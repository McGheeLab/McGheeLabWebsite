/* ================================================================
   user-system.js — McGheeLab User System
   Auth, Database, Dashboard, Story Editor, Admin Panel
   ================================================================ */

window.McgheeLab = window.McgheeLab || {};

/* ─── Constants ──────────────────────────────────────────────── */
const IMAGE_SIZES = {
  thumb:  { maxWidth: 300,  quality: 0.7 },
  medium: { maxWidth: 800,  quality: 0.8 },
  full:   { maxWidth: 1600, quality: 0.9 }
};

const ROLES = {
  admin:       { label: 'Admin',       canPublish: true,  canManage: true  },
  editor:      { label: 'Editor',      canPublish: true,  canManage: false },
  contributor: { label: 'Contributor', canPublish: false, canManage: false }
};

const CATEGORIES = [
  { value: 'pi',         label: 'PI' },
  { value: 'postdoc',    label: 'Postdoc' },
  { value: 'grad',       label: 'Graduate Student' },
  { value: 'undergrad',  label: 'Undergraduate' },
  { value: 'highschool', label: 'High School' }
];

/* Default role per category — PI gets admin, grad/postdoc get editor, others get contributor */
const CATEGORY_DEFAULT_ROLE = {
  pi:         'admin',
  postdoc:    'editor',
  grad:       'editor',
  undergrad:  'contributor',
  highschool: 'contributor'
};

/* Project creation is admin-only (PI level) */

/* ─── Utility ────────────────────────────────────────────────── */
function escapeHTML(s) {
  const d = document.createElement('div');
  d.textContent = s ?? '';
  return d.innerHTML;
}

function categoryOptions(selected) {
  return CATEGORIES.map(c =>
    `<option value="${c.value}" ${selected === c.value ? 'selected' : ''}>${c.label}</option>`
  ).join('');
}

/* ================================================================
   IMAGE UTILITIES — client-side resize to thumb / medium / full
   ================================================================ */
function resizeImage(file, maxWidth, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      let w = img.width, h = img.height;
      if (w > maxWidth) { h = Math.round(h * (maxWidth / w)); w = maxWidth; }
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob(
        blob => blob ? resolve(blob) : reject(new Error('Resize failed')),
        'image/webp', quality
      );
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
    img.src = url;
  });
}

async function processImage(file) {
  const out = {};
  for (const [size, cfg] of Object.entries(IMAGE_SIZES)) {
    out[size] = await resizeImage(file, cfg.maxWidth, cfg.quality);
  }
  return out;
}

async function uploadImageSet(blobs, path) {
  if (!McgheeLab.storage) throw new Error('Storage not configured');
  const ref = McgheeLab.storage.ref();
  const urls = {};
  for (const [size, blob] of Object.entries(blobs)) {
    const child = ref.child(`${path}/${size}.webp`);
    await child.put(blob, { contentType: 'image/webp' });
    urls[size] = await child.getDownloadURL();
  }
  return urls;
}

/* ================================================================
   DATABASE OPERATIONS
   ================================================================ */
const DB = {
  /* ── Users ── */
  async getUser(uid) {
    const doc = await McgheeLab.db.collection('users').doc(uid).get();
    return doc.exists ? { id: doc.id, ...doc.data() } : null;
  },
  async updateUser(uid, data) {
    data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    await McgheeLab.db.collection('users').doc(uid).set(data, { merge: true });
  },
  async getAllUsers() {
    const snap = await McgheeLab.db.collection('users').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },
  async deleteUser(uid) {
    await McgheeLab.db.collection('users').doc(uid).delete();
  },

  /* ── Stories ── */
  async getStory(id) {
    const doc = await McgheeLab.db.collection('stories').doc(id).get();
    return doc.exists ? { id: doc.id, ...doc.data() } : null;
  },
  async getStoriesByUser(uid) {
    const snap = await McgheeLab.db.collection('stories')
      .where('authorUid', '==', uid).orderBy('updatedAt', 'desc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },
  async getPublishedStories() {
    const snap = await McgheeLab.db.collection('stories')
      .where('status', '==', 'published').orderBy('publishedAt', 'desc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },
  async getPendingStories() {
    const snap = await McgheeLab.db.collection('stories')
      .where('status', '==', 'pending').orderBy('updatedAt', 'desc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },
  async saveStory(data) {
    data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    if (data.id) {
      const id = data.id;
      const rest = Object.assign({}, data);
      delete rest.id;
      await McgheeLab.db.collection('stories').doc(id).set(rest, { merge: true });
      return id;
    }
    data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    const ref = await McgheeLab.db.collection('stories').add(data);
    return ref.id;
  },
  async updateStoryStatus(id, status) {
    const update = { status, updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
    if (status === 'published') update.publishedAt = firebase.firestore.FieldValue.serverTimestamp();
    await McgheeLab.db.collection('stories').doc(id).update(update);
  },
  async deleteStory(id) {
    await McgheeLab.db.collection('stories').doc(id).delete();
  },

  /* ── Project Packages ── */
  async getProject(id) {
    const doc = await McgheeLab.db.collection('projectPackages').doc(id).get();
    return doc.exists ? { id: doc.id, ...doc.data() } : null;
  },
  async getProjectsByUser(uid) {
    const snap = await McgheeLab.db.collection('projectPackages')
      .where('authorUid', '==', uid).orderBy('updatedAt', 'desc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },
  async getPublishedProjects() {
    const snap = await McgheeLab.db.collection('projectPackages')
      .where('status', '==', 'published').orderBy('publishedAt', 'desc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },
  async saveProject(data) {
    data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    if (data.id) {
      const id = data.id;
      const rest = Object.assign({}, data);
      delete rest.id;
      await McgheeLab.db.collection('projectPackages').doc(id).set(rest, { merge: true });
      return id;
    }
    data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    const ref = await McgheeLab.db.collection('projectPackages').add(data);
    return ref.id;
  },
  async deleteProject(id) {
    await McgheeLab.db.collection('projectPackages').doc(id).delete();
  },

  /* ── Opportunities ── */
  async getOpenOpportunities() {
    const snap = await McgheeLab.db.collection('opportunities')
      .where('status', '==', 'open').orderBy('createdAt', 'desc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },
  async getAllOpportunities() {
    const snap = await McgheeLab.db.collection('opportunities').orderBy('createdAt', 'desc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },
  async saveOpportunity(data) {
    data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    if (data.id) {
      const id = data.id;
      const rest = Object.assign({}, data);
      delete rest.id;
      await McgheeLab.db.collection('opportunities').doc(id).set(rest, { merge: true });
      return id;
    }
    data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    const ref = await McgheeLab.db.collection('opportunities').add(data);
    return ref.id;
  },
  async deleteOpportunity(id) {
    await McgheeLab.db.collection('opportunities').doc(id).delete();
  },

  /* ── Invitations ── */
  async createInvitation(data) {
    data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    data.used = false;
    data.usedBy = null;
    data.usedAt = null;
    const ref = await McgheeLab.db.collection('invitations').add(data);
    return ref.id;
  },
  async getInvitation(token) {
    const doc = await McgheeLab.db.collection('invitations').doc(token).get();
    return doc.exists ? { id: doc.id, ...doc.data() } : null;
  },
  async getAllInvitations() {
    const snap = await McgheeLab.db.collection('invitations').orderBy('createdAt', 'desc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },
  async markInvitationUsed(token, uid) {
    await McgheeLab.db.collection('invitations').doc(token).update({
      used: true, usedBy: uid,
      usedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  },

  /* ── Team Profiles (migrated, claimable) ── */
  async getUnclaimedProfiles() {
    const snap = await McgheeLab.db.collection('teamProfiles')
      .where('registered', '==', false).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },
  async getTeamProfile(id) {
    const doc = await McgheeLab.db.collection('teamProfiles').doc(id).get();
    return doc.exists ? { id: doc.id, ...doc.data() } : null;
  },
  async claimProfile(profileId, uid) {
    await McgheeLab.db.collection('teamProfiles').doc(profileId).update({
      registered: true,
      registeredUid: uid,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  },
  async getClaimedProfiles() {
    const snap = await McgheeLab.db.collection('teamProfiles')
      .where('registered', '==', true).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }
};

/* ================================================================
   AUTHENTICATION
   ================================================================ */
const Auth = {
  currentUser: null,
  currentProfile: null,
  _listeners: [],

  init() {
    if (!McgheeLab.auth) return;
    McgheeLab.auth.onAuthStateChanged(async (user) => {
      Auth.currentUser = user;
      if (user) {
        try { Auth.currentProfile = await DB.getUser(user.uid); } catch (e) {
          console.warn('Failed to load profile:', e);
          Auth.currentProfile = null;
        }
        document.body.classList.add('logged-in');
        document.body.classList.toggle('is-admin', Auth.currentProfile?.role === 'admin');
      } else {
        Auth.currentProfile = null;
        document.body.classList.remove('logged-in', 'is-admin');
      }
      Auth.updateNavigation();
      Auth._listeners.forEach(fn => fn(user, Auth.currentProfile));
    });
  },

  onChange(fn) { Auth._listeners.push(fn); },

  updateNavigation() {
    const dashLi  = document.getElementById('nav-dashboard');
    const adminLi = document.getElementById('nav-admin');
    const loginA  = document.getElementById('nav-login');
    if (dashLi)  dashLi.style.display  = Auth.currentUser ? '' : 'none';
    if (adminLi) adminLi.style.display = Auth.currentProfile?.role === 'admin' ? '' : 'none';
    if (loginA) {
      loginA.textContent = Auth.currentUser ? 'Logout' : 'Login';
      loginA.href = Auth.currentUser ? '#/logout' : '#/login';
      loginA.setAttribute('data-route', Auth.currentUser ? 'logout' : 'login');
    }
  },

  async login(email, password) {
    return (await McgheeLab.auth.signInWithEmailAndPassword(email, password)).user;
  },

  async register(email, password, name, token) {
    const inv = await DB.getInvitation(token);
    if (!inv) throw new Error('Invalid invitation token.');
    if (inv.used) throw new Error('This invitation has already been used.');
    if (inv.expiresAt && inv.expiresAt.toDate() < new Date()) throw new Error('This invitation has expired.');
    if (inv.email && inv.email.toLowerCase() !== email.toLowerCase()) {
      throw new Error('This invitation is for a different email address.');
    }

    const cred = await McgheeLab.auth.createUserWithEmailAndPassword(email, password);

    // If invitation links to an existing team profile, claim it
    let profileData = { name, photo: null, bio: '', category: inv.category || 'undergrad' };
    if (inv.claimProfileId) {
      try {
        const existing = await DB.getTeamProfile(inv.claimProfileId);
        if (existing && !existing.registered) {
          profileData.name = existing.name || name;
          profileData.bio = existing.bio || '';
          profileData.photo = existing.photo || null;
          profileData.category = existing.category || inv.category || 'undergrad';
          await DB.claimProfile(inv.claimProfileId, cred.user.uid);
        }
      } catch (e) { console.warn('Profile claim failed, using defaults:', e); }
    }

    await DB.updateUser(cred.user.uid, {
      ...profileData, email,
      role: inv.role || 'contributor',
      claimedProfileId: inv.claimProfileId || null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    await DB.markInvitationUsed(token, cred.user.uid);
    return cred.user;
  },

  async logout() {
    await McgheeLab.auth.signOut();
    window.location.hash = '#/';
  },

  isAdmin()    { return Auth.currentProfile?.role === 'admin'; },
  canPublish() { return Auth.currentProfile?.role === 'admin' || Auth.currentProfile?.role === 'editor'; },
  canCreateProject() { return Auth.isAdmin(); }
};

/* ================================================================
   RENDER: LOGIN / REGISTER PAGE
   ================================================================ */
function renderLogin() {
  if (!McgheeLab.auth) {
    return '<div class="auth-card"><p>User system is not configured. See firebase-config.js.</p></div>';
  }

  const qs = new URLSearchParams((window.location.hash.split('?')[1]) || '');
  const token = qs.get('token');
  const isRegister = !!token;

  return `
    <div class="user-auth-page">
      <div class="auth-card">
        <h2>${isRegister ? 'Create Your Account' : 'Sign In'}</h2>
        ${isRegister ? '<p class="auth-subtitle">You have been invited to join McGhee Lab.</p>' : ''}
        <form id="auth-form" class="auth-form">
          ${isRegister ? `
            <input type="hidden" name="token" value="${escapeHTML(token)}">
            <div class="form-group">
              <label for="auth-name">Full Name</label>
              <input type="text" id="auth-name" name="name" required autocomplete="name">
            </div>` : ''}
          <div class="form-group">
            <label for="auth-email">Email</label>
            <input type="email" id="auth-email" name="email" required autocomplete="email">
          </div>
          <div class="form-group">
            <label for="auth-password">Password</label>
            <input type="password" id="auth-password" name="password" required minlength="8"
              autocomplete="${isRegister ? 'new-password' : 'current-password'}">
          </div>
          <div id="auth-error" class="auth-error" hidden></div>
          <button type="submit" class="btn btn-primary">${isRegister ? 'Create Account' : 'Sign In'}</button>
        </form>
      </div>
    </div>`;
}

function wireLogin() {
  const form = document.getElementById('auth-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('auth-error');
    const btn = form.querySelector('button[type="submit"]');
    errEl.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Please wait\u2026';

    try {
      const fd = new FormData(form);
      const token = fd.get('token');
      if (token) {
        await Auth.register(fd.get('email'), fd.get('password'), fd.get('name'), token);
      } else {
        await Auth.login(fd.get('email'), fd.get('password'));
      }
      window.location.hash = '#/dashboard';
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
      btn.disabled = false;
      btn.textContent = fd.get('token') ? 'Create Account' : 'Sign In';
    }
  });
}

/* ================================================================
   RENDER: DASHBOARD
   ================================================================ */
function renderDashboard() {
  if (!Auth.currentUser) { window.location.hash = '#/login'; return '<p>Redirecting\u2026</p>'; }
  const p = Auth.currentProfile || {};

  return `
    <div class="dashboard-page">
      <div class="dash-header">
        <h2>Dashboard</h2>
        <button class="btn btn-secondary" id="dash-logout-btn">Sign Out</button>
      </div>
      <div class="dashboard-grid">

        <!-- Profile Card -->
        <div class="dash-card">
          <h3>My Profile</h3>
          <form id="profile-form" class="profile-form">
            <div class="profile-photo-section">
              <div class="profile-photo-preview" id="profile-photo-preview">
                ${p.photo?.medium
                  ? `<img src="${escapeHTML(p.photo.medium)}" alt="Profile photo">`
                  : '<div class="photo-placeholder">No photo</div>'}
              </div>
              <label class="btn btn-secondary btn-small upload-label">
                Upload Photo
                <input type="file" id="profile-photo-input" accept="image/*" hidden>
              </label>
            </div>
            <div class="form-group">
              <label for="profile-name">Name</label>
              <input type="text" id="profile-name" value="${escapeHTML(p.name || '')}" required>
            </div>
            <div class="form-group">
              <label for="profile-bio">Bio</label>
              <textarea id="profile-bio" rows="4">${escapeHTML(p.bio || '')}</textarea>
            </div>
            <div class="form-group">
              <label for="profile-category">Category</label>
              <select id="profile-category">${categoryOptions(p.category)}</select>
            </div>
            <button type="submit" class="btn btn-primary">Save Profile</button>
            <div id="profile-status" class="form-status" hidden></div>
          </form>
        </div>

        <!-- Stories Card -->
        <div class="dash-card">
          <div class="card-head">
            <h3>My Stories</h3>
            <div class="card-head-actions">
              <a href="#/guide" class="btn btn-secondary btn-small">How-to Guide</a>
              <button class="btn btn-primary btn-small" id="new-story-btn">+ New Story</button>
            </div>
          </div>
          <div id="stories-list" class="stories-list">
            <p class="loading-text">Loading stories\u2026</p>
          </div>
        </div>

        ${Auth.canCreateProject() ? `
        <!-- Projects Card (admin only) -->
        <div class="dash-card dash-card-full">
          <div class="card-head">
            <h3>Project Packages</h3>
            <button class="btn btn-primary btn-small" id="new-project-btn">+ New Project</button>
          </div>
          <p class="hint">Compile published stories into a project with outcomes. Assign stories, set their order, and link to external sites.</p>
          <div id="projects-list" class="stories-list">
            <p class="loading-text">Loading projects\u2026</p>
          </div>
        </div>` : ''}

      </div>
    </div>`;
}

async function wireDashboard() {
  if (!Auth.currentUser) return;

  // Logout button
  document.getElementById('dash-logout-btn')?.addEventListener('click', () => Auth.logout());

  // New story button
  document.getElementById('new-story-btn')?.addEventListener('click', () => {
    window.location.hash = '#/dashboard/story/new';
  });

  // Load story list
  await refreshStoryList();

  // Project package section (grad/postdoc/admin only)
  if (Auth.canCreateProject()) {
    document.getElementById('new-project-btn')?.addEventListener('click', () => {
      window.location.hash = '#/dashboard/project/new';
    });
    await refreshProjectList();
  }

  // Profile form
  const form = document.getElementById('profile-form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const st = document.getElementById('profile-status');
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true; st.hidden = true;
      try {
        await DB.updateUser(Auth.currentUser.uid, {
          name: document.getElementById('profile-name').value,
          bio: document.getElementById('profile-bio').value,
          category: document.getElementById('profile-category').value
        });
        Auth.currentProfile = await DB.getUser(Auth.currentUser.uid);
        st.textContent = 'Profile saved!';
        st.className = 'form-status success'; st.hidden = false;
      } catch (err) {
        st.textContent = 'Error: ' + err.message;
        st.className = 'form-status error'; st.hidden = false;
      }
      btn.disabled = false;
    });
  }

  // Photo upload
  document.getElementById('profile-photo-input')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const st = document.getElementById('profile-status');
    st.textContent = 'Uploading photo\u2026'; st.className = 'form-status'; st.hidden = false;
    try {
      const blobs = await processImage(file);
      const urls = await uploadImageSet(blobs, `users/${Auth.currentUser.uid}/photo`);
      await DB.updateUser(Auth.currentUser.uid, { photo: urls });
      Auth.currentProfile = await DB.getUser(Auth.currentUser.uid);
      document.getElementById('profile-photo-preview').innerHTML =
        `<img src="${escapeHTML(urls.medium)}" alt="Profile photo">`;
      st.textContent = 'Photo updated!'; st.className = 'form-status success';
    } catch (err) {
      st.textContent = 'Upload failed: ' + err.message; st.className = 'form-status error';
    }
  });
}

async function refreshStoryList() {
  const el = document.getElementById('stories-list');
  if (!el) return;

  try {
    const stories = await DB.getStoriesByUser(Auth.currentUser.uid);
    if (!stories.length) {
      el.innerHTML = '<p class="empty-state">No stories yet. Create your first one!</p>';
      return;
    }
    el.innerHTML = stories.map(s => `
      <div class="story-item">
        <div class="story-item-info">
          <strong>${escapeHTML(s.title || 'Untitled')}</strong>
          <span class="status-badge status-${s.status || 'draft'}">${s.status || 'draft'}</span>
        </div>
        <div class="story-item-actions">
          <button class="btn btn-secondary btn-small" data-edit-story="${s.id}">Edit</button>
          <button class="btn btn-danger btn-small" data-delete-story="${s.id}">Delete</button>
        </div>
      </div>
    `).join('');

    el.querySelectorAll('[data-edit-story]').forEach(btn => {
      btn.addEventListener('click', () => { window.location.hash = '#/dashboard/story/' + btn.dataset.editStory; });
    });
    el.querySelectorAll('[data-delete-story]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this story? This cannot be undone.')) return;
        await DB.deleteStory(btn.dataset.deleteStory);
        await refreshStoryList();
      });
    });
  } catch (err) {
    el.innerHTML = '<p class="error-text">Failed to load stories: ' + escapeHTML(err.message) + '</p>';
  }
}

async function refreshProjectList() {
  const el = document.getElementById('projects-list');
  if (!el) return;

  try {
    const projects = await DB.getProjectsByUser(Auth.currentUser.uid);
    if (!projects.length) {
      el.innerHTML = '<p class="empty-state">No project packages yet. Compile your stories into a project!</p>';
      return;
    }
    el.innerHTML = projects.map(p => `
      <div class="story-item">
        <div class="story-item-info">
          <strong>${escapeHTML(p.title || 'Untitled Project')}</strong>
          <span class="status-badge status-${p.status || 'draft'}">${p.status || 'draft'}</span>
          <span class="hint">${(p.storyIds || []).length} stories</span>
        </div>
        <div class="story-item-actions">
          <button class="btn btn-secondary btn-small" data-edit-project="${p.id}">Edit</button>
          <button class="btn btn-danger btn-small" data-delete-project="${p.id}">Delete</button>
        </div>
      </div>
    `).join('');

    el.querySelectorAll('[data-edit-project]').forEach(btn => {
      btn.addEventListener('click', () => { window.location.hash = '#/dashboard/project/' + btn.dataset.editProject; });
    });
    el.querySelectorAll('[data-delete-project]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this project package? This cannot be undone.')) return;
        await DB.deleteProject(btn.dataset.deleteProject);
        await refreshProjectList();
      });
    });
  } catch (err) {
    el.innerHTML = '<p class="error-text">Failed to load projects: ' + escapeHTML(err.message) + '</p>';
  }
}

/* ================================================================
   RENDER: PROJECT PACKAGE EDITOR
   ================================================================ */
function renderProjectEditor(projectId) {
  if (!Auth.currentUser) { window.location.hash = '#/login'; return '<p>Redirecting\u2026</p>'; }
  if (!Auth.isAdmin()) { window.location.hash = '#/dashboard'; return '<p>Access denied.</p>'; }
  const isNew = projectId === 'new';

  return `
    <div class="story-editor-page project-wizard">
      <div class="editor-header">
        <button class="btn btn-secondary" id="proj-back-btn">&larr; Back</button>
        <h2>${isNew ? 'New Project' : 'Edit Project'}</h2>
      </div>

      <!-- Step indicators -->
      <div class="wizard-steps">
        <button class="wizard-step active" data-step="1"><span class="step-num">1</span> Details</button>
        <button class="wizard-step" data-step="2"><span class="step-num">2</span> Team</button>
        <button class="wizard-step" data-step="3"><span class="step-num">3</span> Stories</button>
        <button class="wizard-step" data-step="4"><span class="step-num">4</span> References</button>
        <button class="wizard-step" data-step="5"><span class="step-num">5</span> Review</button>
      </div>

      <form id="project-form">
        <!-- Step 1: Details -->
        <div class="wizard-panel active" data-panel="1">
          <h3>Project Details</h3>
          <div class="form-group">
            <label for="proj-title">Project Title</label>
            <input type="text" id="proj-title" required placeholder="Give your project a title">
          </div>
          <div class="form-group">
            <label for="proj-description">Description</label>
            <textarea id="proj-description" rows="3" placeholder="Describe this project"></textarea>
          </div>
          <div class="form-group">
            <label for="proj-outcomes">Outcomes <span class="hint">(required for publishing)</span></label>
            <textarea id="proj-outcomes" rows="4" placeholder="Describe the project outcomes, results, and conclusions"></textarea>
          </div>
          <div class="form-group">
            <label for="proj-link">External Link <span class="hint">(optional — link to project site)</span></label>
            <input type="url" id="proj-link" placeholder="https://example.com">
          </div>
        </div>

        <!-- Step 2: Team -->
        <div class="wizard-panel" data-panel="2">
          <h3>Project Team</h3>
          <div class="team-fields">
            <div class="form-group">
              <label>Author (PI)</label>
              <input type="text" id="proj-author-name" readonly class="team-readonly">
            </div>
            <div class="form-group">
              <label for="proj-mentor">Mentor</label>
              <select id="proj-mentor">
                <option value="">— Select mentor —</option>
              </select>
            </div>
            <div class="form-group">
              <label>Contributors</label>
              <div class="contributor-select-row">
                <select id="proj-contributor-select">
                  <option value="">— Add contributor —</option>
                </select>
                <button type="button" id="proj-add-contributor-btn" class="btn btn-secondary btn-small">Add</button>
              </div>
              <div id="proj-contributor-chips" class="contributor-chips"></div>
            </div>
          </div>
        </div>

        <!-- Step 3: Stories -->
        <div class="wizard-panel" data-panel="3">
          <h3>Assign Stories</h3>
          <p class="hint">Add published stories to this project. Drag to reorder, or use the arrows. Remove stories you no longer need.</p>
          <div class="proj-story-add-row">
            <select id="proj-story-select">
              <option value="">— Select a story to add —</option>
            </select>
            <button type="button" id="proj-add-story-btn" class="btn btn-secondary btn-small">+ Add</button>
          </div>
          <div id="proj-story-list" class="proj-story-list">
            <p class="empty-state">No stories assigned yet.</p>
          </div>
        </div>

        <!-- Step 4: References -->
        <div class="wizard-panel" data-panel="4">
          <h3>References</h3>
          <p class="hint">Link publications, patents, presentations, or posters to this project.</p>
          <div id="proj-refs-container" class="refs-container"></div>
          <button type="button" id="proj-add-ref-btn" class="btn btn-secondary">+ Add Reference</button>
        </div>

        <!-- Step 5: Review & Publish -->
        <div class="wizard-panel" data-panel="5">
          <h3>Review &amp; Publish</h3>
          <div id="proj-review-summary" class="review-summary"></div>
        </div>

        <!-- Navigation -->
        <div class="wizard-nav">
          <button type="button" id="proj-prev-btn" class="btn btn-secondary" disabled>&larr; Previous</button>
          <div class="wizard-nav-right">
            <button type="button" id="proj-save-draft-btn" class="btn btn-secondary">Save Draft</button>
            <button type="button" id="proj-next-btn" class="btn btn-primary">Next &rarr;</button>
            <button type="submit" id="proj-publish-btn" class="btn btn-primary" hidden>Publish</button>
          </div>
        </div>
        <div id="proj-status" class="form-status" hidden></div>
      </form>
    </div>`;
}

async function wireProjectEditor(projectId) {
  if (!Auth.currentUser || !Auth.isAdmin()) return;

  const form = document.getElementById('project-form');
  if (!form) return;

  let existing = null;
  const selectedContributors = [];
  let _projRefCounter = 0;
  // Ordered list of story objects: { id, title, authorName }
  const assignedStories = [];
  let allStories = [];
  let currentStep = 1;
  const totalSteps = 5;

  // ── Wizard navigation ──
  const steps = document.querySelectorAll('.wizard-step');
  const panels = document.querySelectorAll('.wizard-panel');
  const prevBtn = document.getElementById('proj-prev-btn');
  const nextBtn = document.getElementById('proj-next-btn');
  const publishBtn = document.getElementById('proj-publish-btn');

  function goToStep(n) {
    currentStep = Math.max(1, Math.min(totalSteps, n));
    steps.forEach(s => {
      const sn = Number(s.dataset.step);
      s.classList.toggle('active', sn === currentStep);
      s.classList.toggle('completed', sn < currentStep);
    });
    panels.forEach(p => p.classList.toggle('active', Number(p.dataset.panel) === currentStep));
    prevBtn.disabled = currentStep === 1;
    nextBtn.hidden = currentStep === totalSteps;
    publishBtn.hidden = currentStep !== totalSteps;
    if (currentStep === totalSteps) buildReview();
  }

  steps.forEach(s => s.addEventListener('click', () => goToStep(Number(s.dataset.step))));
  prevBtn.addEventListener('click', () => goToStep(currentStep - 1));
  nextBtn.addEventListener('click', () => goToStep(currentStep + 1));

  // Back button
  document.getElementById('proj-back-btn')?.addEventListener('click', () => {
    window.location.hash = '#/dashboard';
  });

  // ── Step 2: Team ──
  const allUsers = await DB.getAllUsers().catch(() => []);
  const mentorSelect = document.getElementById('proj-mentor');
  const contribSelect = document.getElementById('proj-contributor-select');
  document.getElementById('proj-author-name').value = Auth.currentProfile?.name || Auth.currentUser.email;

  allUsers.forEach(u => {
    const addOpt = (sel) => {
      const o = document.createElement('option');
      o.value = u.id;
      o.textContent = u.name || u.email || u.id;
      o.dataset.name = u.name || '';
      o.dataset.photo = u.photo || '';
      sel.appendChild(o);
    };
    addOpt(mentorSelect);
    if (u.id !== Auth.currentUser.uid) addOpt(contribSelect);
  });

  const chipsEl = document.getElementById('proj-contributor-chips');
  function renderChips() {
    chipsEl.innerHTML = selectedContributors.map((c, i) =>
      `<span class="contributor-chip">${escapeHTML(c.name || c.uid)}
        <button type="button" class="chip-remove" data-idx="${i}">&times;</button>
      </span>`
    ).join('');
    chipsEl.querySelectorAll('.chip-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedContributors.splice(Number(btn.dataset.idx), 1);
        renderChips();
      });
    });
  }

  document.getElementById('proj-add-contributor-btn').addEventListener('click', () => {
    if (!contribSelect.value) return;
    const opt = contribSelect.options[contribSelect.selectedIndex];
    if (selectedContributors.some(c => c.uid === contribSelect.value)) return;
    selectedContributors.push({
      uid: contribSelect.value,
      name: opt.dataset.name || opt.textContent,
      photo: opt.dataset.photo || ''
    });
    renderChips();
    contribSelect.value = '';
  });

  // ── Step 3: Stories (ordered list with add/reorder/delete) ──
  const storySelect = document.getElementById('proj-story-select');
  const storyListEl = document.getElementById('proj-story-list');

  try {
    allStories = await DB.getPublishedStories();
  } catch (e) { console.warn('Failed to load stories:', e); }

  // Populate the story dropdown
  function refreshStoryDropdown() {
    const assignedIds = new Set(assignedStories.map(s => s.id));
    storySelect.innerHTML = '<option value="">— Select a story to add —</option>';
    allStories.filter(s => !assignedIds.has(s.id)).forEach(s => {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = `${s.title || 'Untitled'} — ${s.authorName || ''}`;
      storySelect.appendChild(o);
    });
  }

  function renderStoryList() {
    if (!assignedStories.length) {
      storyListEl.innerHTML = '<p class="empty-state">No stories assigned yet.</p>';
      refreshStoryDropdown();
      return;
    }
    storyListEl.innerHTML = assignedStories.map((s, i) => `
      <div class="proj-story-row" data-idx="${i}">
        <span class="proj-story-num">${i + 1}</span>
        <span class="proj-story-title">${escapeHTML(s.title || 'Untitled')}</span>
        <span class="hint">${escapeHTML(s.authorName || '')}</span>
        <div class="proj-story-controls">
          <button type="button" class="btn-icon" data-move-story="up" title="Move up" ${i === 0 ? 'disabled' : ''}>&uarr;</button>
          <button type="button" class="btn-icon" data-move-story="down" title="Move down" ${i === assignedStories.length - 1 ? 'disabled' : ''}>&darr;</button>
          <button type="button" class="btn-icon btn-danger-icon" data-remove-story title="Remove">&times;</button>
        </div>
      </div>
    `).join('');

    storyListEl.querySelectorAll('[data-move-story="up"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.closest('.proj-story-row').dataset.idx);
        if (idx > 0) { [assignedStories[idx - 1], assignedStories[idx]] = [assignedStories[idx], assignedStories[idx - 1]]; renderStoryList(); }
      });
    });
    storyListEl.querySelectorAll('[data-move-story="down"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.closest('.proj-story-row').dataset.idx);
        if (idx < assignedStories.length - 1) { [assignedStories[idx], assignedStories[idx + 1]] = [assignedStories[idx + 1], assignedStories[idx]]; renderStoryList(); }
      });
    });
    storyListEl.querySelectorAll('[data-remove-story]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.closest('.proj-story-row').dataset.idx);
        assignedStories.splice(idx, 1);
        renderStoryList();
      });
    });
    refreshStoryDropdown();
  }

  document.getElementById('proj-add-story-btn').addEventListener('click', () => {
    const id = storySelect.value;
    if (!id) return;
    const story = allStories.find(s => s.id === id);
    if (!story) return;
    assignedStories.push({ id: story.id, title: story.title || '', authorName: story.authorName || '' });
    renderStoryList();
  });

  renderStoryList();

  // ── Step 4: References ──
  const refsContainer = document.getElementById('proj-refs-container');
  function projRefBlockHTML(data) {
    const id = _projRefCounter++;
    return `
      <div class="ref-block" data-ref-id="${id}">
        <div class="ref-block-row">
          <select class="ref-type">
            ${REF_TYPES.map(t =>
              `<option value="${t.value}" ${data?.type === t.value ? 'selected' : ''}>${t.label}</option>`
            ).join('')}
          </select>
          <input type="text" class="ref-title" placeholder="Title" value="${escapeHTML(data?.title || '')}">
          <input type="url" class="ref-url" placeholder="URL (optional)" value="${escapeHTML(data?.url || '')}">
          <input type="text" class="ref-detail" placeholder="Detail" value="${escapeHTML(data?.detail || '')}">
          <button type="button" class="btn-icon btn-danger-icon" data-remove-ref title="Remove">&times;</button>
        </div>
      </div>`;
  }

  function wireRefBlock(block) {
    block.querySelector('[data-remove-ref]').addEventListener('click', () => block.remove());
  }

  document.getElementById('proj-add-ref-btn').addEventListener('click', () => {
    refsContainer.insertAdjacentHTML('beforeend', projRefBlockHTML());
    wireRefBlock(refsContainer.lastElementChild);
  });

  // ── Load existing project ──
  if (projectId !== 'new') {
    try {
      existing = await DB.getProject(projectId);
    } catch (e) { console.warn('Failed to load project:', e); }
    if (existing) {
      document.getElementById('proj-title').value = existing.title || '';
      document.getElementById('proj-description').value = existing.description || '';
      document.getElementById('proj-outcomes').value = existing.outcomes || '';
      document.getElementById('proj-link').value = existing.link || '';
      if (existing.team?.mentor?.uid) mentorSelect.value = existing.team.mentor.uid;
      if (existing.team?.contributors) {
        existing.team.contributors.forEach(c => selectedContributors.push(c));
        renderChips();
      }
      // Restore stories in order
      if (existing.storyIds) {
        existing.storyIds.forEach(id => {
          const s = allStories.find(st => st.id === id);
          assignedStories.push(s ? { id: s.id, title: s.title || '', authorName: s.authorName || '' } : { id, title: '(deleted story)', authorName: '' });
        });
        renderStoryList();
      }
      if (existing.references) {
        for (const [type, items] of Object.entries(existing.references)) {
          if (Array.isArray(items)) {
            items.forEach(ref => {
              refsContainer.insertAdjacentHTML('beforeend', projRefBlockHTML({ ...ref, type }));
              wireRefBlock(refsContainer.lastElementChild);
            });
          }
        }
      }
    }
  }

  // ── Step 5: Review summary ──
  function buildReview() {
    const el = document.getElementById('proj-review-summary');
    const title = document.getElementById('proj-title').value || '(no title)';
    const desc = document.getElementById('proj-description').value || '(no description)';
    const outcomes = document.getElementById('proj-outcomes').value || '(none)';
    const link = document.getElementById('proj-link').value;
    const mentorOpt = mentorSelect.options[mentorSelect.selectedIndex];
    const mentorName = mentorSelect.value ? (mentorOpt?.dataset?.name || mentorOpt?.textContent || '') : '(none)';
    const contribNames = selectedContributors.map(c => c.name || c.uid).join(', ') || '(none)';
    const storyCount = assignedStories.length;
    const refCount = refsContainer.querySelectorAll('.ref-block').length;

    el.innerHTML = `
      <div class="review-row"><strong>Title:</strong> ${escapeHTML(title)}</div>
      <div class="review-row"><strong>Description:</strong> ${escapeHTML(desc)}</div>
      <div class="review-row"><strong>Outcomes:</strong> ${escapeHTML(outcomes)}</div>
      ${link ? `<div class="review-row"><strong>External Link:</strong> <a href="${escapeHTML(link)}" target="_blank" rel="noopener">${escapeHTML(link)}</a></div>` : ''}
      <div class="review-row"><strong>Mentor:</strong> ${escapeHTML(mentorName)}</div>
      <div class="review-row"><strong>Contributors:</strong> ${escapeHTML(contribNames)}</div>
      <div class="review-row"><strong>Stories:</strong> ${storyCount} assigned</div>
      <div class="review-row"><strong>References:</strong> ${refCount} entries</div>
      ${!outcomes.trim() ? '<p class="form-status error" style="margin-top:.75rem">Outcomes are required before publishing.</p>' : ''}
    `;
  }

  // ── Collect & Save ──
  function collectProjectData(status) {
    const mentorOpt = mentorSelect.options[mentorSelect.selectedIndex];
    const team = {
      author: {
        uid: Auth.currentUser.uid,
        name: Auth.currentProfile?.name || '',
        photo: Auth.currentProfile?.photo || ''
      },
      contributors: selectedContributors.map(c => ({
        uid: c.uid, name: c.name, photo: c.photo || ''
      })),
      mentor: mentorSelect.value ? {
        uid: mentorSelect.value,
        name: mentorOpt?.dataset?.name || mentorOpt?.textContent || '',
        photo: mentorOpt?.dataset?.photo || ''
      } : null
    };

    const references = {};
    refsContainer.querySelectorAll('.ref-block').forEach(block => {
      const type = block.querySelector('.ref-type').value;
      const title = block.querySelector('.ref-title').value.trim();
      const url = block.querySelector('.ref-url').value.trim();
      const detail = block.querySelector('.ref-detail').value.trim();
      if (!title && !url) return;
      if (!references[type]) references[type] = [];
      references[type].push({ title, url, detail });
    });

    return {
      id: existing?.id || undefined,
      title: document.getElementById('proj-title').value,
      description: document.getElementById('proj-description').value,
      outcomes: document.getElementById('proj-outcomes').value,
      link: document.getElementById('proj-link').value.trim(),
      authorUid: Auth.currentUser.uid,
      authorName: Auth.currentProfile?.name || '',
      storyIds: assignedStories.map(s => s.id),
      team,
      references,
      status
    };
  }

  async function saveProject(status) {
    const st = document.getElementById('proj-status');
    st.hidden = true;

    if (status === 'published') {
      const outcomes = document.getElementById('proj-outcomes').value.trim();
      if (!outcomes) {
        st.textContent = 'Outcomes are required before publishing.';
        st.className = 'form-status error'; st.hidden = false;
        return;
      }
    }

    try {
      const data = collectProjectData(status);
      if (status === 'published') data.publishedAt = firebase.firestore.FieldValue.serverTimestamp();
      const id = await DB.saveProject(data);
      st.textContent = status === 'draft' ? 'Draft saved!' : 'Published!';
      st.className = 'form-status success'; st.hidden = false;
      if (!existing) window.location.hash = `#/dashboard/project/${id}`;
      existing = { ...data, id };
    } catch (err) {
      st.textContent = 'Error: ' + err.message;
      st.className = 'form-status error'; st.hidden = false;
    }
  }

  document.getElementById('proj-save-draft-btn').addEventListener('click', () => saveProject('draft'));
  form.addEventListener('submit', e => {
    e.preventDefault();
    saveProject('published');
  });
}

/* ================================================================
   RENDER: STORY GUIDE (help page for students)
   ================================================================ */
function renderGuide() {
  return `
    <div class="guide-page">
      <div class="guide-header">
        <button class="btn btn-secondary" onclick="history.back()">&larr; Back</button>
        <h2>How to Create a Story</h2>
      </div>

      <div class="guide-content">

        <div class="guide-section">
          <h3>What is a Story?</h3>
          <p>A story is how you share your research with the world on the McGhee Lab website. Each story appears on the <strong>Projects</strong> page and is made up of <strong>sections</strong> — blocks of text with optional images that walk the reader through your work.</p>
          <p>Think of it like a poster or a short blog post: explain what you did, why it matters, and show your results.</p>
        </div>

        <div class="guide-section">
          <h3>Step 1: Start a New Story</h3>
          <p>From your <strong>Dashboard</strong>, click the <strong class="highlight">+ New Story</strong> button. This opens the story editor.</p>
          <p>Fill in the top fields:</p>
          <ul>
            <li><strong>Story Title</strong> — A clear, descriptive title (e.g., "Microfluidic Cell Sorting with LLS")</li>
            <li><strong>Associated Project</strong> — The project this relates to (optional)</li>
            <li><strong>Brief Description</strong> — One sentence summarizing the story</li>
          </ul>
        </div>

        <div class="guide-section">
          <h3>Step 2: Add Sections</h3>
          <p>Sections are the building blocks of your story. Each section has:</p>
          <ul>
            <li><strong>Text</strong> — Describe what's happening. Write in plain language — imagine explaining it to a smart friend outside the lab.</li>
            <li><strong>Image</strong> (optional) — A photo, diagram, microscopy image, or chart that supports the text.</li>
            <li><strong>Image description</strong> — Alt text that describes the image for accessibility.</li>
          </ul>
          <p>Click <strong class="highlight">+ Add Section</strong> to add more blocks. You can reorder them with the <strong>&uarr;</strong> <strong>&darr;</strong> arrows or remove one with <strong>&times;</strong>.</p>

          <div class="guide-tip">
            <strong>Tip:</strong> A good story has 3&ndash;6 sections. Start with context (why this work matters), show your methods, then present results. End with what's next.
          </div>
        </div>

        <div class="guide-section">
          <h3>Step 3: Upload Images</h3>
          <p>Click the dashed upload zone in any section, or <strong>drag and drop</strong> an image file onto it.</p>
          <ul>
            <li>Upload <strong>one high-resolution image</strong> per section — the system automatically creates three sizes (thumbnail, medium, full) for fast loading</li>
            <li>Accepted formats: JPG, PNG, WebP, GIF</li>
            <li>Maximum file size: 10 MB</li>
            <li>Best results: images at least <strong>1600px wide</strong></li>
          </ul>
          <p>After uploading, a preview appears in the upload zone. You can click it again to replace the image.</p>

          <div class="guide-tip">
            <strong>Tip:</strong> Use clear, well-lit images. Annotate microscopy images with scale bars. Crop out unnecessary whitespace.
          </div>
        </div>

        <div class="guide-section">
          <h3>Step 4: Preview Your Story</h3>
          <p>Click <strong class="highlight">Preview</strong> to see exactly how your story will look on the public site. The preview shows text and images in the same two-column layout visitors will see.</p>
          <p>Check for:</p>
          <ul>
            <li>Typos and unclear phrasing</li>
            <li>Images appearing correctly</li>
            <li>Logical flow from one section to the next</li>
          </ul>
        </div>

        <div class="guide-section">
          <h3>Step 5: Save or Publish</h3>
          <p>You have three options at the bottom of the editor:</p>
          <table class="guide-table">
            <thead><tr><th>Button</th><th>What it does</th></tr></thead>
            <tbody>
              <tr>
                <td><strong>Save Draft</strong></td>
                <td>Saves your work privately. Only you can see drafts. Come back and edit anytime.</td>
              </tr>
              <tr>
                <td><strong>Publish</strong></td>
                <td>Makes your story live on the public site immediately. <em>(Editors and Admins only)</em></td>
              </tr>
              <tr>
                <td><strong>Submit for Review</strong></td>
                <td>Sends your story to an admin for approval. You'll see this if your role is Contributor. Once approved, it goes live.</td>
              </tr>
            </tbody>
          </table>

          <div class="guide-tip">
            <strong>Tip:</strong> Save drafts often! You won't lose work if you close the browser — just come back to your Dashboard and click Edit on the story.
          </div>
        </div>

        <div class="guide-section">
          <h3>Editing an Existing Story</h3>
          <p>From your <strong>Dashboard</strong>, find the story in "My Stories" and click <strong>Edit</strong>. You can update text, swap images, add or remove sections, then save or re-publish.</p>
        </div>

        <div class="guide-section">
          <h3>What Makes a Great Story?</h3>
          <div class="guide-checklist">
            <label><input type="checkbox" disabled> Clear title that tells the reader what to expect</label>
            <label><input type="checkbox" disabled> Opening section explains <em>why</em> this work matters</label>
            <label><input type="checkbox" disabled> Each section has a purpose — no filler</label>
            <label><input type="checkbox" disabled> Images are high quality with descriptive alt text</label>
            <label><input type="checkbox" disabled> Results are shown, not just described</label>
            <label><input type="checkbox" disabled> Ends with next steps or future directions</label>
          </div>
        </div>

        <div class="guide-section guide-cta">
          <p>Ready to get started?</p>
          <a href="#/dashboard/story/new" class="btn btn-primary">Create Your First Story</a>
          <a href="#/dashboard" class="btn btn-secondary">Back to Dashboard</a>
        </div>

      </div>
    </div>`;
}

/* ================================================================
   RENDER: STORY EDITOR
   ================================================================ */
let _sectionCounter = 0;
let _refCounter = 0;

function renderStoryEditor(storyId) {
  if (!Auth.currentUser) { window.location.hash = '#/login'; return '<p>Redirecting\u2026</p>'; }
  const isNew = storyId === 'new';

  return `
    <div class="story-editor-page">
      <div class="editor-header">
        <button class="btn btn-secondary" id="editor-back-btn">&larr; Back</button>
        <h2>${isNew ? 'New Story' : 'Edit Story'}</h2>
        <a href="#/guide" class="btn btn-secondary btn-small" style="margin-left:auto">Help</a>
      </div>

      <form id="story-form" class="story-form">
        <div class="form-group">
          <label for="story-title">Story Title</label>
          <input type="text" id="story-title" required placeholder="Give your story a title">
        </div>
        <div class="form-group">
          <label for="story-project">Associated Project (optional)</label>
          <input type="text" id="story-project" placeholder="e.g., Microfluidic Cell Sorting">
        </div>
        <div class="form-group">
          <label for="story-description">Brief Description</label>
          <textarea id="story-description" rows="2" placeholder="One-line summary"></textarea>
        </div>

        <h3>Team</h3>
        <p class="hint">Assign team members to this story. You are automatically listed as author.</p>
        <div class="team-fields">
          <div class="form-group">
            <label>Author</label>
            <input type="text" id="story-author-name" readonly class="team-readonly">
          </div>
          <div class="form-group">
            <label for="story-mentor">Mentor</label>
            <select id="story-mentor">
              <option value="">— Select mentor —</option>
            </select>
          </div>
          <div class="form-group">
            <label>Contributors</label>
            <div class="contributor-select-row">
              <select id="story-contributor-select">
                <option value="">— Add contributor —</option>
              </select>
              <button type="button" id="add-contributor-btn" class="btn btn-secondary btn-small">Add</button>
            </div>
            <div id="contributor-chips" class="contributor-chips"></div>
          </div>
        </div>

        <h3>Sections</h3>
        <p class="hint">Each section is a block of text with an optional image. Add as many as you need.</p>
        <div id="sections-container" class="sections-container"></div>
        <button type="button" id="add-section-btn" class="btn btn-secondary">+ Add Section</button>

        <h3>References</h3>
        <p class="hint">Add links to publications, patents, presentations, or posters related to this story.</p>
        <div id="refs-container" class="refs-container"></div>
        <button type="button" id="add-ref-btn" class="btn btn-secondary">+ Add Reference</button>

        <div class="editor-actions">
          <button type="button" id="preview-btn" class="btn btn-secondary">Preview</button>
          <button type="button" id="save-draft-btn" class="btn btn-secondary">Save Draft</button>
          <button type="submit" class="btn btn-primary" id="publish-btn">
            ${Auth.canPublish() ? 'Publish' : 'Submit for Review'}
          </button>
        </div>
        <div id="editor-status" class="form-status" hidden></div>
      </form>

      <div id="story-preview-modal" class="modal" hidden>
        <div class="modal-content">
          <div class="modal-header">
            <h3>Story Preview</h3>
            <button type="button" class="btn btn-secondary btn-small" id="close-preview-btn">&times; Close</button>
          </div>
          <div id="story-preview-body" class="story-preview-body"></div>
        </div>
      </div>
    </div>`;
}

function sectionBlockHTML(data) {
  const id = _sectionCounter++;
  let mediaPreview;
  if (data?.videoUrl) {
    mediaPreview = `<video src="${escapeHTML(data.videoUrl)}" controls playsinline preload="metadata" class="section-video-preview"></video>`;
  } else if (data?.imageUrl) {
    mediaPreview = `<img src="${escapeHTML(data.imageUrl)}" alt="Section image" class="section-img-preview">`;
  } else {
    mediaPreview = '<p class="upload-hint">Click or drag an image or video here (optional)</p>';
  }
  return `
    <div class="section-block" data-section-id="${id}">
      <div class="section-header">
        <span class="section-label">Section ${id + 1}</span>
        <div class="section-controls">
          <button type="button" class="btn-icon" data-move="up" title="Move up">&uarr;</button>
          <button type="button" class="btn-icon" data-move="down" title="Move down">&darr;</button>
          <button type="button" class="btn-icon btn-danger-icon" data-remove title="Remove">&times;</button>
        </div>
      </div>
      <div class="form-group">
        <textarea class="section-text" rows="4" placeholder="Write your section text here\u2026">${escapeHTML(data?.text || '')}</textarea>
      </div>
      <div class="section-media-area">
        <div class="media-upload-zone" data-zone="${id}">
          ${mediaPreview}
        </div>
        <input type="file" class="section-media-input" accept="image/*,video/mp4,video/webm" hidden data-zone="${id}">
        <input type="text" class="section-image-alt" placeholder="Image/video description (alt text)"
          value="${escapeHTML(data?.imageAlt || '')}">
        <div class="media-progress" hidden>Uploading\u2026</div>
      </div>
    </div>`;
}

const REF_TYPES = [
  { value: 'publications',  label: 'Publication' },
  { value: 'patents',       label: 'Patent' },
  { value: 'presentations', label: 'Presentation' },
  { value: 'posters',       label: 'Poster' }
];

function refBlockHTML(data) {
  const id = _refCounter++;
  return `
    <div class="ref-block" data-ref-id="${id}">
      <div class="ref-block-row">
        <select class="ref-type">
          ${REF_TYPES.map(t =>
            `<option value="${t.value}" ${data?.type === t.value ? 'selected' : ''}>${t.label}</option>`
          ).join('')}
        </select>
        <input type="text" class="ref-title" placeholder="Title" value="${escapeHTML(data?.title || '')}">
        <input type="url" class="ref-url" placeholder="URL (optional)" value="${escapeHTML(data?.url || '')}">
        <input type="text" class="ref-detail" placeholder="Detail (e.g., journal name)" value="${escapeHTML(data?.detail || '')}">
        <button type="button" class="btn-icon btn-danger-icon" data-remove-ref title="Remove">&times;</button>
      </div>
    </div>`;
}

async function wireStoryEditor(storyId) {
  if (!Auth.currentUser) return;

  const container = document.getElementById('sections-container');
  const form = document.getElementById('story-form');
  if (!container || !form) return;

  _sectionCounter = 0;
  _refCounter = 0;
  let existing = null;
  const sectionImages = {}; // sectionId → { thumb, medium, full }
  const sectionVideos = {}; // sectionId → URL string
  const selectedContributors = []; // { uid, name, photo }

  // Back button
  document.getElementById('editor-back-btn')?.addEventListener('click', () => {
    window.location.hash = '#/dashboard';
  });

  // Populate team dropdowns from all registered users
  const allUsers = await DB.getAllUsers().catch(() => []);
  const mentorSelect = document.getElementById('story-mentor');
  const contribSelect = document.getElementById('story-contributor-select');
  const authorField = document.getElementById('story-author-name');

  authorField.value = Auth.currentProfile?.name || Auth.currentUser.email;

  allUsers.forEach(u => {
    const opt = (sel) => {
      const o = document.createElement('option');
      o.value = u.id;
      o.textContent = u.name || u.email || u.id;
      o.dataset.name = u.name || '';
      o.dataset.photo = u.photo || '';
      sel.appendChild(o);
    };
    opt(mentorSelect);
    if (u.id !== Auth.currentUser.uid) opt(contribSelect);
  });

  // Contributor chips
  const chipsEl = document.getElementById('contributor-chips');

  function renderContributorChips() {
    chipsEl.innerHTML = selectedContributors.map((c, i) =>
      `<span class="contributor-chip">${escapeHTML(c.name || c.uid)}
        <button type="button" class="chip-remove" data-idx="${i}">&times;</button>
      </span>`
    ).join('');
    chipsEl.querySelectorAll('.chip-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedContributors.splice(Number(btn.dataset.idx), 1);
        renderContributorChips();
      });
    });
  }

  document.getElementById('add-contributor-btn').addEventListener('click', () => {
    const sel = contribSelect;
    if (!sel.value) return;
    const opt = sel.options[sel.selectedIndex];
    if (selectedContributors.some(c => c.uid === sel.value)) return;
    selectedContributors.push({
      uid: sel.value,
      name: opt.dataset.name || opt.textContent,
      photo: opt.dataset.photo || ''
    });
    renderContributorChips();
    sel.value = '';
  });

  // References container
  const refsContainer = document.getElementById('refs-container');

  function wireRefBlock(block) {
    block.querySelector('[data-remove-ref]').addEventListener('click', () => {
      block.remove();
    });
  }

  document.getElementById('add-ref-btn').addEventListener('click', () => {
    refsContainer.insertAdjacentHTML('beforeend', refBlockHTML());
    wireRefBlock(refsContainer.lastElementChild);
  });

  // Load existing story
  if (storyId !== 'new') {
    try {
      existing = await DB.getStory(storyId);
    } catch (e) { console.warn('Failed to load story:', e); }
    if (existing) {
      document.getElementById('story-title').value = existing.title || '';
      document.getElementById('story-project').value = existing.project || '';
      document.getElementById('story-description').value = existing.description || '';

      // Restore team
      if (existing.team) {
        if (existing.team.mentor?.uid) mentorSelect.value = existing.team.mentor.uid;
        if (existing.team.contributors) {
          existing.team.contributors.forEach(c => selectedContributors.push(c));
          renderContributorChips();
        }
      }

      // Restore references
      if (existing.references) {
        for (const [type, items] of Object.entries(existing.references)) {
          if (Array.isArray(items)) {
            items.forEach(ref => {
              refsContainer.insertAdjacentHTML('beforeend', refBlockHTML({ ...ref, type }));
              wireRefBlock(refsContainer.lastElementChild);
            });
          }
        }
      }

      // Restore sections
      (existing.sections || []).forEach((sec, i) => {
        container.insertAdjacentHTML('beforeend', sectionBlockHTML({
          text: sec.text,
          imageUrl: sec.image?.medium || sec.image?.full || '',
          videoUrl: sec.video || '',
          imageAlt: sec.imageAlt || ''
        }));
        if (sec.image) sectionImages[i] = sec.image;
        if (sec.video) sectionVideos[i] = sec.video;
      });
    }
  }

  // Ensure at least one section
  if (!container.children.length) {
    container.insertAdjacentHTML('beforeend', sectionBlockHTML());
  }

  // Wire all existing section blocks
  container.querySelectorAll('.section-block').forEach(b => wireSectionBlock(b));

  // Add section
  document.getElementById('add-section-btn').addEventListener('click', () => {
    container.insertAdjacentHTML('beforeend', sectionBlockHTML());
    wireSectionBlock(container.lastElementChild);
    container.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  function wireSectionBlock(block) {
    block.querySelector('[data-move="up"]').addEventListener('click', () => {
      const prev = block.previousElementSibling;
      if (prev) container.insertBefore(block, prev);
      renumber();
    });
    block.querySelector('[data-move="down"]').addEventListener('click', () => {
      const next = block.nextElementSibling;
      if (next) container.insertBefore(next, block);
      renumber();
    });
    block.querySelector('[data-remove]').addEventListener('click', () => {
      if (container.children.length > 1) { block.remove(); renumber(); }
    });

    const zone = block.querySelector('.media-upload-zone');
    const input = block.querySelector('.section-media-input');
    zone.addEventListener('click', () => input.click());
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault(); zone.classList.remove('drag-over');
      if (e.dataTransfer.files[0]) handleMedia(block, e.dataTransfer.files[0]);
    });
    input.addEventListener('change', e => {
      if (e.target.files[0]) handleMedia(block, e.target.files[0]);
    });
  }

  async function handleMedia(block, file) {
    const zone = block.querySelector('.media-upload-zone');
    const prog = block.querySelector('.media-progress');
    const sid = block.dataset.sectionId;
    const isVideo = file.type === 'video/mp4' || file.type === 'video/webm';

    if (isVideo && file.size > 50 * 1024 * 1024) {
      zone.innerHTML = '<p class="error-text">Video must be under 50 MB</p>';
      return;
    }

    prog.hidden = false;
    zone.innerHTML = `<p class="upload-hint">${isVideo ? 'Uploading video' : 'Processing'}\u2026</p>`;

    try {
      const storyRef = existing?.id || 'draft_' + Date.now();
      const basePath = `stories/${storyRef}/section_${sid}`;

      if (isVideo) {
        const ext = file.type === 'video/mp4' ? 'mp4' : 'webm';
        const ref = McgheeLab.storage.ref().child(`${basePath}/video.${ext}`);
        await ref.put(file, { contentType: file.type });
        const url = await ref.getDownloadURL();
        sectionVideos[sid] = url;
        delete sectionImages[sid]; // clear image if replacing
        zone.innerHTML = `<video src="${escapeHTML(url)}" controls playsinline preload="metadata" class="section-video-preview"></video>`;
      } else {
        const blobs = await processImage(file);
        const urls = await uploadImageSet(blobs, basePath);
        sectionImages[sid] = urls;
        delete sectionVideos[sid]; // clear video if replacing
        zone.innerHTML = `<img src="${escapeHTML(urls.medium)}" alt="Section image" class="section-img-preview">`;
      }
    } catch (err) {
      zone.innerHTML = `<p class="error-text">Upload failed: ${escapeHTML(err.message)}</p>`;
    }
    prog.hidden = true;
  }

  function renumber() {
    container.querySelectorAll('.section-label').forEach((lbl, i) => { lbl.textContent = `Section ${i + 1}`; });
  }

  function collectData(status) {
    const sections = [];
    container.querySelectorAll('.section-block').forEach(block => {
      const sid = block.dataset.sectionId;
      sections.push({
        text: block.querySelector('.section-text').value,
        image: sectionImages[sid] || null,
        video: sectionVideos[sid] || null,
        imageAlt: block.querySelector('.section-image-alt').value,
        order: sections.length
      });
    });

    // Build team object
    const mentorOpt = mentorSelect.options[mentorSelect.selectedIndex];
    const team = {
      author: {
        uid: Auth.currentUser.uid,
        name: Auth.currentProfile?.name || '',
        photo: Auth.currentProfile?.photo || ''
      },
      contributors: selectedContributors.map(c => ({
        uid: c.uid, name: c.name, photo: c.photo || ''
      })),
      mentor: mentorSelect.value ? {
        uid: mentorSelect.value,
        name: mentorOpt?.dataset?.name || mentorOpt?.textContent || '',
        photo: mentorOpt?.dataset?.photo || ''
      } : null
    };

    // Build references object grouped by type
    const references = {};
    refsContainer.querySelectorAll('.ref-block').forEach(block => {
      const type = block.querySelector('.ref-type').value;
      const title = block.querySelector('.ref-title').value.trim();
      const url = block.querySelector('.ref-url').value.trim();
      const detail = block.querySelector('.ref-detail').value.trim();
      if (!title && !url) return; // skip empty refs
      if (!references[type]) references[type] = [];
      references[type].push({ title, url, detail });
    });

    return {
      id: existing?.id || undefined,
      title: document.getElementById('story-title').value,
      project: document.getElementById('story-project').value,
      description: document.getElementById('story-description').value,
      authorUid: Auth.currentUser.uid,
      authorName: Auth.currentProfile?.name || '',
      sections,
      team,
      references,
      status
    };
  }

  async function saveStory(status) {
    const st = document.getElementById('editor-status');
    st.hidden = true;
    try {
      const data = collectData(status);
      const id = await DB.saveStory(data);
      st.textContent = status === 'draft' ? 'Draft saved!'
        : (Auth.canPublish() ? 'Published!' : 'Submitted for review!');
      st.className = 'form-status success'; st.hidden = false;
      if (!existing) window.location.hash = `#/dashboard/story/${id}`;
      existing = { ...data, id };
    } catch (err) {
      st.textContent = 'Error: ' + err.message;
      st.className = 'form-status error'; st.hidden = false;
    }
  }

  // Save draft
  document.getElementById('save-draft-btn').addEventListener('click', () => saveStory('draft'));

  // Publish / submit
  form.addEventListener('submit', e => {
    e.preventDefault();
    saveStory(Auth.canPublish() ? 'published' : 'pending');
  });

  // Preview
  document.getElementById('preview-btn').addEventListener('click', () => {
    const data = collectData('preview');
    const body = document.getElementById('story-preview-body');
    body.innerHTML = `
      <h3>${escapeHTML(data.title)}</h3>
      <p>${escapeHTML(data.description)}</p>
      ${data.sections.map(sec => {
        const hasMedia = sec.image || sec.video;
        let mediaHTML = '';
        if (sec.video) {
          mediaHTML = `<video src="${escapeHTML(sec.video)}" controls playsinline preload="metadata" class="preview-video"></video>`;
        } else if (sec.image) {
          mediaHTML = `<img src="${escapeHTML(sec.image.medium)}" alt="${escapeHTML(sec.imageAlt)}" class="preview-img">`;
        }
        return `
        <div class="preview-media ${hasMedia ? '' : 'text-only'}">
          <div class="preview-text"><p>${escapeHTML(sec.text)}</p></div>
          ${mediaHTML}
        </div>`;
      }).join('')}`;
    document.getElementById('story-preview-modal').hidden = false;
  });

  // Close preview
  document.getElementById('close-preview-btn')?.addEventListener('click', () => {
    document.getElementById('story-preview-modal').hidden = true;
  });
}

/* ================================================================
   RENDER: OPPORTUNITIES PAGE (public)
   ================================================================ */
function renderOpportunities() {
  return `
    <div class="opportunities-page">
      <h2>Opportunities</h2>
      <p class="page-subtitle">Open positions and opportunities in the McGhee Lab.</p>
      <div id="opportunities-list" class="opportunities-grid">
        <p class="loading-text">Loading opportunities\u2026</p>
      </div>
    </div>`;
}

async function wireOpportunities() {
  const el = document.getElementById('opportunities-list');
  if (!el) return;

  try {
    const opps = McgheeLab.DB ? await DB.getOpenOpportunities() : [];
    if (!opps.length) {
      el.innerHTML = '<div class="empty-state-card"><h3>No Open Positions</h3><p>Check back later for new opportunities in the McGhee Lab.</p></div>';
      return;
    }
    el.innerHTML = opps.map(o => `
      <div class="opportunity-card">
        <div class="opp-type-badge">${escapeHTML(o.type || 'Position')}</div>
        <h3>${escapeHTML(o.title || 'Untitled')}</h3>
        ${o.description ? `<p>${escapeHTML(o.description)}</p>` : ''}
        ${o.requirements ? `<div class="opp-requirements"><strong>Requirements:</strong> ${escapeHTML(o.requirements)}</div>` : ''}
        ${o.deadline ? `<p class="opp-deadline">Deadline: <strong>${escapeHTML(o.deadline)}</strong></p>` : ''}
        ${o.contactEmail ? `<p class="opp-contact"><a href="mailto:${escapeHTML(o.contactEmail)}">Apply / Inquire</a></p>` : ''}
      </div>
    `).join('');
  } catch (err) {
    el.innerHTML = '<div class="empty-state-card"><h3>No Open Positions</h3><p>Check back later for new opportunities in the McGhee Lab.</p></div>';
  }
}

/* ================================================================
   RENDER: ADMIN PANEL
   ================================================================ */
function renderAdmin() {
  if (!Auth.isAdmin()) { window.location.hash = '#/dashboard'; return '<p>Access denied.</p>'; }

  return `
    <div class="admin-page">
      <h2>Admin Panel</h2>
      <div class="admin-tabs">
        <button class="tab-btn active" data-tab="users">Users</button>
        <button class="tab-btn" data-tab="invitations">Invitations</button>
        <button class="tab-btn" data-tab="stories">Pending Stories</button>
        <button class="tab-btn" data-tab="opportunities">Opportunities</button>
      </div>

      <!-- Users -->
      <div id="tab-users" class="tab-content active">
        <div id="users-list" class="admin-list"><p class="loading-text">Loading users\u2026</p></div>
      </div>

      <!-- Invitations -->
      <div id="tab-invitations" class="tab-content">
        <div class="inv-form-section">
          <h3>Generate Invitation</h3>
          <form id="inv-form" class="inline-form">
            <select id="inv-profile">
              <option value="">-- No existing profile (new member) --</option>
            </select>
            <input type="email" id="inv-email" placeholder="Email (optional)" autocomplete="off">
            <select id="inv-role">
              <option value="contributor">Contributor</option>
              <option value="editor">Editor</option>
            </select>
            <select id="inv-category">${categoryOptions('undergrad')}</select>
            <select id="inv-expiry">
              <option value="7">7 days</option>
              <option value="30" selected>30 days</option>
              <option value="90">90 days</option>
            </select>
            <button type="submit" class="btn btn-primary">Generate Link</button>
          </form>
          <p class="hint">Select an existing team member to let them claim their profile on registration.</p>
          <div id="inv-result" hidden>
            <p>Invitation link (share with the student):</p>
            <div class="copy-row">
              <input type="text" id="inv-link" readonly>
              <button class="btn btn-secondary btn-small" id="copy-inv-btn">Copy</button>
            </div>
          </div>
        </div>
        <h3>Existing Invitations</h3>
        <div id="inv-list" class="admin-list"><p class="loading-text">Loading\u2026</p></div>
      </div>

      <!-- Pending Stories -->
      <div id="tab-stories" class="tab-content">
        <div id="pending-list" class="admin-list"><p class="loading-text">Loading\u2026</p></div>
      </div>

      <!-- Opportunities -->
      <div id="tab-opportunities" class="tab-content">
        <div class="inv-form-section">
          <h3>Post Opportunity</h3>
          <form id="opp-form" class="opp-form">
            <div class="form-group">
              <label for="opp-title">Title</label>
              <input type="text" id="opp-title" required placeholder="e.g., Undergraduate Research Assistant">
            </div>
            <div class="form-group">
              <label for="opp-type">Type</label>
              <select id="opp-type">
                <option value="Undergraduate Research">Undergraduate Research</option>
                <option value="Graduate Position">Graduate Position</option>
                <option value="Postdoc Position">Postdoc Position</option>
                <option value="Staff">Staff</option>
                <option value="Other">Other</option>
              </select>
            </div>
            <div class="form-group">
              <label for="opp-description">Description</label>
              <textarea id="opp-description" rows="3" placeholder="Describe the position"></textarea>
            </div>
            <div class="form-group">
              <label for="opp-requirements">Requirements</label>
              <textarea id="opp-requirements" rows="2" placeholder="Qualifications, skills, etc."></textarea>
            </div>
            <div class="form-group">
              <label for="opp-deadline">Application Deadline (optional)</label>
              <input type="text" id="opp-deadline" placeholder="e.g., March 31, 2026">
            </div>
            <div class="form-group">
              <label for="opp-contact">Contact Email</label>
              <input type="email" id="opp-contact" placeholder="PI or contact email">
            </div>
            <div class="form-group">
              <label for="opp-status">Status</label>
              <select id="opp-status">
                <option value="open">Open</option>
                <option value="closed">Closed</option>
              </select>
            </div>
            <button type="submit" class="btn btn-primary">Save Opportunity</button>
            <div id="opp-form-status" class="form-status" hidden></div>
          </form>
        </div>
        <h3>All Opportunities</h3>
        <div id="opp-list" class="admin-list"><p class="loading-text">Loading\u2026</p></div>
      </div>
    </div>`;
}

async function wireAdmin() {
  if (!Auth.isAdmin()) return;

  // Tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    });
  });

  loadUsers();
  loadInvitations();
  loadPending();

  // Populate unclaimed profiles dropdown
  try {
    const unclaimed = await DB.getUnclaimedProfiles();
    const profileSelect = document.getElementById('inv-profile');
    if (profileSelect && unclaimed.length) {
      unclaimed.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `${p.name || 'Unknown'}  (${p.category || ''})`;
        profileSelect.appendChild(opt);
      });
      // Auto-fill category (and role) when a profile is selected
      profileSelect.addEventListener('change', () => {
        const selected = unclaimed.find(p => p.id === profileSelect.value);
        if (selected) {
          document.getElementById('inv-category').value = selected.category || 'undergrad';
          syncRoleToCategory();
        }
      });
    }
  } catch (e) { console.warn('Failed to load unclaimed profiles:', e); }

  // Auto-set role when category changes
  function syncRoleToCategory() {
    const cat = document.getElementById('inv-category').value;
    const defaultRole = CATEGORY_DEFAULT_ROLE[cat] || 'contributor';
    document.getElementById('inv-role').value = defaultRole;
  }
  document.getElementById('inv-category')?.addEventListener('change', syncRoleToCategory);
  syncRoleToCategory(); // set initial default

  // Invitation form
  document.getElementById('inv-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const days = parseInt(document.getElementById('inv-expiry').value);
    const exp = new Date(); exp.setDate(exp.getDate() + days);
    const claimProfileId = document.getElementById('inv-profile')?.value || null;
    try {
      const token = await DB.createInvitation({
        email: document.getElementById('inv-email').value || null,
        role: document.getElementById('inv-role').value,
        category: document.getElementById('inv-category').value,
        claimProfileId,
        createdBy: Auth.currentUser.uid,
        expiresAt: firebase.firestore.Timestamp.fromDate(exp)
      });
      const base = window.location.origin + window.location.pathname;
      document.getElementById('inv-link').value = `${base}#/login?token=${token}`;
      document.getElementById('inv-result').hidden = false;
      loadInvitations();
    } catch (err) { alert('Failed: ' + err.message); }
  });

  // Copy button
  document.getElementById('copy-inv-btn')?.addEventListener('click', () => {
    const input = document.getElementById('inv-link');
    input.select();
    navigator.clipboard.writeText(input.value).then(() => {
      document.getElementById('copy-inv-btn').textContent = 'Copied!';
      setTimeout(() => { document.getElementById('copy-inv-btn').textContent = 'Copy'; }, 2000);
    });
  });

  // Opportunities management
  loadOpportunities();

  document.getElementById('opp-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const st = document.getElementById('opp-form-status');
    st.hidden = true;
    try {
      await DB.saveOpportunity({
        title: document.getElementById('opp-title').value,
        type: document.getElementById('opp-type').value,
        description: document.getElementById('opp-description').value,
        requirements: document.getElementById('opp-requirements').value,
        deadline: document.getElementById('opp-deadline').value,
        contactEmail: document.getElementById('opp-contact').value,
        status: document.getElementById('opp-status').value,
        createdBy: Auth.currentUser.uid
      });
      st.textContent = 'Opportunity saved!';
      st.className = 'form-status success'; st.hidden = false;
      document.getElementById('opp-form').reset();
      loadOpportunities();
    } catch (err) {
      st.textContent = 'Error: ' + err.message;
      st.className = 'form-status error'; st.hidden = false;
    }
  });
}

async function loadUsers() {
  const el = document.getElementById('users-list');
  if (!el) return;
  try {
    const users = await DB.getAllUsers();
    if (!users.length) { el.innerHTML = '<p class="empty-state">No registered users.</p>'; return; }
    el.innerHTML = `
      <table class="admin-table">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Category</th><th></th></tr></thead>
        <tbody>
          ${users.map(u => `
            <tr>
              <td>${escapeHTML(u.name || '\u2014')}</td>
              <td>${escapeHTML(u.email || '\u2014')}</td>
              <td>
                <select data-uid="${u.id}" class="role-select">
                  ${Object.entries(ROLES).map(([k, v]) =>
                    `<option value="${k}" ${u.role === k ? 'selected' : ''}>${v.label}</option>`
                  ).join('')}
                </select>
              </td>
              <td>
                <select data-cat-uid="${u.id}" class="category-select">
                  ${categoryOptions(u.category)}
                </select>
              </td>
              <td>
                <button class="btn btn-secondary btn-small" data-save-user="${u.id}">Save</button>
                <button class="btn btn-danger btn-small" data-delete-user="${u.id}">Delete</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;

    el.querySelectorAll('[data-save-user]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const uid = btn.dataset.saveUser;
        const roleSel = el.querySelector(`select[data-uid="${uid}"]`);
        const catSel = el.querySelector(`select[data-cat-uid="${uid}"]`);
        await DB.updateUser(uid, { role: roleSel.value, category: catSel.value });
        btn.textContent = 'Saved!';
        setTimeout(() => { btn.textContent = 'Save'; }, 1500);
      });
    });

    el.querySelectorAll('[data-delete-user]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const uid = btn.dataset.deleteUser;
        if (uid === Auth.currentUser.uid) {
          alert('You cannot delete your own account.');
          return;
        }
        if (!confirm('Delete this user profile? To also remove their login, delete them in Firebase Console → Authentication.')) return;
        await DB.deleteUser(uid);
        loadUsers();
      });
    });
  } catch (err) {
    el.innerHTML = '<p class="error-text">Failed to load users.</p>';
  }
}

async function loadInvitations() {
  const el = document.getElementById('inv-list');
  if (!el) return;
  try {
    const invs = await DB.getAllInvitations();
    if (!invs.length) { el.innerHTML = '<p class="empty-state">No invitations yet.</p>'; return; }
    const base = window.location.origin + window.location.pathname;
    el.innerHTML = `
      <table class="admin-table">
        <thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Expires</th><th></th></tr></thead>
        <tbody>
          ${invs.map(inv => {
            const expired = inv.expiresAt && inv.expiresAt.toDate() < new Date();
            const status = inv.used ? 'Used' : (expired ? 'Expired' : 'Active');
            return `
              <tr class="${inv.used ? 'row-used' : (expired ? 'row-expired' : '')}">
                <td>${escapeHTML(inv.email || 'Any')}</td>
                <td>${escapeHTML(inv.role || '\u2014')}</td>
                <td><span class="status-badge status-${status.toLowerCase()}">${status}</span></td>
                <td>${inv.expiresAt ? inv.expiresAt.toDate().toLocaleDateString() : '\u2014'}</td>
                <td>${!inv.used && !expired
                  ? `<button class="btn btn-secondary btn-small" data-copy-inv="${inv.id}">Copy Link</button>`
                  : '\u2014'}</td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>`;

    el.querySelectorAll('[data-copy-inv]').forEach(btn => {
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(`${base}#/login?token=${btn.dataset.copyInv}`);
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy Link'; }, 2000);
      });
    });
  } catch (err) {
    el.innerHTML = '<p class="error-text">Failed to load invitations.</p>';
  }
}

async function loadPending() {
  const el = document.getElementById('pending-list');
  if (!el) return;
  try {
    const stories = await DB.getPendingStories();
    if (!stories.length) { el.innerHTML = '<p class="empty-state">No stories pending review.</p>'; return; }
    el.innerHTML = stories.map(s => `
      <div class="pending-card">
        <div class="pending-info">
          <strong>${escapeHTML(s.title || 'Untitled')}</strong>
          <span class="pending-author">by ${escapeHTML(s.authorName || 'Unknown')}</span>
          ${s.description ? `<p>${escapeHTML(s.description)}</p>` : ''}
        </div>
        <div class="pending-sections">
          ${(s.sections || []).slice(0, 2).map(sec => `
            <div class="pending-section-preview">
              <p>${escapeHTML((sec.text || '').substring(0, 200))}${(sec.text || '').length > 200 ? '\u2026' : ''}</p>
              ${sec.image ? `<img src="${escapeHTML(sec.image.thumb)}" alt="${escapeHTML(sec.imageAlt || '')}">` : ''}
            </div>`).join('')}
        </div>
        <div class="pending-actions">
          <button class="btn btn-primary btn-small" data-approve="${s.id}">Approve</button>
          <button class="btn btn-danger btn-small" data-reject="${s.id}">Reject</button>
          <button class="btn btn-secondary btn-small" data-view-story="${s.id}">View Full</button>
        </div>
      </div>`).join('');

    el.querySelectorAll('[data-approve]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await DB.updateStoryStatus(btn.dataset.approve, 'published');
        loadPending();
      });
    });
    el.querySelectorAll('[data-reject]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Reject this story? The author can revise and resubmit.')) return;
        await DB.updateStoryStatus(btn.dataset.reject, 'draft');
        loadPending();
      });
    });
    el.querySelectorAll('[data-view-story]').forEach(btn => {
      btn.addEventListener('click', () => {
        window.location.hash = '#/dashboard/story/' + btn.dataset.viewStory;
      });
    });
  } catch (err) {
    el.innerHTML = '<p class="error-text">Failed to load pending stories.</p>';
  }
}

async function loadOpportunities() {
  const el = document.getElementById('opp-list');
  if (!el) return;
  try {
    const opps = await DB.getAllOpportunities();
    if (!opps.length) { el.innerHTML = '<p class="empty-state">No opportunities posted.</p>'; return; }
    el.innerHTML = `
      <table class="admin-table">
        <thead><tr><th>Title</th><th>Type</th><th>Status</th><th>Deadline</th><th></th></tr></thead>
        <tbody>
          ${opps.map(o => `
            <tr>
              <td>${escapeHTML(o.title || '')}</td>
              <td>${escapeHTML(o.type || '')}</td>
              <td><span class="status-badge status-${o.status === 'open' ? 'published' : 'draft'}">${o.status || 'open'}</span></td>
              <td>${escapeHTML(o.deadline || '—')}</td>
              <td><button class="btn btn-danger btn-small" data-delete-opp="${o.id}">Delete</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>`;
    el.querySelectorAll('[data-delete-opp]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this opportunity?')) return;
        await DB.deleteOpportunity(btn.dataset.deleteOpp);
        loadOpportunities();
      });
    });
  } catch (err) {
    el.innerHTML = '<p class="error-text">Failed to load opportunities.</p>';
  }
}

/* ================================================================
   EXPORTS
   ================================================================ */
McgheeLab.Auth             = Auth;
McgheeLab.DB               = DB;
McgheeLab.ROLES            = ROLES;
McgheeLab.processImage     = processImage;
McgheeLab.uploadImageSet   = uploadImageSet;
McgheeLab.renderLogin      = renderLogin;
McgheeLab.wireLogin        = wireLogin;
McgheeLab.renderDashboard  = renderDashboard;
McgheeLab.wireDashboard    = wireDashboard;
McgheeLab.renderStoryEditor = renderStoryEditor;
McgheeLab.wireStoryEditor  = wireStoryEditor;
McgheeLab.renderProjectEditor = renderProjectEditor;
McgheeLab.wireProjectEditor   = wireProjectEditor;
McgheeLab.renderGuide      = renderGuide;
McgheeLab.renderOpportunities  = renderOpportunities;
McgheeLab.wireOpportunities    = wireOpportunities;
McgheeLab.renderAdmin      = renderAdmin;
McgheeLab.wireAdmin        = wireAdmin;

// Initialize auth listener on DOM ready
document.addEventListener('DOMContentLoaded', () => Auth.init());

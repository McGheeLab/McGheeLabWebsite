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
  contributor: { label: 'Contributor', canPublish: false, canManage: false },
  guest:       { label: 'Guest',       canPublish: false, canManage: false }
};

const CATEGORIES = [
  { value: 'pi',         label: 'PI' },
  { value: 'postdoc',    label: 'Postdoc' },
  { value: 'grad',       label: 'Graduate Student' },
  { value: 'undergrad',  label: 'Undergraduate' },
  { value: 'highschool', label: 'High School' },
  { value: 'alumni',     label: 'Alumni' },
  { value: 'guest',      label: 'Guest' }
];

/* Default role per category — PI gets admin, grad/postdoc get editor, others get contributor */
const CATEGORY_DEFAULT_ROLE = {
  pi:         'admin',
  postdoc:    'editor',
  grad:       'editor',
  undergrad:  'contributor',
  highschool: 'contributor',
  alumni:     'contributor',
  guest:      'guest'
};

/* Association types users can add to their profile */
const ASSOC_TYPES = [
  { key: 'papers',        label: 'Papers' },
  { key: 'posters',       label: 'Posters' },
  { key: 'presentations', label: 'Presentations' },
  { key: 'patents',       label: 'Patents' },
  { key: 'protocols',     label: 'Protocols' }
];

/* Badge definitions for team cards — SVG icons at 14×14 */
const BADGE_DEFS = [
  { key: 'papers',        label: 'Papers',
    svg: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>' },
  { key: 'posters',       label: 'Posters',
    svg: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>' },
  { key: 'presentations', label: 'Presentations',
    svg: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h20v14H2z"/><path d="M12 17v4"/><path d="M8 21h8"/><circle cx="12" cy="10" r="3"/></svg>' },
  { key: 'patents',       label: 'Patents',
    svg: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>' },
  { key: 'stories',       label: 'Stories',
    svg: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>' },
  { key: 'protocols',     label: 'Protocols',
    svg: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/></svg>' },
  { key: 'finalWork',     label: 'Thesis / Final Project',
    svg: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c0 2 3 3 6 3s6-1 6-3v-5"/></svg>' },
  { key: 'cv',            label: 'CV',
    svg: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' },
  { key: 'github',        label: 'GitHub',
    svg: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.43 9.8 8.21 11.39.6.11.79-.26.79-.58v-2.23c-3.34.73-4.03-1.42-4.03-1.42-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.49 1 .11-.78.42-1.3.76-1.6-2.67-.31-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6.01 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.65.24 2.87.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.62-5.48 5.92.43.37.82 1.1.82 2.22v3.29c0 .32.19.69.8.58C20.57 21.8 24 17.3 24 12c0-6.63-5.37-12-12-12z"/></svg>' },
  { key: 'linkedin',      label: 'LinkedIn',
    svg: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M20.45 20.45h-3.55v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.36V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.72v20.56C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.72V1.72C24 .77 23.2 0 22.22 0z"/></svg>' },
  { key: 'researchgate',  label: 'ResearchGate',
    svg: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19.59 18.75c-.48.96-1.33 1.62-2.26 1.95-.93.33-2.04.36-3.3-.03-.93-.29-1.83-.82-2.65-1.59-.83-.77-1.55-1.77-2.14-3.01l-.97-2.03c-.46-.95-.88-1.56-1.32-1.95-.44-.39-.94-.58-1.6-.58h-.35v2.79c0 .49.05.85.14 1.05.1.2.26.35.5.44.24.09.68.16 1.32.19v.53H2.5v-.53c.59-.03 1.01-.1 1.25-.19.24-.09.4-.24.5-.44.1-.2.14-.56.14-1.05V8.31c0-.49-.05-.85-.14-1.05-.1-.2-.26-.35-.5-.44C3.51 6.73 3.09 6.66 2.5 6.63v-.53h5.16c1.88 0 3.27.36 4.17 1.07.9.72 1.36 1.7 1.36 2.95 0 .86-.23 1.61-.69 2.25-.46.63-1.15 1.1-2.06 1.4.54.22 1.01.6 1.42 1.12.41.52.86 1.3 1.35 2.32l.76 1.57c.42.86.81 1.44 1.18 1.74.37.3.78.45 1.24.45.28 0 .53-.06.74-.17.22-.12.4-.29.55-.52l.41.47zm-9.33-7.16c.67 0 1.2-.27 1.58-.82.39-.55.58-1.34.58-2.37 0-1.06-.2-1.87-.6-2.42-.4-.55-.96-.83-1.69-.83-.47 0-.83.07-1.08.21-.25.14-.41.33-.5.56-.08.24-.12.62-.12 1.15v4.52h1.83z"/></svg>' },
  { key: 'googleScholar', label: 'Google Scholar',
    svg: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M5.24 14.78A5.01 5.01 0 0 0 10 19a5 5 0 0 0 4.76-4.22H10v-2.56h8.76c.1.56.16 1.14.16 1.78 0 5.04-3.36 8.62-8.92 8.62A9.3 9.3 0 0 1 .7 13.32 9.3 9.3 0 0 1 10 4.02c2.48 0 4.56.88 6.18 2.34l-2.6 2.5C12.54 7.88 11.36 7.4 10 7.4a5.36 5.36 0 0 0-4.76 7.38z"/></svg>' }
];

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

/* ── Square-crop modal for profile photos ────────────────────── */
function openCropModal(file) {
  return new Promise((resolve, reject) => {
    const objUrl = URL.createObjectURL(file);
    const overlay = document.createElement('div');
    overlay.className = 'crop-overlay';
    overlay.innerHTML = `
      <div class="crop-modal">
        <h3>Crop Photo</h3>
        <div class="crop-container">
          <img class="crop-source" src="${objUrl}" alt="Crop preview">
          <div class="crop-box"></div>
        </div>
        <div class="crop-actions">
          <button type="button" class="btn btn-secondary crop-cancel">Cancel</button>
          <button type="button" class="btn btn-primary crop-confirm">Crop &amp; Upload</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const img = overlay.querySelector('.crop-source');
    const container = overlay.querySelector('.crop-container');
    const box = overlay.querySelector('.crop-box');

    function cleanup() { URL.revokeObjectURL(objUrl); overlay.remove(); }

    overlay.querySelector('.crop-cancel').addEventListener('click', () => {
      cleanup();
      reject(new Error('Crop cancelled'));
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { cleanup(); reject(new Error('Crop cancelled')); }
    });

    img.onload = () => {
      /* Fit image in viewport-limited container — CSS handles max sizes.
         Compute initial square crop box (centered, 80% of shorter side). */
      const cw = container.offsetWidth, ch = container.offsetHeight;
      const iw = img.naturalWidth, ih = img.naturalHeight;
      // displayed size (img is object-fit:contain so calc manually)
      const scale = Math.min(cw / iw, ch / ih);
      const dw = iw * scale, dh = ih * scale;
      const offX = (cw - dw) / 2, offY = (ch - dh) / 2;

      let side = Math.round(Math.min(dw, dh) * 0.8);
      let bx = Math.round(offX + (dw - side) / 2);
      let by = Math.round(offY + (dh - side) / 2);

      function clamp() {
        side = Math.max(40, Math.min(side, dw, dh));
        bx = Math.max(offX, Math.min(bx, offX + dw - side));
        by = Math.max(offY, Math.min(by, offY + dh - side));
      }
      function apply() {
        clamp();
        box.style.left = bx + 'px'; box.style.top = by + 'px';
        box.style.width = side + 'px'; box.style.height = side + 'px';
      }
      apply();

      /* Drag the crop box */
      let dragging = false, resizing = false, sx, sy, sbx, sby, sSide;
      box.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const rect = box.getBoundingClientRect();
        const ex = e.clientX - rect.left, ey = e.clientY - rect.top;
        // bottom-right 18px corner = resize handle
        if (ex > rect.width - 18 && ey > rect.height - 18) {
          resizing = true;
        } else {
          dragging = true;
        }
        sx = e.clientX; sy = e.clientY; sbx = bx; sby = by; sSide = side;
        box.setPointerCapture(e.pointerId);
      });
      box.addEventListener('pointermove', (e) => {
        if (dragging) {
          bx = sbx + (e.clientX - sx);
          by = sby + (e.clientY - sy);
          apply();
        } else if (resizing) {
          const delta = Math.max(e.clientX - sx, e.clientY - sy);
          side = sSide + delta;
          apply();
        }
      });
      box.addEventListener('pointerup', () => { dragging = false; resizing = false; });

      /* Confirm crop — extract square from original image */
      overlay.querySelector('.crop-confirm').addEventListener('click', () => {
        // Convert displayed crop coords → original image coords
        const cx = (bx - offX) / scale;
        const cy = (by - offY) / scale;
        const cs = side / scale;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = Math.round(cs);
        canvas.getContext('2d').drawImage(img, cx, cy, cs, cs, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(blob => {
          cleanup();
          if (blob) resolve(blob); else reject(new Error('Crop failed'));
        }, 'image/webp', 0.92);
      });
    };
    img.onerror = () => { cleanup(); reject(new Error('Image load failed')); };
  });
}

async function processImage(fileOrBlob) {
  const out = {};
  for (const [size, cfg] of Object.entries(IMAGE_SIZES)) {
    out[size] = await resizeImage(fileOrBlob, cfg.maxWidth, cfg.quality);
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
    // Cascade-delete all comments and reactions by this user
    const commentSnap = await McgheeLab.db.collection('comments')
      .where('authorUid', '==', uid).get();
    const reactionSnap = await McgheeLab.db.collection('reactions')
      .where('authorUid', '==', uid).get();
    const allRefs = [
      ...commentSnap.docs.map(d => d.ref),
      ...reactionSnap.docs.map(d => d.ref),
      McgheeLab.db.collection('users').doc(uid)
    ];
    // Firestore batches limited to 500 ops — chunk if needed
    for (let i = 0; i < allRefs.length; i += 499) {
      const batch = McgheeLab.db.batch();
      allRefs.slice(i, i + 499).forEach(ref => batch.delete(ref));
      await batch.commit();
    }
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
    delete data.id;
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
      .where('status', '==', 'published').orderBy('order', 'asc').get();
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
    delete data.id;
    data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    const ref = await McgheeLab.db.collection('projectPackages').add(data);
    return ref.id;
  },
  async deleteProject(id) {
    await McgheeLab.db.collection('projectPackages').doc(id).delete();
  },
  async updateProjectOrder(projectId, order) {
    await McgheeLab.db.collection('projectPackages').doc(projectId).update({
      order, updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  },
  async getStoriesByProject(projectId) {
    const snap = await McgheeLab.db.collection('stories')
      .where('projectId', '==', projectId)
      .where('status', '==', 'published')
      .orderBy('publishedAt', 'desc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },

  /* ── News Posts ── */
  async getNewsPost(id) {
    const doc = await McgheeLab.db.collection('newsPosts').doc(id).get();
    return doc.exists ? { id: doc.id, ...doc.data() } : null;
  },
  async getNewsByUser(uid) {
    const snap = await McgheeLab.db.collection('newsPosts')
      .where('authorUid', '==', uid).orderBy('updatedAt', 'desc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },
  async getPublishedNews() {
    const snap = await McgheeLab.db.collection('newsPosts')
      .where('status', '==', 'published').orderBy('publishedAt', 'desc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },
  async getPendingNews() {
    const snap = await McgheeLab.db.collection('newsPosts')
      .where('status', '==', 'pending').orderBy('updatedAt', 'desc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },
  async saveNewsPost(data) {
    data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    if (data.id) {
      const id = data.id;
      const rest = Object.assign({}, data);
      delete rest.id;
      await McgheeLab.db.collection('newsPosts').doc(id).set(rest, { merge: true });
      return id;
    }
    delete data.id;
    data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    const ref = await McgheeLab.db.collection('newsPosts').add(data);
    return ref.id;
  },
  async updateNewsStatus(id, status) {
    const update = { status, updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
    if (status === 'published') update.publishedAt = firebase.firestore.FieldValue.serverTimestamp();
    await McgheeLab.db.collection('newsPosts').doc(id).update(update);
  },
  async deleteNewsPost(id) {
    await McgheeLab.db.collection('newsPosts').doc(id).delete();
  },

  /* ── Comments ── */
  async getCommentsByStory(storyId) {
    const snap = await McgheeLab.db.collection('comments')
      .where('storyId', '==', storyId)
      .orderBy('createdAt', 'asc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },
  async addComment(data) {
    data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    const ref = await McgheeLab.db.collection('comments').add(data);
    return ref.id;
  },
  async deleteComment(id) {
    await McgheeLab.db.collection('comments').doc(id).delete();
  },

  /* ── Reactions ── */
  async getReactionsByStory(storyId) {
    const snap = await McgheeLab.db.collection('reactions')
      .where('storyId', '==', storyId).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },
  async toggleReaction(storyId, emoji) {
    const uid = Auth.currentUser?.uid;
    if (!uid) return;
    const docId = storyId + '_' + uid + '_' + emoji;
    const ref = McgheeLab.db.collection('reactions').doc(docId);
    const doc = await ref.get();
    if (doc.exists) {
      await ref.delete();
      return false;
    }
    await ref.set({
      storyId, authorUid: uid, emoji,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    return true;
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

  /* ── Classes (course listings) ── */
  async getPublishedClasses() {
    const snap = await McgheeLab.db.collection('classes')
      .where('status', '==', 'published').get();
    const classes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    classes.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return classes;
  },
  async getAllClasses() {
    const snap = await McgheeLab.db.collection('classes').orderBy('order', 'asc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },
  async saveClass(data) {
    data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    if (data.id) {
      const id = data.id; delete data.id;
      await McgheeLab.db.collection('classes').doc(id).update(data);
      return id;
    }
    data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    const ref = await McgheeLab.db.collection('classes').add(data);
    return ref.id;
  },
  async deleteClass(id) {
    await McgheeLab.db.collection('classes').doc(id).delete();
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
  },

  /* ── CV Data ─────────────────────────────────────────────────── */
  async getCVData(uid) {
    const doc = await McgheeLab.db.collection('cvData').doc(uid).get();
    return doc.exists ? doc.data() : null;
  },
  async saveCVData(uid, data) {
    await McgheeLab.db.collection('cvData').doc(uid).set(
      { ...data, updatedAt: firebase.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
  },

  /* ── Association Sync: CV → User Profile ─────────────────────── */
  async syncCVToProfile(uid, cvData) {
    const stripTags = s => (s || '').replace(/<[^>]+>/g, '');
    const papers = (cvData.journals || []).map(j => ({
      title: stripTags(j.title),
      url: j.doi ? 'https://doi.org/' + j.doi : '',
      year: j.year || '',
      citations: j.citations || 0,
      journal: j.journal || '',
      authors: j.authors || '',
      volume: j.volume || '',
      issue: j.issue || '',
      pages: j.pages || '',
      status: j.status || ''
    })).filter(p => p.title);
    const posters = (cvData.conferences || []).map(c => ({
      title: stripTags(c.title),
      url: c.doi ? 'https://doi.org/' + c.doi : '',
      year: c.year || '',
      conference: c.conference || '',
      authors: c.authors || ''
    })).filter(p => p.title);
    const presentations = (cvData.presentations || []).map(p => ({
      title: stripTags(p.title),
      url: p.slides_url || '',
      year: p.date ? String(p.date).slice(0, 4) : (p.year || ''),
      event: p.event || '',
      type: p.type || ''
    })).filter(p => p.title);
    const patents = (cvData.patents || []).map(p => ({
      title: stripTags(p.title),
      url: p.number || '',
      year: p.grant_date ? String(p.grant_date).slice(0, 4) : (p.filing_date ? String(p.filing_date).slice(0, 4) : ''),
      status: p.status || '',
      inventors: p.inventors || ''
    })).filter(p => p.title);
    await DB.updateUser(uid, { papers, posters, presentations, patents });
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
    const isAuthed  = !!Auth.currentUser;
    const role      = Auth.currentProfile?.role;
    const isAdmin   = role === 'admin';
    const isNotGuest = isAuthed && role !== 'guest';

    // Toggle auth-gated items across all nav surfaces (drawer, desktop nav, more sheet)
    const toggle = (ids, show) => {
      ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = show ? '' : 'none';
      });
    };
    toggle(['nav-dashboard', 'dnav-dashboard', 'more-dashboard'], isAuthed);
    toggle(['nav-admin',     'dnav-admin',     'more-admin'],     isAdmin);
    toggle(['nav-apps',      'dnav-apps',      'more-apps'],      isNotGuest);

    // Login/Logout text swap across all nav surfaces
    ['nav-login', 'dnav-login', 'more-login'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = isAuthed ? 'Logout' : 'Login';
      el.href = isAuthed ? '#/logout' : '#/login';
      el.setAttribute('data-route', isAuthed ? 'logout' : 'login');
    });

    // Header user button
    const userBtn = document.getElementById('header-user-btn');
    if (userBtn) {
      const nameEl = userBtn.querySelector('.header-user-name');
      if (Auth.currentUser) {
        const p = Auth.currentProfile || {};
        const photoUrl = p.photo?.thumb || p.photo?.medium || '';
        const name = p.name || Auth.currentUser.displayName || '';

        // Show avatar if available
        const existingAvatar = userBtn.querySelector('.header-user-avatar');
        if (photoUrl) {
          if (!existingAvatar) {
            const img = document.createElement('img');
            img.className = 'header-user-avatar';
            img.alt = '';
            img.src = photoUrl;
            userBtn.insertBefore(img, userBtn.firstChild);
          } else {
            existingAvatar.src = photoUrl;
          }
          userBtn.classList.add('has-photo');
        } else {
          if (existingAvatar) existingAvatar.remove();
          userBtn.classList.remove('has-photo');
        }

        if (nameEl) nameEl.textContent = name;
        userBtn.href = '#/dashboard';
        userBtn.setAttribute('aria-label', name || 'Account');
      } else {
        const existingAvatar = userBtn.querySelector('.header-user-avatar');
        if (existingAvatar) existingAvatar.remove();
        userBtn.classList.remove('has-photo');
        if (nameEl) nameEl.textContent = '';
        userBtn.href = '#/login';
        userBtn.setAttribute('aria-label', 'Login');
      }
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

  async googleLogin() {
    const provider = new firebase.auth.GoogleAuthProvider();
    const cred = await McgheeLab.auth.signInWithPopup(provider);
    const user = cred.user;
    // Check if user doc exists; if not, create a guest profile
    const existing = await DB.getUser(user.uid).catch(() => null);
    if (!existing) {
      await DB.updateUser(user.uid, {
        name: user.displayName || '',
        email: user.email || '',
        photo: user.photoURL ? { thumb: user.photoURL, medium: user.photoURL, full: user.photoURL } : null,
        bio: '',
        category: 'guest',
        role: 'guest',
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    }
    return user;
  },

  async logout() {
    await McgheeLab.auth.signOut();
    window.location.hash = '#/';
  },

  isAdmin()    { return Auth.currentProfile?.role === 'admin'; },
  isGuest()    { return Auth.currentProfile?.role === 'guest'; },
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
      ${isRegister ? `
      <div class="auth-card">
        <h2>Create Your Account</h2>
        <p class="auth-subtitle">You have been invited to join McGhee Lab.</p>
        <form id="auth-form" class="auth-form">
          <input type="hidden" name="token" value="${escapeHTML(token)}">
          <div class="form-group">
            <label for="auth-name">Full Name</label>
            <input type="text" id="auth-name" name="name" required autocomplete="name">
          </div>
          <div class="form-group">
            <label for="auth-email">Email</label>
            <input type="email" id="auth-email" name="email" required autocomplete="email">
          </div>
          <div class="form-group">
            <label for="auth-password">Password</label>
            <input type="password" id="auth-password" name="password" required minlength="8"
              autocomplete="new-password">
          </div>
          <div id="auth-error" class="auth-error" hidden></div>
          <button type="submit" class="btn btn-primary">Create Account</button>
        </form>
      </div>
      ` : `
      <div class="auth-cards-row">
        <div class="auth-card">
          <h2>Lab Members</h2>
          <p class="auth-subtitle">Sign in with your lab credentials.</p>
          <form id="auth-form" class="auth-form">
            <div class="form-group">
              <label for="auth-email">Email</label>
              <input type="email" id="auth-email" name="email" required autocomplete="email">
            </div>
            <div class="form-group">
              <label for="auth-password">Password</label>
              <input type="password" id="auth-password" name="password" required minlength="8"
                autocomplete="current-password">
            </div>
            <div id="auth-error" class="auth-error" hidden></div>
            <button type="submit" class="btn btn-primary">Sign In</button>
          </form>
        </div>
        <div class="auth-card auth-card-guest">
          <h2>Guest Access</h2>
          <p class="auth-subtitle">Sign in to comment on research stories and react to posts.</p>
          <button type="button" class="btn btn-google" id="google-login-btn">
            <svg viewBox="0 0 24 24" class="google-icon">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Sign in with Google
          </button>
          <div id="google-error" class="auth-error" hidden></div>
        </div>
      </div>
      `}
    </div>`;
}

function wireLogin() {
  // Lab member email/password form
  const form = document.getElementById('auth-form');
  if (form) {
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
        let user;
        if (token) {
          user = await Auth.register(fd.get('email'), fd.get('password'), fd.get('name'), token);
        } else {
          user = await Auth.login(fd.get('email'), fd.get('password'));
        }
        // Ensure profile is loaded before redirecting so dashboard renders correctly
        if (!Auth.currentProfile && user) {
          try {
            Auth.currentProfile = await DB.getUser(user.uid);
            document.body.classList.add('logged-in');
            document.body.classList.toggle('is-admin', Auth.currentProfile?.role === 'admin');
            Auth.updateNavigation();
          } catch (e) { /* onAuthStateChanged will retry */ }
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

  // Guest Google sign-in
  const googleBtn = document.getElementById('google-login-btn');
  if (googleBtn) {
    googleBtn.addEventListener('click', async () => {
      const errEl = document.getElementById('google-error');
      errEl.hidden = true;
      googleBtn.disabled = true;
      googleBtn.textContent = 'Signing in\u2026';

      try {
        const user = await Auth.googleLogin();
        if (!Auth.currentProfile && user) {
          try {
            Auth.currentProfile = await DB.getUser(user.uid);
            document.body.classList.add('logged-in');
            Auth.updateNavigation();
          } catch (e) { /* onAuthStateChanged will retry */ }
        }
        // Guests go back to where they came from, or home
        const prev = sessionStorage.getItem('mcghee_login_redirect');
        sessionStorage.removeItem('mcghee_login_redirect');
        window.location.hash = prev || '#/research';
      } catch (err) {
        if (err.code !== 'auth/popup-closed-by-user') {
          errEl.textContent = err.message;
          errEl.hidden = false;
        }
        googleBtn.disabled = false;
        googleBtn.innerHTML = `
          <svg viewBox="0 0 24 24" class="google-icon">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
          </svg>
          Sign in with Google`;
      }
    });
  }
}

/* ================================================================
   RENDER: GUEST DASHBOARD (profile-only view for guest users)
   ================================================================ */
function renderGuestDashboard(p) {
  const needsProfile = !p.name || !p.photo;
  return `
    <div class="dashboard-page">
      <div class="dash-header">
        <h2>My Profile</h2>
        <button class="btn btn-secondary" id="dash-logout-btn">Sign Out</button>
      </div>

      ${needsProfile ? `
      <div class="profile-alert">
        <strong>Set up your profile!</strong>
        Add ${!p.photo ? 'a profile photo' : ''}${!p.photo && !p.name ? ' and ' : ''}${!p.name ? 'a display name' : ''} so people can see who you are when you comment.
      </div>` : ''}

      <div class="dashboard-grid">
        <div class="dash-card">
          <h3>Profile</h3>
          <form id="guest-profile-form" class="profile-form">
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
              <label for="guest-name">Display Name</label>
              <input type="text" id="guest-name" value="${escapeHTML(p.name || '')}" required placeholder="How others will see you">
            </div>
            <div class="form-group">
              <label for="guest-bio">About Me</label>
              <textarea id="guest-bio" rows="3" placeholder="A short description of yourself">${escapeHTML(p.bio || '')}</textarea>
            </div>
            <button type="submit" class="btn btn-primary">Save Profile</button>
            <div id="profile-status" class="form-status" hidden></div>
          </form>
        </div>
      </div>
    </div>`;
}

function wireGuestDashboard() {
  document.getElementById('dash-logout-btn')?.addEventListener('click', () => Auth.logout());

  // Photo upload with crop
  document.getElementById('profile-photo-input')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    const st = document.getElementById('profile-status');
    try {
      const cropped = await openCropModal(file);
      st.textContent = 'Uploading photo\u2026'; st.className = 'form-status'; st.hidden = false;
      const blobs = await processImage(cropped);
      const urls = await uploadImageSet(blobs, `users/${Auth.currentUser.uid}/photo`);
      await DB.updateUser(Auth.currentUser.uid, { photo: urls });
      Auth.currentProfile = await DB.getUser(Auth.currentUser.uid);
      document.getElementById('profile-photo-preview').innerHTML =
        `<img src="${escapeHTML(urls.medium)}" alt="Profile photo">`;
      st.textContent = 'Photo updated!'; st.className = 'form-status success';
    } catch (err) {
      if (err.message === 'Crop cancelled') return;
      st.textContent = 'Upload failed: ' + err.message; st.className = 'form-status error';
    }
  });

  // Save form
  const form = document.getElementById('guest-profile-form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const st = document.getElementById('profile-status');
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true; st.hidden = true;
      try {
        await DB.updateUser(Auth.currentUser.uid, {
          name: document.getElementById('guest-name').value.trim(),
          bio: document.getElementById('guest-bio').value.trim()
        });
        Auth.currentProfile = await DB.getUser(Auth.currentUser.uid);
        st.textContent = 'Profile saved!'; st.className = 'form-status success'; st.hidden = false;
      } catch (err) {
        st.textContent = 'Save failed: ' + err.message; st.className = 'form-status error'; st.hidden = false;
      }
      btn.disabled = false;
    });
  }
}

/* ================================================================
   RENDER: DASHBOARD
   ================================================================ */
function renderDashboard() {
  if (!Auth.currentUser) { window.location.hash = '#/login'; return '<p>Redirecting\u2026</p>'; }
  const p = Auth.currentProfile || {};

  /* ── Guest dashboard: profile only ─────────────────────────── */
  if (Auth.isGuest()) return renderGuestDashboard(p);

  const needsProfile = !p.bio || !p.photo;

  return `
    <div class="dashboard-page">
      <div class="dash-header">
        <h2>Dashboard</h2>
        <button class="btn btn-secondary" id="dash-logout-btn">Sign Out</button>
      </div>

      ${needsProfile ? `
      <div class="profile-alert">
        <strong>Complete your profile!</strong>
        Please add ${!p.photo ? 'a profile photo' : ''}${!p.photo && !p.bio ? ' and ' : ''}${!p.bio ? 'a bio' : ''} so your information appears correctly on the Team page.
      </div>` : ''}

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

        <!-- Associations Card -->
        <div class="dash-card">
          <h3>My Associations</h3>
          <p class="hint">Add your academic work. These appear as badges on your team card.</p>
          <div class="assoc-accordion">
          ${ASSOC_TYPES.map(t => {
            const items = p[t.key] || [];
            return `
            <details class="assoc-section" data-assoc="${t.key}">
              <summary class="assoc-header">
                <h4>${t.label} <span class="assoc-count">(${items.length})</span></h4>
              </summary>
              <div class="assoc-body">
                <div class="assoc-list">
                  ${items.map((item, i) => `
                    <div class="assoc-item" data-index="${i}">
                      <span>${item.url ? `<a href="${escapeHTML(item.url)}" target="_blank">${escapeHTML(item.title)}</a>` : escapeHTML(item.title)}</span>
                      <button type="button" class="assoc-remove-btn" data-index="${i}">&times;</button>
                    </div>
                  `).join('') || '<p class="hint assoc-empty">None added yet.</p>'}
                </div>
                <button type="button" class="btn btn-secondary btn-small assoc-add-btn" style="margin-top:.35rem">+ Add</button>
                <div class="assoc-form" hidden>
                  <input type="text" placeholder="${t.label.slice(0, -1)} title" class="assoc-title-input">
                  <input type="url" placeholder="URL (optional)" class="assoc-url-input">
                  <div class="assoc-form-actions">
                    <button type="button" class="btn btn-primary btn-small assoc-save-btn">Save</button>
                    <button type="button" class="btn btn-secondary btn-small assoc-cancel-btn">Cancel</button>
                  </div>
                </div>
              </div>
            </details>`;
          }).join('')}

          <details class="assoc-section">
            <summary class="assoc-header"><h4>CV ${p.cv ? '<span class="assoc-check">\u2713</span>' : ''}</h4></summary>
            <div class="assoc-body">
              ${p.cv ? `<div class="assoc-item"><a href="${escapeHTML(p.cv)}" target="_blank">View current CV</a></div>` : ''}
              <label class="btn btn-secondary btn-small upload-label" style="margin-top:.35rem">
                ${p.cv ? 'Replace' : 'Upload'} CV (PDF)
                <input type="file" id="cv-upload-input" accept=".pdf" hidden>
              </label>
              <div id="cv-upload-status" class="form-status" hidden></div>
            </div>
          </details>

          <details class="assoc-section">
            <summary class="assoc-header"><h4>GitHub ${p.github ? '<span class="assoc-check">\u2713</span>' : ''}</h4></summary>
            <div class="assoc-body">
              <div style="display:flex;gap:.5rem;align-items:center">
                <input type="url" id="github-url-input" placeholder="https://github.com/username" value="${escapeHTML(p.github || '')}" style="flex:1">
                <button type="button" class="btn btn-primary btn-small" id="save-github-btn">Save</button>
              </div>
            </div>
          </details>

          <details class="assoc-section">
            <summary class="assoc-header"><h4>LinkedIn ${p.linkedin ? '<span class="assoc-check">\u2713</span>' : ''}</h4></summary>
            <div class="assoc-body">
              <div style="display:flex;gap:.5rem;align-items:center">
                <input type="url" id="linkedin-url-input" placeholder="https://linkedin.com/in/username" value="${escapeHTML(p.linkedin || '')}" style="flex:1">
                <button type="button" class="btn btn-primary btn-small" id="save-linkedin-btn">Save</button>
              </div>
            </div>
          </details>

          <details class="assoc-section">
            <summary class="assoc-header"><h4>ResearchGate ${p.researchgate ? '<span class="assoc-check">\u2713</span>' : ''}</h4></summary>
            <div class="assoc-body">
              <div style="display:flex;gap:.5rem;align-items:center">
                <input type="url" id="researchgate-url-input" placeholder="https://researchgate.net/profile/username" value="${escapeHTML(p.researchgate || '')}" style="flex:1">
                <button type="button" class="btn btn-primary btn-small" id="save-researchgate-btn">Save</button>
              </div>
            </div>
          </details>

          <details class="assoc-section">
            <summary class="assoc-header"><h4>Google Scholar ${p.googleScholar ? '<span class="assoc-check">\u2713</span>' : ''}</h4></summary>
            <div class="assoc-body">
              <div style="display:flex;gap:.5rem;align-items:center">
                <input type="url" id="google-scholar-url-input" placeholder="https://scholar.google.com/citations?user=..." value="${escapeHTML(p.googleScholar || '')}" style="flex:1">
                <button type="button" class="btn btn-primary btn-small" id="save-google-scholar-btn">Save</button>
              </div>
            </div>
          </details>

          ${p.category === 'alumni' ? `
          <details class="assoc-section">
            <summary class="assoc-header">
              <h4>${p.priorCategory === 'grad' || p.priorCategory === 'postdoc' ? 'Thesis' : 'Final Project'} ${p.finalWork?.url ? '<span class="assoc-check">\u2713</span>' : ''}</h4>
            </summary>
            <div class="assoc-body">
              ${p.finalWork?.url ? `
                <div class="assoc-item">
                  <span><a href="${escapeHTML(p.finalWork.url)}" target="_blank">${escapeHTML(p.finalWork.title || 'View document')}</a></span>
                </div>` : ''}
              <input type="text" id="finalwork-title" placeholder="Title of your ${p.priorCategory === 'grad' || p.priorCategory === 'postdoc' ? 'thesis' : 'final project'}" value="${escapeHTML(p.finalWork?.title || '')}">
              <div style="display:flex;gap:.5rem;align-items:center;margin-top:.35rem">
                <label class="btn btn-secondary btn-small upload-label">
                  Upload PDF
                  <input type="file" id="finalwork-upload-input" accept=".pdf" hidden>
                </label>
                <button type="button" class="btn btn-primary btn-small" id="save-finalwork-btn">Save</button>
              </div>
              <div id="finalwork-status" class="form-status" hidden></div>
            </div>
          </details>` : ''}
          </div>

          <div id="assoc-status" class="form-status" hidden></div>
        </div>

        <!-- CV Builder Card -->
        <div class="dash-card">
          <h3>CV Builder</h3>
          <p class="hint">Build and manage your academic CV. Import from BibTeX, DOI, or ORCID. Export to PDF or LaTeX.</p>
          <a href="#/cv" class="btn btn-primary" style="margin-top:.5rem">Open CV Builder</a>
        </div>

        <!-- My Published Work Card -->
        <div class="dash-card">
          <h3>My Published Work</h3>
          <div id="published-list" class="stories-list">
            <p class="loading-text">Loading\u2026</p>
          </div>
        </div>

        <!-- Stories Card -->
        <div class="dash-card dash-card-full">
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

        <!-- News Posts Card -->
        <div class="dash-card dash-card-full">
          <div class="card-head">
            <h3>My News Posts</h3>
            <div class="card-head-actions">
              <a href="#/guide?tab=news" class="btn btn-secondary btn-small">How-to Guide</a>
              <button class="btn btn-primary btn-small" id="new-news-btn">+ New Post</button>
            </div>
          </div>
          <p class="hint">Share lab events, conference highlights, new papers, and more.</p>
          <div id="news-list" class="stories-list">
            <p class="loading-text">Loading news\u2026</p>
          </div>
        </div>

        <!-- Schedulers Card -->
        <div class="dash-card dash-card-full">
          <div class="card-head">
            <h3>My Schedulers</h3>
            <div class="card-head-actions">
              <a href="#/guide?tab=scheduler" class="btn btn-secondary btn-small">How-to Guide</a>
              <button class="btn btn-primary btn-small" id="new-scheduler-btn">+ New Scheduler</button>
            </div>
          </div>
          <p class="hint">Create scheduling tasks and invite participants via private link.</p>
          <div id="scheduler-create-form" hidden>
            <form id="scheduler-form" class="opp-form" style="margin:.75rem 0;">
              <div class="form-group">
                <label for="sched-title">Title</label>
                <input type="text" id="sched-new-title" required placeholder="e.g., Lab Meeting Schedule">
              </div>
              <div class="form-group">
                <label for="sched-desc">Description</label>
                <textarea id="sched-new-desc" rows="2" placeholder="Brief description (optional)"></textarea>
              </div>
              <div class="form-group">
                <label for="sched-new-mode">Mode</label>
                <select id="sched-new-mode">
                  <option value="sessions">Sessions — fixed time windows on specific days</option>
                  <option value="freeform">Freeform — guests paint their own availability</option>
                </select>
              </div>
              <div style="display:flex;gap:.5rem;">
                <button type="submit" class="btn btn-primary btn-small">Create</button>
                <button type="button" class="btn btn-secondary btn-small" id="cancel-scheduler-btn">Cancel</button>
              </div>
              <div id="scheduler-form-status" class="form-status" hidden></div>
            </form>
          </div>
          <div id="schedulers-list" class="stories-list">
            <p class="loading-text">Loading schedulers\u2026</p>
          </div>
        </div>

        ${Auth.canCreateProject() ? `
        <!-- Projects Card (admin only) -->
        <div class="dash-card dash-card-full">
          <div class="card-head">
            <h3>Project Packages</h3>
            <div class="card-head-actions">
              <button class="btn btn-secondary btn-small" id="reorder-projects-btn">Reorder</button>
              <button class="btn btn-primary btn-small" id="new-project-btn">+ New Project</button>
            </div>
          </div>
          <p class="hint">Create projects, then students publish research stories under them.</p>
          <div id="projects-list" class="stories-list">
            <p class="loading-text">Loading projects\u2026</p>
          </div>
        </div>` : ''}

      </div>
    </div>`;
}

async function wireDashboard() {
  if (!Auth.currentUser) return;

  /* Guest gets a simpler wiring path */
  if (Auth.isGuest()) { wireGuestDashboard(); return; }

  // Logout button
  document.getElementById('dash-logout-btn')?.addEventListener('click', () => Auth.logout());

  // New story button
  document.getElementById('new-story-btn')?.addEventListener('click', () => {
    window.location.hash = '#/dashboard/story/new';
  });

  // Load story list
  await refreshStoryList();

  // Load published work card
  await refreshPublishedList();

  // News posts section
  document.getElementById('new-news-btn')?.addEventListener('click', () => {
    window.location.hash = '#/dashboard/news/new';
  });
  await refreshNewsList();

  // Schedulers section
  document.getElementById('new-scheduler-btn')?.addEventListener('click', () => {
    const form = document.getElementById('scheduler-create-form');
    if (form) form.hidden = !form.hidden;
  });
  document.getElementById('cancel-scheduler-btn')?.addEventListener('click', () => {
    document.getElementById('scheduler-create-form').hidden = true;
  });
  document.getElementById('scheduler-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const st = document.getElementById('scheduler-form-status');
    st.hidden = true;
    const title = document.getElementById('sched-new-title').value.trim();
    if (!title) return;
    const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40)
      + '-' + Date.now().toString(36);
    try {
      const SDB = McgheeLab.ScheduleDB;
      if (!SDB) throw new Error('Scheduler module not loaded.');
      await SDB.saveSchedule({
        id,
        title,
        subtitle: '',
        semester: '',
        description: document.getElementById('sched-new-desc').value.trim(),
        mode: document.getElementById('sched-new-mode').value,
        sessionBlocks: [],
        selectedDays: [],
        startDate: '',
        endDate: '',
        sections: ['overview', 'speakers'],
        slotDefs: [],
        guestFields: [],
        startHour: 8,
        endHour: 18,
        granularity: 30,
        ownerUid: Auth.currentUser.uid
      });
      st.textContent = 'Scheduler created!';
      st.className = 'form-status success'; st.hidden = false;
      document.getElementById('scheduler-form').reset();
      document.getElementById('scheduler-create-form').hidden = true;
      setTimeout(() => { st.hidden = true; }, 3000);
      await refreshSchedulerList();
    } catch (err) {
      st.textContent = 'Error: ' + err.message;
      st.className = 'form-status error'; st.hidden = false;
    }
  });
  await refreshSchedulerList();

  // Project package section (admin only)
  if (Auth.canCreateProject()) {
    document.getElementById('new-project-btn')?.addEventListener('click', () => {
      window.location.hash = '#/dashboard/project/new';
    });

    // Reorder projects UI
    document.getElementById('reorder-projects-btn')?.addEventListener('click', async () => {
      const listEl = document.getElementById('projects-list');
      if (!listEl) return;
      let projects = [];
      try { projects = await DB.getPublishedProjects(); } catch (e) { return; }
      if (!projects.length) { alert('No published projects to reorder.'); return; }

      listEl.innerHTML = `
        <p class="hint">Use arrows to reorder. Click "Save Order" when done.</p>
        <div id="reorder-list"></div>
        <div style="margin-top:.75rem;display:flex;gap:.5rem">
          <button class="btn btn-primary btn-small" id="save-order-btn">Save Order</button>
          <button class="btn btn-secondary btn-small" id="cancel-order-btn">Cancel</button>
        </div>
      `;

      const reorderList = document.getElementById('reorder-list');
      function renderReorderList() {
        reorderList.innerHTML = projects.map((p, i) => `
          <div class="proj-story-row" data-idx="${i}">
            <span class="proj-story-num">${i + 1}</span>
            <span class="proj-story-title">${escapeHTML(p.title || 'Untitled')}</span>
            <div class="proj-story-controls">
              <button type="button" class="btn-icon" data-move="up" ${i === 0 ? 'disabled' : ''}>&uarr;</button>
              <button type="button" class="btn-icon" data-move="down" ${i === projects.length - 1 ? 'disabled' : ''}>&darr;</button>
            </div>
          </div>
        `).join('');
        reorderList.querySelectorAll('[data-move="up"]').forEach(btn => {
          btn.addEventListener('click', () => {
            const idx = Number(btn.closest('.proj-story-row').dataset.idx);
            if (idx > 0) { [projects[idx - 1], projects[idx]] = [projects[idx], projects[idx - 1]]; renderReorderList(); }
          });
        });
        reorderList.querySelectorAll('[data-move="down"]').forEach(btn => {
          btn.addEventListener('click', () => {
            const idx = Number(btn.closest('.proj-story-row').dataset.idx);
            if (idx < projects.length - 1) { [projects[idx], projects[idx + 1]] = [projects[idx + 1], projects[idx]]; renderReorderList(); }
          });
        });
      }
      renderReorderList();

      document.getElementById('save-order-btn').addEventListener('click', async () => {
        try {
          for (let i = 0; i < projects.length; i++) {
            await DB.updateProjectOrder(projects[i].id, i);
          }
          alert('Project order saved!');
          await refreshProjectList();
        } catch (err) { alert('Error saving order: ' + err.message); }
      });
      document.getElementById('cancel-order-btn').addEventListener('click', () => refreshProjectList());
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

  // Photo upload with crop
  document.getElementById('profile-photo-input')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    const st = document.getElementById('profile-status');
    try {
      const cropped = await openCropModal(file);
      st.textContent = 'Uploading photo\u2026'; st.className = 'form-status'; st.hidden = false;
      const blobs = await processImage(cropped);
      const urls = await uploadImageSet(blobs, `users/${Auth.currentUser.uid}/photo`);
      await DB.updateUser(Auth.currentUser.uid, { photo: urls });
      Auth.currentProfile = await DB.getUser(Auth.currentUser.uid);
      document.getElementById('profile-photo-preview').innerHTML =
        `<img src="${escapeHTML(urls.medium)}" alt="Profile photo">`;
      st.textContent = 'Photo updated!'; st.className = 'form-status success';
    } catch (err) {
      if (err.message === 'Crop cancelled') return;
      st.textContent = 'Upload failed: ' + err.message; st.className = 'form-status error';
    }
  });

  // Wire associations editor
  wireAssociations();
}

/* ── Associations Editor ──────────────────────────────────────── */
function wireAssociations() {
  // Exclusive accordion — only one section open at a time
  const accordion = document.querySelector('.assoc-accordion');
  if (accordion) {
    accordion.querySelectorAll('details.assoc-section').forEach(det => {
      det.addEventListener('toggle', () => {
        if (!det.open) return;
        accordion.querySelectorAll('details.assoc-section').forEach(other => {
          if (other !== det && other.open) other.open = false;
        });
      });
    });
  }

  // Wire each array-type association (papers, posters, presentations, patents, protocols)
  document.querySelectorAll('.assoc-section[data-assoc]').forEach(section => {
    const type = section.dataset.assoc;
    const addBtn = section.querySelector('.assoc-add-btn');
    const form = section.querySelector('.assoc-form');
    const saveBtn = section.querySelector('.assoc-save-btn');
    const cancelBtn = section.querySelector('.assoc-cancel-btn');

    addBtn?.addEventListener('click', () => { form.hidden = false; addBtn.hidden = true; });
    cancelBtn?.addEventListener('click', () => {
      form.hidden = true; addBtn.hidden = false;
      form.querySelector('.assoc-title-input').value = '';
      form.querySelector('.assoc-url-input').value = '';
    });

    saveBtn?.addEventListener('click', async () => {
      const title = form.querySelector('.assoc-title-input').value.trim();
      if (!title) { alert('Title is required'); return; }
      const url = form.querySelector('.assoc-url-input').value.trim();
      const items = [...(Auth.currentProfile[type] || []), { title, url: url || '' }];
      try {
        await DB.updateUser(Auth.currentUser.uid, { [type]: items });
        Auth.currentProfile = await DB.getUser(Auth.currentUser.uid);
        refreshAssocList(section, type);
        form.hidden = true; addBtn.hidden = false;
        form.querySelector('.assoc-title-input').value = '';
        form.querySelector('.assoc-url-input').value = '';
      } catch (e) { alert('Error saving: ' + e.message); }
    });

    wireAssocRemove(section, type);
  });

  // CV upload
  document.getElementById('cv-upload-input')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const st = document.getElementById('cv-upload-status');
    st.textContent = 'Uploading CV\u2026'; st.className = 'form-status'; st.hidden = false;
    try {
      const ref = McgheeLab.storage.ref().child(`users/${Auth.currentUser.uid}/cv/${file.name}`);
      await ref.put(file);
      const url = await ref.getDownloadURL();
      await DB.updateUser(Auth.currentUser.uid, { cv: url });
      Auth.currentProfile = await DB.getUser(Auth.currentUser.uid);
      st.textContent = 'CV uploaded!'; st.className = 'form-status success';
    } catch (e) {
      st.textContent = 'Upload failed: ' + e.message; st.className = 'form-status error';
    }
  });

  // GitHub save
  document.getElementById('save-github-btn')?.addEventListener('click', async () => {
    const url = document.getElementById('github-url-input').value.trim();
    try {
      await DB.updateUser(Auth.currentUser.uid, { github: url });
      Auth.currentProfile = await DB.getUser(Auth.currentUser.uid);
      const st = document.getElementById('assoc-status');
      st.textContent = 'GitHub saved!'; st.className = 'form-status success'; st.hidden = false;
      setTimeout(() => { st.hidden = true; }, 2000);
    } catch (e) { alert('Error: ' + e.message); }
  });

  // LinkedIn save
  document.getElementById('save-linkedin-btn')?.addEventListener('click', async () => {
    const url = document.getElementById('linkedin-url-input').value.trim();
    try {
      await DB.updateUser(Auth.currentUser.uid, { linkedin: url });
      Auth.currentProfile = await DB.getUser(Auth.currentUser.uid);
      const st = document.getElementById('assoc-status');
      st.textContent = 'LinkedIn saved!'; st.className = 'form-status success'; st.hidden = false;
      setTimeout(() => { st.hidden = true; }, 2000);
    } catch (e) { alert('Error: ' + e.message); }
  });

  // ResearchGate save
  document.getElementById('save-researchgate-btn')?.addEventListener('click', async () => {
    const url = document.getElementById('researchgate-url-input').value.trim();
    try {
      await DB.updateUser(Auth.currentUser.uid, { researchgate: url });
      Auth.currentProfile = await DB.getUser(Auth.currentUser.uid);
      const st = document.getElementById('assoc-status');
      st.textContent = 'ResearchGate saved!'; st.className = 'form-status success'; st.hidden = false;
      setTimeout(() => { st.hidden = true; }, 2000);
    } catch (e) { alert('Error: ' + e.message); }
  });

  // Google Scholar save
  document.getElementById('save-google-scholar-btn')?.addEventListener('click', async () => {
    const url = document.getElementById('google-scholar-url-input').value.trim();
    try {
      await DB.updateUser(Auth.currentUser.uid, { googleScholar: url });
      Auth.currentProfile = await DB.getUser(Auth.currentUser.uid);
      const st = document.getElementById('assoc-status');
      st.textContent = 'Google Scholar saved!'; st.className = 'form-status success'; st.hidden = false;
      setTimeout(() => { st.hidden = true; }, 2000);
    } catch (e) { alert('Error: ' + e.message); }
  });

  // Final Work (thesis / final project) — alumni only
  document.getElementById('finalwork-upload-input')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const st = document.getElementById('finalwork-status');
    st.textContent = 'Uploading\u2026'; st.className = 'form-status'; st.hidden = false;
    try {
      const ref = McgheeLab.storage.ref().child(`users/${Auth.currentUser.uid}/finalwork/${file.name}`);
      await ref.put(file);
      const url = await ref.getDownloadURL();
      const title = document.getElementById('finalwork-title').value.trim() || file.name;
      await DB.updateUser(Auth.currentUser.uid, { finalWork: { title, url } });
      Auth.currentProfile = await DB.getUser(Auth.currentUser.uid);
      st.textContent = 'Uploaded!'; st.className = 'form-status success';
    } catch (e) {
      st.textContent = 'Upload failed: ' + e.message; st.className = 'form-status error';
    }
  });

  document.getElementById('save-finalwork-btn')?.addEventListener('click', async () => {
    const title = document.getElementById('finalwork-title').value.trim();
    if (!title) { alert('Enter a title first.'); return; }
    const existing = Auth.currentProfile.finalWork || {};
    const st = document.getElementById('finalwork-status');
    try {
      await DB.updateUser(Auth.currentUser.uid, { finalWork: { title, url: existing.url || '' } });
      Auth.currentProfile = await DB.getUser(Auth.currentUser.uid);
      st.textContent = 'Saved!'; st.className = 'form-status success'; st.hidden = false;
      setTimeout(() => { st.hidden = true; }, 2000);
    } catch (e) {
      st.textContent = 'Error: ' + e.message; st.className = 'form-status error'; st.hidden = false;
    }
  });
}

function refreshAssocList(section, type) {
  const items = Auth.currentProfile[type] || [];
  const countEl = section.querySelector('.assoc-count');
  const listEl = section.querySelector('.assoc-list');
  if (countEl) countEl.textContent = `(${items.length})`;
  listEl.innerHTML = items.map((item, i) => `
    <div class="assoc-item" data-index="${i}">
      <span>${item.url ? `<a href="${escapeHTML(item.url)}" target="_blank">${escapeHTML(item.title)}</a>` : escapeHTML(item.title)}</span>
      <button type="button" class="assoc-remove-btn" data-index="${i}">&times;</button>
    </div>
  `).join('') || '<p class="hint assoc-empty">None added yet.</p>';
  wireAssocRemove(section, type);
}

function wireAssocRemove(section, type) {
  section.querySelectorAll('.assoc-remove-btn').forEach(btn => {
    if (btn._wired) return;
    btn._wired = true;
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.index);
      const items = [...(Auth.currentProfile[type] || [])];
      items.splice(idx, 1);
      try {
        await DB.updateUser(Auth.currentUser.uid, { [type]: items });
        Auth.currentProfile = await DB.getUser(Auth.currentUser.uid);
        refreshAssocList(section, type);
      } catch (e) { alert('Error removing: ' + e.message); }
    });
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

async function refreshPublishedList() {
  const el = document.getElementById('published-list');
  if (!el) return;

  try {
    const uid = Auth.currentUser.uid;
    const [stories, projects] = await Promise.all([
      DB.getStoriesByUser(uid),
      Auth.canCreateProject() ? DB.getProjectsByUser(uid) : Promise.resolve([])
    ]);

    const publishedStories = stories.filter(s => s.status === 'published');
    const publishedProjects = projects.filter(p => p.status === 'published');

    if (!publishedStories.length && !publishedProjects.length) {
      el.innerHTML = '<p class="empty-state">No published work yet.</p>';
      return;
    }

    let html = '';

    if (publishedProjects.length) {
      html += '<h4 class="published-section-label">Projects</h4>';
      html += publishedProjects.map(p => `
        <div class="story-item">
          <div class="story-item-info">
            <strong>${escapeHTML(p.title || 'Untitled Project')}</strong>
          </div>
          <div class="story-item-actions">
            <button class="btn btn-secondary btn-small" data-pub-edit-project="${p.id}">Edit</button>
            <button class="btn btn-danger btn-small" data-pub-delete-project="${p.id}">Delete</button>
          </div>
        </div>
      `).join('');
    }

    if (publishedStories.length) {
      html += '<h4 class="published-section-label">Stories</h4>';
      html += publishedStories.map(s => `
        <div class="story-item">
          <div class="story-item-info">
            <strong>${escapeHTML(s.title || 'Untitled')}</strong>
            <span class="hint">${escapeHTML(s.projectTitle || '')}</span>
          </div>
          <div class="story-item-actions">
            <button class="btn btn-secondary btn-small" data-pub-edit-story="${s.id}">Edit</button>
            <button class="btn btn-danger btn-small" data-pub-delete-story="${s.id}">Delete</button>
          </div>
        </div>
      `).join('');
    }

    el.innerHTML = html;

    el.querySelectorAll('[data-pub-edit-project]').forEach(btn => {
      btn.addEventListener('click', () => { window.location.hash = '#/dashboard/project/' + btn.dataset.pubEditProject; });
    });
    el.querySelectorAll('[data-pub-delete-project]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this published project? This cannot be undone.')) return;
        await DB.deleteProject(btn.dataset.pubDeleteProject);
        await refreshPublishedList();
        if (Auth.canCreateProject()) await refreshProjectList();
      });
    });
    el.querySelectorAll('[data-pub-edit-story]').forEach(btn => {
      btn.addEventListener('click', () => { window.location.hash = '#/dashboard/story/' + btn.dataset.pubEditStory; });
    });
    el.querySelectorAll('[data-pub-delete-story]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this published story? This cannot be undone.')) return;
        await DB.deleteStory(btn.dataset.pubDeleteStory);
        await refreshPublishedList();
        await refreshStoryList();
      });
    });
  } catch (err) {
    el.innerHTML = '<p class="error-text">Failed to load: ' + escapeHTML(err.message) + '</p>';
  }
}

async function refreshSchedulerList() {
  const el = document.getElementById('schedulers-list');
  if (!el) return;
  const SDB = McgheeLab.ScheduleDB;
  if (!SDB) { el.innerHTML = '<p class="empty-state">Scheduler module not loaded.</p>'; return; }
  try {
    const snap = await McgheeLab.db.collection('schedules')
      .where('ownerUid', '==', Auth.currentUser.uid).get();
    const schedules = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    schedules.sort((a, b) => (b.updatedAt?.toMillis?.() || 0) - (a.updatedAt?.toMillis?.() || 0));

    if (!schedules.length) {
      el.innerHTML = '<p class="empty-state">No schedulers created yet.</p>';
      return;
    }

    el.innerHTML = schedules.map(s => `
      <div class="story-item">
        <div class="story-item-info">
          <strong>${escapeHTML(s.title || 'Untitled')}</strong>
          <span class="hint">${escapeHTML(s.mode || 'sessions')}${s.sessionBlocks?.length ? ' &middot; ' + s.sessionBlocks.length + ' session(s)' : (s.startDate ? ' &middot; ' + escapeHTML(s.startDate) + (s.endDate ? ' \u2013 ' + escapeHTML(s.endDate) : '') : '')}</span>
        </div>
        <div class="story-item-actions">
          <a href="#/dashboard/scheduler/${encodeURIComponent(s.id)}" class="btn btn-secondary btn-small">Manage</a>
          <button class="btn btn-danger btn-small" data-delete-sched="${s.id}">Delete</button>
        </div>
      </div>
    `).join('');

    el.querySelectorAll('[data-delete-sched]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const sid = btn.dataset.deleteSched;
        if (!confirm('Delete this scheduler and all its participants?')) return;
        try {
          btn.disabled = true; btn.textContent = 'Deleting\u2026';
          const parts = await SDB.getSpeakers(sid);
          for (const p of parts) await SDB.deleteSpeaker(p.id);
          await McgheeLab.db.collection('schedules').doc(sid).delete();
          await refreshSchedulerList();
        } catch (err) { alert('Delete failed: ' + err.message); btn.disabled = false; btn.textContent = 'Delete'; }
      });
    });
  } catch (err) {
    el.innerHTML = '<p class="error-text">Failed to load schedulers.</p>';
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
        <button class="wizard-step" data-step="3"><span class="step-num">3</span> References</button>
        <button class="wizard-step" data-step="4"><span class="step-num">4</span> Review</button>
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
            <label>Cover Image</label>
            <div class="project-cover-upload">
              <div class="project-cover-preview" id="proj-cover-preview">
                <p class="upload-hint">Click or drag an image here</p>
              </div>
              <input type="file" id="proj-cover-input" accept="image/*" hidden>
            </div>
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
          <div class="form-group">
            <label for="proj-order">Display Order <span class="hint">(lower number = shown first)</span></label>
            <input type="number" id="proj-order" value="0" min="0">
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

        <!-- Step 3: References -->
        <div class="wizard-panel" data-panel="3">
          <h3>References</h3>
          <p class="hint">Link publications, patents, presentations, or posters to this project.</p>
          <div id="proj-refs-container" class="refs-container"></div>
          <button type="button" id="proj-add-ref-btn" class="btn btn-secondary">+ Add Reference</button>
        </div>

        <!-- Step 4: Review & Publish -->
        <div class="wizard-panel" data-panel="4">
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
  let coverImageUrls = null;
  let currentStep = 1;
  const totalSteps = 4;

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
      o.dataset.photo = JSON.stringify(u.photo || '');
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
    let parsedPhoto = '';
    try { parsedPhoto = JSON.parse(opt.dataset.photo || '""'); } catch { parsedPhoto = opt.dataset.photo || ''; }
    selectedContributors.push({
      uid: contribSelect.value,
      name: opt.dataset.name || opt.textContent,
      photo: parsedPhoto
    });
    renderChips();
    contribSelect.value = '';
  });

  // ── Cover image upload ──
  const coverPreview = document.getElementById('proj-cover-preview');
  const coverInput = document.getElementById('proj-cover-input');

  coverPreview.addEventListener('click', () => coverInput.click());
  coverPreview.addEventListener('dragover', e => { e.preventDefault(); coverPreview.style.borderColor = 'var(--accent)'; });
  coverPreview.addEventListener('dragleave', () => { coverPreview.style.borderColor = ''; });
  coverPreview.addEventListener('drop', e => {
    e.preventDefault();
    coverPreview.style.borderColor = '';
    const file = e.dataTransfer?.files?.[0];
    if (file && file.type.startsWith('image/')) handleCoverUpload(file);
  });
  coverInput.addEventListener('change', () => {
    if (coverInput.files[0]) handleCoverUpload(coverInput.files[0]);
  });

  async function handleCoverUpload(file) {
    coverPreview.innerHTML = '<p class="upload-hint">Uploading...</p>';
    try {
      const projectRef = existing?.id || 'draft_' + Date.now();
      const sizes = [
        { name: 'thumb', maxW: 300, quality: 0.7 },
        { name: 'medium', maxW: 800, quality: 0.8 },
        { name: 'full', maxW: 1600, quality: 0.9 }
      ];
      const urls = {};
      for (const sz of sizes) {
        const canvas = document.createElement('canvas');
        const img = await createImageBitmap(file);
        const scale = Math.min(1, sz.maxW / img.width);
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise(r => canvas.toBlob(r, 'image/webp', sz.quality));
        const ref = McgheeLab.storage.ref(`projects/${projectRef}/cover/${sz.name}.webp`);
        await ref.put(blob, { contentType: 'image/webp' });
        urls[sz.name] = await ref.getDownloadURL();
      }
      coverImageUrls = urls;
      coverPreview.innerHTML = `<img src="${escapeHTML(urls.medium)}" alt="Cover preview">`;
    } catch (err) {
      coverPreview.innerHTML = `<p class="error-text">Upload failed: ${escapeHTML(err.message)}</p>`;
    }
  }

  // ── Step 3: References ──
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
      document.getElementById('proj-order').value = existing.order ?? 0;
      if (existing.coverImage) {
        coverImageUrls = existing.coverImage;
        if (existing.coverImage.medium) {
          coverPreview.innerHTML = `<img src="${escapeHTML(existing.coverImage.medium)}" alt="Cover preview">`;
        }
      }
      if (existing.team?.mentor?.uid) mentorSelect.value = existing.team.mentor.uid;
      if (existing.team?.contributors) {
        existing.team.contributors.forEach(c => selectedContributors.push(c));
        renderChips();
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

  // ── Step 4: Review summary ──
  function buildReview() {
    const el = document.getElementById('proj-review-summary');
    const title = document.getElementById('proj-title').value || '(no title)';
    const desc = document.getElementById('proj-description').value || '(no description)';
    const outcomes = document.getElementById('proj-outcomes').value || '(none)';
    const link = document.getElementById('proj-link').value;
    const order = document.getElementById('proj-order').value;
    const mentorOpt = mentorSelect.options[mentorSelect.selectedIndex];
    const mentorName = mentorSelect.value ? (mentorOpt?.dataset?.name || mentorOpt?.textContent || '') : '(none)';
    const contribNames = selectedContributors.map(c => c.name || c.uid).join(', ') || '(none)';
    const refCount = refsContainer.querySelectorAll('.ref-block').length;

    el.innerHTML = `
      <div class="review-row"><strong>Title:</strong> ${escapeHTML(title)}</div>
      ${coverImageUrls ? '<div class="review-row"><strong>Cover Image:</strong> uploaded</div>' : '<div class="review-row"><strong>Cover Image:</strong> (none)</div>'}
      <div class="review-row"><strong>Description:</strong> ${escapeHTML(desc)}</div>
      <div class="review-row"><strong>Outcomes:</strong> ${escapeHTML(outcomes)}</div>
      ${link ? `<div class="review-row"><strong>External Link:</strong> <a href="${escapeHTML(link)}" target="_blank" rel="noopener">${escapeHTML(link)}</a></div>` : ''}
      <div class="review-row"><strong>Display Order:</strong> ${escapeHTML(order)}</div>
      <div class="review-row"><strong>Mentor:</strong> ${escapeHTML(mentorName)}</div>
      <div class="review-row"><strong>Contributors:</strong> ${escapeHTML(contribNames)}</div>
      <div class="review-row"><strong>References:</strong> ${refCount} entries</div>
      ${!outcomes.trim() ? '<p class="form-status error" style="margin-top:.75rem">Outcomes are required before publishing.</p>' : ''}
    `;
  }

  // ── Collect & Save ──
  function collectProjectData(status) {
    const mentorOpt = mentorSelect.options[mentorSelect.selectedIndex];
    let mentorPhoto = '';
    if (mentorSelect.value) {
      try { mentorPhoto = JSON.parse(mentorOpt?.dataset?.photo || '""'); } catch { mentorPhoto = mentorOpt?.dataset?.photo || ''; }
    }
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
        photo: mentorPhoto
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

    const result = {
      title: document.getElementById('proj-title').value,
      description: document.getElementById('proj-description').value,
      outcomes: document.getElementById('proj-outcomes').value,
      link: document.getElementById('proj-link').value.trim(),
      coverImage: coverImageUrls,
      order: parseInt(document.getElementById('proj-order').value) || 0,
      authorUid: Auth.currentUser.uid,
      authorName: Auth.currentProfile?.name || '',
      team,
      references,
      status
    };
    if (existing?.id) result.id = existing.id;
    return result;
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
      existing = { ...data, id };
      // Update URL without triggering a re-render so the page stays in place
      if (window.location.hash !== `#/dashboard/project/${id}`) {
        history.replaceState(null, '', `#/dashboard/project/${id}`);
      }
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
        <h2>How-to Guides</h2>
      </div>

      <div class="guide-tabs" id="guide-tabs">
        <button class="guide-tab guide-tab-active" data-guide-tab="stories">Stories</button>
        <button class="guide-tab" data-guide-tab="news">News Posts</button>
        <button class="guide-tab" data-guide-tab="scheduler">Scheduler</button>
      </div>

      <!-- ─── Stories Guide ─────────────────────────────────── -->
      <div class="guide-content guide-panel" id="guide-panel-stories">

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

      <!-- ─── News Posts Guide ──────────────────────────────── -->
      <div class="guide-content guide-panel" id="guide-panel-news" hidden>

        <div class="guide-section">
          <h3>What is a News Post?</h3>
          <p>News posts are short updates that appear on the <strong>News</strong> page. Use them to announce lab events, share conference highlights, celebrate a new paper, or give a glimpse of day-to-day lab life.</p>
          <p>Unlike research stories, news posts are timely — think announcements and highlights rather than deep technical write-ups.</p>
        </div>

        <div class="guide-section">
          <h3>Step 1: Start a New Post</h3>
          <p>From your <strong>Dashboard</strong>, find the <strong>My News Posts</strong> card and click <strong class="highlight">+ New Post</strong>.</p>
          <p>Fill in the top fields:</p>
          <ul>
            <li><strong>Title</strong> — A short, attention-grabbing headline</li>
            <li><strong>Category</strong> — Helps readers filter the news feed</li>
            <li><strong>Brief Description</strong> — A one-line summary shown in the feed card</li>
          </ul>
        </div>

        <div class="guide-section">
          <h3>Step 2: Choose a Category</h3>
          <p>Pick the category that best fits your post:</p>
          <table class="guide-table">
            <thead><tr><th>Category</th><th>Use for</th></tr></thead>
            <tbody>
              <tr><td><strong>Event</strong></td><td>Seminars, workshops, lab socials, outreach events</td></tr>
              <tr><td><strong>Conference</strong></td><td>Conference talks, poster presentations, travel highlights</td></tr>
              <tr><td><strong>Paper</strong></td><td>New publications, preprints, accepted manuscripts</td></tr>
              <tr><td><strong>Highlight</strong></td><td>Awards, grants, featured work, milestones</td></tr>
              <tr><td><strong>Lab Life</strong></td><td>Day-to-day moments, team photos, fun updates</td></tr>
              <tr><td><strong>Other</strong></td><td>Anything that doesn't fit the above</td></tr>
            </tbody>
          </table>
        </div>

        <div class="guide-section">
          <h3>Step 3: Add Sections</h3>
          <p>Just like stories, news posts are built from <strong>sections</strong>. Each section has a text area and an optional image or video upload.</p>
          <ul>
            <li>Click <strong class="highlight">+ Add Section</strong> to add more blocks</li>
            <li>Reorder with <strong>&uarr;</strong> <strong>&darr;</strong> arrows, remove with <strong>&times;</strong></li>
            <li>Images are auto-resized; videos accept MP4 or WebM up to 50 MB</li>
          </ul>
          <div class="guide-tip">
            <strong>Tip:</strong> News posts work best when they're concise — 1&ndash;3 sections is usually enough. Lead with the most important information.
          </div>
        </div>

        <div class="guide-section">
          <h3>Step 4: Preview &amp; Publish</h3>
          <p>Click <strong class="highlight">Preview</strong> to see how your post will look in the news feed. Then choose:</p>
          <ul>
            <li><strong>Save Draft</strong> — Save privately and come back later</li>
            <li><strong>Publish</strong> — Go live immediately (Editors and Admins)</li>
            <li><strong>Submit for Review</strong> — Send to an admin for approval (Contributors)</li>
          </ul>
        </div>

        <div class="guide-section">
          <h3>News Feed Features</h3>
          <p>Once published, your post appears in the news feed with:</p>
          <ul>
            <li><strong>Category badge</strong> — Color-coded label at the top of the card</li>
            <li><strong>Author info</strong> — Your name and photo from your profile</li>
            <li><strong>Reactions</strong> — Readers can react to your post</li>
            <li><strong>Comments</strong> — Readers can leave comments</li>
          </ul>
          <div class="guide-tip">
            <strong>Tip:</strong> A complete profile (name + photo) makes your posts look more professional in the feed. Update your profile from the Dashboard if you haven't already.
          </div>
        </div>

        <div class="guide-section guide-cta">
          <p>Ready to share some news?</p>
          <a href="#/dashboard/news/new" class="btn btn-primary">Create a News Post</a>
          <a href="#/dashboard" class="btn btn-secondary">Back to Dashboard</a>
        </div>

      </div>

      <!-- ─── Scheduler Guide ──────────────────────────────── -->
      <div class="guide-content guide-panel" id="guide-panel-scheduler" hidden>

        <div class="guide-section">
          <h3>What is a Scheduler?</h3>
          <p>The scheduler lets you coordinate meeting times with guests — visiting speakers, collaborators, or anyone you need to schedule. You set up available time slots, then share a private invite link so each guest can mark their availability.</p>
          <p>Think of it like a private Doodle or When2Meet built into the lab website.</p>
        </div>

        <div class="guide-section">
          <h3>Step 1: Create a Scheduler</h3>
          <p>From your <strong>Dashboard</strong>, find the <strong>My Schedulers</strong> card and click <strong class="highlight">+ New Scheduler</strong>.</p>
          <p>Fill in:</p>
          <ul>
            <li><strong>Title</strong> — e.g., "Lab Meeting Schedule" or "Dr. Smith Visit"</li>
            <li><strong>Description</strong> — Brief context (optional)</li>
            <li><strong>Mode</strong> — Choose how scheduling works (see below)</li>
          </ul>
        </div>

        <div class="guide-section">
          <h3>Step 2: Choose a Mode</h3>
          <p>There are two scheduling modes. Pick the one that fits your situation:</p>
          <table class="guide-table">
            <thead><tr><th>Mode</th><th>How it works</th><th>Best for</th></tr></thead>
            <tbody>
              <tr>
                <td><strong>Sessions</strong></td>
                <td>You define fixed time blocks (e.g., 1-hour sessions) on specific days. Guests choose which sessions they're available for.</td>
                <td>Seminar series, visitor schedules, structured meeting blocks</td>
              </tr>
              <tr>
                <td><strong>Freeform</strong></td>
                <td>You open a range of times. Guests paint their availability cell-by-cell, like When2Meet.</td>
                <td>Finding a common meeting time, flexible scheduling</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="guide-section">
          <h3>Step 3: Set Up the Schedule</h3>
          <p>After creating the scheduler, click <strong>Edit</strong> to open it. Expand <strong>Schedule Settings</strong> at the bottom to configure times.</p>
          <p>The builder has two panels side by side:</p>
          <ul>
            <li><strong>Left: Calendar</strong> — Click dates to select the days you want to schedule. Selected days appear highlighted. Click again to deselect.</li>
            <li><strong>Right: Time Grid</strong> — One column per selected day, with 15-minute rows from 7 AM to 9 PM.</li>
          </ul>

          <h4>Sessions mode</h4>
          <ol>
            <li>Choose a <strong>session duration</strong> from the dropdown (15 min to 2 hours)</li>
            <li>Click a cell in the time grid to <strong>place a block</strong> of that duration starting at that time</li>
            <li>Each block is colored differently so you can tell sessions apart</li>
            <li>Click an existing block to <strong>remove</strong> it</li>
          </ol>

          <h4>Freeform mode</h4>
          <ol>
            <li>Click and <strong>drag across cells</strong> to paint available times (green highlight)</li>
            <li>Drag over painted cells to <strong>erase</strong> them</li>
            <li>Select times independently for each day</li>
          </ol>

          <p>Click <strong>Save Settings</strong> when you're done.</p>
          <div class="guide-tip">
            <strong>Tip:</strong> You can come back and change the schedule setup anytime. Existing guest availability is preserved when you add or remove days.
          </div>
        </div>

        <div class="guide-section">
          <h3>Step 4: Configure Guest Fields (Optional)</h3>
          <p>Below the time grid in Schedule Settings, you'll find <strong>Guest Fields</strong> — optional information you can ask guests to provide:</p>
          <ul>
            <li><strong>Talk Summary</strong> — A text area for guests to describe their talk</li>
            <li><strong>Discussion Questions</strong> — Three question fields for pre-meeting discussion prep</li>
            <li><strong>Presentation Materials Link</strong> — A URL field for slides or documents</li>
          </ul>
          <p>All fields are <strong>off by default</strong>. Toggle on only what you need — if none are enabled, guests see a simple availability-only form.</p>
        </div>

        <div class="guide-section">
          <h3>Step 5: Add Guests &amp; Share Invite Links</h3>
          <p>In the main scheduler view, add guests by name and email. Each guest gets a unique <strong>private invite link</strong>.</p>
          <ol>
            <li>Enter the guest's name and email, then click <strong>Add Guest</strong></li>
            <li>Click <strong>Copy Link</strong> next to their name to get their personal invite URL</li>
            <li>Send the link via email — no login required, the link itself grants access</li>
          </ol>
          <div class="guide-tip">
            <strong>Tip:</strong> Each invite link is unique to that guest. Don't share one guest's link with another — add each person separately so their availability is tracked independently.
          </div>
        </div>

        <div class="guide-section">
          <h3>What Guests See</h3>
          <p>When a guest opens their invite link, they see:</p>
          <ul>
            <li>The schedule title and description</li>
            <li>An availability grid where they select their available times</li>
            <li>Any guest fields you've enabled (talk summary, questions, materials link)</li>
            <li>A <strong>Save</strong> button to submit their availability</li>
          </ul>
          <p>Guests can revisit their link anytime to update their selections.</p>
        </div>

        <div class="guide-section">
          <h3>Auto-Assign (Sessions Mode)</h3>
          <p>In sessions mode, once guests have submitted their availability, an <strong>Auto-Assign Slots</strong> button appears. This runs an optimizer that assigns each guest to a session based on availability — maximizing the number of guests who get a slot.</p>
          <p>You can also manually assign guests using the dropdown in the guest table.</p>
        </div>

        <div class="guide-section">
          <h3>Scheduler at a Glance</h3>
          <div class="guide-checklist">
            <label><input type="checkbox" disabled> Create scheduler and choose a mode</label>
            <label><input type="checkbox" disabled> Set up days and times in Schedule Settings</label>
            <label><input type="checkbox" disabled> Toggle on any guest fields you need</label>
            <label><input type="checkbox" disabled> Add guests and send their invite links</label>
            <label><input type="checkbox" disabled> Wait for guests to submit availability</label>
            <label><input type="checkbox" disabled> Assign slots (auto or manual) and confirm</label>
          </div>
        </div>

        <div class="guide-section guide-cta">
          <p>Ready to schedule?</p>
          <a href="#/dashboard" class="btn btn-primary">Go to Dashboard</a>
        </div>

      </div>

    </div>`;
}

function wireGuide() {
  const hash = window.location.hash || '';
  const q = hash.indexOf('?');
  const params = q !== -1 ? new URLSearchParams(hash.slice(q + 1)) : new URLSearchParams();
  const initialTab = params.get('tab') || 'stories';

  const tabs = document.querySelectorAll('[data-guide-tab]');
  const panels = document.querySelectorAll('.guide-panel');

  function activate(tabName) {
    tabs.forEach(t => t.classList.toggle('guide-tab-active', t.dataset.guideTab === tabName));
    panels.forEach(p => { p.hidden = p.id !== 'guide-panel-' + tabName; });
  }

  tabs.forEach(t => t.addEventListener('click', () => activate(t.dataset.guideTab)));
  activate(initialTab);
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
          <label for="story-project">Project <span class="hint">(required)</span></label>
          <select id="story-project" required>
            <option value="">-- Select a project --</option>
          </select>
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

  // Populate project dropdown from published Firestore projects
  const projectSelect = document.getElementById('story-project');
  let allProjects = [];
  try {
    allProjects = await DB.getPublishedProjects();
    allProjects.forEach(p => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.title || 'Untitled Project';
      o.dataset.title = p.title || '';
      projectSelect.appendChild(o);
    });
  } catch (e) { console.warn('Failed to load projects for dropdown:', e); }

  allUsers.forEach(u => {
    const opt = (sel) => {
      const o = document.createElement('option');
      o.value = u.id;
      o.textContent = u.name || u.email || u.id;
      o.dataset.name = u.name || '';
      o.dataset.photo = JSON.stringify(u.photo || '');
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
    let parsedPhoto = '';
    try { parsedPhoto = JSON.parse(opt.dataset.photo || '""'); } catch { parsedPhoto = opt.dataset.photo || ''; }
    selectedContributors.push({
      uid: sel.value,
      name: opt.dataset.name || opt.textContent,
      photo: parsedPhoto
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
      if (existing.projectId) projectSelect.value = existing.projectId;
      else if (existing.project) {
        // Legacy: try to match old free-text project to a Firestore project
        const match = allProjects.find(p => p.title === existing.project);
        if (match) projectSelect.value = match.id;
      }
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
    let mentorPhoto = '';
    if (mentorSelect.value) {
      try { mentorPhoto = JSON.parse(mentorOpt?.dataset?.photo || '""'); } catch { mentorPhoto = mentorOpt?.dataset?.photo || ''; }
    }
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
        photo: mentorPhoto
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

    const result = {
      title: document.getElementById('story-title').value,
      projectId: projectSelect.value,
      projectTitle: projectSelect.options[projectSelect.selectedIndex]?.dataset?.title || projectSelect.options[projectSelect.selectedIndex]?.textContent || '',
      description: document.getElementById('story-description').value,
      authorUid: Auth.currentUser.uid,
      authorName: Auth.currentProfile?.name || '',
      sections,
      team,
      references,
      status
    };
    if (existing?.id) result.id = existing.id;
    return result;
  }

  async function saveStory(status) {
    const st = document.getElementById('editor-status');
    st.hidden = true;
    try {
      const data = collectData(status);
      if (status === 'published') data.publishedAt = firebase.firestore.FieldValue.serverTimestamp();
      const id = await DB.saveStory(data);
      st.textContent = status === 'draft' ? 'Draft saved!'
        : (Auth.canPublish() ? 'Published!' : 'Submitted for review!');
      st.className = 'form-status success'; st.hidden = false;
      existing = { ...data, id };
      // Update URL without triggering a re-render so the page stays in place
      if (window.location.hash !== `#/dashboard/story/${id}`) {
        history.replaceState(null, '', `#/dashboard/story/${id}`);
      }
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
   RENDER: NEWS POST EDITOR
   ================================================================ */
const NEWS_CATEGORIES = [
  { value: 'event',      label: 'Event' },
  { value: 'conference', label: 'Conference' },
  { value: 'paper',      label: 'Paper' },
  { value: 'highlight',  label: 'Highlight' },
  { value: 'lab-life',   label: 'Lab Life' },
  { value: 'other',      label: 'Other' }
];

let _newsSectionCounter = 0;

function newsSectionBlockHTML(data) {
  const id = _newsSectionCounter++;
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
        <div class="media-upload-zone" data-zone="news-${id}">
          ${mediaPreview}
        </div>
        <input type="file" class="section-media-input" accept="image/*,video/mp4,video/webm" hidden data-zone="news-${id}">
        <input type="text" class="section-image-alt" placeholder="Image/video description (alt text)"
          value="${escapeHTML(data?.imageAlt || '')}">
        <div class="media-progress" hidden>Uploading\u2026</div>
      </div>
    </div>`;
}

function renderNewsEditor(postId) {
  if (!Auth.currentUser) { window.location.hash = '#/login'; return '<p>Redirecting\u2026</p>'; }
  const isNew = postId === 'new';

  return `
    <div class="story-editor-page">
      <div class="editor-header">
        <button class="btn btn-secondary" id="news-editor-back-btn">&larr; Back</button>
        <h2>${isNew ? 'New News Post' : 'Edit News Post'}</h2>
      </div>

      <form id="news-form" class="story-form">
        <div class="form-group">
          <label for="news-title">Title</label>
          <input type="text" id="news-title" required placeholder="Give your post a title">
        </div>
        <div class="form-group">
          <label for="news-category">Category</label>
          <select id="news-category">
            ${NEWS_CATEGORIES.map(c => `<option value="${c.value}">${c.label}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label for="news-description">Brief Description</label>
          <textarea id="news-description" rows="2" placeholder="One-line summary"></textarea>
        </div>

        <div class="form-group">
          <label>Cover Image</label>
          <p class="hint">Optional banner image shown on the news card.</p>
          <div class="media-upload-zone" id="news-cover-zone">
            <div id="news-cover-preview">Click or drag to upload a cover image</div>
          </div>
          <input type="file" accept="image/*" id="news-cover-input" hidden>
          <div class="media-progress" id="news-cover-progress" hidden></div>
        </div>

        <h3>Sections</h3>
        <p class="hint">Each section is a block of text with an optional image or video.</p>
        <div id="news-sections-container" class="sections-container"></div>
        <button type="button" id="news-add-section-btn" class="btn btn-secondary">+ Add Section</button>

        <div class="editor-actions">
          <button type="button" id="news-preview-btn" class="btn btn-secondary">Preview</button>
          <button type="button" id="news-save-draft-btn" class="btn btn-secondary">Save Draft</button>
          <button type="submit" class="btn btn-primary" id="news-publish-btn">
            ${Auth.canPublish() ? 'Publish' : 'Submit for Review'}
          </button>
        </div>
        <div id="news-editor-status" class="form-status" hidden></div>
      </form>

      <div id="news-preview-modal" class="modal" hidden>
        <div class="modal-content">
          <div class="modal-header">
            <h3>Post Preview</h3>
            <button type="button" class="btn btn-secondary btn-small" id="news-close-preview-btn">&times; Close</button>
          </div>
          <div id="news-preview-body" class="story-preview-body"></div>
        </div>
      </div>
    </div>`;
}

async function wireNewsEditor(postId) {
  if (!Auth.currentUser) return;

  const container = document.getElementById('news-sections-container');
  const form = document.getElementById('news-form');
  if (!container || !form) return;

  _newsSectionCounter = 0;
  let existing = null;
  const sectionImages = {};
  const sectionVideos = {};
  let coverImageUrls = null;

  // Back button
  document.getElementById('news-editor-back-btn')?.addEventListener('click', () => {
    window.location.hash = '#/dashboard';
  });

  // Load existing post
  if (postId !== 'new') {
    try {
      existing = await DB.getNewsPost(postId);
    } catch (e) { console.warn('Failed to load news post:', e); }
    if (existing) {
      document.getElementById('news-title').value = existing.title || '';
      document.getElementById('news-category').value = existing.category || 'other';
      document.getElementById('news-description').value = existing.description || '';

      (existing.sections || []).forEach((sec, i) => {
        container.insertAdjacentHTML('beforeend', newsSectionBlockHTML({
          text: sec.text,
          imageUrl: sec.image?.medium || sec.image?.full || '',
          videoUrl: sec.video || '',
          imageAlt: sec.imageAlt || ''
        }));
        if (sec.image) sectionImages[i] = sec.image;
        if (sec.video) sectionVideos[i] = sec.video;
      });

      if (existing.coverImage) {
        coverImageUrls = existing.coverImage;
        const preview = document.getElementById('news-cover-preview');
        if (preview && existing.coverImage.medium) {
          preview.innerHTML = `<img src="${escapeHTML(existing.coverImage.medium)}" alt="Cover preview">`;
        }
      }
    }
  }

  // Ensure at least one section
  if (!container.children.length) {
    container.insertAdjacentHTML('beforeend', newsSectionBlockHTML());
  }

  // Wire section blocks
  function wireSectionBlock(block) {
    const sid = block.dataset.sectionId;
    const zone = block.querySelector('.media-upload-zone');
    const fileInput = block.querySelector('.section-media-input');
    const progress = block.querySelector('.media-progress');

    zone?.addEventListener('click', () => fileInput?.click());
    zone?.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone?.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone?.addEventListener('drop', e => {
      e.preventDefault(); zone.classList.remove('drag-over');
      if (e.dataTransfer.files.length) handleMedia(e.dataTransfer.files[0], sid, zone, progress);
    });
    fileInput?.addEventListener('change', e => {
      if (e.target.files[0]) handleMedia(e.target.files[0], sid, zone, progress);
      e.target.value = '';
    });

    block.querySelector('[data-move="up"]')?.addEventListener('click', () => {
      const prev = block.previousElementSibling;
      if (prev) { container.insertBefore(block, prev); renumberSections(); }
    });
    block.querySelector('[data-move="down"]')?.addEventListener('click', () => {
      const next = block.nextElementSibling;
      if (next) { container.insertBefore(next, block); renumberSections(); }
    });
    block.querySelector('[data-remove]')?.addEventListener('click', () => {
      if (container.children.length <= 1) return;
      block.remove(); renumberSections();
    });
  }

  async function handleMedia(file, sid, zone, progress) {
    const isVideo = file.type.startsWith('video/');
    if (isVideo) {
      progress.textContent = 'Uploading video\u2026'; progress.hidden = false;
      try {
        const newsId = existing?.id || 'temp_' + Date.now();
        const ref = McgheeLab.storage.ref().child(`news/${newsId}/section_${sid}_video.${file.name.split('.').pop()}`);
        await ref.put(file);
        const url = await ref.getDownloadURL();
        sectionVideos[sid] = url;
        delete sectionImages[sid];
        zone.innerHTML = `<video src="${escapeHTML(url)}" controls playsinline preload="metadata" class="section-video-preview"></video>`;
        progress.hidden = true;
      } catch (err) {
        progress.textContent = 'Upload failed: ' + err.message; progress.hidden = false;
      }
    } else {
      progress.textContent = 'Processing image\u2026'; progress.hidden = false;
      try {
        const blobs = await processImage(file);
        const newsId = existing?.id || 'temp_' + Date.now();
        const urls = await uploadImageSet(blobs, `news/${newsId}/section_${sid}`);
        sectionImages[sid] = urls;
        delete sectionVideos[sid];
        zone.innerHTML = `<img src="${escapeHTML(urls.medium)}" alt="Section image" class="section-img-preview">`;
        progress.hidden = true;
      } catch (err) {
        progress.textContent = 'Upload failed: ' + err.message; progress.hidden = false;
      }
    }
  }

  function renumberSections() {
    container.querySelectorAll('.section-block').forEach((b, i) => {
      b.querySelector('.section-label').textContent = 'Section ' + (i + 1);
    });
  }

  container.querySelectorAll('.section-block').forEach(wireSectionBlock);

  // Cover image upload
  const coverZone = document.getElementById('news-cover-zone');
  const coverInput = document.getElementById('news-cover-input');
  const coverProgress = document.getElementById('news-cover-progress');
  const coverPreview = document.getElementById('news-cover-preview');

  coverZone?.addEventListener('click', () => coverInput?.click());
  coverZone?.addEventListener('dragover', e => { e.preventDefault(); coverZone.classList.add('drag-over'); });
  coverZone?.addEventListener('dragleave', () => coverZone.classList.remove('drag-over'));
  coverZone?.addEventListener('drop', e => {
    e.preventDefault(); coverZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length) handleCoverUpload(e.dataTransfer.files[0]);
  });
  coverInput?.addEventListener('change', e => {
    if (e.target.files[0]) handleCoverUpload(e.target.files[0]);
    e.target.value = '';
  });

  async function handleCoverUpload(file) {
    coverProgress.textContent = 'Processing image\u2026'; coverProgress.hidden = false;
    try {
      const blobs = await processImage(file);
      const newsId = existing?.id || 'temp_' + Date.now();
      const urls = await uploadImageSet(blobs, `news/${newsId}/cover`);
      coverImageUrls = urls;
      coverPreview.innerHTML = `<img src="${escapeHTML(urls.medium)}" alt="Cover preview">`;
      coverProgress.hidden = true;
    } catch (err) {
      coverProgress.textContent = 'Upload failed: ' + err.message; coverProgress.hidden = false;
    }
  }

  // Add section
  document.getElementById('news-add-section-btn').addEventListener('click', () => {
    container.insertAdjacentHTML('beforeend', newsSectionBlockHTML());
    wireSectionBlock(container.lastElementChild);
  });

  // Collect form data
  function collectData(status) {
    const sections = [];
    container.querySelectorAll('.section-block').forEach(block => {
      const sid = block.dataset.sectionId;
      sections.push({
        text: block.querySelector('.section-text').value.trim(),
        image: sectionImages[sid] || null,
        video: sectionVideos[sid] || null,
        imageAlt: block.querySelector('.section-image-alt').value.trim()
      });
    });

    return {
      id: existing?.id || undefined,
      title: document.getElementById('news-title').value.trim(),
      category: document.getElementById('news-category').value,
      description: document.getElementById('news-description').value.trim(),
      coverImage: coverImageUrls,
      sections,
      authorUid: Auth.currentUser.uid,
      authorName: Auth.currentProfile?.name || Auth.currentUser.email,
      authorPhoto: Auth.currentProfile?.photo || null,
      status
    };
  }

  async function savePost(status) {
    const st = document.getElementById('news-editor-status');
    st.hidden = true;
    try {
      const data = collectData(status);
      if (status === 'published') data.publishedAt = firebase.firestore.FieldValue.serverTimestamp();
      const id = await DB.saveNewsPost(data);
      st.textContent = status === 'draft' ? 'Draft saved!'
        : (Auth.canPublish() ? 'Published!' : 'Submitted for review!');
      st.className = 'form-status success'; st.hidden = false;
      existing = { ...data, id };
      if (window.location.hash !== `#/dashboard/news/${id}`) {
        history.replaceState(null, '', `#/dashboard/news/${id}`);
      }
    } catch (err) {
      st.textContent = 'Error: ' + err.message;
      st.className = 'form-status error'; st.hidden = false;
    }
  }

  // Save draft
  document.getElementById('news-save-draft-btn').addEventListener('click', () => savePost('draft'));

  // Publish / submit
  form.addEventListener('submit', e => {
    e.preventDefault();
    savePost(Auth.canPublish() ? 'published' : 'pending');
  });

  // Preview
  document.getElementById('news-preview-btn').addEventListener('click', () => {
    const data = collectData('preview');
    const body = document.getElementById('news-preview-body');
    body.innerHTML = `
      <h3>${escapeHTML(data.title)}</h3>
      <span class="badge">${escapeHTML(NEWS_CATEGORIES.find(c => c.value === data.category)?.label || data.category)}</span>
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
          ${sec.text ? `<p>${escapeHTML(sec.text)}</p>` : ''}
          ${mediaHTML}
        </div>`;
      }).join('')}`;
    document.getElementById('news-preview-modal').hidden = false;
  });

  // Close preview
  document.getElementById('news-close-preview-btn')?.addEventListener('click', () => {
    document.getElementById('news-preview-modal').hidden = true;
  });
}

/* ── News list helpers for dashboard ── */
async function refreshNewsList() {
  const el = document.getElementById('news-list');
  if (!el) return;

  try {
    const posts = await DB.getNewsByUser(Auth.currentUser.uid);
    if (!posts.length) {
      el.innerHTML = '<p class="empty-state">No news posts yet. Share what\'s happening in the lab!</p>';
      return;
    }
    el.innerHTML = posts.map(p => `
      <div class="story-item">
        <div class="story-item-info">
          <strong>${escapeHTML(p.title || 'Untitled')}</strong>
          <span class="badge news-cat-badge">${escapeHTML(NEWS_CATEGORIES.find(c => c.value === p.category)?.label || p.category || '')}</span>
          <span class="status-badge status-${p.status || 'draft'}">${p.status || 'draft'}</span>
        </div>
        <div class="story-item-actions">
          <button class="btn btn-secondary btn-small" data-edit-news="${p.id}">Edit</button>
          <button class="btn btn-danger btn-small" data-delete-news="${p.id}">Delete</button>
        </div>
      </div>
    `).join('');

    el.querySelectorAll('[data-edit-news]').forEach(btn => {
      btn.addEventListener('click', () => { window.location.hash = '#/dashboard/news/' + btn.dataset.editNews; });
    });
    el.querySelectorAll('[data-delete-news]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this news post? This cannot be undone.')) return;
        await DB.deleteNewsPost(btn.dataset.deleteNews);
        await refreshNewsList();
      });
    });
  } catch (err) {
    el.innerHTML = '<p class="error-text">Failed to load news: ' + escapeHTML(err.message) + '</p>';
  }
}

/* ================================================================
   RENDER: SCHEDULER EDITOR (dashboard — owner/admin view)
   ================================================================ */
function renderSchedulerEditor(scheduleId) {
  if (!Auth.currentUser) { window.location.hash = '#/login'; return '<p>Redirecting\u2026</p>'; }
  return `
    <div class="class-page max-w" data-schedule-id="${escapeHTML(scheduleId)}">
      <div class="section card reveal">
        <div class="class-header">
          <a href="#/dashboard" class="class-back-link">&larr; Dashboard</a>
          <h2 id="sched-editor-title">Scheduler</h2>
          <p class="class-subtitle" id="sched-editor-subtitle"></p>
        </div>
      </div>
      <div id="scheduler-editor-content"><p class="muted-text" style="padding:2rem;text-align:center;">Loading\u2026</p></div>
    </div>`;
}

async function wireSchedulerEditor(scheduleId) {
  const SDB = McgheeLab.ScheduleDB;
  const Sched = McgheeLab.Scheduler;
  if (!SDB || !Sched) return;

  let schedule = await SDB.getSchedule(scheduleId);
  if (!schedule) {
    const c = document.getElementById('scheduler-editor-content');
    if (c) c.innerHTML = '<p class="muted-text">Scheduler not found.</p>';
    return;
  }

  // Verify ownership
  if (schedule.ownerUid !== Auth.currentUser.uid && Auth.currentProfile?.role !== 'admin') {
    const c = document.getElementById('scheduler-editor-content');
    if (c) c.innerHTML = '<p class="muted-text">Access denied.</p>';
    return;
  }

  // Update header
  const titleEl = document.getElementById('sched-editor-title');
  const subtitleEl = document.getElementById('sched-editor-subtitle');
  if (titleEl) titleEl.textContent = schedule.title || 'Scheduler';
  if (subtitleEl) subtitleEl.textContent = schedule.description || '';

  let speakers = [];
  try { speakers = await SDB.getSpeakers(scheduleId); } catch (e) {}

  const container = document.getElementById('scheduler-editor-content');
  if (!container) return;

  // Build config for admin view
  let _adminViewMode = 'admin';
  let _previewSpeakerIdx = 0;

  function buildConfig() {
    return {
      scheduleId,
      schedule,
      speakers,
      currentSpeaker: null,
      viewType: 'admin',
      useKeyAuth: false,
      adminViewMode: _adminViewMode,
      previewSpeakerIdx: _previewSpeakerIdx,
      buildInviteURL: (sid, key) => `${location.origin}${location.pathname}#/schedule/${sid}?key=${key}`,
      onSaveSpeaker: async (id, data) => { await SDB.updateSpeaker(id, data); },
      onSaveSchedule: async (data) => { await SDB.saveSchedule(data); },
      onAddSpeaker: async (data) => { await SDB.addSpeaker(data); },
      onDeleteSpeaker: async (id) => { await SDB.deleteSpeaker(id); },
      onRefresh: async () => {
        schedule = await SDB.getSchedule(scheduleId);
        speakers = await SDB.getSpeakers(scheduleId);
        container.innerHTML = Sched.render(buildConfig());
        Sched.wire('scheduler-editor-content', buildConfig());
      },
      onSwitchView: (mode, idx) => {
        _adminViewMode = mode;
        _previewSpeakerIdx = idx || 0;
        container.innerHTML = Sched.render(buildConfig());
        Sched.wire('scheduler-editor-content', buildConfig());
      }
    };
  }

  container.innerHTML = Sched.render(buildConfig());
  Sched.wire('scheduler-editor-content', buildConfig());
}

/* ================================================================
   RENDER: SCHEDULE PAGE (private — key-only speaker access)
   ================================================================ */
function renderSchedulePage(scheduleId) {
  return `
    <div class="class-page max-w" data-schedule-id="${escapeHTML(scheduleId)}">
      <div class="section card reveal">
        <div class="class-header">
          <h2 id="sched-page-title">Schedule</h2>
          <p class="class-subtitle" id="sched-page-subtitle"></p>
        </div>
      </div>
      <div id="schedule-page-content"><p class="muted-text" style="padding:2rem;text-align:center;">Loading\u2026</p></div>
    </div>`;
}

async function wireSchedulePage(scheduleId) {
  const SDB = McgheeLab.ScheduleDB;
  const Sched = McgheeLab.Scheduler;
  if (!SDB || !Sched) return;

  const hash = window.location.hash || '';
  const q = hash.indexOf('?');
  const inviteKey = q !== -1 ? new URLSearchParams(hash.slice(q + 1)).get('key') : null;

  const container = document.getElementById('schedule-page-content');
  if (!container) return;

  if (!inviteKey) {
    container.innerHTML = '<p class="muted-text">This schedule requires an invite link to access.</p>';
    return;
  }

  let schedule = await SDB.getSchedule(scheduleId);
  if (!schedule) {
    container.innerHTML = '<p class="muted-text">Schedule not found.</p>';
    return;
  }

  // Update header
  const titleEl = document.getElementById('sched-page-title');
  const subtitleEl = document.getElementById('sched-page-subtitle');
  if (titleEl) titleEl.textContent = schedule.title || 'Schedule';
  if (subtitleEl) subtitleEl.textContent = schedule.description || '';

  let speakers = [];
  try { speakers = await SDB.getSpeakers(scheduleId); } catch (e) {}

  let currentSpeaker = speakers.find(s => s.id === inviteKey || s.key === inviteKey);
  if (!currentSpeaker) {
    try { currentSpeaker = await SDB.getSpeakerByKey(inviteKey); } catch (e) {}
  }

  if (!currentSpeaker) {
    container.innerHTML = '<p class="muted-text">Invalid or expired invite key.</p>';
    return;
  }

  function buildConfig() {
    return {
      scheduleId,
      schedule,
      speakers,
      currentSpeaker,
      viewType: 'guest',
      useKeyAuth: true,
      adminViewMode: 'guest',
      previewSpeakerIdx: 0,
      buildInviteURL: (sid, key) => `${location.origin}${location.pathname}#/schedule/${sid}?key=${key}`,
      onSaveSpeaker: async (id, data) => { await SDB.updateSpeakerByKey(id, data); },
      onSaveSchedule: async () => {},
      onAddSpeaker: async () => {},
      onDeleteSpeaker: async () => {},
      onRefresh: async () => {
        schedule = await SDB.getSchedule(scheduleId);
        speakers = await SDB.getSpeakers(scheduleId);
        currentSpeaker = speakers.find(s => s.id === inviteKey || s.key === inviteKey);
        container.innerHTML = Sched.render(buildConfig());
        Sched.wire('schedule-page-content', buildConfig());
      },
      onSwitchView: () => {}
    };
  }

  container.innerHTML = Sched.render(buildConfig());
  Sched.wire('schedule-page-content', buildConfig());
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
        <button class="tab-btn" data-tab="news">Pending News</button>
        <button class="tab-btn" data-tab="opportunities">Opportunities</button>
        <button class="tab-btn" data-tab="classes">Classes</button>
      </div>

      <!-- Users -->
      <div id="tab-users" class="tab-content active">
        <div class="inv-form-section">
          <h3>Add User Manually</h3>
          <p class="hint">Create a team member profile without requiring them to register first.</p>
          <form id="add-user-form" class="inline-form">
            <input type="text" id="add-user-name" placeholder="Full name" required>
            <input type="email" id="add-user-email" placeholder="Email (optional)">
            <select id="add-user-category">${categoryOptions('undergrad')}</select>
            <button type="submit" class="btn btn-primary">Add User</button>
          </form>
          <div id="add-user-status" class="form-status" hidden></div>
        </div>
        <h3>All Users</h3>
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

      <!-- Pending News -->
      <div id="tab-news" class="tab-content">
        <div id="pending-news-list" class="admin-list"><p class="loading-text">Loading\u2026</p></div>
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

      <!-- Classes -->
      <div id="tab-classes" class="tab-content">
        <div class="inv-form-section">
          <h3>Add Course Listing</h3>
          <form id="course-listing-form" class="opp-form">
            <div class="form-group">
              <label for="cl-title">Title</label>
              <input type="text" id="cl-title" required placeholder="e.g., BME 295C">
            </div>
            <div class="form-group">
              <label for="cl-description">Description</label>
              <textarea id="cl-description" rows="2" placeholder="Brief course description"></textarea>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
              <div class="form-group">
                <label for="cl-level">Level</label>
                <input type="text" id="cl-level" placeholder="e.g., Graduate">
              </div>
              <div class="form-group">
                <label for="cl-when">When</label>
                <input type="text" id="cl-when" placeholder="e.g., Summer 2026">
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
              <div class="form-group">
                <label for="cl-start-date">Start Date</label>
                <input type="date" id="cl-start-date">
              </div>
              <div class="form-group">
                <label for="cl-end-date">End Date</label>
                <input type="date" id="cl-end-date">
              </div>
            </div>
            <div class="form-group">
              <label>Days of Week</label>
              <div id="cl-days" style="display:flex;gap:6px;flex-wrap:wrap;">
                <label class="settings-check"><input type="checkbox" value="0"> Sun</label>
                <label class="settings-check"><input type="checkbox" value="1" checked> Mon</label>
                <label class="settings-check"><input type="checkbox" value="2"> Tue</label>
                <label class="settings-check"><input type="checkbox" value="3" checked> Wed</label>
                <label class="settings-check"><input type="checkbox" value="4"> Thu</label>
                <label class="settings-check"><input type="checkbox" value="5" checked> Fri</label>
                <label class="settings-check"><input type="checkbox" value="6"> Sat</label>
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
              <div class="form-group">
                <label for="cl-start-time">Start Time</label>
                <input type="time" id="cl-start-time" value="09:00">
              </div>
              <div class="form-group">
                <label for="cl-end-time">End Time</label>
                <input type="time" id="cl-end-time" value="10:30">
              </div>
              <div class="form-group">
                <label for="cl-frequency">Frequency</label>
                <select id="cl-frequency">
                  <option value="weekly">Weekly</option>
                  <option value="biweekly">Biweekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="once">One-time</option>
                </select>
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
              <div class="form-group">
                <label for="cl-reg-link">Registration Link</label>
                <input type="url" id="cl-reg-link" placeholder="https://... (optional)">
              </div>
              <div class="form-group">
                <label for="cl-order">Display Order</label>
                <input type="number" id="cl-order" value="0" min="0">
              </div>
              <div class="form-group">
                <label for="cl-status">Status</label>
                <select id="cl-status">
                  <option value="published">Published</option>
                  <option value="draft">Draft</option>
                </select>
              </div>
            </div>
            <button type="submit" class="btn btn-primary">Add Course</button>
            <div id="cl-form-status" class="form-status" hidden></div>
          </form>
        </div>
        <h3>Courses</h3>
        <div id="course-listings-list" class="admin-list"><p class="loading-text">Loading\u2026</p></div>
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
  loadPendingNews();

  // Add user manually
  document.getElementById('add-user-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const st = document.getElementById('add-user-status');
    const name = document.getElementById('add-user-name').value.trim();
    const email = document.getElementById('add-user-email').value.trim();
    const category = document.getElementById('add-user-category').value;
    const role = CATEGORY_DEFAULT_ROLE[category] || 'contributor';
    if (!name) { alert('Name is required.'); return; }
    try {
      await McgheeLab.db.collection('users').doc().set({
        name, email: email || '', category, role, bio: '',
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      st.textContent = `User "${name}" added!`;
      st.className = 'form-status success'; st.hidden = false;
      document.getElementById('add-user-form').reset();
      setTimeout(() => { st.hidden = true; }, 3000);
      loadUsers();
    } catch (err) {
      st.textContent = 'Error: ' + err.message;
      st.className = 'form-status error'; st.hidden = false;
    }
  });

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

  // Course listings management
  loadCourseListings();

  document.getElementById('course-listing-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const st = document.getElementById('cl-form-status');
    st.hidden = true;
    const title = document.getElementById('cl-title').value.trim();
    if (!title) return;

    // Generate a URL-safe schedule ID from the title
    const scheduleId = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40);
    if (!scheduleId) { st.textContent = 'Title is required.'; st.className = 'form-status error'; st.hidden = false; return; }

    try {
      // Check for duplicate schedule ID
      const SDB = McgheeLab.ScheduleDB;
      if (SDB) {
        const existing = await SDB.getSchedule(scheduleId);
        if (existing) { st.textContent = `A course with URL "${scheduleId}" already exists.`; st.className = 'form-status error'; st.hidden = false; return; }
      }

      const description = document.getElementById('cl-description').value.trim();
      const when = document.getElementById('cl-when').value.trim();

      // Gather schedule dates
      const daysOfWeek = [...document.querySelectorAll('#cl-days input:checked')].map(cb => parseInt(cb.value));
      const classDates = {
        startDate: document.getElementById('cl-start-date').value || '',
        endDate: document.getElementById('cl-end-date').value || '',
        daysOfWeek,
        startTime: document.getElementById('cl-start-time').value || '09:00',
        endTime: document.getElementById('cl-end-time').value || '10:30',
        frequency: document.getElementById('cl-frequency').value || 'weekly'
      };

      // 1) Create the course listing (public classes page)
      await DB.saveClass({
        title,
        description,
        level: document.getElementById('cl-level').value.trim(),
        when,
        detailPage: scheduleId,
        classDates,
        registrationLink: document.getElementById('cl-reg-link').value.trim(),
        order: parseInt(document.getElementById('cl-order').value) || 0,
        status: document.getElementById('cl-status').value
      });

      // 2) Create the schedule / course builder page
      if (SDB) {
        await SDB.saveSchedule({
          id: scheduleId,
          title,
          subtitle: '',
          semester: when,
          description,
          level: document.getElementById('cl-level').value.trim(),
          classDates,
          registrationLink: document.getElementById('cl-reg-link').value.trim(),
          sections: ['overview'],
          ownerUid: Auth.currentUser.uid
        });
      }

      st.textContent = 'Course created!';
      st.className = 'form-status success'; st.hidden = false;
      document.getElementById('course-listing-form').reset();
      setTimeout(() => { st.hidden = true; }, 3000);
      loadCourseListings();
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
          ${users.map(u => {
            const guest = u.role === 'guest';
            return `
            <tr class="${guest ? 'admin-guest-row' : ''}">
              <td>${escapeHTML(u.name || '\u2014')}${guest ? ' <span class="admin-guest-badge">Guest</span>' : ''}</td>
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
                <button class="btn btn-secondary btn-small" data-edit-user="${u.id}">Edit</button>
                <button class="btn btn-secondary btn-small" data-save-user="${u.id}">Save</button>
                <button class="btn btn-danger btn-small" data-delete-user="${u.id}">Delete</button>
              </td>
            </tr>
            <tr class="admin-edit-row" data-edit-row="${u.id}" hidden>
              <td colspan="5">
                <div class="admin-edit-panel" data-panel-uid="${u.id}">
                  <div class="admin-edit-section">
                    <label>Photo</label>
                    <div class="admin-photo-row">
                      <div class="admin-photo-preview">${u.photo?.medium ? `<img src="${escapeHTML(u.photo.medium)}" alt="Photo">` : '<span class="hint">No photo</span>'}</div>
                      <label class="btn btn-secondary btn-small upload-label">
                        Upload Photo
                        <input type="file" class="admin-photo-input" data-photo-uid="${u.id}" accept="image/*" hidden>
                      </label>
                    </div>
                  </div>
                  <div class="admin-edit-section">
                    <label>Name</label>
                    <input type="text" data-name-uid="${u.id}" value="${escapeHTML(u.name || '')}">
                  </div>
                  <div class="admin-edit-section">
                    <label>Bio</label>
                    <textarea data-bio-uid="${u.id}" rows="${guest ? 2 : 4}">${escapeHTML(u.bio || '')}</textarea>
                  </div>
                  ${guest ? '' : ASSOC_TYPES.map(t => {
                    const items = u[t.key] || [];
                    return `
                    <div class="admin-edit-section admin-assoc" data-admin-assoc="${t.key}" data-assoc-uid="${u.id}">
                      <label>${t.label} (${items.length})</label>
                      <div class="assoc-list">${items.map((item, i) => `
                        <div class="assoc-item" data-index="${i}">
                          <span>${item.url ? `<a href="${escapeHTML(item.url)}" target="_blank">${escapeHTML(item.title)}</a>` : escapeHTML(item.title)}</span>
                          <button type="button" class="assoc-remove-btn" data-index="${i}">&times;</button>
                        </div>`).join('') || '<p class="hint assoc-empty">None</p>'}
                      </div>
                      <div class="admin-assoc-add">
                        <input type="text" placeholder="Title" class="admin-assoc-title">
                        <input type="url" placeholder="URL (optional)" class="admin-assoc-url">
                        <button type="button" class="btn btn-secondary btn-small admin-assoc-add-btn">+ Add</button>
                      </div>
                    </div>`;
                  }).join('')}
                  ${guest ? '' : `<div class="admin-edit-section">
                    <label>CV ${u.cv ? '(\u2713)' : ''}</label>
                    ${u.cv ? `<div class="assoc-item"><a href="${escapeHTML(u.cv)}" target="_blank">View current CV</a></div>` : ''}
                    <label class="btn btn-secondary btn-small upload-label">
                      ${u.cv ? 'Replace' : 'Upload'} CV (PDF)
                      <input type="file" class="admin-cv-input" data-cv-uid="${u.id}" accept=".pdf" hidden>
                    </label>
                  </div>
                  <div class="admin-edit-section">
                    <label>GitHub</label>
                    <input type="url" data-github-uid="${u.id}" placeholder="https://github.com/username" value="${escapeHTML(u.github || '')}">
                  </div>`}
                  <div class="admin-edit-status form-status" hidden></div>
                </div>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;

    // Edit button — toggle edit row
    el.querySelectorAll('[data-edit-user]').forEach(btn => {
      btn.addEventListener('click', () => {
        const uid = btn.dataset.editUser;
        const row = el.querySelector(`[data-edit-row="${uid}"]`);
        if (row) {
          row.hidden = !row.hidden;
          btn.textContent = row.hidden ? 'Edit' : 'Close';
        }
      });
    });

    // Save button — saves role, category, name, bio, github from edit panel
    el.querySelectorAll('[data-save-user]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const uid = btn.dataset.saveUser;
        const roleSel = el.querySelector(`select[data-uid="${uid}"]`);
        const catSel = el.querySelector(`select[data-cat-uid="${uid}"]`);
        const bioEl = el.querySelector(`textarea[data-bio-uid="${uid}"]`);
        const nameEl = el.querySelector(`input[data-name-uid="${uid}"]`);
        const githubEl = el.querySelector(`input[data-github-uid="${uid}"]`);
        const updates = { role: roleSel.value, category: catSel.value };
        if (bioEl) updates.bio = bioEl.value;
        if (nameEl) updates.name = nameEl.value;
        if (githubEl) updates.github = githubEl.value;
        // Store prior category when moving to alumni
        const user = users.find(u => u.id === uid);
        if (catSel.value === 'alumni' && user && user.category !== 'alumni') {
          updates.priorCategory = user.category;
        }
        await DB.updateUser(uid, updates);
        btn.textContent = 'Saved!';
        setTimeout(() => { btn.textContent = 'Save'; loadUsers(); }, 1500);
      });
    });

    // Photo upload per user (with crop)
    el.querySelectorAll('.admin-photo-input').forEach(input => {
      input.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        input.value = '';
        const uid = input.dataset.photoUid;
        const panel = el.querySelector(`[data-panel-uid="${uid}"]`);
        const st = panel?.querySelector('.admin-edit-status');
        try {
          const cropped = await openCropModal(file);
          if (st) { st.textContent = 'Uploading photo\u2026'; st.className = 'form-status admin-edit-status'; st.hidden = false; }
          const blobs = await processImage(cropped);
          const urls = await uploadImageSet(blobs, `users/${uid}/photo`);
          await DB.updateUser(uid, { photo: urls });
          const preview = panel?.querySelector('.admin-photo-preview');
          if (preview) preview.innerHTML = `<img src="${escapeHTML(urls.medium)}" alt="Photo">`;
          if (st) { st.textContent = 'Photo updated!'; st.className = 'form-status admin-edit-status success'; }
        } catch (err) {
          if (err.message === 'Crop cancelled') return;
          if (st) { st.textContent = 'Upload failed: ' + err.message; st.className = 'form-status admin-edit-status error'; }
        }
      });
    });

    // CV upload per user
    el.querySelectorAll('.admin-cv-input').forEach(input => {
      input.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const uid = input.dataset.cvUid;
        const panel = el.querySelector(`[data-panel-uid="${uid}"]`);
        const st = panel?.querySelector('.admin-edit-status');
        if (st) { st.textContent = 'Uploading CV\u2026'; st.className = 'form-status admin-edit-status'; st.hidden = false; }
        try {
          const ref = McgheeLab.storage.ref().child(`users/${uid}/cv/${file.name}`);
          await ref.put(file);
          const url = await ref.getDownloadURL();
          await DB.updateUser(uid, { cv: url });
          if (st) { st.textContent = 'CV uploaded!'; st.className = 'form-status admin-edit-status success'; }
        } catch (err) {
          if (st) { st.textContent = 'Upload failed: ' + err.message; st.className = 'form-status admin-edit-status error'; }
        }
      });
    });

    // Association add/remove per user
    el.querySelectorAll('.admin-assoc').forEach(section => {
      const type = section.dataset.adminAssoc;
      const uid = section.dataset.assocUid;

      // Add
      const addBtn = section.querySelector('.admin-assoc-add-btn');
      addBtn?.addEventListener('click', async () => {
        const title = section.querySelector('.admin-assoc-title').value.trim();
        if (!title) { alert('Title is required'); return; }
        const url = section.querySelector('.admin-assoc-url').value.trim();
        const user = users.find(u => u.id === uid);
        const items = [...(user[type] || []), { title, url: url || '' }];
        try {
          await DB.updateUser(uid, { [type]: items });
          loadUsers();
        } catch (err) { alert('Error: ' + err.message); }
      });

      // Remove
      section.querySelectorAll('.assoc-remove-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const idx = parseInt(btn.dataset.index);
          const user = users.find(u => u.id === uid);
          const items = [...(user[type] || [])];
          items.splice(idx, 1);
          try {
            await DB.updateUser(uid, { [type]: items });
            loadUsers();
          } catch (err) { alert('Error: ' + err.message); }
        });
      });
    });

    el.querySelectorAll('[data-delete-user]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const uid = btn.dataset.deleteUser;
        if (uid === Auth.currentUser.uid) {
          alert('You cannot delete your own account.');
          return;
        }
        const user = users.find(u => u.id === uid);
        const isGuest = user?.role === 'guest';
        const msg = isGuest
          ? 'Delete this guest and all their comments & reactions?'
          : 'Delete this user profile and all their comments & reactions? To also remove their login, delete them in Firebase Console → Authentication.';
        if (!confirm(msg)) return;
        btn.disabled = true;
        btn.textContent = 'Deleting\u2026';
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

async function loadPendingNews() {
  const el = document.getElementById('pending-news-list');
  if (!el) return;
  try {
    const posts = await DB.getPendingNews();
    if (!posts.length) { el.innerHTML = '<p class="empty-state">No news posts pending review.</p>'; return; }
    el.innerHTML = posts.map(p => `
      <div class="pending-card">
        <div class="pending-info">
          <strong>${escapeHTML(p.title || 'Untitled')}</strong>
          <span class="badge news-cat-badge">${escapeHTML(NEWS_CATEGORIES.find(c => c.value === p.category)?.label || p.category || '')}</span>
          <span class="pending-author">by ${escapeHTML(p.authorName || 'Unknown')}</span>
          ${p.description ? `<p>${escapeHTML(p.description)}</p>` : ''}
        </div>
        <div class="pending-sections">
          ${(p.sections || []).slice(0, 2).map(sec => `
            <div class="pending-section-preview">
              <p>${escapeHTML((sec.text || '').substring(0, 200))}${(sec.text || '').length > 200 ? '\u2026' : ''}</p>
              ${sec.image ? `<img src="${escapeHTML(sec.image.thumb)}" alt="${escapeHTML(sec.imageAlt || '')}">` : ''}
            </div>`).join('')}
        </div>
        <div class="pending-actions">
          <button class="btn btn-primary btn-small" data-approve-news="${p.id}">Approve</button>
          <button class="btn btn-danger btn-small" data-reject-news="${p.id}">Reject</button>
          <button class="btn btn-secondary btn-small" data-view-news="${p.id}">View Full</button>
        </div>
      </div>`).join('');

    el.querySelectorAll('[data-approve-news]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await DB.updateNewsStatus(btn.dataset.approveNews, 'published');
        loadPendingNews();
      });
    });
    el.querySelectorAll('[data-reject-news]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Reject this news post? The author can revise and resubmit.')) return;
        await DB.updateNewsStatus(btn.dataset.rejectNews, 'draft');
        loadPendingNews();
      });
    });
    el.querySelectorAll('[data-view-news]').forEach(btn => {
      btn.addEventListener('click', () => {
        window.location.hash = '#/dashboard/news/' + btn.dataset.viewNews;
      });
    });
  } catch (err) {
    el.innerHTML = '<p class="error-text">Failed to load pending news.</p>';
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

async function loadCourseListings() {
  const el = document.getElementById('course-listings-list');
  if (!el) return;
  try {
    const classes = await DB.getAllClasses();
    if (!classes.length) { el.innerHTML = '<p class="empty-state">No courses yet. Use the form above to add one.</p>'; return; }
    el.innerHTML = `
      <table class="admin-table">
        <thead><tr><th>Title</th><th>When</th><th>Status</th><th>Order</th><th></th></tr></thead>
        <tbody>
          ${classes.map(c => `
            <tr>
              <td>${escapeHTML(c.title || '—')}</td>
              <td>${escapeHTML(c.when || '—')}</td>
              <td><span class="status-badge status-${c.status === 'published' ? 'published' : 'draft'}">${c.status || 'draft'}</span></td>
              <td>${c.order ?? 0}</td>
              <td style="white-space:nowrap;">
                ${c.detailPage ? `<a href="#/classes/${encodeURIComponent(c.detailPage)}" class="btn btn-small">Edit</a>` : ''}
                <button class="btn btn-danger btn-small" data-delete-course="${c.id}" data-detail-page="${escapeHTML(c.detailPage || '')}" style="margin-left:4px;">Delete</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>`;

    el.querySelectorAll('[data-delete-course]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this course and all its data?')) return;
        btn.disabled = true; btn.textContent = 'Deleting…';
        const courseId = btn.dataset.deleteCourse;
        const detailPage = btn.dataset.detailPage;
        try {
          // Delete the course listing
          await DB.deleteClass(courseId);

          // Cascade: delete the schedule + participants + classFiles
          if (detailPage && McgheeLab.ScheduleDB) {
            const SDB = McgheeLab.ScheduleDB;
            // Participants
            const parts = await SDB.getSpeakers(detailPage);
            for (const p of parts) await SDB.deleteSpeaker(p.id);
            // Class files (Firestore + Storage)
            const fileSnap = await McgheeLab.db.collection('classFiles')
              .where('classId', '==', detailPage).get();
            for (const doc of fileSnap.docs) {
              const f = doc.data();
              if (f.storagePath) {
                try { await firebase.storage().ref(f.storagePath).delete(); } catch (e) { /* ok */ }
              }
              await McgheeLab.db.collection('classFiles').doc(doc.id).delete();
            }
            // Schedule doc
            await McgheeLab.db.collection('schedules').doc(detailPage).delete();
          }
          loadCourseListings();
        } catch (err) { alert('Error deleting: ' + err.message); }
      });
    });
  } catch (err) {
    el.innerHTML = '<p class="error-text">Failed to load course listings.</p>';
  }
}


/* ================================================================
   EXPORTS
   ================================================================ */
McgheeLab.Auth             = Auth;
McgheeLab.DB               = DB;
McgheeLab.ROLES            = ROLES;
McgheeLab.BADGE_DEFS       = BADGE_DEFS;
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
McgheeLab.wireGuide        = wireGuide;
McgheeLab.renderOpportunities  = renderOpportunities;
McgheeLab.wireOpportunities    = wireOpportunities;
McgheeLab.renderAdmin      = renderAdmin;
McgheeLab.wireAdmin        = wireAdmin;
McgheeLab.renderNewsEditor = renderNewsEditor;
McgheeLab.wireNewsEditor   = wireNewsEditor;
McgheeLab.renderSchedulerEditor = renderSchedulerEditor;
McgheeLab.wireSchedulerEditor   = wireSchedulerEditor;
McgheeLab.renderSchedulePage    = renderSchedulePage;
McgheeLab.wireSchedulePage      = wireSchedulePage;
McgheeLab.NEWS_CATEGORIES  = NEWS_CATEGORIES;

/* ================================================================
   SOCIAL: Reactions & Comments (called from app.js feed)
   ================================================================ */
const REACTION_EMOJIS = [
  { key: 'thumbsup', display: '\uD83D\uDC4D' },
  { key: 'heart', display: '\u2764\uFE0F' },
  { key: 'celebrate', display: '\uD83C\uDF89' },
  { key: 'insightful', display: '\uD83D\uDCA1' },
  { key: 'fire', display: '\uD83D\uDD25' }
];

McgheeLab.loadReactions = async function(storyId, barEl) {
  let reactions = [];
  try { reactions = await DB.getReactionsByStory(storyId); } catch (e) { return; }

  const counts = {};
  const userReacted = {};
  reactions.forEach(r => {
    counts[r.emoji] = (counts[r.emoji] || 0) + 1;
    if (Auth.currentUser && r.authorUid === Auth.currentUser.uid) userReacted[r.emoji] = true;
  });

  const emojiMap = {};
  REACTION_EMOJIS.forEach(e => { emojiMap[e.key] = e.display; });

  // Only show emojis that have at least 1 reaction
  const activeEmojis = REACTION_EMOJIS.filter(e => counts[e.key] > 0);

  let html = activeEmojis.map(e => `
    <button type="button" class="reaction-btn ${userReacted[e.key] ? 'reacted' : ''}"
      data-emoji="${e.key}" data-story-id="${escapeHTML(storyId)}"
      ${!Auth.currentUser ? 'disabled title="Sign in to react"' : ''}>
      ${e.display} <span class="reaction-count">${counts[e.key]}</span>
    </button>
  `).join('');

  // Add reaction picker button
  html += `
    <div class="reaction-picker-wrap">
      <button type="button" class="reaction-add-btn"
        ${!Auth.currentUser ? 'disabled title="Sign in to react"' : ''}
        title="Add reaction">+</button>
      <div class="reaction-picker" hidden>
        ${REACTION_EMOJIS.map(e => `
          <button type="button" class="reaction-picker-item ${userReacted[e.key] ? 'reacted' : ''}"
            data-emoji="${e.key}" data-story-id="${escapeHTML(storyId)}">
            ${e.display}
          </button>
        `).join('')}
      </div>
    </div>
  `;

  barEl.innerHTML = html;

  // Wire existing reaction badge clicks (toggle)
  barEl.querySelectorAll('.reaction-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!Auth.currentUser) return;
      await DB.toggleReaction(storyId, btn.dataset.emoji);
      McgheeLab.loadReactions(storyId, barEl);
    });
  });

  // Wire picker toggle
  const addBtn = barEl.querySelector('.reaction-add-btn');
  const picker = barEl.querySelector('.reaction-picker');
  if (addBtn && picker) {
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!Auth.currentUser) return;
      // Close any other open pickers
      document.querySelectorAll('.reaction-picker:not([hidden])').forEach(p => { if (p !== picker) p.hidden = true; });
      picker.hidden = !picker.hidden;
    });

    picker.querySelectorAll('.reaction-picker-item').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!Auth.currentUser) return;
        picker.hidden = true;
        await DB.toggleReaction(storyId, btn.dataset.emoji);
        McgheeLab.loadReactions(storyId, barEl);
      });
    });
  }

  // Close picker when clicking outside
  const closeHandler = (e) => {
    if (!barEl.contains(e.target)) {
      if (picker) picker.hidden = true;
      document.removeEventListener('click', closeHandler);
    }
  };
  document.addEventListener('click', closeHandler);
};

McgheeLab.loadComments = async function(storyId, sectionEl) {
  let comments = [];
  try { comments = await DB.getCommentsByStory(storyId); } catch (e) { return; }

  let html = comments.map(c => {
    const dateStr = c.createdAt?.toDate?.()
      ? c.createdAt.toDate().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '';
    const canDelete = Auth.currentUser && (c.authorUid === Auth.currentUser.uid || Auth.isAdmin());
    return `
      <div class="comment-item">
        <div class="comment-header">
          <button type="button" class="comment-author-btn" data-author-uid="${escapeHTML(c.authorUid || '')}">
            ${c.authorPhoto
              ? `<img src="${escapeHTML(c.authorPhoto)}" class="comment-avatar" alt="">`
              : `<div class="comment-avatar comment-avatar-placeholder">${escapeHTML((c.authorName || '?')[0])}</div>`}
            <strong>${escapeHTML(c.authorName || 'Anonymous')}</strong>
          </button>
          <span class="comment-date">${escapeHTML(dateStr)}</span>
          ${canDelete ? `<button type="button" class="btn-icon btn-danger-icon comment-delete" data-delete-comment="${escapeHTML(c.id)}">&times;</button>` : ''}
        </div>
        <p class="comment-text">${escapeHTML(c.text)}</p>
      </div>
    `;
  }).join('');

  if (Auth.currentUser) {
    html += `
      <form class="comment-form" data-story-id="${escapeHTML(storyId)}">
        <textarea class="comment-input" placeholder="Add a comment\u2026" rows="2" required></textarea>
        <button type="submit" class="btn btn-primary btn-small">Post</button>
      </form>
    `;
  } else {
    html += `<p class="hint" style="padding:.5rem 0"><a href="#" class="login-to-comment" style="color:var(--accent,#60a5fa)">Sign in</a> to comment.</p>`;
  }

  sectionEl.innerHTML = html;

  // Wire "Sign in" link to save redirect
  const loginLink = sectionEl.querySelector('.login-to-comment');
  if (loginLink) {
    loginLink.addEventListener('click', (e) => {
      e.preventDefault();
      sessionStorage.setItem('mcghee_login_redirect', window.location.hash);
      window.location.hash = '#/login';
    });
  }

  // Wire clickable author → popover
  sectionEl.querySelectorAll('.comment-author-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      // Close any existing popover
      document.querySelectorAll('.author-popover').forEach(p => p.remove());
      const uid = btn.dataset.authorUid;
      if (!uid) return;
      const user = await DB.getUser(uid).catch(() => null);
      if (!user) return;
      const pop = document.createElement('div');
      pop.className = 'author-popover';
      pop.innerHTML = `
        <div class="author-popover-content">
          ${user.photo?.medium
            ? `<img src="${escapeHTML(user.photo.medium)}" class="author-popover-photo" alt="">`
            : `<div class="author-popover-photo author-popover-placeholder">${escapeHTML((user.name || '?')[0])}</div>`}
          <div class="author-popover-info">
            <strong>${escapeHTML(user.name || 'Anonymous')}</strong>
            ${user.bio ? `<p>${escapeHTML(user.bio)}</p>` : ''}
          </div>
        </div>`;
      btn.style.position = 'relative';
      btn.appendChild(pop);
      const close = (ev) => {
        if (!pop.contains(ev.target) && ev.target !== btn) {
          pop.remove();
          document.removeEventListener('click', close);
        }
      };
      setTimeout(() => document.addEventListener('click', close), 0);
    });
  });

  sectionEl.querySelectorAll('.comment-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      await DB.deleteComment(btn.dataset.deleteComment);
      McgheeLab.loadComments(storyId, sectionEl);
      // Update count
      const countEl = document.querySelector(`[data-comment-count="${storyId}"]`);
      if (countEl) countEl.textContent = String(Math.max(0, (parseInt(countEl.textContent) || 0) - 1));
    });
  });

  const form = sectionEl.querySelector('.comment-form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = form.querySelector('.comment-input');
      if (!input.value.trim()) return;
      await DB.addComment({
        storyId,
        authorUid: Auth.currentUser.uid,
        authorName: Auth.currentProfile?.name || '',
        authorPhoto: Auth.currentProfile?.photo?.thumb || Auth.currentProfile?.photo || '',
        text: input.value.trim()
      });
      input.value = '';
      McgheeLab.loadComments(storyId, sectionEl);
      const countEl = document.querySelector(`[data-comment-count="${storyId}"]`);
      if (countEl) countEl.textContent = String((parseInt(countEl.textContent) || 0) + 1);
    });
  }
};

// Initialize auth listener on DOM ready
document.addEventListener('DOMContentLoaded', () => Auth.init());

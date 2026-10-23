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
  { value: 'masters',    label: 'Masters Student' },
  { value: 'undergrad',  label: 'Undergraduate' },
  { value: 'highschool', label: 'High School' },
  { value: 'alumni',     label: 'Alumni' },
  // V3.304 — external educators/students using our class modules. They
  // keep role:'guest' (no lab/RM access); class capabilities come from
  // schedules ownership + enrollments membership (see teacher-classes.js).
  { value: 'teacher',    label: 'Teacher (external)' },
  { value: 'student',    label: 'Student (external)' },
  { value: 'guest',      label: 'Guest' }
];

/* Default role per category — PI gets admin, grad/postdoc get editor, others get contributor */
const CATEGORY_DEFAULT_ROLE = {
  pi:         'admin',
  postdoc:    'editor',
  grad:       'editor',
  masters:    'editor',
  undergrad:  'contributor',
  highschool: 'contributor',
  alumni:     'contributor',
  teacher:    'guest',
  student:    'guest',
  guest:      'guest'
};

/* V3.312 — prior-category choices for alumni grouping. Values match
   CATEGORIES; the team page displays 'grad' alumni under "PhD". */
const ALUMNI_PRIOR_CATEGORIES = [
  { value: 'postdoc',    label: 'Postdoc' },
  { value: 'grad',       label: 'Graduate (PhD)' },
  { value: 'masters',    label: 'Masters' },
  { value: 'undergrad',  label: 'Undergraduate' },
  { value: 'highschool', label: 'High School' }
];

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

/* V3.302 — markdown-lite for story/news section text. Escapes ALL HTML
   first, then re-introduces exactly three constructs: [text](https url),
   **bold**, *italic*. Newlines become <br>. Used by the public feed
   renderers in app.js (via McgheeLab.renderRichText) and the editor
   preview, so authored text renders identically everywhere. */
function renderRichText(s) {
  let out = escapeHTML(s ?? '');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Content must start and end on a non-space so "5 * 3 * 2" stays math.
  out = out.replace(/\*\*([^\s*](?:[^*\n]*[^\s*])?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^\s*](?:[^*\n]*[^\s*])?)\*(?!\*)/g, '$1<em>$2</em>');
  out = out.replace(/\n/g, '<br>');
  return out;
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
  /* V3.302 — mint a Firestore doc id without writing. Editors assign
     the id up front so media uploads land at the real Storage path
     instead of a throwaway "draft_<ts>" / "temp_<ts>" folder. */
  newDocId(coll) {
    return McgheeLab.db.collection(coll).doc().id;
  },

  /* ── Users ── */
  async getUser(uid) {
    const doc = await McgheeLab.db.collection('users').doc(uid).get();
    return doc.exists ? { id: doc.id, ...doc.data() } : null;
  },
  async updateUser(uid, data) {
    data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    await McgheeLab.db.collection('users').doc(uid).set(data, { merge: true });
  },
  /* V3.637 — the PUBLIC team page's user source. `users` is no longer
     world-readable: only docs with a non-guest role are, so the query has to
     carry that constraint (a list is denied outright if any doc it would
     return fails the rule). Signed-in lab members and admins still use
     getAllUsers() for the pickers and the admin table. */
  async getPublicProfiles() {
    const snap = await McgheeLab.db.collection('users').where('role', '!=', 'guest').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
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
  async updateStoryStatus(id, status, extra) {
    const update = { ...(extra || {}), status, updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
    if (status === 'published') {
      const doc = await McgheeLab.db.collection('stories').doc(id).get();
      if (!doc.data()?.publishedAt) update.publishedAt = firebase.firestore.FieldValue.serverTimestamp();
    }
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
  /* V3.553 — published Research Foci snapshots (publicFoci: public read,
   * admin write). Authored + published from RM's research page; renders on
   * #/projects. Whole-collection get — the map is tens of docs; sorted
   * client-side by level (specialty → concept → grant → aim → output —
   * V3.717) then order. */
  async getPublicFoci() {
    const snap = await McgheeLab.db.collection('publicFoci').get();
    const levelRank = { specialty: 0, concept: 1, grant: 2, aim: 3, output: 4 };
    return snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) =>
        (levelRank[a.level] ?? 9) - (levelRank[b.level] ?? 9) ||
        (a.order || 0) - (b.order || 0) ||
        String(a.title || '').localeCompare(String(b.title || '')));
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
  async updateNewsStatus(id, status, extra) {
    const update = { ...(extra || {}), status, updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
    if (status === 'published') {
      const doc = await McgheeLab.db.collection('newsPosts').doc(id).get();
      if (!doc.data()?.publishedAt) update.publishedAt = firebase.firestore.FieldValue.serverTimestamp();
    }
    await McgheeLab.db.collection('newsPosts').doc(id).update(update);
  },
  async deleteNewsPost(id) {
    await McgheeLab.db.collection('newsPosts').doc(id).delete();
  },

  /* ── Visualization views (V3.301 — Data Visualizations) ──
     Saved camera/settings presets for the DataIllustrations viewers.
     Queries use where() only (no orderBy) so no composite index is
     needed; callers get client-side createdAt-desc sorting. */
  async getVizViews(vizId) {
    const snap = await McgheeLab.db.collection('vizViews')
      .where('vizId', '==', vizId).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  },
  async getAllVizViews() {
    const snap = await McgheeLab.db.collection('vizViews').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  },
  async getVizView(id) {
    const doc = await McgheeLab.db.collection('vizViews').doc(id).get();
    return doc.exists ? { id: doc.id, ...doc.data() } : null;
  },
  async saveVizView({ vizId, name, config, posterBlob }) {
    const ref = McgheeLab.db.collection('vizViews').doc();
    let poster = null;
    if (posterBlob) {
      const blobs = await processImage(posterBlob);
      poster = await uploadImageSet(blobs, `vizViews/${ref.id}/poster`);
    }
    const data = {
      vizId, name, config, poster,
      createdBy: Auth.currentUser?.uid || null,
      createdByName: Auth.currentProfile?.name || Auth.currentUser?.displayName || '',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    await ref.set(data);
    return { id: ref.id, ...data };
  },
  async deleteVizView(id) {
    await McgheeLab.db.collection('vizViews').doc(id).delete();
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

// V3.332 — map Firebase auth error codes to human-readable copy.
// user-not-found / wrong-password / invalid-credential share one message
// so the form can't be used to probe which emails have accounts.
const AUTH_ERROR_MESSAGES = {
  'auth/invalid-email':             'That email address doesn’t look right. Please check it and try again.',
  'auth/user-disabled':             'This account has been disabled. Contact the lab administrator.',
  'auth/user-not-found':            'Incorrect email or password.',
  'auth/wrong-password':            'Incorrect email or password.',
  'auth/invalid-credential':        'Incorrect email or password.',
  'auth/invalid-login-credentials': 'Incorrect email or password.',
  'auth/too-many-requests':         'Too many attempts. Wait a few minutes and try again, or reset your password.',
  'auth/network-request-failed':    'Network error. Check your connection and try again.',
  'auth/popup-blocked':             'Your browser blocked the sign-in window. Allow popups for this site and try again.',
  'auth/cancelled-popup-request':   'Another sign-in attempt is already in progress.',
  'auth/email-already-in-use':      'An account with this email already exists. Try signing in instead.',
  'auth/weak-password':             'Password is too weak — use at least 8 characters.',
  'auth/missing-email':             'Please enter your email address.'
};

function friendlyAuthError(err) {
  if (err?.code && AUTH_ERROR_MESSAGES[err.code]) return AUTH_ERROR_MESSAGES[err.code];
  if (typeof err?.code === 'string' && err.code.startsWith('auth/')) return 'Sign-in failed. Please try again.';
  // Non-auth errors (e.g. Auth.register's invitation checks) already carry
  // human-written messages — pass them through.
  return err?.message || 'Something went wrong. Please try again.';
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
  ]);
}

const Auth = {
  currentUser: null,
  currentProfile: null,
  _listeners: [],
  _authStateResolved: false,  // true once onAuthStateChanged has fired at least once

  init() {
    if (!McgheeLab.auth) return;

    // V3.332 — return leg of the popup-blocked → signInWithRedirect fallback.
    if (sessionStorage.getItem('mcghee_google_redirect_pending')) {
      sessionStorage.removeItem('mcghee_google_redirect_pending');
      McgheeLab.auth.getRedirectResult()
        .then(async (cred) => {
          if (cred?.user) {
            await Auth._ensureGuestDoc(cred.user);
            Auth.currentProfile = await DB.getUser(cred.user.uid).catch(() => Auth.currentProfile);
            Auth.updateNavigation();
          }
        })
        .catch((err) => {
          sessionStorage.setItem('mcghee_google_redirect_error', friendlyAuthError(err));
        });
    }

    McgheeLab.auth.onAuthStateChanged(async (user) => {
      // V3.806 — an alias login is swapped for its primary account; this
      // listener re-fires with that account, so skip the alias entirely.
      if (user && await Auth._aliasSwap(user)) return;
      Auth.currentUser = user;
      Auth._authStateResolved = true;
      if (user) {
        try {
          Auth.currentProfile = await DB.getUser(user.uid);
          Auth._removeProfileNotice();
        } catch (e) {
          console.warn('Failed to load profile:', e);
          // Keep the user signed in with a null profile (never drop auth) —
          // retry in the background so the first render isn't held up.
          Auth.currentProfile = null;
          Auth._retryProfileLoad(user.uid);
        }
        document.body.classList.add('logged-in');
        document.body.classList.toggle('is-admin', Auth.currentProfile?.role === 'admin');
      } else {
        Auth.currentProfile = null;
        document.body.classList.remove('logged-in', 'is-admin');
        Auth._removeProfileNotice();
      }
      Auth.updateNavigation();
      Auth._listeners.forEach(fn => fn(user, Auth.currentProfile));
    });
  },

  /* V3.806 — one person, two Google logins. An alias email's session is
     swapped for the account it belongs to (functions/auth-alias.js holds the
     authoritative map; this list only spares other sign-ins the round-trip —
     keep in sync with rm/js/firebase-bridge.js). On failure we stay signed in
     as the alias, as before. */
  _ALIAS_EMAILS: ['mcgheealex@arizona.edu'],
  _aliasSwapping: false,
  async _aliasSwap(user) {
    const email = String(user.email || '').toLowerCase();
    if (!Auth._ALIAS_EMAILS.includes(email) || Auth._aliasSwapping) return false;
    Auth._aliasSwapping = true;
    try {
      const r = await fetch('https://us-central1-mcgheelab-f56cc.cloudfunctions.net/aliasSignIn', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + (await user.getIdToken()), 'Content-Type': 'application/json' },
        body: '{}'
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body.token) throw new Error(body.error || ('HTTP ' + r.status));
      await McgheeLab.auth.signInWithCustomToken(body.token);
      return true;
    } catch (err) {
      console.warn('[auth] alias sign-in failed; staying signed in as ' + email + ':', err.message);
      return false;
    } finally {
      Auth._aliasSwapping = false;
    }
  },

  // V3.332 — background retry when the initial profile read fails.
  _profileRetryActive: false,
  _retryProfileLoad(uid) {
    if (Auth._profileRetryActive) return;
    Auth._profileRetryActive = true;
    (async () => {
      let delay = 1500;
      for (let i = 0; i < 3 && Auth.currentUser?.uid === uid; i++) {
        await new Promise(r => setTimeout(r, delay));
        delay *= 2;
        if (Auth.currentUser?.uid !== uid) break;
        try {
          Auth.currentProfile = await DB.getUser(uid);
          document.body.classList.toggle('is-admin', Auth.currentProfile?.role === 'admin');
          Auth.updateNavigation();
          Auth._removeProfileNotice();
          Auth._profileRetryActive = false;
          Auth._listeners.forEach(fn => fn(Auth.currentUser, Auth.currentProfile));
          // app.js dedupes auth re-renders by uid, so force one router pass
          // to upgrade whatever gated page is open.
          const page = (window.location.hash || '').slice(2).split('/')[0];
          if (['dashboard', 'admin', 'cv'].includes(page)) {
            window.dispatchEvent(new HashChangeEvent('hashchange'));
          }
          return;
        } catch (e) { /* keep retrying */ }
      }
      Auth._profileRetryActive = false;
      if (Auth.currentUser?.uid === uid) Auth._showProfileNotice(uid);
    })();
  },

  _showProfileNotice(uid) {
    Auth._removeProfileNotice();
    const div = document.createElement('div');
    div.className = 'profile-load-notice';
    div.innerHTML = `
      <span>Couldn’t load your profile — some features may be limited.</span>
      <button type="button" class="profile-notice-retry">Retry</button>
      <button type="button" class="profile-notice-close" aria-label="Dismiss">✕</button>`;
    div.querySelector('.profile-notice-retry').addEventListener('click', () => {
      Auth._removeProfileNotice();
      Auth._retryProfileLoad(uid);
    });
    div.querySelector('.profile-notice-close').addEventListener('click', () => Auth._removeProfileNotice());
    document.body.appendChild(div);
  },

  _removeProfileNotice() {
    document.querySelector('.profile-load-notice')?.remove();
  },

  onChange(fn) { Auth._listeners.push(fn); },
  offChange(fn) { Auth._listeners = Auth._listeners.filter(f => f !== fn); },

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
    // Apps menu retired in V3.40 — lab apps now live under /rm/. The
    // 'nav-apps' toggle is left out so any orphaned #dnav-apps element
    // stays hidden (display:none from the markup) regardless of role.
    toggle(['nav-rm',        'dnav-rm',        'more-rm'],        isNotGuest);

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
      // V3.304 — the users create rule only allows a non-guest role when
      // the doc carries the (unused) invitation that granted it. Must be
      // written before markInvitationUsed flips the token.
      inviteToken: token,
      claimedProfileId: inv.claimProfileId || null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    await DB.markInvitationUsed(token, cred.user.uid);
    return cred.user;
  },

  // Check if user doc exists; if not, create a guest profile.
  // V3.805 — create-only inside a transaction (server read, never queued
  // offline). The old `getUser().catch(() => null)` treated a FAILED read as
  // "no doc" and merge-wrote role/category 'guest' + empty bio over a real
  // profile; rules allow that for an admin's own doc.
  async _ensureGuestDoc(user) {
    const ref = McgheeLab.db.collection('users').doc(user.uid);
    const now = firebase.firestore.FieldValue.serverTimestamp();
    await McgheeLab.db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      if (snap.exists) return;
      t.set(ref, {
        name: user.displayName || '',
        email: user.email || '',
        photo: user.photoURL ? { thumb: user.photoURL, medium: user.photoURL, full: user.photoURL } : null,
        bio: '',
        category: 'guest',
        role: 'guest',
        createdAt: now,
        updatedAt: now
      });
    }).catch(err => console.warn('[auth] guest-doc bootstrap skipped:', err.message));
  },

  async googleLogin() {
    const provider = new firebase.auth.GoogleAuthProvider();
    try {
      const cred = await McgheeLab.auth.signInWithPopup(provider);
      await Auth._ensureGuestDoc(cred.user);
      return cred.user;
    } catch (err) {
      // V3.332 — popup blocked: fall back to a full-page redirect. The
      // intended destination is preserved in mcghee_login_redirect and
      // consumed by renderLogin on the return leg.
      if (err.code === 'auth/popup-blocked' || err.code === 'auth/operation-not-supported-in-this-environment') {
        if (!sessionStorage.getItem('mcghee_login_redirect')) {
          sessionStorage.setItem('mcghee_login_redirect', '#/research');
        }
        sessionStorage.setItem('mcghee_google_redirect_pending', '1');
        await McgheeLab.auth.signInWithRedirect(provider);
        return null; // navigation takes over
      }
      throw err;
    }
  },

  async sendPasswordReset(email) {
    await McgheeLab.auth.sendPasswordResetEmail(email, {
      url: window.location.origin + '/#/login'
    });
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

// V3.332 — shared loading/redirect placeholder (spinner + label)
function authLoadingHTML(label = 'Loading…') {
  return `<div class="auth-loading"><div class="auth-spinner" aria-hidden="true"></div><p class="loading-text">${escapeHTML(label)}</p></div>`;
}

function renderLogin() {
  if (!McgheeLab.auth) {
    return '<div class="auth-card"><p>User system is not configured. See firebase-config.js.</p></div>';
  }

  // If already authenticated, skip login and return to where the user was
  // headed (comment link, redirect-fallback return leg) or the dashboard.
  if (Auth.currentUser) {
    const prev = sessionStorage.getItem('mcghee_login_redirect');
    sessionStorage.removeItem('mcghee_login_redirect');
    window.location.hash = prev || '#/dashboard';
    return authLoadingHTML('Redirecting…');
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
            <div id="auth-notice" class="auth-notice" hidden></div>
            <button type="submit" class="btn btn-primary">Sign In</button>
            <button type="button" class="auth-link-btn" id="forgot-password-btn">Forgot password?</button>
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
  // V3.332 \u2014 surface an error stashed by the signInWithRedirect return leg
  const redirectErr = sessionStorage.getItem('mcghee_google_redirect_error');
  if (redirectErr && !Auth.currentUser) {
    sessionStorage.removeItem('mcghee_google_redirect_error');
    const gErr = document.getElementById('google-error');
    if (gErr) { gErr.textContent = redirectErr; gErr.hidden = false; }
  }

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

      const fd = new FormData(form);
      const token = fd.get('token');
      try {
        let user;
        if (token) {
          user = await Auth.register(fd.get('email'), fd.get('password'), fd.get('name'), token);
        } else {
          user = await Auth.login(fd.get('email'), fd.get('password'));
        }
        // Ensure profile is loaded before redirecting so dashboard renders
        // correctly \u2014 but don't hang forever; onAuthStateChanged fills it later.
        if (!Auth.currentProfile && user) {
          try {
            Auth.currentProfile = await withTimeout(DB.getUser(user.uid), 8000);
            document.body.classList.add('logged-in');
            document.body.classList.toggle('is-admin', Auth.currentProfile?.role === 'admin');
            Auth.updateNavigation();
          } catch (e) { /* onAuthStateChanged will retry */ }
        }
        const prev = sessionStorage.getItem('mcghee_login_redirect');
        sessionStorage.removeItem('mcghee_login_redirect');
        window.location.hash = prev || '#/dashboard';
      } catch (err) {
        errEl.textContent = friendlyAuthError(err);
        errEl.hidden = false;
        btn.disabled = false;
        btn.textContent = token ? 'Create Account' : 'Sign In';
      }
    });
  }

  // Forgot password (V3.332)
  const forgotBtn = document.getElementById('forgot-password-btn');
  if (forgotBtn) {
    forgotBtn.addEventListener('click', async () => {
      const errEl = document.getElementById('auth-error');
      const noteEl = document.getElementById('auth-notice');
      errEl.hidden = true;
      noteEl.hidden = true;
      const email = (document.getElementById('auth-email')?.value || '').trim();
      if (!email) {
        errEl.textContent = 'Enter your email above first, then click \u201cForgot password?\u201d';
        errEl.hidden = false;
        return;
      }
      forgotBtn.disabled = true;
      forgotBtn.textContent = 'Sending\u2026';
      // Same message whether or not the account exists \u2014 no enumeration.
      const sentMsg = `If an account exists for ${email}, a password-reset link has been sent. Check your inbox (and spam folder).`;
      try {
        await Auth.sendPasswordReset(email);
        noteEl.textContent = sentMsg;
        noteEl.hidden = false;
      } catch (err) {
        if (err.code === 'auth/user-not-found') {
          noteEl.textContent = sentMsg;
          noteEl.hidden = false;
        } else {
          errEl.textContent = friendlyAuthError(err);
          errEl.hidden = false;
        }
      }
      forgotBtn.textContent = 'Forgot password?';
      setTimeout(() => { forgotBtn.disabled = false; }, 30000); // resend cooldown
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
        // null \u2192 popup was blocked and a full-page redirect is in flight;
        // leave the button in its "Signing in\u2026" state while we navigate.
        if (!user) return;
        if (!Auth.currentProfile) {
          try {
            Auth.currentProfile = await withTimeout(DB.getUser(user.uid), 8000);
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
          errEl.textContent = friendlyAuthError(err);
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
/* V3.304 \u2014 the basic profile card (photo + name + bio) is shared by the
   guest, teacher, and student dashboards. teacher-classes.js embeds it
   via McgheeLab.renderGuestProfileCard / wireGuestProfileCard. */
function renderGuestProfileCard(p) {
  return `
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
        </div>`;
}

function wireGuestProfileCard() {
  /* V3.632 — in a demo preview these two writes would land on the
     previewing admin's own profile doc and storage path, so they are
     intercepted into the demo action log instead. */
  const demo = () => (McgheeLab.TC_DEMO?.active ? McgheeLab.TC_DEMO : null);

  // Photo upload with crop
  document.getElementById('profile-photo-input')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    const st = document.getElementById('profile-status');
    if (demo()) { demo().interceptProfileWrite('profile photo upload'); return; }
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
      if (demo()) { demo().interceptProfileWrite('profile save'); btn.disabled = false; return; }
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
        ${renderGuestProfileCard(p)}
      </div>
    </div>`;
}

/* V3.680 — the "Are you a teacher?" / "Have a class code?" cards are gone
   from the guest dashboard at Alex's direction: no teacher/student
   self-identification on login surfaces. Teacher onboarding now lives on the
   teacher-focused #/teachers page (linked from Classes) plus admin-issued
   invites; students join through the class LINK their teacher shares (the
   class page's code gate still flips category on success). */
function wireGuestDashboard() {
  document.getElementById('dash-logout-btn')?.addEventListener('click', () => Auth.logout());
  wireGuestProfileCard();
}

/* ================================================================
   RENDER: DASHBOARD
   ================================================================ */
function renderDashboard() {
  /* V3.632 \u2014 demo mode: an admin previewing a teacher/student persona
     gets that persona's dashboard, not their own. Checked before the
     isGuest() branch because the previewing account is role:'admin',
     which is exactly why these panels were unreachable before. */
  const demo = McgheeLab.TC_DEMO;
  if (demo?.active && !demo.signedOut) {
    const dp = demo.profile;
    if (dp.category === 'teacher' && McgheeLab.renderTeacherDashboard) return McgheeLab.renderTeacherDashboard(dp);
    if (dp.category === 'student' && McgheeLab.renderStudentDashboard) return McgheeLab.renderStudentDashboard(dp);
    return renderGuestDashboard(dp);
  }

  if (!Auth.currentUser) { window.location.hash = '#/login'; return authLoadingHTML('Redirecting\u2026'); }
  const p = Auth.currentProfile || {};

  /* ── Guest-role dashboards ──────────────────────────────────
     V3.304: external teachers/students keep role:'guest' but get
     their own panels (teacher-classes.js). Plain guests get the
     profile-only view with teacher/student CTAs. */
  if (Auth.isGuest()) {
    if (p.category === 'teacher' && McgheeLab.renderTeacherDashboard) return McgheeLab.renderTeacherDashboard(p);
    if (p.category === 'student' && McgheeLab.renderStudentDashboard) return McgheeLab.renderStudentDashboard(p);
    return renderGuestDashboard(p);
  }

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

      <div id="dash-status-strip"></div>

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

        <!-- API Keys Card -->
        <div class="dash-card">
          <h3>API Keys</h3>
          <p class="hint">Manage API keys used across lab apps (CV Builder AI, Activity Tracker, etc.).</p>
          <div class="form-group" style="margin-top:.5rem">
            <label for="dash-api-key">Anthropic API Key</label>
            <div style="display:flex;gap:.5rem;align-items:center">
              <input type="password" id="dash-api-key" placeholder="${p.anthropicKey ? 'Key saved \u2713' : 'sk-ant-...'}" style="flex:1">
              <button type="button" class="btn btn-primary btn-small" id="save-api-key-btn">Save</button>
              ${p.anthropicKey ? '<button type="button" class="btn btn-secondary btn-small" id="clear-api-key-btn">Clear</button>' : ''}
            </div>
            <p class="hint" style="margin-top:.25rem">Get a key at <a href="https://console.anthropic.com" target="_blank" rel="noopener">console.anthropic.com</a>. Stored securely in your profile. Powers AI features in CV Builder and Activity Tracker.</p>
          </div>
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
  /* V3.632 — mirrors the demo dispatch in renderDashboard. */
  const demo = McgheeLab.TC_DEMO;
  if (demo?.active && !demo.signedOut) {
    const cat = demo.profile.category;
    if (cat === 'teacher' && McgheeLab.wireTeacherDashboard) { await McgheeLab.wireTeacherDashboard(); return; }
    if (cat === 'student' && McgheeLab.wireStudentDashboard) { await McgheeLab.wireStudentDashboard(); return; }
    wireGuestDashboard(); return;
  }

  if (!Auth.currentUser) return;

  /* Guest gets a simpler wiring path (V3.304: teacher/student panels
     wire through teacher-classes.js, matching the render dispatch) */
  if (Auth.isGuest()) {
    const cat = Auth.currentProfile?.category;
    if (cat === 'teacher' && McgheeLab.wireTeacherDashboard) { await McgheeLab.wireTeacherDashboard(); return; }
    if (cat === 'student' && McgheeLab.wireStudentDashboard) { await McgheeLab.wireStudentDashboard(); return; }
    wireGuestDashboard(); return;
  }

  // Logout button
  document.getElementById('dash-logout-btn')?.addEventListener('click', () => Auth.logout());

  // API Key management
  document.getElementById('save-api-key-btn')?.addEventListener('click', async () => {
    const input = document.getElementById('dash-api-key');
    const btn = document.getElementById('save-api-key-btn');
    const key = input?.value?.trim();
    if (!key) return;
    try {
      btn.textContent = 'Saving\u2026'; btn.disabled = true;
      await DB.updateUser(Auth.currentUser.uid, { anthropicKey: key });
      Auth.currentProfile.anthropicKey = key;
      input.value = '';
      input.placeholder = 'Key saved \u2713';
      btn.textContent = 'Saved!';
      setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 1500);
    } catch (e) {
      btn.textContent = 'Failed'; btn.disabled = false;
    }
  });
  document.getElementById('clear-api-key-btn')?.addEventListener('click', async () => {
    if (!confirm('Remove your Anthropic API key?')) return;
    try {
      await DB.updateUser(Auth.currentUser.uid, { anthropicKey: firebase.firestore.FieldValue.delete() });
      Auth.currentProfile.anthropicKey = null;
      const input = document.getElementById('dash-api-key');
      if (input) input.placeholder = 'sk-ant-...';
      document.getElementById('clear-api-key-btn')?.remove();
    } catch (e) {
      console.warn('Failed to remove API key:', e);
    }
  });

  // New story button
  document.getElementById('new-story-btn')?.addEventListener('click', () => {
    window.location.hash = '#/dashboard/story/new';
  });

  // Load story list
  await refreshStoryList();

  // V3.302 — status strip (pending / needs-changes / just-published)
  renderDashStatusStrip();

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
        booleanQuestions: [],
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
        const updates = {
          name: document.getElementById('profile-name').value,
          bio: document.getElementById('profile-bio').value,
          category: document.getElementById('profile-category').value
        };
        // V3.312 — stamp priorCategory on an active→alumni flip, same
        // rule as the admin editor, so self-flipped alumni group right.
        const prevCat = Auth.currentProfile?.category;
        if (updates.category === 'alumni' && prevCat && prevCat !== 'alumni') {
          updates.priorCategory = prevCat;
        }
        await DB.updateUser(Auth.currentUser.uid, updates);
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

/* V3.302 — dashboard status strip: the author's feedback loop. One
   banner per story/news post that is awaiting review, needs changes, or
   was published in the last 14 days (🎉 banners are dismissible; the
   dismissal is remembered in localStorage so published docs stay
   untouched — contributors can no longer write to published docs). */
async function renderDashStatusStrip() {
  const el = document.getElementById('dash-status-strip');
  if (!el || !Auth.currentUser) return;
  try {
    const uid = Auth.currentUser.uid;
    const [stories, news] = await Promise.all([
      DB.getStoriesByUser(uid).catch(() => []),
      DB.getNewsByUser(uid).catch(() => [])
    ]);
    const items = [
      ...stories.map(s => ({ ...s, _kind: 'story', _route: `#/dashboard/story/${s.id}` })),
      ...news.map(p => ({ ...p, _kind: 'news', _route: `#/dashboard/news/${p.id}` }))
    ];

    const seen = (id, status) => localStorage.getItem(`mcghee_status_seen_${id}_${status}`) === '1';
    const banners = [];
    items.forEach(it => {
      const title = escapeHTML(it.title || 'Untitled');
      if (it.status === 'pending') {
        banners.push(`<div class="status-banner status-banner-pending">
          ${ICON.svg('clock')} <a href="${it._route}">${title}</a> is awaiting review.</div>`);
      } else if (it.status === 'changes-requested') {
        banners.push(`<div class="status-banner status-banner-changes">
          ${ICON.svg('pencil')} <a href="${it._route}">${title}</a> needs changes${it.reviewNote ? ': <em>' + escapeHTML(it.reviewNote) + '</em>' : '.'}</div>`);
      } else if (it.status === 'published' && !seen(it.id, 'published')) {
        const pub = it.publishedAt?.toDate?.();
        if (pub && (Date.now() - pub.getTime()) < 14 * 86400000) {
          const publicRoute = it._kind === 'story' ? '#/research' : '#/news';
          banners.push(`<div class="status-banner status-banner-published" data-dismiss-id="${escapeHTML(it.id)}">
            ${ICON.svg('sparkles')} <strong>${title}</strong> is live on the <a href="${publicRoute}">${it._kind === 'story' ? 'Research' : 'News'} page</a>!
            <button type="button" class="status-banner-dismiss" title="Dismiss">&times;</button></div>`);
        }
      }
    });

    el.innerHTML = banners.join('');
    el.querySelectorAll('.status-banner-dismiss').forEach(btn => {
      btn.addEventListener('click', () => {
        const banner = btn.closest('.status-banner');
        localStorage.setItem(`mcghee_status_seen_${banner.dataset.dismissId}_published`, '1');
        banner.remove();
      });
    });
  } catch (e) {
    console.warn('Status strip failed:', e);
  }
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
          <span class="status-badge status-${s.status || 'draft'}">${(s.status || 'draft').replace('-', ' ')}</span>
          ${s.status === 'changes-requested' && s.reviewNote
            ? `<p class="review-note">${ICON.svg('pencil')} ${escapeHTML(s.reviewNote)}</p>` : ''}
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
  if (!Auth.currentUser) { window.location.hash = '#/login'; return authLoadingHTML('Redirecting\u2026'); }
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

  // ── Step 2: Team — shared picker (V3.302 dedup) ──
  const mentorSelect = document.getElementById('proj-mentor');
  const teamPicker = await setupTeamPicker({
    mentorSelect,
    contribSelect: document.getElementById('proj-contributor-select'),
    chipsEl: document.getElementById('proj-contributor-chips'),
    addBtn: document.getElementById('proj-add-contributor-btn'),
    authorField: document.getElementById('proj-author-name')
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
      teamPicker.restore(existing.team);
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
    const contribNames = teamPicker.selectedContributors.map(c => c.name || c.uid).join(', ') || '(none)';
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
    const team = teamPicker.collectTeam(); // V3.302 dedup

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
   EDITOR KIT (V3.302) — shared internals for the story and news
   editors: one implementation of section blocks, media upload, team
   pickers, draft autosave, and true preview. Parameterized per editor
   so a fix or feature lands in both at once.
   ================================================================ */
const RICH_TEXT_HINT = 'Formatting: **bold**, *italic*, [link text](https://&hellip;)';

/* Dispose the previous editor's timers/listeners when a new editor
   wires up — the SPA swaps page content without a teardown hook. */
function claimEditorLifecycle(dispose) {
  if (typeof McgheeLab._editorDispose === 'function') {
    try { McgheeLab._editorDispose(); } catch (e) { /* noop */ }
  }
  McgheeLab._editorDispose = dispose || null;
}

/* Draft autosave + tab-close guard. `canAutosave` must return false
   whenever an automatic save could change the doc's public visibility —
   pending/published docs are never autosaved. */
function createEditorAutosave({ canAutosave, doSave, intervalMs = 30000 }) {
  let dirty = false;
  const unloadHandler = (e) => {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = '';
  };
  window.addEventListener('beforeunload', unloadHandler);
  const timer = setInterval(async () => {
    if (!dirty || !canAutosave()) return;
    dirty = false;
    try { await doSave(); }
    catch (err) { dirty = true; console.warn('Autosave failed:', err); }
  }, intervalMs);
  const api = {
    markDirty() { dirty = true; },
    markClean() { dirty = false; },
    isDirty()   { return dirty; },
    dispose() {
      clearInterval(timer);
      window.removeEventListener('beforeunload', unloadHandler);
    }
  };
  claimEditorLifecycle(api.dispose);
  return api;
}

/* Banner shown in the editor when an admin requested changes */
function reviewNoteBannerHTML(note) {
  return `<div class="review-note-banner"><strong>${ICON.svg('pencil')} Changes requested:</strong> ${escapeHTML(note)}</div>`;
}

/* Preview using the SAME card builder the public feed uses (exported
   by app.js), so preview === published appearance. */
function showEditorPreview({ bodyEl, modalEl, data, builder }) {
  const build = McgheeLab[builder];
  bodyEl.innerHTML = '';
  if (typeof build === 'function') {
    const fake = { ...data, publishedAt: { toDate: () => new Date() } };
    const card = build(fake);
    card.classList.add('preview-card');
    bodyEl.appendChild(card);
    // Auto-expand "Read more" so the whole piece is visible.
    const toggle = card.querySelector('.expand-toggle');
    if (toggle) toggle.click();
  } else {
    bodyEl.innerHTML = '<p class="hint">Preview unavailable.</p>';
  }
  modalEl.hidden = false;
}


/* Section-block engine shared by both editors (V3.302 dedup): move /
   remove controls, image/video upload to `${basePath}/section_{sid}`
   (webp set for images, raw mp4/webm ≤50MB for video), 3D-viz picks
   (V3.301), restore from an existing doc, and collection back into the
   doc's sections[]. Blocks are keyed by their data-section-id so media
   maps survive reorders. */
function setupSectionEditor({ container, basePath, autosave }) {
  const sectionImages = {}; // sectionId → { thumb, medium, full }
  const sectionVideos = {}; // sectionId → URL string
  const sectionViz = {};    // sectionId → { vizId, viewId, name, file, poster, config }

  function renumber() {
    container.querySelectorAll('.section-label').forEach((lbl, i) => {
      lbl.textContent = `Section ${i + 1}`;
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
    zone.innerHTML = `<p class="upload-hint">${isVideo ? 'Uploading video' : 'Processing'}…</p>`;

    try {
      const sectionPath = `${basePath}/section_${sid}`;
      if (isVideo) {
        const ext = file.type === 'video/mp4' ? 'mp4' : 'webm';
        const ref = McgheeLab.storage.ref().child(`${sectionPath}/video.${ext}`);
        await ref.put(file, { contentType: file.type });
        const url = await ref.getDownloadURL();
        sectionVideos[sid] = url;
        delete sectionImages[sid]; // clear image if replacing
        delete sectionViz[sid];    // clear 3D view if replacing
        zone.innerHTML = `<video src="${escapeHTML(url)}" controls playsinline preload="metadata" class="section-video-preview"></video>`;
      } else {
        const blobs = await processImage(file);
        const urls = await uploadImageSet(blobs, sectionPath);
        sectionImages[sid] = urls;
        delete sectionVideos[sid]; // clear video if replacing
        delete sectionViz[sid];    // clear 3D view if replacing
        zone.innerHTML = `<img src="${escapeHTML(urls.medium)}" alt="Section image" class="section-img-preview">`;
      }
      autosave.markDirty();
    } catch (err) {
      zone.innerHTML = `<p class="error-text">Upload failed: ${escapeHTML(err.message)}</p>`;
    }
    prog.hidden = true;
  }

  function wireSectionBlock(block) {
    block.querySelector('[data-move="up"]')?.addEventListener('click', () => {
      const prev = block.previousElementSibling;
      if (prev) { container.insertBefore(block, prev); renumber(); autosave.markDirty(); }
    });
    block.querySelector('[data-move="down"]')?.addEventListener('click', () => {
      const next = block.nextElementSibling;
      if (next) { container.insertBefore(next, block); renumber(); autosave.markDirty(); }
    });
    block.querySelector('[data-remove]')?.addEventListener('click', () => {
      if (container.children.length > 1) { block.remove(); renumber(); autosave.markDirty(); }
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
      e.target.value = '';
    });
    // V3.301 — pick a saved 3D view as this section's media (replaces image/video)
    block.querySelector('.section-viz-btn')?.addEventListener('click', () => {
      openVizPicker(view => {
        const sid = block.dataset.sectionId;
        sectionViz[sid] = {
          vizId: view.vizId, viewId: view.id, name: view.name || '',
          file: view.file || 'viewer3d.html',
          poster: view.poster || null, config: view.config || null
        };
        delete sectionImages[sid];
        delete sectionVideos[sid];
        zone.innerHTML = vizZonePreviewHTML(sectionViz[sid]);
        autosave.markDirty();
      });
    });
  }

  function addSection() {
    container.insertAdjacentHTML('beforeend', sectionBlockHTML());
    wireSectionBlock(container.lastElementChild);
    autosave.markDirty();
    return container.lastElementChild;
  }

  /* Rebuild blocks from an existing doc's sections[]. */
  function restoreSections(sections) {
    (sections || []).forEach(sec => {
      container.insertAdjacentHTML('beforeend', sectionBlockHTML({
        text: sec.text,
        imageUrl: sec.image?.medium || sec.image?.full || '',
        videoUrl: sec.video || '',
        viz: sec.viz || null,
        imageAlt: sec.imageAlt || ''
      }));
      const sid = container.lastElementChild.dataset.sectionId;
      if (sec.image) sectionImages[sid] = sec.image;
      if (sec.video) sectionVideos[sid] = sec.video;
      if (sec.viz) sectionViz[sid] = sec.viz;
    });
  }

  /* Ensure ≥1 block exists, then wire everything present.
     Call once, after restoreSections(). */
  function init() {
    if (!container.children.length) {
      container.insertAdjacentHTML('beforeend', sectionBlockHTML());
    }
    container.querySelectorAll('.section-block').forEach(wireSectionBlock);
  }

  function collectSections() {
    const sections = [];
    container.querySelectorAll('.section-block').forEach(block => {
      const sid = block.dataset.sectionId;
      sections.push({
        text: block.querySelector('.section-text').value.trim(),
        image: sectionImages[sid] || null,
        video: sectionVideos[sid] || null,
        viz: sectionViz[sid] || null,
        imageAlt: block.querySelector('.section-image-alt').value.trim(),
        order: sections.length
      });
    });
    return sections;
  }

  return { init, addSection, restoreSections, collectSections };
}

/* Mentor + contributor pickers shared by both editors (V3.302 dedup):
   populates the selects from registered users and returns collect /
   restore helpers around the shared contributors list. */
async function setupTeamPicker({ mentorSelect, contribSelect, chipsEl, addBtn, authorField, autosave }) {
  autosave = autosave || { markDirty() {} }; // optional — the project editor has no autosave
  const selectedContributors = []; // { uid, name, photo }
  if (authorField) authorField.value = Auth.currentProfile?.name || Auth.currentUser.email;

  const allUsers = await DB.getAllUsers().catch(() => []);
  allUsers.forEach(u => {
    const makeOpt = (sel) => {
      const o = document.createElement('option');
      o.value = u.id;
      o.textContent = u.name || u.email || u.id;
      o.dataset.name = u.name || '';
      o.dataset.photo = JSON.stringify(u.photo || '');
      sel.appendChild(o);
    };
    if (mentorSelect) makeOpt(mentorSelect);
    if (contribSelect && u.id !== Auth.currentUser.uid) makeOpt(contribSelect);
  });

  function renderChips() {
    if (!chipsEl) return;
    chipsEl.innerHTML = selectedContributors.map((c, i) =>
      `<span class="contributor-chip">${escapeHTML(c.name || c.uid)}
        <button type="button" class="chip-remove" data-idx="${i}">&times;</button>
      </span>`
    ).join('');
    chipsEl.querySelectorAll('.chip-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedContributors.splice(Number(btn.dataset.idx), 1);
        renderChips();
        autosave.markDirty();
      });
    });
  }

  addBtn?.addEventListener('click', () => {
    if (!contribSelect?.value) return;
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
    autosave.markDirty();
  });

  function collectTeam() {
    const mentorOpt = mentorSelect?.options[mentorSelect.selectedIndex];
    let mentorPhoto = '';
    if (mentorSelect?.value) {
      try { mentorPhoto = JSON.parse(mentorOpt?.dataset?.photo || '""'); } catch { mentorPhoto = mentorOpt?.dataset?.photo || ''; }
    }
    return {
      author: {
        uid: Auth.currentUser.uid,
        name: Auth.currentProfile?.name || '',
        photo: Auth.currentProfile?.photo || ''
      },
      contributors: selectedContributors.map(c => ({
        uid: c.uid, name: c.name, photo: c.photo || ''
      })),
      mentor: mentorSelect?.value ? {
        uid: mentorSelect.value,
        name: mentorOpt?.dataset?.name || mentorOpt?.textContent || '',
        photo: mentorPhoto
      } : null
    };
  }

  function restore(team) {
    if (!team) return;
    if (team.mentor?.uid && mentorSelect) mentorSelect.value = team.mentor.uid;
    if (Array.isArray(team.contributors)) {
      team.contributors.forEach(c => selectedContributors.push(c));
      renderChips();
    }
  }

  return { collectTeam, restore, selectedContributors };
}

/* ================================================================
   RENDER: STORY EDITOR
   ================================================================ */
let _sectionCounter = 0;
let _refCounter = 0;

function renderStoryEditor(storyId) {
  if (!Auth.currentUser) { window.location.hash = '#/login'; return authLoadingHTML('Redirecting\u2026'); }
  const isNew = storyId === 'new';

  return `
    <div class="story-editor-page">
      <div class="editor-header">
        <button class="btn btn-secondary" id="editor-back-btn">&larr; Back</button>
        <h2>${isNew ? 'New Story' : 'Edit Story'}</h2>
        <a href="#/guide" class="btn btn-secondary btn-small" style="margin-left:auto">Help</a>
      </div>

      <form id="story-form" class="story-form">
        <div id="editor-review-banner" hidden></div>
        <div class="form-group">
          <label for="story-title">Story Title</label>
          <input type="text" id="story-title" required placeholder="Give your story a title">
        </div>
        <div class="form-group">
          <label for="story-project">Project <span class="hint">(required)</span></label>
          <select id="story-project" required>
            <option value="">-- Select a project --</option>
            <option value="__propose__">&#9998; Propose a new project&hellip;</option>
          </select>
          <div id="story-propose-wrap" class="propose-project-wrap" hidden>
            <input type="text" id="story-proposed-project" placeholder="Proposed project name">
            <p class="hint">No matching project yet? Name one here — an admin creates it when your story is approved.</p>
          </div>
        </div>
        <div class="form-group">
          <label for="story-description">Brief Description</label>
          <textarea id="story-description" rows="2" placeholder="One-line summary"></textarea>
        </div>
        <div class="form-group">
          <label for="story-publish-date">Publish Date <span class="hint">(optional — defaults to now)</span></label>
          <input type="date" id="story-publish-date">
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

/* V3.301 \u2014 media-zone preview for a picked 3D visualization view */
function vizZonePreviewHTML(viz) {
  const poster = viz?.poster?.medium || viz?.poster?.thumb || viz?.poster?.full || '';
  return `${poster ? `<img src="${escapeHTML(poster)}" alt="3D view poster" class="section-img-preview">` : ''}
    <span class="badge viz-section-badge">${ICON.svg('cube-transparent')} 3D view: ${escapeHTML(viz?.name || 'Untitled')}</span>`;
}

function sectionBlockHTML(data) {
  const id = _sectionCounter++;
  let mediaPreview;
  if (data?.viz) {
    mediaPreview = vizZonePreviewHTML(data.viz);
  } else if (data?.videoUrl) {
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
        <p class="hint rt-hint">${RICH_TEXT_HINT}</p>
      </div>
      <div class="section-media-area">
        <div class="media-upload-zone" data-zone="${id}">
          ${mediaPreview}
        </div>
        <input type="file" class="section-media-input" accept="image/*,video/mp4,video/webm" hidden data-zone="${id}">
        <button type="button" class="btn btn-secondary btn-small section-viz-btn" data-zone="${id}">${ICON.svg('cube-transparent')} Embed 3D visualization</button>
        <input type="text" class="section-image-alt" placeholder="Image/video description (alt text)"
          value="${escapeHTML(data?.imageAlt || '')}">
        <div class="media-progress" hidden>Uploading\u2026</div>
      </div>
    </div>`;
}

/* V3.301 \u2014 saved-view picker modal shared by the story and news editors.
   Lists all saved views (Firestore `vizViews`) grouped by visualization
   (DataIllustrations/manifest.json). cb(view) receives the chosen view doc
   augmented with the viz `file` + `title` from the manifest. */
async function openVizPicker(cb) {
  let manifest = [];
  let views = [];
  try {
    const res = await fetch('DataIllustrations/manifest.json', { cache: 'no-cache' });
    if (res.ok) manifest = (await res.json()).visualizations || [];
  } catch (e) { console.warn('Viz manifest error:', e); }
  try { views = await DB.getAllVizViews(); } catch (e) { console.warn('Viz views error:', e); }

  const overlay = document.createElement('div');
  overlay.className = 'modal viz-picker-modal';
  const groups = manifest.map(viz => {
    const vizViews = views.filter(v => v.vizId === viz.id);
    if (!vizViews.length) return '';
    return `
      <div class="viz-picker-group">
        <h4>${escapeHTML(viz.title || viz.id)}</h4>
        <div class="viz-picker-grid">
          ${vizViews.map(v => `
            <button type="button" class="viz-picker-tile" data-view-id="${escapeHTML(v.id)}">
              ${v.poster?.thumb || v.poster?.medium
                ? `<img src="${escapeHTML(v.poster.thumb || v.poster.medium)}" alt="${escapeHTML(v.name || '')}">`
                : '<span class="viz-picker-tile-placeholder">' + ICON.svg('cube-transparent') + '</span>'}
              <span class="viz-picker-tile-name">${escapeHTML(v.name || 'Untitled')}</span>
            </button>`).join('')}
        </div>
      </div>`;
  }).join('');
  overlay.innerHTML = `
    <div class="modal-content viz-picker-content">
      <div class="modal-header">
        <h3>Embed a 3D visualization view</h3>
        <button type="button" class="btn btn-secondary btn-small" data-close-picker>&times; Close</button>
      </div>
      <div class="viz-picker-body">
        ${groups || `<p class="upload-hint">No saved views yet. Open a visualization under
          <a href="#/data" target="_blank">Data Visualizations</a>, arrange the view, and click "Save view" first.</p>`}
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('[data-close-picker]').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelectorAll('.viz-picker-tile').forEach(tile => {
    tile.addEventListener('click', () => {
      const view = views.find(v => v.id === tile.dataset.viewId);
      if (!view) return;
      const viz = manifest.find(m => m.id === view.vizId);
      close();
      cb({ ...view, file: viz?.file || 'viewer3d.html', vizTitle: viz?.title || '' });
    });
  });
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

  // V3.302 — doc id is minted up front so media uploads land at the
  // real Storage path (no orphaned draft_* folders), and the first
  // autosave targets the same doc every subsequent save uses.
  const docId = storyId !== 'new' ? storyId : DB.newDocId('stories');
  let docCreated = storyId !== 'new';

  // V3.302 — draft autosave (30s) + tab-close guard. Never fires for
  // pending/published docs, so an autosave can't unpublish anything.
  const autosave = createEditorAutosave({
    canAutosave: () => {
      const title = document.getElementById('story-title')?.value?.trim();
      const st = existing?.status;
      return !!title && (!st || st === 'draft' || st === 'changes-requested');
    },
    doSave: () => saveStory(existing?.status === 'changes-requested' ? 'changes-requested' : 'draft', { auto: true })
  });
  form.addEventListener('input', () => autosave.markDirty());

  // Back button
  document.getElementById('editor-back-btn')?.addEventListener('click', () => {
    window.location.hash = '#/dashboard';
  });

  // Shared section-block engine + team pickers (V3.302 dedup)
  const sections = setupSectionEditor({ container, basePath: `stories/${docId}`, autosave });
  const team = await setupTeamPicker({
    mentorSelect: document.getElementById('story-mentor'),
    contribSelect: document.getElementById('story-contributor-select'),
    chipsEl: document.getElementById('contributor-chips'),
    addBtn: document.getElementById('add-contributor-btn'),
    authorField: document.getElementById('story-author-name'),
    autosave
  });

  // Populate project dropdown from published Firestore projects. The
  // "__propose__" option (V3.302) reveals a free-text field so students
  // aren't blocked when no matching project exists yet.
  const projectSelect = document.getElementById('story-project');
  const proposeOpt = projectSelect.querySelector('option[value="__propose__"]');
  const proposeWrap = document.getElementById('story-propose-wrap');
  const proposeInput = document.getElementById('story-proposed-project');
  let allProjects = [];
  try {
    allProjects = await DB.getPublishedProjects();
    allProjects.forEach(p => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.title || 'Untitled Project';
      o.dataset.title = p.title || '';
      if (proposeOpt) projectSelect.insertBefore(o, proposeOpt);
      else projectSelect.appendChild(o);
    });
  } catch (e) { console.warn('Failed to load projects for dropdown:', e); }
  projectSelect.addEventListener('change', () => {
    if (!proposeWrap) return;
    proposeWrap.hidden = projectSelect.value !== '__propose__';
    if (!proposeWrap.hidden) proposeInput?.focus();
  });

  // References container (story-only)
  const refsContainer = document.getElementById('refs-container');

  function wireRefBlock(block) {
    block.querySelector('[data-remove-ref]').addEventListener('click', () => {
      block.remove();
      autosave.markDirty();
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
      else if (existing.proposedProjectTitle && proposeWrap) {
        // V3.302 — restore an in-flight project proposal
        projectSelect.value = '__propose__';
        proposeWrap.hidden = false;
        proposeInput.value = existing.proposedProjectTitle;
      }
      else if (existing.project) {
        // Legacy: try to match old free-text project to a Firestore project
        const match = allProjects.find(p => p.title === existing.project);
        if (match) projectSelect.value = match.id;
      }
      document.getElementById('story-description').value = existing.description || '';
      if (existing.publishedAt?.toDate) {
        const d = existing.publishedAt.toDate();
        document.getElementById('story-publish-date').value = d.toISOString().slice(0, 10);
      }

      team.restore(existing.team);

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

      sections.restoreSections(existing.sections);

      // V3.302 — surface the admin's review note to the author
      if (existing.status === 'changes-requested' && existing.reviewNote) {
        const banner = document.getElementById('editor-review-banner');
        if (banner) { banner.innerHTML = reviewNoteBannerHTML(existing.reviewNote); banner.hidden = false; }
      }
    }
  }

  // Ensure at least one section + wire all blocks
  sections.init();

  // Add section
  document.getElementById('add-section-btn').addEventListener('click', () => {
    const block = sections.addSection();
    block.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  function collectData(status) {
    // Build references object grouped by type (story-only)
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

    // V3.302 — a proposed project ships as free text; the admin (or a
    // publishing editor) converts it into a real projectPackage later.
    const proposing = projectSelect.value === '__propose__';
    const projOpt = projectSelect.options[projectSelect.selectedIndex];

    return {
      id: docId,
      title: document.getElementById('story-title').value,
      projectId: proposing ? null : (projectSelect.value || null),
      projectTitle: proposing ? '' : (projOpt?.dataset?.title || (projectSelect.value ? projOpt?.textContent : '') || ''),
      proposedProjectTitle: proposing ? (proposeInput?.value.trim() || '') : null,
      description: document.getElementById('story-description').value,
      authorUid: Auth.currentUser.uid,
      authorName: Auth.currentProfile?.name || '',
      sections: sections.collectSections(),
      team: team.collectTeam(),
      references,
      status
    };
  }

  async function saveStory(status, opts = {}) {
    const st = document.getElementById('editor-status');
    if (!opts.auto) st.hidden = true;
    try {
      // V3.302 — an editor/admin publishing with a proposed project gets
      // the project created + linked right now (no admin review follows).
      if (status === 'published' && projectSelect.value === '__propose__') {
        const title = proposeInput?.value.trim();
        if (!title) throw new Error('Name your proposed project first.');
        const pid = await DB.saveProject({
          title, status: 'published', description: '',
          authorUid: Auth.currentUser.uid, order: 9999, storyIds: []
        });
        const o = document.createElement('option');
        o.value = pid; o.textContent = title; o.dataset.title = title;
        if (proposeOpt) projectSelect.insertBefore(o, proposeOpt);
        else projectSelect.appendChild(o);
        projectSelect.value = pid;
        if (proposeWrap) proposeWrap.hidden = true;
      }
      if (status === 'pending' && projectSelect.value === '__propose__' && !proposeInput?.value.trim()) {
        throw new Error('Name your proposed project first.');
      }

      const data = collectData(status);
      if (!docCreated) data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      if (status === 'published') {
        const customDate = document.getElementById('story-publish-date').value;
        data.publishedAt = customDate
          ? firebase.firestore.Timestamp.fromDate(new Date(customDate + 'T12:00:00'))
          : firebase.firestore.FieldValue.serverTimestamp();
      }
      const id = await DB.saveStory(data);
      docCreated = true;
      autosave.markClean();
      st.textContent = opts.auto ? 'Draft autosaved ✓'
        : status === 'draft' ? 'Draft saved!'
        : (Auth.canPublish() ? 'Published!' : 'Submitted for review!');
      st.className = 'form-status success'; st.hidden = false;
      if (opts.auto) setTimeout(() => { st.hidden = true; }, 2500);
      existing = { ...existing, ...data, id };
      // Update URL without triggering a re-render so the page stays in place
      if (window.location.hash !== `#/dashboard/story/${id}`) {
        history.replaceState(null, '', `#/dashboard/story/${id}`);
      }
    } catch (err) {
      st.textContent = 'Error: ' + err.message;
      st.className = 'form-status error'; st.hidden = false;
      if (opts.auto) throw err; // keep the autosave dirty flag set
    }
  }

  // Save draft
  document.getElementById('save-draft-btn').addEventListener('click', () => saveStory('draft'));

  // Publish / submit
  form.addEventListener('submit', e => {
    e.preventDefault();
    saveStory(Auth.canPublish() ? 'published' : 'pending');
  });

  // Preview — V3.302: renders the exact card the public research feed
  // uses (via McgheeLab.buildStoryFeedCard from app.js), so what the
  // author sees is what publishes.
  document.getElementById('preview-btn').addEventListener('click', () => {
    showEditorPreview({
      bodyEl: document.getElementById('story-preview-body'),
      modalEl: document.getElementById('story-preview-modal'),
      data: collectData(existing?.status || 'draft'),
      builder: 'buildStoryFeedCard'
    });
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

/* V3.302 dedup — news sections now use the shared sectionBlockHTML. */
function renderNewsEditor(postId) {
  if (!Auth.currentUser) { window.location.hash = '#/login'; return authLoadingHTML('Redirecting\u2026'); }
  const isNew = postId === 'new';

  return `
    <div class="story-editor-page">
      <div class="editor-header">
        <button class="btn btn-secondary" id="news-editor-back-btn">&larr; Back</button>
        <h2>${isNew ? 'New News Post' : 'Edit News Post'}</h2>
      </div>

      <form id="news-form" class="story-form">
        <div id="editor-review-banner" hidden></div>
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
          <label for="news-publish-date">Publish Date <span class="hint">(optional — defaults to now)</span></label>
          <input type="date" id="news-publish-date">
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

        <h3>Team</h3>
        <p class="hint">Tag the people involved in this post. You are automatically listed as author.</p>
        <div class="team-fields">
          <div class="form-group">
            <label>Author</label>
            <input type="text" id="news-author-name" readonly class="team-readonly">
          </div>
          <div class="form-group">
            <label for="news-mentor">Mentor</label>
            <select id="news-mentor">
              <option value="">— Select mentor —</option>
            </select>
          </div>
          <div class="form-group">
            <label>Contributors</label>
            <div class="contributor-select-row">
              <select id="news-contributor-select">
                <option value="">— Add contributor —</option>
              </select>
              <button type="button" id="news-add-contributor-btn" class="btn btn-secondary btn-small">Add</button>
            </div>
            <div id="news-contributor-chips" class="contributor-chips"></div>
          </div>
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

  _sectionCounter = 0;
  let existing = null;
  let coverImageUrls = null;

  // V3.302 — doc id minted up front (real Storage paths + stable
  // autosave target), same pattern as the story editor.
  const docId = postId !== 'new' ? postId : DB.newDocId('newsPosts');
  let docCreated = postId !== 'new';

  // V3.302 — draft autosave (30s) + tab-close guard; never fires for
  // pending/published posts.
  const autosave = createEditorAutosave({
    canAutosave: () => {
      const title = document.getElementById('news-title')?.value?.trim();
      const st = existing?.status;
      return !!title && (!st || st === 'draft' || st === 'changes-requested');
    },
    doSave: () => savePost(existing?.status === 'changes-requested' ? 'changes-requested' : 'draft', { auto: true })
  });
  form.addEventListener('input', () => autosave.markDirty());

  // Back button
  document.getElementById('news-editor-back-btn')?.addEventListener('click', () => {
    window.location.hash = '#/dashboard';
  });

  // Shared section-block engine + team pickers (V3.302 dedup)
  const sections = setupSectionEditor({ container, basePath: `news/${docId}`, autosave });
  const team = await setupTeamPicker({
    mentorSelect: document.getElementById('news-mentor'),
    contribSelect: document.getElementById('news-contributor-select'),
    chipsEl: document.getElementById('news-contributor-chips'),
    addBtn: document.getElementById('news-add-contributor-btn'),
    authorField: document.getElementById('news-author-name'),
    autosave
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
      if (existing.publishedAt?.toDate) {
        const d = existing.publishedAt.toDate();
        document.getElementById('news-publish-date').value = d.toISOString().slice(0, 10);
      }

      sections.restoreSections(existing.sections);

      if (existing.coverImage) {
        coverImageUrls = existing.coverImage;
        const preview = document.getElementById('news-cover-preview');
        if (preview && existing.coverImage.medium) {
          preview.innerHTML = `<img src="${escapeHTML(existing.coverImage.medium)}" alt="Cover preview">`;
        }
      }

      team.restore(existing.team);

      // V3.302 — surface the admin's review note to the author
      if (existing.status === 'changes-requested' && existing.reviewNote) {
        const banner = document.getElementById('editor-review-banner');
        if (banner) { banner.innerHTML = reviewNoteBannerHTML(existing.reviewNote); banner.hidden = false; }
      }
    }
  }

  // Ensure at least one section + wire all blocks
  sections.init();

  // Add section
  document.getElementById('news-add-section-btn').addEventListener('click', () => {
    sections.addSection();
  });

  // Cover image upload (news-only)
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
    coverProgress.textContent = 'Processing image…'; coverProgress.hidden = false;
    try {
      const blobs = await processImage(file);
      const urls = await uploadImageSet(blobs, `news/${docId}/cover`);
      coverImageUrls = urls;
      coverPreview.innerHTML = `<img src="${escapeHTML(urls.medium)}" alt="Cover preview">`;
      coverProgress.hidden = true;
      autosave.markDirty();
    } catch (err) {
      coverProgress.textContent = 'Upload failed: ' + err.message; coverProgress.hidden = false;
    }
  }

  // Collect form data
  function collectData(status) {
    return {
      id: docId,
      title: document.getElementById('news-title').value.trim(),
      category: document.getElementById('news-category').value,
      description: document.getElementById('news-description').value.trim(),
      coverImage: coverImageUrls,
      sections: sections.collectSections(),
      team: team.collectTeam(),
      authorUid: Auth.currentUser.uid,
      authorName: Auth.currentProfile?.name || Auth.currentUser.email,
      authorPhoto: Auth.currentProfile?.photo || null,
      status
    };
  }

  async function savePost(status, opts = {}) {
    const st = document.getElementById('news-editor-status');
    if (!opts.auto) st.hidden = true;
    try {
      const data = collectData(status);
      if (!docCreated) data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      if (status === 'published') {
        const customDate = document.getElementById('news-publish-date').value;
        data.publishedAt = customDate
          ? firebase.firestore.Timestamp.fromDate(new Date(customDate + 'T12:00:00'))
          : firebase.firestore.FieldValue.serverTimestamp();
      }
      const id = await DB.saveNewsPost(data);
      docCreated = true;
      autosave.markClean();
      st.textContent = opts.auto ? 'Draft autosaved ✓'
        : status === 'draft' ? 'Draft saved!'
        : (Auth.canPublish() ? 'Published!' : 'Submitted for review!');
      st.className = 'form-status success'; st.hidden = false;
      if (opts.auto) setTimeout(() => { st.hidden = true; }, 2500);
      existing = { ...existing, ...data, id };
      if (window.location.hash !== `#/dashboard/news/${id}`) {
        history.replaceState(null, '', `#/dashboard/news/${id}`);
      }
    } catch (err) {
      st.textContent = 'Error: ' + err.message;
      st.className = 'form-status error'; st.hidden = false;
      if (opts.auto) throw err; // keep the autosave dirty flag set
    }
  }

  // Save draft
  document.getElementById('news-save-draft-btn').addEventListener('click', () => savePost('draft'));

  // Publish / submit
  form.addEventListener('submit', e => {
    e.preventDefault();
    savePost(Auth.canPublish() ? 'published' : 'pending');
  });

  // Preview — V3.302: renders the exact card the public news feed uses
  // (via McgheeLab.buildNewsFeedCard from app.js).
  document.getElementById('news-preview-btn').addEventListener('click', () => {
    showEditorPreview({
      bodyEl: document.getElementById('news-preview-body'),
      modalEl: document.getElementById('news-preview-modal'),
      data: collectData(existing?.status || 'draft'),
      builder: 'buildNewsFeedCard'
    });
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
          <span class="status-badge status-${p.status || 'draft'}">${(p.status || 'draft').replace('-', ' ')}</span>
          ${p.status === 'changes-requested' && p.reviewNote
            ? `<p class="review-note">${ICON.svg('pencil')} ${escapeHTML(p.reviewNote)}</p>` : ''}
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
  if (!Auth.currentUser) { window.location.hash = '#/login'; return authLoadingHTML('Redirecting\u2026'); }
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

  // V3.348: signed-in lab members can auto-fill the picker from their
  // RM availability (painted weekly schedule + week overrides + custom
  // events). Direct Firestore reads — the collections allow any-auth
  // read, and ScheduleService's week-scoped subscription can't cover a
  // multi-week scheduler. Calendar busy times aren't available on the
  // public page (no CalendarService/OAuth here); the painted schedule
  // already reflects them for members who maintain it in RM.
  async function fetchMyAvailabilityData(dates) {
    const uid = Auth.currentUser?.uid;
    if (!uid) return { templateBlocks: [], overrides: [], customEvents: [], calendarBusy: [] };
    const db = McgheeLab.db || firebase.firestore();
    const dateSet = new Set(dates);
    const [tmplDoc, ovSnap, ceSnap] = await Promise.all([
      db.collection('huddleScheduleTemplates').doc(uid).get(),
      db.collection('huddleScheduleOverrides').where('ownerUid', '==', uid).get(),
      db.collection('scheduleCustomEvents').where('ownerUid', '==', uid).get(),
    ]);
    return {
      templateBlocks: tmplDoc.exists ? (tmplDoc.data().blocks || []) : [],
      overrides: ovSnap.docs.map(d => Object.assign({ id: d.id }, d.data())).filter(o => dateSet.has(o.date)),
      customEvents: ceSnap.docs.map(d => Object.assign({ id: d.id }, d.data())),
      calendarBusy: [],
    };
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
      // Only offer auto-fill to signed-in users (external guests have no
      // RM availability to read).
      getAvailabilityData: Auth.currentUser ? fetchMyAvailabilityData : null,
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

  // Auth often restores a beat after the first render — re-render once
  // when the user appears so the auto-fill button shows up (V3.348).
  if (!Auth.currentUser && Auth.onChange) {
    const onAuthReady = (user) => {
      Auth.offChange(onAuthReady);
      if (!user) return;
      // Bail if the user navigated away from this schedule page.
      if (!document.getElementById('schedule-page-content')) return;
      container.innerHTML = Sched.render(buildConfig());
      Sched.wire('schedule-page-content', buildConfig());
    };
    Auth.onChange(onAuthReady);
  }
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
      <!-- V3.673 \u2014 engagement hub cross-link: researchers and outreach-minded
           folks land here looking for ways to get involved. -->
      <div class="opportunity-card">
        <div class="opp-type-badge">Outreach</div>
        <h3>Visit a classroom</h3>
        <p>High-school teachers using our modules open their classrooms for guest talks,
           demos, lab tours, and career chats. Researchers can browse availability and
           request a visit on the engagement hub.</p>
        <p><a class="btn" href="#/engage">Open the engagement hub &rarr;</a></p>
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
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Category</th><th>Chat</th><th></th></tr></thead>
        <tbody>
          ${users.map(u => {
            const guest = u.role === 'guest';
            const chatEnabled = guest ? (u.chatAccess === true) : true;
            // V3.265 \u2014 Cason-was-demoted fix. This page's `ROLES` map only
            // has 4 entries (admin / editor / contributor / guest), but
            // RM's admin-permissions page writes roles from a 10-entry
            // taxonomy (admin / pi / postdoc / phd / masters / undergrad /
            // staff / collaborator / member / guest). When a user's role
            // was set via RM to something this dropdown doesn't recognise
            // (e.g. `phd`), no <option> got `selected`, the browser fell
            // back to displaying the first option, and the next Save
            // silently overwrote the role with that wrong value. Fix:
            // if u.role isn't a known key, prepend a sticky "Unknown: X
            // (keep as is)" option that's `selected` so Save round-trips
            // the stored value. The save handler additionally skips
            // writing `role` when roleSel.value === u.role.
            const knownRole = Object.prototype.hasOwnProperty.call(ROLES, u.role || '');
            const unknownOption = knownRole
              ? ''
              : `<option value="${escapeHTML(u.role || '')}" selected>Unknown: ${escapeHTML(u.role || '(unset)')} \u2014 keep as is</option>`;
            const knownTag = knownRole
              ? ''
              : ` <span class="admin-guest-badge" title="Stored role isn't in this page's taxonomy \u2014 managed in RM Admin Permissions">${escapeHTML(u.role || '?')}</span>`;
            return `
            <tr class="${guest ? 'admin-guest-row' : ''}">
              <td>${escapeHTML(u.name || '\u2014')}${guest ? ' <span class="admin-guest-badge">Guest</span>' : ''}${knownTag}</td>
              <td>${escapeHTML(u.email || '\u2014')}</td>
              <td>
                <select data-uid="${u.id}" class="role-select">
                  ${unknownOption}
                  ${Object.entries(ROLES).map(([k, v]) =>
                    `<option value="${k}" ${knownRole && u.role === k ? 'selected' : ''}>${v.label}</option>`
                  ).join('')}
                </select>
              </td>
              <td>
                <select data-cat-uid="${u.id}" class="category-select">
                  ${categoryOptions(u.category)}
                </select>
              </td>
              <td>
                ${guest
                  ? `<label class="admin-chat-toggle"><input type="checkbox" data-chat-uid="${u.id}" ${chatEnabled ? 'checked' : ''} /> <span class="admin-chat-label">${chatEnabled ? 'On' : 'Off'}</span></label>`
                  : '<span class="hint">Auto</span>'
                }
              </td>
              <td>
                <button class="btn btn-secondary btn-small" data-edit-user="${u.id}">Edit</button>
                <button class="btn btn-secondary btn-small" data-save-user="${u.id}">Save</button>
                <button class="btn btn-danger btn-small" data-delete-user="${u.id}">Delete</button>
              </td>
            </tr>
            <tr class="admin-edit-row" data-edit-row="${u.id}" hidden>
              <td colspan="6">
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
                  </div>
                  <div class="admin-edit-section">
                    <label>Prior Category</label>
                    <select data-prior-uid="${u.id}" class="category-select">
                      <option value="">— auto (set when flipped to Alumni) —</option>
                      ${ALUMNI_PRIOR_CATEGORIES.map(c =>
                        `<option value="${c.value}" ${u.priorCategory === c.value ? 'selected' : ''}>${c.label}</option>`
                      ).join('')}
                    </select>
                    <p class="hint">Groups this person on the team page once they're Alumni.</p>
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
        const chatToggle = el.querySelector(`input[data-chat-uid="${uid}"]`);
        const user = users.find(u => u.id === uid);
        const updates = { category: catSel.value };
        // V3.265 — only write `role` when the admin actually changed it.
        // Previously this handler unconditionally wrote `roleSel.value`,
        // which clobbered RM-set roles (phd / postdoc / etc.) the moment
        // anyone saved the row for an unrelated field. Now we compare to
        // the stored `user.role` and skip the write when unchanged. The
        // "Unknown: X — keep as is" option (prepended in the row render)
        // makes the dropdown's `.value` equal the stored role for any
        // out-of-taxonomy value, so Save round-trips cleanly.
        if (user && roleSel.value !== (user.role || '')) {
          updates.role = roleSel.value;
        }
        if (bioEl) updates.bio = bioEl.value;
        if (nameEl) updates.name = nameEl.value;
        if (githubEl) updates.github = githubEl.value;
        if (chatToggle) updates.chatAccess = chatToggle.checked;
        // V3.312 — explicit Prior Category dropdown (alumni grouping).
        // Only written when changed, so untouched rows round-trip cleanly.
        const priorSel = el.querySelector(`select[data-prior-uid="${uid}"]`);
        if (priorSel && user && priorSel.value !== (user.priorCategory || '')) {
          updates.priorCategory = priorSel.value;
        }
        // Store prior category when moving to alumni — the explicit
        // dropdown selection wins over this auto-stamp.
        if (catSel.value === 'alumni' && user && user.category !== 'alumni' && !(priorSel && priorSel.value)) {
          updates.priorCategory = user.category;
        }
        await DB.updateUser(uid, updates);
        btn.textContent = 'Saved!';
        setTimeout(() => { btn.textContent = 'Save'; loadUsers(); }, 1500);
      });
    });

    // Chat access toggle for guests — immediate save
    el.querySelectorAll('input[data-chat-uid]').forEach(toggle => {
      toggle.addEventListener('change', async () => {
        const uid = toggle.dataset.chatUid;
        const label = toggle.parentElement.querySelector('.admin-chat-label');
        if (label) label.textContent = toggle.checked ? 'On' : 'Off';
        await DB.updateUser(uid, { chatAccess: toggle.checked });
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
          ${s.proposedProjectTitle && !s.projectId
            ? `<span class="badge proposed-project-badge">${ICON.svg('light-bulb')} Proposed project: ${escapeHTML(s.proposedProjectTitle)}</span>` : ''}
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
          <button class="btn btn-primary btn-small" data-approve="${s.id}">
            ${s.proposedProjectTitle && !s.projectId ? 'Create project & approve' : 'Approve'}
          </button>
          <button class="btn btn-danger btn-small" data-reject="${s.id}">Request changes</button>
          <button class="btn btn-secondary btn-small" data-view-story="${s.id}">View Full</button>
        </div>
      </div>`).join('');

    el.querySelectorAll('[data-approve]').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const story = stories.find(s => s.id === btn.dataset.approve);
          const extra = { reviewNote: firebase.firestore.FieldValue.delete() };
          // V3.302 \u2014 a student-proposed project becomes real on approval
          if (story && !story.projectId && story.proposedProjectTitle) {
            const pid = await DB.saveProject({
              title: story.proposedProjectTitle, status: 'published',
              description: '', authorUid: Auth.currentUser.uid,
              order: 9999, storyIds: []
            });
            extra.projectId = pid;
            extra.projectTitle = story.proposedProjectTitle;
            extra.proposedProjectTitle = firebase.firestore.FieldValue.delete();
          }
          await DB.updateStoryStatus(btn.dataset.approve, 'published', extra);
        } catch (err) {
          alert('Approve failed: ' + err.message);
        }
        loadPending();
      });
    });
    // V3.302 \u2014 "Request changes" opens an inline note form; the note is
    // stored on the doc and shown to the author (dashboard + editor).
    el.querySelectorAll('[data-reject]').forEach(btn => {
      btn.addEventListener('click', () => {
        const card = btn.closest('.pending-card');
        let noteForm = card.querySelector('.reject-note-form');
        if (noteForm) { noteForm.hidden = !noteForm.hidden; return; }
        noteForm = document.createElement('div');
        noteForm.className = 'reject-note-form';
        noteForm.innerHTML = `
          <textarea rows="2" placeholder="What should the author change? They'll see this note."></textarea>
          <button type="button" class="btn btn-danger btn-small">Send back with note</button>`;
        card.appendChild(noteForm);
        noteForm.querySelector('textarea').focus();
        noteForm.querySelector('button').addEventListener('click', async () => {
          const note = noteForm.querySelector('textarea').value.trim();
          if (!note) { noteForm.querySelector('textarea').focus(); return; }
          await DB.updateStoryStatus(btn.dataset.reject, 'changes-requested', {
            reviewNote: note,
            reviewedAt: firebase.firestore.FieldValue.serverTimestamp()
          });
          loadPending();
        });
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
          <button class="btn btn-danger btn-small" data-reject-news="${p.id}">Request changes</button>
          <button class="btn btn-secondary btn-small" data-view-news="${p.id}">View Full</button>
        </div>
      </div>`).join('');

    el.querySelectorAll('[data-approve-news]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await DB.updateNewsStatus(btn.dataset.approveNews, 'published', {
          reviewNote: firebase.firestore.FieldValue.delete()
        });
        loadPendingNews();
      });
    });
    // V3.302 — "Request changes" with a note the author can act on
    el.querySelectorAll('[data-reject-news]').forEach(btn => {
      btn.addEventListener('click', () => {
        const card = btn.closest('.pending-card');
        let noteForm = card.querySelector('.reject-note-form');
        if (noteForm) { noteForm.hidden = !noteForm.hidden; return; }
        noteForm = document.createElement('div');
        noteForm.className = 'reject-note-form';
        noteForm.innerHTML = `
          <textarea rows="2" placeholder="What should the author change? They'll see this note."></textarea>
          <button type="button" class="btn btn-danger btn-small">Send back with note</button>`;
        card.appendChild(noteForm);
        noteForm.querySelector('textarea').focus();
        noteForm.querySelector('button').addEventListener('click', async () => {
          const note = noteForm.querySelector('textarea').value.trim();
          if (!note) { noteForm.querySelector('textarea').focus(); return; }
          await DB.updateNewsStatus(btn.dataset.rejectNews, 'changes-requested', {
            reviewNote: note,
            reviewedAt: firebase.firestore.FieldValue.serverTimestamp()
          });
          loadPendingNews();
        });
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
McgheeLab.authLoadingHTML  = authLoadingHTML;    // V3.332 — router auth-gate spinner
McgheeLab.friendlyAuthError = friendlyAuthError; // V3.332 — shared auth error copy
McgheeLab.ROLES            = ROLES;
McgheeLab.BADGE_DEFS       = BADGE_DEFS;
McgheeLab.processImage     = processImage;
McgheeLab.uploadImageSet   = uploadImageSet;
McgheeLab.openCropModal    = openCropModal;          // V3.304 — teacher-photo upload
McgheeLab.renderGuestProfileCard = renderGuestProfileCard; // V3.304 — shared by teacher/student dashboards
McgheeLab.wireGuestProfileCard   = wireGuestProfileCard;
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
McgheeLab.renderRichText   = renderRichText;   // V3.302 — markdown-lite

/* ================================================================
   SOCIAL: Reactions & Comments (called from app.js feed)
   ================================================================ */
/* V3.861 — a fixed set of five buttons, so they draw as monochrome icons like
 * the rest of the site. `key` is what Firestore stores (reactions.emoji) and is
 * unchanged; only the picture moved from a colour emoji to an icon. */
const REACTION_EMOJIS = [
  { key: 'thumbsup', icon: 'hand-thumb-up', label: 'Like' },
  { key: 'heart', icon: 'heart', label: 'Love' },
  { key: 'celebrate', icon: 'sparkles', label: 'Celebrate' },
  { key: 'insightful', icon: 'light-bulb', label: 'Insightful' },
  { key: 'fire', icon: 'fire', label: 'Fire' }
];
const reactionIcon = (e) => (window.ICON ? ICON.svg(e.icon) : escapeHTML(e.label));

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
  REACTION_EMOJIS.forEach(e => { emojiMap[e.key] = e.label; });

  // Only show emojis that have at least 1 reaction
  const activeEmojis = REACTION_EMOJIS.filter(e => counts[e.key] > 0);

  let html = activeEmojis.map(e => `
    <button type="button" class="reaction-btn ${userReacted[e.key] ? 'reacted' : ''}"
      data-emoji="${e.key}" data-story-id="${escapeHTML(storyId)}"
      ${!Auth.currentUser ? 'disabled title="Sign in to react"' : `title="${e.label}"`} aria-label="${e.label}">
      ${reactionIcon(e)} <span class="reaction-count">${counts[e.key]}</span>
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
            data-emoji="${e.key}" data-story-id="${escapeHTML(storyId)}" title="${e.label}" aria-label="${e.label}">
            ${reactionIcon(e)}
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

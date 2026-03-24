/* ================================================================
   My App — McGheeLab Lab App
   TODO: Replace this header with your app's name and description.
   ================================================================

   ARCHITECTURE OVERVIEW
   ---------------------
   This file is the entire app logic. It follows the pattern:

   1. IIFE wrapper — prevents global pollution
   2. DOMContentLoaded → AppBridge.init() → onReady(render)
   3. render(user, profile) — builds all HTML into #app
   4. wire() — attaches event listeners after render
   5. Data functions — Firestore CRUD operations

   AVAILABLE GLOBALS (after auth resolves)
   ----------------------------------------
   McgheeLab.db          — Firestore instance
   McgheeLab.auth        — Firebase Auth instance
   McgheeLab.storage     — Firebase Storage instance
   McgheeLab.AppBridge   — Auth bridge (see CLAUDE.md for full API)

   ================================================================ */

(() => {
  'use strict';

  const appEl = document.getElementById('app');

  /* ─── Lifecycle ─────────────────────────────────────────── */

  document.addEventListener('DOMContentLoaded', () => {
    McgheeLab.AppBridge.init();
    McgheeLab.AppBridge.onReady((user, profile) => {
      render(user, profile);
    });
  });

  /* ─── Render ────────────────────────────────────────────── */

  function render(user, profile) {
    const isAdmin = McgheeLab.AppBridge.isAdmin();

    appEl.innerHTML = `
      <div class="app-card">
        <h2>My App</h2>
        <p style="color: var(--muted);">
          TODO: Describe what this app does.
        </p>

        <!-- Example: feature grid -->
        <div class="myapp-features">
          <div class="myapp-feature">
            <h3>Feature One</h3>
            <p>Description of the first feature.</p>
          </div>
          <div class="myapp-feature">
            <h3>Feature Two</h3>
            <p>Description of the second feature.</p>
          </div>
          <div class="myapp-feature">
            <h3>Feature Three</h3>
            <p>Description of the third feature.</p>
          </div>
        </div>

        <!-- Example: form with base styles -->
        <div class="myapp-form-section" style="margin-top: 1.5rem;">
          <label class="app-label">Example Input</label>
          <input id="myapp-input" class="app-input" type="text" placeholder="Type something..." />
          <div style="margin-top: .75rem; display: flex; gap: .5rem;">
            <button id="myapp-save-btn" class="app-btn app-btn--primary">Save</button>
            <button id="myapp-cancel-btn" class="app-btn app-btn--secondary">Cancel</button>
            ${isAdmin ? '<button id="myapp-admin-btn" class="app-btn app-btn--danger">Admin Action</button>' : ''}
          </div>
        </div>

        <!-- Example: user info -->
        <div class="app-empty" style="margin-top: 2rem;">
          <p>Logged in as <strong>${user.displayName || user.email}</strong>
             <span class="app-badge ${isAdmin ? 'app-badge--admin' : 'app-badge--active'}">${profile.role}</span>
          </p>
        </div>
      </div>`;

    wire(user, profile);
    notifyResize();
  }

  /* ─── Wire (Event Listeners) ────────────────────────────── */

  function wire(user, profile) {
    const saveBtn   = document.getElementById('myapp-save-btn');
    const cancelBtn = document.getElementById('myapp-cancel-btn');
    const adminBtn  = document.getElementById('myapp-admin-btn');
    const input     = document.getElementById('myapp-input');

    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const value = input?.value?.trim();
        if (!value) return;

        // TODO: Save to Firestore
        // await addItem({ name: value });
        console.warn('[MyApp] Save clicked:', value);
      });
    }

    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        if (input) input.value = '';
      });
    }

    if (adminBtn) {
      adminBtn.addEventListener('click', () => {
        // TODO: Admin-only action
        console.warn('[MyApp] Admin action clicked');
      });
    }
  }

  /* ─── Data (Firestore CRUD) ─────────────────────────────── */

  // TODO: Replace 'myAppCollection' with your actual collection name
  const COLLECTION = 'myAppCollection';

  async function getItems() {
    const snap = await McgheeLab.db.collection(COLLECTION)
      .orderBy('createdAt', 'desc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  async function addItem(data) {
    const user = McgheeLab.AppBridge.getUser();
    return McgheeLab.db.collection(COLLECTION).add({
      ...data,
      createdBy: user.uid,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  async function updateItem(id, data) {
    return McgheeLab.db.collection(COLLECTION).doc(id).update({
      ...data,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  async function deleteItem(id) {
    return McgheeLab.db.collection(COLLECTION).doc(id).delete();
  }

  /* ─── Utilities ─────────────────────────────────────────── */

  // Notify parent iframe to resize (call after any render)
  function notifyResize() {
    if (McgheeLab.AppBridge.isEmbedded()) {
      window.parent.postMessage({
        type: 'mcgheelab-app-resize',
        height: document.body.scrollHeight
      }, window.location.origin);
    }
  }

  // Loading state helper
  function showLoading() {
    appEl.innerHTML = '<div class="app-empty"><p>Loading&hellip;</p></div>';
  }

  // Error state helper
  function showError(msg) {
    appEl.innerHTML = `<div class="app-empty"><p style="color:var(--danger);">${msg}</p></div>`;
  }

})();

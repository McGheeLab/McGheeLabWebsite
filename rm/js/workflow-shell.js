/* ================================================================
   workflow-shell.js — V3.78+ RM workflow shell (refactored V3.85)
   ================================================================
   Single-page host for an entire workflow. All workflow pages live
   as same-origin iframes inside this shell. The strip's chip clicks
   swap WHICH iframe is visible without a full-page navigation, so
   each page's state (scroll position, in-progress edits, paper-id
   being edited, etc.) survives chip switching.

   Side popouts (left + right): rendered by the shared
   `ShellPopouts.init` from /rm/js/shell-popouts.js. The same module
   is initialized on /rm/pages/split-view.html so popouts stay at the
   overall screen edges in both shell modes — split iframes don't
   nest their own popouts.

   URL state — workflow-shell owns:
     ?workflow=<id> &active=<pageId>
   Popout params (?leftPopout, ?rightPopout, ?leftOpen, ?rightOpen)
   are owned by ShellPopouts; this module preserves them in
   writeState by reading them off the URL each time.

   Lazy iframe loading: only the active page's iframe is created up
   front; other workflow pages' iframes are created on first chip
   click and stay mounted (display:none) thereafter.
   ================================================================ */

(function () {
  'use strict';

  /* ─── URL state (workflow + active only; popouts are owned by
   * ShellPopouts and live in their own params) ──────────────────── */
  function readState() {
    const p = new URLSearchParams(window.location.search);
    return {
      workflow: p.get('workflow') || '',
      active:   p.get('active')   || '',
    };
  }

  function writeState(s) {
    // Preserve every other param (especially popout params owned by
    // ShellPopouts). Only upsert this module's params.
    const p = new URLSearchParams(location.search);
    if (s.workflow) p.set('workflow', s.workflow); else p.delete('workflow');
    if (s.active)   p.set('active',   s.active);   else p.delete('active');
    history.replaceState(null, '', '/rm/pages/workflow-shell.html?' + p.toString());
  }

  /* ─── Page registry helpers ──────────────────────────── */
  function pageMap() {
    return (window.PAGE_REGISTRY && window.PAGE_REGISTRY.byId) || new Map();
  }
  function pageHrefForId(id) {
    const p = pageMap().get(id);
    return p && p.href || null;
  }
  function pageLabelForId(id) {
    const p = pageMap().get(id);
    return p && p.label || id;
  }

  /* ─── Workflow page list ─────────────────────────────── */
  let _wf = null;
  async function loadWorkflow(workflowId) {
    if (_wf && _wf.id === workflowId) return _wf;
    if (typeof firebridge === 'undefined' || !firebridge.db) return null;
    try {
      const snap = await firebridge.db().collection('labConfig').doc('defaultWorkflows').get();
      if (snap.exists) {
        const arr = (snap.data() || {}).workflows || [];
        const hit = arr.find(w => w.id === workflowId);
        if (hit) { _wf = hit; return hit; }
      }
    } catch (e) { /* ignore */ }
    const seeds = (window.PAGE_REGISTRY && window.PAGE_REGISTRY.DEFAULT_WORKFLOWS) || [];
    let hit = seeds.find(w => w.id === workflowId);
    if (hit) { _wf = hit; return hit; }
    const u = firebridge.getUser && firebridge.getUser();
    if (u) {
      try {
        const doc = await firebridge.db()
          .collection('userData').doc(u.uid)
          .collection('customWorkflows').doc(workflowId).get();
        if (doc.exists) { _wf = Object.assign({ id: doc.id }, doc.data() || {}); return _wf; }
      } catch (e) { /* ignore */ }
    }
    return null;
  }

  /* ─── Iframe manager ─────────────────────────────────── */
  const _frames = new Map();

  function _embedHref(href) {
    if (!href) return href;
    const idx = href.indexOf('#');
    const hash = idx >= 0 ? href.slice(idx) : '';
    const path = idx >= 0 ? href.slice(0, idx) : href;
    const qIdx = path.indexOf('?');
    const base = qIdx >= 0 ? path.slice(0, qIdx) : path;
    const qs = qIdx >= 0 ? path.slice(qIdx + 1) : '';
    const qp = new URLSearchParams(qs);
    qp.set('embed', '1');
    return base + '?' + qp.toString() + hash;
  }

  function ensureFrame(pageId) {
    if (_frames.has(pageId)) return _frames.get(pageId);
    const href = pageHrefForId(pageId);
    if (!href) return null;
    const main = document.getElementById('shell-main');
    if (!main) return null;
    const wrapper = document.createElement('div');
    wrapper.className = 'shell-frame-wrap';
    wrapper.dataset.pageId = pageId;
    wrapper.style.display = 'none';
    const frame = document.createElement('iframe');
    frame.className = 'shell-frame';
    frame.name = 'rm-shell-' + pageId;
    frame.src = _embedHref(href);
    frame.title = pageLabelForId(pageId);
    wrapper.appendChild(frame);
    main.appendChild(wrapper);
    const rec = { wrapper, frame };
    _frames.set(pageId, rec);
    return rec;
  }

  function showActiveFrame(pageId) {
    ensureFrame(pageId);
    _frames.forEach((rec, id) => {
      rec.wrapper.style.display = (id === pageId) ? '' : 'none';
    });
  }

  /* ─── Strip integration ──────────────────────────────── */
  window.addEventListener('rm:shell:set-active', (e) => {
    const d = e && e.detail; if (!d) return;
    const pageId = d.pageId;
    if (!pageId) return;
    const s = readState();
    if (s.active !== pageId) {
      s.active = pageId;
      writeState(s);
    }
    showActiveFrame(pageId);     // always swap; force-show is harmless
  });

  /* ─── Boot ────────────────────────────────────────────── */
  async function boot() {
    if (typeof firebridge === 'undefined') return;
    await firebridge.whenAuthResolved();
    if (!firebridge.getUser()) {
      const main = document.getElementById('shell-main');
      if (main) main.innerHTML = '<div class="empty-state">Sign in to use workflows.</div>';
      return;
    }
    if (firebridge.loadAccessGrant) {
      try { await firebridge.loadAccessGrant(); } catch (e) { /* ignore */ }
    }

    let s = readState();
    if (!s.workflow) {
      const wfState = (typeof WorkflowState !== 'undefined' && WorkflowState.read)
        ? WorkflowState.read() : null;
      if (wfState && wfState.id) s.workflow = wfState.id;
      else { location.href = '/rm/index.html'; return; }
    }

    if (typeof WorkflowState !== 'undefined' && WorkflowState.read) {
      const cur = WorkflowState.read();
      if (!cur || cur.id !== s.workflow) WorkflowState.setActive(s.workflow, 'default');
    }

    const wf = await loadWorkflow(s.workflow);
    if (!wf) {
      const main = document.getElementById('shell-main');
      if (main) main.innerHTML = '<div class="empty-state">Workflow not found.</div>';
      return;
    }

    if (!s.active || !pageHrefForId(s.active)) {
      let landing = wf.landingPageId;
      const isAccessible = (id) => {
        if (!pageHrefForId(id)) return false;
        if (typeof firebridge === 'undefined' || !firebridge.canAccessPage) return true;
        return firebridge.canAccessPage(id);
      };
      if (!landing || !isAccessible(landing)) {
        landing = (wf.pageIds || []).find(isAccessible);
      }
      s.active = landing;
    }
    writeState(s);

    if (s.active) showActiveFrame(s.active);

    // V3.85 — popouts handled by the shared module.
    if (window.ShellPopouts && ShellPopouts.init) {
      ShellPopouts.init({
        container: document.getElementById('shell-root') || document.body,
        workflowPageIds: wf.pageIds || [],
        canAccessPage: (id) => {
          if (typeof firebridge === 'undefined' || !firebridge.canAccessPage) return true;
          return firebridge.canAccessPage(id);
        },
        defaults: { left: 'chat', right: 'tasks' },
      });
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();

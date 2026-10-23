/* workflow-state.js — V3.64 client-side state for the active workflow.
 *
 * Active workflow is held in sessionStorage so it persists across in-page
 * navigations within a single tab without rewriting every <a href>. The
 * URL `?workflow=<id>` is recognized as a one-time entry signal — when
 * present, we write to sessionStorage and strip the param via
 * history.replaceState so subsequent navigations to other pages preserve
 * the workflow context without polluting URLs.
 *
 * The state shape is:
 *   {
 *     id: <string>,                 // workflow id (default or custom)
 *     kind: 'default' | 'custom',
 *     addedPageIds:   [...],        // user added these pages while in the
 *                                   //   workflow (e.g. via "+ Add page")
 *     removedPageIds: [...],        // user removed these
 *   }
 *
 * The effective page list at render time is:
 *   workflow.pageIds  ∪ addedPageIds  −  removedPageIds
 *
 * "Dirty" state is `addedPageIds.length || removedPageIds.length` — when
 * dirty, the workflow strip shows a "Save as custom" button (PR 3 / V3.65
 * makes that button persist a new userData/{uid}/customWorkflows doc).
 *
 * Exports `window.WorkflowState`. */

(function () {
  var STORAGE_KEY = 'mcgheelab.activeWorkflow';

  function read() {
    try {
      var raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (!s || typeof s !== 'object') return null;
      if (!s.id) return null;
      // Defensive defaults
      s.kind = s.kind || 'default';
      s.addedPageIds = Array.isArray(s.addedPageIds) ? s.addedPageIds : [];
      s.removedPageIds = Array.isArray(s.removedPageIds) ? s.removedPageIds : [];
      return s;
    } catch (e) {
      return null;
    }
  }

  function write(state) {
    if (!state) {
      sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function clear() {
    sessionStorage.removeItem(STORAGE_KEY);
  }

  /** Read `?workflow=<id>` from current URL and adopt it (overwriting any
   * existing sessionStorage state). Returns the new state or null. After
   * adoption, strips the param from the URL via history.replaceState so
   * the workflow context is invisible in the address bar but still
   * persists in sessionStorage. Called by nav.js early on every page
   * load. */
  function adoptFromUrl() {
    var qp = new URLSearchParams(location.search);
    var wfId = qp.get('workflow');
    if (!wfId) return read();
    var existing = read();
    // If the URL workflow matches existing state's id, keep the existing
    // dirty edits. Otherwise reset to a fresh state.
    var state = (existing && existing.id === wfId)
      ? existing
      : { id: wfId, kind: 'default', addedPageIds: [], removedPageIds: [] };
    write(state);
    // Strip ?workflow= from URL.
    qp.delete('workflow');
    var qs = qp.toString();
    var newUrl = location.pathname + (qs ? '?' + qs : '') + location.hash;
    try { history.replaceState(history.state, '', newUrl); } catch (e) { /* ignore */ }
    return state;
  }

  /** Compute the effective ordered page id list for the active workflow.
   * Caller passes the base workflow's `pageIds` (default or custom) plus
   * the active state object. Returns ordered array of page ids. */
  function effectivePageIds(basePageIds, state) {
    var ids = (basePageIds || []).slice();
    var removed = new Set(state && state.removedPageIds ? state.removedPageIds : []);
    var added = state && state.addedPageIds ? state.addedPageIds : [];
    var seen = new Set();
    var out = [];
    ids.concat(added).forEach(function (id) {
      if (removed.has(id)) return;
      if (seen.has(id)) return;
      seen.add(id);
      out.push(id);
    });
    return out;
  }

  function isDirty(state) {
    if (!state) return false;
    return (state.addedPageIds && state.addedPageIds.length) ||
           (state.removedPageIds && state.removedPageIds.length);
  }

  function addPage(pageId) {
    var s = read();
    if (!s) return;
    if (s.removedPageIds.indexOf(pageId) >= 0) {
      // Was previously removed — un-remove instead of adding.
      s.removedPageIds = s.removedPageIds.filter(function (x) { return x !== pageId; });
    } else if (s.addedPageIds.indexOf(pageId) < 0) {
      s.addedPageIds.push(pageId);
    }
    write(s);
    return s;
  }

  function removePage(pageId) {
    var s = read();
    if (!s) return;
    if (s.addedPageIds.indexOf(pageId) >= 0) {
      // Was a user-added page — just drop it from the added list.
      s.addedPageIds = s.addedPageIds.filter(function (x) { return x !== pageId; });
    } else if (s.removedPageIds.indexOf(pageId) < 0) {
      s.removedPageIds.push(pageId);
    }
    write(s);
    return s;
  }

  /** Async loader: returns the active workflow's full record (label,
   * pageIds, kind, etc.) merged with any sessionStorage edits. Returns
   * null if no active workflow or the record can't be found. Called by
   * nav.js when rendering the strip. */
  async function loadActive() {
    var state = read();
    if (!state) return null;
    if (state.kind === 'default') {
      var wf = await loadDefaultWorkflow(state.id);
      if (!wf) return null;
      return {
        id: wf.id, label: wf.label, description: wf.description, icon: wf.icon,
        kind: 'default',
        basePageIds: wf.pageIds || [],
        effectivePageIds: effectivePageIds(wf.pageIds || [], state),
        state: state,
      };
    }
    // PR 3: custom workflows
    if (state.kind === 'custom') {
      var cw = await loadCustomWorkflow(state.id);
      if (!cw) return null;
      return {
        id: cw.id, label: cw.label, description: cw.description || '', icon: cw.icon || 'star',
        kind: 'custom',
        basePageIds: cw.pageIds || [],
        effectivePageIds: effectivePageIds(cw.pageIds || [], state),
        state: state,
      };
    }
    return null;
  }

  /* ── Firestore loaders ── */

  var _defaultWorkflowsCache = null;
  async function loadDefaultWorkflows() {
    if (_defaultWorkflowsCache) return _defaultWorkflowsCache;
    var seed = (window.PAGE_REGISTRY && window.PAGE_REGISTRY.DEFAULT_WORKFLOWS) || [];
    try {
      if (typeof firebridge === 'undefined' || !firebridge.db) {
        _defaultWorkflowsCache = seed;
        return seed;
      }
      var snap = await firebridge.db().collection('labConfig').doc('defaultWorkflows').get();
      if (snap.exists) {
        var data = snap.data() || {};
        var arr = Array.isArray(data.workflows) ? data.workflows : [];
        if (arr.length) {
          _defaultWorkflowsCache = arr;
          return arr;
        }
      }
    } catch (err) {
      console.warn('[workflow-state] defaults read failed (using seed):', err.message);
    }
    _defaultWorkflowsCache = seed;
    return seed;
  }

  async function loadDefaultWorkflow(id) {
    var arr = await loadDefaultWorkflows();
    return arr.find(function (w) { return w.id === id; }) || null;
  }

  var _customWorkflowsCache = null;
  async function loadCustomWorkflows() {
    if (_customWorkflowsCache) return _customWorkflowsCache;
    if (typeof firebridge === 'undefined') return [];
    var u = firebridge.getUser && firebridge.getUser();
    if (!u) return [];
    try {
      var snap = await firebridge.db()
        .collection('userData').doc(u.uid)
        .collection('customWorkflows').get();
      var arr = [];
      snap.forEach(function (d) {
        var data = d.data() || {};
        arr.push(Object.assign({ id: d.id }, data));
      });
      _customWorkflowsCache = arr;
      return arr;
    } catch (err) {
      console.warn('[workflow-state] custom workflows read failed:', err.message);
      _customWorkflowsCache = [];
      return [];
    }
  }

  async function loadCustomWorkflow(id) {
    var arr = await loadCustomWorkflows();
    return arr.find(function (w) { return w.id === id; }) || null;
  }

  /** Set the active workflow (called by the chooser when the user clicks
   * a card). Resets dirty edits. */
  function setActive(id, kind) {
    write({ id: id, kind: kind || 'default', addedPageIds: [], removedPageIds: [], orderOverride: null });
  }

  /** Add `?workflow=<id>` to a URL while preserving its query + hash.
   * Used by the workflow strip to make every page link carry the
   * workflow context — even though sessionStorage is the primary
   * persistence, including the param means new-tab opens (Cmd-click)
   * still land in the right workflow. */
  function decorateHref(href, wfId) {
    if (!href || !wfId) return href;
    var idx = href.indexOf('#');
    var hash = idx >= 0 ? href.slice(idx) : '';
    var path = idx >= 0 ? href.slice(0, idx) : href;
    var qIdx = path.indexOf('?');
    var qs = qIdx >= 0 ? path.slice(qIdx + 1) : '';
    var basePath = qIdx >= 0 ? path.slice(0, qIdx) : path;
    var qp = new URLSearchParams(qs);
    qp.set('workflow', wfId);
    return basePath + '?' + qp.toString() + hash;
  }

  window.WorkflowState = {
    read: read,
    write: write,
    clear: clear,
    adoptFromUrl: adoptFromUrl,
    effectivePageIds: effectivePageIds,
    isDirty: isDirty,
    addPage: addPage,
    removePage: removePage,
    loadActive: loadActive,
    loadDefaultWorkflows: loadDefaultWorkflows,
    loadDefaultWorkflow: loadDefaultWorkflow,
    loadCustomWorkflows: loadCustomWorkflows,
    loadCustomWorkflow: loadCustomWorkflow,
    setActive: setActive,
    decorateHref: decorateHref,
  };
})();

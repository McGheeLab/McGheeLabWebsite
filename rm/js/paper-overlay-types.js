/* paper-overlay-types.js — V3.189.
 *
 * Closed annotation_type enum + per-type filter UI for the paper reader.
 * Layers on top of paper-overlays.js's draft-scoped filter: a highlight
 * renders if it passes BOTH (overlay filter is on for at least one of its
 * cite_in_drafts) AND (its annotation_type's filter button is on).
 *
 * Public API (window.PAPER_OVERLAY_TYPES):
 *   init({mountEl, onChange})  — render the type-filter pills
 *   getFilterFn()              — (ann) => boolean
 *   getColorForAnnotation(ann) — '#rrggbb' if ann has annotation_type
 *   getActiveTypes()           — string[]
 *   onChange(cb)               — register a listener
 *
 * Persisted in localStorage at `rm_lp_types_<paperId>`. Default: all on.
 */
(function () {
  'use strict';

  // Stable type ordering — also the on-screen pill order.
  const TYPES = [
    { id: 'evidence',   label: 'Evidence',   color: '#22c55e' }, // green
    { id: 'method',     label: 'Method',     color: '#3b82f6' }, // blue
    { id: 'result',     label: 'Result',     color: '#a855f7' }, // purple
    { id: 'limitation', label: 'Limitation', color: '#ef4444' }, // red
    { id: 'claim',      label: 'Claim',      color: '#eab308' }, // yellow
    { id: 'note',       label: 'Note',       color: '#9ca3af' }, // grey
    { id: 'question',   label: 'Question',   color: '#f97316' }, // orange
  ];
  const TYPE_COLORS = Object.fromEntries(TYPES.map(t => [t.id, t.color]));
  const TYPE_LABELS = Object.fromEntries(TYPES.map(t => [t.id, t.label]));

  let _paperId = null;
  let _mountEl = null;
  let _active = new Set(TYPES.map(t => t.id));
  let _counts = {};
  let _changeCallbacks = [];
  let _getAnnotations = null;

  function _storageKey() { return `rm_lp_types_${_paperId || 'unknown'}`; }
  function _loadActive() {
    try {
      const raw = localStorage.getItem(_storageKey());
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return new Set(arr);
      }
    } catch (_) { /* corrupt — fall through */ }
    return new Set(TYPES.map(t => t.id));
  }
  function _saveActive() {
    try { localStorage.setItem(_storageKey(), JSON.stringify(Array.from(_active))); }
    catch (_) { /* quota — ignore */ }
  }

  function getActiveTypes() { return Array.from(_active); }

  function getFilterFn() {
    return (ann) => {
      const t = (ann && ann.annotation_type) || 'note';
      return _active.has(t);
    };
  }

  function getColorForAnnotation(ann) {
    if (!ann) return null;
    const t = ann.annotation_type;
    if (t && TYPE_COLORS[t]) return TYPE_COLORS[t];
    return null;
  }

  function onChange(cb) { if (typeof cb === 'function') _changeCallbacks.push(cb); }
  function _emit() { _changeCallbacks.forEach(cb => { try { cb(); } catch (_) {} }); }

  function _recountTypes() {
    _counts = {};
    const anns = _getAnnotations ? (_getAnnotations() || []) : [];
    for (const a of anns) {
      const t = a.annotation_type || 'note';
      _counts[t] = (_counts[t] || 0) + 1;
    }
  }

  function _render() {
    if (!_mountEl) return;
    _recountTypes();
    _mountEl.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'lp-overlay-types';
    wrap.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;align-items:center;font-size:11px;';

    TYPES.forEach(t => {
      const on = _active.has(t.id);
      const n = _counts[t.id] || 0;
      const btn = document.createElement('button');
      btn.className = 'lp-type-pill';
      btn.title = `${t.label} (${n})`;
      btn.style.cssText = ''
        + 'padding:2px 8px;border-radius:10px;cursor:pointer;'
        + 'font-size:11px;line-height:1.4;border:1px solid ' + t.color + ';'
        + 'background:' + (on ? t.color : 'transparent') + ';'
        + 'color:' + (on ? '#fff' : t.color) + ';'
        + 'opacity:' + (n === 0 ? '0.45' : '1') + ';';
      btn.innerHTML = `${t.label}<span style="margin-left:4px;opacity:0.85;">${n}</span>`;
      btn.addEventListener('click', () => {
        if (_active.has(t.id)) _active.delete(t.id);
        else _active.add(t.id);
        _saveActive();
        _render();
        _emit();
      });
      wrap.appendChild(btn);
    });
    _mountEl.appendChild(wrap);
  }

  function init(opts) {
    _paperId = opts.paperId || null;
    _mountEl = opts.mountEl || null;
    _getAnnotations = opts.getAnnotations || (() => []);
    // V3.294 — clear listeners before re-registering so a tab switch
    // doesn't stack the orchestrator's onChange callback (each one would
    // re-fire on every pill toggle, re-rendering stale consumers).
    _changeCallbacks = [];
    _active = _loadActive();
    _render();
    if (typeof opts.onChange === 'function') onChange(opts.onChange);
  }

  function refresh() { _render(); }

  // V3.294 — tear down for tab switches: drop callbacks + blank the mount.
  function destroy() {
    _changeCallbacks = [];
    if (_mountEl) _mountEl.innerHTML = '';
    _mountEl = null;
    _paperId = null;
    _getAnnotations = null;
  }

  window.PAPER_OVERLAY_TYPES = {
    TYPES,
    TYPE_COLORS,
    TYPE_LABELS,
    init,
    refresh,
    getActiveTypes,
    getFilterFn,
    getColorForAnnotation,
    onChange,
    destroy,
  };
})();

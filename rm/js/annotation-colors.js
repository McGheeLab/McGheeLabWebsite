/* annotation-colors.js — THE single source for the highlight palette.
 *
 * V3.620 — before this, DEFAULT_COLORS was duplicated byte-identical in
 * library-paper.js, library-mobile-paper.js, and library-comments.js, with
 * two more hardcoded yellow fallbacks in annotation-overlay.js and
 * annotation-panel.js — five places that could drift (and the panel's type
 * pills carried a sixth, unrelated color set). Every consumer now reads
 * window.ANNOTATION_COLORS. Load this before any of them.
 *
 * Color IS the category (V3.619): each palette entry maps to the
 * annotation_type stamped on highlights created with it, so the reader's
 * page rects, the right-panel cards, the type pills, the comments feed,
 * and the mobile sheet all agree on one hue per category.
 *
 * The per-user palette route (library/highlight_colors.json) is
 * deliberately NOT consulted here — no UI ever wrote it, and the dead
 * branch is what blanked the create toolbar for every non-Alex user
 * (V3.608). If per-user palettes ever return, they go through this module.
 *
 * Public API (window.ANNOTATION_COLORS):
 *   DEFAULT        — [{id, name, hex, meaning, auto_flags[]}]
 *   COLOR_TO_TYPE  — {colorId: annotation_type}
 *   byId(id)       — palette entry, or the yellow fallback for unknown ids
 *   typeFor(id)    — annotation_type for a color id ('note' fallback)
 *   hexFor(id)     — hex for a color id (yellow fallback)
 */
(function () {
  'use strict';

  var DEFAULT = [
    { id: 'yellow', name: 'Note', hex: '#facc15', meaning: 'Interesting / general note', auto_flags: [] },
    { id: 'green', name: 'Evidence', hex: '#4ade80', meaning: 'Evidence supporting a claim (use evidence_stance="for" when linked to a claim)', auto_flags: [] },
    { id: 'red', name: 'Critique', hex: '#f87171', meaning: 'Counter-evidence / critique / disagree', auto_flags: [] },
    { id: 'blue', name: 'Method', hex: '#60a5fa', meaning: 'Method or technique to remember', auto_flags: [] },
    { id: 'purple', name: 'Investigate', hex: '#a78bfa', meaning: 'Come back to this — needs further investigation', auto_flags: ['marked_for_investigation'] },
    { id: 'orange', name: 'Quote', hex: '#fb923c', meaning: 'Quote-worthy for direct citation in a draft', auto_flags: [] },
  ];

  var COLOR_TO_TYPE = {
    yellow: 'note',
    green: 'evidence',
    red: 'limitation',
    blue: 'method',
    purple: 'question',
    orange: 'quote',
  };

  function byId(id) {
    for (var i = 0; i < DEFAULT.length; i++) {
      if (DEFAULT[i].id === id) return DEFAULT[i];
    }
    return DEFAULT[0]; // yellow — same fallback the overlay always used
  }

  function typeFor(id) { return COLOR_TO_TYPE[id] || 'note'; }
  function hexFor(id) { return byId(id).hex; }

  window.ANNOTATION_COLORS = {
    DEFAULT: DEFAULT,
    COLOR_TO_TYPE: COLOR_TO_TYPE,
    byId: byId,
    typeFor: typeFor,
    hexFor: hexFor,
  };
})();

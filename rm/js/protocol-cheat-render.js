/* protocol-cheat-render.js — shared "cheat sheet" renderers + selection model.
 *
 * Extracted from protocol-cheat.js (V3.503) so BOTH the cheat-sheet page
 * (pages/protocols.html?view=cheat) AND the lab-notebook protocol run
 * (rm/js/lab-notebook.js) render the condensed sheet identically — single
 * source of truth, the way protocol-doc-render.js is shared between the doc
 * view and the editor preview.
 *
 * V3.515 — the contents are USER-SELECTED at point of use, not a hardcoded
 * keep-set. Selection is a small prefs object, persisted per (user, protocol)
 * at userData/{uid}/protocolCheatPrefs/{protocolId}:
 *
 *   { categories: {materials,safety,figures,timing}, overrides: {blockId:'in'|'out'} }
 *
 * Steps + stage headings are structural and always shown. The four category
 * pills toggle their block groups; a per-line tri-state override (Force-
 * include / Force-exclude / Default) wins over the category. Formula/
 * calculator OUTPUTS still resolve inside kept steps via the shared symbol
 * table, so [!var:] tokens keep their live values regardless of selection.
 *
 * Renders reuse window.ProtocolDocRender for kept non-step blocks and emit
 * `prc-*` classes; the host must load protocol-cheat.css and scope the
 * container with `prd-doc prc-doc` for the dense styling.
 *
 * Public: window.ProtocolCheatRender = {
 *   CATEGORIES, CATEGORY_LABELS, DEFAULT_PREFS, defaultPrefs, normalizePrefs,
 *   categoryOf, resolveKeep, keepBlock, condenseStepText, renderStepCheat,
 *   renderSectionsInto(container, tree, ctx, opts),
 *   renderChecklistInto(container, tree, prefs, handlers),
 *   buildConfigBar(prefs, handlers),
 *   loadPrefs(protocolId) -> Promise<prefs>, savePrefs(protocolId, prefs)
 * }
 */

(function () {
  var PW = function () { return window.ProtocolWidgets; };

  /* ── Selection model ─────────────────────────────────────────────── */
  var CATEGORIES = ['materials', 'safety', 'figures', 'timing'];
  var CATEGORY_LABELS = {
    materials: 'Materials',
    safety: 'Safety',
    figures: 'Figures & maps',
    timing: 'Timing',
  };
  /* Defaults before the user customizes: steps always on; figures + timing
   * on; materials + safety off (the V3.503 "earlier split"). */
  function defaultPrefs() {
    return {
      categories: { materials: false, safety: false, figures: true, timing: true },
      overrides: {},
    };
  }
  var DEFAULT_PREFS = defaultPrefs();

  function normalizePrefs(raw) {
    var p = defaultPrefs();
    if (raw && typeof raw === 'object') {
      if (raw.categories && typeof raw.categories === 'object') {
        CATEGORIES.forEach(function (c) {
          if (typeof raw.categories[c] === 'boolean') p.categories[c] = raw.categories[c];
        });
      }
      if (raw.overrides && typeof raw.overrides === 'object') {
        Object.keys(raw.overrides).forEach(function (k) {
          var v = raw.overrides[k];
          if (v === 'in' || v === 'out') p.overrides[k] = v;
        });
      }
    }
    return p;
  }

  /* Which pill (or structural group) a block belongs to. `steps` is always
   * on; `other` is off unless a per-line override forces it in. */
  function categoryOf(b) {
    if (!b) return 'other';
    switch (b.kind) {
      case 'step':
      case 'heading':   return 'steps';
      case 'materials': return 'materials';
      case 'figure':
      case 'layoutMap': return 'figures';
      case 'timeline':  return 'timing';
      case 'safety':    return 'safety';   // legacy kind → critical/safety
      case 'callout': {
        var t = (b.attrs && b.attrs.type) || 'note';
        if (t === 'timing') return 'timing';
        if (t === 'critical') return 'safety';
        return 'other';                    // note / assume
      }
      default:          return 'other';    // table, kv, formula, calculator,
                                           // builder, design, docHeader, note
    }
  }

  /* Final include decision for a block under a selection. Override wins;
   * else steps→in, other→out, else the category pill. */
  function resolveKeep(b, prefs) {
    if (!b) return false;
    prefs = prefs || DEFAULT_PREFS;
    var ov = prefs.overrides && prefs.overrides[b.id];
    if (ov === 'in') return true;
    if (ov === 'out') return false;
    var cat = categoryOf(b);
    if (cat === 'steps') return true;
    if (cat === 'other') return false;
    return !!(prefs.categories && prefs.categories[cat]);
  }

  /* Back-compat alias (default selection = the old V3.503 keep-set). */
  function keepBlock(b) { return resolveKeep(b, DEFAULT_PREFS); }

  /* ── Step condensation ─────────────────────────────────────────────
   * Authored `attrs.cheat` wins (see renderStepCheat); this is the auto
   * fallback. Returns a one-line string that still contains any
   * [!var:]/[!inv:] tokens (they hold no ". "), so bindProse resolves
   * live values afterward. */
  function condenseStepText(raw) {
    var s = String(raw || '').trim();
    if (!s) return '';
    var nl = s.search(/\r?\n/);
    if (nl >= 0) {
      var firstLine = s.slice(0, nl).trim();
      if (firstLine) s = firstLine;
    }
    var m = s.match(/^[\s\S]*?[.;:](?=\s|$)/);
    var out = (m ? m[0] : s).trim().replace(/[.;:]+$/, '');
    if (out.length > 140) out = out.slice(0, 137).replace(/\s+\S*$/, '') + '…';
    return out;
  }

  function renderStepCheat(ctx, b, num) {
    var el = document.createElement('div');
    el.className = 'prc-step';
    var badge = document.createElement('span');
    badge.className = 'prc-step-num';
    badge.textContent = String(num || 1);
    el.appendChild(badge);
    var line = document.createElement('span');
    line.className = 'prc-step-line prd-prose';
    var authored = (b.attrs && typeof b.attrs.cheat === 'string') ? b.attrs.cheat.trim() : '';
    PW().bindProse(ctx, line, authored || condenseStepText(b.body));
    el.appendChild(line);
    return el;
  }

  /* ── View render (the actual cheat sheet) ───────────────────────────
   * Renders the INCLUDED blocks of `tree` into `container`. No header /
   * footer — the host supplies chrome. opts.prefs drives inclusion
   * (default = the V3.503 keep-set). Returns the final step count. */
  function renderSectionsInto(container, tree, ctx, opts) {
    opts = opts || {};
    var prefs = opts.prefs || DEFAULT_PREFS;
    var stepCounter = 0;
    ((tree && tree.sections) || []).forEach(function (sec) {
      var kept = (sec.children || []).filter(function (b) { return resolveKeep(b, prefs); });
      if (!kept.length) return;   // drop sections that condense to nothing
      var secEl = document.createElement('section');
      secEl.className = 'prc-section';
      var h = document.createElement('h2');
      h.className = 'prc-stage';
      h.textContent = sec.label || 'Untitled section';
      secEl.appendChild(h);
      kept.forEach(function (b) {
        var el;
        if (b.kind === 'step') {
          stepCounter++;
          el = renderStepCheat(ctx, b, stepCounter);
        } else {
          el = window.ProtocolDocRender.renderBlock(b, ctx, {});
        }
        if (el) secEl.appendChild(el);
      });
      container.appendChild(secEl);
    });
    return stepCounter;
  }

  /* ── Customize checklist (one row per block, tri-state via checkbox) ─ */
  function _trunc(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  function _previewText(b) {
    switch (b.kind) {
      case 'step': {
        var authored = (b.attrs && b.attrs.cheat || '').trim();
        return authored || condenseStepText(b.body) || '(empty step)';
      }
      case 'heading':   return (b.body || '').trim() || '(stage heading)';
      case 'materials': {
        var rows = (b.attrs && b.attrs.rows) || [];
        var n = rows.filter(function (r) { return r && (r.free_text || r.item_ref || r.qty); }).length;
        return 'Materials — ' + n + ' item' + (n === 1 ? '' : 's');
      }
      case 'figure':    return 'Figure' + ((b.body || '').trim() ? ' — ' + b.body : '');
      case 'layoutMap': return (b.attrs && b.attrs.label) || 'Plate / layout map';
      case 'timeline':  return 'Timeline' + ((b.body || '').trim() ? ' — ' + b.body : '');
      case 'callout':   return '[' + ((b.attrs && b.attrs.type) || 'note') + '] ' + (b.body || '');
      case 'table':     return 'Table' + ((b.body || '').trim() ? ' — ' + b.body : '');
      case 'kv':        return 'Definitions';
      case 'formula':
      case 'calculator':
      case 'builder':
      case 'design':    return (b.attrs && b.attrs.label) || b.kind;
      case 'docHeader': return 'Document header';
      case 'note':
      case 'safety':    return (b.body || '').trim() || b.kind;
      default:          return b.kind;
    }
  }

  function renderChecklistInto(container, tree, prefs, handlers) {
    prefs = prefs || DEFAULT_PREFS;
    handlers = handlers || {};
    ((tree && tree.sections) || []).forEach(function (sec) {
      var kids = (sec.children || []).filter(function (b) { return b && b.kind !== 'docHeader'; });
      if (!kids.length) return;
      var secEl = document.createElement('section');
      secEl.className = 'prc-section prc-check-section';
      var h = document.createElement('h2');
      h.className = 'prc-stage';
      h.textContent = sec.label || 'Untitled section';
      secEl.appendChild(h);
      kids.forEach(function (b) {
        var kept = resolveKeep(b, prefs);
        var cat = categoryOf(b);
        var row = document.createElement('label');
        row.className = 'prc-check-row' + (kept ? '' : ' is-excluded');
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'prc-line-check';
        cb.checked = kept;
        cb.addEventListener('change', function () {
          if (handlers.onToggleBlock) handlers.onToggleBlock(b.id, cb.checked ? 'in' : 'out');
        });
        row.appendChild(cb);
        var tag = document.createElement('span');
        tag.className = 'prc-check-tag prc-cat-' + cat;
        tag.textContent = cat === 'steps' ? (b.kind === 'heading' ? 'heading' : 'step') : cat;
        row.appendChild(tag);
        var prev = document.createElement('span');
        prev.className = 'prc-check-preview';
        prev.textContent = _trunc(_previewText(b), 90);
        row.appendChild(prev);
        secEl.appendChild(row);
      });
      container.appendChild(secEl);
    });
  }

  /* ── Config bar (category pills + Customize toggle + Reset) ─────────
   * handlers = { customizing:bool, onToggleCategory(cat,next),
   *   onToggleCustomize(next), onReset() } */
  function buildConfigBar(prefs, handlers) {
    prefs = prefs || DEFAULT_PREFS;
    handlers = handlers || {};
    var bar = document.createElement('div');
    bar.className = 'prc-configbar';

    var pills = document.createElement('div');
    pills.className = 'prc-pills';
    var lead = document.createElement('span');
    lead.className = 'prc-pills-lead';
    lead.textContent = 'Include:';
    pills.appendChild(lead);
    CATEGORIES.forEach(function (c) {
      var on = !!prefs.categories[c];
      var pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'prc-pill' + (on ? ' on' : '');
      ICON.label(pill, (on ? 'check' : 'plus') + CATEGORY_LABELS[c]);
      pill.setAttribute('aria-pressed', on ? 'true' : 'false');
      pill.addEventListener('click', function () {
        if (handlers.onToggleCategory) handlers.onToggleCategory(c, !on);
      });
      pills.appendChild(pill);
    });
    bar.appendChild(pills);

    var actions = document.createElement('div');
    actions.className = 'prc-configbar-actions';

    var custom = document.createElement('button');
    custom.type = 'button';
    custom.className = 'prc-customize-btn' + (handlers.customizing ? ' on' : '');
    if (handlers.customizing) custom.textContent = '✓ Done';
    else ICON.label(custom, 'pencil', ' Customize lines');
    custom.title = 'Include or exclude individual lines, overriding the category pills';
    custom.addEventListener('click', function () {
      if (handlers.onToggleCustomize) handlers.onToggleCustomize(!handlers.customizing);
    });
    actions.appendChild(custom);

    var hasOverrides = prefs.overrides && Object.keys(prefs.overrides).length > 0;
    var nonDefaultCats = CATEGORIES.some(function (c) {
      return prefs.categories[c] !== DEFAULT_PREFS.categories[c];
    });
    if (hasOverrides || nonDefaultCats) {
      var reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'prc-reset';
      ICON.label(reset, 'arrow-uturn-left', ' Reset');
      reset.title = 'Restore default categories and clear per-line choices';
      reset.addEventListener('click', function () { if (handlers.onReset) handlers.onReset(); });
      actions.appendChild(reset);
    }
    bar.appendChild(actions);
    return bar;
  }

  /* ── Persistence: userData/{uid}/protocolCheatPrefs/{protocolId} ────
   * Owner-only (userData/{uid}/{document=**} rule). Direct firebridge ref,
   * mirroring lab-notebook's PMR writes. Saves are debounced per protocol. */
  function _prefsRef(protocolId) {
    var fb = window.firebridge;
    var u = fb && fb.getUser && fb.getUser();
    if (!fb || !u || !u.uid || !protocolId) return null;
    return fb.db().collection('userData').doc(u.uid)
      .collection('protocolCheatPrefs').doc(protocolId);
  }

  function loadPrefs(protocolId) {
    var ref = _prefsRef(protocolId);
    if (!ref) return Promise.resolve(defaultPrefs());
    return ref.get().then(function (snap) {
      return snap.exists ? normalizePrefs(snap.data()) : defaultPrefs();
    }).catch(function (e) {
      console.warn('[cheat-prefs] load failed:', e && e.message);
      return defaultPrefs();
    });
  }

  var _saveTimers = {};
  function savePrefs(protocolId, prefs) {
    var ref = _prefsRef(protocolId);
    if (!ref) return;
    clearTimeout(_saveTimers[protocolId]);
    _saveTimers[protocolId] = setTimeout(function () {
      ref.set({
        categories: prefs.categories,
        overrides: prefs.overrides,
        updated_at: new Date().toISOString(),
      }, { merge: true }).catch(function (e) {
        console.warn('[cheat-prefs] save failed:', e && e.message);
      });
    }, 400);
  }

  window.ProtocolCheatRender = {
    CATEGORIES: CATEGORIES,
    CATEGORY_LABELS: CATEGORY_LABELS,
    DEFAULT_PREFS: DEFAULT_PREFS,
    defaultPrefs: defaultPrefs,
    normalizePrefs: normalizePrefs,
    categoryOf: categoryOf,
    resolveKeep: resolveKeep,
    keepBlock: keepBlock,
    condenseStepText: condenseStepText,
    renderStepCheat: renderStepCheat,
    renderSectionsInto: renderSectionsInto,
    renderChecklistInto: renderChecklistInto,
    buildConfigBar: buildConfigBar,
    loadPrefs: loadPrefs,
    savePrefs: savePrefs,
  };
})();

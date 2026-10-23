/* pmr-week-assemble.js — V3.532 (My Week program R7): "⤓ Assemble my week".
 *
 * The notebook is canonical for "what I did" (program decision 6); the PMR
 * week becomes assembled + curated instead of retyped. This module gathers
 * everything the student did in a week's date range from four sources:
 *
 *   1. lab-notebook `_index` rows        (userData/{uid}/notebook/_index)
 *   2. tracker events                    (ActivitySignals.listEvents)
 *   3. completed subtasks                (userData/{uid}/buckets walk)
 *   4. My Week plans                      (userData/{uid}/dayPlans)
 *
 * …dedupes against what's already in the week (source_notebook_id /
 * source_subtask_id / source_day_item_id backrefs + the deterministic
 * auto-dayplan-* tracker ids), shows a checkbox review dialog, and inserts
 * the checked items with backrefs. One-shot + idempotent: re-running skips
 * anything whose backref already exists — curation stays human, existing
 * manual items are never touched (same philosophy as V3.193 Auto-fill).
 *
 * Owner-only (the PI/mentor review view is read-only anyway).
 *
 * Globals: window.PMR_WEEK_ASSEMBLE = { open(wk, opts) }
 *   opts = { onInsert(items) — append + save is the CALLER's job (pmr.js
 *            owns scheduleSave/renderBody discipline) }
 * Depends: firebridge; window.ActivitySignals optional (source 2 skipped
 * without it).
 */
(function () {
  'use strict';

  function db()  { return firebridge.db(); }
  function uid() { var u = firebridge.getUser(); return u && u.uid; }
  function newId(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* Existing-backref sets for the whole PERIOD doc (not just this week) so
   * an item pulled into week N never re-suggests in week N+1. */
  function existingRefs(doc) {
    var refs = { notebook: {}, subtask: {}, dayplan: {}, texts: {} };
    (doc.weekly_entries || []).forEach(function (wk) {
      (wk.subsections || []).forEach(function (sub) {
        (sub.items || []).forEach(function (it) {
          if (!it) return;
          if (it.source_notebook_id) refs.notebook[it.source_notebook_id] = 1;
          if (it.source_subtask_id)  refs.subtask[it.source_subtask_id] = 1;
          if (it.source_day_item_id) refs.dayplan[it.source_day_item_id] = 1;
          if (it.text) refs.texts[String(it.text).trim().toLowerCase()] = 1;
        });
      });
    });
    return refs;
  }

  /* Subsection guess — same keyword heuristic as task-pmr-sync V3.194. */
  function guessSubsection(text) {
    var t = String(text || '').toLowerCase();
    if (/\b(read|reading|writ|paper|manuscript|draft|review|literature|cite)\b/.test(t)) return 'Reading/Writing';
    return 'Experimental update';
  }

  /* ── gatherers ───────────────────────────────────────────── */

  async function gatherNotebook(start, end, refs) {
    try {
      var snap = await db().collection('userData').doc(uid()).collection('notebook').doc('_index').get();
      if (!snap.exists) return [];
      return ((snap.data() || {}).entries || [])
        .filter(function (r) { return r && r.date && r.date >= start && r.date <= end; })
        .filter(function (r) { return !refs.notebook[r.id] && !refs.dayplan[r.id]; })
        .map(function (r) {
          var phase = r.phase && r.phase !== 'complete' ? ' (' + r.phase + ')' : '';
          return {
            key: 'nb:' + r.id,
            source: ICON.svg('book-open') + ' notebook',
            text: (r.title || '(untitled)') + phase,
            status: r.phase === 'plan' ? 'in_progress' : 'done',
            subsection: guessSubsection(r.title),
            backref: { source_notebook_id: r.id },
            links: [{ kind: 'notebook', label: r.title || 'Notebook entry', url: '/rm/pages/notebook.html?entry=' + encodeURIComponent(r.id) }],
          };
        });
    } catch (err) {
      console.warn('[pmr-assemble] notebook gather failed:', err && err.message);
      return [];
    }
  }

  async function gatherTracker(start, end, refs) {
    if (!window.ActivitySignals) return [];
    try {
      var rows = await ActivitySignals.listEvents(uid(), { from: start, to: end });
      var seen = {};
      return rows.filter(function (e) {
        // Collapse auto-dayplan schedule/work pairs to one row, keyed on
        // the source id; skip anything whose dayplan/notebook source is
        // already in the PMR (or already suggested by another source).
        var srcId = e.source_ref && e.source_ref.id;
        if (srcId && refs.dayplan[srcId]) return false;
        if (srcId && (e.source === 'rm-notebook' || e.source === 'my-day')) {
          if (refs.notebook[srcId] || seen['src:' + srcId]) return false;
          seen['src:' + srcId] = 1;
        }
        if (e.kind === 'schedule' && e.date < new Date().toISOString().slice(0, 10)) return false; // stale plan, not work
        var t = String(e.text || '').trim().toLowerCase();
        if (!t || refs.texts[t] || seen['txt:' + t]) return false;
        seen['txt:' + t] = 1;
        return true;
      }).map(function (e) {
        return {
          key: 'tr:' + e.id,
          source: ICON.svg('clock') + ' tracker',
          text: e.text,
          status: 'done',
          subsection: guessSubsection(e.text),
          backref: (e.source_ref && e.source_ref.kind === 'dayplan') ? { source_day_item_id: e.source_ref.id } : {},
          links: [],
        };
      });
    } catch (err) {
      console.warn('[pmr-assemble] tracker gather failed:', err && err.message);
      return [];
    }
  }

  async function gatherSubtasks(start, end, refs) {
    try {
      var snap = await db().collection('userData').doc(uid()).collection('buckets').get();
      var out = [];
      function walk(subtasks) {
        (subtasks || []).forEach(function (st) {
          if (!st) return;
          var doneDay = st.done && st.done_at ? String(st.done_at).slice(0, 10) : null;
          if (doneDay && doneDay >= start && doneDay <= end && !refs.subtask[st.id]) {
            out.push({
              key: 'st:' + st.id,
              source: ICON.svg('check-circle') + ' task',
              text: st.text || '',
              status: 'done',
              subsection: guessSubsection(st.text),
              backref: { source_subtask_id: st.id },
              links: [],
            });
          }
          walk(st.children);
        });
      }
      snap.forEach(function (d) {
        ((d.data() || {}).buckets || []).forEach(function (b) { walk(b.subtasks); });
      });
      return out;
    } catch (err) {
      console.warn('[pmr-assemble] subtask gather failed:', err && err.message);
      return [];
    }
  }

  async function gatherDayPlans(start, end, refs, already) {
    try {
      var snap = await db().collection('userData').doc(uid()).collection('dayPlans')
        .where('date', '>=', start).where('date', '<=', end).get();
      return snap.docs
        .filter(function (d) { return d.id !== '_prefs'; })
        .map(function (d) { return Object.assign({ id: d.id }, d.data()); })
        .filter(function (it) {
          if (it.status === 'cancelled' || it.status === 'skipped') return false;
          if (refs.dayplan[it.id]) return false;
          // A notebook stub / tracker event for this plan may already be a
          // candidate — one suggestion per underlying thing.
          return !already['nb:' + it.id] && !Object.keys(already).some(function (k) {
            return k.indexOf('tr:auto-dayplan-' + it.id) === 0;
          });
        })
        .map(function (it) {
          return {
            key: 'dp:' + it.id,
            source: ICON.svg('sun') + ' my day',
            text: it.title || '',
            status: it.status === 'done' ? 'done' : 'in_progress',
            subsection: guessSubsection(it.title),
            backref: { source_day_item_id: it.id },
            links: [],
          };
        });
    } catch (err) {
      console.warn('[pmr-assemble] dayplan gather failed:', err && err.message);
      return [];
    }
  }

  /* ── dialog ──────────────────────────────────────────────── */

  var _css = false;
  function ensureCss() {
    if (_css || document.getElementById('pwa-css')) { _css = true; return; }
    var st = document.createElement('style');
    st.id = 'pwa-css';
    st.textContent =
      '.pwa-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9500;display:flex;align-items:center;justify-content:center;padding:16px}' +
      '.pwa-dialog{background:var(--card,#fff);color:var(--text,#111);border-radius:12px;max-width:560px;width:100%;max-height:82vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.3)}' +
      '.pwa-head{padding:14px 18px;border-bottom:1px solid var(--border,#3333);font-weight:600}' +
      '.pwa-body{padding:10px 18px;overflow-y:auto;flex:1}' +
      '.pwa-group{font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;opacity:.6;margin:.6rem 0 .25rem}' +
      '.pwa-row{display:flex;gap:.5rem;align-items:baseline;padding:.2rem 0;font-size:.9rem}' +
      '.pwa-row .pwa-src{font-size:.72rem;opacity:.6;white-space:nowrap}' +
      '.pwa-foot{padding:12px 18px;border-top:1px solid var(--border,#3333);display:flex;gap:.6rem;justify-content:flex-end}' +
      '.pwa-foot button{padding:.45rem 1rem;border-radius:8px;border:1px solid var(--border,#3333);background:transparent;cursor:pointer}' +
      '.pwa-foot .pwa-insert{background:var(--primary,#2563eb);border-color:var(--primary,#2563eb);color:#fff;font-weight:600}' +
      '.pwa-empty{opacity:.65;padding:1rem 0}';
    document.head.appendChild(st);
    _css = true;
  }

  /** Open the review dialog for a week. opts.onInsert(items) receives
   * ready-to-append PMR week items (id/status/text/links/backref merged). */
  async function open(wk, doc, opts) {
    var start = wk.date_range_start, end = wk.date_range_end || start;
    if (!start) { if (window.TOAST) TOAST.warn('Set the week’s start date first'); return; }
    ensureCss();
    var refs = existingRefs(doc);

    var nb = await gatherNotebook(start, end, refs);
    var tr = await gatherTracker(start, end, refs);
    var already = {};
    nb.concat(tr).forEach(function (c) { already[c.key] = 1; });
    var st = await gatherSubtasks(start, end, refs);
    var dp = await gatherDayPlans(start, end, refs, already);
    var candidates = nb.concat(st, dp, tr).filter(function (c) { return String(c.text || '').trim(); });

    var overlay = document.createElement('div');
    overlay.className = 'pwa-overlay';
    var bySub = {};
    candidates.forEach(function (c, i) { c._i = i; (bySub[c.subsection] = bySub[c.subsection] || []).push(c); });
    var bodyHtml = candidates.length
      ? Object.keys(bySub).map(function (subName) {
          return '<div class="pwa-group">' + esc(subName) + '</div>' + bySub[subName].map(function (c) {
            return '<label class="pwa-row"><input type="checkbox" checked data-i="' + c._i + '">' +
              '<span>' + esc(c.text) + '</span><span class="pwa-src">' + c.source + '</span></label>';
          }).join('');
        }).join('')
      : '<div class="pwa-empty">Nothing new found for ' + esc(start) + ' → ' + esc(end) + ' — everything from your notebook, tracker, tasks and My Week is already in this PMR.</div>';

    overlay.innerHTML =
      '<div class="pwa-dialog">' +
        '<div class="pwa-head">' + ICON.svg('arrow-down-tray') + ' Assemble week ' + esc(start) + ' → ' + esc(end) + '</div>' +
        '<div class="pwa-body">' + bodyHtml + '</div>' +
        '<div class="pwa-foot">' +
          '<button type="button" class="pwa-cancel">Cancel</button>' +
          (candidates.length ? '<button type="button" class="pwa-insert">Insert checked</button>' : '') +
        '</div>' +
      '</div>';

    overlay.addEventListener('click', function (ev) {
      if (ev.target === overlay || ev.target.classList.contains('pwa-cancel')) overlay.remove();
    });
    var insertBtn = overlay.querySelector('.pwa-insert');
    if (insertBtn) insertBtn.addEventListener('click', function () {
      var picked = Array.from(overlay.querySelectorAll('input[type=checkbox]:checked')).map(function (cb) {
        return candidates[+cb.getAttribute('data-i')];
      });
      var items = picked.map(function (c) {
        return {
          bySubsection: c.subsection,
          item: Object.assign({
            id: newId('it'),
            status: c.status,
            text: c.text,
            links: c.links || [],
          }, c.backref),
        };
      });
      overlay.remove();
      if (items.length && opts && typeof opts.onInsert === 'function') opts.onInsert(items);
    });
    document.body.appendChild(overlay);
  }

  window.PMR_WEEK_ASSEMBLE = { open: open };
})();

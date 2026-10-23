/* paper-values.js — "🔑 Values" page of the paper builder (V3.645).
 *
 * A per-paper table of named values the writer references from prose
 * instead of retyping. Two token families read this ONE table:
 *
 *   [!val:KEY]    a paper-local value   (kind 'text' | 'number')
 *   [@item:KEY]   a lab inventory item  (kind 'inventory')
 *
 * The namespace split follows the rule the builder already uses:
 * `[@…]` points OUT at a shared lab record (library, inventory) and
 * `[!…]` points at something inside this paper (fig/sec/eq/val).
 *
 * Why one table for both: they differ only in where the printed text
 * comes from. Sharing the table means one usage index, one picker, one
 * export pass — and no chance of the two drifting apart.
 *
 * Inventory entries store a SNAPSHOT of the row rather than resolving
 * live. See paper-schemas.js for the three reasons (size, archival
 * correctness, and inventory being isLabMember()-read-only).
 *
 * Contract mirrors paper-symbols.js: loaded before paper-equations.js,
 * which calls PaperValues.buildTabContent(root) from _refreshPanel when
 * the Values page is active (idempotent).
 *
 * Public API (window.PaperValues):
 *   buildTabContent(rootEl)   → render/re-render the page
 *   openInsertPicker(anchor)  → the "+ Value" toolbar picker
 */
(function () {
  'use strict';

  var _root = null;
  var _expanded = Object.create(null);   // key → usage fold-out open?
  var _wired = false;

  function PE() { return window.PaperEditor; }
  function PS() { return window.PaperSchemas; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  /* Icon markup must never be routed through esc()/textContent — the
   * release gate (scripts/gen-icons.mjs --scan) fails the build on that.
   * Falls back to a glyph if icons.js hasn't loaded. */
  function icon(name) {
    try {
      if (window.ICON && window.ICON.render) return window.ICON.render(name);
    } catch (e) { /* fall through */ }
    return '\u21bb';
  }

  /* V3.648 — messages go to the corner toast, never a browser alert(). */
  function say(kind, msg) {
    if (window.TOAST && window.TOAST[kind]) { window.TOAST[kind](msg); return; }
    console.warn('[paper-values] ' + msg);
  }

  function entries() {
    var pe = PE();
    return (pe && pe.getValueEntries) ? pe.getValueEntries() : [];
  }

  function usages() {
    var pe = PE();
    return (pe && pe.getKeyUsages) ? pe.getKeyUsages() : {};
  }

  function tokenFor(e) {
    return e.kind === 'inventory' ? ('[@item:' + e.key + ']') : ('[!val:' + e.key + ']');
  }

  /* Duplicate keys can't be prevented in a CRDT (two people can add the
   * same key offline), so surface them instead of silently resolving. */
  function duplicateKeys(list) {
    var seen = Object.create(null), dup = Object.create(null);
    list.forEach(function (e) {
      if (!e.key) return;
      if (seen[e.key]) dup[e.key] = true;
      seen[e.key] = true;
    });
    return dup;
  }

  /* ── Rendering ────────────────────────────────────────────────── */

  function buildTabContent(rootEl) {
    if (!rootEl) return;
    _root = rootEl;
    if (!_wired) {
      _wired = true;
      /* A chip clicked in prose opens that key's fold-out here. */
      window.addEventListener('paper-value-chip-click', function (ev) {
        var key = ev && ev.detail && ev.detail.key;
        if (!key) return;
        _expanded[key] = true;
        if (window.PaperEquations && window.PaperEquations.gotoPage) {
          window.PaperEquations.gotoPage('values');
        }
        render();
        var row = _root && _root.querySelector('[data-val-row="' + CSS.escape(key) + '"]');
        if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center' });
      });
      window.addEventListener('paper-values-changed', function () { if (_root) render(); });
    }
    render();
  }

  function render() {
    if (!_root) return;
    var list = entries();
    var use = usages();
    var dup = duplicateKeys(list);

    var html = '';
    html += '<div class="pe-equations-section">';
    html += '<div class="pe-equations-head">';
    html += '<span class="pe-equations-title">Value keys</span>';
    html += '<span class="pe-equations-hint">Write a key once, define it here, and every mention resolves to it.</span>';
    html += '</div>';

    html += '<div style="margin:6px 0 10px;display:flex;gap:6px;flex-wrap:wrap;">';
    html += '<button type="button" class="btn btn-sm" data-act="add-text">+ Text value</button>';
    html += '<button type="button" class="btn btn-sm" data-act="add-number">+ Number &amp; unit</button>';
    html += '<button type="button" class="btn btn-sm" data-act="add-item">+ Inventory item…</button>';
    html += '</div>';

    if (!list.length) {
      html += '<div class="pe-equations-empty">No value keys yet. Add one, then type its token in your prose — ' +
              'or use <strong>+ Value</strong> on the toolbar to pick and insert in one step.</div>';
    } else {
      html += '<table class="pe-val-table"><thead><tr>' +
              '<th>Key</th><th>Kind</th><th>Resolves to</th><th>Note</th><th>Used</th><th></th>' +
              '</tr></thead><tbody>';
      list.forEach(function (e) {
        var resolved = PS().formatValueEntry(e);
        var n = (use[e.key] || []).length;
        html += '<tr data-val-row="' + esc(e.key) + '" data-id="' + esc(e.id) + '">';
        html += '<td><span class="pe-val-key">' + esc(e.key || '(unnamed)') + '</span>' +
                (dup[e.key] ? '<span class="pe-val-dup">duplicate</span>' : '') +
                '<br><span class="pe-val-token">' + esc(tokenFor(e)) + '</span></td>';
        html += '<td><span class="pe-val-kind pe-val-kind-' + esc(e.kind) + '">' + esc(e.kind) + '</span></td>';
        html += '<td>' + (resolved
          ? '<span class="pe-val-resolved">' + esc(resolved) + '</span>'
          : '<span class="pe-val-resolved-empty">(empty)</span>');
        if (e.kind === 'inventory' && e.snapshot && e.snapshot.name) {
          html += '<br><span class="pe-val-inv-meta">' + esc(e.snapshot.name) + '</span>';
        }
        html += '</td>';
        html += '<td><span class="pe-val-note">' + esc(e.note) + '</span></td>';
        html += '<td>' + (n
          ? '<button type="button" class="pe-val-uses" data-act="uses" data-key="' + esc(e.key) + '">' +
            n + (n === 1 ? ' use' : ' uses') + '</button>'
          : '<span class="pe-val-uses pe-val-uses-none">0 uses</span>') + '</td>';
        html += '<td style="white-space:nowrap;">' +
                '<button type="button" class="btn btn-sm" data-act="insert" data-id="' + esc(e.id) + '">Insert</button> ' +
                '<button type="button" class="btn btn-sm" data-act="edit" data-id="' + esc(e.id) + '">Edit</button> ' +
                (e.kind === 'inventory'
                  ? '<button type="button" class="btn btn-sm" data-act="refresh" data-id="' + esc(e.id) +
                    '" title="Re-pull this row from the lab inventory">' + icon('arrow-path') + '</button> '
                  : '') +
                '<button type="button" class="btn btn-sm" data-act="delete" data-id="' + esc(e.id) + '">✕</button>' +
                '</td>';
        html += '</tr>';

        if (_expanded[e.key]) {
          var rows = use[e.key] || [];
          html += '<tr><td colspan="6"><div class="pe-val-usage-wrap">';
          if (!rows.length) {
            html += '<div class="pe-val-usage-empty">This key isn\'t used anywhere in the paper yet.</div>';
          } else {
            rows.forEach(function (u) {
              html += '<div class="pe-val-usage-row" data-act="jump" data-block="' + esc(u.blockId) + '">' +
                      '<span class="pe-val-usage-where">' + esc(u.sectionLabel || '') +
                      (u.field && u.field !== 'body' ? ' · ' + esc(u.field) : '') + '</span>' +
                      '<span class="pe-val-usage-sentence">' + highlightToken(u.sentence, u.token) + '</span>' +
                      '</div>';
            });
          }
          html += '</div></td></tr>';
        }
      });
      html += '</tbody></table>';
    }
    html += '</div>';
    _root.innerHTML = html;
    wire();
  }

  /* Show the sentence with the key's own token marked, so it's obvious
   * which mention this row is about when a sentence uses several. */
  function highlightToken(sentence, token) {
    var s = esc(sentence || '');
    var t = esc(token || '');
    if (!t) return s;
    return s.split(t).join('<strong>' + t + '</strong>');
  }

  /* ── Interaction ──────────────────────────────────────────────── */

  function wire() {
    if (!_root) return;
    _root.querySelectorAll('[data-act]').forEach(function (el) {
      el.addEventListener('click', function (ev) {
        ev.preventDefault();
        var act = el.dataset.act;
        var id = el.dataset.id;
        /* V3.648 — all three open the inline form anchored under the button
         * that was clicked. None of them is a browser prompt any more. */
        if (act === 'add-text') return openValueForm(el, 'text', null);
        if (act === 'add-number') return openValueForm(el, 'number', null);
        if (act === 'add-item') return pickInventory(null);
        if (act === 'uses') {
          var k = el.dataset.key;
          _expanded[k] = !_expanded[k];
          return render();
        }
        if (act === 'edit') {
          var ex = byId(id);
          return ex ? openValueForm(el, ex.kind, ex) : undefined;
        }
        if (act === 'delete') return deleteEntry(id, el);
        if (act === 'refresh') return refreshFromInventory(id);
        if (act === 'insert') return insertById(id);
        if (act === 'jump') return jumpToBlock(el.dataset.block);
      });
    });
  }

  function byId(id) {
    var all = entries();
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }

  /* ── The value form ───────────────────────────────────────────────
   *
   * V3.648 — every field the writer has to fill in lives in ONE inline form
   * rendered inside the picker dropdown. It replaces the chain of five
   * window.prompt() boxes this used to be. Alex: "i dont want the options to
   * be popups from the browser, i want all the options to be in the 'insert
   * a value' menu that drops down. Never have an input popup anywhere."
   *
   * `formSpec` describes the form; `applyForm` turns its values into an
   * entry. They are separate so the picker (create-and-insert) and the
   * Values page (add / edit in place) share one definition and cannot drift.
   */
  function formSpec(kind, existing, seedKey, opts) {
    opts = opts || {};
    var fields = [{
      key: 'key',
      label: 'Key',
      value: existing ? existing.key : (seedKey || ''),
      placeholder: 'N2TError',
      hint: 'The short name you type in your prose. Letters, digits, _ and -.',
    }];

    if (kind === 'number') {
      fields.push({
        key: 'num', label: 'Number',
        value: (existing && existing.num != null) ? String(existing.num) : '',
        placeholder: '0.5',
        hint: 'Digits only — the unit is its own field.',
      });
      fields.push({
        key: 'unit', label: 'Unit',
        value: (existing && existing.unit) || '',
        placeholder: 'µm',
        hint: 'Leave blank for none.',
      });
      fields.push({
        key: 'sigfigs', label: 'Significant figures',
        value: (existing && existing.sigfigs) ? String(existing.sigfigs) : '',
        placeholder: 'as typed',
        hint: 'Leave blank to print the number exactly as you typed it.',
      });
    } else if (kind === 'text') {
      fields.push({
        key: 'value', label: 'Value',
        value: (existing && existing.value) || '',
        placeholder: 'four-density series',
        hint: 'Printed exactly as typed.',
      });
    } else if (kind === 'inventory') {
      fields.push({
        key: 'format', label: 'How it prints',
        value: (existing && existing.format) || PS().DEFAULT_ITEM_FORMAT,
        placeholder: PS().DEFAULT_ITEM_FORMAT,
        hint: '{vendor}, {catalogue_number} and {name} are filled from the inventory row.',
      });
    }

    fields.push({
      key: 'note', label: 'Note',
      value: (existing && existing.note) || '',
      placeholder: 'why this number is what it is',
      hint: 'For you and your co-authors — never printed.',
    });

    var titles = {
      text: existing ? 'Edit text value' : 'New text value',
      number: existing ? 'Edit number & unit' : 'New number & unit',
      inventory: existing ? 'Edit inventory reference' : 'New inventory reference',
    };

    return {
      title: opts.title || titles[kind] || 'Value',
      fields: fields,
      submitLabel: opts.submitLabel || (existing ? 'Save' : 'Add & insert'),
      backLabel: opts.backLabel || 'Back',
      validate: function (vals) { return validateForm(vals, kind, existing); },
    };
  }

  /* Returns null when the values are usable, or {field, message} naming the
   * field to focus — the picker renders it beside that input. */
  function validateForm(vals, kind, existing) {
    var key = String(vals.key || '').trim();
    if (!key) {
      return { field: 'key', message: 'Give it a key — that is what you type in your prose.' };
    }
    if (!PS().isValidValueKey(key)) {
      return { field: 'key', message: '"' + key + '" is not a usable key. Letters, digits, _ or - with no spaces.' };
    }
    /* A duplicate key silently shadows the other one at render time, so catch
     * it here rather than letting two entries answer to the same token. */
    var clash = entries().filter(function (e) {
      return e.key === key && (!existing || e.id !== existing.id);
    })[0];
    if (clash) {
      return { field: 'key', message: '"' + key + '" is already used by another value. Pick a different key.' };
    }
    if (kind === 'number') {
      var raw = String(vals.num || '').trim();
      if (!raw) return { field: 'num', message: 'Enter the number.' };
      if (!isFinite(Number(raw))) {
        return { field: 'num', message: '"' + raw + '" is not a number.' };
      }
      var sf = String(vals.sigfigs || '').trim();
      if (sf && !(isFinite(Number(sf)) && Number(sf) > 0)) {
        return { field: 'sigfigs', message: 'Significant figures must be a positive number, or blank.' };
      }
    }
    return null;
  }

  /* Writes the entry and returns its key. `existing` may be null (create). */
  function applyForm(vals, kind, existing, extra) {
    var patch = { key: String(vals.key || '').trim(), kind: kind };
    if (kind === 'number') {
      patch.num = Number(String(vals.num).trim());
      patch.unit = String(vals.unit || '').trim();
      var sf = String(vals.sigfigs || '').trim();
      patch.sigfigs = sf ? Number(sf) : null;
    } else if (kind === 'text') {
      patch.value = vals.value == null ? '' : String(vals.value);
    } else if (kind === 'inventory') {
      patch.format = vals.format == null ? PS().DEFAULT_ITEM_FORMAT : String(vals.format);
    }
    patch.note = vals.note == null ? '' : String(vals.note);
    if (extra) Object.keys(extra).forEach(function (k) { patch[k] = extra[k]; });

    if (existing) PE().updateValueEntry(existing.id, patch);
    else PE().addValueEntry(patch);
    render();
    return patch.key;
  }

  /* Open the form as a standalone dropdown anchored to `anchorEl` — used by
   * the Values page's add / edit buttons, so they get the same inline editor
   * the picker uses rather than a browser prompt. */
  function openValueForm(anchorEl, kind, existing, opts) {
    var EQ = window.PaperEquations;
    if (!EQ || !EQ.openPicker) return;
    opts = opts || {};
    var r = anchorEl && anchorEl.getBoundingClientRect
      ? anchorEl.getBoundingClientRect() : null;
    var x = r ? r.left : (window.innerWidth / 2 - 160);
    var y = r ? (r.bottom + 4) : (window.innerHeight / 2 - 140);
    var spec = formSpec(kind, existing, opts.seedKey, {
      submitLabel: existing ? 'Save' : 'Add',
      backLabel: 'Cancel',
    });
    spec.onSubmit = function (vals, handle) {
      var key = applyForm(vals, kind, existing, opts.extra);
      handle.close();
      if (opts.onSaved) opts.onSaved(key);
    };
    EQ.openPicker(x, y, {
      title: spec.title,
      emptyMsg: '',
      renderRowMode: 'plain',
      rows: [],
      form: spec,
    });
  }

  /* V3.648 — the delete guard is an anchored panel in the same dropdown
   * chrome as the form, not window.confirm(). The guard itself stays: a
   * key in use is load-bearing, and the count is the thing worth reading
   * before you agree. `anchorEl` is the ✕ that was clicked. */
  function deleteEntry(id, anchorEl) {
    var e = byId(id);
    if (!e) return;
    var EQ = window.PaperEquations;
    var n = (usages()[e.key] || []).length;
    var msg = n
      ? 'It is used in ' + n + ' place' + (n === 1 ? '' : 's') + '. Those mentions will ' +
        'show as unresolved until you define the key again or edit the prose.'
      : 'It is not used anywhere in the paper yet.';
    if (!EQ || !EQ.openPicker) { PE().deleteValueEntry(id); render(); return; }
    var r = anchorEl && anchorEl.getBoundingClientRect
      ? anchorEl.getBoundingClientRect() : null;
    EQ.openPicker(
      r ? r.left : (window.innerWidth / 2 - 160),
      r ? (r.bottom + 4) : (window.innerHeight / 2 - 100),
      {
        title: 'Delete "' + e.key + '"?',
        emptyMsg: '', renderRowMode: 'plain', rows: [],
        form: {
          title: 'Delete "' + e.key + '"?',
          fields: [],
          note: msg,
          submitLabel: 'Delete',
          backLabel: 'Cancel',
          danger: true,
          onSubmit: function (vals, handle) {
            PE().deleteValueEntry(id);
            render();
            handle.close();
          },
        },
      }
    );
  }

  /* ── Inventory ────────────────────────────────────────────────── */

  /* The inventory is ~1 MB / 3,481 rows, so it loads HERE and nowhere
   * else — never on the paper-open or render path. PROTOCOL_INVENTORY
   * memoizes and in-flight-dedups the load, and merges items with
   * chemicals (a plate and an FBS bottle live in different routes). */
  function pickInventory(existingId) {
    var INV = window.PROTOCOL_INVENTORY;
    if (!INV || !INV.openPicker) {
      say('error', 'The inventory picker is not loaded on this page.');
      return;
    }
    INV.openPicker({
      anchorEl: _root,
      onPick: function (item) {
        if (!item) return;
        var snap = {
          name: item.name || '',
          vendor: item.vendor || '',
          catalogue_number: item.cat || item.catalogue_number || '',
        };
        if (existingId) {
          PE().updateValueEntry(existingId, {
            inv_id: item.id || '', inv_kind: item.kind === 'chemical' ? 'chemical' : 'item',
            snapshot: snap, refreshed_at: new Date().toISOString(),
          });
          render();
          return;
        }
        /* V3.648 — the key (and how it prints) are asked for in the inline
         * form, seeded from the item's name, instead of a prompt box. */
        openValueForm(_root, 'inventory', null, {
          seedKey: suggestKey(item),
          extra: {
            inv_id: item.id || '',
            inv_kind: item.kind === 'chemical' ? 'chemical' : 'item',
            snapshot: snap,
            refreshed_at: new Date().toISOString(),
          },
        });
      },
    });
  }

  /* A starting point only — the author almost always wants something
   * shorter (Alex's own keys are "24WP", "FBS_CC"). */
  function suggestKey(item) {
    var base = String(item.name || item.cat || '')
      .replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/)
      .map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); })
      .join('').slice(0, 20);
    return base || 'ITEM';
  }

  function refreshFromInventory(id) {
    var e = byId(id);
    if (!e) return;
    var INV = window.PROTOCOL_INVENTORY;
    if (!INV || !INV.ensureList) return;
    INV.ensureList().then(function () {
      var hit = INV.findById && INV.findById(e.inv_id);
      if (!hit) {
        say('warn', 'Inventory row ' + e.inv_id + ' no longer exists. Your paper keeps ' +
          'printing the snapshot it saved, so nothing in the manuscript changed — use ' +
          '"+ Inventory item…" to point this key at a new row.');
        return;
      }
      PE().updateValueEntry(id, {
        snapshot: {
          name: hit.name || '',
          vendor: hit.vendor || '',
          catalogue_number: hit.cat || hit.catalogue_number || '',
        },
        refreshed_at: new Date().toISOString(),
      });
      render();
    });
  }

  /* ── Insertion ────────────────────────────────────────────────── */

  function insertById(id) {
    var e = byId(id);
    if (!e || !e.key) return;
    var EQ = window.PaperEquations;
    if (EQ && EQ.insertAtCaret) EQ.insertAtCaret(tokenFor(e));
  }

  /* The "+ Value" toolbar picker: defined keys first, then a row that
   * hands off to the inventory search. Defining and inserting are one
   * action — picking an inventory item that has no key yet prompts for
   * one and inserts the token immediately. */
  /* `opts.x` / `opts.y` place the picker at an explicit viewport point
   * (V3.647 — the paragraph right-click menu opens it where the writer
   * right-clicked; the toolbar button still anchors under itself). */
  function openInsertPicker(anchorEl, opts) {
    var EQ = window.PaperEquations;
    if (!EQ || !EQ.openPicker) return;
    var list = entries();
    var rows = list.map(function (e) {
      var resolved = PS().formatValueEntry(e) || '(empty)';
      return {
        name: e.key + ' — ' + resolved,
        searchKey: (e.key + ' ' + resolved + ' ' + (e.note || '') + ' ' +
                    ((e.snapshot && e.snapshot.name) || '')).toLowerCase(),
        insert: tokenFor(e),
      };
    });
    /* V3.647 — defining a value and referencing it are now ONE action.
     * Before this, a key that didn't exist yet dead-ended the picker: the
     * writer had to leave the sentence, open the Values page, add the key,
     * come back and find the spot again. These rows are `always: true` so
     * they survive filtering — they are exactly what you want when the
     * search box matches nothing — and they seed the key prompt with what
     * was typed, so "N2TError" + Enter is the whole interaction. */
    function seedFrom(q) {
      var t = String(q || '').trim();
      return (t && PS().isValidValueKey(t)) ? t : '';
    }
    function newRow(kind, label) {
      return {
        name: function (q) {
          var seed = seedFrom(q);
          return seed ? ('＋ ' + label + ' “' + seed + '”…') : ('＋ ' + label + '…');
        },
        searchKey: 'new create add define ' + label.toLowerCase(),
        always: true,
        keepOpen: true,   // V3.648 — the form opens IN this dropdown
        _new: kind,
      };
    }
    rows.push(newRow('text', 'New text value'));
    rows.push(newRow('number', 'New number & unit'));
    rows.push({
      name: 'Search the lab inventory…',
      icon: 'magnifying-glass',
      searchKey: 'inventory search item chemical reagent vendor catalog',
      always: true,
      _inv: true,
    });

    var r = anchorEl && anchorEl.getBoundingClientRect
      ? anchorEl.getBoundingClientRect() : null;
    var x = (opts && typeof opts.x === 'number') ? opts.x
      : (r ? r.left : (window.innerWidth / 2 - 160));
    var y = (opts && typeof opts.y === 'number') ? opts.y
      : (r ? (r.bottom + 4) : (window.innerHeight / 2 - 100));

    EQ.openPicker(x, y, {
      title: 'Insert a value',
      emptyMsg: 'No value keys yet — define one below or search the inventory.',
      renderRowMode: 'plain',
      rows: rows,
      onPick: function (row, query, handle) {
        /* V3.648 — `keepOpen` rows never dismissed the popover, so this
         * swaps the list for the form in the SAME dropdown. Saving writes
         * the entry, inserts its token at the caret, and closes. */
        if (row._new) {
          var spec = formSpec(row._new, null, seedFrom(query));
          spec.onSubmit = function (vals, h) {
            var key = applyForm(vals, row._new, null);
            h.close();
            if (key && EQ.insertAtCaret) EQ.insertAtCaret('[!val:' + key + ']');
          };
          handle.showForm(spec);
          return;
        }
        if (row._inv) return insertViaInventory();
        if (row.insert) EQ.insertAtCaret(row.insert);
      },
    });
  }

  function insertViaInventory() {
    var INV = window.PROTOCOL_INVENTORY;
    var EQ = window.PaperEquations;
    if (!INV || !INV.openPicker) {
      say('error', 'The inventory picker is not loaded on this page.');
      return;
    }
    INV.openPicker({
      onPick: function (item) {
        if (!item) return;
        /* Already keyed in this paper? Reuse it rather than making a
         * second key for the same row. */
        var all = entries();
        for (var i = 0; i < all.length; i++) {
          if (all[i].kind === 'inventory' && all[i].inv_id === item.id) {
            if (EQ && EQ.insertAtCaret) EQ.insertAtCaret(tokenFor(all[i]));
            return;
          }
        }
        /* V3.648 — key + print-format via the inline form; on save the
         * token goes straight into the sentence. */
        openValueForm(null, 'inventory', null, {
          seedKey: suggestKey(item),
          extra: {
            inv_id: item.id || '',
            inv_kind: item.kind === 'chemical' ? 'chemical' : 'item',
            snapshot: {
              name: item.name || '',
              vendor: item.vendor || '',
              catalogue_number: item.cat || item.catalogue_number || '',
            },
            refreshed_at: new Date().toISOString(),
          },
          onSaved: function (key) {
            if (key && EQ && EQ.insertAtCaret) EQ.insertAtCaret('[@item:' + key + ']');
          },
        });
      },
    });
  }

  function jumpToBlock(blockId) {
    if (!blockId) return;
    var el = document.querySelector('.pe-block[data-block-id="' + CSS.escape(blockId) + '"]');
    if (el && el.scrollIntoView) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('pe-block-flash');
      setTimeout(function () { el.classList.remove('pe-block-flash'); }, 1200);
    }
  }

  window.PaperValues = {
    buildTabContent: buildTabContent,
    openInsertPicker: openInsertPicker,
  };
})();

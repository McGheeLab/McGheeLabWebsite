/* protocol-inventory.js — V3.121 Phase 3 of the Protocols Builder.
 *
 * Inventory picker + token resolver for protocols. Loads
 * inventory/items.json + inventory/chemicals.json (merged + sorted by
 * name, chemicals first since they're the more frequent bench
 * reference) and exposes:
 *
 *   PROTOCOL_INVENTORY.ensureList()              → Promise<[entry]>
 *   PROTOCOL_INVENTORY.findById(id)              → entry | null
 *   PROTOCOL_INVENTORY.openPicker({onPick, ...}) → opens floating popover
 *   PROTOCOL_INVENTORY.formatLabel(entry)        → "Name (vendor, cat. …)"
 *   PROTOCOL_INVENTORY.formatStockChipHtml(entry)→ HTML for stock chip
 *   PROTOCOL_INVENTORY.renderTextWithTokens(t, byId) → HTML w/ [!inv:<id>]
 *                                                       chips substituted
 *   PROTOCOL_INVENTORY.textHasTokens(t)          → bool
 *   PROTOCOL_INVENTORY.TOKEN_RE                  → regex
 *
 * Tech debt: lab-notebook V3.114 and paper-editor V3.108 each have
 * their own copies of the same picker pattern. A follow-on cleanup
 * phase can extract a shared `rm/js/inventory-picker.js`.
 */

(function () {
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ── Cached list ─────────────────────────────────────────── */

  var _state = {
    list: null,         // [entry]
    byId: null,         // map id → entry
    listPromise: null,  // in-flight load promise
    popover: null,
  };

  function _projectEntry(it, kind) {
    var safety = (kind === 'chemical' && it.safety) || {};
    var cas = safety.cas_number || '';
    var formula = safety.formula || '';
    return {
      id: it.id,
      kind: kind,
      name: it.name || '',
      vendor: it.vendor || '',
      cat: it.catalogue_number || '',
      cas: cas,
      formula: formula,
      desc: it.description || '',
      category: it.category || '',
      subcategory: it.subcategory || '',
      stock_status: it.stock_status || '',     // 'full' | 'low' | 'out_of_stock' | 'n/a' | ''
      quantity: it.quantity || '',              // chemicals: string e.g. "500 mL"
      condition: it.condition || '',            // items: 'active' | 'broken' | 'retired' | 'lost'
      search: ((it.name || '') + ' ' + (it.vendor || '') + ' ' +
               (it.catalogue_number || '') + ' ' + cas + ' ' +
               formula + ' ' + (it.description || '') + ' ' +
               (it.category || '') + ' ' + (it.subcategory || '')).toLowerCase(),
    };
  }

  async function ensureList() {
    if (_state.list) return _state.list;
    if (_state.listPromise) return _state.listPromise;
    _state.listPromise = (async function () {
      try {
        var both = await Promise.all([
          api.load('inventory/items.json').catch(function (e) {
            console.warn('[protocol-inventory] items load failed:', e && e.message);
            return null;
          }),
          api.load('inventory/chemicals.json').catch(function (e) {
            console.warn('[protocol-inventory] chemicals load failed:', e && e.message);
            return null;
          }),
        ]);
        var items = ((both[0] && both[0].items) || []).map(function (it) {
          return _projectEntry(it, 'item');
        });
        var chems = ((both[1] && both[1].chemicals) || []).map(function (it) {
          return _projectEntry(it, 'chemical');
        });
        function byName(a, b) {
          return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
        }
        chems.sort(byName);
        items.sort(byName);
        _state.list = chems.concat(items);
        _state.byId = Object.create(null);
        _state.list.forEach(function (e) { if (e.id) _state.byId[e.id] = e; });
        // Notify token bindings + materials cells that the list is now
        // available so they can re-render any unresolved chips.
        try {
          document.dispatchEvent(new CustomEvent('protocol-inventory-loaded', {
            detail: { count: _state.list.length },
          }));
        } catch (e) { /* ignore */ }
        return _state.list;
      } catch (err) {
        console.warn('[protocol-inventory] ensureList failed:', err && err.message);
        _state.list = [];
        _state.byId = Object.create(null);
        return _state.list;
      } finally {
        _state.listPromise = null;
      }
    })();
    return _state.listPromise;
  }

  function findById(id) {
    if (!id) return null;
    if (!_state.byId) return null;
    return _state.byId[id] || null;
  }

  /* V3.139 — Pure scoring function for the component-matching wizard.
   * Returns the top N inventory entries that could plausibly be what
   * the protocol's `free_text` is referring to. No UI; consumed by the
   * matcher modal in protocol-import.js.
   *
   * Scoring (additive, higher = better):
   *   +15  catalogue number appears verbatim in free_text
   *   +15  CAS number appears verbatim in free_text (chemicals only)
   *   +10  entry's name appears as a case-insensitive substring of
   *        free_text OR vice versa (the longer wins)
   *    +8  vendor appears in free_text
   *    +3  formula (chemical) appears in free_text
   *    +2  category or subcategory appears in free_text
   *   tie-break by stock_status: 'full' > 'low' > '' > 'out_of_stock'.
   *
   * Returns [{entry, score, reasons:[…]}] sorted desc, capped at
   * opts.limit (default 5). Score 0 entries are dropped. */
  function findMatches(freeText, opts) {
    opts = opts || {};
    var limit = typeof opts.limit === 'number' ? opts.limit : 5;
    if (!freeText || !_state.list || !_state.list.length) return [];
    var hay = String(freeText).toLowerCase();

    function _stockTieBreak(stock) {
      switch (stock) {
        case 'full': return 3;
        case 'low':  return 2;
        case 'out_of_stock': return 0;
        default: return 1;
      }
    }

    var scored = [];
    _state.list.forEach(function (e) {
      var score = 0;
      var reasons = [];

      if (e.cat && e.cat.length >= 3) {
        if (hay.indexOf(String(e.cat).toLowerCase()) >= 0) {
          score += 15;
          reasons.push('cat. ' + e.cat);
        }
      }
      if (e.cas && e.cas.length >= 3) {
        if (hay.indexOf(String(e.cas).toLowerCase()) >= 0) {
          score += 15;
          reasons.push('CAS ' + e.cas);
        }
      }
      if (e.name && e.name.length >= 3) {
        var n = String(e.name).toLowerCase();
        if (hay.indexOf(n) >= 0) {
          score += 10;
          reasons.push('name match');
        } else if (n.indexOf(hay) >= 0 && hay.length >= 3) {
          // Source text is a substring of the inventory name (e.g.
          // "agarose" → "Agarose, Low EEO"). Slightly weaker.
          score += 7;
          reasons.push('name match (partial)');
        }
      }
      if (e.vendor && e.vendor.length >= 2) {
        if (hay.indexOf(String(e.vendor).toLowerCase()) >= 0) {
          score += 8;
          reasons.push(e.vendor);
        }
      }
      if (e.formula && e.formula.length >= 2) {
        if (hay.indexOf(String(e.formula).toLowerCase()) >= 0) {
          score += 3;
          reasons.push('formula');
        }
      }
      if (e.category && e.category.length >= 2) {
        if (hay.indexOf(String(e.category).toLowerCase()) >= 0) {
          score += 2;
        }
      }
      if (e.subcategory && e.subcategory.length >= 2) {
        if (hay.indexOf(String(e.subcategory).toLowerCase()) >= 0) {
          score += 2;
        }
      }

      if (score > 0) {
        scored.push({ entry: e, score: score, reasons: reasons });
      }
    });

    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return _stockTieBreak(b.entry.stock_status) - _stockTieBreak(a.entry.stock_status);
    });
    return scored.slice(0, limit);
  }

  /* ── Display helpers ─────────────────────────────────────── */

  function formatLabel(entry) {
    if (!entry) return '?';
    var parts = [];
    if (entry.vendor) parts.push(entry.vendor);
    if (entry.cat) parts.push('cat. ' + entry.cat);
    if (entry.kind === 'chemical' && entry.cas) parts.push('CAS ' + entry.cas);
    if (parts.length) return entry.name + ' (' + parts.join(', ') + ')';
    return entry.name || '(no name)';
  }

  function _stockSeverity(entry) {
    if (!entry) return '';
    if (entry.kind === 'item') {
      if (entry.condition === 'broken' || entry.condition === 'lost') return 'out';
      if (entry.stock_status === 'out_of_stock') return 'out';
      if (entry.stock_status === 'low') return 'low';
      if (entry.stock_status === 'full') return 'full';
      return '';
    }
    // chemicals — V1 just reports presence of a quantity string. A future
    // phase can parse the quantity, sum across vendors, and check
    // expiration dates.
    if (entry.quantity) return 'full';
    return '';
  }

  function formatStockChipHtml(entry) {
    var sev = _stockSeverity(entry);
    if (!sev) return '';
    var label = '';
    var cls = 'proto-stock proto-stock-' + sev;
    if (sev === 'full') label = entry.quantity ? entry.quantity + ' on hand' : 'in stock';
    else if (sev === 'low') label = 'low';
    else if (sev === 'out') label = 'out';
    return '<span class="' + cls + '">' + escapeHtml(label) + '</span>';
  }

  /* ── Token resolver — [!inv:<id>] in step/note/safety/caption bodies ── */

  var TOKEN_RE = /\[!inv:([a-zA-Z0-9][a-zA-Z0-9_-]*)\]/g;

  function textHasTokens(text) {
    if (!text) return false;
    TOKEN_RE.lastIndex = 0;
    return TOKEN_RE.test(text);
  }

  function renderTextWithTokens(text, getById) {
    if (!text) return '';
    var lookup = getById || findById;
    var html = '';
    var last = 0;
    var m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(text)) !== null) {
      html += escapeHtml(text.substring(last, m.index));
      var id = m[1];
      var entry = lookup(id);
      var label = entry ? entry.name : '?';
      var titleStr = entry ? formatLabel(entry) : ('Unknown inventory id: ' + id);
      var stockSev = entry ? _stockSeverity(entry) : '';
      var cls = 'proto-inv';
      if (!entry) cls += ' proto-inv-unknown';
      else if (stockSev === 'out') cls += ' proto-inv-out';
      else if (stockSev === 'low') cls += ' proto-inv-low';
      html += '<span class="' + cls + '" data-inv-id="' + escapeHtml(id) +
              '" title="' + escapeHtml(titleStr) +
              '" contenteditable="false">🧪 ' + escapeHtml(label) + '</span>';
      last = m.index + m[0].length;
    }
    html += escapeHtml(text.substring(last));
    return html;
  }

  /* ── Picker popover ──────────────────────────────────────── */

  function _ensurePopover() {
    if (_state.popover) return _state.popover;
    var pop = document.createElement('div');
    pop.className = 'proto-inv-pop';
    pop.hidden = true;
    pop.innerHTML =
      '<div class="proto-inv-pop-title">Pick a reagent or piece of equipment</div>' +
      '<input type="text" class="proto-inv-pop-search" placeholder="Search by name, vendor, catalog #, CAS, category…" autocomplete="off">' +
      '<div class="proto-inv-pop-list" role="listbox"></div>' +
      '<div class="proto-inv-pop-hint"><kbd>↑</kbd>/<kbd>↓</kbd> navigate · <kbd>Enter</kbd> insert · <kbd>Esc</kbd> close</div>';
    document.body.appendChild(pop);
    _state.popover = pop;

    var input = pop.querySelector('.proto-inv-pop-search');
    var listEl = pop.querySelector('.proto-inv-pop-list');
    var activeIdx = 0;
    var current = [];
    var onPickFn = null;

    pop._refresh = function () {
      var q = input.value.trim().toLowerCase();
      var src = _state.list || [];
      var matched = q
        ? src.filter(function (e) { return e.search.indexOf(q) >= 0; })
        : src.slice(0, 30);
      current = matched.slice(0, 60);
      activeIdx = current.length ? 0 : -1;
      renderList();
    };
    function renderList() {
      listEl.innerHTML = '';
      if (!current.length) {
        listEl.innerHTML = '<div class="proto-inv-pop-empty">No matching inventory items.</div>';
        return;
      }
      current.forEach(function (e, i) {
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'proto-inv-pop-row';
        if (i === activeIdx) row.classList.add('active');
        var kindBadge = '<span class="proto-inv-kind-badge proto-inv-kind-' +
          (e.kind || 'item') + '">' +
          escapeHtml(e.kind === 'chemical' ? 'chem' : 'item') +
          '</span>';
        var stock = formatStockChipHtml(e);
        var metaParts = [];
        if (e.vendor) metaParts.push(escapeHtml(e.vendor));
        if (e.cat) metaParts.push('cat. ' + escapeHtml(e.cat));
        if (e.cas) metaParts.push('CAS ' + escapeHtml(e.cas));
        if (e.formula) metaParts.push(escapeHtml(e.formula));
        if (e.category) metaParts.push(escapeHtml(e.category));
        row.innerHTML =
          '<div class="proto-inv-pop-key">' +
            kindBadge +
            '<span class="proto-inv-pop-name">' + escapeHtml(e.name || '(no name)') + '</span>' +
            stock +
          '</div>' +
          '<div class="proto-inv-pop-meta">' + metaParts.join(' · ') + '</div>';
        // V3.150 — same fix as V3.148/V3.149: do NOT renderList() on
        // mouseenter. The destroy-and-rebuild was racing the click so
        // the user's mousedown landed on the parent .proto-inv-pop-list
        // instead of the row button. Toggle .active in place.
        row.addEventListener('mouseenter', function () {
          if (activeIdx === i) return;
          activeIdx = i;
          Array.prototype.forEach.call(listEl.querySelectorAll('.proto-inv-pop-row'), function (r2, idx) {
            r2.classList.toggle('active', idx === i);
          });
        });
        row.addEventListener('mousedown', function (ev) { ev.preventDefault(); }); // keep selection
        row.addEventListener('click', function () { pickIndex(i); });
        listEl.appendChild(row);
      });
    }
    function pickIndex(i) {
      var entry = current[i];
      if (!entry) return;
      pop.hidden = true;
      try { onPickFn && onPickFn(entry); }
      catch (err) { console.warn('[protocol-inventory] onPick threw:', err); }
    }
    input.addEventListener('input', pop._refresh);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { pop.hidden = true; e.preventDefault(); return; }
      if (e.key === 'Enter')  { pickIndex(activeIdx); e.preventDefault(); return; }
      if (e.key === 'ArrowDown') {
        if (current.length) activeIdx = (activeIdx + 1) % current.length;
        renderList(); e.preventDefault();
      }
      if (e.key === 'ArrowUp') {
        if (current.length) activeIdx = (activeIdx - 1 + current.length) % current.length;
        renderList(); e.preventDefault();
      }
    });
    document.addEventListener('mousedown', function (e) {
      if (!pop.hidden && !pop.contains(e.target)) pop.hidden = true;
    });
    pop._setOnPick = function (fn) { onPickFn = fn; };
    pop._focus = function () { input.value = ''; input.focus(); };
    return pop;
  }

  /* Position the popover near `anchorEl` if given, otherwise centered. */
  function _positionPopover(pop, anchorEl) {
    if (anchorEl) {
      var r = anchorEl.getBoundingClientRect();
      pop.style.left = Math.max(8, Math.min(window.innerWidth - 360, r.left)) + 'px';
      pop.style.top  = (r.bottom + 4) + 'px';
      pop.style.transform = '';
    } else {
      pop.style.left = '50%';
      pop.style.top  = '120px';
      pop.style.transform = 'translateX(-50%)';
    }
  }

  async function openPicker(opts) {
    opts = opts || {};
    if (typeof opts.onPick !== 'function') {
      throw new Error('openPicker: onPick callback required');
    }
    await ensureList();
    var pop = _ensurePopover();
    pop._setOnPick(opts.onPick);
    _positionPopover(pop, opts.anchorEl);
    pop._refresh();
    pop.hidden = false;
    pop._focus();
  }

  window.PROTOCOL_INVENTORY = {
    ensureList: ensureList,
    findById: findById,
    findMatches: findMatches,
    openPicker: openPicker,
    formatLabel: formatLabel,
    formatStockChipHtml: formatStockChipHtml,
    renderTextWithTokens: renderTextWithTokens,
    textHasTokens: textHasTokens,
    TOKEN_RE: TOKEN_RE,
  };
})();

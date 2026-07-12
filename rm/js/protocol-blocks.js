/* protocol-blocks.js — per-kind renderers for protocol blocks (V3.113).
 *
 * Each block in the Yjs tree is a Y.Map { id, kind, status, body, attrs }
 * where `body` is a Y.Text and `attrs` is a Y.Map. For `materials`, the
 * rows live as a Y.Array<Y.Map> at attrs.get('rows').
 *
 * Renderers return a DOM element. The editor (protocol-editor.js) wires
 * lifecycle: insert/remove/move/observe. Renderers do NOT hold their own
 * subscription state — they call ctx.observeBody(yText, el) which the
 * editor manages so unmount cleanup is centralized.
 *
 * Public surface: window.ProtocolBlocks.{ renderBlock, hydrateBlockToYjs,
 * dehydrateBlock, dehydrateTree, hydrateTreeToYjs }.
 */

(function () {
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ── Y.Text ↔ contenteditable binding ────────────────────────────
   * Pragmatic V1: on Y.Text observe, replace the element's textContent
   * if it's not focused. On contenteditable input, replace Y.Text with
   * the new textContent. This loses cursor position on remote edits to
   * the focused block, but for short step bodies the trade-off is fine
   * for MVP and avoids bringing in y-prosemirror or similar.  A future
   * phase can swap this for delta-aware binding.
   */
  function bindYText(el, yText, opts) {
    opts = opts || {};
    var suppressInput = false;

    function flushFromY() {
      if (document.activeElement === el) return; // don't yank cursor on remote edits
      var s = yText.toString();
      if (el.textContent !== s) el.textContent = s;
    }
    flushFromY();

    var yObs = function (event) { flushFromY(); };
    yText.observe(yObs);

    el.addEventListener('input', function () {
      if (suppressInput) return;
      var s = el.textContent || '';
      // Replace Y.Text contents entirely. Crude but works for short bodies.
      yText.doc.transact(function () {
        if (yText.length) yText.delete(0, yText.length);
        if (s) yText.insert(0, s);
      });
      if (opts.onInput) opts.onInput();
    });

    el.addEventListener('blur', function () { flushFromY(); });

    return function unbind() { yText.unobserve(yObs); };
  }

  /* ── V3.117 — Y.Text binding with [!var:<name>] token substitution.
   * On focus the element shows the raw text (so the user can edit
   * the literal `[!var:vol]`). On blur and on initial render it shows
   * rendered HTML where each token is replaced by a chip span. Listens
   * to `protocol-vars-changed` events on document to refresh chips
   * when any formula input changes. */
  function bindYTextWithVars(el, yText, opts) {
    opts = opts || {};

    function showRendered() {
      var raw = yText.toString();
      // V3.315 — single-pass prose renderer in protocol-formulas.js
      // handles [!var:], [!inv:], [!pill:] tokens plus `code` / ~sub~ /
      // ^sup^ inline markup. Token-free plain text skips the HTML path.
      if (!window.ProtocolFormulas || !window.ProtocolFormulas.textHasProse(raw)) {
        el.textContent = raw;
        return;
      }
      el.innerHTML = window.ProtocolFormulas.renderProse(raw);
    }
    function showRaw() {
      el.textContent = yText.toString();
    }

    if (document.activeElement === el) showRaw();
    else showRendered();

    el.addEventListener('focus', showRaw);
    el.addEventListener('blur', showRendered);

    el.addEventListener('input', function () {
      // textContent strips chip spans, so this works whether the user
      // typed into raw mode or onto rendered chips. Reading textContent
      // of rendered HTML returns the chip's literal display value
      // (e.g. "0.1 g") — not what we want — so we MUST be in raw mode
      // for input. The focus listener swapped to raw on click/focus.
      var s = el.textContent || '';
      yText.doc.transact(function () {
        if (yText.length) yText.delete(0, yText.length);
        if (s) yText.insert(0, s);
      });
      if (opts.onInput) opts.onInput();
    });

    var yObs = function () {
      if (document.activeElement !== el) showRendered();
    };
    yText.observe(yObs);

    var onVarsChanged = function () {
      if (document.activeElement !== el) showRendered();
    };
    document.addEventListener('protocol-vars-changed', onVarsChanged);
    // V3.121 — inventory async load triggers a single re-render so any
    // [!inv:<id>] tokens that rendered as `?` chips on first paint can
    // resolve to real items once the list arrives.
    document.addEventListener('protocol-inventory-loaded', onVarsChanged);

    return function unbind() {
      yText.unobserve(yObs);
      document.removeEventListener('protocol-vars-changed', onVarsChanged);
      document.removeEventListener('protocol-inventory-loaded', onVarsChanged);
    };
  }

  /* ── Block controls (status pill, move, delete) ───────────────── */

  function renderControls(yBlock, ctx) {
    var wrap = document.createElement('div');
    wrap.className = 'pre-block-controls';
    if (!ctx.canEdit) return wrap; // read-only viewers see no controls

    // V3.121 — Insert inventory token. Only for blocks whose body is a
    // text Y.Text (step / note / safety / figure-caption) — materials +
    // formula blocks have their own inventory affordances and don't
    // expose this button.
    var kind = yBlock.get('kind');
    var bodyKindsWithInv = { step: 1, note: 1, safety: 1, figure: 1, callout: 1 };
    if (bodyKindsWithInv[kind] && window.PROTOCOL_INVENTORY) {
      var invBtn = document.createElement('button');
      invBtn.type = 'button';
      invBtn.className = 'pre-block-btn pre-block-inv';
      invBtn.textContent = '🧪';
      invBtn.title = 'Insert reference to a lab-inventory item';
      invBtn.addEventListener('click', function () {
        window.PROTOCOL_INVENTORY.openPicker({
          anchorEl: invBtn,
          onPick: function (entry) {
            // Insert at caret if caret is in this block's body el; else
            // append at end of the body Y.Text.
            var yBody = yBlock.get('body');
            if (!yBody || typeof yBody.insert !== 'function') return;
            var token = '[!inv:' + entry.id + ']';
            yBody.doc.transact(function () {
              yBody.insert(yBody.length, token);
            });
            ctx.markDirty();
          },
        }).catch(function (err) {
          alert('Inventory load failed: ' + (err && err.message || err));
        });
      });
      wrap.appendChild(invBtn);
    }

    var statusSel = document.createElement('select');
    statusSel.className = 'pre-block-status';
    ['draft', 'needs-review', 'complete'].forEach(function (s) {
      var opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s.replace('-', ' ');
      statusSel.appendChild(opt);
    });
    statusSel.value = yBlock.get('status') || 'draft';
    statusSel.addEventListener('change', function () {
      yBlock.set('status', statusSel.value);
      ctx.markDirty();
    });
    yBlock.observe(function (event) {
      if (event.keysChanged && event.keysChanged.has('status')) {
        statusSel.value = yBlock.get('status') || 'draft';
      }
    });
    wrap.appendChild(statusSel);

    function btn(label, title, handler) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pre-block-btn';
      b.title = title;
      b.textContent = label;
      b.addEventListener('click', handler);
      return b;
    }
    wrap.appendChild(btn('↑', 'Move up', function () { ctx.moveUp(yBlock); }));
    wrap.appendChild(btn('↓', 'Move down', function () { ctx.moveDown(yBlock); }));
    wrap.appendChild(btn('×', 'Delete block', function () {
      if (confirm('Delete this block?')) ctx.removeBlock(yBlock);
    }));
    return wrap;
  }

  /* ── Renderers per kind ───────────────────────────────────────── */

  function renderStep(yBlock, ctx) {
    var root = document.createElement('div');
    root.className = 'pre-block pre-block-step';
    root.dataset.blockId = yBlock.get('id');

    var num = document.createElement('div');
    num.className = 'pre-step-number';
    num.textContent = String(ctx.stepNumber || '?');
    root.appendChild(num);

    var bodyWrap = document.createElement('div');
    bodyWrap.className = 'pre-step-body';

    var body = document.createElement('div');
    body.className = 'pre-step-text';
    body.contentEditable = ctx.canEdit ? 'true' : 'false';
    body.dataset.placeholder = 'Step description…';
    var unbind = bindYTextWithVars(body, yBlock.get('body'), { onInput: ctx.markDirty });
    ctx.registerCleanup(unbind);
    bodyWrap.appendChild(body);

    root.appendChild(bodyWrap);
    root.appendChild(renderControls(yBlock, ctx));
    return root;
  }

  /* ── V3.315 — Generalized callout. Renders `callout` blocks AND the
   * legacy `note` / `safety` kinds (render-level fold — stored kinds
   * are untouched until the user changes the type select, which
   * rewrites the block to kind:'callout'). */
  var CALLOUT_LABELS = [
    ['critical', '⚠ Critical'],
    ['note', 'ℹ Note'],
    ['assume', '⚙ Assumption'],
    ['timing', '⏱ Timing'],
  ];

  function calloutTypeOf(yBlock) {
    var kind = yBlock.get('kind');
    var attrs = yBlock.get('attrs');
    if (kind === 'callout') return attrs.get('type') || 'note';
    if (kind === 'safety') return 'critical';
    return 'note'; // legacy note (info/tip flavors both fold to note)
  }

  function renderCallout(yBlock, ctx) {
    var root = document.createElement('div');
    var attrs = yBlock.get('attrs');
    var type = calloutTypeOf(yBlock);
    root.className = 'pre-block pre-block-callout pre-callout-' + type;
    root.dataset.blockId = yBlock.get('id');

    var label = document.createElement('div');
    label.className = 'pre-callout-label';
    var sel = document.createElement('select');
    sel.className = 'pre-callout-type';
    CALLOUT_LABELS.forEach(function (kv) {
      var opt = document.createElement('option');
      opt.value = kv[0];
      opt.textContent = kv[1];
      sel.appendChild(opt);
    });
    sel.value = type;
    sel.disabled = !ctx.canEdit;
    sel.addEventListener('change', function () {
      // Changing the type is the moment a legacy note/safety block
      // becomes a real callout — an explicit edit, per the V3.315 plan.
      yBlock.doc.transact(function () {
        yBlock.set('kind', 'callout');
        attrs.set('type', sel.value);
      });
      root.className = 'pre-block pre-block-callout pre-callout-' + sel.value;
      ctx.markDirty();
    });
    label.appendChild(sel);
    root.appendChild(label);

    var body = document.createElement('div');
    body.className = 'pre-callout-body';
    body.contentEditable = ctx.canEdit ? 'true' : 'false';
    body.dataset.placeholder = 'Callout text…';
    var unbind = bindYTextWithVars(body, yBlock.get('body'), { onInput: ctx.markDirty });
    ctx.registerCleanup(unbind);
    root.appendChild(body);

    root.appendChild(renderControls(yBlock, ctx));
    return root;
  }

  /* ── V3.315 — Stage heading: code + title + optional top rule. */
  function renderHeading(yBlock, ctx) {
    var root = document.createElement('div');
    var attrs = yBlock.get('attrs');
    root.className = 'pre-block pre-block-heading';
    root.dataset.blockId = yBlock.get('id');

    var row = document.createElement('div');
    row.className = 'pre-heading-row';

    var codeInp = document.createElement('input');
    codeInp.type = 'text';
    codeInp.className = 'pre-heading-code';
    codeInp.placeholder = '01';
    codeInp.value = attrs.get('code') || '';
    codeInp.disabled = !ctx.canEdit;
    codeInp.addEventListener('input', function () {
      attrs.set('code', codeInp.value);
      ctx.markDirty();
    });
    row.appendChild(codeInp);

    var title = document.createElement('div');
    title.className = 'pre-heading-title';
    title.contentEditable = ctx.canEdit ? 'true' : 'false';
    title.dataset.placeholder = 'Stage title…';
    var unbind = bindYTextWithVars(title, yBlock.get('body'), { onInput: ctx.markDirty });
    ctx.registerCleanup(unbind);
    row.appendChild(title);

    var ruleLabel = document.createElement('label');
    ruleLabel.className = 'pre-heading-rule-toggle';
    var ruleChk = document.createElement('input');
    ruleChk.type = 'checkbox';
    ruleChk.checked = attrs.get('rule') !== false;
    ruleChk.disabled = !ctx.canEdit;
    ruleChk.addEventListener('change', function () {
      attrs.set('rule', ruleChk.checked);
      ctx.markDirty();
    });
    ruleLabel.appendChild(ruleChk);
    ruleLabel.appendChild(document.createTextNode(' rule'));
    ruleLabel.title = 'Draw a hairline above this heading in the document view';
    row.appendChild(ruleLabel);

    root.appendChild(row);
    root.appendChild(renderControls(yBlock, ctx));
    return root;
  }

  /* ── V3.315 — Document header (doc-view masthead). Body = subtitle;
   * attrs = {brand, title, chips:[{text, var}]}. Chips are a plain JSON
   * array value on the attrs Y.Map — edits replace the whole array. */
  function renderDocHeader(yBlock, ctx) {
    var root = document.createElement('div');
    var attrs = yBlock.get('attrs');
    root.className = 'pre-block pre-block-docheader';
    root.dataset.blockId = yBlock.get('id');

    var tag = document.createElement('div');
    tag.className = 'pre-docheader-tag';
    tag.textContent = 'Document header';
    root.appendChild(tag);

    function textField(field, labelText, placeholder) {
      var wrap = document.createElement('label');
      wrap.className = 'pre-formula-field';
      var lab = document.createElement('span');
      lab.className = 'pre-formula-field-label';
      lab.textContent = labelText;
      wrap.appendChild(lab);
      var inp = document.createElement('input');
      inp.type = 'text';
      inp.placeholder = placeholder || '';
      inp.value = attrs.get(field) || '';
      inp.disabled = !ctx.canEdit;
      inp.addEventListener('input', function () {
        attrs.set(field, inp.value);
        ctx.markDirty();
      });
      wrap.appendChild(inp);
      return wrap;
    }

    root.appendChild(textField('brand', 'Brand', 'defaults to labConfig/branding (McGhee Lab)'));
    root.appendChild(textField('title', 'Title', 'defaults to the protocol title'));

    var subtitle = document.createElement('div');
    subtitle.className = 'pre-docheader-subtitle';
    subtitle.contentEditable = ctx.canEdit ? 'true' : 'false';
    subtitle.dataset.placeholder = 'Subtitle line…';
    var unbind = bindYTextWithVars(subtitle, yBlock.get('body'), { onInput: ctx.markDirty });
    ctx.registerCleanup(unbind);
    root.appendChild(subtitle);

    /* Chips editor — plain array of {text, var}. */
    var chipsTitle = document.createElement('div');
    chipsTitle.className = 'pre-formula-section-label';
    chipsTitle.textContent = 'Meta chips';
    root.appendChild(chipsTitle);

    var chipsWrap = document.createElement('div');
    chipsWrap.className = 'pre-docheader-chips';
    root.appendChild(chipsWrap);

    function getChips() {
      var c = attrs.get('chips');
      return Array.isArray(c) ? c.map(function (x) { return { text: x.text || '', var: x.var || '' }; }) : [];
    }
    function setChips(chips) {
      attrs.set('chips', chips);
      ctx.markDirty();
    }

    function renderChips() {
      chipsWrap.innerHTML = '';
      var chips = getChips();
      chips.forEach(function (chip, i) {
        var row = document.createElement('div');
        row.className = 'pre-docheader-chip-row';
        var textInp = document.createElement('input');
        textInp.type = 'text';
        textInp.placeholder = 'Chip text (e.g. N conditions:)';
        textInp.value = chip.text;
        textInp.disabled = !ctx.canEdit;
        textInp.addEventListener('change', function () {
          var c = getChips(); c[i].text = textInp.value; setChips(c);
        });
        row.appendChild(textInp);
        var varInp = document.createElement('input');
        varInp.type = 'text';
        varInp.className = 'pre-docheader-chip-var';
        varInp.placeholder = 'var (optional)';
        varInp.value = chip.var;
        varInp.disabled = !ctx.canEdit;
        varInp.title = 'Symbol-table variable whose live value renders after the text';
        varInp.addEventListener('change', function () {
          var c = getChips(); c[i].var = varInp.value.trim(); setChips(c);
        });
        row.appendChild(varInp);
        if (ctx.canEdit) {
          var del = document.createElement('button');
          del.type = 'button';
          del.className = 'pre-block-btn';
          del.textContent = '×';
          del.title = 'Remove chip';
          del.addEventListener('click', function () {
            var c = getChips(); c.splice(i, 1); setChips(c); renderChips();
          });
          row.appendChild(del);
        }
        chipsWrap.appendChild(row);
      });
      if (ctx.canEdit) {
        var add = document.createElement('button');
        add.type = 'button';
        add.className = 'btn pre-docheader-chip-add';
        add.textContent = '+ Add chip';
        add.addEventListener('click', function () {
          var c = getChips(); c.push({ text: '', var: '' }); setChips(c); renderChips();
        });
        chipsWrap.appendChild(add);
      }
    }
    renderChips();
    attrs.observe(function (event) {
      if (event.keysChanged && event.keysChanged.has('chips')) renderChips();
    });

    root.appendChild(renderControls(yBlock, ctx));
    return root;
  }

  function renderMaterials(yBlock, ctx) {
    var root = document.createElement('div');
    root.className = 'pre-block pre-block-materials';
    root.dataset.blockId = yBlock.get('id');

    var label = document.createElement('div');
    label.className = 'pre-materials-label';
    label.textContent = 'Materials';
    root.appendChild(label);

    var attrs = yBlock.get('attrs');
    var yRows = attrs.get('rows');
    var Y = ctx.Y;

    var table = document.createElement('table');
    table.className = 'pre-materials-table';
    var thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>Qty</th><th>Unit</th><th>Item / description</th><th></th></tr>';
    table.appendChild(thead);
    var tbody = document.createElement('tbody');
    table.appendChild(tbody);

    function renderRows() {
      tbody.innerHTML = '';
      yRows.forEach(function (yRow, idx) {
        var tr = document.createElement('tr');

        function cellInput(field, placeholder, klass) {
          var td = document.createElement('td');
          if (klass) td.className = klass;
          var inp = document.createElement('input');
          inp.type = 'text';
          inp.placeholder = placeholder || '';
          inp.value = yRow.get(field) || '';
          inp.disabled = !ctx.canEdit;
          inp.addEventListener('input', function () {
            yRow.set(field, inp.value);
            ctx.markDirty();
          });
          td.appendChild(inp);
          return td;
        }

        tr.appendChild(cellInput('qty', '5', 'pre-mat-qty'));
        tr.appendChild(cellInput('unit', 'mL', 'pre-mat-unit'));

        // V3.121 — item_ref cell. If `item_ref` is set and the inventory
        // module has the entry, render a chip + stock chip. Otherwise
        // render the free_text input + a 🧪 picker button.
        var tdItem = document.createElement('td');
        tdItem.className = 'pre-mat-text';
        function renderItemCell() {
          tdItem.innerHTML = '';
          var itemRef = yRow.get('item_ref') || null;
          var entry = (itemRef && window.PROTOCOL_INVENTORY)
            ? window.PROTOCOL_INVENTORY.findById(itemRef)
            : null;
          if (itemRef) {
            // Chip mode (entry may be null if inventory hasn't finished
            // loading or the id has been deleted from the inventory).
            var chip = document.createElement('span');
            chip.className = 'pre-mat-chip';
            if (!entry) chip.classList.add('pre-mat-chip-unknown');
            var label = entry
              ? window.PROTOCOL_INVENTORY.formatLabel(entry)
              : (yRow.get('free_text') || itemRef);
            chip.innerHTML = '🧪 ' + escapeHtml(label) +
              (entry ? ' ' + window.PROTOCOL_INVENTORY.formatStockChipHtml(entry) : '');
            tdItem.appendChild(chip);
            if (ctx.canEdit) {
              var clearBtn = document.createElement('button');
              clearBtn.type = 'button';
              clearBtn.className = 'pre-block-btn pre-mat-chip-clear';
              clearBtn.textContent = '×';
              clearBtn.title = 'Unlink from inventory (free-text mode)';
              clearBtn.addEventListener('click', function () {
                yRow.set('item_ref', null);
                ctx.markDirty();
              });
              tdItem.appendChild(clearBtn);
            }
          } else {
            // Free-text input + picker button.
            var inp = document.createElement('input');
            inp.type = 'text';
            inp.placeholder = 'Reagent or equipment';
            inp.value = yRow.get('free_text') || '';
            inp.disabled = !ctx.canEdit;
            inp.addEventListener('input', function () {
              yRow.set('free_text', inp.value);
              ctx.markDirty();
            });
            tdItem.appendChild(inp);
            if (ctx.canEdit && window.PROTOCOL_INVENTORY) {
              var pickBtn = document.createElement('button');
              pickBtn.type = 'button';
              pickBtn.className = 'pre-block-btn pre-mat-pick';
              pickBtn.textContent = '🧪';
              pickBtn.title = 'Pick from lab inventory';
              pickBtn.addEventListener('click', function () {
                window.PROTOCOL_INVENTORY.openPicker({
                  anchorEl: pickBtn,
                  onPick: function (entry) {
                    var label = window.PROTOCOL_INVENTORY.formatLabel(entry);
                    yRow.doc.transact(function () {
                      yRow.set('item_ref', entry.id);
                      // Auto-fill free_text with the label so unlinking
                      // later still leaves human-readable text.
                      yRow.set('free_text', label);
                    });
                    ctx.markDirty();
                  },
                }).catch(function (err) {
                  alert('Inventory load failed: ' + (err && err.message || err));
                });
              });
              tdItem.appendChild(pickBtn);
            }
          }
        }
        renderItemCell();
        // Per-row Y.Map observer — re-render the cell on item_ref / free_text changes.
        yRow.observe(function (event) {
          if (event.keysChanged && (event.keysChanged.has('item_ref') || event.keysChanged.has('free_text'))) {
            renderItemCell();
          }
        });
        tr.appendChild(tdItem);

        var tdDel = document.createElement('td');
        if (ctx.canEdit) {
          var del = document.createElement('button');
          del.type = 'button';
          del.className = 'pre-block-btn';
          del.textContent = '×';
          del.title = 'Remove row';
          del.addEventListener('click', function () {
            yRows.delete(idx, 1);
            renderRows();
            ctx.markDirty();
          });
          tdDel.appendChild(del);
        }
        tr.appendChild(tdDel);

        tbody.appendChild(tr);
      });
    }

    yRows.observe(function () { renderRows(); });
    renderRows();
    // V3.121 — re-render rows once inventory loads so item_ref cells
    // can swap from "(unknown)" to the resolved name + stock chip.
    var onInvLoaded = function () { renderRows(); };
    document.addEventListener('protocol-inventory-loaded', onInvLoaded);
    ctx.registerCleanup(function () {
      document.removeEventListener('protocol-inventory-loaded', onInvLoaded);
    });
    root.appendChild(table);

    if (ctx.canEdit) {
      var addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'btn pre-mat-add';
      addBtn.textContent = '+ Add row';
      addBtn.addEventListener('click', function () {
        var yRow = new Y.Map();
        yRow.set('qty', '');
        yRow.set('unit', '');
        yRow.set('free_text', '');
        yRow.set('item_ref', null);
        yRows.push([yRow]);
        ctx.markDirty();
      });
      root.appendChild(addBtn);
    }

    root.appendChild(renderControls(yBlock, ctx));
    return root;
  }

  function renderFigure(yBlock, ctx) {
    var root = document.createElement('div');
    root.className = 'pre-block pre-block-figure';
    root.dataset.blockId = yBlock.get('id');

    var attrs = yBlock.get('attrs');

    var imgWrap = document.createElement('div');
    imgWrap.className = 'pre-figure-img';

    function renderImg() {
      imgWrap.innerHTML = '';
      var url = attrs.get('image_url');
      if (url) {
        var img = document.createElement('img');
        img.src = url;
        img.alt = attrs.get('image_alt') || '';
        var pct = parseInt(attrs.get('width_pct'), 10) || 100;
        img.style.maxWidth = pct + '%';
        imgWrap.appendChild(img);
      } else {
        var ph = document.createElement('div');
        ph.className = 'pre-figure-placeholder';
        ph.textContent = 'Drop an image here or click to upload';
        imgWrap.appendChild(ph);
      }
    }
    renderImg();
    yBlock.observeDeep(function () { renderImg(); });

    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.style.display = 'none';

    async function uploadFile(file) {
      try {
        ctx.setSaveState('uploading…');
        var res = await window.PROTOCOL_FIGURES.uploadImage(ctx.protocolId, file);
        attrs.doc.transact(function () {
          attrs.set('image_url', res.download_url);
          attrs.set('storage_path', res.storage_path);
          attrs.set('hash', res.hash);
          attrs.set('mime', res.mime);
        });
        ctx.markDirty();
      } catch (err) {
        alert('Upload failed: ' + err.message);
        ctx.setSaveState('upload failed', 'error');
      }
    }

    if (ctx.canEdit) {
      imgWrap.addEventListener('click', function () { fileInput.click(); });
      fileInput.addEventListener('change', function () {
        if (fileInput.files && fileInput.files[0]) uploadFile(fileInput.files[0]);
      });
      imgWrap.addEventListener('dragover', function (e) {
        e.preventDefault();
        imgWrap.classList.add('pre-figure-dragover');
      });
      imgWrap.addEventListener('dragleave', function () {
        imgWrap.classList.remove('pre-figure-dragover');
      });
      imgWrap.addEventListener('drop', function (e) {
        e.preventDefault();
        imgWrap.classList.remove('pre-figure-dragover');
        var f = e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) uploadFile(f);
      });
    } else {
      imgWrap.style.cursor = 'default';
    }

    root.appendChild(imgWrap);
    root.appendChild(fileInput);

    var widthRow = document.createElement('div');
    widthRow.className = 'pre-figure-meta';
    widthRow.innerHTML = '<label>Width % <input type="number" min="20" max="100" value="' +
      (parseInt(attrs.get('width_pct'), 10) || 100) +
      '" class="pre-figure-width"></label> ' +
      '<label>Alt <input type="text" class="pre-figure-alt" value="' +
      escapeHtml(attrs.get('image_alt') || '') + '"></label>';
    var widthInp = widthRow.querySelector('.pre-figure-width');
    widthInp.disabled = !ctx.canEdit;
    widthInp.addEventListener('input', function () {
      var v = parseInt(widthInp.value, 10);
      if (!isNaN(v) && v >= 20 && v <= 100) {
        attrs.set('width_pct', v);
        ctx.markDirty();
      }
    });
    var altInp = widthRow.querySelector('.pre-figure-alt');
    altInp.disabled = !ctx.canEdit;
    altInp.addEventListener('input', function () {
      attrs.set('image_alt', altInp.value);
      ctx.markDirty();
    });
    root.appendChild(widthRow);

    var caption = document.createElement('div');
    caption.className = 'pre-figure-caption';
    caption.contentEditable = ctx.canEdit ? 'true' : 'false';
    caption.dataset.placeholder = 'Caption…';
    var unbind = bindYTextWithVars(caption, yBlock.get('body'), { onInput: ctx.markDirty });
    ctx.registerCleanup(unbind);
    root.appendChild(caption);

    root.appendChild(renderControls(yBlock, ctx));
    return root;
  }

  /* ── V3.117 — Formula block.
   *
   * UI:
   *   ┌─ pre-block-formula ──────────────────────────────────────────┐
   *   │ Label: [Compute agarose mass]                                │
   *   │ Description: [mass = volume × wt%]                           │
   *   │ Variables (live-edit grid):                                  │
   *   │   name | label | default | unit                              │
   *   │   vol  | Final volume | 5 | mL  [×]                          │
   *   │   wt%  | Weight pct   | 2 | %   [×]                          │
   *   │ Expression: [vol * wt_pct / 100]                             │
   *   │ Output:                                                       │
   *   │   name [agarose_mass] · label [Agarose mass] · unit [g] · dec│
   *   │ → 0.100 g                                                     │
   *   └──────────────────────────────────────────────────────────────┘
   *
   * Editing any field debounces a `markDirty` and triggers the editor's
   * `ProtocolFormulas.rebuild(yTree)` which re-emits the symbol table.
   * The output preview re-renders on each `protocol-vars-changed` event.
   */
  function renderFormula(yBlock, ctx) {
    var root = document.createElement('div');
    root.className = 'pre-block pre-block-formula';
    root.dataset.blockId = yBlock.get('id');

    var attrs = yBlock.get('attrs');
    var Y = ctx.Y;

    function _stringInput(field, label, placeholder) {
      var wrap = document.createElement('label');
      wrap.className = 'pre-formula-field';
      var lab = document.createElement('span');
      lab.className = 'pre-formula-field-label';
      lab.textContent = label;
      wrap.appendChild(lab);
      var inp = document.createElement('input');
      inp.type = 'text';
      inp.placeholder = placeholder || '';
      inp.value = attrs.get(field) || '';
      inp.disabled = !ctx.canEdit;
      inp.addEventListener('input', function () {
        attrs.set(field, inp.value);
        ctx.markDirty();
      });
      wrap.appendChild(inp);
      // Y.Map observer for remote edits
      attrs.observe(function (event) {
        if (event.keysChanged && event.keysChanged.has(field)) {
          if (document.activeElement !== inp) inp.value = attrs.get(field) || '';
        }
      });
      return wrap;
    }

    root.appendChild(_stringInput('label', 'Label', 'Compute agarose mass'));
    root.appendChild(_stringInput('description', 'Description', 'mass = volume × wt%'));

    /* Variables grid */
    var varsTitle = document.createElement('div');
    varsTitle.className = 'pre-formula-section-label';
    varsTitle.textContent = 'Variables';
    root.appendChild(varsTitle);

    var yVars = attrs.get('variables');
    if (!yVars || typeof yVars.toArray !== 'function') {
      // Should not happen if hydrated correctly, but guard anyway.
      yVars = new Y.Array();
      attrs.set('variables', yVars);
    }

    var varsTable = document.createElement('table');
    varsTable.className = 'pre-formula-vars-table';
    var varsHead = document.createElement('thead');
    varsHead.innerHTML = '<tr><th>Name</th><th>Label</th><th>Default</th><th>Unit</th><th></th></tr>';
    varsTable.appendChild(varsHead);
    var varsBody = document.createElement('tbody');
    varsTable.appendChild(varsBody);
    root.appendChild(varsTable);

    function renderVarsRows() {
      varsBody.innerHTML = '';
      yVars.forEach(function (yVar, idx) {
        var tr = document.createElement('tr');

        function fieldCell(field, placeholder, klass) {
          var td = document.createElement('td');
          if (klass) td.className = klass;
          var inp = document.createElement('input');
          inp.type = 'text';
          inp.placeholder = placeholder || '';
          var v = yVar.get(field);
          inp.value = (v === null || v === undefined) ? '' : String(v);
          inp.disabled = !ctx.canEdit;
          inp.addEventListener('input', function () {
            // For `default`, try to parse as number; fall back to string.
            var raw = inp.value;
            if (field === 'default' && raw !== '') {
              var n = parseFloat(raw);
              yVar.set(field, isNaN(n) ? raw : n);
            } else {
              yVar.set(field, raw);
            }
            ctx.markDirty();
          });
          td.appendChild(inp);
          return td;
        }

        tr.appendChild(fieldCell('name', 'vol', 'pre-formula-name'));
        tr.appendChild(fieldCell('label', 'Final volume'));
        tr.appendChild(fieldCell('default', '5', 'pre-formula-default'));
        tr.appendChild(fieldCell('unit', 'mL', 'pre-formula-unit'));

        var tdDel = document.createElement('td');
        if (ctx.canEdit) {
          var del = document.createElement('button');
          del.type = 'button';
          del.className = 'pre-block-btn';
          del.textContent = '×';
          del.title = 'Remove variable';
          del.addEventListener('click', function () {
            yVars.delete(idx, 1);
            renderVarsRows();
            ctx.markDirty();
          });
          tdDel.appendChild(del);
        }
        tr.appendChild(tdDel);

        varsBody.appendChild(tr);
      });
    }

    yVars.observe(function () { renderVarsRows(); });
    renderVarsRows();

    if (ctx.canEdit) {
      var addVar = document.createElement('button');
      addVar.type = 'button';
      addVar.className = 'btn pre-formula-add-var';
      addVar.textContent = '+ Add variable';
      addVar.addEventListener('click', function () {
        var yV = new Y.Map();
        yV.set('name', '');
        yV.set('label', '');
        yV.set('default', '');
        yV.set('unit', '');
        yVars.push([yV]);
        ctx.markDirty();
      });
      root.appendChild(addVar);
    }

    /* Expression */
    var exprWrap = document.createElement('label');
    exprWrap.className = 'pre-formula-field pre-formula-expr';
    var exprLab = document.createElement('span');
    exprLab.className = 'pre-formula-field-label';
    exprLab.textContent = 'Expression';
    exprWrap.appendChild(exprLab);
    var exprInp = document.createElement('input');
    exprInp.type = 'text';
    exprInp.placeholder = 'vol * wt_pct / 100';
    exprInp.value = attrs.get('expression') || '';
    exprInp.disabled = !ctx.canEdit;
    exprInp.addEventListener('input', function () {
      attrs.set('expression', exprInp.value);
      ctx.markDirty();
    });
    exprWrap.appendChild(exprInp);
    attrs.observe(function (event) {
      if (event.keysChanged && event.keysChanged.has('expression')) {
        if (document.activeElement !== exprInp) exprInp.value = attrs.get('expression') || '';
      }
    });
    root.appendChild(exprWrap);

    /* Output */
    var outTitle = document.createElement('div');
    outTitle.className = 'pre-formula-section-label';
    outTitle.textContent = 'Output';
    root.appendChild(outTitle);

    var yOut = attrs.get('output');
    if (!yOut || typeof yOut.set !== 'function') {
      yOut = new Y.Map();
      yOut.set('name', 'result');
      yOut.set('label', 'Result');
      yOut.set('unit', '');
      yOut.set('decimals', 3);
      attrs.set('output', yOut);
    }

    var outRow = document.createElement('div');
    outRow.className = 'pre-formula-output-row';

    function outFieldInput(field, placeholder, klass, kind) {
      var wrap = document.createElement('label');
      wrap.className = 'pre-formula-out-field' + (klass ? ' ' + klass : '');
      var lab = document.createElement('span');
      lab.textContent = field;
      wrap.appendChild(lab);
      var inp = document.createElement('input');
      inp.type = (kind === 'number') ? 'number' : 'text';
      if (kind === 'number') { inp.min = '0'; inp.max = '10'; inp.step = '1'; inp.style.width = '50px'; }
      inp.placeholder = placeholder || '';
      var cur = yOut.get(field);
      inp.value = (cur === null || cur === undefined) ? '' : String(cur);
      inp.disabled = !ctx.canEdit;
      inp.addEventListener('input', function () {
        if (kind === 'number') {
          var n = parseInt(inp.value, 10);
          yOut.set(field, isNaN(n) ? 3 : n);
        } else {
          yOut.set(field, inp.value);
        }
        ctx.markDirty();
      });
      wrap.appendChild(inp);
      return wrap;
    }

    outRow.appendChild(outFieldInput('name', 'agarose_mass'));
    outRow.appendChild(outFieldInput('label', 'Agarose mass'));
    outRow.appendChild(outFieldInput('unit', 'g'));
    outRow.appendChild(outFieldInput('decimals', '3', null, 'number'));
    root.appendChild(outRow);

    /* Computed preview */
    var preview = document.createElement('div');
    preview.className = 'pre-formula-preview';
    function refreshPreview() {
      var st = (window.ProtocolFormulas && window.ProtocolFormulas.getSymbolTable()) || {};
      var outName = yOut.get('name');
      var sym = outName ? st[outName] : null;
      if (!outName) {
        preview.innerHTML = '<span class="pre-formula-preview-hint">Set the output name to see the computed result</span>';
      } else if (!sym) {
        preview.innerHTML = '<span class="pre-formula-preview-hint">Output <code>' + escapeHtml(outName) + '</code> not yet computed</span>';
      } else if (sym.error) {
        preview.innerHTML = '<span class="pre-formula-preview-error">⚠ ' + escapeHtml(sym.error) + '</span>';
      } else {
        var label = sym.label || outName;
        preview.innerHTML = '→ <strong>' + escapeHtml(label) + '</strong> = <span class="proto-var proto-var-computed">' +
          escapeHtml(window.ProtocolFormulas.formatSymbolValue(sym)) + '</span>';
      }
    }
    refreshPreview();
    var onVarsChanged = function () { refreshPreview(); };
    document.addEventListener('protocol-vars-changed', onVarsChanged);
    ctx.registerCleanup(function () {
      document.removeEventListener('protocol-vars-changed', onVarsChanged);
    });
    root.appendChild(preview);

    /* Hint */
    var hint = document.createElement('div');
    hint.className = 'pre-formula-hint';
    hint.innerHTML = 'Use <code>[!var:' + escapeHtml(yOut.get('name') || 'result') + ']</code> in any step / note / safety / caption to inline the computed value.';
    yOut.observe(function () {
      hint.innerHTML = 'Use <code>[!var:' + escapeHtml(yOut.get('name') || 'result') + ']</code> in any step / note / safety / caption to inline the computed value.';
    });
    root.appendChild(hint);

    root.appendChild(renderControls(yBlock, ctx));
    return root;
  }

  /* ── V3.316 — plain-JSON-attrs helpers (table / kv / timeline).
   * These blocks store their data as plain arrays on the attrs Y.Map;
   * every edit replaces the whole array (coarse-grained collaboration,
   * same precedent as docHeader.chips). */
  function _plainArray(attrs, field) {
    var v = attrs.get(field);
    return Array.isArray(v) ? JSON.parse(JSON.stringify(v)) : [];
  }

  /* ── V3.316 — generic table editor. */
  function renderTable(yBlock, ctx) {
    var root = document.createElement('div');
    root.className = 'pre-block pre-block-table';
    root.dataset.blockId = yBlock.get('id');
    var attrs = yBlock.get('attrs');

    var label = document.createElement('div');
    label.className = 'pre-materials-label';
    label.textContent = 'Table';
    root.appendChild(label);

    var tableEl = document.createElement('table');
    tableEl.className = 'pre-materials-table pre-generic-table';
    root.appendChild(tableEl);

    function cols() { return _plainArray(attrs, 'columns'); }
    function rows() { return _plainArray(attrs, 'rows'); }
    function save(c, r) {
      attrs.doc.transact(function () {
        if (c) attrs.set('columns', c);
        if (r) attrs.set('rows', r);
      });
      ctx.markDirty();
    }

    var ALIGNS = ['left', 'center', 'right'];

    function renderGrid() {
      var c = cols(), r = rows();
      tableEl.innerHTML = '';
      var thead = document.createElement('thead');
      var trh = document.createElement('tr');
      c.forEach(function (col, ci) {
        var th = document.createElement('th');
        th.className = 'pre-gt-th';
        var inp = document.createElement('input');
        inp.type = 'text';
        inp.value = col.label || '';
        inp.placeholder = 'Column';
        inp.disabled = !ctx.canEdit;
        inp.addEventListener('change', function () {
          var cc = cols(); cc[ci].label = inp.value; save(cc, null);
        });
        th.appendChild(inp);
        if (ctx.canEdit) {
          var ctl = document.createElement('div');
          ctl.className = 'pre-gt-colctl';
          var alignBtn = document.createElement('button');
          alignBtn.type = 'button';
          alignBtn.className = 'pre-block-btn';
          alignBtn.textContent = { left: '⇤', center: '⇹', right: '⇥' }[col.align || 'left'];
          alignBtn.title = 'Alignment: ' + (col.align || 'left') + ' (click to cycle)';
          alignBtn.addEventListener('click', function () {
            var cc = cols();
            var next = ALIGNS[(ALIGNS.indexOf(cc[ci].align || 'left') + 1) % ALIGNS.length];
            cc[ci].align = next; save(cc, null); renderGrid();
          });
          ctl.appendChild(alignBtn);
          var monoBtn = document.createElement('button');
          monoBtn.type = 'button';
          monoBtn.className = 'pre-block-btn' + (col.mono ? ' pre-gt-on' : '');
          monoBtn.textContent = 'M';
          monoBtn.title = 'Monospace cells' + (col.mono ? ' (on)' : ' (off)');
          monoBtn.addEventListener('click', function () {
            var cc = cols(); cc[ci].mono = !cc[ci].mono; save(cc, null); renderGrid();
          });
          ctl.appendChild(monoBtn);
          var delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'pre-block-btn';
          delBtn.textContent = '×';
          delBtn.title = 'Remove column';
          delBtn.addEventListener('click', function () {
            if (!confirm('Remove this column (and its cell data)?')) return;
            var cc = cols(), rr = rows();
            var key = cc[ci].key;
            cc.splice(ci, 1);
            rr.forEach(function (row) { delete row[key]; });
            save(cc, rr); renderGrid();
          });
          ctl.appendChild(delBtn);
          th.appendChild(ctl);
        }
        trh.appendChild(th);
      });
      var thAdd = document.createElement('th');
      thAdd.className = 'pre-gt-addcol';
      if (ctx.canEdit) {
        var addCol = document.createElement('button');
        addCol.type = 'button';
        addCol.className = 'pre-block-btn';
        addCol.textContent = '+ col';
        addCol.addEventListener('click', function () {
          var cc = cols();
          var key = 'c' + (Date.now() % 100000).toString(36) + cc.length;
          cc.push({ key: key, label: '', align: 'left', mono: false });
          save(cc, null); renderGrid();
        });
        thAdd.appendChild(addCol);
      }
      trh.appendChild(thAdd);
      thead.appendChild(trh);
      tableEl.appendChild(thead);

      var tbody = document.createElement('tbody');
      r.forEach(function (row, ri) {
        var tr = document.createElement('tr');
        c.forEach(function (col) {
          var td = document.createElement('td');
          if (col.mono) td.className = 'pre-gt-mono';
          var inp = document.createElement('input');
          inp.type = 'text';
          inp.style.textAlign = col.align || 'left';
          inp.value = row[col.key] || '';
          inp.disabled = !ctx.canEdit;
          inp.addEventListener('change', function () {
            var rr = rows(); rr[ri][col.key] = inp.value; save(null, rr);
          });
          td.appendChild(inp);
          tr.appendChild(td);
        });
        var tdDel = document.createElement('td');
        if (ctx.canEdit) {
          var del = document.createElement('button');
          del.type = 'button';
          del.className = 'pre-block-btn';
          del.textContent = '×';
          del.title = 'Remove row';
          del.addEventListener('click', function () {
            var rr = rows(); rr.splice(ri, 1); save(null, rr); renderGrid();
          });
          tdDel.appendChild(del);
        }
        tr.appendChild(tdDel);
        tbody.appendChild(tr);
      });
      tableEl.appendChild(tbody);
    }
    renderGrid();
    attrs.observe(function (event) {
      if (event.keysChanged &&
          (event.keysChanged.has('columns') || event.keysChanged.has('rows'))) {
        if (!root.contains(document.activeElement)) renderGrid();
      }
    });

    if (ctx.canEdit) {
      var addRow = document.createElement('button');
      addRow.type = 'button';
      addRow.className = 'btn pre-mat-add';
      addRow.textContent = '+ Add row';
      addRow.addEventListener('click', function () {
        var rr = rows(); rr.push({}); save(null, rr); renderGrid();
      });
      root.appendChild(addRow);
    }

    var caption = document.createElement('div');
    caption.className = 'pre-figure-caption';
    caption.contentEditable = ctx.canEdit ? 'true' : 'false';
    caption.dataset.placeholder = 'Caption (optional)…';
    var unbind = bindYTextWithVars(caption, yBlock.get('body'), { onInput: ctx.markDirty });
    ctx.registerCleanup(unbind);
    root.appendChild(caption);

    root.appendChild(renderControls(yBlock, ctx));
    return root;
  }

  /* ── V3.316 — definition / derivation list editor. */
  function renderKv(yBlock, ctx) {
    var root = document.createElement('div');
    root.className = 'pre-block pre-block-kv';
    root.dataset.blockId = yBlock.get('id');
    var attrs = yBlock.get('attrs');

    var label = document.createElement('div');
    label.className = 'pre-materials-label';
    label.textContent = 'Definition list';
    root.appendChild(label);

    var listEl = document.createElement('div');
    listEl.className = 'pre-kv-list';
    root.appendChild(listEl);

    function items() { return _plainArray(attrs, 'items'); }
    function save(it) { attrs.set('items', it); ctx.markDirty(); }

    function renderItems() {
      listEl.innerHTML = '';
      items().forEach(function (item, i) {
        var row = document.createElement('div');
        row.className = 'pre-kv-row';
        var term = document.createElement('input');
        term.type = 'text';
        term.className = 'pre-kv-term';
        term.placeholder = 'Term';
        term.value = item.term || '';
        term.disabled = !ctx.canEdit;
        term.addEventListener('change', function () {
          var it = items(); it[i].term = term.value; save(it);
        });
        row.appendChild(term);
        var def = document.createElement('input');
        def.type = 'text';
        def.className = 'pre-kv-def';
        def.placeholder = 'Definition / derivation';
        def.value = item.def || '';
        def.disabled = !ctx.canEdit;
        def.addEventListener('change', function () {
          var it = items(); it[i].def = def.value; save(it);
        });
        row.appendChild(def);
        if (ctx.canEdit) {
          var del = document.createElement('button');
          del.type = 'button';
          del.className = 'pre-block-btn';
          del.textContent = '×';
          del.addEventListener('click', function () {
            var it = items(); it.splice(i, 1); save(it); renderItems();
          });
          row.appendChild(del);
        }
        listEl.appendChild(row);
      });
      if (ctx.canEdit) {
        var add = document.createElement('button');
        add.type = 'button';
        add.className = 'btn pre-mat-add';
        add.textContent = '+ Add item';
        add.addEventListener('click', function () {
          var it = items(); it.push({ term: '', def: '' }); save(it); renderItems();
        });
        listEl.appendChild(add);
      }
    }
    renderItems();
    attrs.observe(function (event) {
      if (event.keysChanged && event.keysChanged.has('items')) {
        if (!root.contains(document.activeElement)) renderItems();
      }
    });

    root.appendChild(renderControls(yBlock, ctx));
    return root;
  }

  /* ── V3.316 — timeline editor. */
  function renderTimeline(yBlock, ctx) {
    var root = document.createElement('div');
    root.className = 'pre-block pre-block-timeline';
    root.dataset.blockId = yBlock.get('id');
    var attrs = yBlock.get('attrs');

    var label = document.createElement('div');
    label.className = 'pre-materials-label';
    label.textContent = 'Timeline';
    root.appendChild(label);

    var title = document.createElement('div');
    title.className = 'pre-timeline-title';
    title.contentEditable = ctx.canEdit ? 'true' : 'false';
    title.dataset.placeholder = 'Track title (optional)…';
    var unbind = bindYTextWithVars(title, yBlock.get('body'), { onInput: ctx.markDirty });
    ctx.registerCleanup(unbind);
    root.appendChild(title);

    var listEl = document.createElement('div');
    listEl.className = 'pre-timeline-list';
    root.appendChild(listEl);

    function marks() { return _plainArray(attrs, 'marks'); }
    function save(m) { attrs.set('marks', m); ctx.markDirty(); }

    function renderMarks() {
      listEl.innerHTML = '';
      marks().forEach(function (mark, i) {
        var row = document.createElement('div');
        row.className = 'pre-timeline-row';
        function field(fieldName, placeholder, klass) {
          var inp = document.createElement('input');
          inp.type = 'text';
          inp.className = klass || '';
          inp.placeholder = placeholder;
          inp.value = mark[fieldName] || '';
          inp.disabled = !ctx.canEdit;
          inp.addEventListener('change', function () {
            var m = marks(); m[i][fieldName] = inp.value; save(m);
          });
          return inp;
        }
        row.appendChild(field('at', '0 min', 'pre-timeline-at'));
        row.appendChild(field('label', 'Label', 'pre-timeline-label'));
        row.appendChild(field('sub', 'Sub-caption', 'pre-timeline-sub'));
        var incLabel = document.createElement('label');
        incLabel.className = 'pre-heading-rule-toggle';
        var inc = document.createElement('input');
        inc.type = 'checkbox';
        inc.checked = mark.included !== false;
        inc.disabled = !ctx.canEdit;
        inc.addEventListener('change', function () {
          var m = marks(); m[i].included = inc.checked; save(m);
        });
        incLabel.appendChild(inc);
        incLabel.appendChild(document.createTextNode(' incl.'));
        incLabel.title = 'Unchecked marks render dimmed (on the axis but not run)';
        row.appendChild(incLabel);
        if (ctx.canEdit) {
          var del = document.createElement('button');
          del.type = 'button';
          del.className = 'pre-block-btn';
          del.textContent = '×';
          del.addEventListener('click', function () {
            var m = marks(); m.splice(i, 1); save(m); renderMarks();
          });
          row.appendChild(del);
        }
        listEl.appendChild(row);
      });
      if (ctx.canEdit) {
        var add = document.createElement('button');
        add.type = 'button';
        add.className = 'btn pre-mat-add';
        add.textContent = '+ Add mark';
        add.addEventListener('click', function () {
          var m = marks(); m.push({ at: '', label: '', sub: '', included: true }); save(m); renderMarks();
        });
        listEl.appendChild(add);
      }
    }
    renderMarks();
    attrs.observe(function (event) {
      if (event.keysChanged && event.keysChanged.has('marks')) {
        if (!root.contains(document.activeElement)) renderMarks();
      }
    });

    root.appendChild(renderControls(yBlock, ctx));
    return root;
  }

  /* ── Generic plain-array grid editor (V3.318, hoisted V3.324) —
   * fields spec drives columns; the array lives as plain JSON at
   * attrs[field]. Shared by calculator / builder editors. */
  function _arrayGridEditor(attrs, ctx, field, title, fieldsSpec, newItem) {
    var section = document.createElement('div');
    var head = document.createElement('div');
    head.className = 'pre-formula-section-label';
    head.textContent = title;
    section.appendChild(head);
    var tbl = document.createElement('table');
    tbl.className = 'pre-formula-vars-table';
    var thead = document.createElement('thead');
    thead.innerHTML = '<tr>' + fieldsSpec.map(function (f) {
      return '<th>' + escapeHtml(f.label) + '</th>';
    }).join('') + '<th></th></tr>';
    tbl.appendChild(thead);
    var tbody = document.createElement('tbody');
    tbl.appendChild(tbody);
    section.appendChild(tbl);

    function items() { return _plainArray(attrs, field); }
    function save(it) { attrs.set(field, it); ctx.markDirty(); }

    function renderRows() {
      tbody.innerHTML = '';
      items().forEach(function (item, i) {
        var tr = document.createElement('tr');
        fieldsSpec.forEach(function (f) {
          var td = document.createElement('td');
          if (f.kind === 'select') {
            var sel = document.createElement('select');
            f.options.forEach(function (o) {
              var opt = document.createElement('option');
              opt.value = o; opt.textContent = o;
              sel.appendChild(opt);
            });
            sel.value = item[f.key] || f.options[0];
            sel.disabled = !ctx.canEdit;
            sel.addEventListener('change', function () {
              var it = items(); it[i][f.key] = sel.value; save(it);
            });
            td.appendChild(sel);
          } else if (f.kind === 'bool') {
            var chk = document.createElement('input');
            chk.type = 'checkbox';
            chk.checked = !!item[f.key];
            chk.disabled = !ctx.canEdit;
            chk.addEventListener('change', function () {
              var it = items(); it[i][f.key] = chk.checked; save(it);
            });
            td.appendChild(chk);
          } else if (f.kind === 'csv') {
            // Comma-separated string list stored as a real array.
            var csv = document.createElement('input');
            csv.type = 'text';
            if (f.width) csv.style.width = f.width;
            csv.placeholder = f.placeholder || 'a, b, c';
            csv.value = Array.isArray(item[f.key]) ? item[f.key].join(', ') : '';
            csv.disabled = !ctx.canEdit;
            csv.addEventListener('change', function () {
              var it = items();
              it[i][f.key] = csv.value.split(',')
                .map(function (s) { return s.trim(); }).filter(Boolean);
              save(it);
            });
            td.appendChild(csv);
          } else {
            var inp = document.createElement('input');
            inp.type = 'text';
            if (f.width) inp.style.width = f.width;
            inp.placeholder = f.placeholder || '';
            var v = item[f.key];
            inp.value = (v === null || v === undefined) ? '' : String(v);
            inp.disabled = !ctx.canEdit;
            inp.addEventListener('change', function () {
              var it = items();
              var raw = inp.value;
              if (f.kind === 'number' && raw !== '') {
                var n = parseFloat(raw);
                it[i][f.key] = isNaN(n) ? raw : n;
              } else {
                it[i][f.key] = raw;
              }
              save(it);
            });
            td.appendChild(inp);
          }
          tr.appendChild(td);
        });
        var tdDel = document.createElement('td');
        if (ctx.canEdit) {
          var del = document.createElement('button');
          del.type = 'button';
          del.className = 'pre-block-btn';
          del.textContent = '×';
          del.addEventListener('click', function () {
            var it = items(); it.splice(i, 1); save(it); renderRows();
          });
          tdDel.appendChild(del);
        }
        tr.appendChild(tdDel);
        tbody.appendChild(tr);
      });
    }
    renderRows();

    if (ctx.canEdit) {
      var add = document.createElement('button');
      add.type = 'button';
      add.className = 'btn pre-formula-add-var';
      add.textContent = '+ Add';
      add.addEventListener('click', function () {
        var it = items(); it.push(newItem()); save(it); renderRows();
      });
      section.appendChild(add);
    }
    attrs.observe(function (event) {
      if (event.keysChanged && event.keysChanged.has(field)) {
        if (!section.contains(document.activeElement)) renderRows();
      }
    });
    return section;
  }

  /* ── V3.318 — calculator editor (authoring surface; the interactive
   * sliders/cards render in the doc view). Inputs/outputs/table are
   * plain JSON on the attrs Y.Map. */
  function renderCalculator(yBlock, ctx) {
    var root = document.createElement('div');
    root.className = 'pre-block pre-block-calculator';
    root.dataset.blockId = yBlock.get('id');
    var attrs = yBlock.get('attrs');

    function textAttr(field, labelText, placeholder) {
      var wrap = document.createElement('label');
      wrap.className = 'pre-formula-field';
      var lab = document.createElement('span');
      lab.className = 'pre-formula-field-label';
      lab.textContent = labelText;
      wrap.appendChild(lab);
      var inp = document.createElement('input');
      inp.type = 'text';
      inp.placeholder = placeholder || '';
      inp.value = attrs.get(field) || '';
      inp.disabled = !ctx.canEdit;
      inp.addEventListener('input', function () {
        attrs.set(field, inp.value);
        ctx.markDirty();
      });
      wrap.appendChild(inp);
      return wrap;
    }

    var tag = document.createElement('div');
    tag.className = 'pre-docheader-tag';
    tag.textContent = '🧮 Calculator';
    root.appendChild(tag);
    root.appendChild(textAttr('label', 'Label', 'Condition calculator'));
    root.appendChild(textAttr('description', 'Description', 'What this computes'));

    function arrayGrid(field, title, fieldsSpec, newItem) {
      return _arrayGridEditor(attrs, ctx, field, title, fieldsSpec, newItem);
    }

    root.appendChild(arrayGrid('inputs', 'Inputs', [
      { key: 'name', label: 'Name', placeholder: 'n_cond', width: '80px' },
      { key: 'label', label: 'Label', placeholder: 'Conditions' },
      { key: 'widget', label: 'Widget', kind: 'select', options: ['slider', 'number'] },
      { key: 'min', label: 'Min', kind: 'number', width: '48px' },
      { key: 'max', label: 'Max', kind: 'number', width: '48px' },
      { key: 'step', label: 'Step', kind: 'number', width: '48px' },
      { key: 'default', label: 'Default', kind: 'number', width: '56px' },
      { key: 'unit', label: 'Unit', width: '48px' },
      { key: 'rangeHint', label: 'Range hint', placeholder: 'typical 4–12' },
    ], function () {
      return { name: '', label: '', widget: 'slider', min: 0, max: 10,
               step: 1, default: 0, unit: '', rangeHint: '' };
    }));

    root.appendChild(arrayGrid('outputs', 'Outputs (hero cards)', [
      { key: 'name', label: 'Name', placeholder: 'total_vol', width: '90px' },
      { key: 'label', label: 'Label', placeholder: 'Total volume' },
      { key: 'expr', label: 'Expression', placeholder: 'n_cond * vol_per' },
      { key: 'unit', label: 'Unit', width: '48px' },
      { key: 'decimals', label: 'Dec', kind: 'number', width: '38px' },
    ], function () {
      return { name: '', label: '', expr: '', unit: '', decimals: 2 };
    }));

    /* Computed table config: dataset name + column expressions. The
     * table object is one plain JSON value; column edits go through a
     * read-modify-write of the whole object. */
    var tblHead = document.createElement('div');
    tblHead.className = 'pre-formula-section-label';
    tblHead.textContent = 'Computed table (optional)';
    root.appendChild(tblHead);

    function getTable() {
      var t = attrs.get('table');
      return (t && typeof t === 'object')
        ? JSON.parse(JSON.stringify(t))
        : { dataset: '', columns: [] };
    }
    function saveTable(t) { attrs.set('table', t); ctx.markDirty(); }

    var dsWrap = document.createElement('label');
    dsWrap.className = 'pre-formula-field';
    var dsLab = document.createElement('span');
    dsLab.className = 'pre-formula-field-label';
    dsLab.textContent = 'Dataset';
    dsWrap.appendChild(dsLab);
    var dsInp = document.createElement('input');
    dsInp.type = 'text';
    dsInp.placeholder = 'named dataset from a builder block (e.g. conditions)';
    dsInp.value = getTable().dataset || '';
    dsInp.disabled = !ctx.canEdit;
    dsInp.addEventListener('change', function () {
      var t = getTable(); t.dataset = dsInp.value.trim(); saveTable(t);
    });
    dsWrap.appendChild(dsInp);
    root.appendChild(dsWrap);

    var colsEl = document.createElement('div');
    root.appendChild(colsEl);

    function renderTableCols() {
      colsEl.innerHTML = '';
      var t = getTable();
      var tbl = document.createElement('table');
      tbl.className = 'pre-formula-vars-table';
      tbl.innerHTML = '<thead><tr><th>Column label</th><th>Expression (per row)</th><th>Align</th><th>Mono</th><th>Dec</th><th></th></tr></thead>';
      var tbody = document.createElement('tbody');
      (t.columns || []).forEach(function (col, i) {
        var tr = document.createElement('tr');
        function cell(el) { var td = document.createElement('td'); td.appendChild(el); tr.appendChild(td); }
        var lab = document.createElement('input');
        lab.type = 'text'; lab.value = col.label || ''; lab.disabled = !ctx.canEdit;
        lab.addEventListener('change', function () {
          var tt = getTable(); tt.columns[i].label = lab.value; saveTable(tt);
        });
        cell(lab);
        var expr = document.createElement('input');
        expr.type = 'text'; expr.value = col.expr || ''; expr.disabled = !ctx.canEdit;
        expr.placeholder = 'e.g. frac * total_vol';
        expr.addEventListener('change', function () {
          var tt = getTable(); tt.columns[i].expr = expr.value; saveTable(tt);
        });
        cell(expr);
        var align = document.createElement('select');
        ['left', 'center', 'right'].forEach(function (o) {
          var opt = document.createElement('option');
          opt.value = o; opt.textContent = o;
          align.appendChild(opt);
        });
        align.value = col.align || 'left'; align.disabled = !ctx.canEdit;
        align.addEventListener('change', function () {
          var tt = getTable(); tt.columns[i].align = align.value; saveTable(tt);
        });
        cell(align);
        var mono = document.createElement('input');
        mono.type = 'checkbox'; mono.checked = !!col.mono; mono.disabled = !ctx.canEdit;
        mono.addEventListener('change', function () {
          var tt = getTable(); tt.columns[i].mono = mono.checked; saveTable(tt);
        });
        cell(mono);
        var dec = document.createElement('input');
        dec.type = 'text'; dec.style.width = '38px';
        dec.value = (typeof col.decimals === 'number') ? String(col.decimals) : '';
        dec.disabled = !ctx.canEdit;
        dec.addEventListener('change', function () {
          var tt = getTable();
          var n = parseInt(dec.value, 10);
          // Delete rather than set undefined: this object is dehydrated
          // into the Firestore `tree` payload, and Firestore throws on
          // any undefined field value, which would fail every save.
          if (isNaN(n)) delete tt.columns[i].decimals;
          else tt.columns[i].decimals = n;
          saveTable(tt);
        });
        cell(dec);
        var tdDel = document.createElement('td');
        if (ctx.canEdit) {
          var del = document.createElement('button');
          del.type = 'button';
          del.className = 'pre-block-btn';
          del.textContent = '×';
          del.addEventListener('click', function () {
            var tt = getTable(); tt.columns.splice(i, 1); saveTable(tt); renderTableCols();
          });
          tdDel.appendChild(del);
        }
        tr.appendChild(tdDel);
        tbody.appendChild(tr);
      });
      tbl.appendChild(tbody);
      colsEl.appendChild(tbl);
      if (ctx.canEdit) {
        var add = document.createElement('button');
        add.type = 'button';
        add.className = 'btn pre-formula-add-var';
        add.textContent = '+ Add column';
        add.addEventListener('click', function () {
          var tt = getTable();
          tt.columns.push({ label: '', expr: '', align: 'left', mono: false });
          saveTable(tt); renderTableCols();
        });
        colsEl.appendChild(add);
      }
    }
    renderTableCols();
    attrs.observe(function (event) {
      if (event.keysChanged && event.keysChanged.has('table')) {
        if (!colsEl.contains(document.activeElement)) {
          renderTableCols();
          if (document.activeElement !== dsInp) dsInp.value = getTable().dataset || '';
        }
      }
    });

    /* Live outputs preview — mirrors the formula block's preview. */
    var preview = document.createElement('div');
    preview.className = 'pre-formula-preview';
    function refreshPreview() {
      var st = (window.ProtocolFormulas && window.ProtocolFormulas.getSymbolTable()) || {};
      var outs = _plainArray(attrs, 'outputs').filter(function (o) { return o && o.name; });
      if (!outs.length) {
        preview.innerHTML = '<span class="pre-formula-preview-hint">Add outputs to see computed values (sliders render in 📄 Doc view)</span>';
        return;
      }
      preview.innerHTML = outs.map(function (o) {
        var sym = st[o.name];
        var val = sym
          ? (sym.error ? '⚠ ' + escapeHtml(sym.error)
                       : escapeHtml(window.ProtocolFormulas.formatSymbolValue(sym)))
          : '?';
        return '→ <strong>' + escapeHtml(o.label || o.name) + '</strong> = ' +
          '<span class="proto-var proto-var-computed">' + val + '</span>';
      }).join('<br>');
    }
    refreshPreview();
    var onVarsChanged = function () { refreshPreview(); };
    document.addEventListener('protocol-vars-changed', onVarsChanged);
    ctx.registerCleanup(function () {
      document.removeEventListener('protocol-vars-changed', onVarsChanged);
    });
    root.appendChild(preview);

    root.appendChild(renderControls(yBlock, ctx));
    return root;
  }

  /* Simple text-attr field bound to attrs[field] (string value). */
  function _attrTextField(attrs, ctx, field, labelText, placeholder, numeric) {
    var wrap = document.createElement('label');
    wrap.className = 'pre-formula-field';
    var lab = document.createElement('span');
    lab.className = 'pre-formula-field-label';
    lab.textContent = labelText;
    wrap.appendChild(lab);
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = placeholder || '';
    var v = attrs.get(field);
    inp.value = (v === null || v === undefined) ? '' : String(v);
    inp.disabled = !ctx.canEdit;
    inp.addEventListener('change', function () {
      if (numeric) {
        var n = parseFloat(inp.value);
        attrs.set(field, isNaN(n) ? 0 : n);
      } else {
        attrs.set(field, inp.value);
      }
      ctx.markDirty();
    });
    wrap.appendChild(inp);
    attrs.observe(function (event) {
      if (event.keysChanged && event.keysChanged.has(field)) {
        if (document.activeElement !== inp) {
          var nv = attrs.get(field);
          inp.value = (nv === null || nv === undefined) ? '' : String(nv);
        }
      }
    });
    return wrap;
  }

  /* ── V3.324 — builder editor (authoring surface; assembly happens in
   * the doc view). Config: dataset name, params, dims, derived fields,
   * dedupe rule. */
  function renderBuilder(yBlock, ctx) {
    var root = document.createElement('div');
    root.className = 'pre-block pre-block-builder';
    root.dataset.blockId = yBlock.get('id');
    var attrs = yBlock.get('attrs');

    var tag = document.createElement('div');
    tag.className = 'pre-docheader-tag';
    tag.textContent = '🧩 Builder → dataset';
    root.appendChild(tag);

    root.appendChild(_attrTextField(attrs, ctx, 'label', 'Label', 'Condition builder'));
    root.appendChild(_attrTextField(attrs, ctx, 'description', 'Description', 'What gets assembled'));
    root.appendChild(_attrTextField(attrs, ctx, 'dataset', 'Dataset name', 'conditions — consumed by calculator tables + layout maps'));

    root.appendChild(_arrayGridEditor(attrs, ctx, 'params',
      'Parameters (sliders — published to the symbol table)', [
        { key: 'name', label: 'Name', placeholder: 'L_M', width: '70px' },
        { key: 'label', label: 'Label', placeholder: 'Medium granule size' },
        { key: 'min', label: 'Min', kind: 'number', width: '48px' },
        { key: 'max', label: 'Max', kind: 'number', width: '48px' },
        { key: 'step', label: 'Step', kind: 'number', width: '48px' },
        { key: 'default', label: 'Default', kind: 'number', width: '56px' },
        { key: 'unit', label: 'Unit', width: '48px' },
        { key: 'lt', label: '< param', placeholder: 'L_L', width: '60px' },
      ], function () {
        return { name: '', label: '', min: 0, max: 100, step: 1,
                 default: 0, unit: '', lt: '' };
      }));

    root.appendChild(_arrayGridEditor(attrs, ctx, 'dims',
      'Dimensions (one segmented picker each)', [
        { key: 'field', label: 'Field', placeholder: 'size', width: '70px' },
        { key: 'label', label: 'Label', placeholder: 'Granule size' },
        { key: 'source', label: 'Source', kind: 'select', options: ['list', 'params'] },
        { key: 'options', label: 'Options (list source)', kind: 'csv', placeholder: '3:1, 1:1, 1:3' },
        { key: 'editable', label: 'User-editable', kind: 'bool' },
      ], function () {
        return { field: '', label: '', source: 'list', options: [], editable: false };
      }));

    root.appendChild(_arrayGridEditor(attrs, ctx, 'derived',
      'Derived fields (per assembled row)', [
        { key: 'field', label: 'Field', placeholder: 'f', width: '70px' },
        { key: 'expr', label: 'Expression (row scope)', placeholder: 'func_parts / (func_parts + inert_parts)' },
      ], function () { return { field: '', expr: '' }; }));

    /* Dedupe rule — single object; read-modify-write like the
     * calculator's table config. */
    var dedupeHead = document.createElement('div');
    dedupeHead.className = 'pre-formula-section-label';
    dedupeHead.textContent = 'Dedupe rule (optional)';
    root.appendChild(dedupeHead);

    function getDedupe() {
      var d = attrs.get('dedupe');
      return (d && typeof d === 'object')
        ? JSON.parse(JSON.stringify(d))
        : { when: '', ignore: [] };
    }
    var whenWrap = document.createElement('label');
    whenWrap.className = 'pre-formula-field';
    whenWrap.innerHTML = '<span class="pre-formula-field-label">When (row expr)</span>';
    var whenInp = document.createElement('input');
    whenInp.type = 'text';
    whenInp.placeholder = 'f >= 1';
    whenInp.value = getDedupe().when || '';
    whenInp.disabled = !ctx.canEdit;
    whenInp.addEventListener('change', function () {
      var d = getDedupe(); d.when = whenInp.value; attrs.set('dedupe', d); ctx.markDirty();
    });
    whenWrap.appendChild(whenInp);
    root.appendChild(whenWrap);

    var ignWrap = document.createElement('label');
    ignWrap.className = 'pre-formula-field';
    ignWrap.innerHTML = '<span class="pre-formula-field-label">Ignore fields</span>';
    var ignInp = document.createElement('input');
    ignInp.type = 'text';
    ignInp.placeholder = 'inert_size — blanked on matching rows before merging duplicates';
    ignInp.value = (getDedupe().ignore || []).join(', ');
    ignInp.disabled = !ctx.canEdit;
    ignInp.addEventListener('change', function () {
      var d = getDedupe();
      d.ignore = ignInp.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      attrs.set('dedupe', d); ctx.markDirty();
    });
    ignWrap.appendChild(ignInp);
    root.appendChild(ignWrap);

    var hint = document.createElement('div');
    hint.className = 'pre-formula-hint';
    hint.innerHTML = 'Users assemble combinations in the <strong>📄 Doc view</strong>; assembled rows register as the named dataset for calculator tables and layout maps.';
    root.appendChild(hint);

    root.appendChild(renderControls(yBlock, ctx));
    return root;
  }

  /* ── V3.324 — layout map editor (config only; grid renders in the
   * doc view). */
  function renderLayoutMap(yBlock, ctx) {
    var root = document.createElement('div');
    root.className = 'pre-block pre-block-layoutmap';
    root.dataset.blockId = yBlock.get('id');
    var attrs = yBlock.get('attrs');

    var tag = document.createElement('div');
    tag.className = 'pre-docheader-tag';
    tag.textContent = '🗺 Layout map';
    root.appendChild(tag);

    root.appendChild(_attrTextField(attrs, ctx, 'label', 'Label', 'Plate map'));
    root.appendChild(_attrTextField(attrs, ctx, 'dataset', 'Dataset', 'conditions'));
    root.appendChild(_attrTextField(attrs, ctx, 'rows', 'Grid rows', '4', true));
    root.appendChild(_attrTextField(attrs, ctx, 'cols', 'Grid cols', '6', true));
    root.appendChild(_attrTextField(attrs, ctx, 'cellLabel', 'Cell label (row expr)', 'tag — bare field names work'));
    root.appendChild(_attrTextField(attrs, ctx, 'cellSub', 'Cell sub-line (row expr, optional)', 'size'));
    root.appendChild(_attrTextField(attrs, ctx, 'colorField', 'Color by field (optional)', 'tag'));
    root.appendChild(_attrTextField(attrs, ctx, 'spareLabel', 'Spare-well label', '—'));

    var hint = document.createElement('div');
    hint.className = 'pre-formula-hint';
    hint.innerHTML = 'Renders the dataset as a grid in the <strong>📄 Doc view</strong> — one cell per row, spare wells auto-filled.';
    root.appendChild(hint);

    root.appendChild(renderControls(yBlock, ctx));
    return root;
  }

  /* Dispatcher. ctx provides editor-side helpers. */
  function renderBlock(yBlock, ctx) {
    var kind = yBlock.get('kind');
    switch (kind) {
      case 'step':      return renderStep(yBlock, ctx);
      case 'materials': return renderMaterials(yBlock, ctx);
      // V3.315 — note + safety fold into the generalized callout renderer.
      case 'note':      return renderCallout(yBlock, ctx);
      case 'safety':    return renderCallout(yBlock, ctx);
      case 'callout':   return renderCallout(yBlock, ctx);
      case 'figure':    return renderFigure(yBlock, ctx);
      case 'formula':   return renderFormula(yBlock, ctx);
      case 'heading':   return renderHeading(yBlock, ctx);
      case 'docHeader': return renderDocHeader(yBlock, ctx);
      case 'table':     return renderTable(yBlock, ctx);
      case 'kv':        return renderKv(yBlock, ctx);
      case 'timeline':  return renderTimeline(yBlock, ctx);
      case 'calculator': return renderCalculator(yBlock, ctx);
      case 'builder':   return renderBuilder(yBlock, ctx);
      case 'layoutMap': return renderLayoutMap(yBlock, ctx);
      default:
        // Unknown kind (e.g. a future `formula` block in a doc loaded by
        // Phase 1). Render a neutral placeholder so the block isn't lost
        // — its data is preserved in the Y.Map.
        var div = document.createElement('div');
        div.className = 'pre-block pre-block-unknown';
        div.textContent = '[' + kind + ' block — not yet supported in this version]';
        div.appendChild(renderControls(yBlock, ctx));
        return div;
    }
  }

  /* ── Yjs hydration / dehydration ──────────────────────────────── */

  /* Build a Y.Map for one plain-JSON block. */
  function hydrateBlockToYjs(plainBlock, Y) {
    var yBlock = new Y.Map();
    yBlock.set('id', plainBlock.id);
    yBlock.set('kind', plainBlock.kind);
    yBlock.set('status', plainBlock.status || 'draft');

    var yBody = new Y.Text();
    if (plainBlock.body) yBody.insert(0, String(plainBlock.body));
    yBlock.set('body', yBody);

    var yAttrs = new Y.Map();
    var attrs = plainBlock.attrs || {};
    if (plainBlock.kind === 'materials') {
      var yRows = new Y.Array();
      var rows = Array.isArray(attrs.rows) ? attrs.rows : [];
      rows.forEach(function (r) {
        var yRow = new Y.Map();
        yRow.set('qty', r.qty || '');
        yRow.set('unit', r.unit || '');
        yRow.set('free_text', r.free_text || '');
        yRow.set('item_ref', r.item_ref || null);
        yRows.push([yRow]);
      });
      yAttrs.set('rows', yRows);
    } else if (plainBlock.kind === 'formula') {
      // V3.117 — formula attrs have nested types: variables (Y.Array<Y.Map>),
      // output (Y.Map). Plain scalars (label, description, expression) are
      // stored directly on the parent attrs Y.Map.
      yAttrs.set('label', attrs.label || '');
      yAttrs.set('description', attrs.description || '');
      yAttrs.set('expression', attrs.expression || '');
      var yVars2 = new Y.Array();
      var vars = Array.isArray(attrs.variables) ? attrs.variables : [];
      vars.forEach(function (v) {
        var yV = new Y.Map();
        yV.set('name', v.name || '');
        yV.set('label', v.label || '');
        yV.set('default', v.default === undefined ? '' : v.default);
        yV.set('unit', v.unit || '');
        yVars2.push([yV]);
      });
      yAttrs.set('variables', yVars2);
      var yOut2 = new Y.Map();
      var out = attrs.output || {};
      yOut2.set('name', out.name || 'result');
      yOut2.set('label', out.label || 'Result');
      yOut2.set('unit', out.unit || '');
      yOut2.set('decimals', typeof out.decimals === 'number' ? out.decimals : 3);
      yAttrs.set('output', yOut2);
    } else {
      Object.keys(attrs).forEach(function (k) {
        yAttrs.set(k, attrs[k]);
      });
    }
    yBlock.set('attrs', yAttrs);
    return yBlock;
  }

  function hydrateSectionToYjs(plainSection, Y) {
    var ySec = new Y.Map();
    ySec.set('id', plainSection.id);
    ySec.set('label', plainSection.label || 'Untitled section');
    ySec.set('order', plainSection.order || 0);
    ySec.set('status', plainSection.status || 'draft');
    var yChildren = new Y.Array();
    (plainSection.children || []).forEach(function (b) {
      yChildren.push([hydrateBlockToYjs(b, Y)]);
    });
    ySec.set('children', yChildren);
    return ySec;
  }

  /* Seed an empty Y.Doc from a plain protocol tree. Idempotent — call
   * only when the Y.Doc is detected as empty (no sections array yet). */
  function hydrateTreeToYjs(yDoc, plainTree, Y) {
    var yTree = yDoc.getMap('tree');
    if (!yTree.has('meta')) {
      var yMeta = new Y.Map();
      Object.keys((plainTree && plainTree.meta) || {}).forEach(function (k) {
        var v = plainTree.meta[k];
        if (k === 'title') {
          var yTitle = new Y.Text();
          if (v) yTitle.insert(0, String(v));
          yMeta.set('title', yTitle);
        } else {
          yMeta.set(k, v);
        }
      });
      if (!yMeta.has('title')) yMeta.set('title', new Y.Text());
      yTree.set('meta', yMeta);
    }
    if (!yTree.has('sections')) {
      var ySections = new Y.Array();
      ((plainTree && plainTree.sections) || []).forEach(function (s) {
        ySections.push([hydrateSectionToYjs(s, Y)]);
      });
      yTree.set('sections', ySections);
    }
  }

  /* Y.Map<block> → plain JSON. */
  function dehydrateBlock(yBlock) {
    var out = {
      id: yBlock.get('id'),
      kind: yBlock.get('kind'),
      status: yBlock.get('status') || 'draft',
      body: '',
      attrs: {},
    };
    var body = yBlock.get('body');
    if (body && typeof body.toString === 'function') out.body = body.toString();
    var yAttrs = yBlock.get('attrs');
    if (yAttrs && typeof yAttrs.forEach === 'function') {
      yAttrs.forEach(function (v, k) {
        if (Array.isArray(v)) {
          // V3.315 — plain JSON array stored directly on the attrs Y.Map
          // (e.g. docHeader.chips). Without this branch the generic
          // `forEach` case below would coerce it to a {0:…,1:…} object.
          out.attrs[k] = JSON.parse(JSON.stringify(v));
        } else if (v && typeof v.toArray === 'function') {
          // Y.Array — likely materials.rows
          out.attrs[k] = v.toArray().map(function (item) {
            if (item && typeof item.forEach === 'function') {
              var obj = {};
              item.forEach(function (mv, mk) { obj[mk] = mv; });
              return obj;
            }
            return item;
          });
        } else if (v && typeof v.forEach === 'function') {
          var obj = {};
          v.forEach(function (mv, mk) { obj[mk] = mv; });
          out.attrs[k] = obj;
        } else {
          out.attrs[k] = v;
        }
      });
    }
    return out;
  }

  function dehydrateSection(ySec) {
    var children = [];
    var yChildren = ySec.get('children');
    if (yChildren && typeof yChildren.toArray === 'function') {
      yChildren.toArray().forEach(function (yBlock) {
        children.push(dehydrateBlock(yBlock));
      });
    }
    return {
      id: ySec.get('id'),
      label: ySec.get('label') || '',
      order: ySec.get('order') || 0,
      status: ySec.get('status') || 'draft',
      children: children,
    };
  }

  function dehydrateTree(yDoc) {
    var yTree = yDoc.getMap('tree');
    var plainMeta = {};
    var yMeta = yTree.get('meta');
    if (yMeta && typeof yMeta.forEach === 'function') {
      yMeta.forEach(function (v, k) {
        if (v && typeof v.toString === 'function' && k === 'title') {
          plainMeta[k] = v.toString();
        } else {
          plainMeta[k] = v;
        }
      });
    }
    var sections = [];
    var ySections = yTree.get('sections');
    if (ySections && typeof ySections.toArray === 'function') {
      ySections.toArray().forEach(function (ySec) {
        sections.push(dehydrateSection(ySec));
      });
    }
    return { meta: plainMeta, sections: sections };
  }

  window.ProtocolBlocks = {
    renderBlock: renderBlock,
    bindYText: bindYText,
    hydrateBlockToYjs: hydrateBlockToYjs,
    hydrateSectionToYjs: hydrateSectionToYjs,
    hydrateTreeToYjs: hydrateTreeToYjs,
    dehydrateBlock: dehydrateBlock,
    dehydrateSection: dehydrateSection,
    dehydrateTree: dehydrateTree,
  };
})();

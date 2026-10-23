/* paper-grant-checklist.js — submission-readiness checklist for the
 * "📎 Grant Docs" page (V3.468, grant-writing unification R6).
 *
 * Baked-in port of the standalone submission_checklist.html tool,
 * generalized to a per-mechanism data file:
 *   rm/data/grant-checklists/{grant_subtype}.json
 * (nsf-career shipped; add nih-r01.json … as more grants are made).
 *
 * Two panels, mounted by PaperGrantDocs.render() into #pgd-checklist-host:
 *   A) Document manifest — every required document, with LIVE status
 *      computed from the paper (a section with content, or a filled
 *      upload slot, reads "ready"); clicking a row jumps to that section
 *      on the Write page.
 *   B) Process checklist — the 8 categories of manual steps (accounts,
 *      eligibility, formatting, submission…) with the ? plain-language
 *      hint popovers, a progress bar, and a deadline countdown.
 *
 * State (deadline + which process steps are checked) persists on
 * paperExports/{paperId}.checklist (Firestore, shared across devices /
 * collaborators — NOT localStorage like the source tool). paperExports
 * is lab-contributor-writable; we merge-write only the `checklist` field.
 *
 * Contract: window.PaperGrantChecklist.mount(hostEl).
 */
(function () {
  'use strict';

  var _cache = {};        // mechanismId → parsed JSON (per page load)
  var _state = null;      // { checkedProcess:{}, deadline:'' }
  var _saveTimer = null;

  function _pe() { return window.PaperEditor; }
  function _db() {
    try { return (typeof firebridge !== 'undefined' && firebridge.db) ? firebridge.db() : null; }
    catch (e) { return null; }
  }
  function _paperId() {
    try { return new URLSearchParams(location.search).get('paper') || ''; } catch (e) { return ''; }
  }
  function _meta() { try { return (_pe() && _pe().getPaperMeta && _pe().getPaperMeta()) || {}; } catch (e) { return {}; } }
  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function _fetchChecklist(id) {
    if (_cache[id]) return Promise.resolve(_cache[id]);
    if (!/^[\w-]+$/.test(String(id || ''))) return Promise.reject(new Error('bad id'));
    return fetch('/rm/data/grant-checklists/' + id + '.json', { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('not found'); return r.json(); })
      .then(function (j) { _cache[id] = j; return j; });
  }

  /* ── paperExports.checklist persistence ── */
  function _loadState() {
    var db = _db(), pid = _paperId();
    if (!db || !pid) { _state = { checkedProcess: {}, deadline: '', grantDocKinds: {} }; return Promise.resolve(_state); }
    return db.collection('paperExports').doc(pid).get().then(function (snap) {
      var data = (snap.exists && snap.data()) || {};
      var c = data.checklist || {};
      // V3.495 — manifest status reads the Grant Docs PDF store, not sections.
      var gd = {};
      (Array.isArray(data.grantDocs) ? data.grantDocs : []).forEach(function (g) { if (g && g.kind) gd[g.kind] = true; });
      _state = { checkedProcess: c.checkedProcess || {}, deadline: c.deadline || '', grantDocKinds: gd };
      return _state;
    }).catch(function () { _state = { checkedProcess: {}, deadline: '', grantDocKinds: {} }; return _state; });
  }
  function _persist(mechanismId) {
    var db = _db(), pid = _paperId();
    if (!db || !pid) return;
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(function () {
      _saveTimer = null;
      db.collection('paperExports').doc(pid).set({
        checklist: {
          mechanismId: mechanismId,
          deadline: _state.deadline || '',
          checkedProcess: _state.checkedProcess || {},
          updated_at: firebase.firestore.FieldValue.serverTimestamp(),
        },
      }, { merge: true }).catch(function (e) { console.warn('[grant-checklist] save failed', e); });
    }, 500);
  }

  /* ── Live document status from the paper's Yjs sections ── */
  function _sectionScan() {
    var map = _pe() && _pe().getPaperMap && _pe().getPaperMap();
    var res = { present: {}, hasContent: {}, hasUpload: {}, anyCustomContent: false };
    if (!map) return res;
    var sections = map.get('sections');
    if (!sections || !sections.toArray) return res;
    sections.toArray().forEach(function (sec) {
      var kind = sec.get('kind');
      res.present[kind] = true;
      var children = sec.get('children');
      var hasText = false;
      if (children && children.toArray) {
        children.toArray().forEach(function (b) {
          var body = b.get('body');
          if (body && body.toString && body.toString().trim()) hasText = true;
        });
      }
      if (hasText) {
        res.hasContent[kind] = true;
        if (kind === 'custom') res.anyCustomContent = true;
      }
      if (sec.get('uploaded_file')) res.hasUpload[kind] = true;
    });
    return res;
  }

  function _rowStatus(row, scan) {
    var k = row.sectionKind;
    if (!k) return { cls: 'neu', text: row.channel || 'manual' };
    if (k === '__narrative__') {
      return scan.anyCustomContent ? { cls: 'ok', text: 'Drafted' } : { cls: 'miss', text: 'Not started' };
    }
    if (k === 'references') {
      return scan.present.references ? { cls: 'ok', text: 'Present' } : { cls: 'miss', text: 'Not added' };
    }
    // V3.495 — a PDF attached on the Grant Docs page satisfies this document.
    if (_state.grantDocKinds && _state.grantDocKinds[k]) return { cls: 'ok', text: 'Attached' };
    if (scan.hasUpload[k]) return { cls: 'ok', text: 'Uploaded' };     // legacy section slot
    if (scan.hasContent[k]) return { cls: 'ok', text: 'Drafted' };
    if (scan.present[k]) return { cls: 'mid', text: 'Empty' };
    return { cls: 'miss', text: 'Not added' };
  }

  /* ── Render ── */
  function mount(host) {
    if (!host) return;
    var meta = _meta();
    var mechanismId = meta.grant_subtype || '';
    if (!mechanismId) {
      host.innerHTML = '<div class="pgc-none">No submission checklist — set a grant mechanism ' +
        '(NSF CAREER, NIH R01, …) on the Export page to load one.</div>';
      return;
    }
    host.innerHTML = '<div class="pgc-loading">Loading the ' + _esc(mechanismId) + ' submission checklist…</div>';
    Promise.all([_fetchChecklist(mechanismId), _loadState()]).then(function (r) {
      _render(host, r[0], mechanismId);
    }).catch(function () {
      host.innerHTML = '<div class="pgc-none">No checklist file for “' + _esc(mechanismId) + '” yet. ' +
        'It can be added as more grants of this type are prepared.</div>';
    });
  }

  function _render(host, data, mechanismId) {
    host.innerHTML = '';
    var scan = _sectionScan();

    var wrap = document.createElement('div');
    wrap.className = 'pgc';

    /* Header + deadline */
    var head = document.createElement('div');
    head.className = 'pgc-head';
    head.innerHTML = '<div class="pgc-title">Submission checklist — ' + _esc(data.agency || '') + ' ' +
      _esc(data.mechanism || '') + '</div>' +
      '<div class="pgc-solic">' + _esc(data.solicitation || '') + '</div>';
    wrap.appendChild(head);

    var dl = document.createElement('div');
    dl.className = 'pgc-deadline';
    dl.innerHTML = '<label>Deadline <input type="date" class="pgc-deadline-input" value="' +
      _esc(_state.deadline || '') + '"></label>' +
      '<span class="pgc-countdown"></span>' +
      (data.deadlineHint ? '<span class="pgc-deadline-hint">' + _esc(data.deadlineHint) + '</span>' : '');
    wrap.appendChild(dl);
    var dInput = dl.querySelector('.pgc-deadline-input');
    var dCount = dl.querySelector('.pgc-countdown');
    function paintCountdown() {
      var v = _state.deadline;
      if (!v) { dCount.textContent = ''; return; }
      var d = new Date(v + 'T17:00:00');
      var days = Math.ceil((d - new Date()) / 86400000);
      if (isNaN(days)) { dCount.textContent = ''; return; }
      dCount.textContent = days < 0 ? 'past' : (days + (days === 1 ? ' day left' : ' days left'));
      dCount.className = 'pgc-countdown' + (days <= 10 ? ' pgc-urgent' : '');
    }
    paintCountdown();
    dInput.addEventListener('change', function () {
      _state.deadline = dInput.value || '';
      paintCountdown();
      _persist(mechanismId);
    });

    /* A) Document manifest — grouped into tables (V3.495). */
    var mHead = document.createElement('h4');
    mHead.className = 'pgc-subhead';
    mHead.textContent = 'Documents you need';
    wrap.appendChild(mHead);

    function _mrow(row) {
      var st = _rowStatus(row, scan);
      var r = document.createElement('div');
      r.className = 'pgc-mrow';
      var reqLabel = row.req === 'req' ? 'Required' : (row.req === 'cond' ? 'If needed' : 'Optional');
      r.innerHTML =
        '<div class="pgc-mmain">' +
          '<span class="pgc-mname">' + _esc(row.label) + '</span>' +
          '<span class="pgc-req pgc-req-' + _esc(row.req) + '">' + reqLabel + '</span>' +
          '<div class="pgc-mnote">' + _esc(row.note || '') + '</div>' +
        '</div>' +
        '<div class="pgc-mlim">' + _esc(row.limit || '') + '</div>' +
        '<div class="pgc-mwhere">' + _esc(row.channel || '') + '</div>' +
        '<div class="pgc-mstat"><span class="pgc-stat pgc-stat-' + st.cls + '">' + _esc(st.text) + '</span></div>';
      if (row.sectionKind && row.sectionKind !== '__narrative__') {
        r.classList.add('pgc-mrow-jump');
        r.title = 'Go to this section on the Write page';
        r.addEventListener('click', function () { _jumpToKind(row.sectionKind); });
      }
      return r;
    }
    function _table(rows) {
      var t = document.createElement('div');
      t.className = 'pgc-manifest';
      rows.forEach(function (row) { t.appendChild(_mrow(row)); });
      return t;
    }

    var groups = (data.groups && Object.keys(data.groups).length) ? data.groups : null;
    if (groups) {
      Object.keys(groups).forEach(function (gk) {
        var rows = (data.manifest || []).filter(function (row) { return row.group === gk; });
        if (!rows.length) return;
        var gl = document.createElement('div');
        gl.className = 'pgc-grp-label';
        gl.textContent = groups[gk];
        wrap.appendChild(gl);
        wrap.appendChild(_table(rows));
      });
      // Any rows without a recognized group fall into a trailing table.
      var ungrouped = (data.manifest || []).filter(function (row) { return !row.group || !groups[row.group]; });
      if (ungrouped.length) wrap.appendChild(_table(ungrouped));
    } else {
      wrap.appendChild(_table(data.manifest || []));
    }

    /* Callout cards (returned-without-review / do-not-include) + legend. */
    if (Array.isArray(data.callouts) && data.callouts.length) {
      var cc = document.createElement('div');
      cc.className = 'pgc-callouts';
      data.callouts.forEach(function (c) {
        var card = document.createElement('div');
        card.className = 'pgc-callout pgc-callout-' + _esc(c.kind || 'note');
        card.innerHTML = '<div class="pgc-callout-title">' + (c.kind === 'rwr' ? ICON.svg('exclamation-triangle') + ' ' : '') + _esc(c.title || '') + '</div>' +
          '<ul>' + (c.items || []).map(function (it) { return '<li>' + _esc(it) + '</li>'; }).join('') + '</ul>';
        cc.appendChild(card);
      });
      wrap.appendChild(cc);
    }
    var legend = document.createElement('div');
    legend.className = 'pgc-legend';
    legend.innerHTML =
      '<span><i class="pgc-lg pgc-lg-ok"></i> Ready / attached</span>' +
      '<span><i class="pgc-lg pgc-lg-mid"></i> In progress / empty</span>' +
      '<span><i class="pgc-lg pgc-lg-miss"></i> Not started</span>' +
      '<span><i class="pgc-lg pgc-lg-neu"></i> In portal / manual</span>';
    wrap.appendChild(legend);

    /* B) Process checklist */
    var allItems = [];
    (data.process || []).forEach(function (g) { (g.items || []).forEach(function (it) { allItems.push(it); }); });
    var doneCount = allItems.filter(function (it) { return _state.checkedProcess[it.key]; }).length;

    var pHead = document.createElement('div');
    pHead.className = 'pgc-prog';
    pHead.innerHTML = '<div class="pgc-prog-top"><span class="pgc-prog-count">' +
      '<b class="pgc-done">' + doneCount + '</b> of ' + allItems.length + ' steps complete</span></div>' +
      '<div class="pgc-bar"><i class="pgc-bar-fill"></i></div>';
    wrap.appendChild(pHead);
    var bar = pHead.querySelector('.pgc-bar-fill');
    var doneEl = pHead.querySelector('.pgc-done');
    function paintProgress() {
      var n = allItems.filter(function (it) { return _state.checkedProcess[it.key]; }).length;
      doneEl.textContent = n;
      bar.style.width = (allItems.length ? (n / allItems.length * 100) : 0) + '%';
    }
    paintProgress();

    (data.process || []).forEach(function (g) {
      var sec = document.createElement('div');
      sec.className = 'pgc-cat';
      sec.innerHTML = '<div class="pgc-cat-head"><span class="pgc-cat-num">' + _esc(g.num) + '</span>' +
        '<span class="pgc-cat-title">' + _esc(g.title) + '</span></div>' +
        (g.note ? '<div class="pgc-cat-note">' + _esc(g.note) + '</div>' : '');
      var ul = document.createElement('div');
      ul.className = 'pgc-items';
      (g.items || []).forEach(function (it) {
        var li = document.createElement('div');
        li.className = 'pgc-item' + (_state.checkedProcess[it.key] ? ' pgc-checked' : '');
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'pgc-cb';
        cb.checked = !!_state.checkedProcess[it.key];
        cb.addEventListener('change', function () {
          if (cb.checked) _state.checkedProcess[it.key] = true;
          else delete _state.checkedProcess[it.key];
          li.classList.toggle('pgc-checked', cb.checked);
          paintProgress();
          _persist(mechanismId);
        });
        var txt = document.createElement('span');
        txt.className = 'pgc-item-txt';
        txt.innerHTML = '<span class="pgc-item-label">' + _esc(it.label) + '</span>' +
          '<span class="pgc-item-tags">' + (it.tags || []).map(function (t) {
            return '<span class="pgc-tag">' + _esc(t) + '</span>';
          }).join('') + '</span>';
        li.appendChild(cb);
        li.appendChild(txt);
        if (it.hint && it.hint.b) {
          var hb = document.createElement('button');
          hb.type = 'button';
          hb.className = 'pgc-hint-btn';
          hb.textContent = '?';
          hb.title = it.hint.t || 'What is this?';
          hb.addEventListener('click', function (ev) { ev.stopPropagation(); _showHint(hb, it.hint); });
          li.appendChild(hb);
        }
        ul.appendChild(li);
      });
      sec.appendChild(ul);
      wrap.appendChild(sec);
    });

    if (data.note) {
      var foot = document.createElement('div');
      foot.className = 'pgc-foot';
      foot.textContent = data.note;
      wrap.appendChild(foot);
    }

    host.appendChild(wrap);
  }

  function _jumpToKind(kind) {
    var sections = (_pe() && _pe().getSectionsSummary && _pe().getSectionsSummary()) || [];
    var hit = sections.filter(function (s) { return s.kind === kind; })[0];
    if (!hit) return;
    if (window.PaperEquations && window.PaperEquations.gotoPage) {
      window.PaperEquations.gotoPage('write', { focus: hit.id });
    }
  }

  /* Shared hint popover (one at a time). */
  var _pop = null;
  function _showHint(btn, hint) {
    if (_pop) { _pop.remove(); _pop = null; }
    var pop = document.createElement('div');
    pop.className = 'pgc-pop';
    pop.innerHTML = '<div class="pgc-pop-title">' + _esc(hint.t || '') + '</div><div class="pgc-pop-body">' + hint.b + '</div>';
    document.body.appendChild(pop);
    var r = btn.getBoundingClientRect();
    var pr = pop.getBoundingClientRect();
    var left = Math.max(10, Math.min(r.right - pr.width, window.innerWidth - pr.width - 10));
    var top = r.bottom + 8;
    if (top + pr.height > window.innerHeight - 10) top = Math.max(10, r.top - pr.height - 8);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    _pop = pop;
    setTimeout(function () {
      document.addEventListener('mousedown', function onDoc(e) {
        if (_pop && !_pop.contains(e.target) && e.target !== btn) {
          _pop.remove(); _pop = null; document.removeEventListener('mousedown', onDoc);
        }
      });
    }, 0);
  }

  window.PaperGrantChecklist = { mount: mount };
})();

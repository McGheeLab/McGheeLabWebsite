/* classifier-settings.js — V3.293
 *
 * Classifier Settings & Transparency page. Lets the user tune the weights the
 * email-category classifier (email-classifier.js) uses, and see EXACTLY why it
 * decides what it does. Everything is client-side over the api adapter:
 *   - feature-group weights (sender / domain / subject / body)
 *   - activation + confidence thresholds + smoothing
 *   - live resubstitution accuracy that moves as you tune
 *   - per-email explanation (ranked probabilities + per-feature votes)
 *   - read-only view of the deterministic fallback-rule weights
 *
 * Settings persist to userData/{uid}/emailArchive/classifierSettings and are
 * applied on the Email page at boot. IIFE-wrapped to keep helpers off window.
 */
(function () {
  'use strict';

  var CAT_COLORS = {
    research: '#2563eb', teaching: '#d97706', service: '#7c3aed',
    admin: '#64748b', personal: '#dc2626', noise: '#94a3b8',
  };
  var CATS = ['research', 'teaching', 'service', 'admin', 'personal', 'noise'];

  var training = {};        // id -> {label, sub, s, subj, snip, ts}
  var cfg = null;           // working config (from EMAIL_CLASSIFIER.getConfig())
  var accTimer = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function el(id) { return document.getElementById(id); }
  function examplesArray() {
    return Object.keys(training).map(function (id) {
      var e = training[id];
      return { id: id, label: e.label, s: e.s, subj: e.subj, snip: e.snip, sub: e.sub, ts: e.ts };
    });
  }
  function prettyTok(t) {
    if (t.indexOf('from:') === 0) return 'sender ' + t.slice(5);
    if (t.indexOf('dom:') === 0) return '@' + t.slice(4);
    if (t.indexOf('s:') === 0) return 'subj “' + t.slice(2) + '”';
    if (t.indexOf('b:') === 0) return 'body “' + t.slice(2) + '”';
    return t;
  }
  function catChip(c) {
    var col = CAT_COLORS[c] || '#6b7280';
    return '<span class="catchip" style="border:1.5px solid ' + col + ';color:' + col + '">' + esc(c) + '</span>';
  }
  function setStatus(t) { var s = el('cs-status'); if (s) s.textContent = t; }

  function retrain() { if (window.EMAIL_CLASSIFIER) EMAIL_CLASSIFIER.train(examplesArray()); }

  /* ---------- accuracy (live, reflects current weights) ---------- */
  // Uses explain() (not predict/rank) so it evaluates the math regardless of the
  // minExamples activation gate — changing that gate shouldn't blank the number.
  function computeAccuracy() {
    var exs = examplesArray();
    var per = {}; CATS.forEach(function (c) { per[c] = { correct: 0, n: 0 }; });
    var correct = 0, n = 0;
    for (var i = 0; i < exs.length; i++) {
      var ex = exs[i];
      if (CATS.indexOf(ex.label) < 0) continue;
      var e = EMAIL_CLASSIFIER.explain(ex);
      if (!e || !e.ranked.length) continue;
      n++; per[ex.label].n++;
      if (e.ranked[0].category === ex.label) { correct++; per[ex.label].correct++; }
    }
    return { overall: { correct: correct, n: n, pct: n ? Math.round((correct / n) * 1000) / 10 : 0 }, per: per };
  }

  function renderStats() {
    var stats = EMAIL_CLASSIFIER.stats();
    var acc = computeAccuracy();
    var statusTxt = stats.ready ? 'Active — driving guesses' : (Math.max(0, stats.minExamples - stats.total) + ' more labels to activate');
    el('cs-stats').innerHTML =
      metric('Training examples', stats.total, 'hand-categorized') +
      metric('Status', stats.ready ? 'ACTIVE' : 'WARMING', statusTxt) +
      metric('Accuracy', acc.overall.n ? acc.overall.pct + '%' : '—', acc.overall.n ? acc.overall.correct + '/' + acc.overall.n + ' (optimistic)' : 'need labels', acc.overall.pct >= 80) +
      metric('Vocabulary', stats.vocabSize, 'distinct features');
    // per-class accuracy chips
    var chips = CATS.map(function (c) {
      var p = acc.per[c];
      if (!p.n) return '';
      var pct = Math.round((p.correct / p.n) * 100);
      return '<span style="display:inline-block;font-size:12px;margin:0 8px 6px 0">' + catChip(c) +
        ' <b>' + pct + '%</b> <span class="muted">(' + p.correct + '/' + p.n + ')</span></span>';
    }).join('');
    el('cs-perclass').innerHTML = chips || '<span class="muted">No labeled examples yet.</span>';
  }
  function metric(label, big, sub, good) {
    return '<div class="api-metric"><div class="lbl">' + esc(label) + '</div>' +
      '<div class="big' + (good ? ' good' : '') + '">' + esc(big) + '</div><div class="sub">' + esc(sub) + '</div></div>';
  }

  /* ---------- sliders ---------- */
  function slider(opts) {
    // opts: {key, label, sub, min, max, step, value, fmt, onInput}
    var id = 'sl-' + opts.key;
    var row = document.createElement('div');
    row.className = 'slider-row';
    row.innerHTML =
      '<div class="name">' + esc(opts.label) + '<small>' + esc(opts.sub || '') + '</small></div>' +
      '<input type="range" id="' + id + '" min="' + opts.min + '" max="' + opts.max + '" step="' + opts.step + '" value="' + opts.value + '">' +
      '<div class="val" id="' + id + '-v">' + opts.fmt(opts.value) + '</div>';
    var input = row.querySelector('input');
    input.addEventListener('input', function () {
      var v = parseFloat(input.value);
      row.querySelector('#' + id + '-v').textContent = opts.fmt(v);
      opts.onInput(v);
    });
    return row;
  }

  function applyAndRefresh() {
    EMAIL_CLASSIFIER.configure(cfg);
    if (accTimer) clearTimeout(accTimer);
    accTimer = setTimeout(function () { renderStats(); runExplain(); }, 80);
  }

  function renderWeights() {
    var host = el('cs-weights'); host.innerHTML = '';
    var defs = [
      { key: 'w_from', g: 'from', label: 'Sender address', sub: 'exact from: address — strongest, most specific' },
      { key: 'w_dom', g: 'dom', label: 'Sender domain', sub: 'generalizes across addresses at the same org' },
      { key: 'w_s', g: 's', label: 'Subject keywords', sub: 'words in the subject line' },
      { key: 'w_b', g: 'b', label: 'Body keywords', sub: 'words in the snippet / body preview' },
    ];
    defs.forEach(function (d) {
      host.appendChild(slider({
        key: d.key, label: d.label, sub: d.sub, min: 0, max: 3, step: 0.1, value: cfg.weights[d.g],
        fmt: function (v) { return v.toFixed(1) + '×'; },
        onInput: function (v) { cfg.weights[d.g] = v; applyAndRefresh(); },
      }));
    });
  }

  function renderThresholds() {
    var host = el('cs-thresholds'); host.innerHTML = '';
    host.appendChild(slider({
      key: 'minex', label: 'Min examples to activate', sub: 'below this, the rules carry the guess', min: 1, max: 80, step: 1, value: cfg.minExamples,
      fmt: function (v) { return String(v); }, onInput: function (v) { cfg.minExamples = v; applyAndRefresh(); },
    }));
    host.appendChild(slider({
      key: 'minconf', label: 'Min confidence', sub: 'model guesses only above this probability; else rules', min: 0.3, max: 0.95, step: 0.01, value: cfg.minConfidence,
      fmt: function (v) { return Math.round(v * 100) + '%'; }, onInput: function (v) { cfg.minConfidence = v; applyAndRefresh(); },
    }));
    host.appendChild(slider({
      key: 'alpha', label: 'Smoothing (α)', sub: 'higher = smoother / less certain; lower = sharper', min: 0.1, max: 3, step: 0.1, value: cfg.alpha,
      fmt: function (v) { return v.toFixed(1); }, onInput: function (v) { cfg.alpha = v; applyAndRefresh(); },
    }));
    host.appendChild(slider({
      key: 'minpc', label: 'Min examples / class', sub: 'a category must have at least this many to be predicted', min: 1, max: 10, step: 1, value: cfg.minPerClass,
      fmt: function (v) { return String(v); }, onInput: function (v) { cfg.minPerClass = v; applyAndRefresh(); },
    }));
  }

  /* ---------- explain a prediction ---------- */
  function currentTestEmail() {
    return {
      from: [{ email: el('cs-sender').value.trim() }],
      subject: el('cs-subject').value,
      snippet: el('cs-snippet').value,
    };
  }

  function runExplain() {
    var host = el('cs-explain');
    var hasInput = el('cs-sender').value.trim() || el('cs-subject').value.trim() || el('cs-snippet').value.trim();
    if (!hasInput) { host.innerHTML = '<span class="muted">Pick or type an email above to see the breakdown.</span>'; return; }
    var e = EMAIL_CLASSIFIER.explain(currentTestEmail());
    if (!e) { host.innerHTML = '<span class="muted">Model not trained yet — categorize some emails first.</span>'; return; }
    if (!e.ranked.length) { host.innerHTML = '<span class="muted">No predictable classes yet (need more examples per category).</span>'; return; }

    // 1) ranked probability bars
    var bars = e.ranked.map(function (r) {
      var col = CAT_COLORS[r.category] || '#6b7280';
      var pct = Math.round(r.confidence * 100);
      return '<div class="prob-row"><span class="pc" style="color:' + col + '">' + esc(r.category) + '</span>' +
        '<span class="prob-bar"><span style="width:' + pct + '%;background:' + col + '"></span></span>' +
        '<span class="pct">' + pct + '%</span></div>';
    }).join('');
    var winner = e.ranked[0];
    var gated = winner.confidence >= e.config.minConfidence && e.ready;
    var verdict = gated
      ? 'Model would label this <b style="color:' + (CAT_COLORS[winner.category] || '#000') + '">' + esc(winner.category) + '</b>.'
      : 'Below the activation/confidence gate → the <b>rules</b> would decide instead.';

    // 2) how each feature votes (argmax class per token)
    var tokMap = {};
    e.classes.forEach(function (cls) {
      cls.contrib.forEach(function (ct) {
        var m = tokMap[ct.token] || (tokMap[ct.token] = { group: ct.group, weight: ct.weight, vals: {}, counts: {} });
        m.vals[cls.category] = ct.value; m.counts[cls.category] = ct.count;
      });
    });
    var tokRows = e.tokens.map(function (tok) {
      var m = tokMap[tok]; if (!m) return '';
      var fav = null, favV = -Infinity;
      CATS.forEach(function (c) { if (m.vals[c] != null && m.vals[c] > favV) { favV = m.vals[c]; fav = c; } });
      var counts = CATS.filter(function (c) { return m.counts[c]; })
        .map(function (c) { return esc(c) + ':' + m.counts[c]; }).join(' · ') || '<span class="muted">unseen</span>';
      return '<tr><td><code class="tok">' + esc(prettyTok(tok)) + '</code></td>' +
        '<td>' + esc(m.group) + '</td><td>' + m.weight.toFixed(1) + '×</td>' +
        '<td>' + (fav ? catChip(fav) : '<span class="muted">—</span>') + '</td>' +
        '<td class="muted">' + counts + '</td></tr>';
    }).join('');

    host.innerHTML =
      '<div style="margin-bottom:10px">' + bars + '</div>' +
      '<div style="font-size:13px;margin:6px 0 12px">' + verdict + '</div>' +
      '<div class="tbl-scroll"><table class="cs-tbl"><thead><tr><th>Feature</th><th>Group</th><th>Weight</th><th>Favors</th><th>Times seen per category (in training)</th></tr></thead><tbody>' +
      (tokRows || '<tr><td colspan="5" class="muted">No usable features in this email.</td></tr>') +
      '</tbody></table></div>';
  }

  function populatePicker() {
    var sel = el('cs-pick');
    var exs = examplesArray().sort(function (a, b) { return String(b.ts || '').localeCompare(String(a.ts || '')); }).slice(0, 200);
    sel.innerHTML = '<option value="">— load one of your training examples —</option>' +
      exs.map(function (ex) {
        return '<option value="' + esc(ex.id) + '">[' + esc(ex.label) + '] ' + esc((ex.subj || ex.s || ex.id).slice(0, 70)) + '</option>';
      }).join('');
    sel.onchange = function () {
      var ex = training[sel.value];
      if (!ex) return;
      el('cs-sender').value = ex.s || '';
      el('cs-subject').value = ex.subj || '';
      el('cs-snippet').value = ex.snip || '';
      runExplain();
    };
  }

  /* ---------- rules transparency ---------- */
  function renderRules() {
    var host = el('cs-rules');
    if (!window.CATEGORY_RULES || !CATEGORY_RULES.describe) { host.innerHTML = '<span class="muted">Rules not loaded.</span>'; return; }
    var d = CATEGORY_RULES.describe();
    function hintTbl(rows, title) {
      var body = rows.map(function (r) {
        return '<tr><td><code class="tok">' + esc(r.pattern) + '</code></td><td>' + catChip(r.category) + '</td><td>' + r.weight + '</td></tr>';
      }).join('');
      return '<details class="cs-det"><summary>' + esc(title) + ' (' + rows.length + ')</summary>' +
        '<div class="tbl-scroll"><table class="cs-tbl"><thead><tr><th>Pattern</th><th>Category</th><th>Weight</th></tr></thead><tbody>' + body + '</tbody></table></div></details>';
    }
    function noiseTbl(rows, title, hasReason) {
      var body = rows.map(function (r) {
        return '<tr><td><code class="tok">' + esc(r.pattern) + '</code></td>' + (hasReason ? '<td class="muted">' + esc(r.reason || '') + '</td>' : '') + '</tr>';
      }).join('');
      return '<details class="cs-det"><summary>' + esc(title) + ' (' + rows.length + ')</summary>' +
        '<div class="tbl-scroll"><table class="cs-tbl"><thead><tr><th>Pattern</th>' + (hasReason ? '<th>Reason</th>' : '') + '</tr></thead><tbody>' + body + '</tbody></table></div></details>';
    }
    host.innerHTML =
      hintTbl(d.domainHints, 'Sender-domain rules') +
      hintTbl(d.subjectHints, 'Subject rules') +
      noiseTbl(d.noiseSubjects, 'Noise subjects', true) +
      noiseTbl(d.noiseSenders, 'Noise senders', false);
  }

  /* ---------- load / save ---------- */
  async function load() {
    setStatus('loading…');
    try {
      var s = await api.load('email_archive/classifier_settings.json');
      if (s && (s.weights || s.minConfidence != null || s.minExamples != null || s.alpha != null)) {
        EMAIL_CLASSIFIER.configure(s);
      }
    } catch (e) { /* defaults */ }
    try {
      var j = await api.load('email_archive/classifier_training.json');
      training = (j && j.examples) || {};
    } catch (e) { training = {}; }
    cfg = EMAIL_CLASSIFIER.getConfig();
    retrain();
    renderWeights();
    renderThresholds();
    renderStats();
    populatePicker();
    runExplain();
    renderRules();
    setStatus(Object.keys(training).length + ' training examples loaded.');
  }

  async function save() {
    setStatus('saving…');
    try {
      await api.save('email_archive/classifier_settings.json', {
        minExamples: cfg.minExamples, minPerClass: cfg.minPerClass,
        minConfidence: cfg.minConfidence, alpha: cfg.alpha,
        weights: cfg.weights, updated_at: new Date().toISOString(),
      });
      setStatus('Saved. The Email page will use these weights on next load.');
      if (window.TOAST) TOAST.success('Classifier settings saved.');
    } catch (e) {
      setStatus('save failed: ' + e.message);
      if (window.TOAST) TOAST.error('Save failed', { detail: e.message });
    }
  }

  function reset() {
    var d = EMAIL_CLASSIFIER.getConfig().defaults;
    cfg = { minExamples: d.minExamples, minPerClass: d.minPerClass, minConfidence: d.minConfidence, alpha: d.alpha, weights: { from: d.weights.from, dom: d.weights.dom, s: d.weights.s, b: d.weights.b } };
    EMAIL_CLASSIFIER.configure(cfg);
    renderWeights(); renderThresholds(); renderStats(); runExplain();
    setStatus('Reset to defaults — click Save to persist.');
  }

  document.addEventListener('DOMContentLoaded', async function () {
    el('btn-save').addEventListener('click', save);
    el('btn-reset').addEventListener('click', reset);
    ['cs-sender', 'cs-subject', 'cs-snippet'].forEach(function (id) {
      el(id).addEventListener('input', function () { runExplain(); });
    });
    if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) {
      try { await firebridge.whenAuthResolved(); } catch (_) {}
    }
    if (typeof firebridge !== 'undefined' && firebridge.gateSignedIn) {
      var gate = await firebridge.requireSignIn('Sign in to tune your email classifier.');
      if (!gate.allowed) return;
    }
    if (!window.EMAIL_CLASSIFIER) { setStatus('classifier engine failed to load'); return; }
    load();
  });
})();

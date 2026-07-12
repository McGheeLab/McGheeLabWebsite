/* classifier-review.js — V3.292
 *
 * API-Usage page card: review the training data behind the email-category
 * classifier (email-classifier.js). Loads the labeled training store
 * (userData/{uid}/emailArchive/classifierTraining), trains the in-browser
 * Naive Bayes model, and shows:
 *   - summary (examples, ready?, training accuracy, vocabulary size)
 *   - per-category example counts
 *   - the most-predictive signals (tokens) per category
 *   - the full training set (sender / subject / top features / label) with delete
 *
 * Production-working (no Python server): everything is client-side over the
 * same api adapter the email page uses. Wrapped in an IIFE so its helpers don't
 * collide with api-usage.js's top-level `$` / `escapeHtml`.
 */
(function () {
  'use strict';

  var CAT_COLORS = {
    research: '#2563eb', teaching: '#d97706', service: '#7c3aed',
    admin: '#64748b', personal: '#dc2626', noise: '#94a3b8',
  };
  var CATS = ['research', 'teaching', 'service', 'admin', 'personal', 'noise'];

  var training = {};   // id -> {label, sub, s, subj, snip, ts}
  var rowLimit = 200;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function examplesArray() {
    return Object.keys(training).map(function (id) {
      var e = training[id]; return { id: id, label: e.label, s: e.s, subj: e.subj, snip: e.snip, sub: e.sub, ts: e.ts };
    });
  }

  function prettyTok(t) {
    if (t.indexOf('from:') === 0) return 'sender ' + t.slice(5);
    if (t.indexOf('dom:') === 0) return '@' + t.slice(4);
    if (t.indexOf('s:') === 0) return 'subj “' + t.slice(2) + '”';
    if (t.indexOf('b:') === 0) return 'body “' + t.slice(2) + '”';
    return t;
  }

  function retrain() {
    if (window.EMAIL_CLASSIFIER) window.EMAIL_CLASSIFIER.train(examplesArray());
  }

  async function load() {
    var body = document.getElementById('clf-body');
    if (!window.EMAIL_CLASSIFIER) {
      body.innerHTML = '<div class="muted">Classifier engine not loaded.</div>';
      return;
    }
    body.innerHTML = '<div class="muted">Loading training set…</div>';
    try {
      var j = await api.load('email_archive/classifier_training.json');
      training = (j && j.examples) || {};
    } catch (e) {
      training = {};
    }
    retrain();
    render();
  }

  async function save() {
    await api.save('email_archive/classifier_training.json', {
      examples: training, updated_at: new Date().toISOString(),
    });
  }

  function render() {
    var body = document.getElementById('clf-body');
    var C = window.EMAIL_CLASSIFIER;
    var exs = examplesArray();
    var stats = C.stats();
    var acc = C.trainingAccuracy(exs);

    if (!exs.length) {
      body.innerHTML =
        '<div class="muted" style="padding:8px 0">No training examples yet. '
        + 'Categorize emails on the <a href="/rm/pages/activity-overview.html?tab=email">Email page</a> '
        + '(click a “Sort into” pill or pick a category) — each hand-categorization is added here and trains the model.</div>';
      return;
    }

    // --- summary metrics ---
    var statusTxt = stats.ready
      ? 'Active — powering guesses'
      : ('Warming up — ' + Math.max(0, stats.minExamples - stats.total) + ' more to activate');
    var metrics = '<div class="api-grid" style="margin-bottom:14px">'
      + metric('Training examples', stats.total, 'hand-categorized emails')
      + metric('Status', stats.ready ? 'ACTIVE' : 'WARMING', statusTxt)
      + metric('Training accuracy', acc ? (acc.pct + '%') : '—', acc ? (acc.correct + '/' + acc.n + ' (optimistic)') : 'needs more data')
      + metric('Vocabulary', stats.vocabSize, 'distinct features')
      + '</div>';

    // --- per-category counts ---
    var chips = CATS.map(function (c) {
      var n = stats.perClass[c] || 0;
      var dim = n ? '' : 'opacity:.4;';
      return '<span style="' + dim + 'display:inline-block;font-size:12px;padding:3px 10px;border-radius:999px;margin:0 6px 6px 0;'
        + 'border:1.5px solid ' + CAT_COLORS[c] + ';color:' + CAT_COLORS[c] + '">' + esc(c) + ' <b>' + n + '</b></span>';
    }).join('');
    var counts = '<div style="margin-bottom:12px">' + chips + '</div>';

    // --- most-predictive signals per category ---
    var signals = '<details class="step-details" style="margin-bottom:12px"><summary>Most-predictive signals per category</summary>';
    CATS.forEach(function (c) {
      if (!(stats.perClass[c] > 0)) return;
      var toks = C.topTokens(c, 12);
      if (!toks.length) return;
      signals += '<div class="detail-lbl" style="color:' + CAT_COLORS[c] + '">' + esc(c) + '</div>';
      signals += '<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:6px">'
        + toks.map(function (t) {
          return '<span title="weight ' + t.weight.toFixed(2) + ' · seen ' + t.count + '×" '
            + 'style="font-size:11px;background:#f1f5f9;border:1px solid var(--border);border-radius:6px;padding:2px 7px">'
            + esc(prettyTok(t.token)) + '</span>';
        }).join('') + '</div>';
    });
    signals += '<div class="muted" style="font-size:11px;margin-top:4px">Weight = log-odds the feature favors this category vs. the rest. Singletons hidden.</div></details>';

    // --- training set table (most recent first) ---
    exs.sort(function (a, b) { return String(b.ts || '').localeCompare(String(a.ts || '')); });
    var shown = exs.slice(0, rowLimit);
    var head = '<div class="tr-head" style="grid-template-columns:90px 90px 1fr 1.2fr 200px 50px">'
      + '<div>Date</div><div>Label</div><div>Sender</div><div>Subject</div><div>Top features</div><div></div></div>';
    var rows = shown.map(function (ex) {
      var feats = C.featuresFor(ex).slice(0, 6).map(prettyTok).join(' · ');
      var color = CAT_COLORS[ex.label] || '#6b7280';
      var d = (ex.ts || '').slice(0, 10);
      return '<div class="tr-row" data-id="' + esc(ex.id) + '" style="grid-template-columns:90px 90px 1fr 1.2fr 200px 50px">'
        + '<div class="ts">' + esc(d) + '</div>'
        + '<div><span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.3px;padding:2px 7px;border-radius:10px;border:1.5px solid ' + color + ';color:' + color + '">' + esc(ex.label) + (ex.sub ? '<span style="opacity:.7">:' + esc(ex.sub) + '</span>' : '') + '</span></div>'
        + '<div class="title" title="' + esc(ex.s) + '">' + esc(ex.s || '(no sender)') + '</div>'
        + '<div class="title" title="' + esc(ex.subj) + '">' + esc(ex.subj || '(no subject)') + '</div>'
        + '<div class="muted" style="font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(C.featuresFor(ex).join(' ')) + '">' + esc(feats) + '</div>'
        + '<div style="text-align:right"><button class="btn-del" data-act="del" title="Remove this training example">Del</button></div>'
        + '</div>';
    }).join('');
    var moreNote = exs.length > rowLimit
      ? '<div class="muted" style="font-size:11px;padding:8px 10px">Showing the ' + rowLimit + ' most recent of ' + exs.length + '.</div>'
      : '';

    body.innerHTML = metrics + counts + signals + head + rows + moreNote;

    // wire deletes
    body.querySelectorAll('.tr-row [data-act="del"]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var row = btn.closest('.tr-row');
        var id = row.getAttribute('data-id');
        if (!confirm('Remove this training example?\n\nThe model retrains without it. (The email keeps its category on the Email page; only the training signal is dropped.)')) return;
        delete training[id];
        retrain();
        try { await save(); } catch (e) { alert('save failed: ' + e.message); }
        render();
      });
    });
  }

  function metric(label, big, sub) {
    return '<div class="api-metric"><div class="lbl">' + esc(label) + '</div>'
      + '<div class="big">' + esc(big) + '</div><div class="sub">' + esc(sub) + '</div></div>';
  }

  document.addEventListener('DOMContentLoaded', async function () {
    var reload = document.getElementById('btn-clf-reload');
    if (reload) reload.addEventListener('click', load);
    if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) {
      try { await firebridge.whenAuthResolved(); } catch (_) { /* proceed; api.load will no-op if unauth */ }
    }
    load();
  });
})();

/* email-classifier.js — V3.292
 *
 * Free, in-browser Multinomial Naive Bayes email-category classifier that
 * LEARNS LIVE from the emails you hand-categorize. No LLM, no API key, no
 * backend, no Cloud Function — it trains in the browser from the categorizer
 * training store (userData/{uid}/emailArchive/classifierTraining) and is
 * retrained every time you label an email.
 *
 * Features per email:
 *   from:<full sender>   — exact sender address (strongest signal)
 *   dom:<domain>         — sender domain (generalizes across addresses)
 *   s:<token>            — subject keywords
 *   b:<token>            — snippet / body-preview keywords
 *
 * Wired into email-review's guesser AHEAD of the deterministic CATEGORY_RULES
 * (model → rule → unknown) and reviewable on the API Usage page. The model
 * stays silent until it has enough labeled data (MIN_EXAMPLES) and is confident
 * (MIN_CONFIDENCE); below that, the rules carry the guess.
 *
 * Categories: research / teaching / service / admin / personal / noise.
 * 'unknown' is the ABSENCE of a label, never a class here.
 */
(function () {
  'use strict';

  var CATEGORIES = ['research', 'teaching', 'service', 'admin', 'personal', 'noise'];
  var MAX_FIELD_TOKENS = 40; // cap tokens taken from any one field (tokenize-time)

  // All tunable "weights" live here so the Classifier Settings page can adjust
  // them transparently and persist per-user. Defaults reproduce the original
  // behavior exactly (all feature groups weighted 1.0).
  var DEFAULTS = {
    minExamples: 12,     // total labeled examples before the model is trusted
    minPerClass: 2,      // a class needs this many examples to be predictable
    minConfidence: 0.6,  // predict() returns null below this top-class probability
    alpha: 1.0,          // Laplace (add-one) smoothing — higher = smoother/less sure
    weights: { from: 1, dom: 1, s: 1, b: 1 }, // per-feature-group multipliers
  };
  var CONFIG = {
    minExamples: DEFAULTS.minExamples, minPerClass: DEFAULTS.minPerClass,
    minConfidence: DEFAULTS.minConfidence, alpha: DEFAULTS.alpha,
    weights: { from: 1, dom: 1, s: 1, b: 1 },
  };

  function configure(patch) {
    if (patch) {
      if (patch.minExamples != null && isFinite(+patch.minExamples)) CONFIG.minExamples = Math.max(1, +patch.minExamples);
      if (patch.minPerClass != null && isFinite(+patch.minPerClass)) CONFIG.minPerClass = Math.max(1, +patch.minPerClass);
      if (patch.minConfidence != null && isFinite(+patch.minConfidence)) CONFIG.minConfidence = Math.min(0.99, Math.max(0, +patch.minConfidence));
      if (patch.alpha != null && isFinite(+patch.alpha)) CONFIG.alpha = Math.max(0.01, +patch.alpha);
      if (patch.weights) {
        ['from', 'dom', 's', 'b'].forEach(function (g) {
          if (patch.weights[g] != null && isFinite(+patch.weights[g])) CONFIG.weights[g] = Math.max(0, +patch.weights[g]);
        });
      }
    }
    return getConfig();
  }

  function getConfig() {
    return {
      minExamples: CONFIG.minExamples, minPerClass: CONFIG.minPerClass,
      minConfidence: CONFIG.minConfidence, alpha: CONFIG.alpha,
      weights: { from: CONFIG.weights.from, dom: CONFIG.weights.dom, s: CONFIG.weights.s, b: CONFIG.weights.b },
      defaults: {
        minExamples: DEFAULTS.minExamples, minPerClass: DEFAULTS.minPerClass,
        minConfidence: DEFAULTS.minConfidence, alpha: DEFAULTS.alpha,
        weights: { from: 1, dom: 1, s: 1, b: 1 },
      },
    };
  }

  // Feature group from a token prefix ('from:' / 'dom:' / 's:' / 'b:').
  function groupOf(token) {
    var i = token.indexOf(':');
    return i > 0 ? token.slice(0, i) : '';
  }

  // Tiny stopword set — drops the highest-frequency English glue words that
  // carry no category signal. Kept short on purpose; NB tolerates the rest.
  var STOP = {};
  ('the a an and or but of to in on for with from at by is are was were be been being ' +
   'this that these those it its as if then than so we you your our their his her my me ' +
   'will would can could should may might have has had do does did not no yes re fwd ext')
    .split(' ').forEach(function (w) { STOP[w] = 1; });

  function tokenize(text, prefix) {
    if (!text) return [];
    var toks = String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ');
    var out = [], seen = 0;
    for (var i = 0; i < toks.length && seen < MAX_FIELD_TOKENS; i++) {
      var t = toks[i];
      if (t.length < 3) continue;
      if (STOP[t]) continue;
      out.push(prefix + t);
      seen++;
    }
    return out;
  }

  function domainOf(email) {
    var m = /@([^>\s]+)$/.exec(String(email || '').toLowerCase().trim());
    return m ? m[1] : '';
  }

  // Accepts either a LIVE email ({ from:[{email}], subject, snippet/body_preview })
  // or a stored training example ({ s, subj, snip }). Returns a token array.
  function featuresFor(x) {
    x = x || {};
    var sender = '';
    if (x.s) sender = String(x.s).toLowerCase().trim();
    else if (x.from && x.from.length) {
      var f0 = x.from[0];
      sender = String((f0 && (f0.email || f0)) || '').toLowerCase().trim();
    }
    var subject = (x.subj != null) ? x.subj : (x.subject || '');
    var snippet = (x.snip != null) ? x.snip : (x.snippet || x.body_preview || '');
    var toks = [];
    if (sender) {
      toks.push('from:' + sender);
      var d = domainOf(sender);
      if (d) toks.push('dom:' + d);
    }
    toks = toks.concat(tokenize(subject, 's:'));
    toks = toks.concat(tokenize(snippet, 'b:'));
    return toks;
  }

  // MODEL: per-class token counts + totals, built by train().
  var MODEL = null;

  // examples: [{ label, tokens? | s,subj,snip }]
  function train(examples) {
    var m = {
      classCounts: {}, tokenCounts: {}, classTokenTotals: {},
      vocab: {}, vocabSize: 0, total: 0, perClass: {},
    };
    for (var c = 0; c < CATEGORIES.length; c++) {
      var k = CATEGORIES[c];
      m.classCounts[k] = 0; m.tokenCounts[k] = {}; m.classTokenTotals[k] = 0; m.perClass[k] = 0;
    }
    examples = examples || [];
    for (var i = 0; i < examples.length; i++) {
      var ex = examples[i];
      if (!ex || CATEGORIES.indexOf(ex.label) < 0) continue;
      var toks = ex.tokens || featuresFor(ex);
      if (!toks.length) continue;
      m.classCounts[ex.label]++; m.perClass[ex.label]++; m.total++;
      var tc = m.tokenCounts[ex.label];
      for (var j = 0; j < toks.length; j++) {
        var t = toks[j];
        tc[t] = (tc[t] || 0) + 1;
        m.classTokenTotals[ex.label]++;
        m.vocab[t] = 1;
      }
    }
    m.vocabSize = Object.keys(m.vocab).length;
    MODEL = m;
    return m;
  }

  function ready() {
    return !!MODEL && MODEL.total >= CONFIG.minExamples && MODEL.vocabSize > 0;
  }

  // log P(class) + Σ weight(group) · log P(token|class) for one class.
  // wantContrib=true also returns the per-token contribution breakdown (used by
  // explain() for transparency). Single scoring path → _scores + explain agree.
  function _classLogScore(k, tokens, wantContrib) {
    var m = MODEL, V = m.vocabSize, alpha = CONFIG.alpha;
    var prior = Math.log(m.classCounts[k] / m.total);
    var logp = prior;
    var denom = m.classTokenTotals[k] + alpha * V;
    var tc = m.tokenCounts[k];
    var contrib = wantContrib ? [] : null;
    for (var j = 0; j < tokens.length; j++) {
      var t = tokens[j];
      var grp = groupOf(t);
      var w = (CONFIG.weights[grp] != null) ? CONFIG.weights[grp] : 1;
      var cnt = tc[t] || 0;
      var val = w * Math.log((cnt + alpha) / denom);
      logp += val;
      if (contrib) contrib.push({ token: t, group: grp, weight: w, count: cnt, value: val });
    }
    return wantContrib ? { logScore: logp, prior: prior, contrib: contrib } : logp;
  }

  // Weighted log-scores for every predictable class.
  function _scores(tokens) {
    var m = MODEL, out = [];
    for (var c = 0; c < CATEGORIES.length; c++) {
      var k = CATEGORIES[c];
      if (m.perClass[k] < CONFIG.minPerClass) continue;   // too few examples to trust
      out.push({ category: k, logScore: _classLogScore(k, tokens, false) });
    }
    return out;
  }

  function _softmax(scored) {
    if (!scored.length) return [];
    var max = -Infinity, i;
    for (i = 0; i < scored.length; i++) if (scored[i].logScore > max) max = scored[i].logScore;
    var sum = 0;
    for (i = 0; i < scored.length; i++) { scored[i]._e = Math.exp(scored[i].logScore - max); sum += scored[i]._e; }
    var res = scored.map(function (s) { return { category: s.category, confidence: sum ? s._e / sum : 0 }; });
    res.sort(function (a, b) { return b.confidence - a.confidence; });
    return res;
  }

  // Ranked candidate categories with calibrated-ish probabilities (softmax over
  // class log-likelihoods). [] when the model isn't ready or has no features.
  function rank(email) {
    if (!ready()) return [];
    var toks = featuresFor(email);
    if (!toks.length) return [];
    return _softmax(_scores(toks));
  }

  // Single best category when confident enough, else null (caller falls back).
  function predict(email) {
    var r = rank(email);
    if (!r.length || r[0].confidence < CONFIG.minConfidence) return null;
    return { category: r[0].category, confidence: Math.round(r[0].confidence * 1000) / 1000, scores: r };
  }

  // Full transparency for one email: ranked probabilities + the per-feature
  // contribution to each class's score (token, group, weight, count, value).
  // Lets the settings page show EXACTLY why the model leans the way it does.
  function explain(email) {
    if (!MODEL) return null;
    var toks = featuresFor(email);
    var classes = [];
    for (var c = 0; c < CATEGORIES.length; c++) {
      var k = CATEGORIES[c];
      if (MODEL.perClass[k] < CONFIG.minPerClass) continue;
      var r = _classLogScore(k, toks, true);
      classes.push({ category: k, logScore: r.logScore, prior: r.prior, contrib: r.contrib });
    }
    var probs = _softmax(classes.map(function (s) { return { category: s.category, logScore: s.logScore }; }));
    var byCat = {};
    probs.forEach(function (p) { byCat[p.category] = p.confidence; });
    classes.forEach(function (s) { s.confidence = byCat[s.category] || 0; });
    classes.sort(function (a, b) { return b.logScore - a.logScore; });
    return { tokens: toks, ranked: probs, classes: classes, ready: ready(), config: getConfig() };
  }

  // Most-predictive tokens for a category by log-odds vs. all other classes.
  function topTokens(category, n) {
    if (!MODEL) return [];
    n = n || 12;
    var m = MODEL, V = m.vocabSize, ALPHA = CONFIG.alpha;
    var inDenom = m.classTokenTotals[category] + ALPHA * V;
    var restTotal = 0, restCounts = {}, c, k, t, tc;
    for (c = 0; c < CATEGORIES.length; c++) {
      k = CATEGORIES[c];
      if (k === category) continue;
      restTotal += m.classTokenTotals[k];
      tc = m.tokenCounts[k];
      for (t in tc) restCounts[t] = (restCounts[t] || 0) + tc[t];
    }
    var restDenom = restTotal + ALPHA * V;
    var inTc = m.tokenCounts[category] || {};
    // Hide singletons only once there's enough data for them to be noise; on a
    // small training set every token is informative, so surface them all.
    var minCount = m.total >= 60 ? 2 : 1;
    var scored = [];
    for (t in inTc) {
      if (inTc[t] < minCount) continue;
      var pin = (inTc[t] + ALPHA) / inDenom;
      var prest = ((restCounts[t] || 0) + ALPHA) / restDenom;
      scored.push({ token: t, weight: Math.log(pin / prest), count: inTc[t] });
    }
    scored.sort(function (a, b) { return b.weight - a.weight; });
    return scored.slice(0, n);
  }

  function stats() {
    if (!MODEL) return { ready: false, total: 0, perClass: {}, vocabSize: 0, minExamples: CONFIG.minExamples };
    return {
      ready: ready(), total: MODEL.total, perClass: MODEL.perClass,
      vocabSize: MODEL.vocabSize, minExamples: CONFIG.minExamples,
    };
  }

  // Resubstitution accuracy — trains and tests on the same set, so it's
  // OPTIMISTIC (an upper bound, not held-out). Labelled as such in the UI.
  function trainingAccuracy(examples) {
    if (!ready()) return null;
    examples = examples || [];
    var correct = 0, n = 0;
    for (var i = 0; i < examples.length; i++) {
      var ex = examples[i];
      if (!ex || CATEGORIES.indexOf(ex.label) < 0) continue;
      var toks = ex.tokens || featuresFor(ex);
      if (!toks.length) continue;
      var r = _softmax(_scores(toks));
      if (!r.length) continue;
      n++;
      if (r[0].category === ex.label) correct++;
    }
    return n ? { correct: correct, n: n, pct: Math.round((correct / n) * 1000) / 10 } : null;
  }

  window.EMAIL_CLASSIFIER = {
    CATEGORIES: CATEGORIES,
    featuresFor: featuresFor,
    train: train,
    ready: ready,
    predict: predict,
    rank: rank,
    explain: explain,
    topTokens: topTokens,
    stats: stats,
    trainingAccuracy: trainingAccuracy,
    domainOf: domainOf,
    configure: configure,
    getConfig: getConfig,
  };
})();

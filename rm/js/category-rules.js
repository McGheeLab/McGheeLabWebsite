/* category-rules.js — V3.289
 *
 * Free, client-side, deterministic email category guesser. A faithful 1:1 port
 * of the lab's Python rules pre-pass:
 *   ../../ResearchManagement/scripts/email_classify_rules.py   (classify_one)
 *   ../../ResearchManagement/scripts/email_noise_rules.py      (classify_noise)
 *
 * No LLM, no network, no API key. Used by email-review.js at render time to sort
 * scraped mail into real categories instead of dumping everything into 'unknown'.
 * The (deferred) Haiku few-shot guesser is the documented next step for the mail
 * that no rule matches.
 *
 * Categories: research / teaching / service / admin / personal / noise / unknown.
 * Keep the patterns/weights in sync with the Python source if either changes.
 */
(function () {
  'use strict';

  // --- email_noise_rules.py: DEFINITE_NOISE_SUBJECTS ---
  // [regex, reason]. Subject patterns that are almost always noise.
  var NOISE_SUBJECTS = [
    [/inside the (january|february|march|april|may|june|july|august|september|october|november|december) \d{4} .+issue/i, 'journal TOC'],
    [/^\[ext\]\s*your amazon\.com order/i, 'amazon order'],
    [/^\[ext\]\s*shipped:/i, 'shipping'],
    [/has shipped!?\s*$/i, 'shipping'],
    [/arrived safely/i, 'shipping'],
    [/your amazon package will be delivered/i, 'shipping'],
    [/now arriving today/i, 'shipping'],
    [/^\[ext\]\s*20\d\d[’']s /i, 'year-in-review marketing'],
    [/award.?winning restaurants/i, 'opentable promo'],
    [/new login from (windows|mac|ios|android|chrome|safari|firefox)/i, 'login alert'],
    [/security alert/i, 'security alert'],
    [/password (will|has) expire/i, 'password expiration'],
    [/view in your browser|view (this|online) in/i, 'webmail link'],
    [/weekly (digest|update|newsletter|roundup)/i, 'weekly newsletter'],
    [/monthly (digest|update|newsletter|roundup)/i, 'monthly newsletter'],
    [/out of office/i, 'OOO'],
    [/automatic reply/i, 'auto-reply'],
    [/(?:^|:)\s*\d+% off\b/i, 'percent-off promo'],
    [/don[’']?t miss/i, 'urgent marketing'],
    [/webinar\b/i, 'webinar marketing'],
    [/you[’']?re invited/i, 'event blast'],
    [/editor.?s (picks|choice|note)/i, 'editorial blurb'],
    [/^\[ext\]\s*(explore|discover) (this|our)/i, 'marketing verbiage'],
  ];

  // --- email_noise_rules.py: DEFINITE_NOISE_SENDERS ---
  // Sender domains/addresses that are almost always noise. (Matched lowercase.)
  var NOISE_SENDERS = [
    /^shipment-tracking@amazon\.com$/,
    /^auto-confirm@amazon\.com$/,
    /^ship-confirm@amazon\.com$/,
    /^order-update@amazon\.com$/,
    /@opentable\./,
    /@doordash\./,
    /@ubereats\./,
    /@linkedin\.com$/,
    /@email\.teams\.microsoft\.com$/,
    /@mail\.wiley\.com$/,
    /@mail\.ieee\.org$/,
    /@email\.(nature|cell|elsevier|wiley|springer|bmes|acs|sciencemag)\./,
    /@email-alerts\./,
    /@e\.(nature|wiley|elsevier|springer)/,
    /@alerts?\./,
    /^postmaster@/,
    /^mailer-daemon@/,
    /@communications\.arizona\.edu$/,
  ];

  // --- email_classify_rules.py: DOMAIN_HINTS ---  [regex, category, weight]
  var DOMAIN_HINTS = [
    [/@d2l\.arizona\.edu$/, 'teaching', 0.9],
    [/@gradescope/, 'teaching', 0.9],
    [/@edgelearning\.arizona\.edu$/, 'teaching', 0.85],
    [/@canvas\./, 'teaching', 0.9],
    [/@piazza\.com$/, 'teaching', 0.95],
    [/@chronicle\.com$/, 'teaching', 0.4],
    [/@nih\.gov$/, 'research', 0.9],
    [/@nsf\.gov$/, 'research', 0.9],
    [/@doe\.gov$/, 'research', 0.8],
    [/@ahrq\.hhs\.gov$/, 'research', 0.8],
    [/@era\.nih\.gov$/, 'research', 0.95],
    [/@bmes\.org$/, 'service', 0.6],
    [/@editorialmanager\.com$/, 'service', 0.95],
    [/@manuscriptcentral\./, 'service', 0.95],
    [/@scholarone/, 'service', 0.95],
    [/@reviewerreply/, 'service', 0.9],
    [/@nature\.com$/, 'service', 0.5],
    [/@wiley\.com$/, 'service', 0.5],
    [/@sciencemag\.org$/, 'service', 0.5],
    [/@postmaster\./, 'noise', 0.9],
    [/^mailer-daemon@/, 'noise', 0.99],
    [/^no.?reply@/, 'noise', 0.6],
    [/@amazon\.com$/, 'personal', 0.5],
    [/@opentable\./, 'personal', 0.9],
    [/@doordash\./, 'personal', 0.95],
    [/@ubereats\./, 'personal', 0.95],
    [/@linkedin\.com$/, 'noise', 0.8],
    [/@hr\.arizona\.edu$/, 'admin', 0.9],
    [/@financial-services\.arizona\.edu$/, 'admin', 0.9],
    [/@facilities\.arizona\.edu$/, 'admin', 0.9],
    [/@sponsor\.arizona\.edu$/, 'research', 0.85],
    [/@rgw\.arizona\.edu$/, 'research', 0.85],
    [/@grants\.arizona\.edu$/, 'research', 0.9],
    [/@comms\.arizona\.edu$/, 'admin', 0.5],
    [/@list\.arizona\.edu$/, 'admin', 0.3],
    [/@lists\.arizona\.edu$/, 'admin', 0.3],
  ];

  // --- email_classify_rules.py: SUBJECT_HINTS ---  [regex, category, weight]
  var SUBJECT_HINTS = [
    [/\b(syllabus|midterm|final exam|office hours|grading|homework|assignment|lecture|course)\b/i, 'teaching', 0.7],
    [/\b(BME|ECE|CHEE|BE)\s?\d{3}\b/, 'teaching', 0.85],
    [/\b(student|TA|teaching assistant)\b/i, 'teaching', 0.4],
    [/\b(grant|NIH|NSF|R01|R21|R03|K99|F32|DP2|proposal|award|funding)\b/i, 'research', 0.7],
    [/\b(IRB|IACUC|biosafety|COI|conflict of interest)\b/i, 'admin', 0.7],
    [/\b(manuscript|submission|revision|reviewer|decision)\b/i, 'service', 0.55],
    [/\b(peer review|review invitation|reviewing for)\b/i, 'service', 0.9],
    [/\b(committee|search committee|promotion|tenure)\b/i, 'service', 0.7],
    [/\b(travel|reimbursement|receipt|per diem|concur)\b/i, 'admin', 0.75],
    [/\b(purchase order|requisition|PO ?\d+|UAccess)\b/i, 'admin', 0.85],
    [/\b(abstract|conference|symposium|poster|talk)\b/i, 'research', 0.4],
    [/\b(seminar|colloquium|speaker)\b/i, 'service', 0.35],
    [/\b(order|shipment|delivered|tracking|package)\b/i, 'admin', 0.5],
    [/\b(out of office|ooo)\b/i, 'noise', 0.6],
    [/\b(unsubscribe|newsletter|digest|weekly update)\b/i, 'noise', 0.6],
    [/\b(meeting|calendar|invitation)\b/i, 'admin', 0.25],
    [/\b(lab meeting|group meeting)\b/i, 'research', 0.75],
    [/\b(rotation|phd|dissertation|thesis|qualifying exam)\b/i, 'teaching', 0.5],
  ];

  // Port of email_noise_rules.classify_noise(subject, sender) — sender lowercased.
  function classifyNoise(subject, sender) {
    var subj = subject || '';
    var snd = (sender || '').toLowerCase().trim();
    for (var i = 0; i < NOISE_SUBJECTS.length; i++) {
      if (NOISE_SUBJECTS[i][0].test(subj)) return { noise: true, why: 'subj:' + NOISE_SUBJECTS[i][1] };
    }
    for (var j = 0; j < NOISE_SENDERS.length; j++) {
      if (NOISE_SENDERS[j].test(snd)) return { noise: true, why: 'sender:' + NOISE_SENDERS[j].source };
    }
    return { noise: false, why: '' };
  }

  // Shared scoring core for guess() and rank(). Normalizes senders/subject
  // (see the case-folding note below), applies the noise override, then sums
  // domain + subject hint weights per category. Returns either a noise verdict
  // or the raw per-category score map plus the rule trail.
  //
  // Lowercase + trim senders before matching. The lowercasing INTENTIONALLY
  // diverges from the Python source (which matches case-sensitively): email
  // domains are case-insensitive per RFC 5321 and every pattern here is
  // lowercase, so folding case can only add correct matches, never wrong
  // ones. The trim guards the `^`/`$`-anchored patterns against stray
  // leading/trailing whitespace (JS `$`, unlike Python's, does not match
  // before a trailing newline). Don't "restore" case-sensitivity here.
  function scoreEmail(email) {
    email = email || {};
    var from = email.from || [];
    var senders = [];
    for (var i = 0; i < from.length; i++) {
      var e = (from[i] && from[i].email || '').toLowerCase().trim();
      if (e) senders.push(e);
    }
    var subject = (email.subject || '').trim();
    var primary = senders.length ? senders[0] : '';

    // HIGH-CONFIDENCE NOISE OVERRIDE — sender/subject definite-noise → skip the rest.
    var n = classifyNoise(subject, primary);
    if (n.noise) return { noise: true, why: n.why, scores: {}, rules: ['noise-rule:' + n.why] };

    var scores = {};
    var rules = [];
    var k;
    for (k = 0; k < DOMAIN_HINTS.length; k++) {
      var dpat = DOMAIN_HINTS[k][0], dcat = DOMAIN_HINTS[k][1], dw = DOMAIN_HINTS[k][2];
      for (var s = 0; s < senders.length; s++) {
        if (dpat.test(senders[s])) {
          scores[dcat] = (scores[dcat] || 0) + dw;
          rules.push('domain:' + dpat.source + '->' + dcat);
          break; // one hit per pattern (mirrors the Python `break`)
        }
      }
    }
    for (k = 0; k < SUBJECT_HINTS.length; k++) {
      var spat = SUBJECT_HINTS[k][0], scat = SUBJECT_HINTS[k][1], sw = SUBJECT_HINTS[k][2];
      if (spat.test(subject)) {
        scores[scat] = (scores[scat] || 0) + sw;
        rules.push('subj:' + spat.source + '->' + scat);
      }
    }
    return { noise: false, why: '', scores: scores, rules: rules };
  }

  // Port of email_classify_rules.classify_one(entry).
  // `email` needs { from: [{email}], subject }. Returns:
  //   { category, confidence (0..1), needs_llm, rules:[...] }
  // category 'unknown' (confidence 0) means no rule matched.
  function guess(email) {
    var sc = scoreEmail(email);
    if (sc.noise) return { category: 'noise', confidence: 0.95, needs_llm: false, rules: sc.rules };

    var scores = sc.scores;
    var cats = Object.keys(scores);
    if (!cats.length) return { category: 'unknown', confidence: 0, needs_llm: true, rules: [] };

    cats.sort(function (a, b) { return scores[b] - scores[a]; });
    var topCat = cats[0], topScore = scores[topCat];
    var total = 0, k;
    for (k = 0; k < cats.length; k++) total += scores[cats[k]];
    var conf = total ? topScore / total : 0;
    var needsLlm = conf < 0.6;
    if (cats.length >= 2) {
      var second = scores[cats[1]];
      if ((topScore - second) / total < 0.25) needsLlm = true;
    }
    return { category: topCat, confidence: Math.round(conf * 1000) / 1000, needs_llm: needsLlm, rules: sc.rules };
  }

  // Ranked candidate categories for the inline quick-sort pill bar. Returns a
  // confidence-sorted array of { category, score, confidence } — best guess
  // first. A definite-noise verdict collapses to a single high-confidence
  // 'noise' candidate. An email no rule matches returns [] (the caller then
  // falls back to showing every category unranked).
  function rank(email) {
    var sc = scoreEmail(email);
    if (sc.noise) return [{ category: 'noise', score: 1, confidence: 0.95 }];
    var scores = sc.scores;
    var cats = Object.keys(scores);
    if (!cats.length) return [];
    var total = 0, k;
    for (k = 0; k < cats.length; k++) total += scores[cats[k]];
    cats.sort(function (a, b) { return scores[b] - scores[a]; });
    var out = [];
    for (k = 0; k < cats.length; k++) {
      out.push({
        category: cats[k],
        score: scores[cats[k]],
        confidence: total ? Math.round((scores[cats[k]] / total) * 1000) / 1000 : 0,
      });
    }
    return out;
  }

  // Read-only view of the rule tables for the Classifier Settings page — so the
  // fallback layer's weights are as transparent as the learned model's.
  function describe() {
    function rows(arr) {
      return arr.map(function (r) { return { pattern: r[0].source, category: r[1], weight: r[2] }; });
    }
    return {
      domainHints: rows(DOMAIN_HINTS),
      subjectHints: rows(SUBJECT_HINTS),
      noiseSubjects: NOISE_SUBJECTS.map(function (r) { return { pattern: r[0].source, reason: r[1] }; }),
      noiseSenders: NOISE_SENDERS.map(function (r) { return { pattern: r.source }; }),
    };
  }

  window.CATEGORY_RULES = { guess: guess, rank: rank, classifyNoise: classifyNoise, describe: describe };
})();

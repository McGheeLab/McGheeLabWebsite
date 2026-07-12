/* training-paper-peer-review.js — V3.188.
 *
 * Lecture page on the peer-review + revision-letter process.
 * Two interactive widgets:
 *   - Reviewer-comment classifier (regex heuristics for 6 categories +
 *     a response-template suggestion per category, plus preset examples)
 *   - Response-letter builder capstone: pick agree/partial/disagree
 *     response shape, fill in reviewer-comment + your-response +
 *     manuscript-reference; tool emits the canonical point-by-point
 *     block, runs a tone-check for defensive / combative phrasing,
 *     stacks multiple blocks as a letter preview
 * Plus standard TOC scroll-spy.
 */
(function () {
  'use strict';

  function wireToc() {
    const links = Array.from(document.querySelectorAll('.training-toc a'));
    if (!links.length) return;
    const sections = links.map(a => {
      const id = (a.getAttribute('href') || '').replace(/^#/, '');
      return id ? document.getElementById(id) : null;
    }).filter(Boolean);
    function findActive() {
      const offset = 140;
      let active = sections[0];
      for (const s of sections) {
        const r = s.getBoundingClientRect();
        if (r.top - offset <= 0) active = s; else break;
      }
      return active;
    }
    function sync() {
      const a = findActive();
      const aid = a ? a.id : null;
      links.forEach(link => {
        const lid = (link.getAttribute('href') || '').replace(/^#/, '');
        link.classList.toggle('active', lid === aid);
      });
    }
    let scheduled = false;
    window.addEventListener('scroll', () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; sync(); });
    }, { passive: true });
    sync();
  }

  function escapeHtml(s) {
    if (s == null) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  // ── Comment classifier ───────────────────────────────────────────
  // Regex heuristics. Score each category; pick the highest.
  const CATEGORY_RULES = {
    statistical: {
      label: 'Statistical',
      patterns: [
        /\bp[\s-]?value/i, /\bp\s*[<=>]\s*0?\.\d+/i,
        /\bn\s*=\s*\d+/i, /\bsample\s+size/i, /\bpower\s+analysis/i,
        /\bt-test|ANOVA|Mann-Whitney|Wilcoxon|Bonferroni|FDR\b/i,
        /\bstatistical\b/i, /\bsignificance|significant\b/i,
        /\berror\s+bars?/i, /\bSEM\b|\bSD\b|\bstandard deviation\b/i,
        /\bnormality|distribution\b/i,
      ],
      response:
        'Statistical comments usually require either (a) adding the requested analysis to the Methods + Results, or (b) explaining why your current choice is appropriate. Bring evidence: cite the test\'s assumptions and how your data satisfy them, or run the alternative and report what it shows. Almost always: state the n explicitly with units ("n=12 spheroids"), name the test, give the exact p value, and report the multiple-comparison correction if any.',
    },
    methodological: {
      label: 'Methodological',
      patterns: [
        /\bcontrol(?!led)\b/i, /\bdid\s+not\s+control/i,
        /\bmethod(?!s?-)\b/i, /\bapproach/i,
        /\bmissing\s+experiment/i, /\bshould\s+have\s+tested\b/i,
        /\bvalidat(e|ion)/i, /\breplicate/i,
        /\bartifact/i, /\bconfound/i,
        /\bspecificity|specific\s+to/i, /\bblind(ed)?\b/i,
      ],
      response:
        'Methodological comments usually require either (a) running the requested control, (b) citing prior work that establishes the technique, or (c) explaining why the control is unnecessary given your experimental design. If it\'s a fast control, just do it — the editor will weigh "added control" much more favorably than "we explain why this isn\'t needed."',
    },
    literature: {
      label: 'Literature',
      patterns: [
        /\b(did|do)\s+not\s+cite/i, /\bmissed\s+(this\s+)?paper/i,
        /\b(missing|absent)\s+(citation|reference)/i,
        /\bprior\s+work/i, /\bprevious(ly)?\s+(shown|reported|published|studied)/i,
        /\b(e\.g\.,?\s+)?[A-Z][a-z]+\s+et\s+al\.?\s+\d{4}/,  // "Smith et al. 2019"
        /\b[A-Z][a-z]+\s+\(\d{4}\)/,                          // "Smith (2019)"
        /\brelevant\s+literature/i, /\bnot\s+(novel|new)\b/i,
      ],
      response:
        'Literature comments are usually low-effort to address: read the cited paper, decide how it relates, add a citation + a sentence to the Introduction or Discussion situating your work against it. If the reviewer thinks you missed something but you actually addressed it elsewhere, point at where (with page + line) — don\'t just say "we cited it" without specifics.',
    },
    interpretation: {
      label: 'Interpretation',
      patterns: [
        /\byour\s+data\s+(do(es)?\s+not|don[\'’]t)\s+support/i,
        /\bover[-\s]?claim/i, /\bover[-\s]?interpret/i,
        /\b(could|might|may)\s+(also|equally)\s+be/i,
        /\balternative\s+(interpretation|explanation)/i,
        /\bconclu(de|sion)\b.{0,40}\b(too\s+strong|unsupported|exceeds)/i,
        /\b(claim|conclusion)\b.{0,40}\b(too\s+broad|too\s+strong|unsupported)/i,
        /\bmechanism.{0,40}\b(unclear|not\s+established)/i,
      ],
      response:
        'Interpretation comments target your Discussion. Almost always: soften the over-claim by adding scope-bounding language ("in BT-549 spheroids," "under the conditions tested"), acknowledge the alternative explanation explicitly, and explain why your data favor one over the other (or admit you cannot distinguish). The "we cannot rule out X" framing from V3.182 / V3.186 is your friend.',
    },
    stylistic: {
      label: 'Stylistic / presentation',
      patterns: [
        /\bunclear|confusing|hard\s+to\s+(follow|understand)/i,
        /\brewrite|re-?write/i, /\brewording/i,
        /\bfigure\s+\d?\s*(is\s+)?(unclear|hard\s+to\s+read|too\s+small)/i,
        /\bcaption|legend/i, /\bcolor\s+scheme/i,
        /\btoo\s+(long|short|wordy)/i,
        /\borganization|structure/i, /\bflow\b/i,
        /\bgrammar|typo|spelling/i,
      ],
      response:
        'Stylistic comments are usually fast wins. Re-read the flagged sentence / paragraph / figure with the reviewer\'s critique in mind; if you can see the issue, fix it. If you can\'t, ask a co-author to read it fresh — they\'ll usually see it. The response is short: "We have revised this paragraph for clarity (p. X, lines Y)."',
    },
    'scope-creep': {
      label: 'Scope-creep',
      patterns: [
        /\bshould\s+(also\s+)?(test|examine|investigate|measure|validate)/i,
        /\bin\s+vivo\b/i, /\bother\s+cell\s+lines?/i,
        /\bextend\s+(the\s+)?(analysis|study)/i,
        /\badditional\s+experiment/i,
        /\b(would|could)\s+(be\s+)?(interesting|informative)\s+to\s+(see|test)/i,
        /\bwhat\s+about\s+\w+\?/i,
        /\bgeneraliz(e|ation)/i,
      ],
      response:
        'Scope-creep is where you need to push back diplomatically. The right move: name the underlying scientific concern the reviewer is voicing, agree that the suggestion would strengthen the paper, then explain why it\'s beyond scope (multi-month experiment / different model system / requires reagents you don\'t have / etc.). Add a sentence to the Discussion acknowledging the limitation; the editor will usually side with you against unreasonable scope-creep when your response is well-framed.',
    },
  };

  // Preset comment examples for the classifier widget
  const PRESETS = {
    stat:   'The authors do not justify n=12 with a power analysis. Given the small sample size, the statistical claims of significance at p<0.05 should be interpreted with caution. We recommend a power calculation be added to the Methods.',
    meth:   'The authors did not include a control for matrix swelling, which could confound the stiffness-invasion comparison at long timepoints. A no-cell control on the matrix would address this.',
    lit:    'The authors fail to cite Smith et al. 2019, which reported a similar stiffness-dependent inversion in glioma spheroids using comparable methods. This prior work needs to be discussed in the Introduction.',
    interp: 'The conclusion that "edge density is the missing variable" is too strong given that only 5 cell lines were tested. The mechanism could equally be explained by intracellular tension changes downstream of density.',
    scope:  'It would be very informative to see whether the inversion holds in vivo, for example in a mouse xenograft model. The authors should also test whether the effect is preserved in additional cell lines beyond breast.',
  };

  function classify(text) {
    if (!text || !text.trim()) return null;
    const scores = {};
    for (const [cat, info] of Object.entries(CATEGORY_RULES)) {
      let s = 0;
      for (const re of info.patterns) {
        if (re.test(text)) s++;
      }
      scores[cat] = s;
    }
    let best = null, bestScore = 0;
    for (const [cat, s] of Object.entries(scores)) {
      if (s > bestScore) { bestScore = s; best = cat; }
    }
    return best ? { category: best, score: bestScore, scores } : null;
  }

  function wireClassifier() {
    const ta = document.getElementById('rc-comment');
    const verdict = document.getElementById('rc-verdict');
    const tplBox = document.getElementById('rc-template');
    const tplMeta = document.getElementById('rc-meta');
    const tplBody = document.getElementById('rc-template-body');

    function refresh() {
      const text = (ta.value || '').trim();
      if (!text) {
        verdict.classList.remove('is-warning', 'is-critical');
        verdict.innerHTML = 'Paste a comment or pick a preset to classify it.';
        tplBox.style.display = 'none';
        return;
      }
      const r = classify(text);
      if (!r) {
        verdict.classList.remove('is-warning', 'is-critical');
        verdict.classList.add('is-warning');
        verdict.innerHTML = '<strong>Could not classify.</strong> The comment doesn\'t match any of the six categories\' patterns cleanly. Read it carefully — sometimes a comment is a mix of types, or genuinely doesn\'t fit. Treat the highest-overlap category as a starting point and add specifics from the comment\'s actual content.';
        tplBox.style.display = 'none';
        return;
      }
      const info = CATEGORY_RULES[r.category];
      verdict.classList.remove('is-warning', 'is-critical');
      verdict.innerHTML = '<strong>Classified as: ' + escapeHtml(info.label) + '.</strong> ' +
        'Pattern hits: ' + r.score +
        '. Other categories scored: ' +
        Object.entries(r.scores)
          .filter(([k, v]) => k !== r.category && v > 0)
          .map(([k, v]) => escapeHtml(CATEGORY_RULES[k].label) + ' (' + v + ')')
          .join(', ') + (Object.entries(r.scores).filter(([k, v]) => k !== r.category && v > 0).length === 0 ? '(clean match — no other categories triggered)' : '') + '.';
      tplMeta.textContent = 'Category: ' + info.label;
      tplBody.textContent = info.response;
      tplBox.style.display = '';
    }

    ta.addEventListener('input', refresh);
    document.querySelectorAll('.rc-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.preset;
        const text = PRESETS[key];
        if (!text) return;
        ta.value = text;
        refresh();
      });
    });
    refresh();
  }

  // ── Response-letter builder capstone ─────────────────────────────
  const SHAPE_LABEL = {
    agree:    'Agreement',
    partial:  'Partial agreement',
    disagree: 'Disagreement',
  };

  // Tone-check word lists
  const DEFENSIVE_WORDS = [
    /\bthe\s+reviewer\s+(has\s+)?misunderstood\b/i,
    /\bthe\s+reviewer\s+is\s+(wrong|mistaken|incorrect)\b/i,
    /\bobvious(ly)?\b/i,
    /\bas\s+(we\s+)?clearly\s+stated\b/i,
    /\bas\s+(we\s+)?(already|previously)\s+(noted|stated|said)\b/i,
    /\bwe\s+strongly\s+disagree\b/i,
    /\bthis\s+(comment|critique)\s+is\s+(unfounded|baseless|not\s+supported)\b/i,
    /\bunnecessary\s+(comment|critique)\b/i,
    /\bin\s+fact[, ]/i,        // "In fact, the reviewer is..."
  ];

  const responses = []; // list of {shape, comment, response, change, ref}

  function renderResponses() {
    const out = document.getElementById('rl-output');
    const blocks = document.getElementById('rl-blocks');
    const meta = document.getElementById('rl-meta');
    if (responses.length === 0) {
      out.style.display = 'none';
      return;
    }
    out.style.display = '';
    meta.textContent = responses.length + ' response block' + (responses.length === 1 ? '' : 's') + ' in this letter.';
    blocks.innerHTML = responses.map((r, i) => {
      const opening = {
        agree: 'We thank the reviewer for this observation.',
        partial: 'We agree this is an important concern.',
        disagree: 'We respectfully disagree.',
      }[r.shape] || '';
      const ref = r.ref ? ' (' + escapeHtml(r.ref) + ')' : '';
      const change = r.change ? '<br><em>Specific change:</em> ' + escapeHtml(r.change) + ref : ref;
      return '<div style="margin-bottom:14px;padding:10px 14px;background:var(--bg);border-left:3px solid var(--primary);border-radius:0 var(--radius) var(--radius) 0;">' +
             '<div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">Comment ' + (i + 1) + ' · ' + escapeHtml(SHAPE_LABEL[r.shape] || '—') + '</div>' +
             '<div style="font-style:italic;color:var(--text-muted);margin-bottom:6px;">' + escapeHtml(r.comment) + '</div>' +
             '<div><strong>Response:</strong> ' + escapeHtml(opening) + ' ' + escapeHtml(r.response) + change + '</div>' +
             '</div>';
    }).join('');
  }

  function wireLetterBuilder() {
    const shapeEl = document.getElementById('rl-shape');
    const commentEl = document.getElementById('rl-comment');
    const responseEl = document.getElementById('rl-response');
    const changeEl = document.getElementById('rl-change');
    const refEl = document.getElementById('rl-ref');
    const verdict = document.getElementById('rl-verdict');
    const addBtn = document.getElementById('rl-add');
    const clearBtn = document.getElementById('rl-clear');

    function checkTone(text) {
      const hits = [];
      for (const re of DEFENSIVE_WORDS) {
        const m = text.match(re);
        if (m) hits.push(m[0]);
      }
      return hits;
    }

    function refreshVerdict() {
      const shape = shapeEl.value;
      const comment = (commentEl.value || '').trim();
      const resp = (responseEl.value || '').trim();
      const change = (changeEl.value || '').trim();
      const ref = (refEl.value || '').trim();
      verdict.classList.remove('is-warning', 'is-critical');

      const missing = [];
      if (!shape)   missing.push('response shape');
      if (!comment) missing.push('reviewer comment');
      if (!resp)    missing.push('your response');
      if (!ref)     missing.push('manuscript reference');

      const warnings = [];
      const tone = checkTone(resp);
      if (tone.length) {
        warnings.push('<strong>Tone flag:</strong> the phrase "' + escapeHtml(tone[0]) + '" reads as defensive or combative. Reframe — even when the reviewer is wrong, the editor reads your tone. The "we may have presented this poorly; we have clarified" move (V3.188 § 7) is more effective.');
      }
      if (shape === 'disagree' && !ref) {
        warnings.push('Disagreements without a specific manuscript reference read as hand-waving. Always cite the page/line where you defended or clarified the point.');
      }
      if (shape === 'agree' && !change) {
        warnings.push('Agreement responses should include the specific change you made. "We thank the reviewer" without a change is hollow.');
      }
      if (resp.length < 30 && shape) {
        warnings.push('Response is short (' + resp.length + ' characters). Most response-letter blocks should run 50–200 words. If this is genuinely short, double-check you\'ve addressed the substance.');
      }

      if (missing.length) {
        verdict.classList.add('is-critical');
        verdict.innerHTML = '<strong>Fill in:</strong> ' + missing.join(', ') + '.';
      } else if (warnings.length) {
        verdict.classList.add('is-warning');
        verdict.innerHTML = '<strong>Ready to add, with notes:</strong><ul style="margin:6px 0 0 18px;">' +
          warnings.map(w => '<li>' + w + '</li>').join('') + '</ul>';
      } else {
        verdict.innerHTML = '<strong>Looks clean.</strong> Click "Add this response" to append it to the letter preview.';
      }
    }

    [shapeEl, commentEl, responseEl, changeEl, refEl].forEach(el => {
      el.addEventListener('input', refreshVerdict);
      el.addEventListener('change', refreshVerdict);
    });

    addBtn.addEventListener('click', () => {
      const shape = shapeEl.value;
      const comment = (commentEl.value || '').trim();
      const resp = (responseEl.value || '').trim();
      const change = (changeEl.value || '').trim();
      const ref = (refEl.value || '').trim();
      if (!shape || !comment || !resp || !ref) {
        refreshVerdict();
        return;
      }
      responses.push({ shape, comment, response: resp, change, ref });
      // Clear inputs (preserve shape for likely repeated use)
      commentEl.value = '';
      responseEl.value = '';
      changeEl.value = '';
      refEl.value = '';
      renderResponses();
      refreshVerdict();
    });

    clearBtn.addEventListener('click', () => {
      responses.length = 0;
      renderResponses();
      refreshVerdict();
    });

    refreshVerdict();
    renderResponses();
  }

  function init() {
    wireToc();
    wireClassifier();
    wireLetterBuilder();
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) {
      firebridge.whenAuthResolved().then(init).catch(init);
    } else {
      init();
    }
  });
})();

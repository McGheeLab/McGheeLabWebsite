/* training-paper-results.js — V3.185.
 *
 * Lecture page on writing the Results section.
 * Two interactive widgets:
 *   - Reporter-vs-Advocate compare-bar (shared widget from V3.163)
 *   - Figure-alignment checker: paste a paragraph; tool flags sentences
 *     that don't reference a figure and Advocate-voice words that
 *     belong in Discussion. Highlights inline.
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

  function wireComparators() {
    document.querySelectorAll('.compare-bar').forEach(bar => {
      const group = bar.dataset.compare;
      const buttons = bar.querySelectorAll('.compare-btn');
      buttons.forEach(btn => {
        btn.addEventListener('click', () => {
          const side = btn.dataset.side;
          buttons.forEach(b => b.classList.toggle('active', b === btn));
          document.querySelectorAll('[data-pane^="' + group + '-"]').forEach(p => {
            p.classList.toggle('is-active', p.dataset.pane === group + '-' + side);
          });
        });
      });
    });
  }

  // ── Figure-alignment checker ──────────────────────────────────────
  // Word lists that should NOT appear in Results (Advocate voice).
  const ADVOCATE_WORDS = [
    'interestingly', 'importantly', 'remarkably', 'strikingly', 'surprisingly',
    'notably', 'crucially', 'critically',
    'suggests', 'suggest', 'argues', 'arguing', 'argue for',
    'likely because', 'possibly because', 'may explain',
    'appears to be', 'appear to be',
    'as expected', 'as predicted',
    'consistent with the hypothesis', 'in agreement with',
  ];

  // Figure references that count as panel citations
  const FIG_RE = /\b(Fig\.?\s*\d+|Figure\s*\d+|panel\s+[a-z])\b/i;

  // Statistics markers
  const STATS_RE = /\b(p\s*[=<>]\s*0?\.\d+|n\s*=\s*\d+|t-test|ANOVA|Mann-Whitney|Wilcoxon|Bonferroni|SEM|SD\b)/i;

  function escapeHtml(s) {
    if (s == null) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  function splitSentences(text) {
    // Naive sentence split — handles ". " / "! " / "? " but preserves trailing punctuation
    const out = [];
    const parts = text.split(/(?<=[.!?])\s+(?=[A-Z(])/);
    for (const p of parts) {
      const t = p.trim();
      if (t) out.push(t);
    }
    return out;
  }

  function analyzeAndAnnotate(text) {
    const sentences = splitSentences(text);
    let figCount = 0;
    let statsCount = 0;
    let advocateMatches = 0;
    const annotated = sentences.map(s => {
      let html = escapeHtml(s);
      const citesFig = FIG_RE.test(s);
      const hasStats = STATS_RE.test(s);
      if (citesFig) figCount++;
      if (hasStats) statsCount++;

      // Highlight advocate words (case-insensitive). Do this in HTML-escaped string,
      // so we don't accidentally re-escape.
      ADVOCATE_WORDS.forEach(w => {
        const re = new RegExp('\\b(' + w.replace(/\s+/g, '\\s+') + ')\\b', 'gi');
        html = html.replace(re, (match) => {
          advocateMatches++;
          return '<span style="background:var(--red-bg);color:var(--red);padding:1px 3px;border-radius:3px;">' + match + '</span>';
        });
      });

      // If a sentence has no figure citation AND no obvious "introductory" verb
      // (e.g. is a quantitative claim), flag it with amber
      const looksQuant = /\b(increased|decreased|fold|%|p\s*[<=>]|n\s*=)\b/i.test(s);
      if (!citesFig && looksQuant) {
        html = '<span style="background:var(--amber-bg);padding:1px 3px;border-radius:3px;">' + html + '</span>';
      }
      return html + ' ';
    });
    return {
      sentences: sentences.length,
      figCount, statsCount, advocateMatches,
      html: annotated.join(''),
    };
  }

  function wireChecker() {
    const ta = document.getElementById('rc-input');
    const sentencesEl = document.getElementById('rc-sentences');
    const figsEl = document.getElementById('rc-figs');
    const advocateEl = document.getElementById('rc-advocate');
    const statsEl = document.getElementById('rc-stats');
    const verdict = document.getElementById('rc-verdict');
    const output = document.getElementById('rc-output');
    const body = document.getElementById('rc-body');

    function refresh() {
      const text = (ta.value || '').trim();
      if (!text) {
        sentencesEl.textContent = '—';
        figsEl.textContent = '—';
        advocateEl.textContent = '—';
        statsEl.textContent = '—';
        verdict.classList.remove('is-warning', 'is-critical');
        verdict.innerHTML = 'Paste a paragraph to analyze it.';
        output.style.display = 'none';
        return;
      }
      const r = analyzeAndAnnotate(text);
      sentencesEl.textContent = r.sentences;
      figsEl.textContent = r.figCount + ' / ' + r.sentences;
      advocateEl.textContent = r.advocateMatches;
      statsEl.textContent = r.statsCount + ' sentence' + (r.statsCount === 1 ? '' : 's') + ' with stats';

      // Verdict
      verdict.classList.remove('is-warning', 'is-critical');
      const warnings = [];
      if (r.advocateMatches > 0) {
        warnings.push(r.advocateMatches + ' Advocate-voice word' + (r.advocateMatches === 1 ? '' : 's') + ' flagged — those belong in the Discussion.');
      }
      if (r.figCount === 0 && r.sentences >= 2) {
        warnings.push('No sentence cites a figure. Results paragraphs should anchor to panels.');
      } else if (r.sentences >= 3 && r.figCount < r.sentences / 2) {
        warnings.push('Fewer than half your sentences cite a figure. Most Results sentences should reference the panel they\'re reporting on.');
      }
      if (r.statsCount === 0 && /\b(increased|decreased|fold|%)\b/i.test(text)) {
        warnings.push('Quantitative claims present but no statistics inline (n=, p=, test name). Reviewers will flag this.');
      }

      if (warnings.length === 0) {
        verdict.innerHTML = '<strong>Reads like Results.</strong> Figure-anchored, neutral, statistics where claims appear. Reporter voice maintained.';
      } else {
        verdict.classList.add('is-warning');
        verdict.innerHTML = '<strong>' + warnings.length + ' issue' + (warnings.length === 1 ? '' : 's') + ' to address:</strong><ul style="margin:6px 0 0 18px;">' +
          warnings.map(w => '<li>' + w + '</li>').join('') + '</ul>';
      }
      body.innerHTML = r.html;
      output.style.display = '';
    }

    ta.addEventListener('input', refresh);
    refresh();
  }

  function init() {
    wireToc();
    wireComparators();
    wireChecker();
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (typeof firebridge !== 'undefined' && firebridge.requireSignIn) {
      firebridge.requireSignIn('Sign in to track your training progress.').then(init).catch(init);
    } else {
      init();
    }
  });
})();

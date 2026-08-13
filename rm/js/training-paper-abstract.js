/* training-paper-abstract.js — V3.187.
 *
 * Lecture page on writing the Abstract.
 * Two interactive widgets:
 *   - Structured-vs-unstructured compare-bar (shared widget from V3.163)
 *   - Word-budget tool: paste an Abstract, count total words, classify
 *     sentences as motivation / method / result / impact via cue-word
 *     heuristics, compare to target 20/20/40/20 distribution, flag
 *     ceiling violations + skewed budgets.
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

  // ── Word-budget tool ──────────────────────────────────────────────
  // Sentence-classifier heuristics: cue-word lists per Abstract part.
  const CUES = {
    motivation: [
      /\b(remain[s]? contested|contested|disagree|controversial|unresolved|unknown|unclear|missing)\b/i,
      /\b(reported (to|that)|prior (work|studies)|previously)\b/i,
      /\b(is (a |the )?major)\b/i,
    ],
    method: [
      /\b(we (use[d]?|employed|performed|measured|imaged|quantified|developed|tested|characterized))\b/i,
      /\b(here we (apply|use|deploy|build|introduce))\b/i,
      /\b(by (using|imaging|measuring|combining|applying))\b/i,
      /\b(in this (study|paper|work))\b/i,
    ],
    result: [
      /\b(we (show|find|demonstrate|observe|report|identify|reveal|confirm|establish))\b/i,
      /\b(here we show)\b/i,
      /\b(\d+(\.\d+)?\s*-?fold|\d+(\.\d+)?\s*%|p\s*[<=]\s*0?\.\d+|n\s*=\s*\d+)\b/i,
      /\b(increase[ds]?|decrease[ds]?|inverted|reversed|attenuated)\b/i,
    ],
    impact: [
      /\b(implication[s]?|impact|consequence[s]?|importance|provides? (a )?framework|opens? up|paves? the way)\b/i,
      /\b(future (work|experiments|studies))\b/i,
      /\b(should be|may be used|can be applied)\b/i,
      /\b(missing variable|resolve[ds]?|reconcile[ds]?)\b/i,
    ],
  };

  function splitSentences(text) {
    const parts = text.split(/(?<=[.!?])\s+(?=[A-Z(])/);
    return parts.map(p => p.trim()).filter(Boolean);
  }

  function classifySentence(s) {
    const scores = { motivation: 0, method: 0, result: 0, impact: 0 };
    for (const [key, patterns] of Object.entries(CUES)) {
      for (const re of patterns) {
        if (re.test(s)) scores[key]++;
      }
    }
    let best = 'motivation', bestScore = -1;
    for (const k of ['motivation', 'method', 'result', 'impact']) {
      if (scores[k] > bestScore) { best = k; bestScore = scores[k]; }
    }
    return bestScore > 0 ? best : 'motivation'; // default to motivation for unclassified opening
  }

  function countWords(s) {
    if (!s) return 0;
    const m = s.match(/\S+/g);
    return m ? m.length : 0;
  }

  function wireBudgetTool() {
    const limitEl = document.getElementById('ab-limit');
    const ta = document.getElementById('ab-input');
    const totalEl = document.getElementById('ab-total');
    const motivEl = document.getElementById('ab-motiv');
    const methodEl = document.getElementById('ab-method');
    const resultEl = document.getElementById('ab-result');
    const impactEl = document.getElementById('ab-impact');
    const verdict = document.getElementById('ab-verdict');

    function fmt(words, totalWords, target) {
      if (!totalWords) return '—';
      const pct = Math.round((words / totalWords) * 100);
      let flag = '';
      if (Math.abs(pct - target) > 15) flag = ' ⚠';
      return words + ' (' + pct + '%' + flag + ')';
    }

    function refresh() {
      const limit = parseInt(limitEl.value, 10) || 0;
      const text = (ta.value || '').trim();
      if (!text) {
        totalEl.textContent = '—';
        motivEl.textContent = '—';
        methodEl.textContent = '—';
        resultEl.textContent = '—';
        impactEl.textContent = '—';
        verdict.classList.remove('is-warning', 'is-critical');
        verdict.innerHTML = 'Paste your Abstract to analyze the word budget.';
        return;
      }
      const totalWords = countWords(text);
      const sentences = splitSentences(text);
      const partWords = { motivation: 0, method: 0, result: 0, impact: 0 };
      sentences.forEach(s => {
        const part = classifySentence(s);
        partWords[part] += countWords(s);
      });
      totalEl.textContent = totalWords + (limit ? ' / ' + limit : '');
      motivEl.textContent = fmt(partWords.motivation, totalWords, 20);
      methodEl.textContent = fmt(partWords.method, totalWords, 20);
      resultEl.textContent = fmt(partWords.result, totalWords, 40);
      impactEl.textContent = fmt(partWords.impact, totalWords, 20);

      verdict.classList.remove('is-warning', 'is-critical');
      const warnings = [];
      if (limit && totalWords > limit) {
        warnings.push('<strong>Over the ' + limit + '-word limit by ' + (totalWords - limit) + ' words.</strong> Trim before submission — most journals reject over-limit Abstracts at desk-check.');
      }
      // Skewed-budget checks
      const target = { motivation: 20, method: 20, result: 40, impact: 20 };
      for (const k of ['motivation', 'method', 'result', 'impact']) {
        const pct = (partWords[k] / totalWords) * 100;
        if (Math.abs(pct - target[k]) > 20) {
          warnings.push(k.charAt(0).toUpperCase() + k.slice(1) + ' is ' + pct.toFixed(0) + '% of words (target ' + target[k] + '%). ' +
            (pct > target[k] ? 'Too much weight on this section — compress.' : 'Too little — your Abstract is missing this part of the four-part shape.'));
        }
      }
      if (partWords.result === 0) {
        warnings.push('<strong>No Result sentences detected.</strong> The Abstract\'s biggest section should be your finding ("we show...", numbers, fold-changes). Add at least one Result sentence.');
      }
      if (partWords.impact === 0) {
        warnings.push('<strong>No Impact sentences detected.</strong> Close with one sentence on what your finding changes (avoid "further studies are needed").');
      }
      if (limit && totalWords > 0 && totalWords < limit * 0.6) {
        warnings.push('Well under the ' + limit + '-word ceiling. You have headroom — expand the Result or Impact sections.');
      }

      if (warnings.length === 0) {
        verdict.innerHTML = '<strong>Budget looks healthy.</strong> Four-part shape covered, distribution near target, within journal ceiling.';
      } else {
        verdict.classList.add('is-warning');
        verdict.innerHTML = '<strong>' + warnings.length + ' issue' + (warnings.length === 1 ? '' : 's') + ':</strong><ul style="margin:6px 0 0 18px;">' +
          warnings.map(w => '<li>' + w + '</li>').join('') + '</ul>';
      }
    }
    limitEl.addEventListener('change', refresh);
    ta.addEventListener('input', refresh);
    refresh();
  }

  function init() {
    wireToc();
    wireComparators();
    wireBudgetTool();
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (typeof firebridge !== 'undefined' && firebridge.requireSignIn) {
      firebridge.requireSignIn('Sign in to track your training progress.').then(init).catch(init);
    } else {
      init();
    }
  });
})();

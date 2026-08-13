/* training-paper-introduction.js — V3.183.
 *
 * Lecture page covering the 3-paragraph Introduction funnel.
 * Two interactive widgets:
 *   - compare-bar toggles for the ¶1 and ¶2 good-vs-mediocre examples
 *     (reuses the shared widget pattern from V3.163)
 *   - last-paragraph builder: 3 input lines → canonical Storyteller-
 *     voice elevator pitch with "Here we show..." closing sentence
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

  // ── Last-paragraph builder ────────────────────────────────────────
  function lowerFirst(s) { if (!s) return ''; return s.charAt(0).toLowerCase() + s.slice(1); }

  function renderLastParagraph(hypo, approach, finding) {
    if (!hypo || !approach || !finding) return '';
    // Sentence 1: "We reasoned that..."  → hypothesis
    // Sentence 2: "To test this, we..."  → approach
    // Sentence 3: "Here we show that..." → headline finding
    const s1 = 'We reasoned that ' + lowerFirst(hypo.replace(/[.!?]$/, '')) + '.';
    const s2 = 'To test this, we used ' + lowerFirst(approach.replace(/[.!?]$/, '')) + '.';
    const s3 = 'Here we show that ' + lowerFirst(finding.replace(/[.!?]$/, '')) + '.';
    return s1 + ' ' + s2 + ' ' + s3;
  }

  function wireBuilder() {
    const hypoEl     = document.getElementById('lp-hypo');
    const approachEl = document.getElementById('lp-approach');
    const findingEl  = document.getElementById('lp-finding');
    const verdict    = document.getElementById('lp-verdict');
    const output     = document.getElementById('lp-output');
    const body       = document.getElementById('lp-body');

    function refresh() {
      const hypo = (hypoEl.value || '').trim();
      const approach = (approachEl.value || '').trim();
      const finding = (findingEl.value || '').trim();
      const missing = [];
      if (!hypo)     missing.push('hypothesis');
      if (!approach) missing.push('approach');
      if (!finding)  missing.push('headline finding');

      verdict.classList.remove('is-warning', 'is-critical');
      if (missing.length) {
        verdict.classList.add('is-critical');
        verdict.innerHTML = '<strong>Fill in every field.</strong> Still needed: ' + missing.join(', ') + '.';
        output.style.display = 'none';
        return;
      }
      // Sanity checks
      const warnings = [];
      if (finding.length < 25) {
        warnings.push('The headline finding is short. Make sure it states a claim ("X happens"), not just a topic ("we investigated X").');
      }
      if (finding.toLowerCase().includes('we investigated') || finding.toLowerCase().includes('we studied') || finding.toLowerCase().includes('we examined')) {
        warnings.push('The headline finding describes the activity ("we investigated") rather than the result. Re-write to state what you found.');
      }
      if (approach.length > 200) {
        warnings.push('Approach is over 200 characters — the Introduction\'s job is not to recite Methods. Compress to a single technique-level sentence.');
      }

      const para = renderLastParagraph(hypo, approach, finding);
      body.textContent = para;
      output.style.display = '';

      if (warnings.length) {
        verdict.classList.add('is-warning');
        verdict.innerHTML = '<strong>Rendered with notes:</strong><ul style="margin:6px 0 0 18px;">' +
          warnings.map(w => '<li>' + w + '</li>').join('') + '</ul>';
      } else {
        verdict.innerHTML = '<strong>Last paragraph rendered.</strong> Storyteller voice, 3-sentence canonical pattern. Copy into your paper builder if it reads cleanly.';
      }
    }
    [hypoEl, approachEl, findingEl].forEach(el => {
      el.addEventListener('input', refresh);
      el.addEventListener('change', refresh);
    });
    refresh();
  }

  function init() {
    wireToc();
    wireComparators();
    wireBuilder();
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (typeof firebridge !== 'undefined' && firebridge.requireSignIn) {
      firebridge.requireSignIn('Sign in to track your training progress.').then(init).catch(init);
    } else {
      init();
    }
  });
})();

/* training-paper-discussion.js — V3.186.
 *
 * Lecture page on writing the Discussion section.
 * Three interactive widgets:
 *   - Limitation honesty meter (1–7 slider; example phrasings)
 *   - Four-jobs coverage checklist (12 items)
 *   - (compare-bar reused — none in this module, but TOC + scroll-spy)
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

  // ── Limitation honesty meter ──────────────────────────────────────
  const HEDGE_LEVELS = {
    1: {
      where: 'Over-claimed — reviewers will reject',
      text: '"Our results prove that edge density universally controls tumor invasion across all cancer types."',
      meta: 'Papers do not "prove" things. "Universally" generalizes beyond any tested condition. Reviewers will flag this immediately as over-claim.',
    },
    2: {
      where: 'Still too strong',
      text: '"These results definitively establish edge density as the dominant variable in invasion."',
      meta: '"Definitively" + "dominant" claim more than your data show. Replace with "demonstrate," drop "dominant."',
    },
    3: {
      where: 'Strong, defensible',
      text: '"Our results demonstrate that edge density inverts the effect of stiffness on invasion in patient-derived spheroids."',
      meta: 'Bold claim, scope-bounded by "in patient-derived spheroids." A reviewer might push on it but cannot reject it as over-claim. Lab\'s target.',
    },
    4: {
      where: 'Strong with humility — the sweet spot',
      text: '"Our results demonstrate that edge density inverts the effect of stiffness on invasion in patient-derived spheroids, and argue for a primarily mechanical mechanism — though we cannot rule out signaling contributions."',
      meta: 'Strong central claim + an honest acknowledgment of what you cannot resolve. This is what reviewers want to see. Lab\'s target zone.',
    },
    5: {
      where: 'Cautious, still publishable',
      text: '"Our results are consistent with edge density inverting the effect of stiffness on invasion, suggesting a possible mechanical mechanism."',
      meta: '"Consistent with" + "suggesting" + "possible" stacks three hedges. Acceptable but reads tentative. Pick one hedge, lose the others.',
    },
    6: {
      where: 'Over-hedged — paper sounds unconfident',
      text: '"Our results may potentially suggest that edge density could possibly modulate the effect of stiffness on invasion under some conditions."',
      meta: '"May potentially," "could possibly," "under some conditions" — three layers of hedge erase the claim. Reviewer reaction: "what are you actually showing?" Re-write more directly.',
    },
    7: {
      where: 'Cowardly — reviewers will reject',
      text: '"More work is needed to determine whether edge density might be related to invasion outcomes."',
      meta: '"More work is needed" + "might be related" leaves nothing. This reads as if the paper has no findings. Make the claim or don\'t publish.',
    },
  };

  function wireHedgeMeter() {
    const slider = document.getElementById('hedge-slider');
    const out = document.getElementById('hedge-out');
    const where = document.getElementById('hedge-where');
    const text = document.getElementById('hedge-text');
    const meta = document.getElementById('hedge-meta');
    if (!slider) return;
    function refresh() {
      const v = parseInt(slider.value, 10);
      const entry = HEDGE_LEVELS[v] || HEDGE_LEVELS[4];
      out.textContent = v;
      where.textContent = '— ' + entry.where + ' —';
      text.textContent = entry.text;
      meta.textContent = entry.meta;
    }
    slider.addEventListener('input', refresh);
    refresh();
  }

  // ── Four-jobs checklist ───────────────────────────────────────────
  function wireChecklist() {
    const cl = document.getElementById('disc-checklist');
    if (!cl) return;
    const checkboxes = cl.querySelectorAll('input[type="checkbox"]');
    const progress = document.getElementById('disc-progress');
    const bar = document.getElementById('disc-bar');
    const fill = bar.querySelector('div');
    const total = checkboxes.length;
    function refresh() {
      let checked = 0;
      checkboxes.forEach(box => {
        const lab = box.closest('label');
        if (lab) lab.classList.toggle('is-checked', box.checked);
        if (box.checked) checked++;
      });
      const pct = total ? (checked / total) * 100 : 0;
      fill.style.width = pct.toFixed(0) + '%';
      const done = (checked === total);
      bar.classList.toggle('is-done', done);
      progress.classList.toggle('is-done', done);
      progress.textContent = done
        ? '✅ All four jobs covered — your Discussion will read as deliberate, not as filler.'
        : checked + ' of ' + total + ' covered';
    }
    checkboxes.forEach(box => box.addEventListener('change', refresh));
    refresh();
  }

  function init() {
    wireToc();
    wireHedgeMeter();
    wireChecklist();
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) {
      firebridge.whenAuthResolved().then(init).catch(init);
    } else {
      init();
    }
  });
})();

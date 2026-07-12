/* training-paper-writing.js — V3.163 lecture-style module.
 *
 * Lighter than the interactive notebooks (V3.164+) — no canvases. Three
 * small interactive widgets:
 *   - TOC scroll-spy: highlights the active section in the sticky TOC as
 *     the user scrolls
 *   - Compare toggle: switches the "Good vs Mediocre Introduction" panes
 *   - Citation quiz: 5 yes/no claims with explanations + running score
 *   - Submission checklist: 15 checkboxes with progress counter + bar
 *
 * Auth gate via firebridge.whenAuthResolved. State is component-local
 * and not persisted.
 */
(function () {
  'use strict';

  // ── TOC scroll-spy ────────────────────────────────────────────────

  function wireToc() {
    const links = Array.from(document.querySelectorAll('.training-toc a'));
    if (!links.length) return;
    const sections = links
      .map(a => {
        const id = (a.getAttribute('href') || '').replace(/^#/, '');
        return id ? document.getElementById(id) : null;
      })
      .filter(Boolean);

    // Smooth scroll already works via the anchor href; no special handler
    // needed beyond honoring the default behavior. We just need to keep
    // the active class in sync as the user scrolls.

    function findActiveSection() {
      // The section whose top is highest above ~120px from viewport top
      // is "active." Iterate top-down and pick the last one whose top has
      // crossed the threshold.
      const offset = 140;
      let active = sections[0];
      for (const s of sections) {
        const r = s.getBoundingClientRect();
        if (r.top - offset <= 0) active = s;
        else break;
      }
      return active;
    }

    function syncActive() {
      const a = findActiveSection();
      const aId = a ? a.id : null;
      links.forEach(link => {
        const linkId = (link.getAttribute('href') || '').replace(/^#/, '');
        link.classList.toggle('active', linkId === aId);
      });
    }

    let scheduled = false;
    function onScroll() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        syncActive();
      });
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    syncActive();
  }

  // ── Compare toggle (good vs mediocre) ─────────────────────────────

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

  // ── Citation quiz ─────────────────────────────────────────────────

  function wireCiteQuiz() {
    const quiz = document.getElementById('cite-quiz');
    if (!quiz) return;
    const items = quiz.querySelectorAll('.cite-quiz-item');
    const score = document.getElementById('cite-quiz-score');
    let correct = 0;
    let answered = 0;

    items.forEach(item => {
      const truth = item.dataset.correct;
      const buttons = item.querySelectorAll('button');
      const explain = item.querySelector('.explain');
      buttons.forEach(btn => {
        btn.addEventListener('click', () => {
          // Idempotent — clicking the same answer again is a no-op
          if (item.classList.contains('answered') && btn.classList.contains('picked')) return;

          // Reset any previous pick on this item (lets the student re-try)
          buttons.forEach(b => b.classList.remove('picked', 'correct', 'wrong'));
          item.classList.remove('answered');

          const pick = btn.dataset.answer;
          const right = (pick === truth);
          btn.classList.add('picked');
          btn.classList.add(right ? 'correct' : 'wrong');
          item.classList.add('answered');
          explain.classList.add('shown');
          // Recompute score across all answered items
          correct = 0;
          answered = 0;
          items.forEach(it => {
            const picked = it.querySelector('button.picked');
            if (picked) {
              answered++;
              if (picked.classList.contains('correct')) correct++;
            }
          });
          if (answered === items.length) {
            const pct = Math.round((correct / answered) * 100);
            score.textContent = correct + ' / ' + items.length + ' correct (' + pct + '%)' +
              (pct === 100 ? ' — citation-calibrated.' : pct >= 60 ? ' — most of the way there; re-read the explanations on the misses.' : ' — worth re-reading section 4 and trying again.');
          } else {
            score.textContent = answered + ' / ' + items.length + ' answered · ' + correct + ' correct so far';
          }
        });
      });
    });
  }

  // ── Submission checklist ──────────────────────────────────────────

  function wireSubmitChecklist() {
    const cl = document.getElementById('submit-checklist');
    if (!cl) return;
    const checkboxes = cl.querySelectorAll('input[type="checkbox"]');
    const progress   = document.getElementById('submit-progress');
    const bar        = document.getElementById('submit-bar');
    const barFill    = bar.querySelector('div');
    const total      = checkboxes.length;

    function refresh() {
      let checked = 0;
      checkboxes.forEach(box => {
        const lab = box.closest('label');
        if (lab) lab.classList.toggle('is-checked', box.checked);
        if (box.checked) checked++;
      });
      const pct = total ? (checked / total) * 100 : 0;
      barFill.style.width = pct.toFixed(0) + '%';
      const done = (checked === total);
      bar.classList.toggle('is-done', done);
      progress.classList.toggle('is-done', done);
      progress.textContent = done
        ? '✅ All ' + total + ' items ready — message Alex with the manuscript link.'
        : checked + ' of ' + total + ' ready';
    }

    checkboxes.forEach(box => box.addEventListener('change', refresh));
    refresh();
  }

  // ── Init ──────────────────────────────────────────────────────────

  function init() {
    wireToc();
    wireComparators();
    wireCiteQuiz();
    wireSubmitChecklist();
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) {
      firebridge.whenAuthResolved().then(init).catch(init);
    } else {
      init();
    }
  });
})();

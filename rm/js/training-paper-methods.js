/* training-paper-methods.js — V3.184.
 *
 * Lecture page on writing the Methods section.
 * Two interactive widgets:
 *   - Methods-vs-Intro compare-bar (shared widget from V3.163)
 *   - Methods completeness checker (12-item checklist; same shape as
 *     V3.163 submission checklist)
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

  function wireChecklist() {
    const cl = document.getElementById('methods-checklist');
    if (!cl) return;
    const checkboxes = cl.querySelectorAll('input[type="checkbox"]');
    const progress = document.getElementById('methods-progress');
    const bar = document.getElementById('methods-bar');
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
        ? '✅ Methods complete — a stranger could reproduce your experiment.'
        : checked + ' of ' + total + ' covered';
    }
    checkboxes.forEach(box => box.addEventListener('change', refresh));
    refresh();
  }

  function init() {
    wireToc();
    wireComparators();
    wireChecklist();
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (typeof firebridge !== 'undefined' && firebridge.requireSignIn) {
      firebridge.requireSignIn('Sign in to track your training progress.').then(init).catch(init);
    } else {
      init();
    }
  });
})();

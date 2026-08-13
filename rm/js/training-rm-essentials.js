/* training-rm-essentials.js — V3.177 RM power-user orientation.
 *
 * Lecture-style page focused on the workflow paradigm + power-user
 * moves (not "what RM is" setup content — see saved feedback memory
 * `feedback_rm_trainings_power_user.md`).
 *
 * Three interactive widgets:
 *   - Nav-map grid: click a group, see its child pages with one-line
 *     descriptions (for when workflows aren't enough)
 *   - Power-user quiz: 6 questions that separate new users from power
 *     users (brand-dropdown vs home-page navigation, cross-page
 *     integration vs manual re-entry, multi-pick citation vs typing,
 *     etc.)
 *   - Power-user toolkit checklist: 12-item self-assessment of the
 *     habits that mark a power user.
 *
 * Plus the standard TOC scroll-spy.
 */
(function () {
  'use strict';

  // ── Nav-map data ──────────────────────────────────────────────────
  // One-line descriptions of every page a non-admin would see. Mirrors
  // nav.js NAV_ITEMS but with prose descriptions. If nav.js changes,
  // keep this in sync (rare — pages don't move often).

  const NAV_MAP = {
    activity: {
      label: 'Activity', icon: '📈',
      desc: 'Where you log and review your day-to-day research output.',
      pages: [
        { href: '/rm/pages/activity-overview.html', name: 'Overview', desc: 'Roll-up of recent activity across the lab.' },
        { href: '/rm/pages/activity-overview.html?tab=tracker', name: 'Tracker', desc: 'Daily entries with pending-confirmation banner.' },
        { href: '/rm/pages/activity-overview.html?tab=email', name: 'Email', desc: 'Gmail triage + action-item extraction (admin-gated currently).' },
        { href: '/rm/pages/activity-overview.html?tab=timeline', name: 'Year', desc: 'Year-view timeline of your activity.' },
        { href: '/rm/pages/pmr.html', name: 'PMR', desc: 'Periodic Meeting Record — the 1:1 surface with Alex.' },
        { href: '/rm/pages/calendar.html', name: 'Calendar', desc: 'Lab-wide calendar (admin-gated currently).' },
        { href: '/rm/pages/tasks.html', name: 'Tasks', desc: 'Bucket + subtask model + Inbox tab for assigned tasks.' },
        { href: '/rm/pages/sharing.html', name: 'Sharing', desc: 'Where you assign things to other lab members.' },
        { href: '/rm/pages/explorer.html', name: 'Explorer', desc: 'Cross-collection data browser.' },
      ],
    },
    research: {
      label: 'Research', icon: '🔬',
      desc: 'The pages you use while doing science — papers, projects, notebook, protocols.',
      pages: [
        { href: '/rm/pages/projects.html', name: 'Projects', desc: 'The lab\'s research projects, status pills, leads.' },
        { href: '/rm/pages/library.html', name: 'Library', desc: 'Paper reading + annotation + threaded comments.' },
        { href: '/rm/pages/library.html?tab=comments', name: 'Library Comments', desc: 'All comments across all papers.' },
        { href: '/rm/pages/lab-notebook.html', name: 'Lab Notebook', desc: 'Daily entries with image attachments + PMR figure-flagging.' },
        { href: '/rm/pages/protocols.html', name: 'Protocols', desc: 'Live protocols with formula-block calculators.' },
        { href: '/rm/pages/paper-builder.html', name: 'Papers', desc: 'Real-time collaborative paper editor with citation drop.' },
        { href: '/rm/pages/teaching.html', name: 'Teaching', desc: 'Courses + lab classes you\'re leading.' },
        { href: '/rm/pages/service.html', name: 'Service', desc: 'Departmental + community service activities.' },
      ],
    },
    training: {
      label: 'Training', icon: '🎓',
      desc: 'This library. Lab-internal learning material — the page you\'re reading right now lives here.',
      pages: [
        { href: '/rm/pages/training.html', name: 'Overview', desc: 'The training landing grid you came from.' },
        { href: '/rm/pages/training-phd-triangle.html', name: 'The PhD triangle', desc: 'Three pillars of a good PhD.' },
        { href: '/rm/pages/training-scientific-communication.html', name: 'Scientific communication', desc: 'Storytelling for posters and talks.' },
        { href: '/rm/pages/training-paper-writing.html', name: 'Writing a scientific paper', desc: 'IMRaD anatomy, citation discipline, revisions.' },
        { href: '/rm/pages/training-microscope-basics.html', name: 'Microscope basics', desc: 'Required before first AX-R session.' },
        { href: '/rm/pages/training-confocal.html', name: 'Confocal (AX-R)', desc: 'Pinhole, scan modes, lasers, Z-stacks.' },
      ],
    },
    operations: {
      label: 'Operations', icon: '🗓️',
      desc: 'Coordination surfaces — meetings, chat, scheduling, equipment.',
      pages: [
        { href: '/rm/pages/chat.html', name: 'Chat', desc: 'Async lab-internal messaging.' },
        { href: '/rm/pages/huddle.html', name: 'Huddle', desc: 'Quick real-time stand-ups.' },
        { href: '/rm/pages/meetings.html', name: 'Meetings', desc: 'Whole-lab meetings + action items.' },
        { href: '/rm/pages/scheduler.html', name: 'Scheduler', desc: 'Recurring task / event scheduling.' },
        { href: '/rm/pages/equipment.html', name: 'Equipment', desc: 'Microscope / hood / shared-equipment booking.' },
      ],
    },
    admin: {
      label: 'Lab Admin', icon: '📋',
      desc: 'Admin-gated surfaces — mostly Alex + senior members. Visible only if your role allows.',
      pages: [
        { href: '/rm/pages/compliance.html', name: 'Compliance', desc: 'IRB / IACUC / student-training submissions.' },
        { href: '/rm/pages/chemicals.html', name: 'Chemical Safety', desc: 'SDS sheets + hazard tracking.' },
        { href: '/rm/pages/inventory.html', name: 'Inventory', desc: 'Reagent + supply + equipment inventory.' },
        { href: '/rm/pages/people.html', name: 'Lab Members', desc: 'Current + past lab members.' },
        { href: '/rm/pages/career.html', name: 'Career & Tenure', desc: 'Promotion / tenure milestones.' },
        { href: '/rm/pages/procurement.html', name: 'Procurement', desc: 'Purchase orders + reagent ordering.' },
        { href: '/rm/pages/receipts.html', name: 'Receipts & Budget', desc: 'Receipt ingestion + budget tracking.' },
        { href: '/rm/pages/projects-grants.html', name: 'Grant Accounts', desc: 'Grant-account assignments.' },
        { href: '/rm/pages/analytics.html', name: 'Analytics', desc: 'Lab-wide stats dashboard.' },
        { href: '/rm/pages/finance.html', name: 'Travel', desc: 'Conference travel reimbursement flow.' },
      ],
    },
    settings: {
      label: 'Settings', icon: '⚙️',
      desc: 'Your profile, your preferences, and your CV.',
      pages: [
        { href: '/rm/pages/profile.html', name: 'Profile', desc: 'Display name, photo, pronouns, shareActivity flag.' },
        { href: '/rm/pages/settings.html', name: 'Settings', desc: 'UI preferences.' },
        { href: '/rm/pages/cv-editor.html', name: 'CV Editor', desc: 'Personal CV editor (synced to cv-builder.js).' },
        { href: '/rm/pages/cv-editor.html?tab=lab', name: 'CV Overview', desc: 'Aggregated lab-wide CV overview.' },
      ],
    },
  };

  let activeNavGroup = 'activity';

  function renderNavGrid() {
    const grid = document.getElementById('nav-map-grid');
    if (!grid) return;
    grid.innerHTML = '';
    Object.keys(NAV_MAP).forEach(key => {
      const g = NAV_MAP[key];
      const card = document.createElement('div');
      card.className = 'nav-map-card' + (key === activeNavGroup ? ' is-active' : '');
      card.dataset.group = key;
      card.innerHTML =
        '<div class="icon">' + g.icon + '</div>' +
        '<div class="name">' + escapeHtml(g.label) + '</div>' +
        '<div class="count">' + g.pages.length + ' page' + (g.pages.length === 1 ? '' : 's') + '</div>';
      card.addEventListener('click', () => {
        activeNavGroup = key;
        renderNavGrid();
        renderNavDetail();
      });
      grid.appendChild(card);
    });
  }

  function renderNavDetail() {
    const detail = document.getElementById('nav-map-detail');
    if (!detail) return;
    const g = NAV_MAP[activeNavGroup];
    if (!g) { detail.innerHTML = '<h3>Loading…</h3>'; return; }
    let html = '<h3>' + g.icon + '&nbsp; ' + escapeHtml(g.label) + '</h3>';
    html += '<p style="font-size:13px;color:var(--text-muted);margin-bottom:10px;">' + escapeHtml(g.desc) + '</p>';
    html += '<ul>';
    g.pages.forEach(p => {
      html += '<li><a href="' + p.href + '">' + escapeHtml(p.name) + '</a><span class="desc">' + escapeHtml(p.desc) + '</span></li>';
    });
    html += '</ul>';
    detail.innerHTML = html;
  }

  // ── "Where do I go?" quiz ─────────────────────────────────────────
  // Re-pickable. Score recomputes on every click.

  function wireQuiz() {
    const quiz = document.getElementById('rm-quiz');
    if (!quiz) return;
    const items = quiz.querySelectorAll('.rm-quiz-item');
    const scoreEl = document.getElementById('rm-quiz-score');

    items.forEach(item => {
      const truth = item.dataset.correct;
      const choices = item.querySelectorAll('.choices button');
      const explain = item.querySelector('.explain');
      choices.forEach(btn => {
        btn.addEventListener('click', () => {
          // Reset prior pick on this item
          choices.forEach(b => b.classList.remove('picked', 'correct', 'wrong'));
          const pick = btn.dataset.choice;
          const ok = (pick === truth);
          btn.classList.add('picked', ok ? 'correct' : 'wrong');
          explain.classList.add('shown');
          recomputeScore();
        });
      });
    });

    function recomputeScore() {
      let answered = 0, correct = 0;
      items.forEach(it => {
        const picked = it.querySelector('.choices button.picked');
        if (picked) {
          answered++;
          if (picked.classList.contains('correct')) correct++;
        }
      });
      if (answered === 0) {
        scoreEl.textContent = 'Pick an answer on each item to see how power-user-fluent you are.';
      } else if (answered < items.length) {
        scoreEl.textContent = answered + ' / ' + items.length + ' answered · ' + correct + ' correct so far';
      } else {
        const pct = Math.round((correct / answered) * 100);
        scoreEl.textContent = correct + ' / ' + items.length + ' correct (' + pct + '%)' +
          (pct === 100 ? ' — you operate RM the way it was designed to be operated.' : pct >= 60 ? ' — most of the way there; re-read the explanations on the misses.' : ' — worth re-scanning Sections 3 (strip), 5 (cross-page integration), and 8 (shortcuts) and re-trying.');
      }
    }
  }

  // ── First-week checklist (same pattern as V3.163) ─────────────────

  function wireChecklist() {
    const cl = document.getElementById('rm-checklist');
    if (!cl) return;
    const checkboxes = cl.querySelectorAll('input[type="checkbox"]');
    const progress   = document.getElementById('rm-checklist-progress');
    const bar        = document.getElementById('rm-checklist-bar');
    const fill       = bar.querySelector('div');
    const total      = checkboxes.length;

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
        ? '✅ Power-user toolkit adopted — start V3.178 (daily research workflow) next.'
        : checked + ' of ' + total + ' adopted';
    }
    checkboxes.forEach(box => box.addEventListener('change', refresh));
    refresh();
  }

  // ── TOC scroll-spy (same as V3.163 / V3.176) ──────────────────────

  function wireToc() {
    const links = Array.from(document.querySelectorAll('.training-toc a'));
    if (!links.length) return;
    const sections = links
      .map(a => {
        const id = (a.getAttribute('href') || '').replace(/^#/, '');
        return id ? document.getElementById(id) : null;
      })
      .filter(Boolean);
    function findActive() {
      const offset = 140;
      let active = sections[0];
      for (const s of sections) {
        const r = s.getBoundingClientRect();
        if (r.top - offset <= 0) active = s;
        else break;
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

  function init() {
    wireToc();
    renderNavGrid();
    renderNavDetail();
    wireQuiz();
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

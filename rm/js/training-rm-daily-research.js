/* training-rm-daily-research.js — V3.178 Daily Research Workflow in RM.
 *
 * Three interactive widgets:
 *   - Lab Research workflow flowchart: click nodes to read each page's role
 *   - Tracker entry confirmer: simulated pending banner; confirm or dismiss
 *     three entries and watch a mock PMR Activity summary fill in
 *   - Lab-notebook entry simulator: 📌 toggle on a sample image previews the
 *     V3.161 figure-review card that would land in PMR
 *
 * Plus the standard pattern from V3.177: TOC scroll-spy, picker-style quiz,
 * checklist-with-progress.
 */
(function () {
  'use strict';

  // ── 1. Lab Research workflow flowchart ──────────────────────────────
  // Each node is a page in the default Lab Research workflow strip,
  // with a one-line role + the downstream signals it produces.

  const FLOW_NODES = [
    {
      slug: 'tracker',
      icon: '📈',
      name: 'Activity Tracker',
      role: 'Daily ledger',
      what: 'The single ledger of research time. Most entries arrive here automatically as pending — your job is to confirm hours, not to dictate the whole entry.',
      feeds: 'Confirmed entries feed the <strong>PMR Activity</strong> block and the <strong>Stats</strong> bar chart at week\'s end.',
    },
    {
      slug: 'library',
      icon: '📚',
      name: 'Library',
      role: 'Read + annotate papers',
      what: 'Ingest PDFs (extension grab, drop, or auto-download). Highlight, comment, scope annotations to a review task. Citations here are the source for Cmd+K in the paper builder.',
      feeds: 'Highlighted text + comments surface in the <strong>paper builder</strong> when you cite the paper, and in <strong>review-task overlays</strong> scoped to a specific lit review.',
    },
    {
      slug: 'projects',
      icon: '📂',
      name: 'Projects',
      role: 'Where you sit on the lab map',
      what: 'The lab\'s research projects with status pills + leads. Your project assignment drives which projects the notebook entry picker shows.',
      feeds: 'Project assignment gates the <strong>notebook project picker</strong> and the <strong>PMR project overview</strong> rollup.',
    },
    {
      slug: 'tasks',
      icon: '✅',
      name: 'Tasks',
      role: 'Bucket + subtask checklist',
      what: 'Bucket + subtask hierarchy. The Inbox tab shows tasks others assigned you (red badge for unseen). Subtask due_dates surface in the tracker Coming-up lane.',
      feeds: '<strong>Tracker Coming-up lane</strong> (subtask due_date), <strong>PMR Open tasks</strong> block (all assignee subtasks).',
    },
    {
      slug: 'notebook',
      icon: '📓',
      name: 'Lab Notebook',
      role: 'The bench record',
      what: 'Per-experiment entries with body text, attachments, reagent + protocol references, observations. Phase pill (plan / running / complete) controls run-mode UI.',
      feeds: '<strong>Tracker pending entry</strong> on save (category research › experiments). <strong>PMR Figure Reviews</strong> for any image you click 📌 on.',
    },
    {
      slug: 'protocols',
      icon: '📋',
      name: 'Protocols',
      role: 'Reusable procedures + live calculators',
      what: 'Y.Doc collaborative protocols with sections, steps, materials, figures, and formula blocks. Formula variables render as live chips in step text — and propagate into notebook entries via 🧮 calc.',
      feeds: '<strong>Tracker pending entry</strong> on save (category research › writing › protocols). <strong>Notebook 🧮 calc</strong> for live computed inserts.',
    },
  ];

  let activeFlowSlug = FLOW_NODES[0].slug;

  function renderFlow() {
    const grid = document.getElementById('daily-flow-grid');
    if (!grid) return;
    grid.innerHTML = '';
    FLOW_NODES.forEach(n => {
      const card = document.createElement('div');
      card.className = 'daily-flow-node' + (n.slug === activeFlowSlug ? ' is-active' : '');
      card.dataset.slug = n.slug;
      card.innerHTML =
        '<div class="icon">' + escapeHtml(n.icon) + '</div>' +
        '<div class="name">' + escapeHtml(n.name) + '</div>' +
        '<div class="role">' + escapeHtml(n.role) + '</div>';
      card.addEventListener('click', () => {
        activeFlowSlug = n.slug;
        renderFlow();
        renderFlowDetail();
      });
      grid.appendChild(card);
    });
  }

  function renderFlowDetail() {
    const detail = document.getElementById('daily-flow-detail');
    if (!detail) return;
    const n = FLOW_NODES.find(x => x.slug === activeFlowSlug) || FLOW_NODES[0];
    detail.innerHTML =
      '<h4>' + escapeHtml(n.icon) + '&nbsp; ' + escapeHtml(n.name) + ' — ' + escapeHtml(n.role) + '</h4>' +
      '<p>' + escapeHtml(n.what) + '</p>' +
      '<div class="feeds"><strong>Feeds →</strong> ' + n.feeds + '</div>';
  }

  // ── 2. Tracker entry confirmer ──────────────────────────────────────
  // Mock pending entries that mirror the real banner's shape: source pill,
  // text, prefilled hours, ✓ / ✗ buttons. Confirming or dismissing updates
  // a mock "PMR Activity" summary so the cause-and-effect is visible.

  const PENDING_ENTRIES = [
    {
      id: 'p1',
      source: 'rm-notebook',
      text: 'Lab notebook: GELS hydrogel Day 7 — fluorescence imaging',
      prefill: 2.0,
      category: 'research › experiments',
    },
    {
      id: 'p2',
      source: 'rm-protocol',
      text: 'Protocol: GELS staining v3 (updated formula)',
      prefill: 0.5,
      category: 'research › writing › protocols',
    },
    {
      id: 'p3',
      source: 'rm-task',
      text: 'Subtask: Plot Fig 3 panel from batch-11 data',
      prefill: 1.5,
      category: 'research › analysis',
    },
  ];

  const trackerState = {
    // id → { status: 'pending' | 'confirmed' | 'dismissed', hours: number | null }
    rows: Object.fromEntries(PENDING_ENTRIES.map(e => [e.id, { status: 'pending', hours: e.prefill }])),
  };

  function renderTrackerSim() {
    const wrap = document.getElementById('tracker-sim');
    if (!wrap) return;
    // Keep head + populate rows beneath it.
    const head = wrap.querySelector('.tracker-sim-head');
    wrap.innerHTML = '';
    if (head) wrap.appendChild(head);
    PENDING_ENTRIES.forEach(e => {
      const st = trackerState.rows[e.id];
      const row = document.createElement('div');
      row.className = 'tracker-sim-row' + (st.status !== 'pending' ? ' is-resolved' : '');

      const src = document.createElement('span');
      src.className = 'tracker-sim-source';
      src.textContent = e.source.replace(/^rm-/, '');
      row.appendChild(src);

      const txt = document.createElement('span');
      txt.className = 'tracker-sim-text';
      txt.textContent = e.text;
      row.appendChild(txt);

      const hrs = document.createElement('input');
      hrs.type = 'number';
      hrs.step = '0.25';
      hrs.min = '0';
      hrs.className = 'tracker-sim-hours';
      hrs.value = String(st.hours);
      hrs.disabled = st.status !== 'pending';
      hrs.addEventListener('change', () => {
        const v = parseFloat(hrs.value);
        if (isFinite(v) && v >= 0) trackerState.rows[e.id].hours = v;
      });
      row.appendChild(hrs);

      const ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'tracker-sim-btn ok';
      ok.textContent = '✓';
      ok.title = 'Confirm';
      ok.disabled = st.status !== 'pending';
      ok.addEventListener('click', () => {
        const v = parseFloat(hrs.value);
        if (!isFinite(v) || v <= 0) { hrs.focus(); return; }
        trackerState.rows[e.id].status = 'confirmed';
        trackerState.rows[e.id].hours = v;
        renderTrackerSim();
        renderTrackerResult();
      });
      row.appendChild(ok);

      const skip = document.createElement('button');
      skip.type = 'button';
      skip.className = 'tracker-sim-btn skip';
      skip.textContent = '✗';
      skip.title = 'Dismiss';
      skip.disabled = st.status !== 'pending';
      skip.addEventListener('click', () => {
        trackerState.rows[e.id].status = 'dismissed';
        renderTrackerSim();
        renderTrackerResult();
      });
      row.appendChild(skip);

      wrap.appendChild(row);
    });
  }

  function renderTrackerResult() {
    const out = document.getElementById('tracker-sim-result');
    if (!out) return;
    const confirmed = PENDING_ENTRIES
      .map(e => ({ e, st: trackerState.rows[e.id] }))
      .filter(x => x.st.status === 'confirmed');
    const dismissed = PENDING_ENTRIES
      .map(e => ({ e, st: trackerState.rows[e.id] }))
      .filter(x => x.st.status === 'dismissed');
    const remaining = PENDING_ENTRIES.length - confirmed.length - dismissed.length;
    if (confirmed.length === 0 && dismissed.length === 0) {
      out.className = 'tracker-sim-result empty';
      out.textContent = 'Confirm or dismiss entries above. The PMR Activity block updates as you go.';
      return;
    }
    out.className = 'tracker-sim-result';
    const totalHours = confirmed.reduce((s, x) => s + x.st.hours, 0);
    // Mock PMR Activity grouping by top-level category.
    const byCat = {};
    confirmed.forEach(x => {
      const cat = x.e.category.split(' › ')[0];
      byCat[cat] = (byCat[cat] || 0) + x.st.hours;
    });
    const catLines = Object.keys(byCat).sort().map(cat =>
      '<div style="display:flex;justify-content:space-between;gap:10px;">' +
      '<span style="text-transform:capitalize">' + escapeHtml(cat) + '</span>' +
      '<span style="font-variant-numeric:tabular-nums">' + byCat[cat].toFixed(1) + 'h</span>' +
      '</div>'
    ).join('');
    out.innerHTML =
      '<strong>📊 Mock PMR Activity (this week so far):</strong>' +
      '<div style="margin-top:6px">' + catLines + '</div>' +
      '<div style="margin-top:8px;padding-top:6px;border-top:1px solid #a7f3d0;display:flex;justify-content:space-between;font-weight:600">' +
      '<span>Confirmed total</span><span>' + totalHours.toFixed(1) + 'h</span></div>' +
      '<div style="margin-top:4px;font-size:11px;color:#065f46">' +
      confirmed.length + ' confirmed · ' + dismissed.length + ' dismissed · ' +
      remaining + ' pending' +
      '</div>';
  }

  // ── 3. Notebook entry simulator ─────────────────────────────────────
  // Title + date + image with a 📌 PMR badge. Click to flag/unflag and
  // see a preview of the figure-review card that would appear in PMR.

  const nbState = { flagged: false };

  function wireNotebookSim() {
    const titleEl = document.getElementById('nb-sim-title');
    const dateEl = document.getElementById('nb-sim-date');
    const flagBtn = document.getElementById('nb-sim-flag');
    const figureEl = document.getElementById('nb-sim-figure');
    const previewEl = document.getElementById('nb-sim-pmr-preview');
    const previewTitleEl = document.getElementById('nb-sim-pmr-title');
    const previewLinkEl = document.getElementById('nb-sim-pmr-link');
    if (!titleEl || !flagBtn || !figureEl || !previewEl) return;

    // Default date = today.
    if (dateEl) dateEl.value = new Date().toISOString().slice(0, 10);

    function syncPreview() {
      previewEl.classList.toggle('is-visible', nbState.flagged);
      figureEl.classList.toggle('is-flagged', nbState.flagged);
      flagBtn.title = nbState.flagged
        ? 'Flagged for next PMR — click to unflag'
        : 'Flag for next PMR';
      if (previewTitleEl) previewTitleEl.textContent = titleEl.value || '(untitled entry)';
      if (previewLinkEl) {
        const t = (titleEl.value || 'this notebook entry').slice(0, 60);
        const d = (dateEl && dateEl.value) || '';
        previewLinkEl.textContent = t + (d ? ' (' + d + ')' : '');
      }
    }

    flagBtn.addEventListener('click', () => {
      nbState.flagged = !nbState.flagged;
      syncPreview();
    });
    titleEl.addEventListener('input', syncPreview);
    if (dateEl) dateEl.addEventListener('input', syncPreview);

    syncPreview();
  }

  // ── 4. Quiz (pick-one with explanation) ─────────────────────────────

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
          choices.forEach(b => b.classList.remove('picked', 'correct', 'wrong'));
          const ok = (btn.dataset.choice === truth);
          btn.classList.add('picked', ok ? 'correct' : 'wrong');
          if (explain) explain.classList.add('shown');
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
      if (!scoreEl) return;
      if (answered === 0) {
        scoreEl.textContent = 'Pick an answer on each item to see how fluent you are in the daily flow.';
      } else if (answered < items.length) {
        scoreEl.textContent = answered + ' / ' + items.length + ' answered · ' + correct + ' correct so far';
      } else {
        const pct = Math.round((correct / answered) * 100);
        scoreEl.textContent = correct + ' / ' + items.length + ' correct (' + pct + '%)' +
          (pct === 100 ? ' — you have the daily flow internalized.'
          : pct >= 60 ? ' — most of the way there; re-read the explanations on the misses.'
          : ' — worth re-scanning Sections 2 (tracker), 3 (notebook), and 6 (cross-page integration).');
      }
    }
  }

  // ── 5. Checklist with progress bar ──────────────────────────────────

  function wireChecklist() {
    const cl = document.getElementById('daily-checklist');
    if (!cl) return;
    const checkboxes = cl.querySelectorAll('input[type="checkbox"]');
    const progress   = document.getElementById('daily-checklist-progress');
    const bar        = document.getElementById('daily-checklist-bar');
    if (!progress || !bar) return;
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
      if (fill) fill.style.width = pct.toFixed(0) + '%';
      const done = (checked === total);
      bar.classList.toggle('is-done', done);
      progress.classList.toggle('is-done', done);
      progress.textContent = done
        ? '✅ Daily-rhythm adopted — start V3.179 (Tasks & PMR) next.'
        : checked + ' of ' + total + ' adopted';
    }
    checkboxes.forEach(box => box.addEventListener('change', refresh));
    refresh();
  }

  // ── 6. TOC scroll-spy ───────────────────────────────────────────────

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
    renderFlow();
    renderFlowDetail();
    renderTrackerSim();
    renderTrackerResult();
    wireNotebookSim();
    wireQuiz();
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

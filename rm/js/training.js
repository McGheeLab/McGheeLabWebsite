/* training.js — landing page for the RM Lab Training section.
 *
 * Renders a categorized grid of training modules. Each entry maps to a
 * page in rm/pages/training-*.html. Cards marked `available:false`
 * render dimmed + non-clickable so the list always reflects the full
 * curriculum even before the future modules ship.
 *
 * Curriculum is grouped into four categories (V3.162.2):
 *   foundations  — soft-skills + the PhD journey
 *   microscopy   — instrument fundamentals + scope operation
 *   analysis     — image-analysis concepts (basic / intermediate / advanced)
 *   tools        — specific software trainings (Fiji + lab Python apps)
 *
 * Auth: firebridge.isLabMember() — guests get the pending-access
 * overlay from firebase-bridge.js (handled globally; no per-page
 * gate needed here).
 *
 * Introduced V3.162; categorized + 5 lab-software entries added V3.162.2.
 */
(function () {
  'use strict';

  const CATEGORIES = [
    { key: 'foundations', label: 'Foundations',                  blurb: 'How we work and what we expect.' },
    { key: 'rm-hub',      label: 'Using RM',                     blurb: 'How to operate the lab\'s research-management hub itself.' },
    { key: 'microscopy',  label: 'Microscopy',                   blurb: 'From fundamentals to operating the lab\'s scopes.' },
    { key: 'analysis',    label: 'Image analysis — concepts',    blurb: 'The ideas behind processing biological images.' },
    { key: 'tools',       label: 'Image analysis — software',    blurb: 'Specific software, both open-source and lab-built.' },
  ];

  const MODULES = [
    // ── Foundations ──────────────────────────────────────────────
    {
      category: 'foundations',
      slug: 'paper-writing',
      icon: '📝',
      title: 'Paper writing — overview',
      desc: 'From blank page to submitted manuscript — IMRaD anatomy, figure-first drafting, citation discipline, revision letters. Gateway to the V3.182–V3.187 paper-writing series.',
      available: true,
      planVersion: 'V3.163',
    },
    {
      category: 'foundations',
      slug: 'paper-paragraphs',
      icon: '🧱',
      title: 'Paper writing — paragraphs, voice & scope',
      desc: 'Sentence-level craft. The paragraph skeleton, the four scientific voices (Reporter / Storyteller / Advocate / Technician), and narrative scope. Foundation for the section-specific trainings.',
      available: true,
      planVersion: 'V3.182',
    },
    {
      category: 'foundations',
      slug: 'paper-introduction',
      icon: '🔻',
      title: 'Paper writing — the Introduction',
      desc: 'The 3-paragraph funnel from broad context → gap → claim. How to write the section reviewers judge a paper by.',
      available: true,
      planVersion: 'V3.183',
    },
    {
      category: 'foundations',
      slug: 'paper-methods',
      icon: '🧰',
      title: 'Paper writing — the Methods',
      desc: 'Recipe, not storytelling. What belongs in Methods vs Supplementary; catalog numbers, software versions, Technician voice.',
      available: true,
      planVersion: 'V3.184',
    },
    {
      category: 'foundations',
      slug: 'paper-results',
      icon: '📊',
      title: 'Paper writing — the Results',
      desc: 'Figure-anchored prose in Reporter voice. The "interpretation creep" trap. One subsection per figure.',
      available: true,
      planVersion: 'V3.185',
    },
    {
      category: 'foundations',
      slug: 'paper-discussion',
      icon: '🎯',
      title: 'Paper writing — the Discussion',
      desc: 'Interpret, situate, limit, project — the four jobs of the Discussion. Advocate voice with humility. The implication ladder.',
      available: true,
      planVersion: 'V3.186',
    },
    {
      category: 'foundations',
      slug: 'paper-abstract',
      icon: '📋',
      title: 'Paper writing — the Abstract',
      desc: 'Survive the 8-second skim. Word budgeting, structured vs unstructured, why the Abstract is NOT a shortened Introduction.',
      available: true,
      planVersion: 'V3.187',
    },
    {
      category: 'foundations',
      slug: 'paper-peer-review',
      icon: '🔍',
      title: 'Paper writing — peer review & revision',
      desc: 'The post-submission half. What reviewers do, what you owe them, and how to write a response letter that lands. Both sides of the review transaction.',
      available: true,
      planVersion: 'V3.188',
    },
    {
      category: 'foundations',
      slug: 'phd-triangle',
      icon: '🔺',
      title: 'The PhD triangle',
      desc: 'Three pillars of a good PhD — Communication, Creativity, Grit — with Knowledge at the center. Self-assess and map your growth.',
      available: true,
      planVersion: 'V3.162',
    },
    {
      category: 'foundations',
      slug: 'scientific-communication',
      icon: '🎤',
      title: 'Scientific communication',
      desc: 'Telling a story in scientific framing — posters and presentations. The complexity/attention arc, protagonist picking, classic story shapes, and a printable storyboard builder.',
      available: true,
      planVersion: 'V3.176',
    },

    // ── Using RM ─────────────────────────────────────────────────
    {
      category: 'rm-hub',
      slug: 'rm-essentials',
      icon: '🧭',
      title: 'RM Essentials',
      desc: 'Day-1 orientation — sign in, find your way around, run the workflow strip, use split view, fill in your profile. The first thing a new lab member should read.',
      available: true,
      planVersion: 'V3.177',
    },
    {
      category: 'rm-hub',
      slug: 'rm-daily-research',
      icon: '🧪',
      title: 'Daily research workflow',
      desc: 'Activity tracker, lab notebook, library, protocols — how the four daily pages fit together and feed your next PMR.',
      available: true,
      planVersion: 'V3.178',
    },
    {
      category: 'rm-hub',
      slug: 'rm-tasks-pmr',
      icon: '📋',
      title: 'Tasks & PMR',
      desc: 'The bucket + subtask model, the Proposed Inbox, cross-user assignment, and how to file PMR weekly entries that are actually useful for Alex.',
      available: false,
      planVersion: 'V3.179',
    },
    {
      category: 'rm-hub',
      slug: 'rm-papers',
      icon: '📚',
      title: 'Papers in RM',
      desc: 'Library annotations, the paper builder, citation drop, figure uploads, and how drafts surface in your PMR paper-writing block. Pairs with the V3.163 paper-writing training.',
      available: false,
      planVersion: 'V3.180',
    },
    {
      category: 'rm-hub',
      slug: 'rm-admin',
      icon: '🔐',
      title: 'RM for admins',
      desc: 'PI + senior-member surfaces: compliance, chemical safety, inventory, procurement, equipment booking, analytics. Admin-gated; not for guest accounts.',
      available: false,
      planVersion: 'V3.181',
    },

    // ── Microscopy ───────────────────────────────────────────────
    {
      category: 'microscopy',
      slug: 'microscope-basics',
      icon: '🔬',
      title: 'Microscope basics',
      desc: 'Resolution, NA, Köhler illumination, contrast mechanisms — concepts before you touch any specific scope. Required before first-time AX-R confocal access.',
      available: true,
      planVersion: 'V3.164',
      required: true,
    },
    {
      category: 'microscopy',
      slug: 'epifluorescence',
      icon: '💡',
      title: 'Epi-fluorescence (Ti-e / Ti2-U)',
      desc: 'Operate the lab\'s two Nikon epi-fluorescence frames — light path, filter cubes, sources, frame-specific quirks.',
      available: true,
      planVersion: 'V3.165',
    },
    {
      category: 'microscopy',
      slug: 'confocal',
      icon: '🎯',
      title: 'Confocal (Nikon AX-R)',
      desc: 'Pinhole sectioning, resonant vs. galvo scan modes, lasers, Z-stacks, photobleaching — and the AX-R-specific workflow. Requires Microscope basics first.',
      available: true,
      planVersion: 'V3.166',
    },
    {
      category: 'microscopy',
      slug: 'image-train',
      icon: '🔭',
      title: 'Image train & objectives',
      desc: 'The optical components from sample to camera; how to read an objective spec sheet; coverslip correction; tube-lens matching.',
      available: true,
      planVersion: 'V3.167',
    },
    {
      category: 'microscopy',
      slug: 'camera-selection',
      icon: '📷',
      title: 'Selecting a camera',
      desc: 'Sensor families (sCMOS, BSI, qCMOS, EMCCD), the six datasheet specs that decide, modality-driven priorities, an SNR calculator, and a printable shortlist from a 15-camera catalog.',
      available: true,
      planVersion: 'V3.184',
    },

    // ── Image analysis — concepts ────────────────────────────────
    {
      category: 'analysis',
      slug: 'image-analysis-basic',
      icon: '🟢',
      title: 'Image analysis — basic',
      desc: 'Pixels, bit depth, LUTs, channels, ROI measurement — first-touch analysis of confocal stacks.',
      available: false,
      planVersion: 'V3.168',
    },
    {
      category: 'analysis',
      slug: 'image-analysis-intermediate',
      icon: '🟡',
      title: 'Image analysis — intermediate',
      desc: 'Background subtraction, Otsu thresholding, watershed splitting, per-object quantification, batch processing.',
      available: false,
      planVersion: 'V3.169',
    },
    {
      category: 'analysis',
      slug: 'image-analysis-advanced',
      icon: '🔴',
      title: 'Image analysis — advanced',
      desc: 'Deconvolution, 3D segmentation, colocalization metrics, ML-assisted segmentation (Cellpose / StarDist), time-lapse tracking.',
      available: false,
      planVersion: 'V3.170',
    },

    // ── Image analysis — software (tools) ────────────────────────
    {
      category: 'tools',
      slug: 'imagej-fiji',
      icon: '🧰',
      title: 'ImageJ / Fiji — full workflow',
      desc: 'Open-source path: Bio-Formats import, channels + LUTs, preprocessing, segmentation (incl. StarDist + Cellpose plugins), TrackMate, macros for batch processing.',
      available: false,
      planVersion: 'V3.172',
      kind: 'open-source',
    },
    {
      category: 'tools',
      slug: 'cell-tracker',
      icon: '🧬',
      title: 'Cell Tracker (lab software)',
      desc: 'The lab\'s flagship Python GUI for confocal time-series — 11-page workflow from ND2 import through StarDist segmentation, tracking, Eulerian + Lagrangian analysis.',
      available: false,
      planVersion: 'V3.171',
      kind: 'lab-software',
    },
    {
      category: 'tools',
      slug: 'spheroid-sizes',
      icon: '🟣',
      title: 'SpheroidSizes (lab software)',
      desc: 'Script-driven spheroid sizing + cell-state classification with tiered parameter sweeps over confocal images.',
      available: false,
      planVersion: 'V3.173',
      kind: 'lab-software',
    },
    {
      category: 'tools',
      slug: 'serialtrack',
      icon: '🟠',
      title: 'SerialTrack_Python (lab software)',
      desc: 'Particle tracking velocimetry (PTV) for full-field displacements + strains from 2D / 3D confocal sequences. The TFM workhorse; also a Cell Tracker tracker backend.',
      available: false,
      planVersion: 'V3.174',
      kind: 'lab-software',
    },
    {
      category: 'tools',
      slug: 'gels-segmentation',
      icon: '🟤',
      title: 'GELS_ImageSegmentation (lab software)',
      desc: 'Segmentation pipeline for confocal images of cell-laden hydrogels — ND2 parsing through region masks, with paired training data.',
      available: false,
      planVersion: 'V3.175',
      kind: 'lab-software',
    },
  ];

  function escapeHtml(s) {
    if (s == null) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  function buildCard(m) {
    const available = !!m.available;
    const tag = available ? 'a' : 'div';
    const el = document.createElement(tag);
    el.className = 'training-card ' + (available ? 'is-available' : 'is-coming-soon');
    if (available) {
      el.setAttribute('href', '/rm/pages/training-' + m.slug + '.html');
    } else {
      el.setAttribute('aria-disabled', 'true');
      el.setAttribute('title', 'Coming soon — see plan ' + m.planVersion);
    }
    const requiredPill = m.required
      ? '<span class="training-card-status is-required" title="Lab-required prerequisite for confocal access">Required</span>'
      : '';
    const kindPill = m.kind === 'lab-software'
      ? '<span class="training-card-status is-lab-software" title="Custom software built and maintained by the lab">Lab software</span>'
      : (m.kind === 'open-source'
          ? '<span class="training-card-status is-open-source" title="Open-source / community tool">Open source</span>'
          : '');
    el.innerHTML =
      '<div class="training-card-icon">' + escapeHtml(m.icon) + '</div>' +
      '<div class="training-card-title">' + escapeHtml(m.title) + '</div>' +
      '<div class="training-card-desc">' + escapeHtml(m.desc) + '</div>' +
      '<div class="training-card-status-row">' +
      '<span class="training-card-status ' + (available ? 'is-available' : 'is-coming-soon') + '">' +
      (available ? 'Available' : 'Coming soon') +
      '</span>' +
      kindPill +
      requiredPill +
      '</div>';
    return el;
  }

  function buildCategorySection(cat) {
    const wrap = document.createElement('section');
    wrap.className = 'training-category';
    wrap.dataset.category = cat.key;

    const header = document.createElement('div');
    header.className = 'training-category-header';
    header.innerHTML =
      '<h2 class="training-category-title">' + escapeHtml(cat.label) + '</h2>' +
      '<p class="training-category-blurb">' + escapeHtml(cat.blurb) + '</p>';
    wrap.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'training-grid';
    MODULES.filter(m => m.category === cat.key).forEach(m => grid.appendChild(buildCard(m)));
    wrap.appendChild(grid);

    return wrap;
  }

  function render() {
    const root = document.getElementById('training-grid-root');
    if (!root) return;
    root.innerHTML = '';
    CATEGORIES.forEach(cat => {
      const hasAny = MODULES.some(m => m.category === cat.key);
      if (!hasAny) return;
      root.appendChild(buildCategorySection(cat));
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) {
      firebridge.whenAuthResolved().then(render).catch(render);
    } else {
      render();
    }
  });
})();

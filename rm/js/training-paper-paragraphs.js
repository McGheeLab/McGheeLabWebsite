/* training-paper-paragraphs.js — V3.182.
 *
 * Lecture-style page on sentence-level scientific writing craft.
 * Four interactive widgets:
 *   1. Skeleton ↔ prose transformer (4 examples × {skeleton, prose})
 *   2. Voice grid is static markup (no JS); included here as context.
 *   3. Scope dial — 10-step slider with per-step text examples
 *      + the "where does this scope belong" label
 *   4. Paragraph builder capstone — section + voice + skeleton + 3
 *      input lines → rendered paragraph + voice/section mismatch warnings
 *
 * Plus the standard TOC scroll-spy (same pattern as V3.163 / V3.176 /
 * V3.177).
 */
(function () {
  'use strict';

  // ── Skeleton ↔ prose examples ─────────────────────────────────────
  const EXAMPLES = [
    {
      label: 'Results — Reporter voice',
      voice: 'Reporter',
      skeleton: [
        ['observation', 'Invasion increased under stiff vs soft matrix.'],
        ['quantification', '2.4-fold at 24 h, n=12 spheroids per condition, p<0.001.'],
        ['conclusion-from-figure', 'Stiff matrices promote invasion in this assay.'],
      ],
      prose:
        'Spheroid invasion increased 2.4-fold under stiff (4.5 kPa) versus ' +
        'soft (1.5 kPa) matrix conditions at 24 h (Fig. 2a; n=12 spheroids ' +
        'per condition; two-tailed t-test, p&lt;0.001). Stiff matrices ' +
        'promoted invasion in this assay.',
      meta: 'Neutral, anchored to a figure panel, statistics inline, no "interestingly."',
    },
    {
      label: 'Introduction last paragraph — Storyteller voice',
      voice: 'Storyteller',
      skeleton: [
        ['context', 'The role of stiffness in invasion has been contested for two decades.'],
        ['gap', 'A missing variable might explain the contradictions.'],
        ['plan + finding', 'We hypothesized edge cell density is that variable, and show it inverts the effect.'],
      ],
      prose:
        'The role of substrate stiffness in tumor invasion has been ' +
        'contested for two decades: some reports show stiffer matrices ' +
        'promote invasion, others show the opposite. We hypothesized ' +
        'that the discrepancy stems from an unappreciated dependence on ' +
        'cell-density at the spheroid edge. Here we show that, in ' +
        'patient-derived breast tumor spheroids, edge cell density ' +
        'inverts the effect of stiffness on invasion — at low edge ' +
        'density, stiffer matrices suppress invasion; at high density, ' +
        'they promote it.',
      meta: 'Narrative + stake-setting + claim in one sentence. The reader knows the entire paper in 70 words.',
    },
    {
      label: 'Discussion — Advocate voice',
      voice: 'Advocate',
      skeleton: [
        ['interpretation', 'Edge density is the missing variable in stiffness-driven invasion.'],
        ['evidence + literature', 'Our dose-dependent inversion fits both schools of prior literature when density is included.'],
        ['caveat / implication', 'Mechanism may include intracellular tension changes, which we cannot rule out.'],
      ],
      prose:
        'Our results suggest that edge density is the missing variable ' +
        'in stiffness-driven invasion. When prior reports are stratified ' +
        'by edge density, both seemingly contradictory schools are ' +
        'consistent with the dose-dependent inversion we observe. While ' +
        'we cannot rule out contributions from intracellular tension ' +
        'changes, the threshold effect at 0.12 cells/μm² argues for a ' +
        'primarily mechanical mechanism.',
      meta: 'Claim-making with humility — "suggests," "argues for," "we cannot rule out." Bold but bounded.',
    },
    {
      label: 'Methods — Technician voice',
      voice: 'Technician',
      skeleton: [
        ['what', 'Patient-derived BT-549 spheroids embedded in collagen-I matrices.'],
        ['how', 'Imaged on Nikon AX-R confocal at 25×/1.1 NA, 1 AU pinhole, every 30 min for 24 h.'],
        ['(optional why)', 'Water-immersion objective chosen to reach the equator of 200-μm spheroids.'],
      ],
      prose:
        'Patient-derived BT-549 spheroids (passage 8–12) were embedded ' +
        'in collagen-I matrices (1.5 or 4.5 kPa, calibrated by ' +
        'rheometry) and imaged on a Nikon AX-R confocal microscope ' +
        '(25× / 1.1 NA water immersion, 1 AU pinhole, 488 nm ' +
        'excitation, 200 nm Z step) every 30 min for 24 h. The ' +
        'water-immersion objective was selected for its 2 mm working ' +
        'distance, which allowed imaging to the spheroid equator.',
      meta: 'Recipe. Catalog-level precision. No "we believe" or "interestingly." Reproducible by a stranger.',
    },
  ];

  let stageIdx = 0;
  let stageView = 'skeleton';   // 'skeleton' | 'prose'

  function renderStage() {
    const ex = EXAMPLES[stageIdx];
    document.getElementById('stage-title').textContent =
      'Example ' + (stageIdx + 1) + '/' + EXAMPLES.length + ' — ' + ex.label;
    // Skeleton text
    const skelLines = ex.skeleton.map(([label, text]) =>
      '<span class="label">' + escapeHtml(label) + ':</span> ' + escapeHtml(text)).join('\n');
    document.getElementById('skel-skeleton-content').innerHTML = skelLines;
    // Prose
    document.getElementById('skel-prose-content').innerHTML = ex.prose;
    // Meta
    document.getElementById('skel-meta').textContent = ex.meta;
    // View toggle
    document.getElementById('skel-skeleton-view').classList.toggle('is-active', stageView === 'skeleton');
    document.getElementById('skel-prose-view').classList.toggle('is-active', stageView === 'prose');
    document.getElementById('stage-skeleton').classList.toggle('active', stageView === 'skeleton');
    document.getElementById('stage-prose').classList.toggle('active', stageView === 'prose');
  }

  function wireStage() {
    document.getElementById('stage-skeleton').addEventListener('click', () => { stageView = 'skeleton'; renderStage(); });
    document.getElementById('stage-prose').addEventListener('click', () => { stageView = 'prose'; renderStage(); });
    document.getElementById('stage-prev').addEventListener('click', () => {
      stageIdx = (stageIdx - 1 + EXAMPLES.length) % EXAMPLES.length;
      stageView = 'skeleton';
      renderStage();
    });
    document.getElementById('stage-next').addEventListener('click', () => {
      stageIdx = (stageIdx + 1) % EXAMPLES.length;
      stageView = 'skeleton';
      renderStage();
    });
  }

  // ── Scope dial ────────────────────────────────────────────────────
  const SCOPE_LEVELS = {
    1:  { where: 'Public-engagement talk · grant lay-summary', text: 'Cancer kills millions of people every year.' },
    2:  { where: 'Conference plenary opening · NIH section intro', text: 'Solid tumors metastasize through a complex interplay of biology and mechanics.' },
    3:  { where: 'Abstract opening · grant Specific Aims sentence 1', text: 'Tumor invasion depends on the mechanical properties of the surrounding matrix.' },
    4:  { where: 'Title · Introduction paragraph 1', text: 'Mechanical cues from the extracellular matrix shape tumor invasion in 3-D culture.' },
    5:  { where: 'Introduction paragraph 2 · Discussion broadening move', text: 'Substrate stiffness modulates tumor invasion, but reports disagree on the direction of the effect.' },
    6:  { where: 'Title · Abstract impact sentence', text: 'Edge cell density inverts the effect of substrate stiffness on tumor invasion.' },
    7:  { where: 'Discussion opening · Abstract result', text: 'Edge density above 0.12 cells/μm² inverted the effect of 1.5 vs 4.5 kPa matrix stiffness on invasion in BT-549 spheroids.' },
    8:  { where: 'Results paragraph claim', text: 'In 5 patient-derived spheroid lines, raising edge density above 0.12 cells/μm² reversed the sign of the stiffness-invasion relationship at 24 h.' },
    9:  { where: 'Results subsection title · figure legend', text: 'For BT-549 spheroids in 1.5 vs 4.5 kPa collagen, invasion increased 2.4-fold at low edge density (<0.1 cells/μm²) and decreased 0.6-fold at high edge density (>0.2 cells/μm²).' },
    10: { where: 'Methods · supplementary table caption', text: 'BT-549 spheroids (passage 8–12; n=12 per condition) embedded in 1.5 kPa or 4.5 kPa collagen-I matrices and imaged for 24 h on a Nikon AX-R at 25×/1.1 NA water-immersion; edge cell density quantified by StarDist segmentation of the outer 10 μm of each spheroid.' },
  };

  function wireScopeDial() {
    const slider = document.getElementById('scope-slider');
    const out = document.getElementById('scope-out');
    const where = document.getElementById('scope-where');
    const text = document.getElementById('scope-text');
    if (!slider) return;
    function refresh() {
      const v = parseInt(slider.value, 10);
      const entry = SCOPE_LEVELS[v] || SCOPE_LEVELS[5];
      out.textContent = v;
      where.textContent = '— ' + entry.where + ' —';
      text.textContent = entry.text;
    }
    slider.addEventListener('input', refresh);
    refresh();
  }

  // ── Paragraph builder capstone ────────────────────────────────────
  const SECTION_LABELS = {
    intro:      'Introduction',
    methods:    'Methods',
    results:    'Results',
    discussion: 'Discussion',
    abstract:   'Abstract',
  };
  const VOICE_LABELS = {
    reporter: 'Reporter', storyteller: 'Storyteller', advocate: 'Advocate', technician: 'Technician',
  };
  const SKELETON_LABELS = {
    cel: 'Claim → Evidence → Link',
    oqi: 'Observation → Quantification → Conclusion',
    cgn: 'Context → Gap → What\'s-next',
    ieq: 'Interpretation → Evidence → Implication',
    whw: 'What → How → Why',
  };

  // Recommended voice per section + recommended skeleton per section
  const RECOMMENDED = {
    intro:      { voice: 'storyteller', skeletons: ['cgn', 'cel'] },
    methods:    { voice: 'technician',  skeletons: ['whw'] },
    results:    { voice: 'reporter',    skeletons: ['oqi', 'cel'] },
    discussion: { voice: 'advocate',    skeletons: ['ieq', 'cel'] },
    abstract:   { voice: 'storyteller', skeletons: ['cel', 'cgn'] },
  };

  // Voice-specific transition templates between the 3 skeleton lines
  function renderParagraph(voice, line1, line2, line3) {
    const a = String(line1 || '').trim();
    const b = String(line2 || '').trim();
    const c = String(line3 || '').trim();
    if (!a || !b || !c) return '';
    if (voice === 'reporter') {
      return a + ' ' + b + ' ' + c;
    }
    if (voice === 'storyteller') {
      return a + ' However, ' + lowerFirst(b) + ' Here, ' + lowerFirst(c);
    }
    if (voice === 'advocate') {
      return 'Our results suggest that ' + lowerFirst(a) + ' Specifically, ' + lowerFirst(b) + ' While we cannot fully resolve the underlying mechanism, ' + lowerFirst(c);
    }
    if (voice === 'technician') {
      return a + ' ' + b + (c ? ' ' + c : '');
    }
    return a + ' ' + b + ' ' + c;
  }
  function lowerFirst(s) {
    if (!s) return '';
    return s.charAt(0).toLowerCase() + s.slice(1);
  }

  const pbState = { section: '', voice: '', skeleton: '', line1: '', line2: '', line3: '' };

  function refreshBuilder() {
    const required = ['section', 'voice', 'skeleton', 'line1', 'line2', 'line3'];
    const missing = required.filter(k => !String(pbState[k] || '').trim());
    const verdict = document.getElementById('pb-verdict');
    const output  = document.getElementById('pb-output');
    verdict.classList.remove('is-warning', 'is-critical');

    const warnings = [];
    if (pbState.section && pbState.voice) {
      const rec = RECOMMENDED[pbState.section];
      if (rec && pbState.voice !== rec.voice) {
        warnings.push(
          SECTION_LABELS[pbState.section] + ' sections want <strong>' +
          VOICE_LABELS[rec.voice] + '</strong> voice; you picked ' +
          VOICE_LABELS[pbState.voice] + '. Voice creep is the most common first-draft failure mode.'
        );
      }
    }
    if (pbState.section && pbState.skeleton) {
      const rec = RECOMMENDED[pbState.section];
      if (rec && rec.skeletons.indexOf(pbState.skeleton) < 0) {
        warnings.push(
          'For a ' + SECTION_LABELS[pbState.section] + ' paragraph, try the <strong>' +
          SKELETON_LABELS[rec.skeletons[0]] + '</strong> shape — it is closer to what readers expect there. The default Claim→Evidence→Link works too, but is less optimized.'
        );
      }
    }

    if (missing.length) {
      verdict.classList.add('is-critical');
      verdict.innerHTML = '<strong>Fill in every field to render the paragraph.</strong> Still need: ' +
        missing.map(m => m).join(', ') + '.';
      output.style.display = 'none';
      return;
    }

    const para = renderParagraph(pbState.voice, pbState.line1, pbState.line2, pbState.line3);
    document.getElementById('pb-meta').innerHTML =
      '<strong>Section:</strong> ' + SECTION_LABELS[pbState.section] +
      ' · <strong>Voice:</strong> ' + VOICE_LABELS[pbState.voice] +
      ' · <strong>Skeleton:</strong> ' + SKELETON_LABELS[pbState.skeleton];
    document.getElementById('pb-body').textContent = para;
    output.style.display = '';

    if (warnings.length) {
      verdict.classList.add('is-warning');
      verdict.innerHTML = '<strong>Rendered with warnings:</strong><ul style="margin:6px 0 0 18px;">' +
        warnings.map(w => '<li>' + w + '</li>').join('') + '</ul>';
    } else {
      verdict.innerHTML = '<strong>Voice and skeleton match the section.</strong> The paragraph below is what the reader will see — copy it into your paper builder if it works.';
    }
  }

  function wireBuilder() {
    const map = {
      'pb-section': 'section', 'pb-voice': 'voice', 'pb-skeleton': 'skeleton',
      'pb-line1': 'line1', 'pb-line2': 'line2', 'pb-line3': 'line3',
    };
    Object.keys(map).forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      const key = map[id];
      const handler = (e) => { pbState[key] = e.target.value; refreshBuilder(); };
      el.addEventListener('input', handler);
      el.addEventListener('change', handler);
    });
    refreshBuilder();
  }

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
    wireStage();
    renderStage();
    wireScopeDial();
    wireBuilder();
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) {
      firebridge.whenAuthResolved().then(init).catch(init);
    } else {
      init();
    }
  });
})();

/* training-epifluorescence.js — V3.165 interactive notebook.
 *
 * Five tabs covering the lab's two Nikon epi-fluorescence frames:
 *   1. Light path — annotated optical schematic + active cube highlights
 *   2. Filter cubes — fluorophore × cube matching with spectra overlay
 *   3. Sources — LED (Ti2-U) vs arc lamp (Ti-e) signal curves
 *   4. Frame ops — Ti-e vs Ti2-U comparison + 6-step user checklist
 *   5. Capstone — 8-hour Ti2-U live-cell time-lapse plan with sign-off
 *
 * Reuses the V3.164/V3.166 interactive-notebook patterns: shared CSS,
 * DPR-aware canvas, requestAnimationFrame tab dispatch, component-local
 * state, auth via firebridge.whenAuthResolved.
 */
(function () {
  'use strict';

  function getCanvasCtx(id) {
    const c = document.getElementById(id);
    if (!c) return null;
    const dpr = window.devicePixelRatio || 1;
    const rect = c.getBoundingClientRect();
    const cssW = rect.width  > 4 ? rect.width  : (parseFloat(c.getAttribute('width'))  || 600);
    const cssH = rect.height > 4 ? rect.height : (parseFloat(c.getAttribute('height')) || 300);
    c.width  = Math.round(cssW * dpr);
    c.height = Math.round(cssH * dpr);
    c.style.width  = cssW + 'px';
    c.style.height = cssH + 'px';
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { c, ctx, w: cssW, h: cssH };
  }

  // ── Fixed reference data ──────────────────────────────────────────

  // Cube spec: ex bandpass [low, high], dichroic edge, em bandpass [low, high]
  const CUBES = {
    dapi:    { label: 'DAPI',    ex: [370, 410], dich: 425, em: [435, 485], exColor: '#a78bfa', emColor: '#60a5fa' },
    gfp:     { label: 'GFP',     ex: [450, 490], dich: 495, em: [500, 550], exColor: '#34d399', emColor: '#16a34a' },
    mcherry: { label: 'mCherry', ex: [540, 580], dich: 585, em: [592, 667], exColor: '#fbbf24', emColor: '#f97316' },
    cy5:     { label: 'Cy5',     ex: [590, 650], dich: 660, em: [663, 738], exColor: '#fb7185', emColor: '#dc2626' },
    mismatch:{ label: 'Mismatched (GFP ex + Cy5 em)', ex: [450, 490], dich: 495, em: [663, 738], exColor: '#34d399', emColor: '#dc2626' },
  };

  // Fluorophore: ex peak/σ, em peak/σ — gaussian approximations
  const FLUORS = {
    dapi:    { label: 'DAPI',    exPeak: 358, exSig: 24, emPeak: 461, emSig: 35 },
    gfp:     { label: 'GFP / AF488', exPeak: 488, exSig: 18, emPeak: 510, emSig: 22 },
    mcherry: { label: 'mCherry / AF568', exPeak: 587, exSig: 24, emPeak: 610, emSig: 30 },
    cy5:     { label: 'Cy5 / AF647', exPeak: 650, exSig: 22, emPeak: 670, emSig: 28 },
  };

  // ── State ─────────────────────────────────────────────────────────
  const state = {
    lightpath: { cube: 'gfp' },
    cube:      { fluor: 'gfp', cube: 'gfp' },
    source:    { kind: 'led', power: 20, frames: 100 },
    frame:     { which: 'tie' },
    plan:      { obj: '', exp: 200, bin: 1, pfs: 'on', power: 10, interval: 5 },
  };

  let activeTab = 'tab-lightpath';

  function setActiveTab(id) {
    activeTab = id;
    document.querySelectorAll('.tab-btn').forEach(b => {
      const on = b.dataset.tab === id;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.tab-content').forEach(t => {
      t.classList.toggle('active', t.id === id);
    });
    requestAnimationFrame(redrawActiveTab);
  }

  function redrawActiveTab() {
    if      (activeTab === 'tab-lightpath') drawLightPath();
    else if (activeTab === 'tab-cubes')     drawCubePanel();
    else if (activeTab === 'tab-sources')   drawSource();
    else if (activeTab === 'tab-frames')    drawFramePanel();
    else if (activeTab === 'tab-plan')      drawPlan();
  }

  // ── TAB 1 — Light path ────────────────────────────────────────────

  function drawLightPath() {
    const cube = CUBES[state.lightpath.cube];
    document.getElementById('lp-label').textContent     = cube.label;
    document.getElementById('lp-ex').textContent        = cube.ex[0] + '–' + cube.ex[1] + ' nm';
    document.getElementById('lp-dichroic').textContent  = cube.dich + ' nm';
    document.getElementById('lp-em').textContent        = cube.em[0] + '–' + cube.em[1] + ' nm';

    // Verdict + status
    const v = document.getElementById('lp-verdict');
    v.classList.remove('is-warning', 'is-critical');
    let status, text;
    if (state.lightpath.cube === 'mismatch') {
      v.classList.add('is-critical');
      status = 'will not work';
      text = '<strong>Mismatched cube.</strong> The GFP excitation band (470/40) excites GFP, but the Cy5 emission band (700/75) sits 200 nm away from where GFP emits. Result: GFP gets hit by excitation, fluoresces, but the camera never sees the emission. The cube is structurally a filter cube; it just isn\'t the right one.';
    } else {
      status = 'matched';
      text = '<strong>' + cube.label + ' cube installed.</strong> Excitation, dichroic, and emission are all aligned for this fluorophore. The light path below shows the actual wavelengths in flight.';
    }
    document.getElementById('lp-status').textContent = status;
    v.innerHTML = text;

    // Canvas: light path
    const cw = getCanvasCtx('canvas-lightpath');
    if (!cw) return;
    const { ctx, w, h } = cw;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    // Layout — vertical scope on the right, source on the upper-left
    const objX = w * 0.62, objY = h * 0.78;
    const cubeX = w * 0.62, cubeY = h * 0.48;
    const tubeX = w * 0.62, tubeY = h * 0.18;
    const sourceX = w * 0.18, sourceY = cubeY;
    const sampleX = objX, sampleY = h * 0.92;

    // Helper to draw a rectangular component with a label
    function drawBox(x, y, ww, hh, label, fill, stroke) {
      ctx.fillStyle = fill;
      ctx.fillRect(x - ww / 2, y - hh / 2, ww, hh);
      ctx.strokeStyle = stroke || '#475569';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - ww / 2, y - hh / 2, ww, hh);
      ctx.fillStyle = '#1f2937';
      ctx.font = '11px -apple-system, sans-serif';
      ctx.fillText(label, x - ctx.measureText(label).width / 2, y + 4);
    }

    // Source
    drawBox(sourceX, sourceY, 90, 30, 'Source', '#fef3c7');
    // Excitation filter (between source and cube)
    drawBox((sourceX + cubeX) / 2, cubeY, 70, 22, 'Ex filter', '#dbeafe');
    // Filter cube
    drawBox(cubeX, cubeY, 80, 80, '', '#e0e7ff', '#4338ca');
    // Dichroic diagonal inside the cube
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cubeX - 40, cubeY - 40);
    ctx.lineTo(cubeX + 40, cubeY + 40);
    ctx.stroke();
    ctx.fillStyle = '#4338ca';
    ctx.font = 'bold 10px -apple-system, sans-serif';
    ctx.fillText('dichroic', cubeX - 22, cubeY + 50);
    // Emission filter (above cube)
    drawBox(cubeX, (cubeY + tubeY) / 2, 80, 22, 'Em filter', '#dcfce7');
    // Tube lens + camera (top)
    drawBox(tubeX, tubeY, 90, 22, 'Tube lens + camera', '#f3f4f6');
    // Objective (below cube)
    drawBox(objX, objY, 80, 30, 'Objective', '#fed7aa');
    // Sample
    ctx.fillStyle = '#475569';
    ctx.font = '12px -apple-system, sans-serif';
    ctx.fillText('sample', sampleX - 22, sampleY + 4);

    // Excitation rays (source → ex filter → cube → objective → sample) — blue
    ctx.strokeStyle = cube.exColor;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(sourceX + 45, sourceY);
    ctx.lineTo(cubeX - 40, cubeY);
    ctx.stroke();
    // Down through cube via dichroic reflection
    ctx.beginPath();
    ctx.moveTo(cubeX, cubeY);
    ctx.lineTo(cubeX, objY - 15);
    ctx.stroke();
    // Through objective to sample
    ctx.beginPath();
    ctx.moveTo(cubeX, objY + 15);
    ctx.lineTo(sampleX, sampleY - 8);
    ctx.stroke();

    // Emission rays (sample → objective → cube → em filter → tube lens) — green
    ctx.strokeStyle = cube.emColor;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(sampleX, sampleY - 12);
    ctx.lineTo(cubeX, objY + 15);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cubeX, objY - 15);
    ctx.lineTo(cubeX, cubeY);
    ctx.stroke();
    // Through dichroic (passes straight up)
    ctx.beginPath();
    ctx.moveTo(cubeX, cubeY);
    ctx.lineTo(cubeX, tubeY + 12);
    ctx.stroke();
    ctx.setLineDash([]);

    // Mismatch overlay
    if (state.lightpath.cube === 'mismatch') {
      ctx.fillStyle = 'rgba(220, 38, 38, 0.12)';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#dc2626';
      ctx.font = 'bold 13px -apple-system, sans-serif';
      ctx.fillText('⚠  Emission filter is 200 nm off from any fluorophore', 10, 20);
      // Cross out the emission path
      ctx.strokeStyle = '#dc2626';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cubeX - 18, (cubeY + tubeY) / 2 - 8);
      ctx.lineTo(cubeX + 18, (cubeY + tubeY) / 2 + 8);
      ctx.moveTo(cubeX + 18, (cubeY + tubeY) / 2 - 8);
      ctx.lineTo(cubeX - 18, (cubeY + tubeY) / 2 + 8);
      ctx.stroke();
    }

    // Legend
    ctx.fillStyle = '#1f2937';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.fillText('— excitation', 12, h - 28);
    ctx.fillText('-- emission',  12, h - 12);
    ctx.strokeStyle = cube.exColor;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(80, h - 32); ctx.lineTo(110, h - 32); ctx.stroke();
    ctx.strokeStyle = cube.emColor;
    ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(80, h - 16); ctx.lineTo(110, h - 16); ctx.stroke();
    ctx.setLineDash([]);
  }

  // ── TAB 2 — Filter cubes ──────────────────────────────────────────

  function overlapBandWithGaussian(band, peak, sigma) {
    // Numerical integration of gaussian * indicator(band)
    const [lo, hi] = band;
    const N = 40;
    let s = 0;
    for (let i = 0; i < N; i++) {
      const x = lo + (i / N) * (hi - lo);
      s += Math.exp(-((x - peak) * (x - peak)) / (2 * sigma * sigma));
    }
    return s / N * (hi - lo);   // approximate area; normalization not strict
  }

  function drawCubePanel() {
    const fluor = FLUORS[state.cube.fluor];
    const cube  = CUBES[state.cube.cube];

    document.getElementById('cube-fluor-label').textContent = fluor.label;
    document.getElementById('cube-cube-label').textContent  = cube.label;

    // Compute overlap %
    const peakArea = fluor.emSig * Math.sqrt(2 * Math.PI);
    const exOverlap = overlapBandWithGaussian(cube.ex, fluor.exPeak, fluor.exSig) / (fluor.exSig * Math.sqrt(2 * Math.PI)) * 100;
    const emOverlap = overlapBandWithGaussian(cube.em, fluor.emPeak, fluor.emSig) / peakArea * 100;

    document.getElementById('cube-ex-overlap').textContent = exOverlap.toFixed(0) + '%';
    document.getElementById('cube-em-overlap').textContent = emOverlap.toFixed(0) + '%';

    const v = document.getElementById('cube-verdict');
    const status = document.getElementById('cube-status');
    v.classList.remove('is-warning', 'is-critical');
    let text;
    if (exOverlap < 5 && emOverlap < 5) {
      status.textContent = 'no signal';
      v.classList.add('is-critical');
      text = '<strong>No signal.</strong> Neither the excitation nor the emission band overlaps the fluorophore. The cube and fluorophore are completely mismatched.';
    } else if (exOverlap < 15) {
      status.textContent = 'dim';
      v.classList.add('is-warning');
      text = '<strong>Very dim signal.</strong> Excitation band only covers ' + exOverlap.toFixed(0) + '% of the fluorophore\'s absorption — you\'re hitting it with off-spec light. Switch to the correct cube.';
    } else if (emOverlap < 15) {
      status.textContent = 'no signal';
      v.classList.add('is-critical');
      text = '<strong>Almost no signal at the camera.</strong> The emission band misses the fluorophore peak (' + emOverlap.toFixed(0) + '% overlap). Excitation is fine but the camera can\'t see what the sample is emitting.';
    } else if (exOverlap > 50 && emOverlap > 50) {
      status.textContent = 'excellent match';
      text = '<strong>Excellent match.</strong> Excitation ' + exOverlap.toFixed(0) + '%, emission ' + emOverlap.toFixed(0) + '%. This is what you want for a publication-quality image.';
    } else {
      status.textContent = 'acceptable';
      text = '<strong>Acceptable match.</strong> Excitation ' + exOverlap.toFixed(0) + '%, emission ' + emOverlap.toFixed(0) + '%. The signal will work but you may want to verify with a brighter test sample first.';
    }
    v.innerHTML = text;

    // Canvas
    const cw = getCanvasCtx('canvas-cube');
    if (!cw) return;
    const { ctx, w, h } = cw;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    const padL = 36, padR = 12, padT = 12, padB = 28;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const xMin = 350, xMax = 750;
    function nm2px(nm) { return padL + (nm - xMin) / (xMax - xMin) * plotW; }

    // Axes
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, padT + plotH);
    ctx.lineTo(padL + plotW, padT + plotH);
    ctx.stroke();
    ctx.fillStyle = '#475569';
    ctx.font = '11px -apple-system, sans-serif';
    [400, 450, 500, 550, 600, 650, 700].forEach(t => {
      const px = nm2px(t);
      ctx.beginPath(); ctx.moveTo(px, padT + plotH); ctx.lineTo(px, padT + plotH + 4); ctx.stroke();
      ctx.fillText(t + '', px - 10, padT + plotH + 16);
    });
    ctx.fillText('emission λ (nm)', padL + plotW / 2 - 40, h - 8);

    // Cube transmission bands (solid fills)
    function fillBand(band, color) {
      ctx.fillStyle = color;
      const x0 = nm2px(band[0]), x1 = nm2px(band[1]);
      ctx.fillRect(x0, padT, x1 - x0, plotH);
    }
    fillBand(cube.ex, cube.exColor + '44');
    fillBand(cube.em, cube.emColor + '44');

    // Cube band outlines + labels
    function outlineBand(band, color, label) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      const x0 = nm2px(band[0]), x1 = nm2px(band[1]);
      ctx.beginPath();
      ctx.moveTo(x0, padT); ctx.lineTo(x0, padT + plotH);
      ctx.moveTo(x1, padT); ctx.lineTo(x1, padT + plotH);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.font = 'bold 11px -apple-system, sans-serif';
      ctx.fillText(label, (x0 + x1) / 2 - ctx.measureText(label).width / 2, padT + 12);
    }
    outlineBand(cube.ex, cube.exColor, 'ex ' + cube.ex[0] + '–' + cube.ex[1]);
    outlineBand(cube.em, cube.emColor, 'em ' + cube.em[0] + '–' + cube.em[1]);

    // Dichroic edge line
    ctx.strokeStyle = '#4338ca';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    const dx = nm2px(cube.dich);
    ctx.moveTo(dx, padT); ctx.lineTo(dx, padT + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#4338ca';
    ctx.font = '10px -apple-system, sans-serif';
    ctx.fillText('dichroic ' + cube.dich, dx + 4, padT + plotH - 4);

    // Fluorophore excitation + emission (dashed gaussians)
    function plotGaussian(peak, sig, color, dash) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.2;
      if (dash) ctx.setLineDash(dash);
      ctx.beginPath();
      for (let i = 0; i <= plotW; i++) {
        const nm = xMin + (i / plotW) * (xMax - xMin);
        const v = Math.exp(-((nm - peak) * (nm - peak)) / (2 * sig * sig));
        const px = padL + i;
        const py = padT + plotH - v * (plotH * 0.92);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    plotGaussian(fluor.exPeak, fluor.exSig, '#1d4ed8', [5, 3]);
    plotGaussian(fluor.emPeak, fluor.emSig, '#16a34a', [5, 3]);

    // Legend
    ctx.fillStyle = '#1f2937';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.fillText(fluor.label + ' excitation (dashed blue)', padL + 4, padT + plotH - 28);
    ctx.fillText(fluor.label + ' emission (dashed green)', padL + 4, padT + plotH - 14);
  }

  // ── TAB 3 — Sources ───────────────────────────────────────────────

  function drawSource() {
    const s = state.source;
    document.getElementById('src-power-out').textContent  = s.power;
    document.getElementById('src-frames-out').textContent = s.frames;
    document.getElementById('src-name').textContent       = s.kind === 'led' ? 'LED engine (Ti2-U)' : 'Arc lamp (Ti-e)';
    document.getElementById('src-stab').textContent       = s.kind === 'led' ? '< 1% variability' : '5–20% drift / session';

    // Models: signal(t) = (1 - bleach(t)) * source_stability(t)
    // Bleach k scales with power: at 20% power, k ≈ 0.005 per frame
    const k = 0.0003 * s.power;
    // Source drift: LED ~ flat; arc lamp slowly drifts down then re-warms
    const drift = (t) => s.kind === 'led' ?
      1 - 0.003 * Math.sin(t * 0.1) :     // tiny ripple
      1 - 0.12 * (1 - Math.exp(-t / 80)) + 0.05 * Math.sin(t * 0.08);   // bigger drift
    // Bleach: exp(-k * t)
    function signal(t) { return Math.exp(-k * t) * drift(t); }

    const finalSig = signal(s.frames);
    const driftMag = Math.abs(drift(s.frames) - 1.0) * 100;

    document.getElementById('src-final').textContent = (finalSig * 100).toFixed(0) + '%';
    document.getElementById('src-drift').textContent = driftMag.toFixed(1) + '%';

    const v = document.getElementById('src-verdict');
    v.classList.remove('is-warning', 'is-critical');
    let status, text;
    if (s.kind === 'led' && finalSig > 0.7) {
      status = 'stable';
      text = '<strong>LED engine, low dose.</strong> Signal stays within a few % over the whole run — great for quantitative intensity measurements. This is the Ti2-U sweet spot.';
    } else if (s.kind === 'led' && finalSig > 0.4) {
      status = 'usable';
      v.classList.add('is-warning');
      text = '<strong>LED engine, high power.</strong> The source is stable but you\'re bleaching the sample. Drop power and increase exposure if SNR allows.';
    } else if (s.kind === 'led') {
      status = 'over-bleached';
      v.classList.add('is-critical');
      text = '<strong>Heavy bleaching.</strong> Even with the stable LED, you\'ve burned through the dye by frame ' + s.frames + '. Lower the power.';
    } else if (s.kind === 'arc') {
      v.classList.add('is-warning');
      status = 'drifts';
      text = '<strong>Arc lamp drift.</strong> The arc lamp drifts ' + driftMag.toFixed(1) + '% over this run independent of your sample. For quantitative work, either correct with a per-frame reference, or move to the Ti2-U LED for the experiment.';
    }
    document.getElementById('src-status').textContent = status;
    v.innerHTML = text;

    // Canvas
    const cw = getCanvasCtx('canvas-source');
    if (!cw) return;
    const { ctx, w, h } = cw;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    const padL = 44, padR = 14, padT = 14, padB = 28;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    // Axes
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, padT + plotH);
    ctx.lineTo(padL + plotW, padT + plotH);
    ctx.stroke();

    // 100% / 50% reference lines
    ctx.strokeStyle = '#cbd5e1';
    ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL + plotW, padT); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(padL, padT + plotH / 2); ctx.lineTo(padL + plotW, padT + plotH / 2); ctx.stroke();
    ctx.setLineDash([]);

    // Signal curve
    ctx.strokeStyle = s.kind === 'led' ? '#16a34a' : '#d97706';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let i = 0; i <= plotW; i++) {
      const t = (i / plotW) * s.frames;
      const y = padT + plotH - signal(t) * plotH;
      const x = padL + i;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Labels
    ctx.fillStyle = '#475569';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.fillText('frame', padL + plotW / 2 - 14, h - 8);
    ctx.fillText('0', padL - 10, padT + plotH + 12);
    ctx.fillText(s.frames + '', padL + plotW - 12, padT + plotH + 12);
    ctx.fillText('100%', padL - 32, padT + 4);
    ctx.fillText('50%', padL - 28, padT + plotH / 2 + 4);
  }

  // ── TAB 4 — Frame ops ─────────────────────────────────────────────

  const FRAMES = {
    tie: {
      body: 'Ti-e (legacy)',
      source: 'Metal-halide arc lamp (X-Cite 120)',
      pfs: 'Optional Perfect Focus System (often disabled — calibration is finicky)',
      stage: 'Manual XY stage',
      turret: '6-position manual filter cube turret',
      software: 'NIS-Elements 4.x (legacy)',
      best: 'Quick snapshots when the Ti2-U is in use',
      quirks: 'Z focus drifts ±2 μm/hr without PFS; lamp drift ~10% / session',
      checklist: [
        'Switch the Ti-e on at the box on the right pillar — lamp warmup takes ~10 min.',
        'Confirm filter turret index matches the cube you want (DAPI/GFP/mCherry/Cy5 are labelled on the wheel).',
        'Mount the slide, focus in brightfield first (always quicker than focusing in fluorescence).',
        'Switch to fluorescence: shutter the lamp, click into the right cube, open shutter.',
        'Adjust the lamp intensity slider down to the lowest value that gives a usable image — arc lamps photobleach fast.',
        'Lock the stage before walking away. Z drifts without PFS — do not start a long acquisition without verifying focus stability.',
      ],
    },
    ti2u: {
      body: 'Ti2-U (current)',
      source: 'Lumencor / X-Cite XLED engine (4 LEDs, stable)',
      pfs: 'Perfect Focus System integrated, on by default',
      stage: 'Motorized XY stage with joystick + NIS Multi-Point',
      turret: '6-position motorized filter cube turret',
      software: 'NIS-Elements (current) with Multi-Point + JOBS time-lapse modules',
      best: 'Long live-cell time-lapse, multi-point acquisitions, anything requiring intensity stability',
      quirks: 'Motorized stage occasionally drifts ~0.5 μm — re-home if precision matters',
      checklist: [
        'Power up the controller box (left of the scope). LEDs do not need warmup.',
        'Open NIS-Elements. The LED engine and filter wheel will auto-initialize.',
        'Mount the slide; engage Perfect Focus System (PFS button on the front of the body).',
        'Select the LED channel that matches your fluorophore — the filter wheel auto-rotates to the matching cube.',
        'Set exposure + LED power. Aim for the lowest power that gives usable SNR — the LED is stable so the dial setting maps linearly to dose.',
        'For multi-point or time-lapse: build the acquisition plan in NIS-Elements before clicking Run. Save the .nd2 immediately after the run.',
      ],
    },
  };

  function drawFramePanel() {
    const f = FRAMES[state.frame.which];
    document.getElementById('fr-body').textContent     = f.body;
    document.getElementById('fr-source').textContent   = f.source;
    document.getElementById('fr-pfs').textContent      = f.pfs;
    document.getElementById('fr-stage').textContent    = f.stage;
    document.getElementById('fr-turret').textContent   = f.turret;
    document.getElementById('fr-software').textContent = f.software;
    document.getElementById('fr-best').textContent     = f.best;
    document.getElementById('fr-quirks').textContent   = f.quirks;
    document.getElementById('fr-title').textContent    = 'First-time user checklist — ' + f.body;
    const list = document.getElementById('fr-checklist');
    list.innerHTML = '';
    f.checklist.forEach(step => {
      const li = document.createElement('li');
      li.textContent = step;
      li.style.marginBottom = '4px';
      list.appendChild(li);
    });
    const v = document.getElementById('fr-verdict');
    v.classList.remove('is-warning', 'is-critical');
    if (state.frame.which === 'tie') {
      v.innerHTML = '<strong>Ti-e.</strong> Use this scope when the Ti2-U is occupied or when you specifically need an excitation wavelength only the arc lamp covers. Don\'t use it for quantitative intensity time-lapse — the lamp drift will dominate your signal.';
    } else {
      v.innerHTML = '<strong>Ti2-U.</strong> The default modern epi-fluorescence frame. Stable LED, Perfect Focus, motorized everything. Pick this scope first for any new experiment.';
    }
  }

  // ── TAB 5 — Capstone plan ─────────────────────────────────────────

  function drawPlan() {
    const p = state.plan;
    document.getElementById('pl-power-out').textContent = p.power;
    const frames = Math.max(1, Math.round((8 * 60) / p.interval));
    document.getElementById('pl-count').textContent = frames;

    const issues = [];
    const warnings = [];

    if (!p.obj) issues.push('Pick an objective.');

    // Objective sanity for live migrating cells
    const objMeta = {
      '20_075':  { NA: 0.75, mag: 20,  imm: 'air', note: 'Good field of view, low photodamage. Often the right choice for migration assays.' },
      '40_095':  { NA: 0.95, mag: 40,  imm: 'air', note: 'Decent for migration; NA almost as high as oil but air is friendlier for live multi-well.' },
      '60_140':  { NA: 1.4,  mag: 60,  imm: 'oil', note: 'High NA but oil + 8-hour live-cell = drift problems. Possible with PFS but tighten focus periodically.' },
      '100_145': { NA: 1.45, mag: 100, imm: 'oil', note: 'Resolution-overkill for migration — small FOV; cells will leave frame. Save this for subcellular work.' },
    };
    if (p.obj === '100_145') {
      warnings.push('100× / 1.45 has a small FOV — migrating cells will leave the frame quickly. 20×–40× is better suited to migration.');
    } else if (p.obj === '60_140') {
      warnings.push('60× / 1.4 oil over 8 hours: the immersion oil can dry / shift; rely on PFS and check focus visually every hour.');
    }

    // Exposure
    if (p.exp > 1000) {
      warnings.push('Exposure ' + p.exp + ' ms is long — even on a stable LED, this is a lot of light. Try halving exposure and binning 2×2 instead.');
    }

    // Binning + objective interaction
    if (p.bin > 1 && (p.obj === '60_140' || p.obj === '100_145')) {
      warnings.push('Binning ' + p.bin + '×' + p.bin + ' on a high-NA objective sacrifices the resolution you paid for. Only use binning if SNR is the bottleneck.');
    }

    // PFS
    if (p.pfs === 'off') {
      issues.push('PFS off for an 8-hour live-cell experiment is risky — focus will drift. Turn PFS on unless you have a specific reason not to (e.g. PFS interferes with your fluorophore).');
    }

    // Total light budget = power × exp × frames (relative)
    const budget = (p.power / 10) * (p.exp / 200) * frames;
    if (budget > 600) {
      issues.push('Total light budget ' + budget.toFixed(0) + ' (relative) is high — cells likely won\'t survive 8 hours. Drop power or extend the interval.');
    } else if (budget > 300) {
      warnings.push('Total light budget ' + budget.toFixed(0) + ' is moderate; expect some bleaching by frame 96 and possibly slowed migration.');
    }

    // Interval
    if (p.interval > 15) {
      warnings.push('Interval ' + p.interval + ' min may miss fast migration events; tighten to 5–10 min if migration speed is the readout.');
    }

    // Verdict + sign-off
    const v = document.getElementById('pl-verdict');
    v.classList.remove('is-warning', 'is-critical');
    let html;
    if (issues.length) {
      v.classList.add('is-critical');
      html = '<strong>Plan not approvable yet:</strong><ul style="margin:6px 0 0 18px;">' +
             issues.map(i => '<li>' + i + '</li>').join('') + '</ul>';
      if (warnings.length) html += '<div style="margin-top:8px;font-size:13px;color:#475569;">Also worth fixing: ' + warnings.join(' ') + '</div>';
    } else if (warnings.length) {
      v.classList.add('is-warning');
      html = '<strong>Plan approvable with notes:</strong><ul style="margin:6px 0 0 18px;">' +
             warnings.map(wn => '<li>' + wn + '</li>').join('') + '</ul>';
    } else {
      html = '<strong>Plan approved.</strong> Internally consistent. Print and pin it.';
    }
    v.innerHTML = html;

    const ss = document.getElementById('pl-signoff');
    if (!p.obj && p.exp === 200 && p.power === 10) {
      ss.style.display = 'none';
      return;
    }
    ss.style.display = '';
    const om = objMeta[p.obj];
    document.getElementById('pls-obj').textContent     = om ? (om.mag + '× / NA ' + om.NA + ' ' + om.imm) : '—';
    document.getElementById('pls-expbin').textContent  = p.exp + ' ms / ' + p.bin + '×' + p.bin + ' binning';
    document.getElementById('pls-power').textContent   = p.power + '%';
    document.getElementById('pls-pfs').textContent     = p.pfs === 'on' ? 'on' : 'off';
    document.getElementById('pls-int').textContent     = p.interval + ' min  /  ' + frames + ' frames';
    document.getElementById('pls-budget').textContent  = budget.toFixed(0) + ' (relative)';
    document.getElementById('pls-date').textContent    = new Date().toISOString().slice(0, 10);
    const passEl = document.getElementById('pls-pass');
    const failEl = document.getElementById('pls-fail');
    if (issues.length) { passEl.style.display = 'none'; failEl.style.display = ''; }
    else { passEl.style.display = ''; failEl.style.display = 'none'; }
  }

  // ── Wiring ────────────────────────────────────────────────────────

  function wireTabs() {
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.addEventListener('click', () => setActiveTab(b.dataset.tab));
    });
  }

  function wireLightPath() {
    document.querySelectorAll('#tab-lightpath .lp-btn').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('#tab-lightpath .lp-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        state.lightpath.cube = b.dataset.cube;
        drawLightPath();
      });
    });
  }

  function wireCubeTab() {
    document.getElementById('cube-fluor').addEventListener('change', (e) => {
      state.cube.fluor = e.target.value;
      drawCubePanel();
    });
    document.getElementById('cube-pick').addEventListener('change', (e) => {
      state.cube.cube = e.target.value;
      drawCubePanel();
    });
  }

  function wireSourcesTab() {
    document.querySelectorAll('#tab-sources .src-btn').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('#tab-sources .src-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        state.source.kind = b.dataset.source;
        drawSource();
      });
    });
    document.getElementById('src-power').addEventListener('input', (e) => {
      state.source.power = parseInt(e.target.value, 10);
      drawSource();
    });
    document.getElementById('src-frames').addEventListener('input', (e) => {
      state.source.frames = parseInt(e.target.value, 10);
      drawSource();
    });
  }

  function wireFramesTab() {
    document.querySelectorAll('#tab-frames .frame-btn').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('#tab-frames .frame-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        state.frame.which = b.dataset.frame;
        drawFramePanel();
      });
    });
  }

  function wirePlanTab() {
    document.getElementById('pl-obj').addEventListener('change', (e) => {
      state.plan.obj = e.target.value;
      drawPlan();
    });
    document.getElementById('pl-exp').addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      if (!Number.isNaN(v)) state.plan.exp = v;
      drawPlan();
    });
    document.getElementById('pl-bin').addEventListener('change', (e) => {
      state.plan.bin = parseInt(e.target.value, 10);
      drawPlan();
    });
    document.getElementById('pl-pfs').addEventListener('change', (e) => {
      state.plan.pfs = e.target.value;
      drawPlan();
    });
    document.getElementById('pl-power').addEventListener('input', (e) => {
      state.plan.power = parseInt(e.target.value, 10);
      drawPlan();
    });
    document.getElementById('pl-interval').addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      if (!Number.isNaN(v)) state.plan.interval = v;
      drawPlan();
    });
  }

  function wireResize() {
    let timer = null;
    const h = () => { clearTimeout(timer); timer = setTimeout(redrawActiveTab, 120); };
    window.addEventListener('resize', h);
    window.addEventListener('orientationchange', h);
  }

  function init() {
    wireTabs();
    wireLightPath();
    wireCubeTab();
    wireSourcesTab();
    wireFramesTab();
    wirePlanTab();
    wireResize();
    drawLightPath();
    drawCubePanel();
    drawSource();
    drawFramePanel();
    drawPlan();
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) {
      firebridge.whenAuthResolved().then(init).catch(init);
    } else {
      init();
    }
  });
})();

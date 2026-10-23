/* training-image-train.js — V3.167 interactive notebook.
 *
 * Five tabs covering the optical components between the sample and the
 * camera and how to choose the right objective:
 *   1. Light path — clickable scope schematic with per-component facts
 *   2. Decoder — paste an objective marking, get a tokenized breakdown
 *   3. Aberrations — coverslip / immersion / depth scenarios with a
 *      correction-collar slider over a live PSF cross-section
 *   4. FOV & Pixel sampling — objective × tube × camera × λ → system mag,
 *      pixel size at sample, Nyquist target, FOV box
 *   5. Capstone — objective shortlist generator with a printable request
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

  // ── Reference data ────────────────────────────────────────────────

  const COMPONENTS = {
    sample: {
      name: 'Sample (+ mounting medium)',
      default: 'Aqueous mount n≈1.33 for live; fluoromount n≈1.50 for fixed',
      mistake: 'Mismatched mounting medium index → spherical aberration with depth',
      fix: 'Use a mounting medium whose n matches your immersion (water lens + aqueous; oil lens + fluoromount).',
    },
    coverslip: {
      name: 'Coverslip',
      default: '#1.5 (170 μm) — worldwide standard, what objectives are designed for',
      mistake: '#1 (~150 μm) silently degrades the PSF — symptom is axial blur',
      fix: 'Buy #1.5 (or #1.5H for ±5 μm thickness tolerance) and use it for every imaging experiment.',
    },
    immersion: {
      name: 'Immersion medium',
      default: 'Matches the objective design: air, water (n=1.33), glycerol (n=1.47), oil (n=1.515)',
      mistake: 'Using an oil lens dry, or grabbing the wrong bottle (water in an oil lens)',
      fix: 'Read the objective marking; oil = "Oil"; water = "W" or "WI"; air = no marking.',
    },
    objective: {
      name: 'Objective',
      default: 'Determines NA, magnification, chromatic correction, WD',
      mistake: 'Using a 60× oil for a 100 μm spheroid (WD 130 μm — can\'t reach the equator)',
      fix: 'Match objective to sample geometry; use Tab 4 to check FOV + Nyquist; use Tab 5 to choose.',
    },
    tubelens: {
      name: 'Tube lens',
      default: '200 mm (Nikon) — sets the actual system magnification with the objective',
      mistake: 'Confusing the nominal "60×" with the actual mag on a non-Nikon scope (180 mm tube → 54×)',
      fix: 'When mixing brands, recalculate: M_sys = M_obj × f_tube / f_design (Tab 4 does this for you).',
    },
    cube: {
      name: 'Filter cube',
      default: 'Excitation + dichroic + emission, matched to a fluorophore',
      mistake: 'Wrong cube in the path → dim or no signal (see V3.165 epi-fluorescence training)',
      fix: 'Confirm cube label matches your fluorophore before opening the shutter.',
    },
    port: {
      name: 'Camera / eyepiece port',
      default: 'Camera = quantitative + recordable; eyepiece = quick visual',
      mistake: 'Leaving the port routed to eyepieces during a camera acquisition — black images',
      fix: 'On the Ti2-U, NIS auto-routes the port; on the Ti-e, throw the side-port lever manually.',
    },
  };

  const FOV_OBJ = {
    '20_075': { mag: 20, NA: 0.75, design: 200 },
    '25_110': { mag: 25, NA: 1.1,  design: 200 },
    '40_130': { mag: 40, NA: 1.3,  design: 200 },
    '60_140': { mag: 60, NA: 1.4,  design: 200 },
  };

  const FOV_CAM = {
    fusion_bt: { name: 'Hamamatsu Fusion BT', w: 2304, h: 2304, pxUm: 6.5 },
    prime_95b: { name: 'Photometrics Prime 95B', w: 1200, h: 1200, pxUm: 11 },
    zyla_42:   { name: 'Andor Zyla 4.2', w: 2048, h: 2048, pxUm: 6.5 },
  };

  // Lab objective catalog for Tab 5 capstone scoring
  const CATALOG = [
    { name: '4× / 0.13 Plan Achr air',       mag: 4,  NA: 0.13, wd: 17.0,  imm: 'air',   chrom: 'achr',  cost: 1 },
    { name: '10× / 0.30 Plan Fluor air',     mag: 10, NA: 0.30, wd: 16.0,  imm: 'air',   chrom: 'fluor', cost: 1 },
    { name: '20× / 0.75 Plan Apo air',       mag: 20, NA: 0.75, wd: 1.0,   imm: 'air',   chrom: 'apo',   cost: 2 },
    { name: '25× / 1.1 CFI Apo LWD water',   mag: 25, NA: 1.1,  wd: 2.0,   imm: 'water', chrom: 'apo',   cost: 3 },
    { name: '40× / 1.3 Plan Fluor oil',      mag: 40, NA: 1.3,  wd: 0.20,  imm: 'oil',   chrom: 'fluor', cost: 2 },
    { name: '40× / 1.3 Plan Apo oil',        mag: 40, NA: 1.3,  wd: 0.20,  imm: 'oil',   chrom: 'apo',   cost: 3 },
    { name: '60× / 1.4 Plan Apo λ oil',      mag: 60, NA: 1.4,  wd: 0.13,  imm: 'oil',   chrom: 'apo',   cost: 3 },
    { name: '100× / 1.45 Plan Apo TIRF oil', mag: 100, NA: 1.45, wd: 0.13, imm: 'oil',   chrom: 'apo',   cost: 3 },
  ];

  // ── State ─────────────────────────────────────────────────────────
  const state = {
    train:      { comp: 'sample' },
    decoder:    { spec: 'Plan Apo λ 60× / 1.40 Oil ∞ / 0.17 WD 0.13' },
    aberration: { scenario: 'design', collar: 0, depth: 0 },
    fov:        { obj: '25_110', tube: 200, camera: 'fusion_bt', lambda: 510, bin: 1 },
    purchase:   { minNA: 1.0, minWD: 0.5, allowAir: false, allowWater: true, allowOil: false, chrom: 'fluor' },
  };

  let activeTab = 'tab-train';

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
    if      (activeTab === 'tab-train')      drawTrain();
    else if (activeTab === 'tab-decoder')    drawDecoder();
    else if (activeTab === 'tab-aberration') drawAberration();
    else if (activeTab === 'tab-fov')        drawFOV();
    else if (activeTab === 'tab-purchase')   drawPurchase();
  }

  // ── TAB 1 — Light path ────────────────────────────────────────────

  // Layout positions for each component, used for both rendering and click hit-tests
  function trainLayout(w, h) {
    return {
      sample:    { x: w * 0.5, y: h * 0.93, ww: 110, hh: 18, label: 'sample' },
      coverslip: { x: w * 0.5, y: h * 0.85, ww: 110, hh: 8,  label: '#1.5 coverslip' },
      immersion: { x: w * 0.5, y: h * 0.77, ww: 80,  hh: 12, label: 'immersion' },
      objective: { x: w * 0.5, y: h * 0.65, ww: 100, hh: 36, label: 'objective' },
      cube:      { x: w * 0.5, y: h * 0.45, ww: 92,  hh: 56, label: 'filter cube' },
      tubelens:  { x: w * 0.5, y: h * 0.25, ww: 100, hh: 22, label: 'tube lens (200 mm)' },
      port:      { x: w * 0.5, y: h * 0.10, ww: 110, hh: 28, label: 'camera / eyepiece' },
    };
  }

  function drawTrain() {
    const c = COMPONENTS[state.train.comp];
    document.getElementById('comp-name').textContent    = c.name;
    document.getElementById('comp-default').textContent = c.default;
    document.getElementById('comp-mistake').textContent = c.mistake;
    document.getElementById('comp-fix').textContent     = c.fix;
    document.getElementById('comp-verdict').innerHTML   = '<strong>' + c.name + '.</strong> ' + c.default;

    const cw = getCanvasCtx('canvas-train');
    if (!cw) return;
    const { ctx, w, h } = cw;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    const L = trainLayout(w, h);

    // Vertical connecting line through center
    ctx.strokeStyle = '#cbd5e1';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(w / 2, h * 0.06);
    ctx.lineTo(w / 2, h * 0.95);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw each component
    Object.keys(L).forEach(key => {
      const L0 = L[key];
      const active = state.train.comp === key;
      const fillColors = {
        sample:    '#fef3c7',
        coverslip: '#dbeafe',
        immersion: '#cffafe',
        objective: '#fed7aa',
        cube:      '#e0e7ff',
        tubelens:  '#f3f4f6',
        port:      '#fde68a',
      };
      ctx.fillStyle = fillColors[key];
      ctx.fillRect(L0.x - L0.ww / 2, L0.y - L0.hh / 2, L0.ww, L0.hh);
      ctx.strokeStyle = active ? '#2563eb' : '#475569';
      ctx.lineWidth = active ? 3 : 1.5;
      ctx.strokeRect(L0.x - L0.ww / 2, L0.y - L0.hh / 2, L0.ww, L0.hh);
      ctx.fillStyle = '#1f2937';
      ctx.font = active ? 'bold 12px -apple-system, sans-serif' : '11px -apple-system, sans-serif';
      ctx.fillText(L0.label, L0.x - ctx.measureText(L0.label).width / 2, L0.y + 4);
    });

    // Dichroic inside the cube
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 2;
    const cb = L.cube;
    ctx.beginPath();
    ctx.moveTo(cb.x - cb.ww / 2, cb.y - cb.hh / 2);
    ctx.lineTo(cb.x + cb.ww / 2, cb.y + cb.hh / 2);
    ctx.stroke();

    // Excitation ray from side
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cb.x - cb.ww / 2 - 60, cb.y);
    ctx.lineTo(cb.x - cb.ww / 2, cb.y);
    ctx.stroke();
    ctx.fillStyle = '#16a34a';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.fillText('illumination →', cb.x - cb.ww / 2 - 95, cb.y - 6);

    // Emission ray up
    ctx.strokeStyle = '#16a34a';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(cb.x, cb.y);
    ctx.lineTo(cb.x, L.tubelens.y + L.tubelens.hh / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Highlight label for active comp
    ctx.fillStyle = '#2563eb';
    ctx.font = 'bold 11px -apple-system, sans-serif';
    ctx.fillText('● ' + L[state.train.comp].label + ' (selected)', 12, h - 8);
  }

  // ── TAB 2 — Decoder ───────────────────────────────────────────────

  function parseObjective(s) {
    if (!s) return null;
    const out = {
      tokens: [],
      flat: null, chrom: null, uvir: null,
      mag: null, na: null, imm: null,
      tube: null, cs: null, wd: null,
    };
    // Field flatness
    if (/\bplan\b/i.test(s))           { out.flat = 'Plan (flat field)'; out.tokens.push({ t: 'Plan', kind: 'flat', desc: 'flat field across full FOV' }); }
    else                                { out.flat = 'not specified (curved field)'; }

    // Chromatic correction
    if (/\bapo\b/i.test(s))            { out.chrom = 'Apochromat (4+ colors)'; out.tokens.push({ t: 'Apo', kind: 'chrom', desc: 'apochromat — 4+ color chromatic correction' }); }
    else if (/\bfluor\b/i.test(s))     { out.chrom = 'Fluorite (3 colors)'; out.tokens.push({ t: 'Fluor', kind: 'chrom', desc: 'fluorite — 3-color chromatic correction' }); }
    else if (/\bachr/i.test(s))        { out.chrom = 'Achromat (2 colors)'; out.tokens.push({ t: 'Achromat', kind: 'chrom', desc: 'achromat — 2-color chromatic correction' }); }
    else                                { out.chrom = 'not specified'; }

    // UV/IR transmission marker
    if (/\bλ\b/.test(s) || /\bLambda\b/i.test(s) || /\bλ\b/.test(s)) {
      out.uvir = 'extended UV/IR'; out.tokens.push({ t: 'λ', kind: 'uvir', desc: 'extended UV/IR transmission' });
    } else {
      out.uvir = 'visible only';
    }

    // Magnification
    const mMag = s.match(/(\d+(?:\.\d+)?)\s*[x×]/i);
    if (mMag) { out.mag = parseFloat(mMag[1]); out.tokens.push({ t: mMag[0], kind: 'mag', desc: 'magnification' }); }

    // NA — first decimal not adjacent to "x"
    const mNA = s.match(/\/\s*(\d+\.\d+)/);
    if (mNA) { out.na = parseFloat(mNA[1]); out.tokens.push({ t: mNA[1], kind: 'na', desc: 'numerical aperture' }); }

    // Immersion
    if (/\boil\b/i.test(s))           { out.imm = 'oil (n=1.515)'; out.tokens.push({ t: 'Oil', kind: 'imm', desc: 'oil immersion' }); }
    else if (/\bwater\b/i.test(s) || /\bWI\b/.test(s)) { out.imm = 'water (n=1.33)'; out.tokens.push({ t: 'Water', kind: 'imm', desc: 'water immersion' }); }
    else if (/\bgly/i.test(s))         { out.imm = 'glycerol (n=1.47)'; out.tokens.push({ t: 'Gly', kind: 'imm', desc: 'glycerol immersion' }); }
    else                                { out.imm = 'air'; out.tokens.push({ t: 'Air', kind: 'imm', desc: 'no immersion (air gap)' }); }

    // Tube lens convention
    if (/[∞]/.test(s) || /\binfinity\b/i.test(s)) {
      out.tube = 'infinity-corrected (needs tube lens)'; out.tokens.push({ t: '∞', kind: 'tube', desc: 'infinity-corrected (modern)' });
    } else {
      out.tube = 'finite (no tube lens)';
    }

    // Coverslip thickness (mm)
    const csM = s.match(/\/\s*0\.(\d{2,3})/g);
    // The pattern "/ 0.17" appears twice in a typical spec (NA and CS).
    // Use last numeric-only "/ 0.NN" not adjacent to immersion as the coverslip.
    const allSlash = [...s.matchAll(/\/\s*(0\.\d{2,3})/g)].map(m => parseFloat(m[1]));
    if (allSlash.length >= 2) { out.cs = allSlash[1]; out.tokens.push({ t: allSlash[1].toFixed(2), kind: 'cs', desc: 'designed coverslip thickness (mm)' }); }
    else                       { out.cs = null; }

    // Working distance
    const wdM = s.match(/WD\s*(\d+(?:\.\d+)?)/i);
    if (wdM) { out.wd = parseFloat(wdM[1]); out.tokens.push({ t: 'WD ' + wdM[1], kind: 'wd', desc: 'working distance (mm)' }); }

    return out;
  }

  function drawDecoder() {
    const parsed = parseObjective(state.decoder.spec);
    document.getElementById('dec-flat').textContent  = parsed.flat;
    document.getElementById('dec-chrom').textContent = parsed.chrom;
    document.getElementById('dec-uvir').textContent  = parsed.uvir;
    document.getElementById('dec-mag').textContent   = parsed.mag != null ? parsed.mag + '×' : '—';
    document.getElementById('dec-na').textContent    = parsed.na != null ? parsed.na.toFixed(2) : '—';
    document.getElementById('dec-imm').textContent   = parsed.imm;
    document.getElementById('dec-tube').textContent  = parsed.tube;
    document.getElementById('dec-cs').textContent    = parsed.cs != null ? parsed.cs.toFixed(2) + ' mm (' + (parsed.cs > 0.16 ? '#1.5' : '#1') + ')' : 'not specified';
    document.getElementById('dec-wd').textContent    = parsed.wd != null ? parsed.wd + ' mm (' + (parsed.wd * 1000).toFixed(0) + ' μm)' : '—';

    const v = document.getElementById('dec-verdict');
    v.classList.remove('is-warning', 'is-critical');
    const warnings = [];
    if (parsed.cs != null && parsed.cs < 0.16) warnings.push('This is a #1 coverslip design (' + parsed.cs.toFixed(2) + ' mm). Most lab samples mount on #1.5 (0.17 mm) — verify before using.');
    if (parsed.na != null && parsed.na > 1.0 && parsed.imm === 'air') warnings.push('NA ' + parsed.na + ' with air immersion is borderline impossible — double-check the marking.');
    if (warnings.length) {
      v.classList.add('is-warning');
      v.innerHTML = '<strong>Decoded with warnings:</strong> ' + warnings.join(' ');
    } else {
      v.innerHTML = '<strong>' + (parsed.flat || '') + ' ' + (parsed.chrom || '') + ' ' + (parsed.mag || '') + '× / ' +
                    (parsed.na != null ? parsed.na.toFixed(2) : '?') + ' ' + (parsed.imm || '') + '.</strong> ' +
                    'Use Tab 4 to see if this lens meets Nyquist on your camera; use Tab 5 to compare against the lab catalog.';
    }

    // Render tokens
    const cw = getCanvasCtx('canvas-decoder');
    if (!cw) return;
    const { ctx, w, h } = cw;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    const tokenColors = {
      flat: '#2563eb', chrom: '#16a34a', uvir: '#a855f7',
      mag: '#dc2626', na: '#ea580c', imm: '#0891b2',
      tube: '#7c3aed', cs: '#0369a1', wd: '#65a30d',
    };
    let x = 12, y = 30;
    ctx.font = 'bold 14px -apple-system, sans-serif';
    parsed.tokens.forEach(tok => {
      const tw = ctx.measureText(tok.t).width + 14;
      if (x + tw > w - 12) { x = 12; y += 50; }
      ctx.fillStyle = tokenColors[tok.kind] || '#475569';
      ctx.fillRect(x, y - 18, tw, 26);
      ctx.fillStyle = '#fff';
      ctx.fillText(tok.t, x + 7, y);
      ctx.fillStyle = '#475569';
      ctx.font = '10px -apple-system, sans-serif';
      ctx.fillText(tok.desc, x, y + 22);
      ctx.font = 'bold 14px -apple-system, sans-serif';
      x += tw + 14;
    });
    if (!parsed.tokens.length) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '13px -apple-system, sans-serif';
      ctx.fillText('No recognizable tokens in this marking.', 12, 30);
    }
  }

  // ── TAB 3 — Aberration ────────────────────────────────────────────

  function drawAberration() {
    const a = state.aberration;
    document.getElementById('ab-collar-out').textContent = a.collar;
    document.getElementById('ab-depth-out').textContent  = a.depth;

    let scenarioLabel, baseSpherical, collarHelps;
    if (a.scenario === 'design') {
      scenarioLabel = 'Design conditions';
      baseSpherical = 0;
      collarHelps = false;
    } else if (a.scenario === 'cs1') {
      scenarioLabel = '#1 coverslip on #1.5-designed objective';
      baseSpherical = 0.6;
      collarHelps = true;
    } else if (a.scenario === 'deep') {
      scenarioLabel = 'Oil objective deep into aqueous sample';
      baseSpherical = Math.min(1.0, a.depth / 80);
      collarHelps = false;       // collar can\'t fix immersion mismatch
    } else if (a.scenario === 'glycerol') {
      scenarioLabel = 'Water objective + glycerol mount';
      baseSpherical = 0.55;
      collarHelps = true;
    }

    // Spherical aberration after collar correction (units: arbitrary)
    let finalSpherical = baseSpherical;
    if (collarHelps) {
      // Collar offset linearly reduces spherical aberration; full cancellation possible
      const correction = Math.abs(a.collar) / 40;     // 1.0 at ±40
      finalSpherical = Math.max(0, baseSpherical - correction * baseSpherical);
      // Over-correction symmetrically swings to the opposite sign
      if (Math.abs(a.collar) > 40) {
        const overshoot = (Math.abs(a.collar) - 40) / 50;
        finalSpherical = overshoot * 0.6;
      }
    }

    document.getElementById('ab-scenario').textContent  = scenarioLabel;
    document.getElementById('ab-spherical').textContent = baseSpherical.toFixed(2) + ' (raw)';
    document.getElementById('ab-recover').textContent   = collarHelps ? 'yes (rotate collar)' : 'no (mismatch is in the immersion, not the coverslip)';
    let symLabel;
    if (finalSpherical < 0.05) symLabel = 'symmetric (corrected)';
    else if (finalSpherical < 0.2) symLabel = 'slight asymmetry';
    else if (finalSpherical < 0.5) symLabel = 'visible skew';
    else symLabel = 'severe skew';
    document.getElementById('ab-sym').textContent = symLabel + ' (' + finalSpherical.toFixed(2) + ')';

    const v = document.getElementById('ab-verdict');
    v.classList.remove('is-warning', 'is-critical');
    if (a.scenario === 'design') {
      v.innerHTML = '<strong>Design conditions.</strong> Everything matches the objective\'s design assumptions — no aberration. This is your baseline.';
    } else if (a.scenario === 'deep' || a.scenario === 'glycerol') {
      v.classList.add('is-critical');
      v.innerHTML = '<strong>Immersion mismatch — no collar fix.</strong> The aberration grows with depth and the correction collar can\'t cancel it. The only real fix is to use an objective whose immersion matches your sample\'s mounting medium.';
    } else if (finalSpherical < 0.1) {
      v.innerHTML = '<strong>Recovered.</strong> The collar has cancelled most of the spherical aberration introduced by the wrong coverslip. The PSF below should look symmetric — that\'s your visual confirmation.';
    } else if (Math.abs(a.collar) > 40 && a.scenario === 'cs1') {
      v.classList.add('is-warning');
      v.innerHTML = '<strong>Over-corrected.</strong> You\'ve pushed the collar past the optimal point — aberration has flipped sign. Back off until the PSF is symmetric again.';
    } else {
      v.classList.add('is-warning');
      v.innerHTML = '<strong>Partially corrected.</strong> Keep adjusting the collar. The PSF skew below shows how far you still have to go.';
    }

    // Canvas: XZ PSF cross-section with aberration warping
    const cw = getCanvasCtx('canvas-psf');
    if (!cw) return;
    const { ctx, w, h } = cw;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    const cx = w / 2, cy = h / 2;
    const sigmaX = 16, sigmaZ = 32;
    const skew = finalSpherical * 22 * Math.sign(a.collar !== 0 ? a.collar : 1);

    const img = ctx.getImageData(0, 0, w, h);
    const data = img.data;
    for (let y = 0; y < h; y++) {
      const zCorrected = y - cy - skew * Math.cos(((y - cy) / sigmaZ) * 0.5);
      for (let x = 0; x < w; x++) {
        const xx = x - cx;
        const I = Math.exp(-(xx * xx) / (2 * sigmaX * sigmaX)) *
                  Math.exp(-(zCorrected * zCorrected) / (2 * sigmaZ * sigmaZ));
        const v = Math.min(1, I);
        const g = Math.floor(v * 230);
        const idx = (y * w + x) * 4;
        data[idx]     = Math.floor(g * 0.5);
        data[idx + 1] = g;
        data[idx + 2] = Math.floor(g * 0.6);
        data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.fillText('XZ cross-section of a single bead', 10, 18);
    ctx.fillText('← X →', cx - 14, h - 6);
  }

  // ── TAB 4 — FOV & Pixel sampling ──────────────────────────────────

  function drawFOV() {
    const f = state.fov;
    const obj = FOV_OBJ[f.obj];
    const cam = FOV_CAM[f.camera];
    const Mdesign = obj.design;
    const Msys = obj.mag * (f.tube / Mdesign);
    const pxSensorUm = cam.pxUm * f.bin;
    const pxSampleUm = pxSensorUm / Msys;
    const nyquistUm = (f.lambda / (4 * obj.NA)) / 1000;
    const fovWidthUm  = (cam.w * cam.pxUm) / Msys;
    const fovHeightUm = (cam.h * cam.pxUm) / Msys;

    document.getElementById('fov-sysmag').textContent   = Msys.toFixed(1) + '×';
    document.getElementById('fov-pxsample').textContent = pxSampleUm.toFixed(3) + ' μm';
    document.getElementById('fov-nyquist').textContent  = nyquistUm.toFixed(3) + ' μm';
    document.getElementById('fov-fov').textContent      = fovWidthUm.toFixed(0) + ' × ' + fovHeightUm.toFixed(0) + ' μm';

    let status, kind, text;
    if (pxSampleUm > nyquistUm * 1.3) {
      status = 'under-sampled';
      kind = 'is-critical';
      text = '<strong>Under-sampled.</strong> Pixel size at sample ' + pxSampleUm.toFixed(3) + ' μm is well above Nyquist target ' + nyquistUm.toFixed(3) + ' μm. High-frequency detail will be aliased — points blur into pixel grid artifacts. Drop binning, switch to a smaller-pixel camera, or use a higher-mag objective.';
    } else if (pxSampleUm > nyquistUm) {
      status = 'borderline';
      kind = 'is-warning';
      text = '<strong>Borderline.</strong> Pixel size ' + pxSampleUm.toFixed(3) + ' μm slightly exceeds Nyquist (' + nyquistUm.toFixed(3) + ' μm). Fine for a quick check; tighten for the publication figure.';
    } else if (pxSampleUm < nyquistUm * 0.4) {
      status = 'over-sampled';
      kind = 'is-warning';
      text = '<strong>Over-sampled.</strong> You\'re acquiring more pixels than the optics support — bigger files, slower reads, no new information. Enable 2' + ICON.svg('x-mark') + '2 binning to cut file size in half.';
    } else {
      status = 'at Nyquist';
      kind = '';
      text = '<strong>At Nyquist.</strong> Pixel size ' + pxSampleUm.toFixed(3) + ' μm vs target ' + nyquistUm.toFixed(3) + ' μm. Good for both viewing and deconvolution.';
    }
    document.getElementById('fov-status').textContent = status;
    const v = document.getElementById('fov-verdict');
    v.classList.remove('is-warning', 'is-critical');
    if (kind) v.classList.add(kind);
    v.innerHTML = text;

    // Canvas: FOV box with one bead drawn to scale
    const cw = getCanvasCtx('canvas-fov');
    if (!cw) return;
    const { ctx, w, h } = cw;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    // Pick a scale so FOV occupies ~70% of canvas
    const margin = 30;
    const aspect = fovWidthUm / fovHeightUm;
    let drawW, drawH;
    if ((w - 2 * margin) / aspect <= (h - 2 * margin)) {
      drawW = w - 2 * margin;
      drawH = drawW / aspect;
    } else {
      drawH = h - 2 * margin;
      drawW = drawH * aspect;
    }
    const x0 = (w - drawW) / 2, y0 = (h - drawH) / 2;
    ctx.fillStyle = '#f1f5f9';
    ctx.fillRect(x0, y0, drawW, drawH);
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 2;
    ctx.strokeRect(x0, y0, drawW, drawH);
    // FOV size label
    ctx.fillStyle = '#1f2937';
    ctx.font = 'bold 12px -apple-system, sans-serif';
    ctx.fillText(fovWidthUm.toFixed(0) + ' × ' + fovHeightUm.toFixed(0) + ' μm', x0 + 8, y0 + 16);
    // Pixel sample size box (zoomed)
    const pxScale = drawW / fovWidthUm;
    const pxBoxPx = pxSampleUm * pxScale * 8;
    ctx.fillStyle = '#fde68a';
    ctx.fillRect(x0 + drawW / 2 - pxBoxPx / 2, y0 + drawH / 2 - pxBoxPx / 2, pxBoxPx, pxBoxPx);
    ctx.strokeStyle = '#ca8a04';
    ctx.strokeRect(x0 + drawW / 2 - pxBoxPx / 2, y0 + drawH / 2 - pxBoxPx / 2, pxBoxPx, pxBoxPx);
    ctx.fillStyle = '#854d0e';
    ctx.font = '10px -apple-system, sans-serif';
    ctx.fillText('8 × 8 pixels', x0 + drawW / 2 - pxBoxPx / 2, y0 + drawH / 2 - pxBoxPx / 2 - 4);
    // Bead at Airy radius (for the chosen NA / λ)
    const airyUm = (1.22 * f.lambda / (2 * obj.NA)) / 1000;
    const beadPx = Math.max(2, airyUm * pxScale);
    const bx = x0 + drawW * 0.75, by = y0 + drawH / 2;
    const g = ctx.createRadialGradient(bx, by, 0, bx, by, beadPx);
    g.addColorStop(0,    'rgba(220, 38, 38, 1)');
    g.addColorStop(1,    'rgba(220, 38, 38, 0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(bx, by, beadPx * 1.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#dc2626';
    ctx.font = '10px -apple-system, sans-serif';
    ctx.fillText('one Airy disk (' + (airyUm * 1000).toFixed(0) + ' nm) to scale', bx - 60, by - beadPx - 6);
    // Camera name label
    ctx.fillStyle = '#475569';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.fillText(cam.name + ' · ' + cam.w + '×' + cam.h + ' · ' + cam.pxUm + ' μm pixels · ' + f.bin + '×' + f.bin + ' binning', 10, h - 8);
  }

  // ── TAB 5 — Purchase capstone ─────────────────────────────────────

  function drawPurchase() {
    const p = state.purchase;
    document.getElementById('bu-na-out').textContent = p.minNA.toFixed(2);
    document.getElementById('bu-wd-out').textContent = p.minWD.toFixed(2);

    const allowed = [];
    if (p.allowAir)   allowed.push('air');
    if (p.allowWater) allowed.push('water');
    if (p.allowOil)   allowed.push('oil');
    const chromOK = (chr) => {
      if (p.chrom === 'achr')  return true;
      if (p.chrom === 'fluor') return chr !== 'achr';
      if (p.chrom === 'apo')   return chr === 'apo';
      return true;
    };

    // Score each catalog entry
    const candidates = CATALOG.map(c => {
      const meets = (c.NA >= p.minNA) && (c.wd >= p.minWD) &&
                    allowed.indexOf(c.imm) >= 0 && chromOK(c.chrom);
      // Aberration risk for the project scenario: oil into aqueous-50μm
      let aberration = 0;
      if (c.imm === 'oil')   aberration = 1.0;
      else if (c.imm === 'water') aberration = 0.05;
      else                    aberration = 0.4;
      const score = meets ? (c.NA * 100) - aberration * 60 - c.cost * 5 : -1;
      return { ...c, meets, aberration, score };
    });
    const matched = candidates.filter(c => c.meets).sort((a, b) => b.score - a.score);

    const v = document.getElementById('bu-verdict');
    const ss = document.getElementById('bu-signoff');
    v.classList.remove('is-warning', 'is-critical');
    if (matched.length === 0) {
      v.classList.add('is-critical');
      v.innerHTML = '<strong>No candidates meet your spec.</strong> Loosen one of the constraints (lower NA, shorter WD, allow a different immersion, or accept Fluor-level chromatic correction).';
      ss.style.display = 'none';
      return;
    }

    // Verdict
    const top = matched[0];
    v.innerHTML = '<strong>' + matched.length + ' candidate' + (matched.length > 1 ? 's' : '') + ' meet the spec.</strong> ' +
                  'Top pick: <strong>' + top.name + '</strong> — NA ' + top.NA.toFixed(2) + ', WD ' + top.wd + ' mm, ' +
                  top.imm + ' immersion. ' +
                  (top.imm === 'water' ? 'Water immersion is ideal for the 50 μm-deep aqueous spheroid in this scenario.' :
                   top.imm === 'oil'   ? 'Oil immersion gives the highest NA but be aware: imaging 50 μm into an aqueous sample with this lens will produce visible spherical aberration (see Tab 3).' :
                   'Air immersion is comfortable but caps NA at ~0.95.');

    ss.style.display = '';
    document.getElementById('bu-date').textContent = new Date().toISOString().slice(0, 10);
    const tab = document.getElementById('bu-table');
    tab.innerHTML = '';
    matched.slice(0, 5).forEach((c, i) => {
      const row = document.createElement('div');
      row.className = 'signoff-row';
      row.innerHTML = '<span class="label">' + (i === 0 ? '★ ' : '   ') + c.name + '</span>' +
                      '<span class="value">NA ' + c.NA.toFixed(2) + ' · WD ' + c.wd + ' mm · cost ' + '$'.repeat(c.cost) + '</span>';
      tab.appendChild(row);
    });
    if (matched.length > 5) {
      const more = document.createElement('div');
      more.className = 'signoff-row';
      more.innerHTML = '<span class="label">(' + (matched.length - 5) + ' more matches not shown)</span><span class="value"></span>';
      tab.appendChild(more);
    }
  }

  // ── Wiring ────────────────────────────────────────────────────────

  function wireTabs() {
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.addEventListener('click', () => setActiveTab(b.dataset.tab));
    });
  }

  function wireTrainTab() {
    document.querySelectorAll('#tab-train .comp-btn').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('#tab-train .comp-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        state.train.comp = b.dataset.comp;
        drawTrain();
      });
    });
  }

  function wireDecoderTab() {
    const inp = document.getElementById('obj-spec');
    inp.addEventListener('input', (e) => { state.decoder.spec = e.target.value; drawDecoder(); });
    document.querySelectorAll('#tab-decoder .obj-preset').forEach(b => {
      b.addEventListener('click', () => {
        state.decoder.spec = b.dataset.spec;
        inp.value = b.dataset.spec;
        drawDecoder();
      });
    });
  }

  function wireAberrationTab() {
    document.querySelectorAll('#tab-aberration .ab-btn').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('#tab-aberration .ab-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        state.aberration.scenario = b.dataset.ab;
        drawAberration();
      });
    });
    document.getElementById('ab-collar').addEventListener('input', (e) => {
      state.aberration.collar = parseInt(e.target.value, 10);
      drawAberration();
    });
    document.getElementById('ab-depth').addEventListener('input', (e) => {
      state.aberration.depth = parseInt(e.target.value, 10);
      drawAberration();
    });
  }

  function wireFovTab() {
    document.getElementById('fov-obj').addEventListener('change', (e) => { state.fov.obj = e.target.value; drawFOV(); });
    document.getElementById('fov-tube').addEventListener('change', (e) => { state.fov.tube = parseInt(e.target.value, 10); drawFOV(); });
    document.getElementById('fov-camera').addEventListener('change', (e) => { state.fov.camera = e.target.value; drawFOV(); });
    document.getElementById('fov-lambda').addEventListener('change', (e) => { state.fov.lambda = parseInt(e.target.value, 10); drawFOV(); });
    document.getElementById('fov-bin').addEventListener('change', (e) => { state.fov.bin = parseInt(e.target.value, 10); drawFOV(); });
  }

  function wirePurchaseTab() {
    document.getElementById('bu-na').addEventListener('input', (e) => { state.purchase.minNA = parseFloat(e.target.value); drawPurchase(); });
    document.getElementById('bu-wd').addEventListener('input', (e) => { state.purchase.minWD = parseFloat(e.target.value); drawPurchase(); });
    document.getElementById('bu-imm-air').addEventListener('change',   (e) => { state.purchase.allowAir   = e.target.checked; drawPurchase(); });
    document.getElementById('bu-imm-water').addEventListener('change', (e) => { state.purchase.allowWater = e.target.checked; drawPurchase(); });
    document.getElementById('bu-imm-oil').addEventListener('change',   (e) => { state.purchase.allowOil   = e.target.checked; drawPurchase(); });
    document.getElementById('bu-budget').addEventListener('change', (e) => { state.purchase.chrom = e.target.value; drawPurchase(); });
  }

  function wireResize() {
    let timer = null;
    const h = () => { clearTimeout(timer); timer = setTimeout(redrawActiveTab, 120); };
    window.addEventListener('resize', h);
    window.addEventListener('orientationchange', h);
  }

  function init() {
    wireTabs();
    wireTrainTab();
    wireDecoderTab();
    wireAberrationTab();
    wireFovTab();
    wirePurchaseTab();
    wireResize();
    drawTrain();
    drawDecoder();
    drawAberration();
    drawFOV();
    drawPurchase();
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (typeof firebridge !== 'undefined' && firebridge.requireSignIn) {
      firebridge.requireSignIn('Sign in to track your training progress.').then(init).catch(init);
    } else {
      init();
    }
  });
})();

/* training-confocal.js — V3.166 interactive notebook for the Nikon AX-R.
 *
 * Six tabs:
 *   1. Pinhole — widefield vs confocal side-by-side, AU slider, section thickness
 *   2. Scan modes — galvo vs resonant, averaging slider, SNR + time
 *   3. Lasers & detectors — fluorophore checkboxes, emission spectra canvas, crosstalk
 *   4. Z-stacks — objective × wavelength × depth × sampling → Nyquist Δz + slice count
 *   5. Photobleaching — power × dwell × N → exponential decay + viability
 *   6. Session worksheet — printable AX-R session plan with internal-consistency check
 *
 * Reuses the shared interactive-notebook CSS + canvas helper conventions
 * established by V3.164. No Firestore reads/writes; state is component-local.
 *
 * Prerequisite (per V3.164 plan + saved memory): the student should have
 * completed V3.164 microscope basics + had its capstone signed off before
 * working through this module.
 */
(function () {
  'use strict';

  // ── Generic canvas helper (DPR-aware, container-sized) ────────────
  function getCanvasCtx(id) {
    const c = document.getElementById(id);
    if (!c) return null;
    const dpr = window.devicePixelRatio || 1;
    const rect = c.getBoundingClientRect();
    const cssW = rect.width  > 4 ? rect.width  : (parseFloat(c.getAttribute('width'))  || 600);
    const cssH = rect.height > 4 ? rect.height : (parseFloat(c.getAttribute('height')) || 260);
    c.width  = Math.round(cssW * dpr);
    c.height = Math.round(cssH * dpr);
    c.style.width  = cssW + 'px';
    c.style.height = cssH + 'px';
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { c, ctx, w: cssW, h: cssH };
  }

  // Deterministic-seed PRNG for reproducible "sample" rendering.
  function makeRng(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  // ── Module state ──────────────────────────────────────────────────
  const state = {
    pinhole: { au: 1.0 },
    scan:    { mode: 'galvo', N: 1 },
    lasers:  { dapi: true, gfp: true, mch: true, af647: true, acq: 'seq' },
    zstack:  { obj: '25_110', lambda: 510, depth_um: 20, samp: 1 },
    bleach:  { laser: 10, dwell: 2.0, frames: 80 },
    session: { scan: '', pinhole: '', acq: '', dz_nm: 200, dose: 30 },
  };

  let activeTab = 'tab-pinhole';

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
    if      (activeTab === 'tab-pinhole') drawPinhole();
    else if (activeTab === 'tab-scan')    drawScan();
    else if (activeTab === 'tab-lasers')  drawLasers();
    else if (activeTab === 'tab-zstack')  drawZStack();
    else if (activeTab === 'tab-bleach')  drawBleach();
    else if (activeTab === 'tab-session') drawSession();
  }

  // ── TAB 1 — Pinhole ───────────────────────────────────────────────
  // Render a synthetic 3-D spheroid section to two canvases. The
  // "widefield" canvas always blurs in z-projection; the "confocal"
  // canvas mixes between a clean section (pinhole≈1AU) and the widefield
  // look as the pinhole opens.

  function drawSpheroidView(canvasId, blendFactor /* 0=confocal, 1=widefield */, signalScale) {
    const cw = getCanvasCtx(canvasId);
    if (!cw) return;
    const { ctx, w, h } = cw;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    // Reproducible cell positions on a "slab" of a spheroid.
    const rng = makeRng(20240511);
    const cx = w / 2, cy = h / 2;
    const sphR = Math.min(w, h) * 0.42;
    const dots = [];
    for (let i = 0; i < 110; i++) {
      const u = rng() * 2 - 1, v = rng() * 2 - 1, z = rng() * 2 - 1;
      const r = Math.sqrt(u * u + v * v + z * z);
      if (r > 1) { i--; continue; }
      dots.push({ x: u * sphR + cx, y: v * sphR + cy, z });
    }

    // In-focus dots are |z| < focusBand (proportional to pinhole/AU but
    // not literally); out-of-focus dots smear and dim.
    const inFocusBand = 0.18 + 0.05 * blendFactor; // widens slightly with bigger pinhole
    dots.forEach(d => {
      const focusDist = Math.abs(d.z);
      let alpha, blur;
      if (focusDist < inFocusBand) {
        alpha = 0.95 * signalScale;
        blur = 4;
      } else {
        // Out-of-focus contribution scales with how "widefield" we are
        const oof = (focusDist - inFocusBand);
        alpha = 0.85 * blendFactor * Math.exp(-oof * 1.8) * signalScale;
        blur = 4 + oof * 16 * (0.5 + blendFactor);
      }
      if (alpha < 0.03) return;
      const g = ctx.createRadialGradient(d.x, d.y, 0, d.x, d.y, blur * 1.4);
      g.addColorStop(0,    'rgba(40, 220, 80,'  + alpha           + ')');
      g.addColorStop(0.7,  'rgba(40, 220, 80,'  + (alpha * 0.35) + ')');
      g.addColorStop(1,    'rgba(40, 220, 80, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(d.x, d.y, blur * 1.4, 0, Math.PI * 2);
      ctx.fill();
    });

    // Scale bar
    ctx.fillStyle = '#fff';
    ctx.fillRect(12, h - 18, 60, 3);
    ctx.font = '11px -apple-system, sans-serif';
    ctx.fillText('20 μm', 12, h - 22);
  }

  function drawPinhole() {
    const au = state.pinhole.au;
    document.getElementById('ph-au-out').textContent = au.toFixed(1);

    // Section thickness — fold formula in for au at λ_em=510, NA=1.1, n=1.33
    const lam = 510, NA = 1.1, n = 1.33;
    const optR = 0.88 * lam / (n - Math.sqrt(Math.max(0.0001, n * n - NA * NA)));
    const pinR = Math.SQRT2 * n * (au * 1.22 * lam / NA) / NA; // crude scaling
    const sectionNm = Math.sqrt(optR * optR + pinR * pinR);
    const sectionUm = sectionNm / 1000;
    document.getElementById('ph-thick').textContent = sectionUm.toFixed(2) + ' μm';

    // Signal scales roughly with pinhole area (au²) but capped at 1.0 (1 AU = "100%")
    const signal = Math.min(1.3, au * au);
    document.getElementById('ph-signal').textContent = signal.toFixed(2) + ' ×';

    // Rejection: 1 - blend factor (qualitative)
    let blend, rejection, kind, status, text;
    if (au < 0.7) {
      blend = 0.05; rejection = 'excellent';
      status = 'Thin section, low signal';
      kind = 'is-warning';
      text = '<strong>Sub-Airy pinhole.</strong> Optical section is thin, but you have discarded most of the photons. Only useful on very bright samples.';
    } else if (au <= 1.3) {
      blend = 0.1 + (au - 0.7) * 0.1; rejection = 'good';
      status = 'Balanced (recommended)';
      kind = '';
      text = '<strong>~1 AU — the canonical setting.</strong> Good optical sectioning, signal not crippled. Use this unless you have a specific reason to deviate.';
    } else if (au <= 3) {
      blend = 0.2 + (au - 1.3) * 0.18; rejection = 'reduced';
      status = 'Thicker section, more signal';
      kind = 'is-warning';
      text = '<strong>Open pinhole.</strong> More signal at the cost of axial resolution — useful for dim live samples but cells will appear "thicker" and out-of-focus structure will start to creep in.';
    } else {
      blend = Math.min(0.95, 0.5 + (au - 3) * 0.15); rejection = 'minimal';
      status = '≈ widefield';
      kind = 'is-critical';
      text = '<strong>Effectively widefield.</strong> You have opened the pinhole so far that the confocal advantage is gone. Either close the pinhole or switch scopes.';
    }
    document.getElementById('ph-rejection').textContent = rejection;
    document.getElementById('ph-status').textContent = status;

    const v = document.getElementById('ph-verdict');
    v.classList.remove('is-warning', 'is-critical');
    if (kind) v.classList.add(kind);
    v.innerHTML = text;

    drawSpheroidView('canvas-widefield', 1.0, 1.0);
    drawSpheroidView('canvas-confocal', blend, Math.min(1.0, signal));
  }

  // ── TAB 2 — Scan modes ────────────────────────────────────────────

  function drawScan() {
    const mode = state.scan.mode;
    const N = state.scan.N;

    // Per-pixel dwell time (rough): galvo ≈ 4 μs, resonant ≈ 0.2 μs
    const dwell = mode === 'galvo' ? 4.0 : 0.2;
    // Time per averaged frame at 1024×1024: galvo ~4 s/frame, resonant ~0.033 s/frame
    const baseFrameSec = mode === 'galvo' ? 4.0 : 0.033;
    const timeSec = baseFrameSec * N;
    // SNR relative to single galvo frame: galvo N=1 → 1.0
    // Resonant per-frame SNR ≈ 0.25 of galvo (proportional to √dwell ratio); averaging gives √N
    const snrPerFrame = mode === 'galvo' ? 1.0 : 0.32;
    const snrRel = snrPerFrame * Math.sqrt(N);
    // Bleach per averaged frame: per-pixel-exposure × N
    const bleachRel = (dwell / 4.0) * N;

    document.getElementById('scan-avg-out').textContent = N;
    document.getElementById('scan-mode').textContent = mode;
    document.getElementById('scan-dwell').textContent = dwell.toFixed(1) + ' μs/px';
    document.getElementById('scan-time').textContent  = timeSec.toFixed(2) + ' s';
    document.getElementById('scan-snr').textContent   = snrRel.toFixed(2) + ' ×';
    document.getElementById('scan-bleach').textContent = bleachRel.toFixed(2) + ' ×';

    // Verdict
    const v = document.getElementById('scan-verdict');
    v.classList.remove('is-warning', 'is-critical');
    let parts = [];
    if (mode === 'galvo' && N > 4) {
      v.classList.add('is-warning');
      parts.push('<strong>Galvo with N > 4 averaging.</strong> You\'re paying scan time twice — galvo is already slow. If you need this much SNR, the answer is usually a brighter sample or a more efficient detector, not more averaging.');
    } else if (mode === 'resonant' && N === 1) {
      v.classList.add('is-warning');
      parts.push('<strong>Single-frame resonant.</strong> Single resonant frames are noisy by design. Use this only when you genuinely want raw 30-fps video; otherwise average at least 4–8 frames.');
    } else if (mode === 'resonant' && N >= 16) {
      parts.push('<strong>Resonant with heavy averaging.</strong> Approaching galvo SNR while keeping a live preview during acquisition — the default lab setting for "looks clean, still live-friendly."');
    } else if (mode === 'galvo') {
      parts.push('<strong>Galvo</strong> at modest averaging — best fidelity per pixel. Use for fixed-cell quantitative work where time isn\'t the constraint.');
    } else {
      parts.push('<strong>Resonant N=' + N + '.</strong> SNR ' + snrRel.toFixed(2) + '×, time ' + timeSec.toFixed(2) + ' s/frame. Reasonable for live or fast Z-stacks.');
    }
    v.innerHTML = parts.join(' ');

    // Canvas: cell field with mode + averaging-dependent noise
    const cw = getCanvasCtx('canvas-scan');
    if (!cw) return;
    const { ctx, w, h } = cw;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    const rng = makeRng(1729);
    const cells = [];
    for (let i = 0; i < 9; i++) {
      cells.push({
        x: 80 + rng() * (w - 160),
        y: 50 + rng() * (h - 100),
        r: 22 + rng() * 14,
      });
    }
    // Per-pixel render with noise. Noise std proportional to 1/√(signal+dwell×N)
    const noiseAmp = 60 / Math.max(0.5, snrRel);
    const img = ctx.getImageData(0, 0, w, h);
    const data = img.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // True intensity field: sum of cells
        let I = 0;
        for (let i = 0; i < cells.length; i++) {
          const c = cells[i];
          const dx = x - c.x, dy = y - c.y;
          const r2 = dx * dx + dy * dy;
          if (r2 < c.r * c.r * 4) {
            I += 220 * Math.exp(-r2 / (c.r * c.r * 0.5));
          }
        }
        // Noise (box-Muller approximation: average two uniforms)
        const noise = (Math.random() + Math.random() + Math.random() - 1.5) * noiseAmp;
        const v = Math.max(0, Math.min(255, I + noise));
        const g = Math.floor(v);
        const idx = (y * w + x) * 4;
        data[idx]     = Math.floor(g * 0.5);
        data[idx + 1] = g;
        data[idx + 2] = Math.floor(g * 0.6);
        data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    // Mode label
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 13px -apple-system, sans-serif';
    ctx.fillText(mode.toUpperCase() + ' · N=' + N + ' · SNR ' + snrRel.toFixed(2) + '×', 12, 22);
  }

  // ── TAB 3 — Lasers & detectors ────────────────────────────────────

  // Each fluorophore: emission peak, gaussian σ for the curve, and the color
  const FLUOR = {
    dapi:  { peak: 460, sigma: 32, color: '#60a5fa', label: 'DAPI' },
    gfp:   { peak: 510, sigma: 28, color: '#22c55e', label: 'GFP / AF488' },
    mch:   { peak: 610, sigma: 38, color: '#f59e0b', label: 'mCherry' },
    af647: { peak: 670, sigma: 32, color: '#a3a3a3', label: 'AF647' },
  };

  function drawLasers() {
    const enabled = Object.keys(FLUOR).filter(k => state.lasers[k]);
    const acq = state.lasers.acq;

    // Crosstalk: for every pair of enabled fluorophores, compute the overlap
    // integral of their emission gaussians as a percentage.
    let worstPair = '—';
    let worstBleed = 0;
    for (let i = 0; i < enabled.length; i++) {
      for (let j = i + 1; j < enabled.length; j++) {
        const a = FLUOR[enabled[i]], b = FLUOR[enabled[j]];
        // Bhattacharyya-like overlap coefficient between two normalized gaussians.
        const sigma2 = (a.sigma * a.sigma + b.sigma * b.sigma) / 2;
        const overlap = Math.exp(-((a.peak - b.peak) * (a.peak - b.peak)) / (4 * sigma2)) *
                         Math.sqrt(2 * a.sigma * b.sigma / (a.sigma * a.sigma + b.sigma * b.sigma));
        const bleedPct = overlap * 100;
        if (bleedPct > worstBleed) {
          worstBleed = bleedPct;
          worstPair = a.label + ' ↔ ' + b.label;
        }
      }
    }
    // Sequential acquisition cuts crosstalk dramatically (~0.1× residual)
    const effectiveBleed = acq === 'seq' ? worstBleed * 0.1 : worstBleed;

    document.getElementById('ct-worst').textContent = enabled.length < 2 ? '—' : worstPair;
    document.getElementById('ct-bleed').textContent = effectiveBleed.toFixed(1) + '%';

    const status = document.getElementById('ct-status');
    const v = document.getElementById('laser-verdict');
    v.classList.remove('is-warning', 'is-critical');

    if (enabled.length === 0) {
      status.textContent = 'no fluorophores selected';
      v.innerHTML = 'Enable at least one fluorophore.';
    } else if (enabled.length === 1) {
      status.textContent = 'single channel';
      v.innerHTML = '<strong>Single fluorophore.</strong> No crosstalk possible.';
    } else if (effectiveBleed < 5) {
      status.textContent = 'safe';
      v.innerHTML = '<strong>Safe acquisition.</strong> Estimated bleed-through under 5%. ' +
                    (acq === 'seq' ? 'Sequential acquisition has neutralized most overlap.' : 'Spectral separation is sufficient even for simultaneous acquisition.');
    } else if (effectiveBleed < 15) {
      status.textContent = 'caution';
      v.classList.add('is-warning');
      v.innerHTML = '<strong>Marginal — ' + effectiveBleed.toFixed(1) + '% bleed-through.</strong> ' +
                    (acq === 'sim' ? 'Switch to sequential acquisition to drop this dramatically.' :
                                      'Even sequential, this pair is spectrally close. Tighten the detector collection windows.');
    } else {
      status.textContent = 'unsafe';
      v.classList.add('is-critical');
      v.innerHTML = '<strong>Significant crosstalk — ' + effectiveBleed.toFixed(1) + '% bleed-through.</strong> ' +
                    (acq === 'sim' ? 'Sequential acquisition is the first fix; if the pair is still bad, drop one fluorophore or replace it with a spectrally further-separated one.' :
                                      'Even sequential cannot fully resolve this pair. Reconsider the fluorophore choice.');
    }

    // ── Canvas: emission spectra ────────────────────────────────────
    const cw = getCanvasCtx('canvas-spectra');
    if (!cw) return;
    const { ctx, w, h } = cw;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    const padL = 36, padR = 12, padT = 12, padB = 28;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    // X axis range 380..720 nm
    const xMin = 380, xMax = 720;
    function nm2px(nm) { return padL + (nm - xMin) / (xMax - xMin) * plotW; }

    // Background bands for the AX-R lasers
    [[405, '#a78bfa22'], [488, '#34d39922'], [561, '#fbbf2422'], [640, '#ef444422']].forEach(([nm, color]) => {
      ctx.fillStyle = color;
      ctx.fillRect(nm2px(nm - 3), padT, nm2px(nm + 3) - nm2px(nm - 3), plotH);
    });

    // Axes
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, padT + plotH);
    ctx.lineTo(padL + plotW, padT + plotH);
    ctx.stroke();
    // X ticks
    ctx.fillStyle = '#475569';
    ctx.font = '11px -apple-system, sans-serif';
    [400, 450, 500, 550, 600, 650, 700].forEach(t => {
      const px = nm2px(t);
      ctx.beginPath(); ctx.moveTo(px, padT + plotH); ctx.lineTo(px, padT + plotH + 4); ctx.stroke();
      ctx.fillText(t + '', px - 10, padT + plotH + 16);
    });
    ctx.fillText('emission λ (nm)', padL + plotW / 2 - 40, h - 8);

    // Plot each enabled fluorophore as a gaussian
    enabled.forEach(k => {
      const f = FLUOR[k];
      ctx.strokeStyle = f.color;
      ctx.fillStyle   = f.color + '44';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i <= plotW; i++) {
        const nm = xMin + (i / plotW) * (xMax - xMin);
        const v = Math.exp(-((nm - f.peak) * (nm - f.peak)) / (2 * f.sigma * f.sigma));
        const px = padL + i;
        const py = padT + plotH - v * plotH;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      // Light fill
      ctx.lineTo(padL + plotW, padT + plotH);
      ctx.lineTo(padL, padT + plotH);
      ctx.closePath();
      ctx.fill();
      // Label at peak
      ctx.fillStyle = f.color;
      ctx.font = 'bold 11px -apple-system, sans-serif';
      ctx.fillText(f.label, nm2px(f.peak) - 18, padT + 10);
    });

    // Laser labels at the top
    ctx.fillStyle = '#64748b';
    ctx.font = '10px -apple-system, sans-serif';
    [405, 488, 561, 640].forEach(nm => {
      ctx.fillText(nm + ' nm laser', nm2px(nm) - 24, padT - 2);
    });
  }

  // ── TAB 4 — Z-stacks ──────────────────────────────────────────────

  const Z_OBJ = {
    '25_110': { mag: 25, NA: 1.1, n: 1.33, label: '25× / 1.1 water' },
    '40_130': { mag: 40, NA: 1.3, n: 1.515, label: '40× / 1.3 oil' },
    '60_140': { mag: 60, NA: 1.4, n: 1.515, label: '60× / 1.4 oil' },
  };

  function drawZStack() {
    const z = state.zstack;
    const obj = Z_OBJ[z.obj];
    const NA = obj.NA, n = obj.n;
    const nyquist_nm = z.lambda / (2 * NA * NA * n);
    // sampling multiplier (0.5 = 2× under, 1 = nyquist, 2 = 2× over)
    const samp = z.samp;
    const step_nm = nyquist_nm / samp;
    const slices = Math.max(1, Math.ceil(z.depth_um * 1000 / step_nm) + 1);
    // Naive timing: ~1 s/slice for typical AX-R resonant Z-stack with averaging
    const timeSec = slices * 1.0;
    // Naive file size: 2048×2048 × 16-bit × 4 channels per slice
    const bytes = slices * 2048 * 2048 * 2 * 4;
    const mb = bytes / (1024 * 1024);

    document.getElementById('z-nyquist').textContent = nyquist_nm.toFixed(0) + ' nm';
    document.getElementById('z-step').textContent    = step_nm.toFixed(0) + ' nm';
    document.getElementById('z-count').textContent   = slices + '';
    document.getElementById('z-time').textContent    = timeSec.toFixed(0) + ' s (~' + (timeSec / 60).toFixed(1) + ' min)';
    document.getElementById('z-size').textContent    = mb.toFixed(0) + ' MB';

    const v = document.getElementById('z-verdict');
    v.classList.remove('is-warning', 'is-critical');
    if (samp === 0.5) {
      v.classList.add('is-warning');
      v.innerHTML = '<strong>2× under-sampled.</strong> Fine for a survey Z-stack or a live-cell run where photon budget matters more than spatial precision. Do not use this for deconvolution or quantitative spatial analysis.';
    } else if (samp === 2) {
      v.classList.add('is-warning');
      v.innerHTML = '<strong>2× over-sampled.</strong> ' + slices + ' slices, ~' + (mb / 1024).toFixed(2) + ' GB. You are acquiring more pixels than the optics support — the extra Z-steps will not improve resolvability, only file size and bleach.';
    } else {
      v.innerHTML = '<strong>Nyquist-sampled.</strong> ' + slices + ' slices · ' + step_nm.toFixed(0) + ' nm step. This is the default for quantitative or deconvolved confocal volumes.';
    }

    // ── Canvas: XZ slice render showing the same bead under each sampling
    const cw = getCanvasCtx('canvas-zstack');
    if (!cw) return;
    const { ctx, w, h } = cw;
    ctx.fillStyle = '#fafafa';
    ctx.fillRect(0, 0, w, h);

    // Draw the "ground-truth" PSF shape on the left, then sampled slices as horizontal lines.
    const padL = 50, padR = 12, padT = 26, padB = 22;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    // PSF is an elongated gaussian in Z (FWHM ~ 1.0 μm at NA 1.1) and X.
    const psfZ_um = 1.0 * (1.1 * 1.1) / (NA * NA);   // fakey scaling — for visual only
    const fovZ_um = Math.max(2, 6 * psfZ_um);
    const fovX_um = Math.max(2, fovZ_um);            // square FOV
    function um2pxX(u) { return padL + (u + fovX_um / 2) / fovX_um * plotW; }
    function um2pxZ(u) { return padT + (u + fovZ_um / 2) / fovZ_um * plotH; }

    // PSF image: row-by-row gaussian
    const psfImg = ctx.getImageData(padL, padT, plotW, plotH);
    const data = psfImg.data;
    for (let py = 0; py < plotH; py++) {
      const zu = -fovZ_um / 2 + (py / plotH) * fovZ_um;
      for (let px = 0; px < plotW; px++) {
        const xu = -fovX_um / 2 + (px / plotW) * fovX_um;
        const I = Math.exp(-(zu * zu) / (2 * (psfZ_um / 2.355) * (psfZ_um / 2.355))) *
                  Math.exp(-(xu * xu) / (2 * (psfZ_um / 4.7) * (psfZ_um / 4.7)));
        const v = Math.min(1, I);
        const g = Math.floor(v * 230);
        const idx = (py * plotW + px) * 4;
        data[idx]     = Math.floor(g * 0.5);
        data[idx + 1] = g;
        data[idx + 2] = Math.floor(g * 0.6);
        data[idx + 3] = 255;
      }
    }
    ctx.putImageData(psfImg, padL, padT);

    // Sampled slices as horizontal dashed lines.
    const step_um = step_nm / 1000;
    ctx.strokeStyle = 'rgba(220,38,38,0.9)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    for (let z_um = -fovZ_um / 2; z_um <= fovZ_um / 2; z_um += step_um) {
      const y = um2pxZ(z_um);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Axes labels
    ctx.fillStyle = '#475569';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.fillText('XZ view of a single sub-resolution bead, red dashes = Z slices', 10, 18);
    ctx.fillText('X →', padL + plotW - 30, padT + plotH + 14);
    ctx.save();
    ctx.translate(14, padT + plotH / 2 + 4);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Z (focus)', 0, 0);
    ctx.restore();
  }

  // ── TAB 5 — Photobleaching ────────────────────────────────────────

  function drawBleach() {
    const b = state.bleach;
    document.getElementById('b-laser-out').textContent  = b.laser;
    document.getElementById('b-dwell-out').textContent  = b.dwell.toFixed(1);
    document.getElementById('b-frames-out').textContent = b.frames;

    // Dose model: relative dose per frame ∝ laser × dwell
    const dosePerFrame = (b.laser / 10) * (b.dwell / 2.0);
    // Bleach decay rate k tuned so that "normal" dose (laser=10, dwell=2) ≈ half-life 100 frames
    const k = 0.007 * dosePerFrame;
    const finalSignal = Math.exp(-k * b.frames);
    const halfLifeFrames = Math.log(2) / Math.max(1e-6, k);
    // Cumulative dose proxy
    const cumDose = dosePerFrame * b.frames;
    // Viability tiers (heuristic, calibrated to "rough lab feel")
    let viability, kind, text;
    if (cumDose < 12) {
      viability = 'good'; kind = '';
      text = '<strong>Survivable dose.</strong> Most live-cell experiments are fine here. Cumulative dose ~' + cumDose.toFixed(1) + ' (relative). Final signal ~' + (finalSignal * 100).toFixed(0) + '% of starting.';
    } else if (cumDose < 30) {
      viability = 'marginal'; kind = 'is-warning';
      text = '<strong>Marginal.</strong> Cells will visibly stress over the course of the experiment — slowed migration, occasional blebbing. Acceptable for a final-figure shot, risky for multi-hour time-lapse.';
    } else {
      viability = 'unsafe'; kind = 'is-critical';
      text = '<strong>Unsafe live-cell dose.</strong> Cumulative dose ~' + cumDose.toFixed(1) + '. Expect mitotic arrest, blebbing, retraction. Drop laser power, increase HV (detector gain), or accept fewer frames.';
    }

    document.getElementById('b-dose').textContent      = cumDose.toFixed(1);
    document.getElementById('b-signal').textContent    = (finalSignal * 100).toFixed(0) + '%';
    document.getElementById('b-half').textContent      = isFinite(halfLifeFrames) ? halfLifeFrames.toFixed(0) : '∞';
    document.getElementById('b-viability').textContent = viability;

    const v = document.getElementById('bleach-verdict');
    v.classList.remove('is-warning', 'is-critical');
    if (kind) v.classList.add(kind);
    v.innerHTML = text;

    // Canvas: bleach decay curve
    const cw = getCanvasCtx('canvas-bleach');
    if (!cw) return;
    const { ctx, w, h } = cw;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    const padL = 40, padR = 14, padT = 14, padB = 24;
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
    // 100% line
    ctx.strokeStyle = '#cbd5e1';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL + plotW, padT);
    ctx.stroke();
    ctx.setLineDash([]);
    // 50% line
    ctx.strokeStyle = '#e5e7eb';
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, padT + plotH / 2);
    ctx.lineTo(padL + plotW, padT + plotH / 2);
    ctx.stroke();
    ctx.setLineDash([]);
    // Decay
    ctx.strokeStyle = kind === 'is-critical' ? '#dc2626' : (kind === 'is-warning' ? '#d97706' : '#16a34a');
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let i = 0; i <= plotW; i++) {
      const frame = (i / plotW) * b.frames;
      const s = Math.exp(-k * frame);
      const py = padT + plotH - s * plotH;
      const px = padL + i;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
    // Labels
    ctx.fillStyle = '#475569';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.fillText('frame', padL + plotW / 2 - 16, h - 6);
    ctx.fillText('0', padL - 12, padT + plotH + 12);
    ctx.fillText(b.frames + '', padL + plotW - 12, padT + plotH + 12);
    ctx.save();
    ctx.translate(12, padT + plotH / 2 + 4);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('signal', 0, 0);
    ctx.restore();
    ctx.fillText('100%', padL - 30, padT + 4);
    ctx.fillText('50%',  padL - 26, padT + plotH / 2 + 4);
  }

  // ── TAB 6 — Session worksheet ─────────────────────────────────────

  function drawSession() {
    const s = state.session;
    document.getElementById('se-laser-out').textContent = s.dose;

    const issues = [];
    const warnings = [];

    if (!s.scan)    issues.push('Pick a scan mode.');
    if (!s.pinhole) issues.push('Pick a pinhole.');
    if (!s.acq)     issues.push('Pick an acquisition mode (sequential vs simultaneous).');

    // Sample is fixed → simultaneous is OK if spectra allow; the sample here
    // has DAPI + GFP + AF647 (no mCherry), so spectral separation is decent.
    // But the lab guidance is: DAPI sequentially. Flag simultaneous as warning.
    if (s.acq === 'sim') {
      warnings.push('Simultaneous acquisition with DAPI is rarely safe — the blue tail leaks into 488. Switch to sequential.');
    }

    // Pinhole sanity
    if (s.pinhole === '5.0') {
      issues.push('5 AU pinhole is effectively widefield — defeats the purpose of using a confocal.');
    } else if (s.pinhole === '0.5') {
      warnings.push('0.5 AU pinhole discards most of the signal; only use this if the sample is very bright.');
    }

    // Z step sanity (Nyquist for AX-R 25×/1.1 + GFP 510 ≈ 160 nm)
    if (s.dz_nm > 400) {
      issues.push('Z step ' + s.dz_nm + ' nm is well above Nyquist (~160 nm) — your 3-D rendering will be aliased.');
    } else if (s.dz_nm > 200) {
      warnings.push('Z step ' + s.dz_nm + ' nm under-samples Nyquist; fine for a survey, tighten for the final figure.');
    } else if (s.dz_nm < 80) {
      warnings.push('Z step ' + s.dz_nm + ' nm is well below Nyquist — no extra information, just more bleach + file size.');
    }

    // Scan mode + dose
    if (s.scan === 'galvo' && s.dose > 50) {
      warnings.push('Galvo + high dose — galvo already runs long exposures. Consider resonant with averaging to cut dose without losing SNR.');
    }
    if (s.dose > 70) {
      issues.push('Total laser dose ' + s.dose + ' is in the cell-killing range. Drop laser power, drop dwell, or drop frames.');
    } else if (s.dose > 40) {
      warnings.push('Laser dose ' + s.dose + ' is high — viability is marginal. Test on a sacrificial corner first.');
    }

    // Sequential + galvo + N=4 means slices × 4 channels × 4 averages — quickly painful
    if (s.scan === 'galvo' && s.acq === 'seq') {
      warnings.push('Galvo + sequential is the slowest combination. Make sure your sample is stable for the scan duration (no drift).');
    }

    const v = document.getElementById('se-verdict');
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
             warnings.map(w => '<li>' + w + '</li>').join('') + '</ul>';
    } else {
      html = '<strong>Plan approved.</strong> The choices are internally consistent. Print and bring to the AX-R.';
    }
    v.innerHTML = html;

    // Sign-off sheet
    const ss = document.getElementById('se-signoff');
    if (!s.scan && !s.pinhole && !s.acq) {
      ss.style.display = 'none';
      return;
    }
    ss.style.display = '';
    document.getElementById('ss2-scan').textContent    = s.scan || '—';
    document.getElementById('ss2-pinhole').textContent = s.pinhole ? s.pinhole + ' AU' : '—';
    document.getElementById('ss2-acq').textContent     = s.acq === 'seq' ? 'sequential' : (s.acq === 'sim' ? 'simultaneous' : '—');
    // Slice count: 100 μm spheroid / chosen Δz
    const slices = Math.max(1, Math.ceil(100000 / s.dz_nm) + 1);
    document.getElementById('ss2-dz').textContent      = s.dz_nm + ' nm  /  ~' + slices + ' slices over 100 μm';
    document.getElementById('ss2-dose').textContent    = s.dose + ' (relative)';
    document.getElementById('ss2-date').textContent    = new Date().toISOString().slice(0, 10);
    const passEl = document.getElementById('ss2-pass');
    const failEl = document.getElementById('ss2-fail');
    if (issues.length) {
      passEl.style.display = 'none';
      failEl.style.display = '';
    } else {
      passEl.style.display = '';
      failEl.style.display = 'none';
    }
  }

  // ── Wiring ────────────────────────────────────────────────────────

  function wireTabs() {
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.addEventListener('click', () => setActiveTab(b.dataset.tab));
    });
  }

  function wirePinholeTab() {
    document.getElementById('ph-au').addEventListener('input', (e) => {
      state.pinhole.au = parseFloat(e.target.value);
      drawPinhole();
    });
  }

  function wireScanTab() {
    document.querySelectorAll('#tab-scan .scan-btn').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('#tab-scan .scan-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        state.scan.mode = b.dataset.mode;
        drawScan();
      });
    });
    document.getElementById('scan-avg').addEventListener('input', (e) => {
      state.scan.N = parseInt(e.target.value, 10);
      drawScan();
    });
  }

  function wireLasersTab() {
    [['dye-dapi', 'dapi'], ['dye-gfp', 'gfp'], ['dye-mch', 'mch'], ['dye-af647', 'af647']].forEach(([id, key]) => {
      document.getElementById(id).addEventListener('change', (e) => {
        state.lasers[key] = e.target.checked;
        drawLasers();
      });
    });
    document.getElementById('acq-mode').addEventListener('change', (e) => {
      state.lasers.acq = e.target.value;
      drawLasers();
    });
  }

  function wireZStackTab() {
    document.getElementById('z-obj').addEventListener('change', (e) => {
      state.zstack.obj = e.target.value;
      drawZStack();
    });
    document.getElementById('z-lambda').addEventListener('change', (e) => {
      state.zstack.lambda = parseInt(e.target.value, 10);
      drawZStack();
    });
    document.getElementById('z-depth').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (!Number.isNaN(v)) state.zstack.depth_um = v;
      drawZStack();
    });
    document.querySelectorAll('input[name="z-samp"]').forEach(r => {
      r.addEventListener('change', (e) => {
        state.zstack.samp = parseFloat(e.target.value);
        drawZStack();
      });
    });
  }

  function wireBleachTab() {
    document.getElementById('b-laser').addEventListener('input', (e) => {
      state.bleach.laser = parseInt(e.target.value, 10);
      drawBleach();
    });
    document.getElementById('b-dwell').addEventListener('input', (e) => {
      state.bleach.dwell = parseFloat(e.target.value);
      drawBleach();
    });
    document.getElementById('b-frames').addEventListener('input', (e) => {
      state.bleach.frames = parseInt(e.target.value, 10);
      drawBleach();
    });
  }

  function wireSessionTab() {
    document.getElementById('se-scan').addEventListener('change', (e) => {
      state.session.scan = e.target.value;
      drawSession();
    });
    document.getElementById('se-pinhole').addEventListener('change', (e) => {
      state.session.pinhole = e.target.value;
      drawSession();
    });
    document.getElementById('se-acq').addEventListener('change', (e) => {
      state.session.acq = e.target.value;
      drawSession();
    });
    document.getElementById('se-dz').addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      if (!Number.isNaN(v)) state.session.dz_nm = v;
      drawSession();
    });
    document.getElementById('se-laser').addEventListener('input', (e) => {
      state.session.dose = parseInt(e.target.value, 10);
      drawSession();
    });
  }

  function wireResize() {
    let timer = null;
    const handler = () => {
      clearTimeout(timer);
      timer = setTimeout(redrawActiveTab, 120);
    };
    window.addEventListener('resize', handler);
    window.addEventListener('orientationchange', handler);
  }

  function init() {
    wireTabs();
    wirePinholeTab();
    wireScanTab();
    wireLasersTab();
    wireZStackTab();
    wireBleachTab();
    wireSessionTab();
    wireResize();
    // Warm-up draw for every tab so canvases have sane state before they
    // become visible.
    drawPinhole();
    drawScan();
    drawLasers();
    drawZStack();
    drawBleach();
    drawSession();
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) {
      firebridge.whenAuthResolved().then(init).catch(init);
    } else {
      init();
    }
  });
})();

/* training-microscope-basics.js — V3.164 interactive notebook.
 *
 * Five tabs:
 *   1. Resolution & diffraction limit — two-Airy-disk separation slider
 *   2. NA & objectives — objective scenarios × wavelength, light-cone
 *   3. Köhler illumination — four alignment scenarios, eyepiece preview
 *   4. Contrast mechanisms — four modalities, same cell field
 *   5. Capstone — sign-off worksheet that gates AX-R first-session access
 *
 * Self-contained — no external libraries beyond the firebridge auth
 * helper. Canvases are DPR-aware via getCanvasCtx(). State is component-
 * local; no Firestore reads/writes.
 *
 * Introduced V3.164. Per the saved project memory, this module is the
 * lab-mandated prerequisite for first-time AX-R confocal access.
 */
(function () {
  'use strict';

  // ── Generic canvas helper (DPR-aware, container-sized) ────────────

  function getCanvasCtx(id) {
    const c = document.getElementById(id);
    if (!c) return null;
    const dpr = window.devicePixelRatio || 1;
    const rect = c.getBoundingClientRect();
    // Fall back to the canvas width/height attribute when the element
    // is in a hidden tab (rect = 0).
    const cssW = rect.width  > 4 ? rect.width  : (parseFloat(c.getAttribute('width'))  || 600);
    const cssH = rect.height > 4 ? rect.height : (parseFloat(c.getAttribute('height')) || 280);
    c.width  = Math.round(cssW * dpr);
    c.height = Math.round(cssH * dpr);
    c.style.width  = cssW + 'px';
    c.style.height = cssH + 'px';
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { c, ctx, w: cssW, h: cssH };
  }

  // Bessel J1(x) / x — approximation good enough for Airy disk rendering.
  // Power series for small x, then asymptotic for large x.
  function j1OverX(x) {
    if (Math.abs(x) < 1e-6) return 0.5;
    if (Math.abs(x) < 8) {
      // Polynomial approximation (Abramowitz & Stegun 9.4.4)
      const x2 = x * x;
      const num = 0.5 - x2 * (0.56249985 - x2 * (0.21093573 - x2 * (0.03954289 - x2 * (0.00443319 - x2 * (0.00031761 - x2 * 0.00001109)))));
      return num;
    }
    const ax = Math.abs(x);
    const z = 8 / ax;
    const z2 = z * z;
    const p = 1 + z2 * (0.00183105 - z2 * (0.00003516 + z2 * 0.00002457));
    const q = 0.04687499 - z2 * (0.00228770 + z2 * 0.00010604);
    const xx = ax - 2.35619449;
    return Math.sqrt(0.6366198 / ax) * (Math.cos(xx) * p - z * Math.sin(xx) * q) * Math.sign(x) / x;
  }

  // Airy intensity profile in 1D (radius in nm), normalized to peak 1.
  // Pattern scale parameter: peak at r=0, first zero at r ≈ 1.22 λ / (2·NA).
  function airyIntensity(r_nm, lambda_nm, NA) {
    // k = π · NA / λ in nm^-1; argument is 2 · k · r
    const arg = 2 * Math.PI * NA * r_nm / lambda_nm;
    const t = 2 * j1OverX(arg);
    return t * t;
  }

  // ── Module state ──────────────────────────────────────────────────

  const state = {
    resolution: { sep_nm: 300, lambda: 510, NA: 1.4 },
    na:         { mag: 4, NA: 0.13, wd_mm: 17, imm: 'air', lambda: 510 },
    kohler:     { mode: 'ok' },
    contrast:   { mode: 'bf' },
    capstone:   {
      modality: '', objective: '',
      lasers: { '405': false, '488': false, '561': false, '640': false },
      pixel_um: 0.2,
    },
  };

  let activeTab = 'tab-resolution';

  // ── Tab dispatcher ────────────────────────────────────────────────

  function setActiveTab(tabId) {
    activeTab = tabId;
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tabId);
      b.setAttribute('aria-selected', b.dataset.tab === tabId ? 'true' : 'false');
    });
    document.querySelectorAll('.tab-content').forEach(t => {
      t.classList.toggle('active', t.id === tabId);
    });
    // Defer redraw so the now-visible canvas has real dimensions.
    requestAnimationFrame(redrawActiveTab);
  }

  function redrawActiveTab() {
    if (activeTab === 'tab-resolution') drawResolution();
    else if (activeTab === 'tab-na')        drawNAPanel();
    else if (activeTab === 'tab-kohler')    drawKohler();
    else if (activeTab === 'tab-contrast')  drawContrast();
    else if (activeTab === 'tab-capstone')  drawCapstone();
  }

  // ── TAB 1 — Resolution ────────────────────────────────────────────

  function drawResolution() {
    const sep = state.resolution.sep_nm;
    const lam = state.resolution.lambda;
    const NA  = state.resolution.NA;
    const d_abbe = lam / (2 * NA);

    // Readouts
    document.getElementById('res-sep-out').textContent = sep;
    document.getElementById('res-lambda').textContent  = lam + ' nm';
    document.getElementById('res-na').textContent      = NA.toFixed(2);
    document.getElementById('res-abbe').textContent    = d_abbe.toFixed(0) + ' nm';

    let status, kind, text;
    if (sep < d_abbe * 0.9) {
      status = 'Unresolved';
      kind = 'is-critical';
      text = '<strong>Unresolved.</strong> The two sources are closer than the Abbe limit — they appear as a single blob. No image processing can recover them.';
    } else if (sep < d_abbe * 1.25) {
      status = 'Just resolved';
      kind = 'is-warning';
      text = '<strong>Just resolved.</strong> You can see two peaks, but the dip between them is shallow. In real noisy data this would be ambiguous.';
    } else {
      status = 'Resolved';
      kind = '';
      text = '<strong>Resolved.</strong> The two peaks are cleanly separated. Confidently countable as two objects in segmentation.';
    }
    document.getElementById('res-status').textContent = status;
    const v = document.getElementById('res-verdict');
    v.classList.remove('is-critical', 'is-warning', 'is-bad');
    if (kind) v.classList.add(kind);
    v.innerHTML = text;

    // ── Airy disk render ────────────────────────────────────────────
    const cw = getCanvasCtx('canvas-airy');
    if (cw) {
      const { ctx, w, h } = cw;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      // Pixel scale: 1 px = pxNm nm. Choose so the canvas covers ~1500 nm.
      const fovNm = 1600;
      const pxNm = fovNm / w;
      const cy = h / 2;
      const cx1 = w / 2 - (sep / 2) / pxNm;
      const cx2 = w / 2 + (sep / 2) / pxNm;
      // Render the combined intensity field.
      const img = ctx.getImageData(0, 0, w, h);
      const data = img.data;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const r1 = Math.hypot((x - cx1) * pxNm, (y - cy) * pxNm);
          const r2 = Math.hypot((x - cx2) * pxNm, (y - cy) * pxNm);
          const I = airyIntensity(r1, lam, NA) + airyIntensity(r2, lam, NA);
          // Gamma-compress for display so the rings are visible.
          const v = Math.min(1, Math.pow(I, 0.55));
          const g = Math.floor(v * 220);
          const idx = (y * w + x) * 4;
          // Slight green tint for fluorescence look
          data[idx]     = Math.floor(g * 0.6);
          data[idx + 1] = g;
          data[idx + 2] = Math.floor(g * 0.6);
          data[idx + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      // Scale bar (200 nm)
      const sbLen = 200 / pxNm;
      ctx.fillStyle = '#fff';
      ctx.fillRect(12, h - 18, sbLen, 3);
      ctx.font = '11px -apple-system, sans-serif';
      ctx.fillText('200 nm', 12, h - 22);
    }

    // ── 1-D profile (sum across y) ──────────────────────────────────
    const cp = getCanvasCtx('canvas-airy-profile');
    if (cp) {
      const { ctx, w, h } = cp;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      // Axes
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 1;
      const padL = 30, padR = 10, padT = 8, padB = 24;
      const plotW = w - padL - padR;
      const plotH = h - padT - padB;
      ctx.beginPath();
      ctx.moveTo(padL, padT);
      ctx.lineTo(padL, padT + plotH);
      ctx.lineTo(padL + plotW, padT + plotH);
      ctx.stroke();
      // Compute profile
      const fovNm = 1600;
      const pxNm = fovNm / plotW;
      const cx1 = -sep / 2;
      const cx2 =  sep / 2;
      let maxI = 0;
      const pts = [];
      for (let x = 0; x < plotW; x++) {
        const r_nm = (x - plotW / 2) * pxNm;
        const I = airyIntensity(r_nm - cx1, lam, NA) + airyIntensity(r_nm - cx2, lam, NA);
        pts.push(I);
        if (I > maxI) maxI = I;
      }
      ctx.strokeStyle = '#16a34a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      pts.forEach((I, i) => {
        const px = padL + i;
        const py = padT + plotH - (I / Math.max(maxI, 1e-9)) * plotH;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.stroke();
      // X-axis label
      ctx.fillStyle = '#475569';
      ctx.font = '11px -apple-system, sans-serif';
      ctx.fillText('position (nm)', padL + plotW / 2 - 30, h - 6);
      ctx.save();
      ctx.translate(10, padT + plotH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText('intensity', -20, 0);
      ctx.restore();
      // Tick at zero
      const zx = padL + plotW / 2;
      ctx.strokeStyle = '#cbd5e1';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(zx, padT);
      ctx.lineTo(zx, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // ── TAB 2 — NA & Objectives ───────────────────────────────────────

  function drawNAPanel() {
    const s = state.na;
    const lam = s.lambda;
    const d = lam / (2 * s.NA);
    const n_index = { air: 1.0, water: 1.33, oil: 1.515 }[s.imm] || 1.0;
    const dof_um = (lam * n_index) / (s.NA * s.NA) / 1000;     // crude analytical DOF
    const lightRel = (s.NA * s.NA) / (1.4 * 1.4);              // relative to NA 1.4

    document.getElementById('na-mag').textContent   = s.mag + '×';
    document.getElementById('na-naval').textContent = s.NA.toFixed(2);
    document.getElementById('na-imm').textContent   = s.imm;
    document.getElementById('na-wd').textContent    = s.wd_mm + ' mm';
    document.getElementById('na-res').textContent   = d.toFixed(0) + ' nm';
    document.getElementById('na-dof').textContent   = dof_um.toFixed(2) + ' μm';
    document.getElementById('na-light').textContent = lightRel.toFixed(2) + ' ×';

    // Verdict
    const v = document.getElementById('na-verdict');
    v.classList.remove('is-warning', 'is-critical', 'is-bad');
    let parts = [];
    parts.push('<strong>' + s.mag + '× / NA ' + s.NA.toFixed(2) + ' ' + s.imm + '.</strong>');
    parts.push('At λ=' + lam + ' nm this resolves ~' + d.toFixed(0) + ' nm in XY.');
    if (s.NA >= 1.3) {
      parts.push('Excellent resolution, but WD ' + s.wd_mm + ' mm — you cannot reach deeper than a few hundred μm into a thick sample.');
    } else if (s.NA < 0.3) {
      parts.push('Very wide field, very long WD — great for slide overviews; do not expect to count nuclei.');
      v.classList.add('is-warning');
    } else if (s.imm === 'water' && s.NA > 1.0) {
      parts.push('The water-dipping sweet spot for the AX-R: high NA <em>and</em> 2 mm WD — reaches through whole spheroids without spherical aberration.');
    }
    v.innerHTML = parts.join(' ');

    // ── Light cone canvas ────────────────────────────────────────────
    const cw = getCanvasCtx('canvas-cone');
    if (cw) {
      const { ctx, w, h } = cw;
      ctx.clearRect(0, 0, w, h);
      // Sample plane at bottom; objective above. Half-angle θ = asin(NA/n)
      const theta = Math.asin(Math.min(0.99, s.NA / n_index));
      const sampleY = h - 40;
      const objY = 40;
      const objW = 100;
      const cx = w / 2;
      // Draw "sample"
      ctx.fillStyle = '#f1f5f9';
      ctx.fillRect(0, sampleY, w, h - sampleY);
      ctx.strokeStyle = '#94a3b8';
      ctx.beginPath(); ctx.moveTo(0, sampleY); ctx.lineTo(w, sampleY); ctx.stroke();
      ctx.fillStyle = '#475569';
      ctx.font = '11px -apple-system, sans-serif';
      ctx.fillText('sample plane (n = ' + n_index.toFixed(2) + ', ' + s.imm + ')', 10, sampleY + 20);
      // Draw objective front lens
      ctx.fillStyle = '#cbd5e1';
      ctx.fillRect(cx - objW / 2, objY - 20, objW, 24);
      ctx.fillStyle = '#1f2937';
      ctx.fillText(s.mag + '× / ' + s.NA.toFixed(2), cx - 26, objY - 5);
      // Light cone
      const focusX = cx;
      const focusY = sampleY;
      const apertureHalf = (sampleY - objY) * Math.tan(theta);
      ctx.fillStyle = 'rgba(37, 99, 235, 0.18)';
      ctx.beginPath();
      ctx.moveTo(focusX, focusY);
      ctx.lineTo(cx - apertureHalf, objY);
      ctx.lineTo(cx + apertureHalf, objY);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // Theta arc + label
      ctx.strokeStyle = '#dc2626';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(focusX, focusY, 38, -Math.PI / 2 - theta, -Math.PI / 2);
      ctx.stroke();
      ctx.fillStyle = '#dc2626';
      ctx.font = 'italic 13px -apple-system, sans-serif';
      ctx.fillText('θ = ' + (theta * 180 / Math.PI).toFixed(0) + '°', focusX + 14, focusY - 28);
      // WD label
      ctx.fillStyle = '#475569';
      ctx.font = '11px -apple-system, sans-serif';
      ctx.fillText('WD ≈ ' + s.wd_mm + ' mm (not to scale)', 10, h - 6);
      // NA equation
      ctx.fillStyle = '#1f2937';
      ctx.font = 'bold 12px -apple-system, sans-serif';
      ctx.fillText('NA = n · sin(θ) = ' + n_index.toFixed(2) + ' × ' + Math.sin(theta).toFixed(2) + ' = ' + s.NA.toFixed(2), w - 220, 18);
    }
  }

  // ── TAB 3 — Köhler illumination ───────────────────────────────────

  const KOHLER_TABLE = {
    ok: {
      field: 'just outside FOV',
      aperture: '~80% of BFP',
      lamp: 'defocused at sample',
      uniform: 'uniform',
      contrast: 'good',
      verdict: '<strong>Correct Köhler.</strong> Field is uniformly lit, contrast is good, no filament shadow. This is the baseline every transmitted-light session should start from.',
      kind: '',
    },
    field: {
      field: 'closed too far',
      aperture: '~80% of BFP',
      lamp: 'defocused at sample',
      uniform: 'vignette',
      contrast: 'good',
      verdict: '<strong>Field diaphragm too closed.</strong> You see a dark frame around the image. Open the field diaphragm until it just disappears from view.',
      kind: 'is-warning',
    },
    aperture: {
      field: 'just outside FOV',
      aperture: 'wide open',
      lamp: 'defocused at sample',
      uniform: 'uniform',
      contrast: 'low',
      verdict: '<strong>Aperture diaphragm too open.</strong> Resolution is technically maxed but contrast has collapsed — features wash out. Close to ~80% of the back focal plane.',
      kind: 'is-warning',
    },
    lamp: {
      field: 'just outside FOV',
      aperture: '~80% of BFP',
      lamp: 'focused at sample',
      uniform: 'filament visible',
      contrast: 'good',
      verdict: '<strong>Lamp focused on the sample.</strong> You see the filament shadow superimposed on the image. Adjust the lamp collector or, on the Ti2-U LED engines, swap in the diffuser.',
      kind: 'is-critical',
    },
  };

  function drawKohler() {
    const k = KOHLER_TABLE[state.kohler.mode] || KOHLER_TABLE.ok;
    document.getElementById('kohler-field').textContent     = k.field;
    document.getElementById('kohler-aperture').textContent  = k.aperture;
    document.getElementById('kohler-lamp').textContent      = k.lamp;
    document.getElementById('kohler-uniform').textContent   = k.uniform;
    document.getElementById('kohler-contrast').textContent  = k.contrast;
    const v = document.getElementById('kohler-verdict');
    v.classList.remove('is-warning', 'is-critical', 'is-bad');
    if (k.kind) v.classList.add(k.kind);
    v.innerHTML = k.verdict;

    const cw = getCanvasCtx('canvas-kohler');
    if (!cw) return;
    const { ctx, w, h } = cw;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    // Circular eyepiece field of view
    const cx = w / 2, cy = h / 2;
    const fovR = Math.min(w, h) / 2 - 10;
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, fovR, 0, Math.PI * 2); ctx.clip();

    // Base illumination — uniform vs vignette
    const baseGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, fovR);
    if (state.kohler.mode === 'field') {
      baseGrad.addColorStop(0,    '#fffef0');
      baseGrad.addColorStop(0.45, '#fffef0');
      baseGrad.addColorStop(0.55, '#1a1a1a');
      baseGrad.addColorStop(1,    '#0a0a0a');
    } else {
      baseGrad.addColorStop(0, '#fffef0');
      baseGrad.addColorStop(1, '#f0eed8');
    }
    ctx.fillStyle = baseGrad;
    ctx.fillRect(cx - fovR, cy - fovR, fovR * 2, fovR * 2);

    // Sample: a few simulated cells
    const cells = [
      [cx - 60, cy - 30, 32], [cx + 40, cy - 10, 28], [cx - 10, cy + 40, 26],
      [cx + 70, cy + 50, 22], [cx - 80, cy + 35, 20], [cx + 10, cy - 60, 24],
    ];
    // Contrast modulation
    let cellAlpha = 0.55;
    if (state.kohler.mode === 'aperture') cellAlpha = 0.15;
    cells.forEach(([x, y, r]) => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(60, 60, 80,' + (cellAlpha * 0.8) + ')');
      g.addColorStop(0.7, 'rgba(60, 60, 80,' + (cellAlpha * 0.4) + ')');
      g.addColorStop(1, 'rgba(60, 60, 80, 0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      // Nucleus
      ctx.fillStyle = 'rgba(40, 40, 70,' + (cellAlpha * 0.6) + ')';
      ctx.beginPath(); ctx.arc(x + r * 0.1, y - r * 0.1, r * 0.35, 0, Math.PI * 2); ctx.fill();
    });

    // Filament shadow (when lamp is focused at sample)
    if (state.kohler.mode === 'lamp') {
      ctx.strokeStyle = 'rgba(60, 40, 0, 0.55)';
      ctx.lineWidth = 4;
      // Coiled-tungsten-style figure-8 doubled
      for (let i = -2; i <= 2; i++) {
        ctx.beginPath();
        ctx.moveTo(cx - 60, cy + i * 16);
        ctx.bezierCurveTo(cx - 30, cy + i * 16 - 14, cx + 30, cy + i * 16 + 14, cx + 60, cy + i * 16);
        ctx.stroke();
      }
    }

    ctx.restore();
    // Outer FOV ring
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, fovR, 0, Math.PI * 2); ctx.stroke();
  }

  // ── TAB 4 — Contrast mechanisms ───────────────────────────────────

  const CONTRAST_TABLE = {
    bf: {
      sensitive: 'absorption',
      damage: 'minimal',
      spec: 'low (everything contributes)',
      setup: 'simple',
      scopes: 'all scopes',
      verdict: '<strong>Brightfield.</strong> Stained tissue sections light up; unstained live cells nearly disappear. The cheapest, gentlest modality — when it works, it works.',
    },
    phase: {
      sensitive: 'optical path-length differences',
      damage: 'minimal',
      spec: 'low',
      setup: 'phase ring in condenser + phase objective',
      scopes: 'Ti-e + Ti2-U',
      verdict: '<strong>Phase contrast.</strong> Live unstained cells become visible; characteristic halo around object edges (a well-known artifact). Ideal for long live-cell time-lapse where photodamage matters more than fine detail.',
    },
    dic: {
      sensitive: 'gradient of optical path length',
      damage: 'minimal',
      spec: 'low',
      setup: 'polarizer + Wollaston prisms + analyzer',
      scopes: 'Ti-e + Ti2-U',
      verdict: '<strong>DIC.</strong> Pseudo-3D look, no halos. Excellent for label-free morphology and thickness mapping. Fiddly to align; not compatible with plastic dishes.',
    },
    fluor: {
      sensitive: 'labeled molecules only',
      damage: 'significant (photobleach + phototox)',
      spec: 'very high',
      setup: 'filter cube matched to fluorophore',
      scopes: 'Ti-e, Ti2-U, AX-R',
      verdict: '<strong>Fluorescence.</strong> Only your labeled targets emit — high specificity, dark background, paper-figure ready. Costs you photons. Always ask "could phase / DIC answer this?" before committing to fluorescence on a live experiment.',
    },
  };

  function drawContrast() {
    const k = CONTRAST_TABLE[state.contrast.mode] || CONTRAST_TABLE.bf;
    document.getElementById('contrast-sensitive').textContent = k.sensitive;
    document.getElementById('contrast-damage').textContent    = k.damage;
    document.getElementById('contrast-spec').textContent      = k.spec;
    document.getElementById('contrast-setup').textContent     = k.setup;
    document.getElementById('contrast-scopes').textContent    = k.scopes;
    document.getElementById('contrast-verdict').innerHTML     = k.verdict;

    const cw = getCanvasCtx('canvas-contrast');
    if (!cw) return;
    const { ctx, w, h } = cw;
    const mode = state.contrast.mode;

    // Background per modality
    if (mode === 'fluor') {
      ctx.fillStyle = '#000';
    } else if (mode === 'phase') {
      ctx.fillStyle = '#d8d8d8';
    } else if (mode === 'dic') {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#b8b8b8'); g.addColorStop(1, '#909090');
      ctx.fillStyle = g;
    } else {
      ctx.fillStyle = '#f4ecd8';
    }
    ctx.fillRect(0, 0, w, h);

    // Deterministic cell layout
    const cells = [];
    let seed = 42;
    function r() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }
    for (let i = 0; i < 22; i++) {
      cells.push({
        x: 60 + r() * (w - 120),
        y: 50 + r() * (h - 100),
        rr: 16 + r() * 14,
        nuc: r() * 0.5 + 0.5,
      });
    }

    cells.forEach(c => {
      const { x, y, rr, nuc } = c;
      if (mode === 'bf') {
        // Faintly visible cytoplasm
        ctx.fillStyle = 'rgba(140, 110, 70, 0.18)';
        ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.fill();
        // Nucleus barely visible
        ctx.fillStyle = 'rgba(80, 60, 40, 0.22)';
        ctx.beginPath(); ctx.arc(x + 3, y - 3, rr * 0.4, 0, Math.PI * 2); ctx.fill();
      } else if (mode === 'phase') {
        // Halo + dark interior
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(x, y, rr + 1.5, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = 'rgba(60, 60, 60, 0.65)';
        ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.fill();
        // Nucleus
        ctx.fillStyle = 'rgba(30, 30, 30, 0.75)';
        ctx.beginPath(); ctx.arc(x + 2, y - 2, rr * 0.35, 0, Math.PI * 2); ctx.fill();
      } else if (mode === 'dic') {
        // Gradient shading: bright on top-left, dark on bottom-right
        const g = ctx.createRadialGradient(x - rr * 0.4, y - rr * 0.4, 2, x, y, rr);
        g.addColorStop(0,    'rgba(255, 255, 255, 0.9)');
        g.addColorStop(0.45, 'rgba(180, 180, 180, 0.4)');
        g.addColorStop(0.75, 'rgba(60, 60, 60, 0.65)');
        g.addColorStop(1,    'rgba(20, 20, 20, 0.9)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.fill();
      } else if (mode === 'fluor') {
        // Bright nucleus only (DAPI-style)
        const g = ctx.createRadialGradient(x, y, 0, x, y, rr * 0.7);
        g.addColorStop(0,    'rgba(180, 220, 255, ' + nuc + ')');
        g.addColorStop(0.6,  'rgba(80, 140, 230, ' + (nuc * 0.7) + ')');
        g.addColorStop(1,    'rgba(40, 80, 180, 0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, rr * 0.85, 0, Math.PI * 2); ctx.fill();
      }
    });

    // Modality label
    ctx.fillStyle = (mode === 'fluor') ? '#fff' : '#1f2937';
    ctx.font = 'bold 13px -apple-system, sans-serif';
    ctx.fillText({
      bf: 'BRIGHTFIELD', phase: 'PHASE CONTRAST',
      dic: 'DIC', fluor: 'FLUORESCENCE (DAPI)'
    }[mode] || '', 12, h - 14);
  }

  // ── TAB 5 — Capstone sign-off worksheet ───────────────────────────

  function drawCapstone() {
    const c = state.capstone;
    const verdict = document.getElementById('cap-verdict');
    const signoff = document.getElementById('cap-signoff');
    const issues = [];      // critical (block sign-off)
    const warnings = [];    // suboptimal but not blocking

    // Modality check ---------------------------------------------------
    if (!c.modality) {
      issues.push('Pick a modality.');
    } else if (c.modality === 'brightfield' || c.modality === 'phase') {
      issues.push('Brightfield / phase contrast cannot resolve a 3-color fluorescent stack — pick fluorescence.');
    } else if (c.modality === 'widefield') {
      warnings.push('Widefield will image the 200 μm spheroid but the out-of-focus blur from above and below the focal plane is severe — confocal is the right call for this experiment.');
    }

    // Objective check --------------------------------------------------
    const objMeta = {
      '4_013_air':    { mag: 4,  NA: 0.13, wd: 17,   imm: 'air',   note: 'Way too low NA for resolving subcellular detail.' },
      '20_075_air':   { mag: 20, NA: 0.75, wd: 1.0,  imm: 'air',   note: 'Decent overview but air objective + 200 μm thick aqueous sample → severe spherical aberration deep in the spheroid.' },
      '25_110_water': { mag: 25, NA: 1.1,  wd: 2.0,  imm: 'water', note: 'The AX-R sweet spot — high NA + 2 mm WD reaches the equator of a 200 μm spheroid.' },
      '40_130_oil':   { mag: 40, NA: 1.3,  wd: 0.20, imm: 'oil',   note: 'High NA but WD 200 μm — you cannot reach the equator of a 200 μm spheroid. Surface only.' },
      '60_140_oil':   { mag: 60, NA: 1.4,  wd: 0.13, imm: 'oil',   note: 'WD 130 μm physically cannot reach the equator of a 200 μm spheroid. Surface imaging only.' },
    };
    const obj = objMeta[c.objective];
    if (!c.objective) {
      issues.push('Pick an objective.');
    } else {
      if (c.objective === '4_013_air' || c.objective === '20_075_air') {
        issues.push(obj.note);
      } else if (c.objective === '40_130_oil' || c.objective === '60_140_oil') {
        warnings.push(obj.note);
      } // 25/1.1 water is the good answer; emit no warning
    }

    // Laser check ------------------------------------------------------
    const wantedLasers = ['405', '488', '640'];   // DAPI + Phalloidin-AF488 + AF647
    const missingLasers = wantedLasers.filter(L => !c.lasers[L]);
    const extraLasers = Object.keys(c.lasers).filter(L => c.lasers[L] && wantedLasers.indexOf(L) < 0);
    if (missingLasers.length) {
      issues.push('Missing required laser line' + (missingLasers.length > 1 ? 's' : '') + ': ' + missingLasers.join(' nm, ') + ' nm. The three labels are DAPI (405), Phalloidin-AF488 (488), and antibody-AF647 (640).');
    }
    if (extraLasers.length) {
      warnings.push('You have ' + extraLasers.join(' nm, ') + ' nm enabled but none of the three labels excite there. Disable to reduce photobleaching during scan.');
    }

    // Pixel sampling check --------------------------------------------
    // Nyquist target: λ/(4·NA) for the chosen objective + the shortest λ in the stack
    const lambda_min = c.lasers['405'] ? 450 : (c.lasers['488'] ? 510 : 670);
    let nyquist_um = 0.2;
    if (obj) {
      nyquist_um = (lambda_min / (4 * obj.NA)) / 1000;
    }
    document.getElementById('cap-nyquist').textContent = nyquist_um.toFixed(3) + ' μm';
    if (c.pixel_um > nyquist_um * 1.3) {
      issues.push('Pixel size ' + c.pixel_um.toFixed(3) + ' μm is well above the Nyquist target ' + nyquist_um.toFixed(3) + ' μm — high-frequency detail will be aliased. Increase zoom or change objective.');
    } else if (c.pixel_um > nyquist_um) {
      warnings.push('Pixel size ' + c.pixel_um.toFixed(3) + ' μm slightly exceeds Nyquist (' + nyquist_um.toFixed(3) + ' μm). Acceptable for a survey scan; tighten for the final figure.');
    } else if (c.pixel_um < nyquist_um * 0.4) {
      warnings.push('Pixel size much smaller than Nyquist — you\'re acquiring more pixels than the optics support. Larger files, longer scans, no extra information.');
    }

    // Compose verdict + sign-off --------------------------------------
    verdict.classList.remove('is-critical', 'is-warning', 'is-bad');
    let html = '';
    if (issues.length) {
      verdict.classList.add('is-critical');
      html = '<strong>Not approved yet — fix these:</strong><ul style="margin:6px 0 0 18px;">' +
             issues.map(i => '<li>' + i + '</li>').join('') + '</ul>';
      if (warnings.length) {
        html += '<div style="margin-top:8px;font-size:13px;color:#475569;">Also worth fixing: ' + warnings.join(' ') + '</div>';
      }
    } else if (warnings.length) {
      verdict.classList.add('is-warning');
      html = '<strong>Approvable with notes:</strong><ul style="margin:6px 0 0 18px;">' +
             warnings.map(w => '<li>' + w + '</li>').join('') + '</ul>' +
             '<div style="margin-top:8px;font-size:13px;">Sign-off below. The notes above are worth discussing with Alex but do not block approval.</div>';
    } else {
      html = '<strong>Configuration approved.</strong> Bring the printed sign-off sheet to your first AX-R session.';
    }
    verdict.innerHTML = html;

    // Sign-off sheet
    if (!c.modality && !c.objective) {
      signoff.style.display = 'none';
      return;
    }
    signoff.style.display = '';
    document.getElementById('ss-modality').textContent = c.modality || '—';
    document.getElementById('ss-objective').textContent = obj ? (obj.mag + '× / NA ' + obj.NA + ' ' + obj.imm + ', WD ' + obj.wd + ' mm') : '—';
    const lasersOn = Object.keys(c.lasers).filter(L => c.lasers[L]);
    document.getElementById('ss-lasers').textContent = lasersOn.length ? lasersOn.join(' nm, ') + ' nm' : '—';
    document.getElementById('ss-sampling').textContent = c.pixel_um.toFixed(3) + ' μm / Nyquist target ' + nyquist_um.toFixed(3) + ' μm';
    document.getElementById('ss-date').textContent = new Date().toISOString().slice(0, 10);
    const passEl = document.getElementById('ss-pass');
    const failEl = document.getElementById('ss-fail');
    if (issues.length) {
      passEl.style.display = 'none';
      failEl.style.display = '';
    } else {
      passEl.style.display = '';
      failEl.style.display = 'none';
    }
  }

  // ── Event wiring ──────────────────────────────────────────────────

  function wireTabs() {
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.addEventListener('click', () => setActiveTab(b.dataset.tab));
    });
  }

  function wireResolutionTab() {
    document.getElementById('res-sep').addEventListener('input', (e) => {
      state.resolution.sep_nm = parseInt(e.target.value, 10);
      drawResolution();
    });
    document.querySelectorAll('#tab-resolution .scen-btn').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('#tab-resolution .scen-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        state.resolution.lambda = parseInt(b.dataset.lambda, 10);
        state.resolution.NA     = parseFloat(b.dataset.na);
        drawResolution();
      });
    });
  }

  function wireNATab() {
    document.querySelectorAll('#tab-na .obj-btn').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('#tab-na .obj-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        state.na.mag   = parseInt(b.dataset.mag, 10);
        state.na.NA    = parseFloat(b.dataset.na);
        state.na.wd_mm = parseFloat(b.dataset.wd);
        state.na.imm   = b.dataset.imm;
        drawNAPanel();
      });
    });
    document.getElementById('na-lambda').addEventListener('change', (e) => {
      state.na.lambda = parseInt(e.target.value, 10);
      drawNAPanel();
    });
  }

  function wireKohlerTab() {
    document.querySelectorAll('#tab-kohler .kohler-btn').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('#tab-kohler .kohler-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        state.kohler.mode = b.dataset.kohler;
        drawKohler();
      });
    });
  }

  function wireContrastTab() {
    document.querySelectorAll('#tab-contrast .contrast-btn').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('#tab-contrast .contrast-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        state.contrast.mode = b.dataset.contrast;
        drawContrast();
      });
    });
  }

  function wireCapstoneTab() {
    document.getElementById('cap-modality').addEventListener('change', (e) => {
      state.capstone.modality = e.target.value;
      drawCapstone();
    });
    document.getElementById('cap-objective').addEventListener('change', (e) => {
      state.capstone.objective = e.target.value;
      drawCapstone();
    });
    ['405', '488', '561', '640'].forEach(L => {
      document.getElementById('cap-laser-' + L).addEventListener('change', (e) => {
        state.capstone.lasers[L] = e.target.checked;
        drawCapstone();
      });
    });
    document.getElementById('cap-pixel').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (!Number.isNaN(v)) state.capstone.pixel_um = v;
      drawCapstone();
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
    wireResolutionTab();
    wireNATab();
    wireKohlerTab();
    wireContrastTab();
    wireCapstoneTab();
    wireResize();
    // Initial draw of every tab so canvases warm up; the active one is
    // the only one visible, but the others' state is now ready for when
    // the user clicks through.
    drawResolution();
    drawNAPanel();
    drawKohler();
    drawContrast();
    drawCapstone();
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (typeof firebridge !== 'undefined' && firebridge.requireSignIn) {
      firebridge.requireSignIn('Sign in to track your training progress.').then(init).catch(init);
    } else {
      init();
    }
  });
})();

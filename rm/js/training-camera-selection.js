/* training-camera-selection.js — V3.184 interactive notebook.
 *
 * Five tabs covering camera selection for the Nikon Ti-E / Ti2-U
 * inverted microscope:
 *   1. Sensor types — 5 sensor families with architecture cross-section
 *   2. Specs deciphered — the six datasheet specs that actually decide
 *   3. Modality matcher — imaging mode → spec priorities + recommendation
 *   4. SNR calculator — SNR = (S·QE)/√(S·QE + B·QE + Nread² + D·t),
 *      with noise-regime classification and a simulated noisy pixel grid
 *   5. Capstone — catalog of 15 real cameras with 2025-2026 prices,
 *      scored against budget + modality + priority toggles, printable
 *      shortlist for procurement
 *
 * Catalog prices are 2025-2026 ballpark academic quotes — surfaced as
 * such on the page; never represent these as final.
 */
(function () {
  'use strict';

  function getCanvasCtx(id) {
    const c = document.getElementById(id);
    if (!c) return null;
    const dpr = window.devicePixelRatio || 1;
    const rect = c.getBoundingClientRect();
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

  function fmtUsd(v) {
    return '$' + Math.round(v).toLocaleString();
  }

  // ─────────────────────────────────────────────────────────────────
  // TAB 1 — Sensor families
  // ─────────────────────────────────────────────────────────────────

  const FAMILIES = {
    indcmos: {
      name: 'Industrial CMOS',
      qe: '~50-65% peak',
      readNoise: '~5-10 e-',
      fps: '30-200',
      price: '$1k - $3k',
      bestFor: 'Brightfield, phase, DIC; transmitted-light teaching',
      avoid: 'Anything fluorescence — read noise + low QE kill SNR',
      arch: 'frontIllum',
      caption: 'Off-the-shelf industrial sensor with a Bayer or mono CFA. Optimized for cost, not low light.',
    },
    scmos: {
      name: 'sCMOS (front-illuminated)',
      qe: '~70-82% peak',
      readNoise: '~1.0-1.6 e- rms',
      fps: '30-100 full frame; kHz on sub-array',
      price: '$10k - $20k',
      bestFor: 'Workhorse fluorescence — well-stained live cells, TFM, time-lapse',
      avoid: 'Single-molecule (QE too low) and quantitative photon counting',
      arch: 'frontIllum',
      caption: 'Wiring + microlens layer sits between the photons and the silicon → ~25% of red photons reflect off the metal before producing signal.',
    },
    'scmos-bsi': {
      name: 'sCMOS BSI (back-illuminated)',
      qe: '~90-95% peak',
      readNoise: '~1.0-1.6 e- rms',
      fps: '30-100 full frame',
      price: '$20k - $30k',
      bestFor: 'Dim fluorescence, spinning-disk confocal, live-cell quantitative imaging',
      avoid: 'When the lamp is bright (brightfield) — paying ~$10k extra for QE you can\'t use',
      arch: 'backIllum',
      caption: 'Silicon flipped over so photons hit the photodiode first; wiring is on the back. Adds 20-25% QE across the visible.',
    },
    qcmos: {
      name: 'qCMOS (quantitative CMOS)',
      qe: '~85% peak BSI',
      readNoise: '< 0.3 e- rms (photon-number resolving)',
      fps: '5-25 full frame',
      price: '$25k - $30k',
      bestFor: 'Single-molecule, photon counting, ultra-low-light kinetics',
      avoid: 'High-speed imaging (full-frame fps is half a comparable sCMOS)',
      arch: 'backIllum',
      caption: 'Same BSI architecture as Fusion BT but with read electronics tuned so low you can distinguish 0, 1, 2 photoelectrons. Hamamatsu ORCA-Quest is the canonical part.',
    },
    emccd: {
      name: 'EMCCD (legacy ultra-low-light)',
      qe: '~95% peak BSI',
      readNoise: '< 1 e- effective (with EM gain on)',
      fps: '5-30 full frame',
      price: '$30k - $40k',
      bestFor: 'Single-molecule on legacy systems; preserved as the prior tier',
      avoid: 'New purchases — qCMOS has displaced it for almost every workflow',
      arch: 'emccd',
      caption: 'Each charge packet is amplified in an electron-multiplying register before readout. The amplification helps SNR at very low signal but adds a √2 excess-noise factor.',
    },
  };

  function drawSensorArch(ctx, w, h, arch) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    const cx = w / 2, midY = h / 2;
    const pixW = 220, pixH = 110;
    const x0 = cx - pixW / 2, y0 = midY - pixH / 2;

    // Photon arrows from top
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 2;
    ctx.fillStyle = '#16a34a';
    ctx.font = 'bold 11px -apple-system, sans-serif';
    for (let i = -2; i <= 2; i++) {
      const xPhot = cx + i * 28;
      ctx.beginPath();
      ctx.moveTo(xPhot, 14);
      ctx.lineTo(xPhot, y0 - 6);
      ctx.stroke();
      // Arrowhead
      ctx.beginPath();
      ctx.moveTo(xPhot, y0 - 2);
      ctx.lineTo(xPhot - 3, y0 - 8);
      ctx.lineTo(xPhot + 3, y0 - 8);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillText('photons in', 12, 22);

    if (arch === 'frontIllum') {
      // Wiring layer on top, silicon below
      ctx.fillStyle = '#d4d4d8';
      ctx.fillRect(x0, y0, pixW, pixH * 0.35);
      ctx.strokeStyle = '#52525b';
      ctx.lineWidth = 1;
      ctx.strokeRect(x0, y0, pixW, pixH * 0.35);
      ctx.fillStyle = '#27272a';
      ctx.font = '11px -apple-system, sans-serif';
      ctx.fillText('metal wiring + microlens', x0 + 6, y0 + pixH * 0.22);

      ctx.fillStyle = '#86efac';
      ctx.fillRect(x0, y0 + pixH * 0.35, pixW, pixH * 0.65);
      ctx.strokeStyle = '#166534';
      ctx.strokeRect(x0, y0 + pixH * 0.35, pixW, pixH * 0.65);
      ctx.fillStyle = '#14532d';
      ctx.fillText('silicon (photo-active)', x0 + 6, y0 + pixH * 0.6);
      ctx.fillText('photodiode well', x0 + 6, y0 + pixH * 0.85);

      // Some photons reflect off the wiring — draw two red bouncing arrows
      ctx.strokeStyle = '#dc2626';
      ctx.fillStyle = '#dc2626';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx - 56, y0);
      ctx.lineTo(cx - 70, y0 - 18);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx + 56, y0);
      ctx.lineTo(cx + 70, y0 - 18);
      ctx.stroke();
      ctx.font = 'bold 11px -apple-system, sans-serif';
      ctx.fillText('~25-30% reflected', cx + 84, y0 - 10);
    } else if (arch === 'backIllum') {
      // Silicon on top, wiring on bottom
      ctx.fillStyle = '#86efac';
      ctx.fillRect(x0, y0, pixW, pixH * 0.65);
      ctx.strokeStyle = '#166534';
      ctx.strokeRect(x0, y0, pixW, pixH * 0.65);
      ctx.fillStyle = '#14532d';
      ctx.font = '11px -apple-system, sans-serif';
      ctx.fillText('silicon (photo-active) — photons in first', x0 + 6, y0 + pixH * 0.18);
      ctx.fillText('photodiode well', x0 + 6, y0 + pixH * 0.5);

      ctx.fillStyle = '#d4d4d8';
      ctx.fillRect(x0, y0 + pixH * 0.65, pixW, pixH * 0.35);
      ctx.strokeStyle = '#52525b';
      ctx.strokeRect(x0, y0 + pixH * 0.65, pixW, pixH * 0.35);
      ctx.fillStyle = '#27272a';
      ctx.fillText('metal wiring (now behind)', x0 + 6, y0 + pixH * 0.88);

      // Annotation: ~95% QE
      ctx.fillStyle = '#16a34a';
      ctx.font = 'bold 12px -apple-system, sans-serif';
      ctx.fillText('~90-95% reach the silicon →', cx + 84, y0 + 12);
    } else if (arch === 'emccd') {
      // BSI silicon + EM gain register
      ctx.fillStyle = '#86efac';
      ctx.fillRect(x0, y0, pixW, pixH * 0.45);
      ctx.strokeStyle = '#166534';
      ctx.strokeRect(x0, y0, pixW, pixH * 0.45);
      ctx.fillStyle = '#14532d';
      ctx.font = '11px -apple-system, sans-serif';
      ctx.fillText('silicon (BSI)', x0 + 6, y0 + pixH * 0.25);

      ctx.fillStyle = '#fbbf24';
      ctx.fillRect(x0, y0 + pixH * 0.45, pixW, pixH * 0.25);
      ctx.strokeStyle = '#92400e';
      ctx.strokeRect(x0, y0 + pixH * 0.45, pixW, pixH * 0.25);
      ctx.fillStyle = '#7c2d12';
      ctx.fillText('electron-multiplying register (gain ×1000)', x0 + 6, y0 + pixH * 0.6);

      ctx.fillStyle = '#d4d4d8';
      ctx.fillRect(x0, y0 + pixH * 0.7, pixW, pixH * 0.3);
      ctx.strokeStyle = '#52525b';
      ctx.strokeRect(x0, y0 + pixH * 0.7, pixW, pixH * 0.3);
      ctx.fillStyle = '#27272a';
      ctx.fillText('output amplifier', x0 + 6, y0 + pixH * 0.9);

      // Excess noise factor warning
      ctx.fillStyle = '#dc2626';
      ctx.font = 'bold 11px -apple-system, sans-serif';
      ctx.fillText('√2 excess-noise factor', cx + 84, y0 + pixH * 0.58);
    }

    // Bottom: readout arrow
    ctx.strokeStyle = '#475569';
    ctx.fillStyle = '#475569';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, y0 + pixH + 6);
    ctx.lineTo(cx, h - 16);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, h - 12);
    ctx.lineTo(cx - 4, h - 18);
    ctx.lineTo(cx + 4, h - 18);
    ctx.closePath();
    ctx.fill();
    ctx.font = '11px -apple-system, sans-serif';
    ctx.fillText('signal out', cx + 10, h - 12);
  }

  // ─────────────────────────────────────────────────────────────────
  // TAB 2 — Specs deciphered
  // ─────────────────────────────────────────────────────────────────

  const SPECS = {
    qe: {
      name: 'Quantum efficiency (QE)',
      units: 'percent at peak λ',
      range: '50% (industrial) → 95% (BSI sCMOS / EMCCD)',
      better: 'Higher — more photons → more signal electrons',
      tradeoff: 'BSI architecture costs ~$10k more than front-illuminated',
      matters: 'When signal photons are scarce (dim fluorescence, deep into samples, single-molecule)',
      verdict: 'QE multiplies signal proportionally. Doubling QE from 45% to 90% doubles the photoelectron count — that\'s a √2 SNR gain in the shot-noise-limited regime. The flip side: when you\'re photon-rich (brightfield), spending on QE buys you nothing useful.',
      visual: 'qe',
    },
    readnoise: {
      name: 'Read noise',
      units: 'electrons (rms) per pixel per readout',
      range: '0.3 e- (qCMOS) → 6 e- (industrial CMOS)',
      better: 'Lower — adds independently of signal, dominates at low signal',
      tradeoff: 'Lowest read noise needs slower readout — full-frame fps drops',
      matters: 'When signal is ≲ 20 photons/pixel — read noise dominates the noise budget',
      verdict: 'Read noise enters as N_read², so halving it removes 75% of that noise term. Once shot noise (√S) > N_read, the spec is irrelevant. Real-world: a 0.5 e- qCMOS vs a 1.5 e- sCMOS gives a 9× advantage when S=2 photons, but they tie at S=200.',
      visual: 'readnoise',
    },
    pxsize: {
      name: 'Pixel size',
      units: 'micrometers per side (physical pixel pitch)',
      range: '4.25 µm (Iris / Quest) → 6.5 µm (Fusion / Zyla) → 11 µm (Sona-11)',
      better: 'Depends — bigger = more photons/pixel; smaller = finer sampling',
      tradeoff: 'Smaller pixels need higher magnification or denser sampling at the sample',
      matters: 'Pixel size × system magnification = pixel size at sample. Has to be ≤ λ/(4·NA) for Nyquist.',
      verdict: 'Pick pixel size to hit Nyquist on your objective. A 6.5 µm camera + 25×/1.1 = 0.26 µm/px — about right for 488 nm emission. The 11 µm Sona on the same scope = 0.44 µm/px — under-sampled unless you bin 0× or push mag up.',
      visual: 'pxsize',
    },
    sensor: {
      name: 'Sensor size / megapixels',
      units: 'sensor diagonal (mm) × megapixels',
      range: '13 mm / 4 MP → 25 mm / 15 MP (Iris 15) → 32 mm / 16 MP (Dhyana 4040)',
      better: 'Bigger sensor = larger FOV at the sample (more cells per frame)',
      tradeoff: 'Bigger files, slower writes, may exceed objective field number → vignetting corners',
      matters: 'Statistics — TFM, screening, tile-stitching benefit most',
      verdict: 'FOV at sample = sensor_diagonal ÷ system_magnification. A 25 mm Iris 15 on a 25×/1.1 gives ~1 mm FOV. Watch for the objective\'s field number (typ. 22-25 mm) — past it the corners go dark or aberrated.',
      visual: 'sensor',
    },
    dynrange: {
      name: 'Dynamic range / bit depth',
      units: 'full-well (e-) ÷ read noise = ratio or dB; ADC bit depth in bits',
      range: 'Dynamic range 1000:1 → 90,000:1; bit depth 12 → 16 bits',
      better: 'Higher when bright and dim features coexist in the same frame',
      tradeoff: 'Higher bit depth = bigger files, slower transfer',
      matters: 'Mixed-intensity scenes (bright cytoplasm + dim puncta; ratiometric imaging)',
      verdict: 'A 12-bit camera resolves 4096 gray levels. A 16-bit camera resolves 65,536. The win only shows up when your scene actually spans that range — a brightfield image of an evenly stained slide gets nothing from 16-bit. Lab default: 16-bit for quantitative fluorescence, 12-bit fine for visual brightfield.',
      visual: 'dynrange',
    },
    fps: {
      name: 'Frame rate',
      units: 'frames per second (full-frame; sub-array is much faster)',
      range: '5 fps (large qCMOS) → 100 fps (sCMOS) → 1000+ fps (small ROI)',
      better: 'Higher for fast events; not needed for fixed-cell snapshots',
      tradeoff: 'High-fps cameras often sacrifice QE or have smaller sensors',
      matters: 'Calcium transients, vesicle trafficking, particle tracking, beating heart organoids',
      verdict: 'Frame rate caps your time resolution. Calcium imaging needs ≥50 fps to catch a 200 ms transient. Particle tracking needs frame intervals shorter than the particle\'s motion blur — for cells migrating 5 µm/min through a hydrogel, 1 Hz is fine; for vesicles at 1 µm/s, you need ≥30 Hz.',
      visual: 'fps',
    },
  };

  function drawSpecVisual(ctx, w, h, spec) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    if (spec === 'qe') {
      // QE curves vs wavelength
      ctx.font = '11px -apple-system, sans-serif';
      ctx.fillStyle = '#475569';
      ctx.fillText('QE vs wavelength', 12, 18);
      const axL = 50, axR = w - 30, axB = h - 30, axT = 30;
      // axes
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(axL, axT); ctx.lineTo(axL, axB); ctx.lineTo(axR, axB);
      ctx.stroke();
      ctx.fillStyle = '#64748b';
      ctx.fillText('400 nm', axL - 8, axB + 14);
      ctx.fillText('700 nm', axR - 22, axB + 14);
      ctx.fillText('100%', axL - 38, axT + 6);
      ctx.fillText('0%', axL - 24, axB);

      // BSI curve
      ctx.strokeStyle = '#16a34a';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      for (let i = 0; i <= 30; i++) {
        const x = axL + (axR - axL) * (i / 30);
        const wave = 400 + i * 10;
        let q = 0.92 - 0.0006 * Math.pow(wave - 540, 2) / 100;
        q = Math.max(0.4, Math.min(0.95, q));
        const y = axB - (axB - axT) * q;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.fillStyle = '#16a34a';
      ctx.fillText('BSI sCMOS (95% peak)', axR - 140, axT + 18);

      // Front-illum curve
      ctx.strokeStyle = '#ea580c';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      for (let i = 0; i <= 30; i++) {
        const x = axL + (axR - axL) * (i / 30);
        const wave = 400 + i * 10;
        let q = 0.78 - 0.001 * Math.pow(wave - 540, 2) / 80;
        q = Math.max(0.25, Math.min(0.82, q));
        const y = axB - (axB - axT) * q;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.fillStyle = '#ea580c';
      ctx.fillText('Front-illum (78% peak)', axR - 140, axT + 36);

      // Industrial curve
      ctx.strokeStyle = '#dc2626';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      for (let i = 0; i <= 30; i++) {
        const x = axL + (axR - axL) * (i / 30);
        const wave = 400 + i * 10;
        let q = 0.55 - 0.001 * Math.pow(wave - 540, 2) / 60;
        q = Math.max(0.18, Math.min(0.6, q));
        const y = axB - (axB - axT) * q;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.fillStyle = '#dc2626';
      ctx.fillText('Industrial CMOS (55% peak)', axR - 170, axT + 54);
    } else if (spec === 'readnoise') {
      // Histogram of dark-pixel readouts at three noise levels
      ctx.font = '11px -apple-system, sans-serif';
      ctx.fillStyle = '#475569';
      ctx.fillText('Read-noise pixel histogram (dark field readout)', 12, 18);
      const cx = w / 2;
      const baseY = h - 30;
      const peakH = h - 60;
      // 3 Gaussians
      const noises = [
        { sigma: 0.3, color: '#16a34a', label: 'qCMOS 0.3 e-' },
        { sigma: 1.5, color: '#2563eb', label: 'sCMOS 1.5 e-' },
        { sigma: 6.0, color: '#dc2626', label: 'industrial 6 e-' },
      ];
      noises.forEach((n, i) => {
        ctx.strokeStyle = n.color;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        for (let xx = -50; xx <= 50; xx += 0.5) {
          const g = Math.exp(-(xx * xx) / (2 * n.sigma * n.sigma * 25));
          const px = cx + xx * 4;
          const py = baseY - g * peakH;
          if (xx === -50) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.fillStyle = n.color;
        ctx.fillText(n.label, 14, 36 + i * 16);
      });
      ctx.strokeStyle = '#94a3b8';
      ctx.beginPath();
      ctx.moveTo(40, baseY); ctx.lineTo(w - 20, baseY); ctx.stroke();
      ctx.fillStyle = '#64748b';
      ctx.fillText('electrons', cx - 24, baseY + 14);
    } else if (spec === 'pxsize') {
      // Three pixel grids side-by-side
      ctx.font = '11px -apple-system, sans-serif';
      ctx.fillStyle = '#475569';
      ctx.fillText('Same object, three pixel pitches', 12, 18);
      const sizes = [
        { label: '4.25 µm', cells: 12, color: '#7c3aed', xCenter: w * 0.18 },
        { label: '6.5 µm',  cells: 8,  color: '#0891b2', xCenter: w * 0.5 },
        { label: '11 µm',   cells: 5,  color: '#ea580c', xCenter: w * 0.82 },
      ];
      sizes.forEach(s => {
        const g = 130;
        const cell = g / s.cells;
        const x0 = s.xCenter - g / 2, y0 = 40;
        ctx.strokeStyle = '#cbd5e1';
        ctx.lineWidth = 1;
        for (let i = 0; i <= s.cells; i++) {
          ctx.beginPath();
          ctx.moveTo(x0 + i * cell, y0);
          ctx.lineTo(x0 + i * cell, y0 + g);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(x0, y0 + i * cell);
          ctx.lineTo(x0 + g, y0 + i * cell);
          ctx.stroke();
        }
        ctx.strokeStyle = '#475569';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x0, y0, g, g);
        // Object overlay — same size in all three
        const grad = ctx.createRadialGradient(s.xCenter, y0 + g / 2, 0, s.xCenter, y0 + g / 2, 32);
        grad.addColorStop(0, 'rgba(220, 38, 38, 1)');
        grad.addColorStop(1, 'rgba(220, 38, 38, 0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(s.xCenter, y0 + g / 2, 32, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = s.color;
        ctx.font = 'bold 12px -apple-system, sans-serif';
        ctx.fillText(s.label, s.xCenter - 16, y0 + g + 18);
      });
    } else if (spec === 'sensor') {
      // Sensor outlines to scale
      ctx.font = '11px -apple-system, sans-serif';
      ctx.fillStyle = '#475569';
      ctx.fillText('Sensor footprints — same scale (mm diagonals)', 12, 18);
      const scale = 6;
      const yC = h / 2 + 10;
      const sensors = [
        { name: '13 mm (Flash 4.0)',  d: 13, w: 13 / Math.SQRT2, h: 13 / Math.SQRT2, color: '#cbd5e1', xC: w * 0.22 },
        { name: '18 mm (Fusion BT)', d: 18, w: 18 / Math.SQRT2, h: 18 / Math.SQRT2, color: '#93c5fd', xC: w * 0.5 },
        { name: '25 mm (Iris 15)',   d: 25, w: 25 / Math.SQRT2, h: 25 / Math.SQRT2, color: '#86efac', xC: w * 0.8 },
      ];
      sensors.forEach(s => {
        const sw = s.w * scale, sh = s.h * scale;
        ctx.fillStyle = s.color;
        ctx.fillRect(s.xC - sw / 2, yC - sh / 2, sw, sh);
        ctx.strokeStyle = '#1e40af';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(s.xC - sw / 2, yC - sh / 2, sw, sh);
        ctx.fillStyle = '#1f2937';
        ctx.font = '11px -apple-system, sans-serif';
        ctx.fillText(s.name, s.xC - 40, yC + sh / 2 + 18);
      });
    } else if (spec === 'dynrange') {
      // Histogram of pixel intensities with floors at different bit depths
      ctx.font = '11px -apple-system, sans-serif';
      ctx.fillStyle = '#475569';
      ctx.fillText('Gray levels resolvable at three bit depths', 12, 18);
      const levels = [
        { bits: 12, n: 4096,  label: '12-bit · 4,096 levels',  color: '#dc2626' },
        { bits: 14, n: 16384, label: '14-bit · 16,384 levels', color: '#ea580c' },
        { bits: 16, n: 65536, label: '16-bit · 65,536 levels', color: '#16a34a' },
      ];
      levels.forEach((L, i) => {
        const y0 = 40 + i * 60;
        const barW = (w - 80) * Math.log10(L.n) / Math.log10(65536);
        ctx.fillStyle = L.color;
        ctx.fillRect(60, y0, barW, 22);
        ctx.fillStyle = '#1f2937';
        ctx.font = '12px -apple-system, sans-serif';
        ctx.fillText(L.label, 60, y0 - 6);
      });
    } else if (spec === 'fps') {
      // Bars: full-frame fps for each family
      ctx.font = '11px -apple-system, sans-serif';
      ctx.fillStyle = '#475569';
      ctx.fillText('Full-frame fps comparison', 12, 18);
      const bars = [
        { label: 'qCMOS (Quest 2)',     fps: 25,  color: '#7c3aed' },
        { label: 'Sona / Fusion BT',     fps: 50,  color: '#2563eb' },
        { label: 'Zyla 4.2 / Flash 4.0', fps: 100, color: '#16a34a' },
        { label: 'Kinetix',               fps: 500, color: '#ea580c' },
        { label: 'Lightning',             fps: 800, color: '#dc2626' },
      ];
      const maxFps = 1000;
      bars.forEach((b, i) => {
        const y0 = 35 + i * 38;
        const barW = (w - 180) * Math.log10(b.fps + 1) / Math.log10(maxFps + 1);
        ctx.fillStyle = b.color;
        ctx.fillRect(160, y0, barW, 22);
        ctx.fillStyle = '#1f2937';
        ctx.font = '12px -apple-system, sans-serif';
        ctx.fillText(b.label, 12, y0 + 16);
        ctx.fillStyle = '#475569';
        ctx.font = '11px -apple-system, sans-serif';
        ctx.fillText(b.fps + ' fps', 160 + barW + 6, y0 + 16);
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // TAB 3 — Modality matcher
  // ─────────────────────────────────────────────────────────────────

  // Spec priorities (0-3) per modality: [qe, readnoise, pxsize, sensorFov, dynrange, fps]
  const MODALITIES = {
    brightfield: {
      name: 'Brightfield',
      pri: { qe: 0, rn: 0, px: 1, fov: 2, dr: 2, fps: 1 },
      family: 'Industrial CMOS or basic mono CMOS',
      budget: '$1k - $3k',
      pick: 'FLIR Blackfly S USB3 ($2k); Hamamatsu ORCA-Spark ($6k) overkill but useful',
      summary: 'Photons are plentiful from the lamp — every fluorescence camera is wasted here. Spend on dynamic range and sensor size, save on QE / cooling / read noise.',
    },
    phase: {
      name: 'Phase contrast / DIC',
      pri: { qe: 0, rn: 0, px: 2, fov: 2, dr: 3, fps: 1 },
      family: 'Industrial CMOS or entry sCMOS',
      budget: '$2k - $7k',
      pick: 'Hamamatsu ORCA-Spark ($6k) — 12-bit linearity good for thin phase gradients',
      summary: 'Like brightfield but watch dynamic range — phase fringes create both very bright and very dim regions in the same frame. 12-bit is fine, 16-bit helps with quantitative DIC.',
    },
    'epi-bright': {
      name: 'Epi-fluorescence (well-stained / live)',
      pri: { qe: 2, rn: 2, px: 2, fov: 2, dr: 2, fps: 2 },
      family: 'sCMOS front-illuminated',
      budget: '$10k - $20k',
      pick: 'Hamamatsu Flash 4.0 V3 ($18k); Photometrics Iris 15 ($15k) for large FOV',
      summary: 'The bread-and-butter case. Front-illum sCMOS does everything well — moderate QE, low read noise, fast, big enough FOV. Step up to BSI only if your signal drops.',
    },
    'epi-dim': {
      name: 'Epi-fluorescence (dim / fixed / quantitative)',
      pri: { qe: 3, rn: 3, px: 2, fov: 2, dr: 2, fps: 1 },
      family: 'sCMOS BSI',
      budget: '$20k - $30k',
      pick: 'Hamamatsu Fusion BT ($25k); Photometrics Prime BSI Express ($22k)',
      summary: 'When photons are scarce, BSI sCMOS pays for itself. The 95% QE turns marginal images into clean ones. Cooled, low read noise, big enough FOV.',
    },
    tirf: {
      name: 'TIRF',
      pri: { qe: 3, rn: 3, px: 2, fov: 1, dr: 1, fps: 2 },
      family: 'qCMOS or sCMOS BSI',
      budget: '$25k - $30k',
      pick: 'Hamamatsu ORCA-Quest 2 ($28k); Photometrics Prime BSI Express ($22k)',
      summary: 'Signal is tiny — single membrane proteins. QE and read noise dominate everything. Small FOV is fine because the evanescent field is small anyway. Cooled.',
    },
    spinning: {
      name: 'Spinning-disk confocal',
      pri: { qe: 3, rn: 2, px: 2, fov: 2, dr: 2, fps: 3 },
      family: 'sCMOS BSI (global shutter ideally)',
      budget: '$20k - $30k',
      pick: 'Photometrics Kinetix ($30k); Hamamatsu Fusion BT ($25k)',
      summary: 'The disk throws away most of the laser light, so the camera has to be sensitive. Plus you want frame rates that keep up with the disk. BSI sCMOS is the standard.',
    },
    livecell: {
      name: 'Live-cell time-lapse',
      pri: { qe: 3, rn: 2, px: 2, fov: 2, dr: 2, fps: 1 },
      family: 'sCMOS BSI',
      budget: '$20k - $25k',
      pick: 'Hamamatsu Fusion BT ($25k); Photometrics Prime BSI Express ($22k)',
      summary: 'Higher QE means shorter exposures, less phototoxicity, less photobleaching — the camera buys you experiment hours. Fps moderate; you\'re probably ≤1 Hz over hours.',
    },
    calcium: {
      name: 'Calcium / fast tracking',
      pri: { qe: 2, rn: 2, px: 2, fov: 1, dr: 1, fps: 3 },
      family: 'sCMOS BSI with fast readout',
      budget: '$25k - $30k',
      pick: 'Photometrics Kinetix ($30k); Hamamatsu ORCA-Lightning ($26k)',
      summary: 'Need ≥50 fps to catch a 200 ms calcium transient. Kinetix hits 500 fps full-frame; Lightning hits 800. Smaller FOV is fine if you crop to neurons of interest.',
    },
    smlm: {
      name: 'Single-molecule (STORM / SMLM)',
      pri: { qe: 3, rn: 3, px: 3, fov: 1, dr: 2, fps: 2 },
      family: 'qCMOS or EMCCD',
      budget: '$28k - $40k',
      pick: 'Hamamatsu ORCA-Quest 2 ($28k); Andor iXon Ultra 888 EMCCD ($35k) for legacy',
      summary: 'The hardest case — single fluorophores emit only ~100-1000 photons before bleaching. Every spec must be near-perfect: highest QE, lowest noise, right pixel size for fitting precision.',
    },
    tfm: {
      name: 'TFM bead tracking',
      pri: { qe: 2, rn: 3, px: 2, fov: 3, dr: 2, fps: 1 },
      family: 'sCMOS BSI with large sensor',
      budget: '$20k - $30k',
      pick: 'Photometrics Kinetix ($30k); Hamamatsu Fusion BT ($25k); Iris 15 ($15k) if budget-bound',
      summary: 'Bead localization needs low read noise (sub-pixel fit accuracy). Large FOV matters — more cells per frame = more statistics. The Iris 15\'s 25 mm sensor is great here if you can live with its 73% QE.',
    },
  };

  function drawModalityBars(ctx, w, h, modKey) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    const m = MODALITIES[modKey];
    if (!m) return;

    const labels = [
      ['Quantum efficiency', 'qe',  '#16a34a'],
      ['Read noise (low)',   'rn',  '#2563eb'],
      ['Pixel sampling',     'px',  '#7c3aed'],
      ['Sensor / FOV',       'fov', '#ea580c'],
      ['Dynamic range',      'dr',  '#0891b2'],
      ['Frame rate',         'fps', '#dc2626'],
    ];

    const barH = 22, gap = 12, yStart = 22, xLabel = 12, xBar = 140, barWMax = w - xBar - 50;
    ctx.font = 'bold 12px -apple-system, sans-serif';
    labels.forEach(([label, key, color], i) => {
      const y = yStart + i * (barH + gap);
      ctx.fillStyle = '#1f2937';
      ctx.fillText(label, xLabel, y + 15);
      const pri = m.pri[key];
      const barW = (pri / 3) * barWMax;
      ctx.fillStyle = '#e5e7eb';
      ctx.fillRect(xBar, y, barWMax, barH);
      ctx.fillStyle = color;
      ctx.fillRect(xBar, y, barW, barH);
      ctx.strokeStyle = '#cbd5e1';
      ctx.strokeRect(xBar, y, barWMax, barH);
      ctx.fillStyle = '#1f2937';
      ctx.font = 'bold 11px -apple-system, sans-serif';
      ctx.fillText(pri + ' / 3', xBar + barWMax + 8, y + 15);
      ctx.font = 'bold 12px -apple-system, sans-serif';
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // TAB 4 — SNR calculator
  // ─────────────────────────────────────────────────────────────────

  function computeSnr(s) {
    const sigE  = s.signal * (s.qe / 100);
    const bgE   = s.bg     * (s.qe / 100);
    const darkE = s.dc     * s.t;
    const shotNoiseSq = sigE + bgE;
    const noiseSq = shotNoiseSq + s.rn * s.rn + darkE;
    const snr = sigE / Math.sqrt(Math.max(1e-9, noiseSq));
    const totalNoise = Math.sqrt(noiseSq);

    // Identify dominant noise term
    const terms = [
      { key: 'shot',   value: sigE,         label: 'signal-shot-noise limited (the goal)' },
      { key: 'bg',     value: bgE,          label: 'background-shot-noise limited' },
      { key: 'read',   value: s.rn * s.rn,  label: 'read-noise limited' },
      { key: 'dark',   value: darkE,        label: 'dark-current limited' },
    ];
    terms.sort((a, b) => b.value - a.value);
    const dominant = terms[0];

    return { sigE, bgE, darkE, totalNoise, snr, dominant };
  }

  // Seeded PRNG so the simulated image is stable across redraws of the same parameters
  function mulberry32(seed) {
    return function () {
      let t = (seed += 0x6D2B79F5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randomGaussian(rng) {
    // Box-Muller
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function drawSnrImage(ctx, w, h, s) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    const rng = mulberry32(42);
    const gridW = 80, gridH = 36;
    const cellW = w / gridW, cellH = h / gridH;
    const cxg = gridW / 2, cyg = gridH / 2;

    const img = ctx.createImageData(w, h);
    const data = img.data;
    // For each pixel of canvas, find its grid cell, compute photon count + add noise
    for (let y = 0; y < h; y++) {
      const gy = Math.floor(y / cellH);
      for (let x = 0; x < w; x++) {
        const gx = Math.floor(x / cellW);
        const r = Math.sqrt((gx - cxg) * (gx - cxg) + (gy - cyg) * (gy - cyg));
        // Gaussian object profile
        const objAmp = Math.exp(-(r * r) / (2 * 5 * 5));
        const sigPhot = s.signal * objAmp + s.bg;
        const sigE = sigPhot * (s.qe / 100);
        const darkE = s.dc * s.t;
        const meanE = sigE + darkE;
        // Sample noisy electron count (Poisson approx Gaussian + read noise)
        const shot = randomGaussian(rng) * Math.sqrt(Math.max(0.0001, meanE));
        const read = randomGaussian(rng) * s.rn;
        const measured = Math.max(0, meanE + shot + read);
        // Display: linear scale based on max expected signal (signal*1.0 + bg) at the bright object
        const maxE = (s.signal + s.bg) * (s.qe / 100) + s.dc * s.t;
        const v = Math.min(1, measured / Math.max(1e-3, maxE * 1.1));
        const g = Math.floor(v * 240);
        const idx = (y * w + x) * 4;
        data[idx]     = Math.floor(g * 0.4);
        data[idx + 1] = g;
        data[idx + 2] = Math.floor(g * 0.5);
        data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    // Crosshair to mark object center
    ctx.strokeStyle = '#ffffff80';
    ctx.lineWidth = 1;
    const ccx = w / 2, ccy = h / 2;
    ctx.beginPath(); ctx.moveTo(ccx - 12, ccy); ctx.lineTo(ccx + 12, ccy);
    ctx.moveTo(ccx, ccy - 12); ctx.lineTo(ccx, ccy + 12);
    ctx.stroke();

    ctx.fillStyle = '#fff';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.fillText('simulated noisy image (single Gaussian object on background)', 8, h - 8);
  }

  // ─────────────────────────────────────────────────────────────────
  // TAB 5 — Capstone catalog
  // ─────────────────────────────────────────────────────────────────

  // Real cameras with 2025-2026 academic-ballpark prices.
  // qePeak: percent; rn: e- rms; pxUm: pixel pitch µm; diagMm: sensor
  // diagonal mm; mp: megapixels; fps: full-frame fps; price: USD;
  // family: one of indcmos/scmos/scmos-bsi/qcmos/emccd.
  const CATALOG = [
    // ── Budget / industrial tier (≤ $5k) ─────────────────────────────
    { name: 'Thorlabs Zelux CS165MU', vendor: 'Thorlabs', family: 'indcmos', mp: 1.6, pxUm: 3.45, diagMm: 6.5, qePeak: 69, rn: 3.5, fps: 35, bits: 10, price: 700,
      blurb: 'Ultra-compact CMOS (Sony IMX273). Brightfield + alignment work; not for serious fluorescence.' },
    { name: 'FLIR Blackfly S USB3 (mono)', vendor: 'Teledyne / FLIR', family: 'indcmos', mp: 2.3, pxUm: 5.86, diagMm: 13.4, qePeak: 60, rn: 6.0, fps: 75, bits: 10, price: 2000,
      blurb: 'Industrial CMOS; brightfield / phase only. Not for fluorescence.' },
    { name: 'Thorlabs Kiralux CC126MU', vendor: 'Thorlabs', family: 'scmos', mp: 12.3, pxUm: 3.45, diagMm: 17.6, qePeak: 72, rn: 2.5, fps: 23, bits: 12, price: 4000,
      blurb: 'Cooled CMOS (Sony IMX304). Great brightfield / well-stained epi for the price; 3.45 µm pixels demand higher mag.' },
    { name: 'Thorlabs Quantalux CC215MU', vendor: 'Thorlabs', family: 'scmos', mp: 2.1, pxUm: 5.04, diagMm: 11.1, qePeak: 61, rn: 1.0, fps: 50, bits: 16, price: 5000,
      blurb: 'Cooled sCMOS, 1 e- read noise. Cheapest "real" scientific camera for routine fluorescence.' },

    // ── Mid-tier sCMOS ($6k - $16k) ──────────────────────────────────
    { name: 'Hamamatsu ORCA-Spark', vendor: 'Hamamatsu', family: 'scmos', mp: 2.3, pxUm: 5.86, diagMm: 14.0, qePeak: 75, rn: 1.6, fps: 40, bits: 12, price: 6000,
      blurb: 'Entry sCMOS; good for routine epi-fluorescence on a budget.' },
    { name: 'Tucsen FL-20BW', vendor: 'Tucsen', family: 'scmos', mp: 20, pxUm: 2.4, diagMm: 15.9, qePeak: 84, rn: 0.9, fps: 16, bits: 16, price: 7000,
      blurb: 'High-res 20 MP cooled CMOS (Sony IMX183) with sub-1 e- read noise; 2.4 µm pixels need ≥40× mag.' },
    { name: 'Tucsen Dhyana 400BSI V3', vendor: 'Tucsen', family: 'scmos-bsi', mp: 4.2, pxUm: 6.5, diagMm: 18.8, qePeak: 95, rn: 1.6, fps: 40, bits: 16, price: 9000,
      blurb: 'Budget BSI sCMOS; rivals Prime BSI on paper at half the price.' },
    { name: 'Photometrics Iris 9', vendor: 'Teledyne / Photometrics', family: 'scmos', mp: 9, pxUm: 4.25, diagMm: 18.7, qePeak: 73, rn: 1.4, fps: 30, bits: 12, price: 10000,
      blurb: 'Mid-FOV front-illum sCMOS; same chip family as Iris 15, smaller sensor.' },
    { name: 'Tucsen Dhyana 4040 V2', vendor: 'Tucsen', family: 'scmos', mp: 16, pxUm: 6.5, diagMm: 32.0, qePeak: 74, rn: 1.6, fps: 26, bits: 16, price: 11000,
      blurb: 'Largest-FOV sensor in this price band; budget alternative to Iris 15 by FOV.' },
    { name: 'Tucsen FL-26BW', vendor: 'Tucsen', family: 'scmos-bsi', mp: 26, pxUm: 3.76, diagMm: 28.3, qePeak: 92, rn: 0.9, fps: 6.5, bits: 16, price: 13000,
      blurb: 'Deep-cooled BSI (Sony IMX571) to −25 °C; ultra-low dark current. Chemiluminescence + long-exposure dim fluorescence.' },
    { name: 'Tucsen Libra 25', vendor: 'Tucsen', family: 'scmos-bsi', mp: 5.3, pxUm: 7.52, diagMm: 25.0, qePeak: 92, rn: 1.0, fps: 32, bits: 16, price: 14000,
      blurb: '25 mm BSI sensor — direct Iris 15 alternative on FOV but with 92% QE + 1 e- read noise. Coarser sampling.' },
    { name: 'Tucsen Dhyana 95V2', vendor: 'Tucsen', family: 'scmos-bsi', mp: 4.2, pxUm: 11, diagMm: 31.9, qePeak: 95, rn: 1.7, fps: 48, bits: 16, price: 14000,
      blurb: 'Large 11 µm BSI pixels (GSENSE400BSI); Sona competitor. SMLM + deep-tissue.' },
    { name: 'Photometrics Iris 15', vendor: 'Teledyne / Photometrics', family: 'scmos', mp: 15, pxUm: 4.25, diagMm: 25.0, qePeak: 73, rn: 1.4, fps: 31, bits: 12, price: 15000,
      blurb: 'Large 25 mm sensor + 4.25 µm pixels; FOV-per-dollar leader on the front-illum side.' },
    { name: 'Andor ZL41 Cell 4.2', vendor: 'Oxford / Andor', family: 'scmos', mp: 4.2, pxUm: 6.5, diagMm: 18.8, qePeak: 82, rn: 0.9, fps: 53, bits: 16, price: 16000,
      blurb: 'Successor to the Zyla 4.2 PLUS — front-illum 82% QE, 0.9 e- read noise, no active cooling.' },
    { name: 'Andor ZL41 Cell 5.5', vendor: 'Oxford / Andor', family: 'scmos', mp: 5.5, pxUm: 6.5, diagMm: 21.8, qePeak: 64, rn: 0.9, fps: 40, bits: 16, price: 19000,
      blurb: 'Rare global-shutter option; trades QE (64%) for snap-shot mode useful in tracking + machine-vision-style work.' },

    // ── Premium sCMOS BSI ($18k - $30k) ──────────────────────────────
    { name: 'Hamamatsu ORCA-Flash 4.0 V3', vendor: 'Hamamatsu', family: 'scmos', mp: 4.2, pxUm: 6.5, diagMm: 18.8, qePeak: 82, rn: 1.6, fps: 100, bits: 16, price: 18000,
      blurb: 'The reference scientific sCMOS for a decade; still excellent.' },
    { name: 'Tucsen Aries 6504 Pro', vendor: 'Tucsen', family: 'scmos-bsi', mp: 4.2, pxUm: 6.5, diagMm: 18.8, qePeak: 95, rn: 0.43, fps: 74, bits: 16, price: 19000,
      blurb: 'Tucsen\'s Fusion BT competitor — 0.43 e- read noise, BSI 95% QE, air/liquid cooled.' },
    { name: 'Photometrics Prime 95B', vendor: 'Teledyne / Photometrics', family: 'scmos-bsi', mp: 1.4, pxUm: 11, diagMm: 18.6, qePeak: 95, rn: 1.6, fps: 41, bits: 16, price: 20000,
      blurb: 'Large 11 µm BSI pixels; superb low-light SNR per pixel. Coarse sampling — fine for ≤40×.' },
    { name: 'Photometrics Prime BSI Express', vendor: 'Teledyne / Photometrics', family: 'scmos-bsi', mp: 4.2, pxUm: 6.5, diagMm: 18.8, qePeak: 95, rn: 1.0, fps: 100, bits: 16, price: 22000,
      blurb: 'High-QE BSI workhorse; great default for dim epi + spinning-disk.' },
    { name: 'Andor Sona-11 (22 mm)', vendor: 'Oxford / Andor', family: 'scmos-bsi', mp: 2.0, pxUm: 11, diagMm: 21.9, qePeak: 95, rn: 1.6, fps: 70, bits: 16, price: 20000,
      blurb: 'Smaller-sensor Sona-11 — same 11 µm BSI pixels in a 22 mm format. 70 fps for live-cell.' },
    { name: 'Andor Sona-11 (32 mm)', vendor: 'Oxford / Andor', family: 'scmos-bsi', mp: 4.2, pxUm: 11, diagMm: 31.9, qePeak: 95, rn: 1.6, fps: 48, bits: 16, price: 22000,
      blurb: 'Large 11 µm BSI in a 32 mm sensor (formerly Sona 4.2B-11). Coarse sampling — fine for ≤40×.' },
    { name: 'Andor Sona Extreme', vendor: 'Oxford / Andor', family: 'scmos-bsi', mp: 4.2, pxUm: 6.5, diagMm: 18.8, qePeak: 95, rn: 0.9, fps: 43, bits: 16, price: 28000,
      blurb: 'BSI 95% QE with sub-1 e- read noise and -45 °C deep cooling. CoaXPress option reaches 135 fps; USB 3.0 = 43 fps.' },
    { name: 'Andor CB2 24B', vendor: 'Oxford / Andor', family: 'scmos-bsi', mp: 24.5, pxUm: 2.74, diagMm: 19.3, qePeak: 75, rn: 1.3, fps: 106, bits: 12, price: 32000,
      blurb: 'High-resolution BSI (24.5 MP) + 106 fps full-res / 386 fps binned via CoaXPress. Frame grabber required; not USB.' },
    { name: 'Hamamatsu ORCA-Fusion BT', vendor: 'Hamamatsu', family: 'scmos-bsi', mp: 5.3, pxUm: 6.5, diagMm: 18.8, qePeak: 95, rn: 0.7, fps: 100, bits: 16, price: 25000,
      blurb: 'Best-in-class BSI sCMOS — high QE + sub-1 e- read noise + 100 fps.' },
    { name: 'Hamamatsu ORCA-Lightning', vendor: 'Hamamatsu', family: 'scmos', mp: 4, pxUm: 5.5, diagMm: 17.6, qePeak: 80, rn: 1.4, fps: 800, bits: 12, price: 26000,
      blurb: 'Speed king — 800 fps full frame for calcium / fast tracking.' },
    { name: 'Hamamatsu ORCA-Quest 2', vendor: 'Hamamatsu', family: 'qcmos', mp: 9.4, pxUm: 4.6, diagMm: 23.4, qePeak: 85, rn: 0.27, fps: 25, bits: 16, price: 28000,
      blurb: 'Photon-number-resolving qCMOS — the new low-light reference.' },
    { name: 'Photometrics Kinetix', vendor: 'Teledyne / Photometrics', family: 'scmos-bsi', mp: 10, pxUm: 6.5, diagMm: 29.4, qePeak: 95, rn: 1.0, fps: 500, bits: 16, price: 30000,
      blurb: 'Large 29 mm BSI sensor + 500 fps full frame. Best-of-everything if budget allows.' },
    { name: 'Andor iXon Ultra 888 (EMCCD)', vendor: 'Oxford / Andor', family: 'emccd', mp: 1.05, pxUm: 13, diagMm: 18.8, qePeak: 95, rn: 0.5, fps: 26, bits: 14, price: 35000,
      blurb: 'Legacy EMCCD; mostly displaced by qCMOS. Buy only for compatibility with existing SMLM rigs.' },
  ];

  function scoreCamera(cam, pri, prefs) {
    // Map camera specs to 0-3 scores per priority axis
    const qeScore  = Math.max(0, Math.min(3, (cam.qePeak - 50) / 15));         // 50%→0, 95%→3
    const rnScore  = Math.max(0, Math.min(3, (6 - cam.rn) / 1.9));             // 6e-→0, 0.3e-→3
    const pxScore  = (() => {
      // Best around 6.5 µm for general use; penalize extremes
      const d = Math.abs(cam.pxUm - 6.5);
      return Math.max(0, 3 - d * 0.5);
    })();
    const fovScore = Math.max(0, Math.min(3, (cam.diagMm - 13) / 6.5));        // 13mm→0, 32mm→3
    const drScore  = Math.max(0, Math.min(3, (cam.bits - 12) / 1.5));          // 12→0, 16→2.67
    const fpsScore = Math.max(0, Math.min(3, Math.log10(Math.max(1, cam.fps)) / Math.log10(800) * 3));

    // Weighted sum
    const base =
      qeScore  * pri.qe  +
      rnScore  * pri.rn  +
      pxScore  * pri.px  +
      fovScore * pri.fov +
      drScore  * pri.dr  +
      fpsScore * pri.fps;

    // Hard boosts from explicit user prefs
    let bonus = 0;
    if (prefs.needFov  && fovScore >= 2)   bonus += 2;
    if (prefs.needFast && fpsScore >= 2)   bonus += 2;
    if (prefs.needLowNoise && rnScore >= 2.5) bonus += 2;

    // Penalize industrial CMOS for any fluorescence modality
    if (cam.family === 'indcmos' && pri.qe > 0) bonus -= 12;

    // Don't recommend EMCCD unless we explicitly need lowest noise on a smlm-like axis
    if (cam.family === 'emccd' && !(prefs.needLowNoise && pri.qe >= 3)) bonus -= 3;

    return { score: base + bonus, qeScore, rnScore, pxScore, fovScore, drScore, fpsScore };
  }

  // ─────────────────────────────────────────────────────────────────
  // State
  // ─────────────────────────────────────────────────────────────────

  const state = {
    sensors:  { fam: 'indcmos' },
    specs:    { spec: 'qe' },
    modality: { mod: 'brightfield' },
    snr:      { signal: 80, bg: 20, qe: 75, rn: 1.5, dc: 0.2, t: 0.5 },
    pick:     { budget: 20000, modality: 'epi-dim', needFov: false, needFast: false, needLowNoise: false },
  };

  let activeTab = 'tab-sensors';

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
    if      (activeTab === 'tab-sensors')  drawSensors();
    else if (activeTab === 'tab-specs')    drawSpecs();
    else if (activeTab === 'tab-modality') drawModality();
    else if (activeTab === 'tab-snr')      drawSnr();
    else if (activeTab === 'tab-pick')     drawPick();
  }

  // ─────────────────────────────────────────────────────────────────
  // Renderers per tab
  // ─────────────────────────────────────────────────────────────────

  function drawSensors() {
    const f = FAMILIES[state.sensors.fam];
    document.getElementById('fam-name').textContent      = f.name;
    document.getElementById('fam-qe').textContent        = f.qe;
    document.getElementById('fam-readnoise').textContent = f.readNoise;
    document.getElementById('fam-fps').textContent       = f.fps;
    document.getElementById('fam-price').textContent     = f.price;
    document.getElementById('fam-bestfor').textContent   = f.bestFor;
    document.getElementById('fam-avoid').textContent     = f.avoid;

    const v = document.getElementById('fam-verdict');
    v.classList.remove('is-warning', 'is-critical');
    if (state.sensors.fam === 'emccd') v.classList.add('is-warning');
    if (state.sensors.fam === 'indcmos') v.classList.add('is-warning');
    v.innerHTML = '<strong>' + f.name + '.</strong> ' + f.caption;

    const cw = getCanvasCtx('canvas-sensor');
    if (cw) drawSensorArch(cw.ctx, cw.w, cw.h, f.arch);
  }

  function drawSpecs() {
    const s = SPECS[state.specs.spec];
    document.getElementById('spec-name').textContent     = s.name;
    document.getElementById('spec-units').textContent    = s.units;
    document.getElementById('spec-range').textContent    = s.range;
    document.getElementById('spec-better').textContent   = s.better;
    document.getElementById('spec-tradeoff').textContent = s.tradeoff;
    document.getElementById('spec-matters').textContent  = s.matters;

    const v = document.getElementById('spec-verdict');
    v.classList.remove('is-warning', 'is-critical');
    v.innerHTML = '<strong>' + s.name + '.</strong> ' + s.verdict;

    const cw = getCanvasCtx('canvas-spec');
    if (cw) drawSpecVisual(cw.ctx, cw.w, cw.h, s.visual);
  }

  function drawModality() {
    const m = MODALITIES[state.modality.mod];
    document.getElementById('mod-pri-qe').textContent  = m.pri.qe  + ' / 3';
    document.getElementById('mod-pri-rn').textContent  = m.pri.rn  + ' / 3';
    document.getElementById('mod-pri-px').textContent  = m.pri.px  + ' / 3';
    document.getElementById('mod-pri-fov').textContent = m.pri.fov + ' / 3';
    document.getElementById('mod-pri-dr').textContent  = m.pri.dr  + ' / 3';
    document.getElementById('mod-pri-fps').textContent = m.pri.fps + ' / 3';
    document.getElementById('mod-rec-fam').textContent    = m.family;
    document.getElementById('mod-rec-budget').textContent = m.budget;
    document.getElementById('mod-rec-pick').textContent   = m.pick;

    const v = document.getElementById('mod-verdict');
    v.classList.remove('is-warning', 'is-critical');
    v.innerHTML = '<strong>' + m.name + '.</strong> ' + m.summary;

    const cw = getCanvasCtx('canvas-modality');
    if (cw) drawModalityBars(cw.ctx, cw.w, cw.h, state.modality.mod);
  }

  function drawSnr() {
    const s = state.snr;
    document.getElementById('snr-signal-out').textContent = s.signal;
    document.getElementById('snr-bg-out').textContent     = s.bg;
    document.getElementById('snr-qe-out').textContent     = s.qe;
    document.getElementById('snr-rn-out').textContent     = s.rn.toFixed(1);
    document.getElementById('snr-dc-out').textContent     = s.dc.toFixed(2);
    document.getElementById('snr-t-out').textContent      = s.t.toFixed(2);

    const r = computeSnr(s);
    document.getElementById('snr-sig-e').textContent      = r.sigE.toFixed(1) + ' e-';
    document.getElementById('snr-bg-e').textContent       = r.bgE.toFixed(1) + ' e-';
    document.getElementById('snr-dark-e').textContent     = r.darkE.toFixed(2) + ' e-';
    document.getElementById('snr-total-noise').textContent = r.totalNoise.toFixed(2) + ' e-';
    document.getElementById('snr-value').textContent      = r.snr.toFixed(2);
    document.getElementById('snr-regime').textContent     = r.dominant.label;

    const v = document.getElementById('snr-verdict');
    v.classList.remove('is-warning', 'is-critical');
    let verdict;
    if (r.snr >= 10) {
      verdict = '<strong>SNR = ' + r.snr.toFixed(1) + ' — publication quality.</strong> ' +
                'Noise is ' + r.dominant.label + '. ';
      verdict += r.dominant.key === 'shot'
        ? 'You\'re photon-limited — the only way up is higher QE or longer exposure.'
        : (r.dominant.key === 'bg'
           ? 'The fix is better filters or TIRF, not a better camera.'
           : (r.dominant.key === 'read'
              ? 'A lower-read-noise camera (qCMOS) would still help, but you\'re comfortable here.'
              : 'Cooling or shorter exposures would help.'));
    } else if (r.snr >= 3) {
      v.classList.add('is-warning');
      verdict = '<strong>SNR = ' + r.snr.toFixed(1) + ' — usable but noisy.</strong> ' +
                'Noise is ' + r.dominant.label + '. ';
      verdict += r.dominant.key === 'read'
        ? 'Halving read noise (sCMOS → qCMOS) is the biggest single lever.'
        : (r.dominant.key === 'dark'
           ? 'Drop dark current with deeper cooling, or shorten the exposure.'
           : (r.dominant.key === 'bg'
              ? 'Cut background with cleaner filters, TIRF, or a confocal pinhole.'
              : 'Push signal up (longer exposure or higher QE).'));
    } else {
      v.classList.add('is-critical');
      verdict = '<strong>SNR = ' + r.snr.toFixed(1) + ' — barely above the noise floor.</strong> ' +
                'Dominant noise: ' + r.dominant.label + '. ';
      verdict += 'You probably can\'t see your structure here without averaging or denoising. Investigate filters, exposure, and camera QE before pushing analysis.';
    }
    v.innerHTML = verdict;

    const cw = getCanvasCtx('canvas-snr');
    if (cw) drawSnrImage(cw.ctx, cw.w, cw.h, s);
  }

  function drawPick() {
    const p = state.pick;
    document.getElementById('pick-budget-out').textContent = p.budget.toLocaleString();

    const m = MODALITIES[p.modality];
    const prefs = { needFov: p.needFov, needFast: p.needFast, needLowNoise: p.needLowNoise };

    const scored = CATALOG
      .filter(cam => cam.price <= p.budget)
      .map(cam => ({ cam, ...scoreCamera(cam, m.pri, prefs) }))
      .sort((a, b) => b.score - a.score);

    const v = document.getElementById('pick-verdict');
    const ss = document.getElementById('pick-signoff');
    v.classList.remove('is-warning', 'is-critical');

    if (!scored.length) {
      v.classList.add('is-critical');
      v.innerHTML = '<strong>No catalog camera fits under $' + p.budget.toLocaleString() + '.</strong> ' +
                    'Raise the budget — the cheapest fluorescence-capable camera in the catalog is the Thorlabs Quantalux CC215MU at $5,000 (or the Hamamatsu ORCA-Spark at $6,000 for a non-Thorlabs entry).';
      ss.style.display = 'none';
      return;
    }

    const top = scored[0];
    let summary = '<strong>Top pick: ' + top.cam.name + ' (' + fmtUsd(top.cam.price) + ').</strong> ';
    summary += top.cam.blurb + ' ';
    summary += 'For <em>' + m.name + '</em>, this camera scores ' + top.score.toFixed(1) + '. ';
    // Strengths / weaknesses callout
    const strengths = [];
    if (top.qeScore  >= 2.5) strengths.push('high QE');
    if (top.rnScore  >= 2.5) strengths.push('very low read noise');
    if (top.fovScore >= 2.5) strengths.push('large FOV');
    if (top.fpsScore >= 2.5) strengths.push('fast frame rate');
    if (top.drScore  >= 2.5) strengths.push('16-bit dynamic range');
    if (strengths.length) summary += 'Strengths: ' + strengths.join(', ') + '. ';
    summary += 'Always confirm a live vendor quote before submitting a purchase request.';
    v.innerHTML = summary;

    ss.style.display = '';
    document.getElementById('pick-date').textContent = new Date().toISOString().slice(0, 10);

    const tab = document.getElementById('pick-table');
    tab.innerHTML = '';

    // Header row
    const head = document.createElement('div');
    head.className = 'signoff-row';
    head.style.fontWeight = '600';
    head.innerHTML = '<span class="label">Rank · Camera</span><span class="value">QE · RN · Pixel · FOV · fps · Price</span>';
    tab.appendChild(head);

    scored.slice(0, 5).forEach((entry, i) => {
      const c = entry.cam;
      const row = document.createElement('div');
      row.className = 'signoff-row';
      const marker = i === 0 ? '★' : (i + 1);
      row.innerHTML =
        '<span class="label">' + marker + '. ' + c.name + '<br><span style="font-size:11px;color:var(--text-muted);">' + c.blurb + '</span></span>' +
        '<span class="value" style="text-align:right;font-size:12px;">' +
          c.qePeak + '% · ' +
          c.rn.toFixed(1) + ' e- · ' +
          c.pxUm + ' µm · ' +
          c.diagMm + ' mm · ' +
          c.fps + ' fps<br>' +
          '<strong>' + fmtUsd(c.price) + '</strong>' +
        '</span>';
      tab.appendChild(row);
    });

    if (scored.length > 5) {
      const more = document.createElement('div');
      more.className = 'signoff-row';
      more.innerHTML = '<span class="label">(' + (scored.length - 5) + ' more under budget not shown)</span><span class="value"></span>';
      tab.appendChild(more);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Wiring
  // ─────────────────────────────────────────────────────────────────

  function wireTabs() {
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.addEventListener('click', () => setActiveTab(b.dataset.tab));
    });
  }

  function wireSensorsTab() {
    document.querySelectorAll('#tab-sensors .fam-btn').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('#tab-sensors .fam-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        state.sensors.fam = b.dataset.fam;
        drawSensors();
      });
    });
  }

  function wireSpecsTab() {
    document.querySelectorAll('#tab-specs .spec-btn').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('#tab-specs .spec-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        state.specs.spec = b.dataset.spec;
        drawSpecs();
      });
    });
  }

  function wireModalityTab() {
    document.querySelectorAll('#tab-modality .mod-btn').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('#tab-modality .mod-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        state.modality.mod = b.dataset.mod;
        drawModality();
      });
    });
  }

  function wireSnrTab() {
    const map = [
      ['snr-signal', 'signal', parseInt],
      ['snr-bg',     'bg',     parseInt],
      ['snr-qe',     'qe',     parseInt],
      ['snr-rn',     'rn',     parseFloat],
      ['snr-dc',     'dc',     parseFloat],
      ['snr-t',      't',      parseFloat],
    ];
    map.forEach(([id, key, parser]) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', (e) => {
        state.snr[key] = parser(e.target.value);
        drawSnr();
      });
    });
  }

  function wirePickTab() {
    document.getElementById('pick-budget').addEventListener('input', (e) => {
      state.pick.budget = parseInt(e.target.value, 10);
      drawPick();
    });
    document.getElementById('pick-modality').addEventListener('change', (e) => {
      state.pick.modality = e.target.value;
      drawPick();
    });
    document.getElementById('pick-needfov').addEventListener('change', (e) => {
      state.pick.needFov = e.target.checked; drawPick();
    });
    document.getElementById('pick-needfast').addEventListener('change', (e) => {
      state.pick.needFast = e.target.checked; drawPick();
    });
    document.getElementById('pick-needlownoise').addEventListener('change', (e) => {
      state.pick.needLowNoise = e.target.checked; drawPick();
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
    wireSensorsTab();
    wireSpecsTab();
    wireModalityTab();
    wireSnrTab();
    wirePickTab();
    wireResize();
    drawSensors();
    drawSpecs();
    drawModality();
    drawSnr();
    drawPick();
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) {
      firebridge.whenAuthResolved().then(init).catch(init);
    } else {
      init();
    }
  });
})();

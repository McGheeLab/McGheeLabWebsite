/* training-cell-culture.js — V3.686 interactive notebook.
 *
 * Six tabs:
 *   1. The cabinet      — sash/inflow, grille occlusion, hand speed vs the curtain
 *   2. The incubator    — Henderson-Hasselbalch with a live phenol-red swatch
 *   3. The hands        — the pipetting error budget, term by term
 *   4. Aliquoting       — 1-(1-p)^N and the master-transfer floor
 *   5. Case files       — ten diagnostic cases, four of which are NOT contamination
 *   6. Sign-off         — a scored media-change configuration + printable sheet
 *
 * Self-contained — no external libraries beyond the firebridge auth helper.
 * Canvases are DPR-aware via getCanvasCtx(). State is component-local; no
 * Firestore reads/writes, and nothing on the page is persisted — the PRINTED
 * sheet is the record. Name/date/cell-line are inline <input> fields; this
 * page never calls prompt()/alert()/confirm().
 *
 * The full derivations behind every number here live in the four-lesson
 * modules/cell_culture/ track; this page is the lab-internal competency gate.
 *
 * Introduced V3.686.
 */
(function () {
  'use strict';

  // ── Generic canvas helper (DPR-aware, container-sized) ────────────
  // Copied verbatim from training-microscope-basics.js — the rect.width > 4
  // fallback is what keeps canvases in inactive tabs from rendering at zero.
  function getCanvasCtx(id) {
    const c = document.getElementById(id);
    if (!c) return null;
    const dpr = window.devicePixelRatio || 1;
    const rect = c.getBoundingClientRect();
    const cssW = rect.width  > 4 ? rect.width  : (parseFloat(c.getAttribute('width'))  || 640);
    const cssH = rect.height > 4 ? rect.height : (parseFloat(c.getAttribute('height')) || 280);
    c.width  = Math.round(cssW * dpr);
    c.height = Math.round(cssH * dpr);
    c.style.width  = cssW + 'px';
    c.style.height = cssH + 'px';
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { c, ctx, w: cssW, h: cssH };
  }

  function escapeHtml(s) {
    if (s == null) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }
  const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));
  const num = id => parseFloat(document.getElementById(id).value);
  const chk = id => !!document.getElementById(id).checked;
  const sel = id => document.getElementById(id).value;
  function setOut(id, txt) { const e = document.getElementById(id); if (e) e.textContent = txt; }
  function setVal(id, txt) { const e = document.getElementById(id); if (e) e.textContent = txt; }
  function verdict(id, cls, title, body) {
    const e = document.getElementById(id); if (!e) return;
    e.className = 'val-verdict' + (cls ? ' ' + cls : '');
    e.innerHTML = '<strong>' + title + '</strong>' + body;
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  }
  // Read theme tokens so the canvases follow tokens.css rather than hardcoding.
  function tok(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (e) { return fallback; }
  }
  let COL = {};
  function readTokens() {
    COL = {
      text:   tok('--text', '#1e293b'),
      muted:  tok('--text-muted', '#64748b'),
      border: tok('--border', '#e2e8f0'),
      bg:     tok('--bg', '#f8fafc'),
      surf:   tok('--surface', '#ffffff'),
      pri:    tok('--primary', '#2563eb'),
      red:    tok('--red', '#dc2626'),
      green:  tok('--green', '#16a34a'),
      amber:  '#f59e0b'
    };
  }

  // ── Tab 1: the cabinet ────────────────────────────────────────────
  // NSF/ANSI 49 Class II A2: inflow >= 0.51 m/s at the certified 8 in sash;
  // Q is taken from that condition and held fixed, which is the idealisation
  // v_in = Q/(w h) assumes. The air curtain runs at about 0.5 m/s.
  const CAB = { w: 1.22, sash0: 0.203, vin0: 0.53, vinMin: 0.51, vCurtain: 0.50 };
  CAB.Q = CAB.vin0 * CAB.w * CAB.sash0;

  function cabState() {
    const sash = num('cab-sash'), block = num('cab-block') / 100, hand = num('cab-hand') / 100;
    const vin = CAB.Q / (CAB.w * sash * 0.0254);
    const pi = hand / CAB.vCurtain;
    // room air crosses when its own fluctuation beats the inflow it fights;
    // exponential fluctuations with 0.12 m/s rms in a quiet room
    const base = vin <= 0 ? 1 : Math.exp(-vin / 0.12);
    const esc = clamp(base + 0.62 * block + 0.30 * clamp(pi - 1, 0, 3) / 3, 0, 1);
    return { sash, block, hand, vin, pct: 100 * vin / CAB.vinMin, pi, esc };
  }
  function drawCabinet() {
    const g = getCanvasCtx('canvas-cabinet'); if (!g) return;
    const { ctx, w, h } = g, s = cabState();
    ctx.fillStyle = COL.bg; ctx.fillRect(0, 0, w, h);
    const L = w * 0.26, R = w * 0.96, T = 16, B = h - 26, IW = R - L, IH = B - T;
    const surfY = T + IH * 0.82, sashY = T + IH * (0.08 + 0.034 * s.sash);
    ctx.fillStyle = COL.surf; ctx.fillRect(L, T, IW, IH);
    ctx.strokeStyle = COL.muted; ctx.lineWidth = 2; ctx.strokeRect(L, T, IW, IH);
    ctx.fillStyle = 'rgba(8,145,178,.18)'; ctx.fillRect(L + 3, T + 3, IW - 6, 15);
    ctx.fillStyle = '#0891b2'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('SUPPLY HEPA', L + IW / 2, T + 10);
    // work surface + grille, with the blocked fraction shown
    ctx.fillStyle = COL.border; ctx.fillRect(L + 3, surfY, IW - 6, 8);
    const gw = IW * 0.16;
    ctx.fillStyle = '#475569'; ctx.fillRect(L + 3, surfY, gw, 8);
    if (s.block > 0) { ctx.fillStyle = COL.red; ctx.fillRect(L + 3, surfY, gw * s.block, 8); }
    // sash + opening
    ctx.fillStyle = 'rgba(148,163,184,.30)'; ctx.fillRect(L - 5, T, 10, sashY - T);
    ctx.strokeStyle = COL.text; ctx.lineWidth = 3.5; ctx.beginPath(); ctx.moveTo(L, T); ctx.lineTo(L, sashY); ctx.stroke();
    ctx.strokeStyle = s.pi > 1 ? COL.red : COL.amber; ctx.lineWidth = 1.6;
    ctx.setLineDash(s.pi > 1 ? [3, 5] : []);
    ctx.beginPath(); ctx.moveTo(L, sashY + 2); ctx.lineTo(L, surfY + 8); ctx.stroke(); ctx.setLineDash([]);
    // downflow, splayed when the grille is blocked
    for (let i = 1; i <= 7; i++) {
      const x = L + IW * (0.10 + 0.12 * i);
      const j = s.block * 16 * Math.sin(i * 2.1 + s.block * 8);
      ctx.strokeStyle = s.block > 0.3 ? COL.red : (s.block > 0.1 ? COL.amber : 'rgba(37,99,235,.55)');
      ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.moveTo(x, T + 22); ctx.lineTo(x + j, surfY - 4); ctx.stroke();
    }
    // inflow arrows
    for (let i = 0; i < 3; i++) {
      const y = sashY - 8 - i * 12;
      ctx.strokeStyle = s.vin >= CAB.vinMin ? COL.amber : COL.red; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(L - 42, y); ctx.lineTo(L + IW * 0.05, y + 7); ctx.stroke();
    }
    // the hand
    const hx = L + IW * 0.30, hy = surfY - 44;
    ctx.fillStyle = '#fbcfe8'; ctx.strokeStyle = '#be185d'; ctx.lineWidth = 1.4;
    roundRect(ctx, hx - 24, hy - 11, 48, 22, 8); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#9d174d'; ctx.font = '9px sans-serif'; ctx.fillText('hand', hx, hy);
    // the dish
    ctx.fillStyle = '#fecdd3'; ctx.strokeStyle = COL.red; ctx.lineWidth = 1.4;
    ctx.fillRect(L + IW * 0.60, surfY - 9, 42, 9); ctx.strokeRect(L + IW * 0.60, surfY - 9, 42, 9);
    ctx.fillStyle = COL.muted; ctx.font = '10px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('room', 6, T + 6);
    ctx.fillText('sash ' + s.sash.toFixed(1) + ' in', 6, T + 22);
    ctx.textAlign = 'center';
    ctx.fillText('front grille', L + 3 + gw / 2, surfY + 11);
    ctx.fillText('open dish', L + IW * 0.60 + 21, surfY + 11);
  }
  function updCabinet() {
    const s = cabState();
    setOut('cab-sash-out', s.sash.toFixed(1));
    setOut('cab-block-out', String(Math.round(s.block * 100)));
    setOut('cab-hand-out', String(Math.round(s.hand * 100)));
    setVal('cab-vin', s.vin.toFixed(2) + ' m/s');
    setVal('cab-pct', Math.round(s.pct) + ' %');
    setVal('cab-dead', Math.round(100 * s.block) + ' %');
    setVal('cab-pi', s.pi.toFixed(2) + (s.pi > 1 ? '  (> 1)' : ''));
    setVal('cab-esc', (100 * s.esc).toFixed(1) + ' %');
    drawCabinet();
    if (s.block >= 0.30) {
      verdict('cab-verdict', 'is-critical', 'The grille is ' + Math.round(100 * s.block) + '% covered.',
        ' That fraction of the opening has <b>no inward velocity at all</b> — there is no curtain there to cross — and the rest is now a jet that mixes room air into the work zone rather than holding it out. ' +
        (100 * s.esc).toFixed(0) + '% is reaching the work surface. The cabinet sounds exactly the same as it did at 0%.');
    } else if (s.vin < 0.40) {
      verdict('cab-verdict', 'is-critical', 'The curtain has failed — sash at ' + s.sash.toFixed(1) + ' in.',
        ' Inflow ' + s.vin.toFixed(2) + ' m/s, only ' + Math.round(s.pct) + '% of the 0.51 m/s NSF minimum. v<sub>in</sub> is inverse in sash height, so the last few inches cost the most, and the containment that protects <em>you</em> has gone with it.');
    } else if (s.pi > 1.4) {
      verdict('cab-verdict', 'is-bad', 'Your hands are faster than the protection.',
        ' &Pi; = v<sub>hand</sub>/v<sub>curtain</sub> = ' + s.pi.toFixed(2) + '. Above 1 your arm outruns the air meant to close behind it and drags a slug of room air in with it, once per crossing — and a media change is a dozen crossings. Slow to under 50 cm/s and move <em>parallel</em> to the sash.');
    } else if (s.vin < CAB.vinMin || s.block > 0.10) {
      verdict('cab-verdict', 'is-warning', 'Out of specification, and it looks identical.',
        ' Inflow ' + s.vin.toFixed(2) + ' m/s (' + Math.round(s.pct) + '% of minimum) with ' + Math.round(100 * s.block) + '% of the grille covered. Nothing sounds different and the certification sticker still says it passed — at 8 inches, with the grille clear.');
    } else {
      verdict('cab-verdict', '', 'In specification, and you can see why.',
        ' Inflow <b>' + s.vin.toFixed(2) + ' m/s</b> = ' + Math.round(s.pct) + '% of the NSF minimum, grille clear, &Pi; = ' + s.pi.toFixed(2) + '. Room particles turn down into the front grille before they get past the opening — only ' + (100 * s.esc).toFixed(1) + '% reach the dish. Note that it is the <em>inflow</em> stopping them, not the downflow.');
    }
  }

  // ── Tab 2: the incubator ──────────────────────────────────────────
  const PRSTOPS = [[6.2,234,179,8],[6.6,245,158,11],[6.9,249,115,22],[7.2,239,68,68],
                   [7.4,220,38,38],[7.7,225,29,72],[8.1,190,24,93],[8.8,134,25,143]];
  function phenolRed(p) {
    const S = PRSTOPS;
    if (p <= S[0][0]) return 'rgb(' + S[0][1] + ',' + S[0][2] + ',' + S[0][3] + ')';
    const e = S[S.length - 1];
    if (p >= e[0]) return 'rgb(' + e[1] + ',' + e[2] + ',' + e[3] + ')';
    for (let i = 0; i < S.length - 1; i++) {
      if (p >= S[i][0] && p <= S[i + 1][0]) {
        const u = (p - S[i][0]) / (S[i + 1][0] - S[i][0]);
        return 'rgb(' + Math.round(S[i][1] + u * (S[i+1][1] - S[i][1])) + ',' +
                        Math.round(S[i][2] + u * (S[i+1][2] - S[i][2])) + ',' +
                        Math.round(S[i][3] + u * (S[i+1][3] - S[i][3])) + ')';
      }
    }
    return '#dc2626';
  }
  const phWord = p => p < 6.5 ? 'yellow' : p < 6.9 ? 'orange' : p < 7.15 ? 'orange-red'
    : p < 7.5 ? 'red — normal' : p < 7.8 ? 'pink-red' : p < 8.3 ? 'magenta' : 'purple';
  function incState() {
    const co2 = num('inc-co2'), hco3 = num('inc-hco3'), lact = num('inc-lact');
    const aq = 0.0307 * (co2 / 100 * (760 - 47));
    const left = Math.max(hco3 - lact, 1e-4);
    const ph = 6.1 + Math.log10(left / Math.max(aq, 1e-6));
    return { co2, hco3, lact, aq, left, ph, col: phenolRed(ph), beyond: ph > 8.5 };
  }
  function drawPh() {
    const g = getCanvasCtx('canvas-ph'); if (!g) return;
    const { ctx, w, h } = g, s = incState();
    ctx.fillStyle = COL.bg; ctx.fillRect(0, 0, w, h);
    const bx = w * 0.07, by = 30, bw = 76, bh = h - 78;
    ctx.fillStyle = COL.border; roundRect(ctx, bx + 22, by - 13, 32, 15, 3); ctx.fill();
    ctx.fillStyle = s.col; roundRect(ctx, bx, by, bw, bh, 8); ctx.fill();
    ctx.strokeStyle = 'rgba(15,23,42,.25)'; ctx.lineWidth = 2; roundRect(ctx, bx, by, bw, bh, 8); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.25)'; roundRect(ctx, bx + 7, by + 9, 12, bh - 26, 6); ctx.fill();
    ctx.fillStyle = COL.muted; ctx.font = '11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(phWord(s.ph), bx + bw / 2, by + bh + 8);
    const sx = bx + bw + 44, sw = w - sx - 20, sy = by + 12, sh = 28;
    for (let i = 0; i < sw; i++) { ctx.fillStyle = phenolRed(6 + 3 * i / sw); ctx.fillRect(sx + i, sy, 1.4, sh); }
    ctx.strokeStyle = COL.muted; ctx.lineWidth = 1; ctx.strokeRect(sx, sy, sw, sh);
    ctx.fillStyle = COL.muted; ctx.font = '10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let p = 6; p <= 9; p += 0.5) { const x = sx + sw * (p - 6) / 3; ctx.fillRect(x, sy + sh, 1, 4); ctx.fillText(p.toFixed(1), x, sy + sh + 6); }
    const h0 = sx + sw * (7.1 - 6) / 3, h1 = sx + sw * (7.5 - 6) / 3;
    ctx.strokeStyle = COL.text; ctx.lineWidth = 1.6; ctx.setLineDash([3, 3]);
    ctx.strokeRect(h0, sy - 4, h1 - h0, sh + 8); ctx.setLineDash([]);
    ctx.fillStyle = COL.text; ctx.font = 'bold 10px sans-serif'; ctx.textBaseline = 'bottom';
    ctx.fillText('healthy 7.1 - 7.5', (h0 + h1) / 2, sy - 7);
    const mx = sx + sw * (clamp(s.ph, 6, 9) - 6) / 3;
    ctx.fillStyle = COL.text; ctx.beginPath();
    ctx.moveTo(mx, sy + sh + 16); ctx.lineTo(mx - 6, sy + sh + 26); ctx.lineTo(mx + 6, sy + sh + 26); ctx.closePath(); ctx.fill();
    ctx.font = 'bold 15px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText('pH ' + s.ph.toFixed(2), clamp(mx, sx + 40, sx + sw - 40), sy + sh + 28);
    ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = COL.muted;
    ctx.fillText('pH = 6.1 + log10 ( ' + s.left.toFixed(1) + ' mM HCO3- / ' + s.aq.toFixed(3) + ' mM CO2 )', sx, sy + sh + 56);
    if (s.beyond) { ctx.fillStyle = COL.amber; ctx.fillText('above pH 8.5 bicarbonate is no longer the only buffer', sx, sy + sh + 74); }
  }
  function updIncubator() {
    const s = incState();
    setOut('inc-co2-out', s.co2.toFixed(2));
    setOut('inc-hco3-out', String(Math.round(s.hco3)));
    setOut('inc-lact-out', String(Math.round(s.lact)));
    setVal('inc-aq', s.aq.toFixed(3) + ' mM');
    setVal('inc-left', s.left.toFixed(1) + ' mM');
    setVal('inc-ph', s.ph.toFixed(2));
    setVal('inc-col', phWord(s.ph));
    drawPh();
    if (s.beyond) {
      verdict('inc-verdict', 'is-critical', 'Alkaline, and off the end of the model.',
        ' At ' + s.co2.toFixed(2) + '% CO<sub>2</sub> there is almost nothing acidic dissolved, so the equation returns pH ' + s.ph.toFixed(2) + '. Real medium stops around 8.2–8.5 — protein and any HEPES take over as buffers and outgassing is slow. Trust the <em>direction</em>: a bottle out of the incubator goes alkaline within minutes, which is why medium is warmed with a loose cap and put back promptly.');
    } else if (s.lact > 12) {
      verdict('inc-verdict', 'is-critical', 'This is what "left too long" looks like.',
        ' ' + Math.round(s.lact) + ' mM of lactate has eaten through the bicarbonate, leaving <b>' + s.left.toFixed(1) + ' mM</b>. The gas has not changed — the box is still at ' + s.co2.toFixed(1) + '% — but the top of the ratio collapsed, so the pH is ' + s.ph.toFixed(2) + ' and the bottle is ' + phWord(s.ph) + '. Nothing failed. The cells did what cells do, for one day longer than anyone was watching.');
    } else if (s.ph > 7.5) {
      verdict('inc-verdict', 'is-warning', 'Alkaline — and the medium, not the box, is usually why.',
        ' pH ' + s.ph.toFixed(2) + ' with ' + Math.round(s.hco3) + ' mM bicarbonate at ' + s.co2.toFixed(1) + '% CO<sub>2</sub>. If this is DMEM it is not broken: 3.7 g/L NaHCO<sub>3</sub> is a <b>10% CO<sub>2</sub></b> formulation. Match the gas to the bottle, or use the low-bicarbonate version. Check the label before you blame the incubator.');
    } else if (s.ph < 6.9) {
      verdict('inc-verdict', 'is-bad', 'Acid. Change the medium now.',
        ' pH ' + s.ph.toFixed(2) + ' — visibly ' + phWord(s.ph) + ' through the door. Attached cells usually recover from a medium change, but they now have an acid-stress history, and that belongs in the notebook rather than silently inside your next experiment.');
    } else {
      verdict('inc-verdict', '', 'This is the colour you are trying to see.',
        ' pH <b>' + s.ph.toFixed(2) + '</b> from ' + s.left.toFixed(1) + ' mM bicarbonate over ' + s.aq.toFixed(3) + ' mM dissolved CO<sub>2</sub>. 5% is not a magic number — it is the CO<sub>2</sub> that balances about 24 mM bicarbonate at pH 7.4. The setting belongs to the <em>medium formulation</em>.');
    }
  }

  // ── Tab 3: the hands ──────────────────────────────────────────────
  const RANGES = [10, 100, 200, 1000];
  function hndState() {
    const V = num('hnd-vol'), R = RANGES[clamp(Math.round(num('hnd-range')), 0, 3)], T = num('hnd-temp');
    const Vset = Math.min(V, R);
    const cushion = Math.max(0.15 * R + 0.85 * (R - Vset), 0);
    const t = {
      sys:   0.008 * Math.sqrt(R * Vset),
      film:  (chk('hnd-prewet') ? 0.002 : 0.012) * Vset,
      therm: 0.25 * cushion * (T - 22) / 295,
      angle: chk('hnd-vert')  ? 0 : 0.006 * Vset,
      depth: chk('hnd-depth') ? 0 : 0.009 * Vset,
      wait:  chk('hnd-wait')  ? 0 : 0.005 * Vset,
      wall:  chk('hnd-wall')  ? 0 : 0.007 * Vset
    };
    const tot = t.sys + t.film + t.therm + t.angle + t.depth + t.wait + t.wall;
    const Rfit = RANGES.reduce((b, r) => (r >= V && (b === null || r < b)) ? r : b, null) || RANGES[3];
    const off = ['hnd-prewet','hnd-vert','hnd-depth','hnd-wait','hnd-wall'].filter(k => !chk(k)).length + (Rfit !== R ? 1 : 0);
    return { V, R, Rfit, Vset, T, cushion, t, tot, pct: 100 * tot / Math.max(Vset, 1e-9), over: V > R, off };
  }
  function drawHands() {
    const g = getCanvasCtx('canvas-hands'); if (!g) return;
    const { ctx, w, h } = g, s = hndState();
    ctx.fillStyle = COL.bg; ctx.fillRect(0, 0, w, h);
    const rows = [
      ['pipettor vs volume', s.t.sys, '#7c3aed'],
      ['dry tip keeps a film', s.t.film, '#0891b2'],
      ['warm hand expands the cushion', s.t.therm, COL.amber],
      ['held at an angle', s.t.angle, COL.red],
      ['immersion depth', s.t.depth, '#ec4899'],
      ['withdrew too soon', s.t.wait, '#14b8a6'],
      ['no touch-off', s.t.wall, '#84cc16']
    ];
    const L = 190, R = w - 96, T = 12, rh = 26;
    const scale = Math.max(s.tot, 1e-3);
    ctx.font = '11px sans-serif'; ctx.textBaseline = 'middle';
    rows.forEach((r, i) => {
      const y = T + i * rh + 10;
      ctx.textAlign = 'right'; ctx.fillStyle = r[1] > 1e-9 ? COL.text : COL.border;
      ctx.fillText(r[0], L - 10, y);
      ctx.fillStyle = COL.border; roundRect(ctx, L, y - 7, R - L, 14, 7); ctx.fill();
      if (r[1] > 1e-9) { ctx.fillStyle = r[2]; roundRect(ctx, L, y - 7, Math.max((R - L) * clamp(r[1] / scale, 0, 1), 4), 14, 7); ctx.fill(); }
      ctx.textAlign = 'left'; ctx.fillStyle = r[1] > 1e-9 ? COL.text : COL.border;
      ctx.font = 'bold 11px sans-serif'; ctx.fillText(r[1] > 1e-9 ? r[1].toFixed(3) + ' µL' : 'off', R + 8, y);
      ctx.font = '11px sans-serif';
    });
    const yT = T + rows.length * rh + 12;
    ctx.strokeStyle = COL.border; ctx.beginPath(); ctx.moveTo(20, yT - 8); ctx.lineTo(R + 76, yT - 8); ctx.stroke();
    ctx.textAlign = 'left'; ctx.fillStyle = COL.muted;
    ctx.fillText('you asked for ' + Math.round(s.Vset) + ' µL and delivered', 20, yT + 6);
    ctx.font = 'bold 20px sans-serif';
    ctx.fillStyle = s.pct > 3 ? COL.red : (s.pct > 1 ? COL.amber : COL.green);
    ctx.fillText((s.Vset - s.tot).toFixed(2) + ' µL', 20, yT + 28);
    ctx.font = '12px sans-serif'; ctx.fillText('short by ' + s.pct.toFixed(2) + '%', 160, yT + 30);
  }
  function updHands() {
    const s = hndState();
    setOut('hnd-vol-out', String(Math.round(s.V)));
    setOut('hnd-range-out', String(s.R));
    setOut('hnd-temp-out', s.T.toFixed(1));
    setVal('hnd-cush', Math.round(s.cushion) + ' µL');
    setVal('hnd-del', (s.Vset - s.tot).toFixed(2) + ' µL');
    setVal('hnd-err', s.pct.toFixed(2) + ' %');
    const big = Object.keys(s.t).reduce((a, b) => s.t[a] >= s.t[b] ? a : b);
    const NAMES = { sys: 'wrong pipettor', film: 'dry tip', therm: 'warm hand', angle: 'held at an angle', depth: 'immersion depth', wait: 'withdrew too soon', wall: 'no touch-off' };
    setVal('hnd-big', s.tot > 1e-9 ? NAMES[big] : 'none');
    drawHands();
    if (s.over) {
      verdict('hnd-verdict', 'is-critical', 'Past the top of this pipettor.',
        ' ' + Math.round(s.V) + ' µL from a 0–' + s.R + ' µL device is not a small error, it is an impossible request. On the bench this is the mistake that silently halves a reaction.');
    } else if (s.pct > 4) {
      verdict('hnd-verdict', 'is-critical', 'Over 4% out, with ' + s.off + ' habit' + (s.off === 1 ? '' : 's') + ' switched off.',
        ' <b>' + s.pct.toFixed(2) + '%</b>, dominated by <em>' + NAMES[big] + '</em>. Nothing here is a hardware fault — every bar is a decision made in the two seconds before the plunger moved.');
    } else if (s.pct > 1) {
      verdict('hnd-verdict', 'is-warning', 'About ' + s.pct.toFixed(1) + '% out. Invisible today, expensive later.',
        ' Largest remaining term: <em>' + NAMES[big] + '</em>. A 1–4% systematic error never shows up in a single measurement — it shows up as an EC<sub>50</sub> that shifts when someone else runs the assay.');
    } else if (s.Rfit !== s.R) {
      verdict('hnd-verdict', 'is-warning', 'Good technique, wrong device.',
        ' ' + s.pct.toFixed(2) + '% — but you are taking ' + Math.round(s.Vset) + ' µL from a 0–' + s.R + ' µL pipettor when a 0–' + s.Rfit + ' µL one is the right tool. Accuracy is specified near nominal and degrades below it.');
    } else {
      verdict('hnd-verdict', '', 'Under 1%. That is what the habits buy you.',
        ' ' + s.pct.toFixed(2) + '% short of ' + Math.round(s.Vset) + ' µL, on the 0–' + s.R + ' µL device, with only a ' + Math.round(s.cushion) + ' µL air cushion. None of it took longer than doing it badly.');
    }
  }

  // ── Tab 4: aliquoting ─────────────────────────────────────────────
  const STOCK_V = 500;
  function alqState() {
    const k = Math.round(num('alq-k')), N = Math.round(num('alq-n')), p = num('alq-p') / 100, pm = num('alq-m') / 100;
    const pf = pm * 0.3;
    const use = kk => 1 - Math.pow(1 - p, Math.max(N / kk, 1));
    const loss = kk => STOCK_V * ((kk > 1 ? pm + pf : 0) + use(kk));
    const one = STOCK_V * use(1), now = loss(k), floor = STOCK_V * (pm + pf + (1 - (1 - p)));
    return { k, N, p, pm, one, now, floor, loss, ratio: one / Math.max(now, 1e-9) };
  }
  function drawAliquot() {
    const g = getCanvasCtx('canvas-aliquot'); if (!g) return;
    const { ctx, w, h } = g, s = alqState();
    ctx.fillStyle = COL.bg; ctx.fillRect(0, 0, w, h);
    const L = 62, R = w - 18, T = 18, B = h - 42, yMax = Math.max(s.one * 1.08, 1e-6);
    const toX = k => L + (k - 1) / 99 * (R - L);
    const toY = v => B - clamp(v / yMax, 0, 1) * (B - T);
    ctx.strokeStyle = COL.border; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    for (let i = 0; i <= 4; i++) { const y = T + (B - T) * i / 4; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(R, y); ctx.stroke(); }
    ctx.setLineDash([]);
    ctx.strokeStyle = COL.muted; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(L, T); ctx.lineTo(L, B); ctx.lineTo(R, B); ctx.stroke();
    ctx.fillStyle = COL.muted; ctx.font = '10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    [1, 20, 40, 60, 80, 100].forEach(k => ctx.fillText(String(k), toX(k), B + 6));
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) { const v = yMax * (1 - i / 4); ctx.fillText(v.toFixed(v < 10 ? 1 : 0), L - 6, T + (B - T) * i / 4); }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = COL.text; ctx.font = '11px sans-serif';
    ctx.fillText('number of aliquots', (L + R) / 2, B + 20);
    ctx.save(); ctx.translate(14, (T + B) / 2); ctx.rotate(-Math.PI / 2); ctx.textBaseline = 'middle';
    ctx.fillText('expected loss (mL)', 0, 0); ctx.restore();
    ctx.strokeStyle = COL.pri; ctx.lineWidth = 2.4; ctx.beginPath();
    for (let k = 1; k <= 100; k++) { const x = toX(k), y = toY(s.loss(k)); if (k === 1) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.stroke();
    ctx.strokeStyle = COL.amber; ctx.lineWidth = 1.4; ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(L, toY(s.floor)); ctx.lineTo(R, toY(s.floor)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = COL.amber; ctx.font = '10px sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillText('floor: the transfer that made them = ' + s.floor.toFixed(2) + ' mL', R - 4, toY(s.floor) - 3);
    const px = toX(clamp(s.k, 1, 100)), py = toY(s.now);
    ctx.beginPath(); ctx.arc(px, py, 6, 0, 6.284);
    ctx.fillStyle = s.ratio > 8 ? COL.green : (s.ratio > 3 ? COL.amber : COL.red); ctx.fill();
    ctx.strokeStyle = COL.text; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = COL.text; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(s.now.toFixed(2) + ' mL', clamp(px + 11, 0, w - 80), py);
  }
  function updAliquot() {
    const s = alqState();
    setOut('alq-k-out', String(s.k));
    setOut('alq-n-out', String(s.N));
    setOut('alq-p-out', (100 * s.p).toFixed(2));
    setOut('alq-m-out', (100 * s.pm).toFixed(2));
    const size = STOCK_V / s.k;
    setVal('alq-size', size.toFixed(size < 1 ? 2 : 1) + ' mL');
    setVal('alq-each', Math.max(s.N / s.k, 1).toFixed(1));
    setVal('alq-loss', s.now.toFixed(2) + ' mL');
    setVal('alq-floor', s.floor.toFixed(2) + ' mL');
    setVal('alq-ratio', s.ratio.toFixed(1) + ' × better');
    drawAliquot();
    if (s.k === 1) {
      verdict('alq-verdict', 'is-bad', 'One bottle. This is the baseline.',
        ' ' + s.N + ' entries at ' + (100 * s.p).toFixed(2) + '% gives P = ' + (100 * (1 - Math.pow(1 - s.p, s.N))).toFixed(1) + '%, and each of those events costs the whole 500 mL. Expected loss <b>' + s.now.toFixed(1) + ' mL</b> — ' + Math.round(100 * s.now / STOCK_V) + '% of the stock, on average, with technique you would call good.');
    } else if (s.now <= s.floor * 1.12) {
      verdict('alq-verdict', '', 'You have hit the floor. Look at what is holding it up.',
        ' ' + s.now.toFixed(2) + ' mL — <b>' + Math.round(s.ratio) + '× better</b> than one bottle — and splitting further changes almost nothing, because what is left is the <em>master transfer</em>. If that goes wrong every aliquot is contaminated identically. Aliquoting does not remove risk so much as <b>concentrate it into one moment you can prepare for</b>.');
    } else if (s.ratio > 4) {
      verdict('alq-verdict', '', Math.round(s.ratio) + '× better, for zero change in technique.',
        ' ' + s.k + ' aliquots of ' + size.toFixed(2) + ' mL: each entered ' + Math.max(s.N / s.k, 1).toFixed(1) + ' times instead of ' + s.N + ', and each holding a ' + s.k + 'th as much. Probability and blast radius both fell. Your p did not move at all.');
    } else {
      verdict('alq-verdict', 'is-warning', 'Better, but barely off the baseline.',
        ' ' + s.now.toFixed(1) + ' mL against ' + s.one.toFixed(1) + ' for one bottle — only ' + s.ratio.toFixed(1) + '×. Each tube is still entered ' + Math.max(s.N / s.k, 1).toFixed(1) + ' times, so its own exponent is still doing damage. Push k until each aliquot is opened once or twice.');
    }
  }

  // ── Tab 6: the sign-off ───────────────────────────────────────────
  // Nine configuration decisions. `crit` marks the five whose failure loses
  // more than one flask; the sheet only passes when all five are right AND
  // every decision has been made.
  const SO = [
    { id: 'so-sash',     best: '8',       crit: true,
      bad: { '12': 'Sash at 12 in — inflow drops to about 0.35 m/s, roughly 69% of the NSF minimum. It sounds identical.',
             '18': 'Sash as high as it goes — inflow is well under half the minimum and the cabinet is containing nothing.' } },
    { id: 'so-warm',     best: 'bead',    crit: false,
      bad: { 'water': 'A water bath is workable if it is cleaned often, but it is a documented reservoir; a bead bath removes the failure mode entirely.',
             'wet':   'A wet bottle straight into the cabinet drips contaminated bath water into the work zone — this is the exact case the guidance calls out.' } },
    { id: 'so-layout',   best: 'good',    crit: true,
      bad: { 'reach': 'Everything at the front covers the intake grille. That span of the opening then has no inward flow at all — the curtain is not weakened there, it is absent.',
             'store': 'Yesterday\'s racks are bioburden AND wakes. "Do not use the hood as a storage area" is about airflow as much as cleanliness.' } },
    { id: 'so-pipette',  best: 'plunger', crit: false,
      bad: { 'tip':  'Opening the pointed end drags the part that goes into your medium across a torn, unsterile wrapper edge.',
             'down': 'Anything laid on the work surface is no longer sterile, however clean the surface looks.' } },
    { id: 'so-aspirate', best: 'asp',     crit: false,
      bad: { 'pour': 'Pouring wets the neck, and a 0.1 mm thread gap lifts medium about 8 cm — you have built a continuous path from the medium to the outside.',
             'blow': 'Blowing out into air makes a droplet population that stays airborne for minutes. Touch off against the wall instead.' } },
    { id: 'so-fresh',    best: 'clean',   crit: true,
      bad: { 'used': 'This is the step that loses a shelf. A pipette that has been inside a flask must never re-enter a shared stock bottle.',
             'new':  'Safe, but a fresh pipette per flask is six times the plastic for no additional protection — the clean-pipette rule already covers it.' } },
    { id: 'so-open',     best: 'one',     crit: true,
      bad: { 'three': 'A compromise between a rule and no rule is no rule. Three open vessels is three exposures and reaches that cross them.',
             'all':   'Six open flasks for the whole procedure, and every reach crosses one of them.' } },
    { id: 'so-move',     best: 'slow',    crit: true,
      bad: { 'fast': 'Above about 50 cm/s your hand outruns the air curtain and drags room air in with it, once per crossing.',
             'over': 'A reach-over is ten to a hundred times the baseline. Once is survivable; two hundred times a month is the problem.' } },
    { id: 'so-finish',   best: 'clean',   crit: false,
      bad: { 'later': '"Later" is how a cabinet becomes a storage shelf, and the work surface stays contaminated in the meantime.',
             'off':   'Leave it running through the work week. Live mycoplasma has been recovered from a hood surface four to six days after a spill — the filter is not what wears out.' } }
  ];

  function soState() {
    let done = 0, crit = 0, critTotal = 0, flags = [];
    SO.forEach(q => {
      const v = sel(q.id);
      if (q.crit) critTotal++;
      if (!v) return;
      done++;
      if (v === q.best) { if (q.crit) crit++; }
      else flags.push({ id: q.id, crit: q.crit, why: q.bad[v] || 'Not the right choice here.' });
    });
    const branch = quizScore('cc-branch');
    const cases  = quizScore('cc-cases');
    const pass = done === SO.length && crit === critTotal && flags.length === 0 && branch.right === branch.total && cases.right >= 8;
    return { done, crit, critTotal, flags, branch, cases, pass };
  }
  function updSignoff() {
    const s = soState();
    setVal('so-done', s.done + ' / ' + SO.length);
    setVal('so-crit', s.crit + ' / ' + s.critTotal);
    setVal('so-result', s.pass ? 'PASS' : (s.done < SO.length ? 'incomplete' : 'not yet'));
    const box = document.getElementById('so-critique');
    if (box) {
      if (!s.done) box.innerHTML = '<p class="cc-crit-empty">Make your choices on the left; the critique appears here.</p>';
      else if (!s.flags.length) box.innerHTML = '<p class="cc-crit-ok">Nothing flagged in the ' + s.done + ' decision' + (s.done === 1 ? '' : 's') + ' made so far.</p>';
      else box.innerHTML = s.flags.map(f =>
        '<p class="cc-crit-item' + (f.crit ? ' is-crit' : '') + '">' +
        (f.crit ? '<span class="cc-crit-tag">critical</span>' : '<span class="cc-crit-tag is-minor">fix</span>') +
        escapeHtml(f.why) + '</p>').join('');
    }
    const sheet = document.getElementById('so-sheet');
    if (sheet) sheet.style.display = s.done === SO.length ? '' : 'none';
    setVal('so-ss-cab', sel('so-sash') === '8' && sel('so-layout') === 'good' ? 'sash at the mark, front strip clear, waste downstream' : 'FLAGGED — see critique');
    setVal('so-ss-path', sel('so-fresh') === 'clean' && sel('so-open') === 'one' && sel('so-move') === 'slow' ? 'one vessel open, one pipette per liquid, no reach-over' : 'FLAGGED — see critique');
    setVal('so-ss-branch', s.branch.right + ' / ' + s.branch.total + ' correct');
    setVal('so-ss-cases', s.cases.right + ' / ' + s.cases.total + ' correct');
    const p = document.getElementById('so-pass'), f = document.getElementById('so-fail');
    if (p) p.style.display = s.pass ? '' : 'none';
    if (f) f.style.display = (!s.pass && s.done === SO.length) ? '' : 'none';
    if (s.done < SO.length) {
      verdict('so-verdict', 'is-warning', s.done + ' of ' + SO.length + ' decisions made.',
        ' Work down the controls on the left. The sheet appears once every decision has an answer — including the ones you are not sure about, because the critique is where the value is.');
    } else if (s.pass) {
      verdict('so-verdict', '', 'Pass. Print it and bring it.',
        ' All ' + s.critTotal + ' critical items right, ' + s.branch.right + '/' + s.branch.total + ' branch points and ' + s.cases.right + '/' + s.cases.total + ' case files. Fill in your name, the date and the cell line, print the sheet, and bring it to your first supervised session — the three observed items at the bottom are the half of this that only a person standing next to you can sign.');
    } else {
      const nCrit = s.flags.filter(x => x.crit).length;
      verdict('so-verdict', nCrit ? 'is-critical' : 'is-bad', 'Not yet — ' + (nCrit ? nCrit + ' critical item' + (nCrit === 1 ? '' : 's') + ' flagged.' : 'close, but something is still off.'),
        ' ' + (nCrit ? 'A critical item is one whose failure costs more than a single flask.' : 'Nothing critical is wrong; fix the flagged items and complete the branch points and case files.') +
        ' Branch points ' + s.branch.right + '/' + s.branch.total + ', case files ' + s.cases.right + '/' + s.cases.total + ' (8 needed).');
    }
  }

  // ── Quizzes (case files + branch points) ──────────────────────────
  // Re-pickable; the score recomputes on every click, and the sign-off reads it.
  const QUIZ = {};
  function quizScore(id) {
    const q = QUIZ[id];
    if (!q) { const n = document.querySelectorAll('#' + id + ' .rm-quiz-item').length; return { right: 0, total: n }; }
    let right = 0;
    q.items.forEach(it => { if (it.picked === it.truth) right++; });
    return { right: right, total: q.items.length };
  }
  function wireQuiz(id, scoreId) {
    const quiz = document.getElementById(id);
    if (!quiz) return;
    const items = [].slice.call(quiz.querySelectorAll('.rm-quiz-item')).map(el => ({ el: el, truth: el.dataset.correct, picked: null }));
    QUIZ[id] = { items: items };
    items.forEach(item => {
      const choices = item.el.querySelectorAll('.choices button');
      const explain = item.el.querySelector('.explain');
      choices.forEach(btn => {
        btn.addEventListener('click', () => {
          choices.forEach(b => b.classList.remove('picked', 'correct', 'wrong'));
          item.picked = btn.dataset.choice;
          const ok = item.picked === item.truth;
          btn.classList.add('picked', ok ? 'correct' : 'wrong');
          if (explain) explain.classList.add('shown');
          const sc = quizScore(id);
          const el = document.getElementById(scoreId);
          if (el) el.textContent = sc.right + ' / ' + sc.total;
          updSignoff();
        });
      });
    });
    const el = document.getElementById(scoreId);
    if (el) el.textContent = '0 / ' + items.length;
  }

  // ── Tabs, scenario bars, wiring ───────────────────────────────────
  let activeTab = 'tab-cabinet';
  function setActiveTab(tabId) {
    activeTab = tabId;
    document.querySelectorAll('.tab-btn').forEach(b => {
      const on = b.dataset.tab === tabId;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.tab-content').forEach(s => s.classList.toggle('active', s.id === tabId));
    window.scrollTo({ top: 0 });
    refresh();
  }
  function wireTabs() {
    document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => setActiveTab(b.dataset.tab)));
  }
  function wireScenarios() {
    document.querySelectorAll('.scenario-bar').forEach(bar => {
      const btns = bar.querySelectorAll('.scen-btn');
      btns.forEach(btn => btn.addEventListener('click', () => {
        btns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        Object.keys(btn.dataset).forEach(k => {
          if (k === 'scen') return;
          const map = { sash: 'cab-sash', block: 'cab-block', hand: 'cab-hand',
                        hco3: 'inc-hco3', co2: 'inc-co2', lact: 'inc-lact' };
          const el = map[k] && document.getElementById(map[k]);
          if (el) el.value = btn.dataset[k];
        });
        refresh();
      }));
    });
  }
  function wireInputs() {
    ['cab-sash','cab-block','cab-hand','inc-co2','inc-hco3','inc-lact',
     'hnd-vol','hnd-range','hnd-temp','alq-k','alq-n','alq-p','alq-m'].forEach(id => {
      const el = document.getElementById(id); if (el) el.addEventListener('input', refresh);
    });
    ['hnd-prewet','hnd-vert','hnd-depth','hnd-wait','hnd-wall'].forEach(id => {
      const el = document.getElementById(id); if (el) el.addEventListener('change', refresh);
    });
    SO.forEach(q => { const el = document.getElementById(q.id); if (el) el.addEventListener('change', updSignoff); });
  }
  function wireResize() {
    let t = null;
    const go = () => { clearTimeout(t); t = setTimeout(refresh, 120); };
    window.addEventListener('resize', go);
    window.addEventListener('orientationchange', go);
  }
  function refresh() {
    try {
      if (activeTab === 'tab-cabinet')        updCabinet();
      else if (activeTab === 'tab-incubator') updIncubator();
      else if (activeTab === 'tab-hands')     updHands();
      else if (activeTab === 'tab-aliquot')   updAliquot();
      else if (activeTab === 'tab-signoff')   updSignoff();
    } catch (e) { console.error('cell-culture refresh', e); }
  }

  function init() {
    readTokens();
    wireTabs();
    wireScenarios();
    wireInputs();
    wireResize();
    wireQuiz('cc-cases', 'cc-cases-score');
    wireQuiz('cc-branch', 'cc-branch-score');
    // Default the sign-off date to today so the printed sheet is never blank-dated.
    const d = document.getElementById('so-date');
    if (d && !d.value) { const n = new Date(); d.value = n.toISOString().slice(0, 10); }
    updSignoff();
    refresh();
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (typeof firebridge !== 'undefined' && firebridge.requireSignIn) {
      firebridge.requireSignIn('Sign in to track your training progress.').then(init).catch(init);
    } else {
      init();
    }
  });
})();

/* kit.js — shared controls, number formatting and canvas plots for the PE-bead simulators.
   Inlined into each page by build.py, so every published page is one self-contained file
   (it runs in Scientia's sandboxed frame: no network, no storage it can count on). */
'use strict';
const K = (() => {
  const SUP = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '' };
  const sup = s => String(s).split('').map(c => SUP[c] ?? c).join('');

  /* ---------- DOM ---------- */
  function h(tag, attrs, ...kids) {
    const m = /^([a-z0-9]+)((?:[.#][\w-]+)*)$/i.exec(tag) || [0, tag, ''];
    const el = document.createElement(m[1]);
    (m[2].match(/[.#][\w-]+/g) || []).forEach(t => t[0] === '.' ? el.classList.add(t.slice(1)) : (el.id = t.slice(1)));
    if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'on') for (const [e, f] of Object.entries(v)) el.addEventListener(e, f);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    const add = x => { if (x == null || x === false) return; if (Array.isArray(x)) return x.forEach(add); el.append(x instanceof Node ? x : document.createTextNode(String(x))); };
    kids.forEach(add);
    return el;
  }
  const $ = (s, r) => (r || document).querySelector(s);
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const color = i => css('--s' + (((i % 8) + 8) % 8 + 1));

  /* ---------- numbers ---------- */
  function fmt(x, sig = 3) {
    if (x == null || Number.isNaN(x)) return '–';
    if (!Number.isFinite(x)) return x > 0 ? '∞' : '−∞';
    if (x === 0) return '0';
    const a = Math.abs(x), e = Math.floor(Math.log10(a));
    if (e >= -2 && e < 5) { const d = Math.max(0, sig - 1 - e); return (x < 0 ? '−' : '') + a.toFixed(Math.min(d, 6)).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''); }
    const m = x / Math.pow(10, e); let ms = Math.abs(m).toFixed(Math.max(0, sig - 1)).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    if (ms === '10') { return fmt(Math.sign(x) * Math.pow(10, e + 1), sig); }
    return (x < 0 ? '−' : '') + (ms === '1' ? '' : ms + '×') + '10' + sup(e);
  }
  const group = n => Math.round(n).toLocaleString('en-US');
  /** A molar concentration with an SI prefix: 3.2e-12 → "3.2 pM". */
  function molar(M, sig = 3) {
    if (!(M > 0)) return M === 0 ? '0 M' : '–';
    const P = [[1e-15, 'fM'], [1e-12, 'pM'], [1e-9, 'nM'], [1e-6, 'µM'], [1e-3, 'mM'], [1, 'M']];
    let p = P[0]; for (const q of P) if (M >= q[0] * 0.9995) p = q;
    return fmt(M / p[0], sig) + ' ' + p[1];
  }
  function dur(s) {
    if (!(s >= 0)) return '–';
    if (s < 60) return fmt(s, 2) + ' s';
    if (s < 3600) return fmt(s / 60, 2) + ' min';
    if (s < 86400 * 2) return fmt(s / 3600, 2) + ' h';
    return fmt(s / 86400, 2) + ' d';
  }
  const pct = (x, d = 1) => (x == null || !Number.isFinite(x)) ? '–' : (x * 100).toFixed(d) + '%';

  /* ---------- controls ---------- */
  /** A labelled slider. log:true maps the track to decades between min and max. */
  function slider(o) {
    const log = !!o.log, N = o.steps || 400;
    const toPos = v => log ? Math.round(N * (Math.log10(v) - Math.log10(o.min)) / (Math.log10(o.max) - Math.log10(o.min))) : v;
    const fromPos = p => { if (!log) return +p; const v = Math.pow(10, Math.log10(o.min) + (p / N) * (Math.log10(o.max) - Math.log10(o.min))); const e = Math.floor(Math.log10(v)), q = Math.pow(10, e - 2); return Math.round(v / q) * q; };
    const show = v => (o.fmt ? o.fmt(v) : fmt(v)) + (o.unit ? ' ' + o.unit : '');
    const val = h('span.ctl-v'), inp = h('input', { type: 'range', min: log ? 0 : o.min, max: log ? N : o.max, step: log ? 1 : (o.step || 'any'), 'aria-label': o.label });
    const ctl = { value: o.value, el: null, set(v, quiet) { ctl.value = v; inp.value = toPos(v); val.textContent = show(v); if (!quiet && o.onInput) o.onInput(v); } };
    inp.addEventListener('input', () => ctl.set(fromPos(+inp.value)));
    ctl.el = h('div.ctl', h('div.ctl-h', h('span', o.label), val), inp, o.hint ? h('div.ctl-hint', o.hint) : null);
    ctl.set(o.value, true);
    return ctl;
  }
  /** Segmented buttons: options [[value, label], …]. */
  function seg(o) {
    const wrap = h('div.seg', { role: 'group', 'aria-label': o.label || '' });
    const ctl = { value: o.value, el: null, set(v, quiet) { ctl.value = v; [...wrap.children].forEach(b => b.classList.toggle('on', b.dataset.v === String(v))); if (!quiet && o.onInput) o.onInput(v); } };
    o.options.forEach(([v, l, t]) => wrap.append(h('button', { 'data-v': String(v), title: t || '', on: { click: () => ctl.set(v) } }, l)));
    ctl.el = h('div.ctl', o.label ? h('div.ctl-h', h('span', o.label)) : null, wrap, o.hint ? h('div.ctl-hint', o.hint) : null);
    ctl.set(o.value, true);
    return ctl;
  }
  function check(o) {
    const inp = h('input', { type: 'checkbox' });
    const ctl = { value: !!o.value, el: h('label.chk', inp, h('span', o.label, o.hint ? h('div.ctl-hint', o.hint) : null)), set(v, quiet) { ctl.value = !!v; inp.checked = !!v; if (!quiet && o.onInput) o.onInput(!!v); } };
    inp.addEventListener('change', () => ctl.set(inp.checked));
    ctl.set(o.value, true);
    return ctl;
  }
  function tabs(host, list, onChange) {
    const bar = h('div.tabs', { role: 'tablist' }), panes = {};
    let cur = null;
    const go = id => { cur = id; [...bar.children].forEach(b => b.classList.toggle('on', b.dataset.id === id)); for (const [k, p] of Object.entries(panes)) p.style.display = k === id ? '' : 'none'; onChange && onChange(id); };
    list.forEach(t => { bar.append(h('button', { 'data-id': t.id, role: 'tab', on: { click: () => go(t.id) } }, t.label)); panes[t.id] = t.el; });
    host.append(bar, ...list.map(t => t.el));
    go(list[0].id);
    return { go, get current() { return cur; } };
  }
  function tiles(host, rows) {
    host.replaceChildren(...rows.filter(Boolean).map(r => h('div.tile' + (r.state ? '.' + r.state : ''), { title: r.title || '' }, h('div.v', r.value), h('div.l', r.label), r.sub ? h('div.s', r.sub) : null)));
  }
  /** Batch redraws into one animation frame. */
  function scheduler(fn) { let q = false; return () => { if (q) return; q = true; requestAnimationFrame(() => { q = false; fn(); }); }; }

  /* ---------- ticks ---------- */
  function niceTicks(lo, hi, n = 5) {
    const span = hi - lo; if (!(span > 0)) return [lo];
    const raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
    const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag, out = [];
    for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    return out;
  }
  function logTicks(lo, hi) {
    const a = Math.floor(Math.log10(lo)), b = Math.ceil(Math.log10(hi)), major = [], minor = [];
    const every = Math.max(1, Math.ceil((b - a) / 7));
    for (let e = a; e <= b; e++) { const v = Math.pow(10, e); if (v >= lo * 0.999 && v <= hi * 1.001 && (e - a) % every === 0) major.push(v); for (let k = 2; k < 10; k++) { const m = k * v; if (m > lo && m < hi && b - a <= 6) minor.push(m); } }
    return { major, minor };
  }

  /* ---------- line plot ---------- */
  /** new K.Plot(host, {title, xLabel, yLabel, xLog, yLog, height, xFmt, yFmt, yMin, yMax, xMin, xMax, csvName}) */
  class Plot {
    constructor(host, o) {
      this.o = Object.assign({ height: 260, xFmt: fmt, yFmt: fmt }, o);
      this.series = []; this.marks = []; this.hmarks = []; this.spans = [];
      this.legend = h('div.legend');
      this.cv = h('canvas', { role: 'img', 'aria-label': (o.title || 'plot') + ': ' + (o.yLabel || '') + ' against ' + (o.xLabel || '') });
      this.tip = h('div.tip');
      const csv = h('button.btn', { title: 'Copy the plotted data as CSV', style: { fontSize: '11.5px', padding: '2px 8px' }, on: { click: () => this.copyCsv(csv) } }, 'CSV');
      this.el = h('div.plot', h('div.plot-h', o.title ? h('span.t', o.title) : null, this.legend, h('span.spacer'), csv), this.cv, this.tip);
      host.append(this.el);
      this.cv.addEventListener('pointermove', e => this.hover(e));
      this.cv.addEventListener('pointerleave', () => { this.tip.style.display = 'none'; this.hx = null; this.draw(); });
      if (window.ResizeObserver) new ResizeObserver(() => this.draw()).observe(this.cv);
      if (window.matchMedia) { const mq = matchMedia('(prefers-color-scheme: dark)'); mq.addEventListener && mq.addEventListener('change', () => this.draw()); }
    }
    /** series: [{name, x[], y[], c (palette slot) | color, dash, width, band:{lo[],hi[]}, dots, hidden, legend:false}] */
    set(series, marks, hmarks, spans) { this.series = series || []; this.marks = marks || []; this.hmarks = hmarks || []; this.spans = spans || []; this.renderLegend(); this.draw(); }
    renderLegend() {
      this.legend.replaceChildren(...this.series.filter(s => s.legend !== false && s.name).map(s => {
        const c = s.color || color(s.c || 0), i = h('i' + (s.dash ? '.dash' : '') + (s.onlyBand ? '.band' : ''));
        if (s.onlyBand) i.style.background = c; else i.style.borderTopColor = c;
        return h('span', i, s.name);
      }));
    }
    range() {
      const o = this.o; let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const s of this.series) {
        if (s.hidden) continue;
        const ys = [s.y, s.band && s.band.lo, s.band && s.band.hi].filter(Boolean);
        s.x.forEach((x, i) => {
          if (!Number.isFinite(x) || (o.xLog && x <= 0)) return;
          let any = false;
          for (const Y of ys) { const y = Y[i]; if (!Number.isFinite(y) || (o.yLog && y <= 0)) continue; any = true; if (s.noRange) continue; y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
          if (any) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
        });
      }
      if (o.xMin != null) x0 = o.xMin; if (o.xMax != null) x1 = o.xMax;
      if (o.yMin != null) y0 = o.yMin; if (o.yMax != null) y1 = o.yMax;
      if (!Number.isFinite(x0)) { x0 = o.xLog ? 1 : 0; x1 = o.xLog ? 10 : 1; }
      if (!Number.isFinite(y0)) { y0 = o.yLog ? 1 : 0; y1 = o.yLog ? 10 : 1; }
      if (o.yLog) { if (y1 / y0 < 10) { const m = Math.sqrt(y0 * y1); y0 = m / 3.2; y1 = m * 3.2; } if (o.yMax == null) y1 *= 1.25; if (o.yMin == null) y0 /= 1.25; }
      else { if (y1 === y0) { y1 += Math.abs(y1) * 0.1 || 1; y0 -= Math.abs(y0) * 0.1; } const p = (y1 - y0) * 0.06; if (o.yMax == null) y1 += p; if (o.yMin == null && !(o.yZero && y0 >= 0)) y0 -= p; if (o.yZero && o.yMin == null && y0 > 0) y0 = 0; }
      if (o.xLog && x1 / x0 < 1.0001) { x0 /= 2; x1 *= 2; } if (!o.xLog && x1 === x0) { x0 -= 1; x1 += 1; }
      return { x0, x1, y0, y1 };
    }
    draw() {
      const cv = this.cv, o = this.o, dpr = window.devicePixelRatio || 1, W = Math.max(200, cv.clientWidth || 600), H = o.height;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.height = H + 'px'; }
      const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
      const R = this.R = this.range(), L = 58, Rm = 14, T = 8, B = 40, pw = W - L - Rm, ph = H - T - B;
      const sx = x => L + pw * (o.xLog ? (Math.log10(x) - Math.log10(R.x0)) / (Math.log10(R.x1) - Math.log10(R.x0)) : (x - R.x0) / (R.x1 - R.x0));
      const sy = y => T + ph * (1 - (o.yLog ? (Math.log10(y) - Math.log10(R.y0)) / (Math.log10(R.y1) - Math.log10(R.y0)) : (y - R.y0) / (R.y1 - R.y0)));
      this.map = { sx, sy, L, T, pw, ph, W, H };
      const ink3 = css('--ink-3'), grid = css('--grid'), ink2 = css('--ink-2'), line = css('--line');
      g.font = '11px ' + css('--sans'); g.lineWidth = 1;
      // spans (shaded x-ranges)
      for (const s of this.spans) { const a = Math.max(L, sx(s.from)), b = Math.min(L + pw, sx(s.to)); if (b > a) { g.fillStyle = s.color || css('--surface-2'); g.globalAlpha = s.alpha ?? 1; g.fillRect(a, T, b - a, ph); g.globalAlpha = 1; if (s.label) { g.fillStyle = ink3; g.textAlign = 'left'; g.fillText(s.label, a + 4, T + 12); } } }
      // grid + ticks
      const xt = o.xLog ? logTicks(R.x0, R.x1) : { major: niceTicks(R.x0, R.x1, Math.max(3, Math.round(pw / 90))), minor: [] };
      const yt = o.yLog ? logTicks(R.y0, R.y1) : { major: niceTicks(R.y0, R.y1, Math.max(3, Math.round(ph / 50))), minor: [] };
      g.strokeStyle = grid;
      for (const v of xt.minor) { const x = Math.round(sx(v)) + .5; g.globalAlpha = .5; g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke(); g.globalAlpha = 1; }
      for (const v of yt.minor) { const y = Math.round(sy(v)) + .5; g.globalAlpha = .5; g.beginPath(); g.moveTo(L, y); g.lineTo(L + pw, y); g.stroke(); g.globalAlpha = 1; }
      g.fillStyle = ink3; g.textAlign = 'center'; g.textBaseline = 'top';
      for (const v of xt.major) { const x = Math.round(sx(v)) + .5; if (x < L - 1 || x > L + pw + 1) continue; g.strokeStyle = grid; g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke(); g.fillText(o.xFmt(v), x, T + ph + 5); }
      g.textAlign = 'right'; g.textBaseline = 'middle';
      for (const v of yt.major) { const y = Math.round(sy(v)) + .5; if (y < T - 1 || y > T + ph + 1) continue; g.strokeStyle = grid; g.beginPath(); g.moveTo(L, y); g.lineTo(L + pw, y); g.stroke(); g.fillText(o.yFmt(v), L - 6, y); }
      g.strokeStyle = line; g.beginPath(); g.moveTo(L + .5, T); g.lineTo(L + .5, T + ph + .5); g.lineTo(L + pw, T + ph + .5); g.stroke();
      g.fillStyle = ink2; g.textAlign = 'center'; g.textBaseline = 'bottom'; g.font = '12px ' + css('--sans');
      if (o.xLabel) g.fillText(o.xLabel, L + pw / 2, H - 2);
      if (o.yLabel) { g.save(); g.translate(13, T + ph / 2); g.rotate(-Math.PI / 2); g.textBaseline = 'middle'; g.fillText(o.yLabel, 0, 0); g.restore(); }
      g.save(); g.beginPath(); g.rect(L, T - 1, pw + 1, ph + 2); g.clip();
      // horizontal reference lines
      for (const m of this.hmarks) { if (!Number.isFinite(m.y) || (o.yLog && m.y <= 0)) continue; const y = Math.round(sy(m.y)) + .5; g.strokeStyle = m.color || ink3; g.setLineDash(m.dash === false ? [] : [4, 4]); g.lineWidth = 1; g.beginPath(); g.moveTo(L, y); g.lineTo(L + pw, y); g.stroke(); g.setLineDash([]); if (m.label) { g.fillStyle = ink3; g.font = '11px ' + css('--sans'); g.textAlign = 'right'; g.textBaseline = 'bottom'; g.fillText(m.label, L + pw - 4, y - 2); } }
      // series
      for (const s of this.series) {
        if (s.hidden) continue;
        const c = s.color || color(s.c || 0);
        if (s.band) {
          g.fillStyle = c; g.globalAlpha = s.bandAlpha ?? .16; g.beginPath(); let started = false;
          s.x.forEach((x, i) => { const y = s.band.hi[i]; if (!Number.isFinite(y) || (o.yLog && y <= 0) || (o.xLog && x <= 0)) return; const X = sx(x), Y = sy(y); started ? g.lineTo(X, Y) : (g.moveTo(X, Y), started = true); });
          for (let i = s.x.length - 1; i >= 0; i--) { const x = s.x[i], y = s.band.lo[i]; if (!Number.isFinite(y) || (o.yLog && y <= 0) || (o.xLog && x <= 0)) continue; g.lineTo(sx(x), sy(y)); }
          g.closePath(); g.fill(); g.globalAlpha = 1;
        }
        if (s.onlyBand) continue;
        g.strokeStyle = c; g.lineWidth = s.width || 2; g.setLineDash(s.dash ? (Array.isArray(s.dash) ? s.dash : [6, 4]) : []); g.lineJoin = 'round';
        if (!s.dotsOnly) { g.beginPath(); let pen = false; s.x.forEach((x, i) => { const y = s.y[i]; if (!Number.isFinite(y) || !Number.isFinite(x) || (o.yLog && y <= 0) || (o.xLog && x <= 0)) { pen = false; return; } const X = sx(x), Y = sy(y); pen ? g.lineTo(X, Y) : g.moveTo(X, Y); pen = true; }); g.stroke(); }
        g.setLineDash([]);
        if (s.dots) { const r = s.dotR || 3.5; g.fillStyle = c; g.strokeStyle = css('--surface'); g.lineWidth = 1.5; s.x.forEach((x, i) => { const y = s.y[i]; if (!Number.isFinite(y) || (o.yLog && y <= 0) || (o.xLog && x <= 0)) return; g.beginPath(); g.arc(sx(x), sy(y), r, 0, 7); g.fill(); g.stroke(); }); }
      }
      // vertical marks
      for (const m of this.marks) { if (!Number.isFinite(m.x) || (o.xLog && m.x <= 0)) continue; const x = Math.round(sx(m.x)) + .5; if (x < L || x > L + pw) continue; g.strokeStyle = m.color || ink3; g.lineWidth = 1; g.setLineDash(m.dash === false ? [] : [4, 4]); g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke(); g.setLineDash([]); if (m.label) { g.fillStyle = ink2; g.font = '11px ' + css('--sans'); g.textAlign = x > L + pw * .7 ? 'right' : 'left'; g.textBaseline = 'top'; g.fillText(m.label, x + (x > L + pw * .7 ? -4 : 4), T + 4 + (m.row || 0) * 13); } }
      // hover crosshair
      if (this.hx != null) { g.strokeStyle = ink3; g.globalAlpha = .6; g.beginPath(); g.moveTo(this.hx + .5, T); g.lineTo(this.hx + .5, T + ph); g.stroke(); g.globalAlpha = 1;
        for (const p of this.hpts || []) { g.fillStyle = p.c; g.strokeStyle = css('--surface'); g.lineWidth = 2; g.beginPath(); g.arc(p.X, p.Y, 4, 0, 7); g.fill(); g.stroke(); } }
      g.restore();
    }
    hover(e) {
      if (!this.map || !this.R) return;
      const r = this.cv.getBoundingClientRect(), X = e.clientX - r.left, Y = e.clientY - r.top, m = this.map, o = this.o;
      if (X < m.L || X > m.L + m.pw || Y < m.T || Y > m.T + m.ph) { this.tip.style.display = 'none'; this.hx = null; this.draw(); return; }
      const fx = (X - m.L) / m.pw, xv = o.xLog ? Math.pow(10, Math.log10(this.R.x0) + fx * (Math.log10(this.R.x1) - Math.log10(this.R.x0))) : this.R.x0 + fx * (this.R.x1 - this.R.x0);
      const rows = [], pts = [];
      for (const s of this.series) {
        if (s.hidden || s.onlyBand || s.noTip || !s.x.length) continue;
        let bi = -1, bd = Infinity;
        s.x.forEach((x, i) => { if (!Number.isFinite(s.y[i])) return; const d = Math.abs(o.xLog ? Math.log10(x / xv) : x - xv); if (d < bd) { bd = d; bi = i; } });
        if (bi < 0) continue;
        const c = s.color || color(s.c || 0), yv = s.y[bi];
        if (o.yLog && yv <= 0) continue;
        pts.push({ X: m.sx(s.x[bi]), Y: m.sy(yv), c });
        rows.push(h('div', h('span.k', { style: { background: c } }), (s.name || '') + ': ', h('b', (s.tipFmt || o.yFmt)(yv)), s.tipExtra ? ' ' + s.tipExtra(bi) : ''));
      }
      this.hx = X; this.hpts = pts; this.draw();
      if (!rows.length) { this.tip.style.display = 'none'; return; }
      this.tip.replaceChildren(h('div.muted', (o.xLabel ? o.xLabel.replace(/\s*\(.*\)$/, '') + ' ' : '') + (o.tipX || o.xFmt)(xv)), ...rows);
      this.tip.style.display = 'block';
      const tw = this.tip.offsetWidth, cw = this.el.clientWidth, left = this.cv.offsetLeft + X + 14;
      this.tip.style.left = (left + tw > cw - 4 ? this.cv.offsetLeft + X - tw - 14 : left) + 'px';
      this.tip.style.top = (this.cv.offsetTop + Math.max(4, Y - 30)) + 'px';
    }
    csv() {
      const ss = this.series.filter(s => !s.onlyBand && !s.hidden && s.name);
      const lines = [];
      for (const s of ss) { lines.push('# ' + s.name); lines.push([this.o.xLabel || 'x', this.o.yLabel || 'y'].map(v => '"' + v + '"').join(',')); s.x.forEach((x, i) => lines.push(x + ',' + s.y[i])); lines.push(''); }
      return lines.join('\n');
    }
    copyCsv(btn) {
      const t = this.csv(), done = ok => { const old = btn.textContent; btn.textContent = ok ? 'Copied' : 'Copy failed'; setTimeout(() => { btn.textContent = old; }, 1400); };
      try { navigator.clipboard.writeText(t).then(() => done(true), () => fallback()); } catch (e) { fallback(); }
      function fallback() { try { const a = h('textarea', { style: { position: 'fixed', opacity: '0' } }, t); document.body.append(a); a.select(); const ok = document.execCommand('copy'); a.remove(); done(ok); } catch (e) { done(false); } }
    }
  }

  /* ---------- image ---------- */
  const INF = [[0.0002189403691192265, 0.001651004631001012, -0.01948089843709184], [0.1065134194856116, 0.5639564367884091, 3.932712388889277], [11.60249308247187, -3.972853965665698, -15.9423941062914],
    [-41.70399613139459, 17.43639888205313, 44.35414519872813], [77.162935699427, -33.40235894210092, -81.80730925738993], [-71.31942824499214, 32.62606426397723, 73.20951985803202], [25.13112622477341, -12.24266895238567, -23.07032500287172]];
  const LUTS = {};
  function lut(name) {
    if (LUTS[name]) return LUTS[name];
    const t = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const x = i / 255; let r, g, b;
      if (name === 'inferno') { const c = [0, 1, 2].map(k => { let v = INF[6][k]; for (let j = 5; j >= 0; j--) v = INF[j][k] + x * v; return v; }); [r, g, b] = c; }
      else if (name === 'pe') { r = Math.min(1, x * 1.6); g = Math.max(0, Math.min(1, (x - 0.25) * 1.25)); b = Math.max(0, (x - 0.7) * 2.2); }
      else { r = g = b = x; }
      t[i * 3] = r * 255; t[i * 3 + 1] = g * 255; t[i * 3 + 2] = b * 255;
    }
    return (LUTS[name] = t);
  }
  /** Draw a float image (row-major, w×h) into a canvas with a LUT; returns nothing. lo/hi set the display range. */
  function paint(cv, data, w, hgt, lo, hi, name, scale) {
    const s = scale || 1; cv.width = w * s; cv.height = hgt * s;
    const g = cv.getContext('2d'), img = g.createImageData(w * s, hgt * s), L = lut(name || 'gray'), d = img.data, span = (hi - lo) || 1;
    for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) {
      const v = data[y * w + x], k = Math.max(0, Math.min(255, Math.round(255 * (v - lo) / span))) * 3;
      for (let yy = 0; yy < s; yy++) { let o = ((y * s + yy) * w * s + x * s) * 4; for (let xx = 0; xx < s; xx++, o += 4) { d[o] = L[k]; d[o + 1] = L[k + 1]; d[o + 2] = L[k + 2]; d[o + 3] = 255; } }
    }
    g.putImageData(img, 0, 0);
  }
  function colorbar(cv, name) { cv.width = 256; cv.height = 1; const g = cv.getContext('2d'), img = g.createImageData(256, 1), L = lut(name); for (let i = 0; i < 256; i++) { img.data[i * 4] = L[i * 3]; img.data[i * 4 + 1] = L[i * 3 + 1]; img.data[i * 4 + 2] = L[i * 3 + 2]; img.data[i * 4 + 3] = 255; } g.putImageData(img, 0, 0); }

  /* ---------- seeded random ---------- */
  function rng(seed) { let s = (seed >>> 0) || 1; const u = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return (s >>> 0) / 4294967296; }; let spare = null;
    const normal = () => { if (spare != null) { const v = spare; spare = null; return v; } let a, b, q; do { a = 2 * u() - 1; b = 2 * u() - 1; q = a * a + b * b; } while (q >= 1 || q === 0); const f = Math.sqrt(-2 * Math.log(q) / q); spare = b * f; return a * f; };
    const poisson = lam => { if (lam <= 0) return 0; if (lam < 30) { const L = Math.exp(-lam); let k = 0, p = 1; do { k++; p *= u(); } while (p > L); return k - 1; } return Math.max(0, Math.round(lam + Math.sqrt(lam) * normal())); };
    return { u, normal, poisson }; }

  const store = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } } };

  return { h, $, css, color, fmt, group, molar, dur, pct, sup, slider, seg, check, tabs, tiles, scheduler, niceTicks, logTicks, Plot, lut, paint, colorbar, rng, store };
})();

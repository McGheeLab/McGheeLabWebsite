#!/usr/bin/env node
/* gen-icons.mjs — build rm/js/icons.js from scripts/icons.manifest.json.
 *
 *   node scripts/gen-icons.mjs            regenerate (whole-file overwrite)
 *   node scripts/gen-icons.mjs --check    fail if the committed file is stale
 *   node scripts/gen-icons.mjs --scan     fail on a call site naming an icon
 *                                         that the manifest doesn't ship
 *
 * Run BY HAND when the manifest changes — like scripts/scan_modules.py. This
 * is not a build step: nothing the browser does depends on it, and the site
 * works from the committed rm/js/icons.js alone. release_push.py runs
 * `--check --scan` as a release gate so a stale or typo'd icon can't ship.
 *
 * Sources live at repo-root vendor/heroicons/ (NOT rm/vendor/) on purpose:
 * OurlabMobile/scripts/sync-rm.mjs rsyncs all of rm/ into the phone bundle,
 * and ~650 unused source SVGs have no business travelling with it. Only the
 * generated rm/js/icons.js ships.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'vendor', 'heroicons');
const LUCIDE = join(ROOT, 'vendor', 'lucide', '24');
const MANIFEST = join(ROOT, 'scripts', 'icons.manifest.json');
const OUT = join(ROOT, 'rm', 'js', 'icons.js');

const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const SCAN = argv.includes('--scan');
const EMOJI = argv.includes('--emoji');

const die = (msg) => { console.error(`[gen-icons] ERROR ${msg}`); process.exit(1); };

/* ── read + validate the manifest ─────────────────────────────────────── */
const man = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const ICONS = man.icons;
const FALLBACK = man.fallback;
const TINT = Object.fromEntries(Object.entries(man.tint || {}).filter(([k]) => !k.startsWith('_')));
if (!ICONS[FALLBACK]) die(`fallback "${FALLBACK}" is not in icons{}`);

/* ── extract the inner markup of one source SVG ───────────────────────── */
function inner(name, weight, custom, lucide) {
  // V3.861 — Lucide (ISC) fills the gaps Heroicons has no shape for. Same
  // 24-grid outline family; its root stroke-width is dropped below like
  // Heroicons', so .hi's --hi-stroke draws both libraries at one weight.
  if (lucide && weight !== 'outline') return null;
  const base = lucide ? LUCIDE
    : custom ? join(VENDOR, 'custom', '24', weight) : join(VENDOR, '24', weight);
  const file = join(base, `${name}.svg`);
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, 'utf8');

  // currentColor is the whole reason to leave emoji behind. A source that
  // hardcodes a colour would silently ignore --text-muted / --primary.
  if (!raw.includes('currentColor')) die(`${file} does not use currentColor`);

  const body = raw.replace(/<!--[\s\S]*?-->/g, '').replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>[\s\S]*$/, '');

  return body
    // the wrapper's job now: CSS owns stroke-width so it stays overridable,
    // and ICON.svg() owns aria. Everything else on the PATHS is load-bearing
    // — dropping fill-rule="evenodd" visibly corrupts solid icons.
    .replace(/\s(?:xmlns|aria-hidden|data-slot|stroke-width)="[^"]*"/g, '')
    .replace(/\s+/g, ' ')
    .replace(/>\s+</g, '><')
    .trim();
}

const outline = {}, solid = {}, emojiOf = {}, nameOf = {};
const missingSolid = [];

for (const [name, cfg] of Object.entries(ICONS)) {
  const o = inner(name, 'outline', cfg.custom, cfg.lucide);
  if (!o) die(`no source SVG for "${name}" (custom=${!!cfg.custom}, lucide=${!!cfg.lucide}) — check the spelling against vendor/`);
  outline[name] = o;

  if (cfg.solid) {
    const s = inner(name, 'solid', cfg.custom, cfg.lucide);
    if (!s) die(`"${name}" is marked solid:true but has no solid source`);
    solid[name] = s;
  } else {
    missingSolid.push(name);
  }

  // reverse map powers the kill switch; forward map powers ICON.render()
  const glyphs = [cfg.emoji, ...(cfg.also || [])].filter(Boolean);
  if (glyphs.length) {
    emojiOf[name] = glyphs[0];
    for (const g of glyphs) {
      if (nameOf[g] && nameOf[g] !== name) {
        die(`glyph ${g} is claimed by both "${nameOf[g]}" and "${name}" — one emoji, one icon`);
      }
      nameOf[g] = name;
    }
  }
}

const tintOf = {};
for (const [g, [name, color]] of Object.entries(TINT)) {
  if (!ICONS[name]) die(`tint ${g} names "${name}", which is not in icons{}`);
  if (nameOf[g]) die(`glyph ${g} is in both tint{} and icons{} — pick one`);
  tintOf[g] = [name, color || ''];
}

/* ── --scan: call sites must name a shippable icon AND route it safely ──
 *
 * The second half matters more than the first. ICON.svg() returns MARKUP, and
 * this codebase has 203 `el.textContent = '<glyph>'` sinks across 54 files
 * (measured 2026-08-15) — far more than a migration can hand-audit. Assigning
 * markup to any of them renders a literal "<svg viewBox=…>" as visible text,
 * and escaping it does the same. Neither throws, so nothing catches it but a
 * human looking at the page. These two guards catch the whole class instead.  */
const TRAPS = [
  {
    re: /\.(?:textContent|innerText)\s*=[^;\n]*\bICON\.(?:svg|render)\b/g,
    msg: 'assigns ICON markup to a text sink — use ICON.el() + replaceChildren()',
  },
  {
    re: /\b(?:esc|escHtml|escapeHtml|escapeHTML)\s*\(\s*ICON\./g,
    msg: 'escapes ICON markup — it is trusted; escaping renders the source as text',
  },
  {
    re: /\.setAttribute\(\s*['"](?:title|aria-label|alt|placeholder)['"]\s*,[^)]*\bICON\./g,
    msg: 'puts ICON markup in a text-only attribute — pass {label} instead',
  },
  {
    // The same mistake one level down: an icon concatenated INTO an HTML
    // attribute inside a markup string. A tooltip is a text channel, so this
    // paints the raw <svg> source in the tooltip. Caught in the wild once
    // (paper-figure-board.js title="… student ↔ mentor thread").
    re: /(?:title|alt|aria-label|placeholder)="[^"]{0,200}?\bICON\.(?:svg|render)\b/g,
    msg: 'concatenates an icon into an HTML text attribute — keep the glyph or reword',
  },
];

/* Every shipped folder that can hold an ICON call (V3.861 adds the public
 * root and the course modules — both now load /rm/js/icons.js). */
function scanFiles() {
  const out = [];
  const add = (dir, deep) => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, f.name);
      if (f.isDirectory()) { if (deep && !/^(vendor|node_modules|\.)/.test(f.name)) add(p, deep); continue; }
      if (/\.(js|html)$/.test(f.name)) out.push(p);
    }
  };
  add(join(ROOT, 'rm', 'js'), false);
  add(join(ROOT, 'rm', 'pages'), false);
  add(join(ROOT, 'modules'), true);
  for (const f of readdirSync(ROOT)) if (/\.(js|html)$/.test(f)) out.push(join(ROOT, f));
  return out;
}

function scan() {
  const re = /(?:ICON\.(?:svg|el)\(\s*['"]|ICON\.label\([^,]+,\s*['"]|ICON\.draw\([^,]+,\s*['"]|data-hi=")([A-Za-z0-9-]+)['"]/g;
  const used = new Map();
  const traps = [];

  {
    for (const full of scanFiles()) {
      const f = full.slice(ROOT.length + 1).split('\\').join('/');
      // icons.js documents example calls in its banner; icon-audit.html
      // deliberately requests a missing icon to prove the fallback renders.
      if (/(^|\/)icons\.js$/.test(f) || /icon-audit\.html$/.test(f)) continue;
      const txt = readFileSync(full, 'utf8');
      for (const m of txt.matchAll(re)) {
        if (!used.has(m[1])) used.set(m[1], []);
        used.get(m[1]).push(f);
      }
      const lines = txt.split('\n');
      for (const t of TRAPS) {
        for (const m of txt.matchAll(t.re)) {
          const line = txt.slice(0, m.index).split('\n').length;
          if (/^\s*(?:\/\/|\*|\/\*)/.test(lines[line - 1] || '')) continue;  // a comment about the rule
          traps.push(`${f}:${line} ${t.msg}\n      ${(lines[line - 1] || '').trim().slice(0, 110)}`);
        }
      }
    }
  }

  const unknown = [...used.keys()].filter((n) => !ICONS[n]);
  if (unknown.length) {
    for (const n of unknown) console.error(`[gen-icons]   "${n}" used in ${used.get(n).join(', ')}`);
    die(`${unknown.length} call site(s) name an icon the manifest doesn't ship`);
  }
  if (traps.length) {
    for (const t of traps) console.error(`[gen-icons]   ${t}`);
    die(`${traps.length} call site(s) route icon markup into a text channel`);
  }

  // Advisory only: names reached through a variable (ICON.svg(t.icon)) are
  // unscannable, which is exactly why the manifest and not the scan is
  // authoritative. Never fail on "unused".
  const unused = Object.keys(ICONS).filter((n) => !used.has(n));
  console.log(`[gen-icons] scan: ${used.size} literal name(s) used, all shippable;`
    + ` 0 text-sink/escaping traps`
    + (unused.length ? `; ${unused.length} manifest entries not referenced literally (may be dynamic)` : ''));
}

/* ── --emoji: no colour-emoji images in shipped UI (V3.861) ───────────────
 *
 * Alex, 2026-10-23: "ensure the icons we use are the solid color type not the
 * colored images". V3.642 converted the chrome and stopped; 200 versions later
 * ~2,000 emoji had crept back in, because nothing failed when one was added.
 * This is that failure. A colour emoji is any Extended_Pictographic code point
 * except the few typographic arrows/marks every text font draws in the text
 * colour. Comments and console lines don't render. A line that is a genuine
 * exception (the chat REACTION set — people react with emoji, that is content)
 * carries the marker `emoji-ok`.                                              */
const TYPOGRAPHIC = new Set(['↔', '↕', '↖', '↗', '↘', '↙', '©', '®', '™']);
/* Every file the site actually ships: deploy/site.json's include list (the
 * one definition of what the site IS, V3.817), minus third-party code —
 * rm/vendor and Gabe's vendored Scientia build — and the generated icons.js,
 * whose reverse map IS emoji. */
function shippedFiles() {
  const site = JSON.parse(readFileSync(join(ROOT, 'deploy', 'site.json'), 'utf8'));
  const out = [];
  const ok = (rel) => /\.(js|mjs|html|css|json)$/.test(rel)
    && !/(^|\/)(vendor|node_modules)\//.test(rel) && !/^rm\/scientia\//.test(rel)
    && !/(^|\/)icons\.js$/.test(rel) && rel !== 'manifest.json';
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (!/^(\.|node_modules|__pycache__)/.test(e.name)) walk(p); }
      else if (ok(p.slice(ROOT.length + 1).split('\\').join('/'))) out.push(p);
    }
  };
  for (const inc of site.include) {
    if (inc.endsWith('/**')) walk(join(ROOT, inc.slice(0, -3)));
    else if (existsSync(join(ROOT, inc)) && ok(inc)) out.push(join(ROOT, inc));
  }
  return out;
}

/* An emoji can also be WRITTEN as an escape — '\u{1F4C5}', '\uD83D\uDCCC',
 * '\u2705', '&#128279;', '&#x1F517;' — and render exactly the same. Decode
 * those on each line before testing it, or they slip past (V3.861: 53 did). */
function decodeEscapes(ln) {
  return ln
    .replace(/\\u\{([0-9a-fA-F]{2,6})\}/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\u([dD][89abAB][0-9a-fA-F]{2})\\u([dD][c-fC-F][0-9a-fA-F]{2})/g,
      (m, a, b) => String.fromCharCode(parseInt(a, 16), parseInt(b, 16)))
    .replace(/\\u(2[0-9a-fA-F]{3}|1[fF][0-9a-fA-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d{4,6});/g, (m, d) => String.fromCodePoint(+d))
    .replace(/&#[xX]([0-9a-fA-F]{4,5});/g, (m, h) => String.fromCodePoint(parseInt(h, 16)));
}

function emojiGate() {
  const files = shippedFiles();
  const RE = /\p{Extended_Pictographic}\uFE0F?/gu;
  const hits = [];
  for (const full of files) {
    const rel = full.slice(ROOT.length + 1).split('\\').join('/');
    if (/(^|\/)icons\.js$/.test(rel)) continue;          // the reverse map IS emoji
    let inBlock = false, inHtml = false;
    readFileSync(full, 'utf8').split('\n').forEach((ln, i) => {
      const wasBlock = inBlock, wasHtml = inHtml;
      const o = ln.lastIndexOf('/*'), c = ln.lastIndexOf('*/');
      if (o !== -1 && o > c) inBlock = true; else if (c !== -1) inBlock = false;
      const ho = ln.lastIndexOf('<!--'), hc = ln.lastIndexOf('-->');
      if (ho !== -1 && ho > hc) inHtml = true; else if (hc !== -1) inHtml = false;
      if (wasBlock || wasHtml || /emoji-ok/.test(ln) || /\bconsole\.\w+\(/.test(ln)) return;
      const t = ln.trim();
      if (/^(\/\/|\*|\/\*|<!--)/.test(t)) return;
      const dl = decodeEscapes(ln);
      const lineCmt = dl.search(/(^|[^:\\'"])\/\/\s/);
      for (const m of dl.matchAll(RE)) {
        const g = m[0];
        if (TYPOGRAPHIC.has(g)) continue;
        if (lineCmt !== -1 && m.index > lineCmt) continue;
        if (/\/\*[^*]*$/.test(dl.slice(0, m.index))) continue;     // inside an inline /* … */
        hits.push(`${rel}:${i + 1} ${g}  ${t.slice(0, 100)}`);
      }
    });
  }
  if (hits.length) {
    for (const h of hits.slice(0, process.env.GEN_ICONS_ALL ? 1e9 : 400)) console.error(`[gen-icons]   ${h}`);
    die(`${hits.length} colour emoji in shipped UI — use ICON.svg()/data-hi, or drop it from text-only channels (mark a deliberate exception with emoji-ok)`);
  }
  console.log(`[gen-icons] emoji: 0 colour emoji across ${files.length} shipped files`);
}

/* ── emit ─────────────────────────────────────────────────────────────── */
const j = (o) => JSON.stringify(o, Object.keys(o).sort(), 0);

const banner = `/* icons.js — Heroicons v${man.heroicons} + Lucide gap icons for RM and the public site. GENERATED FILE, DO NOT EDIT.
 *
 * Regenerate:  node scripts/gen-icons.mjs
 * Source of truth: scripts/icons.manifest.json + vendor/heroicons/
 *
 * Heroicons is MIT (c) Tailwind Labs — see vendor/heroicons/LICENSE.
 * The ${Object.keys(ICONS).filter((n) => ICONS[n].custom).length} icons marked custom are ours: Heroicons ships no
 * microscope, target, thumbtack, compass, stacked-books, barricade or helix.
 * They are drawn to the same spec (24x24, 1.5 stroke, round caps, currentColor)
 * by vendor/heroicons/custom/make_custom_icons.py.
 *
 * ── Using it ─────────────────────────────────────────────────────────────
 *   ICON.svg('sun')                        -> markup string, for innerHTML
 *   ICON.svg('sun', {variant:'solid'})     -> filled weight (active states)
 *   ICON.svg('sun', {size:'lg'})           -> hi-lg; omit size to inherit
 *   ICON.svg('trash', {label:'Delete'})    -> role=img + aria-label
 *   ICON.el('sun')                         -> SVGElement, for textContent sites
 *   ICON.label(btn, 'check', ' Done')      -> icon + text INTO an element
 *                                            replacing a textContent assignment
 *   ICON.render(value)                     -> emoji | image URL | icon name
 *   ICON.svg('dot', {variant:'solid', tint:'#ef4444'}) -> a coloured status dot
 *   <i data-hi="beaker"></i>               -> static HTML; swapped at DOMContentLoaded
 *   ICON.hydrate(root)                     -> same, after injecting such HTML
 *   ICON.draw(ctx, 'beer', x, y, 18, col)  -> onto a <canvas> (Path2D, synchronous)
 *
 * ★ ICON.svg() returns TRUSTED MARKUP. Never pass it through esc()/escHtml()
 *   and never assign it to .textContent — both render the raw source as text.
 *
 * ★ Kill switch: ICON.setMode('emoji') renders the glyph each icon replaced,
 *   at render time, with no deploy. Set window.RM_ICON_MODE='emoji' before
 *   this file loads, or flip labConfig.iconMode. This is the ONLY rollback
 *   that reaches phones already running a shipped TestFlight build.
 */`;

const src = `${banner}
(function () {
  'use strict';

  var OUTLINE = ${j(outline)};
  var SOLID = ${j(solid)};
  var EMOJI = ${j(emojiOf)};   /* icon name -> the glyph it replaced */
  var BY_GLYPH = ${j(nameOf)}; /* glyph -> icon name (ICON.render) */
  var TINT = ${JSON.stringify(tintOf)}; /* colour-shape glyph -> [icon, colour] */
  var FALLBACK = ${JSON.stringify(FALLBACK)};
  var SIZES = { xs: 1, sm: 1, md: 1, lg: 1, xl: 1, '2xl': 1 };

  var mode = 'icons';
  try {
    if (window.RM_ICON_MODE === 'emoji') mode = 'emoji';
    else if (localStorage.getItem('rm_icon_mode') === 'emoji') mode = 'emoji';
  } catch (e) { /* private mode / no storage — stay on icons */ }

  var warned = {};
  function warnOnce(name) {
    if (warned[name]) return;
    warned[name] = 1;
    try { console.warn('[icons] unknown icon "' + name + '" — add it to scripts/icons.manifest.json'); } catch (e) {}
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* aria is mutually exclusive by design: emitting aria-hidden together with
   * a name is a WCAG failure (hidden-but-named). No label => decorative,
   * which is right for the overwhelming majority (icon beside visible text). */
  function ariaFor(label) {
    return label
      ? ' role="img" aria-label="' + esc(label) + '"'
      : ' aria-hidden="true" focusable="false"';
  }

  function classFor(opts, isSolid, extra) {
    var c = 'hi' + (isSolid ? ' hi-solid' : '');
    if (opts.size && SIZES[opts.size]) c += ' hi-' + opts.size;
    if (extra) c += ' ' + extra;
    if (opts.cls) c += ' ' + opts.cls;
    return c;
  }

  function styleFor(opts) {
    var st = (typeof opts.size === 'number') ? 'font-size:' + opts.size + 'px;' : '';
    /* tint: a colour that IS the meaning (status dots, user-picked markers) */
    if (opts.tint && /^(#[0-9a-fA-F]{3,8}|var[(]--[a-zA-Z0-9_-]+[)]|[a-z]+)$/.test(opts.tint)) st += 'color:' + opts.tint + ';';
    return st ? ' style="' + st + '"' : '';
  }

  function emojiSpan(glyph, opts) {
    return '<span class="' + esc(classFor(opts, false, 'hi-emoji')) + '"' + styleFor(opts)
      + ariaFor(opts.label) + '>' + esc(glyph) + '</span>';
  }

  function svg(name, opts) {
    opts = opts || {};
    if (mode === 'emoji' && EMOJI[name]) return emojiSpan(EMOJI[name], opts);

    var wantSolid = opts.variant === 'solid';
    var body = wantSolid ? SOLID[name] : OUTLINE[name];
    /* solid not shipped for this name -> outline rather than nothing */
    if (!body && wantSolid) { body = OUTLINE[name]; wantSolid = false; }
    var missing = false;
    if (!body) {
      warnOnce(name);
      body = OUTLINE[FALLBACK];
      wantSolid = false;
      missing = true;
    }
    /* data-icon keeps the REQUESTED name so a typo is greppable in the DOM,
     * and data-icon-missing marks it so QA can assert on it without having to
     * scrape console warnings. */
    return '<svg class="' + esc(classFor(opts, wantSolid)) + '" viewBox="0 0 24 24"'
      + ' data-icon="' + esc(name) + '"' + (missing ? ' data-icon-missing="1"' : '')
      + styleFor(opts) + ariaFor(opts.label) + (opts.attrs ? ' ' + opts.attrs : '') + '>'
      + body + '</svg>';
  }

  /* For call sites that assign to .textContent / appendChild, where a markup
   * string would render as literal "<svg …>" text. There are 203 of those
   * across 54 files, so this is not a rare path. */
  function el(name, opts) {
    var d = document.createElement('div');
    d.innerHTML = svg(name, opts);
    return d.firstChild;
  }

  /* The workhorse for those 203 sinks. Replaces an element's content with an
   * icon plus optional text, which is what nearly every one of them was doing
   * with a glyph:
   *     btn.textContent = '✓ Mark complete';
   *  -> ICON.label(btn, 'check', ' Mark complete');
   * Text goes in as a text node, so it can never be parsed as markup — the
   * whole failure mode this migration has to avoid. Returns the element. */
  function label(node, name, text, opts) {
    if (!node) return node;
    var parts = [el(name, opts)];
    if (text != null && text !== '') parts.push(document.createTextNode(String(text)));
    if (node.replaceChildren) node.replaceChildren.apply(node, parts);
    else {
      node.textContent = '';
      for (var i = 0; i < parts.length; i++) node.appendChild(parts[i]);
    }
    return node;
  }

  /* Stored icon values are NOT migrated (V3.641). A value may be an uploaded
   * image URL, a Heroicon name, or a legacy emoji a user picked years ago —
   * and the three namespaces are provably disjoint: emoji are never ASCII,
   * URLs always carry a scheme, names are always lowercase-ASCII-with-hyphens.
   * Order matters; an unrecognised value must render as itself, never vanish. */
  function render(value, opts) {
    opts = opts || {};
    var v = String(value == null ? '' : value).trim();
    if (!v) return '';
    if (/^(https?:|data:)/i.test(v)) {
      return '<img class="' + esc(classFor(opts, false, 'hi-img')) + '" src="' + esc(v)
        + '"' + styleFor(opts) + ' alt="' + esc(opts.label || '') + '">';
    }
    if (/^[a-z][a-z0-9-]{1,40}$/.test(v) && (OUTLINE[v] || SOLID[v])) return svg(v, opts);
    var g = v.split(String.fromCharCode(0xFE0F)).join('');
    if (TINT[g] && mode !== 'emoji') {
      var o2 = {}; for (var k in opts) o2[k] = opts[k];
      o2.tint = TINT[g][1] || opts.tint; if (SOLID[TINT[g][0]]) o2.variant = 'solid';
      return svg(TINT[g][0], o2);
    }
    if (BY_GLYPH[v]) return svg(BY_GLYPH[v], opts);
    if (BY_GLYPH[g]) return svg(BY_GLYPH[g], opts);
    return emojiSpan(v, opts);
  }

  /* V3.861 — static HTML can't call ICON.svg(). It writes
   *     <i data-hi="book-open"></i>  (+ data-hi-variant / -size / -label / -tint)
   * and this swaps each one for the icon. Runs once at DOMContentLoaded; call
   * ICON.hydrate(root) after injecting an HTML fragment that carries them. */
  function hydrate(root) {
    var scope = root || document;
    if (!scope.querySelectorAll) return;
    var list = scope.querySelectorAll('[data-hi]');
    for (var i = 0; i < list.length; i++) {
      var n = list[i], d = n.dataset || {};
      if (n.tagName && n.tagName.toLowerCase() === 'svg') continue;   // already an icon
      var o = { variant: d.hiVariant, label: d.hiLabel, tint: d.hiTint, cls: n.getAttribute('class') || '' };
      if (d.hiSize) o.size = /^[0-9]+$/.test(d.hiSize) ? +d.hiSize : d.hiSize;
      var wrap = document.createElement('div');
      wrap.innerHTML = svg(d.hi, o);
      if (wrap.firstChild && n.parentNode) n.parentNode.replaceChild(wrap.firstChild, n);
    }
  }

  /* V3.861 — canvas has no DOM: draw the icon's own geometry with Path2D.
   *   ICON.draw(ctx, 'beer', x, y, 18, '#334155')   (x,y = top-left)
   * Synchronous, so it works inside a render loop. Handles every element the
   * shipped sources use (path, circle, ellipse, rect, line, polyline, polygon). */
  var _shapes = {};
  function shapesOf(name, solid) {
    var key = (solid ? 's:' : 'o:') + name;
    if (_shapes[key]) return _shapes[key];
    var body = (solid ? SOLID[name] : OUTLINE[name]) || OUTLINE[name] || OUTLINE[FALLBACK];
    var out = [], re = /<(path|circle|ellipse|rect|line|polyline|polygon)(?=[ />])([^>]*)>/g, m;
    function at(a, k) { var r = new RegExp('(?:^| )' + k + '="([^"]*)"').exec(a); return r ? r[1] : null; }
    function num(a, k) { return parseFloat(at(a, k)) || 0; }
    while ((m = re.exec(body))) {
      var t = m[1], a = m[2], p;
      try {
        if (t === 'path') p = new Path2D(at(a, 'd') || '');
        else {
          p = new Path2D();
          if (t === 'circle') p.arc(num(a, 'cx'), num(a, 'cy'), num(a, 'r'), 0, Math.PI * 2);
          else if (t === 'ellipse') p.ellipse(num(a, 'cx'), num(a, 'cy'), num(a, 'rx'), num(a, 'ry'), 0, 0, Math.PI * 2);
          else if (t === 'rect') {
            var rx = num(a, 'rx');
            if (rx && p.roundRect) p.roundRect(num(a, 'x'), num(a, 'y'), num(a, 'width'), num(a, 'height'), rx);
            else p.rect(num(a, 'x'), num(a, 'y'), num(a, 'width'), num(a, 'height'));
          } else if (t === 'line') { p.moveTo(num(a, 'x1'), num(a, 'y1')); p.lineTo(num(a, 'x2'), num(a, 'y2')); }
          else {
            var pts = (at(a, 'points') || '').trim().split(/[ ,]+/).map(parseFloat);
            for (var j = 0; j + 1 < pts.length; j += 2) p[j ? 'lineTo' : 'moveTo'](pts[j], pts[j + 1]);
            if (t === 'polygon') p.closePath();
          }
        }
        out.push(p);
      } catch (e) { /* Path2D missing (very old engine) — draw nothing for it */ }
    }
    return (_shapes[key] = out);
  }
  function draw(ctx, name, x, y, size, color, opts) {
    if (!ctx || typeof Path2D === 'undefined') return;
    opts = opts || {};
    var solid = opts.variant === 'solid' && !!SOLID[name];
    var shapes = shapesOf(name, solid), k = (size || 16) / 24;
    ctx.save();
    ctx.translate(x, y); ctx.scale(k, k);
    ctx.lineWidth = opts.stroke || 1.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = ctx.fillStyle = color || '#475569';
    for (var i = 0; i < shapes.length; i++) { if (solid) ctx.fill(shapes[i], 'evenodd'); else ctx.stroke(shapes[i]); }
    ctx.restore();
  }

  /* V3.861 — a page that loads icons.js but none of the site stylesheets
   * (course modules, standalone tools) would paint each inline SVG at the
   * browser default 300x150. These are the same rules as style.css's .hi
   * block, at the FRONT of <head> so any page stylesheet still wins. */
  try {
    if (!document.getElementById('hi-base')) {
      var st = document.createElement('style');
      st.id = 'hi-base';
      st.textContent = '.hi{width:1em;height:1em;display:inline-block;vertical-align:-0.125em;flex:none;'
        + 'fill:none;stroke:currentColor;stroke-width:var(--hi-stroke,1.5);stroke-linecap:round;'
        + 'stroke-linejoin:round;overflow:visible}.hi-solid{fill:currentColor;stroke:none}'
        + '.hi-emoji{width:1em;height:1em;display:inline-block;line-height:1;text-align:center;font-style:normal;flex:none}'
        + '.hi-img{width:1em;height:1em;display:inline-block;vertical-align:-0.125em;object-fit:contain;flex:none}';
      var h = document.head || document.getElementsByTagName('head')[0];
      if (h) h.insertBefore(st, h.firstChild);
    }
  } catch (e) { /* no DOM (worker / node) */ }

  try {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { hydrate(); });
    else hydrate();
  } catch (e) {}

  window.ICON = {
    svg: svg,
    el: el,
    label: label,
    render: render,
    hydrate: hydrate,
    draw: draw,
    has: function (n) { return !!OUTLINE[n]; },
    names: function () { return Object.keys(OUTLINE).sort(); },
    /* glyph -> icon name, so a migrating call site can look up its own emoji */
    forGlyph: function (g) { return BY_GLYPH[g] || null; },
    getMode: function () { return mode; },
    setMode: function (m) { mode = (m === 'emoji') ? 'emoji' : 'icons'; return mode; },
  };
})();
`;

if (SCAN) scan();
if (EMOJI) emojiGate();

if (CHECK) {
  const onDisk = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (onDisk !== src) die('rm/js/icons.js is stale — run `node scripts/gen-icons.mjs`');
  console.log(`[gen-icons] check: rm/js/icons.js is current (${Object.keys(ICONS).length} icons)`);
} else {
  writeFileSync(OUT, src);
  const kb = (Buffer.byteLength(src) / 1024).toFixed(1);
  console.log(`[gen-icons] wrote rm/js/icons.js — ${Object.keys(ICONS).length} outline`
    + ` + ${Object.keys(solid).length} solid, ${kb} KB`);
  console.log(`[gen-icons] ${Object.keys(nameOf).length} glyphs mapped for ICON.render()`
    + ` / kill switch; ${missingSolid.length} icons outline-only`);
}

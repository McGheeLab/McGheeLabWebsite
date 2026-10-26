#!/usr/bin/env node
/* drive.mjs — headless driver for the Paper Lab (V3.906).
 *
 *   node scripts/paper-lab/drive.mjs import  <bundle.zip-url> <paperId>
 *   node scripts/paper-lab/drive.mjs preview <paperId> <outDir> [--template ID]
 *   node scripts/paper-lab/drive.mjs compile <paperId> <outDir>
 *
 * Talks to a running `serve.py` (PAPER_LAB_URL, default http://localhost:8917).
 * `preview` opens the paper in the REAL editor, opens the Document view and
 * writes one PNG per page sheet (preview-01.png …) plus preview.json (page
 * count + per-page layout metrics measured from the DOM). `compile` opens the
 * REAL Export page, presses "Compile to PDF" (lab-hooks.js routes it to local
 * Tectonic) and copies the PDF + log to outDir.
 *
 * Uses patchright/playwright resolved from PATCHRIGHT_ROOT, the CodeGPT VS
 * Code extension, or a global install. page.ev() evaluates in the MAIN world
 * (patchright's default world is isolated and cannot see page globals).
 */
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';

const BASE = process.env.PAPER_LAB_URL || 'http://localhost:8917';

function resolveChromium() {
  const roots = [];
  if (process.env.PATCHRIGHT_ROOT) roots.push(process.env.PATCHRIGHT_ROOT);
  const ext = path.join(os.homedir(), '.vscode', 'extensions');
  try {
    fs.readdirSync(ext).filter(d => d.startsWith('danielsanmedium.dscodegpt')).sort().reverse()
      .forEach(d => roots.push(path.join(ext, d, 'standalone') + '/'));
  } catch (e) { /* no extension dir */ }
  roots.push(process.cwd() + '/');
  for (const r of roots) {
    for (const name of ['patchright', 'playwright']) {
      try { return { chromium: createRequire(r)(name).chromium, patch: name === 'patchright' }; } catch (e) { /* next */ }
    }
  }
  throw new Error('patchright/playwright not found; set PATCHRIGHT_ROOT');
}

async function launch(opts = {}) {
  const { chromium, patch } = resolveChromium();
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1500, height: 1100 }, deviceScaleFactor: opts.dpr || 2, acceptDownloads: true });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) logs.push(m.type() + ': ' + m.text().slice(0, 400)); });
  page.on('pageerror', e => logs.push('pageerror: ' + (e.stack || e.message).slice(0, 800)));
  page.ev = (fn, arg) => patch ? page.evaluate(fn, arg, undefined, false) : page.evaluate(fn, arg);
  page.waitMain = async (fn, arg, ms = 30000) => {
    const t0 = Date.now();
    for (;;) {
      let v = null;
      try { v = await page.ev(fn, arg); } catch (e) { v = null; }
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error('waitMain timeout: ' + String(fn).slice(0, 120));
      await page.waitForTimeout(150);
    }
  };
  return { browser, page, logs };
}

async function cmdImport(zipUrl, paperId) {
  const { browser, page, logs } = await launch();
  await page.goto(BASE + '/rm/pages/paper-builder.html');
  await page.waitMain(() => !!(window.PaperImportEngine && window.PaperLab && window.JSZip));
  const res = await page.ev(async ([u, id]) => {
    try { return await window.PaperLab.importBundle(u, id); } catch (e) { return { error: String(e && e.stack || e) }; }
  }, [zipUrl, paperId]);
  await page.waitForTimeout(800);
  await browser.close();
  console.log(JSON.stringify({ res, logs: logs.filter(l => !/404/.test(l)).slice(0, 20) }, null, 1));
}

async function openEditor(page, paperId) {
  await page.goto(BASE + '/rm/pages/paper-builder.html?paper=' + encodeURIComponent(paperId));
  await page.waitMain(() => !!(window.PaperEditor && window.PaperEditor.getPaperMap() &&
    document.querySelectorAll('.pe-block').length > 0), null, 60000);
  // citation index + cite style settle
  await page.waitForTimeout(1500);
}

async function cmdPreview(paperId, outDir, args) {
  fs.mkdirSync(outDir, { recursive: true });
  const { browser, page, logs } = await launch({ dpr: 2, viewport: { width: 1400, height: 2600 } });
  await openEditor(page, paperId);
  if (args.template) {
    await page.ev(async (t) => {
      await firebridge.db().collection('paperExports').doc(window.PaperEditor.getPaperId()).set({ templateId: t }, { merge: true });
    }, args.template);
  }
  await page.ev(() => window.PaperDocView.open());
  // wait for at least one sheet and an idle status
  await page.waitMain(() => document.querySelectorAll('.pdv-sheet').length > 0 &&
    !(document.querySelector('.pdv-status') || {}).textContent, null, 90000);
  await page.waitForTimeout(2500);   // late image decode → one re-render
  await page.waitMain(() => !(document.querySelector('.pdv-status') || {}).textContent, null, 60000);
  // V3.914 — a grant document other than the narrative (--doc project_summary)
  if (args.doc) {
    await page.ev((d) => { const s = document.getElementById('pdv-doc'); if (s) { s.value = d; s.dispatchEvent(new Event('change', { bubbles: true })); } }, args.doc);
    await page.waitForTimeout(2500);
    await page.waitMain(() => !(document.querySelector('.pdv-status') || {}).textContent, null, 60000);
  }
  // actual size: zoom 1 so a sheet is its physical size at 96 dpi CSS px
  await page.ev(() => {
    const sel = document.querySelector('#pdv-zoom, .pdv-zoom select, select[data-pdv-zoom]');
    if (sel) { sel.value = '1'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.waitForTimeout(600);
  const metrics = await page.ev(() => {
    const sheets = Array.from(document.querySelectorAll('.pdv-sheet'));
    return sheets.map((s, i) => {
      const r = s.getBoundingClientRect();
      return { i, w: r.width, h: r.height, cls: s.className };
    });
  });
  // V3.915 — --probe FILE: a JS expression evaluated in the page (main
  // world) after layout; its JSON result lands in outDir/probe.json
  if (args.probe) {
    const res = await page.ev(fs.readFileSync(args.probe, 'utf8'));
    fs.writeFileSync(path.join(outDir, 'probe.json'), JSON.stringify(res, null, 1));
  }
  const handles = await page.$$('.pdv-sheet');
  for (let i = 0; i < handles.length; i++) {
    await handles[i].scrollIntoViewIfNeeded();
    await handles[i].screenshot({ path: path.join(outDir, 'preview-' + String(i + 1).padStart(2, '0') + '.png') });
  }
  const label = await page.ev(() => (document.querySelector('.pdv-pages-label') || {}).textContent || '');
  // every typeset line, per sheet, in reading order (column 1 then 2), for sync.py
  const lines = await page.ev(() => Array.from(document.querySelectorAll('.pdv-sheet')).map((sh) => {
    const top = sh.getBoundingClientRect();
    const mid = top.left + top.width / 2;
    const out = [];
    sh.querySelectorAll('.pts-ln, .pdv-heading, .pdv-subheading, .pdv-figcap, .pdv-tabcap').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (!r.height) return;
      const para = el.closest('[data-block-id]');
      // the zone a typeset line belongs to: body text, a caption, the
      // front matter, the bibliography — sync.py scores them apart
      const z = el.closest('.pdv-figcap, .pdv-tabcap') ? 'cap'
        : el.closest('.pdv-abstract, .pdv-keywords, .pdv-titleblock, .pdv-factbox') ? 'front'
        : el.closest('.pdv-bib') ? 'bib' : 'body';
      out.push({ b: para ? para.dataset.blockId : null, z,
        k: el.classList.contains('pts-ln') ? 'ln' : el.className.split(' ')[0].replace('pdv-', ''),
        x: r.left - top.left, y: r.top - top.top, col: r.right < mid + 2 ? 0 : (r.left > mid - 2 ? 1 : -1),
        t: el.textContent.replace(/\s+/g, ' ').trim().slice(0, 160) });
    });
    return out;
  }));
  // V3.912 — every wrapped figure the paginator set: page, wrapfig's size and line count
  const wraps = await page.ev(() => Array.from(document.querySelectorAll('.pdv-sheet')).flatMap((sh, i) =>
    Array.from(sh.querySelectorAll('.pdv-wrap-anchor, .pdv-wrap-dumped')).map((a) => {
      const f = a.classList.contains('pdv-wrap-anchor') ? a.querySelector('.pdv-figure') : a;
      return { page: i + 1, block: f && f.dataset.blockId, dumped: a.classList.contains('pdv-wrap-dumped'),
        size: a.dataset.wfSize ? +a.dataset.wfSize : null, lines: a.dataset.wfLines ? +a.dataset.wfLines : null,
        room: a.dataset.wfRoom ? +a.dataset.wfRoom : null };
    })));
  const eqs = await page.ev(() => Array.from(document.querySelectorAll('.pdv-sheet .pdv-eq')).slice(0, 6).map((e) => ({
    cls: e.className, styleH: e.style.height, h: e.getBoundingClientRect().height,
    katex: !!e.querySelector('.katex'), struts: Array.from(e.querySelectorAll('.strut')).map((s) => s.style.height + '/' + s.style.verticalAlign) })));
  const acct = await page.ev(() => Array.from(document.querySelectorAll('.pdv-sheet')).map((sh) => {
    try { return JSON.parse(sh.dataset.acct || 'null'); } catch (e) { return null; }
  }));
  fs.writeFileSync(path.join(outDir, 'preview.json'), JSON.stringify({ paperId, pages: handles.length, label, metrics, logs, wraps, acct, eqs }, null, 1));
  fs.writeFileSync(path.join(outDir, 'preview-lines.json'), JSON.stringify(lines));
  await browser.close();
  console.log(JSON.stringify({ pages: handles.length, label, logs: logs.filter(l => !/404/.test(l)).slice(0, 15) }, null, 1));
}

async function cmdCompile(paperId, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const { browser, page, logs } = await launch({ dpr: 1 });
  await page.goto(BASE + '/rm/pages/paper-export.html?paper=' + encodeURIComponent(paperId));
  await page.waitMain(() => {
    const b = document.getElementById('px-compile');
    return !!(b && !b.disabled && window.PaperExportTex);
  }, null, 60000);
  await page.waitForTimeout(2500);
  const respP = page.waitForResponse(r => r.url().includes('/paper-lab/api/compile'), { timeout: 600000 });
  await page.ev(() => document.getElementById('px-compile').click());
  const resp = await respP;
  const res = await resp.json();
  fs.writeFileSync(path.join(outDir, 'compile.json'), JSON.stringify(res, null, 1));
  if (res.ok && res.dir) {
    fs.copyFileSync(path.join(res.dir, 'main.pdf'), path.join(outDir, 'compiled.pdf'));
  }
  /* V3.916 — what the person sees after the response: the PDF mounted in
   * the viewer, or the status line (the old run stopped at the response) */
  let after = null;
  try {
    after = await page.waitMain(() => {
      const st = (document.getElementById('px-status') || document.querySelector('.px-status') || {}).textContent || '';
      const canv = document.querySelectorAll('#px-viewer canvas, #px-viewer .pdfv-page, #px-viewer .page').length;
      if (canv || /fail|error|no PDF/i.test(st) || /Compiled/.test(st)) return { status: st.trim(), viewerPages: canv };
      return null;
    }, null, 60000);
  } catch (e) {
    after = await page.ev(() => ({ status: ((document.getElementById('px-status') || {}).textContent || '').trim(),
      viewerHtml: ((document.getElementById('px-viewer') || {}).innerHTML || '').slice(0, 300), timedOut: true }));
  }
  fs.writeFileSync(path.join(outDir, 'compile-after.json'), JSON.stringify(after, null, 1));
  await page.waitForTimeout(500);
  await browser.close();
  console.log(JSON.stringify({ ok: res.ok, seconds: res.seconds, dir: res.dir, missing: res.missing, after,
    tail: res.ok ? '' : (res.log || '').slice(-3000), logs: logs.filter(l => !/404/.test(l)).slice(0, 15) }, null, 1));
}

/* V3.911 — compile one of a grant's documents from the Export page's
 * Grant documents card (--doc "References Cited"); saves <outDir>/doc.pdf */
async function cmdCompileDoc(paperId, outDir, args) {
  fs.mkdirSync(outDir, { recursive: true });
  const { browser, page, logs } = await launch({ dpr: 1 });
  await page.goto(BASE + '/rm/pages/paper-export.html?paper=' + encodeURIComponent(paperId));
  await page.waitMain(() => document.querySelectorAll('#px-subdocs .px-subdoc-row').length > 0, null, 60000);
  await page.waitForTimeout(2500);
  const rows = await page.ev(() => Array.from(document.querySelectorAll('#px-subdocs .px-subdoc-row')).map((r) => ({
    title: r.querySelector('.px-subdoc-title').textContent, hint: r.querySelector('.px-subdoc-hint').textContent,
    compile: !r.querySelectorAll('button')[1].disabled })));
  const respP = page.waitForResponse(r => r.url().includes('/paper-lab/api/compile'), { timeout: 600000 });
  const clicked = await page.ev((label) => {
    const r = Array.from(document.querySelectorAll('#px-subdocs .px-subdoc-row'))
      .find((x) => x.querySelector('.px-subdoc-title').textContent.indexOf(label) === 0);
    if (!r) return false;
    r.querySelectorAll('button')[1].click();
    return true;
  }, args.doc || 'References Cited');
  let res = null;
  if (clicked) {
    res = await (await respP).json();
    if (res.ok && res.dir) fs.copyFileSync(path.join(res.dir, 'main.pdf'), path.join(outDir, 'doc.pdf'));
  }
  fs.writeFileSync(path.join(outDir, 'compiledoc.json'), JSON.stringify({ rows, res }, null, 1));
  await browser.close();
  console.log(JSON.stringify({ rows, ok: res && res.ok, dir: res && res.dir, tail: res && !res.ok ? (res.log || '').slice(-2000) : '',
    logs: logs.filter(l => !/404/.test(l)).slice(0, 10) }, null, 1));
}

/* V3.910 — open the Document view, open the layout check, save its
 * report (check.json) and a screenshot of the window (check.png).
 * `--tighten N` presses the panel's "Tighten N paragraphs" first. */
async function cmdCheck(paperId, outDir, args) {
  fs.mkdirSync(outDir, { recursive: true });
  const { browser, page, logs } = await launch({ dpr: 1, viewport: { width: 1500, height: 1000 } });
  await openEditor(page, paperId);
  await page.ev(() => window.PaperDocView.open());
  await page.waitMain(() => document.querySelectorAll('.pdv-sheet').length > 0 &&
    !(document.querySelector('.pdv-status') || {}).textContent, null, 90000);
  await page.waitForTimeout(2500);
  await page.waitMain(() => !(document.querySelector('.pdv-status') || {}).textContent, null, 60000);
  await page.ev(() => { const b = document.getElementById('pdv-check'); if (b && !b.hidden) b.click(); });
  await page.waitForTimeout(400);
  const read = () => page.ev(() => {
    const p = document.querySelector('.pdv-check-panel');
    return { pages: document.querySelectorAll('.pdv-sheet').length,
      badge: (document.getElementById('pdv-check-count') || {}).textContent || '',
      text: p ? p.innerText : null };
  });
  const before = await read();
  let after = null;
  if (args.tighten || args['tighten-last'] || args.reset) {
    await page.ev((one) => {
      const bs = document.querySelectorAll(one === 'reset' ? '[data-pdv-check="reset"]'
        : one ? '[data-pdv-check="tighten"]' : '[data-pdv-check="save-page"]');
      const b = bs[bs.length - 1];
      if (b) b.click();
    }, args.reset ? 'reset' : !!args['tighten-last']);
    await page.waitForTimeout(3000);
    await page.waitMain(() => !(document.querySelector('.pdv-status') || {}).textContent, null, 60000);
    await page.waitForTimeout(800);
    after = await read();
  }
  // V3.913 — a grant: Fit to the page limit (--fit 1), then Keep (--keep 1)
  if (args.fit) {
    await page.screenshot({ path: path.join(outDir, 'check-before.png') });
    await page.ev(() => { const b = document.querySelector('[data-pdv-check="fit"]'); if (b) b.click(); });
    await page.waitMain(() => !!document.querySelector('[data-pdv-check="fit-keep"], [data-pdv-check="fit-dismiss"]'), null, 300000);
    await page.waitForTimeout(800);
    after = await read();
    if (args.keep) {
      await page.ev(() => { const b = document.querySelector('[data-pdv-check="fit-keep"]'); if (b) b.click(); });
      await page.waitForTimeout(4000);
      await page.waitMain(() => !(document.querySelector('.pdv-status') || {}).textContent, null, 60000);
      after.kept = await read();
    }
  }
  await page.screenshot({ path: path.join(outDir, 'check.png') });
  fs.writeFileSync(path.join(outDir, 'check.json'), JSON.stringify({ before, after, logs }, null, 1));
  await browser.close();
  console.log(JSON.stringify({ before: { pages: before.pages, badge: before.badge }, after: after && { pages: after.pages, badge: after.badge },
    logs: logs.filter(l => !/404/.test(l)).slice(0, 10) }, null, 1));
}

const [cmd, a1, a2, ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) args[rest[i].slice(2)] = rest[i + 1];
if (cmd === 'import') await cmdImport(a1, a2);
else if (cmd === 'preview') await cmdPreview(a1, a2, args);
else if (cmd === 'check') await cmdCheck(a1, a2, args);
else if (cmd === 'compile') await cmdCompile(a1, a2);
else if (cmd === 'compiledoc') await cmdCompileDoc(a1, a2, args);
else { console.error('usage: drive.mjs import|preview|compile …'); process.exit(2); }

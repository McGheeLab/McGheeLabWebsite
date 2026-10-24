// What a note with many PDF cards costs, in the real app at Retina density (V3.894).
//   node <browser-automation>/browser.mjs http://127.0.0.1:PORT/ --script scripts/litreview/render/pdfload.mjs
// env: DOC_ID (note), LAB=1 (add lab-mode.js §14, PDF cards on demand — only that section: the rest of the lab layer
// needs the cloud hub, which a desktop page served by serve.py does not have), SHOT=prefix for screenshots. Reports, from the DOM: drawn pages (on screen / total) and their
// canvas memory after opening; what a sync from "another device" does to the PDF canvases; zoomed far out; zoomed into
// one paper (quote highlights present); after panning away. Needs a writable local notebook (the sync step adds a note).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const LAB_JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../rm/scientia/lab-mode.js')

export default async (page) => {
  const DOC = process.env.DOC_ID || 'd_lra1e7c848c1', BASE = new URL(page.url()).origin, SHOT = process.env.SHOT || '/tmp/pdfload'
  const br = page.context().browser()
  const ctx = await br.newContext({ viewport: { width: 1700, height: 1050 }, deviceScaleFactor: +(process.env.DSF || 2) })
  const p = await ctx.newPage(), errors = []
  p.on('pageerror', e => errors.push(String(e).slice(0, 300))); p.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)) })
  if (process.env.LAB) {
    const src = fs.readFileSync(LAB_JS, 'utf8'), at = src.indexOf('/* ---- 14. '), end = src.lastIndexOf('})();')
    if (at < 0) throw new Error('lab-mode.js has no section 14')
    const sec14 = "(function(){ var LAB = window.SIS_LAB = window.SIS_LAB || {}; var warn = function () { console.error.apply(console, ['[lab-mode]'].concat([].slice.call(arguments))); };\n" +
      "if (!document.getElementById('lab-mode-css')) document.head.append(Object.assign(document.createElement('style'), { id: 'lab-mode-css' }));\n" + src.slice(at, end) + '\n})();'
    await p.route(BASE + '/', async route => {
      const r = await route.fetch(), html = await r.text()
      await route.fulfill({ status: 200, contentType: 'text/html', body: html.slice(0, html.lastIndexOf('</body>')) + '<script src="/__lab/pdf14.js"></script>' + html.slice(html.lastIndexOf('</body>')) })   // the LAST </body> (the app's code has the string too); not the original Content-Length (it would cut the page short)
    })
    await p.route(BASE + '/__lab/pdf14.js', route => route.fulfill({ body: sec14, contentType: 'text/javascript' }))
  }
  await p.goto(BASE + '/'); await p.waitForTimeout(4000)
  await p.evaluate(() => { window.__lt = []; try { new PerformanceObserver(l => l.getEntries().forEach(e => window.__lt.push(Math.round(e.duration)))).observe({ type: 'longtask' }) } catch (e) { window.__lt = null } })
  const stat = () => p.evaluate(() => {
    const vis = el => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth }
    const c = [...document.querySelectorAll('.pdfw canvas.pdf-page')], drawn = c.filter(x => x.width > 0 && x.height > 0 && !(x.width === 300 && x.height === 150))
    return { cards: document.querySelectorAll('.pdfw').length, cardsOnScreen: [...document.querySelectorAll('.pdfw')].filter(vis).length, drawn: drawn.length, drawnOnScreen: drawn.filter(vis).length,
      canvasMB: Math.round(drawn.reduce((s, x) => s + x.width * x.height * 4, 0) / 1048576), highlightsOnScreen: [...document.querySelectorAll('.pdfw .q-hl')].filter(vis).length,
      titles: [...document.querySelectorAll('.pdfw.lab-pdf-far')].filter(vis).length }
  })
  const longTasks = () => p.evaluate(() => { const l = window.__lt || []; window.__lt = []; return { n: l.length, totalMs: l.reduce((a, b) => a + b, 0), maxMs: Math.max(0, ...l) } })
  const settle = async (max = 40) => { let last = null, same = 0; for (let i = 0; i < max; i++) { await p.waitForTimeout(1000); const s = await stat(); if (last && s.drawn === last.drawn) same++; else same = 0; last = s; if (same >= 5) break } return last }
  const zoomAt = async (x, y, steps) => { await p.mouse.move(x, y); for (let i = 0; i < Math.abs(steps); i++) { await p.keyboard.down('Control'); await p.mouse.wheel(0, steps > 0 ? 120 : -120); await p.keyboard.up('Control'); await p.waitForTimeout(120) } }
  const out = {}

  await p.evaluate(id => { location.hash = '#/doc/' + id }, DOC)
  out.open = Object.assign(await settle(), { longTasks: await longTasks() })
  await p.screenshot({ path: SHOT + '-1-open.png' })

  // another device creates a note → a sync arrives → changed() → the canvas is rebuilt
  await p.evaluate(() => { document.querySelectorAll('.pdfw canvas.pdf-page').forEach(c => { c.dataset.mark = '1' }); document.querySelectorAll('.box').forEach(b => { b.dataset.lt = '1' }) })   // boxes made after this are new
  const st = await (await fetch(BASE + '/api/sync/state')).json(), now = new Date().toISOString(), id = 'd_sync' + Date.now().toString(36)
  await fetch(BASE + '/api/sync/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ anySid: true, dev: 'dv_synctest', name: 'Other device',
    ops: [{ store: 'documents', id, rec: { id, type: 'note', scope: 'global', projectId: null, themeId: null, title: 'sync test', created: now, modified: now, layout: { head: { x: 0, y: 0 } } }, del: false, prev: null, base: st.syncSeq || 0 }] }) })
  for (let i = 0; i < 20; i++) { await p.waitForTimeout(1000); if (await p.evaluate(() => [...document.querySelectorAll('.box[data-id]')].some(b => !b.dataset.lt))) break }
  await p.waitForTimeout(3000)
  out.sync = Object.assign(await p.evaluate(() => { const c = [...document.querySelectorAll('.pdfw canvas.pdf-page')]; return { boxesRebuilt: [...document.querySelectorAll('.box[data-id]')].filter(b => !b.dataset.lt).length, pageCanvasesKept: c.filter(x => x.dataset.mark).length, pageCanvasesNew: c.filter(x => !x.dataset.mark).length } }), { longTasks: await longTasks() })

  // zoom far out over bare paper (left edge)
  await zoomAt(20, 700, 9); await p.waitForTimeout(2500)
  out.farOut = await stat(); await p.screenshot({ path: SHOT + '-2-far.png' })

  // zoom back in onto the first paper of the H2 column (Hino 2020)
  const hino = await p.evaluate(() => { const b = [...document.querySelectorAll('.box.w-pdf')].find(x => /Hino/.test(x.textContent)); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left - 6, y: r.top + r.height / 3 } })
  if (hino) { await zoomAt(Math.max(5, hino.x), hino.y, -9); out.zoomIn = await settle(15); await p.screenshot({ path: SHOT + '-3-in.png' }) }

  // pan away down the canvas (wheel scrolls the paper when not over a card)
  await p.mouse.move(8, 500); for (let i = 0; i < 12; i++) { await p.mouse.wheel(0, 400); await p.waitForTimeout(100) }
  await p.waitForTimeout(6000)
  out.pannedAway = await stat()
  out.errors = errors.slice(0, 10)
  return out
}

// open a note, optionally pan (wheel) and zoom, measure every box, screenshot
export default async (page) => {
  await page.setViewportSize({ width: +(process.env.VW || 1700), height: +(process.env.VH || 1050) })
  if (process.env.CLEAR) { await page.evaluate(() => new Promise(r => { const q = indexedDB.deleteDatabase('scientia-in-situ'); q.onsuccess = q.onerror = q.onblocked = () => r() })); try { localStorage.clear() } catch {} await page.reload(); await page.waitForTimeout(4000) }
  await page.waitForTimeout(+(process.env.PRE || 0)); await page.evaluate(id => { location.hash = '#/doc/' + id }, process.env.DOC_ID)
  await page.waitForTimeout(+(process.env.BOOT || 3500))
  await page.mouse.move(850, 600)
  const dy = +(process.env.DY || 0), dx = +(process.env.DX || 0)
  for (let i = 0; i < 10 && (dy || dx); i++) { await page.mouse.wheel(dx / 10, dy / 10); await page.waitForTimeout(80) }
  if (process.env.ZOOMOUT) { for (let i = 0; i < +process.env.ZOOMOUT; i++) { await page.keyboard.down('Control'); await page.mouse.wheel(0, 120); await page.keyboard.up('Control'); await page.waitForTimeout(120) } }
  await page.waitForTimeout(+(process.env.SETTLE || 4000))
  const boxes = await page.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll('.box[data-id]')).map(b => [b.dataset.id, [b.offsetLeft, b.offsetTop, b.offsetWidth, b.offsetHeight]])))
  const pdfs = await page.evaluate(() => Array.from(document.querySelectorAll('.pdfw')).map(p => ({ canv: p.querySelectorAll('canvas').length, hl: p.querySelectorAll('.q-hl').length, miss: (p.querySelector('.embed-missing') || {}).textContent || null })))
  if (process.env.BOXES) (await import('node:fs')).writeFileSync(process.env.BOXES, JSON.stringify(boxes))
  await page.screenshot({ path: process.env.SHOT })
  return { n: Object.keys(boxes).length, pdfs }
}

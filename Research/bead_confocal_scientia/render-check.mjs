// Render check for the Scientia project: visit every note in a live browser session on a desktop serve.py notebook, measure every box,
// flag overlapping boxes and missing HTML embeds, save heights.json (for build-project.js --heights) and screenshots.
//   OUT=<folder> RECORDS=<records.json> node ~/.claude/skills/browser-automation/browser.mjs --session sci --script Research/bead_confocal_scientia/render-check.mjs
// NOTES=overview,binding limits it; NOSHOT=1 skips screenshots.
import fs from 'node:fs'
export default async function run(page) {
  const SP = process.env.OUT, R = JSON.parse(fs.readFileSync(process.env.RECORDS || SP + "/records.json", "utf8"))
  const only = (process.env.NOTES || '').split(',').filter(Boolean)
  await page.setViewportSize({ width: 1700, height: 1050 })
  await page.evaluate(() => { try { Object.keys(localStorage).filter(k => k.includes('view:')).forEach(k => localStorage.removeItem(k)) } catch (e) {} })
  await page.reload(); await page.waitForTimeout(5000)
  const heights = {}, report = {}
  for (const [key, id] of Object.entries(R.notes)) {
    if (only.length && !only.includes(key)) continue
    await page.evaluate(id => { location.hash = '#/doc/' + id }, id)
    await page.waitForTimeout(+(process.env.WAIT || 4500))
    const boxes = await page.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll('.box[data-id]')).map(b => [b.dataset.id, [b.offsetLeft, b.offsetTop, b.offsetWidth, b.offsetHeight]])))
    const ids = Object.keys(boxes).filter(k => k !== '_head' && !k.startsWith('_')), ov = []
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const a = boxes[ids[i]], b = boxes[ids[j]], dx = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]), dy = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1])
      if (dx > 4 && dy > 4) ov.push([ids[i], ids[j], dx, dy])
    }
    for (const k of ids) heights[k] = boxes[k]
    if (boxes._head) heights['_head:' + id] = boxes._head[3]
    const errs = await page.evaluate(() => Array.from(document.querySelectorAll('.embed-missing')).length)
    report[key] = { boxes: ids.length, overlaps: ov.length, ov: ov.slice(0, 4), missingEmbeds: errs }
    if (!process.env.NOSHOT && ids.length) {
      await page.screenshot({ path: `${SP}/shots/${key}-top.png` })
      await page.mouse.move(850, 600)
      for (let i = 0; i < +(process.env.ZOOMOUT || 14); i++) { await page.keyboard.down('Control'); await page.mouse.wheel(0, 120); await page.keyboard.up('Control'); await page.waitForTimeout(70) }
      await page.waitForTimeout(600)
      const r = await page.evaluate(() => { const bs = [...document.querySelectorAll('.box[data-id]')].map(b => b.getBoundingClientRect()); return [Math.min(...bs.map(b => b.left)), Math.min(...bs.map(b => b.top))] })
      for (let i = 0; i < 10; i++) { await page.mouse.wheel((r[0] - 20) / 10, (r[1] - 100) / 10); await page.waitForTimeout(40) }
      await page.waitForTimeout(1800)
      await page.screenshot({ path: `${SP}/shots/${key}-all.png` })
    }
  }
  fs.writeFileSync(SP + '/heights.json', JSON.stringify(heights))
  return report
}

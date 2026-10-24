// open the note, fit out, then zoom in anchored on blank paper just left of the TARGET box (cards eat the wheel)
export default async (page) => {
  await page.setViewportSize({ width: +(process.env.VW || 1700), height: +(process.env.VH || 1050) })
  await page.evaluate(id => { location.hash = '#/doc/' + id }, process.env.DOC_ID)
  await page.waitForTimeout(6000)
  const ctrlWheel = async (n, dy) => { for (let i = 0; i < n; i++) { await page.keyboard.down('Control'); await page.mouse.wheel(0, dy); await page.keyboard.up('Control'); await page.waitForTimeout(70) } }
  const rect = id => page.evaluate(id => { const e = document.querySelector('.box[data-id="' + id + '"]'); if (!e) return null; const b = e.getBoundingClientRect(); return [b.left, b.top, b.width, b.height] }, id)
  await page.mouse.move(60, 300); await ctrlWheel(+(process.env.OUT || 14), 100); await page.waitForTimeout(800)
  let r = await rect(process.env.TARGET)
  // pan (wheel over bare paper at the far left) so the target's top sits near the top of the screen
  { const dy = r[1] - +(process.env.TOPY || 160); await page.mouse.move(8, 500); for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, dy / 10); await page.waitForTimeout(40) } await page.waitForTimeout(500); r = await rect(process.env.TARGET) }
  const px = Math.max(5, r[0] - +(process.env.GAP || 25)), py = Math.min(980, Math.max(90, r[1] + r[3] * +(process.env.FY || 0.1)))
  const under = await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e ? (e.closest('.box') ? 'BOX ' : 'paper ') + e.className : null }, [px, py])
  await page.mouse.move(px, py); await ctrlWheel(+(process.env.IN || 10), -100)
  await page.waitForTimeout(+(process.env.SETTLE || 6000))
  await page.screenshot({ path: process.env.SHOT })
  return { at: [px, py], under, after: await rect(process.env.TARGET), z: await page.evaluate(() => document.querySelector('.world') ? document.querySelector('.world').style.transform : null) }
}

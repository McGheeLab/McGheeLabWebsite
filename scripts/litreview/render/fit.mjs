export default async (page) => {
  await page.setViewportSize({ width: 1700, height: 1050 })
  await page.evaluate(id => { location.hash = '#/doc/' + id }, process.env.DOC_ID)
  await page.waitForTimeout(6000)
  await page.mouse.move(8, 500)
  for (let i = 0; i < 20; i++) { await page.keyboard.down('Control'); await page.mouse.wheel(0, 100); await page.keyboard.up('Control'); await page.waitForTimeout(60) }
  // pan so the canvas's top-left content is at the top-left of the screen
  const r = await page.evaluate(() => { const bs = [...document.querySelectorAll('.box[data-id]')].map(b => b.getBoundingClientRect()); return [Math.min(...bs.map(b => b.left)), Math.min(...bs.map(b => b.top))] })
  for (let i = 0; i < 10; i++) { await page.mouse.wheel((r[0] - 20) / 10, (r[1] - 90) / 10); await page.waitForTimeout(40) }
  await page.waitForTimeout(5000)
  await page.screenshot({ path: process.env.SHOT })
  return await page.evaluate(() => document.querySelector('.world').style.transform)
}

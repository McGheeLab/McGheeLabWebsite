export default async function run(page) {
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto('http://localhost:8791/modules/bme295c/lesson-01.html#talk-Nan-kuei_Chen');
  await page.waitForSelector('.talk', { timeout: 30000 });
  await page.waitForTimeout(1200);
  await page.locator('#talk-Nan-kuei_Chen').scrollIntoViewIfNeeded();
  await page.locator('#talk-Nan-kuei_Chen details').first().evaluate(d => d.open = true);
  await page.waitForTimeout(600);
  await page.screenshot({ path: './bme295c-card.png', fullPage: false });
  return { ok: true };
}

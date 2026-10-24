// Render the setup diagrams (SVG pages in this folder) to PNG in ../figures/, at the SVG's own pixel size (2x the viewBox).
//   node ~/.claude/skills/browser-automation/browser.mjs about:blank --script Research/bead_confocal_sim/diagrams/render.mjs
// DIAGRAMS=setup_assay,setup_section limits the run.
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
export default async function run(page) {
  const here = path.dirname(fileURLToPath(import.meta.url)), out = path.join(here, '..', 'figures')
  const only = (process.env.DIAGRAMS || '').split(',').filter(Boolean)
  const files = readdirSync(here).filter(f => f.endsWith('.html') && (!only.length || only.includes(f.replace('.html', ''))))
  const done = []
  for (const f of files) {
    await page.setViewportSize({ width: 2500, height: 1600 })
    await page.goto('file://' + path.join(here, f))
    await page.waitForTimeout(300)
    const el = page.locator('#fig')
    const png = path.join(out, f.replace('.html', '.png'))
    await el.screenshot({ path: png })
    done.push(png)
  }
  return done
}

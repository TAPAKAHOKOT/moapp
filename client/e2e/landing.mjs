import { mkdirSync } from 'node:fs'
import { webkit } from 'playwright'
import { BASE, SHOTS, sleep } from './common.mjs'
mkdirSync(SHOTS, { recursive: true })
const browser = await webkit.launch()
for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 393, height: 659 }]]) {
  for (const scheme of ['dark', 'light']) {
    const context = await browser.newContext({ viewport, colorScheme: scheme })
    const page = await context.newPage()
    await page.goto(BASE)
    await page.waitForSelector('.empty-state', { timeout: 15000 })
    await sleep(400)
    await page.screenshot({ path: `${SHOTS}landing-${name}-${scheme}.png` })
    const metrics = await page.evaluate(() => {
      const b = document.querySelector('.empty-state .primary'); const h1 = document.querySelector('.empty-state h1')
      return { buttonWidth: b?.getBoundingClientRect().width, h1Width: h1?.getBoundingClientRect().width, mainWidth: document.querySelector('.empty-state')?.getBoundingClientRect().width }
    })
    console.log(name, scheme, 'landing', JSON.stringify(metrics))
    await page.locator('.empty-state .primary').click()
    await sleep(500)
    await page.screenshot({ path: `${SHOTS}landing-${name}-${scheme}-sheet.png` })
    const sheet = await page.evaluate(() => {
      const s = document.querySelector('.bottom-sheet'); const inputs = [...document.querySelectorAll('.bottom-sheet input')].map((i) => Math.round(i.getBoundingClientRect().width)); const labels = [...document.querySelectorAll('.bottom-sheet label')].map((l) => Math.round(l.getBoundingClientRect().width))
      const primary = document.querySelector('.bottom-sheet .primary'); const r = s.getBoundingClientRect()
      return { sheet: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(innerHeight - r.bottom) }, inputs, labels, primaryWidth: Math.round(primary.getBoundingClientRect().width), fontSizeLabel: getComputedStyle(document.querySelector('.bottom-sheet label')).fontSize }
    })
    console.log(name, scheme, 'sheet', JSON.stringify(sheet))
    await context.close()
  }
}
await browser.close()

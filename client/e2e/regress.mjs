// Visual regression set: node regress.mjs <label>  → shots/regress-<label>/*.png
import { mkdirSync } from 'node:fs'
import { webkit } from 'playwright'
import { launch, openApp, goTab, acceptDeviceLink, BASE, SHOTS, sleep, touchDrag } from './common.mjs'
const link = process.argv.find((arg) => arg.includes('#/device/'))
const label = process.argv.slice(2).find((arg) => !arg.includes('#/device/')) ?? 'now'
const dir = `${SHOTS}regress-${label}/`
mkdirSync(dir, { recursive: true })
const mask = (page) => [page.locator('.entry-card .topline .date-chip')]

let pendingLink = link
async function phone(scheme, viewport, tag) {
  const { browser, context, page, statePath } = await launch('webkit', { colorScheme: scheme, viewport })
  if (pendingLink) { await acceptDeviceLink(page, context, statePath, pendingLink); pendingLink = null }
  await openApp(page)
  await sleep(300)
  await page.screenshot({ path: `${dir}${tag}-${scheme}-entry.png`, mask: mask(page) })
  await touchDrag(page, '.swipe-area', { x: 60, y: 150 }, { x: 330, y: 150 }, { steps: 10, stepDelay: 30 })
  await sleep(700)
  await page.screenshot({ path: `${dir}${tag}-${scheme}-entry-edit.png`, mask: mask(page) })
  await touchDrag(page, '.swipe-area', { x: 330, y: 150 }, { x: 40, y: 150 }, { steps: 10, stepDelay: 30 })
  await sleep(700)
  await page.locator('.entry-lower-live .tag-strip .extra-add').click()
  await sleep(500)
  await page.screenshot({ path: `${dir}${tag}-${scheme}-tag-sheet.png`, mask: mask(page) })
  await page.locator('.tag-sheet .icon-button').click()
  await sleep(400)
  await page.locator('.main-categories button', { hasText: 'Ещё' }).click()
  await sleep(500)
  await page.screenshot({ path: `${dir}${tag}-${scheme}-category-sheet.png`, mask: mask(page) })
  await page.locator('.bottom-sheet .icon-button').click()
  await sleep(400)
  await goTab(page, 'История')
  await sleep(400)
  await page.screenshot({ path: `${dir}${tag}-${scheme}-history.png` })
  await page.locator('.history-chip-strip .filter-chip', { hasText: 'Даты' }).click()
  await sleep(500)
  await page.screenshot({ path: `${dir}${tag}-${scheme}-period-sheet.png` })
  await page.locator('.period-sheet .icon-button').click()
  await sleep(400)
  await goTab(page, 'Аналитика')
  await sleep(1600)
  await page.screenshot({ path: `${dir}${tag}-${scheme}-analytics.png` })
  await page.locator('.analytics-period button', { hasText: 'Месяц' }).click()
  await sleep(1600)
  await page.evaluate(() => { document.querySelectorAll('.page-slot')[2].scrollTop = 500 })
  await sleep(300)
  await page.screenshot({ path: `${dir}${tag}-${scheme}-analytics-month-scrolled.png` })
  await goTab(page, 'Настройки')
  await sleep(700)
  await page.screenshot({ path: `${dir}${tag}-${scheme}-settings.png` })
  await page.locator('.settings-row', { hasText: 'Категории' }).click()
  await sleep(500)
  await page.screenshot({ path: `${dir}${tag}-${scheme}-settings-categories.png` })
  await page.locator('.list-sheet .icon-button').click()
  await sleep(300)
  await page.locator('.settings-row', { hasText: 'Карта Bybit' }).click()
  await sleep(700)
  await page.screenshot({ path: `${dir}${tag}-${scheme}-settings-bybit.png` })
  await browser.close()
}

await phone('light', { width: 393, height: 659 }, 'p393')
await phone('dark', { width: 393, height: 659 }, 'p393')
await phone('light', { width: 320, height: 568 }, 'p320')
await phone('light', { width: 390, height: 763 }, 'p390')

// desktop: landing + sheet, app settings + dialog
const browser = await webkit.launch()
for (const scheme of ['light', 'dark']) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme })
  const page = await context.newPage()
  await page.goto(BASE)
  await page.waitForSelector('.empty-state')
  await sleep(400)
  await page.screenshot({ path: `${dir}d1440-${scheme}-landing.png` })
  await page.locator('.empty-state .primary').click()
  await sleep(500)
  await page.screenshot({ path: `${dir}d1440-${scheme}-landing-sheet.png` })
  await context.close()
}
await browser.close()
{
  const { browser, page } = await launch('webkit', { colorScheme: 'light', viewport: { width: 1280, height: 800 } })
  await openApp(page)
  await sleep(300)
  await page.screenshot({ path: `${dir}d1280-light-entry.png`, mask: mask(page) })
  await goTab(page, 'Настройки')
  await sleep(600)
  await page.locator('.settings-row', { hasText: 'Теги' }).click()
  await sleep(500)
  await page.screenshot({ path: `${dir}d1280-light-settings-tags.png` })
  await browser.close()
}
console.log('captured', label)

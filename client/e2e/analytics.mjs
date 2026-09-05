import { mkdirSync, existsSync } from 'node:fs'
import { launch, openApp, goTab, acceptDeviceLink, SHOTS, sleep } from './common.mjs'

// Capture what happens on the analytics page when period / week / currency change.
const link = process.argv.find((arg) => arg.includes('#/device/'))
const kind = process.argv.slice(2).find((arg) => arg === 'chromium') ?? 'webkit'
const dir = `${SHOTS}analytics-${kind}/`
mkdirSync(dir, { recursive: true })
const { browser, context, page, statePath } = await launch(kind)
if (link) await acceptDeviceLink(page, context, statePath, link)
await openApp(page)
await goTab(page, 'Аналитика')
await sleep(1500)

const snapshot = () => page.evaluate(() => {
  const h1 = document.querySelector('.analytics-title h1')
  const cards = [...document.querySelectorAll('.chart-card')].map((c) => ({ h: Math.round(c.getBoundingClientRect().height), title: c.querySelector('h2')?.textContent, canvas: Boolean(c.querySelector('canvas')), skeleton: Boolean(c.querySelector('.chart-skeleton')), empty: Boolean(c.querySelector('.analytics-empty')), opacity: getComputedStyle(c).opacity }))
  return {
    loading: document.querySelector('.analytics')?.classList.contains('loading'),
    total: h1?.textContent,
    h1Opacity: h1 ? getComputedStyle(h1).opacity : null,
    status: document.querySelector('.analytics .rate-caption[role="status"]')?.textContent ?? null,
    legend: document.querySelectorAll('.legend-row').length,
    cards,
    pageHeight: document.querySelectorAll('.page-slot')[2]?.scrollHeight,
  }
})

async function capture(name, action) {
  console.log(`\n=== ${name} ===`)
  console.log('before', JSON.stringify(await snapshot()))
  await action()
  let previous = ''
  for (let i = 0; i < 30; i++) {
    const s = JSON.stringify(await snapshot())
    if (s !== previous) { console.log(i, s); previous = s }
    await page.screenshot({ path: `${dir}${name}-${String(i).padStart(2, '0')}.png` })
    await sleep(40)
  }
}

await capture('week-to-month', () => page.locator('.analytics-period button', { hasText: 'Месяц' }).click())
await capture('prev-month', () => page.locator('.week-navigator button[aria-label="Предыдущий месяц"]').click())
await capture('month-to-week', () => page.locator('.analytics-period button', { hasText: 'Неделя' }).click())
await capture('prev-week', () => page.locator('.week-navigator button[aria-label="Предыдущая неделя"]').click())
await capture('focus-category', () => page.locator('.legend-row').first().click())
await capture('currency', async () => { await page.locator('.currency-choice').click(); await sleep(400); await page.locator('.currency-list button', { hasText: 'EUR' }).first().click() })
await browser.close()

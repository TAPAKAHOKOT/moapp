import { webkit, chromium, devices } from 'playwright'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const BASE = process.env.MOAPP_BASE ?? 'http://localhost:5173'
export const STATE_WEBKIT = new URL('./.state/webkit.json', import.meta.url).pathname
export const STATE_CHROMIUM = new URL('./.state/chromium.json', import.meta.url).pathname
export const SHOTS = new URL('./.shots/', import.meta.url).pathname

export async function launch(kind = 'webkit', { colorScheme = 'light', viewport } = {}) {
  const browser = kind === 'webkit' ? await webkit.launch() : await chromium.launch()
  const statePath = kind === 'webkit' ? STATE_WEBKIT : STATE_CHROMIUM
  const device = devices['iPhone 15']
  const context = await browser.newContext({
    ...device,
    viewport: viewport ?? { width: 393, height: 659 },
    colorScheme,
    ...(existsSync(statePath) ? { storageState: statePath } : {}),
  })
  const page = await context.newPage()
  return { browser, context, page, statePath }
}

// Первый запуск: node e2e/<script>.mjs 'http://localhost:5173/#/device/<token>' — ссылка из «Другие устройства».
export async function acceptDeviceLink(page, context, statePath, url) {
  mkdirSync(dirname(statePath), { recursive: true })
  await page.goto(url)
  const button = page.getByRole('button', { name: 'Подключить' })
  await button.waitFor({ state: 'visible', timeout: 15000 })
  await page.waitForFunction(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Подключить'); return b && !b.disabled }, null, { timeout: 15000 })
  await button.click()
  await page.waitForSelector('.app-shell', { timeout: 20000 })
  await context.storageState({ path: statePath })
}

export async function openApp(page) {
  await page.goto(BASE)
  await page.waitForSelector('.app-shell', { timeout: 20000 })
  await page.waitForTimeout(600)
}

export async function goTab(page, label) {
  await page.locator(`.bottom-nav button:has-text("${label}")`).click()
  await page.waitForTimeout(700)
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Synthesised touch sequence for WebKit (no Touch constructor in headless WebKit) and Chromium.
export async function touchDrag(page, selector, from, to, { steps = 12, holdMs = 0, stepDelay = 16 } = {}) {
  await page.evaluate(async ({ selector, from, to, steps, holdMs, stepDelay }) => {
    const target = document.querySelector(selector) ?? document.elementFromPoint(from.x, from.y) ?? document.body
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const mk = (x, y) => {
      if (typeof document.createTouch === 'function') return document.createTouch(window, target, 1, x, y, x, y, x, y)
      return new Touch({ identifier: 1, target, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y, radiusX: 1, radiusY: 1, force: 1 })
    }
    const list = (items) => typeof document.createTouchList === 'function' ? document.createTouchList(...items) : items
    const fire = (type, touches, changed) => {
      const event = new TouchEvent(type, { touches: list(touches), targetTouches: list(touches), changedTouches: list(changed), bubbles: true, cancelable: true, composed: true })
      target.dispatchEvent(event)
      return event
    }
    const start = mk(from.x, from.y)
    fire('touchstart', [start], [start])
    for (let i = 1; i <= steps; i++) {
      const x = from.x + (to.x - from.x) * i / steps
      const y = from.y + (to.y - from.y) * i / steps
      const t = mk(x, y)
      fire('touchmove', [t], [t])
      await sleep(stepDelay)
    }
    if (holdMs) await sleep(holdMs)
    const end = mk(to.x, to.y)
    fire('touchend', [], [end])
  }, { selector, from, to, steps, holdMs, stepDelay })
}

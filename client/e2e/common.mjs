import { webkit, chromium, devices } from 'playwright'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const BASE = process.env.MOAPP_BASE ?? 'http://localhost:5173'
// Вход у каждого порта свой (у стендов замеров — свои базы), у dev-сервера на 5173 — прежние файлы.
const port = new URL(BASE).port
const stateSuffix = port && port !== '5173' ? `-${port}` : ''
export const STATE_WEBKIT = new URL(`./.state/webkit${stateSuffix}.json`, import.meta.url).pathname
export const STATE_CHROMIUM = new URL(`./.state/chromium${stateSuffix}.json`, import.meta.url).pathname
export const SHOTS = new URL('./.shots/', import.meta.url).pathname

// Сервис-воркер выключен: на продакшен-сборке (стенд замеров) он при первой загрузке забирает страницу
// и перезагружает её посреди прогона — вместе со ссылкой входа и снимками.
export async function launch(kind = 'webkit', { colorScheme = 'light', viewport } = {}) {
  const browser = kind === 'webkit' ? await webkit.launch() : await chromium.launch()
  const statePath = kind === 'webkit' ? STATE_WEBKIT : STATE_CHROMIUM
  const device = devices['iPhone 15']
  const context = await browser.newContext({
    ...device,
    viewport: viewport ?? { width: 393, height: 659 },
    colorScheme,
    serviceWorkers: 'block',
    ...(existsSync(statePath) ? { storageState: statePath } : {}),
  })
  // Жёсткие таймауты: ожидание селектора или клика не висит дольше 15 с, загрузка страницы — 20 с.
  context.setDefaultTimeout(15000)
  context.setDefaultNavigationTimeout(20000)
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
  const screen = await page.waitForSelector('.app-shell, .empty-state', { timeout: 20000 })
  if (await screen.evaluate((node) => node.classList.contains('empty-state'))) throw new Error(`на ${BASE} нет входа: передайте первому запуску ссылку входа (стенд — node client/e2e/perf/stand.mjs link --port=N)`)
  await page.waitForTimeout(600)
}

export async function goTab(page, label) {
  await page.locator(`.bottom-nav button:has-text("${label}")`).click()
  await page.waitForTimeout(700)
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// То, что телефон помнит сам и что меняет снимки, одинаково в каждом прогоне и после каждой перезагрузки:
// карточка «Сохраните ссылку доступа» полная (счётчик показов с нуля — после двух показов она сворачивается в строку),
// подсказка про удержание уже показана и не всплывает тостом при входе в «Настройку экрана».
export async function pinLocalState(context) {
  await context.addInitScript(() => {
    try {
      const user = localStorage.getItem('moapp:v2:known-user')
      if (!user) return
      localStorage.setItem(`moapp:v2:user:${user}:recovery-reminder`, JSON.stringify({ shows: 0, snoozedUntil: null }))
      localStorage.setItem(`moapp:v2:user:${user}:hold-hint`, '1')
    } catch { /* без хранилища приложение возьмёт значения по умолчанию */ }
  })
}

// Настройки аккаунта (null — значение по умолчанию) и свои настройки человека в каждом его пространстве.
export const DEFAULT_ACCOUNT = { theme: null, accent: null, textSize: null, analyticsPeriod: 'week', entryBlocks: null, historyBlocks: null, analyticsBlocks: null }
export const DEFAULT_MEMBER = { historyFilters: null, analyticsCurrency: null, lastCurrency: null, categoryOrder: null, tagOrder: null }
export const ALL_BLOCKS = {
  entryBlocks: { shown: ['today', 'usual', 'keypad', 'tiles', 'note', 'tags'], hidden: [] },
  analyticsBlocks: { shown: ['trend', 'pace', 'categories', 'top', 'tags', 'weekdays', 'calendar'], hidden: [] },
}

// Запросы идут со страницы того же адреса: годится и открытое приложение (потом перезагрузить), и /api/health.
export async function patchSettings(page, account, member = null) {
  await page.evaluate(async ({ account, member }) => {
    const session = await (await fetch('/api/session', { credentials: 'include' })).json()
    if (!session?.authenticated) throw new Error('нет входа: передайте первому запуску ссылку входа')
    const headers = { 'content-type': 'application/json', 'X-Moapp-Expected-User-Id': session.user.id, 'X-Moapp-Expected-Session-Id': session.currentSessionId }
    const send = async (path, settings) => {
      const response = await fetch(path, { method: 'PATCH', credentials: 'include', headers, body: JSON.stringify({ settings }) })
      if (!response.ok) throw new Error(`PATCH ${path} → ${response.status} ${await response.text()}`)
    }
    if (account) await send('/api/me/settings', account)
    if (member) for (const workspace of session.workspaces) await send(`/api/workspaces/${workspace.id}/me/settings`, member)
  }, { account, member })
}

// Каждый прогон начинается с одного и того же аккаунта: «Неделя», экраны по умолчанию, обычный текст, исходный цвет,
// без фильтров истории. Отдельный контекст на /api/health: приложение не успеет отправить поверх свои настройки.
export async function resetAccount(kind = 'webkit') {
  const { browser, page } = await launch(kind)
  try {
    await page.goto(`${BASE}/api/health`)
    await patchSettings(page, DEFAULT_ACCOUNT, DEFAULT_MEMBER)
  } finally { await browser.close() }
}

// Synthesised touch sequence for WebKit (no Touch constructor in headless WebKit) and Chromium.
// selector = null — касание получает элемент под пальцем в точке from (например, конкретная строка «Истории»).
export async function touchDrag(page, selector, from, to, { steps = 12, holdMs = 0, stepDelay = 16 } = {}) {
  await page.evaluate(async ({ selector, from, to, steps, holdMs, stepDelay }) => {
    const target = (selector ? document.querySelector(selector) : null) ?? document.elementFromPoint(from.x, from.y) ?? document.body
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


// Предохранитель на весь скрипт: что бы ни зависло, процесс выйдет с кодом 2.
export function guard(ms, name) {
  setTimeout(() => { console.error(`${name}: не уложился в ${Math.round(ms / 1000)} с, выхожу`); process.exit(2) }, ms).unref()
}

// Функция состояния для страницы: sample(arg) без замыканий, результат — простой объект.
const sampleExpression = (sample, arg) => `(${sample.toString()})(${JSON.stringify(arg ?? null)})`

// Покадровая запись в реальном времени: requestAnimationFrame на странице пишет состояние каждого кадра (~16 мс) в течение
// ms от старта, пока скрипт ведёт действие. shots — снимки по ходу: [{ at: мс от старта, path, clip? }]; снимок в WebKit
// занимает ~90 мс, поэтому в JSON идёт фактическое время каждого. Запись кончается и по таймеру страницы — даже если
// кадры перестали приходить.
export async function realtimeFrames(page, { ms = 500, sample, arg, action, shots = [] }) {
  await page.evaluate(`(() => {
    const record = window.__realtime = { samples: [], t0: performance.now() }
    record.done = new Promise((resolve) => {
      setTimeout(resolve, ${ms + 1500})
      const tick = (now) => {
        record.samples.push({ t: Math.round(now - record.t0), ...${sampleExpression(sample, arg)} })
        if (now - record.t0 < ${ms}) requestAnimationFrame(tick)
        else resolve()
      }
      requestAnimationFrame(tick)
    })
  })()`)
  const started = Date.now()
  const taken = []
  const shooting = (async () => {
    for (const shot of shots) {
      const wait = shot.at - (Date.now() - started)
      if (wait > 0) await sleep(wait)
      const t = await page.evaluate(() => Math.round(performance.now() - window.__realtime.t0))
      await page.screenshot({ path: shot.path, ...(shot.clip ? { clip: shot.clip } : {}) })
      taken.push({ t, png: shot.path.split('/').pop() })
    }
  })()
  await action()
  await shooting
  await page.evaluate(() => window.__realtime.done)
  return { samples: await page.evaluate(() => window.__realtime.samples), shots: taken }
}

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

// Покадровая запись, два режима.
// Реальное время: requestAnimationFrame на странице пишет состояние каждого кадра (~16 мс), пока скрипт ведёт жест.
// Замороженное: часы страницы стоят (page.clock, ставится до загрузки), CSS-переходы и Web Animations на паузе, и скрипт
// сам двигает время шагами по 16 мс — события жеста на своих шагах, после шага состояние и снимок. Кадры такого прогона
// повторяются один в один, их можно сравнивать попиксельно между ревизиями. Рендер React и события анимаций идут в
// реальном времени, поэтому после шага скрипт ждёт реальные ~30 мс.
const FRAME_TOOLS = () => {
  const tools = window.__frameTools = { t: 0, seen: new Map(), target: null }
  // Касание одним пальцем по одному событию, без таймеров страницы — они стоят вместе с часами. click — клик следом,
  // как после короткого касания на телефоне (синтетические касания его не порождают).
  tools.touch = (type, x, y, click = false) => {
    if (type === 'touchstart') tools.target = document.elementFromPoint(x, y)
    const target = tools.target
    const point = typeof document.createTouch === 'function' ? document.createTouch(window, target, 1, x, y, x, y, x, y) : new Touch({ identifier: 1, target, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y })
    const list = (items) => typeof document.createTouchList === 'function' ? document.createTouchList(...items) : items
    const touches = type === 'touchend' || type === 'touchcancel' ? [] : [point]
    target.dispatchEvent(new TouchEvent(type, { touches: list(touches), targetTouches: list(touches), changedTouches: list([point]), bubbles: true, cancelable: true, composed: true }))
    if (click) target.closest('button, [role="button"]')?.click()
  }
  // Анимация, замеченная впервые, начинается с текущего шага, дальше её время — время шагов.
  tools.seek = () => {
    for (const animation of document.getAnimations()) {
      if (!tools.seen.has(animation)) { tools.seen.set(animation, tools.t); animation.pause() }
      animation.currentTime = tools.t - tools.seen.get(animation)
    }
  }
}

// Функция состояния для страницы: sample(arg) без замыканий, результат — простой объект.
const sampleExpression = (sample, arg) => `(${sample.toString()})(${JSON.stringify(arg ?? null)})`

export async function realtimeFrames(page, { ms = 500, sample, arg, action }) {
  await page.evaluate(`(() => {
    const record = window.__realtime = { samples: [], t0: performance.now() }
    record.done = new Promise((resolve) => {
      const tick = (now) => {
        record.samples.push({ t: Math.round(now - record.t0), ...${sampleExpression(sample, arg)} })
        if (now - record.t0 < ${ms}) requestAnimationFrame(tick)
        else resolve()
      }
      requestAnimationFrame(tick)
    })
  })()`)
  await action()
  await page.evaluate(() => window.__realtime.done)
  return page.evaluate(() => window.__realtime.samples)
}

// Часы ставятся до загрузки страницы и идут как настоящие, пока их не остановят.
export async function installClock(page) { await page.clock.install() }

export async function freeze(page) {
  await page.evaluate(FRAME_TOOLS)
  const now = await page.evaluate(() => Date.now())
  await page.clock.pauseAt(now + 50)
}

export async function unfreeze(page) {
  await page.evaluate(() => { for (const animation of document.getAnimations()) animation.play() })
  await page.clock.resume()
}

// events: { t, type: 'touchstart' | 'touchmove' | 'touchend', x, y, click? } или { t, run: async () => … } — действие скрипта.
// shot(index) — путь снимка кадра или null; clip — область снимка.
export async function frozenFrames(page, { frames = 32, events = [], sample, arg, shot = () => null, clip }) {
  await page.evaluate(() => { window.__frameTools.t = 0; window.__frameTools.seen = new Map() })
  const result = []
  for (let index = 0; index < frames; index++) {
    const t = index * 16
    if (index > 0) await page.clock.runFor(16)
    await page.evaluate((t) => { window.__frameTools.t = t }, t)
    for (const event of events.filter((item) => item.t === t)) {
      if (event.run) await event.run()
      else await page.evaluate((event) => window.__frameTools.touch(event.type, event.x, event.y, event.click), event)
    }
    await sleep(30)
    const state = await page.evaluate(`(window.__frameTools.seek(), ${sampleExpression(sample, arg)})`)
    const path = shot(index)
    if (path) await page.screenshot({ path, ...(clip ? { clip } : {}) })
    result.push({ i: index, t, ...state, ...(path ? { png: path.split('/').pop() } : {}) })
  }
  return result
}

// Первая прокрутка «Истории»: свежая загрузка, вкладка открыта впервые, и список сразу листают вниз ровно, как пальцем,
// через несколько порций строк. Пишет ленту кадров с числом строк, коммиты React, где кадр потерял время и не видна ли
// на экране пустота под нарисованными строками (порция не успела за лентой).
//   node client/e2e/perf/history-scroll.mjs <webkit|chromium> [--port=4411] [--throttle=1] [--label=имя]
//     [--speed=7000]      px/с, с которой лента уходит вверх (флик на iPhone — 5–10 тысяч)
//     [--distance=24000]  сколько пролистать, px: при порциях по 200 строк — две их границы, по 30 — десяток
//     [--wait=800]        сколько «История» стоит открытой до прокрутки, мс
//     [--hold=40]         палец касается строки и стоит столько мс, потом тянет ленту 300 px и отпускает — дальше она
//                         едет сама; от 100 мс строка успевает зажечь плашку нажатия; -1 — без касания
//     [--trace]           (Chromium) разбор долгих задач по трассе: скрипт, стили, раскладка, отрисовка
//     [--breakdown]       (оба) задачи планировщика React и принудительная раскладка по часам страницы — с накладными
//     [--fixslot]         как у measure.mjs
// Лента двигается от часов кадра, как у прокрутки вне главного потока: опоздавший кадр прыгает дальше, а не тормозит
// ленту. Самый долгий кадр — сколько главный поток не отдавал кадр; на iPhone 13 умножайте время Mac примерно на 1,7.
// Результат — .results/<label>-scroll-<kind>-x<throttle>.json и сводка в консоли.
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_PORT, RESULTS, launch, openApp, parseArgs, resetAccount, sleep } from './common.mjs'

const { positional: [kind = 'webkit'], flags } = parseArgs(process.argv.slice(2))
const port = Number(flags.port ?? DEFAULT_PORT)
const throttle = Number(flags.throttle ?? 1)
const label = flags.label ?? `port${port}`
const speed = Number(flags.speed ?? 7000)
const distance = Number(flags.distance ?? 24000)
const openWait = Number(flags.wait ?? 800)
const hold = Number(flags.hold ?? 40)
const tracing = Boolean(flags.trace) && kind === 'chromium'
const breakdown = Boolean(flags.breakdown)
const settle = (ms) => sleep(ms * Math.max(1, throttle * 0.6))

const { browser, context, page } = await launch(kind, { throttle })
page.on('pageerror', (error) => console.log('pageerror', error.message))

// Часы задач планировщика React (MessageChannel) и принудительной раскладки (первое чтение offsetHeight после правок).
if (breakdown) await context.addInitScript(() => {
  const log = window.__tasks = []
  const Native = window.MessageChannel
  window.MessageChannel = class extends Native {
    constructor() {
      super()
      const port = this.port1
      let handler = null
      Object.defineProperty(port, 'onmessage', {
        get: () => handler,
        set: (fn) => { handler = fn; Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage').set.call(port, fn && ((event) => {
          const start = performance.now()
          window.__layout = 0
          try { fn(event) } finally { log.push({ start, end: performance.now(), layout: window.__layout }) }
        })) },
      })
    }
  }
  const offset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { const t = performance.now(); const value = offset.get.call(this); window.__layout = (window.__layout ?? 0) + performance.now() - t; return value } })
})

await openApp(page, port)
await resetAccount(page)
await page.reload()
await page.waitForSelector('.entry-view .keypad', { timeout: 60_000 })
if (flags.fixslot) await page.addStyleTag({ content: '.page-slot{position:relative}' })
await settle(1500)

await page.tap('.bottom-nav button:has-text("История")')
await settle(openWait)
if (tracing) await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink', 'v8.execute'] })

const run = await page.evaluate(async ({ speed, distance, hold }) => {
  const slot = document.querySelectorAll('.page-slot')[1]
  const rows = () => slot.getElementsByClassName('history-expense').length
  const frames = []
  const start = slot.scrollTop
  // Палец — touch-события по строке под ним, как в swipe.mjs: в WebKit без экрана нет конструктора Touch.
  const finger = hold >= 0 ? { x: 195, y: 420, target: document.elementFromPoint(195, 420), down: true } : null
  const touch = (y) => typeof document.createTouch === 'function' ? document.createTouch(window, finger.target, 7, finger.x, y, finger.x, y, finger.x, y) : new Touch({ identifier: 7, target: finger.target, clientX: finger.x, clientY: y, pageX: finger.x, pageY: y, screenX: finger.x, screenY: y })
  const list = (items) => typeof document.createTouchList === 'function' ? document.createTouchList(...items) : items
  const fire = (type, y) => { const point = touch(y); const now = type === 'touchend' ? [] : [point]; finger.target.dispatchEvent(new TouchEvent(type, { touches: list(now), targetTouches: list(now), changedTouches: list([point]), bubbles: true, cancelable: true, composed: true })) }
  // Время кадра — часы страницы в момент вызова: метка кадра Chromium ставится, когда кадр заказан, и прячет задачу,
  // которая его задержала.
  const t0 = await new Promise((done) => requestAnimationFrame(() => done(performance.now())))
  if (finger) fire('touchstart', finger.y)
  const moveAt = t0 + Math.max(0, hold)
  await new Promise((done) => {
    const tick = () => {
      const now = performance.now()
      // Пустота на экране: сколько пикселей отступа под нарисованными строками видно — порция не успела.
      const rest = slot.querySelector('.history-rest')
      const blank = rest ? Math.max(0, Math.round(slot.getBoundingClientRect().bottom - rest.getBoundingClientRect().top)) : 0
      frames.push({ at: now, top: Math.round(slot.scrollTop), rows: rows(), height: slot.scrollHeight, blank })
      if (now < moveAt) { requestAnimationFrame(tick); return }
      const target = start + (now - moveAt) / 1000 * speed
      if (target - start >= distance || slot.scrollTop + slot.clientHeight >= slot.scrollHeight - 1) { if (finger?.down) fire('touchend', finger.y); done(); return }
      // Палец ведёт ленту первые 300 px, дальше её несёт инерция.
      if (finger?.down) {
        const y = finger.y - (target - start)
        if (target - start < 300) fire('touchmove', y)
        else { fire('touchend', y); finger.down = false }
      }
      slot.scrollTop = target
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await new Promise((done) => setTimeout(done, 400))
  const end = performance.now()
  const commits = window.__perf.commits.filter((commit) => commit.at >= t0 && commit.at <= end).map((commit) => commit.at)
  const tasks = (window.__tasks ?? []).filter((task) => task.start >= t0 && task.start <= end)
  return { t0, end, frames, commits, tasks, finalRows: rows(), scrollHeight: slot.scrollHeight, finger: finger ? finger.target.closest('.history-expense') !== null : null }
}, { speed, distance, hold })

let trace = null
if (tracing) trace = summarizeTrace(JSON.parse((await browser.stopTracing()).toString('utf8')), run)

const deltas = run.frames.slice(1).map((frame, index) => ({ ...frame, delta: frame.at - run.frames[index].at, before: run.frames[index] }))
const long = deltas.filter((item) => item.delta > 20).map((item) => {
  const inside = (at) => at > item.before.at && at <= item.at
  return {
    at: Math.round(item.before.at - run.t0), ms: Math.round(item.delta), top: item.before.top, rows: `${item.before.rows}→${item.rows}`,
    commits: run.commits.filter(inside).length,
    tasks: run.tasks.filter((task) => inside(task.start)).map((task) => `${Math.round(task.end - task.start)}${task.layout > 1 ? `(раскл. ${Math.round(task.layout)})` : ''}`).join('+') || undefined,
  }
})
const summary = {
  frames: run.frames.length,
  maxFrame: Math.round(Math.max(0, ...deltas.map((item) => item.delta))),
  over20: deltas.filter((item) => item.delta > 20).length,
  over33: deltas.filter((item) => item.delta > 33).length,
  jankMs: Math.round(deltas.filter((item) => item.delta > 20).reduce((sum, item) => sum + item.delta - 16.7, 0)),
  scrolled: run.frames.at(-1).top - run.frames[0].top,
  rows: `${run.frames[0].rows}→${run.finalRows}`,
  commits: run.commits.length,
  blankFrames: run.frames.filter((frame) => frame.blank > 0).length,
  blankMaxPx: Math.max(0, ...run.frames.map((frame) => frame.blank)),
  scrollHeight: run.scrollHeight,
  fingerOnRow: run.finger,
}
console.log(`${kind} ${label} ×${throttle}: ${speed} px/с, ${summary.scrolled} px — max ${summary.maxFrame} ms, >20 ms ${summary.over20}, >33 ms ${summary.over33}, застывание ${summary.jankMs} ms, строк ${summary.rows}, коммитов ${summary.commits}, пустота на экране ${summary.blankFrames ? `${summary.blankFrames} кадров, до ${summary.blankMaxPx} px` : '0'}`)
for (const item of long) console.log(`  +${item.at} ms  кадр ${item.ms} ms  top ${item.top}  строк ${item.rows}  коммитов ${item.commits}${item.tasks ? `  задачи React ${item.tasks}` : ''}`)
// Все заметные задачи React: у порции — рендер и коммит с раскладкой, следом — задача эффектов (слушатели строк).
const heavy = run.tasks.filter((task) => task.end - task.start > 2).map((task) => ({ at: Math.round(task.start - run.t0), ms: Math.round(task.end - task.start), layout: Math.round(task.layout) }))
if (breakdown) console.log(`  задачи React > 2 мс: ${heavy.map((task) => `+${task.at} ${task.ms}${task.layout ? `(раскл. ${task.layout})` : ''}`).join(', ') || '—'}`)
if (trace) for (const task of trace) console.log(`  трасса +${task.at} ms  ${task.ms} ms: ${Object.entries(task.parts).map(([key, value]) => `${key} ${value}`).join(', ')}`)

writeFileSync(resolve(RESULTS, `${label}-scroll-${kind}-x${throttle}.json`), JSON.stringify({ kind, label, throttle, speed, distance, openWait, hold, ...summary, long, trace, ...(breakdown ? { heavy } : {}) }, null, 2))
await browser.close()

// Долгие задачи главного потока из трассы Chromium: из чего они состоят (время вложенных событий без двойного счёта).
function summarizeTrace(data, run) {
  const events = data.traceEvents ?? data
  const main = events.find((event) => event.name === 'thread_name' && event.args?.name === 'CrRendererMain' && events.some((other) => other.pid === event.pid && other.name === 'RunTask' && other.dur > 5000))
  if (!main) return []
  const own = events.filter((event) => event.pid === main.pid && event.tid === main.tid && event.ph === 'X' && typeof event.dur === 'number')
  // Часы трассы → часы страницы: кадр страницы нашей прокрутки ставим по событию FireAnimationFrame.
  const fired = own.filter((event) => event.name === 'FireAnimationFrame').map((event) => event.ts)
  const shift = fired.length ? fired[0] / 1000 - run.frames[0].at : 0
  const kinds = [
    ['стили', /^(UpdateLayoutTree|RecalculateStyles|ScheduleStyleRecalculation)$/],
    ['раскладка', /^(Layout|UpdateLayout)$/],
    ['отрисовка', /^(Paint|PrePaint|Layerize|UpdateLayer|CompositeLayers|Commit|PaintImage|RasterTask)$/],
    ['наблюдатели', /IntersectionObserver|ResizeObserver/],
    ['скрипт', /^(FunctionCall|EvaluateScript|TimerFire|FireAnimationFrame|EventDispatch|v8\.callFunction|v8\.run|MessagePort|HandlePostMessage)$/],
  ]
  const kindOf = (name) => kinds.find(([, pattern]) => pattern.test(name))?.[0]
  const tasks = own.filter((event) => event.name === 'RunTask' && event.dur > 16_000)
  return tasks.map((task) => {
    const end = task.ts + task.dur
    const inner = own.filter((event) => event !== task && event.ts >= task.ts && event.ts + event.dur <= end && kindOf(event.name))
    // Собственное время каждого события без вложенных: принудительная раскладка внутри скрипта идёт в раскладку.
    const parts = {}
    for (const event of inner) {
      const kind = kindOf(event.name)
      const children = inner.filter((other) => other !== event && other.ts >= event.ts && other.ts + other.dur <= event.ts + event.dur)
      const top = children.filter((child) => !children.some((parent) => parent !== child && parent.ts <= child.ts && parent.ts + parent.dur >= child.ts + child.dur))
      const self = event.dur - top.reduce((sum, child) => sum + child.dur, 0)
      parts[kind] = (parts[kind] ?? 0) + Math.max(0, self)
    }
    const named = Object.fromEntries(Object.entries(parts).map(([key, value]) => [key, Math.round(value / 1000)]).filter(([, value]) => value > 0))
    const accounted = Object.values(parts).reduce((sum, value) => sum + value, 0)
    named['прочее'] = Math.round((task.dur - accounted) / 1000)
    return { at: Math.round(task.ts / 1000 - shift - run.t0), ms: Math.round(task.dur / 1000), parts: named }
  }).filter((task) => task.at > -50)
}

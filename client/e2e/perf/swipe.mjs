// Четыре свайпа карточки «Расхода» к старым тратам, когда «История» и «Аналитика» уже открыты: кадры и застывание.
//   node client/e2e/perf/swipe.mjs <webkit|chromium> [--port=4411] [--throttle=1] [--label=имя] [--allblocks]
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_PORT, RESULTS, launch, openApp, parseArgs, resetAccount, sleep } from './common.mjs'

const { positional: [kind = 'webkit'], flags } = parseArgs(process.argv.slice(2))
const port = Number(flags.port ?? DEFAULT_PORT)
const throttle = Number(flags.throttle ?? 1)
const label = flags.label ?? `port${port}`
const { browser, page } = await launch(kind, { throttle })
await openApp(page, port)
await resetAccount(page, { allBlocks: Boolean(flags.allblocks) })
await page.reload()
await page.waitForSelector('.entry-view .keypad', { timeout: 60_000 })
for (const tab of ['История', 'Аналитика', 'Расход']) { await page.tap(`.bottom-nav button:has-text("${tab}")`); await sleep(1500) }

const t0 = await page.evaluate(() => performance.now())
for (let swipe = 0; swipe < 4; swipe++) {
  // В WebKit без экрана нет конструктора Touch: касания собираются через document.createTouch.
  await page.evaluate(async () => {
    const target = document.querySelector('.swipe-area')
    const wait = (ms) => new Promise((done) => setTimeout(done, ms))
    const touch = (x, y) => typeof document.createTouch === 'function' ? document.createTouch(window, target, 1, x, y, x, y, x, y) : new Touch({ identifier: 1, target, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y })
    const list = (items) => typeof document.createTouchList === 'function' ? document.createTouchList(...items) : items
    const fire = (type, touches, changed) => target.dispatchEvent(new TouchEvent(type, { touches: list(touches), targetTouches: list(touches), changedTouches: list(changed), bubbles: true, cancelable: true, composed: true }))
    const start = touch(80, 200); fire('touchstart', [start], [start])
    for (let step = 1; step <= 10; step++) { const moved = touch(80 + step * 22, 202); fire('touchmove', [moved], [moved]); await wait(16) }
    const end = touch(300, 202); fire('touchend', [], [end])
  })
  await sleep(700)
}
const stats = await page.evaluate((t0) => {
  const frames = window.__perf.frames.filter((at) => at >= t0)
  const deltas = frames.slice(1).map((at, index) => at - frames[index])
  return {
    frames: frames.length,
    maxFrame: Math.round(Math.max(...deltas)),
    over50: deltas.filter((delta) => delta > 50).length,
    jankMs: Math.round(deltas.filter((delta) => delta > 20).reduce((sum, delta) => sum + delta - 16.7, 0)),
    card: document.querySelector('.entry-card:not(.aside) .eyebrow')?.textContent,
  }
}, t0)
console.log(`${kind} ${label} ×${throttle}: четыре свайпа — max ${stats.maxFrame} ms, >50ms ${stats.over50}, застывание ${stats.jankMs} ms (${stats.card})`)
writeFileSync(resolve(RESULTS, `${label}-swipe-${kind}-x${throttle}.json`), JSON.stringify({ kind, label, throttle, ...stats }, null, 2))
await browser.close()

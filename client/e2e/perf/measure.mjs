// Сценарии замера на поднятом стенде: кадры, коммиты React, время главного потока (Chromium).
//   node client/e2e/perf/measure.mjs <webkit|chromium> [--port=4411] [--throttle=1] [--label=имя]
//     [--count]     посчитать отрисованные компоненты в каждом коммите (добавляет накладные расходы — не для мс)
//     [--profile]   профиль CPU на каждый сценарий (Chromium): самые тяжёлые функции
//     [--allblocks] включить все новые блоки экранов перед замером
//     [--fixslot]   для ревизий до исправления: подпись в «Настройках» раздвигала страницу, мобильный Chromium мельчил вид
// Результат — .results/<label>-<kind>-x<throttle>[-count][-allblocks].json и сводка в консоли.
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_PORT, RESULTS, launch, openApp, parseArgs, resetAccount, sleep } from './common.mjs'

const { positional: [kind = 'webkit'], flags } = parseArgs(process.argv.slice(2))
const port = Number(flags.port ?? DEFAULT_PORT)
const throttle = Number(flags.throttle ?? 1)
const label = flags.label ?? `port${port}`
const counting = Boolean(flags.count)
const profiling = Boolean(flags.profile) && kind === 'chromium'
const allBlocks = Boolean(flags.allblocks)
const settle = (ms) => sleep(ms * Math.max(1, throttle * 0.6))

const { browser, page, cdp } = await launch(kind, { throttle })
page.on('pageerror', (error) => console.log('pageerror', error.message))

const metrics = async () => {
  if (!cdp) return null
  const { metrics: list } = await cdp.send('Performance.getMetrics')
  return Object.fromEntries(list.map((item) => [item.name, item.value]))
}
const now = () => page.evaluate(() => performance.now())

// Самовес и полный вес по имени функции из профиля CPU.
function hottest(profile) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]))
  const parent = new Map()
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)
  const samples = new Map()
  for (const id of profile.samples) samples.set(id, (samples.get(id) ?? 0) + 1)
  const interval = (profile.endTime - profile.startTime) / 1000 / Math.max(1, profile.samples.length)
  const label = (node) => { const frame = node.callFrame; const file = frame.url ? frame.url.split('/').pop().replace(/-[\w]{8}\.js$/, '') : ''; return `${frame.functionName || '(anon)'}${file && !file.startsWith('index') ? `@${file}` : ''}` }
  const self = new Map(), total = new Map()
  for (const [id, count] of samples) {
    const node = byId.get(id)
    const name = label(node)
    self.set(name, (self.get(name) ?? 0) + count * interval)
    if (['(idle)', '(program)', '(garbage collector)'].includes(node.callFrame.functionName)) continue
    const seen = new Set()
    for (let current = id; current !== undefined; current = parent.get(current)) {
      const item = byId.get(current); const itemName = label(item)
      if (seen.has(itemName) || item.callFrame.functionName === '(root)') continue
      seen.add(itemName); total.set(itemName, (total.get(itemName) ?? 0) + count * interval)
    }
  }
  const top = (map, size) => [...map].filter(([name]) => name !== '(idle)').sort((a, b) => b[1] - a[1]).slice(0, size).map(([name, ms]) => [name, Math.round(ms)])
  return { self: top(self, 14), total: top(total, 22) }
}

const results = []
async function scenario(name, action, { wait = 1200 } = {}) {
  if (profiling) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start') }
  const before = await metrics()
  const t0 = await now()
  await action()
  await settle(wait)
  const t1 = await now()
  const after = await metrics()
  const profile = profiling ? (await cdp.send('Profiler.stop')).profile : null
  const data = await page.evaluate(({ t0, t1 }) => {
    const perf = window.__perf
    const frames = perf.frames.filter((at) => at >= t0 && at <= t1)
    const deltas = frames.slice(1).map((at, index) => at - frames[index])
    const commits = perf.commits.filter((commit) => commit.at >= t0 && commit.at <= t1)
    const renders = {}, mounts = {}
    for (const commit of commits) {
      for (const [key, value] of Object.entries(commit.counts ?? {})) renders[key] = (renders[key] ?? 0) + value
      for (const [key, value] of Object.entries(commit.mounts ?? {})) mounts[key] = (mounts[key] ?? 0) + value
    }
    return {
      frames: frames.length,
      maxFrame: Math.round(Math.max(0, ...deltas)),
      over50: deltas.filter((delta) => delta > 50).length,
      jankMs: Math.round(deltas.filter((delta) => delta > 20).reduce((sum, delta) => sum + delta - 16.7, 0)),
      worst: [...deltas].sort((a, b) => b - a).slice(0, 3).map(Math.round),
      commits: commits.length, renders, mounts,
      nodes: document.getElementsByTagName('*').length,
      documentWidth: document.documentElement.scrollWidth,
    }
  }, { t0, t1 })
  const cpu = before && after ? {
    task: Math.round((after.TaskDuration - before.TaskDuration) * 1000),
    script: Math.round((after.ScriptDuration - before.ScriptDuration) * 1000),
    style: Math.round((after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000),
    layout: Math.round((after.LayoutDuration - before.LayoutDuration) * 1000),
  } : null
  const entry = { name, ...data, cpu, windowMs: Math.round(t1 - t0), ...(profile ? { hot: hottest(profile) } : {}) }
  results.push(entry)
  console.log(`\n# ${name}\n  max ${data.maxFrame} ms · >50ms ${data.over50} · застывание ${data.jankMs} ms · худшие ${data.worst.join('/')} · коммитов ${data.commits} · DOM ${data.nodes}`)
  if (cpu) console.log(`  главный поток: ${cpu.task} ms (скрипт ${cpu.script}, стили ${cpu.style}, раскладка ${cpu.layout})`)
  if (counting) console.log(`  рендеры: ${Object.entries(data.renders).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([key, value]) => `${key}×${value}`).join(' ') || '—'}`)
  if (entry.hot) console.log(`  тяжелее всего (сам): ${entry.hot.self.map(([key, value]) => `${key} ${value}`).join(', ')}`)
  return entry
}

const tapNav = (tab) => page.tap(`.bottom-nav button:has-text("${tab}")`)

await openApp(page, port)
await resetAccount(page, { allBlocks })
await page.reload()
await page.waitForSelector('.entry-view .keypad', { timeout: 60_000 })
if (flags.fixslot) await page.addStyleTag({ content: '.page-slot{position:relative}' })
await page.evaluate((counting) => { window.__perf.counting = counting }, counting)
await settle(1500)
console.log(`${kind} ${label} ×${throttle}${allBlocks ? ' все блоки' : ''}`)

await scenario('1. Tab «История», first visit (mount)', () => tapNav('История'), { wait: 1500 })
await scenario('2. Scroll «История» 2500px', async () => {
  if (cdp) await cdp.send('Input.synthesizeScrollGesture', { x: 195, y: 420, yDistance: -2500, speed: 2500, gestureSourceType: 'touch' })
  else await page.evaluate(() => new Promise((done) => { const slot = document.querySelectorAll('.page-slot')[1]; let step = 0; const tick = () => { slot.scrollTop += 42; if (++step < 60) requestAnimationFrame(tick); else done() }; requestAnimationFrame(tick) }))
}, { wait: 800 })
await page.evaluate(() => { document.querySelectorAll('.page-slot')[1].scrollTop = 0 })
await settle(300)
await scenario('3. Tab «Аналитика», first visit (mount + charts)', () => tapNav('Аналитика'), { wait: 1800 })
await scenario('4. Tab «Настройки», first visit', () => tapNav('Настройки'), { wait: 1200 })
await scenario('5. Tab «Расход» (all four mounted)', () => tapNav('Расход'), { wait: 1200 })
await scenario('6. Tab «История» again', () => tapNav('История'), { wait: 1200 })
await scenario('7. Tab «Расход» again', () => tapNav('Расход'), { wait: 1200 })
await scenario('8. Keypad: three digits', async () => { for (const digit of ['1', '2', '5']) await page.tap(`.keypad button[aria-label="${digit}"]`) }, { wait: 600 })
await page.tap('.main-categories button >> nth=0')
await settle(400)
await scenario('9. Save expense (optimistic + server answer)', () => page.tap('.entry-save .primary'), { wait: 2500 })
await scenario('10. Open currency sheet', () => page.tap('.entry-card:not(.aside) .amount-row button'), { wait: 900 })
await scenario('11. Close sheet', () => page.tap('.bottom-sheet .icon-button'), { wait: 900 })
await tapNav('История'); await settle(1200)
await scenario('12. History filter: pick one category', async () => {
  await page.tap('button[aria-label="Категория истории"]')
  await settle(500)
  await page.tap('.select-option >> nth=1')
  await settle(300)
  await page.tap('.sheet-done')
}, { wait: 1500 })
await scenario('13. History filter: reset', () => page.tap('.history-reset'), { wait: 1500 })
if (cdp) await scenario('14. Swipe pager История → Аналитика (touch)', () => cdp.send('Input.synthesizeScrollGesture', { x: 300, y: 150, xDistance: -260, yDistance: 0, speed: 1200, gestureSourceType: 'touch' }), { wait: 1500 })
else await tapNav('Аналитика')
await settle(600)
await scenario('15. Analytics: week → month', () => page.tap('.analytics-period button:has-text("Месяц")'), { wait: 1500 })
await scenario('16. Analytics: previous month', () => page.tap('.week-navigator button[aria-label="Предыдущий месяц"]'), { wait: 1500 })
await scenario('17. Idle 3s on Analytics', async () => {}, { wait: 3000 })

// Сколько стоит в этом движке переключить inert на «Истории» (стили + раскладка), и сколько там строк.
const engine = await page.evaluate(() => {
  const history = document.querySelectorAll('.page-slot')[1]
  const probe = history.querySelector('.history-row') ?? history
  const force = () => { void getComputedStyle(probe).pointerEvents; void document.body.offsetWidth }
  const runs = []
  for (let index = 0; index < 6; index++) {
    const t = performance.now()
    if (history.hasAttribute('inert')) history.removeAttribute('inert'); else history.setAttribute('inert', '')
    force()
    runs.push(performance.now() - t)
  }
  runs.shift()
  history.setAttribute('inert', '')
  return { inertFlipMs: Math.round(runs.reduce((a, b) => a + b, 0) / runs.length * 10) / 10, historyRows: history.querySelectorAll('.history-expense').length, historyNodes: history.getElementsByTagName('*').length }
})
console.log('\ninert на «Истории»:', engine)

const file = resolve(RESULTS, `${label}-${kind}-x${throttle}${counting ? '-count' : ''}${allBlocks ? '-allblocks' : ''}.json`)
writeFileSync(file, JSON.stringify({ kind, label, throttle, counting, allBlocks, results, engine }, null, 2))
console.log(`→ ${file}`)
await browser.close()

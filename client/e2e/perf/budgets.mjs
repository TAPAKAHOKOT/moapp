// Проверка бюджетов из budgets.json по результатам одной метки и сравнение двух меток.
//   node client/e2e/perf/budgets.mjs <label>             — нужны <label>-webkit-x1, -chromium-x1-count, -chromium-x4, -swipe-webkit-x1
//   node client/e2e/perf/budgets.mjs <before> <after>    — сравнение WebKit по сценариям (кадр и застывание)
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { HERE, RESULTS } from './common.mjs'

const [first, second] = process.argv.slice(2)
const read = (name) => { const file = resolve(RESULTS, `${name}.json`); return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null }
const sum = (renders, pattern) => Object.entries(renders ?? {}).filter(([name]) => pattern.test(name)).reduce((total, [, count]) => total + count, 0)
const find = (result, prefix) => result?.results.find((item) => item.name.startsWith(prefix))

if (second) {
  const before = read(`${first}-webkit-x1`), after = read(`${second}-webkit-x1`)
  if (!before || !after) throw new Error('нет результатов WebKit для одной из меток')
  console.log(`сценарий`.padEnd(52), `кадр ${first} → ${second}`.padEnd(26), 'застывание')
  for (const item of before.results) {
    const other = after.results.find((candidate) => candidate.name === item.name)
    if (!other) continue
    console.log(item.name.slice(0, 50).padEnd(52), `${item.maxFrame} → ${other.maxFrame} ms`.padEnd(26), `${item.jankMs} → ${other.jankMs} ms`)
  }
  process.exit(0)
}

const budgets = JSON.parse(readFileSync(resolve(HERE, 'budgets.json'), 'utf8'))
const webkit = read(`${first}-webkit-x1`), counts = read(`${first}-chromium-x1-count`), weak = read(`${first}-chromium-x4`), swipe = read(`${first}-swipe-webkit-x1`)
const checks = []
const check = (title, value, limit, ok = value <= limit) => checks.push({ title, value, limit, ok })

if (webkit) {
  const worst = webkit.results.filter((item) => !item.name.startsWith('2.')).reduce((max, item) => item.maxFrame > max.maxFrame ? item : max)
  check(`WebKit: самый долгий кадр (${worst.name})`, worst.maxFrame, budgets.webkitWorstFrameMs)
  const opened = find(webkit, '1.')
  check('WebKit: элементов после открытия «Истории»', opened.nodes, budgets.historyNodesAfterOpen)
  const widest = Math.max(...webkit.results.map((item) => item.documentWidth ?? 0))
  check('Ширина документа, px', widest, budgets.documentWidthPx)
} else checks.push({ title: `нет ${first}-webkit-x1`, ok: false })
if (swipe) check('WebKit: четыре свайпа карточки, застывание', swipe.jankMs, budgets.swipeStallMs)
else checks.push({ title: `нет ${first}-swipe-webkit-x1`, ok: false })
if (counts) {
  const tab = find(counts, '6.')
  check('Переключение вкладки: коммитов', tab.commits, budgets.tabSwitch.commits)
  check('Переключение вкладки: рендеров App', sum(tab.renders, /^App\d*$/), budgets.tabSwitch.appRenders)
  check('Переключение вкладки: обновлений графиков', sum(tab.renders, /^AnalyticsChart/), budgets.tabSwitch.chartRenders)
  check('Переключение вкладки: рендеров скрытых «Аналитики» и «Настроек»', sum(tab.renders, /^(AnalyticsView|SettingsView)/), budgets.tabSwitch.hiddenScreenRenders)
  const save = find(counts, '9.')
  check('Сохранение: перерисованных строк «Истории»', sum(save.renders, /^HistoryRow\d*$/), budgets.save.historyRowRenders)
  check('Сохранение: обновлений графиков', sum(save.renders, /^AnalyticsChart/), budgets.save.chartRenders)
  const filter = find(counts, '12.')
  check('Фильтр «Истории»: обновлений графиков', sum(filter.renders, /^AnalyticsChart/), budgets.filter.chartRenders)
} else checks.push({ title: `нет ${first}-chromium-x1-count`, ok: false })
if (weak) check('Chromium ×4: скрипт при сохранении, ms', find(weak, '9.').cpu.script, budgets.chromiumX4SaveScriptMs)
else checks.push({ title: `нет ${first}-chromium-x4`, ok: false })

for (const item of checks) console.log(`${item.ok ? 'ok  ' : 'FAIL'} ${item.title}${item.value !== undefined ? `: ${item.value} (бюджет ${item.limit})` : ''}`)
process.exit(checks.every((item) => item.ok) ? 0 : 1)

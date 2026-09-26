// Покадрово: карточка над «Историей» исчезает и появляется. У профиля стенда нет сохранённой ссылки доступа, поэтому
// «Сохраните ссылку доступа» видна, пока есть связь: context.setOffline(true) прячет её, setOffline(false) возвращает
// (App слушает online/offline). С --inbox=N ответ очереди карт подменяется, и над списком стоит ещё
// «N операций с карты ждут разбора» — без связи она уходит вместе с первой.
// С --select вместо связи — выбор записей: долгое касание второй строки включает выбор (карточки сворачиваются, вместо
// фильтров и поиска на панели встаёт «Выбрано 1 · Удалить · Отмена»), «Отмена» выключает. --blocks=<id,id> оставляет над
// списком только эти блоки «Истории» (filters, total; --blocks= — ни одного, и панель есть только в выборе); в конце
// аккаунт сбрасывается.
//   node client/e2e/cards.mjs [метка] [ссылка входа] [--inbox=N] [--select] [--blocks=…]   адрес — MOAPP_BASE, вход — client/e2e/.state/
// Две фазы (hide, show или select, cancel): кадры requestAnimationFrame (~16 мс) в течение ~500 мс от переключения (у
// select — от касания: выбор включается через 450 мс); затем то же ещё раз с четырьмя снимками верха экрана по ходу
// (снимок останавливает кадры страницы на ~90 мс). В кадре: rowTop и listTop — верх первой строки и списка, toolbar —
// видимая высота панели фильтров (её обёртки, если есть), selecting — идёт ли выбор, above — блоки между панелью и
// списком (класс:высота@прозрачность — карточки или их обёртки), reminder и inbox — сами карточки.
// Сводка: на сколько и за сколько кадров сдвинулся список, самый большой шаг и шаги против движения, то же для высоты
// панели. На ccb30ae карточки едут ~200 мс, а панель прыгает за один кадр. Время кадров плавает на кадр между
// прогонами; сдвиг и число кадров повторяются.
// Результат — .shots/cards-<метка>/cards.json и PNG.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { BASE, launch, openApp, goTab, acceptDeviceLink, guard, patchSettings, pinLocalState, resetAccount, realtimeFrames, snapshotsDuring, touchDrag, SHOTS, sleep } from './common.mjs'

guard(120_000, 'cards.mjs')
const args = process.argv.slice(2)
const link = args.find((arg) => arg.includes('#/device/'))
const label = args.find((arg) => !arg.includes('#/device/') && !arg.startsWith('--')) ?? 'now'
const inbox = Number(args.find((arg) => arg.startsWith('--inbox='))?.split('=')[1] ?? 0)
const select = args.includes('--select')
const blocksArg = args.find((arg) => arg.startsWith('--blocks='))
const blocks = blocksArg === undefined ? null : blocksArg.slice('--blocks='.length).split(',').filter(Boolean)
const dir = `${SHOTS}cards-${label}/`
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })

const CARDS_SAMPLE = () => {
  const page = document.querySelectorAll('.page-slot')[1].querySelector('.history-page')
  const list = page.querySelector('.history-list')
  const round = (value) => Math.round(value * 10) / 10
  const children = [...page.children]
  const above = children.slice(0, children.indexOf(list)).filter((node) => !node.matches('.history-toolbar, .history-toolbar-slot')).map((node) => {
    const opacity = Number(getComputedStyle(node).opacity)
    return `${[...node.classList].join('.')}:${round(node.getBoundingClientRect().height)}${opacity < 1 ? `@${round(opacity)}` : ''}`
  })
  const card = (selector) => {
    const node = page.querySelector(selector)
    if (!node) return null
    const box = node.getBoundingClientRect()
    return { h: round(box.height), top: round(box.top), opacity: round(Number(getComputedStyle(node).opacity)) }
  }
  const bar = page.querySelector('.history-toolbar-slot') ?? page.querySelector('.history-toolbar')
  return {
    rowTop: round(list.querySelector('.history-expense').getBoundingClientRect().top),
    listTop: round(list.getBoundingClientRect().top),
    toolbar: bar ? round(bar.getBoundingClientRect().height) : 0,
    selecting: list.classList.contains('selecting'),
    above: above.join(' | ') || '-',
    reminder: card('.history-reminder'),
    inbox: card('.history-inbox:not(.history-reminder)'),
  }
}

// Путь одной величины по кадрам: откуда и куда, когда началось и кончилось движение, сколько кадров оно заняло, самый
// большой шаг за кадр (у скачка он равен всему сдвигу) и сколько шагов было против общего направления (рывки назад).
function track(samples, key) {
  const values = samples.map((sample) => sample[key])
  const moving = values.map((value, index) => index && Math.abs(value - values[index - 1]) > 0.05 ? index : -1).filter((index) => index > 0)
  const delta = values.at(-1) - values[0]
  const steps = moving.map((index) => values[index] - values[index - 1])
  return {
    from: values[0],
    to: values.at(-1),
    delta: Math.round(delta * 10) / 10,
    startedAt: moving.length ? samples[moving[0]].t : null,
    settledAt: moving.length ? samples[moving.at(-1)].t : null,
    movingFrames: moving.length,
    maxStep: Math.round(Math.max(0, ...steps.map(Math.abs)) * 10) / 10,
    backSteps: steps.filter((step) => Math.sign(step) !== Math.sign(delta)).length,
  }
}

function summarize(samples) {
  const blocks = []
  for (const sample of samples) if (blocks.at(-1) !== sample.above) blocks.push(sample.above)
  const switched = samples.findIndex((sample) => sample.selecting !== samples[0].selecting)
  return {
    ...track(samples, 'rowTop'),
    switchedAt: switched > 0 ? samples[switched].t : null,
    toolbar: track(samples, 'toolbar'),
    above: blocks.length > 3 ? `${blocks[0]} → … (${blocks.length - 2}) → ${blocks.at(-1)}` : blocks.join(' → '),
  }
}

if (link) {
  const { browser, context, page, statePath } = await launch('webkit')
  await acceptDeviceLink(page, context, statePath, link)
  await browser.close()
}
await resetAccount()
if (blocks) {
  const { browser, page } = await launch('webkit')
  await page.goto(`${BASE}/api/health`)
  await patchSettings(page, { historyBlocks: { shown: blocks, hidden: ['filters', 'total'].filter((id) => !blocks.includes(id)) } })
  await browser.close()
}

const { browser, context, page } = await launch('webkit')
await pinLocalState(context)
page.on('pageerror', (error) => console.log('pageerror', error.message))
if (inbox) await page.route('**/integrations/card-queue', (route) => route.fulfill({ json: { pendingCount: inbox } }))
await openApp(page)
await goTab(page, 'История')
await sleep(800)
const initial = await page.evaluate(CARDS_SAMPLE)
if (!initial.reminder) throw new Error('нет карточки «Сохраните ссылку доступа»: у профиля сохранена ссылка или нет связи')
if (inbox && !initial.inbox) throw new Error('нет карточки очереди карт')
const clip = { x: 0, y: 0, width: page.viewportSize().width, height: Math.min(page.viewportSize().height, Math.round(initial.rowTop) + 140) }
const phases = {}
const shots = {}
const shotsAt = (name, after = 0) => [30, 130, 250, 420].map((at, index) => ({ at: after + at, clip, path: `${dir}${name}-${index}.png` }))
if (select) {
  // Вторая строка, как в regress.mjs: долгое касание без движения, палец держится 700 мс (выбор — на 450-й).
  const row = await page.evaluate(() => {
    const box = document.querySelectorAll('.page-slot')[1].querySelectorAll('.history-expense')[1].getBoundingClientRect()
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }
  })
  const hold = async () => { await sleep(16); await touchDrag(page, null, row, row, { steps: 1, holdMs: 700 }) }
  const cancel = async () => { await sleep(16); await page.locator('.page-slot').nth(1).locator('.history-selectbar .text-button').click() }
  phases.select = await realtimeFrames(page, { ms: 1000, sample: CARDS_SAMPLE, action: hold })
  await sleep(800)
  phases.cancel = await realtimeFrames(page, { ms: 500, sample: CARDS_SAMPLE, action: cancel })
  await sleep(800)
  shots.select = await snapshotsDuring(page, { action: hold, shots: shotsAt('select', 470) })
  await sleep(800)
  shots.cancel = await snapshotsDuring(page, { action: cancel, shots: shotsAt('cancel') })
} else {
  const toggle = (offline) => async () => { await sleep(16); await context.setOffline(offline) }
  phases.hide = await realtimeFrames(page, { ms: 500, sample: CARDS_SAMPLE, action: toggle(true) })
  await sleep(800)
  phases.show = await realtimeFrames(page, { ms: 500, sample: CARDS_SAMPLE, action: toggle(false) })
  await sleep(800)
  shots.hide = await snapshotsDuring(page, { action: toggle(true), shots: shotsAt('hide') })
  await sleep(800)
  shots.show = await snapshotsDuring(page, { action: toggle(false), shots: shotsAt('show') })
}
await browser.close()
if (blocks) await resetAccount()

const summary = Object.fromEntries(Object.entries(phases).map(([name, phase]) => [name, summarize(phase)]))
writeFileSync(`${dir}cards.json`, JSON.stringify({ label, inbox, select, blocks, summary, phases, shots }, null, 2))
for (const [name, value] of Object.entries(summary)) {
  const bar = value.toolbar
  console.log(`${name.padEnd(6)} первая строка ${value.from} → ${value.to} (${value.delta}) · движение ${value.startedAt ?? '—'}–${value.settledAt ?? '—'} мс, кадров ${value.movingFrames}, шаг до ${value.maxStep}, назад ${value.backSteps}${value.switchedAt !== null ? ` · выбор сменился на ${value.switchedAt} мс` : ''}`)
  console.log(`${''.padEnd(6)} панель ${bar.from} → ${bar.to} (${bar.delta}) · ${bar.startedAt ?? '—'}–${bar.settledAt ?? '—'} мс, кадров ${bar.movingFrames}, шаг до ${bar.maxStep}, назад ${bar.backSteps} · ${value.above}`)
}
console.log(`→ ${dir}`)

// Покадрово: карточка над «Историей» исчезает и появляется. У профиля стенда нет сохранённой ссылки доступа, поэтому
// «Сохраните ссылку доступа» видна, пока есть связь: context.setOffline(true) прячет её, setOffline(false) возвращает
// (App слушает online/offline). С --inbox=N ответ очереди карт подменяется, и над списком стоит ещё
// «N операций с карты ждут разбора» — без связи она уходит вместе с первой.
//   node client/e2e/cards.mjs [метка] [ссылка входа] [--inbox=N]      адрес — MOAPP_BASE, вход — client/e2e/.state/
// Две фазы (hide, show): кадры requestAnimationFrame (~16 мс) в течение ~500 мс от переключения связи и четыре снимка
// верха экрана по ходу. В кадре: rowTop и listTop — верх первой строки и списка, above — блоки между панелью фильтров и
// списком (класс:высота@прозрачность — карточки или их обёртки), reminder и inbox — сами карточки.
// Сводка: на сколько и за сколько кадров сдвинулся список. На текущей main — скачок за один кадр, после правок ожидается
// плавное изменение за ~200 мс. Время кадров плавает на кадр между прогонами; сдвиг и число кадров повторяются.
// Результат — .shots/cards-<метка>/cards.json и PNG.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { launch, openApp, goTab, acceptDeviceLink, guard, pinLocalState, resetAccount, realtimeFrames, SHOTS, sleep } from './common.mjs'

guard(120_000, 'cards.mjs')
const args = process.argv.slice(2)
const link = args.find((arg) => arg.includes('#/device/'))
const label = args.find((arg) => !arg.includes('#/device/') && !arg.startsWith('--')) ?? 'now'
const inbox = Number(args.find((arg) => arg.startsWith('--inbox='))?.split('=')[1] ?? 0)
const dir = `${SHOTS}cards-${label}/`
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })

const CARDS_SAMPLE = () => {
  const page = document.querySelectorAll('.page-slot')[1].querySelector('.history-page')
  const list = page.querySelector('.history-list')
  const round = (value) => Math.round(value * 10) / 10
  const children = [...page.children]
  const above = children.slice(0, children.indexOf(list)).filter((node) => !node.classList.contains('history-toolbar')).map((node) => {
    const opacity = Number(getComputedStyle(node).opacity)
    return `${[...node.classList].join('.')}:${round(node.getBoundingClientRect().height)}${opacity < 1 ? `@${round(opacity)}` : ''}`
  })
  const card = (selector) => {
    const node = page.querySelector(selector)
    if (!node) return null
    const box = node.getBoundingClientRect()
    return { h: round(box.height), top: round(box.top), opacity: round(Number(getComputedStyle(node).opacity)) }
  }
  return {
    rowTop: round(list.querySelector('.history-expense').getBoundingClientRect().top),
    listTop: round(list.getBoundingClientRect().top),
    above: above.join(' | ') || '-',
    reminder: card('.history-reminder'),
    inbox: card('.history-inbox:not(.history-reminder)'),
  }
}

// По верху первой строки: откуда и куда, когда началось и кончилось движение, сколько кадров оно заняло и самый большой
// шаг за кадр (у скачка он равен всему сдвигу).
function summarize({ samples }) {
  const values = samples.map((sample) => sample.rowTop)
  const moving = values.map((value, index) => index && Math.abs(value - values[index - 1]) > 0.05 ? index : -1).filter((index) => index > 0)
  const blocks = []
  for (const sample of samples) if (blocks.at(-1) !== sample.above) blocks.push(sample.above)
  return {
    from: values[0],
    to: values.at(-1),
    delta: Math.round((values.at(-1) - values[0]) * 10) / 10,
    startedAt: moving.length ? samples[moving[0]].t : null,
    settledAt: moving.length ? samples[moving.at(-1)].t : null,
    movingFrames: moving.length,
    maxStep: Math.round(Math.max(0, ...moving.map((index) => Math.abs(values[index] - values[index - 1]))) * 10) / 10,
    above: blocks.length > 3 ? `${blocks[0]} → … (${blocks.length - 2}) → ${blocks.at(-1)}` : blocks.join(' → '),
  }
}

if (link) {
  const { browser, context, page, statePath } = await launch('webkit')
  await acceptDeviceLink(page, context, statePath, link)
  await browser.close()
}
await resetAccount()

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
const record = (name, offline) => realtimeFrames(page, {
  ms: 500, sample: CARDS_SAMPLE,
  action: async () => { await sleep(16); await context.setOffline(offline) },
  shots: [30, 130, 250, 420].map((at, index) => ({ at, clip, path: `${dir}${name}-${index}.png` })),
})
const phases = {}
phases.hide = await record('hide', true)
await sleep(800)
phases.show = await record('show', false)
await browser.close()

const summary = Object.fromEntries(Object.entries(phases).map(([name, phase]) => [name, summarize(phase)]))
writeFileSync(`${dir}cards.json`, JSON.stringify({ label, inbox, summary, phases }, null, 2))
for (const [name, value] of Object.entries(summary)) console.log(`${name.padEnd(4)} первая строка ${value.from} → ${value.to} (${value.delta}) · движение ${value.startedAt ?? '—'}–${value.settledAt ?? '—'} мс, кадров ${value.movingFrames}, шаг до ${value.maxStep} · ${value.above}`)
console.log(`→ ${dir}`)

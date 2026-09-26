// Покадрово: карточка над «Историей» исчезает и появляется. У профиля стенда нет сохранённой ссылки доступа, поэтому
// «Сохраните ссылку доступа» видна, пока есть связь: context.setOffline(true) прячет её, setOffline(false) возвращает
// (App слушает online/offline). С --inbox=N ответ очереди карт подменяется, и над списком стоит ещё
// «N операций с карты ждут разбора» — без связи она уходит вместе с первой.
//   node client/e2e/cards.mjs [метка] [ссылка входа] [--inbox=N]      адрес — MOAPP_BASE, вход — client/e2e/.state/
// Два прохода: реальное время — кадры requestAnimationFrame (~16 мс) в течение ~500 мс от переключения связи; замороженное —
// шаги по 16 мс (page.clock + пауза CSS-переходов) со снимком экрана на каждом шаге, повторяется один в один.
// В кадре: rowTop и listTop — верх первой строки и списка, above — блоки между панелью фильтров и списком (класс:высота@
// прозрачность — карточки или их обёртки), reminder и inbox — сами карточки. Сводка: на сколько и за сколько кадров сдвинулся
// список. На текущей main ожидается скачок за один кадр, после правок — плавное изменение за ~200 мс.
// Результат — .shots/cards-<метка>/cards.json и PNG замороженного прохода.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { launch, openApp, goTab, acceptDeviceLink, pinLocalState, resetAccount, installClock, freeze, frozenFrames, realtimeFrames, SHOTS, sleep } from './common.mjs'

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

// Сводка фазы по верху первой строки: откуда и куда, когда началось и кончилось движение, сколько кадров оно заняло
// и самый большой шаг за кадр (у скачка он равен всему сдвигу).
function summarize(frames) {
  const values = frames.map((frame) => frame.rowTop)
  const moving = values.map((value, index) => index && Math.abs(value - values[index - 1]) > 0.05 ? index : -1).filter((index) => index > 0)
  return {
    from: values[0],
    to: values.at(-1),
    delta: Math.round((values.at(-1) - values[0]) * 10) / 10,
    startedAt: moving.length ? frames[moving[0]].t : null,
    settledAt: moving.length ? frames[moving.at(-1)].t : null,
    movingFrames: moving.length,
    maxStep: Math.round(Math.max(0, ...moving.map((index) => Math.abs(values[index] - values[index - 1]))) * 10) / 10,
    above: [...new Set(frames.map((frame) => frame.above))].length > 3 ? `${frames[0].above} → … → ${frames.at(-1).above}` : [...new Set(frames.map((frame) => frame.above))].join(' → '),
  }
}

async function openHistory(context, page) {
  await pinLocalState(context)
  page.on('pageerror', (error) => console.log('pageerror', error.message))
  if (inbox) await page.route('**/integrations/card-queue', (route) => route.fulfill({ json: { pendingCount: inbox } }))
  await openApp(page)
  await goTab(page, 'История')
  await sleep(800)
  const state = await page.evaluate(CARDS_SAMPLE)
  if (!state.reminder) throw new Error('нет карточки «Сохраните ссылку доступа»: у профиля сохранена ссылка или нет связи')
  if (inbox && !state.inbox) throw new Error('нет карточки очереди карт')
}

if (link) {
  const { browser, context, page, statePath } = await launch('webkit')
  await acceptDeviceLink(page, context, statePath, link)
  await browser.close()
}
await resetAccount()

// Реальное время.
const realtime = {}
{
  const { browser, context, page } = await launch('webkit')
  await openHistory(context, page)
  const record = (offline) => realtimeFrames(page, { ms: 500, sample: CARDS_SAMPLE, action: async () => { await sleep(16); await context.setOffline(offline) } })
  realtime.hide = await record(true)
  await sleep(800)
  realtime.show = await record(false)
  await browser.close()
}

// Замороженное время: шаг 16 мс, связь переключается на втором кадре, снимок экрана на каждом кадре.
const frames = {}
{
  const { browser, context, page } = await launch('webkit')
  await installClock(page)
  await openHistory(context, page)
  await freeze(page)
  const film = (name, offline) => frozenFrames(page, { frames: 32, events: [{ t: 16, run: () => context.setOffline(offline) }], sample: CARDS_SAMPLE, shot: (index) => `${dir}${name}-${String(index).padStart(2, '0')}.png` })
  frames.hide = await film('hide', true)
  frames.show = await film('show', false)
  await browser.close()
}

const summary = {}
for (const [mode, phases] of Object.entries({ realtime, frames })) for (const [phase, list] of Object.entries(phases)) summary[`${mode} ${phase}`] = summarize(list)
writeFileSync(`${dir}cards.json`, JSON.stringify({ label, inbox, summary, realtime, frames }, null, 2))
for (const [key, value] of Object.entries(summary)) console.log(`${key.padEnd(14)} первая строка ${value.from} → ${value.to} (${value.delta}) · движение ${value.startedAt ?? '—'}–${value.settledAt ?? '—'} мс, кадров ${value.movingFrames}, шаг до ${value.maxStep} · ${value.above}`)
console.log(`→ ${dir}`)

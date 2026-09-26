// Покадрово: строка «Истории» открывается свайпом влево и закрывается — касанием открытой строки и протяжкой обратно.
//   node client/e2e/row-swipe.mjs [метка] [ссылка входа]      адрес — MOAPP_BASE, вход — client/e2e/.state/
// Два прохода по второй строке списка:
//   реальное время — кадры requestAnimationFrame (~16 мс) в течение ~500 мс от начала жеста → realtime в JSON;
//   замороженное — время шагами по 16 мс (page.clock + пауза CSS-переходов), после каждого шага состояние и снимок
//   области строки → frames в JSON и <фаза>-NN.png. Эти кадры повторяются один в один: сравнение до/после —
//   `regress-compare.mjs <a> <b> row-swipe`.
// В кадре: tx — сдвиг слоя строки (из вычисленного transform, то есть и посреди перехода), класс строки, «Удалить» —
// shown / hidden / absent (нет в DOM), red — сколько её красного видно, gap — сколько строки открыто без красного (должно
// быть 0 — иначе видна дыра), deletes — сколько кнопок «Удалить» во всём списке.
// Результат — .shots/row-swipe-<метка>/row-swipe.json и PNG.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { launch, openApp, goTab, acceptDeviceLink, pinLocalState, resetAccount, installClock, freeze, frozenFrames, realtimeFrames, SHOTS, sleep, touchDrag } from './common.mjs'

const link = process.argv.find((arg) => arg.includes('#/device/'))
const label = process.argv.slice(2).find((arg) => !arg.includes('#/device/')) ?? 'now'
const dir = `${SHOTS}row-swipe-${label}/`
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const ROW = 1

const ROW_SAMPLE = (index) => {
  const row = document.querySelectorAll('.page-slot')[1].querySelectorAll('.history-expense')[index]
  if (!row) return { missing: true }
  const swipe = row.querySelector('.history-swipe')
  const button = row.querySelector('.history-swipe-delete')
  const matrix = /matrix(3d)?\(([^)]*)\)/.exec(getComputedStyle(swipe).transform)
  const parts = matrix ? matrix[2].split(',').map(Number) : null
  const tx = parts ? (matrix[1] ? parts[12] : parts[4]) : 0
  const rowBox = row.getBoundingClientRect()
  const swipeBox = swipe.getBoundingClientRect()
  const opened = Math.max(0, rowBox.right - swipeBox.right)
  let state = 'absent', red = 0
  if (button) {
    const style = getComputedStyle(button)
    const shown = style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0
    state = shown ? 'shown' : 'hidden'
    if (shown) { const box = button.getBoundingClientRect(); red = Math.max(0, Math.min(box.right, rowBox.right) - Math.max(box.left, swipeBox.right)) }
  }
  // Дыра — открытая часть строки там, где должна быть кнопка (84 px у правого края), но красного нет. Перетяжка дальше
  // кнопки (до 1,15 ширины) открывает полоску фона и дырой не считается: так было всегда.
  return {
    tx: Math.round(tx * 100) / 100,
    row: row.className.replace('history-expense', '').trim() || '-',
    delete: state,
    opened: Math.round(opened),
    red: Math.round(red),
    gap: Math.round(Math.max(0, Math.min(opened, 84) - red)),
    deletes: document.querySelectorAll('.page-slot')[1].querySelectorAll('.history-swipe-delete').length,
  }
}

// Жесты на шкале 16 мс: t — когда событие уходит в страницу.
const rowEvents = (y) => ({
  open: [{ t: 0, type: 'touchstart', x: 300, y }, ...Array.from({ length: 8 }, (_, k) => ({ t: (k + 1) * 16, type: 'touchmove', x: 300 - (k + 1) * 15, y })), { t: 144, type: 'touchend', x: 180, y }],
  // Короткое касание открытой строки: касание, через 48 мс отпускание и клик следом, как на телефоне.
  closeTap: [{ t: 0, type: 'touchstart', x: 150, y }, { t: 48, type: 'touchend', x: 150, y, click: true }],
  // Протяжка обратно на 60 px: дальше половины кнопки, строка доезжает до места сама.
  closeDrag: [{ t: 0, type: 'touchstart', x: 180, y }, ...Array.from({ length: 5 }, (_, k) => ({ t: (k + 1) * 16, type: 'touchmove', x: 180 + (k + 1) * 12, y })), { t: 96, type: 'touchend', x: 240, y }],
})

// Сводка фазы: где строка остановилась и когда, как жила кнопка «Удалить», были ли кадры с дырой.
function summarize(frames) {
  const last = frames.at(-1)
  let settled = frames.length - 1
  while (settled > 0 && Math.abs(frames[settled - 1].tx - last.tx) < 0.5) settled--
  const runs = []
  for (const frame of frames) {
    const current = runs.at(-1)
    if (current?.delete === frame.delete) current.to = frame.t
    else runs.push({ delete: frame.delete, from: frame.t, to: frame.t })
  }
  return {
    final: last.tx,
    settledAt: frames[settled].t,
    delete: runs.map((run) => `${run.delete} ${run.from}–${run.to}`).join(', '),
    gapFrames: frames.filter((frame) => frame.gap > 0).length,
    maxGap: Math.max(...frames.map((frame) => frame.gap)),
    deletesInList: [...new Set(frames.map((frame) => frame.deletes))].join('/'),
  }
}

async function openHistory(context, page) {
  await pinLocalState(context)
  page.on('pageerror', (error) => console.log('pageerror', error.message))
  await openApp(page)
  await goTab(page, 'История')
  await sleep(800)
  return page.evaluate((index) => {
    const box = document.querySelectorAll('.page-slot')[1].querySelectorAll('.history-expense')[index].getBoundingClientRect()
    return { top: Math.round(box.top), height: Math.round(box.height), y: Math.round(box.top + box.height / 2) }
  }, ROW)
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
  const row = await openHistory(context, page)
  const record = (action) => realtimeFrames(page, { ms: 500, sample: ROW_SAMPLE, arg: ROW, action })
  const open = () => touchDrag(page, null, { x: 300, y: row.y }, { x: 180, y: row.y }, { steps: 8, stepDelay: 16 })
  realtime.open = await record(open)
  await sleep(400)
  realtime.closeTap = await record(async () => {
    await touchDrag(page, null, { x: 150, y: row.y }, { x: 150, y: row.y }, { steps: 1, stepDelay: 48 })
    await page.evaluate((index) => document.querySelectorAll('.page-slot')[1].querySelectorAll('.history-row')[index].click(), ROW)
  })
  await sleep(400)
  await open()
  await sleep(600)
  realtime.closeDrag = await record(() => touchDrag(page, null, { x: 180, y: row.y }, { x: 240, y: row.y }, { steps: 5, stepDelay: 16 }))
  await browser.close()
}

// Замороженное время: кадр каждые 16 мс, снимок области строки.
const frames = {}
let rowBox
{
  const { browser, context, page } = await launch('webkit')
  await installClock(page)
  const row = await openHistory(context, page)
  rowBox = row
  const touches = rowEvents(row.y)
  await freeze(page)
  const clip = { x: 0, y: row.top, width: page.viewportSize().width, height: row.height }
  const film = (name, events, withShots = true) => frozenFrames(page, { frames: 32, events, sample: ROW_SAMPLE, arg: ROW, clip, shot: (index) => withShots ? `${dir}${name}-${String(index).padStart(2, '0')}.png` : null })
  frames.open = await film('open', touches.open)
  frames.closeTap = await film('close-tap', touches.closeTap)
  await film('reopen', touches.open, false)
  frames.closeDrag = await film('close-drag', touches.closeDrag)
  await browser.close()
}

const summary = {}
for (const [mode, phases] of Object.entries({ realtime, frames })) for (const [phase, list] of Object.entries(phases)) summary[`${mode} ${phase}`] = summarize(list)
writeFileSync(`${dir}row-swipe.json`, JSON.stringify({ label, row: { index: ROW, ...rowBox }, summary, realtime, frames }, null, 2))
for (const [key, value] of Object.entries(summary)) console.log(`${key.padEnd(18)} стоп ${value.final} к ${value.settledAt} мс · «Удалить»: ${value.delete} · дыра в ${value.gapFrames} кадрах (до ${value.maxGap} px) · кнопок в списке ${value.deletesInList}`)
console.log(`→ ${dir}`)

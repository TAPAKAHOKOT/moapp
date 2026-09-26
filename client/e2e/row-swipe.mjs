// Покадрово: строка «Истории» открывается свайпом влево и закрывается — касанием открытой строки и протяжкой обратно.
//   node client/e2e/row-swipe.mjs [метка] [ссылка входа]      адрес — MOAPP_BASE, вход — client/e2e/.state/
// Вторая строка списка, три фазы (open, closeTap, closeDrag). В каждой — кадры requestAnimationFrame (~16 мс) в течение
// ~500 мс от начала жеста; затем те же жесты ещё раз с четырьмя снимками области строки по ходу (снимок останавливает
// кадры страницы на ~90 мс, поэтому числа и снимки пишутся в разных повторах).
// В кадре: tx — сдвиг слоя строки (из вычисленного transform, то есть и посреди перехода), row — классы строки,
// delete — кнопка «Удалить»: shown / hidden / absent (нет в DOM), opened — насколько строка открыта, red — сколько красного
// видно, gap — открытая часть в пределах ширины кнопки без красного (дыра, должно быть 0), deletes — кнопок во всём списке.
// Сводка фазы: где строка остановилась и когда, как жила кнопка, пропала ли она раньше, чем строка доехала.
// Время кадров плавает на кадр-другой между прогонами; состояния и сводка повторяются.
// Результат — .shots/row-swipe-<метка>/row-swipe.json и PNG.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { launch, openApp, goTab, acceptDeviceLink, guard, pinLocalState, resetAccount, realtimeFrames, snapshotsDuring, SHOTS, sleep, touchDrag } from './common.mjs'

guard(150_000, 'row-swipe.mjs')
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
  // Перетяжка дальше кнопки (до 1,15 ширины) открывает полоску фона — так было всегда, дырой это не считается.
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

function summarize(samples) {
  const last = samples.at(-1)
  let settled = samples.length - 1
  while (settled > 0 && Math.abs(samples[settled - 1].tx - last.tx) < 0.5) settled--
  const states = []
  for (const sample of samples) if (states.at(-1) !== sample.delete) states.push(sample.delete)
  // Кнопка пропала (hidden/absent), пока строка ещё была сдвинута больше чем на 1 px, — это видимая дыра при закрытии.
  const early = samples.find((sample, index) => index > 0 && sample.delete !== 'shown' && samples[index - 1].delete === 'shown' && Math.abs(sample.tx) > 1)
  return {
    final: last.tx,
    settledAt: samples[settled].t,
    delete: states.join(' → '),
    deleteGoneWhileOpen: early ? `${early.t} мс при tx ${early.tx}` : 'нет',
    gapFrames: samples.filter((sample) => sample.gap > 0).length,
    maxGap: Math.max(...samples.map((sample) => sample.gap)),
    deletesInList: [...new Set(samples.map((sample) => sample.deletes))].join('/'),
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
await openApp(page)
await goTab(page, 'История')
await sleep(800)
const row = await page.evaluate((index) => {
  const box = document.querySelectorAll('.page-slot')[1].querySelectorAll('.history-expense')[index].getBoundingClientRect()
  return { top: Math.round(box.top), height: Math.round(box.height), y: Math.round(box.top + box.height / 2) }
}, ROW)
const clip = { x: 0, y: row.top, width: page.viewportSize().width, height: row.height }
const open = () => touchDrag(page, null, { x: 300, y: row.y }, { x: 180, y: row.y }, { steps: 8, stepDelay: 16 })
// Короткое касание открытой строки и клик следом, как на телефоне (синтетические касания клика не порождают).
const closeTap = async () => {
  await touchDrag(page, null, { x: 150, y: row.y }, { x: 150, y: row.y }, { steps: 1, stepDelay: 48 })
  await page.evaluate((index) => document.querySelectorAll('.page-slot')[1].querySelectorAll('.history-row')[index].click(), ROW)
}
// Протяжка обратно на 60 px — дальше половины кнопки, строка доезжает до места сама.
const closeDrag = () => touchDrag(page, null, { x: 180, y: row.y }, { x: 240, y: row.y }, { steps: 5, stepDelay: 16 })

// Каждая фаза — действие и то, что готовит строку к нему; между фазами строка успокаивается.
async function run(each) {
  const result = {}
  result.open = await each('open', open)
  await sleep(400)
  result.closeTap = await each('close-tap', closeTap)
  await sleep(400)
  await open()
  await sleep(600)
  result.closeDrag = await each('close-drag', closeDrag)
  await sleep(400)
  return result
}
const phases = await run((name, action) => realtimeFrames(page, { ms: 500, sample: ROW_SAMPLE, arg: ROW, action }))
const shots = await run((name, action) => snapshotsDuring(page, { action, shots: [40, 140, 260, 420].map((at, index) => ({ at, clip, path: `${dir}${name}-${index}.png` })) }))
await browser.close()

const summary = Object.fromEntries(Object.entries(phases).map(([name, phase]) => [name, summarize(phase)]))
writeFileSync(`${dir}row-swipe.json`, JSON.stringify({ label, row: { index: ROW, ...row }, summary, phases, shots }, null, 2))
for (const [name, value] of Object.entries(summary)) console.log(`${name.padEnd(9)} стоп ${value.final} к ${value.settledAt} мс · «Удалить»: ${value.delete}, пропала раньше строки: ${value.deleteGoneWhileOpen} · дыра в ${value.gapFrames} кадрах (до ${value.maxGap} px) · кнопок в списке ${value.deletesInList}`)
console.log(`→ ${dir}`)

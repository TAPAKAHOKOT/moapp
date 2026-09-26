// Visual regression set: node regress.mjs <label> [device link]  → .shots/regress-<label>/*.png + log.json
// Старые снимки и их имена не меняются (прежние эталоны остаются сравнимыми); новые состояния снимаются после них,
// со сброшенного аккаунта, и называются по-своему. Аккаунт сбрасывается в начале и в конце прогона.
// Часы каждой страницы начинаются сегодня в 12:34 (pinClock): время на карточке «Расхода» одно и то же во всех прогонах
// одного дня, поэтому масок на снимках нет — сравнивается весь экран, в том числе открытые поверх шиты.
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium, devices, webkit } from 'playwright'
import { launch, openApp, goTab, acceptDeviceLink, guard, pinLocalState, patchSettings, resetAccount, pinClock, pinnedNow, ALL_BLOCKS, BASE, SHOTS, STATE_WEBKIT, sleep, touchDrag } from './common.mjs'
guard(25 * 60_000, 'regress.mjs')
const link = process.argv.find((arg) => arg.includes('#/device/'))
const label = process.argv.slice(2).find((arg) => !arg.includes('#/device/')) ?? 'now'
const dir = `${SHOTS}regress-${label}/`
mkdirSync(dir, { recursive: true })
const log = { label, base: BASE, clock: pinnedNow().toString(), settingsWidth: {}, historyEnd: {}, historyLength: {}, pressed: {} }
const HISTORY = 1, ANALYTICS = 2

// Ответы сервера с ошибкой видны в выводе: 429 от ограничителя частоты или 5xx портят снимки молча.
function watchErrors(page, tag) {
  page.on('response', (response) => { if (response.status() >= 400) console.log(`  ${tag}: ${response.status()} ${response.request().method()} ${response.url().replace(BASE, '')}`) })
  page.on('pageerror', (error) => console.log(`  ${tag}: pageerror ${error.message}`))
}

// Ширина документа после «Настроек»: пока у .page-slot нет position: relative, подпись в настройках раздвигает страницу.
async function logSettingsWidth(page, key) {
  log.settingsWidth[key] = await page.evaluate(() => document.documentElement.scrollWidth)
  console.log(`  ${key}: ширина документа после «Настроек» ${log.settingsWidth[key]}`)
}

if (link) {
  const { browser, context, page, statePath } = await launch('webkit')
  await acceptDeviceLink(page, context, statePath, link)
  await browser.close()
}
await resetAccount()

// Телефон WebKit с входом, закреплённым хранилищем и часами на 12:34 — до первой загрузки страницы.
async function phoneContext(scheme, viewport, tag) {
  const opened = await launch('webkit', { colorScheme: scheme, viewport })
  await pinLocalState(opened.context)
  await pinClock(opened.context)
  watchErrors(opened.page, `${tag}-${scheme}`)
  return opened
}

async function phone(scheme, viewport, tag) {
  const { browser, page } = await phoneContext(scheme, viewport, tag)
  await openApp(page)
  await sleep(300)
  await page.screenshot({ path: `${dir}${tag}-${scheme}-entry.png` })
  await touchDrag(page, '.swipe-area', { x: 60, y: 150 }, { x: 330, y: 150 }, { steps: 10, stepDelay: 30 })
  await sleep(700)
  await page.screenshot({ path: `${dir}${tag}-${scheme}-entry-edit.png` })
  await touchDrag(page, '.swipe-area', { x: 330, y: 150 }, { x: 40, y: 150 }, { steps: 10, stepDelay: 30 })
  await sleep(700)
  await page.locator('.entry-lower-live .tag-strip .extra-add').click()
  await sleep(500)
  await page.screenshot({ path: `${dir}${tag}-${scheme}-tag-sheet.png` })
  await page.locator('.tag-sheet .icon-button').click()
  await sleep(400)
  await page.locator('.main-categories button', { hasText: 'Ещё' }).click()
  await sleep(500)
  await page.screenshot({ path: `${dir}${tag}-${scheme}-category-sheet.png` })
  await page.locator('.bottom-sheet .icon-button').click()
  await sleep(400)
  await goTab(page, 'История')
  await sleep(400)
  await page.screenshot({ path: `${dir}${tag}-${scheme}-history.png` })
  await page.locator('.history-chip-strip .filter-chip', { hasText: 'Даты' }).click()
  await sleep(500)
  await page.screenshot({ path: `${dir}${tag}-${scheme}-period-sheet.png` })
  await page.locator('.period-sheet .icon-button').click()
  await sleep(400)
  await goTab(page, 'Аналитика')
  await sleep(1600)
  await page.screenshot({ path: `${dir}${tag}-${scheme}-analytics.png` })
  await page.locator('.analytics-period button', { hasText: 'Месяц' }).click()
  await sleep(1600)
  await page.evaluate(() => { document.querySelectorAll('.page-slot')[2].scrollTop = 500 })
  await sleep(300)
  await page.screenshot({ path: `${dir}${tag}-${scheme}-analytics-month-scrolled.png` })
  await goTab(page, 'Настройки')
  await sleep(700)
  await logSettingsWidth(page, `${tag}-${scheme}`)
  await page.screenshot({ path: `${dir}${tag}-${scheme}-settings.png` })
  await page.locator('.settings-row', { hasText: 'Категории' }).click()
  await sleep(500)
  await page.screenshot({ path: `${dir}${tag}-${scheme}-settings-categories.png` })
  await page.locator('.list-sheet .icon-button').click()
  await sleep(300)
  // Моды — отдельная страница поверх вкладок: снимок списка и шторки первого мода (или каталога, если модов нет).
  await page.locator('.settings-row', { hasText: 'Моды' }).click()
  await sleep(700)
  await page.screenshot({ path: `${dir}${tag}-${scheme}-mods.png` })
  const firstMod = page.locator('.mod-row').first()
  if (await firstMod.count()) await firstMod.click()
  else await page.locator('.mods-add').click()
  await sleep(700)
  await page.screenshot({ path: `${dir}${tag}-${scheme}-mods-sheet.png` })
  await browser.close()
}

await phone('light', { width: 393, height: 659 }, 'p393')
await phone('dark', { width: 393, height: 659 }, 'p393')
await phone('light', { width: 320, height: 568 }, 'p320')
await phone('light', { width: 390, height: 763 }, 'p390')

// desktop: landing + sheet, app settings + dialog
const browser = await webkit.launch()
for (const scheme of ['light', 'dark']) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, serviceWorkers: 'block' })
  context.setDefaultTimeout(15000)
  context.setDefaultNavigationTimeout(20000)
  await pinClock(context)
  const page = await context.newPage()
  await page.goto(BASE)
  await page.waitForSelector('.empty-state')
  await sleep(400)
  await page.screenshot({ path: `${dir}d1440-${scheme}-landing.png` })
  await page.locator('.empty-state .primary').click()
  await sleep(500)
  await page.screenshot({ path: `${dir}d1440-${scheme}-landing-sheet.png` })
  await context.close()
}
await browser.close()
{
  const { browser, page } = await phoneContext('light', { width: 1280, height: 800 }, 'd1280')
  await openApp(page)
  await sleep(300)
  await page.screenshot({ path: `${dir}d1280-light-entry.png` })
  await goTab(page, 'Настройки')
  await sleep(600)
  await logSettingsWidth(page, 'd1280-light')
  await page.locator('.settings-row', { hasText: 'Теги' }).click()
  await sleep(500)
  await page.screenshot({ path: `${dir}d1280-light-settings-tags.png` })
  await browser.close()
}

// ——— Новые состояния: то, что меняют ускорения «Истории», экранов и графиков. Аккаунт снова по умолчанию. ———
await resetAccount()

const scrollSlot = (page, index, top) => page.evaluate(({ index, top }) => { document.querySelectorAll('.page-slot')[index].scrollTop = top }, { index, top })

// До самого конца списка. Если «История» дорисовывает строки по мере прокрутки, её высота растёт — дожимаем, пока
// высота не перестанет меняться, а прокрутка не упрётся в край.
async function scrollSlotToEnd(page, index) {
  let passes = 0
  for (; passes < 60; passes++) {
    const before = await page.evaluate((index) => { const slot = document.querySelectorAll('.page-slot')[index]; slot.scrollTop = slot.scrollHeight; return slot.scrollHeight }, index)
    await sleep(250)
    const after = await page.evaluate((index) => { const slot = document.querySelectorAll('.page-slot')[index]; return { height: slot.scrollHeight, atEnd: slot.scrollHeight - slot.clientHeight - slot.scrollTop < 1 } }, index)
    if (after.height === before && after.atEnd) break
  }
  return passes + 1
}

// Середина строки «Истории» по её номеру среди строк (0 — первая).
const rowCenter = (page, index) => page.evaluate((index) => {
  const box = document.querySelectorAll('.page-slot')[1].querySelectorAll('.history-expense')[index].getBoundingClientRect()
  return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }
}, index)

// Аналитика ждёт ответа сервера, график и число в шапке доезжают за 250 мс — пауза с запасом, как у старых снимков.
const ANALYTICS_SETTLE = 1600

// После перезагрузки часы снова начинаются с 12:34: init-скрипт pinClock ставится в каждый новый документ.
async function reloadApp(page) {
  await page.reload()
  await page.waitForSelector('.app-shell', { timeout: 20000 })
  await sleep(900)
}

// Полный набор новых состояний для 393×659 (светлая и тёмная тема); на других экранах — только прокрутка и жесты «Истории».
async function extras(scheme, viewport, tag, { full }) {
  const { browser, page } = await phoneContext(scheme, viewport, tag)
  const shot = (name) => page.screenshot({ path: `${dir}${tag}-${scheme}-${name}.png` })
  await openApp(page)
  await sleep(300)

  // «История» на прокрутке 0, 2 500, 6 000 px и в самом конце, где полоса «Ещё N записей до …».
  await goTab(page, 'История')
  await sleep(500)
  for (const top of [0, 2500, 6000]) {
    await scrollSlot(page, HISTORY, top)
    await sleep(800)
    await shot(`history-at-${top}`)
  }
  const passes = await scrollSlotToEnd(page, HISTORY)
  await sleep(800)
  await shot('history-at-end')
  log.historyEnd[`${tag}-${scheme}`] = { passes, ...await page.evaluate(() => { const slot = document.querySelectorAll('.page-slot')[1]; return { scrollHeight: slot.scrollHeight, scrollTop: Math.round(slot.scrollTop), older: slot.querySelector('.history-older span')?.textContent ?? null } }) }
  await scrollSlot(page, HISTORY, 0)
  await sleep(600)

  // Выбор нескольких: долгое касание второй строки — у строк появляются чекбоксы, сверху «Выбрано 1».
  const row = await rowCenter(page, 1)
  await touchDrag(page, null, row, row, { steps: 1, holdMs: 700 })
  await sleep(800)
  await shot('history-select')
  await page.locator('.history-selectbar .text-button').click()
  await sleep(700)

  // Вторая строка, открытая свайпом влево: видна красная «Удалить». Касание открытой строки закрывает её.
  await touchDrag(page, null, { x: 300, y: row.y }, { x: 180, y: row.y }, { steps: 8, stepDelay: 16 })
  await sleep(800)
  await shot('history-swiped')
  await page.locator('.page-slot').nth(HISTORY).locator('.history-row').nth(1).click()
  await sleep(700)

  if (full) {
    // «Настройка экрана»: значок в шапке, выход — «Готово».
    for (const [tab, name] of [['Расход', 'entry'], ['История', 'history'], ['Аналитика', 'analytics']]) {
      await goTab(page, tab)
      await sleep(name === 'analytics' ? ANALYTICS_SETTLE : 300)
      await page.locator('.screen-edit-open').click()
      await sleep(1000)
      await shot(`${name}-arrange`)
      await page.locator('.screen-edit-done').click()
      await sleep(700)
    }

    // Все новые блоки «Расхода» и «Аналитики»; аналитика — вся лента шагами по 500 px.
    await patchSettings(page, ALL_BLOCKS)
    await reloadApp(page)
    await shot('entry-allblocks')
    await goTab(page, 'Аналитика')
    await sleep(ANALYTICS_SETTLE)
    const size = await page.evaluate(() => { const slot = document.querySelectorAll('.page-slot')[2]; return { height: slot.scrollHeight, view: slot.clientHeight } })
    const last = size.height - size.view
    for (let index = 0, top = 0; ; index++, top += 500) {
      await scrollSlot(page, ANALYTICS, Math.min(top, last))
      await sleep(500)
      await shot(`analytics-allblocks-${index}`)
      if (top >= last) break
    }
    log.analyticsAllBlocksHeight = { ...log.analyticsAllBlocksHeight, [`${tag}-${scheme}`]: size.height }

    // Крупный текст: «Расход», «История», «Аналитика».
    await patchSettings(page, { entryBlocks: null, analyticsBlocks: null, textSize: 'large' })
    await reloadApp(page)
    await shot('entry-large')
    await goTab(page, 'История')
    await sleep(500)
    await shot('history-large')
    await goTab(page, 'Аналитика')
    await sleep(ANALYTICS_SETTLE)
    await shot('analytics-large')

    // Другой акцент: графики и числа «Аналитики» в голубом.
    await patchSettings(page, { textSize: null, accent: 'blue' })
    await reloadApp(page)
    await goTab(page, 'Аналитика')
    await sleep(ANALYTICS_SETTLE)
    await shot('analytics-blue')
    await patchSettings(page, { accent: null })
  }
  await browser.close()
}

await extras('light', { width: 393, height: 659 }, 'p393', { full: true })
await extras('dark', { width: 393, height: 659 }, 'p393', { full: true })
await extras('light', { width: 390, height: 763 }, 'p390', { full: false })
await extras('light', { width: 320, height: 568 }, 'p320', { full: false })

// ——— Длина прокрутки «Истории»: полоса прокрутки и дальность флика зависят от неё, а не только от видимых строк. ———
// Что нарисовано: строки, высота слота, прокрутка и пустота ниже строк в видимой части. «Пустоту» даёт отступ
// .history-rest, которым «История» с порциями держит длину ненарисованных строк (у ревизий без порций его нет — 0).
const historyState = (page) => page.evaluate(() => {
  const slot = document.querySelectorAll('.page-slot')[1]
  const view = slot.getBoundingClientRect()
  const rest = slot.querySelector('.history-rest')?.getBoundingClientRect()
  const blank = rest ? Math.max(0, Math.min(view.bottom, rest.bottom) - Math.max(view.top, rest.top)) : 0
  return { scrollHeight: slot.scrollHeight, scrollTop: Math.round(slot.scrollTop), rows: slot.querySelectorAll('.history-expense').length, rest: rest ? Math.round(rest.height) : 0, blank: Math.round(blank) }
})

// Ждёт условия на странице не дольше limit мс; ответ — сколько ждали, или null, если так и не дождались.
async function waitFor(page, limit, check, arg) {
  const started = Date.now()
  for (;;) {
    if (await page.evaluate(check, arg)) return Date.now() - started
    if (Date.now() - started > limit) return null
    await sleep(50)
  }
}

async function historyLength(scheme, viewport, tag) {
  const { browser, page } = await phoneContext(scheme, viewport, tag)
  const shot = (name) => page.screenshot({ path: `${dir}${tag}-${scheme}-${name}.png` })
  const entry = log.historyLength[`${tag}-${scheme}`] = {}
  await openApp(page)
  await goTab(page, 'История')
  await sleep(500)
  entry.opened = await historyState(page)

  // Граница первой порции: 118-я строка на трети экрана — видны последние строки порции и первые следующей.
  // Дорисовка ждётся, только если есть отступ (без порций список уже целый).
  await page.evaluate(() => {
    const slot = document.querySelectorAll('.page-slot')[1]
    const row = slot.querySelectorAll('.history-expense')[117]
    slot.scrollTop = Math.round(slot.scrollTop + row.getBoundingClientRect().top - slot.getBoundingClientRect().top - slot.clientHeight / 3)
  })
  const waitedMs = entry.opened.rest ? await waitFor(page, 2000, (rows) => document.querySelectorAll('.page-slot')[1].querySelectorAll('.history-expense').length > rows, entry.opened.rows) : 0
  await sleep(600)
  entry.portion = { ...await historyState(page), waitedMs }
  await shot('history-portion-edge')

  // Прыжок на 40 000 px одним присваиванием, как полосой прокрутки, со свежей страницы (первая порция): порции
  // должны сами закрыть пустоту на экране не дольше 2 с — без повторных прокруток.
  await reloadApp(page)
  await goTab(page, 'История')
  await sleep(500)
  await scrollSlot(page, HISTORY, 40000)
  const fillMs = await waitFor(page, 2000, () => {
    const slot = document.querySelectorAll('.page-slot')[1]
    const rest = slot.querySelector('.history-rest')
    return !rest || rest.getBoundingClientRect().top >= slot.getBoundingClientRect().bottom
  })
  await sleep(600)
  entry.jump = { ...await historyState(page), fillMs }
  await shot('history-jump-40000')
  console.log(`  ${tag}-${scheme}: высота «Истории» ${entry.opened.scrollHeight} → ${entry.portion.scrollHeight} (порция за ${waitedMs ?? '>2000'} мс), прыжок: пустота закрыта за ${fillMs ?? '>2000'} мс, высота ${entry.jump.scrollHeight}`)
  await browser.close()
}

await historyLength('light', { width: 393, height: 659 }, 'p393')
await historyLength('dark', { width: 393, height: 659 }, 'p393')
await historyLength('light', { width: 390, height: 763 }, 'p390')
await historyLength('light', { width: 320, height: 568 }, 'p320')

// ——— Плашка нажатия строки «Истории». Сравнивается вид, а не момент: на main это :active, в ветке — класс .pressed,
// который касание ставит через ~100 мс неподвижного пальца, а мышь — сразу. ———
// Цвет подложки строки под пальцем — в журнал: у обеих ревизий он должен быть одним и тем же.
const plate = (page) => page.evaluate(() => {
  const row = document.querySelectorAll('.page-slot')[1].querySelectorAll('.history-expense')[1]
  const swipe = getComputedStyle(row.querySelector('.history-swipe'))
  return { background: swipe.backgroundColor, radius: swipe.borderRadius, selecting: Boolean(document.querySelector('.history-selectbar')) }
})

// Мышь: обычное окно 390×844 без касаний, кнопка зажата над второй строкой и не отпущена. Снимок до 450 мс — дальше
// удержание включило бы выбор записей.
async function pressedMouse(scheme) {
  const browser = await webkit.launch()
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme, serviceWorkers: 'block', storageState: STATE_WEBKIT })
  context.setDefaultTimeout(15000)
  context.setDefaultNavigationTimeout(20000)
  await pinLocalState(context)
  await pinClock(context)
  const page = await context.newPage()
  watchErrors(page, `m390-${scheme}`)
  await openApp(page)
  await goTab(page, 'История')
  await sleep(500)
  const row = await rowCenter(page, 1)
  await page.mouse.move(row.x, row.y)
  await sleep(300)
  await page.mouse.down()
  await sleep(120)
  log.pressed[`m390-${scheme}`] = await plate(page)
  await page.screenshot({ path: `${dir}m390-${scheme}-history-pressed-mouse.png` })
  await browser.close()
}

// Касание: iPhone в Chromium. Долгий тап через CDP (Input.synthesizeTapGesture) проходит настоящий путь касания, и
// :active на main зажигается (примерно через 150 мс). Синтетические TouchEvent (touchDrag) :active не ставят, а
// касание в Playwright WebKit — только мгновенный тап, поэтому в WebKit сравнимого снимка удержания нет.
// Палец стоит 440 мс (меньше 450 мс выбора записей), снимок — на 300 мс.
async function pressedTouch(scheme) {
  const browser = await chromium.launch()
  const context = await browser.newContext({ ...devices['iPhone 15'], viewport: { width: 393, height: 659 }, colorScheme: scheme, serviceWorkers: 'block', storageState: STATE_WEBKIT })
  context.setDefaultTimeout(15000)
  context.setDefaultNavigationTimeout(20000)
  await pinLocalState(context)
  await pinClock(context)
  const page = await context.newPage()
  watchErrors(page, `c393-${scheme}`)
  await openApp(page)
  await goTab(page, 'История')
  await sleep(500)
  const row = await rowCenter(page, 1)
  const cdp = await context.newCDPSession(page)
  const hold = cdp.send('Input.synthesizeTapGesture', { x: row.x, y: row.y, duration: 440, tapCount: 1, gestureSourceType: 'touch' })
  await sleep(300)
  const during = await plate(page)
  await page.screenshot({ path: `${dir}c393-${scheme}-history-pressed-touch.png` })
  log.pressed[`c393-${scheme}`] = { ...during, stillHeld: (await plate(page)).background === during.background }
  await hold
  await browser.close()
}

await pressedMouse('light')
await pressedMouse('dark')
await pressedTouch('light')
await pressedTouch('dark')
await resetAccount()

writeFileSync(`${dir}log.json`, JSON.stringify(log, null, 2))
console.log('captured', label)

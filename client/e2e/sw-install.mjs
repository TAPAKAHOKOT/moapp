// Живая установка сервис-воркера: свежий браузер открывает одноразовую ссылку входа, как новый человек на телефоне.
//   PERF_WORK=… node client/e2e/sw-install.mjs --port=N [--label=метка] [webkit] [chromium]   (по умолчанию оба движка)
// Сервис-воркер здесь, в отличие от остальных сценариев, включён: скрипт ждёт, пока он заберёт страницу
// (navigator.serviceWorker.controller), считает загрузки документа главного фрейма и смотрит, где оказался человек.
// Ожидание: один документ, экран «Подключить» пережил установку, после нажатия — пространство, кнопки «Обновить» нет.
// Сборка стенда — продакшен, поэтому main.tsx регистрирует /sw.js, как на проде; в ней воркер из client/public/sw.js
// (кэширует только оболочку: без плагина Vite список файлов сборки ему не подставлен), жизненный цикл тот же:
// install → activate → clients.claim() → controllerchange.
// Ссылки одноразовые — каждая берётся заново через API стенда (как `stand.mjs link`).
// Итог — .shots/sw-install-<метка>/sw-install.json и снимки экрана до и после нажатия; код выхода 1, если что-то не так.
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium, devices, webkit } from 'playwright'
import { api, parseArgs } from './perf/common.mjs'
import { SHOTS, guard, sleep } from './common.mjs'

guard(3 * 60_000, 'sw-install.mjs')
const { positional, flags } = parseArgs(process.argv.slice(2))
const port = Number(flags.port ?? 4411)
const label = flags.label ?? String(port)
const kinds = positional.length ? positional : ['webkit', 'chromium']
const base = `http://localhost:${port}`
const dir = `${SHOTS}sw-install-${label}/`
mkdirSync(dir, { recursive: true })

async function screen(page) {
  return page.evaluate(() => {
    if (document.querySelector('.app-shell')) return 'пространство'
    if ([...document.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Подключить')) return 'подключить'
    if (document.querySelector('.empty-state')) return 'гостевой экран'
    return 'пусто'
  }).catch(() => 'перезагружается')
}

async function run(kind) {
  const { url } = await api(port, 'POST', '/api/me/device-links', {})
  const browser = kind === 'webkit' ? await webkit.launch() : await chromium.launch()
  const context = await browser.newContext({ ...devices['iPhone 15'], viewport: { width: 393, height: 659 }, serviceWorkers: 'allow' })
  context.setDefaultTimeout(15000)
  const page = await context.newPage()
  const started = Date.now()
  const at = () => Date.now() - started
  // framenavigated приходит и на смену адреса внутри документа (capability.ts вынимает токен из адреса через
  // history.replaceState), поэтому отдельно считаются загрузки документа — навигационные запросы главного фрейма.
  const navigations = [], documents = [], controllerChanges = []
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations.push({ t: at(), url: frame.url().replace(base, '').replace(/#\/device\/.+/, '#/device/…') }) })
  page.on('request', (request) => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents.push({ t: at(), url: request.url().replace(base, '').replace(/#\/device\/.+/, '#/device/…') }) })
  page.on('console', (message) => { if (message.text().startsWith('sw-install:')) controllerChanges.push({ t: at(), text: message.text() }) })
  await context.addInitScript(() => {
    navigator.serviceWorker?.addEventListener('controllerchange', () => console.log('sw-install: controllerchange'))
  })

  await page.goto(url)
  const first = await screen(page)
  // Воркер забирает страницу за доли секунды после load. Если приложение перезагрузится, ожидание переживёт это:
  // waitForFunction проверяет условие заново в новом документе.
  let controlled = true
  await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller), null, { timeout: 15000 }).catch(() => { controlled = false })
  const controlledAt = at()
  // Время на перезагрузку, если она будет, и на отрисовку того, что после неё.
  await sleep(2000)
  await page.waitForSelector('.app-shell, .empty-state, button:has-text("Подключить")', { timeout: 15000 }).catch(() => {})
  const afterInstall = await screen(page)
  await page.screenshot({ path: `${dir}${kind}-after-install.png` })
  let afterConnect = afterInstall
  if (afterInstall === 'подключить') {
    const button = page.getByRole('button', { name: 'Подключить' })
    await page.waitForFunction(() => { const found = [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === 'Подключить'); return found && !found.disabled }, null, { timeout: 15000 })
    await button.click()
    await page.waitForSelector('.app-shell, .empty-state', { timeout: 20000 }).catch(() => {})
    // Шапка с «Обновить» появилась бы, пока воркер ждёт в waiting; ему даётся время.
    await sleep(1500)
    afterConnect = await screen(page)
  }
  await page.screenshot({ path: `${dir}${kind}-final.png` })
  const updateButton = await page.locator('.update-button').count()
  const worker = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker?.getRegistration()
    return { controller: Boolean(navigator.serviceWorker?.controller), active: registration?.active?.state ?? null, waiting: Boolean(registration?.waiting), navigationType: performance.getEntriesByType('navigation')[0]?.type ?? null }
  }).catch((error) => ({ error: error.message }))
  await browser.close()

  const result = { kind, controlled, controlledAt, first, afterInstall, afterConnect, documents, navigations, controllerChanges, updateButton, worker }
  const problems = []
  if (!controlled) problems.push('воркер так и не забрал страницу')
  if (documents.length !== 1) problems.push(`документ загружался ${documents.length} раза`)
  if (afterConnect !== 'пространство') problems.push(`человек на экране «${afterConnect}»`)
  if (updateButton) problems.push('в шапке «Обновить»')
  result.ok = problems.length === 0
  result.problems = problems
  console.log(`${kind}: ${result.ok ? 'ok' : problems.join('; ')}`)
  console.log(`  воркер забрал страницу: ${controlled ? `через ${controlledAt} мс` : 'нет'}; controllerchange: ${controllerChanges.map((item) => `${item.t} мс`).join(', ') || '—'}`)
  console.log(`  загрузки документа: ${documents.map((item) => `${item.t} мс ${item.url}`).join(' · ')}`)
  console.log(`  framenavigated: ${navigations.map((item) => `${item.t} мс ${item.url}`).join(' · ')}`)
  console.log(`  экран: сразу «${first}», после установки «${afterInstall}», в конце «${afterConnect}»; «Обновить»: ${updateButton ? 'есть' : 'нет'}; воркер ${JSON.stringify(worker)}`)
  return result
}

const results = []
for (const kind of kinds) results.push(await run(kind))
writeFileSync(`${dir}sw-install.json`, JSON.stringify({ base, results }, null, 2))
process.exitCode = results.every((result) => result.ok) ? 0 : 1

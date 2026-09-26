// Стенд замеров: любая ревизия приложения на своём порту, с одним и тем же годом расходов.
//   node client/e2e/perf/stand.mjs seed                 — один раз: база с данными и вход WebKit/Chromium
//   node client/e2e/perf/stand.mjs up <rev|.> [--port=N] — собрать ревизию (или «.» — рабочую копию) и поднять сервер
//   node client/e2e/perf/stand.mjs down [--port=N]      — остановить
//   node client/e2e/perf/stand.mjs link [--port=N]      — ссылка входа для другого браузера (regress.mjs)
// Все стенды получают копию одной базы, поэтому снимки и замеры разных ревизий сравнимы попиксельно.
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { chromium, webkit } from 'playwright'
import { DEFAULT_PORT, HERE, PHONE, REPO, WORK, api, parseArgs, profilePath, sleep, storagePath } from './common.mjs'

const { positional: [command, revArg], flags } = parseArgs(process.argv.slice(2))
const port = Number(flags.port ?? DEFAULT_PORT)
const seedDb = resolve(WORK, 'seed.sqlite')

function startServer({ src, dist, db, port: serverPort }) {
  const log = openSync(resolve(WORK, `server-${serverPort}.log`), 'w')
  const child = spawn(process.execPath, ['--import', 'tsx', resolve(HERE, 'server.mjs')], {
    cwd: REPO, detached: true, stdio: ['ignore', log, log],
    env: { ...process.env, STAND_SRC: src, ...(dist ? { STAND_DIST: dist } : {}), DATABASE_PATH: db, PORT: String(serverPort) },
  })
  child.unref()
  writeFileSync(resolve(WORK, `server-${serverPort}.pid`), String(child.pid))
  return child.pid
}

async function waitHealthy(serverPort) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await fetch(`http://localhost:${serverPort}/api/health`)).ok) return } catch { /* ещё поднимается */ }
    await sleep(500)
  }
  throw new Error(`сервер на ${serverPort} не ответил, см. ${resolve(WORK, `server-${serverPort}.log`)}`)
}

function stopServer(serverPort) {
  const pidFile = resolve(WORK, `server-${serverPort}.pid`)
  if (!existsSync(pidFile)) return false
  const pid = Number(readFileSync(pidFile, 'utf8'))
  try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(pid, 'SIGTERM') } catch { /* уже остановлен */ } }
  rmSync(pidFile)
  return true
}

const dbFiles = (path) => [path, `${path}-wal`, `${path}-shm`]

// Детерминированный год трат: тот же генератор и тот же якорь (сегодня, полдень) дают одинаковые данные весь день.
async function seedData(serverPort, count = 1500) {
  const origin = `http://localhost:${serverPort}`
  const call = async (profile, method, path, body) => {
    const headers = { origin }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (profile) Object.assign(headers, { cookie: profile.cookie, 'x-moapp-expected-user-id': profile.userId, 'x-moapp-expected-session-id': profile.sessionId })
    const response = await fetch(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text}`)
    return { json: text ? JSON.parse(text) : null, cookie: response.headers.get('set-cookie') }
  }
  let state = 42
  const random = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648 }
  const pick = (list) => list[Math.floor(random() * list.length)]
  const { json: me, cookie } = await call(null, 'POST', '/api/identity', { displayName: 'Ваня' })
  const profile = { userId: me.user.id, sessionId: me.currentSessionId, cookie: cookie.split(';', 1)[0] }
  const workspaceId = randomUUID()
  await call(profile, 'POST', '/api/workspaces', { id: workspaceId, name: 'Дом', currency: 'RSD' })
  const boot = (await call(profile, 'GET', `/api/workspaces/${workspaceId}/bootstrap?tz=Europe%2FBelgrade`)).json
  const categories = boot.categories.map((category) => category.id)
  const tagSpecs = [['вдвоём', '#819978'], ['отпуск', '#7d9db4'], ['подарок', '#d98f70'], ['кофе', '#d2ad62'], ['дети', '#aa8aaf'], ['такси', '#797d72'], ['работа', null], ['здоровье', '#819978'], ['машина', '#7d9db4'], ['друзья', '#d98f70']]
  const tags = []
  for (const [name, color] of tagSpecs) tags.push((await call(profile, 'POST', `/api/workspaces/${workspaceId}/tags`, { id: randomUUID(), name, color })).json.id)
  const notes = ['Maxi', 'Lidl', 'Idea', 'Aroma', 'IKEA', 'Аптека', 'Кафе', 'Yandex Go', 'Wolt', 'Glovo', 'Netflix', 'Бранч', 'Ужин', 'Кино', 'Стрижка', 'Рынок', 'Пекарня', 'Заправка', 'OPENAI *CHATGPT SUBSCR', 'Подарок маме']
  const anchor = new Date()
  anchor.setHours(12, 0, 0, 0)
  const older = Math.round(count * 0.15)
  const operations = []
  for (let index = 0; index < count + older; index++) {
    const daysAgo = index < count ? random() * 360 : 372 + random() * 150
    const roll = random()
    const currency = roll < 0.84 ? 'RSD' : roll < 0.94 ? 'EUR' : roll < 0.98 ? 'USD' : 'RUB'
    const amount = currency === 'RSD' ? 150 + random() * 9000 : currency === 'EUR' ? 3 + random() * 120 : currency === 'USD' ? 5 + random() * 90 : 300 + random() * 4000
    const tagCount = random() < 0.35 ? (random() < 0.7 ? 1 : 2) : 0
    const tagIds = [...new Set(Array.from({ length: tagCount }, () => pick(tags)))]
    operations.push({ operationId: randomUUID(), type: 'createExpense', payload: {
      id: randomUUID(), amountMinor: Math.round(amount * 100), currency, categoryId: pick(categories),
      note: random() < 0.55 ? pick(notes) : null, occurredAt: new Date(anchor.getTime() - daysAgo * 86_400_000).toISOString(), tagIds,
    } })
  }
  for (let offset = 0; offset < operations.length; offset += 200) {
    const { json } = await call(profile, 'POST', `/api/workspaces/${workspaceId}/sync`, { operations: operations.slice(offset, offset + 200) })
    const failed = json.results.filter((result) => result.status !== 'applied')
    if (failed.length) throw new Error(`не записалось: ${JSON.stringify(failed[0])}`)
  }
  return { profile, workspaceId, count, older }
}

async function login(kind, serverPort) {
  const { url } = await api(serverPort, 'POST', '/api/me/device-links', {})
  const browser = kind === 'webkit' ? await webkit.launch() : await chromium.launch()
  const context = await browser.newContext({ ...PHONE, serviceWorkers: 'block' })
  const page = await context.newPage()
  await page.goto(url)
  const button = page.getByRole('button', { name: 'Подключить' })
  await button.waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForFunction(() => { const found = [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === 'Подключить'); return found && !found.disabled }, null, { timeout: 30_000 })
  await button.click()
  await page.waitForSelector('.app-shell', { timeout: 30_000 })
  await context.storageState({ path: storagePath(kind) })
  await browser.close()
}

function snapshot(rev) {
  // Рабочая копия: метка по имени каталога, чтобы сборки из разных worktree не перезаписывали друг друга.
  if (rev === '.' || rev === 'worktree') return { label: `worktree-${basename(REPO)}`, src: REPO, clientRoot: resolve(REPO, 'client') }
  const sha = execFileSync('git', ['rev-parse', '--short', rev], { cwd: REPO, encoding: 'utf8' }).trim()
  const dir = resolve(WORK, `src-${sha}`)
  if (!existsSync(resolve(dir, 'client'))) {
    mkdirSync(dir, { recursive: true })
    execFileSync('sh', ['-c', `git archive ${sha} client server package.json | tar -x -C '${dir}'`], { cwd: REPO })
    symlinkSync(resolve(REPO, 'node_modules'), resolve(dir, 'node_modules'))
  }
  return { label: sha, src: dir, clientRoot: resolve(dir, 'client') }
}

function build({ label, clientRoot }) {
  const out = resolve(WORK, `dist-${label}`)
  execFileSync(process.execPath, [resolve(REPO, 'node_modules/vite/bin/vite.js'), 'build', '--config', resolve(HERE, 'vite.stand.config.mjs')], {
    cwd: REPO, stdio: 'inherit', env: { ...process.env, STAND_CLIENT_ROOT: clientRoot, STAND_OUT: out, STAND_CACHE: resolve(WORK, `.vite-${label}`) },
  })
  return out
}

if (command === 'seed') {
  const seedPort = 4499
  stopServer(seedPort)
  for (const file of dbFiles(seedDb)) rmSync(file, { force: true })
  // Экран входа по ссылке нужен клиенту — берём сборку рабочей копии, для входа годится любая версия.
  startServer({ src: REPO, dist: build(snapshot('.')), db: seedDb, port: seedPort })
  try {
    await waitHealthy(seedPort)
    const seeded = await seedData(seedPort, Number(flags.count ?? 1500))
    writeFileSync(profilePath, JSON.stringify(seeded.profile, null, 2))
    await login('webkit', seedPort)
    await login('chromium', seedPort)
    console.log(`база готова: ${seeded.count} трат за год и ${seeded.older} старше, вход для WebKit и Chromium сохранён`)
  } finally {
    stopServer(seedPort)
    await sleep(500)
  }
} else if (command === 'up') {
  if (!existsSync(seedDb)) throw new Error('сначала `node client/e2e/perf/stand.mjs seed`')
  if (!revArg) throw new Error('укажите ревизию: up <rev|.>')
  stopServer(port)
  const source = snapshot(revArg)
  const dist = build(source)
  const db = resolve(WORK, `db-${port}.sqlite`)
  dbFiles(seedDb).forEach((file, index) => { if (existsSync(file)) copyFileSync(file, dbFiles(db)[index]); else rmSync(dbFiles(db)[index], { force: true }) })
  startServer({ src: source.src, dist, db, port })
  await waitHealthy(port)
  console.log(`${source.label} на http://localhost:${port}`)
} else if (command === 'down') {
  console.log(stopServer(port) ? `стенд на ${port} остановлен` : `на ${port} стенда нет`)
} else if (command === 'link') {
  console.log((await api(port, 'POST', '/api/me/device-links', {})).url)
} else {
  console.log('команды: seed | up <rev|.> [--port=N] | down [--port=N] | link [--port=N]')
}

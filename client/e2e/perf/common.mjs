// Общее для стенда замеров: пути, профиль телефона, инструменты страницы и запуск браузера.
import { chromium, webkit } from 'playwright'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

export const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO = resolve(HERE, '../../..')
// PERF_WORK — общий каталог базы и сборок, когда стенд запускают из отдельного git worktree.
export const WORK = process.env.PERF_WORK ? resolve(process.env.PERF_WORK) : resolve(HERE, '.work')
export const RESULTS = resolve(HERE, '.results')
export const DEFAULT_PORT = 4411
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

for (const dir of [WORK, RESULTS]) mkdirSync(dir, { recursive: true })

// iPhone 13 в Safari с панелью: 390×664 CSS px, DPR 3, касания.
export const PHONE = {
  viewport: { width: 390, height: 664 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
}

export const storagePath = (kind) => resolve(WORK, `storage-${kind}.json`)
export const profilePath = resolve(WORK, 'profile.json')
export const readProfile = () => JSON.parse(readFileSync(profilePath, 'utf8'))

export function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (const arg of argv) {
    if (!arg.startsWith('--')) { positional.push(arg); continue }
    const [key, value] = arg.slice(2).split('=')
    flags[key] = value ?? true
  }
  return { positional, flags }
}

export async function api(port, method, path, body, profile = readProfile()) {
  const headers = { origin: `http://localhost:${port}`, cookie: profile.cookie, 'x-moapp-expected-user-id': profile.userId, 'x-moapp-expected-session-id': profile.sessionId }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`http://localhost:${port}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text}`)
  return text ? JSON.parse(text) : null
}

// Ставится до React: хук в духе React DevTools считает, какие компоненты действительно отрисовались в каждом коммите
// (поддерево, у которого не сменился child, не трогалось), и лента кадров requestAnimationFrame.
export const INSTRUMENT = () => {
  const perf = window.__perf = { counting: false, commits: [], frames: [] }
  const PerformedWork = 1
  const componentTags = new Set([0, 1, 11, 14, 15])
  const nameOf = (fiber) => {
    let type = fiber.type
    if (!type) return '?'
    if (typeof type === 'object' && type.type) type = type.type
    if (typeof type === 'object' && type.render) type = type.render
    return type.displayName || type.name || 'anonymous'
  }
  const bump = (counts, fiber) => { const name = nameOf(fiber); counts[name] = (counts[name] ?? 0) + 1 }
  const mountAll = (fiber, counts) => {
    const stack = [fiber]
    while (stack.length) {
      const node = stack.pop()
      if (componentTags.has(node.tag)) bump(counts, node)
      if (node.child) stack.push(node.child)
      if (node.sibling && node !== fiber) stack.push(node.sibling)
    }
  }
  const walk = (next, prev, counts, mounts) => {
    if (!prev) { mountAll(next, mounts); return }
    if (componentTags.has(next.tag) && (next.flags & PerformedWork)) bump(counts, next)
    if (next.child !== prev.child) for (let child = next.child; child; child = child.sibling) walk(child, child.alternate, counts, mounts)
  }
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map(), supportsFiber: true, isDisabled: false,
    inject(renderer) { const id = this.renderers.size + 1; this.renderers.set(id, renderer); return id },
    checkDCE() {}, onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id, root) {
      const at = performance.now()
      if (!perf.counting) { perf.commits.push({ at }); return }
      const counts = {}, mounts = {}
      for (let child = root.current.child; child; child = child.sibling) walk(child, child.alternate, counts, mounts)
      perf.commits.push({ at, counts, mounts })
    },
  }
  const frame = (now) => { perf.frames.push(now); requestAnimationFrame(frame) }
  requestAnimationFrame(frame)
}

// Сервис-воркер на стенде не нужен: в чистом браузере он забирает страницу и перезагружает её посреди замера.
export async function launch(kind, { throttle = 1 } = {}) {
  const browser = kind === 'webkit' ? await webkit.launch() : await chromium.launch()
  const storage = storagePath(kind)
  const context = await browser.newContext({ ...PHONE, serviceWorkers: 'block', ...(existsSync(storage) ? { storageState: storage } : {}) })
  await context.addInitScript(INSTRUMENT)
  const page = await context.newPage()
  let cdp = null
  if (kind === 'chromium') {
    cdp = await context.newCDPSession(page)
    await cdp.send('Performance.enable', { timeDomain: 'timeTicks' })
    if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle })
  }
  return { browser, context, page, cdp }
}

// Экран и период — в аккаунте: перед замером возвращаем раскладку по умолчанию (или все новые блоки) и «Неделю».
export async function resetAccount(page, { allBlocks = false } = {}) {
  await page.evaluate(async (allBlocks) => {
    const session = await (await fetch('/api/session', { credentials: 'include' })).json()
    if (!session?.authenticated) throw new Error('стенд не залогинен: запустите `node client/e2e/perf/stand.mjs seed`')
    const blocks = allBlocks
      ? { entryBlocks: { shown: ['today', 'usual', 'keypad', 'tiles', 'note', 'tags'], hidden: [] }, analyticsBlocks: { shown: ['trend', 'pace', 'categories', 'top', 'tags', 'weekdays', 'calendar'], hidden: [] } }
      : { entryBlocks: null, historyBlocks: null, analyticsBlocks: null }
    await fetch('/api/me/settings', { method: 'PATCH', credentials: 'include', headers: { 'content-type': 'application/json', 'X-Moapp-Expected-User-Id': session.user.id, 'X-Moapp-Expected-Session-Id': session.currentSessionId }, body: JSON.stringify({ settings: { analyticsPeriod: 'week', ...blocks } }) })
  }, allBlocks)
}

export async function openApp(page, port) {
  await page.goto(`http://localhost:${port}/`)
  await page.waitForSelector('.entry-view .keypad', { timeout: 60_000 })
}

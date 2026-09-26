// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import * as screenBlocks from './screen-blocks'
import * as ui from './ui'
import * as workspaceApi from './workspace-api'
import * as workspaceOffline from './workspace-offline'
import type { AuthenticatedSession, WorkspaceBootstrap } from './types'

// «Аналитику» мемоизирует её собственный экран, поэтому здесь вместо неё мемоизированная заглушка: тесты смотрят
// на сторону приложения — сколько оно рендерит и меняются ли пропсы «Аналитики» от переключения вкладок.
const analytics = vi.hoisted(() => ({ renders: 0 }))
vi.mock('./screens/Analytics', async (importOriginal) => {
  const { createElement, memo } = await import('react')
  const AnalyticsView = memo(function AnalyticsView() {
    analytics.renders += 1
    return createElement('section', { className: 'page analytics' })
  })
  return { ...await importOriginal<typeof import('./screens/Analytics')>(), AnalyticsView }
})

const workspace = { id: 'workspace-a', name: 'Дом', role: 'owner' as const, version: 1, joinedAt: '2026-08-01T00:00:00.000Z' }
const session: AuthenticatedSession = { authenticated: true, user: { id: 'user-a', displayName: 'Аня', recoveryConfigured: true, recoveryGeneration: 1 }, currentSessionId: 'session-a', currentSessionExpiresAt: '2030-01-01T00:00:00.000Z', serverTime: '2026-08-10T14:00:00.000Z', restrictedToRecovery: false, workspaces: [workspace], legacyWorkspaceId: null, settings: {} }
const bootstrap: WorkspaceBootstrap = {
  workspaceId: workspace.id,
  workspace,
  categories: [{ id: 'products', name: 'Продукты', color: '#758d69', placement: 'main', sortOrder: 0, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', archivedAt: null, version: 1 }],
  currencies: [{ code: 'RSD', name: 'Сербский динар', symbol: 'дин.', decimals: 2 }],
  rates: { base: 'RSD', date: '2026-08-10', ratesToRsd: { RSD: 1 } },
  tags: [],
  expenses: [{ id: 'a', amountMinor: 1_000, currency: 'RSD', categoryId: 'products', note: null, tagIds: [], occurredAt: '2026-08-09T10:00:00.000Z', createdAt: '2026-08-09T10:00:00.000Z', updatedAt: '2026-08-09T10:00:00.000Z', version: 1, deletedAt: null }],
  defaultAnalyticsCurrency: 'RSD',
  serverTime: '2026-08-10T14:00:00.000Z',
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  workspaceApi.allowWorkspaceMutations(); workspaceApi.setSessionContext(null)
  for (const key of ['theme', 'accent', 'textSize', 'input']) delete document.documentElement.dataset[key]
})

// Целое приложение в jsdom: сеть и офлайн-хранилище подменены. Рендеры считаются по вызовам изнутри тела компонента:
// useInputModality зовёт только App, hiddenBlockCount — только «Настройки».
async function renderApp() {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
  // Без анимаций лента встаёт на вкладку сразу — как в браузере к концу плавной прокрутки.
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduced-motion'), media: query, addEventListener() {}, removeEventListener() {} }))
  await workspaceApi.probeServer()
  vi.spyOn(workspaceApi, 'getSession').mockResolvedValue(session)
  vi.spyOn(workspaceApi, 'getBootstrap').mockResolvedValue({ data: bootstrap, offline: false })
  vi.spyOn(workspaceApi, 'syncAllWorkspaces').mockResolvedValue(undefined)
  vi.spyOn(workspaceApi, 'listMods').mockResolvedValue([])
  vi.spyOn(workspaceApi, 'getCardQueueStatus').mockResolvedValue({ pendingCount: 0 })
  vi.spyOn(workspaceApi, 'listMembers').mockResolvedValue({ members: [] })
  vi.spyOn(workspaceApi, 'listSessions').mockResolvedValue({ sessions: [] })
  vi.spyOn(workspaceApi, 'listInvitations').mockResolvedValue({ invitations: [] })
  vi.spyOn(workspaceOffline, 'cacheProfile').mockResolvedValue(undefined)
  vi.spyOn(workspaceOffline, 'cacheBootstrap').mockResolvedValue(undefined)
  vi.spyOn(workspaceOffline, 'readCachedBootstrap').mockResolvedValue(undefined)
  vi.spyOn(workspaceOffline, 'readCachedProfile').mockResolvedValue(undefined)
  vi.spyOn(workspaceOffline, 'outboxStats').mockResolvedValue({ total: 0, conflicts: 0, failed: 0 })
  vi.spyOn(workspaceOffline, 'waitForWorkspaceOfflineWrites').mockResolvedValue(undefined)
  const appRenders = vi.spyOn(ui, 'useInputModality')
  const settingsRenders = vi.spyOn(screenBlocks, 'hiddenBlockCount')
  render(<App/>)
  await screen.findByRole('button', { name: 'Настройки' })
  // jsdom не раскладывает страницу: ширину ленты задаём сами, иначе обработчик прокрутки ничего не делает.
  Object.defineProperty(document.querySelector('.pager'), 'clientWidth', { configurable: true, value: 390 })
  return { appRenders, settingsRenders }
}

// Нажатие на вкладку: лента встаёт на её место, браузер присылает scroll, через 90 мс таймер проверяет, где она стоит.
async function tap(name: string) {
  fireEvent.click(screen.getByRole('button', { name }))
  fireEvent.scroll(document.querySelector('.pager')!)
  await act(() => new Promise((done) => setTimeout(done, 120)))
}

const TABS = ['История', 'Аналитика', 'Настройки', 'Расход']

describe('renders on a tab switch', () => {
  it('renders the app once per tap, and the pager settling on that tab adds nothing', async () => {
    const { appRenders } = await renderApp()
    // Первое открытие страницы — второй рендер: она монтируется в transition, не задерживая нажатие.
    for (const name of TABS) await tap(name)

    for (const name of TABS) {
      appRenders.mockClear()
      await tap(name)
      expect(appRenders, name).toHaveBeenCalledTimes(1)
    }
  })

  it('leaves «Настройки» and «Аналитика» alone while other tabs are picked', async () => {
    const { settingsRenders } = await renderApp()
    for (const name of TABS) await tap(name)
    expect(settingsRenders).toHaveBeenCalled()
    expect(analytics.renders).toBeGreaterThan(0)

    settingsRenders.mockClear(); analytics.renders = 0
    for (const name of [...TABS, 'История']) await tap(name)
    expect(settingsRenders).not.toHaveBeenCalled()
    expect(analytics.renders).toBe(0)
  })

  it('still shows a new theme and colour in the memoized «Настройки» right away', async () => {
    await renderApp()
    await tap('Настройки')
    const row = within(screen.getByRole('group', { name: 'Профиль' })).getByRole('button', { name: /^Внешний вид/ })
    expect(row.textContent).toBe('Внешний видшалфейный цвет, Как в системе')

    fireEvent.click(row)
    const sheet = screen.getByRole('dialog', { name: 'Внешний вид' })
    fireEvent.click(within(within(sheet).getByRole('group', { name: 'Тема' })).getByRole('button', { name: 'Тёмная' }))
    expect(row.textContent).toBe('Внешний видшалфейный цвет, Тёмная')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Цвет: голубой' }))
    expect(row.textContent).toBe('Внешний видголубой цвет, Тёмная')
  })
})

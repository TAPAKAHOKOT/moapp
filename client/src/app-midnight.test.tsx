// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import * as ui from './ui'
import * as workspaceApi from './workspace-api'
import * as workspaceOffline from './workspace-offline'
import type { AuthenticatedSession, WorkspaceBootstrap } from './types'

// Графики «Аналитики» в jsdom не рисуются: холст заменён пустым.
vi.mock('react-chartjs-2', async () => {
  const { createElement } = await import('react')
  const ChartMock = () => createElement('canvas')
  return { Bar: ChartMock, Doughnut: ChartMock, Line: ChartMock }
})

// Воскресенье, 23:58 по Белграду (тесты идут в Europe/Belgrade, летом это UTC+2), и понедельник, 00:05.
const SUNDAY_NIGHT = new Date('2026-08-16T21:58:00.000Z')
const MONDAY_MORNING = new Date('2026-08-16T22:05:00.000Z')

const workspace = { id: 'workspace-a', name: 'Дом', role: 'owner' as const, version: 1, joinedAt: '2026-08-01T00:00:00.000Z' }
const session: AuthenticatedSession = { authenticated: true, user: { id: 'user-a', displayName: 'Аня', recoveryConfigured: true, recoveryGeneration: 1 }, currentSessionId: 'session-a', currentSessionExpiresAt: '2030-01-01T00:00:00.000Z', serverTime: '2026-08-16T21:00:00.000Z', restrictedToRecovery: false, workspaces: [workspace], legacyWorkspaceId: null, settings: { entryBlocks: { shown: ['today', 'keypad', 'tiles', 'note', 'tags'], hidden: ['usual'] } } }
const bootstrap: WorkspaceBootstrap = {
  workspaceId: workspace.id,
  workspace,
  categories: [{ id: 'products', name: 'Продукты', color: '#758d69', placement: 'main', sortOrder: 0, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', archivedAt: null, version: 1 }],
  currencies: [{ code: 'RSD', name: 'Сербский динар', symbol: 'дин.', decimals: 2 }],
  rates: { base: 'RSD', date: '2026-08-16', ratesToRsd: { RSD: 1 } },
  tags: [],
  // Трата в воскресенье в 23:00 — «сегодня» до полуночи и «вчера» после.
  expenses: [{ id: 'a', amountMinor: 1_000, currency: 'RSD', categoryId: 'products', note: null, tagIds: [], occurredAt: '2026-08-16T21:00:00.000Z', createdAt: '2026-08-16T21:00:00.000Z', updatedAt: '2026-08-16T21:00:00.000Z', version: 1, deletedAt: null }],
  defaultAnalyticsCurrency: 'RSD',
  serverTime: '2026-08-16T21:00:00.000Z',
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  workspaceApi.allowWorkspaceMutations(); workspaceApi.setSessionContext(null)
  for (const key of ['theme', 'accent', 'textSize', 'input']) delete document.documentElement.dataset[key]
})

// Целое приложение в jsdom с настоящими экранами: сеть и офлайн-хранилище подменены, сервер аналитики не отвечает.
async function renderApp(data: WorkspaceBootstrap = bootstrap) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduced-motion'), media: query, addEventListener() {}, removeEventListener() {} }))
  await workspaceApi.probeServer()
  vi.spyOn(workspaceApi, 'getSession').mockResolvedValue(session)
  vi.spyOn(workspaceApi, 'getBootstrap').mockResolvedValue({ data, offline: false })
  vi.spyOn(workspaceApi, 'getAnalytics').mockRejectedValue(new Error('offline'))
  vi.spyOn(workspaceApi, 'syncAllWorkspaces').mockResolvedValue(undefined)
  vi.spyOn(workspaceApi, 'listMods').mockResolvedValue([])
  vi.spyOn(workspaceApi, 'getCardQueueStatus').mockResolvedValue({ pendingCount: 0 })
  vi.spyOn(workspaceOffline, 'cacheProfile').mockResolvedValue(undefined)
  vi.spyOn(workspaceOffline, 'cacheBootstrap').mockResolvedValue(undefined)
  vi.spyOn(workspaceOffline, 'readCachedBootstrap').mockResolvedValue(undefined)
  vi.spyOn(workspaceOffline, 'readCachedProfile').mockResolvedValue(undefined)
  vi.spyOn(workspaceOffline, 'outboxStats').mockResolvedValue({ total: 0, conflicts: 0, failed: 0 })
  vi.spyOn(workspaceOffline, 'waitForWorkspaceOfflineWrites').mockResolvedValue(undefined)
  // Рендеры приложения считаются по useInputModality: его зовёт только App.
  const appRenders = vi.spyOn(ui, 'useInputModality')
  render(<App/>)
  await screen.findByRole('button', { name: 'Настройки' })
  Object.defineProperty(document.querySelector('.pager'), 'clientWidth', { configurable: true, value: 390 })
  return { appRenders }
}

async function tap(name: string) {
  fireEvent.click(screen.getByRole('button', { name }))
  fireEvent.scroll(document.querySelector('.pager')!)
  await act(() => new Promise((done) => setTimeout(done, 120)))
}

const todayLine = () => document.querySelector('.entry-today')?.textContent
const week = () => document.querySelector('.analytics .week-navigator div')?.textContent

describe('the day turning over midnight', () => {
  it('moves «Сегодня» and the current week of «Аналитика» to the new day once the app checks its calendar', async () => {
    vi.setSystemTime(SUNDAY_NIGHT)
    const { appRenders } = await renderApp()
    await tap('Аналитика')
    expect(week()).toBe('Текущая неделя10–16 августа')
    await tap('Расход')
    expect(todayLine()).toMatch(/^Сегодня.*1 трата$/)

    // Приложение простояло открытым за полночь; телефон вернули в руку — страница снова видна.
    vi.setSystemTime(MONDAY_MORNING)
    appRenders.mockClear()
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(todayLine()).toBe('Сегодня трат ещё нет')
    // Новый день будит приложение один раз, следующая проверка в тот же день — уже нет.
    expect(appRenders).toHaveBeenCalledTimes(1)
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(appRenders).toHaveBeenCalledTimes(1)

    await tap('Аналитика')
    expect(week()).toBe('Текущая неделя17–23 августа')
  })

  it('moves the «Сегодня» filter of «История» to the new day as well', async () => {
    vi.setSystemTime(SUNDAY_NIGHT)
    // Фильтр «Сегодня» сохранён в настройках человека в пространстве.
    await renderApp({ ...bootstrap, settings: { historyFilters: { period: 'today', categoryIds: [], tagIds: [], currencies: [], from: '2026-08-01', to: '2026-08-16' } } })
    await tap('История')
    expect(document.querySelectorAll('.history-expense')).toHaveLength(1)

    vi.setSystemTime(MONDAY_MORNING)
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(document.querySelectorAll('.history-expense')).toHaveLength(0)
    expect(screen.getByText('Ничего не найдено')).toBeTruthy()
  })
})

// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import type { CanvasHTMLAttributes, ReactNode } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import AnalyticsChart from './AnalyticsCharts'
import { formatAnalyticsAmount } from './format'
import { AnalyticsView } from './screens/Analytics'
import type { Expense, WorkspaceBootstrap } from './types'

type ChartMockProps = CanvasHTMLAttributes<HTMLCanvasElement> & { data: { labels?: unknown; datasets?: unknown }; options?: unknown; fallbackContent?: ReactNode }

// Мок ведёт себя как обёртка react-chartjs-2: она зовёт chart.update() — и Chart.js четверть секунды анимирует
// график, — когда между рендерами сменились options, data.labels или data.datasets. Мок считает свои рендеры
// и такие обновления (по названию графика).
const drawn = vi.hoisted(() => ({ renders: 0, updates: [] as string[] }))
vi.mock('react-chartjs-2', async () => {
  const { useEffect, useRef } = await import('react')
  function ChartMock({ data, options, fallbackContent, ...canvas }: ChartMockProps) {
    drawn.renders += 1
    const mounted = useRef(false)
    useEffect(() => {
      if (mounted.current) drawn.updates.push(String(canvas['aria-label']))
      mounted.current = true
    }, [options, data.labels, data.datasets])
    return <canvas {...canvas}>{fallbackContent}</canvas>
  }
  return { Bar: ChartMock, Doughnut: ChartMock, Line: ChartMock }
})

const TREND = 'Динамика расходов в валюте RSD'
const DOUGHNUT = 'Расходы по категориям в валюте RSD'

function forget() {
  drawn.renders = 0
  drawn.updates.length = 0
}

const now = new Date().toISOString()

function spent(id: string, amountMinor: number, categoryId = 'products', tagIds: string[] = [], occurredAt = now): Expense {
  return { id, amountMinor, currency: 'RSD', categoryId, note: null, tagIds, occurredAt, createdAt: occurredAt, updatedAt: occurredAt, version: 1, deletedAt: null }
}

function workspace(expenses: Expense[], overrides: Partial<WorkspaceBootstrap> = {}): WorkspaceBootstrap {
  const at = '2026-08-01T00:00:00.000Z'
  const summary = { id: 'workspace-a', name: 'Дом', role: 'owner' as const, version: 1, joinedAt: at }
  return {
    workspaceId: summary.id,
    workspace: summary,
    categories: [
      { id: 'products', name: 'Продукты', color: '#758d69', placement: 'main', sortOrder: 0, createdAt: at, updatedAt: at, archivedAt: null, version: 1 },
      { id: 'home', name: 'Для дома', color: '#b08a5a', placement: 'main', sortOrder: 1, createdAt: at, updatedAt: at, archivedAt: null, version: 1 },
    ],
    tags: [{ id: 'tag-coffee', name: 'кофе', color: null, sortOrder: 0, createdAt: at, updatedAt: at, version: 1 }],
    currencies: [{ code: 'RSD', name: 'Сербский динар', symbol: 'дин.', decimals: 2 }, { code: 'EUR', name: 'Евро', symbol: '€', decimals: 2 }],
    rates: { base: 'RSD', date: now.slice(0, 10), ratesToRsd: { RSD: 1, EUR: 117 } },
    expenses,
    defaultAnalyticsCurrency: 'RSD',
    serverTime: at,
    ...overrides,
  }
}

const historyFilters = { categoryIds: ['home'], tagIds: [], currencies: [], period: 'all' as const, from: now.slice(0, 8) + '01', to: now.slice(0, 10) }

// Колбэки у приложения стабильны — так же и здесь: иначе экран перерисовывался бы от новых функций.
const props = { userId: 'user-a', workspaceId: 'workspace-a', setBootstrap: () => {}, theme: 'light' as const, online: false, onEditScreen: () => {}, onScreensChange: () => {} }

// Экран читает список расходов на каждом своём рендере: по числу чтений видно, рисовался ли он.
function watched(data: WorkspaceBootstrap) {
  const reads = { count: 0 }
  const { expenses, ...rest } = data
  const bootstrap = Object.defineProperty(rest, 'expenses', { enumerable: true, get() { reads.count += 1; return expenses } }) as WorkspaceBootstrap
  return { bootstrap, reads }
}

// Кадры анимации идут только по команде теста: так видно, что рисуется на каждом из них.
const frames = new Map<number, FrameRequestCallback>()
let lastFrame = 0
let elapsed = 0

function nextFrame() {
  elapsed += 16
  const due = [...frames.values()]
  frames.clear()
  act(() => { for (const callback of due) callback(performance.now() + elapsed) })
}

beforeAll(async () => {
  // Графики грузятся отдельным куском: один раз дождавшись его, дальше экран рисует их сразу.
  render(<AnalyticsView {...props} bootstrap={workspace([spent('warm-up', 100_000)])}/>)
  await screen.findAllByRole('img', { name: TREND })
  cleanup()
})

beforeEach(() => {
  forget()
  frames.clear()
  elapsed = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++lastFrame, callback); return lastFrame })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('chart redraws', () => {
  const line = { kind: 'line' as const, labels: ['пн', 'вт'], values: [1200, 350], color: '#758d69', fillColor: 'rgba(117,141,105,.12)', pointRadius: 3, target: 'RSD', textColor: '#73776f', gridColor: 'rgba(32,37,31,.06)', maxTicksLimit: 7 }
  const doughnut = { kind: 'doughnut' as const, labels: ['Продукты', 'Для дома'], values: [100, 50], colors: ['#758d69', '#b08a5a'], target: 'RSD' }
  const bar = { kind: 'bar' as const, labels: ['Пн', 'Вт'], values: [50, 75], color: '#758d69', target: 'RSD', textColor: '#73776f', gridColor: 'rgba(32,37,31,.06)' }

  it('keeps a chart as it is when the same numbers come in new arrays', () => {
    const first = render(<AnalyticsChart {...line}/>)
    const second = render(<AnalyticsChart {...doughnut}/>)
    const third = render(<AnalyticsChart {...bar}/>)
    forget()
    first.rerender(<AnalyticsChart {...line} labels={[...line.labels]} values={[...line.values]}/>)
    second.rerender(<AnalyticsChart {...doughnut} labels={[...doughnut.labels]} values={[...doughnut.values]} colors={[...doughnut.colors]}/>)
    third.rerender(<AnalyticsChart {...bar} labels={[...bar.labels]} values={[...bar.values]}/>)
    expect(drawn.renders).toBe(0)
    expect(drawn.updates).toEqual([])
  })

  it('updates a chart once for new numbers, a new colour or another currency', () => {
    const { rerender } = render(<AnalyticsChart {...line}/>)
    forget()
    rerender(<AnalyticsChart {...line} values={[1200, 400]}/>)
    expect(drawn.updates).toEqual([TREND])
    rerender(<AnalyticsChart {...line} values={[1200, 400]} color="#b1cfa3"/>)
    expect(drawn.updates).toEqual([TREND, TREND])
    rerender(<AnalyticsChart {...line} values={[1200, 400]} color="#b1cfa3" target="EUR"/>)
    expect(drawn.updates).toEqual([TREND, TREND, 'Динамика расходов в валюте EUR'])
    expect(drawn.renders).toBe(3)
  })

  it('redraws no chart when «Аналитика» renders again with the same numbers', () => {
    const bootstrap = workspace([spent('a', 100_000), spent('b', 50_000, 'home', ['tag-coffee'])])
    const { rerender } = render(<AnalyticsView {...props} bootstrap={bootstrap}/>)
    // Линия, круг категорий и круг тегов.
    expect(screen.getAllByRole('img')).toHaveLength(3)
    forget()
    rerender(<AnalyticsView {...props} bootstrap={bootstrap}/>)
    // Фильтр «Истории» живёт в тех же данных пространства, но аналитики не касается.
    rerender(<AnalyticsView {...props} bootstrap={{ ...bootstrap, settings: { historyFilters } }}/>)
    expect(drawn.renders).toBe(0)
    expect(drawn.updates).toEqual([])
  })

  it('updates the charts for new expenses, another theme, accent or currency — and only those that change', () => {
    const bootstrap = workspace([spent('a', 100_000), spent('b', 50_000, 'home', ['tag-coffee'])])
    const { rerender } = render(<AnalyticsView {...props} bootstrap={bootstrap}/>)
    forget()
    const more = { ...bootstrap, expenses: [spent('c', 30_000), ...bootstrap.expenses] }
    rerender(<AnalyticsView {...props} bootstrap={more}/>)
    expect(drawn.updates.sort()).toEqual([TREND, DOUGHNUT, DOUGHNUT])

    // Цвет линии и тегов без своего цвета идёт от темы и акцента; у категорий цвет свой, и их круг не трогается.
    forget()
    rerender(<AnalyticsView {...props} bootstrap={more} theme="dark"/>)
    expect(drawn.updates.sort()).toEqual([TREND, DOUGHNUT])
    forget()
    rerender(<AnalyticsView {...props} bootstrap={more} theme="dark" accent="blue"/>)
    expect(drawn.updates.sort()).toEqual([TREND, DOUGHNUT])

    forget()
    rerender(<AnalyticsView {...props} bootstrap={{ ...more, settings: { analyticsCurrency: 'EUR' } }} theme="dark" accent="blue"/>)
    expect(drawn.updates.sort()).toEqual(['Динамика расходов в валюте EUR', 'Расходы по категориям в валюте EUR', 'Расходы по категориям в валюте EUR'])
  })
})

describe('analytics screen redraws', () => {
  // Вкладка смонтирована всё время, пока открыто пространство, а приложение перерисовывается от каждого касания.
  it('does not render again when the app renders with the same props', () => {
    const { bootstrap, reads } = watched(workspace([spent('a', 100_000)]))
    const { rerender } = render(<AnalyticsView {...props} bootstrap={bootstrap}/>)
    reads.count = 0
    rerender(<AnalyticsView {...props} bootstrap={bootstrap}/>)
    expect(reads.count).toBe(0)
    rerender(<AnalyticsView {...props} bootstrap={bootstrap} theme="dark"/>)
    expect(reads.count).toBeGreaterThan(0)
  })
})

describe('analytics total animation', () => {
  const header = (container: HTMLElement) => ({
    total: () => container.querySelector('.analytics-title h1')!.textContent!.replace(/\s/g, ' '),
    perDay: () => container.querySelector('.analytics-comparison')!.textContent!.replace(/\s/g, ' '),
  })

  it('moves only the numbers on each frame, while the screen and its charts draw once', () => {
    const first = workspace([spent('a', 100_000)])
    const { container, rerender } = render(<AnalyticsView {...props} bootstrap={first}/>)
    const { total, perDay } = header(container)
    // Первое значение — сразу, без анимации.
    expect(total()).toBe('1 000')
    const { bootstrap, reads } = watched({ ...first, expenses: [spent('b', 100_000), ...first.expenses] })
    forget()
    rerender(<AnalyticsView {...props} bootstrap={bootstrap}/>)
    const charts = drawn.renders
    expect(charts).toBeGreaterThan(0)
    reads.count = 0
    const totals = new Set<string>()
    const perDays = new Set<string>()
    for (let frame = 0; frame < 40 && frames.size; frame += 1) {
      nextFrame()
      totals.add(total())
      perDays.add(perDay())
    }
    // Сумма и строка «в день» доезжали кадр за кадром, а не прыгнули.
    expect(totals.size).toBeGreaterThan(5)
    expect(perDays.size).toBeGreaterThan(5)
    const days = (new Date().getDay() + 6) % 7 + 1
    expect(total()).toBe('2 000')
    expect(perDay()).toBe(`${formatAnalyticsAmount(2_000 / days, 'RSD')} в день · 2 операции`.replace(/\s/g, ' '))
    // На кадрах не рисовались ни экран, ни графики.
    expect(reads.count).toBe(0)
    expect(drawn.renders).toBe(charts)
  })

  it('shows the new total at once when the phone asks for less motion', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener: () => {}, removeEventListener: () => {} }))
    const first = workspace([spent('a', 100_000)])
    const { container, rerender } = render(<AnalyticsView {...props} bootstrap={first}/>)
    rerender(<AnalyticsView {...props} bootstrap={{ ...first, expenses: [spent('b', 100_000), ...first.expenses] }}/>)
    expect(header(container).total()).toBe('2 000')
    expect(frames.size).toBe(0)
  })
})

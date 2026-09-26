// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HISTORY_FIRST_ROWS, HISTORY_MORE_ROWS, HistoryView } from './screens/History'
import type { Expense, WorkspaceBootstrap } from './types'

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// Записи по нескольку в день, от свежих к старым: так в окно попадают и целые дни, и последний — частично.
function bootstrapWith(count: number): WorkspaceBootstrap {
  const workspace = { id: 'workspace-a', name: 'Дом', role: 'owner' as const, version: 1, joinedAt: '2026-01-01T00:00:00.000Z' }
  const start = Date.parse('2026-09-20T12:00:00.000Z')
  const expenses: Expense[] = Array.from({ length: count }, (_, index) => {
    const at = new Date(start - Math.floor(index / 3) * 86_400_000 - (index % 3) * 3_600_000).toISOString()
    return { id: `e${index}`, amountMinor: 1_000 + index, currency: 'RSD', categoryId: 'products', note: null, occurredAt: at, createdAt: at, updatedAt: at, version: 1, deletedAt: null }
  })
  return {
    workspaceId: workspace.id,
    workspace,
    categories: [{ id: 'products', name: 'Продукты', color: '#758d69', placement: 'main', sortOrder: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, version: 1 }],
    currencies: [{ code: 'RSD', name: 'Сербский динар', symbol: 'дин.', decimals: 2 }],
    rates: { base: 'RSD', date: '2026-09-20', ratesToRsd: { RSD: 1 } },
    tags: [],
    expenses,
    defaultAnalyticsCurrency: 'RSD',
    serverTime: '2026-09-20T14:00:00.000Z',
  }
}

const props = { userId: 'user-a', workspaceId: 'workspace-a', setBootstrap: vi.fn(), edit: vi.fn(), createNew: vi.fn(), refreshPending: vi.fn() }

// Поддельный IntersectionObserver: тест сам решает, когда отступ под нарисованными строками подошёл к экрану.
class FakeObserver {
  static live = new Set<FakeObserver>()
  targets = new Set<Element>()
  constructor(readonly callback: IntersectionObserverCallback, readonly options: IntersectionObserverInit = {}) {}
  observe(target: Element) { this.targets.add(target); FakeObserver.live.add(this) }
  unobserve(target: Element) { this.targets.delete(target) }
  disconnect() { this.targets.clear(); FakeObserver.live.delete(this) }
  takeRecords() { return [] }
}

function stubObserver() {
  FakeObserver.live.clear()
  vi.stubGlobal('IntersectionObserver', FakeObserver)
}

const reachRest = () => act(() => {
  for (const observer of [...FakeObserver.live]) {
    const entries = [...observer.targets].map((target) => ({ target, isIntersecting: true, intersectionRatio: 1, boundingClientRect: target.getBoundingClientRect(), intersectionRect: target.getBoundingClientRect(), rootBounds: null, time: 0 }))
    observer.callback(entries as unknown as IntersectionObserverEntry[], observer as unknown as IntersectionObserver)
  }
})

const rows = (container: HTMLElement) => container.querySelectorAll('.history-expense').length

describe('history window', () => {
  it('draws the first rows, keeps room for the rest and adds more as the rest comes near', () => {
    stubObserver()
    const { container } = render(<HistoryView {...props} bootstrap={bootstrapWith(400)}/>)

    expect(rows(container)).toBe(HISTORY_FIRST_ROWS)
    expect(container.querySelector('.history-rest')).not.toBeNull()
    // Итог и счётчик считаются по всем записям, а не по нарисованным.
    expect(container.querySelector('.history-total-line')?.textContent).toContain('400 записей')

    reachRest()
    expect(rows(container)).toBe(HISTORY_FIRST_ROWS + HISTORY_MORE_ROWS)
    reachRest()
    expect(rows(container)).toBe(400)
    expect(container.querySelector('.history-rest')).toBeNull()
  })

  it('watches for the rest from the page it scrolls in, two screens ahead', () => {
    stubObserver()
    const { container } = render(<div className="page-slot"><HistoryView {...props} bootstrap={bootstrapWith(300)}/></div>)
    const [observer] = [...FakeObserver.live]
    expect(observer?.options.root).toBe(container.querySelector('.page-slot'))
    expect(observer?.options.rootMargin).toMatch(/ 200% 0px$/)
    expect([...observer!.targets]).toEqual([container.querySelector('.history-rest')])
  })

  it('goes back to the first rows when a filter or the search changes', () => {
    stubObserver()
    const { container } = render(<HistoryView {...props} bootstrap={bootstrapWith(400)}/>)
    reachRest()
    expect(rows(container)).toBe(HISTORY_FIRST_ROWS + HISTORY_MORE_ROWS)

    // Код валюты есть в тексте каждой записи: поиск оставляет все 400, но окно начинается сначала.
    fireEvent.click(screen.getByRole('button', { name: 'Поиск' }))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'rsd' } })
    expect(rows(container)).toBe(HISTORY_FIRST_ROWS)
    expect(container.querySelector('.history-total-line')?.textContent).toContain('400 записей')
  })

  it('draws every row where IntersectionObserver is missing', () => {
    const { container } = render(<HistoryView {...props} bootstrap={bootstrapWith(400)}/>)
    expect(rows(container)).toBe(400)
    expect(container.querySelector('.history-rest')).toBeNull()
  })

  it('keeps the strip of older records after the rest, seen only at the very end', () => {
    stubObserver()
    const { container } = render(<HistoryView {...props} bootstrap={bootstrapWith(300)} older={{ count: 12, since: '2025-09-01', busy: false, load: vi.fn() }}/>)
    const order = [...container.querySelector('.history-page')!.children].map((node) => node.className)
    expect(order.slice(order.indexOf('history-list'))).toEqual(['history-list', 'history-rest', 'history-older'])
  })

  it('drops the extra rows once the tab is left near its top, and keeps them when left deep in the list', async () => {
    stubObserver()
    vi.useFakeTimers()
    const { container } = render(<div className="pager"><div className="page-slot"><HistoryView {...props} bootstrap={bootstrapWith(400)}/></div></div>)
    const slot = container.querySelector<HTMLElement>('.page-slot')!
    reachRest()
    expect(rows(container)).toBe(HISTORY_FIRST_ROWS + HISTORY_MORE_ROWS)

    // Ушли далеко вниз: окно остаётся, чтобы вернуться на то же место.
    Object.defineProperty(slot, 'scrollTop', { configurable: true, value: 5_000 })
    await act(async () => { slot.setAttribute('inert', '') })
    act(() => vi.advanceTimersByTime(2_000))
    expect(rows(container)).toBe(HISTORY_FIRST_ROWS + HISTORY_MORE_ROWS)

    await act(async () => { slot.removeAttribute('inert') })
    Object.defineProperty(slot, 'scrollTop', { configurable: true, value: 0 })
    await act(async () => { slot.setAttribute('inert', '') })
    // Пока лента вкладок едет, строки не снимаются: перерисовка посреди анимации стоила бы кадра.
    act(() => vi.advanceTimersByTime(300))
    fireEvent.scroll(container.querySelector('.pager')!)
    act(() => vi.advanceTimersByTime(300))
    expect(rows(container)).toBe(HISTORY_FIRST_ROWS + HISTORY_MORE_ROWS)
    act(() => vi.advanceTimersByTime(2_000))
    expect(rows(container)).toBe(HISTORY_FIRST_ROWS)
  })
})

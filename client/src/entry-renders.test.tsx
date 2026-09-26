// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EntryView } from './screens/Entry'
import type { BlockLayout, Expense, WorkspaceBootstrap } from './types'

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function bootstrapWith(expenses: Expense[], overrides: Partial<WorkspaceBootstrap> = {}): WorkspaceBootstrap {
  const workspace = { id: 'workspace-a', name: 'Дом', role: 'owner' as const, version: 1, joinedAt: '2026-08-01T00:00:00.000Z' }
  return {
    workspaceId: workspace.id,
    workspace,
    categories: [{ id: 'products', name: 'Продукты', color: '#758d69', placement: 'main', sortOrder: 0, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', archivedAt: null, version: 1 }],
    currencies: [{ code: 'RSD', name: 'Сербский динар', symbol: 'дин.', decimals: 2 }],
    rates: { base: 'RSD', date: '2026-08-10', ratesToRsd: { RSD: 1 } },
    tags: [],
    expenses,
    defaultAnalyticsCurrency: 'RSD',
    serverTime: '2026-08-10T14:00:00.000Z',
    ...overrides,
  }
}

// Время и теги записи читает всякий, кто перебирает расходы: по числу чтений видно, пересчитывал ли кто-то весь список.
function countedExpenses(count: number, reads: { occurredAt: number; tagIds: number }) {
  return Array.from({ length: count }, (_, index) => {
    const at = new Date(Date.now() - index * 3_600_000).toISOString()
    const expense = { id: `e${index}`, amountMinor: 1_000, currency: 'RSD', categoryId: 'products', note: null, createdAt: at, updatedAt: at, version: 1, deletedAt: null }
    Object.defineProperty(expense, 'occurredAt', { enumerable: true, get: () => { reads.occurredAt += 1; return at } })
    Object.defineProperty(expense, 'tagIds', { enumerable: true, get: () => { reads.tagIds += 1; return [] } })
    return expense as Expense
  })
}

const stable = { userId: 'user-a', workspaceId: 'workspace-a', setBootstrap: vi.fn(), setCurrentId: vi.fn(), refreshPending: vi.fn(), onDraftDirtyChange: vi.fn(), onEditScreen: vi.fn(), onScreensChange: vi.fn() }

function entry(bootstrap: WorkspaceBootstrap, blocks: BlockLayout) {
  return <EntryView {...stable} workspace={bootstrap.workspace} bootstrap={bootstrap} currentId={null} active blocks={blocks}/>
}

describe('«Сегодня» and «Как обычно» on «Расход»', () => {
  it('does not recount «Сегодня» over every expense on a keypad press', () => {
    const reads = { occurredAt: 0, tagIds: 0 }
    const { container } = render(entry(bootstrapWith(countedExpenses(40, reads)), { shown: ['today', 'keypad', 'tiles', 'note', 'tags'], hidden: ['usual'] }))
    expect(container.querySelector('.entry-today')?.textContent).toMatch(/^Сегодня\d/)
    reads.occurredAt = 0
    fireEvent.click(screen.getByRole('button', { name: '7' }))
    fireEvent.click(screen.getByRole('button', { name: '5' }))
    expect(container.querySelector('.entry-card:not(.aside) .amount-value')?.textContent).toBe('75')
    expect(reads.occurredAt).toBeLessThan(5)
  })

  it('shows the same «Сегодня» in the swipe preview without counting it again', () => {
    const reads = { occurredAt: 0, tagIds: 0 }
    const { container } = render(entry(bootstrapWith(countedExpenses(40, reads)), { shown: ['keypad', 'tiles', 'today', 'note', 'tags'], hidden: ['usual'] }))
    reads.occurredAt = 0
    const section = screen.getByRole('region', { name: 'Ввод суммы' })
    fireEvent.pointerDown(section, { pointerType: 'mouse', button: 0, clientX: 100, clientY: 20 })
    fireEvent.pointerMove(section, { pointerType: 'mouse', clientX: 180, clientY: 20 })
    const live = container.querySelector('.entry-lower-live .entry-today')
    const preview = container.querySelector('.entry-lower-preview .entry-today')
    expect(preview?.textContent).toMatch(/^Сегодня\d/)
    expect(preview?.textContent).toBe(live?.textContent)
    expect(reads.occurredAt).toBeLessThan(5)
  })

  it('works out «Как обычно» only while the block is on the screen', () => {
    const reads = { occurredAt: 0, tagIds: 0 }
    const expenses = countedExpenses(40, reads)
    const off = { shown: ['keypad', 'tiles', 'note', 'tags'], hidden: ['today', 'usual'] }
    const { container, rerender } = render(entry(bootstrapWith(expenses), off))
    rerender(entry(bootstrapWith([...expenses]), off))
    expect(reads.tagIds).toBeLessThan(5)
    rerender(entry(bootstrapWith([...expenses]), { shown: ['usual', 'keypad', 'tiles', 'note', 'tags'], hidden: ['today'] }))
    expect(reads.tagIds).toBeGreaterThanOrEqual(40)
    expect(container.querySelector('.entry-usual')?.textContent).toBe('10Продукты')
  })
})

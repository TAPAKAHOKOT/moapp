import { describe, expect, it } from 'vitest'
import { buildHistoryCsv, defaultHistoryPreferences, filterHistoryExpenses, historyDateRange, historyTotals, parseHistoryPreferences, type HistoryFilters } from './history'
import type { Category, Currency, Expense, RateSnapshot, Tag } from './types'

const categories: Category[] = [
  { id: 'food', name: 'Еда', color: '#758d69', placement: 'main', sortOrder: 0, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', archivedAt: null, version: 1 },
  { id: 'transport', name: 'Транспорт', color: '#826f62', placement: 'main', sortOrder: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', archivedAt: null, version: 1 },
]
const currencies: Currency[] = [
  { code: 'RSD', name: 'Сербский динар', symbol: 'дин.', decimals: 2 },
  { code: 'EUR', name: 'Евро', symbol: '€', decimals: 2 },
]
const tags: Tag[] = [
  { id: 'trip', name: 'Поездка', color: '#819978', sortOrder: 0, version: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' },
  { id: 'work', name: 'Работа', color: null, sortOrder: 1, version: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' },
]
const expenses: Expense[] = [
  { id: 'monday-food', amountMinor: 1_234, currency: 'RSD', categoryId: 'food', note: 'Обед, кофе', tagIds: ['work', 'trip'], occurredAt: '2026-08-24T10:00:00.000Z', createdAt: '2026-08-24T10:00:00.000Z', updatedAt: '2026-08-24T10:00:00.000Z', version: 1, deletedAt: null },
  { id: 'sunday-transport', amountMinor: 2_000, currency: 'RSD', categoryId: 'transport', note: null, occurredAt: '2026-08-30T20:00:00.000Z', createdAt: '2026-08-30T20:00:00.000Z', updatedAt: '2026-08-30T20:00:00.000Z', version: 1, deletedAt: null },
  { id: 'next-week-food', amountMinor: 5_000, currency: 'RSD', categoryId: 'food', note: null, occurredAt: '2026-08-31T10:00:00.000Z', createdAt: '2026-08-31T10:00:00.000Z', updatedAt: '2026-08-31T10:00:00.000Z', version: 1, deletedAt: null },
  { id: 'eur-food', amountMinor: 750, currency: 'EUR', categoryId: 'food', note: null, occurredAt: '2026-09-01T10:00:00.000Z', createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-01T10:00:00.000Z', version: 1, deletedAt: null },
  { id: 'deleted', amountMinor: 100, currency: 'RSD', categoryId: 'food', note: null, occurredAt: '2026-08-30T12:00:00.000Z', createdAt: '2026-08-30T12:00:00.000Z', updatedAt: '2026-08-30T12:00:00.000Z', version: 2, deletedAt: '2026-09-01T00:00:00.000Z' },
]

function filters(overrides: Partial<HistoryFilters> = {}): HistoryFilters {
  return { categoryId: '', tagId: '', currency: '', period: 'all', date: '2026-08-30', from: '', to: '', ...overrides }
}

describe('history filters', () => {
  it('filters by category and Belgrade calendar day', () => {
    expect(filterHistoryExpenses(expenses, filters({ categoryId: 'transport', period: 'day' })).map((expense) => expense.id)).toEqual(['sunday-transport'])
  })

  it('uses Monday through Sunday for a selected week', () => {
    expect(historyDateRange(filters({ period: 'week' }))).toEqual({ from: '2026-08-24', to: '2026-08-30' })
    expect(filterHistoryExpenses(expenses, filters({ period: 'week' })).map((expense) => expense.id)).toEqual(['sunday-transport', 'monday-food'])
  })

  it('accepts an interval entered in either order', () => {
    expect(filterHistoryExpenses(expenses, filters({ period: 'range', from: '2026-08-31', to: '2026-08-30' })).map((expense) => expense.id)).toEqual(['next-week-food', 'sunday-transport'])
  })

  it('filters by a tag and treats expenses without tags as untagged', () => {
    expect(filterHistoryExpenses(expenses, filters({ tagId: 'trip' })).map((expense) => expense.id)).toEqual(['monday-food'])
    expect(filterHistoryExpenses(expenses, filters({ tagId: 'missing' }))).toEqual([])
  })

  it('filters by the expense currency', () => {
    expect(filterHistoryExpenses(expenses, filters({ currency: 'EUR' })).map((expense) => expense.id)).toEqual(['eur-food'])
  })

  it('restores valid saved preferences and ignores malformed storage', () => {
    const saved = parseHistoryPreferences(JSON.stringify({ query: 'кофе', categoryId: 'food', currency: 'EUR', period: 'range', date: '2026-08-30', from: '2026-08-01', to: '2026-08-31' }), '2026-09-01')
    expect(saved).toEqual({ query: 'кофе', categoryId: 'food', tagId: '', currency: 'EUR', period: 'range', date: '2026-08-30', from: '2026-08-01', to: '2026-08-31' })
    expect(parseHistoryPreferences(JSON.stringify({ tagId: 'trip' }), '2026-09-01').tagId).toBe('trip')
    expect(parseHistoryPreferences('{broken', '2026-09-01')).toEqual(defaultHistoryPreferences('2026-09-01'))
  })
})

describe('history CSV export', () => {
  it('keeps exact decimal amounts and safely quotes notes', () => {
    const csv = buildHistoryCsv([expenses[0]!], categories, currencies, tags)
    expect(csv.split('\n')[0]).toBe('occurred_at,date,time,category,tags,amount,currency,note,id')
    expect(csv).toContain('2026-08-24,12:00,Еда,Поездка; Работа,12.34,RSD,"Обед, кофе",monday-food')
    expect(csv.split('\n')).toHaveLength(2)
    expect(buildHistoryCsv([expenses[1]!], categories, currencies, tags)).toContain('Транспорт,,20.00')
  })
})

describe('historyTotals', () => {
  const rates: RateSnapshot = { base: 'RSD', date: '2026-08-10', ratesToRsd: { RSD: 1, EUR: 117 } }
  const row = (id: string, amountMinor: number, currency: string): Expense => ({ id, amountMinor, currency, categoryId: 'food', note: null, occurredAt: '2026-08-24T10:00:00.000Z', createdAt: '2026-08-24T10:00:00.000Z', updatedAt: '2026-08-24T10:00:00.000Z', version: 1, deletedAt: null })

  it('sums a single currency exactly in minor units', () => {
    const totals = historyTotals([row('a', 1_000, 'RSD'), row('b', 2_550, 'RSD')], currencies, rates, 'RSD')
    expect(totals).toMatchObject({ byCurrency: [{ currency: 'RSD', amountMinor: 3_550 }], target: 'RSD', missing: [] })
    expect(totals.converted).toBeCloseTo(35.5)
  })

  it('converts a mixed set into the target currency and lists the parts largest first', () => {
    const totals = historyTotals([row('a', 1_000, 'RSD'), row('b', 2_000, 'EUR')], currencies, rates, 'RSD')
    expect(totals.byCurrency).toEqual([{ currency: 'EUR', amountMinor: 2_000 }, { currency: 'RSD', amountMinor: 1_000 }])
    expect(totals.converted).toBeCloseTo(10 + 20 * 117)
  })

  it('names currencies without a rate instead of guessing a total', () => {
    const totals = historyTotals([row('a', 1_000, 'RSD'), row('b', 500, 'USD')], currencies, rates, 'RSD')
    expect(totals.missing).toEqual(['USD'])
    expect(totals.converted).toBeNull()
  })
})

describe('relative history periods', () => {
  const filters = (period: HistoryFilters['period']): HistoryFilters => ({ categoryId: '', tagId: '', currency: '', period, date: '', from: '', to: '' })

  it('derives presets from the given day', () => {
    expect(historyDateRange(filters('today'), '2026-09-03')).toEqual({ from: '2026-09-03', to: '2026-09-03' })
    expect(historyDateRange(filters('yesterday'), '2026-09-03')).toEqual({ from: '2026-09-02', to: '2026-09-02' })
    expect(historyDateRange(filters('this-week'), '2026-09-03')).toEqual({ from: '2026-08-31', to: '2026-09-06' })
    expect(historyDateRange(filters('last-week'), '2026-09-03')).toEqual({ from: '2026-08-24', to: '2026-08-30' })
    expect(historyDateRange(filters('this-month'), '2026-09-03')).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    expect(historyDateRange(filters('last-month'), '2026-09-03')).toEqual({ from: '2026-08-01', to: '2026-08-31' })
  })

  it('applies a preset to the expense list and keeps it after a reload', () => {
    expect(filterHistoryExpenses(expenses, filters('last-week'), '2026-09-03').map((expense) => expense.id)).toEqual(['sunday-transport', 'monday-food'])
    expect(parseHistoryPreferences(JSON.stringify({ period: 'last-week' }), '2026-09-03').period).toBe('last-week')
    expect(parseHistoryPreferences(JSON.stringify({ period: 'fortnight' }), '2026-09-03').period).toBe('all')
  })
})

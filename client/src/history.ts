import type { Category, Currency, Expense, RateSnapshot, Tag } from './types'
import { convertExpense, hasRate, localDateKey, monthDateRange, weekDateRange } from './utils'

// Относительные пресеты считаются от сегодняшнего дня при каждом применении, поэтому сохранённый фильтр не устаревает.
export const HISTORY_PERIODS = ['all', 'today', 'this-week', 'this-month', 'range'] as const
export type HistoryPeriod = typeof HISTORY_PERIODS[number]
export const HISTORY_PERIOD_LABELS: Record<HistoryPeriod, string> = {
  all: 'Все даты', today: 'Сегодня', 'this-week': 'Эта неделя', 'this-month': 'Этот месяц', range: 'Выбрать даты',
}

// Фильтры по категории, тегу и валюте принимают несколько значений: внутри одного фильтра — «или», между фильтрами — «и».
export type HistoryFilters = {
  categoryIds: string[]
  tagIds: string[]
  currencies: string[]
  period: HistoryPeriod
  from: string
  to: string
}

export type HistoryPreferences = HistoryFilters & { query: string }

export function defaultHistoryPreferences(today: string): HistoryPreferences {
  return { query: '', categoryIds: [], tagIds: [], currencies: [], period: 'all', from: `${today.slice(0, 8)}01`, to: today }
}

export function parseHistoryPreferences(raw: string | null, today: string): HistoryPreferences {
  const defaults = defaultHistoryPreferences(today)
  if (!raw) return defaults
  try {
    const saved = JSON.parse(raw) as Partial<Record<keyof HistoryPreferences | 'categoryId' | 'tagId' | 'currency', unknown>>
    const date = (value: unknown, fallback: string) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback
    const period = (HISTORY_PERIODS as readonly unknown[]).includes(saved.period) ? saved.period as HistoryPeriod : defaults.period
    // Старые настройки хранили одно значение строкой; оно становится списком из одного элемента.
    const ids = (list: unknown, single: unknown, valid: (value: string) => boolean) => {
      const raw = Array.isArray(list) ? list : typeof single === 'string' && single ? [single] : []
      return [...new Set(raw.filter((value): value is string => typeof value === 'string' && value.length > 0 && valid(value)))].slice(0, 50)
    }
    return {
      query: typeof saved.query === 'string' ? saved.query.slice(0, 200) : defaults.query,
      categoryIds: ids(saved.categoryIds, saved.categoryId, (value) => value.length <= 100),
      tagIds: ids(saved.tagIds, saved.tagId, (value) => value.length <= 100),
      currencies: ids(saved.currencies, saved.currency, (value) => /^[A-Z]{3}$/.test(value)),
      period,
      from: date(saved.from, defaults.from),
      to: date(saved.to, defaults.to),
    }
  } catch {
    return defaults
  }
}

export function historyDateRange(filters: HistoryFilters, today = localDateKey(new Date())): { from?: string; to?: string } {
  if (filters.period === 'today') return { from: today, to: today }
  if (filters.period === 'this-week') return weekDateRange(today)
  if (filters.period === 'this-month') return monthDateRange(today)
  if (filters.period !== 'range') return {}
  if (filters.from && filters.to && filters.from > filters.to) return { from: filters.to, to: filters.from }
  return { from: filters.from || undefined, to: filters.to || undefined }
}

export function filterHistoryExpenses(expenses: Expense[], filters: HistoryFilters, today = localDateKey(new Date())) {
  const { from, to } = historyDateRange(filters, today)
  return expenses.filter((expense) => {
    if (expense.deletedAt) return false
    if (filters.categoryIds.length && !filters.categoryIds.includes(expense.categoryId)) return false
    if (filters.tagIds.length && !(expense.tagIds ?? []).some((id) => filters.tagIds.includes(id))) return false
    if (filters.currencies.length && !filters.currencies.includes(expense.currency)) return false
    const date = localDateKey(expense.occurredAt)
    return (!from || date >= from) && (!to || date <= to)
  }).sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
}

// Имена тегов расхода в стабильном порядке — для строки истории, поиска и экспорта.
export function expenseTagNames(expense: Pick<Expense, 'tagIds'>, tags: Tag[]) {
  const byId = new Map(tags.map((tag) => [tag.id, tag.name]))
  return (expense.tagIds ?? []).map((id) => byId.get(id)).filter((name): name is string => Boolean(name)).sort((left, right) => left.localeCompare(right, 'ru-RU'))
}

function decimalAmount(amountMinor: number, decimals: number) {
  const sign = amountMinor < 0 ? '-' : ''
  const digits = String(Math.abs(amountMinor)).padStart(decimals + 1, '0')
  if (!decimals) return `${sign}${digits}`
  return `${sign}${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`
}

function csvCell(value: string | number) {
  const text = String(value).replace(/\r\n?|\n/g, ' ')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function buildHistoryCsv(expenses: Expense[], categories: Category[], currencies: Currency[], tags: Tag[] = []) {
  const categoryMap = new Map(categories.map((category) => [category.id, category.name]))
  const decimals = new Map(currencies.map((currency) => [currency.code, currency.decimals]))
  const rows = expenses.map((expense) => {
    const date = localDateKey(expense.occurredAt)
    const time = new Date(expense.occurredAt).toLocaleTimeString('en-GB', {
      timeZone: 'Europe/Belgrade', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    })
    return [
      expense.occurredAt,
      date,
      time,
      categoryMap.get(expense.categoryId) ?? 'Архивная категория',
      expenseTagNames(expense, tags).join('; '),
      decimalAmount(expense.amountMinor, decimals.get(expense.currency) ?? 2),
      expense.currency,
      expense.note ?? '',
      expense.voidedAt ? (expense.voidReason?.kind ?? 'declined') : 'counted',
      expense.id,
    ].map(csvCell).join(',')
  })
  return ['occurred_at,date,time,category,tags,amount,currency,note,status,id', ...rows].join('\n')
}

export type HistoryTotals = {
  /** Sums per original currency, largest first. */
  byCurrency: { currency: string; amountMinor: number }[]
  /** Everything converted into the target currency, or null when a rate is missing. */
  converted: number | null
  target: string
  missing: string[]
}

// Итог по показанным записям: в одной валюте — точная сумма, в нескольких — пересчёт по курсам снимка.
export function historyTotals(shown: Expense[], currencies: Currency[], rates: RateSnapshot, target: string): HistoryTotals {
  // Declined/reversed provider operations stay visible but never count.
  const expenses = shown.filter((expense) => !expense.voidedAt)
  const byCurrency = new Map<string, number>()
  for (const expense of expenses) byCurrency.set(expense.currency, (byCurrency.get(expense.currency) ?? 0) + expense.amountMinor)
  const missing = [...new Set(expenses.filter((expense) => !hasRate(rates, expense.currency, target, localDateKey(expense.occurredAt))).map((expense) => expense.currency))].sort()
  const converted = missing.length ? null : expenses.reduce((sum, expense) => sum + convertExpense(expense, target, currencies, rates), 0)
  return {
    byCurrency: [...byCurrency].map(([currency, amountMinor]) => ({ currency, amountMinor })).sort((left, right) => right.amountMinor - left.amountMinor || left.currency.localeCompare(right.currency)),
    converted,
    target,
    missing,
  }
}

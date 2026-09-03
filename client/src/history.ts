import type { Category, Currency, Expense, RateSnapshot, Tag } from './types'
import { convertExpense, localDateKey, monthDateRange, shiftDateKey, weekDateRange } from './utils'

// Относительные пресеты считаются от сегодняшнего дня при каждом применении, поэтому сохранённый фильтр не устаревает.
export const HISTORY_PERIODS = ['all', 'today', 'yesterday', 'this-week', 'last-week', 'this-month', 'last-month', 'day', 'week', 'range'] as const
export type HistoryPeriod = typeof HISTORY_PERIODS[number]
export const HISTORY_PERIOD_LABELS: Record<HistoryPeriod, string> = {
  all: 'Все даты', today: 'Сегодня', yesterday: 'Вчера', 'this-week': 'Эта неделя', 'last-week': 'Прошлая неделя',
  'this-month': 'Этот месяц', 'last-month': 'Прошлый месяц', day: 'Выбрать день', week: 'Выбрать неделю', range: 'Интервал',
}

export type HistoryFilters = {
  categoryId: string
  tagId: string
  currency: string
  period: HistoryPeriod
  date: string
  from: string
  to: string
}

export type HistoryPreferences = HistoryFilters & { query: string }

export function defaultHistoryPreferences(today: string): HistoryPreferences {
  return { query: '', categoryId: '', tagId: '', currency: '', period: 'all', date: today, from: `${today.slice(0, 8)}01`, to: today }
}

export function parseHistoryPreferences(raw: string | null, today: string): HistoryPreferences {
  const defaults = defaultHistoryPreferences(today)
  if (!raw) return defaults
  try {
    const saved = JSON.parse(raw) as Partial<Record<keyof HistoryPreferences, unknown>>
    const date = (value: unknown, fallback: string) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback
    const period = (HISTORY_PERIODS as readonly unknown[]).includes(saved.period) ? saved.period as HistoryPeriod : defaults.period
    return {
      query: typeof saved.query === 'string' ? saved.query.slice(0, 200) : defaults.query,
      categoryId: typeof saved.categoryId === 'string' ? saved.categoryId.slice(0, 100) : defaults.categoryId,
      tagId: typeof saved.tagId === 'string' ? saved.tagId.slice(0, 100) : defaults.tagId,
      currency: typeof saved.currency === 'string' && /^[A-Z]{3}$/.test(saved.currency) ? saved.currency : defaults.currency,
      period,
      date: date(saved.date, defaults.date),
      from: date(saved.from, defaults.from),
      to: date(saved.to, defaults.to),
    }
  } catch {
    return defaults
  }
}

export function historyDateRange(filters: HistoryFilters, today = localDateKey(new Date())): { from?: string; to?: string } {
  if (filters.period === 'today') return { from: today, to: today }
  if (filters.period === 'yesterday') { const yesterday = shiftDateKey(today, -1); return { from: yesterday, to: yesterday } }
  if (filters.period === 'this-week') return weekDateRange(today)
  if (filters.period === 'last-week') return weekDateRange(today, -1)
  if (filters.period === 'this-month') return monthDateRange(today)
  if (filters.period === 'last-month') return monthDateRange(today, -1)
  if (filters.period === 'day') return filters.date ? { from: filters.date, to: filters.date } : {}
  if (filters.period === 'week') return filters.date ? weekDateRange(filters.date) : {}
  if (filters.period !== 'range') return {}
  if (filters.from && filters.to && filters.from > filters.to) return { from: filters.to, to: filters.from }
  return { from: filters.from || undefined, to: filters.to || undefined }
}

export function filterHistoryExpenses(expenses: Expense[], filters: HistoryFilters, today = localDateKey(new Date())) {
  const { from, to } = historyDateRange(filters, today)
  return expenses.filter((expense) => {
    if (expense.deletedAt) return false
    if (filters.categoryId && expense.categoryId !== filters.categoryId) return false
    if (filters.tagId && !(expense.tagIds ?? []).includes(filters.tagId)) return false
    if (filters.currency && expense.currency !== filters.currency) return false
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
  const hasRate = (code: string) => code === target || Boolean((rates.ratesToRsd[code] ?? (code === 'RSD' ? 1 : 0)) && (rates.ratesToRsd[target] ?? (target === 'RSD' ? 1 : 0)))
  const missing = [...byCurrency.keys()].filter((code) => !hasRate(code)).sort()
  const converted = missing.length ? null : expenses.reduce((sum, expense) => sum + convertExpense(expense, target, currencies, rates), 0)
  return {
    byCurrency: [...byCurrency].map(([currency, amountMinor]) => ({ currency, amountMinor })).sort((left, right) => right.amountMinor - left.amountMinor || left.currency.localeCompare(right.currency)),
    converted,
    target,
    missing,
  }
}

export type Currency = {
  code: string
  name: string
  symbol: string
  decimals: number
}

export type Category = {
  id: string
  name: string
  color: string
  placement: 'main' | 'additional'
  sortOrder: number
  archivedAt: string | null
  version: number
}

export type Expense = {
  id: string
  amountMinor: number
  currency: string
  categoryId: string
  note: string | null
  occurredAt: string
  createdAt: string
  updatedAt: string
  version: number
  deletedAt: string | null
  pending?: boolean
}

export type RateSnapshot = {
  base: 'RSD'
  date: string | null
  ratesToRsd: Record<string, number>
}

export type Session = { authenticated: boolean }

export type Bootstrap = {
  expenses: Expense[]
  categories: Category[]
  currencies: Currency[]
  rates: RateSnapshot
}

export type OutboxItem = {
  operationId: string
  type: 'createExpense' | 'updateExpense' | 'deleteExpense'
  payload: Record<string, unknown>
  createdAt: string
  status?: 'queued' | 'conflict' | 'failed'
  error?: string
  current?: Expense
}

export type SyncResult = {
  operationId: string
  status: 'applied' | 'unchanged' | 'conflict' | 'error'
  expense?: Expense
  current?: Expense
  error?: { code: string; message: string }
  replayed?: boolean
}

export type AnalyticsData = {
  currency: string
  from: string
  to: string
  totalMinor: number
  expenseCount: number
  convertedCount: number
  rateDate: string | null
  missingCurrencies: string[]
  daily: { date: string; amountMinor: number; count: number }[]
  categories: { categoryId: string; name: string; color: string | null; amountMinor: number; count: number }[]
  weekdays: { weekday: number; amountMinor: number; count: number }[]
  calendar: { date: string; amountMinor: number; count: number }[]
}

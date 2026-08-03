import { cacheBootstrap, clearOfflineData, queueMutation, readCachedBootstrap, readOutbox, removeMutation } from './offline'
import type { AnalyticsData, Bootstrap, Category, Currency, Expense, OutboxItem, RateSnapshot, Session, SyncResult } from './types'

type ErrorEnvelope = { error?: { code?: string; message?: string; details?: unknown }; message?: string }

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message) }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    credentials: 'include',
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as ErrorEnvelope
    const error = body.error
    const parsed = new ApiError(response.status, error?.code || 'REQUEST_ERROR', error?.message || body.message || 'Не удалось выполнить запрос', error?.details)
    if (response.status === 401) window.dispatchEvent(new Event('moapp:unauthorized'))
    throw parsed
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export const getSession = () => request<Session>('/api/session')

export async function login(pin: string): Promise<void> {
  await request('/api/session', { method: 'POST', body: JSON.stringify({ pin }) })
  localStorage.setItem('moapp:known-session', '1')
}

export async function logout(): Promise<void> {
  try { await request('/api/session', { method: 'DELETE' }) } catch { /* local logout must also work offline */ }
  localStorage.removeItem('moapp:known-session')
  localStorage.removeItem('moapp:last-currency')
  localStorage.removeItem('moapp:analytics-currency')
  await clearOfflineData()
}

export async function getBootstrap(): Promise<{ data: Bootstrap; offline: boolean }> {
  try {
    const raw = await request<Partial<Bootstrap>>('/api/bootstrap')
    const data: Bootstrap = { expenses: raw.expenses || [], categories: raw.categories || [], currencies: raw.currencies?.length ? raw.currencies : fallbackCurrencies(), rates: raw.rates || fallbackRates() }
    await cacheBootstrap(data)
    return { data, offline: false }
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) throw error
    const cached = await readCachedBootstrap()
    if (cached) return { data: cached, offline: true }
    throw error
  }
}

async function sendOperations(items: OutboxItem[]) {
  return request<{ results: SyncResult[]; serverTime: string }>('/api/sync', {
    method: 'POST', body: JSON.stringify({ operations: items.map(({ operationId, type, payload }) => ({ operationId, type, payload })) }),
  })
}

export function buildExpenseOperation(type: OutboxItem['type'], expense: Expense, operationId: string, createdAt: string): OutboxItem {
  const common = { id: expense.id, amountMinor: expense.amountMinor, currency: expense.currency, categoryId: expense.categoryId, note: expense.note, occurredAt: expense.occurredAt }
  const payload = type === 'createExpense' ? common : type === 'updateExpense' ? { ...common, version: Math.max(1, expense.version - 1) } : { id: expense.id, version: expense.version }
  return { operationId, type, payload, createdAt, status: 'queued' }
}

export async function submitExpenseOperation(type: OutboxItem['type'], expense: Expense): Promise<SyncResult | null> {
  const item = buildExpenseOperation(type, expense, crypto.randomUUID(), new Date().toISOString())
  await queueMutation(item)
  if (!navigator.onLine) return null
  try {
    const response = await sendOperations([item])
    const result = response.results[0]
    if (!result) throw new ApiError(500, 'INVALID_RESPONSE', 'Сервер вернул пустой результат')
    if (result.status === 'applied' || result.status === 'unchanged') await removeMutation(item.operationId)
    else if (result.status === 'conflict') await queueMutation({ ...item, status: 'conflict', error: result.error?.message, current: result.current })
    else { await removeMutation(item.operationId); throw new ApiError(400, result.error?.code || 'VALIDATION', result.error?.message || 'Изменение отклонено') }
    return result
  } catch (error) {
    if (error instanceof TypeError) return null
    await removeMutation(item.operationId)
    throw error
  }
}

export async function syncOutbox(onProgress?: () => void) {
  const items = (await readOutbox()).filter((item) => !item.status || item.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, 200)
  if (!items.length) return
  const response = await sendOperations(items)
  for (const result of response.results) {
    const item = items.find((candidate) => candidate.operationId === result.operationId)
    if (!item) continue
    if (result.status === 'applied' || result.status === 'unchanged') await removeMutation(item.operationId)
    else await queueMutation({ ...item, status: result.status === 'conflict' ? 'conflict' : 'failed', error: result.error?.message, current: result.current })
    onProgress?.()
  }
}

export async function discardOutboxIssues() {
  const items = await readOutbox()
  await Promise.all(items.filter((item) => item.status === 'conflict' || item.status === 'failed').map((item) => removeMutation(item.operationId)))
}

function requireOnline() {
  if (!navigator.onLine) throw new ApiError(0, 'OFFLINE', 'Категории можно менять только при подключении к интернету')
}

export async function createCategory(category: Category) {
  requireOnline()
  return request<Category>('/api/categories', { method: 'POST', body: JSON.stringify({ id: category.id, name: category.name, color: category.color, placement: category.placement, sortOrder: category.sortOrder }) })
}
export async function updateCategory(category: Category) {
  requireOnline()
  return request<Category>(`/api/categories/${category.id}`, { method: 'PATCH', body: JSON.stringify({ name: category.name, color: category.color, placement: category.placement, sortOrder: category.sortOrder, archived: Boolean(category.archivedAt), version: category.version }) })
}
export async function reorderCategories(ids: string[]) {
  requireOnline()
  return request<{ categories: Category[] }>('/api/categories/order', { method: 'PUT', body: JSON.stringify({ ids }) })
}

export function getAnalytics(from: string, to: string, currency: string) {
  return request<AnalyticsData>(`/api/analytics?${new URLSearchParams({ from, to, currency })}`)
}

function fallbackCurrencies(): Currency[] {
  const supportedValuesOf = (Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf
  const codes = supportedValuesOf?.('currency') || ['RSD', 'EUR', 'USD', 'RUB']
  const names = new Intl.DisplayNames(['ru'], { type: 'currency' })
  return codes.map((code) => { const options = new Intl.NumberFormat('ru', { style: 'currency', currency: code }).resolvedOptions(); const symbol = new Intl.NumberFormat('ru', { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' }).formatToParts(0).find((part) => part.type === 'currency')?.value || code; return { code, name: names.of(code) || code, symbol, decimals: options.maximumFractionDigits ?? 2 } })
}
function fallbackRates(): RateSnapshot { return { base: 'RSD', date: new Date().toISOString().slice(0, 10), ratesToRsd: { RSD: 1 } } }

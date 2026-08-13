import { cacheBootstrap, clearOfflineData, queueMutation, readCachedBootstrap, readOutbox, removeMutation } from './offline'
import type { AnalyticsData, Bootstrap, Category, Currency, Expense, OutboxItem, RateSnapshot, Session, SyncResult } from './types'

type ErrorEnvelope = { error?: { code?: string; message?: string; details?: unknown }; message?: string }
let serverMutationsBlocked = false

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message) }
}

export const isUpgradeRequired = (error: unknown): error is ApiError => error instanceof ApiError && error.status === 410 && error.code === 'UPGRADE_REQUIRED'
export const blockServerMutations = () => { serverMutationsBlocked = true }

function requireMutationsAllowed() {
  if (serverMutationsBlocked) throw new ApiError(410, 'UPGRADE_REQUIRED', 'Нужно обновить приложение')
}

function notifyApiError(error: ApiError) {
  if (typeof window === 'undefined') return
  if (error.status === 401) window.dispatchEvent(new Event('moapp:unauthorized'))
  if (isUpgradeRequired(error)) window.dispatchEvent(new Event('moapp:upgrade-required'))
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
    notifyApiError(parsed)
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
  try { await request('/api/session', { method: 'DELETE' }) } catch (error) {
    // A cutover response is not an offline logout: preserve cached data for the update.
    if (isUpgradeRequired(error)) throw error
  }
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
    if ((error instanceof ApiError && error.status === 401) || isUpgradeRequired(error)) throw error
    const cached = await readCachedBootstrap()
    if (cached) return { data: cached, offline: true }
    throw error
  }
}

async function sendOperations(items: OutboxItem[]) {
  requireMutationsAllowed()
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
  const result = (await submitExpenseOperations(type, [expense]))[0] ?? null
  if (result?.status === 'error') throw new ApiError(400, result.error?.code || 'VALIDATION', result.error?.message || 'Изменение отклонено')
  return result
}

export async function submitExpenseOperations(type: OutboxItem['type'], expenses: Expense[]): Promise<(SyncResult | null)[]> {
  const createdAt = new Date().toISOString()
  const items = expenses.map((expense) => buildExpenseOperation(type, expense, crypto.randomUUID(), createdAt))
  await Promise.all(items.map((item) => queueMutation(item)))
  if (!navigator.onLine) return items.map(() => null)
  const results: (SyncResult | null)[] = []
  for (let offset = 0; offset < items.length; offset += 200) {
    const chunk = items.slice(offset, offset + 200)
    let response: Awaited<ReturnType<typeof sendOperations>>
    try { response = await sendOperations(chunk) }
    catch (error) {
      // A request may have reached the server even when its response was lost. Retain its operationId for replay.
      return [...results, ...items.slice(offset).map(() => null)]
    }
    if (!response || !Array.isArray(response.results)) return [...results, ...items.slice(offset).map(() => null)]
    for (const item of chunk) {
      const result = response.results.find((candidate) => candidate.operationId === item.operationId)
      if (!result) {
        // A partial/malformed response proves nothing about this operation.
        results.push(null)
      } else if (result.status === 'applied' || result.status === 'unchanged') {
        await removeMutation(item.operationId); results.push(result)
      } else if (result.status === 'conflict') {
        await queueMutation({ ...item, status:'conflict', error:result.error?.message, current:result.current }); results.push(result)
      } else if (result.status === 'error') {
        await removeMutation(item.operationId); results.push(result)
      } else {
        results.push(null)
      }
    }
  }
  return results
}

export async function syncOutbox(onProgress?: () => void) {
  const items = (await readOutbox()).filter((item) => !item.status || item.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, 200)
  if (!items.length) return
  let response: Awaited<ReturnType<typeof sendOperations>>
  try { response = await sendOperations(items) } catch { return }
  if (!response || !Array.isArray(response.results)) return
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
  requireMutationsAllowed()
  return request<Category>('/api/categories', { method: 'POST', body: JSON.stringify({ id: category.id, name: category.name, color: category.color, placement: category.placement, sortOrder: category.sortOrder }) })
}
export async function updateCategory(category: Category) {
  requireOnline()
  requireMutationsAllowed()
  return request<Category>(`/api/categories/${category.id}`, { method: 'PATCH', body: JSON.stringify({ name: category.name, color: category.color, placement: category.placement, sortOrder: category.sortOrder, archived: Boolean(category.archivedAt), version: category.version }) })
}
export async function reorderCategories(ids: string[]) {
  requireOnline()
  requireMutationsAllowed()
  return request<{ categories: Category[] }>('/api/categories/order', { method: 'PUT', body: JSON.stringify({ ids }) })
}

export function getAnalytics(from: string, to: string, currency: string, categoryId?: string) {
  const params = new URLSearchParams({ from, to, currency })
  if (categoryId) params.set('categoryId', categoryId)
  return request<AnalyticsData>(`/api/analytics?${params}`)
}

function fallbackCurrencies(): Currency[] {
  const supportedValuesOf = (Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf
  const codes = supportedValuesOf?.('currency') || ['RSD', 'EUR', 'USD', 'RUB']
  const names = new Intl.DisplayNames(['ru'], { type: 'currency' })
  return codes.map((code) => { const options = new Intl.NumberFormat('ru', { style: 'currency', currency: code }).resolvedOptions(); const symbol = new Intl.NumberFormat('ru', { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' }).formatToParts(0).find((part) => part.type === 'currency')?.value || code; return { code, name: names.of(code) || code, symbol, decimals: options.maximumFractionDigits ?? 2 } })
}
function fallbackRates(): RateSnapshot { return { base: 'RSD', date: new Date().toISOString().slice(0, 10), ratesToRsd: { RSD: 1 } } }

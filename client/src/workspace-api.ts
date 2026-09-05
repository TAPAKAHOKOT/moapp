import { cacheBootstrap, queueMutation, queueMutations, readCachedBootstrap, readOutbox, removeMutation } from './workspace-offline'
import type {
  AnalyticsData, AuthenticatedSession, BybitCardStatus, BybitCardTransaction, BybitRegion, Category, DeviceLinkMetadata, DeviceLinkPreview, DeviceSession, Expense, InvitationMetadata,
  InvitationPreview, Participant, RecoveryPrepareResponse, RecoveryPreview, SessionState, SyncResult, UserProfile, WorkspaceBootstrap,
  Tag, WorkspaceOutboxItem, WorkspaceSummary,
} from './types'

type ErrorEnvelope = { error?: { code?: string; message?: string; details?: unknown }; message?: string }
type ExpectedContext = Pick<AuthenticatedSession, 'user' | 'currentSessionId'>
type RequestOptions = RequestInit & { signal?: AbortSignal; suppressExpectedContext?: boolean }

let context: ExpectedContext | null = null
let mutationsBlocked = false

const SERVER_ERROR_MESSAGES: Record<string, string> = {
  ALREADY_AUTHENTICATED: 'В этом браузере уже открыт другой профиль.',
  ALREADY_CONNECTED: 'Это устройство уже подключено.',
  ALREADY_MEMBER: 'Этот профиль уже добавлен в пространство.',
  CATEGORY_INVALID: 'Категория недоступна или перенесена в архив.',
  CLAIM_IN_PROGRESS: 'Перенос уже выполняется в другой вкладке.',
  DUPLICATE: 'Такая запись уже существует.',
  FORBIDDEN: 'Для этого действия не хватает прав.',
  IDEMPOTENCY_CONFLICT: 'Это изменение уже было отправлено с другими данными.',
  IDENTITY_CONFLICT: 'Ссылка относится к другому профилю.',
  INVALID_DISPLAY_NAME: 'Проверьте имя: оно не должно быть пустым или слишком длинным.',
  INVALID_PIN: 'PIN не подошёл.',
  INVALID_WORKSPACE_NAME: 'Проверьте название пространства.',
  LINK_INVALID: 'Ссылка недействительна или больше не действует.',
  NOT_FOUND: 'Запрошенные данные не найдены.',
  OWNER_CANNOT_LEAVE: 'Сначала передайте владение пространством другому участнику.',
  RATES_UNAVAILABLE: 'Курсы валют временно недоступны.',
  RATE_MISSING: 'Для одной из валют пока нет курса.',
  ROTATION_STALE: 'Параллельно уже была сохранена другая ссылка восстановления.',
  RATE_LIMITED: 'Слишком много попыток. Подождите немного и повторите.',
  SESSION_CONTEXT_CHANGED: 'Активная сессия изменилась. Обновите данные и повторите действие.',
  UNAUTHORIZED: 'Сессия завершилась. Восстановите доступ и повторите действие.',
  UPGRADE_REQUIRED: 'Нужно обновить приложение.',
  USE_LOGOUT: 'Для текущего устройства используйте кнопку выхода.',
  VALIDATION: 'Проверьте заполненные данные.',
  VERSION_CONFLICT: 'Данные на сервере уже изменились. Обновите экран и повторите действие.',
  UNDO_CONFLICT: 'Созданный расход уже изменился, поэтому отменить его из разбора нельзя.',
  BYBIT_KEY_NOT_READ_ONLY: 'Создайте для Moapp отдельный read-only API-ключ Bybit.',
  BYBIT_CARD_PERMISSION_MISSING: 'У API-ключа не включено разрешение Bybit Card.',
  BYBIT_RATE_LIMITED: 'Bybit временно ограничил частоту запросов. Подождите немного и повторите.',
  BYBIT_REJECTED: 'Bybit отклонил запрос. Проверьте ключ, регион и ограничения по IP.',
  BYBIT_UNAVAILABLE: 'Bybit сейчас недоступен. Повторите синхронизацию позже.',
  WORKSPACE_NOT_FOUND: 'Пространство не найдено или доступ к нему закрыт.',
}

function localizeServerError(status: number, code: string, message: string) {
  if (/[А-Яа-яЁё]/.test(message)) return message
  return SERVER_ERROR_MESSAGES[code] ?? (status >= 500 ? 'Сервер временно недоступен. Повторите позже.' : status === 429 ? 'Слишком много попыток. Подождите немного и повторите.' : 'Не удалось выполнить запрос.')
}

export class WorkspaceApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message) }
}

export const isSessionContextChanged = (error: unknown): error is WorkspaceApiError => error instanceof WorkspaceApiError && error.status === 409 && error.code === 'SESSION_CONTEXT_CHANGED'
export const isWorkspaceNotFound = (error: unknown): error is WorkspaceApiError => error instanceof WorkspaceApiError && error.status === 404 && error.code === 'WORKSPACE_NOT_FOUND'
export const isObjectNotFound = (error: unknown): error is WorkspaceApiError => error instanceof WorkspaceApiError && error.status === 404 && error.code === 'NOT_FOUND'
export const isLinkInvalid = (error: unknown): error is WorkspaceApiError => error instanceof WorkspaceApiError && error.status === 410 && error.code === 'LINK_INVALID'
export const isRateLimited = (error: unknown): error is WorkspaceApiError => error instanceof WorkspaceApiError && error.status === 429

export function setSessionContext(session: SessionState | null): void {
  context = session?.authenticated ? { user: session.user, currentSessionId: session.currentSessionId } : null
}
export const getSessionContext = () => context
export const blockWorkspaceMutations = () => { mutationsBlocked = true }
export const allowWorkspaceMutations = () => { mutationsBlocked = false }

function rememberSession<T extends SessionState>(session: T): T {
  setSessionContext(session)
  if (session.authenticated) allowWorkspaceMutations()
  return session
}
function assertMutationsAllowed() { if (mutationsBlocked) throw new WorkspaceApiError(410, 'UPGRADE_REQUIRED', 'Нужно обновить приложение') }
function workspacePath(workspaceId: string, suffix = '') { return `/api/workspaces/${encodeURIComponent(workspaceId)}${suffix}` }

function sessionContextChanged(): WorkspaceApiError {
  return new WorkspaceApiError(409, 'SESSION_CONTEXT_CHANGED', 'Активная сессия изменилась во время запроса')
}

function sameContext(left: ExpectedContext | null, right: ExpectedContext | null): boolean {
  return left?.user.id === right?.user.id && left?.currentSessionId === right?.currentSessionId
}

function assertCurrentContext(snapshot: ExpectedContext | null): void {
  if (!sameContext(snapshot, context)) throw sessionContextChanged()
}

function captureMutationContext(userId: string): ExpectedContext {
  if (!context || context.user.id !== userId) throw sessionContextChanged()
  return context
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

// navigator.onLine alone is unreliable (iOS reports "online" without connectivity), so the last transport
// outcome is tracked too: any completed response marks the server reachable, a failed fetch marks it lost.
let serverReachable = true
const reachabilityListeners = new Set<(reachable: boolean) => void>()
function setServerReachable(next: boolean) {
  if (serverReachable === next) return
  serverReachable = next
  for (const listener of reachabilityListeners) listener(next)
}
export const isServerReachable = () => serverReachable
export function subscribeServerReachability(listener: (reachable: boolean) => void): () => void {
  reachabilityListeners.add(listener)
  return () => { reachabilityListeners.delete(listener) }
}
/** Cheap connectivity check that never touches the session context. */
export async function probeServer(signal?: AbortSignal): Promise<boolean> {
  try { await fetch('/api/health', { signal, cache: 'no-store', credentials: 'omit' }); setServerReachable(true); return true }
  catch (error) { if (!isAbortError(error)) setServerReachable(false); return false }
}

function isAuthoritativeWorkspaceError(error: unknown): boolean {
  return error instanceof WorkspaceApiError && (
    error.status === 401 || error.status === 409 ||
    (error.status === 404 && error.code === 'WORKSPACE_NOT_FOUND') ||
    (error.status === 410 && error.code === 'UPGRADE_REQUIRED')
  )
}

export async function request<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const { suppressExpectedContext = false, headers: suppliedHeaders, ...init } = options
  const headers = new Headers(suppliedHeaders)
  if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (!suppressExpectedContext && context) {
    headers.set('X-Moapp-Expected-User-Id', context.user.id)
    headers.set('X-Moapp-Expected-Session-Id', context.currentSessionId)
  }
  let response: Response
  try { response = await fetch(url, { ...init, headers, credentials: 'include' }) }
  catch (error) {
    // Only a transport failure means the server is unreachable; an aborted request says nothing about the network.
    if (!isAbortError(error)) setServerReachable(false)
    throw error
  }
  setServerReachable(true)
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as ErrorEnvelope
    const code = body.error?.code ?? 'REQUEST_ERROR'
    const message = body.error?.message ?? body.message ?? 'Не удалось выполнить запрос'
    throw new WorkspaceApiError(response.status, code, localizeServerError(response.status, code, message), body.error?.details)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

// Identity/session. GET /session deliberately does not send stale-tab headers.
export async function getSession(signal?: AbortSignal): Promise<SessionState> {
  const session = await request<SessionState>('/api/session', { signal, suppressExpectedContext: true })
  // A mocked/custom fetch may resolve even after abort. Never let that late
  // response restore the API identity context after an explicit logout.
  if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError')
  // Merely observing a cookie is not enough to lift an explicit logout fence.
  // The App does that only after its transition epoch accepts this response.
  setSessionContext(session)
  return session
}
export async function logout(signal?: AbortSignal): Promise<void> { await request<void>('/api/session', { method: 'DELETE', signal }) }
/** Used only for the persisted offline-logout marker before normal hydration. */
export async function logoutExpected(userId: string, sessionId: string, signal?: AbortSignal): Promise<void> {
  await request<void>('/api/session', { method: 'DELETE', signal, suppressExpectedContext: true, headers: {
    'X-Moapp-Expected-User-Id': userId, 'X-Moapp-Expected-Session-Id': sessionId,
  } })
}
export async function createIdentity(displayName: string, signal?: AbortSignal): Promise<AuthenticatedSession> {
  return rememberSession(await request<AuthenticatedSession>('/api/identity', { method: 'POST', body: JSON.stringify({ displayName }), signal }))
}
export function updateProfile(displayName: string, signal?: AbortSignal) { assertMutationsAllowed(); return request<{ user: UserProfile }>('/api/me', { method: 'PATCH', body: JSON.stringify({ displayName }), signal }) }
export function listSessions(signal?: AbortSignal) { return request<{ sessions: DeviceSession[] }>('/api/me/sessions', { signal }) }
export async function revokeSession(sessionId: string, signal?: AbortSignal): Promise<void> { assertMutationsAllowed(); return request<void>(`/api/me/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE', signal }) }

// Workspaces and membership.
export function listWorkspaces(signal?: AbortSignal) { return request<{ workspaces: WorkspaceSummary[] }>('/api/workspaces', { signal }) }
export function createWorkspace(id: string, name: string, signal?: AbortSignal) { assertMutationsAllowed(); return request<{ workspace: WorkspaceSummary }>('/api/workspaces', { method: 'POST', body: JSON.stringify({ id, name }), signal }) }
export function renameWorkspace(workspaceId: string, name: string, version: number, signal?: AbortSignal) { assertMutationsAllowed(); return request<{ workspace: WorkspaceSummary }>(workspacePath(workspaceId), { method: 'PATCH', body: JSON.stringify({ name, version }), signal }) }
export function listMembers(workspaceId: string, signal?: AbortSignal) { return request<{ members: Participant[] }>(workspacePath(workspaceId, '/members'), { signal }) }
export async function removeMember(workspaceId: string, userId: string, signal?: AbortSignal): Promise<void> { assertMutationsAllowed(); return request<void>(workspacePath(workspaceId, `/members/${encodeURIComponent(userId)}`), { method: 'DELETE', signal }) }
export async function leaveWorkspace(workspaceId: string, signal?: AbortSignal): Promise<void> { assertMutationsAllowed(); return request<void>(workspacePath(workspaceId, '/members/me'), { method: 'DELETE', signal }) }
export function transferOwnership(workspaceId: string, userId: string, version: number, signal?: AbortSignal) { assertMutationsAllowed(); return request<{ workspace: WorkspaceSummary }>(workspacePath(workspaceId, '/transfer-ownership'), { method: 'POST', body: JSON.stringify({ userId, version }), signal }) }

// Invitations and capability previews deliberately suppress identity headers.
export function listInvitations(workspaceId: string, signal?: AbortSignal) { return request<{ invitations: InvitationMetadata[] }>(workspacePath(workspaceId, '/invitations'), { signal }) }
export function createInvitation(workspaceId: string, ttlHours?: number, signal?: AbortSignal) {
  assertMutationsAllowed()
  const body = ttlHours === undefined ? {} : { ttlHours }
  return request<{ invitation: InvitationMetadata; url: string }>(workspacePath(workspaceId, '/invitations'), { method: 'POST', body: JSON.stringify(body), signal })
}
export async function revokeInvitation(workspaceId: string, invitationId: string, signal?: AbortSignal): Promise<void> { assertMutationsAllowed(); return request<void>(workspacePath(workspaceId, `/invitations/${encodeURIComponent(invitationId)}`), { method: 'DELETE', signal }) }
export function previewInvitation(token: string, signal?: AbortSignal) { return request<InvitationPreview>('/api/access/invitations/preview', { method: 'POST', body: JSON.stringify({ token }), signal, suppressExpectedContext: true }) }
export function acceptInvitation(token: string, signal?: AbortSignal) { assertMutationsAllowed(); return request<{ workspace: WorkspaceSummary }>('/api/access/invitations/accept', { method: 'POST', body: JSON.stringify({ token }), signal }) }

export function createDeviceLink(signal?: AbortSignal) { assertMutationsAllowed(); return request<{ deviceLink: DeviceLinkMetadata; url: string }>('/api/me/device-links', { method: 'POST', body: JSON.stringify({}), signal }) }
export function previewDeviceLink(token: string, signal?: AbortSignal) { return request<DeviceLinkPreview>('/api/access/device-links/preview', { method: 'POST', body: JSON.stringify({ token }), signal, suppressExpectedContext: true }) }
export async function acceptDeviceLink(token: string, attemptToken: string, signal?: AbortSignal): Promise<AuthenticatedSession> {
  const session = await request<AuthenticatedSession>('/api/access/device-links/accept', { method: 'POST', body: JSON.stringify({ token, attemptToken }), signal })
  return rememberSession(session)
}

export function prepareInitialOrManualRecovery(signal?: AbortSignal) { assertMutationsAllowed(); return request<RecoveryPrepareResponse>('/api/me/recovery/rotation/prepare', { method: 'POST', body: JSON.stringify({}), signal }) }
export async function completeInitialOrManualRecovery(completionToken: string, signal?: AbortSignal): Promise<AuthenticatedSession> {
  return rememberSession(await request<AuthenticatedSession>('/api/me/recovery/rotation/complete', { method: 'POST', body: JSON.stringify({ completionToken }), signal }))
}
export function previewRecovery(token: string, signal?: AbortSignal) { return request<RecoveryPreview>('/api/access/recovery/preview', { method: 'POST', body: JSON.stringify({ token }), signal, suppressExpectedContext: true }) }
export function prepareRecovery(token: string, signal?: AbortSignal) { return request<RecoveryPrepareResponse>('/api/access/recovery/prepare', { method: 'POST', body: JSON.stringify({ token }), signal }) }
export async function completeRecovery(completionToken: string, signal?: AbortSignal): Promise<AuthenticatedSession> {
  return rememberSession(await request<AuthenticatedSession>('/api/access/recovery/complete', { method: 'POST', body: JSON.stringify({ completionToken }), signal }))
}
export async function legacyClaim(pin: string, displayName: string, attemptToken: string, signal?: AbortSignal): Promise<AuthenticatedSession> {
  return rememberSession(await request<AuthenticatedSession>('/api/legacy-claim', { method: 'POST', body: JSON.stringify({ pin, displayName, attemptToken }), signal }))
}

// Tenant-scoped domain API.  Workspace ID is deliberately the first argument.
export async function getBootstrap(workspaceId: string, signal?: AbortSignal): Promise<{ data: WorkspaceBootstrap; offline: boolean }> {
  const snapshot = context
  try {
    const data = await request<WorkspaceBootstrap>(workspacePath(workspaceId, '/bootstrap'), { signal })
    assertCurrentContext(snapshot)
    if (data.workspaceId !== workspaceId) throw new WorkspaceApiError(409, 'WORKSPACE_RESPONSE_MISMATCH', 'Ответ сервера относится к другому пространству')
    if (snapshot) {
      await cacheBootstrap(snapshot.user.id, workspaceId, data)
      assertCurrentContext(snapshot)
    }
    return { data, offline: false }
  } catch (error) {
    // These responses are authoritative access changes, not offline failures.
    // Falling back to a cached bootstrap here would keep a removed workspace
    // visible or let a stale tab render data for the wrong session.
    if (isAbortError(error) || isAuthoritativeWorkspaceError(error)) throw error
    const cached = snapshot ? await readCachedBootstrap(snapshot.user.id, workspaceId) : undefined
    assertCurrentContext(snapshot)
    if (cached?.workspaceId === workspaceId) return { data: cached, offline: true }
    throw error
  }
}
export function listExpenses(workspaceId: string, signal?: AbortSignal) { return request<{ expenses: Expense[] }>(workspacePath(workspaceId, '/expenses'), { signal }) }
export function getExpense(workspaceId: string, expenseId: string, signal?: AbortSignal) { return request<Expense>(workspacePath(workspaceId, `/expenses/${encodeURIComponent(expenseId)}`), { signal }) }
export function createExpense(workspaceId: string, expense: Omit<Expense, 'createdAt' | 'updatedAt' | 'version' | 'deletedAt' | 'pending'>, signal?: AbortSignal) { assertMutationsAllowed(); return request<Expense>(workspacePath(workspaceId, '/expenses'), { method: 'POST', body: JSON.stringify(expense), signal }) }
export function updateExpense(workspaceId: string, expenseId: string, update: Partial<Expense> & Pick<Expense, 'version'>, signal?: AbortSignal) { assertMutationsAllowed(); return request<Expense>(workspacePath(workspaceId, `/expenses/${encodeURIComponent(expenseId)}`), { method: 'PATCH', body: JSON.stringify(update), signal }) }
export function includeExpense(workspaceId: string, expenseId: string, version: number, signal?: AbortSignal) { assertMutationsAllowed(); return request<Expense>(workspacePath(workspaceId, `/expenses/${encodeURIComponent(expenseId)}/include`), { method: 'POST', body: JSON.stringify({ version }), signal }) }
export async function deleteExpense(workspaceId: string, expenseId: string, version: number, signal?: AbortSignal): Promise<void> { assertMutationsAllowed(); return request<void>(workspacePath(workspaceId, `/expenses/${encodeURIComponent(expenseId)}`), { method: 'DELETE', body: JSON.stringify({ version }), signal }) }
export function listCategories(workspaceId: string, signal?: AbortSignal) { return request<{ categories: Category[] }>(workspacePath(workspaceId, '/categories'), { signal }) }
export function createCategory(workspaceId: string, category: Omit<Category, 'version' | 'createdAt' | 'updatedAt' | 'archivedAt'>, signal?: AbortSignal) {
  assertMutationsAllowed()
  const { id, name, placement, sortOrder, color } = category
  return request<Category>(workspacePath(workspaceId, '/categories'), { method: 'POST', body: JSON.stringify({ id, name, placement, sortOrder, color }), signal })
}
export function updateCategory(workspaceId: string, categoryId: string, update: Partial<Category> & Pick<Category, 'version'>, signal?: AbortSignal) {
  assertMutationsAllowed()
  const { name, placement, sortOrder, color, archivedAt, version } = update
  return request<Category>(workspacePath(workspaceId, `/categories/${encodeURIComponent(categoryId)}`), { method: 'PATCH', body: JSON.stringify({ name, placement, sortOrder, color, archivedAt, version }), signal })
}
export async function deleteCategory(workspaceId: string, categoryId: string, version: number, signal?: AbortSignal): Promise<void> { assertMutationsAllowed(); return request<void>(workspacePath(workspaceId, `/categories/${encodeURIComponent(categoryId)}`), { method: 'DELETE', body: JSON.stringify({ version }), signal }) }
export function listTags(workspaceId: string, signal?: AbortSignal) { return request<{ tags: Tag[] }>(workspacePath(workspaceId, '/tags'), { signal }) }
export function createTag(workspaceId: string, input: { name: string; color?: string | null; id?: string }, signal?: AbortSignal) { assertMutationsAllowed(); return request<Tag>(workspacePath(workspaceId, '/tags'), { method: 'POST', body: JSON.stringify({ id: input.id ?? crypto.randomUUID(), name: input.name, color: input.color ?? null }), signal }) }
export function updateTag(workspaceId: string, tagId: string, update: { name?: string; color?: string | null; sortOrder?: number; version: number }, signal?: AbortSignal) { assertMutationsAllowed(); return request<Tag>(workspacePath(workspaceId, `/tags/${encodeURIComponent(tagId)}`), { method: 'PATCH', body: JSON.stringify(update), signal }) }
export function reorderTags(workspaceId: string, ids: string[], signal?: AbortSignal) { assertMutationsAllowed(); return request<{ tags: Tag[] }>(workspacePath(workspaceId, '/tags/order'), { method: 'PUT', body: JSON.stringify({ ids }), signal }) }
export async function deleteTag(workspaceId: string, tagId: string, version: number, signal?: AbortSignal): Promise<void> { assertMutationsAllowed(); return request<void>(workspacePath(workspaceId, `/tags/${encodeURIComponent(tagId)}`), { method: 'DELETE', body: JSON.stringify({ version }), signal }) }
export function reorderCategories(workspaceId: string, ids: string[], signal?: AbortSignal) { assertMutationsAllowed(); return request<{ categories: Category[] }>(workspacePath(workspaceId, '/categories/order'), { method: 'PUT', body: JSON.stringify({ ids }), signal }) }
export function getAnalytics(workspaceId: string, from: string, to: string, currency: string, categoryId?: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ from, to, currency }); if (categoryId) query.set('categoryId', categoryId)
  return request<AnalyticsData>(workspacePath(workspaceId, `/analytics?${query}`), { signal })
}

const bybitCardPath = (workspaceId: string, suffix = '') => workspacePath(workspaceId, `/integrations/bybit-card${suffix}`)
export function getBybitCardStatus(workspaceId: string, signal?: AbortSignal) {
  return request<BybitCardStatus>(bybitCardPath(workspaceId), { signal })
}
export function connectBybitCard(workspaceId: string, apiKey: string, apiSecret: string, region: BybitRegion, signal?: AbortSignal) {
  assertMutationsAllowed()
  return request<BybitCardStatus>(bybitCardPath(workspaceId), { method: 'POST', body: JSON.stringify({ apiKey, apiSecret, region }), signal })
}
export async function disconnectBybitCard(workspaceId: string, signal?: AbortSignal): Promise<void> {
  assertMutationsAllowed()
  await request<void>(bybitCardPath(workspaceId), { method: 'DELETE', body: JSON.stringify({}), signal })
}
export function syncBybitCard(workspaceId: string, signal?: AbortSignal) {
  assertMutationsAllowed()
  return request<BybitCardStatus & { imported: number; throttled?: boolean }>(bybitCardPath(workspaceId, '/sync'), { method: 'POST', body: JSON.stringify({}), signal })
}
export function listBybitCardTransactions(workspaceId: string, signal?: AbortSignal) {
  return request<{ transactions: BybitCardTransaction[]; pendingCount: number }>(bybitCardPath(workspaceId, '/transactions?limit=200'), { signal })
}
export function classifyBybitCardTransaction(workspaceId: string, transactionId: string, categoryId: string, comment: string, tagIds: string[] = [], signal?: AbortSignal) {
  assertMutationsAllowed()
  return request<{ transaction: BybitCardTransaction; expense: Expense; pendingCount: number }>(bybitCardPath(workspaceId, `/transactions/${encodeURIComponent(transactionId)}/classify`), { method: 'POST', body: JSON.stringify({ categoryId, comment, tagIds }), signal })
}
export function ignoreBybitCardTransaction(workspaceId: string, transactionId: string, signal?: AbortSignal) {
  assertMutationsAllowed()
  return request<{ pendingCount: number }>(bybitCardPath(workspaceId, `/transactions/${encodeURIComponent(transactionId)}/ignore`), { method: 'POST', body: JSON.stringify({}), signal })
}
export function undoBybitCardTransaction(workspaceId: string, transactionId: string, expense?: Pick<Expense, 'id'|'version'>, signal?: AbortSignal) {
  assertMutationsAllowed()
  return request<{ transaction: BybitCardTransaction; undoneExpenseId: string|null; pendingCount: number }>(bybitCardPath(workspaceId, `/transactions/${encodeURIComponent(transactionId)}/undo`), { method: 'POST', body: JSON.stringify(expense?{expenseId:expense.id,expenseVersion:expense.version}:{}), signal })
}

export function buildExpenseOperation(userId: string, workspaceId: string, type: WorkspaceOutboxItem['type'], expense: Expense, operationId: string, createdAt: string): WorkspaceOutboxItem {
  const common = { id: expense.id, amountMinor: expense.amountMinor, currency: expense.currency, categoryId: expense.categoryId, note: expense.note, occurredAt: expense.occurredAt, tagIds: expense.tagIds ?? [] }
  const payload = type === 'createExpense' ? common : type === 'updateExpense' ? { ...common, version: Math.max(1, expense.version - 1) } : { id: expense.id, version: expense.version }
  return { userId, workspaceId, operationId, type, payload, createdAt, status: 'queued' }
}

async function sendOperations(workspaceId: string, items: WorkspaceOutboxItem[], signal?: AbortSignal): Promise<{ results: SyncResult[]; serverTime: string; workspaceId: string }> {
  assertMutationsAllowed()
  const response = await request<{ results: SyncResult[]; serverTime: string; workspaceId: string }>(workspacePath(workspaceId, '/sync'), { method: 'POST', body: JSON.stringify({ operations: items.map(({ operationId, type, payload }) => ({ operationId, type, payload })) }), signal })
  if (response.workspaceId !== workspaceId) throw new WorkspaceApiError(409, 'WORKSPACE_RESPONSE_MISMATCH', 'Ответ синхронизации относится к другому пространству')
  return response
}

export async function submitExpenseOperation(userId: string, workspaceId: string, type: WorkspaceOutboxItem['type'], expense: Expense, operationId = crypto.randomUUID(), signal?: AbortSignal): Promise<SyncResult | null> {
  const snapshot = captureMutationContext(userId)
  const item = buildExpenseOperation(userId, workspaceId, type, expense, operationId, new Date().toISOString())
  await queueMutation(userId, workspaceId, item)
  assertCurrentContext(snapshot)
  if (typeof navigator !== 'undefined' && !navigator.onLine) return null
  try {
    const response = await sendOperations(workspaceId, [item], signal)
    assertCurrentContext(snapshot)
    const result = response.results.find((candidate) => candidate.operationId === item.operationId)
    if (!result) return null
    if (result.status === 'applied' || result.status === 'unchanged') await removeMutation(userId, workspaceId, item.operationId)
    else if (result.status === 'conflict') await queueMutation(userId, workspaceId, { ...item, status: 'conflict', error: result.error?.message, errorCode: result.error?.code, current: result.current })
    else if (result.status === 'error') {
      await queueMutation(userId, workspaceId, { ...item, status: 'failed', error: result.error?.message, errorCode: result.error?.code })
      const code = result.error?.code ?? 'SYNC_ERROR'
      throw new WorkspaceApiError(422, code, localizeServerError(422, code, result.error?.message ?? 'Не удалось применить изменение'))
    }
    return result
  } catch (error) {
    // Abort and lost responses are deliberately indistinguishable to the
    // outbox: retaining the stable operationId is the only safe retry policy.
    if (isAbortError(error) || isAuthoritativeWorkspaceError(error) || error instanceof WorkspaceApiError && error.status === 422) throw error
    return null
  }
}

/** Batch convenience for UI actions; every item remains independently scoped and retryable. */
export async function submitExpenseOperations(userId: string, workspaceId: string, type: WorkspaceOutboxItem['type'], expenses: Expense[], signal?: AbortSignal): Promise<(SyncResult | null)[]> {
  const snapshot = captureMutationContext(userId)
  const items = expenses.map((expense) => buildExpenseOperation(userId, workspaceId, type, expense, crypto.randomUUID(), new Date().toISOString()))
  await queueMutations(userId, workspaceId, items)
  assertCurrentContext(snapshot)
  if (typeof navigator !== 'undefined' && !navigator.onLine) return items.map(() => null)
  let response: { results: SyncResult[]; serverTime: string; workspaceId: string }
  try { response = await sendOperations(workspaceId, items, signal) }
  catch (error) {
    if (isAbortError(error) || isAuthoritativeWorkspaceError(error)) throw error
    return items.map(() => null)
  }
  assertCurrentContext(snapshot)
  const results = new Map(response.results.map((result) => [result.operationId, result]))
  const cleanup = items.flatMap((item) => {
    const result = results.get(item.operationId)
    if (!result) return []
    if (result.status === 'applied' || result.status === 'unchanged') return [removeMutation(userId, workspaceId, item.operationId)]
    return [queueMutation(userId, workspaceId, { ...item, status: result.status === 'conflict' ? 'conflict' : 'failed', error: result.error?.message, errorCode: result.error?.code, current: result.current })]
  })
  // A successful server response is authoritative. Failed local cleanup leaves
  // the original stable operationId in the outbox, so a later sync can safely
  // retry it without rolling the already-applied UI action back.
  await Promise.allSettled(cleanup)
  assertCurrentContext(snapshot)
  return items.map((item) => results.get(item.operationId) ?? null)
}

export function describeOutboxIssue(item: Pick<WorkspaceOutboxItem, 'status' | 'error' | 'errorCode'>): string {
  if (item.status === 'conflict') return item.errorCode === 'IDEMPOTENCY_CONFLICT' ? 'Такой расход уже есть на сервере с другими данными.' : 'Этот расход уже изменили с другого устройства.'
  return localizeServerError(422, item.errorCode ?? '', item.error ?? '')
}

const isOutboxIssue = (item: WorkspaceOutboxItem) => item.status === 'conflict' || item.status === 'failed'

/** Re-sends a rejected change. A conflict is resent on top of the server's current version, so the local change wins. */
export async function retryOutboxIssue(userId: string, workspaceId: string, operationId: string): Promise<SyncResult | null> {
  const snapshot = captureMutationContext(userId)
  const issue = (await readOutbox(userId, workspaceId)).find((item) => item.operationId === operationId && isOutboxIssue(item))
  assertCurrentContext(snapshot)
  if (!issue) throw new WorkspaceApiError(404, 'NOT_FOUND', 'Это изменение уже обработано')
  // The server remembers the rejected operationId with its verdict, so the retry needs a fresh id.
  const current = issue.current
  const type = issue.type === 'createExpense' && current ? 'updateExpense' : issue.type
  const payload = type === 'createExpense' ? { ...issue.payload } : { ...issue.payload, version: current ? current.version : issue.payload.version }
  const item: WorkspaceOutboxItem = { userId, workspaceId, operationId: crypto.randomUUID(), type, payload, createdAt: new Date().toISOString(), status: 'queued' }
  await queueMutation(userId, workspaceId, item)
  await removeMutation(userId, workspaceId, issue.operationId)
  assertCurrentContext(snapshot)
  if (typeof navigator !== 'undefined' && !navigator.onLine) return null
  try {
    const response = await sendOperations(workspaceId, [item])
    assertCurrentContext(snapshot)
    const result = response.results.find((candidate) => candidate.operationId === item.operationId)
    if (!result) return null
    if (result.status === 'applied' || result.status === 'unchanged') await removeMutation(userId, workspaceId, item.operationId)
    else await queueMutation(userId, workspaceId, { ...item, status: result.status === 'conflict' ? 'conflict' : 'failed', error: result.error?.message, errorCode: result.error?.code, current: result.current })
    return result
  } catch (error) {
    // A lost response leaves the item queued under its stable id; the next sync retries it safely.
    if (isAbortError(error) || isAuthoritativeWorkspaceError(error)) throw error
    return null
  }
}

/** Drops rejected local changes (all of them, or only the given operation ids) and returns the authoritative snapshot. */
export async function discardOutboxIssues(userId: string, workspaceId: string, operationIds?: readonly string[]): Promise<WorkspaceBootstrap> {
  const snapshot = captureMutationContext(userId)
  const selected = (item: WorkspaceOutboxItem) => isOutboxIssue(item) && (!operationIds || operationIds.includes(item.operationId))
  let items = await readOutbox(userId, workspaceId)
  const queued = items.filter((item) => !item.status || item.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  if (queued.length) {
    await syncOutboxWithContext(userId, workspaceId, snapshot)
    assertCurrentContext(snapshot)
    items = await readOutbox(userId, workspaceId)
    if (items.some((item) => !item.status || item.status === 'queued')) throw new WorkspaceApiError(503, 'SYNC_PENDING', 'Сначала дождитесь отправки остальных изменений')
  }
  // Do not use getBootstrap's offline fallback here. Once an issue is removed,
  // only an authoritative snapshot can safely replace its optimistic value.
  const data = await request<WorkspaceBootstrap>(workspacePath(workspaceId, '/bootstrap'))
  assertCurrentContext(snapshot)
  if (data.workspaceId !== workspaceId) throw new WorkspaceApiError(409, 'WORKSPACE_RESPONSE_MISMATCH', 'Ответ сервера относится к другому пространству')
  await cacheBootstrap(userId, workspaceId, data)
  assertCurrentContext(snapshot)
  await Promise.all(items.filter(selected).map((item) => removeMutation(userId, workspaceId, item.operationId)))
  assertCurrentContext(snapshot)
  return data
}

export async function syncOutbox(userId: string, workspaceId: string, signal?: AbortSignal, onProgress?: () => void): Promise<void> {
  await syncOutboxWithContext(userId, workspaceId, captureMutationContext(userId), signal, onProgress)
}

async function syncOutboxWithContext(userId: string, workspaceId: string, expectedContext: ExpectedContext, signal?: AbortSignal, onProgress?: () => void): Promise<void> {
  const items = (await readOutbox(userId, workspaceId)).filter((item) => !item.status || item.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, 200)
  assertCurrentContext(expectedContext)
  if (!items.length) return
  let response: { results: SyncResult[]; serverTime: string; workspaceId: string }
  try {
    response = await sendOperations(workspaceId, items, signal)
    assertCurrentContext(expectedContext)
  } catch (error) {
    if (isAbortError(error) || isAuthoritativeWorkspaceError(error)) throw error
    return
  }
  for (const result of response.results) {
    assertCurrentContext(expectedContext)
    const item = items.find((candidate) => candidate.operationId === result.operationId)
    if (!item) continue
    if (result.status === 'applied' || result.status === 'unchanged') await removeMutation(userId, workspaceId, item.operationId)
    else await queueMutation(userId, workspaceId, { ...item, status: result.status === 'conflict' ? 'conflict' : 'failed', error: result.error?.message, errorCode: result.error?.code, current: result.current })
    onProgress?.()
  }
}

/** Active workspace first, then every other workspace with queued operations. */
export async function syncAllWorkspaces(userId: string, workspaces: readonly WorkspaceSummary[], activeWorkspaceId: string | null, signal?: AbortSignal, onProgress?: (workspaceId: string) => void): Promise<void> {
  const snapshot = captureMutationContext(userId)
  const ordered = [...workspaces].sort((a, b) => Number(b.id === activeWorkspaceId) - Number(a.id === activeWorkspaceId))
  for (const workspace of ordered) {
    assertCurrentContext(snapshot)
    await syncOutboxWithContext(userId, workspace.id, snapshot, signal)
    assertCurrentContext(snapshot)
    onProgress?.(workspace.id)
  }
}

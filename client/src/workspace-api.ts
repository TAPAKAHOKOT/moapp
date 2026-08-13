import { cacheBootstrap, queueMutation, readCachedBootstrap, readOutbox, removeMutation } from './workspace-offline'
import type {
  AnalyticsData, AuthenticatedSession, Category, DeviceLinkMetadata, DeviceLinkPreview, DeviceSession, Expense, InvitationMetadata,
  InvitationPreview, Participant, RecoveryPrepareResponse, RecoveryPreview, SessionState, SyncResult, UserProfile, WorkspaceBootstrap,
  WorkspaceOutboxItem, WorkspaceSummary,
} from './types'

type ErrorEnvelope = { error?: { code?: string; message?: string; details?: unknown }; message?: string }
type ExpectedContext = Pick<AuthenticatedSession, 'user' | 'currentSessionId'>
type RequestOptions = RequestInit & { signal?: AbortSignal; suppressExpectedContext?: boolean }

let context: ExpectedContext | null = null
let mutationsBlocked = false

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

function rememberSession<T extends SessionState>(session: T): T { setSessionContext(session); return session }
function assertMutationsAllowed() { if (mutationsBlocked) throw new WorkspaceApiError(410, 'UPGRADE_REQUIRED', 'Нужно обновить приложение') }
function workspacePath(workspaceId: string, suffix = '') { return `/api/workspaces/${encodeURIComponent(workspaceId)}${suffix}` }

export async function request<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const { suppressExpectedContext = false, headers: suppliedHeaders, ...init } = options
  const headers = new Headers(suppliedHeaders)
  if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (!suppressExpectedContext && context) {
    headers.set('X-Moapp-Expected-User-Id', context.user.id)
    headers.set('X-Moapp-Expected-Session-Id', context.currentSessionId)
  }
  const response = await fetch(url, { ...init, headers, credentials: 'include' })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as ErrorEnvelope
    throw new WorkspaceApiError(response.status, body.error?.code ?? 'REQUEST_ERROR', body.error?.message ?? body.message ?? 'Не удалось выполнить запрос', body.error?.details)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

// Identity/session. GET /session deliberately does not send stale-tab headers.
export async function getSession(signal?: AbortSignal): Promise<SessionState> {
  return rememberSession(await request<SessionState>('/api/session', { signal, suppressExpectedContext: true }))
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
  try {
    const data = await request<WorkspaceBootstrap>(workspacePath(workspaceId, '/bootstrap'), { signal })
    if (data.workspaceId !== workspaceId) throw new WorkspaceApiError(409, 'WORKSPACE_RESPONSE_MISMATCH', 'Ответ сервера относится к другому пространству')
    if (context) await cacheBootstrap(context.user.id, workspaceId, data)
    return { data, offline: false }
  } catch (error) {
    if (error instanceof WorkspaceApiError && (error.status === 401 || isSessionContextChanged(error))) throw error
    const cached = context ? await readCachedBootstrap(context.user.id, workspaceId) : undefined
    if (cached?.workspaceId === workspaceId) return { data: cached, offline: true }
    throw error
  }
}
export function listExpenses(workspaceId: string, signal?: AbortSignal) { return request<{ expenses: Expense[] }>(workspacePath(workspaceId, '/expenses'), { signal }) }
export function getExpense(workspaceId: string, expenseId: string, signal?: AbortSignal) { return request<Expense>(workspacePath(workspaceId, `/expenses/${encodeURIComponent(expenseId)}`), { signal }) }
export function createExpense(workspaceId: string, expense: Omit<Expense, 'createdAt' | 'updatedAt' | 'version' | 'deletedAt' | 'pending'>, signal?: AbortSignal) { assertMutationsAllowed(); return request<Expense>(workspacePath(workspaceId, '/expenses'), { method: 'POST', body: JSON.stringify(expense), signal }) }
export function updateExpense(workspaceId: string, expenseId: string, update: Partial<Expense> & Pick<Expense, 'version'>, signal?: AbortSignal) { assertMutationsAllowed(); return request<Expense>(workspacePath(workspaceId, `/expenses/${encodeURIComponent(expenseId)}`), { method: 'PATCH', body: JSON.stringify(update), signal }) }
export async function deleteExpense(workspaceId: string, expenseId: string, version: number, signal?: AbortSignal): Promise<void> { assertMutationsAllowed(); return request<void>(workspacePath(workspaceId, `/expenses/${encodeURIComponent(expenseId)}`), { method: 'DELETE', body: JSON.stringify({ version }), signal }) }
export function listCategories(workspaceId: string, signal?: AbortSignal) { return request<{ categories: Category[] }>(workspacePath(workspaceId, '/categories'), { signal }) }
export function createCategory(workspaceId: string, category: Omit<Category, 'version' | 'archivedAt'>, signal?: AbortSignal) { assertMutationsAllowed(); return request<Category>(workspacePath(workspaceId, '/categories'), { method: 'POST', body: JSON.stringify(category), signal }) }
export function updateCategory(workspaceId: string, categoryId: string, update: Partial<Category> & Pick<Category, 'version'>, signal?: AbortSignal) { assertMutationsAllowed(); return request<Category>(workspacePath(workspaceId, `/categories/${encodeURIComponent(categoryId)}`), { method: 'PATCH', body: JSON.stringify(update), signal }) }
export async function deleteCategory(workspaceId: string, categoryId: string, version: number, signal?: AbortSignal): Promise<void> { assertMutationsAllowed(); return request<void>(workspacePath(workspaceId, `/categories/${encodeURIComponent(categoryId)}`), { method: 'DELETE', body: JSON.stringify({ version }), signal }) }
export function reorderCategories(workspaceId: string, ids: string[], signal?: AbortSignal) { assertMutationsAllowed(); return request<{ categories: Category[] }>(workspacePath(workspaceId, '/categories/order'), { method: 'PUT', body: JSON.stringify({ ids }), signal }) }
export function getAnalytics(workspaceId: string, from: string, to: string, currency: string, categoryId?: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ from, to, currency }); if (categoryId) query.set('categoryId', categoryId)
  return request<AnalyticsData>(workspacePath(workspaceId, `/analytics?${query}`), { signal })
}

export function buildExpenseOperation(userId: string, workspaceId: string, type: WorkspaceOutboxItem['type'], expense: Expense, operationId: string, createdAt: string): WorkspaceOutboxItem {
  const common = { id: expense.id, amountMinor: expense.amountMinor, currency: expense.currency, categoryId: expense.categoryId, note: expense.note, occurredAt: expense.occurredAt }
  const payload = type === 'createExpense' ? common : type === 'updateExpense' ? { ...common, version: Math.max(1, expense.version - 1) } : { id: expense.id, version: expense.version }
  return { userId, workspaceId, operationId, type, payload, createdAt, status: 'queued' }
}

async function sendOperations(workspaceId: string, items: WorkspaceOutboxItem[], signal?: AbortSignal): Promise<{ results: SyncResult[]; serverTime: string; workspaceId?: string }> {
  assertMutationsAllowed()
  const response = await request<{ results: SyncResult[]; serverTime: string; workspaceId?: string }>(workspacePath(workspaceId, '/sync'), { method: 'POST', body: JSON.stringify({ operations: items.map(({ operationId, type, payload }) => ({ operationId, type, payload })) }), signal })
  if (response.workspaceId !== undefined && response.workspaceId !== workspaceId) throw new WorkspaceApiError(409, 'WORKSPACE_RESPONSE_MISMATCH', 'Ответ синхронизации относится к другому пространству')
  return response
}

export async function submitExpenseOperation(userId: string, workspaceId: string, type: WorkspaceOutboxItem['type'], expense: Expense, operationId = crypto.randomUUID(), signal?: AbortSignal): Promise<SyncResult | null> {
  const item = buildExpenseOperation(userId, workspaceId, type, expense, operationId, new Date().toISOString())
  await queueMutation(userId, workspaceId, item)
  if (typeof navigator !== 'undefined' && !navigator.onLine) return null
  try {
    const response = await sendOperations(workspaceId, [item], signal)
    const result = response.results.find((candidate) => candidate.operationId === item.operationId)
    if (!result) return null
    if (result.status === 'applied' || result.status === 'unchanged') await removeMutation(userId, workspaceId, item.operationId)
    else if (result.status === 'conflict') await queueMutation(userId, workspaceId, { ...item, status: 'conflict', error: result.error?.message, current: result.current })
    else if (result.status === 'error') await removeMutation(userId, workspaceId, item.operationId)
    return result
  } catch (error) {
    // Abort and lost responses are deliberately indistinguishable to the
    // outbox: retaining the stable operationId is the only safe retry policy.
    if (isSessionContextChanged(error)) throw error
    return null
  }
}

export async function syncOutbox(userId: string, workspaceId: string, signal?: AbortSignal, onProgress?: () => void): Promise<void> {
  const items = (await readOutbox(userId, workspaceId)).filter((item) => !item.status || item.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, 200)
  if (!items.length) return
  let response: { results: SyncResult[]; serverTime: string; workspaceId?: string }
  try { response = await sendOperations(workspaceId, items, signal) } catch (error) { if (isSessionContextChanged(error)) throw error; return }
  for (const result of response.results) {
    const item = items.find((candidate) => candidate.operationId === result.operationId)
    if (!item) continue
    if (result.status === 'applied' || result.status === 'unchanged') await removeMutation(userId, workspaceId, item.operationId)
    else await queueMutation(userId, workspaceId, { ...item, status: result.status === 'conflict' ? 'conflict' : 'failed', error: result.error?.message, current: result.current })
    onProgress?.()
  }
}

/** Active workspace first, then every other workspace with queued operations. */
export async function syncAllWorkspaces(userId: string, workspaces: readonly WorkspaceSummary[], activeWorkspaceId: string | null, signal?: AbortSignal, onProgress?: (workspaceId: string) => void): Promise<void> {
  const ordered = [...workspaces].sort((a, b) => Number(b.id === activeWorkspaceId) - Number(a.id === activeWorkspaceId))
  for (const workspace of ordered) { await syncOutbox(userId, workspace.id, signal); onProgress?.(workspace.id) }
}

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./workspace-offline', () => ({
  cacheBootstrap: vi.fn(), queueMutation: vi.fn(), queueMutations: vi.fn(), readCachedBootstrap: vi.fn(), readOutbox: vi.fn(async () => []), removeMutation: vi.fn(),
}))

import { cacheBootstrap, queueMutation, queueMutations, readCachedBootstrap, readOutbox, removeMutation } from './workspace-offline'
import { acceptDeviceLink, allowWorkspaceMutations, blockWorkspaceMutations, buildExpenseOperation, createCategory, createExpense, createInvitation, deleteCategory, discardOutboxIssues, getBootstrap, getSession, getSessionContext, prepareRecovery, previewInvitation, request, retryOutboxIssue, setSessionContext, submitExpenseOperation, submitExpenseOperations, syncAllWorkspaces, syncOutbox, updateCategory, updateExpense } from './workspace-api'
import type { AuthenticatedSession, Expense, WorkspaceBootstrap } from './types'

const session: AuthenticatedSession = {
  authenticated: true, user: { id: 'user-a', displayName: 'A', recoveryConfigured: false, recoveryGeneration: 0 }, currentSessionId: 'session-a',
  currentSessionExpiresAt: '2030-01-01T00:00:00.000Z', serverTime: '2026-01-01T00:00:00.000Z', restrictedToRecovery: false, workspaces: [], legacyWorkspaceId: null,
}
const otherSession: AuthenticatedSession = {
  ...session, user: { ...session.user, id: 'user-b', displayName: 'B' }, currentSessionId: 'session-b',
}
const expense: Expense = {
  id: 'expense-a', amountMinor: 100, currency: 'RSD', categoryId: 'products', note: null, occurredAt: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', version: 1, deletedAt: null,
}
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
const errorResponse = (status: number, code: string) => new Response(JSON.stringify({ error: { code, message: code } }), { status, headers: { 'Content-Type': 'application/json' } })

describe('workspace api identity context', () => {
  beforeEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); setSessionContext(null); allowWorkspaceMutations() })

  it.each([
    [401, 'UNAUTHORIZED', 'Your session has expired', 'Сессия завершилась. Восстановите доступ и повторите действие.'],
    [429, 'TOO_MANY_REQUESTS', 'Rate limit exceeded', 'Слишком много попыток. Подождите немного и повторите.'],
    [503, 'SERVICE_UNAVAILABLE', 'Database unavailable', 'Сервер временно недоступен. Повторите позже.'],
  ])('localizes an English server error for status %s', async (status, code, message, localized) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code, message } }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(request('/api/test')).rejects.toMatchObject({ status, code, message: localized })
  })

  it('preserves an already localized server message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'CUSTOM', message: 'Ссылка уже закрыта.' } }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(request('/api/test')).rejects.toMatchObject({ message: 'Ссылка уже закрыта.' })
  })

  it('hydrates the immutable expected-context snapshot from session', async () => {
    const fetchMock = vi.fn(async () => response(session)); vi.stubGlobal('fetch', fetchMock)
    await getSession()
    await request('/api/workspaces')
    const calls = fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit]>
    const headers = new Headers(calls[1]![1].headers)
    expect(headers.get('X-Moapp-Expected-User-Id')).toBe('user-a')
    expect(headers.get('X-Moapp-Expected-Session-Id')).toBe('session-a')
  })

  it('does not remember a session from a response that resolves after abort', async () => {
    let resolveResponse!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolveResponse = resolve })))
    const controller = new AbortController()

    const pending = getSession(controller.signal)
    controller.abort()
    resolveResponse(response(session))

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(getSessionContext()).toBeNull()
  })

  it('does not lift an explicit logout fence when a late session read returns authenticated', async () => {
    setSessionContext(session)
    blockWorkspaceMutations()
    const fetchMock = vi.fn(async () => response(session))
    vi.stubGlobal('fetch', fetchMock)

    await getSession()

    expect(() => createInvitation('workspace-a')).toThrow(expect.objectContaining({ code: 'UPGRADE_REQUIRED' }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('suppresses context only for public access previews', async () => {
    setSessionContext(session)
    const fetchMock = vi.fn(async () => response({ kind: 'invitation', workspace: { id: 'w', name: 'W' }, expiresAt: '2030-01-01T00:00:00.000Z' }))
    vi.stubGlobal('fetch', fetchMock)
    await previewInvitation('A'.repeat(43))
    const calls = fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit]>
    const headers = new Headers(calls[0]![1].headers)
    expect(headers.get('X-Moapp-Expected-User-Id')).toBeNull()
    expect(headers.get('Content-Type')).toBe('application/json')
  })

  it('sends an explicit empty JSON object for default invitation creation', async () => {
    setSessionContext(session)
    const fetchMock = vi.fn(async () => response({ invitation: {}, url: 'https://example.test/#/join/x' })); vi.stubGlobal('fetch', fetchMock)
    await createInvitation('workspace-a')
    const calls = fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit]>
    expect(calls[0]![1].body).toBe('{}')
  })

  it('preserves canonical bare expense/category responses and category delete version', async () => {
    setSessionContext(session)
    const expense = { id: 'expense', amountMinor: 1 }
    const category = { id: 'category', name: 'Food' }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(expense)).mockResolvedValueOnce(response(expense))
      .mockResolvedValueOnce(response(category)).mockResolvedValueOnce(response(category))
      .mockResolvedValueOnce(new Response(undefined, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(createExpense('workspace', { id: 'expense', amountMinor: 1, currency: 'RSD', categoryId: 'products', note: null, occurredAt: '2026-01-01T00:00:00.000Z' })).resolves.toEqual(expense)
    await expect(updateExpense('workspace', 'expense', { version: 1 })).resolves.toEqual(expense)
    await expect(createCategory('workspace', { id: 'category', name: 'Food', color: '#fff', placement: 'main', sortOrder: 0 })).resolves.toEqual(category)
    await expect(updateCategory('workspace', 'category', { version: 1 })).resolves.toEqual(category)
    await deleteCategory('workspace', 'category', 3)
    const calls = fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit]>
    expect(calls[4]![1].body).toBe(JSON.stringify({ version: 3 }))
    expect(new Headers(calls[4]![1].headers).get('Content-Type')).toBe('application/json')
  })

  it.each([
    [401, 'UNAUTHORIZED'],
    [404, 'WORKSPACE_NOT_FOUND'],
    [409, 'SESSION_CONTEXT_CHANGED'],
    [410, 'UPGRADE_REQUIRED'],
  ])('does not mask authoritative bootstrap failure %s %s with cached data', async (status, code) => {
    setSessionContext(session)
    const cached = { workspaceId: 'workspace-a' } as WorkspaceBootstrap
    vi.mocked(readCachedBootstrap).mockResolvedValue(cached)
    vi.stubGlobal('fetch', vi.fn(async () => errorResponse(status, code)))

    await expect(getBootstrap('workspace-a')).rejects.toMatchObject({ status, code })
    expect(readCachedBootstrap).not.toHaveBeenCalled()
  })

  it('does not turn an aborted bootstrap request into cached offline data', async () => {
    setSessionContext(session)
    vi.mocked(readCachedBootstrap).mockResolvedValue({ workspaceId: 'workspace-a' } as WorkspaceBootstrap)
    const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' })
    vi.stubGlobal('fetch', vi.fn(async () => { throw aborted }))

    await expect(getBootstrap('workspace-a')).rejects.toBe(aborted)
    expect(readCachedBootstrap).not.toHaveBeenCalled()
  })

  it('still uses a same-workspace bootstrap cache for a transient server failure', async () => {
    setSessionContext(session)
    const cached = { workspaceId: 'workspace-a' } as WorkspaceBootstrap
    vi.mocked(readCachedBootstrap).mockResolvedValue(cached)
    vi.stubGlobal('fetch', vi.fn(async () => errorResponse(503, 'SERVICE_UNAVAILABLE')))

    await expect(getBootstrap('workspace-a')).resolves.toEqual({ data: cached, offline: true })
    expect(readCachedBootstrap).toHaveBeenCalledWith('user-a', 'workspace-a')
  })

  it('does not cache or return a delayed bootstrap after the active identity changes', async () => {
    setSessionContext(session)
    let resolveResponse!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolveResponse = resolve })))

    const pending = getBootstrap('workspace-a')
    setSessionContext(otherSession)
    resolveResponse(response({ workspaceId: 'workspace-a' }))

    await expect(pending).rejects.toMatchObject({ status: 409, code: 'SESSION_CONTEXT_CHANGED' })
    expect(cacheBootstrap).not.toHaveBeenCalled()
    expect(readCachedBootstrap).not.toHaveBeenCalled()
  })

  it('omits expected-context headers for guest access acceptance but includes them for a normal-session recovery action', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(session))
      .mockResolvedValueOnce(response({ recoveryUrl: 'https://example.test/#/recover/x', completionToken: 'A'.repeat(43), expiresAt: '2030-01-01T00:00:00.000Z', recoveryGeneration: 1 }))
    vi.stubGlobal('fetch', fetchMock)

    await acceptDeviceLink('A'.repeat(43), 'B'.repeat(43))
    setSessionContext(session)
    await prepareRecovery('A'.repeat(43))

    const calls = fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit]>
    const guestHeaders = new Headers(calls[0]![1].headers)
    const normalHeaders = new Headers(calls[1]![1].headers)
    expect(guestHeaders.get('X-Moapp-Expected-User-Id')).toBeNull()
    expect(guestHeaders.get('X-Moapp-Expected-Session-Id')).toBeNull()
    expect(normalHeaders.get('X-Moapp-Expected-User-Id')).toBe('user-a')
    expect(normalHeaders.get('X-Moapp-Expected-Session-Id')).toBe('session-a')
  })

  it('keeps an operation queued instead of sending it after its identity changes', async () => {
    setSessionContext(session)
    vi.mocked(queueMutation).mockImplementationOnce(async () => { setSessionContext(otherSession) })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(submitExpenseOperation('user-a', 'workspace-a', 'createExpense', expense, '00000000-0000-4000-8000-000000000001')).rejects.toMatchObject({ status: 409, code: 'SESSION_CONTEXT_CHANGED' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(removeMutation).not.toHaveBeenCalled()
  })

  it('rejects a sync response that does not prove its workspace scope', async () => {
    setSessionContext(session)
    vi.stubGlobal('navigator', { onLine: true })
    const operationId = '00000000-0000-4000-8000-000000000001'
    vi.stubGlobal('fetch', vi.fn(async () => response({
      serverTime: '2026-01-03T00:00:00.000Z',
      results: [{ operationId, status: 'applied', expense }],
    })))

    await expect(submitExpenseOperation('user-a', 'workspace-a', 'createExpense', expense, operationId)).rejects.toMatchObject({
      code: 'WORKSPACE_RESPONSE_MISMATCH',
    })
    expect(removeMutation).not.toHaveBeenCalledWith('user-a', 'workspace-a', operationId)
  })

  it.each([
    ['create', 'createExpense', expense],
    ['update', 'updateExpense', { ...expense, version: 2, updatedAt: '2026-01-02T00:00:00.000Z' }],
    ['delete', 'deleteExpense', expense],
    ['restore', 'updateExpense', { ...expense, version: 3, deletedAt: null, updatedAt: '2026-01-03T00:00:00.000Z' }],
  ] as const)('rejects a permanent sync error for a single %s so the optimistic UI can roll back', async (_label, type, operationExpense) => {
    setSessionContext(session)
    vi.stubGlobal('navigator', { onLine: true })
    const operationId = '00000000-0000-4000-8000-000000000001'
    vi.stubGlobal('fetch', vi.fn(async () => response({
      workspaceId: 'workspace-a',
      serverTime: '2026-01-03T00:00:00.000Z',
      results: [{ operationId, status: 'error', error: { code: 'CATEGORY_INVALID', message: 'Category is unavailable' } }],
    })))

    await expect(submitExpenseOperation('user-a', 'workspace-a', type, operationExpense, operationId)).rejects.toMatchObject({
      code: 'CATEGORY_INVALID',
      message: 'Категория недоступна или перенесена в архив.',
    })
    expect(removeMutation).not.toHaveBeenCalledWith('user-a', 'workspace-a', operationId)
    expect(queueMutation).toHaveBeenLastCalledWith('user-a', 'workspace-a', expect.objectContaining({ operationId, status: 'failed' }))
  })

  it('returns applied and permanent-error results independently for a mixed batch', async () => {
    setSessionContext(session)
    vi.stubGlobal('navigator', { onLine: true })
    const rejected = { ...expense, id: 'expense-b', updatedAt: '2026-01-02T00:00:00.000Z' }
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { operations: Array<{ operationId: string; payload: { id: string } }> }
      const results = body.operations.map((operation) => operation.payload.id === expense.id
        ? { operationId: operation.operationId, status: 'applied', expense: { ...expense, version: 2 } }
        : { operationId: operation.operationId, status: 'error', error: { code: 'CATEGORY_INVALID', message: 'Category is unavailable' } })
      return response({ workspaceId: 'workspace-a', serverTime: '2026-01-02T00:00:00.000Z', results })
    }))

    const results = await submitExpenseOperations('user-a', 'workspace-a', 'deleteExpense', [expense, rejected])

    expect(results[0]).toMatchObject({ status: 'applied', expense: { id: expense.id, version: 2 } })
    expect(results[1]).toMatchObject({ status: 'error', error: { code: 'CATEGORY_INVALID' } })
    expect(queueMutations).toHaveBeenCalledTimes(1)
    expect(removeMutation).toHaveBeenCalledTimes(1)
    expect(queueMutation).toHaveBeenCalledWith('user-a', 'workspace-a', expect.objectContaining({ status: 'failed' }))
  })

  it('returns an authoritative applied batch result when local outbox removal fails', async () => {
    setSessionContext(session)
    vi.stubGlobal('navigator', { onLine: true })
    vi.mocked(removeMutation).mockRejectedValueOnce(new Error('IndexedDB removal failed'))
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { operations: Array<{ operationId: string }> }
      return response({
        workspaceId: 'workspace-a',
        serverTime: '2026-01-02T00:00:00.000Z',
        results: [{ operationId: body.operations[0]!.operationId, status: 'applied', expense: { ...expense, version: 2 } }],
      })
    }))

    await expect(submitExpenseOperations('user-a', 'workspace-a', 'deleteExpense', [expense])).resolves.toEqual([
      expect.objectContaining({ status: 'applied', expense: expect.objectContaining({ id: expense.id, version: 2 }) }),
    ])
    expect(removeMutation).toHaveBeenCalledTimes(1)
  })

  it('returns an authoritative rejected batch result when persisting its outbox status fails', async () => {
    setSessionContext(session)
    vi.stubGlobal('navigator', { onLine: true })
    vi.mocked(queueMutation).mockRejectedValueOnce(new Error('IndexedDB update failed'))
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { operations: Array<{ operationId: string }> }
      return response({
        workspaceId: 'workspace-a',
        serverTime: '2026-01-02T00:00:00.000Z',
        results: [{ operationId: body.operations[0]!.operationId, status: 'error', error: { code: 'CATEGORY_INVALID', message: 'Category is unavailable' } }],
      })
    }))

    await expect(submitExpenseOperations('user-a', 'workspace-a', 'deleteExpense', [expense])).resolves.toEqual([
      expect.objectContaining({ status: 'error', error: expect.objectContaining({ code: 'CATEGORY_INVALID' }) }),
    ])
    expect(queueMutation).toHaveBeenCalledWith('user-a', 'workspace-a', expect.objectContaining({ status: 'failed' }))
  })

  it.each([
    [401, 'UNAUTHORIZED'],
    [409, 'SESSION_CONTEXT_CHANGED'],
  ])('still rejects an authoritative batch failure %s %s', async (status, code) => {
    setSessionContext(session)
    vi.stubGlobal('navigator', { onLine: true })
    vi.stubGlobal('fetch', vi.fn(async () => errorResponse(status, code)))

    await expect(submitExpenseOperations('user-a', 'workspace-a', 'deleteExpense', [expense])).rejects.toMatchObject({ status, code })
  })

  it('keeps conflicted outbox entries when the authoritative bootstrap cannot be loaded', async () => {
    setSessionContext(session)
    vi.stubGlobal('navigator', { onLine: true })
    const issue = { ...buildExpenseOperation('user-a', 'workspace-a', 'updateExpense', expense, 'issue-a', '2026-01-01T00:00:00.000Z'), status: 'conflict' as const }
    vi.mocked(readOutbox).mockResolvedValueOnce([issue])
    vi.stubGlobal('fetch', vi.fn(async () => errorResponse(503, 'SERVICE_UNAVAILABLE')))

    await expect(discardOutboxIssues('user-a', 'workspace-a')).rejects.toMatchObject({ status: 503 })
    expect(removeMutation).not.toHaveBeenCalled()
    expect(cacheBootstrap).not.toHaveBeenCalled()
  })

  it('keeps conflicted outbox entries when discard is attempted offline', async () => {
    setSessionContext(session)
    const issue = { ...buildExpenseOperation('user-a', 'workspace-a', 'updateExpense', expense, 'issue-a', '2026-01-01T00:00:00.000Z'), status: 'conflict' as const }
    vi.mocked(readOutbox).mockResolvedValueOnce([issue])
    vi.stubGlobal('navigator', { onLine: false })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline') }))

    await expect(discardOutboxIssues('user-a', 'workspace-a')).rejects.toBeInstanceOf(Error)
    expect(removeMutation).not.toHaveBeenCalled()
    expect(cacheBootstrap).not.toHaveBeenCalled()
  })

  it('discards only the selected issue when operation ids are given', async () => {
    setSessionContext(session)
    vi.stubGlobal('navigator', { onLine: true })
    const first = { ...buildExpenseOperation('user-a', 'workspace-a', 'updateExpense', expense, 'issue-a', '2026-01-01T00:00:00.000Z'), status: 'conflict' as const }
    const second = { ...buildExpenseOperation('user-a', 'workspace-a', 'deleteExpense', expense, 'issue-b', '2026-01-01T00:00:01.000Z'), status: 'failed' as const }
    const bootstrap = { workspaceId: 'workspace-a' } as WorkspaceBootstrap
    vi.mocked(readOutbox).mockResolvedValueOnce([first, second])
    vi.stubGlobal('fetch', vi.fn(async () => response(bootstrap)))

    await expect(discardOutboxIssues('user-a', 'workspace-a', ['issue-b'])).resolves.toEqual(bootstrap)
    expect(removeMutation).toHaveBeenCalledTimes(1)
    expect(removeMutation).toHaveBeenCalledWith('user-a', 'workspace-a', 'issue-b')
  })

  it('retries a conflicted update on top of the server version under a fresh operation id', async () => {
    setSessionContext(session)
    vi.stubGlobal('navigator', { onLine: true })
    const issue = { ...buildExpenseOperation('user-a', 'workspace-a', 'updateExpense', expense, 'issue-a', '2026-01-01T00:00:00.000Z'), status: 'conflict' as const, current: { ...expense, version: 7 } }
    vi.mocked(readOutbox).mockResolvedValueOnce([issue])
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { operations: { operationId: string }[] }
      return response({ workspaceId: 'workspace-a', serverTime: '2026-01-02T00:00:00.000Z', results: [{ operationId: body.operations[0]!.operationId, status: 'applied', expense }] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await retryOutboxIssue('user-a', 'workspace-a', 'issue-a')
    expect(result?.status).toBe('applied')
    const sent = (JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { operations: { operationId: string; type: string; payload: { version: number } }[] }).operations[0]!
    expect(sent.operationId).not.toBe('issue-a')
    expect(sent.type).toBe('updateExpense')
    expect(sent.payload.version).toBe(7)
    expect(removeMutation).toHaveBeenCalledWith('user-a', 'workspace-a', 'issue-a')
    expect(removeMutation).toHaveBeenCalledWith('user-a', 'workspace-a', sent.operationId)
  })

  it('keeps a retried change queued when the network drops', async () => {
    setSessionContext(session)
    vi.stubGlobal('navigator', { onLine: true })
    const issue = { ...buildExpenseOperation('user-a', 'workspace-a', 'createExpense', expense, 'issue-a', '2026-01-01T00:00:00.000Z'), status: 'failed' as const, errorCode: 'VALIDATION' }
    vi.mocked(readOutbox).mockResolvedValueOnce([issue])
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline') }))

    await expect(retryOutboxIssue('user-a', 'workspace-a', 'issue-a')).resolves.toBeNull()
    expect(queueMutation).toHaveBeenCalledWith('user-a', 'workspace-a', expect.objectContaining({ type: 'createExpense', status: 'queued' }))
    expect(removeMutation).toHaveBeenCalledTimes(1)
    expect(removeMutation).toHaveBeenCalledWith('user-a', 'workspace-a', 'issue-a')
  })

  it('removes only problematic entries after the authoritative bootstrap succeeds', async () => {
    setSessionContext(session)
    vi.stubGlobal('navigator', { onLine: true })
    const issue = { ...buildExpenseOperation('user-a', 'workspace-a', 'updateExpense', expense, 'issue-a', '2026-01-01T00:00:00.000Z'), status: 'conflict' as const }
    const queued = buildExpenseOperation('user-a', 'workspace-a', 'createExpense', expense, 'queued-a', '2026-01-02T00:00:00.000Z')
    const bootstrap = { workspaceId: 'workspace-a' } as WorkspaceBootstrap
    vi.mocked(readOutbox)
      .mockResolvedValueOnce([issue, queued])
      .mockResolvedValueOnce([queued])
      .mockResolvedValueOnce([issue])
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
      ? response({ workspaceId: 'workspace-a', serverTime: '2026-01-02T00:00:00.000Z', results: [{ operationId: 'queued-a', status: 'applied', expense }] })
      : response(bootstrap))
    vi.stubGlobal('fetch', fetchMock)

    await expect(discardOutboxIssues('user-a', 'workspace-a')).resolves.toEqual(bootstrap)
    expect(cacheBootstrap).toHaveBeenCalledWith('user-a', 'workspace-a', bootstrap)
    expect(removeMutation).toHaveBeenCalledTimes(2)
    expect(removeMutation).toHaveBeenCalledWith('user-a', 'workspace-a', 'issue-a')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([
    [401, 'UNAUTHORIZED'],
    [404, 'WORKSPACE_NOT_FOUND'],
    [410, 'UPGRADE_REQUIRED'],
  ])('propagates authoritative sync failure %s %s instead of treating it as offline', async (status, code) => {
    setSessionContext(session)
    const item = buildExpenseOperation('user-a', 'workspace-a', 'createExpense', expense, '00000000-0000-4000-8000-000000000001', '2026-01-01T00:00:00.000Z')
    vi.mocked(readOutbox).mockResolvedValue([item])
    vi.stubGlobal('fetch', vi.fn(async () => errorResponse(status, code)))

    await expect(syncOutbox('user-a', 'workspace-a')).rejects.toMatchObject({ status, code })
    expect(removeMutation).not.toHaveBeenCalled()
  })

  it('keeps transient sync failures queued and stops a multi-workspace sync after a context change', async () => {
    setSessionContext(session)
    vi.stubGlobal('navigator', { onLine: true })
    vi.stubGlobal('fetch', vi.fn(async () => errorResponse(503, 'SERVICE_UNAVAILABLE')))
    await expect(submitExpenseOperation('user-a', 'workspace-a', 'createExpense', expense, '00000000-0000-4000-8000-000000000001')).resolves.toBeNull()
    expect(removeMutation).not.toHaveBeenCalled()

    vi.mocked(readOutbox).mockImplementationOnce(async () => { setSessionContext(otherSession); return [] })
    await expect(syncAllWorkspaces('user-a', [{ id: 'workspace-a', name: 'A', role: 'owner', version: 1, joinedAt: '2026-01-01T00:00:00.000Z' }], 'workspace-a')).rejects.toMatchObject({ status: 409, code: 'SESSION_CONTEXT_CHANGED' })
  })
})

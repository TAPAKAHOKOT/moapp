import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./workspace-offline', () => ({
  cacheBootstrap: vi.fn(), queueMutation: vi.fn(), readCachedBootstrap: vi.fn(), readOutbox: vi.fn(async () => []), removeMutation: vi.fn(),
}))

import { cacheBootstrap, queueMutation, readCachedBootstrap, readOutbox, removeMutation } from './workspace-offline'
import { acceptDeviceLink, buildExpenseOperation, createCategory, createExpense, createInvitation, deleteCategory, getBootstrap, getSession, getSessionContext, prepareRecovery, previewInvitation, request, setSessionContext, submitExpenseOperation, syncAllWorkspaces, syncOutbox, updateCategory, updateExpense } from './workspace-api'
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
  beforeEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); setSessionContext(null) })

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

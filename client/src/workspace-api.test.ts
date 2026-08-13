import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./workspace-offline', () => ({
  cacheBootstrap: vi.fn(), queueMutation: vi.fn(), readCachedBootstrap: vi.fn(), readOutbox: vi.fn(async () => []), removeMutation: vi.fn(),
}))

import { createCategory, createExpense, createInvitation, deleteCategory, getSession, previewInvitation, request, setSessionContext, updateCategory, updateExpense } from './workspace-api'
import type { AuthenticatedSession } from './types'

const session: AuthenticatedSession = {
  authenticated: true, user: { id: 'user-a', displayName: 'A', recoveryConfigured: false, recoveryGeneration: 0 }, currentSessionId: 'session-a',
  currentSessionExpiresAt: '2030-01-01T00:00:00.000Z', serverTime: '2026-01-01T00:00:00.000Z', restrictedToRecovery: false, workspaces: [], legacyWorkspaceId: null,
}
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

describe('workspace api identity context', () => {
  beforeEach(() => { vi.clearAllMocks(); setSessionContext(null) })

  it('hydrates the immutable expected-context snapshot from session', async () => {
    const fetchMock = vi.fn(async () => response(session)); vi.stubGlobal('fetch', fetchMock)
    await getSession()
    await request('/api/workspaces')
    const calls = fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit]>
    const headers = new Headers(calls[1]![1].headers)
    expect(headers.get('X-Moapp-Expected-User-Id')).toBe('user-a')
    expect(headers.get('X-Moapp-Expected-Session-Id')).toBe('session-a')
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
})

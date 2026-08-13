import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./workspace-offline', () => ({
  cacheProfile: vi.fn(), clearUserOfflineData: vi.fn(), clearWorkspaceOfflineData: vi.fn(), outboxStats: vi.fn(async () => ({ total: 0, conflicts: 0, failed: 0 })),
  readCachedBootstrap: vi.fn(), readCachedProfile: vi.fn(),
}))

import { beginWorkspaceRequest, chooseCachedWorkspace, closeCapability, createAppState, createIdentityCoordinator, createLoggedOutState, finishWorkspaceRequest, hydrateAppState, openLegacyClaim, updateWorkspace } from './app-state'
import { readCachedBootstrap } from './workspace-offline'
import type { AuthenticatedSession, GuestSession, WorkspaceRuntime, WorkspaceSummary } from './types'

function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() { return data.size }, clear: () => data.clear(), getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null, removeItem: (key) => { data.delete(key) }, setItem: (key, value) => { data.set(key, String(value)) },
  }
}

const session = (userId: string, sessionId = 'session'): AuthenticatedSession => ({
  authenticated: true, user: { id: userId, displayName: userId, recoveryConfigured: false, recoveryGeneration: 0 }, currentSessionId: sessionId,
  currentSessionExpiresAt: '2030-01-01T00:00:00.000Z', serverTime: '2026-01-01T00:00:00.000Z', restrictedToRecovery: false, workspaces: [], legacyWorkspaceId: null,
})

const guest = (legacyClaimAvailable = false): GuestSession => ({
  authenticated: false, user: null, workspaces: [], legacyClaimAvailable,
  serverTime: '2026-01-01T00:00:00.000Z',
})

const workspace = (id: string): WorkspaceSummary => ({
  id, name: id, role: 'owner', version: 1, joinedAt: '2026-01-01T00:00:00.000Z',
})

const cachedRuntime = (workspaceId: string): WorkspaceRuntime => ({
  workspaceId, bootstrap: { workspaceId } as WorkspaceRuntime['bootstrap'], source: 'cache', status: 'ready',
  offline: true, outbox: { total: 0, conflicts: 0, failed: 0 }, requestEpoch: 0,
})

beforeEach(() => { vi.stubGlobal('localStorage', memoryStorage()); vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('BroadcastChannel', undefined) })
afterEach(() => vi.unstubAllGlobals())

describe('workspace runtime race isolation', () => {
  it('does not apply a delayed A response after a newer A request epoch', () => {
    let state = createAppState()
    state = beginWorkspaceRequest(state, 'A')
    const firstEpoch = state.runtimes.A!.requestEpoch
    state = beginWorkspaceRequest(state, 'A')
    state = finishWorkspaceRequest(state, 'A', firstEpoch, { bootstrap: null, source: 'network', offline: false, status: 'ready' })
    expect(state.runtimes.A!.status).toBe('loading')
  })

  it('requires every update to name its target workspace', () => {
    const state = updateWorkspace(createAppState(), 'B', (runtime) => ({ ...runtime, outbox: { total: 1, conflicts: 0, failed: 0 } }))
    expect(state.runtimes.B!.outbox.total).toBe(1)
    expect(state.runtimes.A).toBeUndefined()
  })

  it('retains only safe IDs for an unexpected authenticated server identity', async () => {
    localStorage.setItem('moapp:v2:known-user', 'cached-user')
    const state = await hydrateAppState(session('server-user', 'server-session'))
    expect(state).toMatchObject({ phase: 'known-user-locked', session: null, identityConflict: true, conflictingSession: { userId: 'server-user', sessionId: 'server-session' } })
    expect(state.runtimes).toEqual({})
  })

  it('keeps a clean legacy browser on the guest screen until it explicitly starts a claim', async () => {
    const state = await hydrateAppState(guest(true))
    expect(state.phase).toBe('guest')
    expect(openLegacyClaim(state).phase).toBe('legacy-claim')
  })

  it('drops every renderable workspace value immediately when logging out', () => {
    const state = createLoggedOutState()
    expect(state).toMatchObject({ phase: 'known-user-locked', session: null, activeWorkspaceId: null, runtimes: {}, capability: null })
  })

  it('recalculates the phase when a capability flow is closed', async () => {
    const state = await hydrateAppState(guest(true), { kind: 'invite', token: 'token' })
    expect(state.phase).toBe('capability')
    expect(closeCapability(state)).toMatchObject({ phase: 'guest', capability: null })
  })

  it('uses a cached membership instead of a stale saved workspace selection', async () => {
    localStorage.setItem('moapp:v2:active-workspace:user', 'uncached')
    const workspaces = [workspace('uncached'), workspace('cached')]
    const selected = chooseCachedWorkspace('user', workspaces, { cached: cachedRuntime('cached') })
    expect(selected).toBe('cached')

    vi.mocked(readCachedBootstrap).mockImplementation(async (_userId, workspaceId) => workspaceId === 'cached' ? { workspaceId } as never : undefined)
    const state = await hydrateAppState({ ...session('user'), workspaces })
    expect(state.activeWorkspaceId).toBe('uncached')
  })

  it('uses the shared storage epoch when a newly opened tab announces identity', () => {
    localStorage.setItem('moapp:v2:identity-epoch', JSON.stringify({ epoch: 5, userId: 'old', sessionId: 'old-session' }))
    const foreignIdentity = vi.fn()
    const existing = createIdentityCoordinator({ refresh: async () => {}, abortNetwork: vi.fn(), stopSync: vi.fn(), onForeignIdentity: foreignIdentity, intervalMs: 60_000 })
    const newer = createIdentityCoordinator({ refresh: async () => {}, abortNetwork: vi.fn(), stopSync: vi.fn(), onForeignIdentity: vi.fn(), intervalMs: 60_000 })
    newer.announce('new-user', 'new-session')
    const event = Object.assign(new Event('storage'), { key: 'moapp:v2:identity-epoch', newValue: localStorage.getItem('moapp:v2:identity-epoch') })
    window.dispatchEvent(event)
    expect(JSON.parse(localStorage.getItem('moapp:v2:identity-epoch')!).epoch).toBe(6)
    expect(foreignIdentity).toHaveBeenCalledTimes(1)
    existing.dispose(); newer.dispose()
  })

  it('forces workspace reload when connectivity returns', () => {
    const refresh = vi.fn(async () => {})
    const coordinator = createIdentityCoordinator({ refresh, abortNetwork: vi.fn(), stopSync: vi.fn(), onForeignIdentity: vi.fn(), intervalMs: 60_000 })

    window.dispatchEvent(new Event('online'))

    expect(refresh).toHaveBeenCalledWith(true)
    coordinator.dispose()
  })
})

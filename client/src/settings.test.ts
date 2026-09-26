import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { THEME_MIRROR } from './appearance'
import { patchSettings, queueMemberSettings, queuedAccountSettings, queuedMemberSettings, settleMemberSettings, withAccountSettings, withMemberSettings, workspacesWithQueuedSettings } from './settings'
import type { AuthenticatedSession, WorkspaceBootstrap } from './types'

function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() { return data.size }, clear: () => data.clear(), getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null, removeItem: (key) => { data.delete(key) }, setItem: (key, value) => { data.set(key, String(value)) },
  }
}

const session = (settings?: AuthenticatedSession['settings']): AuthenticatedSession => ({
  authenticated: true, user: { id: 'user-a', displayName: 'Аня', recoveryConfigured: true, recoveryGeneration: 1 }, currentSessionId: 'session-a',
  currentSessionExpiresAt: '2030-01-01T00:00:00.000Z', serverTime: '2026-09-25T10:00:00.000Z', restrictedToRecovery: false, workspaces: [], legacyWorkspaceId: null,
  ...(settings ? { settings } : {}),
})

const bootstrap = (settings?: WorkspaceBootstrap['settings']): WorkspaceBootstrap => ({
  workspaceId: 'workspace-a', workspace: { id: 'workspace-a', name: 'Дом', role: 'owner', version: 1, joinedAt: '2026-08-01T00:00:00.000Z' },
  categories: [], tags: [], expenses: [], currencies: [], rates: { base: 'RSD', date: null, ratesToRsd: { RSD: 1 } }, defaultAnalyticsCurrency: 'RSD',
  serverTime: '2026-09-25T10:00:00.000Z', ...(settings ? { settings } : {}),
})

const legacy = (name: string) => `moapp:v2:user:user-a:workspace:workspace-a:${name}`

beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()))
afterEach(() => vi.unstubAllGlobals())

describe('personal settings on this phone', () => {
  it('applies a change key by key, and null returns a setting to its default', () => {
    expect(patchSettings({ lastCurrency: 'EUR', analyticsCurrency: 'USD' }, { lastCurrency: null, analyticsCurrency: 'RSD' })).toEqual({ analyticsCurrency: 'RSD' })
    expect(patchSettings(undefined, { theme: 'dark' })).toEqual({ theme: 'dark' })
  })

  it('shows a change that has not reached the server on top of the server answer', () => {
    queueMemberSettings('user-a', 'workspace-a', { lastCurrency: 'EUR', analyticsCurrency: null })
    expect(withMemberSettings('user-a', bootstrap({ lastCurrency: 'RSD', analyticsCurrency: 'USD' })).settings).toEqual({ lastCurrency: 'EUR' })
    expect(workspacesWithQueuedSettings('user-a')).toEqual(['workspace-a'])
    expect(workspacesWithQueuedSettings('user-b')).toEqual([])
  })

  it('forgets a sent change only while nobody changed it again', () => {
    queueMemberSettings('user-a', 'workspace-a', { lastCurrency: 'EUR', analyticsCurrency: 'USD' })
    settleMemberSettings('user-a', 'workspace-a', { lastCurrency: 'RSD', analyticsCurrency: 'USD' })
    expect(queuedMemberSettings('user-a', 'workspace-a')).toEqual({ lastCurrency: 'EUR' })
    settleMemberSettings('user-a', 'workspace-a', { lastCurrency: 'EUR' })
    expect(queuedMemberSettings('user-a', 'workspace-a')).toEqual({})
    expect(localStorage.getItem('moapp:v2:user:user-a:workspace:workspace-a:pending-settings')).toBeNull()
  })

  it('moves what this phone remembered into the account once, without the search text and without overwriting the account', () => {
    localStorage.setItem(legacy('last-currency'), 'EUR')
    localStorage.setItem(legacy('analytics-currency'), 'USD')
    localStorage.setItem(legacy('history-filters'), JSON.stringify({ query: 'кофе', categoryIds: ['products'], tagIds: [], currencies: ['EUR'], period: 'this-month', from: '2026-09-01', to: '2026-09-25' }))

    const merged = withMemberSettings('user-a', bootstrap({ analyticsCurrency: 'RSD' }))

    expect(merged.settings).toEqual({
      analyticsCurrency: 'RSD',
      lastCurrency: 'EUR',
      historyFilters: { categoryIds: ['products'], tagIds: [], currencies: ['EUR'], period: 'this-month', from: '2026-09-01', to: '2026-09-25' },
    })
    expect(queuedMemberSettings('user-a', 'workspace-a')).toEqual({ lastCurrency: 'EUR', historyFilters: merged.settings!.historyFilters })
    for (const name of ['last-currency', 'analytics-currency', 'history-filters']) expect(localStorage.getItem(legacy(name))).toBeNull()
  })

  it('waits for the server before moving anything when a cache predates settings in the account', () => {
    localStorage.setItem(legacy('last-currency'), 'EUR')
    expect(withMemberSettings('user-a', bootstrap()).settings).toBeUndefined()
    expect(localStorage.getItem(legacy('last-currency'))).toBe('EUR')
    expect(queuedMemberSettings('user-a', 'workspace-a')).toEqual({})
  })

  it('moves the theme picked on this phone into the account once, only if the account has none', () => {
    localStorage.setItem(THEME_MIRROR, 'dark')

    expect(withAccountSettings(session()).settings).toBeUndefined()
    expect(withAccountSettings(session({ theme: 'light' })).settings).toEqual({ theme: 'light' })
    expect(queuedAccountSettings('user-a')).toEqual({})

    localStorage.removeItem('moapp:v2:user:user-a:theme-moved')
    expect(withAccountSettings(session({})).settings).toEqual({ theme: 'dark' })
    expect(queuedAccountSettings('user-a')).toEqual({ theme: 'dark' })

    // The mirror keeps following the account afterwards; it never overrides the account again.
    localStorage.removeItem('moapp:v2:user:user-a:pending-settings')
    expect(withAccountSettings(session({})).settings).toEqual({})
  })
})

import { describe, expect, it, vi } from 'vitest'
import { completeRecoverySafely, completeRotationSafely, replacementTokenFromRecoveryUrl } from './recovery-flow'
import type { RecoveryCompletionApi } from './recovery-flow'
import { WorkspaceApiError } from './workspace-api'
import type { AuthenticatedSession, GuestSession, RecoveryPrepareResponse } from './types'

const replacementToken = 'r'.repeat(43)
const prepared: RecoveryPrepareResponse = {
  recoveryUrl: `https://moapp.test/#/recover/${replacementToken}`,
  completionToken: 'c'.repeat(43),
  expiresAt: '2030-01-01T00:00:00.000Z',
  nextGeneration: 2,
}

const authenticated = (userId = 'user-1'): AuthenticatedSession => ({
  authenticated: true,
  user: { id: userId, displayName: 'Аня', recoveryConfigured: true, recoveryGeneration: 2 },
  currentSessionId: 'session-1',
  currentSessionExpiresAt: '2030-01-01T00:00:00.000Z',
  serverTime: '2026-01-01T00:00:00.000Z',
  restrictedToRecovery: false,
  workspaces: [],
  legacyWorkspaceId: null,
})
const guest = (): GuestSession => ({ authenticated: false, user: null, workspaces: [], legacyClaimAvailable: false, serverTime: '2026-01-01T00:00:00.000Z' })

function api(overrides: Partial<RecoveryCompletionApi> = {}): RecoveryCompletionApi {
  return {
    completeRecovery: vi.fn(),
    completeRotation: vi.fn(),
    previewRecovery: vi.fn(),
    getSession: vi.fn(),
    ...overrides,
  } as RecoveryCompletionApi
}

describe('recovery completion helpers', () => {
  it('extracts only an exact recovery fragment', () => {
    expect(replacementTokenFromRecoveryUrl(prepared.recoveryUrl)).toBe(replacementToken)
    expect(replacementTokenFromRecoveryUrl(`https://moapp.test/#/recover/${replacementToken}/extra`)).toBeNull()
    expect(replacementTokenFromRecoveryUrl('https://moapp.test/#/join/not-a-recovery-token')).toBeNull()
  })

  it('recognises a lost public completion response only after previewing the exact replacement and matching session', async () => {
    const client = api({
      completeRecovery: vi.fn().mockRejectedValue(new Error('connection closed')),
      previewRecovery: vi.fn().mockResolvedValue({ kind: 'recovery', targetUserId: 'user-1', displayName: 'Аня' }),
      getSession: vi.fn().mockResolvedValue(authenticated()),
    })
    await expect(completeRecoverySafely({ prepared, targetUserId: 'user-1' }, client)).resolves.toMatchObject({
      status: 'completed', confirmedBy: 'replacement-preview', session: { user: { id: 'user-1' } },
    })
    expect(client.previewRecovery).toHaveBeenCalledWith(replacementToken)
  })

  it('does not rotate again when public recovery committed but its new cookie was lost', async () => {
    const client = api({
      completeRecovery: vi.fn().mockRejectedValue(new WorkspaceApiError(410, 'LINK_INVALID', 'used')),
      previewRecovery: vi.fn().mockResolvedValue({ kind: 'recovery', targetUserId: 'user-1', displayName: 'Аня' }),
      getSession: vi.fn().mockResolvedValue(guest()),
    })
    await expect(completeRecoverySafely({ prepared, targetUserId: 'user-1', canRetry: vi.fn().mockReturnValue(true) }, client)).resolves.toEqual({
      status: 'replacement-active-needs-recovery', replacementToken,
    })
    expect(client.completeRecovery).toHaveBeenCalledOnce()
  })

  it('continues with public recovery when a restricted rotation committed but its replacement cookie was lost', async () => {
    const client = api({
      completeRotation: vi.fn().mockRejectedValue(new Error('connection closed')),
      previewRecovery: vi.fn().mockResolvedValue({ kind: 'recovery', targetUserId: 'user-1', displayName: 'Аня' }),
      getSession: vi.fn().mockResolvedValue(guest()),
    })
    await expect(completeRotationSafely({ prepared, targetUserId: 'user-1' }, client)).resolves.toEqual({
      status: 'replacement-active-needs-recovery', replacementToken,
    })
    expect(client.completeRotation).toHaveBeenCalledOnce()
  })

  it('reports stale after previewing an invalid replacement link', async () => {
    const stale = new WorkspaceApiError(409, 'ROTATION_STALE', 'Another rotation won')
    const client = api({
      completeRotation: vi.fn().mockRejectedValue(stale),
      previewRecovery: vi.fn().mockRejectedValue(new WorkspaceApiError(410, 'LINK_INVALID', 'invalid')),
    })
    await expect(completeRotationSafely({ prepared, targetUserId: 'user-1' }, client)).resolves.toEqual({ status: 'rotation-stale', replacementToken })
    expect(client.previewRecovery).toHaveBeenCalledWith(replacementToken)
  })

  it('retries an invalid completion at most once only when the caller authorises it', async () => {
    const invalid = new WorkspaceApiError(410, 'LINK_INVALID', 'expired')
    const canRetry = vi.fn().mockReturnValue(true)
    const client = api({
      completeRotation: vi.fn().mockRejectedValueOnce(invalid).mockResolvedValueOnce(authenticated()),
      previewRecovery: vi.fn().mockRejectedValue(new WorkspaceApiError(410, 'LINK_INVALID', 'invalid')),
    })
    await expect(completeRotationSafely({ prepared, targetUserId: 'user-1', canRetry }, client)).resolves.toMatchObject({ status: 'completed', confirmedBy: 'retry-response' })
    expect(canRetry).toHaveBeenCalledOnce()
    expect(client.completeRotation).toHaveBeenCalledTimes(2)
  })

  it('leaves an invalid completion unconfirmed without an explicit retry authorisation', async () => {
    const client = api({
      completeRotation: vi.fn().mockRejectedValue(new WorkspaceApiError(410, 'LINK_INVALID', 'expired')),
      previewRecovery: vi.fn().mockRejectedValue(new WorkspaceApiError(410, 'LINK_INVALID', 'invalid')),
    })
    await expect(completeRotationSafely({ prepared, targetUserId: 'user-1' }, client)).resolves.toMatchObject({
      status: 'completion-unconfirmed', reason: 'replacement-link-invalid',
    })
    expect(client.completeRotation).toHaveBeenCalledOnce()
  })
})

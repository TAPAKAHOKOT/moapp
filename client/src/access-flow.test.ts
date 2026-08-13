import { describe, expect, it, vi } from 'vitest'
import { AccessFlowError, acceptDeviceWithProbe, acceptInvitationWithProbe, createIdentityWithProbe, createWorkspaceWithProbe, generateAttemptToken } from './access-flow'
import type { AccessFlowApi } from './access-flow'
import { WorkspaceApiError } from './workspace-api'
import type { AuthenticatedSession, GuestSession, WorkspaceSummary } from './types'

const workspace: WorkspaceSummary = { id: 'workspace-1', name: 'Дом', role: 'owner', version: 1, joinedAt: '2026-01-01T00:00:00.000Z' }
const authenticated = (userId = 'user-1', workspaces: WorkspaceSummary[] = []): AuthenticatedSession => ({
  authenticated: true,
  user: { id: userId, displayName: 'Аня', recoveryConfigured: false, recoveryGeneration: 0 },
  currentSessionId: `session-${userId}`,
  currentSessionExpiresAt: '2030-01-01T00:00:00.000Z',
  serverTime: '2026-01-01T00:00:00.000Z',
  restrictedToRecovery: false,
  workspaces,
  legacyWorkspaceId: null,
})
const guest = (): GuestSession => ({ authenticated: false, user: null, workspaces: [], legacyClaimAvailable: false, serverTime: '2026-01-01T00:00:00.000Z' })

function api(overrides: Partial<AccessFlowApi> = {}): AccessFlowApi {
  return {
    createIdentity: vi.fn(),
    createWorkspace: vi.fn(),
    acceptInvitation: vi.fn(),
    acceptDeviceLink: vi.fn(),
    getSession: vi.fn(),
    ...overrides,
  } as AccessFlowApi
}

describe('access flow helpers', () => {
  it('generates a 32-byte base64url attempt token', () => {
    const token = generateAttemptToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(generateAttemptToken()).not.toBe(token)
  })

  it('recognises a lost identity response by probing the session', async () => {
    const lost = new Error('connection closed')
    const client = api({ createIdentity: vi.fn().mockRejectedValue(lost), getSession: vi.fn().mockResolvedValue(authenticated()) })
    await expect(createIdentityWithProbe('Аня', client)).resolves.toMatchObject({ authenticated: true, user: { id: 'user-1' } })
    expect(client.getSession).toHaveBeenCalledOnce()
  })

  it('keeps the original identity error when the probe remains a guest', async () => {
    const lost = new Error('connection closed')
    const client = api({ createIdentity: vi.fn().mockRejectedValue(lost), getSession: vi.fn().mockResolvedValue(guest()) })
    await expect(createIdentityWithProbe('Аня', client)).rejects.toBe(lost)
  })

  it('recognises a lost workspace creation response using the stable workspace id', async () => {
    const lost = new Error('connection closed')
    const client = api({ createWorkspace: vi.fn().mockRejectedValue(lost), getSession: vi.fn().mockResolvedValue(authenticated('user-1', [workspace])) })
    await expect(createWorkspaceWithProbe(workspace.id, workspace.name, client)).resolves.toEqual(workspace)
    expect(client.createWorkspace).toHaveBeenCalledWith(workspace.id, workspace.name)
  })

  it('treats an already-member invitation as successful only after membership is confirmed', async () => {
    const alreadyMember = new WorkspaceApiError(409, 'ALREADY_MEMBER', 'Already joined')
    const client = api({ acceptInvitation: vi.fn().mockRejectedValue(alreadyMember), getSession: vi.fn().mockResolvedValue(authenticated('user-1', [workspace])) })
    await expect(acceptInvitationWithProbe('invite-secret', workspace.id, client)).resolves.toMatchObject({ workspaces: [workspace] })
  })

  it('keeps an invitation error when the session does not prove target membership', async () => {
    const lost = new Error('connection closed')
    const client = api({ acceptInvitation: vi.fn().mockRejectedValue(lost), getSession: vi.fn().mockResolvedValue(authenticated()) })
    await expect(acceptInvitationWithProbe('invite-secret', workspace.id, client)).rejects.toBe(lost)
  })

  it('retries a lost device-link response once with the same attempt token', async () => {
    const attempt = 'A'.repeat(43)
    const client = api({
      acceptDeviceLink: vi.fn().mockRejectedValueOnce(new Error('connection closed')).mockResolvedValueOnce(authenticated('target-user')),
      getSession: vi.fn().mockResolvedValue(guest()),
    })
    await expect(acceptDeviceWithProbe('device-secret', attempt, 'target-user', client)).resolves.toMatchObject({ user: { id: 'target-user' } })
    expect(client.acceptDeviceLink).toHaveBeenNthCalledWith(1, 'device-secret', attempt)
    expect(client.acceptDeviceLink).toHaveBeenNthCalledWith(2, 'device-secret', attempt)
  })

  it('raises an explicit identity conflict when probing finds another profile', async () => {
    const client = api({ acceptDeviceLink: vi.fn().mockRejectedValue(new Error('connection closed')), getSession: vi.fn().mockResolvedValue(authenticated('other-user')) })
    await expect(acceptDeviceWithProbe('device-secret', 'A'.repeat(43), 'target-user', client)).rejects.toBeInstanceOf(AccessFlowError)
  })
})

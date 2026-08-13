import {
  acceptDeviceLink,
  acceptInvitation,
  createIdentity,
  createWorkspace,
  getSession,
} from './workspace-api'
import type { AuthenticatedSession, SessionState, WorkspaceSummary } from './types'

/**
 * Generates the idempotency key required by device and legacy-access attempts.
 * The key is deliberately returned to the caller only: it must never be
 * persisted with application data or logged.
 */
export function generateAttemptToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export type AccessFlowApi = {
  createIdentity: typeof createIdentity
  createWorkspace: typeof createWorkspace
  acceptInvitation: typeof acceptInvitation
  acceptDeviceLink: typeof acceptDeviceLink
  getSession: typeof getSession
}

const defaultApi: AccessFlowApi = { createIdentity, createWorkspace, acceptInvitation, acceptDeviceLink, getSession }

export class AccessFlowError extends Error {
  constructor(public readonly code: 'INVITATION_NOT_CONFIRMED' | 'IDENTITY_CONFLICT', message: string) {
    super(message)
    this.name = 'AccessFlowError'
  }
}

function hasWorkspace(session: SessionState, workspaceId: string): session is AuthenticatedSession {
  return session.authenticated && session.workspaces.some((workspace) => workspace.id === workspaceId)
}

function requireTargetIdentity(session: AuthenticatedSession, targetUserId: string): AuthenticatedSession {
  if (session.user.id === targetUserId) return session
  throw new AccessFlowError('IDENTITY_CONFLICT', 'Эта ссылка предназначена для другого профиля')
}

async function probeSessionOrThrow(originalError: unknown, api: AccessFlowApi): Promise<SessionState> {
  try {
    return await api.getSession()
  } catch {
    throw originalError
  }
}

/** Resolve an unknown POST /identity result without creating a second identity. */
export async function createIdentityWithProbe(displayName: string, api: AccessFlowApi = defaultApi): Promise<AuthenticatedSession> {
  try {
    return await api.createIdentity(displayName)
  } catch (error) {
    const session = await probeSessionOrThrow(error, api)
    if (session.authenticated) return session
    throw error
  }
}

/** Resolve an unknown workspace creation result using the caller-provided stable UUID. */
export async function createWorkspaceWithProbe(stableId: string, name: string, api: AccessFlowApi = defaultApi): Promise<WorkspaceSummary> {
  try {
    return (await api.createWorkspace(stableId, name)).workspace
  } catch (error) {
    const session = await probeSessionOrThrow(error, api)
    if (hasWorkspace(session, stableId)) return session.workspaces.find((workspace) => workspace.id === stableId)!
    throw error
  }
}

/**
 * Accept an invitation exactly once from the UI's perspective. A consumed link
 * that reports ALREADY_MEMBER (or loses its response) is successful only when
 * the refreshed session proves membership of the intended workspace.
 */
export async function acceptInvitationWithProbe(token: string, targetWorkspaceId: string, api: AccessFlowApi = defaultApi): Promise<AuthenticatedSession> {
  let originalError: unknown | undefined
  try {
    await api.acceptInvitation(token)
  } catch (error) {
    originalError = error
  }

  let session: SessionState
  try {
    session = await api.getSession()
  } catch {
    if (originalError !== undefined) throw originalError
    throw new AccessFlowError('INVITATION_NOT_CONFIRMED', 'Не удалось подтвердить присоединение к пространству')
  }
  if (hasWorkspace(session, targetWorkspaceId)) return session
  if (originalError !== undefined) throw originalError
  throw new AccessFlowError('INVITATION_NOT_CONFIRMED', 'Присоединение к пространству не подтверждено')
}

async function confirmDeviceAttempt(
  token: string,
  stableAttempt: string,
  targetUserId: string,
  api: AccessFlowApi,
): Promise<AuthenticatedSession> {
  const accepted = await api.acceptDeviceLink(token, stableAttempt)
  return requireTargetIdentity(accepted, targetUserId)
}

/**
 * Handles an uncertain device-link acceptance. The same attempt token is used
 * for its single retry, allowing the server to safely return the original
 * accepted session instead of connecting a second device.
 */
export async function acceptDeviceWithProbe(
  token: string,
  stableAttempt: string,
  targetUserId: string,
  api: AccessFlowApi = defaultApi,
): Promise<AuthenticatedSession> {
  try {
    return await confirmDeviceAttempt(token, stableAttempt, targetUserId, api)
  } catch (firstError) {
    const afterFirst = await probeSessionOrThrow(firstError, api)
    if (afterFirst.authenticated) return requireTargetIdentity(afterFirst, targetUserId)

    try {
      return await confirmDeviceAttempt(token, stableAttempt, targetUserId, api)
    } catch (retryError) {
      const afterRetry = await probeSessionOrThrow(retryError, api)
      if (afterRetry.authenticated) return requireTargetIdentity(afterRetry, targetUserId)
      throw retryError
    }
  }
}

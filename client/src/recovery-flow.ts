import {
  completeInitialOrManualRecovery,
  completeRecovery,
  getSession,
  previewRecovery,
  WorkspaceApiError,
} from './workspace-api'
import type { AuthenticatedSession, RecoveryPrepareResponse, SessionState } from './types'

export type RecoveryCompletionSource = 'public' | 'rotation'

export type RecoveryCompletionApi = {
  completeRecovery: typeof completeRecovery
  completeRotation: typeof completeInitialOrManualRecovery
  previewRecovery: typeof previewRecovery
  getSession: typeof getSession
}

export type RecoveryRetryContext = {
  source: RecoveryCompletionSource
  prepared: RecoveryPrepareResponse
  replacementToken: string
  completeError: unknown
  previewError: unknown
}

export type RecoveryCompletionInput = {
  prepared: RecoveryPrepareResponse
  /** The identity established by the preview that began this flow. */
  targetUserId: string
  /**
   * Retrying a completion is safe only when the caller's source-state checks
   * prove that no other rotation could have won. The helper never retries by
   * default.
   */
  canRetry?: (context: RecoveryRetryContext) => boolean | Promise<boolean>
}

export type RecoveryCompletionOutcome =
  | { status: 'completed'; session: AuthenticatedSession; confirmedBy: 'response' | 'replacement-preview' | 'retry-response' }
  | { status: 'replacement-active-needs-recovery'; replacementToken: string }
  | { status: 'replacement-active-session-mismatch'; replacementToken: string; session: SessionState }
  | { status: 'rotation-stale'; replacementToken: string }
  | { status: 'completion-unconfirmed'; reason: 'replacement-url-invalid' | 'replacement-link-invalid' | 'replacement-preview-failed'; error: unknown }
  | { status: 'completion-failed'; error: unknown }

const defaultApi: RecoveryCompletionApi = {
  completeRecovery,
  completeRotation: completeInitialOrManualRecovery,
  previewRecovery,
  getSession,
}

function isLinkInvalid(error: unknown): boolean {
  return error instanceof WorkspaceApiError && error.code === 'LINK_INVALID'
}

function isRotationStale(error: unknown): boolean {
  return error instanceof WorkspaceApiError && error.code === 'ROTATION_STALE'
}

/**
 * Completion may have committed even when its HTTP response was lost. A
 * transport error and LINK_INVALID are therefore both treated as uncertain;
 * ordinary API errors (for example IDENTITY_CONFLICT) remain ordinary errors.
 */
function isUncertainCompletion(error: unknown): boolean {
  return !(error instanceof WorkspaceApiError) || isLinkInvalid(error) || isRotationStale(error)
}

/** Extract only the exact fragment capability returned by the server. */
export function replacementTokenFromRecoveryUrl(recoveryUrl: string): string | null {
  try {
    const hash = new URL(recoveryUrl).hash
    const match = /^#\/recover\/([A-Za-z0-9_-]{43})$/.exec(hash)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

function matchingSession(session: SessionState, targetUserId: string): session is AuthenticatedSession {
  return session.authenticated && session.user.id === targetUserId
}

async function inspectUncertainCompletion(
  source: RecoveryCompletionSource,
  input: RecoveryCompletionInput,
  api: RecoveryCompletionApi,
  complete: (completionToken: string) => Promise<AuthenticatedSession>,
  completeError: unknown,
  retryAvailable: boolean,
): Promise<RecoveryCompletionOutcome> {
  const replacementToken = replacementTokenFromRecoveryUrl(input.prepared.recoveryUrl)
  if (!replacementToken) return { status: 'completion-unconfirmed', reason: 'replacement-url-invalid', error: completeError }

  try {
    await api.previewRecovery(replacementToken)
  } catch (previewError) {
    if (isRotationStale(completeError) && isLinkInvalid(previewError)) {
      return { status: 'rotation-stale', replacementToken }
    }
    if (!isLinkInvalid(previewError)) {
      return { status: 'completion-unconfirmed', reason: 'replacement-preview-failed', error: previewError }
    }

    const retryAllowed = retryAvailable && Boolean(input.canRetry) && await input.canRetry!({
      source, prepared: input.prepared, replacementToken, completeError, previewError,
    })
    if (!retryAllowed) return { status: 'completion-unconfirmed', reason: 'replacement-link-invalid', error: previewError }

    try {
      const session = await complete(input.prepared.completionToken)
      return { status: 'completed', session, confirmedBy: 'retry-response' }
    } catch (retryError) {
      // A retry can lose its response too. Inspecting once more is safe, but
      // never issue a third completion request.
      if (!isUncertainCompletion(retryError)) return { status: 'completion-failed', error: retryError }
      return inspectUncertainCompletion(source, input, api, complete, retryError, false)
    }
  }

  let session: SessionState
  try {
    session = await api.getSession()
  } catch (error) {
    return { status: 'completion-unconfirmed', reason: 'replacement-preview-failed', error }
  }
  if (matchingSession(session, input.targetUserId)) {
    return { status: 'completed', session, confirmedBy: 'replacement-preview' }
  }
  if (!session.authenticated) {
    // The replacement link proves the prior completion, but this browser did
    // not receive its new cookie. This also applies to a restricted legacy
    // completion: that old session is atomically revoked on success. The caller
    // can continue through public recovery with this in-memory replacement.
    return { status: 'replacement-active-needs-recovery', replacementToken }
  }
  return { status: 'replacement-active-session-mismatch', replacementToken, session }
}

async function completeSafely(
  source: RecoveryCompletionSource,
  input: RecoveryCompletionInput,
  api: RecoveryCompletionApi,
  complete: (completionToken: string) => Promise<AuthenticatedSession>,
): Promise<RecoveryCompletionOutcome> {
  try {
    const session = await complete(input.prepared.completionToken)
    return { status: 'completed', session, confirmedBy: 'response' }
  } catch (error) {
    if (!isUncertainCompletion(error)) return { status: 'completion-failed', error }
    return inspectUncertainCompletion(source, input, api, complete, error, true)
  }
}

/** Complete public recovery without mistaking a lost response for failure. */
export function completeRecoverySafely(
  input: RecoveryCompletionInput,
  api: RecoveryCompletionApi = defaultApi,
): Promise<RecoveryCompletionOutcome> {
  return completeSafely('public', input, api, api.completeRecovery)
}

/** Complete initial/manual rotation without ever auto-retrying by default. */
export function completeRotationSafely(
  input: RecoveryCompletionInput,
  api: RecoveryCompletionApi = defaultApi,
): Promise<RecoveryCompletionOutcome> {
  return completeSafely('rotation', input, api, api.completeRotation)
}

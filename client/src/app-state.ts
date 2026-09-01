import { cacheProfile, clearUserOfflineData, clearWorkspaceOfflineData, outboxStats, readCachedBootstrap, readCachedProfile, waitForWorkspaceOfflineWrites } from './workspace-offline'
import { blockWorkspaceMutations, isSessionContextChanged, logoutExpected, setSessionContext } from './workspace-api'
import type { CapabilityIntent, OutboxStats, SessionState, WorkspaceRuntime, WorkspaceSummary } from './types'

export type AppPhase = 'checking' | 'guest' | 'known-user-locked' | 'legacy-claim' | 'restricted-recovery' | 'no-workspaces' | 'workspace' | 'capability'
export type LogoutMarker = { userId: string; sessionId: string }
export type AppState = {
  phase: AppPhase
  session: SessionState | null
  knownUserId: string | null
  activeWorkspaceId: string | null
  runtimes: Record<string, WorkspaceRuntime>
  capability: CapabilityIntent | null
  identityConflict: boolean
  /** Server identity IDs retained only to allow an explicit safe logout. */
  conflictingSession: { userId: string; sessionId: string } | null
}

const KNOWN_USER = 'moapp:v2:known-user'
const LOGOUT_PENDING = 'moapp:v2:logout-pending'
const activeKey = (userId: string) => `moapp:v2:active-workspace:${userId}`
type WorkspacePreference = 'last-currency' | 'analytics-currency' | 'analytics-week-category' | 'analytics-month-category' | 'history-filters'
const workspaceCurrencyKey = (userId: string, workspaceId: string, name: WorkspacePreference) => `moapp:v2:user:${userId}:workspace:${workspaceId}:${name}`

const storage = (): Storage | null => {
  if (typeof localStorage === 'undefined') return null
  // Node's test runtime may expose a placeholder localStorage object without
  // the browser Storage API; treat it as unavailable rather than failing boot.
  return typeof localStorage.getItem === 'function' && typeof localStorage.setItem === 'function' ? localStorage : null
}
export const knownUserId = () => storage()?.getItem(KNOWN_USER) ?? null
export const getLogoutMarker = (): LogoutMarker | null => {
  const raw = storage()?.getItem(LOGOUT_PENDING)
  if (!raw) return null
  try {
    const marker = JSON.parse(raw) as Partial<LogoutMarker>
    return typeof marker.userId === 'string' && typeof marker.sessionId === 'string' ? { userId: marker.userId, sessionId: marker.sessionId } : null
  } catch { return null }
}

function chooseWorkspace(userId: string, workspaces: readonly WorkspaceSummary[]): string | null {
  const saved = storage()?.getItem(activeKey(userId))
  return saved && workspaces.some((workspace) => workspace.id === saved) ? saved : workspaces[0]?.id ?? null
}

/**
 * Select a workspace that can actually be rendered while offline.  A saved
 * workspace is still preferred when it has a cache; otherwise the first
 * cached membership wins.  This prevents a stale saved selection from
 * leaving the app on a permanent loading screen when another workspace is
 * available locally.
 */
export function chooseCachedWorkspace(userId: string, workspaces: readonly WorkspaceSummary[], runtimes: Record<string, WorkspaceRuntime>): string | null {
  const saved = chooseWorkspace(userId, workspaces)
  if (saved && runtimes[saved]?.bootstrap) return saved
  return workspaces.find((workspace) => runtimes[workspace.id]?.bootstrap)?.id ?? saved
}
function phaseFor(session: SessionState, capability: CapabilityIntent | null, known: string | null): AppPhase {
  if (capability) return 'capability'
  // A legacy claim is an opt-in migration, never an automatic screen at boot.
  // A clean browser must get the normal guest landing even when old data is
  // available on the server.
  if (!session.authenticated) return known ? 'known-user-locked' : 'guest'
  if (known && known !== session.user.id) return 'known-user-locked'
  if (session.restrictedToRecovery) return 'restricted-recovery'
  return session.workspaces.length ? 'workspace' : 'no-workspaces'
}
function newRuntime(workspaceId: string): WorkspaceRuntime {
  return { workspaceId, bootstrap: null, source: null, status: 'idle', offline: false, outbox: { total: 0, conflicts: 0, failed: 0 }, requestEpoch: 0 }
}

function clearUserPreferences(userId: string, workspaceId?: string): void {
  const local = storage()
  if (!local) return
  const prefix = workspaceId === undefined ? `moapp:v2:user:${userId}:workspace:` : `moapp:v2:user:${userId}:workspace:${workspaceId}:`
  const keys: string[] = []
  for (let index = 0; index < local.length; index += 1) {
    const key = local.key(index)
    if (key?.startsWith(prefix)) keys.push(key)
  }
  for (const key of keys) local.removeItem(key)
  if (workspaceId === undefined) local.removeItem(activeKey(userId))
}

export function createAppState(capability: CapabilityIntent | null = null): AppState {
  return { phase: 'checking', session: null, knownUserId: knownUserId(), activeWorkspaceId: null, runtimes: {}, capability, identityConflict: false, conflictingSession: null }
}

/** Opens the legacy migration only after the person explicitly asks for it. */
export function openLegacyClaim(state: AppState): AppState {
  if (state.capability || state.session?.authenticated || !state.session?.legacyClaimAvailable) return state
  return { ...state, phase: 'legacy-claim' }
}

/**
 * Drops every in-memory, potentially sensitive renderable value immediately.
 * Call this straight after `beginLogout`, before waiting for the network.
 */
export function createLoggedOutState(): AppState {
  return {
    phase: 'known-user-locked', session: null, knownUserId: null, activeWorkspaceId: null,
    runtimes: {}, capability: null, identityConflict: false, conflictingSession: null,
  }
}

/** Closes a capability flow without accidentally restoring its old phase. */
export function closeCapability(state: AppState): AppState {
  if (!state.capability) return state
  if (state.identityConflict) return { ...state, capability: null, phase: 'known-user-locked' }
  if (state.session) return { ...state, capability: null, phase: phaseFor(state.session, null, state.knownUserId) }
  return { ...state, capability: null, phase: state.knownUserId ? 'known-user-locked' : 'guest' }
}

/** Hydrate only after the pending logout marker has been safely settled. */
export async function hydrateAppState(session: SessionState, capability: CapabilityIntent | null = null): Promise<AppState> {
  const known = knownUserId()
  if (!session.authenticated) {
    setSessionContext(null)
    return { ...createAppState(capability), session, knownUserId: known, phase: phaseFor(session, capability, known) }
  }
  const conflict = known !== null && known !== session.user.id
  if (conflict) {
    // Do not render either profile until the user explicitly clears local data
    // or logs out the unexpected server identity.
    setSessionContext(null)
    return {
      ...createAppState(capability), session: null, knownUserId: known, phase: 'known-user-locked', identityConflict: true,
      conflictingSession: { userId: session.user.id, sessionId: session.currentSessionId },
    }
  }
  storage()?.setItem(KNOWN_USER, session.user.id)
  setSessionContext(session)
  await cacheProfile(session.user.id, session)
  const runtimes: Record<string, WorkspaceRuntime> = {}
  for (const workspace of session.workspaces) {
    const cached = await readCachedBootstrap(session.user.id, workspace.id)
    const stats = await outboxStats(session.user.id, workspace.id)
    runtimes[workspace.id] = { ...newRuntime(workspace.id), bootstrap: cached ?? null, source: cached ? 'cache' : null, status: cached ? 'ready' : 'idle', offline: false, outbox: stats }
  }
  const activeWorkspaceId = chooseWorkspace(session.user.id, session.workspaces)
  return { phase: phaseFor(session, capability, session.user.id), session, knownUserId: session.user.id, activeWorkspaceId, runtimes, capability, identityConflict: false, conflictingSession: null }
}

export function updateWorkspace(state: AppState, workspaceId: string, updater: (runtime: WorkspaceRuntime) => WorkspaceRuntime): AppState {
  const current = state.runtimes[workspaceId] ?? newRuntime(workspaceId)
  const next = updater(current)
  if (next.workspaceId !== workspaceId) throw new Error('Workspace runtime cannot be moved between scopes')
  return { ...state, runtimes: { ...state.runtimes, [workspaceId]: next } }
}

export function beginWorkspaceRequest(state: AppState, workspaceId: string): AppState {
  return updateWorkspace(state, workspaceId, (runtime) => ({ ...runtime, status: 'loading', requestEpoch: runtime.requestEpoch + 1 }))
}

/** Applies a delayed response only when it still belongs to the original runtime epoch. */
export function finishWorkspaceRequest(state: AppState, workspaceId: string, epoch: number, patch: Pick<WorkspaceRuntime, 'bootstrap' | 'source' | 'offline' | 'status'>): AppState {
  return updateWorkspace(state, workspaceId, (runtime) => runtime.requestEpoch === epoch ? { ...runtime, ...patch } : runtime)
}

export function setActiveWorkspace(state: AppState, workspaceId: string | null): AppState {
  const session = state.session
  if (!session?.authenticated) return state
  const selected = workspaceId && session.workspaces.some((workspace) => workspace.id === workspaceId) ? workspaceId : chooseWorkspace(session.user.id, session.workspaces)
  if (selected) storage()?.setItem(activeKey(session.user.id), selected)
  else storage()?.removeItem(activeKey(session.user.id))
  return { ...state, activeWorkspaceId: selected }
}

export async function applyMembershipLoss(state: AppState, workspaceId: string): Promise<AppState> {
  if (!state.session?.authenticated) return state
  const { user } = state.session
  await clearWorkspaceOfflineData(user.id, workspaceId)
  clearUserPreferences(user.id, workspaceId)
  const workspaces = state.session.workspaces.filter((workspace) => workspace.id !== workspaceId)
  const session = { ...state.session, workspaces }
  await cacheProfile(user.id, session)
  const runtimes = { ...state.runtimes }; delete runtimes[workspaceId]
  return setActiveWorkspace({ ...state, session, runtimes, phase: workspaces.length ? 'workspace' : 'no-workspaces' }, state.activeWorkspaceId === workspaceId ? null : state.activeWorkspaceId)
}

export async function canOpenOfflineWorkspace(userId: string, workspaceId: string, now = Date.now()): Promise<boolean> {
  if (getLogoutMarker()) return false
  const profile = await readCachedProfile(userId)
  if (!profile?.session.authenticated || profile.session.user.id !== userId) return false
  if (Date.parse(profile.session.currentSessionExpiresAt) <= now) return false
  return Boolean(await readCachedBootstrap(userId, workspaceId))
}

export async function beginLogout(state: AppState): Promise<void> {
  if (!state.session?.authenticated) return
  const { user, currentSessionId } = state.session
  blockWorkspaceMutations()
  setSessionContext(null)
  storage()?.setItem(LOGOUT_PENDING, JSON.stringify({ userId: user.id, sessionId: currentSessionId } satisfies LogoutMarker))
  // The marker is durable before any profile/cache IDs are removed.
  storage()?.removeItem(KNOWN_USER)
  clearUserPreferences(user.id)
  await waitForWorkspaceOfflineWrites()
  await clearUserOfflineData(user.id)
}

/** Returns true only after the old cookie is revoked or safely proved unrelated. */
export async function settlePendingLogout(online: boolean, signal?: AbortSignal): Promise<boolean> {
  const marker = getLogoutMarker()
  if (!marker || !online) return !marker
  try {
    await logoutExpected(marker.userId, marker.sessionId, signal)
    await waitForWorkspaceOfflineWrites()
    await clearUserOfflineData(marker.userId)
    storage()?.removeItem(LOGOUT_PENDING)
    return true
  } catch (error) {
    if (isSessionContextChanged(error)) {
      await waitForWorkspaceOfflineWrites()
      await clearUserOfflineData(marker.userId)
      storage()?.removeItem(LOGOUT_PENDING)
      return true
    }
    return false
  }
}

export async function forgetKnownProfile(online: boolean, session: SessionState | null, signal?: AbortSignal): Promise<boolean> {
  const userId = knownUserId()
  if (!userId) return true
  const authenticatedSession = session?.authenticated && session.user.id === userId ? session : null
  const authoritativeGuest = Boolean(online && session && !session.authenticated)
  // navigator.onLine alone is not proof that the server cookie is gone. Keep
  // the local lock until we have either the matching session ID or a fresh
  // authoritative guest response.
  if (!authenticatedSession && !authoritativeGuest) return false
  blockWorkspaceMutations()
  setSessionContext(null)
  if (authenticatedSession) storage()?.setItem(LOGOUT_PENDING, JSON.stringify({ userId, sessionId: authenticatedSession.currentSessionId } satisfies LogoutMarker))
  else storage()?.removeItem(LOGOUT_PENDING)
  storage()?.removeItem(KNOWN_USER)
  clearUserPreferences(userId)
  await waitForWorkspaceOfflineWrites()
  await clearUserOfflineData(userId)
  if (!authenticatedSession || !online) return true
  return settlePendingLogout(true, signal)
}

export function getWorkspacePreference(userId: string, workspaceId: string, name: WorkspacePreference): string | null { return storage()?.getItem(workspaceCurrencyKey(userId, workspaceId, name)) ?? null }
export function setWorkspacePreference(userId: string, workspaceId: string, name: WorkspacePreference, value: string): void { storage()?.setItem(workspaceCurrencyKey(userId, workspaceId, name), value) }
export const readWorkspaceStats = (userId: string, workspaceId: string): Promise<OutboxStats> => outboxStats(userId, workspaceId)

export type IdentityEvent = { epoch: number; eventId: string; userId: string | null; sessionId: string | null }
type CoordinatorOptions = { refresh: (reloadWorkspace?: boolean) => Promise<void>; abortNetwork: () => void; stopSync: () => void; onForeignIdentity: () => void; intervalMs?: number }

/** Broadcast is an acceleration only; server expected-context headers remain the security boundary. */
export function createIdentityCoordinator(options: CoordinatorOptions) {
  const key = 'moapp:v2:identity-epoch'
  const readEpoch = () => {
    try {
      const raw = storage()?.getItem(key)
      const value = raw ? JSON.parse(raw) as Partial<IdentityEvent> : null
      return typeof value?.epoch === 'number' && Number.isSafeInteger(value.epoch) && value.epoch >= 0 ? value.epoch : 0
    } catch { return 0 }
  }
  let epoch = readEpoch()
  const seenEvents = new Set<string>()
  let stopped = false
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('moapp-identity')
  const receive = (event: IdentityEvent) => {
    const eventId = typeof event.eventId === 'string' ? event.eventId : `${event.epoch}:${event.userId ?? ''}:${event.sessionId ?? ''}`
    if (stopped || seenEvents.has(eventId) || event.epoch < epoch) return
    seenEvents.add(eventId); epoch = Math.max(epoch, event.epoch); options.abortNetwork(); options.stopSync(); options.onForeignIdentity(); void options.refresh()
  }
  channel?.addEventListener('message', (event: MessageEvent<IdentityEvent>) => receive(event.data))
  const storageListener = (event: StorageEvent) => { if (event.key === key && event.newValue) { try { receive(JSON.parse(event.newValue) as IdentityEvent) } catch { /* ignore malformed events */ } } }
  if (typeof window !== 'undefined') window.addEventListener('storage', storageListener)
  // Reconnect/foreground refreshes must also retry a workspace whose previous
  // bootstrap failed even when the identity and selected workspace are equal.
  const refresh = () => { if (!stopped) void options.refresh(true) }
  const visibilityListener = () => { if (document.visibilityState === 'visible') refresh() }
  if (typeof window !== 'undefined') { window.addEventListener('online', refresh); window.addEventListener('visibilitychange', visibilityListener) }
  const interval = setInterval(refresh, options.intervalMs ?? 30 * 60_000)
  return {
    announce(userId: string | null, sessionId: string | null) {
      // A tab may open long after earlier identity changes. Reading the shared
      // version before incrementing prevents its epoch=1 announcement from
      // being ignored by a tab that has already observed epoch=5.
      epoch = Math.max(epoch, readEpoch()) + 1
      const event = { epoch, eventId: crypto.randomUUID(), userId, sessionId }
      seenEvents.add(event.eventId)
      channel?.postMessage(event)
      try { storage()?.setItem(key, JSON.stringify(event)) } catch { /* BroadcastChannel remains available */ }
    },
    dispose() {
      stopped = true; clearInterval(interval); channel?.close()
      if (typeof window !== 'undefined') {
        window.removeEventListener('storage', storageListener); window.removeEventListener('online', refresh); window.removeEventListener('visibilitychange', visibilityListener)
      }
    },
  }
}

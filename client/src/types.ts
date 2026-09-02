export type Currency = {
  code: string
  name: string
  symbol: string
  decimals: number
}

export type Category = {
  id: string
  name: string
  color: string | null
  placement: 'main' | 'additional'
  sortOrder: number
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  version: number
}

export type Tag = {
  id: string
  name: string
  version: number
  createdAt: string
  updatedAt: string
}

export type Expense = {
  id: string
  amountMinor: number
  currency: string
  categoryId: string
  note: string | null
  tagIds?: string[]
  occurredAt: string
  createdAt: string
  updatedAt: string
  version: number
  deletedAt: string | null
  pending?: boolean
}

export type BybitRegion = 'global' | 'eu' | 'nl' | 'tr' | 'kz' | 'ge' | 'ae' | 'id'

export type BybitCardStatus = {
  connected: boolean
  canManage: boolean
  region?: BybitRegion
  enabledAt?: string
  lastSyncedAt?: string | null
  status?: 'active' | 'error'
  lastError?: string | null
  pendingCount: number
}

export type BybitCardTransaction = {
  id: string
  txnId: string | null
  orderNo: string | null
  type: 'purchase' | 'atm'
  amountMinor: number
  currency: string
  merchantName: string | null
  merchantCountry: string | null
  merchantCity: string | null
  mccCode: string | null
  merchantCategory: string | null
  occurredAt: string
  reviewStatus: 'pending' | 'classified' | 'ignored'
  expenseId: string | null
}

export type RateSnapshot = {
  base: 'RSD'
  date: string | null
  ratesToRsd: Record<string, number>
}

export type SyncResult = {
  operationId: string
  status: 'applied' | 'unchanged' | 'conflict' | 'error'
  expense?: Expense
  current?: Expense
  error?: { code: string; message: string }
  replayed?: boolean
}

export type AnalyticsData = {
  currency: string
  from: string
  to: string
  totalMinor: number
  expenseCount: number
  convertedCount: number
  rateDate: string | null
  missingCurrencies: string[]
  daily: { date: string; amountMinor: number; count: number }[]
  categories: { categoryId: string; name: string; color: string | null; amountMinor: number; count: number }[]
  weekdays: { weekday: number; amountMinor: number; count: number }[]
  calendar: { date: string; amountMinor: number; count: number }[]
}

export type UserProfile = {
  id: string
  displayName: string
  recoveryConfigured: boolean
  recoveryGeneration: number
}

export type WorkspaceSummary = {
  id: string
  name: string
  role: 'owner' | 'member'
  version: number
  joinedAt: string
}

export type AuthenticatedSession = {
  authenticated: true
  user: UserProfile
  currentSessionId: string
  currentSessionExpiresAt: string
  serverTime: string
  restrictedToRecovery: boolean
  workspaces: WorkspaceSummary[]
  legacyWorkspaceId: string | null
}

export type GuestSession = {
  authenticated: false
  user: null
  workspaces: []
  legacyClaimAvailable: boolean
  serverTime: string
}

export type SessionState = AuthenticatedSession | GuestSession

export type Participant = {
  userId: string
  displayName: string
  role: 'owner' | 'member'
  joinedAt: string
  isCurrentUser: boolean
}

export type DeviceSession = {
  id: string
  label: string
  createdAt: string
  lastSeenAt: string
  expiresAt: string
  current: boolean
}

export type InvitationMetadata = {
  id: string
  workspaceId: string
  expiresAt: string
  createdAt: string
}

export type InvitationPreview = {
  kind: 'invitation'
  workspace: Pick<WorkspaceSummary, 'id' | 'name'>
  expiresAt: string
}

export type DeviceLinkMetadata = { id: string; expiresAt: string }
export type DeviceLinkPreview = { kind: 'device'; targetUserId: string; displayName: string; expiresAt: string }
export type RecoveryPreview = { kind: 'recovery'; targetUserId: string; displayName: string }
export type RecoveryPrepareResponse = { recoveryUrl: string; completionToken: string; expiresAt: string; nextGeneration: number }

export type WorkspaceBootstrap = {
  workspaceId: string
  workspace: WorkspaceSummary
  expenses: Expense[]
  categories: Category[]
  tags?: Tag[]
  currencies: Currency[]
  rates: RateSnapshot
  defaultAnalyticsCurrency: string
  serverTime: string
}

export type WorkspaceOutboxItem = {
  userId: string
  workspaceId: string
  operationId: string
  type: 'createExpense' | 'updateExpense' | 'deleteExpense'
  payload: Record<string, unknown>
  createdAt: string
  status?: 'queued' | 'conflict' | 'failed'
  error?: string
  current?: Expense
}

export type OutboxStats = { total: number; conflicts: number; failed: number }

export type WorkspaceRuntime = {
  workspaceId: string
  bootstrap: WorkspaceBootstrap | null
  source: 'cache' | 'network' | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  offline: boolean
  outbox: OutboxStats
  requestEpoch: number
}

export type CapabilityIntent =
  | { kind: 'invite'; token: string }
  | { kind: 'device'; token: string }
  | { kind: 'recovery'; token: string }

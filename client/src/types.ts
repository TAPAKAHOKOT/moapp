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
  color: string | null
  sortOrder: number
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
  /** Set when the provider (Bybit Card, a T-Bank statement) declined or reversed the operation this expense came from. */
  voidedAt?: string | null
  voidReason?: ExpenseVoidReason | null
  pending?: boolean
}

/** Часть разделённого платежа: без `note`/`tagIds` она наследует их у исходной записи. */
export type ExpenseSplitPart = {
  amountMinor: number
  /** Без категории часть остаётся в категории исходной записи. */
  categoryId?: string
  note?: string | null
  tagIds?: string[]
}

export type ExpenseVoidReason = {
  provider: 'bybit-card' | 'tbank'
  kind: 'declined' | 'reversed'
  txnId: string | null
  merchantName: string | null
  amountMinor: number
  currency: string
}

export type BybitRegion = 'global' | 'eu' | 'nl' | 'tr' | 'kz' | 'ge' | 'ae' | 'id'

/** Состояние ключа Bybit: его показывают и шторка карты, и список модов. */
export type BybitCardState = {
  connected: boolean
  region?: BybitRegion
  enabledAt?: string
  lastSyncedAt?: string | null
  status?: 'active' | 'error'
  lastError?: string | null
}

export type BybitCardStatus = BybitCardState & {
  /** Всегда true: ключ подключает любой участник. Поле осталось от времени, когда это мог только владелец. */
  canManage: boolean
  pendingCount: number
}

/** Моды, которые знает этот клиент; незнакомые моды с сервера не показываются. */
export type ModId = 'bybit-card' | 'tbank'

/** Мод из каталога пространства. Добавленный Bybit рассказывает о своём ключе. */
export type WorkspaceMod = {
  id: ModId
  added: boolean
  addedAt: string | null
  state?: BybitCardState
}

/** Операция с карты в очереди разбора: пришла от Bybit сама или из загруженной выписки Т‑Банка. */
export type CardTransaction = {
  id: string
  source: 'bybit-card' | 'tbank'
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
  reviewStatus: 'pending' | 'classified' | 'ignored' | 'split'
  expenseId: string | null
  /** Часть разделённого платежа: её номер и общее число частей. У целой операции — null. */
  splitIndex?: number | null
  splitCount?: number | null
  /** false while the bank still holds the authorization; the amount may change when it settles */
  settled: boolean
}

/** Итог загрузки выписки: сколько трат встало в разбор и сколько уже было загружено раньше. */
export type TbankStatementResult = {
  imported: number
  known: number
  /** Строки, которые не удалось прочитать: без даты, суммы или валюты. */
  skipped: number
  pendingCount: number
}

export type RateSnapshot = {
  base: 'RSD'
  date: string | null
  ratesToRsd: Record<string, number>
  /** Rates to RSD by purchase day in the calendar the client asked for (tz), for the days that have expenses. Missing days fall back to the snapshot. */
  daily?: Record<string, Record<string, number>>
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
  /** Доли тегов; запись с несколькими тегами делится между ними поровну. `tagId: null` — записи без тегов. Старый сервер поле не присылает. */
  tags?: { tagId: string | null; name: string | null; color: string | null; amountMinor: number; count: number }[]
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
  /** ISO 4217 code a new expense starts in and totals default to. Absent in caches written before it existed. */
  currency?: string
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
  /** Display name of the person who created the link; absent when the creator cannot be resolved. */
  invitedBy?: string
}

export type DeviceLinkMetadata = { id: string; expiresAt: string }
export type DeviceLinkPreview = { kind: 'device'; targetUserId: string; displayName: string; expiresAt: string }
export type RecoveryPreview = { kind: 'recovery'; targetUserId: string; displayName: string }
export type RecoveryPrepareResponse = { recoveryUrl: string; completionToken: string; expiresAt: string; nextGeneration: number }

export type WorkspaceBootstrap = {
  workspaceId: string
  workspace: WorkspaceSummary
  /** The last twelve months of expenses; earlier ones are counted in `olderExpenses` and loaded on demand. */
  expenses: Expense[]
  /** First calendar day (client zone) covered by `expenses`. */
  expensesSince?: string
  /** Non-deleted expenses before `expensesSince` that are not included. */
  olderExpenses?: number
  /** The calendar the server used for days and daily rates. */
  timeZone?: string
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
  errorCode?: string
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

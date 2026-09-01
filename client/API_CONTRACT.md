# Client API contract

This document describes the API used by `src/workspace-api.ts` and its workspace-scoped offline data model. Paths are shown with their full `/api` prefix.

## Request rules

The client sends cookies with `credentials: 'include'`. The session cookie is server-managed, `HttpOnly`, `SameSite=Strict`, and `Secure` in production; client code never reads or stores it.

`GET /api/session` hydrates the active principal. Once its response is authenticated, `setSessionContext` records `user.id` and `currentSessionId`, and the shared request function adds:

```http
X-Moapp-Expected-User-Id: <user.id>
X-Moapp-Expected-Session-Id: <currentSessionId>
```

The server returns `409 SESSION_CONTEXT_CHANGED` if these values do not exactly match the cookie. The client deliberately suppresses them for `GET /api/session` and invitation/device/recovery preview calls. Guest-capable device/recovery calls have no expected-context headers before authentication and do include them when an authenticated context has already been hydrated.

The server validates the browser-supplied `Origin` on mutations and requires it to exactly match configured `APP_ORIGIN`. The request helper adds `Content-Type: application/json` whenever a body is supplied. All `POST`, `PATCH`, and `PUT` calls use JSON, including `{}` for an empty body. Expense/category deletes also send JSON `{version}`.

The following client calls send a bodyless `DELETE`, so they do not set JSON content type: logout, revoke another session, leave a workspace, remove a member, and revoke an invitation. A successful `204` is mapped to `undefined` without attempting to parse JSON.

All API responses except health are `Cache-Control: private, no-store`. The service worker caches the application shell, not API responses. Errors are exposed as `WorkspaceApiError(status, code, message, details)` from:

```json
{"error":{"code":"SESSION_CONTEXT_CHANGED","message":"...","details":{}}}
```

## Session and identity shapes

```ts
type UserProfile = {
  id: string
  displayName: string
  recoveryConfigured: boolean
  recoveryGeneration: number
}

type WorkspaceSummary = {
  id: string
  name: string
  role: 'owner' | 'member'
  version: number
  joinedAt: string
}

type GuestSession = {
  authenticated: false
  user: null
  workspaces: []
  legacyClaimAvailable: boolean
  serverTime: string
}

type AuthenticatedSession = {
  authenticated: true
  user: UserProfile
  currentSessionId: string
  currentSessionExpiresAt: string
  serverTime: string
  restrictedToRecovery: boolean
  workspaces: WorkspaceSummary[]
  legacyWorkspaceId: string | null
}

type DeviceSession = {
  id: string
  label: string
  createdAt: string
  lastSeenAt: string
  expiresAt: string
  current: boolean
}
```

The current client calls:

- `GET /api/session` → `GuestSession | AuthenticatedSession`.
- `POST /api/identity` with `{displayName}` → `201 AuthenticatedSession`.
- `PATCH /api/me` with `{displayName}` → `{user: UserProfile}`.
- `GET /api/me/sessions` → `{sessions: DeviceSession[]}`.
- `DELETE /api/me/sessions/:sessionId` → `204`; the current session must use logout.
- `DELETE /api/session` → `204` and clears the server session cookie.

There is no regular shared-PIN sign-in and no trusted-device marker. `POST /api/session` is retired; only `GET /api/session` and `DELETE /api/session` are current.

The browser stores one known user ID as an offline ownership guard, not as a credential. If the hydrated cookie belongs to another user, the client clears its request context and does not expose either profile's cached workspace data until that identity conflict is explicitly resolved.

## Workspaces and members

- `GET /api/workspaces` → `{workspaces: WorkspaceSummary[]}`.
- `POST /api/workspaces` with `{id,name}` → `{workspace}` (`201`, or `200` for a compatible retry).
- `PATCH /api/workspaces/:workspaceId` with `{name,version}` → `{workspace}`.
- `GET /api/workspaces/:workspaceId/members` → `{members: Participant[]}`.
- `DELETE /api/workspaces/:workspaceId/members/me` → `204`.
- `DELETE /api/workspaces/:workspaceId/members/:userId` → `204`.
- `POST /api/workspaces/:workspaceId/transfer-ownership` with `{userId,version}` → `{workspace}`.

`Participant` contains `userId`, `displayName`, `role`, `joinedAt`, and `isCurrentUser`. Rename, member removal, ownership transfer, and invitation management are owner-only. A nonmember receives `404 WORKSPACE_NOT_FOUND`, not a signal that distinguishes an existing private workspace from a missing one.

## Workspace bootstrap and offline scope

Every domain call puts the workspace ID in the path. `GET /api/workspaces/:workspaceId/bootstrap` returns:

```ts
type WorkspaceBootstrap = {
  workspaceId: string
  workspace: WorkspaceSummary
  expenses: Expense[]
  categories: Category[]
  currencies: Currency[]
  rates: { base: 'RSD'; date: string | null; ratesToRsd: Record<string, number> }
  defaultAnalyticsCurrency: string
  serverTime: string
}
```

Bootstrap contains active expenses and both active and archived categories. `ratesToRsd` is RSD per major unit of each source currency and always contains `RSD: 1`.

The client rejects a bootstrap whose `workspaceId` differs from the requested workspace. IndexedDB bootstrap records use the compound key `(userId, workspaceId)`. Outbox records use `(userId, workspaceId, operationId)`, and their stored `userId`/`workspaceId` must match the requested storage scope. Offline fallback reads only the current authenticated user's cache for the requested workspace.

Legacy v2 cache/outbox data remains quarantined until a completed legacy claim supplies the exact `legacyWorkspaceId`; migration then moves it into the scoped v3 stores. This storage guarantee applies to bootstrap and outbox records; it does not make capability secrets or a session cookie available offline.

## Expense routes and synchronization

```ts
type Expense = {
  id: string
  amountMinor: number
  currency: string
  categoryId: string
  note: string | null
  occurredAt: string
  createdAt: string
  updatedAt: string
  version: number
  deletedAt: string | null
}
```

`amountMinor` is a positive safe integer in the currency's minor units, `currency` is ISO 4217, and `note` is nullable with a server maximum of 500 characters.

- `GET /api/workspaces/:workspaceId/expenses?...` → `{expenses: Expense[], nextCursor: string | null}`. Supported filters are `from`, `to`, `categoryId`, `currency`, `cursor`, `limit`, and `includeDeleted`; the server caps `limit` at 200. The current `listExpenses` wrapper declares only `{expenses}` and does not expose `nextCursor` in its static return type.
- `GET /api/workspaces/:workspaceId/expenses/:expenseId` → `Expense`.
- `POST /api/workspaces/:workspaceId/expenses` with complete expense input → `201 Expense`, or `200 Expense` for a compatible ID retry.
- `PATCH /api/workspaces/:workspaceId/expenses/:expenseId` with changed fields and `version` → `Expense`.
- `DELETE /api/workspaces/:workspaceId/expenses/:expenseId` with `{version}` → `204` and soft-deletes the expense.

The offline write path uses `POST /api/workspaces/:workspaceId/sync` with at most 200 operations:

```ts
type SyncOperation = {
  operationId: string
  type: 'createExpense' | 'updateExpense' | 'deleteExpense'
  payload: Record<string, unknown>
}

type SyncResult = {
  operationId: string
  status: 'applied' | 'unchanged' | 'conflict' | 'error'
  expense?: Expense
  current?: Expense
  error?: { code: string; message: string }
  replayed?: boolean
}
```

The canonical response is `{workspaceId,results,serverTime}`. The server stores replay results by `(workspaceId, operationId)`. The client persists an operation before its first attempt and retains the same operation ID after an abort or lost response. Applied/unchanged results leave the outbox; conflicts retain the server's `current` expense. Batched error results are marked failed, while the single-operation submission path removes a terminal error. Sync is performed separately per workspace. The current helper rejects a mismatching response `workspaceId`, although its compatibility typing still permits that field to be omitted; the implemented server always includes it.

## Categories

The server wire category shape is:

```ts
type Category = {
  id: string
  name: string
  color: string | null
  placement: 'main' | 'additional'
  sortOrder: number
  archivedAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}
```

The client model matches this response shape. UI-created categories start with a color, while older or imported categories may legitimately have `color: null`.

- `GET /api/workspaces/:workspaceId/categories?includeArchived=false` → `{categories}`.
- `POST /api/workspaces/:workspaceId/categories` with `{id?,name,placement,sortOrder?,color?}` → `201 Category`, or `200 Category` for a compatible UUID retry.
- `PATCH /api/workspaces/:workspaceId/categories/:categoryId` with changed fields plus `version` → `Category`; `archived` or an ISO/null `archivedAt` archives or restores it.
- `DELETE /api/workspaces/:workspaceId/categories/:categoryId` with `{version}` → `204` and archives it.
- `PUT /api/workspaces/:workspaceId/categories/order` with `{ids}` → `{categories}`.

Category mutations are online requests. A stale category or expense version returns `409 VERSION_CONFLICT`; `error.details.current` contains the canonical current object. Incompatible create retries return `409 IDEMPOTENCY_CONFLICT`.

## Bybit Card integration

The client exposes workspace-scoped status, connection, disconnection, manual
sync, review-list, classify, ignore, and guarded undo calls. These mutations are online-only.
The connection UI displays `enabledAt`: transactions before that instant are
never imported. Review items remain outside `Expense[]` and analytics until
classification returns a normal expense and adds it to the workspace bootstrap.
Undo supplies the returned expense id/version, removes an unchanged classified
expense from the bootstrap, and restores its provider transaction to review.

## Analytics and rates

`GET /api/workspaces/:workspaceId/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD&currency=RSD&categoryId=` returns:

```ts
type AnalyticsData = {
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
```

The current wrapper supplies `from`, `to`, and `currency`; `categoryId` is optional. `missingCurrencies` identifies expenses omitted from converted totals, and `rateDate` is nullable. Date filters use the `Europe/Belgrade` calendar while expense instants remain ISO UTC.

The server also exposes normal-session-only global rate routes:

- `GET /api/rates/status`
- `POST /api/rates/refresh` (JSON mutation; send `{}`)
- `GET /api/rates/convert?amount=&from=&to=&date=`

They require expected-context headers but no workspace membership. `src/workspace-api.ts` currently has no dedicated wrapper functions for these three routes; rate data used by the current client arrives through bootstrap and analytics.

## Invitations

- `GET /api/workspaces/:workspaceId/invitations` → `{invitations: InvitationMetadata[]}` for active invitations only. Metadata contains `id`, `workspaceId`, `expiresAt`, and `createdAt`, never the secret URL.
- `POST /api/workspaces/:workspaceId/invitations` with `{ttlHours?}` → `201 {invitation,url}`.
- `DELETE /api/workspaces/:workspaceId/invitations/:invitationId` → `204` with no body.
- `POST /api/access/invitations/preview` with `{token}` → `{kind:'invitation',workspace:{id,name},expiresAt}`.
- `POST /api/access/invitations/accept` with `{token}` → `{workspace}` and requires a normal session.

Invitation management is owner-only. Accepting while already a member returns `409 ALREADY_MEMBER`.

Revoking a session also invalidates device links created by or accepted into it and its active unconsumed invitations. Removing a member invalidates invitations that member created for that workspace; transferring ownership invalidates all active unconsumed invitations for the workspace.

## Device links

- `POST /api/me/device-links` with `{}` → `201 {deviceLink:{id,expiresAt},url}`.
- `POST /api/access/device-links/preview` with `{token}` → `{kind:'device',targetUserId,displayName,expiresAt}`.
- `POST /api/access/device-links/accept` with `{token,attemptToken}` → `AuthenticatedSession` and a new cookie.

`attemptToken` is a stable caller-generated 32-byte base64url value. It must be reused after a lost response: a consumed link with the same attempt token can return a fresh `AuthenticatedSession` while its accepted session/link remains valid; a different attempt receives `410 LINK_INVALID`. Accept can run without an existing session. An already hydrated session first needs matching expected-context headers and then must match the target identity. Failures are `409 SESSION_CONTEXT_CHANGED`, `409 IDENTITY_CONFLICT`, or `409 ALREADY_CONNECTED` as applicable.

## Recovery

- `POST /api/me/recovery/rotation/prepare` with `{}` → `{recoveryUrl,completionToken,expiresAt,nextGeneration}`.
- `POST /api/me/recovery/rotation/complete` with `{completionToken}` → `AuthenticatedSession`.
- `POST /api/access/recovery/preview` with `{token}` → `{kind:'recovery',targetUserId,displayName}`.
- `POST /api/access/recovery/prepare` with `{token}` → `{recoveryUrl,completionToken,expiresAt,nextGeneration}`.
- `POST /api/access/recovery/complete` with `{completionToken}` → `AuthenticatedSession` and a new cookie.

Recovery rotation is two-phase. The replacement URL is not active at `prepare`; the user must save it in an appropriate secret store before calling `complete`. The client keeps the URL and completion token only in transient state, not application storage. External recovery completion rotates the recovery secret and revokes old sessions, active device links targeting the user, and active unconsumed invitations created by the user. A concurrent generation change returns `409 ROTATION_STALE`; stale expected headers return `409 SESSION_CONTEXT_CHANGED`; a correctly contextualized different identity returns `409 IDENTITY_CONFLICT`.

## Capability-fragment secrecy

Invitation, device, and recovery URLs use `#/join/<secret>`, `#/device/<secret>`, and `#/recover/<secret>`. Because the token is a URL fragment, it is not sent in the initial HTTP request or Referer. Before application/service-worker startup, the client extracts a valid fragment into memory and immediately replaces browser history with `/`. It does not put capability tokens in IndexedDB or local storage.

The raw token is sent only in a JSON body to the corresponding `/api/access/...` endpoint. Preview does not consume it. Invalid, expired, consumed, or revoked tokens return `410 LINK_INVALID` without revealing the condition, except for the same-attempt device retry described above. Capability URLs, raw tokens, `attemptToken`, and `completionToken` must never be logged or stored by the application. The recovery URL is deliberately copied or saved by the user outside application storage before completion.

## One-time legacy claim and retired clients

`POST /api/legacy-claim` with `{pin,displayName,attemptToken}` is a one-time migration bridge, not normal authentication. `attemptToken` is a stable caller-generated 32-byte base64url value. Success returns an `AuthenticatedSession` with `restrictedToRecovery: true`, `workspaces: []`, and `legacyWorkspaceId`. The restricted session must complete `/api/me/recovery/rotation/prepare` and `/complete`; the completion response is a normal session and exposes the user's workspaces.

`legacyClaimAvailable` on `GuestSession` controls whether a claim can currently start. Wrong PIN returns `401 INVALID_PIN`, a competing claim returns `409 CLAIM_IN_PROGRESS`, and a closed claim returns `410 UPGRADE_REQUIRED`.

Old PIN methods (`POST /api/session`, `POST /api/auth/login`, `GET /api/auth/session`, `POST /api/auth/logout`) and old unscoped domain routes (`/api/bootstrap`, `/api/expenses`, `/api/categories`, `/api/analytics`, `/api/sync`, including their former item/order methods) return `410 UPGRADE_REQUIRED`. Current client calls must not fall back to those retired routes.

## Error handling

- `400 VALIDATION` or `400 REQUEST_ERROR`: invalid query, path, or JSON body.
- `401 UNAUTHORIZED`: no normal session, or a restricted session attempted a normal-only route.
- `403 FORBIDDEN`: exact-Origin failure or insufficient owner permission.
- `404 WORKSPACE_NOT_FOUND`: missing workspace or missing membership, intentionally indistinguishable.
- `404 NOT_FOUND`: missing object inside an accessible workspace.
- `409 SESSION_CONTEXT_CHANGED`: another profile/session replaced the hydrated context; rehydrate before doing more work.
- `409 VERSION_CONFLICT`: optimistic concurrency failure; use `details.current` when supplied.
- `409 IDEMPOTENCY_CONFLICT`: a client ID was reused with different input.
- `409 IDENTITY_CONFLICT`: an access capability belongs to a different profile.
- Other flow-specific `409` codes include `ALREADY_AUTHENTICATED`, `ALREADY_MEMBER`, `ALREADY_CONNECTED`, `OWNER_CANNOT_LEAVE`, `USE_LOGOUT`, `CLAIM_IN_PROGRESS`, `ROTATION_STALE`, and category-name `DUPLICATE`.
- `415 REQUEST_ERROR`: a bodyful mutation did not use JSON content type.
- `410 LINK_INVALID`: invalid/expired/consumed/revoked capability.
- `410 UPGRADE_REQUIRED`: retired client method or unavailable legacy claim.
- `429 RATE_LIMITED`: honor `Retry-After`.

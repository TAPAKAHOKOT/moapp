# Moapp API contract

This document describes the implemented account/workspace API. Normal application endpoints are under `/api`; OAuth discovery/authorization and MCP use the dedicated public paths described below.

## Transport, sessions, and errors

`GET /api/health` is the public liveness/database check and is the only API response without the explicit private no-store policy. Every other `/api/*` response sends `Cache-Control: private, no-store`; session hydration and capability previews are also callable without a session as described below.

Normal authentication uses a signed, `HttpOnly`, `SameSite=Strict`, `Path=/` cookie. Its name is `__Host-moapp_session` when secure cookies are enabled and `moapp_session` otherwise; production cookies are `Secure`. Only a SHA-256 hash of the random session token is stored in SQLite.

After `GET /api/session` returns an authenticated session, clients must send both of these headers on normal-session and restricted-session protected requests:

```http
X-Moapp-Expected-User-Id: <user.id>
X-Moapp-Expected-Session-Id: <currentSessionId>
```

They must exactly match the current cookie principal. Missing or mismatched values return `409 SESSION_CONTEXT_CHANGED` before protected data is read. `GET /api/session`, guest identity creation, and capability preview requests intentionally do not require these headers. Guest-capable device/recovery requests do not require them for a guest, but do require them when a valid normal cookie is present. A valid restricted legacy-claim session also needs them for its allowed recovery requests, claim retry, and logout.

Unless a route is explicitly described as public, guest-capable, or restricted-session-capable, it requires a normal session and both expected-context headers. A `/api/workspaces/:workspaceId/...` route additionally requires membership in that workspace.

Every current mutation requires `Origin` to exactly equal configured `APP_ORIGIN`; otherwise it returns `403 FORBIDDEN`. All current `POST`, `PATCH`, and `PUT` requests, plus the expense/category `DELETE` requests, are JSON mutations and require `Content-Type: application/json`. Capability previews are included even though they do not consume the link. Use `{}` for an empty JSON body. These mutations are explicitly bodyless and reject a body:

- `DELETE /api/session`
- `DELETE /api/me/sessions/:sessionId`
- `DELETE /api/workspaces/:workspaceId/members/me`
- `DELETE /api/workspaces/:workspaceId/members/:userId`
- `DELETE /api/workspaces/:workspaceId/invitations/:invitationId`

A successful bodyless response is `204` with no JSON. Errors use one envelope:

```json
{"error":{"code":"VERSION_CONFLICT","message":"Expense was changed","details":{"current":{}}}}
```

Validation errors are normally `400`; missing JSON content type is `415`. Protected-route authentication failures are `401`; the one-time claim also uses `401 INVALID_PIN`. `403 FORBIDDEN` covers exact-Origin rejection and insufficient owner permission. A missing workspace membership is deliberately indistinguishable from a missing workspace: `404 WORKSPACE_NOT_FOUND`. A missing object inside an accessible workspace is `404 NOT_FOUND`.

Amounts are positive safe integers in currency minor units. Currency codes are ISO 4217. Timestamps are ISO 8601 instants; analytics filters use `YYYY-MM-DD` calendar dates in `Europe/Belgrade`. Client-created workspace, expense, sync-operation, and optional category IDs are UUIDs. Versioned mutations use integer optimistic-concurrency versions.

`GET /api/health` returns `{status:'ok'|'degraded',database,time}`.

## OAuth 2.1 and MCP

Moapp exposes a stateless, JSON-response Streamable HTTP MCP endpoint at
`POST /mcp`. `GET` and `DELETE /mcp` return `405` because the implementation
does not keep MCP sessions or server-initiated streams. Every MCP request
requires `Authorization: Bearer <access token>` and the `history:read` scope.
Missing or invalid credentials return `401` with a `WWW-Authenticate` challenge
pointing to protected-resource metadata.

Discovery endpoints:

- `GET /.well-known/oauth-protected-resource` (also available with `/mcp` appended);
- `GET /.well-known/oauth-authorization-server`;
- `POST /oauth/register` for public-client dynamic registration;
- `GET|POST /oauth/authorize` for consent through the existing normal Moapp session;
- `POST /oauth/token` for `authorization_code` and rotating `refresh_token` grants;
- `POST /oauth/revoke` for access- or refresh-token revocation.

The flow requires S256 PKCE, the exact resource `${APP_ORIGIN}/mcp`, an exact
registered redirect URI, and the single `history:read` scope. Access tokens
expire after one hour; refresh tokens expire after 30 days and rotate on every
use. Authorization codes are single-use and expire after five minutes. Only
SHA-256 hashes of codes and tokens are stored in SQLite. OAuth endpoints return
`Cache-Control: no-store`.

The authorization page does not introduce another identity provider. It uses
the signed `SameSite=Strict` Moapp cookie but intentionally does not require
the API expected-context headers, since it is a browser redirect rather than
an API client request. The first cross-site navigation may not carry the strict
cookie; the page provides a same-origin continuation before consent. Consent
submissions use a ten-minute HMAC-signed CSRF token bound to the active session,
OAuth client, redirect URI, resource, state, and PKCE challenge. A present
foreign `Origin` is rejected; a missing or opaque `Origin` is accepted only
with that valid form token for compatibility with sandboxed OAuth windows.

Available read-only tools:

- `list_workspaces` returns the connected profile's current workspace IDs,
  names, and roles;
- `get_expense_history` accepts `workspaceId`, optional inclusive `from`/`to`
  Belgrade calendar dates, `categoryId`, `tagId`, `currency`, `limit` (up to 200), and
  an opaque pagination `cursor`. It returns exact minor-unit and decimal
  amounts, category names, tag ids and names (`tagIds`, `tags`), notes, local dates, and `nextCursor`.

Tool calls recheck live membership before reading tenant data. Losing
membership immediately removes access even while the OAuth token remains
valid. Deleted expenses are never returned, and a foreign workspace is
indistinguishable from a missing workspace. MCP exposes no write tools.

## Session response

`GET /api/session` is the session hydration endpoint and never needs expected-context headers. It returns one of:

```ts
type GuestSession = {
  authenticated: false
  user: null
  workspaces: []
  legacyClaimAvailable: boolean
  serverTime: string
}

type AuthenticatedSession = {
  authenticated: true
  user: {
    id: string
    displayName: string
    recoveryConfigured: boolean
    recoveryGeneration: number
  }
  currentSessionId: string
  currentSessionExpiresAt: string
  serverTime: string
  restrictedToRecovery: boolean
  workspaces: WorkspaceSummary[]
  legacyWorkspaceId: string | null
}
```

A restricted legacy-claim session has `restrictedToRecovery: true` and `workspaces: []`. It may use only session hydration/logout, retry the legacy claim, and the initial recovery rotation endpoints described below. A normal session may slide its expiry during hydration or protected requests.

## Identity and sessions

- `POST /api/identity` with `{displayName}` creates a new profile and normal session. It returns `AuthenticatedSession` with `201`. A browser with a valid session gets `409 ALREADY_AUTHENTICATED`.
- `PATCH /api/me` with `{displayName}` returns `{user}`.
- `GET /api/me/sessions` returns `{sessions: DeviceSession[]}` for active, unexpired sessions. Each item has `id`, `label`, `createdAt`, `lastSeenAt`, `expiresAt`, and `current`.
- `DELETE /api/me/sessions/:sessionId` returns `204`. It only revokes another session owned by the current user; the current session returns `409 USE_LOGOUT`. Revocation also invalidates device links created by or accepted into that session and its active unconsumed invitations.
- `DELETE /api/session` returns `204`, revokes a valid current session, clears the cookie, and applies the same access-link revocation. With no valid cookie it is idempotent and still returns `204`.

There is no ordinary shared-PIN login. `POST /api/session` is a retired method and returns `410 UPGRADE_REQUIRED`; the same path remains valid for `GET` hydration and `DELETE` logout.

## Workspaces and members

```ts
type WorkspaceSummary = {
  id: string
  name: string
  role: 'owner' | 'member'
  version: number
  joinedAt: string
}

type Participant = {
  userId: string
  displayName: string
  role: 'owner' | 'member'
  joinedAt: string
  isCurrentUser: boolean
}
```

- `GET /api/workspaces` returns `{workspaces: WorkspaceSummary[]}`.
- `POST /api/workspaces` with `{id,name}` returns `{workspace}` with `201`. A compatible retry returns `200`; reuse of the ID with different data returns `409 IDEMPOTENCY_CONFLICT`.
- `PATCH /api/workspaces/:workspaceId` with `{name,version}` returns `{workspace}`. It is owner-only; a stale version returns `409 VERSION_CONFLICT`.
- `GET /api/workspaces/:workspaceId/members` returns `{members: Participant[]}`.
- `DELETE /api/workspaces/:workspaceId/members/me` returns `204`. The owner must transfer ownership first and otherwise receives `409 OWNER_CANNOT_LEAVE`.
- `DELETE /api/workspaces/:workspaceId/members/:userId` returns `204` and is owner-only. The owner cannot remove themself. Removing a member revokes that user's active unconsumed invitations for the workspace.
- `POST /api/workspaces/:workspaceId/transfer-ownership` with `{userId,version}` returns `{workspace}`. The target must already be a member; a successful transfer revokes all active unconsumed invitations for that workspace.

Owner-only actions return `403 FORBIDDEN` to a member. Membership/owner mutations recheck the relevant membership or ownership inside their transaction.

## Workspace bootstrap

`GET /api/workspaces/:workspaceId/bootstrap` returns all archived and active categories, all tags, active expenses only, currency metadata, the latest RSD rate snapshot, and the current workspace summary:

```ts
type WorkspaceBootstrap = {
  workspaceId: string
  workspace: WorkspaceSummary
  categories: Category[]
  tags: Tag[]
  expenses: Expense[]
  currencies: { code: string; name: string; symbol: string; decimals: number }[]
  rates: { base: 'RSD'; date: string | null; ratesToRsd: Record<string, number> }
  defaultAnalyticsCurrency: string
  serverTime: string
}
```

`ratesToRsd` is the number of RSD per major unit of the source currency and always contains `RSD: 1`.

## Expenses

```ts
type Expense = {
  id: string
  amountMinor: number
  currency: string
  categoryId: string
  occurredAt: string
  note: string | null
  tagIds: string[]
  version: number
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}
```

`tagIds` is always present and sorted. Create and update accept an optional `tagIds` array (unique, at most 20, every id must belong to the workspace); an unknown id returns `400 TAG_INVALID`. Omitting `tagIds` on `PATCH` keeps the current tags, sending `[]` clears them. The idempotent `POST` retry compares `tagIds` only when the retry includes them.

- `GET /api/workspaces/:workspaceId/expenses?from=&to=&categoryId=&tagId=&currency=&cursor=&limit=50&includeDeleted=false` returns `{expenses,nextCursor}`. `limit` is capped at 200 and `nextCursor` is `string | null`.
- `GET /api/workspaces/:workspaceId/expenses/:id` returns one `Expense`.
- `POST /api/workspaces/:workspaceId/expenses` accepts complete `{id,amountMinor,currency,categoryId,occurredAt,note?,tagIds?}` and returns an `Expense` with `201`. A compatible ID retry returns the existing expense with `200`; incompatible reuse returns `409 IDEMPOTENCY_CONFLICT` with `details.current`.
- `PATCH /api/workspaces/:workspaceId/expenses/:id` accepts changed fields plus required `version` and returns the updated `Expense`.
- `DELETE /api/workspaces/:workspaceId/expenses/:id` requires JSON `{version}` and returns `204`; deletion is soft.

Notes are trimmed, nullable, and at most 500 characters. Creating or updating against an absent/archived category returns `400 CATEGORY_INVALID`. A stale expense version returns `409 VERSION_CONFLICT` with the current expense in `error.details.current`.

## Categories

```ts
type Category = {
  id: string
  name: string
  placement: 'main' | 'additional'
  sortOrder: number
  color: string | null
  version: number
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}
```

- `GET /api/workspaces/:workspaceId/categories?includeArchived=false` returns `{categories}`. Only the literal value `true` includes archived categories.
- `POST /api/workspaces/:workspaceId/categories` accepts `{id?,name,placement,sortOrder?,color?}` and returns a `Category` with `201`. A compatible UUID retry returns `200`; incompatible reuse returns `409 IDEMPOTENCY_CONFLICT`.
- `PATCH /api/workspaces/:workspaceId/categories/:id` accepts changed fields plus required `version`; `archived` may archive/restore the category, and `archivedAt` accepts an ISO timestamp or `null`. It returns the updated `Category`.
- `DELETE /api/workspaces/:workspaceId/categories/:id` requires JSON `{version}` and returns `204`; it archives rather than removes history.
- `PUT /api/workspaces/:workspaceId/categories/order` with `{ids}` returns `{categories}`. The unique array must contain every active category or every active category in one placement group.

A stale category version returns `409 VERSION_CONFLICT` with `error.details.current`.

## Tags

Tags are short workspace-level labels that can be attached to any expense regardless of its category. An expense carries at most 20 tags.

```ts
type Tag = {
  id: string
  name: string
  color: string | null
  sortOrder: number
  version: number
  createdAt: string
  updatedAt: string
}
```

- `GET /api/workspaces/:workspaceId/tags` returns `{tags}` ordered by name.
- `POST /api/workspaces/:workspaceId/tags` accepts `{id?,name,color?}` and returns a `Tag` with `201`; `color` is `#RRGGBB` or `null`, and the new tag is appended to the end of the order. Names are NFKC-normalized, trimmed, collapse inner whitespace, and are 1-30 characters. A compatible UUID retry returns `200`; a different name for an existing id returns `409 IDEMPOTENCY_CONFLICT`. A name that already exists (case-insensitive, including Cyrillic) returns `409 DUPLICATE` with the existing tag in `error.details.current`.
- `PATCH /api/workspaces/:workspaceId/tags/:id` accepts any of `name`, `color`, `sortOrder` plus required `version` and returns the updated `Tag`.
- `PUT /api/workspaces/:workspaceId/tags/order` with `{ids}` returns `{tags}`; the unique array must list every tag of the workspace exactly once and becomes the display order (`sortOrder`).
- `DELETE /api/workspaces/:workspaceId/tags/:id` requires JSON `{version}` and returns `204`. Deletion is hard: the tag is detached from every expense, the expenses themselves stay.

A stale tag version returns `409 VERSION_CONFLICT` with `error.details.current`.

## Offline synchronization

`POST /api/workspaces/:workspaceId/sync` accepts at most 200 operations and applies the batch in one transaction:

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

The response is exactly `{workspaceId,results,serverTime}`. Replay identity is `(workspaceId, operationId)`: a retry in the same workspace returns the stored result with `replayed: true` and never reapplies the mutation. Conflict results include the current expense when available. Membership is rechecked as the first read inside the batch transaction.

## Bybit Card integration

The optional integration is workspace-scoped. Only the workspace owner can
connect, replace, or remove credentials; every member may read and classify the
shared review queue. Credentials are accepted only for a read-only Bybit API key
with the `BitCard` permission and are encrypted before storage.

- `GET /api/workspaces/:workspaceId/integrations/bybit-card` returns connection state, `enabledAt`, last sync state, management capability, and `pendingCount`.
- `POST /api/workspaces/:workspaceId/integrations/bybit-card` accepts `{apiKey,apiSecret,region}`. A successful replacement resets `enabledAt` to the current server instant and discards the old provider queue.
- `DELETE /api/workspaces/:workspaceId/integrations/bybit-card` requires `{}`. Classified expenses remain.
- `POST /api/workspaces/:workspaceId/integrations/bybit-card/sync` requires `{}` and polls cleared card transactions.
- `GET /api/workspaces/:workspaceId/integrations/bybit-card/transactions?limit=` returns oldest-first pending transactions, capped at 200.
- `POST .../transactions/:transactionId/classify` accepts `{categoryId,comment,tagIds?}` and atomically creates an expense carrying those tags. Compatible retries return the linked expense.
- `POST .../transactions/:transactionId/ignore` requires `{}` and removes the item from review without creating an expense.
- `POST .../transactions/:transactionId/undo` returns an ignored item to review. For a classified item it accepts `{expenseId,expenseVersion}` and soft-deletes the linked expense only if that version is still current; otherwise it returns `409 UNDO_CONFLICT`.

Both the provider query and the storage transaction enforce
`occurredAt >= enabledAt`. Subsequent polls overlap recent time to absorb delayed
clearing but never move that boundary backwards. The provider is queried with
`type=SIDE_QUERY_AUTH` in the JSON body (the only value the live API accepts),
paged at 100 records with a one-second pause between pages. Settled payments
(`tradeStatus=1`) and open authorizations (`tradeStatus=0`) with `status=1` enter
review; each transaction carries `settled`. Open authorizations are refreshed on
every poll (the window always reaches back to the oldest one) until they settle,
which may change the amount, or are declined/reversed, which removes a still
pending item from review and leaves an already classified expense untouched.
Declined records are never imported. The imported amount is what was actually
paid (`paidAmount`/`paidCurrency`, e.g. RSD), falling back to the card-currency
total. `type` is `atm` for side 13 or MCC 6011.

## Analytics and rates

`GET /api/workspaces/:workspaceId/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD&currency=RSD&categoryId=` returns:

```ts
{
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

All four query parameters are optional: `from` defaults to the first day of the current Belgrade month, `to` to the current Belgrade date, and `currency` to the configured analytics currency. `categoryId` narrows the result. Missing conversions are omitted from converted totals and reported in `missingCurrencies`; `expenseCount` still counts all matching expenses.

Rate routes are global rather than workspace-scoped, but still require a normal session and expected-context headers:

- `GET /api/rates/status` returns `{rateDate:string|null,fetchedAt:string|null,count:number}`.
- `POST /api/rates/refresh` is a JSON mutation (send `{}`) and returns `{fetched:number,dates:string[]}`; an upstream failure returns `502 RATES_UNAVAILABLE`.
- `GET /api/rates/convert?amount=10&from=EUR&to=RSD&date=2026-08-03` converts a major-unit amount and returns `{amount,rateDate,currency}`; no cached conversion returns `503 RATE_MISSING`.

## Invitations and capability links

Capability URLs are returned as `${APP_ORIGIN}/#/join/<secret>`, `${APP_ORIGIN}/#/device/<secret>`, or `${APP_ORIGIN}/#/recover/<secret>`. The secret is in the fragment so it is not sent in the initial HTTP request or Referer. The server stores only a hash. Raw URLs are returned only at creation/preparation and never by list endpoints. Callers must treat the URL, raw token, attempt token, and completion token as secrets and must not log or put them in application storage. A recovery URL must instead be saved by the user in an appropriate secret store before rotation is completed.

Invitation management is owner-only:

- `GET /api/workspaces/:workspaceId/invitations` returns `{invitations}` with active items `{id,workspaceId,expiresAt,createdAt}`; it never returns a token or URL.
- `POST /api/workspaces/:workspaceId/invitations` accepts `{ttlHours?}` and returns `201 {invitation,url}`.
- `DELETE /api/workspaces/:workspaceId/invitations/:invitationId` is bodyless and returns `204`.
- `POST /api/access/invitations/preview` with `{token}` returns `{kind:'invitation',workspace:{id,name},expiresAt}` without consuming it.
- `POST /api/access/invitations/accept` with `{token}` requires a normal session and returns `{workspace}`. An existing member gets `409 ALREADY_MEMBER`.

An invalid, expired, consumed, or revoked capability normally returns `410 LINK_INVALID` without disclosing which condition applied. The exception is a consumed device link retried with its original `attemptToken` while its accepted session/link remains valid: that lost-response recovery returns a fresh `AuthenticatedSession` and replaces the prior accepted session. A different attempt token still receives `410 LINK_INVALID`.

## Device links

- `POST /api/me/device-links` with `{}` requires a normal session and returns `201 {deviceLink:{id,expiresAt},url}`.
- `POST /api/access/device-links/preview` with `{token}` returns `{kind:'device',targetUserId,displayName,expiresAt}`.
- `POST /api/access/device-links/accept` with `{token,attemptToken}` returns `AuthenticatedSession` and sets the cookie. `attemptToken` is a stable, caller-generated 32-byte base64url value used for safe retries.

Accept may run as a guest. If a valid normal cookie is present, its expected-context headers are required and its user must match the link target. Conflicts return `409 IDENTITY_CONFLICT` or `409 ALREADY_CONNECTED`.

## Recovery rotation

Recovery rotation is two-phase. `prepare` returns a new recovery URL plus a short-lived completion token; the new recovery secret is not activated until `complete`. The recovery URL must be saved before completion. Reusing an old generation after another rotation completed returns `409 ROTATION_STALE`.

- `POST /api/me/recovery/rotation/prepare` with `{}` requires the current normal or restricted legacy-claim session and returns `{recoveryUrl,completionToken,expiresAt,nextGeneration}`.
- `POST /api/me/recovery/rotation/complete` with `{completionToken}` requires that same session and returns `AuthenticatedSession`. Completing the initial restricted flow closes the legacy claim and replaces the restricted cookie with a normal session.
- `POST /api/access/recovery/preview` with `{token}` returns `{kind:'recovery',targetUserId,displayName}`.
- `POST /api/access/recovery/prepare` with `{token}` returns `{recoveryUrl,completionToken,expiresAt,nextGeneration}`.
- `POST /api/access/recovery/complete` with `{completionToken}` rotates recovery, revokes the user's old sessions, active device links targeting the user, and active unconsumed invitations created by the user, creates a normal session, and returns `AuthenticatedSession`.

External recovery prepare/complete may run as a guest. A valid normal cookie requires expected-context headers; a missing/mismatched context returns `409 SESSION_CONTEXT_CHANGED`. Once the context matches, a cookie belonging to another profile returns `409 IDENTITY_CONFLICT`.

## One-time legacy claim and retired API

`POST /api/legacy-claim` is the only use of the old shared PIN. It is a one-time migration bridge, not a login endpoint. The JSON body is `{pin,displayName,attemptToken}`, where `attemptToken` is a stable, caller-generated 32-byte base64url value. Success returns `200 AuthenticatedSession` restricted to recovery setup. The client must complete `/api/me/recovery/rotation/prepare` and `/complete` before normal workspace access is available.

Wrong PIN returns `401 INVALID_PIN`; an incompatible active claim returns `409 CLAIM_IN_PROGRESS`; a normal cookie returns `409 ALREADY_AUTHENTICATED`; and a closed/unavailable claim returns `410 UPGRADE_REQUIRED`. A matching valid restricted retry is non-destructive and returns the current restricted session.

These old authentication methods always return `410 UPGRADE_REQUIRED`:

- `POST /api/session`
- `POST /api/auth/login`
- `GET /api/auth/session`
- `POST /api/auth/logout`

These old unscoped domain methods also return `410 UPGRADE_REQUIRED`:

- `GET /api/bootstrap`
- `GET|POST /api/expenses`
- `GET|PATCH|DELETE /api/expenses/:id`
- `GET|POST /api/categories`
- `PATCH|DELETE /api/categories/:id`
- `PUT /api/categories/order`
- `GET /api/analytics`
- `POST /api/sync`

Clients must use `/api/workspaces/:workspaceId/...`.

## Important conflict/status codes

- `409 SESSION_CONTEXT_CHANGED`: the cookie no longer matches the hydrated user/session.
- `409 VERSION_CONFLICT`: a versioned resource changed; expense/category errors include `details.current`.
- `409 IDEMPOTENCY_CONFLICT`: a client ID was reused with different create data.
- `409 IDENTITY_CONFLICT`: a capability belongs to another profile.
- Other resource-specific `409` codes include `ALREADY_AUTHENTICATED`, `ALREADY_MEMBER`, `ALREADY_CONNECTED`, `OWNER_CANNOT_LEAVE`, `USE_LOGOUT`, `CLAIM_IN_PROGRESS`, `ROTATION_STALE`, and `DUPLICATE`.
- `410 LINK_INVALID`: an access secret is invalid, expired, consumed, or revoked.
- `410 UPGRADE_REQUIRED`: a retired PIN/unscoped API or unavailable legacy claim was used.
- `429 RATE_LIMITED`: retry later; rate-limited responses include `Retry-After`.

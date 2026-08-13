# 00. Целевая архитектура

## 1. Цель

Добавить несколько изолированных пространств и доступ без формы регистрации,
email и пароля, сохранив простой повседневный сценарий Moapp.

Пользователь должен уметь:

- создать первое пространство с главной страницы;
- создать последующие пространства из настроек;
- мгновенно переключаться между добавленными пространствами через шапку;
- пригласить отдельного человека одноразовой ссылкой или QR;
- подключить дополнительное собственное устройство отдельной ссылкой;
- восстановить свой профиль и все доступные ему пространства личной recovery
  link;
- видеть участников пространства отдельно от своих подключённых устройств.

## 2. Зафиксированные решения

### Профиль без регистрации

`user` — серверный профиль со случайным ID и отображаемым именем. Имя не
уникально, не является логином и не подтверждает личность. Email, пароль и
внешний OAuth в этой версии отсутствуют.

Чистый браузер не создаёт профиль автоматически. В UI создание первого
пространства и принятие приглашения остаются одной короткой формой, но внутри
выполняются в два шага:

1. `POST /api/identity` создаёт только профиль и session.
2. Уже authenticated запрос создаёт workspace или принимает invitation.

Так потерянный первый HTTP-ответ может оставить только пустой профиль, но не
недоступное пространство и не погашенное приглашение. После неопределённого
результата клиент сначала вызывает `GET /api/session`: если cookie дошла, flow
продолжается; если нет — identity можно создать повторно. Пустые профили без
memberships/recovery удаляются housekeeping после истечения всех их sessions.

Один браузер одновременно принадлежит одному профилю. Подключение device link
другого профиля требует явного выхода и удаления локальных данных текущего.

### Пространство

Пространство — tenant с собственными расходами, категориями, аналитикой и
очередью синхронизации. Один пользователь может состоять в нескольких
пространствах.

У пространства ровно один владелец:

- владелец переименовывает пространство, приглашает и удаляет участников,
  отзывает приглашения и передаёт владение;
- участник работает с расходами и категориями и может выйти сам;
- владелец не может выйти или удалить себя до передачи владения;
- удаление участника прекращает доступ во всех его сессиях, но не затрагивает
  другие пространства этого пользователя.

Удаление пространства и удаление профиля не входят в первый релиз.

### Устройство и сессия

Отдельной таблицы устройств нет. Каждая строка `sessions` представляет одно
подключённое устройство/браузер и содержит понятную подпись, время последней
активности и отметку отзыва.

В интерфейсе это две разные области:

- «Участники» — люди внутри текущего пространства;
- «Мои устройства» — сессии текущего профиля во всех пространствах.

### Активное пространство

Активное пространство хранится только на клиенте. Серверная сессия определяет
`userId`, но не содержит переключаемого `activeWorkspaceId`.

Каждый доменный маршрут содержит пространство явно:

```text
/api/workspaces/:workspaceId/...
```

Сервер извлекает пользователя из HttpOnly cookie и на каждом запросе проверяет
его membership. Переданный клиентом ID никогда не считается доказательством
доступа.

### Три разных типа ссылки

- **Invitation** — добавляет другого человека как участника конкретного
  пространства.
- **Device link** — создаёт ещё одну сессию того же пользователя и не меняет
  memberships.
- **Recovery link** — личный бессрочный мастер-секрет профиля; восстанавливает
  доступ ко всем memberships, которые всё ещё принадлежат пользователю.

Invitation и device link одноразовые и короткоживущие. Active recovery link не
истекает, но после восстановления или ручной ротации заменяется новой.

### Recovery всегда двухфазный

Старая recovery link и существующие сессии продолжают действовать, пока
пользователь не увидел новую ссылку, не сохранил её и не подтвердил завершение.

Это обязательный инвариант. Одношаговая операция «погасить старую и вернуть
новую» запрещена: потерянный HTTP-ответ может оставить человека без доступа.

### Capability URL

Секрет находится во fragment, а не в path/query:

```text
https://moapp.example/#/join/SECRET
https://moapp.example/#/device/SECRET
https://moapp.example/#/recover/SECRET
```

Fragment не отправляется Nginx/Fastify и не попадает в `Referer`. Клиент до
первого API-запроса извлекает секрет в память и очищает адрес через
`history.replaceState`. В API секрет передаётся только JSON body.

## 3. Целевая модель данных

### Пользователи и доступ

```text
users
  id                         TEXT PRIMARY KEY
  display_name               TEXT NOT NULL
  recovery_token_hash        TEXT UNIQUE NULL
  recovery_generation        INTEGER NOT NULL DEFAULT 0
  created_at                 TEXT NOT NULL
  updated_at                 TEXT NOT NULL

sessions
  id                         TEXT PRIMARY KEY
  token_hash                 TEXT UNIQUE NOT NULL
  user_id                    TEXT NOT NULL -> users.id
  kind                       normal | legacy_claim_pending
  label                      TEXT NOT NULL
  created_at                 TEXT NOT NULL
  last_seen_at               TEXT NOT NULL
  expires_at                 TEXT NOT NULL
  revoked_at                 TEXT NULL

workspaces
  id                         TEXT PRIMARY KEY
  name                       TEXT NOT NULL
  owner_user_id              TEXT NOT NULL -> users.id
  version                    INTEGER NOT NULL DEFAULT 1
  created_at                 TEXT NOT NULL
  updated_at                 TEXT NOT NULL
  FOREIGN KEY (id, owner_user_id)
    REFERENCES memberships(workspace_id, user_id)
    DEFERRABLE INITIALLY DEFERRED

memberships
  workspace_id               TEXT NOT NULL -> workspaces.id
  user_id                    TEXT NOT NULL -> users.id
  joined_at                  TEXT NOT NULL
  added_by_user_id           TEXT NULL -> users.id
  PRIMARY KEY (workspace_id, user_id)

access_tokens
  id                         TEXT PRIMARY KEY
  kind                       invitation | device_link | recovery_rotation
  token_hash                 TEXT UNIQUE NOT NULL
  workspace_id               TEXT NULL
  target_user_id             TEXT NULL
  created_by_user_id         TEXT NULL
  created_by_session_id      TEXT NULL
  replacement_token_hash     TEXT NULL
  expected_generation        INTEGER NULL
  revoke_sessions            INTEGER NOT NULL DEFAULT 0
  accept_attempt_hash        TEXT NULL
  accepted_session_id        TEXT NULL
  created_at                 TEXT NOT NULL
  expires_at                 TEXT NOT NULL
  consumed_at                TEXT NULL
  revoked_at                 TEXT NULL

legacy_claims                -- zero rows on clean installs, one on v2 upgrade
  workspace_id               TEXT PRIMARY KEY -> workspaces.id
  owner_user_id              TEXT NOT NULL -> users.id
  state                      open | claimed_pending | closed
  attempt_hash               TEXT NULL
  pending_session_id         TEXT NULL -> sessions.id
  pending_expires_at         TEXT NULL
  updated_at                 TEXT NOT NULL
```

`workspaces.owner_user_id` — единственный источник истины о владельце. Deferred
composite FK обеспечивает наличие owner membership на уровне SQLite; создание и
передача владения выполняются транзакциями. Удаление owner membership запрещено.

`access_tokens` получает точную CHECK-матрицу:

| kind | workspace | target user | creator user/session | replacement/generation | revoke sessions | accept attempt/session |
|---|---|---|---|---|---:|---|
| `invitation` | required | NULL | both required | both NULL | 0 | both NULL |
| `device_link`, active | NULL | required | both required | both NULL | 0 | both NULL |
| `device_link`, consumed | NULL | required | both required | both NULL | 0 | both required |
| manual `recovery_rotation` | NULL | required | creator user = target; session required | both required | 0 | both NULL |
| public `recovery_rotation` | NULL | required | both NULL | both required | 1 | both NULL |

Для всех rows `revoke_sessions IN (0,1)`. Device accept получает отдельный
32-byte `attemptToken`: при первом consume хранится только его hash и ID созданной
session. Повтор с теми же link + attempt до expiry считается retry одного
действия только пока row не revoked и `accepted_session_id` остаётся active:
предыдущая attempt-session отзывается, создаётся новая и cookie выставляется
повторно. Иной attempt после consume и любой retry после явного session revoke,
logout или recovery получает `410 LINK_INVALID`. Отзыв session закрывает как
созданные ею unexpired device links, так и consumed link, который создал эту
session, а также все active invitations, созданные этой session. Существующая
session, ранее подключённая link создателя, остаётся независимой. Это закрывает
потерю successful HTTP-response, не позволяя воскресить отозванное устройство
или использовать capability от скомпрометированной session. Complete recovery
дополнительно фильтрует `kind`,
`revoke_sessions`, creator session/target и generation внутри одной transaction.

### Tenant-scoped данные

```text
categories
  workspace_id
  id
  ...
  PRIMARY KEY (workspace_id, id)
  UNIQUE (workspace_id, name COLLATE NOCASE)

expenses
  workspace_id
  id
  category_id
  ...
  PRIMARY KEY (workspace_id, id)
  FOREIGN KEY (workspace_id, category_id)
    REFERENCES categories(workspace_id, id)

sync_operations
  workspace_id
  operation_id
  ...
  PRIMARY KEY (workspace_id, operation_id)
```

Составные ключи позволяют каждому пространству иметь категории `products`,
`other` и даже совпадающие UUID, не создавая глобальных конфликтов. Курсы валют,
`schema_migrations` и служебный heartbeat остаются глобальными.

## 4. HTTP-контракт

### Сессия и первый запуск

```text
GET    /api/session                         public, всегда 200
DELETE /api/session                         idempotent logout
POST   /api/identity                        guest: create empty user + session
POST   /api/legacy-claim                    legacy only: restricted session
PATCH  /api/me                              change display name
GET    /api/me/sessions
DELETE /api/me/sessions/:sessionId
```

`GET /api/session`:

```json
{
  "authenticated": true,
  "user": {
    "id": "uuid",
    "displayName": "Анна",
    "recoveryConfigured": true,
    "recoveryGeneration": 2
  },
  "currentSessionId": "uuid",
  "currentSessionExpiresAt": "...",
  "serverTime": "...",
  "restrictedToRecovery": false,
  "workspaces": [
    {
      "id": "uuid",
      "name": "Дом",
      "role": "owner",
      "version": 1,
      "joinedAt": "..."
    }
  ],
  "legacyWorkspaceId": null
}
```

Для чистого браузера:

```json
{
  "authenticated": false,
  "user": null,
  "workspaces": [],
  "legacyClaimAvailable": false,
  "serverTime": "..."
}
```

`POST /api/identity {displayName}` создаёт только профиль и normal session. После
неопределённого network result клиент проверяет `GET /api/session` перед retry.
Первое пространство создаётся обычным idempotent `POST /api/workspaces`, а
invitation принимается authenticated endpoint. Для пользователя интерфейс всё
равно показывает одну форму. Recovery настраивается отдельным двухфазным
потоком.

`POST /api/legacy-claim` не заменяет active профиль: normal session получает
`409 ALREADY_AUTHENTICATED`. Restricted session может получить idempotent
response только когда её session ID и body attempt совпадают с singleton
pending claim и `pending_expires_at > now`; guest retry допускается с тем же
attempt до этого hard expiry для восстановления потерянного cookie/response.

Для guest shape `legacyClaimAvailable=true` только если singleton claim в
`open` либо его `claimed_pending` уже истёк; active pending и `closed` дают
false.

Normal session expiry — скользящий inactivity TTL. Не чаще одного раза в час
valid request обновляет `last_seen_at`, `expires_at` и cookie expiry. Restricted
`legacy_claim_pending` никогда не sliding: её hard expiry не позже
`legacy_claims.pending_expires_at`. Cached normal `currentSessionExpiresAt`
ограничивает offline-доступ; после этого времени клиент показывает lock до
online-проверки.

Во всём API `authenticated` без дополнительной оговорки означает normal
session. Restricted `legacy_claim_pending` допускается только к
`GET/DELETE /api/session` и двум endpoint initial recovery rotation; workspace,
domain, invitation и device-link management требуют normal session.

После первичного `GET /api/session` каждый запрос, который рассчитывает на
текущую identity, отправляет два headers:

```text
X-Moapp-Expected-User-Id: <user.id>
X-Moapp-Expected-Session-Id: <currentSessionId>
```

Auth guard сравнивает оба с cookie principal **до** membership lookup, чтения и
mutation. Mismatch возвращает `409 SESSION_CONTEXT_CHANGED` и ничего не меняет.
Это не доказательство авторизации, а защита stale вкладки: если другая вкладка
вышла и подключила иной профиль, старая не сможет отправить его cookie со своим
outbox, даже когда оба user состоят в одном workspace. Публичный session
bootstrap и все read-only `/api/access/*/preview` игнорируют expected headers:
preview нужен для lost-response probe до новой hydration. Для guest-capable
mutating access endpoint отсутствие headers разрешено **только если valid cookie
реально отсутствует**. Если cookie есть, expected headers обязательны и должны
совпасть — route-wide guest bypass запрещён. Для остальных valid-cookie
normal/restricted endpoints отсутствие headers также считается
`SESSION_CONTEXT_CHANGED`; guest idempotent logout без valid cookie остаётся
`204`.

`DELETE /api/session` с mismatched expected IDs возвращает
`SESSION_CONTEXT_CHANGED`, не revoke и не очищает новую cookie. Для клиента это
terminal success только при обработке сохранённого offline logout marker старой
session; обычная вкладка сначала rehydrate'ит identity.

### Пространства и участники

```text
GET    /api/workspaces
POST   /api/workspaces                      { id, name }
PATCH  /api/workspaces/:workspaceId

GET    /api/workspaces/:workspaceId/members
DELETE /api/workspaces/:workspaceId/members/:userId
DELETE /api/workspaces/:workspaceId/members/me
POST   /api/workspaces/:workspaceId/transfer-ownership { userId, version }
```

Workspace ID генерирует клиент. Повтор `POST` с тем же ID и совместимыми
owner/name возвращает существующий workspace (`200`); несовместимый повтор —
`409 IDEMPOTENCY_CONFLICT`. Transfer использует
`WHERE id=? AND owner_user_id=? AND version=?`, увеличивает version и возвращает
обновлённый summary.

### Данные пространства

```text
GET    /api/workspaces/:workspaceId/bootstrap
GET    /api/workspaces/:workspaceId/expenses
GET    /api/workspaces/:workspaceId/expenses/:id
POST   /api/workspaces/:workspaceId/expenses
PATCH  /api/workspaces/:workspaceId/expenses/:id
DELETE /api/workspaces/:workspaceId/expenses/:id

GET    /api/workspaces/:workspaceId/categories
POST   /api/workspaces/:workspaceId/categories
PATCH  /api/workspaces/:workspaceId/categories/:id
DELETE /api/workspaces/:workspaceId/categories/:id
PUT    /api/workspaces/:workspaceId/categories/order

GET    /api/workspaces/:workspaceId/analytics
POST   /api/workspaces/:workspaceId/sync
```

Bootstrap возвращает `workspaceId` вместе с данными. Клиент обязан проверить,
что ответ относится к ожидаемому runtime, прежде чем применить его.

### Invitation

```text
GET    /api/workspaces/:workspaceId/invitations
POST   /api/workspaces/:workspaceId/invitations { ttlHours?: integer }
DELETE /api/workspaces/:workspaceId/invitations/:invitationId
POST   /api/access/invitations/preview       { token }
POST   /api/access/invitations/accept        { token } (normal session required)
```

Preview публичный и не расходует токен. Accept вызывается только по явной
кнопке и всегда требует normal session. Guest UI сначала вызывает `/api/identity`, не
погашая invitation. Accept добавляет текущий профиль и всегда создаёт `member`,
никогда владельца. Если accept response потерян, клиент обновляет `/api/session`:
наличие preview workspace в memberships означает success, иначе запрос можно
повторить с тем же token.

Invitation TTL: default 72 часа, допустимое integer-значение 24–168.

### Device link

```text
POST   /api/me/device-links
POST   /api/access/device-links/preview      { token }
POST   /api/access/device-links/accept       { token, attemptToken }
```

Accept создаёт новую session существующего `target_user_id`. Если браузер уже
авторизован под другим профилем, сервер возвращает конфликт; клиент сначала
показывает предупреждение и выполняет подтверждённый online logout. Stable
`attemptToken` живёт только в памяти flow и позволяет безопасно повторить accept
после потерянного ответа по правилам CHECK-матрицы выше. При uncertain result
guest-клиент сначала проверяет `/api/session`: появившаяся session означает
success; если он всё ещё guest, accept повторяется с тем же attempt. Для уже
consumed link совпавший attempt обрабатывается раньше проверки
`ALREADY_CONNECTED`; текущая session, если она есть, должна быть именно
`accepted_session_id`. Другая session того же user получает
`ALREADY_CONNECTED`, а другого user — `IDENTITY_CONFLICT`; в обоих случаях
ничего не перевыпускается.

### Recovery

```text
POST   /api/me/recovery/rotation/prepare
POST   /api/me/recovery/rotation/complete    { completionToken }

POST   /api/access/recovery/preview          { token }
POST   /api/access/recovery/prepare          { token }
POST   /api/access/recovery/complete         { completionToken }
```

Manual rotation сохраняет существующие сессии. Recovery после потери доступа
при complete отзывает все прежние сессии пользователя, все unexpired device
links target user (включая consumed-but-retryable) и созданные им активные
invitations, затем создаёт одну новую сессию.
Оба prepare endpoint возвращают точную форму
`{recoveryUrl,completionToken,expiresAt,nextGeneration}`; оба raw-секрета
выдаются один раз и живут только в памяти flow до complete.

Public recovery prepare/complete при active session другого user возвращают
`409 IDENTITY_CONFLICT` без изменения token/generation. Клиент сохраняет intent
только в памяти, выполняет подтверждённый online logout с очисткой локальных
данных и повторяет recovery.

### Канонические response-типы

Ни один агент не вводит альтернативный envelope. Типы ниже являются частью
контракта:

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

type GuestSession = {
  authenticated: false
  user: null
  workspaces: []
  legacyClaimAvailable: boolean
  serverTime: string
}

type Participant = {
  userId: string
  displayName: string
  role: 'owner' | 'member'
  joinedAt: string
  isCurrentUser: boolean
}

type DeviceSession = {
  id: string
  label: string
  createdAt: string
  lastSeenAt: string
  expiresAt: string
  current: boolean
}

type InvitationMetadata = {
  id: string
  workspaceId: string
  expiresAt: string
  createdAt: string
}

type DeviceLinkMetadata = {
  id: string
  expiresAt: string
}

type DeviceLinkPreview = {
  kind: 'device'
  targetUserId: string
  displayName: string
  expiresAt: string
}

type RecoveryPreview = {
  kind: 'recovery'
  targetUserId: string
  displayName: string
}

type RecoveryPrepareResponse = {
  recoveryUrl: string
  completionToken: string
  expiresAt: string
  nextGeneration: number
}
```

Endpoint responses:

| Endpoint | Success response |
|---|---|
| `GET /session` | `AuthenticatedSession | GuestSession`, `200` |
| `POST /identity` | `AuthenticatedSession`, `201` |
| `PATCH /me` | `{user: UserProfile}`, `200` |
| `GET /me/sessions` | `{sessions: DeviceSession[]}`, `200` |
| `DELETE /session`, member/session/invitation delete | empty, `204` |
| `GET /workspaces` | `{workspaces: WorkspaceSummary[]}`, `200` |
| `POST /workspaces` | `{workspace: WorkspaceSummary}`, `201`; idempotent replay `200` |
| workspace rename/transfer | `{workspace: WorkspaceSummary}`, `200` |
| `GET .../members` | `{members: Participant[]}`, `200` |
| `GET .../bootstrap` | `{workspaceId,workspace,categories,expenses,currencies,rates,defaultAnalyticsCurrency,serverTime}`, `200` |
| invitation list | `{invitations: InvitationMetadata[]}`, `200` |
| invitation create | `{invitation: InvitationMetadata,url:string}`, `201` |
| invitation preview | `{kind:'invitation',workspace:{id,name},expiresAt}`, `200` |
| invitation accept | `{workspace: WorkspaceSummary}`, `200` |
| device link create | `{deviceLink:DeviceLinkMetadata,url:string}`, `201` |
| device link preview | `DeviceLinkPreview`, `200` |
| device link accept | `AuthenticatedSession`, `200` |
| recovery preview | `RecoveryPreview`, `200` |
| manual/public recovery prepare | `RecoveryPrepareResponse`, `200` |
| manual/public recovery complete | `AuthenticatedSession`, `200` |
| legacy claim | `AuthenticatedSession` с `restrictedToRecovery:true`, `200` |

Server всегда возвращает canonical fragment URL из `APP_ORIGIN`; клиент не
реконструирует origin и QR кодирует ровно эту строку. List/preview никогда не
возвращают raw secret. `completionToken`, `attemptToken` и recovery token не
попадают в persisted client types.

Ошибки сохраняют существующий envelope:

```json
{"error":{"code":"WORKSPACE_NOT_FOUND","message":"...","details":{}}}
```

## 5. Ошибки и сокрытие данных

- `401 UNAUTHORIZED` — отсутствует или истекла пользовательская сессия.
- `403 FORBIDDEN` — пользователь состоит в пространстве, но операция требует
  владельца.
- `404 WORKSPACE_NOT_FOUND` — workspace отсутствует или у user нет membership;
  оба случая неразличимы публично. `404 NOT_FOUND` — scoped object отсутствует.
- `409 VERSION_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `IDENTITY_CONFLICT`,
  `ALREADY_AUTHENTICATED`, `ALREADY_MEMBER`, `ALREADY_CONNECTED`,
  `OWNER_CANNOT_LEAVE`, `USE_LOGOUT`, `CLAIM_IN_PROGRESS` и `ROTATION_STALE` —
  конкретные conflict cases.
- `409 SESSION_CONTEXT_CHANGED` — cookie user/session отличается от hydrated
  client context; вкладка блокируется и заново получает session, не повторяя
  mutation автоматически.
- `410 LINK_INVALID` — capability link/pending completion
  недействительна/истекла/использована/отозвана; все эти случаи получают
  одинаковое публичное сообщение.
- `410 UPGRADE_REQUIRED` — старый unscoped API после cutover.
- `429 RATE_LIMITED` — rate limit с `Retry-After`.

Recovery complete никогда не делает вывод только по error code или
`recoveryGeneration`. После uncertain response/`LINK_INVALID` клиент сначала
делает preview **точно новой показанной recovery URL**: только успешный preview
доказывает, что именно она сейчас active. Так как preview нового active secret
даёт capability, этот probe имеет строгий rate limit/no-store и выполняется
только после пользовательского complete, не автоматически в фоне.
`ROTATION_STALE` означает, что
победила другая rotation; показанная этим flow ссылка не active, а предыдущая
может уже не работать. Для expired/invalid completion прежнюю ссылку можно
обещать только после её успешного preview либо при неизменной generation и
доказанном отсутствии concurrent rotation. При initial setup прежней ссылки
вообще нет — повтор запускается из ещё active session.

## 6. Безопасность

- Все случайные секреты: не менее 32 байт CSPRNG, base64url.
- В SQLite хранится только SHA-256 hash высокоэнтропийного секрета.
- Raw links возвращаются ровно один раз и никогда не логируются.
- Cookie: в production имя `__Host-moapp_session`, `HttpOnly`, `Secure`,
  `SameSite=Strict`, `Path=/`, без `Domain`. Development/test по HTTP использует
  отдельное имя `moapp_session`, чтобы не ослаблять production flags.
- Любой mutating API проверяет точное значение `Origin` относительно
  настроенного `APP_ORIGIN`. Mutation с body требует
  `Content-Type: application/json`; bodyless `DELETE` допустим без
  Content-Type и отклоняет неожиданный body.
- Все `/api/*` responses, зависящие от cookie/profile/workspace или содержащие
  capability metadata, имеют `Cache-Control: private, no-store`; HTTP/browser/SW
  cache не может обойти expected-context guard после смены cookie. Исключение —
  отдельный публичный `/api/health`. Намеренный offline cache живёт только в
  scoped IndexedDB.
- Приложение выставляет `Referrer-Policy: no-referrer`, CSP с
  `frame-ancestors 'none'`, HSTS в HTTPS-контуре и
  `X-Content-Type-Options: nosniff`.
- Fastify доверяет ровно одному reverse-proxy hop, а не произвольной цепочке
  `X-Forwarded-For`.
- Имена нормализуются NFKC, обрезаются по краям, ограничиваются по длине; control
  и bidi override символы отклоняются.

Минимальные лимиты для self-hosted MVP:

- identity creation: 3/IP/час и 10/IP/сутки;
- создание workspace: 5/user/час;
- invitations: 10/workspace/час и ограничение активных ссылок;
- device links: 5/user/час;
- recovery prepare: 5/IP/15 минут;
- preview/accept: 20/IP/минуту.

## 7. Явные ограничения MVP

- Legacy shared PIN не позволяет доказать, кто был «главным». Первое корректное
  claim-действие получает право завершить recovery; `claimed_pending` защищает
  только от параллельного перехвата. Cutover выполняется владельцем в
  согласованное окно, после чего PIN отключается.
- Уже прочитанный offline-кэш удалённого участника нельзя стереть удалённо.
- Потеря всех сессий до настройки recovery необратима; UI должен предупреждать.
- Публичное создание без регистрации допускает spam/Sybil. Rate limits и общая
  storage quota достаточны для небольшого инстанса, но не заменяют CAPTCHA при
  публичном масштабировании.
- Возврат старой SQLite backup может воскресить отозванные сессии/ссылки.
  Disaster-recovery runbook должен включать ротацию `SESSION_SECRET` и отзыв
  временных capability после отката.
- Детальные роли, несколько владельцев, администраторы, удаление пространства и
  удаление профиля отложены.

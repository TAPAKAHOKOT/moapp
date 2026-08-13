# 05. Клиентские контракты, состояние и offline-изоляция

## Результат задачи

Клиент понимает профиль и список пространств, адресует API по workspace ID,
безопасно хранит отдельные bootstrap/outbox/preferences и не позволяет
запаздывающим ответам или legacy данным попасть в другое пространство.

Эта задача создаёт foundation. Полный пользовательский интерфейс строится в
плане 06.

## Зависимости

- Зафиксированы response/error shapes планов 02–04.
- Scoped server endpoints из плана 03 доступны для интеграционных тестов.
- Legacy workspace mapping возвращается session API.

## Владение файлами

- `client/src/types.ts`
- новые additive `client/src/workspace-api.ts` и
  `client/src/workspace-offline.ts`
- новый `client/src/app-state.ts`
- новый `client/src/capability.ts`
- `client/public/sw.js`
- `client/vite.config.ts`
- `client/index.html`
- новые `client/src/workspace-api.test.ts`,
  `client/src/workspace-offline.test.ts`, `client/src/app-state.test.ts`
- precache/test dependencies в `client/package.json`

Визуальные компоненты и переключение `App.tsx`/`main.tsx` относятся к плану 06.
Чтобы после этой задачи build оставался рабочим, существующие `api.ts`,
`offline.ts` и их unscoped exports временно сохраняются для старого App. План 06
атомарно переводит imports на новые scoped modules и удаляет legacy exports.

## Целевые типы

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

type SessionState =
  | {
      authenticated: false
      user: null
      workspaces: []
      legacyClaimAvailable: boolean
      serverTime: string
    }
  | {
      authenticated: true
      user: UserProfile
      currentSessionId: string
      currentSessionExpiresAt: string
      serverTime: string
      restrictedToRecovery: boolean
      workspaces: WorkspaceSummary[]
      legacyWorkspaceId: string | null
    }

type WorkspaceRuntime = {
  workspaceId: string
  bootstrap: WorkspaceBootstrap | null
  source: 'cache' | 'network' | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  offline: boolean
  outbox: OutboxStats
  requestEpoch: number
}

type WorkspaceBootstrap = {
  workspaceId: string
  workspace: WorkspaceSummary
  expenses: Expense[]
  categories: Category[]
  currencies: Currency[]
  rates: RateSnapshot
  defaultAnalyticsCurrency: string
  serverTime: string
}

type WorkspaceOutboxItem = {
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

type CapabilityIntent =
  | { kind: 'invite'; token: string }
  | { kind: 'device'; token: string }
  | { kind: 'recovery'; token: string }
```

`WorkspaceBootstrap`/`WorkspaceOutboxItem` самостоятельны и не extend legacy
`Bootstrap`/`OutboxItem`. Они переиспользуют только leaf domain-типы
`Expense`/`Category`/`Currency`/`RateSnapshot`. Старые `api.ts`/`offline.ts`
продолжают компилироваться со своими неизменёнными aliases до плана 06; затем
план 06 удаляет только legacy `Session`/`Bootstrap`/`OutboxItem`, сохраняя leaf
domain types. Bootstrap response содержит `workspaceId`; это проверяется до
записи в state/cache.

## Root state machine

Фазы приложения:

```text
checking
  -> guest
  -> known-user-locked
  -> legacy-claim
  -> restricted-recovery
  -> no-workspaces
  -> workspace
  -> capability
```

Capability intent имеет приоритет над guest/empty screen, но preview не
потребляет token.

До любой session hydration проверяется обязательный offline logout marker. Если
session истекла по cached `currentSessionExpiresAt`, offline workspace не
открывается до online-проверки.

Если server отвечает guest, но локально есть `known-user`/profile/cache/outbox,
это не чистый guest, а `known-user-locked`: данные не показываются и не
удаляются, Create/identity/invitation accept запрещены. Пользователь может:

- восстановить тот же `userId` recovery/device link;
- явно «Забыть локальный профиль», что использует тот же revoke/logout marker и
  только затем открывает чистый guest flow.

Device/recovery preview возвращает `targetUserId` для сравнения с известным
локальным ID. Совпадение позволяет восстановить session, сохранив scoped
cache/outbox; другой ID требует подтверждённой очистки **до** accept/prepare.
После любого identity/device/recovery response `user.id` сравнивается снова.
Если authenticated server session неожиданно принадлежит другому ID, ни старые,
ни новые данные не render'ятся до явного решения: очистить старый local profile
или logout новой server session. Автоматического merge/переназначения нет.

Выбор active workspace:

1. сохранённый ID текущего user, если он всё ещё есть в session memberships;
2. первое доступное workspace;
3. `null`, если список пуст.

Нельзя хранить `activeWorkspaceId` и безымянный `bootstrap` как два независимых
state. Runtime всегда несёт свой `workspaceId`, а любые setters принимают
expected workspace:

```ts
updateWorkspace(workspaceId, updater)
```

Так завершившаяся mutation A не сможет изменить active bootstrap B.

## Workspace-scoped API client

Все domain functions требуют workspace ID первым аргументом:

```ts
getBootstrap(workspaceId, signal)
submitExpenseOperation(userId, workspaceId, ...)
syncOutbox(userId, workspaceId, ...)
createCategory(workspaceId, ...)
getAnalytics(workspaceId, ...)
```

План 05 владеет **полным**, а не примерным surface нового
`workspace-api.ts`. Помимо domain functions он экспортирует согласованные с
`00` операции:

```ts
getSession(); logout(); createIdentity(displayName); updateProfile(...)
listSessions(); revokeSession(sessionId)

createWorkspace(id, name); renameWorkspace(workspaceId, name, version)
listMembers(workspaceId); removeMember(workspaceId, userId); leaveWorkspace(workspaceId)
transferOwnership(workspaceId, userId, version)

listInvitations(workspaceId); createInvitation(workspaceId, ttlHours?)
revokeInvitation(workspaceId, invitationId)
previewInvitation(token); acceptInvitation(token)

createDeviceLink(); previewDeviceLink(token); acceptDeviceLink(token, attemptToken)

prepareInitialOrManualRecovery(); completeInitialOrManualRecovery(completionToken)
previewRecovery(token); prepareRecovery(token); completeRecovery(completionToken)
legacyClaim(pin, displayName, attemptToken)
```

`createInvitation` всегда отправляет JSON body: `{}` без override либо
`{ttlHours}`. Остальные POST prepare/create без полей также отправляют `{}`;
bodyful mutations всегда JSON. Канонические bodyless DELETE отправляются без
body и без обязательного Content-Type.

Названия могут следовать стилю проекта, но ни одна функция из UI плана 06 не
реализует собственный `fetch`. Все request/response types, включая
`RecoveryPrepareResponse`, metadata links, participants и `targetUserId` в
device/recovery preview, добавляются в новые типы плана 05 без ослабления
legacy-типов.

Общий `request`:

- принимает `AbortSignal`;
- после hydration автоматически ставит
  `X-Moapp-Expected-User-Id`/`X-Moapp-Expected-Session-Id` из immutable session
  snapshot каждого authenticated/mutating request; caller не передаёт их
  вручную. `GET /session` и access previews явно suppress headers, чтобы
  lost-response probe работал после смены cookie;
- различает user `401`, workspace guard `404 WORKSPACE_NOT_FOUND`, object
  `404 NOT_FOUND`, token `410 LINK_INVALID`, stale-tab
  `409 SESSION_CONTEXT_CHANGED` и rate `429`;
- не трактует потерю одного membership как logout всего профиля;
- никогда не включает token в URL;
- не логирует body access requests;
- проверяет `workspaceId` в bootstrap/sync response.

При переключении старый bootstrap request отменяется `AbortController` и/или
отбрасывается по `requestEpoch`. Для mutation abort не должен удалять outbox:
результат может быть потерян, и операция должна replay с тем же operationId.

Первый workspace получает заранее сгенерированный stable UUID. Flow
`identity → createWorkspace` при uncertain identity result сначала проверяет
`GET /session`; workspace create retry использует тот же UUID. Invite для guest
выполняет `identity → authenticated accept`; потерянный accept проверяется через
обновлённый session membership. Device accept генерирует один 32-byte
`attemptToken` на flow и сохраняет его только в памяти для retry. При unknown
result сначала выполняется session probe; accept повторяется с тем же attempt
только если browser остался guest.

`ALREADY_MEMBER` из invitation flow не показывается generic error: клиент
обновляет session, активирует уже добавленное workspace, а сама invitation
остаётся пригодной для другого человека.

Session coordinator вызывает `GET /api/session` при startup, `online`, возврате
в visible state и не реже раза в 30 минут при открытом приложении. Он обновляет
cached `currentSessionExpiresAt`/`serverTime`, чтобы sliding server session не
получала ложный offline lock из-за старого snapshot.

`BroadcastChannel('moapp-identity')` с fallback на versioned localStorage event
рассылает `{epoch,userId|null,sessionId|null}` после identity, device/recovery,
legacy completion, logout и forget. Другие вкладки немедленно abort'ят network
controllers, останавливают sync и переходят в checking/locked. Это ускоряет UI,
но безопасность не зависит от broadcast: expected headers блокируют stale
request на сервере. `SESSION_CONTEXT_CHANGED` никогда автоматически не replay'ит
mutation; вкладка сначала получает session и разрешает identity conflict.

## IndexedDB v3

Текущий upgrade удаляет `outbox`; повторять это нельзя. Создать новые stores,
оставив legacy stores до явного переноса:

```text
profiles
  keyPath: userId
  cached Session snapshot without secrets

workspace-cache
  keyPath: [userId, workspaceId]
  { userId, workspaceId, data, cachedAt }

workspace-outbox
  keyPath: [userId, workspaceId, operationId]
  indexes: byWorkspace, byCreatedAt/status as needed

migration-state
  keyPath: [userId, migration]
  stages: db_complete | complete

legacy stores
  cache, outbox — временно остаются, никогда не участвуют в обычной sync
```

Все публичные функции scoped:

```ts
cacheBootstrap(userId, workspaceId, data)
readCachedBootstrap(userId, workspaceId)
queueMutation(userId, workspaceId, item)
readOutbox(userId, workspaceId)
removeMutation(userId, workspaceId, operationId)
outboxStats(userId, workspaceId)
clearWorkspaceOfflineData(userId, workspaceId)
clearUserOfflineData(userId)
```

Удаление operation дополнительно проверяет весь composite key. Нельзя удалять
строку по одному `operationId`.

### Legacy offline migration

Старые `cache/bootstrap`, outbox без workspace ID и preferences не назначаются
автоматически текущему активному пространству.

Разрешённый путь:

1. Новый клиент выполняет explicit legacy claim.
2. Session возвращает точный `legacyWorkspaceId` и legacy owner context.
3. Клиент переносит old bootstrap/outbox/preferences под
   `userId + legacyWorkspaceId`.
4. Copy новых rows, marker `db_complete` и clear legacy IndexedDB stores
   выполняются одной transaction, включающей old/new/meta stores.
5. После DB commit переносятся localStorage preferences и marker становится
   `complete`.

Если процесс упал после DB commit, следующий startup видит `db_complete`,
идемпотентно завершает localStorage и не копирует outbox второй раз. Interruption
на любом этапе покрывается тестом.

Если соответствие неоднозначно, данные остаются в quarantine и не отправляются.
UI может предложить отбросить старую очередь; произвольная привязка к первому
workspace запрещена.

## localStorage

```text
moapp:theme                                      global device preference
moapp:v2:known-user                              current cached user ID
moapp:v2:active-workspace:<userId>
moapp:v2:user:<userId>:workspace:<workspaceId>:last-currency
moapp:v2:user:<userId>:workspace:<workspaceId>:analytics-currency
moapp:v2:logout-pending                          JSON {userId,sessionId}
```

Workspace preferences разделяются. Theme можно сохранять после logout. Profile
и membership names хранятся в IndexedDB, а localStorage содержит минимум IDs.

Offline startup разрешён только при наличии known user, cached profile и cache
выбранного workspace, а также `currentSessionExpiresAt` в будущем относительно
device clock. Некэшированное или expired пространство нельзя открыть offline.

## Sync нескольких пространств

- Активное пространство синхронизируется первым.
- Затем scheduler обязательно проходит все доступные workspace с queued rows;
  conflict/error в A не блокирует B.
- Endpoint для каждой пачки строится из `item.workspaceId`, а не текущего UI.
- Conflict/error badge принадлежит workspace в переключателе.
- Потеря membership после online проверки немедленно очищает cache, outbox и
  preferences этого user/workspace, обновляет session и сообщает, что
  несинхронизированные операции отброшены; операции не переназначаются.
- Logout удаляет profile, caches, outbox и preferences текущего user. Offline
  logout **до очистки `known-user`** записывает фиксированный key
  `moapp:v2:logout-pending` со значением `{userId,sessionId}`, ставит локальный
  lock и pending server revoke, поскольку HttpOnly cookie физически нельзя
  отозвать без сети.
  Фиксированное имя позволяет startup найти marker без уже удалённого known ID.

Startup при `logout-pending` выполняется до `GET /session`:

1. offline — только locked state;
2. online — сначала `DELETE /session` с expected IDs из marker; если cookie уже
   относится к другой session/user, `SESSION_CONTEXT_CHANGED` считается
   безопасным доказательством, что старую cookie нельзя отозвать этим browser,
   и новая cookie не затрагивается;
3. после `204` **или этого конкретного 409 mismatch** удалить marker и разрешить
   обычный session startup; другие errors оставляют marker.

Ни bootstrap, ни cached profile до server revoke не показываются.

Destructive «Забыть локальный профиль» из `known-user-locked` использует тот же
порядок. Online сначала выполняется idempotent `DELETE /session`; offline marker
не позволит неожиданно воскресить старую cookie при следующем запуске.

## Безопасный разбор capability

`capability.ts` предоставляет чистую функцию, которую план 06 вызывает из
`main.tsx` до render и service worker registration:

1. распознать только точные `#/join/`, `#/device/`, `#/recover/`;
2. проверить базовый формат/длину token без его логирования;
3. сохранить intent только в памяти модуля/props;
4. выполнить `history.replaceState` на чистый `/`;
5. передать intent в App.

Не класть intent/token в React-router history, sessionStorage, localStorage,
IndexedDB, analytics или error text.

## Service worker и HTML

Перейти на build-generated precache manifest (`vite-plugin-pwa`/Workbox
`injectManifest` либо эквивалентный build step) и обеспечить:

- сохранить compatibility-протокол плана 00a: новый worker обрабатывает message
  `{type:'SKIP_WAITING'}` и вызывает `skipWaiting()`, а registration helper
  сообщает UI о waiting/updatefound worker;
- удалить `moapp-shell-v1` и все прежние app caches при activate;
- никогда не кэшировать navigation URL как отдельный ключ;
- для navigation использовать network-first и `/` как единственный offline
  fallback;
- кэшировать только same-origin static shell/assets;
- precache содержит фактические hashed JS/CSS текущего Vite build, поэтому одна
  online загрузка новой установки гарантирует следующий полный offline start;
- API всегда исключён;
- тест response/cache policy подтверждает, что session/workspace/access API не
  попадают в HTTP/SW cache; единственный intentional offline store — IndexedDB;
- fragment в любом случае не виден worker, но тест доказывает отсутствие token в
  Cache Storage keys.

В `index.html` добавить no-referrer meta/header defense. Server/Nginx header
остаётся authoritative.

## Тесты

Использовать `fake-indexeddb`; для UI foundation при необходимости jsdom.

### Storage isolation

- A и B имеют независимые cache/outbox с одинаковым operationId.
- Read/remove/sync A не затрагивает B.
- Два user в одном browser namespace не пересекаются.
- Upgrade v2 → v3 не удаляет legacy outbox.
- Legacy items не видны обычному `readOutbox` до explicit migration.
- Known mapping переносит их только в legacy workspace.
- Crash до/после DB commit идемпотентно продолжает migration без дублей/потерь.

### State/races

- Быстрые A → B → A с delayed responses не показывает чужой bootstrap.
- Delayed mutation A обновляет только runtime A.
- Delayed analytics A не заменяет analytics B.
- Cross-tab switch/logout abort'ит stale sync; даже уже отправленный request со
  старыми expected IDs не применяет mutation под новой cookie identity.
- Removed membership выбирает оставшееся workspace, а не logout.
- Saved active ID игнорируется, если его нет в session.
- Offline можно выбрать cached B, но нельзя открыть uncached C.

### Capability/SW

- Hash очищен до первого API request.
- Token отсутствует в URL после parse и во всех storage.
- Unknown/malformed hash не вызывает access request.
- SW не кэширует navigation/API и удаляет old cache.
- Чистая установка после одной online загрузки полностью стартует offline.
- Собранный compatibility-клиент 00a видит waiting новый worker, отправляет
  `SKIP_WAITING` и после `controllerchange` загружает cutover bundle; fragment
  capability переживает update до того, как новый bundle очистит его.

### Preferences/logout

- Валюты A/B независимы.
- Logout очищает все данные user, сохраняет theme.
- Offline logout блокирует локальное открытие до server revoke/re-login.
- Cached session после expiry не открывает данные offline.
- Guest response при known user входит в `known-user-locked`, не в Create.
- Recovery/device того же known user сохраняет его cache/outbox; другой user не
  принимается до подтверждённой local cleanup.
- Неожиданная authenticated session другого user не показывает ни один profile
  до явного выбора.
- `SESSION_CONTEXT_CHANGED` не replay'ит outbox до новой hydration; cross-tab
  logout/device/recovery lock'ит соседнюю вкладку через BroadcastChannel/storage.
- Access preview ignores stale expected context, затем `GET /session` hydrates
  cookie после public/legacy recovery complete; guest-capable mutation без
  headers отклоняется, если server уже видит valid cookie.
- Visibility/online heartbeat обновляет sliding session snapshot.
- Outbox A синхронизируется после switch на B; conflict A не блокирует B.

## Критерии приёмки

- Ни одна функция нового `workspace-offline.ts` не имеет unscoped overload;
  временный legacy module удаляется в плане 06.
- Outbox невозможно отправить по endpoint, выбранному из UI state.
- Запаздывающий response не меняет другой workspace.
- Raw capability token живёт только в памяти текущего flow.
- Legacy queue сохраняется, но остаётся безопасно заблокированной до точного
  mapping.

## Передача UI-агенту

Передать:

- reducer/actions root state;
- scoped storage/API signatures;
- capability intent type;
- workspace runtime update contract;
- поведение membership loss и offline availability;
- готовые test helpers для нескольких workspace.

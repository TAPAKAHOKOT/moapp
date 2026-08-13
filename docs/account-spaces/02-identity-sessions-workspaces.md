# 02. Профили, сессии, пространства и участники

## Результат задачи

Сервер аутентифицирует случайной HttpOnly session пользователя, возвращает его
пространства, позволяет создать и переименовать пространство, управлять
участниками и собственными сессиями. Обычный вход по общему PIN исчезает; PIN
остаётся только как одноразовый migration bridge для старой базы.

## Зависимости

- Готов план 01 и зафиксированы имена/ключи таблиц.
- Контракт из [00-architecture.md](./00-architecture.md) не меняется внутри этой
  задачи без согласования с клиентским планом.

## Владение файлами

- `server/src/auth.ts`
- `server/src/types.ts`
- `server/src/config.ts`
- новые `server/src/users.ts` и `server/src/workspaces.ts`
- новый самостоятельный `registerCoreRoutes` plugin; `server/src/app.ts` не
  менять, его связывает integration-owner в плане 07
- общий test-app helper, принимающий дополнительные route plugins для планов
  03/04
- новые `server/test/auth-workspaces.test.ts`

Recovery, invitation и device-link endpoints реализуются в плане 04. Доменные
expense/category SQL-запросы — в плане 03.

Чтобы план 04 компилировался без shared-file конфликта, план 02 заранее добавляет
в `AppConfig`/`configFromEnv` обязательный production `appOrigin` и typed access
limits/TTLs с безопасными defaults из `00`/`04`. Core пока не использует эти
поля; access agent только читает их и не меняет `types.ts`/`config.ts`.

## Шаги

### 1. Ввести principal запроса

Заменить PIN fingerprint модель на session lookup:

```ts
request.auth = {
  userId: string
  sessionId: string
  sessionKind: 'normal' | 'legacy_claim_pending'
  expiresAt: string
}
```

Нужны три переиспользуемых уровня:

- `optionalAuth` — валидная cookie заполняет `request.auth`, отсутствие cookie не
  является ошибкой; именно он используется публичными `GET /api/session` и
  idempotent `DELETE /api/session`;
- `requireAnySession` — требует active, unexpired session любого разрешённого
  kind и используется только explicit initial recovery с дополнительной
  проверкой matching `legacy_claims.pending_session_id`;
- `requireAuth` — требует active, unexpired **normal** session;
- `requireWorkspaceMember` — берёт `workspaceId` только из route params,
  сначала требует normal session, затем проверяет membership и прикрепляет
  owner-флаг.

Даже после pre-handler каждый repository/helper получает обязательный
`workspaceId`; guard не заменяет scoped SQL.

Session validation:

- hash cookie token и lookup по `token_hash`;
- проверка `expires_at` и `revoked_at`;
- expired/revoked row не аутентифицирует запрос;
- TTL normal session скользящий: не чаще одного раза в час обновляются
  `last_seen_at`, `expires_at` и cookie expiry;
- `legacy_claim_pending` никогда не продлевается: её session/cookie hard expiry
  равна или меньше `legacy_claims.pending_expires_at`;
- cookie очищается при недействительной session.

После lookup principal guard проверяет обязательные для hydrated authenticated
calls `X-Moapp-Expected-User-Id` и `X-Moapp-Expected-Session-Id`. Они должны
точно совпасть с cookie principal до любого authenticated чтения или mutation;
mismatch даёт
`409 SESSION_CONTEXT_CHANGED`. Публичный `GET /api/session` и read-only access
preview полностью exempt. Guest-capable access mutation принимает отсутствие
headers только при фактическом отсутствии valid cookie; при любой valid cookie
headers обязательны и совпадают. Identity строго guest-only. Legacy claim
начинается/retry'ится guest без headers; единственное cookie-исключение —
matching restricted retry с ожидаемыми IDs этой restricted session. Normal либо
mismatched cookie получает conflict. Initial recovery с restricted cookie также
отправляет IDs restricted session.

Session kind `legacy_claim_pending` допускается только к `/api/session`, logout
и initial recovery endpoints. Domain/workspace/access-management routes требуют
`normal`, поэтому claimant не читает данные до сохранения recovery.

Планы 03/04 импортируют эти helpers, а не переопределяют guards. Формулировка
«authenticated session» в остальных документах по умолчанию означает normal;
единственное исключение для pending явно названо initial recovery.

### 2. Унифицировать создание session

Вынести helper, которым позднее пользуются identity, device и recovery:

- 32 random bytes base64url;
- в БД только SHA-256;
- отдельный public `session.id` для списка устройств;
- server-generated label из ограниченной сводки user agent, без сохранения
  полного fingerprint;
- expiry из `SESSION_TTL_DAYS`;
- cookie flags согласно `00`.

`DELETE /api/session` идемпотентен: отзывает текущую row, если она найдена,
очищает cookie и возвращает `204` даже для гостя.

### 3. Реализовать публичный session bootstrap

`GET /api/session` всегда возвращает `200`:

- guest shape для чистого/недействительного браузера;
- authenticated shape с user, currentSessionId и workspace summaries;
- role вычисляется сравнением `workspaces.owner_user_id` с `user.id`;
- вернуть `recoveryConfigured`, `legacyWorkspaceId` и
  `legacyClaimAvailable` по контракту.

`legacyClaimAvailable=true` только для `open` либо `claimed_pending` с истёкшим
`pending_expires_at` (такой claim атомарно переоткрывается при следующей валидной
PIN-попытке). Active pending и `closed` возвращают false.

Список workspace сортируется стабильно: последний выбор не хранится на сервере,
поэтому достаточно `joined_at`, затем name/id.

### 4. Реализовать создание пустого профиля

`POST /api/identity` доступен только гостю и принимает:

```json
{"displayName":"Анна"}
```

Transaction создаёт user без recovery и normal session, но не workspace и не
membership. После commit выставить cookie и вернуть canonical
`AuthenticatedSession`. Endpoint имеет строгий rate limit.

При network uncertainty клиент сначала проверяет `/api/session`. Если cookie не
дошла, retry может создать ещё один пустой профиль, но ни одно пространство и ни
одна capability не теряются. Housekeeping удаляет user без memberships/recovery
после истечения/удаления всех его sessions.

Если session уже валидна, вернуть `409 ALREADY_AUTHENTICATED`, а не создавать
второй профиль в том же браузере.

### 5. Реализовать пространства

- `GET /api/workspaces` — актуальные summaries текущего user.
- `POST /api/workspaces {id,name}` — любой normal authenticated user,
  transaction создаёт workspace, owner membership и standard categories.
- `PATCH /api/workspaces/:id {name,version}` — только owner, optimistic version.

Client-generated workspace ID обеспечивает retry: совместимый повтор от того же
owner возвращает существующий workspace, несовместимый —
`IDEMPOTENCY_CONFLICT`.

Создание нового workspace не меняет серверную session. Клиент делает его
активным локально после успешного ответа.

### 6. Реализовать участников и владение

- `GET .../members` — любой member; вернуть userId, displayName, role, joinedAt,
  isCurrentUser.
- `DELETE .../members/:userId` — owner удаляет только member; owner/self
  защищены. В той же transaction отзываются active invitations, которые этот
  удаляемый user ранее создал для данного workspace.
- `DELETE .../members/me` — member выходит; owner получает conflict до transfer.
- `POST .../transfer-ownership {userId,version}` — только owner, target уже
  member.

Transfer — одна transaction с повторной owner-проверкой внутри неё и CAS
`WHERE id=? AND owner_user_id=? AND version=?`. После неё прежний owner остаётся
member, новый ID записан в `workspaces.owner_user_id`, version увеличен, а
deferred FK гарантирует owner membership. Concurrent transfer допускает одного
победителя. В той же transaction отзываются все active invitations пространства:
новый owner при необходимости выпускает новые.

Любая owner-only mutation повторно проверяет owner внутри той же synchronous DB
transaction, где меняет данные; одного pre-handler недостаточно при гонке
transfer/remove.

Для отсутствующего membership/workspace вернуть `404 WORKSPACE_NOT_FOUND`; для
существующего member, которому не хватает owner-права, — `403 FORBIDDEN`.

### 7. Реализовать профиль и список сессий

- `PATCH /api/me` меняет displayName после той же нормализации, что identity.
- `GET /api/me/sessions` возвращает только active, unexpired sessions текущего
  user: current flag, label, createdAt, lastSeenAt и expiresAt. Revoked/expired
  строки остаются внутренними и позднее удаляются housekeeping-задачей.
- `DELETE /api/me/sessions/:id` может отзывать только session текущего user.
  Чужой ID получает `404`.
- Отзыв session в той же transaction ставит `revoked_at` всем unexpired device
  links, созданным этой session, включая consumed-but-retryable, а также link с
  `accepted_session_id` этой session, и всем active invitations, созданным этой
  session. Уже созданная через link creator-session независима и сама не
  отзывается.
- Current session отзывается только обычным logout. Попытка удалить её через
  `/api/me/sessions/:id` возвращает `409 USE_LOGOUT`; logout использует тот же
  атомарный revoke helper, поэтому источник current device session также больше
  нельзя replay.

### 8. Добавить legacy claim

Новый клиент использует отдельный endpoint:

```text
POST /api/legacy-claim { pin, displayName, attemptToken }
```

Правила:

- normal active session получает `409 ALREADY_AUTHENTICATED`, claim/cookie не
  меняются; один browser не может молча заменить другой профиль;
- active restricted session допускается только если её ID и body attempt точно
  совпадают с текущим pending claim и `pending_expires_at > now`: это idempotent
  response той же session, без новой row; mismatch возвращает
  `CLAIM_IN_PROGRESS` без изменения cookie/session, а expired/invalid restricted
  session отзывает `optionalAuth` и никогда не продлевает lease;
- guest может начать `open` claim либо восстановить потерянный cookie/response
  для `claimed_pending` только с тем же attempt hash;
- доступен только при строке `legacy_claims` в state `open` либо
  `claimed_pending` с тем же attempt hash;
- проверяет старый `APP_PIN` тем же scrypt + constant-time способом и имеет
  жёсткий rate limit;
- первый успешный запрос атомарно меняет state `open → claimed_pending`, хранит
  только hash 32-byte attempt, обновляет имя owner и создаёт restricted
  `legacy_claim_pending` session на 30 минут;
- только guest retry после потерянного cookie/response с теми же PIN + attempt
  отзывает прежнюю pending session, записывает новую pending session ID и
  выставляет новую cookie; active matching restricted retry выше остаётся
  no-op/idempotent. Другой attempt получает `409 CLAIM_IN_PROGRESS`;
- истёкший pending claim может быть атомарно открыт заново следующей валидной
  PIN-попыткой: прежняя pending session отзывается, attempt/session/expiry поля
  очищаются по CHECK-матрице и затем записывается новая попытка;
- UI не допускает «Позже» и не открывает legacy workspace: claimant обязан
  завершить initial recovery, после чего state становится `closed`, session —
  normal, а все остальные pending claim sessions отзываются;
- после закрытия claim всегда возвращает безопасную ошибку;
- `POST /api/session {pin}`, `POST /api/auth/login`, `GET /api/auth/session` и
  `POST /api/auth/logout` больше не принимают старую auth-модель и отвечают
  `410 UPGRADE_REQUIRED`. Новый `GET /api/session` и `DELETE /api/session`
  сохраняют свои канонические session/logout semantics.

`APP_PIN` становится необязательным transitional config. Удалять его из
production env можно только после закрытия claim и проверки recovery. Startup
fail-fast, если legacy claim `open|claimed_pending`, а `APP_PIN` отсутствует;
после `closed` PIN действительно необязателен.

Для этого `configFromEnv` возвращает `pin?: string` и больше не падает сам по
себе. После `openDatabase` startup проверяет `legacy_claims`; открытый claim без
PIN завершает процесс до readiness и регистрации HTTP listener.

## Валидация и безопасность

- Display name: NFKC, trim, 1–60 видимых символов, без управляющих и bidi
  override.
- Workspace name: NFKC, trim, 1–80 символов с теми же запретами.
- Ни user, ни owner, ни workspace scope не принимаются из body там, где их можно
  определить из session/params.
- Все mutating routes требуют точный `Origin`; route с body требует JSON, а
  bodyless DELETE допускается без Content-Type и отклоняет неожиданный body.
- Session secret rotation отзывает все cookies ожидаемым образом.
- Настроить Fastify на доверие одному proxy hop вместо `trustProxy: true`.

## Тесты

### Session и identity

- Guest `GET /session` → 200 false.
- Identity создаёт ровно user/session и ноль workspace.
- Повторная identity в authenticated browser → 409.
- Потеря identity response не создаёт недоступных domain data/capabilities;
  клиентский session probe продолжает flow, если cookie дошла.
- Session содержит только memberships этого user.
- Expired/revoked session не работает; logout идемпотентен.
- Stale tab headers после смены cookie на другой user/session дают
  `SESSION_CONTEXT_CHANGED` до repository/mutation.
- Logout mismatch не очищает/не отзывает новую cookie; no/invalid cookie даёт
  idempotent `204`.
- Revoke/logout session закрывает созданные ею active invitations и retryable
  device links; старые capabilities не возвращают доступ.
- Active normal request продлевает sliding expiry не чаще раза в час.
- Restricted session не sliding и не действует при
  `pending_expires_at <= now`.
- Один user видит две свои sessions; чужую отозвать нельзя.

### Workspaces и роли

- Authenticated user создаёт второе workspace и становится owner.
- Повтор create с тем же client ID идемпотентен; другой name конфликтует.
- Member читает members и доменные routes, но не rename/invite/remove/transfer.
- Owner удаляет member, не может удалить себя.
- Member выходит, owner не выходит до transfer.
- Transfer при гонке оставляет ровно одного owner.
- Удаление membership A не влияет на memberships B.

### Legacy

- Старые sessions уже недействительны.
- Неверный PIN rate-limited.
- Claim работает только для fixture с open state.
- Retry claim допустим только с тем же attempt; competing attempt блокируется.
- Pending claim не читает workspace и обязан завершить recovery.
- Pending expiry позволяет безопасный новый claim; successful recovery закрывает
  claim навсегда.
- Гонка pending expiry vs recovery complete имеет одного transaction winner:
  complete при `pending_expires_at <= now` не активирует recovery и не создаёт
  normal session.
- При open/pending claim без `APP_PIN` startup останавливается; closed стартует.
- Чистая install не выставляет claim available.
- Все старые auth aliases и unscoped contract не получают доступ к данным.

## Критерии приёмки

- В `request` всегда известны user/session, но active workspace там не хранится.
- Все owner transitions транзакционны.
- Список «Мои устройства» нельзя использовать для просмотра/отзыва чужих
  sessions.
- PIN не является обычным способом входа и существует только до legacy cutover.
- Core tests не зависят от access-link реализации плана 04.

## Передача следующим агентам

Зафиксировать:

- TypeScript shape `request.auth` и workspace guard;
- reusable session creation/revocation helpers;
- response types `Session`, `WorkspaceSummary`, `Participant`;
- точные error codes/statuses;
- способ, которым recovery complete из плана 04 закрывает legacy claim.

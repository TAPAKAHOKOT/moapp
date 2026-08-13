# 04. Приглашения, подключение устройства и recovery

## Результат задачи

Сервер выдаёт и безопасно погашает три строго разделённых capability:

- invitation для нового участника;
- device link для новой session того же user;
- personal recovery link с безопасной двухфазной ротацией.

Raw secrets не сохраняются и не попадают в HTTP URL/логи.

## Зависимости

- План 01: `access_tokens`, users/sessions/workspaces schema.
- План 02: session helpers, auth context, membership/owner checks.
- План 02 уже добавил `APP_ORIGIN`/access limits в typed `AppConfig`; production
  environment задаёт обязательный origin.

## Владение файлами

- новый самостоятельный access route plugin в `server/src/access/`
- новый `server/test/access-links.test.ts`

Не менять `server/src/app.ts`, `auth.ts`, shared types плана 02 или domain
expense/category behavior. Использовать стабильные session/guard helpers плана
02; wiring выполняет integration-owner в плане 07.

## Общие token helpers

Реализовать одно место для:

- генерации 32 random bytes и base64url encoding;
- SHA-256 hashing перед записью/lookup;
- построения URL только из configured `APP_ORIGIN`;
- атомарного consume с условиями `consumed_at IS NULL`, `revoked_at IS NULL`,
  `expires_at > now`;
- одинаковой публичной ошибки для invalid/expired/used/revoked;
- `Cache-Control: private, no-store` в рамках общего правила для всех
  profile/workspace/access API;
- очистки expired rows отдельной безопасной housekeeping операцией.

Housekeeping сначала удаляет/архивирует expired access rows, и только затем
старые revoked/expired sessions, на которые больше нет ссылок. Session rows,
нужные для device idempotent retry до link expiry, не удаляются раньше.

Общий session-revoke helper плана 02 закрывает все active invitations,
созданные этой session. Поэтому отзыв скомпрометированного устройства
инвалидирует и выпущенные им, но ещё не использованные invite links.

Нельзя:

- принимать origin из `Host`/`X-Forwarded-Host`;
- логировать request body на access endpoints;
- хранить raw token в SQLite, session, local data или result JSON;
- использовать один kind как fallback для другого.

## Invitation flow

### Создание и отзыв

Только owner:

```text
GET    /api/workspaces/:workspaceId/invitations
POST   /api/workspaces/:workspaceId/invitations
DELETE /api/workspaces/:workspaceId/invitations/:invitationId
```

POST всегда принимает JSON `{}` либо `{ttlHours?: integer}`; default 72,
допустимый диапазон 24–168 часов. Он создаёт одноразовый token и возвращает raw
fragment URL ровно один раз. List возвращает
только metadata — raw URL восстановить нельзя. Ограничить число одновременно
active invitations.

### Preview и accept

```text
POST /api/access/invitations/preview { token }
POST /api/access/invitations/accept  { token } (normal session required)
```

- Preview не меняет БД и показывает только workspace name и expiry.
- Accept запускается явной кнопкой.
- Guest UI сначала создаёт пустой профиль через `/api/identity`; invitation до
  этого не consume. Accept добавляет membership текущему user.
- Invite никогда не создаёт owner.
- Если user уже member, вернуть `409 ALREADY_MEMBER` и не потреблять invitation,
  чтобы ссылка оставалась пригодной для нового участника.
- В конкурентной гонке только один accept потребляет token.
- Owner permission повторно проверяется внутри transaction создания/отзыва link.
- Если accept response потерян, session refresh с появившимся workspace считается
  success; если membership нет, тот же token можно retry.

## Device link flow

### Создание

```text
POST /api/me/device-links
```

Любая normal authenticated session создаёт link только для собственного `userId` с TTL
15 минут и одним использованием. Metadata связывает capability с создавшей
session. Отзыв creator session закрывает все созданные ею unexpired links,
включая consumed-but-retryable; уже успешно созданная через такой link session
остаётся независимой.

### Preview и accept

```text
POST /api/access/device-links/preview { token }
POST /api/access/device-links/accept  { token, attemptToken }
```

- Preview не потребляет token; показывает `targetUserId`, ограниченное имя
  профиля и expiry. ID нужен локальному known-profile guard, но сам по себе не
  является секретом или доказательством доступа.
- Accept в guest browser создаёт новую normal session того же target user.
- Browser с другим active user получает `409 IDENTITY_CONFLICT`; server не
  заменяет cookie молча.
- Browser с тем же user получает `409 ALREADY_CONNECTED`, не создавая
  бесконечные sessions.
- `attemptToken` — 32 random bytes, живёт только в памяти клиента.
- Первый accept атомарно stores attempt hash, consume link и создаёт session.
- Retry с теми же link + attempt до expiry отзывает созданную этой попыткой
  session, создаёт новую и повторно выставляет cookie, только если link не
  revoked и предыдущая `accepted_session_id` всё ещё active. Другой attempt
  после consume либо retry после revoke/logout/recovery получает
  `410 LINK_INVALID`.
- При unknown response клиент сначала probes `/api/session`: если начавший как
  guest browser теперь authenticated, flow завершён; если он всё ещё guest,
  выполняется retry с тем же attempt. На consumed retry server сначала сверяет
  attempt и разрешает текущую session только когда это ровно
  `accepted_session_id`; другая session того же user получает
  `ALREADY_CONNECTED`, другого user — `IDENTITY_CONFLICT`, и не заменяется.

## Recovery model

Active recovery secret хранится как `users.recovery_token_hash`. Он не имеет
срока действия. `recovery_generation` используется как compare-and-swap против
параллельных ротаций.

Pending rotation — строка `access_tokens(kind=recovery_rotation)`:

- `token_hash` — hash короткоживущего completion token;
- `target_user_id`;
- `replacement_token_hash` — hash новой recovery link;
- `expected_generation`;
- `revoke_sessions` — различает manual rotation и recovery;
- TTL ровно 30 минут.

Manual pending row имеет `revoke_sessions=0` и привязана к текущей
`created_by_session_id`; manual complete требует ту же active session. Public
recovery row имеет `revoke_sessions=1` и не принимается manual endpoint. Таким
образом completion tokens двух flow нельзя перепутать, хотя они используют одну
таблицу.

Raw новая recovery link и completion token возвращаются только на prepare:

```json
{
  "recoveryUrl":"https://host/#/recover/SECRET",
  "completionToken":"SECRET",
  "expiresAt":"...",
  "nextGeneration":2
}
```

Оба raw-секрета не хранятся и живут на клиенте только в памяти flow.

### Initial setup и ручная ротация

```text
POST /api/me/recovery/rotation/prepare
POST /api/me/recovery/rotation/complete { completionToken }
```

Prepare работает и при `recovery_token_hash IS NULL`:

1. генерирует новый recovery secret и completion token;
2. сохраняет только их hashes и expected generation;
3. возвращает новую `#/recover/...` link;
4. старая recovery link и sessions остаются рабочими.

UI сначала показывает/copy/QR новую ссылку. Только после явного «Я сохранил»
вызывает complete. Complete CAS-обновляет hash/generation и consume pending row.
Manual rotation не отзывает sessions.

Restricted legacy session допускается к этим двум endpoint только для initial
setup и только если она совпадает с `legacy_claims.pending_session_id`/attempt
state. Prepare и complete внутри одной transaction повторно требуют
`state=claimed_pending`, matching session и `pending_expires_at > now`.
Restricted session/cookie никогда не sliding и не живёт дольше pending lease.
На boundary/после expiry она отзывается, recovery не активируется; successful
complete до expiry выполняет дополнительный claim transition ниже.

Если initial setup обычного profile отменён до complete, profile остаётся без
recovery и может повторить настройку позже. Для restricted legacy claim отмена
не открывает workspace: можно продолжить pending flow либо дождаться expiry и
claim заново. Если manual rotation отменена, старая ссылка остаётся рабочей.

### Восстановление после потери устройств

```text
POST /api/access/recovery/preview  { token }
POST /api/access/recovery/prepare  { token }
POST /api/access/recovery/complete { completionToken }
```

- Preview не расходует active recovery и показывает `targetUserId` плюс
  ограниченное display name для локального known-profile guard.
- Preview/prepare/complete при active session другого user возвращают
  `409 IDENTITY_CONFLICT` без consume/CAS. После подтверждённого online logout
  flow повторяется с token, который всё ещё находится только в памяти.
- Prepare валидирует current recovery hash, создаёт pending rotation с
  `revoke_sessions=1`, возвращает новую recovery link, но ничего не отзывает.
- После сохранения новой ссылки complete одной transaction:
  - проверяет expected generation;
  - активирует replacement hash и увеличивает generation;
  - инвалидирует старый recovery;
  - отзывает все старые sessions user;
  - отзывает все unexpired device links target user, включая
    consumed-but-retryable;
  - отзывает active invitations, созданные этим user;
  - создаёт одну новую normal session;
  - consume pending rotation;
- Cookie выставляется после commit.

Если prepare response потерян, active recovery и sessions не меняются. Клиент
до завершения flow держит в памяти исходный recovery token (если он был), новую
recovery URL, completion token и `nextGeneration`.

После uncertain complete результат определяется так:

1. всегда preview **точно новой recovery URL**; success доказывает, что именно
   она сейчас active — одной совпавшей generation недостаточно, потому что два
   prepare могут иметь одинаковый `nextGeneration`; probe выполняется только
   внутри явного flow, rate-limited и не логируется;
2. затем проверить `/api/session`: session того же user нужна для продолжения,
   но её generation сама по себе не доказывает победителя;
3. если новая link active, но browser guest, запустить public recovery уже с
   ней, показать и сохранить следующую replacement link и получить session;
4. если новая link invalid, а generation/source preview доказывают, что исходная
   rotation не произошла и completion ещё действует, retry того же completion;
5. если generation изменилась или source тоже invalid, другая/последующая
   rotation победила: текущую показанную link считать неактивной и не обещать,
   что предыдущая работает.

`ROTATION_STALE` всегда идёт по пункту 5. `LINK_INVALID` может означать как
expiry/revoke, так и потерянный response уже consumed complete, поэтому перед
сообщением пользователю всё равно обязателен пункт 1. Manual/initial flow при
неизменной generation может начать новый prepare из active session; public flow
может повториться с проверенной active исходной link. Для initial setup прежней
link нет. Этот алгоритм тестируется с drop до/после commit и двумя concurrent
prepare с одинаковым `nextGeneration`.

### Закрытие legacy claim

Если complete впервые активирует recovery для restricted legacy owner:

- `legacy_claims.state` атомарно меняется на `closed`, а `attempt_hash`,
  `pending_session_id` и `pending_expires_at` очищаются;
- restricted pending session отзывается, создаётся ровно одна новая normal
  session, все остальные sessions legacy owner отзываются;
- старый PIN больше не даёт доступ.

Все эти изменения входят в ту же transaction, что и активация recovery;
normal-session cookie выставляется только после commit. Если response потерян,
сохранённая уже активная recovery link позволяет запустить public recovery и
получить новую session.

## Обязательные тексты для клиента

При первой выдаче:

> Сохраните ссылку восстановления. Позже показать её снова будет нельзя — можно
> только заменить новой. Любой, у кого есть эта ссылка, получит полный доступ ко
> всем вашим пространствам.

Перед ручной ротацией:

> После завершения старая ссылка сразу перестанет работать. Сначала убедитесь,
> что сможете сохранить новую.

Перед complete восстановления:

> Сохраните новую ссылку прежде чем продолжить. После завершения старая ссылка
> перестанет работать, а все прежние устройства будут отключены.

После complete:

> Доступ восстановлен. Старая ссылка больше не работает, все прежние устройства
> отключены. Убедитесь, что новая ссылка сохранена.

При `ROTATION_STALE` после неуспешного preview показанной новой ссылки:

> Эта новая ссылка не активна: параллельно завершено другое изменение ссылки
> восстановления. Предыдущая ссылка тоже может уже не работать. Используйте
> последнюю подтверждённую ссылку или активное устройство, чтобы создать новую.

При expired/invalid completion и подтверждённой active предыдущей ссылке:

> Новая ссылка не активирована. Мы проверили, что предыдущая ссылка продолжает
> работать. Удалите сохранённую новую ссылку и повторите создание.

При initial setup без предыдущей ссылки:

> Новая ссылка не активирована. Вернитесь в приложение на этом устройстве и
> создайте новую; если это перенос старых данных и сессия истекла, повторите
> перенос с PIN.

## Rate limits и HTTP hardening

- Preview/accept: около 20/IP/мин.
- Invitation create: 10/workspace/час.
- Device link create: 5/user/час.
- Recovery prepare: 5/IP/15 минут; manual rotation 3/user/час.
- `429` содержит `Retry-After`.
- Все mutations проверяют exact Origin; mutation с body требует JSON content
  type, bodyless DELETE допустим без него и не принимает неожиданный body.
- Security headers и `no-store` проверяются тестами.
- Request/error logging централизованно redacts по имени поля `pin`, `token`,
  `attemptToken`, `completionToken` и не сериализует legacy PIN или access body
  даже на validation/5xx paths.

## Тесты

### Purpose isolation

- invitation token не принимается device/recovery endpoint;
- device token не добавляет membership;
- recovery token не работает как session token;
- raw secret отсутствует в SQLite dump и metadata list responses.

### Invitations

- preview не consume;
- identity + accept нового user и accept существующего user;
- only owner create/revoke;
- expiry/revoke/use дают одинаковое сообщение;
- one-use race имеет одного победителя;
- удалённый member не возвращается через старую consumed link.
- revoke/logout creator session делает её active invitations недействительными.

### Device links

- новая session имеет тот же userId и memberships;
- expiry и idempotent retry только с тем же attempt;
- lost response определяется session probe либо guest retry с тем же attempt;
- different current identity → conflict без consume;
- revoke accepted session, revoke creator session и recovery закрывают retry;
- `accept → revoke/logout/recovery → same attempt` всегда даёт `410` и не
  создаёт session.

### Recovery

- старая link действует после prepare и до complete;
- отменённая pending rotation ничего не меняет;
- manual complete не отзывает sessions;
- recovery complete отзывает все старые sessions и создаёт одну новую;
- после complete работает только новая recovery link;
- concurrent rotations защищены generation CAS, но одинаковый
  `nextGeneration` не считается доказательством конкретного победителя;
- lost-response сценарии остаются восстановимыми;
- drop до/после complete всегда начинает с exact new-link preview;
- concurrent prepare/complete проверяется точным preview replacement link, а не
  одной generation;
- recovery в browser другого user требует logout и не consume secret;
- initial setup можно отложить и повторить;
- legacy claim закрывается только после successful activation;
- потерянный response legacy activation восстанавливается через уже сохранённую
  active recovery link, а restricted session не оживает.
- Expiry vs initial complete race имеет одного transaction winner; complete при
  `pending_expires_at <= now` не активирует recovery/normal session и не может
  продлить restricted lease.

### URL/log safety

- URL строится из `APP_ORIGIN`, Host injection не влияет;
- endpoint path/query не содержит raw token;
- access responses `private, no-store`;
- validation/exception logs не содержат PIN/token/attempt/completion values;
- invalid token error не раскрывает kind/state/target.

## Критерии приёмки

- Три capability невозможно перепутать ни по API, ни по DB CHECK.
- Preview никогда не выдаёт доступ и не потребляет ссылку.
- Recovery никогда не инвалидирует старый secret до показа нового.
- Пользователь после каждой завершённой ротации получает явное требование
  сохранить новую ссылку.
- Владелец workspace не получает право управлять sessions участника.

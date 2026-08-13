# 01. Схема SQLite и перенос текущих данных

## Результат задачи

SQLite поддерживает профили, пространства и tenant-scoped данные. Существующие
расходы и категории без потерь оказываются в одном legacy-пространстве
«Основное», а старые PIN-сессии отозваны. Чистая установка не получает
автоматического пользователя или пространства.

Эта задача создаёт фундамент и **не должна выкладываться отдельно** от сервера и
клиента, которые понимают новую схему.

## Зависимости

- Прочитать [00-architecture.md](./00-architecture.md).
- Не менять существующие migration 1 и 2.
- До работы снять fixture текущей v2-схемы и проверить текущие migration tests.

## Владение файлами

Основные изменения:

- `server/src/db.ts`
- `server/src/types.ts` — только DB row types, согласованно с планом 02
- новый `server/test/migration.test.ts`
- при необходимости fixtures/helpers внутри `server/test/fixtures/`

Не реализовывать здесь HTTP-маршруты, UI и access-link lifecycle.

## Шаги

### 1. Сделать migration runner пригодным для сложной миграции

Текущий runner исполняет SQL-строки и после всех migration глобально seed'ит
категории. Для v3 требуется программная migration-функция:

- migrations 1 и 2 остаются байт-в-байт совместимыми;
- версия 3 выполняется одной управляемой транзакцией;
- migration получает заранее созданные UUID legacy user/workspace;
- повторный запуск не создаёт новые сущности;
- глобальный post-migration seed удаляется;
- появляется `seedWorkspaceCategories(db, workspaceId)`, вызываемый только при
  создании конкретного пространства.

### 2. Зафиксировать тип запуска до цикла migrations

До применения любой новой версии прочитать максимальную версию существующей БД
в `schemaVersionAtStartup`; отсутствие `schema_migrations`/пустой новой БД
записывается как `0`, но существующие versioned базы различаются точно:

- `schemaVersionAtStartup === 1 || schemaVersionAtStartup === 2` означает
  upgrade старой установки, даже если её domain-таблицы пусты;
- `schemaVersionAtStartup === 0` и прохождение 1 → 2 → 3 в одном startup
  означает чистую установку;
- версия выше известной до начала запуска — hard failure, не эвристика.

Определять upgrade по наличию categories запрещено: пустая, но уже развёрнутая
v1/v2-база иначе будет ошибочно признана новой.

### 3. Создать новые identity/access таблицы

Создать `users`, `workspaces`, `memberships`, новую `sessions`, `access_tokens`
и singleton `legacy_claims` по контракту из `00`.

Обязательные ограничения и индексы:

- unique hash для sessions/recovery/access tokens;
- индексы sessions по `user_id`, expiry и active/revoked state;
- индексы memberships по `user_id`;
- индексы access tokens по kind, target/workspace и expiry;
- CHECK по назначению полей каждого token kind;
- `recovery_generation >= 0`;
- `revoked_at`/`consumed_at` не используются как альтернативный способ
  определения kind.
- deferred composite owner FK гарантирует наличие owner membership;
- CHECK access tokens реализует полную truth table из `00`, включая
  `revoke_sessions IN (0,1)` и active/consumed device attempt fields.

`sessions` перестраивается, старые строки не копируются: общий PIN не позволяет
понять, каким людям принадлежали браузеры. Новая таблица содержит session kind
`normal|legacy_claim_pending`.

`legacy_claims` получает state CHECK-матрицу:

- `open`: `attempt_hash`, `pending_session_id`, `pending_expires_at` все NULL;
- `claimed_pending`: все три поля NOT NULL;
- `closed`: все три поля NULL.

Переход expired pending → open очищает поля и отзывает прежнюю restricted
session в одной transaction; переход → closed делает то же перед созданием
normal session.

Restricted session `expires_at` не превышает `pending_expires_at` и не
продлевается sliding update normal sessions. Claim/recovery transaction всегда
сравнивает pending expiry с одним transaction timestamp.

Из-за FK `access_tokens.created_by_session_id` порядок фиксирован:

1. создать `users`, `memberships` и `workspaces` с deferred cyclic owner FK;
2. создать `sessions_new`;
3. удалить старую `sessions` и переименовать `sessions_new`;
4. только затем создать `access_tokens` и `legacy_claims`.

`PRAGMA foreign_keys=ON` устанавливается до migration transaction и не
переключается внутри неё.

### 4. Перестроить tenant-scoped таблицы

Перестроить через временные таблицы, copy, drop и rename:

1. `categories_new` с PK `(workspace_id, id)` и уникальностью имени внутри
   пространства.
2. `expenses_new` с PK `(workspace_id, id)` и составным FK на category.
3. `sync_operations_new` с PK `(workspace_id, operation_id)`.

Соблюсти порядок зависимостей при drop/rename. Нельзя временно копировать расход
в категорию другого workspace. Индексы дат, порядка категорий и soft-delete
воссоздаются с `workspace_id` первым ключом там, где это улучшает scoped lookup.

### 5. Различить upgrade и чистую установку

Migration использует `schemaVersionAtStartup`:

- для любой уже существовавшей v1/v2 создать user-placeholder, workspace
  «Основное», owner
  membership и перенести в него все categories, expenses и sync results;
- сохранить IDs, versions, timestamps, archived/deleted flags и result JSON без
  смысловых изменений;
- создать одну строку `legacy_claims` со state `open`, workspace/owner IDs,
  пустыми attempt/session/expiry полями;
- для чистой БД, проходящей migrations 1 → 2 → 3 за один запуск, не создавать
  user/workspace/categories и не записывать open claim.

Причина последнего требования: seed старой схемы сейчас выполняется после цикла
migrations. Его нельзя случайно выполнить до определения legacy dataset.

### 6. Подготовить безопасный legacy claim

Сама HTTP-операция относится к плану 02, но `legacy_claims` должна позволять:

- claim существовать только для legacy owner;
- состояния `open → claimed_pending → closed`;
- в pending хранить hash 32-byte client attempt, restricted session ID и expiry;
- повторить потерянный response только с тем же attempt token; иной claimant
  получает `CLAIM_IN_PROGRESS` до expiry;
- после expiry атомарно снова открыть claim при следующей валидной PIN-попытке;
- атомарно закрыть claim после завершения первой recovery setup;
- после закрытия никогда не открывать его повторно при restart.

Старые session rows удаляются уже при migration. Нельзя автоматически считать
все старые браузеры устройствами одного владельца.

### 7. Добавить проверки целостности

В конце migration:

- выполнить `PRAGMA foreign_key_check` и оборвать startup при любой строке;
- выполнить `PRAGMA quick_check`;
- проверить, что у каждого workspace существует owner membership;
- проверить, что количество перенесённых строк совпало с исходным;
- не проглатывать ошибку и не записывать `schema_migrations.version=3` при
  неполном переносе.

Для production предусмотреть свободное место примерно под вторую копию основных
таблиц и WAL на время перестройки.

## Тесты

### Чистая база

- Старт создаёт v3 schema.
- `users`, `workspaces`, `memberships`, `categories` и `legacy_claims` пусты.
- Повторный start не меняет количество строк.

### Upgrade fixtures v1/v2

Fixture должна содержать:

- стандартные и пользовательскую category;
- archived category;
- active и soft-deleted expense;
- разные versions/timestamps;
- sync result;
- старую session.

После upgrade проверить:

- создано ровно одно «Основное», один owner-placeholder и один open claim;
- все доменные строки имеют один legacy workspace;
- значения и JSON совпадают с fixture;
- старая session отсутствует;
- composite FK и все индексы существуют;
- `foreign_key_check` и `quick_check` пусты/`ok`;
- второй restart идемпотентен.
- отдельные уже-v1/v2, но пустые fixtures всё равно создают legacy
  workspace/claim;
  новая schemaVersion=0 fixture — нет.

### Tenant keys

- Два workspace могут иметь category `products` и одно имя.
- Два workspace могут иметь одинаковый expense ID.
- Expense с `(workspace A, category B)` отклоняется FK.
- Один `operation_id` разрешён в A и B, но не дублируется внутри A.

### Failure atomicity

Искусственно вызвать ошибку в середине copy и доказать, что:

- schema version 3 не записана;
- исходные таблицы и строки доступны;
- следующий корректный запуск может повторить migration.

## Критерии приёмки

- Ни одна старая запись не теряет ID, version, timestamp или soft-delete state.
- Чистая установка начинается без скрытого «Основного».
- Системные categories создаются функцией только внутри нового workspace.
- Старые sessions не переживают migration.
- Owner membership гарантирован deferred FK, а не только application check.
- SQL на уровне БД запрещает cross-workspace category reference.
- Migration tests работают на временном файле SQLite, а не только `:memory:`.

## Передача следующему агенту

В отчёте указать:

- номер migration и полный список новых индексов/constraints;
- способ определения legacy dataset;
- shape `legacy_claims` и UUID legacy workspace fixture;
- результаты row-count, FK и quick-check tests;
- оценку дополнительного места, использованного migration fixture.

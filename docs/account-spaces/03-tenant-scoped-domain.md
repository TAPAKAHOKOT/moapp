# 03. Tenant-scoped расходы, категории, аналитика и sync

## Результат задачи

Все данные приложения адресуются через workspace route, проверяют membership и
фильтруются по `workspace_id` в каждом SQL-запросе. Невозможно прочитать,
изменить, связать или получить idempotency response другого пространства.

## Зависимости

- План 01: composite schema готова.
- План 02: доступны `requireAuth`, `requireWorkspaceMember` и тип auth context.

Эту задачу и план 04 можно выполнять параллельно после стабилизации core
helpers. Не использовать access token как замену обычной membership.

## Владение файлами

- `server/src/categories.ts`
- `server/src/expenses.ts`
- `server/src/analytics.ts`
- `server/src/sync.ts`
- `server/src/rates.ts`
- новый `server/test/tenant-isolation.test.ts`
- перенос релевантных сценариев из `server/test/api.test.ts`

Экспортировать самостоятельный `registerTenantDomainRoutes` plugin. Не менять
`server/src/app.ts`, `auth.ts` или shared types плана 02; wiring выполняет план
07. Domain row/input types держать в соответствующих modules. Tests регистрируют
plugin через общий test-app helper плана 02.

## Основной принцип

Защита двойная:

1. Workspace route pre-handler проверяет membership.
2. Каждый SELECT/INSERT/UPDATE/DELETE и domain helper требует workspace ID.

Каждая mutation повторно проверяет membership внутри той же synchronous SQLite
transaction, в которой меняет данные. После любого `await` между guard и чтением
membership проверяется снова.

Запрещён helper вида `getExpense(app, id)`. Требуется
`getExpense(app, workspaceId, id)`; то же относится к category и sync result.

## Шаги

### 1. Перенести маршруты под workspace prefix

Зарегистрировать:

```text
/api/workspaces/:workspaceId/bootstrap
/api/workspaces/:workspaceId/expenses...
/api/workspaces/:workspaceId/categories...
/api/workspaces/:workspaceId/analytics
/api/workspaces/:workspaceId/sync
```

Можно использовать scoped Fastify plugin, но params и request types должны быть
явными. `workspaceId` из body/query игнорируется или отклоняется.

Старые unscoped endpoints:

- `/api/bootstrap`
- `/api/expenses...`
- `/api/categories...`
- `/api/analytics`
- `/api/sync`

после cutover возвращают `410 UPGRADE_REQUIRED` без чтения/изменения данных.
Особенно важно запретить старый `/api/sync`, чтобы открытая вкладка старой PWA не
применила legacy outbox в неопределённое пространство.

### 2. Scoped bootstrap

Bootstrap выбирает:

- все categories только указанного workspace, включая archived для подписей
  истории;
- active expenses только этого workspace;
- глобальные currencies/rates;
- `workspaceId` и актуальную workspace summary.

Response всегда содержит ID пространства. Это позволяет клиенту отбросить
запаздывающий response после переключения.

### 3. Scoped expenses

Во всех операциях:

- lookup по `(workspace_id, id)`;
- create idempotency проверяет существующий ID только внутри workspace;
- category validation использует `(workspace_id, category_id)`;
- update/delete version conflict возвращает только current object того же
  workspace;
- cursor/list filters всегда начинаются с workspace predicate;
- чужой/отсутствующий ID → одинаковый `404`.

Не добавлять `workspaceId` в mutable expense body. Контекст задаёт URL.

### 4. Scoped categories

- Имена уникальны внутри workspace.
- Системные IDs могут повторяться.
- create idempotency проверяет только `(workspace_id,id)`.
- archive/update/delete lookup scoped.
- reorder загружает и обновляет только categories одного workspace.
- Unknown IDs из другого workspace не раскрываются и считаются invalid input.

### 5. Scoped analytics

SQL получает только active expenses workspace до фильтрации по календарным дням.
Category filter и map названий также scoped. Нельзя сначала загрузить все расходы
и затем надеяться отфильтровать tenant только в TypeScript.

`ensureRates` выполняет network `await`; после него analytics повторно проверяет
membership и только затем читает expenses. Иначе удалённый во время загрузки
курсов участник мог бы получить данные.

Курсы валют остаются глобальными и не дублируются по workspace.
`/api/rates/*` — global user-scoped endpoints: они требуют normal session и
expected identity headers, но не workspace membership. Из server endpoints
публичным без session остаётся только `/api/health`.

Все domain/rates/bootstrap responses получают `Cache-Control: private,
no-store`; offline-копирование делает только scoped IndexedDB клиента.

### 6. Scoped sync и idempotency

`POST /api/workspaces/:workspaceId/sync`:

- очередь по-прежнему ограничена 200 operations;
- replay lookup использует `(workspace_id, operation_id)`;
- stored result принадлежит workspace и не может быть возвращён другому;
- create/update/delete helpers получают workspaceId;
- вся пачка выполняется одной transaction, как сейчас;
- первая операция transaction повторно проверяет membership; removal до replay
  отклоняет всю пачку до domain mutation;
- response включает `workspaceId` и `serverTime`.

Result JSON не должен содержать внутренние owner/user данные.

### 7. Разделить тесты

Оставить тесты валют/дат, но перестроить setup:

- создать двух пользователей;
- workspace A и B;
- owner A добавить member при необходимости через fixture helper, не через ещё
  не готовый invite;
- выдавать отдельные cookies;
- создавать совпадающие IDs в обоих workspace.

## Обязательная isolation matrix

Для каждого ресурса проверить list/get/create/update/delete, где применимо:

| Сценарий | Ожидание |
|---|---|
| Member A читает A | success |
| Member A обращается к B без membership | 404 WORKSPACE_NOT_FOUND |
| ID объекта A передан в route B | 404, данные A не возвращены |
| Одинаковый ID существует в A и B | меняется только объект из route |
| Membership A удалён перед запросом | запрос отклонён до SQL mutation |

Отдельные тесты:

- category B нельзя присвоить expense A;
- reorder A не меняет sort/version B;
- analytics A не учитывает строки B даже при совпадающих датах/categories;
- sync operation UUID может существовать в A и B независимо;
- replay A никогда не возвращает result B;
- stale update A не содержит current B;
- archived/deleted records не теряются при scope.

## Критерии приёмки

- `rg` по domain SQL не находит lookup expense/category/sync только по `id` без
  workspace predicate, кроме явно глобальных migrations/tests.
- Все domain helpers требуют workspaceId в сигнатуре.
- Старый клиент не может ни прочитать, ни применить mutation.
- Rates и heartbeat остаются глобальными.
- Tenant isolation tests проходят отдельно и в полном `npm test`.

## Передача клиентскому агенту

Сообщить точные:

- workspace endpoint paths;
- bootstrap/sync response shapes с `workspaceId`;
- error code при удалённом membership;
- поведение old unscoped API;
- список routes, которые остаются user-scoped, но не workspace-scoped.

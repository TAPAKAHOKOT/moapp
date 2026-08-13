# 07. Интеграция, выкладка и QA

## Результат задачи

Все предыдущие планы собраны в один совместимый release, migration отрепетирована
на копии production DB, старый клиент не может писать данные после cutover, а
основные сценарии проверены минимум в двух независимых browser profiles и
offline режиме.

## Почему нужен отдельный cutover

Migration меняет первичные/внешние ключи основных таблиц. После появления
нескольких tenant простой запуск старого server image небезопасен: старый код не
фильтрует workspace и может раскрыть данные.

Поэтому:

- изменения схемы, scoped server routes и новый client выкладываются как один
  согласованный release;
- обычный rollback только на старый image запрещён;
- rollback после migration означает остановку записи, восстановление
  pre-cutover SQLite backup и запуск старого image, с осознанной потерей новых
  post-cutover записей;
- предпочтительный ответ на небольшую ошибку после начала использования —
  forward fix, если tenant isolation не нарушена.

Проект автоматически deploy'ит push в `main`. Координатор не должен отправлять
частично совместимые commits. Локальные agent changes сначала интегрируются и
проходят полный gate.

Исключение — план `00a`: это намеренно отдельный, обратно совместимый production
release. Основной cutover запрещён, пока он не развёрнут и известные устройства
не обновились/не синхронизировали старую очередь.

## 1. Интеграция кода

Integration-owner единолично меняет `server/src/app.ts`: регистрирует core,
tenant-domain и access plugins, ставит compatibility 410 handlers и проверяет
порядок hooks. Агенты 03/04 не редактируют этот файл параллельно.

### Свести контракты

Обновить и согласовать:

- `server/API_CONTRACT.md`
- `client/API_CONTRACT.md`
- `README.md`
- `README-deploy.md`
- `.env.example`
- `server/.env.example`
- `docker-compose.yml`

Убрать утверждения про общий PIN как обычную модель. Документировать:

- session/workspace/access endpoints;
- fragment links;
- offline cache privacy;
- migration claim;
- невозможность remote wipe уже скачанных данных;
- backup rollback consequences.

### Production config

- Добавить `APP_ORIGIN` в runtime config и сделать обязательным в production.
- `APP_PIN`/legacy PIN оставить необязательным только на migration window.
- Startup/readiness fail-fast при open/pending legacy claim без `APP_PIN`.
- После successful claim + recovery убрать PIN из production `.env` отдельным
  последующим deploy.
- Добавить configurable caps/TTLs, если они не зафиксированы безопасными
  defaults.
- Проверить cookie Secure/local development behavior.
- Ограничить `trustProxy` одним hop.

### Security headers

Проверить в фактическом HTTPS response:

- `Referrer-Policy: no-referrer`;
- CSP, включая `frame-ancestors 'none'`;
- HSTS;
- `X-Content-Type-Options: nosniff`;
- все session/profile/workspace/access API `Cache-Control: private, no-store`;
- cookie flags и отсутствие Domain.

CSP должна разрешать необходимые локальные styles/assets/worker, но не внешние
QR, analytics или third-party scripts на capability экранах.

## 2. Автоматический quality gate

Запустить из корня:

```text
npm run typecheck
npm test
npm run build
```

Дополнительно обязательно иметь отдельные suites:

- migration fixture/atomicity;
- auth/workspace roles;
- tenant isolation matrix;
- access links/recovery races;
- IndexedDB migration/isolation;
- root state race tests;
- component first-space/switch/settings/recovery flows.
- compatibility bundle против нового 410 behavior;
- lost-response identity/workspace/invite/device/recovery scenarios.

Проверить production bundle/service worker, а не только dev server.

## 3. Репетиция migration

На копии production SQLite, никогда не на live volume:

1. Получить свежую consistent copy/restore из Litestream.
2. Зафиксировать file size, row counts, schema version и quick check.
3. Запустить новый image/migration.
4. Проверить:
   - `PRAGMA quick_check`;
   - `PRAGMA foreign_key_check`;
   - counts categories/expenses/sync operations;
   - сохранение IDs, versions, timestamps, archived/deleted state;
   - ровно один legacy workspace/owner;
   - sessions старой модели отсутствуют;
   - повторный startup идемпотентен.
5. Измерить время migration, peak database/WAL size и нужное свободное место.
6. Прогнать новый API поверх migrated copy.
7. Выполнить тестовый restore pre-cutover backup, чтобы rollback был не только
   написан, но и проверен.

Rollback rehearsal запускает old image только после ротации `SESSION_SECRET` в
isolated env: иначе восстановленные старые session rows/cookies могут ожить.

## 4. Сквозная browser matrix

Использовать минимум два независимых browser profiles A/B и при возможности
третье устройство C.

### Новый инстанс

- A видит «Создать пространство», создаёт профиль + «Дом».
- Потерянные identity/workspace responses не создают дубль workspace и flow
  завершается через session probe/stable workspace ID.
- A сохраняет initial recovery, перезагружается и остаётся в «Дом».
- A создаёт «Личное», оно становится active.
- Switch Дом ↔ Личное не смешивает expenses/categories/analytics/preferences.
- Offline доступны только ранее загруженные workspace.

### Invitation

- A создаёт invite/QR «Дом».
- Preview B не consume.
- B вводит display name, принимает, видит только «Дом».
- Потерянный accept response определяется session membership, invite не создаёт
  недоступный профиль.
- A видит B в participants, но не его devices.
- B создаёт expense; A получает его после refresh/sync.
- A удаляет B; online API B немедленно закрывается, outbox B не применяется.
- Подтвердить и задокументировать, что старая offline-копия B остаётся читаемой
  до reconnect/local cleanup.

### Device link

- A создаёт device link; C подключается к тому же user.
- Drop device accept response сначала проверяется session probe, а guest retry с
  тем же attempt не создаёт независимого user/неограниченных sessions.
- C видит оба workspace A.
- В sessions A/C отображаются отдельно.
- Отзыв C не удаляет A и memberships.
- Active invite, выпущенный C до его отзыва, после revoke C даёт `410`.
- Попытка принять link в browser B требует явного выхода из B, не merge.

### Recovery

- Prepare не отключает A/C и не инвалидирует старую link.
- До complete показать/сохранить новую link.
- Complete отзывает A/C, создаёт current recovered session.
- Старая link больше не работает, новая работает.
- Потерянный prepare/complete response смоделирован и не создаёт необратимый
  lockout.
- Два prepare с одинаковым `nextGeneration` завершаются одним CAS-победителем;
  UI определяет его exact preview новой ссылки, а не одной generation.
- Recovery link в browser другого user требует confirmed online logout и не
  смешивает local caches.
- Manual rotation из settings не отзывает sessions, но заменяет old recovery.

### Offline/races

- Создать offline mutation в A/Дом, переключиться на Личное, восстановить сеть:
  mutation уходит только в Дом.
- Быстро переключать workspace при задержанных bootstrap/analytics responses:
  данные не мерцают и не заменяются.
- Logout offline очищает local data/блокирует UI и завершает server revoke после
  reconnect.
- Reload после offline logout не вызывает session/bootstrap до server revoke.
- Cached session после expiry не открывает workspace offline.
- Вкладка A с queued mutation блокируется, когда вкладка B выходит и подключает
  другой profile; direct stale request A с old expected IDs получает
  `SESSION_CONTEXT_CHANGED` и не пишет даже в общий для обоих workspace.

## 5. Legacy production cutover

Перед выкладкой:

- убедиться, что compatibility-релиз `00a` установлен на известных устройствах,
  а их legacy outbox синхронизирован либо сохранён;
- убедиться в свежем verified R2 backup и записать restore timestamp;
- проверить свободное место;
- предупредить активных пользователей о коротком обновлении и закрытии старых
  tabs;
- подготовить old image digest и точную rollback процедуру;
- не публиковать legacy PIN в логах/чатах.

После deploy:

1. Проверить health, schema version, quick/FK checks и logs без token bodies.
2. Новый client показывает legacy claim, старый client получает
   `UPGRADE_REQUIRED`, сохраняет outbox и запускает update flow.
3. Владелец claim'ит «Основное» старым PIN, display name и in-memory attempt;
   competing claim блокируется.
4. Обязательно сохранить и complete recovery; до этого workspace недоступен.
5. Убедиться, что claim `closed`, session normal. Затем одной resumable
   migration привязать legacy cache/outbox к `legacyWorkspaceId` и проверить sync
   до создания других workspace.
6. Переименовать «Основное» при желании.
7. Подключить свои дополнительные устройства device link.
8. Пригласить остальных людей invitation links.
9. Удалить `APP_PIN` из production env отдельным контролируемым изменением и
   проверить restart/readiness.

## 6. Наблюдение после release

Не логируя PII/secrets, наблюдать:

- 5xx/429/410 по endpoint family;
- migration/health/backup heartbeat;
- число orphan/pending access rows и их cleanup;
- количество rejected workspace access attempts как aggregate;
- sync conflicts/errors по workspace ID только в server-internal структурированных
  logs, без raw payload/notes;
- рост SQLite/WAL и backup freshness.

Не добавлять raw capability, display names, expense notes или cookie в logs.
Logger/validation hooks redacts поля `pin`, `token`, `attemptToken` и
`completionToken`, включая legacy claim и 5xx paths.

## 7. Stop conditions

Остановить cutover и не разрешать дальнейшие записи, если:

- foreign key/quick check не проходит;
- row counts legacy data расходятся;
- старый unscoped sync принимает mutation;
- один tenant видит объект/analytics другого;
- recovery complete может погасить последнюю ссылку до показа новой;
- service worker/cache сохраняет capability URL/token;
- backup restore не проверен.
- compatibility release не подтверждён на известных устройствах;
- legacy claim может открыть данные до recovery activation;

## Definition of Done

- Все автоматические и browser matrix проверки пройдены.
- Legacy data claim'нуты, recovery владельца сохранён, old PIN удалён.
- Несколько workspace и участников реально проверены на разных profiles.
- Tenant isolation проверена не только UI, но прямыми API tests.
- Production backup продолжает реплицироваться и weekly restore check проходит.
- Документация описывает фактическое, а не планируемое API.
- Нет незакрытых временных compatibility endpoints, которые могут читать или
  писать unscoped данные.
- Старые auth aliases не принимают PIN; compatibility update сохранит queue.

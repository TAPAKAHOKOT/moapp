# 00a. Предварительный compatibility-релиз

## Результат задачи

До изменения SQLite/API текущая однопространственная версия клиента получает
защиту offline-очереди и умеет безопасно обновиться при будущем
`UPGRADE_REQUIRED`. Этот небольшой релиз выкладывается в `main` отдельно и
заранее; только после его проверки разрешён multi-tenant cutover.

## Почему это обязательно

Текущий `submitExpenseOperations` удаляет queued operation почти после любой
HTTP-ошибки. После нового сервера старая вкладка получит `401` или
`410 UPGRADE_REQUIRED` и может безвозвратно удалить расход, который пользователь
создал offline. Просьба «закрыть старые вкладки» не является механизмом
сохранности данных.

## Границы задачи

Изменять только текущий клиент и его tests/service-worker update UX. Не добавлять
users/workspaces, не менять SQLite и не переключать существующие endpoints.
Релиз должен быть полностью совместим с текущим production server.

Основные файлы:

- `client/src/api.ts`
- `client/src/App.tsx`
- `client/src/api.test.ts`
- `client/public/sw.js`
- при необходимости небольшой version/update helper

## Шаги

### 1. Никогда не удалять outbox при недоказанном результате

В online submit/sync catch:

- `401 UNAUTHORIZED` сохраняет все затронутые outbox rows;
- `410 UPGRADE_REQUIRED` сохраняет все rows;
- неизвестный response/parse error и 5xx также сохраняют rows;
- удалять queued row можно только после явного sync result
  `applied|unchanged|error` от совместимого endpoint;
- validation `error` по конкретной operation может удалить только её после
  rollback и понятного сообщения.

Это правило полезно и после перехода: отсутствие доказанного результата означает
retry с тем же operationId.

### 2. Ввести обязательное состояние обновления

На `UPGRADE_REQUIRED` клиент:

- прекращает новые server mutations;
- оставляет cached bootstrap/outbox нетронутыми;
- показывает полноэкранное «Нужно обновить приложение»;
- вызывает `serviceWorkerRegistration.update()`;
- отслеживает `updatefound`/installing state и при наличии waiting worker
  предлагает одну кнопку «Обновить», даже если обновление обнаружено до первого
  `410` (например, старая PWA открыта по новой invite/recovery link);
- после `controllerchange` выполняет reload;
- не маскирует ошибку как «Неверный PIN».

На `401` обычный lock остаётся, но outbox не очищается. Если последующий PIN
endpoint вернёт `UPGRADE_REQUIRED`, включается update state.

### 3. Безопасно активировать новый worker

Добавить message flow `SKIP_WAITING` только после явной кнопки. Перед reload:

- дождаться завершения IndexedDB writes;
- не вызывать logout/clearOfflineData;
- не удалять старый outbox;
- если форма имеет dirty несохранённый draft, отложить reload и попросить
  сохранить/отменить его; submitted mutation уже защищена outbox.

Полный build-time precache выполняется в плане 05; здесь нужен только надёжный
update handshake текущей PWA.

### 4. Добавить compatibility tests

- queued create/update/delete остаются после `401`;
- queued rows остаются после `410 UPGRADE_REQUIRED`;
- generic 5xx/invalid response не удаляет недоказанную operation;
- explicit per-operation validation result удаляет только соответствующую row;
- update state не вызывает logout/clear storage;
- waiting update обнаруживается через `updatefound` и активируется message
  protocol независимо от того, был ли `410`;
- повтор после reload использует тот же operationId.

Отдельный regression test запускает этот собранный compatibility bundle против
fixture нового server behavior: unscoped sync отвечает 410, а очередь остаётся
пригодной для последующей legacy migration.

## Выкладка до основной реализации

1. Прогнать текущие typecheck/test/build.
2. Отправить compatibility commit в `main` отдельным Conventional Commit.
3. Дождаться production deploy.
4. Открыть PWA на всех известных активных устройствах, проверить новую версию и
   успешную отправку текущего outbox.
5. Оставить этот релиз доступным до начала cutover и явно подтвердить, что
   известные устройства обновились.

Невозможно гарантировать сохранность неизвестной старой установки, которая ни
разу не получила compatibility-релиз и хранит локальные изменения. Это
операционный residual risk: перед cutover владелец либо подтверждает отсутствие
таких устройств, либо откладывает миграцию.

## Критерии приёмки

- Релиз не меняет текущую server/schema модель и безопасно работает в
  production до основного cutover.
- Любая недоказанная server mutation остаётся в outbox.
- `UPGRADE_REQUIRED` приводит к update UI, а не очистке данных или PIN error.
- Реальный собранный compatibility bundle сохраняет очередь при ответе будущего
  server fixture.

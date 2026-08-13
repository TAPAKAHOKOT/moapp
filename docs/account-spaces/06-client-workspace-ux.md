# 06. Минималистичный UI пространств и доступа

## Результат задачи

Пользователь видит простой интерфейс без формы регистрации: создаёт первое или
дополнительное пространство, переключается через шапку, приглашает людей,
подключает своё устройство и безопасно настраивает recovery. Сложная модель
доступа спрятана в настройках и не перегружает ежедневный учёт расходов.

## Зависимости

- План 05 предоставляет root state, capability intent, scoped API/storage.
- Server endpoints планов 02–04 доступны.
- Текущий visual language и mobile gestures сохраняются.

## Владение файлами

- `client/src/App.tsx`
- `client/src/main.tsx`
- `client/src/styles.css`
- удаление legacy `client/src/api.ts`, `client/src/offline.ts`, перенос/удаление
  их старых tests и всех unscoped imports после переключения App;
- рекомендуемые новые компоненты:
  - `client/src/workspaces/WorkspaceSwitcher.tsx`
  - `client/src/workspaces/CreateWorkspaceSheet.tsx`
  - `client/src/access/CapabilityFlow.tsx`
  - `client/src/access/RecoverySaveSheet.tsx`
  - `client/src/settings/ParticipantsSection.tsx`
  - `client/src/settings/AccessSection.tsx`
- component/integration tests
- QR dependency в `client/package.json`
- manifest description при необходимости

Не возвращать tenant logic внутрь визуальных компонентов; использовать foundation
из плана 05.

Эта задача атомарно переводит App на `workspace-api.ts`/
`workspace-offline.ts`, подключает capability parser до render и удаляет старые
unscoped exports/modules. После каждого commit в итоговой серии build должен
компилироваться; смешивать scoped UI с unscoped mutation запрещено.

## 1. Главная страница без пространства

### Чистый browser

Если нет session и capability intent:

- логотип/краткое описание;
- одна primary кнопка **«Создать пространство»**;
- при legacy migration availability — отдельный неброский путь
  «Продолжить с существующими расходами», не обычный PIN login.

После кнопки показать минимальный sheet с двумя полями:

- «Как вас называть»;
- «Название пространства».

Это onboarding, а не экран регистрации: никаких email, пароля, подтверждений или
обязательных профилей.

По submit клиент последовательно вызывает `/api/identity`, затем idempotent
`/api/workspaces` со stable UUID. При uncertain identity result сначала делает
session probe; при uncertain workspace result повторяет тот же UUID. Для
пользователя это остаётся одним действием и одним loading state.

### Перенос существующих расходов

Путь «Продолжить с существующими расходами» открывает `LegacyClaimFlow`:

- одно поле display name и текущий PIN;
- 32-byte attemptToken создаётся один раз в памяти;
- rate limit/`CLAIM_IN_PROGRESS` показываются отдельно от wrong PIN;
- successful claim переводит в blocking recovery screen, workspace ещё не
  открывается и действия «Позже» нет;
- после complete session становится normal, legacy IndexedDB migration одной
  транзакцией привязывает queue/cache к `legacyWorkspaceId`;
- только затем загружается «Основное».

### Профиль без memberships

Если session существует, но workspace list пуст:

- та же empty page и кнопка;
- спрашивать только название пространства;
- объяснить, что профиль сохранён и можно создать новое пространство.

После success новое пространство сразу active. Если recovery ещё не настроен,
предложить initial recovery flow.

### Известный локальный профиль без server session

`known-user-locked` — не экран нового пользователя. Он не показывает cached
расходы и не предлагает Create, пока человек не выбрал:

- «Восстановить доступ» к тому же профилю;
- destructive «Забыть локальный профиль» с предупреждением о локальной очереди.

Invite в этом состоянии сначала требует recovery либо forget. Device/recovery
preview сравнивает `targetUserId`: тот же профиль сохраняет его local data,
другой требует подтверждённой очистки до продолжения. Неожиданная active server
session другого user также блокирует render до выбора, а не смешивает caches.

## 2. Быстрое переключение

Название текущего пространства постоянно доступно в общей шапке над pager, а не
спрятано в Settings. Нажатие открывает bottom sheet:

- список workspace;
- check у active;
- роль при необходимости вторичным текстом;
- offline/outbox/conflict badge рядом с соответствующим workspace;
- внизу **«Создать пространство»**.

При выборе:

- переключить active ID;
- сразу показать cached bootstrap, если он есть;
- запустить network refresh;
- remount workspace pager через `key={workspaceId}`;
- сбросить `currentId`, expense draft/editor, history selection, analytics result,
  category sheet и pending confirmations прошлого пространства.

Если текущий expense draft непустой, перед switch показать короткое подтверждение
об отбрасывании; пустой экран переключается мгновенно.

Некэшированное workspace offline видимо, но disabled с понятной подписью.

## 3. Создание дополнительного пространства

Одинаковый `CreateWorkspaceSheet` вызывается:

- из switcher;
- из Settings → «Пространства».

Для authenticated user одно поле «Название». Success:

- обновляет session workspace list;
- делает workspace active;
- закрывает sheet;
- показывает короткий toast;
- не заставляет повторно сохранять personal recovery, если он уже настроен.

## 4. Структура Settings

Переименовать текущий экран «Категории» в полноценные «Настройки», сохранив
редактор categories как отдельную секцию:

1. **Пространство** — название, роль, создать новое; owner может переименовать.
2. **Участники** — люди текущего workspace и приглашение.
3. **Доступ** — имя профиля, мои устройства, подключить устройство, recovery.
4. **Категории** — существующий функционал.
5. **Это устройство** — theme и logout/clear local data.

Секции access могут быть свёрнуты/открывать sheets, чтобы основной экран не стал
визуально тяжёлым.

Все management operations и списки participants/sessions/invitations —
online-only и не кэшируются. Offline показываются только workspace summary и
disabled actions с подписью «Нужно подключение к интернету»; stale
participant/device lists не отображаются.

## 5. Участники, не устройства

Список участников показывает отображаемое имя и owner/member. Это список людей:

- owner видит «Пригласить человека», revoke active invitation и remove member;
- member не может удалять других;
- member видит «Выйти из пространства»;
- owner вместо выхода видит передачу владения выбранному member;
- удаление/выход всегда подтверждаются с объяснением, что server access закроется
  на всех устройствах человека.

Нельзя обещать удалённое стирание уже загруженного offline cache.
Если у member есть pending outbox, выход требует выбора «Сначала
синхронизировать» или destructive «Выйти и отбросить N изменений».

### Invite UX

Owner создаёт link, после чего sheet предлагает:

- Copy link;
- native Share, если доступен;
- QR, сгенерированный локально;
- expiry и «Отозвать».

Никаких внешних QR/shortener сервисов.
QR и Copy используют ровно URL, возвращённый server; client не реконструирует
origin или fragment.

Получатель:

1. видит preview с названием workspace;
2. явно нажимает «Присоединиться»;
3. guest вводит display name; UI сначала создаёт identity/session и только затем
   authenticated accept;
4. existing user подтверждает «Присоединиться как …»;
5. workspace добавляется и становится active;
6. для нового user предлагается recovery setup.

`ALREADY_MEMBER` означает «пространство уже добавлено»: обновить memberships и
сделать его active, не показывая generic error и не consume invitation.

Preview не погашает ссылку — это защищает от link scanners.

## 6. Мои устройства

Отдельный раздел показывает sessions текущего user:

- понятный label;
- current marker;
- last activity;
- revoke для других sessions.

Под revoke явно написано: доступ этой server session прекратится, но уже
скачанные на другом устройстве offline-данные удалённо стереть невозможно.

Кнопка **«Подключить моё устройство»** генерирует короткоживущую link/QR.
Получатель device link видит имя профиля и подтверждает подключение.
На flow генерируется один in-memory `attemptToken`, повторно используемый при
unknown network result. Сначала выполнить session probe: новая session в
изначально guest browser означает success; только если browser остался guest,
повторить accept с тем же attempt.

Если браузер уже относится к другому профилю:

- показать предупреждение, что локальные данные текущего профиля будут удалены;
- потребовать явный выход online;
- только после successful logout принимать device link;
- никогда не merge profiles автоматически.

Та же identity-conflict процедура обязательна для recovery другого профиля:
recovery token остаётся только в памяти, выполняется confirmed online logout и
flow продолжается без reload.

## 7. Recovery UX

### Initial setup

После первого workspace/invite, если `recoveryConfigured=false`, предложить
настроить восстановление. Prepare показывает:

- предупреждение из плана 04;
- Copy/Share;
- локальный QR;
- подтверждение **«Я сохранил ссылку»** → complete;
- действие «Позже» → pending не complete, recovery остаётся ненастроенным.

Settings в этом случае показывает заметное, но не блокирующее
«Восстановление не настроено».

Исключение — migrated legacy claim: recovery blocking, «Позже» отсутствует.

### Ротация из настроек

Старую ссылку показать невозможно. Кнопка:

**«Создать новую ссылку восстановления»**

Перед prepare показать, что старая перестанет работать только после завершения.
После выдачи новой complete доступен лишь после явного подтверждения сохранения.
После complete вывести отдельное сообщение:

> Новая ссылка сохранена. Предыдущая ссылка больше не работает.

Manual rotation не отключает остальные устройства.

### Recovery по ссылке

1. Preview и кнопка «Восстановить доступ».
2. Prepare возвращает новую ссылку.
3. Обязательный экран сохранения; complete не вызывается автоматически.
4. Перед complete точный текст о ротации и отключении прежних устройств.
5. После complete новый профиль/session загружается, старая ссылка не работает,
   UI ещё раз напоминает сохранить новую.

Если complete response неизвестен:

- сначала preview ровно новой показанной recovery link: только active preview
  доказывает committed именно этой rotation;
- session и `recoveryGeneration` использовать как дополнительное состояние, но
  не как доказательство победителя;
- active новая link при guest означает запуск recovery заново по ней с выдачей
  ещё одной replacement link;
- invalid новая link разрешает retry прежнего completion только если
  generation/preview исходной link доказывают, что другая rotation не победила.

Ни completion token, ни новая recovery link не записываются в storage.

## 8. Обработка capability ошибок

- Invalid/expired/used/revoked: единый экран «Ссылка недействительна или больше
  не действует».
- Offline при preview: не расходовать intent; предложить повторить после сети в
  пределах текущей вкладки.
- Identity conflict: отдельный confirm, не generic toast.
- Rate limit: показать время повторной попытки, если есть `Retry-After`.
- `ROTATION_STALE`: новая сохранённая ссылка не active, параллельная rotation
  победила, а старая тоже может уже не работать;
- expired/invalid completion: сначала exact preview новой ссылки, затем обещать
  работу старой только после её проверки; initial setup возвращается к active
  session без упоминания несуществующей старой ссылки.
- После очистки hash секрет не восстанавливается при полном reload; это лучше,
  чем сохранять его небезопасно. Пользователь может открыть исходную link снова.

## 9. Сохранение текущих UX-возможностей

- Expense keypad, swipe history, charts и theme не меняют бизнес-поведение.
- Workspace header не должен ломать viewport/pager sizing на mobile Safari.
- Draft одного workspace никогда не показывается в другом. В MVP switch
  сбрасывает только подтверждённый несохранённый draft; отдельные per-workspace
  drafts можно добавить позже.
- Category mutation остаётся online-only, но теперь scoped.

## Тесты

Для component flows добавить Testing Library/jsdom.

### Основные сценарии

- Guest без intent видит одну primary Create кнопку, не PIN.
- Known-user без server session видит locked/recovery, а не Create; forget явно
  предупреждает и очищает локальную очередь только после подтверждения.
- Recovery/device того же known user сохраняет cache/outbox, другого — требует
  cleanup; неожиданная session другого user не render'ит смешанное состояние.
- Смена/logout профиля в соседней вкладке сразу lock'ит текущую; её pending
  outbox не отправляется под новой browser cookie.
- Guest create спрашивает два имени; existing no-workspace — только workspace.
- Lost identity response сначала проверяет session; lost workspace response не
  создаёт дубль благодаря stable ID.
- Legacy claim с competing attempt блокируется; restricted claim не открывает
  данные до recovery и затем запускает exact offline migration.
- Create из Settings и switcher использует один компонент и сразу активирует
  result.
- Switch A → B remount'ит workspace UI и не оставляет state A.
- Offline switch доступен только для cached workspace.

### Roles/settings

- Owner/member видят разные controls.
- Remove member, leave и transfer имеют правильные подтверждения.
- Участники и «Мои устройства» не смешаны.
- Current session нельзя случайно удалить как другого участника.

### Links/recovery

- Preview не вызывает accept.
- Guest/existing invite flows отличаются только display-name шагом.
- Lost invitation accept определяется через session memberships.
- QR кодирует exact fragment URL, полученный от server.
- Device identity conflict требует confirmed logout.
- Recovery identity conflict требует тот же confirmed online logout.
- Device accept retry использует тот же in-memory attempt.
- Lost device response сначала проверяет session и только для guest повторяет
  accept.
- Initial recovery можно отложить.
- Manual/recovery complete невозможно вызвать до save acknowledgement.
- Drop complete response начинается с exact new-link preview; generation не
  используется как единственное доказательство.
- Два concurrent prepare с одинаковым `nextGeneration` корректно определяют
  победителя по preview конкретной ссылки.
- Failed complete различает stale, проверенную старую link и initial setup без
  старой ссылки.
- После любой завершённой ротации явно написано, что нужно хранить новую ссылку и
  старая больше не работает.

### Regression

- Expense create/edit/delete/sync в A работают после multiple switches.
- Analytics request получает active workspace ID.
- Delayed analytics A никогда не заменяет экран B.
- Mobile pager/header не перекрывают bottom nav и sheets.

## Критерии приёмки

- Повседневный экран добавления расхода получает только один новый постоянный
  элемент — компактный workspace switcher.
- Создание workspace — максимум одно поле для существующего user.
- Регистрационной формы, email и password нет.
- Access complexity находится в Settings, а participants и devices имеют
  понятную разную семантику.
- Recovery невозможно завершить без экрана сохранения новой ссылки.

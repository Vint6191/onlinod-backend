# Проверка актуальных исходников (157)

Проверенная среда: Node 22.23.3, npm, Linux. Пакет содержит исходники и тесты, а не Windows-установщик. Нативные Electron/Windows и многосессионные PostgreSQL-проверки требуют отдельного окружения.

Все команды выполняются в изолированной копии проекта без production-подключений. `npm run test:all` обнаруживает все `*.test`/`*.spec` с расширениями js/mjs/cjs, включая каталоги вне src; исключает node_modules, dist и .git. Не используйте production DATABASE_URL для тестов. Интеграционные тесты сохраняют собственные условия запуска и отмечаются SKIP без нужного окружения.

1. Установите зависимости Backend и Desktop через `npm ci` под Node 22. В Desktop выполните `npm run build` и `npm run typecheck`.
2. Для запуска SQLite-тестов вне Electron в отдельной тестовой копии Desktop выполните `npm rebuild better-sqlite3 --build-from-source`. Для запуска самого Electron после этих тестов восстановите ABI командой `npm run rebuild:native`. Не переносите node_modules из тестовой копии в установленное приложение.
3. Создайте отдельный локальный каталог SQL-стенда с зависимостями `@electric-sql/pglite@0.5.8` и `@electric-sql/pglite-socket@0.2.11`. В переменной ONLINOD_SQL_PROOF_RUNTIME задайте абсолютный путь этого каталога. Стенд создаёт свою одноразовую БД и устанавливает единую актуальную схему. Старые миграции и процедуры переноса данных не используются.
4. Задайте ONLINOD_BACKEND_ROOT и ONLINOD_DESKTOP_ROOT абсолютными путями двух проектов, а ONLINOD_CAMPAIGN_EVIDENCE — абсолютным путём отдельного каталога результатов. Из Backend запустите:

```sh
npm run test:database
npm run test:database-overlay
npm run test:admin-diagnostics
npm run test:server-startup
npm run test:product-acceptance
node scripts/audit/campaign-read/proof.cjs
node scripts/audit/destructive-control-state-proof.cjs
npm run test:auth-sql
npm run test:all
```

5. Из собранного Desktop с теми же ONLINOD_* переменными запустите `npm run test:all`. Он использует четыре ответа, полученные настоящими SQL-чтениями Backend, и выполняет также проверку их совместимости с Desktop. Отсутствие этих файлов — ошибка, а не молчаливый пропуск. Порядок подготовки переменных зависит от вашей оболочки; значения должны быть абсолютными путями.

`node scripts/test-all.cjs --list` печатает точный список обнаруженных тестовых файлов без запуска. Отдельные старые gate-команды продолжают проверять только свои области. Зелёный полный JS-прогон не означает, что пропущенные интеграционные и нативные проверки пройдены.

`npm run test:database` проверяет настоящий установщик Prisma на пустой БД, повторный запуск, физические бизнес-ограничения, первый вход и текущие задачи. В ONLINOD_SQL_PROOF_OUTPUT можно задать каталог JSON-результата; по умолчанию создаётся временный каталог. Стенд PGlite использует один SQL-сеанс и не подтверждает многосессионную работу обычного PostgreSQL.

Для новой установки задайте DATABASE_URL пустой БД с public-схемой и выполните `npm run prisma:migrate`. Существующая старая БД по умолчанию отклоняется без удаления данных. Для одноразового удаления старой тестовой схемы до 153 в той же БД задайте Build Command Render: `npm install && npm run prisma:migrate -- --reset-legacy-test-database`. Команда удаляет старую public-схему со всеми её тестовыми данными и устанавливает актуальную. После успеха верните `npm install && npm run prisma:migrate`. Повтор той же команды с флагом сохраняет уже установленную актуальную БД; текущая, повреждённая или более новая запись baseline не разрешает сброс. Новая БД, платный тариф и SQL-консоль не требуются. BAT удаляет только перечисленные устаревшие исходники из корня проекта; он не копирует файлы, не собирает приложение и не очищает БД/профиль.

Установщик передаёт Prisma только проверенную текущую миграцию в отдельном временном каталоге. Соседние старые каталоги не исполняются и больше не блокируют установку. BAT нужен для очистки исходников; удаления следует включить в Git-коммит. SQL-проверка `test:database-overlay` проверяет этот сценарий, повторный запуск, CRLF, подмену/отсутствие текущей миграции и сохранность старой непустой БД при отказе. Она создаёт собственную одноразовую БД и не использует DATABASE_URL приложения.

`test:admin-diagnostics` проверяет полный проход по 20 000 исторических доставок и дополнительным текущим состояниям: настоящие дубли отправок, обычную пару отправка/удаление, отсутствие ID у завершённых отправок, неизвестный исход записи и просроченное удаление бампа. Старый зависший курсор и старые результаты CRM автоматически заменяются новым наблюдением. Проверяются откат неудачного сохранения, ограниченные страницы, повторный запуск и SQL-план.

`test:server-startup` запускает именно `src/server.js` с обычными фоновыми таймерами на отдельной БД, ждёт первый общий sweep, проверяет `/health` и `/ready`, завершает процесс через SIGTERM и повторно запускает с теми же данными. Эти проверки воспроизводят ошибку после успешной сборки, которую проверка одной лишь схемы не обнаруживает. PGlite остаётся односессионным стендом; многосессионная конкуренция PostgreSQL здесь не подтверждается.

`test:product-acceptance` связывает настоящий HTTP-процесс Backend, Prisma и текущие Desktop-модули команд, шифрования и чтения Home/Campaigns. Требуются установленный Desktop (`ONLINOD_DESKTOP_ROOT`, используется его esbuild) и описанный выше SQL-стенд. Команда сама создаёт изолированную БД; DATABASE_URL приложения не используется. JSON-результат и серверный лог сохраняются в `ONLINOD_SQL_PROOF_OUTPUT/evidence/product-acceptance`; без этой переменной создаётся временный каталог. Письма, ключи и клиентские журналы используют только синтетические данные, находятся в отдельном временном каталоге и удаляются при завершении.

Проход включает регистрацию с подтверждением почты, две модели с зашифрованными сессиями, текущие HTTP read models, команды настроек, пять Automation-модулей, Bump/SFS templates, 17 команд управления сканами, Message Library, медиаметаданные, Customs, второй Desktop identity, Team и Admin. Реальный Desktop-журнал восстанавливается после потерянного ответа и SIGKILL Backend; повтор Custom проверяется до и после следующего изменения заказа. Проверяются отзыв доступа уже выданного токена, stale session revision, отказ старых unkeyed writes и сохранность данных после обычного перезапуска.

Это проверка перечисленных связей и контрактов. Почтовый провайдер заменён контролируемым адаптером; OF identity задана тестовыми данными, внешние fetch запрещены. Полный сбор OF, Telegram instruction/review/relay, S3 upload, нативный Browser/Windows UI, локальная AI-модель и многосессионные блокировки PostgreSQL этим проходом не подтверждаются. Команда не добавляется в Render build/start и не нужна для обычного развёртывания.

## Полный локальный цикл Customs (158)

С теми же `ONLINOD_DESKTOP_ROOT`, `ONLINOD_SQL_PROOF_RUNTIME` и `ONLINOD_SQL_PROOF_OUTPUT` выполните `npm run test:custom-acceptance` из Backend. Нужны зависимости обоих проектов; `better-sqlite3` в изолированной тестовой копии Desktop должен соответствовать запускающему Node 22. Electron-сборку native-модуля для этой команды не используйте. Результат и журнал сервера записываются в `evidence/custom-acceptance`.

Стенд запускает настоящий Backend и Prisma на текущей схеме, а также настоящие Desktop `CustomOrdersService`, `VaultService`, write authority и файловые SQLite-журналы. Проверяются создание заказа, Telegram TASK и повторы, входящий ответ модели, перенос в Vault, проверка контента, переделка с новой версией, подготовка цены и медиа, выдача фанату и отмена. Отдельно проверяются общий SQL-откат source claim/reserve/operator settlement, потеря ответов begin/confirm/relay-complete, неопределённый Telegram outcome, повторное открытие SQLite и SIGKILL Backend. Потерянный ответ relay-complete проходит штатную паузу повторной обработки около 90 секунд: часы и retry-поля не меняются. Весь проход ограничен 180 секундами.

Порт Telegram, OF/S3, composer и события нативной страницы контролируются стендом; реальных сообщений он не отправляет. Сервисы ONLINOD и их SQL/HTTP/SQLite-переходы выполняются без подмены. Native Windows/Electron, настоящие провайдеры и многосессионная конкуренция PostgreSQL остаются отдельной целевой проверкой. Команда предназначена для разработки и не добавляется в Render build/start. Обычная сборка остаётся `npm install && npm run prisma:migrate`.

## Связанный цикл Automation и React UI (159)

`npm run test:automation-acceptance` использует `ONLINOD_DESKTOP_ROOT`, `ONLINOD_SQL_PROOF_RUNTIME`, `ONLINOD_SQL_PROOF_OUTPUT` как предыдущие стенды. Дополнительно задайте `ONLINOD_BROWSER_RUNTIME` — каталог с Playwright и `@sparticuz/chromium`; `ONLINOD_CHROMIUM_PATH` позволяет использовать уже установленный Chromium. Нужен Node 22 и соответствующий ему `better-sqlite3` в тестовой копии Desktop. Стенд создаёт собственную одноразовую БД; DATABASE_URL приложения не используется.

Настоящие React-компоненты открываются в Chromium и через текущие RPC-обработчики, Desktop-сервисы и журнал команд обращаются к настоящему Backend. Отправки исполняет текущий BackendActionWorker через настоящий WorkCoordinator/SQLite. Likes и SFS сканируются текущими readonly handlers с настоящими HTTP lease/progress/complete; для SFS используются серверные токены наблюдений. Начальная публикация SubscriberDirectory и текущие отношения фанатов заданы изолированным SQL-стендом.

Проверяются десять разделов Automation, шаблон Bump и переключение модели, live presence -> Bump -> история, pause/resume во время preflight, Follow Back, Likes discovery/execution, Refollow, полный SFS discovery/follow/scan/comment/like/unfollow, сохранение cleanup при паузе, потеря подтверждения complete, readback неизвестного send, продолжение очереди после сверки и SIGKILL Backend. Выборка готовых задач проверяется в UTC, Europe/Kyiv и America/New_York. Штатные паузы и сроки не подменяются; общий предел — 600 секунд. Вывод: `evidence/automation-acceptance`, включая JSON, журналы и снимки интерфейса.

OF и нативные Electron-порты контролируются стендом: настоящих отправок нет. Проверка не подтверждает нативный Windows/Electron, настоящий OF или многосессионную конкуренцию PostgreSQL. Команда не нужна на Render; обычная сборка остаётся `npm install && npm run prisma:migrate`.

## Связанный Subscriber Directory / FanData / UI (160)

`npm run test:subscriber-acceptance` использует те же изолированные SQL/browser runtime и переменные окружения, что Automation159. Нужен Node22 и совместимый `better-sqlite3`. Стенд не использует DATABASE_URL приложения и не создаёт начальные строки Subscriber/FanData напрямую.

Настоящие React-компоненты, CreatorService/bootstrap, SubscriberDirectoryService, management journal, BackendReadonlyJobWorker, обработчики subscriber scan/point refresh, SQLite WorkCoordinator и BackendActionWorker обращаются к текущему Backend/Prisma/SQL. Контролируются только физические OF-ответы и native capability/session-reconcile порты.

Сценарии:225 подписчиков / три страницы; остановка и повторное открытие SQLite между страницами; атомарная видимость опубликованного списка; неизвестные деньги и generic isActive; UI Ignore/Block; смена состава при rescan; потеря progress/complete ACK; обновление имени/суммы и поиск/сортировка по текущим данным; изменение допуска Bump во время preflight; Backend SIGKILL; изоляция моделей; явный пустой terminal source. Обычные паузы и lease-сроки не подменяются. Предел600 секунд. Результат — `evidence/subscriber-acceptance` (JSON, журналы, снимки UI).

Это локальная связанная проверка с одним физическим SQL-сеансом PGlite. Настоящие Windows/Electron, OF и многосессионная конкуренция PostgreSQL ею не подтверждаются. Команда только для разработки; Render build остаётся `npm install && npm run prisma:migrate`.

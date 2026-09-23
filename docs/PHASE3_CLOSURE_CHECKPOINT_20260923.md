# Phase 3 — текущий checkpoint: Analytics coordinator, 2026-09-23

**SOURCE OPEN / SCALE OPEN.** Прежний Render blocker снят; обнаружены нарушения протокола владения и отдельный архитектурный блокер масштаба. Этот delta исправляет владение и восстановление. Он не объявляет Phase 3 закрытой.

Текущий actual: `onlinod-backend-main - 2026-09-23T155943.875.zip`, SHA-256 `ef61552692436a3ee989a8b387221d0ecc946d0aae07532ecbd869cb2348bb7f`. Он побайтово совпал с предыдущим исправленным Backend. ZIP текущей итерации содержит только изменения относительно этого actual; прежние 13 исправленных файлов повторно целиком не выдаются.

Успешный Render checkout `2367e87b7f6bdfb35159413c6f585c5408fb2df6`: прежние 40 offline проверок и 180 физических проверок (60 clean / 60 rolling / 60 seeded) прошли; fixture leaks отсутствуют, primary migrations завершены, DomainWork topology ACTIVE, gate ok=true, service live. Этот результат относится к предыдущему source. Новое изменение ещё требует физического proof.

## Подтверждённые причины и реализованный протокол

- `analytics-collection-planner.js`: heartbeat и completion проверяли token/cycle/revision, но не истечение lease. Старый worker мог оживить истёкшую аренду, сохранить cursor, завершить demand или отправить его в quarantine до появления нового владельца.
- Разные advisory locks у demand claim и enqueue/settlement не сериализовали один ряд. Claim мог использовать уже изменившийся revision/state. Все операции теперь берут один row lock, затем читают PostgreSQL clock и актуальный ряд; settlement/heartbeat требуют ещё живой lease. Предикаты renewal/completion также содержат expiry fence.
- Lease, истёкший в следующем UTC-часе, сбрасывал незавершённый cursor. Теперь takeover сохраняет исходный cycleKey/cycleNow/cursor; следующий цикл начинается после завершения прежнего. Это относится и к Earnings, и к Creator Analytics.
- Home sweep проглатывал processing failure/claim loss и возвращал ok=true. Теперь bounded результат содержит failures/errors и ok=false, чтобы scheduler health видел деградацию.
- Все production writes этих двух Prisma моделей в `src` найдены в этом сервисе. Lock order: advisory lock при необходимости → row lock → DB clock → conditional transition. Heartbeat берёт только row lock. Локальный fallback now используется только адаптерами без raw SQL; production каждый раз читает текущий DB clock.

Граница исправления: это fencing прогресса/завершения координатора. Оно не доказывает, что каждая создаваемая задача коммитится под тем же lease, и не устраняет глобальные обходы. Существующая per-creator/window idempotency остаётся отдельной защитой повторного планирования.

## Проверки текущего delta

- До production-изменения: новый набор воспроизвёл 10 падений (9 новых regressions и исправленное ожидание восстановления через границу часа).
- После: Analytics planner 31/31; расширенный целевой набор 80/80.
- Syntax/no-undef gate: 89 файлов; Prisma contract scan: 360 файлов, нарушений нет.
- Дополнительный physical test проверяет expiry без takeover, неизменность состояния после stale completion/quarantine, сохранение cursor/cycle через смену часа, fencing старого token после takeover и completion действующим владельцем через два Prisma clients.
- Pinned manifest A36-R3: 13 файлов, 61 тест на сценарий, 183 суммарно; SHA-256 `eee216ba1f281ad6d43edebe784f59ef60418e1e2451d5e353bf115bcff8ecf8`. Прежние 60 проверок сохранены; новый physical test не заменён mock-проверкой.
- A29 pre-DB gate теперь включает также Analytics planner и guard версии physical manifest. Локальный PostgreSQL недоступен: новая физическая проверка здесь не выполнена.

Финальные числа общего и pre-DB набора записаны в `docs/PHASE3_ANALYTICS_COORDINATOR_CHECKPOINT_20260923.txt`. Исходные 103 падения общего набора не объявлены устранёнными: часть относится к старым Team/E2E mocks, retired APIs, whitespace-sensitive schema assertions и внешним Desktop paths. Это требует отдельной привязки к актуальным контрактам, а не массовой замены expectations.

## Оставшийся узел и production architecture следующего изменения

| Граница | Fresh-source evidence | Условие closure |
| --- | --- | --- |
| Earnings recurring | `runAnalyticsCollectionSweep`: все READY creators под одним lease; страницы ограничены, весь запуск — нет | Durable per-creator due work, ограниченный batch/time budget, fair agency admission, восстановление независимо от глобального cursor |
| Creator Analytics | `runCreatorAnalyticsCatchupSweep`: глобальный обход; ошибка creator увеличивает failures, cursor идёт дальше, цикл может завершиться с ok=true | Долг не теряется: отдельный durable retry/backoff/quarantine на creator; ошибка видна в health; bounded planning commits |
| Campaign discovery | `selectCampaignDirectoryDiscoveryAdmissions`: перебор due rows может пройти весь набор, если кандидаты заняты | Индексируемый due admission с durable continuation/fairness; лимит просмотренных строк без starvation хвоста |
| Home demand | `processAnalyticsDemand`: один demand может пройти всю agency за один вызов | Durable chunk/continuation, ограниченное время владения и честное yield; revision/access checks сохраняются на каждом chunk |
| Capacity projection | `readCanonicalCapacityInputs`: глобальные агрегаты по current collection/demand/job state | Поддерживаемые инкрементально rebuildable projections; bounded dirty repair, reconciliation вне hot path |
| Scheduler | Analytics global lanes исполняются последовательно перед остальной recurring работой | Отдельные bounded lanes; медленный creator/agency не блокирует остальные домены |

Следующий implementation должен провести эти связанные planners через единый durable due-work lifecycle: один creator/domain work item → bounded claim → commit planning under live ownership → yield/retry/complete. Включить creator/agency lifecycle, backfill существующих READY creators, generation-aware rollout, удаление прежних global planners, индексы, restart/expiry/partial failure tests и per-agency fairness. Нельзя просто добавить LIMIT в старый цикл: без durable continuation это создаст starvation. Нельзя оставлять старый global writer рядом с новой очередью.

До cutover необходимо проверить пригодность существующего `DomainWorkItem` для этих work classes и точные транзакционные границы planner. Эта часть — целевая архитектура, ещё не реализованный факт. Уже существующий bounded `CREATOR_RECURRING_PLANNING` lane не заменяет Earnings/Creator Analytics lanes.

SCALE proof: сочетание many agencies × many creators, крупная история, 100 workers, несколько replicas; оценивать scanned rows, query count/time, locks, retry debt и максимальное ожидание agency. Прежние 1000 agencies × 4 creators и отдельно 4 agencies × 1000 creators не доказывают одновременный большой размер обеих осей. Для этой границы нужно также доказать конкурентные enqueue/claim/settlement и expiration при ожидании row lock на PostgreSQL; unit interleaving не заменяет такой proof.

Master roadmap: остаёмся в Phase 3 / Analytics planning closure. Прежний Render proof blocker CLOSED; Analytics coordinator correction IMPLEMENTED / PHYSICAL PROOF PENDING; global planning и capacity scale OPEN. Новый project-wide resweep понадобится после изменения общей очереди/schema/access. Другие функциональные узлы сейчас не переписываются.

## Применение

Распаковать delta поверх текущего Backend с сохранением путей. Удалений, изменений Prisma schema, миграций, зависимостей и Desktop в этом delta нет. Команда остаётся `npm install && npm run audit:phase3-a29-render`. Это deploy gate: после успешного disposable proof он запускает миграции primary DB. Новый ожидаемый physical результат — 61/61 во всех трёх сценариях, ноль skips/leaks, затем успешный gate. Даже этот результат не закрывает перечисленные SCALE-блокеры.

Ниже сохранён **исторический checkpoint предыдущего delta**. Его исходный actual, числа тестов и статус ожидания proof относятся только к прежней итерации; актуальный статус находится выше.

# История: исправление Render proof contract

Статус: исправление реализовано; локальные проверки выполнены. **SOURCE CLOSED / SCALE CLOSED не объявлены.** Исправленный физический proof на PostgreSQL ещё не выполнен.

## Единственный исходный actual для этого delta

- Backend: `onlinod-backend-main - 2026-09-23T151434.459.zip`.
- SHA-256 Backend ZIP: `35640122f57997233bfd36cddbe09ad5b495649d2e10ef3adb2449710048ee9b`.
- Render-лог: `Вставленная ​​уценка(20260923-121900).md`.
- SHA-256 лога: `a9d0582722b66a3f841381a3579c72b0316a684f8be39ee138e28d87de8a79d0`.
- Render checkout в этом логе: `707f94e3fcae9511db449d6f9a74ece65e785829`.

Архив содержит только изменённые/новые файлы относительно этого Backend. Предыдущие исправления уже присутствуют в actual и повторно в delta не включены. Desktop, Prisma schema, миграции, зависимости и physical-test manifest не менялись.

## Что оказалось сломано

В предоставленном логе сценарий регистрирует 60 физических тестов: 56 pass, 4 fail. Все четыре падения находятся в `phase3-a34-source-scale-closure.integration.test.js`. Они не доказывают deadlock новой архитектуры: проверки прерываются на ошибочных fixtures/SQL-контрактах до нужных утверждений. Но и считать архитектуру доказанной по ним нельзя.

| Граница | Причина | Исправление |
| --- | --- | --- |
| Prisma model / бизнес-роль | `AgencyMember.role = CHATTER` отсутствует в `UserRole`; `roleKey = chatter` — отдельный контракт | `role = OPERATOR`, `roleKey` сохранён; исправлены все пять таких физических fixtures в исходнике |
| Prisma / PostgreSQL | `queryRaw` пытается декодировать возвращаемый `void` от `pg_sleep` и destructive guard | Команды используют `executeRaw`; исключения PostgreSQL продолжают прерывать транзакцию |
| Production observation clock | Та же ошибка `pg_sleep` присутствовала в activation-service; mock возвращал невозможный декодированный результат | Исправлен production-вызов; mock запрещает старый путь; `activatedAt` берётся из проверенного DB clock |
| Конкурентный proof | Односторонний сигнал + sleep не гарантировали нужного пересечения; раннее отклонение `Promise.all` позволяло начать teardown до завершения второй транзакции | Общий двусторонний барьер, ограниченное ожидание, проброс первой ошибки и `allSettled` перед cleanup |
| Fixture lifecycle | User удалялся root-клиентом вне Team-generation транзакции, ошибка проглатывалась; лог фиксирует User leak | Используется canonical fixture graph с generation admission; порядок work → creator → agency → user; disconnect выполняется и при ошибке cleanup |
| Preflight | Syntax/no-undef и source assertions пропускали несовместимые контракты | AST-проверка всех production JS, scripts и integration fixtures: enum literals сверяются с generated Prisma DMMF, известные void-команды — с PostgreSQL builtins/миграциями |
| Диагностика | Один Prisma error с 1000 creator IDs многократно печатался целиком; пересекающиеся digest windows дублировались | Ограниченный console head/tail с сохранением причины в конце ошибки; уникальные позиции строк; полный error остаётся в step logs и JSON report |

Это дефект самого контура доказательства, а не только четыре опечатки: неверные mocks и fixtures давали локальную уверенность, а реальные контракты впервые проверялись на Render. Теперь существующий `audit:phase3-a29-render` запускает также 40 offline contract/runtime regressions до создания disposable database.

Статический preflight имеет честную границу: он проверяет известные literal/const-контракты, не заменяет проверку динамического SQL, транзакций, миграций и нагрузки на настоящем PostgreSQL.

## Проверено на новом source

Среда локальной проверки: Node 24.19.0, Prisma 5.22.0. В присланном Render-логе — Node 22.23.2. Локальный запуск не выдается за проверку окружения Render.

- Целевой набор: **40/40 pass, 0 fail, 0 skip**.
- В него входят 16 новых regressions: enum/void contract, negative examples, гарантированное пересечение, отказ до/после барьера, timeout, non-Error rejection, завершение клиентов, bounded diagnostics, lossless TAP parsing, generation-fenced cleanup обеих schema generations.
- Changed-JS gate: **87 файлов**, syntax/no-undef без ошибок.
- Prisma source preflight: **360 файлов**, 0 нарушений. На неизменённом входном actual тот же preflight обнаруживает **9 нарушений** — в том числе все четыре места из Render-лога и production activation.
- PostgreSQL identifier lint: pass; 0 новых oversized identifiers / collisions.
- Полный локальный набор до изменений: 3167 tests, 2955 pass, 103 fail, 109 skip.
- Полный локальный набор после изменений: 3183 tests, 2971 pass, 103 fail, 109 skip.
- Имена всех 103 исходных падений совпадают; новых падений нет. Общий набор **не зелёный**, эти существующие проблемы не считаются закрытыми данным исправлением.

В локальной среде нет доступного PostgreSQL / DATABASE_URL. Установка PostgreSQL заблокирована разрешениями среды. Моки и статические результаты не подменяют отсутствующее физическое доказательство.

## Применение и следующий обязательный proof

Распаковать ZIP поверх корня указанного Backend с сохранением путей. Файлы удалять не требуется. Старые migration-файлы не редактировались; дополнительных миграций этот delta не добавляет.

Команда Render остаётся прежней:

```sh
npm install && npm run audit:phase3-a29-render
```

Она выполняет identifier/source/offline gates, затем физический proof в disposable database; только после успешного proof и удаления disposable database запускает миграции основной БД. Это deploy-команда, не read-only диагностика.

Обязательные условия для принятия результата:

1. `proof-contracts-pass` после успешных static gates.
2. Все три physical migration-сценария: **60/60**, fail=0, skipped=0, без fixture leaks. Два opposite-order tests теперь действительно принуждают пересечение транзакций.
3. Проверки исходного pack на member scope, 1000 agencies / 4000 creators / two replicas, exact destructive claims, restart/fencing и остальные scale assertions проходят без ослабления требований.
4. Успешный schema/disposable cleanup, затем `PHASE3_A29_RENDER_GATE_RESULT` с `ok:true` и `primaryMigrationStatus:0`.
5. Сохранить новый actual и JSON proof, затем продолжить fresh-source adversarial closure этого же узла. Один зелёный build сам по себе не закрывает весь проект и не доказывает все возможные нагрузки.

Pinned physical manifest сохранён: 13 файлов, 60 тестов на сценарий, 180 суммарно; canonical SHA-256 `e07ba94a0d839e7eb403cfc252ca15764c134d6e5df746e4006d98f5f22e479b`. Ни один physical test не удалён, не добавлен в skip и не заменён offline-проверкой.

Полные диагностические артефакты следующего запуска:

- `artifacts/audit/phase3-a26-postgres-proof.json`
- `artifacts/audit/phase3-a26-failure-manifest.json`
- `artifacts/audit/phase3-a20-steps/*.log`

Master roadmap: текущий Phase 3 узел остаётся **OPEN / PHYSICAL REPROOF REQUIRED**. К следующему domain по результатам этого delta не переходим.

# Phase 3 — closure continues, 2026-09-23

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

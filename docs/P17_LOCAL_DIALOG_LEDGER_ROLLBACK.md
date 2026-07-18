# P17 — возврат полной истории диалогов в локальную SQLite

## Зафиксированная граница хранения

Начиная с этой версии единственным рабочим хранилищем полной истории OnlyFans является Desktop:

```text
.runtime/chromium/root/desktop-cache/dialog-messages-lite/dialog-messages.sqlite
```

Локально сохраняются:

- полный текст сообщений;
- `messageId`, `dialogId`, sender/recipient и timestamps;
- PPV price/currency;
- `isOpened` / `isFree`;
- media ID, asset ID, owner и fan-media признак;
- локальные purchase signals;
- CRM scan state, CRM profile и AI revision state;
- локальная Vault Asset Sales projection.

Backend хранит только:

- durable jobs, claim/lease и continuation;
- scan run/state и компактные счётчики;
- message ID/observations, необходимые для безопасной остановки incremental scan;
- reconciliation targets и фундамент под возможную будущую серверную миграцию.

Backend **не является хранилищем текста переписки**. Модели `DialogMessageLedger`, `DialogMessageMedia`, `DialogPurchaseSignal`, `VaultPurchaseLedger`, `VaultPurchaseMedia` и `VaultAssetSalesAggregate` временно сохранены только как dormant legacy schema для безопасного forward migration и отдельной очистки уже накопленных данных.

## Порядок развёртывания

1. Сделать backup PostgreSQL и исходников.
2. Сначала развернуть backend из этого комплекта. Это немедленно прекращает новые записи полной переписки от старых Desktop-сборок: legacy `/ingest/ws` подтверждает запрос, но ничего не сохраняет.
3. Затем закрыть ONLINOD на компьютере и установить Desktop из этого комплекта.
4. Запустить небольшой тестовый диалог и проверить рост локальной базы `dialog-messages.sqlite`.
5. Проверить, что количество строк в серверных legacy-таблицах больше не растёт.
6. Только после проверки использовать отдельный cleanup SQL.

## Что не делает обновление автоматически

- не удаляет существующие серверные строки;
- не запускает `TRUNCATE`, `DELETE`, `VACUUM FULL` или миграцию с потерей данных;
- не удаляет legacy Prisma-модели;
- не переносит локальную базу между разными компьютерами.

## Важное ограничение local-only архитектуры

Локальная SQLite принадлежит конкретной установке Desktop. История и CRM-профиль не синхронизируются между компьютерами через PostgreSQL. При отсутствии завершённого локального scan state Desktop запрашивает полный scan, даже если серверный checkpoint был завершён другим компьютером. Сервер остаётся координатором durable work, но не источником полной истории.

## Проверка остановки роста

До очистки выполните read-only часть:

```text
scripts/p17_inspect_and_cleanup_legacy_dialog_ledger.sql
```

Запишите `row_count` и `total_size`, подождите хотя бы один рабочий цикл сканера и выполните read-only блок повторно. Очистку запускайте только если значения legacy message/media/purchase таблиц больше не растут.

-- P17 LOCAL DIALOG LEDGER
--
-- По умолчанию этот файл выполняет ТОЛЬКО read-only инвентаризацию.
-- Деструктивный TRUNCATE защищён явным session flag и не запускается случайно.
--
-- Рекомендуемый порядок:
--   1. Deploy нового backend.
--   2. Deploy нового Desktop.
--   3. Выполнить этот файл без SET-флага и сохранить результат.
--   4. Убедиться, что legacy-таблицы больше не растут.
--   5. Сделать backup PostgreSQL.
--   6. В ОДНОЙ И ТОЙ ЖЕ сессии выполнить:
--        SET onlinod.allow_p17_legacy_cleanup = 'yes';
--      затем выполнить весь файл повторно.
--
-- TRUNCATE освобождает страницы таблиц значительно быстрее большого DELETE.
-- Схема/Prisma-модели остаются на месте как dormant foundation.

SELECT
  c.relname AS table_name,
  COALESCE(s.n_live_tup, 0)::bigint AS estimated_rows,
  pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
  pg_total_relation_size(c.oid) AS total_size_bytes
FROM pg_class c
LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
WHERE c.relkind = 'r'
  AND c.relname IN (
    'DialogMessageLedger',
    'DialogMessageMedia',
    'DialogPurchaseSignal',
    'VaultPurchaseLedger',
    'VaultPurchaseMedia',
    'VaultAssetSalesAggregate'
  )
ORDER BY pg_total_relation_size(c.oid) DESC;

SELECT
  (SELECT COUNT(*) FROM "DialogMessageLedger") AS dialog_messages,
  (SELECT COUNT(*) FROM "DialogMessageMedia") AS dialog_media,
  (SELECT COUNT(*) FROM "DialogPurchaseSignal") AS purchase_signals,
  (SELECT COUNT(*) FROM "VaultPurchaseLedger") AS vault_purchases,
  (SELECT COUNT(*) FROM "VaultPurchaseMedia") AS vault_purchase_media,
  (SELECT COUNT(*) FROM "VaultAssetSalesAggregate") AS vault_aggregates;

DO $$
BEGIN
  IF current_setting('onlinod.allow_p17_legacy_cleanup', true) IS DISTINCT FROM 'yes' THEN
    RAISE NOTICE 'Read-only inspection complete. Cleanup NOT executed. Set onlinod.allow_p17_legacy_cleanup=yes in this session after backup and deploy verification.';
    RETURN;
  END IF;

  RAISE WARNING 'P17 legacy dialog/Vault server data will be permanently truncated now.';

  -- All FK-related legacy tables are included in one statement, so PostgreSQL
  -- can truncate them without CASCADE touching unrelated business tables.
  EXECUTE $truncate$
    TRUNCATE TABLE
      "VaultPurchaseMedia",
      "VaultPurchaseLedger",
      "VaultAssetSalesAggregate",
      "DialogMessageMedia",
      "DialogMessageLedger",
      "DialogPurchaseSignal"
  $truncate$;
END
$$;

SELECT
  (SELECT COUNT(*) FROM "DialogMessageLedger") AS dialog_messages_after,
  (SELECT COUNT(*) FROM "DialogMessageMedia") AS dialog_media_after,
  (SELECT COUNT(*) FROM "DialogPurchaseSignal") AS purchase_signals_after,
  (SELECT COUNT(*) FROM "VaultPurchaseLedger") AS vault_purchases_after,
  (SELECT COUNT(*) FROM "VaultPurchaseMedia") AS vault_purchase_media_after,
  (SELECT COUNT(*) FROM "VaultAssetSalesAggregate") AS vault_aggregates_after;

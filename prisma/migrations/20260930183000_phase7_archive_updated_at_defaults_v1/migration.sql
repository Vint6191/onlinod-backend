-- Align the five retained archive columns with the original SQL migrations and
-- the Phase7 physical contract. The deployed database was observed to have no
-- default on these NOT NULL timestamp(3) columns (Render 2026-09-30, V4 report).
-- This changes catalog defaults only. Existing rows and updatedAt values stay
-- unchanged; all Phase7 writer fences and constraints remain in force.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
DECLARE
  target_table text;
  column_state record;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'AutomationRule',
    'CreatorPresenceSnapshot',
    'CreatorPresenceUser',
    'MessageTemplateGroup',
    'MessageTemplate'
  ] LOOP
    -- Inspect while holding the DDL lock so a concurrent schema change cannot
    -- turn the reviewed NULL/default case into an unrelated overwritten value.
    EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE', target_table);
    SELECT c.relkind, a.atttypid, a.atttypmod, a.attnotnull, a.attgenerated,
           pg_get_expr(d.adbin, d.adrelid) AS default_expression
      INTO column_state
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
    WHERE n.nspname = 'public' AND c.relname = target_table
      AND a.attname = 'updatedAt' AND a.attnum > 0 AND NOT a.attisdropped;

    IF NOT FOUND OR column_state.relkind <> 'r'
       OR column_state.atttypid <> 'pg_catalog.timestamp'::regtype
       OR column_state.atttypmod <> 3
       OR NOT column_state.attnotnull OR column_state.attgenerated <> '' THEN
      RAISE EXCEPTION 'PHASE7_ARCHIVE_UPDATED_AT_COLUMN_INVALID:%', target_table;
    END IF;
    IF column_state.default_expression IS NULL THEN
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP', target_table);
    ELSIF column_state.default_expression <> 'CURRENT_TIMESTAMP' THEN
      RAISE EXCEPTION 'PHASE7_ARCHIVE_UPDATED_AT_DEFAULT_UNEXPECTED:%:%', target_table, column_state.default_expression;
    END IF;
  END LOOP;
END $$;
COMMIT;

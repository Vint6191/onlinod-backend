BEGIN;

-- Audit15 Closure5 forward-only migration finalization.
--
-- Never edit/replay an already-applied historical migration to repair these
-- rows. Closure2 may already have deleted MoneyAttribution, so every decision
-- below is derived exclusively from the canonical TeamTipLedger row.
--
-- 1) state-only legacy manual rows are durable MANUAL authority even when the
--    old MoneyAttribution history array was empty;
-- 2) proven legacy AUTO rows are classified once and left available to the
--    current automatic projector;
-- 3) rows whose old authority evidence was already destroyed are fail-closed
--    as conflict/manual-review instead of being silently auto-attributed.

-- Definite state-only MANUAL authority preserved by the Closure2 migration.
UPDATE "TeamTipLedger" t
SET
  "status" = CASE
    WHEN LOWER(COALESCE(t."result"->>'legacyState', t."result"->'legacyMigration'->>'legacyState', '')) = 'claimed'
      THEN 'claimed'
    WHEN LOWER(COALESCE(t."result"->>'legacyState', t."result"->'legacyMigration'->>'legacyState', '')) = 'manager'
      AND t."attributedMemberId" IS NOT NULL THEN 'resolved'
    WHEN LOWER(COALESCE(t."result"->>'legacyState', t."result"->'legacyMigration'->>'legacyState', '')) = 'manager'
      THEN 'creator_revenue'
    WHEN LOWER(COALESCE(t."result"->>'legacyState', t."result"->'legacyMigration'->>'legacyState', '')) = 'released'
      AND t."attributedMemberId" IS NOT NULL THEN 'claimed'
    WHEN LOWER(COALESCE(t."result"->>'legacyState', t."result"->'legacyMigration'->>'legacyState', '')) = 'released'
      THEN 'released'
    ELSE t."status"
  END,
  "attributedUserId" = CASE
    WHEN t."attributedMemberId" IS NULL THEN NULL
    ELSE (
      SELECT am."userId"
      FROM "AgencyMember" am
      WHERE am."agencyId" = t."agencyId" AND am."id" = t."attributedMemberId"
      LIMIT 1
    )
  END,
  "attributedShiftKey" = NULL,
  "resolvedAt" = COALESCE(t."resolvedAt", t."updatedAt", t."receivedAt"),
  "resolvedSource" = 'manual_legacy_money_attribution_forward_repair_state_' ||
    LOWER(COALESCE(t."result"->>'legacyState', t."result"->'legacyMigration'->>'legacyState', 'manual')),
  "result" = COALESCE(t."result", '{}'::jsonb) || jsonb_build_object(
    'audit15Closure5ManualRepairScan', jsonb_build_object(
      'classified', true,
      'classification', 'state_only_manual_repaired',
      'classifiedAt', CURRENT_TIMESTAMP,
      'source', 'audit15_closure5_forward_migration'
    )
  ),
  "history" = COALESCE(t."history", '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
    'ts', (extract(epoch from CURRENT_TIMESTAMP) * 1000)::bigint,
    'action', 'audit15_closure5_repair_state_only_manual_authority',
    'reason', 'Recovered durable MANUAL authority from Closure2 legacyState after MoneyAttribution removal',
    'prevOwner', t."attributedMemberId",
    'nextOwner', t."attributedMemberId",
    'source', 'audit15_closure5_forward_migration'
  )),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE LEFT(COALESCE(t."resolvedSource", ''), 7) <> 'manual_'
  AND COALESCE(t."result"->'audit15Closure5ManualRepairScan'->>'classified', 'false') <> 'true'
  AND (
    t."resolvedSource" IN ('legacy_money_attribution_migration','audit15_legacy_money_attribution_migration')
    OR t."source" IN ('legacy_money_attribution_migration','audit15_legacy_money_attribution_migration')
    OR COALESCE(t."result"->>'migratedFrom','') = 'MoneyAttribution'
    OR (t."result" ? 'legacyMigration')
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(t."history", '[]'::jsonb)) h(item)
      WHERE h.item->>'action' IN ('migrate_legacy_tip_to_team_tip_ledger','audit15_migrate_legacy_tip_to_team_tip_ledger')
    )
  )
  AND (
    LOWER(COALESCE(t."result"->>'legacyState', t."result"->'legacyMigration'->>'legacyState', '')) IN ('manager','released')
    OR (
      LOWER(COALESCE(t."result"->>'legacyState', t."result"->'legacyMigration'->>'legacyState', '')) = 'claimed'
      AND t."attributedMemberId" IS NOT NULL
    )
  );

-- Proven old AUTO rows are not MANUAL. Mark them processed so the bounded
-- runtime safety-net advances instead of selecting the same harmless rows.
UPDATE "TeamTipLedger" t
SET
  "result" = COALESCE(t."result", '{}'::jsonb) || jsonb_build_object(
    'audit15Closure5ManualRepairScan', jsonb_build_object(
      'classified', true,
      'classification', 'legacy_auto_no_manual_evidence',
      'classifiedAt', CURRENT_TIMESTAMP,
      'source', 'audit15_closure5_forward_migration'
    )
  ),
  "history" = COALESCE(t."history", '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
    'ts', (extract(epoch from CURRENT_TIMESTAMP) * 1000)::bigint,
    'action', 'audit15_closure5_classify_legacy_auto_no_manual_evidence',
    'classification', 'legacy_auto_no_manual_evidence',
    'reason', 'Legacy state proves AUTO and contains no MANUAL authority evidence',
    'source', 'audit15_closure5_forward_migration'
  )),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE LEFT(COALESCE(t."resolvedSource", ''), 7) <> 'manual_'
  AND COALESCE(t."result"->'audit15Closure5ManualRepairScan'->>'classified', 'false') <> 'true'
  AND LOWER(COALESCE(t."result"->>'legacyState', t."result"->'legacyMigration'->>'legacyState', '')) = 'auto'
  AND (
    t."resolvedSource" IN ('legacy_money_attribution_migration','audit15_legacy_money_attribution_migration')
    OR t."source" IN ('legacy_money_attribution_migration','audit15_legacy_money_attribution_migration')
    OR COALESCE(t."result"->>'migratedFrom','') = 'MoneyAttribution'
    OR (t."result" ? 'legacyMigration')
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(t."history", '[]'::jsonb)) h(item)
      WHERE h.item->>'action' IN ('migrate_legacy_tip_to_team_tip_ledger','audit15_migrate_legacy_tip_to_team_tip_ledger')
    )
  );

-- If previous buggy AUTO reconciliation already destroyed both manual history
-- and legacyState, historical ownership is unknowable. Do not guess. Remove
-- chatter attribution, make the row conflict/manual-review, and use a manual_*
-- source so the automatic projector cannot silently overwrite the quarantine.
UPDATE "TeamTipLedger" t
SET
  "status" = 'conflict',
  "attributedMemberId" = NULL,
  "attributedUserId" = NULL,
  "attributedShiftKey" = NULL,
  "resolvedAt" = NULL,
  "resolvedByMemberId" = NULL,
  "resolvedSource" = 'manual_legacy_money_attribution_ambiguous_requires_review',
  "result" = COALESCE(t."result", '{}'::jsonb) || jsonb_build_object(
    'audit15Closure5ManualRepairScan', jsonb_build_object(
      'classified', true,
      'classification', 'ambiguous_legacy_authority_requires_review',
      'classifiedAt', CURRENT_TIMESTAMP,
      'requiresManualReview', true,
      'source', 'audit15_closure5_forward_migration'
    )
  ),
  "history" = COALESCE(t."history", '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
    'ts', (extract(epoch from CURRENT_TIMESTAMP) * 1000)::bigint,
    'action', 'audit15_closure5_quarantine_ambiguous_legacy_authority',
    'reason', 'Legacy migration evidence is insufficient to distinguish historical AUTO from MANUAL authority',
    'prevOwner', t."attributedMemberId",
    'nextOwner', NULL,
    'source', 'manual_legacy_money_attribution_ambiguous_requires_review'
  )),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE LEFT(COALESCE(t."resolvedSource", ''), 7) <> 'manual_'
  AND COALESCE(t."result"->'audit15Closure5ManualRepairScan'->>'classified', 'false') <> 'true'
  AND COALESCE(LOWER(t."result"->>'legacyState'), LOWER(t."result"->'legacyMigration'->>'legacyState'), '') <> 'auto'
  AND (
    t."resolvedSource" IN ('legacy_money_attribution_migration','audit15_legacy_money_attribution_migration')
    OR t."source" IN ('legacy_money_attribution_migration','audit15_legacy_money_attribution_migration')
    OR COALESCE(t."result"->>'migratedFrom','') = 'MoneyAttribution'
    OR (t."result" ? 'legacyMigration')
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(t."history", '[]'::jsonb)) h(item)
      WHERE h.item->>'action' IN ('migrate_legacy_tip_to_team_tip_ledger','audit15_migrate_legacy_tip_to_team_tip_ledger')
    )
  );

COMMIT;

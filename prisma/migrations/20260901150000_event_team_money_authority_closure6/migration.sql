BEGIN;

-- Audit15 Closure6: forward-only migration classification + review finalization.
--
-- One historical authority precedence is used by SQL and runtime:
--   1) MANUAL evidence in result/history;
--   2) legacy state fallback (claimed/manager/released);
--   3) proven AUTO (legacyState=auto or an earlier durable AUTO marker);
--   4) otherwise fail closed as an explicit migration-review conflict.
--
-- This migration touches TeamTipLedger only. It never depends on the deleted
-- MoneyAttribution row and does not mutate any older migration file.

CREATE TEMP TABLE "Audit15Closure6ManualEvidence" ON COMMIT DROP AS
WITH legacy_rows AS (
  SELECT t.*
  FROM "TeamTipLedger" t
  WHERE (
      t."resolvedSource" IN ('legacy_money_attribution_migration','audit15_legacy_money_attribution_migration')
      OR t."source" IN ('legacy_money_attribution_migration','audit15_legacy_money_attribution_migration')
      OR COALESCE(t."result"->>'migratedFrom','') = 'MoneyAttribution'
      OR (t."result" ? 'legacyMigration')
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(t."history", '[]'::jsonb)) h(item)
        WHERE h.item->>'action' IN ('migrate_legacy_tip_to_team_tip_ledger','audit15_migrate_legacy_tip_to_team_tip_ledger')
      )
    )
), manual_events AS (
  SELECT
    t."id" AS tip_id,
    mr.item->>'action' AS action,
    NULLIF(mr.item->>'memberId','') AS member_id,
    NULLIF(mr.item->>'resolvedByMemberId','') AS resolved_by_member_id,
    CASE WHEN COALESCE(mr.item->>'resolvedAt','') ~ '^\\d{4}-\\d{2}-\\d{2}T'
      THEN (mr.item->>'resolvedAt')::timestamptz ELSE NULL END AS resolved_at,
    4 AS source_rank,
    mr.ord
  FROM legacy_rows t
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(t."result"->'manualResolutions') = 'array'
      THEN t."result"->'manualResolutions' ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS mr(item, ord)
  WHERE mr.item->>'action' IN ('claim','release','manager_override')

  UNION ALL

  SELECT
    t."id",
    t."result"->'manualResolution'->>'action',
    NULLIF(t."result"->'manualResolution'->>'memberId',''),
    NULLIF(t."result"->'manualResolution'->>'resolvedByMemberId',''),
    CASE WHEN COALESCE(t."result"->'manualResolution'->>'resolvedAt','') ~ '^\\d{4}-\\d{2}-\\d{2}T'
      THEN (t."result"->'manualResolution'->>'resolvedAt')::timestamptz ELSE NULL END,
    5,
    1
  FROM legacy_rows t
  WHERE t."result"->'manualResolution'->>'action' IN ('claim','release','manager_override')

  UNION ALL

  SELECT
    t."id",
    mr.item->>'action',
    NULLIF(mr.item->>'memberId',''),
    NULLIF(mr.item->>'resolvedByMemberId',''),
    CASE WHEN COALESCE(mr.item->>'resolvedAt','') ~ '^\\d{4}-\\d{2}-\\d{2}T'
      THEN (mr.item->>'resolvedAt')::timestamptz ELSE NULL END,
    3,
    mr.ord
  FROM legacy_rows t
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(t."result"->'legacyMigration'->'manualResolutions') = 'array'
      THEN t."result"->'legacyMigration'->'manualResolutions' ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS mr(item, ord)
  WHERE mr.item->>'action' IN ('claim','release','manager_override')

  UNION ALL

  SELECT
    t."id",
    h.item->>'action',
    NULLIF(h.item->>'nextOwner',''),
    NULLIF(h.item->>'byMemberId',''),
    CASE WHEN COALESCE(h.item->>'ts','') ~ '^[0-9]+(\\.[0-9]+)?$'
      THEN to_timestamp((h.item->>'ts')::double precision / 1000.0) ELSE NULL END,
    2,
    h.ord
  FROM legacy_rows t
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(t."history", '[]'::jsonb))
    WITH ORDINALITY AS h(item, ord)
  WHERE h.item->>'action' IN ('claim','release','manager_override')
), ranked AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY tip_id
    ORDER BY resolved_at DESC NULLS LAST, source_rank DESC, ord DESC
  ) AS rn
  FROM manual_events
)
SELECT tip_id, action, member_id, resolved_by_member_id, resolved_at
FROM ranked
WHERE rn = 1;

-- 1) MANUAL result/history evidence always wins, even if stale legacyState says AUTO
-- or Closure5 previously classified the row as AUTO.
UPDATE "TeamTipLedger" t
SET
  "status" = CASE
    WHEN e.action = 'claim' AND e.member_id IS NOT NULL THEN 'claimed'
    WHEN e.action = 'claim' THEN 'unresolved'
    WHEN e.action = 'manager_override' AND e.member_id IS NOT NULL THEN 'resolved'
    WHEN e.action = 'manager_override' THEN 'creator_revenue'
    WHEN e.action = 'release' AND e.member_id IS NOT NULL THEN 'claimed'
    WHEN e.action = 'release' THEN 'released'
    ELSE t."status"
  END,
  "attributedMemberId" = e.member_id,
  "attributedUserId" = CASE WHEN e.member_id IS NULL THEN NULL ELSE (
    SELECT am."userId" FROM "AgencyMember" am
    WHERE am."agencyId" = t."agencyId" AND am."id" = e.member_id
    LIMIT 1
  ) END,
  "attributedShiftKey" = NULL,
  "resolvedAt" = COALESCE(e.resolved_at, t."resolvedAt", t."updatedAt", t."receivedAt"),
  "resolvedByMemberId" = e.resolved_by_member_id,
  "resolvedSource" = 'manual_legacy_money_attribution_closure6_' || e.action,
  "result" = COALESCE(t."result", '{}'::jsonb) || jsonb_build_object(
    'audit15Closure6MigrationAuthority', jsonb_build_object(
      'classified', true,
      'classification', 'legacy_manual_authority',
      'requiresManualReview', false,
      'classifiedAt', CURRENT_TIMESTAMP,
      'source', 'audit15_closure6_forward_migration'
    )
  ),
  "history" = COALESCE(t."history", '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
    'ts', (extract(epoch from CURRENT_TIMESTAMP) * 1000)::bigint,
    'action', 'audit15_closure6_classify_legacy_manual_authority',
    'classification', 'legacy_manual_authority',
    'prevOwner', t."attributedMemberId",
    'nextOwner', e.member_id,
    'source', 'audit15_closure6_forward_migration'
  )),
  "updatedAt" = CURRENT_TIMESTAMP
FROM "Audit15Closure6ManualEvidence" e
WHERE t."id" = e.tip_id
  AND (
    LEFT(COALESCE(t."resolvedSource", ''), 7) <> 'manual_'
    OR COALESCE(e.resolved_at, TIMESTAMP 'epoch') > COALESCE(t."resolvedAt", t."updatedAt", TIMESTAMP 'epoch')
    OR t."resolvedSource" = 'manual_legacy_money_attribution_ambiguous_requires_review'
  );

-- 2) State-only MANUAL fallback is used only when no richer manual evidence exists.
UPDATE "TeamTipLedger" t
SET
  "status" = CASE
    WHEN LOWER(COALESCE(t."result"->>'legacyState', t."result"->'legacyMigration'->>'legacyState', '')) = 'claimed'
      AND t."attributedMemberId" IS NOT NULL THEN 'claimed'
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
  "attributedUserId" = CASE WHEN t."attributedMemberId" IS NULL THEN NULL ELSE (
    SELECT am."userId" FROM "AgencyMember" am
    WHERE am."agencyId" = t."agencyId" AND am."id" = t."attributedMemberId"
    LIMIT 1
  ) END,
  "attributedShiftKey" = NULL,
  "resolvedAt" = COALESCE(t."resolvedAt", t."updatedAt", t."receivedAt"),
  "resolvedSource" = 'manual_legacy_money_attribution_closure6_state_' ||
    LOWER(COALESCE(t."result"->>'legacyState', t."result"->'legacyMigration'->>'legacyState', 'manual')),
  "result" = COALESCE(t."result", '{}'::jsonb) || jsonb_build_object(
    'audit15Closure6MigrationAuthority', jsonb_build_object(
      'classified', true,
      'classification', 'legacy_manual_state_fallback',
      'requiresManualReview', false,
      'classifiedAt', CURRENT_TIMESTAMP,
      'source', 'audit15_closure6_forward_migration'
    )
  ),
  "history" = COALESCE(t."history", '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
    'ts', (extract(epoch from CURRENT_TIMESTAMP) * 1000)::bigint,
    'action', 'audit15_closure6_classify_legacy_manual_state',
    'classification', 'legacy_manual_state_fallback',
    'prevOwner', t."attributedMemberId",
    'nextOwner', t."attributedMemberId",
    'source', 'audit15_closure6_forward_migration'
  )),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE LEFT(COALESCE(t."resolvedSource", ''), 7) <> 'manual_'
  AND NOT EXISTS (SELECT 1 FROM "Audit15Closure6ManualEvidence" e WHERE e.tip_id = t."id")
  AND (
    LOWER(COALESCE(t."result"->>'legacyState', t."result"->'legacyMigration'->>'legacyState', '')) IN ('manager','released')
    OR (
      LOWER(COALESCE(t."result"->>'legacyState', t."result"->'legacyMigration'->>'legacyState', '')) = 'claimed'
      AND t."attributedMemberId" IS NOT NULL
    )
  )
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

-- State-only manager/released with no owner is still manual (creator revenue / release).
UPDATE "TeamTipLedger" t
SET
  "status" = CASE
    WHEN LOWER(COALESCE(t."result"->>'legacyState', t."result"->'legacyMigration'->>'legacyState', '')) = 'manager' THEN 'creator_revenue'
    ELSE 'released'
  END,
  "attributedMemberId" = NULL,
  "attributedUserId" = NULL,
  "attributedShiftKey" = NULL,
  "resolvedAt" = COALESCE(t."resolvedAt", t."updatedAt", t."receivedAt"),
  "resolvedSource" = 'manual_legacy_money_attribution_closure6_state_' ||
    LOWER(COALESCE(t."result"->>'legacyState', t."result"->'legacyMigration'->>'legacyState', 'manual')),
  "result" = COALESCE(t."result", '{}'::jsonb) || jsonb_build_object(
    'audit15Closure6MigrationAuthority', jsonb_build_object(
      'classified', true, 'classification', 'legacy_manual_state_fallback',
      'requiresManualReview', false, 'classifiedAt', CURRENT_TIMESTAMP,
      'source', 'audit15_closure6_forward_migration'
    )
  ),
  "history" = COALESCE(t."history", '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
    'ts', (extract(epoch from CURRENT_TIMESTAMP) * 1000)::bigint,
    'action', 'audit15_closure6_classify_legacy_manual_state',
    'classification', 'legacy_manual_state_fallback',
    'prevOwner', t."attributedMemberId", 'nextOwner', NULL,
    'source', 'audit15_closure6_forward_migration'
  )),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE LEFT(COALESCE(t."resolvedSource", ''), 7) <> 'manual_'
  AND t."attributedMemberId" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "Audit15Closure6ManualEvidence" e WHERE e.tip_id = t."id")
  AND LOWER(COALESCE(t."result"->>'legacyState', t."result"->'legacyMigration'->>'legacyState', '')) IN ('manager','released')
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

-- 3) Proven AUTO only after both manual-evidence layers were ruled out.
UPDATE "TeamTipLedger" t
SET
  "result" = COALESCE(t."result", '{}'::jsonb) || jsonb_build_object(
    'audit15Closure6MigrationAuthority', jsonb_build_object(
      'classified', true, 'classification', 'proven_legacy_auto',
      'requiresManualReview', false, 'classifiedAt', CURRENT_TIMESTAMP,
      'source', 'audit15_closure6_forward_migration'
    )
  ),
  "history" = CASE
    WHEN EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(t."history", '[]'::jsonb)) h(item)
      WHERE h.item->>'action' = 'audit15_closure6_classify_legacy_auto_authority'
    ) THEN COALESCE(t."history", '[]'::jsonb)
    ELSE COALESCE(t."history", '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
      'ts', (extract(epoch from CURRENT_TIMESTAMP) * 1000)::bigint,
      'action', 'audit15_closure6_classify_legacy_auto_authority',
      'classification', 'proven_legacy_auto',
      'reason', 'Legacy authority was proven AUTO after MANUAL evidence precedence was exhausted',
      'source', 'audit15_closure6_forward_migration'
    ))
  END,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE LEFT(COALESCE(t."resolvedSource", ''), 7) <> 'manual_'
  AND NOT EXISTS (SELECT 1 FROM "Audit15Closure6ManualEvidence" e WHERE e.tip_id = t."id")
  AND LOWER(COALESCE(t."result"->>'legacyState', t."result"->'legacyMigration'->>'legacyState', '')) NOT IN ('claimed','manager','released')
  AND (
    LOWER(COALESCE(t."result"->>'legacyState', t."result"->'legacyMigration'->>'legacyState', '')) = 'auto'
    OR COALESCE(t."result"->'audit15Closure5ManualRepairScan'->>'classification','') = 'legacy_auto_no_manual_evidence'
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(t."history", '[]'::jsonb)) h(item)
      WHERE h.item->>'action' IN (
        'audit15_closure5_classify_legacy_auto_no_manual_evidence',
        'audit15_closure6_classify_legacy_auto_authority'
      )
    )
  )
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

-- 4) Remaining historical rows are truly ambiguous. Keep them frozen and
-- discoverable for the senior migration-review lane; never guess an owner.
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
    'audit15Closure6MigrationAuthority', jsonb_build_object(
      'classified', true, 'classification', 'ambiguous_legacy_authority_requires_review',
      'requiresManualReview', true, 'classifiedAt', CURRENT_TIMESTAMP,
      'source', 'audit15_closure6_forward_migration'
    )
  ),
  "history" = CASE
    WHEN EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(t."history", '[]'::jsonb)) h(item)
      WHERE h.item->>'action' = 'audit15_closure6_quarantine_ambiguous_legacy_authority'
    ) THEN COALESCE(t."history", '[]'::jsonb)
    ELSE COALESCE(t."history", '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
      'ts', (extract(epoch from CURRENT_TIMESTAMP) * 1000)::bigint,
      'action', 'audit15_closure6_quarantine_ambiguous_legacy_authority',
      'classification', 'ambiguous_legacy_authority_requires_review',
      'reason', 'Historical legacy authority is not provably MANUAL or AUTO and requires explicit senior review',
      'source', 'manual_legacy_money_attribution_ambiguous_requires_review'
    ))
  END,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE LEFT(COALESCE(t."resolvedSource", ''), 7) <> 'manual_'
  AND NOT EXISTS (SELECT 1 FROM "Audit15Closure6ManualEvidence" e WHERE e.tip_id = t."id")
  AND LOWER(COALESCE(t."result"->>'legacyState', t."result"->'legacyMigration'->>'legacyState', '')) NOT IN ('claimed','manager','released','auto')
  AND COALESCE(t."result"->'audit15Closure5ManualRepairScan'->>'classification','') <> 'legacy_auto_no_manual_evidence'
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(t."history", '[]'::jsonb)) h(item)
    WHERE h.item->>'action' IN (
      'audit15_closure5_classify_legacy_auto_no_manual_evidence',
      'audit15_closure6_classify_legacy_auto_authority'
    )
  )
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

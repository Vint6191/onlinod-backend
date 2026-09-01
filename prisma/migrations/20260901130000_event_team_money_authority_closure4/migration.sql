BEGIN;

-- Audit15 Closure4 forward repair.
--
-- Closure2 could already have migrated a legacy MoneyAttribution MANUAL
-- decision into TeamTipLedger with resolvedSource=legacy_money_attribution_migration
-- and then deleted the MoneyAttribution row. A later automatic CreatorTip
-- reconciliation could therefore erase that historical manual decision because
-- it only preserves durable manual_* sources.
--
-- Repair ONLY the canonical TeamTipLedger. This migration intentionally does
-- not read or lock MoneyAttribution, so it can overlap the runtime legacy
-- MoneyAttribution -> TeamTip migrator without creating a Money<->Team lock
-- cycle. UPDATE takes row locks only on TeamTipLedger candidates.
WITH migrated AS (
  SELECT
    t."id",
    t."agencyId",
    t."resolvedSource" AS current_resolved_source,
    t."resolvedAt" AS current_resolved_at,
    t."updatedAt" AS current_updated_at,
    evidence.action,
    evidence.member_id,
    evidence.resolved_by_member_id,
    evidence.resolved_at,
    am."userId" AS member_user_id
  FROM "TeamTipLedger" t
  JOIN LATERAL (
    SELECT e.action, e.member_id, e.resolved_by_member_id, e.resolved_at, e.source_rank, e.ord
    FROM (
      SELECT
        mr.item->>'action' AS action,
        NULLIF(mr.item->>'memberId','') AS member_id,
        NULLIF(mr.item->>'resolvedByMemberId','') AS resolved_by_member_id,
        CASE
          WHEN COALESCE(mr.item->>'resolvedAt','') ~ '^\d{4}-\d{2}-\d{2}T'
            THEN (mr.item->>'resolvedAt')::timestamptz
          ELSE NULL
        END AS resolved_at,
        2 AS source_rank,
        mr.ord
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(t."result"->'manualResolutions') = 'array'
            THEN t."result"->'manualResolutions'
          ELSE '[]'::jsonb
        END
      ) WITH ORDINALITY AS mr(item, ord)
      WHERE mr.item->>'action' IN ('claim','release','manager_override')

      UNION ALL

      SELECT
        h.item->>'action' AS action,
        NULLIF(h.item->>'nextOwner','') AS member_id,
        NULLIF(h.item->>'byMemberId','') AS resolved_by_member_id,
        CASE
          WHEN COALESCE(h.item->>'ts','') ~ '^[0-9]+(\.[0-9]+)?$'
            THEN to_timestamp((h.item->>'ts')::double precision / 1000.0)
          ELSE NULL
        END AS resolved_at,
        1 AS source_rank,
        h.ord
      FROM jsonb_array_elements(COALESCE(t."history", '[]'::jsonb))
        WITH ORDINALITY AS h(item, ord)
      WHERE h.item->>'action' IN ('claim','release','manager_override')
    ) e
    ORDER BY e.resolved_at DESC NULLS LAST, e.source_rank DESC, e.ord DESC
    LIMIT 1
  ) evidence ON TRUE
  LEFT JOIN "AgencyMember" am
    ON am."agencyId" = t."agencyId" AND am."id" = evidence.member_id
  WHERE (
      t."resolvedSource" IN ('legacy_money_attribution_migration','audit15_legacy_money_attribution_migration')
      OR t."source" IN ('legacy_money_attribution_migration','audit15_legacy_money_attribution_migration')
      OR COALESCE(t."result"->>'migratedFrom','') = 'MoneyAttribution'
      OR (t."result" ? 'legacyMigration')
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(t."history", '[]'::jsonb)) mh(item)
        WHERE mh.item->>'action' IN ('migrate_legacy_tip_to_team_tip_ledger','audit15_migrate_legacy_tip_to_team_tip_ledger')
      )
    )
), repair AS (
  SELECT *
  FROM migrated
  WHERE LEFT(COALESCE(current_resolved_source, ''), 7) <> 'manual_'
     OR COALESCE(resolved_at, TIMESTAMP 'epoch') > COALESCE(current_resolved_at, current_updated_at, TIMESTAMP 'epoch')
)
UPDATE "TeamTipLedger" t
SET
  "status" = CASE
    WHEN r.action = 'claim' AND r.member_id IS NOT NULL THEN 'claimed'
    WHEN r.action = 'claim' THEN 'unresolved'
    WHEN r.action = 'manager_override' AND r.member_id IS NOT NULL THEN 'resolved'
    WHEN r.action = 'manager_override' THEN 'creator_revenue'
    WHEN r.action = 'release' AND r.member_id IS NOT NULL THEN 'claimed'
    WHEN r.action = 'release' THEN 'released'
    ELSE t."status"
  END,
  "attributedMemberId" = r.member_id,
  "attributedUserId" = CASE WHEN r.member_id IS NOT NULL THEN r.member_user_id ELSE NULL END,
  "attributedShiftKey" = NULL,
  "resolvedAt" = COALESCE(r.resolved_at, t."updatedAt", t."receivedAt"),
  "resolvedByMemberId" = r.resolved_by_member_id,
  "resolvedSource" = 'manual_legacy_money_attribution_forward_repair_' || r.action,
  "result" = COALESCE(t."result", '{}'::jsonb) || jsonb_build_object(
    'audit15Closure4ManualRepair', jsonb_build_object(
      'repaired', true,
      'action', r.action,
      'memberId', r.member_id,
      'resolvedByMemberId', r.resolved_by_member_id,
      'resolvedAt', COALESCE(r.resolved_at, t."updatedAt", t."receivedAt"),
      'source', 'audit15_closure4_forward_repair'
    )
  ),
  "history" = COALESCE(t."history", '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
    'ts', (extract(epoch from CURRENT_TIMESTAMP) * 1000)::bigint,
    'action', 'audit15_closure4_repair_migrated_manual_authority',
    'reason', 'Recovered durable manual authority from canonical migrated history after legacy MoneyAttribution removal',
    'prevOwner', t."attributedMemberId",
    'nextOwner', r.member_id,
    'source', 'manual_legacy_money_attribution_forward_repair_' || r.action
  )),
  "updatedAt" = CURRENT_TIMESTAMP
FROM repair r
WHERE t."id" = r."id";

COMMIT;

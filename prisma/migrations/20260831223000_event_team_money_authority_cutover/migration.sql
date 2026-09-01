BEGIN;

-- Audit15: explicit projection-coverage authority. Zero projected rows after
-- this watermark mean authoritative zero, not "projector unavailable".
CREATE TABLE "TeamProjectionCoverage" (
    "agencyId" TEXT NOT NULL,
    "responseCoverageFrom" TIMESTAMP(3) NOT NULL,
    "dialogCoverageFrom" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'audit15_cutover',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TeamProjectionCoverage_pkey" PRIMARY KEY ("agencyId")
);

ALTER TABLE "TeamProjectionCoverage"
ADD CONSTRAINT "TeamProjectionCoverage_agencyId_fkey"
FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "TeamProjectionCoverage" ("agencyId", "responseCoverageFrom", "dialogCoverageFrom", "source")
SELECT "id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'audit15_cutover'
FROM "Agency"
ON CONFLICT ("agencyId") DO NOTHING;

-- Audit15 Closure3: deployment migration participates in the same legacy/manual
-- authority as the runtime migrator. Block legacy and canonical tip writers for
-- the short one-time cutover so an old rolling process cannot commit a newer
-- manual MoneyAttribution decision between snapshot and deletion.
LOCK TABLE "MoneyAttribution" IN SHARE ROW EXCLUSIVE MODE;

-- Do NOT table-lock TeamTipLedger here. The runtime legacy migrator takes its
-- MoneyAttribution row lock before touching TeamTipLedger. Holding only the
-- MoneyAttribution table lock therefore serializes old rolling writers before
-- this migration reaches TeamTip rows, while TeamTip ON CONFLICT uses ordinary
-- row-level locking and cannot form a Money<->Team table-lock cycle.

INSERT INTO "TeamTipLedger" (
    "id", "agencyId", "accountId", "creatorId", "eventHash", "tipId",
    "dialogId", "fanId", "amountCents", "currency", "receivedAt", "status",
    "attributedMemberId", "attributedUserId", "attributedShiftKey",
    "resolvedAt", "resolvedSource", "result", "history", "source", "createdAt", "updatedAt"
)
SELECT
    'legacy_' || md5(m."agencyId" || ':' || m."eventHash"),
    m."agencyId",
    COALESCE(NULLIF(m."accountId", ''), 'unknown'),
    m."creatorId",
    m."eventHash",
    m."eventHash",
    m."fanId",
    m."fanId",
    m."amountCents",
    COALESCE(NULLIF(m."currency", ''), 'USD'),
    m."occurredAt",
    CASE
      WHEN mh.item->>'action' = 'claim' AND NULLIF(mh.item->>'nextOwner','') IS NOT NULL THEN 'claimed'
      WHEN mh.item->>'action' = 'claim' THEN 'unresolved'
      WHEN mh.item->>'action' = 'manager_override' AND NULLIF(mh.item->>'nextOwner','') IS NOT NULL THEN 'resolved'
      WHEN mh.item->>'action' = 'manager_override' THEN 'creator_revenue'
      WHEN mh.item->>'action' = 'release' AND NULLIF(mh.item->>'nextOwner','') IS NOT NULL THEN 'claimed'
      WHEN mh.item->>'action' = 'release' THEN 'released'
      WHEN m."state" = 'auto' AND m."attributedToMemberId" IS NOT NULL THEN 'attributed'
      WHEN m."state" = 'claimed' AND m."attributedToMemberId" IS NOT NULL THEN 'claimed'
      WHEN m."state" = 'manager' AND m."attributedToMemberId" IS NOT NULL THEN 'resolved'
      WHEN m."state" = 'released' AND m."attributedToMemberId" IS NOT NULL THEN 'claimed'
      ELSE 'creator_revenue'
    END,
    CASE
      WHEN mh.item IS NOT NULL THEN NULLIF(mh.item->>'nextOwner','')
      WHEN m."state" IN ('auto','claimed','manager','released') THEN m."attributedToMemberId"
      ELSE NULL
    END,
    CASE
      WHEN mh.item IS NOT NULL
       AND NULLIF(mh.item->>'nextOwner','') IS DISTINCT FROM m."attributedToMemberId" THEN NULL
      WHEN m."state" IN ('auto','claimed','manager','released') THEN m."attributedToUserId"
      ELSE NULL
    END,
    NULL,
    CASE
      WHEN mh.item IS NOT NULL AND COALESCE(mh.item->>'ts','') ~ '^[0-9]+$'
        THEN to_timestamp((mh.item->>'ts')::double precision / 1000.0)
      WHEN mh.item IS NOT NULL OR m."state" IN ('claimed','manager','released')
        THEN COALESCE(m."lockedAt", m."updatedAt", m."occurredAt")
      WHEN m."attributedToMemberId" IS NOT NULL THEN COALESCE(m."lockedAt", m."updatedAt", m."occurredAt")
      ELSE NULL
    END,
    CASE
      WHEN mh.item IS NOT NULL THEN 'manual_legacy_money_attribution_' || COALESCE(NULLIF(mh.item->>'action',''), 'resolution')
      WHEN m."state" IN ('claimed','manager','released') THEN 'manual_legacy_money_attribution_' || m."state"
      ELSE 'legacy_money_attribution_migration'
    END,
    jsonb_build_object(
      'claimType','tip_attribution',
      'migratedFrom','MoneyAttribution',
      'legacyAttributionId',m."id",
      'legacyState',m."state",
      'legacyAutoReason',m."autoReason",
      'manualAuthority',(mh.item IS NOT NULL OR m."state" IN ('claimed','manager','released')),
      'migratedAt',CURRENT_TIMESTAMP
    ),
    COALESCE(m."history", '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
      'ts',(extract(epoch from CURRENT_TIMESTAMP) * 1000)::bigint,
      'action','audit15_migrate_legacy_tip_to_team_tip_ledger',
      'source','audit15_cutover',
      'legacyAttributionId',m."id"
    )),
    'audit15_legacy_money_attribution_migration',
    COALESCE(m."createdAt", m."capturedAt", m."occurredAt"),
    CURRENT_TIMESTAMP
FROM "MoneyAttribution" m
LEFT JOIN LATERAL (
  SELECT e.item
  FROM jsonb_array_elements(COALESCE(m."history", '[]'::jsonb)) WITH ORDINALITY AS e(item, ord)
  WHERE e.item->>'action' IN ('claim','release','manager_override')
  ORDER BY e.ord DESC
  LIMIT 1
) mh ON TRUE
WHERE m."eventType" = 'tip_received'
ON CONFLICT ("agencyId", "eventHash") DO UPDATE SET
    -- Incoming AUTO never replaces current canonical attribution. Incoming
    -- MANUAL always merges its durable history; ownership changes only when
    -- the canonical row is not manual or the legacy manual decision is newer.
    "status" = CASE
      WHEN LEFT(EXCLUDED."resolvedSource", 7) = 'manual_'
       AND (
         LEFT(COALESCE("TeamTipLedger"."resolvedSource", ''), 7) <> 'manual_'
         OR COALESCE(EXCLUDED."resolvedAt", TIMESTAMP 'epoch') > COALESCE("TeamTipLedger"."resolvedAt", "TeamTipLedger"."updatedAt", TIMESTAMP 'epoch')
       )
      THEN EXCLUDED."status" ELSE "TeamTipLedger"."status" END,
    "attributedMemberId" = CASE
      WHEN LEFT(EXCLUDED."resolvedSource", 7) = 'manual_'
       AND (
         LEFT(COALESCE("TeamTipLedger"."resolvedSource", ''), 7) <> 'manual_'
         OR COALESCE(EXCLUDED."resolvedAt", TIMESTAMP 'epoch') > COALESCE("TeamTipLedger"."resolvedAt", "TeamTipLedger"."updatedAt", TIMESTAMP 'epoch')
       )
      THEN EXCLUDED."attributedMemberId" ELSE "TeamTipLedger"."attributedMemberId" END,
    "attributedUserId" = CASE
      WHEN LEFT(EXCLUDED."resolvedSource", 7) = 'manual_'
       AND (
         LEFT(COALESCE("TeamTipLedger"."resolvedSource", ''), 7) <> 'manual_'
         OR COALESCE(EXCLUDED."resolvedAt", TIMESTAMP 'epoch') > COALESCE("TeamTipLedger"."resolvedAt", "TeamTipLedger"."updatedAt", TIMESTAMP 'epoch')
       )
      THEN EXCLUDED."attributedUserId" ELSE "TeamTipLedger"."attributedUserId" END,
    "attributedShiftKey" = CASE
      WHEN LEFT(EXCLUDED."resolvedSource", 7) = 'manual_'
       AND (
         LEFT(COALESCE("TeamTipLedger"."resolvedSource", ''), 7) <> 'manual_'
         OR COALESCE(EXCLUDED."resolvedAt", TIMESTAMP 'epoch') > COALESCE("TeamTipLedger"."resolvedAt", "TeamTipLedger"."updatedAt", TIMESTAMP 'epoch')
       )
      THEN NULL ELSE "TeamTipLedger"."attributedShiftKey" END,
    "resolvedAt" = CASE
      WHEN LEFT(EXCLUDED."resolvedSource", 7) = 'manual_'
       AND (
         LEFT(COALESCE("TeamTipLedger"."resolvedSource", ''), 7) <> 'manual_'
         OR COALESCE(EXCLUDED."resolvedAt", TIMESTAMP 'epoch') > COALESCE("TeamTipLedger"."resolvedAt", "TeamTipLedger"."updatedAt", TIMESTAMP 'epoch')
       )
      THEN EXCLUDED."resolvedAt" ELSE "TeamTipLedger"."resolvedAt" END,
    "resolvedSource" = CASE
      WHEN LEFT(EXCLUDED."resolvedSource", 7) = 'manual_'
       AND (
         LEFT(COALESCE("TeamTipLedger"."resolvedSource", ''), 7) <> 'manual_'
         OR COALESCE(EXCLUDED."resolvedAt", TIMESTAMP 'epoch') > COALESCE("TeamTipLedger"."resolvedAt", "TeamTipLedger"."updatedAt", TIMESTAMP 'epoch')
       )
      THEN EXCLUDED."resolvedSource" ELSE "TeamTipLedger"."resolvedSource" END,
    "result" = COALESCE("TeamTipLedger"."result", '{}'::jsonb) || jsonb_build_object('legacyMigration', EXCLUDED."result"),
    "history" = COALESCE("TeamTipLedger"."history", '[]'::jsonb) || COALESCE(EXCLUDED."history", '[]'::jsonb),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE LEFT(EXCLUDED."resolvedSource", 7) = 'manual_';

-- With both writer tables locked, the canonical identity now either contains
-- the legacy manual authority or already contains an equal/newer canonical
-- manual authority. Deletion cannot discard a concurrent rolling-process write.
DELETE FROM "MoneyAttribution" m
WHERE m."eventType" = 'tip_received'
  AND EXISTS (
    SELECT 1 FROM "TeamTipLedger" t
    WHERE t."agencyId" = m."agencyId" AND t."eventHash" = m."eventHash"
  );

COMMIT;

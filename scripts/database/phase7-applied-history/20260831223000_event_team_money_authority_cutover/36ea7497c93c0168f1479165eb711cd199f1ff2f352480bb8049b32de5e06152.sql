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


-- Migrate legacy tip attribution into the canonical TeamTipLedger. The unique
-- (agencyId,eventHash) key decides identity; an already-canonical row wins.
INSERT INTO "TeamTipLedger" (
    "id", "agencyId", "accountId", "creatorId", "eventHash", "tipId",
    "dialogId", "fanId", "amountCents", "currency", "receivedAt", "status",
    "attributedMemberId", "attributedUserId", "resolvedAt", "resolvedSource",
    "result", "history", "source", "createdAt", "updatedAt"
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
      WHEN m."state" = 'auto' AND m."attributedToMemberId" IS NOT NULL THEN 'attributed'
      WHEN m."state" = 'claimed' AND m."attributedToMemberId" IS NOT NULL THEN 'claimed'
      WHEN m."state" = 'manager' AND m."attributedToMemberId" IS NOT NULL THEN 'resolved'
      WHEN m."state" = 'released' AND m."attributedToMemberId" IS NOT NULL THEN 'claimed'
      ELSE 'creator_revenue'
    END,
    CASE WHEN m."state" IN ('auto','claimed','manager','released') THEN m."attributedToMemberId" ELSE NULL END,
    CASE WHEN m."state" IN ('auto','claimed','manager','released') THEN m."attributedToUserId" ELSE NULL END,
    CASE WHEN m."attributedToMemberId" IS NOT NULL THEN COALESCE(m."lockedAt", m."updatedAt", m."occurredAt") ELSE NULL END,
    'audit15_legacy_money_attribution_migration',
    jsonb_build_object(
      'claimType','tip_attribution',
      'migratedFrom','MoneyAttribution',
      'legacyAttributionId',m."id",
      'legacyState',m."state",
      'legacyAutoReason',m."autoReason",
      'migratedAt',CURRENT_TIMESTAMP
    ),
    COALESCE(m."history", '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
      'ts',(extract(epoch from CURRENT_TIMESTAMP) * 1000)::bigint,
      'action','audit15_migrate_legacy_tip_to_team_tip_ledger',
      'source','audit15_cutover'
    )),
    'audit15_legacy_money_attribution_migration',
    COALESCE(m."createdAt", m."capturedAt", m."occurredAt"),
    CURRENT_TIMESTAMP
FROM "MoneyAttribution" m
WHERE m."eventType" = 'tip_received'
ON CONFLICT ("agencyId", "eventHash") DO NOTHING;

-- Delete a legacy tip only after the same canonical identity is present. This
-- also removes duplicates where the canonical CreatorTip projector won first.
DELETE FROM "MoneyAttribution" m
WHERE m."eventType" = 'tip_received'
  AND EXISTS (
    SELECT 1 FROM "TeamTipLedger" t
    WHERE t."agencyId" = m."agencyId" AND t."eventHash" = m."eventHash"
  );

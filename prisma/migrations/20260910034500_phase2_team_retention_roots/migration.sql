-- Phase 2: stable Team money roots + idempotent activity contribution identity.
-- This is an additive/fail-closed retention cutover. It does not delete legacy proof.

ALTER TABLE "TeamActivityEvent"
  ADD COLUMN IF NOT EXISTS "semanticEventKey" TEXT;

CREATE INDEX IF NOT EXISTS "TeamActivityEvent_agency_event_semantic_idx"
  ON "TeamActivityEvent"("agencyId", "eventKind", "semanticEventKey");

ALTER TABLE "TeamHistoricalAnalyticsCoverage"
  ADD COLUMN IF NOT EXISTS "activityContributionVersion" TEXT NOT NULL DEFAULT 'team_activity_contribution_v2',
  ADD COLUMN IF NOT EXISTS "activityContributionCutoverAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "retentionVectorVersion" TEXT NOT NULL DEFAULT 'team_retention_vector_v2';

-- Existing agencies have a legacy aggregate baseline. Events older than this cutover
-- that no longer have an exact compact contribution identity are classified SEALED_LEGACY
-- rather than counted again as if they were new.
UPDATE "TeamHistoricalAnalyticsCoverage"
   SET "activityContributionCutoverAt" = COALESCE("activityContributionCutoverAt", CURRENT_TIMESTAMP),
       "activityContributionVersion" = 'team_activity_contribution_v2',
       "retentionVectorVersion" = 'team_retention_vector_v2',
       "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "TeamHistoricalAnalyticsCoverage"(
  "agencyId", "activityCoverageFrom", "moneyCoverageFrom",
  "activityProjectionVersion", "moneyProjectionVersion",
  "activityContributionVersion", "activityContributionCutoverAt", "retentionVectorVersion",
  "source", "backfilledAt", "createdAt", "updatedAt"
)
SELECT a."id", a."createdAt", a."createdAt",
       'team_activity_daily_v1', 'team_money_fact_v2',
       'team_activity_contribution_v2', CURRENT_TIMESTAMP, 'team_retention_vector_v2',
       'phase2_retention_roots_v2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM "Agency" a
 WHERE NOT EXISTS (
   SELECT 1 FROM "TeamHistoricalAnalyticsCoverage" c WHERE c."agencyId" = a."id"
 );


ALTER TABLE "TeamResponseCase"
  ADD COLUMN IF NOT EXISTS "projectionState" TEXT NOT NULL DEFAULT 'NEEDS_REPAIR',
  ADD COLUMN IF NOT EXISTS "repairReason" TEXT;
ALTER TABLE "TeamResponseCase" ALTER COLUMN "projectionState" SET DEFAULT 'FULL';
UPDATE "TeamResponseCase"
   SET "projectionState" = CASE WHEN "derivationVersion" = 'team_response_v2' THEN 'FULL' ELSE 'NEEDS_REPAIR' END,
       "repairReason" = CASE WHEN "derivationVersion" = 'team_response_v2' THEN NULL ELSE 'LEGACY_V1_REPAIR_REQUIRED' END;
CREATE INDEX IF NOT EXISTS "TeamResponseCase_agency_projection_state_reply_idx"
  ON "TeamResponseCase"("agencyId", "projectionState", "replyAt", "id");

CREATE TABLE IF NOT EXISTS "TeamActivityContribution" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "eventKind" TEXT NOT NULL,
  "semanticKey" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'APPLIED',
  "memberId" TEXT,
  "creatorKey" TEXT NOT NULL DEFAULT '__none__',
  "creatorId" TEXT,
  "day" TIMESTAMP(3) NOT NULL,
  "messagesSent" INTEGER NOT NULL DEFAULT 0,
  "ppvSentMessages" INTEGER NOT NULL DEFAULT 0,
  "broadcastDispatches" INTEGER NOT NULL DEFAULT 0,
  "postsCreated" INTEGER NOT NULL DEFAULT 0,
  "storiesCreated" INTEGER NOT NULL DEFAULT 0,
  "contentActions" INTEGER NOT NULL DEFAULT 0,
  "contentMediaItemsPublished" INTEGER NOT NULL DEFAULT 0,
  "sourceEventAt" TIMESTAMP(3) NOT NULL,
  "projectionVersion" TEXT NOT NULL DEFAULT 'team_activity_contribution_v2',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TeamActivityContribution_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TeamActivityContribution_agencyId_fkey"
    FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "TeamActivityContribution_agency_event_semantic_key"
  ON "TeamActivityContribution"("agencyId", "eventKind", "semanticKey");
CREATE INDEX IF NOT EXISTS "TeamActivityContribution_agency_member_day_idx"
  ON "TeamActivityContribution"("agencyId", "memberId", "day");
CREATE INDEX IF NOT EXISTS "TeamActivityContribution_agency_creator_day_idx"
  ON "TeamActivityContribution"("agencyId", "creatorId", "day");
CREATE INDEX IF NOT EXISTS "TeamActivityContribution_agency_state_event_idx"
  ON "TeamActivityContribution"("agencyId", "state", "sourceEventAt");

ALTER TABLE "TeamPpvPurchaseLedger"
  ADD COLUMN IF NOT EXISTS "rootVersion" TEXT NOT NULL DEFAULT 'team_money_root_v2',
  ADD COLUMN IF NOT EXISTS "compactedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "migrationBaselineProtected" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE "TeamTipLedger"
  ADD COLUMN IF NOT EXISTS "rootVersion" TEXT NOT NULL DEFAULT 'team_money_root_v2',
  ADD COLUMN IF NOT EXISTS "compactedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "migrationBaselineProtected" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE "TeamMoneyAttributionFact"
  ADD COLUMN IF NOT EXISTS "rootId" TEXT,
  ADD COLUMN IF NOT EXISTS "rootVersion" TEXT NOT NULL DEFAULT 'team_money_root_v2';

CREATE INDEX IF NOT EXISTS "TeamMoneyAttributionFact_agency_source_root_idx"
  ON "TeamMoneyAttributionFact"("agencyId", "sourceType", "rootId");

-- Historical root reconstruction is intentionally not performed as a global DDL scan.
-- Existing missing-root facts are recovered on demand and by bounded per-agency enumeration.
-- This keeps migration restartable and avoids a platform-wide history transaction.

-- v2 activity projection: the compact contribution identity is inserted first.
-- The daily aggregate changes only when that semantic contribution was newly admitted.
CREATE OR REPLACE FUNCTION onlinod_project_team_activity_contribution_v2()
RETURNS TRIGGER AS $$
DECLARE
  v_day TIMESTAMP(3);
  v_creator_key TEXT;
  v_messages INTEGER := 0;
  v_ppv_sent INTEGER := 0;
  v_broadcast INTEGER := 0;
  v_posts INTEGER := 0;
  v_stories INTEGER := 0;
  v_content INTEGER := 0;
  v_media INTEGER := 0;
  v_content_at TIMESTAMP(3) := NULL;
  v_contributes BOOLEAN := FALSE;
  v_semantic_key TEXT;
  v_cutover TIMESTAMP(3);
  v_inserted INTEGER := 0;
BEGIN
  IF NEW."source" <> 'electron_team_v13' OR NEW."eventKind" IS NULL OR NEW."memberId" IS NULL THEN
    RETURN NEW;
  END IF;

  v_day := date_trunc('day', NEW."ts");
  v_creator_key := COALESCE(NEW."creatorId", NEW."accountId", '__none__');
  v_semantic_key := NULLIF(NEW."semanticEventKey", '');
  -- Rolling-deploy compatibility: old binaries do not yet populate semanticEventKey.
  -- Derive the same stable business identity from canonical columns, never localId.
  IF v_semantic_key IS NULL THEN
    IF NEW."eventKind" = 'MESSAGE_SEND_CONFIRMED' AND NEW."messageId" IS NOT NULL THEN
      v_semantic_key := v_creator_key || ':message:' || NEW."messageId";
    ELSIF NEW."eventKind" = 'BROADCAST_DISPATCH_CONFIRMED' AND NEW."broadcastDispatchId" IS NOT NULL THEN
      v_semantic_key := v_creator_key || ':broadcast:' || NEW."broadcastDispatchId";
    ELSIF NEW."eventKind" IN ('CONTENT_POST_PUBLISHED_CONFIRMED','CONTENT_STORY_PUBLISHED_CONFIRMED') AND NEW."contentId" IS NOT NULL THEN
      v_semantic_key := v_creator_key || ':content:' || NEW."contentId";
    END IF;
  END IF;
  NEW."semanticEventKey" := v_semantic_key;

  IF NEW."eventKind" = 'MESSAGE_SEND_CONFIRMED' AND NEW."actionSource" = 'MANUAL' AND NEW."lifecycle" = 'CONFIRMED' THEN
    v_contributes := TRUE; v_messages := 1;
    IF NEW."isPpv" = TRUE OR COALESCE(NEW."priceCents", 0) > 0 THEN v_ppv_sent := 1; END IF;
  ELSIF NEW."eventKind" = 'BROADCAST_DISPATCH_CONFIRMED' AND NEW."lifecycle" = 'CONFIRMED' THEN
    v_contributes := TRUE; v_broadcast := 1;
  ELSIF NEW."eventKind" = 'CONTENT_POST_PUBLISHED_CONFIRMED' AND NEW."actionSource" = 'MANUAL' AND NEW."lifecycle" = 'CONFIRMED' THEN
    v_contributes := TRUE; v_posts := 1; v_content := 1;
    v_media := GREATEST(COALESCE(NEW."mediaCount", 0), 0); v_content_at := NEW."ts";
  ELSIF NEW."eventKind" = 'CONTENT_STORY_PUBLISHED_CONFIRMED' AND NEW."actionSource" = 'MANUAL' AND NEW."lifecycle" = 'CONFIRMED' THEN
    v_contributes := TRUE; v_stories := 1; v_content := 1;
    v_media := GREATEST(COALESCE(NEW."mediaCount", 0), 0); v_content_at := NEW."ts";
  END IF;

  IF NOT v_contributes THEN
    NEW."historicalProjectionVersion" := 'team_activity_zero_v2';
    NEW."historicalProjectedAt" := clock_timestamp();
    RETURN NEW;
  END IF;

  -- A contributing event without a stable semantic identity fails closed: keep raw
  -- evidence and do not create a new aggregate contribution from transport identity.
  IF v_semantic_key IS NULL THEN
    NEW."historicalProjectionVersion" := 'team_activity_unkeyed_v2';
    NEW."historicalProjectedAt" := NULL;
    RETURN NEW;
  END IF;

  SELECT c."activityContributionCutoverAt" INTO v_cutover
    FROM "TeamHistoricalAnalyticsCoverage" c
   WHERE c."agencyId" = NEW."agencyId";

  -- Coverage can be absent only for an agency created after this migration. New
  -- agencies have no sealed legacy daily baseline, so historical provider events are admissible.
  IF v_cutover IS NULL THEN
    INSERT INTO "TeamHistoricalAnalyticsCoverage"(
      "agencyId", "activityCoverageFrom", "moneyCoverageFrom",
      "activityProjectionVersion", "moneyProjectionVersion", "activityContributionVersion",
      "activityContributionCutoverAt", "retentionVectorVersion", "source", "backfilledAt", "createdAt", "updatedAt"
    ) VALUES (
      NEW."agencyId", NEW."ts", NEW."ts", 'team_activity_daily_v1', 'team_money_fact_v2',
      'team_activity_contribution_v2', TIMESTAMP '1970-01-01 00:00:00', 'team_retention_vector_v2',
      'phase2_retention_roots_v2_new_agency', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    ) ON CONFLICT ("agencyId") DO NOTHING;
    v_cutover := TIMESTAMP '1970-01-01 00:00:00';
  END IF;

  -- Existing pre-cutover history with no compact identity is ambiguous: daily v1 may
  -- already include it. Seal the key without adding another contribution.
  IF NEW."ts" < v_cutover THEN
    INSERT INTO "TeamActivityContribution"(
      "id","agencyId","eventKind","semanticKey","state","memberId","creatorKey","creatorId","day",
      "sourceEventAt","projectionVersion","createdAt","updatedAt"
    ) VALUES (
      'tac_' || md5(NEW."agencyId" || ':' || NEW."eventKind" || ':' || v_semantic_key),
      NEW."agencyId", NEW."eventKind", v_semantic_key, 'SEALED_LEGACY', NEW."memberId", v_creator_key,
      NEW."creatorId", v_day, NEW."ts", 'team_activity_contribution_v2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    ) ON CONFLICT ("agencyId","eventKind","semanticKey") DO NOTHING;
    NEW."historicalProjectionVersion" := 'team_activity_legacy_sealed_v2';
    NEW."historicalProjectedAt" := clock_timestamp();
    RETURN NEW;
  END IF;

  INSERT INTO "TeamActivityContribution"(
    "id","agencyId","eventKind","semanticKey","state","memberId","creatorKey","creatorId","day",
    "messagesSent","ppvSentMessages","broadcastDispatches","postsCreated","storiesCreated",
    "contentActions","contentMediaItemsPublished","sourceEventAt","projectionVersion","createdAt","updatedAt"
  ) VALUES (
    'tac_' || md5(NEW."agencyId" || ':' || NEW."eventKind" || ':' || v_semantic_key),
    NEW."agencyId", NEW."eventKind", v_semantic_key, 'APPLIED', NEW."memberId", v_creator_key, NEW."creatorId", v_day,
    v_messages, v_ppv_sent, v_broadcast, v_posts, v_stories, v_content, v_media, NEW."ts",
    'team_activity_contribution_v2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  ) ON CONFLICT ("agencyId","eventKind","semanticKey") DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 1 THEN
    INSERT INTO "TeamMemberActivityDaily" (
      "id", "agencyId", "memberId", "creatorKey", "creatorId", "day",
      "messagesSent", "ppvSentMessages", "broadcastDispatches", "postsCreated", "storiesCreated",
      "contentActions", "contentMediaItemsPublished", "sourceEventCount", "firstEventAt", "lastEventAt",
      "lastContentActivityAt", "projectionVersion", "createdAt", "updatedAt"
    ) VALUES (
      'tad_' || md5(NEW."agencyId" || ':' || NEW."memberId" || ':' || v_creator_key || ':' || v_day::text),
      NEW."agencyId", NEW."memberId", v_creator_key, NEW."creatorId", v_day,
      v_messages, v_ppv_sent, v_broadcast, v_posts, v_stories, v_content, v_media,
      1, NEW."ts", NEW."ts", v_content_at, 'team_activity_daily_v1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
    ON CONFLICT ("agencyId", "memberId", "creatorKey", "day") DO UPDATE SET
      "messagesSent" = "TeamMemberActivityDaily"."messagesSent" + EXCLUDED."messagesSent",
      "ppvSentMessages" = "TeamMemberActivityDaily"."ppvSentMessages" + EXCLUDED."ppvSentMessages",
      "broadcastDispatches" = "TeamMemberActivityDaily"."broadcastDispatches" + EXCLUDED."broadcastDispatches",
      "postsCreated" = "TeamMemberActivityDaily"."postsCreated" + EXCLUDED."postsCreated",
      "storiesCreated" = "TeamMemberActivityDaily"."storiesCreated" + EXCLUDED."storiesCreated",
      "contentActions" = "TeamMemberActivityDaily"."contentActions" + EXCLUDED."contentActions",
      "contentMediaItemsPublished" = "TeamMemberActivityDaily"."contentMediaItemsPublished" + EXCLUDED."contentMediaItemsPublished",
      "sourceEventCount" = "TeamMemberActivityDaily"."sourceEventCount" + 1,
      "firstEventAt" = LEAST("TeamMemberActivityDaily"."firstEventAt", EXCLUDED."firstEventAt"),
      "lastEventAt" = GREATEST("TeamMemberActivityDaily"."lastEventAt", EXCLUDED."lastEventAt"),
      "lastContentActivityAt" = CASE
        WHEN EXCLUDED."lastContentActivityAt" IS NULL THEN "TeamMemberActivityDaily"."lastContentActivityAt"
        WHEN "TeamMemberActivityDaily"."lastContentActivityAt" IS NULL THEN EXCLUDED."lastContentActivityAt"
        ELSE GREATEST("TeamMemberActivityDaily"."lastContentActivityAt", EXCLUDED."lastContentActivityAt")
      END,
      "updatedAt" = CURRENT_TIMESTAMP;
  END IF;

  NEW."historicalProjectionVersion" := 'team_activity_contribution_v2';
  NEW."historicalProjectedAt" := clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "TeamActivityEvent_project_historical_v1" ON "TeamActivityEvent";
DROP TRIGGER IF EXISTS "TeamActivityEvent_project_historical_v2" ON "TeamActivityEvent";
CREATE TRIGGER "TeamActivityEvent_project_historical_v2"
  BEFORE INSERT ON "TeamActivityEvent"
  FOR EACH ROW EXECUTE FUNCTION onlinod_project_team_activity_contribution_v2();

-- Money facts are projections of stable roots, not identities created by TTL detail rows.
CREATE OR REPLACE FUNCTION onlinod_project_team_ppv_fact_v2()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO "TeamMoneyAttributionFact" (
    "id", "agencyId", "sourceType", "sourceRowId", "externalId", "creatorId", "memberId", "userId",
    "fanId", "dialogId", "amountCents", "currency", "occurredAt", "businessStatus", "financialStatus",
    "attributionActive", "canonicalMoneyId", "creatorSaleId", "financialTransactionId", "creatorTipId",
    "attributionBasis", "sourceUpdatedAt", "rootId", "rootVersion", "projectionVersion", "createdAt", "updatedAt"
  ) VALUES (
    'ppv_' || md5(NEW."agencyId" || ':' || NEW."id"), NEW."agencyId", 'PPV', NEW."id", NEW."purchaseId", NEW."creatorId",
    NEW."attributedMemberId", NEW."attributedUserId", COALESCE(NEW."fanId", NEW."buyerFanId"), NEW."dialogId",
    GREATEST(COALESCE(NEW."amountCents", 0), 0), UPPER(COALESCE(NULLIF(NEW."currency", ''), 'USD')), NEW."purchasedAt",
    NEW."status", NEW."financialStatus",
    (NEW."status" IN ('attributed', 'resolved') AND NEW."attributedMemberId" IS NOT NULL AND COALESCE(lower(NEW."financialStatus"), '') <> 'undo'),
    COALESCE(NEW."financialTransactionId", NEW."creatorSaleId"), NEW."creatorSaleId", NEW."financialTransactionId", NULL,
    NEW."attributionBasis", COALESCE(NEW."updatedAt", CURRENT_TIMESTAMP), NEW."id", 'team_money_root_v2',
    'team_money_fact_v2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  )
  ON CONFLICT ("agencyId", "sourceType", "sourceRowId") DO UPDATE SET
    "externalId"=EXCLUDED."externalId", "creatorId"=EXCLUDED."creatorId", "memberId"=EXCLUDED."memberId",
    "userId"=EXCLUDED."userId", "fanId"=EXCLUDED."fanId", "dialogId"=EXCLUDED."dialogId",
    "amountCents"=EXCLUDED."amountCents", "currency"=EXCLUDED."currency", "occurredAt"=EXCLUDED."occurredAt",
    "businessStatus"=EXCLUDED."businessStatus", "financialStatus"=EXCLUDED."financialStatus",
    "attributionActive"=EXCLUDED."attributionActive", "canonicalMoneyId"=EXCLUDED."canonicalMoneyId",
    "creatorSaleId"=EXCLUDED."creatorSaleId", "financialTransactionId"=EXCLUDED."financialTransactionId",
    "creatorTipId"=EXCLUDED."creatorTipId", "attributionBasis"=EXCLUDED."attributionBasis",
    "sourceUpdatedAt"=EXCLUDED."sourceUpdatedAt", "rootId"=EXCLUDED."rootId", "rootVersion"='team_money_root_v2',
    "projectionVersion"='team_money_fact_v2', "updatedAt"=CURRENT_TIMESTAMP;
  NEW."historicalFactVersion" := 'team_money_fact_v2';
  NEW."historicalFactProjectedAt" := clock_timestamp();
  NEW."rootVersion" := 'team_money_root_v2';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION onlinod_project_team_tip_fact_v2()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO "TeamMoneyAttributionFact" (
    "id", "agencyId", "sourceType", "sourceRowId", "externalId", "creatorId", "memberId", "userId",
    "fanId", "dialogId", "amountCents", "currency", "occurredAt", "businessStatus", "financialStatus",
    "attributionActive", "canonicalMoneyId", "creatorSaleId", "financialTransactionId", "creatorTipId",
    "attributionBasis", "sourceUpdatedAt", "rootId", "rootVersion", "projectionVersion", "createdAt", "updatedAt"
  ) VALUES (
    'tip_' || md5(NEW."agencyId" || ':' || NEW."id"), NEW."agencyId", 'TIP', NEW."id", NEW."tipId", NEW."creatorId",
    NEW."attributedMemberId", NEW."attributedUserId", NEW."fanId", NEW."dialogId",
    GREATEST(COALESCE(NEW."amountCents", 0), 0), UPPER(COALESCE(NULLIF(NEW."currency", ''), 'USD')), NEW."receivedAt",
    NEW."status", NEW."financialStatus",
    (NEW."status" IN ('attributed', 'claimed', 'resolved') AND NEW."attributedMemberId" IS NOT NULL AND COALESCE(lower(NEW."financialStatus"), '') <> 'undo'),
    NEW."creatorTipId", NULL, NULL, NEW."creatorTipId", NEW."attributionBasis", COALESCE(NEW."updatedAt", CURRENT_TIMESTAMP),
    NEW."id", 'team_money_root_v2', 'team_money_fact_v2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  )
  ON CONFLICT ("agencyId", "sourceType", "sourceRowId") DO UPDATE SET
    "externalId"=EXCLUDED."externalId", "creatorId"=EXCLUDED."creatorId", "memberId"=EXCLUDED."memberId",
    "userId"=EXCLUDED."userId", "fanId"=EXCLUDED."fanId", "dialogId"=EXCLUDED."dialogId",
    "amountCents"=EXCLUDED."amountCents", "currency"=EXCLUDED."currency", "occurredAt"=EXCLUDED."occurredAt",
    "businessStatus"=EXCLUDED."businessStatus", "financialStatus"=EXCLUDED."financialStatus",
    "attributionActive"=EXCLUDED."attributionActive", "canonicalMoneyId"=EXCLUDED."canonicalMoneyId",
    "creatorSaleId"=EXCLUDED."creatorSaleId", "financialTransactionId"=EXCLUDED."financialTransactionId",
    "creatorTipId"=EXCLUDED."creatorTipId", "attributionBasis"=EXCLUDED."attributionBasis",
    "sourceUpdatedAt"=EXCLUDED."sourceUpdatedAt", "rootId"=EXCLUDED."rootId", "rootVersion"='team_money_root_v2',
    "projectionVersion"='team_money_fact_v2', "updatedAt"=CURRENT_TIMESTAMP;
  NEW."historicalFactVersion" := 'team_money_fact_v2';
  NEW."historicalFactProjectedAt" := clock_timestamp();
  NEW."rootVersion" := 'team_money_root_v2';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "TeamPpvPurchaseLedger_project_historical_v1" ON "TeamPpvPurchaseLedger";
DROP TRIGGER IF EXISTS "TeamPpvPurchaseLedger_project_historical_v2" ON "TeamPpvPurchaseLedger";
CREATE TRIGGER "TeamPpvPurchaseLedger_project_historical_v2"
  BEFORE INSERT OR UPDATE ON "TeamPpvPurchaseLedger"
  FOR EACH ROW EXECUTE FUNCTION onlinod_project_team_ppv_fact_v2();

DROP TRIGGER IF EXISTS "TeamTipLedger_project_historical_v1" ON "TeamTipLedger";
DROP TRIGGER IF EXISTS "TeamTipLedger_project_historical_v2" ON "TeamTipLedger";
CREATE TRIGGER "TeamTipLedger_project_historical_v2"
  BEFORE INSERT OR UPDATE ON "TeamTipLedger"
  FOR EACH ROW EXECUTE FUNCTION onlinod_project_team_tip_fact_v2();

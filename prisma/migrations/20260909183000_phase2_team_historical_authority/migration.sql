-- Phase 2: Team Historical Analytics / Retention Authority.
-- Long-range product history must not depend on retaining every raw Team event
-- or every mutable claims ledger row forever.

ALTER TABLE "TeamActivityEvent"
  ADD COLUMN IF NOT EXISTS "historicalProjectionVersion" TEXT,
  ADD COLUMN IF NOT EXISTS "historicalProjectedAt" TIMESTAMP(3);

ALTER TABLE "TeamPpvPurchaseLedger"
  ADD COLUMN IF NOT EXISTS "historicalFactVersion" TEXT,
  ADD COLUMN IF NOT EXISTS "historicalFactProjectedAt" TIMESTAMP(3);

ALTER TABLE "TeamTipLedger"
  ADD COLUMN IF NOT EXISTS "historicalFactVersion" TEXT,
  ADD COLUMN IF NOT EXISTS "historicalFactProjectedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "TeamActivityEvent_agencyId_historicalProjectionVersion_ts_idx"
  ON "TeamActivityEvent"("agencyId", "historicalProjectionVersion", "ts");

CREATE TABLE IF NOT EXISTS "TeamHistoricalAnalyticsCoverage" (
  "agencyId" TEXT NOT NULL,
  "activityCoverageFrom" TIMESTAMP(3) NOT NULL,
  "moneyCoverageFrom" TIMESTAMP(3) NOT NULL,
  "activityProjectionVersion" TEXT NOT NULL DEFAULT 'team_activity_daily_v1',
  "moneyProjectionVersion" TEXT NOT NULL DEFAULT 'team_money_fact_v1',
  "source" TEXT NOT NULL DEFAULT 'phase2_historical_authority',
  "backfilledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TeamHistoricalAnalyticsCoverage_pkey" PRIMARY KEY ("agencyId"),
  CONSTRAINT "TeamHistoricalAnalyticsCoverage_agencyId_fkey"
    FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "TeamMemberActivityDaily" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
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
  "sourceEventCount" INTEGER NOT NULL DEFAULT 0,
  "firstEventAt" TIMESTAMP(3),
  "lastEventAt" TIMESTAMP(3),
  "lastContentActivityAt" TIMESTAMP(3),
  "projectionVersion" TEXT NOT NULL DEFAULT 'team_activity_daily_v1',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TeamMemberActivityDaily_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TeamMemberActivityDaily_agencyId_fkey"
    FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "TeamMemberActivityDaily_agency_member_creator_day_key"
  ON "TeamMemberActivityDaily"("agencyId", "memberId", "creatorKey", "day");
CREATE INDEX IF NOT EXISTS "TeamMemberActivityDaily_agency_member_day_idx"
  ON "TeamMemberActivityDaily"("agencyId", "memberId", "day");
CREATE INDEX IF NOT EXISTS "TeamMemberActivityDaily_agency_creator_day_idx"
  ON "TeamMemberActivityDaily"("agencyId", "creatorId", "day");
CREATE INDEX IF NOT EXISTS "TeamMemberActivityDaily_agency_day_idx"
  ON "TeamMemberActivityDaily"("agencyId", "day");

CREATE TABLE IF NOT EXISTS "TeamMoneyAttributionFact" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceRowId" TEXT NOT NULL,
  "externalId" TEXT,
  "creatorId" TEXT,
  "memberId" TEXT,
  "userId" TEXT,
  "fanId" TEXT,
  "dialogId" TEXT,
  "amountCents" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "businessStatus" TEXT NOT NULL,
  "financialStatus" TEXT,
  "attributionActive" BOOLEAN NOT NULL DEFAULT FALSE,
  "canonicalMoneyId" TEXT,
  "creatorSaleId" TEXT,
  "financialTransactionId" TEXT,
  "creatorTipId" TEXT,
  "attributionBasis" TEXT,
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "projectionVersion" TEXT NOT NULL DEFAULT 'team_money_fact_v1',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TeamMoneyAttributionFact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TeamMoneyAttributionFact_agencyId_fkey"
    FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TeamMoneyAttributionFact_sourceType_check" CHECK ("sourceType" IN ('PPV', 'TIP'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "TeamMoneyAttributionFact_agency_source_row_key"
  ON "TeamMoneyAttributionFact"("agencyId", "sourceType", "sourceRowId");
CREATE INDEX IF NOT EXISTS "TeamMoneyAttributionFact_agency_source_member_occurred_idx"
  ON "TeamMoneyAttributionFact"("agencyId", "sourceType", "memberId", "occurredAt");
CREATE INDEX IF NOT EXISTS "TeamMoneyAttributionFact_agency_creator_occurred_idx"
  ON "TeamMoneyAttributionFact"("agencyId", "creatorId", "occurredAt");
CREATE INDEX IF NOT EXISTS "TeamMoneyAttributionFact_agency_active_occurred_idx"
  ON "TeamMoneyAttributionFact"("agencyId", "attributionActive", "occurredAt");
CREATE INDEX IF NOT EXISTS "TeamMoneyAttributionFact_agency_member_dialog_occurred_idx"
  ON "TeamMoneyAttributionFact"("agencyId", "memberId", "dialogId", "occurredAt");
CREATE INDEX IF NOT EXISTS "TeamMoneyAttributionFact_canonicalMoneyId_idx"
  ON "TeamMoneyAttributionFact"("canonicalMoneyId");
CREATE INDEX IF NOT EXISTS "TeamMoneyAttributionFact_creatorSaleId_idx"
  ON "TeamMoneyAttributionFact"("creatorSaleId");
CREATE INDEX IF NOT EXISTS "TeamMoneyAttributionFact_financialTransactionId_idx"
  ON "TeamMoneyAttributionFact"("financialTransactionId");
CREATE INDEX IF NOT EXISTS "TeamMoneyAttributionFact_creatorTipId_idx"
  ON "TeamMoneyAttributionFact"("creatorTipId");

-- Install projection triggers before historical backfill. Any write arriving during the backfill
-- is projected by the trigger and carries proof, so the backfill can safely process only unprojected rows.
CREATE OR REPLACE FUNCTION onlinod_project_team_activity_daily_v1()
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
BEGIN
  IF NEW."source" <> 'electron_team_v13' OR NEW."eventKind" IS NULL OR NEW."memberId" IS NULL THEN
    RETURN NEW;
  END IF;

  v_day := date_trunc('day', NEW."ts");
  v_creator_key := COALESCE(NEW."creatorId", NEW."accountId", '__none__');

  IF NEW."eventKind" = 'MESSAGE_SEND_CONFIRMED' AND NEW."actionSource" = 'MANUAL' AND NEW."lifecycle" = 'CONFIRMED' THEN
    v_contributes := TRUE;
    v_messages := 1;
    IF NEW."isPpv" = TRUE OR COALESCE(NEW."priceCents", 0) > 0 THEN v_ppv_sent := 1; END IF;
  END IF;
  IF NEW."eventKind" = 'BROADCAST_DISPATCH_CONFIRMED' AND NEW."lifecycle" = 'CONFIRMED' THEN
    v_contributes := TRUE;
    v_broadcast := 1;
  END IF;
  IF NEW."eventKind" = 'CONTENT_POST_PUBLISHED_CONFIRMED' AND NEW."actionSource" = 'MANUAL' AND NEW."lifecycle" = 'CONFIRMED' THEN
    v_contributes := TRUE;
    v_posts := 1; v_content := 1; v_media := GREATEST(COALESCE(NEW."mediaCount", 0), 0); v_content_at := NEW."ts";
  END IF;
  IF NEW."eventKind" = 'CONTENT_STORY_PUBLISHED_CONFIRMED' AND NEW."actionSource" = 'MANUAL' AND NEW."lifecycle" = 'CONFIRMED' THEN
    v_contributes := TRUE;
    v_stories := 1; v_content := 1; v_media := GREATEST(COALESCE(NEW."mediaCount", 0), 0); v_content_at := NEW."ts";
  END IF;

  -- High-volume incoming/seen/coverage telemetry contributes zero to this compact
  -- activity family. Mark the zero contribution as projected without hammering a
  -- shared member/creator/day row on every inbound event.
  IF NOT v_contributes THEN
    NEW."historicalProjectionVersion" := 'team_activity_daily_v1';
    NEW."historicalProjectedAt" := clock_timestamp();
    RETURN NEW;
  END IF;

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

  NEW."historicalProjectionVersion" := 'team_activity_daily_v1';
  NEW."historicalProjectedAt" := clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'TeamActivityEvent_project_historical_v1'
      AND tgrelid = '"TeamActivityEvent"'::regclass
      AND NOT tgisinternal
  ) THEN
    EXECUTE 'CREATE TRIGGER "TeamActivityEvent_project_historical_v1" BEFORE INSERT ON "TeamActivityEvent" FOR EACH ROW EXECUTE FUNCTION onlinod_project_team_activity_daily_v1()';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION onlinod_project_team_ppv_fact_v1()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO "TeamMoneyAttributionFact" (
    "id", "agencyId", "sourceType", "sourceRowId", "externalId", "creatorId", "memberId", "userId",
    "fanId", "dialogId", "amountCents", "currency", "occurredAt", "businessStatus", "financialStatus",
    "attributionActive", "canonicalMoneyId", "creatorSaleId", "financialTransactionId", "creatorTipId",
    "attributionBasis", "sourceUpdatedAt", "projectionVersion",
    "createdAt", "updatedAt"
  ) VALUES (
    'ppv_' || md5(NEW."agencyId" || ':' || NEW."id"), NEW."agencyId", 'PPV', NEW."id", NEW."purchaseId", NEW."creatorId",
    NEW."attributedMemberId", NEW."attributedUserId", COALESCE(NEW."fanId", NEW."buyerFanId"), NEW."dialogId",
    GREATEST(COALESCE(NEW."amountCents", 0), 0), UPPER(COALESCE(NULLIF(NEW."currency", ''), 'USD')), NEW."purchasedAt",
    NEW."status", NEW."financialStatus",
    (NEW."status" IN ('attributed', 'resolved') AND NEW."attributedMemberId" IS NOT NULL AND COALESCE(lower(NEW."financialStatus"), '') <> 'undo'),
    COALESCE(NEW."financialTransactionId", NEW."creatorSaleId"), NEW."creatorSaleId", NEW."financialTransactionId", NULL,
    NEW."attributionBasis", COALESCE(NEW."updatedAt", CURRENT_TIMESTAMP),
    'team_money_fact_v1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  )
  ON CONFLICT ("agencyId", "sourceType", "sourceRowId") DO UPDATE SET
    "externalId" = EXCLUDED."externalId", "creatorId" = EXCLUDED."creatorId", "memberId" = EXCLUDED."memberId",
    "userId" = EXCLUDED."userId", "fanId" = EXCLUDED."fanId", "dialogId" = EXCLUDED."dialogId",
    "amountCents" = EXCLUDED."amountCents", "currency" = EXCLUDED."currency", "occurredAt" = EXCLUDED."occurredAt",
    "businessStatus" = EXCLUDED."businessStatus", "financialStatus" = EXCLUDED."financialStatus",
    "attributionActive" = EXCLUDED."attributionActive", "canonicalMoneyId" = EXCLUDED."canonicalMoneyId",
    "creatorSaleId" = EXCLUDED."creatorSaleId", "financialTransactionId" = EXCLUDED."financialTransactionId",
    "creatorTipId" = EXCLUDED."creatorTipId", "attributionBasis" = EXCLUDED."attributionBasis",
    "sourceUpdatedAt" = EXCLUDED."sourceUpdatedAt",
    "projectionVersion" = 'team_money_fact_v1', "updatedAt" = CURRENT_TIMESTAMP;
  NEW."historicalFactVersion" := 'team_money_fact_v1';
  NEW."historicalFactProjectedAt" := clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'TeamPpvPurchaseLedger_project_historical_v1'
      AND tgrelid = '"TeamPpvPurchaseLedger"'::regclass
      AND NOT tgisinternal
  ) THEN
    EXECUTE 'CREATE TRIGGER "TeamPpvPurchaseLedger_project_historical_v1" BEFORE INSERT OR UPDATE ON "TeamPpvPurchaseLedger" FOR EACH ROW EXECUTE FUNCTION onlinod_project_team_ppv_fact_v1()';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION onlinod_project_team_tip_fact_v1()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO "TeamMoneyAttributionFact" (
    "id", "agencyId", "sourceType", "sourceRowId", "externalId", "creatorId", "memberId", "userId",
    "fanId", "dialogId", "amountCents", "currency", "occurredAt", "businessStatus", "financialStatus",
    "attributionActive", "canonicalMoneyId", "creatorSaleId", "financialTransactionId", "creatorTipId",
    "attributionBasis", "sourceUpdatedAt", "projectionVersion",
    "createdAt", "updatedAt"
  ) VALUES (
    'tip_' || md5(NEW."agencyId" || ':' || NEW."id"), NEW."agencyId", 'TIP', NEW."id", NEW."tipId", NEW."creatorId",
    NEW."attributedMemberId", NEW."attributedUserId", NEW."fanId", NEW."dialogId",
    GREATEST(COALESCE(NEW."amountCents", 0), 0), UPPER(COALESCE(NULLIF(NEW."currency", ''), 'USD')), NEW."receivedAt",
    NEW."status", NEW."financialStatus",
    (NEW."status" IN ('attributed', 'claimed', 'resolved') AND NEW."attributedMemberId" IS NOT NULL AND COALESCE(lower(NEW."financialStatus"), '') <> 'undo'),
    NEW."creatorTipId", NULL, NULL, NEW."creatorTipId", NEW."attributionBasis", COALESCE(NEW."updatedAt", CURRENT_TIMESTAMP),
    'team_money_fact_v1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  )
  ON CONFLICT ("agencyId", "sourceType", "sourceRowId") DO UPDATE SET
    "externalId" = EXCLUDED."externalId", "creatorId" = EXCLUDED."creatorId", "memberId" = EXCLUDED."memberId",
    "userId" = EXCLUDED."userId", "fanId" = EXCLUDED."fanId", "dialogId" = EXCLUDED."dialogId",
    "amountCents" = EXCLUDED."amountCents", "currency" = EXCLUDED."currency", "occurredAt" = EXCLUDED."occurredAt",
    "businessStatus" = EXCLUDED."businessStatus", "financialStatus" = EXCLUDED."financialStatus",
    "attributionActive" = EXCLUDED."attributionActive", "canonicalMoneyId" = EXCLUDED."canonicalMoneyId",
    "creatorSaleId" = EXCLUDED."creatorSaleId", "financialTransactionId" = EXCLUDED."financialTransactionId",
    "creatorTipId" = EXCLUDED."creatorTipId", "attributionBasis" = EXCLUDED."attributionBasis",
    "sourceUpdatedAt" = EXCLUDED."sourceUpdatedAt",
    "projectionVersion" = 'team_money_fact_v1', "updatedAt" = CURRENT_TIMESTAMP;
  NEW."historicalFactVersion" := 'team_money_fact_v1';
  NEW."historicalFactProjectedAt" := clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'TeamTipLedger_project_historical_v1'
      AND tgrelid = '"TeamTipLedger"'::regclass
      AND NOT tgisinternal
  ) THEN
    EXECUTE 'CREATE TRIGGER "TeamTipLedger_project_historical_v1" BEFORE INSERT OR UPDATE ON "TeamTipLedger" FOR EACH ROW EXECUTE FUNCTION onlinod_project_team_tip_fact_v1()';
  END IF;
END;
$$;

-- Canonical money rows can be corrected after the mutable Team ledger detail has
-- already expired. Keep durable Team facts synchronized with later payout/refund
-- truth instead of freezing a stale financialStatus forever.
CREATE OR REPLACE FUNCTION onlinod_refresh_team_fact_from_creator_sale_v1()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE "TeamMoneyAttributionFact" f
  SET "amountCents" = GREATEST(COALESCE(NEW."amountCents", 0), 0),
      "currency" = UPPER(COALESCE(NULLIF(NEW."currency", ''), 'USD')),
      "occurredAt" = NEW."purchasedAt",
      "financialStatus" = CASE WHEN f."financialTransactionId" IS NULL THEN NEW."transactionStatus" ELSE f."financialStatus" END,
      "attributionActive" = (
        f."businessStatus" IN ('attributed', 'resolved')
        AND f."memberId" IS NOT NULL
        AND COALESCE(lower(CASE WHEN f."financialTransactionId" IS NULL THEN NEW."transactionStatus" ELSE f."financialStatus" END), '') <> 'undo'
      ),
      "sourceUpdatedAt" = COALESCE(NEW."sourceUpdatedAt", NEW."updatedAt", CURRENT_TIMESTAMP),
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE f."sourceType" = 'PPV' AND f."creatorSaleId" = NEW."id";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'CreatorSale_refresh_team_fact_v1'
      AND tgrelid = '"CreatorSale"'::regclass
      AND NOT tgisinternal
  ) THEN
    EXECUTE 'CREATE TRIGGER "CreatorSale_refresh_team_fact_v1" AFTER INSERT OR UPDATE OF "amountCents", "currency", "purchasedAt", "transactionStatus", "sourceUpdatedAt" ON "CreatorSale" FOR EACH ROW EXECUTE FUNCTION onlinod_refresh_team_fact_from_creator_sale_v1()';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION onlinod_refresh_team_fact_from_financial_tx_v1()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE "TeamMoneyAttributionFact" f
  SET "financialStatus" = NEW."transactionStatus",
      "attributionActive" = (
        f."businessStatus" IN ('attributed', 'resolved')
        AND f."memberId" IS NOT NULL
        AND COALESCE(lower(NEW."transactionStatus"), '') <> 'undo'
      ),
      "sourceUpdatedAt" = COALESCE(NEW."sourceUpdatedAt", NEW."updatedAt", CURRENT_TIMESTAMP),
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE f."sourceType" = 'PPV' AND f."financialTransactionId" = NEW."id";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'CreatorFinancialTransaction_refresh_team_fact_v1'
      AND tgrelid = '"CreatorFinancialTransaction"'::regclass
      AND NOT tgisinternal
  ) THEN
    EXECUTE 'CREATE TRIGGER "CreatorFinancialTransaction_refresh_team_fact_v1" AFTER INSERT OR UPDATE OF "transactionStatus", "sourceUpdatedAt" ON "CreatorFinancialTransaction" FOR EACH ROW EXECUTE FUNCTION onlinod_refresh_team_fact_from_financial_tx_v1()';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION onlinod_refresh_team_fact_from_creator_tip_v1()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE "TeamMoneyAttributionFact" f
  SET "amountCents" = GREATEST(COALESCE(NEW."amountCents", 0), 0),
      "currency" = UPPER(COALESCE(NULLIF(NEW."currency", ''), 'USD')),
      "occurredAt" = NEW."tippedAt",
      "financialStatus" = NEW."transactionStatus",
      "attributionActive" = (
        f."businessStatus" IN ('attributed', 'claimed', 'resolved')
        AND f."memberId" IS NOT NULL
        AND COALESCE(lower(NEW."transactionStatus"), '') <> 'undo'
      ),
      "sourceUpdatedAt" = COALESCE(NEW."sourceUpdatedAt", NEW."updatedAt", CURRENT_TIMESTAMP),
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE f."sourceType" = 'TIP' AND f."creatorTipId" = NEW."id";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'CreatorTip_refresh_team_fact_v1'
      AND tgrelid = '"CreatorTip"'::regclass
      AND NOT tgisinternal
  ) THEN
    EXECUTE 'CREATE TRIGGER "CreatorTip_refresh_team_fact_v1" AFTER INSERT OR UPDATE OF "amountCents", "currency", "tippedAt", "transactionStatus", "sourceUpdatedAt" ON "CreatorTip" FOR EACH ROW EXECUTE FUNCTION onlinod_refresh_team_fact_from_creator_tip_v1()';
  END IF;
END;
$$;

-- Backfill + proof is one retry-atomic unit. If a deploy is interrupted,
-- the aggregate increment and raw-row proof roll back together; rerunning cannot double-count history.
BEGIN;

-- Backfill compact activity from the complete retained canonical Team-v13 event stream.
INSERT INTO "TeamMemberActivityDaily" (
  "id", "agencyId", "memberId", "creatorKey", "creatorId", "day",
  "messagesSent", "ppvSentMessages", "broadcastDispatches",
  "postsCreated", "storiesCreated", "contentActions", "contentMediaItemsPublished",
  "sourceEventCount", "firstEventAt", "lastEventAt", "lastContentActivityAt",
  "projectionVersion", "createdAt", "updatedAt"
)
SELECT
  'tad_' || md5(e."agencyId" || ':' || e."memberId" || ':' || COALESCE(e."creatorId", e."accountId", '__none__') || ':' || date_trunc('day', e."ts")::text),
  e."agencyId",
  e."memberId",
  COALESCE(e."creatorId", e."accountId", '__none__'),
  e."creatorId",
  date_trunc('day', e."ts"),
  COUNT(*) FILTER (
    WHERE e."eventKind" = 'MESSAGE_SEND_CONFIRMED'
      AND e."actionSource" = 'MANUAL'
      AND e."lifecycle" = 'CONFIRMED'
  )::INTEGER,
  COUNT(*) FILTER (
    WHERE e."eventKind" = 'MESSAGE_SEND_CONFIRMED'
      AND e."actionSource" = 'MANUAL'
      AND e."lifecycle" = 'CONFIRMED'
      AND (e."isPpv" = TRUE OR COALESCE(e."priceCents", 0) > 0)
  )::INTEGER,
  COUNT(*) FILTER (
    WHERE e."eventKind" = 'BROADCAST_DISPATCH_CONFIRMED'
      AND e."lifecycle" = 'CONFIRMED'
  )::INTEGER,
  COUNT(*) FILTER (
    WHERE e."eventKind" = 'CONTENT_POST_PUBLISHED_CONFIRMED'
      AND e."actionSource" = 'MANUAL'
      AND e."lifecycle" = 'CONFIRMED'
  )::INTEGER,
  COUNT(*) FILTER (
    WHERE e."eventKind" = 'CONTENT_STORY_PUBLISHED_CONFIRMED'
      AND e."actionSource" = 'MANUAL'
      AND e."lifecycle" = 'CONFIRMED'
  )::INTEGER,
  COUNT(*) FILTER (
    WHERE e."eventKind" IN ('CONTENT_POST_PUBLISHED_CONFIRMED', 'CONTENT_STORY_PUBLISHED_CONFIRMED')
      AND e."actionSource" = 'MANUAL'
      AND e."lifecycle" = 'CONFIRMED'
  )::INTEGER,
  COALESCE(SUM(
    CASE WHEN e."eventKind" IN ('CONTENT_POST_PUBLISHED_CONFIRMED', 'CONTENT_STORY_PUBLISHED_CONFIRMED')
      AND e."actionSource" = 'MANUAL'
      AND e."lifecycle" = 'CONFIRMED'
      THEN GREATEST(COALESCE(e."mediaCount", 0), 0) ELSE 0 END
  ), 0)::INTEGER,
  COUNT(*)::INTEGER,
  MIN(e."ts"),
  MAX(e."ts"),
  MAX(e."ts") FILTER (
    WHERE e."eventKind" IN ('CONTENT_POST_PUBLISHED_CONFIRMED', 'CONTENT_STORY_PUBLISHED_CONFIRMED')
      AND e."actionSource" = 'MANUAL'
      AND e."lifecycle" = 'CONFIRMED'
  ),
  'team_activity_daily_v1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "TeamActivityEvent" e
WHERE e."source" = 'electron_team_v13'
  AND e."eventKind" IS NOT NULL
  AND e."memberId" IS NOT NULL
  AND e."historicalProjectionVersion" IS NULL
  AND (
    (e."eventKind" = 'MESSAGE_SEND_CONFIRMED' AND e."actionSource" = 'MANUAL' AND e."lifecycle" = 'CONFIRMED')
    OR (e."eventKind" = 'BROADCAST_DISPATCH_CONFIRMED' AND e."lifecycle" = 'CONFIRMED')
    OR (e."eventKind" = 'CONTENT_POST_PUBLISHED_CONFIRMED' AND e."actionSource" = 'MANUAL' AND e."lifecycle" = 'CONFIRMED')
    OR (e."eventKind" = 'CONTENT_STORY_PUBLISHED_CONFIRMED' AND e."actionSource" = 'MANUAL' AND e."lifecycle" = 'CONFIRMED')
  )
GROUP BY e."agencyId", e."memberId", COALESCE(e."creatorId", e."accountId", '__none__'), e."creatorId", date_trunc('day', e."ts")
ON CONFLICT ("agencyId", "memberId", "creatorKey", "day") DO UPDATE SET
  "messagesSent" = "TeamMemberActivityDaily"."messagesSent" + EXCLUDED."messagesSent",
  "ppvSentMessages" = "TeamMemberActivityDaily"."ppvSentMessages" + EXCLUDED."ppvSentMessages",
  "broadcastDispatches" = "TeamMemberActivityDaily"."broadcastDispatches" + EXCLUDED."broadcastDispatches",
  "postsCreated" = "TeamMemberActivityDaily"."postsCreated" + EXCLUDED."postsCreated",
  "storiesCreated" = "TeamMemberActivityDaily"."storiesCreated" + EXCLUDED."storiesCreated",
  "contentActions" = "TeamMemberActivityDaily"."contentActions" + EXCLUDED."contentActions",
  "contentMediaItemsPublished" = "TeamMemberActivityDaily"."contentMediaItemsPublished" + EXCLUDED."contentMediaItemsPublished",
  "sourceEventCount" = "TeamMemberActivityDaily"."sourceEventCount" + EXCLUDED."sourceEventCount",
  "firstEventAt" = CASE
    WHEN "TeamMemberActivityDaily"."firstEventAt" IS NULL THEN EXCLUDED."firstEventAt"
    WHEN EXCLUDED."firstEventAt" IS NULL THEN "TeamMemberActivityDaily"."firstEventAt"
    ELSE LEAST("TeamMemberActivityDaily"."firstEventAt", EXCLUDED."firstEventAt")
  END,
  "lastEventAt" = CASE
    WHEN "TeamMemberActivityDaily"."lastEventAt" IS NULL THEN EXCLUDED."lastEventAt"
    WHEN EXCLUDED."lastEventAt" IS NULL THEN "TeamMemberActivityDaily"."lastEventAt"
    ELSE GREATEST("TeamMemberActivityDaily"."lastEventAt", EXCLUDED."lastEventAt")
  END,
  "lastContentActivityAt" = CASE
    WHEN EXCLUDED."lastContentActivityAt" IS NULL THEN "TeamMemberActivityDaily"."lastContentActivityAt"
    WHEN "TeamMemberActivityDaily"."lastContentActivityAt" IS NULL THEN EXCLUDED."lastContentActivityAt"
    ELSE GREATEST("TeamMemberActivityDaily"."lastContentActivityAt", EXCLUDED."lastContentActivityAt")
  END,
  "projectionVersion" = 'team_activity_daily_v1',
  "updatedAt" = CURRENT_TIMESTAMP;

UPDATE "TeamActivityEvent"
SET "historicalProjectionVersion" = 'team_activity_daily_v1',
    "historicalProjectedAt" = CURRENT_TIMESTAMP
WHERE "source" = 'electron_team_v13'
  AND "eventKind" IS NOT NULL
  AND "memberId" IS NOT NULL
  AND "historicalProjectionVersion" IS NULL;

COMMIT;

-- Durable money fact backfill + proof is also atomic, so no raw row can be
-- advertised as projected by a partially completed money backfill.
BEGIN;

-- Durable money fact backfill. These facts remain after mutable/detail claim rows expire.
INSERT INTO "TeamMoneyAttributionFact" (
  "id", "agencyId", "sourceType", "sourceRowId", "externalId", "creatorId",
  "memberId", "userId", "fanId", "dialogId", "amountCents", "currency", "occurredAt",
  "businessStatus", "financialStatus", "attributionActive", "canonicalMoneyId",
  "creatorSaleId", "financialTransactionId", "creatorTipId",
  "attributionBasis", "sourceUpdatedAt", "projectionVersion", "createdAt", "updatedAt"
)
SELECT
  'ppv_' || md5(p."agencyId" || ':' || p."id"), p."agencyId", 'PPV', p."id", p."purchaseId", p."creatorId",
  p."attributedMemberId", p."attributedUserId", COALESCE(p."fanId", p."buyerFanId"), p."dialogId",
  GREATEST(COALESCE(p."amountCents", 0), 0), UPPER(COALESCE(NULLIF(p."currency", ''), 'USD')), p."purchasedAt",
  p."status", p."financialStatus",
  (p."status" IN ('attributed', 'resolved') AND p."attributedMemberId" IS NOT NULL AND COALESCE(lower(p."financialStatus"), '') <> 'undo'),
  COALESCE(p."financialTransactionId", p."creatorSaleId"), p."creatorSaleId", p."financialTransactionId", NULL,
  p."attributionBasis", p."updatedAt", 'team_money_fact_v1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "TeamPpvPurchaseLedger" p
WHERE p."historicalFactVersion" IS NULL
ON CONFLICT ("agencyId", "sourceType", "sourceRowId") DO UPDATE SET
  "externalId" = EXCLUDED."externalId", "creatorId" = EXCLUDED."creatorId", "memberId" = EXCLUDED."memberId",
  "userId" = EXCLUDED."userId", "fanId" = EXCLUDED."fanId", "dialogId" = EXCLUDED."dialogId",
  "amountCents" = EXCLUDED."amountCents", "currency" = EXCLUDED."currency", "occurredAt" = EXCLUDED."occurredAt",
  "businessStatus" = EXCLUDED."businessStatus", "financialStatus" = EXCLUDED."financialStatus",
  "attributionActive" = EXCLUDED."attributionActive", "canonicalMoneyId" = EXCLUDED."canonicalMoneyId",
  "creatorSaleId" = EXCLUDED."creatorSaleId", "financialTransactionId" = EXCLUDED."financialTransactionId",
  "creatorTipId" = EXCLUDED."creatorTipId", "attributionBasis" = EXCLUDED."attributionBasis",
  "sourceUpdatedAt" = EXCLUDED."sourceUpdatedAt", "projectionVersion" = 'team_money_fact_v1',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "TeamMoneyAttributionFact"."sourceUpdatedAt" <= EXCLUDED."sourceUpdatedAt";

INSERT INTO "TeamMoneyAttributionFact" (
  "id", "agencyId", "sourceType", "sourceRowId", "externalId", "creatorId",
  "memberId", "userId", "fanId", "dialogId", "amountCents", "currency", "occurredAt",
  "businessStatus", "financialStatus", "attributionActive", "canonicalMoneyId",
  "creatorSaleId", "financialTransactionId", "creatorTipId",
  "attributionBasis", "sourceUpdatedAt", "projectionVersion", "createdAt", "updatedAt"
)
SELECT
  'tip_' || md5(t."agencyId" || ':' || t."id"), t."agencyId", 'TIP', t."id", t."tipId", t."creatorId",
  t."attributedMemberId", t."attributedUserId", t."fanId", t."dialogId",
  GREATEST(COALESCE(t."amountCents", 0), 0), UPPER(COALESCE(NULLIF(t."currency", ''), 'USD')), t."receivedAt",
  t."status", t."financialStatus",
  (t."status" IN ('attributed', 'claimed', 'resolved') AND t."attributedMemberId" IS NOT NULL AND COALESCE(lower(t."financialStatus"), '') <> 'undo'),
  t."creatorTipId", NULL, NULL, t."creatorTipId", t."attributionBasis", t."updatedAt",
  'team_money_fact_v1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "TeamTipLedger" t
WHERE t."historicalFactVersion" IS NULL
ON CONFLICT ("agencyId", "sourceType", "sourceRowId") DO UPDATE SET
  "externalId" = EXCLUDED."externalId", "creatorId" = EXCLUDED."creatorId", "memberId" = EXCLUDED."memberId",
  "userId" = EXCLUDED."userId", "fanId" = EXCLUDED."fanId", "dialogId" = EXCLUDED."dialogId",
  "amountCents" = EXCLUDED."amountCents", "currency" = EXCLUDED."currency", "occurredAt" = EXCLUDED."occurredAt",
  "businessStatus" = EXCLUDED."businessStatus", "financialStatus" = EXCLUDED."financialStatus",
  "attributionActive" = EXCLUDED."attributionActive", "canonicalMoneyId" = EXCLUDED."canonicalMoneyId",
  "creatorSaleId" = EXCLUDED."creatorSaleId", "financialTransactionId" = EXCLUDED."financialTransactionId",
  "creatorTipId" = EXCLUDED."creatorTipId", "attributionBasis" = EXCLUDED."attributionBasis",
  "sourceUpdatedAt" = EXCLUDED."sourceUpdatedAt", "projectionVersion" = 'team_money_fact_v1',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "TeamMoneyAttributionFact"."sourceUpdatedAt" <= EXCLUDED."sourceUpdatedAt";

UPDATE "TeamPpvPurchaseLedger"
SET "historicalFactVersion" = 'team_money_fact_v1',
    "historicalFactProjectedAt" = CURRENT_TIMESTAMP
WHERE "historicalFactVersion" IS NULL;
UPDATE "TeamTipLedger"
SET "historicalFactVersion" = 'team_money_fact_v1',
    "historicalFactProjectedAt" = CURRENT_TIMESTAMP
WHERE "historicalFactVersion" IS NULL;

COMMIT;

-- Existing agencies: canonical Team-v13 became authoritative at the provenance cutover.
-- Money is guaranteed complete only across the raw-ledger retention horizon; any older
-- backfilled facts remain usable but are not silently advertised as FULL coverage.
INSERT INTO "TeamHistoricalAnalyticsCoverage" (
  "agencyId", "activityCoverageFrom", "moneyCoverageFrom", "source", "backfilledAt", "createdAt", "updatedAt"
)
SELECT
  a."id",
  GREATEST(a."createdAt", TIMESTAMP '2026-08-11 23:40:00'),
  GREATEST(a."createdAt", CURRENT_TIMESTAMP - INTERVAL '180 days'),
  'phase2_historical_authority_backfill', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Agency" a
ON CONFLICT ("agencyId") DO NOTHING;


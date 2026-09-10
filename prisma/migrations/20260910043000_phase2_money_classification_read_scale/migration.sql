
-- R15: preserve the compact sent-message authority root across detail retention.
ALTER TABLE "TeamSentMessageLedger"
  ADD COLUMN IF NOT EXISTS "compactedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "rootVersion" TEXT NOT NULL DEFAULT 'team_sent_root_v2';

CREATE INDEX IF NOT EXISTS "TeamSentMessageLedger_retention_compact_idx"
  ON "TeamSentMessageLedger" ("sentAt", "id")
  WHERE "compactedAt" IS NULL;

-- Phase 2 INT5: money-root classification + bounded read/retention indexes.
-- Existing facts start PENDING and are classified by bounded per-agency work. New root
-- projections emitted after this migration stamp CANONICAL from their stable root identity.

ALTER TABLE "TeamMoneyAttributionFact"
  ADD COLUMN IF NOT EXISTS "canonicalBusinessKey" TEXT,
  ADD COLUMN IF NOT EXISTS "classificationState" TEXT NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS "classificationReason" TEXT,
  ADD COLUMN IF NOT EXISTS "classificationVersion" TEXT NOT NULL DEFAULT 'team_money_root_classification_v1';

CREATE INDEX IF NOT EXISTS "TeamMoneyAttributionFact_classification_read_idx"
  ON "TeamMoneyAttributionFact"("agencyId","classificationState","sourceType","occurredAt");
CREATE INDEX IF NOT EXISTS "TeamMoneyAttributionFact_business_key_idx"
  ON "TeamMoneyAttributionFact"("agencyId","sourceType","canonicalBusinessKey");

-- Reinstall stable-root projection functions so every new/live root carries an explicit,
-- verified business key and is immediately read-eligible. Historical rows remain PENDING
-- until the bounded classifier proves their identity.
CREATE OR REPLACE FUNCTION onlinod_project_team_ppv_fact_v2()
RETURNS TRIGGER AS $$
DECLARE
  business_key TEXT;
BEGIN
  business_key := CASE
    WHEN NEW."creatorSaleId" IS NOT NULL THEN 'sale:' || NEW."creatorSaleId"
    WHEN NEW."financialTransactionId" IS NOT NULL THEN 'financial:' || NEW."financialTransactionId"
    ELSE NULL
  END;
  INSERT INTO "TeamMoneyAttributionFact" (
    "id", "agencyId", "sourceType", "sourceRowId", "externalId", "creatorId", "memberId", "userId",
    "fanId", "dialogId", "amountCents", "currency", "occurredAt", "businessStatus", "financialStatus",
    "attributionActive", "canonicalMoneyId", "creatorSaleId", "financialTransactionId", "creatorTipId",
    "attributionBasis", "sourceUpdatedAt", "rootId", "rootVersion", "canonicalBusinessKey",
    "classificationState", "classificationReason", "classificationVersion", "projectionVersion", "createdAt", "updatedAt"
  ) VALUES (
    'ppv_' || md5(NEW."agencyId" || ':' || NEW."id"), NEW."agencyId", 'PPV', NEW."id", NEW."purchaseId", NEW."creatorId",
    NEW."attributedMemberId", NEW."attributedUserId", COALESCE(NEW."fanId", NEW."buyerFanId"), NEW."dialogId",
    GREATEST(COALESCE(NEW."amountCents", 0), 0), UPPER(COALESCE(NULLIF(NEW."currency", ''), 'USD')), NEW."purchasedAt",
    NEW."status", NEW."financialStatus",
    (NEW."status" IN ('attributed', 'resolved') AND NEW."attributedMemberId" IS NOT NULL AND COALESCE(lower(NEW."financialStatus"), '') <> 'undo'),
    COALESCE(NEW."financialTransactionId", NEW."creatorSaleId"), NEW."creatorSaleId", NEW."financialTransactionId", NULL,
    NEW."attributionBasis", COALESCE(NEW."updatedAt", CURRENT_TIMESTAMP), NEW."id", 'team_money_root_v2', business_key,
    CASE WHEN business_key IS NULL THEN 'INCOMPLETE' ELSE 'CANONICAL' END,
    CASE WHEN business_key IS NULL THEN 'LIVE_ROOT_CANONICAL_BUSINESS_KEY_MISSING' ELSE NULL END,
    'team_money_root_classification_v1', 'team_money_fact_v2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
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
    "canonicalBusinessKey"=EXCLUDED."canonicalBusinessKey", "classificationState"=EXCLUDED."classificationState",
    "classificationReason"=EXCLUDED."classificationReason", "classificationVersion"='team_money_root_classification_v1',
    "projectionVersion"='team_money_fact_v2', "updatedAt"=CURRENT_TIMESTAMP;
  NEW."historicalFactVersion" := 'team_money_fact_v2';
  NEW."historicalFactProjectedAt" := clock_timestamp();
  NEW."rootVersion" := 'team_money_root_v2';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION onlinod_project_team_tip_fact_v2()
RETURNS TRIGGER AS $$
DECLARE
  business_key TEXT;
BEGIN
  business_key := CASE WHEN NEW."creatorTipId" IS NOT NULL THEN 'tip:' || NEW."creatorTipId" ELSE NULL END;
  INSERT INTO "TeamMoneyAttributionFact" (
    "id", "agencyId", "sourceType", "sourceRowId", "externalId", "creatorId", "memberId", "userId",
    "fanId", "dialogId", "amountCents", "currency", "occurredAt", "businessStatus", "financialStatus",
    "attributionActive", "canonicalMoneyId", "creatorSaleId", "financialTransactionId", "creatorTipId",
    "attributionBasis", "sourceUpdatedAt", "rootId", "rootVersion", "canonicalBusinessKey",
    "classificationState", "classificationReason", "classificationVersion", "projectionVersion", "createdAt", "updatedAt"
  ) VALUES (
    'tip_' || md5(NEW."agencyId" || ':' || NEW."id"), NEW."agencyId", 'TIP', NEW."id", NEW."tipId", NEW."creatorId",
    NEW."attributedMemberId", NEW."attributedUserId", NEW."fanId", NEW."dialogId",
    GREATEST(COALESCE(NEW."amountCents", 0), 0), UPPER(COALESCE(NULLIF(NEW."currency", ''), 'USD')), NEW."receivedAt",
    NEW."status", NEW."financialStatus",
    (NEW."status" IN ('attributed', 'claimed', 'resolved') AND NEW."attributedMemberId" IS NOT NULL AND COALESCE(lower(NEW."financialStatus"), '') <> 'undo'),
    NEW."creatorTipId", NULL, NULL, NEW."creatorTipId", NEW."attributionBasis", COALESCE(NEW."updatedAt", CURRENT_TIMESTAMP),
    NEW."id", 'team_money_root_v2', business_key,
    CASE WHEN business_key IS NULL THEN 'INCOMPLETE' ELSE 'CANONICAL' END,
    CASE WHEN business_key IS NULL THEN 'LIVE_ROOT_CANONICAL_BUSINESS_KEY_MISSING' ELSE NULL END,
    'team_money_root_classification_v1', 'team_money_fact_v2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
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
    "canonicalBusinessKey"=EXCLUDED."canonicalBusinessKey", "classificationState"=EXCLUDED."classificationState",
    "classificationReason"=EXCLUDED."classificationReason", "classificationVersion"='team_money_root_classification_v1',
    "projectionVersion"='team_money_fact_v2', "updatedAt"=CURRENT_TIMESTAMP;
  NEW."historicalFactVersion" := 'team_money_fact_v2';
  NEW."historicalFactProjectedAt" := clock_timestamp();
  NEW."rootVersion" := 'team_money_root_v2';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Queue/read indexes used by bounded transitional R9 reads.
CREATE INDEX IF NOT EXISTS "CCS_review_bounded_scan_idx"
  ON "CustomContentSubmission"("agencyId","pipelineDisposition","reviewStatus","receivedAt","createdAt","id");
CREATE INDEX IF NOT EXISTS "CCS_overdue_bounded_scan_idx"
  ON "CustomContentSubmission"("agencyId","reviewStatus","reviewedAt","id")
  WHERE "customOrderId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "CustomOrder_reminder_bounded_scan_idx"
  ON "CustomOrder"("agencyId","status","nextReminderAt","id")
  WHERE "status"='PENDING' AND "nextReminderAt" IS NOT NULL;


-- Extend new-agency activation for every historical family introduced by later Phase 2
-- generations. A just-created agency has no pre-cutover rows to enumerate.
CREATE OR REPLACE FUNCTION "phase2_new_agency_coverage_trigger"()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO "Phase2WorkCoverage"(
    "id","agencyId","family","generation","active","enumerationState",
    "unresolvedCount","sourceWatermark","activatedAt","completedAt","createdAt","updatedAt"
  ) VALUES
    ('p2cov_' || md5(NEW."id" || E'\\x1f' || 'PROVIDER_OPERATIONAL' || E'\\x1f' || 'phase2_provider_operational_coverage_v1'),
      NEW."id",'PROVIDER_OPERATIONAL','phase2_provider_operational_coverage_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\\x1f' || 'CUSTOM_EXTERNAL_PROJECTION' || E'\\x1f' || 'phase2_custom_external_coverage_v1'),
      NEW."id",'CUSTOM_EXTERNAL_PROJECTION','phase2_custom_external_coverage_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\\x1f' || 'TEAM_ACTIVITY_CONTRIBUTION' || E'\\x1f' || 'phase2_team_activity_contribution_v2'),
      NEW."id",'TEAM_ACTIVITY_CONTRIBUTION','phase2_team_activity_contribution_v2',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\\x1f' || 'TEAM_RESPONSE_RANGE_REPAIR' || E'\\x1f' || 'phase2_team_response_range_v2'),
      NEW."id",'TEAM_RESPONSE_RANGE_REPAIR','phase2_team_response_range_v2',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\\x1f' || 'TEAM_MONEY_ROOT_CLASSIFICATION' || E'\\x1f' || 'phase2_team_money_root_classification_v1'),
      NEW."id",'TEAM_MONEY_ROOT_CLASSIFICATION','phase2_team_money_root_classification_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
  ON CONFLICT ("agencyId","family","generation") DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

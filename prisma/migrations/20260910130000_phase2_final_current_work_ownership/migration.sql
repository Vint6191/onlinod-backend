-- Phase 2 final current-work ownership convergence.
-- ProviderOperationalDebt remains capability/retention projection; executable current
-- repair is DomainWorkItem-owned and keyed by exact canonical objects.

CREATE OR REPLACE FUNCTION "phase2_refresh_custom_external_projection_debt"()
RETURNS TRIGGER AS $$
DECLARE
  v_submission_id TEXT;
  v_order_id TEXT;
  v_account_id TEXT;
  v_media_id TEXT;
  v_message_id TEXT;
  v_projected BOOLEAN := FALSE;
  v_has_media BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."actionType" IN ('CUSTOM_RELAY_SEND','CUSTOM_MANUAL_SEND') THEN
      DELETE FROM "ProviderOperationalDebt" WHERE "id"=('pod_external_' || OLD."id");
    END IF;
    RETURN OLD;
  END IF;

  -- Ordinary AutomationDelivery transitions must not pay for a Custom debt-table lookup.
  -- If a row transitioned away from a Custom kind, deterministic PK cleanup is sufficient;
  -- any already-published DomainWork will revalidate the canonical delivery and ACK obsolete.
  IF NEW."actionType" NOT IN ('CUSTOM_RELAY_SEND','CUSTOM_MANUAL_SEND') THEN
    IF TG_OP='UPDATE' AND OLD."actionType" IN ('CUSTOM_RELAY_SEND','CUSTOM_MANUAL_SEND') THEN
      DELETE FROM "ProviderOperationalDebt" WHERE "id"=('pod_external_' || NEW."id");
    END IF;
    RETURN NEW;
  END IF;

  DELETE FROM "ProviderOperationalDebt" WHERE "id"=('pod_external_' || NEW."id");
  IF NEW."status" <> 'COMPLETED' THEN RETURN NEW; END IF;

  IF NEW."actionType" = 'CUSTOM_RELAY_SEND' THEN
    v_submission_id := COALESCE(NULLIF(NEW."payload"->>'submissionId',''), split_part(COALESCE(NEW."targetId",''), ':', 1));
    v_media_id := NULLIF(NEW."result"->>'mediaId','');
    IF v_submission_id IS NULL OR v_submission_id = '' OR v_media_id IS NULL THEN RETURN NEW; END IF;

    SELECT COALESCE(NULLIF(NEW."payload"->>'telegramSourceAccountId',''), NULLIF(submission."telegramSourceAccountId",'')),
           (v_media_id = ANY(submission."ofMediaIds"))
      INTO v_account_id, v_projected
      FROM "CustomContentSubmission" submission
     WHERE submission."agencyId"=NEW."agencyId" AND submission."id"=v_submission_id
     LIMIT 1;
    IF v_account_id IS NULL OR COALESCE(v_projected,FALSE) THEN RETURN NEW; END IF;

    INSERT INTO "ProviderOperationalDebt"(
      "id","agencyId","accountId","creatorId","debtClass","objectType","objectId",
      "customOrderId","customSubmissionId","intentId","reason","sourceVersion","createdAt","updatedAt"
    ) VALUES (
      'pod_external_' || NEW."id", NEW."agencyId", v_account_id, NEW."creatorId",
      'CUSTOM_EXTERNAL_PROJECTION_DEBT','AutomationDelivery',NEW."id",
      NULLIF(NEW."payload"->>'customOrderId',''),v_submission_id,NULL,'CUSTOM_RELAY_SEND','provider_operational_debt_v1',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    ) ON CONFLICT ("id") DO UPDATE SET
      "accountId"=EXCLUDED."accountId", "creatorId"=EXCLUDED."creatorId",
      "customOrderId"=EXCLUDED."customOrderId", "customSubmissionId"=EXCLUDED."customSubmissionId",
      "reason"=EXCLUDED."reason", "sourceVersion"=EXCLUDED."sourceVersion", "updatedAt"=CURRENT_TIMESTAMP;

    PERFORM "phase2_publish_domain_work"(
      NEW."agencyId",'CUSTOM_EXTERNAL_PROJECTION','AutomationDelivery',NEW."id",
      COALESCE(NULLIF(v_account_id,''),NEW."creatorId"),NEW."creatorId",NULLIF(v_account_id,''),NULL,NULL,0,CURRENT_TIMESTAMP
    );
    RETURN NEW;
  END IF;

  v_order_id := COALESCE(NULLIF(NEW."payload"->>'customOrderId',''), NULLIF(NEW."result"->>'customOrderId',''), NULLIF(NEW."targetId",''));
  v_submission_id := COALESCE(NULLIF(NEW."payload"->>'submissionId',''), NULLIF(NEW."result"->>'submissionId',''));
  v_message_id := COALESCE(NULLIF(NEW."messageId",''), NULLIF(NEW."result"->>'messageId',''));
  IF v_order_id IS NULL OR v_message_id IS NULL THEN RETURN NEW; END IF;

  SELECT EXISTS(
           SELECT 1 FROM jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(NEW."result"->'mediaIds')='array' THEN NEW."result"->'mediaIds' ELSE '[]'::jsonb END
           ) AS media(value)
         ),
         (v_message_id = ANY(ord."deliveryMessageIds"))
         AND NOT EXISTS(
           SELECT 1 FROM jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(NEW."result"->'mediaIds')='array' THEN NEW."result"->'mediaIds' ELSE '[]'::jsonb END
           ) AS media(value)
           WHERE NOT (media.value = ANY(ord."deliverySentMediaIds"))
         )
    INTO v_has_media, v_projected
    FROM "CustomOrder" ord
   WHERE ord."agencyId"=NEW."agencyId" AND ord."id"=v_order_id
   LIMIT 1;
  IF NOT COALESCE(v_has_media,FALSE) OR COALESCE(v_projected,FALSE) THEN RETURN NEW; END IF;

  INSERT INTO "ProviderOperationalDebt"(
    "id","agencyId","accountId","creatorId","debtClass","objectType","objectId",
    "customOrderId","customSubmissionId","intentId","reason","sourceVersion","createdAt","updatedAt"
  ) VALUES (
    'pod_external_' || NEW."id", NEW."agencyId", '__CUSTOM_MANUAL__', NEW."creatorId",
    'CUSTOM_EXTERNAL_PROJECTION_DEBT','AutomationDelivery',NEW."id",
    v_order_id,v_submission_id,NULL,'CUSTOM_MANUAL_SEND','provider_operational_debt_v1',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
  ) ON CONFLICT ("id") DO UPDATE SET
    "creatorId"=EXCLUDED."creatorId", "customOrderId"=EXCLUDED."customOrderId",
    "customSubmissionId"=EXCLUDED."customSubmissionId", "reason"=EXCLUDED."reason",
    "sourceVersion"=EXCLUDED."sourceVersion", "updatedAt"=CURRENT_TIMESTAMP;

  PERFORM "phase2_publish_domain_work"(
    NEW."agencyId",'CUSTOM_EXTERNAL_PROJECTION','AutomationDelivery',NEW."id",
    NEW."creatorId",NEW."creatorId",NULL,NULL,NULL,0,CURRENT_TIMESTAMP
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "AutomationDelivery_custom_external_projection_debt" ON "AutomationDelivery";
CREATE TRIGGER "AutomationDelivery_custom_external_projection_debt"
AFTER INSERT OR DELETE OR UPDATE OF "status","actionType","payload","result","targetId","messageId"
ON "AutomationDelivery"
FOR EACH ROW EXECUTE FUNCTION "phase2_refresh_custom_external_projection_debt"();

-- TEAM_DIALOG_PROJECTION: one executable work identity per creator/dialog. Raw events carry
-- their own projection marker so coalescing multiple invalidations cannot skip an event.
ALTER TABLE "TeamActivityEvent"
  ADD COLUMN IF NOT EXISTS "dialogProjectionVersion" TEXT,
  ADD COLUMN IF NOT EXISTS "dialogProjectedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "TeamActivityEvent_dialog_projection_work_idx"
  ON "TeamActivityEvent"("agencyId","creatorId","dialogId","dialogProjectionVersion","ts","id");
CREATE INDEX IF NOT EXISTS "TeamActivityEvent_dialog_projection_enumeration_v1_idx"
  ON "TeamActivityEvent"("agencyId","id")
  WHERE ("dialogProjectionVersion" IS NULL OR "dialogProjectionVersion" <> 'team_dialog_projection_v1')
    AND (
      "eventKind" IN ('FAN_MESSAGE_RECEIVED','DIALOG_SEEN','DIALOG_SESSION') OR
      ("eventKind"='MESSAGE_SEND_CONFIRMED'
       AND UPPER(COALESCE("actionSource",''))='MANUAL'
       AND UPPER(COALESCE("lifecycle",''))='CONFIRMED')
    );

CREATE OR REPLACE FUNCTION "phase2_team_dialog_domain_work_trigger"()
RETURNS TRIGGER AS $$
DECLARE
  v_dialog_id TEXT;
  v_object_id TEXT;
BEGIN
  IF NEW."creatorId" IS NULL OR NEW."eventKind" IS NULL THEN RETURN NEW; END IF;
  v_dialog_id := COALESCE(NULLIF(NEW."dialogId",''),NULLIF(NEW."fanId",''));

  IF v_dialog_id IS NOT NULL AND (
       NEW."eventKind" IN ('FAN_MESSAGE_RECEIVED','DIALOG_SEEN','DIALOG_SESSION') OR
       (NEW."eventKind"='MESSAGE_SEND_CONFIRMED' AND UPPER(COALESCE(NEW."actionSource",''))='MANUAL' AND UPPER(COALESCE(NEW."lifecycle",''))='CONFIRMED')
     ) THEN
    v_object_id := json_build_array(NEW."creatorId",v_dialog_id)::text;
    PERFORM "phase2_publish_domain_work"(
      NEW."agencyId",'TEAM_DIALOG_PROJECTION','CreatorDialog',v_object_id,
      NEW."creatorId",NEW."creatorId",NULL,NULL,NULL,0,CURRENT_TIMESTAMP
    );
  END IF;

  IF NEW."eventKind" IN ('COVERAGE_STARTED','COVERAGE_ENDED') THEN
    PERFORM "phase2_publish_domain_work"(
      NEW."agencyId",'TEAM_RESPONSE_RANGE_REPAIR','TeamActivityEvent',NEW."id",
      NEW."creatorId",NEW."creatorId",NULL,NULL,NULL,0,CURRENT_TIMESTAMP
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "TeamActivityEvent_phase2_dialog_work" ON "TeamActivityEvent";
CREATE TRIGGER "TeamActivityEvent_phase2_dialog_work"
AFTER INSERT ON "TeamActivityEvent"
FOR EACH ROW EXECUTE FUNCTION "phase2_team_dialog_domain_work_trigger"();

-- New agencies have no historical dialog projection debt. Extend the current coverage
-- activation set without dropping families introduced by previous Phase 2 migrations.
CREATE OR REPLACE FUNCTION "phase2_new_agency_coverage_trigger"()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO "Phase2WorkCoverage"(
    "id","agencyId","family","generation","active","enumerationState",
    "unresolvedCount","sourceWatermark","activatedAt","completedAt","createdAt","updatedAt"
  ) VALUES
    ('p2cov_' || md5(NEW."id" || E'\x1f' || 'PROVIDER_OPERATIONAL' || E'\x1f' || 'phase2_provider_operational_coverage_v1'), NEW."id",'PROVIDER_OPERATIONAL','phase2_provider_operational_coverage_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\x1f' || 'CUSTOM_EXTERNAL_PROJECTION' || E'\x1f' || 'phase2_custom_external_coverage_v1'), NEW."id",'CUSTOM_EXTERNAL_PROJECTION','phase2_custom_external_coverage_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\x1f' || 'TEAM_ACTIVITY_CONTRIBUTION' || E'\x1f' || 'phase2_team_activity_contribution_v2'), NEW."id",'TEAM_ACTIVITY_CONTRIBUTION','phase2_team_activity_contribution_v2',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\x1f' || 'TEAM_RESPONSE_RANGE_REPAIR' || E'\x1f' || 'phase2_team_response_range_v2'), NEW."id",'TEAM_RESPONSE_RANGE_REPAIR','phase2_team_response_range_v2',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\x1f' || 'TEAM_DIALOG_PROJECTION' || E'\x1f' || 'phase2_team_dialog_projection_v1'), NEW."id",'TEAM_DIALOG_PROJECTION','phase2_team_dialog_projection_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\x1f' || 'TEAM_MONEY_ROOT_CLASSIFICATION' || E'\x1f' || 'phase2_team_money_root_classification_v1'), NEW."id",'TEAM_MONEY_ROOT_CLASSIFICATION','phase2_team_money_root_classification_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\x1f' || 'TEAM_MONEY_RECONCILIATION' || E'\x1f' || 'phase2_team_money_reconciliation_v1'), NEW."id",'TEAM_MONEY_RECONCILIATION','phase2_team_money_reconciliation_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\x1f' || 'TEAM_READ_SUMMARY' || E'\x1f' || 'phase2_team_money_read_summary_v1'), NEW."id",'TEAM_READ_SUMMARY','phase2_team_money_read_summary_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\x1f' || 'TELEGRAM_CONFIRMED_PROJECTION' || E'\x1f' || 'phase2_telegram_confirmed_projection_v1'), NEW."id",'TELEGRAM_CONFIRMED_PROJECTION','phase2_telegram_confirmed_projection_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\x1f' || 'TELEGRAM_INBOUND_PROJECTION' || E'\x1f' || 'phase2_telegram_inbound_projection_v1'), NEW."id",'TELEGRAM_INBOUND_PROJECTION','phase2_telegram_inbound_projection_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
  ON CONFLICT ("agencyId","family","generation") DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- TEAM_MONEY_RECONCILIATION: canonical CreatorSale/CreatorTip transitions publish exact
-- reconciliation work. This removes current business mutation from collector request paths.
CREATE OR REPLACE FUNCTION "phase2_team_money_reconciliation_trigger"()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM "phase2_publish_domain_work"(
    NEW."agencyId",'TEAM_MONEY_RECONCILIATION',TG_TABLE_NAME,NEW."id",
    NEW."creatorId",NEW."creatorId",NULL,NULL,NULL,0,CURRENT_TIMESTAMP
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "CreatorSale_phase2_team_money_work" ON "CreatorSale";
CREATE TRIGGER "CreatorSale_phase2_team_money_work"
AFTER INSERT OR UPDATE OF "fanId","externalNotificationId","eventFingerprint","saleType","messageId","amountCents","currency","purchasedAt","transactionStatus","externalTransactionId","sourceUpdatedAt"
ON "CreatorSale" FOR EACH ROW EXECUTE FUNCTION "phase2_team_money_reconciliation_trigger"();

DROP TRIGGER IF EXISTS "CreatorTip_phase2_team_money_work" ON "CreatorTip";
CREATE TRIGGER "CreatorTip_phase2_team_money_work"
AFTER INSERT OR UPDATE OF "fanId","externalNotificationId","eventFingerprint","messageId","amountCents","currency","tippedAt","transactionStatus","externalTransactionId","sourceUpdatedAt"
ON "CreatorTip" FOR EACH ROW EXECUTE FUNCTION "phase2_team_money_reconciliation_trigger"();

-- TEAM_READ_SUMMARY: durable contribution snapshot plus daily/lifetime aggregates.
CREATE TABLE IF NOT EXISTS "TeamMoneyDailyRollup" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "creatorKey" TEXT NOT NULL DEFAULT '__none__',
  "creatorId" TEXT,
  "sourceType" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "day" DATE NOT NULL,
  "amountCents" BIGINT NOT NULL DEFAULT 0,
  "factCount" INTEGER NOT NULL DEFAULT 0,
  "projectionVersion" TEXT NOT NULL DEFAULT 'team_money_rollup_v1',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TeamMoneyDailyRollup_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TeamMoneyDailyRollup_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "TeamMoneyDailyRollup_identity_key"
  ON "TeamMoneyDailyRollup"("agencyId","memberId","creatorKey","sourceType","currency","day");
CREATE INDEX IF NOT EXISTS "TeamMoneyDailyRollup_agency_day_member_idx"
  ON "TeamMoneyDailyRollup"("agencyId","day","memberId");
CREATE INDEX IF NOT EXISTS "TeamMoneyDailyRollup_agency_creator_day_idx"
  ON "TeamMoneyDailyRollup"("agencyId","creatorId","day");

CREATE TABLE IF NOT EXISTS "TeamMoneyLifetimeRollup" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "creatorKey" TEXT NOT NULL DEFAULT '__none__',
  "creatorId" TEXT,
  "sourceType" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "amountCents" BIGINT NOT NULL DEFAULT 0,
  "factCount" INTEGER NOT NULL DEFAULT 0,
  "projectionVersion" TEXT NOT NULL DEFAULT 'team_money_rollup_v1',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TeamMoneyLifetimeRollup_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TeamMoneyLifetimeRollup_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "TeamMoneyLifetimeRollup_identity_key"
  ON "TeamMoneyLifetimeRollup"("agencyId","memberId","creatorKey","sourceType","currency");
CREATE INDEX IF NOT EXISTS "TeamMoneyLifetimeRollup_agency_member_idx"
  ON "TeamMoneyLifetimeRollup"("agencyId","memberId");
CREATE INDEX IF NOT EXISTS "TeamMoneyLifetimeRollup_agency_creator_idx"
  ON "TeamMoneyLifetimeRollup"("agencyId","creatorId");

CREATE TABLE IF NOT EXISTS "TeamMoneyRollupContribution" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "sourceFactId" TEXT NOT NULL,
  "factFingerprint" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT FALSE,
  "memberId" TEXT,
  "creatorKey" TEXT NOT NULL DEFAULT '__none__',
  "creatorId" TEXT,
  "sourceType" TEXT,
  "currency" TEXT,
  "day" DATE,
  "amountCents" BIGINT NOT NULL DEFAULT 0,
  "projectionVersion" TEXT NOT NULL DEFAULT 'team_money_rollup_v1',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TeamMoneyRollupContribution_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TeamMoneyRollupContribution_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TeamMoneyRollupContribution_sourceFactId_fkey" FOREIGN KEY ("sourceFactId") REFERENCES "TeamMoneyAttributionFact"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "TeamMoneyRollupContribution_sourceFactId_key" ON "TeamMoneyRollupContribution"("sourceFactId");
CREATE INDEX IF NOT EXISTS "TeamMoneyRollupContribution_active_day_idx" ON "TeamMoneyRollupContribution"("agencyId","active","day");

CREATE OR REPLACE FUNCTION "phase2_team_money_read_summary_trigger"()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM "phase2_publish_domain_work"(
    NEW."agencyId",'TEAM_READ_SUMMARY','TeamMoneyAttributionFact',NEW."id",
    COALESCE(NULLIF(NEW."creatorId",''),NEW."agencyId"),NEW."creatorId",NULL,NULL,NULL,0,CURRENT_TIMESTAMP
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "TeamMoneyAttributionFact_phase2_read_summary_work" ON "TeamMoneyAttributionFact";
CREATE TRIGGER "TeamMoneyAttributionFact_phase2_read_summary_work"
AFTER INSERT OR UPDATE OF "memberId","creatorId","amountCents","currency","occurredAt","businessStatus","financialStatus","attributionActive","classificationState","sourceUpdatedAt"
ON "TeamMoneyAttributionFact" FOR EACH ROW EXECUTE FUNCTION "phase2_team_money_read_summary_trigger"();

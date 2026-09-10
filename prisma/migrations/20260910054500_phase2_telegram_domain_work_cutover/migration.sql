-- Phase 2 Telegram projection execution cutover.
-- Current provider receipts/inbound events publish exact DomainWork; history is enumerated per agency in bounded pages.

CREATE INDEX IF NOT EXISTS "TelegramInboundEvent_receipt_sender_pending_idx"
  ON "TelegramInboundEvent"("agencyId","accountId","senderTelegramUserId","id")
  WHERE "submissionId" IS NULL AND "projectionState" IN ('PENDING','FAILED_RETRYABLE');
CREATE INDEX IF NOT EXISTS "TelegramInboundEvent_receipt_reply_pending_idx"
  ON "TelegramInboundEvent"("agencyId","accountId","replyToMessageId","id")
  WHERE "submissionId" IS NULL AND "projectionState" IN ('PENDING','FAILED_RETRYABLE') AND "replyToMessageId" IS NOT NULL;

CREATE OR REPLACE FUNCTION "phase2_inbound_domain_work_trigger"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP='INSERT' OR OLD."submissionId" IS DISTINCT FROM NEW."submissionId" THEN
    PERFORM "phase2_publish_domain_work"(
      NEW."agencyId",'TELEGRAM_INBOUND_PROJECTION','TelegramInboundEvent',NEW."id",
      COALESCE(NEW."accountId",NEW."creatorId"),NEW."creatorId",NEW."accountId",NULL,NULL,0,CURRENT_TIMESTAMP
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "TelegramInboundEvent_phase2_domain_work" ON "TelegramInboundEvent";
CREATE TRIGGER "TelegramInboundEvent_phase2_domain_work"
AFTER INSERT OR UPDATE OF "submissionId" ON "TelegramInboundEvent"
FOR EACH ROW EXECUTE FUNCTION "phase2_inbound_domain_work_trigger"();

-- Refine the earlier intent producer: clearing projectionBlockedAt after a successful projection
-- must not republish the same claimed revision forever. A newly confirmed/changed provider receipt
-- also publishes an inbound receipt-context item whose continuation is bounded by DomainWork.progressCursor.
CREATE OR REPLACE FUNCTION "phase2_intent_domain_work_trigger"()
RETURNS TRIGGER AS $$
DECLARE v_confirm_changed BOOLEAN := FALSE;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD."customOrderId" IS NOT NULL THEN
      PERFORM "phase2_publish_domain_work"(OLD."agencyId",'CUSTOM_COMMUNICATION','CustomOrder',OLD."customOrderId",OLD."creatorId",OLD."creatorId",OLD."accountId",NULL,NULL,0,CURRENT_TIMESTAMP);
      IF OLD."kind" IN ('AUTO_REMINDER','MANUAL_REMINDER') THEN
        PERFORM "phase2_bump_dependency"(OLD."agencyId",'REMINDER_OUTCOME',OLD."customOrderId");
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  IF NEW."customOrderId" IS NOT NULL THEN
    PERFORM "phase2_publish_domain_work"(NEW."agencyId",'CUSTOM_COMMUNICATION','CustomOrder',NEW."customOrderId",NEW."creatorId",NEW."creatorId",NEW."accountId",NULL,NULL,0,CURRENT_TIMESTAMP);
    IF NEW."kind" IN ('AUTO_REMINDER','MANUAL_REMINDER') AND
       (TG_OP='INSERT' OR OLD."state" IS DISTINCT FROM NEW."state" OR OLD."outcomeReason" IS DISTINCT FROM NEW."outcomeReason" OR OLD."remoteMessageId" IS DISTINCT FROM NEW."remoteMessageId" OR OLD."confirmedAt" IS DISTINCT FROM NEW."confirmedAt") THEN
      PERFORM "phase2_bump_dependency"(NEW."agencyId",'REMINDER_OUTCOME',NEW."customOrderId");
    END IF;
  END IF;

  IF TG_OP='INSERT' THEN
    v_confirm_changed := NEW."state"='CONFIRMED' OR NEW."projectionBlockedAt" IS NOT NULL;
  ELSE
    v_confirm_changed :=
      (NEW."state"='CONFIRMED' AND (
        OLD."state" IS DISTINCT FROM NEW."state" OR
        OLD."remoteMessageId" IS DISTINCT FROM NEW."remoteMessageId" OR
        OLD."remoteRecipientTelegramUserId" IS DISTINCT FROM NEW."remoteRecipientTelegramUserId" OR
        OLD."remoteSentAt" IS DISTINCT FROM NEW."remoteSentAt" OR
        OLD."confirmedAt" IS DISTINCT FROM NEW."confirmedAt" OR
        OLD."confirmationAuthority" IS DISTINCT FROM NEW."confirmationAuthority"
      )) OR
      (NEW."projectionBlockedAt" IS NOT NULL AND OLD."projectionBlockedAt" IS DISTINCT FROM NEW."projectionBlockedAt");
  END IF;

  IF v_confirm_changed THEN
    PERFORM "phase2_publish_domain_work"(NEW."agencyId",'TELEGRAM_CONFIRMED_PROJECTION','TelegramDeliveryIntent',NEW."id",COALESCE(NEW."accountId",NEW."creatorId"),NEW."creatorId",NEW."accountId",NULL,NULL,0,CURRENT_TIMESTAMP);
    IF NEW."state"='CONFIRMED' AND NEW."remoteMessageId" IS NOT NULL THEN
      PERFORM "phase2_publish_domain_work"(NEW."agencyId",'TELEGRAM_INBOUND_PROJECTION','TelegramDeliveryReceipt',NEW."id",COALESCE(NEW."accountId",NEW."creatorId"),NEW."creatorId",NEW."accountId",NULL,NULL,0,CURRENT_TIMESTAMP);
    END IF;
  END IF;

  IF TG_OP='UPDATE' AND OLD."customOrderId" IS NOT NULL AND
     (OLD."customOrderId" IS DISTINCT FROM NEW."customOrderId" OR OLD."agencyId" IS DISTINCT FROM NEW."agencyId") THEN
    PERFORM "phase2_publish_domain_work"(OLD."agencyId",'CUSTOM_COMMUNICATION','CustomOrder',OLD."customOrderId",OLD."creatorId",OLD."creatorId",OLD."accountId",NULL,NULL,0,CURRENT_TIMESTAMP);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Existing trigger is already attached to this function; replace it only to include receipt authority fields.
DROP TRIGGER IF EXISTS "TelegramDeliveryIntent_phase2_domain_work" ON "TelegramDeliveryIntent";
CREATE TRIGGER "TelegramDeliveryIntent_phase2_domain_work"
AFTER INSERT OR DELETE OR UPDATE OF "customOrderId","accountId","kind","state","commitStartedAt","remoteMessageId","remoteRecipientTelegramUserId","remoteSentAt","confirmedAt","confirmationAuthority","projectionBlockedAt","providerBindingRetryAt","outcomeReason"
ON "TelegramDeliveryIntent" FOR EACH ROW EXECUTE FUNCTION "phase2_intent_domain_work_trigger"();

-- New agencies have no pre-cutover Telegram rows; live triggers above are already installed.
CREATE OR REPLACE FUNCTION "phase2_new_agency_coverage_trigger"()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO "Phase2WorkCoverage"(
    "id","agencyId","family","generation","active","enumerationState",
    "unresolvedCount","sourceWatermark","activatedAt","completedAt","createdAt","updatedAt"
  ) VALUES
    ('p2cov_' || md5(NEW."id" || E'\\x1f' || 'PROVIDER_OPERATIONAL' || E'\\x1f' || 'phase2_provider_operational_coverage_v1'), NEW."id",'PROVIDER_OPERATIONAL','phase2_provider_operational_coverage_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\\x1f' || 'CUSTOM_EXTERNAL_PROJECTION' || E'\\x1f' || 'phase2_custom_external_coverage_v1'), NEW."id",'CUSTOM_EXTERNAL_PROJECTION','phase2_custom_external_coverage_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\\x1f' || 'TEAM_ACTIVITY_CONTRIBUTION' || E'\\x1f' || 'phase2_team_activity_contribution_v2'), NEW."id",'TEAM_ACTIVITY_CONTRIBUTION','phase2_team_activity_contribution_v2',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\\x1f' || 'TEAM_RESPONSE_RANGE_REPAIR' || E'\\x1f' || 'phase2_team_response_range_v2'), NEW."id",'TEAM_RESPONSE_RANGE_REPAIR','phase2_team_response_range_v2',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\\x1f' || 'TEAM_MONEY_ROOT_CLASSIFICATION' || E'\\x1f' || 'phase2_team_money_root_classification_v1'), NEW."id",'TEAM_MONEY_ROOT_CLASSIFICATION','phase2_team_money_root_classification_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\\x1f' || 'TELEGRAM_CONFIRMED_PROJECTION' || E'\\x1f' || 'phase2_telegram_confirmed_projection_v1'), NEW."id",'TELEGRAM_CONFIRMED_PROJECTION','phase2_telegram_confirmed_projection_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\\x1f' || 'TELEGRAM_INBOUND_PROJECTION' || E'\\x1f' || 'phase2_telegram_inbound_projection_v1'), NEW."id",'TELEGRAM_INBOUND_PROJECTION','phase2_telegram_inbound_projection_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
  ON CONFLICT ("agencyId","family","generation") DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

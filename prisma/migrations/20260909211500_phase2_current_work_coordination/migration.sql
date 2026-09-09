-- Phase 2 final scale cutover: distributed maintenance ownership is execution
-- metadata only. It never replaces canonical Team/Custom/Telegram facts.
CREATE TABLE IF NOT EXISTS "MaintenanceLaneState" (
  "key" TEXT NOT NULL,
  "generation" TEXT NOT NULL,
  "ownerToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "nextRunAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "cursor" JSONB,
  "progress" JSONB,
  "lastRunAt" TIMESTAMP(3),
  "lastOutcome" TEXT,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MaintenanceLaneState_pkey" PRIMARY KEY ("key")
);

CREATE INDEX IF NOT EXISTS "MaintenanceLaneState_leaseUntil_idx"
  ON "MaintenanceLaneState"("leaseUntil");
CREATE INDEX IF NOT EXISTS "MaintenanceLaneState_due_idx"
  ON "MaintenanceLaneState"("nextRunAt", "completedAt");

-- Current pending-projection debt must be locatable without walking canonical
-- Team history. New events are projected inline; this index is the recovery
-- workset for rows whose derived projection is still missing.
CREATE INDEX IF NOT EXISTS "TeamActivityEvent_pending_projection_work_idx"
  ON "TeamActivityEvent"("pendingProjectionVersion", "ts", "id");

-- The legacy bootstrap repair is a finite compatibility lane. This expression
-- index makes the one-time locator bounded by the legacy source itself instead
-- of by all TeamActivityEvent history.
CREATE INDEX IF NOT EXISTS "TeamActivityEvent_legacy_pending_bootstrap_idx"
  ON "TeamActivityEvent"("agencyId", "ts", "id")
  WHERE ("extra"->>'sourceDetail') = 'crm_pending_bootstrap_v1';

-- Summary queries operate at agency/range cardinality. These indexes keep the
-- aggregate plan from depending on member/creator prefix selectivity.
CREATE INDEX IF NOT EXISTS "TeamResponseCase_agency_replyAt_idx"
  ON "TeamResponseCase"("agencyId", "replyAt");
CREATE INDEX IF NOT EXISTS "TeamDialogSession_agency_startedAt_idx"
  ON "TeamDialogSession"("agencyId", "startedAt");
CREATE INDEX IF NOT EXISTS "TeamMoneyAttributionFact_dialog_summary_idx"
  ON "TeamMoneyAttributionFact"(
    "agencyId",
    "memberId",
    "creatorId",
    (COALESCE(NULLIF("fanId",''), NULLIF("dialogId",''))),
    "occurredAt"
  )
  WHERE "attributionActive" = TRUE;

-- Provider/Custom current-work authority. Historical canonical facts remain in their
-- domain tables; this projection only locates current operational work and is always
-- exact-revalidated before a destructive provider lifecycle action.
ALTER TABLE "CustomOrder"
  ADD COLUMN IF NOT EXISTS "providerOperationalDirty" BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "providerOperationalProjectedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "providerOperationalProjectionVersion" TEXT;

CREATE INDEX IF NOT EXISTS "CustomOrder_provider_operational_work_idx"
  ON "CustomOrder"("agencyId", "providerOperationalDirty", "status", "id");

CREATE TABLE IF NOT EXISTS "ProviderOperationalDebt" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "creatorId" TEXT,
  "debtClass" TEXT NOT NULL,
  "objectType" TEXT NOT NULL,
  "objectId" TEXT NOT NULL,
  "customOrderId" TEXT,
  "customSubmissionId" TEXT,
  "intentId" TEXT,
  "reason" TEXT,
  "sourceVersion" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderOperationalDebt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProviderOperationalDebt_identity_key"
  ON "ProviderOperationalDebt"("agencyId", "accountId", "debtClass", "objectType", "objectId");
CREATE INDEX IF NOT EXISTS "ProviderOperationalDebt_account_work_idx"
  ON "ProviderOperationalDebt"("agencyId", "accountId", "debtClass", "updatedAt");
CREATE INDEX IF NOT EXISTS "ProviderOperationalDebt_creator_work_idx"
  ON "ProviderOperationalDebt"("agencyId", "creatorId", "debtClass", "updatedAt");
CREATE INDEX IF NOT EXISTS "ProviderOperationalDebt_order_idx"
  ON "ProviderOperationalDebt"("agencyId", "customOrderId", "updatedAt");
CREATE INDEX IF NOT EXISTS "ProviderOperationalDebt_submission_idx"
  ON "ProviderOperationalDebt"("agencyId", "customSubmissionId", "updatedAt");

-- New writes never rely on the historical backfill to be rediscovered. Any canonical
-- transition that can change provider operational semantics marks only its exact order.
-- The bounded maintenance lane then reprojects that order under a row lock.
CREATE OR REPLACE FUNCTION "phase2_mark_provider_order_dirty"(p_agency TEXT, p_order TEXT)
RETURNS VOID AS $$
BEGIN
  IF p_agency IS NULL OR p_order IS NULL THEN RETURN; END IF;
  UPDATE "CustomOrder"
     SET "providerOperationalDirty" = TRUE
   WHERE "agencyId" = p_agency AND "id" = p_order;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "phase2_provider_intent_dirty_trigger"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    PERFORM "phase2_mark_provider_order_dirty"(NEW."agencyId", NEW."customOrderId");
  END IF;
  IF TG_OP <> 'INSERT' AND (TG_OP = 'DELETE' OR OLD."customOrderId" IS DISTINCT FROM NEW."customOrderId" OR OLD."agencyId" IS DISTINCT FROM NEW."agencyId") THEN
    PERFORM "phase2_mark_provider_order_dirty"(OLD."agencyId", OLD."customOrderId");
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "TelegramDeliveryIntent_provider_operational_dirty" ON "TelegramDeliveryIntent";
CREATE TRIGGER "TelegramDeliveryIntent_provider_operational_dirty"
AFTER INSERT OR DELETE OR UPDATE OF
  "customOrderId", "accountId", "kind", "state", "commitStartedAt", "remoteMessageId",
  "remoteSentAt", "confirmedAt", "projectionBlockedAt", "providerBindingRetryAt", "outcomeReason"
ON "TelegramDeliveryIntent"
FOR EACH ROW EXECUTE FUNCTION "phase2_provider_intent_dirty_trigger"();

CREATE OR REPLACE FUNCTION "phase2_provider_submission_dirty_trigger"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    PERFORM "phase2_mark_provider_order_dirty"(NEW."agencyId", NEW."customOrderId");
  END IF;
  IF TG_OP <> 'INSERT' AND (TG_OP = 'DELETE' OR OLD."customOrderId" IS DISTINCT FROM NEW."customOrderId" OR OLD."agencyId" IS DISTINCT FROM NEW."agencyId") THEN
    PERFORM "phase2_mark_provider_order_dirty"(OLD."agencyId", OLD."customOrderId");
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "CustomContentSubmission_provider_operational_dirty" ON "CustomContentSubmission";
CREATE TRIGGER "CustomContentSubmission_provider_operational_dirty"
AFTER INSERT OR DELETE OR UPDATE OF
  "customOrderId", "telegramSourceAccountId", "telegramSourceUserId", "telegramMessageIds", "ofMediaIds",
  "pipelineDisposition", "reviewStatus"
ON "CustomContentSubmission"
FOR EACH ROW EXECUTE FUNCTION "phase2_provider_submission_dirty_trigger"();

CREATE OR REPLACE FUNCTION "phase2_provider_order_state_dirty_trigger"()
RETURNS TRIGGER AS $$
BEGIN
  NEW."providerOperationalDirty" := TRUE;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "CustomOrder_provider_operational_state_dirty" ON "CustomOrder";
CREATE TRIGGER "CustomOrder_provider_operational_state_dirty"
BEFORE UPDATE OF "status", "type", "telegramCancellationWaivedAt", "telegramCancellationWaiverReason"
ON "CustomOrder"
FOR EACH ROW EXECUTE FUNCTION "phase2_provider_order_state_dirty_trigger"();


-- Creator/provider configuration changes can unblock an exact order without touching that order
-- itself. Re-open only the affected creator's pending CONTENT work; the bounded dirty lane owns
-- model-communication repair and then reprojects provider debt before marking the row clean.
CREATE OR REPLACE FUNCTION "phase2_provider_creator_binding_dirty_trigger"()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE "CustomOrder"
     SET "providerOperationalDirty" = TRUE
   WHERE "agencyId" = NEW."agencyId"
     AND "creatorId" = NEW."id"
     AND "type" = 'CONTENT'
     AND "status" = 'PENDING';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "CreatorAccount_provider_operational_dirty" ON "CreatorAccount";
CREATE TRIGGER "CreatorAccount_provider_operational_dirty"
AFTER UPDATE OF "telegramContact", "telegramUserId", "telegramAccountId", "status", "deletedAt"
ON "CreatorAccount"
FOR EACH ROW EXECUTE FUNCTION "phase2_provider_creator_binding_dirty_trigger"();

CREATE OR REPLACE FUNCTION "phase2_provider_account_lifecycle_dirty_trigger"()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE "CustomOrder" co
     SET "providerOperationalDirty" = TRUE
    FROM "CreatorAccount" ca
   WHERE ca."agencyId" = NEW."agencyId"
     AND ca."telegramAccountId" = NEW."id"
     AND co."agencyId" = ca."agencyId"
     AND co."creatorId" = ca."id"
     AND co."type" = 'CONTENT'
     AND co."status" = 'PENDING';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "AgencyTelegramMtprotoAccount_provider_operational_dirty" ON "AgencyTelegramMtprotoAccount";
CREATE TRIGGER "AgencyTelegramMtprotoAccount_provider_operational_dirty"
AFTER UPDATE OF "lifecycleState"
ON "AgencyTelegramMtprotoAccount"
FOR EACH ROW EXECUTE FUNCTION "phase2_provider_account_lifecycle_dirty_trigger"();

CREATE OR REPLACE FUNCTION "phase2_provider_order_delete_cleanup_trigger"()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM "ProviderOperationalDebt"
   WHERE "agencyId" = OLD."agencyId" AND "customOrderId" = OLD."id";
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "CustomOrder_provider_operational_delete_cleanup" ON "CustomOrder";
CREATE TRIGGER "CustomOrder_provider_operational_delete_cleanup"
AFTER DELETE ON "CustomOrder"
FOR EACH ROW EXECUTE FUNCTION "phase2_provider_order_delete_cleanup_trigger"();

-- New external Custom completions become bounded current-work debt immediately.
-- This trigger is only a locator projection: every worker revalidates the exact
-- AutomationDelivery + Custom business object before changing canonical state.
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
    DELETE FROM "ProviderOperationalDebt"
     WHERE "debtClass"='CUSTOM_EXTERNAL_PROJECTION_DEBT'
       AND "objectType"='AutomationDelivery'
       AND "objectId"=OLD."id";
    RETURN OLD;
  END IF;

  DELETE FROM "ProviderOperationalDebt"
   WHERE "debtClass"='CUSTOM_EXTERNAL_PROJECTION_DEBT'
     AND "objectType"='AutomationDelivery'
     AND "objectId"=NEW."id";

  IF NEW."status" <> 'COMPLETED' OR NEW."actionType" NOT IN ('CUSTOM_RELAY_SEND','CUSTOM_MANUAL_SEND') THEN
    RETURN NEW;
  END IF;

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
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "AutomationDelivery_custom_external_projection_debt" ON "AutomationDelivery";
CREATE TRIGGER "AutomationDelivery_custom_external_projection_debt"
AFTER INSERT OR DELETE OR UPDATE OF "status","actionType","payload","result","targetId","messageId"
ON "AutomationDelivery"
FOR EACH ROW EXECUTE FUNCTION "phase2_refresh_custom_external_projection_debt"();

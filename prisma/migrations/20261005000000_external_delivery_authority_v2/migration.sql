BEGIN;
-- Additive authority. Applied historical SQL and remote delivery facts stay intact.
CREATE TABLE "MassCreatorDeliveryState" (
  "creatorId" TEXT PRIMARY KEY REFERENCES "CreatorAccount"("id") ON DELETE CASCADE,
  "agencyId" TEXT NOT NULL REFERENCES "Agency"("id") ON DELETE CASCADE,
  "sourceRevision" BIGINT NOT NULL DEFAULT 0,
  "observationSequence" BIGINT NOT NULL DEFAULT 0,
  "activeSequence" BIGINT NOT NULL DEFAULT 0,
  "activeObservationId" TEXT,
  "retirementId" TEXT,
  "retirementStartedAt" TIMESTAMP(3),
  "retirementProofId" TEXT,
  "retirementProofRevision" BIGINT,
  "retirementProofObservedAt" TIMESTAMP(3),
  "retirementProviderId" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'UTC')
);
CREATE INDEX "MassCreatorDeliveryState_agency_creator_idx" ON "MassCreatorDeliveryState"("agencyId","creatorId");
CREATE TABLE "MassQueueObservation" (
  "id" TEXT PRIMARY KEY,
  "agencyId" TEXT NOT NULL REFERENCES "Agency"("id") ON DELETE CASCADE,
  "creatorId" TEXT NOT NULL REFERENCES "CreatorAccount"("id") ON DELETE CASCADE,
  "userId" TEXT NOT NULL, "memberId" TEXT NOT NULL, "deviceId" TEXT NOT NULL, "accessEpoch" INTEGER NOT NULL,
  "purpose" TEXT NOT NULL CHECK ("purpose" IN ('BROWSE','RETIREMENT')),
  "sequence" BIGINT NOT NULL,
  "sourceRevision" BIGINT NOT NULL,
  "retirementId" TEXT,
  "providerId" TEXT,
  "fenceAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "retainUntil" TIMESTAMP(3) NOT NULL,
  "acceptedAt" TIMESTAMP(3), "publishedAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'OPEN' CHECK ("status" IN ('OPEN','READY','APPLYING','APPLIED','EXPIRED')),
  "itemCount" INTEGER,
  "receivedCount" INTEGER NOT NULL DEFAULT 0,
  "pageCount" INTEGER NOT NULL DEFAULT 0,
  "lastQueueId" TEXT,
  "phase" TEXT NOT NULL DEFAULT 'PRESENT' CHECK ("phase" IN ('PRESENT','CURRENT','FINAL')),
  "cursor" TEXT,
  "pending" INTEGER NOT NULL DEFAULT 0,
  "settled" INTEGER NOT NULL DEFAULT 0,
  "cancelSettled" INTEGER NOT NULL DEFAULT 0,
  "response" JSONB,
  CONSTRAINT "MassQueueObservation_count_check" CHECK ("receivedCount" BETWEEN 0 AND 100000 AND ("itemCount" IS NULL OR "itemCount" BETWEEN 0 AND 100000))
);
CREATE INDEX "MassQueueObservation_retention_idx" ON "MassQueueObservation"("retainUntil","id");
CREATE INDEX "MassQueueObservation_creator_idx" ON "MassQueueObservation"("agencyId","creatorId","sequence");
CREATE TABLE "MassQueueObservationPage" (
  "observationId" TEXT NOT NULL REFERENCES "MassQueueObservation"("id") ON DELETE CASCADE,
  "ordinal" INTEGER NOT NULL,
  "digest" TEXT NOT NULL,
  PRIMARY KEY ("observationId","ordinal")
);
CREATE TABLE "MassQueueObservationItem" (
  "observationId" TEXT NOT NULL REFERENCES "MassQueueObservation"("id") ON DELETE CASCADE,
  "queueId" TEXT COLLATE "C" NOT NULL,
  PRIMARY KEY ("observationId","queueId")
);

-- All generations share this physical revision/retirement barrier. Old runtime
-- code cannot bypass a prepared retirement or publish an invisible MASS change.
CREATE FUNCTION "onlinod_mass_delivery_mutation_v2"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s "MassCreatorDeliveryState"%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND OLD."actionType" IN ('MASS_QUEUE_CREATE','MASS_NATIVE_QUEUE_CREATE','MASS_PROVIDER_QUEUE_OBSERVED','MASS_QUEUE_CANCEL','MASS_NATIVE_QUEUE_CANCEL')
     AND ROW(OLD."agencyId",OLD."creatorId",OLD."actionType") IS DISTINCT FROM ROW(NEW."agencyId",NEW."creatorId",NEW."actionType") THEN
    RAISE EXCEPTION 'MASS_DELIVERY_IDENTITY_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  IF NEW."actionType" NOT IN ('MASS_QUEUE_CREATE','MASS_NATIVE_QUEUE_CREATE','MASS_PROVIDER_QUEUE_OBSERVED','MASS_QUEUE_CANCEL','MASS_NATIVE_QUEUE_CANCEL') THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
    IF ROW(OLD."agencyId",OLD."creatorId",OLD."actionType") IS DISTINCT FROM ROW(NEW."agencyId",NEW."creatorId",NEW."actionType") THEN
      RAISE EXCEPTION 'MASS_DELIVERY_IDENTITY_IMMUTABLE' USING ERRCODE='23514';
    END IF;
    IF ROW(OLD."status",OLD."targetId",OLD."writeCommitAt",OLD."writeCommitRevision",OLD."remoteLifecycleState",OLD."remoteTargetId",OLD."remoteLifecycleObservedAt",OLD."failureCode")
       IS NOT DISTINCT FROM ROW(NEW."status",NEW."targetId",NEW."writeCommitAt",NEW."writeCommitRevision",NEW."remoteLifecycleState",NEW."remoteTargetId",NEW."remoteLifecycleObservedAt",NEW."failureCode") THEN RETURN NEW; END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM "CreatorAccount" WHERE "id"=NEW."creatorId" AND "agencyId"=NEW."agencyId") THEN
    RAISE EXCEPTION 'MASS_DELIVERY_SCOPE_MISMATCH' USING ERRCODE='23514';
  END IF;
  INSERT INTO "MassCreatorDeliveryState"("creatorId","agencyId") VALUES (NEW."creatorId",NEW."agencyId") ON CONFLICT ("creatorId") DO NOTHING;
  SELECT * INTO s FROM "MassCreatorDeliveryState" WHERE "creatorId"=NEW."creatorId" FOR UPDATE;
  IF s."agencyId" IS DISTINCT FROM NEW."agencyId" THEN RAISE EXCEPTION 'MASS_DELIVERY_SCOPE_MISMATCH' USING ERRCODE='23514'; END IF;
  IF s."retirementId" IS NOT NULL AND NEW."actionType" IN ('MASS_QUEUE_CREATE','MASS_NATIVE_QUEUE_CREATE') THEN
    IF TG_OP='INSERT' OR (NEW."status"='COMMITTING' AND (OLD."status" IS DISTINCT FROM 'COMMITTING' OR NEW."writeCommitAt" IS DISTINCT FROM OLD."writeCommitAt" OR NEW."writeCommitRevision" IS DISTINCT FROM OLD."writeCommitRevision")) THEN
      RAISE EXCEPTION 'MASS_CREATOR_RETIREMENT_IN_PROGRESS' USING ERRCODE='23514';
    END IF;
  END IF;
  UPDATE "MassCreatorDeliveryState" SET "sourceRevision"="sourceRevision"+1,
    "retirementProofId"=NULL,"retirementProofRevision"=NULL,"retirementProofObservedAt"=NULL,
    "updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "creatorId"=NEW."creatorId";
  RETURN NEW;
END $$;
CREATE TRIGGER "mass_delivery_mutation_v2" BEFORE INSERT OR UPDATE ON "AutomationDelivery"
  FOR EACH ROW EXECUTE FUNCTION "onlinod_mass_delivery_mutation_v2"();

CREATE FUNCTION "onlinod_mass_delivery_delete_v2"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."actionType" NOT IN ('MASS_QUEUE_CREATE','MASS_NATIVE_QUEUE_CREATE','MASS_PROVIDER_QUEUE_OBSERVED','MASS_QUEUE_CANCEL','MASS_NATIVE_QUEUE_CANCEL') THEN RETURN OLD; END IF;
  -- Parent cascade is permitted only after the parent's own retirement guard.
  IF NOT EXISTS(SELECT 1 FROM "CreatorAccount" WHERE "id"=OLD."creatorId") THEN RETURN OLD; END IF;
  IF EXISTS(SELECT 1 FROM "AutomationDelivery" WHERE "id"=OLD."id" AND ("actionType" IN ('MASS_QUEUE_CREATE','MASS_NATIVE_QUEUE_CREATE','MASS_PROVIDER_QUEUE_OBSERVED','MASS_QUEUE_CANCEL','MASS_NATIVE_QUEUE_CANCEL') AND
  ("status" IN ('QUEUED','CLAIMED','RUNNING','COMMITTING','RECONCILE_REQUIRED','RETRY_SCHEDULED','PAUSED') OR
   ("actionType" IN ('MASS_QUEUE_CREATE','MASS_NATIVE_QUEUE_CREATE','MASS_PROVIDER_QUEUE_OBSERVED') AND
    ("remoteLifecycleState" IN ('PENDING','UNKNOWN','MIGRATION_RECONCILE_REQUIRED') OR
     ("status"='COMPLETED' AND "remoteLifecycleState" IS NULL) OR
     ("status"='FAILED' AND "failureCode"='outcome_unresolved_do_not_retry' AND "remoteLifecycleState" IS DISTINCT FROM 'SETTLED'))) OR
   ("actionType" IN ('MASS_QUEUE_CANCEL','MASS_NATIVE_QUEUE_CANCEL') AND "status"='FAILED' AND "failureCode"='outcome_unresolved_do_not_retry'))) ) THEN
    RAISE EXCEPTION 'MASS_CURRENT_DEBT_NOT_DELETABLE' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER "mass_delivery_delete_v2" BEFORE DELETE ON "AutomationDelivery" FOR EACH ROW EXECUTE FUNCTION "onlinod_mass_delivery_delete_v2"();

CREATE FUNCTION "onlinod_mass_creator_retirement_v2"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE retiring BOOLEAN;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW."remoteId" IS DISTINCT FROM OLD."remoteId" THEN
      UPDATE "MassCreatorDeliveryState" SET "sourceRevision"="sourceRevision"+1,"retirementProofId"=NULL,
        "retirementProofRevision"=NULL,"retirementProofObservedAt"=NULL WHERE "creatorId"=OLD."id";
    END IF;
    retiring := OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL;
    IF NOT retiring THEN RETURN NEW; END IF;
  ELSE retiring := OLD."deletedAt" IS NULL; END IF;
  IF EXISTS(SELECT 1 FROM "AutomationDelivery" WHERE "creatorId"=OLD."id" AND "agencyId"=OLD."agencyId" AND ("actionType" IN ('MASS_QUEUE_CREATE','MASS_NATIVE_QUEUE_CREATE','MASS_PROVIDER_QUEUE_OBSERVED','MASS_QUEUE_CANCEL','MASS_NATIVE_QUEUE_CANCEL') AND
  ("status" IN ('QUEUED','CLAIMED','RUNNING','COMMITTING','RECONCILE_REQUIRED','RETRY_SCHEDULED','PAUSED') OR
   ("actionType" IN ('MASS_QUEUE_CREATE','MASS_NATIVE_QUEUE_CREATE','MASS_PROVIDER_QUEUE_OBSERVED') AND
    ("remoteLifecycleState" IN ('PENDING','UNKNOWN','MIGRATION_RECONCILE_REQUIRED') OR
     ("status"='COMPLETED' AND "remoteLifecycleState" IS NULL) OR
     ("status"='FAILED' AND "failureCode"='outcome_unresolved_do_not_retry' AND "remoteLifecycleState" IS DISTINCT FROM 'SETTLED'))) OR
   ("actionType" IN ('MASS_QUEUE_CANCEL','MASS_NATIVE_QUEUE_CANCEL') AND "status"='FAILED' AND "failureCode"='outcome_unresolved_do_not_retry'))) ) THEN
    RAISE EXCEPTION 'CREATOR_HAS_ACTIVE_MASS' USING ERRCODE='23514';
  END IF;
  IF retiring AND NULLIF(btrim(OLD."remoteId"),'') IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM "MassCreatorDeliveryState" s WHERE s."creatorId"=OLD."id" AND s."agencyId"=OLD."agencyId"
      AND s."retirementId" IS NOT NULL AND s."retirementProofId" IS NOT NULL AND s."retirementProofRevision"=s."sourceRevision"
      AND s."retirementProviderId" IS NOT DISTINCT FROM OLD."remoteId") THEN
    RAISE EXCEPTION 'CREATOR_MASS_PROVIDER_SNAPSHOT_REQUIRED' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "mass_creator_retirement_v2" BEFORE UPDATE OR DELETE ON "CreatorAccount" FOR EACH ROW EXECUTE FUNCTION "onlinod_mass_creator_retirement_v2"();

CREATE FUNCTION "onlinod_mass_agency_retirement_v2"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE retiring BOOLEAN;
BEGIN
  IF TG_OP='UPDATE' THEN
    retiring := OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL;
    IF NOT retiring THEN RETURN NEW; END IF;
  ELSE retiring := OLD."deletedAt" IS NULL; END IF;
  IF EXISTS(SELECT 1 FROM "AutomationDelivery" WHERE "agencyId"=OLD."id" AND ("actionType" IN ('MASS_QUEUE_CREATE','MASS_NATIVE_QUEUE_CREATE','MASS_PROVIDER_QUEUE_OBSERVED','MASS_QUEUE_CANCEL','MASS_NATIVE_QUEUE_CANCEL') AND
  ("status" IN ('QUEUED','CLAIMED','RUNNING','COMMITTING','RECONCILE_REQUIRED','RETRY_SCHEDULED','PAUSED') OR
   ("actionType" IN ('MASS_QUEUE_CREATE','MASS_NATIVE_QUEUE_CREATE','MASS_PROVIDER_QUEUE_OBSERVED') AND
    ("remoteLifecycleState" IN ('PENDING','UNKNOWN','MIGRATION_RECONCILE_REQUIRED') OR
     ("status"='COMPLETED' AND "remoteLifecycleState" IS NULL) OR
     ("status"='FAILED' AND "failureCode"='outcome_unresolved_do_not_retry' AND "remoteLifecycleState" IS DISTINCT FROM 'SETTLED'))) OR
   ("actionType" IN ('MASS_QUEUE_CANCEL','MASS_NATIVE_QUEUE_CANCEL') AND "status"='FAILED' AND "failureCode"='outcome_unresolved_do_not_retry'))) ) THEN
    RAISE EXCEPTION 'AGENCY_HAS_ACTIVE_MASS' USING ERRCODE='23514';
  END IF;
  IF retiring AND EXISTS(SELECT 1 FROM "CreatorAccount" c LEFT JOIN "MassCreatorDeliveryState" s ON s."creatorId"=c."id" AND s."agencyId"=c."agencyId"
    WHERE c."agencyId"=OLD."id" AND c."deletedAt" IS NULL AND NULLIF(btrim(c."remoteId"),'') IS NOT NULL
      AND (s."retirementId" IS NULL OR s."retirementProofId" IS NULL OR s."retirementProofRevision" IS DISTINCT FROM s."sourceRevision"
        OR s."retirementProviderId" IS DISTINCT FROM c."remoteId")) THEN
    RAISE EXCEPTION 'AGENCY_MASS_PROVIDER_SNAPSHOT_REQUIRED' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "mass_agency_retirement_v2" BEFORE UPDATE OR DELETE ON "Agency" FOR EACH ROW EXECUTE FUNCTION "onlinod_mass_agency_retirement_v2"();

CREATE FUNCTION "onlinod_telegram_new_send_v2"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE lifecycle TEXT;
BEGIN
  IF NEW."state"<>'COMMITTING' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD."state"='COMMITTING' AND NEW."commitStartedAt" IS NOT DISTINCT FROM OLD."commitStartedAt"
     AND ROW(NEW."claimRevision",NEW."agencyId",NEW."creatorId",NEW."accountId",NEW."kind",NEW."logicalKey",NEW."payloadFingerprint",NEW."deviceId")
       IS NOT DISTINCT FROM ROW(OLD."claimRevision",OLD."agencyId",OLD."creatorId",OLD."accountId",OLD."kind",OLD."logicalKey",OLD."payloadFingerprint",OLD."deviceId") THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD."commitStartedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'TELEGRAM_SEND_REPLAY_NOT_ALLOWED' USING ERRCODE='23514';
  END IF;
  IF current_setting('onlinod.telegram_send_generation',true) IS DISTINCT FROM 'external_delivery_v2' THEN
    RAISE EXCEPTION 'TELEGRAM_SEND_RUNTIME_UPGRADE_REQUIRED' USING ERRCODE='23514';
  END IF;
  SELECT "lifecycleState" INTO lifecycle FROM "AgencyTelegramMtprotoAccount" WHERE "id"=NEW."accountId" AND "agencyId"=NEW."agencyId" FOR SHARE;
  IF lifecycle IS DISTINCT FROM 'ACTIVE' THEN RAISE EXCEPTION 'TELEGRAM_EXECUTION_NEW_SEND_FORBIDDEN' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "telegram_new_send_v2" BEFORE INSERT OR UPDATE ON "TelegramDeliveryIntent" FOR EACH ROW EXECUTE FUNCTION "onlinod_telegram_new_send_v2"();

COMMIT;

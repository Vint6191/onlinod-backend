-- Phase 4 foundation; deploy only with the complete reviewed Phase 4 cutover.
ALTER TABLE "AdminUser" ADD COLUMN "accessEpoch" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "AdminSession" ADD COLUMN "issuedAccessEpoch" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AdminSession" ALTER COLUMN "issuedAccessEpoch" SET DEFAULT 1;
ALTER TABLE "CreatorBillingProfile" ADD COLUMN "pricingRevision" INTEGER NOT NULL DEFAULT 1;
-- Existing sessions retain epoch 0 and fail authority checks. New sessions
-- bind the actual epoch explicitly. No full-table revocation UPDATE is needed.

CREATE FUNCTION onlinod_admin_access_epoch_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."passwordHash", NEW."role", NEW."active") IS DISTINCT FROM
     ROW(OLD."passwordHash", OLD."role", OLD."active") THEN
    NEW."accessEpoch" := OLD."accessEpoch" + 1;
  ELSE
    NEW."accessEpoch" := OLD."accessEpoch";
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "AdminUser_access_epoch_v1" BEFORE UPDATE ON "AdminUser"
FOR EACH ROW EXECUTE FUNCTION onlinod_admin_access_epoch_v1();

-- Covers every pricing writer, including payment and renewal paths. Revenue
-- observations do not change pricingRevision. Overflow aborts instead of wrap.
CREATE FUNCTION onlinod_pricing_revision_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."tier", NEW."tierMode", NEW."corePriceCents", NEW."aiChatterEnabled",
         NEW."aiChatterPriceCents", NEW."outreachEnabled", NEW."outreachPriceCents",
         NEW."billingExcluded", NEW."notes") IS DISTINCT FROM
     ROW(OLD."tier", OLD."tierMode", OLD."corePriceCents", OLD."aiChatterEnabled",
         OLD."aiChatterPriceCents", OLD."outreachEnabled", OLD."outreachPriceCents",
         OLD."billingExcluded", OLD."notes") THEN
    NEW."pricingRevision" := OLD."pricingRevision" + 1;
  ELSE
    NEW."pricingRevision" := OLD."pricingRevision";
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "CreatorBillingProfile_pricing_revision_v1" BEFORE UPDATE ON "CreatorBillingProfile"
FOR EACH ROW EXECUTE FUNCTION onlinod_pricing_revision_v1();

CREATE TABLE "AdminCommand" (
 "id" TEXT NOT NULL PRIMARY KEY, "actorId" TEXT NOT NULL, "commandId" TEXT NOT NULL,
 "sessionId" TEXT NOT NULL, "actorAccessEpoch" INTEGER NOT NULL,
 "action" TEXT NOT NULL, "targetId" TEXT NOT NULL, "payloadHash" TEXT NOT NULL,
 "reason" TEXT NOT NULL, "scopeAgencyId" TEXT, "status" TEXT NOT NULL,
 "httpStatus" INTEGER NOT NULL DEFAULT 0, "result" JSONB,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completedAt" TIMESTAMP(3),
 CONSTRAINT "AdminCommand_status_check" CHECK ("status" IN ('RUNNING', 'SUCCEEDED', 'REJECTED'))
);
CREATE UNIQUE INDEX "AdminCommand_actorId_commandId_key" ON "AdminCommand"("actorId", "commandId");
CREATE INDEX "AdminCommand_actorId_createdAt_id_idx" ON "AdminCommand"("actorId", "createdAt", "id");
CREATE INDEX "AdminCommand_scopeAgencyId_createdAt_id_idx" ON "AdminCommand"("scopeAgencyId", "createdAt", "id");
CREATE TABLE "AdminCommandAudit" (
 "id" TEXT NOT NULL PRIMARY KEY, "commandId" TEXT NOT NULL, "sequence" INTEGER NOT NULL,
 "actorId" TEXT NOT NULL, "action" TEXT NOT NULL, "targetId" TEXT NOT NULL,
 "scopeAgencyId" TEXT, "event" TEXT NOT NULL, "reason" TEXT NOT NULL, "detail" JSONB NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "AdminCommandAudit_commandId_fkey" FOREIGN KEY ("commandId") REFERENCES "AdminCommand"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AdminCommandAudit_commandId_sequence_key" ON "AdminCommandAudit"("commandId", "sequence");
CREATE INDEX "AdminCommandAudit_scopeAgencyId_createdAt_id_idx" ON "AdminCommandAudit"("scopeAgencyId", "createdAt", "id");
CREATE INDEX "AdminCommandAudit_actorId_createdAt_id_idx" ON "AdminCommandAudit"("actorId", "createdAt", "id");

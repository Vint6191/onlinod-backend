-- R1 is already deployed: only additive forward migration here.
ALTER TABLE "Agency" ADD COLUMN "billingPolicyRevision" INTEGER NOT NULL DEFAULT 1,
 ADD COLUMN "billingSupportHold" BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN "billingSupportHoldReason" TEXT,
 ADD COLUMN "billingSupportHoldAt" TIMESTAMP(3);
ALTER TABLE "CreatorBillingEntitlement" ADD COLUMN "entitlementRevision" INTEGER NOT NULL DEFAULT 1;
-- Preserve live historical explicit locks. Retired agencies remain lifecycle-owned.
UPDATE "Agency" SET "billingSupportHold"=true,
 "billingSupportHoldReason"='Preserved historical LOCKED status', "billingSupportHoldAt"=clock_timestamp()
 WHERE "status"='LOCKED' AND "deletedAt" IS NULL;

CREATE FUNCTION onlinod_agency_billing_policy_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW."plan",NEW."trialEndsAt",NEW."billingSupportHold",NEW."billingSupportHoldReason") IS DISTINCT FROM
    ROW(OLD."plan",OLD."trialEndsAt",OLD."billingSupportHold",OLD."billingSupportHoldReason") THEN
   NEW."billingPolicyRevision" := GREATEST(NEW."billingPolicyRevision",OLD."billingPolicyRevision"+1);
 ELSE
   NEW."billingPolicyRevision" := GREATEST(NEW."billingPolicyRevision",OLD."billingPolicyRevision");
 END IF;
 IF NEW."billingSupportHold" OR NEW."deletedAt" IS NOT NULL THEN NEW."status" := 'LOCKED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "Agency_billing_policy_v1" BEFORE UPDATE ON "Agency"
 FOR EACH ROW EXECUTE FUNCTION onlinod_agency_billing_policy_v1();

-- All registered subscription writers lock Agency before Subscription.
-- Aggregate status/paid dates do not invalidate a displayed policy version.
CREATE FUNCTION onlinod_subscription_policy_revision_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
   UPDATE "Agency" SET "billingPolicyRevision"="billingPolicyRevision"+1 WHERE "id"=NEW."agencyId";
 ELSIF TG_OP='DELETE' THEN
   UPDATE "Agency" SET "billingPolicyRevision"="billingPolicyRevision"+1 WHERE "id"=OLD."agencyId";
 ELSIF ROW(NEW."billingMode",NEW."billingPeriod",NEW."corePricePerCreatorCents",NEW."trialEndsAt",NEW."notes") IS DISTINCT FROM
       ROW(OLD."billingMode",OLD."billingPeriod",OLD."corePricePerCreatorCents",OLD."trialEndsAt",OLD."notes") THEN
   UPDATE "Agency" SET "billingPolicyRevision"="billingPolicyRevision"+1 WHERE "id"=NEW."agencyId";
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER "AgencySubscription_policy_revision_v1" AFTER INSERT OR UPDATE OR DELETE ON "AgencySubscription"
 FOR EACH ROW EXECUTE FUNCTION onlinod_subscription_policy_revision_v1();

CREATE FUNCTION onlinod_entitlement_revision_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ignored TEXT[] := ARRAY['entitlementRevision','updatedAt','lastRenewalAttemptAt','lastRenewalErrorCode','lastRevenue30dCents','lastRevenueCapturedAt'];
BEGIN
 IF (to_jsonb(NEW)-ignored) IS DISTINCT FROM (to_jsonb(OLD)-ignored) THEN
   NEW."entitlementRevision" := OLD."entitlementRevision"+1;
 ELSE NEW."entitlementRevision" := OLD."entitlementRevision";
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "CreatorBillingEntitlement_revision_v1" BEFORE UPDATE ON "CreatorBillingEntitlement"
 FOR EACH ROW EXECUTE FUNCTION onlinod_entitlement_revision_v1();
CREATE INDEX "AgencySubscription_agency_created_id_idx" ON "AgencySubscription"("agencyId","createdAt","id");

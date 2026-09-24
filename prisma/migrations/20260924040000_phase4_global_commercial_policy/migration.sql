BEGIN;
SET LOCAL lock_timeout = '5s';

INSERT INTO "SystemSetting" ("id","key","value","revision","updatedAt")
VALUES ('commercial-policy-v1','billing.commercial.policy.v1',
 '{"trialDays":14,"starterPriceCents":2000,"growthPriceCents":3000,"proPriceCents":5000,"elitePriceCents":15000,"aiChatterPriceCents":10000,"outreachPriceCents":2900}'::jsonb,1,clock_timestamp());

CREATE FUNCTION phase4_commercial_policy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE field TEXT; amount NUMERIC;
BEGIN
 IF (TG_OP <> 'INSERT' AND OLD."key" = 'billing.commercial.policy.v1') OR
    (TG_OP <> 'DELETE' AND NEW."key" = 'billing.commercial.policy.v1') THEN
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NEW."key" <> OLD."key") THEN
   RAISE EXCEPTION 'COMMERCIAL_POLICY_CANNOT_DELETE_OR_RENAME';
  END IF;
  IF current_setting('onlinod.commercial_policy_command',true) IS DISTINCT FROM 'v1' THEN
   RAISE EXCEPTION 'COMMERCIAL_POLICY_COMMAND_REQUIRED';
  END IF;
  IF jsonb_typeof(NEW."value") IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'COMMERCIAL_POLICY_INVALID'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(NEW."value")) <> 7 THEN RAISE EXCEPTION 'COMMERCIAL_POLICY_INVALID'; END IF;
  FOREACH field IN ARRAY ARRAY['trialDays','starterPriceCents','growthPriceCents','proPriceCents','elitePriceCents','aiChatterPriceCents','outreachPriceCents'] LOOP
   IF jsonb_typeof(NEW."value"->field) IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'COMMERCIAL_POLICY_INVALID'; END IF;
   amount := (NEW."value"->>field)::numeric;
   IF amount <> trunc(amount) OR amount < (CASE WHEN field IN ('aiChatterPriceCents','outreachPriceCents') THEN 0 ELSE 1 END)
      OR amount > (CASE WHEN field='trialDays' THEN 365 ELSE 1000000 END) THEN RAISE EXCEPTION 'COMMERCIAL_POLICY_INVALID'; END IF;
  END LOOP;
  IF TG_OP='UPDATE' THEN NEW."revision" := OLD."revision" + 1; ELSE NEW."revision" := 1; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "phase4_commercial_policy_guard" BEFORE INSERT OR UPDATE OR DELETE ON "SystemSetting"
 FOR EACH ROW EXECUTE FUNCTION phase4_commercial_policy_guard();

ALTER TABLE "Agency" ADD COLUMN "trialGrantedAt" TIMESTAMP(3), ADD COLUMN "trialGrantedDays" INTEGER, ADD COLUMN "trialPolicyRevision" INTEGER;
-- A historical null TRIAL is finite from its original creation, not a fresh
-- trial on every deployment. Explicit previous deadlines remain unchanged.
WITH existing_trials AS (
 SELECT a."id", a."createdAt", s."trialEndsAt" AS previous_end
 FROM "Agency" a LEFT JOIN LATERAL (
   SELECT "trialEndsAt" FROM "AgencySubscription" WHERE "agencyId"=a."id"
   ORDER BY "createdAt" DESC, "id" DESC LIMIT 1
 ) s ON true
 WHERE a."status"='TRIAL' AND a."trialEndsAt" IS NULL AND a."deletedAt" IS NULL
)
UPDATE "Agency" a SET
 "trialGrantedAt"=CASE WHEN t.previous_end IS NULL THEN t."createdAt" END,
 "trialGrantedDays"=CASE WHEN t.previous_end IS NULL THEN 14 END,
 "trialPolicyRevision"=CASE WHEN t.previous_end IS NULL THEN 1 END,
 "trialEndsAt"=COALESCE(t.previous_end,t."createdAt" + interval '14 days')
 FROM existing_trials t WHERE a."id"=t."id";
CREATE FUNCTION phase4_issue_agency_trial() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy RECORD; issued TIMESTAMP(3);
BEGIN
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW."trialGrantedAt",NEW."trialGrantedDays",NEW."trialPolicyRevision") IS DISTINCT FROM
     ROW(OLD."trialGrantedAt",OLD."trialGrantedDays",OLD."trialPolicyRevision") THEN RAISE EXCEPTION 'TRIAL_ISSUANCE_IMMUTABLE'; END IF;
  RETURN NEW;
 END IF;
 SELECT "value","revision" INTO STRICT policy FROM "SystemSetting" WHERE "key"='billing.commercial.policy.v1' FOR SHARE;
 issued := clock_timestamp() AT TIME ZONE 'UTC';
 -- Server-owned issuance, also for a draining binary that omitted the dates.
 NEW."trialGrantedAt" := issued;
 NEW."trialGrantedDays" := (policy."value"->>'trialDays')::integer;
 NEW."trialPolicyRevision" := policy."revision";
 NEW."trialEndsAt" := issued + make_interval(days => NEW."trialGrantedDays");
 RETURN NEW;
END $$;
CREATE TRIGGER "phase4_issue_agency_trial" BEFORE INSERT OR UPDATE ON "Agency"
 FOR EACH ROW EXECUTE FUNCTION phase4_issue_agency_trial();

ALTER TABLE "CreatorBillingProfile" ADD COLUMN "corePriceOverrideCents" INTEGER,
 ADD COLUMN "aiChatterPriceOverrideCents" INTEGER, ADD COLUMN "outreachPriceOverrideCents" INTEGER;
-- AUTO amounts were observations. A fixed standard tier at its old catalog
-- amount inherits global prices too; a manual non-standard amount and CUSTOM
-- remain individual exceptions. After cutover nullable fields record intention
-- explicitly, including an override equal to the current catalog price.
UPDATE "CreatorBillingProfile" SET
 "corePriceOverrideCents"=CASE WHEN "tier"='CUSTOM' OR ("tierMode"='MANUAL' AND "corePriceCents" <> CASE "tier" WHEN 'STARTER' THEN 2000 WHEN 'GROWTH' THEN 3000 WHEN 'PRO' THEN 5000 WHEN 'ELITE' THEN 15000 ELSE 0 END) THEN "corePriceCents" ELSE NULL END,
 "aiChatterPriceOverrideCents"=CASE WHEN "aiChatterPriceCents"<>10000 AND ("aiChatterEnabled" OR "aiChatterPriceCents"<>0) THEN "aiChatterPriceCents" ELSE NULL END,
 "outreachPriceOverrideCents"=CASE WHEN "outreachPriceCents"<>2900 AND ("outreachEnabled" OR "outreachPriceCents"<>0) THEN "outreachPriceCents" ELSE NULL END;
ALTER TABLE "CreatorBillingProfile" ADD CONSTRAINT "CreatorBillingProfile_override_prices_valid" CHECK (
 ("corePriceOverrideCents" IS NULL OR "corePriceOverrideCents">=0) AND
 ("aiChatterPriceOverrideCents" IS NULL OR "aiChatterPriceOverrideCents">=0) AND
 ("outreachPriceOverrideCents" IS NULL OR "outreachPriceOverrideCents">=0));
-- Old writers cannot silently create a new copied-price authority or erase an
-- explicit override. Only the complete new writer generation can configure it.
CREATE FUNCTION phase4_commercial_pricing_writer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('onlinod.commercial_pricing_writer',true) IS DISTINCT FROM 'v1' THEN
  RAISE EXCEPTION 'COMMERCIAL_PRICING_WRITER_REQUIRED';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "phase4_commercial_pricing_writer_guard" BEFORE INSERT OR UPDATE ON "CreatorBillingProfile"
 FOR EACH ROW EXECUTE FUNCTION phase4_commercial_pricing_writer_guard();
CREATE OR REPLACE FUNCTION onlinod_pricing_revision_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW) - ARRAY['pricingRevision','updatedAt','revenue30dCents']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['pricingRevision','updatedAt','revenue30dCents']) THEN
  NEW."pricingRevision" := OLD."pricingRevision"+1;
 ELSE NEW."pricingRevision" := OLD."pricingRevision"; END IF;
 RETURN NEW;
END $$;
ALTER TABLE "CreatorBillingPeriod" ADD COLUMN "commercialPolicyRevision" INTEGER;
COMMIT;

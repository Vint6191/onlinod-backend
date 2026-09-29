BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "AnalyticsCollectionDemand" ADD COLUMN "scopeMode" TEXT NOT NULL DEFAULT 'LEGACY';
-- NOT VALID avoids a history scan; checks still enforce every subsequent write.
ALTER TABLE "AnalyticsCollectionDemand" ADD CONSTRAINT "AnalyticsCollectionDemand_scopeMode_check"
 CHECK ("scopeMode" IN ('LEGACY','MEMBER_CURRENT')) NOT VALID;
ALTER TABLE "AnalyticsCollectionDemand" ADD CONSTRAINT "AnalyticsCollectionDemand_member_scope_shape_check"
 CHECK ("scopeMode" <> 'MEMBER_CURRENT' OR "creatorIds" IS NULL OR "creatorIds" = 'null'::jsonb) NOT VALID;
-- Older backend replicas do not understand MEMBER_CURRENT billing/scope semantics.
-- They must not acquire one of these demands during a mixed-version rollout.
CREATE FUNCTION "phase6_home_member_scope_claim_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."scopeMode" = 'MEMBER_CURRENT' AND NEW."claimToken" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."claimToken" IS DISTINCT FROM OLD."claimToken"
          OR NEW."claimedRevision" IS DISTINCT FROM OLD."claimedRevision")
     AND current_setting('onlinod.home_member_scope_version',true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'HOME_MEMBER_SCOPE_WORKER_UPGRADE_REQUIRED';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "phase6_home_member_scope_claim_guard" BEFORE INSERT OR UPDATE
 ON "AnalyticsCollectionDemand" FOR EACH ROW EXECUTE FUNCTION "phase6_home_member_scope_claim_guard"();
COMMIT;

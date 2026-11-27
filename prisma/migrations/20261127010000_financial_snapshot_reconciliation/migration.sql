BEGIN;
SET LOCAL lock_timeout = '5s';

-- Existing generations retain their original membership semantics. Only a
-- completed rebuild can grant the new proof policy to a published snapshot.
ALTER TABLE "CreatorEarningsGeneration"
  ADD COLUMN "proofPolicyVersion" integer NOT NULL DEFAULT 1,
  ADD COLUMN "canonicalRepairCursor" text NOT NULL DEFAULT '',
  ADD COLUMN "canonicalRepairThroughId" text,
  ADD CONSTRAINT "CreatorEarningsGeneration_proofPolicyVersion_check" CHECK ("proofPolicyVersion" >= 1);
ALTER TABLE "CreatorEarningsGeneration" DROP CONSTRAINT "CreatorEarningsGeneration_state_check";
ALTER TABLE "CreatorEarningsGeneration" ADD CONSTRAINT "CreatorEarningsGeneration_state_check"
  CHECK (state IN ('BUILDING','READY','REPAIRING','ACTIVE','RETIRED'));
ALTER TABLE "CreatorEarningsGeneration" ADD CONSTRAINT "CreatorEarningsGeneration_canonical_repair_check"
  CHECK (state <> 'REPAIRING' OR ("publishedAt" IS NULL AND "canonicalRepairThroughId" IS NOT NULL));
ALTER TABLE "CreatorEarningsGeneration" DROP CONSTRAINT "CreatorEarningsGeneration_phase_check";
ALTER TABLE "CreatorEarningsGeneration" ADD CONSTRAINT "CreatorEarningsGeneration_phase_check"
  CHECK (phase IN ('COPY','APPLY','WITHDRAW','RESOLVE','READY'));
DROP INDEX "EarningsGeneration_building";
CREATE UNIQUE INDEX "EarningsGeneration_building" ON "CreatorEarningsGeneration"("creatorId")
  WHERE state IN ('BUILDING','READY','REPAIRING');
DROP INDEX "EarningsGeneration_abandoned";
CREATE INDEX "EarningsGeneration_abandoned" ON "CreatorEarningsGeneration"("createdAt",id)
  WHERE state IN ('BUILDING','READY','REPAIRING');

CREATE OR REPLACE FUNCTION onlinod_earnings_writer_fence_v6() RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE creator text;
BEGIN
 creator := CASE WHEN TG_OP='DELETE' THEN OLD."creatorId" ELSE NEW."creatorId" END;
 IF current_setting('onlinod.earnings_writer_generation',true) IS DISTINCT FROM 'v8'
   AND EXISTS(SELECT 1 FROM "CreatorAccount" WHERE id=creator AND "deletedAt" IS NULL)
 THEN RAISE EXCEPTION 'EARNINGS_WRITER_UPGRADE_REQUIRED' USING ERRCODE='55000'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $body$;

CREATE OR REPLACE FUNCTION onlinod_earnings_writer_fence_v7() RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE creator text; rowdata jsonb;
BEGIN
 rowdata := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 creator := rowdata->>'creatorId';
 IF creator IS NULL THEN SELECT "creatorId" INTO creator FROM "CreatorEarningsGeneration" WHERE id=rowdata->>'generation'; END IF;
 IF current_setting('onlinod.earnings_writer_generation',true) IS DISTINCT FROM 'v8'
   AND EXISTS(SELECT 1 FROM "CreatorAccount" WHERE id=creator AND "deletedAt" IS NULL)
 THEN RAISE EXCEPTION 'EARNINGS_WRITER_UPGRADE_REQUIRED' USING ERRCODE='55000'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $body$;

COMMIT;

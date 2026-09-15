-- Actual59 F59-A/B/C closure: durable server-side access-generation boundary.
-- The boundary is captured transactionally by the same UPDATE that advances
-- AgencyMember.accessEpoch. It is deliberately conservative: endedAt is the
-- server statement timestamp at which the old epoch is invalidated inside the
-- mutation transaction, so Team performance can never extend beyond it.
CREATE TABLE IF NOT EXISTS "AgencyMemberAccessEpochBoundary" (
  "memberId" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "accessEpoch" INTEGER NOT NULL,
  "nextAccessEpoch" INTEGER NOT NULL,
  "endedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgencyMemberAccessEpochBoundary_pkey" PRIMARY KEY ("memberId", "accessEpoch")
);

CREATE INDEX IF NOT EXISTS "AgencyMemberAccessEpochBoundary_agency_user_ended_idx"
  ON "AgencyMemberAccessEpochBoundary"("agencyId", "userId", "endedAt");

CREATE OR REPLACE FUNCTION "capture_agency_member_access_epoch_boundary"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."accessEpoch" IS DISTINCT FROM OLD."accessEpoch" THEN
    INSERT INTO "AgencyMemberAccessEpochBoundary" (
      "memberId", "agencyId", "userId", "accessEpoch", "nextAccessEpoch", "endedAt"
    ) VALUES (
      OLD."id", OLD."agencyId", OLD."userId", OLD."accessEpoch", NEW."accessEpoch", timezone('UTC', statement_timestamp())
    )
    ON CONFLICT ("memberId", "accessEpoch") DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "AgencyMember_capture_access_epoch_boundary" ON "AgencyMember";
CREATE TRIGGER "AgencyMember_capture_access_epoch_boundary"
AFTER UPDATE OF "accessEpoch" ON "AgencyMember"
FOR EACH ROW
WHEN (OLD."accessEpoch" IS DISTINCT FROM NEW."accessEpoch")
EXECUTE FUNCTION "capture_agency_member_access_epoch_boundary"();

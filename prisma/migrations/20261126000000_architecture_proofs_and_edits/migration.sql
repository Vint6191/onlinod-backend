BEGIN;

-- Existing ledger facts remain intact. Policy zero preserves the distinction
-- between accepted provider history and unverified legacy live extensions.
ALTER TABLE "CreatorEarningsLedgerProof"
  ADD COLUMN "proofPolicyVersion" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "CreatorEarningsLedgerProof_proofPolicyVersion_check"
    CHECK ("proofPolicyVersion" >= 0);

-- Form concurrency is independent of the authorization epoch. A display-name
-- edit must not revoke a running resource generation's authority.
ALTER TABLE "AgencyMember"
  ADD COLUMN "editRevision" INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT "AgencyMember_editRevision_check" CHECK ("editRevision" >= 1);

-- The age of an undelivered tail must not be refreshed by later heartbeats.
-- Existing tails are adopted conservatively by the versioned repair service.
ALTER TABLE "CreatorRealtimeSession" ADD COLUMN "unackedSinceAt" TIMESTAMP(3);

COMMIT;

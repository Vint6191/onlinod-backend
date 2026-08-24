-- V20.19 Phase 8: track which Agency Master Key generation owns each creator CDK.
-- Existing creator keys were created under root v1 before root rotation existed.
ALTER TABLE "CreatorCryptoKeyState"
  ADD COLUMN "rootVersion" INTEGER NOT NULL DEFAULT 1;

CREATE INDEX "CreatorCryptoKeyState_agencyId_rootVersion_idx"
  ON "CreatorCryptoKeyState"("agencyId", "rootVersion");

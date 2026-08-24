-- V20.19 Phase 8: dual-format secret envelopes for zero-relogin client-side E2E migration.
CREATE TYPE "SecretEncryptionMode" AS ENUM ('SERVER_V1', 'CLIENT_E2E_V1');

ALTER TABLE "CreatorSessionState"
  ADD COLUMN "encryptionMode" "SecretEncryptionMode" NOT NULL DEFAULT 'SERVER_V1',
  ADD COLUMN "keyVersion" INTEGER;

ALTER TABLE "AgencyProxyEndpoint"
  ADD COLUMN "encryptionMode" "SecretEncryptionMode" NOT NULL DEFAULT 'SERVER_V1',
  ADD COLUMN "keyVersion" INTEGER;

ALTER TABLE "AgencyCryptoRoot"
  ADD COLUMN "enforceOpaqueSecrets" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "enforcedAt" TIMESTAMP(3);

CREATE INDEX "CreatorSessionState_encryptionMode_idx" ON "CreatorSessionState"("encryptionMode");
CREATE INDEX "AgencyProxyEndpoint_encryptionMode_idx" ON "AgencyProxyEndpoint"("encryptionMode");

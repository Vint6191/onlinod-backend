-- V20.19 Phase 8 hardening: crypto identity ownership must survive WorkerDevice agency/user switching.
-- WorkerDevice is mutable current telemetry and cannot safely backfill immutable crypto ownership.
-- Any rows created by an unreleased/intermediate V20.19 build are therefore invalidated fail-closed:
-- revoke their key wraps, remove the ambiguous identity, then require explicit re-enrollment.
-- Normal production upgrade from V20.18.1 has no DeviceCryptoIdentity rows yet, so this is a no-op there.

ALTER TABLE "DeviceCryptoIdentity" ADD COLUMN "userId" TEXT;

UPDATE "AgencyCryptoOwnerKeyWrap" AS wrap
SET "revokedAt" = COALESCE(wrap."revokedAt", CURRENT_TIMESTAMP)
WHERE EXISTS (
  SELECT 1
  FROM "DeviceCryptoIdentity" AS identity
  WHERE identity."agencyId" = wrap."agencyId"
    AND identity."deviceId" = wrap."deviceId"
    AND identity."userId" IS NULL
);

UPDATE "CreatorDeviceKeyWrap" AS wrap
SET "revokedAt" = COALESCE(wrap."revokedAt", CURRENT_TIMESTAMP)
WHERE EXISTS (
  SELECT 1
  FROM "DeviceCryptoIdentity" AS identity
  WHERE identity."agencyId" = wrap."agencyId"
    AND identity."deviceId" = wrap."deviceId"
    AND identity."userId" IS NULL
);

DELETE FROM "DeviceCryptoIdentity"
WHERE "userId" IS NULL;

ALTER TABLE "DeviceCryptoIdentity" ALTER COLUMN "userId" SET NOT NULL;

CREATE INDEX "DeviceCryptoIdentity_agencyId_userId_idx" ON "DeviceCryptoIdentity"("agencyId", "userId");

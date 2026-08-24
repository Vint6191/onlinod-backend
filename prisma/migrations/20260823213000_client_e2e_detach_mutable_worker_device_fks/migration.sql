-- V20.19 Phase 8 multi-agency hardening.
-- WorkerDevice is a mutable current-workspace telemetry row keyed by physical device id.
-- Crypto identities and wrapped key material are agency-scoped durable security state and must not
-- be cascade-deleted when WorkerDevice moves between agencies or is deleted with another agency.

ALTER TABLE "DeviceCryptoIdentity"
  DROP CONSTRAINT IF EXISTS "DeviceCryptoIdentity_deviceId_fkey";

ALTER TABLE "AgencyCryptoOwnerKeyWrap"
  DROP CONSTRAINT IF EXISTS "AgencyCryptoOwnerKeyWrap_deviceId_fkey";

ALTER TABLE "CreatorDeviceKeyWrap"
  DROP CONSTRAINT IF EXISTS "CreatorDeviceKeyWrap_deviceId_fkey";

-- V20.19 Phase 8 hardening: one physical WorkerDevice can participate in more than one agency.
-- Device private material remains local; the same pinned public key may be registered independently per agency.

ALTER TABLE "DeviceCryptoIdentity"
  DROP CONSTRAINT "DeviceCryptoIdentity_pkey";

ALTER TABLE "DeviceCryptoIdentity"
  ADD CONSTRAINT "DeviceCryptoIdentity_pkey" PRIMARY KEY ("agencyId", "deviceId");

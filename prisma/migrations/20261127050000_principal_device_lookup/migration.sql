BEGIN;
SET LOCAL lock_timeout = '5s';
-- Ownership is global to a logical device, including retained key identities
-- in former agencies. Each auth check reads at most one matching row.
CREATE INDEX "DeviceCryptoIdentity_deviceId_userId_idx" ON "DeviceCryptoIdentity"("deviceId", "userId");
COMMIT;

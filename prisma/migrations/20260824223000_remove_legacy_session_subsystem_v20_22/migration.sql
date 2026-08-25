-- V20.22 P3: final removal of the pre-Session-Broker persistence architecture.
-- AccessSnapshot may contain historical server-decryptable bytes; DROP TABLE
-- is intentional crypto-destruction. No legacy payload is copied forward.

DROP TABLE IF EXISTS "AccessSnapshot";
DROP TABLE IF EXISTS "CreatorConnectSession";

ALTER TABLE "CreatorAccount"
  DROP COLUMN IF EXISTS "partition",
  DROP COLUMN IF EXISTS "sessionMode";

ALTER TABLE "AgencyCryptoRoot"
  DROP COLUMN IF EXISTS "enforceOpaqueSecrets",
  DROP COLUMN IF EXISTS "enforcedAt";

DROP TYPE IF EXISTS "AccessSnapshotType";
DROP TYPE IF EXISTS "ConnectSessionStatus";
DROP TYPE IF EXISTS "CreatorSessionMode";

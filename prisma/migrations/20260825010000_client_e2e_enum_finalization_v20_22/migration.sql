-- V20.22 final production schema: SecretEncryptionMode is structurally CLIENT_E2E_V1-only.
-- Historical migrations are intentionally retained. This migration refuses to remove the
-- legacy enum value while any legacy row still exists.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "CreatorSessionState"
    WHERE "encryptionMode"::text = 'SERVER_V1'
  ) THEN
    RAISE EXCEPTION 'V20.22 enum finalization blocked: SERVER_V1 creator session rows remain';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "AgencyProxyEndpoint"
    WHERE "encryptionMode"::text = 'SERVER_V1'
  ) THEN
    RAISE EXCEPTION 'V20.22 enum finalization blocked: SERVER_V1 proxy rows remain';
  END IF;
END $$;

ALTER TABLE "CreatorSessionState" ALTER COLUMN "encryptionMode" DROP DEFAULT;
ALTER TABLE "AgencyProxyEndpoint" ALTER COLUMN "encryptionMode" DROP DEFAULT;

ALTER TYPE "SecretEncryptionMode" RENAME TO "SecretEncryptionMode_v20_22_legacy";
CREATE TYPE "SecretEncryptionMode" AS ENUM ('CLIENT_E2E_V1');

ALTER TABLE "CreatorSessionState"
  ALTER COLUMN "encryptionMode" TYPE "SecretEncryptionMode"
  USING ("encryptionMode"::text::"SecretEncryptionMode");

ALTER TABLE "AgencyProxyEndpoint"
  ALTER COLUMN "encryptionMode" TYPE "SecretEncryptionMode"
  USING ("encryptionMode"::text::"SecretEncryptionMode");

ALTER TABLE "CreatorSessionState"
  ALTER COLUMN "encryptionMode" SET DEFAULT 'CLIENT_E2E_V1'::"SecretEncryptionMode";

ALTER TABLE "AgencyProxyEndpoint"
  ALTER COLUMN "encryptionMode" SET DEFAULT 'CLIENT_E2E_V1'::"SecretEncryptionMode";

DROP TYPE "SecretEncryptionMode_v20_22_legacy";

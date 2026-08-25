-- V20.22 final runtime cutover: CLIENT_E2E_V1 is the only supported secret format.
--
-- Safety invariant: do NOT silently destroy or strand real legacy credentials.
-- Deployment must stop if secret-bearing SERVER_V1 rows still exist. Credentialless
-- legacy rows are safe to relabel because they contain no secret material.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "CreatorSessionState"
    WHERE "status" = 'ACTIVE'
      AND "encryptionMode" = 'SERVER_V1'
      AND "encryptedPayload" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'V20.22 CLIENT_E2E cutover blocked: ACTIVE SERVER_V1 creator sessions remain';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "AgencyProxyEndpoint"
    WHERE "hasCredentials" = TRUE
      AND "encryptionMode" = 'SERVER_V1'
      AND "encryptedPayload" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'V20.22 CLIENT_E2E cutover blocked: SERVER_V1 proxy credentials remain';
  END IF;
END $$;

-- Rows without secret material can be normalized without migration/decryption.
UPDATE "CreatorSessionState"
SET "encryptionMode" = 'CLIENT_E2E_V1'
WHERE "encryptionMode" = 'SERVER_V1'
  AND "encryptedPayload" IS NULL;

UPDATE "AgencyProxyEndpoint"
SET "encryptionMode" = 'CLIENT_E2E_V1'
WHERE "encryptionMode" = 'SERVER_V1'
  AND "hasCredentials" = FALSE
  AND "encryptedPayload" IS NULL;

ALTER TABLE "CreatorSessionState"
  ALTER COLUMN "encryptionMode" SET DEFAULT 'CLIENT_E2E_V1';

ALTER TABLE "AgencyProxyEndpoint"
  ALTER COLUMN "encryptionMode" SET DEFAULT 'CLIENT_E2E_V1';

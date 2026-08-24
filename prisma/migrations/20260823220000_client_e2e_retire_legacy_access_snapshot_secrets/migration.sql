-- Phase 8 hardening: AccessSnapshot is legacy rollback metadata only after
-- irreversible opaque-secret enforcement.  Secret-bearing columns must be
-- nullable so enforcement can crypto-shred every server-decryptable payload
-- while retaining non-secret provenance until Phase 9 removes the legacy API.
ALTER TABLE "AccessSnapshot"
  ALTER COLUMN "encryptedPayload" DROP NOT NULL,
  ALTER COLUMN "iv" DROP NOT NULL,
  ALTER COLUMN "tag" DROP NOT NULL,
  ALTER COLUMN "algorithm" DROP NOT NULL;

ALTER TABLE "AccessSnapshot"
  ADD COLUMN "payloadRetiredAt" TIMESTAMP(3);

-- Upgrade safety: an earlier V20.19 intermediate may already have flipped the
-- irreversible agency flag while legacy AccessSnapshot ciphertext still
-- existed.  Retire that material immediately at migration deploy; waiting for
-- a user to click the enforcement action again would leave the backend capable
-- of decrypting the old OF credentials.
UPDATE "AccessSnapshot" AS snapshot
SET
  "encryptedPayload" = NULL,
  "iv" = NULL,
  "tag" = NULL,
  "algorithm" = NULL,
  "active" = FALSE,
  "revokedAt" = COALESCE(snapshot."revokedAt", CURRENT_TIMESTAMP),
  "payloadRetiredAt" = COALESCE(snapshot."payloadRetiredAt", CURRENT_TIMESTAMP)
FROM "AgencyCryptoRoot" AS root
WHERE snapshot."agencyId" = root."agencyId"
  AND root."enforceOpaqueSecrets" = TRUE
  AND snapshot."encryptedPayload" IS NOT NULL;

-- Defense in depth for agencies that crossed the flag in an earlier
-- intermediate: no SERVER_V1 ciphertext may survive the irreversible boundary,
-- even if an old status/hasCredentials flag was inconsistent.
UPDATE "CreatorSessionState" AS state
SET
  "encryptedPayload" = NULL,
  "iv" = NULL,
  "tag" = NULL,
  "algorithm" = NULL,
  "keyVersion" = NULL,
  "credentialHash" = NULL,
  "coherenceHash" = NULL
FROM "AgencyCryptoRoot" AS root
WHERE state."agencyId" = root."agencyId"
  AND root."enforceOpaqueSecrets" = TRUE
  AND state."encryptionMode" = 'SERVER_V1'
  AND state."encryptedPayload" IS NOT NULL;

UPDATE "AgencyProxyEndpoint" AS proxy
SET
  "encryptedPayload" = NULL,
  "iv" = NULL,
  "tag" = NULL,
  "algorithm" = NULL,
  "keyVersion" = NULL,
  "hasCredentials" = FALSE
FROM "AgencyCryptoRoot" AS root
WHERE proxy."agencyId" = root."agencyId"
  AND root."enforceOpaqueSecrets" = TRUE
  AND proxy."encryptionMode" = 'SERVER_V1'
  AND proxy."encryptedPayload" IS NOT NULL;

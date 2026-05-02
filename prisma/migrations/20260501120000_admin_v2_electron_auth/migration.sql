-- Admin v2: soft delete, device commands, admin roles
-- Idempotent — safe to re-run.

-- ───────────────────────────────────────────────────────────────
-- Soft-delete on key entities. Hard-deletes are dangerous in
-- production (cascade can remove paid customer's data on a typo).
-- We mark deletedAt instead and filter on queries.
-- ───────────────────────────────────────────────────────────────

ALTER TABLE "Agency"          ADD COLUMN IF NOT EXISTS "deletedAt"      TIMESTAMP(3);
ALTER TABLE "Agency"          ADD COLUMN IF NOT EXISTS "deletedReason"  TEXT;

ALTER TABLE "User"            ADD COLUMN IF NOT EXISTS "disabledAt"     TIMESTAMP(3);
ALTER TABLE "User"            ADD COLUMN IF NOT EXISTS "disabledReason" TEXT;

ALTER TABLE "CreatorAccount"  ADD COLUMN IF NOT EXISTS "deletedAt"      TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Agency_deletedAt_idx"          ON "Agency"("deletedAt");
CREATE INDEX IF NOT EXISTS "User_disabledAt_idx"           ON "User"("disabledAt");
CREATE INDEX IF NOT EXISTS "CreatorAccount_deletedAt_idx"  ON "CreatorAccount"("deletedAt");


-- ───────────────────────────────────────────────────────────────
-- Device commands queue. When admin kicks a device or revokes a
-- creator's access, we don't push — Electron polls and applies.
-- ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "DeviceCommand" (
  "id"            TEXT NOT NULL,
  "deviceId"      TEXT NOT NULL,
  "agencyId"      TEXT NOT NULL,
  "command"       TEXT NOT NULL,
  "payload"       JSONB,
  "issuedByAdmin" TEXT,
  "issuedByUser"  TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deliveredAt"   TIMESTAMP(3),
  "ackedAt"       TIMESTAMP(3),
  "result"        JSONB,
  CONSTRAINT "DeviceCommand_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DeviceCommand_deviceId_idx"   ON "DeviceCommand"("deviceId");
CREATE INDEX IF NOT EXISTS "DeviceCommand_agencyId_idx"   ON "DeviceCommand"("agencyId");
CREATE INDEX IF NOT EXISTS "DeviceCommand_deliveredAt_idx" ON "DeviceCommand"("deliveredAt");

-- Optional FK — keep it loose so device deletion doesn't lose history.
-- (We don't add ON DELETE CASCADE here on purpose.)


-- ───────────────────────────────────────────────────────────────
-- Admin roles: super admin vs read-only support. Default existing
-- admins to SUPER_ADMIN so nothing breaks.
-- ───────────────────────────────────────────────────────────────

UPDATE "AdminUser" SET "role" = 'SUPER_ADMIN' WHERE "role" IS NULL OR "role" = '';


-- ───────────────────────────────────────────────────────────────
-- Impersonation tokens. Short-lived shadow sessions issued by
-- an admin to view a user's workspace. Used by the /impersonate
-- flow: admin creates token → frontend opens new tab with token
-- in URL → tab claims it → gets a normal user accessToken with
-- impersonatedByAdminId stamped for audit.
-- ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "ImpersonationToken" (
  "id"             TEXT NOT NULL,
  "tokenHash"      TEXT NOT NULL,
  "adminUserId"    TEXT NOT NULL,
  "targetUserId"   TEXT NOT NULL,
  "targetAgencyId" TEXT NOT NULL,
  "expiresAt"      TIMESTAMP(3) NOT NULL,
  "claimedAt"      TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ImpersonationToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ImpersonationToken_tokenHash_key" ON "ImpersonationToken"("tokenHash");
CREATE INDEX IF NOT EXISTS "ImpersonationToken_targetUserId_idx" ON "ImpersonationToken"("targetUserId");
CREATE INDEX IF NOT EXISTS "ImpersonationToken_expiresAt_idx"    ON "ImpersonationToken"("expiresAt");


-- ───────────────────────────────────────────────────────────────
-- Stamp on RefreshSession so we know if a session was started by
-- an impersonating admin. Lets us paint a banner in the UI.
-- ───────────────────────────────────────────────────────────────

ALTER TABLE "RefreshSession" ADD COLUMN IF NOT EXISTS "impersonatedByAdminId" TEXT;
CREATE INDEX IF NOT EXISTS "RefreshSession_impersonatedByAdminId_idx" ON "RefreshSession"("impersonatedByAdminId");

-- Electron auth session metadata.
ALTER TABLE "RefreshSession" ADD COLUMN IF NOT EXISTS "deviceId" TEXT;
ALTER TABLE "RefreshSession" ADD COLUMN IF NOT EXISTS "client" TEXT;
ALTER TABLE "RefreshSession" ADD COLUMN IF NOT EXISTS "rememberDevice" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "RefreshSession_deviceId_idx" ON "RefreshSession"("deviceId");

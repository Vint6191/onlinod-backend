-- Team v2: extend AgencyMember with display fields + add roles/overrides/invitations tables
-- Idempotent — safe to re-run.

-- ───────────────────────────────────────────────────────────────
-- AgencyMember — extend with display + role + scope fields
-- ───────────────────────────────────────────────────────────────

ALTER TABLE "AgencyMember" ADD COLUMN IF NOT EXISTS "roleKey"           TEXT;
ALTER TABLE "AgencyMember" ADD COLUMN IF NOT EXISTS "displayName"       TEXT;
ALTER TABLE "AgencyMember" ADD COLUMN IF NOT EXISTS "initials"          TEXT;
ALTER TABLE "AgencyMember" ADD COLUMN IF NOT EXISTS "tone"              TEXT;
ALTER TABLE "AgencyMember" ADD COLUMN IF NOT EXISTS "commission"        JSONB;
ALTER TABLE "AgencyMember" ADD COLUMN IF NOT EXISTS "assignedCreators"  JSONB;
ALTER TABLE "AgencyMember" ADD COLUMN IF NOT EXISTS "statusBadge"       JSONB;
ALTER TABLE "AgencyMember" ADD COLUMN IF NOT EXISTS "lastSeenLabel"     TEXT;
ALTER TABLE "AgencyMember" ADD COLUMN IF NOT EXISTS "isTest"            BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AgencyMember" ADD COLUMN IF NOT EXISTS "deletedAt"         TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "AgencyMember_roleKey_idx" ON "AgencyMember"("roleKey");

-- Backfill: every existing OWNER member gets roleKey='owner', everything
-- else gets a sensible default mapped from the legacy enum.
-- (We do NOT touch the legacy `role` column — it stays as is.)
UPDATE "AgencyMember"
SET "roleKey" = CASE
  WHEN "role" = 'OWNER'    THEN 'owner'
  WHEN "role" = 'ADMIN'    THEN 'manager'
  WHEN "role" = 'MANAGER'  THEN 'manager'
  WHEN "role" = 'OPERATOR' THEN 'chatter'
  ELSE 'chatter'
END
WHERE "roleKey" IS NULL;


-- ───────────────────────────────────────────────────────────────
-- AgencyCustomRole — user-created roles per agency
-- ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "AgencyCustomRole" (
  "id"          TEXT NOT NULL,
  "agencyId"    TEXT NOT NULL,
  "key"         TEXT NOT NULL,
  "label"       TEXT NOT NULL,
  "tone"        TEXT,
  "description" TEXT,
  "access"      JSONB NOT NULL DEFAULT '{}',
  "basedOn"     TEXT,
  "createdByUserId" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgencyCustomRole_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AgencyCustomRole_agencyId_key_key" ON "AgencyCustomRole"("agencyId", "key");
CREATE INDEX        IF NOT EXISTS "AgencyCustomRole_agencyId_idx"     ON "AgencyCustomRole"("agencyId");

ALTER TABLE "AgencyCustomRole"
  DROP CONSTRAINT IF EXISTS "AgencyCustomRole_agencyId_fkey";
ALTER TABLE "AgencyCustomRole"
  ADD CONSTRAINT "AgencyCustomRole_agencyId_fkey"
  FOREIGN KEY ("agencyId") REFERENCES "Agency"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;


-- ───────────────────────────────────────────────────────────────
-- AgencyRoleOverride — preset role customizations per agency
-- (e.g. agency wants "chatter" preset to have money:view instead of hidden)
-- ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "AgencyRoleOverride" (
  "id"        TEXT NOT NULL,
  "agencyId"  TEXT NOT NULL,
  "roleKey"   TEXT NOT NULL,
  "access"    JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgencyRoleOverride_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AgencyRoleOverride_agencyId_roleKey_key" ON "AgencyRoleOverride"("agencyId", "roleKey");

ALTER TABLE "AgencyRoleOverride"
  DROP CONSTRAINT IF EXISTS "AgencyRoleOverride_agencyId_fkey";
ALTER TABLE "AgencyRoleOverride"
  ADD CONSTRAINT "AgencyRoleOverride_agencyId_fkey"
  FOREIGN KEY ("agencyId") REFERENCES "Agency"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;


-- ───────────────────────────────────────────────────────────────
-- AgencySubPermissionOverride — per-zone sub-permission three-state toggle
-- value=true (explicit on), false (explicit off), or row absent (auto)
-- ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "AgencySubPermissionOverride" (
  "id"        TEXT NOT NULL,
  "agencyId"  TEXT NOT NULL,
  "roleKey"   TEXT NOT NULL,
  "subPermKey" TEXT NOT NULL,
  "value"     BOOLEAN NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgencySubPermissionOverride_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AgencySubPermissionOverride_unique_key"
  ON "AgencySubPermissionOverride"("agencyId", "roleKey", "subPermKey");
CREATE INDEX IF NOT EXISTS "AgencySubPermissionOverride_agencyId_idx"
  ON "AgencySubPermissionOverride"("agencyId");

ALTER TABLE "AgencySubPermissionOverride"
  DROP CONSTRAINT IF EXISTS "AgencySubPermissionOverride_agencyId_fkey";
ALTER TABLE "AgencySubPermissionOverride"
  ADD CONSTRAINT "AgencySubPermissionOverride_agencyId_fkey"
  FOREIGN KEY ("agencyId") REFERENCES "Agency"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;


-- ───────────────────────────────────────────────────────────────
-- AgencyInvitation — single-use tokens for inviting members
-- ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "AgencyInvitation" (
  "id"               TEXT NOT NULL,
  "agencyId"         TEXT NOT NULL,
  "tokenHash"        TEXT NOT NULL,
  "email"            TEXT,
  "roleKey"          TEXT NOT NULL,
  "displayName"      TEXT,
  "assignedCreators" JSONB,
  "commission"       JSONB,
  "invitedByUserId"  TEXT NOT NULL,
  "expiresAt"        TIMESTAMP(3) NOT NULL,
  "claimedAt"        TIMESTAMP(3),
  "claimedByUserId"  TEXT,
  "claimedMemberId"  TEXT,
  "revokedAt"        TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgencyInvitation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AgencyInvitation_tokenHash_key" ON "AgencyInvitation"("tokenHash");
CREATE INDEX IF NOT EXISTS "AgencyInvitation_agencyId_idx" ON "AgencyInvitation"("agencyId");
CREATE INDEX IF NOT EXISTS "AgencyInvitation_email_idx"    ON "AgencyInvitation"("email");
CREATE INDEX IF NOT EXISTS "AgencyInvitation_expiresAt_idx" ON "AgencyInvitation"("expiresAt");

ALTER TABLE "AgencyInvitation"
  DROP CONSTRAINT IF EXISTS "AgencyInvitation_agencyId_fkey";
ALTER TABLE "AgencyInvitation"
  ADD CONSTRAINT "AgencyInvitation_agencyId_fkey"
  FOREIGN KEY ("agencyId") REFERENCES "Agency"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgencyInvitation"
  DROP CONSTRAINT IF EXISTS "AgencyInvitation_invitedByUserId_fkey";
ALTER TABLE "AgencyInvitation"
  ADD CONSTRAINT "AgencyInvitation_invitedByUserId_fkey"
  FOREIGN KEY ("invitedByUserId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

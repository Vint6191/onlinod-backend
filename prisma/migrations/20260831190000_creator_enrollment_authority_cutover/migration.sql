-- Audit 14: creator enrollment / connection / reconnect authority cutover.
-- CreatorAccount status remains the business lifecycle. Connection authority is
-- explicit and independent from the canonical session status.

CREATE TYPE "CreatorConnectionState" AS ENUM (
  'ENROLLMENT_REQUIRED',
  'CONNECTING',
  'CONNECTED',
  'RECONNECT_REQUIRED',
  'RECONNECTING'
);

ALTER TYPE "CreatorSessionStateStatus" ADD VALUE IF NOT EXISTS 'REINITIALIZING';

ALTER TABLE "CreatorAccount"
  ADD COLUMN "enrollmentExpectedUsername" TEXT,
  ADD COLUMN "platformUsername" TEXT,
  ADD COLUMN "platformDisplayName" TEXT,
  ADD COLUMN "platformAvatarUrl" TEXT,
  ADD COLUMN "connectionState" "CreatorConnectionState" NOT NULL DEFAULT 'ENROLLMENT_REQUIRED',
  ADD COLUMN "connectionGeneration" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "connectionStartedAt" TIMESTAMP(3),
  ADD COLUMN "connectedSessionRevision" INTEGER;

ALTER TABLE "CreatorSessionState"
  ADD COLUMN "connectionGeneration" INTEGER NOT NULL DEFAULT 0;

-- Existing DRAFT rows retain their provisional username fence. Existing READY
-- rows become CONNECTED only when a portable ACTIVE canonical session actually
-- exists; otherwise they are explicitly reconnect-required.
UPDATE "CreatorAccount"
SET "enrollmentExpectedUsername" = lower("username")
WHERE "deletedAt" IS NULL
  AND "remoteId" IS NULL
  AND "username" IS NOT NULL;

UPDATE "CreatorAccount"
SET
  "platformUsername" = lower("username"),
  "platformDisplayName" = "displayName",
  "platformAvatarUrl" = "avatarUrl"
WHERE "deletedAt" IS NULL
  AND "remoteId" IS NOT NULL
  AND "username" IS NOT NULL;

UPDATE "CreatorAccount" c
SET
  "connectionState" = CASE
    WHEN c."status" = 'READY' AND s."status" = 'ACTIVE' AND s."portableReady" = TRUE
      THEN 'CONNECTED'::"CreatorConnectionState"
    WHEN c."status" = 'READY'
      THEN 'RECONNECT_REQUIRED'::"CreatorConnectionState"
    ELSE 'ENROLLMENT_REQUIRED'::"CreatorConnectionState"
  END,
  "connectionGeneration" = CASE WHEN c."status" = 'READY' THEN 1 ELSE 0 END,
  "connectedSessionRevision" = CASE
    WHEN c."status" = 'READY' AND s."status" = 'ACTIVE' AND s."portableReady" = TRUE
      THEN s."revision"
    ELSE NULL
  END
FROM "CreatorSessionState" s
WHERE s."creatorId" = c."id";

UPDATE "CreatorAccount"
SET
  "connectionState" = CASE
    WHEN "status" = 'READY' THEN 'RECONNECT_REQUIRED'::"CreatorConnectionState"
    ELSE 'ENROLLMENT_REQUIRED'::"CreatorConnectionState"
  END,
  "connectionGeneration" = CASE WHEN "status" = 'READY' THEN 1 ELSE 0 END,
  "connectedSessionRevision" = NULL
WHERE NOT EXISTS (
  SELECT 1 FROM "CreatorSessionState" s WHERE s."creatorId" = "CreatorAccount"."id"
);


-- Existing canonical sessions belong to the migrated creator connection generation.
UPDATE "CreatorSessionState" s
SET "connectionGeneration" = c."connectionGeneration"
FROM "CreatorAccount" c
WHERE c."id" = s."creatorId";

-- DB is the final identity authority. Soft-deleted rows intentionally do not
-- reserve an OF identity forever.
CREATE UNIQUE INDEX "CreatorAccount_active_remote_identity_unique"
  ON "CreatorAccount" ("agencyId", "remoteId")
  WHERE "deletedAt" IS NULL AND "remoteId" IS NOT NULL;

CREATE UNIQUE INDEX "CreatorAccount_active_username_identity_unique"
  ON "CreatorAccount" (
    "agencyId",
    lower(COALESCE("platformUsername", "enrollmentExpectedUsername", "username"))
  )
  WHERE "deletedAt" IS NULL
    AND COALESCE("platformUsername", "enrollmentExpectedUsername", "username") IS NOT NULL;

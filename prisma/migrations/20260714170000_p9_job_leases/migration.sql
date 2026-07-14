ALTER TABLE "JobInstance"
  ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT,
  ADD COLUMN IF NOT EXISTS "leaseTokenHash" TEXT,
  ADD COLUMN IF NOT EXISTS "leaseRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "workId" TEXT,
  ADD COLUMN IF NOT EXISTS "continuation" JSONB,
  ADD COLUMN IF NOT EXISTS "progress" JSONB,
  ADD COLUMN IF NOT EXISTS "lastProgressAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "JobInstance_agencyId_idempotencyKey_idx"
  ON "JobInstance"("agencyId", "idempotencyKey");

CREATE UNIQUE INDEX IF NOT EXISTS "JobInstance_idempotencyKey_key"
  ON "JobInstance"("idempotencyKey");

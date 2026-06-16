-- Message Library v20.2 trash retention and block-level soft delete.
ALTER TABLE "ContentCollection"
  ADD COLUMN IF NOT EXISTS "purgeAfter" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "trashedByUserId" TEXT;

ALTER TABLE "ContentBlock"
  ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "purgeAfter" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "trashedByUserId" TEXT;

CREATE INDEX IF NOT EXISTS "ContentCollection_purgeAfter_idx" ON "ContentCollection"("purgeAfter");
CREATE INDEX IF NOT EXISTS "ContentBlock_status_purgeAfter_idx" ON "ContentBlock"("status", "purgeAfter");

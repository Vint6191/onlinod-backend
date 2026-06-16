-- Message Library v20.1 server-store metadata.
-- Keeps script-level folder/enabled/stats while scripts are stored in
-- ContentCollection + ContentBlock for cross-device sharing.
ALTER TABLE "ContentCollection"
  ADD COLUMN IF NOT EXISTS "metadata" JSONB NOT NULL DEFAULT '{}';

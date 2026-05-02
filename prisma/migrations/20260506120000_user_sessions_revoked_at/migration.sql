ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "sessionsRevokedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "User_sessionsRevokedAt_idx" ON "User"("sessionsRevokedAt");

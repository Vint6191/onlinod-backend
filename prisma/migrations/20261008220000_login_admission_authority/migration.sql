-- Shared across replicas. Only hashed scope keys are stored; no password, raw email or IP.
CREATE TABLE "LoginAdmissionBucket" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "windowStartedAt" TIMESTAMPTZ(3) NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "attempts" INTEGER NOT NULL CHECK ("attempts" >= 0 AND "attempts" <= 10000)
);
CREATE INDEX "LoginAdmissionBucket_expiresAt_id_idx" ON "LoginAdmissionBucket" ("expiresAt", "id");

-- Phase 3 INT5.9A-15
-- Durable typed projection of lower-bound provider capacity debt. Canonical
-- work remains in Campaign/FanData rows; this singleton records what the
-- current physical gate + weighted fairness can actually prove about backlog.
CREATE TABLE IF NOT EXISTS "ProviderCapacityDebtState" (
  "id" TEXT NOT NULL,
  "sourceVersion" VARCHAR(120) NOT NULL,
  "sampledAt" TIMESTAMP(3) NOT NULL,
  "revision" BIGINT NOT NULL DEFAULT 0,
  "status" VARCHAR(32) NOT NULL DEFAULT 'UNKNOWN',
  "overloadReason" VARCHAR(500),
  "physicalStartsPerHour" DOUBLE PRECISION NOT NULL,
  "backgroundGuaranteedStartsPerHour" DOUBLE PRECISION NOT NULL,
  "campaignDirectoryGuaranteedStartsPerHour" DOUBLE PRECISION NOT NULL,
  "fanDataGuaranteedStartsPerHour" DOUBLE PRECISION NOT NULL,
  "campaignDirectoryDueCreators" INTEGER NOT NULL DEFAULT 0,
  "campaignDirectoryOverdueCreators" INTEGER NOT NULL DEFAULT 0,
  "campaignDirectoryRequiredCalls" BIGINT NOT NULL DEFAULT 0,
  "campaignDirectoryCapacityDebtCalls" BIGINT NOT NULL DEFAULT 0,
  "campaignDirectoryOldestDueAt" TIMESTAMP(3),
  "campaignDirectoryGuaranteedClearHours" DOUBLE PRECISION NOT NULL,
  "campaignDirectoryTargetHours" DOUBLE PRECISION NOT NULL,
  "fanDataUnsatisfiedDemands" BIGINT NOT NULL DEFAULT 0,
  "fanDataPendingJobs" INTEGER NOT NULL DEFAULT 0,
  "fanDataCapacityDebtCalls" BIGINT NOT NULL DEFAULT 0,
  "fanDataOldestRequestedAt" TIMESTAMP(3),
  "fanDataGuaranteedClearHours" DOUBLE PRECISION NOT NULL,
  "fanDataTargetHours" DOUBLE PRECISION NOT NULL,
  "providerLowerBoundRequiredCalls" BIGINT NOT NULL DEFAULT 0,
  "providerExclusiveClearHours" DOUBLE PRECISION NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderCapacityDebtState_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProviderCapacityDebtState_status_check" CHECK ("status" IN ('HEALTHY','PRESSURED','OVERLOADED','UNKNOWN'))
);

CREATE INDEX IF NOT EXISTS "ProviderCapacityDebtState_status_sampled_idx"
  ON "ProviderCapacityDebtState"("status", "sampledAt");

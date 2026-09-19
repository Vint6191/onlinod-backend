-- Phase 3 INT5.9A-16
-- Formalize the current provider-capacity topology and durable overload-control
-- projection. This migration is additive; it does not create a second provider
-- limiter and does not alter the existing of-global permit/waiter authority.

ALTER TABLE "ProviderCapacityDebtState"
  ADD COLUMN IF NOT EXISTS "topologyVersion" VARCHAR(120) NOT NULL DEFAULT 'phase3_provider_capacity_topology_v1_a16',
  ADD COLUMN IF NOT EXISTS "topologyId" VARCHAR(120) NOT NULL DEFAULT 'of-global',
  ADD COLUMN IF NOT EXISTS "topologyScope" VARCHAR(40) NOT NULL DEFAULT 'FLEET_GLOBAL',
  ADD COLUMN IF NOT EXISTS "topologyShardCount" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "topologyShardingAllowed" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "controlMode" VARCHAR(40) NOT NULL DEFAULT 'CONSERVATIVE',
  ADD COLUMN IF NOT EXISTS "controlReason" VARCHAR(500),
  ADD COLUMN IF NOT EXISTS "operatorActionRequired" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "campaignDirectoryAdmissionBudgetCalls" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "campaignDirectoryGuaranteedCallsPerSweep" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "ProviderCapacityDebtState"
  DROP CONSTRAINT IF EXISTS "ProviderCapacityDebtState_topology_v1_check";
ALTER TABLE "ProviderCapacityDebtState"
  ADD CONSTRAINT "ProviderCapacityDebtState_topology_v1_check"
  CHECK (
    "topologyId" = 'of-global'
    AND "topologyScope" = 'FLEET_GLOBAL'
    AND "topologyShardCount" = 1
    AND "topologyShardingAllowed" = FALSE
    AND "controlMode" IN ('NORMAL','OVERLOAD_PROTECTED','CONSERVATIVE')
    AND "campaignDirectoryAdmissionBudgetCalls" >= 1
    AND "campaignDirectoryGuaranteedCallsPerSweep" >= 1
  );

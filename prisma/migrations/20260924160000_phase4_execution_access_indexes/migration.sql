-- Populated deployments build these online in the npm prisma:migrate preflight.
CREATE INDEX IF NOT EXISTS "AutomationDelivery_fair_claim_idx" ON "AutomationDelivery"("agencyId","creatorId","claimedAt" DESC) WHERE "originKind"='AUTOMATION' AND "claimedAt" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "AutomationDelivery_fair_finish_idx" ON "AutomationDelivery"("agencyId","creatorId","finishedAt" DESC) WHERE "originKind"='AUTOMATION' AND "status"='COMPLETED' AND "finishedAt" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "AutomationDelivery_pending_creator_idx" ON "AutomationDelivery"("agencyId","creatorId","priority" DESC,"notBefore","createdAt","id") WHERE "originKind"='AUTOMATION' AND "status" IN ('QUEUED','RETRY_SCHEDULED','RECONCILE_REQUIRED');
CREATE INDEX IF NOT EXISTS "AutomationDelivery_expired_lease_idx" ON "AutomationDelivery"("agencyId","claimUntil","id") WHERE "status" IN ('CLAIMED','RUNNING','COMMITTING','RECONCILE_REQUIRED') AND "claimUntil" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "AutomationDelivery_stranded_idx" ON "AutomationDelivery"("agencyId","writeCommitAt","id") WHERE "status"='RECONCILE_REQUIRED' AND "claimUntil" IS NULL;
CREATE INDEX IF NOT EXISTS "CreatorAccount_live_catalog_idx" ON "CreatorAccount"("agencyId","id") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "TelegramDeliveryIntent_pending_billing_idx" ON "TelegramDeliveryIntent"("agencyId","creatorId","createdAt","id") WHERE "state" IN ('PLANNED','CLAIMED','FAILED_PRECOMMIT');

CREATE INDEX IF NOT EXISTS "TelegramDeliveryIntent_expired_commit_idx" ON "TelegramDeliveryIntent"("agencyId","commitStartedAt","id") WHERE "state"='COMMITTING';

-- Physical write pacing must include admitted writes of every eventual status.
-- These narrow indexes also support failed/unknown writes without scanning history.
CREATE INDEX "AutomationDelivery_pacing_commit_idx"
ON "AutomationDelivery" ("agencyId", "creatorId", "writeCommitAt" DESC)
WHERE "originKind" = 'AUTOMATION' AND "writeCommitAt" IS NOT NULL;

CREATE INDEX "AutomationDelivery_pacing_action_commit_idx"
ON "AutomationDelivery" ("agencyId", "creatorId", "actionType", "writeCommitAt" DESC)
WHERE "originKind" = 'AUTOMATION' AND "writeCommitAt" IS NOT NULL;

-- Control eligibility is evaluated before each bounded keyset page.
CREATE INDEX "AutomationDelivery_control_paused_idx"
ON "AutomationDelivery" ("agencyId", "id") INCLUDE ("creatorId", "moduleKey")
WHERE "originKind" = 'AUTOMATION' AND "status" = 'PAUSED';

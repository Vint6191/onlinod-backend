-- The derived financial-media owner uses the existing durable work authority.
-- Append its dispatch opportunity without changing any existing lane ordinal.
INSERT INTO "Phase2WorkGenerationAuthority"
 ("workClass","activeGeneration","projectionVersion",revision,"activatedAt","createdAt","updatedAt")
 VALUES ('MEDIA_FINANCIAL_PROJECTION','phase2_domain_work_v3_actual55','phase2_domain_work_v3_actual55',
  1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

INSERT INTO "MaintenanceAdmissionClassState"
 ("generation","laneName","ordinal","turnCount","admissionSequence")
 VALUES ('onlinod_maintenance_v1','mediaFinancialProjection',39,0,0);

-- An exhausted dialog gap may yield to a later independently observed loss.
-- Seek the latest durable loss cause without sorting a creator's old intents.
CREATE INDEX "CreatorRecoveryIntent_dialog_episode_idx"
 ON "CreatorRecoveryIntent"("creatorId","targetAt",id);

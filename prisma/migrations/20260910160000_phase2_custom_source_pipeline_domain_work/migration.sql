-- Phase 2 / A43 — Custom source pipeline execution ownership.
-- CUSTOM_SOURCE_PIPELINE is the durable readiness/lease authority; the Desktop
-- remains the only executor of Telegram download + OnlyFans/Vault external writes.

CREATE INDEX IF NOT EXISTS "CustomContentSubmission_source_history_keyset_idx"
  ON "CustomContentSubmission"("agencyId","pipelineDisposition","id")
  WHERE "pipelineDisposition" IN ('ACTIVE','SALVAGE');

-- Every live source lifecycle transition publishes the exact submission work key.
-- DELETE is lifecycle/cascade cleanup: no fresh source work is created from that edge;
-- linked order work is still invalidated so an old assignment can converge.
CREATE OR REPLACE FUNCTION "phase2_submission_domain_work_trigger"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    -- Submission rows have no direct delete command; DELETE is lifecycle/cascade cleanup.
    -- DomainWorkItem is agency-scoped and cascades with Agency, so do not create fresh
    -- work from an AFTER DELETE cascade edge.
    IF OLD."customOrderId" IS NOT NULL THEN
      PERFORM "phase2_publish_domain_work"(OLD."agencyId",'CUSTOM_COMMUNICATION','CustomOrder',OLD."customOrderId",OLD."creatorId",OLD."creatorId",OLD."telegramSourceAccountId",NULL,NULL,0,CURRENT_TIMESTAMP);
    END IF;
    RETURN OLD;
  END IF;

  PERFORM "phase2_publish_domain_work"(NEW."agencyId",'CUSTOM_SOURCE_PIPELINE','CustomContentSubmission',NEW."id",NEW."creatorId",NEW."creatorId",NEW."telegramSourceAccountId",NULL,NULL,0,CURRENT_TIMESTAMP);
  IF NEW."customOrderId" IS NOT NULL THEN
    PERFORM "phase2_publish_domain_work"(NEW."agencyId",'CUSTOM_COMMUNICATION','CustomOrder',NEW."customOrderId",NEW."creatorId",NEW."creatorId",NEW."telegramSourceAccountId",NULL,NULL,0,CURRENT_TIMESTAMP);
  END IF;

  IF TG_OP='UPDATE' AND OLD."customOrderId" IS NOT NULL AND
     (OLD."customOrderId" IS DISTINCT FROM NEW."customOrderId" OR OLD."agencyId" IS DISTINCT FROM NEW."agencyId") THEN
    PERFORM "phase2_publish_domain_work"(OLD."agencyId",'CUSTOM_COMMUNICATION','CustomOrder',OLD."customOrderId",OLD."creatorId",OLD."creatorId",OLD."telegramSourceAccountId",NULL,NULL,0,CURRENT_TIMESTAMP);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "CustomContentSubmission_phase2_domain_work" ON "CustomContentSubmission";
CREATE TRIGGER "CustomContentSubmission_phase2_domain_work"
AFTER INSERT OR DELETE OR UPDATE OF
  "customOrderId","bindingRevision","reviewDecisionRevision",
  "telegramSourceAccountId","telegramSourceUserId","telegramMessageIds","ofMediaIds",
  "pipelineDisposition","reviewStatus"
ON "CustomContentSubmission" FOR EACH ROW EXECUTE FUNCTION "phase2_submission_domain_work_trigger"();

-- Creator execution defaults/status are dependencies of both order communication
-- and standalone source work. Keep the producer transaction small: only bump one
-- dependency row + one fanout work item; enumeration happens outside this lock.
CREATE OR REPLACE FUNCTION "phase2_creator_binding_dependency_trigger"()
RETURNS TRIGGER AS $$
DECLARE v_revision BIGINT;
BEGIN
  IF TG_OP='UPDATE' AND NOT (
      OLD."telegramContact" IS DISTINCT FROM NEW."telegramContact" OR
      OLD."telegramUserId" IS DISTINCT FROM NEW."telegramUserId" OR
      OLD."telegramAccountId" IS DISTINCT FROM NEW."telegramAccountId" OR
      OLD."customsVaultFolderId" IS DISTINCT FROM NEW."customsVaultFolderId" OR
      OLD."status" IS DISTINCT FROM NEW."status" OR
      OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt") THEN RETURN NEW; END IF;
  v_revision := "phase2_bump_dependency"(NEW."agencyId",'CREATOR_BINDING',NEW."id");
  PERFORM "phase2_publish_domain_work"(NEW."agencyId",'DEPENDENCY_FANOUT','CreatorAccount',NEW."id",NEW."id",NEW."id",NEW."telegramAccountId",'CREATOR_BINDING',NEW."id",v_revision,CURRENT_TIMESTAMP);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "CreatorAccount_phase2_binding_dependency" ON "CreatorAccount";
CREATE TRIGGER "CreatorAccount_phase2_binding_dependency"
AFTER UPDATE OF "telegramContact","telegramUserId","telegramAccountId","customsVaultFolderId","status","deletedAt"
ON "CreatorAccount" FOR EACH ROW EXECUTE FUNCTION "phase2_creator_binding_dependency_trigger"();

-- Workspace relay recipient is an agency-wide execution default for unpinned
-- submissions. Publish one small fanout event rather than touching every submission
-- while the setting row is locked.
CREATE OR REPLACE FUNCTION "phase2_custom_pipeline_config_dependency_trigger"()
RETURNS TRIGGER AS $$
DECLARE
  v_agency TEXT;
  v_key TEXT;
  v_revision BIGINT;
BEGIN
  IF TG_OP='DELETE' THEN
    v_agency := OLD."agencyId";
    v_key := OLD."key";
  ELSE
    v_agency := NEW."agencyId";
    v_key := NEW."key";
    IF TG_OP='UPDATE' AND OLD."key" IS NOT DISTINCT FROM NEW."key" AND OLD."value" IS NOT DISTINCT FROM NEW."value" THEN RETURN NEW; END IF;
  END IF;
  IF TG_OP='UPDATE' AND OLD."key" = 'vaultUploadRecipient' AND NEW."key" <> 'vaultUploadRecipient' THEN
    v_key := OLD."key";
  END IF;
  IF v_key <> 'vaultUploadRecipient' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  v_revision := "phase2_bump_dependency"(v_agency,'CUSTOM_PIPELINE_CONFIG',v_agency);
  PERFORM "phase2_publish_domain_work"(v_agency,'DEPENDENCY_FANOUT','CustomPipelineConfig',v_agency,v_agency,NULL,NULL,'CUSTOM_PIPELINE_CONFIG',v_agency,v_revision,CURRENT_TIMESTAMP);
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "WorkspaceSetting_phase2_custom_pipeline_config" ON "WorkspaceSetting";
CREATE TRIGGER "WorkspaceSetting_phase2_custom_pipeline_config"
AFTER INSERT OR DELETE OR UPDATE OF "key","value"
ON "WorkspaceSetting" FOR EACH ROW EXECUTE FUNCTION "phase2_custom_pipeline_config_dependency_trigger"();

-- New agencies have no historical source submissions. Preserve every existing
-- family and add CUSTOM_SOURCE_PIPELINE as immediately complete only for a newly
-- created agency; existing agencies are seeded by the bounded v2 coverage lane.
CREATE OR REPLACE FUNCTION "phase2_new_agency_coverage_trigger"()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO "Phase2WorkCoverage"(
    "id","agencyId","family","generation","active","enumerationState",
    "unresolvedCount","sourceWatermark","activatedAt","completedAt","createdAt","updatedAt"
  ) VALUES
    ('p2cov_' || md5(NEW."id" || E'\x1f' || 'PROVIDER_OPERATIONAL' || E'\x1f' || 'phase2_provider_operational_coverage_v1'), NEW."id",'PROVIDER_OPERATIONAL','phase2_provider_operational_coverage_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\x1f' || 'CUSTOM_EXTERNAL_PROJECTION' || E'\x1f' || 'phase2_custom_external_coverage_v1'), NEW."id",'CUSTOM_EXTERNAL_PROJECTION','phase2_custom_external_coverage_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\x1f' || 'CUSTOM_SOURCE_PIPELINE' || E'\x1f' || 'phase2_custom_source_pipeline_coverage_v1'), NEW."id",'CUSTOM_SOURCE_PIPELINE','phase2_custom_source_pipeline_coverage_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\x1f' || 'TEAM_ACTIVITY_CONTRIBUTION' || E'\x1f' || 'phase2_team_activity_contribution_v2'), NEW."id",'TEAM_ACTIVITY_CONTRIBUTION','phase2_team_activity_contribution_v2',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\x1f' || 'TEAM_RESPONSE_RANGE_REPAIR' || E'\x1f' || 'phase2_team_response_range_v2'), NEW."id",'TEAM_RESPONSE_RANGE_REPAIR','phase2_team_response_range_v2',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\x1f' || 'TEAM_DIALOG_PROJECTION' || E'\x1f' || 'phase2_team_dialog_projection_v1'), NEW."id",'TEAM_DIALOG_PROJECTION','phase2_team_dialog_projection_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\x1f' || 'TEAM_MONEY_ROOT_CLASSIFICATION' || E'\x1f' || 'phase2_team_money_root_classification_v1'), NEW."id",'TEAM_MONEY_ROOT_CLASSIFICATION','phase2_team_money_root_classification_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\x1f' || 'TEAM_MONEY_RECONCILIATION' || E'\x1f' || 'phase2_team_money_reconciliation_v1'), NEW."id",'TEAM_MONEY_RECONCILIATION','phase2_team_money_reconciliation_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\x1f' || 'TEAM_READ_SUMMARY' || E'\x1f' || 'phase2_team_money_read_summary_v1'), NEW."id",'TEAM_READ_SUMMARY','phase2_team_money_read_summary_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\x1f' || 'TELEGRAM_CONFIRMED_PROJECTION' || E'\x1f' || 'phase2_telegram_confirmed_projection_v1'), NEW."id",'TELEGRAM_CONFIRMED_PROJECTION','phase2_telegram_confirmed_projection_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\x1f' || 'TELEGRAM_INBOUND_PROJECTION' || E'\x1f' || 'phase2_telegram_inbound_projection_v1'), NEW."id",'TELEGRAM_INBOUND_PROJECTION','phase2_telegram_inbound_projection_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
  ON CONFLICT ("agencyId","family","generation") DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

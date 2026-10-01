BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

-- Same ordering as the sole projection publisher: advisory owner, then state.
-- An in-flight old owner finishes first; an old replica's next batch rejects
-- the new catalog before consuming any source keys or publishing a snapshot.
SELECT pg_advisory_xact_lock(hashtext('phase6-capacity-projection-v1'));
DO $$
DECLARE
  current_state "ProviderCapacityProjectionState"%ROWTYPE;
  expected_keys TEXT[];
  legacy_keys TEXT[];
  stored_keys TEXT[];
BEGIN
  SELECT ARRAY_AGG(key ORDER BY key) INTO expected_keys FROM unnest(ARRAY[
    'fetch_earnings','fetch_campaigns','fan_data_point_refresh',
    'catchup_notifications_scan','financial_transactions_scan',
    'dialog_intelligence_scan','vault_unsorted_scan','subscriber_directory_scan',
    'likes_content_discovery','sfs_target_discovery','sfs_target_scan'
  ]::text[]) AS keys(key);
  SELECT ARRAY_AGG(key ORDER BY key) INTO legacy_keys
    FROM unnest(expected_keys || ARRAY['traffic_sources_scan']) AS keys(key);
  SELECT * INTO current_state FROM "ProviderCapacityProjectionState"
    WHERE "id"='of-global-capacity-v1' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CAPACITY_PROJECTION_STATE_MISSING'; END IF;
  IF current_state."generation" <> 'phase6_capacity_incremental_v1' THEN
    RAISE EXCEPTION 'CAPACITY_PROJECTION_GENERATION_MISMATCH';
  END IF;
  SELECT ARRAY_AGG(key ORDER BY key) INTO stored_keys FROM unnest(current_state."jobKeys") AS keys(key);
  IF stored_keys IS NOT DISTINCT FROM expected_keys THEN RETURN; END IF;
  IF stored_keys IS DISTINCT FROM legacy_keys THEN
    RAISE EXCEPTION 'CAPACITY_CATALOG_TRANSITION_SOURCE_MISMATCH';
  END IF;

  -- This transition only removes one bucket from the fixed-catalog read.
  -- Directory/FanData/remaining job contribution semantics are unchanged.
  -- Preserve all source cursors, incomplete-bootstrap flags and dirty work.
  -- The existing Traffic RETIRE lane cancels old jobs in bounded transactions;
  -- their canonical triggers retract retired contributions through dirty repair.
  -- No canonical scan, destructive cleanup or fleet-wide cursor reset here.
  UPDATE "ProviderCapacityProjectionState" SET "jobKeys"=expected_keys,
    "revision"="revision"+1,"sampledAt"=clock_timestamp(),"updatedAt"=clock_timestamp()
    WHERE "id"=current_state."id" RETURNING * INTO current_state;

  -- Invalidate the cached result in the SAME commit, through its existing
  -- publication fence. The next bounded runtime batch derives a current result.
  PERFORM set_config('onlinod.capacity_projection_revision',current_state."revision"::text,true);
  UPDATE "ProviderCapacityDebtState" SET
    "sourceVersion"='phase6_provider_capacity_debt_v1',
    "revision"="revision"+1,"projectionRevision"=current_state."revision",
    "sampledAt"=current_state."sampledAt","updatedAt"=current_state."sampledAt",
    "status"='UNKNOWN',"overloadReason"='CAPACITY_CATALOG_TRANSITION',
    "projectionCoverageStatus"='PARTIAL',"futureDebtCoverageStatus"='PARTIAL',
    "futureDebtCoverageReason"='CAPACITY_CATALOG_TRANSITION',
    "controlMode"='CONSERVATIVE',"controlReason"='CAPACITY_STATUS_UNKNOWN',
    "operatorActionRequired"=false,
    "campaignDirectoryAdmissionBudgetCalls"="campaignDirectoryGuaranteedCallsPerSweep"
    WHERE "id"=current_state."id";
END $$;
COMMIT;

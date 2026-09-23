"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const source = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

test("A34 scheduler outcome contract rejects malformed/nested failures without losing created work", async () => {
  const scheduler = require("./job-scheduler");
  const { SCHEDULER_OUTCOME, normalizeSchedulerDecision, executeSchedulerConsumer } = scheduler._test;

  const malformed = normalizeSchedulerDecision(null);
  assert.equal(malformed.outcome, SCHEDULER_OUTCOME.DEGRADED);
  assert.equal(malformed.reason, "malformed_planner_result");

  const nested = normalizeSchedulerDecision({
    ok: true,
    created: true,
    discovery: { ok: false, created: false, reason: "discovery_failed" },
    planning: { ok: true, created: true },
  });
  assert.equal(nested.outcome, SCHEDULER_OUTCOME.DEGRADED);
  assert.equal(nested.created, true);
  assert.equal(nested.failures[0].path, "result.discovery");

  const calls = [];
  const created = [];
  const skipped = [];
  const degraded = [];
  const outcomes = [];
  await executeSchedulerConsumer({
    work: "first", created, skipped, degraded, outcomes,
    execute: async () => { calls.push("first"); throw Object.assign(new Error("boom"), { code: "first_failed" }); },
  });
  await executeSchedulerConsumer({
    work: "second", created, skipped, degraded, outcomes,
    execute: async () => { calls.push("second"); return { ok: true, created: true, reason: "planned" }; },
  });
  assert.deepEqual(calls, ["first", "second"]);
  assert.equal(degraded.length, 1);
  assert.equal(degraded[0].reason, "first_failed");
  assert.deepEqual(created, ["second"]);
});

test("A34 Likes resolves discovery and planning as one composite authority", () => {
  const { resolveAutomaticLikesResult } = require("./likes-service")._test;
  const discoveryFailed = resolveAutomaticLikesResult({
    discovery: { ok: false, created: true, reason: "discovery_failed" },
    planning: { ok: true, created: true },
  });
  assert.equal(discoveryFailed.ok, false);
  assert.equal(discoveryFailed.created, true);
  assert.equal(discoveryFailed.reason, "discovery_failed");

  const malformed = resolveAutomaticLikesResult({
    discovery: { created: false },
    planning: { ok: true, created: false },
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.reason, "likes_substep_malformed");
});

test("A34 recurring creator planning is durable, bounded, fair and timer-visible", () => {
  const scheduler = source("src/services/job-scheduler.js");
  const domain = source("src/services/domain-work-authority-service.js");
  const subscriber = source("src/services/subscriber-directory-service.js");
  const start = scheduler.indexOf("async function runRecurringCreatorWork");
  const end = scheduler.indexOf("async function runPhase2MaintenancePump", start);
  const recurring = scheduler.slice(start, end);
  assert.match(domain, /CREATOR_RECURRING_PLANNING/);
  assert.match(recurring, /claimDomainWorkBatch\([\s\S]*CREATOR_RECURRING_PLANNING/);
  assert.match(recurring, /perAgencyQuantum/);
  assert.match(recurring, /perPartitionQuantum:\s*1/);
  assert.match(recurring, /Math\.min\(100/);
  assert.match(recurring, /heartbeatDomainWorkClaim/);
  assert.match(recurring, /failDomainWorkClaim/);
  assert.match(recurring, /yieldDomainWorkClaim/);
  assert.doesNotMatch(recurring, /creatorAccount\.findMany/);
  assert.match(scheduler, /ensureSubscriberScanDue\(\{\s*db,/);
  assert.match(subscriber, /async function ensureSubscriberScanDue\(\{ db = prisma,/);
  assert.match(subscriber, /async function scheduleSubscriberScan\(\{\s*db = prisma,/);
  assert.match(scheduler, /\["creatorRecurringPlanning", \(\) => runRecurringCreatorWork/);
  assert.match(scheduler, /runRecurringSweep\(\)[\s\S]*\.then\(handleRecurringSweepTickResult\)/);
  assert.match(scheduler, /sweep resolved degraded/);
  assert.match(scheduler, /getRecurringSchedulerHealthSnapshot/);
});

test("A35 recurring work closes physical Creator deletion without an absent-identity UPDATE", () => {
  const migration = source("prisma/migrations/20260922170000_phase3_a35_creator_recurring_delete_closure_v1/migration.sql");
  const fixture = source("scripts/audit/phase3-postgres-proof-fixture-authority.js");
  const deleteStart = migration.indexOf("IF TG_OP='DELETE' THEN");
  const deleteEnd = migration.indexOf("END IF;", deleteStart);
  const deleteBranch = migration.slice(deleteStart, deleteEnd);

  assert.ok(deleteStart >= 0 && deleteEnd > deleteStart);
  assert.match(deleteBranch, /DELETE FROM "DomainWorkItem"/);
  assert.match(deleteBranch, /"workClass"=v_work_class/);
  assert.match(deleteBranch, /"objectType"='CreatorAccount'/);
  assert.match(deleteBranch, /"objectId"=OLD\."id"/);
  assert.doesNotMatch(deleteBranch, /UPDATE "DomainWorkItem"/);
  assert.match(migration, /IF v_old_eligible AND NOT \(v_new_eligible AND v_same_identity\)[\s\S]*UPDATE "DomainWorkItem"/);

  const drainCall = fixture.indexOf("drainPhase3PostgresAgencyDomainWork(tx, id)", fixture.indexOf("async function cleanupPhase3PostgresAgencyFixture"));
  const creatorDelete = fixture.indexOf("tx.creatorAccount.deleteMany", drainCall);
  const agencyDelete = fixture.indexOf("tx.agency.deleteMany", creatorDelete);
  assert.ok(drainCall >= 0 && creatorDelete > drainCall && agencyDelete > creatorDelete,
    "fixture teardown must drain DomainWork, then Creators, then Agency");
});

test("A36 DomainWork admission is bounded on both Agency and creator axes without locator authority", () => {
  const schema = source("prisma/schema.prisma");
  const domain = source("src/services/domain-work-authority-service.js");
  const migration = source("prisma/migrations/20260922183000_phase3_a36_domain_work_claim_shard_closure_v1/migration.sql");
  const lockClosure = source("prisma/migrations/20260922201500_phase3_a36_claim_generation_lock_closure_v2/migration.sql");
  const rollout = source("scripts/database/phase3-domain-work-claim-online-rollout.js");
  const scheduler = source("src/services/job-scheduler.js");
  const destructive = source("src/services/phase2-destructive-delete-authority-service.js");
  const release = source("src/services/phase2-release-compatibility-authority-service.js");
  const customSubmissions = source("src/services/custom-content-submissions-service.js");
  const permissions = source("src/middleware/automation-permissions.js");
  const packageJson = source("package.json");
  const postgresProof = source("scripts/audit/phase3-a20-postgres-proof.js");
  const physical = source("src/services/phase3-a34-source-scale-closure.integration.test.js");
  const broadStart = domain.indexOf('if (rawCapable && typeof db?.$transaction === "function")');
  const broadEnd = domain.indexOf("// Adapter/unit fallback", broadStart);
  const broad = domain.slice(broadStart, broadEnd);
  const scopedReserveStart = domain.indexOf("async function reserveMemberScopeCreatorProbe");
  const scopedReserveEnd = domain.indexOf("async function claimDomainWorkBatch", scopedReserveStart);
  const scopedReserve = domain.slice(scopedReserveStart, scopedReserveEnd);
  const sourceClaimStart = customSubmissions.indexOf("async function claimCustomContentSubmissionUploadWork(");
  const sourceClaimEnd = customSubmissions.indexOf("async function heartbeatCustomContentSubmissionSourceWork", sourceClaimStart);
  const sourceClaim = customSubmissions.slice(sourceClaimStart, sourceClaimEnd);
  const writerQueueStart = migration.indexOf('CREATE OR REPLACE FUNCTION "phase3_queue_domain_work_claim_locator_insert"');
  const deferredFlushStart = migration.indexOf('CREATE OR REPLACE FUNCTION "phase3_flush_domain_work_claim_locator_mutations"');
  const triggerInstallStart = migration.indexOf('DROP TRIGGER IF EXISTS "trg_phase3_domain_work_claim_locator_mutation_flush"');
  const writerQueue = migration.slice(writerQueueStart, deferredFlushStart);
  const deferredFlush = migration.slice(deferredFlushStart, triggerInstallStart);
  const partitionReconcileStart = migration.indexOf('CREATE OR REPLACE FUNCTION "phase3_reconcile_domain_work_claim_partition"');
  const partitionReconcileEnd = migration.indexOf('CREATE OR REPLACE FUNCTION "phase3_reconcile_domain_work_claim_shard"', partitionReconcileStart);
  const partitionReconcile = migration.slice(partitionReconcileStart, partitionReconcileEnd);

  assert.match(schema, /model DomainWorkClaimAgencyState[\s\S]*nextDispatchAt\s+DateTime[\s\S]*revision\s+BigInt/);
  assert.match(schema, /model DomainWorkClaimShardState[\s\S]*claimShard\s+Int[\s\S]*nextDispatchAt\s+DateTime/);
  assert.match(schema, /model DomainWorkClaimLocatorMutationBatch[\s\S]*txId\s+BigInt\s+@id/);
  assert.match(schema, /model DomainWorkClaimLocatorMutationIntent[\s\S]*txId\s+BigInt[\s\S]*partitionKey\s+String/);
  assert.match(schema, /model DomainWorkClaimTopologyState[\s\S]*activationState\s+String[\s\S]*cursorAgencyId\s+String\?[\s\S]*cursorActiveGeneration\s+String\?[\s\S]*cursorWorkId\s+String\?[\s\S]*backfilledPartitions\s+BigInt/);
  assert.match(schema, /model DomainWorkClaimTopologyState[\s\S]*partitionsBackfilledAt\s+DateTime\?[\s\S]*cursorMemberId\s+String\?[\s\S]*backfilledMembers\s+BigInt[\s\S]*membersBackfilledAt\s+DateTime\?/);
  assert.match(schema, /model AgencyMemberCreatorAccessCurrent[\s\S]*memberId\s+String[\s\S]*creatorId\s+String[\s\S]*claimShard\s+Int/);
  assert.match(schema, /model DomainWorkMemberScopeShardState[\s\S]*accessEpoch\s+Int[\s\S]*cursorCreatorId\s+String\?/);
  assert.match(schema, /model Phase2WorkBroadClaimPartitionState[\s\S]*nextClaimableAt\s+DateTime\?[\s\S]*revision\s+BigInt/);
  assert.match(domain, /DOMAIN_WORK_CLAIM_SHARD_COUNT = 128/);
  assert.match(broad, /DomainWorkClaimAgencyState/);
  assert.match(broad, /DomainWorkClaimShardState/);
  assert.match(broad, /Phase2WorkBroadClaimPartitionState/);
  assert.match(broad, /phase3_domain_work_claimable_at/);
  assert.match(broad, /FOR UPDATE OF d SKIP LOCKED/);
  assert.equal((broad.match(/FOR UPDATE OF [as] SKIP LOCKED/g) || []).length, 2,
    "Agency and shard reservations must both stay non-blocking");
  assert.doesNotMatch(broad, /reservationSql\(false\)/,
    "locator contention must fall through to indexed physical truth, never a blocking retry");
  assert.match(broad, /phase3_reconcile_domain_work_claim_partition[\s\S]*phase3_reconcile_domain_work_claim_shard[\s\S]*phase3_reconcile_domain_work_claim_agency/);
  assert.doesNotMatch(broad, /SELECT f\."agencyId"[\s\S]*EXISTS \([\s\S]*DomainWorkItem/);
  assert.doesNotMatch(broad, /DomainWorkReadyAgency|DomainWorkReadyPartition|Phase2WorkFamilyState/);
  assert.doesNotMatch(broad, /timeout:\s*[1-9]/);

  assert.match(migration, /% 128/);
  assert.match(migration, /Agency locators O\(A\)[\s\S]*shard locators O\(A \* min\(128,C\)\)[\s\S]*never enumerates A, C, A\*C, or lifetime DONE history/);
  assert.match(migration, /DomainWorkClaimAgencyState_dispatch_idx/);
  assert.match(migration, /DomainWorkClaimShardState_dispatch_idx/);
  assert.match(migration, /DomainWorkItem_claimable_global_a36_idx/);
  assert.match(migration, /DomainWorkItem_claimable_agency_shard_a36_idx/);
  assert.match(migration, /DomainWorkItem_claimable_creator_a36_idx/);
  assert.match(migration, /DomainWorkItem_current_activation_a36_idx/);
  assert.match(migration, /AgencyMember_current_activation_a36_idx/);
  assert.match(migration, /claimability writes[\s\S]*lower-only/);
  assert.match(migration, /v_new_due IS NOT NULL[\s\S]*v_new_due < v_old_due/);
  assert.match(broad, /Math\.min\(384, take \+ DOMAIN_WORK_CLAIM_SHARD_COUNT\)/);
  assert.match(broad, /partitionSelectionCap = Math\.min\(256,/);
  assert.match(domain, /DomainWorkClaimTopologyState|domainWorkClaimTopologyState/);
  assert.match(domain, /domain_work_claim_topology_building/);
  assert.match(domain, /DOMAIN_WORK_MEMBER_SCOPE_SHARD_PROBE = 32/);
  assert.match(domain, /DOMAIN_WORK_MEMBER_SCOPE_CREATOR_PROBE = 16/);
  assert.match(scopedReserve, /DomainWorkMemberScopeShardState/);
  assert.match(scopedReserve, /AgencyMemberCreatorAccessCurrent/);
  assert.match(scopedReserve, /DomainWorkClaimShardState/);
  assert.match(scopedReserve, /JOIN "CreatorAccount" live_creator[\s\S]*live_creator\."deletedAt" IS NULL/);
  assert.match(scopedReserve, /FOR UPDATE OF s SKIP LOCKED/);
  assert.match(scopedReserve, /LIMIT \$7[\s\S]*LIMIT \$8/);
  assert.match(domain, /FOR SHARE OF m/);
  assert.match(domain, /authorized_creators[\s\S]*AgencyMemberCreatorAccessCurrent/);
  assert.match(domain, /authorized_creators[\s\S]*JOIN "CreatorAccount" live_creator[\s\S]*live_creator\."deletedAt" IS NULL/);
  assert.match(domain, /d\."creatorId"=c\."creatorId"[\s\S]*phase3_domain_work_claimable_at[\s\S]*FOR UPDATE OF d SKIP LOCKED/);
  assert.match(domain, /effectiveAgencyId = memberAuthority\?\.agencyId \|\| clean\(agencyId, 180\)/);
  assert.match(domain, /let selectedAgency = effectiveAgencyId/);
  assert.ok(writerQueueStart >= 0 && deferredFlushStart > writerQueueStart && triggerInstallStart > deferredFlushStart);
  assert.match(writerQueue, /DomainWorkClaimLocatorMutationBatch/);
  assert.match(writerQueue, /DomainWorkClaimLocatorMutationIntent/);
  assert.match(writerQueue, /phase3_queue_domain_work_claim_locator_update/);
  assert.match(writerQueue, /phase3_queue_domain_work_claim_locator_delete/);
  assert.match(writerQueue, /leaseUntil" IS DISTINCT FROM n\."leaseUntil/);
  assert.equal((writerQueue.match(/"isOutstanding"=TRUE/g) || []).length, 3,
    "insert/update/delete staging must exclude lifetime history and superseded generations");
  assert.doesNotMatch(writerQueue, /INSERT INTO "DomainWorkClaimShardState"|INSERT INTO "DomainWorkClaimAgencyState"/);
  assert.match(migration, /CREATE CONSTRAINT TRIGGER "trg_phase3_domain_work_claim_locator_mutation_flush"[\s\S]*DEFERRABLE INITIALLY DEFERRED/);
  assert.match(lockClosure, /DROP TRIGGER IF EXISTS "trg_phase2_domain_work_current_partition" ON "DomainWorkItem"/);
  assert.match(lockClosure, /DROP FUNCTION IF EXISTS "phase2_track_domain_work_current_partition"\(\)/);
  assert.match(rollout, /retired row-level partition writer is still reachable/);
  assert.ok(
    deferredFlush.indexOf('phase3_reconcile_domain_work_claim_partition')
      < deferredFlush.indexOf('phase3_reconcile_domain_work_claim_shard')
      && deferredFlush.indexOf('phase3_reconcile_domain_work_claim_shard')
        < deferredFlush.indexOf('phase3_reconcile_domain_work_claim_agency'),
    "deferred writer flush must reconcile partitions, then shards, then Agencies",
  );
  assert.match(deferredFlush, /Phase2WorkGenerationAuthority[\s\S]*ORDER BY i\."agencyId",i\."workClass",i\."partitionKey"/);
  assert.match(migration, /p\."revision"=v_revision/);
  assert.match(migration, /s\."revision"=v_revision/);
  assert.match(migration, /a\."revision"=v_revision/);
  assert.match(partitionReconcile, /SELECT EXISTS \([\s\S]*LIMIT 1[\s\S]*v_count := 1/);
  assert.match(partitionReconcile, /state" IN \('READY','CLAIMED'\)[\s\S]*ORDER BY "phase3_domain_work_claimable_at"[\s\S]*LIMIT 1/);
  assert.doesNotMatch(partitionReconcile, /COUNT\s*\(|MIN\s*\(/i,
    "locator repair must not scan an arbitrarily large current partition");
  assert.match(migration, /v_old_membership := OLD\."isOutstanding" IS TRUE[\s\S]*v_old_current_generation=OLD\."activeGeneration"/);
  assert.doesNotMatch(migration, /DomainWorkReadyAgency|DomainWorkReadyPartition/);
  assert.doesNotMatch(migration, /LOCK TABLE/);
  assert.doesNotMatch(migration, /DELETE FROM "Phase2WorkBroadClaimPartitionState";/);
  assert.match(migration, /populated DomainWorkItem requires online index preflight/);
  assert.match(migration, /DomainWorkClaimTopologyState[\s\S]*THEN 'BUILDING' ELSE 'ACTIVE'/);
  assert.match(migration, /AgencyMember_assignedCreators_cardinality_check[\s\S]*<= 10000/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "AgencyMemberCreatorAccessCurrent"/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "DomainWorkMemberScopeShardState"/);
  assert.match(migration, /phase3_fence_agency_member_access_epoch[\s\S]*NEW\."accessEpoch" := OLD\."accessEpoch" \+ 1/);
  assert.match(migration, /phase3_refresh_member_creator_scope[\s\S]*phase2_scope_creator_ids[\s\S]*phase3_domain_work_claim_shard/);
  const scopeRefreshStart = migration.indexOf('CREATE OR REPLACE FUNCTION "phase3_refresh_member_creator_scope"');
  const scopeRefreshEnd = migration.indexOf('CREATE OR REPLACE FUNCTION "phase3_refresh_member_creator_scope_trigger"', scopeRefreshStart);
  assert.doesNotMatch(migration.slice(scopeRefreshStart, scopeRefreshEnd), /JOIN "CreatorAccount"/,
    "normalized grants must not require creator-lifecycle fan-out rebuilds");
  assert.match(migration, /AgencyMember_phase3_scope_projection_insert/);
  assert.match(migration, /AgencyMember_phase3_scope_projection_update/);
  assert.match(migration, /AgencyMember_phase3_scope_projection_delete/);
  assert.match(migration, /phase3_fence_member_creator_access_during_creator_delete[\s\S]*FOR KEY SHARE NOWAIT[\s\S]*DESTRUCTIVE_CREATOR_CLEANUP/);
  assert.match(migration, /FanObservationReadLease[\s\S]*FanObservationToken[\s\S]*OfProviderRequestGateWaiter[\s\S]*phase2_direct_creator_insert_fence/);
  assert.match(migration, /phase2_destructive_agency_work_id[\s\S]*phase2_destructive_agency_owner_token[\s\S]*"leaseUntil">clock_timestamp/);
  assert.match(destructive, /await run\("AgencyMemberCreatorAccessCurrent"[\s\S]*await run\("FanObservationReadLease"[\s\S]*await run\("FanObservationToken"[\s\S]*await run\("OfProviderRequestGateWaiter"/);
  assert.match(destructive, /"DomainWorkMemberScopeShardState"[\s\S]*"AgencyMemberCreatorAccessCurrent"/);
  assert.match(migration, /phase3_invalidate_domain_work_claim_generation[\s\S]*"activationState"='BUILDING'[\s\S]*"cursorWorkId"=NULL[\s\S]*"partitionsBackfilledAt"=NULL/);
  assert.match(migration, /Phase2WorkGenerationAuthority_phase3_claim_invalidate[\s\S]*AFTER UPDATE OF "activeGeneration"/);

  const dependencyBumpStart = migration.indexOf('CREATE OR REPLACE FUNCTION "phase2_bump_dependency"');
  const dependencyWakeStart = migration.indexOf('CREATE OR REPLACE FUNCTION "phase3_wake_domain_dependency_batch"');
  const dependencyWakeEnd = migration.indexOf("-- Scoped access is a control-plane payload", dependencyWakeStart);
  const dependencyBump = migration.slice(dependencyBumpStart, dependencyWakeStart);
  const dependencyWake = migration.slice(dependencyWakeStart, dependencyWakeEnd);
  assert.match(domain, /DEPENDENCY_WAKE:\s*"DEPENDENCY_WAKE"/);
  assert.match(domain, /async function wakeDomainDependencyBatch/);
  assert.doesNotMatch(scheduler, /async function wakeDomainDependencyBatch/,
    "scheduler must orchestrate dependency wake, not become a second DomainWork writer");
  assert.match(dependencyBump, /'DEPENDENCY_WAKE','DomainDependency'/);
  assert.doesNotMatch(dependencyBump, /UPDATE\s+"DomainWorkItem"/i,
    "dependency producer transaction must not enumerate blocked work");
  assert.match(dependencyWake, /LIMIT v_limit[\s\S]*FOR UPDATE OF d SKIP LOCKED/);
  assert.match(dependencyWake, /SELECT EXISTS\([\s\S]*v_remaining/);
  assert.match(dependencyWake, /"dependencyRevision" < p_revision/);
  assert.match(rollout, /DomainWorkItem_blocked_dependency_partial_idx/);
  const adapterBumpStart = domain.indexOf("async function bumpDomainDependency");
  const adapterBumpEnd = domain.indexOf("async function currentDependencyRevision", adapterBumpStart);
  const adapterBump = domain.slice(adapterBumpStart, adapterBumpEnd);
  assert.match(adapterBump, /workClass:\s*WORK_CLASS\.DEPENDENCY_WAKE/);
  assert.doesNotMatch(adapterBump, /domainWorkItem\.updateMany/);
  const wakeWorkerStart = scheduler.indexOf("async function maybeRunPhase2DependencyWake");
  const wakeWorkerEnd = scheduler.indexOf("async function listDependencyFanoutOrders", wakeWorkerStart);
  const wakeWorker = scheduler.slice(wakeWorkerStart, wakeWorkerEnd);
  const wakeAuthorityStart = domain.indexOf("async function runDomainDependencyWakeSweep");
  const wakeAuthorityEnd = domain.indexOf("async function currentDependencyRevision", wakeAuthorityStart);
  const wakeAuthority = domain.slice(wakeAuthorityStart, wakeAuthorityEnd);
  assert.match(wakeWorker, /return runDomainDependencyWakeSweep\(\{ db, now, claimLimit: 20, wakeLimit: 100 \}\)/);
  assert.match(wakeAuthority, /workClass:\s*WORK_CLASS\.DEPENDENCY_WAKE/);
  assert.match(wakeAuthority, /wakeDomainDependencyBatch\(/);
  assert.match(wakeAuthority, /batch\.remaining[\s\S]*yieldDomainWorkClaim/);
  assert.match(scheduler, /const dependencyWake = await maybeRunPhase2DependencyWake/);

  assert.match(release, /DOMAIN_WORK_EXECUTOR_GENERATION = "phase3_domain_executor_v5_a36_claim_topology"/);
  assert.match(release, /DOMAIN_WORK_PRE_A36_EXECUTOR_GENERATION = "phase2_domain_executor_v4_actual56_postcut"/);
  assert.match(release, /authorizeDomainWorkDependencyWakeBridge[\s\S]*DomainWorkClaimTopologyState[\s\S]*FOR SHARE[\s\S]*Phase2ReleaseCompatibilityAuthority[\s\S]*FOR SHARE/);
  assert.match(release, /authorizeDomainWorkExecutor[\s\S]*DomainWorkClaimTopologyState[\s\S]*FOR SHARE[\s\S]*activationState \|\| ""\)\.toUpperCase\(\) !== "ACTIVE"/);
  assert.match(release, /releaseGeneration === DOMAIN_WORK_PRE_A36_EXECUTOR_GENERATION[\s\S]*releaseGeneration === DOMAIN_WORK_EXECUTOR_GENERATION/);
  assert.match(domain, /topology\?\.activationState === "BUILDING"[\s\S]*klass === WORK_CLASS\.DEPENDENCY_WAKE/);
  assert.match(rollout, /DOMAIN_WORK_EXECUTOR_GENERATION = "phase3_domain_executor_v5_a36_claim_topology"/);
  assert.match(rollout, /runBuildingDependencyWakeUnit[\s\S]*runDomainDependencyWakeSweep/);
  assert.match(rollout, /await maintainDependencyWake\(\);[\s\S]*backfillBatch[\s\S]*await maintainDependencyWake\(\);[\s\S]*backfillMemberBatch[\s\S]*await maintainDependencyWake\(\);/);
  const activationFenceStart = rollout.indexOf("async function activateTopologyExecutorFence");
  const activationFenceEnd = rollout.indexOf("async function activateTopology", activationFenceStart + 1);
  const activationFence = rollout.slice(activationFenceStart, activationFenceEnd);
  assert.match(activationFence, /Phase2ReleaseCompatibilityAuthority/);
  assert.match(activationFence, /requiredGeneration/);
  assert.match(activationFence, /DomainWorkClaimTopologyState/);
  assert.match(activationFence, /activationState"='ACTIVE'/);
  assert.match(activationFence, /db\.\$transaction/);

  assert.equal((rollout.match(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/g) || []).length, 7);
  const partitionSelectorStart = rollout.indexOf("async function selectBackfillCandidates");
  const partitionSelectorEnd = rollout.indexOf("async function lockBackfillAgencyLifecycles", partitionSelectorStart);
  const partitionSelector = rollout.slice(partitionSelectorStart, partitionSelectorEnd);
  assert.match(partitionSelector, /DomainWorkItem[\s\S]*"isOutstanding"=TRUE[\s\S]*LIMIT \$6[\s\S]*state\.cursorActiveGeneration, state\.cursorWorkId/);
  assert.doesNotMatch(partitionSelector, /DISTINCT ON/,
    "one activation batch must bound physical current-work rows, not only distinct partitions");
  assert.doesNotMatch(rollout, /VALIDATE CONSTRAINT "Phase2WorkBroadClaimPartitionState_claimShard_check"/);
  assert.match(rollout, /jsonb_to_recordset\(\$1::jsonb\)/);
  assert.match(rollout, /pg_advisory_xact_lock_shared[\s\S]*agency-lifecycle:/);
  assert.match(rollout, /lockBackfillAgencyLifecycles[\s\S]*\$executeRawUnsafe[\s\S]*pg_advisory_xact_lock_shared/,
    "Prisma must execute and discard PostgreSQL void advisory-lock results");
  assert.match(rollout, /phase3_reconcile_domain_work_claim_partition[\s\S]*phase3_reconcile_domain_work_claim_shard[\s\S]*phase3_reconcile_domain_work_claim_agency/);
  assert.match(rollout, /cursorAgencyId[\s\S]*cursorWorkClass[\s\S]*cursorPartitionKey[\s\S]*cursorActiveGeneration[\s\S]*cursorWorkId/);
  assert.match(rollout, /backfilledPartitions"="backfilledPartitions"\+\$7::bigint/);
  assert.match(rollout, /selectMemberBackfillCandidates[\s\S]*FOR SHARE OF m[\s\S]*LIMIT \$2/);
  assert.match(rollout, /phase3_refresh_member_creator_scope/);
  assert.match(rollout, /Phase2WorkGenerationAuthority_phase3_claim_invalidate/);
  assert.match(rollout, /cursorMemberId[\s\S]*backfilledMembers/);
  assert.match(rollout, /partitionsBackfilledAt[\s\S]*membersBackfilledAt/);
  const validationStart = rollout.indexOf("async function validateTopology");
  const validationEnd = rollout.indexOf("async function activateTopology", validationStart);
  const boundedValidation = rollout.slice(validationStart, validationEnd);
  assert.match(boundedValidation, /selectBackfillCandidates\(db, state, 1\)/);
  assert.match(boundedValidation, /selectMemberBackfillCandidates\(db, state, 1\)/);
  assert.doesNotMatch(boundedValidation, /missingPartitionPath|missingMemberAccess|jsonb_array_elements|COUNT\(\*\).*DomainWorkItem/);
  assert.match(rollout, /pg_try_advisory_lock/);
  assert.match(rollout, /validateTopology[\s\S]*"activationState"='ACTIVE'/);
  assert.doesNotMatch(rollout, /DELETE FROM "Phase2WorkBroadClaimPartitionState"|TRUNCATE/);
  const preflightAt = packageJson.indexOf("phase3-domain-work-claim-online-rollout.js --preflight");
  const migrateAt = packageJson.indexOf("prisma migrate deploy", preflightAt);
  const activateAt = packageJson.indexOf("phase3-domain-work-claim-online-rollout.js --activate", migrateAt);
  assert.ok(preflightAt >= 0 && migrateAt > preflightAt && activateAt > migrateAt,
    "deployment must build indexes online, install producers, then activate the resumable topology");
  assert.match(postgresProof, /DOMAIN_WORK_CLAIM_ROLLOUT/);
  assert.match(postgresProof, /rolling-a13-domain-work-preflight[\s\S]*rolling-current-domain-work-activate/);
  assert.match(postgresProof, /seeded-domain-work-preflight[\s\S]*seeded-current-domain-work-activate/);

  assert.match(sourceClaim, /relationalMemberScope/);
  assert.match(sourceClaim, /memberScope:[\s\S]*memberId:[\s\S]*userId:[\s\S]*accessEpoch:/);
  const relationalBranch = sourceClaim.slice(sourceClaim.indexOf("const relationalMemberScope"));
  assert.doesNotMatch(relationalBranch.split("const adapterScope")[0], /allowedCreatorScope/);
  assert.match(permissions, /AgencyMemberCreatorAccessCurrent/);
  assert.match(permissions, /DomainWorkClaimTopologyState/);

  assert.match(physical, /4000 creators publish bounded fair work and two replicas claim disjoint batches/);
  assert.match(physical, /scoped member claims 1000 of 2000 creators through fixed shards without enumerating scope/);
  assert.match(physical, /A36_SCOPED_1000_OF_2000_FIXED_SHARD_ACCESS_PASS/);
  assert.match(physical, /DomainWorkItem_claimable_creator_a36_idx/);
  assert.match(physical, /1000 agencies publish 4000 creators and two replicas claim tenant-fair disjoint batches/);
  assert.match(physical, /A36_POPULATED_RESUMABLE_ACTIVATION_LIVE_WRITE_PASS/);
  assert.match(physical, /A36_EXECUTOR_GENERATION_CUTOVER_PASS/);
  assert.match(physical, /A36_DEPENDENCY_WAKE_BOUNDED_FANOUT_PASS/);
  assert.match(physical, /batchSize: 37[\s\S]*live-after-cursor/);
  assert.match(physical, /assert\.equal\(allAgencies\.size, 100\)/);
  assert.match(physical, /opposite-order multi-write transactions defer exact partition-shard-Agency reconciliation without deadlock/);
  assert.match(physical, /opposite-order transactions sharing the exact same partitions cannot retain the retired row-trigger inversion/);
  assert.equal((physical.match(/await runPhase3InterleavedTransactions\(/g) || []).length, 3);
  assert.match(physical, /state: "BLOCKED"[\s\S]*blockedPartitions\.every\(\(row\) => row\.nextClaimableAt == null\)/);
  assert.match(physical, /rebuiltPartition\?\.nextClaimableAt[\s\S]*rebuiltShard\?\.nextDispatchAt[\s\S]*rebuiltAgency\?\.nextDispatchAt/);
});

test("A36 PostgreSQL boundary normalizes Node time and selects destructive authority by proven schema generation", () => {
  const temporal = source("prisma/migrations/20260923043000_phase3_domain_work_temporal_api_contract_v1/migration.sql");
  const original = source("prisma/migrations/20260922183000_phase3_a36_domain_work_claim_shard_closure_v1/migration.sql");
  const fixture = source("scripts/audit/phase3-postgres-proof-fixture-authority.js");
  const domain = source("src/services/domain-work-authority-service.js");
  const postgresProof = source("scripts/audit/phase3-a20-postgres-proof.js");

  assert.match(original, /p_touched_at TIMESTAMP\(3\)/,
    "DB-internal reconciliation must keep the canonical timestamp(3) storage contract");
  assert.match(temporal, /CREATE OR REPLACE FUNCTION "phase3_utc_timestamp"\(p_value TIMESTAMPTZ\)/);
  assert.match(temporal, /AT TIME ZONE 'UTC'[\s\S]*::TIMESTAMP\(3\)/);
  assert.equal((temporal.match(/p_touched_at TIMESTAMPTZ/g) || []).length, 3,
    "partition, shard and Agency application boundaries must all accept Prisma timestamptz");
  assert.equal((temporal.match(/"phase3_utc_timestamp"\(p_touched_at\)/g) || []).length, 3);
  assert.match(temporal, /phase3_reconcile_domain_work_claim_partition[\s\S]*phase3_reconcile_domain_work_claim_shard[\s\S]*phase3_reconcile_domain_work_claim_agency/);
  assert.doesNotMatch(domain, /phase3_reconcile_domain_work_claim_(?:partition|shard|agency)"\([^\n]*::timestamp/i,
    "temporal compatibility belongs to the PostgreSQL API, not scattered caller casts");
  assert.match(domain, /COALESCE\(\$12::timestamptz,clock_timestamp\(\)\)[\s\S]*AT TIME ZONE 'UTC'/,
    "immediate publication must use the database clock and normalize explicit Node timestamps at one SQL boundary");
  assert.match(domain, /DOMAIN_WORK_AVAILABLE_AT_INVALID/,
    "an invalid explicit deadline must fail closed instead of silently becoming immediate work");
  const exactFixtureClaim = fixture.slice(
    fixture.indexOf("async function claimPhase3PostgresAgencyDestructiveFixture"),
    fixture.indexOf("async function installPhase3PostgresAgencyDestructiveFixtureAuthority"),
  );
  assert.doesNotMatch(exactFixtureClaim, /availableAt:\s*new Date\(/,
    "exact destructive fixture work must use the same DB-clock immediate publication contract as production");

  assert.match(fixture, /PHASE3_CLAIM_TOPOLOGY_MIGRATION/);
  assert.match(fixture, /PHASE3_EXACT_DESTRUCTIVE_CLAIM_MIGRATION/);
  assert.match(fixture, /"_prisma_migrations"[\s\S]*finished_at IS NOT NULL[\s\S]*rolled_back_at IS NULL/);
  assert.match(fixture, /to_regclass\('\"DomainWorkClaimTopologyState\"'\)/);
  assert.match(fixture, /to_regprocedure\('\"phase2_internal_agency_destructive_authorized\"\(text\)'\)/);
  assert.match(fixture, /phase2_destructive_agency_work_id[\s\S]*phase2_destructive_agency_owner_token/);
  assert.match(fixture, /PHASE3_POSTGRES_FIXTURE_GENERATION_DRIFT/,
    "partial or contradictory schema generations must fail closed");
  assert.match(fixture, /LEGACY_AGENCY_MARKER/);
  assert.match(fixture, /EXACT_LIVE_CLAIM/);
  assert.match(fixture, /installLegacyPhase3PostgresAgencyDestructiveFixtureAuthority[\s\S]*drainPhase3PostgresAgencyDomainWork[\s\S]*creatorAccount\.deleteMany[\s\S]*agency\.deleteMany/);
  assert.match(fixture, /claimPhase3PostgresAgencyDestructiveFixture[\s\S]*installPhase3PostgresAgencyDestructiveFixtureAuthority/);
  assert.match(postgresProof, /rolling-a13-fixture-lifecycle[\s\S]*addMigrationsAfter\(rollingPrisma, A13_CUTOFF\)[\s\S]*rolling-current-fixture-lifecycle/);
  assert.match(postgresProof, /seeded-pre-a20-2-fixture-lifecycle[\s\S]*addMigrationsAfter\(seededRollingPrisma, PRE_A20_2_CUTOFF\)[\s\S]*seeded-current-fixture-lifecycle/);
});

test("A36 PostgreSQL application ABI owns every Prisma numeric narrowing boundary", () => {
  const original = source("prisma/migrations/20260922183000_phase3_a36_domain_work_claim_shard_closure_v1/migration.sql");
  const numericAbi = source("prisma/migrations/20260923060000_phase3_domain_work_prisma_numeric_abi_contract_v2/migration.sql");
  const domain = source("src/services/domain-work-authority-service.js");
  const rollout = source("scripts/database/phase3-domain-work-claim-online-rollout.js");

  assert.match(original, /phase3_reconcile_domain_work_claim_shard[\s\S]*p_shard INTEGER[\s\S]*p_touched_at TIMESTAMP\(3\)/,
    "DB-internal shard reconciliation must retain its int4/timestamp(3) storage contract");
  assert.match(original, /phase3_wake_domain_dependency_batch[\s\S]*p_revision BIGINT,p_limit INTEGER DEFAULT 100/,
    "DB-internal wake authority must retain its bounded int4 limit");

  assert.match(numericAbi, /phase3_reconcile_domain_work_claim_shard[\s\S]*p_shard BIGINT[\s\S]*p_touched_at TIMESTAMPTZ/);
  assert.match(numericAbi, /p_shard >= 0 AND p_shard < 128[\s\S]*p_shard::INTEGER[\s\S]*phase3_utc_timestamp/,
    "the application ABI must validate the shard before narrowing and normalize time centrally");
  assert.match(numericAbi, /phase3_wake_domain_dependency_batch[\s\S]*p_revision BIGINT[\s\S]*p_limit BIGINT/);
  assert.match(numericAbi, /GREATEST\([\s\S]*1::BIGINT[\s\S]*LEAST\(COALESCE\(p_limit,100::BIGINT\),500::BIGINT\)[\s\S]*::INTEGER/,
    "the application ABI must bound the wake limit before narrowing");

  assert.match(domain, /phase3_reconcile_domain_work_claim_shard"\(\$1,\$2,\$3,\$4,\$5\)/);
  assert.match(domain, /phase3_wake_domain_dependency_batch"\(\$1,\$2,\$3,\$4,\$5\)/);
  assert.doesNotMatch(domain, /phase3_(?:reconcile_domain_work_claim_shard|wake_domain_dependency_batch)"\([^\n]*::(?:int|integer|bigint)/i,
    "Prisma wire compatibility belongs to the PostgreSQL API, not scattered runtime casts");

  assert.match(rollout, /oidvectortypes\(p\.proargtypes\) AS arguments/,
    "overloaded routine verification must use the full PostgreSQL identity signature");
  assert.match(rollout, /text, text, text, bigint, integer[\s\S]*text, text, text, bigint, bigint/,
    "rollout must verify canonical and Prisma dependency-wake ABIs independently");
  assert.match(rollout, /text, text, text, integer, timestamp without time zone[\s\S]*text, text, text, bigint, timestamp with time zone/,
    "rollout must verify canonical and Prisma shard ABIs independently");
  assert.match(rollout, /wakePrismaDefinition[\s\S]*bound before narrowing/);
  assert.match(rollout, /shardStorageDefinition[\s\S]*shardPrismaDefinition[\s\S]*delegate to storage authority/);
});

test("A36 fixture generation classifier accepts only complete legacy or exact-claim generations", () => {
  const {
    PHASE3_DESTRUCTIVE_FIXTURE_AUTHORITY_MODE,
    classifyPhase3PostgresDestructiveFixtureAuthority,
  } = require("../../scripts/audit/phase3-postgres-proof-fixture-authority");

  assert.equal(
    classifyPhase3PostgresDestructiveFixtureAuthority({}).mode,
    PHASE3_DESTRUCTIVE_FIXTURE_AUTHORITY_MODE.LEGACY_AGENCY_MARKER,
  );
  assert.equal(
    classifyPhase3PostgresDestructiveFixtureAuthority({
      topologyMigrationApplied: true,
      exactMigrationApplied: true,
      topologyTablePresent: true,
      exactFunctionInstalled: true,
    }).mode,
    PHASE3_DESTRUCTIVE_FIXTURE_AUTHORITY_MODE.EXACT_LIVE_CLAIM,
  );

  for (const partial of [
    { topologyMigrationApplied: true, topologyTablePresent: true },
    { exactMigrationApplied: true, exactFunctionInstalled: true },
    { topologyTablePresent: true },
    { exactFunctionInstalled: true },
  ]) {
    assert.throws(
      () => classifyPhase3PostgresDestructiveFixtureAuthority(partial),
      (error) => error?.code === "PHASE3_POSTGRES_FIXTURE_GENERATION_DRIFT",
    );
  }
});

test("A36 R2 destructive bypass is bound to one live claimed DWI and preserves child Creator composition", () => {
  const destructive = source("src/services/phase2-destructive-delete-authority-service.js");
  const fixture = source("scripts/audit/phase3-postgres-proof-fixture-authority.js");
  const phase2Fixture = source("scripts/test-support/phase2-postgres-integration-authority.js");
  const migration = source("prisma/migrations/20260922214500_phase3_a36_destructive_claim_authority_closure_v3/migration.sql");
  const physical = source("src/services/phase3-a34-source-scale-closure.integration.test.js");

  const agencyAuthorityStart = migration.indexOf('CREATE OR REPLACE FUNCTION "phase2_internal_agency_destructive_authorized"');
  const creatorAuthorityStart = migration.indexOf('CREATE OR REPLACE FUNCTION "phase2_internal_creator_destructive_authorized"');
  const creatorFenceStart = migration.indexOf('CREATE OR REPLACE FUNCTION "phase2_assert_creator_destructive_insert_allowed"');
  assert.ok(agencyAuthorityStart >= 0 && creatorAuthorityStart > agencyAuthorityStart && creatorFenceStart > creatorAuthorityStart);

  const agencyAuthority = migration.slice(agencyAuthorityStart, creatorAuthorityStart);
  const creatorAuthority = migration.slice(creatorAuthorityStart, creatorFenceStart);
  const creatorFence = migration.slice(creatorFenceStart);
  for (const authority of [agencyAuthority, creatorAuthority]) {
    assert.match(authority, /LANGUAGE sql[\s\S]*VOLATILE/);
    assert.match(authority, /"state"='CLAIMED'/);
    assert.match(authority, /"isOutstanding"=TRUE/);
    assert.match(authority, /"ownerToken"=/);
    assert.match(authority, /"leaseUntil">clock_timestamp\(\)/);
  }
  assert.match(agencyAuthority, /phase2_destructive_agency_work_id/);
  assert.match(agencyAuthority, /phase2_destructive_agency_owner_token/);
  assert.match(creatorAuthority, /phase2_destructive_creator_work_id/);
  assert.match(creatorAuthority, /phase2_destructive_creator_owner_token/);
  assert.match(creatorFence, /v_creator_internal := "phase2_internal_creator_destructive_authorized"/);
  assert.match(creatorFence, /phase2_internal_agency_destructive_authorized[\s\S]*AND NOT v_creator_internal/);

  const creatorWorker = destructive.slice(
    destructive.indexOf("async function processCreatorHardDeleteWorkItem"),
    destructive.indexOf("module.exports"),
  );
  assert.match(creatorWorker, /lockDomainWorkClaimForCommit[\s\S]*phase2_destructive_creator_work_id/);
  assert.match(creatorWorker, /phase2_destructive_creator_owner_token/);
  assert.match(creatorWorker, /String\(item\.id\)[\s\S]*String\(ownerToken \|\| item\.ownerToken \|\| ""\)/);
  assert.match(fixture, /claimPhase3PostgresAgencyDestructiveFixture[\s\S]*claimDomainWorkBatch/);
  assert.match(fixture, /phase2_destructive_agency_work_id/);
  assert.match(fixture, /phase2_destructive_agency_owner_token/);
  assert.ok(
    fixture.indexOf("claimPhase3PostgresAgencyDestructiveFixture(db, id)")
      < fixture.indexOf("installPhase3PostgresAgencyDestructiveFixtureAuthority(tx, id, claim)"),
    "fixture teardown must claim before installing the exact transaction-local authority",
  );
  assert.match(phase2Fixture, /claimAgencyDestructiveFixture[\s\S]*claimDomainWorkBatch/);
  assert.match(phase2Fixture, /phase2_destructive_agency_work_id/);
  assert.match(phase2Fixture, /phase2_destructive_agency_owner_token/);
  assert.match(physical, /destructive internal authority requires the exact live claim and preserves child composition/);
  assert.match(physical, /A36_DESTRUCTIVE_EXACT_CLAIM_AUTHORITY_PASS/);
});

test("A34 Hidden status has one canonical writer boundary and an atomic projection migration", () => {
  const subscriber = source("src/services/subscriber-directory-service.js");
  const likes = source("src/services/likes-service.js");
  const admin = source("src/routes/admin-data.js");
  const migration = source("prisma/migrations/20260922120000_phase3_a34_source_scale_closure_v1/migration.sql");
  const setterStart = subscriber.indexOf("async function setHiddenOnlineStatus");
  const setterEnd = subscriber.indexOf("module.exports", setterStart);
  const setter = subscriber.slice(setterStart, setterEnd);

  assert.match(setter, /runWithAutomationWriteCommitFence/);
  assert.match(setter, /lockSubscriberPublicationCreator/);
  assert.match(setter, /tx\.hiddenOnlineUser\.upsert/);
  assert.doesNotMatch(setter, /automationBumpFanState\.upsert/);
  assert.match(subscriber, /lockDbAdvisoryXact\(\{ db, key: `subscriber-publication:/);
  assert.doesNotMatch(subscriber, /pg_advisory_xact_lock/);
  assert.doesNotMatch(likes, /automationBumpFanState\.findMany/);

  assert.match(migration, /phase3_project_hidden_status_to_bump/);
  assert.match(migration, /HiddenOnlineUser_status_authority_check/);
  assert.match(migration, /a34_bump_status_migration/);
  assert.match(migration, /trg_phase3_hidden_status_projection/);
  assert.match(migration, /CREATOR_RECURRING_PLANNING/);
  assert.match(migration, /trg_phase3_creator_recurring_work/);
  assert.match(migration, /FROM "CreatorAccount" c[\s\S]*WHERE c\."status"='READY'/);

  assert.match(admin, /hiddenOnlineUser:[^\n]*deleteProtected:\s*true/);
  assert.match(admin, /followBackTask:[^\n]*deleteProtected:\s*true/);
  assert.match(admin, /if \(m\.deleteProtected\)[\s\S]*ADMIN_DELETE_PROTECTED/);
  assert.match(admin, /hiddenOnlineUser\.findMany\(\{ where: \{ fanId: q \}/);
  assert.doesNotMatch(admin, /hiddenOnlineUser\.findMany\(\{ where: \{ OR:/);
});

test("A34 resolved degradation updates scheduler health instead of disappearing in a fulfilled promise", () => {
  const scheduler = require("./job-scheduler");
  const { recordRecurringSchedulerHealth, handleRecurringSweepTickResult } = scheduler._test;
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = { ok: false, reason: "likes_failed", degradedComponents: [{ component: "recurringCreatorWork", reason: "likes_failed" }] };
    const health = recordRecurringSchedulerHealth(result);
    handleRecurringSweepTickResult(result);
    assert.equal(health.status, "DEGRADED");
    assert.equal(health.lastReason, "likes_failed");
    assert.ok(health.consecutiveDegraded >= 1);
    assert.ok(lines.some((line) => line.includes("sweep resolved degraded")));
  } finally {
    console.error = original;
  }
});

test("Home demand fulfilled failure and rejection remain visible across healthy recurring ticks and skipped overlap", () => {
  const scheduler = require("./job-scheduler");
  const { handleAnalyticsDemandTickResult, recordRecurringSchedulerHealth } = scheduler._test;
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const failed = { ok: false, failures: 2, reason: "analytics_demand_processing_failed", errors: [{ reason: "P1001" }] };
    handleAnalyticsDemandTickResult(failed);
    handleAnalyticsDemandTickResult(failed);
    recordRecurringSchedulerHealth({ ok: true });
    handleAnalyticsDemandTickResult({ ok: true, skipped: true });
    let health = scheduler.getRecurringSchedulerHealthSnapshot();
    assert.equal(health.status, "DEGRADED");
    assert.equal(health.analyticsDemand.failures, 2);
    assert.equal(health.analyticsDemand.consecutiveDegraded, 2);
    assert.equal(lines.length, 1, "identical errors must not flood every timer tick");
    handleAnalyticsDemandTickResult(null, Object.assign(new Error("connection lost"), { code: "P1001" }));
    health = scheduler.getRecurringSchedulerHealthSnapshot();
    assert.equal(health.lastReason, "P1001");
    assert.equal(lines.length, 2);
    handleAnalyticsDemandTickResult({ ok: true, skipped: false });
    assert.equal(scheduler.getRecurringSchedulerHealthSnapshot().status, "HEALTHY");
    assert.match(source("src/services/job-scheduler.js"), /runAnalyticsCollectionDemandSweep\(\{ db: prisma \}\)[\s\S]*?\.then\(\(result\) => handleAnalyticsDemandTickResult\(result\)\)/);
  } finally {
    handleAnalyticsDemandTickResult({ ok: true });
    console.error = original;
  }
});

"use strict";
// Real service/Prisma/current SQL guards. Provider data is synthetic; the test
// resumes one nonempty immutable generation across a transient failure.
const assert = require("node:assert/strict");
const { createScaleSqlRuntime } = require("../test-support/scale-sql-runtime.cjs");
const { scope } = require("./analytics-traffic/fixture.cjs");
const keepAlive = setInterval(() => {}, 1000);
const deadline = setTimeout(() => { console.error("CAMPAIGN_RESUME_PROOF_DEADLINE"); process.exit(2); }, 180000);
(async () => {
  const runtime = await createScaleSqlRuntime();
  try {
    const { db } = runtime;
    process.env.DATABASE_URL = runtime.url; process.env.DIRECT_URL = runtime.url;
    require.cache[require.resolve("../../src/prisma")] = { exports: db };
    const kernel = require("../../src/services/db-commit-kernel");
    const activation = require("../../src/services/campaign-causal-activation-service");
    const lock = require("../../src/services/campaign-transaction-lock-service");
    const control = require("../../src/services/analytics-collector-control-service");
    const ledger = require("../../src/services/creator-analytics-ledger-service");
    const fair = require("../../src/services/campaign-fair-pages-service");
    const s = await scope(db, { agencyId: "resume173-agency", creatorId: "resume173-creator", userId: "resume173-user" });
    const now = new Date();
    const params = { ...control.buildCollectionCommand({ collectorType: "CAMPAIGNS", collectionMode: "catchup", now }),
      analyticsObservationStartedAt: now.toISOString(), campaignFairPagesVersion: 1, campaignFrontierSchedulingVersion: 1,
      syncPolicyVersion: 2, recoveryIntentId: "resume173-offline-gap" };
    const write = fn => kernel.runRootCommit(db, async ({ tx }) => {
      await activation.enterCampaignBoundedExecution({ db: tx });
      await activation.enterCampaignWriterGeneration({ db: tx });
      await lock.acquireCampaignTransactionLock(tx, s.creatorId);
      return fn(tx);
    });
    await write(async tx => {
      const previous = await tx.jobInstance.create({ data: { id: "resume173-previous-job",
        agencyId: s.agencyId, creatorId: s.creatorId, scope: "creator", jobKey: "fetch_campaigns", status: "CLAIMED",
        params: { ...params, collectionGeneration: "previous-run", collectionRequestedAt: new Date(+now - 1000).toISOString() } } });
      await control.acceptCampaignGeneration({ db: tx, job: previous, campaignLockHeld: true });
      await tx.creatorCampaignFanRefreshWork.create({ data: {
        agencyId: s.agencyId, creatorId: s.creatorId, scanRunId: "previous-run", scanStartedAt: new Date(+now - 1000),
        onlyFansUserId: "old-fan", campaignJobId: previous.id, freshnessCutoffAt: now, status: "FAILED",
      } });
    });
    let job = await write(tx => tx.jobInstance.create({ data: { id: "resume173-job", ...s, userId: undefined,
      scope: "creator", jobKey: "fetch_campaigns", status: "CLAIMED", params } }));
    const run = params.collectionGeneration;
    const page = { kind: "campaigns_page", schemaVersion: 4, collectorVersion: "campaigns-v13", scanRunId: run,
      batchKey: `run:${run}:directory:1`, scannerRejected: 0, campaigns: [{ id: "done", name: "Done" }, { id: "pending", name: "Pending" }] };
    await ledger.ingestCampaignChunk({ db, job, chunk: page });
    job.continuation = { driverPhase: "execute", jobContinuation: { collectorVersion: "campaigns-v13", scanRunId: run,
      phase: "segment", directorySourceExhausted: true, campaignPagesComplete: true, campaignBatchCount: 1,
      claimerBatchCount: 0, segmentCursor: null } };
    const segment = () => ledger.loadCampaignDirectorySegment({ db, job, chunk: {
      kind: "campaign_directory_segment", schemaVersion: 4, collectorVersion: "campaigns-v13", scanRunId: run,
      cursor: job.continuation.jobContinuation.segmentCursor } });
    const first = await segment();
    assert.deepEqual(first.campaignDirectorySegment.campaigns.map(row => [row.id, row.page, row.offset]), [["done", 0, 0], ["pending", 0, 0]]);
    await write(async tx => {
      await fair.commitPage(tx, job, { externalCampaignId: "done", pageNumber: 1, sourceOffset: 0, sourceRowCount: 0, sourceHasMore: false }, false);
      await fair.commitPage(tx, job, { externalCampaignId: "pending", pageNumber: 1, sourceOffset: 0, sourceRowCount: 50, sourceHasMore: true }, false);
      await tx.creatorCampaign.updateMany({ where: { creatorId: s.creatorId, externalCampaignId: "done" }, data: {
        claimersLastVerifiedRunId: run, claimersTargetRunId: null, claimersObservationVersion: 1,
        claimersVerifiedAt: now, claimerVerifiedRevision: 1 } });
      const statuses = ["ALREADY_FRESH", "QUEUED", "SUCCEEDED", "UNAVAILABLE", "FAILED"];
      await tx.creatorCampaignFanRefreshWork.createMany({ data: statuses.map((status, i) => ({
        agencyId: s.agencyId, creatorId: s.creatorId, scanRunId: run, scanStartedAt: now,
        onlyFansUserId: "fan-" + i, campaignJobId: job.id, freshnessCutoffAt: now, status,
        requestedRevision: i ? 1 : 0,
      })) });
      await tx.creatorCampaignCollectionState.update({ where: { creatorId: s.creatorId }, data: {
        campaignFrontierCompletedCount: 1, campaignFrontierFreshnessStatus: "SCANNING", campaignProofClaimerBatches: 2,
        fanValueCoverageScanRunId: run, fanValueExpected: 5, fanValueQueued: 4, fanValueOutstanding: 1,
        fanValueAlreadyFresh: 1, fanValueSucceeded: 1, fanValueUnavailable: 1, fanValueFailed: 1,
        fanValueFreshnessStatus: "QUEUED" } });
    });
    const cursorBefore = await db.creatorCampaign.findMany({ where: { creatorId: s.creatorId }, orderBy: { externalCampaignId: "asc" } });
    await control.recordCampaignCollectionFailure({ db, job, terminal: false, error: new Error("temporary provider timeout"), retryAfterAt: now });
    const before = await db.creatorCampaignCollectionState.findUnique({ where: { creatorId: s.creatorId } });
    await db.$disconnect();
    job = structuredClone(job);
    job.continuation.jobContinuation.segmentCursor = "1";
    const resumed = await segment();
    assert.deepEqual(resumed.campaignDirectorySegment.campaigns.map(row => [row.id, row.page, row.offset]), [["pending", 1, 50]]);
    const after = await db.creatorCampaignCollectionState.findUnique({ where: { creatorId: s.creatorId } });
    for (const key of Object.keys(before).filter(key => /^(campaignFrontier|campaignProof|fanValue)/.test(key)))
      assert.deepEqual(after[key], before[key], "same-generation retry erased " + key);
    assert.equal(after.status, "SCANNING"); assert.equal(after.lastErrorCode, null); assert.equal(after.retryAfterAt, null);
    assert.deepEqual(await db.creatorCampaign.findMany({ where: { creatorId: s.creatorId }, orderBy: { externalCampaignId: "asc" } }), cursorBefore);
    console.log("PASS retry/reconnect preserves the exact frontier plan, completed target and pending page 1 / offset 50");

    // Reproduce the already-persisted 172 state: the retry accepted the same
    // generation and erased its plan before the next segment request arrived.
    await write(tx => tx.creatorCampaignCollectionState.update({ where: { creatorId: s.creatorId }, data: {
      campaignFrontierPlanRunId: null, campaignFrontierSelection: {}, campaignFrontierFreshnessStatus: "MISSING",
      campaignFrontierObservationVersion: 0, campaignFrontierDueCount: 0, campaignFrontierTargetCount: 0,
      campaignFrontierCompletedCount: 0, campaignFrontierDeferredCount: 0,
      fanValueExpected: 0, fanValueQueued: 0, fanValueOutstanding: 0, fanValueAlreadyFresh: 0,
      fanValueSucceeded: 0, fanValueUnavailable: 0, fanValueFailed: 0, fanValueFreshnessStatus: "MISSING" } }));
    const repaired = await segment();
    assert.deepEqual(repaired.campaignDirectorySegment.campaigns.map(row => [row.id, row.page, row.offset]), [["pending", 1, 50]]);
    const repairedState = await db.creatorCampaignCollectionState.findUnique({ where: { creatorId: s.creatorId } });
    assert.equal(repairedState.campaignFrontierTargetCount, 2); assert.equal(repairedState.campaignFrontierCompletedCount, 1);
    assert.equal(repairedState.campaignFrontierPlanRunId, run);
    for (const key of ["fanValueExpected", "fanValueAlreadyFresh", "fanValueQueued", "fanValueOutstanding",
      "fanValueSucceeded", "fanValueUnavailable", "fanValueFailed", "fanValueFreshnessStatus"])
      assert.deepEqual(repairedState[key], before[key], "retained per-fan receipt not restored: " + key);
    assert.deepEqual(await db.creatorCampaign.findMany({ where: { creatorId: s.creatorId }, orderBy: { externalCampaignId: "asc" } }), cursorBefore);
    console.log("PASS already-erased recovery plan reconstructs completion and per-fan counters without rewinding or rereading any cursor");

    await assert.rejects(() => write(tx => tx.creatorCampaign.updateMany({ where: { creatorId: s.creatorId, externalCampaignId: "pending" },
      data: fair.initialCursor(run) })), /CAMPAIGN_FAIR_CURSOR_TRANSITION_INVALID/);
    await write(tx => fair.commitPage(tx, job, { externalCampaignId: "pending", pageNumber: 2, sourceOffset: 50, sourceRowCount: 0, sourceHasMore: false }, false));
    const done = await segment();
    assert.deepEqual(done.campaignDirectorySegment.campaigns, []); assert.equal(done.campaignDirectorySegment.hasMore, false);
    console.log("PASS forward page commit completes; direct rewind still rejected by unchanged SQL guard");
    console.log("CAMPAIGN_RESUME_PROOF_PASS", JSON.stringify({ native: runtime.native, checks: 3, providerRescans: 0 }));
  } finally { await runtime.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { clearInterval(keepAlive); clearTimeout(deadline); });

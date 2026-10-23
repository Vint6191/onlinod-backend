"use strict";
// Real SQL reader/current-task regression. The fixture supplies already
// published independent source proofs; FanData completeness stays independent
// from the membership proof and never schedules another provider traversal.
const assert = require("node:assert/strict");
const { createScaleSqlRuntime } = require("../test-support/scale-sql-runtime.cjs");
const { scope } = require("./analytics-traffic/fixture.cjs");
const alive = setInterval(() => {}, 1000);
const deadline = setTimeout(() => { console.error("INITIAL_CAMPAIGN_READINESS_DEADLINE"); process.exit(2); }, 180000);
(async () => {
  const runtime = await createScaleSqlRuntime();
  try {
    const { db } = runtime;
    process.env.DATABASE_URL = runtime.url; process.env.DIRECT_URL = runtime.url;
    require.cache[require.resolve("../../src/prisma")] = { exports: db };
    const { runRootCommit } = require("../../src/services/db-commit-kernel");
    const initial = require("../../src/services/initial-collection-readiness-service");
    const overview = require("../../src/services/creator-overview-service");
    const s = await scope(db, { agencyId: "readiness-agency", creatorId: "readiness-creator", userId: "readiness-user" });
    const foreign = await scope(db, { agencyId: "readiness-foreign-agency", creatorId: "readiness-foreign-creator", userId: "readiness-foreign-user" });
    const now = new Date(), old = new Date(+now - 10000), generation = "readiness-baseline";
    const publisherIds = [];
    for (const [model, jobKey] of [["creatorFinancialCollectionState", "financial_transactions_scan"], ["creatorCampaignCollectionState", "fetch_campaigns"]]) {
      const job = await db.jobInstance.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId, scope: "creator", jobKey, status: "PUBLISHING" } });
      publisherIds.push(job.id);
      await db.analyticsPublication.create({ data: { id: `readiness-${job.id}`, jobId: job.id, agencyId: s.agencyId, creatorId: s.creatorId,
        userId: s.userId, deviceId: "readiness-device", leaseRevision: 1, leaseTokenHash: "proof", payloadHash: "proof",
        payload: { scanRunId: generation }, state: "PENDING", stage: "FINALIZE" } });
      await runRootCommit(db, async ({ tx }) => {
        if (model === "creatorFinancialCollectionState") {
          await require("../../src/services/financial-receipt-authority").enter(tx);
          await tx.financialReceiptRun.create({ data: { id: `readiness-run-${job.id}`, jobId: job.id, agencyId: s.agencyId,
            creatorId: s.creatorId, generation, windows: [], cursor: { phase: "done" }, proof: { complete: true } } });
        }
        await tx[model].create({ data: { agencyId: s.agencyId, creatorId: s.creatorId, sourceJobId: job.id,
          status: "COMPLETE", activeGeneration: generation, baselineGeneration: generation, baselineVerifiedAt: old,
          ...(model === "creatorCampaignCollectionState" ? { fanValueCoverageScanRunId: generation, fanValueFreshnessStatus: "COMPLETE", fanValueExpected: 1 }
            : { receiptCoverageVersion: 1 }) } });
      });
    }
    await runRootCommit(db, async ({ tx }) => {
      await tx.$executeRawUnsafe("SELECT set_config('onlinod.earnings_writer_generation','v7',true)");
      await tx.creatorEarningsLedgerProof.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId, generation, fromAt: old, throughAt: now } });
    });
    await db.creatorNotificationSyncState.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId,
      status: "COMPLETE", normalizerVersion: "notification-source-v2", fullBackfillVerifiedAt: old } });
    await db.subscriberDirectoryState.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId,
      status: "READY", publishedGeneration: 1, publishedAt: old } });
    await db.jobInstance.updateMany({ where: { id: { in: publisherIds } }, data: { status: "DONE", completedAt: now } });
    await db.analyticsPublication.updateMany({ where: { jobId: { in: publisherIds } }, data: { state: "COMMITTED" } });
    const jobsBefore = await db.jobInstance.count();
    const read = () => initial.readInitialCollectionReadiness({ db, creatorId: s.creatorId, now });
    const campaign = result => result.sources.find(source => source.key === "campaigns");
    const demand = await db.creatorFanRefreshDemand.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId,
      onlyFansUserId: "100", requestedFreshnessCutoffAt: old, status: "COMPLETE", requestedRevision: 1, satisfiedRevision: 1 } });
    await db.creatorFanRefreshDemand.create({ data: { agencyId: foreign.agencyId, creatorId: foreign.creatorId,
      onlyFansUserId: "100", requestedFreshnessCutoffAt: old, status: "UNAVAILABLE" } });
    let value = await read();
    assert.equal(value.ready, true); assert.equal(value.completed, 4); assert.equal(campaign(value).ready, true);
    assert.equal((await overview.readCreatorCurrentTask({ db, creatorId: s.creatorId })).progress.percent, 100);
    console.log("PASS four saved sources are ready; another agency's unavailable fan does not leak into readiness");

    await db.creatorFanRefreshDemand.update({ where: { id: demand.id }, data: { status: "UNAVAILABLE", lastOutcome: "UNAVAILABLE" } });
    const before = runtime.queries.length;
    value = await read();
    assert.equal(runtime.queries.length - before, 1, "frequent readiness polling retains one SQL snapshot");
    assert.equal(value.ready, false); assert.equal(value.completed, 3);
    assert.equal(campaign(value).membershipReady, true); assert.equal(campaign(value).ready, false);
    assert.equal(campaign(value).state, "PARTIAL"); assert.equal(campaign(value).enrichmentUnavailable, true);
    assert.match(campaign(value).reason, /unavailable/);
    const task = await overview.readCreatorCurrentTask({ db, creatorId: s.creatorId });
    assert.equal(task.status, "PARTIAL"); assert.equal(task.progress.percent, 75);
    assert.equal(task.label, "Initial data collection incomplete"); assert.equal(task.progress.current, 3);
    console.log("PASS current unavailable demand changes 4/4 to 3/4 and the actual task card to PARTIAL / 75%");

    await db.creatorFanRefreshDemand.update({ where: { id: demand.id }, data: { status: "COMPLETE", lastOutcome: "SUCCEEDED" } });
    assert.equal((await read()).ready, true, "resolved current demand is read directly, without a cached failure flag");
    // Fresh embedded unavailable observations create a terminal run receipt,
    // without necessarily creating a refresh Demand or a provider job.
    await db.creatorCampaignCollectionState.update({ where: { creatorId: s.creatorId },
      data: { fanValueFreshnessStatus: "PARTIAL", fanValueUnavailable: 1 } });
    value = await read();
    assert.equal(value.completed, 3); assert.equal(campaign(value).enrichmentPartial, true);
    assert.equal(campaign(value).state, "PARTIAL"); assert.equal(campaign(value).enrichmentUnavailable, true);
    assert.match(campaign(value).reason, /unavailable/);
    await db.creatorCampaignCollectionState.update({ where: { creatorId: s.creatorId }, data: { fanValueUnavailable: 0 } });
    value = await read();
    assert.equal(value.completed, 3); assert.match(campaign(value).reason, /coverage is incomplete/);
    await db.creatorCampaignCollectionState.update({ where: { creatorId: s.creatorId },
      data: { fanValueCoverageScanRunId: "superseded-run" } });
    assert.equal((await read()).ready, true, "a superseded run's receipt cannot block the current result");
    console.log("PASS partial embedded-value receipt is incomplete only for its current generation");

    await db.creatorCampaignCollectionState.update({ where: { creatorId: s.creatorId },
      data: { fanValueCoverageScanRunId: generation, fanValueFreshnessStatus: "QUEUED", fanValueOutstanding: 1 } });
    value = await read();
    assert.equal(value.completed, 3); assert.equal(campaign(value).state, "COLLECTING"); assert.equal(campaign(value).enrichmentPending, true);
    const states = await initial.loadInitialCollectionAdmission({ db, creatorIds: [s.creatorId], now });
    for (const jobKey of ["catchup_notifications_scan", "subscriber_directory_scan"])
      assert.equal(initial.initialCollectionAdmission({ jobKey }, states.get(s.creatorId)).admitted, true);
    assert.equal(await db.jobInstance.count(), jobsBefore, "readiness never creates provider retries or another campaign scan");
    console.log("PASS membership admission releases independent sources; partial readiness creates no provider work");
    console.log("INITIAL_CAMPAIGN_READINESS_PROOF_PASS", JSON.stringify({ native: runtime.native, checks: 4, queryCount: 1 }));
  } finally { await runtime.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { clearInterval(alive); clearTimeout(deadline); });

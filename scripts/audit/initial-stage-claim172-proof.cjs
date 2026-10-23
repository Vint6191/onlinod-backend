"use strict";
const assert = require("node:assert/strict");
const { createScaleSqlRuntime } = require("../test-support/scale-sql-runtime.cjs");
const { scope } = require("./analytics-traffic/fixture.cjs");
const keep = setInterval(() => {}, 1000);
const deadline = setTimeout(() => { console.error("INITIAL_STAGE_PROOF_DEADLINE"); process.exit(2); }, 180000);
(async () => {
  const runtime = await createScaleSqlRuntime();
  try {
    const { db } = runtime;
    require.cache[require.resolve("../../src/prisma")] = { exports: db };
    const control = require("../../src/services/analytics-collector-control-service");
    const admission = require("../../src/services/initial-collection-readiness-service");
    const lease = require("../../src/services/job-lease-service");
    const { runRootCommit } = require("../../src/services/db-commit-kernel");
    const now = new Date(), old = new Date(+now - 3600000), deviceId = "initial-stage-device";
    const s = await scope(db, { agencyId: "initial-stage-agency", creatorId: "initial-stage-creator", userId: "initial-stage-user" });
    await db.agency.update({ where: { id: s.agencyId }, data: { trialEndsAt: new Date(+now + 86400000) } });
    await db.workerDevice.create({ data: { id: deviceId, agencyId: s.agencyId, userId: s.userId, lastSeenAt: now } });
    const blockedCreators = Array.from({ length: 32 }, (_, i) => `stage-blocked-${i}`);
    await runRootCommit(db, async ({ tx }) => {
      await tx.$queryRawUnsafe("SELECT set_config('onlinod.phase2_creator_writer_generation','phase2_creator_writer_v2_actual56_postcut',true)");
      await tx.creatorAccount.createMany({ data: blockedCreators.map(id => ({ id, agencyId: s.agencyId, displayName: id, status: "READY", remoteId: id })) });
    });
    await db.deviceCreatorBinding.createMany({ data: [s.creatorId, ...blockedCreators].map(creatorId => ({ creatorId,
      agencyId: s.agencyId, deviceId, sessionReadReady: true, lastSeenAt: now })) });
    await db.jobInstance.createMany({ data: blockedCreators.flatMap(creatorId => Array.from({ length: 8 }, (_, i) => ({
      id: `${creatorId}-job-${i}`, agencyId: s.agencyId, creatorId, jobKey: "catchup_notifications_scan", scope: "creator",
      nextRunAt: old, priority: 100, params: control.buildCollectionCommand({ collectorType: "NOTIFICATIONS", collectionMode: "full", reason: "INITIAL_PROOF", now }),
    }))) });
    const financial = await db.jobInstance.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId,
      jobKey: "financial_transactions_scan", scope: "creator", nextRunAt: now, priority: 0,
      params: { ...control.buildCollectionCommand({ collectorType: "FINANCIAL", collectionMode: "full", reason: "INITIAL_PROOF", now }),
        endDate: now.toISOString(), earningsLedgerVersion: 1 } } });
    const capabilities = Object.fromEntries(["creatorEventDrivenSyncV2", "financialWindowReceiptsV1", "financialTraversalV2", "financialMoneyResolutionV1",
      "campaignCausalObservationV1", "campaignServerFanRefreshV1", "campaignResumablePaginationV1", "campaignFreshnessCoverageV1",
      "campaignOrderIndependentTraversalV1", "campaignSegmentedFairTraversalV1", "campaignFrontierSchedulingV1", "campaignDirectoryReuseV1",
      "campaignBoundedTraversalV1", "campaignTraversalAuthorityV1", "campaignFairPagesV1"].map(key => [key, true]));
    const input = { userId: s.userId, deviceId, jobKeys: ["financial_transactions_scan", "fetch_campaigns", "catchup_notifications_scan"], capabilities };
    const claimed = await lease.claimJob(input);
    assert.equal(claimed.job?.id, financial.id, JSON.stringify(claimed));
    assert.equal(await db.jobInstance.count({ where: { creatorId: { in: blockedCreators }, status: "SCHEDULED", attempts: 0, nextRunAt: old } }), 256);
    assert.equal((await lease.claimJob(input)).reason, "initial-stage-wait");
    console.log("PASS newer financial work is claimed past 256 old blocked jobs across 32 creators; blocked attempts and due dates are preserved");

    await lease.failJob({ userId: s.userId, deviceId, jobId: financial.id, leaseToken: claimed.job.leaseToken,
      leaseRevision: claimed.job.leaseRevision, retryable: false, error: "PROVIDER_UNAVAILABLE" });
    const campaign = await db.jobInstance.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId,
      jobKey: "fetch_campaigns", scope: "creator", nextRunAt: now, priority: 0,
      params: control.buildCollectionCommand({ collectorType: "CAMPAIGNS", collectionMode: "full", reason: "INITIAL_PROOF", now }) } });
    const campaignClaim = await lease.claimJob(input);
    assert.equal(campaignClaim.job?.id, campaign.id, JSON.stringify(campaignClaim));
    console.log("PASS finite finance failure releases the campaign candidate while older independent creators remain correctly blocked");

    // Compare the actual relational candidate predicate with the owning source
    // reader. This includes the compatibility baseline fallback and a poisoned
    // newer membership proof, which must not borrow the older proof's timestamp.
    const jobs = await Promise.all(["financial_transactions_scan", "fetch_campaigns", "catchup_notifications_scan", "subscriber_directory_scan"].map(jobKey =>
      db.jobInstance.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId, jobKey, scope: "creator", params: {} } })));
    const trusted = { baselineGeneration: "baseline", baselineVerifiedAt: old };
    const future = new Date(+now + 86400000);
    const cases = [
      { name: "missing", finance: null, campaign: null },
      { name: "finite failures", finance: { status: "FAILED" }, campaign: { status: "FAILED" } },
      { name: "finite partial", finance: { status: "PARTIAL" }, campaign: { status: "PARTIAL" } },
      { name: "future cooldown", finance: { status: "PARTIAL", retryAfterAt: future }, campaign: { retryAfterAt: future } },
      { name: "due retry", finance: { status: "PARTIAL", retryAfterAt: old }, campaign: { status: "PARTIAL", retryAfterAt: old } },
      { name: "baseline missing ledger", finance: trusted, campaign: trusted },
      { name: "published baselines", finance: trusted, campaign: trusted, ledger: true },
      { name: "future finance", finance: { ...trusted, baselineVerifiedAt: future }, campaign: trusted, ledger: true },
      { name: "membership proof", finance: trusted, campaign: { membershipBaselineGeneration: "baseline", membershipBaselineVerifiedAt: old,
        membershipCoverageStatus: "COMPLETE", membershipCoverageCompletedAt: old }, ledger: true },
      { name: "future membership shadows legacy", finance: trusted, campaign: { ...trusted, membershipBaselineGeneration: "baseline", membershipBaselineVerifiedAt: future,
        membershipCoverageStatus: "COMPLETE", membershipCoverageCompletedAt: future }, ledger: true },
      { name: "empty generation", finance: { ...trusted, baselineGeneration: "" }, campaign: trusted, ledger: true },
    ];
    const publications = {};
    for (const [model, jobKey] of [["creatorFinancialCollectionState", "financial_transactions_scan"], ["creatorCampaignCollectionState", "fetch_campaigns"]]) {
      const publisher = await db.jobInstance.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId, jobKey, scope: "creator", status: "PUBLISHING" } });
      await db.analyticsPublication.create({ data: { id: `publication-${publisher.id}`, jobId: publisher.id, agencyId: s.agencyId, creatorId: s.creatorId,
        userId: s.userId, deviceId, leaseRevision: 1, leaseTokenHash: "proof", payloadHash: "proof",
        payload: { scanRunId: "baseline" }, state: "PENDING", stage: "FINALIZE" } });
      publications[model] = publisher.id;
    }
    for (const scenario of cases) {
      await db.creatorFinancialCollectionState.deleteMany({ where: { creatorId: s.creatorId } });
      await db.creatorCampaignCollectionState.deleteMany({ where: { creatorId: s.creatorId } });
      await db.creatorEarningsLedgerProof.deleteMany({ where: { creatorId: s.creatorId } });
      for (const [model, data] of [["creatorFinancialCollectionState", scenario.finance], ["creatorCampaignCollectionState", scenario.campaign]])
        if (data) await db[model].create({ data: { agencyId: s.agencyId, creatorId: s.creatorId,
          sourceJobId: publications[model], activeGeneration: "baseline", ...data } });
      if (scenario.ledger) await runRootCommit(db, async ({ tx }) => {
        await tx.$executeRawUnsafe("SELECT set_config('onlinod.earnings_writer_generation','v7',true)");
        await tx.creatorEarningsLedgerProof.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId, generation: "baseline", fromAt: old, throughAt: now } });
      });
      const states = await admission.loadInitialCollectionAdmission({ db, creatorIds: [s.creatorId], now });
      const selected = new Set((await db.jobInstance.findMany({ where: { id: { in: jobs.map(job => job.id) },
        AND: [admission.initialCollectionClaimWhere(now)] }, select: { id: true } })).map(job => job.id));
      for (const job of jobs) assert.equal(selected.has(job.id), admission.initialCollectionAdmission(job, states.get(s.creatorId)).admitted,
        scenario.name + ": " + job.jobKey);
    }
    console.log("PASS relational admission matches source authority in 11 SQL scenarios including future evidence, finite retries, ledger proof and membership fallback");
    console.log(`PASS initial stage claim proof (${runtime.native ? "native PostgreSQL" : "PGlite"})`);
  } finally { await runtime.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { clearInterval(keep); clearTimeout(deadline); });

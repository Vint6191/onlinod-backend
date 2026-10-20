"use strict";
// Actual Desktop directory traversal and Backend page/completion/publication
// services over isolated SQL. Only provider rows and the temporary DB failure
// are synthetic. Reproduce the old terminal policy through its real settle path.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { createRequire } = require("node:module");
const { fixture, scope } = require("./analytics-traffic/fixture.cjs");
const keepAlive = setInterval(() => {}, 1000);
const deadline = setTimeout(() => { console.error("CAMPAIGN_RECOVERY_PROOF_TIMEOUT"); process.exit(2); }, 120000);
async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "nod-campaign-recovery-"));
  const desktop = path.resolve(process.env.ONLINOD_DESKTOP_ROOT);
  const desktopLoad = createRequire(path.join(desktop, "package.json"));
  const bundle = path.join(temporary, "campaigns.cjs");
  await desktopLoad("esbuild").build({ entryPoints: [path.join(desktop, "apps/desktop/electron/main/services/backend-jobs/handlers/campaigns-handler.ts")],
    outfile: bundle, bundle: true, platform: "node", format: "cjs", logLevel: "silent" });
  const { campaignsHandler } = require(bundle);
  const f = await fixture(), { db, root } = f;
  try {
    const s = await scope(db), at = new Date(), token = "campaign-fixture-lease", jobId = "campaign-old-terminal";
    require.cache[require.resolve(path.join(root, "src/prisma"))] = { exports: db };
    const kernel = require(path.join(root, "src/services/db-commit-kernel"));
    const lease = require(path.join(root, "src/services/job-lease-service"));
    const control = require(path.join(root, "src/services/analytics-collector-control-service"));
    const publisherPath = require.resolve(path.join(root, "src/services/analytics-publication-service"));
    const publisher = require(publisherPath);
    const deviceId = "campaign-recovery-device";
    await db.workerDevice.create({ data: { id: deviceId, agencyId: s.agencyId, userId: s.userId, lastSeenAt: at } });
    let job = await kernel.runRootCommit(db, async ({ tx }) => {
      await require(path.join(root, "src/services/campaign-causal-activation-service")).enterCampaignBoundedExecution({ db: tx });
      return tx.jobInstance.create({ data: {
      id: jobId, agencyId: s.agencyId, creatorId: s.creatorId, jobKey: "fetch_campaigns", scope: "creator", status: "CLAIMED",
      claimedByDeviceId: deviceId, leaseTokenHash: crypto.createHash("sha256").update(token).digest("hex"), leaseRevision: 1,
      leaseMemberId: "member-" + s.agencyId, leaseAccessEpoch: 1, leaseUntil: new Date(+at + 600000),
      params: { ...control.buildCollectionCommand({ collectorType: "CAMPAIGNS", collectionMode: "full", reason: "LOCAL_RECOVERY_PROOF", now: at }),
        analyticsObservationStartedAt: at.toISOString(), campaignTraversalAuthorityVersion: 1, campaignFairPagesVersion: 1,
        campaignFreshnessCoverageVersion: 1, campaignBoundedTraversalVersion: 1, campaignFrontierSchedulingVersion: 1 },
      } });
    });
    const identity = { jobId, userId: s.userId, deviceId, leaseToken: token, leaseRevision: 1 };
    let accepted, providerReads = 0;
    for (let turn = 0; turn < 8 && !accepted; turn++) {
      const previous = structuredClone(job.continuation);
      const step = await campaignsHandler.runChunk({ creatorId: s.creatorId, job,
        continuation: job.continuation?.jobContinuation || null, signal: new AbortController().signal,
        ofApi: { request: async request => {
          assert.equal(request.source, "backend.readonly.fetch_campaigns.list"); providerReads++;
          return { ok: true, status: 200, data: { list: [], hasMore: false } };
        } },
      });
      const continuation = step.outcome === "done"
        ? { driverPhase: "complete", result: step.result, progress: step.progress }
        : { driverPhase: "execute", jobContinuation: step.continuation };
      await lease.progressJob({ ...identity, expectedContinuation: previous, chunkResult: step.chunkResult, continuation, progress: step.progress });
      job = await db.jobInstance.findUnique({ where: { id: jobId } });
      if (step.outcome === "done") accepted = await lease.completeJob({ ...identity, result: step.result, progress: step.progress });
    }
    assert(accepted?.publicationPending, "actual collection must hand off server-owned publication");
    assert.equal(providerReads, 1);
    const before = await db.creatorCampaignCollectionState.findUnique({ where: { creatorId: s.creatorId } });
    assert.equal(before.status, "SCANNING");
    assert.equal(before.campaignProofCampaignBatches, 1);

    // Emulate the old eighth-failure decision while retaining the real current
    // transaction, recordJobFailure, immutable receipt and DWI acknowledgement.
    const retryPolicy = require(path.join(root, "src/services/db-retry-policy"));
    const classifyCurrent = retryPolicy.isTransientDatabaseError;
    delete require.cache[publisherPath];
    retryPolicy.isTransientDatabaseError = () => false;
    let oldPolicy;
    try { oldPolicy = require(publisherPath); }
    finally { retryPolicy.isTransientDatabaseError = classifyCurrent; delete require.cache[publisherPath]; }
    await db.analyticsPublication.update({ where: { id: accepted.publicationId }, data: { attempts: 7 } });
    let inject = true;
    db.$use(async (params, next) => {
      if (inject && params.model === "CreatorCampaignCollectionState" && params.action === "findUnique") {
        inject = false;
        throw Object.assign(new Error("Injected temporary SQL availability failure"), { code: "P2024" });
      }
      return next(params);
    });
    const failed = await oldPolicy.runAnalyticsPublicationSweep({ db, limit: 1 });
    assert.equal(failed.ok, false); assert.equal(inject, false);
    const receipt = await db.analyticsPublication.findUnique({ where: { id: accepted.publicationId } });
    const terminalJob = await db.jobInstance.findUnique({ where: { id: jobId } });
    const terminalState = await db.creatorCampaignCollectionState.findUnique({ where: { creatorId: s.creatorId } });
    const terminalWork = await db.domainWorkItem.findFirst({ where: { workClass: "ANALYTICS_PUBLICATION", objectId: accepted.publicationId } });
    assert.equal(receipt.state, "REJECTED"); assert.equal(receipt.lastError, "P2024");
    assert.equal(terminalJob.status, "FAILED"); assert.equal(terminalState.status, "FAILED");
    assert.equal(terminalState.retryAfterAt, null); assert.equal(terminalState.lastErrorCode, "CAMPAIGN_COLLECTION_FAILED");
    assert.equal(terminalWork.state, "DONE"); assert.equal(terminalWork.isOutstanding, false);
    assert.equal(terminalState.activeGeneration, before.activeGeneration);
    assert.equal(terminalState.campaignProofCampaignBatches, before.campaignProofCampaignBatches);
    console.log("PASS actual old terminal policy rejects publication, collector and job and acknowledges DWI");

    await db.$disconnect(); await f.waitForIdle();
    await f.engine.exec('DROP INDEX "AnalyticsCollectionDemand_quarantine_pending_idx"');
    await f.engine.exec(fs.readFileSync(path.join(root, "prisma/migrations/20261018030000_analytics_recovery_retry/migration.sql"), "utf8"));
    const recovered = await db.creatorCampaignCollectionState.findUnique({ where: { creatorId: s.creatorId } });
    assert.equal(recovered.status, "SCANNING"); assert.equal(recovered.lastErrorCode, null);
    for (const key of Object.keys(before).filter(key => /^(campaignProof|campaignDirectory|campaignFrontier|fanValue)/.test(key))) {
      assert.deepEqual(recovered[key], terminalState[key], "recovery changed retained observation " + key);
    }
    const resumedWork = await db.domainWorkItem.findUnique({ where: { id: terminalWork.id } });
    assert.equal(resumedWork.state, "READY"); assert.equal(resumedWork.isOutstanding, true);
    assert.equal(resumedWork.requestedRevision, terminalWork.requestedRevision + 1n);
    assert.equal(resumedWork.completedRevision, terminalWork.completedRevision);
    console.log("PASS migration restores exact collector generation and work revision while preserving collected evidence");

    for (let turn = 0; turn < 8; turn++) {
      const row = await db.analyticsPublication.findUnique({ where: { id: accepted.publicationId } });
      if (row.state !== "PENDING") break;
      await kernel.runRootCommit(db, async ({ tx }) => {
        const due = new Date(Date.now() - 1000);
        await tx.analyticsPublication.update({ where: { id: row.id }, data: { availableAt: due } });
        await tx.domainWorkItem.update({ where: { id: terminalWork.id }, data: { availableAt: due, nextAttemptAt: null } });
      });
      const sweep = await publisher.runAnalyticsPublicationSweep({ db });
      assert.equal(sweep.ok, true, JSON.stringify(sweep));
    }
    const final = await db.analyticsPublication.findUnique({ where: { id: accepted.publicationId } });
    assert.equal(final.state, "COMMITTED", JSON.stringify({ state: final.state, lastError: final.lastError, response: final.response }));
    assert.equal((await db.jobInstance.findUnique({ where: { id: jobId } })).status, "DONE");
    const finalState = await db.creatorCampaignCollectionState.findUnique({ where: { creatorId: s.creatorId } });
    assert.equal(finalState.status, "COMPLETE"); assert.equal(finalState.membershipCoverageStatus, "COMPLETE");
    assert.equal(finalState.activeGeneration, before.activeGeneration); assert(finalState.baselineVerifiedAt instanceof Date);
    assert.equal(providerReads, 1);
    console.log("PASS revived Campaign reaches FINALIZE and committed membership proof without a provider rescan");
    console.log(JSON.stringify({ ok: true, cases: 3, providerReads, productionAccessed: false, nativePostgres: false,
      limitations: ["PGlite single SQL session; native PostgreSQL contention not exercised", "Synthetic empty provider directory; real Desktop and Backend protocols"] }));
  } finally { await f.close(); fs.rmSync(temporary, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { clearInterval(keepAlive); clearTimeout(deadline); });

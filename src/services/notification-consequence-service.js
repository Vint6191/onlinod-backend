"use strict";

const { performance } = require("node:perf_hooks");
const work = require("./domain-work-authority-service");
const { runRootCommit } = require("./db-commit-kernel");
const { dbAuthorityNow } = require("./db-time-authority-service");
const WORK_CLASS = work.WORK_CLASS.NOTIFICATION_CONSEQUENCES;
const PAGE_SIZE = 50;
const TABLES = ["creatorSale", "creatorTip", "creatorSubscriptionEvent"];
const TERMINAL = new Set(["DONE", "FAILED", "CANCELLED", "CANCELED", "EXPIRED"]);
function error(code) { return Object.assign(new Error(code), { code }); }
function owned(result) { if (!result || result.lost) throw error("NOTIFICATION_CONSEQUENCE_CLAIM_LOST"); return result; }

async function publishNotificationConsequences({ db, job }) {
  if (job?.jobKey !== "catchup_notifications_scan" || job?.params?.notificationMode !== "catchup") return null;
  const published = await work.publishDomainWork({ db, agencyId: job.agencyId, creatorId: job.creatorId,
    workClass: WORK_CLASS, objectType: "JobInstance", objectId: job.id,
    parentObjectId: job.creatorId, partitionKey: job.creatorId });
  if (!published?.id) throw error("NOTIFICATION_CONSEQUENCE_INTENT_REQUIRED");
  return published;
}

async function projectFacts({ db, job, table, rows, historical = false, historyPolicy = null }) {
  // Lazy imports avoid a cycle through job-result -> Team -> scheduler.
  const projection = require("./team-observation-service");
  const traffic = require("./traffic-service");
  const project = [projection.projectSaleProjectionFact, projection.projectTipProjectionFact,
    projection.projectSubscriptionProjectionFact][table];
  const subscriptions = [];
  const deferredAggregates = new Map();
  let retentionExcluded = 0;
  for (const row of rows) {
    const fact = project(row);
    if (fact.kind === "sale" || fact.kind === "tip") {
      await traffic.markTrafficFanValueDirty({ db, agencyId: job.agencyId, creatorId: job.creatorId,
        fanId: fact.fanId, occurredAt: fact.purchasedAt || fact.receivedAt || fact.occurredAt,
        reason: `canonical_${fact.kind}` });
      continue;
    }
    const result = await traffic.projectCanonicalSubscriptionCompatibility({ db, job, fact, deferredAggregates, historyPolicy });
    if (result.retentionExcluded || result.aggregateRetentionExcluded) retentionExcluded++;
    const type = String(fact.eventType || "").toLowerCase();
    if (fact.fanId && /(subscribed|resubscribed|renewed)/.test(type) && !/(expired|refund|chargeback|auto.?renew)/.test(type)) {
      subscriptions.push({ type: "subscription_created", fanId: fact.fanId, dialogId: fact.fanId,
        createdAt: fact.subscribedAt || fact.occurredAt, source: "canonical_subscription_fact",
        providerEventId: fact.externalEventId || fact.notificationId || fact.eventHash });
    }
  }
  for (const aggregate of Array.from(deferredAggregates.values()).sort(traffic.compareTrafficAggregateTargets)) {
    await traffic.recomputeTrafficDailyAggregate(db, aggregate);
  }
  if (subscriptions.length) {
    const result = await require("./bump-service").processRuntimeEvents({
      db, agencyId: job.agencyId, creatorId: job.creatorId, events: subscriptions, reconcileOnly: historical,
    });
    if (result?.errors?.length) throw error(`NOTIFICATION_BUMP_PROJECTION_FAILED:${result.errors[0].code}`);
  }
  return { retentionExcluded };
}

async function processNotificationConsequencePage({ db, item, ownerToken }) {
  if (item.workClass !== WORK_CLASS || item.objectType !== "JobInstance" || !item.creatorId) {
    throw error("NOTIFICATION_CONSEQUENCE_SCOPE_INVALID");
  }
  return runRootCommit(db, async ({ tx }) => {
    // Producer order is JobInstance -> work; use that order on the consumer too.
    if (typeof tx.$queryRawUnsafe === "function") {
      await tx.$queryRawUnsafe('SELECT "id" FROM "JobInstance" WHERE "id"=$1 AND "agencyId"=$2 FOR SHARE', item.objectId, item.agencyId);
    }
    const claim = owned(await work.lockDomainWorkClaimForCommit({ db: tx, item, ownerToken }));
    const job = await tx.jobInstance.findUnique({ where: { id: item.objectId } });
    if (!job || job.agencyId !== item.agencyId || job.creatorId !== item.creatorId) throw error("NOTIFICATION_CONSEQUENCE_SOURCE_MISSING");
    const creator = await tx.creatorAccount.findFirst({ where: { id: job.creatorId, agencyId: job.agencyId, deletedAt: null }, select: { id: true } });
    if (!creator) {
      owned(await work.ackDomainWorkClaim({ db: tx, item, ownerToken, terminalCause: "CREATOR_RETIRED" }));
      return { completed: true, retired: true, processed: 0 };
    }
    if (!TERMINAL.has(job.status)) {
      owned(await work.yieldDomainWorkClaim({ db: tx, item, ownerToken,
        availableAt: new Date(claim.authorityNow.getTime() + 30000) }));
      return { waiting: true, processed: 0 };
    }
    const cursor = claim.item.progressCursor || {};
    const table = Number.isInteger(cursor.table) ? cursor.table : 0;
    if (table < 0 || table >= TABLES.length) throw error("NOTIFICATION_CONSEQUENCE_CURSOR_INVALID");
    const rows = await tx[TABLES[table]].findMany({
      where: { agencyId: job.agencyId, creatorId: job.creatorId, sourceJobId: job.id,
        ...(cursor.afterId ? { id: { gt: String(cursor.afterId) } } : {}) },
      orderBy: { id: "asc" }, take: PAGE_SIZE,
      include: { fan: { select: { onlyFansUserId: true, username: true, displayName: true } } },
    });
    await projectFacts({ db: tx, job, table, rows });
    const processed = Math.max(0, Number(cursor.processed || 0)) + rows.length;
    const next = rows.length === PAGE_SIZE
      ? { table, afterId: rows.at(-1).id, processed }
      : { table: table + 1, afterId: null, processed };
    if (next.table < TABLES.length) {
      owned(await work.yieldDomainWorkClaim({ db: tx, item, ownerToken, progressCursor: next }));
      return { yielded: true, processed: rows.length };
    }
    // Never replay ingestNotificationFacts or completeNotificationSync here:
    // those clocks/proofs belong to the collector, not a delayed projection.
    const completedAt = job.completedAt || job.updatedAt;
    const now = await dbAuthorityNow({ db: tx, fallbackNow: new Date() });
    await tx.teamObservationState.upsert({
      where: { agencyId_creatorId: { agencyId: job.agencyId, creatorId: job.creatorId } },
      create: { agencyId: job.agencyId, creatorId: job.creatorId, accountId: job.params?.accountId || job.creatorId }, update: {},
    });
    await tx.teamObservationState.updateMany({
      where: { agencyId: job.agencyId, creatorId: job.creatorId,
        AND: [{ OR: [{ lastSuccessfulScanAt: null }, { lastSuccessfulScanAt: { lte: completedAt } }] },
          { OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }] }] },
      data: { lastScanSummary: { jobId: job.id, compatibilityProcessed: processed, compatibilityComplete: true,
        projection: "durable_notification_consequences_v1" },
        ...(job.status === "DONE" ? { lastSuccessfulScanAt: completedAt, currentScanStatus: "idle", lastErrorCode: null, lastErrorAt: null } : {}) },
    });
    owned(await work.ackDomainWorkClaim({ db: tx, item, ownerToken }));
    return { completed: true, processed: rows.length };
  }, { profile: "JOB_CHUNK", authority: { kind: "NOTIFICATION_CONSEQUENCES", agencyId: item.agencyId, creatorId: item.creatorId } });
}

async function runNotificationConsequenceSweep({ db = null, limit = 8, maxRuntimeMs = 5000 } = {}) {
  if (!db) db = require("../prisma");
  const started = performance.now();
  const report = { ok: true, selected: 0, processed: 0, completed: 0, yielded: 0, waiting: 0, failed: 0, lostOwnership: 0 };
  // Claim one quantum at a time: do not hold a large batch's leases while the
  // first item waits. Shared DomainWork claim indexes provide agency fairness.
  for (let index = 0; index < Math.max(1, Math.min(16, Number(limit) || 8)); index += 1) {
    if (performance.now() - started >= maxRuntimeMs) break;
    const claim = await work.claimDomainWorkBatch({ db, workClass: WORK_CLASS, limit: 1,
      perAgencyQuantum: 1, perPartitionQuantum: 1, leaseMs: 120000 });
    if (claim?.skipped) {
      report.skipped = true;
      report.reason = claim.reason;
      report.ok = claim.reason === "domain_work_dependency_wake_bridge_transition";
    }
    const item = claim?.items?.[0];
    if (!item) break;
    report.selected += 1;
    try {
      const result = await processNotificationConsequencePage({ db, item, ownerToken: claim.ownerToken });
      report.processed += result.processed;
      for (const key of ["completed", "yielded", "waiting"]) if (result[key]) report[key] += 1;
    } catch (cause) {
      const failed = await work.failDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, error: cause });
      report.ok = false;
      if (failed.lost) report.lostOwnership += 1; else report.failed += 1;
    }
  }
  return report;
}

module.exports = { projectFacts, WORK_CLASS, PAGE_SIZE, publishNotificationConsequences, processNotificationConsequencePage, runNotificationConsequenceSweep };

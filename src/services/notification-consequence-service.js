"use strict";

const { performance } = require("node:perf_hooks");
const work = require("./domain-work-authority-service");
const { runRootCommit } = require("./db-commit-kernel");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { lockAgencyLifecycleBarrier } = require("./agency-lifecycle-barrier-service");
const { pauseDeletedAgencyProjection } = require("./analytics-projection-lifecycle-service");
const LEGACY_WORK_CLASS = work.WORK_CLASS.NOTIFICATION_CONSEQUENCES;
const WORK_CLASS = work.WORK_CLASS.NOTIFICATION_CONSEQUENCES_V2;
const PAGE_SIZE = 50;
const TABLES = ["creatorSale", "creatorTip", "creatorSubscriptionEvent"];
const TERMINAL = new Set(["DONE", "FAILED", "CANCELLED", "CANCELED", "EXPIRED"]);
function error(code) { return Object.assign(new Error(code), { code }); }
function owned(result) { if (!result || result.lost) throw error("NOTIFICATION_CONSEQUENCE_CLAIM_LOST"); return result; }

async function publishNotificationConsequences({ db, job }) {
  if (job?.jobKey !== "catchup_notifications_scan") return null;
  const published = await work.publishDomainWork({ db, agencyId: job.agencyId, creatorId: job.creatorId,
    workClass: "NOTIFICATION_FACT_RECEIPTS", objectType: "JobInstance", objectId: job.id,
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
  let retentionExcluded = 0;
  for (const row of rows) {
    const fact = project(row);
    if (fact.kind === "sale" || fact.kind === "tip") {
      // Retained facts may outlive both the fan relation and the event identity.
      // The financial fact remains canonical; there is no fan-scoped Traffic
      // projection to invalidate in that case. History records the identity gap.
      if (!fact.fanId) continue;
      await traffic.markTrafficFanValueDirty({ db, agencyId: job.agencyId, creatorId: job.creatorId,
        fanId: fact.fanId, occurredAt: fact.purchasedAt || fact.receivedAt || fact.occurredAt,
        reason: `canonical_${fact.kind}` });
      continue;
    }
    const result = await traffic.projectCanonicalSubscriptionCompatibility({ db, job, fact, historyPolicy });
    if (result.retentionExcluded) retentionExcluded++;
    const type = String(fact.eventType || "").toLowerCase();
    if (fact.fanId && /(subscribed|resubscribed|renewed)/.test(type) && !/(expired|refund|chargeback|auto.?renew)/.test(type)) {
      subscriptions.push({ type: "subscription_created", fanId: fact.fanId, dialogId: fact.fanId,
        createdAt: fact.subscribedAt || fact.occurredAt, source: "canonical_subscription_fact",
        providerEventId: fact.externalEventId || fact.notificationId || fact.eventHash });
    }
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
  if (![WORK_CLASS, LEGACY_WORK_CLASS].includes(item.workClass) || item.objectType !== "JobInstance" || !item.creatorId) {
    throw error("NOTIFICATION_CONSEQUENCE_SCOPE_INVALID");
  }
  return runRootCommit(db, async ({ tx }) => {
    const lifecycle = await lockAgencyLifecycleBarrier({ db: tx, agencyId: item.agencyId });
    // Producer order is JobInstance -> work; use that order on the consumer too.
    if (typeof tx.$queryRawUnsafe === "function") {
      await tx.$queryRawUnsafe('SELECT "id" FROM "JobInstance" WHERE "id"=$1 AND "agencyId"=$2 FOR SHARE', item.objectId, item.agencyId);
    }
    const claim = owned(await work.lockDomainWorkClaimForCommit({ db: tx, item, ownerToken }));
    if (await pauseDeletedAgencyProjection({ db: tx, lifecycle, item, ownerToken })) return { waiting: true, processed: 0 };
    const job = await tx.jobInstance.findUnique({ where: { id: item.objectId } });
    if (!job) {
      // New receipt work survives Job retention; the additive retained-fact
      // repair owns reconstruction of associations already lost by old queues.
      owned(await work.ackDomainWorkClaim({ db: tx, item, ownerToken, terminalCause: "LEGACY_JOB_RETIRED" }));
      return { completed: true, processed: 0 };
    }
    if (job.agencyId !== item.agencyId || job.creatorId !== item.creatorId) throw error("NOTIFICATION_CONSEQUENCE_SOURCE_MISSING");
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
    const historical = job.params?.notificationMode !== "catchup";
    let historyPolicy = null;
    if (historical) {
      const policy = await require("./retention-service").getRetentionSettings({ db: tx });
      if (!policy.ok) throw error("NOTIFICATION_LEGACY_RETENTION_POLICY_UNAVAILABLE");
      historyPolicy = { organicCutoff: policy.settings.trafficPaidOrganicLedgerDays > 0 ? new Date(+claim.authorityNow - policy.settings.trafficPaidOrganicLedgerDays * 86400000) : null };
    }
    await projectFacts({ db: tx, job, table, rows, historical, historyPolicy });
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
    const now = await dbAuthorityNow({ db: tx, fallbackNow: new Date() });
    await tx.$executeRawUnsafe(`UPDATE "TeamObservationState" SET "lastScanSummary"=COALESCE("lastScanSummary",'{}'::jsonb)
      || jsonb_build_object('compatibilityProcessed',$4::int,'compatibilityComplete',TRUE,'compatibilityDeferred',FALSE,'projection','legacy_notification_drain')
      WHERE "agencyId"=$1 AND "creatorId"=$2 AND "lastScanSummary"->>'jobId'=$3
        AND ("lockedUntil" IS NULL OR "lockedUntil"<=$5::timestamp)`, job.agencyId, job.creatorId, job.id, processed, now);
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
  let emptyLanes = 0;
  for (let index = 0; index < Math.max(1, Math.min(16, Number(limit) || 8)); index += 1) {
    if (performance.now() - started >= maxRuntimeMs) break;
    const claim = await work.claimDomainWorkBatch({ db, workClass: ["NOTIFICATION_FACT_RECEIPTS", WORK_CLASS, LEGACY_WORK_CLASS][index % 3], limit: 1,
      perAgencyQuantum: 1, perPartitionQuantum: 1, leaseMs: 120000 });
    if (claim?.skipped) {
      report.skipped = true;
      report.reason = claim.reason;
      report.ok = claim.reason === "domain_work_dependency_wake_bridge_transition";
    }
    const item = claim?.items?.[0];
    if (!item) { if (++emptyLanes >= 3) break; continue; }
    emptyLanes = 0;
    report.selected += 1;
    try {
      const result = await (item.workClass === "NOTIFICATION_FACT_RECEIPTS"
        ? require("./notification-fact-receipt-service").processPage : processNotificationConsequencePage)({ db, item, ownerToken: claim.ownerToken });
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

module.exports = { projectFacts, WORK_CLASS, LEGACY_WORK_CLASS, PAGE_SIZE, publishNotificationConsequences, processNotificationConsequencePage, runNotificationConsequenceSweep };

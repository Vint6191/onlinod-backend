"use strict";
const { digest } = require("./team-command-contract");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { canUsePermission } = require("./team-access-control");
const { permissions } = require("./operational-command-contract");
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const stateId = (agencyId, creatorId, family) => "operation_" + digest([agencyId, creatorId, family]);
const candidateModels = {
  follow_back: "followBackCandidate",
  follow: "followAutomationCandidate",
  likes: "automationContentCandidate",
  sfs: "sfsTargetCandidate",
};
async function candidate(db, agencyId, creatorId, p) {
  return db[candidateModels[p.input.module]].findFirst({
    where: {
      agencyId,
      creatorId,
      ...(["follow_back", "follow"].includes(p.input.module)
        ? { fanId: p.input.candidateId }
        : { id: p.input.candidateId }),
    },
  });
}
async function snapshot(db, agencyId, creatorId, p) {
  const state = await db.operationalControlState.findUnique({ where: { id: stateId(agencyId, creatorId, p.family) } });
  let native = null;
  if (p.family === "dialog_module") {
    native = await db.moduleSetting.findUnique({
      where: { agencyId_moduleKey: { agencyId, moduleKey: "dialog_intelligence" } },
      select: { updatedAt: true, enabled: true },
    });
  } else if (p.family === "dialog") {
    const plan = await db.dialogScanRun.findFirst({
      where: { agencyId, creatorId, dialogId: "__dialog_discovery__" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    native = plan
      ? {
          id: plan.id,
          generation: plan.generation,
          status: plan.status,
          control: plan.continuation?.historyControl || null,
        }
      : null;
  } else if (p.family === "dialog_single") {
    native = await db.dialogScanRun.findFirst({
      where: { agencyId, creatorId, dialogId: p.input.dialogId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, status: true, generation: true },
    });
  } else if (p.family === "vault") {
    const row = await db.vaultUnsortedSnapshot.findUnique({ where: { agencyId_creatorId: { agencyId, creatorId } } });
    native = row
      ? { id: row.id, jobId: row.payload?.scan?.jobId || null, status: row.payload?.scan?.status || null }
      : null;
  } else if (["notification", "financial", "campaign"].includes(p.family)) {
    const jobKey = {
      notification: "catchup_notifications_scan",
      financial: "financial_transactions_scan",
      campaign: "fetch_campaigns",
    }[p.family];
    native = await db.jobInstance.findMany({
      where: { agencyId, creatorId, jobKey },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 1,
      select: { id: true, status: true },
    });
  } else if (["subscriber", "hidden"].includes(p.family)) {
    const row = await db.subscriberDirectoryState.findFirst({ where: { agencyId, creatorId } });
    native = { runId: row?.currentRunId || null };
    if (p.family === "hidden")
      native.item = await db.hiddenOnlineUser.findUnique({
        where: { creatorId_fanId: { creatorId, fanId: p.input.fanId } },
        select: { id: true, status: true, updatedAt: true },
      });
  } else if (p.family === "automation_candidate") {
    const row = await candidate(db, agencyId, creatorId, p);
    native = row ? { id: row.id, updatedAt: row.updatedAt, latestDeliveryId: row.latestDeliveryId } : null;
  } else if (p.family === "automation_delivery") {
    native = await db.automationDelivery.findMany({
      where: {
        agencyId,
        creatorId,
        originKind: "AUTOMATION",
        ...(p.input.deliveryId
          ? { id: p.input.deliveryId }
          : { status: "FAILED", ...(p.input.moduleKey ? { moduleKey: p.input.moduleKey } : {}) }),
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: p.input.limit || 100,
      select: { id: true, status: true, leaseRevision: true },
    });
  }
  return digest([p.family, creatorId, state?.revision || 0, native]);
}
async function authorizeExtra(db, member, p) {
  for (const key of permissions(p))
    if (!(await canUsePermission({ db, member, key })))
      throw fail("MANAGEMENT_PERMISSION_REVOKED", "Current permission is required", 403);
}
function compact(value, depth = 0) {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.length <= 180 ? value : undefined;
  if (!value || typeof value !== "object" || depth > 2) return undefined;
  const allowed = new Set([
    "id",
    "jobId",
    "runId",
    "created",
    "reason",
    "action",
    "status",
    "generation",
    "resumed",
    "paused",
    "canceled",
    "cancelled",
    "pausedRuns",
    "pausedJobs",
    "pausedStates",
    "resumedStates",
    "canceledJobs",
    "resetStates",
    "normalized",
    "requested",
    "retried",
    "resolved",
    "skipped",
    "duplicate",
    "requiresQueueRetry",
    "deliveryId",
    "forceChildFull",
    "summary",
    "createdCount",
    "queued",
    "existing",
    "eligible",
    "total",
    "run",
    "job",
    "jobs",
    "results",
    "deferred",
    "planned",
    "notReady",
    "blocked",
    "skippedCount",
    "count",
    "dueDays",
    "windows",
    "reused",
    "rangeKey",
    "subscriberJobId",
    "fanId",
  ]);
  const result = {};
  for (const [k, v] of Object.entries(value))
    if (allowed.has(k)) {
      const clean = compact(v, depth + 1);
      if (clean !== undefined) result[k] = clean;
    }
  return result;
}
async function apply(db, agencyId, creatorId, userId, member, p) {
  await authorizeExtra(db, member, p);
  if ((await snapshot(db, agencyId, creatorId, p)) !== p.expectedRevision)
    throw fail("OPERATION_VERSION_CONFLICT", "Operation changed; refresh before starting another action");
  const now = await dbAuthorityNow({ db }),
    common = { db, agencyId, creatorId, userId },
    input = p.input;
  let value;
  if (p.family === "dialog_module")
    value = await require("./dialog-module-control-service").configure({ db, agencyId, ...input });
  else if (p.family === "traffic_refresh")
    value = await require("./traffic-service").scheduleTrafficRefresh({ ...common, ...input });
  else if (p.family === "dialog_single") {
    if (p.operation === "start") {
      value = await require("./dialog-intelligence-service").scheduleDialogScanTx(db, {
        agencyId,
        creatorId,
        userId,
        ...input,
      });
      if (value.job) require("./job-planning-repository").publishPlannedJobAvailable(value.job);
    } else value = await require("./dialog-scan-control-service").cancelDialogRun({ ...common, ...input });
  } else if (["notification", "financial", "campaign"].includes(p.family)) {
    const spec = {
      notification: ["notification", "Notification"],
      financial: ["financial-transaction", "FinancialTransaction"],
      campaign: ["campaign", "Campaign"],
    }[p.family];
    const owner = require(`./${spec[0]}-scan-control-service`);
    const creator = await db.creatorAccount.findUnique({ where: { id: creatorId } });
    value = await owner[`${p.operation === "start" ? "start" : "stop"}Manual${spec[1]}Scan`]({
      db,
      creator,
      creatorId,
      requestedByUserId: userId,
      now,
      ...input,
    });
  } else if (p.family === "vault") {
    const owner = require("./vault-unsorted-service");
    const methods = {
      start: "scheduleVaultUnsortedScan",
      pause: "pauseVaultUnsortedScan",
      resume: "resumeVaultUnsortedScan",
      cancel: "cancelVaultUnsortedScan",
    };
    value = await owner[methods[p.operation]]({ ...common, ...input });
  } else if (p.family === "dialog") {
    const owner = require("./dialog-intelligence-service"),
      controls = require("./dialog-scan-control-service");
    if (["start", "resume"].includes(p.operation) && !(await owner.moduleControl(db, agencyId)).enabled)
      throw fail("DIALOG_MODULE_DISABLED", "Enable Dialog Intelligence before starting scans");
    if (p.operation === "start") {
      const childMode = input.mode === "full" ? "initial" : input.mode || "incremental";
      value = await owner.restartCreatorDialogPlanTx(db, {
        agencyId,
        creatorId,
        userId,
        ...input,
        childMode,
        forceChildFull: input.mode === "full",
        source: input.source || "manual_creator_scan",
        generation: null,
        pageLimit: input.pageLimit || 50,
        overlapPages: input.overlapPages ?? 2,
        maxPages: input.maxPages ?? (childMode === "initial" ? 5000 : 1000),
        priority: input.priority ?? 70,
      });
      if (value.job) require("./job-planning-repository").publishPlannedJobAvailable(value.job);
    } else
      value = await controls[
        { pause: "pauseCreatorRuns", resume: "resumeCreatorRuns", cancel: "cancelCreatorRuns" }[p.operation]
      ]({ ...common, reason: input.reason || "changed by user" });
  } else if (p.family === "subscriber")
    value = await require("./subscriber-directory-service").scheduleSubscriberScan({
      ...common,
      ...input,
      manual: input.manual !== false,
      priority: 80,
    });
  else if (p.family === "hidden")
    value = await require("./subscriber-directory-service").setHiddenOnlineStatus({ ...common, ...input });
  else if (p.family === "automation_candidate") {
    const row = await candidate(db, agencyId, creatorId, p);
    if (!row) throw fail("candidate_not_found", "Candidate not found", 404);
    const i = {
      ...common,
      actorUserId: userId,
      fanId: input.candidateId,
      candidateId: input.candidateId,
      action: input.action,
      priority: 100,
      manual: true,
      source: "manual_candidate",
    };
    if (input.action === "retry" && !row.latestDeliveryId)
      throw fail("DELIVERY_NOT_FOUND", "Candidate has no delivery to retry", 404);
    if (input.action === "retry" && row.latestDeliveryId)
      value = await require("./automation-action-delivery-service").retryActionDelivery({
        ...i,
        deliveryId: row.latestDeliveryId,
      });
    else if (input.module === "follow_back")
      value =
        await require("./follow-back-service")[input.action === "follow" ? "planFollowBack" : "setCandidateState"](i);
    else if (input.module === "follow")
      value =
        await require("./follow-automation-service")[
          input.action === "refollow" ? "planFollowAutomation" : "setFollowAutomationCandidateState"
        ](i);
    else if (input.module === "likes")
      value = await require("./likes-service")[input.action === "like" ? "planLikes" : "setLikeCandidateState"]({
        ...i,
        candidateIds: [row.id],
      });
    else value = await require("./sfs-service").setSfsCandidateState(i);
  } else if (p.family === "automation_delivery") {
    const owner = require("./automation-action-delivery-service");
    if (p.operation === "retry_safe") {
      const rows = await db.automationDelivery.findMany({
        where: {
          agencyId,
          creatorId,
          originKind: "AUTOMATION",
          status: "FAILED",
          failureCategory: { in: require("./automation-failure-taxonomy").SAFE_RETRY_CATEGORIES },
          ...(input.moduleKey ? { moduleKey: input.moduleKey } : {}),
        },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: input.limit || 100,
        select: { id: true },
      });
      for (const row of rows) await owner.retryActionDelivery({ ...common, actorUserId: userId, deliveryId: row.id });
      value = { requested: rows.length, retried: rows.length };
    } else {
      const row = await db.automationDelivery.findFirst({
        where: { agencyId, creatorId, id: input.deliveryId, originKind: "AUTOMATION" },
      });
      if (!row) throw fail("DELIVERY_NOT_FOUND", "Delivery not found", 404);
      value = await owner[
        { retry: "retryActionDelivery", cancel: "cancelActionDelivery", release: "releaseClaimByAdmin" }[p.operation]
      ]({ ...common, actorUserId: userId, ...input });
    }
  } else if (p.family === "automation_plan") {
    const map = {
      follow_back: ["follow-back-service", "planFollowBack"],
      follow: ["follow-automation-service", "planFollowAutomation"],
      bumps: ["bump-service", "planBumps"],
      bumps_auto: ["bump-service", "planConfiguredBumpsNow"],
      bump_replies: ["bump-service", "triggerPendingReplyScan"],
      likes: ["likes-service", "planLikes"],
      likes_discover: ["likes-service", "scheduleLikesDiscovery"],
      sfs: ["sfs-service", "planSfsTargets"],
      sfs_discover: ["sfs-service", "scheduleSfsDiscovery"],
    };
    const [file, method] = map[p.operation];
    // Current-fan refresh is part of the same durable transaction, not a post-commit gap.
    const scheduleFanRefresh = (arg) =>
      require("./fan-data-authority-service").scheduleFanDataPointRefresh({ ...arg, db });
    value = await require("./" + file)[method]({
      ...common,
      ...input,
      scheduleFanRefresh,
      priority: 100,
      manual: true,
    });
  } else if (p.family === "analytics_refresh") {
    const earnings = await require("./analytics-collection-planner").ensureAnalyticsFreshness({
      db,
      agencyId,
      creatorId,
      rangeKey: input.rangeKey,
      reason: "INTERACTIVE_REFRESH",
      priority: 100,
      now,
    });
    await require("./creator-analytics-sync-orchestrator").ensureRecurringCreatorAnalyticsCatchups({
      db,
      agencyId,
      creatorId,
      priority: 95,
      now,
    });
    const subscribers = await require("./subscriber-directory-service").scheduleSubscriberScan({
      ...common,
      manual: true,
      force: true,
      priority: 90,
      reason: "creator_analytics_refresh",
    });
    value = { rangeKey: earnings.rangeKey, subscriberJobId: subscribers.job?.id || subscribers.run?.jobId || null };
  }
  if (value?.ok === false)
    throw fail(value.code || "OPERATION_REJECTED", value.error || "Operation could not be applied");
  const state = await db.operationalControlState.upsert({
    where: { id: stateId(agencyId, creatorId, p.family) },
    create: {
      id: stateId(agencyId, creatorId, p.family),
      agencyId,
      creatorId,
      family: p.family,
      lastOperation: p.operation,
      revision: 1,
    },
    update: { lastOperation: p.operation, revision: { increment: 1 } },
  });
  const outcome = {
    ok: true,
    creatorId,
    family: p.family,
    operation: p.operation,
    committedControlRevision: state.revision,
    ...compact(value || {}),
  };
  if (Buffer.byteLength(JSON.stringify(outcome)) > 6000)
    throw fail("OPERATION_RECEIPT_LIMIT", "Operation summary exceeds limit", 413);
  return { humanReference: { outcome } };
}
module.exports = { snapshot, authorizeExtra, apply };

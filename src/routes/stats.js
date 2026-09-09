/* src/routes/stats.js
   Current relational Creator Analytics/Stats routes plus explicit 410 tombstones
   for the retired snapshot generation. Mounted at /api/stats; auth/access is
   resolved per creator and current analytics ranges use analytics-range-contract.
*/

"use strict";

const express = require("express");
const crypto = require("node:crypto");
const { z } = require("zod");
const prisma = require("../prisma");
const { requireAuthDevice } = require("../middleware/auth");
const { resolveEffectivePermissions } = require("../services/team-access-control");
const { requireCreatorAccess, allowedCreatorScope } = require("../middleware/automation-permissions");
const { readCampaignFans } = require("../services/creator-analytics-ledger-service");
const { readCreatorOverview, readCreatorCurrentTask, readCreatorTaskActivity, readCreatorTaskActivityDays } = require("../services/creator-overview-service");
const { recordNotificationSocketEvent } = require("../services/notification-sync-state-service");
const { ensureRecurringCreatorAnalyticsCatchups } = require("../services/creator-analytics-sync-orchestrator");
const { ingestNotificationFacts, normalizeEvent: normalizeNotificationFact } = require("../services/notification-facts-service");
const { scheduleSubscriberScan } = require("../services/subscriber-directory-service");
const { ensureAnalyticsFreshness } = require("../services/analytics-collection-planner");
const { normalizeCreatorOverviewRangeKey } = require("../services/analytics-range-contract");
const { dbAuthorityNow } = require("../services/db-time-authority-service");
const { capabilityFreshnessWindow } = require("../services/capability-freshness-authority-service");
const {
  startManualNotificationScan,
  stopManualNotificationScan,
  readManualNotificationScan,
} = require("../services/notification-scan-control-service");
const {
  startManualFinancialTransactionScan,
  stopManualFinancialTransactionScan,
  readManualFinancialTransactionScan,
} = require("../services/financial-transaction-scan-control-service");
const {
  startManualCampaignScan,
  stopManualCampaignScan,
  readManualCampaignScan,
} = require("../services/campaign-scan-control-service");

const router = express.Router();


function requireEarningsPermission(res, member) {
  if (member?.permissions?.["money.view_earnings"] === true) return true;
  res.status(403).json({ ok: false, code: "FEATURE_FORBIDDEN", permission: "money.view_earnings", error: "money.view_earnings permission is required" });
  return false;
}

function requireRefreshPermission(res, member) {
  if (member?.permissions?.["creator_analytics.refresh"] === true) return true;
  res.status(403).json({ ok: false, code: "FEATURE_FORBIDDEN", permission: "creator_analytics.refresh", error: "creator_analytics.refresh permission is required" });
  return false;
}


function actorUserId(req) {
  return req.auth?.userId || req.user?.id || null;
}

// ════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════

function validationError(res, err) {
  return res.status(400).json({
    ok: false,
    code: "VALIDATION_ERROR",
    error: err.issues?.[0]?.message || "Validation error",
    issues: err.issues || [],
  });
}

async function effectiveCurrentMember(req) {
  const member = req.auth?.membership || req.member || null;
  if (!member || String(member.agencyId || "") !== String(req.auth?.agencyId || "")) return null;
  return { ...member, permissions: await resolveEffectivePermissions({ member, db: prisma }) };
}

// Creator-level Stats always uses the canonical assigned creator authority.
async function loadCreatorWithAccess(req, res, creatorId) {
  try {
    const member = await effectiveCurrentMember(req);
    if (!member) {
      res.status(403).json({ ok: false, code: "NOT_A_MEMBER", error: "Not a current member of this agency" });
      return null;
    }
    const creator = await requireCreatorAccess({
      agencyId: req.auth.agencyId,
      member,
      creatorId: String(creatorId || ""),
      db: prisma,
    });
    const fullCreator = await prisma.creatorAccount.findFirst({ where: { id: creator.id, agencyId: req.auth.agencyId, deletedAt: null } });
    return { creator: fullCreator || creator, member };
  } catch (error) {
    res.status(Number(error?.status) || 403).json({
      ok: false,
      code: error?.code || "CREATOR_ACCESS_FORBIDDEN",
      error: error?.message || "Creator access denied",
    });
    return null;
  }
}

// Agency convenience endpoints are still member-scoped: membership never
// implies access to every creator in the agency.
async function loadAgencyAccess(req, res, agencyId) {
  if (String(agencyId || "") !== String(req.auth?.agencyId || "")) {
    res.status(403).json({ ok: false, code: "AGENCY_FORBIDDEN", error: "No access to agency" });
    return null;
  }
  const agency = await prisma.agency.findFirst({ where: { id: req.auth.agencyId, deletedAt: null } });
  if (!agency) {
    res.status(404).json({ ok: false, code: "AGENCY_NOT_FOUND", error: "Agency not found" });
    return null;
  }
  const member = await effectiveCurrentMember(req);
  if (!member) {
    res.status(403).json({ ok: false, code: "NOT_A_MEMBER", error: "Not a current member of this agency" });
    return null;
  }
  const scope = await allowedCreatorScope({ agencyId: agency.id, member, db: prisma });
  return { agency, member, scope };
}

async function requireFreshAnalyticsReporter({ req, creator, suppliedDeviceId }) {
  const userId = actorUserId(req);
  const boundDeviceId = requireAuthDevice(req, suppliedDeviceId, {
    requiredCode: "ANALYTICS_DEVICE_BOUND_TOKEN_REQUIRED",
    mismatchCode: "DEVICE_IDENTITY_MISMATCH",
  });
  const authorityNow = await dbAuthorityNow({ db: prisma, fallbackNow: new Date() });
  const freshnessWindow = capabilityFreshnessWindow(authorityNow, 10 * 60 * 1000);
  const device = await prisma.workerDevice.findFirst({
    where: { id: boundDeviceId, userId, agencyId: creator.agencyId, lastSeenAt: freshnessWindow },
    select: { id: true },
  });
  if (!device) {
    const error = new Error("The authenticated reporting device is not active in this agency");
    error.code = "ANALYTICS_DEVICE_FORBIDDEN";
    error.status = 403;
    throw error;
  }
  const member = req.auth?.membership || req.member || null;
  const binding = await prisma.deviceCreatorBinding.findFirst({
    where: {
      deviceId: device.id,
      creatorId: creator.id,
      agencyId: creator.agencyId,
      status: "ACTIVE",
      sessionReadReady: true,
      lastSeenAt: freshnessWindow,
      ...(Number.isInteger(Number(member?.accessEpoch)) ? { accessEpoch: Number(member.accessEpoch) } : {}),
    },
    select: { id: true },
  });
  if (!binding) {
    const error = new Error("The authenticated reporting device has no fresh SESSION_READ capability for this creator");
    error.code = "ANALYTICS_CREATOR_CAPABILITY_STALE";
    error.status = 409;
    throw error;
  }
  return device;
}

// ════════════════════════════════════════════════════════════
// Retired snapshot-era Stats generation.
// These endpoints intentionally remain mounted as explicit 410 tombstones so
// old clients cannot mutate or accidentally read a second analytics truth.
// ════════════════════════════════════════════════════════════

function legacyStatsGone(_req, res) {
  return res.status(410).json({
    ok: false,
    code: "ANALYTICS_LEGACY_STATS_RETIRED",
    error: "This snapshot-era Analytics endpoint has been retired. Use the current analytics read model.",
  });
}

router.post("/earnings/upsert", legacyStatsGone);
router.post("/campaigns/upsert", legacyStatsGone);
router.get("/creators/:creatorId/earnings", legacyStatsGone);
router.get("/creators/:creatorId/campaigns", legacyStatsGone);
router.get("/creators/:creatorId/overview", legacyStatsGone);
router.get("/agencies/:agencyId/earnings/summary", legacyStatsGone);
router.post("/agencies/:agencyId/refresh", legacyStatsGone);
router.get("/creators/:creatorId/ledger-overview", legacyStatsGone);
router.get("/creators/:creatorId/ledger-coverage", legacyStatsGone);
router.post("/creators/:creatorId/messages-daily", legacyStatsGone);

// Current Creator Analytics refresh: one earnings freshness demand plus the
// already-canonical non-earnings catch-up/subscriber control planes.
router.post("/creators/:creatorId/refresh", async (req, res) => {
  try {
    const ctx = await loadCreatorWithAccess(req, res, req.params.creatorId);
    if (!ctx) return;
    if (!requireRefreshPermission(res, ctx.member)) return;
    const { creator } = ctx;
    let range;
    try {
      range = normalizeCreatorOverviewRangeKey(req.body?.rangeKey || req.query?.rangeKey || "30d");
    } catch {
      return res.status(400).json({
        ok: false, code: "INVALID_OVERVIEW_RANGE",
        error: `Invalid overview range: ${String(req.body?.rangeKey || req.query?.rangeKey || "")}`,
      });
    }
    const now = new Date();
    const [earnings, analyticsCatchups, subscribers] = await Promise.all([
      ensureAnalyticsFreshness({
        db: prisma,
        creatorId: creator.id,
        agencyId: creator.agencyId,
        rangeKey: range,
        reason: "INTERACTIVE_REFRESH",
        priority: 100,
        now,
      }),
      ensureRecurringCreatorAnalyticsCatchups({ creatorId: creator.id, agencyId: creator.agencyId, now, priority: 95 }),
      scheduleSubscriberScan({
        agencyId: creator.agencyId,
        creatorId: creator.id,
        userId: actorUserId(req),
        manual: true,
        force: true,
        priority: 90,
        reason: "creator_analytics_refresh",
      }),
    ]);
    return res.json({
      ok: true,
      rangeKey: earnings.rangeKey,
      earnings: {
        dueDays: earnings.dueDays,
        windows: earnings.windows,
        created: earnings.created,
        reused: earnings.reused,
        jobs: earnings.jobs.map((job) => ({ id: job?.id || null, status: job?.status || null })),
      },
      analyticsCatchups: {
        ready: analyticsCatchups.ready === true,
        created: analyticsCatchups.created || [],
        skipped: analyticsCatchups.skipped || [],
        initial: analyticsCatchups.initial || null,
      },
      subscriberJobId: subscribers.job?.id || subscribers.run?.jobId || null,
    });
  } catch (err) {
    const status = Number(err?.status) || (err?.code === "ANALYTICS_RANGE_INVALID" ? 400 : 500);
    console.error("[stats/refresh-creator] failed:", err);
    return res.status(status).json({ ok: false, code: err?.code || "REFRESH_FAILED", error: err?.message || "Failed" });
  }
});

const liveNotificationSchema = z.object({
  deviceId: z.string().min(3).max(160),
  batchId: z.string().min(8).max(80).regex(/^[A-Za-z0-9._-]+$/),
  observedAt: z.string().datetime({ offset: true }),
  sourceTimezone: z.literal("UTC").default("UTC"),
  events: z.array(z.record(z.unknown())).min(1).max(100),
});

router.get("/creators/:creatorId/overview-v2", async (req, res) => {
  try {
    const ctx = await loadCreatorWithAccess(req, res, String(req.params.creatorId || ""));
    if (!ctx) return;
    if (!requireEarningsPermission(res, ctx.member)) return;
    let rangeKey;
    try {
      rangeKey = normalizeCreatorOverviewRangeKey(req.query.range || "30d");
    } catch {
      return res.status(400).json({ ok: false, code: "INVALID_OVERVIEW_RANGE", error: `Invalid overview range: ${String(req.query.range || "")}` });
    }
    const overview = await readCreatorOverview({ creatorId: ctx.creator.id, rangeKey });
    return res.json(overview);
  } catch (error) {
    console.error("[stats/overview-v2] failed:", error);
    return res.status(500).json({ ok: false, code: "CREATOR_OVERVIEW_FAILED", error: error?.message || "Failed" });
  }
});

router.get("/creators/:creatorId/current-task", async (req, res) => {
  try {
    const ctx = await loadCreatorWithAccess(req, res, String(req.params.creatorId || ""));
    if (!ctx) return;
    if (!requireEarningsPermission(res, ctx.member)) return;
    const task = await readCreatorCurrentTask({ creatorId: ctx.creator.id });
    return res.json({ ok: true, creatorId: ctx.creator.id, task });
  } catch (error) {
    console.error("[stats/current-task] failed:", error);
    return res.status(500).json({ ok: false, code: "CREATOR_CURRENT_TASK_FAILED", error: error?.message || "Failed" });
  }
});

router.get("/creators/:creatorId/task-activity", async (req, res) => {
  try {
    const ctx = await loadCreatorWithAccess(req, res, String(req.params.creatorId || ""));
    if (!ctx) return;
    if (!requireEarningsPermission(res, ctx.member)) return;
    const day = String(req.query.day || "").trim() || null;
    if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return res.status(400).json({ ok: false, code: "INVALID_ACTIVITY_DAY", error: "day must be YYYY-MM-DD" });
    }
    const limit = Math.max(1, Math.min(5000, Number.parseInt(String(req.query.limit || "240"), 10) || 240));
    const [items, days] = await Promise.all([
      readCreatorTaskActivity({ creatorId: ctx.creator.id, day, limit }),
      readCreatorTaskActivityDays({ creatorId: ctx.creator.id }),
    ]);
    return res.json({ ok: true, creatorId: ctx.creator.id, retentionDays: 30, days, items });
  } catch (error) {
    console.error("[stats/task-activity] failed:", error);
    return res.status(500).json({ ok: false, code: "CREATOR_TASK_ACTIVITY_FAILED", error: error?.message || "Failed" });
  }
});

router.get("/creators/:creatorId/campaigns/:campaignId/fans", async (req, res) => {
  try {
    const ctx = await loadCreatorWithAccess(req, res, String(req.params.creatorId || ""));
    if (!ctx) return;
    if (!requireEarningsPermission(res, ctx.member)) return;
    const limit = Math.max(1, Math.min(100, Number.parseInt(String(req.query.limit || "50"), 10) || 50));
    const offset = Math.max(0, Math.min(1_000_000, Number.parseInt(String(req.query.offset || "0"), 10) || 0));
    const campaignId = String(req.params.campaignId || "");
    if (!campaignId || campaignId.length > 220) {
      return res.status(400).json({ ok: false, code: "INVALID_CAMPAIGN_ID", error: "Invalid campaign id" });
    }
    let rangeKey = null;
    if (String(req.query.range || "").trim()) {
      try {
        rangeKey = normalizeCreatorOverviewRangeKey(req.query.range);
      } catch {
        return res.status(400).json({ ok: false, code: "INVALID_CAMPAIGN_FAN_RANGE", error: `Invalid campaign fan range: ${String(req.query.range || "")}` });
      }
    }
    const result = await readCampaignFans({
      creatorId: ctx.creator.id,
      campaignId,
      limit,
      offset,
      rangeKey,
    });
    if (!result) return res.status(404).json({ ok: false, code: "CAMPAIGN_NOT_FOUND", error: "Campaign not found for this creator" });
    return res.json({ ok: true, creatorId: ctx.creator.id, ...result });
  } catch (error) {
    console.error("[stats/campaign-fans] failed:", error);
    return res.status(500).json({ ok: false, code: "CAMPAIGN_FANS_FAILED", error: error?.message || "Failed" });
  }
});


// Manual Notifications ALL scanner used by the Creator Analytics development
// workspace. These endpoints deliberately schedule only the existing
// catchup_notifications_scan JobInstance; they do not start earnings,
// campaigns, subscribers, message aggregation, or any private worker loop.
router.get("/creators/:creatorId/notification-scan", async (req, res) => {
  try {
    const ctx = await loadCreatorWithAccess(req, res, String(req.params.creatorId || ""));
    if (!ctx) return;
    if (!requireEarningsPermission(res, ctx.member)) return;
    const outcome = String(req.query.outcome || "ALL").trim().toUpperCase();
    const limit = Math.max(1, Math.min(200, Number.parseInt(String(req.query.limit || "100"), 10) || 100));
    const offset = Math.max(0, Math.min(1_000_000, Number.parseInt(String(req.query.offset || "0"), 10) || 0));
    const result = await readManualNotificationScan({ creator: ctx.creator, outcome, limit, offset });
    return res.json(result);
  } catch (error) {
    const message = error?.message || "Failed";
    const validation = /invalid notification scan outcome/i.test(message);
    console.error("[stats/notification-scan] failed:", error);
    return res.status(validation ? 400 : 500).json({
      ok: false,
      code: validation ? "INVALID_NOTIFICATION_SCAN_FILTER" : "NOTIFICATION_SCAN_READ_FAILED",
      error: message,
    });
  }
});

router.post("/creators/:creatorId/notification-scan/start", async (req, res) => {
  try {
    const ctx = await loadCreatorWithAccess(req, res, String(req.params.creatorId || ""));
    if (!ctx) return;
    if (!requireRefreshPermission(res, ctx.member)) return;
    const started = await startManualNotificationScan({
      creator: ctx.creator,
      requestedByUserId: actorUserId(req),
      now: new Date(),
      forceFull: req.body?.forceFull === true,
    });
    const result = await readManualNotificationScan({ creator: ctx.creator, outcome: "ALL", limit: 100, offset: 0 });
    return res.json({ ...result, action: started.action });
  } catch (error) {
    console.error("[stats/notification-scan/start] failed:", error);
    return res.status(500).json({ ok: false, code: "NOTIFICATION_SCAN_START_FAILED", error: error?.message || "Failed" });
  }
});

router.post("/creators/:creatorId/notification-scan/stop", async (req, res) => {
  try {
    const ctx = await loadCreatorWithAccess(req, res, String(req.params.creatorId || ""));
    if (!ctx) return;
    if (!requireRefreshPermission(res, ctx.member)) return;
    const stopped = await stopManualNotificationScan({ creatorId: ctx.creator.id, now: new Date() });
    const result = await readManualNotificationScan({ creator: ctx.creator, outcome: "ALL", limit: 100, offset: 0 });
    return res.json({ ...result, action: stopped.action });
  } catch (error) {
    console.error("[stats/notification-scan/stop] failed:", error);
    return res.status(500).json({ ok: false, code: "NOTIFICATION_SCAN_STOP_FAILED", error: error?.message || "Failed" });
  }
});


// Manual all-time payout transaction scanner. It is intentionally separate
// from Notifications so transaction experiments never rescan notification history.
router.get("/creators/:creatorId/financial-transaction-scan", async (req, res) => {
  try {
    const ctx = await loadCreatorWithAccess(req, res, String(req.params.creatorId || ""));
    if (!ctx) return;
    if (!requireEarningsPermission(res, ctx.member)) return;
    const limit = Math.max(1, Math.min(200, Number.parseInt(String(req.query.limit || "100"), 10) || 100));
    const offset = Math.max(0, Math.min(1_000_000, Number.parseInt(String(req.query.offset || "0"), 10) || 0));
    return res.json(await readManualFinancialTransactionScan({ creator: ctx.creator, limit, offset }));
  } catch (error) {
    console.error("[stats/financial-transaction-scan] failed:", error);
    return res.status(500).json({ ok: false, code: "FINANCIAL_TRANSACTION_SCAN_READ_FAILED", error: error?.message || "Failed" });
  }
});

router.post("/creators/:creatorId/financial-transaction-scan/start", async (req, res) => {
  try {
    const ctx = await loadCreatorWithAccess(req, res, String(req.params.creatorId || ""));
    if (!ctx) return;
    if (!requireEarningsPermission(res, ctx.member)) return;
    if (!requireRefreshPermission(res, ctx.member)) return;
    const started = await startManualFinancialTransactionScan({ creator: ctx.creator, requestedByUserId: actorUserId(req), now: new Date() });
    const result = await readManualFinancialTransactionScan({ creator: ctx.creator, limit: 100, offset: 0 });
    return res.json({ ...result, action: started.action });
  } catch (error) {
    console.error("[stats/financial-transaction-scan/start] failed:", error);
    return res.status(500).json({ ok: false, code: "FINANCIAL_TRANSACTION_SCAN_START_FAILED", error: error?.message || "Failed" });
  }
});

router.post("/creators/:creatorId/financial-transaction-scan/stop", async (req, res) => {
  try {
    const ctx = await loadCreatorWithAccess(req, res, String(req.params.creatorId || ""));
    if (!ctx) return;
    if (!requireEarningsPermission(res, ctx.member)) return;
    if (!requireRefreshPermission(res, ctx.member)) return;
    const stopped = await stopManualFinancialTransactionScan({ creatorId: ctx.creator.id, now: new Date() });
    const result = await readManualFinancialTransactionScan({ creator: ctx.creator, limit: 100, offset: 0 });
    return res.json({ ...result, action: stopped.action });
  } catch (error) {
    console.error("[stats/financial-transaction-scan/stop] failed:", error);
    return res.status(500).json({ ok: false, code: "FINANCIAL_TRANSACTION_SCAN_STOP_FAILED", error: error?.message || "Failed" });
  }
});

// Manual campaign/claimer scanner. Kept isolated from Notifications and the
// all-in-one refresh endpoint so campaign development never replays unrelated
// sources. The underlying fetch_campaigns collector already walks campaign
// pages and each campaign's claimer pages to source exhaustion.
router.get("/creators/:creatorId/campaign-scan", async (req, res) => {
  try {
    const ctx = await loadCreatorWithAccess(req, res, String(req.params.creatorId || ""));
    if (!ctx) return;
    if (!requireEarningsPermission(res, ctx.member)) return;
    const limit = Math.max(1, Math.min(200, Number.parseInt(String(req.query.limit || "100"), 10) || 100));
    const offset = Math.max(0, Math.min(1_000_000, Number.parseInt(String(req.query.offset || "0"), 10) || 0));
    return res.json(await readManualCampaignScan({ creator: ctx.creator, limit, offset }));
  } catch (error) {
    console.error("[stats/campaign-scan] failed:", error);
    return res.status(500).json({ ok: false, code: "CAMPAIGN_SCAN_READ_FAILED", error: error?.message || "Failed" });
  }
});

router.post("/creators/:creatorId/campaign-scan/start", async (req, res) => {
  try {
    const ctx = await loadCreatorWithAccess(req, res, String(req.params.creatorId || ""));
    if (!ctx) return;
    if (!requireEarningsPermission(res, ctx.member)) return;
    if (!requireRefreshPermission(res, ctx.member)) return;
    const started = await startManualCampaignScan({ creator: ctx.creator, requestedByUserId: actorUserId(req), now: new Date() });
    const result = await readManualCampaignScan({ creator: ctx.creator, limit: 100, offset: 0 });
    return res.json({ ...result, action: started.action });
  } catch (error) {
    console.error("[stats/campaign-scan/start] failed:", error);
    return res.status(500).json({ ok: false, code: "CAMPAIGN_SCAN_START_FAILED", error: error?.message || "Failed" });
  }
});

router.post("/creators/:creatorId/campaign-scan/stop", async (req, res) => {
  try {
    const ctx = await loadCreatorWithAccess(req, res, String(req.params.creatorId || ""));
    if (!ctx) return;
    if (!requireEarningsPermission(res, ctx.member)) return;
    if (!requireRefreshPermission(res, ctx.member)) return;
    const stopped = await stopManualCampaignScan({ creatorId: ctx.creator.id, now: new Date() });
    const result = await readManualCampaignScan({ creator: ctx.creator, limit: 100, offset: 0 });
    return res.json({ ...result, action: stopped.action });
  } catch (error) {
    console.error("[stats/campaign-scan/stop] failed:", error);
    return res.status(500).json({ ok: false, code: "CAMPAIGN_SCAN_STOP_FAILED", error: error?.message || "Failed" });
  }
});

router.post("/creators/:creatorId/notifications/live", async (req, res) => {
  try {
    const input = liveNotificationSchema.parse(req.body || {});
    const ctx = await loadCreatorWithAccess(req, res, String(req.params.creatorId || ""));
    if (!ctx) return;
    // Live websocket facts are reported by the authenticated device that owns
    // the fresh creator binding. Chatter devices must not need the managerial
    // "refresh analytics" permission merely to preserve realtime facts.
    const userId = actorUserId(req);
    const boundDeviceId = requireAuthDevice(req, input.deviceId, {
      requiredCode: "LIVE_NOTIFICATION_DEVICE_BOUND_TOKEN_REQUIRED",
      mismatchCode: "DEVICE_IDENTITY_MISMATCH",
    });
    const authorityNow = await dbAuthorityNow({ db: prisma, fallbackNow: new Date() });
    const freshnessWindow = capabilityFreshnessWindow(authorityNow, 10 * 60 * 1000);
    const device = await prisma.workerDevice.findFirst({
      where: { id: boundDeviceId, userId, agencyId: ctx.creator.agencyId, lastSeenAt: freshnessWindow },
      select: { id: true },
    });
    if (!device) return res.status(403).json({ ok: false, code: "LIVE_NOTIFICATION_DEVICE_FORBIDDEN", error: "The authenticated reporting device is not owned by this agency member" });
    const binding = await prisma.deviceCreatorBinding.findFirst({
      where: {
        deviceId: device.id,
        creatorId: ctx.creator.id,
        agencyId: ctx.creator.agencyId,
        status: "ACTIVE",
        realtimeReady: true,
        ...(Number.isInteger(Number(ctx.member?.accessEpoch)) ? { accessEpoch: Number(ctx.member.accessEpoch) } : {}),
        lastSeenAt: freshnessWindow,
      },
      select: { id: true },
    });
    if (!binding) return res.status(409).json({ ok: false, code: "LIVE_NOTIFICATION_REALTIME_UNAVAILABLE", error: "The authenticated reporting device has no fresh REALTIME capability for this creator" });

    const grouped = new Map();
    const dates = [];
    for (const raw of input.events) {
      const normalized = normalizeNotificationFact(raw, ctx.creator.id);
      if (!normalized.sourceType || normalized.rejected) {
        return res.status(422).json({ ok: false, code: "LIVE_NOTIFICATION_EVENT_REJECTED", error: normalized.rejected || "Unsupported live notification event" });
      }
      if (!grouped.has(normalized.sourceType)) grouped.set(normalized.sourceType, []);
      grouped.get(normalized.sourceType).push(raw);
      if (normalized.occurredAt) dates.push(normalized.occurredAt);
    }
    const observedAt = new Date(input.observedAt);
    const rangeFrom = dates.length ? new Date(Math.min(...dates.map((date) => date.getTime())) - 5 * 60 * 1000) : new Date(observedAt.getTime() - 5 * 60 * 1000);
    const rangeTo = dates.length ? new Date(Math.max(...dates.map((date) => date.getTime())) + 5 * 60 * 1000) : new Date(observedAt.getTime() + 5 * 60 * 1000);
    const logicalJob = {
      id: `live_${input.batchId}`,
      agencyId: ctx.creator.agencyId,
      creatorId: ctx.creator.id,
      sourceJobId: null,
      params: {
        from: rangeFrom.toISOString(),
        to: rangeTo.toISOString(),
        types: [...grouped.keys()],
        notificationMode: "catchup",
      },
    };
    const results = [];
    for (const [type, events] of grouped) {
      const typeHash = crypto.createHash("sha256").update(`${input.batchId}|${type}`).digest("hex").slice(0, 24);
      const result = await ingestNotificationFacts({
        db: prisma,
        job: logicalJob,
        deviceId: device.id,
        result: {
          events,
          notificationType: type,
          batchKey: `run:${input.batchId}:page:${type}:${typeHash}`,
          finalizeCoverage: false,
          sourceTimezone: input.sourceTimezone,
          scanRunId: input.batchId,
          collectorVersion: "notifications-all-v5",
          schemaVersion: 4,
          coverage: { [type]: { status: "partial" } },
        },
      });
      results.push({ type, ...result });
    }
    await recordNotificationSocketEvent({
      db: prisma,
      agencyId: ctx.creator.agencyId,
      creatorId: ctx.creator.id,
      deviceId: device.id,
      occurredAt: dates.length ? new Date(Math.max(...dates.map((date) => date.getTime()))) : observedAt,
    });
    return res.json({ ok: true, creatorId: ctx.creator.id, batchId: input.batchId, results });
  } catch (error) {
    if (error?.issues) return validationError(res, error);
    console.error("[stats/notifications-live] failed:", error);
    return res.status(Number(error?.status) || 500).json({ ok: false, code: error?.code || "LIVE_NOTIFICATION_INGEST_FAILED", error: error?.message || "Failed" });
  }
});


module.exports = router;

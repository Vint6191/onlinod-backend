/* src/routes/stats.js
   ────────────────────────────────────────────────────────────
   Creator metrics storage + retrieval.
   
   Mounted at /api/stats. Auth required (req.user populated).
   
   Write side (called by chatter machines doing the actual work):
     POST /earnings/upsert
     POST /campaigns/upsert
   
   Read side (called by owner / chatter UI):
     GET /creators/:creatorId/earnings?range=7d
     GET /creators/:creatorId/campaigns
     GET /creators/:creatorId/overview
     GET /agencies/:agencyId/earnings/summary?range=7d
   
   Refresh trigger (called when owner clicks "refresh now"):
     POST /creators/:creatorId/refresh
     POST /agencies/:agencyId/refresh
   ────────────────────────────────────────────────────────────
*/

"use strict";

const express = require("express");
const crypto = require("node:crypto");
const { z } = require("zod");
const prisma = require("../prisma");
const { scheduleJobNow } = require("../services/job-scheduler");
const { canViewEarnings, canRefreshAnalytics } = require("../services/creator-analytics-permissions");
const { sanitizeAnalyticsRaw } = require("../services/creator-analytics-sanitize");
const { readCreatorLedgerOverview, readCreatorCoverage, readCampaignFans, upsertMessagesDaily } = require("../services/creator-analytics-ledger-service");
const { buildNotificationScanParams, loadNotificationSyncState, recordNotificationSocketEvent } = require("../services/notification-sync-state-service");
const { ingestNotificationFacts, normalizeEvent: normalizeNotificationFact } = require("../services/notification-facts-service");
const { scheduleSubscriberScan } = require("../services/subscriber-directory-service");
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

const router = express.Router();


function requireEarningsPermission(res, member) {
  if (canViewEarnings(member)) return true;
  res.status(403).json({ ok: false, code: "EARNINGS_VIEW_FORBIDDEN", error: "Earnings permission is required" });
  return false;
}

function requireRefreshPermission(res, member) {
  if (canRefreshAnalytics(member)) return true;
  res.status(403).json({ ok: false, code: "ANALYTICS_REFRESH_FORBIDDEN", error: "Owner, admin, manager or analytics refresh permission is required" });
  return false;
}


function actorUserId(req) {
  return req.auth?.userId || req.user?.id || null;
}

// ════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════

const VALID_RANGES = new Set(["24h", "7d", "30d", "90d", "180d", "365d", "ytd", "prev_year", "all"]);

function validationError(res, err) {
  return res.status(400).json({
    ok: false,
    code: "VALIDATION_ERROR",
    error: err.issues?.[0]?.message || "Validation error",
    issues: err.issues || [],
  });
}

// Big numbers come back from Prisma as BigInt — JSON.stringify barfs
// on them. Coerce to Number for output. Cents fit fine in a 53-bit
// JS number until $90T. We're not there.
function bigToNum(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === "bigint") return Number(v);
  return Number(v);
}

function sanitizeCampaigns(value) {
  const clean = sanitizeAnalyticsRaw(value, {
    maxDepth: 10,
    maxArrayLength: 2000,
    maxObjectKeys: 500,
    maxStringLength: 10_000,
  });
  return Array.isArray(clean) ? clean : [];
}

function snapshotForClient(s) {
  if (!s) return null;
  return {
    id: s.id,
    creatorId: s.creatorId,
    rangeKey: s.rangeKey,
    rangeStartAt: s.rangeStartAt,
    rangeEndAt: s.rangeEndAt,
    summary: {
      total: bigToNum(s.totalCents),
      gross: bigToNum(s.grossCents),
      delta: bigToNum(s.deltaCents),
      avgSale: bigToNum(s.avgSaleCents),
      fanLtv: bigToNum(s.fanLtvCents),
      salesCount: s.salesCount,
      uniqueFans: s.uniqueFans,
    },
    capturedAt: s.capturedAt,
    capturedByDeviceId: s.capturedByDeviceId,
    raw: sanitizeAnalyticsRaw(s.raw),
    staleSeconds: Math.max(0, Math.floor((Date.now() - new Date(s.capturedAt).getTime()) / 1000)),
  };
}

async function requireMembership(userId, agencyId) {
  if (!userId || !agencyId) return null;

  return prisma.agencyMember.findFirst({
    where: {
      agencyId,
      userId,
      deletedAt: null,
      agency: { deletedAt: null },
    },
  });
}

// Look up a creator by id and return both the creator and the
// caller's membership in its agency. 403 if caller can't access.
async function loadCreatorWithAccess(req, res, creatorId) {
  const creator = await prisma.creatorAccount.findUnique({
    where: { id: creatorId },
  });
  if (!creator || creator.deletedAt) {
    res.status(404).json({ ok: false, code: "CREATOR_NOT_FOUND", error: "Creator not found" });
    return null;
  }

  const member = await requireMembership(actorUserId(req), creator.agencyId);
  if (!member) {
    res.status(403).json({ ok: false, code: "NOT_A_MEMBER", error: "Not a member of this agency" });
    return null;
  }

  return { creator, member };
}

// Same but for agency-level endpoints.
async function loadAgencyAccess(req, res, agencyId) {
  const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
  if (!agency || agency.deletedAt) {
    res.status(404).json({ ok: false, code: "AGENCY_NOT_FOUND", error: "Agency not found" });
    return null;
  }

  const member = await requireMembership(actorUserId(req), agency.id);
  if (!member) {
    res.status(403).json({ ok: false, code: "NOT_A_MEMBER", error: "Not a member of this agency" });
    return null;
  }

  return { agency, member };
}

// ════════════════════════════════════════════════════════════
// POST /earnings/upsert — chatter machine writes earnings result
// ════════════════════════════════════════════════════════════

const earningsUpsertSchema = z.object({
  deviceId: z.string().min(1), // who is reporting
  creatorId: z.string().min(1),
  rangeKey: z.string().refine((v) => VALID_RANGES.has(v), "Invalid rangeKey"),
  range: z
    .object({
      startDate: z.string(),
      endDate: z.string(),
    })
    .optional(),
  summary: z.object({
    total: z.number(),
    gross: z.number().optional(),
    delta: z.number().optional(),
    avgSale: z.number().optional(),
    fanLtv: z.number().optional(),
    salesCount: z.number().int().nonnegative(),
    uniqueFans: z.number().int().nonnegative(),
  }),
  raw: z.any().optional(),
});

router.post("/earnings/upsert", async (req, res) => {
  try {
    const input = earningsUpsertSchema.parse(req.body);
    const userId = actorUserId(req);

    // Validate device → it must belong to this user.
    const device = await prisma.workerDevice.findUnique({ where: { id: input.deviceId } });
    if (!device) {
      return res.status(404).json({ ok: false, code: "DEVICE_NOT_FOUND", error: "Device not found. Heartbeat first." });
    }
    if (device.userId !== userId) {
      return res.status(403).json({ ok: false, code: "NOT_YOUR_DEVICE", error: "This deviceId is not yours" });
    }

    // Validate creator + access.
    const ctx = await loadCreatorWithAccess(req, res, input.creatorId);
    if (!ctx) return;
    const { creator } = ctx;

    const data = {
      creatorId: creator.id,
      agencyId: creator.agencyId,
      rangeKey: input.rangeKey,
      rangeStartAt: input.range?.startDate ? new Date(input.range.startDate) : null,
      rangeEndAt: input.range?.endDate ? new Date(input.range.endDate) : null,
      totalCents: Math.round(input.summary.total),
      grossCents: Math.round(input.summary.gross || 0),
      deltaCents: Math.round(input.summary.delta || 0),
      avgSaleCents: Math.round(input.summary.avgSale || 0),
      fanLtvCents: Math.round(input.summary.fanLtv || 0),
      salesCount: input.summary.salesCount,
      uniqueFans: input.summary.uniqueFans,
      raw: sanitizeAnalyticsRaw(input.raw),
      capturedAt: new Date(),
      capturedByDeviceId: device.id,
      capturedByUserId: userId,
    };

    const snapshot = await prisma.creatorEarningsSnapshot.upsert({
      where: { creatorId_rangeKey: { creatorId: creator.id, rangeKey: input.rangeKey } },
      create: data,
      update: data,
    });

    return res.json({
      ok: true,
      snapshot: snapshotForClient(snapshot),
    });
  } catch (err) {
    if (err?.issues) return validationError(res, err);
    console.error("[stats/earnings/upsert] failed:", err);
    return res.status(500).json({
      ok: false,
      code: "EARNINGS_UPSERT_FAILED",
      error: err?.message || "Failed",
    });
  }
});

// ════════════════════════════════════════════════════════════
// POST /campaigns/upsert
// ════════════════════════════════════════════════════════════

const campaignsUpsertSchema = z.object({
  deviceId: z.string().min(1),
  creatorId: z.string().min(1),
  rangeKey: z.string().optional(),
  campaigns: z.array(z.any()).max(2000),
});

router.post("/campaigns/upsert", async (req, res) => {
  try {
    const input = campaignsUpsertSchema.parse(req.body);
    const userId = actorUserId(req);

    const device = await prisma.workerDevice.findUnique({ where: { id: input.deviceId } });
    if (!device || device.userId !== userId) {
      return res.status(403).json({ ok: false, code: "NOT_YOUR_DEVICE", error: "Invalid device" });
    }

    const ctx = await loadCreatorWithAccess(req, res, input.creatorId);
    if (!ctx) return;
    const { creator } = ctx;

    const cleanCampaigns = sanitizeCampaigns(input.campaigns);
    let active = 0,
      claimers = 0,
      clicks = 0;
    for (const c of cleanCampaigns) {
      if (c?.is_active) active += 1;
      claimers += Number(c?.claimers_count || 0);
      clicks += Number(c?.clicks_count || 0);
    }

    const data = {
      creatorId: creator.id,
      agencyId: creator.agencyId,
      rangeKey: input.rangeKey || "7d",
      campaigns: cleanCampaigns,
      totalActive: active,
      totalClaimers: claimers,
      totalClicks: clicks,
      capturedAt: new Date(),
      capturedByDeviceId: device.id,
      capturedByUserId: userId,
    };

    const snapshot = await prisma.creatorCampaignsSnapshot.upsert({
      where: { creatorId: creator.id },
      create: data,
      update: data,
    });

    return res.json({
      ok: true,
      snapshot: {
        id: snapshot.id,
        creatorId: snapshot.creatorId,
        rangeKey: snapshot.rangeKey,
        campaigns: sanitizeCampaigns(snapshot.campaigns),
        totals: { active, claimers, clicks },
        capturedAt: snapshot.capturedAt,
        staleSeconds: 0,
      },
    });
  } catch (err) {
    if (err?.issues) return validationError(res, err);
    console.error("[stats/campaigns/upsert] failed:", err);
    return res.status(500).json({
      ok: false,
      code: "CAMPAIGNS_UPSERT_FAILED",
      error: err?.message || "Failed",
    });
  }
});

// ════════════════════════════════════════════════════════════
// GET /creators/:creatorId/earnings?range=7d
// ════════════════════════════════════════════════════════════

router.get("/creators/:creatorId/earnings", async (req, res) => {
  try {
    const ctx = await loadCreatorWithAccess(req, res, req.params.creatorId);
    if (!ctx) return;
    if (!requireEarningsPermission(res, ctx.member)) return;

    const range = String(req.query.range || "7d");
    if (!VALID_RANGES.has(range)) {
      return res.status(400).json({ ok: false, code: "INVALID_RANGE", error: `Invalid range: ${range}` });
    }

    const snapshot = await prisma.creatorEarningsSnapshot.findUnique({
      where: { creatorId_rangeKey: { creatorId: ctx.creator.id, rangeKey: range } },
    });

    if (!snapshot) {
      return res.json({
        ok: true,
        snapshot: null,
        creatorId: ctx.creator.id,
        rangeKey: range,
      });
    }

    return res.json({ ok: true, snapshot: snapshotForClient(snapshot) });
  } catch (err) {
    console.error("[stats/earnings/get] failed:", err);
    return res.status(500).json({ ok: false, code: "EARNINGS_GET_FAILED", error: err?.message || "Failed" });
  }
});

// ════════════════════════════════════════════════════════════
// GET /creators/:creatorId/campaigns
// ════════════════════════════════════════════════════════════

router.get("/creators/:creatorId/campaigns", async (req, res) => {
  try {
    const ctx = await loadCreatorWithAccess(req, res, req.params.creatorId);
    if (!ctx) return;
    if (!requireEarningsPermission(res, ctx.member)) return;

    const snapshot = await prisma.creatorCampaignsSnapshot.findUnique({
      where: { creatorId: ctx.creator.id },
    });

    if (!snapshot) {
      return res.json({ ok: true, snapshot: null, creatorId: ctx.creator.id });
    }

    return res.json({
      ok: true,
      snapshot: {
        id: snapshot.id,
        creatorId: snapshot.creatorId,
        rangeKey: snapshot.rangeKey,
        campaigns: sanitizeCampaigns(snapshot.campaigns),
        totals: {
          active: snapshot.totalActive,
          claimers: snapshot.totalClaimers,
          clicks: snapshot.totalClicks,
        },
        capturedAt: snapshot.capturedAt,
        staleSeconds: Math.max(0, Math.floor((Date.now() - new Date(snapshot.capturedAt).getTime()) / 1000)),
      },
    });
  } catch (err) {
    console.error("[stats/campaigns/get] failed:", err);
    return res.status(500).json({ ok: false, code: "CAMPAIGNS_GET_FAILED", error: err?.message || "Failed" });
  }
});

// ════════════════════════════════════════════════════════════
// GET /creators/:creatorId/overview — earnings + campaigns combined
// ════════════════════════════════════════════════════════════

router.get("/creators/:creatorId/overview", async (req, res) => {
  try {
    const ctx = await loadCreatorWithAccess(req, res, req.params.creatorId);
    if (!ctx) return;
    if (!requireEarningsPermission(res, ctx.member)) return;

    const range = String(req.query.range || "7d");
    if (!VALID_RANGES.has(range)) {
      return res.status(400).json({ ok: false, code: "INVALID_RANGE", error: `Invalid range: ${range}` });
    }

    const [earnings, campaigns, allRanges] = await Promise.all([
      prisma.creatorEarningsSnapshot.findUnique({
        where: { creatorId_rangeKey: { creatorId: ctx.creator.id, rangeKey: range } },
      }),
      prisma.creatorCampaignsSnapshot.findUnique({
        where: { creatorId: ctx.creator.id },
      }),
      prisma.creatorEarningsSnapshot.findMany({
        where: { creatorId: ctx.creator.id },
        select: { rangeKey: true, capturedAt: true, totalCents: true },
        take: 10000,
      }),
    ]);

    return res.json({
      ok: true,
      creator: {
        id: ctx.creator.id,
        displayName: ctx.creator.displayName,
        username: ctx.creator.username,
        status: ctx.creator.status,
      },
      earnings: snapshotForClient(earnings),
      campaigns: campaigns
        ? {
            campaigns: sanitizeCampaigns(campaigns.campaigns),
            totals: { active: campaigns.totalActive, claimers: campaigns.totalClaimers, clicks: campaigns.totalClicks },
            capturedAt: campaigns.capturedAt,
            staleSeconds: Math.max(0, Math.floor((Date.now() - new Date(campaigns.capturedAt).getTime()) / 1000)),
          }
        : null,
      availableRanges: allRanges.map((r) => ({
        rangeKey: r.rangeKey,
        capturedAt: r.capturedAt,
        totalCents: bigToNum(r.totalCents),
      })),
    });
  } catch (err) {
    console.error("[stats/overview] failed:", err);
    return res.status(500).json({ ok: false, code: "OVERVIEW_FAILED", error: err?.message || "Failed" });
  }
});

// ════════════════════════════════════════════════════════════
// GET /agencies/:agencyId/earnings/summary?range=7d
// — Aggregated view for owner dashboard.
// ════════════════════════════════════════════════════════════

router.get("/agencies/:agencyId/earnings/summary", async (req, res) => {
  try {
    const ctx = await loadAgencyAccess(req, res, req.params.agencyId);
    if (!ctx) return;
    if (!requireEarningsPermission(res, ctx.member)) return;

    const range = String(req.query.range || "7d");
    if (!VALID_RANGES.has(range)) {
      return res.status(400).json({ ok: false, code: "INVALID_RANGE", error: `Invalid range: ${range}` });
    }

    const snapshots = await prisma.creatorEarningsSnapshot.findMany({
      where: { agencyId: ctx.agency.id, rangeKey: range },
      include: {
        creator: { select: { id: true, displayName: true, username: true, avatarUrl: true, status: true } },
      },
      orderBy: { totalCents: "desc" },
      take: 10000,
    });

    let totalCents = 0n;
    let salesCount = 0;
    let uniqueFans = 0;

    for (const s of snapshots) {
      totalCents += BigInt(s.totalCents || 0);
      salesCount += s.salesCount;
      uniqueFans += s.uniqueFans;
    }

    return res.json({
      ok: true,
      agencyId: ctx.agency.id,
      rangeKey: range,
      totals: {
        total: bigToNum(totalCents),
        salesCount,
        uniqueFans,
        creatorCount: snapshots.length,
      },
      perCreator: snapshots.map((s) => ({
        creator: s.creator,
        total: bigToNum(s.totalCents),
        salesCount: s.salesCount,
        uniqueFans: s.uniqueFans,
        capturedAt: s.capturedAt,
        staleSeconds: Math.max(0, Math.floor((Date.now() - new Date(s.capturedAt).getTime()) / 1000)),
      })),
    });
  } catch (err) {
    console.error("[stats/agency-summary] failed:", err);
    return res.status(500).json({ ok: false, code: "AGENCY_SUMMARY_FAILED", error: err?.message || "Failed" });
  }
});

// ════════════════════════════════════════════════════════════
// POST /creators/:creatorId/refresh — owner clicks "refresh now"
// Bumps priority + nextRunAt for all jobs of this creator.
// Creates jobs if missing.
// ════════════════════════════════════════════════════════════

router.post("/creators/:creatorId/refresh", async (req, res) => {
  try {
    const ctx = await loadCreatorWithAccess(req, res, req.params.creatorId);
    if (!ctx) return;
    if (!requireRefreshPermission(res, ctx.member)) return;
    const { creator } = ctx;

    const range = String(req.body?.rangeKey || req.query?.rangeKey || "7d");
    if (!VALID_RANGES.has(range)) {
      return res.status(400).json({ ok: false, code: "INVALID_RANGE", error: `Invalid range: ${range}` });
    }

    const now = new Date();
    const notificationState = await loadNotificationSyncState(prisma, creator.id);
    const notificationParams = buildNotificationScanParams({
      state: notificationState,
      now,
      reason: "creator_analytics_refresh",
      analyticsRangeKey: range,
    });
    const [earnings, campaigns, notifications, subscribers] = await Promise.all([
      scheduleJobNow({
        jobKey: "fetch_earnings",
        creatorId: creator.id,
        agencyId: creator.agencyId,
        params: { rangeKey: range },
        priority: 100,
        now,
        bucketMs: 60_000,
      }),
      scheduleJobNow({
        jobKey: "fetch_campaigns",
        creatorId: creator.id,
        agencyId: creator.agencyId,
        params: { rangeKey: range },
        priority: 100,
        now,
        bucketMs: 60_000,
      }),
      scheduleJobNow({
        jobKey: "catchup_notifications_scan",
        creatorId: creator.id,
        agencyId: creator.agencyId,
        params: notificationParams,
        priority: 95,
        now,
        bucketMs: 60_000,
      }),
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

    const freshAfter = new Date(Date.now() - 2 * 60 * 1000);
    const onlineBindings = await prisma.deviceCreatorBinding.count({
      where: {
        creatorId: creator.id,
        agencyId: creator.agencyId,
        status: "ACTIVE",
        lastSeenAt: { gte: freshAfter },
        device: { lastSeenAt: { gte: freshAfter } },
      },
    });

    return res.json({
      ok: true,
      onlineWorkers: onlineBindings,
      jobs: [
        { id: earnings.job.id, jobKey: "fetch_earnings", rangeKey: range, reason: earnings.reason },
        { id: campaigns.job.id, jobKey: "fetch_campaigns", rangeKey: range, reason: campaigns.reason },
        { id: notifications.job.id, jobKey: "catchup_notifications_scan", rangeKey: range, reason: notifications.reason, notificationMode: notificationParams.notificationMode },
        { id: subscribers.job?.id || subscribers.run?.jobId || null, jobKey: "subscriber_directory_scan", rangeKey: "all", reason: subscribers.reason },
      ],
      message:
        onlineBindings === 0
          ? "Jobs scheduled, but no READY desktop binding currently sees this creator."
          : `Jobs scheduled. ${onlineBindings} READY worker binding(s) can pick them up.`,
    });
  } catch (err) {
    console.error("[stats/refresh-creator] failed:", err);
    return res.status(500).json({ ok: false, code: "REFRESH_FAILED", error: err?.message || "Failed" });
  }
});

// ════════════════════════════════════════════════════════════
// POST /agencies/:agencyId/refresh — owner clicks "refresh all creators"
// ════════════════════════════════════════════════════════════

router.post("/agencies/:agencyId/refresh", async (req, res) => {
  try {
    const ctx = await loadAgencyAccess(req, res, req.params.agencyId);
    if (!ctx) return;
    if (!requireRefreshPermission(res, ctx.member)) return;

    const range = String(req.body?.rangeKey || req.query?.rangeKey || "7d");
    if (!VALID_RANGES.has(range)) {
      return res.status(400).json({ ok: false, code: "INVALID_RANGE", error: `Invalid range: ${range}` });
    }

    const creators = await prisma.creatorAccount.findMany({
      where: { agencyId: ctx.agency.id, deletedAt: null, status: "READY" },
      select: { id: true, agencyId: true },
      take: 10000,
    });

    const now = new Date();
    const notificationStates = await prisma.creatorNotificationSyncState.findMany({
      where: { creatorId: { in: creators.map((creator) => creator.id) } },
    });
    const notificationStateByCreator = new Map(notificationStates.map((state) => [state.creatorId, state]));
    let jobsScheduled = 0;
    let alreadyClaimed = 0;
    const failedCreators = [];
    const batchSize = range === "all" ? 5 : 20;

    // Do not schedule 4,000 jobs sequentially for a 2,000-creator agency, but
    // also avoid one unbounded Promise.all that can stampede the database.
    for (let offset = 0; offset < creators.length; offset += batchSize) {
      const batch = creators.slice(offset, offset + batchSize);
      const settled = await Promise.allSettled(
        batch.map(async (creator) => {
          const scheduled = await Promise.all([
            scheduleJobNow({
              jobKey: "fetch_earnings",
              creatorId: creator.id,
              agencyId: creator.agencyId,
              params: { rangeKey: range },
              priority: 50,
              now,
              bucketMs: 60_000,
            }),
            scheduleJobNow({
              jobKey: "fetch_campaigns",
              creatorId: creator.id,
              agencyId: creator.agencyId,
              params: { rangeKey: range },
              priority: 50,
              now,
              bucketMs: 60_000,
            }),
            scheduleJobNow({
              jobKey: "catchup_notifications_scan",
              creatorId: creator.id,
              agencyId: creator.agencyId,
              params: buildNotificationScanParams({
                state: notificationStateByCreator.get(creator.id) || null,
                now,
                reason: "agency_analytics_refresh",
                analyticsRangeKey: range,
              }),
              priority: 45,
              now,
              bucketMs: 60_000,
            }),
          ]);
          return { creatorId: creator.id, scheduled };
        })
      );

      for (let index = 0; index < settled.length; index += 1) {
        const result = settled[index];
        const creatorId = batch[index]?.id || null;
        if (result.status === "rejected") {
          failedCreators.push({
            creatorId,
            code: String(result.reason?.code || "ANALYTICS_JOB_SCHEDULE_FAILED"),
          });
          continue;
        }
        for (const scheduled of result.value.scheduled) {
          if (scheduled.reason === "already_claimed") alreadyClaimed += 1;
          else jobsScheduled += 1;
        }
      }
    }

    return res.json({
      ok: true,
      creatorsScheduled: creators.length - failedCreators.length,
      creatorsRequested: creators.length,
      jobsScheduled,
      alreadyClaimed,
      failedCount: failedCreators.length,
      failures: failedCreators.slice(0, 50),
    });
  } catch (err) {
    console.error("[stats/refresh-agency] failed:", err);
    return res.status(500).json({ ok: false, code: "AGENCY_REFRESH_FAILED", error: err?.message || "Failed" });
  }
});


// Relational Creator Analytics V1 read model and local-only message day aggregates.
const liveNotificationSchema = z.object({
  deviceId: z.string().min(3).max(160),
  batchId: z.string().min(8).max(80).regex(/^[A-Za-z0-9._-]+$/),
  observedAt: z.string().datetime({ offset: true }),
  sourceTimezone: z.literal("UTC").default("UTC"),
  events: z.array(z.record(z.unknown())).min(1).max(100),
});

const messagesDailySchema = z.object({
  deviceId: z.string().min(3).max(160),
  syncId: z.string().uuid(),
  observedAt: z.string().datetime({ offset: true }),
  sourceTimezone: z.literal("UTC").default("UTC"),
  localCoverage: z.object({
    complete: z.boolean(),
    knownDialogs: z.number().int().nonnegative(),
    incompleteDialogs: z.number().int().nonnegative(),
    messagesIndexed: z.number().int().nonnegative(),
    oldestMessageAt: z.string().datetime({ offset: true }).nullable(),
    newestMessageAt: z.string().datetime({ offset: true }).nullable(),
  }).superRefine((value, ctx) => {
    if (value.incompleteDialogs > value.knownDialogs) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "incompleteDialogs cannot exceed knownDialogs" });
    const provable = value.knownDialogs > 0 && value.incompleteDialogs === 0;
    if (value.complete !== provable) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "localCoverage.complete does not match dialog counters" });
    if (value.oldestMessageAt && value.newestMessageAt && new Date(value.oldestMessageAt) > new Date(value.newestMessageAt)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "localCoverage oldestMessageAt cannot be after newestMessageAt" });
    }
  }),
  rows: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    incomingMessages: z.number().int().nonnegative(),
    outgoingMessages: z.number().int().nonnegative(),
    totalMessages: z.number().int().nonnegative(),
    uniqueDialogs: z.number().int().nonnegative(),
    uniqueIncomingFans: z.number().int().nonnegative(),
    uniqueOutgoingFans: z.number().int().nonnegative(),
  })).max(50),
});

router.get("/creators/:creatorId/ledger-overview", async (req, res) => {
  try {
    const ctx = await loadCreatorWithAccess(req, res, String(req.params.creatorId || ""));
    if (!ctx) return;
    if (!requireEarningsPermission(res, ctx.member)) return;
    const rangeKey = String(req.query.range || "30d");
    if (!VALID_RANGES.has(rangeKey)) {
      return res.status(400).json({ ok: false, code: "INVALID_RANGE", error: `Invalid range: ${rangeKey}` });
    }
    const overview = await readCreatorLedgerOverview({ creatorId: ctx.creator.id, rangeKey });
    return res.json(overview);
  } catch (error) {
    console.error("[stats/ledger-overview] failed:", error);
    return res.status(500).json({ ok: false, code: "CREATOR_LEDGER_OVERVIEW_FAILED", error: error?.message || "Failed" });
  }
});


router.get("/creators/:creatorId/ledger-coverage", async (req, res) => {
  try {
    const ctx = await loadCreatorWithAccess(req, res, String(req.params.creatorId || ""));
    if (!ctx) return;
    if (!requireEarningsPermission(res, ctx.member)) return;
    const rangeKey = String(req.query.range || "30d");
    if (!VALID_RANGES.has(rangeKey)) {
      return res.status(400).json({ ok: false, code: "INVALID_RANGE", error: `Invalid range: ${rangeKey}` });
    }
    const limit = Math.max(1, Math.min(500, Number.parseInt(String(req.query.limit || "120"), 10) || 120));
    const offset = Math.max(0, Math.min(1_000_000, Number.parseInt(String(req.query.offset || "0"), 10) || 0));
    const page = await readCreatorCoverage({ creatorId: ctx.creator.id, rangeKey, limit, offset });
    return res.json({ ok: true, creatorId: ctx.creator.id, ...page });
  } catch (error) {
    console.error("[stats/ledger-coverage] failed:", error);
    return res.status(500).json({ ok: false, code: "CREATOR_LEDGER_COVERAGE_FAILED", error: error?.message || "Failed" });
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
    const result = await readCampaignFans({
      creatorId: ctx.creator.id,
      campaignId,
      limit,
      offset,
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

router.post("/creators/:creatorId/notifications/live", async (req, res) => {
  try {
    const input = liveNotificationSchema.parse(req.body || {});
    const ctx = await loadCreatorWithAccess(req, res, String(req.params.creatorId || ""));
    if (!ctx) return;
    // Live websocket facts are reported by the authenticated device that owns
    // the fresh creator binding. Chatter devices must not need the managerial
    // "refresh analytics" permission merely to preserve realtime facts.
    const userId = actorUserId(req);
    const freshAfter = new Date(Date.now() - 10 * 60 * 1000);
    const device = await prisma.workerDevice.findFirst({
      where: { id: input.deviceId, userId, agencyId: ctx.creator.agencyId, lastSeenAt: { gte: freshAfter } },
      select: { id: true },
    });
    if (!device) return res.status(403).json({ ok: false, code: "LIVE_NOTIFICATION_DEVICE_FORBIDDEN", error: "The reporting device is not owned by this agency member" });
    const binding = await prisma.deviceCreatorBinding.findFirst({
      where: {
        deviceId: device.id,
        creatorId: ctx.creator.id,
        agencyId: ctx.creator.agencyId,
        status: "ACTIVE",
        lastSeenAt: { gte: freshAfter },
      },
      select: { id: true },
    });
    if (!binding) return res.status(409).json({ ok: false, code: "LIVE_NOTIFICATION_CREATOR_NOT_READY", error: "The reporting device has no fresh READY binding for this creator" });

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
    return res.status(500).json({ ok: false, code: error?.code || "LIVE_NOTIFICATION_INGEST_FAILED", error: error?.message || "Failed" });
  }
});

router.post("/creators/:creatorId/messages-daily", async (req, res) => {
  try {
    const input = messagesDailySchema.parse(req.body || {});
    const ctx = await loadCreatorWithAccess(req, res, String(req.params.creatorId || ""));
    if (!ctx) return;
    if (!requireRefreshPermission(res, ctx.member)) return;
    const userId = actorUserId(req);
    const freshAfter = new Date(Date.now() - 10 * 60 * 1000);
    const device = await prisma.workerDevice.findFirst({
      where: { id: input.deviceId, userId, agencyId: ctx.creator.agencyId, lastSeenAt: { gte: freshAfter } },
      select: { id: true, lastSeenAt: true },
    });
    if (!device) return res.status(403).json({ ok: false, code: "MESSAGES_DAILY_DEVICE_FORBIDDEN", error: "The reporting device is not owned by this agency member" });
    const binding = await prisma.deviceCreatorBinding.findFirst({
      where: {
        deviceId: device.id,
        creatorId: ctx.creator.id,
        agencyId: ctx.creator.agencyId,
        status: "ACTIVE",
        lastSeenAt: { gte: freshAfter },
      },
      select: { id: true },
    });
    if (!binding) return res.status(409).json({ ok: false, code: "MESSAGES_DAILY_CREATOR_NOT_READY", error: "The reporting device has no fresh READY binding for this creator" });
    const rows = input.rows.map((row) => ({ ...row, sourceTimezone: input.sourceTimezone }));
    const result = await upsertMessagesDaily({
      agencyId: ctx.creator.agencyId,
      creatorId: ctx.creator.id,
      rows,
      syncId: input.syncId,
      observedAt: input.observedAt,
      sourceDeviceId: device.id,
      localCoverage: input.localCoverage,
    });
    return res.json({ ok: true, creatorId: ctx.creator.id, ...result });
  } catch (error) {
    if (error?.issues) return validationError(res, error);
    console.error("[stats/messages-daily] failed:", error);
    return res.status(500).json({ ok: false, code: "MESSAGES_DAILY_UPSERT_FAILED", error: error?.message || "Failed" });
  }
});

module.exports = router;

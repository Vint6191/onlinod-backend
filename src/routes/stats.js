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
const { z }   = require("zod");
const prisma  = require("../prisma");

const router = express.Router();

function actorUserId(req) {
  return req.auth?.userId || req.user?.id || null;
}

function actorAgencyId(req) {
  return req.auth?.agencyId || req.user?.activeAgencyId || req.body?.agencyId || req.query?.agencyId || null;
}


// ════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════

const VALID_RANGES = new Set([
  "24h", "7d", "30d", "90d", "180d", "365d", "ytd", "prev_year", "all",
]);

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
  deviceId:   z.string().min(1),  // who is reporting
  creatorId:  z.string().min(1),
  rangeKey:   z.string().refine((v) => VALID_RANGES.has(v), "Invalid rangeKey"),
  range: z.object({
    startDate: z.string(),
    endDate:   z.string(),
  }).optional(),
  summary: z.object({
    total:      z.number(),
    gross:      z.number().optional(),
    delta:      z.number().optional(),
    avgSale:    z.number().optional(),
    fanLtv:     z.number().optional(),
    salesCount: z.number().int().nonnegative(),
    uniqueFans: z.number().int().nonnegative(),
  }),
  raw:    z.any().optional(),
  jobId:  z.string().optional(),  // optional — links snapshot to the job that produced it
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

    // Optional sanity: device should have a binding to this creator.
    // We don't reject if missing — chatter might be working off a recent
    // binding that just expired. Just log warn.
    const binding = await prisma.deviceCreatorBinding.findUnique({
      where: { deviceId_creatorId: { deviceId: device.id, creatorId: creator.id } },
    });
    if (!binding) {
      console.warn(`[stats/earnings] device ${device.id} reporting for creator ${creator.id} without active binding`);
    }

    const data = {
      creatorId: creator.id,
      agencyId: creator.agencyId,
      rangeKey: input.rangeKey,
      rangeStartAt: input.range?.startDate ? new Date(input.range.startDate) : null,
      rangeEndAt:   input.range?.endDate   ? new Date(input.range.endDate)   : null,
      totalCents:  Math.round(input.summary.total),
      grossCents:  Math.round(input.summary.gross || 0),
      deltaCents:  Math.round(input.summary.delta || 0),
      avgSaleCents: Math.round(input.summary.avgSale || 0),
      fanLtvCents:  Math.round(input.summary.fanLtv || 0),
      salesCount: input.summary.salesCount,
      uniqueFans: input.summary.uniqueFans,
      raw: input.raw || null,
      capturedAt: new Date(),
      capturedByDeviceId: device.id,
      capturedByUserId: userId,
    };

    const snapshot = await prisma.creatorEarningsSnapshot.upsert({
      where: { creatorId_rangeKey: { creatorId: creator.id, rangeKey: input.rangeKey } },
      create: data,
      update: data,
    });

    // If this was triggered by a job, mark the job DONE.
    if (input.jobId) {
      try {
        await prisma.jobInstance.update({
          where: { id: input.jobId },
          data: {
            status: "DONE",
            completedAt: new Date(),
            result: { snapshotId: snapshot.id, total: data.totalCents, salesCount: data.salesCount },
          },
        });
      } catch (_) { /* job might not exist — that's fine */ }
    }

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
  deviceId:  z.string().min(1),
  creatorId: z.string().min(1),
  rangeKey:  z.string().optional(),
  campaigns: z.array(z.any()).max(2000),
  jobId:     z.string().optional(),
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

    let active = 0, claimers = 0, clicks = 0;
    for (const c of input.campaigns) {
      if (c?.is_active) active += 1;
      claimers += Number(c?.claimers_count || 0);
      clicks   += Number(c?.clicks_count   || 0);
    }

    const data = {
      creatorId: creator.id,
      agencyId: creator.agencyId,
      rangeKey: input.rangeKey || "7d",
      campaigns: input.campaigns,
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

    if (input.jobId) {
      try {
        await prisma.jobInstance.update({
          where: { id: input.jobId },
          data: {
            status: "DONE",
            completedAt: new Date(),
            result: { snapshotId: snapshot.id, campaignCount: input.campaigns.length },
          },
        });
      } catch (_) {}
    }

    return res.json({
      ok: true,
      snapshot: {
        id: snapshot.id,
        creatorId: snapshot.creatorId,
        rangeKey: snapshot.rangeKey,
        campaigns: snapshot.campaigns,
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
        campaigns: snapshot.campaigns || [],
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
            campaigns: campaigns.campaigns || [],
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
    const { creator } = ctx;

    const range = String(req.body?.rangeKey || req.query?.rangeKey || "7d");
    if (!VALID_RANGES.has(range)) {
      return res.status(400).json({ ok: false, code: "INVALID_RANGE", error: `Invalid range: ${range}` });
    }

    const now = new Date();

    // Are there chatter machines online for this creator?
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    const onlineBindings = await prisma.deviceCreatorBinding.count({
      where: {
        creatorId: creator.id,
        ofStatus: "READY",
        device: { lastHeartbeatAt: { gte: fiveMinAgo } },
      },
    });

    // Schedule earnings job (or bump existing).
    const earningsJobs = await prisma.jobInstance.findMany({
      where: {
        jobKey: "fetch_earnings",
        creatorId: creator.id,
        status: { in: ["SCHEDULED", "FAILED"] },
      },
    });

    const matchingEarningsJob = earningsJobs.find((j) => {
      try {
        return (j.params || {}).rangeKey === range;
      } catch (_) { return false; }
    });

    let earningsJob = matchingEarningsJob;
    if (earningsJob) {
      earningsJob = await prisma.jobInstance.update({
        where: { id: earningsJob.id },
        data: {
          status: "SCHEDULED",
          priority: 100,
          nextRunAt: now,
          lastError: null,
        },
      });
    } else {
      earningsJob = await prisma.jobInstance.create({
        data: {
          jobKey: "fetch_earnings",
          scope: "creator",
          creatorId: creator.id,
          agencyId: creator.agencyId,
          params: { rangeKey: range },
          status: "SCHEDULED",
          priority: 100,
          scheduledAt: now,
          nextRunAt: now,
        },
      });
    }

    // Schedule campaigns job too — same pattern, but it has no rangeKey.
    let campaignsJob = await prisma.jobInstance.findFirst({
      where: {
        jobKey: "fetch_campaigns",
        creatorId: creator.id,
        status: { in: ["SCHEDULED", "FAILED"] },
      },
    });

    if (campaignsJob) {
      campaignsJob = await prisma.jobInstance.update({
        where: { id: campaignsJob.id },
        data: { status: "SCHEDULED", priority: 100, nextRunAt: now, lastError: null },
      });
    } else {
      campaignsJob = await prisma.jobInstance.create({
        data: {
          jobKey: "fetch_campaigns",
          scope: "creator",
          creatorId: creator.id,
          agencyId: creator.agencyId,
          params: { rangeKey: range },
          status: "SCHEDULED",
          priority: 100,
          scheduledAt: now,
          nextRunAt: now,
        },
      });
    }

    return res.json({
      ok: true,
      onlineWorkers: onlineBindings,
      jobs: [
        { id: earningsJob.id,  jobKey: "fetch_earnings",  rangeKey: range },
        { id: campaignsJob.id, jobKey: "fetch_campaigns" },
      ],
      message: onlineBindings === 0
        ? "Job scheduled, but no online workers see this creator right now."
        : `Job scheduled. ${onlineBindings} worker(s) can pick it up.`,
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

    const range = String(req.body?.rangeKey || req.query?.rangeKey || "7d");
    if (!VALID_RANGES.has(range)) {
      return res.status(400).json({ ok: false, code: "INVALID_RANGE", error: `Invalid range: ${range}` });
    }

    const creators = await prisma.creatorAccount.findMany({
      where: { agencyId: ctx.agency.id, deletedAt: null, status: "READY" },
      select: { id: true, agencyId: true },
    });

    const now = new Date();
    let scheduled = 0;

    // For each creator, schedule both jobs. We do upsert-like behavior by
    // hand because params is JSON — Prisma's compound unique index doesn't
    // help us here.
    for (const creator of creators) {
      // earnings
      const earnings = await prisma.jobInstance.findMany({
        where: {
          jobKey: "fetch_earnings",
          creatorId: creator.id,
          status: { in: ["SCHEDULED", "FAILED"] },
        },
      });
      const matching = earnings.find((j) => (j.params || {}).rangeKey === range);

      if (matching) {
        await prisma.jobInstance.update({
          where: { id: matching.id },
          data: { status: "SCHEDULED", priority: 50, nextRunAt: now, lastError: null },
        });
      } else {
        await prisma.jobInstance.create({
          data: {
            jobKey: "fetch_earnings",
            scope: "creator",
            creatorId: creator.id,
            agencyId: creator.agencyId,
            params: { rangeKey: range },
            priority: 50,
            scheduledAt: now,
            nextRunAt: now,
          },
        });
      }
      scheduled += 1;
    }

    return res.json({
      ok: true,
      creatorsScheduled: scheduled,
    });
  } catch (err) {
    console.error("[stats/refresh-agency] failed:", err);
    return res.status(500).json({ ok: false, code: "AGENCY_REFRESH_FAILED", error: err?.message || "Failed" });
  }
});


module.exports = router;

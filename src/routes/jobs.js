/* src/routes/jobs.js
   ────────────────────────────────────────────────────────────
   Job claim/report endpoints. The Electron jobs-runner loop
   calls these:
   
     POST /claim    — give me a job to do
                      Backend looks for SCHEDULED jobs whose
                      creator is bound to the calling device.
                      Picks highest priority, oldest. Marks
                      CLAIMED with a 5-minute lease.
   
     POST /:id/report — I finished (ok or error)
                      Backend transitions to DONE / FAILED with
                      backoff for retries.
   
   Lease expiration:
     Every claim call also runs a quick sweeper that resets
     CLAIMED jobs whose leaseUntil < now back to SCHEDULED.
     This handles workers that crashed or got disconnected mid-job.
   
   Schedule auto-creation:
     When a creator becomes READY (via creator-connect), we should
     auto-schedule a first earnings job so owner UI has data without
     anyone clicking refresh. That hook lives in creator-connect.js
     (separate patch).
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

const LEASE_MS = 5 * 60 * 1000;       // 5 minutes
const RETRY_BACKOFF_MS = 60 * 1000;   // 1 minute base
const MAX_ATTEMPTS = 5;


function validationError(res, err) {
  return res.status(400).json({
    ok: false,
    code: "VALIDATION_ERROR",
    error: err.issues?.[0]?.message || "Validation error",
  });
}

// Sweep: any CLAIMED job whose leaseUntil is in the past goes back
// to SCHEDULED (with attempts++, so we don't infinite-loop on a
// stuck one).
async function sweepExpiredLeases() {
  const now = new Date();
  const expired = await prisma.jobInstance.findMany({
    where: {
      status: "CLAIMED",
      leaseUntil: { lt: now },
    },
    select: { id: true, attempts: true },
  });

  if (!expired.length) return 0;

  await Promise.all(expired.map((j) =>
    prisma.jobInstance.update({
      where: { id: j.id },
      data: {
        status: "SCHEDULED",
        claimedAt: null,
        claimedByDeviceId: null,
        leaseUntil: null,
        attempts: { increment: 1 },
        nextRunAt: new Date(Date.now() + RETRY_BACKOFF_MS),
        lastError: "lease expired",
      },
    })
  ));

  return expired.length;
}


// ════════════════════════════════════════════════════════════
// POST /claim
//
// Body: { deviceId }
// Response shapes:
//   { ok: true, job: null }                  — no work available
//   { ok: true, job: { id, jobKey, ... } }   — got a job
// ════════════════════════════════════════════════════════════

const claimSchema = z.object({
  deviceId: z.string().min(1),
});

router.post("/claim", async (req, res) => {
  try {
    const input = claimSchema.parse(req.body);
    const userId = actorUserId(req);

    // Validate device.
    const device = await prisma.workerDevice.findUnique({ where: { id: input.deviceId } });
    if (!device || device.userId !== userId) {
      return res.status(403).json({ ok: false, code: "NOT_YOUR_DEVICE", error: "Invalid device" });
    }

    // Reset stale leases first.
    await sweepExpiredLeases();

    const now = new Date();
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);

    // Heartbeat must be recent — if device hasn't sent heartbeat in
    // 5 min we don't trust it for new jobs.
    if (!device.lastSeenAt || device.lastSeenAt < fiveMinAgo) {
      return res.json({ ok: true, job: null, reason: "device-stale" });
    }

    // What creators can this device/user work on right now?
    //
    // Original pack referenced DeviceCreatorBinding, but our current schema
    // does not have that table. Use the worker's active agency membership
    // and assignedCreators scope instead. The Electron job runner still
    // validates the local manifest before doing OF requests; if there is no
    // usable partition, the job reports a normal failure/backoff.
    const member = await prisma.agencyMember.findFirst({
      where: {
        agencyId: device.agencyId,
        userId,
        deletedAt: null,
        agency: { deletedAt: null },
      },
    });

    if (!member) {
      return res.json({ ok: true, job: null, reason: "not-a-member" });
    }

    const roleKey = String(member.roleKey || "").toLowerCase();
    const isBroadScope =
      member.role === "OWNER" ||
      member.role === "MANAGER" ||
      roleKey === "owner" ||
      roleKey === "manager" ||
      !member.assignedCreators ||
      member.assignedCreators === "all";

    let creatorWhere = {
      agencyId: device.agencyId,
      deletedAt: null,
      status: "READY",
    };

    if (!isBroadScope) {
      const assigned = Array.isArray(member.assignedCreators)
        ? member.assignedCreators.map((id) => String(id || "").trim()).filter(Boolean)
        : [];

      creatorWhere = {
        ...creatorWhere,
        id: { in: assigned.length ? assigned : ["__none__"] },
      };
    }

    const visibleCreators = await prisma.creatorAccount.findMany({
      where: creatorWhere,
      select: { id: true },
    });

    const visibleCreatorIds = visibleCreators.map((item) => item.id);
    if (!visibleCreatorIds.length) {
      return res.json({ ok: true, job: null, reason: "no-creators-visible" });
    }

    // Find the best candidate job.
    //
    // We do a SELECT first (high-pri, oldest scheduled, creatorId in our
    // visible set), then a CONDITIONAL UPDATE WHERE status='SCHEDULED'
    // to claim it. If two devices race, only one's UPDATE will succeed —
    // the other gets rowsAffected=0 and we loop.
    //
    // We cap attempts at 3 to avoid pathological hot loops.

    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = await prisma.jobInstance.findFirst({
        where: {
          status: "SCHEDULED",
          nextRunAt: { lte: now },
          attempts: { lt: MAX_ATTEMPTS },
          OR: [
            { creatorId: { in: visibleCreatorIds } },
            { scope: "agency", agencyId: device.agencyId, creatorId: null },
            { scope: "global", creatorId: null, agencyId: null },
          ],
        },
        orderBy: [
          { priority: "desc" },
          { nextRunAt: "asc" },
        ],
      });

      if (!candidate) {
        return res.json({ ok: true, job: null, reason: "no-work" });
      }

      // Try to claim atomically.
      const claimResult = await prisma.jobInstance.updateMany({
        where: { id: candidate.id, status: "SCHEDULED" },
        data: {
          status: "CLAIMED",
          claimedAt: now,
          claimedByDeviceId: device.id,
          leaseUntil: new Date(now.getTime() + LEASE_MS),
        },
      });

      if (claimResult.count === 0) {
        // Someone else got it. Try next candidate.
        continue;
      }

      const claimed = await prisma.jobInstance.findUnique({ where: { id: candidate.id } });

      return res.json({
        ok: true,
        job: {
          id: claimed.id,
          jobKey: claimed.jobKey,
          scope: claimed.scope,
          creatorId: claimed.creatorId,
          agencyId: claimed.agencyId,
          params: claimed.params || {},
          attempt: claimed.attempts + 1,
          leaseUntil: claimed.leaseUntil,
        },
      });
    }

    return res.json({ ok: true, job: null, reason: "race-lost" });
  } catch (err) {
    if (err?.issues) return validationError(res, err);
    console.error("[jobs/claim] failed:", err);
    return res.status(500).json({ ok: false, code: "CLAIM_FAILED", error: err?.message || "Failed" });
  }
});


// ════════════════════════════════════════════════════════════
// POST /:id/report
//
// Body: { ok: true|false, error?: string, deviceId, result? }
// ════════════════════════════════════════════════════════════

const reportSchema = z.object({
  deviceId: z.string().min(1),
  ok:       z.boolean(),
  error:    z.string().max(2000).optional().nullable(),
  result:   z.any().optional(),
});

router.post("/:id/report", async (req, res) => {
  try {
    const input = reportSchema.parse(req.body);
    const userId = actorUserId(req);

    const job = await prisma.jobInstance.findUnique({ where: { id: req.params.id } });
    if (!job) {
      return res.status(404).json({ ok: false, code: "JOB_NOT_FOUND", error: "Job not found" });
    }

    // Validate that the reporting device actually claimed this job.
    if (job.claimedByDeviceId && job.claimedByDeviceId !== input.deviceId) {
      return res.status(409).json({
        ok: false,
        code: "JOB_CLAIMED_BY_OTHER",
        error: "Job is claimed by a different device",
      });
    }

    // Validate device ownership.
    const device = await prisma.workerDevice.findUnique({ where: { id: input.deviceId } });
    if (!device || device.userId !== userId) {
      return res.status(403).json({ ok: false, code: "NOT_YOUR_DEVICE", error: "Invalid device" });
    }

    if (input.ok) {
      const updated = await prisma.jobInstance.update({
        where: { id: job.id },
        data: {
          status: "DONE",
          completedAt: new Date(),
          leaseUntil: null,
          result: input.result || null,
          lastError: null,
        },
      });

      return res.json({ ok: true, job: { id: updated.id, status: updated.status } });
    }

    // Failure — backoff.
    const newAttempts = job.attempts + 1;
    const backoffMs = RETRY_BACKOFF_MS * Math.pow(2, newAttempts - 1);

    if (newAttempts >= MAX_ATTEMPTS) {
      const updated = await prisma.jobInstance.update({
        where: { id: job.id },
        data: {
          status: "FAILED",
          attempts: newAttempts,
          lastError: input.error || "unknown error",
          completedAt: new Date(),
          leaseUntil: null,
        },
      });
      return res.json({ ok: true, job: { id: updated.id, status: updated.status, terminal: true } });
    }

    const updated = await prisma.jobInstance.update({
      where: { id: job.id },
      data: {
        status: "SCHEDULED",
        attempts: newAttempts,
        lastError: input.error || "unknown error",
        nextRunAt: new Date(Date.now() + backoffMs),
        claimedAt: null,
        claimedByDeviceId: null,
        leaseUntil: null,
      },
    });

    return res.json({ ok: true, job: { id: updated.id, status: updated.status, retryAt: updated.nextRunAt } });
  } catch (err) {
    if (err?.issues) return validationError(res, err);
    console.error("[jobs/report] failed:", err);
    return res.status(500).json({ ok: false, code: "REPORT_FAILED", error: err?.message || "Failed" });
  }
});


// ════════════════════════════════════════════════════════════
// GET /pending — debug / admin helper
//
// Lists pending jobs visible to the caller (their agencies only).
// Useful for debugging "why isn't refresh updating data".
// ════════════════════════════════════════════════════════════

router.get("/pending", async (req, res) => {
  try {
    const memberships = await prisma.agencyMember.findMany({
      where: { userId: actorUserId(req), deletedAt: null },
      select: { agencyId: true },
    });
    const agencyIds = memberships.map((m) => m.agencyId);

    if (!agencyIds.length) return res.json({ ok: true, jobs: [] });

    const jobs = await prisma.jobInstance.findMany({
      where: {
        agencyId: { in: agencyIds },
        status: { in: ["SCHEDULED", "CLAIMED", "FAILED"] },
      },
      orderBy: [{ priority: "desc" }, { nextRunAt: "asc" }],
      take: 200,
      include: {
        creator: { select: { id: true, displayName: true, username: true } },
      },
    });

    return res.json({
      ok: true,
      jobs: jobs.map((j) => ({
        id: j.id,
        jobKey: j.jobKey,
        scope: j.scope,
        status: j.status,
        priority: j.priority,
        creator: j.creator,
        agencyId: j.agencyId,
        params: j.params,
        attempts: j.attempts,
        nextRunAt: j.nextRunAt,
        lastError: j.lastError,
        claimedByDeviceId: j.claimedByDeviceId,
        leaseUntil: j.leaseUntil,
      })),
    });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "PENDING_FAILED", error: err?.message || "Failed" });
  }
});


module.exports = router;

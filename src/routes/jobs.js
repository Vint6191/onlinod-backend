"use strict";

const express = require("express");
const { z } = require("zod");
const prisma = require("../prisma");
const {
  JobLeaseError,
  claimJob,
  renewLease,
  completeJob,
  failJob,
  releaseJob,
} = require("../services/job-lease-service");

const router = express.Router();

function actorUserId(req) {
  return req.auth?.userId || req.user?.id || null;
}

function actorAgencyId(req) {
  return req.auth?.agencyId || req.user?.activeAgencyId || req.query?.agencyId || null;
}

function validationError(res, error) {
  return res.status(400).json({
    ok: false,
    code: "VALIDATION_ERROR",
    error: error.issues?.[0]?.message || "Validation error",
  });
}

function leaseError(res, error) {
  if (error instanceof JobLeaseError) {
    return res.status(error.status || 409).json({
      ok: false,
      code: error.code,
      error: error.message,
    });
  }
  throw error;
}

const deviceSchema = z.string().min(1).max(200);
const tokenSchema = z.string().min(20).max(500);
const workIdSchema = z.string().min(1).max(200).optional().nullable();
const leaseRevisionSchema = z.number().int().positive();
const progressSchema = z.object({
  percent: z.number().finite().min(0).max(100).optional(),
  current: z.number().finite().min(0).optional(),
  total: z.number().finite().min(0).optional(),
  message: z.string().max(500).optional(),
}).passthrough().optional().nullable();

const claimSchema = z.object({
  deviceId: deviceSchema,
  leaseMs: z.number().int().min(30_000).max(15 * 60_000).optional(),
  jobKeys: z.array(z.string().min(1).max(120)).min(1).max(100),
});

const leaseMutationSchema = z.object({
  deviceId: deviceSchema,
  leaseToken: tokenSchema,
  leaseRevision: leaseRevisionSchema,
  leaseMs: z.number().int().min(30_000).max(15 * 60_000).optional(),
  workId: workIdSchema,
  progress: progressSchema,
  continuation: z.unknown().optional(),
});

const completeSchema = z.object({
  deviceId: deviceSchema,
  leaseToken: tokenSchema,
  leaseRevision: leaseRevisionSchema,
  workId: workIdSchema,
  progress: progressSchema,
  result: z.unknown().optional(),
});


const releaseSchema = z.object({
  deviceId: deviceSchema,
  leaseToken: tokenSchema,
  leaseRevision: leaseRevisionSchema,
  workId: workIdSchema,
  reason: z.string().min(1).max(2000),
  runAfterMs: z.number().int().min(1_000).max(15 * 60_000).optional(),
});

const failSchema = z.object({
  deviceId: deviceSchema,
  leaseToken: tokenSchema,
  leaseRevision: leaseRevisionSchema,
  workId: workIdSchema,
  error: z.string().min(1).max(2000),
  result: z.unknown().optional(),
  retryable: z.boolean().optional(),
});

router.post("/claim", async (req, res, next) => {
  try {
    const input = claimSchema.parse(req.body);
    const claimed = await claimJob({
      userId: actorUserId(req),
      deviceId: input.deviceId,
      leaseMs: input.leaseMs,
      jobKeys: input.jobKeys,
    });
    return res.json({ ok: true, ...claimed });
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    try { return leaseError(res, error); } catch (unhandled) { return next(unhandled); }
  }
});

router.post("/:id/lease/renew", async (req, res, next) => {
  try {
    const input = leaseMutationSchema.parse(req.body);
    const lease = await renewLease({
      jobId: req.params.id,
      userId: actorUserId(req),
      deviceId: input.deviceId,
      leaseToken: input.leaseToken,
      leaseRevision: input.leaseRevision,
      leaseMs: input.leaseMs,
      workId: input.workId,
      progress: input.progress,
      continuation: input.continuation,
    });
    return res.json({ ok: true, lease });
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    try { return leaseError(res, error); } catch (unhandled) { return next(unhandled); }
  }
});

router.post("/:id/progress", async (req, res, next) => {
  try {
    const input = leaseMutationSchema.parse(req.body);
    const lease = await renewLease({
      jobId: req.params.id,
      userId: actorUserId(req),
      deviceId: input.deviceId,
      leaseToken: input.leaseToken,
      leaseRevision: input.leaseRevision,
      leaseMs: input.leaseMs,
      workId: input.workId,
      progress: input.progress,
      continuation: input.continuation,
    });
    return res.json({ ok: true, lease });
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    try { return leaseError(res, error); } catch (unhandled) { return next(unhandled); }
  }
});

router.post("/:id/complete", async (req, res, next) => {
  try {
    const input = completeSchema.parse(req.body);
    const completed = await completeJob({
      jobId: req.params.id,
      userId: actorUserId(req),
      deviceId: input.deviceId,
      leaseToken: input.leaseToken,
      leaseRevision: input.leaseRevision,
      workId: input.workId,
      result: input.result,
      progress: input.progress,
    });
    return res.json({ ok: true, ...completed });
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    try { return leaseError(res, error); } catch (unhandled) { return next(unhandled); }
  }
});

router.post("/:id/release", async (req, res, next) => {
  try {
    const input = releaseSchema.parse(req.body);
    const released = await releaseJob({
      jobId: req.params.id,
      userId: actorUserId(req),
      ...input,
    });
    return res.json({ ok: true, job: released });
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    try { return leaseError(res, error); } catch (unhandled) { return next(unhandled); }
  }
});

router.post("/:id/fail", async (req, res, next) => {
  try {
    const input = failSchema.parse(req.body);
    const failed = await failJob({
      jobId: req.params.id,
      userId: actorUserId(req),
      deviceId: input.deviceId,
      leaseToken: input.leaseToken,
      leaseRevision: input.leaseRevision,
      workId: input.workId,
      error: input.error,
      result: input.result,
      retryable: input.retryable,
    });
    return res.json({ ok: true, job: failed });
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    try { return leaseError(res, error); } catch (unhandled) { return next(unhandled); }
  }
});

// Compatibility endpoint for clients transitioning from the old report route.
// It is intentionally fenced: deviceId alone is no longer sufficient.
router.post("/:id/report", async (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.ok === false) {
      const input = failSchema.parse({
        deviceId: body.deviceId,
        leaseToken: body.leaseToken,
        leaseRevision: body.leaseRevision,
        workId: body.workId,
        error: body.error || "unknown error",
        result: body.result,
        retryable: body.retryable,
      });
      const failed = await failJob({
        jobId: req.params.id,
        userId: actorUserId(req),
        ...input,
      });
      return res.json({ ok: true, job: failed, compatibility: true });
    }

    const input = completeSchema.parse({
      deviceId: body.deviceId,
      leaseToken: body.leaseToken,
      leaseRevision: body.leaseRevision,
      workId: body.workId,
      progress: body.progress,
      result: body.result,
    });
    const completed = await completeJob({
      jobId: req.params.id,
      userId: actorUserId(req),
      ...input,
    });
    return res.json({ ok: true, ...completed, compatibility: true });
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    try { return leaseError(res, error); } catch (unhandled) { return next(unhandled); }
  }
});

router.get("/pending", async (req, res, next) => {
  try {
    const agencyId = actorAgencyId(req);
    if (!agencyId) {
      return res.status(400).json({ ok: false, code: "AGENCY_REQUIRED", error: "Agency is required" });
    }

    const status = String(req.query.status || "").trim().toUpperCase();
    const allowedStatuses = new Set(["SCHEDULED", "CLAIMED", "DONE", "FAILED", "CANCELLED"]);
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
    const jobs = await prisma.jobInstance.findMany({
      where: {
        agencyId,
        ...(allowedStatuses.has(status) ? { status } : { status: { in: ["SCHEDULED", "CLAIMED", "FAILED"] } }),
      },
      orderBy: [{ status: "asc" }, { priority: "desc" }, { nextRunAt: "asc" }],
      take: limit,
      select: {
        id: true,
        idempotencyKey: true,
        jobKey: true,
        scope: true,
        creatorId: true,
        agencyId: true,
        status: true,
        priority: true,
        attempts: true,
        params: true,
        workId: true,
        continuation: true,
        progress: true,
        lastProgressAt: true,
        claimedAt: true,
        claimedByDeviceId: true,
        leaseUntil: true,
        leaseRevision: true,
        nextRunAt: true,
        startedAt: true,
        completedAt: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return res.json({ ok: true, jobs });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;

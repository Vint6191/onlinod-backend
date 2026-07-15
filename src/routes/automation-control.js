"use strict";

const express = require("express");
const { z } = require("zod");
const prisma = require("../prisma");
const { isSeniorAgencyMember } = require("../middleware/team-permissions");
const { automationCreatorParamRequired, allowedCreatorScope } = require("../middleware/automation-permissions");
const { attachAutomationAudit } = require("../middleware/automation-audit");
const { getAutomationMetrics, listAutomationAudit } = require("../services/automation-history-service");
const { automationAudit, compactControl } = require("../services/automation-audit-service");
const {
  getAutomationControlSnapshot,
  setAutomationControl,
  requireCreator,
} = require("../services/automation-control-service");
const {
  ActionDeliveryError,
  claimActionDelivery,
  renewActionLease,
  startActionDelivery,
  validateActionDelivery,
  completeActionDelivery,
  failActionDelivery,
  releaseActionDelivery,
  listActionDeliveries,
  retryActionDelivery,
  retrySafeFailures,
  cancelActionDelivery,
  releaseClaimByAdmin,
} = require("../services/automation-action-delivery-service");
const {
  planFollowBack,
  ensureAutomaticFollowBack,
  setCandidateState,
  retryCandidateDelivery,
  listFollowBack,
  getAutomationOverview,
} = require("../services/follow-back-service");
const {
  planBumps,
  planConfiguredBumpsNow,
  processRuntimeEvents,
  getBumpOverview,
  triggerPendingReplyScan,
  ensureAutomaticBumps,
} = require("../services/bump-service");
const {
  scheduleLikesDiscovery,
  planLikes,
  ensureAutomaticLikes,
  listLikes,
  setLikeCandidateState,
} = require("../services/likes-service");
const {
  scheduleSfsDiscovery, planSfsTargets, ensureAutomaticSfs, listSfs, setSfsCandidateState,
} = require("../services/sfs-service");
const {
  planFollowAutomation,
  ensureAutomaticFollowAutomation,
  listFollowAutomation,
  setFollowAutomationCandidateState,
} = require("../services/follow-automation-service");

const router = express.Router();
attachAutomationAudit(router);
router.param("creatorId", automationCreatorParamRequired());

function validationError(res, error) {
  return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: error.issues?.[0]?.message || "Validation error" });
}
function serviceError(res, error, fallback = "AUTOMATION_REQUEST_FAILED") {
  const code = error?.code || fallback;
  const status = Number(error?.status) || (code === "CREATOR_NOT_FOUND" || code === "candidate_not_found" || code === "DELIVERY_NOT_FOUND" ? 404 : 500);
  return res.status(status).json({ ok: false, code, error: error?.message || "Automation request failed" });
}
async function seniorRequired(req, res, next) {
  try {
    const member = req.auth?.membership || req.member;
    if (!member || !isSeniorAgencyMember(member)) {
      return res.status(403).json({ ok: false, code: "WRITE_AUTOMATION_FORBIDDEN", error: "Only owner, admin or manager may change or run write automation" });
    }
    req.automationMember = member;
    return next();
  } catch (error) {
    return next(error);
  }
}

router.get("/overview/:creatorId", async (req, res) => {
  try {
    return res.json(await getAutomationOverview({ agencyId: req.auth.agencyId, creatorId: req.params.creatorId }));
  } catch (error) { return serviceError(res, error, "AUTOMATION_OVERVIEW_FAILED"); }
});

router.get("/controls/:creatorId", async (req, res) => {
  try {
    return res.json({ ok: true, snapshot: await getAutomationControlSnapshot({ agencyId: req.auth.agencyId, creatorId: req.params.creatorId }) });
  } catch (error) { return serviceError(res, error, "AUTOMATION_CONTROLS_FAILED"); }
});

router.get("/metrics/:creatorId", async (req, res) => {
  try {
    const query = z.object({
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      months: z.coerce.number().int().min(1).max(60).optional(),
    }).parse(req.query || {});
    return res.json(await getAutomationMetrics({
      agencyId: req.auth.agencyId, creatorId: req.params.creatorId,
      from: query.from || null, to: query.to || null, months: query.months || 12,
    }));
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "AUTOMATION_METRICS_FAILED");
  }
});

router.get("/audit/:creatorId", async (req, res) => {
  try {
    const query = z.object({
      moduleKey: z.string().max(80).optional(),
      cursor: z.string().datetime().optional(),
      limit: z.coerce.number().int().min(1).max(250).optional(),
    }).parse(req.query || {});
    return res.json(await listAutomationAudit({
      agencyId: req.auth.agencyId, creatorId: req.params.creatorId,
      moduleKey: query.moduleKey || null, cursor: query.cursor || null, limit: query.limit || 100,
    }));
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "AUTOMATION_AUDIT_FAILED");
  }
});

const controlSchema = z.object({
  scope: z.enum(["workspace", "creator", "module"]),
  creatorId: z.string().min(1).max(160).optional().nullable(),
  moduleKey: z.enum(["follow_back", "bumps", "likes", "follow", "sfs"]).optional().nullable(),
  enabled: z.boolean().optional(),
  settings: z.record(z.unknown()).optional(),
});
router.patch("/controls", seniorRequired, async (req, res) => {
  try {
    const input = controlSchema.parse(req.body || {});
    let beforeControl = null;
    if (input.creatorId) {
      await allowedCreatorScope({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, requestedCreatorId: input.creatorId });
      beforeControl = compactControl(await getAutomationControlSnapshot({ agencyId: req.auth.agencyId, creatorId: input.creatorId }));
    }
    const result = await setAutomationControl({
      agencyId: req.auth.agencyId,
      userId: req.auth.userId,
      scope: input.scope,
      creatorId: input.creatorId || null,
      moduleKey: input.moduleKey || null,
      enabled: input.enabled,
      settings: input.settings,
    });
    let planning = null;
    if (input.creatorId) {
      const runFollowBack = input.scope !== "module" || input.moduleKey === "follow_back";
      const runBumps = input.scope !== "module" || input.moduleKey === "bumps";
      const runLikes = input.scope !== "module" || input.moduleKey === "likes";
      const runFollowAutomation = input.scope !== "module" || input.moduleKey === "follow";
      const runSfs = input.scope !== "module" || input.moduleKey === "sfs";
      const [followBack, bumps, likes, followAutomation, sfs] = await Promise.all([
        runFollowBack ? ensureAutomaticFollowBack({
          agencyId: req.auth.agencyId,
          creatorId: input.creatorId,
          source: "control_update",
        }) : null,
        runBumps ? ensureAutomaticBumps({
          agencyId: req.auth.agencyId,
          creatorId: input.creatorId,
          userId: req.auth.userId,
          source: "control_update",
        }) : null,
        runLikes ? ensureAutomaticLikes({
          agencyId: req.auth.agencyId,
          creatorId: input.creatorId,
          source: "control_update",
        }) : null,
        runFollowAutomation ? ensureAutomaticFollowAutomation({
          agencyId: req.auth.agencyId,
          creatorId: input.creatorId,
          source: "control_update",
        }) : null,
        runSfs ? ensureAutomaticSfs({ agencyId: req.auth.agencyId, creatorId: input.creatorId, source: "control_update" }) : null,
      ]);
      planning = { followBack, bumps, likes, followAutomation, sfs };
    }
    await automationAudit({
      agencyId: req.auth.agencyId, actorUserId: req.auth.userId, creatorId: input.creatorId || null,
      moduleKey: input.moduleKey || null, action: input.enabled === false ? "control.disabled" : input.enabled === true ? "control.enabled" : "control.settings_changed",
      targetType: input.scope, targetId: input.creatorId || input.moduleKey || req.auth.agencyId,
      before: beforeControl, after: input.creatorId ? compactControl(result.snapshot) : { enabled: input.enabled },
      details: { scope: input.scope, settingsKeys: Object.keys(input.settings || {}).slice(0, 80) },
    });
    return res.json({ ...result, planning });
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "AUTOMATION_CONTROL_UPDATE_FAILED");
  }
});

const listFollowSchema = z.object({
  search: z.string().max(160).optional(),
  state: z.string().max(60).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
router.get("/follow-back/:creatorId", async (req, res) => {
  try {
    const query = listFollowSchema.parse(req.query || {});
    return res.json(await listFollowBack({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      search: query.search || "",
      state: query.state || null,
      offset: query.offset || 0,
      limit: query.limit || 100,
    }));
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "FOLLOW_BACK_LIST_FAILED");
  }
});

const planSchema = z.object({ fanId: z.string().min(1).max(160).optional(), source: z.string().max(80).optional() });
router.post("/follow-back/:creatorId/plan", seniorRequired, async (req, res) => {
  try {
    const input = planSchema.parse(req.body || {});
    return res.status(202).json(await planFollowBack({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      userId: req.auth.userId,
      fanId: input.fanId || null,
      source: input.source || (input.fanId ? "manual_fan" : "manual_run"),
      priority: input.fanId ? 100 : 70,
    }));
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "FOLLOW_BACK_PLAN_FAILED");
  }
});

const candidateActionSchema = z.object({ action: z.enum(["ignore", "block", "restore", "follow", "retry"]) });
router.post("/follow-back/:creatorId/candidates/:fanId/action", seniorRequired, async (req, res) => {
  try {
    const input = candidateActionSchema.parse(req.body || {});
    if (input.action === "retry") {
      return res.status(202).json(await retryCandidateDelivery({
        agencyId: req.auth.agencyId,
        creatorId: req.params.creatorId,
        fanId: req.params.fanId,
      }));
    }
    if (input.action === "follow") {
      return res.status(202).json(await planFollowBack({
        agencyId: req.auth.agencyId,
        creatorId: req.params.creatorId,
        userId: req.auth.userId,
        fanId: req.params.fanId,
        source: "candidate_follow_now",
        priority: 100,
      }));
    }
    return res.json(await setCandidateState({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      fanId: req.params.fanId,
      action: input.action,
    }));
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "FOLLOW_BACK_ACTION_FAILED");
  }
});


const followAutomationListSchema = z.object({
  search: z.string().max(160).optional(),
  state: z.string().max(60).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
router.get("/follow/:creatorId", async (req, res) => {
  try {
    const query = followAutomationListSchema.parse(req.query || {});
    return res.json(await listFollowAutomation({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      search: query.search || "",
      state: query.state || null,
      offset: query.offset || 0,
      limit: query.limit || 100,
    }));
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "FOLLOW_AUTOMATION_LIST_FAILED");
  }
});
router.post("/follow/:creatorId/plan", seniorRequired, async (req, res) => {
  try {
    const input = planSchema.parse(req.body || {});
    return res.status(202).json(await planFollowAutomation({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      userId: req.auth.userId,
      fanId: input.fanId || null,
      source: input.source || (input.fanId ? "candidate_refollow_now" : "manual_run"),
      priority: input.fanId ? 100 : 70,
    }));
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "FOLLOW_AUTOMATION_PLAN_FAILED");
  }
});
router.post("/follow/:creatorId/candidates/:fanId/action", seniorRequired, async (req, res) => {
  try {
    const input = z.object({ action: z.enum(["ignore", "block", "restore", "refollow", "retry"]) }).parse(req.body || {});
    if (input.action === "refollow") {
      return res.status(202).json(await planFollowAutomation({
        agencyId: req.auth.agencyId,
        creatorId: req.params.creatorId,
        userId: req.auth.userId,
        fanId: req.params.fanId,
        source: "candidate_refollow_now",
        priority: 100,
      }));
    }
    if (input.action === "retry") {
      const candidate = await prisma.followAutomationCandidate.findFirst({
        where: { agencyId: req.auth.agencyId, creatorId: req.params.creatorId, fanId: req.params.fanId },
        select: { latestDeliveryId: true },
      });
      if (!candidate) return res.status(404).json({ ok: false, code: "candidate_not_found", error: "Follow Automation candidate not found" });
      if (!candidate.latestDeliveryId) return res.status(409).json({ ok: false, code: "no_delivery", error: "Candidate has no delivery to retry" });
      return res.status(202).json(await retryActionDelivery({ agencyId: req.auth.agencyId, deliveryId: candidate.latestDeliveryId }));
    }
    return res.json({ ok: true, candidate: await setFollowAutomationCandidateState({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      fanId: req.params.fanId,
      action: input.action,
    }) });
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "FOLLOW_AUTOMATION_ACTION_FAILED");
  }
});


const bumpPlanSchema = z.object({
  source: z.enum(["online", "hidden_online", "paid_subscriber", "free_subscriber", "subscription_event", "manual"]).optional(),
  fanIds: z.array(z.string().min(1).max(160)).max(500).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  manual: z.boolean().optional(),
});
router.get("/bumps/:creatorId/overview", async (req, res) => {
  try {
    await requireCreator(req.auth.agencyId, req.params.creatorId);
    return res.json(await getBumpOverview({ agencyId: req.auth.agencyId, creatorId: req.params.creatorId }));
  } catch (error) { return serviceError(res, error, "BUMPS_OVERVIEW_FAILED"); }
});
router.post("/bumps/:creatorId/plan", seniorRequired, async (req, res) => {
  try {
    const input = bumpPlanSchema.parse(req.body || {});
    return res.status(202).json(await planBumps({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      userId: req.auth.userId,
      source: input.source || "manual",
      fanIds: input.fanIds || [],
      limit: input.limit || null,
      manual: input.manual !== false,
    }));
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "BUMPS_PLAN_FAILED");
  }
});
router.post("/bumps/:creatorId/plan-auto", seniorRequired, async (req, res) => {
  try {
    await requireCreator(req.auth.agencyId, req.params.creatorId);
    const result = await planConfiguredBumpsNow({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      userId: req.auth.userId,
      source: "manual_plan_now",
    });
    await automationAudit({
      agencyId: req.auth.agencyId, actorUserId: req.auth.userId, creatorId: req.params.creatorId,
      moduleKey: "bumps", action: "bumps.plan_now", targetType: "creator", targetId: req.params.creatorId,
      details: { planned: result.planned || 0, reason: result.reason || null, skipCounts: result.skipCounts || {} },
    });
    return res.status(202).json(result);
  } catch (error) {
    return serviceError(res, error, "BUMPS_PLAN_AUTO_FAILED");
  }
});
router.post("/bumps/:creatorId/events", seniorRequired, async (req, res) => {
  try {
    const input = z.object({
      deviceId: z.string().min(1).max(160),
      events: z.array(z.record(z.unknown())).max(500),
    }).parse(req.body || {});
    const freshAfter = new Date(Date.now() - 5 * 60_000);
    const binding = await prisma.deviceCreatorBinding.findFirst({
      where: {
        agencyId: req.auth.agencyId,
        creatorId: req.params.creatorId,
        deviceId: input.deviceId,
        status: "ACTIVE",
        lastSeenAt: { gte: freshAfter },
        device: { agencyId: req.auth.agencyId, userId: req.auth.userId, lastSeenAt: { gte: freshAfter } },
      },
      select: { id: true },
    });
    if (!binding) {
      return res.status(403).json({
        ok: false,
        code: "RUNTIME_EVENT_DEVICE_NOT_READY",
        error: "Runtime events require a fresh active device/creator binding",
      });
    }
    return res.json(await processRuntimeEvents({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      userId: req.auth.userId,
      events: input.events,
    }));
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "BUMPS_EVENTS_FAILED");
  }
});
router.post("/bumps/:creatorId/reply-scan", seniorRequired, async (req, res) => {
  try {
    const input = z.object({ limit: z.number().int().min(1).max(500).optional() }).parse(req.body || {});
    return res.status(202).json(await triggerPendingReplyScan({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      limit: input.limit || 100,
    }));
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "BUMPS_REPLY_SCAN_FAILED");
  }
});

const likesListSchema = z.object({
  search: z.string().max(160).optional(),
  state: z.string().max(60).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
router.get("/likes/:creatorId", async (req, res) => {
  try {
    const query = likesListSchema.parse(req.query || {});
    return res.json(await listLikes({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      search: query.search || "",
      state: query.state || null,
      offset: query.offset || 0,
      limit: query.limit || 100,
    }));
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "LIKES_LIST_FAILED");
  }
});
router.post("/likes/:creatorId/discover", seniorRequired, async (req, res) => {
  try {
    const input = z.object({
      fanIds: z.array(z.string().min(1).max(160)).max(1000).optional(),
      force: z.boolean().optional(),
      maxFans: z.number().int().min(1).max(5000).optional(),
      source: z.string().max(80).optional(),
    }).parse(req.body || {});
    return res.status(202).json(await scheduleLikesDiscovery({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      userId: req.auth.userId,
      fanIds: input.fanIds || [],
      force: input.force === true,
      maxFans: input.maxFans || 500,
      source: input.source || "manual_discovery",
      priority: 90,
    }));
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "LIKES_DISCOVERY_FAILED");
  }
});
router.post("/likes/:creatorId/plan", seniorRequired, async (req, res) => {
  try {
    const input = z.object({ candidateIds: z.array(z.string().min(1).max(160)).max(500).optional(), source: z.string().max(80).optional() }).parse(req.body || {});
    return res.status(202).json(await planLikes({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      userId: req.auth.userId,
      candidateIds: input.candidateIds || [],
      source: input.source || "manual_run",
      manual: true,
      priority: input.candidateIds?.length ? 100 : 70,
    }));
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "LIKES_PLAN_FAILED");
  }
});
router.post("/likes/:creatorId/candidates/:candidateId/action", seniorRequired, async (req, res) => {
  try {
    const input = z.object({ action: z.enum(["ignore", "block", "restore", "like", "retry"]) }).parse(req.body || {});
    const candidate = await prisma.automationContentCandidate.findFirst({
      where: { id: req.params.candidateId, agencyId: req.auth.agencyId, creatorId: req.params.creatorId },
    });
    if (!candidate) return res.status(404).json({ ok: false, code: "candidate_not_found", error: "Like candidate not found" });
    if (input.action === "like") {
      return res.status(202).json(await planLikes({
        agencyId: req.auth.agencyId, creatorId: req.params.creatorId, userId: req.auth.userId,
        candidateIds: [candidate.id], source: "candidate_like_now", manual: true, priority: 100,
      }));
    }
    if (input.action === "retry") {
      if (!candidate.latestDeliveryId) return res.status(409).json({ ok: false, code: "no_delivery", error: "Candidate has no delivery to retry" });
      return res.status(202).json(await retryActionDelivery({ agencyId: req.auth.agencyId, deliveryId: candidate.latestDeliveryId }));
    }
    return res.json({ ok: true, candidate: await setLikeCandidateState({
      agencyId: req.auth.agencyId, creatorId: req.params.creatorId, candidateId: candidate.id, action: input.action,
    }) });
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "LIKES_ACTION_FAILED");
  }
});

const deliveryQuerySchema = z.object({
  creatorId: z.string().max(160).optional(),
  moduleKey: z.string().max(80).optional(),
  actionType: z.string().max(80).optional(),
  status: z.string().max(80).optional(),
  deviceId: z.string().max(160).optional(),
  fan: z.string().max(160).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
const sfsListSchema = z.object({
  search: z.string().max(160).optional(),
  state: z.string().max(60).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
router.get("/sfs/:creatorId", async (req, res) => {
  try {
    const query = sfsListSchema.parse(req.query || {});
    return res.json(await listSfs({
      agencyId: req.auth.agencyId, creatorId: req.params.creatorId, search: query.search || "",
      state: query.state || null, offset: query.offset || 0, limit: query.limit || 100,
    }));
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "SFS_LIST_FAILED");
  }
});
router.post("/sfs/:creatorId/discover", seniorRequired, async (req, res) => {
  try {
    const input = z.object({ force: z.boolean().optional(), source: z.string().max(80).optional() }).parse(req.body || {});
    return res.status(202).json(await scheduleSfsDiscovery({
      agencyId: req.auth.agencyId, creatorId: req.params.creatorId, userId: req.auth.userId,
      force: input.force === true, source: input.source || "manual_ui", priority: 90,
    }));
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "SFS_DISCOVERY_FAILED");
  }
});
router.post("/sfs/:creatorId/plan", seniorRequired, async (req, res) => {
  try {
    const input = z.object({ candidateId: z.string().max(160).optional(), source: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).parse(req.body || {});
    return res.status(202).json(await planSfsTargets({
      agencyId: req.auth.agencyId, creatorId: req.params.creatorId, userId: req.auth.userId,
      candidateId: input.candidateId || null, source: input.source || (input.candidateId ? "candidate_run" : "manual_run"),
      priority: input.candidateId ? 100 : 70, limit: input.limit || 20,
    }));
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "SFS_PLAN_FAILED");
  }
});
router.post("/sfs/:creatorId/candidates/:candidateId/action", seniorRequired, async (req, res) => {
  try {
    const input = z.object({ action: z.enum(["ignore", "block", "restore", "run", "retry"]) }).parse(req.body || {});
    return res.json(await setSfsCandidateState({ agencyId: req.auth.agencyId, creatorId: req.params.creatorId, candidateId: req.params.candidateId, action: input.action }));
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "SFS_CANDIDATE_ACTION_FAILED");
  }
});

router.get("/deliveries", async (req, res) => {
  try {
    const query = deliveryQuerySchema.parse(req.query || {});
    const scope = await allowedCreatorScope({
      agencyId: req.auth.agencyId,
      member: req.auth.membership || req.member,
      requestedCreatorId: query.creatorId || null,
    });
    return res.json(await listActionDeliveries({
      agencyId: req.auth.agencyId,
      creatorId: query.creatorId || null,
      creatorIds: scope.creatorIds,
      moduleKey: query.moduleKey || null,
      actionType: query.actionType || null,
      status: query.status || null,
      deviceId: query.deviceId || null,
      fan: query.fan || null,
      offset: query.offset || 0,
      limit: query.limit || 100,
    }));
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "AUTOMATION_DELIVERIES_FAILED");
  }
});

router.post("/deliveries/retry-safe", seniorRequired, async (req, res) => {
  try {
    const input = z.object({
      creatorId: z.string().max(160).optional().nullable(),
      moduleKey: z.string().max(80).optional().nullable(),
      limit: z.number().int().min(1).max(500).optional(),
    }).parse(req.body || {});
    return res.json(await retrySafeFailures({
      agencyId: req.auth.agencyId,
      creatorId: input.creatorId || null,
      moduleKey: input.moduleKey || null,
      limit: input.limit || 100,
    }));
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "AUTOMATION_RETRY_SAFE_FAILED");
  }
});

router.post("/deliveries/:id/retry", seniorRequired, async (req, res) => {
  try { return res.json(await retryActionDelivery({ agencyId: req.auth.agencyId, deliveryId: req.params.id })); }
  catch (error) { return serviceError(res, error, "AUTOMATION_DELIVERY_RETRY_FAILED"); }
});
router.post("/deliveries/:id/cancel", seniorRequired, async (req, res) => {
  try { return res.json(await cancelActionDelivery({ agencyId: req.auth.agencyId, deliveryId: req.params.id, reason: req.body?.reason || "manual_cancel" })); }
  catch (error) { return serviceError(res, error, "AUTOMATION_DELIVERY_CANCEL_FAILED"); }
});
router.post("/deliveries/:id/release", seniorRequired, async (req, res) => {
  try { return res.json(await releaseClaimByAdmin({ agencyId: req.auth.agencyId, deliveryId: req.params.id })); }
  catch (error) { return serviceError(res, error, "AUTOMATION_DELIVERY_RELEASE_FAILED"); }
});

const workerLeaseSchema = z.object({
  deviceId: z.string().min(3).max(160),
  leaseToken: z.string().min(16).max(500),
  leaseRevision: z.number().int().min(1),
  leaseMs: z.number().int().min(30_000).max(10 * 60_000).optional(),
});
router.post("/worker/claim", async (req, res) => {
  try {
    const input = z.object({
      deviceId: z.string().min(3).max(160),
      leaseMs: z.number().int().min(30_000).max(10 * 60_000).optional(),
      actionTypes: z.array(z.enum(["FOLLOW_BACK", "SEND_MESSAGE", "DELETE_MESSAGE", "LIKE_POST", "UNFOLLOW_FAN", "FOLLOW_FAN", "SFS_FOLLOW_TARGET", "SFS_COMMENT_POST", "SFS_LIKE_COMMENT", "SFS_UNFOLLOW_TARGET"])).min(1).max(20).optional(),
    }).parse(req.body || {});
    return res.json({ ok: true, ...(await claimActionDelivery({ userId: req.auth.userId, deviceId: input.deviceId, leaseMs: input.leaseMs, actionTypes: input.actionTypes })) });
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "ACTION_DELIVERY_CLAIM_FAILED");
  }
});
router.post("/worker/:id/renew", async (req, res) => {
  try { const input = workerLeaseSchema.parse(req.body || {}); return res.json(await renewActionLease({ deliveryId: req.params.id, userId: req.auth.userId, ...input })); }
  catch (error) { if (error instanceof z.ZodError) return validationError(res, error); return serviceError(res, error, "ACTION_DELIVERY_RENEW_FAILED"); }
});
router.post("/worker/:id/start", async (req, res) => {
  try { const input = workerLeaseSchema.parse(req.body || {}); return res.json(await startActionDelivery({ deliveryId: req.params.id, userId: req.auth.userId, ...input })); }
  catch (error) { if (error instanceof z.ZodError) return validationError(res, error); return serviceError(res, error, "ACTION_DELIVERY_START_FAILED"); }
});
router.post("/worker/:id/validate", async (req, res) => {
  try { const input = workerLeaseSchema.parse(req.body || {}); return res.json(await validateActionDelivery({ deliveryId: req.params.id, userId: req.auth.userId, ...input })); }
  catch (error) { if (error instanceof z.ZodError) return validationError(res, error); return serviceError(res, error, "ACTION_DELIVERY_VALIDATE_FAILED"); }
});
router.post("/worker/:id/complete", async (req, res) => {
  try {
    const input = workerLeaseSchema.extend({ status: z.enum(["COMPLETED", "SKIPPED"]).optional(), outcomeCode: z.string().max(120).optional().nullable(), result: z.record(z.unknown()).optional() }).parse(req.body || {});
    return res.json(await completeActionDelivery({ deliveryId: req.params.id, userId: req.auth.userId, ...input }));
  } catch (error) { if (error instanceof z.ZodError) return validationError(res, error); return serviceError(res, error, "ACTION_DELIVERY_COMPLETE_FAILED"); }
});
router.post("/worker/:id/fail", async (req, res) => {
  try {
    const input = workerLeaseSchema.extend({ failureCode: z.string().min(1).max(120), error: z.string().max(2000).optional(), retryable: z.boolean().optional(), retryAfterMs: z.number().int().min(0).max(24 * 60 * 60_000).optional(), result: z.record(z.unknown()).optional() }).parse(req.body || {});
    return res.json(await failActionDelivery({ deliveryId: req.params.id, userId: req.auth.userId, ...input }));
  } catch (error) { if (error instanceof z.ZodError) return validationError(res, error); return serviceError(res, error, "ACTION_DELIVERY_FAIL_FAILED"); }
});
router.post("/worker/:id/release", async (req, res) => {
  try {
    const input = workerLeaseSchema.extend({ reason: z.string().min(1).max(500), runAfterMs: z.number().int().min(0).max(24 * 60 * 60_000).optional() }).parse(req.body || {});
    return res.json(await releaseActionDelivery({ deliveryId: req.params.id, userId: req.auth.userId, ...input }));
  } catch (error) { if (error instanceof z.ZodError) return validationError(res, error); return serviceError(res, error, "ACTION_DELIVERY_RELEASE_FAILED"); }
});

router.use((error, _req, res, _next) => {
  if (error instanceof ActionDeliveryError) return serviceError(res, error);
  return serviceError(res, error);
});

module.exports = router;

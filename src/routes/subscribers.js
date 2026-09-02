"use strict";

const express = require("express");
const { z } = require("zod");
const { automationCreatorParamRequired } = require("../middleware/automation-permissions");
const { requireProductPermission } = require("../middleware/product-access");
const { attachAutomationAudit } = require("../middleware/automation-audit");
const {
  scheduleSubscriberScan,
  getSubscriberDirectoryStatus,
  listHiddenOnline,
  setHiddenOnlineStatus,
} = require("../services/subscriber-directory-service");

const router = express.Router();
attachAutomationAudit(router);
router.param("creatorId", automationCreatorParamRequired());

function automationManagementRequired(req, res, next) {
  requireProductPermission(req, "automation.manage", { code: "WRITE_AUTOMATION_FORBIDDEN" })
    .then(() => next())
    .catch((error) => res.status(Number(error?.status) || 403).json({ ok: false, code: error?.code || "WRITE_AUTOMATION_FORBIDDEN", error: error?.message || "Automation management permission is required" }));
}

function validationError(res, error) {
  return res.status(400).json({
    ok: false,
    code: "VALIDATION_ERROR",
    error: error.issues?.[0]?.message || "Validation error",
  });
}

function serviceError(res, error, fallbackCode) {
  const code = error?.code || fallbackCode || "SUBSCRIBER_DIRECTORY_FAILED";
  const status =
    code === "CREATOR_NOT_FOUND" || code === "HIDDEN_ONLINE_NOT_FOUND"
      ? 404
      : code === "SUBSCRIBER_SNAPSHOT_NOT_READY" || code === "CREATOR_SCOPE_REQUIRED"
        ? 409
        : 500;
  return res.status(status).json({ ok: false, code, error: error?.message || "Subscriber directory request failed" });
}

const scanSchema = z.object({
  force: z.boolean().optional(),
  manual: z.boolean().optional(),
  mode: z.enum(["full"]).optional(),
  sourceType: z.string().min(1).max(40).optional(),
  pageLimit: z.number().int().min(20).max(100).optional(),
  scanEveryDays: z.number().int().min(1).max(30).optional(),
});

router.post("/:creatorId/scan", automationManagementRequired, async (req, res) => {
  try {
    const input = scanSchema.parse(req.body || {});
    const creator = req.automationCreator;
    const result = await scheduleSubscriberScan({
      agencyId: req.auth.agencyId,
      creatorId: creator.id,
      userId: req.auth.userId || null,
      manual: input.manual !== false,
      force: input.force === true,
      mode: input.mode || "full",
      sourceType: input.sourceType || "all",
      pageLimit: input.pageLimit || 100,
      scanEveryDays: input.scanEveryDays || 7,
      priority: 80,
      reason: input.force === true ? "manual_force_hidden_online_scan" : "manual_hidden_online_scan",
    });
    return res.status(result.created ? 202 : 200).json(result);
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "SUBSCRIBER_SCAN_SCHEDULE_FAILED");
  }
});

router.get("/:creatorId/status", async (req, res) => {
  try {
    const creator = req.automationCreator;
    return res.json(await getSubscriberDirectoryStatus({ agencyId: req.auth.agencyId, creatorId: creator.id }));
  } catch (error) {
    return serviceError(res, error, "SUBSCRIBER_STATUS_FAILED");
  }
});

const hiddenQuerySchema = z.object({
  status: z.enum(["active", "ignored", "blocked", "all"]).optional(),
  search: z.string().max(160).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  sort: z.enum(["spent_desc", "recent", "name"]).optional(),
});

router.get("/:creatorId/hidden-online", async (req, res) => {
  try {
    const query = hiddenQuerySchema.parse(req.query || {});
    const creator = req.automationCreator;
    return res.json(
      await listHiddenOnline({
        agencyId: req.auth.agencyId,
        creatorId: creator.id,
        status: query.status || "active",
        search: query.search || "",
        offset: query.offset || 0,
        limit: query.limit || 100,
        sort: query.sort || "spent_desc",
      })
    );
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "HIDDEN_ONLINE_LIST_FAILED");
  }
});

const statusSchema = z.object({ status: z.enum(["active", "ignored", "blocked"]) });

router.patch("/:creatorId/hidden-online/:fanId/status", automationManagementRequired, async (req, res) => {
  try {
    const input = statusSchema.parse(req.body || {});
    const creator = req.automationCreator;
    return res.json(
      await setHiddenOnlineStatus({
        agencyId: req.auth.agencyId,
        creatorId: creator.id,
        fanId: String(req.params.fanId || "").trim(),
        status: input.status,
      })
    );
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "HIDDEN_ONLINE_STATUS_FAILED");
  }
});

module.exports = router;

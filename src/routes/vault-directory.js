"use strict";

const express = require("express");
const { z } = require("zod");
const {
  getVaultDirectoryIntelligence,
  checkProtectedVaultMedia,
} = require("../services/vault-directory-service");
const {
  getVaultUnsortedState,
  listVaultUnsortedMedia,
  scheduleVaultUnsortedScan,
  pauseVaultUnsortedScan,
  resumeVaultUnsortedScan,
  cancelVaultUnsortedScan,
  markVaultUnsortedItems,
} = require("../services/vault-unsorted-service");

const { automationCreatorParamRequired } = require("../middleware/automation-permissions");

const router = express.Router();

const unsortedStartSchema = z.object({
  mode: z.enum(["incremental", "full"]).optional(),
  source: z.string().max(80).optional(),
  priority: z.number().int().min(0).max(200).optional(),
});
const unsortedListSchema = z.object({
  offset: z.number().int().min(0).max(1_000_000).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  type: z.enum(["photo", "video", "audio", "gif", "unknown"]).optional().nullable(),
});
const unsortedMarkSchema = z.object({
  mediaIds: z.array(z.string().min(1).max(240)).min(1).max(10_000),
  status: z.enum(["SORTED", "UNSORTED", "HIDDEN"]),
});

router.param("creatorId", automationCreatorParamRequired());

function sendError(res, error, fallbackCode) {
  const code = error?.code || fallbackCode;
  const status = code === "CREATOR_NOT_FOUND" ? 404 : code === "MEDIA_IDS_INVALID" ? 400 : 500;
  return res.status(status).json({ ok: false, code, error: String(error?.message || error || "Vault directory request failed") });
}


router.get("/:creatorId/unsorted", async (req, res) => {
  try {
    return res.json(await getVaultUnsortedState({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
    }));
  } catch (error) {
    return sendError(res, error, "VAULT_UNSORTED_STATE_FAILED");
  }
});

router.post("/:creatorId/unsorted/items", async (req, res) => {
  try {
    const input = unsortedListSchema.parse(req.body || {});
    return res.json(await listVaultUnsortedMedia({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      ...input,
    }));
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: error.issues?.[0]?.message || "Validation error" });
    return sendError(res, error, "VAULT_UNSORTED_LIST_FAILED");
  }
});

router.post("/:creatorId/unsorted/scans", async (req, res) => {
  try {
    const input = unsortedStartSchema.parse(req.body || {});
    const result = await scheduleVaultUnsortedScan({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      userId: req.auth.userId,
      mode: input.mode || "incremental",
      source: input.source || "vault_ui",
      priority: input.priority ?? 80,
    });
    return res.status(result.created ? 202 : 200).json(result);
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: error.issues?.[0]?.message || "Validation error" });
    return sendError(res, error, "VAULT_UNSORTED_START_FAILED");
  }
});

router.post("/:creatorId/unsorted/pause", async (req, res) => {
  try {
    return res.json(await pauseVaultUnsortedScan({ agencyId: req.auth.agencyId, creatorId: req.params.creatorId, userId: req.auth.userId }));
  } catch (error) {
    return sendError(res, error, "VAULT_UNSORTED_PAUSE_FAILED");
  }
});

router.post("/:creatorId/unsorted/resume", async (req, res) => {
  try {
    return res.json(await resumeVaultUnsortedScan({ agencyId: req.auth.agencyId, creatorId: req.params.creatorId, userId: req.auth.userId }));
  } catch (error) {
    return sendError(res, error, "VAULT_UNSORTED_RESUME_FAILED");
  }
});

router.post("/:creatorId/unsorted/cancel", async (req, res) => {
  try {
    return res.json(await cancelVaultUnsortedScan({ agencyId: req.auth.agencyId, creatorId: req.params.creatorId, userId: req.auth.userId }));
  } catch (error) {
    return sendError(res, error, "VAULT_UNSORTED_CANCEL_FAILED");
  }
});

router.post("/:creatorId/unsorted/items/mark", async (req, res) => {
  try {
    const input = unsortedMarkSchema.parse(req.body || {});
    return res.json(await markVaultUnsortedItems({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      mediaIds: input.mediaIds,
      status: input.status,
    }));
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: error.issues?.[0]?.message || "Validation error" });
    return sendError(res, error, "VAULT_UNSORTED_MARK_FAILED");
  }
});

router.post("/:creatorId/intelligence", async (req, res) => {
  try {
    const result = await getVaultDirectoryIntelligence({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      mediaIds: req.body?.mediaIds || [],
    });
    return res.json(result);
  } catch (error) {
    return sendError(res, error, "VAULT_DIRECTORY_INTELLIGENCE_FAILED");
  }
});

router.post("/:creatorId/protection-check", async (req, res) => {
  try {
    const result = await checkProtectedVaultMedia({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      mediaIds: req.body?.mediaIds || [],
    });
    return res.json(result);
  } catch (error) {
    return sendError(res, error, "VAULT_DIRECTORY_PROTECTION_CHECK_FAILED");
  }
});

module.exports = router;

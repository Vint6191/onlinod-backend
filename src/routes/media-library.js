"use strict";

const express = require("express");
const { z } = require("zod");
const { automationCreatorParamRequired } = require("../middleware/automation-permissions");
const { isSeniorAgencyMember } = require("../middleware/team-permissions");
const {
  getMediaMetadata,
  upsertMediaMetadata,
  listStorylines,
  replaceUsageSources,
  mutateFolderMembership,
  deleteMediaAssets,
  getMediaSalesSummary,
  listMediaSalesAssets,
} = require("../services/media-library-service");

const router = express.Router();

const mediaIdsSchema = z.object({
  mediaIds: z.array(z.string().min(1).max(240)).max(5000),
});
const metadataSchema = z.object({
  mediaType: z.enum(["photo", "video", "audio", "gif", "unknown"]),
  durationSec: z.number().int().min(0).max(86400).nullable().optional(),
  description: z.string().max(12000),
  manualTags: z.array(z.string().max(80)).max(100),
  visibleBodyParts: z.array(z.string().max(80)).max(100),
  accessType: z.enum(["free", "paid"]),
  minPrice: z.number().min(0).max(20_000_000),
  idealPrice: z.number().min(0).max(20_000_000),
  storylineName: z.string().max(200).nullable().optional(),
  storylineOrder: z.number().int().min(-100000).max(100000).nullable().optional(),
  storylineRole: z.enum(["main", "additional"]).nullable().optional(),
});
const usageItemSchema = z.object({
  mediaId: z.string().min(1).max(240),
  sentCount: z.number().int().min(0).max(10_000_000),
  soldCount: z.number().int().min(0).max(10_000_000),
  notOpenedCount: z.number().int().min(0).max(10_000_000),
  freeCount: z.number().int().min(0).max(10_000_000),
  revenueCents: z.number().int().min(0).max(2_000_000_000),
  uniqueBuyers: z.number().int().min(0).max(10_000_000),
  lastSoldAt: z.string().max(100).nullable().optional(),
});
const usageSourcesSchema = z.object({
  sources: z.array(z.object({
    sourceKey: z.string().min(1).max(240),
    sourceRevision: z.string().min(1).max(100),
    capturedAt: z.string().max(100).optional(),
    items: z.array(usageItemSchema).max(2000),
  })).min(1).max(25),
});
const folderMutationSchema = z.object({
  mediaIds: z.array(z.string().min(1).max(240)).min(1).max(5000),
  folderId: z.string().min(1).max(240),
  action: z.enum(["add", "remove"]),
});
const salesListSchema = z.object({
  offset: z.number().int().min(0).max(10_000_000).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  mediaType: z.enum(["photo", "video", "audio", "gif", "unknown"]).nullable().optional(),
});

router.param("creatorId", automationCreatorParamRequired());

function sendError(res, error, fallbackCode) {
  if (error instanceof z.ZodError) {
    return res.status(400).json({
      ok: false,
      code: "VALIDATION_ERROR",
      error: error.issues?.[0]?.message || "Validation error",
    });
  }
  const code = error?.code || fallbackCode;
  const status = code === "CREATOR_NOT_FOUND" ? 404
    : ["MEDIA_ID_MISSING", "MEDIA_IDS_INVALID"].includes(code) ? 400
      : 500;
  return res.status(status).json({
    ok: false,
    code,
    error: String(error?.message || error || "Media Library request failed"),
  });
}

function seniorRequired(req, res, next) {
  const member = req.auth?.membership || req.member;
  if (!member || !isSeniorAgencyMember(member)) {
    return res.status(403).json({
      ok: false,
      code: "MEDIA_LIBRARY_DELETE_FORBIDDEN",
      error: "Owner, admin or manager permission is required",
    });
  }
  return next();
}

router.post("/:creatorId/assets/query", async (req, res) => {
  try {
    const input = mediaIdsSchema.parse(req.body || {});
    return res.json(await getMediaMetadata({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      mediaIds: input.mediaIds,
    }));
  } catch (error) {
    return sendError(res, error, "MEDIA_LIBRARY_QUERY_FAILED");
  }
});

router.put("/:creatorId/assets/:mediaId/metadata", async (req, res) => {
  try {
    const input = metadataSchema.parse(req.body || {});
    return res.json(await upsertMediaMetadata({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      mediaId: req.params.mediaId,
      input,
      userId: req.auth.userId,
    }));
  } catch (error) {
    return sendError(res, error, "MEDIA_LIBRARY_METADATA_UPDATE_FAILED");
  }
});

router.get("/:creatorId/storylines", async (req, res) => {
  try {
    return res.json(await listStorylines({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
    }));
  } catch (error) {
    return sendError(res, error, "MEDIA_LIBRARY_STORYLINES_FAILED");
  }
});

router.put("/:creatorId/usage-sources", async (req, res) => {
  try {
    const input = usageSourcesSchema.parse(req.body || {});
    return res.json(await replaceUsageSources({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      sources: input.sources,
    }));
  } catch (error) {
    return sendError(res, error, "MEDIA_LIBRARY_USAGE_SYNC_FAILED");
  }
});

router.post("/:creatorId/folders/mutate", async (req, res) => {
  try {
    const input = folderMutationSchema.parse(req.body || {});
    return res.json(await mutateFolderMembership({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      mediaIds: input.mediaIds,
      folderId: input.folderId,
      action: input.action,
    }));
  } catch (error) {
    return sendError(res, error, "MEDIA_LIBRARY_FOLDER_MUTATION_FAILED");
  }
});

router.post("/:creatorId/assets/delete", seniorRequired, async (req, res) => {
  try {
    const input = mediaIdsSchema.parse(req.body || {});
    return res.json(await deleteMediaAssets({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      mediaIds: input.mediaIds,
    }));
  } catch (error) {
    return sendError(res, error, "MEDIA_LIBRARY_DELETE_FAILED");
  }
});

router.get("/:creatorId/sales/summary", async (req, res) => {
  try {
    return res.json(await getMediaSalesSummary({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
    }));
  } catch (error) {
    return sendError(res, error, "MEDIA_LIBRARY_SALES_SUMMARY_FAILED");
  }
});

router.post("/:creatorId/sales/assets", async (req, res) => {
  try {
    const input = salesListSchema.parse(req.body || {});
    return res.json(await listMediaSalesAssets({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      ...input,
    }));
  } catch (error) {
    return sendError(res, error, "MEDIA_LIBRARY_SALES_ASSETS_FAILED");
  }
});

module.exports = router;

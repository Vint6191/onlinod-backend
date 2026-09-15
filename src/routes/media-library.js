"use strict";

const express = require("express");
const { z } = require("zod");
const { automationCreatorParamRequired } = require("../middleware/automation-permissions");
const { requireProductPermission, requireProductDevice, currentAccessEpoch } = require("../middleware/product-access");
const { assertExecutionAccessFence } = require("../services/execution-access-fence-service");
const {
  getMediaMetadata,
  searchMediaLibrary,
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
const searchSchema = z.object({
  query: z.string().max(240).default(""),
  scope: z.enum(["everything", "description", "tags", "folders"]).default("everything"),
  folderId: z.string().max(240).nullable().optional(),
  folderMatchIds: z.array(z.string().min(1).max(240)).max(500).optional(),
  mediaType: z.enum(["all", "photo", "video", "audio", "gif", "unknown"]).nullable().optional(),
  offset: z.number().int().min(0).max(10_000_000).optional(),
  limit: z.number().int().min(1).max(100).optional(),
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
  accessEpoch: z.number().int().min(0),
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
  const status = Number(error?.status) || (code === "CREATOR_NOT_FOUND" ? 404
    : ["MEDIA_ID_MISSING", "MEDIA_IDS_INVALID"].includes(code) ? 400
      : 500);
  return res.status(status).json({
    ok: false,
    code,
    error: String(error?.message || error || "Media Library request failed"),
  });
}

function vaultManagementRequired(req, res, next) {
  requireProductPermission(req, "content.manage_vault", { code: "MEDIA_LIBRARY_MANAGE_FORBIDDEN" })
    .then(() => next())
    .catch((error) => sendError(res, error, "MEDIA_LIBRARY_MANAGE_FORBIDDEN"));
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

router.post("/:creatorId/assets/search", async (req, res) => {
  try {
    const input = searchSchema.parse(req.body || {});
    return res.json(await searchMediaLibrary({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      ...input,
    }));
  } catch (error) {
    return sendError(res, error, "MEDIA_LIBRARY_SEARCH_FAILED");
  }
});

router.put("/:creatorId/assets/:mediaId/metadata", vaultManagementRequired, async (req, res) => {
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

async function putCurrentAuthorizedUsageSources(req, res) {
  try {
    requireProductDevice(req, req.auth?.deviceId);
    const input = usageSourcesSchema.parse(req.body || {});
    const admittedAccessEpoch = currentAccessEpoch(req);
    if (!Number.isInteger(admittedAccessEpoch) || input.accessEpoch !== admittedAccessEpoch) {
      const error = new Error("Media Library usage sync authorization generation is stale");
      error.code = "MEDIA_LIBRARY_USAGE_AUTHORIZATION_STALE";
      error.status = 409;
      throw error;
    }
    const memberId = String(req.auth?.memberId || req.auth?.membership?.id || "").trim();
    const userId = String(req.auth?.userId || "").trim();
    const creatorId = String(req.params.creatorId || "").trim();
    const commitGuard = async (tx) => assertExecutionAccessFence({
      db: tx,
      agencyId: req.auth.agencyId,
      userId,
      memberId,
      accessEpoch: input.accessEpoch,
      creatorId,
      lock: true,
    });
    return res.json(await replaceUsageSources({
      agencyId: req.auth.agencyId,
      creatorId,
      sources: input.sources,
      commitGuard,
    }));
  } catch (error) {
    return sendError(res, error, "MEDIA_LIBRARY_USAGE_SYNC_FAILED");
  }
}

// New Desktop builds use a versioned path so they fail closed against an old
// backend replica instead of having accessEpoch stripped by the legacy Zod
// object and committing without generation proof during a rolling deploy.
router.put("/:creatorId/usage-sources/current-authorized", putCurrentAuthorizedUsageSources);
// The legacy path remains mounted only with the same mandatory proof. Old
// Desktop builds therefore fail closed after the backend rollout.
router.put("/:creatorId/usage-sources", putCurrentAuthorizedUsageSources);

router.post("/:creatorId/folders/mutate", vaultManagementRequired, async (req, res) => {
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

router.post("/:creatorId/assets/delete", vaultManagementRequired, async (req, res) => {
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

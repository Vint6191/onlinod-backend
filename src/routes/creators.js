const express = require("express");
const multer = require("multer");
const path = require("node:path");
const fs = require("node:fs");
const { z } = require("zod");

const prisma = require("../prisma");
const { authRequired, requireAuthDevice } = require("../middleware/auth");
const { creatorManagementRequired } = require("../middleware/creator-management-permissions");
const { allowedCreatorScope, requireCreatorAccess } = require("../middleware/automation-permissions");
const { audit } = require("../services/audit-service");
const { scheduleInitialJobsForCreator } = require("../services/job-scheduler");
const { agencyRemovalPhrase } = require("../services/creator-agency-removal");
const { retireCreatorWithinTransaction, publishCreatorRetirementControlEvents } = require("../services/creator-lifecycle-authority-service");
const { setCreatorTelegramUserId } = require("../services/creator-telegram-identity");
const { updateCreatorTelegramContact } = require("../services/creator-telegram-contact-authority-service");
const {
  createCreatorDraft,
  beginCreatorConnection,
  completeCreatorConnection,
  observeCreatorPlatformProfile,
} = require("../services/creator-enrollment-authority-service");
const {
  assertHumanCreatorCreateAuthority,
  lockHumanCreatorMutation,
  currentCreatorCatalogGeneration,
} = require("../services/creator-human-management-authority-service");

const router = express.Router();

const uploadsDir = path.join(__dirname, "..", "..", "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

const ALLOWED_AVATAR_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const ALLOWED_AVATAR_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

function avatarExtension(file) {
  const ext = path.extname(file.originalname || "").toLowerCase();
  return ALLOWED_AVATAR_EXTENSIONS.has(ext) ? ext : ".jpg";
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    cb(null, `avatar_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${avatarExtension(file)}`);
  },
});

function looksLikeAllowedImage(filePath, mimeType) {
  const header = fs.readFileSync(filePath).subarray(0, 16);
  const hex = header.toString("hex");
  const ascii = header.toString("ascii");

  if (mimeType === "image/jpeg") return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  if (mimeType === "image/png") return hex.startsWith("89504e470d0a1a0a");
  if (mimeType === "image/gif") return ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a");
  if (mimeType === "image/webp") return ascii.startsWith("RIFF") && header.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
}

function safeUnlink(filePath) {
  try { if (filePath) fs.unlinkSync(filePath); } catch (_) {}
}

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const mime = String(file.mimetype || "").toLowerCase();
    if (!ALLOWED_AVATAR_EXTENSIONS.has(ext) || !ALLOWED_AVATAR_MIME.has(mime)) {
      return cb(new Error("Only jpg, png, webp or gif image files are allowed"));
    }
    cb(null, true);
  },
});

const creatorUsernameSchema = z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9._-]+$/, "Invalid OnlyFans username");

const createSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  username: creatorUsernameSchema,
  notes: z.string().trim().max(2000).optional().nullable(),
});

const updateSchema = createSchema.partial();

const completeConnectionSchema = z.object({
  remoteId: z.string().min(1).max(120),
  username: creatorUsernameSchema,
  connectionGeneration: z.number().int().positive(),
  displayName: z.string().trim().min(1).max(120).optional().nullable(),
  avatarUrl: z.string().max(2000).optional().nullable(),
});

const platformProfileSchema = z.object({
  deviceId: z.string().trim().min(1).max(180),
  connectionGeneration: z.number().int().positive(),
  observedAt: z.string().datetime(),
  remoteId: z.string().min(1).max(120),
  username: creatorUsernameSchema,
  displayName: z.string().trim().min(1).max(120).optional().nullable(),
  avatarUrl: z.string().max(2000).optional().nullable(),
}).strict();

const agencyRemovalSchema = z.object({
  phrase: z.string().min(1).max(240),
  acknowledgeAgencyRemoval: z.literal(true),
  acknowledgeSessionRevocation: z.literal(true),
});

const telegramContactSchema = z.object({
  telegramContact: z.string().trim().min(1).max(160).regex(/^[^\r\n\t]+$/, "Invalid Telegram contact").nullable(),
  telegramAccountId: z.string().trim().min(1).max(180).nullable().optional(),
});

const telegramIdentitySchema = z.object({
  telegramUserId: z.string().trim().regex(/^\d{1,20}$/, "Invalid Telegram user id"),
  telegramContact: z.string().trim().min(1).max(160).regex(/^[^\r\n\t]+$/, "Invalid Telegram contact"),
});

function normalizeUsername(value) {
  const clean = String(value || "").trim().replace(/^@+/, "");
  return clean ? clean.toLowerCase() : null;
}

function jsonRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}


async function findCreatorConflict({ db = prisma, agencyId, remoteId = null, username = null, excludeId = null }) {
  const or = [];
  if (remoteId) or.push({ remoteId: String(remoteId) });
  if (username) {
    const normalized = normalizeUsername(username);
    or.push(
      { platformUsername: { equals: normalized, mode: "insensitive" } },
      { enrollmentExpectedUsername: { equals: normalized, mode: "insensitive" } },
      { username: { equals: normalized, mode: "insensitive" } },
    );
  }
  if (!or.length) return null;
  return db.creatorAccount.findFirst({
    where: {
      agencyId,
      deletedAt: null,
      ...(excludeId ? { id: { not: excludeId } } : {}),
      OR: or,
    },
  });
}

function creatorErrorResponse(res, error, fallbackCode, fallbackMessage) {
  if (error?.issues) {
    return res.status(400).json({
      ok: false,
      code: "VALIDATION_ERROR",
      error: error.issues[0]?.message || "Validation error",
      issues: error.issues,
    });
  }
  if (String(error?.code || "") === "P2002") {
    return res.status(409).json({ ok: false, code: "CREATOR_ALREADY_EXISTS", error: "This OnlyFans creator identity or username is already active in the agency" });
  }
  if (error?.status && error?.code) {
    const payload = { ok: false, code: error.code, error: error.message || fallbackMessage };
    if (error.creatorId) payload.creatorId = error.creatorId;
    if (error.currentConnectionState) payload.currentConnectionState = error.currentConnectionState;
    if (error.currentConnectionGeneration != null) payload.currentConnectionGeneration = error.currentConnectionGeneration;
    if (error.details && typeof error.details === "object") payload.details = error.details;
    return res.status(Number(error.status)).json(payload);
  }
  return res.status(500).json({ ok: false, code: fallbackCode, error: fallbackMessage });
}



function publicBaseUrl(req) {
  return (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
}

async function creatorAccessRequired(req, res, next) {
  try {
    req.authorizedCreator = await requireCreatorAccess({
      agencyId: req.auth.agencyId,
      member: req.auth.membership,
      creatorId: req.params.id,
    });
    return next();
  } catch (error) {
    return res.status(Number(error?.status) || 403).json({
      ok: false,
      code: error?.code || "CREATOR_ACCESS_FORBIDDEN",
      error: error?.message || "Creator access denied",
    });
  }
}

router.use(authRequired);

router.get("/", async (req, res) => {
  try {
    const scope = await allowedCreatorScope({ agencyId: req.auth.agencyId, member: req.auth.membership });
    const creators = await prisma.creatorAccount.findMany({
      where: {
        agencyId: req.auth.agencyId,
        deletedAt: null,
        ...(scope.broad ? {} : { id: { in: scope.creatorIds.length ? scope.creatorIds : ["__none__"] } }),
      },
      include: {
        sessionState: {
          select: {
            status: true,
            revision: true,
            payloadVersion: true,
            portableReady: true,
            platformUserId: true,
            capturedByDeviceId: true,
            updatedAt: true,
          },
        },
        networkProfile: {
          select: {
            mode: true,
            proxyEndpointId: true,
            version: true,
            updatedAt: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 10000});

    return res.json({ ok: true, creators });
  } catch (err) {
    console.error("[creators/list] failed:", err);
    return res.status(500).json({ ok: false, code: "CREATORS_LIST_FAILED", error: "Failed to list creators" });
  }
});

router.post("/", creatorManagementRequired, async (req, res) => {
  try {
    const scope = await allowedCreatorScope({ agencyId: req.auth.agencyId, member: req.auth.membership });
    if (!scope.broad) {
      return res.status(403).json({ ok: false, code: "CREATOR_CREATE_REQUIRES_ALL_SCOPE", error: "Creating a new creator requires all-creators scope" });
    }
    const input = createSchema.parse(req.body);
    const username = normalizeUsername(input.username);
    const conflict = await findCreatorConflict({ agencyId: req.auth.agencyId, username });
    if (conflict) {
      return res.status(409).json({ ok: false, code: "CREATOR_ALREADY_EXISTS", error: "This OnlyFans creator is already connected", creatorId: conflict.id });
    }

    const creator = await createCreatorDraft({
      db: prisma,
      agencyId: req.auth.agencyId,
      displayName: input.displayName,
      username,
      notes: input.notes || null,
      beforeCreate: async (tx) => {
        await assertHumanCreatorCreateAuthority({
          tx,
          agencyId: req.auth.agencyId,
          actorMember: req.auth.membership,
        });
      },
    });

    await audit({
      agencyId: req.auth.agencyId,
      actorUserId: req.auth.userId,
      action: "creator.created",
      targetType: "creator",
      targetId: creator.id,
      metadata: { username: creator.username, status: creator.status },
    });
    const creatorCatalogGeneration = await currentCreatorCatalogGeneration({ db: prisma, agencyId: req.auth.agencyId });
    return res.status(201).json({ ok: true, creator, creatorCatalogGeneration });
  } catch (err) {
    console.error("[creators/create] failed:", err);
    return creatorErrorResponse(res, err, "CREATOR_CREATE_FAILED", "Failed to create creator");
  }
});

router.get("/:id", creatorAccessRequired, async (req, res) => {
  try {
    const creator = await prisma.creatorAccount.findFirst({
      where: {
        id: req.params.id,
        agencyId: req.auth.agencyId,
        deletedAt: null,
      },
      include: {
        sessionState: {
          select: {
            status: true,
            revision: true,
            payloadVersion: true,
            portableReady: true,
            platformUserId: true,
            capturedByDeviceId: true,
            updatedAt: true,
          },
        },
        networkProfile: {
          select: {
            mode: true,
            proxyEndpointId: true,
            version: true,
            updatedAt: true,
          },
        },
      },
    });

    if (!creator) {
      return res.status(404).json({ ok: false, code: "CREATOR_NOT_FOUND", error: "Creator not found" });
    }

    return res.json({ ok: true, creator });
  } catch (err) {
    console.error("[creators/read] failed:", err);
    return res.status(500).json({ ok: false, code: "CREATOR_READ_FAILED", error: "Failed to read creator" });
  }
});

router.patch("/:id/telegram-contact", creatorManagementRequired, creatorAccessRequired, async (req, res) => {
  try {
    const input = telegramContactSchema.parse(req.body);
    const creator = await updateCreatorTelegramContact({
      agencyId: req.auth.agencyId,
      actorMember: req.auth.membership,
      actorUserId: req.auth.userId,
      creatorId: req.params.id,
      telegramContact: input.telegramContact,
      telegramAccountId: input.telegramAccountId,
      db: prisma,
    });
    return res.json({ ok: true, creator });
  } catch (err) {
    if (err?.issues) return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: err.issues[0]?.message || "Validation error", issues: err.issues });
    const status = Number(err?.status || 0);
    if (status >= 400 && status < 600) return res.status(status).json({ ok: false, code: err?.code || "CREATOR_TELEGRAM_CONTACT_UPDATE_FAILED", error: err?.message || "Failed to update Telegram contact" });
    console.error("[creators/telegram-contact] failed:", err);
    return res.status(500).json({ ok: false, code: "CREATOR_TELEGRAM_CONTACT_UPDATE_FAILED", error: "Failed to update Telegram contact" });
  }
});

router.patch("/:id/telegram-identity", creatorManagementRequired, creatorAccessRequired, async (req, res) => {
  try {
    const input = telegramIdentitySchema.parse(req.body);
    const before = await prisma.creatorAccount.findFirst({
      where: { id: req.params.id, agencyId: req.auth.agencyId, deletedAt: null },
      select: { id: true, telegramContact: true, telegramUserId: true },
    });
    if (!before) {
      return res.status(404).json({ ok: false, code: "CREATOR_NOT_FOUND", error: "Creator not found" });
    }

    const creator = await setCreatorTelegramUserId({
      agencyId: req.auth.agencyId,
      actorMember: req.auth.membership,
      creatorId: before.id,
      telegramUserId: input.telegramUserId,
      expectedTelegramContact: input.telegramContact,
      db: prisma,
    });

    await audit({
      agencyId: req.auth.agencyId,
      actorUserId: req.auth.userId,
      action: "creator.telegram_identity.resolved",
      targetType: "creator",
      targetId: creator.id,
      metadata: {
        hadIdentity: Boolean(before.telegramUserId),
        hasIdentity: Boolean(creator.telegramUserId),
      },
    });

    return res.json({ ok: true, creator });
  } catch (err) {
    if (err?.issues) {
      return res.status(400).json({
        ok: false,
        code: "VALIDATION_ERROR",
        error: err.issues[0]?.message || "Validation error",
        issues: err.issues,
      });
    }
    if (err?.status && err?.code) {
      return res.status(Number(err.status)).json({ ok: false, code: err.code, error: err.message || "Failed to save Telegram identity" });
    }
    console.error("[creators/telegram-identity] failed:", err);
    return res.status(500).json({ ok: false, code: "CREATOR_TELEGRAM_IDENTITY_UPDATE_FAILED", error: "Failed to save Telegram identity" });
  }
});

router.patch("/:id", creatorManagementRequired, creatorAccessRequired, async (req, res) => {
  try {
    const input = updateSchema.parse(req.body);

    // Admission reads remain useful for fast UX, but they are not the commit
    // authority. The transaction below re-locks Agency -> Creator -> actor.
    const admitted = await prisma.creatorAccount.findFirst({
      where: { id: req.params.id, agencyId: req.auth.agencyId, deletedAt: null },
    });
    if (!admitted) {
      return res.status(404).json({ ok: false, code: "CREATOR_NOT_FOUND", error: "Creator not found" });
    }

    const creator = await prisma.$transaction(async (tx) => {
      const locked = await lockHumanCreatorMutation({
        tx,
        agencyId: req.auth.agencyId,
        creatorId: req.params.id,
        actorMember: req.auth.membership,
      });
      const existing = locked.creator || await tx.creatorAccount.findFirst({
        where: { id: req.params.id, agencyId: req.auth.agencyId, deletedAt: null },
      });
      if (!existing) {
        const error = Object.assign(new Error("Creator not found"), { code: "CREATOR_NOT_FOUND", status: 404 });
        throw error;
      }

      const nextUsername = input.username === undefined ? existing.username : normalizeUsername(input.username);
      if (input.username !== undefined && existing.remoteId && normalizeUsername(existing.platformUsername || existing.username) !== nextUsername) {
        const error = Object.assign(new Error("Connected creator username is updated only from verified platform identity observations"), {
          code: "CREATOR_PLATFORM_USERNAME_OBSERVATION_REQUIRED", status: 409,
        });
        throw error;
      }
      const conflict = await findCreatorConflict({ db: tx, agencyId: req.auth.agencyId, username: nextUsername, excludeId: existing.id });
      if (conflict) {
        const error = Object.assign(new Error("This OnlyFans creator is already connected"), {
          code: "CREATOR_ALREADY_EXISTS", status: 409, creatorId: conflict.id,
        });
        throw error;
      }

      return tx.creatorAccount.update({
        where: { id: existing.id },
        data: {
          displayName: input.displayName === undefined ? undefined : input.displayName.trim(),
          username: input.username === undefined ? undefined : nextUsername,
          enrollmentExpectedUsername: input.username === undefined || existing.remoteId ? undefined : nextUsername,
          notes: input.notes === undefined ? undefined : input.notes || null,
        },
      });
    }, { maxWait: 10_000, timeout: 30_000 });

    await audit({
      agencyId: req.auth.agencyId,
      actorUserId: req.auth.userId,
      action: "creator.updated",
      targetType: "creator",
      targetId: creator.id,
      metadata: { username: creator.username, status: creator.status },
    });

    return res.json({ ok: true, creator });
  } catch (err) {
    console.error("[creators/update] failed:", err);
    return creatorErrorResponse(res, err, "CREATOR_UPDATE_FAILED", "Failed to update creator");
  }
});

router.delete("/:id", creatorManagementRequired, creatorAccessRequired, async (req, res) => {
  try {
    const input = agencyRemovalSchema.parse(req.body);
    const existing = await prisma.creatorAccount.findFirst({
      where: {
        id: req.params.id,
        agencyId: req.auth.agencyId,
      },
    });

    if (!existing) {
      return res.status(404).json({ ok: false, code: "CREATOR_NOT_FOUND", error: "Creator not found" });
    }

    let expectedPhrase;
    try {
      expectedPhrase = agencyRemovalPhrase(existing);
    } catch (_) {
      return res.status(409).json({ ok: false, code: "CREATOR_USERNAME_REQUIRED_FOR_REMOVAL", error: "Creator username is required before removal" });
    }
    if (input.phrase !== expectedPhrase) {
      return res.status(400).json({ ok: false, code: "CREATOR_DELETE_PHRASE_REQUIRED", error: "Agency removal phrase does not match", expectedPhrase });
    }

    const removedAt = new Date();
    const result = await prisma.$transaction(async (tx) => {
      const retirement = await retireCreatorWithinTransaction({
        tx,
        agencyId: req.auth.agencyId,
        creatorId: existing.id,
        actorUserId: req.auth.userId,
        mode: "SOFT",
        retiredAt: removedAt,
        sourceRequestId: `creator-removal:${existing.id}:${removedAt.getTime()}`,
        revokeReason: "CREATOR_REMOVED_FROM_AGENCY",
        managementActorMember: req.auth.membership,
        managementPermissionKey: "creators.manage",
      });
      await tx.auditLog.create({
        data: {
          agencyId: req.auth.agencyId,
          actorUserId: req.auth.userId,
          action: "creator.removed_from_agency",
          targetType: "creator",
          targetId: existing.id,
          metadata: {
            username: existing.username,
            remoteId: existing.remoteId,
            removedFromMemberAssignments: retirement.removedFromMemberAssignments,
            removedFromInvitationAssignments: retirement.removedFromInvitationAssignments,
            revokedCanonicalSessionCount: retirement.revokedCanonicalSessionCount,
            retiredCanonicalSessionSecretCount: retirement.retiredCanonicalSessionSecretCount,
            revokedCreatorKeyWrapCount: retirement.revokedCreatorKeyWrapCount,
            retiredDedicatedProxyCount: retirement.retiredDedicatedProxyCount,
            historyPreserved: true,
            messageHistoryPreserved: true,
            crmDataPreserved: true,
          },
        },
      });
      return retirement;
    }, { maxWait: 10_000, timeout: 30_000 });

    publishCreatorRetirementControlEvents({
      agencyId: req.auth.agencyId,
      creatorId: existing.id,
      reason: "CREATOR_REMOVED_FROM_AGENCY",
      memberEpochs: result.memberEpochs,
      sourceDeviceId: req.auth?.deviceId || null,
      requestId: req.headers?.["x-request-id"] || null,
    });

    return res.json({
      ok: true,
      creatorId: existing.id,
      removedFromMemberAssignments: result.removedFromMemberAssignments,
      removedFromInvitationAssignments: result.removedFromInvitationAssignments,
      revokedCanonicalSessionCount: result.revokedCanonicalSessionCount,
      retiredCanonicalSessionSecretCount: result.retiredCanonicalSessionSecretCount,
      revokedCreatorKeyWrapCount: result.revokedCreatorKeyWrapCount,
      retiredDedicatedProxyCount: result.retiredDedicatedProxyCount,
      historyPreserved: true,
      alreadyRemoved: result.alreadyRetired === true,
    });
  } catch (err) {
    if (err?.issues) {
      return res.status(400).json({
        ok: false,
        code: "VALIDATION_ERROR",
        error: err.issues[0]?.message || "Validation error",
        issues: err.issues,
      });
    }

    if (!err?.status && !err?.code) console.error("[creators/delete] failed:", err);
    return creatorErrorResponse(res, err, "CREATOR_DELETE_FAILED", "Failed to remove creator from agency");
  }
});

router.post("/:id/begin-connection", creatorManagementRequired, creatorAccessRequired, async (req, res) => {
  try {
    const result = await beginCreatorConnection({
      db: prisma,
      agencyId: req.auth.agencyId,
      creatorId: req.params.id,
      userId: req.auth.userId,
      actorMember: req.auth.membership,
      deviceId: req.auth?.deviceId || null,
    });
    if (!result.unchanged) {
      await audit({
        agencyId: req.auth.agencyId,
        actorUserId: req.auth.userId,
        action: result.mode === "RECONNECT" ? "creator.reconnect_started" : "creator.connection_started",
        targetType: "creator",
        targetId: result.creator.id,
        metadata: { connectionGeneration: result.connectionGeneration, mode: result.mode },
      });
    }
    return res.json({ ok: true, ...result });
  } catch (err) {
    if (!err?.status && !err?.issues && String(err?.code || "") !== "P2002") console.error("[creators/begin-connection] failed:", err);
    return creatorErrorResponse(res, err, "CREATOR_CONNECTION_BEGIN_FAILED", "Failed to begin creator connection");
  }
});

router.post("/:id/complete-connection", creatorManagementRequired, creatorAccessRequired, async (req, res) => {
  try {
    const input = completeConnectionSchema.parse(req.body);
    const result = await completeCreatorConnection({
      db: prisma,
      agencyId: req.auth.agencyId,
      creatorId: req.params.id,
      userId: req.auth.userId,
      actorMember: req.auth.membership,
      connectionGeneration: input.connectionGeneration,
      remoteId: input.remoteId,
      username: input.username,
      platformDisplayName: input.displayName || null,
      avatarUrl: input.avatarUrl || null,
    });

    if (result.connectedNow) {
      await scheduleInitialJobsForCreator({ creatorId: result.creator.id, agencyId: result.creator.agencyId, priority: 50 }).catch((error) => {
        console.warn("[creators/complete-connection] schedule jobs failed:", error?.message || error);
      });
      await audit({
        agencyId: req.auth.agencyId,
        actorUserId: req.auth.userId,
        action: result.creator.remoteId ? "creator.connected" : "creator.connection_completed",
        targetType: "creator",
        targetId: result.creator.id,
        metadata: {
          remoteId: result.creator.remoteId,
          username: result.creator.platformUsername || result.creator.username,
          connectionGeneration: result.creator.connectionGeneration,
          canonicalRevision: result.creator.connectedSessionRevision,
          source: "desktop_runtime",
        },
      });
    }
    return res.json({
      ok: true, creator: result.creator, unchanged: result.unchanged,
      staleNoop: result.staleNoop === true, reason: result.reason || null,
    });
  } catch (err) {
    if (!err?.status && !err?.issues && String(err?.code || "") !== "P2002") console.error("[creators/complete-connection] failed:", err);
    return creatorErrorResponse(res, err, "CREATOR_RUNTIME_COMPLETE_FAILED", "Failed to complete creator connection");
  }
});

router.post("/:id/platform-profile", creatorAccessRequired, async (req, res) => {
  try {
    const input = platformProfileSchema.parse(req.body);
    const sourceDeviceId = requireAuthDevice(req, input.deviceId, {
      requiredCode: "CREATOR_PROFILE_DEVICE_BOUND_TOKEN_REQUIRED",
      mismatchCode: "CREATOR_PROFILE_AUTH_DEVICE_MISMATCH",
    });
    const result = await observeCreatorPlatformProfile({
      db: prisma,
      agencyId: req.auth.agencyId,
      creatorId: req.params.id,
      userId: req.auth.userId,
      sourceDeviceId,
      connectionGeneration: input.connectionGeneration,
      observedAt: input.observedAt,
      remoteId: input.remoteId,
      username: input.username,
      platformDisplayName: input.displayName || null,
      avatarUrl: input.avatarUrl || null,
    });
    return res.json({ ok: true, creator: result.creator, unchanged: result.unchanged });
  } catch (err) {
    if (!err?.status && !err?.issues && String(err?.code || "") !== "P2002") console.error("[creators/platform-profile] failed:", err);
    return creatorErrorResponse(res, err, "CREATOR_PLATFORM_PROFILE_UPDATE_FAILED", "Failed to update creator platform profile");
  }
});

router.post("/:id/avatar", creatorManagementRequired, creatorAccessRequired, upload.single("avatar"), async (req, res) => {
  let committed = false;
  try {
    const existing = await prisma.creatorAccount.findFirst({
      where: { id: req.params.id, agencyId: req.auth.agencyId, deletedAt: null },
    });
    if (!existing) {
      safeUnlink(req.file?.path);
      return res.status(404).json({ ok: false, code: "CREATOR_NOT_FOUND", error: "Creator not found" });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, code: "AVATAR_MISSING", error: "Avatar file is required" });
    }

    const mime = String(req.file.mimetype || "").toLowerCase();
    if (!looksLikeAllowedImage(req.file.path, mime)) {
      safeUnlink(req.file.path);
      return res.status(400).json({ ok: false, code: "AVATAR_INVALID", error: "Avatar file content is not a valid image" });
    }

    const avatarUrl = `${publicBaseUrl(req)}/uploads/${req.file.filename}`;
    const creator = await prisma.$transaction(async (tx) => {
      await lockHumanCreatorMutation({
        tx,
        agencyId: req.auth.agencyId,
        creatorId: req.params.id,
        actorMember: req.auth.membership,
      });
      return tx.creatorAccount.update({
        where: { id: req.params.id },
        data: { avatarUrl },
      });
    }, { maxWait: 10_000, timeout: 30_000 });
    committed = true;
    return res.json({ ok: true, avatarUrl, creator });
  } catch (err) {
    if (!committed) safeUnlink(req.file?.path);
    console.error("[creators/avatar] failed:", err);
    return creatorErrorResponse(res, err, "AVATAR_UPLOAD_FAILED", "Failed to upload avatar");
  }
});

module.exports = router;

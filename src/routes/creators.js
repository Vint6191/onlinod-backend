const express = require("express");
const multer = require("multer");
const path = require("node:path");
const fs = require("node:fs");
const { z } = require("zod");

const prisma = require("../prisma");
const { authRequired } = require("../middleware/auth");
const { creatorManagementRequired } = require("../middleware/creator-management-permissions");
const { allowedCreatorScope, requireCreatorAccess } = require("../middleware/automation-permissions");
const { audit } = require("../services/audit-service");
const { scheduleInitialJobsForCreator } = require("../services/job-scheduler");
const { agencyRemovalPhrase, removeCreatorFromAssignedCreators } = require("../services/creator-agency-removal");

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

const completeRuntimeSchema = z.object({
  remoteId: z.string().min(1).max(120),
  username: creatorUsernameSchema,
  displayName: z.string().trim().min(1).max(120).optional().nullable(),
  avatarUrl: z.string().max(2000).optional().nullable(),
  partition: z.string().min(1).max(220),
});

const agencyRemovalSchema = z.object({
  phrase: z.string().min(1).max(240),
  acknowledgeAgencyRemoval: z.literal(true),
  acknowledgeSessionRevocation: z.literal(true),
});

const telegramContactSchema = z.object({
  telegramContact: z.string().trim().min(1).max(160).regex(/^[^\r\n\t]+$/, "Invalid Telegram contact").nullable(),
});

function normalizeUsername(value) {
  const clean = String(value || "").trim().replace(/^@+/, "");
  return clean ? clean.toLowerCase() : null;
}

function makePartition(creatorId) {
  return `persist:acct_${String(creatorId || "").replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}


function jsonRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}


async function findCreatorConflict({ agencyId, remoteId = null, username = null, excludeId = null }) {
  const or = [];
  if (remoteId) or.push({ remoteId: String(remoteId) });
  if (username) or.push({ username: { equals: normalizeUsername(username), mode: "insensitive" } });
  if (!or.length) return null;
  return prisma.creatorAccount.findFirst({
    where: {
      agencyId,
      deletedAt: null,
      ...(excludeId ? { id: { not: excludeId } } : {}),
      OR: or,
    },
  });
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

    const creator = await prisma.$transaction(async (tx) => {
      const created = await tx.creatorAccount.create({
        data: {
          agencyId: req.auth.agencyId,
          displayName: input.displayName.trim(),
          username,
          remoteId: null,
          partition: null,
          status: "DRAFT",
          notes: input.notes || null,
        },
      });
      if (created.partition) return created;
      return tx.creatorAccount.update({ where: { id: created.id }, data: { partition: makePartition(created.id) } });
    });

    await audit({
      agencyId: req.auth.agencyId,
      actorUserId: req.auth.userId,
      action: "creator.created",
      targetType: "creator",
      targetId: creator.id,
      metadata: { username: creator.username, status: creator.status },
    });

    return res.status(201).json({ ok: true, creator });
  } catch (err) {
    if (err?.issues) {
      return res.status(400).json({
        ok: false,
        code: "VALIDATION_ERROR",
        error: err.issues[0]?.message || "Validation error",
        issues: err.issues,
      });
    }

    console.error("[creators/create] failed:", err);
    return res.status(500).json({ ok: false, code: "CREATOR_CREATE_FAILED", error: "Failed to create creator" });
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
    const existing = await prisma.creatorAccount.findFirst({
      where: {
        id: req.params.id,
        agencyId: req.auth.agencyId,
        deletedAt: null,
      },
      select: { id: true, telegramContact: true },
    });

    if (!existing) {
      return res.status(404).json({ ok: false, code: "CREATOR_NOT_FOUND", error: "Creator not found" });
    }

    const creator = await prisma.creatorAccount.update({
      where: { id: existing.id },
      data: { telegramContact: input.telegramContact },
    });

    await audit({
      agencyId: req.auth.agencyId,
      actorUserId: req.auth.userId,
      action: "creator.telegram_contact.updated",
      targetType: "creator",
      targetId: creator.id,
      metadata: {
        hadContact: Boolean(existing.telegramContact),
        hasContact: Boolean(creator.telegramContact),
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

    console.error("[creators/telegram-contact] failed:", err);
    return res.status(500).json({ ok: false, code: "CREATOR_TELEGRAM_CONTACT_UPDATE_FAILED", error: "Failed to update Telegram contact" });
  }
});

router.patch("/:id", creatorManagementRequired, creatorAccessRequired, async (req, res) => {
  try {
    const input = updateSchema.parse(req.body);

    const existing = await prisma.creatorAccount.findFirst({
      where: {
        id: req.params.id,
        agencyId: req.auth.agencyId,
        deletedAt: null,
      },
    });

    if (!existing) {
      return res.status(404).json({ ok: false, code: "CREATOR_NOT_FOUND", error: "Creator not found" });
    }

    const nextUsername = input.username === undefined ? existing.username : normalizeUsername(input.username);
    const conflict = await findCreatorConflict({ agencyId: req.auth.agencyId, username: nextUsername, excludeId: existing.id });
    if (conflict) {
      return res.status(409).json({ ok: false, code: "CREATOR_ALREADY_EXISTS", error: "This OnlyFans creator is already connected", creatorId: conflict.id });
    }

    const creator = await prisma.creatorAccount.update({
      where: { id: existing.id },
      data: {
        displayName: input.displayName === undefined ? undefined : input.displayName.trim(),
        username: input.username === undefined ? undefined : nextUsername,
        notes: input.notes === undefined ? undefined : input.notes || null,
      },
    });

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
    if (err?.issues) {
      return res.status(400).json({
        ok: false,
        code: "VALIDATION_ERROR",
        error: err.issues[0]?.message || "Validation error",
        issues: err.issues,
      });
    }

    console.error("[creators/update] failed:", err);
    return res.status(500).json({ ok: false, code: "CREATOR_UPDATE_FAILED", error: "Failed to update creator" });
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

    if (existing.deletedAt) {
      return res.json({
        ok: true,
        creatorId: existing.id,
        partition: existing.partition,
        removedFromMemberAssignments: 0,
        historyPreserved: true,
        alreadyRemoved: true,
      });
    }

    const removedAt = new Date();
    const result = await prisma.$transaction(async (tx) => {
      const members = await tx.agencyMember.findMany({
        where: { agencyId: req.auth.agencyId, deletedAt: null },
        select: { id: true, assignedCreators: true },
        take: 10000,
      });
      let removedFromMemberAssignments = 0;
      for (const member of members) {
        const next = removeCreatorFromAssignedCreators(member.assignedCreators, existing.id);
        if (!next.changed) continue;
        await tx.agencyMember.update({ where: { id: member.id }, data: { assignedCreators: next.value } });
        removedFromMemberAssignments += 1;
      }

      const pendingInvitations = await tx.agencyInvitation.findMany({
        where: { agencyId: req.auth.agencyId, claimedAt: null, revokedAt: null },
        select: { id: true, assignedCreators: true },
        take: 10000,
      });
      let removedFromInvitationAssignments = 0;
      for (const invitation of pendingInvitations) {
        const next = removeCreatorFromAssignedCreators(invitation.assignedCreators, existing.id);
        if (!next.changed) continue;
        await tx.agencyInvitation.update({ where: { id: invitation.id }, data: { assignedCreators: next.value } });
        removedFromInvitationAssignments += 1;
      }

      await tx.accessSnapshot.updateMany({ where: { creatorId: existing.id, active: true }, data: { active: false, revokedAt: removedAt } });
      await tx.deviceCreatorBinding.updateMany({ where: { creatorId: existing.id }, data: { status: "REVOKED" } });
      await tx.creatorConnectSession.updateMany({ where: { creatorId: existing.id, status: { in: ["PENDING", "CLAIMED"] } }, data: { status: "CANCELLED", cancelledAt: removedAt } });
      await tx.jobInstance.updateMany({
        where: { creatorId: existing.id, status: { in: ["SCHEDULED", "CLAIMED", "FAILED"] } },
        data: { status: "CANCELLED", completedAt: removedAt, leaseUntil: null, leaseTokenHash: null, claimedAt: null, claimedByDeviceId: null },
      });

      await tx.creatorAccount.update({
        where: { id: existing.id },
        data: { status: "DISABLED", deletedAt: removedAt },
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
            partition: existing.partition,
            removedFromMemberAssignments,
            removedFromInvitationAssignments,
            historyPreserved: true,
            messageHistoryPreserved: true,
            crmDataPreserved: true,
          },
        },
      });
      return { removedFromMemberAssignments, removedFromInvitationAssignments };
    }, { maxWait: 10_000, timeout: 120_000 });

    return res.json({
      ok: true,
      creatorId: existing.id,
      partition: existing.partition,
      removedFromMemberAssignments: result.removedFromMemberAssignments,
      removedFromInvitationAssignments: result.removedFromInvitationAssignments,
      historyPreserved: true,
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

    console.error("[creators/delete] failed:", err);
    return res.status(500).json({ ok: false, code: "CREATOR_DELETE_FAILED", error: "Failed to remove creator from agency" });
  }
});

router.post("/:id/complete-runtime", creatorManagementRequired, creatorAccessRequired, async (req, res) => {
  try {
    const input = completeRuntimeSchema.parse(req.body);
    const existing = await prisma.creatorAccount.findFirst({
      where: { id: req.params.id, agencyId: req.auth.agencyId, deletedAt: null },
    });
    if (!existing) return res.status(404).json({ ok: false, code: "CREATOR_NOT_FOUND", error: "Creator not found" });

    const username = normalizeUsername(input.username);
    const expectedUsername = normalizeUsername(existing.username);
    if (expectedUsername && expectedUsername !== username) {
      return res.status(409).json({
        ok: false,
        code: "CREATOR_IDENTITY_MISMATCH",
        error: "The signed-in OnlyFans account does not match the creator username",
        expectedUsername,
        observedUsername: username,
      });
    }
    if (existing.remoteId && String(existing.remoteId) !== String(input.remoteId)) {
      return res.status(409).json({
        ok: false,
        code: "CREATOR_IDENTITY_MISMATCH",
        error: "The signed-in OnlyFans account does not match the connected creator identity",
      });
    }
    const expectedPartition = existing.partition || makePartition(existing.id);
    if (String(input.partition) !== expectedPartition) {
      return res.status(409).json({
        ok: false,
        code: "CREATOR_PARTITION_MISMATCH",
        error: "The Chromium partition does not match this creator",
      });
    }
    const conflict = await findCreatorConflict({
      agencyId: req.auth.agencyId,
      remoteId: input.remoteId,
      username,
      excludeId: existing.id,
    });
    if (conflict) {
      return res.status(409).json({ ok: false, code: "CREATOR_ALREADY_EXISTS", error: "This OnlyFans creator is already connected", creatorId: conflict.id });
    }

    const nextPartition = expectedPartition;
    const wasAlreadyConnected = existing.status === "READY"
      && String(existing.remoteId || "") === String(input.remoteId)
      && normalizeUsername(existing.username) === username;

    const updated = await prisma.creatorAccount.updateMany({
      where: { id: existing.id, agencyId: req.auth.agencyId, deletedAt: null },
      data: {
        remoteId: input.remoteId,
        username,
        displayName: existing.displayName,
        avatarUrl: input.avatarUrl || existing.avatarUrl,
        partition: nextPartition,
        status: "READY",
      },
    });
    if (updated.count !== 1) {
      return res.status(409).json({ ok: false, code: "CREATOR_CONNECTION_STALE", error: "Creator was removed while the connection was being completed" });
    }
    const creator = await prisma.creatorAccount.findFirst({
      where: { id: existing.id, agencyId: req.auth.agencyId, deletedAt: null },
    });
    if (!creator) {
      return res.status(409).json({ ok: false, code: "CREATOR_CONNECTION_STALE", error: "Creator was removed while the connection was being completed" });
    }

    if (!wasAlreadyConnected) {
      await scheduleInitialJobsForCreator({ creatorId: creator.id, agencyId: creator.agencyId, priority: 50 }).catch((error) => {
        console.warn("[creators/complete-runtime] schedule jobs failed:", error?.message || error);
      });
      await audit({
        agencyId: req.auth.agencyId,
        actorUserId: req.auth.userId,
        action: "creator.connected",
        targetType: "creator",
        targetId: creator.id,
        metadata: { remoteId: creator.remoteId, username: creator.username, source: "desktop_runtime" },
      });
    }

    return res.json({ ok: true, creator, unchanged: wasAlreadyConnected });
  } catch (err) {
    if (err?.issues) return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: err.issues[0]?.message || "Validation error", issues: err.issues });
    console.error("[creators/complete-runtime] failed:", err);
    return res.status(500).json({ ok: false, code: "CREATOR_RUNTIME_COMPLETE_FAILED", error: "Failed to complete creator connection" });
  }
});

router.post("/:id/avatar", creatorManagementRequired, creatorAccessRequired, upload.single("avatar"), async (req, res) => {
  try {
    const existing = await prisma.creatorAccount.findFirst({
      where: {
        id: req.params.id,
        agencyId: req.auth.agencyId,
        deletedAt: null,
      },
    });

    if (!existing) {
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
    const creator = await prisma.creatorAccount.update({
      where: { id: existing.id },
      data: { avatarUrl },
    });

    return res.json({ ok: true, avatarUrl, creator });
  } catch (err) {
    console.error("[creators/avatar] failed:", err);
    return res.status(500).json({ ok: false, code: "AVATAR_UPLOAD_FAILED", error: "Failed to upload avatar" });
  }
});

module.exports = router;

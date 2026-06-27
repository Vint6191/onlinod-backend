const express = require("express");
const multer = require("multer");
const path = require("node:path");
const fs = require("node:fs");
const { z } = require("zod");

const prisma = require("../prisma");
const { authRequired } = require("../middleware/auth");

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

const statusValues = [
  "DRAFT",
  "READY",
  "NOT_CREATOR",
  "AUTH_FAILED",
  "DISABLED",
  "draft",
  "ready",
  "not_creator",
  "auth_failed",
  "disabled",
];

const createSchema = z.object({
  displayName: z.string().min(1).max(120),
  username: z.string().max(120).optional().nullable(),
  remoteId: z.string().max(120).optional().nullable(),
  partition: z.string().max(220).optional().nullable(),
  status: z.enum(statusValues).optional(),
  notes: z.string().max(2000).optional().nullable(),
});

const updateSchema = createSchema.partial();

function normalizeStatus(status) {
  if (!status) return undefined;
  const s = String(status).toUpperCase();
  if (s === "NOT_CREATOR") return "NOT_CREATOR";
  if (s === "AUTH_FAILED") return "AUTH_FAILED";
  if (s === "READY") return "READY";
  if (s === "DISABLED") return "DISABLED";
  return "DRAFT";
}

function publicBaseUrl(req) {
  return (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
}

router.use(authRequired);

router.get("/", async (req, res) => {
  try {
    const creators = await prisma.creatorAccount.findMany({
      where: { agencyId: req.auth.agencyId, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 10000});

    return res.json({ ok: true, creators });
  } catch (err) {
    console.error("[creators/list] failed:", err);
    return res.status(500).json({ ok: false, code: "CREATORS_LIST_FAILED", error: "Failed to list creators" });
  }
});

router.post("/", async (req, res) => {
  try {
    const input = createSchema.parse(req.body);

    const creator = await prisma.creatorAccount.create({
      data: {
        agencyId: req.auth.agencyId,
        displayName: input.displayName,
        username: input.username || null,
        remoteId: input.remoteId || null,
        partition: input.partition || null,
        status: normalizeStatus(input.status) || "DRAFT",
        notes: input.notes || null,
      },
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

router.get("/:id", async (req, res) => {
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

router.patch("/:id", async (req, res) => {
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

    const creator = await prisma.creatorAccount.update({
      where: { id: existing.id },
      data: {
        displayName: input.displayName,
        username: input.username === undefined ? undefined : input.username || null,
        remoteId: input.remoteId === undefined ? undefined : input.remoteId || null,
        partition: input.partition === undefined ? undefined : input.partition || null,
        status: input.status === undefined ? undefined : normalizeStatus(input.status),
        notes: input.notes === undefined ? undefined : input.notes || null,
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

    console.error("[creators/update] failed:", err);
    return res.status(500).json({ ok: false, code: "CREATOR_UPDATE_FAILED", error: "Failed to update creator" });
  }
});

router.delete("/:id", async (req, res) => {
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

    await prisma.creatorAccount.update({
      where: { id: existing.id },
      data: { deletedAt: new Date(), status: "DISABLED" },
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("[creators/delete] failed:", err);
    return res.status(500).json({ ok: false, code: "CREATOR_DELETE_FAILED", error: "Failed to delete creator" });
  }
});

router.post("/:id/avatar", upload.single("avatar"), async (req, res) => {
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

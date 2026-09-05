"use strict";

const express = require("express");
const multer = require("multer");
const path = require("node:path");
const fs = require("node:fs");
const {
  getAccountSettings,
  updateAccountProfile,
  updateAccountAvatar,
  changeAccountPassword,
  requestAccountPasswordReset,
  logoutAccountDevice,
  logoutOtherAccountDevices,
  revokeAccountSession,
  revokeOtherAccountSessions,
  getWorkspaceSettings,
  updateWorkspaceSettings,
  getBillingSettings,
  getTelegramMtprotoSettings,
  updateTelegramCustomReminderSettings,
  addTelegramMtprotoAccount,
  removeTelegramMtprotoAccount,
  issueTelegramMtprotoLocalMaterial,
  storeTelegramMtprotoSession,
} = require("../services/settings-service");
const {
  claimTelegramExecutionRuntimes,
  releaseTelegramExecutionRuntime,
} = require("../services/telegram-execution-runtime");

const { requireProductDevice } = require("../middleware/product-access");

const router = express.Router();
const uploadsDir = path.join(__dirname, "..", "..", "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

const AVATAR_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const AVATAR_EXT = new Map([["image/jpeg", ".jpg"], ["image/png", ".png"], ["image/webp", ".webp"]]);

function safeUnlink(filePath) {
  try { if (filePath) fs.unlinkSync(filePath); } catch (_) {}
}


function localUserAvatarPath(value) {
  const text = String(value || "");
  const match = text.match(/\/uploads\/(user_avatar_[a-zA-Z0-9_.-]+)$/);
  if (!match) return null;
  const full = path.join(uploadsDir, match[1]);
  return path.dirname(full) === uploadsDir ? full : null;
}

function validImageBytes(filePath, mimeType) {
  const header = fs.readFileSync(filePath).subarray(0, 16);
  const hex = header.toString("hex");
  const ascii = header.toString("ascii");
  if (mimeType === "image/jpeg") return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  if (mimeType === "image/png") return hex.startsWith("89504e470d0a1a0a");
  if (mimeType === "image/webp") return ascii.startsWith("RIFF") && header.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => cb(null, `user_avatar_${Date.now()}_${Math.random().toString(36).slice(2, 9)}${AVATAR_EXT.get(String(file.mimetype || "").toLowerCase()) || ".jpg"}`),
  }),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => AVATAR_MIME.has(String(file.mimetype || "").toLowerCase()) ? cb(null, true) : cb(new Error("Only jpg, png or webp images are allowed")),
});

function uploadAccountAvatar(req, res, next) {
  upload.single("avatar")(req, res, (err) => {
    if (!err) return next();
    safeUnlink(req.file?.path);
    const tooLarge = err?.code === "LIMIT_FILE_SIZE";
    return res.status(400).json({
      ok: false,
      code: tooLarge ? "SETTINGS_AVATAR_TOO_LARGE" : "SETTINGS_AVATAR_UPLOAD_INVALID",
      error: tooLarge ? "Avatar must be smaller than 3 MB" : String(err?.message || "Invalid avatar upload"),
    });
  });
}

function publicBaseUrl(req) {
  const explicit = String(process.env.PUBLIC_BASE_URL || process.env.API_PUBLIC_URL || "").trim().replace(/\/$/, "");
  if (explicit) return explicit;
  return `${req.protocol}://${req.get("host")}`;
}

function authDeviceId(req) {
  // Current-device identity is an authorization fact from the signed access
  // token. Never let query/body/header input choose which session survives a
  // password change or "logout other devices" operation. Legacy unbound JWTs
  // safely fall back to null, which means no device is implicitly preserved.
  return String(req.auth?.deviceId || "").trim().slice(0, 160) || null;
}

function sendError(res, err, fallbackCode) {
  const status = Number(err?.status || 0) || (String(err?.code || "").includes("FORBIDDEN") ? 403 : 400);
  if (Number(err?.retryAfterSeconds || 0) > 0) res.setHeader("Retry-After", String(Math.ceil(Number(err.retryAfterSeconds))));
  return res.status(status).json({
    ok: false,
    code: err?.code || fallbackCode,
    error: err?.message || "Request failed",
    ...(Number(err?.retryAfterSeconds || 0) > 0 ? { retryAfterSeconds: Math.ceil(Number(err.retryAfterSeconds)) } : {}),
  });
}

router.get("/account", async (req, res) => {
  try {
    const result = await getAccountSettings({ userId: req.auth.userId, currentDeviceId: authDeviceId(req) });
    if (!result) return res.status(404).json({ ok: false, code: "SETTINGS_USER_NOT_FOUND", error: "User not found" });
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[settings/account] failed:", err);
    return res.status(500).json({ ok: false, code: "SETTINGS_ACCOUNT_FAILED", error: "Failed to load account settings" });
  }
});

router.patch("/account/profile", async (req, res) => {
  try {
    const user = await updateAccountProfile({ agencyId: req.auth.agencyId, userId: req.auth.userId, name: req.body?.name });
    return res.json({ ok: true, user });
  } catch (err) { return sendError(res, err, "SETTINGS_PROFILE_UPDATE_FAILED"); }
});

router.post("/account/avatar", uploadAccountAvatar, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, code: "SETTINGS_AVATAR_MISSING", error: "Avatar file is required" });
    const mime = String(req.file.mimetype || "").toLowerCase();
    if (!validImageBytes(req.file.path, mime)) {
      safeUnlink(req.file.path);
      return res.status(400).json({ ok: false, code: "SETTINGS_AVATAR_INVALID", error: "Avatar file content is not a valid image" });
    }
    const avatarUrl = `${publicBaseUrl(req)}/uploads/${req.file.filename}`;
    const previousPath = localUserAvatarPath(req.auth.user?.avatarUrl);
    const user = await updateAccountAvatar({ agencyId: req.auth.agencyId, userId: req.auth.userId, avatarUrl });
    if (previousPath && previousPath !== req.file.path) safeUnlink(previousPath);
    return res.json({ ok: true, user, avatarUrl });
  } catch (err) {
    safeUnlink(req.file?.path);
    return sendError(res, err, "SETTINGS_AVATAR_UPDATE_FAILED");
  }
});

router.delete("/account/avatar", async (req, res) => {
  try {
    const previousPath = localUserAvatarPath(req.auth.user?.avatarUrl);
    const user = await updateAccountAvatar({ agencyId: req.auth.agencyId, userId: req.auth.userId, avatarUrl: null });
    if (previousPath) safeUnlink(previousPath);
    return res.json({ ok: true, user });
  } catch (err) { return sendError(res, err, "SETTINGS_AVATAR_REMOVE_FAILED"); }
});

router.post("/account/password", async (req, res) => {
  try {
    await changeAccountPassword({ agencyId: req.auth.agencyId, userId: req.auth.userId, currentPassword: req.body?.currentPassword, newPassword: req.body?.newPassword, currentDeviceId: authDeviceId(req) });
    return res.json({ ok: true });
  } catch (err) { return sendError(res, err, "SETTINGS_PASSWORD_CHANGE_FAILED"); }
});

router.post("/account/forgot-password", async (req, res) => {
  try {
    const result = await requestAccountPasswordReset({ userId: req.auth.userId });
    return res.json(result);
  } catch (err) {
    console.error("[settings/forgot-password] failed:", err);
    return res.status(500).json({ ok: false, code: "SETTINGS_PASSWORD_RESET_FAILED", error: "Failed to send reset email" });
  }
});

router.delete("/account/devices/:deviceId", async (req, res) => {
  try {
    const result = await logoutAccountDevice({
      agencyId: req.auth.agencyId,
      userId: req.auth.userId,
      targetDeviceId: req.params.deviceId,
      currentDeviceId: authDeviceId(req),
    });
    return res.json(result);
  } catch (err) { return sendError(res, err, "SETTINGS_DEVICE_LOGOUT_FAILED"); }
});

router.post("/account/devices/logout-others", async (req, res) => {
  try {
    const result = await logoutOtherAccountDevices({
      agencyId: req.auth.agencyId,
      userId: req.auth.userId,
      currentDeviceId: authDeviceId(req),
    });
    return res.json(result);
  } catch (err) { return sendError(res, err, "SETTINGS_OTHER_DEVICES_LOGOUT_FAILED"); }
});

router.delete("/account/sessions/:sessionId", async (req, res) => {
  try {
    const result = await revokeAccountSession({ agencyId: req.auth.agencyId, userId: req.auth.userId, sessionId: req.params.sessionId, currentDeviceId: authDeviceId(req) });
    return res.json(result);
  } catch (err) { return sendError(res, err, "SETTINGS_SESSION_REVOKE_FAILED"); }
});

router.post("/account/sessions/revoke-others", async (req, res) => {
  try {
    const result = await revokeOtherAccountSessions({ agencyId: req.auth.agencyId, userId: req.auth.userId, currentDeviceId: authDeviceId(req) });
    return res.json(result);
  } catch (err) { return sendError(res, err, "SETTINGS_SESSIONS_REVOKE_FAILED"); }
});

router.get("/workspace", async (req, res) => {
  try {
    const result = await getWorkspaceSettings({ agencyId: req.auth.agencyId, member: req.auth.membership });
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[settings/workspace] failed:", err);
    return res.status(500).json({ ok: false, code: "WORKSPACE_SETTINGS_FAILED", error: "Failed to load workspace settings" });
  }
});

router.patch("/workspace", async (req, res) => {
  try {
    const result = await updateWorkspaceSettings({ agencyId: req.auth.agencyId, actorUserId: req.auth.userId, member: req.auth.membership, patch: req.body || {} });
    return res.json({ ok: true, ...result });
  } catch (err) { return sendError(res, err, "WORKSPACE_SETTINGS_UPDATE_FAILED"); }
});

router.get("/billing", async (req, res) => {
  try {
    const billing = await getBillingSettings({ agencyId: req.auth.agencyId, member: req.auth.membership });
    return res.json({ ok: true, billing });
  } catch (err) {
    console.error("[settings/billing] failed:", err);
    return res.status(500).json({ ok: false, code: "SETTINGS_BILLING_FAILED", error: "Failed to load billing" });
  }
});

router.get("/telegram", async (req, res) => {
  try {
    const telegram = await getTelegramMtprotoSettings({ agencyId: req.auth.agencyId, member: req.auth.membership });
    return res.json({ ok: true, telegram });
  } catch (err) { return sendError(res, err, "SETTINGS_TELEGRAM_LOAD_FAILED"); }
});


router.patch("/telegram/reminders", async (req, res) => {
  try {
    const reminders = await updateTelegramCustomReminderSettings({
      agencyId: req.auth.agencyId,
      member: req.auth.membership,
      reminders: req.body?.reminders,
    });
    return res.json({ ok: true, reminders });
  } catch (err) { return sendError(res, err, "SETTINGS_TELEGRAM_REMINDERS_UPDATE_FAILED"); }
});


router.post("/telegram/runtime/claim", async (req, res) => {
  try {
    requireProductDevice(req, req.body?.deviceId);
    return res.json(await claimTelegramExecutionRuntimes({ agencyId: req.auth.agencyId, member: req.auth.membership, deviceId: req.body?.deviceId, accountId: req.body?.accountId, limit: req.body?.limit, db: require("../prisma") }));
  } catch (err) { return sendError(res, err, "SETTINGS_TELEGRAM_RUNTIME_CLAIM_FAILED"); }
});

router.post("/telegram/runtime/:accountId/release", async (req, res) => {
  try {
    requireProductDevice(req, req.body?.deviceId);
    return res.json(await releaseTelegramExecutionRuntime({ agencyId: req.auth.agencyId, member: req.auth.membership, accountId: req.params.accountId, deviceId: req.body?.deviceId, claimToken: req.body?.claimToken, db: require("../prisma") }));
  } catch (err) { return sendError(res, err, "SETTINGS_TELEGRAM_RUNTIME_RELEASE_FAILED"); }
});

router.post("/telegram/accounts", async (req, res) => {
  try {
    requireProductDevice(req, req.body?.deviceId);
    const result = await addTelegramMtprotoAccount({
      agencyId: req.auth.agencyId,
      member: req.auth.membership,
      apiId: req.body?.apiId,
      apiHash: req.body?.apiHash,
    });
    return res.status(201).json({ ok: true, account: result.account });
  } catch (err) { return sendError(res, err, "SETTINGS_TELEGRAM_ADD_FAILED"); }
});

router.delete("/telegram/accounts/:accountId", async (req, res) => {
  try {
    await removeTelegramMtprotoAccount({ agencyId: req.auth.agencyId, member: req.auth.membership, accountId: req.params.accountId });
    return res.json({ ok: true });
  } catch (err) { return sendError(res, err, "SETTINGS_TELEGRAM_REMOVE_FAILED"); }
});

router.post("/telegram/accounts/:accountId/local-material", async (req, res) => {
  try {
    const boundDeviceId = requireProductDevice(req, req.body?.deviceId);
    const material = await issueTelegramMtprotoLocalMaterial({
      agencyId: req.auth.agencyId,
      member: req.auth.membership,
      accountId: req.params.accountId,
      purpose: req.body?.purpose,
      creatorId: req.body?.creatorId,
      submissionId: req.body?.submissionId,
      messageIds: req.body?.messageIds,
      intentId: req.body?.intentId,
      orderId: req.body?.orderId,
      deliveryClaimToken: req.body?.deliveryClaimToken,
      deviceId: boundDeviceId,
      claimToken: req.body?.claimToken,
    });
    res.setHeader("Cache-Control", "no-store, private");
    res.setHeader("Pragma", "no-cache");
    return res.json({ ok: true, material });
  } catch (err) { return sendError(res, err, "SETTINGS_TELEGRAM_LOCAL_MATERIAL_FAILED"); }
});

router.put("/telegram/accounts/:accountId/session", async (req, res) => {
  try {
    requireProductDevice(req, req.body?.deviceId);
    const account = await storeTelegramMtprotoSession({
      agencyId: req.auth.agencyId,
      member: req.auth.membership,
      accountId: req.params.accountId,
      session: req.body?.session,
    });
    res.setHeader("Cache-Control", "no-store, private");
    res.setHeader("Pragma", "no-cache");
    return res.json({ ok: true, account });
  } catch (err) { return sendError(res, err, "SETTINGS_TELEGRAM_SESSION_STORE_FAILED"); }
});

router.get("/runtime", (_req, res) => res.status(410).json({
  ok: false,
  code: "SETTINGS_RUNTIME_DIAGNOSTICS_GONE",
  error: "Customer runtime diagnostics are retired from the settings surface",
}));

module.exports = router;

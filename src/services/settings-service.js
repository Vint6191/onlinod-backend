"use strict";

const bcrypt = require("bcryptjs");
const prisma = require("../prisma");
const { publicUser, issuePasswordReset } = require("./auth-service");
const { audit } = require("./audit-service");
const { canUsePermission, isOwner } = require("./team-access-control");
const { encryptTelegramCredentials, decryptTelegramCredentials } = require("./telegram-mtproto-credentials");
const { SETTINGS_KEY: TELEGRAM_CUSTOM_REMINDERS_KEY, normalizeTelegramCustomReminders, reprojectCustomReminderSchedule } = require("./custom-order-reminders");
const { publicProviderConfig, recentOrders } = require("./billing-nowpayments-service");
const { catalogForClient } = require("./billing-catalog-service");
const { publicEntitlement } = require("./billing-entitlement-service");
const { getWalletState, readRolling30dRevenueBatch, pricingPreviewFromRevenue } = require("./billing-wallet-service");

const WORKSPACE_SETTING_DEFAULTS = Object.freeze({
  timezone: "UTC",
  timeFormat: "24h",
  dateFormat: "DD.MM.YYYY",
  vaultUploadRecipient: "",
});
const TIME_FORMATS = new Set(["12h", "24h"]);
const DATE_FORMATS = new Set(["DD.MM.YYYY", "MM.DD.YYYY", "YYYY-MM-DD"]);

function clean(value, max = 240) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

function isValidTimezone(value) {
  const zone = clean(value, 100);
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date());
    return true;
  } catch (_) {
    return false;
  }
}

function settingsObject(rows) {
  return Object.fromEntries((Array.isArray(rows) ? rows : []).map((row) => [row.key, row.value]));
}

function normalizeWorkspacePreferences(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const timezone = typeof source.timezone === "string" && isValidTimezone(source.timezone)
    ? source.timezone
    : WORKSPACE_SETTING_DEFAULTS.timezone;
  const timeFormat = TIME_FORMATS.has(String(source.timeFormat || ""))
    ? String(source.timeFormat)
    : WORKSPACE_SETTING_DEFAULTS.timeFormat;
  const dateFormat = DATE_FORMATS.has(String(source.dateFormat || ""))
    ? String(source.dateFormat)
    : WORKSPACE_SETTING_DEFAULTS.dateFormat;
  const vaultUploadRecipient = clean(source.vaultUploadRecipient, 100).replace(/^@+/, "");
  return { timezone, timeFormat, dateFormat, vaultUploadRecipient };
}

function sessionPublic(row, currentSessionId) {
  const deviceId = clean(row.deviceId, 160) || null;
  return {
    id: String(row.id),
    deviceId,
    client: clean(row.client, 80) || null,
    userAgent: clean(row.userAgent, 500) || null,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : null,
    expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
    rememberDevice: row.rememberDevice === true,
    isThisDevice: !!currentSessionId && String(row.id) === String(currentSessionId),
  };
}

function dateMs(value) {
  const time = value ? new Date(value).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function newestDate(...values) {
  let best = null;
  let bestMs = 0;
  for (const value of values) {
    const ms = dateMs(value);
    if (ms <= bestMs) continue;
    bestMs = ms;
    best = value;
  }
  return best ? new Date(best).toISOString() : null;
}

function oldestDate(values) {
  let best = null;
  let bestMs = Number.POSITIVE_INFINITY;
  for (const value of values) {
    const ms = dateMs(value);
    if (!ms || ms >= bestMs) continue;
    bestMs = ms;
    best = value;
  }
  return best ? new Date(best).toISOString() : null;
}

function accountDevicesFromSessions({ sessions, workerDevices, currentDeviceId }) {
  const workerById = new Map((Array.isArray(workerDevices) ? workerDevices : []).map((row) => [clean(row.id, 160), row]));
  const groups = new Map();
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const id = clean(session.deviceId, 160);
    if (!id) continue; // Pre-device-binding sessions stay visible in the legacy session list only.
    const rows = groups.get(id) || [];
    rows.push(session);
    groups.set(id, rows);
  }

  const devices = [];
  for (const [id, rows] of groups.entries()) {
    rows.sort((left, right) => dateMs(right.lastUsedAt || right.createdAt) - dateMs(left.lastUsedAt || left.createdAt));
    const latest = rows[0] || {};
    const worker = workerById.get(id) || null;
    const expiresAt = newestDate(...rows.map((row) => row.expiresAt));
    const lastActiveAt = newestDate(worker?.lastSeenAt, ...rows.map((row) => row.lastUsedAt || row.createdAt));
    devices.push({
      deviceId: id,
      deviceName: clean(worker?.deviceName, 160) || null,
      platform: clean(worker?.platform, 80) || null,
      appVersion: clean(worker?.appVersion, 80) || null,
      client: clean(latest.client, 80) || null,
      userAgent: clean(latest.userAgent, 500) || null,
      firstLoginAt: oldestDate(rows.map((row) => row.createdAt)),
      lastActiveAt,
      expiresAt,
      rememberDevice: rows.some((row) => row.rememberDevice === true),
      activeSessionCount: rows.length,
      isThisDevice: !!currentDeviceId && id === currentDeviceId,
    });
  }

  devices.sort((left, right) => {
    if (left.isThisDevice !== right.isThisDevice) return left.isThisDevice ? -1 : 1;
    return dateMs(right.lastActiveAt) - dateMs(left.lastActiveAt);
  });
  return devices;
}

async function getAccountSettings({ userId, currentDeviceId = null, db = null }) {
  const client = db || prisma;
  const now = new Date();
  const [user, sessions, workerDevices] = await Promise.all([
    client.user.findUnique({ where: { id: userId } }),
    client.refreshSession.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: [{ lastUsedAt: "desc" }, { createdAt: "desc" }],
    }),
    client.workerDevice?.findMany
      ? client.workerDevice.findMany({
        where: { userId },
        select: { id: true, deviceName: true, platform: true, appVersion: true, lastSeenAt: true },
        take: 1000,
      })
      : Promise.resolve([]),
  ]);
  if (!user) return null;
  const normalizedDeviceId = clean(currentDeviceId, 160) || null;
  const currentSession = normalizedDeviceId
    ? sessions.find((row) => clean(row.deviceId, 160) === normalizedDeviceId) || null
    : null;
  return {
    user: publicUser(user),
    currentDeviceId: normalizedDeviceId,
    devices: accountDevicesFromSessions({ sessions, workerDevices, currentDeviceId: normalizedDeviceId }),
    // Kept for backward-compatible desktop builds. New UI is device-oriented.
    sessions: sessions.map((row) => sessionPublic(row, currentSession?.id || null)),
  };
}

async function updateAccountProfile({ agencyId, userId, name, db = null }) {
  const client = db || prisma;
  const nextName = clean(name, 80);
  if (!nextName) {
    const err = new Error("Display name is required");
    err.code = "SETTINGS_NAME_REQUIRED";
    throw err;
  }
  const before = await client.user.findUnique({ where: { id: userId }, select: { name: true } });
  const user = await client.user.update({ where: { id: userId }, data: { name: nextName } });
  await audit({ agencyId, actorUserId: userId, action: "settings.account.profile_updated", targetType: "user", targetId: userId, metadata: { beforeName: before?.name || null, afterName: nextName }, db: client });
  return publicUser(user);
}

async function updateAccountAvatar({ agencyId, userId, avatarUrl, db = null }) {
  const client = db || prisma;
  const value = clean(avatarUrl, 2000) || null;
  const user = await client.user.update({ where: { id: userId }, data: { avatarUrl: value } });
  await audit({ agencyId, actorUserId: userId, action: value ? "settings.account.avatar_updated" : "settings.account.avatar_removed", targetType: "user", targetId: userId, metadata: { avatarConfigured: !!value }, db: client });
  return publicUser(user);
}

async function changeAccountPassword({ agencyId, userId, currentPassword, newPassword, currentDeviceId = null, db = null }) {
  const client = db || prisma;
  const current = String(currentPassword || "");
  const next = String(newPassword || "");
  if (next.length < 8 || next.length > 200) {
    const err = new Error("New password must contain between 8 and 200 characters");
    err.code = "SETTINGS_PASSWORD_INVALID";
    throw err;
  }
  const user = await client.user.findUnique({ where: { id: userId } });
  if (!user || !(await bcrypt.compare(current, user.passwordHash))) {
    const err = new Error("Current password is incorrect");
    err.code = "SETTINGS_CURRENT_PASSWORD_INVALID";
    throw err;
  }
  const passwordHash = await bcrypt.hash(next, 12);
  const now = new Date();
  const deviceId = clean(currentDeviceId, 160);
  await client.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { passwordHash } });
    await tx.refreshSession.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(deviceId ? { OR: [{ deviceId: { not: deviceId } }, { deviceId: null }] } : {}),
      },
      data: { revokedAt: now },
    });
  });
  await audit({ agencyId, actorUserId: userId, action: "settings.account.password_changed", targetType: "user", targetId: userId, metadata: { preservedCurrentDevice: !!deviceId } });
  return { ok: true };
}

async function requestAccountPasswordReset({ userId, db = null }) {
  const client = db || prisma;
  const user = await client.user.findUnique({ where: { id: userId } });
  if (!user) return { ok: true, emailSent: false };
  const reset = await issuePasswordReset(user);
  return {
    ok: true,
    emailSent: reset.emailResult?.ok === true && !reset.emailResult?.skipped,
    devResetUrl: reset.emailResult?.skipped ? reset.emailResult?.resetUrl : undefined,
  };
}

async function logoutAccountDevice({ agencyId, userId, targetDeviceId, currentDeviceId = null, db = null }) {
  const client = db || prisma;
  const target = clean(targetDeviceId, 160);
  if (!target) {
    const err = new Error("Device id is required");
    err.code = "SETTINGS_DEVICE_REQUIRED";
    throw err;
  }
  const now = new Date();
  const result = await client.refreshSession.updateMany({
    // Account-level device logout is intentionally not scoped to the current
    // agency. It signs this user's logical device out everywhere without
    // touching another user, WorkerDevice telemetry, creator bindings or any
    // E2E crypto identity/wrap state.
    where: { userId, deviceId: target, revokedAt: null },
    data: { revokedAt: now },
  });
  if (!result.count) {
    const err = new Error("Device has no active account session");
    err.code = "SETTINGS_DEVICE_NOT_ACTIVE";
    err.status = 404;
    throw err;
  }
  const normalizedCurrent = clean(currentDeviceId, 160) || null;
  const currentDeviceLoggedOut = !!normalizedCurrent && target === normalizedCurrent;
  await audit({
    agencyId,
    actorUserId: userId,
    action: "settings.account.device_logged_out",
    targetType: "auth_device",
    targetId: target,
    metadata: { revokedSessionCount: result.count, currentDeviceLoggedOut },
    db: client,
  });
  return { ok: true, deviceId: target, revokedSessionCount: result.count, currentDeviceLoggedOut };
}

async function logoutOtherAccountDevices({ agencyId, userId, currentDeviceId, db = null }) {
  const client = db || prisma;
  const current = clean(currentDeviceId, 160);
  if (!current) {
    const err = new Error("Current device id is required");
    err.code = "SETTINGS_CURRENT_DEVICE_REQUIRED";
    throw err;
  }
  const now = new Date();
  const active = await client.refreshSession.findMany({
    where: { userId, revokedAt: null, OR: [{ deviceId: { not: current } }, { deviceId: null }] },
    select: { deviceId: true },
  });
  const result = await client.refreshSession.updateMany({
    where: { userId, revokedAt: null, OR: [{ deviceId: { not: current } }, { deviceId: null }] },
    data: { revokedAt: now },
  });
  const loggedOutDeviceIds = Array.from(new Set(active.map((row) => clean(row.deviceId, 160)).filter(Boolean))).sort();
  await audit({
    agencyId,
    actorUserId: userId,
    action: "settings.account.other_devices_logged_out",
    targetType: "user",
    targetId: userId,
    metadata: { currentDeviceId: current, revokedSessionCount: result.count, loggedOutDeviceIds },
    db: client,
  });
  return { ok: true, revokedSessionCount: result.count, loggedOutDeviceCount: loggedOutDeviceIds.length };
}

// Backward-compatible session endpoints from Settings V12. If the selected
// refresh session is device-bound, revoke the entire logical device so old
// desktop builds get the same immediate isolation semantics as the new UI.
async function revokeAccountSession({ agencyId, userId, sessionId, currentDeviceId = null, db = null }) {
  const client = db || prisma;
  const session = await client.refreshSession.findFirst({ where: { id: clean(sessionId, 180), userId, revokedAt: null } });
  if (!session) {
    const err = new Error("Session not found");
    err.code = "SETTINGS_SESSION_NOT_FOUND";
    throw err;
  }
  const targetDeviceId = clean(session.deviceId, 160);
  if (targetDeviceId) {
    const result = await logoutAccountDevice({ agencyId, userId, targetDeviceId, currentDeviceId, db: client });
    return { ok: true, currentDeviceRevoked: result.currentDeviceLoggedOut };
  }
  await client.refreshSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
  await audit({ agencyId, actorUserId: userId, action: "settings.account.session_revoked", targetType: "refresh_session", targetId: session.id, metadata: { deviceId: null, client: session.client || null, currentDeviceRevoked: false }, db: client });
  return { ok: true, currentDeviceRevoked: false };
}

async function revokeOtherAccountSessions({ agencyId, userId, currentDeviceId, db = null }) {
  const result = await logoutOtherAccountDevices({ agencyId, userId, currentDeviceId, db });
  return { ok: true, revokedCount: result.revokedSessionCount };
}

async function canManageWorkspaceSettings(member, db = null) {
  return canUsePermission({ member, key: "workspace.manage_settings", db: db || prisma });
}

async function getWorkspaceSettings({ agencyId, member, db = null }) {
  const client = db || prisma;
  const [agency, rows] = await Promise.all([
    client.agency.findUnique({ where: { id: agencyId }, select: { id: true, name: true, plan: true, status: true, trialEndsAt: true, currentPeriodEnd: true } }),
    client.workspaceSetting.findMany({ where: { agencyId, key: { in: ["timezone", "timeFormat", "dateFormat", "vaultUploadRecipient"] } } }),
  ]);
  const raw = settingsObject(rows);
  return {
    agency,
    preferences: normalizeWorkspacePreferences(raw),
    canManage: await canManageWorkspaceSettings(member, client),
  };
}

async function updateWorkspaceSettings({ agencyId, actorUserId, member, patch, db = null }) {
  const client = db || prisma;
  if (!(await canManageWorkspaceSettings(member, client))) {
    const err = new Error("You do not have permission to edit workspace settings");
    err.code = "SETTINGS_WORKSPACE_FORBIDDEN";
    err.status = 403;
    throw err;
  }

  // Validate the complete patch before the first database write so a malformed
  // timezone/date-format can never leave the workspace half-updated.
  const input = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
  const values = {};
  let nextName;
  if (Object.prototype.hasOwnProperty.call(input, "name")) {
    const name = clean(input.name, 120);
    if (!name) {
      const err = new Error("Workspace name is required");
      err.code = "SETTINGS_WORKSPACE_NAME_REQUIRED";
      throw err;
    }
    nextName = name;
  }
  if (Object.prototype.hasOwnProperty.call(input, "timezone")) {
    const timezone = clean(input.timezone, 100);
    if (!isValidTimezone(timezone)) {
      const err = new Error("Timezone must be a valid IANA timezone");
      err.code = "SETTINGS_TIMEZONE_INVALID";
      throw err;
    }
    values.timezone = timezone;
  }
  if (Object.prototype.hasOwnProperty.call(input, "timeFormat")) {
    const value = String(input.timeFormat || "");
    if (!TIME_FORMATS.has(value)) {
      const err = new Error("Unsupported time format");
      err.code = "SETTINGS_TIME_FORMAT_INVALID";
      throw err;
    }
    values.timeFormat = value;
  }
  if (Object.prototype.hasOwnProperty.call(input, "dateFormat")) {
    const value = String(input.dateFormat || "");
    if (!DATE_FORMATS.has(value)) {
      const err = new Error("Unsupported date format");
      err.code = "SETTINGS_DATE_FORMAT_INVALID";
      throw err;
    }
    values.dateFormat = value;
  }
  if (Object.prototype.hasOwnProperty.call(input, "vaultUploadRecipient")) {
    const value = clean(input.vaultUploadRecipient, 100).replace(/^@+/, "");
    if (value && !/^(?:[A-Za-z0-9_]{3,64}|[1-9]\d{0,39})$/.test(value)) {
      const err = new Error("Vault upload recipient must be an OnlyFans username or numeric user ID");
      err.code = "SETTINGS_VAULT_UPLOAD_RECIPIENT_INVALID";
      throw err;
    }
    values.vaultUploadRecipient = value;
  }

  const before = await getWorkspaceSettings({ agencyId, member, db: client });
  const persist = async (tx) => {
    if (nextName !== undefined) {
      await tx.agency.update({ where: { id: agencyId }, data: { name: nextName } });
    }
    for (const [key, value] of Object.entries(values)) {
      await tx.workspaceSetting.upsert({
        where: { agencyId_key: { agencyId, key } },
        create: { agencyId, key, value },
        update: { value },
      });
    }
  };
  if (typeof client.$transaction === "function") await client.$transaction((tx) => persist(tx));
  else await persist(client);

  const after = await getWorkspaceSettings({ agencyId, member, db: client });
  await audit({
    agencyId,
    actorUserId,
    action: "settings.workspace.updated",
    targetType: "agency",
    targetId: agencyId,
    metadata: {
      before: { name: before.agency?.name || null, ...before.preferences },
      after: { name: after.agency?.name || null, ...after.preferences },
    },
    db: client,
  });
  return after;
}

function billingLine(creator, pricing, defaultCorePriceCents = 2000, now = new Date()) {
  const profile = creator?.billingProfile || null;
  const excluded = profile?.billingExcluded === true;
  const preview = pricing || null;
  const core = excluded ? 0 : Math.max(0, Number(preview?.corePriceCents ?? profile?.corePriceCents ?? defaultCorePriceCents ?? 2000));
  const aiEnabled = !excluded && profile?.aiChatterEnabled === true;
  const outreachEnabled = !excluded && profile?.outreachEnabled === true;
  const ai = aiEnabled ? Math.max(0, Number(preview?.aiChatterPriceCents ?? profile?.aiChatterPriceCents ?? 10000)) : 0;
  const outreach = outreachEnabled ? Math.max(0, Number(preview?.outreachPriceCents ?? profile?.outreachPriceCents ?? 2900)) : 0;
  return {
    creatorId: String(creator.id),
    creatorName: creator.displayName || creator.username || String(creator.id),
    creatorUsername: creator.username || null,
    tier: String(preview?.tier || profile?.tier || "STARTER"),
    tierMode: String(profile?.tierMode || "AUTO"),
    pricingSource: preview?.pricingSource || "AUTO_30D",
    pricingAvailable: preview?.available === true,
    pricingErrorCode: preview?.errorCode || null,
    revenue30dCents: preview?.revenue30dCents == null ? null : Number(preview.revenue30dCents),
    revenueCapturedAt: preview?.revenueCapturedAt ? new Date(preview.revenueCapturedAt).toISOString() : null,
    revenueSource: preview?.revenueSource || null,
    corePriceCents: core,
    aiChatterEnabled: aiEnabled,
    aiChatterPriceCents: Math.max(0, Number(profile?.aiChatterPriceCents ?? 10000)),
    outreachEnabled,
    outreachPriceCents: Math.max(0, Number(profile?.outreachPriceCents ?? 2900)),
    billingExcluded: excluded,
    lineTotalCents: core + ai + outreach,
    estimatedNextChargeCents: excluded || preview?.available !== true ? null : Math.max(0, Number(preview.totalCents || 0)),
    entitlement: publicEntitlement(creator?.billingEntitlement || null, now),
  };
}


function canManageTelegram(member) {
  const role = String(member?.role || "").trim().toUpperCase();
  const roleKey = String(member?.roleKey || "").trim().toLowerCase();
  return role === "OWNER" || role === "ADMIN" || roleKey === "owner" || roleKey === "admin";
}

function ensureTelegramManager(member) {
  if (canManageTelegram(member)) return;
  const err = new Error("Only the agency owner or administrator can manage Telegram MTProto credentials");
  err.code = "SETTINGS_TELEGRAM_OWNER_ADMIN_ONLY";
  err.status = 403;
  throw err;
}


function telegramLifecycleState(row) {
  return String(row?.lifecycleState || "ACTIVE") === "RETIRING" ? "RETIRING" : "ACTIVE";
}

function publicTelegramAccount(row, sessionReady = false, now = new Date()) {
  const lifecycleState = telegramLifecycleState(row);
  const drainCompleted = lifecycleState === "RETIRING" && !!row?.retirementDrainCompletedAt;
  const runtimeOwnerLive = lifecycleState === "RETIRING" && !!(row?.runtimeClaimUntil && new Date(row.runtimeClaimUntil).getTime() > new Date(now).getTime());
  return {
    id: String(row.id),
    apiId: Number(row.apiId),
    sessionReady: sessionReady === true,
    lifecycleState,
    retirementRequestedAt: row?.retirementRequestedAt ? new Date(row.retirementRequestedAt).toISOString() : null,
    drainRequired: lifecycleState === "RETIRING" && !drainCompleted,
    drainCompleted,
    forceRetireAvailable: lifecycleState === "RETIRING" && !drainCompleted && !runtimeOwnerLive,
  };
}

async function assertTelegramAccountNoBusinessBlockers({ agencyId, accountId, db }) {
  const id = String(accountId);
  const activeIntent = db.telegramDeliveryIntent?.findFirst ? await db.telegramDeliveryIntent.findFirst({
    where: { agencyId, accountId: id, state: { in: ["PLANNED", "CLAIMED", "COMMITTING", "RECONCILE_REQUIRED", "FAILED_PRECOMMIT"] } },
    select: { id: true, kind: true, state: true },
  }) : null;
  if (activeIntent) throw Object.assign(new Error("Telegram connection is still required by an active or unresolved Custom delivery"), { code: "SETTINGS_TELEGRAM_ACCOUNT_IN_USE", status: 409 });

  if (db.telegramDeliveryIntent?.findMany && db.customOrder?.findFirst) {
    const taskRows = await db.telegramDeliveryIntent.findMany({ where: { agencyId, accountId: id, kind: "TASK", state: "CONFIRMED" }, select: { customOrderId: true }, take: 1000 });
    const orderIds = Array.from(new Set((taskRows || []).map((row) => String(row.customOrderId || "")).filter(Boolean)));
    if (orderIds.length) {
      const pendingOrder = await db.customOrder.findFirst({ where: { agencyId, id: { in: orderIds }, status: "PENDING" }, select: { id: true } });
      if (pendingOrder) throw Object.assign(new Error("Telegram connection is still the canonical thread for a pending Custom order"), { code: "SETTINGS_TELEGRAM_ACCOUNT_IN_USE", status: 409 });
    }
  }

  if (db.customContentSubmission?.findMany) {
    const sourceRows = await db.customContentSubmission.findMany({ where: { agencyId, telegramSourceAccountId: id }, select: { id: true, telegramMessageIds: true, ofMediaIds: true } });
    const pendingSource = (sourceRows || []).find((row) => {
      const sourceCount = Array.isArray(row.telegramMessageIds) ? row.telegramMessageIds.length : 0;
      const mediaCount = Array.isArray(row.ofMediaIds) ? row.ofMediaIds.length : 0;
      return sourceCount > mediaCount;
    });
    if (pendingSource) throw Object.assign(new Error("Telegram connection is still required by pending Custom source media"), { code: "SETTINGS_TELEGRAM_ACCOUNT_IN_USE", status: 409 });
  } else if (db.customContentSubmission?.findFirst) {
    const pendingSource = await db.customContentSubmission.findFirst({ where: { agencyId, telegramSourceAccountId: id, reviewStatus: { in: ["WAITING_REVIEW", "REVISION_REQUESTED"] } }, select: { id: true } });
    if (pendingSource) throw Object.assign(new Error("Telegram connection is still required by pending Custom source media"), { code: "SETTINGS_TELEGRAM_ACCOUNT_IN_USE", status: 409 });
  }

  if (db.telegramInboundEvent?.findFirst) {
    const unresolvedInbound = await db.telegramInboundEvent.findFirst({
      where: { agencyId, accountId: id, submissionId: null, projectionState: { in: ["PENDING", "FAILED_RETRYABLE", "REVIEW_REQUIRED"] } },
      select: { id: true, projectionState: true },
    });
    if (unresolvedInbound) throw Object.assign(new Error("Telegram connection is still required by an unresolved inbound provider source"), { code: "SETTINGS_TELEGRAM_ACCOUNT_IN_USE", status: 409 });
  }
}

async function getTelegramMtprotoSettings({ agencyId, member, db = null }) {
  if (!canManageTelegram(member)) return { available: false, reason: "OWNER_OR_ADMIN_ONLY", accounts: [], reminders: normalizeTelegramCustomReminders(null) };
  const client = db || prisma;
  const [rows, reminderRow] = await Promise.all([
    client.agencyTelegramMtprotoAccount.findMany({
      where: { agencyId },
      select: { id: true, apiId: true, encryptedPayload: true, iv: true, tag: true, algorithm: true, payloadVersion: true, lifecycleState: true, retirementRequestedAt: true, retirementDrainCompletedAt: true, runtimeClaimedByDeviceId: true, runtimeClaimUntil: true },
      orderBy: { id: "asc" },
    }),
    client.workspaceSetting.findUnique({ where: { agencyId_key: { agencyId, key: TELEGRAM_CUSTOM_REMINDERS_KEY } } }).catch(() => null),
  ]);
  const accounts = rows.map((row) => {
    let sessionReady = false;
    try { sessionReady = Boolean(String(decryptTelegramCredentials(row).session || "").trim()); } catch (_) {}
    return publicTelegramAccount(row, sessionReady);
  });
  return { available: true, accounts, reminders: normalizeTelegramCustomReminders(reminderRow?.value) };
}

async function updateTelegramCustomReminderSettings({ agencyId, member, reminders, db = null }) {
  ensureTelegramManager(member);
  const client = db || prisma;
  const normalized = normalizeTelegramCustomReminders(reminders);

  // Workspace policy publication and the order projections that make it executable are one
  // transaction. If the process crashes, neither a half-published policy nor half-reprojected
  // schedule set is committed. Concurrent provider settlement loses/retries on CustomOrder CAS.
  const apply = async (tx) => {
    await tx.workspaceSetting.upsert({
      where: { agencyId_key: { agencyId, key: TELEGRAM_CUSTOM_REMINDERS_KEY } },
      create: { agencyId, key: TELEGRAM_CUSTOM_REMINDERS_KEY, value: normalized },
      update: { value: normalized },
    });
    if (tx.customOrder?.findMany && tx.customOrder?.updateMany) {
      const pendingOrders = await tx.customOrder.findMany({
        where: { agencyId, status: "PENDING" },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      const projectionNow = new Date();
      for (const order of pendingOrders) {
        await reprojectCustomReminderSchedule({ agencyId, orderId: order.id, now: projectionNow, firstAnchorAt: projectionNow, db: tx });
      }
    }
    await audit({
      agencyId,
      actorUserId: member?.userId || null,
      action: "settings.telegram.custom_reminders_updated",
      targetType: "agency",
      targetId: agencyId,
      metadata: { contentEnabled: normalized.content.enabled, callEnabled: normalized.call.enabled, physicalEnabled: normalized.physical.enabled },
      db: tx,
    });
    return normalized;
  };
  return typeof client.$transaction === "function" ? client.$transaction(apply) : apply(client);
}

function telegramInputError(message, code) {
  const err = new Error(message);
  err.code = code;
  err.status = 400;
  return err;
}

async function addTelegramMtprotoAccount({ agencyId, member, apiId, apiHash, session, db = null }) {
  ensureTelegramManager(member);
  const numericApiId = Number(apiId);
  if (!Number.isSafeInteger(numericApiId) || numericApiId <= 0 || numericApiId > 2147483647) {
    throw telegramInputError("API ID must be a positive integer", "SETTINGS_TELEGRAM_API_ID_INVALID");
  }
  const cleanApiHash = String(apiHash || "").trim();
  if (!/^[a-fA-F0-9]{32}$/.test(cleanApiHash)) {
    throw telegramInputError("API hash must contain 32 hexadecimal characters", "SETTINGS_TELEGRAM_API_HASH_INVALID");
  }
  const cleanSession = String(session || "").trim();
  if (cleanSession.length > 262144) {
    throw telegramInputError("MTProto session must be smaller than 256 KB", "SETTINGS_TELEGRAM_SESSION_INVALID");
  }
  const client = db || prisma;
  let encrypted;
  try {
    encrypted = encryptTelegramCredentials({ apiHash: cleanApiHash, session: cleanSession });
  } catch (_) {
    const err = new Error("Secure Telegram credential storage is unavailable");
    err.code = "SETTINGS_TELEGRAM_STORAGE_UNAVAILABLE";
    err.status = 503;
    throw err;
  }
  const account = await client.agencyTelegramMtprotoAccount.create({
    data: {
      agencyId,
      apiId: numericApiId,
      encryptedPayload: encrypted.encryptedPayload,
      iv: encrypted.iv,
      tag: encrypted.tag,
      algorithm: encrypted.algorithm,
      payloadVersion: encrypted.payloadVersion,
    },
    select: { id: true, apiId: true },
  });
  return { available: true, account: publicTelegramAccount({ ...account, lifecycleState: "ACTIVE", retirementRequestedAt: null, retirementDrainCompletedAt: null }, Boolean(cleanSession)) };
}

async function removeTelegramMtprotoAccount({ agencyId, member, accountId, db = null, now = new Date() }) {
  ensureTelegramManager(member);
  const id = String(accountId || "").trim();
  if (!id || id.length > 180) throw telegramInputError("Telegram connection id is required", "SETTINGS_TELEGRAM_ACCOUNT_INVALID");
  const client = db || prisma;
  if (typeof client?.$transaction !== "function") {
    throw Object.assign(new Error("Telegram connection retirement requires transactional storage"), { code: "SETTINGS_TELEGRAM_ACCOUNT_RETIRE_TRANSACTION_REQUIRED", status: 503 });
  }
  const existing = await client.agencyTelegramMtprotoAccount.findFirst({
    where: { id, agencyId },
    select: { id: true, apiId: true, lifecycleState: true, retirementRequestedAt: true, retirementDrainCompletedAt: true, runtimeClaimedByDeviceId: true, runtimeClaimUntil: true, runtimeClaimGeneration: true, runtimeDrainedGeneration: true },
  });
  if (!existing) {
    const err = new Error("Telegram connection not found"); err.code = "SETTINGS_TELEGRAM_ACCOUNT_NOT_FOUND"; err.status = 404; throw err;
  }

  // ACTIVE -> RETIRING is serialized with new TelegramDeliveryIntent reservation on the
  // same account row. The first no-op ACTIVE update acquires the row lock *before* the
  // blocker scan. Therefore a racing planner either commits first and is observed here,
  // or this transaction commits RETIRING first and the planner's ACTIVE fence fails.
  if (String(existing.lifecycleState || "ACTIVE") === "ACTIVE") {
    const beginRetirement = async (tx) => {
      if (!tx.agencyTelegramMtprotoAccount?.updateMany) {
        throw Object.assign(new Error("Telegram connection retirement fencing is unavailable"), { code: "SETTINGS_TELEGRAM_ACCOUNT_RETIRE_FENCE_UNAVAILABLE", status: 503 });
      }
      const locked = await tx.agencyTelegramMtprotoAccount.updateMany({
        where: { id, agencyId, OR: [{ lifecycleState: "ACTIVE" }, { lifecycleState: null }] },
        data: { lifecycleState: "ACTIVE" },
      });
      if (Number(locked?.count || 0) !== 1) {
        const raced = await tx.agencyTelegramMtprotoAccount.findFirst({ where: { id, agencyId }, select: { lifecycleState: true } });
        if (String(raced?.lifecycleState || "") === "RETIRING") return { alreadyRetiring: true };
        throw Object.assign(new Error("Telegram connection retirement changed concurrently; retry"), { code: "SETTINGS_TELEGRAM_ACCOUNT_RETIRE_RACE", status: 409 });
      }

      // Must run after the account-row lock. A planner that won first has already created
      // its durable intent by the time this query can proceed.
      await assertTelegramAccountNoBusinessBlockers({ agencyId, accountId: id, db: tx });
      const current = await tx.agencyTelegramMtprotoAccount.findFirst({
        where: { id, agencyId },
        select: { runtimeClaimedByDeviceId: true, runtimeClaimGeneration: true, runtimeDrainedGeneration: true },
      });
      const claimGeneration = Math.max(0, Number(current?.runtimeClaimGeneration) || 0);
      const drainedGeneration = Math.max(0, Number(current?.runtimeDrainedGeneration) || 0);
      const latestRuntimeIsDurablyDrained = !current?.runtimeClaimedByDeviceId && claimGeneration === drainedGeneration;
      const changed = await tx.agencyTelegramMtprotoAccount.updateMany({
        where: { id, agencyId, lifecycleState: "ACTIVE", runtimeClaimGeneration: claimGeneration, runtimeDrainedGeneration: drainedGeneration },
        data: {
          lifecycleState: "RETIRING",
          retirementRequestedAt: now,
          // Only a drained release of the latest runtime generation proves the Desktop SQLite
          // outbox is empty. Merely having no live TTL/current owner is not such a proof.
          retirementDrainCompletedAt: latestRuntimeIsDurablyDrained ? now : null,
        },
      });
      if (Number(changed?.count || 0) !== 1) throw Object.assign(new Error("Telegram connection retirement changed concurrently; retry"), { code: "SETTINGS_TELEGRAM_ACCOUNT_RETIRE_RACE", status: 409 });
      return { alreadyRetiring: false };
    };
    await client.$transaction((tx) => beginRetirement(tx), { isolationLevel: "Serializable" });
  }

  const retire = async (tx) => {
    const current = await tx.agencyTelegramMtprotoAccount.findFirst({
      where: { id, agencyId },
      select: { id: true, apiId: true, lifecycleState: true, retirementRequestedAt: true, retirementDrainCompletedAt: true, runtimeClaimedByDeviceId: true, runtimeClaimUntil: true, runtimeClaimGeneration: true, runtimeDrainedGeneration: true },
    });
    if (!current) return { ok: true, retired: true, lifecycleState: "RETIRED", drainRequired: false, drainCompleted: true, retirementRequestedAt: null };
    if (String(current.lifecycleState || "") !== "RETIRING") throw Object.assign(new Error("Telegram connection is not in retirement state"), { code: "SETTINGS_TELEGRAM_ACCOUNT_RETIRE_STATE_INVALID", status: 409 });
    await assertTelegramAccountNoBusinessBlockers({ agencyId, accountId: id, db: tx });
    const drainCompleted = !!current.retirementDrainCompletedAt;
    const liveLease = !!current.runtimeClaimedByDeviceId || !!(current.runtimeClaimUntil && new Date(current.runtimeClaimUntil).getTime() > now.getTime());
    if (!drainCompleted || liveLease) {
      return {
        ok: true,
        retired: false,
        lifecycleState: "RETIRING",
        drainRequired: !drainCompleted,
        drainCompleted,
        retirementRequestedAt: current.retirementRequestedAt ? new Date(current.retirementRequestedAt).toISOString() : null,
      };
    }
    await tx.creatorAccount.updateMany({ where: { agencyId, telegramAccountId: id }, data: { telegramAccountId: null } });
    await tx.agencyTelegramMtprotoAccount.delete({ where: { id } });
    return { ok: true, retired: true, lifecycleState: "RETIRED", drainRequired: false, drainCompleted: true, retirementRequestedAt: current.retirementRequestedAt ? new Date(current.retirementRequestedAt).toISOString() : null };
  };
  return client.$transaction((tx) => retire(tx), { isolationLevel: "Serializable" });
}

async function forceRetireLostTelegramMtprotoAccount({ agencyId, member, accountId, reason, acknowledgeLostObservations = false, db = null, now = new Date() }) {
  ensureTelegramManager(member);
  const id = clean(accountId, 180);
  const why = clean(reason, 1000);
  if (!id) throw telegramInputError("Telegram connection id is required", "SETTINGS_TELEGRAM_ACCOUNT_INVALID");
  if (acknowledgeLostObservations !== true) throw Object.assign(new Error("Explicit acknowledgement of possible lost local Telegram observations is required"), { code: "SETTINGS_TELEGRAM_FORCE_RETIRE_ACK_REQUIRED", status: 400 });
  if (!why) throw Object.assign(new Error("A reason is required to force-retire a lost Telegram runtime"), { code: "SETTINGS_TELEGRAM_FORCE_RETIRE_REASON_REQUIRED", status: 400 });
  const client = db || prisma;
  if (typeof client?.$transaction !== "function") throw Object.assign(new Error("Force retirement requires transactional storage"), { code: "SETTINGS_TELEGRAM_FORCE_RETIRE_TRANSACTION_REQUIRED", status: 503 });
  return client.$transaction(async (tx) => {
    if (!tx.agencyTelegramMtprotoAccount?.updateMany) throw Object.assign(new Error("Telegram retirement fencing is unavailable"), { code: "SETTINGS_TELEGRAM_FORCE_RETIRE_FENCE_UNAVAILABLE", status: 503 });
    const locked = await tx.agencyTelegramMtprotoAccount.updateMany({ where: { id, agencyId, lifecycleState: "RETIRING" }, data: { lifecycleState: "RETIRING" } });
    if (Number(locked?.count || 0) !== 1) {
      const row = await tx.agencyTelegramMtprotoAccount.findFirst({ where: { id, agencyId }, select: { id: true, lifecycleState: true } });
      if (!row) throw Object.assign(new Error("Telegram connection not found"), { code: "SETTINGS_TELEGRAM_ACCOUNT_NOT_FOUND", status: 404 });
      throw Object.assign(new Error("Force retirement is only available after normal retirement has entered RETIRING"), { code: "SETTINGS_TELEGRAM_FORCE_RETIRE_STATE_INVALID", status: 409 });
    }
    const runtime = await tx.agencyTelegramMtprotoAccount.findFirst({
      where: { id, agencyId },
      select: { retirementDrainCompletedAt: true, runtimeClaimedByDeviceId: true, runtimeClaimUntil: true },
    });
    if (runtime?.retirementDrainCompletedAt) {
      throw Object.assign(new Error("Telegram runtime is already durably drained; finish normal removal instead"), { code: "SETTINGS_TELEGRAM_FORCE_RETIRE_NOT_REQUIRED", status: 409 });
    }
    if (runtime?.runtimeClaimUntil && new Date(runtime.runtimeClaimUntil).getTime() > new Date(now).getTime()) {
      throw Object.assign(new Error("The owning Telegram Desktop runtime is still live; wait for normal drain or lease expiry before force retirement"), { code: "SETTINGS_TELEGRAM_FORCE_RETIRE_RUNTIME_LIVE", status: 409 });
    }
    await assertTelegramAccountNoBusinessBlockers({ agencyId, accountId: id, db: tx });
    await audit({
      agencyId,
      actorUserId: member?.userId || null,
      action: "settings.telegram.account_force_retired_lost_runtime",
      targetType: "telegram_mtproto_account",
      targetId: id,
      metadata: { reason: why, acknowledgedPossibleLostLocalObservations: true },
      db: tx,
      required: true,
    });
    await tx.creatorAccount.updateMany({ where: { agencyId, telegramAccountId: id }, data: { telegramAccountId: null } });
    await tx.agencyTelegramMtprotoAccount.delete({ where: { id } });
    return { ok: true, retired: true, forced: true, lifecycleState: "RETIRED", drainRequired: false, drainCompleted: false, retirementRequestedAt: null };
  }, { isolationLevel: "Serializable" });
}

async function readTelegramMtprotoAccountSecret({ agencyId, accountId, db = null, requireActive = false }) {
  const id = clean(accountId, 180);
  if (!id) throw telegramInputError("Telegram connection id is required", "SETTINGS_TELEGRAM_ACCOUNT_INVALID");
  const client = db || prisma;
  const row = await client.agencyTelegramMtprotoAccount.findFirst({
    where: { id, agencyId },
    select: { id: true, apiId: true, encryptedPayload: true, iv: true, tag: true, algorithm: true, payloadVersion: true, lifecycleState: true, retirementRequestedAt: true, retirementDrainCompletedAt: true, runtimeClaimedByDeviceId: true, runtimeClaimUntil: true },
  });
  if (!row) {
    const err = new Error("Telegram connection not found");
    err.code = "SETTINGS_TELEGRAM_ACCOUNT_NOT_FOUND";
    err.status = 404;
    throw err;
  }
  if (requireActive && telegramLifecycleState(row) !== "ACTIVE") {
    const err = new Error("Telegram connection is retiring and cannot start or complete authorization");
    err.code = "SETTINGS_TELEGRAM_ACCOUNT_RETIRING";
    err.status = 409;
    throw err;
  }
  let credentials;
  try { credentials = decryptTelegramCredentials(row); }
  catch (_) {
    const err = new Error("Stored Telegram credentials cannot be decrypted");
    err.code = "SETTINGS_TELEGRAM_STORAGE_UNAVAILABLE";
    err.status = 503;
    throw err;
  }
  return { row, apiHash: String(credentials.apiHash || ""), session: String(credentials.session || "") };
}

async function issueTelegramMtprotoLocalMaterial({ agencyId, member, accountId, purpose, creatorId = null, submissionId = null, messageIds = null, intentId = null, orderId = null, deliveryClaimToken = null, deviceId = null, claimToken = null, db = null }) {
  const normalizedPurpose = clean(purpose, 40).toLowerCase();
  if (!new Set(["authorize", "messaging", "customs-source-read", "customs-delivery-write", "customs-delivery-read"]).has(normalizedPurpose)) {
    throw telegramInputError("Telegram local-material purpose is invalid", "SETTINGS_TELEGRAM_LOCAL_PURPOSE_INVALID");
  }
  const client = db || prisma;
  let customsSource = null;
  let customsDelivery = null;
  if (normalizedPurpose === "authorize") ensureTelegramManager(member);
  else {
    const { assertTelegramMessagingAccess, assertTelegramRuntimeLease } = require("./telegram-execution-runtime");
    if (normalizedPurpose === "messaging") {
      await assertTelegramMessagingAccess({ agencyId, member, accountId, creatorId, db: client });
    } else if (normalizedPurpose === "customs-source-read") {
      const { assertCustomSubmissionTelegramSourceAccess } = require("./custom-content-submissions-service");
      customsSource = await assertCustomSubmissionTelegramSourceAccess({ agencyId, member, submissionId, creatorId, accountId, messageIds, db: client });
    } else {
      const { assertTelegramDeliveryMaterialAccess, getTelegramOrderContext } = require("./telegram-delivery-authority-service");
      if (normalizedPurpose === "customs-delivery-write") {
        customsDelivery = await assertTelegramDeliveryMaterialAccess({ agencyId, member, intentId, creatorId, accountId, deviceId, deliveryClaimToken, db: client });
      } else {
        const context = await getTelegramOrderContext({ agencyId, member, orderId, db: client });
        const requested = Array.from(new Set((Array.isArray(messageIds) ? messageIds : []).map((value) => clean(value, 40)).filter(Boolean)));
        const allowed = new Set(context.telegramReferenceMessageIds.map(String));
        if (!requested.length || requested.some((id) => !allowed.has(id))) throw telegramInputError("Requested Telegram history messages are outside this Custom order", "CUSTOM_ORDER_TELEGRAM_HISTORY_MESSAGE_MISMATCH");
        if (String(context.creatorId) !== clean(creatorId, 180) || String(context.accountId) !== clean(accountId, 180)) throw telegramInputError("Custom Telegram history scope does not match the order", "CUSTOM_ORDER_TELEGRAM_HISTORY_SCOPE_MISMATCH");
        customsDelivery = { recipientTelegramUserId: context.telegramUserId };
      }
    }
    await assertTelegramRuntimeLease({ agencyId, member, accountId, deviceId, claimToken, db: client });
  }
  const secret = await readTelegramMtprotoAccountSecret({ agencyId, accountId, db: client, requireActive: normalizedPurpose === "authorize" });
  if (!/^[a-fA-F0-9]{32}$/.test(secret.apiHash)) {
    const err = new Error("Stored Telegram API hash is invalid");
    err.code = "SETTINGS_TELEGRAM_API_HASH_INVALID";
    err.status = 409;
    throw err;
  }
  if (normalizedPurpose !== "authorize" && !secret.session.trim()) {
    const err = new Error("Telegram account has not been authorized yet");
    err.code = "SETTINGS_TELEGRAM_SESSION_REQUIRED";
    err.status = 409;
    throw err;
  }
  return {
    accountId: secret.row.id,
    apiId: secret.row.apiId,
    apiHash: secret.apiHash,
    session: normalizedPurpose === "authorize" ? "" : secret.session,
    ...(normalizedPurpose === "customs-source-read" ? { sourceTelegramUserId: String(customsSource?.telegramSourceUserId || "") } : {}),
    ...(normalizedPurpose === "customs-delivery-write" || normalizedPurpose === "customs-delivery-read" ? { deliveryTelegramUserId: String(customsDelivery?.recipientTelegramUserId || "") } : {}),
  };
}

async function storeTelegramMtprotoSession({ agencyId, member, accountId, session, db = null }) {
  ensureTelegramManager(member);
  const cleanSession = String(session || "").trim();
  if (!cleanSession || cleanSession.length > 262144) throw telegramInputError("MTProto session must be non-empty and smaller than 256 KB", "SETTINGS_TELEGRAM_SESSION_INVALID");
  const client = db || prisma;
  if (typeof client?.$transaction !== "function") throw Object.assign(new Error("Telegram session handoff requires transactional storage"), { code: "SETTINGS_TELEGRAM_SESSION_TRANSACTION_REQUIRED", status: 503 });
  return client.$transaction(async (tx) => {
    const secret = await readTelegramMtprotoAccountSecret({ agencyId, accountId, db: tx, requireActive: true });
    let encrypted;
    try { encrypted = encryptTelegramCredentials({ apiHash: secret.apiHash, session: cleanSession }); }
    catch (_) { const err = new Error("Secure Telegram credential storage is unavailable"); err.code = "SETTINGS_TELEGRAM_STORAGE_UNAVAILABLE"; err.status = 503; throw err; }
    const changed = await tx.agencyTelegramMtprotoAccount.updateMany({
      where: { id: secret.row.id, agencyId, lifecycleState: "ACTIVE" },
      data: { encryptedPayload: encrypted.encryptedPayload, iv: encrypted.iv, tag: encrypted.tag, algorithm: encrypted.algorithm, payloadVersion: encrypted.payloadVersion },
    });
    if (Number(changed?.count || 0) !== 1) throw Object.assign(new Error("Telegram connection entered retirement before the session handoff committed"), { code: "SETTINGS_TELEGRAM_ACCOUNT_RETIRING", status: 409 });
    return publicTelegramAccount({ ...secret.row, lifecycleState: "ACTIVE" }, true);
  }, { isolationLevel: "Serializable" });
}


async function getBillingSettings({ agencyId, member, db = null }) {
  const client = db || prisma;
  if (!isOwner(member)) return { available: false, reason: "OWNER_ONLY" };
  const now = new Date();
  const providerBase = publicProviderConfig();
  const [agency, subscription, creators, orders, walletState] = await Promise.all([
    client.agency.findUnique({ where: { id: agencyId }, select: { id: true, name: true, plan: true, status: true, trialEndsAt: true, currentPeriodEnd: true } }),
    client.agencySubscription.findFirst({ where: { agencyId }, orderBy: { createdAt: "desc" } }),
    client.creatorAccount.findMany({
      where: { agencyId, deletedAt: null },
      include: { billingProfile: true, billingEntitlement: true },
      orderBy: { createdAt: "asc" },
    }),
    recentOrders({ agencyId, limit: 20, db: client }),
    getWalletState({ agencyId, testMode: providerBase.testMode === true, db: client, limit: 40 }),
  ]);
  const creatorIds = creators.map((creator) => creator.id);
  const revenueByCreator = await readRolling30dRevenueBatch({ db: client, creatorIds, now });
  const defaultCorePriceCents = Math.max(0, Number(subscription?.corePricePerCreatorCents ?? 2000));
  const rows = creators.map((creator) => {
    const pricing = pricingPreviewFromRevenue({ profile: creator.billingProfile, revenue: revenueByCreator.get(String(creator.id)) || null });
    return billingLine(creator, pricing, defaultCorePriceCents, now);
  });
  const monthlyTotalCents = rows.reduce((sum, row) => sum + row.lineTotalCents, 0);
  const activeRows = rows.filter((row) => row.entitlement.coreActive);
  const autoRenewRows = rows.filter((row) => row.entitlement.autoRenewEnabled && !row.billingExcluded);
  const thirtyDayHorizon = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const upcomingAutoRenewRows = autoRenewRows.filter((row) => {
    const renewalAt = row.entitlement.nextRenewalAt || row.entitlement.coreValidUntil;
    if (!renewalAt) return false;
    const date = new Date(renewalAt);
    return Number.isFinite(date.getTime()) && date <= thirtyDayHorizon;
  });
  const estimatedNext30DaysCents = upcomingAutoRenewRows.reduce((sum, row) => sum + Number(row.estimatedNextChargeCents || 0), 0);
  const pricingDataUnavailableCreators = upcomingAutoRenewRows.filter((row) => row.estimatedNextChargeCents == null).length;
  const maxEntitlementEnd = activeRows
    .map((row) => row.entitlement.coreValidUntil ? new Date(row.entitlement.coreValidUntil) : null)
    .filter((value) => value && Number.isFinite(value.getTime()))
    .sort((a, b) => b.getTime() - a.getTime())[0] || null;
  const billingMode = String(subscription?.billingMode || "MANUAL");
  const rawStatus = String(subscription?.status || agency?.status || "TRIAL");
  const effectiveStatus = billingMode !== "FREE_INTERNAL" && rawStatus === "ACTIVE" && activeRows.length === 0
    ? "PAST_DUE"
    : activeRows.length > 0 ? "ACTIVE" : rawStatus;
  const liveCheckoutBlockedByInternalTestMode = billingMode === "FREE_INTERNAL" && providerBase.environment === "live";

  return {
    available: true,
    agency,
    subscription: subscription ? {
      id: subscription.id,
      status: subscription.status,
      effectiveStatus,
      billingMode,
      billingPeriod: "MONTHLY",
      corePricePerCreatorCents: subscription.corePricePerCreatorCents,
      trialEndsAt: subscription.trialEndsAt,
      graceUntil: subscription.graceUntil,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
      effectiveCurrentPeriodEnd: maxEntitlementEnd ? maxEntitlementEnd.toISOString() : null,
    } : null,
    billedCreators: rows.filter((row) => !row.billingExcluded).length,
    activeEntitledCreators: activeRows.length,
    creatorsCount: rows.length,
    monthlyTotalCents,
    estimatedNext30DaysCents,
    pricingDataUnavailableCreators,
    wallet: walletState.wallet,
    walletTransactions: walletState.transactions,
    creators: rows,
    catalog: catalogForClient(),
    provider: {
      mode: billingMode,
      internalTestMode: billingMode === "FREE_INTERNAL",
      ...providerBase,
      checkoutAvailable: providerBase.checkoutAvailable && !liveCheckoutBlockedByInternalTestMode,
      liveCheckoutBlockedByInternalTestMode,
    },
    recentOrders: orders,
  };
}

module.exports = {
  WORKSPACE_SETTING_DEFAULTS,
  TIME_FORMATS,
  DATE_FORMATS,
  isValidTimezone,
  normalizeWorkspacePreferences,
  getAccountSettings,
  updateAccountProfile,
  updateAccountAvatar,
  changeAccountPassword,
  requestAccountPasswordReset,
  logoutAccountDevice,
  logoutOtherAccountDevices,
  revokeAccountSession,
  revokeOtherAccountSessions,
  canManageWorkspaceSettings,
  getWorkspaceSettings,
  updateWorkspaceSettings,
  getBillingSettings,
  getTelegramMtprotoSettings,
  updateTelegramCustomReminderSettings,
  addTelegramMtprotoAccount,
  removeTelegramMtprotoAccount,
  forceRetireLostTelegramMtprotoAccount,
  issueTelegramMtprotoLocalMaterial,
  storeTelegramMtprotoSession,
};

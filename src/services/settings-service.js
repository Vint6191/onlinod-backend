"use strict";

const bcrypt = require("bcryptjs");
const prisma = require("../prisma");
const { publicUser, issuePasswordReset } = require("./auth-service");
const { audit } = require("./audit-service");
const { canUsePermission, isOwner } = require("./team-access-control");
const { encryptTelegramCredentials, decryptTelegramCredentials } = require("./telegram-mtproto-credentials");
const {
  beginTelegramAuthorization,
  submitTelegramAuthorizationCode,
  submitTelegramAuthorizationPassword,
  testTelegramConnection,
  getTelegramTestStatus,
  getTelegramRuntimeStatus,
  forgetTelegramAccountRuntime,
} = require("./telegram-mtproto-runtime");
const { publicProviderConfig, recentOrders } = require("./billing-nowpayments-service");
const { catalogForClient } = require("./billing-catalog-service");
const { publicEntitlement } = require("./billing-entitlement-service");
const { getWalletState, readRolling30dRevenueBatch, pricingPreviewFromRevenue } = require("./billing-wallet-service");

const WORKSPACE_SETTING_DEFAULTS = Object.freeze({
  timezone: "UTC",
  timeFormat: "24h",
  dateFormat: "DD.MM.YYYY",
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
  return { timezone, timeFormat, dateFormat };
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

async function getAccountSettings({ userId, currentDeviceId = null, db = null }) {
  const client = db || prisma;
  const now = new Date();
  const [user, sessions] = await Promise.all([
    client.user.findUnique({ where: { id: userId } }),
    client.refreshSession.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: [{ lastUsedAt: "desc" }, { createdAt: "desc" }],
    }),
  ]);
  if (!user) return null;
  const normalizedDeviceId = clean(currentDeviceId, 160) || null;
  const currentSession = normalizedDeviceId
    ? sessions.find((row) => clean(row.deviceId, 160) === normalizedDeviceId) || null
    : null;
  return {
    user: publicUser(user),
    currentDeviceId: normalizedDeviceId,
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

async function revokeAccountSession({ agencyId, userId, sessionId, currentDeviceId = null, db = null }) {
  const client = db || prisma;
  const session = await client.refreshSession.findFirst({ where: { id: clean(sessionId, 180), userId, revokedAt: null } });
  if (!session) {
    const err = new Error("Session not found");
    err.code = "SETTINGS_SESSION_NOT_FOUND";
    throw err;
  }
  let currentSessionId = null;
  const normalizedDeviceId = clean(currentDeviceId, 160);
  if (normalizedDeviceId && clean(session.deviceId, 160) === normalizedDeviceId) {
    const current = await client.refreshSession.findFirst({
      where: { userId, deviceId: normalizedDeviceId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: [{ lastUsedAt: "desc" }, { createdAt: "desc" }],
    });
    currentSessionId = current?.id || null;
  }
  await client.refreshSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
  const currentDeviceRevoked = !!currentSessionId && String(currentSessionId) === String(session.id);
  await audit({ agencyId, actorUserId: userId, action: "settings.account.session_revoked", targetType: "refresh_session", targetId: session.id, metadata: { deviceId: session.deviceId || null, client: session.client || null, currentDeviceRevoked }, db: client });
  return { ok: true, currentDeviceRevoked };
}

async function revokeOtherAccountSessions({ agencyId, userId, currentDeviceId, db = null }) {
  const client = db || prisma;
  const deviceId = clean(currentDeviceId, 160);
  if (!deviceId) {
    const err = new Error("Current device id is required");
    err.code = "SETTINGS_CURRENT_DEVICE_REQUIRED";
    throw err;
  }
  const result = await client.refreshSession.updateMany({
    where: { userId, revokedAt: null, OR: [{ deviceId: { not: deviceId } }, { deviceId: null }] },
    data: { revokedAt: new Date() },
  });
  await audit({ agencyId, actorUserId: userId, action: "settings.account.other_sessions_revoked", targetType: "user", targetId: userId, metadata: { currentDeviceId: deviceId, revokedCount: result.count }, db: client });
  return { ok: true, revokedCount: result.count };
}

async function canManageWorkspaceSettings(member, db = null) {
  return canUsePermission({ member, key: "workspace.manage_settings", db: db || prisma });
}

async function getWorkspaceSettings({ agencyId, member, db = null }) {
  const client = db || prisma;
  const [agency, rows] = await Promise.all([
    client.agency.findUnique({ where: { id: agencyId }, select: { id: true, name: true, plan: true, status: true, trialEndsAt: true, currentPeriodEnd: true } }),
    client.workspaceSetting.findMany({ where: { agencyId, key: { in: ["timezone", "timeFormat", "dateFormat"] } } }),
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


async function getTelegramMtprotoSettings({ agencyId, member, db = null }) {
  if (!isOwner(member)) return { available: false, reason: "OWNER_ONLY", accounts: [] };
  const client = db || prisma;
  const rows = await client.agencyTelegramMtprotoAccount.findMany({
    where: { agencyId },
    select: { id: true, apiId: true, encryptedPayload: true, iv: true, tag: true, algorithm: true, payloadVersion: true },
    orderBy: { id: "asc" },
  });
  const accounts = rows.map((row) => {
    let sessionReady = false;
    try { sessionReady = Boolean(String(decryptTelegramCredentials(row).session || "").trim()); } catch (_) {}
    const runtime = getTelegramRuntimeStatus(row.id);
    return { id: row.id, apiId: row.apiId, sessionReady, connected: runtime.connected === true, authStage: runtime.authStage || null };
  });
  return { available: true, accounts };
}

function telegramInputError(message, code) {
  const err = new Error(message);
  err.code = code;
  err.status = 400;
  return err;
}

async function addTelegramMtprotoAccount({ agencyId, member, apiId, apiHash, session, db = null }) {
  if (!isOwner(member)) {
    const err = new Error("Only the agency owner can manage Telegram MTProto credentials");
    err.code = "SETTINGS_TELEGRAM_OWNER_ONLY";
    err.status = 403;
    throw err;
  }
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
  return { available: true, account: { ...account, sessionReady: Boolean(cleanSession), connected: false, authStage: null } };
}

async function removeTelegramMtprotoAccount({ agencyId, member, accountId, db = null }) {
  if (!isOwner(member)) {
    const err = new Error("Only the agency owner can manage Telegram MTProto credentials");
    err.code = "SETTINGS_TELEGRAM_OWNER_ONLY";
    err.status = 403;
    throw err;
  }
  const id = String(accountId || "").trim();
  if (!id || id.length > 180) throw telegramInputError("Telegram connection id is required", "SETTINGS_TELEGRAM_ACCOUNT_INVALID");
  const client = db || prisma;
  const existing = await client.agencyTelegramMtprotoAccount.findFirst({ where: { id, agencyId }, select: { id: true } });
  if (!existing) {
    const err = new Error("Telegram connection not found");
    err.code = "SETTINGS_TELEGRAM_ACCOUNT_NOT_FOUND";
    err.status = 404;
    throw err;
  }
  await forgetTelegramAccountRuntime(existing.id).catch(() => undefined);
  await client.agencyTelegramMtprotoAccount.delete({ where: { id: existing.id } });
  return { ok: true };
}

function ensureTelegramOwner(member) {
  if (isOwner(member)) return;
  const err = new Error("Only the agency owner can manage Telegram MTProto credentials");
  err.code = "SETTINGS_TELEGRAM_OWNER_ONLY";
  err.status = 403;
  throw err;
}

async function startTelegramMtprotoAuthorization({ agencyId, member, accountId, phone }) {
  ensureTelegramOwner(member);
  return beginTelegramAuthorization({ agencyId, accountId: clean(accountId, 180), phone });
}

async function submitTelegramMtprotoCode({ agencyId, member, accountId, challengeId, code }) {
  ensureTelegramOwner(member);
  return submitTelegramAuthorizationCode({ agencyId, accountId: clean(accountId, 180), challengeId: clean(challengeId, 180), code });
}

async function submitTelegramMtprotoPassword({ agencyId, member, accountId, challengeId, password }) {
  ensureTelegramOwner(member);
  return submitTelegramAuthorizationPassword({ agencyId, accountId: clean(accountId, 180), challengeId: clean(challengeId, 180), password });
}

async function runTelegramMtprotoConnectionTest({ agencyId, member, accountId }) {
  ensureTelegramOwner(member);
  return testTelegramConnection({ agencyId, accountId: clean(accountId, 180) });
}

async function readTelegramMtprotoTestStatus({ agencyId, member, accountId }) {
  ensureTelegramOwner(member);
  return getTelegramTestStatus({ agencyId, accountId: clean(accountId, 180) });
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
  revokeAccountSession,
  revokeOtherAccountSessions,
  canManageWorkspaceSettings,
  getWorkspaceSettings,
  updateWorkspaceSettings,
  getBillingSettings,
  getTelegramMtprotoSettings,
  addTelegramMtprotoAccount,
  removeTelegramMtprotoAccount,
  startTelegramMtprotoAuthorization,
  submitTelegramMtprotoCode,
  submitTelegramMtprotoPassword,
  runTelegramMtprotoConnectionTest,
  readTelegramMtprotoTestStatus,
};

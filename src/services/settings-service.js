"use strict";

const bcrypt = require("bcryptjs");
const prisma = require("../prisma");
const { publicUser, issuePasswordReset } = require("./auth-service");
const { audit } = require("./audit-service");
const { canUsePermission, isOwner } = require("./team-access-control");

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

function billingLine(profile) {
  const core = profile.billingExcluded ? 0 : Number(profile.corePriceCents || 0);
  const ai = !profile.billingExcluded && profile.aiChatterEnabled ? Number(profile.aiChatterPriceCents || 0) : 0;
  const outreach = !profile.billingExcluded && profile.outreachEnabled ? Number(profile.outreachPriceCents || 0) : 0;
  return {
    creatorId: String(profile.creatorId),
    creatorName: profile.creator?.displayName || profile.creator?.username || String(profile.creatorId),
    creatorUsername: profile.creator?.username || null,
    tier: String(profile.tier || "STARTER"),
    corePriceCents: core,
    aiChatterEnabled: profile.aiChatterEnabled === true,
    aiChatterPriceCents: ai,
    outreachEnabled: profile.outreachEnabled === true,
    outreachPriceCents: outreach,
    billingExcluded: profile.billingExcluded === true,
    lineTotalCents: core + ai + outreach,
  };
}

async function getBillingSettings({ agencyId, member, db = null }) {
  const client = db || prisma;
  if (!isOwner(member)) return { available: false, reason: "OWNER_ONLY" };
  const [agency, subscription, profiles, creatorsCount] = await Promise.all([
    client.agency.findUnique({ where: { id: agencyId }, select: { id: true, name: true, plan: true, status: true, trialEndsAt: true, currentPeriodEnd: true } }),
    client.agencySubscription.findFirst({ where: { agencyId }, orderBy: { createdAt: "desc" } }),
    client.creatorBillingProfile.findMany({ where: { agencyId }, include: { creator: { select: { id: true, displayName: true, username: true, deletedAt: true } } }, orderBy: { createdAt: "asc" } }),
    client.creatorAccount.count({ where: { agencyId, deletedAt: null } }),
  ]);
  const rows = profiles.filter((row) => !row.creator?.deletedAt).map(billingLine);
  const monthlyTotalCents = rows.reduce((sum, row) => sum + row.lineTotalCents, 0);
  const billingMode = String(subscription?.billingMode || "MANUAL");
  return {
    available: true,
    agency,
    subscription: subscription ? {
      id: subscription.id,
      status: subscription.status,
      billingMode,
      billingPeriod: subscription.billingPeriod,
      corePricePerCreatorCents: subscription.corePricePerCreatorCents,
      trialEndsAt: subscription.trialEndsAt,
      graceUntil: subscription.graceUntil,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
    } : null,
    billedCreators: rows.filter((row) => !row.billingExcluded).length,
    creatorsCount,
    monthlyTotalCents,
    creators: rows,
    provider: {
      mode: billingMode,
      testMode: billingMode === "FREE_INTERNAL",
      checkoutAvailable: false,
      providerKey: billingMode === "CRYPTO" ? clean(process.env.BILLING_CRYPTO_PROVIDER, 80) || null : null,
    },
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
};

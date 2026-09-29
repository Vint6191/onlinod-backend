"use strict";
const { z } = require("zod");
const bcrypt = require("bcryptjs");
const { digest } = require("./team-command-contract");
const { runRootCommit } = require("./db-commit-kernel");
const { lockDbAdvisoryXact } = require("./db-transaction-service");
const { acquireAuthorizationUserLock } = require("./authorization-session-authority-service");
const { assertManagementCommitAuthority, lockAgencyLifecycle } = require("./management-commit-authority-service");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { audit } = require("./audit-service");
const { fail, sessionRevision, selectSessions, readActiveSessions } = require("./account-security-state");
const ACTIONS = ["account.password", "account.logoutDevice", "account.logoutOthers", "account.revokeSession", "account.revokeOthers"];
const identity = z.string().min(1).max(220);
const origin = { originAuthorizationSessionId: identity, deviceId: z.string().min(1).max(160) };
const envelope = z.object({ commandId: z.string().uuid().transform(s => s.toLowerCase()), action: z.enum(ACTIONS), targetId: z.string().max(180), payload: z.record(z.unknown()) }).strict();
const password = z.object({ ...origin, currentPassword: z.string().min(1).max(200), newPassword: z.string().min(8).max(200) }).strict();
const logout = z.object({ ...origin, expectedRevision: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
function parse(input, cancel = false) {
  const c = envelope.parse(input);
  if (Buffer.byteLength(JSON.stringify(c.payload)) > 4096) throw fail("ACCOUNT_SECURITY_PAYLOAD_LIMIT", "Invalid account action", 413);
  const fingerprint = digest(["account-security-v1", c.commandId, c.action, c.targetId, c.payload]);
  if (!cancel) {
    const targeted = ["account.logoutDevice", "account.revokeSession"].includes(c.action);
    if (targeted ? !c.targetId : c.targetId !== "") throw fail("ACCOUNT_SECURITY_TARGET_INVALID", "Invalid account target", 400);
    return { ...c, payload: (c.action === "account.password" ? password : logout).parse(c.payload), fingerprint };
  }
  return { ...c, fingerprint };
}
async function preparePassword(db, userId, c, receiptId) {
  if (c.action !== "account.password") return null;
  // Avoid expensive credential work on replay. A concurrent commit is checked
  // again under locks before any preparation error is surfaced.
  const prior = await db.$queryRawUnsafe('SELECT "id" FROM "ManagementCommandReceipt" WHERE "id"=$1', receiptId);
  if (prior.length) return null;
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user || user.disabledAt || !(await bcrypt.compare(c.payload.currentPassword, user.passwordHash)))
    return { error: fail("SETTINGS_CURRENT_PASSWORD_INVALID", "Current password is incorrect", 400) };
  return { before: user.passwordHash, next: await bcrypt.hash(c.payload.newPassword, 12) };
}
async function executeAccountSecurityCommand({ db, agencyId, userId, actorMember, deviceId, authorizationSessionId, input, cancel = false }) {
  if (!agencyId || !userId || actorMember?.userId !== userId || !actorMember?.id)
    throw fail("ACCOUNT_SECURITY_ACTOR_REQUIRED", "Current account is required", 403);
  if (!deviceId || !authorizationSessionId) throw fail("ACCOUNT_SECURITY_LINEAGE_REQUIRED", "Sign in with an updated Desktop", 401);
  const c = parse(input, cancel);
  const id = "account_security_v1_" + digest([agencyId, userId, c.commandId]);
  const prepared = cancel ? null : await preparePassword(db, userId, c, id);
  return runRootCommit(db, async ({ tx }) => {
    await lockAgencyLifecycle({ tx, agencyId });
    await lockDbAdvisoryXact({ db: tx, key: id });
    // Same account lock as login, refresh, logout and password reset, across agencies.
    await acquireAuthorizationUserLock(tx, { userId });
    await tx.$queryRawUnsafe('SELECT "id" FROM "User" WHERE "id"=$1 FOR UPDATE', userId);
    await assertManagementCommitAuthority({ tx, agencyId, actorMember, agencyAlreadyLocked: true });
    const now = await dbAuthorityNow({ db: tx, fallbackNow: new Date() });
    const live = await tx.refreshSession.findFirst({ where: { userId, agencyId, deviceId, authorizationSessionId, revokedAt: null, expiresAt: { gt: now } }, select: { id: true } });
    if (!live) throw fail("SESSION_REVOKED", "This sign-in is no longer active", 401);
    const [prior] = await tx.$queryRawUnsafe('SELECT * FROM "ManagementCommandReceipt" WHERE "id"=$1', id);
    if (prior && prior.fingerprint !== c.fingerprint) throw fail("ACCOUNT_SECURITY_COMMAND_CONFLICT", "Command ID belongs to another intent");
    const store = async (status, reference) => tx.$executeRawUnsafe(
      'INSERT INTO "ManagementCommandReceipt" ("id","agencyId","userId","action","targetId","fingerprint","status","reference") VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',
      id, agencyId, userId, c.action, c.targetId, c.fingerprint, status, JSON.stringify(reference));
    if (cancel) {
      if (!prior) await store("ABANDONED", {});
      return { ok: true, commandId: c.commandId, alreadyCommitted: prior?.status === "COMMITTED", abandoned: !prior || prior.status === "ABANDONED" };
    }
    if (prior?.status === "ABANDONED") throw fail("ACCOUNT_SECURITY_COMMAND_ABANDONED", "This account action was cancelled");
    // A receipt confirms the original event, not the state of later sign-ins.
    if (prior) return { ok: true, commandId: c.commandId, action: c.action, replayed: true, result: prior.reference.result };
    if (c.payload.deviceId !== deviceId || c.payload.originAuthorizationSessionId !== authorizationSessionId)
      throw fail("ACCOUNT_SECURITY_ORIGIN_CHANGED", "This pending action belongs to an earlier sign-in; cancel it before starting a new action");
    const rows = await readActiveSessions(tx, userId, now);
    const targets = selectSessions(rows, c.action, c.targetId, deviceId);
    if (c.action !== "account.password" && sessionRevision(targets) !== c.payload.expectedRevision)
      throw fail("ACCOUNT_SECURITY_SESSION_CHANGED", "Sign-ins changed; refresh the device list before trying again");
    if (c.action === "account.password") {
      if (prepared?.error) throw prepared.error;
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!prepared?.next || user.passwordHash !== prepared.before) throw fail("SETTINGS_PASSWORD_CHANGED", "Password changed while this request was being verified");
      await tx.user.update({ where: { id: userId }, data: { passwordHash: prepared.next } });
      await tx.authToken.updateMany({ where: { userId, type: "PASSWORD_RESET", usedAt: null }, data: { usedAt: now } });
    }
    const revoked = targets.length ? await tx.refreshSession.updateMany({ where: { userId, id: { in: targets.map(r => r.id) }, revokedAt: null, expiresAt: { gt: now } }, data: { revokedAt: now } }) : { count: 0 };
    const currentDeviceLoggedOut = targets.some(r => r.deviceId === deviceId && r.agencyId === agencyId && r.authorizationSessionId === authorizationSessionId);
    const result = { ok: true, userId, deviceId: c.action === "account.logoutDevice" ? c.targetId : deviceId,
      originAuthorizationSessionId: authorizationSessionId, revokedSessionCount: revoked.count,
      loggedOutDeviceCount: new Set(targets.map(r => r.deviceId).filter(Boolean)).size, currentDeviceLoggedOut,
      currentDeviceRevoked: currentDeviceLoggedOut, revokedCount: revoked.count,
      ...(c.action === "account.password" ? { passwordChanged: true } : {}) };
    await audit({ required: true, db: tx, agencyId, actorUserId: userId, action: "account_security.committed", targetType: c.action, targetId: c.targetId || userId,
      metadata: { commandId: c.commandId, revokedSessionCount: revoked.count, currentDeviceLoggedOut } });
    await store("COMMITTED", { result });
    return { ok: true, commandId: c.commandId, action: c.action, replayed: false, result };
  }, { profile: "SECRET_WRITE", authority: { kind: "ACCOUNT_SECURITY", agencyId, userId }, maxAttempts: 1 });
}
module.exports = { ACTIONS, parse, executeAccountSecurityCommand };

"use strict";

const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const { adminError, publicAdmin } = require("./admin-command-contract");
const { dbAuthorityNow } = require("./db-time-authority-service");

const KNOWN_ROLES = new Set(["SUPER_ADMIN", "SUPPORT"]);
const sha256 = value => crypto.createHash("sha256").update(String(value)).digest("hex");

async function lockAdminRows(tx, ids, mode = "share") {
  if (typeof tx?.$queryRawUnsafe !== "function") throw adminError("ADMIN_TRANSACTION_REQUIRED", "PostgreSQL transaction authority is required", 503);
  for (const id of [...new Set(ids.filter(Boolean).map(String))].sort()) {
    await tx.$queryRawUnsafe(`SELECT "id" FROM "AdminUser" WHERE "id"=$1 FOR ${mode === "update" ? "UPDATE" : "SHARE"}`, id);
  }
}

async function lockAdminActor(tx, actor, { roles = ["SUPER_ADMIN", "SUPPORT"], targetAdminId = null, mutateIdentity = false } = {}) {
  if (!actor?.adminId || !actor?.sessionId || !Number.isInteger(actor.accessEpoch)) throw adminError("ADMIN_AUTH_REQUIRED", "Current admin session is required", 401);
  await lockAdminRows(tx, [actor.adminId, ...(mutateIdentity ? [targetAdminId] : [])], mutateIdentity ? "update" : "share");
  await tx.$queryRawUnsafe('SELECT "id" FROM "AdminSession" WHERE "id"=$1 AND "adminUserId"=$2 FOR SHARE', actor.sessionId, actor.adminId);
  const session = await tx.adminSession.findUnique({ where: { id: actor.sessionId }, include: { adminUser: true } });
  const now = await dbAuthorityNow({ db: tx });
  const admin = session?.adminUser;
  if (!session || session.adminUserId !== actor.adminId || session.revokedAt || new Date(session.expiresAt) <= now) throw adminError("ADMIN_AUTH_INVALID", "Admin session is expired or revoked", 401);
  if (!admin?.active || !KNOWN_ROLES.has(admin.role)) throw adminError("ADMIN_DISABLED", "Admin authority is inactive", 403);
  if (admin.accessEpoch !== session.issuedAccessEpoch || actor.accessEpoch !== admin.accessEpoch) throw adminError("ADMIN_AUTH_GENERATION_CHANGED", "Admin access changed; sign in again", 401);
  if (!roles.includes(admin.role)) throw adminError("ADMIN_INSUFFICIENT_ROLE", "This action is not permitted for this admin role", 403);
  return { admin, session, now };
}

async function loginAdmin({ db, email, password, ip = null, userAgent = null }) {
  const before = await db.adminUser.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!before?.active || !KNOWN_ROLES.has(before.role) || !(await bcrypt.compare(password, before.passwordHash))) throw adminError("ADMIN_AUTH_INVALID", "Invalid admin credentials", 401);
  const days = Number(process.env.ADMIN_SESSION_DAYS || 7);
  if (!Number.isInteger(days) || days < 1 || days > 30) throw adminError("ADMIN_SESSION_CONFIG_INVALID", "ADMIN_SESSION_DAYS must be between 1 and 30", 503);
  const token = crypto.randomBytes(32).toString("base64url");
  return db.$transaction(async tx => {
    await lockAdminRows(tx, [before.id], "update");
    const admin = await tx.adminUser.findUnique({ where: { id: before.id } });
    if (!admin?.active || !KNOWN_ROLES.has(admin.role) || admin.passwordHash !== before.passwordHash || admin.accessEpoch !== before.accessEpoch) throw adminError("ADMIN_CREDENTIAL_GENERATION_CHANGED", "Admin credentials changed; sign in again", 401);
    const now = await dbAuthorityNow({ db: tx });
    const expiresAt = new Date(now.getTime() + days * 86400000);
    const session = await tx.adminSession.create({ data: { adminUserId: admin.id, issuedAccessEpoch: admin.accessEpoch, tokenHash: sha256(token), expiresAt, ip, userAgent } });
    await tx.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: now } });
    await tx.adminActionLog.create({ data: { adminUserId: admin.id, action: "admin.session_created", targetType: "admin_session", targetId: session.id, after: { accessEpoch: admin.accessEpoch, expiresAt: expiresAt.toISOString() } } });
    return { ok: true, token, expiresAt, admin: publicAdmin({ ...admin, lastLoginAt: now }) };
  }, { maxWait: 5000, timeout: 15000 });
}

async function logoutAdmin({ db, actor }) {
  return db.$transaction(async tx => {
    // Match command order: AdminUser before AdminSession. A completed logout
    // blocks every subsequent new command; it does not touch customer sessions.
    await lockAdminRows(tx, [actor.adminId]);
    await tx.$queryRawUnsafe('SELECT "id" FROM "AdminSession" WHERE "id"=$1 AND "adminUserId"=$2 FOR UPDATE', actor.sessionId, actor.adminId);
    const session = await tx.adminSession.findUnique({ where: { id: actor.sessionId } });
    if (!session || session.adminUserId !== actor.adminId) throw adminError("ADMIN_AUTH_INVALID", "Admin session is invalid", 401);
    if (session.revokedAt) return { ok: true };
    const now = await dbAuthorityNow({ db: tx });
    await tx.adminSession.update({ where: { id: session.id }, data: { revokedAt: now } });
    await tx.adminActionLog.create({ data: { adminUserId: actor.adminId, action: "admin.session_revoked", targetType: "admin_session", targetId: session.id } });
    return { ok: true };
  });
}

module.exports = { KNOWN_ROLES, sha256, lockAdminRows, lockAdminActor, loginAdmin, logoutAdmin };

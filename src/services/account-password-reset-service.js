"use strict";
const bcrypt = require("bcryptjs");
const { sha256 } = require("../utils/crypto");
const { runDbTransaction } = require("./db-transaction-service");
const { acquireAuthorizationUserLock } = require("./authorization-session-authority-service");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { fail } = require("./account-security-state");
const { assertNewPassword } = require("./account-password-policy");
async function resetAccountPassword({ db, token, password }) {
  if (typeof token !== "string" || !token || token.length > 256)
    throw fail("RESET_PASSWORD_INVALID", "Invalid password reset", 400);
  assertNewPassword(password);
  const record = await db.authToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!record || record.type !== "PASSWORD_RESET") throw fail("TOKEN_INVALID", "Reset token is invalid", 400);
  if (record.usedAt) throw fail("TOKEN_USED", "Reset token was already used", 400);
  const preparedUser = await db.user.findUnique({ where: { id: record.userId } });
  if (!preparedUser || preparedUser.disabledAt) throw fail("SETTINGS_ACCOUNT_INACTIVE", "Account is inactive", 403);
  const equivalent = await bcrypt.compare(password, preparedUser.passwordHash);
  const passwordHash = await bcrypt.hash(password, 12);
  return runDbTransaction(db, async tx => {
    await acquireAuthorizationUserLock(tx, { userId: record.userId });
    await tx.$queryRawUnsafe('SELECT "id" FROM "User" WHERE "id"=$1 FOR UPDATE', record.userId);
    const user = await tx.user.findUnique({ where: { id: record.userId } });
    if (!user || user.disabledAt) throw fail("SETTINGS_ACCOUNT_INACTIVE", "Account is inactive", 403);
    const now = await dbAuthorityNow({ db: tx, fallbackNow: new Date() });
    const current = await tx.authToken.findUnique({ where: { id: record.id } });
    if (!current || current.usedAt) throw fail("TOKEN_USED", "Reset token was already used", 400);
    if (new Date(current.expiresAt) <= now) throw fail("TOKEN_EXPIRED", "Reset token expired", 400);
    if (user.passwordHash !== preparedUser.passwordHash) throw fail("SETTINGS_PASSWORD_CHANGED", "Password changed while this reset was being verified", 409);
    if (equivalent) throw fail("PASSWORD_UNCHANGED", "Choose a password different from your current password", 400);
    const consumed = await tx.authToken.updateMany({ where: { id: record.id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
    if (consumed.count !== 1) throw fail("TOKEN_USED", "Reset token was already used", 400);
    await tx.authToken.updateMany({ where: { userId: record.userId, type: "PASSWORD_RESET", usedAt: null }, data: { usedAt: now } });
    await tx.user.update({ where: { id: record.userId }, data: { passwordHash, sessionsRevokedAt: now } });
    await tx.refreshSession.updateMany({ where: { userId: record.userId, revokedAt: null, expiresAt: { gt: now } }, data: { revokedAt: now } });
    return { ok: true };
  });
}
module.exports = { resetAccountPassword };

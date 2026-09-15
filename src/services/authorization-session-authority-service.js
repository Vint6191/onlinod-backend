"use strict";

const { lockDbAdvisoryXact, runDbTransaction } = require("./db-transaction-service");

function clean(value, max = 240) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

function authorizationChanged(code, message) {
  const error = new Error(message || "Authorization changed while the session was being committed");
  error.code = code || "AUTHORIZATION_CHANGED";
  error.status = 409;
  return error;
}

async function acquireAuthorizationUserLock(db, { userId } = {}) {
  const user = clean(userId, 180);
  if (!user) return false;
  await lockDbAdvisoryXact({ db, key: `authorization-user:${user}` });
  return true;
}

async function acquireAuthorizationDeviceLock(db, { userId, agencyId, deviceId } = {}) {
  const user = clean(userId, 180);
  const agency = clean(agencyId, 180);
  const device = clean(deviceId, 180);
  if (!user || !agency || !device) return false;
  await lockDbAdvisoryXact({ db, key: `authorization-device:${user}:${agency}:${device}` });
  return true;
}

async function acquireAuthorizationLineageLock(db, authorizationSessionId) {
  const lineage = clean(authorizationSessionId, 220);
  if (!lineage) return false;
  await lockDbAdvisoryXact({ db, key: `authorization-lineage:${lineage}` });
  return true;
}

async function lockCurrentLoginAuthority(db, {
  userId,
  agencyId,
  memberId,
  expectedAccessEpoch = null,
  expectedPasswordHash = null,
} = {}) {
  const user = clean(userId, 180);
  const agency = clean(agencyId, 180);
  const member = clean(memberId, 180);
  if (!user || !agency || !member) throw authorizationChanged("AUTHORIZATION_CHANGED", "Login authority identity is incomplete");

  let row = null;
  if (typeof db?.$queryRawUnsafe === "function") {
    const rows = await db.$queryRawUnsafe(`
      SELECT m."id" AS "memberId",
             m."accessEpoch" AS "accessEpoch",
             m."deletedAt" AS "memberDeletedAt",
             m."deactivatedAt" AS "memberDeactivatedAt",
             u."disabledAt" AS "userDisabledAt",
             u."passwordHash" AS "passwordHash",
             a."deletedAt" AS "agencyDeletedAt"
        FROM "AgencyMember" m
        JOIN "User" u ON u."id"=m."userId"
        JOIN "Agency" a ON a."id"=m."agencyId"
       WHERE m."id"=$1 AND m."userId"=$2 AND m."agencyId"=$3
       FOR SHARE OF m,u,a
    `, member, user, agency);
    row = Array.isArray(rows) ? rows[0] || null : null;
  } else if (db?.agencyMember?.findFirst) {
    const found = await db.agencyMember.findFirst({
      where: { id: member, userId: user, agencyId: agency },
      include: { user: true, agency: true },
    });
    if (found) {
      row = {
        memberId: found.id,
        accessEpoch: found.accessEpoch,
        memberDeletedAt: found.deletedAt || null,
        memberDeactivatedAt: found.deactivatedAt || null,
        userDisabledAt: found.user?.disabledAt || null,
        passwordHash: found.user?.passwordHash || null,
        agencyDeletedAt: found.agency?.deletedAt || null,
      };
    }
  }

  if (!row || row.memberDeletedAt || row.memberDeactivatedAt || row.userDisabledAt || row.agencyDeletedAt) {
    throw authorizationChanged("AUTHORIZATION_CHANGED", "User, membership, or agency is no longer authorized");
  }
  if (expectedAccessEpoch !== null && expectedAccessEpoch !== undefined
      && Number(row.accessEpoch || 0) !== Number(expectedAccessEpoch || 0)) {
    throw authorizationChanged("AUTHORIZATION_GENERATION_CHANGED", "Membership authorization generation changed during session commit");
  }
  if (expectedPasswordHash && row.passwordHash && String(row.passwordHash) !== String(expectedPasswordHash)) {
    throw authorizationChanged("CREDENTIAL_GENERATION_CHANGED", "Password changed while login was being committed");
  }
  return row;
}


async function lockCurrentRefreshSession(db, {
  sessionId,
  tokenHash,
  userId,
  agencyId,
} = {}) {
  const session = clean(sessionId, 220);
  const token = clean(tokenHash, 220);
  const user = clean(userId, 180);
  const agency = clean(agencyId, 180);
  if (!session || !token || !user || !agency) {
    const error = new Error("Refresh session identity is incomplete");
    error.code = "REFRESH_INVALID";
    error.status = 401;
    throw error;
  }

  let row = null;
  if (typeof db?.$queryRawUnsafe === "function") {
    const rows = await db.$queryRawUnsafe(`
      SELECT r."id", r."userId", r."agencyId", r."deviceId",
             r."authorizationSessionId", r."expiresAt", r."revokedAt",
             (r."expiresAt" <= clock_timestamp()) AS "expired"
        FROM "RefreshSession" r
       WHERE r."id"=$1 AND r."tokenHash"=$2
       FOR UPDATE
    `, session, token);
    row = Array.isArray(rows) ? rows[0] || null : null;
  } else if (db?.refreshSession?.findUnique) {
    const found = await db.refreshSession.findUnique({ where: { id: session } });
    if (found && String(found.tokenHash || "") === token) {
      row = {
        ...found,
        expired: new Date(found.expiresAt).getTime() <= Date.now(),
      };
    }
  }

  if (!row || String(row.userId || "") !== user || String(row.agencyId || "") !== agency) {
    const error = new Error("Refresh token is invalid or expired");
    error.code = "REFRESH_INVALID";
    error.status = 401;
    throw error;
  }
  if (row.revokedAt) {
    const error = new Error("Refresh token reuse detected. Please sign in again.");
    error.code = "REFRESH_REUSED";
    error.status = 401;
    throw error;
  }
  if (row.expired === true) {
    const error = new Error("Refresh token is invalid or expired");
    error.code = "REFRESH_INVALID";
    error.status = 401;
    throw error;
  }
  return row;
}

async function withAuthorizationUserLock({ db, userId, work, options = undefined }) {
  if (typeof work !== "function") throw new TypeError("withAuthorizationUserLock requires a work callback");
  return runDbTransaction(db, async (tx) => {
    await acquireAuthorizationUserLock(tx, { userId });
    return work(tx);
  }, options);
}

module.exports = {
  acquireAuthorizationUserLock,
  acquireAuthorizationDeviceLock,
  acquireAuthorizationLineageLock,
  lockCurrentLoginAuthority,
  lockCurrentRefreshSession,
  withAuthorizationUserLock,
};

"use strict";
const { digest } = require("./team-command-contract");
const LIMIT = 2048;
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
// Refresh rotation changes a token, not the login generation being displayed.
// NULL-lineage clients have no stable generation: their exact row is the fence.
function sessionRevision(rows) {
  return digest([...new Set(rows.map(r => JSON.stringify([
    r.agencyId, r.deviceId || null, r.authorizationSessionId || `legacy:${r.id}`,
  ])))].sort());
}
function selectSessions(rows, action, targetId, currentDeviceId) {
  if (action === "account.logoutDevice") return rows.filter(r => r.deviceId === targetId);
  if (action === "account.revokeSession") {
    const target = rows.find(r => r.id === targetId);
    if (!target) throw fail("SETTINGS_SESSION_NOT_FOUND", "Session changed; refresh the device list");
    return target.deviceId ? rows.filter(r => r.deviceId === target.deviceId) : [target];
  }
  return rows.filter(r => r.deviceId !== currentDeviceId);
}
async function readActiveSessions(tx, userId, now) {
  const rows = await tx.refreshSession.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: now } },
    take: LIMIT + 1,
    orderBy: { id: "asc" },
  });
  if (rows.length > LIMIT) throw fail("ACCOUNT_SECURITY_SESSION_LIMIT", "Too many active sessions; contact support", 409);
  return rows;
}
module.exports = { LIMIT, fail, sessionRevision, selectSessions, readActiveSessions };

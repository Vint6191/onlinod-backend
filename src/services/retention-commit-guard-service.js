"use strict";
const { dbAuthorityNow, asDate } = require("./db-time-authority-service");
const { assertAdminSessionLifetimeAt } = require("./admin-session-authority-service");
async function lockRetentionCommit({ tx, ownerToken, adminAuthority = null }) {
  const rows = await tx.$queryRawUnsafe('SELECT "ownerToken", "leaseUntil", "completedAt" FROM "RetentionSweepLease" WHERE "key"=$1 FOR SHARE', "global_retention_v1");
  const now = await dbAuthorityNow({ db: tx });
  const lease = rows[0];
  if (!lease || lease.ownerToken !== ownerToken || lease.completedAt || !asDate(lease.leaseUntil) || asDate(lease.leaseUntil) <= now) throw Object.assign(new Error("Retention ownership lost before archive commit"), { code: "RETENTION_LEASE_LOST" });
  if (adminAuthority) assertAdminSessionLifetimeAt(adminAuthority, now);
}
module.exports = { lockRetentionCommit };

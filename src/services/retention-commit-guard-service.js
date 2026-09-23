"use strict";
const { dbAuthorityNow } = require("./db-time-authority-service");
async function lockRetentionCommit({ tx, ownerToken }) {
  const rows = await tx.$queryRawUnsafe('SELECT "ownerToken", "leaseUntil", "completedAt" FROM "RetentionSweepLease" WHERE "key"=$1 FOR SHARE', "global_retention_v1");
  const now = await dbAuthorityNow({ db: tx });
  const lease = rows[0];
  if (!lease || lease.ownerToken !== ownerToken || lease.completedAt || lease.leaseUntil <= now) throw Object.assign(new Error("Retention ownership lost before archive commit"), { code: "RETENTION_LEASE_LOST" });
}
module.exports = { lockRetentionCommit };

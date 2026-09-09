"use strict";

const { lockDbAdvisoryXact } = require("./db-transaction-service");

function clean(value, max = 180) {
  const text = String(value == null ? "" : value).trim();
  return text ? text.slice(0, max) : "";
}

function agencyLifecycleBarrierKey(agencyId) {
  const id = clean(agencyId, 180);
  if (!id) {
    const error = new Error("Agency lifecycle barrier requires an agency id");
    error.code = "AGENCY_LIFECYCLE_BARRIER_AGENCY_REQUIRED";
    throw error;
  }
  return `agency-lifecycle:${id}`;
}

async function lockAgencyLifecycleBarrier({ db, agencyId, mode = "shared" }) {
  const id = clean(agencyId, 180);
  const key = agencyLifecycleBarrierKey(id);
  const normalizedMode = String(mode || "shared").toLowerCase() === "exclusive" ? "exclusive" : "shared";

  // Canonical lifecycle coordination is the advisory RW barrier. The immediately
  // previous Phase2 generation already acquired this same advisory key before touching
  // the Agency row, so normal shared work no longer needs a compatibility FOR SHARE.
  // This is the final scale cutover: unrelated billing/business updates to Agency must
  // not serialize ordinary Custom/Team/provider work. Destructive lifecycle mutations
  // may still lock the exact Agency row because they actually mutate that row.
  if (typeof db?.$executeRawUnsafe === "function") {
    await lockDbAdvisoryXact({ db, key, mode: normalizedMode });
  }

  let row = null;
  if (typeof db?.$queryRawUnsafe === "function") {
    const rowLock = normalizedMode === "exclusive" ? " FOR UPDATE" : "";
    const rows = await db.$queryRawUnsafe(
      `SELECT "id", "deletedAt", "status" FROM "Agency" WHERE "id" = $1${rowLock}`,
      id,
    );
    row = Array.isArray(rows) ? rows[0] || null : null;
  } else if (db?.agency?.findUnique) {
    row = await db.agency.findUnique({ where: { id }, select: { id: true, deletedAt: true, status: true } });
  } else if (db?.agency?.findFirst) {
    row = await db.agency.findFirst({ where: { id }, select: { id: true, deletedAt: true, status: true } });
  }

  return { key, mode: normalizedMode, row };
}

async function lockAgencyLifecycleBarrierExclusive({ db, agencyId }) {
  return lockAgencyLifecycleBarrier({ db, agencyId, mode: "exclusive" });
}

module.exports = {
  agencyLifecycleBarrierKey,
  lockAgencyLifecycleBarrier,
  lockAgencyLifecycleBarrierExclusive,
};

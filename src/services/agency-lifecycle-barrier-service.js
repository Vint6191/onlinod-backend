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

  // New-generation lifecycle coordination is an advisory RW barrier so normal work
  // in one large Agency can proceed in parallel. Keep the matching Agency row lock
  // during this cutover as a rolling-generation compatibility fence: the immediately
  // previous generation used FOR UPDATE on this same row. Shared holders remain
  // mutually compatible, while old/new destructive and normal work still serialize.
  if (typeof db?.$executeRawUnsafe === "function") {
    await lockDbAdvisoryXact({ db, key, mode: normalizedMode });
  }

  let row = null;
  if (typeof db?.$queryRawUnsafe === "function") {
    const rowLock = normalizedMode === "exclusive" ? "FOR UPDATE" : "FOR SHARE";
    const rows = await db.$queryRawUnsafe(
      `SELECT "id", "deletedAt", "status" FROM "Agency" WHERE "id" = $1 ${rowLock}`,
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

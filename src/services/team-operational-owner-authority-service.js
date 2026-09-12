"use strict";

function clean(value) {
  return String(value == null ? "" : value).trim();
}

function lastOperationalOwnerError(details = null) {
  const error = new Error("Cannot remove the last operational OWNER");
  // Keep the established external code stable while tightening its semantics.
  error.code = "LAST_OWNER";
  error.status = 409;
  if (details) error.details = details;
  return error;
}

function operationalOwnerWhere({ agencyId, excludeMemberId = null } = {}) {
  const agency = clean(agencyId);
  if (!agency) throw Object.assign(new Error("agencyId is required for operational OWNER authority"), { code: "OPERATIONAL_OWNER_AGENCY_REQUIRED", status: 500 });
  const where = {
    agencyId: agency,
    deletedAt: null,
    deactivatedAt: null,
    user: { is: { disabledAt: null } },
    OR: [{ roleKey: "owner" }, { role: "OWNER" }],
  };
  if (excludeMemberId) where.id = { not: clean(excludeMemberId) };
  return where;
}

async function assertOperationalOwnerRemovalSafety({ db, agencyId, memberId } = {}) {
  if (!db?.agencyMember?.count) {
    throw Object.assign(new Error("Operational OWNER storage is required"), { code: "OWNER_SAFETY_STORAGE_REQUIRED", status: 500 });
  }
  const member = clean(memberId);
  const agency = clean(agencyId);
  const targetOperational = await db.agencyMember.count({
    where: { ...operationalOwnerWhere({ agencyId: agency }), id: member },
  });
  if (targetOperational === 0) return { operational: false, safe: true };

  const otherOwners = await db.agencyMember.count({
    where: operationalOwnerWhere({ agencyId: agency, excludeMemberId: member }),
  });
  if (otherOwners === 0) throw lastOperationalOwnerError({ agencyId: agency, memberId: member });
  return { operational: true, safe: true, otherOwners };
}

async function assertUserDisableOwnerSafety({ tx, userId } = {}) {
  if (!tx?.agencyMember?.findMany || !tx?.agencyMember?.count) {
    throw Object.assign(new Error("Operational OWNER storage is required for User lifecycle validation"), { code: "OWNER_SAFETY_STORAGE_REQUIRED", status: 500 });
  }
  const user = clean(userId);
  const ownerMemberships = await tx.agencyMember.findMany({
    where: {
      userId: user,
      deletedAt: null,
      deactivatedAt: null,
      // Retired Agencies have no current Team authority. Their owner invariant is
      // revalidated before restore, so User disable must not be blocked by history.
      agency: { is: { deletedAt: null } },
      OR: [{ roleKey: "owner" }, { role: "OWNER" }],
    },
    select: { id: true, agencyId: true },
  });

  for (const membership of ownerMemberships || []) {
    const otherOwners = await tx.agencyMember.count({
      where: operationalOwnerWhere({ agencyId: membership.agencyId, excludeMemberId: membership.id }),
    });
    if (otherOwners === 0) {
      throw lastOperationalOwnerError({ agencyId: clean(membership.agencyId), memberId: clean(membership.id), userId: user });
    }
  }
  return { safe: true, ownerMemberships: ownerMemberships || [] };
}

async function assertAgencyHasOperationalOwner({ db, agencyId, code = "AGENCY_OPERATIONAL_OWNER_REQUIRED", message = "Agency requires at least one operational OWNER" } = {}) {
  if (!db?.agencyMember?.count) {
    throw Object.assign(new Error("Operational OWNER storage is required"), { code: "OWNER_SAFETY_STORAGE_REQUIRED", status: 500 });
  }
  const agency = clean(agencyId);
  const count = await db.agencyMember.count({ where: operationalOwnerWhere({ agencyId: agency }) });
  if (count > 0) return { safe: true, ownerCount: count };
  const error = new Error(message);
  error.code = code;
  error.status = 409;
  error.details = { agencyId: agency };
  throw error;
}

async function findLiveAgenciesWithoutOperationalOwner(db, { limit = 50 } = {}) {
  const take = Math.max(1, Math.min(500, Number(limit) || 50));
  if (typeof db?.$queryRawUnsafe === "function") {
    const rows = await db.$queryRawUnsafe(`
      SELECT a."id"
        FROM "Agency" a
       WHERE a."deletedAt" IS NULL
         AND NOT EXISTS (
           SELECT 1
             FROM "AgencyMember" m
             JOIN "User" u ON u."id" = m."userId"
            WHERE m."agencyId" = a."id"
              AND m."deletedAt" IS NULL
              AND m."deactivatedAt" IS NULL
              AND u."disabledAt" IS NULL
              AND (m."roleKey" = 'owner' OR m."role" = 'OWNER')
         )
       ORDER BY a."id" ASC
       LIMIT $1
    `, take);
    return (Array.isArray(rows) ? rows : []).map((row) => clean(row.id)).filter(Boolean);
  }

  if (!db?.agency?.findMany || !db?.agencyMember?.count) {
    throw Object.assign(new Error("Operational OWNER preflight storage is required"), { code: "OWNER_SAFETY_STORAGE_REQUIRED", status: 500 });
  }
  const agencies = await db.agency.findMany({ where: { deletedAt: null }, select: { id: true }, orderBy: { id: "asc" }, take });
  const missing = [];
  for (const agency of agencies || []) {
    const count = await db.agencyMember.count({ where: operationalOwnerWhere({ agencyId: agency.id }) });
    if (count === 0) missing.push(clean(agency.id));
  }
  return missing;
}

async function assertAllLiveAgenciesHaveOperationalOwner({ db, limit = 50 } = {}) {
  const agencyIds = await findLiveAgenciesWithoutOperationalOwner(db, { limit });
  if (!agencyIds.length) return { safe: true, checked: true };
  const error = new Error("Team control-plane activation blocked: live Agency without an operational OWNER");
  error.code = "TEAM_CONTROL_PLANE_OWNER_INVARIANT_FAILED";
  error.status = 409;
  error.details = { agencyIds, truncated: agencyIds.length >= Math.max(1, Math.min(500, Number(limit) || 50)) };
  throw error;
}

module.exports = {
  operationalOwnerWhere,
  lastOperationalOwnerError,
  assertOperationalOwnerRemovalSafety,
  assertUserDisableOwnerSafety,
  assertAgencyHasOperationalOwner,
  findLiveAgenciesWithoutOperationalOwner,
  assertAllLiveAgenciesHaveOperationalOwner,
};

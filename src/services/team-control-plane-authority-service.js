"use strict";

const { lockDbAdvisoryXact } = require("./db-transaction-service");
const { lockAgencyLifecycleBarrier } = require("./agency-lifecycle-barrier-service");
const { assertTeamControlPlaneWriteAdmission } = require("./phase2-release-compatibility-authority-service");

function clean(value, max = 180) {
  const text = String(value == null ? "" : value).trim();
  return text ? text.slice(0, max) : "";
}

function teamControlPlaneTopologyLockKey(agencyId) {
  const agency = clean(agencyId);
  if (!agency) throw Object.assign(new Error("agencyId is required"), { code: "TEAM_CONTROL_TOPOLOGY_AGENCY_REQUIRED" });
  // Keep the checkpoint-11 advisory identity stable while widening its semantic
  // boundary from Creator-scope-only mutations to the whole Team control-plane.
  // This lets an older checkpoint-13 Creator retirement still serialize with a
  // newer Team topology writer during a bounded rolling overlap.
  return `phase2:creator-access-topology:${agency}`;
}

async function lockTeamControlPlaneTopology({ tx, agencyId, agencyAlreadyLocked = false, allowDeleted = false } = {}) {
  const agency = clean(agencyId);
  if (!tx || !agency) throw Object.assign(new Error("Team control-plane topology context is required"), { code: "TEAM_CONTROL_TOPOLOGY_CONTEXT_REQUIRED" });

  // M1 rolling-release admission is deliberately first. During an old/new
  // binary overlap the new C2 lock order must fail closed BEFORE acquiring any
  // Agency/Role/Creator/User/Member lock that can participate in the old graph.
  await assertTeamControlPlaneWriteAdmission(tx);

  let agencyRow = null;
  if (!agencyAlreadyLocked) {
    const barrier = await lockAgencyLifecycleBarrier({ db: tx, agencyId: agency, mode: "shared" });
    agencyRow = barrier.row;
    if (!agencyRow) throw Object.assign(new Error("Agency not found"), { code: "AGENCY_NOT_FOUND", status: 404 });
    if (!allowDeleted && agencyRow.deletedAt) throw Object.assign(new Error("Agency is no longer active"), { code: "AGENCY_RETIRED", status: 409 });
  }

  const key = teamControlPlaneTopologyLockKey(agency);
  if (typeof tx.$executeRawUnsafe === "function") {
    await lockDbAdvisoryXact({ db: tx, key, mode: "exclusive" });
  }
  return { key, agencyId: agency, agencyRow, adapter: typeof tx.$executeRawUnsafe !== "function" };
}

function normalizeCreatorIds(creatorIds) {
  const raw = Array.isArray(creatorIds) ? creatorIds : [creatorIds];
  return Array.from(new Set(raw.map((id) => clean(id)).filter(Boolean))).sort();
}

async function lockLiveTeamControlPlaneCreators({ tx, agencyId, creatorIds = [], mode = "share" } = {}) {
  const agency = clean(agencyId);
  if (!tx || !agency) throw Object.assign(new Error("Creator lock context is required"), { code: "TEAM_CONTROL_CREATOR_CONTEXT_REQUIRED" });
  const targets = normalizeCreatorIds(creatorIds);
  if (!targets.length) return { creatorIds: [], missingCreatorIds: [] };

  const write = String(mode || "share").toLowerCase() === "update";
  if (typeof tx.$queryRawUnsafe === "function") {
    const missing = [];
    for (const creatorId of targets) {
      const rows = await tx.$queryRawUnsafe(
        `SELECT "id" FROM "CreatorAccount" WHERE "id"=$1 AND "agencyId"=$2 AND "deletedAt" IS NULL ${write ? "FOR UPDATE" : "FOR SHARE"}`,
        creatorId,
        agency,
      );
      if (!Array.isArray(rows) || rows.length !== 1) missing.push(creatorId);
    }
    return { creatorIds: targets, missingCreatorIds: missing };
  }

  if (tx?.creatorAccount?.findMany) {
    const rows = await tx.creatorAccount.findMany({
      where: { agencyId: agency, deletedAt: null, id: { in: targets } },
      select: { id: true },
      take: targets.length,
    });
    const live = new Set((rows || []).map((row) => String(row.id)));
    return { creatorIds: targets, missingCreatorIds: targets.filter((id) => !live.has(id)) };
  }

  throw Object.assign(new Error("Creator storage is required for Team control-plane locking"), { code: "TEAM_CONTROL_CREATOR_STORAGE_REQUIRED", status: 500 });
}

module.exports = {
  teamControlPlaneTopologyLockKey,
  lockTeamControlPlaneTopology,
  normalizeCreatorIds,
  lockLiveTeamControlPlaneCreators,
};

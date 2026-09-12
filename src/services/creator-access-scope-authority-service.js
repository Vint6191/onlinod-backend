"use strict";

const { lockTeamControlPlaneTopology, teamControlPlaneTopologyLockKey } = require("./team-control-plane-authority-service");

function clean(value, max = 180) {
  const text = String(value == null ? "" : value).trim();
  return text ? text.slice(0, max) : "";
}

function epoch(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

function explicitScopeContainmentSql(columnSql, param) {
  return `(${columnSql} @> jsonb_build_array(${param}::text) OR ${columnSql} @> jsonb_build_object('ids',jsonb_build_array(${param}::text)) OR ${columnSql} @> jsonb_build_object('creatorIds',jsonb_build_array(${param}::text)))`;
}

function creatorAccessTopologyLockKey(agencyId) {
  return teamControlPlaneTopologyLockKey(agencyId);
}

async function lockCreatorAccessTopology({ tx, agencyId } = {}) {
  // Backward-compatible alias retained for checkpoint-13 callers/tests. The
  // underlying advisory identity is now the canonical Team control-plane fence.
  // Callers that already own the Agency lifecycle barrier may reacquire it shared
  // without changing lock order.
  return lockTeamControlPlaneTopology({ tx, agencyId, agencyAlreadyLocked: false, allowDeleted: true });
}

async function retireCreatorCurrentAccess({ tx, agencyId, creatorId } = {}) {
  const agency = clean(agencyId);
  const creator = clean(creatorId);
  if (!tx || !agency || !creator) throw Object.assign(new Error("agencyId and creatorId are required"), { code: "CREATOR_SCOPE_CONTEXT_REQUIRED" });

  if (typeof tx.$queryRawUnsafe !== "function") {
    // Test/non-Postgres fallback stays correct, though production uses indexed SQL.
    const { removeCreatorFromAssignedCreators } = require("./creator-agency-removal");
    const members = await tx.agencyMember.findMany({ where: { agencyId: agency, deletedAt: null }, select: { id: true, userId: true, assignedCreators: true, accessEpoch: true } });
    const changedMembers = [];
    for (const row of members) {
      const next = removeCreatorFromAssignedCreators(row.assignedCreators, creator);
      if (!next.changed) continue;
      const updated = await tx.agencyMember.update({ where: { id: row.id }, data: { assignedCreators: next.value, accessEpoch: { increment: 1 } } });
      changedMembers.push({ id: updated?.id || row.id, userId: updated?.userId || row.userId, accessEpoch: epoch(updated?.accessEpoch || row.accessEpoch) + (updated?.accessEpoch ? 0 : 1) });
    }
    const invitations = await tx.agencyInvitation.findMany({ where: { agencyId: agency, claimedAt: null, revokedAt: null }, select: { id: true, assignedCreators: true } });
    let changedInvitations = 0;
    for (const row of invitations) {
      const next = removeCreatorFromAssignedCreators(row.assignedCreators, creator);
      if (!next.changed) continue;
      await tx.agencyInvitation.update({ where: { id: row.id }, data: { assignedCreators: next.value } });
      changedInvitations += 1;
    }
    return { members: changedMembers, removedFromMemberAssignments: changedMembers.length, removedFromInvitationAssignments: changedInvitations };
  }

  const memberPredicate = explicitScopeContainmentSql('m."assignedCreators"', '$2');
  const memberRows = await tx.$queryRawUnsafe(
    `WITH targets AS MATERIALIZED (
       SELECT m."id"
         FROM "AgencyMember" m
        WHERE m."agencyId"=$1 AND m."deletedAt" IS NULL AND ${memberPredicate}
        ORDER BY m."id"
        FOR UPDATE
     )
     UPDATE "AgencyMember" m
        SET "assignedCreators"="phase2_remove_creator_from_access_scope"(m."assignedCreators",$2),
            "accessEpoch"=m."accessEpoch"+1,
            "updatedAt"=CURRENT_TIMESTAMP
       FROM targets t
      WHERE m."id"=t."id"
      RETURNING m."id",m."userId",m."accessEpoch"`,
    agency,
    creator,
  );

  const invitationPredicate = explicitScopeContainmentSql('i."assignedCreators"', '$2');
  const invitationRows = await tx.$queryRawUnsafe(
    `WITH targets AS MATERIALIZED (
       SELECT i."id"
         FROM "AgencyInvitation" i
        WHERE i."agencyId"=$1 AND i."claimedAt" IS NULL AND i."revokedAt" IS NULL AND ${invitationPredicate}
        ORDER BY i."id"
        FOR UPDATE
     )
     UPDATE "AgencyInvitation" i
        SET "assignedCreators"="phase2_remove_creator_from_access_scope"(i."assignedCreators",$2)
       FROM targets t
      WHERE i."id"=t."id"
      RETURNING i."id"`,
    agency,
    creator,
  );

  return {
    members: (memberRows || []).map((row) => ({ id: String(row.id), userId: row.userId ? String(row.userId) : null, accessEpoch: epoch(row.accessEpoch) })),
    removedFromMemberAssignments: Array.isArray(memberRows) ? memberRows.length : 0,
    removedFromInvitationAssignments: Array.isArray(invitationRows) ? invitationRows.length : 0,
  };
}

module.exports = { retireCreatorCurrentAccess, lockCreatorAccessTopology, creatorAccessTopologyLockKey };

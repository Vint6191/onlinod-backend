"use strict";

function rootPrisma() { return require("../prisma"); }
const { runDbTransaction } = require("./db-transaction-service");

function optionalEpoch(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function staleError(code, message) {
  return Object.assign(new Error(message), { code, status: 409 });
}

async function withHeartbeatMemberGeneration({
  db = null,
  agencyId,
  userId,
  memberId = null,
  expectedAccessEpoch = null,
  work,
}) {
  if (!agencyId || !userId || typeof work !== "function") {
    throw new TypeError("heartbeat member generation requires agencyId, userId and work");
  }
  return runDbTransaction(db || rootPrisma(), async (tx) => {
    if (typeof tx.$queryRawUnsafe === "function") {
      if (memberId) {
        await tx.$queryRawUnsafe(
          `SELECT "id" FROM "AgencyMember"
           WHERE "id"=$1 AND "agencyId"=$2 AND "userId"=$3
           FOR SHARE`,
          String(memberId), String(agencyId), String(userId),
        );
      } else {
        await tx.$queryRawUnsafe(
          `SELECT "id" FROM "AgencyMember"
           WHERE "agencyId"=$1 AND "userId"=$2
           FOR SHARE`,
          String(agencyId), String(userId),
        );
      }
    }

    const member = await tx.agencyMember.findFirst({
      where: {
        ...(memberId ? { id: String(memberId) } : {}),
        agencyId: String(agencyId),
        userId: String(userId),
        deletedAt: null,
        deactivatedAt: null,
        agency: { deletedAt: null },
      },
    });
    if (!member) throw staleError("DEVICE_HEARTBEAT_MEMBER_STALE", "Agency membership is no longer active");

    const currentAccessEpoch = optionalEpoch(member.accessEpoch);
    if (currentAccessEpoch === null) {
      throw staleError("DEVICE_HEARTBEAT_ACCESS_EPOCH_UNAVAILABLE", "Current member authorization revision is unavailable");
    }
    const expected = optionalEpoch(expectedAccessEpoch);
    if (expected !== null && currentAccessEpoch !== expected) {
      throw staleError("DEVICE_HEARTBEAT_ACCESS_EPOCH_STALE", "Member authorization changed while heartbeat was in flight");
    }

    return work({ tx, member, accessEpoch: currentAccessEpoch });
  });
}

module.exports = { withHeartbeatMemberGeneration };

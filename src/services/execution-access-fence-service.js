"use strict";

const { canAccessCreator } = require("../middleware/automation-permissions");

class ExecutionAccessFenceError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = "ExecutionAccessFenceError";
    this.code = code;
    this.status = status;
  }
}

function int(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

async function loadMember({ db, userId, agencyId, memberId, lock = false }) {
  const client = db || require("../prisma");
  if (lock && typeof client.$queryRawUnsafe === "function") {
    const rows = await client.$queryRawUnsafe(
      `SELECT "id", "userId", "agencyId", "role", "roleKey", "permissions", "assignedCreators", "accessEpoch", "deletedAt", "deactivatedAt"
         FROM "AgencyMember"
        WHERE "id" = $1 AND "userId" = $2 AND "agencyId" = $3
        FOR SHARE`,
      memberId, userId, agencyId,
    );
    return Array.isArray(rows) ? rows[0] || null : null;
  }
  return client.agencyMember.findFirst({
    where: { id: memberId, userId, agencyId, deletedAt: null, deactivatedAt: null, agency: { deletedAt: null } },
  });
}

async function assertExecutionAccessFence(input) {
  const memberId = String(input.memberId || "").trim();
  const creatorId = String(input.creatorId || "").trim();
  const agencyId = String(input.agencyId || "").trim();
  const userId = String(input.userId || "").trim();
  const accessEpoch = int(input.accessEpoch, -1);
  if (!memberId || !creatorId || !agencyId || !userId || accessEpoch < 0) {
    throw new ExecutionAccessFenceError("EXECUTION_ACCESS_FENCE_MISSING", "Execution lease has no access fence", 409);
  }
  const db = input.db || require("../prisma");
  const member = await loadMember({ db, userId, agencyId, memberId, lock: input.lock === true });
  if (!member || member.deletedAt || member.deactivatedAt) {
    throw new ExecutionAccessFenceError("EXECUTION_ACCESS_REVOKED", "Agency membership is no longer active", 403);
  }
  if (int(member.accessEpoch, 1) !== accessEpoch) {
    throw new ExecutionAccessFenceError("EXECUTION_ACCESS_EPOCH_STALE", "Execution lease access epoch is stale", 409);
  }
  if (!canAccessCreator(member, creatorId)) {
    throw new ExecutionAccessFenceError("EXECUTION_CREATOR_ACCESS_REVOKED", "Creator access was revoked after lease claim", 403);
  }
  const creator = await db.creatorAccount.findFirst({
    where: { id: creatorId, agencyId, deletedAt: null },
    select: { id: true, status: true },
  });
  if (!creator) throw new ExecutionAccessFenceError("EXECUTION_CREATOR_NOT_FOUND", "Creator no longer exists", 404);
  if (creator.status !== "READY") {
    throw new ExecutionAccessFenceError("EXECUTION_CREATOR_NOT_READY", "Creator is not ready for execution", 409);
  }
  return { member, creator, accessEpoch };
}

module.exports = { ExecutionAccessFenceError, assertExecutionAccessFence };

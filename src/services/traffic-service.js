"use strict";
const prisma = require("../prisma");
const { canUsePermission, resolveEffectivePermissions } = require("./team-access-control");
const { requireCreatorAccess } = require("../middleware/automation-permissions");
const { isCommitTransaction } = require("./db-commit-kernel");
const { projectCanonicalSubscriptionReceipt: projectCanonicalSubscriptionCompatibility } = require("./subscription-receipt-projection-service");
const readers = require("./traffic-read-service");
const fail = (code, status = 409) => Object.assign(new Error(code), { code, status });
async function assertTrafficViewer({ userId, creatorId, db = prisma }) {
  const creator = await db.creatorAccount.findUnique({ where: { id: creatorId } });
  if (!creator || creator.deletedAt) {
    const err = new Error("Creator not found");
    err.code = "CREATOR_NOT_FOUND";
    err.status = 404;
    throw err;
  }

  const member = await db.agencyMember.findFirst({
    where: { userId, agencyId: creator.agencyId, deletedAt: null, deactivatedAt: null, agency: { deletedAt: null } },
  });
  if (!member) {
    const err = new Error("Not a member of this agency");
    err.code = "NOT_A_MEMBER";
    err.status = 403;
    throw err;
  }

  await requireCreatorAccess({ agencyId: creator.agencyId, member, creatorId: creator.id, db });
  const effectivePermissions = await resolveEffectivePermissions({ member, db });
  const effectiveMember = { ...member, permissions: effectivePermissions };
  if (!(await canUsePermission({ member: effectiveMember, key: "traffic.view", db }))) {
    const err = new Error("Traffic analytics permission is required");
    err.code = "TRAFFIC_VIEW_FORBIDDEN";
    err.status = 403;
    throw err;
  }

  return { creator, member: effectiveMember };
}


async function markTrafficFanValueDirty({ db = prisma, agencyId, creatorId, fanId, occurredAt = null, reason = null }) {
  if (!agencyId || !creatorId || !fanId) throw fail("BAD_TRAFFIC_DIRTY_INPUT", 400);
  if (!isCommitTransaction(db)) throw fail("TRAFFIC_DIRTY_COMMIT_REQUIRED");
  await db.$executeRawUnsafe('SELECT "onlinod_traffic_dirty_fan_v2"($1,$2,$3)', agencyId, creatorId, String(fanId));
  const when = occurredAt ? new Date(occurredAt) : new Date();
  if (!Number.isFinite(when.getTime())) throw fail("TRAFFIC_DIRTY_DATE_INVALID", 400);
  await db.$executeRawUnsafe('UPDATE "TrafficFanProjection" SET "lastRevenueAt"=GREATEST("lastRevenueAt",$4::timestamp),"updatedAt"=CURRENT_TIMESTAMP WHERE "agencyId"=$1 AND "creatorId"=$2 AND "fanId"=$3', agencyId, creatorId, String(fanId), when);
  return { ok: true, queued: true, fanId: String(fanId), reason };
}
async function scheduleTrafficRefresh({ db = prisma, userId, creatorId }) {
  // This command is reached through operation.control, which holds current
  // lifecycle, member, permission and creator locks and has a replay receipt.
  if (!isCommitTransaction(db)) throw fail("MANAGEMENT_COMMAND_REQUIRED", 410);
  const { creator, member } = await assertTrafficViewer({ db, userId, creatorId });
  if (!await canUsePermission({ db, member, key: "traffic.refresh" })) throw fail("TRAFFIC_REFRESH_FORBIDDEN", 403);
  const result = await require("./campaign-scan-control-service").startManualCampaignScan({ db, creator, requestedByUserId: userId });
  return { ok: true, ...result, jobId: result.job?.id || null, providerAuthority: "CAMPAIGNS" };
}
module.exports = { assertTrafficViewer, markTrafficFanValueDirty, projectCanonicalSubscriptionCompatibility, scheduleTrafficRefresh,
  getTrafficOverview: input => readers.getTrafficOverview({ db: prisma, ...input }),
  getTrafficSourceMembers: input => readers.getTrafficSourceMembers({ db: prisma, ...input }) };

"use strict";

const { runRootCommit } = require("./db-commit-kernel");
const { requireCreatorAccess } = require("../middleware/automation-permissions");
const { resolveEffectivePermissions, canUsePermission } = require("./team-access-control");
const denied = code => Object.assign(new Error(code), { code, status: 403 });

async function resolveAnalyticsViewer({ db, userId, creatorId, member: expected = null, permission }) {
  const creator = await db.creatorAccount.findUnique({ where: { id: creatorId } });
  if (!creator || creator.deletedAt) throw Object.assign(new Error("CREATOR_NOT_FOUND"), { code: "CREATOR_NOT_FOUND", status: 404 });
  if (!userId || (expected && (expected.userId !== userId || expected.agencyId !== creator.agencyId))) throw denied("ANALYTICS_ACCESS_CHANGED");
  const member = await db.agencyMember.findFirst({ where: {
    userId, agencyId: creator.agencyId, deletedAt: null, deactivatedAt: null,
    agency: { deletedAt: null }, user: { disabledAt: null },
    ...(expected ? { id: expected.id, accessEpoch: expected.accessEpoch } : {}),
  } });
  if (!member) throw denied("ANALYTICS_ACCESS_CHANGED");
  await requireCreatorAccess({ db, agencyId: creator.agencyId, member, creatorId });
  const effective = { ...member, permissions: await resolveEffectivePermissions({ db, member }) };
  if (!await canUsePermission({ db, member: effective, key: permission })) throw denied("FEATURE_FORBIDDEN");
  return { creator, member: effective };
}

async function readWithAnalyticsViewer(input, read) {
  const { db } = input;
  const result = await runRootCommit(db, async ({ tx }) => {
    const viewer = await resolveAnalyticsViewer({ ...input, db: tx });
    const value = await read({ db: tx, ...viewer });
    return { value, member: viewer.member };
  }, { profile: "COMMAND", isolationLevel: "RepeatableRead", authority: {
    kind: "ANALYTICS_VIEWER_READ", creatorId: input.creatorId, userId: input.userId,
  } });
  // Re-check on the root AFTER the read snapshot ends. Re-reading inside a
  // REPEATABLE READ snapshot cannot observe a concurrently disabled user,
  // retired scope or changed epoch and would falsely certify the old payload.
  await resolveAnalyticsViewer({ ...input, member: result.member });
  return result.value;
}

module.exports = { resolveAnalyticsViewer, readWithAnalyticsViewer };

"use strict";
const { runRootCommit } = require("./db-commit-kernel");
const { requireCreatorAccess } = require("../middleware/automation-permissions");
const denied = () => Object.assign(new Error("ENTITY_CHANGE_ACCESS_CHANGED"), { code: "ENTITY_CHANGE_ACCESS_CHANGED", status: 403 });

async function resolveViewer({ db, agencyId, creatorId, userId, member: expected }) {
  if (!userId || !expected || expected.userId !== userId || expected.agencyId !== agencyId) throw denied();
  const member = await db.agencyMember.findFirst({ where: { id: expected.id, userId, agencyId,
    accessEpoch: expected.accessEpoch, deletedAt: null, deactivatedAt: null,
    agency: { deletedAt: null }, user: { disabledAt: null } } });
  if (!member) throw denied();
  const creator = await requireCreatorAccess({ db, agencyId, member, creatorId });
  return { member, creator };
}

async function readWithEntityViewer(input, read) {
  const result = await runRootCommit(input.db, async ({ tx }) => {
    const viewer = await resolveViewer({ ...input, db: tx });
    try { return { value: await read({ db: tx, ...viewer }), member: viewer.member }; }
    catch (error) {
      // Retention metadata is scoped data too; do not return a stale creator's
      // head merely because the successful response became a reconcile error.
      if (error?.code !== "RECONCILE_REQUIRED") throw error;
      return { error, member: viewer.member };
    }
  }, { profile: "COMMAND", isolationLevel: "RepeatableRead", authority: {
    kind: "CREATOR_ENTITY_READ", agencyId: input.agencyId, creatorId: input.creatorId, userId: input.userId,
  } });
  // A snapshot cannot see a concurrent revocation. Recheck after it closes,
  // before any creator identity or mandatory correction is returned.
  await resolveViewer({ ...input, member: result.member });
  if (result.error) throw result.error;
  return result.value;
}
module.exports = { resolveViewer, readWithEntityViewer };

"use strict";

const { lockDbAdvisoryXact } = require("./db-transaction-service");
const { lockBillingWriteAdmission } = require("./billing-write-admission-service");
const { lockAutomationWriteCommitFence } = require("./automation-write-commit-fence-service");

function failure(code) { return Object.assign(new Error(code), { code, status: 409 }); }

// A delivery is a historical receipt; it may finish after its workflow has
// advanced. Only its exact generation may project into the live candidate.
function sfsCandidateWhere(delivery, { includeCompleted = false } = {}) {
  return {
    id: typeof delivery?.payload?.candidateId === "string" ? delivery.payload.candidateId.trim().slice(0,160) : "",
    agencyId: delivery?.agencyId || "", creatorId: delivery?.creatorId || "",
    generation: Number.isSafeInteger(delivery?.generation) ? delivery.generation : -1,
    ...(includeCompleted ? {} : { completedAt: null, state: { not: "COMPLETED" } }),
  };
}

// Reuse the existing creator control fence. Lifecycle and billing precede the
// creator row; the creator fence precedes candidate, member, job and delivery.
// Workspace control holds the same fence exclusively and projects failures in
// that transaction without reacquiring creator row locks after business rows.
async function lockSfsScope(db,{agencyId,creatorId}) {
  if (!db?.$queryRawUnsafe || typeof db.$transaction === "function") throw failure("SFS_MUTATION_TRANSACTION_REQUIRED");
  if (!agencyId || !creatorId) throw failure("SFS_MUTATION_SCOPE_REQUIRED");
  await lockBillingWriteAdmission({db,agencyId});
  const rows = await db.$queryRawUnsafe('SELECT "id","agencyId","remoteId","deletedAt" FROM "CreatorAccount" WHERE "id"=$1 AND "agencyId"=$2 FOR SHARE',creatorId,agencyId);
  await lockAutomationWriteCommitFence({db,agencyId,creatorId});
  return rows[0] || null;
}

// Settlement takes candidate rows before delivery rows. Control projection is
// serialized by the enclosing creator/workspace fence, which must already be held.
async function lockSfsCandidateBatch(db, deliveries, { allowMissing = false } = {}) {
  if (!Array.isArray(deliveries) || deliveries.length > 500) throw failure("SFS_MUTATION_BATCH_INVALID");
  const rows = deliveries.filter(d => d?.moduleKey === "sfs");
  if (!rows.length) return;
  if (!db?.$queryRawUnsafe || typeof db.$transaction === "function") throw failure("SFS_MUTATION_TRANSACTION_REQUIRED");
  const scopes = new Map();
  for (const row of rows) {
    const id = row.payload?.candidateId;
    if (typeof id !== "string" || !id || !row.agencyId || !row.creatorId) {
      if (allowMissing) continue;
      throw failure("SFS_MUTATION_CANDIDATE_REQUIRED");
    }
    const prior = scopes.get(id);
    if (prior && (prior.agencyId !== row.agencyId || prior.creatorId !== row.creatorId)) throw failure("SFS_MUTATION_SCOPE_CONFLICT");
    scopes.set(id, { id, agencyId: row.agencyId, creatorId: row.creatorId });
  }
  if (!scopes.size) return;
  const found = await db.$queryRawUnsafe(`SELECT k."id",k."agencyId",k."creatorId",k."targetUserId" FROM "SfsTargetCandidate" k
    JOIN jsonb_to_recordset($1::jsonb) AS s(id text,"agencyId" text,"creatorId" text)
      ON k."id"=s.id AND k."agencyId"=s."agencyId" AND k."creatorId"=s."creatorId"
    ORDER BY k."id" FOR UPDATE OF k`, JSON.stringify([...scopes.values()]));
  if (!allowMissing && found.length !== scopes.size) throw failure("PHASE7_SFS_OWNER_UNPROVEN");
  const byId = new Map(found.map(k => [k.id,k]));
  for (const row of rows) if (row.actionType === 'SFS_UNFOLLOW_TARGET' && row.payload?.legacyMigration === true) {
    const candidate = byId.get(row.payload.candidateId);
    if (!candidate || candidate.targetUserId !== row.targetId || row.fanId !== row.targetId) throw failure("PHASE7_SFS_OWNER_UNPROVEN");
  }
}

async function lockSfsDeliveryMutation(db, delivery) {
  if (delivery?.moduleKey !== "sfs") return;
  await lockSfsScope(db,delivery);
  if (delivery.actionType === "SFS_UNFOLLOW_TARGET" && delivery.payload?.legacyMigration === true) {
    await lockDbAdvisoryXact({ db, key: `p14:sfs-target:${delivery.agencyId}:${delivery.creatorId}:${delivery.targetId}` });
  }
  // Current malformed/orphaned queue rows still need their normal invalid_target
  // transition. Only legacy obligations require a proven candidate before any
  // mutation; current projections are always constrained to agency + creator.
  await lockSfsCandidateBatch(db,[delivery], { allowMissing: !(delivery.actionType === "SFS_UNFOLLOW_TARGET" && delivery.payload?.legacyMigration === true) });
}
async function lockSfsJobMutation(db,job) {
  if (['sfs_target_discovery','sfs_target_scan'].includes(job?.jobKey)) await lockSfsScope(db,job);
}
module.exports = { lockSfsScope, lockSfsCandidateBatch, lockSfsDeliveryMutation, lockSfsJobMutation, sfsCandidateWhere };

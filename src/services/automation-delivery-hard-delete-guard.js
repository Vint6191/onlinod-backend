"use strict";

const { hasMassCurrentDebt } = require("./mass-delivery-contract");
const cleanupContract = require("./phase7-cleanup-contract");

const SFS_MODULE_KEY = "sfs";
const SFS_FOLLOW_TARGET_ACTION_TYPE = "SFS_FOLLOW_TARGET";

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function clean(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function isSfsFollowProof(row) {
  return row?.moduleKey === SFS_MODULE_KEY && row?.actionType === SFS_FOLLOW_TARGET_ACTION_TYPE;
}

function sfsCandidateId(row) {
  return clean(object(row?.payload).candidateId);
}

function candidateNoLongerNeedsFollowProof(candidate, row) {
  if (!candidate) return true;
  if (candidate.completedAt || candidate.state === "COMPLETED") return true;
  if (candidate.usedForever === true && object(candidate.metadata).legacyMigration !== true) return true;

  const metadata = object(candidate.metadata);
  if (metadata.legacyMigration === true) return false; // Requires the same scoped attestation as cleanup admission.
  if (Number(candidate.generation) !== Number(row?.generation)) return true;

  // Current-generation cleanup carries the same proof in both the candidate and
  // the cleanup delivery. createSafetyUnfollow writes the cleanup first and the
  // candidate metadata second in the delivery settlement transaction, so this
  // marker is monotonic and means the original FOLLOW receipt is no longer a
  // runtime dependency.
  return metadata.followEffectOwnership === "OWNED"
    && clean(metadata.followEffectDeliveryId) === clean(row?.id);
}

/**
 * Partition already-bounded hard-delete candidates without scanning the
 * delivery table.  Only the intermediate pre-INT4.3C SFS generation needs its
 * completed FOLLOW receipt while an old cleanup remains active.  Current SFS
 * embeds proof in the cleanup/candidate; legacy cleanup requires an immutable scoped attestation.
 *
 * Unknown/malformed SFS proof rows fail closed.  Current MASS debt is always retained, including legacy NULL remote lifecycle.
 * Other delivery classes retain their own lifecycle guards.
 */
async function partitionAutomationDeliveryHardDeleteCandidates({ db, rows = [] } = {}) {
  const all = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const massProtected = all.filter(hasMassCurrentDebt);
  const remaining = all.filter((row) => !hasMassCurrentDebt(row));
  const legacyCleanup = remaining.filter(cleanupContract.isLegacyCleanup);
  const receipts = legacyCleanup.length && db?.phase7RetirementProof?.findMany
    ? await db.phase7RetirementProof.findMany({where:{sourceTable:'AutomationDelivery',kind:'SETTLED',deliveryId:{in:legacyCleanup.map(d=>d.id)}},take:500}) : [];
  const settlement = new Map(receipts.map(p=>[p.deliveryId,p]));
  const protectedCleanup = legacyCleanup.filter(d=>!cleanupContract.isSettledCleanup(d)||!cleanupContract.matchesSettlementProof(settlement.get(d.id),d));
  const blockedIds = new Set(protectedCleanup.map(d=>d.id));
  const input = remaining.filter(d=>!blockedIds.has(d.id));
  massProtected.push(...protectedCleanup);
  const relevant = input.filter(isSfsFollowProof);
  if (!relevant.length) return { deletable: input, protected: massProtected };

  if (!db?.sfsTargetCandidate?.findMany) {
    return {
      deletable: input.filter((row) => !isSfsFollowProof(row)),
      protected: [...massProtected, ...relevant],
    };
  }

  const candidateIds = [...new Set(relevant.map(sfsCandidateId).filter(Boolean))];
  const candidates = candidateIds.length
    ? await db.sfsTargetCandidate.findMany({
        where: { id: { in: candidateIds } },
        select: {
          id: true,
          generation: true,
          state: true,
          usedForever: true,
          completedAt: true,
          metadata: true,
          agencyId: true, creatorId: true, targetUserId: true, safetyUnfollowDeliveryId: true,
        },
      })
    : [];
  const byId = new Map((candidates || []).map((candidate) => [candidate.id, candidate]));

  const attested=await require("./phase7-legacy-storage-service").attestedCleanupCandidates(db,candidates.filter(c=>object(c.metadata).legacyMigration===true));
  const deletable = [];
  const protectedRows = [...massProtected];
  for (const row of input) {
    if (!isSfsFollowProof(row)) {
      deletable.push(row);
      continue;
    }
    const candidateId = sfsCandidateId(row);
    // A malformed historical SFS row cannot prove that no cleanup depends on
    // it, so keep it. A valid id with no candidate has no live SFS consumer.
    if (!candidateId) {
      protectedRows.push(row);
      continue;
    }
    const candidate = byId.get(candidateId);
    let safe = candidateNoLongerNeedsFollowProof(candidate, row);
    if (!safe && attested.has(candidateId)) safe=true;
    if (safe) deletable.push(row); else protectedRows.push(row);
  }
  return { deletable, protected: protectedRows };
}

module.exports = {
  isSfsFollowProof,
  sfsCandidateId,
  candidateNoLongerNeedsFollowProof,
  partitionAutomationDeliveryHardDeleteCandidates,
};

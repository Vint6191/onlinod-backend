"use strict";

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
  if (candidate.completedAt || candidate.state === "COMPLETED" || candidate.usedForever === true) return true;

  const metadata = object(candidate.metadata);
  if (metadata.legacyMigration === true) return true;
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
 * embeds proof in the cleanup/candidate; P14 legacy cleanup is self-adopted.
 *
 * Unknown/malformed SFS proof rows fail closed.  Every other delivery class is
 * passed through; its own lifecycle guards remain the caller's responsibility.
 */
async function partitionAutomationDeliveryHardDeleteCandidates({ db, rows = [] } = {}) {
  const input = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const relevant = input.filter(isSfsFollowProof);
  if (!relevant.length) return { deletable: input, protected: [] };

  if (!db?.sfsTargetCandidate?.findMany) {
    return {
      deletable: input.filter((row) => !isSfsFollowProof(row)),
      protected: relevant,
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
        },
      })
    : [];
  const byId = new Map((candidates || []).map((candidate) => [candidate.id, candidate]));

  const deletable = [];
  const protectedRows = [];
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
    if (candidateNoLongerNeedsFollowProof(byId.get(candidateId), row)) deletable.push(row);
    else protectedRows.push(row);
  }
  return { deletable, protected: protectedRows };
}

module.exports = {
  isSfsFollowProof,
  sfsCandidateId,
  candidateNoLongerNeedsFollowProof,
  partitionAutomationDeliveryHardDeleteCandidates,
};

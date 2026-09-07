"use strict";

const ACTIVE_MASS_WRITE_STATUSES = ["QUEUED", "CLAIMED", "RUNNING", "COMMITTING", "RECONCILE_REQUIRED", "RETRY_SCHEDULED", "PAUSED"];
const REMOTE_BLOCKING_STATES = ["PENDING", "MIGRATION_RECONCILE_REQUIRED", "UNKNOWN"];
const MASS_CREATE_ACTIONS = ["MASS_QUEUE_CREATE", "MASS_NATIVE_QUEUE_CREATE", "MASS_PROVIDER_QUEUE_OBSERVED"];
const MASS_CANCEL_ACTIONS = ["MASS_QUEUE_CANCEL", "MASS_NATIVE_QUEUE_CANCEL"];
const MASS_PROVIDER_SNAPSHOT_PROOF_ACTION = "MASS_PROVIDER_SNAPSHOT_PROOF";
const MASS_PROVIDER_SNAPSHOT_PROOF_MAX_AGE_MS = 2 * 60_000;
const MASS_RETIREMENT_SNAPSHOT_PURPOSE = "RETIREMENT";

const MASS_PROVIDER_STATE_ACTIONS = [...new Set([...MASS_CREATE_ACTIONS, ...MASS_CANCEL_ACTIONS, MASS_PROVIDER_SNAPSHOT_PROOF_ACTION])];

function proofSnapshotEmpty(proof) {
  return Number(proof?.result?.snapshotItemCount) === 0;
}

function dateAfter(value, threshold) {
  return value instanceof Date && threshold instanceof Date && value > threshold;
}

async function creatorMassProviderStateAdvancedAfterProof({ db, agencyId, creatorId, proof }) {
  const proofAt = proof?.remoteLifecycleObservedAt instanceof Date ? proof.remoteLifecycleObservedAt : null;
  if (!proofAt) return true;
  const later = await db.automationDelivery.findFirst({
    where: {
      agencyId, creatorId, id: { not: proof.id }, actionType: { in: MASS_PROVIDER_STATE_ACTIONS },
      OR: [
        { remoteLifecycleObservedAt: { gt: proofAt } },
        { actionType: { in: [...MASS_CREATE_ACTIONS, ...MASS_CANCEL_ACTIONS] }, writeCommitAt: { gt: proofAt } },
      ],
    },
    select: { id: true },
  });
  return Boolean(later);
}

class MassCampaignAuthorityError extends Error {
  constructor(code, message, status = 409, details = null) {
    super(message); this.name = "MassCampaignAuthorityError"; this.code = code; this.status = status; this.details = details;
  }
}

async function creatorMassCampaignBlockers({ db, agencyId, creatorId }) {
  const [activeCreates, unresolvedCreates, remoteQueues, activeCancels] = await Promise.all([
    db.automationDelivery.count({ where: { agencyId, creatorId, actionType: { in: MASS_CREATE_ACTIONS }, status: { in: ACTIVE_MASS_WRITE_STATUSES } } }),
    db.automationDelivery.count({ where: {
      agencyId, creatorId, actionType: { in: MASS_CREATE_ACTIONS }, status: "FAILED", failureCode: "outcome_unresolved_do_not_retry",
      OR: [{ remoteLifecycleState: null }, { remoteLifecycleState: { not: "SETTLED" } }],
    } }),
    db.automationDelivery.count({ where: { agencyId, creatorId, actionType: { in: MASS_CREATE_ACTIONS }, remoteLifecycleState: { in: REMOTE_BLOCKING_STATES } } }),
    db.automationDelivery.count({ where: {
      agencyId, creatorId, actionType: { in: MASS_CANCEL_ACTIONS },
      OR: [
        { status: { in: ACTIVE_MASS_WRITE_STATUSES } },
        { status: "FAILED", failureCode: "outcome_unresolved_do_not_retry" },
      ],
    } }),
  ]);
  return { activeCreates, unresolvedCreates, remoteQueues, activeCancels, total: activeCreates + unresolvedCreates + remoteQueues + activeCancels };
}

async function agencyMassCampaignBlockers({ db, agencyId }) {
  const [activeCreates, unresolvedCreates, remoteQueues, activeCancels] = await Promise.all([
    db.automationDelivery.count({ where: { agencyId, actionType: { in: MASS_CREATE_ACTIONS }, status: { in: ACTIVE_MASS_WRITE_STATUSES } } }),
    db.automationDelivery.count({ where: {
      agencyId, actionType: { in: MASS_CREATE_ACTIONS }, status: "FAILED", failureCode: "outcome_unresolved_do_not_retry",
      OR: [{ remoteLifecycleState: null }, { remoteLifecycleState: { not: "SETTLED" } }],
    } }),
    db.automationDelivery.count({ where: { agencyId, actionType: { in: MASS_CREATE_ACTIONS }, remoteLifecycleState: { in: REMOTE_BLOCKING_STATES } } }),
    db.automationDelivery.count({ where: {
      agencyId, actionType: { in: MASS_CANCEL_ACTIONS },
      OR: [
        { status: { in: ACTIVE_MASS_WRITE_STATUSES } },
        { status: "FAILED", failureCode: "outcome_unresolved_do_not_retry" },
      ],
    } }),
  ]);
  return { activeCreates, unresolvedCreates, remoteQueues, activeCancels, total: activeCreates + unresolvedCreates + remoteQueues + activeCancels };
}

function freshSnapshotThreshold(now = new Date()) {
  return new Date(now.getTime() - MASS_PROVIDER_SNAPSHOT_PROOF_MAX_AGE_MS);
}

function massProviderSnapshotProofKey(agencyIdInput, creatorIdInput, purposeInput = MASS_RETIREMENT_SNAPSHOT_PURPOSE) {
  const agencyId = String(agencyIdInput || "").trim();
  const creatorId = String(creatorIdInput || "").trim();
  const purpose = String(purposeInput || "").trim().toUpperCase();
  if (!agencyId || !creatorId || !["BROWSE", MASS_RETIREMENT_SNAPSHOT_PURPOSE].includes(purpose)) return null;
  return `mass-provider-snapshot-proof:${agencyId}:${creatorId}:${purpose}`;
}


async function invalidateCreatorMassProviderRetirementProof({ db, agencyId, creatorId, reason = "mass provider state advanced", now = new Date() }) {
  const idempotencyKey = massProviderSnapshotProofKey(agencyId, creatorId, MASS_RETIREMENT_SNAPSHOT_PURPOSE);
  if (!idempotencyKey) return { count: 0 };
  return db.automationDelivery.updateMany({
    where: {
      agencyId, creatorId, idempotencyKey, actionType: MASS_PROVIDER_SNAPSHOT_PROOF_ACTION, status: "COMPLETED",
    },
    data: {
      status: "CANCELED",
      failureCode: "mass_provider_snapshot_stale",
      failureCategory: "TERMINAL",
      lastError: String(reason || "mass provider state advanced").slice(0, 1000),
      result: {
        outcomeState: "PROVIDER_SNAPSHOT_STALE",
        purpose: MASS_RETIREMENT_SNAPSHOT_PURPOSE,
        invalidatedAt: now.toISOString(),
        invalidatedReason: String(reason || "mass provider state advanced").slice(0, 500),
      },
      finishedAt: now,
      lastCheckedAt: now,
    },
  });
}

async function creatorHasProviderIdentity({ db, agencyId, creatorId }) {
  const creator = await db.creatorAccount.findFirst({
    where: { id: creatorId, agencyId },
    select: { id: true, remoteId: true },
  });
  return Boolean(String(creator?.remoteId || "").trim());
}

async function creatorMassProviderSnapshotProof({ db, agencyId, creatorId, now = new Date() }) {
  const idempotencyKey = massProviderSnapshotProofKey(agencyId, creatorId, MASS_RETIREMENT_SNAPSHOT_PURPOSE);
  if (!idempotencyKey) return null;
  const proof = await db.automationDelivery.findUnique({ where: { idempotencyKey } });
  if (!proof || proof.agencyId !== agencyId || proof.creatorId !== creatorId
      || proof.actionType !== MASS_PROVIDER_SNAPSHOT_PROOF_ACTION || proof.status !== "COMPLETED"
      || !(proof.remoteLifecycleObservedAt instanceof Date) || proof.remoteLifecycleObservedAt <= freshSnapshotThreshold(now)
      || String(proof?.result?.purpose || "").toUpperCase() !== MASS_RETIREMENT_SNAPSHOT_PURPOSE
      || !proofSnapshotEmpty(proof)) {
    return null;
  }
  if (await creatorMassProviderStateAdvancedAfterProof({ db, agencyId, creatorId, proof })) return null;
  return proof;
}

async function assertCreatorMassCampaignRetirable(input) {
  const blockers = await creatorMassCampaignBlockers(input);
  if (blockers.total > 0) throw new MassCampaignAuthorityError("CREATOR_HAS_ACTIVE_MASS", "Resolve active/unknown MASS writes and pending native OnlyFans queues before removing this creator", 409, blockers);
  if (input.requireFreshProviderSnapshot !== false && await creatorHasProviderIdentity(input)) {
    const proof = await creatorMassProviderSnapshotProof(input);
    if (!proof) {
      throw new MassCampaignAuthorityError(
        "CREATOR_MASS_PROVIDER_SNAPSHOT_REQUIRED",
        "Refresh this creator's complete OnlyFans MASS queue immediately before removal so provider-side queues cannot be orphaned",
        409,
        { ...blockers, snapshotMaxAgeMs: MASS_PROVIDER_SNAPSHOT_PROOF_MAX_AGE_MS },
      );
    }
    return { ...blockers, providerSnapshotObservedAt: proof.remoteLifecycleObservedAt };
  }
  return blockers;
}

async function assertAgencyMassCampaignRetirable(input) {
  const blockers = await agencyMassCampaignBlockers(input);
  if (blockers.total > 0) throw new MassCampaignAuthorityError("AGENCY_HAS_ACTIVE_MASS", "Resolve active/unknown MASS writes and pending native OnlyFans queues before removing this agency", 409, blockers);
  if (input.requireFreshProviderSnapshot !== false) {
    const creators = await input.db.creatorAccount.findMany({
      where: { agencyId: input.agencyId, deletedAt: null, remoteId: { not: null } },
      select: { id: true },
    });
    if (creators.length) {
      const freshProofs = await input.db.automationDelivery.findMany({
        where: {
          agencyId: input.agencyId, actionType: MASS_PROVIDER_SNAPSHOT_PROOF_ACTION, status: "COMPLETED",
          remoteLifecycleObservedAt: { gt: freshSnapshotThreshold(input.now || new Date()) },
        },
        select: { creatorId: true, idempotencyKey: true, remoteLifecycleObservedAt: true, result: true },
      });
      const threshold = freshSnapshotThreshold(input.now || new Date());
      const recentProviderState = await input.db.automationDelivery.findMany({
        where: {
          agencyId: input.agencyId, actionType: { in: MASS_PROVIDER_STATE_ACTIONS },
          OR: [
            { remoteLifecycleObservedAt: { gt: threshold } },
            { actionType: { in: [...MASS_CREATE_ACTIONS, ...MASS_CANCEL_ACTIONS] }, writeCommitAt: { gt: threshold } },
          ],
        },
        select: { id: true, creatorId: true, actionType: true, remoteLifecycleObservedAt: true, writeCommitAt: true },
      });
      const proven = new Set(freshProofs
        .filter((row) => String(row?.result?.purpose || "").toUpperCase() === MASS_RETIREMENT_SNAPSHOT_PURPOSE
          && String(row.idempotencyKey || "") === String(massProviderSnapshotProofKey(input.agencyId, row.creatorId, MASS_RETIREMENT_SNAPSHOT_PURPOSE) || "")
          && proofSnapshotEmpty(row)
          && !recentProviderState.some((activity) => String(activity.creatorId || "") === String(row.creatorId || "")
            && String(activity.id || "") !== String(row.id || "")
            && (dateAfter(activity.remoteLifecycleObservedAt, row.remoteLifecycleObservedAt) || dateAfter(activity.writeCommitAt, row.remoteLifecycleObservedAt))))
        .map((row) => String(row.creatorId || ""))
        .filter(Boolean));
      const missingCreatorIds = creators.map((row) => String(row.id || "")).filter((id) => id && !proven.has(id));
      if (missingCreatorIds.length) {
        throw new MassCampaignAuthorityError(
          "AGENCY_MASS_PROVIDER_SNAPSHOT_REQUIRED",
          "Refresh the complete OnlyFans MASS queue for every live creator immediately before removing this agency",
          409,
          { ...blockers, snapshotMaxAgeMs: MASS_PROVIDER_SNAPSHOT_PROOF_MAX_AGE_MS, missingCreatorIds },
        );
      }
    }
  }
  return blockers;
}

module.exports = {
  ACTIVE_MASS_WRITE_STATUSES,
  REMOTE_BLOCKING_STATES,
  MASS_CREATE_ACTIONS,
  MASS_CANCEL_ACTIONS,
  MASS_PROVIDER_SNAPSHOT_PROOF_ACTION,
  MASS_PROVIDER_SNAPSHOT_PROOF_MAX_AGE_MS,
  MASS_RETIREMENT_SNAPSHOT_PURPOSE,
  massProviderSnapshotProofKey,
  invalidateCreatorMassProviderRetirementProof,
  MassCampaignAuthorityError,
  creatorMassCampaignBlockers,
  agencyMassCampaignBlockers,
  creatorHasProviderIdentity,
  creatorMassProviderSnapshotProof,
  assertCreatorMassCampaignRetirable,
  assertAgencyMassCampaignRetirable,
};

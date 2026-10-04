"use strict";
const { ACTIVE, CREATE_ACTIONS, CANCEL_ACTIONS, CURRENT_PREDICATE, RETIREMENT_ACCEPT_MS, error } = require("./mass-delivery-contract");

async function blockers({ db, agencyId, creatorId = null }) {
  const rows = await db.$queryRawUnsafe(`SELECT "actionType","status","failureCode","remoteLifecycleState",count(*)::int AS n
    FROM "AutomationDelivery" WHERE ${CURRENT_PREDICATE} AND "agencyId"=$1 ${creatorId ? 'AND "creatorId"=$2' : ''}
    GROUP BY "actionType","status","failureCode","remoteLifecycleState"`, ...[agencyId, ...(creatorId ? [creatorId] : [])]);
  const out = { activeCreates: 0, unresolvedCreates: 0, remoteQueues: 0, activeCancels: 0, total: 0 };
  for (const row of rows) {
    out.total += row.n;
    if (CANCEL_ACTIONS.includes(row.actionType)) out.activeCancels += row.n;
    else if (ACTIVE.includes(row.status)) out.activeCreates += row.n;
    else if (row.status === "FAILED" && row.failureCode === "outcome_unresolved_do_not_retry") out.unresolvedCreates += row.n;
    else out.remoteQueues += row.n;
  }
  return out;
}
async function creatorHasProviderIdentity({ db, agencyId, creatorId }) {
  const row = await db.creatorAccount.findFirst({ where: { id: creatorId, agencyId }, select: { remoteId: true } });
  return Boolean(String(row?.remoteId || "").trim());
}
async function creatorMassProviderSnapshotProof({ db, agencyId, creatorId }) {
  const [row] = await db.$queryRawUnsafe(`SELECT s."retirementProofId" AS id,s."retirementProofObservedAt" AS "remoteLifecycleObservedAt"
    FROM "MassCreatorDeliveryState" s JOIN "CreatorAccount" c ON c."id"=s."creatorId" AND c."agencyId"=s."agencyId"
    WHERE s."agencyId"=$1 AND s."creatorId"=$2 AND s."retirementId" IS NOT NULL AND s."retirementProofId" IS NOT NULL
      AND s."retirementProofRevision"=s."sourceRevision" AND s."retirementProviderId" IS NOT DISTINCT FROM c."remoteId"`, agencyId, creatorId);
  return row || null;
}
async function assertCreatorMassCampaignRetirable(input) {
  const current = await blockers(input);
  if (current.total) throw error("CREATOR_HAS_ACTIVE_MASS", "Resolve active/unknown MASS writes and native provider queues before removing the creator", 409, current);
  if (input.requireFreshProviderSnapshot !== false && await creatorHasProviderIdentity(input)) {
    const proof = await creatorMassProviderSnapshotProof(input);
    if (!proof) throw error("CREATOR_MASS_PROVIDER_SNAPSHOT_REQUIRED", "Prepare creator retirement with a complete empty provider queue observation", 409, current);
    return { ...current, providerSnapshotObservedAt: proof.remoteLifecycleObservedAt };
  }
  return current;
}
async function assertAgencyMassCampaignRetirable(input) {
  const current = await blockers(input);
  if (current.total) throw error("AGENCY_HAS_ACTIVE_MASS", "Resolve active/unknown MASS writes and native provider queues before removing the agency", 409, current);
  if (input.requireFreshProviderSnapshot !== false) {
    // Proofs accumulate under individual creator admission barriers. Each is
    // invalidated atomically by accepted MASS state changes or explicit resume.
    // No all-creators freshness intersection and no historical delivery scan.
    const missing = await input.db.$queryRawUnsafe(`SELECT c."id" FROM "CreatorAccount" c
      LEFT JOIN "MassCreatorDeliveryState" s ON s."creatorId"=c."id" AND s."agencyId"=c."agencyId"
      WHERE c."agencyId"=$1 AND c."deletedAt" IS NULL AND NULLIF(btrim(c."remoteId"),'') IS NOT NULL
        AND (s."retirementId" IS NULL OR s."retirementProofId" IS NULL OR s."retirementProofRevision" IS DISTINCT FROM s."sourceRevision"
          OR s."retirementProviderId" IS DISTINCT FROM c."remoteId")
      ORDER BY c."id" LIMIT 101`, input.agencyId);
    if (missing.length) throw error("AGENCY_MASS_PROVIDER_SNAPSHOT_REQUIRED", "Prepare retirement for the remaining creators; completed preparations remain paused", 409,
      { ...current, missingCreatorIds: missing.slice(0, 100).map(row => row.id), hasMore: missing.length > 100 });
  }
  return current;
}
module.exports = {
  ACTIVE_MASS_WRITE_STATUSES: ACTIVE, REMOTE_BLOCKING_STATES: ["PENDING", "MIGRATION_RECONCILE_REQUIRED", "UNKNOWN"],
  MASS_CREATE_ACTIONS: CREATE_ACTIONS, MASS_CANCEL_ACTIONS: CANCEL_ACTIONS,
  MASS_PROVIDER_SNAPSHOT_PROOF_MAX_AGE_MS: RETIREMENT_ACCEPT_MS, MASS_RETIREMENT_SNAPSHOT_PURPOSE: "RETIREMENT",
  creatorMassCampaignBlockers: blockers, agencyMassCampaignBlockers: blockers,
  creatorHasProviderIdentity, creatorMassProviderSnapshotProof, assertCreatorMassCampaignRetirable, assertAgencyMassCampaignRetirable,
};

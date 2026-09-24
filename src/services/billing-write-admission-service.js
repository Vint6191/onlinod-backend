"use strict";

const { creatorBillingAccess, BillingExecutionAccessError } = require("./billing-execution-access-service");
const { lockAgencyLifecycleBarrier } = require("./agency-lifecycle-barrier-service");

// Transaction only. Billing writers already take Agency FOR UPDATE. Readers
// share this lock, so distinct creators can commit concurrently. Acquire before
// member, creator, delivery and automation-lane locks, under the lifecycle barrier.
async function lockBillingWriteAdmission({ db, agencyId }) {
  await lockAgencyLifecycleBarrier({ db, agencyId });
  const rows = await db.$queryRawUnsafe('SELECT "id" FROM "Agency" WHERE "id"=$1 FOR SHARE', agencyId);
  if (!rows.length) throw new BillingExecutionAccessError("BILLING_CREATOR_NOT_FOUND", "Workspace no longer exists", 404);
}

async function assertBillingWriteAdmission({ db, agencyId, creatorId }) {
  const state = await creatorBillingAccess({ db, agencyId, creatorId });
  if (!state.allowed) throw new BillingExecutionAccessError(state.reason,
    state.recoverable ? "This creator requires an active subscription" : "Workspace execution is suspended",
    state.recoverable ? 402 : 403);
  return state;
}

function isBillingAdmissionError(error) {
  return ["CREATOR_SUBSCRIPTION_REQUIRED", "BILLING_ACCESS_HELD"].includes(error?.code);
}

// Filter before LIMIT. High-priority unpaid jobs must not starve paid creators.
// Historical unknown outcomes remain drain work, including pre-cutover rows.
function billingActionClaimWhere(access) {
  return { OR: [
    { creatorId: { in: [...access].filter(([, state]) => state.allowed).map(([id]) => id) } },
    { status: "RECONCILE_REQUIRED" },
    { failureCategory: "OUTCOME_UNKNOWN_RECONCILE" },
    { result: { path: ["outcomeState"], equals: "RECONCILE_REQUIRED" } },
  ] };
}

// TelegramDeliveryIntent intentionally has no ORM Creator relation. Apply the
// current-fact predicate in SQL BEFORE the bounded work page, never post-filter
// an unpaid prefix. One indexed candidate per paid creator bounds discovery
// independently of queued history and prevents one creator monopolizing a page.
// This is discovery only; commit rechecks the shared authority.
async function selectBillableTelegramWorkIds({ db, agencyId, scope, take }) {
  const rows = await db.$queryRawUnsafe(`WITH clock AS MATERIALIZED (
      SELECT clock_timestamp() AT TIME ZONE 'UTC' AS at
    ), agency AS MATERIALIZED (
      SELECT a."id",a."trialEndsAt",COALESCE(s."billingMode"::text,'MANUAL') AS mode
      FROM "Agency" a LEFT JOIN LATERAL (SELECT "billingMode" FROM "AgencySubscription"
        WHERE "agencyId"=a."id" ORDER BY "createdAt" DESC,"id" DESC LIMIT 1) s ON true
      WHERE a."id"=$1 AND a."deletedAt" IS NULL AND a."billingSupportHold"=false
    )
    , eligible AS MATERIALIZED (
      SELECT c."id" FROM "CreatorAccount" c JOIN agency a ON a."id"=c."agencyId" CROSS JOIN clock
      LEFT JOIN "CreatorBillingEntitlement" e ON e."creatorId"=c."id" AND e."agencyId"=a."id"
      WHERE c."deletedAt" IS NULL AND ($2::boolean OR c."id"=ANY($3::text[]))
        AND (a.mode='FREE_INTERNAL' OR a."trialEndsAt">clock.at
          OR (e."coreValidUntil">clock.at AND (e."coreValidFrom" IS NULL OR e."coreValidFrom"<=clock.at)))
    )
    SELECT t."id" FROM eligible c CROSS JOIN clock
    CROSS JOIN LATERAL (
      SELECT t."id",t."createdAt" FROM "TelegramDeliveryIntent" t
      WHERE t."agencyId"=$1 AND t."creatorId"=c."id"
        AND t."state" IN ('PLANNED','CLAIMED','FAILED_PRECOMMIT')
        AND (t."state"<>'CLAIMED' OR t."claimUntil" IS NULL OR t."claimUntil"<=clock.at)
        AND NOT (t."state"='PLANNED' AND t."commitStartedAt" IS NULL
          AND starts_with(COALESCE(t."outcomeReason",''),'PRECOMMIT_PROVIDER_UNAVAILABLE:'))
      ORDER BY t."createdAt",t."id" LIMIT 1
    ) t
    ORDER BY t."createdAt",t."id" LIMIT $4`, agencyId, scope?.broad === true,
    (scope?.creatorIds || []).map(String), Math.max(1, Math.min(200, take)));
  return rows.map(row => row.id);
}

module.exports = { lockBillingWriteAdmission, assertBillingWriteAdmission, billingActionClaimWhere, isBillingAdmissionError, selectBillableTelegramWorkIds };

"use strict";

const { trustedCollectionTimestamp, COLLECTION_FUTURE_SKEW_TOLERANCE_MS } = require("./analytics-freshness-policy");
const { membershipProofState } = require("./campaign-membership-proof-service");
const INITIAL_KEYS = new Set(["financial_transactions_scan", "fetch_campaigns", "catchup_notifications_scan", "subscriber_directory_scan"]);
const map = rows => new Map(rows.map(row => [row.creatorId, row]));
const finite = state => state?.status === "FAILED" || state?.status === "PARTIAL" && !state.retryAfterAt;

// The scheduler/claim owner can read a whole bounded candidate page once. No
// per-job history lookup and no second mutable readiness authority is created.
async function loadInitialCollectionAdmission({ db, creatorIds, now = new Date() }) {
  const ids = [...new Set(creatorIds)].filter(Boolean);
  if (!ids.length) return new Map();
  if (ids.length > 500) throw new Error("INITIAL_ADMISSION_PAGE_TOO_LARGE");
  const [financialRows, campaignRows, proofRows] = await Promise.all([
    db.creatorFinancialCollectionState.findMany({ where: { creatorId: { in: ids } } }),
    db.creatorCampaignCollectionState.findMany({ where: { creatorId: { in: ids } } }),
    db.creatorEarningsLedgerProof.findMany({ where: { creatorId: { in: ids } }, select: { creatorId: true } }),
  ]);
  const finances = map(financialRows), campaigns = map(campaignRows), proofs = map(proofRows);
  return new Map(ids.map(id => {
    const financial = finances.get(id), campaign = campaigns.get(id), membership = membershipProofState(campaign);
    const financialReady = Boolean(financial?.baselineGeneration && trustedCollectionTimestamp(financial.baselineVerifiedAt, now) && proofs.has(id));
    const membershipReady = Boolean(membership.baselineGeneration && trustedCollectionTimestamp(membership.baselineVerifiedAt, now));
    // A finite error/cooldown releases independent stages, while its missing
    // proof stays visible. FanData enrichment continues from its own queue once
    // membership has been durably published and cannot hold later sources forever.
    return [id, { financialReady, membershipReady,
      financialReleased: financialReady || finite(financial) || Boolean(financial?.retryAfterAt && +financial.retryAfterAt > +now),
      campaignsReleased: membershipReady || finite(campaign) || Boolean(campaign?.retryAfterAt && +campaign.retryAfterAt > +now) }];
  }));
}

function initialCollectionAdmission(job, state) {
  if (!INITIAL_KEYS.has(job.jobKey) || job.jobKey === "financial_transactions_scan" || job.params?.moneyResolutionVersion === 1)
    return { admitted: true };
  // Existing baselines mean recurring work has its own independent contract.
  if (!state?.financialReleased) return { admitted: false, reason: "initial_financial_stage" };
  if (job.jobKey !== "fetch_campaigns" && !state.campaignsReleased) return { admitted: false, reason: "initial_campaign_stage" };
  return { admitted: true };
}

// Exclude blocked stages in candidate selection, before the fairness/race
// limit. Skipping twenty old blocked rows in memory would revisit the same rows
// on every poll and starve the financial job that can release them. These are
// point-lookups of the same source states used above, not another job history
// scan or a durable copy of readiness. Claim still rechecks current admission.
function initialCollectionClaimWhere(now = new Date()) {
  const trustedThrough = new Date(+now + COLLECTION_FUTURE_SKEW_TOLERANCE_MS);
  const generation = { not: null, notIn: [""] };
  const finiteOrDeferred = { OR: [
    { status: "FAILED" }, { status: "PARTIAL", retryAfterAt: null }, { retryAfterAt: { gt: now } },
  ] };
  const financialReleased = { OR: [
    { financialCollectionState: { is: finiteOrDeferred } },
    { financialCollectionState: { is: { baselineGeneration: generation, baselineVerifiedAt: { lte: trustedThrough } } },
      earningsLedgerProof: { some: {} } },
  ] };
  const campaignsReleased = { campaignCollectionState: { is: { OR: [
    finiteOrDeferred,
    { membershipBaselineGeneration: generation, membershipBaselineVerifiedAt: { lte: trustedThrough } },
    { AND: [
      { OR: [{ membershipBaselineGeneration: null }, { membershipBaselineGeneration: "" }, { membershipBaselineVerifiedAt: null }] },
      { baselineGeneration: generation, baselineVerifiedAt: { lte: trustedThrough } },
    ] },
  ] } } };
  return { OR: [
    { jobKey: { notIn: ["fetch_campaigns", "catchup_notifications_scan", "subscriber_directory_scan"] } },
    { params: { path: ["moneyResolutionVersion"], equals: 1 } },
    { jobKey: "fetch_campaigns", creator: { is: financialReleased } },
    { jobKey: { in: ["catchup_notifications_scan", "subscriber_directory_scan"] },
      creator: { is: { AND: [financialReleased, campaignsReleased] } } },
  ] };
}

function source(key, row, ready, detail = {}) {
  const retryAt = row?.retryAfterAt ? new Date(row.retryAfterAt).toISOString() : null;
  const state = row?.status === "SCANNING" || row?.status === "PUBLISHING" ? "COLLECTING"
    : row?.status === "FAILED" ? "STOPPED" : row?.status === "PARTIAL" ? "PARTIAL"
      : ready ? "READY" : retryAt ? "WAITING" : "REQUIRED";
  return { key, required: true, ready, state, reason: row?.lastErrorMessage || row?.lastErrorCode || row?.lastError || null,
    retryAt, ...detail };
}

async function readInitialCollectionReadiness({ db, creatorId, now = new Date() }) {
  let financial, campaigns, notifications, subscribers, ledger, debt, financialEffect, notificationEffect;
  if (typeof db.$queryRawUnsafe === "function") {
    // One read snapshot of the four source proofs and indexed demand probes.
    // A frequently polled task card must not create a per-source SQL waterfall.
    const [row] = await db.$queryRawUnsafe(`SELECT to_jsonb(f) AS financial,to_jsonb(c) AS campaigns,
        to_jsonb(n) AS notifications,to_jsonb(s) AS subscribers,to_jsonb(p) AS ledger,
        jsonb_build_object('queued',EXISTS(SELECT 1 FROM "CreatorFanRefreshDemand" d WHERE d."creatorId"=$1 AND d.status='QUEUED'),
          'failed',EXISTS(SELECT 1 FROM "CreatorFanRefreshDemand" d WHERE d."creatorId"=$1 AND d.status='FAILED'),
          'unavailable',EXISTS(SELECT 1 FROM "CreatorFanRefreshDemand" d WHERE d."creatorId"=$1 AND d.status='UNAVAILABLE')) AS debt,
        COALESCE(fj.result->'completionSideEffect','{}') AS "financialEffect",
        COALESCE(nj.result->'completionSideEffect','{}') AS "notificationEffect"
      FROM (SELECT $1::text AS id) scope
      LEFT JOIN "CreatorFinancialCollectionState" f ON f."creatorId"=scope.id
      LEFT JOIN "CreatorCampaignCollectionState" c ON c."creatorId"=scope.id
      LEFT JOIN "CreatorNotificationSyncState" n ON n."creatorId"=scope.id
      LEFT JOIN "SubscriberDirectoryState" s ON s."creatorId"=scope.id
      LEFT JOIN "CreatorEarningsLedgerProof" p ON p."creatorId"=scope.id
      LEFT JOIN "JobInstance" fj ON fj.id=f."sourceJobId" AND fj."creatorId"=scope.id
      LEFT JOIN "JobInstance" nj ON nj.id=n."sourceJobId" AND nj."creatorId"=scope.id`, creatorId);
    // Timestamp-without-time-zone JSON is canonical UTC, independently of the
    // Node process timezone. Convert only the selected top-level state dates.
    const hydrate = value => value && Object.fromEntries(Object.entries(value).map(([key, value]) => [key,
      key.endsWith("At") && typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?$/.test(value) ? new Date(value + "Z") : value]));
    financial=hydrate(row.financial); campaigns=hydrate(row.campaigns); notifications=hydrate(row.notifications);
    subscribers=hydrate(row.subscribers); ledger=hydrate(row.ledger); debt=row.debt;
    financialEffect=row.financialEffect; notificationEffect=row.notificationEffect;
  } else {
    let unavailable;
    [financial, campaigns, notifications, subscribers, ledger, debt, unavailable] = await Promise.all([
      db.creatorFinancialCollectionState.findUnique({ where: { creatorId } }),
      db.creatorCampaignCollectionState.findUnique({ where: { creatorId } }),
      db.creatorNotificationSyncState.findUnique({ where: { creatorId } }),
      db.subscriberDirectoryState.findUnique({ where: { creatorId } }),
      db.creatorEarningsLedgerProof.findUnique({ where: { creatorId } }),
      require("./campaign-refresh-debt-service").readCampaignRefreshDebt({ db, creatorId }),
      db.creatorFanRefreshDemand?.findFirst?.({ where: { creatorId, status: "UNAVAILABLE" }, select: { id: true } }),
    ]);
    debt = { ...debt, unavailable: Boolean(unavailable) };
    const sourceJobIds = [financial?.sourceJobId, notifications?.sourceJobId].filter(Boolean);
    const jobs = sourceJobIds.length ? await db.jobInstance.findMany({ where: { creatorId, id: { in: sourceJobIds } }, select: { id: true, result: true } }) : [];
    const effects = new Map(jobs.map(job => [job.id, job.result?.completionSideEffect || {}]));
    financialEffect = effects.get(financial?.sourceJobId) || {}; notificationEffect = effects.get(notifications?.sourceJobId) || {};
  }
  const membership = membershipProofState(campaigns);
  const financialReady = Boolean(ledger && financial?.baselineGeneration && trustedCollectionTimestamp(financial.baselineVerifiedAt, now));
  const membershipReady = Boolean(membership.baselineGeneration && trustedCollectionTimestamp(membership.baselineVerifiedAt, now));
  // A terminal unavailable check completes traversal, not the requested fan
  // value. Current Demand survives run changes; an old run's cached receipt
  // must not certify (or block) the current coverage. This only describes the
  // saved result: initial admission and the finite retry policy stay separate.
  const currentFanCoverage = Boolean(campaigns?.activeGeneration && campaigns.fanValueCoverageScanRunId === campaigns.activeGeneration);
  const enrichmentPending = debt.queued || currentFanCoverage && Number(campaigns.fanValueOutstanding || 0) > 0;
  const enrichmentUnavailable = debt.unavailable || currentFanCoverage && Number(campaigns.fanValueUnavailable || 0) > 0;
  const enrichmentPartial = debt.failed || enrichmentUnavailable || currentFanCoverage && Number(campaigns.fanValueExpected || 0) > 0
    && campaigns.fanValueFreshnessStatus !== "COMPLETE";
  const campaignReady = membershipReady && !enrichmentPending && !enrichmentPartial;
  const items = [
    source("financial", financial, financialReady, { published: Boolean(ledger), historyRead: financialEffect.historyRead === true,
      ...(financialEffect.historyRead && financialEffect.published === false ? { state: "VERIFICATION_FAILED", reason: financialEffect.error || financial?.lastErrorMessage || financialEffect.verification || "Financial comparison not verified" } : {}) }),
    source("campaigns", campaigns, campaignReady,
      { membershipReady, enrichmentPending, enrichmentFailed: debt.failed, enrichmentUnavailable, enrichmentPartial,
        ...(membershipReady && !campaignReady ? { state: enrichmentPending ? "COLLECTING" : "PARTIAL",
          reason: enrichmentPending ? "Fan profiles are still being collected"
            : enrichmentUnavailable ? "Some fan profiles are unavailable; campaign membership is saved but fan values are incomplete"
              : debt.failed ? "Some fan profiles could not be collected" : "Campaign membership is saved; fan value coverage is incomplete" } : {}) }),
    source("notifications", notifications, Boolean(notifications?.normalizerVersion === "notification-source-v2" && trustedCollectionTimestamp(notifications.fullBackfillVerifiedAt, now)),
      { historyRead: Boolean(notifications?.fullBackfillCompletedAt || notificationEffect.sourceTraversalComplete) }),
    source("subscribers", subscribers, Boolean(subscribers?.publishedAt && subscribers?.publishedGeneration > 0)),
  ];
  const ready = items.every(item => item.ready), completed = items.filter(item => item.ready).length;
  return { ready, completed, total: items.length, sources: items };
}

module.exports = { loadInitialCollectionAdmission, initialCollectionAdmission, initialCollectionClaimWhere, readInitialCollectionReadiness };

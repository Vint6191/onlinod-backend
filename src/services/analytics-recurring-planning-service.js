"use strict";

const { runDbTransaction } = require("./db-transaction-service");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { lockDomainWorkClaimForCommit } = require("./domain-work-authority-service");
const { afterPlanningCommit } = require("./job-planning-repository");
const { guaranteedDirectoryCallsPerSweep } = require("./provider-capacity-topology-control-service");

const HOUR_MS = 60 * 60 * 1000;

// One fleet-wide hourly reservation, independent of replica/timer count. This
// admits periodic directory jobs only; provider starts retain their existing gate.
async function reserveDirectoryAdmission({ db, state, now, budgetKey = "campaign-directory" }) {
  const at = await dbAuthorityNow({ db, fallbackNow: now });
  const windowStart = new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);
  const cost = Math.max(1, Math.ceil(Math.max(0, Number(state?.campaignDirectoryCampaignCount) || 0) / 50) + 1);
  const rows = await db.$queryRawUnsafe(`
    INSERT INTO "AnalyticsPlanningBudget" ("id","windowStart","reservedCalls","reservedJobs","updatedAt")
    VALUES ($4,$1,$2,1,clock_timestamp())
    ON CONFLICT ("id") DO UPDATE SET
      "windowStart"=EXCLUDED."windowStart",
      "reservedCalls"=CASE WHEN "AnalyticsPlanningBudget"."windowStart" < EXCLUDED."windowStart"
        THEN EXCLUDED."reservedCalls" ELSE "AnalyticsPlanningBudget"."reservedCalls" + EXCLUDED."reservedCalls" END,
      "reservedJobs"=CASE WHEN "AnalyticsPlanningBudget"."windowStart" < EXCLUDED."windowStart" THEN 1 ELSE "AnalyticsPlanningBudget"."reservedJobs" + 1 END,
      "updatedAt"=clock_timestamp()
    WHERE "AnalyticsPlanningBudget"."windowStart" < EXCLUDED."windowStart"
       OR ("AnalyticsPlanningBudget"."windowStart"=EXCLUDED."windowStart"
         AND "AnalyticsPlanningBudget"."reservedCalls" + EXCLUDED."reservedCalls" <= $3 AND "AnalyticsPlanningBudget"."reservedJobs" < 100)
    RETURNING "reservedCalls"`, windowStart, cost, guaranteedDirectoryCallsPerSweep(), String(budgetKey));
  // One oversized first request is allowed each hour so cost cannot make a
  // creator impossible to serve. Other admissions wait for the next window.
  return rows.length > 0;
}

async function planRecurringCreatorAnalytics({ db, item, ownerToken, now = new Date() }) {
  if (typeof db?.$transaction !== "function" || typeof db?.$queryRawUnsafe !== "function") {
    throw Object.assign(new Error("Analytics planning requires a root transactional database"), { code: "ANALYTICS_PLANNING_TRANSACTION_REQUIRED" });
  }
  return afterPlanningCommit(() => runDbTransaction(db, async (tx) => {
    // Match lifecycle ordering: Agency -> Creator -> exact work claim -> collector.
    // SHARE protects eligibility against soft deletion/status change until commit.
    const agencies = await tx.$queryRawUnsafe('SELECT "id" FROM "Agency" WHERE "id"=$1 AND "deletedAt" IS NULL FOR SHARE', item.agencyId);
    const creators = agencies.length ? await tx.$queryRawUnsafe('SELECT "id" FROM "CreatorAccount" WHERE "id"=$1 AND "agencyId"=$2 AND "status"=\'READY\' AND "deletedAt" IS NULL FOR SHARE', item.creatorId || item.objectId, item.agencyId) : [];
    if (!creators.length) return { retired: true, created: 0, skipped: 0 };
    const ownership = await lockDomainWorkClaimForCommit({ db: tx, item, ownerToken, fallbackNow: now });
    if (!ownership.current || ownership.newerRevision) throw Object.assign(new Error("Analytics planning ownership lost"), { code: "ANALYTICS_PLANNING_CLAIM_LOST" });
    const creatorId = creators[0].id;
    if (ownership.item.workClass !== "CREATOR_RECURRING_PLANNING"
      || ownership.item.agencyId !== item.agencyId
      || String(ownership.item.creatorId || ownership.item.objectId) !== String(creatorId)) {
      throw Object.assign(new Error("Analytics work claim scope mismatch"), { code: "ANALYTICS_PLANNING_SCOPE_MISMATCH" });
    }
    const { ensureOperationalAnalyticsFreshness } = require("./analytics-collection-planner");
    const { ensureRecurringCreatorAnalyticsCatchups } = require("./creator-analytics-sync-orchestrator");
    const earnings = await ensureOperationalAnalyticsFreshness({ db: tx, creatorId, agencyId: item.agencyId, now: ownership.authorityNow, reason: "RECURRING", priority: 30 });
    const analytics = await ensureRecurringCreatorAnalyticsCatchups({
      db: tx, creatorId, agencyId: item.agencyId, now: ownership.authorityNow, priority: 20,
      campaignDirectoryDiscoveryAdmitted: false,
      reserveCampaignDirectory: (state) => reserveDirectoryAdmission({ db: tx, state, now: ownership.authorityNow }),
    });
    if (analytics?.initial?.reason === "failed_terminal" || analytics?.initial?.reason === "missing_scope") {
      throw Object.assign(new Error(`Analytics initial sync: ${analytics.initial.reason}`), { code: "ANALYTICS_INITIAL_SYNC_BLOCKED" });
    }
    // A lease can expire during planning even while its row is locked. No jobs
    // or admission budget survive this failed final fence; notifications wait.
    const final = await lockDomainWorkClaimForCommit({ db: tx, item, ownerToken, fallbackNow: now });
    if (!final.current || final.newerRevision) throw Object.assign(new Error("Analytics planning lease expired before commit"), { code: "ANALYTICS_PLANNING_CLAIM_LOST" });
    return { created: Number(earnings.created || 0) + Number(analytics.created?.length || 0) + (analytics.initial?.created ? 1 : 0), skipped: Number(analytics.skipped?.length || 0), retired: false };
  }, { maxWait: 5000, timeout: 20_000 }));
}

module.exports = { planRecurringCreatorAnalytics, reserveDirectoryAdmission };

"use strict";

const { runRootCommit } = require("./db-commit-kernel");

const { readCurrentDesktopMemberAuthority } = require("./desktop-current-access-authority-service");
const { requireCreatorAccess } = require("../middleware/automation-permissions");
const { isOwner } = require("./team-access-control");
const { creatorBillingAccess, BillingExecutionAccessError } = require("./billing-execution-access-service");

async function planBillingEarningsRefresh({ db, agencyId, userId, memberId, creatorId }) {
  // Same order as billing/Owner mutations: agency before member. A transfer or
  // hold cannot commit between permission validation and durable job creation.
  await db.$queryRawUnsafe('SELECT "id" FROM "Agency" WHERE "id"=$1 FOR SHARE', agencyId);
  await db.$queryRawUnsafe('SELECT "id" FROM "AgencyMember" WHERE "id"=$1 AND "agencyId"=$2 AND "userId"=$3 FOR SHARE', memberId, agencyId, userId);
  // Billing recovery survives expiry, but never membership/Owner revocation.
  const member = await readCurrentDesktopMemberAuthority({ db, agencyId, userId, memberId });
  if (!isOwner(member)) throw new BillingExecutionAccessError("BILLING_OWNER_ONLY", "Billing recovery is available to the workspace owner", 403);
  const creator = await requireCreatorAccess({ db, agencyId, member, creatorId });
  if (creator.status !== "READY") throw new BillingExecutionAccessError("BILLING_RECOVERY_SESSION_REQUIRED", "Connect this creator before refreshing earnings", 409);
  const access = await creatorBillingAccess({ db, agencyId, creatorId });
  if (!access.recoverable) throw new BillingExecutionAccessError(access.reason, "Workspace execution is suspended", 403);
  const today = Math.floor(access.now.getTime() / 86400000) * 86400000;
  const { ensureAnalyticsWindowFreshness } = require("./analytics-collection-planner");
  const plan = await ensureAnalyticsWindowFreshness({ db, agencyId, creatorId, now: access.now,
    startDay: new Date(today - 30 * 86400000), endDay: new Date(today - 86400000),
    reason: "BILLING", priority: 80, force: false });
  return { state: plan.fresh ? "READY" : "QUEUED", created: plan.created, reused: plan.reused,
    deferredDays: plan.deferredDays, startDay: plan.startDay.toISOString().slice(0, 10), endDay: plan.endDay.toISOString().slice(0, 10) };
}

async function requestBillingEarningsRefresh(input) {
  return runRootCommit(input.db, (context) => planBillingEarningsRefresh({ ...input, db: context.tx }), {
    profile: "BILLING_RECOVERY",
    authority: { kind: "BILLING_CONTROL", agencyId: input.agencyId, userId: input.userId, creatorId: input.creatorId },
  });
}

module.exports = { requestBillingEarningsRefresh };

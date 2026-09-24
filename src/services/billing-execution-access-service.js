"use strict";

const crypto = require("node:crypto");
const { activeCore } = require("./billing-state-service");
const DAY_MS = 86400000;
const RECOVERY_OPERATION = "earnings.chart";
const SECURITY_OPERATIONS = new Set(["identity.bootstrap.me", "identity.shadow-bootstrap.me"]);

class BillingExecutionAccessError extends Error {
  constructor(code, message, status = 402) {
    super(message); this.name = "BillingExecutionAccessError"; this.code = code; this.status = status;
  }
}

// This authority reads current facts and PostgreSQL time. Agency.status and
// AgencySubscription.status are projections, never execution permissions.
// One creator's entitlement cannot admit another creator in the same agency.
const ACCESS_SQL = `WITH clock AS MATERIALIZED (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS at)
 SELECT c."id" AS "creatorId", a."deletedAt", a."billingSupportHold", a."trialEndsAt",
   COALESCE(s."billingMode"::text,'MANUAL') AS "billingMode",
   e."coreValidFrom",e."coreValidUntil",clock.at AS "authorityNow"
 FROM "Agency" a CROSS JOIN clock
 JOIN "CreatorAccount" c ON c."agencyId"=a."id" AND c."deletedAt" IS NULL
 LEFT JOIN LATERAL (SELECT "billingMode" FROM "AgencySubscription"
   WHERE "agencyId"=a."id" ORDER BY "createdAt" DESC,"id" DESC LIMIT 1) s ON true
 LEFT JOIN "CreatorBillingEntitlement" e ON e."creatorId"=c."id" AND e."agencyId"=a."id"
 WHERE a."id"=$1 AND c."id"=ANY($2::text[])`;

function accessFromRow(row) {
  const now = row?.authorityNow;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new BillingExecutionAccessError("BILLING_ACCESS_CLOCK_INVALID", "Billing clock is unavailable", 503);
  }
  if (row.deletedAt || row.billingSupportHold === true) return { allowed: false, recoverable: false, reason: "BILLING_ACCESS_HELD", now, validUntil: null };
  if (row.billingMode === "FREE_INTERNAL") return { allowed: true, recoverable: true, reason: "FREE_INTERNAL", now, validUntil: null };
  const trial = row.trialEndsAt instanceof Date && row.trialEndsAt > now ? row.trialEndsAt : null;
  const paid = activeCore(row, now) ? row.coreValidUntil : null;
  const validUntil = trial && paid ? new Date(Math.max(trial.getTime(), paid.getTime())) : trial || paid;
  return { allowed: !!validUntil, recoverable: true, reason: validUntil ? (paid ? "PAID" : "TRIAL") : "CREATOR_SUBSCRIPTION_REQUIRED", now, validUntil };
}

async function readBillingExecutionAccess({ db, agencyId, creatorIds }) {
  const ids = [...new Set(creatorIds.map(String).filter(Boolean))];
  const result = new Map();
  // Parameter/query batch, not a visibility horizon: classify every supplied id.
  for (let offset = 0; offset < ids.length; offset += 500) {
    const rows = await db.$queryRawUnsafe(ACCESS_SQL, String(agencyId), ids.slice(offset, offset + 500));
    for (const row of rows) result.set(row.creatorId, accessFromRow(row));
  }
  return result;
}

async function creatorBillingAccess({ db, agencyId, creatorId }) {
  const state = (await readBillingExecutionAccess({ db, agencyId, creatorIds: [creatorId] })).get(creatorId);
  if (!state) throw new BillingExecutionAccessError("BILLING_CREATOR_NOT_FOUND", "Creator is outside the live agency scope", 404);
  return state;
}

function denied(state) {
  return new BillingExecutionAccessError(state.reason, state.recoverable ? "This creator requires an active subscription" : "Workspace execution is suspended", state.recoverable ? 402 : 403);
}

function recoveryBounds(now) {
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  // One extra closed day lets a server-pinned job cross UTC midnight. A single
  // recovery request still cannot cover more than 30 days or the current day.
  return { from: new Date(today - 31 * DAY_MS).toISOString().slice(0, 10), to: new Date(today - DAY_MS).toISOString().slice(0, 10) };
}

function recoveryWindow(params, now) {
  const from = params?.scanFrom, to = params?.scanTo;
  const exactDay = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (params?.analyticsContractVersion !== 1 || params?.sourceTimezone !== "UTC" || !exactDay(from) || !exactDay(to)) return false;
  const bounds = recoveryBounds(now);
  return from >= bounds.from && to <= bounds.to && from <= to && Date.parse(to) - Date.parse(from) < 30 * DAY_MS;
}

function billingJobClaimWhere({ access, recoveryCapable }) {
  const paid = [], recovery = [];
  let now = null;
  for (const [id, state] of access) {
    now = state.now;
    if (state.allowed) paid.push(id);
    else if (state.recoverable && recoveryCapable) recovery.push(id);
  }
  const alternatives = [{ creatorId: { in: paid } }];
  if (recovery.length) {
    const bounds = recoveryBounds(now);
    alternatives.push({ creatorId: { in: recovery }, jobKey: "fetch_earnings", AND: [
      { params: { path: ["analyticsContractVersion"], equals: 1 } },
      { params: { path: ["sourceTimezone"], equals: "UTC" } },
      { params: { path: ["scanFrom"], gte: bounds.from } },
      { params: { path: ["scanTo"], lte: bounds.to } },
    ] });
  }
  return { OR: alternatives };
}

async function assertJobBillingAccess({ db, job, recoveryCapable = true }) {
  const state = await creatorBillingAccess({ db, agencyId: job.agencyId, creatorId: job.creatorId });
  if (state.allowed) return state;
  if (state.recoverable && recoveryCapable && job.jobKey === "fetch_earnings" && recoveryWindow(job.params, state.now)) return state;
  throw denied(state);
}

async function assertProviderBillingAccess({ db, agencyId, creatorId, userId, deviceId, member, capability, operation, billingRecovery, jobLease, operationReadback, physicalRequest }) {
  const state = await creatorBillingAccess({ db, agencyId, creatorId });
  if (operationReadback) return require("./billing-operation-readback-service").assertOperationReadback({
    db, agencyId, creatorId, userId, deviceId, member, capability, operation, operationReadback, physicalRequest,
  });
  if (!state.recoverable) throw denied(state);
  // Session identity verification is needed to restore a disconnected collector.
  // A caller-supplied security_probe label alone must never admit arbitrary work.
  if (capability === "security_probe") {
    if (!SECURITY_OPERATIONS.has(operation)) throw new BillingExecutionAccessError("BILLING_SECURITY_PROBE_INVALID", "Unknown session identity operation", 403);
    return state;
  }
  const lease = jobLease || billingRecovery;
  if (state.allowed && !lease) return state;
  if (capability !== "read" || !lease || (!state.allowed && (operation !== RECOVERY_OPERATION || !billingRecovery))) throw denied(state);
  const { jobId, leaseToken, leaseRevision } = lease;
  if (billingRecovery && (jobId !== billingRecovery.jobId || leaseToken !== billingRecovery.leaseToken || leaseRevision !== billingRecovery.leaseRevision)) {
    throw new BillingExecutionAccessError("BILLING_RECOVERY_LEASE_INVALID", "Conflicting job lease contexts", 403);
  }
  if (typeof jobId !== "string" || typeof leaseToken !== "string" || !Number.isInteger(leaseRevision) || leaseRevision < 1) throw denied(state);
  const tokenHash = crypto.createHash("sha256").update(leaseToken).digest("hex");
  const rows = await db.$queryRawUnsafe(`SELECT j."jobKey",j."params",j."leaseUntil",clock_timestamp() AT TIME ZONE 'UTC' AS "authorityNow"
    FROM "JobInstance" j JOIN "AgencyMember" m ON m."id"=j."leaseMemberId" AND m."agencyId"=j."agencyId"
    JOIN "User" u ON u."id"=m."userId" AND u."disabledAt" IS NULL
    JOIN "WorkerDevice" d ON d."id"=j."claimedByDeviceId" AND d."userId"=m."userId" AND d."agencyId"=j."agencyId"
    WHERE j."id"=$1 AND j."agencyId"=$2 AND j."creatorId"=$3 AND j."claimedByDeviceId"=$4
      AND j."status"='CLAIMED' AND j."leaseTokenHash"=$5
      AND j."leaseRevision"=$6 AND j."leaseUntil">clock_timestamp() AT TIME ZONE 'UTC'
      AND m."id"=$7 AND m."userId"=$8 AND m."deletedAt" IS NULL AND m."deactivatedAt" IS NULL
      AND m."accessEpoch"=j."leaseAccessEpoch" AND m."accessEpoch"=$9`,
    jobId, agencyId, creatorId, deviceId, tokenHash, leaseRevision, String(member?.id || ""), userId, Number(member?.accessEpoch || 0));
  const job = rows?.[0];
  if (!job || (!state.allowed && (job.jobKey !== "fetch_earnings" || !recoveryWindow(job.params, job.authorityNow)
    || job.params.scanFrom !== billingRecovery.scanFrom || job.params.scanTo !== billingRecovery.scanTo))) {
    throw new BillingExecutionAccessError("BILLING_RECOVERY_LEASE_INVALID", "Billing recovery requires a current earnings job for this device and date range", 403);
  }
  return { ...state, validUntil: state.validUntil ? new Date(Math.min(state.validUntil.getTime(), job.leaseUntil.getTime())) : job.leaseUntil, recovery: !state.allowed };
}

module.exports = { BillingExecutionAccessError, readBillingExecutionAccess, creatorBillingAccess, billingJobClaimWhere,
  assertJobBillingAccess, assertProviderBillingAccess, recoveryWindow, recoveryBounds, accessFromRow, ACCESS_SQL };

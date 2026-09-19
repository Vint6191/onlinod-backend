"use strict";

const { lockDbAdvisoryXact } = require("./db-transaction-service");

const FAN_DATA_REFRESH_MAX_ACTIVE_CLAIMS = Math.max(1, Math.min(100, Number.parseInt(process.env.FAN_DATA_REFRESH_MAX_ACTIVE_CLAIMS || "8", 10) || 8));
const FAN_DATA_REFRESH_MAX_ACTIVE_CLAIMS_PER_CREATOR = Math.max(1, Math.min(FAN_DATA_REFRESH_MAX_ACTIVE_CLAIMS, Number.parseInt(process.env.FAN_DATA_REFRESH_MAX_ACTIVE_CLAIMS_PER_CREATOR || "1", 10) || 1));
const FAN_DATA_REFRESH_CLAIM_LOCK_KEY = "fan-data-refresh-claim-admission-v1";
const FAN_DATA_REFRESH_MAX_PENDING_JOBS = Math.max(FAN_DATA_REFRESH_MAX_ACTIVE_CLAIMS, Math.min(500, Number.parseInt(process.env.FAN_DATA_REFRESH_MAX_PENDING_JOBS || "32", 10) || 32));
const FAN_DATA_REFRESH_MAX_PENDING_JOBS_PER_CREATOR = Math.max(FAN_DATA_REFRESH_MAX_ACTIVE_CLAIMS_PER_CREATOR, Math.min(FAN_DATA_REFRESH_MAX_PENDING_JOBS, Number.parseInt(process.env.FAN_DATA_REFRESH_MAX_PENDING_JOBS_PER_CREATOR || "4", 10) || 4));
const FAN_DATA_REFRESH_SCHEDULE_LOCK_KEY = "fan-data-refresh-schedule-admission-v1";

function clean(value, max = 180) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

async function fanDataRefreshClaimAvailable(db, creatorId) {
  const scopedCreatorId = clean(creatorId, 180);
  if (!scopedCreatorId || typeof db?.$queryRawUnsafe !== "function" || typeof db?.$executeRawUnsafe !== "function") {
    return { available: true, globalFull: false, creatorFull: false, activeGlobal: 0, activeCreator: 0 };
  }
  await lockDbAdvisoryXact({ db, key: FAN_DATA_REFRESH_CLAIM_LOCK_KEY });
  const rows = await db.$queryRawUnsafe(`
    SELECT
      COUNT(*)::bigint AS "activeGlobal",
      COUNT(*) FILTER (WHERE "creatorId" = $1)::bigint AS "activeCreator"
    FROM "JobInstance"
    WHERE "jobKey" = 'fan_data_point_refresh'
      AND "status" = 'CLAIMED'
  `, scopedCreatorId);
  const row = Array.isArray(rows) ? rows[0] : rows;
  const activeGlobal = Number(row?.activeGlobal ?? row?.activeglobal ?? 0);
  const activeCreator = Number(row?.activeCreator ?? row?.activecreator ?? 0);
  const globalFull = !Number.isFinite(activeGlobal) || activeGlobal >= FAN_DATA_REFRESH_MAX_ACTIVE_CLAIMS;
  const creatorFull = !Number.isFinite(activeCreator) || activeCreator >= FAN_DATA_REFRESH_MAX_ACTIVE_CLAIMS_PER_CREATOR;
  return {
    available: !globalFull && !creatorFull,
    globalFull,
    creatorFull,
    activeGlobal: Number.isFinite(activeGlobal) ? activeGlobal : FAN_DATA_REFRESH_MAX_ACTIVE_CLAIMS,
    activeCreator: Number.isFinite(activeCreator) ? activeCreator : FAN_DATA_REFRESH_MAX_ACTIVE_CLAIMS_PER_CREATOR,
  };
}

async function fanDataRefreshScheduleAvailable(db, creatorId) {
  const scopedCreatorId = clean(creatorId, 180);
  if (!scopedCreatorId || typeof db?.$queryRawUnsafe !== "function" || typeof db?.$executeRawUnsafe !== "function") {
    return { available: true, globalFull: false, creatorFull: false, pendingGlobal: 0, pendingCreator: 0 };
  }
  await lockDbAdvisoryXact({ db, key: FAN_DATA_REFRESH_SCHEDULE_LOCK_KEY });
  const rows = await db.$queryRawUnsafe(`
    SELECT
      COUNT(*)::bigint AS "pendingGlobal",
      COUNT(*) FILTER (WHERE "creatorId" = $1)::bigint AS "pendingCreator"
    FROM "JobInstance"
    WHERE "jobKey" = 'fan_data_point_refresh'
      AND "status" IN ('SCHEDULED','CLAIMED')
  `, scopedCreatorId);
  const row = Array.isArray(rows) ? rows[0] : rows;
  const pendingGlobal = Number(row?.pendingGlobal ?? row?.pendingglobal ?? 0);
  const pendingCreator = Number(row?.pendingCreator ?? row?.pendingcreator ?? 0);
  const globalFull = !Number.isFinite(pendingGlobal) || pendingGlobal >= FAN_DATA_REFRESH_MAX_PENDING_JOBS;
  const creatorFull = !Number.isFinite(pendingCreator) || pendingCreator >= FAN_DATA_REFRESH_MAX_PENDING_JOBS_PER_CREATOR;
  return {
    available: !globalFull && !creatorFull,
    globalFull, creatorFull,
    pendingGlobal: Number.isFinite(pendingGlobal) ? pendingGlobal : FAN_DATA_REFRESH_MAX_PENDING_JOBS,
    pendingCreator: Number.isFinite(pendingCreator) ? pendingCreator : FAN_DATA_REFRESH_MAX_PENDING_JOBS_PER_CREATOR,
  };
}

module.exports = {
  FAN_DATA_REFRESH_MAX_ACTIVE_CLAIMS,
  FAN_DATA_REFRESH_MAX_ACTIVE_CLAIMS_PER_CREATOR,
  FAN_DATA_REFRESH_CLAIM_LOCK_KEY,
  FAN_DATA_REFRESH_MAX_PENDING_JOBS,
  FAN_DATA_REFRESH_MAX_PENDING_JOBS_PER_CREATOR,
  FAN_DATA_REFRESH_SCHEDULE_LOCK_KEY,
  fanDataRefreshClaimAvailable,
  fanDataRefreshScheduleAvailable,
};

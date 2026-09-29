"use strict";

// One bounded transaction owns backfill, dirty repair, time wakeup and publication.
// Canonical triggers only touch a per-source dirty key; never this global lock.
const { runDbTransaction } = require("./db-transaction-service");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { CLAIMABLE_DESKTOP_JOB_KEYS } = require("./job-catalog");
const { DEFAULT_CAMPAIGN_DIRECTORY_PAGE_SIZE } = require("./provider-capacity-sla-service");
const ID = "of-global-capacity-v1";
const GENERATION = "phase6_capacity_incremental_v1";
const SOURCE = Object.freeze({
  directory: { table: "CreatorCampaignCollectionState", columns: '"id","baselineVerifiedAt","campaignDirectoryDiscoveryRequestedRevision","campaignDirectoryDiscoveryCompletedRevision","campaignDirectoryDiscoveryDueAt","campaignDirectoryCampaignCount"' },
  fan: { table: "CreatorFanRefreshDemand", columns: '"id","requestedRevision","satisfiedRevision","lastRequestedAt"' },
  job: { table: "JobInstance", columns: '"id","jobKey","status","scheduledAt"' },
});
const OTHER_KEYS = CLAIMABLE_DESKTOP_JOB_KEYS.filter((key) => !["fetch_campaigns", "fan_data_point_refresh"].includes(key));
const OTHER_BUCKETS = OTHER_KEYS.map((key) => `job:${key}`);
const json = (value) => JSON.stringify(value, (_key, v) => typeof v === "bigint" ? String(v) : v);
const integer = (value) => BigInt(value ?? 0);
const date = (value) => value == null ? null : new Date(value);
const failure = (code) => Object.assign(new Error(code), { code });

function contributionFor(kind, row, now) {
  if (!row) return null; // canonical deletion retracts the former contribution
  const c = { kind, sourceId: row.id, bucket: kind, itemCount: 0n, overdueCount: 0n, requiredCalls: 0n, oldestAt: null, nextDueAt: null };
  if (kind === "directory") {
    if (!row.baselineVerifiedAt) return null;
    const dueAt = date(row.campaignDirectoryDiscoveryDueAt);
    const due = integer(row.campaignDirectoryDiscoveryRequestedRevision) > integer(row.campaignDirectoryDiscoveryCompletedRevision) || !dueAt || dueAt <= now;
    c.itemCount = due ? 1n : 0n;
    c.overdueCount = dueAt && dueAt < now ? 1n : 0n;
    const count = Math.max(0, Number(row.campaignDirectoryCampaignCount) || 0);
    c.requiredCalls = due ? BigInt(Math.max(1, Math.ceil(count / DEFAULT_CAMPAIGN_DIRECTORY_PAGE_SIZE) + 1)) : 0n;
    c.oldestAt = due ? dueAt : null;
    // At equality it is due but not overdue. Revisit one timestamp millisecond later.
    c.nextDueAt = dueAt && dueAt >= now ? new Date(dueAt.getTime() + (dueAt.getTime() === now.getTime() ? 1 : 0)) : null;
    return c;
  }
  if (kind === "fan") {
    if (integer(row.requestedRevision) <= integer(row.satisfiedRevision)) return null;
    c.itemCount = 1n; c.oldestAt = date(row.lastRequestedAt); return c;
  }
  if (kind !== "job") throw failure("CAPACITY_SOURCE_KIND_INVALID");
  const fan = row.jobKey === "fan_data_point_refresh" && ["SCHEDULED", "CLAIMED"].includes(row.status);
  const other = OTHER_KEYS.includes(row.jobKey) && ["SCHEDULED", "CLAIMED", "PAUSED"].includes(row.status);
  if (!fan && !other) return null;
  c.bucket = `job:${row.jobKey}`; c.itemCount = 1n; c.oldestAt = date(row.scheduledAt); return c;
}

function bucketDeltas(before, after) {
  const totals = new Map();
  for (const [rows, sign] of [[before, -1n], [after, 1n]]) for (const c of rows) {
    const delta = totals.get(c.bucket) || { bucket: c.bucket, itemCount: 0n, overdueCount: 0n, requiredCalls: 0n };
    for (const key of ["itemCount", "overdueCount", "requiredCalls"]) delta[key] += sign * integer(c[key]);
    totals.set(c.bucket, delta);
  }
  return [...totals.values()].filter((c) => c.itemCount || c.overdueCount || c.requiredCalls);
}

async function enqueue(db, kind, ids) {
  if (!ids.length) return;
  await db.$executeRawUnsafe(`INSERT INTO "ProviderCapacityDirty" ("kind","sourceId","touchedAt")
    SELECT $1, id, clock_timestamp() FROM unnest($2::text[]) AS id
    ON CONFLICT ("kind","sourceId") DO NOTHING`, kind, ids);
}

async function seedBackfill(db, state, size) {
  let scanned = 0;
  for (const [kind, source] of Object.entries(SOURCE)) {
    if (state[`${kind}Complete`]) continue;
    const cursor = state[`${kind}Cursor`];
    // Two query shapes retain a plain PK range even under a generic query plan.
    const rows = cursor == null
      ? await db.$queryRawUnsafe(`SELECT "id" FROM "${source.table}" ORDER BY "id" LIMIT $1`, size)
      : await db.$queryRawUnsafe(`SELECT "id" FROM "${source.table}" WHERE "id">$1 ORDER BY "id" LIMIT $2`, cursor, size);
    await enqueue(db, kind, rows.map((row) => row.id));
    await db.$executeRawUnsafe(`UPDATE "ProviderCapacityProjectionState" SET "${kind}Cursor"=$2,"${kind}Complete"=$3 WHERE "id"=$1`, ID, rows.at(-1)?.id ?? cursor, rows.length < size);
    scanned += rows.length;
  }
  return scanned;
}

async function repairDirty(db, now, size) {
  const due = await db.$queryRawUnsafe(`SELECT "kind","sourceId" FROM "ProviderCapacityContribution"
    WHERE "nextDueAt" <= $1 ORDER BY "nextDueAt","kind","sourceId" LIMIT $2`, now, size);
  await enqueue(db, "directory", due.map((row) => row.sourceId));
  const dirty = await db.$queryRawUnsafe(`SELECT "kind","sourceId" FROM "ProviderCapacityDirty"
    ORDER BY "touchedAt","kind","sourceId" LIMIT $1 FOR UPDATE SKIP LOCKED`, size);
  for (const [kind, source] of Object.entries(SOURCE)) {
    const ids = dirty.filter((row) => row.kind === kind).map((row) => row.sourceId);
    if (!ids.length) continue;
    // Dirty keys are locked until commit. A concurrent canonical mutation waits
    // at its trigger, then recreates its key after our delete; no lost wakeup.
    const rows = await db.$queryRawUnsafe(`SELECT ${source.columns} FROM "${source.table}" WHERE "id"=ANY($1::text[])`, ids);
    const before = await db.$queryRawUnsafe(`SELECT * FROM "ProviderCapacityContribution" WHERE "kind"=$1 AND "sourceId"=ANY($2::text[])`, kind, ids);
    const after = rows.map((row) => contributionFor(kind, row, now)).filter(Boolean);
    const deltas = bucketDeltas(before, after);
    if (deltas.length) {
      await db.$executeRawUnsafe(`INSERT INTO "ProviderCapacityBucket" ("bucket")
        SELECT bucket FROM unnest($1::text[]) AS bucket ON CONFLICT DO NOTHING`, deltas.map((d) => d.bucket));
      await db.$executeRawUnsafe(`UPDATE "ProviderCapacityBucket" b SET
        "itemCount"=b."itemCount"+d."itemCount", "overdueCount"=b."overdueCount"+d."overdueCount", "requiredCalls"=b."requiredCalls"+d."requiredCalls"
        FROM jsonb_to_recordset($1::jsonb) AS d(bucket text,"itemCount" bigint,"overdueCount" bigint,"requiredCalls" bigint) WHERE b."bucket"=d.bucket`, json(deltas));
    }
    await db.$executeRawUnsafe(`DELETE FROM "ProviderCapacityContribution" WHERE "kind"=$1 AND "sourceId"=ANY($2::text[])`, kind, ids);
    if (after.length) await db.$executeRawUnsafe(`INSERT INTO "ProviderCapacityContribution" ("kind","sourceId","bucket","itemCount","overdueCount","requiredCalls","oldestAt","nextDueAt")
      SELECT kind,"sourceId",bucket,"itemCount","overdueCount","requiredCalls","oldestAt","nextDueAt"
      FROM jsonb_to_recordset($1::jsonb) AS c(kind text,"sourceId" text,bucket text,"itemCount" bigint,"overdueCount" bigint,"requiredCalls" bigint,"oldestAt" timestamp,"nextDueAt" timestamp)`, json(after));
    await db.$executeRawUnsafe(`DELETE FROM "ProviderCapacityDirty" WHERE "kind"=$1 AND "sourceId"=ANY($2::text[])`, kind, ids);
  }
  return dirty.length;
}

async function readProjectedInputs(db, now) {
  // Fixed catalog cardinality, singleton lookups and indexed LIMIT 1 probes only.
  const rows = await db.$queryRawUnsafe(`WITH background_other AS (
    SELECT COALESCE(SUM(b."itemCount"),0)::bigint AS "backgroundOtherPendingJobs",
      COUNT(*) FILTER (WHERE b."itemCount">0)::bigint AS "backgroundOtherPendingJobClasses",
      MIN(oldest."oldestAt") AS "backgroundOtherOldestScheduledAt"
    FROM unnest($2::text[]) AS keys(bucket)
    LEFT JOIN "ProviderCapacityBucket" b ON b.bucket=keys.bucket
    LEFT JOIN LATERAL (SELECT "oldestAt" FROM "ProviderCapacityContribution" c
      WHERE c.bucket=keys.bucket AND "oldestAt" IS NOT NULL ORDER BY "oldestAt" LIMIT 1) oldest ON true
  ) SELECT s."revision", s."directoryComplete",s."fanComplete",s."jobComplete",
    (s."directoryComplete" AND s."fanComplete" AND s."jobComplete"
      AND NOT EXISTS (SELECT 1 FROM "ProviderCapacityDirty" LIMIT 1)
      AND NOT EXISTS (SELECT 1 FROM "ProviderCapacityContribution" WHERE "nextDueAt" <= $1 LIMIT 1)) AS "projectionComplete",
    COALESCE(d."itemCount",0) AS "dueCreators", COALESCE(d."overdueCount",0) AS "overdueCreators", COALESCE(d."requiredCalls",0) AS "requiredCalls",
    (SELECT "oldestAt" FROM "ProviderCapacityContribution" WHERE bucket='directory' AND "oldestAt" IS NOT NULL ORDER BY "oldestAt" LIMIT 1) AS "oldestDueAt",
    COALESCE(f."itemCount",0) AS "unsatisfiedDemands",
    (SELECT "oldestAt" FROM "ProviderCapacityContribution" WHERE bucket='fan' AND "oldestAt" IS NOT NULL ORDER BY "oldestAt" LIMIT 1) AS "oldestRequestedAt",
    COALESCE(j."itemCount",0) AS "pendingJobs", background_other.*,
    u."usageWindowStartedAt",u."usageTotalStarts",u."usageCriticalWriteStarts",u."usageInteractiveStarts",
    u."usageRealtimeStarts",u."usageNormalStarts",u."usageCampaignDirectoryStarts",u."usageCampaignFrontierStarts",
    u."usageFanDataStarts",u."usageBackgroundOtherStarts",u."usageUnclassifiedStarts"
    FROM "ProviderCapacityProjectionState" s
    LEFT JOIN "ProviderCapacityBucket" d ON d.bucket='directory'
    LEFT JOIN "ProviderCapacityBucket" f ON f.bucket='fan'
    LEFT JOIN "ProviderCapacityBucket" j ON j.bucket='job:fan_data_point_refresh'
    CROSS JOIN background_other
    LEFT JOIN "OfProviderRequestGateState" u ON u.id='of-global'
    WHERE s.id=$3`, now, OTHER_BUCKETS, ID);
  if (!rows[0]) throw failure("CAPACITY_PROJECTION_STATE_MISSING");
  return rows[0];
}

async function runProviderCapacityProjectionBatch({ db, batchSize = 96, publish } = {}) {
  if (typeof publish !== "function") throw new TypeError("capacity publish callback required");
  const size = Math.max(3, Math.min(128, Math.floor(Number(batchSize) || 96)));
  return runDbTransaction(db, async (tx) => {
    const lock = await tx.$queryRawUnsafe(`SELECT pg_try_advisory_xact_lock(hashtext('phase6-capacity-projection-v1')) AS acquired`);
    if (lock[0]?.acquired !== true) return { ok: false, skipped: true, persisted: false, reason: "capacity_projection_busy" };
    const states = await tx.$queryRawUnsafe(`SELECT * FROM "ProviderCapacityProjectionState" WHERE id=$1 FOR UPDATE`, ID);
    const state = states[0];
    if (state?.generation !== GENERATION) throw failure("CAPACITY_PROJECTION_GENERATION_MISMATCH");
    if ([...(state.jobKeys || [])].sort().join("|") !== [...CLAIMABLE_DESKTOP_JOB_KEYS].sort().join("|")) throw failure("CAPACITY_PROJECTION_CATALOG_CHANGED");
    const now = await dbAuthorityNow({ db: tx });
    const scanned = await seedBackfill(tx, state, Math.max(1, Math.floor(size / 3)));
    const processed = await repairDirty(tx, now, size);
    // End-of-batch DB clock: any newly due entry keeps coverage PARTIAL.
    const sampledAt = await dbAuthorityNow({ db: tx });
    await tx.$executeRawUnsafe(`UPDATE "ProviderCapacityProjectionState" SET "revision"="revision"+1,"sampledAt"=$2,"updatedAt"=$2 WHERE id=$1`, ID, sampledAt);
    const row = await readProjectedInputs(tx, sampledAt);
    await tx.$queryRawUnsafe(`SELECT set_config('onlinod.capacity_projection_revision',$1,true)`, String(row.revision));
    const result = await publish({ db: tx, row, now: sampledAt });
    if (result?.persisted !== true) throw failure("CAPACITY_PUBLICATION_REJECTED");
    return { ...result, scanned, processed, batchSize: size, projectionComplete: row.projectionComplete === true };
  }, { timeout: 15000, maxWait: 2000, deadlineMs: 20000, lockTimeoutMs: 2000, statementTimeoutMs: 12000, maxAttempts: 3 });
}

module.exports = { GENERATION, contributionFor, bucketDeltas, runProviderCapacityProjectionBatch };

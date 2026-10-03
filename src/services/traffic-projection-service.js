"use strict";

const { runRootCommit } = require("./db-commit-kernel");
const { lockAgencyLifecycleBarrier } = require("./agency-lifecycle-barrier-service");
const { authorizeTrafficExecutor, enterTrafficProjection } = require("./traffic-projection-authority");
const { claimDomainWorkBatch, lockDomainWorkClaimForCommit, ackDomainWorkClaim,
  yieldDomainWorkClaim, failDomainWorkClaim } = require("./domain-work-authority-service");
const PAGE = 100;
const FACT_PAGE = 25;
const fault = code => Object.assign(new Error(code), { code, status: 409 });

async function ensureTrafficProjection({ db, agencyId, creatorId }) {
  await db.$executeRawUnsafe('SELECT "onlinod_traffic_ensure_backfill_v2"($1,$2)', agencyId, creatorId);
}

// Only this finite enumerator scans creator identities, once per installation.
// New scopes are enrolled by CreatorAccount insertion and live fact capture.
async function seedTrafficProjection({ db }) {
  return runRootCommit(db, async ({ tx }) => {
    await authorizeTrafficExecutor(tx);
    const [seed] = await tx.$queryRawUnsafe('SELECT * FROM "TrafficProjectionSeed" WHERE "id"=\'v2\' FOR UPDATE SKIP LOCKED');
    if (!seed || seed.complete) return { seeded: 0 };
    const creators = await tx.creatorAccount.findMany({ where: { id: { gt: seed.cursor }, deletedAt: null },
      orderBy: { id: "asc" }, take: PAGE, select: { id: true, agencyId: true } });
    for (const creator of creators) await ensureTrafficProjection({ db: tx, agencyId: creator.agencyId, creatorId: creator.id });
    await tx.$executeRawUnsafe('UPDATE "TrafficProjectionSeed" SET "cursor"=$1,"complete"=$2 WHERE "id"=\'v2\'',
      creators.at(-1)?.id || seed.cursor, creators.length < PAGE);
    return { seeded: creators.length };
  }, { profile: "JOB_CHUNK", authority: { kind: "TRAFFIC_PROJECTION_SEED" } });
}

const BACKFILL = Object.freeze({
  SOURCES: { table: "TrafficSource", next: "CAMPAIGNS", sql: 'UPDATE "TrafficSource" SET "costCents"="costCents" WHERE "id"=$1' },
  CAMPAIGNS: { table: "CreatorCampaign", next: "CAMPAIGN_MEMBERS", fn: "onlinod_traffic_project_source_v2" },
  CAMPAIGN_MEMBERS: { table: "CreatorCampaignFan", next: "MEMBERS", fn: "onlinod_traffic_project_member_v2" },
  MEMBERS: { table: "TrafficSourceMember", next: "RECEIPTS" },
  RECEIPTS: { table: "CreatorSubscriptionLedger", next: "DONE", fn: "onlinod_traffic_receipt_project_v2" },
});

const FACTS = Object.freeze({
  CreatorCampaign: "onlinod_traffic_project_source_v2",
  CreatorCampaignFan: "onlinod_traffic_project_member_v2",
  CreatorSubscriptionLedger: "onlinod_traffic_receipt_project_v2",
});

async function factUnit(tx, item) {
  const fn = Object.hasOwn(FACTS, item.objectType) && FACTS[item.objectType];
  if (!fn) throw fault("TRAFFIC_FACT_TYPE_INVALID");
  // These functions re-read the current canonical row after the creator lock,
  // validate its scope, and apply only the old/new projection delta. A delete
  // still has a stable work identity; receipt cache supplies its former scope.
  await tx.$executeRawUnsafe(`SELECT "${fn}"($1)`, item.objectId);
  return { done: true, processed: 1 };
}

async function backfillUnit(tx, item) {
  const [state] = await tx.$queryRawUnsafe('SELECT * FROM "TrafficProjectionBackfillData" WHERE "creatorId"=$1 AND "agencyId"=$2 FOR UPDATE', item.creatorId, item.agencyId);
  if (!state || state.completedAt) return { done: true };
  if (state.stage === "RETIRE") {
    const jobs = await tx.jobInstance.findMany({ where: { agencyId: item.agencyId, creatorId: item.creatorId, jobKey: "traffic_sources_scan",
      status: { in: ["SCHEDULED", "CLAIMED", "PAUSED"] } }, orderBy: { id: "asc" }, take: PAGE, select: { id: true } });
    if (jobs.length) await tx.jobInstance.updateMany({ where: { id: { in: jobs.map(j => j.id) }, status: { in: ["SCHEDULED", "CLAIMED", "PAUSED"] } },
      data: { status: "CANCELLED", leaseUntil: null, leaseTokenHash: null, leaseRevision: { increment: 1 }, lastError: "TRAFFIC_SOURCE_JOB_RETIRED" } });
    if (jobs.length < PAGE) await tx.$executeRawUnsafe('UPDATE "TrafficProjectionBackfillData" SET "stage"=\'SOURCES\',"cursor"=\'\' WHERE "creatorId"=$1', item.creatorId);
    return { done: false, stage: "RETIRE", processed: jobs.length };
  }
  const spec = BACKFILL[state.stage];
  if (!spec) throw fault("TRAFFIC_BACKFILL_STAGE_INVALID");
  // Table/function names are closed constants, never client input.
  const rows = await tx.$queryRawUnsafe(`SELECT "id","agencyId","creatorId"${state.stage === "MEMBERS" ? ',"fanId"' : ""}
    FROM "${spec.table}" WHERE "creatorId"=$1 AND "agencyId"=$2 AND "id">$3 ORDER BY "id" LIMIT $4`,
  state.creatorId, state.agencyId, state.cursor, PAGE);
  for (const row of rows) {
    if (spec.fn) await tx.$executeRawUnsafe(`SELECT "${spec.fn}"($1)`, row.id);
    else if (spec.sql) await tx.$executeRawUnsafe(spec.sql, row.id);
    else await tx.$executeRawUnsafe('SELECT "onlinod_traffic_dirty_fan_v2"($1,$2,$3)', row.agencyId, row.creatorId, row.fanId);
  }
  const more = rows.length === PAGE;
  const stage = more ? state.stage : spec.next;
  await tx.$executeRawUnsafe(`UPDATE "TrafficProjectionBackfillData" SET "stage"=$2,"cursor"=$3,
    "completedAt"=CASE WHEN $2='DONE' THEN CURRENT_TIMESTAMP ELSE NULL END,"updatedAt"=CURRENT_TIMESTAMP WHERE "creatorId"=$1`,
  state.creatorId, stage, more ? rows.at(-1).id : "");
  return { done: stage === "DONE", stage, processed: rows.length };
}

async function fanUnit(tx, item, cursor) {
  // Canonical producers own only the signal. The derived row is created here,
  // after the Traffic lock; producers never wait for it while holding DWI.
  await tx.$executeRawUnsafe(`INSERT INTO "TrafficFanProjection"("id","agencyId","creatorId","fanId")
    SELECT "id","agencyId","creatorId","fanId" FROM "TrafficFanSignal"
    WHERE "id"=$1 AND "creatorId"=$2 AND "agencyId"=$3 ON CONFLICT DO NOTHING`,item.objectId,item.creatorId,item.agencyId);
  const [fan] = await tx.$queryRawUnsafe('SELECT * FROM "TrafficFanProjection" WHERE "id"=$1 AND "creatorId"=$2 AND "agencyId"=$3', item.objectId, item.creatorId, item.agencyId);
  if (!fan) return { done: true };
  if (cursor.stage === "ATTRIBUTION") {
    const member = await tx.trafficSourceMember.findFirst({ where: { creatorId: fan.creatorId, agencyId: fan.agencyId, fanId: fan.fanId },
      orderBy: [{ lastSeenAt: "desc" }, { id: "desc" }], select: { sourceId: true } });
    if (!member) return { done: true };
    // Canonical receipt captures only publish work. They never wait for the
    // Traffic lock, so taking receipt rows here cannot invert that lock order.
    const receipts = await tx.$queryRawUnsafe(`SELECT "id" FROM "CreatorSubscriptionLedger"
      WHERE "creatorId"=$1 AND "agencyId"=$2 AND "fanId"=$3 AND "sourceId" IS NULL
      ORDER BY "id" LIMIT $4 FOR UPDATE SKIP LOCKED`, fan.creatorId, fan.agencyId, fan.fanId, PAGE);
    if (receipts.length) await tx.creatorSubscriptionLedger.updateMany({ where: {
      creatorId: fan.creatorId, agencyId: fan.agencyId, fanId: fan.fanId, sourceId: null, id: { in: receipts.map(r => r.id) },
    }, data: { sourceId: member.sourceId, organicConfirmed: false, attributionAttempts: 0 } });
    // A locked receipt must remain debt; SKIP LOCKED is not proof of exhaustion.
    const pending = await tx.creatorSubscriptionLedger.findFirst({ where: { creatorId: fan.creatorId, agencyId: fan.agencyId,
      fanId: fan.fanId, sourceId: null }, select: { id: true } });
    return { done: !pending, cursor: { stage: "ATTRIBUTION" }, processed: receipts.length };
  }
  await tx.$executeRawUnsafe('SELECT "onlinod_traffic_lock_v2"($1)', fan.creatorId);
  const rows = await tx.trafficSourceMember.findMany({ where: { creatorId: fan.creatorId, agencyId: fan.agencyId,
    fanId: fan.fanId, ...(cursor.id ? { id: { gt: cursor.id } } : {}) }, orderBy: { id: "asc" }, take: PAGE, select: { id: true } });
  let unique = cursor.metrics || {};
  let pending = cursor.pending === true;
  for (const row of rows) {
    const [result] = await tx.$queryRawUnsafe('SELECT "onlinod_traffic_member_metrics_v2"($1) AS metrics', row.id);
    unique = result.metrics; pending ||= Number(unique.valuePendingMembers) > 0;
  }
  if (rows.length === PAGE) return { done: false, processed: rows.length, cursor: { id: rows.at(-1).id, metrics: unique, pending } };
  if (Object.keys(unique).length) unique.valuePendingMembers = pending ? 1 : 0;
  await tx.$executeRawUnsafe('SELECT "onlinod_traffic_add_v2"($1,$2,\'total\',\'\',\'*\',"onlinod_traffic_delta_v2"($3::jsonb,$4::jsonb))',
    fan.agencyId, fan.creatorId, JSON.stringify(fan.metrics), JSON.stringify(unique));
  await tx.$executeRawUnsafe('UPDATE "TrafficFanProjection" SET "metrics"=$2::jsonb,"updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1', fan.id, JSON.stringify(unique));
  return { done: false, cursor: { stage: "ATTRIBUTION" }, processed: rows.length };
}

async function runTrafficProjectionItems({ db, items, ownerToken }) {
  const item = items[0];
  if (!item || items.length>FACT_PAGE || items.some(row=>row.agencyId!==item.agencyId || row.creatorId!==item.creatorId)
    || (items.length>1 && items.some(row=>row.workClass!=="TRAFFIC_FACT"))) throw fault("TRAFFIC_BATCH_SCOPE_INVALID");
  return runRootCommit(db, async ({ tx }) => {
    const lifecycle = await lockAgencyLifecycleBarrier({ db: tx, agencyId: item.agencyId });
    const creators = await tx.$queryRawUnsafe('SELECT "id" FROM "CreatorAccount" WHERE "id"=$1 AND "agencyId"=$2 AND "deletedAt" IS NULL FOR SHARE', item.creatorId, item.agencyId);
    const active = lifecycle.row && !lifecycle.row.deletedAt && creators.length;
    if (active) await enterTrafficProjection(tx, item.creatorId);
    const results = [];
    for (const item of items) {
      if (creators.length && await require("./analytics-projection-lifecycle-service").pauseDeletedAgencyProjection({ db: tx, lifecycle, item, ownerToken })) {
        results.push({ done: false, paused: true });
        continue;
      }
      const cursor = item.progressCursor && String(item.progressCursor.revision) === String(item.claimedRevision) ? item.progressCursor : {};
      let result = { done: true, retired: true };
      if (active) {
        if (item.workClass === "TRAFFIC_BACKFILL") result = await backfillUnit(tx, item);
        else if (item.workClass === "TRAFFIC_FAN") result = await fanUnit(tx, item, cursor);
        else if (item.workClass === "TRAFFIC_FACT") result = await factUnit(tx, item);
        else throw fault("TRAFFIC_WORK_CLASS_INVALID");
      }
      // Capture writers may raise requestedRevision while we work. Progress and
      // fenced yield/ack share this transaction. Lost ownership rolls back deltas.
      const fence = await lockDomainWorkClaimForCommit({ db: tx, item, ownerToken });
      if (!fence.current) throw fault("TRAFFIC_PROJECTION_CLAIM_LOST");
      const settled = result.done ? await ackDomainWorkClaim({ db: tx, item, ownerToken })
        : await yieldDomainWorkClaim({ db: tx, item, ownerToken,
          progressCursor: { ...(result.cursor || {}), revision: String(item.claimedRevision) } });
      if (settled.lost) throw fault("TRAFFIC_PROJECTION_CLAIM_LOST");
      results.push(result);
    }
    return results;
  }, { profile: "JOB_CHUNK", authority: { kind: "TRAFFIC_PROJECTION", agencyId: item.agencyId, creatorId: item.creatorId } });
}

async function runTrafficProjectionUnit({db,item,ownerToken}) {
  return (await runTrafficProjectionItems({db,items:[item],ownerToken}))[0];
}

async function runTrafficProjectionSweep({ db, limit = 4 }) {
  const seed = await seedTrafficProjection({ db });
  const results = [];
  // Separate queues prevent a large rebuild from starving current observations.
  for (const workClass of ["TRAFFIC_FACT", "TRAFFIC_FAN", "TRAFFIC_BACKFILL"]) {
    const facts=workClass==="TRAFFIC_FACT";
    const take=Math.max(1,Math.min(8,Number(limit)||4));
    const batch = await claimDomainWorkBatch({ db, workClass, limit:facts?Math.min(PAGE,take*FACT_PAGE):take,
      perAgencyQuantum:facts?FACT_PAGE:2,perPartitionQuantum:facts?FACT_PAGE:1 });
    const groups=[];
    for(const item of batch.items||[]) {
      let group=facts&&groups.find(rows=>rows.length<FACT_PAGE && rows[0].agencyId===item.agencyId && rows[0].creatorId===item.creatorId);
      if(!group){group=[];groups.push(group);}group.push(item);
    }
    for (const items of groups) {
      if(items.length>1) {
        try {results.push(...await runTrafficProjectionItems({db,items,ownerToken:batch.ownerToken}));continue;}
        catch (_) { /* The whole batch rolled back. Isolate a bad/stolen item below. */ }
      }
      for (const item of items) {
        try { results.push(await runTrafficProjectionUnit({ db, item, ownerToken: batch.ownerToken })); }
        catch (error) {
          await failDomainWorkClaim({ db, item, ownerToken: batch.ownerToken, error });
          results.push({ error: String(error.code || error.message) });
        }
      }
    }
  }
  return { ok: results.every(r => !r.error), seed, processed: results.length, results };
}

module.exports = { PAGE, FACT_PAGE, ensureTrafficProjection, seedTrafficProjection, runTrafficProjectionUnit, runTrafficProjectionItems, runTrafficProjectionSweep };

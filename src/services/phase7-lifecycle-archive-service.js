"use strict";
const { authorizeLegacyLifecycle, legacyTablePresent, failure } = require('./phase7-legacy-storage-service');
const { handoffLegacyJob } = require('./phase7-obligation-handoff-service');

async function drainLifecycleLegacyJobs({ tx, agencyId, creatorId = null, limit = 10 }) {
  await authorizeLegacyLifecycle(tx,{agencyId,creatorId});
  const pending = await tx.automationDelivery.findFirst({where:{agencyId,...(creatorId?{creatorId}:{}),moduleKey:'sfs',actionType:'SFS_UNFOLLOW_TARGET',
    payload:{path:['legacyMigration'],equals:true},status:{in:['QUEUED','CLAIMED','RUNNING','COMMITTING','RECONCILE_REQUIRED','RETRY_SCHEDULED','PAUSED']}},select:{id:true}});
  if (pending) throw failure('PHASE7_PENDING_SFS_CLEANUP_BLOCKS_LIFECYCLE',{deliveryId:pending.id});
  if (!await legacyTablePresent(tx,'AutomationJob')) return {deleted:0,hasMore:false};
  const count=Math.max(1,Math.min(25,limit));
  const scope=creatorId ? `AND (x."creatorId"=$2 OR x."accountId"=$2 OR EXISTS
    (SELECT 1 FROM "AutomationTask" t WHERE t."id"=x."taskId" AND t."agencyId"=$1 AND t."creatorId"=$2))` : '';
  const params=creatorId?[agencyId,creatorId]:[agencyId];
  // Fetch sizes first; the deletion owner must not materialize arbitrary legacy
  // payloads merely because a tenant requested deletion.
  const meta=await tx.$queryRawUnsafe(`WITH keys AS MATERIALIZED (
    SELECT x."id" FROM "AutomationJob" x WHERE x."agencyId"=$1 ${scope} ORDER BY x."id" LIMIT ${count+1}
  ) SELECT x."id",octet_length(to_jsonb(x)::text) AS bytes FROM keys k JOIN "AutomationJob" x ON x."id"=k."id" ORDER BY x."id"`,...params);
  if (!meta.length) return {deleted:0,hasMore:false};
  const ids=[];let bytes=0;
  for (const row of meta.slice(0,count)) {
    if (Number(row.bytes)>8388608) throw failure('PHASE7_LIFECYCLE_OVERSIZE_REQUIRES_ARCHIVE_RECOVERY',{sourceId:row.id});
    if (bytes+Number(row.bytes)>8388608) break;
    ids.push(row.id);bytes+=Number(row.bytes);
  }
  const jobs=await tx.$queryRawUnsafe(`SELECT to_jsonb(x)::text AS body,
    encode(sha256(convert_to(to_jsonb(x)::text,'UTF8')),'hex') AS hash
    FROM "AutomationJob" x WHERE x."agencyId"=$1 AND x."id"=ANY($2::text[]) ORDER BY x."id" FOR UPDATE`,agencyId,ids);
  for (const row of jobs) {
    const proof=await handoffLegacyJob({db:tx,job:JSON.parse(row.body),sourceHash:row.hash});
    if (proof.kind==='SFS_CLEANUP') throw failure('PHASE7_PENDING_SFS_CLEANUP_BLOCKS_LIFECYCLE',{deliveryId:proof.deliveryId});
  }
  const deleted=Number(await tx.$executeRawUnsafe('DELETE FROM "AutomationJob" WHERE "agencyId"=$1 AND "id"=ANY($2::text[])',agencyId,ids));
  return {deleted,hasMore:meta.length>ids.length};
}
module.exports={drainLifecycleLegacyJobs};

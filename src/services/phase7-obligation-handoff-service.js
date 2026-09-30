"use strict";
const { object, sha, failure, putProof, runDbTransaction, lockDbAdvisoryXact } = require('./phase7-legacy-storage-service');
const P14 = '20260715153000_p14_sfs_automation';
const md5 = v => require('node:crypto').createHash('md5').update(v).digest('hex');
const SETTLED = new Set(['COMPLETED', 'SKIPPED']);
function targetOf(job) {
  const p = object(job.payload); const a = String(job.fanId || '').trim(), b = String(p.targetUserId || '').trim();
  if (a && b && a !== b) throw failure('PHASE7_LEGACY_TARGET_CONFLICT');
  return a || b || null;
}
async function handoffLegacyJob({ db, job, sourceHash }) {
  return runDbTransaction(db, async tx => {
    const payload = object(job.payload), result = object(job.result);
    const base = { cohortId: 'automation_job', sourceTable: 'AutomationJob', sourceId: job.id, sourceHash,
      agencyId: job.agencyId, creatorId: job.creatorId || job.accountId || null };
    if (job.type === 'sfs_hunter' && ['sfs_used_marker','sfs_unfollow_due'].includes(job.action)) {
      const targetId = targetOf(job), creatorId = job.creatorId;
      if (!creatorId || !targetId) throw failure('PHASE7_SFS_SCOPE_UNPROVEN', { sourceId: job.id });
      await lockDbAdvisoryXact({ db: tx, key: `p14:sfs-target:${job.agencyId}:${creatorId}:${targetId}` });
      const creator = await tx.creatorAccount.findFirst({ where: { id: creatorId, agencyId: job.agencyId }, select: { id: true, remoteId: true } });
      const candidate = await tx.sfsTargetCandidate.findFirst({ where: { agencyId: job.agencyId, creatorId, targetUserId: targetId } });
      if (job.action === 'sfs_used_marker') {
        if (job.status !== 'done') throw failure('PHASE7_CONSUMPTION_STATUS_UNPROVEN');
        const proof = await putProof(tx, { ...base, creatorId, targetId, providerSubject: creator?.remoteId || null,
          kind: 'CONSUMED', consumptionKey: sha(JSON.stringify([job.agencyId,creatorId,targetId])),
          evidence: { basis: 'LEGACY_SFS_USED_MARKER', completedAt: job.completedAt || null } });
        // Never rewrite current workflow/generation or create a new creator.
        if (candidate && !candidate.usedForever) await tx.sfsTargetCandidate.update({ where: { id: candidate.id }, data: { usedForever: true } });
        return proof;
      }
      if (!creator?.remoteId || !candidate) throw failure('PHASE7_SFS_OWNER_UNPROVEN');
      const existing = await tx.automationDelivery.findMany({ where: { agencyId: job.agencyId, creatorId,
        moduleKey: 'sfs', actionType: 'SFS_UNFOLLOW_TARGET', payload: { path: ['sourceJobId'], equals: job.id } }, take: 2 });
      if (existing.length > 1) throw failure('PHASE7_SFS_DELIVERY_CONFLICT');
      let delivery = existing[0];
      const follow = await tx.automationDelivery.findFirst({ where: { agencyId: job.agencyId, creatorId,
        moduleKey: 'sfs', actionType: 'SFS_FOLLOW_TARGET', fanId: targetId, generation: delivery?.generation ?? candidate.generation,
        status: 'COMPLETED', writeCommitAt: { not: null }, result: { path: ['code'], equals: 'followed' } },
        orderBy: { finishedAt: 'desc' }, select: { id: true, generation: true, writeCommitAt: true } });
      let basis = follow ? 'CURRENT_FOLLOW_RECEIPT' : null;
      if (!delivery && follow) {
        const idempotencyKey = `sfs_unfollow:${creatorId}:${targetId}:${follow.generation}`;
        const id = 'phase7_cleanup_' + sha(idempotencyKey).slice(0,32);
        const data = { candidateId: candidate.id, safetyCleanup: true, legacyMigration: true, sourceJobId: job.id };
        await tx.$executeRawUnsafe(`INSERT INTO "AutomationDelivery"
          ("id","agencyId","creatorId","originKind","moduleKey","actionType","targetId","fanId","idempotencyKey","generation",
           "priority","payload","status","scheduledAt","notBefore","maxAttempts","updatedAt")
          VALUES($1,$2,$3,'AUTOMATION','sfs','SFS_UNFOLLOW_TARGET',$4,$4,$5,$6,120,$7::jsonb,'QUEUED',CURRENT_TIMESTAMP,$8,20,CURRENT_TIMESTAMP)
          ON CONFLICT("idempotencyKey") DO NOTHING`, id,job.agencyId,creatorId,targetId,idempotencyKey,follow.generation,JSON.stringify(data),new Date(job.runAfter));
        delivery = await tx.automationDelivery.findUnique({ where: { idempotencyKey } });
      }
      if (!delivery || delivery.agencyId !== job.agencyId || delivery.creatorId !== creatorId
          || delivery.targetId !== targetId || delivery.fanId !== targetId || delivery.moduleKey !== 'sfs'
          || delivery.actionType !== 'SFS_UNFOLLOW_TARGET' || object(delivery.payload).candidateId !== candidate.id
          || object(delivery.payload).sourceJobId !== job.id) throw failure('PHASE7_SFS_DELIVERY_IDENTITY_UNPROVEN');
      if (SETTLED.has(delivery.status)) {
        if (delivery.status !== 'COMPLETED' || !['unfollowed','already_unfollowed','unfollowed_recovered'].includes(String(object(delivery.result).code || ''))) throw failure('PHASE7_SFS_SETTLEMENT_UNPROVEN');
        return putProof(tx, { ...base, creatorId,targetId,providerSubject:creator.remoteId,kind:'SETTLED',generation:delivery.generation,
          deliveryId:delivery.id,evidence:{basis:'CURRENT_CLEANUP_RECEIPT',candidateId:candidate.id} });
      }
      if (!basis) {
        const migrations = await tx.$queryRawUnsafe('SELECT "checksum","started_at","finished_at" FROM "_prisma_migrations" WHERE "migration_name"=$1 AND "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL', P14);
        const migration = migrations[0];
        // The fixed P14 receipt identity + pre-migration source + original tuple
        // prove prior acceptance. Two mutable legacy flags alone never suffice.
        if (migration && migrations.length === 1 && delivery.id === 'p14_sfs_cleanup_' + md5(job.id).slice(0,20)
            && delivery.generation === 1 && new Date(job.createdAt) <= new Date(migration.started_at)
            && job.error === 'P14_LEGACY_SFS_DISABLED' && job.status === 'canceled'
            && delivery.idempotencyKey === `sfs_unfollow:${creatorId}:${targetId}:1`)
          basis = 'P14_ACCEPTED_COMPENSATION:' + migration.checksum;
      }
      if (!basis) throw failure('PHASE7_SFS_FOLLOW_AUTHORITY_UNPROVEN');
      const meta = object(candidate.metadata);
      if (candidate.safetyUnfollowDeliveryId && candidate.safetyUnfollowDeliveryId !== delivery.id)
        throw failure('PHASE7_SFS_NEWER_CLEANUP_CONFLICT');
      if (meta.followEffectOwnership === 'OWNED' && meta.followEffectDeliveryId && meta.followEffectDeliveryId !== follow?.id)
        throw failure('PHASE7_SFS_NEWER_FOLLOW_CONFLICT');
      const proof = await putProof(tx, { ...base, creatorId,targetId,providerSubject:creator.remoteId,kind:'SFS_CLEANUP',
        generation:delivery.generation,deliveryId:delivery.id,evidence:{basis,candidateId:candidate.id,followDeliveryId:follow?.id || null} });
      await tx.automationDelivery.update({where:{id:delivery.id},data:{legacyCleanupProofId:proof.id}});
      if (candidate.safetyUnfollowDeliveryId !== delivery.id) await tx.sfsTargetCandidate.update({ where: { id: candidate.id }, data: { safetyUnfollowDeliveryId: delivery.id } });
      return proof;
    }
    // Terminal does not mean no external effect. Preserve confirmed completion;
    // cancellation is safe only when the recorded job never acquired execution.
    if (job.type !== 'sfs_hunter' && job.status === 'done' && job.completedAt) {
      return putProof(tx, { ...base,kind:'SETTLED',evidence:{basis:'LEGACY_RECORDED_COMPLETION',type:job.type,action:job.action} });
    }
    const knownRetirement = /^P(14|15)_/.test(String(job.error || ''));
    if (['canceled','expired'].includes(job.status) && Number(job.attempts) === 0 && !job.claimedAt && !job.claimedByDeviceId
        && !Object.keys(result).length && knownRetirement && job.action !== 'sfs_unfollow_due') {
      return putProof(tx, { ...base,kind:'NO_EFFECT',evidence:{basis:'NEVER_ATTEMPTED_RETIRED_JOB',type:job.type,action:job.action} });
    }
    throw failure('PHASE7_LEGACY_OBLIGATION_RECONCILE_REQUIRED', { sourceId: job.id, action: job.action, jobStatus: job.status });
  }, { timeout: 10000 });
}
module.exports = { handoffLegacyJob, targetOf };

// Existing cleanup can outlive its old Job. Its current completed FOLLOW receipt
// is an independent admissible basis; missing historical evidence stays blocked.
async function handoffExistingCleanup({ db, deliveryId }) {
  return runDbTransaction(db, async tx => {
    const delivery = await tx.automationDelivery.findUnique({where:{id:deliveryId}});
    if (!delivery || delivery.moduleKey !== 'sfs' || delivery.actionType !== 'SFS_UNFOLLOW_TARGET'
        || object(delivery.payload).legacyMigration !== true) throw failure('PHASE7_CLEANUP_SOURCE_INVALID');
    if (delivery.legacyCleanupProofId) return {proofId:delivery.legacyCleanupProofId,duplicate:true};
    await lockDbAdvisoryXact({db:tx,key:`p14:sfs-target:${delivery.agencyId}:${delivery.creatorId}:${delivery.targetId}`});
    const candidate = await tx.sfsTargetCandidate.findFirst({where:{id:object(delivery.payload).candidateId,
      agencyId:delivery.agencyId,creatorId:delivery.creatorId,targetUserId:delivery.targetId}});
    if (!candidate || delivery.fanId !== candidate.targetUserId || candidate.safetyUnfollowDeliveryId !== delivery.id) throw failure('PHASE7_CLEANUP_SOURCE_CONFLICT');
    const creator = await tx.creatorAccount.findFirst({where:{id:delivery.creatorId,agencyId:delivery.agencyId},select:{remoteId:true}});
    const follow = await tx.automationDelivery.findFirst({where:{agencyId:delivery.agencyId,creatorId:delivery.creatorId,
      moduleKey:'sfs',actionType:'SFS_FOLLOW_TARGET',fanId:delivery.targetId,generation:delivery.generation,status:'COMPLETED',
      writeCommitAt:{not:null},result:{path:['code'],equals:'followed'}},orderBy:{finishedAt:'desc'}});
    if (!follow || !creator?.remoteId) throw failure('PHASE7_CLEANUP_SOURCE_PROOF_MISSING');
    const metadata=object(candidate.metadata);
    if (metadata.followEffectOwnership==='OWNED' && metadata.followEffectDeliveryId && metadata.followEffectDeliveryId!==follow.id) throw failure('PHASE7_SFS_NEWER_FOLLOW_CONFLICT');
    const hashes=await tx.$queryRawUnsafe(`SELECT encode(sha256(convert_to(to_jsonb(x)::text,'UTF8')),'hex') AS h FROM "AutomationDelivery" x WHERE "id"=$1`,delivery.id);
    const proof=await putProof(tx,{cohortId:'automation_job',sourceTable:'AutomationDelivery',sourceId:delivery.id,sourceHash:hashes[0].h,
      agencyId:delivery.agencyId,creatorId:delivery.creatorId,providerSubject:creator.remoteId,targetId:delivery.targetId,
      kind:'SFS_CLEANUP',generation:delivery.generation,deliveryId:delivery.id,
      evidence:{basis:'CURRENT_FOLLOW_RECEIPT',candidateId:candidate.id,followDeliveryId:follow.id}});
    await tx.automationDelivery.update({where:{id:delivery.id},data:{legacyCleanupProofId:proof.id}});
    return {proofId:proof.id};
  },{timeout:10000});
}
async function handoffCleanupPage({db,after=null,limit=20}) {
  const count=Math.max(1,Math.min(100,limit));
  const rows=await db.$queryRawUnsafe(`SELECT "id","agencyId" FROM "AutomationDelivery"
    WHERE "moduleKey"='sfs' AND "actionType"='SFS_UNFOLLOW_TARGET' AND "payload"->>'legacyMigration'='true'
    AND "legacyCleanupProofId" IS NULL AND "status" IN ('QUEUED','CLAIMED','RUNNING','COMMITTING','RECONCILE_REQUIRED','RETRY_SCHEDULED','PAUSED')
    AND ($1::text IS NULL OR ("agencyId","id")>($1,$2)) ORDER BY "agencyId","id" LIMIT $3`,after?.agencyId||null,after?.id||null,count);
  const results=[];
  for (const row of rows) {
    try { results.push({id:row.id,...await handoffExistingCleanup({db,deliveryId:row.id})}); }
    catch(error) { results.push({id:row.id,blocked:true,code:error.code||'HANDOFF_FAILED'}); }
  }
  return {results,nextCursor:rows.length?{agencyId:rows.at(-1).agencyId,id:rows.at(-1).id}:null,hasMore:rows.length===count};
}
module.exports.handoffExistingCleanup=handoffExistingCleanup;
module.exports.handoffCleanupPage=handoffCleanupPage;

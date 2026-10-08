'use strict';
const {failure,putProof,legacyTablePresent,transactionRequired,manifest}=require('./phase7-legacy-storage-service');
const {lockAgencyLifecycleBarrier}=require('./agency-lifecycle-barrier-service');
const contract=require('./phase7-cleanup-contract');

async function lockScope(tx,{agencyId,creatorId}) {
  transactionRequired(tx);
  if(!agencyId)throw failure('PHASE7_LIFECYCLE_SCOPE_REQUIRED');
  if(creatorId)return require('./sfs-mutation-authority-service').lockSfsScope(tx,{agencyId,creatorId});
  const agency=await lockAgencyLifecycleBarrier({db:tx,agencyId});
  if(!agency.row)throw failure('PHASE7_OBLIGATION_AGENCY_ABSENT');
  return null;
}
// Compatibility entry point for the shared current/legacy SFS mutation prefix.
async function lockCleanupMutation(tx,delivery) {
  return require('./sfs-mutation-authority-service').lockSfsDeliveryMutation(tx,delivery);
}
async function readLegacySource(tx,{id,agencyId,sourceHash,optional=false}) {
  transactionRequired(tx);
  if(!await legacyTablePresent(tx,'AutomationJob')){
    if(optional)return null;
    throw failure('PHASE7_LEGACY_SOURCE_ABSENT');
  }
  const rows=await tx.$queryRawUnsafe(`SELECT CASE WHEN octet_length(to_jsonb(x)::text)<=$3 THEN to_jsonb(x)::text ELSE NULL END AS body,
    encode(sha256(convert_to(to_jsonb(x)::text,'UTF8')),'hex') AS hash
    FROM "AutomationJob" x WHERE "id"=$1 AND "agencyId"=$2 FOR UPDATE`,id,agencyId,manifest.pageBytes);
  if(!rows.length){if(optional)return null;throw failure('PHASE7_LEGACY_SOURCE_ABSENT',{sourceId:id});}
  if(!rows[0].body)throw failure('PHASE7_LIFECYCLE_OVERSIZE_REQUIRES_ARCHIVE_RECOVERY',{sourceId:id});
  if(sourceHash!==undefined&&(!/^[a-f0-9]{64}$/.test(sourceHash)||sourceHash!==rows[0].hash))throw failure('PHASE7_LEGACY_SOURCE_CHANGED',{sourceId:id});
  return {job:JSON.parse(rows[0].body),sourceHash:rows[0].hash};
}
async function lockCandidate(tx,{agencyId,creatorId,targetId}) {
  const rows=await tx.$queryRawUnsafe('SELECT "id" FROM "SfsTargetCandidate" WHERE "agencyId"=$1 AND "creatorId"=$2 AND "targetUserId"=$3 FOR UPDATE',agencyId,creatorId,targetId);
  if(rows.length!==1)throw failure('PHASE7_SFS_OWNER_UNPROVEN');
  return tx.sfsTargetCandidate.findUnique({where:{id:rows[0].id}});
}
async function lockDelivery(tx,id) {
  const rows=await tx.$queryRawUnsafe('SELECT "id" FROM "AutomationDelivery" WHERE "id"=$1 FOR UPDATE',id);
  return rows.length?tx.automationDelivery.findUnique({where:{id}}):null;
}
async function attachedProof(tx,{delivery,candidate,creator}) {
  if(!delivery?.legacyCleanupProofId)return null;
  const proof=await tx.phase7RetirementProof.findUnique({where:{id:delivery.legacyCleanupProofId}});
  if(!contract.matchesSfsAttestation({proof,delivery,candidate,providerSubject:creator?.remoteId}))throw failure('PHASE7_CLEANUP_ATTESTATION_STALE',{deliveryId:delivery.id});
  return proof;
}
// Exactly one execution attestation owns a delivery. A second frozen source is
// represented by an immutable source receipt pointing to that attestation;
// deliveryId remains null, so it can never be mistaken for execution authority.
async function representLegacySource(tx,{source,proof}) {
  const {job,sourceHash}=source;
  if(proof.sourceTable==='AutomationJob'&&proof.sourceId===job.id&&proof.sourceHash===sourceHash)return proof;
  const link=await putProof(tx,{cohortId:'automation_job',sourceTable:'AutomationJob',sourceId:job.id,sourceHash,
    agencyId:job.agencyId,creatorId:job.creatorId,providerSubject:proof.providerSubject,targetId:proof.targetId,generation:proof.generation,
    kind:'SFS_CLEANUP',evidence:{basis:'ATTESTED_CLEANUP_REFERENCE',cleanupProofId:proof.id,cleanupDeliveryId:proof.deliveryId,
      candidateId:proof.evidence.candidateId}});
  return {...proof,sourceReceiptId:link.id};
}
async function recordCleanupSettlement(tx,{delivery,candidate,creator,proof}) {
  transactionRequired(tx);
  if(!contract.isLegacyCleanup(delivery)||!contract.isSettledCleanup(delivery))throw failure('PHASE7_SFS_SETTLEMENT_UNPROVEN');
  await preserveCleanupSettlements(tx,[delivery.id]);
  const settled=await settlementForDelivery(tx,delivery);
  if(!settled)throw failure('PHASE7_SFS_SETTLEMENT_UNPROVEN');
  return settled;
}
async function preserveCleanupSettlements(tx,ids) {
  transactionRequired(tx);
  if(!Array.isArray(ids)||ids.length>500)throw failure('PHASE7_SETTLEMENT_BATCH_INVALID');
  if(!ids.length)return 0;
  const rows=await tx.$queryRawUnsafe('SELECT phase7_preserve_cleanup_settlements($1::text[]) AS count',ids);
  return Number(rows[0].count);
}
async function settlementForDelivery(tx,delivery) {
  const rows=await tx.phase7RetirementProof.findMany({where:{sourceTable:'AutomationDelivery',sourceId:delivery.id,kind:'SETTLED',deliveryId:delivery.id},take:2});
  if(rows.length>1)throw failure('PHASE7_SFS_SETTLEMENT_CONFLICT');
  return rows[0]&&contract.matchesSettlementProof(rows[0],delivery)?rows[0]:null;
}
async function recoverSettledSource(tx,source,targetId) {
  const {job,sourceHash}=source;
  const links=await tx.phase7RetirementProof.findMany({where:{sourceTable:'AutomationJob',sourceId:job.id,sourceHash,kind:'SFS_CLEANUP'},take:2});
  if(!links.length)return null;
  if(links.length!==1)throw failure('PHASE7_SFS_SETTLEMENT_CONFLICT');
  const link=links[0];
  if(link.agencyId!==job.agencyId||link.creatorId!==job.creatorId||link.targetId!==targetId)throw failure('PHASE7_SFS_SETTLEMENT_CONFLICT');
  const canonical=link.deliveryId?link:await tx.phase7RetirementProof.findUnique({where:{id:link.evidence?.cleanupProofId||''}});
  if(!canonical||(!link.deliveryId&&(link.evidence?.basis!=='ATTESTED_CLEANUP_REFERENCE'
      ||link.evidence.cleanupDeliveryId!==canonical.deliveryId||link.generation!==canonical.generation
      ||link.evidence.candidateId!==canonical.evidence?.candidateId))
      ||canonical.agencyId!==job.agencyId||canonical.creatorId!==job.creatorId||canonical.targetId!==targetId)
    throw failure('PHASE7_SFS_SETTLEMENT_CONFLICT');
  const settled=await tx.phase7RetirementProof.findMany({where:{sourceTable:'AutomationDelivery',sourceId:canonical.deliveryId,kind:'SETTLED'},take:2});
  if(!settled.length)return null;
  if(settled.length!==1||!contract.matchesSettledAttestation(settled[0],canonical))throw failure('PHASE7_SFS_SETTLEMENT_CONFLICT');
  return putProof(tx,{cohortId:'automation_job',sourceTable:'AutomationJob',sourceId:job.id,sourceHash,agencyId:job.agencyId,
    creatorId:job.creatorId,targetId,providerSubject:canonical.providerSubject,kind:'SETTLED',generation:canonical.generation,
    deliveryId:canonical.deliveryId,evidence:{basis:'CURRENT_CLEANUP_RECEIPT',candidateId:canonical.evidence.candidateId,
      cleanupProofId:canonical.id,settlementProofId:settled[0].id}});
}
async function assertSfsRetirable({db,agencyId,creatorId=null}) {
  transactionRequired(db);
  const values=creatorId?[agencyId,creatorId]:[agencyId];
  const scope=`"agencyId"=$1${creatorId?' AND "creatorId"=$2':''}`;
  const checks=[
    `SELECT "id" FROM "AutomationDelivery" WHERE ${scope} AND ${contract.UNSETTLED_SQL} LIMIT 1`,
    `SELECT "id" FROM "AutomationDelivery" WHERE ${scope} AND "moduleKey"='sfs' AND "actionType"='SFS_FOLLOW_TARGET'
      AND "status" IN ('CLAIMED','RUNNING','COMMITTING','RECONCILE_REQUIRED') LIMIT 1`,
    `SELECT "id" FROM "SfsTargetCandidate" WHERE ${scope} AND "completedAt" IS NULL
      AND ("metadata"->>'followEffectOwnership'='OWNED' OR "metadata"->>'legacyMigration'='true') LIMIT 1`,
  ];
  for(const sql of checks){const rows=await db.$queryRawUnsafe(sql,...values);if(rows.length)throw failure('SFS_CLEANUP_BLOCKS_RETIREMENT',{
    message:'Finish or reconcile SFS cleanup before removing this creator or agency.',objectId:rows[0].id});}
  if(await legacyTablePresent(db,'AutomationJob')){
    const rows=await db.$queryRawUnsafe(`SELECT j."id" FROM "AutomationJob" j WHERE j."agencyId"=$1 ${creatorId?'AND j."creatorId"=$2':''}
      AND j."type"='sfs_hunter' AND j."action"='sfs_unfollow_due'
      AND NOT EXISTS(SELECT 1 FROM "Phase7RetirementProof" p WHERE p."sourceTable"='AutomationJob' AND p."sourceId"=j."id"
        AND p."kind"='SETTLED' AND p."sourceHash"=encode(sha256(convert_to(to_jsonb(j)::text,'UTF8')),'hex')) LIMIT 1`,...values);
    if(rows.length)throw failure('SFS_LEGACY_HANDOFF_BLOCKS_RETIREMENT',{message:'Verify the historical SFS cleanup before removing this creator or agency.',sourceId:rows[0].id});
  }
}
module.exports={lockScope,lockCleanupMutation,readLegacySource,lockCandidate,lockDelivery,attachedProof,representLegacySource,
  recordCleanupSettlement,preserveCleanupSettlements,settlementForDelivery,recoverSettledSource,assertSfsRetirable};

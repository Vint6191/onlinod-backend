'use strict';
const {COHORTS,GENERATION,manifest,failure,runDbTransaction}=require('./phase7-legacy-storage-service');
async function assertNoOldExecutions(db){
  const checks=[`SELECT "id" FROM "AutomationDelivery" WHERE "legacyStorageGeneration" IS DISTINCT FROM '${GENERATION}' AND "status" IN ('CLAIMED','RUNNING','COMMITTING','RECONCILE_REQUIRED') LIMIT 1`,
    `SELECT "id" FROM "JobInstance" WHERE "legacyStorageGeneration" IS DISTINCT FROM '${GENERATION}' AND "status" IN ('CLAIMED','RUNNING') LIMIT 1`,
    `SELECT "id" FROM "DomainWorkItem" WHERE "legacyStorageGeneration" IS DISTINCT FROM '${GENERATION}' AND "state"='CLAIMED' LIMIT 1`,
    `SELECT "id" FROM "AutomationDelivery" WHERE "moduleKey"='sfs' AND "actionType"='SFS_UNFOLLOW_TARGET' AND "payload"->>'legacyMigration'='true' AND "legacyCleanupProofId" IS NULL AND "status" IN ('QUEUED','CLAIMED','RUNNING','COMMITTING','RECONCILE_REQUIRED','RETRY_SCHEDULED','PAUSED') LIMIT 1`];
  for(let i=0;i<checks.length;i++){const rows=await db.$queryRawUnsafe(checks[i]);if(rows.length)throw failure(i===3?'PHASE7_CLEANUP_HANDOFF_INCOMPLETE':'PHASE7_OLD_EXECUTION_NOT_DRAINED',{objectId:rows[0].id});}
}
async function checkContractReady(db,{root=require('node:path').resolve(__dirname,'../..'),releaseFile}={}){
  await require('./phase7-legacy-storage-service').storageState(db);
  await require('../../scripts/database/phase7-legacy-storage-indexes').ensureIndexes(db);
  const rows=await db.phase7RetirementCohort.findMany({where:{id:{in:COHORTS}}});
  if(rows.length!==COHORTS.length||rows.some(r=>r.planHash!==manifest.planHash||r.state!=='PURGE_READY'||!r.rollbackClosedAt||!r.enumerationComplete||!r.verifiedAt))throw failure('PHASE7_CONTRACT_NOT_PREPARED');
  const fingerprint=(await db.$queryRawUnsafe('SELECT phase7_storage_fingerprint() AS value'))[0].value;
  if(rows.some(r=>r.fingerprint!==fingerprint)||new Set(rows.map(r=>JSON.stringify(r.releaseManifest))).size!==1)throw failure('PHASE7_CONTRACT_FINGERPRINT_CHANGED');
  const invalid=await db.phase7RetirementPartition.findFirst({where:{cohortId:{in:COHORTS},state:{not:'VERIFIED'}},select:{id:true}});
  if(invalid)throw failure('PHASE7_PARTITION_UNVERIFIED',{partitionId:invalid.id});
  const receipt=rows[0].releaseManifest;
  const release=await readRelease(root,{file:releaseFile});
  require('../../scripts/database/phase7-release-source').sameRelease(receipt,release);
  const checked=require('./phase7-contract-evidence').validateEvidence(receipt.operatorEvidence,receipt);
  if(checked.evidenceHash!==receipt.operatorEvidenceHash)throw failure('PHASE7_OPERATOR_EVIDENCE_HASH_MISMATCH');
  await require('./phase7-archive-integrity').assertArchiveAdmission(db,checked.evidence.archive);
  await require('../../scripts/database/phase7-role-preflight').inspectRoles(db,{roles:receipt.roleReport?.runtimeRoles?.map(r=>r.name),strict:true});
  await assertNoOldExecutions(db);return {ready:true,fingerprint,release};
}
const {readRelease}=require('../../scripts/database/phase7-release-source');
async function prepareContract({db,release,closeRollback=false,operatorEvidence,runtimeRoles}){
  if(!closeRollback)throw failure('PHASE7_EXPLICIT_ROLLBACK_CLOSURE_REQUIRED');
  release=require('../../scripts/database/phase7-release-source').identity(release);
  if(!operatorEvidence)throw failure('PHASE7_OPERATOR_EVIDENCE_REQUIRED');
  const checked=require('./phase7-contract-evidence').validateEvidence(operatorEvidence,release);
  const roleReport=await require('../../scripts/database/phase7-role-preflight').inspectRoles(db,{roles:runtimeRoles,strict:true});
  const receipt={...release,operatorEvidence:checked.evidence,operatorEvidenceHash:checked.evidenceHash,roleReport};
  await require('./phase7-legacy-storage-service').storageState(db);
  await require('../../scripts/database/phase7-legacy-storage-indexes').ensureIndexes(db);
  return runDbTransaction(db,async tx=>{
    const rows=await tx.$queryRawUnsafe('SELECT * FROM "Phase7RetirementCohort" WHERE "id"=ANY($1::text[]) ORDER BY "id" FOR UPDATE',COHORTS);
    if(rows.length!==COHORTS.length||rows.some(r=>r.planHash!==manifest.planHash||!r.enumerationComplete||r.state==='PURGED'))throw failure('PHASE7_ENUMERATION_INCOMPLETE');
    for(const c of rows){const invalid=await tx.phase7RetirementPartition.findFirst({where:{cohortId:c.id,state:{not:'VERIFIED'}},select:{id:true}});if(invalid)throw failure('PHASE7_PARTITION_UNVERIFIED',{partitionId:invalid.id});}
    const mismatch=await tx.phase7RetirementPartition.findFirst({where:{cohortId:{in:COHORTS},sequence:{gt:0},OR:[{archiveRoot:{not:checked.evidence.archive.exportRoot}},{archiveRoot:null},{restoreRoot:{not:checked.evidence.archive.restoreRoot}},{restoreRoot:null}]},select:{id:true}});
    if(mismatch)throw failure('PHASE7_ARCHIVE_EVIDENCE_ROOT_MISMATCH',{partitionId:mismatch.id});
    await require('./phase7-archive-integrity').assertArchiveAdmission(tx,checked.evidence.archive);
    await assertNoOldExecutions(tx);
    const fingerprint=(await tx.$queryRawUnsafe('SELECT phase7_storage_fingerprint() AS value'))[0].value;
    await tx.phase7RetirementCohort.updateMany({where:{id:{in:COHORTS}},data:{state:'PURGE_READY',fingerprint,releaseManifest:receipt,verifiedAt:new Date(),rollbackClosedAt:new Date(),revision:{increment:1}}});
    return {ready:true,fingerprint};
  },{timeout:15000});
}
module.exports={assertNoOldExecutions,checkContractReady,readRelease,prepareContract};

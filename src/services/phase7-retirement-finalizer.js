'use strict';
const {COHORTS,GENERATION,manifest,failure,runDbTransaction,sha}=require('./phase7-legacy-storage-service');
async function assertNoOldExecutions(db){
  const checks=[`SELECT "id" FROM "AutomationDelivery" WHERE "legacyStorageGeneration" IS DISTINCT FROM '${GENERATION}' AND "status" IN ('CLAIMED','RUNNING','COMMITTING','RECONCILE_REQUIRED') LIMIT 1`,
    `SELECT "id" FROM "JobInstance" WHERE "legacyStorageGeneration" IS DISTINCT FROM '${GENERATION}' AND "status" IN ('CLAIMED','RUNNING') LIMIT 1`,
    `SELECT "id" FROM "DomainWorkItem" WHERE "legacyStorageGeneration" IS DISTINCT FROM '${GENERATION}' AND "state"='CLAIMED' LIMIT 1`,
    `SELECT "id" FROM "AutomationDelivery" WHERE "moduleKey"='sfs' AND "actionType"='SFS_UNFOLLOW_TARGET' AND "payload"->>'legacyMigration'='true' AND "legacyCleanupProofId" IS NULL AND "status" IN ('QUEUED','CLAIMED','RUNNING','COMMITTING','RECONCILE_REQUIRED','RETRY_SCHEDULED','PAUSED') LIMIT 1`];
  for(let i=0;i<checks.length;i++){const rows=await db.$queryRawUnsafe(checks[i]);if(rows.length)throw failure(i===3?'PHASE7_CLEANUP_HANDOFF_INCOMPLETE':'PHASE7_OLD_EXECUTION_NOT_DRAINED',{objectId:rows[0].id});}
}
async function checkContractReady(db){
  await require('./phase7-legacy-storage-service').storageState(db);
  await require('../../scripts/database/phase7-legacy-storage-indexes').ensureIndexes(db);
  const rows=await db.phase7RetirementCohort.findMany({where:{id:{in:COHORTS}}});
  if(rows.length!==COHORTS.length||rows.some(r=>r.planHash!==manifest.planHash||r.state!=='PURGE_READY'||!r.rollbackClosedAt||!r.enumerationComplete||!r.verifiedAt))throw failure('PHASE7_CONTRACT_NOT_PREPARED');
  const fingerprint=(await db.$queryRawUnsafe('SELECT phase7_storage_fingerprint() AS value'))[0].value;
  if(rows.some(r=>r.fingerprint!==fingerprint)||new Set(rows.map(r=>JSON.stringify(r.releaseManifest))).size!==1)throw failure('PHASE7_CONTRACT_FINGERPRINT_CHANGED');
  const invalid=await db.phase7RetirementPartition.findFirst({where:{cohortId:{in:COHORTS},state:{not:'VERIFIED'}},select:{id:true}});
  if(invalid)throw failure('PHASE7_PARTITION_UNVERIFIED',{partitionId:invalid.id});
  const receipt=rows[0].releaseManifest;
  const checked=require('./phase7-contract-evidence').validateEvidence(receipt.operatorEvidence,receipt);
  if(checked.evidenceHash!==receipt.operatorEvidenceHash)throw failure('PHASE7_OPERATOR_EVIDENCE_HASH_MISMATCH');
  await require('../../scripts/database/phase7-role-preflight').inspectRoles(db,{roles:receipt.roleReport?.runtimeRoles?.map(r=>r.name),strict:true});
  await assertNoOldExecutions(db);return {ready:true,fingerprint};
}
async function readRelease(root){
  const fs=require('node:fs/promises'),path=require('node:path');const name=path.join(root,'phase7-release.json');
  const st=await fs.lstat(name);if(!st.isFile()||st.isSymbolicLink()||st.size>2097152)throw failure('PHASE7_RELEASE_MANIFEST_INVALID');
  const release=JSON.parse(await fs.readFile(name,'utf8'));
  if(release.generation!==GENERATION||release.planHash!==manifest.planHash||!Array.isArray(release.backendFiles)||release.backendFiles.length>5000||!['desktopHash','baseBackendHash','baseDesktopHash'].every(k=>/^[a-f0-9]{64}$/.test(release[k]||'')))throw failure('PHASE7_RELEASE_MANIFEST_INVALID');
  const actual=await require('../../scripts/database/phase7-source-inventory').sourcePaths(root);
  if(JSON.stringify(actual)!==JSON.stringify(release.backendFiles.map(e=>e.path)))throw failure('PHASE7_RELEASE_SOURCE_SET_MISMATCH');
  for(const entry of release.backendFiles){
    if(!entry.path||entry.path.includes('\\')||entry.path.split('/').some(x=>!x||x==='..'||x==='.')||path.isAbsolute(entry.path))throw failure('PHASE7_RELEASE_PATH_INVALID');
    const full=path.join(root,entry.path);if(await fs.realpath(full)!==full)throw failure('PHASE7_RELEASE_SYMLINK');
    const file=await fs.stat(full);if(!file.isFile()||file.size!==entry.bytes||file.size>16777216||sha(await fs.readFile(full))!==entry.sha256)throw failure('PHASE7_RELEASE_SOURCE_MISMATCH',{file:entry.path});
  }
  if(sha(JSON.stringify(release.backendFiles))!==release.backendHash)throw failure('PHASE7_RELEASE_HASH_INVALID');
  return {generation:release.generation,planHash:release.planHash,backendHash:release.backendHash,desktopHash:release.desktopHash,packageId:release.packageId,baseBackendHash:release.baseBackendHash,baseDesktopHash:release.baseDesktopHash};
}
async function prepareContract({db,release,closeRollback=false,operatorEvidence,runtimeRoles}){
  if(!closeRollback)throw failure('PHASE7_EXPLICIT_ROLLBACK_CLOSURE_REQUIRED');
  if(release.generation!==GENERATION||release.planHash!==manifest.planHash||![release.backendHash,release.desktopHash].every(x=>/^[a-f0-9]{64}$/.test(x||'')))throw failure('PHASE7_RELEASE_MANIFEST_INVALID');
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
    await assertNoOldExecutions(tx);
    const fingerprint=(await tx.$queryRawUnsafe('SELECT phase7_storage_fingerprint() AS value'))[0].value;
    await tx.phase7RetirementCohort.updateMany({where:{id:{in:COHORTS}},data:{state:'PURGE_READY',fingerprint,releaseManifest:receipt,verifiedAt:new Date(),rollbackClosedAt:new Date(),revision:{increment:1}}});
    return {ready:true,fingerprint};
  },{timeout:15000});
}
module.exports={assertNoOldExecutions,checkContractReady,readRelease,prepareContract};

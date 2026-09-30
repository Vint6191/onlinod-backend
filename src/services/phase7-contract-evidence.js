'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {failure,GENERATION,sha}=require('./phase7-legacy-storage-service');
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
function validateEvidence(value,release,{now=Date.now()}={}){
  const x=value;
  if(!x||x.version!==1||x.generation!==GENERATION||x.backendHash!==release.backendHash||x.desktopHash!==release.desktopHash
    ||typeof x.operator!=='string'||!x.operator.trim()||x.operator.length>200||x.noOldBinariesRemain!==true
    ||x.rollbackMode!=='restore_database_and_matching_sources')throw failure('PHASE7_OPERATOR_EVIDENCE_INVALID');
  const time=s=>typeof s==='string'&&Number.isFinite(Date.parse(s))?Date.parse(s):NaN;
  const opened=time(x.rollbackWindow?.openedAt),closed=time(x.rollbackWindow?.closedAt);
  if(!Number.isFinite(opened)||!Number.isFinite(closed)||opened>closed||closed>now+300000)throw failure('PHASE7_ROLLBACK_WINDOW_INVALID');
  if(!Array.isArray(x.stoppedBinaries)||x.stoppedBinaries.length<2||x.stoppedBinaries.length>100
    ||x.stoppedBinaries.some(b=>!['backend','desktop'].includes(b.component)||!hash(b.sourceHash)||!b.scope||typeof b.scope!=='string'||b.scope.length>500
      ||!Number.isFinite(time(b.stoppedAt))||time(b.stoppedAt)<opened||time(b.stoppedAt)>closed))throw failure('PHASE7_STOPPED_BINARY_EVIDENCE_INVALID');
  for(const [component,sourceHash] of [['backend',release.baseBackendHash],['desktop',release.baseDesktopHash]]){
    if(!hash(sourceHash)||!x.stoppedBinaries.some(b=>b.component===component&&b.sourceHash===sourceHash))throw failure('PHASE7_ALLOWED_ROLLBACK_BINARY_UNACCOUNTED');
  }
  const a=x.archive;
  if(!a||a.durability!=='persistent_backup'||!hash(a.exportRoot)||!hash(a.restoreRoot)||a.exportRoot===a.restoreRoot
    ||typeof a.backupId!=='string'||!a.backupId.trim()||a.backupId.length>500||!Number.isFinite(time(a.restoredAt))||time(a.restoredAt)>now+300000
    ||!Number.isFinite(time(a.retentionUntil))||time(a.retentionUntil)<=now)throw failure('PHASE7_DURABLE_ARCHIVE_EVIDENCE_INVALID');
  const evidence={version:1,generation:GENERATION,backendHash:x.backendHash,desktopHash:x.desktopHash,operator:x.operator,
    noOldBinariesRemain:true,rollbackMode:x.rollbackMode,rollbackWindow:{openedAt:new Date(opened).toISOString(),closedAt:new Date(closed).toISOString()},
    stoppedBinaries:x.stoppedBinaries.map(b=>({component:b.component,sourceHash:b.sourceHash,scope:b.scope,stoppedAt:new Date(time(b.stoppedAt)).toISOString()})),
    archive:{durability:a.durability,exportRoot:a.exportRoot,restoreRoot:a.restoreRoot,backupId:a.backupId,restoredAt:new Date(time(a.restoredAt)).toISOString(),retentionUntil:new Date(time(a.retentionUntil)).toISOString()}};
  return {evidence,evidenceHash:sha(JSON.stringify(evidence))};
}
async function readEvidence(file,release){
  if(typeof file!=='string'||!file)throw failure('PHASE7_OPERATOR_EVIDENCE_REQUIRED');
  const full=path.resolve(file),st=await fs.lstat(full);
  if(!st.isFile()||st.isSymbolicLink()||st.size>65536||await fs.realpath(full)!==full)throw failure('PHASE7_OPERATOR_EVIDENCE_FILE_INVALID');
  return validateEvidence(JSON.parse(await fs.readFile(full,'utf8')),release);
}
module.exports={validateEvidence,readEvidence};

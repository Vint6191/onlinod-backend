'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const contract=require('./phase7-cleanup-contract');
function fixture(){
 const delivery={id:'d',moduleKey:'sfs',actionType:'SFS_UNFOLLOW_TARGET',agencyId:'a',creatorId:'c',targetId:'t',fanId:'t',generation:2,
  legacyCleanupProofId:'p',payload:{legacyMigration:true,candidateId:'k',sourceJobId:'j'},status:'COMPLETED',result:{code:'unfollowed'},finishedAt:new Date('2026-10-08T10:00:00.123Z'),writeCommitAt:new Date('2026-10-08T09:59:59.123Z')};
 const proof={id:'p',kind:'SFS_CLEANUP',cohortId:'automation_job',classifierVersion:1,sourceTable:'AutomationJob',sourceId:'j',sourceHash:'a'.repeat(64),
  agencyId:'a',creatorId:'c',targetId:'t',generation:2,deliveryId:'d',providerSubject:'remote',evidence:{basis:'CURRENT_FOLLOW_RECEIPT',candidateId:'k',followDeliveryId:'f'}};
 const candidate={id:'k',agencyId:'a',creatorId:'c',targetUserId:'t',safetyUnfollowDeliveryId:'d',metadata:{legacyMigration:true}};
 const settlement={...proof,id:'settlement',kind:'SETTLED',sourceTable:'AutomationDelivery',sourceId:'d',evidence:{basis:'CURRENT_CLEANUP_RECEIPT',candidateId:'k',cleanupProofId:'p',outcomeCode:'unfollowed',finishedAt:delivery.finishedAt.toISOString(),writeCommitAt:delivery.writeCommitAt.toISOString()}};
 return {proof,delivery,candidate,providerSubject:'remote',settlement};
}
for(const [name,change] of [
 ['another agency',x=>x.delivery.agencyId='foreign'],['another creator',x=>x.delivery.creatorId='foreign'],
 ['another target',x=>x.delivery.fanId='foreign'],['another generation',x=>x.delivery.generation=3],
 ['a copied proof pointer',x=>x.delivery.legacyCleanupProofId='other'],['a replaced candidate',x=>x.candidate.id='other'],
 ['a newer cleanup pointer',x=>x.candidate.safetyUnfollowDeliveryId='other'],['a new provider account',x=>x.providerSubject='other'],
 ['a newer owned follow',x=>x.candidate.metadata={followEffectOwnership:'OWNED',followEffectDeliveryId:'newer'}],
 ['a different source job',x=>x.delivery.payload.sourceJobId='other'],['an invalid source hash',x=>x.proof.sourceHash='invalid'],
 ['unproven compensation',x=>x.proof.evidence={...x.proof.evidence,basis:'P14_ACCEPTED_COMPENSATION:unverified',followDeliveryId:null}],
])test('an attestation cannot authorize '+name,()=>{const x=fixture();assert.equal(contract.matchesSfsAttestation(x),true);change(x);assert.equal(contract.matchesSfsAttestation(x),false);});
test('completed queue state without a proven outcome cannot authorize retirement or retention',()=>{
 for(const status of ['QUEUED','RUNNING','FAILED','CANCELED','SKIPPED'])assert.equal(contract.isSettledCleanup({...fixture().delivery,status}),false);
 for(const code of ['unknown','followed','already_followed',null])assert.equal(contract.isSettledCleanup({...fixture().delivery,result:{code}}),false);
 assert.equal(contract.isSettledCleanup({...fixture().delivery,finishedAt:null}),false);
 assert.equal(contract.isSettledCleanup({...fixture().delivery,writeCommitAt:null}),false);
});
test('already-unfollowed observation settles without a write, but still requires a finished receipt',()=>{
 const d={...fixture().delivery,result:{code:'already_unfollowed'},writeCommitAt:null};assert.equal(contract.isSettledCleanup(d),true);
 assert.equal(contract.isSettledCleanup({...d,finishedAt:null}),false);
});
test('permanent settlement proves completion independently of deleted runtime rows',()=>{
 const {proof,settlement}=fixture();assert.equal(contract.matchesSettledAttestation(settlement,proof),true);
 for(const p of [{...settlement,agencyId:'foreign'},{...settlement,generation:3},{...settlement,sourceId:'other'},
  {...settlement,evidence:{...settlement.evidence,cleanupProofId:'other'}},{...settlement,evidence:{...settlement.evidence,outcomeCode:'unknown'}},
  {...settlement,evidence:{...settlement.evidence,writeCommitAt:null}}])assert.equal(contract.matchesSettledAttestation(p,proof),false);
});
test('UTC settlement evidence has identical meaning in UTC and non-UTC worker processes',()=>{
 const {delivery,settlement}=fixture();assert.equal(contract.matchesSettlementProof(settlement,delivery),true);
 const script=`const c=require(${JSON.stringify(require.resolve('./phase7-cleanup-contract'))});const x=${JSON.stringify({delivery,settlement})};if(!c.matchesSettlementProof(x.settlement,x.delivery))process.exit(1)`;
 for(const TZ of ['UTC','America/New_York','Asia/Kolkata']){const r=spawnSync(process.execPath,['-e',script],{env:{...process.env,TZ},encoding:'utf8'});assert.equal(r.status,0,r.stderr);}
});
test('permanent receipt cannot conceal a later rewrite of outcome or completion time',()=>{
 const {delivery,settlement}=fixture();
 assert.equal(contract.matchesSettlementProof(settlement,{...delivery,result:{code:'already_unfollowed'}}),false);
 assert.equal(contract.matchesSettlementProof(settlement,{...delivery,finishedAt:new Date('2026-10-09T10:00:00.123Z')}),false);
});

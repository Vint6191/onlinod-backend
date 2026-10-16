'use strict';
// Read-side fixtures only: seed a coherent already-verified snapshot, including
// its publisher/receipt provenance, without disabling any database guard.
// Collector correctness is tested separately by catchup-recovery-proof.cjs.
async function seedCoverage(tx, scope, {kind, now, state={}}) {
  const authority=require('../../src/services/financial-receipt-authority');
  const generation=`fixture-${kind}-${scope.creatorId}`,jobId=`proof-${generation}`;
  await authority.enter(tx);
  await tx.jobInstance.create({data:{id:jobId,agencyId:scope.agencyId,creatorId:scope.creatorId,scope:'CREATOR',
    jobKey:kind==='FINANCIAL'?'financial_transactions_scan':'fetch_campaigns',status:'PUBLISHING',params:{collectionGeneration:generation}}});
  await tx.analyticsPublication.create({data:{id:jobId+':1',jobId,agencyId:scope.agencyId,creatorId:scope.creatorId,userId:scope.userId,
    deviceId:'read-fixture-device',leaseRevision:1,leaseTokenHash:'fixture-token',payloadHash:'fixture-payload',payload:{scanRunId:generation},stage:'FINALIZE'}});
  if(kind==='FINANCIAL')await tx.financialReceiptRun.create({data:{id:jobId,jobId,agencyId:scope.agencyId,creatorId:scope.creatorId,generation,
    windows:[{kind:'FULL',from:'2016-01-01T00:00:00.000Z',to:now.toISOString()}],cursor:{phase:'done'},proof:{complete:true}}});
  const delegate=kind==='FINANCIAL'?tx.creatorFinancialCollectionState:tx.creatorCampaignCollectionState;
  await delegate.create({data:{agencyId:scope.agencyId,creatorId:scope.creatorId,status:'COMPLETE',baselineVerifiedAt:now,baselineObservedAt:now,
    sourceJobId:jobId,activeGeneration:generation,...state}});
  await tx.analyticsPublication.update({where:{id:jobId+':1'},data:{state:'COMMITTED',completedAt:now}});
  await tx.jobInstance.update({where:{id:jobId},data:{status:'DONE'}});
}
module.exports={seedCoverage};

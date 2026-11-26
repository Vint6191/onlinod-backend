'use strict';
// Offline maintenance entry point. Default is bounded read-only planning.
const fs=require('node:fs');
const {PrismaClient}=require('@prisma/client');
const {configuration}=require('../../src/services/conversation-storage/databases');
const c=require('../../src/services/conversation-storage/common');
const {DialogRepository}=require('../../src/services/conversation-storage/dialog-repository');
const {CrmRepository}=require('../../src/services/conversation-storage/crm-repository');
const {CrmAnalysisService}=require('../../src/services/conversation-storage/crm-analysis-service');
const {HistoryRelay}=require('../../src/services/conversation-storage/history-relay');
const repair=require('../../src/services/conversation-storage/operation-repair');
async function main(){
 const args=process.argv.slice(2),value=name=>{const i=args.indexOf(name);return i>=0?args[i+1]:null};
 const manifestPath=value('--manifest'),apply=args.includes('--apply');
 const manifest=manifestPath?JSON.parse(fs.readFileSync(manifestPath,'utf8')):null;
 const ctx={agencyId:value('--agency')||manifest?.scope?.agencyId,creatorId:value('--creator')||manifest?.scope?.creatorId,platformCreatorId:value('--platform-creator')||manifest?.scope?.platformCreatorId,
  deviceId:'conversation-repair-cli',actorId:value('--operator')};
 if(!ctx.agencyId||!ctx.creatorId||!ctx.platformCreatorId||!ctx.actorId||apply&&!manifest)throw Error('Require --agency --creator --platform-creator --operator; apply requires reviewed --manifest');
 ctx.scopeId=c.scopeId(ctx.agencyId,ctx.platformCreatorId);
 const config=configuration(),dialogsDb=new PrismaClient({datasources:{db:{url:config.dialogs}}}),crmDb=new PrismaClient({datasources:{db:{url:config.crm}}});
 try{const dialogs=new DialogRepository(dialogsDb),crm=new CrmRepository(crmDb,dialogs),analysis=new CrmAnalysisService(crm,dialogs,new HistoryRelay(dialogs,crm));
  const page={after:value('--after')||'',...(value('--limit')?{limit:Number(value('--limit'))}:{})};
  const result=apply?await repair.applyCrmOperationRepair(analysis,ctx,manifest):args.includes('--dialog-waits')?await repair.inventoryAmbiguousDialogWaits(dialogsDb,ctx,page):await repair.planCrmOperationRepair(analysis,ctx,{...page,
    ...(value('--run-id')?{runId:value('--run-id')}:{ }),...(value('--target-at')?{targetAt:value('--target-at')}:{ })});
  process.stdout.write(JSON.stringify(result,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');
 }finally{await dialogsDb.$disconnect();await crmDb.$disconnect()}
}
if(require.main===module)main().catch(e=>{console.error(e.code||e.message);process.exitCode=1});
module.exports={main};

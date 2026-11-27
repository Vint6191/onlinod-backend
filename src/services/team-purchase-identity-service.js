"use strict";
const {createHash}=require("node:crypto");
const KEY="team_purchase_identity_adoption_v3";
function aliases(sale) {
  return [["creator_sale",sale.id],["notification",sale.externalNotificationId],["transaction",sale.externalTransactionId],["event",sale.eventFingerprint]]
    .filter(([,value])=>typeof value==="string" && value.trim()).map(([namespace,externalId])=>({namespace,externalId:externalId.trim()}));
}
function purchaseId(sale) {return "ppv:v3:"+createHash("sha256").update(JSON.stringify([sale.agencyId,sale.creatorId,sale.id])).digest("hex");}
function compatible(root,sale,financialTransactionId) {
  return root && root.agencyId===sale.agencyId && (root.creatorId||root.accountId)===sale.creatorId
    && (!root.creatorSaleId||root.creatorSaleId===sale.id)
    && (!root.financialTransactionId||!financialTransactionId||root.financialTransactionId===financialTransactionId);
}
async function find(db,sale) {
  if(!db.teamPpvPurchaseAlias)return null;
  const refs=await db.teamPpvPurchaseAlias.findMany({where:{agencyId:sale.agencyId,creatorId:sale.creatorId,OR:aliases(sale)}});
  const roots=[...new Set(refs.map(row=>row.rootId))];
  if(roots.length>1)throw Object.assign(Error("TEAM_PURCHASE_ALIAS_CONFLICT"),{code:"TEAM_PURCHASE_ALIAS_CONFLICT"});
  if(!roots.length)return null;
  return {rootId:roots[0],root:await db.teamPpvPurchaseLedger.findUnique({where:{id:roots[0]}})};
}
async function bind(db,sale,root) {
  if(!db.teamPpvPurchaseAlias)return;
  for(const alias of aliases(sale)) {
    const key={agencyId:sale.agencyId,creatorId:sale.creatorId,...alias};
    await db.teamPpvPurchaseAlias.createMany({data:[{...key,rootId:root.id}],skipDuplicates:true});
    const row=await db.teamPpvPurchaseAlias.findUnique({where:{agencyId_creatorId_namespace_externalId:key}});
    if(row.rootId!==root.id)throw Object.assign(Error("TEAM_PURCHASE_ALIAS_CONFLICT"),{code:"TEAM_PURCHASE_ALIAS_CONFLICT"});
  }
}
async function legacyAmbiguous(db,sale,root) {
  if(root.rootVersion==="team_money_root_v3" || !root.purchaseId || !db.creatorSale.findFirst)return false;
  return Boolean(await db.creatorSale.findFirst({where:{agencyId:sale.agencyId,id:{not:sale.id},
    OR:[{externalNotificationId:root.purchaseId},{externalTransactionId:root.purchaseId}]},select:{id:true}}));
}
async function adoptPage(db) {
  return require("./db-commit-kernel").runRootCommit(db,async({tx})=>{
    const [state]=await tx.$queryRawUnsafe('SELECT * FROM "MaintenanceLaneState" WHERE key=$1 AND "completedAt" IS NULL FOR UPDATE SKIP LOCKED',KEY);
    if(!state)return {complete:true,selected:0};
    if(state.cursor.phase==="ROOTS") {
      const roots=await tx.teamPpvPurchaseLedger.findMany({where:{id:{gt:state.cursor.afterId||"",lte:state.cursor.upperRootId},
        creatorSaleId:null,financialTransactionId:null},orderBy:{id:"asc"},take:100});
      for(const root of roots) {
        const life=await require("./agency-lifecycle-barrier-service").lockAgencyLifecycleBarrier({db:tx,agencyId:root.agencyId});
        if(!life.row || life.row.deletedAt)continue;
        await tx.$queryRawUnsafe('SELECT id FROM "TeamPpvResolveJob" WHERE "agencyId"=$1 AND "purchaseId"=$2 ORDER BY id FOR UPDATE',root.agencyId,root.purchaseId);
        const [current]=await tx.$queryRawUnsafe('SELECT * FROM "TeamPpvPurchaseLedger" WHERE id=$1 FOR UPDATE',root.id);
        if(!current || current.creatorSaleId || current.financialTransactionId)continue;
        const related=await tx.creatorSale.findFirst({where:{agencyId:root.agencyId,
          OR:[{externalNotificationId:current.purchaseId},{externalTransactionId:current.purchaseId}]},select:{id:true}});
        if(!related)continue;
        // Old untyped roots may carry manual evidence but cannot be assigned
        // to a canonical operation by a numeric coincidence. Keep the evidence
        // for review and withdraw its duplicate monetary contribution.
        await tx.teamPpvPurchaseLedger.update({where:{id:root.id},data:{financialStatus:"unverified",
          status:"conflict",attributionBasis:"LEGACY_IDENTITY_REVIEW_REQUIRED"}});
      }
      const complete=roots.length<100;
      await tx.maintenanceLaneState.update({where:{key:KEY},data:{cursor:{...state.cursor,afterId:roots.at(-1)?.id||state.cursor.afterId},completedAt:complete?new Date():null}});
      return {complete,selected:roots.length};
    }
    const rows=await tx.creatorSale.findMany({where:{id:{gt:state.cursor.afterId||"",lte:state.cursor.upperId},saleType:"MESSAGE"},
      orderBy:{id:"asc"},take:100,select:{id:true,agencyId:true,creatorId:true}});
    for(const row of rows) {
      const lifecycle=await require("./agency-lifecycle-barrier-service").lockAgencyLifecycleBarrier({db:tx,agencyId:row.agencyId});
      if(!lifecycle.row || lifecycle.row.deletedAt)continue;
      await require("./domain-work-authority-service").publishDomainWork({db:tx,...row,objectId:row.id,objectType:"CreatorSale",
        workClass:"TEAM_MONEY_RECONCILIATION",partitionKey:row.creatorId});
    }
    const complete=rows.length<100;
    await tx.maintenanceLaneState.update({where:{key:KEY},data:{cursor:complete?{...state.cursor,phase:"ROOTS",afterId:""}:{...state.cursor,afterId:rows.at(-1)?.id||state.cursor.afterId},completedAt:null}});
    return {complete:false,selected:rows.length};
  },{profile:"JOB_CHUNK",authority:{kind:"TEAM_PURCHASE_IDENTITY_ADOPTION"}});
}
module.exports={KEY,aliases,purchaseId,compatible,find,bind,legacyAmbiguous,adoptPage};

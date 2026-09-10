"use strict";

const { scanAllById } = require("./telegram-exact-authority-scan-service");
const { confirmedTaskBinding, pinnedSubmissionSourceBinding } = require("./custom-revision-provider-binding-authority-service");
const { isActiveTelegramAccount } = require("./telegram-account-reference-authority-service");
const { DEBT, requireProviderOperationalBackfillReady } = require("./provider-operational-debt-authority-service");

const PAGE = 200;
function clean(value, max = 180) { const text=String(value==null?"":value).trim(); return text ? text.slice(0,max) : ""; }
function time(value) { if (!value) return Number.NEGATIVE_INFINITY; const d=value instanceof Date?value:new Date(value); return Number.isFinite(d.getTime())?d.getTime():Number.NEGATIVE_INFINITY; }
function newest(rows, primary="createdAt") {
  return (rows||[]).slice().sort((a,b)=>time(b?.[primary])-time(a?.[primary]) || time(b?.createdAt)-time(a?.createdAt) || String(b?.id||"").localeCompare(String(a?.id||"")))[0] || null;
}
function currentLatestSubmission(rows) { return newest(rows, "receivedAt"); }
function latestConfirmedTask(rows) { return newest((rows||[]).filter((r)=>String(r.kind)==="TASK" && String(r.state)==="CONFIRMED"), "confirmedAt"); }
function latestRevisionForSubmission(rows, submissionId) {
  return newest((rows||[]).filter((r)=>String(r.kind)==="REVISION_REQUEST" && String(r.customSubmissionId||"")===String(submissionId||"")), "createdAt");
}
function accountActive(accountById, accountId) {
  const row=accountById.get(String(accountId||""));
  return isActiveTelegramAccount(row);
}
function futureRevisionCandidates({ task, submission }) {
  return [confirmedTaskBinding(task), pinnedSubmissionSourceBinding(submission)].filter(Boolean);
}
function classifyProviderThreadRetention({ order, submission, intents, accountById, retiringAccountId }) {
  const target=clean(retiringAccountId);
  if (!order || String(order.type||"CONTENT").toUpperCase()!=="CONTENT" || String(order.status||"").toUpperCase()!=="PENDING") return null;
  const task=latestConfirmedTask(intents);
  if (!submission) {
    const taskBinding=confirmedTaskBinding(task);
    return taskBinding && String(taskBinding.accountId)===target
      ? { reason:"CURRENT_INITIAL_INSTRUCTION", orderId:String(order.id), creatorId:String(order.creatorId), accountId:target, anchorKind:taskBinding.anchorKind }
      : null;
  }
  if (String(submission.pipelineDisposition||"ACTIVE")!=="ACTIVE") return null;
  const reviewStatus=String(submission.reviewStatus||"WAITING_REVIEW").toUpperCase();
  if (reviewStatus==="APPROVED") return null;

  const revision=reviewStatus==="REVISION_REQUESTED" ? latestRevisionForSubmission(intents, submission.id) : null;
  const revisionState=String(revision?.state||"");
  if (["COMMITTING","RECONCILE_REQUIRED","CONFIRMED"].includes(revisionState)) {
    if (String(revision?.accountId||"")===target) {
      return {
        reason: revisionState==="CONFIRMED" ? "CURRENT_REVISION_INSTRUCTION" : "REVISION_PROVIDER_OUTCOME_UNRESOLVED",
        orderId:String(order.id), creatorId:String(order.creatorId), submissionId:String(submission.id),
        accountId:target, anchorKind:"REVISION_REQUEST", intentId:String(revision.id), state:revisionState,
      };
    }
    return null;
  }

  // WAITING_REVIEW (V1/V2) and precommit/missing REVISION_REQUEST both preserve the
  // legal manager transition REQUEST_REVISION. Retirement is allowed only if another
  // currently ACTIVE canonical anchor survives this account.
  const candidates=futureRevisionCandidates({task,submission});
  const targetCandidates=candidates.filter((binding)=>String(binding.accountId)===target);
  if (!targetCandidates.length) return null;
  const surviving=candidates.find((binding)=>String(binding.accountId)!==target && accountActive(accountById,binding.accountId));
  if (surviving) return null;
  return {
    reason:"LAST_FUTURE_REVISION_CAPABILITY", orderId:String(order.id), creatorId:String(order.creatorId), submissionId:String(submission.id),
    accountId:target, anchorKind:targetCandidates[0].anchorKind, reviewStatus,
  };
}

async function lockCustomOrderRows({ agencyId, orderIds, db }) {
  if (typeof db?.$queryRawUnsafe!=="function" || !orderIds?.length) return;
  const ids=Array.from(new Set(orderIds.map(String))).sort();
  for (let offset=0; offset<ids.length; offset+=100) {
    const chunk=ids.slice(offset,offset+100);
    const placeholders=chunk.map((_,i)=>`$${i+2}`).join(",");
    await db.$queryRawUnsafe(
      `SELECT "id" FROM "CustomOrder" WHERE "agencyId" = $1 AND "id" IN (${placeholders}) ORDER BY "id" FOR UPDATE`,
      String(agencyId), ...chunk,
    );
  }
}

async function candidateCurrentOrderIdsForAccount({ agencyId, accountId, db }) {
  const ids = new Set();
  if (!db?.providerOperationalDebt?.findMany) {
    const error = new Error("Provider operational current-work authority is unavailable");
    error.code = "PROVIDER_OPERATIONAL_DEBT_STORAGE_UNAVAILABLE";
    error.status = 503;
    throw error;
  }
  await requireProviderOperationalBackfillReady({ db, agencyId });

  // Retirement is indexed by THIS provider account's current capability debt. Historical
  // intents/submissions and other providers' PENDING Customs are cold evidence now. Each
  // candidate order is still exact-revalidated below before it can block retirement.
  await scanAllById({
    delegate: db.providerOperationalDebt,
    where: { agencyId, accountId: String(accountId), debtClass: DEBT.CURRENT_PROVIDER_THREAD_CAPABILITY },
    select: { id: true, customOrderId: true, objectId: true },
    pageSize: 250,
    onPage: async (rows) => {
      for (const row of rows || []) {
        const orderId = clean(row.customOrderId || row.objectId);
        if (orderId) ids.add(orderId);
      }
      return false;
    },
  });
  return [...ids];
}


async function findCustomProviderThreadRetentionBlockerForOrder({ agencyId, accountId, orderId, db }={}) {
  const target=clean(accountId);
  const scopedOrderId=clean(orderId);
  if(!agencyId || !target || !scopedOrderId || !db?.customOrder?.findFirst) return null;
  await lockCustomOrderRows({agencyId,orderIds:[scopedOrderId],db});
  const order=await db.customOrder.findFirst({
    where:{agencyId,id:scopedOrderId,type:"CONTENT",status:"PENDING"},
    select:{id:true,creatorId:true,type:true,status:true,fanDeliveredAt:true},
  });
  if(!order) return null;
  const submissions=db.customContentSubmission?.findMany ? await db.customContentSubmission.findMany({
    where:{agencyId,customOrderId:scopedOrderId},
    select:{id:true,creatorId:true,customOrderId:true,pipelineDisposition:true,reviewStatus:true,telegramSourceAccountId:true,telegramSourceUserId:true,telegramMessageIds:true,receivedAt:true,createdAt:true},
    orderBy:[{receivedAt:"asc"},{createdAt:"asc"},{id:"asc"}],
  }) : [];
  const intents=db.telegramDeliveryIntent?.findMany ? await db.telegramDeliveryIntent.findMany({
    where:{agencyId,customOrderId:scopedOrderId,kind:{in:["TASK","REVISION_REQUEST"]}},
    select:{id:true,creatorId:true,customOrderId:true,customSubmissionId:true,kind:true,state:true,accountId:true,remoteMessageId:true,remoteRecipientTelegramUserId:true,remoteSentAt:true,confirmedAt:true,createdAt:true},
    orderBy:[{createdAt:"asc"},{id:"asc"}],
  }) : [];
  const accountIds=new Set([target]);
  for(const row of intents||[]) if(row.accountId) accountIds.add(String(row.accountId));
  for(const row of submissions||[]) if(row.telegramSourceAccountId) accountIds.add(String(row.telegramSourceAccountId));
  const accountById=new Map();
  const ids=[...accountIds];
  if(db.agencyTelegramMtprotoAccount?.findMany) {
    const rows=await db.agencyTelegramMtprotoAccount.findMany({where:{agencyId,id:{in:ids}},select:{id:true,lifecycleState:true}});
    for(const row of rows||[]) accountById.set(String(row.id),row);
  } else if(db.agencyTelegramMtprotoAccount?.findFirst) {
    for(const id of ids) { const row=await db.agencyTelegramMtprotoAccount.findFirst({where:{agencyId,id},select:{id:true,lifecycleState:true}}); if(row) accountById.set(String(row.id),row); }
  }
  return classifyProviderThreadRetention({
    order,
    submission:currentLatestSubmission(submissions||[]),
    intents:intents||[],
    accountById,
    retiringAccountId:target,
  });
}

async function findCustomProviderThreadRetentionBlockers({ agencyId, accountId, db, stopAfterFirst=false }={}) {
  const target=clean(accountId);
  if(!agencyId || !target || !db) return [];
  const candidateIds=await candidateCurrentOrderIdsForAccount({agencyId,accountId:target,db});
  if(!candidateIds.length) return [];
  await lockCustomOrderRows({agencyId,orderIds:candidateIds,db});
  if(!db.customOrder?.findMany) return [];
  const orders=await db.customOrder.findMany({
    where:{agencyId,id:{in:candidateIds},type:"CONTENT",status:"PENDING"},
    select:{id:true,creatorId:true,type:true,status:true,fanDeliveredAt:true},
    orderBy:{id:"asc"},
  });
  const orderIds=(orders||[]).map((r)=>String(r.id));
  if(!orderIds.length) return [];

  const submissions=[];
  if(db.customContentSubmission?.findMany) await scanAllById({
    delegate:db.customContentSubmission, where:{agencyId,customOrderId:{in:orderIds}},
    select:{id:true,creatorId:true,customOrderId:true,pipelineDisposition:true,reviewStatus:true,telegramSourceAccountId:true,telegramSourceUserId:true,telegramMessageIds:true,receivedAt:true,createdAt:true},
    onPage:async(rows)=>{submissions.push(...(rows||[]));return false;},
  });
  const intents=[];
  if(db.telegramDeliveryIntent?.findMany) await scanAllById({
    delegate:db.telegramDeliveryIntent, where:{agencyId,customOrderId:{in:orderIds},kind:{in:["TASK","REVISION_REQUEST"]}},
    select:{id:true,creatorId:true,customOrderId:true,customSubmissionId:true,kind:true,state:true,accountId:true,remoteMessageId:true,remoteRecipientTelegramUserId:true,remoteSentAt:true,confirmedAt:true,createdAt:true},
    onPage:async(rows)=>{intents.push(...(rows||[]));return false;},
  });
  const accountIds=new Set([target]);
  for(const row of intents) if(row.accountId) accountIds.add(String(row.accountId));
  for(const row of submissions) if(row.telegramSourceAccountId) accountIds.add(String(row.telegramSourceAccountId));
  const accountById=new Map();
  const ids=[...accountIds];
  if(db.agencyTelegramMtprotoAccount?.findMany) {
    const rows=await db.agencyTelegramMtprotoAccount.findMany({where:{agencyId,id:{in:ids}},select:{id:true,lifecycleState:true}});
    for(const row of rows||[]) accountById.set(String(row.id),row);
  } else if(db.agencyTelegramMtprotoAccount?.findFirst) {
    for(const id of ids) { const row=await db.agencyTelegramMtprotoAccount.findFirst({where:{agencyId,id},select:{id:true,lifecycleState:true}}); if(row) accountById.set(String(row.id),row); }
  }
  const subsByOrder=new Map();
  for(const row of submissions){const k=String(row.customOrderId);const list=subsByOrder.get(k)||[];list.push(row);subsByOrder.set(k,list);}
  const intentsByOrder=new Map();
  for(const row of intents){const k=String(row.customOrderId);const list=intentsByOrder.get(k)||[];list.push(row);intentsByOrder.set(k,list);}
  const blockers=[];
  for(const order of orders||[]){
    const submission=currentLatestSubmission(subsByOrder.get(String(order.id))||[]);
    const blocker=classifyProviderThreadRetention({order,submission,intents:intentsByOrder.get(String(order.id))||[],accountById,retiringAccountId:target});
    if(!blocker) continue;
    blockers.push(blocker);
    if(stopAfterFirst) break;
  }
  return blockers;
}

module.exports={ classifyProviderThreadRetention, findCustomProviderThreadRetentionBlockerForOrder, findCustomProviderThreadRetentionBlockers, lockCustomOrderRows };

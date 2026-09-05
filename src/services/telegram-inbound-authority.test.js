"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ingestTelegramInboundEvent,
  reconcilePendingInboundForConfirmedDelivery,
  projectTelegramInboundEvent,
  retryPendingInboundProjections,
  listTelegramInboundReviewQueue,
  searchTelegramInboundReviewCandidates,
  resolveTelegramInboundReview,
} = require("./telegram-inbound-authority-service");

function clone(v){ return v == null ? v : structuredClone(v); }
function value(v){ return v instanceof Date ? v.getTime() : v; }
function matches(row, where={}) {
  for (const [k,e] of Object.entries(where)) {
    if (k === "OR") { if (!e.some((x)=>matches(row,x))) return false; continue; }
    if (k === "agency") continue;
    const a=row[k];
    if (e && typeof e === "object" && !Array.isArray(e) && !(e instanceof Date)) {
      if ("in" in e && !e.in.map(String).includes(String(a))) return false;
      if ("not" in e && (e.not === null ? a === null : String(a) === String(e.not))) return false;
      continue;
    }
    if (e === null) { if (a !== null) return false; continue; }
    if (a instanceof Date || e instanceof Date) { if (value(a)!==value(e)) return false; continue; }
    if (String(a)!==String(e)) return false;
  }
  return true;
}
function fixture({ projectedIdentity = false }={}) {
  const now=new Date("2026-09-04T16:00:00.000Z");
  const member={id:"member-1",userId:"user-1",agencyId:"agency-1",role:"OWNER",roleKey:"owner",assignedCreators:"all",accessEpoch:3,deletedAt:null,deactivatedAt:null};
  const creator={id:"creator-1",agencyId:"agency-1",status:"READY",deletedAt:null,telegramContact:"@model",telegramUserId:projectedIdentity?"900001":null,telegramAccountId:"tg-1"};
  const account={id:"tg-1",agencyId:"agency-1",runtimeClaimedByDeviceId:"device-1",runtimeClaimToken:"runtime-1",runtimeClaimUntil:new Date(now.getTime()+600000),runtimeLeaseUserId:member.userId,runtimeLeaseMemberId:member.id,runtimeLeaseAccessEpoch:member.accessEpoch,runtimeLeaseCreatorId:creator.id};
  const orders=[{id:"order-1",agencyId:"agency-1",creatorId:creator.id,type:"CONTENT",status:"PENDING",fanDeliveredAt:null,contentBoundAt:null,scenario:"custom content",dueAt:new Date(now.getTime()+3600000),createdAt:new Date(now.getTime()-10000),updatedAt:new Date(now.getTime()-10000),telegramTaskMessageId:700,telegramReferenceMessageIds:[],telegramLastModelMessageId:null,telegramLastModelMessageAt:null}];
  const intents=[{id:"intent-task",agencyId:"agency-1",creatorId:creator.id,customOrderId:"order-1",accountId:"tg-1",kind:"TASK",state:"CONFIRMED",remoteMessageId:700,remoteRecipientTelegramUserId:"900001",confirmedAt:new Date(now.getTime()-5000)}];
  const events=[];
  const submissions=[];
  const audits=[];
  const db={
    _orders:orders,_events:events,_intents:intents,_submissions:submissions,_audits:audits,
    agencyMember:{async findFirst({where}){return matches(member,where)?clone(member):null;}},
    creatorAccount:{
      async findFirst({where}){return clone(matches(creator,where)?creator:null);},
      async findMany({where}){return matches(creator,where)?[clone(creator)]:[];},
    },
    agencyTelegramMtprotoAccount:{
      async findFirst({where}){return clone(matches(account,where)?account:null);},
      async findMany({where}){return matches(account,where)?[{id:account.id}]:[];},
    },
    telegramDeliveryIntent:{
      async findFirst({where}){return clone(intents.find((r)=>matches(r,where))||null);},
      async findMany({where,take=20}){return intents.filter((r)=>matches(r,where)).slice(0,take).map(clone);},
    },
    customOrder:{
      async findFirst({where}){const r=orders.find((x)=>matches(x,where)); return r?clone(r):null;},
      async findMany({where,take=100}){return orders.filter((x)=>matches(x,where)).slice(0,take).map(clone);},
      async updateMany({where,data}){const r=orders.find((x)=>matches(x,where) && (where.updatedAt===undefined || value(x.updatedAt)===value(where.updatedAt))); if(!r)return{count:0}; Object.assign(r,clone(data),{updatedAt:new Date(r.updatedAt.getTime()+1)}); return{count:1};},
    },
    customContentSubmission:{
      async findFirst({where}={}){const r=submissions.find((x)=>matches(x,where||{}));return r?clone(r):null;},
      async findMany({where,take=100}={}){return submissions.filter((x)=>matches(x,where||{})).slice(0,take).map(clone);},
      async create({data}){
        if(submissions.some((r)=>r.id===data.id)){const e=new Error("dup");e.code="P2002";throw e;}
        const r={reviewStatus:"WAITING_REVIEW",reviewComment:null,reviewedByMemberId:null,reviewedAt:null,telegramInboundEventIds:[],...clone(data),createdAt:new Date(now),updatedAt:new Date(now)};submissions.push(r);return clone(r);
      },
      async updateMany({where,data}){const r=submissions.find((x)=>matches(x,where));if(!r)return{count:0};Object.assign(r,clone(data),{updatedAt:new Date(new Date(r.updatedAt).getTime()+1)});return{count:1};},
    },
    telegramInboundEvent:{
      async findFirst({where}){return clone(events.find((r)=>matches(r,where))||null);},
      async findMany({where,take=200}){return events.filter((r)=>matches(r,where)).slice(0,take).map(clone);},
      async count({where}){return events.filter((r)=>matches(r,where)).length;},
      async create({data}){if(events.some((r)=>r.id===data.id)){const e=new Error("dup");e.code="P2002";throw e;} const r={...clone(data),submissionId:null,createdAt:new Date(now),updatedAt:new Date(now)};events.push(r);return clone(r);},
      async updateMany({where,data}){const r=events.find((x)=>matches(x,where) && (where.updatedAt===undefined || value(x.updatedAt)===value(where.updatedAt))); if(!r)return{count:0}; Object.assign(r,clone(data),{updatedAt:new Date(r.updatedAt.getTime()+1)}); return{count:1};},
    },
    auditLog:{async create({data}){const row={id:`audit-${audits.length+1}`,...clone(data)};audits.push(row);return clone(row);}},
    async $transaction(fn){
      const snapshots={orders:clone(orders),intents:clone(intents),events:clone(events),submissions:clone(submissions),audits:clone(audits)};
      try{return await fn(this);}catch(error){
        orders.splice(0,orders.length,...snapshots.orders); intents.splice(0,intents.length,...snapshots.intents);
        events.splice(0,events.length,...snapshots.events); submissions.splice(0,submissions.length,...snapshots.submissions); audits.splice(0,audits.length,...snapshots.audits);
        throw error;
      }
    },
  };
  return {db,member,now,creator,orders,intents,events,submissions,audits};
}

function ingestRaw(fx, extra={}) { return ingestTelegramInboundEvent({ agencyId:"agency-1",member:fx.member,accountId:"tg-1",deviceId:"device-1",claimToken:"runtime-1",senderTelegramUserId:"900001",messageId:801,replyToMessageId:700,hasMedia:false,sentAt:fx.now.toISOString(),now:fx.now,db:fx.db,...extra }); }
async function ingest(fx, extra={}) { const result=await ingestRaw(fx,extra); await new Promise((resolve)=>setImmediate(resolve)); return result; }

test("confirmed provider recipient identity correlates inbound even when best-effort Creator.telegramUserId projection is missing",async()=>{
  const fx=fixture({projectedIdentity:false});
  const r=await ingest(fx);
  assert.equal(r.event.creatorId,"creator-1"); assert.equal(r.event.customOrderId,"order-1");
});

test("reply to any confirmed Telegram delivery id, including reminder, correlates the same CustomOrder",async()=>{
  const fx=fixture();
  fx.intents.push({id:"intent-reminder",agencyId:"agency-1",creatorId:"creator-1",customOrderId:"order-1",accountId:"tg-1",kind:"AUTO_REMINDER",state:"CONFIRMED",remoteMessageId:750,remoteRecipientTelegramUserId:"900001",confirmedAt:new Date(fx.now.getTime()-1000)});
  const r=await ingest(fx,{messageId:802,replyToMessageId:750});
  assert.equal(r.event.customOrderId,"order-1");
});

test("non-Reply inbound has an explicit fallback only when exactly one active CONTENT custom exists",async()=>{
  const fx=fixture();
  const one=await ingest(fx,{messageId:803,replyToMessageId:null}); assert.equal(one.event.customOrderId,"order-1");
  fx.orders.push({...clone(fx.orders[0]),id:"order-2",createdAt:new Date(fx.now.getTime()-5000),updatedAt:new Date(fx.now.getTime()-5000)});
  const ambiguous=await ingest(fx,{messageId:804,replyToMessageId:null}); assert.equal(ambiguous.event.customOrderId,null);
});

test("unmatched direct Reply never falls back to legacy message-id projections or the single active order",async()=>{
  const fx=fixture();
  // Recipient identity remains provider-proven through another confirmed delivery, but message 700
  // is deliberately no longer represented by a canonical delivery intent.  The old CustomOrder
  // projection still contains 700 and must not become a second correlation authority.
  fx.intents[0].remoteMessageId=999;
  const r=await ingest(fx,{messageId:805,replyToMessageId:700,hasMedia:false});
  assert.equal(r.event.creatorId,"creator-1");
  assert.equal(r.event.customOrderId,null);
  assert.equal(fx.orders[0].telegramLastModelMessageId,null);
});

test("same provider message replay is idempotent and does not create a second event",async()=>{
  const fx=fixture(); await ingest(fx); await ingest(fx); assert.equal(fx.events.length,1);
});

test("older Telegram event arriving later cannot overwrite the newer current projection",async()=>{
  const fx=fixture();
  await ingest(fx,{messageId:901,sentAt:"2026-09-04T16:01:00.000Z",now:new Date("2026-09-04T16:01:05.000Z")});
  await ingest(fx,{messageId:900,sentAt:"2026-09-04T16:00:00.000Z",now:new Date("2026-09-04T16:01:06.000Z")});
  assert.equal(fx.orders[0].telegramLastModelMessageId,901);
  assert.equal(new Date(fx.orders[0].telegramLastModelMessageAt).toISOString(),"2026-09-04T16:01:00.000Z");
});


test("best-effort Creator.telegramUserId cannot establish Custom business provenance before a provider receipt",async()=>{
  const fx=fixture({projectedIdentity:true});
  fx.intents.length=0;
  const r=await ingest(fx,{messageId:905,replyToMessageId:700,hasMedia:true});
  assert.equal(r.event.creatorId,null);
  assert.equal(r.event.customOrderId,null);
  assert.equal(r.event.submissionId,null);
  assert.equal(fx.orders[0].telegramLastModelMessageId,null);
});

test("late confirmed recipient receipt promotes a durable unresolved inbound event and repairs current projection",async()=>{
  const fx=fixture({projectedIdentity:true});
  fx.intents.length=0;
  const first=await ingest(fx,{messageId:906,replyToMessageId:null,hasMedia:false});
  assert.equal(first.event.creatorId,null);
  fx.intents.push({id:"intent-task-late",agencyId:"agency-1",creatorId:"creator-1",customOrderId:"order-1",accountId:"tg-1",kind:"TASK",state:"CONFIRMED",remoteMessageId:700,remoteRecipientTelegramUserId:"900001",confirmedAt:new Date(fx.now.getTime()+1000)});
  const repaired=await reconcilePendingInboundForConfirmedDelivery({agencyId:"agency-1",accountId:"tg-1",senderTelegramUserId:"900001",actorUserId:"user-1",now:new Date(fx.now.getTime()+2000),db:fx.db});
  assert.equal(repaired.reconciled,1);
  assert.equal(fx.events[0].creatorId,"creator-1");
  assert.equal(fx.events[0].customOrderId,"order-1");
  assert.equal(fx.orders[0].telegramLastModelMessageId,906);
});

test("late manual confirmation without recipient identity still repairs an unresolved direct Reply by remote message id",async()=>{
  const fx=fixture({projectedIdentity:true});
  fx.intents.length=0;
  const first=await ingest(fx,{messageId:907,replyToMessageId:777,hasMedia:false});
  assert.equal(first.event.creatorId,null);
  fx.intents.push({id:"intent-manual-late",agencyId:"agency-1",creatorId:"creator-1",customOrderId:"order-1",accountId:"tg-1",kind:"MANUAL_REMINDER",state:"CONFIRMED",remoteMessageId:777,remoteRecipientTelegramUserId:null,confirmedAt:new Date(fx.now.getTime()+1000)});
  const repaired=await reconcilePendingInboundForConfirmedDelivery({agencyId:"agency-1",accountId:"tg-1",replyToMessageId:777,actorUserId:"user-1",now:new Date(fx.now.getTime()+2000),db:fx.db});
  assert.equal(repaired.reconciled,1);
  assert.equal(fx.events[0].creatorId,"creator-1");
  assert.equal(fx.events[0].customOrderId,"order-1");
  assert.equal(fx.orders[0].telegramLastModelMessageId,907);
});


test("CALL/PHYSICAL media observations ACK before derived submission projection and become SKIPPED_NON_CONTENT without poisoning later inbound",async()=>{
  for (const type of ["CALL","PHYSICAL"]) {
    const fx=fixture();
    fx.orders[0].type=type;
    fx.orders[0].scheduledAt=type === "CALL" ? new Date(fx.now.getTime()+3600000) : null;
    fx.orders[0].durationMinutes=type === "CALL" ? 30 : null;
    fx.orders[0].physicalStatus=type === "PHYSICAL" ? "PLANNED" : null;

    const accepted=await ingestRaw(fx,{messageId:type === "CALL" ? 920 : 930,hasMedia:true});
    assert.equal(accepted.ok,true);
    assert.equal(accepted.accepted,true);
    assert.equal(accepted.event.submissionId,null);
    assert.equal(accepted.event.projectionState,"PENDING","Desktop ACK must not wait for CONTENT submission projection");

    await new Promise((resolve)=>setImmediate(resolve));
    assert.equal(fx.events[0].projectionState,"SKIPPED");
    assert.equal(fx.events[0].projectionReason,"NON_CONTENT_ORDER");
    assert.equal(fx.events[0].submissionId,null);

    const following=await ingestRaw(fx,{messageId:type === "CALL" ? 921 : 931,hasMedia:false,sentAt:new Date(fx.now.getTime()+1000).toISOString(),now:new Date(fx.now.getTime()+1000)});
    assert.equal(following.accepted,true,"a non-content media observation must never head-of-line poison later inbound events");
    assert.equal(fx.events.length,2);
    await new Promise((resolve)=>setImmediate(resolve));
  }
});


test("concurrent inbound projectors cannot downgrade a terminal projection with a late retryable result",async()=>{
  const fx=fixture();
  const accepted=await ingestRaw(fx,{messageId:940,hasMedia:false});
  assert.equal(accepted.event.projectionState,"PENDING");

  // Consume the ingest fast-path first so the row is terminal, then deliberately put it back
  // into PENDING to force two projectors over exactly the same durable observation.
  await new Promise((resolve)=>setImmediate(resolve));
  fx.events[0].projectionState="PENDING";
  fx.events[0].projectionReason=null;
  fx.events[0].projectedAt=null;

  let firstFind=true;
  let releaseFail;
  const failGate=new Promise((resolve)=>{ releaseFail=resolve; });
  const originalFind=fx.db.customOrder.findFirst.bind(fx.db.customOrder);
  fx.db.customOrder.findFirst=async(args)=>{
    if(firstFind){
      firstFind=false;
      await failGate;
      throw Object.assign(new Error("forced stale projector failure"),{code:"FORCED_STALE_PROJECTOR_FAILURE"});
    }
    return originalFind(args);
  };

  const stale=projectTelegramInboundEvent({eventId:fx.events[0].id,actorUserId:"user-1",now:new Date(fx.now.getTime()+1000),db:fx.db});
  await new Promise((resolve)=>setImmediate(resolve));
  const winner=await projectTelegramInboundEvent({eventId:fx.events[0].id,actorUserId:"user-1",now:new Date(fx.now.getTime()+1001),db:fx.db});
  assert.equal(winner.state,"SKIPPED");
  assert.equal(fx.events[0].projectionState,"SKIPPED");
  assert.equal(fx.events[0].projectionReason,"NO_MEDIA");

  releaseFail();
  const staleResult=await stale;
  assert.equal(staleResult.state,"SKIPPED","the stale worker must report the durable terminal truth, not its discarded retryable attempt");
  assert.equal(staleResult.reason,"NO_MEDIA");
  assert.equal(fx.events[0].projectionState,"SKIPPED","a late retryable worker must not downgrade the durable terminal state");
  assert.equal(fx.events[0].projectionReason,"NO_MEDIA");
});


test("server retry sweep can drain crash-window inbound globally without hot-looping unresolved provenance",async()=>{
  const fx=fixture();
  fx.events.push({
    id:"event-crash-window",agencyId:"agency-1",accountId:"tg-1",creatorId:"creator-1",customOrderId:"order-1",submissionId:null,
    senderTelegramUserId:"900001",messageId:950,replyToMessageId:700,groupedId:null,hasMedia:false,text:null,
    sentAt:new Date(fx.now),observedAt:new Date(fx.now),projectionState:"PENDING",projectionReason:null,projectionAttempts:0,projectedAt:null,
    createdAt:new Date(fx.now),updatedAt:new Date(fx.now),
  });
  fx.events.push({
    id:"event-unresolved",agencyId:"agency-2",accountId:"tg-2",creatorId:null,customOrderId:null,submissionId:null,
    senderTelegramUserId:"900002",messageId:951,replyToMessageId:null,groupedId:null,hasMedia:true,text:null,
    sentAt:new Date(fx.now),observedAt:new Date(fx.now),projectionState:"PENDING",projectionReason:"CREATOR_UNRESOLVED",projectionAttempts:1,projectedAt:null,
    createdAt:new Date(fx.now),updatedAt:new Date(fx.now),
  });

  const result=await retryPendingInboundProjections({now:new Date(fx.now.getTime()+1000),limit:50,db:fx.db});
  assert.equal(result.scanned,1,"global server sweep should select the crash-window row without requiring an agency/Desktop caller");
  assert.equal(fx.events[0].projectionState,"SKIPPED");
  assert.equal(fx.events[0].projectionReason,"NO_MEDIA");
  assert.equal(fx.events[1].projectionState,"PENDING","CREATOR_UNRESOLVED waits for receipt-driven reconciliation instead of hot-looping");
});


function seedReview(fx, overrides={}) {
  const row={
    id:`review-${fx.events.length+1}`,agencyId:"agency-1",accountId:"tg-1",creatorId:"creator-1",customOrderId:"order-1",submissionId:null,
    senderTelegramUserId:"900001",messageId:980+fx.events.length,replyToMessageId:700,groupedId:null,hasMedia:false,text:"review me",
    sentAt:new Date(fx.now.getTime()-1000),observedAt:new Date(fx.now.getTime()-500),projectionState:"REVIEW_REQUIRED",projectionReason:"PROVENANCE_CONFLICT",
    projectionAttempts:1,projectedAt:new Date(fx.now.getTime()-250),createdAt:new Date(fx.now.getTime()-500),updatedAt:new Date(fx.now.getTime()-250),
    ...clone(overrides),
  };
  fx.events.push(row);
  return row;
}

test("REVIEW_REQUIRED inbound events are visible in a management queue with explicit resolve capability",async()=>{
  const fx=fixture(); seedReview(fx);
  const queue=await listTelegramInboundReviewQueue({agencyId:"agency-1",member:fx.member,limit:25,now:fx.now,db:fx.db});
  assert.equal(queue.ok,true); assert.equal(queue.count,1); assert.equal(queue.items.length,1); assert.equal(queue.canResolve,true);
  assert.equal(queue.items[0].eventId,fx.events[0].id); assert.equal(queue.items[0].projectionReason,"PROVENANCE_CONFLICT");
  assert.equal(queue.items[0].creatorId,"creator-1"); assert.equal(queue.items[0].customOrderId,"order-1");
  assert.equal(queue.items[0].candidateOrders.some((row)=>row.customOrderId==="order-1"),true);
});

test("REVIEW_REQUIRED candidate lookup is per creator and cannot be starved by another creator's large pending queue",async()=>{
  const fx=fixture();
  for(let i=0;i<60;i++) fx.orders.push({...clone(fx.orders[0]),id:`creator1-bulk-${i}`,scenario:`bulk ${i}`,createdAt:new Date(fx.now.getTime()-i),updatedAt:new Date(fx.now.getTime()-i)});
  const order2={...clone(fx.orders[0]),id:"order-2",creatorId:"creator-2",scenario:"creator two target",contentBoundAt:null,createdAt:new Date(fx.now.getTime()-100000),updatedAt:new Date(fx.now.getTime()-100000)};
  fx.orders.push(order2);
  const creator2={id:"creator-2",agencyId:"agency-1",status:"READY",deletedAt:null,displayName:"Creator Two",username:"creator2",avatarUrl:null};
  fx.db.creatorAccount.findMany=async({where})=>{
    const all=[fx.creator,creator2]; return all.filter((row)=>matches(row,where)).map(clone);
  };
  seedReview(fx,{id:"review-c1",creatorId:"creator-1",customOrderId:"order-1",messageId:991});
  seedReview(fx,{id:"review-c2",creatorId:"creator-2",customOrderId:"order-2",messageId:992});
  const queue=await listTelegramInboundReviewQueue({agencyId:"agency-1",member:fx.member,limit:25,now:fx.now,db:fx.db});
  const c2=queue.items.find((item)=>item.eventId==="review-c2");
  assert.ok(c2); assert.equal(c2.candidateOrders.some((candidate)=>candidate.customOrderId==="order-2"),true);
  assert.ok(c2.candidateOrders.length<=20);
});


test("REVIEW_REQUIRED candidate search can recover an older valid target beyond the initial per-creator suggestions",async()=>{
  const fx=fixture();
  fx.events.push({
    id:"review-search",agencyId:"agency-1",accountId:"tg-1",creatorId:"creator-1",customOrderId:null,submissionId:null,
    senderTelegramUserId:"900001",messageId:971,replyToMessageId:700,groupedId:null,hasMedia:true,text:"older target",
    sentAt:new Date(fx.now),observedAt:new Date(fx.now),projectionState:"REVIEW_REQUIRED",projectionReason:"CUSTOM_SUBMISSION_ORDER_NOT_FOUND",projectionAttempts:1,projectedAt:new Date(fx.now),
    createdAt:new Date(fx.now),updatedAt:new Date(fx.now),
  });
  for(let i=0;i<30;i+=1){
    fx.orders.unshift({id:`newer-${i}`,agencyId:"agency-1",creatorId:"creator-1",type:"CONTENT",status:"PENDING",scenario:`newer ${i}`,dueAt:null,createdAt:new Date(fx.now.getTime()+i+1),updatedAt:new Date(fx.now)});
  }
  fx.orders.push({id:"older-exact-target",agencyId:"agency-1",creatorId:"creator-1",type:"CONTENT",status:"PENDING",scenario:"rare archived-looking pending custom",dueAt:null,createdAt:new Date(fx.now.getTime()-999999),updatedAt:new Date(fx.now)});
  const original=fx.db.customOrder.findMany.bind(fx.db.customOrder);
  fx.db.customOrder.findMany=async(args)=>{
    if(args?.where?.OR){
      const exact=args.where.OR.find((part)=>part?.id)?.id;
      if(exact){
        const row=fx.orders.find((candidate)=>candidate.id===exact && candidate.agencyId===args.where.agencyId && candidate.creatorId===args.where.creatorId && candidate.type==="CONTENT" && candidate.status==="PENDING");
        return row?[clone(row)]:[];
      }
    }
    return original(args);
  };
  const result=await searchTelegramInboundReviewCandidates({agencyId:"agency-1",member:fx.member,eventId:"review-search",query:"#older-exact-target",limit:30,db:fx.db});
  assert.equal(result.proofState,"PROVEN");
  assert.deepEqual(result.items.map((row)=>row.customOrderId),["older-exact-target"]);
});


test("stale candidate search result cannot bypass a provider-proof change before ASSIGN",async()=>{
  const fx=fixture();
  fx.events.push({
    id:"review-search-stale-proof",agencyId:"agency-1",accountId:"tg-1",creatorId:"creator-1",customOrderId:null,submissionId:null,
    senderTelegramUserId:"900001",messageId:972,replyToMessageId:null,groupedId:null,hasMedia:true,text:"stale candidate proof",
    sentAt:new Date(fx.now),observedAt:new Date(fx.now),projectionState:"REVIEW_REQUIRED",projectionReason:"CUSTOM_SUBMISSION_ORDER_NOT_FOUND",projectionAttempts:1,projectedAt:new Date(fx.now),
    createdAt:new Date(fx.now),updatedAt:new Date(fx.now),
  });
  const searched=await searchTelegramInboundReviewCandidates({agencyId:"agency-1",member:fx.member,eventId:"review-search-stale-proof",query:"order-1",db:fx.db});
  assert.equal(searched.proofState,"PROVEN");
  assert.equal(searched.items[0]?.customOrderId,"order-1");

  // Proof changes after the read-only search but before the manager commits ASSIGN.
  fx.intents.push({id:"intent-conflicting-recipient",agencyId:"agency-1",creatorId:"creator-2",customOrderId:"order-other",accountId:"tg-1",kind:"TASK",state:"CONFIRMED",remoteMessageId:799,remoteRecipientTelegramUserId:"900001",confirmedAt:new Date(fx.now)});
  await assert.rejects(
    ()=>resolveTelegramInboundReview({agencyId:"agency-1",member:fx.member,eventId:"review-search-stale-proof",resolution:"ASSIGN_TO_CONTENT_ORDER",reason:"candidate looked valid before provider proof changed",customOrderId:"order-1",now:fx.now,db:fx.db}),
    (error)=>error?.code==="TELEGRAM_INBOUND_REVIEW_CREATOR_UNPROVEN" && error?.status===409,
  );
  assert.equal(fx.events[0].projectionState,"REVIEW_REQUIRED");
  assert.equal(fx.submissions.length,0);
});

test("member may view REVIEW_REQUIRED queue but cannot resolve without content.review_customs",async()=>{
  const fx=fixture(); seedReview(fx);
  const viewer={...fx.member,role:"SUPERVISOR",roleKey:"supervisor",permissions:{"team.analytics.view":true,"content.review_customs":false}};
  const queue=await listTelegramInboundReviewQueue({agencyId:"agency-1",member:viewer,db:fx.db});
  assert.equal(queue.items.length,1); assert.equal(queue.canResolve,false);
  await assert.rejects(
    resolveTelegramInboundReview({agencyId:"agency-1",member:viewer,eventId:fx.events[0].id,resolution:"SKIP",reason:"manager decision",now:fx.now,db:fx.db}),
    (error)=>error?.code==="TELEGRAM_INBOUND_REVIEW_FORBIDDEN" && error?.status===403,
  );
  assert.equal(fx.events[0].projectionState,"REVIEW_REQUIRED");
});

test("explicit REVIEW_REQUIRED skip is audited and stale automatic projection cannot downgrade it",async()=>{
  const fx=fixture(); seedReview(fx);
  const resolved=await resolveTelegramInboundReview({agencyId:"agency-1",member:fx.member,eventId:fx.events[0].id,resolution:"SKIP",reason:"confirmed unrelated media",now:fx.now,db:fx.db});
  assert.equal(resolved.state,"SKIPPED"); assert.match(fx.events[0].projectionReason,/^MANUAL_SKIP:/);
  assert.equal(fx.audits.some((row)=>row.action==="custom_order.telegram_inbound_review_skip"),true);
  assert.equal(fx.audits.at(-1).metadata.previousReason,"PROVENANCE_CONFLICT");
  const stale=await projectTelegramInboundEvent({eventId:fx.events[0].id,actorUserId:"stale-worker",now:new Date(fx.now.getTime()+1000),db:fx.db});
  assert.equal(stale.state,"SKIPPED"); assert.match(stale.reason,/^MANUAL_SKIP:/); assert.equal(fx.events[0].projectionState,"SKIPPED");
});

test("explicit REVIEW_REQUIRED retry is audited and deterministically re-enters automatic projection",async()=>{
  const fx=fixture(); seedReview(fx,{projectionReason:"CUSTOM_SUBMISSION_ORDER_NOT_FOUND",hasMedia:false});
  const resolved=await resolveTelegramInboundReview({agencyId:"agency-1",member:fx.member,eventId:fx.events[0].id,resolution:"RETRY_AFTER_REPAIR",reason:"order repaired",now:new Date(fx.now.getTime()+1000),db:fx.db});
  assert.equal(resolved.state,"SKIPPED"); assert.equal(resolved.projectionReason,"NO_MEDIA");
  assert.equal(fx.events[0].projectionState,"SKIPPED"); assert.equal(fx.events[0].projectionReason,"NO_MEDIA");
  const audit=fx.audits.find((row)=>row.action==="custom_order.telegram_inbound_review_retry");
  assert.ok(audit); assert.equal(audit.metadata.previousReason,"CUSTOM_SUBMISSION_ORDER_NOT_FOUND"); assert.equal(audit.metadata.reason,"order repaired");
});

test("human SKIP/RETRY state transition and mandatory reason audit commit atomically",async()=>{
  for(const resolution of ["SKIP","RETRY_AFTER_REPAIR"]){
    const fx=fixture(); seedReview(fx,{projectionReason:"PROVENANCE_CONFLICT"});
    fx.db.auditLog.create=async()=>{throw Object.assign(new Error("audit storage unavailable"),{code:"AUDIT_DOWN"});};
    await assert.rejects(
      resolveTelegramInboundReview({agencyId:"agency-1",member:fx.member,eventId:fx.events[0].id,resolution,reason:"manager decision",now:new Date(fx.now.getTime()+1000),db:fx.db}),
      (error)=>error?.code==="AUDIT_DOWN",
    );
    assert.equal(fx.events[0].projectionState,"REVIEW_REQUIRED","failed audit must roll back the human state decision");
    assert.equal(fx.events[0].projectionReason,"PROVENANCE_CONFLICT");
    assert.equal(fx.audits.length,0);
  }
});

test("backend retry sweep converges linked stale REVIEW_REQUIRED rows to APPLIED without UI",async()=>{
  const fx=fixture(); seedReview(fx,{submissionId:"submission-scheduler"});
  const result=await retryPendingInboundProjections({agencyId:"agency-1",now:new Date(fx.now.getTime()+1000),limit:50,db:fx.db});
  assert.equal(result.convergedLinked,1); assert.equal(result.applied,1);
  assert.equal(fx.events[0].projectionState,"APPLIED"); assert.equal(fx.events[0].projectionReason,"SUBMISSION_ALREADY_LINKED");
});

test("submissionId is a stronger durable fact and REVIEW_REQUIRED converges to APPLIED",async()=>{
  const fx=fixture(); seedReview(fx,{submissionId:"submission-1"});
  const projected=await projectTelegramInboundEvent({eventId:fx.events[0].id,actorUserId:"user-1",now:fx.now,db:fx.db});
  assert.equal(projected.state,"APPLIED"); assert.equal(projected.submission.id,"submission-1");
  assert.equal(fx.events[0].projectionState,"APPLIED"); assert.equal(fx.events[0].projectionReason,"SUBMISSION_ALREADY_LINKED");
});

test("explicit REVIEW_REQUIRED resolution fails closed without transactional storage",async()=>{
  const fx=fixture(); seedReview(fx); delete fx.db.$transaction;
  await assert.rejects(
    resolveTelegramInboundReview({agencyId:"agency-1",member:fx.member,eventId:fx.events[0].id,resolution:"SKIP",reason:"manager decision",now:fx.now,db:fx.db}),
    (error)=>error?.code==="TELEGRAM_INBOUND_REVIEW_TRANSACTION_REQUIRED",
  );
  assert.equal(fx.events[0].projectionState,"REVIEW_REQUIRED"); assert.equal(fx.audits.length,0);
});

test("Serializable REVIEW_REQUIRED transaction conflict becomes deterministic refresh conflict",async()=>{
  const fx=fixture(); seedReview(fx);
  fx.db.$transaction=async()=>{throw Object.assign(new Error("serialization failure"),{code:"P2034"});};
  await assert.rejects(
    resolveTelegramInboundReview({agencyId:"agency-1",member:fx.member,eventId:fx.events[0].id,resolution:"SKIP",reason:"manager decision",now:fx.now,db:fx.db}),
    (error)=>error?.code==="TELEGRAM_INBOUND_REVIEW_RACE" && error?.status===409,
  );
  assert.equal(fx.events[0].projectionState,"REVIEW_REQUIRED");
});

test("explicit review resolution requires a human reason",async()=>{
  const fx=fixture(); seedReview(fx);
  await assert.rejects(
    resolveTelegramInboundReview({agencyId:"agency-1",member:fx.member,eventId:fx.events[0].id,resolution:"SKIP",reason:" ",now:fx.now,db:fx.db}),
    (error)=>error?.code==="TELEGRAM_INBOUND_REVIEW_REASON_REQUIRED",
  );
  assert.equal(fx.events[0].projectionState,"REVIEW_REQUIRED");
});


test("explicit REVIEW_REQUIRED assignment materializes the provider event and assigns only to the proven creator CONTENT order",async()=>{
  const fx=fixture();
  seedReview(fx,{customOrderId:null,hasMedia:true,text:"provider media for repaired custom"});
  const resolved=await resolveTelegramInboundReview({
    agencyId:"agency-1",member:fx.member,eventId:fx.events[0].id,resolution:"ASSIGN_TO_CONTENT_ORDER",reason:"provider identity repaired and target verified",customOrderId:"order-1",now:new Date(fx.now.getTime()+1000),db:fx.db,
  });
  assert.equal(resolved.state,"APPLIED"); assert.ok(resolved.submissionId);
  assert.equal(fx.events[0].projectionState,"APPLIED"); assert.equal(fx.events[0].customOrderId,"order-1"); assert.equal(fx.events[0].submissionId,resolved.submissionId);
  assert.equal(fx.submissions.length,1); assert.equal(fx.submissions[0].customOrderId,"order-1"); assert.equal(fx.submissions[0].creatorId,"creator-1");
  assert.ok(fx.orders[0].contentBoundAt,"human assignment must enter the same durable CONTENT lifecycle as automatic submission intake");
  assert.equal(fx.audits.some((row)=>row.action==="custom_order.telegram_inbound_review_assign"),true);
});



test("ASSIGN resolution rolls back materialization/binding when mandatory audit cannot commit",async()=>{
  const fx=fixture(); seedReview(fx,{customOrderId:null,hasMedia:true,text:"provider media"});
  fx.db.auditLog.create=async()=>{throw Object.assign(new Error("audit storage unavailable"),{code:"AUDIT_DOWN"});};
  await assert.rejects(
    resolveTelegramInboundReview({agencyId:"agency-1",member:fx.member,eventId:fx.events[0].id,resolution:"ASSIGN_TO_CONTENT_ORDER",reason:"verified target",customOrderId:"order-1",now:new Date(fx.now.getTime()+1000),db:fx.db}),
    (error)=>error?.code==="AUDIT_DOWN",
  );
  assert.equal(fx.events[0].projectionState,"REVIEW_REQUIRED"); assert.equal(fx.events[0].submissionId,null);
  assert.equal(fx.submissions.length,0); assert.equal(fx.orders[0].contentBoundAt,null);
  assert.equal(fx.audits.length,0);
});

test("explicit REVIEW_REQUIRED assignment refuses a target whose creator is not provider-proven",async()=>{
  const fx=fixture();
  const other={...clone(fx.orders[0]),id:"order-2",creatorId:"creator-2",contentBoundAt:null,updatedAt:new Date(fx.now.getTime()-9000)};
  fx.orders.push(other);
  const originalFindFirst=fx.db.creatorAccount.findFirst.bind(fx.db.creatorAccount);
  fx.db.creatorAccount.findFirst=async({where})=>{
    if(String(where?.id||"")==="creator-2") return {id:"creator-2",agencyId:"agency-1",status:"READY",deletedAt:null};
    return originalFindFirst({where});
  };
  seedReview(fx,{customOrderId:null,hasMedia:true});
  await assert.rejects(
    resolveTelegramInboundReview({agencyId:"agency-1",member:fx.member,eventId:fx.events[0].id,resolution:"ASSIGN_TO_CONTENT_ORDER",reason:"try wrong creator",customOrderId:"order-2",now:fx.now,db:fx.db}),
    (error)=>error?.code==="TELEGRAM_INBOUND_REVIEW_CREATOR_UNPROVEN",
  );
  assert.equal(fx.events[0].projectionState,"REVIEW_REQUIRED"); assert.equal(fx.submissions.length,0); assert.equal(fx.orders[1].contentBoundAt,null);
});

test("concurrent submission materialization wins over human SKIP/RETRY and converges REVIEW_REQUIRED to APPLIED", async()=>{
  for (const resolution of ["SKIP", "RETRY_AFTER_REPAIR"]) {
    const fx=fixture();
    const seeded=seedReview(fx,{reason:"PROVENANCE_CONFLICT"});
    const original=fx.db.telegramInboundEvent.updateMany.bind(fx.db.telegramInboundEvent);
    let injected=false;
    fx.db.telegramInboundEvent.updateMany=async({where,data})=>{
      if (!injected && where?.projectionState === "REVIEW_REQUIRED" && where?.submissionId === null) {
        injected=true;
        const durable=fx.events.find((row)=>row.id===seeded.id);
        durable.submissionId=`submission-race-${resolution}`;
        durable.updatedAt=new Date(new Date(durable.updatedAt).getTime()+1);
      }
      return original({where,data});
    };
    const result=await resolveTelegramInboundReview({agencyId:"agency-1",member:fx.member,eventId:seeded.id,resolution,reason:"manager stale action",now:new Date(fx.now.getTime()+7000),db:fx.db});
    assert.equal(result.state,"APPLIED");
    assert.equal(result.idempotent,true);
    assert.equal(fx.events[0].projectionState,"APPLIED");
    assert.match(String(fx.events[0].submissionId),/^submission-race-/);
    assert.equal(fx.audits.some((row)=>String(row.action||"").endsWith(resolution === "SKIP" ? "_skip" : "_retry")),false,"losing human action must not audit itself as the winner");
  }
});

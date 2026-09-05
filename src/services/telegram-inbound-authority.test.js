"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { ingestTelegramInboundEvent, reconcilePendingInboundForConfirmedDelivery, projectTelegramInboundEvent, retryPendingInboundProjections } = require("./telegram-inbound-authority-service");

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
  const orders=[{id:"order-1",agencyId:"agency-1",creatorId:creator.id,type:"CONTENT",status:"PENDING",createdAt:new Date(now.getTime()-10000),updatedAt:new Date(now.getTime()-10000),telegramTaskMessageId:700,telegramReferenceMessageIds:[],telegramLastModelMessageId:null,telegramLastModelMessageAt:null}];
  const intents=[{id:"intent-task",agencyId:"agency-1",creatorId:creator.id,customOrderId:"order-1",accountId:"tg-1",kind:"TASK",state:"CONFIRMED",remoteMessageId:700,remoteRecipientTelegramUserId:"900001",confirmedAt:new Date(now.getTime()-5000)}];
  const events=[];
  const db={
    _orders:orders,_events:events,_intents:intents,
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
      async findMany({where,take=100}){return orders.filter((x)=>matches(x,where)).slice(0,take).map((r)=>({id:r.id}));},
      async updateMany({where,data}){const r=orders.find((x)=>matches(x,where) && (where.updatedAt===undefined || value(x.updatedAt)===value(where.updatedAt))); if(!r)return{count:0}; Object.assign(r,clone(data),{updatedAt:new Date(r.updatedAt.getTime()+1)}); return{count:1};},
    },
    customContentSubmission:{
      async findFirst(){return null;},
    },
    telegramInboundEvent:{
      async findFirst({where}){return clone(events.find((r)=>matches(r,where))||null);},
      async findMany({where,take=200}){return events.filter((r)=>matches(r,where)).slice(0,take).map(clone);},
      async create({data}){if(events.some((r)=>r.id===data.id)){const e=new Error("dup");e.code="P2002";throw e;} const r={...clone(data),submissionId:null,createdAt:new Date(now),updatedAt:new Date(now)};events.push(r);return clone(r);},
      async updateMany({where,data}){const r=events.find((x)=>matches(x,where) && (where.updatedAt===undefined || value(x.updatedAt)===value(where.updatedAt))); if(!r)return{count:0}; Object.assign(r,clone(data),{updatedAt:new Date(r.updatedAt.getTime()+1)}); return{count:1};},
    },
    auditLog:{async create({data}){return{id:"audit",...clone(data)};}},
  };
  return {db,member,now,creator,orders,intents,events};
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

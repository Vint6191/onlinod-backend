"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyProviderThreadRetention, findCustomProviderThreadRetentionBlockers } = require("./custom-provider-thread-retention-authority-service");

function mapAccounts(rows) { return new Map(rows.map((row)=>[row.id,row])); }
const order = { id:"order-1", creatorId:"creator-1", type:"CONTENT", status:"PENDING" };
const task = { id:"task-1", kind:"TASK", state:"CONFIRMED", accountId:"tg-a", remoteMessageId:501, remoteRecipientTelegramUserId:"1001", confirmedAt:new Date("2026-09-07T10:00:00Z"), createdAt:new Date("2026-09-07T09:59:00Z") };
function submission(overrides={}) { return { id:"sub-1", customOrderId:"order-1", pipelineDisposition:"ACTIVE", reviewStatus:"WAITING_REVIEW", telegramSourceAccountId:"tg-b", telegramSourceUserId:"1001", telegramMessageIds:[700], receivedAt:new Date("2026-09-07T11:00:00Z"), createdAt:new Date("2026-09-07T11:00:00Z"), ...overrides }; }

test("initial confirmed TASK retains its provider account until first response exists", () => {
  const blocker=classifyProviderThreadRetention({order,submission:null,intents:[task],accountById:mapAccounts([{id:"tg-a",lifecycleState:"ACTIVE"}]),retiringAccountId:"tg-a"});
  assert.equal(blocker?.reason,"CURRENT_INITIAL_INSTRUCTION");
});

test("WAITING_REVIEW retains at least one future revision-capable provider anchor, not every anchor", () => {
  const sub=submission();
  const accounts=mapAccounts([{id:"tg-a",lifecycleState:"ACTIVE"},{id:"tg-b",lifecycleState:"ACTIVE"}]);
  assert.equal(classifyProviderThreadRetention({order,submission:sub,intents:[task],accountById:accounts,retiringAccountId:"tg-a"}),null,"pinned source survives TASK retirement");
  assert.equal(classifyProviderThreadRetention({order,submission:sub,intents:[task],accountById:accounts,retiringAccountId:"tg-b"}),null,"confirmed TASK survives source-account retirement");
});

test("concurrent second retirement sees the first anchor RETIRING and blocks destruction of the last capability", () => {
  const sub=submission();
  const accounts=mapAccounts([{id:"tg-a",lifecycleState:"RETIRING"},{id:"tg-b",lifecycleState:"ACTIVE"}]);
  const blocker=classifyProviderThreadRetention({order,submission:sub,intents:[task],accountById:accounts,retiringAccountId:"tg-b"});
  assert.equal(blocker?.reason,"LAST_FUTURE_REVISION_CAPABILITY");
});

test("historical no-TASK WAITING_REVIEW keeps its pinned source account for a legal future revision", () => {
  const sub=submission({telegramSourceAccountId:"tg-b"});
  const blocker=classifyProviderThreadRetention({order,submission:sub,intents:[],accountById:mapAccounts([{id:"tg-b",lifecycleState:"ACTIVE"}]),retiringAccountId:"tg-b"});
  assert.equal(blocker?.reason,"LAST_FUTURE_REVISION_CAPABILITY");
});

test("APPROVED response releases provider-thread retention when no separate delivery debt exists", () => {
  const sub=submission({reviewStatus:"APPROVED"});
  assert.equal(classifyProviderThreadRetention({order,submission:sub,intents:[task],accountById:mapAccounts([{id:"tg-a",lifecycleState:"ACTIVE"},{id:"tg-b",lifecycleState:"ACTIVE"}]),retiringAccountId:"tg-a"}),null);
});

test("confirmed current revision retains the exact revision account even when an older TASK/source alternative exists", () => {
  const sub=submission({reviewStatus:"REVISION_REQUESTED"});
  const revision={id:"rev-1",kind:"REVISION_REQUEST",state:"CONFIRMED",customSubmissionId:sub.id,accountId:"tg-b",remoteMessageId:800,remoteRecipientTelegramUserId:"1001",confirmedAt:new Date("2026-09-07T12:00:00Z"),createdAt:new Date("2026-09-07T11:59:00Z")};
  const blocker=classifyProviderThreadRetention({order,submission:sub,intents:[task,revision],accountById:mapAccounts([{id:"tg-a",lifecycleState:"ACTIVE"},{id:"tg-b",lifecycleState:"ACTIVE"}]),retiringAccountId:"tg-b"});
  assert.equal(blocker?.reason,"CURRENT_REVISION_INSTRUCTION");
  assert.equal(blocker?.intentId,"rev-1");
});

test("production-shaped current-debt lookup locks the exact CustomOrder and blocks WAITING_REVIEW account retirement", async () => {
  const orders=[{...order,agencyId:"agency-1"}];
  const submissions=[{...submission({telegramSourceAccountId:"tg-a"}),agencyId:"agency-1",creatorId:"creator-1"}];
  const intents=[{...task,agencyId:"agency-1",creatorId:"creator-1",customOrderId:"order-1"}];
  const accounts=[{id:"tg-a",agencyId:"agency-1",lifecycleState:"ACTIVE"}];
  let lockCalls=0;
  const matches=(row,where={})=>Object.entries(where).every(([key,v])=>{
    if(key==="id"&&v?.in)return v.in.includes(row.id);
    if(key==="customOrderId"&&v?.in)return v.in.includes(row.customOrderId);
    if(key==="kind"&&v?.in)return v.in.includes(row.kind);
    if(key==="customOrderId"&&v?.not===null)return row.customOrderId!=null;
    if(v&&typeof v==="object"&&!Array.isArray(v)&&"in" in v)return v.in.map(String).includes(String(row[key]));
    return String(row[key])===String(v);
  });
  const page=(rows,args)=>rows.filter(r=>matches(r,args.where||{})).sort((a,b)=>String(a.id).localeCompare(String(b.id))).slice(0,args.take||250).map(r=>({...r}));
  const db={
    telegramDeliveryIntent:{findMany:async(args)=>page(intents,args)},
    customContentSubmission:{findMany:async(args)=>page(submissions,args)},
    customOrder:{
      findMany:async({where})=>orders.filter(r=>matches(r,where)).map(r=>({...r})),
      findFirst:async({where})=>orders.find(r=>matches(r,where)) || null,
    },
    providerOperationalDebt:{
      findMany:async(args)=>page([{id:"debt-1",agencyId:"agency-1",accountId:"tg-a",debtClass:"CURRENT_PROVIDER_THREAD_CAPABILITY",customOrderId:"order-1",objectId:"order-1"}],args),
    },
    maintenanceLaneState:{findUnique:async()=>({key:"provider_operational_debt_backfill_v1",generation:"provider_operational_debt_v1",completedAt:new Date("2026-09-09T00:00:00Z")})},
    agencyTelegramMtprotoAccount:{findMany:async({where})=>accounts.filter(r=>matches(r,where)).map(r=>({...r}))},
    async $queryRawUnsafe(){lockCalls+=1;return [];},
  };
  const blockers=await findCustomProviderThreadRetentionBlockers({agencyId:"agency-1",accountId:"tg-a",db,stopAfterFirst:true});
  assert.equal(blockers.length,1);
  assert.equal(blockers[0].reason,"LAST_FUTURE_REVISION_CAPABILITY");
  assert.ok(lockCalls>0,"retirement decision must serialize on the shared CustomOrder row");
});

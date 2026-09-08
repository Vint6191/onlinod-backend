"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { deriveCustomRevisionDispatch } = require("./custom-revision-dispatch-authority-service");

function fixture({ intent = null, task = null, accounts = {}, submission = null } = {}) {
  const sub = submission || { id:"sub-1", customOrderId:"order-1", telegramSourceAccountId:null, telegramSourceUserId:null, telegramMessageIds:[] };
  const db = {
    telegramDeliveryIntent: { async findFirst({ where }) {
      if (where.kind === "REVISION_REQUEST") return intent;
      if (where.kind === "TASK") return task;
      return null;
    } },
    agencyTelegramMtprotoAccount: { async findFirst({ where }) {
      const state = accounts[String(where.id)];
      return state ? { id:String(where.id), lifecycleState:state } : null;
    } },
  };
  return { sub, db };
}

test("missing intent with usable pinned source is DISPATCH_REQUIRED", async () => {
  const { sub, db } = fixture({ submission:{ id:"sub-1", customOrderId:"order-1", telegramSourceAccountId:"tg-live", telegramSourceUserId:"1001", telegramMessageIds:[501] }, accounts:{"tg-live":"ACTIVE"} });
  const result = await deriveCustomRevisionDispatch({ agencyId:"agency-1", orderId:"order-1", submission:sub, intent:null, db });
  assert.equal(result.status,"DISPATCH_REQUIRED");
  assert.equal(result.blockedCode,null);
  assert.equal(result.providerAnchorKind,"PINNED_SUBMISSION_SOURCE");
});

test("missing intent with no usable provider anchor is DISPATCH_BLOCKED", async () => {
  const { sub, db } = fixture();
  const result = await deriveCustomRevisionDispatch({ agencyId:"agency-1", orderId:"order-1", submission:sub, intent:null, db });
  assert.equal(result.status,"DISPATCH_BLOCKED");
  assert.equal(result.blockedCode,"TASK_AND_PINNED_SOURCE_UNAVAILABLE");
});

test("PLANNED provider-unavailable intent is BLOCKED while provider remains unavailable", async () => {
  const intent={id:"rev-1",kind:"REVISION_REQUEST",state:"PLANNED",customSubmissionId:"sub-1",outcomeReason:"PRECOMMIT_PROVIDER_UNAVAILABLE:CUSTOM_ORDER_TELEGRAM_ACCOUNT_RETIRING",createdAt:new Date()};
  const task={id:"task-1",kind:"TASK",state:"CONFIRMED",accountId:"tg-old",remoteMessageId:500,remoteRecipientTelegramUserId:"1001"};
  const { sub, db } = fixture({ intent, task, accounts:{"tg-old":"RETIRING"} });
  const result=await deriveCustomRevisionDispatch({agencyId:"agency-1",orderId:"order-1",submission:sub,intent,db});
  assert.equal(result.status,"DISPATCH_BLOCKED");
  assert.equal(result.intentId,"rev-1");
});

test("durable PRECOMMIT_PROVIDER_UNAVAILABLE remains DISPATCH_BLOCKED until repair clears the durable blocker", async () => {
  const intent={id:"rev-1",kind:"REVISION_REQUEST",state:"PLANNED",customSubmissionId:"sub-1",outcomeReason:"PRECOMMIT_PROVIDER_UNAVAILABLE:CUSTOM_ORDER_TELEGRAM_ACCOUNT_RETIRING",createdAt:new Date()};
  const task={id:"task-1",kind:"TASK",state:"CONFIRMED",accountId:"tg-old",remoteMessageId:500,remoteRecipientTelegramUserId:"1001"};
  const { sub, db } = fixture({ intent, task, submission:{id:"sub-1",customOrderId:"order-1",telegramSourceAccountId:"tg-live",telegramSourceUserId:"1001",telegramMessageIds:[700]}, accounts:{"tg-old":"RETIRING","tg-live":"ACTIVE"} });
  const blocked=await deriveCustomRevisionDispatch({agencyId:"agency-1",orderId:"order-1",submission:sub,intent,db});
  assert.equal(blocked.status,"DISPATCH_BLOCKED");
  assert.equal(blocked.blockedCode,"CUSTOM_ORDER_TELEGRAM_ACCOUNT_RETIRING");

  const repaired={...intent,outcomeReason:null};
  const pending=await deriveCustomRevisionDispatch({agencyId:"agency-1",orderId:"order-1",submission:sub,intent:repaired,db});
  assert.equal(pending.status,"DISPATCH_PENDING");
  assert.equal(pending.providerAnchorKind,"PINNED_SUBMISSION_SOURCE");
});

test("committing/unknown/confirmed/cancelled states are provider-effect states and do not downgrade to BLOCKED", async () => {
  const { sub, db } = fixture();
  for (const [state,status] of [["COMMITTING","SENDING"],["RECONCILE_REQUIRED","DELIVERY_UNKNOWN"],["CONFIRMED","WAITING_MODEL"],["CANCELLED","DISPATCH_CANCELLED"]]) {
    const intent={id:`rev-${state}`,state,remoteMessageId:state==="CONFIRMED"?900:null,remoteSentAt:state==="CONFIRMED"?new Date():null};
    const result=await deriveCustomRevisionDispatch({agencyId:"agency-1",orderId:"order-1",submission:sub,intent,db});
    assert.equal(result.status,status);
  }
});


test("revision dispatch product projection has one exported authority", () => {
  const telegramAuthority = require("./telegram-delivery-authority-service");
  assert.equal(Object.prototype.hasOwnProperty.call(telegramAuthority, "revisionDispatchProjection"), false);
});

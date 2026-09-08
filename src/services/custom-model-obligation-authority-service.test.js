"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { deriveCustomModelObligation, reminderBindingFromObligation } = require("./custom-model-obligation-authority-service");
const { normalizeTelegramCustomReminders, desiredReminderSchedule } = require("./custom-order-reminders");

function clone(value) { return value == null ? value : structuredClone(value); }
function fixture() {
  const now = new Date("2026-09-07T18:00:00.000Z");
  const order = {
    id: "order-1", agencyId: "agency-1", creatorId: "creator-1", type: "CONTENT", status: "PENDING",
    lastReminderAt: null, lastReminderKey: null, nextReminderAt: null, reminderConfig: null,
    createdAt: new Date(now.getTime() - 3_600_000), updatedAt: new Date(now.getTime() - 1_000),
  };
  const submissions = [];
  const intents = [];
  const byCreatedDesc = (rows) => rows.slice().sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0) || String(b.id).localeCompare(String(a.id)));
  const db = {
    customOrder: { async findFirst({ where }) { return where.id === order.id && where.agencyId === order.agencyId ? clone(order) : null; } },
    customContentSubmission: {
      async findFirst({ where }) {
        return clone(byCreatedDesc(submissions.filter((row)=>String(row.agencyId)===String(where.agencyId) && String(row.creatorId)===String(where.creatorId) && String(row.customOrderId)===String(where.customOrderId)))[0] || null);
      },
    },
    telegramDeliveryIntent: {
      async findFirst({ where }) {
        return clone(byCreatedDesc(intents.filter((row)=>{
          if (String(row.agencyId)!==String(where.agencyId) || String(row.customOrderId)!==String(where.customOrderId) || String(row.kind)!==String(where.kind)) return false;
          if (where.state !== undefined && String(row.state)!==String(where.state)) return false;
          if (where.customSubmissionId !== undefined && String(row.customSubmissionId||"")!==String(where.customSubmissionId||"")) return false;
          return true;
        }))[0] || null);
      },
    },
    agencyTelegramMtprotoAccount: { async findFirst({ where }) { return String(where.id)==="tg-1" ? { id:"tg-1", lifecycleState:"ACTIVE" } : null; } },
  };
  return { now, order, submissions, intents, db };
}

function confirmedIntent({ id, kind, customSubmissionId = null, sentAt }) {
  return {
    id, agencyId:"agency-1", creatorId:"creator-1", customOrderId:"order-1", customSubmissionId,
    kind, state:"CONFIRMED", accountId:"tg-1", remoteMessageId: kind === "TASK" ? 501 : 601,
    remoteRecipientTelegramUserId:"1001", remoteSentAt: sentAt, confirmedAt: sentAt, createdAt: sentAt,
  };
}

test("CONTENT obligation starts only from exact provider-confirmed TASK and reminder clock anchors to TASK receipt", async () => {
  const fx=fixture();
  let obligation=await deriveCustomModelObligation({agencyId:"agency-1",order:fx.order,db:fx.db});
  assert.equal(obligation.state,"NO_INSTRUCTION");
  assert.equal(obligation.modelOwesResponse,false);

  fx.intents.push({id:"task-planned",agencyId:"agency-1",customOrderId:"order-1",kind:"TASK",state:"PLANNED",accountId:"tg-1",createdAt:new Date(fx.now.getTime()-40*60_000)});
  obligation=await deriveCustomModelObligation({agencyId:"agency-1",order:fx.order,db:fx.db});
  assert.equal(obligation.state,"INITIAL_DISPATCH_PENDING");
  assert.equal(obligation.modelOwesResponse,false);

  const sentAt=new Date(fx.now.getTime()-35*60_000);
  fx.intents.splice(0,fx.intents.length,confirmedIntent({id:"task-confirmed",kind:"TASK",sentAt}));
  obligation=await deriveCustomModelObligation({agencyId:"agency-1",order:fx.order,db:fx.db});
  assert.equal(obligation.state,"INITIAL_WAITING_RESPONSE");
  assert.equal(obligation.modelOwesResponse,true);
  assert.equal(reminderBindingFromObligation(obligation).replyToMessageId,"501");
  const due=desiredReminderSchedule(fx.order,normalizeTelegramCustomReminders({content:{firstAfterMinutes:30}}),fx.now,{modelObligation:obligation});
  assert.equal(due.at.toISOString(),fx.now.toISOString(),"overdue schedule clamps to now but remains anchored to provider TASK time");
  assert.match(due.key,/^CONTENT:TASK:task-confirmed:/);
});

test("canonical response satisfies model obligation throughout review/approval and REQUEST_REVISION does not restart it before provider confirmation", async () => {
  const fx=fixture();
  fx.intents.push(confirmedIntent({id:"task-confirmed",kind:"TASK",sentAt:new Date(fx.now.getTime()-60*60_000)}));
  fx.submissions.push({id:"v1",agencyId:"agency-1",creatorId:"creator-1",customOrderId:"order-1",pipelineDisposition:"ACTIVE",reviewStatus:"WAITING_REVIEW",receivedAt:new Date(fx.now.getTime()-10*60_000),createdAt:new Date(fx.now.getTime()-10*60_000)});
  let obligation=await deriveCustomModelObligation({agencyId:"agency-1",order:fx.order,db:fx.db});
  assert.equal(obligation.state,"RESPONSE_RECEIVED");
  assert.equal(obligation.modelOwesResponse,false);
  assert.equal(desiredReminderSchedule(fx.order,normalizeTelegramCustomReminders({}),fx.now,{modelObligation:obligation}).at,null);

  fx.submissions[0].reviewStatus="APPROVED";
  obligation=await deriveCustomModelObligation({agencyId:"agency-1",order:fx.order,db:fx.db});
  assert.equal(obligation.state,"NO_MODEL_OBLIGATION");
  assert.equal(obligation.modelOwesResponse,false);

  fx.submissions[0].reviewStatus="REVISION_REQUESTED";
  fx.submissions[0].reviewedAt=new Date(fx.now.getTime()-1000);
  fx.intents.push({id:"revision-planned",agencyId:"agency-1",customOrderId:"order-1",customSubmissionId:"v1",kind:"REVISION_REQUEST",state:"PLANNED",accountId:"tg-1",createdAt:new Date(fx.now.getTime()-900)});
  obligation=await deriveCustomModelObligation({agencyId:"agency-1",order:fx.order,db:fx.db});
  assert.equal(obligation.state,"REVISION_DISPATCH_PENDING");
  assert.equal(obligation.modelOwesResponse,false);
  assert.equal(desiredReminderSchedule(fx.order,normalizeTelegramCustomReminders({}),fx.now,{modelObligation:obligation}).at,null);
});

test("revision UNKNOWN never creates reminder obligation; exact CONFIRMED revision starts a fresh cycle anchored to revision receipt", async () => {
  const fx=fixture();
  fx.submissions.push({id:"v1",agencyId:"agency-1",creatorId:"creator-1",customOrderId:"order-1",pipelineDisposition:"ACTIVE",reviewStatus:"REVISION_REQUESTED",reviewedAt:new Date(fx.now.getTime()-20*60_000),receivedAt:new Date(fx.now.getTime()-60*60_000),createdAt:new Date(fx.now.getTime()-60*60_000)});
  fx.intents.push({id:"revision-unknown",agencyId:"agency-1",customOrderId:"order-1",customSubmissionId:"v1",kind:"REVISION_REQUEST",state:"RECONCILE_REQUIRED",accountId:"tg-1",createdAt:new Date(fx.now.getTime()-15*60_000)});
  let obligation=await deriveCustomModelObligation({agencyId:"agency-1",order:fx.order,db:fx.db});
  assert.equal(obligation.state,"REVISION_DELIVERY_UNKNOWN");
  assert.equal(obligation.modelOwesResponse,false);

  const sentAt=new Date(fx.now.getTime()-31*60_000);
  fx.intents.splice(0,fx.intents.length,confirmedIntent({id:"revision-confirmed",kind:"REVISION_REQUEST",customSubmissionId:"v1",sentAt}));
  fx.order.lastReminderAt=new Date(fx.now.getTime()-2*60*60_000);
  fx.order.lastReminderKey="CONTENT:2026-09-07T16:00:00.000Z"; // legacy initial-cycle reminder
  obligation=await deriveCustomModelObligation({agencyId:"agency-1",order:fx.order,db:fx.db});
  assert.equal(obligation.state,"REVISION_WAITING_RESPONSE");
  assert.equal(obligation.modelOwesResponse,true);
  const binding=reminderBindingFromObligation(obligation);
  assert.equal(binding.replyToMessageId,"601");
  const due=desiredReminderSchedule(fx.order,normalizeTelegramCustomReminders({content:{firstAfterMinutes:30,repeatEveryMinutes:5}}),fx.now,{modelObligation:obligation});
  assert.match(due.key,/^CONTENT:REVISION_REQUEST:revision-confirmed:/);
  assert.equal(due.at.toISOString(),fx.now.toISOString(),"legacy TASK reminder history must not shift the new revision cycle");
});

test("REVISION_REQUESTED without any provider anchor is REVISION_DISPATCH_BLOCKED and creates no model reminder obligation", async () => {
  const fx=fixture();
  fx.db.agencyTelegramMtprotoAccount = { async findFirst() { return null; } };
  fx.submissions.push({ id:"v1-blocked", agencyId:"agency-1", creatorId:"creator-1", customOrderId:"order-1", pipelineDisposition:"ACTIVE", reviewStatus:"REVISION_REQUESTED", reviewComment:"redo", reviewedAt:new Date(fx.now.getTime()-1000), telegramMessageIds:[101], telegramSourceAccountId:null, telegramSourceUserId:null, receivedAt:new Date(fx.now.getTime()-10_000), createdAt:new Date(fx.now.getTime()-10_000) });
  const obligation=await deriveCustomModelObligation({agencyId:"agency-1",order:fx.order,db:fx.db});
  assert.equal(obligation.state,"REVISION_DISPATCH_BLOCKED");
  assert.equal(obligation.modelOwesResponse,false);
  assert.equal(desiredReminderSchedule(fx.order,normalizeTelegramCustomReminders({}),fx.now,{modelObligation:obligation}).at,null);
});

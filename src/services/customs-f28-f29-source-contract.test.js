"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
function read(rel){ return fs.readFileSync(path.join(__dirname, "..", rel), "utf8"); }

test("F28 has one current reminder schedule projector and all current writers delegate to it",()=>{
  const reminders=read("services/custom-order-reminders.js");
  const orders=read("services/custom-orders-service.js");
  const settings=read("services/settings-service.js");
  const delivery=read("services/telegram-delivery-authority-service.js");
  assert.match(reminders,/async function reprojectCustomReminderSchedule/);
  assert.match(reminders,/updatedAt:\s*revision/);
  assert.match(reminders,/nextReminderAt:\s*desiredAt/);
  assert.match(reminders,/telegramTaskMessageId\s*==\s*null/,"schedule projector must stay unarmed before canonical TASK confirmation");
  for(const source of [orders,settings,delivery]) assert.match(source,/reprojectCustomReminderSchedule/);
  assert.doesNotMatch(settings,/data:\s*\{[^}]*nextReminderAt/s,"settings must not remain an independent direct schedule writer");
  assert.doesNotMatch(delivery,/data:\s*\{[^}]*nextReminderAt/s,"Telegram settlement must not persist stale derived schedule directly");
});

test("F29 review-required lifecycle is routed through explicit queue and management resolution authority",()=>{
  const routes=read("routes/custom-orders.js");
  const inbound=read("services/telegram-inbound-authority-service.js");
  assert.match(routes,/router\.get\("\/telegram-inbound\/review-required"/);
  assert.match(routes,/router\.post\("\/telegram-inbound\/:eventId\/resolve"/);
  assert.match(routes,/router\.get\("\/telegram-inbound\/:eventId\/candidates"/);
  assert.match(inbound,/content\.review_customs/);
  assert.match(inbound,/team\.analytics\.view/);
  for(const action of ["RETRY_AFTER_REPAIR","ASSIGN_TO_CONTENT_ORDER","SKIP"]) assert.match(inbound,new RegExp(action));
  assert.match(inbound,/reviewReason\(reason\)/);
  assert.match(inbound,/custom_order\.telegram_inbound_review_(?:skip|retry|assign)/);
  assert.match(inbound,/submissionId:\s*null/);
  assert.match(inbound,/convergeLinkedSubmissionState/);
  assert.match(inbound,/convergedLinked/,"backend-owned sweep must converge linked stale review rows without UI");
  assert.match(inbound,/required:\s*true/,"explicit human resolutions must require durable audit in the same transaction");
  assert.match(inbound,/isolationLevel:\s*"Serializable"/,"human review proof/decision must be serialized with concurrent provenance changes");
  assert.match(inbound,/TELEGRAM_INBOUND_REVIEW_TRANSACTION_REQUIRED/,"human resolution must fail closed without transaction support");
  assert.match(inbound,/async function loadReviewCandidateOrders/);
  assert.match(inbound,/async function searchTelegramInboundReviewCandidates/);
  assert.match(inbound,/proofState:\s*"PROVEN"/);
  assert.match(inbound,/take:\s*20/,"candidate lookup must be bounded per creator rather than globally starving scoped creators");
  assert.match(inbound,/PROJECTION_RETRYABLE_STATES\s*=\s*\["PENDING",\s*"FAILED_RETRYABLE"\]/);
});

test("stale Audit16 reminder-lease source shape is retired in favor of current delivery authority",()=>{
  const audit16=read("services/audit16-product-surface-closure.test.js");
  assert.match(audit16,/telegram-delivery-authority-service\.js/);
  assert.match(audit16,/assertExecutionAccessFence/);
  assert.doesNotMatch(audit16,/reminderLeaseMemberId/);
  assert.doesNotMatch(audit16,/reminderLeaseAccessEpoch/);
});

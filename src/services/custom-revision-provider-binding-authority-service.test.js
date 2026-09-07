"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveRevisionProviderBinding } = require("./custom-revision-provider-binding-authority-service");

function dbFixture({ task = null, lifecycleState = "ACTIVE" } = {}) {
  return {
    telegramDeliveryIntent: { async findFirst() { return task; } },
    agencyTelegramMtprotoAccount: { async findFirst({ where }) { return where.id === "tg-1" ? { id: "tg-1", lifecycleState } : null; } },
  };
}

test("confirmed TASK is preferred over pinned source for revision provider binding", async () => {
  const task = { id:"task-1", state:"CONFIRMED", accountId:"tg-1", remoteMessageId:501, remoteRecipientTelegramUserId:"1001" };
  const binding = await resolveRevisionProviderBinding({ agencyId:"agency-1", orderId:"order-1", submission:{ id:"sub-1", telegramSourceAccountId:"tg-1", telegramSourceUserId:"2002", telegramMessageIds:[700] }, db:dbFixture({ task }) });
  assert.equal(binding.anchorKind,"CONFIRMED_TASK");
  assert.equal(binding.replyToMessageId,"501");
  assert.equal(binding.recipientTelegramUserId,"1001");
  assert.equal(binding.replyToDeliveryId,"task-1");
});

test("pinned submission source is the historical revision fallback when TASK does not exist", async () => {
  const binding = await resolveRevisionProviderBinding({ agencyId:"agency-1", orderId:"order-1", submission:{ id:"sub-1", telegramSourceAccountId:"tg-1", telegramSourceUserId:"2002", telegramMessageIds:[701,703,702] }, db:dbFixture() });
  assert.equal(binding.anchorKind,"PINNED_SUBMISSION_SOURCE");
  assert.equal(binding.replyToMessageId,"703");
  assert.equal(binding.recipientTelegramUserId,"2002");
  assert.equal(binding.replyToDeliveryId,null);
});

test("missing TASK and pinned source is explicit revision dispatch blocked, never synthetic success", async () => {
  await assert.rejects(
    () => resolveRevisionProviderBinding({ agencyId:"agency-1", orderId:"order-1", submission:{ id:"sub-1", telegramMessageIds:[701] }, db:dbFixture() }),
    (error) => error?.code === "CUSTOM_REVISION_DISPATCH_BLOCKED" && error?.blockedCode === "TASK_AND_PINNED_SOURCE_UNAVAILABLE",
  );
});

test("retiring pinned provider account is explicit revision dispatch blocked", async () => {
  await assert.rejects(
    () => resolveRevisionProviderBinding({ agencyId:"agency-1", orderId:"order-1", submission:{ id:"sub-1", telegramSourceAccountId:"tg-1", telegramSourceUserId:"2002", telegramMessageIds:[701] }, db:dbFixture({ lifecycleState:"RETIRING" }) }),
    (error) => error?.code === "CUSTOM_REVISION_DISPATCH_BLOCKED" && error?.blockedCode === "PROVIDER_ACCOUNT_RETIRING",
  );
});

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyCancellationInstructionFacts, deriveCustomCancellationInstruction, requireCancellationProviderAnchor } = require("./custom-cancellation-instruction-authority-service");

const order = { id: "order-1", agencyId: "agency-1", creatorId: "creator-1", type: "CONTENT", status: "CANCELLED" };
const submission = { id: "v1", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1", reviewStatus: "REVISION_REQUESTED", receivedAt: new Date("2026-09-07T18:00:00Z"), createdAt: new Date("2026-09-07T18:00:00Z") };
const task = { id: "task-1", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1", accountId: "tg-task", kind: "TASK", state: "CONFIRMED", remoteMessageId: 501, remoteRecipientTelegramUserId: "900001", confirmedAt: new Date("2026-09-07T17:00:00Z") };
const revision = { id: "revision-1", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1", customSubmissionId: "v1", accountId: "tg-revision", kind: "REVISION_REQUEST", state: "CONFIRMED", remoteMessageId: 601, remoteRecipientTelegramUserId: "900001", confirmedAt: new Date("2026-09-07T18:05:00Z") };

test("confirmed revision is the strongest cancellation instruction and owns provider account/thread", () => {
  const result = classifyCancellationInstructionFacts({ submission, revision, task });
  assert.equal(result.state, "CONFIRMED_REVISION");
  assert.equal(result.anchor.anchorKind, "REVISION_REQUEST");
  assert.equal(result.anchor.accountId, "tg-revision");
  assert.equal(result.anchor.replyToMessageId, "601");
  assert.equal(result.instruction.id, "revision-1");
});

test("unknown revision outcome blocks fallback to an older confirmed TASK", () => {
  const result = classifyCancellationInstructionFacts({ submission, revision: { ...revision, state: "RECONCILE_REQUIRED", remoteMessageId: null }, task });
  assert.equal(result.state, "REVISION_OUTCOME_UNRESOLVED");
  assert.equal(result.anchor, null);
  assert.throws(() => requireCancellationProviderAnchor(result), (error) => error?.code === "CUSTOM_CANCELLATION_INSTRUCTION_OUTCOME_UNRESOLVED");
});

test("proven-precommit revision has no provider effect and safely falls back to confirmed TASK", () => {
  for (const state of ["PLANNED", "CLAIMED", "FAILED_PRECOMMIT", "CANCELLED"]) {
    const result = classifyCancellationInstructionFacts({ submission, revision: { ...revision, state, remoteMessageId: null }, task });
    assert.equal(result.state, "CONFIRMED_TASK", state);
    assert.equal(result.anchor.accountId, "tg-task", state);
  }
});

test("historical confirmed provider identity remains cancellation proof without remoteSentAt", () => {
  const result = classifyCancellationInstructionFacts({ submission, revision: { ...revision, remoteSentAt: null }, task: null });
  assert.equal(result.state, "CONFIRMED_REVISION");
  assert.equal(result.anchor.remoteSentAt, new Date(revision.confirmedAt).toISOString());
});

test("derive authority reads exact latest revision decision and returns no synthetic delivery when no instruction was proven", async () => {
  const db = {
    customContentSubmission: { findFirst: async () => ({ ...submission }) },
    telegramDeliveryIntent: { findFirst: async ({ where }) => where.kind === "REVISION_REQUEST" ? null : null },
  };
  const result = await deriveCustomCancellationInstruction({ agencyId: "agency-1", order, db });
  assert.equal(result.state, "NO_DELIVERED_INSTRUCTION");
  assert.equal(result.anchor, null);
  assert.throws(() => requireCancellationProviderAnchor(result), (error) => error?.code === "CUSTOM_CANCELLATION_MODEL_INSTRUCTION_NOT_DELIVERED");
});

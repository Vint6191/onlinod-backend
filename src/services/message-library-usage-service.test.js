"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createContentDb } = require("../../scripts/test-support/message-library-memory-db");
const { normalizeUsageInput, recordMessageLibraryUsage } = require("./message-library-usage-service");
const input = { eventId: "usage-intent-000001", creatorId: "creator-a", scriptId: "script-a", messageId: "message-a", dialogId: "1234", eventType: "draft_inserted" };
function request(m, extra = {}) { return { db: m.db, agencyId: "agency-a", userId: "user-a", actorMember: { id: "member-a", userId: "user-a", accessEpoch: 1 }, input: { ...input, ...extra } }; }

test("lost response retry returns the same canonical event and one audit", async () => {
  const m = createContentDb(), req = request(m);
  const first = await recordMessageLibraryUsage(req), next = await recordMessageLibraryUsage(req);
  assert.equal(first.replayed, false); assert.equal(next.replayed, true);
  assert.deepEqual(first.event, next.event); assert.equal(m.state.usageEvents.length, 1); assert.equal(m.state.contentAudit.length, 1);
});
for (const patch of [{ scriptId: "other-script" }, { creatorId: "other-creator" }, { messageId: "other" }, { dialogId: "9999" }, { eventType: "message_sent" }, { amount: 5 }, { metadata: { mediaCount: 1 } }]) {
  test(`same key with changed ${Object.keys(patch)[0]} cannot create another effect`, async () => {
    const m = createContentDb(); m.state.creators.push({ id: "other-creator", agencyId: "agency-a", deletedAt: null });
    await recordMessageLibraryUsage(request(m));
    await assert.rejects(recordMessageLibraryUsage(request(m, patch)), { code: "MESSAGE_LIBRARY_USAGE_EVENT_CONFLICT" });
    assert.equal(m.state.usageEvents.length, 1); assert.equal(m.state.contentAudit.length, 1);
  });
}
test("a second legitimate insertion has a different event ID and remains countable", async () => {
  const m = createContentDb(); await recordMessageLibraryUsage(request(m));
  const result = await recordMessageLibraryUsage(request(m, { eventId: "usage-intent-000002" }));
  assert.equal(result.replayed, false); assert.equal(m.state.usageEvents.length, 2);
});
for (const change of ["epoch", "revoked", "scope", "creator", "agency"]) test(`replay checks live ${change} before revealing the receipt`, async () => {
  const m = createContentDb(); await recordMessageLibraryUsage(request(m));
  if (change === "epoch") m.state.member.accessEpoch++;
  if (change === "revoked") m.state.member.deactivatedAt = m.clock;
  if (change === "scope") Object.assign(m.state.member, { role: "OPERATOR", roleKey: "chatter", assignedCreators: [] });
  if (change === "creator") m.state.creators[0].deletedAt = m.clock;
  if (change === "agency") m.state.agencies[0].deletedAt = m.clock;
  await assert.rejects(recordMessageLibraryUsage(request(m)));
  assert.equal(m.state.usageEvents.length, 1); assert.equal(m.state.contentAudit.length, 1);
});
test("script/block cleanup does not erase a previously committed usage receipt", async () => {
  const m = createContentDb(), first = await recordMessageLibraryUsage(request(m));
  m.state.collections = []; m.state.blocks = [];
  assert.deepEqual((await recordMessageLibraryUsage(request(m))).event, first.event);
  await assert.rejects(recordMessageLibraryUsage(request(m, { eventId: "usage-intent-000002" })), { code: "MESSAGE_LIBRARY_SCRIPT_NOT_FOUND" });
});
test("audit failure rolls back event and leaves the same key retryable", async () => {
  const options = { failContentAudit: true }, m = createContentDb(options);
  await assert.rejects(recordMessageLibraryUsage(request(m)), /audit unavailable/);
  assert.equal(m.state.usageEvents.length, 0); assert.equal(m.state.contentAudit.length, 0);
});
test("missing/invalid intent IDs and non-finite amounts fail before opening a transaction", async () => {
  let tx = 0; const req = request({ db: { $transaction() { tx++; throw Error("unexpected transaction"); } } });
  for (const eventId of [undefined, null, "", "short", "x".repeat(121), "valid-key-with space", {}]) await assert.rejects(recordMessageLibraryUsage({ ...req, input: { ...input, eventId } }), { code: "MESSAGE_LIBRARY_USAGE_EVENT_ID_REQUIRED" });
  for (const amount of [Infinity, "NaN", "1e999"]) await assert.rejects(recordMessageLibraryUsage({ ...req, input: { ...input, amount } }), { code: "MESSAGE_LIBRARY_USAGE_NUMBER_INVALID" });
  assert.equal(tx, 0);
});
test("canonical fingerprint ignores unpersisted text, object order and caller receipt forgery", () => {
  const clean = normalizeUsageInput({ ...input, metadata: { price: 5, mediaCount: 2 } });
  const dirty = normalizeUsageInput({ ...input, text: "secret", metadata: { mediaCount: 2, price: 5, text: "secret", usageReceipt: { fingerprint: "forged" } } });
  assert.equal(clean.fingerprint, dirty.fingerprint); assert.equal(JSON.stringify(dirty).includes("secret"), false); assert.equal(JSON.stringify(dirty).includes("forged"), false);
});

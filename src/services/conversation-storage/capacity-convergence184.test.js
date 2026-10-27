"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { ConversationRuntime } = require("./runtime");
const { CrmRepository } = require("./crm-repository");
const ctx = { agencyId: "agency", creatorId: "creator", scopeId: "scope" };
test("branch capacity retains measured sizes and coalesces concurrent checks", async () => {
  let calls = 0;
  const runtime = new ConversationRuntime({ dialogs: { $queryRawUnsafe: async () => {
    calls++; return [{ bytes: 900000000n, databases: [{ datname: "neondb", bytes: 880000000 }, { datname: "nod_dialogs", bytes: 20000000 }] }];
  } }, crm: {} }, {});
  const results = await Promise.allSettled(Array.from({ length: 25 }, () => runtime.capacity("dialogs")));
  assert.equal(calls, 1);
  for (const result of results) {
    assert.equal(result.status, "rejected"); assert.equal(result.reason.status, 507);
    assert.equal(result.reason.capacity.usedBytes, 900000000); assert.equal(result.reason.capacity.maxBytes, 850000000);
    assert.equal(result.reason.capacity.databases[0].database, "neondb"); assert.equal(result.reason.retryAfterMs, 300000);
  }
  await assert.rejects(runtime.capacity("dialogs"), e => e.capacity.usedBytes === 900000000);
  assert.equal(calls, 1);
  runtime.capacities.clear(); runtime.db.dialogs.$queryRawUnsafe = async () => [{ bytes: 1000n }];
  await runtime.capacity("dialogs");
});
test("invalid capacity measurements cannot admit writes", async () => {
  const runtime = new ConversationRuntime({ dialogs: { $queryRawUnsafe: async () => [{ bytes: "not-a-size" }] }, crm: {} }, {});
  await assert.rejects(runtime.capacity("dialogs"), { code: "CONVERSATION_CAPACITY_MEASUREMENT_INVALID" });
});
test("server CRM reads scoped canonical identity without copying it into CRM", async () => {
  let reads = 0;
  const crmDb = { $queryRawUnsafe: async () => [{ profile: { preferredName: "Manual", platformUsername: "old" }, revision: 4n, field_versions: {}, manual_fields: ["preferredName"], notes: [] }],
    $executeRawUnsafe: async () => assert.fail("read cannot mirror data"), $transaction: async () => assert.fail("read cannot create a profile") };
  const runtime = new ConversationRuntime({ dialogs: {}, crm: crmDb }, {
    creatorFan: { findMany: async query => {
      reads++; assert.deepEqual(query.where, { agencyId: "agency", creatorId: "creator", onlyFansUserId: { in: ["42"] } });
      return [{ id: "fan", creatorId: "creator", onlyFansUserId: "42", username: "current", displayName: "Provider" }];
    } },
  });
  const profile = await runtime.crm.getProfile(ctx, "42");
  assert.equal(profile.platformUsername, "current"); assert.equal(profile.platformDisplayName, "Provider");
  assert.equal(profile.fanName, "Manual"); assert.equal(profile.revision, 4); assert.equal(reads, 1);
});
test("campaign pages batch identities outside the CRM transaction and fence concurrent changes", async () => {
  let inTransaction = false, head = 10n, calls = 0, changeDuringRead = false;
  const db = { $executeRawUnsafe: async () => 1, $queryRawUnsafe: async sql => {
    if (sql.includes("FROM crm_profile")) return Array.from({ length: 100 }, (_, i) => ({ fan_id: String(i + 1), profile: {}, revision: 1, manual_fields: [], field_versions: {}, updated_at: new Date() }));
    return [{ scope_id: "scope", agency_id: "agency", platform_creator_id: "model", revision: 3n }];
  }, $transaction: async fn => { inTransaction = true; try { return await fn(db); } finally { inTransaction = false; } } };
  const crm = new CrmRepository(db, {}, { revision: async () => head, read: async (_ctx, ids) => {
    calls++; assert.equal(inTransaction, false); assert.equal(ids.length, 100);
    if (changeDuringRead) head++;
    return ids.map(id => ({ onlyFansUserId: id, platformIdentity: { username: `fan${id}` } }));
  } });
  const page = await crm.readPage({ ...ctx, platformCreatorId: "model" }, {});
  assert.equal(page.revision, 13); assert.equal(page.rows[0].profile.platformUsername, "fan1"); assert.equal(calls, 1);
  assert.equal(await crm.readRevision(ctx), 13); head++;
  await assert.rejects(crm.readPage({ ...ctx, platformCreatorId: "model" }, { revision: 13 }), { code: "CAMPAIGN_SOURCE_CHANGED" });
  changeDuringRead = true;
  await assert.rejects(crm.readPage({ ...ctx, platformCreatorId: "model" }, {}), { code: "CAMPAIGN_SOURCE_CHANGED" });
});

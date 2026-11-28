"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const { createContentDb } = require("../../scripts/test-support/message-library-memory-db");
const {
  findMessageLibraryScript, findMessageLibraryBlock, inspectMessageLibraryBlockIdentities,
  adoptLegacyMessageLibraryBlockIds, withMessageLibraryMutation, changeMessageLibraryLifecycle,
  runMessageLibraryTrashMaintenance,
} = require("./message-library-lifecycle-service");
const { recordMessageLibraryUsage } = require("./message-library-usage-service");

const scope = { agencyId: "agency-a", creatorId: "creator-a" };
const actor = { id: "member-a", userId: "user-a", accessEpoch: 1 };
const usage = { eventId: "identity-event-000001", creatorId: "creator-a", scriptId: "script-a", messageId: "message-a" };

test("script identity falls back to server ID only for a null client ID", async () => {
  const m = createContentDb();
  assert.equal((await findMessageLibraryScript({ db: m.db, ...scope, scriptId: "script-a" })).id, "collection-a");
  assert.equal(await findMessageLibraryScript({ db: m.db, ...scope, scriptId: "collection-a" }), null);
  m.state.collections[0].clientId = null;
  assert.equal((await findMessageLibraryScript({ db: m.db, ...scope, scriptId: "collection-a" })).id, "collection-a");
  assert.equal(await findMessageLibraryScript({ db: m.db, ...scope, scriptId: "script-a" }), null);
});

test("ambiguous historical script alias and foreign creator both fail closed", async () => {
  const m = createContentDb();
  m.state.collections[0].clientId = null;
  m.state.collections.push({ ...m.state.collections[0], id: "another-row", clientId: "collection-a" });
  await assert.rejects(findMessageLibraryScript({ db: m.db, ...scope, scriptId: "collection-a" }), { code: "MESSAGE_LIBRARY_IDENTITY_AMBIGUOUS" });
  m.state.collections.pop();
  await assert.rejects(findMessageLibraryScript({ db: m.db, ...scope, creatorId: "another-creator", scriptId: "collection-a" }), { code: "MESSAGE_LIBRARY_SCRIPT_CREATOR_MISMATCH" });
  assert.equal(await findMessageLibraryScript({ db: m.db, ...scope, agencyId: "another-agency", scriptId: "collection-a" }), null);
});

test("block public ID never selects another block's nonpublic server ID", async () => {
  const m = createContentDb();
  m.state.blocks.push({ ...m.state.blocks[0], id: "block-b", clientId: "block-a" });
  assert.equal((await findMessageLibraryBlock({ db: m.db, collectionId: "collection-a", messageId: "block-a" })).id, "block-b");
  assert.equal(await findMessageLibraryBlock({ db: m.db, collectionId: "another-collection", messageId: "block-a" }), null);
  m.state.blocks[0].clientId = null;
  await assert.rejects(findMessageLibraryBlock({ db: m.db, collectionId: "collection-a", messageId: "block-a" }), { code: "MESSAGE_LIBRARY_IDENTITY_AMBIGUOUS" });
  await assert.rejects(inspectMessageLibraryBlockIdentities({ db: m.db, collectionId: "collection-a", messageIds: ["block-a"] }), { code: "MESSAGE_LIBRARY_IDENTITY_AMBIGUOUS" });
});

test("legacy block adoption retains the row and refuses missing existing price", async () => {
  const m = createContentDb(); m.state.blocks[0].clientId = null;
  const writes = [], tx = { ...m.db, $executeRawUnsafe: async (...args) => writes.push(args) };
  await assert.rejects(adoptLegacyMessageLibraryBlockIds({ tx, collectionId: "collection-a", blocks: [{ clientId: "block-a", priceProvided: false }] }), { code: "MESSAGE_LIBRARY_PRICE_REQUIRED" });
  assert.equal(writes.length, 0);
  await adoptLegacyMessageLibraryBlockIds({ tx, collectionId: "collection-a", blocks: [{ clientId: "block-a", priceProvided: true }, { clientId: "new-block", priceProvided: false }] });
  assert.equal(writes.length, 1); assert.equal(writes[0][1], "collection-a"); assert.deepEqual(writes[0][2], ["block-a"]);
  assert.match(writes[0][0], /"clientId" IS NULL/);
});

test("identity resolution is bounded by candidate aliases, not the library size", async () => {
  const queries = [], db = { contentCollection: { findMany: async q => (queries.push(q), []) }, contentBlock: { findMany: async q => (queries.push(q), []) } };
  await findMessageLibraryScript({ db, ...scope, scriptId: "script-a" });
  await findMessageLibraryBlock({ db, collectionId: "collection-a", messageId: "block-a" });
  await inspectMessageLibraryBlockIdentities({ db, collectionId: "collection-a", messageIds: ["a", "b", "a"] });
  assert.deepEqual(queries.map(q => q.take), [2, 2, 4]);
  assert.deepEqual(queries[2].select, { id: true, clientId: true });
});

test("legacy parent lifecycle and scheduled cleanup use its public fallback", async () => {
  const m = createContentDb(); m.state.collections[0].clientId = null;
  const changed = await withMessageLibraryMutation({ db: m.db, ...scope, actorMember: actor, userId: "user-a", scriptId: "collection-a", action: "trash",
    work: args => changeMessageLibraryLifecycle({ ...args, action: "trash", userId: "user-a" }) });
  assert.equal(changed.item.id, "collection-a");
  Object.assign(m.state.collections[0], { purgeAfter: new Date("2025-01-01") });
  const cleaned = await runMessageLibraryTrashMaintenance({ db: m.db });
  assert.equal(cleaned.ok, true); assert.equal(cleaned.scriptsDeleted, 1); assert.equal(cleaned.blocksDeleted, 1);
});

test("usage targets canonical block ID and rejects a newly ambiguous alias", async () => {
  const m = createContentDb();
  m.state.blocks.push({ ...m.state.blocks[0], id: "block-b", clientId: "block-a" });
  const req = { db: m.db, agencyId: scope.agencyId, userId: "user-a", actorMember: actor, input: { ...usage, messageId: "block-a" } };
  const first = await recordMessageLibraryUsage(req); assert.equal(first.event.blockId, "block-b");
  m.state.blocks[0].clientId = null;
  // A confirmed receipt remains replayable even if a later historical repair
  // made the alias ambiguous. Fresh intents must resolve the current target.
  assert.equal((await recordMessageLibraryUsage(req)).replayed, true);
  await assert.rejects(recordMessageLibraryUsage({ ...req, input: { ...req.input, eventId: "identity-event-000002" } }), { code: "MESSAGE_LIBRARY_IDENTITY_AMBIGUOUS" });
  assert.equal(m.state.usageEvents.length, 1); assert.equal(m.state.contentAudit.length, 1);
});

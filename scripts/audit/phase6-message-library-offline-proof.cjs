"use strict";
// Executes the production service + authority + commit kernel against real SQL.
// PGlite is a single serialized backend; this is NOT a multi-session lock proof.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { randomUUID } = require("node:crypto");
const { PGlite } = require(process.env.ONLINOD_PGLITE_MODULE || "@electric-sql/pglite");
const { recordMessageLibraryUsage } = require("../../src/services/message-library-usage-service");
const { withProductBilling } = require("../../src/services/product-billing-context-service");
test("D1 actual usage service on file-backed PostgreSQL WASM", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "onlinod-d1-")); let pg = new PGlite(directory); await pg.waitReady;
  t.after(async () => { await pg.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await pg.exec(fs.readFileSync(path.join(__dirname, "../../test/fixtures/phase6-message-library-I7-baseline.sql"), "utf8"));
  await pg.exec(`INSERT INTO "Agency"(id,name,"trialEndsAt","updatedAt") VALUES ('a','A','2099-01-01',CURRENT_TIMESTAMP),('b','B','2099-01-01',CURRENT_TIMESTAMP);
    INSERT INTO "User"(id,email,"passwordHash","updatedAt") VALUES ('u','u@test','x',CURRENT_TIMESTAMP),('v','v@test','x',CURRENT_TIMESTAMP);
    INSERT INTO "AgencyMember"(id,"agencyId","userId",role,"roleKey","assignedCreators","updatedAt") VALUES ('m','a','u','OWNER','owner','"all"',CURRENT_TIMESTAMP),('n','b','u','OWNER','owner','"all"',CURRENT_TIMESTAMP),('v','a','v','OWNER','owner','"all"',CURRENT_TIMESTAMP);
    INSERT INTO "CreatorAccount"(id,"agencyId","displayName","updatedAt") VALUES ('c','a','C',CURRENT_TIMESTAMP),('d','a','D',CURRENT_TIMESTAMP),('b','b','B',CURRENT_TIMESTAMP);
    INSERT INTO "ContentCollection"(id,"agencyId","creatorId",kind,title,"clientId","updatedAt") VALUES ('s','a','c','message_library_script','Script','script',CURRENT_TIMESTAMP),('b','b','b','message_library_script','Script','script',CURRENT_TIMESTAMP);
    INSERT INTO "ContentBlock"(id,"collectionId","clientId","updatedAt") VALUES ('block','s','message',CURRENT_TIMESTAMP);`);
  const calls = []; let failAudit = false;
  function adapter(sql) {
    async function rows(query, params = []) { const result = await sql.query(query, params); calls.push({ query, rows: result.rows.length, paramBytes: JSON.stringify(params).length }); return result.rows; }
    async function insert(table, data) { const keys = Object.keys(data); return (await rows(`INSERT INTO "${table}" (${keys.map(k => `"${k}"`).join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")}) RETURNING *`, Object.values(data).map(v => v && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v)))[0]; }
    return {
      $queryRawUnsafe: (query, ...params) => rows(query, params),
      $executeRawUnsafe: async (query, ...params) => (await rows(query, params)).length,
      agencyMember: { findFirst: async ({ where: w }) => (await rows(`SELECT m.* FROM "AgencyMember" m JOIN "User" u ON u.id=m."userId" WHERE m.id=$1 AND m."agencyId"=$2 AND m."userId"=$3 AND m."deletedAt" IS NULL AND m."deactivatedAt" IS NULL AND u."disabledAt" IS NULL LIMIT 1`, [w.id, w.agencyId, w.userId]))[0] || null },
      contentCollection: { findFirst: async ({ where: w }) => (await rows('SELECT * FROM "ContentCollection" WHERE "agencyId"=$1 AND "clientId"=$2 LIMIT 1', [w.agencyId, w.clientId]))[0] || null },
      contentBlock: { findFirst: async ({ where: w }) => (await rows('SELECT * FROM "ContentBlock" WHERE "collectionId"=$1 AND ("clientId"=$2 OR (id=$2 AND "clientId" IS NULL)) LIMIT 1', [w.collectionId, w.OR[0].clientId]))[0] || null },
      contentUsageEvent: { findUnique: async ({ where }) => (await rows('SELECT * FROM "ContentUsageEvent" WHERE id=$1', [where.id]))[0] || null, create: ({ data }) => insert("ContentUsageEvent", data) },
      auditLog: { create: ({ data }) => { if (failAudit) throw Error("injected audit failure"); return insert("AuditLog", { id: randomUUID(), ...data }); } },
    };
  }
  const db = { $transaction: fn => pg.transaction(sql => fn(adapter(sql))) };
  const input = { eventId: "sql-usage-intent-0001", creatorId: "c", scriptId: "script", messageId: "message", dialogId: "1234", eventType: "draft_inserted" };
  const req = { db, agencyId: "a", userId: "u", actorMember: { id: "m", accessEpoch: 1 }, input };
  const run = (patch = {}) => { const r = { ...req, ...patch }; return withProductBilling(r.agencyId, () => recordMessageLibraryUsage(r)); };
  const counts = async () => (await pg.query('SELECT (SELECT count(*)::int FROM "ContentUsageEvent") AS events,(SELECT count(*)::int FROM "AuditLog") AS audits')).rows[0];
  let original;
  await t.test("lost response: retry returns one committed event and one audit", async () => {
    original = await run(); const replay = await run(); assert.equal(replay.replayed, true); assert.deepEqual(original.event, replay.event); assert.deepEqual(await counts(), { events: 1, audits: 1 });
  });
  await t.test("receipt survives engine close/reopen and application recreation", async () => {
    await pg.close(); pg = new PGlite(directory); await pg.waitReady;
    const replay = await run(); assert.deepEqual(replay.event, original.event); assert.equal(replay.replayed, true);
  });
  await t.test("changed target/payload conflicts; different user or agency is an independent namespace", async () => {
    for (const changed of [{ dialogId: "9999" }, { creatorId: "d" }, { scriptId: "other" }, { amount: 9 }]) await assert.rejects(run({ input: { ...input, ...changed } }), { code: "MESSAGE_LIBRARY_USAGE_EVENT_CONFLICT" });
    assert.equal((await run({ userId: "v", actorMember: { id: "v", accessEpoch: 1 } })).replayed, false);
    assert.equal((await run({ agencyId: "b", actorMember: { id: "n", accessEpoch: 1 }, input: { ...input, creatorId: "b", messageId: null } })).replayed, false);
  });
  await t.test("audit error rolls back event; same intent succeeds after recovery", async () => {
    const before = await counts(), patch = { input: { ...input, eventId: "sql-usage-intent-0002" } };
    failAudit = true; await assert.rejects(run(patch), /injected audit failure/); failAudit = false; assert.deepEqual(await counts(), before);
    assert.equal((await run(patch)).replayed, false); assert.equal((await run(patch)).replayed, true);
  });
  for (const [label, change, restore, code] of [
    ["access epoch", 'UPDATE "AgencyMember" SET "accessEpoch"=2 WHERE id=\'m\'', 'UPDATE "AgencyMember" SET "accessEpoch"=1 WHERE id=\'m\'', "MANAGEMENT_ACCESS_STALE"],
    ["disabled user", 'UPDATE "User" SET "disabledAt"=CURRENT_TIMESTAMP WHERE id=\'u\'', 'UPDATE "User" SET "disabledAt"=NULL WHERE id=\'u\'', "MANAGEMENT_USER_DISABLED"],
    ["membership revoked", 'UPDATE "AgencyMember" SET "deactivatedAt"=CURRENT_TIMESTAMP WHERE id=\'m\'', 'UPDATE "AgencyMember" SET "deactivatedAt"=NULL WHERE id=\'m\'', "MANAGEMENT_ACCESS_REVOKED"],
    ["creator scope", `UPDATE "AgencyMember" SET role='OPERATOR',"roleKey"='chatter',"assignedCreators"='[]' WHERE id='m'`, `UPDATE "AgencyMember" SET role='OWNER',"roleKey"='owner',"assignedCreators"='"all"' WHERE id='m'`, "MANAGEMENT_CREATOR_SCOPE_REVOKED"],
    ["billing hold", 'UPDATE "Agency" SET "billingSupportHold"=true WHERE id=\'a\'', 'UPDATE "Agency" SET "billingSupportHold"=false WHERE id=\'a\'', "BILLING_ACCESS_HELD"],
    ["retired creator", 'UPDATE "CreatorAccount" SET "deletedAt"=CURRENT_TIMESTAMP WHERE id=\'c\'', 'UPDATE "CreatorAccount" SET "deletedAt"=NULL WHERE id=\'c\'', "MANAGEMENT_CREATOR_RETIRED"],
  ]) await t.test(`current ${label} denies replay before receipt lookup`, async () => {
    await pg.exec(change); const start = calls.length; await assert.rejects(run(), { code }); assert.ok(calls.slice(start).every(c => !c.query.includes('FROM "ContentUsageEvent"'))); await pg.exec(restore);
  });
  await t.test("cleanup preserves prior receipt, while new usage of deleted script fails", async () => {
    await pg.exec('DELETE FROM "ContentBlock" WHERE "collectionId"=\'s\'; DELETE FROM "ContentCollection" WHERE id=\'s\'');
    assert.deepEqual((await run()).event, original.event);
    await assert.rejects(run({ input: { ...input, eventId: "sql-usage-intent-0003" } }), { code: "MESSAGE_LIBRARY_SCRIPT_NOT_FOUND" });
  });
  await t.test("16000 historical events: one PK lookup; DB enforces uniqueness independently", async () => {
    await pg.exec(`INSERT INTO "ContentUsageEvent"(id,"agencyId") SELECT 'old-'||i,'a' FROM generate_series(1,16000)i; ANALYZE "ContentUsageEvent"`);
    const start = calls.length; await run(); const lookup = calls.slice(start).filter(c => c.query.includes('FROM "ContentUsageEvent"')); assert.equal(lookup.length, 1); assert.equal(lookup[0].rows, 1);
    const plan = await pg.query('EXPLAIN (FORMAT JSON) SELECT * FROM "ContentUsageEvent" WHERE id=$1', [original.event.id]); assert.match(JSON.stringify(plan.rows), /ContentUsageEvent_pkey/);
    await assert.rejects(pg.query('INSERT INTO "ContentUsageEvent"(id,"agencyId") VALUES ($1,\'a\')', [original.event.id]), /duplicate key/);
    console.log(JSON.stringify({ historicalEvents: 16000, receiptRows: lookup[0].rows, maxResultRows: Math.max(...calls.map(c => c.rows)), canonicalEventBytes: Buffer.byteLength(JSON.stringify(original.event)), engine: "PGlite; serialized single backend" }));
  });
});

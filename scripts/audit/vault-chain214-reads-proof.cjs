"use strict";

// Runs against explicitly supplied, disposable native PostgreSQL databases.
// Production read models execute unchanged; the second connection creates a
// deterministic concurrent writer between count and page statements.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

async function runVaultReads214({ backendRoot, dialogsUrl, coreDb, output }) {
  assert.ok(dialogsUrl, "EXPLICIT_DISPOSABLE_DIALOG_DATABASE_REQUIRED");
  const load = createRequire(path.join(backendRoot, "package.json"));
  const { PrismaClient } = load("@prisma/client");
  const db = new PrismaClient({ datasources: { db: { url: dialogsUrl } } });
  const writer = new PrismaClient({ datasources: { db: { url: dialogsUrl } } });
  const { DialogReadModels } = load("./src/services/conversation-storage/dialog-read-models");
  const c = load("./src/services/conversation-storage/common");
  const scopeId = c.scopeId("vault214_reads", "100001");
  const otherScopeId = c.scopeId("vault214_reads_other", "100001");
  const ctx = { scopeId, creatorId: "vault214_read_creator" };
  const models = new DialogReadModels({ db });
  const cases = [], witnessObservations = [];
  async function check(name, test) {
    try { await test(); cases.push({ name, ok: true }); }
    catch (error) { cases.push({ name, ok: false, error: error.message, code: error.code || null }); }
  }
  async function seed(scope, total = 10005, dialog = "200001") {
    await db.$executeRawUnsafe(`INSERT INTO dialog_archive_scope(scope_id,agency_id,platform,platform_creator_id,epoch)
      VALUES($1,$2,'onlyfans','100001','vault214_fixture') ON CONFLICT DO NOTHING`, scope, scope === scopeId ? "vault214_reads" : "vault214_reads_other");
    await db.$executeRawUnsafe(`INSERT INTO dialog_archive_thread(scope_id,dialog_id,platform_fan_id)
      VALUES($1,$2,$2) ON CONFLICT DO NOTHING`, scope, dialog);
    await db.$executeRawUnsafe(`INSERT INTO dialog_archive_message(scope_id,dialog_id,message_id,platform_creator_id,
      platform_fan_id,platform_author_id,created_at,sender,price_cents,provider_opened,data,content_hash,storage_bytes,revision)
      SELECT $1,$2,(1000000+n)::text,'100001',$2,'100001',TIMESTAMPTZ '2026-11-01 10:00:00Z','creator',1001,true,
        jsonb_build_object('mediaIds',jsonb_build_array('900001','900002','900003'),'updatedAt','2026-11-01T10:00:00.000Z'),
        'fixture',100,n FROM generate_series(1,$3::integer) n ON CONFLICT DO NOTHING`, scope, dialog, total);
  }
  try {
    await seed(scopeId);
    await seed(otherScopeId, 7);
    await check("deep pages beyond 10000 retain the complete filtered total", async () => {
      const page = await models.listVaultSalesRows(ctx, { offset: 10001, limit: 2 });
      assert.equal(page.count, 10005); assert.equal(page.rows.length, 2);
      assert.equal(page.offset, 10001); assert.equal(page.nextOffset, 10003); assert.equal(page.hasMore, true);
    });
    await check("an empty deep page remains bounded and retains its true total", async () => {
      const page = await models.listVaultSalesRows(ctx, { offset: 10000001, limit: 2 });
      assert.equal(page.count, 10005); assert.deepEqual(page.rows, []);
      assert.equal(page.nextOffset, 10000001); assert.equal(page.hasMore, false);
    });
    await check("zero page size cannot return a non-progressing continuation", async () => {
      const page = await models.listVaultSalesRows(ctx, { limit: 0 });
      assert.ok(page.rows.length >= 1); assert.ok(page.nextOffset > page.offset);
    });
    await check("filters and totals remain confined to the exact archive scope", async () => {
      assert.equal((await models.listVaultSalesRows(ctx, { assetId: "900002", limit: 1 })).count, 10005);
      assert.equal((await models.listVaultSalesRows(ctx, { buyerId: "200002" })).count, 0);
      assert.equal((await models.listVaultSalesRows({ ...ctx, scopeId: otherScopeId }, { limit: 1 })).count, 7);
      assert.equal((await models.listVaultSalesRows(ctx, { status: "NOT_OPENED" })).count, 0);
      assert.equal((await models.listVaultSalesRows(ctx, { from: "2026-11-02T00:00:00Z" })).count, 0);
    });
    await check("count and rows share a PostgreSQL snapshot across a concurrent correction", async () => {
      let changed = false;
      function intercept(target) {
        return new Proxy(target, { get(object, name) {
          if (name === "$queryRawUnsafe") return async (sql, ...params) => {
            const rows = await object.$queryRawUnsafe(sql, ...params);
            if (!changed && /SELECT count\(\*\) n FROM dialog_archive_message/.test(sql)) {
              changed = true;
              await writer.$executeRawUnsafe("DELETE FROM dialog_archive_message WHERE scope_id=$1", scopeId);
            }
            return rows;
          };
          if (name === "$transaction") return (fn, options) => object.$transaction(tx => fn(intercept(tx)), options);
          const value = object[name]; return typeof value === "function" ? value.bind(object) : value;
        } });
      }
      const concurrent = new DialogReadModels({ db: intercept(db) });
      const page = await concurrent.listVaultSalesRows(ctx, { offset: 1, limit: 2 });
      assert.equal(changed, true); assert.equal(page.count, 10005); assert.equal(page.rows.length, 2);
      assert.equal((await models.listVaultSalesRows(ctx, {})).count, 0);
    });
    if (coreDb) {
      const singleton = load.resolve("./src/prisma"), previous = require.cache[singleton];
      require.cache[singleton] = { id: singleton, filename: singleton, loaded: true, exports: coreDb };
      try {
        const { runRootCommit } = load("./src/services/db-commit-kernel");
        const scope = await runRootCommit(coreDb, async ({ tx }) => {
          const writes = load("./src/services/database-write-contract-service");
          await writes.assertTeamControlPlaneWriteAdmission(tx);
          await writes.authorizeCreatorAccountWrite(tx);
          const user = await tx.user.create({ data: { email: `vault214-${require("node:crypto").randomUUID()}@example.test`, passwordHash: "fixture" } });
          const agency = await tx.agency.create({ data: { name: "Vault 214 diagnostics fixture" } });
          await tx.agencyMember.create({ data: { agencyId: agency.id, userId: user.id, role: "OWNER", roleKey: "owner" } });
          const creator = await tx.creatorAccount.create({ data: { agencyId: agency.id, displayName: "Vault read proof" } });
          const identity = { agencyId: agency.id, creatorId: creator.id };
          const oldRun = await tx.dialogScanRun.create({ data: { ...identity, dialogId: "200001", mode: "targeted", status: "RUNNING", createdAt: new Date("2026-11-01T00:00:00Z") } });
          const oldJob = await tx.jobInstance.create({ data: { ...identity, scope: "creator", jobKey: "dialog_intelligence_scan", status: "SCHEDULED", createdAt: new Date("2026-11-01T00:00:00Z") } });
          await tx.dialogScanRun.createMany({ data: Array.from({ length: 55 }, (_, index) => ({ ...identity, dialogId: String(300000 + index), mode: "targeted", status: "COMPLETED", createdAt: new Date(Date.UTC(2026, 10, 2, 0, 0, index)) })) });
          await tx.jobInstance.createMany({ data: Array.from({ length: 55 }, (_, index) => ({ ...identity, scope: "creator", jobKey: "dialog_intelligence_scan", status: "COMPLETED", createdAt: new Date(Date.UTC(2026, 10, 2, 0, 0, index)) })) });
          return { ...identity, oldRun, oldJob };
        });
        await check("older active collection is visible beyond the latest 50 completed jobs", async () => {
          const router = load("./src/routes/dialog-intelligence");
          const handler = router.stack.find(layer => layer.route?.path === "/creators/:creatorId/diagnostics").route.stack[0].handle;
          let payload, status = 200;
          await handler({ auth: { agencyId: scope.agencyId }, params: { creatorId: scope.creatorId } }, {
            status(value) { status = value; return this; }, json(value) { payload = value; return value; },
          });
          assert.equal(status, 200); assert.equal(payload.ok, true);
          assert.ok(payload.runs.some(row => row.id === scope.oldRun.id && row.status === "RUNNING"));
          assert.ok(payload.jobs.some(row => row.id === scope.oldJob.id && row.status === "SCHEDULED"));
          assert.ok(payload.runs.length <= 51); assert.ok(payload.jobs.length <= 51);
          assert.equal(new Set(payload.runs.map(row => row.id)).size, payload.runs.length);
        });
        await check("asset aggregates do not fabricate absent resolution and deleted-buyer counts", async () => {
          const summary = (await load("./src/services/media-library-service").getMediaSalesSummary({ ...scope, db: coreDb })).summary;
          assert.equal(summary.soldAssets, 0); assert.equal(summary.totalSales, 0); assert.equal(summary.revenueCents, 0);
          assert.equal(summary.unresolved, null); assert.equal(summary.deletedBuyers, null);
        });
        for (const kind of ["summary", "assets", "directory"]) await check(`${kind} money and availability use one snapshot across a committed projection repair`, async () => {
          const asset = await coreDb.creatorMediaAsset.upsert({
            where: { creatorId_mediaId: { creatorId: scope.creatorId, mediaId: "940001" } },
            create: { agencyId: scope.agencyId, creatorId: scope.creatorId, mediaId: "940001", catalogActive: true, soldCount: 1, revenueCents: 100 },
            update: { revenueCents: 100 },
          });
          await coreDb.creatorMediaFinancialAdoptionState.upsert({
            where: { creatorId: scope.creatorId },
            create: { agencyId: scope.agencyId, creatorId: scope.creatorId, semanticsVersion: 2, completedAt: null },
            update: { completedAt: null },
          });
          const evidenceTable = (await coreDb.$queryRawUnsafe(`SELECT to_regclass('public."CreatorMediaMessageEvidence"') IS NOT NULL AS present`))[0].present;
          if (evidenceTable) await coreDb.$executeRawUnsafe(`INSERT INTO "CreatorMediaMessageEvidence"
            ("agencyId","creatorId","sourceKey","messageId","dialogId","creatorMediaIds","excludedMediaIds","manifestHash",dirty,"pendingFacts")
            VALUES($1,$2,'vault214-read-witness','300040','200040','["940001"]'::jsonb,'[]'::jsonb,'read-fixture',true,false)
            ON CONFLICT("creatorId","sourceKey","messageId") DO UPDATE SET dirty=true,"pendingFacts"=false`, scope.agencyId, scope.creatorId);
          let repaired = false, payloadRead;
          const payloadReady = new Promise(resolve => { payloadRead = resolve; });
          function intercept(target) {
            return new Proxy(target, { get(object, name) {
              if (name === "$queryRawUnsafe") return async (sql, ...params) => {
                if (!repaired && sql.includes('FROM "CreatorMediaMessageFinancialState"')) {
                  await payloadReady;
                  repaired = true;
                  // Independent SQL transaction, on another pool connection:
                  // emulate the atomic final projection commit while this read
                  // is suspended after obtaining its old saved payload.
                  await coreDb.$transaction(async tx => {
                    await tx.creatorMediaAsset.update({ where: { id: asset.id }, data: { revenueCents: 803 } });
                    await tx.creatorMediaFinancialAdoptionState.update({ where: { creatorId: scope.creatorId }, data: { completedAt: new Date() } });
                    if (evidenceTable) await tx.$executeRawUnsafe(`UPDATE "CreatorMediaMessageEvidence" SET dirty=false,"pendingFacts"=false WHERE "creatorId"=$1`, scope.creatorId);
                  });
                }
                const rows = await object.$queryRawUnsafe(sql, ...params);
                if (sql.includes('AS "soldAssets"')) payloadRead();
                return rows;
              };
              if (name === "$transaction" && typeof object.$transaction === "function") return (fn, options) => object.$transaction(tx => fn(intercept(tx)), options);
              if (name === "creatorMediaAsset") return new Proxy(object[name], { get(model, operation) {
                const fn = model[operation];
                if (["findMany", "aggregate"].includes(operation)) return async args => { const rows = await fn.call(model, args); payloadRead(); return rows; };
                return typeof fn === "function" ? fn.bind(model) : fn;
              } });
              const value = object[name]; return typeof value === "function" ? value.bind(object) : value;
            } });
          }
          const readDb = intercept(coreDb), media = load("./src/services/media-library-service");
          const value = kind === "summary" ? (await media.getMediaSalesSummary({ ...scope, db: readDb })).summary
            : kind === "assets" ? (await media.listMediaSalesAssets({ ...scope, limit: 1, db: readDb })).items[0]
              : (await load("./src/services/vault-directory-service").getVaultDirectoryIntelligence({ ...scope, mediaIds: ["940001"], includePipeline: false, db: readDb })).summary;
          const amount = kind === "assets" ? value.totalRevenueCents : value.revenueCents;
          witnessObservations.push({ kind, amount, revenueAvailable: value.revenueAvailable, revenueComplete: value.revenueComplete, repaired, evidenceTable });
          assert.equal(repaired, true); assert.equal(amount, 100);
          assert.equal(value.revenueAvailable, false, "old partial payload must retain its unavailable witness");
          const after = (await media.getMediaSalesSummary({ ...scope, db: coreDb })).summary;
          assert.equal(after.revenueCents, 803); assert.equal(after.revenueAvailable, true);
        });
      } finally { if (previous) require.cache[singleton] = previous; else delete require.cache[singleton]; }
    }
    const { DialogRepository } = load("./src/services/conversation-storage/dialog-repository");
    const repo = new DialogRepository(db), remote = new DialogReadModels(repo);
    const evidenceCtx = { scopeId: c.scopeId("vault214_evidence", "100002"), agencyId: "vault214_evidence", creatorId: "vault214_evidence_creator", platformCreatorId: "100002", deviceId: "device214" };
    const message = (dialogId, messageId, mediaIds, mediaEvidence) => ({
      creatorId: evidenceCtx.creatorId, dialogId, messageId, platformCreatorId: evidenceCtx.platformCreatorId,
      platformFanId: dialogId, platformAuthorId: evidenceCtx.platformCreatorId, sender: "creator", text: "Synthetic purchased message",
      mediaIds, ...(mediaEvidence ? { mediaEvidence } : {}), price: 10.01, opened: 1,
      createdAt: "2026-11-01T00:00:00.000Z", source: "full_scan",
    });
    const proof = (creatorMediaIds, excludedMediaIds = []) => ({ version: 1, complete: true, creatorMediaIds, excludedMediaIds });
    const commit = (row, extras = {}, command = c.newCommandId()) => repo.commitScanPage(evidenceCtx, { dialogId: row.dialogId, messages: [row], statePatch: {}, targeted: true, ...extras }, command);
    try {
      await check("ownership proof adoption does not invalidate an unchanged legacy scan frontier", async () => {
        const row = message("200010", "300010", ["900010"]);
        await commit(row);
        const incoming = { ...row, mediaEvidence: proof(["900010"]) };
        assert.deepEqual(await repo.findExistingMessageIds(evidenceCtx, { dialogId: row.dialogId, messageIds: [row.messageId], unchangedMessages: [incoming] }), [row.messageId]);
        await commit(incoming);
        assert.deepEqual(await repo.findExistingMessageIds(evidenceCtx, { dialogId: row.dialogId, messageIds: [row.messageId], unchangedMessages: [row] }), [row.messageId]);
      });
      await check("remote archive commits and replays complete ownership evidence with its message", async () => {
        const row = message("200011", "300011", ["900011", "900012"], proof(["900011", "900012"], ["900099"]));
        const command = c.newCommandId(), first = await commit(row, {}, command);
        assert.deepEqual(await commit(row, {}, command), first);
        const stored = (await repo.getMessages(evidenceCtx, { dialogId: row.dialogId }))[0];
        assert.deepEqual(stored.mediaEvidence, row.mediaEvidence);
        const page = await remote.listMediaUsageFactPage(evidenceCtx, { dialogId: row.dialogId });
        assert.deepEqual(page.messageMediaEvidence, [{ dialogId: row.dialogId, messageId: row.messageId, ...row.mediaEvidence }]);
        assert.deepEqual(page.facts.map(fact => fact.mediaId), row.mediaIds);
      });
      await check("text-only or legacy partial refresh preserves media and never certifies an unknown legacy ID", async () => {
        const row = message("200012", "300012", ["900021", "900022"]);
        await commit(row);
        const owned = message(row.dialogId, row.messageId, ["900021"], proof(["900021"]));
        await commit(owned);
        await commit({ ...row, text: "Only text changed", mediaIds: [], changedAt: "2026-11-02T00:00:00.000Z" }, { presentFields: ["text"] });
        const stored = (await repo.getMessages(evidenceCtx, { dialogId: row.dialogId }))[0];
        assert.deepEqual([...stored.mediaIds].sort(), ["900021", "900022"]);
        assert.deepEqual(stored.mediaEvidence, owned.mediaEvidence);
      });
      await check("new explicit fan proof corrects older content without reviving excluded attachments", async () => {
        const old = message("200013", "300013", ["900031", "900032"]);
        await commit({ ...old, changedAt: "2026-11-03T00:00:00.000Z" });
        const correction = message(old.dialogId, old.messageId, ["900031"], proof(["900031"], ["900032"]));
        await commit(correction);
        await commit({ ...old, changedAt: "2026-11-04T00:00:00.000Z" });
        const stored = (await repo.getMessages(evidenceCtx, { dialogId: old.dialogId }))[0];
        assert.deepEqual(stored.mediaIds, ["900031"]); assert.deepEqual(stored.mediaEvidence, correction.mediaEvidence);
        await assert.rejects(commit({ ...old, mediaEvidence: proof(["900031", "900032"]) }), { code: "DIALOG_MEDIA_OWNERSHIP_CONFLICT" });
      });
      await check("fan-only message evidence remains discoverable and advances an empty fact page", async () => {
        const row = message("200014", "300014", [], proof([], ["900041"]));
        await commit(row);
        assert.ok((await remote.listMediaUsageDialogIds(evidenceCtx, {})).includes(row.dialogId));
        const page = await remote.listMediaUsageFactPage(evidenceCtx, { dialogId: row.dialogId });
        assert.deepEqual(page.facts, []); assert.equal(page.messageMediaEvidence.length, 1);
        assert.deepEqual(page.next, { messageId: row.messageId, mediaId: "" }); assert.equal(page.done, true);
      });
      await check("malformed or conflicting ownership proof rolls back before archive mutation", async () => {
        const row = message("200015", "300015", ["900051"], proof(["900051"], ["900051"]));
        await assert.rejects(commit(row), { code: "DIALOG_MEDIA_EVIDENCE_INVALID" });
        assert.equal((await repo.count(evidenceCtx, { dialogId: row.dialogId })).messages, 0);
      });
      await check("split remote fact pages retain exact complete descriptors and a replayable revision", async () => {
        const dialogId = "200016";
        for (let index = 0; index < 12; index++) {
          const ids = Array.from({ length: 100 }, (_, ordinal) => String(910000 + index * 100 + ordinal));
          await commit(message(dialogId, String(310000 + index), ids, proof(ids)));
        }
        let after = null, revision, facts = [], pages = 0;
        do {
          const page = await remote.listMediaUsageFactPage(evidenceCtx, { dialogId, after, revision });
          revision ||= page.revision; pages++;
          assert.equal(page.revision, revision); assert.ok(page.facts.length <= 1000);
          assert.equal(new Set(page.messageMediaEvidence.map(row => row.messageId)).size, page.messageMediaEvidence.length);
          for (const row of page.messageMediaEvidence) assert.equal(row.creatorMediaIds.length, 100);
          facts.push(...page.facts); after = page.next;
          if (page.done) break;
          assert.ok(pages < 5);
        } while (true);
        assert.equal(facts.length, 1200); assert.equal(new Set(facts.map(row => row.messageId + ":" + row.mediaId)).size, 1200);
        assert.equal(pages, 2);
        const reopened = new DialogReadModels(new DialogRepository(writer));
        assert.equal((await reopened.listMediaUsageFactPage(evidenceCtx, { dialogId, revision })).revision, revision);
      });
    } finally {
      await db.$executeRawUnsafe("DELETE FROM dialog_archive_scope WHERE scope_id=$1", evidenceCtx.scopeId);
    }
    const result = { ok: cases.every(item => item.ok), node: process.version, backendRoot, cases, witnessObservations };
    if (output) fs.writeFileSync(output, JSON.stringify(result, null, 2));
    return result;
  } finally {
    await db.$executeRawUnsafe("DELETE FROM dialog_archive_scope WHERE scope_id=ANY($1::text[])", [scopeId, otherScopeId]);
    await writer.$disconnect(); await db.$disconnect();
  }
}
module.exports = { runVaultReads214 };

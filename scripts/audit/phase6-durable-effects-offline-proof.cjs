"use strict";
// Disposable full-migration SQL proof. Does not use the caller's DATABASE_URL.
const assert = require("node:assert/strict"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { createRequire } = require("node:module"),
  { spawn } = require("node:child_process");
const { PrismaClient } = require(process.env.DE_PRISMA_CLIENT || "@prisma/client");
const keepAlive = setInterval(() => {}, 1000);
const deadline = setTimeout(() => {
  console.error("LOCAL_PROOF_DEADLINE");
  process.exit(2);
}, 180000);
async function main() {
  if (!process.env.PHASE5_PROOF_RUNTIME) throw Error("PHASE5_PROOF_RUNTIME required");
  const load = createRequire(path.resolve(process.env.PHASE5_PROOF_RUNTIME, "package.json"));
  const { PGlite } = load("@electric-sql/pglite"),
    { PGLiteSocketServer } = load("@electric-sql/pglite-socket");
  console.log("PROOF_ENGINE_START");
  const engine = await PGlite.create();
  const server = new PGLiteSocketServer({ db: engine, host: "127.0.0.1", port: 0 });
  await server.start();
  const url = `postgresql://postgres:postgres@${server.getServerConn()}/postgres?connection_limit=1&sslmode=disable`;
  const db = new PrismaClient({ datasources: { db: { url } }, log: [{ emit: "event", level: "query" }] }),
    cases = [];
  if (process.env.DE_SQL_TRACE === "1") db.$on("query", (e) => console.log("SQL", e.query.slice(0, 150)));
  const check = async (name, work) => {
    console.log("CHECK_START", name);
    await work();
    cases.push({ name, status: "PASS" });
    console.log(JSON.stringify(cases.at(-1)));
  };
  try {
    // Execute the exact SQL files in order before opening Prisma's single socket.
    // migrate deploy is verified separately; this avoids a PGlite socket takeover
    // race between the migration engine and the proof client.
    const fs = require("node:fs"),
      migrations = path.resolve(__dirname, "../../prisma/migrations");
    for (const name of fs.readdirSync(migrations).sort()) {
      const file = path.join(migrations, name, "migration.sql");
      if (fs.existsSync(file)) await engine.exec(fs.readFileSync(file, "utf8"));
    }
    console.log("PROOF_MIGRATIONS_APPLIED");
    await engine.exec("DISCARD ALL");
    console.log("PROOF_WIRE_RESET");
    await engine.exec("SET TIME ZONE 'UTC'");
    console.log("PROOF_FIXTURE_DDL_READY");
    require.cache[require.resolve("../../src/prisma")] = { exports: db };
    process.env.SNAPSHOT_ENCRYPTION_KEY = Buffer.alloc(32, 6).toString("base64");
    global.fetch = async () => {
      throw Error("DE proof forbids external services");
    };
    await engine.exec(`CREATE TABLE "DEReceiptFault" (enabled boolean NOT NULL); INSERT INTO "DEReceiptFault" VALUES(false);
      CREATE FUNCTION de_receipt_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF (SELECT enabled FROM "DEReceiptFault") THEN RAISE EXCEPTION 'DE_RECEIPT_FAULT'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER de_receipt_fault BEFORE INSERT ON "ManagementCommandReceipt" FOR EACH ROW EXECUTE FUNCTION de_receipt_fault();`);
    const { executeManagementCommand } = require("../../src/services/management-command-service");
    const custom = require("../../src/services/custom-orders-service"),
      network = require("../../src/services/creator-network-profile-service"),
      settings = require("../../src/services/settings-service"),
      bcrypt = require("bcryptjs");
    const oldHash = await bcrypt.hash("original-password", 4);
    const generation = (tx) =>
      tx.$executeRawUnsafe(
        "SELECT set_config('onlinod.phase2_team_control_plane_generation',$1,true)",
        "phase2_team_control_plane_v2_durable_access"
      );
    let seq = 0;
    async function seed() {
      return db.$transaction(async (tx) => {
        await generation(tx);
        await require("../../src/services/database-write-contract-service").authorizeCreatorAccountWrite(
          tx
        );
        const tag = "de-" + ++seq;
        const user = await tx.user.create({
          data: { email: tag + "@example.test", passwordHash: oldHash, name: "before" },
        });
        const agency = await tx.agency.create({ data: { name: tag, trialEndsAt: new Date("2099-01-01") } });
        const member = await tx.agencyMember.create({
          data: {
            agencyId: agency.id,
            userId: user.id,
            role: "OWNER",
            roleKey: "owner",
            assignedCreators: "all",
            permissions: {},
          },
        });
        const creator = await tx.creatorAccount.create({
          data: { agencyId: agency.id, displayName: tag, username: tag, status: "DRAFT" },
        });
        return { agencyId: agency.id, userId: user.id, member, creatorId: creator.id };
      });
    }

    async function disable(s) {
      await db.$transaction(async (tx) => {
        await generation(tx);
        await tx.agencyMember.update({ where: { id: s.member.id }, data: { role: "ADMIN", roleKey: "admin" } });
        const replacement = await tx.user.create({
          data: { email: "replacement-" + s.userId + "@example.test", passwordHash: oldHash },
        });
        await tx.agencyMember.create({
          data: {
            agencyId: s.agencyId,
            userId: replacement.id,
            role: "OWNER",
            roleKey: "owner",
            assignedCreators: "all",
          },
        });
        await tx.user.update({ where: { id: s.userId }, data: { disabledAt: new Date() } });
      });
      assert.ok((await db.user.findUnique({ where: { id: s.userId } })).disabledAt);
    }
    const command = (action, targetId, payload) => ({ commandId: crypto.randomUUID(), action, targetId, payload });
    const run = (s, input, extra = {}) =>
      executeManagementCommand({
        db,
        agencyId: s.agencyId,
        userId: s.userId,
        actorMember: s.member,
        deviceId: "device",
        input,
        ...extra,
      });
    const receipts = (s) =>
      db.$queryRawUnsafe('SELECT * FROM "ManagementCommandReceipt" WHERE "agencyId"=$1', s.agencyId);
    async function fault(work) {
      await db.$executeRawUnsafe('UPDATE "DEReceiptFault" SET enabled=true');
      try {
        await assert.rejects(work());
      } finally {
        await db.$executeRawUnsafe('UPDATE "DEReceiptFault" SET enabled=false');
      }
    }
    const user = (s) => db.user.findUnique({ where: { id: s.userId } });
    const creator = (s) => db.creatorAccount.findUnique({ where: { id: s.creatorId } });
    const avatar = (s, kind = "account.avatar", revision = 0) =>
      command(kind, kind === "account.avatar" ? "" : s.creatorId, {
        expectedRevision: revision,
        mimeType: "image/png",
        dataBase64: Buffer.from("89504e470d0a1a0a0102030405", "hex").toString("base64"),
      });
    for (const kind of ["account.avatar", "creator.avatar"]) {
      await check(`${kind}: asset pointer revision and receipt commit once after lost reply`, async () => {
        const s = await seed(),
          c = avatar(s, kind),
          a = await run(s, c),
          b = await run(s, c);
        assert.equal(b.replayed, true);
        assert.deepEqual(a.result, b.result);
        const row = kind === "account.avatar" ? await user(s) : await creator(s);
        assert.equal(row.avatarRevision, 1);
        assert.match(row.avatarUrl, /\/api\/assets\/avatars\/[a-f0-9]{64}$/);
        assert.equal((await receipts(s)).length, 1);
        await assert.rejects(run(s, avatar(s, kind)), { code: "AVATAR_REVISION_CHANGED" });
      });
      await check(`${kind}: receipt fault rolls back pointer and revision`, async () => {
        const s = await seed();
        await fault(() => run(s, avatar(s, kind)));
        const row = kind === "account.avatar" ? await user(s) : await creator(s);
        assert.equal(row.avatarRevision, 0);
        assert.equal(row.avatarUrl, null);
        assert.equal((await receipts(s)).length, 0);
      });
    }
    await check("avatar deletion replay cannot erase a newer image", async () => {
      const s = await seed();
      await run(s, avatar(s));
      const c = command("account.avatar", "", { expectedRevision: 1, mimeType: null, dataBase64: null });
      await run(s, c);
      await run(s, avatar(s, "account.avatar", 2));
      const replay = await run(s, c);
      assert.equal(replay.resultUnavailable, true);
      assert.equal((await user(s)).avatarRevision, 3);
    });
    await check("avatar wrong magic is rejected before persistence", async () => {
      const s = await seed(),
        c = avatar(s);
      c.payload.dataBase64 = Buffer.from("wrong image").toString("base64");
      await assert.rejects(run(s, c), { code: "AVATAR_INVALID" });
      assert.equal((await receipts(s)).length, 0);
    });
    const automation = (s, version = null, enabled = false) =>
      command("automation.control", s.creatorId, { scope: "creator", expectedUpdatedAt: version, enabled });
    await check("automation version and receipt replay preserve the committed control", async () => {
      const s = await seed(),
        c = automation(s),
        a = await run(s, c),
        b = await run(s, c);
      assert.equal(b.replayed, true);
      assert.deepEqual(a.result, b.result);
      assert.equal(a.result.control.enabled, false);
      await assert.rejects(run(s, automation(s)), { code: "CONTROL_VERSION_CONFLICT" });
    });
    await check("automation receipt failure leaves no partial control", async () => {
      const s = await seed();
      await fault(() => run(s, automation(s)));
      assert.equal(await db.automationControlState.count({ where: { agencyId: s.agencyId } }), 0);
    });
    const traffic = async (s) =>
      db.trafficSource.create({
        data: { agencyId: s.agencyId, creatorId: s.creatorId, sourceType: "tracking", externalId: "one" },
      });
    await check("traffic cost CAS receipt and rollback share one transaction", async () => {
      const s = await seed(),
        t = await traffic(s),
        c = command("traffic.cost", s.creatorId, {
          sourceId: t.id,
          expectedRevision: 0,
          costCents: 1200,
          currency: "USD",
        });
      await fault(() => run(s, c));
      assert.equal((await db.trafficSource.findUnique({ where: { id: t.id } })).costRevision, 0);
      const a = await run(s, c),
        b = await run(s, c);
      assert.deepEqual(b.result, a.result);
      assert.equal(b.replayed, true);
      assert.equal(a.result.source.costRevision, 1);
      await assert.rejects(run(s, { ...c, commandId: crypto.randomUUID() }), { code: "TRAFFIC_COST_VERSION_CONFLICT" });
    });
    const metadata = {
      mediaType: "photo",
      description: "human metadata",
      manualTags: ["tag"],
      visibleBodyParts: [],
      accessType: "paid",
      minPrice: 1,
      idealPrice: 2,
    };
    await check("media metadata editor CAS prevents old replay from overwriting the current metadata", async () => {
      const s = await seed(),
        c = command("media.metadata", s.creatorId, {
          mediaId: "11",
          expectedAssetId: null,
          expectedUpdatedAt: null,
          metadata,
        });
      await fault(() => run(s, c));
      assert.equal(await db.creatorMediaAsset.count({ where: { creatorId: s.creatorId } }), 0);
      const a = await run(s, c);
      assert.equal((await run(s, c)).replayed, true);
      const row = await db.creatorMediaAsset.findUnique({
        where: { creatorId_mediaId: { creatorId: s.creatorId, mediaId: "11" } },
      });
      await run(
        s,
        command("media.metadata", s.creatorId, {
          mediaId: "11",
          expectedAssetId: row.id,
          expectedUpdatedAt: row.metadataUpdatedAt.toISOString(),
          metadata: { ...metadata, description: "new" },
        })
      );
      assert.equal((await run(s, c)).resultUnavailable, true);
      await assert.rejects(run(s, { ...c, commandId: crypto.randomUUID() }), {
        code: "MEDIA_METADATA_VERSION_CONFLICT",
      });
    });
    await check("media folder and deletion repair reuse the same receipt and do not reapply later edits", async () => {
      const s = await seed();
      await db.creatorMediaAsset.create({
        data: { agencyId: s.agencyId, creatorId: s.creatorId, mediaId: "12", catalogActive: true },
      });
      const c = command("media.folder", s.creatorId, { mediaIds: ["12"], folderId: "folder", action: "add" });
      await fault(() => run(s, c));
      assert.deepEqual((await db.creatorMediaAsset.findFirst({ where: { creatorId: s.creatorId } })).folderIds, []);
      await run(s, c);
      await run(s, command("media.folder", s.creatorId, { ...c.payload, action: "remove" }));
      await run(s, c);
      assert.deepEqual((await db.creatorMediaAsset.findFirst({ where: { creatorId: s.creatorId } })).folderIds, []);
      const d = command("media.delete", s.creatorId, { mediaIds: ["12"] });
      await run(s, d);
      assert.equal((await run(s, d)).replayed, true);
    });
    await check("custom destination keeps revision, required audit and receipt atomic", async () => {
      const s = await seed(),
        c = command("custom.destination", s.creatorId, { folderId: "42", expectedFolderId: null, expectedRevision: 0 });
      await fault(() => run(s, c));
      assert.equal((await creator(s)).customsVaultFolderId, null);
      const a = await run(s, c);
      assert.equal(a.result.revision, 1);
      assert.deepEqual((await run(s, c)).result, a.result);
      await assert.rejects(run(s, { ...c, commandId: crypto.randomUUID() }), {
        code: "CUSTOM_VAULT_DESTINATION_CONFLICT",
      });
    });
    await check("custom update CAS and receipt recover one order revision", async () => {
      const s = await seed(),
        o = await db.customOrder.create({
          data: {
            agencyId: s.agencyId,
            creatorId: s.creatorId,
            createdByMemberId: s.member.id,
            dialogId: "fan",
            scenario: "original",
            type: "CONTENT",
            contentKind: "PHOTO",
          },
        });
      const c = command("custom.update", s.creatorId, {
        orderId: o.id,
        expectedUpdatedAt: o.updatedAt.toISOString(),
        patch: { internalNote: "edited" },
      });
      await fault(() => run(s, c));
      assert.equal((await db.customOrder.findUnique({ where: { id: o.id } })).internalNote, null);
      const a = await run(s, c);
      assert.equal((await run(s, c)).replayed, true);
      assert.equal((await db.customOrder.findUnique({ where: { id: o.id } })).internalNote, "edited");
      await assert.rejects(run(s, { ...c, commandId: crypto.randomUUID() }), { code: "CUSTOM_ORDER_VERSION_CONFLICT" });
    });
    await check("disabled current user cannot replay a committed result", async () => {
      const s = await seed(),
        c = avatar(s);
      await run(s, c);
      await disable(s);
      await assert.rejects(run(s, c));
    });
    await check("cancellation creates a durable tombstone before any effect", async () => {
      const s = await seed(),
        c = avatar(s);
      assert.equal((await run(s, c, { cancel: true })).abandoned, true);
      await assert.rejects(run(s, c), { code: "MANAGEMENT_COMMAND_ABANDONED" });
      assert.equal((await user(s)).avatarRevision, 0);
    });
    for (const kind of ["bump", "sfs"])
      await check(
        `automation ${kind} templates: immutable identity, stale editor conflict and atomic deletion replay`,
        async () => {
          const s = await seed(),
            c = command("automation.template", s.creatorId, {
              kind,
              operation: "save",
              templateId: "",
              expectedTaskId: null,
              expectedUpdatedAt: null,
              input: { messageText: "synthetic template", commentText: "synthetic comment", enabled: false },
            });
          await fault(() => run(s, c));
          assert.equal(await db.automationTask.count({ where: { agencyId: s.agencyId } }), 0);
          const a = await run(s, c),
            b = await run(s, c);
          assert.equal(b.replayed, true);
          assert.deepEqual(b.result, a.result);
          assert.equal(await db.automationTask.count({ where: { agencyId: s.agencyId } }), 1);
          const row = await db.automationTask.findFirst({ where: { agencyId: s.agencyId } });
          const d = command("automation.template", s.creatorId, {
            kind,
            operation: "delete",
            templateId: row.clientId,
            expectedTaskId: row.id,
            expectedUpdatedAt: row.updatedAt.toISOString(),
          });
          await run(s, d);
          assert.equal((await run(s, d)).replayed, true);
          assert.equal((await run(s, c)).resultUnavailable, true);
          assert.equal(await db.automationTask.count({ where: { agencyId: s.agencyId } }), 0);
        }
      );
    for (const kind of ["tip", "ppv"])
      await check(
        `claims ${kind}: attribution, required history and durable receipt roll back and replay together`,
        async () => {
          const s = await seed();
          const row =
            kind === "tip"
              ? await db.teamTipLedger.create({
                  data: {
                    agencyId: s.agencyId,
                    creatorId: s.creatorId,
                    accountId: s.creatorId,
                    eventHash: "event",
                    tipId: "tip",
                    receivedAt: new Date(),
                    status: "conflict",
                  },
                })
              : await db.teamPpvResolveJob.create({
                  data: {
                    agencyId: s.agencyId,
                    creatorId: s.creatorId,
                    accountId: s.creatorId,
                    purchaseId: "purchase",
                    messageId: "message",
                    purchasedAt: new Date(),
                    status: "conflict",
                  },
                });
          const payload =
            kind === "tip"
              ? {
                  expectedUpdatedAt: row.updatedAt.toISOString(),
                  action: "manager_override",
                  targetMemberId: s.member.id,
                  reason: "reviewed evidence",
                }
              : {
                  expectedUpdatedAt: row.updatedAt.toISOString(),
                  action: "assign",
                  memberId: s.member.id,
                  reason: "reviewed evidence",
                };
          const c = command(`claims.${kind}`, kind === "tip" ? "event" : row.id, payload);
          await fault(() => run(s, c, { deviceId: null }));
          const read = () =>
            kind === "tip"
              ? db.teamTipLedger.findUnique({ where: { id: row.id } })
              : db.teamPpvResolveJob.findUnique({ where: { id: row.id } });
          assert.equal((await read()).status, "conflict");
          assert.equal((await receipts(s)).length, 0);
          const a = await run(s, c, { deviceId: null }),
            b = await run(s, c, { deviceId: null });
          assert.equal(b.replayed, true);
          assert.deepEqual(b.result, a.result);
          if (kind === "tip") assert.equal((await read()).history.length, 1);
          else assert.equal(await db.teamPpvClaimAudit.count({ where: { agencyId: s.agencyId } }), 1);
          await assert.rejects(run(s, { ...c, commandId: crypto.randomUUID() }), { code: "CLAIM_VERSION_CONFLICT" });
          await disable(s);
          await assert.rejects(run(s, c, { deviceId: null }));
        }
      );
    const operationOwner = require("../../src/services/operational-command-service");
    async function operation(s, family, operation, input = {}) {
      const p = { family, operation, input },
        targetId = family === "dialog_module" ? "" : s.creatorId;
      return command("operation.control", targetId, {
        ...p,
        expectedRevision: await operationOwner.snapshot(db, s.agencyId, targetId, p),
      });
    }
    for (const family of ["notification", "financial", "campaign", "vault", "dialog", "subscriber"])
      await check(
        `operation ${family}: scheduling and receipt are atomic, retry stays in the original generation`,
        async () => {
          const s = await seed(),
            c = await operation(s, family, "start", family === "dialog" ? { mode: "incremental" } : {});
          await fault(() => run(s, c));
          assert.equal(await db.jobInstance.count({ where: { agencyId: s.agencyId } }), 0);
          assert.equal(await db.operationalControlState.count({ where: { agencyId: s.agencyId } }), 0);
          const a = await run(s, c),
            b = await run(s, c);
          assert.equal(b.replayed, true);
          assert.deepEqual(b.result, a.result);
          assert.equal(await db.operationalControlState.count({ where: { agencyId: s.agencyId } }), 1);
          await assert.rejects(run(s, { ...c, commandId: crypto.randomUUID() }), {
            code: "OPERATION_VERSION_CONFLICT",
          });
          // Simulated receipt compaction cannot turn an already consumed intent into new work.
          await db.$executeRawUnsafe('DELETE FROM "ManagementCommandReceipt" WHERE "agencyId"=$1', s.agencyId);
          await assert.rejects(run(s, c), { code: "OPERATION_VERSION_CONFLICT" });
        }
      );
    for (const family of ["notification", "financial", "campaign", "vault", "dialog"])
      await check(`operation ${family}: late stop replay does not stop a replacement run`, async () => {
        const s = await seed();
        await run(s, await operation(s, family, "start"));
        const stop = await operation(s, family, ["vault", "dialog"].includes(family) ? "pause" : "stop");
        await run(s, stop);
        await run(s, await operation(s, family, ["vault", "dialog"].includes(family) ? "resume" : "start"));
        const before = await db.jobInstance.findMany({
          where: { agencyId: s.agencyId },
          orderBy: { id: "asc" },
          select: { id: true, status: true, leaseRevision: true },
        });
        assert.equal((await run(s, stop)).replayed, true);
        assert.deepEqual(
          await db.jobInstance.findMany({
            where: { agencyId: s.agencyId },
            orderBy: { id: "asc" },
            select: { id: true, status: true, leaseRevision: true },
          }),
          before
        );
      });
    for (const module of ["follow_back", "follow", "likes", "sfs"])
      await check(
        `automation ${module}: candidate state and affected deliveries commit with the original intent`,
        async () => {
          const s = await seed();
          const model = {
            follow_back: "followBackCandidate",
            follow: "followAutomationCandidate",
            likes: "automationContentCandidate",
            sfs: "sfsTargetCandidate",
          }[module];
          const row = await db[model].create({
            data: {
              agencyId: s.agencyId,
              creatorId: s.creatorId,
              ...(module === "likes"
                ? { ownerFanId: "fan", contentId: "content" }
                : module === "sfs"
                  ? { username: "target", targetUserId: "fan" }
                  : { fanId: "fan" }),
            },
          });
          const c = await operation(s, "automation_candidate", "action", {
            module,
            candidateId: ["follow_back", "follow"].includes(module) ? "fan" : row.id,
            action: "block",
          });
          await fault(() => run(s, c));
          assert.equal((await db[model].findUnique({ where: { id: row.id } })).state, row.state);
          await run(s, c);
          assert.equal((await run(s, c)).replayed, true);
          const restore = await operation(s, "automation_candidate", "action", {
            ...c.payload.input,
            action: "restore",
          });
          await run(s, restore);
          await run(s, c);
          assert.notEqual((await db[model].findUnique({ where: { id: row.id } })).state, "BLOCKED");
        }
      );
    await check("automation delivery: unknown provider outcome cannot become a manual resend", async () => {
      const s = await seed(),
        row = await db.automationDelivery.create({
          data: {
            agencyId: s.agencyId,
            creatorId: s.creatorId,
            moduleKey: "bumps",
            actionType: "SEND_MESSAGE",
            status: "FAILED",
            failureCategory: "OUTCOME_UNKNOWN_RECONCILE",
            failureCode: "send_result_unknown",
          },
        });
      const c = await operation(s, "automation_delivery", "retry", { deliveryId: row.id });
      await assert.rejects(run(s, c), { code: "DELIVERY_RECONCILIATION_REQUIRED" });
      assert.equal((await receipts(s)).length, 0);
      assert.equal((await db.automationDelivery.findUnique({ where: { id: row.id } })).status, "FAILED");
    });
    await check("automation delivery: an old release cannot release a newer worker lease", async () => {
      const s = await seed(),
        row = await db.automationDelivery.create({
          data: {
            agencyId: s.agencyId,
            creatorId: s.creatorId,
            moduleKey: "follow_back",
            actionType: "FOLLOW_BACK",
            status: "CLAIMED",
            leaseRevision: 1,
            attempts: 1,
          },
        });
      const c = await operation(s, "automation_delivery", "release", { deliveryId: row.id });
      await fault(() => run(s, c));
      assert.equal((await db.automationDelivery.findUnique({ where: { id: row.id } })).leaseRevision, 1);
      await run(s, c);
      await db.automationDelivery.update({ where: { id: row.id }, data: { status: "CLAIMED", leaseRevision: 3 } });
      await run(s, c);
      assert.equal((await db.automationDelivery.findUnique({ where: { id: row.id } })).leaseRevision, 3);
    });
    for (const op of [
      "follow_back",
      "follow",
      "bumps",
      "bumps_auto",
      "bump_replies",
      "likes",
      "likes_discover",
      "sfs",
      "sfs_discover",
    ])
      await check(`automation planner ${op}: root composition and immutable command replay`, async () => {
        const s = await seed();
        const moduleKey =
          { bumps_auto: "bumps", bump_replies: "bumps", likes_discover: "likes", sfs_discover: "sfs" }[op] || op;
        await run(
          s,
          command("automation.control", s.creatorId, {
            scope: "module",
            moduleKey,
            expectedUpdatedAt: null,
            enabled: true,
          })
        );
        await db.subscriberDirectoryState.create({
          data: {
            agencyId: s.agencyId,
            creatorId: s.creatorId,
            status: "READY",
            currentRunId: "proof-snapshot",
            publishedGeneration: 1,
            publicationGeneration: 1,
          },
        });
        const c = await operation(s, "automation_plan", op);
        const first = await run(s, c);
        assert.equal((await run(s, c)).replayed, true);
        assert.equal(first.result.committedControlRevision, 1);
      });
    await check(
      "traffic forced refresh: lost reply creates one scheduled command, receipt fault creates none",
      async () => {
        const s = await seed(),
          c = await operation(s, "traffic_refresh", "refresh", { force: true, accountHints: { accountId: "local" } });
        await fault(() => run(s, c));
        assert.equal(await db.jobInstance.count({ where: { agencyId: s.agencyId } }), 0);
        await run(s, c);
        await run(s, c);
        assert.equal(await db.jobInstance.count({ where: { agencyId: s.agencyId } }), 1);
      }
    );
    await check("single dialog scan: replayed cancellation cannot cancel a replacement generation", async () => {
      const s = await seed();
      await run(s, await operation(s, "dialog_single", "start", { dialogId: "fan", mode: "initial" }));
      const c = await operation(s, "dialog_single", "cancel", { dialogId: "fan" });
      await run(s, c);
      await run(s, await operation(s, "dialog_single", "start", { dialogId: "fan", mode: "initial" }));
      const before = await db.dialogScanRun.findMany({
        where: { agencyId: s.agencyId },
        orderBy: { id: "asc" },
        select: { id: true, status: true },
      });
      await run(s, c);
      assert.deepEqual(
        await db.dialogScanRun.findMany({
          where: { agencyId: s.agencyId },
          orderBy: { id: "asc" },
          select: { id: true, status: true },
        }),
        before
      );
    });
    await check(
      "dialog module: command receipt and resume demand commit together; later manual pause supersedes old demand",
      async () => {
        const s = await seed();
        await run(s, await operation(s, "dialog", "start"));
        await run(s, await operation(s, "dialog_module", "configure", { enabled: false }));
        const c = await operation(s, "dialog_module", "configure", { enabled: true });
        await fault(() => run(s, c));
        assert.equal(await db.dialogControlResumeDemand.count({ where: { agencyId: s.agencyId } }), 0);
        assert.equal(
          (
            await db.moduleSetting.findUnique({
              where: { agencyId_moduleKey: { agencyId: s.agencyId, moduleKey: "dialog_intelligence" } },
            })
          ).enabled,
          false
        );
        await run(s, c);
        await run(s, c);
        assert.equal(await db.dialogControlResumeDemand.count({ where: { agencyId: s.agencyId } }), 1);
        const demand = await db.dialogControlResumeDemand.findFirst({ where: { agencyId: s.agencyId } });
        await run(s, await operation(s, "dialog", "pause"));
        assert.equal(
          await require("../../src/services/dialog-module-control-service").resumeDemand({ db, id: demand.id }),
          false
        );
        assert.equal(
          (await db.dialogControlResumeDemand.findUnique({ where: { id: demand.id } })).status,
          "SUPERSEDED"
        );
      }
    );
    await check("dialog module: enabling the global switch preserves an earlier manual creator pause", async () => {
      const s = await seed();
      await run(s, await operation(s, "dialog", "start"));
      await run(s, await operation(s, "dialog", "pause"));
      await run(s, await operation(s, "dialog_module", "configure", { enabled: false }));
      await run(s, await operation(s, "dialog_module", "configure", { enabled: true }));
      assert.equal(await db.dialogControlResumeDemand.count({ where: { agencyId: s.agencyId } }), 0);
      assert.equal(await db.dialogScanRun.count({ where: { agencyId: s.agencyId, status: "PAUSED" } }), 1);
    });
    await check("dialog module: durable resume survives restart and finishes exactly once", async () => {
      const s = await seed();
      await run(s, await operation(s, "dialog", "start"));
      await run(s, await operation(s, "dialog_module", "configure", { enabled: false }));
      await run(s, await operation(s, "dialog_module", "configure", { enabled: true }));
      const demand = await db.dialogControlResumeDemand.findFirst({ where: { agencyId: s.agencyId } }),
        resume = require("../../src/services/dialog-module-control-service").resumeDemand;
      assert.equal(await resume({ db, id: demand.id }), true);
      const count = await db.jobInstance.count({ where: { agencyId: s.agencyId } });
      assert.equal(await resume({ db, id: demand.id }), false);
      assert.equal(await db.jobInstance.count({ where: { agencyId: s.agencyId } }), count);
    });
    await check("16,000 paused dialog states resume without the previous 1,000-row cutoff", async () => {
      const s = await seed();
      await db.$executeRawUnsafe(
        `INSERT INTO "DialogScanState" ("id","agencyId","creatorId","dialogId","status","updatedAt") SELECT 'state-'||$1||'-'||n,$1,$2,n::text,'PAUSED',CURRENT_TIMESTAMP FROM generate_series(1,16000)n`,
        s.agencyId,
        s.creatorId
      );
      const result = await run(s, await operation(s, "dialog", "resume"));
      assert.equal(result.result.resumedStates, 16000);
      assert.equal(await db.dialogScanState.count({ where: { agencyId: s.agencyId, status: "PLANNED" } }), 16000);
    });
    const auth = require("../../src/services/auth-service"),
      mail = require("../../src/services/auth-mail-outbox-service"),
      { sha256 } = require("../../src/utils/crypto");
    async function token(s, plain = "token", patch = {}) {
      return db.authToken.create({
        data: {
          userId: s.userId,
          type: "EMAIL_VERIFY",
          tokenHash: sha256(s.userId + plain),
          codeHash: sha256("123456"),
          expiresAt: new Date(Date.now() + 1800000),
          ...patch,
        },
      });
    }
    await check("verification consumes one token and all sibling codes once under the User fence", async () => {
      const s = await seed();
      await token(s);
      await token(s, "sibling", { codeHash: sha256("654321") });
      const results = await Promise.all([
        auth.verifyEmailByToken(s.userId + "token"),
        auth.verifyEmailByCode({ email: (await user(s)).email, code: "123456" }),
      ]);
      assert.equal(results.filter((x) => x.ok).length, 1);
      assert.equal(await db.authToken.count({ where: { userId: s.userId, usedAt: null } }), 0);
      const stamp = (await user(s)).emailVerifiedAt;
      assert.equal((await auth.verifyEmailByToken(s.userId + "sibling")).ok, false);
      assert.deepEqual((await user(s)).emailVerifiedAt, stamp);
    });
    await check("expired and disabled-user verification cannot update the account", async () => {
      const s = await seed();
      await token(s, "expired", { expiresAt: new Date(0) });
      assert.equal((await auth.verifyEmailByToken(s.userId + "expired")).ok, false);
      await token(s);
      await disable(s);
      assert.equal((await auth.verifyEmailByToken(s.userId + "token")).ok, false);
      assert.equal((await user(s)).emailVerifiedAt, null);
    });
    async function queued(s) {
      const t = await token(s);
      return db.$transaction((tx) =>
        mail.enqueueAuthMail(tx, {
          userId: s.userId,
          authTokenId: t.id,
          kind: "EMAIL_VERIFY",
          expiresAt: t.expiresAt,
          payload: {
            from: "synthetic@example.test",
            to: ["recipient@example.test"],
            subject: "test",
            html: "secret-token",
          },
        })
      );
    }
    await check("auth-mail unknown outcome retries exact wire payload and provider identity", async () => {
      const s = await seed(),
        id = await queued(s),
        seen = [];
      const send = async (payload, options) => {
        seen.push({ payload, options });
        return seen.length === 1
          ? { ok: false, outcome: "unknown", code: "TIMEOUT" }
          : { ok: true, providerId: "synthetic" };
      };
      await mail.deliverAuthMail({ db, id, send });
      assert.equal((await db.authMailOutbox.findUnique({ where: { id } })).status, "UNKNOWN");
      await db.authMailOutbox.update({ where: { id }, data: { nextAttemptAt: new Date(0) } });
      await mail.deliverAuthMail({ db, id, send });
      assert.deepEqual(seen[0], seen[1]);
      assert.equal((await db.authMailOutbox.findUnique({ where: { id } })).payload, null);
      await mail.deliverAuthMail({ db, id, send });
      assert.equal(seen.length, 2);
    });
    await check("auth-mail active lease excludes a second dispatcher and stale settlement is fenced", async () => {
      const s = await seed(),
        id = await queued(s);
      let enter, release;
      const started = new Promise((r) => (enter = r)),
        gate = new Promise((r) => (release = r));
      const flight = mail.deliverAuthMail({
        db,
        id,
        send: async () => {
          enter();
          await gate;
          return { ok: true, providerId: "synthetic" };
        },
      });
      await started;
      const second = await mail.deliverAuthMail({
        db,
        id,
        send: async () => {
          throw Error("second physical send");
        },
      });
      assert.equal(second.code, "AUTH_MAIL_PENDING");
      await db.authMailOutbox.update({ where: { id }, data: { leaseId: "new-owner" } });
      release();
      await flight;
      assert.equal((await db.authMailOutbox.findUnique({ where: { id } })).leaseId, "new-owner");
    });
    await check("auth-mail expired or consumed tokens are never sent", async () => {
      const s = await seed(),
        id = await queued(s);
      await db.authToken.updateMany({ where: { userId: s.userId }, data: { usedAt: new Date() } });
      let calls = 0;
      await mail.deliverAuthMail({
        db,
        id,
        send: async () => {
          calls++;
          return { ok: true };
        },
      });
      assert.equal(calls, 0);
      const row = await db.authMailOutbox.findUnique({ where: { id } });
      assert.equal(row.status, "EXPIRED");
      assert.equal(row.payload, null);
    });
    await check("auth issuance lost reply reuses one valid token and one encrypted mail intent", async () => {
      const s = await seed();
      delete process.env.RESEND_API_KEY;
      const before = await user(s);
      await auth.issueEmailVerification(before);
      await auth.issueEmailVerification(before);
      assert.equal(await db.authToken.count({ where: { userId: s.userId, usedAt: null } }), 1);
      assert.equal(await db.authMailOutbox.count({ where: { userId: s.userId } }), 1);
      assert.equal((await auth.issueEmailVerification(before)).token, undefined);
    });

    await check(
      "creator retirement receipt survives archived state and rolls back the complete transition",
      async () => {
        const s = await seed(),
          row = await creator(s);
        const { FAMILY, GENERATION } = require("../../src/services/phase2-work-coverage-authority-service");
        await db.phase2WorkCoverage.updateMany({
          where: {
            agencyId: s.agencyId,
            family: FAMILY.PROVIDER_OPERATIONAL,
            generation: GENERATION.PROVIDER_OPERATIONAL,
          },
          data: { active: true, enumerationState: "COMPLETE", completedAt: new Date() },
        });
        const c = command("creator.retire", s.creatorId, {
          expectedUpdatedAt: row.updatedAt.toISOString(),
          phrase: require("../../src/services/creator-agency-removal").agencyRemovalPhrase(row),
          acknowledgeAgencyRemoval: true,
          acknowledgeSessionRevocation: true,
        });
        await fault(() => run(s, c));
        assert.equal((await creator(s)).deletedAt, null);
        const a = await run(s, c),
          b = await run(s, c);
        assert.equal(b.replayed, true);
        assert.deepEqual(b.result, a.result);
        assert.ok((await creator(s)).deletedAt);
      }
    );
    async function cryptoSeed() {
      const s = await seed(),
        deviceId = "owner-" + s.userId,
        proof = Buffer.alloc(32, 0x5a).toString("base64");
      await db.workerDevice.create({ data: { id: deviceId, agencyId: s.agencyId, userId: s.userId } });
      const key = crypto
        .generateKeyPairSync("x25519")
        .publicKey.export({ format: "der", type: "spki" })
        .toString("base64");
      await db.deviceCryptoIdentity.create({
        data: {
          agencyId: s.agencyId,
          deviceId,
          userId: s.userId,
          publicKey: key,
          fingerprint: "synthetic",
          status: "ACTIVE",
        },
      });
      await db.agencyCryptoRoot.create({
        data: {
          agencyId: s.agencyId,
          recoveryCiphertext: "synthetic",
          recoveryIv: "synthetic",
          recoveryTag: "synthetic",
          recoveryProofHash: crypto.createHash("sha256").update(Buffer.from(proof, "base64")).digest("base64"),
        },
      });
      await db.agencyCryptoOwnerKeyWrap.create({
        data: {
          agencyId: s.agencyId,
          rootVersion: 1,
          deviceId,
          ephemeralPublicKey: key,
          ciphertext: "synthetic",
          iv: "synthetic",
          tag: "synthetic",
        },
      });
      await db.creatorCryptoKeyState.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId } });
      return {
        s,
        args: {
          db,
          agencyId: s.agencyId,
          userId: s.userId,
          member: s.member,
          actorDeviceId: deviceId,
          creatorId: s.creatorId,
          expectedKeyVersion: 1,
          expectedCurrentRootVersion: 1,
          expectedTargetRootVersion: 1,
          deviceWraps: [],
          actorProof: proof,
          commandId: crypto.randomUUID(),
        },
      };
    }
    const rotate = require("../../src/services/client-e2e-keyring-service").commitCreatorKeyRotation;
    await check("creator-key rotation commits receipt atomically and lost reply never rotates twice", async () => {
      const { s, args } = await cryptoSeed();
      await fault(() => rotate(args));
      assert.equal((await db.creatorCryptoKeyState.findUnique({ where: { creatorId: s.creatorId } })).activeVersion, 1);
      const a = await rotate(args),
        b = await rotate(args);
      assert.equal(a.activeKeyVersion, 2);
      assert.equal(b.replayed, true);
      assert.equal(b.activeKeyVersion, 2);
      await assert.rejects(rotate({ ...args, deviceWraps: [{ deviceId: "tamper" }] }), {
        code: "CRYPTO_ROTATION_COMMAND_CONFLICT",
      });
      await assert.rejects(rotate({ ...args, actorProof: Buffer.alloc(32, 1).toString("base64") }));
      assert.equal((await db.creatorCryptoKeyState.findUnique({ where: { creatorId: s.creatorId } })).activeVersion, 2);
    });
    await check(
      "creator-key rotation cancellation cannot erase a committed receipt or admit an abandoned command",
      async () => {
        const { args } = await cryptoSeed();
        assert.equal((await rotate({ ...args, cancel: true })).abandoned, true);
        await assert.rejects(rotate(args), { code: "CRYPTO_ROTATION_COMMAND_ABANDONED" });
        const next = { ...args, commandId: crypto.randomUUID() };
        await rotate(next);
        const recovery = await rotate({ ...next, cancel: true });
        assert.equal(recovery.alreadyCommitted, true);
        assert.equal(recovery.result.activeKeyVersion, 2);
      }
    );
    console.log(
      JSON.stringify({
        status: "PASS",
        cases: cases.length,
        actualPrisma: true,
        fullMigrationChain: true,
        physicalMultiSessionPostgres: false,
        externalServices: false,
      })
    );
  } finally {
    await db.$disconnect();
    await server.stop();
    await engine.close();
  }
}
main().then(
  () => {
    clearInterval(keepAlive);
    clearTimeout(deadline);
  },
  (e) => {
    console.error(e);
    clearInterval(keepAlive);
    clearTimeout(deadline);
    process.exitCode = 1;
  }
);

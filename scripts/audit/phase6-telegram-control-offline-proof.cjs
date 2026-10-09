"use strict";
// Disposable full-migration SQL proof. Does not use the caller's DATABASE_URL.
const assert = require("node:assert/strict"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { createRequire } = require("node:module"),
  { spawn } = require("node:child_process");
const { PrismaClient } = require(process.env.D9_PRISMA_CLIENT || "@prisma/client");
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
  console.log("PROOF_ENGINE_READY");
  const server = new PGLiteSocketServer({ db: engine, host: "127.0.0.1", port: 0 });
  await server.start();
  console.log("PROOF_SOCKET_READY");
  const url = `postgresql://postgres:postgres@${server.getServerConn()}/postgres?connection_limit=1&sslmode=disable`;
  const db = new PrismaClient({ datasources: { db: { url } }, log: [{ emit: "event", level: "query" }] }),
    cases = [];
  if (process.env.D9_SQL_TRACE === "1") db.$on("query", (e) => console.log("SQL", e.query.slice(0, 150)));
  const check = async (name, work) => {
    console.log("CHECK_START", name);
    await work();
    cases.push({ name, status: "PASS" });
    console.log(JSON.stringify(cases.at(-1)));
  };
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [require.resolve("prisma/build/index.js"), "migrate", "deploy"], {
        cwd: path.resolve(__dirname, "../.."),
        env: { ...process.env, DATABASE_URL: url },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (b) => {
        output += b;
        console.log("MIGRATION", String(b).slice(0, 500));
      });
      child.stderr.on("data", (b) => {
        output += b;
        console.log("MIGRATION_ERR", String(b).slice(0, 500));
      });
      child.once("error", reject);
      child.once("close", (code) => (code ? reject(Error(output)) : resolve()));
    });
    console.log("PROOF_MIGRATIONS_APPLIED");
    await engine.exec("DISCARD ALL");
    console.log("PROOF_WIRE_RESET");
    await engine.exec("SET TIME ZONE 'UTC'");
    await engine.exec(`CREATE TABLE "D9ReceiptFault" (enabled boolean NOT NULL); INSERT INTO "D9ReceiptFault" VALUES(false);
      CREATE FUNCTION d9_receipt_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF (SELECT enabled FROM "D9ReceiptFault") THEN RAISE EXCEPTION 'D9_RECEIPT_FAULT'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER d9_receipt_fault BEFORE INSERT ON "ManagementCommandReceipt" FOR EACH ROW EXECUTE FUNCTION d9_receipt_fault();`);
    process.env.SNAPSHOT_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    global.fetch = async () => {
      throw Error("D9 proof forbids external services");
    };
    require.cache[require.resolve("../../src/prisma")] = { exports: db };
    const {
      executeTelegramControlCommand: execute,
      readTelegramAuthorizationMaterial: material,
    } = require("../../src/services/telegram-control-command-service");
    const {
      readReminderState,
      accountRevision,
      credentialRevision,
    } = require("../../src/services/telegram-control-state");
    const {
      encryptTelegramCredentials,
      decryptTelegramCredentials,
    } = require("../../src/services/telegram-mtproto-credentials");
    const settings = require("../../src/services/settings-service");
    const {
      authorizeAuthorizationHistoryPublisher,
    } = require("../../src/services/authorization-history-write-contract");
    const { FAMILY, GENERATION } = require("../../src/services/phase2-work-coverage-authority-service");
    let seq = 0;
    const generation = (tx) =>
      tx.$executeRawUnsafe(
        "SELECT set_config('onlinod.phase2_team_control_plane_generation',$1,true)",
        "phase2_team_control_plane_v2_durable_access"
      );
    async function seed() {
      return db.$transaction(async (tx) => {
        await generation(tx);
        await authorizeAuthorizationHistoryPublisher(tx);
        const user = await tx.user.create({
          data: { email: `d9-${++seq}@example.test`, passwordHash: "synthetic", emailVerifiedAt: new Date() },
        });
        const agency = await tx.agency.create({ data: { name: `d9-${seq}`, trialEndsAt: new Date("2099-01-01") } });
        const member = await tx.agencyMember.create({
          data: { userId: user.id, agencyId: agency.id, role: "OWNER", roleKey: "owner", assignedCreators: "all" },
        });
        const s = {
          userId: user.id,
          agencyId: agency.id,
          actorMember: member,
          deviceId: "device",
          authorizationSessionId: crypto.randomUUID(),
        };
        const session = await tx.refreshSession.create({
          data: {
            userId: s.userId,
            agencyId: s.agencyId,
            deviceId: s.deviceId,
            authorizationSessionId: s.authorizationSessionId,
            tokenHash: crypto.randomUUID(),
            expiresAt: new Date("2099-01-01"),
          },
        });
        await tx.phase2WorkCoverage.upsert({
          where: {
            agencyId_family_generation: {
              agencyId: s.agencyId,
              family: FAMILY.PROVIDER_OPERATIONAL,
              generation: GENERATION.PROVIDER_OPERATIONAL,
            },
          },
          create: {
            id: crypto.randomUUID(),
            agencyId: s.agencyId,
            family: FAMILY.PROVIDER_OPERATIONAL,
            generation: GENERATION.PROVIDER_OPERATIONAL,
            active: true,
            enumerationState: "COMPLETE",
            completedAt: new Date(),
          },
          update: { active: true, enumerationState: "COMPLETE", completedAt: new Date() },
        });
        return { ...s, loginId: session.id };
      });
    }
    const command = (s, action, payload = {}, targetId = "") => ({
      commandId: crypto.randomUUID(),
      action,
      targetId,
      payload: { ...payload, deviceId: s.deviceId, originAuthorizationSessionId: s.authorizationSessionId },
    });
    const run = (s, input, extra = {}) => execute({ db, ...s, input, ...extra });
    const createCommand = (s) => command(s, "telegram.create", { apiId: 12345, apiHash: "a".repeat(32) });
    const row = (id) => db.agencyTelegramMtprotoAccount.findUnique({ where: { id } });
    const receipts = (s) =>
      db.$queryRawUnsafe('SELECT * FROM "ManagementCommandReceipt" WHERE "agencyId"=$1', s.agencyId);
    async function add(s, patch = {}) {
      return db.agencyTelegramMtprotoAccount.create({
        data: {
          agencyId: s.agencyId,
          apiId: 12345,
          ...encryptTelegramCredentials({ apiHash: "a".repeat(32), session: "" }),
          ...patch,
        },
      });
    }
    const sessionCommand = (s, r, value = "private-mtproto-session") =>
      command(s, "telegram.session", { session: value, expectedCredentialRevision: credentialRevision(r) }, r.id);
    const retireCommand = (s, r, forced = false) =>
      command(
        s,
        forced ? "telegram.forceRetire" : "telegram.retire",
        {
          expectedRevision: accountRevision(r),
          ...(forced ? { reason: "Lost PC", acknowledgeLostObservations: true } : {}),
        },
        r.id
      );
    async function policyCommand(s, enabled) {
      const state = await readReminderState(db, s.agencyId);
      return command(s, "telegram.reminders", {
        expectedRevision: state.remindersRevision,
        reminders: { ...state.reminders, content: { ...state.reminders.content, enabled } },
      });
    }
    async function fault(work) {
      await db.$executeRawUnsafe('UPDATE "D9ReceiptFault" SET enabled=true');
      try {
        await assert.rejects(work());
      } finally {
        await db.$executeRawUnsafe('UPDATE "D9ReceiptFault" SET enabled=false');
      }
    }
    const retirementWork = (s) =>
      db.domainWorkItem.findMany({ where: { agencyId: s.agencyId, objectType: "TelegramAccountRetirement" } });
    await check("create lost response replay creates one connection and one receipt", async () => {
      const s = await seed(),
        c = createCommand(s),
        a = await run(s, c),
        b = await run(s, c);
      assert.equal(a.result.accountId, b.result.accountId);
      assert.equal(b.replayed, true);
      assert.equal(await db.agencyTelegramMtprotoAccount.count({ where: { agencyId: s.agencyId } }), 1);
      assert.equal((await receipts(s)).length, 1);
      const stored = await row(a.result.accountId);
      assert.equal(decryptTelegramCredentials(stored).apiHash, "a".repeat(32));
      assert.ok(!JSON.stringify(await receipts(s)).includes("a".repeat(32)));
      assert.ok(!JSON.stringify(await receipts(s)).includes("encryptedPayload"));
    });
    await check("create receipt rollback removes connection and required audit", async () => {
      const s = await seed();
      await fault(() => run(s, createCommand(s)));
      assert.equal(await db.agencyTelegramMtprotoAccount.count({ where: { agencyId: s.agencyId } }), 0);
      assert.equal(await db.auditLog.count({ where: { agencyId: s.agencyId } }), 0);
    });
    await check("old create replay after deletion confirms history without resurrection", async () => {
      const s = await seed(),
        c = createCommand(s),
        a = await run(s, c);
      await db.agencyTelegramMtprotoAccount.delete({ where: { id: a.result.accountId } });
      const b = await run(s, c);
      assert.equal(b.result.account, null);
      assert.equal(await db.agencyTelegramMtprotoAccount.count({ where: { agencyId: s.agencyId } }), 0);
    });
    await check("reminder update publishes policy and durable work once; replay returns current policy", async () => {
      const s = await seed(),
        c = await policyCommand(s, false),
        a = await run(s, c);
      assert.equal(a.result.reminders.content.enabled, false);
      const next = await policyCommand(s, true);
      await run(s, next);
      const before = await db.domainWorkItem.findMany({ where: { agencyId: s.agencyId } }),
        b = await run(s, c);
      assert.equal(b.result.reminders.content.enabled, true);
      assert.deepEqual(await db.domainWorkItem.findMany({ where: { agencyId: s.agencyId } }), before);
    });
    await check("reminder ABA change is caught by dependency revision", async () => {
      const s = await seed(),
        stale = await policyCommand(s, false);
      await run(s, await policyCommand(s, false));
      await run(s, await policyCommand(s, true));
      await assert.rejects(run(s, stale), { code: "TELEGRAM_REMINDERS_CHANGED" });
    });
    await check("reminder receipt failure rolls back policy, revision, fanout and audit", async () => {
      const s = await seed(),
        before = await readReminderState(db, s.agencyId),
        c = await policyCommand(s, false);
      await fault(() => run(s, c));
      assert.deepEqual(await readReminderState(db, s.agencyId), before);
      assert.equal(await db.domainWorkItem.count({ where: { agencyId: s.agencyId } }), 0);
      assert.equal(await db.auditLog.count({ where: { agencyId: s.agencyId } }), 0);
    });
    await check("authorization material carries exact encrypted revision and no prior session", async () => {
      const s = await seed(),
        r = await add(s, {
          ...encryptTelegramCredentials({ apiHash: "a".repeat(32), session: "old-private-session" }),
        });
      const m = await material({ db, ...s, accountId: r.id });
      assert.equal(m.credentialRevision, credentialRevision(r));
      assert.equal(m.session, "");
      assert.equal(m.apiHash, "a".repeat(32));
    });
    await check("session lost response replay does not overwrite a newer session", async () => {
      const s = await seed(),
        r = await add(s),
        c = sessionCommand(s, r);
      await run(s, c);
      const second = sessionCommand(s, await row(r.id), "newest-private-session");
      await run(s, second);
      const b = await run(s, c);
      assert.equal(b.replayed, true);
      assert.equal(b.result.sessionStored, true);
      assert.equal(decryptTelegramCredentials(await row(r.id)).session, "newest-private-session");
      const serialized = JSON.stringify(await receipts(s));
      assert.ok(!serialized.includes("private-session") && !serialized.includes("apiHash"));
    });
    await check("a different delayed authorization cannot replace newer credentials", async () => {
      const s = await seed(),
        r = await add(s),
        old = sessionCommand(s, r, "delayed-private-session");
      await run(s, sessionCommand(s, r, "latest-private-session"));
      await assert.rejects(run(s, old), { code: "TELEGRAM_CREDENTIALS_CHANGED" });
      assert.equal(decryptTelegramCredentials(await row(r.id)).session, "latest-private-session");
    });
    await check("session receipt failure rolls back ciphertext and audit", async () => {
      const s = await seed(),
        r = await add(s);
      await fault(() => run(s, sessionCommand(s, r)));
      assert.equal(credentialRevision(await row(r.id)), credentialRevision(r));
      assert.equal(await db.auditLog.count({ where: { agencyId: s.agencyId } }), 0);
    });
    for (const patch of [
      { runtimeClaimedByDeviceId: "pc", runtimeClaimUntil: new Date("2099-01-01") },
      { runtimeClaimGeneration: 2, runtimeDrainedGeneration: 1 },
      { runtimeClaimedByDeviceId: "old-pc", runtimeClaimUntil: new Date("2000-01-01") },
    ])
      await check(
        "session and QR material reject an active or undrained runtime " + JSON.stringify(patch),
        async () => {
          const s = await seed(),
            r = await add(s, patch);
          await assert.rejects(run(s, sessionCommand(s, r)), { code: "TELEGRAM_AUTH_RUNTIME_NOT_DRAINED" });
          await assert.rejects(material({ db, ...s, accountId: r.id }), { code: "TELEGRAM_AUTH_RUNTIME_NOT_DRAINED" });
        }
      );
    await check("drained runtime generation allows a new authorization", async () => {
      const s = await seed(),
        r = await add(s, { runtimeClaimGeneration: 2, runtimeDrainedGeneration: 2 });
      await run(s, sessionCommand(s, r));
      assert.equal(decryptTelegramCredentials(await row(r.id)).session, "private-mtproto-session");
    });
    await check("retirement and its fanout are atomic with the receipt", async () => {
      const s = await seed(),
        r = await add(s),
        c = retireCommand(s, r);
      await fault(() => run(s, c));
      assert.equal((await row(r.id)).lifecycleState, "ACTIVE");
      assert.equal((await retirementWork(s)).length, 0);
      const first = await run(s, c);
      assert.equal(first.result.lifecycleState, "RETIRING");
      assert.equal(first.result.drainRequired, false);
      assert.equal((await retirementWork(s)).length, 1);
      const before = await retirementWork(s);
      assert.equal((await run(s, c)).replayed, true);
      assert.deepEqual(await retirementWork(s), before);
    });
    await check("retirement after a lost reply remains recoverable after actual deletion", async () => {
      const s = await seed(),
        r = await add(s),
        c = retireCommand(s, r);
      await run(s, c);
      await db.agencyTelegramMtprotoAccount.delete({ where: { id: r.id } });
      const replay = await run(s, c);
      assert.equal(replay.result.retired, true);
      assert.equal(replay.result.lifecycleState, "RETIRED");
    });
    await check("retirement refuses a stale displayed runtime generation", async () => {
      const s = await seed(),
        r = await add(s),
        c = retireCommand(s, r);
      await db.agencyTelegramMtprotoAccount.update({ where: { id: r.id }, data: { runtimeClaimGeneration: 1 } });
      await assert.rejects(run(s, c), { code: "TELEGRAM_ACCOUNT_CHANGED" });
      assert.equal((await row(r.id)).lifecycleState, "ACTIVE");
    });
    await check("undrained normal retirement remains pending without detach work", async () => {
      const s = await seed(),
        r = await add(s, { runtimeClaimGeneration: 1, runtimeClaimedByDeviceId: "lost-pc" }),
        a = await run(s, retireCommand(s, r));
      assert.equal(a.result.drainRequired, true);
      assert.equal((await retirementWork(s)).length, 0);
    });
    await check("normal finish after durable drain publishes one bounded fanout", async () => {
      const s = await seed(),
        r = await add(s, { runtimeClaimGeneration: 1, runtimeClaimedByDeviceId: "old-pc" });
      await run(s, retireCommand(s, r));
      const drained = await db.agencyTelegramMtprotoAccount.update({
        where: { id: r.id },
        data: { runtimeDrainedGeneration: 1, runtimeClaimedByDeviceId: null, retirementDrainCompletedAt: new Date() },
      });
      await run(s, retireCommand(s, drained));
      assert.equal((await retirementWork(s)).length, 1);
    });
    await check("force retirement refuses current live runtime even with valid revision", async () => {
      const s = await seed(),
        r = await add(s, {
          lifecycleState: "RETIRING",
          retirementRequestedAt: new Date(),
          runtimeClaimGeneration: 1,
          runtimeClaimedByDeviceId: "pc",
          runtimeClaimUntil: new Date("2099-01-01"),
        });
      await assert.rejects(run(s, retireCommand(s, r, true)), { code: "SETTINGS_TELEGRAM_FORCE_RETIRE_RUNTIME_LIVE" });
      assert.equal((await retirementWork(s)).length, 0);
    });
    await check("force retirement audit and fanout rollback together then replay once", async () => {
      const s = await seed(),
        r = await add(s, {
          lifecycleState: "RETIRING",
          retirementRequestedAt: new Date(),
          runtimeClaimGeneration: 1,
          runtimeClaimedByDeviceId: "lost-pc",
          runtimeClaimUntil: new Date("2000-01-01"),
        }),
        c = retireCommand(s, r, true);
      await fault(() => run(s, c));
      assert.equal((await retirementWork(s)).length, 0);
      assert.equal(await db.auditLog.count({ where: { agencyId: s.agencyId } }), 0);
      await run(s, c);
      await run(s, c);
      assert.equal((await retirementWork(s)).length, 1);
      assert.equal(
        await db.auditLog.count({
          where: { agencyId: s.agencyId, action: "settings.telegram.account_force_retired_lost_runtime" },
        }),
        1
      );
    });
    await check("retiring connection cannot accept a fresh QR material or session", async () => {
      const s = await seed(),
        r = await add(s);
      await run(s, retireCommand(s, r));
      await assert.rejects(material({ db, ...s, accountId: r.id }), { code: "SETTINGS_TELEGRAM_ACCOUNT_RETIRING" });
      await assert.rejects(run(s, sessionCommand(s, r)), { code: "SETTINGS_TELEGRAM_ACCOUNT_RETIRING" });
    });
    await check("cancel ordering and fingerprint reject late conflicting requests", async () => {
      const s = await seed(),
        c = createCommand(s);
      assert.equal((await run(s, c, { cancel: true })).abandoned, true);
      await assert.rejects(run(s, c), { code: "TELEGRAM_CONTROL_COMMAND_ABANDONED" });
      await assert.rejects(run(s, { ...c, payload: { ...c.payload, apiId: 987 } }), {
        code: "TELEGRAM_CONTROL_COMMAND_CONFLICT",
      });
      const committed = createCommand(s);
      await run(s, committed);
      assert.equal((await run(s, committed, { cancel: true })).alreadyCommitted, true);
      assert.equal(await db.agencyTelegramMtprotoAccount.count({ where: { agencyId: s.agencyId } }), 1);
    });
    await check("current actor membership epoch and role are rechecked on replay", async () => {
      const s = await seed(),
        c = createCommand(s);
      await run(s, c);
      await db.$transaction(async (tx) => {
        await generation(tx);
        await tx.agencyMember.update({ where: { id: s.actorMember.id }, data: { accessEpoch: { increment: 1 } } });
      });
      await assert.rejects(run(s, c), { code: "MANAGEMENT_ACCESS_STALE" });
      s.actorMember = await db.agencyMember.findUnique({ where: { id: s.actorMember.id } });
      assert.equal((await run(s, c)).replayed, true);
    });
    await check("authorization material and commit reject a revoked actor session", async () => {
      const s = await seed(),
        r = await add(s);
      await db.refreshSession.update({ where: { id: s.loginId }, data: { revokedAt: new Date() } });
      await assert.rejects(material({ db, ...s, accountId: r.id }), { code: "SESSION_REVOKED" });
      await assert.rejects(run(s, createCommand(s)), { code: "SESSION_REVOKED" });
    });
    await check("cross-agency account id never exposes material or accepts session", async () => {
      const s = await seed(),
        other = await seed(),
        r = await add(other);
      await assert.rejects(material({ db, ...s, accountId: r.id }), { code: "SETTINGS_TELEGRAM_ACCOUNT_NOT_FOUND" });
      await assert.rejects(run(s, sessionCommand(s, r)), { code: "SETTINGS_TELEGRAM_ACCOUNT_NOT_FOUND" });
    });
    await check(
      "new login confirms committed old intent, refuses uncommitted old intent and allows cancel",
      async () => {
        const s = await seed(),
          done = createCommand(s),
          pending = createCommand(s);
        await run(s, done);
        s.authorizationSessionId = crypto.randomUUID();
        await db.$transaction(async (tx) => {
          await authorizeAuthorizationHistoryPublisher(tx);
          await tx.refreshSession.create({
            data: {
              userId: s.userId,
              agencyId: s.agencyId,
              deviceId: s.deviceId,
              authorizationSessionId: s.authorizationSessionId,
              tokenHash: crypto.randomUUID(),
              expiresAt: new Date("2099-01-01"),
            },
          });
        });
        assert.equal((await run(s, done)).replayed, true);
        await assert.rejects(run(s, pending), { code: "TELEGRAM_CONTROL_ORIGIN_CHANGED" });
        assert.equal((await run(s, pending, { cancel: true })).abandoned, true);
      }
    );
    await check("account collection admits at most 128 rows and never returns a partial list", async () => {
      const s = await seed(),
        encrypted = encryptTelegramCredentials({ apiHash: "a".repeat(32), session: "" });
      await db.agencyTelegramMtprotoAccount.createMany({
        data: Array.from({ length: 128 }, (_, i) => ({
          id: crypto.randomUUID(),
          agencyId: s.agencyId,
          apiId: i + 1,
          ...encrypted,
        })),
      });
      await assert.rejects(run(s, createCommand(s)), { code: "TELEGRAM_CONTROL_ACCOUNT_LIMIT" });
      const view = await settings.getTelegramMtprotoSettings({ db, agencyId: s.agencyId, member: s.actorMember });
      assert.equal(view.accounts.length, 128);
      assert.ok(view.remindersRevision);
      await add(s);
      await assert.rejects(settings.getTelegramMtprotoSettings({ db, agencyId: s.agencyId, member: s.actorMember }), {
        code: "TELEGRAM_CONTROL_ACCOUNT_LIMIT",
      });
    });
    async function changeRole(s, role, disabled = false) {
      await db.$transaction(async (tx) => {
        await generation(tx);
        await tx.agencyMember.update({
          where: { id: s.actorMember.id },
          data: { role, roleKey: role.toLowerCase(), accessEpoch: { increment: 1 } },
        });
        const u = await tx.user.create({
          data: { email: `replacement-owner-${s.userId}@example.test`, passwordHash: "synthetic" },
        });
        await tx.agencyMember.create({
          data: { agencyId: s.agencyId, userId: u.id, role: "OWNER", roleKey: "owner", assignedCreators: "all" },
        });
        if (disabled) await tx.user.update({ where: { id: s.userId }, data: { disabledAt: new Date() } });
      });
      s.actorMember = await db.agencyMember.findUnique({ where: { id: s.actorMember.id } });
    }
    await check("current administrator can create and authorize with exactly one separate agency owner", async () => {
      const s = await seed();
      await changeRole(s, "ADMIN");
      const c = createCommand(s),
        r = await run(s, c);
      assert.equal((await material({ db, ...s, accountId: r.result.accountId })).apiId, 12345);
      assert.equal(await db.agencyMember.count({ where: { agencyId: s.agencyId, role: "OWNER" } }), 1);
    });
    await check("demoted current member cannot create, read secret material or replay", async () => {
      const s = await seed(),
        c = createCommand(s),
        r = await run(s, c);
      await changeRole(s, "OPERATOR");
      for (const attempt of [
        () => run(s, c),
        () => run(s, createCommand(s)),
        () => material({ db, ...s, accountId: r.result.accountId }),
      ])
        await assert.rejects(attempt(), { code: "MANAGEMENT_OWNER_OR_ADMIN_REQUIRED" });
    });
    await check("disabled current administrator cannot recover or read authorization material", async () => {
      const s = await seed(),
        c = createCommand(s),
        r = await run(s, c);
      await changeRole(s, "ADMIN", true);
      await assert.rejects(run(s, c), { code: "MANAGEMENT_USER_DISABLED" });
      await assert.rejects(material({ db, ...s, accountId: r.result.accountId }), { code: "MANAGEMENT_USER_DISABLED" });
    });
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

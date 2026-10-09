"use strict";
// Disposable full-migration SQL proof. Does not use the caller's DATABASE_URL.
const assert = require("node:assert/strict"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { createRequire } = require("node:module"),
  { spawn } = require("node:child_process");
const { PrismaClient } = require(process.env.D7_PRISMA_CLIENT || "@prisma/client");
const keepAlive = setInterval(() => {}, 1000);
const deadline = setTimeout(() => {
  console.error("LOCAL_PROOF_DEADLINE");
  process.exit(2);
}, 55000);
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
  if (process.env.D7_SQL_TRACE === "1") db.$on("query", (e) => console.log("SQL", e.query.slice(0, 150)));
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
      child.stdout.on("data", (b) => (output += b));
      child.stderr.on("data", (b) => (output += b));
      child.once("error", reject);
      child.once("close", (code) => (code ? reject(Error(output)) : resolve()));
    });
    console.log("PROOF_MIGRATIONS_APPLIED");
    await engine.exec("DISCARD ALL");
    console.log("PROOF_WIRE_RESET");
    await engine.exec("SET TIME ZONE 'UTC'");
    await engine.exec(`CREATE TABLE "D7AuditFault" (enabled boolean NOT NULL); INSERT INTO "D7AuditFault" VALUES(false);
      CREATE FUNCTION d7_receipt_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF (SELECT enabled FROM "D7AuditFault") THEN RAISE EXCEPTION 'D7_RECEIPT_FAULT'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER d7_receipt_fault BEFORE INSERT ON "ManagementCommandReceipt" FOR EACH ROW EXECUTE FUNCTION d7_receipt_fault();
      CREATE TABLE "D7CompletionFault" (enabled boolean NOT NULL); INSERT INTO "D7CompletionFault" VALUES(false);
      CREATE FUNCTION d7_completion_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW."action"='creator.connected' AND (SELECT enabled FROM "D7CompletionFault") THEN RAISE EXCEPTION 'D7_COMPLETION_FAULT'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER d7_completion_fault BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION d7_completion_fault();`);
    Object.assign(process.env, {
      NOWPAYMENTS_MODE: "sandbox",
      NOWPAYMENTS_API_KEY: "synthetic",
      NOWPAYMENTS_IPN_SECRET: "synthetic",
      PUBLIC_BASE_URL: "https://backend.test",
      NOWPAYMENTS_SANDBOX_ACTIVATE: "true",
    });
    global.fetch = async () => {
      throw Error("D7 proof forbids external services");
    };
    console.log("PROOF_FIXTURE_DDL_READY");
    require.cache[require.resolve("../../src/prisma")] = { exports: db };
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
        const tag = "d7-" + ++seq;
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
          data: {
            agencyId: agency.id,
            displayName: tag,
            username: tag,
            enrollmentExpectedUsername: tag,
            status: "READY",
          },
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
    const profile = () => command("account.profile", "", { name: "after", expectedName: "before" });
    const proxy = (s) =>
      command("network.create", s.creatorId, {
        deviceId: "device",
        expectedNetworkVersion: 0,
        label: "Dedicated",
        type: "SOCKS5",
        host: "proxy.example.test",
        port: 1080,
      });
    const walletOwner = require("../../src/services/billing-wallet-service");
    const { billingControlRevision } = require("../../src/services/billing-control-command-service");
    const { readCommercialPolicy } = require("../../src/services/billing-commercial-policy-service");
    const enrollment = require("../../src/services/creator-enrollment-authority-service");
    const revision = async (s) =>
      billingControlRevision(
        await db.creatorAccount.findUnique({
          where: { id: s.creatorId },
          include: { billingProfile: true, billingEntitlement: true },
        }),
        await readCommercialPolicy({ db }),
        true
      );
    const start = async (s, extras = {}) =>
      command("billing.start", s.creatorId, {
        expectedRevision: await revision(s),
        testMode: true,
        expectedActive: false,
        expectedChargeCents: 2000,
        ...extras,
      });
    const prefs = async (s, ai = false, outreach = true) =>
      command("billing.preferences", s.creatorId, {
        expectedRevision: await revision(s),
        aiChatterEnabled: ai,
        outreachEnabled: outreach,
      });
    const cancelRenewal = async (s) =>
      command("billing.cancelRenewal", s.creatorId, { expectedRevision: await revision(s) });
    async function creatorData(s, data) {
      return db.$transaction(async (tx) => {
        await require("../../src/services/database-write-contract-service").authorizeCreatorAccountWrite(
          tx
        );
        return tx.creatorAccount.update({ where: { id: s.creatorId }, data });
      });
    }
    async function funding(s, amount = 100000n) {
      await db.agencyBillingWallet.create({ data: { agencyId: s.agencyId, testMode: true, balanceCents: amount } });
      const now = (await db.$queryRawUnsafe("SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now"))[0].now;
      const today = Math.floor(now.getTime() / 86400000) * 86400000,
        dates = Array.from({ length: 30 }, (_, i) => new Date(today - (i + 1) * 86400000));
      const proof = await db.analyticsScanProof.create({
        data: {
          agencyId: s.agencyId,
          creatorId: s.creatorId,
          dataType: "EARNINGS",
          scanRunId: "proof",
          sourceTimezone: "UTC",
          scanFrom: dates[29],
          scanTo: dates[0],
          requestedAt: now,
          serverReceivedAt: now,
          committedAt: now,
          status: "COMMITTED",
          collectorVersion: "d7-proof",
          schemaVersion: 1,
          scanGeneration: "d7",
          collectionReason: "PROOF",
          rowCount: 30,
          payloadChecksum: "a".repeat(64),
        },
      });
      await db.creatorEarningsDaily.createMany({
        data: dates.map((date) => ({
          agencyId: s.agencyId,
          creatorId: s.creatorId,
          date,
          totalCents: 100,
          scanProofId: proof.id,
          sourceScanRunId: "proof",
          collectedAt: now,
        })),
      });
      await db.analyticsCoverage.createMany({
        data: dates.map((coverageDate) => ({
          agencyId: s.agencyId,
          creatorId: s.creatorId,
          dataType: "EARNINGS",
          coverageDate,
          sourceTimezone: "UTC",
          status: "COMPLETE",
          scanProofId: proof.id,
          lastVerifiedAt: now,
        })),
      });
    }
    const balance = async (s) =>
      (
        await db.agencyBillingWallet.findUnique({
          where: { agencyId_testMode: { agencyId: s.agencyId, testMode: true } },
        })
      ).balanceCents;
    const entitlement = (s) => db.creatorBillingEntitlement.findUnique({ where: { creatorId: s.creatorId } });
    const contact = (s, value = "@next", expectedContact = null) =>
      command("creator.telegramContact", s.creatorId, {
        telegramContact: value,
        telegramAccountId: null,
        expectedContact,
        expectedAccountId: null,
      });
    const begin = (s, expectedGeneration = 0, expectedState = "ENROLLMENT_REQUIRED") =>
      command("creator.beginConnection", s.creatorId, { deviceId: "device", expectedGeneration, expectedState });
    async function handoffOwner(s, disableUser = false) {
      await db.$transaction(async (tx) => {
        await generation(tx);
        await tx.agencyMember.update({ where: { id: s.member.id }, data: { role: "ADMIN", roleKey: "admin" } });
        const user = await tx.user.create({
          data: { email: "new-" + s.userId + "@example.test", passwordHash: oldHash },
        });
        await tx.agencyMember.create({
          data: { agencyId: s.agencyId, userId: user.id, role: "OWNER", roleKey: "owner", assignedCreators: "all" },
        });
        if (disableUser) await tx.user.update({ where: { id: s.userId }, data: { disabledAt: new Date() } });
      });
    }
    async function connected(s) {
      const now = new Date();
      await creatorData(s, {
        connectionState: "CONNECTED",
        connectionGeneration: 1,
        remoteId: "id-" + s.creatorId,
        platformUsername: "old-" + s.creatorId,
        platformDisplayName: "Old",
        platformProfileObservedAt: new Date(now.getTime() - 10000),
        platformProfileSourceDeviceId: "device",
        platformProfileConnectionGeneration: 1,
      });
      return {
        db,
        agencyId: s.agencyId,
        creatorId: s.creatorId,
        userId: s.userId,
        actorMember: s.member,
        sourceDeviceId: "device",
        connectionGeneration: 1,
        observedAt: now.toISOString(),
        remoteId: "id-" + s.creatorId,
        username: "new-" + s.creatorId,
        platformDisplayName: "New",
        avatarUrl: null,
      };
    }
    await check("Billing first start and lost response replay debit exactly one period", async () => {
      const s = await seed();
      await funding(s);
      const c = await start(s),
        one = await run(s, c),
        two = await run(s, c);
      assert.equal(one.result.period.totalCents, 2000);
      assert.equal(one.result.entitlement.autoRenewEnabled, true);
      assert.deepEqual(two.result, one.result);
      assert.equal(two.replayed, true);
      assert.equal(await balance(s), 98000n);
      assert.equal(
        await db.billingWalletTransaction.count({ where: { agencyId: s.agencyId, type: "SUBSCRIPTION_DEBIT" } }),
        1
      );
      assert.equal((await receipts(s)).length, 1);
    });
    await check("Old start after cancel cannot re-enable renewal or debit again", async () => {
      const s = await seed();
      await funding(s);
      const c = await start(s);
      await run(s, c);
      await run(s, await cancelRenewal(s));
      const r = await run(s, c);
      assert.equal(r.resultUnavailable, true);
      assert.equal((await entitlement(s)).autoRenewEnabled, false);
      assert.equal(await balance(s), 98000n);
    });
    await check("Old cancellation after explicit resume cannot cancel the newer renewal", async () => {
      const s = await seed();
      await funding(s);
      await run(s, await start(s));
      const c = await cancelRenewal(s);
      await run(s, c);
      const r = await run(s, await start(s, { expectedActive: true, expectedChargeCents: 0 }));
      assert.equal(r.result.alreadyActive, true);
      assert.equal(r.result.period, null);
      assert.equal((await run(s, c)).resultUnavailable, true);
      assert.equal((await entitlement(s)).autoRenewEnabled, true);
      assert.equal(await balance(s), 98000n);
    });
    await check("Saved old start after paid period expiry never purchases a second month", async () => {
      const s = await seed();
      await funding(s);
      const c = await start(s);
      await run(s, c);
      await db.creatorBillingEntitlement.update({
        where: { creatorId: s.creatorId },
        data: { coreValidUntil: new Date(Date.now() - 1000) },
      });
      assert.equal((await run(s, c)).resultUnavailable, true);
      assert.equal(await balance(s), 98000n);
      assert.equal(await db.creatorBillingPeriod.count({ where: { creatorId: s.creatorId } }), 1);
    });
    await check("Stale new preferences/cancellation fail CAS instead of overwriting a newer command", async () => {
      const s = await seed(),
        a = await prefs(s),
        b = await prefs(s, true, false);
      await run(s, a);
      await assert.rejects(run(s, b), { code: "BILLING_CONTROL_VERSION_CONFLICT" });
      await assert.rejects(
        run(s, command("billing.cancelRenewal", s.creatorId, { expectedRevision: b.payload.expectedRevision })),
        { code: "BILLING_CONTROL_VERSION_CONFLICT" }
      );
      const row = await db.creatorBillingProfile.findUnique({ where: { creatorId: s.creatorId } });
      assert.equal(row.aiChatterEnabled, false);
      assert.equal(row.outreachEnabled, true);
    });
    await check("Preferences replay preserves newer add-ons and receipt stores no body", async () => {
      const s = await seed(),
        c = await prefs(s);
      await run(s, c);
      await run(s, await prefs(s, true, false));
      assert.equal((await run(s, c)).resultUnavailable, true);
      const rows = await receipts(s);
      assert.equal(rows.length, 2);
      assert.equal(JSON.stringify(rows).includes("expectedRevision"), false);
    });
    await check("Shown price change rejects without period, debit, receipt or partial profile", async () => {
      const s = await seed();
      await funding(s);
      const c = await start(s, { expectedChargeCents: 1 });
      await assert.rejects(run(s, c), { code: "BILLING_QUOTE_CHANGED" });
      assert.equal(await balance(s), 100000n);
      assert.equal((await receipts(s)).length, 0);
      assert.equal(await db.creatorBillingPeriod.count({ where: { creatorId: s.creatorId } }), 0);
    });
    await check("Crossing expiration after reading active status cannot silently charge the wallet", async () => {
      const s = await seed();
      await funding(s);
      const c = await start(s, { expectedActive: true, expectedChargeCents: 0 });
      await assert.rejects(run(s, c), { code: "BILLING_CONTROL_VERSION_CONFLICT" });
      assert.equal(await balance(s), 100000n);
    });
    await check("Provider environment is an explicit part of the saved start intent", async () => {
      const s = await seed();
      await funding(s);
      await assert.rejects(run(s, await start(s, { testMode: false })), {
        code: "BILLING_WALLET_ENVIRONMENT_MISMATCH",
      });
      assert.equal(await balance(s), 100000n);
    });
    await check("Insufficient balance and incomplete revenue leave no successful command receipt", async () => {
      const s = await seed();
      await funding(s, 100n);
      await assert.rejects(run(s, await start(s)), { code: "BILLING_WALLET_INSUFFICIENT_BALANCE" });
      const t = await seed();
      await db.agencyBillingWallet.create({ data: { agencyId: t.agencyId, testMode: true, balanceCents: 100000n } });
      await assert.rejects(run(t, await start(t)), { code: "BILLING_EARNINGS_30D_UNAVAILABLE" });
      assert.equal((await receipts(s)).length + (await receipts(t)).length, 0);
      assert.equal(await balance(s), 100n);
      assert.equal(await balance(t), 100000n);
    });
    await check(
      "Receipt insertion failure atomically rolls back debit, period, entitlement, profile and audit",
      async () => {
        const s = await seed();
        await funding(s);
        const c = await start(s);
        await db.$executeRawUnsafe('UPDATE "D7AuditFault" SET enabled=true');
        try {
          await assert.rejects(run(s, c));
        } finally {
          await db.$executeRawUnsafe('UPDATE "D7AuditFault" SET enabled=false');
        }
        assert.equal(await balance(s), 100000n);
        assert.equal(await entitlement(s), null);
        assert.equal(await db.creatorBillingPeriod.count({ where: { creatorId: s.creatorId } }), 0);
        assert.equal(await db.auditLog.count({ where: { agencyId: s.agencyId } }), 0);
        assert.equal(await db.creatorBillingProfile.count({ where: { creatorId: s.creatorId } }), 0);
        assert.equal((await receipts(s)).length, 0);
        await run(s, c);
        assert.equal(await balance(s), 98000n);
      }
    );
    await check("Cancel-before-execute is terminal; commit-before-cancel does not refund or undo payment", async () => {
      const s = await seed();
      await funding(s);
      const a = await start(s);
      assert.equal((await run(s, a, { cancel: true })).abandoned, true);
      await assert.rejects(run(s, a), { code: "MANAGEMENT_COMMAND_ABANDONED" });
      assert.equal(await balance(s), 100000n);
      const b = await start(s);
      await run(s, b);
      assert.equal((await run(s, b, { cancel: true })).alreadyCommitted, true);
      assert.equal(await balance(s), 98000n);
    });
    await check("Same command UUID with changed amount or action is never a new billing intent", async () => {
      const s = await seed();
      await funding(s);
      const c = await start(s);
      await run(s, c);
      await assert.rejects(run(s, { ...c, payload: { ...c.payload, expectedChargeCents: 3000 } }), {
        code: "MANAGEMENT_COMMAND_CONFLICT",
      });
      await assert.rejects(
        run(s, { ...c, action: "billing.cancelRenewal", payload: { expectedRevision: await revision(s) } }),
        { code: "MANAGEMENT_COMMAND_CONFLICT" }
      );
      assert.equal(await balance(s), 98000n);
    });
    await check(
      "Transferred OWNER cannot replay money results; current basic member can tombstone own unresolved intent",
      async () => {
        const s = await seed();
        await funding(s);
        const c = await start(s),
          other = await prefs(s);
        await run(s, c);
        await handoffOwner(s);
        s.member = await db.agencyMember.findUnique({ where: { id: s.member.id } });
        await assert.rejects(run(s, c), { code: "BILLING_OWNER_ONLY" });
        await assert.rejects(run(s, await prefs(s)), { code: "BILLING_OWNER_ONLY" });
        assert.equal((await run(s, other, { cancel: true })).abandoned, true);
        assert.equal(
          await db.agencyMember.count({
            where: { agencyId: s.agencyId, role: "OWNER", deletedAt: null, deactivatedAt: null },
          }),
          1
        );
      }
    );
    await check("Disabled User and stale access epoch reject both new commands and replay", async () => {
      const s = await seed(),
        c = await prefs(s);
      await run(s, c);
      await handoffOwner(s, true);
      await assert.rejects(run(s, c), { code: "MANAGEMENT_USER_DISABLED" });
      const t = await seed();
      await db.$transaction(async (tx) => {
        await generation(tx);
        await tx.agencyMember.update({ where: { id: t.member.id }, data: { accessEpoch: { increment: 1 } } });
      });
      await assert.rejects(run(t, await prefs(t)), { code: "MANAGEMENT_ACCESS_STALE" });
      assert.equal((await receipts(t)).length, 0);
    });
    await check("Billing recovery works after expiry and repeated refresh reuses planner authority", async () => {
      const s = await seed();
      await db.agency.update({ where: { id: s.agencyId }, data: { trialEndsAt: new Date(Date.now() - 86400000) } });
      const recovery = require("../../src/services/billing-recovery-service");
      const input = {
        db,
        agencyId: s.agencyId,
        userId: s.userId,
        actorMember: s.member,
        memberId: s.member.id,
        creatorId: s.creatorId,
      };
      const one = await recovery.requestBillingEarningsRefresh(input),
        two = await recovery.requestBillingEarningsRefresh(input);
      assert.equal(one.state, "QUEUED");
      assert.equal(two.created, 0);
      assert.ok(one.created + one.reused > 0);
      await handoffOwner(s, true);
      await assert.rejects(recovery.requestBillingEarningsRefresh(input), { code: "MANAGEMENT_USER_DISABLED" });
    });
    await check("Billing reconcile with no payment still rechecks current owner before disclosure", async () => {
      const s = await seed();
      const order = await db.billingOrder.create({
        data: {
          agencyId: s.agencyId,
          createdByUserId: s.userId,
          provider: "NOWPAYMENTS",
          status: "CHECKOUT_CREATED",
          amountCents: 100,
          testMode: true,
          billingPeriod: "MONTHLY",
          periodMonths: 1,
          billedCreators: 0,
          pricingSnapshot: {},
        },
      });
      const provider = require("../../src/services/billing-nowpayments-service");
      let checks = 0;
      await assert.rejects(
        provider.reconcileOrder({
          db,
          agencyId: s.agencyId,
          orderId: order.id,
          authorize: async () => {
            if (++checks === 2) throw Object.assign(Error("revoked"), { code: "PROOF_OWNER_REVOKED" });
          },
        }),
        { code: "PROOF_OWNER_REVOKED" }
      );
      assert.equal(checks, 2);
    });
    await check("Begin connection exact replay keeps one generation and changed UUID payload is rejected", async () => {
      const s = await seed(),
        c = begin(s),
        one = await run(s, c),
        two = await run(s, c);
      assert.equal(one.result.connectionGeneration, 1);
      assert.deepEqual(two.result, one.result);
      await assert.rejects(run(s, { ...c, payload: { ...c.payload, expectedGeneration: 1 } }), {
        code: "MANAGEMENT_COMMAND_CONFLICT",
      });
      await assert.rejects(run(s, begin(s)), { code: "CREATOR_CONNECTION_VERSION_CONFLICT" });
    });
    await check("Old begin after revoke cannot start a later reconnect generation", async () => {
      const s = await seed(),
        c = begin(s);
      await run(s, c);
      await creatorData(s, { remoteId: "remote-" + s.creatorId, connectionState: "RECONNECT_REQUIRED" });
      assert.equal((await run(s, c)).resultUnavailable, true);
      assert.equal((await db.creatorAccount.findUnique({ where: { id: s.creatorId } })).connectionGeneration, 1);
      const next = await run(s, begin(s, 1, "RECONNECT_REQUIRED"));
      assert.equal(next.result.connectionGeneration, 2);
    });
    await check("Begin connection device mismatch and receipt failure cannot advance the generation", async () => {
      const s = await seed(),
        c = begin(s);
      await assert.rejects(run(s, c, { deviceId: "other" }), { code: "CREATOR_CONNECTION_AUTH_DEVICE_MISMATCH" });
      await db.$executeRawUnsafe('UPDATE "D7AuditFault" SET enabled=true');
      try {
        await assert.rejects(run(s, c));
      } finally {
        await db.$executeRawUnsafe('UPDATE "D7AuditFault" SET enabled=false');
      }
      const creator = await db.creatorAccount.findUnique({ where: { id: s.creatorId } });
      assert.equal(creator.connectionGeneration, 0);
      assert.equal((await receipts(s)).length, 0);
    });
    await check(
      "Telegram contact durable replay preserves newer editor and clears resolved identity on change",
      async () => {
        const s = await seed();
        await creatorData(s, { telegramUserId: "123" });
        const c = contact(s),
          one = await run(s, c),
          two = await run(s, c);
        assert.equal(one.result.creator.telegramUserId, null);
        assert.deepEqual(one.result, two.result);
        await run(s, contact(s, "@latest", "@next"));
        assert.equal((await run(s, c)).resultUnavailable, true);
        await assert.rejects(run(s, contact(s, "@stale", null)), { code: "CREATOR_TELEGRAM_CONTACT_CHANGED" });
        assert.equal((await db.creatorAccount.findUnique({ where: { id: s.creatorId } })).telegramContact, "@latest");
      }
    );
    await check("Telegram assignment to unavailable account fails atomically with no receipt", async () => {
      const s = await seed(),
        c = contact(s);
      c.payload.telegramAccountId = "missing";
      await assert.rejects(run(s, c), { code: "CREATOR_TELEGRAM_ACCOUNT_INVALID" });
      assert.equal((await receipts(s)).length, 0);
      assert.equal((await db.creatorAccount.findUnique({ where: { id: s.creatorId } })).telegramContact, null);
    });
    await check("Profile observation preserves ordering and exact duplicates; key collision is rejected", async () => {
      const s = await seed(),
        o = await connected(s),
        one = await enrollment.observeCreatorPlatformProfile(o),
        two = await enrollment.observeCreatorPlatformProfile(o);
      assert.equal(one.unchanged, false);
      assert.equal(two.reason, "DUPLICATE_PROFILE_OBSERVATION");
      await assert.rejects(enrollment.observeCreatorPlatformProfile({ ...o, platformDisplayName: "Different" }), {
        code: "CREATOR_PROFILE_OBSERVATION_CONFLICT",
      });
      const old = await enrollment.observeCreatorPlatformProfile({
        ...o,
        observedAt: new Date(Date.parse(o.observedAt) - 1).toISOString(),
        username: "old",
      });
      assert.equal(old.staleNoop, true);
    });
    await check("Disabled user and stale observation epoch cannot update even a correctly bound profile", async () => {
      const s = await seed(),
        o = await connected(s);
      await handoffOwner(s, true);
      await assert.rejects(enrollment.observeCreatorPlatformProfile(o), { code: "CREATOR_CONNECTION_MEMBER_INACTIVE" });
      const t = await seed(),
        v = await connected(t);
      await db.$transaction(async (tx) => {
        await generation(tx);
        await tx.agencyMember.update({ where: { id: t.member.id }, data: { accessEpoch: { increment: 1 } } });
      });
      await assert.rejects(enrollment.observeCreatorPlatformProfile(v), { code: "MANAGEMENT_ACCESS_STALE" });
      assert.equal((await db.creatorAccount.findUnique({ where: { id: s.creatorId } })).platformDisplayName, "Old");
    });
    await check("Completion audit is atomic; same-generation replay records no second audit", async () => {
      const s = await seed(),
        beg = await run(s, begin(s)),
        creator = beg.result.creator,
        at = new Date(Date.parse(creator.connectionStartedAt) + 1000);
      await db.creatorSessionState.upsert({
        where: { creatorId: s.creatorId },
        create: {
          agencyId: s.agencyId,
          creatorId: s.creatorId,
          status: "ACTIVE",
          connectionGeneration: 1,
          revision: 1,
          portableReady: true,
          keyVersion: 1,
          encryptedPayload: "cipher",
          iv: "iv",
          tag: "tag",
          algorithm: "aes-256-gcm-client-e2e-v1",
          platformUserId: "remote-" + s.creatorId,
          credentialHash: "a".repeat(64),
          coherenceHash: "b".repeat(64),
          capturedAt: at,
        },
        update: {
          status: "ACTIVE",
          connectionGeneration: 1,
          revision: 1,
          portableReady: true,
          keyVersion: 1,
          encryptedPayload: "cipher",
          iv: "iv",
          tag: "tag",
          algorithm: "aes-256-gcm-client-e2e-v1",
          platformUserId: "remote-" + s.creatorId,
          credentialHash: "a".repeat(64),
          coherenceHash: "b".repeat(64),
          capturedAt: at,
        },
      });
      const input = {
        db,
        agencyId: s.agencyId,
        creatorId: s.creatorId,
        userId: s.userId,
        actorMember: s.member,
        connectionGeneration: 1,
        remoteId: "remote-" + s.creatorId,
        username: creator.username,
      };
      await db.$executeRawUnsafe('UPDATE "D7CompletionFault" SET enabled=true');
      try {
        await assert.rejects(enrollment.completeCreatorConnection(input));
      } finally {
        await db.$executeRawUnsafe('UPDATE "D7CompletionFault" SET enabled=false');
      }
      assert.equal((await db.creatorAccount.findUnique({ where: { id: s.creatorId } })).connectionState, "CONNECTING");
      assert.equal((await enrollment.completeCreatorConnection(input)).connectedNow, true);
      assert.equal((await enrollment.completeCreatorConnection(input)).unchanged, true);
      assert.equal(await db.auditLog.count({ where: { agencyId: s.agencyId, action: "creator.connected" } }), 1);
    });
    await check(
      "Reconcile rechecks owner after provider GET; factual settlement survives revoked presentation authority",
      async () => {
        const s = await seed();
        const order = await db.billingOrder.create({
          data: {
            agencyId: s.agencyId,
            createdByUserId: s.userId,
            provider: "NOWPAYMENTS",
            status: "CHECKOUT_CREATED",
            amountCents: 100,
            testMode: true,
            billingPeriod: "MONTHLY",
            periodMonths: 1,
            billedCreators: 0,
            pricingSnapshot: {},
          },
        });
        await db.billingPaymentAttempt.create({
          data: { orderId: order.id, provider: "NOWPAYMENTS", testMode: true, providerPaymentId: "proof-" + order.id },
        });
        const provider = require("../../src/services/billing-nowpayments-service"),
          { billingCheckoutAuthority } = require("../../src/services/billing-checkout-command-service");
        const originalFetch = global.fetch;
        let gets = 0;
        global.fetch = async (_url, options) => {
          assert.equal(options.method, "GET");
          gets++;
          await handoffOwner(s, true);
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                payment_id: "proof-" + order.id,
                order_id: order.id,
                payment_status: "waiting",
                price_amount: 1,
                price_currency: "usd",
              }),
          };
        };
        try {
          await assert.rejects(
            provider.reconcileOrder({
              db,
              agencyId: s.agencyId,
              orderId: order.id,
              authorize: billingCheckoutAuthority({ agencyId: s.agencyId, userId: s.userId, actorMember: s.member }),
            }),
            { code: "MANAGEMENT_USER_DISABLED" }
          );
        } finally {
          global.fetch = originalFetch;
        }
        assert.equal(gets, 1);
        assert.equal(
          await db.billingProviderEvent.count({ where: { orderId: order.id, processedAt: { not: null } } }),
          1
        );
      }
    );
    await check(
      "Retirement rechecks the creator revision behind the confirmation phrase before removing access",
      async () => {
        const s = await seed();
        const before = await db.creatorAccount.findUnique({ where: { id: s.creatorId } });
        await creatorData(s, { username: "changed-" + s.creatorId });
        const { runDbTransaction } = require("../../src/services/db-transaction-service");
        await assert.rejects(
          runDbTransaction(db, (tx) =>
            require("../../src/services/creator-lifecycle-authority-service").retireCreatorWithinTransaction({
              tx,
              agencyId: s.agencyId,
              creatorId: s.creatorId,
              actorUserId: s.userId,
              managementActorMember: s.member,
              expectedUpdatedAt: new Date(before.updatedAt.getTime() - 1000),
            })
          ),
          { code: "CREATOR_VERSION_CONFLICT" }
        );
        assert.equal((await db.creatorAccount.findUnique({ where: { id: s.creatorId } })).deletedAt, null);
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

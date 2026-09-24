"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createRequire } = require("node:module");
const { spawn } = require("node:child_process");
const { PrismaClient } = require("@prisma/client");
const root = path.resolve(__dirname, "../..");
async function main() {
  if (!process.env.PHASE5_PROOF_RUNTIME) throw new Error("PHASE5_PROOF_RUNTIME required");
  const load = createRequire(path.resolve(process.env.PHASE5_PROOF_RUNTIME, "package.json"));
  const { PGlite } = load("@electric-sql/pglite");
  const { PGLiteSocketServer } = load("@electric-sql/pglite-socket");
  console.log("[I4 proof] starting disposable SQL engine");
  const engine = await PGlite.create();
  const server = new PGLiteSocketServer({ db: engine, host: "127.0.0.1", port: 0 });
  await server.start();
  const url = `postgresql://postgres:postgres@${server.getServerConn()}/postgres?connection_limit=1&sslmode=disable`;
  const db = new PrismaClient({ datasources: { db: { url } } });
  const cases = [];
  const check = async (name, fn) => { await fn(); cases.push({ name, status: "PASS" }); console.log(JSON.stringify(cases.at(-1))); };
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, "node_modules/prisma/build/index.js"), "migrate", "deploy"], {
        cwd: root, env: { ...process.env, DATABASE_URL: url }, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = ""; child.stdout.on("data", b => { output += b; }); child.stderr.on("data", b => { output += b; });
      child.once("error", reject); child.once("close", code => code ? reject(new Error(output)) : resolve());
    });
    console.log("[I4 proof] full migration chain applied");
    await engine.exec("DISCARD ALL");
    await engine.exec("SET TIME ZONE 'UTC'");
    await engine.exec(`UPDATE "Phase2ReleaseCompatibilityAuthority" SET "activationState"='ACTIVE' WHERE "scope"='TEAM_CONTROL_PLANE'`);
    await engine.exec(`UPDATE "Phase2ReleaseCompatibilityAuthority" SET "requiredGeneration"='phase3_domain_executor_v6_failure_policy',"activationState"='ACTIVE' WHERE "scope"='DOMAIN_WORK_EXECUTOR'`);
    let attempts = 0, fault = null, afterRollback = null, hook = null, offsetMs = 0;
    const proxy = new Proxy({}, { get(_unused, key) {
      if (key === "$transaction") return async (fn, options) => {
        try { return await db.$transaction(async tx => {
          attempts++;
          const wrapped = new Proxy({}, { get(_t, k) {
            const value = tx[k];
            if (typeof value === "function") return async (...args) => {
              const result = await value.apply(tx, args);
              if (hook) await hook({ tx, key: k, args, result });
              if (k === "$queryRawUnsafe" && args[0].includes("clock_timestamp") && result[0]?.authorityNow && offsetMs) result[0].authorityNow = new Date(result[0].authorityNow.getTime() + offsetMs);
              return result;
            };
            if (value && typeof value === "object") return new Proxy(value, { get(model, method) {
              const methodValue = model[method];
              if (typeof methodValue !== "function") return methodValue;
              return async (...args) => {
                const result = await methodValue.apply(model, args);
                if (hook) await hook({ tx, key: k, method, args, result });
                return result;
              };
            } });
            return value;
          } });
          const result = await fn(wrapped);
          if (fault) {
            const code = fault; fault = null;
            assert.ok(["40001", "40P01"].includes(code));
            await tx.$executeRawUnsafe(`DO $$ BEGIN RAISE EXCEPTION USING ERRCODE='${code}', MESSAGE='I4_CONTROLLED_CONFLICT'; END $$`);
          }
          return result;
        }, options); }
        catch (error) { if (afterRollback) { const work = afterRollback; afterRollback = null; await work(); } throw error; }
      };
      const value = db[key]; return typeof value === "function" ? value.bind(db) : value;
    } });
    require.cache[require.resolve("../../src/prisma")] = { exports: proxy };
    const sessions = require("../../src/services/admin-session-authority-service");
    const bulk = require("../../src/services/admin-bulk-pricing-command-service");
    const support = require("../../src/services/admin-support-command-service");
    const adminRetention = require("../../src/services/admin-retention-command-service");
    const retention = require("../../src/services/retention-service");
    const retentionWork = require("../../src/services/retention-work-context-service");
    const { bootstrapAdmin } = require("../../src/services/admin-operator-bootstrap-service");
    const { diagnosticsStep, KEY: diagnosticsKey } = require("../../src/services/admin-diagnostics-service");
    const { compactAutomationDeliveries } = require("../../src/services/automation-history-service");
    const work = require("../../src/services/domain-work-authority-service");
    const password = "i4-proof-strong-password";
    const passwordHash = await require("bcryptjs").hash(password, 4);
    let seq = 0;
    async function seed() {
      const label = `i4-${++seq}`;
      return db.$transaction(async tx => {
        await tx.$executeRawUnsafe("SELECT set_config('onlinod.phase2_team_control_plane_generation',$1,true)", "phase2_team_control_plane_v2_durable_access");
        const user = await tx.user.create({ data: { email: label + "@example.test", passwordHash: "proof" } });
        const agency = await tx.agency.create({ data: { name: label, trialEndsAt: new Date(Date.now() + 86400000) } });
        await tx.agencyMember.create({ data: { agencyId: agency.id, userId: user.id, role: "OWNER", roleKey: "owner", assignedCreators: "all" } });
        const creator = await tx.creatorAccount.create({ data: { agencyId: agency.id, displayName: label, status: "READY" } });
        await tx.$executeRawUnsafe("SELECT set_config('onlinod.commercial_pricing_writer','v1',true)");
        await tx.creatorBillingProfile.create({ data: { agencyId: agency.id, creatorId: creator.id } });
        const admin = await tx.adminUser.create({ data: { email: label + "-admin@example.test", passwordHash } });
        const session = await tx.adminSession.create({ data: { adminUserId: admin.id, tokenHash: crypto.randomUUID(), issuedAccessEpoch: admin.accessEpoch, expiresAt: new Date(Date.now() + 86400000) } });
        return { agency, creator, admin, session, actor: { adminId: admin.id, sessionId: session.id, accessEpoch: admin.accessEpoch } };
      });
    }
    const rejectAudit = async ({ tx, key }) => {
      if (key === "adminActionLog" || key === "adminCommandAudit") await tx.$executeRawUnsafe("DO $$ BEGIN RAISE EXCEPTION 'I4_REQUIRED_AUDIT_FAILURE'; END $$");
    };
    async function queuedBulk() {
      const s = await seed();
      const accepted = await bulk.submitAdminBulkPricing({ db: proxy, actor: s.actor, commandId: crypto.randomUUID(), agencyId: s.agency.id,
        payload: { tier: "PRO", reason: "I4 proof", items: [{ creatorId: s.creator.id, expectedRevision: 1 }] } });
      assert.equal(accepted.statusCode, 202);
      const claim = await work.claimDomainWorkBatch({ db: proxy, workClass: bulk.WORK_CLASS, agencyId: s.agency.id, generation: bulk.GENERATION, limit: 1, leaseMs: 120000 });
      assert.equal(claim.items.length, 1, claim.reason || "Expected one claimed command");
      return { ...s, item: claim.items[0], ownerToken: claim.ownerToken };
    }
    const processItem = s => bulk.processAdminBulkPricingItem({ db: proxy, item: s.item, ownerToken: s.ownerToken });
    async function queuedRetention() {
      await db.retentionSweepLease.deleteMany({}); // Disposable fixture reset, no production path.
      const s = await seed(), policy = await retention.getRetentionSettings({ db: proxy });
      const accepted = await adminRetention.submitAdminRetentionRun({ db: proxy, actor: s.actor, commandId: crypto.randomUUID(),
        payload: { reason: "I4 proof", expectedRevision: policy.revision, expectedPolicyHash: policy.policyHash } });
      assert.equal(accepted.statusCode, 202);
      return { ...s, row: await db.adminCommand.findFirst({ where: { actorId: s.admin.id, action: "retention.run" } }) };
    }
    await check("login SQLSTATE 40001 retries once; one session and one required audit", async () => {
      const s = await seed(), before = attempts; fault = "40001";
      const result = await sessions.loginAdmin({ db: proxy, email: s.admin.email, password });
      assert.equal(attempts - before, 2); assert.ok(result.token);
      assert.equal(await db.adminSession.count({ where: { adminUserId: s.admin.id } }), 2);
      assert.equal(await db.adminActionLog.count({ where: { adminUserId: s.admin.id } }), 1);
    });
    await check("login retry re-reads a changed credential generation", async () => {
      const s = await seed(); fault = "40001";
      afterRollback = () => db.adminUser.update({ where: { id: s.admin.id }, data: { passwordHash: "changed" } });
      await assert.rejects(sessions.loginAdmin({ db: proxy, email: s.admin.email, password }), { code: "ADMIN_CREDENTIAL_GENERATION_CHANGED" });
      assert.equal(await db.adminSession.count({ where: { adminUserId: s.admin.id } }), 1);
      assert.equal(await db.adminActionLog.count({ where: { adminUserId: s.admin.id } }), 0);
    });
    await check("mandatory login audit failure rolls back session and lastLoginAt", async () => {
      const s = await seed(); hook = rejectAudit;
      try { await assert.rejects(sessions.loginAdmin({ db: proxy, email: s.admin.email, password }), /I4_REQUIRED_AUDIT_FAILURE/); } finally { hook = null; }
      assert.equal(await db.adminSession.count({ where: { adminUserId: s.admin.id } }), 1);
      assert.equal((await db.adminUser.findUnique({ where: { id: s.admin.id } })).lastLoginAt, null);
    });
    await check("logout audit rollback, conflict retry and replay preserve one revocation", async () => {
      const s = await seed(); hook = rejectAudit;
      try { await assert.rejects(sessions.logoutAdmin({ db: proxy, actor: s.actor }), /I4_REQUIRED_AUDIT_FAILURE/); } finally { hook = null; }
      assert.equal((await db.adminSession.findUnique({ where: { id: s.session.id } })).revokedAt, null);
      fault = "40P01"; const before = attempts;
      await sessions.logoutAdmin({ db: proxy, actor: s.actor }); assert.equal(attempts - before, 2);
      await sessions.logoutAdmin({ db: proxy, actor: s.actor });
      assert.equal(await db.adminActionLog.count({ where: { adminUserId: s.admin.id } }), 1);
    });
    await check("operator recovery retry and replay keep one epoch advance and one receipt", async () => {
      const s = await seed(); const input = { db: proxy, commandId: crypto.randomUUID(), operator: "i4-disposable", reason: "Proof recovery", email: s.admin.email, password, name: "Recovered" };
      fault = "40001"; const before = attempts; await bootstrapAdmin(input); assert.equal(attempts - before, 2);
      const changed = await db.adminUser.findUnique({ where: { id: s.admin.id } });
      assert.equal(changed.accessEpoch, s.admin.accessEpoch + 1);
      assert.ok((await db.adminSession.findUnique({ where: { id: s.session.id } })).revokedAt);
      await bootstrapAdmin(input);
      assert.equal((await db.adminUser.findUnique({ where: { id: s.admin.id } })).accessEpoch, changed.accessEpoch);
      assert.equal(await db.adminCommandAudit.count({ where: { actorId: "operator:i4-disposable" } }), 1);
    });
    for (const code of ["40001", "40P01"]) await check(`bulk ${code} commits one price, cursor, item audit and claim settlement`, async () => {
      const s = await queuedBulk(), before = attempts; fault = code;
      assert.equal((await processItem(s)).status, "SUCCEEDED"); assert.equal(attempts - before, 2);
      assert.equal((await db.creatorBillingProfile.findUnique({ where: { creatorId: s.creator.id } })).pricingRevision, 2);
      const row = await db.adminCommand.findUnique({ where: { id: s.item.objectId } });
      assert.equal(row.executionProgress.nextIndex, 1);
      assert.equal(await db.adminCommandAudit.count({ where: { commandId: row.id } }), 2);
      assert.equal((await db.domainWorkItem.findUnique({ where: { id: s.item.id } })).state, "DONE");
    });
    for (const boundary of ["creator-lock", "audit", "settlement"]) await check(`bulk expiry after ${boundary}: savepoint rolls back target and settles PAUSED_AUTH`, async () => {
      const s = await queuedBulk();
      await db.adminSession.update({ where: { id: s.session.id }, data: { expiresAt: new Date(Date.now() + 60000) } });
      hook = async ({ key, args }) => {
        if ((boundary === "creator-lock" && key === "$queryRawUnsafe" && args[0].includes('FROM "CreatorBillingProfile"')) ||
            (boundary === "audit" && key === "adminCommandAudit" && args[0].data.event === "SUCCEEDED") ||
            (boundary === "settlement" && key === "$queryRawUnsafe" && args[0].includes('UPDATE "DomainWorkItem"'))) offsetMs = 90000;
      };
      try { assert.equal((await processItem(s)).status, "PAUSED_AUTH"); assert.equal(offsetMs, 90000); } finally { hook = null; offsetMs = 0; }
      assert.equal((await db.creatorBillingProfile.findUnique({ where: { creatorId: s.creator.id } })).pricingRevision, 1);
      const row = await db.adminCommand.findUnique({ where: { id: s.item.objectId } }); assert.equal(row.executionProgress.nextIndex, 0);
      const audit = await db.adminCommandAudit.findMany({ where: { commandId: row.id }, orderBy: { sequence: "asc" } });
      assert.deepEqual(audit.map(a => a.event), ["ACCEPTED", "PAUSED_AUTH"]);
      assert.equal((await db.domainWorkItem.findUnique({ where: { id: s.item.id } })).state, "DONE");
    });
    await check("bulk required-audit failure leaves original price, cursor and live claim", async () => {
      const s = await queuedBulk(); hook = rejectAudit;
      try { await assert.rejects(processItem(s), /I4_REQUIRED_AUDIT_FAILURE/); } finally { hook = null; }
      assert.equal((await db.creatorBillingProfile.findUnique({ where: { creatorId: s.creator.id } })).pricingRevision, 1);
      assert.equal((await db.adminCommand.findUnique({ where: { id: s.item.objectId } })).executionProgress.nextIndex, 0);
      assert.equal((await db.domainWorkItem.findUnique({ where: { id: s.item.id } })).state, "CLAIMED");
    });
    await check("support read rejects a grant expiring while its bounded page is fetched", async () => {
      const s = await seed();
      const opened = await support.openAdminSupport({ db: proxy, actor: s.actor, commandId: crypto.randomUUID(), payload: { agencyId: s.agency.id, durationMinutes: 5, reason: "Proof support" } });
      const grantId = opened.body.grant.id;
      const page = await support.readAdminSupport({ db: proxy, actor: s.actor, grantId });
      assert.deepEqual(page.creators.map(c => c.id), [s.creator.id]);
      hook = async ({ key, method }) => { if (key === "creatorAccount" && method === "findMany") offsetMs = 360000; };
      try { await assert.rejects(support.readAdminSupport({ db: proxy, actor: s.actor, grantId }), { code: "SUPPORT_GRANT_EXPIRED" }); } finally { hook = null; offsetMs = 0; }
    });
    for (const boundary of ["lease-lock", "start-audit"]) await check(`retention expiry after ${boundary} cancels without a running lease or PASS_STARTED receipt`, async () => {
      const s = await queuedRetention();
      await db.adminSession.update({ where: { id: s.session.id }, data: { expiresAt: new Date(Date.now() + 60000) } });
      hook = async ({ key, args }) => {
        if ((boundary === "lease-lock" && key === "$queryRawUnsafe" && args[0].includes('FROM "RetentionSweepLease"')) ||
            (boundary === "start-audit" && key === "adminCommandAudit" && args[0].data.event === "PASS_STARTED")) offsetMs = 90000;
      };
      try { assert.equal((await adminRetention.claimAdminRetentionRun({ db: proxy, row: s.row })).reason, "admin_authority_changed"); } finally { hook = null; offsetMs = 0; }
      assert.equal(await db.retentionSweepLease.count({}), 0);
      assert.equal((await db.adminCommand.findUnique({ where: { id: s.row.id } })).status, "CANCELLED");
      assert.deepEqual((await db.adminCommandAudit.findMany({ where: { commandId: s.row.id }, orderBy: { sequence: "asc" } })).map(a => a.event), ["ACCEPTED", "CANCELLED"]);
    });
    await check("retention claim conflict retries from immutable identity with one start receipt", async () => {
      const s = await queuedRetention(); fault = "40001"; const before = attempts;
      const claim = await adminRetention.claimAdminRetentionRun({ db: proxy, row: s.row });
      assert.equal(attempts - before, 2); assert.ok(claim.lease.acquired); assert.equal(claim.row.executionProgress.attempts, 1);
      assert.equal(await db.adminCommandAudit.count({ where: { commandId: s.row.id, event: "PASS_STARTED" } }), 1);
      await retention.finalizeRetentionSweepLease({ db: proxy, ownerToken: claim.lease.ownerToken, outcome: "COMPLETE", onFinalize: tx => tx.adminCommand.update({ where: { id: s.row.id }, data: { status: "SUCCEEDED" } }) });
    });
    await check("revoked initiating session can settle a failed Admin pass with an atomic required receipt", async () => {
      const s = await queuedRetention();
      const result = await adminRetention.runAdminRetentionSweep({ db: proxy, run: async options => {
        await db.adminSession.update({ where: { id: s.session.id }, data: { revokedAt: new Date() } });
        return retention.finalizeRetentionSweepLease({ db: proxy, ownerToken: options.claimedLease.ownerToken, outcome: "PARTIAL",
          onFinalize: (tx, now) => options.onFinalize(tx, now, { ok: false, laneErrors: [{ code: "ADMIN_AUTH_INVALID" }] }, null) });
      } });
      assert.equal(result, true);
      assert.equal((await db.adminCommand.findUnique({ where: { id: s.row.id } })).status, "FAILED");
      assert.equal(await db.adminCommandAudit.count({ where: { commandId: s.row.id, event: "FAILED" } }), 1);
      assert.ok((await db.retentionSweepLease.findUnique({ where: { key: "global_retention_v1" } })).completedAt);
    });
    for (const cause of ["session", "lease"]) await check(`retention ${cause} expiry after SQL deletion rolls back the batch`, async () => {
      const s = await seed(); await db.retentionSweepLease.deleteMany({});
      const lease = await retention.claimRetentionSweepLease({ db: proxy, leaseMs: cause === "lease" ? 60000 : 7200000 });
      await db.adminSession.update({ where: { id: s.session.id }, data: { expiresAt: new Date(Date.now() + (cause === "session" ? 60000 : 86400000)) } });
      const key = "i4-retention-" + seq; await db.systemSetting.create({ data: { key, value: { keep: true } } });
      const actorGuard = tx => sessions.lockAdminActor(tx, s.actor);
      try {
        await assert.rejects(retentionWork.withRetentionWork(lease.ownerToken, () => retentionWork.runRetentionMutation(async tx => {
          await tx.systemSetting.delete({ where: { key } }); offsetMs = 90000;
        }, proxy), actorGuard), { code: cause === "session" ? "ADMIN_AUTH_INVALID" : "RETENTION_LEASE_LOST" });
      } finally { offsetMs = 0; }
      assert.ok(await db.systemSetting.findUnique({ where: { key } }));
    });
    await check("retention final audit failure rolls back lease release; retry settles atomically", async () => {
      await db.retentionSweepLease.deleteMany({});
      const lease = await retention.claimRetentionSweepLease({ db: proxy });
      await assert.rejects(retention.finalizeRetentionSweepLease({ db: proxy, ownerToken: lease.ownerToken, outcome: "COMPLETE", onFinalize: async tx => { await tx.$executeRawUnsafe("DO $$ BEGIN RAISE EXCEPTION 'I4_FINAL_AUDIT_FAILURE'; END $$"); } }), /I4_FINAL_AUDIT_FAILURE/);
      assert.equal((await db.retentionSweepLease.findUnique({ where: { key: "global_retention_v1" } })).completedAt, null);
      fault = "40P01"; const before = attempts;
      assert.equal(await retention.finalizeRetentionSweepLease({ db: proxy, ownerToken: lease.ownerToken, outcome: "COMPLETE" }), true);
      assert.equal(attempts - before, 2);
    });
    await check("diagnostics raw conflict replays one bounded page without doubling counts", async () => {
      await db.systemSetting.deleteMany({ where: { key: diagnosticsKey } });
      fault = "40001"; const before = attempts;
      const result = await diagnosticsStep({ db: proxy }); assert.equal(attempts - before, 2);
      const state = (await db.systemSetting.findUnique({ where: { key: diagnosticsKey } })).value;
      assert.equal(state.run.scanned, result.processed); assert.equal(state.run.lane, 1);
    });
    await check("archive expiry after aggregate write rolls back source deletion and aggregate; retry contributes once", async () => {
      const s = await seed(), at = new Date("2025-01-01T00:00:00Z"), olderThan = new Date("2025-02-01T00:00:00Z");
      const row = await db.automationDelivery.create({ data: { agencyId: s.agency.id, creatorId: s.creator.id, moduleKey: "bumps", actionType: "SEND_MESSAGE", status: "COMPLETED", originKind: "AUTOMATION", finishedAt: at, createdAt: at } });
      await db.adminSession.update({ where: { id: s.session.id }, data: { expiresAt: new Date(Date.now() + 60000) } });
      const commitGuard = tx => sessions.lockAdminActor(tx, s.actor);
      hook = async ({ key, args }) => { if (key === "$queryRawUnsafe" && args[0].includes('INSERT INTO "AutomationMonthlyAggregate"')) offsetMs = 90000; };
      try { await assert.rejects(compactAutomationDeliveries({ db: proxy, olderThan, commitGuard }), { code: "ADMIN_AUTH_INVALID" }); assert.equal(offsetMs, 90000); } finally { hook = null; offsetMs = 0; }
      assert.ok(await db.automationDelivery.findUnique({ where: { id: row.id } }));
      assert.equal(await db.automationMonthlyAggregate.count({ where: { creatorId: s.creator.id } }), 0);
      fault = "40001"; const before = attempts;
      assert.equal((await compactAutomationDeliveries({ db: proxy, olderThan, commitGuard })).archived, 1); assert.equal(attempts - before, 2);
      assert.equal((await db.automationMonthlyAggregate.findFirst({ where: { creatorId: s.creator.id } })).total, 1);
    });
    const report = { ok: true, engine: "PGlite PostgreSQL WASM + TCP + Prisma 5.22", migrations: fs.readdirSync(path.join(root, "prisma/migrations")).filter(name => fs.existsSync(path.join(root, "prisma/migrations", name, "migration.sql"))).length, cases: cases.length,
      limits: ["Single physical SQL connection; no native PostgreSQL contention or multi-replica load proof", "Clock advancement is injected at production query boundaries; not an OS clock or live wait", "No production database, Render restart, historical notification backfill or Desktop LocalAI validation"], results: cases };
    const output = process.env.PHASE5_PROOF_OUTPUT;
    if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report));
  } finally { await db.$disconnect(); await server.stop(); await engine.close(); }
}
const watchdog = setTimeout(() => { console.error("I4_PROOF_DEADLINE_EXCEEDED"); process.exit(1); }, 180000);
main().then(() => clearTimeout(watchdog), error => { clearTimeout(watchdog); console.error(error); process.exitCode = 1; });

"use strict";
// Real production services + Prisma + a disposable SQL engine. Clock and
// transport faults are controlled; this is not native concurrency/load proof.
const assert = require("node:assert/strict"), fs = require("node:fs"), crypto = require("node:crypto");
const { createAdminSqlRuntime } = require("../test-support/admin-sql-runtime.cjs");
async function main() {
  const fixture = await createAdminSqlRuntime({ runtimePath: process.env.ADMIN_PROOF_RUNTIME });
  const { db, queries } = fixture;
  const cases = [], plans = {};
  const check = async (name, run) => { await run(); cases.push({ name, status: "PASS" }); console.log(JSON.stringify(cases.at(-1))); };
  let hook = null, offsetMs = 0, conflict = null, afterRollback = null, loseReply = false, attempts = 0;
  const proxy = new Proxy(db, { get(target, key) {
    if (key === "$transaction") return async (run, options) => {
      let result;
      try {
        result = await db.$transaction(async tx => {
          attempts++;
          const wrapped = new Proxy(tx, { get(client, name) {
            const value = client[name];
            if (typeof value === "function") return async (...args) => {
              const result = await value.apply(client, args);
              if (hook) await hook({ tx, key: name, args, result });
              if (name === "$queryRawUnsafe" && args[0].includes("clock_timestamp") && result[0]?.authorityNow && offsetMs) result[0].authorityNow = new Date(result[0].authorityNow.getTime() + offsetMs);
              return result;
            };
            if (value && typeof value === "object") return new Proxy(value, { get(model, method) {
              const fn = model[method]; if (typeof fn !== "function") return fn;
              return async (...args) => { const result = await fn.apply(model, args); if (hook) await hook({ tx, key: name, method, args, result }); return result; };
            } });
            return value;
          } });
          const result = await run(wrapped);
          if (conflict) { const code = conflict; conflict = null; assert.ok(["40001", "40P01"].includes(code)); await tx.$executeRawUnsafe(`DO $$ BEGIN RAISE EXCEPTION USING ERRCODE='${code}', MESSAGE='R5_CONTROLLED_CONFLICT'; END $$`); }
          return result;
        }, options);
      } catch (error) { if (afterRollback) { const fn = afterRollback; afterRollback = null; await fn(); } throw error; }
      if (loseReply) { loseReply = false; throw Object.assign(Error("Commit acknowledgement lost"), { code: "R5_CONNECTION_REPLY_LOST" }); }
      return result;
    };
    const value = target[key]; return typeof value === "function" ? value.bind(target) : value;
  } });
  require.cache[require.resolve("../../src/prisma")] = { exports: proxy };
  const pricing = require("../../src/services/admin-pricing-command-service");
  const commands = require("../../src/services/admin-commit-authority-service");
  const sessions = require("../../src/services/admin-session-authority-service");
  const identity = require("../../src/services/admin-identity-command-service");
  const bulk = require("../../src/services/admin-bulk-pricing-command-service");
  const support = require("../../src/services/admin-support-command-service");
  const retention = require("../../src/services/retention-service");
  const retentionWork = require("../../src/services/retention-work-context-service");
  const { deferCommitHint } = require("../../src/services/db-commit-kernel");
  const password = "r5-proof-password", passwordHash = await require("bcryptjs").hash(password, 4);
  let sequence = 0;
  async function seed() {
    return db.$transaction(async tx => {
      const label = `r5-${++sequence}`;
      await tx.$executeRawUnsafe("SELECT set_config('onlinod.phase2_team_control_plane_generation',$1,true)", "phase2_team_control_plane_v2_durable_access");
      const user = await tx.user.create({ data: { email: label + "@example.test", passwordHash: "fixture" } });
      const agency = await tx.agency.create({ data: { name: label, trialEndsAt: new Date(Date.now() + 86400000) } });
      await tx.agencyMember.create({ data: { agencyId: agency.id, userId: user.id, role: "OWNER", roleKey: "owner", assignedCreators: "all" } });
      const creator = await tx.creatorAccount.create({ data: { agencyId: agency.id, displayName: label, status: "READY" } });
      await tx.$executeRawUnsafe("SELECT set_config('onlinod.commercial_pricing_writer','v1',true)");
      await tx.creatorBillingProfile.create({ data: { agencyId: agency.id, creatorId: creator.id } });
      const admin = await tx.adminUser.create({ data: { email: label + "-admin@example.test", passwordHash } });
      const session = await tx.adminSession.create({ data: { adminUserId: admin.id, tokenHash: crypto.randomUUID(), issuedAccessEpoch: admin.accessEpoch, expiresAt: new Date(Date.now() + 86400000) } });
      return { user, agency, creator, admin, session, actor: { adminId: admin.id, sessionId: session.id, accessEpoch: admin.accessEpoch } };
    });
  }
  const payload = { expectedRevision: 1, corePriceCents: 7300, reason: "R5 finalization proof" };
  const price = (s, commandId = crypto.randomUUID(), database = proxy) => pricing.setAdminPricing({ db: database, actor: s.actor, commandId, creatorId: s.creator.id, payload });
  async function requireDenial(s) {
    const profile = await db.creatorBillingProfile.findUnique({ where: { creatorId: s.creator.id } });
    assert.equal(profile.pricingRevision, 1);
    const row = await db.adminCommand.findFirst({ where: { actorId: s.admin.id } });
    assert.equal(row.status, "REJECTED"); assert.equal(row.result.code, "ADMIN_AUTH_INVALID");
    assert.deepEqual((await db.adminCommandAudit.findMany({ where: { commandId: row.id } })).map(a => a.event), ["REJECTED"]);
    return row;
  }
  try {
    await db.$executeRawUnsafe(`UPDATE "Phase2ReleaseCompatibilityAuthority" SET "activationState"='ACTIVE' WHERE "scope"='TEAM_CONTROL_PLANE'`);
    await db.$executeRawUnsafe(`UPDATE "Phase2ReleaseCompatibilityAuthority" SET "requiredGeneration"='phase3_domain_executor_v6_failure_policy',"activationState"='ACTIVE' WHERE "scope"='DOMAIN_WORK_EXECUTOR'`);
    for (const boundary of ["audit", "receipt", "completion-clock"]) await check(`SQL expiry after ${boundary} rolls back mutation plus success audit and keeps one denial`, async () => {
      const s = await seed(); let audited = false, armed = true;
      hook = async ({ key, args }) => {
        if (key === "adminCommandAudit" && args[0].data.event === "COMMITTED") audited = true;
        if (armed && ((boundary === "audit" && audited) || (boundary === "receipt" && key === "adminCommand" && args[0].data?.status === "SUCCEEDED") || (boundary === "completion-clock" && audited && key === "$queryRawUnsafe" && args[0].includes("clock_timestamp")))) { offsetMs = 172800000; armed = false; }
      };
      let result; try { result = await price(s); } finally { hook = null; offsetMs = 0; }
      assert.equal(result.statusCode, 401); assert.equal(armed, false); await requireDenial(s);
      assert.equal((await price(s, result.commandId)).replayed, true);
    });
    for (const boundary of ["audit", "receipt"]) await check(`SQL queued ${boundary} expiry removes the durable work publication`, async () => {
      const s = await seed();
      hook = async ({ key, args }) => { if ((boundary === "audit" && key === "adminCommandAudit" && args[0].data.event === "ACCEPTED") || (boundary === "receipt" && key === "adminCommand" && args[0].data?.status === "QUEUED")) offsetMs = 172800000; };
      let result; try { result = await bulk.submitAdminBulkPricing({ db: proxy, actor: s.actor, commandId: crypto.randomUUID(), agencyId: s.agency.id, payload: { tier: "PRO", reason: "Queue proof", items: [{ creatorId: s.creator.id, expectedRevision: 1 }] } }); } finally { hook = null; offsetMs = 0; }
      assert.equal(result.statusCode, 401); const row = await requireDenial(s);
      assert.equal(row.executionPayload, null); assert.equal(row.executionProgress, null);
      assert.equal(await db.domainWorkItem.count({ where: { objectType: "AdminCommand", objectId: row.id } }), 0);
    });
    await check("SQL success has no awaited domain/audit/receipt write after its final clock decision", async () => {
      const s = await seed(); queries.length = 0;
      assert.equal((await price(s)).statusCode, 200);
      const statements = queries.map(q => q.query);
      assert.equal(statements.at(-1), "COMMIT"); assert.match(statements.at(-2), /SELECT clock_timestamp/);
      assert.equal((await db.creatorBillingProfile.findUnique({ where: { creatorId: s.creator.id } })).pricingRevision, 2);
    });
    for (const code of ["40001", "40P01"]) await check(`SQL ${code} retry commits exactly one price, audit and receipt`, async () => {
      const s = await seed(), before = attempts; conflict = code;
      assert.equal((await price(s)).statusCode, 200); assert.equal(attempts - before, 2);
      assert.equal((await db.creatorBillingProfile.findUnique({ where: { creatorId: s.creator.id } })).pricingRevision, 2);
      assert.equal(await db.adminCommandAudit.count({ where: { actorId: s.admin.id } }), 1);
    });
    await check("revocation between failed root and retry is reread before any new mutation", async () => {
      const s = await seed(); conflict = "40001";
      afterRollback = () => db.adminSession.update({ where: { id: s.session.id }, data: { revokedAt: new Date() } });
      await assert.rejects(price(s), { code: "ADMIN_AUTH_INVALID" });
      assert.equal(await db.adminCommand.count({ where: { actorId: s.admin.id } }), 0);
      assert.equal((await db.creatorBillingProfile.findUnique({ where: { creatorId: s.creator.id } })).pricingRevision, 1);
    });
    await check("lost commit acknowledgement is reconciled by the same UUID after reconnect without reapplying", async () => {
      const s = await seed(), commandId = crypto.randomUUID(), before = attempts; loseReply = true;
      await assert.rejects(price(s, commandId), { code: "R5_CONNECTION_REPLY_LOST" }); assert.equal(attempts - before, 1);
      await db.$disconnect(); await db.$connect();
      const read = await commands.readAdminCommand({ db: proxy, actor: s.actor, commandId }); assert.equal(read.status, "SUCCEEDED");
      assert.equal((await price(s, commandId)).replayed, true);
      assert.equal((await db.creatorBillingProfile.findUnique({ where: { creatorId: s.creator.id } })).pricingRevision, 2);
      assert.equal(await db.adminCommandAudit.count({ where: { actorId: s.admin.id } }), 1);
    });
    await check("SQL returned rejection rolls back partial target changes and notification hints", async () => {
      const s = await seed(); let hints = 0;
      const result = await commands.executeAdminCommand({ db: proxy, actor: s.actor, commandId: crypto.randomUUID(), action: "billing.pricing.set", targetId: s.creator.id, payload,
        work: async ({ tx, commitContext }) => { await tx.agency.update({ where: { id: s.agency.id }, data: { name: "must-roll-back" } }); deferCommitHint(commitContext, "denied", () => { hints++; }); return { statusCode: 409, body: { ok: false, code: "DECLINED" } }; },
      });
      assert.equal(result.statusCode, 409); assert.equal(hints, 0);
      assert.equal((await db.agency.findUnique({ where: { id: s.agency.id } })).name, s.agency.name);
    });
    await check("required SQL audit failure after insertion rolls back all command effects", async () => {
      const s = await seed();
      hook = async ({ tx, key }) => { if (key === "adminCommandAudit") await tx.$executeRawUnsafe("DO $$ BEGIN RAISE EXCEPTION 'R5_REQUIRED_AUDIT_FAILURE'; END $$"); };
      try { await assert.rejects(price(s), /R5_REQUIRED_AUDIT_FAILURE/); } finally { hook = null; }
      assert.equal(await db.adminCommand.count({ where: { actorId: s.admin.id } }), 0);
      assert.equal(await db.adminCommandAudit.count({ where: { actorId: s.admin.id } }), 0);
      assert.equal((await db.creatorBillingProfile.findUnique({ where: { creatorId: s.creator.id } })).pricingRevision, 1);
    });
    await check("late self-password expiry reverses the real epoch trigger and session revocation", async () => {
      const s = await seed();
      hook = async ({ key }) => { if (key === "adminCommandAudit") offsetMs = 172800000; };
      let result; try { result = await identity.resetAdminPassword({ db: proxy, actor: s.actor, commandId: crypto.randomUUID(), targetId: s.admin.id, payload: { password: "new-r5-password", expectedEpoch: 1, reason: "Self rotation" } }); } finally { hook = null; offsetMs = 0; }
      assert.equal(result.statusCode, 401);
      const admin = await db.adminUser.findUnique({ where: { id: s.admin.id } }); assert.equal(admin.accessEpoch, 1); assert.equal(admin.passwordHash, passwordHash);
      assert.equal((await db.adminSession.findUnique({ where: { id: s.session.id } })).revokedAt, null);
    });
    await check("authorized self-demotion completes and requires a new login for subsequent commands", async () => {
      const s = await seed();
      const result = await identity.patchAdminIdentity({ db: proxy, actor: s.actor, commandId: crypto.randomUUID(), targetId: s.admin.id, payload: { role: "SUPPORT", expectedEpoch: 1, reason: "Transfer responsibility" } });
      assert.equal(result.statusCode, 200); assert.equal(result.body.admin.accessEpoch, 2);
      await assert.rejects(commands.readAdminCommand({ db: proxy, actor: s.actor, commandId: result.commandId }), { code: "ADMIN_AUTH_INVALID" });
      const login = await sessions.loginAdmin({ db: proxy, email: s.admin.email, password });
      const session = await db.adminSession.findUnique({ where: { tokenHash: sessions.sha256(login.token) } });
      const actor = { adminId: s.admin.id, sessionId: session.id, accessEpoch: 2 };
      assert.equal((await commands.readAdminCommand({ db: proxy, actor, commandId: result.commandId })).status, "SUCCEEDED");
    });
    await check("support grant creation expiring in the command audit leaves no usable grant", async () => {
      const s = await seed(); hook = async ({ key }) => { if (key === "adminCommandAudit") offsetMs = 172800000; };
      let result; try { result = await support.openAdminSupport({ db: proxy, actor: s.actor, commandId: crypto.randomUUID(), payload: { agencyId: s.agency.id, reason: "Support case" } }); } finally { hook = null; offsetMs = 0; }
      assert.equal(result.statusCode, 401); assert.equal(await db.adminSupportGrant.count({ where: { actorId: s.admin.id } }), 0);
    });
    await check("late login audit cannot issue an already-expired session", async () => {
      const s = await seed(); hook = async ({ key }) => { if (key === "adminActionLog") offsetMs = 60 * 86400000; };
      try { await assert.rejects(sessions.loginAdmin({ db: proxy, email: s.admin.email, password }), { code: "ADMIN_AUTH_INVALID" }); } finally { hook = null; offsetMs = 0; }
      assert.equal(await db.adminSession.count({ where: { adminUserId: s.admin.id } }), 1);
      assert.equal((await db.adminUser.findUnique({ where: { id: s.admin.id } })).lastLoginAt, null);
    });
    await check("read-result authority rejects revocation and epoch changes on actual stored rows", async () => {
      const s = await seed(); await sessions.authorizeAdminReadResult({ db: proxy, actor: s.actor });
      await sessions.logoutAdmin({ db: proxy, actor: s.actor });
      await assert.rejects(sessions.authorizeAdminReadResult({ db: proxy, actor: s.actor }), { code: "ADMIN_AUTH_INVALID" });
      const other = await seed(); await db.adminUser.update({ where: { id: other.admin.id }, data: { role: "SUPPORT" } });
      await assert.rejects(sessions.authorizeAdminReadResult({ db: proxy, actor: other.actor }), { code: "ADMIN_AUTH_GENERATION_CHANGED" });
    });
    await check("retention final lease wait cannot outlive its administrative session", async () => {
      const s = await seed(), key = "r5-retention-wait";
      await db.retentionSweepLease.deleteMany({});
      const lease = await retention.claimRetentionSweepLease({ db: proxy, leaseMs: 4 * 86400000 });
      assert.equal(lease.acquired, true);
      await db.systemSetting.create({ data: { key, value: { keep: true } } });
      let mutated = false;
      hook = async ({ key: model, args }) => {
        if (mutated && model === "$queryRawUnsafe" && args[0].includes('FROM "RetentionSweepLease"')) offsetMs = 2 * 86400000;
      };
      try {
        await assert.rejects(retentionWork.withRetentionWork(lease.ownerToken, () => retentionWork.runRetentionMutation(async tx => {
          await tx.systemSetting.delete({ where: { key } }); mutated = true;
        }, proxy), tx => sessions.lockAdminActor(tx, s.actor)), { code: "ADMIN_AUTH_INVALID" });
        assert.equal(offsetMs, 2 * 86400000);
      } finally { hook = null; offsetMs = 0; }
      assert.ok(await db.systemSetting.findUnique({ where: { key } }));
    });
    await check("another admin cannot read a command receipt by UUID", async () => {
      const s = await seed(), other = await seed(), result = await price(s);
      await assert.rejects(commands.readAdminCommand({ db: proxy, actor: other.actor, commandId: result.commandId }), { code: "ADMIN_COMMAND_NOT_FOUND" });
    });
    await check("command receipt lookup stays indexed with 200000 unrelated receipts", async () => {
      const s = await seed(), result = await price(s);
      await db.$executeRawUnsafe(`INSERT INTO "AdminCommand"("id","commandId","actorId","sessionId","actorAccessEpoch","action","targetId","payloadHash","reason","status","httpStatus","result","createdAt","completedAt")
        SELECT 'r5-history-'||g,'r5-command-'||g,'r5-history-actor-'||(g%1000),'historical-session',1,'billing.pricing.set','historical-target',repeat('a',64),'synthetic SQL history','SUCCEEDED',200,'{}'::jsonb,now(),now() FROM generate_series(1,200000) g`);
      await db.$executeRawUnsafe('ANALYZE "AdminCommand"');
      const raw = await db.$queryRawUnsafe('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT * FROM "AdminCommand" WHERE "actorId"=$1 AND "commandId"=$2', s.admin.id, result.commandId);
      plans.receipt = raw;
      const planText = JSON.stringify(raw); assert.match(planText, /Index Scan|Index Only Scan/); assert.doesNotMatch(planText, /Seq Scan/);
      assert.equal((await commands.readAdminCommand({ db: proxy, actor: s.actor, commandId: result.commandId })).status, "SUCCEEDED");
    });
    const report = { ok: true, cases: cases.length, migrations: fixture.migrations.length, excludedContract: fixture.excludedContract,
      engine: "PGlite single connection / real Prisma 5.22 services", results: cases, plans,
      limits: ["Not native PostgreSQL16 multi-session lock/SSI testing", "Controlled clock and reply faults, not real provider/Render/Windows runs", "200000 synthetic receipts demonstrate an index plan, not agency/creator/worker production capacity"],
    };
    if (process.env.ADMIN_PROOF_OUTPUT) fs.writeFileSync(process.env.ADMIN_PROOF_OUTPUT, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ ok: true, cases: cases.length, migrations: fixture.migrations.length }));
  } finally { hook = null; await fixture.close(); }
}
const watchdog = setTimeout(() => { console.error("ADMIN_AUTHORITY_PROOF_DEADLINE_EXCEEDED"); process.exit(1); }, 180000);
main().then(() => clearTimeout(watchdog), error => { clearTimeout(watchdog); console.error(error); process.exitCode = 1; });

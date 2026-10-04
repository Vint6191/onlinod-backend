"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { createMemoryDb } = require("../../scripts/test-support/admin-command-memory-db");
const { executeAdminCommand, readAdminCommand } = require("./admin-commit-authority-service");
const { setAdminPricing } = require("./admin-pricing-command-service");
const { submitAdminBulkPricing } = require("./admin-bulk-pricing-command-service");
const { patchAdminIdentity, resetAdminPassword } = require("./admin-identity-command-service");
const { lockAdminActor, loginAdmin } = require("./admin-session-authority-service");
const { deferCommitHint, runRootCommit } = require("./db-commit-kernel");
const actor = { adminId: "admin-a", sessionId: "session-a", accessEpoch: 1 };
const price = { expectedRevision: 1, reason: "Final authority proof", corePriceCents: 7300 };

function expiringDb(boundary) {
  let armed = true, successAudit = false;
  const m = createMemoryDb({ extendClient(api, { clock }) {
    const expire = () => { if (armed) { armed = false; clock.setTime(clock.getTime() + 1000); } };
    const audit = api.adminCommandAudit.create;
    api.adminCommandAudit.create = async input => {
      const row = await audit(input);
      if (["COMMITTED", "ACCEPTED"].includes(input.data.event)) {
        successAudit = true;
        if (boundary === "audit") expire();
      }
      return row;
    };
    const update = api.adminCommand.update;
    api.adminCommand.update = async input => {
      const row = await update(input);
      if (boundary === "receipt" && ["SUCCEEDED", "QUEUED"].includes(input.data.status)) expire();
      return row;
    };
    const query = api.$queryRawUnsafe;
    api.$queryRawUnsafe = async (...args) => {
      const rows = await query(...args);
      if (boundary === "completion-clock" && successAudit && args[0].includes("clock_timestamp")) expire();
      return rows;
    };
    return api;
  } });
  m.state.sessions[0].expiresAt = new Date(m.clock.getTime() + 1000);
  return { m, expired: () => !armed };
}

for (const boundary of ["audit", "receipt", "completion-clock"]) test(`expiry at ${boundary} rolls back pricing, success audit and receipt together`, async () => {
  const { m, expired } = expiringDb(boundary), commandId = randomUUID();
  const result = await setAdminPricing({ db: m.db, actor, commandId, creatorId: "creator-a", payload: price });
  assert.equal(expired(), true);
  assert.equal(result.statusCode, 401);
  assert.equal(result.body.code, "ADMIN_AUTH_INVALID");
  assert.equal(m.state.profiles[0].corePriceCents, 2000);
  assert.equal(m.state.profiles[0].pricingRevision, 1);
  assert.deepEqual(m.state.audit.map(row => row.event), ["REJECTED"]);
  assert.equal(m.state.commands[0].status, "REJECTED");
  assert.equal(m.state.commands[0].result.ok, false);
  const freshActor = { ...actor, sessionId: "session-new" };
  m.state.sessions.push({ ...m.state.sessions[0], id: freshActor.sessionId, expiresAt: new Date(m.clock.getTime() + 60000) });
  const replay = await setAdminPricing({ db: m.db, actor: freshActor, commandId, creatorId: "creator-a", payload: price });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.body, result.body);
  assert.equal((await readAdminCommand({ db: m.db, actor: freshActor, commandId })).status, "REJECTED");
  assert.equal(m.state.audit.length, 1);
});

for (const boundary of ["audit", "receipt"]) test(`expiry at queued ${boundary} removes published work and its acceptance`, async () => {
  const { m } = expiringDb(boundary);
  const result = await submitAdminBulkPricing({ db: m.db, actor, commandId: randomUUID(), agencyId: "agency-a", payload: {
    reason: "Queued cutover", tier: "PRO", items: [{ creatorId: "creator-a", expectedRevision: 1 }],
  } });
  assert.equal(result.statusCode, 401);
  assert.equal(m.state.workItems.length, 0);
  assert.equal(m.state.commands[0].executionPayload, undefined);
  assert.equal(m.state.commands[0].executionProgress, undefined);
  assert.deepEqual(m.state.audit.map(row => row.event), ["REJECTED"]);
});

for (const returned of [false, true]) test(`${returned ? "returned" : "thrown"} domain rejection cannot retain partial writes or post-commit hints`, async () => {
  const m = createMemoryDb(); let hints = 0;
  const result = await executeAdminCommand({ db: m.db, actor, commandId: randomUUID(), action: "billing.pricing.set", targetId: "creator-a", payload: price,
    work: async ({ tx, commitContext }) => {
      await tx.creatorBillingProfile.update({ where: { creatorId: "creator-a" }, data: { corePriceCents: 9100 } });
      deferCommitHint(commitContext, "must-not-publish", () => { hints++; });
      if (returned) return { statusCode: 409, body: { ok: false, code: "DECLINED" } };
      throw Object.assign(Error("Declined"), { status: 409, code: "DECLINED" });
    },
  });
  assert.equal(result.statusCode, 409);
  assert.equal(m.state.profiles[0].corePriceCents, 2000);
  assert.equal(hints, 0);
  assert.deepEqual(m.state.audit.map(row => row.event), ["REJECTED"]);
});

test("expiry after success audit discards a deferred effect", async () => {
  const { m } = expiringDb("audit"); let hints = 0;
  await executeAdminCommand({ db: m.db, actor, commandId: randomUUID(), action: "billing.pricing.set", targetId: "creator-a", payload: price,
    work: async ({ commitContext }) => { deferCommitHint(commitContext, "not-authorized", () => { hints++; }); return { body: { ok: true } }; },
  });
  assert.equal(hints, 0);
});

for (const code of ["40001", "40P01"]) test(`late ${code} retries one whole administrative command with one effect`, async () => {
  const m = createMemoryDb(); let attempts = 0;
  const db = { $transaction: (work, options) => m.db.$transaction(async tx => {
    const result = await work(tx);
    if (++attempts === 1) throw Object.assign(Error("Controlled conflict"), { code: "P2010", meta: { code } });
    return result;
  }, options) };
  const result = await setAdminPricing({ db, actor, commandId: randomUUID(), creatorId: "creator-a", payload: price });
  assert.equal(result.statusCode, 200); assert.equal(attempts, 2);
  assert.equal(m.state.profiles[0].pricingRevision, 2);
  assert.equal(m.state.audit.length, 1); assert.equal(m.state.commands.length, 1);
});

test("failure to persist a late denial rolls back the complete root", async () => {
  const m = createMemoryDb({ extendClient(api, { clock }) {
    const create = api.adminCommandAudit.create;
    api.adminCommandAudit.create = async input => {
      if (input.data.event === "REJECTED") throw Error("Required rejection audit unavailable");
      const result = await create(input); clock.setUTCFullYear(2030); return result;
    };
    return api;
  } });
  await assert.rejects(setAdminPricing({ db: m.db, actor, commandId: randomUUID(), creatorId: "creator-a", payload: price }), /Required rejection audit/);
  assert.equal(m.state.profiles[0].pricingRevision, 1);
  assert.equal(m.state.commands.length, 0); assert.equal(m.state.audit.length, 0);
});

test("receipt storage failure is not misclassified as a domain rejection", async () => {
  const m = createMemoryDb({ extendClient(api) {
    api.adminCommandAudit.create = async () => { throw Object.assign(Error("Audit denied"), { status: 403, code: "AUDIT_DENIED" }); };
    return api;
  } });
  await assert.rejects(setAdminPricing({ db: m.db, actor, commandId: randomUUID(), creatorId: "creator-a", payload: price }), { code: "AUDIT_DENIED" });
  assert.equal(m.state.profiles[0].pricingRevision, 1); assert.equal(m.state.commands.length, 0);
});

test("authorized self-demotion commits once and invalidates every later old-session command", async () => {
  const m = createMemoryDb();
  m.state.admins.push({ ...m.state.admins[0], id: "admin-b", email: "b@example.test" });
  const result = await patchAdminIdentity({ db: m.db, actor, commandId: randomUUID(), targetId: actor.adminId, payload: { role: "SUPPORT", expectedEpoch: 1, reason: "Transfer platform responsibility" } });
  assert.equal(result.statusCode, 200); assert.equal(m.state.admins[0].role, "SUPPORT");
  assert.ok(m.state.sessions[0].revokedAt);
  await assert.rejects(setAdminPricing({ db: m.db, actor, commandId: randomUUID(), creatorId: "creator-a", payload: price }), { code: "ADMIN_AUTH_INVALID" });
});

test("expired self-password rotation rolls back the epoch and its own session revocation", async () => {
  const { m } = expiringDb("receipt");
  const result = await resetAdminPassword({ db: m.db, actor, commandId: randomUUID(), targetId: actor.adminId, payload: { password: "new-proof-password", expectedEpoch: 1, reason: "Rotate own credentials" } });
  assert.equal(result.statusCode, 401);
  assert.equal(m.state.admins[0].passwordHash, "old-hash"); assert.equal(m.state.admins[0].accessEpoch, 1);
  assert.equal(m.state.sessions[0].revokedAt, null);
});

test("login cannot issue a session that expired during required audit storage", async () => {
  const m = createMemoryDb({ extendClient(api, { clock }) {
    const create = api.adminActionLog.create;
    api.adminActionLog.create = async input => { const row = await create(input); clock.setUTCFullYear(2040); return row; };
    return api;
  } });
  m.state.admins[0].passwordHash = await require("bcryptjs").hash("proof-password", 4);
  await assert.rejects(loginAdmin({ db: m.db, email: "a@example.test", password: "proof-password" }), { code: "ADMIN_AUTH_INVALID" });
  assert.equal(m.state.sessions.length, 1); assert.equal(m.state.logs.length, 0);
});

test("malformed session deadlines fail closed", async () => {
  for (const expiresAt of [null, undefined, "invalid", new Date(NaN)]) {
    const m = createMemoryDb(); m.state.sessions[0].expiresAt = expiresAt;
    await assert.rejects(runRootCommit(m.db, ({ tx }) => lockAdminActor(tx, actor)), { code: "ADMIN_AUTH_INVALID" });
  }
});

for (const boundary of ["lease-lock", "lease-clock"]) test(`retention session expiring at final ${boundary} rolls back the bounded mutation`, async () => {
  const { withRetentionWork, runRetentionMutation } = require("./retention-work-context-service");
  let armed = false, afterLeaseLock = false;
  const m = createMemoryDb({ extendClient(api, { clock }) {
    const query = api.$queryRawUnsafe;
    api.$queryRawUnsafe = async (sql, ...args) => {
      if (sql.includes('FROM "RetentionSweepLease"')) {
        afterLeaseLock = armed;
        if (armed && boundary === "lease-lock") { armed = false; clock.setTime(clock.getTime() + 2000); }
        return [{ ownerToken: "r5-pass", leaseUntil: new Date(clock.getTime() + 60000), completedAt: null }];
      }
      if (armed && afterLeaseLock && boundary === "lease-clock" && sql.includes("clock_timestamp")) {
        armed = false; clock.setTime(clock.getTime() + 2000);
      }
      return query(sql, ...args);
    };
    return api;
  } });
  m.state.sessions[0].expiresAt = new Date(m.clock.getTime() + 1000);
  await assert.rejects(withRetentionWork("r5-pass", () => runRetentionMutation(async tx => {
    await tx.agency.update({ where: { id: "agency-a" }, data: { name: "must-roll-back" } }); armed = true;
  }, m.db), tx => lockAdminActor(tx, actor)), { code: "ADMIN_AUTH_INVALID" });
  assert.equal(armed, false); assert.equal(m.state.agencies[0].name, undefined);
});

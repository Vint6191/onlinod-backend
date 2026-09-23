"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const bcrypt = require("bcryptjs");
const { createMemoryDb } = require("../../scripts/test-support/admin-command-memory-db");
const { executeAdminCommand, readAdminCommand } = require("./admin-commit-authority-service");
const { setAdminPricing } = require("./admin-pricing-command-service");
const { patchAdminIdentity, resetAdminPassword, createAdminIdentity, passwordSchema } = require("./admin-identity-command-service");
const { loginAdmin, logoutAdmin } = require("./admin-session-authority-service");
const { bootstrapAdmin } = require("./admin-operator-bootstrap-service");
const { adminError, commandRequest } = require("./admin-command-contract");

const actor = { adminId: "admin-a", sessionId: "session-a", accessEpoch: 1 };
const payload = { expectedRevision: 1, reason: "Support price correction", corePriceCents: 3210 };
const pricing = (db, input = {}) => setAdminPricing({ db, actor, commandId: randomUUID(), creatorId: "creator-a", payload, ...input });

test("same command identity replay returns one durable result and audit", async () => {
  const m = createMemoryDb(); const commandId = randomUUID();
  const results = await Promise.all([pricing(m.db, { commandId }), pricing(m.db, { commandId })]);
  assert.deepEqual(results[0].body, results[1].body);
  assert.equal(results[1].replayed, true);
  assert.equal(m.state.commands.length, 1); assert.equal(m.state.audit.length, 1);
  assert.equal(m.state.profiles[0].pricingRevision, 2);
  const status = await readAdminCommand({ db: m.db, actor, commandId });
  assert.equal(status.status, "SUCCEEDED");
});
test("same identity with a different payload conflicts without a second mutation", async () => {
  const m = createMemoryDb(); const commandId = randomUUID();
  await pricing(m.db, { commandId });
  await assert.rejects(pricing(m.db, { commandId, payload: { ...payload, corePriceCents: 7 } }), { code: "ADMIN_COMMAND_PAYLOAD_CONFLICT" });
  assert.equal(m.state.profiles[0].corePriceCents, 3210);
});
test("revoked authority cannot replay a previously successful command", async () => {
  const m = createMemoryDb(); const commandId = randomUUID();
  await pricing(m.db, { commandId }); m.state.sessions[0].revokedAt = m.clock;
  await assert.rejects(pricing(m.db, { commandId }), { code: "ADMIN_AUTH_INVALID" });
  await assert.rejects(readAdminCommand({ db: m.db, actor, commandId }), { code: "ADMIN_AUTH_INVALID" });
});
test("audit storage failure rolls back pricing and the command receipt", async () => {
  const m = createMemoryDb({ failAudit: true });
  await assert.rejects(pricing(m.db), /audit unavailable/);
  assert.equal(m.state.profiles[0].corePriceCents, 2000);
  assert.equal(m.state.commands.length, 0); assert.equal(m.state.audit.length, 0);
});
test("domain rejection rolls back partial work and retains a stable rejected receipt", async () => {
  const m = createMemoryDb(); const commandId = randomUUID(); let calls = 0;
  const command = () => executeAdminCommand({ db: m.db, actor, commandId, action: "billing.pricing.set", targetId: "creator-a", payload, work: async ({ tx }) => {
    calls++; await tx.creatorBillingProfile.update({ where: { creatorId: "creator-a" }, data: { corePriceCents: 9000 } });
    throw adminError("BUSINESS_CONFLICT", "Cannot apply change", 409);
  } });
  const first = await command(); const replay = await command();
  assert.equal(first.statusCode, 409); assert.deepEqual(first.body, replay.body);
  assert.equal(calls, 1); assert.equal(m.state.profiles[0].corePriceCents, 2000);
  assert.equal(m.state.audit[0].event, "REJECTED");
});
test("two intents with the same displayed revision cannot both overwrite pricing", async () => {
  const m = createMemoryDb();
  const result = await Promise.all([pricing(m.db), pricing(m.db, { payload: { ...payload, corePriceCents: 8000 } })]);
  assert.deepEqual(result.map(row => row.statusCode), [200, 409]);
  assert.equal(m.state.profiles[0].corePriceCents, 3210);
});
test("partial pricing updates preserve other configuration and domain revenue facts", async () => {
  const m = createMemoryDb(); m.state.profiles[0].corePriceCents = 4999;
  const result = await pricing(m.db, { payload: { expectedRevision: 1, reason: "Annotate", notes: "Reviewed" } });
  assert.equal(result.body.billing.corePriceCents, 4999);
  assert.equal(result.body.billing.revenue30dCents, 42);
  assert.equal(result.body.billing.tierMode, "AUTO");
});
test("pricing validation rejects fractional prices, fact rewrites and conflicting AUTO intent", async () => {
  for (const extra of [{ corePriceCents: 1.2 }, { corePriceCents: "1" }, { revenue30dCents: 1 }, { corePriceCents: -1 }]) {
    const m = createMemoryDb(); await assert.rejects(pricing(m.db, { payload: { ...payload, ...extra } })); assert.equal(m.state.commands.length, 0);
  }
  const m = createMemoryDb(); const result = await pricing(m.db, { payload: { ...payload, tierMode: "AUTO" } });
  assert.equal(result.statusCode, 400); assert.equal(m.state.profiles[0].tierMode, "AUTO");
});
test("unknown role, changed access epoch and database-clock expiry fail before mutation", async () => {
  for (const change of [m => { m.state.admins[0].role = ""; }, m => { m.state.admins[0].accessEpoch = 2; }, m => { m.state.sessions[0].expiresAt = m.clock; }]) {
    const m = createMemoryDb(); change(m); await assert.rejects(pricing(m.db)); assert.equal(m.state.commands.length, 0);
  }
});
test("retired agency or creator cannot receive a pricing mutation", async () => {
  for (const name of ["agencies", "creators"]) {
    const m = createMemoryDb(); m.state[name][0].deletedAt = m.clock;
    const result = await pricing(m.db); assert.ok(result.statusCode >= 400); assert.equal(m.state.profiles[0].corePriceCents, 2000);
  }
});
test("last active SUPER_ADMIN demotion is rejected without revoking their session", async () => {
  const m = createMemoryDb();
  const result = await patchAdminIdentity({ db: m.db, actor, commandId: randomUUID(), targetId: "admin-a", payload: { expectedEpoch: 1, role: "SUPPORT", reason: "Change role" } });
  assert.equal(result.body.code, "LAST_SUPER_ADMIN"); assert.equal(m.state.admins[0].role, "SUPER_ADMIN"); assert.equal(m.state.sessions[0].revokedAt, null);
});
test("password reset rotates access, revokes sessions and omits credential material", async () => {
  const m = createMemoryDb(); m.state.admins.push({ ...m.state.admins[0], id: "admin-b", email: "b@example.test" });
  m.state.sessions.push({ ...m.state.sessions[0], id: "session-b", adminUserId: "admin-b" });
  const result = await resetAdminPassword({ db: m.db, actor, commandId: randomUUID(), targetId: "admin-b", payload: { expectedEpoch: 1, password: "new-password-value", reason: "Lost device" } });
  assert.equal(result.body.admin.accessEpoch, 2); assert.ok(m.state.sessions[1].revokedAt);
  assert.equal(await bcrypt.compare("new-password-value", m.state.admins[1].passwordHash), true);
  assert.doesNotMatch(JSON.stringify([result, m.state.audit, m.state.commands]), /passwordHash|new-password-value|\$2[aby]\$/);
});
test("login rejects credentials changed between verification and transaction admission", async () => {
  const m = createMemoryDb({ beforeTransaction: state => { state.admins[0].passwordHash = "rotated"; state.admins[0].accessEpoch++; } });
  m.state.admins[0].passwordHash = await bcrypt.hash("correct-password", 4);
  await assert.rejects(loginAdmin({ db: m.db, email: "a@example.test", password: "correct-password" }), { code: "ADMIN_CREDENTIAL_GENERATION_CHANGED" });
  assert.equal(m.state.sessions.length, 1); assert.equal(m.state.logs.length, 0);
});
test("logout audit failure cannot produce an unaudited session change", async () => {
  const m = createMemoryDb({ failLog: true });
  await assert.rejects(logoutAdmin({ db: m.db, actor }), /audit unavailable/);
  assert.equal(m.state.sessions[0].revokedAt, null);
});
test("operator credential recovery joins durable receipts and revokes prior sessions", async () => {
  const m = createMemoryDb(); const args = { db: m.db, commandId: randomUUID(), operator: "ops-test", reason: "Recover access", email: "a@example.test", password: "operator-password", name: "Operator" };
  const first = await bootstrapAdmin(args); const replay = await bootstrapAdmin(args);
  assert.deepEqual(first, replay); assert.equal(m.state.admins[0].accessEpoch, 2);
  assert.ok(m.state.sessions[0].revokedAt); assert.equal(m.state.audit.length, 1);
});
test("credentials cannot be silently truncated by bcrypt and command IDs are mandatory", () => {
  assert.equal(passwordSchema.safeParse("я".repeat(37)).success, false);
  assert.throws(() => commandRequest({ headers: {} }), { status: 428 });
  assert.throws(() => commandRequest({ headers: { "idempotency-key": "arbitrary" } }), { status: 400 });
});
test("SUPPORT cannot create an admin even when its UI sends the request", async () => {
  const m = createMemoryDb(); m.state.admins[0].role = "SUPPORT";
  await assert.rejects(createAdminIdentity({ db: m.db, actor, commandId: randomUUID(), payload: { email: "new@example.test", password: "strong-enough-password", reason: "Provision account" } }), { code: "ADMIN_INSUFFICIENT_ROLE" });
  assert.equal(m.state.admins.length, 1);
});

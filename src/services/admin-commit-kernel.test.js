"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { createMemoryDb } = require("../../scripts/test-support/admin-command-memory-db");
const { executeAdminCommand } = require("./admin-commit-authority-service");
const { deferCommitHint } = require("./db-commit-kernel");
const team = require("./team-administration-service");
const actor = { adminId: "admin-a", sessionId: "session-a", accessEpoch: 1 };
const command = db => ({ db, actor, commandId: randomUUID(), action: "billing.hold.set", targetId: "agency-a", payload: { expectedRevision: 0, enabled: true, reason: "kernel proof" } });

test("platform member entry points cannot open an unaudited independent Team root", async () => {
  const db = { $transaction() { assert.fail("unowned platform transaction"); } };
  await assert.rejects(team.updateMemberAccessByPlatformAdmin({ db, agencyId: "a", memberId: "m" }), { code: "TEAM_ADMIN_COMMIT_REQUIRED" });
  await assert.rejects(team.removeMember({ db, agencyId: "a", memberId: "m", platformAdmin: true }), { code: "TEAM_ADMIN_COMMIT_REQUIRED" });
});

for (const state of ["40001", "40P01"]) test(`Admin ${state} exhaustion rolls back receipts and retains HTTP conflict contract`, async () => {
  const m = createMemoryDb();
  let attempts = 0, hints = 0;
  const db = { $transaction: (work, options) => m.db.$transaction(async tx => {
    attempts += 1;
    await work(tx);
    throw Object.assign(new Error("DB conflict"), { code: "P2010", meta: { code: state } });
  }, options) };
  await assert.rejects(executeAdminCommand({ ...command(db), work: async ({ commitContext }) => {
    deferCommitHint(commitContext, "failed", () => { hints += 1; });
    return { body: { ok: true } };
  } }), { code: "TEAM_CONTROL_PLANE_SERIALIZATION_CONFLICT", status: 409 });
  assert.equal(attempts, 3); assert.equal(hints, 0);
  assert.equal(m.state.commands.length, 0); assert.equal(m.state.audit.length, 0);
});

test("Admin terminal domain rejection drops hints but keeps one replayable rejection receipt", async () => {
  const m = createMemoryDb(), input = command(m.db);
  let hints = 0, calls = 0;
  const work = async ({ commitContext }) => {
    calls += 1;
    deferCommitHint(commitContext, "rejected", () => { hints += 1; });
    throw Object.assign(new Error("Reject domain"), { code: "DOMAIN_REJECTED", status: 409 });
  };
  const first = await executeAdminCommand({ ...input, work });
  const replay = await executeAdminCommand({ ...input, work });
  assert.equal(first.statusCode, 409); assert.equal(replay.replayed, true);
  assert.equal(calls, 1); assert.equal(hints, 0);
  assert.equal(m.state.commands.length, 1); assert.equal(m.state.audit.length, 1);
});

test("Admin session expiring during domain work rolls back changes and commits a rejected receipt", async () => {
  const m = createMemoryDb();
  let hints = 0;
  const result = await executeAdminCommand({ ...command(m.db), work: async ({ tx, commitContext }) => {
    await tx.agency.update({ where: { id: "agency-a" }, data: { name: "Must roll back" } });
    deferCommitHint(commitContext, "expired", () => { hints += 1; });
    m.clock.setUTCFullYear(2028);
    return { body: { ok: true } };
  } });
  assert.equal(result.statusCode, 401); assert.equal(result.body.code, "ADMIN_AUTH_INVALID");
  assert.equal(m.state.agencies[0].name, undefined); assert.equal(hints, 0);
  assert.equal(m.state.commands[0].status, "REJECTED"); assert.equal(m.state.audit.length, 1);
});

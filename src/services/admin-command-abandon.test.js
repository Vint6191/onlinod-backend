"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { randomUUID } = require("node:crypto");
const { createMemoryDb } = require("../../scripts/test-support/admin-command-memory-db");
const { abandonAdminCommand } = require("./admin-commit-authority-service");
const { setAdminPricing } = require("./admin-pricing-command-service");
const actor = { adminId: "admin-a", sessionId: "session-a", accessEpoch: 1 };
const payload = { expectedRevision: 1, reason: "Price correction", corePriceCents: 3210 };
const execute = (db, commandId) => setAdminPricing({ db, actor, commandId, creatorId: "creator-a", payload });

test("closing an absent command fences its late original request without applying it", async () => {
  const m = createMemoryDb(), commandId = randomUUID();
  const closed = await abandonAdminCommand({ db: m.db, actor, commandId });
  assert.equal(closed.result.code, "ADMIN_COMMAND_ABANDONED");
  const late = await execute(m.db, commandId);
  assert.equal(late.statusCode, 409);
  assert.equal(late.body.code, "ADMIN_COMMAND_ABANDONED");
  assert.equal(m.state.profiles[0].corePriceCents, 2000);
  assert.equal(m.state.commands.length, 1);
  assert.equal(m.state.audit.length, 1);
  assert.deepEqual(await abandonAdminCommand({ db: m.db, actor, commandId }), closed);
});

test("a commit which wins before closure retains its original outcome and one mutation", async () => {
  const m = createMemoryDb(), commandId = randomUUID();
  const committed = await execute(m.db, commandId);
  const closed = await abandonAdminCommand({ db: m.db, actor, commandId });
  assert.equal(closed.status, "SUCCEEDED");
  assert.deepEqual(closed.result, committed.body);
  assert.equal(m.state.profiles[0].pricingRevision, 2);
  assert.equal(m.state.audit.length, 1);
});

test("closure needs current authority and audit failure cannot leave a tombstone", async () => {
  const revoked = createMemoryDb(); revoked.state.sessions[0].revokedAt = revoked.clock;
  await assert.rejects(abandonAdminCommand({ db: revoked.db, actor, commandId: randomUUID() }), { code: "ADMIN_AUTH_INVALID" });
  assert.equal(revoked.state.commands.length, 0);
  const broken = createMemoryDb({ failAudit: true });
  await assert.rejects(abandonAdminCommand({ db: broken.db, actor, commandId: randomUUID() }), /audit unavailable/);
  assert.equal(broken.state.commands.length, 0);
});

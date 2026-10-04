"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createMemoryDb } = require("../../scripts/test-support/admin-command-memory-db");
const { readAdminSupport } = require("./admin-support-command-service");
const actor = { adminId: "admin-a", sessionId: "session-a", accessEpoch: 1 };
function fixture({ expireBeforeResult = false } = {}) {
  let reading = false, lastClock;
  const m = createMemoryDb({ extendState: { grants: [{ id: "grant-a", agencyId: "agency-a", actorId: actor.adminId, sessionId: actor.sessionId, actorAccessEpoch: 1, expiresAt: new Date("2026-09-23T12:00:00.500Z") }] },
    extendClient(api, { read, clock, copy }) {
      const query = api.$queryRawUnsafe;
      api.$queryRawUnsafe = async (sql, ...args) => {
        if (sql.includes('FROM "AdminSupportGrant"')) return [{ id: args[0] }];
        const rows = await query(sql, ...args);
        if (sql.includes("clock_timestamp")) {
          lastClock = new Date(rows[0].authorityNow);
          // Simulate independent awaited reads crossing a deadline. The
          // returned decision must still describe the last clock it used.
          if (reading) clock.setTime(clock.getTime() + 1000);
        }
        return rows;
      };
      api.adminSupportGrant = { findUnique: async ({ where }) => copy(read().grants.find(g => g.id === where.id) || null) };
      api.creatorAccount.findMany = async ({ take }) => {
        assert.equal(take, 51); reading = true;
        if (expireBeforeResult) clock.setTime(clock.getTime() + 1000);
        return [{ id: "creator-a", agencyId: "agency-a" }];
      };
      return api;
    },
  });
  return { m, lastClock: () => lastClock };
}
test("support response uses one final authority instant for both session and grant", async () => {
  const { m, lastClock } = fixture();
  const result = await readAdminSupport({ db: m.db, actor, grantId: "grant-a" });
  assert.deepEqual(result.authorityNow, lastClock());
  assert.ok(new Date(result.grant.expiresAt) > lastClock());
});
test("grant expiry during the data read discards diagnostics", async () => {
  const { m } = fixture({ expireBeforeResult: true });
  await assert.rejects(readAdminSupport({ db: m.db, actor, grantId: "grant-a" }), { code: "SUPPORT_GRANT_EXPIRED" });
});
test("malformed grant expiry cannot authorize a diagnostic read", async () => {
  const { m } = fixture(); m.state.grants[0].expiresAt = "invalid";
  await assert.rejects(readAdminSupport({ db: m.db, actor, grantId: "grant-a" }), { code: "SUPPORT_GRANT_EXPIRED" });
});

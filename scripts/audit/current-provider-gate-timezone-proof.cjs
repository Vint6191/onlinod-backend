"use strict";
// Real Prisma/raw SQL and the current gate/commit kernel, in a disposable DB.
// The caller's DATABASE_URL is never used. No provider or application data.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { createAdminSqlRuntime } = require("../test-support/admin-sql-runtime.cjs");
const credit = require(path.resolve(process.env.ONLINOD_PROVIDER_GATE_BASELINE || path.join(__dirname, "../.."),
  "src/services/provider-request-credit-authority-service.js"));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run({ runtimePath, output }) {
  const result = { ok: false, engine: "PGlite + Prisma + actual provider gate", nativePostgres: false,
    externalProviders: false, baseline: Boolean(process.env.ONLINOD_PROVIDER_GATE_BASELINE), cases: [] };
  const fixture = await createAdminSqlRuntime({ runtimePath });
  const db = fixture.db;
  const input = id => ({ db, waiterId: id, permitId: id, ownerInstanceId: "timezone-proof",
    agencyId: "agency-proof", creatorId: "creator-proof", deviceId: "device-proof", capability: "core",
    priority: "interactive", intervalMs: 700 });
  const waiter = async id => (await db.$queryRawUnsafe(`SELECT *,
    EXTRACT(EPOCH FROM ("leaseUntil" - (clock_timestamp() AT TIME ZONE 'UTC'))) * 1000 AS "remainingMs"
    FROM "OfProviderRequestGateWaiter" WHERE "waiterId"=$1`, id))[0];
  try {
    const { runRootCommit } = require("../../src/services/db-commit-kernel");
    const writers = require("../../src/services/database-write-contract-service");
    await runRootCommit(db, async ({ tx }) => {
      await writers.assertTeamControlPlaneWriteAdmission(tx);
      await tx.user.create({ data: { id: "owner-proof", email: "clock-proof@example.test", passwordHash: "no-login-fixture" } });
      await tx.agency.create({ data: { id: "agency-proof", name: "Disposable provider clock proof" } });
      await tx.agencyMember.create({ data: { agencyId: "agency-proof", userId: "owner-proof", role: "OWNER", roleKey: "owner" } });
      await writers.authorizeCreatorAccountWrite(tx);
      await tx.creatorAccount.create({ data: { id: "creator-proof", agencyId: "agency-proof", displayName: "Clock proof" } });
    });
    assert.equal(await db.creatorAccount.count({ where: { id: "creator-proof", agencyId: "agency-proof" } }), 1);
    for (const zone of ["UTC", "Europe/Kyiv", "America/New_York"]) {
      const row = { zone, ok: false, checks: [] };
      result.cases.push(row);
      try {
        await db.$executeRawUnsafe('DELETE FROM "OfProviderRequestGateWaiter"');
        await db.$executeRawUnsafe('DELETE FROM "OfProviderRequestGateState"');
        await db.$executeRawUnsafe("SELECT set_config('TimeZone', $1, false)", zone);
        const authority = await credit.readProviderGateFairnessAuthority({ db });
        const a = input("first"), b = input("second"), expired = input("expired");
        const first = await credit.registerDurableProviderWaiter({ ...a, waiterTtlMs: 5000 });
        assert.ok(Math.abs(first.enqueuedAt - authority.authorityNow) < 2000, "UTC enqueue time: " + zone);
        assert.ok(Math.abs(first.leaseUntil - first.enqueuedAt - 5000) <= 2);
        const registered = await waiter(a.waiterId);
        assert.ok(Math.abs(registered.createdAt - first.enqueuedAt) < 2000);
        const renewed = await credit.registerDurableProviderWaiter({ ...a, waiterTtlMs: 10000 });
        assert.equal(renewed.ticket, first.ticket);
        assert.deepEqual(renewed.enqueuedAt, first.enqueuedAt);
        assert.ok(renewed.leaseUntil > first.leaseUntil);
        await assert.rejects(credit.registerDurableProviderWaiter({ ...a, ownerInstanceId: "other" }),
          { code: "OF_PROVIDER_GATE_WAITER_COLLISION" });
        row.checks.push("registration, renewal, FIFO identity and collision fence");

        await credit.registerDurableProviderWaiter(expired);
        await db.$executeRawUnsafe(`UPDATE "OfProviderRequestGateWaiter"
          SET "leaseUntil"=(clock_timestamp() AT TIME ZONE 'UTC') - INTERVAL '1 second' WHERE "waiterId"=$1`, expired.waiterId);
        const heartbeat = { db, ownerInstanceId: a.ownerInstanceId, waiterIds: [a.waiterId, expired.waiterId], waiterTtlMs: 20000 };
        assert.deepEqual(await credit.heartbeatDurableProviderWaiters({ ...heartbeat, ownerInstanceId: "other" }), { touched: 0 });
        assert.deepEqual(await credit.heartbeatDurableProviderWaiters(heartbeat), { touched: 1 });
        const live = await waiter(a.waiterId);
        assert.ok(Number(live.remainingMs) > 18000 && Number(live.remainingMs) <= 20001);
        assert.ok(live.updatedAt >= first.enqueuedAt);
        assert.equal((await credit.tryAcquireDurableProviderPermit(expired)).reason, "waiter_missing");
        row.checks.push("heartbeat extends only the live exact owner's lease; expiry stays closed");

        const granted = await credit.tryAcquireDurableProviderPermit(a);
        assert.equal(granted.granted, true);
        assert.equal(granted.expiresAt - granted.grantedAt, credit.PROVIDER_GATE_PERMIT_TTL_MS);
        assert.equal(await waiter(a.waiterId), undefined);
        assert.equal(await waiter(expired.waiterId), undefined, "Expired FIFO prefix is pruned");
        await credit.registerDurableProviderWaiter(b);
        assert.equal((await credit.tryAcquireDurableProviderPermit(b)).reason, "active_permit");
        assert.equal((await credit.cancelDurableProviderPermit({ ...a, deviceId: "other" })).cancelled, false);
        const started = await credit.acknowledgeDurableProviderStarted(a);
        assert.equal(started.nextAllowedAt - started.startedAt, 700);
        const spacing = await credit.tryAcquireDurableProviderPermit(b);
        assert.equal(spacing.reason, "spacing");
        assert.deepEqual(spacing.retryAt, started.nextAllowedAt);
        await wait(Math.max(0, spacing.retryAt - spacing.authorityNow) + 30);
        const next = await credit.tryAcquireDurableProviderPermit(b);
        assert.equal(next.granted, true);
        assert.ok(next.grantedAt - started.startedAt >= 700);
        const secondStarted = await credit.acknowledgeDurableProviderStarted(b);
        assert.equal(secondStarted.usageTotalStarts, 2);
        assert.equal(secondStarted.usageUnclassifiedStarts, 0);
        row.checks.push("admission, DB trigger, exact permit owner, start accounting and global 700 ms spacing");

        const state = await credit.readDurableProviderGateState({ db });
        assert.deepEqual(state.lastStartedAt, secondStarted.startedAt);
        assert.deepEqual(state.nextAllowedAt, secondStarted.nextAllowedAt);
        assert.equal((await db.$queryRawUnsafe("SHOW TimeZone"))[0].TimeZone, zone,
          "Commit UTC policy must not leak into the pooled session");
        row.checks.push("stored UTC state and unchanged session timezone after commit");
        row.ok = true;
      } catch (error) {
        row.error = { message: error.message, stack: error.stack };
      }
    }
    result.ok = result.cases.every(row => row.ok);
  } finally {
    await fixture.close();
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
  }
  return result;
}

module.exports = { run };
if (require.main === module) {
  const output = path.resolve(process.env.ONLINOD_SQL_PROOF_OUTPUT ||
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), "onlinod-provider-timezone-")), "result.json"));
  run({ runtimePath: process.env.ONLINOD_SQL_PROOF_RUNTIME, output }).then(result => {
    console.log(JSON.stringify({ ok: result.ok, cases: result.cases, output }));
    process.exitCode = result.ok ? 0 : 1;
  }).catch(error => { console.error(error); process.exitCode = 1; });
}

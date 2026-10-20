"use strict";
// Isolated SQL only; never connects to application DATABASE_URL or providers.
const assert = require("node:assert/strict");
const { createScaleSqlRuntime } = require("../test-support/scale-sql-runtime.cjs");
const { scope } = require("./analytics-traffic/fixture.cjs");
const keep = setInterval(() => {}, 1000);
(async () => {
  const f = await createScaleSqlRuntime();
  try {
    const tenant = await scope(f.db), other = await scope(f.db, { agencyId: "other-agency", creatorId: "other-creator", userId: "other-user" });
    require.cache[require.resolve("../../src/prisma")] = { exports: f.db };
    const { createRecoveryRuntimeObserver } = require("../../src/services/recovery-runtime-observer");
    const rows = [], emit = (...args) => rows.push(args);
    const observe = createRecoveryRuntimeObserver({ emit });
    await observe.observe({ db: f.db, ...tenant });
    assert.equal(rows.length, 1); assert.equal(rows[0][0], "creator recovery snapshot", JSON.stringify(rows));
    assert.deepEqual(rows[0][2].snapshot.subscriber.readFailures, []);
    assert.equal(rows[0][2].snapshot.scope.creatorId, tenant.creatorId);
    console.log("PASS default read-only transaction reads actual current schema");
    await observe.stop();

    const now = new Date();
    await f.db.jobInstance.create({ data: { id: "diag-financial", ...tenant, userId: undefined,
      jobKey: "financial_transactions_scan", scope: "creator", status: "FAILED",
      params: { moneyResolutionVersion: 1, startDate: "2026-10-17T10:00:00Z", endDate: "2026-10-17T11:00:00Z",
        cookie: "canary-secret", rawObservation: "canary-fan" },
      lastError: "private canary-provider-payload", nextRunAt: now,
      result: { raw: "canary-result", completionSideEffect: {
        type: "financial_transactions", ok: false, protocolCurrent: true,
        sourceBoundaryReached: true, scannerRejected: 0, staleGeneration: false,
        reconciliation: { proofKind: "EXHAUSTED_WINDOW_AND_CHART", chartReady: true,
          countMatched: false, grossMatched: false, netMatched: false,
          chartCount: 2, chartGrossCents: 2500, chartNetCents: 2000 },
        windows: [{ kind: "RESOLUTION", from: "2026-10-17T10:00:00Z", to: "2026-10-17T11:00:00Z",
          pages: 1, received: 1, rejected: 0, exhausted: true, matched: false,
          count: 1, grossCents: 1000, netCents: 800, statusGroups: {},
          charts: { total: { transactionsCount: 2, grossCents: 2500, netCents: 2000 } },
          payload: "canary-provider-response" }],
        raw: "canary-side-effect", fanUserId: "canary-fan-user",
      } },
    } });
    await f.db.creatorMoneyResolutionRequest.create({ data: { creatorId: tenant.creatorId, agencyId: tenant.agencyId,
      jobId: "diag-financial", attempts: 1, lastError: "canary-stored-message", updatedAt: now } });
    await f.db.creatorRecoveryIntent.create({ data: { id: "diag-intent", creatorId: tenant.creatorId, agencyId: tenant.agencyId,
      stream: "financial", reason: "OFFLINE_GAP", gapFrom: now, targetAt: now, policyVersion: 1, status: "RUNNING", jobId: "diag-financial" } });
    const observed = createRecoveryRuntimeObserver({ emit });
    await observed.observe({ db: f.db, agencyId: tenant.agencyId, creatorId: tenant.creatorId });
    const payload = rows.at(-1)[2].snapshot;
    assert.equal(rows.at(-1)[0], "creator recovery snapshot", JSON.stringify(rows.at(-1)));
    assert.equal(payload.moneyResolution.jobId, "diag-financial");
    assert.equal(payload.referencedJobs[0].windowMs, 3600000);
    assert.equal(payload.referencedJobs[0].status, "FAILED");
    const verification = payload.referencedJobs[0].financialVerification;
    assert.equal(verification.outcome, "REJECTED");
    assert.equal(verification.countMatched, false);
    assert.equal(verification.windows[0].observed.count, 1);
    assert.equal(verification.windows[0].expected.count, 2);
    assert.equal(verification.windows[0].observed.netCents, 800);
    assert.equal(verification.windows[0].expected.netCents, 2000);
    assert.equal(payload.recoveryIntents[0].id, "diag-intent");
    assert.doesNotMatch(JSON.stringify(payload), /canary/);
    console.log("PASS existing failed resolution exposes stored verification mismatch without new scans or raw job data");
    await observed.stop();

    const denied = createRecoveryRuntimeObserver({ emit });
    await denied.observe({ db: f.db, agencyId: other.agencyId, creatorId: tenant.creatorId, jobId: "diag-financial" });
    assert.equal(rows.at(-1)[2].snapshot.scopeUnavailable, true);
    assert.equal(rows.at(-1)[2].snapshot.referencedJobs, undefined);
    await denied.stop();
    console.log("PASS cross-agency scope does not reveal recovery rows");

    const readonly = createRecoveryRuntimeObserver({ emit, inspect: async tx => tx.systemSetting.create({ data: { key: "diagnostic-must-not-write", value: {} } }) });
    await readonly.observe({ db: f.db, agencyId: tenant.agencyId, creatorId: tenant.creatorId });
    assert.equal(rows.at(-1)[0], "creator recovery inspection failed");
    assert.equal(await f.db.systemSetting.findUnique({ where: { key: "diagnostic-must-not-write" } }), null);
    await readonly.stop();
    console.log("PASS database enforces read-only diagnostics and observer safely reports failure");

    // Deliberately fail one actual PostgreSQL statement. The next statements
    // would produce 25P02; the emitted cause must remain the first 22012.
    const failingDb = { $transaction: (fn, options) => f.db.$transaction(tx => fn(new Proxy(tx, {
      get(target, name) {
        if (name === "subscriberDirectoryMaintenanceSignal") return { findMany: () => target.$queryRawUnsafe("SELECT 1/0") };
        const value = target[name]; return typeof value === "function" ? value.bind(target) : value;
      },
    })), options) };
    const failedRead = createRecoveryRuntimeObserver({ emit });
    await failedRead.observe({ db: failingDb, agencyId: tenant.agencyId, creatorId: tenant.creatorId });
    assert.equal(rows.at(-1)[0], "creator recovery inspection failed");
    assert.equal(rows.at(-1)[2].diagnosticRead, "maintenanceSignals");
    assert.equal(rows.at(-1)[2].error.databaseCode, "22012", JSON.stringify(rows.at(-1)));
    await failedRead.stop();
    console.log("PASS first PostgreSQL failure survives aborted-transaction follow-ups with safe read name and SQLSTATE");
    console.log(JSON.stringify({ ok: true, cases: 5, nativePostgres: f.native, productionAccessed: false, externalProviders: false }));
  } finally { await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearInterval(keep));

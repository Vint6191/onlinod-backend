"use strict";
// Recreate persisted pre-release publication debt, then run the actual installer
// against isolated PostgreSQL/PGlite. No provider or application database access.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { spawn } = require("node:child_process");
const { createScaleSqlRuntime } = require("../test-support/scale-sql-runtime.cjs");
const { scope } = require("./analytics-traffic/fixture.cjs");
const { migrations, validMigrationPrefix } = require("../../src/services/database-migration-chain");
const { TRANSIENT_DATABASE_CODES, classifyStoredDatabaseFailure } = require("../../src/services/db-retry-policy");
const root = path.resolve(__dirname, "../.."), migrationName = "20261018050000_subscriber_stranded_wake";
const keep = setInterval(() => {}, 1000);
const deadline = setTimeout(() => { console.error("SUBSCRIBER_MIGRATION_PROOF_DEADLINE"); process.exit(2); }, 240000);

(async () => {
  const runtime = await createScaleSqlRuntime({ beforeMigration: migrationName }), checks = [];
  const pass = name => { checks.push(name); console.log("PASS", name); };
  try {
    const { db } = runtime, s = await scope(db);
    const now = new Date(), old = new Date(+now - 86400000), future = new Date(+now + 3600000);
    const expired = "Transaction API error: Transaction already closed: A commit cannot be executed on an expired transaction. The timeout for this transaction was 15000 ms, however 15100 ms passed since the start of the transaction.";
    let sequence = 0;
    const unchanged = [], repaired = [], missing = [];
    async function fixture({ run = {}, signal, creator = {}, agencyId = s.agencyId } = {}) {
      const id = `subscriber-migration-${++sequence}`;
      await db.$transaction(async tx => {
        await tx.$queryRawUnsafe("SELECT set_config('onlinod.phase2_creator_writer_generation','phase2_creator_writer_v2_actual56_postcut',true)");
        await tx.creatorAccount.create({ data: { id, agencyId, displayName: id, remoteId: id, status: "READY", ...creator } });
      });
      const savedRun = await db.subscriberScanRun.create({ data: { id: `${id}-run`, agencyId, creatorId: id,
        status: "RUNNING", fanProjectionStatus: "COMPLETE", hasMore: false, publicationStatus: "CURRENT",
        publicationGeneration: 7, publicationCursorId: "already-committed-row", publicationAddedCount: 4048, ...run } });
      const savedSignal = signal && await db.subscriberDirectoryMaintenanceSignal.create({ data: {
        id: `${id}-signal`, agencyId, creatorId: id, kind: "RECOVERY", attempts: 100, revision: 13,
        dueAt: future, reason: "PUBLICATION_DEBT", lastError: expired, ...signal,
      } });
      return { id, run: savedRun, signal: savedSignal };
    }
    missing.push(await fixture());
    missing.push(await fixture({ run: { status: "PUBLISHED", publicationStatus: "COMPLETE" } }));
    missing.push(await fixture({ run: { status: "SUPERSEDED", publicationStatus: "COMPLETE" } }));
    const diagnostics = [expired, "Transaction API error: Unable to start a transaction in the given time.",
      "Timed out fetching a new connection from the connection pool. More info: fixture",
      "\nCan't reach database server at fixture\n", "Server has closed the connection.",
      "Raw query failed. Code: `40001`. Message: `serialization failure`",
      "\nInvalid `prisma.$queryRawUnsafe()` invocation:\n\n\nCan't reach database server at `127.0.0.1:1`\n\nPlease make sure your database server is running at `127.0.0.1:1`.",
      "Invalid `db.creator.findMany()` invocation in\nfixture.js:15\n→ db.creator.findMany()\n\nTimed out fetching a new connection from the connection pool. More info: fixture\n(Connection limit: 1)",
      "Invalid `prisma.agency.findMany()` invocation:\n\nServer has closed the connection.",
      ...[...TRANSIENT_DATABASE_CODES, "P2028", "DB_TRANSIENT_AGGREGATE"].map(code => `[TRANSIENT_DB:${code}] classified database failure`)];
    for (const lastError of diagnostics) {
      assert(classifyStoredDatabaseFailure({ message: lastError }), lastError);
      repaired.push(await fixture({ signal: { lastError, claimToken: "expired-owner", claimUntil: old } }));
    }
    const badErrors = ["GENUINE_DATA_CONTRADICTION", "P2028: Transaction not found", "request timeout",
      "A commit cannot be executed on an expired transaction.", "The timeout for this transaction was 15000 ms, however 15100 ms passed",
      "Raw query failed. Code: `23503`. Message: `mentions 40001`", "[TRANSIENT_DB:P2002] duplicate key",
      "prefix [TRANSIENT_DB:P2024] not an authority marker",
      "Can't reach database server at fixture\nGenuine domain contradiction",
      "application error: Invalid `prisma.creator.findMany()` invocation:\n\nServer has closed the connection.",
      "Invalid `prisma.creator.findMany()` invocation:\n\nServer has closed the connection.\nGenuine domain contradiction",
      "Invalid `prisma.creator.findMany()` invocation:\n\nAuthentication failed against database server at fixture"];
    for (const lastError of badErrors) {
      assert.equal(classifyStoredDatabaseFailure({ message: lastError }), null, lastError);
      unchanged.push(await fixture({ signal: { lastError } }));
    }
    const liveOwner = await fixture({ signal: { claimToken: "current-publisher", claimUntil: future } });
    unchanged.push(liveOwner, await fixture({ signal: { attempts: 99 } }),
      await fixture({ signal: { kind: "RETENTION" } }),
      await fixture({ signal: {}, run: { status: "PUBLISHED", publicationStatus: "COMPLETE", publicationJobReconciledAt: old } }),
      await fixture({ signal: {}, creator: { deletedAt: old } }));
    const noWake = [await fixture({ creator: { deletedAt: old } }),
      await fixture({ run: { hasMore: true } }), await fixture({ run: { fanProjectionStatus: "PROJECTING" } }),
      await fixture({ run: { status: "PUBLISHED", publicationStatus: "COMPLETE", publicationJobReconciledAt: old } })];
    const retired = { agencyId: "retired-agency" };
    await db.$transaction(async tx => {
      await tx.$queryRawUnsafe("SELECT set_config('onlinod.phase2_team_control_plane_generation','phase2_team_control_plane_v2_durable_access',true)");
      await tx.agency.create({ data: { id: retired.agencyId, name: "Historical retired agency", deletedAt: old } });
    });
    noWake.push(await fixture({ agencyId: retired.agencyId }));
    unchanged.push(await fixture({ agencyId: retired.agencyId, signal: {} }));
    // A historical tenant mismatch must not publish into either tenant's lane.
    noWake.push(await fixture({ run: { agencyId: retired.agencyId } }));

    // Large completed history must be excluded by the existing partial indexes.
    await db.$executeRawUnsafe(`INSERT INTO "SubscriberScanRun" (
      "id","agencyId","creatorId","status","fanProjectionStatus","hasMore","publicationStatus","publicationJobReconciledAt","updatedAt"
    ) SELECT 'completed-history-' || n,$1,$2,'PUBLISHED','COMPLETE',false,'COMPLETE',$3,$3
      FROM generate_series(1,15000) n`, s.agencyId, s.creatorId, old);
    await db.$executeRawUnsafe('ANALYZE "SubscriberScanRun"');
    const migration = fs.readFileSync(path.join(root, "prisma/migrations", migrationName, "migration.sql"), "utf8");
    const debtQuery = /WITH publication_debt AS \(([\s\S]*?)\)\nINSERT/.exec(migration)[1];
    const plans = await db.$queryRawUnsafe(`EXPLAIN (ANALYZE,FORMAT JSON) ${debtQuery}`);
    const planText = JSON.stringify(plans);
    assert.match(planText, /SubscriberScanRun_publication_debt_idx/);
    assert.match(planText, /SubscriberScanRun_(creator_reconcile|publication_job_reconcile)_idx/);
    assert.doesNotMatch(planText, /"Node Type":"Seq Scan","[^}]*"Relation Name":"SubscriberScanRun"/);
    pass("migration debt selection uses existing partial indexes with 15000 completed historical scans");

    const runsBefore = await db.subscriberScanRun.findMany({ where: { id: { startsWith: "subscriber-migration-" } }, orderBy: { id: "asc" } });
    const targetIndex = migrations.findIndex(item => item.migration === migrationName);
    assert(targetIndex > 0, "target migration must follow the baseline");
    const prefix = await db.$queryRawUnsafe('SELECT migration_name,checksum,finished_at,rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name');
    assert.equal(validMigrationPrefix(prefix), true, "fixture must have an authentic completed migration prefix");
    assert.equal(validMigrationPrefix(prefix, true), false, "target and later migrations must not be preinstalled");
    assert.deepEqual(prefix.map(row => ({ migration: row.migration_name, checksum: row.checksum })), migrations.slice(0, targetIndex));
    pass("actual pre-upgrade DDL and receipts stop immediately before the target migration");
    await db.$executeRawUnsafe("SET TIME ZONE 'Pacific/Auckland'");
    await db.$disconnect(); if (runtime.waitForIdle) await runtime.waitForIdle();
    const install = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["scripts/database/install-current.js"], { cwd: root,
        env: { ...process.env, DATABASE_URL: runtime.url || process.env.ONLINOD_NATIVE_TEST_DATABASE_URL,
          DIRECT_URL: runtime.url || process.env.ONLINOD_NATIVE_TEST_DATABASE_URL }, stdio: ["ignore", "pipe", "pipe"] });
      let output = ""; child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
      const timer = setTimeout(() => child.kill(), 60000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(output)); });
    });
    await install();
    for (const item of missing) {
      const signal = await db.subscriberDirectoryMaintenanceSignal.findUnique({ where: { creatorId_kind: { creatorId: item.id, kind: "RECOVERY" } } });
      assert(signal, item.id); assert.equal(signal.attempts, 0); assert.equal(signal.revision, 1);
      assert.equal(signal.claimToken, null); assert.equal(signal.claimUntil, null);
      assert(Math.abs(+signal.dueAt - Date.now()) < 60000, "new work must be due immediately despite a non-UTC session");
    }
    pass("actual deploy restores missing RECOVERY wakes for incomplete publication and terminal-job reconciliation immediately");
    for (const item of repaired) {
      const signal = await db.subscriberDirectoryMaintenanceSignal.findUnique({ where: { id: item.signal.id } });
      assert.equal(signal.attempts, 0, item.signal.lastError); assert.equal(signal.revision, item.signal.revision + 1);
      assert.equal(signal.lastError, null); assert.equal(signal.claimToken, null); assert.equal(signal.claimUntil, null);
      assert.equal(signal.reason, "TRANSIENT_DATABASE_RECOVERY");
      assert(Math.abs(+signal.dueAt - Date.now()) < 60000, "repaired work must be due immediately");
    }
    pass("deployment revives only exact known transient SQL quarantine and fences expired owners");
    for (const item of unchanged) assert.deepEqual(await db.subscriberDirectoryMaintenanceSignal.findUnique({ where: { id: item.signal.id } }), item.signal, item.id);
    for (const item of noWake) assert.equal(await db.subscriberDirectoryMaintenanceSignal.count({ where: { creatorId: item.id } }), 0, item.id);
    assert.deepEqual(await db.subscriberScanRun.findMany({ where: { id: { startsWith: "subscriber-migration-" } }, orderBy: { id: "asc" } }), runsBefore);
    assert.equal(await db.subscriberScanRun.count({ where: { id: { startsWith: "completed-history-" } } }), 15000);
    assert.equal(await db.jobInstance.count(), 0);
    pass("live ownership, healthy backoff, true poison, retention, tenant/lifecycle fences and publication cursors remain intact");
    const signalsBefore = await db.subscriberDirectoryMaintenanceSignal.findMany({ orderBy: { id: "asc" } });
    await db.$disconnect(); if (runtime.waitForIdle) await runtime.waitForIdle();
    await install();
    assert.deepEqual(await db.subscriberDirectoryMaintenanceSignal.findMany({ orderBy: { id: "asc" } }), signalsBefore);
    assert.equal((await require("../../src/services/database-contract-service").readDatabaseContract(db)).ready, true);
    pass("repeated actual install is a no-op and the complete current schema contract remains ready");
    const report = { ok: true, checks, knownTransientCases: repaired.length, protectedSignals: unchanged.length,
      absentWakes: noWake.length, historicalScans: 15000, engine: runtime.native ? "PostgreSQL + Prisma" : "PGlite + Prisma, one physical SQL connection" };
    if (process.env.ONLINOD_SUBSCRIBER_MIGRATION_REPORT) fs.writeFileSync(process.env.ONLINOD_SUBSCRIBER_MIGRATION_REPORT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await runtime.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => { clearInterval(keep); clearTimeout(deadline); });

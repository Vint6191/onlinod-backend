"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createScaleSqlRuntime } = require("../test-support/scale-sql-runtime.cjs");
const { scope } = require("./analytics-traffic/fixture.cjs");
const { runRootCommit } = require("../../src/services/db-commit-kernel");
const feed = require("../../src/services/creator-entity-change-service");
const migration = "20261027010000_entity_change_window187";
const root = path.resolve(__dirname, "../..");
const reclaimSql = fs.readFileSync(path.join(root, "scripts/database/reclaim-entity-change-journal.sql"), "utf8");
const pass = label => console.log("PASS", label);

(async () => {
  const f = await createScaleSqlRuntime({ beforeMigration: migration });
  try {
    const { db } = f, s = await scope(db);
    const other = await scope(db, { agencyId: "other-agency", creatorId: "other-creator", userId: "other-user" });
    const fresh = await scope(db, { agencyId: "fresh-agency", creatorId: "fresh-creator", userId: "fresh-user" });
    const commit = work => runRootCommit(db, ({ tx }) => work(tx));
    const read = (owner, args = {}) => runRootCommit(db, ({ tx }) => feed.readEntityChanges({ db: tx, ...owner, ...args }), { isolationLevel: "RepeatableRead" });
    const snapshot = (owner, args = {}) => runRootCommit(db, ({ tx }) => feed.readCurrentEntities({ db: tx, ...owner, ...args }), { isolationLevel: "RepeatableRead" });
    const change = (id, version = "1") => ({ entityType: "FAN", entityId: id, sourceIdentity: `fan:${id}`,
      sourceVersion: version, payload: { dataVersion: version, fanOnlyFansUserId: id } });
    const head = async owner => (await db.$queryRawUnsafe('SELECT * FROM "CreatorEntityChangeHead" WHERE "creatorId"=$1', owner.creatorId))[0];
    const count = async owner => Number((await db.$queryRawUnsafe('SELECT count(*) AS n FROM "CreatorEntityChange" WHERE "creatorId"=$1', owner.creatorId))[0].n);
    async function sql(text) {
      if (f.engine) {
        await db.$disconnect(); await f.waitForIdle();
        try { return await f.engine.exec(text); }
        catch (error) { await f.engine.exec("ROLLBACK"); throw error; }
      }
      const url = new URL(f.url);
      return execFileSync("psql", ["--no-psqlrc", "--set", "ON_ERROR_STOP=1"], { input: text,
        env: { ...process.env, PGHOST: url.hostname, PGPORT: url.port || "5432", PGDATABASE: url.pathname.slice(1),
          PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGSSLMODE: "disable" },
        stdio: ["pipe", "pipe", "pipe"] });
    }
    async function seed(owner, rows, ageDays = 0) {
      await commit(async tx => {
        await tx.$executeRawUnsafe(`INSERT INTO "CreatorEntityChangeHead"("creatorId","agencyId","lastRevision","nextRetentionAt")
          VALUES($1,$2,$3,clock_timestamp()+interval '30 days')`, owner.creatorId, owner.agencyId, BigInt(rows));
        await tx.$executeRawUnsafe(`INSERT INTO "CreatorEntityChange"("creatorId","agencyId",revision,"entityType","entityId","sourceIdentity","sourceVersion",payload,"createdAt")
          SELECT $1,$2,g,'FAN','reobserved-fan','fan:reobserved-fan',g::text,jsonb_build_object('dataVersion',g::text),
            clock_timestamp()-($4::int*interval '1 day') FROM generate_series(1::bigint,$3::bigint) g`, owner.creatorId, owner.agencyId, BigInt(rows), ageDays);
        await tx.$executeRawUnsafe(`INSERT INTO "CreatorEntityCurrent"("creatorId","agencyId",revision,"entityType","entityId","sourceIdentity","sourceVersion",payload)
          SELECT "creatorId","agencyId",revision,"entityType","entityId","sourceIdentity","sourceVersion",payload
          FROM "CreatorEntityChange" WHERE "creatorId"=$1 AND revision=$2`, owner.creatorId, BigInt(rows));
      });
    }
    const legacyRows = feed.MAX_RETAINED_CHANGES * 3 + 137;
    await seed(s, legacyRows);
    await seed(other, 3, 2);
    await seed(fresh, feed.MAX_RETAINED_CHANGES - 2);
    await assert.rejects(() => sql(reclaimSql), /BACKEND_187_MIGRATION_REQUIRED/);
    assert.equal(await count(s), legacyRows);
    const migrationSql = fs.readFileSync(path.join(root, "prisma/migrations", migration, "migration.sql"), "utf8");
    await sql(migrationSql);
    const expected = require("../../src/services/database-migration-chain").migrations.find(item => item.migration === migration);
    await db.$executeRawUnsafe(`INSERT INTO "_prisma_migrations"(id,checksum,migration_name,finished_at,applied_steps_count)
      VALUES('proof-window187',$1,$2,now(),1)`, expected.checksum, migration);
    assert((await head(s)).nextRetentionAt <= new Date());
    assert.equal(await count(s), legacyRows, "upgrade only wakes cleanup; no destructive deployment");
    pass("upgrade wakes previously future-dated heads; reclamation refuses an unupgraded database without deleting rows");

    await commit(tx => feed.publishEntityChanges({ db: tx, ...s, changes: [change("live-after-legacy")] }));
    assert.equal(await count(s), legacyRows);
    assert.equal(String((await head(s)).retainedFrom), "2");
    await assert.rejects(() => read(s), { code: "RECONCILE_REQUIRED" });
    assert.equal((await read(s, { afterRevision: "1", limit: 1 })).changes[0].revision, "2");
    pass("a one-row owner commit adds one and removes only one legacy row, rather than scanning the full backlog");

    const freshBatch = Array.from({ length: 230 }, (_, i) => change(`fresh-${String(i).padStart(3, "0")}`));
    await commit(tx => feed.publishEntityChanges({ db: tx, ...fresh, changes: freshBatch }));
    assert.equal(await count(fresh), feed.MAX_RETAINED_CHANGES);
    const stableHead = await head(fresh);
    assert.equal(stableHead.retainedFrom, 229n);
    await commit(tx => feed.publishEntityChanges({ db: tx, ...fresh, changes: freshBatch }));
    assert.deepEqual(await head(fresh), stableHead, "unchanged replay cannot spend revision/window capacity");
    await assert.rejects(() => runRootCommit(db, async context => {
      await feed.publishEntityChanges({ db: context.tx, ...fresh, changes: [change("rollback")] });
      require("../../src/services/db-commit-kernel").prepareCommit(context, "zzz-fail-after-feed", () => { throw Error("AFTER_WINDOW_TRIM"); });
    }), /AFTER_WINDOW_TRIM/);
    assert.deepEqual(await head(fresh), stableHead);
    assert.equal(await count(fresh), feed.MAX_RETAINED_CHANGES);
    assert.equal((await read(fresh, { afterRevision: "228", limit: 1 })).nextRevision, "229");
    pass("fresh windows remain capped without maintenance; replay is a no-op; rollback restores trimmed rows, snapshot and head");

    // The quiet creator is due first; a busy creator cannot consume all pages.
    await db.$executeRawUnsafe(`UPDATE "CreatorEntityChangeHead" SET "nextRetentionAt"=clock_timestamp()-interval '1 day' WHERE "creatorId"=$1`, other.creatorId);
    assert.equal(await commit(tx => feed.retainPage(tx)), 3);
    assert.equal(await count(other), 0);
    assert.equal((await snapshot(other)).entities.length, 1);
    const beforeSweep = await count(s);
    const report = await feed.runRetentionSweep({ db, maxPages: 4, maxRuntimeMs: 30000 });
    assert(report.processed <= 4 * 500);
    assert(beforeSweep - await count(s) <= 4 * 500);
    assert(await count(s) < beforeSweep);
    assert.equal(await count(fresh), feed.MAX_RETAINED_CHANGES);
    assert.equal((await head(other)).nextRetentionAt, null);
    pass("one-day age cleanup and count cleanup are bounded, fair, isolated by creator, and preserve snapshots");

    // Leave no maintenance timer running: publication itself must pay for rows.
    for (let i = 0; i < 4; i++) {
      await commit(tx => feed.publishEntityChanges({ db: tx, ...fresh, changes: [change("fresh-live", String(i + 1))] }));
      assert.equal(await count(fresh), feed.MAX_RETAINED_CHANGES);
    }
    const beforeBurst = await head(fresh);
    await commit(tx => feed.publishEntityChanges({ db: tx, ...fresh,
      changes: Array.from({ length: 12000 }, (_, i) => change(`burst-${String(i).padStart(5, "0")}`)) }));
    assert.equal(await count(fresh), feed.MAX_RETAINED_CHANGES);
    assert.equal((await head(fresh)).retainedFrom, beforeBurst.retainedFrom + 12000n);
    pass("a maximum 12000-entity owner commit keeps the 20000-row window bounded without a cleanup worker");
    if (f.native) {
      const beforeRace = await head(fresh);
      await Promise.all(["a", "b"].map(writer => commit(tx => feed.publishEntityChanges({ db: tx, ...fresh,
        changes: Array.from({ length: 200 }, (_, i) => change(`concurrent-${writer}-${i}`)) }))));
      assert.equal(await count(fresh), feed.MAX_RETAINED_CHANGES);
      assert.equal((await head(fresh)).lastRevision, beforeRace.lastRevision + 400n);
      assert.equal((await head(fresh)).retainedFrom, beforeRace.retainedFrom + 400n);
      pass("competing native PostgreSQL publishers serialize allocation and trimming without overshooting the window");
    }
    const sale = { id: "reclaim-protected-sale", agencyId: s.agencyId, creatorId: s.creatorId,
      eventFingerprint: "a".repeat(64), saleType: "MESSAGE", fanOnlyFansUserIdAtEvent: "42", messageId: "77", amountCents: 1900, purchasedAt: new Date() };
    await commit(async tx => {
      await require("../../src/services/creator-fact-write-authority").lockCreatorFacts(tx, s.agencyId, s.creatorId);
      await tx.creatorSale.create({ data: sale });
      await feed.publishCanonicalSales({ db: tx, ...s, saleIds: [sale.id] });
    });
    const currentRows = () => db.$queryRawUnsafe('SELECT * FROM "CreatorEntityCurrent" ORDER BY "creatorId","entityType","entityId"');
    const beforeCurrent = await currentRows(), beforeHead = await head(fresh);
    const beforeSize = BigInt((await db.$queryRawUnsafe(`SELECT pg_total_relation_size('public."CreatorEntityChange"') AS bytes`))[0].bytes);
    const beforeRows = await count(s);
    await sql(reclaimSql.replace("COMMIT;", "ROLLBACK;"));
    assert.equal(await count(s), beforeRows);
    assert.deepEqual(await head(fresh), beforeHead);
    pass("the exact reclamation script is transactional: rollback restores the journal and cursors");

    // The guard rejects a missing current head instead of discarding its only copy.
    await db.$executeRawUnsafe('UPDATE "CreatorEntityChangeHead" SET "lastRevision"="lastRevision"+1 WHERE "creatorId"=$1', fresh.creatorId);
    await assert.rejects(() => sql(reclaimSql), /ENTITY_CURRENT_SNAPSHOT_REQUIRED/);
    assert.equal(await count(s), beforeRows);
    await db.$executeRawUnsafe('UPDATE "CreatorEntityChangeHead" SET "lastRevision"="lastRevision"-1 WHERE "creatorId"=$1', fresh.creatorId);
    await sql(reclaimSql);
    assert.equal(await count(s), 0); assert.equal(await count(fresh), 0);
    assert.deepEqual(await currentRows(), beforeCurrent);
    assert.equal((await db.creatorSale.findUnique({ where: { id: sale.id } })).amountCents, 1900);
    const afterSize = BigInt((await db.$queryRawUnsafe(`SELECT pg_total_relation_size('public."CreatorEntityChange"') AS bytes`))[0].bytes);
    assert(afterSize < beforeSize / 10n, "physical relation, including indexes, must shrink");
    console.log(JSON.stringify({ engine: f.native ? "native PostgreSQL" : "PGlite PostgreSQL", beforeBytes: String(beforeSize), afterBytes: String(afterSize), snapshotRows: beforeCurrent.length }));
    pass("reclamation physically shrinks the journal, preserves exact current snapshots and money, and rejects inconsistent snapshots");

    await assert.rejects(() => read(fresh, { afterRevision: "0" }), { code: "RECONCILE_REQUIRED" });
    const initial = await snapshot(fresh, { limit: 100 }), barrier = initial.snapshotBarrier;
    assert(initial.hasMore);
    await commit(tx => feed.publishEntityChanges({ db: tx, ...fresh, changes: [change("000-during-snapshot")] }));
    const entities = new Map(initial.entities.map(row => [row.entityId, row]));
    let page = initial;
    while (page.hasMore) {
      page = await snapshot(fresh, { limit: 100, snapshotBarrier: barrier, afterType: page.nextCursor.entityType, afterId: page.nextCursor.entityId });
      for (const row of page.entities) entities.set(row.entityId, row);
    }
    const catchup = await read(fresh, { afterRevision: barrier });
    assert.equal(catchup.changes.length, 1);
    for (const row of catchup.changes) entities.set(row.entityId, row);
    assert(entities.has("000-during-snapshot"));
    assert.equal(catchup.nextRevision, String(beforeHead.lastRevision + 1n));
    const purchase = (await snapshot(s)).entities.find(row => row.entityType === "MESSAGE_PURCHASE");
    assert.equal(purchase.payload.messageId, "77");
    assert.equal(purchase.payload.opened, true);
    const crossAgency = await read({ ...fresh, agencyId: other.agencyId });
    assert.deepEqual(crossAgency.changes, []);
    pass("offline clients recover bounded current pages, exact purchase corrections and concurrent changes; revisions never reset and agency isolation remains");

    await sql('TRUNCATE "public"."CreatorEntityChange";'); // Simulate a pre-reset MVCC head with the now-empty physical journal.
    await assert.rejects(() => read(fresh, { afterRevision: barrier }), { code: "RECONCILE_REQUIRED" });
    pass("a stale MVCC head or a missing journal suffix cannot acknowledge a false catch-up");
    if (!f.native) console.log("LIMIT: physical SQL and rollback checked in PGlite; native concurrent writer/lock timing and live Neon size not measured");
  } finally { await f.close(); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

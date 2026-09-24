"use strict";

// Disposable proof only. Never reads DATABASE_URL or connects to a production
// database. PGlite and its socket adapter are optional audit-runtime packages.
const { createRequire } = require("node:module");
const path = require("node:path");
const fs = require("node:fs");
const assert = require("node:assert/strict");
const { setTimeout: delay } = require("node:timers/promises");
const { PrismaClient, Prisma } = require("@prisma/client");
const { runRootCommit, joinCommit, deferCommitHint, commitAuthorityNow } = require("../../src/services/db-commit-kernel");

async function main() {
  const runtime = process.env.PHASE5_PROOF_RUNTIME;
  if (!runtime) throw new Error("Set PHASE5_PROOF_RUNTIME to an audit runtime containing @electric-sql/pglite and pglite-socket");
  const load = createRequire(path.resolve(runtime, "package.json"));
  const { PGlite } = load("@electric-sql/pglite");
  const { PGLiteSocketServer } = load("@electric-sql/pglite-socket");
  const engine = await PGlite.create();
  const server = new PGLiteSocketServer({ db: engine, host: "127.0.0.1", port: 0 });
  await server.start();
  const db = new PrismaClient({ datasources: { db: { url: `postgresql://postgres:postgres@${server.getServerConn()}/postgres?connection_limit=1&sslmode=disable` } } });
  const results = [];
  async function proof(name, fn) {
    const evidence = await fn();
    results.push({ name, status: "PASS", evidence: evidence || null });
    console.log(JSON.stringify(results.at(-1)));
  }
  try {
    await db.$executeRawUnsafe('CREATE TABLE "CommitProbe" (id text PRIMARY KEY, value integer NOT NULL)');
    await db.$executeRawUnsafe('CREATE TABLE "AuthorityProbe" (id text PRIMARY KEY, allowed boolean NOT NULL)');
    await db.$executeRawUnsafe('INSERT INTO "AuthorityProbe" VALUES ($1, true)', "actor");

    await proof("actual Prisma join shares Serializable root; nested roots are rejected", async () => {
      await runRootCommit(db, async (context) => {
        assert.equal(typeof context.tx.$transaction, "undefined");
        await joinCommit(context, { isolationLevel: "Serializable" }, async (joined) => {
          assert.equal(joined.tx, context.tx);
          const row = (await joined.tx.$queryRawUnsafe("SHOW transaction_isolation"))[0];
          assert.equal(row.transaction_isolation, "serializable");
        });
        await assert.rejects(runRootCommit(db, () => {}), { code: "DB_COMMIT_NESTED_ROOT_FORBIDDEN" });
      }, { profile: "SECRET_READ" });
    });

    await proof("ReadCommitted cannot silently satisfy Serializable join", async () => {
      await assert.rejects(runRootCommit(db, async (context) => {
        await context.tx.$executeRawUnsafe('INSERT INTO "CommitProbe" VALUES ($1, 1)', "mismatch");
        return joinCommit(context, { isolationLevel: "Serializable" }, () => assert.fail("unsafe join"));
      }), { code: "DB_COMMIT_JOIN_ISOLATION_MISMATCH" });
      const rows = await db.$queryRawUnsafe('SELECT id FROM "CommitProbe" WHERE id=$1', "mismatch");
      assert.equal(rows.length, 0);
    });

    for (const sqlState of ["40001", "40P01"]) {
      for (const method of ["$queryRawUnsafe", "$executeRawUnsafe"]) {
        await proof(`${sqlState} through ${method}: rollback, whole retry and one post-commit hint`, async () => {
          const id = sqlState + method;
          const hints = [];
          const attempts = [];
          await runRootCommit(db, async (context) => {
            attempts.push(context.attempt);
            await context.tx.$executeRawUnsafe('INSERT INTO "CommitProbe" VALUES ($1, $2)', id, context.attempt);
            deferCommitHint(context, id, () => hints.push(context.attempt));
            if (context.attempt === 1) {
              // SQLSTATE literals come only from the closed list above.
              await context.tx[method](`DO $$ BEGIN RAISE EXCEPTION USING ERRCODE='${sqlState}', MESSAGE='controlled conflict'; END $$;`);
            }
            assert.deepEqual(hints, []);
          }, { profile: "SECRET_WRITE", retryBaseMs: 1 });
          assert.deepEqual(attempts, [1, 2]);
          assert.deepEqual(hints, [2]);
          const rows = await db.$queryRawUnsafe('SELECT value FROM "CommitProbe" WHERE id=$1', id);
          assert.deepEqual(rows, [{ value: 2 }]);
          return { attempts, hints, persistedRows: rows.length };
        });
      }
    }

    await proof("revoked authority between attempts is re-read; no partial mutation survives", async () => {
      let revoked = false, attempts = 0;
      const root = { async $transaction(work, options) {
        try { return await db.$transaction(work, options); }
        catch (error) {
          if (!revoked && error.code === "P2010" && error.meta?.code === "40001") {
            revoked = true;
            await db.$executeRawUnsafe('UPDATE "AuthorityProbe" SET allowed=false WHERE id=$1', "actor");
          }
          throw error;
        }
      } };
      await assert.rejects(runRootCommit(root, async (context) => {
        attempts += 1;
        const actor = (await context.tx.$queryRawUnsafe('SELECT allowed FROM "AuthorityProbe" WHERE id=$1', "actor"))[0];
        if (!actor.allowed) throw Object.assign(new Error("revoked"), { code: "ACTOR_REVOKED", status: 403 });
        await context.tx.$executeRawUnsafe('INSERT INTO "CommitProbe" VALUES ($1, 1)', "authority");
        await context.tx.$executeRawUnsafe("DO $$ BEGIN RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='controlled conflict'; END $$;");
      }, { profile: "SECRET_WRITE", retryBaseMs: 1 }), { code: "ACTOR_REVOKED" });
      assert.equal(attempts, 2);
      assert.deepEqual(await db.$queryRawUnsafe('SELECT id FROM "CommitProbe" WHERE id=$1', "authority"), []);
      return { attempts, revoked, persistedRows: 0 };
    });

    await proof("unique violation is not retried as a serialization conflict", async () => {
      await db.$executeRawUnsafe('INSERT INTO "CommitProbe" VALUES ($1, 1)', "unique");
      let attempts = 0;
      await assert.rejects(runRootCommit(db, async (context) => {
        attempts += 1;
        await context.tx.$executeRawUnsafe('INSERT INTO "CommitProbe" VALUES ($1, 2)', "unique");
      }), (error) => error.code === "P2010" && error.meta?.code === "23505");
      assert.equal(attempts, 1);
    });

    await proof("SQL timeout settings do not leak out of the transaction", async () => {
      const read = async (client) => (await client.$queryRawUnsafe("SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement"))[0];
      const before = await read(db);
      await runRootCommit(db, async (ctx) => {
        const settings = await read(ctx.tx);
        assert.notEqual(settings.lock, "0");
        assert.notEqual(settings.statement, "0");
      }, { profile: "SECRET_READ" });
      assert.deepEqual(await read(db), before);
    });

    await proof("authority time remains fresh across domain lock/work boundaries", async () => {
      await runRootCommit(db, async (ctx) => {
        const first = await commitAuthorityNow(ctx);
        await delay(10);
        const second = await commitAuthorityNow(ctx);
        assert.ok(second.getTime() > first.getTime());
      });
    });

    await proof("actual job planner hints cannot escape rollback or an inner callback", async () => {
      const { afterPlanningCommit, publishPlannedJobAvailable } = require("../../src/services/job-planning-repository");
      const { waitForDesktopControlEvents } = require("../../src/services/desktop-control-events");
      const agencyId = "phase5-disposable-proof";
      const events = async () => (await waitForDesktopControlEvents({ agencyId, streamId: "force-immediate-snapshot" })).events;
      const job = { id: "proof-job", agencyId, creatorId: "creator", jobKey: "fetch_earnings" };
      await assert.rejects(runRootCommit(db, async () => {
        await afterPlanningCommit(async () => publishPlannedJobAvailable(job));
        assert.deepEqual(await events(), []);
        throw new Error("outer rollback");
      }), /outer rollback/);
      assert.deepEqual(await events(), []);
      await runRootCommit(db, async () => {
        await afterPlanningCommit(async () => publishPlannedJobAvailable(job));
        assert.deepEqual(await events(), []);
      });
      const published = await events();
      assert.equal(published.length, 1);
      assert.equal(published[0].jobId, job.id);
    });

    const output = { ok: true, prisma: Prisma.prismaVersion.client, engine: "PGlite PostgreSQL WASM via Prisma TCP connector", nativeConcurrentPostgres: false, cases: results };
    if (process.env.PHASE5_PROOF_OUTPUT) fs.writeFileSync(process.env.PHASE5_PROOF_OUTPUT, JSON.stringify(output, null, 2));
    console.log(JSON.stringify({ passed: results.length, ok: true }));
  } finally {
    await db.$disconnect();
    await server.stop();
    await engine.close();
  }
}

const watchdog = setTimeout(() => { console.error("PHASE5_COMMIT_PROOF_DEADLINE_EXCEEDED"); process.exit(1); }, 180000);
main().then(() => clearTimeout(watchdog), error => { clearTimeout(watchdog); console.error(error); process.exitCode = 1; });

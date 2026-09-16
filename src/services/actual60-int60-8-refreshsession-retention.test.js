"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const root = path.resolve(__dirname, "../..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

function loadRetentionService() {
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === "../prisma") return {};
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve("./retention-service")];
    return require("./retention-service");
  } finally {
    Module._load = original;
  }
}

test("admin device kick revokes only the selected device's live refresh sessions", () => {
  const source = read("src/routes/admin.js");
  const start = source.indexOf('router.post("/devices/:id/kick"');
  assert.ok(start >= 0);
  const block = source.slice(start, source.indexOf("// ═", start));
  assert.match(block, /deviceId:\s*device\.id/);
  assert.match(block, /userId:\s*device\.userId[\s\S]*agencyId:\s*device\.agencyId[\s\S]*deviceId:\s*device\.id[\s\S]*revokedAt:\s*null[\s\S]*expiresAt:\s*\{\s*gt:\s*sessionRevokedAt\s*\}/);
});

test("refresh-session retention materializes compact lineage boundary before deleting raw rotations", async () => {
  const { purgeRefreshSessionHistoryBatch } = loadRetentionService();
  const calls = { select: null, boundarySql: null, boundaryArgs: null, deletedIds: null };
  const db = {
    $queryRawUnsafe: async (sql, cutoff, limit) => {
      calls.select = { sql, cutoff, limit };
      return [
        { id: "row-lineaged", authorizationSessionId: "lineage-old" },
        { id: "row-legacy", authorizationSessionId: null },
      ];
    },
    $executeRawUnsafe: async (sql, ...args) => {
      calls.boundarySql = sql;
      calls.boundaryArgs = args;
      return 1;
    },
    refreshSession: {
      deleteMany: async ({ where }) => {
        calls.deletedIds = where.id.in;
        return { count: where.id.in.length };
      },
    },
  };

  const cutoff = new Date("2026-08-01T00:00:00.000Z");
  const result = await purgeRefreshSessionHistoryBatch({ db, cutoff, batchSize: 2000 });
  assert.equal(result.deleted, 2);
  assert.equal(result.materializedBoundaries, 1);
  assert.deepEqual(calls.deletedIds, ["row-lineaged", "row-legacy"]);
  assert.match(calls.select.sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(calls.boundarySql, /INSERT INTO "AuthorizationSessionBoundary"/);
  assert.match(calls.boundarySql, /NOT EXISTS[\s\S]*live\."expiresAt" > clock_timestamp\(\)/);
  assert.match(calls.boundarySql, /ON CONFLICT \("authorizationSessionId"\) DO UPDATE/);
  assert.match(calls.boundarySql, /LEAST\("AuthorizationSessionBoundary"\."endedAt", EXCLUDED\."endedAt"\)/);
  assert.deepEqual(calls.boundaryArgs, ["lineage-old"]);
});

test("retention source keeps raw tokens for an explicit post-expiry security horizon and is scheduler-owned", () => {
  const retention = read("src/services/retention-service.js");
  const scheduler = read("src/services/job-scheduler.js");
  assert.match(retention, /refreshSessionRawHistoryDays:[\s\S]*fallback:\s*30[\s\S]*min:\s*7/);
  assert.match(retention, /ONLINOD_REFRESH_SESSION_RAW_HISTORY_DAYS/);
  assert.match(retention, /\["authSessions", runRefreshSessionRetentionSweep\]/);
  assert.match(scheduler, /"authSessions"/);
});

test("authorization generation collision survives raw RefreshSession purge via AuthorizationSessionBoundary", () => {
  const auth = read("src/services/auth-service.js");
  assert.match(auth, /async function authorizationSessionWasUsed/);
  assert.match(auth, /refreshSession\.findFirst/);
  assert.match(auth, /authorizationSessionBoundary\?\.findUnique/);
  const uses = auth.match(/authorizationSessionWasUsed\(tx, authorizationSessionId\)/g) || [];
  assert.equal(uses.length, 2, "fresh login and legacy adoption must both reject compacted historical lineage reuse");
});

test("terminal authorization lookup retains compact-boundary fallback after raw rotations are purged", () => {
  const telemetry = read("src/services/telemetry-ingest-service.js");
  const start = telemetry.indexOf("async function authorizationSessionEndedAt");
  const end = telemetry.indexOf("async function creatorCatalogGenerationEndedAt", start);
  const block = telemetry.slice(start, end);
  assert.match(block, /AuthorizationSessionBoundary/);
  assert.match(block, /if \(revokedEndedAt\) return revokedEndedAt;/);
});

test("refresh-session retention derives natural terminal time from the latest row in the whole lineage, not only purge candidates", () => {
  const retention = read("src/services/retention-service.js");
  const start = retention.indexOf("async function purgeRefreshSessionHistoryBatch");
  const end = retention.indexOf("async function runRefreshSessionRetentionSweep", start);
  const block = retention.slice(start, end);
  assert.match(block, /SELECT DISTINCT ON \(r\."authorizationSessionId"\)/);
  assert.match(block, /FROM "RefreshSession" r[\s\S]*r\."authorizationSessionId" IN \(\$\{placeholders\}\)/);
  assert.match(block, /ORDER BY r\."authorizationSessionId", r\."expiresAt" DESC, r\."createdAt" DESC, r\."id" DESC/);
  assert.doesNotMatch(block, /JOIN\s+candidates/i, "terminal boundary must not be derived only from the raw rows selected for purge");
});

test("refresh-session retention fails closed when exact raw-delete cardinality changes", async () => {
  const { purgeRefreshSessionHistoryBatch } = loadRetentionService();
  const db = {
    $queryRawUnsafe: async () => [{ id: "raw-1", authorizationSessionId: null }],
    $executeRawUnsafe: async () => 0,
    refreshSession: { deleteMany: async () => ({ count: 0 }) },
  };
  await assert.rejects(
    purgeRefreshSessionHistoryBatch({ db, cutoff: new Date("2026-08-01T00:00:00.000Z"), batchSize: 10 }),
    (error) => error?.code === "REFRESH_SESSION_RETENTION_DELETE_COUNT_MISMATCH",
  );
});

test("agency hard-delete owns compact authorization-history rows and fences late boundary recreation", () => {
  const destructive = read("src/services/phase2-destructive-delete-authority-service.js");
  for (const table of [
    "AuthorizationSessionBoundary",
    "AgencyMemberAccessEpochBoundary",
    "AgencyCreatorCatalogGenerationBoundary",
  ]) assert.match(destructive, new RegExp(`"${table}"`));

  const migration = read("prisma/migrations/20260916034500_actual60_int60_8_authorization_boundary_destructive_fence/migration.sql");
  for (const table of [
    "AuthorizationSessionBoundary",
    "AgencyMemberAccessEpochBoundary",
    "AgencyCreatorCatalogGenerationBoundary",
  ]) assert.match(migration, new RegExp(`'${table}'`));
  assert.match(migration, /phase2_fence_non_fk_tenant_insert_during_agency_delete/);
  assert.match(migration, /BEFORE INSERT OR UPDATE/);
});

test("refresh-session retention has a non-bypassable hourly drain floor and PARTIAL sweeps bypass the normal completion cooldown", async () => {
  const source = read("src/services/retention-service.js");
  assert.match(source, /REFRESH_SESSION_RETENTION_MIN_BATCHES\s*=\s*100/);
  assert.match(source, /Math\.max\(REFRESH_SESSION_RETENTION_MIN_BATCHES,\s*Math\.min\(1000,\s*Math\.floor\(configuredMaxBatches\)\)\)/);
  assert.match(source, /lastOutcome\s*\|\|\s*""\)\.toUpperCase\(\)\s*===\s*"COMPLETE"[\s\S]*minimumInterval\s*>\s*0/);

  const { claimRetentionSweepLease } = loadRetentionService();
  const authorityNow = new Date("2026-09-16T00:00:00.000Z");
  let existing = {
    key: "global_retention_v1",
    ownerToken: "previous",
    leaseUntil: new Date("2026-09-15T23:00:00.000Z"),
    completedAt: new Date("2026-09-15T23:59:00.000Z"),
    lastOutcome: "PARTIAL",
  };
  const db = {
    $transaction: async (work) => work(db),
    $executeRawUnsafe: async () => 1,
    $queryRawUnsafe: async () => [{ authorityNow }],
    retentionSweepLease: {
      findUnique: async () => existing,
      upsert: async ({ create, update }) => {
        existing = { ...(existing || create), ...update, startedAt: authorityNow };
        return existing;
      },
    },
  };

  const partialRetry = await claimRetentionSweepLease({
    db,
    ownerToken: "next-owner",
    fallbackNow: authorityNow,
    minIntervalMs: 24 * 60 * 60 * 1000,
  });
  assert.equal(partialRetry.acquired, true, "PARTIAL retention must be eligible again on the next scheduler tick");

  existing = {
    ...existing,
    ownerToken: "complete-owner",
    completedAt: new Date("2026-09-15T23:59:00.000Z"),
    lastOutcome: "COMPLETE",
  };
  const completeRetry = await claimRetentionSweepLease({
    db,
    ownerToken: "blocked-owner",
    fallbackNow: authorityNow,
    minIntervalMs: 24 * 60 * 60 * 1000,
  });
  assert.equal(completeRetry.acquired, false);
  assert.equal(completeRetry.reason, "recently_completed");
});

test("refresh-session retention exposes bounded catch-up capacity instead of hiding scheduler saturation", () => {
  const retention = read("src/services/retention-service.js");
  const start = retention.indexOf("async function runRefreshSessionRetentionSweep");
  const end = retention.indexOf("function maxDate", start);
  const block = retention.slice(start, end);
  assert.match(block, /saturated:\s*hasMore\s*&&\s*batches\s*>=\s*maxBatches/);
  assert.match(block, /workBudgetRows:\s*batchSize\s*\*\s*maxBatches/);
  assert.match(block, /batchSize,\s*\n\s*maxBatches,/);
});

test("refresh-session purge candidate query is expiry-index shaped rather than lineage-history shaped", () => {
  const schema = read("prisma/schema.prisma");
  assert.match(schema, /model RefreshSession[\s\S]*@@index\(\[expiresAt\]\)/);
  const retention = read("src/services/retention-service.js");
  const start = retention.indexOf("async function purgeRefreshSessionHistoryBatch");
  const end = retention.indexOf("async function runRefreshSessionRetentionSweep", start);
  const block = retention.slice(start, end);
  assert.match(block, /WHERE r\."expiresAt" < \$1[\s\S]*ORDER BY r\."expiresAt" ASC, r\."id" ASC[\s\S]*LIMIT \$2/);
  assert.doesNotMatch(block, /WHERE r\."authorizationSessionId" IS NOT NULL[\s\S]*ORDER BY r\."expiresAt" ASC/,
    "retention candidate discovery must stay global expiry-index shaped rather than scanning lineage history");
});

test("refresh-session retention catch-up floor is paired with the hourly recurring scheduler cadence", () => {
  const scheduler = read("src/services/job-scheduler.js");
  assert.match(scheduler, /const RECURRING_INTERVAL_MS\s*=\s*60\s*\*\s*60\s*\*\s*1000/);
  // Minimum source envelope: 100 batches * min batchSize 100 * 24 hourly
  // PARTIAL retries = 240k rotations/day. At a 15-minute access TTL that is
  // 2.5k continuously active clients at the theoretical 96 rotations/day.
  const minRowsPerDay = 100 * 100 * 24;
  const maxRotationsPerClientDay = 24 * 60 / 15;
  assert.equal(minRowsPerDay, 240_000);
  assert.ok(minRowsPerDay / maxRotationsPerClientDay >= 2_500);
});

test("scheduler keeps retention saturation and continuation visible in production logs", () => {
  const scheduler = read("src/services/job-scheduler.js");
  const start = scheduler.indexOf("function retentionBreakdown");
  const end = scheduler.indexOf("async function maybeRunRetentionSweep", start);
  const block = scheduler.slice(start, end);
  assert.match(block, /hasMore:\s*lane\?\.hasMore\s*===\s*true/);
  assert.match(block, /saturated:\s*items\.filter/);
  assert.match(block, /workBudgetRows:\s*items\.reduce/);
  assert.match(scheduler, /retention sweep done[\s\S]*remainingWork=\$\{result\?\.remainingWork === true\}/);
});

test("compact authorization lineage tombstones have no unclassified production User hard-delete surface", () => {
  const srcRoot = path.join(root, "src");
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.endsWith(".js") && !entry.name.endsWith(".test.js")) {
        const source = fs.readFileSync(file, "utf8");
        if (/\.(?:user)\.delete(?:Many)?\s*\(/.test(source) || /DELETE\s+FROM\s+"User"/i.test(source)) {
          offenders.push(path.relative(root, file).replace(/\\/g, "/"));
        }
      }
    }
  };
  walk(srcRoot);
  assert.deepEqual(offenders, [],
    "a new production User hard-delete surface must explicitly erase AuthorizationSessionBoundary before entering frozen source");
});

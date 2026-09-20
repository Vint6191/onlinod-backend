"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { campaignTransactionLockKey } = require("./campaign-transaction-lock-service");
const preflight = require("../../scripts/database/phase3-campaign-coverage-generation-online-preflight");

const ROOT = path.resolve(__dirname, "../..");
const source = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

function exactIndex(overrides = {}) {
  return {
    name: preflight.CURRENT_RUN_INDEX_NAME,
    valid: true,
    ready: true,
    unique: false,
    keyAttributeCount: 3,
    attributeCount: 3,
    accessMethod: "btree",
    predicate: null,
    expressions: null,
    columns: ["creatorId", "scanRunId", "id"],
    definition: 'CREATE INDEX "CreatorCampaignFanRefreshWork_creator_run_id_idx" ON "CreatorCampaignFanRefreshWork" USING btree ("creatorId", "scanRunId", id)',
    ...overrides,
  };
}

test("A20.12 one creator Campaign lock authority covers ingest, FanData healing, queue and terminal/recovery", () => {
  assert.equal(campaignTransactionLockKey("creator-1"), "analytics-collector:campaigns:creator-1");
  const ledger = source("src/services/creator-analytics-ledger-service.js");
  const fanData = source("src/services/fan-data-authority-service.js");
  const queue = source("src/services/campaign-fan-refresh-queue-service.js");
  const control = source("src/services/analytics-collector-control-service.js");
  assert.match(control, /COLLECTOR_TYPES\.CAMPAIGNS\) return campaignTransactionLockKey\(creatorId\)/);
  assert.match(ledger, /acquireCampaignTransactionLock\(tx, job\.creatorId\)[\s\S]{0,3000}acceptCampaignGeneration\(\{ db: tx, job, deviceId, campaignLockHeld: true \}\)/);
  assert.match(fanData, /acquireCampaignTransactionLock\(tx, scopedCreatorId\)[\s\S]{0,1200}applyGenericFanObservationBulkSql/);
  assert.match(queue, /enqueueUniqueCampaignFanRefreshes[\s\S]{0,1800}acquireCampaignTransactionLock\(db, creatorId\)/);
  assert.match(queue, /finalizeCampaignFanRefreshJob[\s\S]{0,1400}acquireCampaignTransactionLock\(db, creatorId\)[\s\S]{0,1200}lockDemandRowsByRefreshJob/);
  assert.match(queue, /recordCampaignFanRefreshJobFailure[\s\S]{0,1400}acquireCampaignTransactionLock\(db, creatorId\)[\s\S]{0,1200}lockDemandRowsByRefreshJob/);
  assert.doesNotMatch(queue, /discoverFailedCampaignFanRefreshCreatorIds|acquireCampaignTransactionLocks/);
  assert.match(queue, /claimCampaignFanRefreshPromotionSignal[\s\S]*FOR UPDATE OF s SKIP LOCKED[\s\S]*LIMIT 1/);
  assert.match(queue, /runCampaignFanRefreshPromotionMaintenance[\s\S]*acquireCampaignTransactionLock\(tx, creatorId\)[\s\S]*recoverFailedCampaignFanRefreshDemands/);
});

test("A20 final recovery has no production multi-creator lock helper or global debt scan", () => {
  const locks = source("src/services/campaign-transaction-lock-service.js");
  const queue = source("src/services/campaign-fan-refresh-queue-service.js");
  const leases = source("src/services/job-lease-service.js");
  assert.doesNotMatch(locks, /acquireCampaignTransactionLocks/);
  assert.doesNotMatch(queue, /DISTINCT\s+.*creatorId|ROW_NUMBER\(\)\s+OVER\s*\(\s*PARTITION BY/i);
  assert.doesNotMatch(leases, /promoteQueuedCampaignFanRefreshDemands/);
});

test("A20.12 current-run index authority proves exact non-partial plain-column btree definition", () => {
  assert.doesNotThrow(() => preflight.assertCurrentRunIndex(exactIndex()));
  assert.throws(() => preflight.assertCurrentRunIndex(exactIndex({ predicate: '("status" = \'QUEUED\')' })), /must be non-partial/);
  assert.throws(() => preflight.assertCurrentRunIndex(exactIndex({ accessMethod: "hash" })), /must be btree/);
  assert.throws(() => preflight.assertCurrentRunIndex(exactIndex({ attributeCount: 4, columns: ["creatorId", "scanRunId", "id"] })), /exact definition\/order mismatch/);
  assert.throws(() => preflight.assertCurrentRunIndex(exactIndex({ columns: ["creatorId", "id", "scanRunId"] })), /exact definition\/order mismatch/);
});

test("A20.12 index lifecycle uses nonblocking session authority on the dedicated CREATE INDEX connection", async () => {
  const events = [];
  let index = null;
  let sessionLockHeld = false;
  const root = {
    $queryRawUnsafe: async (sql) => {
      assert.match(String(sql), /pg_backend_pid/);
      return [{ pid: 101, isolation: "read committed" }];
    },
  };
  const worker = {
    $queryRawUnsafe: async (sql) => {
      const text = String(sql);
      if (/pg_try_advisory_lock/.test(text)) {
        events.push(["try-lock"]);
        if (sessionLockHeld) return [{ acquired: false, pid: 202, isolation: "read committed" }];
        sessionLockHeld = true;
        return [{ acquired: true, pid: 202, isolation: "read committed" }];
      }
      if (/pg_advisory_unlock/.test(text)) {
        events.push(["unlock"]);
        const released = sessionLockHeld;
        sessionLockHeld = false;
        return [{ pid: 202, released }];
      }
      if (/pg_backend_pid/.test(text)) return [{ pid: 202, isolation: "read committed" }];
      if (/pg_stat_progress_create_index/.test(text)) return [];
      events.push(["worker-inspect", text]);
      return index ? [index] : [];
    },
    $executeRawUnsafe: async (sql) => {
      events.push(["worker-execute", String(sql)]);
      if (/CREATE INDEX CONCURRENTLY/.test(String(sql))) index = exactIndex();
      return 0;
    },
  };
  await preflight.withIndexLifecycleAuthority(
    root,
    (db, contract) => {
      assert.equal(contract.verified, true);
      assert.equal(contract.rootPid, 101);
      assert.equal(contract.lifecyclePid, 202);
      assert.equal(contract.authorityMode, "session_try_lock");
      return preflight.ensureCurrentRunLookupIndex(db);
    },
    { workerDb: worker, requireDistinctConnections: true, pollMs: 0 },
  );
  const lock = events.findIndex(([kind]) => kind === "try-lock");
  const inspect = events.findIndex(([kind]) => kind === "worker-inspect");
  const create = events.findIndex(([kind, sql]) => kind === "worker-execute" && /CREATE INDEX CONCURRENTLY/.test(sql));
  const unlock = events.findIndex(([kind]) => kind === "unlock");
  assert.ok(lock >= 0 && inspect > lock && create > inspect && unlock > create, JSON.stringify(events));
  assert.equal(sessionLockHeld, false);
});

test("A22 concurrent index lifecycle contenders poll without pinning a transaction snapshot", async () => {
  let holder = null;
  let firstEntered = false;
  let secondEntered = false;
  let releaseFirst;
  const firstRelease = new Promise((resolve) => { releaseFirst = resolve; });
  const tries = { 202: 0, 303: 0 };

  function root(pid) {
    return { $queryRawUnsafe: async () => [{ pid, isolation: "read committed" }] };
  }
  function lifecycle(pid) {
    return {
      $queryRawUnsafe: async (sql) => {
        const text = String(sql);
        if (/pg_try_advisory_lock/.test(text)) {
          tries[pid] += 1;
          if (holder === null) { holder = pid; return [{ acquired: true, pid, isolation: "read committed" }]; }
          return [{ acquired: false, pid, isolation: "read committed" }];
        }
        if (/pg_advisory_unlock/.test(text)) {
          const released = holder === pid;
          if (released) holder = null;
          return [{ pid, released }];
        }
        if (/pg_backend_pid/.test(text)) return [{ pid, isolation: "read committed" }];
        return [];
      },
    };
  }

  const first = preflight.withIndexLifecycleAuthority(
    root(101),
    async (_db, contract) => {
      firstEntered = true;
      assert.equal(contract.lifecyclePid, 202);
      await firstRelease;
      return "first";
    },
    { workerDb: lifecycle(202), requireDistinctConnections: true, pollMs: 1, timeoutMs: 1000 },
  );

  while (!firstEntered) await new Promise((resolve) => setTimeout(resolve, 1));
  const second = preflight.withIndexLifecycleAuthority(
    root(102),
    async (_db, contract) => { secondEntered = true; assert.equal(contract.lifecyclePid, 303); return "second"; },
    { workerDb: lifecycle(303), requireDistinctConnections: true, pollMs: 1, timeoutMs: 1000 },
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(secondEntered, false, "peer must poll rather than enter lifecycle work while authority is held");
  assert.ok(tries[303] >= 1, "peer must use nonblocking try-lock polling");
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.equal(holder, null);
});

test("A20.12 lifecycle authority never waits inside an interactive transaction", () => {
  const physical = source("scripts/database/phase3-campaign-coverage-generation-online-preflight.js");
  const start = physical.indexOf("async function withIndexLifecycleAuthority");
  const end = physical.indexOf("\nasync function ensureCurrentRunLookupIndex", start);
  const body = physical.slice(start, end);
  assert.match(body, /pg_try_advisory_lock/);
  assert.match(body, /session_try_lock/);
  assert.doesNotMatch(body, /\$transaction/);
  assert.doesNotMatch(body, /pg_advisory_xact_lock/);
  assert.match(physical, /INDEX_LIFECYCLE_ADVISORY_LOCK_KEY/);
  assert.notEqual(preflight.INDEX_LIFECYCLE_ADVISORY_LOCK_KEY, preflight.PREFLIGHT_ADVISORY_LOCK_KEY);
});


test("A20.12 index repair waits for an active peer build before treating an invalid catalog row as abandoned", async () => {
  const events = [];
  let index = exactIndex({ valid: false, ready: false });
  let progressReads = 0;
  const db = {
    $queryRawUnsafe: async (sql) => {
      const text = String(sql);
      if (/pg_stat_progress_create_index/.test(text)) {
        progressReads += 1;
        events.push(["progress", progressReads]);
        return progressReads === 1 ? [{ pid: 4242, command: "CREATE INDEX CONCURRENTLY", phase: "building index" }] : [];
      }
      events.push(["inspect", index?.valid === true ? "valid" : "invalid"]);
      return index ? [index] : [];
    },
    $executeRawUnsafe: async (sql) => {
      const text = String(sql);
      if (/DROP INDEX CONCURRENTLY/.test(text)) {
        events.push(["drop"]);
        index = null;
      }
      if (/CREATE INDEX CONCURRENTLY/.test(text)) {
        events.push(["create"]);
        index = exactIndex();
      }
      return 0;
    },
  };
  const result = await preflight.ensureCurrentRunLookupIndex(db, { pollMs: 0, timeoutMs: 1000 });
  assert.equal(result.ensured, true);
  const firstProgress = events.findIndex(([kind]) => kind === "progress");
  const drop = events.findIndex(([kind]) => kind === "drop");
  assert.ok(firstProgress >= 0 && drop > firstProgress, JSON.stringify(events));
  assert.doesNotThrow(() => preflight.assertCurrentRunIndex(index));
});

test("A20.12 proof contract includes full ingest race and full preflight lifecycle concurrency", () => {
  const runner = source("scripts/audit/phase3-a20-postgres-proof.js");
  assert.match(runner, /phase3-campaign-closure-a20-12\.integration\.test\.js/);
  assert.match(runner, /phase3-a20-index-lifecycle-concurrency\.js/);
  assert.match(runner, /A20_12_INDEX_ABSENT_CONCURRENCY_PASS/);
  assert.match(runner, /A20_12_INDEX_INVALID_RECOVERY_PASS/);
});

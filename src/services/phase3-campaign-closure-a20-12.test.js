"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  campaignTransactionLockKey,
  acquireCampaignTransactionLocks,
} = require("./campaign-transaction-lock-service");
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
  assert.match(queue, /discoverFailedCampaignFanRefreshCreatorIds[\s\S]*acquireCampaignTransactionLocks\(db, lockedCreatorIds\)[\s\S]*recoverFailedCampaignFanRefreshDemandsSetBased/);
});

test("A20.12 multi-creator authority locks creator keys in deterministic sorted order with one SQL call", async () => {
  const calls = [];
  const db = { $executeRawUnsafe: async (sql, keys) => { calls.push({ sql: String(sql), keys }); return 0; } };
  const result = await acquireCampaignTransactionLocks(db, ["creator-z", "creator-a", "creator-z"]);
  assert.deepEqual(result.keys, [
    "analytics-collector:campaigns:creator-a",
    "analytics-collector:campaigns:creator-z",
  ]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /ordered_scope_keys AS MATERIALIZED/);
  assert.match(calls[0].sql, /unnest\(\$1::text\[\]\)/);
  assert.match(calls[0].sql, /ORDER BY scope_key ASC/);
  assert.match(calls[0].sql, /FROM ordered_scope_keys/);
  assert.deepEqual(calls[0].keys, result.keys);
});

test("A20.12 current-run index authority proves exact non-partial plain-column btree definition", () => {
  assert.doesNotThrow(() => preflight.assertCurrentRunIndex(exactIndex()));
  assert.throws(() => preflight.assertCurrentRunIndex(exactIndex({ predicate: '("status" = \'QUEUED\')' })), /must be non-partial/);
  assert.throws(() => preflight.assertCurrentRunIndex(exactIndex({ accessMethod: "hash" })), /must be btree/);
  assert.throws(() => preflight.assertCurrentRunIndex(exactIndex({ attributeCount: 4, columns: ["creatorId", "scanRunId", "id"] })), /exact definition\/order mismatch/);
  assert.throws(() => preflight.assertCurrentRunIndex(exactIndex({ columns: ["creatorId", "id", "scanRunId"] })), /exact definition\/order mismatch/);
});

test("A20.12 deploy owner spans index inspect/drop/create/verify lifecycle outside the owner transaction", async () => {
  const events = [];
  let index = null;
  const root = {
    $transaction: async (work, options) => {
      events.push(["owner-begin", options]);
      const ownerTx = {
        $executeRawUnsafe: async (sql) => { events.push(["owner-lock", String(sql)]); return 0; },
      };
      const result = await work(ownerTx);
      events.push(["owner-commit"]);
      return result;
    },
    $queryRawUnsafe: async (sql) => {
      events.push(["root-inspect", String(sql)]);
      return index ? [index] : [];
    },
    $executeRawUnsafe: async (sql) => {
      events.push(["root-execute", String(sql)]);
      if (/CREATE INDEX CONCURRENTLY/.test(String(sql))) index = exactIndex();
      return 0;
    },
  };
  await preflight.withIndexLifecycleAuthority(root, (db) => preflight.ensureCurrentRunLookupIndex(db));
  const lock = events.findIndex(([kind]) => kind === "owner-lock");
  const inspect = events.findIndex(([kind]) => kind === "root-inspect");
  const create = events.findIndex(([kind, sql]) => kind === "root-execute" && /CREATE INDEX CONCURRENTLY/.test(sql));
  const commit = events.findIndex(([kind]) => kind === "owner-commit");
  assert.ok(lock >= 0 && inspect > lock && create > inspect && commit > create, JSON.stringify(events));
  assert.equal(events[0][1].timeout, preflight.INDEX_LIFECYCLE_AUTHORITY_TIMEOUT_MS);
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

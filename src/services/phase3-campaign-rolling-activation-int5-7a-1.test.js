"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("INT5.7A-1 claim wire capability fences fetch_campaigns from old Desktop", () => {
  const route = read("src/routes/jobs.js");
  const lease = read("src/services/job-lease-service.js");
  assert.match(route, /campaignCausalObservationV1:\s*z\.boolean\(\)/);
  assert.match(route, /capabilities:\s*input\.capabilities/);
  assert.match(lease, /capabilities\?\.campaignCausalObservationV1 !== true/);
  assert.match(lease, /allowedJobKeys = allowedJobKeys\.filter\(\(jobKey\) => jobKey !== "fetch_campaigns"\)/);
});

test("INT5.7A-1 bridge migration creates inactive durable barrier instead of activating during mixed replicas", () => {
  const migration = read("prisma/migrations/20260917213000_phase3_campaign_causal_v1_bridge/migration.sql");
  assert.match(migration, /phase3\.campaignCausalObservationV1/);
  assert.match(migration, /"active":false/);
  assert.doesNotMatch(migration, /UPDATE\s+"JobInstance"/i);
});

test("INT5.7A-1 Campaign current projection locks activation barrier and rejects tokenless rows after activation", () => {
  const ledger = read("src/services/creator-analytics-ledger-service.js");
  const activation = read("src/services/campaign-causal-activation-service.js");
  assert.match(ledger, /campaignCausalV1State\(\{ db: tx, lockForCommit: true \}\)/);
  assert.match(ledger, /activation\.active === true \|\| Number\(object\(job\.params\)\.observationTokenVersion \|\| 0\) >= 1/);
  assert.match(ledger, /if \(!activation\.active && !campaignFanValueObservationTokenRequired\(job\)\) return fallbackObservedAt/);
  assert.match(activation, /FOR SHARE/);
  assert.match(activation, /FOR UPDATE/);
});

test("INT5.7A-1 activation transaction revokes all live Campaign owners and stamps protocol before setting active", () => {
  const activation = read("src/services/campaign-causal-activation-service.js");
  const cleanupAt = activation.indexOf('DELETE FROM "FanObservationReadLease"');
  const revokeAt = activation.indexOf('UPDATE "JobInstance" AS j', cleanupAt);
  const revisionAt = activation.indexOf('"leaseRevision" = j."leaseRevision" + 1', revokeAt);
  const activeAt = activation.indexOf('await tx.systemSetting.update');
  assert.ok(cleanupAt >= 0 && revokeAt > cleanupAt && revisionAt > revokeAt);
  assert.ok(activeAt > revisionAt, "durable activation must become visible only after old owners are fenced and cleaned");
  assert.match(activation, /observationTokenVersion/);
  assert.match(activation, /observationReadLeaseVersion/);
});

test("INT5.7A-1 activation runtime set-based cutover revokes old owners and activates last", async () => {
  const prismaModule = require.resolve("../prisma");
  require.cache[prismaModule] = { id: prismaModule, filename: prismaModule, loaded: true, exports: {} };
  delete require.cache[require.resolve("./campaign-causal-activation-service")];
  const { activateCampaignCausalV1 } = require("./campaign-causal-activation-service");
  const events = [];
  let rawCall = 0;
  const tx = {
    $queryRawUnsafe: async (sql) => {
      rawCall += 1;
      const text = String(sql);
      events.push(["sql", text]);
      if (rawCall === 1) return []; // live Campaign JobInstance rows locked first
      if (rawCall === 2) return [{ value: { active: false, epoch: 3, writerGenerationActive: false, claimGenerationActive: false } }];
      if (/FROM pg_trigger/.test(text)) return [
        { triggerName: "phase3_campaign_writer_generation_ingest_guard_trg", tableName: "AnalyticsIngestBatch", enabled: "O", functionName: "phase3_campaign_writer_generation_guard", functionDefinition: "current_setting(onlinod.campaign_writer_generation) CAMPAIGN_WRITER_GENERATION_RETIRED" },
        { triggerName: "phase3_campaign_writer_generation_identity_guard_trg", tableName: "CreatorFan", enabled: "O", functionName: "phase3_campaign_writer_generation_guard", functionDefinition: "current_setting(onlinod.campaign_writer_generation) CAMPAIGN_WRITER_GENERATION_RETIRED" },
        { triggerName: "phase3_campaign_writer_generation_value_guard_trg", tableName: "CreatorFanValueCurrent", enabled: "O", functionName: "phase3_campaign_writer_generation_guard", functionDefinition: "current_setting(onlinod.campaign_writer_generation) CAMPAIGN_WRITER_GENERATION_RETIRED" },
        { triggerName: "phase3_campaign_claim_generation_guard_trg", tableName: "JobInstance", enabled: "O", functionName: "phase3_campaign_claim_generation_guard", functionDefinition: "current_setting(onlinod.campaign_claim_generation) CAMPAIGN_CLAIM_GENERATION_RETIRED" },
      ];
      if (/FROM "_prisma_migrations"/.test(text)) return [
        { migrationName: "20260918003000_phase3_campaign_writer_generation_fence", finishedAt: new Date(), rolledBackAt: null },
        { migrationName: "20260918150000_phase3_campaign_claim_generation_fence", finishedAt: new Date(), rolledBackAt: null },
      ];
      return [{ revoked: 1, stamped: 2 }];
    },
    systemSetting: {
      update: async (args) => { events.push(["activate", args]); return args.data; },
    },
  };
  const db = {
    $transaction: async (work, options) => {
      assert.equal(options.isolationLevel, "ReadCommitted");
      assert.ok(options.maxWait > 0 && options.maxWait <= 10_000);
      assert.ok(options.timeout > 100_000 && options.timeout <= 110_000, "admission and execution share the 120s root deadline");
      return work(tx);
    },
  };
  const result = await activateCampaignCausalV1({ db, activatedBy: "test" });
  assert.deepEqual(result, { active: true, writerGenerationActive: true, claimGenerationActive: true, writerGeneration: 1, alreadyActive: false, epoch: 4, revoked: 1, stamped: 2 });
  assert.match(events[0][1], /JobInstance[\s\S]*FOR UPDATE/);
  assert.match(events[1][1], /SystemSetting[\s\S]*FOR UPDATE/);
  const cutoverSql = events[4][1];
  assert.match(cutoverSql, /DELETE FROM "FanObservationReadLease"[\s\S]*r\."leaseRevision" = c\."leaseRevision"/);
  assert.match(cutoverSql, /"leaseRevision" = j\."leaseRevision" \+ 1/);
  assert.match(cutoverSql, /"status" = 'SCHEDULED'/);
  assert.match(cutoverSql, /observationTokenVersion/);
  assert.equal(events.at(-1)[0], "activate");
  assert.equal(events.at(-1)[1].data.value.active, true);
  assert.equal(events.at(-1)[1].data.value.writerGenerationActive, true);
  assert.equal(events.at(-1)[1].data.value.claimGenerationActive, true);
  assert.equal(events.at(-1)[1].data.value.writerGeneration, 1);
});

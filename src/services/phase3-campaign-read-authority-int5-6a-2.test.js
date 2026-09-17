"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const prismaModule = require.resolve("../prisma");
require.cache[prismaModule] = { id: prismaModule, filename: prismaModule, loaded: true, exports: {} };
const { stopManualCampaignScan } = require("./campaign-scan-control-service");

const root = path.resolve(__dirname, "../..");
function source(rel) { return fs.readFileSync(path.join(root, rel), "utf8"); }

test("INT5.6A-2 fetch_campaigns is a causal-read job with two exact server-owned purposes", () => {
  const jobs = source("src/services/job-lease-service.js");
  assert.match(jobs, /fetch_campaigns:\s*Object\.freeze\(\["campaign_claimers_page", "campaign_fan_values"\]\)/);
  assert.match(jobs, /FAN_OBSERVATION_READ_LEASE_JOB_KEYS = new Set\(Object\.keys\(FAN_OBSERVATION_READ_PURPOSE_BY_JOB_KEY\)\)/);
  assert.match(jobs, /FAN_OBSERVATION_READ_LEASE_JOB_KEYS\.has\(String\(candidate\.jobKey \|\| ""\)\)[\s\S]*observationTokenVersion:\s*1,\s*observationReadLeaseVersion:\s*1/,
    "first post-cutover claim must upgrade queued campaign jobs before execution");
  assert.match(jobs, /const allowed = FAN_OBSERVATION_READ_PURPOSE_BY_JOB_KEY\[String\(job\?\.jobKey \|\| ""\)\] \|\| null/);
  assert.match(jobs, /!Array\.isArray\(allowed\)[\s\S]*!allowed\.includes\(requested\)/);
  assert.match(jobs, /FAN_OBSERVATION_READ_LEASE_PURPOSE_FORBIDDEN/);
});

test("INT5.6A-2 every current campaign scheduler opts new jobs into causal token and read-lease protocol", () => {
  const orchestrator = source("src/services/creator-analytics-sync-orchestrator.js");
  const manual = source("src/services/campaign-scan-control-service.js");
  const orchestratorPairs = orchestrator.match(/observationTokenVersion:\s*1,\s*\n\s*observationReadLeaseVersion:\s*1,/g) || [];
  assert.equal(orchestratorPairs.length, 2, "initial and catchup campaign schedulers must both carry the causal contract");
  assert.match(manual, /fanValueBatchSize:\s*20,[\s\S]*observationTokenVersion:\s*1,[\s\S]*observationReadLeaseVersion:\s*1,/,
    "manual campaign scans must carry the same causal contract");
});

test("INT5.6A-2 campaign authority remains purpose-exact instead of accepting a generic campaign read purpose", () => {
  const jobs = source("src/services/job-lease-service.js");
  assert.doesNotMatch(jobs, /fetch_campaigns:\s*Object\.freeze\(\["fetch_campaigns"\]\)/);
  assert.doesNotMatch(jobs, /fetch_campaigns:\s*Object\.freeze\(\["campaign"\]\)/);
  assert.match(jobs, /return requested;/);
});


test("INT5.6A-2 manual campaign pause CAS-revokes the owner and exact read lease in one transaction", async () => {
  const authorityNow = new Date("2026-09-17T16:40:00.000Z");
  const active = {
    id: "campaign-job-1",
    creatorId: "creator-1",
    agencyId: "agency-1",
    jobKey: "fetch_campaigns",
    status: "CLAIMED",
    claimedByDeviceId: "device-1",
    leaseRevision: 7,
    lastProgressAt: null,
    params: { manualCampaignScan: true, manualCampaignScanVersion: 1 },
  };
  const order = [];
  let pauseWhere = null;
  let cleanupWhere = null;
  const db = {
    async $queryRawUnsafe(sql) {
      assert.match(String(sql), /clock_timestamp\(\)/);
      return [{ authorityNow }];
    },
    async $transaction(work) {
      order.push("tx-begin");
      const value = await work(this);
      order.push("tx-end");
      return value;
    },
    jobInstance: {
      async findMany() { return [active]; },
      async updateMany({ where }) {
        order.push("pause-cas");
        pauseWhere = where;
        return { count: 1 };
      },
      async findUnique() { return { ...active, status: "PAUSED", leaseRevision: 8, claimedByDeviceId: null }; },
    },
    fanObservationReadLease: {
      async deleteMany({ where }) {
        order.push("read-lease-cleanup");
        cleanupWhere = where;
        return { count: 1 };
      },
    },
  };

  const result = await stopManualCampaignScan({ db, creatorId: "creator-1", now: authorityNow });
  assert.equal(result.action, "paused");
  assert.equal(pauseWhere.leaseRevision, 7, "pause must CAS the owner revision it observed");
  assert.deepEqual(cleanupWhere, {
    creatorId: "creator-1",
    jobId: "campaign-job-1",
    deviceId: "device-1",
    leaseRevision: 7,
  });
  assert.deepEqual(order.slice(0, 4), ["tx-begin", "pause-cas", "read-lease-cleanup", "tx-end"]);
});

test("INT5.6A-2 source keeps campaign pause owner-loss cleanup inside the same transaction", () => {
  const control = source("src/services/campaign-scan-control-service.js");
  assert.match(control, /const pause = async \(tx\) => \{[\s\S]*jobInstance\.updateMany[\s\S]*leaseRevision: active\.leaseRevision[\s\S]*fanObservationReadLease\?\.deleteMany[\s\S]*jobId: active\.id[\s\S]*deviceId: active\.claimedByDeviceId[\s\S]*leaseRevision: active\.leaseRevision/);
  assert.match(control, /db\.\$transaction\(pause\)/);
});

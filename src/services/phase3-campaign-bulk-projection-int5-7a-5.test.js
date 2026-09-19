"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { consumeFanObservationTokensBatch } = require("./fan-observation-token-service");
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "../prisma" && (parent?.filename?.endsWith("creator-analytics-ledger-service.js") || parent?.filename?.endsWith("analytics-collector-control-service.js") || parent?.filename?.endsWith("campaign-causal-activation-service.js"))) return {};
  return originalLoad.call(this, request, parent, isMain);
};
const { ingestCampaignChunk } = require("./creator-analytics-ledger-service");
Module._load = originalLoad;

const ledger = fs.readFileSync(path.join(__dirname, "creator-analytics-ledger-service.js"), "utf8");
const fanData = fs.readFileSync(path.join(__dirname, "fan-data-authority-service.js"), "utf8");
const tokens = fs.readFileSync(path.join(__dirname, "fan-observation-token-service.js"), "utf8");

function scopeHash(purpose, fanId) {
  return crypto.createHash("sha256").update(`${purpose}|${fanId}`).digest("hex");
}

function tokenRow(index, overrides = {}) {
  const fanId = `fan-${index}`;
  return {
    id: BigInt(index),
    token: `token-${index}`,
    jobId: "job-1",
    deliveryId: null,
    deviceId: "device-1",
    leaseRevision: 7,
    purpose: "campaign_fan_values",
    scopeHash: scopeHash("campaign_fan_values", fanId),
    observedAt: new Date(`2026-09-17T18:00:${String(index).padStart(2, "0")}.000Z`),
    consumedAt: null,
    ...overrides,
  };
}

test("INT5.7A-5 consumes a bounded Campaign token set with one read and one delete phase", async () => {
  const rows = Array.from({ length: 20 }, (_, index) => tokenRow(index + 1));
  let reads = 0;
  let deletes = 0;
  const db = {
    fanObservationToken: {
      findMany: async ({ where }) => {
        reads += 1;
        assert.equal(where.token.in.length, 20);
        return rows;
      },
      deleteMany: async ({ where }) => {
        deletes += 1;
        assert.equal(where.token.in.length, 20);
        assert.equal(where.jobId, "job-1");
        assert.equal(where.deviceId, "device-1");
        assert.equal(where.leaseRevision, 7);
        assert.equal(where.consumedAt, null);
        return { count: 20 };
      },
    },
  };
  const requests = rows.map((row, index) => ({
    token: row.token,
    purpose: "campaign_fan_values",
    subjects: [`fan-${index + 1}`],
  }));
  const consumed = await consumeFanObservationTokensBatch({
    db,
    job: { id: "job-1" },
    deviceId: "device-1",
    leaseRevision: 7,
    requests,
  });
  assert.equal(consumed.length, 20);
  assert.equal(reads, 1);
  assert.equal(deletes, 1);
  assert.equal(consumed[0].observedAt.toISOString(), "2026-09-17T18:00:01.000Z");
  assert.equal(consumed[19].observedAt.toISOString(), "2026-09-17T18:00:20.000Z");
});

test("INT5.7A-5 validates every exact token scope before consuming any token", async () => {
  const rows = [tokenRow(1), tokenRow(2, { scopeHash: scopeHash("campaign_fan_values", "wrong-fan") })];
  let deletes = 0;
  const db = {
    fanObservationToken: {
      findMany: async () => rows,
      deleteMany: async () => { deletes += 1; return { count: 2 }; },
    },
  };
  await assert.rejects(
    consumeFanObservationTokensBatch({
      db,
      job: { id: "job-1" },
      deviceId: "device-1",
      leaseRevision: 7,
      requests: [
        { token: "token-1", purpose: "campaign_fan_values", subjects: ["fan-1"] },
        { token: "token-2", purpose: "campaign_fan_values", subjects: ["fan-2"] },
      ],
    }),
    /FAN_OBSERVATION_TOKEN_INVALID/,
  );
  assert.equal(deletes, 0, "an invalid member must abort before the bounded consume phase");
});

test("INT5.7A-5 Campaign batch uses canonical bulk FanData projection after replay fence", () => {
  const fn = ledger.slice(ledger.indexOf("async function ingestCampaignFanValuesBatchChunk"), ledger.indexOf("async function completeCampaignScan"));
  const replayAt = fn.indexOf('if (replay && ["COMMITTED", "PARTIAL"].includes(batch.status))');
  const consumeAt = fn.indexOf("consumeFanObservationTokensBatch");
  const projectAt = fn.indexOf("projectFanObservationBatch");
  assert.ok(replayAt >= 0 && consumeAt > replayAt && projectAt > consumeAt);
  assert.doesNotMatch(fn, /upsertCampaignFanValueTx\(/, "batch path must not re-enter scalar value projection");
  assert.doesNotMatch(fn, /projectFanIdentity\(/, "batch path must not directly invoke scalar identity projection");
  assert.doesNotMatch(fn, /projectFanValue\(/, "batch path must not directly invoke scalar value projection");
  assert.match(fn, /allowedSources: \["CAMPAIGN_CLAIMER"\]/);
  assert.match(fn, /observedAtPolicy: "TRUSTED_INPUT"/);
  assert.match(fn, /scanRunId,/);
});

test("INT5.7A-5 reuses the existing single-lock generic FanData authority", () => {
  const bulk = fanData.slice(fanData.indexOf("async function applyGenericFanObservationBulkSql"), fanData.indexOf("async function projectFanObservationBatch"));
  assert.match(bulk, /await lockFanAuthorityScope\(tx, scope\.creatorId, fanIds\)/);
  assert.match(bulk, /INSERT INTO "CreatorFan"/);
  assert.match(bulk, /INSERT INTO "CreatorFanValueCurrent"/);
  assert.match(tokens, /async function consumeFanObservationTokensBatch/);
  assert.match(tokens, /fanObservationToken\.findMany/);
  assert.match(tokens, /fanObservationToken\.deleteMany/);
});


test("INT5.7A-5 a full 50-claimer page uses one canonical FanData lock for identity plus embedded values", async () => {
  const rawSql = [];
  const fanIds = Array.from({ length: 50 }, (_, index) => `fan-${index + 1}`);
  const tx = {
    $executeRawUnsafe: async (sql, ...args) => { rawSql.push({ sql: String(sql), args }); return 1; },
    $queryRawUnsafe: async (sql, ...args) => {
      rawSql.push({ sql: String(sql), args });
      if (/clock_timestamp\(\)/.test(String(sql))) return [{ authorityNow: new Date("2026-09-17T18:00:02.000Z") }];
      if (/INSERT INTO "CreatorCampaignFan"/.test(String(sql))) {
        return JSON.parse(args[0]).map((row) => ({
          fanRecordId: row.fanRecordId, existed: false, newerGeneration: false,
          alreadyObservedInCurrentRun: false, historicalBoundary: false, wrote: true,
        }));
      }
      return [];
    },
    analyticsIngestBatch: {
      findUnique: async () => null,
      create: async ({ data }) => ({ id: "batch-1", status: "RECEIVED", ...data }),
      update: async ({ data }) => ({ id: "batch-1", ...data }),
    },
    creatorCampaignCollectionState: {
      findUnique: async () => null,
      upsert: async ({ create }) => ({ id: "state-1", ...create }),
      update: async ({ data }) => ({ id: "state-1", ...data }),
    },
    creatorCampaign: {
      findUnique: async () => ({ id: "campaign-db-1" }),
    },
    creatorCampaignFrontierFan: {
      findMany: async () => [],
      deleteMany: async () => ({ count: 0 }),
      createMany: async () => ({ count: 0 }),
    },
    creatorCampaignFan: {
      findUnique: async () => null,
      upsert: async ({ create }) => create,
    },
    creatorFan: {
      findMany: async ({ where }) => {
        const ids = where?.onlyFansUserId?.in || [];
        return ids.map((onlyFansUserId) => ({
          id: `db-${onlyFansUserId}`,
          creatorId: "creator-1",
          onlyFansUserId,
          usernameAuthorityVersion: null,
          displayNameAuthorityVersion: null,
          avatarAuthorityVersion: null,
          headerAuthorityVersion: null,
          identityAuthorityVersion: null,
        }));
      },
    },
    creatorFanValueCurrent: { findMany: async () => [] },
  };
  const db = { ...tx, $transaction: async (work) => work(tx) };
  const job = {
    id: "job-1",
    agencyId: "agency-1",
    creatorId: "creator-1",
    leaseRevision: 1,
    params: {
      collectionContractVersion: 1,
      collectionType: "CAMPAIGNS",
      collectionMode: "full",
      collectionGeneration: "scan-1",
      collectionRequestedAt: "2026-09-17T18:00:00.000Z",
      collectionReason: "TEST",
    },
  };
  const claimers = fanIds.map((fanId, index) => ({
    id: `claim-${index + 1}`,
    userId: fanId,
    username: `user-${index + 1}`,
    displayName: `User ${index + 1}`,
    embeddedValue: {
      observedAt: "2026-09-17T18:00:01.000Z",
      totalNetCents: 1000 + index,
      messagesNetCents: 1000 + index,
      subscriptionsNetCents: 0,
      tipsNetCents: 0,
      postsNetCents: 0,
      streamsNetCents: 0,
    },
  }));
  const result = await ingestCampaignChunk({
    db,
    job,
    deviceId: "device-1",
    chunk: {
      kind: "campaign_claimers_page",
      schemaVersion: 4,
      collectorVersion: "campaigns-v8",
      scanRunId: "scan-1",
      batchKey: "run:scan-1:campaigns-v8:claimers:test",
      externalCampaignId: "campaign-1",
      pageNumber: 2,
      campaignComplete: false,
      scannerRejected: 0,
      claimers,
    },
  });
  assert.equal(result.inserted, 50);
  const locks = rawSql.filter((entry) => /pg_advisory_xact_lock/.test(entry.sql));
  assert.equal(locks.length, 3, "two fixed Campaign/collector locks + one FanData authority lock");
  const fanUpserts = rawSql.filter((entry) => /INSERT INTO "CreatorFan"/.test(entry.sql));
  const valueUpserts = rawSql.filter((entry) => /INSERT INTO "CreatorFanValueCurrent"/.test(entry.sql));
  const membershipUpserts = rawSql.filter((entry) => /INSERT INTO "CreatorCampaignFan"/.test(entry.sql));
  assert.equal(fanUpserts.length, 1);
  assert.equal(valueUpserts.length, 1);
  assert.equal(membershipUpserts.length, 1, "the entire claimer page must use one set-based membership statement");
  assert.equal(JSON.parse(membershipUpserts[0].args[0]).length, 50);
  assert.equal(JSON.parse(fanUpserts[0].args[0]).length, 50);
  assert.equal(JSON.parse(valueUpserts[0].args[0]).length, 50);
});

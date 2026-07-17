"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const prismaModule = require.resolve("../prisma");
require.cache[prismaModule] = { id: prismaModule, filename: prismaModule, loaded: true, exports: {} };
delete require.cache[require.resolve("./dialog-intelligence-service")];
const { restartCreatorDialogPlanTx } = require("./dialog-intelligence-service");

function matchesValue(actual, expected) {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if (Array.isArray(expected.in)) return expected.in.includes(actual);
    if (Object.hasOwn(expected, "not")) return actual !== expected.not;
    if (Object.hasOwn(expected, "lt")) return Number(actual) < Number(expected.lt);
  }
  return actual === expected;
}

function matches(row, where = {}) {
  for (const [key, expected] of Object.entries(where || {})) {
    if (key === "id" && expected?.in) {
      if (!expected.in.includes(row.id)) return false;
      continue;
    }
    if (key === "activeRunId" && expected?.in) {
      if (!expected.in.includes(row.activeRunId)) return false;
      continue;
    }
    if (key === "status" || key === "mode" || key === "dialogId" || key === "generation") {
      if (!matchesValue(row[key], expected)) return false;
      continue;
    }
    if (row[key] !== expected) return false;
  }
  return true;
}

function apply(row, data = {}) {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "increment")) {
      row[key] = Number(row[key] || 0) + Number(value.increment || 0);
    } else {
      row[key] = value;
    }
  }
  row.updatedAt = new Date();
  return row;
}

function createDb({ enabled = true } = {}) {
  const oldGeneration = 1_752_777_777;
  const runs = [
    {
      id: "old-discovery", jobId: "old-discovery-job", agencyId: "agency-1", creatorId: "creator-1",
      dialogId: "__dialog_discovery__", mode: "discovery", status: "RUNNING", generation: oldGeneration,
      createdAt: new Date("2026-07-17T16:00:00.000Z"), updatedAt: new Date("2026-07-17T16:00:00.000Z"),
    },
    {
      id: "old-history", jobId: "old-history-job", agencyId: "agency-1", creatorId: "creator-1",
      dialogId: "dialog-1", mode: "initial", status: "QUEUED", generation: oldGeneration,
      createdAt: new Date("2026-07-17T16:01:00.000Z"), updatedAt: new Date("2026-07-17T16:01:00.000Z"),
    },
  ];
  const jobs = [
    { id: "old-discovery-job", status: "CLAIMED", leaseRevision: 3, params: { scanRunId: "old-discovery", dialogId: "__dialog_discovery__" }, continuation: { mode: "discovery", page: 1288, offset: 1590, dialogsFound: 12804 } },
    { id: "old-history-job", status: "SCHEDULED", leaseRevision: 1, params: { scanRunId: "old-history", dialogId: "dialog-1" } },
  ];
  const states = [
    {
      id: "discovery-state", agencyId: "agency-1", creatorId: "creator-1", dialogId: "__dialog_discovery__",
      status: "RUNNING", generation: oldGeneration, activeRunId: "old-discovery", activeJobId: "old-discovery-job",
      initialScanComplete: false,
    },
    {
      id: "dialog-state", agencyId: "agency-1", creatorId: "creator-1", dialogId: "dialog-1",
      status: "QUEUED", generation: oldGeneration, activeRunId: "old-history", activeJobId: "old-history-job",
      initialScanComplete: false,
    },
  ];
  let runSeq = 0;
  let jobSeq = 0;

  const db = {
    _runs: runs,
    _jobs: jobs,
    _states: states,
    _oldGeneration: oldGeneration,
    creatorAccount: {
      findFirst: async () => ({ id: "creator-1", agencyId: "agency-1", remoteId: "of-1", status: "READY" }),
    },
    moduleSetting: {
      findUnique: async () => ({ enabled, status: enabled ? "active" : "disabled", config: {} }),
    },
    dialogScanRun: {
      findFirst: async ({ where = {}, orderBy = [] } = {}) => {
        const found = runs.filter((row) => matches(row, where));
        if (Array.isArray(orderBy) && orderBy.some((item) => item.generation === "desc")) {
          found.sort((a, b) => Number(b.generation || 0) - Number(a.generation || 0));
        } else {
          found.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        }
        return found[0] || null;
      },
      findMany: async ({ where = {} } = {}) => runs.filter((row) => matches(row, where)),
      create: async ({ data }) => {
        const row = { id: `new-run-${++runSeq}`, jobId: null, pagesProcessed: 0, messagesProcessed: 0, mediaProcessed: 0, createdAt: new Date(), updatedAt: new Date(), ...data };
        runs.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = runs.find((item) => item.id === where.id);
        if (!row) throw new Error(`missing run ${where.id}`);
        return apply(row, data);
      },
      updateMany: async ({ where, data }) => {
        const selected = runs.filter((row) => matches(row, where));
        selected.forEach((row) => apply(row, data));
        return { count: selected.length };
      },
    },
    jobInstance: {
      findUnique: async ({ where }) => jobs.find((row) => row.id === where.id) || null,
      create: async ({ data }) => {
        const row = { id: `new-job-${++jobSeq}`, leaseRevision: 0, createdAt: new Date(), updatedAt: new Date(), ...data };
        jobs.push(row);
        return row;
      },
      updateMany: async ({ where, data }) => {
        const selected = jobs.filter((row) => matches(row, where));
        selected.forEach((row) => apply(row, data));
        return { count: selected.length };
      },
    },
    dialogScanState: {
      findUnique: async ({ where }) => states.find((row) => row.creatorId === where.creatorId_dialogId.creatorId && row.dialogId === where.creatorId_dialogId.dialogId) || null,
      updateMany: async ({ where, data }) => {
        const selected = states.filter((row) => matches(row, where));
        selected.forEach((row) => apply(row, data));
        return { count: selected.length };
      },
      upsert: async ({ where, create, update }) => {
        const key = where.creatorId_dialogId;
        let row = states.find((item) => item.creatorId === key.creatorId && item.dialogId === key.dialogId);
        if (!row) {
          row = { id: `state-${states.length + 1}`, createdAt: new Date(), updatedAt: new Date(), ...create };
          states.push(row);
          return row;
        }
        return apply(row, update);
      },
    },
  };
  return db;
}

test("explicit full creator rescan supersedes the old plan and creates its replacement in the same tx body", async () => {
  const db = createDb();
  const result = await restartCreatorDialogPlanTx(db, {
    agencyId: "agency-1",
    creatorId: "creator-1",
    childMode: "initial",
    forceChildFull: true,
    source: "vault_sales_ui",
    pageLimit: 50,
    overlapPages: 2,
    maxPages: 5000,
    priority: 90,
    userId: "user-1",
  });

  assert.equal(result.created, true);
  assert.equal(result.supersededHistoryRuns, 2);
  assert.equal(result.generation, 1);
  assert.equal(db._runs.find((row) => row.id === "old-discovery").status, "CANCELLED");
  assert.equal(db._runs.find((row) => row.id === "old-history").status, "CANCELLED");

  const replacement = db._runs.find((row) => row.id.startsWith("new-run-"));
  assert.ok(replacement);
  assert.equal(replacement.dialogId, "__dialog_discovery__");
  assert.equal(replacement.status, "QUEUED");
  assert.equal(replacement.generation, 1);
  const replacementJob = db._jobs.find((row) => row.id.startsWith("new-job-"));
  assert.ok(replacementJob);
  assert.equal(replacementJob.continuation.page, 0);
  assert.equal(replacementJob.continuation.offset, 0);
  assert.equal(replacementJob.continuation.dialogId, "__dialog_discovery__");
  const discoveryState = db._states.find((row) => row.dialogId === "__dialog_discovery__");
  assert.equal(discoveryState.status, "QUEUED");
  assert.equal(discoveryState.activeRunId, replacement.id);
});


test("compact generations continue independently of legacy Unix timestamp generations", async () => {
  const db = createDb();
  db._runs.push({
    id: "compact-old", jobId: null, agencyId: "agency-1", creatorId: "creator-1",
    dialogId: "dialog-compact", mode: "initial", status: "COMPLETED", generation: 7,
    createdAt: new Date("2026-07-16T16:00:00.000Z"), updatedAt: new Date("2026-07-16T16:00:00.000Z"),
  });
  const result = await restartCreatorDialogPlanTx(db, {
    agencyId: "agency-1", creatorId: "creator-1", childMode: "initial", forceChildFull: true,
  });
  assert.equal(result.generation, 8);
});

test("disabled module does not cancel the existing creator plan", async () => {
  const db = createDb({ enabled: false });
  const result = await restartCreatorDialogPlanTx(db, {
    agencyId: "agency-1", creatorId: "creator-1", childMode: "initial", forceChildFull: true,
  });
  assert.equal(result.created, false);
  assert.equal(result.reason, "module_disabled");
  assert.equal(db._runs.find((row) => row.id === "old-discovery").status, "RUNNING");
  assert.equal(db._runs.find((row) => row.id === "old-history").status, "QUEUED");
});

test("creator scan route no longer uses Unix seconds as a visible request counter", () => {
  const route = fs.readFileSync(path.resolve(__dirname, "../routes/dialog-intelligence.js"), "utf8");
  assert.match(route, /restartCreatorDialogPlan\(/);
  assert.doesNotMatch(route, /Math\.floor\(Date\.now\(\)\s*\/\s*1000\)/);
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { inspectSubscriberRecoveryDiagnostics, safeSubscriberDiagnosticError } = require("./subscriber-recovery-diagnostics");

const now = new Date("2026-10-20T16:00:00Z");
const old = new Date("2026-10-17T16:00:00Z");
const scope = { agencyId: "agency-a", creatorId: "creator-a" };
function fixture(overrides = {}) {
  const run = { id: "old-run", jobId: "old-job", status: "RUNNING", hasMore: false,
    fanProjectionStatus: "COMPLETE", fanProjectionCursorOffset: 20, fanProjectionCount: 20,
    nextOffset: 20, scannedCount: 20, pageCount: 1, publicationStatus: "CURRENT",
    publicationGeneration: 1, publicationCursorId: "opaque-item-id", updatedAt: old,
  };
  const rows = {
    state: { id: "state", status: "SCANNING", publicationGeneration: 1, publishedGeneration: 0, lastJobId: "old-job" },
    debtRun: run, latestRun: run,
    signals: [{ id: "signal", kind: "RECOVERY", revision: 2, attempts: 100, dueAt: old, lastError: "SUBSCRIBER_RECOLLECTION_BLOCKED" }],
    work: { id: "work", state: "READY", isOutstanding: true, requestedRevision: 4n, completedRevision: 3n,
      claimedRevision: 3n, claimFence: 11n, ownerToken: "DWI-SECRET", leaseUntil: new Date(+now + 60_000),
      progressCursor: { lastFullPlanningAt: old, lastSubscriberDerivedGeneration: 0, secret: "CURSOR-SECRET" } },
    admission: { generation: "onlinod_maintenance_v1", laneName: "subscriberDirectoryMaintenance", turnCount: 88n, lastAdmittedAt: old },
    jobs: [{ id: "old-job", status: "PUBLISHING", jobKey: "subscriber_directory_scan", lastProgressAt: old,
      params: { scanRunId: "old-run", token: "PARAM-SECRET" }, progress: { stage: "PUBLICATION", providerPayload: "PROGRESS-SECRET" } }],
    ...overrides,
  };
  const calls = [];
  const read = (name, get) => async query => {
    calls.push({ name, query });
    if (rows[name] instanceof Error) throw rows[name];
    return get ? get(query) : rows[name];
  };
  const db = {
    $queryRawUnsafe: async (sql, agencyId, creatorId) => {
      calls.push({ name: "debtRun", query: { where: { agencyId, creatorId } }, sql });
      if (rows.debtRun instanceof Error) throw rows.debtRun;
      return rows.debtRun ? [rows.debtRun] : [];
    },
    subscriberDirectoryState: { findFirst: read("state") },
    subscriberScanRun: { findFirst: async query => {
      const name = query.where.OR ? "debtRun" : "latestRun"; return read(name)(query);
    } },
    subscriberDirectoryMaintenanceSignal: { findMany: read("signals") },
    domainWorkItem: { findFirst: read("work") },
    maintenanceAdmissionClassState: { findUnique: read("admission") },
    jobInstance: { findMany: read("jobs") },
  };
  return { db, rows, calls };
}

test("diagnostics identifies poison, stale admission and unchanged durable publication separately", async () => {
  const { db, calls } = fixture();
  const result = await inspectSubscriberRecoveryDiagnostics(db, { ...scope, now });
  assert.equal(result.readOnly, true);
  assert.equal(result.debtRun.phase, "CURRENT");
  assert.equal(result.debtRun.cursorId, "opaque-item-id");
  assert.equal(result.debtRun.progressAgeMs, 3 * 24 * 60 * 60_000);
  assert.equal(result.debtRun.recollectionCause, null);
  assert.equal(result.signals[0].lastError.code, "SUBSCRIBER_RECOLLECTION_BLOCKED");
  assert.ok(result.blockers.includes("RECOVERY_ATTEMPT_LIMIT_REACHED"));
  assert.ok(result.blockers.includes("MAINTENANCE_ADMISSION_STALE"));
  assert.equal(result.maintenanceAdmission.meaning, "dispatch_opportunity_not_completed_work");
  assert.equal(result.recurringWork.requestedRevision, "4");
  assert.equal(calls.length, 7);
  for (const call of calls.filter(item => item.name !== "admission")) {
    assert.equal(call.query.where.agencyId, scope.agencyId);
    assert.equal(call.query.where.creatorId, scope.creatorId);
  }
  assert.equal(calls.find(call => call.name === "signals").query.take, 3);
  assert.equal(calls.find(call => call.name === "jobs").query.take, 4);
});

test("no raw errors, owner capabilities, arbitrary parameters or progress payloads reach logs", async () => {
  const { db, rows } = fixture();
  rows.signals[0].claimToken = "CLAIM-SECRET";
  rows.signals[0].claimUntil = new Date(+now + 60_000);
  rows.signals[0].lastError = "Bad payload Authorization: Bearer AUTH-SECRET, Cookie: COOKIE-SECRET";
  rows.state.lastError = "postgres://dbuser:DB-SECRET@host/db";
  rows.jobs[0].lastError = "raw FAN-NAME came from provider body";
  rows.jobs[0].progress.stage = "FAN-NAME's auth stage";
  rows.jobs[0].progress.waitKind = "AUTH-SECRET";
  rows.jobs[0].progress.publicationPhase = "COOKIE-SECRET";
  const result = await inspectSubscriberRecoveryDiagnostics(db, { ...scope, now });
  const encoded = JSON.stringify(result);
  assert.doesNotMatch(encoded, /(?:CLAIM|DWI|PARAM|CURSOR|PROGRESS|AUTH|COOKIE|DB)-SECRET|FAN-NAME|postgres:\/\//);
  assert.ok(result.signals[0].owner.fingerprint);
  assert.equal(result.signals[0].owner.leaseActive, true);
  assert.ok(result.blockers.includes("RECOVERY_OWNER_ACTIVE"));
  assert.equal(result.signals[0].lastError.code, null);
  assert.ok(result.signals[0].lastError.fingerprint);
});

test("recollection shows predecessor debt and its fresh job without falsely reporting no work", async () => {
  const { db, rows } = fixture();
  rows.debtRun = { ...rows.debtRun, status: "FAILED", publicationStatus: "RECOLLECTING" };
  rows.latestRun = { ...rows.latestRun, id: "replacement-run", jobId: "replacement-job", publicationGeneration: 2,
    status: "QUEUED", hasMore: null, fanProjectionStatus: "PENDING", publicationStatus: "PENDING" };
  rows.signals = [{ id: "signal", kind: "RECOVERY", attempts: 0, dueAt: new Date(+now + 30_000) }];
  rows.jobs.push({ id: "replacement-job", jobKey: "subscriber_directory_scan", status: "SCHEDULED", params: { scanRunId: "replacement-run" } });
  const result = await inspectSubscriberRecoveryDiagnostics(db, { ...scope, now });
  assert.equal(result.debtRun.phase, "RECOLLECTING");
  assert.equal(result.latestRun.id, "replacement-run");
  assert.equal(result.jobs.find(job => job.id === "replacement-job").status, "SCHEDULED");
  assert.ok(result.blockers.includes("WAITING_FOR_RECOLLECTION"));
  assert.ok(result.blockers.includes("RECOVERY_BACKOFF"));
  assert.ok(!result.blockers.includes("RECOVERY_SIGNAL_MISSING"));
});

test("a failed diagnostic read remains explicit and is not confused with a missing recovery signal", async () => {
  const { db, rows } = fixture();
  rows.signals = Object.assign(new Error("Server has closed the connection."), { code: "P1017" });
  const result = await inspectSubscriberRecoveryDiagnostics(db, { ...scope, now, strictReads: false });
  assert.ok(result.blockers.includes("DIAGNOSTIC_READ_INCOMPLETE"));
  assert.ok(!result.blockers.includes("RECOVERY_SIGNAL_MISSING"));
  assert.equal(result.readFailures[0].error.code, "P1017");
  assert.equal(result.debtRun.id, "old-run");
});

test("transactional inspection propagates the first SQL cause and its read name", async () => {
  const { db, rows, calls } = fixture();
  const error = Object.assign(new Error("Server has closed the connection."), { code: "P1017" });
  rows.signals = error;
  await assert.rejects(inspectSubscriberRecoveryDiagnostics(db, { ...scope, now }), failure => {
    assert.equal(failure, error);
    assert.equal(failure.diagnosticRead, "maintenanceSignals");
    return true;
  });
  assert.equal(calls.some(call => call.name === "jobs"), false);
});

test("missing wake and invalid publication proof are visible without changing stored authority", async () => {
  const { db, rows, calls } = fixture({ debtRun: null, signals: [] });
  rows.latestRun = { ...rows.latestRun, hasMore: true, fanProjectionStatus: "PROJECTING" };
  const result = await inspectSubscriberRecoveryDiagnostics(db, { ...scope, now, jobId: "old-job" });
  assert.equal(result.latestRun.recollectionCause, "SUBSCRIBER_PUBLICATION_SOURCE_PROOF_MISSING");
  assert.ok(result.blockers.includes("PUBLISHING_JOB_WITHOUT_ELIGIBLE_DEBT_RUN"));
  assert.equal(calls.length, 7);
  assert.equal(rows.jobs[0].status, "PUBLISHING");
});

test("expired signal owner, missing source job and final job reconciliation are distinct observations", async () => {
  const { db, rows } = fixture({ jobs: [] });
  rows.signals[0] = { id: "signal", kind: "RECOVERY", attempts: 0, dueAt: old, claimToken: "expired", claimUntil: old };
  rows.debtRun = { ...rows.debtRun, status: "PUBLISHED", publicationStatus: "COMPLETE", publicationJobReconciledAt: null };
  const result = await inspectSubscriberRecoveryDiagnostics(db, { ...scope, now });
  assert.ok(result.blockers.includes("RECOVERY_OWNER_EXPIRED"));
  assert.ok(result.blockers.includes("SOURCE_JOB_MISSING_OR_OUT_OF_SCOPE"));
  assert.ok(result.blockers.includes("WAITING_FOR_JOB_RECONCILIATION"));
  assert.ok(!result.blockers.includes("RECOVERY_OWNER_ACTIVE"));
});

test("diagnostic read requires explicit tenant and creator scope before issuing SQL", async () => {
  const { db, calls } = fixture();
  await assert.rejects(inspectSubscriberRecoveryDiagnostics(db, { creatorId: scope.creatorId, now }), { code: "SUBSCRIBER_DIAGNOSTIC_SCOPE_REQUIRED" });
  assert.equal(calls.length, 0);
});

test("safe stored DB diagnostics retain known codes and omit connection details", () => {
  const result = safeSubscriberDiagnosticError("[TRANSIENT_DB:P2028] Query SECRET cannot be executed on an expired transaction");
  assert.equal(result.code, "P2028");
  assert.equal(result.category, "TRANSIENT_DATABASE");
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  assert.equal(safeSubscriberDiagnosticError("Subscriber publication generation 1 is stale behind allocated generation 5").code,
    "SUBSCRIBER_PUBLICATION_GENERATION_STALE");
});


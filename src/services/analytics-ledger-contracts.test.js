"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ANALYTICS_DATA_TYPES,
  ANALYTICS_COVERAGE_STATUSES,
  ANALYTICS_INGEST_STATUSES,
  AnalyticsLedgerValidationError,
  parseAnalyticsIngestEnvelope,
  parseAnalyticsCoverageInput,
} = require("./analytics-ledger-contracts");

const checksum = "a".repeat(64);

function validEnvelope(overrides = {}) {
  return {
    creatorId: "creator-1",
    idempotencyKey: "analytics:creator-1:earnings:2026-08-05:v1",
    dataType: "EARNINGS",
    rangeFrom: "2026-08-05T00:00:00.000Z",
    rangeTo: "2026-08-05T23:59:59.999Z",
    sourceTimezone: "Europe/Kiev",
    collectorVersion: "earnings-v1",
    schemaVersion: 1,
    payloadChecksum: checksum,
    receivedRows: 1,
    ...overrides,
  };
}

function validCoverage(overrides = {}) {
  return {
    creatorId: "creator-1",
    dataType: "NOTIFICATIONS",
    coverageDate: "2026-08-05",
    sourceTimezone: "Europe/Kiev",
    status: "PARTIAL",
    coveredFromAt: "2026-08-05T12:00:00.000Z",
    coveredToAt: "2026-08-05T18:00:00.000Z",
    sourceCursorEnd: "notification-123",
    lastVerifiedAt: "2026-08-05T18:01:00.000Z",
    ...overrides,
  };
}

test("analytics ledger enums are explicit and stable", () => {
  assert.deepEqual(ANALYTICS_DATA_TYPES, ["EARNINGS", "NOTIFICATIONS", "CAMPAIGNS", "MESSAGES_DAILY"]);
  assert.deepEqual(ANALYTICS_COVERAGE_STATUSES, [
    "MISSING",
    "QUEUED",
    "SCANNING",
    "PARTIAL",
    "COMPLETE",
    "FAILED",
    "UNAVAILABLE",
  ]);
  assert.deepEqual(ANALYTICS_INGEST_STATUSES, ["RECEIVED", "COMMITTED", "PARTIAL", "REJECTED", "FAILED"]);
});

test("ingest envelope accepts a typed versioned ordered range", () => {
  const parsed = parseAnalyticsIngestEnvelope(validEnvelope());

  assert.equal(parsed.creatorId, "creator-1");
  assert.ok(parsed.rangeFrom instanceof Date);
  assert.ok(parsed.rangeTo instanceof Date);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.receivedRows, 1);
});

test("ingest envelope rejects reversed ranges, unknown fields and invalid checksums", () => {
  assert.throws(
    () =>
      parseAnalyticsIngestEnvelope(
        validEnvelope({
          rangeFrom: "2026-08-06T00:00:00.000Z",
          rangeTo: "2026-08-05T00:00:00.000Z",
          sourceTimezone: "Mars/Olympus_Mons",
          payloadChecksum: "bad",
          agencyId: "must-not-be-trusted",
          sourceDeviceId: "must-come-from-auth-context",
          sourceJobId: "must-come-from-claimed-job",
        }),
      ),
    (error) => {
      assert.ok(error instanceof AnalyticsLedgerValidationError);
      assert.ok(error.issues.some((issue) => issue.path === "agencyId"));
      assert.ok(error.issues.some((issue) => issue.path === "sourceDeviceId"));
      assert.ok(error.issues.some((issue) => issue.path === "sourceJobId"));
      assert.ok(error.issues.some((issue) => issue.path === "payloadChecksum"));
      assert.ok(error.issues.some((issue) => issue.path === "sourceTimezone"));
      assert.ok(error.issues.some((issue) => issue.path === "rangeTo"));
      return true;
    },
  );
});

test("ingest envelope rejects type coercion and timezone-less dates", () => {
  for (const overrides of [
    { schemaVersion: "1" },
    { receivedRows: "1" },
    { rangeFrom: false },
    { rangeFrom: 0 },
    { rangeFrom: "2026-08-05" },
    { rangeFrom: "2026-08-05T00:00:00" },
  ]) {
    assert.throws(() => parseAnalyticsIngestEnvelope(validEnvelope(overrides)), AnalyticsLedgerValidationError);
  }
});

test("coverage contract uses date-only keys and keeps partial intervals honest", () => {
  assert.throws(() =>
    parseAnalyticsCoverageInput(
      validCoverage({
        coverageDate: "2026-02-31",
        coveredFromAt: "2026-08-05T18:00:00.000Z",
        coveredToAt: "2026-08-05T12:00:00.000Z",
      }),
    ),
  );

  const parsed = parseAnalyticsCoverageInput(validCoverage());

  assert.equal(parsed.coverageDate, "2026-08-05");
  assert.equal(parsed.status, "PARTIAL");
});

test("partial coverage requires actual interval or cursor evidence", () => {
  assert.throws(
    () =>
      parseAnalyticsCoverageInput(
        validCoverage({
          coveredFromAt: null,
          coveredToAt: null,
          sourceCursorStart: null,
          sourceCursorEnd: null,
        }),
      ),
    AnalyticsLedgerValidationError,
  );
});

test("coverage terminal states require verification and failures require a code", () => {
  for (const status of ["PARTIAL", "COMPLETE", "FAILED", "UNAVAILABLE"]) {
    assert.throws(
      () => parseAnalyticsCoverageInput(validCoverage({ status, lastVerifiedAt: null })),
      AnalyticsLedgerValidationError,
    );
  }

  for (const status of ["FAILED", "UNAVAILABLE"]) {
    assert.throws(
      () =>
        parseAnalyticsCoverageInput(
          validCoverage({ status, lastErrorCode: null, lastVerifiedAt: "2026-08-05T18:01:00.000Z" }),
        ),
      AnalyticsLedgerValidationError,
    );
  }
});

test("complete and missing coverage reject contradictory metadata", () => {
  assert.throws(
    () =>
      parseAnalyticsCoverageInput(
        validCoverage({
          status: "COMPLETE",
          lastVerifiedAt: "2026-08-05T18:01:00.000Z",
          lastErrorCode: "STALE_ERROR",
        }),
      ),
    AnalyticsLedgerValidationError,
  );

  assert.throws(
    () =>
      parseAnalyticsCoverageInput(
        validCoverage({
          status: "MISSING",
          lastVerifiedAt: null,
          coveredFromAt: "2026-08-05T12:00:00.000Z",
          coveredToAt: null,
        }),
      ),
    AnalyticsLedgerValidationError,
  );

  const complete = parseAnalyticsCoverageInput(
    validCoverage({
      status: "COMPLETE",
      coveredFromAt: null,
      coveredToAt: null,
      sourceCursorEnd: null,
      lastVerifiedAt: "2026-08-05T23:59:59.999Z",
    }),
  );
  assert.equal(complete.status, "COMPLETE");
});

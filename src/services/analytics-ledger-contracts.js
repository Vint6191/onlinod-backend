"use strict";

const ANALYTICS_DATA_TYPES = Object.freeze([
  "EARNINGS",
  "NOTIFICATIONS",
  "CAMPAIGNS",
  "MESSAGES_DAILY",
]);

const ANALYTICS_COVERAGE_STATUSES = Object.freeze([
  "MISSING",
  "QUEUED",
  "SCANNING",
  "PARTIAL",
  "COMPLETE",
  "FAILED",
  "UNAVAILABLE",
]);

const ANALYTICS_INGEST_STATUSES = Object.freeze([
  "RECEIVED",
  "COMMITTED",
  "PARTIAL",
  "REJECTED",
  "FAILED",
]);

const ISO_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

class AnalyticsLedgerValidationError extends Error {
  constructor(issues) {
    super("Invalid analytics ledger input");
    this.name = "AnalyticsLedgerValidationError";
    this.code = "ANALYTICS_LEDGER_VALIDATION_FAILED";
    this.issues = issues;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function pushUnknownKeys(input, allowed, issues) {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) issues.push({ path: key, message: "Unknown field" });
  }
}

function requiredString(input, path, issues, { min = 1, max = 200, pattern } = {}) {
  if (typeof input !== "string") {
    issues.push({ path, message: "Expected string" });
    return null;
  }
  const value = input.trim();
  if (value.length < min || value.length > max) {
    issues.push({ path, message: `Expected ${min}-${max} characters` });
    return null;
  }
  if (pattern && !pattern.test(value)) {
    issues.push({ path, message: "Invalid format" });
    return null;
  }
  return value;
}

function optionalString(input, path, issues, { max = 2_000 } = {}) {
  if (input === undefined || input === null) return null;
  if (typeof input !== "string") {
    issues.push({ path, message: "Expected string or null" });
    return null;
  }
  if (input.length > max) {
    issues.push({ path, message: `Expected at most ${max} characters` });
    return null;
  }
  return input;
}

function requiredEnum(input, path, values, issues) {
  if (!values.includes(input)) {
    issues.push({ path, message: `Expected one of: ${values.join(", ")}` });
    return null;
  }
  return input;
}

function requiredTimezone(input, path, issues) {
  const value = requiredString(input, path, issues, { max: 100 });
  if (!value) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
  } catch {
    issues.push({ path, message: "Expected a valid IANA timezone" });
    return null;
  }
  return value;
}

function requiredInteger(input, path, issues, { min = 0, max = 1_000_000 } = {}) {
  if (!Number.isInteger(input) || input < min || input > max) {
    issues.push({ path, message: `Expected integer between ${min} and ${max}` });
    return null;
  }
  return input;
}

function optionalDateTime(input, path, issues) {
  if (input === undefined || input === null) return null;

  if (input instanceof Date) {
    const value = new Date(input.getTime());
    if (Number.isNaN(value.getTime())) {
      issues.push({ path, message: "Expected a valid date-time" });
      return null;
    }
    return value;
  }

  if (typeof input !== "string" || !ISO_DATE_TIME_PATTERN.test(input)) {
    issues.push({ path, message: "Expected an ISO 8601 date-time with an explicit timezone" });
    return null;
  }

  const value = new Date(input);
  if (Number.isNaN(value.getTime())) {
    issues.push({ path, message: "Expected a valid date-time" });
    return null;
  }
  return value;
}

function requiredDateTime(input, path, issues) {
  if (input === null || input === undefined) {
    issues.push({ path, message: "Required" });
    return null;
  }
  return optionalDateTime(input, path, issues);
}

function requiredDateOnly(input, path, issues) {
  if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    issues.push({ path, message: "Expected YYYY-MM-DD" });
    return null;
  }
  const date = new Date(`${input}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== input) {
    issues.push({ path, message: "Expected a real calendar date" });
    return null;
  }
  return input;
}

function finish(issues, value) {
  if (issues.length > 0) throw new AnalyticsLedgerValidationError(issues);
  return value;
}

function parseAnalyticsIngestEnvelope(input) {
  const issues = [];
  if (!isPlainObject(input)) throw new AnalyticsLedgerValidationError([{ path: "", message: "Expected object" }]);

  pushUnknownKeys(
    input,
    new Set([
      "creatorId",
      "idempotencyKey",
      "dataType",
      "rangeFrom",
      "rangeTo",
      "sourceTimezone",
      "collectorVersion",
      "schemaVersion",
      "payloadChecksum",
      "receivedRows",
    ]),
    issues,
  );

  const value = {
    creatorId: requiredString(input.creatorId, "creatorId", issues),
    idempotencyKey: requiredString(input.idempotencyKey, "idempotencyKey", issues, { min: 8, max: 240 }),
    dataType: requiredEnum(input.dataType, "dataType", ANALYTICS_DATA_TYPES, issues),
    rangeFrom: requiredDateTime(input.rangeFrom, "rangeFrom", issues),
    rangeTo: requiredDateTime(input.rangeTo, "rangeTo", issues),
    sourceTimezone: requiredTimezone(input.sourceTimezone, "sourceTimezone", issues),
    collectorVersion: requiredString(input.collectorVersion, "collectorVersion", issues, { max: 80 }),
    schemaVersion: requiredInteger(input.schemaVersion, "schemaVersion", issues, { min: 1 }),
    payloadChecksum: requiredString(input.payloadChecksum, "payloadChecksum", issues, {
      min: 64,
      max: 64,
      pattern: /^[a-f0-9]{64}$/i,
    }),
    receivedRows: requiredInteger(input.receivedRows, "receivedRows", issues),
  };

  if (value.rangeFrom && value.rangeTo && value.rangeTo.getTime() < value.rangeFrom.getTime()) {
    issues.push({ path: "rangeTo", message: "Must be greater than or equal to rangeFrom" });
  }

  return finish(issues, value);
}

function parseAnalyticsCoverageInput(input) {
  const issues = [];
  if (!isPlainObject(input)) throw new AnalyticsLedgerValidationError([{ path: "", message: "Expected object" }]);

  pushUnknownKeys(
    input,
    new Set([
      "creatorId",
      "dataType",
      "coverageDate",
      "sourceTimezone",
      "status",
      "coveredFromAt",
      "coveredToAt",
      "sourceCursorStart",
      "sourceCursorEnd",
      "lastVerifiedAt",
      "lastErrorCode",
      "lastErrorMessage",
      "retryAfterAt",
    ]),
    issues,
  );

  const value = {
    creatorId: requiredString(input.creatorId, "creatorId", issues),
    dataType: requiredEnum(input.dataType, "dataType", ANALYTICS_DATA_TYPES, issues),
    coverageDate: requiredDateOnly(input.coverageDate, "coverageDate", issues),
    sourceTimezone: requiredTimezone(input.sourceTimezone, "sourceTimezone", issues),
    status: requiredEnum(input.status, "status", ANALYTICS_COVERAGE_STATUSES, issues),
    coveredFromAt: optionalDateTime(input.coveredFromAt, "coveredFromAt", issues),
    coveredToAt: optionalDateTime(input.coveredToAt, "coveredToAt", issues),
    sourceCursorStart: optionalString(input.sourceCursorStart, "sourceCursorStart", issues, { max: 500 }),
    sourceCursorEnd: optionalString(input.sourceCursorEnd, "sourceCursorEnd", issues, { max: 500 }),
    lastVerifiedAt: optionalDateTime(input.lastVerifiedAt, "lastVerifiedAt", issues),
    lastErrorCode: optionalString(input.lastErrorCode, "lastErrorCode", issues, { max: 120 }),
    lastErrorMessage: optionalString(input.lastErrorMessage, "lastErrorMessage", issues, { max: 2_000 }),
    retryAfterAt: optionalDateTime(input.retryAfterAt, "retryAfterAt", issues),
  };

  if (value.coveredFromAt && value.coveredToAt && value.coveredToAt.getTime() < value.coveredFromAt.getTime()) {
    issues.push({ path: "coveredToAt", message: "Must be greater than or equal to coveredFromAt" });
  }

  if (["PARTIAL", "COMPLETE", "FAILED", "UNAVAILABLE"].includes(value.status) && !value.lastVerifiedAt) {
    issues.push({ path: "lastVerifiedAt", message: `Required when status is ${value.status}` });
  }

  if (
    value.status === "PARTIAL" &&
    value.coveredFromAt === null &&
    value.coveredToAt === null &&
    value.sourceCursorStart === null &&
    value.sourceCursorEnd === null
  ) {
    issues.push({ path: "status", message: "PARTIAL coverage requires an interval or cursor" });
  }

  if (["FAILED", "UNAVAILABLE"].includes(value.status) && !value.lastErrorCode?.trim()) {
    issues.push({ path: "lastErrorCode", message: `Required when status is ${value.status}` });
  }

  if (
    value.status === "COMPLETE" &&
    (value.lastErrorCode !== null || value.lastErrorMessage !== null || value.retryAfterAt !== null)
  ) {
    issues.push({ path: "status", message: "COMPLETE coverage cannot retain error or retry metadata" });
  }

  if (
    value.status === "MISSING" &&
    (value.coveredFromAt !== null ||
      value.coveredToAt !== null ||
      value.sourceCursorStart !== null ||
      value.sourceCursorEnd !== null)
  ) {
    issues.push({ path: "status", message: "MISSING coverage cannot contain covered intervals or cursors" });
  }

  return finish(issues, value);
}

module.exports = {
  ANALYTICS_DATA_TYPES,
  ANALYTICS_COVERAGE_STATUSES,
  ANALYTICS_INGEST_STATUSES,
  AnalyticsLedgerValidationError,
  parseAnalyticsIngestEnvelope,
  parseAnalyticsCoverageInput,
};

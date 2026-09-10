"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  buildProjectionDetailAuthority,
  retainedDetailFrom,
} = require("./team-historical-range-authority-service");
const { resolveRange } = require("./range-service");

test("all-range response/dialog detail is bounded by retained horizon and reports incomplete coverage", () => {
  const authorityNow = new Date("2026-09-09T12:00:00.000Z");
  const range = resolveRange("all", authorityNow);
  const expectedCutoff = retainedDetailFrom({ authorityNow, detailDays: 180 });
  const authority = buildProjectionDetailAuthority({
    range,
    authorityNow,
    detailDays: 180,
    responseCoverageFrom: new Date("2025-01-01T00:00:00.000Z"),
    dialogCoverageFrom: new Date("2025-01-01T00:00:00.000Z"),
  });

  assert.equal(authority.responseAvailableFrom.toISOString(), expectedCutoff.toISOString());
  assert.equal(authority.dialogAvailableFrom.toISOString(), expectedCutoff.toISOString());
  assert.equal(authority.responseRange.startAt.toISOString(), expectedCutoff.toISOString());
  assert.equal(authority.dialogRange.startAt.toISOString(), expectedCutoff.toISOString());
  assert.equal(authority.responseCoverage.status, "AVAILABLE_FROM");
  assert.equal(authority.dialogCoverage.status, "AVAILABLE_FROM");
});

test("retention preserves incomplete/open correction authority and advances retained coverage only through vector compaction", () => {
  const source = fs.readFileSync(path.join(__dirname, "retention-service.js"), "utf8");
  assert.match(source, /projectionState:\s*"FULL"/);
  assert.match(source, /endedAt:\s*\{ not:\s*null, lt:\s*cutoff \}/);
  assert.match(source, /TEAM_PROVIDER_CORRECTION_HORIZON_DAYS = 366/);
  assert.match(source, /responseCoverageFrom:\s*maxDate/);
  assert.match(source, /dialogCoverageFrom:\s*maxDate/);
});

test("all Team detail APIs and schedule use the shared historical range authority", () => {
  const read = fs.readFileSync(path.join(__dirname, "team-response-read-service.js"), "utf8");
  const analytics = fs.readFileSync(path.join(__dirname, "team-analytics-service.js"), "utf8");
  const schedule = fs.readFileSync(path.join(__dirname, "team-schedule-service.js"), "utf8");
  assert.match(read, /team-historical-range-authority-service/);
  assert.match(read, /retainedRange: retainedRange \? rangeForClient\(retainedRange\) : null/);
  assert.match(analytics, /buildProjectionDetailAuthority/);
  assert.match(analytics, /bounded_team_response_case_v1/);
  assert.match(analytics, /bounded_team_dialog_session_v1/);
  assert.match(schedule, /historicalCoverage: scheduleCoverage/);
  assert.match(schedule, /const queryRange = retainedRange/);
});

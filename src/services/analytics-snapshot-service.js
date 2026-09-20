"use strict";

// Phase-3 final cutover tombstone. AnalyticsSnapshot and its sibling legacy
// snapshot generations are physically retired by migration. Keeping a tiny
// source-level compatibility module prevents accidental require failures in
// historical tooling while making it impossible to write/read the retired DB.
function retired() {
  const error = new Error("Legacy analytics snapshots are retired; use canonical /api/home and /api/stats authorities");
  error.code = "ANALYTICS_SNAPSHOT_RETIRED";
  error.status = 410;
  throw error;
}
async function reportAnalyticsSnapshots() { return retired(); }
async function getLatestSnapshot() { return retired(); }
async function getLatestPayload() { return retired(); }
module.exports = { reportAnalyticsSnapshots, getLatestSnapshot, getLatestPayload, ALLOWED_SCOPES: new Set() };

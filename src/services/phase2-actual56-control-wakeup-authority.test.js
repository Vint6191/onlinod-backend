"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

function loadFreshEvents() {
  const modulePath = require.resolve("./desktop-control-events");
  delete require.cache[modulePath];
  return require("./desktop-control-events");
}

test("process-local control buffer is deliberately lossy; durable proof must not be derived from it", async () => {
  const events = loadFreshEvents();
  events.publishDesktopControlEvent({ type: "CREATOR_REVOKED", agencyId: "agency-a", creatorId: "creator-a" });
  for (let index = 0; index < 5001; index += 1) {
    events.publishDesktopControlEvent({ type: "JOB_AVAILABLE", agencyId: "agency-b", jobId: `job-${index}` });
  }
  const result = await events.waitForDesktopControlEvents({ agencyId: "agency-a", afterSeq: 0, streamId: "stale-client-stream", waitMs: 250 });
  assert.deepEqual(result.events, [], "cross-tenant ring-buffer eviction is expected and must not be correctness authority");
  assert.ok(result.cursor >= 5002, "cursor may advance even though the wakeup was evicted");

  const route = read("src/routes/desktop.js");
  const waitPos = route.indexOf("await waitForDesktopControlEvents");
  const proofPos = route.indexOf("filterAuthorizedControlEventsStable", waitPos);
  const responsePos = route.indexOf("authority: filtered.authority", proofPos);
  assert.ok(waitPos >= 0 && proofPos > waitPos && responsePos > proofPos,
    "every successful long-poll must read fresh durable authority after the lossy wait");
});

test("security wakeups are bounded hints rather than per-Creator broad revoke fanout", () => {
  const team = read("src/services/team-administration-service.js");
  const admin = read("src/routes/admin.js");
  assert.doesNotMatch(team, /for\s*\([^)]*creator[^)]*\)[\s\S]{0,700}CREATOR_REVOKED/i);
  assert.doesNotMatch(admin, /for\s*\([^)]*creator[^)]*\)[\s\S]{0,700}CREATOR_REVOKED/i);
});

test("control route recomputes Member/User/Agency and creator generation after long-poll wait", () => {
  const route = read("src/routes/desktop.js");
  const authority = read("src/services/desktop-current-access-authority-service.js");
  assert.match(route, /withStableDesktopCurrentAccess/);
  assert.match(route, /currentCreatorCatalogGeneration/);
  assert.match(route, /authority:\s*filtered\.authority/);
  assert.match(authority, /user:\s*\{\s*is:\s*\{\s*disabledAt:\s*null/);
  assert.match(authority, /agency:\s*\{\s*is:\s*\{\s*deletedAt:\s*null/);
});

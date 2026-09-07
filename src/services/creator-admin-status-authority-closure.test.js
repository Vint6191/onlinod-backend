"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ADMIN_ROUTE = fs.readFileSync(path.join(__dirname, "../routes/admin.js"), "utf8");
const ADMIN_PAGE = fs.readFileSync(path.join(__dirname, "../../public/pages/admin.js"), "utf8");

function statusRouteSource() {
  const start = ADMIN_ROUTE.indexOf('router.patch("/creators/:id/status"');
  const end = ADMIN_ROUTE.indexOf('// PATCH /creators/:id/billing', start);
  assert.notEqual(start, -1, "legacy creator status route must remain as compatibility surface");
  assert.notEqual(end, -1, "status route must have a stable boundary before creator billing route");
  return ADMIN_ROUTE.slice(start, end);
}

test("legacy admin creator status endpoint cannot write CreatorAccount.status", () => {
  const source = statusRouteSource();
  assert.match(source, /CREATOR_STATUS_MANAGED_BY_LIFECYCLE_AUTHORITY/);
  assert.match(source, /String\(before\.status\) === status/);
  assert.doesNotMatch(source, /creatorAccount\.update\s*\(/);
  assert.doesNotMatch(source, /data:\s*\{\s*status\s*\}/);
});

test("legacy admin status endpoint cannot forge READY or bypass full DISABLED removal", () => {
  const source = statusRouteSource();
  assert.match(source, /status === "READY"/);
  assert.match(source, /verified Creator Enrollment \/ Connection workflow/);
  assert.match(source, /status === "DISABLED"/);
  assert.match(source, /creator removal workflow/);
  assert.match(source, /active Customs, external writes, session\/crypto material and access/);
});

test("admin UI no longer exposes direct READY or DISABLED status toggles", () => {
  assert.doesNotMatch(ADMIN_PAGE, /data-admin-creator-status/);
  assert.doesNotMatch(ADMIN_PAGE, /manual admin status change/);
  assert.match(ADMIN_PAGE, /data-admin-delete-creator/);
});

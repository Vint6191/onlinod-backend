"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");

function load(filename, overrides = {}) {
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module, exports: module.exports,
    require: (id) => Object.hasOwn(overrides, id) ? overrides[id] : localRequire(id),
    console, setTimeout, clearTimeout, AbortController,
  }, { filename });
  return module.exports;
}

function fixture({ revoked = false } = {}) {
  const bus = load(path.resolve(__dirname, "../services/desktop-control-events.js"), {
    "./db-commit-kernel": { currentCommitContext: () => null },
  });
  const authorizations = [];
  const router = load(path.resolve(__dirname, "desktop.js"), {
    "../prisma": {},
    "../middleware/auth": { authRequired() {}, requireAuthDevice: (req, id) => {
      assert.equal(id, req.auth.deviceId); return id;
    } },
    "../services/desktop-bootstrap-service": { accessibleCreatorIdSet: async ({ agencyId, member, creatorIds }) => {
      authorizations.push({ agencyId, memberId: member.id, creatorIds: [...creatorIds] });
      return new Set(creatorIds.filter(id => id === "creator-allowed"));
    } },
    "../services/desktop-secret-delta-service": {},
    "../services/audit-service": {},
    "../services/desktop-control-events": bus,
    "../services/desktop-current-access-authority-service": {
      desktopAuthorityProof: () => ({ accessEpoch: 4, creatorCatalogGeneration: 5 }),
      withStableDesktopCurrentAccess: async ({ work }) => ({
        value: await work({ id: "member-current" }), member: { id: "member-current" }, generation: 5,
      }),
    },
    "../services/creator-human-management-authority-service": { currentCreatorCatalogGeneration: async () => 5 },
    "../services/authorization-session-authority-service": { assertCurrentAuthorizationSession: async () => {
      if (revoked) throw Object.assign(new Error("Session revoked"), { code: "SESSION_REVOKED", status: 401 });
    } },
  });
  const handler = router.stack.find(layer => layer.route?.path === "/control/events").route.stack.at(-1).handle;
  const request = new EventEmitter();
  request.auth = { agencyId: "agency-a", userId: "user-a", deviceId: "device-a", membership: { id: "member-stale" } };
  request.query = { deviceId: "device-a", streamId: bus.currentDesktopControlStreamId(), afterSeq: 0, waitMs: 250 };
  const response = new EventEmitter();
  response.statusCode = 200;
  response.setHeader = () => {};
  response.status = (status) => { response.statusCode = status; return response; };
  response.json = (body) => { response.body = body; return response; };
  return { bus, authorizations, response, run: () => handler(request, response) };
}

test("analytics invalidation reaches the current agency desktop without creator details", async () => {
  const f = fixture();
  f.bus.publishDesktopControlEvent({ type: "ANALYTICS_CHANGED", agencyId: "agency-b", creatorId: "foreign", amount: 500 });
  f.bus.publishDesktopControlEvent({ type: "ANALYTICS_CHANGED", agencyId: "agency-a", creatorId: "private", amount: 900 });
  await f.run();
  assert.equal(f.response.statusCode, 200);
  assert.deepEqual(Array.from(f.response.body.events, event => event.type), ["ANALYTICS_CHANGED"]);
  const delivered = f.response.body.events[0];
  assert.equal(delivered.creatorId, undefined);
  assert.equal(delivered.amount, undefined);
  assert.equal(delivered._agencyId, undefined);
});

test("creator hints still require current creator scope and post-wait membership", async () => {
  const f = fixture();
  for (const creatorId of ["creator-allowed", "creator-foreign"]) {
    f.bus.publishDesktopControlEvent({ type: "JOB_AVAILABLE", agencyId: "agency-a", creatorId, jobId: `job-${creatorId}` });
    f.bus.publishDesktopControlEvent({ type: "SESSION_REVISION_CHANGED", agencyId: "agency-a", creatorId, revision: 3, status: "ACTIVE" });
  }
  await f.run();
  assert.equal(f.response.statusCode, 200);
  assert.equal(f.response.body.events.length, 2);
  assert.ok(f.response.body.events.every(event => event.creatorId === "creator-allowed"));
  assert.equal(f.authorizations[0].memberId, "member-current");
  assert.equal(f.authorizations[0].agencyId, "agency-a");
});

test("a session revoked during the control wait receives no analytics hint", async () => {
  const f = fixture({ revoked: true });
  f.bus.publishDesktopControlEvent({ type: "ANALYTICS_CHANGED", agencyId: "agency-a" });
  await f.run();
  assert.equal(f.response.statusCode, 401);
  assert.equal(f.response.body.code, "SESSION_REVOKED");
  assert.equal(f.response.body.events, undefined);
});

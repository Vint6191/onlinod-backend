"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { lockAgencyLifecycleBarrier } = require("./agency-lifecycle-barrier-service");

function authorityFake() {
  const execute = [];
  const query = [];
  return {
    execute,
    query,
    db: {
      async $executeRawUnsafe(sql, ...args) {
        execute.push({ sql: String(sql), args });
        return 0;
      },
      async $queryRawUnsafe(sql, ...args) {
        const text = String(sql);
        query.push({ sql: text, args });
        if (/FROM "AgencyCustomRole"/.test(text)) return [{ id: "role-1" }];
        if (/FROM "Agency"/.test(text)) return [{ id: String(args[0]), deletedAt: null, status: "ACTIVE" }];
        return [];
      },
      agencyCustomRole: { findUnique: async () => ({ id: "role-1" }) },
    },
  };
}

function source(rel) {
  return fs.readFileSync(path.join(__dirname, rel), "utf8");
}

test("Phase2 lock topology: Agency normal holders are shared, destructive holders are exclusive, with rolling row-lock compatibility", async () => {
  const shared = authorityFake();
  const sharedResult = await lockAgencyLifecycleBarrier({ db: shared.db, agencyId: "agency-1", mode: "shared" });
  assert.equal(sharedResult.mode, "shared");
  assert.equal(shared.execute.length, 1);
  assert.match(shared.execute[0].sql, /pg_advisory_xact_lock_shared/);
  assert.equal(shared.execute[0].args[0], "agency-lifecycle:agency-1");
  assert.equal(shared.query.length, 1);
  assert.match(shared.query[0].sql, /FROM "Agency"/);
  assert.match(shared.query[0].sql, /FOR SHARE/);
  assert.doesNotMatch(shared.query[0].sql, /FOR UPDATE/);

  const exclusive = authorityFake();
  const exclusiveResult = await lockAgencyLifecycleBarrier({ db: exclusive.db, agencyId: "agency-1", mode: "exclusive" });
  assert.equal(exclusiveResult.mode, "exclusive");
  assert.equal(exclusive.execute.length, 1);
  assert.match(exclusive.execute[0].sql, /pg_advisory_xact_lock\(/);
  assert.doesNotMatch(exclusive.execute[0].sql, /_shared/);
  assert.match(exclusive.query[0].sql, /FOR UPDATE/);
});

test("Phase2 lock topology: Team role configuration is role-local while Agency lifecycle remains shared", () => {
  const team = source("team-administration-service.js");
  const start = team.indexOf("async function lockTeamRoleLifecycle");
  const end = team.indexOf("async function bumpLiveRoleMemberAccessEpochs", start);
  assert.ok(start >= 0 && end > start);
  const body = team.slice(start, end);
  assert.match(body, /lockAgencyLifecycleBarrier\(\{ db: tx, agencyId, mode: "shared" \}\)/);
  assert.match(body, /team-role-lifecycle:/);
  assert.match(body, /mode: write \? "exclusive" : "shared"/);
  assert.match(body, /const rowLock = write \? "FOR UPDATE" : "FOR SHARE"/);
  assert.match(body, /FROM "AgencyCustomRole"/);
  assert.ok(body.indexOf("lockAgencyLifecycleBarrier") < body.indexOf("lockDbAdvisoryXact"));
  assert.ok(body.indexOf("lockDbAdvisoryXact") < body.indexOf('FROM "AgencyCustomRole"'));
});

test("Phase2 lock topology: management commit no longer owns an Agency exclusive row mutex", () => {
  const management = source("management-commit-authority-service.js");
  assert.match(management, /lockAgencyLifecycleBarrier/);
  assert.doesNotMatch(management, /FROM "Agency"[\s\S]{0,180}FOR UPDATE/);
  assert.doesNotMatch(management, /FROM "Agency"[\s\S]{0,180}FOR SHARE/);
});

test("Phase2 lock topology: destructive Agency delete and restore use the exclusive lifecycle capability", () => {
  const admin = source("../routes/admin.js");
  const removeStart = admin.indexOf('router.delete("/agencies/:id"');
  const restoreStart = admin.indexOf('router.post("/agencies/:id/restore"');
  const next = admin.indexOf("// ═", restoreStart);
  assert.ok(removeStart >= 0 && restoreStart > removeStart);
  const remove = admin.slice(removeStart, restoreStart);
  const restore = admin.slice(restoreStart, next > restoreStart ? next : undefined);
  const deleteCalls = remove.match(/lockAgencyPipelineLifecycleExclusive/g) || [];
  assert.ok(deleteCalls.length >= 2, "soft and hard delete must both take exclusive Agency lifecycle");
  assert.match(restore, /lockAgencyPipelineLifecycleExclusive/);
});

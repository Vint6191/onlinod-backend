"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const migration = read("prisma/migrations/20260912007000_phase2_actual56_team_control_plane_release_activation/migration.sql");
const topology = read("src/services/team-control-plane-authority-service.js");
const lifecycle = read("src/services/creator-lifecycle-authority-service.js");
const admin = read("src/routes/admin.js");
const destructive = read("src/services/phase2-destructive-delete-authority-service.js");
const activationScript = read("scripts/maintenance/phase2-team-control-plane-activation.js");
const release = require("./phase2-release-compatibility-authority-service");

function indexOrder(source, needles, label) {
  let previous = -1;
  for (const needle of needles) {
    const next = source.indexOf(needle, previous + 1);
    assert.ok(next >= 0, `${label}: missing ${needle}`);
    assert.ok(next > previous, `${label}: ${needle} must follow previous lock/admission step`);
    previous = next;
  }
}

test("M1 Team control-plane migration publishes DRAINING, never auto-ACTIVE", () => {
  assert.match(migration, /'TEAM_CONTROL_PLANE'/);
  assert.match(migration, /'phase2_team_control_plane_v1_actual56_postcut'/);
  assert.match(migration, /'DRAINING'/);
  assert.match(migration, /"activationState" IN \('DRAINING','ACTIVE'\)/);
  assert.match(migration, /"activatedAt" DROP NOT NULL/);
  const insert = migration.slice(migration.indexOf('INSERT INTO "Phase2ReleaseCompatibilityAuthority"'));
  assert.match(insert, /'TEAM_CONTROL_PLANE'[\s\S]*'DRAINING'[\s\S]*NULL,[\s\S]*NULL/);
  assert.doesNotMatch(insert, /'TEAM_CONTROL_PLANE'[\s\S]{0,250}'ACTIVE'/);
});

test("M1 new Team writer takes shared release fence and fails closed while DRAINING", async () => {
  const calls = [];
  const tx = {
    async $executeRawUnsafe(sql, ...args) {
      calls.push({ kind: "execute", sql, args });
      return 1;
    },
    async $queryRawUnsafe(sql, ...args) {
      calls.push({ kind: "query", sql, args });
      return [{
        scope: release.TEAM_CONTROL_PLANE_SCOPE,
        requiredGeneration: release.TEAM_CONTROL_PLANE_GENERATION,
        activationState: "DRAINING",
        drainStartedAt: new Date(),
        activatedAt: null,
        activationConfirmedAt: null,
      }];
    },
  };

  await assert.rejects(
    release.assertTeamControlPlaneWriteAdmission(tx),
    (error) => error?.code === "TEAM_CONTROL_PLANE_DRAINING" && error?.status === 503,
  );
  assert.equal(calls[0].kind, "execute");
  assert.match(calls[0].sql, /pg_advisory_xact_lock_shared/);
  assert.deepEqual(calls[0].args, [release.TEAM_CONTROL_PLANE_RELEASE_FENCE_KEY]);
  assert.equal(calls[1].kind, "query");
  assert.match(calls[1].sql, /Phase2ReleaseCompatibilityAuthority/);
});

test("M1 ACTIVE Team writer admission uses the exact release generation", async () => {
  const tx = {
    async $executeRawUnsafe() { return 1; },
    async $queryRawUnsafe() {
      return [{
        scope: release.TEAM_CONTROL_PLANE_SCOPE,
        requiredGeneration: release.TEAM_CONTROL_PLANE_GENERATION,
        activationState: "ACTIVE",
      }];
    },
  };
  const result = await release.assertTeamControlPlaneWriteAdmission(tx);
  assert.equal(result.admitted, true);
  assert.equal(result.generation, release.TEAM_CONTROL_PLANE_GENERATION);
  assert.equal(result.row.activationState, "ACTIVE");
});

test("M1 activation requires explicit drain confirmation and takes the exclusive release fence", async () => {
  let transactions = 0;
  const db = {
    async $transaction(work) {
      transactions += 1;
      const calls = [];
      const tx = {
        calls,
        async $executeRawUnsafe(sql, ...args) { calls.push({ kind: "execute", sql, args }); return 1; },
        async $queryRawUnsafe(sql, ...args) {
          calls.push({ kind: "query", sql, args });
          if (/^UPDATE\s+"Phase2ReleaseCompatibilityAuthority"/m.test(sql.trim())) {
            return [{
              scope: release.TEAM_CONTROL_PLANE_SCOPE,
              requiredGeneration: release.TEAM_CONTROL_PLANE_GENERATION,
              activationState: "ACTIVE",
            }];
          }
          return [{
            scope: release.TEAM_CONTROL_PLANE_SCOPE,
            requiredGeneration: release.TEAM_CONTROL_PLANE_GENERATION,
            activationState: "DRAINING",
          }];
        },
      };
      const result = await work(tx);
      return { result, calls };
    },
  };

  await assert.rejects(
    release.activateTeamControlPlaneAfterDrain(db),
    (error) => error?.code === "TEAM_CONTROL_PLANE_DRAIN_CONFIRMATION_REQUIRED",
  );
  assert.equal(transactions, 0, "missing confirmation must fail before opening a transaction");

  const wrapped = await release.activateTeamControlPlaneAfterDrain(db, { confirmOldBinaryDrained: true });
  assert.equal(transactions, 1);
  assert.equal(wrapped.result.activated, true);
  const first = wrapped.calls[0];
  assert.equal(first.kind, "execute");
  assert.match(first.sql, /pg_advisory_xact_lock\(hashtext\(\$1\)\)/);
  assert.deepEqual(first.args, [release.TEAM_CONTROL_PLANE_RELEASE_FENCE_KEY]);
  assert.match(wrapped.calls.find((entry) => entry.kind === "query" && /UPDATE\s+"Phase2ReleaseCompatibilityAuthority"/m.test(entry.sql))?.sql || "", /"activationState"='ACTIVE'/);
});

test("M1 Team admission precedes the C2 lock graph on every outer retirement path", () => {
  const topologyFn = topology.slice(topology.indexOf("async function lockTeamControlPlaneTopology"), topology.indexOf("function normalizeCreatorIds"));
  indexOrder(topologyFn, [
    "await assertTeamControlPlaneWriteAdmission(tx)",
    "await lockAgencyLifecycleBarrier",
    "await lockDbAdvisoryXact",
  ], "topology service");

  const retire = lifecycle.slice(lifecycle.indexOf("async function retireCreatorWithinTransaction"), lifecycle.indexOf("function publishCreatorRetirementControlEvents"));
  indexOrder(retire, [
    "await assertTeamControlPlaneWriteAdmission(tx)",
    "await lockAgencyPipelineLifecycle",
    "await lockTeamControlPlaneTopology",
    "await lockCreatorPipelineLifecycle",
  ], "Creator retirement");

  const adminDelete = admin.slice(admin.indexOf('router.delete("/creators/:id"'));
  indexOrder(adminDelete, [
    "await assertTeamControlPlaneWriteAdmission(tx)",
    "await lockAgencyPipelineLifecycle",
    "await lockAgencyBillingMutation",
    "await retireCreatorWithinTransaction",
  ], "platform-admin Creator retirement");

  const destructiveDelete = destructive.slice(destructive.indexOf("async function processAgencyHardDeleteWorkItem"));
  indexOrder(destructiveDelete, [
    "await assertTeamControlPlaneWriteAdmission(tx)",
    "await lockAgencyPipelineLifecycleExclusive",
  ], "Agency destructive cleanup");
});


test("M1 DRAINING covers every Team Administration write transaction without widening the steady-state topology mutex", () => {
  const teamAdmin = read("src/services/team-administration-service.js");
  const wrapper = teamAdmin.slice(teamAdmin.indexOf("async function serializableTeamTransaction"), teamAdmin.indexOf("function requireLiveTeamActor"));
  indexOrder(wrapper, [
    "db.$transaction(async (tx)",
    "await assertTeamControlPlaneWriteAdmission(tx)",
    "return fn(tx)",
  ], "Team Administration release wrapper");

  for (const fn of ["createInvitation", "reissueInvitation", "revokeInvitation", "createCustomRole", "updateRoleMetadata", "deleteCustomRole"]) {
    const start = teamAdmin.indexOf(`async function ${fn}`);
    assert.ok(start >= 0, `missing ${fn}`);
  }
  // These paths remain intentionally outside the Agency-wide topology mutex after
  // activation; release admission is a deployment fence, not a new steady-state
  // serialization root.
  const metadata = teamAdmin.slice(teamAdmin.indexOf("async function updateRoleMetadata"), teamAdmin.indexOf("async function setRoleAccess"));
  assert.doesNotMatch(metadata, /lockTeamControlPlaneTopology/);
  const createInvite = teamAdmin.slice(teamAdmin.indexOf("async function createInvitation"), teamAdmin.indexOf("async function reissueInvitation"));
  assert.doesNotMatch(createInvite, /lockTeamControlPlaneTopology/);
});



test("M1 rolling anti-map covers every reachable Team control-plane storage writer", () => {
  const productionFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.endsWith(".test.js")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".js")) productionFiles.push(full);
    }
  };
  walk(path.join(root, "src"));

  const collect = (pattern) => productionFiles
    .filter((file) => pattern.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(root, file).replaceAll(path.sep, "/"))
    .sort();

  assert.deepEqual(collect(/agencyCustomRole\.(?:create|update|updateMany|delete|deleteMany|upsert)\s*\(|(?:INSERT INTO|UPDATE|DELETE FROM)\s+"AgencyCustomRole"/), [
    "src/services/team-administration-service.js",
  ]);
  assert.deepEqual(collect(/(?:agencyRoleOverride|agencySubPermissionOverride)\.(?:create|createMany|update|updateMany|delete|deleteMany|upsert)\s*\(/), [
    "src/services/team-administration-service.js",
  ]);
  assert.deepEqual(collect(/agencyInvitation\.(?:create|update|updateMany|delete|deleteMany|upsert)\s*\(|(?:INSERT INTO|UPDATE|DELETE FROM)\s+"AgencyInvitation"/), [
    "src/routes/auth.js",
    "src/routes/invitations.js",
    "src/services/creator-access-scope-authority-service.js",
    "src/services/team-administration-service.js",
  ]);

  const auth = read("src/routes/auth.js");
  const invitations = read("src/routes/invitations.js");
  const creatorAccess = read("src/services/creator-access-scope-authority-service.js");
  const teamAdmin = read("src/services/team-administration-service.js");
  assert.match(auth, /lockTeamControlPlaneTopology/);
  assert.match(invitations, /lockTeamControlPlaneTopology/);
  assert.match(teamAdmin, /async function serializableTeamTransaction[\s\S]*assertTeamControlPlaneWriteAdmission/);
  assert.match(creatorAccess, /retireCreatorCurrentAccess/);
  assert.match(lifecycle, /assertTeamControlPlaneWriteAdmission[\s\S]*retireCreatorCurrentAccess/);
});



test("M1 invitation claim/register preserve release-drain errors instead of masquerading as stale roles", () => {
  const auth = read("src/routes/auth.js");
  const invitations = read("src/routes/invitations.js");
  assert.match(auth, /catch \(lockError\)[\s\S]*TEAM_CONTROL_PLANE_[\s\S]*throw lockError[\s\S]*INVITE_ROLE_STALE/);
  assert.match(auth, /startsWith\("TEAM_CONTROL_PLANE_"\)[\s\S]*res\.status\(Number\(err\.status\)\)/);
  assert.match(invitations, /catch \(lockError\)[\s\S]*TEAM_CONTROL_PLANE_[\s\S]*throw lockError[\s\S]*INVITE_ROLE_STALE/);
});



test("M1 destructive Agency cleanup yields during intentional Team release drain instead of recording a false failure", () => {
  const destructiveDelete = destructive.slice(destructive.indexOf("async function processAgencyHardDeleteWorkItem"));
  indexOrder(destructiveDelete, [
    "await assertTeamControlPlaneWriteAdmission(tx)",
    'error?.code === "TEAM_CONTROL_PLANE_DRAINING"',
    'phase: "WAIT_TEAM_CONTROL_PLANE_RELEASE"',
    "await lockAgencyPipelineLifecycleExclusive",
  ], "Agency destructive drain dependency");
});

test("M1 operator activation is explicit CLI-only confirmation, not startup auto-activation", () => {
  assert.match(activationScript, /--activate/);
  assert.match(activationScript, /--confirm-old-binary-drained/);
  assert.match(activationScript, /activateTeamControlPlaneAfterDrain/);
  assert.match(activationScript, /Refusing activation/);
  assert.doesNotMatch(activationScript, /setTimeout|ONLINOD_PHASE2.*AUTO|process\.env\.[A-Z0-9_]*ACTIVATE/);
});

test("M1 activation preflight refuses ACTIVE when old-binary drain left a live Agency without operational OWNER", async () => {
  const db = {
    async $transaction(work) {
      const tx = {
        async $executeRawUnsafe() { return 1; },
        async $queryRawUnsafe(sql) {
          if (/FROM\s+"Agency"\s+a/i.test(sql)) return [{ id: "agency_without_owner" }];
          return [{
            scope: release.TEAM_CONTROL_PLANE_SCOPE,
            requiredGeneration: release.TEAM_CONTROL_PLANE_GENERATION,
            activationState: "DRAINING",
          }];
        },
      };
      return work(tx);
    },
  };

  await assert.rejects(
    release.activateTeamControlPlaneAfterDrain(db, { confirmOldBinaryDrained: true }),
    (error) => error?.code === "TEAM_CONTROL_PLANE_OWNER_INVARIANT_FAILED"
      && error?.status === 409
      && error?.details?.agencyIds?.[0] === "agency_without_owner",
  );
});

test("M1 authority-changing User lifecycle, Agency restore, and new-Agency bootstrap join release admission before authority locks/writes", () => {
  const adminSource = read("src/routes/admin.js");
  const userStart = adminSource.indexOf('router.patch("/users/:id"');
  const userEnd = adminSource.indexOf('router.post("/users/:id/force-logout"', userStart);
  const userPatch = adminSource.slice(userStart, userEnd);
  indexOrder(userPatch, [
    "await assertTeamControlPlaneWriteAdmission(tx)",
    'SELECT "id" FROM "User" WHERE "id"=$1 FOR UPDATE',
    "await assertUserDisableOwnerSafety",
    "tx.user.update",
  ], "User lifecycle release admission");

  const restoreStart = adminSource.indexOf('router.post("/agencies/:id/restore"');
  const restoreEnd = adminSource.indexOf('router.post("/agencies/:id/impersonate"', restoreStart);
  const restore = adminSource.slice(restoreStart, restoreEnd);
  indexOrder(restore, [
    "await assertTeamControlPlaneWriteAdmission(tx)",
    "lockAgencyPipelineLifecycleExclusive",
    "assertAgencyHasOperationalOwner",
    "tx.agency.update",
  ], "Agency restore release admission");

  const authSource = read("src/routes/auth.js");
  const bootstrapStart = authSource.indexOf("// New Agency + OWNER bootstrap");
  const bootstrapEnd = authSource.indexOf("// Audit15 projection authority", bootstrapStart);
  const bootstrap = authSource.slice(bootstrapStart, bootstrapEnd);
  indexOrder(bootstrap, [
    "await assertTeamControlPlaneWriteAdmission(tx)",
    "tx.agency.create",
    "tx.agencyMember.create",
  ], "new Agency bootstrap release admission");
});

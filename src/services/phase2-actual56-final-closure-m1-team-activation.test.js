"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const migration = read("prisma/migrations/20260912007000_phase2_actual56_team_control_plane_release_activation/migration.sql");
const generationFenceMigration = read("prisma/migrations/20260912008000_phase2_actual56_team_db_generation_fence/migration.sql");
const server = read("src/server.js");
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

function dbFenceRows({ disabled = null, omit = null, wrongTable = null, wrongCoverage = null } = {}) {
  const scopedDefinition = (triggerName, tableName) => {
    if (triggerName === "phase2_team_writer_generation_user_disabled") {
      return `CREATE TRIGGER ${triggerName} BEFORE UPDATE OF "disabledAt" OR DELETE ON "${tableName}" FOR EACH ROW EXECUTE FUNCTION ${release.TEAM_CONTROL_PLANE_DB_FENCE_FUNCTION}()`;
    }
    if (triggerName === "phase2_team_writer_generation_agency_lifecycle") {
      return `CREATE TRIGGER ${triggerName} BEFORE INSERT OR UPDATE OF "deletedAt" OR DELETE ON "${tableName}" FOR EACH ROW EXECUTE FUNCTION ${release.TEAM_CONTROL_PLANE_DB_FENCE_FUNCTION}()`;
    }
    return `CREATE TRIGGER ${triggerName} BEFORE INSERT OR UPDATE OR DELETE ON "${tableName}" FOR EACH ROW EXECUTE FUNCTION ${release.TEAM_CONTROL_PLANE_DB_FENCE_FUNCTION}()`;
  };
  return release.TEAM_CONTROL_PLANE_DB_FENCE_TRIGGERS
    .filter(([triggerName]) => triggerName !== omit)
    .map(([triggerName, tableName]) => ({
      triggerName,
      tableName: triggerName === wrongTable ? "WrongTable" : tableName,
      enabled: triggerName === disabled ? "D" : "O",
      functionName: release.TEAM_CONTROL_PLANE_DB_FENCE_FUNCTION,
      functionDefinition: `CREATE FUNCTION ${release.TEAM_CONTROL_PLANE_DB_FENCE_FUNCTION}() RETURNS trigger AS $$ ${release.TEAM_CONTROL_PLANE_DB_SETTING} ${release.TEAM_CONTROL_PLANE_GENERATION} "activationState" 'ACTIVE' PHASE2_INCOMPATIBLE_TEAM_CONTROL_PLANE_WRITER $$`,
      triggerDefinition: triggerName === wrongCoverage
        ? `CREATE TRIGGER ${triggerName} BEFORE DELETE ON "${tableName}" FOR EACH ROW EXECUTE FUNCTION ${release.TEAM_CONTROL_PLANE_DB_FENCE_FUNCTION}()`
        : scopedDefinition(triggerName, tableName),
    }));
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

test("M1 Team write admission rejects the root Prisma client because the DB token is transaction-local", async () => {
  const rootClient = {
    async $transaction() { throw new Error("must not be reached"); },
    async $executeRawUnsafe() { throw new Error("must not be reached"); },
    async $queryRawUnsafe() { throw new Error("must not be reached"); },
  };
  await assert.rejects(
    release.assertTeamControlPlaneWriteAdmission(rootClient),
    (error) => error?.code === "TEAM_CONTROL_PLANE_TRANSACTION_REQUIRED" && error?.status === 500,
  );
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

test("M1 pre-migration preflight fails before DDL when any live Agency lacks an operational OWNER", async () => {
  const badDb = {
    async $queryRawUnsafe(sql) {
      if (/FROM\s+"Agency"\s+a/i.test(sql)) return [{ id: "agency-bad" }];
      return [];
    },
  };
  await assert.rejects(
    release.preflightTeamControlPlaneMigration(badDb),
    (error) => error?.code === "TEAM_CONTROL_PLANE_MIGRATION_PREFLIGHT_FAILED"
      && error?.details?.blockerAgencyIds?.[0] === "agency-bad",
  );
  const good = await release.preflightTeamControlPlaneMigration({ async $queryRawUnsafe() { return []; } });
  assert.equal(good.safe, true);
});

test("M1 v2 migration establishes one release + multi-table DB cutover, installs the writer fence, and returns to DRAINING", () => {
  assert.match(generationFenceMigration, /phase2_team_control_plane_v2_durable_access/);
  assert.match(generationFenceMigration, /pg_advisory_xact_lock\(hashtext\('phase2:release-activation:TEAM_CONTROL_PLANE'\)\)/);
  assert.match(generationFenceMigration, /LOCK TABLE[\s\S]*"Agency"[\s\S]*"User"[\s\S]*"AgencyMember"[\s\S]*"AgencyInvitation"[\s\S]*"TeamMemberFunction"[\s\S]*"AgencyCustomRole"[\s\S]*"AgencyRoleOverride"[\s\S]*"AgencySubPermissionOverride"[\s\S]*IN SHARE ROW EXCLUSIVE MODE/);
  assert.match(generationFenceMigration, /current_setting\('onlinod\.phase2_team_control_plane_generation', true\)/);
  assert.match(generationFenceMigration, /SELECT "requiredGeneration", "activationState"[\s\S]*activation_state IS DISTINCT FROM 'ACTIVE'/);
  assert.match(generationFenceMigration, /ERRCODE = '55000'/);
  const releaseFencePos = generationFenceMigration.indexOf("pg_advisory_xact_lock(hashtext('phase2:release-activation:TEAM_CONTROL_PLANE'))");
  const lockPos = generationFenceMigration.indexOf("LOCK TABLE");
  const preflightPos = generationFenceMigration.indexOf("PHASE2_TEAM_CONTROL_PLANE_OWNER_PREFLIGHT_FAILED");
  const triggerFunctionPos = generationFenceMigration.indexOf("CREATE OR REPLACE FUNCTION phase2_require_team_control_plane_generation");
  assert.ok(releaseFencePos >= 0 && lockPos > releaseFencePos && preflightPos > lockPos && triggerFunctionPos > preflightPos, "migration must take the exclusive release fence before Team table locks, then preflight before installing the v2 DB fence");
  assert.match(generationFenceMigration, /FROM "Agency" a[\s\S]*a\."deletedAt" IS NULL[\s\S]*JOIN "User" u[\s\S]*m\."deletedAt" IS NULL[\s\S]*m\."deactivatedAt" IS NULL[\s\S]*u\."disabledAt" IS NULL[\s\S]*m\."roleKey" = 'owner'[\s\S]*m\."role" = 'OWNER'/);
  assert.match(generationFenceMigration, /ERRCODE = '23514'/);
  for (const table of ["AgencyMember", "TeamMemberFunction", "AgencyCustomRole", "AgencyRoleOverride", "AgencySubPermissionOverride", "AgencyInvitation"]) {
    assert.match(generationFenceMigration, new RegExp(`ON "${table}"`));
  }
  assert.match(generationFenceMigration, /BEFORE UPDATE OF "disabledAt" OR DELETE ON "User"/);
  assert.match(generationFenceMigration, /BEFORE INSERT OR UPDATE OF "deletedAt" OR DELETE ON "Agency"/);
  assert.match(generationFenceMigration, /INSERT INTO "Phase2ReleaseCompatibilityAuthority"[\s\S]*'phase2_team_control_plane_v2_durable_access'[\s\S]*'DRAINING'/);
});

test("M1 ACTIVE Team writer admission sets the exact DB generation token in-transaction", async () => {
  const calls = [];
  const tx = {
    async $executeRawUnsafe(sql, ...args) { calls.push({ kind: "execute", sql, args }); return 1; },
    async $queryRawUnsafe(sql, ...args) {
      calls.push({ kind: "query", sql, args });
      if (/set_config/.test(sql)) return [{ value: release.TEAM_CONTROL_PLANE_GENERATION }];
      return [{
        scope: release.TEAM_CONTROL_PLANE_SCOPE,
        requiredGeneration: release.TEAM_CONTROL_PLANE_GENERATION,
        activationState: "ACTIVE",
      }];
    },
  };
  const result = await release.assertTeamControlPlaneWriteAdmission(tx);
  assert.equal(result.admitted, true);
  const token = calls.find((entry) => entry.kind === "query" && /set_config/.test(entry.sql));
  assert.ok(token, "ACTIVE writer must set the transaction-local DB generation token");
  assert.deepEqual(token.args, [release.TEAM_CONTROL_PLANE_DB_SETTING, release.TEAM_CONTROL_PLANE_GENERATION]);
});

test("M1 legacy accessEpoch helpers cannot write AgencyMember outside the Team generation transaction", async () => {
  const { bumpMemberAccessEpoch, bumpAgencyAccessEpoch } = require("./access-epoch-service");
  const calls = [];
  const db = {
    async $transaction(work) {
      calls.push("transaction");
      const tx = {
        async $executeRawUnsafe(sql) { calls.push(/pg_advisory_xact_lock_shared/.test(sql) ? "release-lock" : "execute"); return 1; },
        async $queryRawUnsafe(sql) {
          if (/set_config/.test(sql)) { calls.push("generation-token"); return [{ value: release.TEAM_CONTROL_PLANE_GENERATION }]; }
          calls.push("release-row");
          return [{ scope: release.TEAM_CONTROL_PLANE_SCOPE, requiredGeneration: release.TEAM_CONTROL_PLANE_GENERATION, activationState: "ACTIVE" }];
        },
        agencyMember: {
          async update() { calls.push("member-update"); return { id: "member-1", accessEpoch: 9 }; },
          async updateMany() { calls.push("agency-update"); return { count: 3 }; },
        },
      };
      return work(tx);
    },
  };
  assert.equal(await bumpMemberAccessEpoch({ db, memberId: "member-1" }), 9);
  await bumpAgencyAccessEpoch({ db, agencyId: "agency-1" });
  assert.deepEqual(calls.slice(0, 5), ["transaction", "release-lock", "release-row", "generation-token", "member-update"]);
  const secondToken = calls.lastIndexOf("generation-token");
  const secondWrite = calls.lastIndexOf("agency-update");
  assert.ok(secondToken >= 0 && secondToken < secondWrite, "agency-wide bump must receive the transaction-local Team generation before DML");
});


test("M1 activation diagnostics fails closed when the operational-OWNER proof cannot be read", async () => {
  const db = {
    async $queryRawUnsafe(sql) {
      if (/FROM\s+pg_trigger\s+t/i.test(sql)) return dbFenceRows();
      if (/FROM\s+"Agency"\s+a/i.test(sql)) {
        const error = new Error("owner scan unavailable");
        error.code = "PG_OWNER_SCAN_FAILED";
        throw error;
      }
      return [{
        scope: release.TEAM_CONTROL_PLANE_SCOPE,
        requiredGeneration: release.TEAM_CONTROL_PLANE_GENERATION,
        activationState: "DRAINING",
      }];
    },
  };
  await assert.rejects(
    release.teamControlPlaneActivationDiagnostics(db),
    (error) => error?.code === "PG_OWNER_SCAN_FAILED",
    "operator diagnostics must not translate an unreadable OWNER invariant into zero blockers",
  );
});

test("M1 idempotent ACTIVE activation still fails closed when the physical DB fence is damaged", async () => {
  const db = {
    async $transaction(work) {
      const tx = {
        async $executeRawUnsafe() { return 1; },
        async $queryRawUnsafe(sql) {
          if (/FROM\s+pg_trigger\s+t/i.test(sql)) return dbFenceRows({ omit: "phase2_team_writer_generation_invitation" });
          return [{
            scope: release.TEAM_CONTROL_PLANE_SCOPE,
            requiredGeneration: release.TEAM_CONTROL_PLANE_GENERATION,
            activationState: "ACTIVE",
          }];
        },
      };
      return work(tx);
    },
  };
  await assert.rejects(
    release.activateTeamControlPlaneAfterDrain(db),
    (error) => error?.code === "TEAM_CONTROL_PLANE_DB_FENCE_INCOMPLETE",
  );
});

test("M1 activation rejects a missing or disabled physical PostgreSQL Team fence", async () => {
  const healthy = await release.readTeamControlPlaneDbFenceStatus({
    async $queryRawUnsafe() { return dbFenceRows(); },
  });
  assert.equal(healthy.ready, true);
  assert.equal(healthy.observedTriggerCount, release.TEAM_CONTROL_PLANE_DB_FENCE_TRIGGERS.length);

  const broken = await release.readTeamControlPlaneDbFenceStatus({
    async $queryRawUnsafe() { return dbFenceRows({ disabled: "phase2_team_writer_generation_agency_member" }); },
  });
  assert.equal(broken.ready, false);
  assert.equal(broken.mismatchedTriggers.length, 1);
  await assert.rejects(
    release.assertTeamControlPlaneDbFenceIntegrity({ async $queryRawUnsafe() { return dbFenceRows({ omit: "phase2_team_writer_generation_invitation" }); } }),
    (error) => error?.code === "TEAM_CONTROL_PLANE_DB_FENCE_INCOMPLETE" && error?.details?.missingTriggers?.includes("phase2_team_writer_generation_invitation"),
  );
  await assert.rejects(
    release.assertTeamControlPlaneDbFenceIntegrity({ async $queryRawUnsafe() { return dbFenceRows({ wrongCoverage: "phase2_team_writer_generation_agency_member" }); } }),
    (error) => error?.code === "TEAM_CONTROL_PLANE_DB_FENCE_INCOMPLETE"
      && error?.details?.mismatchedTriggers?.some((row) => row.triggerName === "phase2_team_writer_generation_agency_member" && row.coverageValid === false),
  );
});

test("M1 activation no longer trusts operator drain confirmation and takes the exclusive release fence", async () => {
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
          if (/FROM\s+pg_trigger\s+t/i.test(sql)) return dbFenceRows();
          if (/FROM\s+"Agency"\s+a/i.test(sql)) return [];
          if (/^UPDATE\s+"Phase2ReleaseCompatibilityAuthority"/m.test(sql.trim())) {
            return [{ scope: release.TEAM_CONTROL_PLANE_SCOPE, requiredGeneration: release.TEAM_CONTROL_PLANE_GENERATION, activationState: "ACTIVE" }];
          }
          return [{ scope: release.TEAM_CONTROL_PLANE_SCOPE, requiredGeneration: release.TEAM_CONTROL_PLANE_GENERATION, activationState: "DRAINING" }];
        },
      };
      const result = await work(tx);
      return { result, calls };
    },
  };

  const wrapped = await release.activateTeamControlPlaneAfterDrain(db);
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
  const accessEpoch = read("src/services/access-epoch-service.js");
  const teamAdmin = read("src/services/team-administration-service.js");
  assert.match(auth, /lockTeamControlPlaneTopology/);
  assert.match(invitations, /lockTeamControlPlaneTopology/);
  assert.match(teamAdmin, /async function serializableTeamTransaction[\s\S]*assertTeamControlPlaneWriteAdmission/);
  assert.match(accessEpoch, /withTeamControlPlaneWrite[\s\S]*assertTeamControlPlaneWriteAdmission/);
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

test("M1 maintenance CLI exposes preflight/diagnostics/activation and no DRAINING Team writer", () => {
  assert.match(activationScript, /--preflight-migration/);
  assert.match(activationScript, /preflightTeamControlPlaneMigration/);
  assert.match(activationScript, /--activate/);
  assert.match(activationScript, /teamControlPlaneActivationDiagnostics/);
  assert.match(activationScript, /activateTeamControlPlaneAfterDrain/);
  assert.doesNotMatch(activationScript, /--repair-owner|--confirm-draining-repair|repairOperationalOwnerDuringDrain/);
  assert.doesNotMatch(activationScript, /--confirm-old-binary-drained|TEAM_CONTROL_PLANE_DRAIN_CONFIRMATION_REQUIRED/);
  assert.doesNotMatch(activationScript, /setTimeout|ONLINOD_PHASE2.*AUTO|process\.env\.[A-Z0-9_]*ACTIVATE/);
});

test("M1 liveness and release readiness are separate observable facts", () => {
  const health = server.slice(server.indexOf('app.get("/health"'), server.indexOf('app.get("/api"'));
  assert.match(health, /app\.get\("\/health"[\s\S]*status: "healthy"/);
  assert.doesNotMatch(health.slice(0, health.indexOf('app.get("/ready"')), /TEAM_CONTROL_PLANE_GENERATION/);
  assert.match(health, /app\.get\("\/ready"[\s\S]*TEAM_CONTROL_PLANE_GENERATION[\s\S]*readTeamControlPlaneDbFenceStatus[\s\S]*dbFence\.ready[\s\S]*503/);
  assert.match(health, /health\/details[\s\S]*teamControlPlane[\s\S]*dbFence/);
});

test("M1 activation preflight refuses ACTIVE when old-binary drain left a live Agency without operational OWNER", async () => {
  const db = {
    async $transaction(work) {
      const tx = {
        async $executeRawUnsafe() { return 1; },
        async $queryRawUnsafe(sql) {
          if (/FROM\s+pg_trigger\s+t/i.test(sql)) return dbFenceRows();
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
    release.activateTeamControlPlaneAfterDrain(db),
    (error) => error?.code === "TEAM_CONTROL_PLANE_OWNER_INVARIANT_FAILED"
      && error?.status === 409
      && error?.details?.agencyIds?.[0] === "agency_without_owner",
  );
});

test("M1 v2 DRAINING exposes no Team mutation authority after the locked migration preflight", () => {
  const serviceSource = read("src/services/phase2-release-compatibility-authority-service.js");
  assert.doesNotMatch(serviceSource, /repairOperationalOwnerDuringDrain|TEAM_CONTROL_PLANE_DRAINING_REPAIR/);
  assert.doesNotMatch(serviceSource, /agencyMember\.(?:create|update|updateMany|delete|deleteMany|upsert)\s*\(/);
  assert.match(generationFenceMigration, /PHASE2_TEAM_CONTROL_PLANE_OWNER_PREFLIGHT_FAILED/);
  assert.match(generationFenceMigration, /BEFORE INSERT OR UPDATE OF "deletedAt" OR DELETE ON "Agency"/);
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

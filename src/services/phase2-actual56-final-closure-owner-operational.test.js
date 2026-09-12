"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

function loadOwnerSafetyPureFunctions() {
  const authority = read("src/services/team-operational-owner-authority-service.js");
  const body = authority.slice(0, authority.indexOf("module.exports"));
  return new Function(`${body}\nreturn { assertUserDisableOwnerSafety, assertAgencyHasOperationalOwner, assertAllLiveAgenciesHaveOperationalOwner };`)();
}


test("C2 owner invariant counts only live Member + live User operational OWNERs", () => {
  const authority = read("src/services/team-operational-owner-authority-service.js");
  assert.match(authority, /deletedAt:\s*null/);
  assert.match(authority, /deactivatedAt:\s*null/);
  assert.match(authority, /user:\s*\{\s*is:\s*\{\s*disabledAt:\s*null\s*\}\s*\}/);
  assert.match(authority, /error\.code = "LAST_OWNER"/);
  assert.match(authority, /targetOperational[\s\S]*if \(targetOperational === 0\) return/);

  const team = read("src/services/team-administration-service.js");
  assert.match(team, /assertOperationalOwnerRemovalSafety/);
});


test("C2 User disable rejects disabling the sole operational OWNER", async () => {
  const tx = {
    agencyMember: {
      findMany: async () => [{ id: "member-owner", agencyId: "agency-a" }],
      count: async ({ where }) => {
        assert.equal(where.agencyId, "agency-a");
        assert.deepEqual(where.id, { not: "member-owner" });
        assert.deepEqual(where.user, { is: { disabledAt: null } });
        return 0;
      },
    },
  };

  const { assertUserDisableOwnerSafety } = loadOwnerSafetyPureFunctions();
  await assert.rejects(
    () => assertUserDisableOwnerSafety({ tx, userId: "user-owner" }),
    (error) => error?.code === "LAST_OWNER" && error?.status === 409 && error?.details?.agencyId === "agency-a",
  );
});

test("C2 User disable succeeds when every owned Agency has another operational OWNER", async () => {
  const seen = [];
  const tx = {
    agencyMember: {
      findMany: async ({ where }) => {
        assert.equal(where.userId, "user-owner");
        assert.equal(where.deletedAt, null);
        assert.equal(where.deactivatedAt, null);
        assert.deepEqual(where.agency, { is: { deletedAt: null } });
        return [
          { id: "owner-a", agencyId: "agency-a" },
          { id: "owner-b", agencyId: "agency-b" },
        ];
      },
      count: async ({ where }) => {
        seen.push(where.agencyId);
        assert.deepEqual(where.user, { is: { disabledAt: null } });
        return 1;
      },
    },
  };

  const { assertUserDisableOwnerSafety } = loadOwnerSafetyPureFunctions();
  await assert.doesNotReject(() => assertUserDisableOwnerSafety({ tx, userId: "user-owner" }));
  assert.deepEqual(seen, ["agency-a", "agency-b"]);
});

test("C2 admin User disable checks owner safety after User FOR UPDATE and before eligibility mutation", () => {
  const admin = read("src/routes/admin.js");
  const start = admin.indexOf('router.patch("/users/:id"');
  const end = admin.indexOf('router.post("/users/:id/force-logout"', start);
  const route = admin.slice(start, end);

  const admission = route.indexOf("assertTeamControlPlaneWriteAdmission(tx)");
  const lock = route.indexOf('SELECT "id" FROM "User" WHERE "id"=$1 FOR UPDATE');
  const ownerSafety = route.indexOf("assertUserDisableOwnerSafety");
  const mutation = route.indexOf("tx.user.update");
  assert.ok(admission >= 0 && lock > admission && ownerSafety > lock && mutation > ownerSafety);
  assert.doesNotMatch(route, /lockTeamControlPlaneTopology/);
  assert.match(route, /TEAM_CONTROL_PLANE_SERIALIZATION_CONFLICT/);
});

test("C2 Serializable Team write conflicts surface as controlled 409 rather than backend 500", () => {
  const service = read("src/services/team-administration-service.js");
  const start = service.indexOf("async function serializableTeamTransaction");
  const end = service.indexOf("function requireLiveTeamActor", start);
  const block = service.slice(start, end);
  assert.match(block, /P2034/);
  assert.match(block, /TEAM_CONTROL_PLANE_SERIALIZATION_CONFLICT/);
  assert.match(block, /conflict\.status = 409/);
});

test("C2/M1 Agency restore and activation cannot expose a live Agency without an operational OWNER", async () => {
  const admin = read("src/routes/admin.js");
  const restoreStart = admin.indexOf('router.post("/agencies/:id/restore"');
  const restoreEnd = admin.indexOf('router.post("/agencies/:id/impersonate"', restoreStart);
  const restore = admin.slice(restoreStart, restoreEnd);
  const admission = restore.indexOf("assertTeamControlPlaneWriteAdmission(tx)");
  const lifecycle = restore.indexOf("lockAgencyPipelineLifecycleExclusive");
  const owner = restore.indexOf("assertAgencyHasOperationalOwner");
  const update = restore.indexOf("tx.agency.update");
  assert.ok(admission >= 0 && lifecycle > admission && owner > lifecycle && update > owner);

  const release = read("src/services/phase2-release-compatibility-authority-service.js");
  const activationStart = release.indexOf("async function activateTeamControlPlaneAfterDrain");
  const activationEnd = release.indexOf("async function runCreatorAccountWriteTransaction", activationStart);
  const activation = release.slice(activationStart, activationEnd);
  assert.match(activation, /lockDbAdvisoryXact[\s\S]*mode: "exclusive"/);
  assert.match(activation, /assertAllLiveAgenciesHaveOperationalOwner/);
  assert.ok(activation.indexOf("assertAllLiveAgenciesHaveOperationalOwner") < activation.indexOf('"activationState"=\'ACTIVE\''));
});

test("M1 new-Agency OWNER bootstrap joins release admission before Agency/Member creation", () => {
  const auth = read("src/routes/auth.js");
  const bootstrap = auth.slice(auth.indexOf("// New Agency + OWNER bootstrap"), auth.indexOf("// Audit15 projection authority"));
  assert.match(bootstrap, /assertTeamControlPlaneWriteAdmission\(tx\)/);
  assert.ok(bootstrap.indexOf("assertTeamControlPlaneWriteAdmission(tx)") < bootstrap.indexOf("tx.agency.create"));
  assert.ok(bootstrap.indexOf("tx.agency.create") < bootstrap.indexOf("tx.agencyMember.create"));
});

test("C2 anti-map keeps persistent User.disabledAt mutation behind the canonical admin owner-safety path", () => {
  const srcRoot = path.join(root, "src");
  const writers = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".js") || entry.name.endsWith(".test.js")) continue;
      const text = fs.readFileSync(full, "utf8");
      const disabledMutation = /\bdata\.disabledAt\s*=|data\s*:\s*\{[^}]{0,1000}disabledAt\s*:|UPDATE\s+"User"[\s\S]{0,1200}"disabledAt"\s*=/i.test(text);
      if (disabledMutation) writers.push(path.relative(root, full).replaceAll("\\", "/"));
    }
  };
  walk(srcRoot);
  assert.deepEqual(writers.sort(), ["src/routes/admin.js"]);

  const admin = read("src/routes/admin.js");
  assert.match(admin, /input\.disabled === true && !before\.disabledAt[\s\S]*assertUserDisableOwnerSafety/);
});

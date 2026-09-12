"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const creators = read("src/routes/creators.js");
const management = read("src/services/management-commit-authority-service.js");
const human = read("src/services/creator-human-management-authority-service.js");
const enrollment = read("src/services/creator-enrollment-authority-service.js");
const bootstrap = read("src/services/desktop-bootstrap-service.js");
const desktopAuthority = read("src/services/desktop-current-access-authority-service.js");
const desktopSecret = read("src/services/desktop-secret-delta-service.js");
const desktopRoute = read("src/routes/desktop.js");
const migration = read("prisma/migrations/20260912004000_phase2_actual56_creator_management_catalog_authority/migration.sql");
const schema = read("prisma/schema.prisma");

test("C5 Creator create revalidates live actor permission and broad scope before INSERT", () => {
  const create = creators.slice(creators.indexOf('router.post("/", creatorManagementRequired'), creators.indexOf('router.get("/:id"'));
  assert.match(create, /beforeCreate: async \(tx\)/);
  assert.match(create, /assertHumanCreatorCreateAuthority/);
  assert.match(enrollment, /if \(typeof beforeCreate === "function"\) await beforeCreate\(tx\);[\s\S]*creatorAccount\.create/);
  assert.match(human, /permissionKey: "creators\.manage"/);
  assert.match(human, /requireBroadCreatorScope: true/);
  assert.match(management, /MANAGEMENT_BROAD_CREATOR_SCOPE_REQUIRED/);
});

test("C5 metadata and avatar mutations own Agency -> Creator -> actor commit fence", () => {
  const patch = creators.slice(creators.indexOf('router.patch("/:id",'), creators.indexOf('router.delete("/:id"'));
  const avatar = creators.slice(creators.indexOf('router.post("/:id/avatar"'), creators.indexOf('module.exports = router'));
  for (const source of [patch, avatar]) {
    assert.match(source, /prisma\.\$transaction/);
    assert.match(source, /lockHumanCreatorMutation/);
  }
  const agency = human.indexOf("await lockAgencyLifecycle");
  const creator = human.indexOf('FROM "CreatorAccount"', agency);
  const actor = human.indexOf("await assertManagementCommitAuthority", creator);
  assert.ok(agency >= 0 && creator > agency && actor > creator);
  assert.match(human.slice(actor, actor + 700), /creatorRowsAlreadyLocked: true/);
});

test("C5 avatar abort removes uploaded file instead of reporting stale success", () => {
  const avatar = creators.slice(creators.indexOf('router.post("/:id/avatar"'), creators.indexOf('module.exports = router'));
  assert.match(avatar, /let committed = false/);
  assert.match(avatar, /if \(!committed\) safeUnlink\(req\.file\?\.path\)/);
  assert.match(avatar, /creatorErrorResponse\(res, err/);
});


test("C5 connection begin/complete/manual revoke share the same human commit authority", () => {
  const creatorRoutes = creators.slice(creators.indexOf('router.post("/:id/begin-connection"'), creators.indexOf('router.post("/:id/platform-profile"'));
  const sessionRoutes = read("src/routes/creator-sessions.js");
  assert.match(creatorRoutes, /actorMember: req\.auth\.membership/);
  assert.match(sessionRoutes, /revokeCreatorConnection\(\{[\s\S]*actorMember: req\.auth\.membership/);
  assert.match(enrollment, /lockHumanConnectionMutation/);
  assert.match(enrollment, /reassertHumanConnectionMutation/);
  assert.doesNotMatch(enrollment, /async function requireLiveConnectionAuthority/);
});

test("C6 Creator catalog membership is one bounded Agency generation, not O(all members)", () => {
  assert.match(schema, /model AgencyCreatorCatalogState/);
  assert.match(schema, /creatorCatalogState AgencyCreatorCatalogState\?/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "AgencyCreatorCatalogState"/);
  assert.match(migration, /CREATE TRIGGER trg_phase2_creator_catalog_generation/);
  assert.match(migration, /AFTER INSERT OR DELETE OR UPDATE OF "agencyId", "deletedAt"/);
  assert.match(migration, /"generation" = "AgencyCreatorCatalogState"\."generation" \+ 1/);
  const create = creators.slice(creators.indexOf('router.post("/", creatorManagementRequired'), creators.indexOf('router.get("/:id"'));
  assert.doesNotMatch(create, /agencyMember\.updateMany|agencyMember\.findMany|bumpAgencyAccessEpoch|publishAgencyAccessEpochEvents|ACCESS_EPOCH_CHANGED/);
});

test("C6 desktop bootstrap exports catalog generation while member accessEpoch stays member-specific", () => {
  assert.match(bootstrap, /currentCreatorCatalogGeneration/);
  assert.match(bootstrap, /creatorCatalogGeneration/);
  assert.match(bootstrap, /accessEpoch/);
  assert.doesNotMatch(human, /agencyMember\.updateMany/);
});


function productionCreatorMutationFiles() {
  const mutation = /creatorAccount\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/;
  const files = [];
  for (const dir of [path.join(root, "src", "routes"), path.join(root, "src", "services")]) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".js") || name.endsWith(".test.js")) continue;
      const abs = path.join(dir, name);
      if (!fs.statSync(abs).isFile()) continue;
      const source = fs.readFileSync(abs, "utf8");
      if (mutation.test(source)) files.push([path.relative(root, abs).replaceAll("\\", "/"), source]);
    }
  }
  return new Map(files);
}

test("C5 every direct human CreatorAccount writer remains behind a commit-time authority", () => {
  const writers = productionCreatorMutationFiles();
  const required = {
    "src/routes/creators.js": ["assertHumanCreatorCreateAuthority", "lockHumanCreatorMutation", "retireCreatorWithinTransaction"],
    "src/services/creator-enrollment-authority-service.js": ["lockHumanConnectionMutation", "authorizeCreatorAccountWrite"],
    "src/services/creator-telegram-contact-authority-service.js": ["lockCreatorPipelineLifecycle", "assertManagementCommitAuthority"],
    "src/services/creator-telegram-identity.js": ["lockCreatorPipelineLifecycle", "assertManagementCommitAuthority"],
    "src/services/custom-vault-destination-service.js": ["assertCustomManagementCreatorAccess", "authorizeCreatorAccountWrite"],
    "src/services/creator-lifecycle-authority-service.js": ["assertManagementCommitAuthority", "retireCreatorCurrentAccess"],
  };
  for (const [rel, markers] of Object.entries(required)) {
    assert.ok(writers.has(rel), `${rel} must remain in the direct CreatorAccount writer inventory`);
    const source = writers.get(rel);
    for (const marker of markers) assert.match(source, new RegExp(marker));
  }

  const classifiedInternal = new Set([
    "src/services/creator-session-broker-service.js",
    "src/services/phase2-destructive-delete-authority-service.js",
    "src/services/telegram-account-retirement-fanout-service.js",
  ]);
  const classified = new Set([...Object.keys(required), ...classifiedInternal]);
  assert.deepEqual([...writers.keys()].filter((rel) => !classified.has(rel)).sort(), [], "new direct CreatorAccount writer requires explicit C5 classification");
});

test("C6 creator-catalog publication is O(1) with respect to Agency membership", () => {
  assert.doesNotMatch(migration, /"AgencyMember"|agencyMember\.|publishAgencyAccessEpochEvents|ACCESS_EPOCH_CHANGED/);
  const create = creators.slice(creators.indexOf('router.post("/", creatorManagementRequired'), creators.indexOf('router.get("/:id"'));
  assert.doesNotMatch(create, /AgencyMember|agencyMember\.|bumpAgencyAccessEpoch|publishAgencyAccessEpochEvents|ACCESS_EPOCH_CHANGED/);
});

test("C6 desktop bootstrap publishes generation and creator membership from one stable seqlock snapshot", () => {
  assert.match(bootstrap, /generationBefore = await currentCreatorCatalogGeneration/);
  assert.match(bootstrap, /creators = await listAccessibleCreatorRows/);
  assert.match(bootstrap, /generationAfter = await currentCreatorCatalogGeneration/);
  assert.match(bootstrap, /generationBefore === generationAfter/);
  assert.match(bootstrap, /desktopMemberAuthorityFingerprint\(memberBefore\) === desktopMemberAuthorityFingerprint\(memberAfter\)/);
  assert.match(bootstrap, /readCurrentDesktopMemberAuthority/);
  assert.match(bootstrap, /CREATOR_CATALOG_SNAPSHOT_UNSTABLE/);
  assert.doesNotMatch(bootstrap, /Promise\.all\(\[\s*listAccessibleCreatorRows[\s\S]*currentCreatorCatalogGeneration/);
});

test("C6 stable catalog reader retries a raced membership change and never pairs stale rows with a newer generation", async () => {
  const { readStableAccessibleCreatorCatalog } = require("./desktop-bootstrap-service");
  const generations = [4, 5, 5, 5];
  let generationRead = 0;
  let listRead = 0;
  const member = { id: "m1", userId: "u1", agencyId: "a1", role: "OWNER", roleKey: "owner", assignedCreators: "all", accessEpoch: 7 };
  const db = {
    agencyMember: { async findFirst() { return { ...member }; } },
    agencyCreatorCatalogState: {
      async findUnique() { return { generation: generations[generationRead++] }; },
    },
    creatorAccount: {
      async findMany() {
        listRead += 1;
        return listRead === 1 ? [{ id: "old" }] : [{ id: "old" }, { id: "new" }];
      },
    },
  };
  const result = await readStableAccessibleCreatorCatalog({
    db, agencyId: "a1", userId: "u1", member, maxAttempts: 3,
  });
  assert.equal(listRead, 2);
  assert.equal(result.creatorCatalogGeneration, 5);
  assert.deepEqual(result.creators.map((row) => row.id), ["old", "new"]);
});

test("C6 stable catalog reader fails closed under continuous membership churn", async () => {
  const { readStableAccessibleCreatorCatalog } = require("./desktop-bootstrap-service");
  let generation = 0;
  const member = { id: "m1", userId: "u1", agencyId: "a1", role: "OWNER", roleKey: "owner", assignedCreators: "all", accessEpoch: 7 };
  const db = {
    agencyMember: { async findFirst() { return { ...member }; } },
    agencyCreatorCatalogState: { async findUnique() { generation += 1; return { generation }; } },
    creatorAccount: { async findMany() { return []; } },
  };
  await assert.rejects(
    () => readStableAccessibleCreatorCatalog({ db, agencyId: "a1", userId: "u1", member, maxAttempts: 2 }),
    (error) => error?.code === "CREATOR_CATALOG_SNAPSHOT_UNSTABLE" && error?.status === 503 && error?.retryable === true,
  );
});


test("C6 stable bootstrap retries member-scope churn and returns the new accessEpoch/catalog", async () => {
  const { readStableAccessibleCreatorCatalog } = require("./desktop-bootstrap-service");
  const oldMember = { id: "m1", userId: "u1", agencyId: "a1", role: "OPERATOR", roleKey: "chatter", assignedCreators: { creatorIds: ["c1"] }, accessEpoch: 9 };
  const newMember = { ...oldMember, assignedCreators: { creatorIds: [] }, accessEpoch: 10 };
  const memberReads = [oldMember, newMember, newMember, newMember];
  let memberRead = 0;
  let listRead = 0;
  const db = {
    agencyMember: { async findFirst() { return { ...memberReads[Math.min(memberRead++, memberReads.length - 1)] }; } },
    agencyCreatorCatalogState: { async findUnique() { return { generation: 5 }; } },
    creatorAccount: {
      async findMany(input) {
        listRead += 1;
        const ids = input.where?.id?.in || [];
        return ids.includes("c1") ? [{ id: "c1" }] : [];
      },
    },
  };
  const result = await readStableAccessibleCreatorCatalog({ db, agencyId: "a1", userId: "u1", member: oldMember, maxAttempts: 3 });
  assert.equal(listRead, 2);
  assert.equal(result.accessEpoch, 10);
  assert.deepEqual(result.creators, []);
});

test("C6 stable bootstrap fails closed if member/User authority disappears mid-read", async () => {
  const { readStableAccessibleCreatorCatalog } = require("./desktop-bootstrap-service");
  const member = { id: "m1", userId: "u1", agencyId: "a1", role: "OPERATOR", roleKey: "chatter", assignedCreators: { creatorIds: ["c1"] }, accessEpoch: 9 };
  let reads = 0;
  const db = {
    agencyMember: { async findFirst() { reads += 1; return reads === 1 ? { ...member } : null; } },
    agencyCreatorCatalogState: { async findUnique() { return { generation: 5 }; } },
    creatorAccount: { async findMany() { return [{ id: "c1" }]; } },
  };
  await assert.rejects(
    () => readStableAccessibleCreatorCatalog({ db, agencyId: "a1", userId: "u1", member, maxAttempts: 2 }),
    (error) => error?.code === "DESKTOP_MEMBER_AUTHORITY_REVOKED" && error?.status === 403,
  );
});


test("C6 desktop current-access authority is shared by bootstrap, secret delta, and post-wait control filtering", () => {
  assert.match(desktopAuthority, /deletedAt:\s*null/);
  assert.match(desktopAuthority, /deactivatedAt:\s*null/);
  assert.match(desktopAuthority, /user:\s*\{\s*is:\s*\{\s*disabledAt:\s*null/);
  assert.match(desktopAuthority, /agency:\s*\{\s*is:\s*\{\s*deletedAt:\s*null/);
  assert.match(desktopSecret, /readCurrentDesktopMemberAuthority/);
  assert.match(desktopSecret, /DESKTOP_SECRET_MEMBER_INACTIVE/);
  const control = desktopRoute.slice(desktopRoute.indexOf('router.get("/control/events"'), desktopRoute.indexOf('router.post("/bootstrap"'));
  assert.ok(control.indexOf("waitForDesktopControlEvents") < control.indexOf("filterAuthorizedControlEventsStable(req, result.events)"));
  assert.match(desktopRoute, /withStableDesktopCurrentAccess/);
  assert.match(desktopRoute, /readGeneration:\s*\(\) => currentCreatorCatalogGeneration/);
  assert.match(desktopRoute, /work:\s*\(member\) => filterAuthorizedControlEvents\(req, events, member\)/);
});

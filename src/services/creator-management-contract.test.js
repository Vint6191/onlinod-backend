"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("changed creator-management backend files pass node syntax checks", () => {
  for (const rel of ["routes/creators.js", "middleware/creator-management-permissions.js", "services/creator-agency-removal.js"]) {
    execFileSync(process.execPath, ["--check", path.join(root, rel)], { stdio: "pipe" });
  }
});

test("all creator writes require management permission", () => {
  const source = read("routes/creators.js");
  assert.match(source, /router\.post\("\/", creatorManagementRequired/);
  assert.match(source, /router\.patch\("\/:id\/telegram-contact", creatorManagementRequired, creatorAccessRequired/);
  assert.match(source, /router\.patch\("\/:id", creatorManagementRequired/);
  assert.match(source, /router\.delete\("\/:id", creatorManagementRequired/);
  assert.match(source, /router\.post\("\/:id\/begin-connection", creatorManagementRequired, creatorAccessRequired/);
  assert.match(source, /router\.post\("\/:id\/complete-connection", creatorManagementRequired, creatorAccessRequired/);
  assert.match(source, /router\.post\("\/:id\/platform-profile", creatorAccessRequired/);
  assert.match(source, /router\.post\("\/:id\/avatar", creatorManagementRequired/);
});

test("creation requires an expected OnlyFans username and keeps Chromium partition device-local", () => {
  const source = read("routes/creators.js");
  assert.match(source, /const creatorUsernameSchema = z\.string\(\)\.trim\(\)\.min\(1\)\.max\(120\)\.regex/);
  assert.match(source, /username: creatorUsernameSchema/);
  const createRoute = source.slice(source.indexOf('router.post("/", creatorManagementRequired'), source.indexOf('router.get("/:id"'));
  assert.doesNotMatch(createRoute, /\bpartition\b/);
  assert.doesNotMatch(createRoute, /persist:acct_|makePartition/);
  assert.match(source, /CREATOR_ALREADY_EXISTS/);
  assert.match(source, /mode: "insensitive"/);
  const createSchema = source.slice(source.indexOf("const createSchema"), source.indexOf("const completeConnectionSchema"));
  assert.doesNotMatch(createSchema, /remoteId|partition|status/);
});

test("runtime completion is identity-bound, generation-fenced and committed by one enrollment authority", () => {
  const routes = read("routes/creators.js");
  const service = read("services/creator-enrollment-authority-service.js");
  assert.match(routes, /completeCreatorConnection\(\{/);
  assert.match(routes, /connectionGeneration: input\.connectionGeneration/);
  assert.doesNotMatch(routes, /CREATOR_PARTITION_MISMATCH/);
  assert.match(service, /CREATOR_IDENTITY_MISMATCH/);
  assert.match(service, /creatorSessionState\.findUnique/);
  assert.match(service, /CREATOR_CANONICAL_SESSION_REQUIRED/);
  assert.match(service, /canonical\.status !== "ACTIVE"/);
  assert.match(service, /canonical\.platformUserId/);
  assert.match(service, /creatorConnectionLockKey\(agencyId, creatorId\)/);
  assert.match(service, /requireLiveConnectionAuthority/);
  assert.match(service, /CREATOR_CONNECTION_GENERATION_STALE/);
  assert.match(service, /connectionState: CREATOR_CONNECTION_STATES\.CONNECTED/);
  assert.match(service, /connectedSessionRevision: Number\(canonical\.revision\)/);
  assert.match(routes, /if \(result\.connectedNow\)/);
  assert.match(routes, /scheduleInitialJobsForCreator/);
});

test("agency removal requires two consequences and only the username phrase", () => {
  const source = read("routes/creators.js");
  assert.match(source, /const agencyRemovalSchema = z\.object/);
  assert.match(source, /acknowledgeAgencyRemoval: z\.literal\(true\)/);
  assert.match(source, /acknowledgeSessionRevocation: z\.literal\(true\)/);
  assert.doesNotMatch(source, /confirmation: z\.string|input\.confirmation/);
  assert.match(source, /input\.phrase !== expectedPhrase/);
  assert.match(source, /CREATOR_DELETE_PHRASE_REQUIRED/);
});

test("agency removal revokes live access but preserves creator history transactionally", () => {
  const source = read("routes/creators.js");
  const removal = source.slice(source.indexOf('router.delete("/:id"'), source.indexOf('router.post("/:id/complete-connection"'));
  assert.match(removal, /prisma\.\$transaction/);
  assert.match(removal, /agencyMember\.findMany/);
  assert.match(removal, /removeCreatorFromAssignedCreators/);
  assert.match(removal, /agencyMember\.update/);
  assert.match(removal, /retireCreatorCryptoMaterialOnRemoval/);
  assert.match(removal, /deviceCreatorBinding\.updateMany/);
  assert.doesNotMatch(removal, /creatorConnectSession|CreatorConnectSession|accessSnapshot|AccessSnapshot/);
  assert.match(removal, /status: \{ in: \["SCHEDULED", "CLAIMED", "FAILED"\] \}/);
  assert.match(removal, /creatorAccount\.update/);
  assert.match(removal, /status: "DISABLED", deletedAt: removedAt/);
  assert.doesNotMatch(removal, /creatorAccount\.delete|crmProfile\.(?:delete|deleteMany)|crmNote\.(?:delete|deleteMany)|dialogMessageLedger\.(?:delete|deleteMany)/);
  assert.match(removal, /creator\.removed_from_agency/);
  assert.match(removal, /messageHistoryPreserved: true/);
  assert.match(removal, /crmDataPreserved: true/);
  assert.match(removal, /timeout: 120_000/);
});

test("agency removal is retry-safe using the archived creator row", () => {
  const source = read("routes/creators.js");
  const removal = source.slice(source.indexOf('router.delete("/:id"'), source.indexOf('router.post("/:id/complete-connection"'));
  assert.match(removal, /if \(existing\.deletedAt\)/);
  assert.match(removal, /alreadyRemoved: true/);
  assert.match(removal, /historyPreserved: true/);
  assert.doesNotMatch(removal, /\bpartition\b/);
  assert.doesNotMatch(removal, /auditLog\.findFirst|deletionPhraseFromAudit/);
});

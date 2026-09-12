"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.resolve(__dirname, "..");

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith(".js") && !entry.name.endsWith(".test.js")) out.push(full);
  }
  return out;
}

const productionFiles = walk(SRC);
const rel = (file) => path.relative(path.resolve(__dirname, "../.."), file).replaceAll("\\", "/");

function filesMatching(regex) {
  return productionFiles
    .filter((file) => regex.test(fs.readFileSync(file, "utf8")))
    .map(rel)
    .sort();
}

function exact(actual, expected, label) {
  assert.deepEqual(actual, [...expected].sort(), label);
}

test("SOURCE FINAL anti-map: every DomainWorkItem storage mutator is classified", () => {
  exact(filesMatching(/domainWorkItem\.(?:create|createMany|upsert|update|updateMany|delete|deleteMany)\s*\(|(?:INSERT INTO|UPDATE|DELETE FROM)\s+"DomainWorkItem"/), [
    "src/services/custom-order-reminders.js",
    "src/services/domain-work-authority-service.js",
    "src/services/phase2-destructive-delete-authority-service.js",
  ], "A new DomainWorkItem writer must join C1 conservation + M1 executor review");
});

test("SOURCE FINAL anti-map: every AgencyMember storage mutator is classified", () => {
  exact(filesMatching(/agencyMember\.(?:create|createMany|upsert|update|updateMany|delete|deleteMany)\s*\(|(?:INSERT INTO|UPDATE|DELETE FROM)\s+"AgencyMember"/), [
    "src/routes/admin.js",
    "src/routes/auth.js",
    "src/services/access-epoch-service.js",
    "src/services/creator-access-scope-authority-service.js",
    "src/services/team-administration-service.js",
  ], "A new AgencyMember writer must join the C2 Team control-plane lock graph");
});

test("SOURCE FINAL anti-map: all Team role-definition writers stay in canonical Team Administration", () => {
  exact(filesMatching(/(?:agencyCustomRole|agencyRoleOverride)\.(?:create|createMany|upsert|update|updateMany|delete|deleteMany)\s*\(/), [
    "src/services/team-administration-service.js",
  ], "Role lifecycle writers must not bypass canonical C2 ordering");
});

test("SOURCE FINAL anti-map: every CreatorAccount storage mutator is classified", () => {
  exact(filesMatching(/creatorAccount\.(?:create|createMany|upsert|update|updateMany|delete|deleteMany)\s*\(|(?:INSERT INTO|UPDATE|DELETE FROM)\s+"CreatorAccount"/), [
    "src/routes/creators.js",
    "src/services/creator-enrollment-authority-service.js",
    "src/services/creator-lifecycle-authority-service.js",
    "src/services/creator-session-broker-service.js",
    "src/services/creator-telegram-contact-authority-service.js",
    "src/services/creator-telegram-identity.js",
    "src/services/custom-vault-destination-service.js",
    "src/services/phase2-destructive-delete-authority-service.js",
    "src/services/telegram-account-retirement-fanout-service.js",
  ], "A new CreatorAccount writer must join C5/M1 authority classification");
});

test("SOURCE FINAL anti-map: current operational Pending truth has only the two canonical consumers", () => {
  exact(filesMatching(/TeamOperationalPendingCurrent/), [
    "src/services/team-analytics-service.js",
    "src/services/team-pending-read-service.js",
  ], "A new current-Pending consumer must reuse C3/C4 operational-owner semantics");
});

test("SOURCE FINAL anti-map: authority-changing rolling-release admission is confined to canonical control-plane surfaces", () => {
  exact(filesMatching(/assertTeamControlPlaneWriteAdmission/), [
    "src/routes/admin.js",
    "src/routes/auth.js",
    "src/services/creator-lifecycle-authority-service.js",
    "src/services/phase2-destructive-delete-authority-service.js",
    "src/services/phase2-release-compatibility-authority-service.js",
    "src/services/team-administration-service.js",
    "src/services/team-control-plane-authority-service.js",
  ], "A new release-gated authority writer must be explicitly classified under M1");
});

test("SOURCE FINAL anti-map: Desktop current access is one shared live Member/User/Agency authority", () => {
  const authority = fs.readFileSync(path.join(SRC, "services/desktop-current-access-authority-service.js"), "utf8");
  const bootstrap = fs.readFileSync(path.join(SRC, "services/desktop-bootstrap-service.js"), "utf8");
  const secrets = fs.readFileSync(path.join(SRC, "services/desktop-secret-delta-service.js"), "utf8");
  const desktop = fs.readFileSync(path.join(SRC, "routes/desktop.js"), "utf8");
  assert.match(authority, /deletedAt:\s*null[\s\S]*deactivatedAt:\s*null[\s\S]*user:\s*\{\s*is:\s*\{\s*disabledAt:\s*null[\s\S]*agency:\s*\{\s*is:\s*\{\s*deletedAt:\s*null/);
  assert.match(bootstrap, /readCurrentDesktopMemberAuthority/);
  assert.match(secrets, /readCurrentDesktopMemberAuthority/);
  assert.match(desktop, /withStableDesktopCurrentAccess/);
  assert.match(desktop, /currentCreatorCatalogGeneration/);
});

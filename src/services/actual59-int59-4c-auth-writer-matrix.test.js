"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function source(rel) {
  return fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");
}

const authService = () => source("services/auth-service.js");
const authRoute = () => source("routes/auth.js");
const settings = () => source("services/settings-service.js");
const admin = () => source("routes/admin.js");
const crypto = () => source("services/client-e2e-keyring-service.js");
const authority = () => source("services/authorization-session-authority-service.js");

test("INT59.4C refresh HTTP route forwards the durable Desktop incarnation into refresh rotation", () => {
  const text = authRoute();
  assert.match(text, /refreshAccessToken\(\{[\s\S]{0,400}?authorizationScopeIncarnation:\s*input\.authorizationScopeIncarnation\s*\|\|\s*null/);
});

test("INT59.4C authorization locks reuse the canonical executeRaw transaction-lock authority", () => {
  const text = authority();
  assert.match(text, /lockDbAdvisoryXact/);
  assert.doesNotMatch(text, /pg_advisory_xact_lock/);
  assert.doesNotMatch(authService(), /pg_advisory_xact_lock/);
});

test("INT59.4C login and refresh use one lock order: user then device then optional lineage", () => {
  const text = authService();
  const login = text.slice(text.indexOf("async function issueLoginTokens"), text.indexOf("async function verifyEmailByToken"));
  assert.ok(login.indexOf("acquireAuthorizationUserLock") < login.indexOf("acquireAuthorizationDeviceLock"));
  assert.ok(login.indexOf("acquireAuthorizationDeviceLock") < login.indexOf("lockCurrentLoginAuthority"));
  const refresh = text.slice(text.indexOf("async function refreshAccessToken"), text.indexOf("async function revokeRefreshToken"));
  assert.ok(refresh.indexOf("acquireAuthorizationUserLock") < refresh.indexOf("acquireAuthorizationDeviceLock"));
  assert.ok(refresh.indexOf("acquireAuthorizationDeviceLock") < refresh.indexOf("lockCurrentLoginAuthority"));
  assert.ok(login.indexOf("lockCurrentLoginAuthority") < login.indexOf("acquireAuthorizationLineageLock"));
  assert.ok(refresh.indexOf("lockCurrentLoginAuthority") < refresh.indexOf("acquireAuthorizationLineageLock"));
  assert.equal((text.match(/acquireAuthorizationLineageLock\(/g) || []).length, 2,
    "fresh login and legacy refresh adoption may each lock lineage, but only after USER -> DEVICE -> current authority");
});

test("INT59.4C refresh-only account writers serialize with login/refresh publication", () => {
  assert.match(settings(), /withAuthorizationUserLock\([\s\S]*?refreshSession\.updateMany/);
  const lock = settings().slice(settings().indexOf("async function lockEligibleAccountUser"), settings().indexOf("async function updateAccountProfile"));
  assert.match(lock, /acquireAuthorizationUserLock\(db,\s*\{\s*userId\s*\}\)/);
  const password = settings().slice(settings().indexOf("async function changeAccountPassword"), settings().indexOf("async function requestAccountPasswordReset"));
  assert.ok(password.indexOf("lockEligibleAccountUser") < password.indexOf("tx.user.update"));
  for (const file of ["services/account-security-command-service.js", "services/account-password-reset-service.js"]) {
    const body = source(file); assert.ok(body.indexOf("await acquireAuthorizationUserLock") < body.indexOf("tx.refreshSession.updateMany"));
  }
  assert.match(crypto(), /retireCurrentDeviceIdentity[\s\S]{0,1400}?acquireAuthorizationUserLock\(tx,\s*\{\s*userId\s*\}\)/);
  assert.match(admin(), /force-logout", operationHandler\("user.logout"\)/);
  assert.match(admin(), /devices\/:id\/kick", operationHandler\("device.kick"\)/);
  const operations = source("services/admin-operational-command-service.js");
  assert.match(operations, /acquireAuthorizationUserLock\(tx,\{userId:targetId\}\)/);
  assert.match(operations, /acquireAuthorizationUserLock\(tx,\{userId:input.userId\}\)/);
});

test("INT59.4C business-authority writers remain fenced by current User/Member/Agency rows rather than a second auth authority", () => {
  const text = authority();
  assert.match(text, /FROM "AgencyMember" m[\s\S]*JOIN "User" u[\s\S]*JOIN "Agency" a[\s\S]*FOR SHARE OF m,u,a/);
  assert.match(text, /AUTHORIZATION_GENERATION_CHANGED/);
  assert.match(text, /CREDENTIAL_GENERATION_CHANGED/);
});


test("INT59.4D refresh source token is a commit-time DB-clock fence after USER/DEVICE/current-authority locks", () => {
  const authorityText = authority();
  const sourceFenceBody = authorityText.slice(authorityText.indexOf("async function lockCurrentRefreshSession"), authorityText.indexOf("async function withAuthorizationUserLock"));
  assert.match(sourceFenceBody, /FROM "RefreshSession" r/);
  assert.match(sourceFenceBody, /clock_timestamp\(\)/);
  assert.match(sourceFenceBody, /FOR UPDATE/);
  const text = authService();
  const refresh = text.slice(text.indexOf("async function refreshAccessToken"), text.indexOf("async function revokeRefreshToken"));
  const user = refresh.indexOf("acquireAuthorizationUserLock");
  const device = refresh.indexOf("acquireAuthorizationDeviceLock");
  const authorityFence = refresh.indexOf("lockCurrentLoginAuthority");
  const sourceFence = refresh.indexOf("lockCurrentRefreshSession");
  const create = refresh.indexOf("tx.refreshSession.create");
  assert.ok(user >= 0 && user < device && device < authorityFence && authorityFence < sourceFence && sourceFence < create);
});



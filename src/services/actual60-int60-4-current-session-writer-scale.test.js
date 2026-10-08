"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

function block(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start >= 0 && end > start, `missing block ${startNeedle} -> ${endNeedle}`);
  return source.slice(start, end);
}

// Operations moved from inline routes to the command receipt transaction.
// Keep route reachability and the live-only WHERE predicate in the same check.
function adminSource(actions) {
  const routes = read('src/routes/admin.js');
  const handlers = read('src/routes/admin-command-handlers.js');
  for (const action of actions) assert(routes.includes(`operationHandler("${action}"`), action);
  assert.match(handlers, /admin-operational-command-service[\s\S]*executeAdminOperation/);
  const source = read('src/services/admin-operational-command-service.js');
  assert.match(source, /executeAdminCommand\(\{db,actor,commandId,action,targetId/);
  return source;
}
test("INT60.4 scale: agency retirement revokes only live RefreshSession rows", () => {
  const source = adminSource(['agency.retire']);
  const retire = block(source, 'if(action.startsWith("agency."))', 'if(action.startsWith("member."))');
  assert.match(retire, /refreshSession\.updateMany\(\{where:\{agencyId:targetId,revokedAt:null,expiresAt:\{gt:now\}\},data:\{revokedAt:now\}/);
  assert.match(retire, /if\(input.hard\).*publishDomainWork/);
});
test("INT60.4 scale: admin account lifecycle writers exclude expired-unrevoked history", () => {
  const source = adminSource(['user.update','user.logout','user.password.reset','device.kick']);
  const user = block(source, 'if(action.startsWith("user."))', 'if(action==="creator.retire")');
  assert.match(user, /refreshSession\.updateMany\(\{where:\{userId:targetId,revokedAt:null,expiresAt:\{gt:now\}\}/);
  assert.match(user, /const revoke=action!=="user.update"\|\|input.disabled===true/);
  const kick = block(source, 'if(action==="device.kick")', 'if(action==="maintenance.subscriber.requeue")');
  assert.match(kick, /refreshSession\.updateMany\(\{where:\{userId:input.userId,agencyId:input.agencyId,deviceId:targetId,revokedAt:null,expiresAt:\{gt:now\}\}/);
});

test("INT60.4 scale: account recovery, crypto retirement and Team removal mutate only live session rows", () => {
  const authRoute = read("src/routes/auth.js");
  assert.match(authRoute, /account-password-reset-service[\s\S]*resetAccountPassword/);
  const reset = read("src/services/account-password-reset-service.js");
  assert.match(reset, /userId:\s*(?:record\.userId|userId),\s*revokedAt:\s*null,\s*expiresAt:\s*\{\s*gt:\s*now\s*\}/);

  const crypto = read("src/services/client-e2e-keyring-service.js");
  const retireStart = crypto.indexOf("async function retireCurrentDeviceIdentity");
  assert.ok(retireStart >= 0);
  const retire = crypto.slice(retireStart, retireStart + 9000);
  assert.match(retire, /userId,\s*agencyId,\s*deviceId:\s*id,\s*revokedAt:\s*null,\s*expiresAt:\s*\{\s*gt:\s*now\s*\}/);

  const team = read("src/services/team-administration-service.js");
  const setStatus = block(team, "async function setMemberStatus", "async function removeMember");
  assert.match(setStatus, /userId:\s*liveTarget\.userId,\s*agencyId,\s*revokedAt:\s*null,\s*expiresAt:\s*\{\s*gt:\s*deactivatedAt\s*\}/);
  const remove = block(team, "async function removeMember", "async function updateMemberAccessByPlatformAdmin");
  assert.match(remove, /userId:\s*liveTarget\.userId,\s*agencyId,\s*revokedAt:\s*null,\s*expiresAt:\s*\{\s*gt:\s*deletedAt\s*\}/);
});

test("INT60.4 scale: exact-session revokes may remain history-addressed because id bounds work independently of rotation cardinality", () => {
  const auth = read("src/services/auth-service.js");
  assert.match(auth, /where:\s*\{\s*id:\s*session\.id,\s*revokedAt:\s*null\s*\}/);
  const settings = read("src/services/settings-service.js");
  assert.match(settings, /where:\s*\{\s*id:\s*session\.id,\s*userId,\s*revokedAt:\s*null\s*\}/);
});

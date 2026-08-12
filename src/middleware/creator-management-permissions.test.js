"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { canManageCreators, creatorManagementRequired } = require("./creator-management-permissions");

test("senior agency roles can manage creators", () => {
  for (const member of [{ role: "OWNER" }, { role: "MANAGER" }, { role: "ADMIN" }, { roleKey: "manager" }]) {
    assert.equal(canManageCreators(member), true);
  }
});

test("explicit flat and nested creator permissions are supported", () => {
  assert.equal(canManageCreators({ permissions: { "creators.manage": true } }), true);
  assert.equal(canManageCreators({ permissions: { creators: { manage: true } } }), true);
  assert.equal(canManageCreators({ permissions: { models: { manage: true } } }), true);
  assert.equal(canManageCreators({ role: "CHATTER", permissions: {} }), false);
});

test("middleware fails closed on explicit canonical deny", async () => {
  let status = 0; let body = null; let called = false;
  const res = { status(value) { status = value; return this; }, json(value) { body = value; return this; } };
  await creatorManagementRequired({ auth: { membership: { role: "CHATTER", permissions: { "creators.manage": false } } } }, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(status, 403);
  assert.equal(body.code, "CREATOR_MANAGEMENT_FORBIDDEN");
});

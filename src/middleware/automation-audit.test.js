"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { actionFromRequest, safeDetails } = require("./automation-audit");

test("automation mutation routes map to stable business audit actions", () => {
  assert.equal(actionFromRequest({ method: "PATCH", path: "/controls", body: {} }), "control.updated");
  assert.equal(actionFromRequest({ method: "POST", path: "/follow-back/c1/plan", body: {} }), "follow_back.run_started");
  assert.equal(actionFromRequest({ method: "POST", path: "/deliveries/d1/cancel", body: {} }), "delivery.canceled");
});

test("audit request details do not copy settings or message payload", () => {
  const details = safeDetails({ method: "POST", path: "/bumps/upsert", route: { path: "/bumps/upsert" }, body: { text: "private", settings: { token: "x" } }, params: {}, query: {} }, { ok: true, item: { id: "t1" } });
  assert.equal(details.taskId, "t1");
  assert.equal(Object.hasOwn(details, "text"), false);
  assert.equal(Object.hasOwn(details, "settings"), false);
});

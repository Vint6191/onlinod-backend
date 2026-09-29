"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { randomUUID } = require("node:crypto");
const { parseCommand, ACTIONS } = require("./team-command-contract");
const command = patch => ({ commandId: randomUUID(), action: "role.create", payload: { label: "A role" }, ...patch });
test("v2 has all 15 typed actions, strict envelope and normalized proof-independent intent", () => {
  assert.equal(Object.keys(ACTIONS).length, 15);
  const a = command(), b = { ...a, actorProof: "fresh-owner-proof" };
  assert.equal(parseCommand(a).fingerprint, parseCommand(b).fingerprint);
  assert.equal(parseCommand(a).fingerprint, parseCommand({ ...a, payload: { basedOn: "chatter", label: " A role " } }).fingerprint);
  for (const input of [{ ...a, commandId: "" }, { ...a, agencyId: "forged" }, { ...a, userId: "forged" }, { ...a, payload: { label: "A", actorProof: "secret" } }, { ...a, action: "unknown" }]) assert.throws(() => parseCommand(input));
});
test("target and bounded shift inputs reject ambiguous or incomplete intents", () => {
  assert.throws(() => parseCommand(command({ targetId: "not-a-create-target" })), { code: "TEAM_COMMAND_TARGET_INVALID" });
  assert.throws(() => parseCommand(command({ action: "role.delete", payload: {} })), { code: "TEAM_COMMAND_TARGET_INVALID" });
  assert.throws(() => parseCommand(command({ action: "shift.update", targetId: "s", payload: { note: "missing revision" } })));
  assert.throws(() => parseCommand(command({ action: "shift.cancel", targetId: "s", payload: { expectedRevision: 0 } })));
});
test("all 19 unkeyed Team administration/schedule HTTP writes return 410 before domain work", async () => {
  const response = () => ({ statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } });
  let count = 0;
  for (const name of ["../routes/team", "../routes/team-schedule"]) {
    const router = require(name);
    for (const layer of router.stack) {
      const route = layer.route;
      if (!route || route.methods.get || route.path.startsWith("/commands/") || route.path.startsWith("/ownership/")) continue;
      const res = response();
      await route.stack[0].handle({ body: {}, auth: {} }, res);
      assert.equal(res.statusCode, 410, route.path); assert.equal(res.body.code, "TEAM_COMMAND_V2_REQUIRED"); count++;
    }
  }
  assert.equal(count, 19);
});
test("HTTP v2 identity comes exclusively from admitted auth, cancellation is explicit", async () => {
  const servicePath = require.resolve("./team-command-service"), previous = require.cache[servicePath];
  const calls = [];
  require.cache[servicePath] = { exports: { executeTeamCommand: async input => { calls.push(input); return { ok: true }; } } };
  try {
    const router = require("../routes/team");
    for (const url of ["/commands/v2", "/commands/v2/cancel"]) {
      const route = router.stack.find(layer => layer.route?.path === url).route;
      const req = { auth: { agencyId: "auth-agency", userId: "auth-user", deviceId: "auth-device" }, body: { agencyId: "forged" } };
      await route.stack[0].handle(req, { json: value => value });
    }
    assert.deepEqual(calls.map(c => [c.agencyId, c.userId, c.actorDeviceId, c.cancel]), [["auth-agency", "auth-user", "auth-device", false], ["auth-agency", "auth-user", "auth-device", true]]);
  } finally { if (previous) require.cache[servicePath] = previous; else delete require.cache[servicePath]; }
});

"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { onlineObservationFresh, onlineObservationWindow, isOnlineBumpSend, commitOnlineBumpWrite } = require("./bump-write-window-service");
const { eligibility } = require("./bump-rules");
const at = new Date("2026-10-05T00:00:00Z"), ttl = 30000;
for (const [offset, expected] of [[-1, false], [0, true], [29999, true], [30000, false], [30001, false]]) {
  test(`online TTL is [observedAt, expiresAt), offset ${offset}`, () => {
    const now = new Date(+at + offset); assert.equal(onlineObservationFresh(at, ttl, now), expected);
    assert.equal(eligibility({ candidate: { fanId: "f", dialogId: "f", observedAt: at }, source: "online", settings: { onlineObservationTtlMs: ttl }, now }), expected ? null : "stale_candidate");
  });
}
test("missing, invalid and nonfinite clock data cannot grant an online window", () => {
  for (const observed of [null, undefined, "", new Date(NaN), "bad"]) assert.equal(onlineObservationWindow(observed, ttl), null);
  for (const duration of [0, -1, NaN, Infinity, 0.5]) assert.equal(onlineObservationWindow(at, duration), null);
});
test("online gate is limited to Bumps SEND_MESSAGE; deletes and other sources retain their policy", () => {
  const d = { moduleKey: "bumps", actionType: "SEND_MESSAGE", payload: { source: "online" } };
  assert.equal(isOnlineBumpSend(d), true);
  for (const patch of [{ moduleKey: "other" }, { actionType: "DELETE_MESSAGE" }, { payload: { source: "manual" } }, { payload: { source: "hidden_online" } }]) assert.equal(isOnlineBumpSend({ ...d, ...patch }), false);
});
test("online SQL permit refuses an unowned DB transaction before touching rows", async () => {
  await assert.rejects(commitOnlineBumpWrite({ db: {}, delivery: {} }), { code: "BUMP_WRITE_WINDOW_CONTEXT_REQUIRED" });
});

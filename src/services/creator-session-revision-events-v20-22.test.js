"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  publishCreatorSessionRevision,
  waitForCreatorSessionRevisionEvents,
  currentCreatorSessionRevisionStreamId,
} = require("./creator-session-revision-events");

test("revision hint bus exposes metadata only and isolates agency streams", async () => {
  const agencyA = `agency-a-${Date.now()}`;
  const agencyB = `agency-b-${Date.now()}`;
  const event = publishCreatorSessionRevision({
    agencyId: agencyA,
    creatorId: "creator-1",
    revision: 19,
    status: "ACTIVE",
    sourceDeviceId: "device-a",
    requestId: "request-12345678",
    opaquePayload: { ciphertext: "MUST-NOT-LEAK" },
    cookies: [{ name: "sess", value: "MUST-NOT-LEAK" }],
  });
  assert.deepEqual(Object.keys(event).sort(), ["creatorId", "emittedAt", "requestId", "revision", "seq", "sourceDeviceId", "status"].sort());
  assert.doesNotMatch(JSON.stringify(event), /MUST-NOT-LEAK/);

  const a = await waitForCreatorSessionRevisionEvents({ agencyId: agencyA, streamId: currentCreatorSessionRevisionStreamId(), afterSeq: 0, waitMs: 250 });
  assert.equal(a.events.some((item) => item.creatorId === "creator-1" && item.revision === 19), true);

  const bPromise = waitForCreatorSessionRevisionEvents({ agencyId: agencyB, streamId: currentCreatorSessionRevisionStreamId(), afterSeq: a.cursor, waitMs: 500 });
  setTimeout(() => publishCreatorSessionRevision({ agencyId: agencyB, creatorId: "creator-b", revision: 3, status: "ACTIVE", sourceDeviceId: "device-b", requestId: "request-b-123456" }), 10);
  const b = await bPromise;
  assert.deepEqual(b.events.map((item) => item.creatorId), ["creator-b"]);
});

test("a stale stream id resets an unrelated old cursor immediately after backend restart semantics", async () => {
  const agencyId = `agency-restart-${Date.now()}`;
  const started = Date.now();
  const result = await waitForCreatorSessionRevisionEvents({ agencyId, streamId: "old-process-stream", afterSeq: Number.MAX_SAFE_INTEGER - 1, waitMs: 5000 });
  assert.equal(result.streamId, currentCreatorSessionRevisionStreamId());
  assert.ok(Date.now() - started < 500, "stream reset must not long-poll behind a stale old-process cursor");
});

test("creator-session route registers events before :creatorId and emits hints only after committed CAS changes", () => {
  const route = fs.readFileSync(path.join(__dirname, "../routes/creator-sessions.js"), "utf8");
  const eventsAt = route.indexOf('router.get("/events"');
  const creatorAt = route.indexOf('router.get("/:creatorId"');
  assert.ok(eventsAt >= 0 && creatorAt > eventsAt);
  assert.match(route, /requireAuthDevice\(req, deviceIdSchema\.parse\(req\.query\.deviceId\)/);
  assert.match(route, /filterAuthorizedRevisionEvents/);
  assert.match(route, /requireCreatorAccess/);
  assert.match(route, /if \(!result\.idempotent && !result\.unchanged\)/);
  assert.match(route, /publishRevisionHint\(\{/);
  assert.doesNotMatch(route, /publishRevisionHint\(\{[^}]*opaquePayload/s);
  assert.doesNotMatch(route, /publishRevisionHint\(\{[^}]*credentialHash/s);
});

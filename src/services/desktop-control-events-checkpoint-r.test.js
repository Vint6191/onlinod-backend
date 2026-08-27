"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  publishDesktopControlEvent,
  waitForDesktopControlEvents,
  currentDesktopControlStreamId,
} = require("./desktop-control-events");
const {
  publishCreatorSessionRevision,
  waitForCreatorSessionRevisionEvents,
  currentCreatorSessionRevisionStreamId,
} = require("./creator-session-revision-events");

const agency = `agency-r-${process.pid}-${Date.now()}`;

test("R: one metadata-only control bus filters target user/member/device and never exposes secret-shaped extras", async () => {
  publishDesktopControlEvent({
    type: "NETWORK_REVISION_CHANGED",
    agencyId: agency,
    creatorId: "creator-1",
    networkVersion: 7,
    targetUserId: "user-a",
    targetMemberId: "member-a",
    targetDeviceId: "device-a",
    ciphertext: "must-not-escape",
    proxyPassword: "must-not-escape",
    sess: "must-not-escape",
  });
  publishDesktopControlEvent({
    type: "ACCESS_EPOCH_CHANGED",
    agencyId: agency,
    accessEpoch: 11,
    targetUserId: "user-b",
    targetMemberId: "member-b",
  });
  const result = await waitForDesktopControlEvents({
    agencyId: agency,
    userId: "user-a",
    memberId: "member-a",
    deviceId: "device-a",
    streamId: currentDesktopControlStreamId(),
    afterSeq: 0,
    waitMs: 250,
  });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, "NETWORK_REVISION_CHANGED");
  assert.equal(result.events[0].networkVersion, 7);
  const serialized = JSON.stringify(result.events[0]);
  assert.equal(serialized.includes("must-not-escape"), false);
  assert.equal(serialized.includes("ciphertext"), false);
  assert.equal(serialized.includes("proxyPassword"), false);
  assert.equal(serialized.includes('"sess"'), false);
});

test("R: legacy creator-session revision channel is a filtered view of the exact same stream", async () => {
  assert.equal(currentCreatorSessionRevisionStreamId(), currentDesktopControlStreamId());
  const event = publishCreatorSessionRevision({ agencyId: agency, creatorId: "creator-2", revision: 9, status: "ACTIVE" });
  const result = await waitForCreatorSessionRevisionEvents({ agencyId: agency, streamId: currentCreatorSessionRevisionStreamId(), afterSeq: event.seq - 1, waitMs: 250 });
  assert.equal(result.streamId, currentDesktopControlStreamId());
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.events[0], {
    seq: event.seq,
    creatorId: "creator-2",
    revision: 9,
    status: "ACTIVE",
    sourceDeviceId: null,
    requestId: null,
    emittedAt: event.emittedAt,
  });
});

test("R: backend wiring publishes access, revoke, network, key and job invalidations after mutation boundaries", () => {
  const root = path.resolve(__dirname, "..");
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  const desktop = read("routes/desktop.js");
  const team = read("services/team-administration-service.js");
  const creators = read("routes/creators.js");
  const network = read("routes/network-profiles.js");
  const keyring = read("routes/client-e2e-keyring.js");
  const scheduler = read("services/job-scheduler.js");
  assert.match(desktop, /\/control\/events/);
  assert.match(desktop, /requireAuthDevice/);
  assert.match(team, /ACCESS_EPOCH_CHANGED/);
  assert.match(team, /CREATOR_REVOKED/);
  assert.match(creators, /CREATOR_REVOKED/);
  assert.match(network, /NETWORK_REVISION_CHANGED/);
  assert.match(keyring, /KEY_VERSION_CHANGED/);
  assert.match(scheduler, /JOB_AVAILABLE/);
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (name) => fs.readFileSync(path.join(__dirname, name), "utf8");

function cacheModule(relative, exportsValue) {
  const resolved = require.resolve(relative, { paths: [__dirname] });
  const previous = require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsValue };
  return () => {
    delete require.cache[resolved];
    if (previous) require.cache[resolved] = previous;
  };
}

test("subscriber publication fence is retryable for every derived-state mutation phase and opens only after COMPLETE", async () => {
  const restore = cacheModule("../prisma", {});
  const servicePath = require.resolve("./subscriber-publication-fence-service", { paths: [__dirname] });
  delete require.cache[servicePath];
  try {
    const { validateSubscriberPublicationIdle, assertSubscriberPublicationIdle } = require(servicePath);
    let phase = "PENDING";
    const db = {
      subscriberScanRun: {
        findFirst: async () => phase === "COMPLETE" ? null : ({ id: "run-1", publicationStatus: phase, updatedAt: new Date() }),
      },
    };
    for (const candidate of ["PENDING", "CURRENT", "PREVIOUS", "FINALIZE"]) {
      phase = candidate;
      const result = await validateSubscriberPublicationIdle({ db, agencyId: "agency-1", creatorId: "creator-1", now: new Date("2026-09-20T18:00:00.000Z") });
      assert.equal(result.ok, false);
      assert.equal(result.terminal, false);
      assert.equal(result.code, "subscriber_publication_in_progress");
      assert.equal(result.publicationStatus, candidate);
      await assert.rejects(
        () => assertSubscriberPublicationIdle({ db, agencyId: "agency-1", creatorId: "creator-1" }),
        (error) => error?.code === "subscriber_publication_in_progress" && error?.status === 409,
      );
    }
    phase = "COMPLETE";
    assert.deepEqual(await validateSubscriberPublicationIdle({ db, agencyId: "agency-1", creatorId: "creator-1" }), { ok: true });
  } finally {
    delete require.cache[servicePath];
    restore();
  }
});

test("all subscriber-derived planners and pre-write validators cross the publication fence before candidate generation checks", () => {
  const followBack = read("follow-back-service.js");
  const followAutomation = read("follow-automation-service.js");
  const fanCurrent = read("fan-current-consumer-service.js");
  const bumps = read("bump-service.js");
  const subscriber = read("subscriber-directory-service.js");
  const action = read("automation-action-delivery-service.js");

  assert.match(followBack, /planFollowBackLocked[\s\S]*assertSubscriberPublicationIdle\(\{ db, agencyId, creatorId \}\)/);
  assert.match(followAutomation, /planFollowAutomationLocked[\s\S]*assertSubscriberPublicationIdle\(\{ db, agencyId, creatorId \}\)/);
  assert.match(followAutomation, /validateFollowAutomationDelivery[\s\S]*validateSubscriberPublicationIdle[\s\S]*followAutomationCandidate\.findFirst/);
  assert.match(fanCurrent, /validateFollowBackDeliveryCurrent[\s\S]*validateSubscriberPublicationIdle[\s\S]*followBackCandidate\.findFirst/);
  assert.match(bumps, /\["hidden_online", "paid_subscriber", "free_subscriber"\][\s\S]*assertSubscriberPublicationIdle/);
  assert.match(bumps, /validateBumpDelivery[\s\S]*validateSubscriberPublicationIdle[\s\S]*automationBumpFanState\.findUnique/);
  assert.match(subscriber, /publicationTransaction[\s\S]*lockAutomationWriteCommitFence[\s\S]*lockSubscriberPublicationCreator[\s\S]*advanceSubscriberPublication/);
  const fence = read("subscriber-publication-fence-service.js");
  assert.doesNotMatch(fence, /status:\s*["']RUNNING["']/);
  assert.match(fence, /hasMore:\s*false[\s\S]*fanProjectionStatus:\s*["']COMPLETE["'][\s\S]*publicationStatus/);
  assert.match(action, /validation\?\.terminal === false[\s\S]*error\.retryable = true[\s\S]*error\.retryAt/);
});

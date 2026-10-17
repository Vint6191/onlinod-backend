"use strict";
const assert = require("node:assert/strict");
const work = require("../../src/services/domain-work-authority-service");
const sync = require("../../src/services/creator-live-sync-service");
const { runRootCommit } = require("../../src/services/db-commit-kernel");

module.exports = async function wakeProof({ db, scope: s, now, pass }) {
  const tx = fn => runRootCommit(db, ({ tx }) => fn(tx));
  const identity = { agencyId: s.agencyId, creatorId: s.creatorId, workClass: "CREATOR_RECURRING_PLANNING", objectType: "CreatorAccount", objectId: s.creatorId, partitionKey: s.creatorId };
  const claim = () => work.claimDomainWorkBatch({ db, workClass: identity.workClass, agencyId: s.agencyId, creatorIds: [s.creatorId], limit: 1 });
  const progressCursor = { lastFullPlanningAt: now.toISOString() }, future = new Date(+now + 3600000);
  let c = await claim(); assert.equal(c.items.length, 1);
  assert((await work.yieldDomainWorkClaim({ db, item: c.items[0], ownerToken: c.ownerToken, progressCursor, availableAt: future })).yielded);
  await tx(t => work.publishDomainWorkBatch({ db: t, items: [identity] }));
  c = await claim(); assert.equal(c.items.length, 1); assert.deepEqual(c.items[0].progressCursor, progressCursor);
  // An event arriving during the claim must remain immediately due, while the
  // already-completed hourly generic plan survives this newer revision.
  await tx(t => work.publishDomainWorkBatch({ db: t, items: [identity] }));
  const yielded = await work.yieldDomainWorkClaim({ db, item: c.items[0], ownerToken: c.ownerToken, progressCursor, availableAt: future, preserveProgressOnNewerRevision: true });
  assert(yielded.newerRevision); assert(+yielded.availableAt < +future);
  c = await claim(); assert.equal(c.items.length, 1); assert.deepEqual(c.items[0].progressCursor, progressCursor);
  await work.yieldDomainWorkClaim({ db, item: c.items[0], ownerToken: c.ownerToken, progressCursor, availableAt: future });
  await tx(async t => {
    await t.creatorRecoveryIntent.createMany({ data: [
      { id: "wake-old", agencyId: s.agencyId, creatorId: s.creatorId, stream: "financial", reason: "OFFLINE_GAP", gapFrom: new Date(+now - 7200000), targetAt: now, policyVersion: 2, status: "RUNNING", jobId: "wake-job" },
      { id: "wake-new", agencyId: s.agencyId, creatorId: s.creatorId, stream: "financial", reason: "OFFLINE_GAP", gapFrom: now, targetAt: new Date(+now + 1), policyVersion: 2, status: "PENDING" },
    ] });
    await sync.completeRecovery(t, { id: "wake-job", ...s, jobKey: "financial_transactions_scan", params: { recoveryIntentId: "wake-old" } }, true);
  });
  c = await claim(); assert.equal(c.items.length, 1); assert.deepEqual(c.items[0].progressCursor, progressCursor);
  assert.equal((await db.creatorRecoveryIntent.findUnique({ where: { id: "wake-new" } })).status, "PENDING");
  await work.ackDomainWorkClaim({ db, item: c.items[0], ownerToken: c.ownerToken });
  pass("creator planning wakes on new debt and completion, preserves the hourly deadline across racing revisions and never loses a newer offline gap behind an older collector");
};

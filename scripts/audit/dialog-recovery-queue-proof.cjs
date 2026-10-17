"use strict";
const assert = require("node:assert/strict");
const { runRootCommit } = require("../../src/services/db-commit-kernel");
const queue = require("../../src/services/dialog-recovery-queue-service");
const work = require("../../src/services/domain-work-authority-service");

module.exports = async function queueProof({ db, scope: s, now, pass }) {
  const tx = fn => runRootCommit(db, ({ tx }) => fn(tx)), past = new Date(+now - 7200000);
  await tx(t => t.teamObservationState.update({ where: { agencyId_creatorId: {agencyId:s.agencyId,creatorId:s.creatorId} }, data: { lastRealtimeEventAt: past } }));
  const enqueue = () => tx(t => queue.enqueue({ db: t, agencyId: s.agencyId, now,
    candidates: [{ creatorId: s.creatorId, lastCoveredAt: past }],
    bindings: [{ creatorId: s.creatorId, account: { lastWsFrameAt: now.toISOString() } }],
  }));
  assert.equal((await enqueue()).queued, 1);
  assert.equal((await enqueue()).queued, 0);
  const claim = () => work.claimDomainWorkBatch({ db, workClass: queue.WORK_CLASS, limit: 1 });
  let c = await claim();
  assert.equal(c.items.length, 1);
  const absent = await queue.processRequest({ db, item: c.items[0], ownerToken: c.ownerToken });
  assert.equal(absent.reason, "baseline_missing");
  assert.equal((await enqueue()).queued, 0, "missing baseline backoff must not requeue on every heartbeat");
  assert.equal(+(await db.teamObservationState.findUnique({ where: { agencyId_creatorId: {agencyId:s.agencyId,creatorId:s.creatorId} } })).lastRealtimeEventAt, +past);
  await tx(async t => {
    await t.dialogScanRun.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId, dialogId: "__dialog_discovery__", mode: "discovery", status: "COMPLETED", completedAt: past, createdAt: past } });
    await t.creatorDialogRecoveryRequest.update({ where: { creatorId: s.creatorId }, data: { nextCheckAt: past } });
  });
  await enqueue(); c = await claim();
  await assert.rejects(queue.processRequest({ db, item: c.items[0], ownerToken: c.ownerToken, schedule: async () => { throw Error("ROLLBACK_PROOF"); } }), /ROLLBACK_PROOF/);
  assert((await db.creatorDialogRecoveryRequest.findUnique({ where: { creatorId: s.creatorId } })).queued);
  let scheduled = 0;
  const result = await queue.processRequest({ db, item: c.items[0], ownerToken: c.ownerToken, schedule: async input => {
    scheduled++; assert.equal(input.forceChildFull, false); assert.equal(input.source, "offline_gap_recovery");
    return { ok: true, created: true, reason: "scheduled" };
  } });
  assert(result.created); assert.equal(scheduled, 1);
  assert.equal(+(await db.teamObservationState.findUnique({ where: { agencyId_creatorId: {agencyId:s.agencyId,creatorId:s.creatorId} } })).lastRealtimeEventAt, +past);
  // Another healthy device has already closed the gap before this queued check.
  await tx(async t => {
    await t.teamObservationState.update({ where: { agencyId_creatorId: {agencyId:s.agencyId,creatorId:s.creatorId} }, data: { lastRealtimeEventAt: now } });
    await t.creatorDialogRecoveryRequest.update({ where: { creatorId: s.creatorId }, data: { nextCheckAt: past } });
  });
  await enqueue(); c = await claim();
  const settled = await queue.processRequest({ db, item: c.items[0], ownerToken: c.ownerToken, schedule: async () => { throw Error("SHOULD_NOT_SCAN"); } });
  assert(settled.coverageReleased);
  pass("durable dialog recovery coalesces devices, honors baseline backoff, rolls back failed planning, preserves unresolved coverage and skips a gap already covered by another device");
};

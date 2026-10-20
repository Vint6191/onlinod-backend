"use strict";
// Queue transport proof only: real SQL/Prisma and retained authority fences,
// synthetic 1.6s round trips. No business collector/provider is executed.
const assert = require("node:assert/strict");
const { setTimeout: delay } = require("node:timers/promises");
const { fixture, scope } = require("./analytics-traffic/fixture.cjs");

async function main() {
  const f = await fixture(), { db } = f;
  let delayed = false, queries = 0;
  db.$use(async (params, next) => { if (delayed) { queries++; await delay(1600); } return next(params); });
  async function slow(work) {
    queries = 0; delayed = true; const started = Date.now();
    try { const value = await work(); return { value, queries, wallMs: Date.now() - started }; }
    finally { delayed = false; }
  }
  try {
    const s = await scope(db);
    const dwi = require("../../src/services/domain-work-authority-service");
    const identity = { db, agencyId: s.agencyId, creatorId: s.creatorId, workClass: "CREATOR_RECURRING_PLANNING",
      objectType: "CreatorAccount", objectId: s.creatorId, partitionKey: s.creatorId };
    await dwi.publishDomainWork(identity);
    const admitted = await slow(() => dwi.claimDomainWorkBatch({ db, workClass: identity.workClass,
      limit: 1, perAgencyQuantum: 1, perPartitionQuantum: 1 }));
    assert.equal(admitted.value.items.length, 1);
    const item = admitted.value.items[0], ownerToken = admitted.value.ownerToken;
    assert.equal(item.creatorId, s.creatorId); assert.equal(item.agencyId, s.agencyId);
    console.log("PASS broad bounded agency/shard/physical claim through slow SQL", JSON.stringify({ queries: admitted.queries, wallMs: admitted.wallMs }));

    const heartbeat = await slow(() => dwi.heartbeatDomainWorkClaim({ db, item, ownerToken }));
    assert.equal(heartbeat.value.renewed, true);
    assert(heartbeat.value.leaseUntil > item.leaseUntil);
    const saved = await slow(() => dwi.saveDomainWorkProgress({ db, item, ownerToken, progressCursor: { page: 1 } }));
    assert.equal(saved.value.saved, true);
    const yielded = await slow(() => dwi.yieldDomainWorkClaim({ db, item, ownerToken, progressCursor: { page: 2 } }));
    assert.equal(yielded.value.yielded, true);
    const row = await db.domainWorkItem.findUnique({ where: { id: item.id } });
    assert.equal(row.state, "READY"); assert.equal(row.ownerToken, null); assert.deepEqual(row.progressCursor, { page: 2 });
    console.log("PASS heartbeat, progress and continuation commit without losing ownership", JSON.stringify({ heartbeatMs: heartbeat.wallMs, saveMs: saved.wallMs, yieldMs: yielded.wallMs }));

    const claim = () => dwi.claimDomainWorkBatch({ db, workClass: identity.workClass, agencyId: s.agencyId, creatorIds: [s.creatorId], limit: 1 });
    const current = await claim(); assert.equal(current.items.length, 1);
    const stale = await dwi.ackDomainWorkClaim({ db, item, ownerToken });
    assert.equal(stale.lost, true);
    const acked = await slow(() => dwi.ackDomainWorkClaim({ db, item: current.items[0], ownerToken: current.ownerToken }));
    assert.equal(acked.value.acknowledged, true);
    const complete = await db.domainWorkItem.findUnique({ where: { id: item.id } });
    assert.equal(complete.state, "DONE"); assert.equal(complete.isOutstanding, false);
    assert.equal(complete.completedRevision, complete.requestedRevision);
    console.log("PASS a stale owner is fenced and the current owner acknowledges through slow SQL", JSON.stringify({ ackMs: acked.wallMs }));

    await dwi.publishDomainWork(identity);
    const failing = await claim();
    const failed = await dwi.failDomainWorkClaim({ db, item: failing.items[0], ownerToken: failing.ownerToken,
      error: Object.assign(Error("temporary connection outage"), { code: "P2024" }) });
    assert.equal(failed.failed, true); assert.equal(failed.state, "READY");
    const retry = await db.domainWorkItem.findUnique({ where: { id: item.id } });
    assert.equal(retry.errorClass, "TRANSIENT_DATABASE"); assert(retry.nextAttemptAt instanceof Date);
    await dwi.publishDomainWork(identity);
    const blocking = await claim();
    const blocked = await dwi.blockDomainWorkClaim({ db, item: blocking.items[0], ownerToken: blocking.ownerToken,
      dependencyKind: "proof_dependency", dependencyKey: "proof_key", dependencyRevision: 0n });
    assert.equal(blocked.blocked, true);
    const waiting = await db.domainWorkItem.findUnique({ where: { id: item.id } });
    assert.equal(waiting.state, "BLOCKED"); assert.equal(waiting.ownerToken, null); assert.equal(waiting.agencyId, s.agencyId);
    console.log("PASS failure and dependency settlement preserve their exact state transitions");
    console.log(JSON.stringify({ ok: true, cases: 4, productionAccessed: false, nativePostgres: false,
      limitations: ["PGlite single SQL session; native multi-replica contention not exercised", "Synthetic latency covers bounded queue units, not every business transaction"] }));
  } finally { await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { runRootCommit } = require("../../src/services/db-commit-kernel");

module.exports = async function retentionProof({ db, scope: s, now, pass }) {
  const tx = fn => runRootCommit(db, ({ tx }) => fn(tx));
  const retention = require("../../src/services/live-sync-retention-service");
  const past = new Date(+now - 31 * 86400000), sessionId = crypto.randomUUID();
  await tx(async t => {
    await t.$executeRawUnsafe("SELECT set_config('onlinod.earnings_writer_generation','v7',true)");
    const base = await t.creatorRealtimeSession.findFirst({ where: { creatorId: s.creatorId } });
    await t.creatorRealtimeSession.create({ data: { ...base, id: sessionId, incarnation: sessionId, ackedSeq: 600n, capturedSeq: 601n, updatedAt: past, retiredAt: null } });
    await t.$executeRawUnsafe(`INSERT INTO "CreatorRealtimeReceipt"("sessionId",seq,digest,"capturedAt")
      SELECT $1,i,'retention-proof',$2 FROM generate_series(1,601) i`, sessionId, past);
    await t.$executeRawUnsafe(`INSERT INTO "CreatorRecoveryIntent"(id,"agencyId","creatorId",stream,reason,"gapFrom","targetAt","policyVersion",status,"completedAt")
      SELECT 'retention-intent-'||i,$1,$2,'notifications','OFFLINE_GAP',$3,$3+interval '1 second'*i,2,'COMPLETE',$3
      FROM generate_series(1,600) i`, s.agencyId, s.creatorId, past);
    await t.$executeRawUnsafe(`INSERT INTO "CreatorMoneyObservation"(id,"agencyId","creatorId","occurredAt","capturedAt",status)
      SELECT 'retention-money-'||i,$1,$2,$3,$3,CASE WHEN i<=600 THEN 'APPLIED' ELSE 'PENDING' END
      FROM generate_series(1,601) i`, s.agencyId, s.creatorId, past);
    await t.$executeRawUnsafe(`INSERT INTO "CreatorNotificationFrontierPage"("creatorId","agencyId",generation,page,"cursorStart",digest,"createdAt")
      SELECT $1,$2,'retention-generation',i,i::text,'fixture',$3 FROM generate_series(1,600) i`, s.creatorId, s.agencyId, past);
  });
  assert.equal(await retention.page(db, "receipts"), 500);
  assert.equal(await retention.page(db, "receipts"), 100);
  assert.equal(await db.creatorRealtimeReceipt.count({ where: { sessionId } }), 1);
  assert.equal((await db.creatorRealtimeSession.findUnique({ where: { id: sessionId } })).ackedSeq, 600n);
  assert.equal(await retention.page(db, "money"), 500);
  assert.equal(await retention.page(db, "money"), 100);
  assert.equal((await db.creatorMoneyObservation.findUnique({ where: { id: "retention-money-601" } })).status, "PENDING");
  assert.equal(await retention.page(db, "intents"), 500);
  assert.equal(await retention.page(db, "intents"), 100);
  const watermark = await db.creatorRecoveryWatermark.findUnique({ where: { creatorId_stream: { creatorId: s.creatorId, stream: "notifications" } } });
  assert.equal(+watermark.throughAt, +past + 600000);
  assert.equal(await retention.page(db, "frontiers"), 500);
  assert.equal(await retention.page(db, "frontiers"), 100);
  assert.equal(await retention.page(db, "legacy"), 3);
  assert((await db.creatorEarningsLedgerProof.findUnique({ where: { creatorId: s.creatorId } })).activeGeneration);
  assert.equal(await db.creatorEarningsLedgerEntry.count({ where: { creatorId: s.creatorId } }), 0);
  pass("retention pages stay at 500: ACK authority, unacknowledged receipts and unresolved money survive; completed recovery watermark survives compaction; old legacy rows retire only after publication");
};

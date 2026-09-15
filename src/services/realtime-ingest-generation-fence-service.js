"use strict";

const { runDbTransaction } = require("./db-transaction-service");
const { assertExecutionAccessFence } = require("./execution-access-fence-service");

function rootPrisma() { return require("../prisma"); }

async function assertRealtimeIngestGenerationCurrent({
  db,
  agencyId,
  userId,
  memberId,
  accessEpoch,
  creatorId,
}) {
  return assertExecutionAccessFence({
    db,
    agencyId,
    userId,
    memberId,
    accessEpoch,
    creatorId,
    lock: true,
  });
}

async function withRealtimeIngestGenerationFence({
  db = null,
  agencyId,
  userId,
  memberId,
  accessEpoch,
  creatorId,
  work,
  transactionOptions = { maxWait: 10_000, timeout: 30_000 },
}) {
  if (typeof work !== "function") throw new TypeError("Realtime ingest generation fence requires a work callback");
  return runDbTransaction(db || rootPrisma(), async (tx) => {
    const fence = await assertRealtimeIngestGenerationCurrent({
      db: tx,
      agencyId,
      userId,
      memberId,
      accessEpoch,
      creatorId,
    });
    return work({ tx, member: fence.member, creator: fence.creator, accessEpoch: fence.accessEpoch });
  }, transactionOptions);
}

module.exports = { assertRealtimeIngestGenerationCurrent, withRealtimeIngestGenerationFence };

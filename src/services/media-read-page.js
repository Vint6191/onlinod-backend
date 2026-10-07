"use strict";
const { runDbTransaction } = require("./db-transaction-service");

// Offsets are positions in the source, never counts of filtered/rendered items.
// Leave room for the largest page when calculating the next position.
const MAX_MEDIA_OFFSET = Number.MAX_SAFE_INTEGER - 500;
function mediaOffset(value = 0) {
  const offset = value == null ? 0 : Number(value);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_MEDIA_OFFSET) {
    throw Object.assign(new Error("Media offset must be a nonnegative safe integer"), { code: "MEDIA_OFFSET_INVALID", status: 400 });
  }
  return offset;
}
function exactMediaCount(value) {
  const number = Number(value ?? 0);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw Object.assign(new Error("Media aggregate exceeds the exact numeric range"), { code: "MEDIA_COUNT_OUT_OF_RANGE" });
  }
  return number;
}
function readMediaSnapshot(db, work) {
  return runDbTransaction(db, work, { isolationLevel: "RepeatableRead", maxWait: 5000, timeout: 15000 });
}
async function readMediaPage(db, { where, orderBy, offset = 0, limit }) {
  const skip = mediaOffset(offset);
  const [rows, total] = await readMediaSnapshot(db, tx => Promise.all([
    tx.creatorMediaAsset.findMany({ where, orderBy, skip, take: limit }),
    tx.creatorMediaAsset.count({ where }),
  ]));
  const count = exactMediaCount(total), nextOffset = skip + rows.length;
  return { rows, count, offset: skip, nextOffset, hasMore: nextOffset < count };
}
module.exports = { MAX_MEDIA_OFFSET, mediaOffset, exactMediaCount, readMediaSnapshot, readMediaPage };

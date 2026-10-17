"use strict";
const { hashCanonicalJson } = require("./realtime-receipt-hash");
const enabled = (job) => job.params?.notificationMode === "catchup" && job.params?.notificationFrontierVersion === 2;
class NotificationFrontierError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.status = 409;
  }
}
const fail = (code) => {
  throw new NotificationFrontierError(code);
};
async function commitPage(db, job, chunk, previous) {
  if (!enabled(job)) return previous || {};
  const generation = job.params.collectionGeneration;
  const p =
    previous?.generation === generation
      ? previous
      : { generation, page: 0, cursor: null, phase: "SEEK", boundaryPage: null };
  const digest = hashCanonicalJson(chunk);
  const [receipt] = await db.$queryRawUnsafe(
    'SELECT digest FROM "CreatorNotificationFrontierPage" WHERE "creatorId"=$1 AND generation=$2 AND page=$3',
    job.creatorId,
    generation,
    chunk.page
  );
  if (receipt) {
    if (receipt.digest !== digest) fail("NOTIFICATION_FRONTIER_PAYLOAD_CONFLICT");
    return p;
  }
  if (
    p.phase === "DONE" ||
    chunk.page !== p.page + 1 ||
    (chunk.cursorStart || null) !== p.cursor ||
    chunk.sourcePhase !== "all"
  )
    fail("NOTIFICATION_FRONTIER_CURSOR_MISMATCH");
  if (typeof chunk.sourceHasMore !== "boolean" || !Array.isArray(chunk.observations))
    fail("NOTIFICATION_FRONTIER_PAGE_INVALID");
  const ids = chunk.observations.map((row) => row.notificationId).filter(Boolean);
  const known = new Set([...(job.params.knownNotificationIds || []), job.params.stopAtNotificationId].filter(Boolean));
  const boundary = ids.length > 0 && ids.length === chunk.observations.length && ids.every((id) => known.has(id));
  const cursor = chunk.cursorEnd || null;
  if (chunk.sourceHasMore && (!ids.length || !cursor || cursor === p.cursor || ids.at(-1) !== cursor))
    fail("NOTIFICATION_FRONTIER_CURSOR_STALLED");
  if (chunk.sourceHasMore) {
    const [cycle] = await db.$queryRawUnsafe(
      'SELECT page FROM "CreatorNotificationFrontierPage" WHERE "creatorId"=$1 AND generation=$2 AND "cursorStart"=$3',
      job.creatorId,
      generation,
      cursor
    );
    if (cycle) fail("NOTIFICATION_FRONTIER_CURSOR_CYCLE");
  }
  const done = !chunk.sourceHasMore || p.phase === "OVERLAP";
  const next = {
    generation,
    page: chunk.page,
    cursor: done ? null : cursor,
    phase: done ? "DONE" : boundary ? "OVERLAP" : "SEEK",
    boundaryPage: p.boundaryPage || (boundary ? chunk.page : null),
    overlapPage: p.phase === "OVERLAP" ? chunk.page : null,
    exhausted: !chunk.sourceHasMore,
  };
  if (
    chunk.sourceExhausted !== done ||
    (done && chunk.stopReason !== (!chunk.sourceHasMore ? "source_exhausted" : "known_boundary_reached"))
  )
    fail("NOTIFICATION_FRONTIER_COMPLETION_INVALID");
  await db.$executeRawUnsafe(
    'INSERT INTO "CreatorNotificationFrontierPage"("creatorId","agencyId",generation,page,"cursorStart","cursorEnd",digest) VALUES($1,$2,$3,$4,$5,$6,$7)',
    job.creatorId,
    job.agencyId,
    generation,
    chunk.page,
    p.cursor || "",
    cursor,
    digest
  );
  return next;
}
function completed(job, receipt) {
  return (
    !enabled(job) ||
    (receipt?.generation === job.params.collectionGeneration &&
      receipt.phase === "DONE" &&
      (receipt.exhausted === true || receipt.overlapPage === receipt.boundaryPage + 1))
  );
}
module.exports = { NotificationFrontierError, enabled, commitPage, completed };

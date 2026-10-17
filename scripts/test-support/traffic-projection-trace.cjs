"use strict";

// Test-only observation of the real maintenance executor. No scheduling,
// projection, ownership, or disposition logic is replaced by this wrapper.
const fs = require("node:fs");
const service = require("../../src/services/traffic-projection-service");

exports.attachTrafficProjectionTrace = function attachTrafficProjectionTrace(filename) {
  const original = service.runTrafficProjectionSweep;
  let tick = 0, fingerprint = null, changedAt = Date.now(), unchangedTicks = 0;
  const write = row => fs.appendFileSync(filename, JSON.stringify(row, (_key, value) =>
    typeof value === "bigint" ? String(value) : value) + "\n");
  service.runTrafficProjectionSweep = async function tracedTrafficProjection(options) {
    const db = options.db || require("../../src/prisma");
    const snapshot = () => db.domainWorkItem.findMany({
      where: { workClass: { in: ["TRAFFIC_FACT", "TRAFFIC_FAN", "TRAFFIC_BACKFILL"] }, isOutstanding: true },
      orderBy: { id: "asc" }, take: 1000,
      select: { id: true, workClass: true, requestedRevision: true, completedRevision: true,
        claimedRevision: true, state: true, attempts: true, progressCursor: true, claimFence: true,
        availableAt: true, updatedAt: true, errorClass: true, lastError: true },
    });
    const backfillSnapshot = () => db.$queryRawUnsafe(`SELECT "creatorId","stage","cursor"
      FROM "TrafficProjectionBackfillData" WHERE "completedAt" IS NULL ORDER BY "creatorId" LIMIT 1000`);
    const currentTick = ++tick, before = await snapshot(), backfillBefore = await backfillSnapshot(), startedAt = Date.now();
    write({ phase: "BEGIN", pid: process.pid, tick: currentTick, at: new Date(startedAt), before, backfillBefore });
    let result, failure;
    try {
      result = await original(options);
      return result;
    } catch (error) {
      failure = { code: error.code, message: error.message };
      throw error;
    } finally {
      const after = await snapshot(), backfillAfter = await backfillSnapshot();
      // Claims, attempts and lease rotations alone are not progress. A page
      // cursor, revision or outstanding-set change must actually be committed.
      const current = JSON.stringify({ items: after.map(row => [row.id, row.requestedRevision,
        row.completedRevision, row.progressCursor]), backfills: backfillAfter }, (_key, value) =>
        typeof value === "bigint" ? String(value) : value);
      if (current !== fingerprint) { fingerprint = current; changedAt = Date.now(); unchangedTicks = 0; }
      else unchangedTicks++;
      write({ phase: "END", pid: process.pid, tick: currentTick, at: new Date(),
        durationMs: Date.now() - startedAt, noProgressForMs: Date.now() - changedAt,
        unchangedTicks, result, failure, after, backfillAfter });
    }
  };
};

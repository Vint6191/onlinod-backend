"use strict";
const { runDbTransaction } = require("./db-transaction-service");


const prisma = require("../prisma");

const FAN_OBSERVATION_CREATOR_CLOCK_SETTING_KEY = "phase3.fanObservationCreatorClockV1";
const FAN_OBSERVATION_CLOCK_ACTIVATION_MAX_WAIT_MS = 30_000;

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function activeValue(value) {
  return object(value).active === true;
}

function asDate(value, code) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(code);
  return date;
}

async function activateFanObservationCreatorClockV1({
  db = prisma,
  activatedBy = "operator",
  maxFutureSkewMs = FAN_OBSERVATION_CLOCK_ACTIVATION_MAX_WAIT_MS,
} = {}) {
  const maxWaitMs = Math.max(0, Number(maxFutureSkewMs || 0));
  return runDbTransaction(db, async (tx) => {
    if (typeof tx.$queryRawUnsafe !== "function") {
      throw new Error("FAN_OBSERVATION_CLOCK_ACTIVATION_DB_LOCK_UNAVAILABLE");
    }

    // Lock order is intentionally SystemSetting -> legacy clock. Token issue in
    // bridge mode takes FOR SHARE on the same setting before touching the legacy
    // row, so activation cannot cut the floor underneath an in-flight bridge
    // issuance. Old binaries must already be drained before this command runs.
    const settingRows = await tx.$queryRawUnsafe(
      'SELECT "value" FROM "SystemSetting" WHERE "key" = $1 FOR UPDATE',
      FAN_OBSERVATION_CREATOR_CLOCK_SETTING_KEY,
    );
    if (!Array.isArray(settingRows) || !settingRows[0]) {
      throw new Error("FAN_OBSERVATION_CLOCK_ACTIVATION_BARRIER_MISSING");
    }
    const previous = object(settingRows[0].value);
    if (activeValue(previous)) {
      return {
        active: true,
        alreadyActive: true,
        epoch: Math.max(0, Number(previous.epoch || 0)),
        floorObservedAt: previous.floorObservedAt || null,
      };
    }

    const clockRows = await tx.$queryRawUnsafe(`
      SELECT "lastObservedAt", clock_timestamp() AS "dbNow"
      FROM "FanObservationClock"
      WHERE "id" = 1
      FOR UPDATE
    `);
    if (!Array.isArray(clockRows) || !clockRows[0]) {
      throw new Error("FAN_OBSERVATION_CLOCK_LEGACY_ROW_MISSING");
    }
    const floorObservedAt = asDate(clockRows[0].lastObservedAt, "FAN_OBSERVATION_CLOCK_LEGACY_TIME_INVALID");
    let dbNow = asDate(clockRows[0].dbNow, "FAN_OBSERVATION_CLOCK_DB_TIME_INVALID");
    const initialDbNow = dbNow;
    let futureSkewMs = Math.max(0, floorObservedAt.getTime() - dbNow.getTime());

    // A future-skewed legacy logical clock must not silently become the durable
    // floor of every creator. With the barrier/global rows locked, no bridge
    // issuer can advance the floor, so a bounded wait can let wall time catch
    // up. Large skew fails closed and requires an operator/data investigation.
    if (futureSkewMs > maxWaitMs) {
      const error = new Error("FAN_OBSERVATION_CLOCK_ACTIVATION_FUTURE_SKEW");
      error.futureSkewMs = futureSkewMs;
      error.maxFutureSkewMs = maxWaitMs;
      throw error;
    }
    if (futureSkewMs > 0) {
      if (typeof tx.$executeRawUnsafe !== "function") {
        throw new Error("FAN_OBSERVATION_CLOCK_ACTIVATION_DB_EXECUTE_UNAVAILABLE");
      }
      // pg_sleep returns void, not a Prisma-decodable result column.
      await tx.$executeRawUnsafe('SELECT pg_sleep($1::double precision)', (futureSkewMs + 2) / 1000);
      const nowRows = await tx.$queryRawUnsafe('SELECT clock_timestamp() AS "dbNow"');
      dbNow = asDate(nowRows?.[0]?.dbNow, "FAN_OBSERVATION_CLOCK_DB_TIME_INVALID");
      futureSkewMs = Math.max(0, floorObservedAt.getTime() - dbNow.getTime());
      if (futureSkewMs > 0) {
        throw new Error("FAN_OBSERVATION_CLOCK_ACTIVATION_FLOOR_STILL_FUTURE");
      }
    }

    const epoch = Math.max(0, Number(previous.epoch || 0)) + 1;
    await tx.systemSetting.update({
      where: { key: FAN_OBSERVATION_CREATOR_CLOCK_SETTING_KEY },
      data: {
        value: {
          active: true,
          epoch,
          floorObservedAt: floorObservedAt.toISOString(),
          activatedAt: dbNow.toISOString(),
          activatedBy: String(activatedBy || "operator").slice(0, 120),
        },
      },
    });
    return {
      active: true,
      alreadyActive: false,
      epoch,
      floorObservedAt: floorObservedAt.toISOString(),
      waitedForFutureSkewMs: Math.max(0, floorObservedAt.getTime() - initialDbNow.getTime()),
    };
  }, { maxWait: 10_000, timeout: 60_000 });
}

module.exports = {
  FAN_OBSERVATION_CREATOR_CLOCK_SETTING_KEY,
  FAN_OBSERVATION_CLOCK_ACTIVATION_MAX_WAIT_MS,
  activateFanObservationCreatorClockV1,
};

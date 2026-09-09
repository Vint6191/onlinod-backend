"use strict";

const CAPABILITY_FUTURE_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

function asDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return new Date(value.getTime());
  if (value === null || value === undefined || value === "") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function capabilityFreshnessWindow(now, maxAgeMs, futureSkewMs = CAPABILITY_FUTURE_SKEW_TOLERANCE_MS) {
  const current = asDate(now);
  const age = Number(maxAgeMs);
  const future = Number(futureSkewMs);
  if (!current || !Number.isFinite(age) || age < 0 || !Number.isFinite(future) || future < 0) {
    const error = new Error("CAPABILITY_FRESHNESS_WINDOW_INVALID");
    error.code = "CAPABILITY_FRESHNESS_WINDOW_INVALID";
    throw error;
  }
  return {
    gte: new Date(current.getTime() - Math.floor(age)),
    lte: new Date(current.getTime() + Math.floor(future)),
  };
}

function isCapabilityTimestampFresh(value, now, maxAgeMs, futureSkewMs = CAPABILITY_FUTURE_SKEW_TOLERANCE_MS) {
  const timestamp = asDate(value);
  if (!timestamp) return false;
  const window = capabilityFreshnessWindow(now, maxAgeMs, futureSkewMs);
  return timestamp >= window.gte && timestamp <= window.lte;
}

module.exports = {
  CAPABILITY_FUTURE_SKEW_TOLERANCE_MS,
  capabilityFreshnessWindow,
  isCapabilityTimestampFresh,
};

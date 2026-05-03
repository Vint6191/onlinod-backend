"use strict";

const VALID_RANGE_KEYS = ["24h", "7d", "30d", "90d", "180d", "365d", "ytd", "prev_year", "all"];
const VALID_RANGES = new Set(VALID_RANGE_KEYS);

function startOfUtcDay(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function resolveRange(rangeKey = "7d", nowInput = new Date()) {
  const now = nowInput instanceof Date ? nowInput : new Date(nowInput);
  const key = String(rangeKey || "7d").trim().toLowerCase();
  const normalized = VALID_RANGES.has(key) ? key : "7d";
  const year = now.getUTCFullYear();

  if (normalized === "24h") {
    return { key: "24h", startAt: new Date(now.getTime() - 24 * 60 * 60 * 1000), endAt: now };
  }

  if (normalized === "ytd") {
    return { key: normalized, startAt: new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0)), endAt: now };
  }

  if (normalized === "prev_year") {
    return {
      key: normalized,
      startAt: new Date(Date.UTC(year - 1, 0, 1, 0, 0, 0, 0)),
      endAt: new Date(Date.UTC(year - 1, 11, 31, 23, 59, 59, 999)),
    };
  }

  if (normalized === "all") {
    return { key: normalized, startAt: null, endAt: now };
  }

  const days = Number(normalized.replace("d", "")) || 7;
  return {
    key: normalized,
    startAt: startOfUtcDay(new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000)),
    endAt: now,
  };
}

function resolvePreviousRange(rangeKey = "7d", nowInput = new Date()) {
  const current = resolveRange(rangeKey, nowInput);
  if (!current.startAt) return { key: current.key, startAt: null, endAt: current.startAt };
  const span = current.endAt.getTime() - current.startAt.getTime();
  return {
    key: current.key,
    startAt: new Date(current.startAt.getTime() - span),
    endAt: new Date(current.startAt.getTime()),
  };
}

function whereForRange(fieldName, range) {
  if (!range?.startAt) return range?.endAt ? { [fieldName]: { lte: range.endAt } } : {};
  return { [fieldName]: { gte: range.startAt, lte: range.endAt } };
}

function rangeForClient(range) {
  return {
    key: range.key,
    startAt: range.startAt ? range.startAt.toISOString() : null,
    endAt: range.endAt ? range.endAt.toISOString() : null,
  };
}

module.exports = {
  VALID_RANGE_KEYS,
  VALID_RANGES,
  resolveRange,
  resolvePreviousRange,
  whereForRange,
  rangeForClient,
};

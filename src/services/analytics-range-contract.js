"use strict";

const DAY_MS = 24 * 60 * 60 * 1000;
const ANALYTICS_CONTRACT_VERSION = 1;
const ANALYTICS_SOURCE_TIMEZONE = "UTC";
const ANALYTICS_HISTORY_FLOOR = "2016-01-01";

const DISPLAY_RANGE_KEYS = Object.freeze(["today", "7d", "30d", "90d", "180d", "365d", "ytd", "prev_year", "all"]);
const CREATOR_OVERVIEW_RANGE_KEYS = Object.freeze(["7d", "30d", "90d", "180d", "365d"]);
const HOME_RANGE_KEYS = Object.freeze(["today", "7d", "30d", "90d"]);
const DISPLAY_RANGE_SET = new Set(DISPLAY_RANGE_KEYS);
const CREATOR_OVERVIEW_RANGE_SET = new Set(CREATOR_OVERVIEW_RANGE_KEYS);
const HOME_RANGE_SET = new Set(HOME_RANGE_KEYS);
const LEGACY_DISPLAY_ALIASES = Object.freeze({ "24h": "today" });

function validDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function utcDay(value) {
  const date = validDate(value);
  if (!date) return null;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function utcDayEnd(value) {
  const day = utcDay(value);
  return day ? new Date(day.getTime() + DAY_MS - 1) : null;
}

function dateKey(value) {
  const day = utcDay(value);
  return day ? day.toISOString().slice(0, 10) : null;
}

function parseDateKey(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && dateKey(date) === text ? date : null;
}

function normalizeDisplayRangeKey(value, fallback = "30d") {
  const raw = String(value || fallback).trim().toLowerCase();
  const normalized = LEGACY_DISPLAY_ALIASES[raw] || raw;
  if (!DISPLAY_RANGE_SET.has(normalized)) {
    const error = new Error("ANALYTICS_RANGE_INVALID");
    error.code = "ANALYTICS_RANGE_INVALID";
    error.rangeKey = raw;
    throw error;
  }
  return normalized;
}

function normalizeProductRangeKey(value, allowedSet, productCode, fallback) {
  const key = normalizeDisplayRangeKey(value, fallback);
  if (!allowedSet.has(key)) {
    const error = new Error(`${productCode}_RANGE_UNSUPPORTED`);
    error.code = `${productCode}_RANGE_UNSUPPORTED`;
    error.rangeKey = key;
    throw error;
  }
  return key;
}

function normalizeCreatorOverviewRangeKey(value, fallback = "30d") {
  return normalizeProductRangeKey(value, CREATOR_OVERVIEW_RANGE_SET, "CREATOR_OVERVIEW", fallback);
}

function normalizeHomeRangeKey(value, fallback = "7d") {
  return normalizeProductRangeKey(value, HOME_RANGE_SET, "HOME", fallback);
}

function displayRangeBounds(rangeKey, now = new Date()) {
  const key = normalizeDisplayRangeKey(rangeKey);
  const anchor = validDate(now);
  if (!anchor) throw new Error("ANALYTICS_RANGE_NOW_INVALID");
  const today = utcDay(anchor);
  let startDay;
  let endDay = today;

  if (key === "today") {
    startDay = today;
  } else if (/^\d+d$/.test(key)) {
    const days = Number(key.slice(0, -1));
    startDay = new Date(today.getTime() - (days - 1) * DAY_MS);
  } else if (key === "ytd") {
    startDay = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
  } else if (key === "prev_year") {
    startDay = new Date(Date.UTC(today.getUTCFullYear() - 1, 0, 1));
    endDay = new Date(Date.UTC(today.getUTCFullYear() - 1, 11, 31));
  } else if (key === "all") {
    startDay = parseDateKey(ANALYTICS_HISTORY_FLOOR);
  } else {
    throw new Error("ANALYTICS_RANGE_UNSUPPORTED");
  }

  return {
    rangeKey: key,
    startDay,
    endDay,
    startAt: startDay,
    endAt: key === "prev_year" ? utcDayEnd(endDay) : anchor,
  };
}

function previousDisplayRange(rangeKey, now = new Date()) {
  const current = displayRangeBounds(rangeKey, now);
  if (current.rangeKey === "all") return null;
  const days = Math.floor((current.endDay.getTime() - current.startDay.getTime()) / DAY_MS) + 1;
  const endDay = new Date(current.startDay.getTime() - DAY_MS);
  const startDay = new Date(endDay.getTime() - (days - 1) * DAY_MS);
  return {
    rangeKey: current.rangeKey,
    startDay,
    endDay,
    startAt: startDay,
    endAt: utcDayEnd(endDay),
  };
}

function scanContractFromJob(job) {
  const params = job?.params && typeof job.params === "object" ? job.params : {};
  const contractVersion = Number(params.analyticsContractVersion);
  if (contractVersion !== ANALYTICS_CONTRACT_VERSION) {
    const error = new Error("ANALYTICS_SCAN_CONTRACT_VERSION_INVALID");
    error.code = "ANALYTICS_SCAN_CONTRACT_VERSION_INVALID";
    throw error;
  }
  const scanFrom = parseDateKey(params.scanFrom);
  const scanTo = parseDateKey(params.scanTo);
  if (!scanFrom || !scanTo || scanFrom > scanTo) {
    const error = new Error("ANALYTICS_SCAN_WINDOW_INVALID");
    error.code = "ANALYTICS_SCAN_WINDOW_INVALID";
    throw error;
  }
  if (scanTo > utcDay(new Date())) {
    const error = new Error("ANALYTICS_SCAN_WINDOW_FUTURE");
    error.code = "ANALYTICS_SCAN_WINDOW_FUTURE";
    throw error;
  }
  const sourceTimezone = String(params.sourceTimezone || "").trim();
  if (sourceTimezone !== ANALYTICS_SOURCE_TIMEZONE) {
    const error = new Error("ANALYTICS_SCAN_TIMEZONE_INVALID");
    error.code = "ANALYTICS_SCAN_TIMEZONE_INVALID";
    throw error;
  }
  const requestedAt = validDate(params.requestedAt);
  if (!requestedAt) {
    const error = new Error("ANALYTICS_SCAN_REQUESTED_AT_INVALID");
    error.code = "ANALYTICS_SCAN_REQUESTED_AT_INVALID";
    throw error;
  }
  const scanGeneration = String(params.scanGeneration || "").trim();
  if (!scanGeneration || scanGeneration.length > 120) {
    const error = new Error("ANALYTICS_SCAN_GENERATION_INVALID");
    error.code = "ANALYTICS_SCAN_GENERATION_INVALID";
    throw error;
  }
  const collectionReason = String(params.collectionReason || "").trim();
  if (!collectionReason || collectionReason.length > 120) {
    const error = new Error("ANALYTICS_SCAN_REASON_INVALID");
    error.code = "ANALYTICS_SCAN_REASON_INVALID";
    throw error;
  }
  return {
    contractVersion,
    scanFrom,
    scanTo,
    scanFromKey: dateKey(scanFrom),
    scanToKey: dateKey(scanTo),
    sourceTimezone,
    requestedAt,
    scanGeneration,
    collectionReason,
    displayRangeKey: params.displayRangeKey ? normalizeDisplayRangeKey(params.displayRangeKey) : null,
  };
}

function eachDay(startDay, endDay) {
  const start = utcDay(startDay);
  const end = utcDay(endDay);
  if (!start || !end || start > end) return [];
  const days = [];
  for (let value = start.getTime(); value <= end.getTime(); value += DAY_MS) days.push(new Date(value));
  return days;
}

module.exports = {
  DAY_MS,
  ANALYTICS_CONTRACT_VERSION,
  ANALYTICS_SOURCE_TIMEZONE,
  ANALYTICS_HISTORY_FLOOR,
  DISPLAY_RANGE_KEYS,
  CREATOR_OVERVIEW_RANGE_KEYS,
  HOME_RANGE_KEYS,
  normalizeDisplayRangeKey,
  normalizeCreatorOverviewRangeKey,
  normalizeHomeRangeKey,
  displayRangeBounds,
  previousDisplayRange,
  scanContractFromJob,
  eachDay,
  utcDay,
  utcDayEnd,
  dateKey,
  parseDateKey,
};

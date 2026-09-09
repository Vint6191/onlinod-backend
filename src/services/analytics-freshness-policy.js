"use strict";

const { DAY_MS, utcDay } = require("./analytics-range-contract");

const CURRENT_DAY_FRESHNESS_MS = 15 * 60 * 1000;
const RECENT_CLOSED_FRESHNESS_MS = 48 * 60 * 60 * 1000;
// Provider history is never declared immutable. Old earnings remain mutable
// evidence and are periodically reverified so refunds/chargebacks/corrections
// can converge without inventing an unsupported FINAL state.
const HISTORICAL_FRESHNESS_MS = 30 * DAY_MS;
const RECENT_HISTORY_DAYS = 30;
const COLLECTION_FUTURE_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

function positiveMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 60_000 ? Math.floor(parsed) : fallback;
}

const NOTIFICATION_COLLECTION_FRESHNESS_MS = positiveMs(process.env.CREATOR_ANALYTICS_NOTIFICATION_CATCHUP_MS, 3 * 60 * 60 * 1000);
const FINANCIAL_COLLECTION_FRESHNESS_MS = positiveMs(process.env.CREATOR_ANALYTICS_FINANCIAL_CATCHUP_MS, 24 * 60 * 60 * 1000);
const CAMPAIGN_COLLECTION_FRESHNESS_MS = positiveMs(process.env.CREATOR_ANALYTICS_CAMPAIGN_CATCHUP_MS, 60 * 60 * 1000);

function trustedCollectionTimestamp(value, now = new Date()) {
  if (!value) return null;
  const timestamp = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  const currentNow = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (!Number.isFinite(timestamp.getTime()) || !Number.isFinite(currentNow.getTime())) return null;
  if (timestamp.getTime() > currentNow.getTime() + COLLECTION_FUTURE_SKEW_TOLERANCE_MS) return null;
  return timestamp;
}

function earningsFreshnessLimitMs(day, now = new Date()) {
  const targetDay = utcDay(day);
  const today = utcDay(now);
  if (targetDay.getTime() === today.getTime()) return CURRENT_DAY_FRESHNESS_MS;
  const ageDays = Math.floor((today.getTime() - targetDay.getTime()) / DAY_MS);
  return ageDays <= RECENT_HISTORY_DAYS ? RECENT_CLOSED_FRESHNESS_MS : HISTORICAL_FRESHNESS_MS;
}

module.exports = {
  CURRENT_DAY_FRESHNESS_MS,
  RECENT_CLOSED_FRESHNESS_MS,
  HISTORICAL_FRESHNESS_MS,
  RECENT_HISTORY_DAYS,
  COLLECTION_FUTURE_SKEW_TOLERANCE_MS,
  NOTIFICATION_COLLECTION_FRESHNESS_MS,
  FINANCIAL_COLLECTION_FRESHNESS_MS,
  CAMPAIGN_COLLECTION_FRESHNESS_MS,
  trustedCollectionTimestamp,
  earningsFreshnessLimitMs,
};

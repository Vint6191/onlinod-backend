"use strict";

const crypto = require("node:crypto");

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value)
    .sort()
    .reduce((out, key) => {
      const item = value[key];
      if (item !== undefined) out[key] = stableValue(item);
      return out;
    }, {});
}

function bucketTimestamp(value, bucketMs) {
  const timestamp = value instanceof Date ? value.getTime() : new Date(value || Date.now()).getTime();
  const size = Number(bucketMs);
  if (!Number.isFinite(timestamp)) return 0;
  if (!Number.isFinite(size) || size <= 0) return timestamp;
  return Math.floor(timestamp / size) * size;
}

function buildJobIdempotencyKey({
  jobKey,
  scope = "creator",
  creatorId = null,
  agencyId = null,
  params = {},
  bucketAt = new Date(),
  bucketMs = 60 * 60 * 1000,
} = {}) {
  const normalized = {
    jobKey: String(jobKey || "").trim(),
    scope: String(scope || "creator").trim(),
    creatorId: creatorId ? String(creatorId) : null,
    agencyId: agencyId ? String(agencyId) : null,
    bucket: bucketTimestamp(bucketAt, bucketMs),
    params: stableValue(params || {}),
  };
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex")
    .slice(0, 32);
  return `${normalized.jobKey || "job"}:${digest}`;
}

module.exports = { stableValue, bucketTimestamp, buildJobIdempotencyKey };

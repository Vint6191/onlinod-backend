"use strict";
const FAN_DATA_INPUT_MAX = 500;
function fanInputError(code, status = 413) { return Object.assign(new Error(code), { code, status }); }
function exactFanId(value) {
  if (typeof value !== "string" && !(typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) return null;
  const id = String(value).trim();
  return id && id.length <= 180 && !/[\x00-\x1f\x7f]/.test(id) ? id : null;
}
function boundedFanIds(values = [], code = "FAN_DATA_REQUEST_TOO_LARGE") {
  if (!Array.isArray(values)) throw fanInputError("FAN_DATA_IDS_INVALID", 400);
  // Check raw cardinality before iteration, normalization, dedupe or hashing.
  if (values.length > FAN_DATA_INPUT_MAX) throw fanInputError(code);
  const ids = new Set();
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const id = exactFanId(value);
    if (!id) throw fanInputError("FAN_DATA_ID_INVALID", 400);
    ids.add(id);
  }
  return [...ids];
}
module.exports = { FAN_DATA_INPUT_MAX, exactFanId, boundedFanIds, fanInputError };

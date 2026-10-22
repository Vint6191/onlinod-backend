"use strict";
const { hashCanonicalJson } = require("./realtime-receipt-hash");
const { publishEntityChanges } = require("./creator-entity-change-service");

// Only a typed invalidation leaves the media owner. Private descriptions,
// provider URLs, aggregate money and custom-order evidence remain in its reads.
async function publishMediaResult({ db, agencyId, creatorId, kind, entityId = creatorId, mediaId, state }) {
  const dataVersion = hashCanonicalJson(state);
  return publishEntityChanges({ db, agencyId, creatorId, changes: [{ entityType: "MEDIA", entityId,
    sourceIdentity: `media:${kind}:${entityId}`, sourceVersion: dataVersion,
    payload: { dataVersion, reason: kind, ...(mediaId ? { mediaId } : {}) } }] });
}
module.exports = { publishMediaResult };

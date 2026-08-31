"use strict";

const CREATOR_CONNECTION_STATES = Object.freeze({
  ENROLLMENT_REQUIRED: "ENROLLMENT_REQUIRED",
  CONNECTING: "CONNECTING",
  CONNECTED: "CONNECTED",
  RECONNECT_REQUIRED: "RECONNECT_REQUIRED",
  RECONNECTING: "RECONNECTING",
});

function creatorConnectionLockKey(agencyId, creatorId) {
  const agency = String(agencyId || "").trim();
  const creator = String(creatorId || "").trim();
  if (!agency || !creator) {
    throw Object.assign(new Error("Creator connection lock requires agencyId and creatorId"), {
      code: "CREATOR_CONNECTION_LOCK_KEY_INVALID",
    });
  }
  return `creator_connection:${agency}:${creator}`;
}

module.exports = { CREATOR_CONNECTION_STATES, creatorConnectionLockKey };

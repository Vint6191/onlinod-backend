"use strict";

/**
 * Library content and draft-insertion telemetry do not establish sent, reply,
 * purchase or revenue attribution. Historical metadata.stats is retained as
 * raw evidence only; no caller-supplied value or source marker makes it a
 * measured result. Keep this public projection independent of that metadata.
 */
function unavailableMessageLibraryStats() {
  return {
    sent: null,
    replies: null,
    replyRate: null,
    purchases: null,
    earned: null,
    totalEarned: null,
    unavailableReason: "NO_CONFIRMED_ATTRIBUTION",
  };
}

module.exports = { unavailableMessageLibraryStats };

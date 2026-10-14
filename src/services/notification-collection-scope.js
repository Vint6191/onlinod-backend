"use strict";

// The current Desktop traverses all five types in both FULL and catch-up mode.
// A repair is another complete traversal; partial coverage is not its scope.
const NOTIFICATION_TYPES = Object.freeze(["purchases", "tips", "subscriptions", "likes", "comments"]);

function hasFullNotificationScope(params) {
  // Both existing consumers default a missing/non-array scope to all types.
  if (!Array.isArray(params?.types)) return true;
  const types = new Set(params.types.map(type => String(type).trim().toLowerCase()));
  return types.size === NOTIFICATION_TYPES.length && NOTIFICATION_TYPES.every(type => types.has(type));
}

module.exports = { NOTIFICATION_TYPES, hasFullNotificationScope };

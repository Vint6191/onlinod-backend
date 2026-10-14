"use strict";

// Classify only the creator lifecycle trigger's NOWAIT conflict. Callers may
// convert it into waiting only AFTER their transaction has rolled back.
function isCreatorLifecycleContention(error) {
  return String(error?.meta?.code || error?.code || "") === "55P03"
    && /\bPHASE2_CREATOR_LIFECYCLE_BUSY\b/.test(String(error?.meta?.message || error?.message || ""));
}
module.exports = { isCreatorLifecycleContention };

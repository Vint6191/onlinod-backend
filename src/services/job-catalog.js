"use strict";

const JOB_CATALOG = Object.freeze({
  fetch_earnings: Object.freeze({ wave: "read-only", scope: "creator" }),
  fetch_campaigns: Object.freeze({ wave: "read-only", scope: "creator" }),
  traffic_sources_scan: Object.freeze({ wave: "read-only", scope: "creator" }),
  catchup_notifications_scan: Object.freeze({ wave: "read-only", scope: "creator" }),
});

const CLAIMABLE_DESKTOP_JOB_KEYS = Object.freeze(Object.keys(JOB_CATALOG));
const CLAIMABLE_DESKTOP_JOB_KEY_SET = new Set(CLAIMABLE_DESKTOP_JOB_KEYS);

function filterClaimableDesktopJobKeys(values) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || "").trim())
      .filter((value) => CLAIMABLE_DESKTOP_JOB_KEY_SET.has(value))
  ));
}

module.exports = {
  JOB_CATALOG,
  CLAIMABLE_DESKTOP_JOB_KEYS,
  filterClaimableDesktopJobKeys,
};

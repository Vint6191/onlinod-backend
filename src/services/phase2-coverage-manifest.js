"use strict";

const { createHash } = require("node:crypto");
const {
  FAMILY,
  GENERATION,
} = require("./phase2-work-coverage-authority-service");

// This value is intentionally immutable for the exact Actual53 Phase2 family set.
// Adding/removing/changing a family requires a NEW manifest version and therefore a
// NEW one-time seed lane generation. Reusing a completed old seed is M53-01.
const COVERAGE_MANIFEST_VERSION = "phase2_coverage_manifest_actual53_v1";
const COVERAGE_SEED_LANE_KEY = "phase2_coverage_seed_v3_actual53_final";
const COVERAGE_SEED_GENERATION = `${COVERAGE_MANIFEST_VERSION}:seed_v1`;

const COVERAGE_MANIFEST = Object.freeze([
  Object.freeze([FAMILY.PROVIDER_OPERATIONAL, GENERATION.PROVIDER_OPERATIONAL]),
  Object.freeze([FAMILY.CUSTOM_EXTERNAL_PROJECTION, GENERATION.CUSTOM_EXTERNAL_PROJECTION]),
  Object.freeze([FAMILY.CUSTOM_SOURCE_PIPELINE, GENERATION.CUSTOM_SOURCE_PIPELINE]),
  Object.freeze([FAMILY.TEAM_ACTIVITY_CONTRIBUTION, GENERATION.TEAM_ACTIVITY_CONTRIBUTION]),
  Object.freeze([FAMILY.TEAM_RESPONSE_RANGE_REPAIR, GENERATION.TEAM_RESPONSE_RANGE_REPAIR]),
  Object.freeze([FAMILY.TEAM_DIALOG_PROJECTION, GENERATION.TEAM_DIALOG_PROJECTION]),
  Object.freeze([FAMILY.TEAM_MONEY_ROOT_CLASSIFICATION, GENERATION.TEAM_MONEY_ROOT_CLASSIFICATION]),
  Object.freeze([FAMILY.TEAM_MONEY_RECONCILIATION, GENERATION.TEAM_MONEY_RECONCILIATION]),
  Object.freeze([FAMILY.TEAM_READ_SUMMARY, GENERATION.TEAM_READ_SUMMARY]),
  Object.freeze([FAMILY.TELEGRAM_CONFIRMED_PROJECTION, GENERATION.TELEGRAM_CONFIRMED_PROJECTION]),
  Object.freeze([FAMILY.TELEGRAM_INBOUND_PROJECTION, GENERATION.TELEGRAM_INBOUND_PROJECTION]),
]);

function coverageManifestFingerprint() {
  return createHash("sha256")
    .update(JSON.stringify({ version: COVERAGE_MANIFEST_VERSION, manifest: COVERAGE_MANIFEST }))
    .digest("hex");
}

module.exports = {
  COVERAGE_MANIFEST_VERSION,
  COVERAGE_SEED_LANE_KEY,
  COVERAGE_SEED_GENERATION,
  COVERAGE_MANIFEST,
  coverageManifestFingerprint,
};

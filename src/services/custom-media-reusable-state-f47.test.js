"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ROOT = __dirname;
const read = (name) => fs.readFileSync(path.join(ROOT, name), "utf8");

test("F47 reusable Bump state cannot persist or plan CUSTOM media", () => {
  const server = read("automation-server-service.js");
  const planner = read("bump-service.js");
  const delivery = read("custom-content-delivery-service.js");
  assert.match(delivery, /async function classifyProgrammaticCustomMediaProvenance/);
  assert.match(delivery, /resolveAttemptedCustomMedia/);
  assert.match(server, /assertReusableBumpMediaAllowed/);
  assert.match(server, /AUTOMATION_BUMP_CUSTOM_MEDIA_FORBIDDEN/);
  assert.match(server, /async function saveBump[\s\S]*assertReusableBumpMediaAllowed[\s\S]*upsertTask/);
  assert.match(server, /if \(restore\)[\s\S]*assertReusableBumpMediaAllowed[\s\S]*restoreTask/);
  assert.match(planner, /classifyBumpCustomMediaIds[\s\S]*classifyProgrammaticCustomMediaProvenance[\s\S]*activeTemplates[\s\S]*classifyBumpCustomMediaIds/);
  assert.match(planner, /blockedTemplateIds/);
  assert.match(planner, /custom_media_programmatic_forbidden/);
});


test("F47 legacy Bump deliveries cannot be manually retried around current provenance", () => {
  const planner = read("bump-service.js");
  const authority = read("automation-action-delivery-service.js");
  assert.match(planner, /async function validateBumpDelivery[\s\S]*classifyBumpCustomMediaIds/);
  assert.match(planner, /custom_media_programmatic_forbidden/);
  assert.match(authority, /retryActionDelivery[\s\S]*custom_media_programmatic_forbidden/);
  assert.match(authority, /retryActionDelivery[\s\S]*validateBumpDelivery/);
});

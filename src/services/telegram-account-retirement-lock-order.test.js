"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "settings-service.js"), "utf8");

function bodyBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `missing source range ${startMarker}`);
  return source.slice(start, end);
}

function assertBefore(text, left, right, message) {
  const a = text.indexOf(left);
  const b = text.indexOf(right);
  assert.ok(a >= 0 && b >= 0 && a < b, message || `${left} must precede ${right}`);
}

test("normal Telegram retirement serializes Agency before account and Custom blockers", () => {
  const body = bodyBetween("async function removeTelegramMtprotoAccount", "async function forceRetireLostTelegramMtprotoAccount");
  const begin = body.slice(body.indexOf("const beginRetirement = async (tx)"), body.indexOf("await client.$transaction((tx) => beginRetirement(tx)"));
  assertBefore(begin, "lockAgencyPipelineLifecycle", "lockTelegramAccountLifecycleRow", "ACTIVE -> RETIRING must acquire Agency lifecycle fence before the account row");
  assertBefore(begin, "lockTelegramAccountLifecycleRow", "assertTelegramAccountNoBusinessBlockers", "account row must still fence new provider work before the blocker scan");

  const finish = body.slice(body.indexOf("const retire = async (tx)"));
  assertBefore(finish, "lockAgencyPipelineLifecycle", "lockTelegramAccountLifecycleRow", "RETIRING -> RETIRED must reacquire the account row after Agency lifecycle");
  assertBefore(finish, "lockTelegramAccountLifecycleRow", "assertTelegramAccountNoBusinessBlockers", "final blocker scan must run under the account row fence");
  assertBefore(finish, "assertTelegramAccountNoBusinessBlockers", "scheduleTelegramAccountRetirementFanout", "bounded retirement fanout must be published only after the final blocker scan");
  assert.doesNotMatch(finish, /agencyTelegramMtprotoAccount\.delete/, "management transaction must not synchronously hard-delete the Telegram account");
});

test("force retirement uses the same Agency-first lifecycle order", () => {
  const body = bodyBetween("async function forceRetireLostTelegramMtprotoAccount", "async function readTelegramMtprotoAccountSecret");
  assertBefore(body, "lockAgencyPipelineLifecycle", "lockTelegramAccountLifecycleRow", "force retirement must acquire Agency lifecycle fence before the account row");
  assertBefore(body, "lockTelegramAccountLifecycleRow", "assertTelegramAccountNoBusinessBlockers", "force retirement must preserve account-before-blocker serialization after the Agency fence");
  assertBefore(body, "assertTelegramAccountNoBusinessBlockers", "scheduleTelegramAccountRetirementFanout", "force retirement must publish bounded fanout only after blockers");
  assert.doesNotMatch(body, /agencyTelegramMtprotoAccount\.delete/, "force management transaction must not synchronously hard-delete the Telegram account");
});

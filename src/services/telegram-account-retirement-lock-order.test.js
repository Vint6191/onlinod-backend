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
  assertBefore(begin, "lockAgencyPipelineLifecycle", "agencyTelegramMtprotoAccount.updateMany", "ACTIVE -> RETIRING must acquire Agency lifecycle fence before the account row");
  assertBefore(begin, "agencyTelegramMtprotoAccount.updateMany", "assertTelegramAccountNoBusinessBlockers", "account row must still fence new provider work before the blocker scan");

  const finish = body.slice(body.indexOf("const retire = async (tx)"));
  assertBefore(finish, "lockAgencyPipelineLifecycle", "assertTelegramAccountNoBusinessBlockers", "RETIRING -> RETIRED blocker scan must also be Agency-first");
  assertBefore(finish, "assertTelegramAccountNoBusinessBlockers", "agencyTelegramMtprotoAccount.delete", "hard delete must remain after the full blocker scan");
});

test("force retirement uses the same Agency-first lifecycle order", () => {
  const body = bodyBetween("async function forceRetireLostTelegramMtprotoAccount", "async function readTelegramMtprotoAccountSecret");
  assertBefore(body, "lockAgencyPipelineLifecycle", "agencyTelegramMtprotoAccount.updateMany", "force retirement must acquire Agency lifecycle fence before the account row");
  assertBefore(body, "agencyTelegramMtprotoAccount.updateMany", "assertTelegramAccountNoBusinessBlockers", "force retirement must preserve account-before-blocker serialization after the Agency fence");
  assertBefore(body, "assertTelegramAccountNoBusinessBlockers", "agencyTelegramMtprotoAccount.delete", "force hard delete must remain after blockers");
});

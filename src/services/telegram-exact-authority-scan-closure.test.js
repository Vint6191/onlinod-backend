"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("F44 runtime eligibility separates exact discovery from resource claim limits", () => {
  const runtime = read("src/services/telegram-execution-runtime.js");
  const eligible = runtime.slice(runtime.indexOf("async function eligibleTelegramExecutionAccounts"), runtime.indexOf("async function assertTelegramMessagingAccess"));
  assert.doesNotMatch(eligible, /take:\s*1000\b/);
  assert.doesNotMatch(eligible, /take:\s*100\b/);
  assert.match(eligible, /take:\s*2\b/, "Auto may read two ACTIVE rows because the exact question is 0, 1, or >1");
  assert.match(eligible, /findPendingTaskAnchors/);
  assert.match(eligible, /scanIncompleteTelegramSources/);
  assert.match(eligible, /scanActiveFollowupIntents/);
  assert.match(runtime, /MAX_RUNTIME_CLAIMS\s*=\s*100/, "resource claim cap remains separate from discovery correctness");
});

test("F44 retirement uses exact current-thread/source authority instead of sampled history", () => {
  const settings = read("src/services/settings-service.js");
  const blocker = settings.slice(settings.indexOf("async function assertTelegramAccountNoBusinessBlockers"), settings.indexOf("async function getTelegramMtprotoSettings"));
  assert.doesNotMatch(blocker, /take:\s*1000\b/);
  assert.match(blocker, /findPendingTaskAnchors\(\{\s*agencyId,\s*accountId:\s*id/);
  assert.match(blocker, /scanIncompleteTelegramSources/);
  assert.match(blocker, /telegramInboundEvent\.findFirst/);
});

test("F44 exact scan helper paginates to exhaustion and TASK discovery starts from current PENDING orders", () => {
  const helper = read("src/services/telegram-exact-authority-scan-service.js");
  assert.match(helper, /cursor:\s*\{\s*id:\s*cursorId\s*\}/);
  assert.match(helper, /skip:\s*1/);
  assert.match(helper, /status:\s*"PENDING"/);
  assert.match(helper, /customOrderId:\s*\{\s*in:\s*orderIds\s*\}/);
  assert.match(helper, /TELEGRAM_EXACT_AUTHORITY_SCAN_STALLED/);
});

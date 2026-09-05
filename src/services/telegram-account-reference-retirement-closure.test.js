"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("F40/F41 all NEW manual-source and creator account references share the ACTIVE account-row authority", () => {
  const helper = read("src/services/telegram-account-reference-authority-service.js");
  const submissions = read("src/services/custom-content-submissions-service.js");
  const creatorAuthority = read("src/services/creator-telegram-contact-authority-service.js");
  const creatorsRoute = read("src/routes/creators.js");
  const delivery = read("src/services/telegram-delivery-authority-service.js");

  assert.match(helper, /agencyTelegramMtprotoAccount\.updateMany/);
  assert.match(helper, /lifecycleState:\s*"ACTIVE"/);
  assert.match(submissions, /lockActiveTelegramAccountReference\(\{/);
  assert.match(creatorAuthority, /lockActiveTelegramAccountReference\(\{/);
  assert.match(creatorAuthority, /isolationLevel:\s*"Serializable"/);
  assert.match(delivery, /lockActiveTelegramAccountReference\(\{/);
  assert.match(creatorsRoute, /updateCreatorTelegramContact\(\{/);
  const contactRoute = creatorsRoute.slice(creatorsRoute.indexOf('router.patch("/:id/telegram-contact"'), creatorsRoute.indexOf('router.patch("/:id/telegram-identity"'));
  assert.doesNotMatch(contactRoute, /agencyTelegramMtprotoAccount\.(findFirst|updateMany|update|create)/, "creator route cannot perform stale account pre-read/write outside the authority transaction");
});

test("F42 current-work resolution and authorization treat RETIRING as unavailable without silently switching explicit assignments to Auto", () => {
  const reminders = read("src/services/custom-order-reminders.js");
  const settings = read("src/services/settings-service.js");

  const resolver = reminders.slice(reminders.indexOf("async function resolveTelegramAccountId"), reminders.indexOf("module.exports"));
  assert.match(resolver, /activeLifecycleWhere\(\)/);
  assert.match(resolver, /return exists \? exists\.id : null/);
  assert.match(settings, /requireActive:\s*normalizedPurpose === "authorize"/);
  assert.match(settings, /storeTelegramMtprotoSession[\s\S]*isolationLevel:\s*"Serializable"/);
  assert.match(settings, /SETTINGS_TELEGRAM_ACCOUNT_RETIRING/);
});

test("F42 retirement is a visible lifecycle result rather than a committed transition reported as generic failure", () => {
  const settings = read("src/services/settings-service.js");
  const route = read("src/routes/settings.js");

  assert.match(settings, /lifecycleState:\s*"RETIRING"/);
  assert.match(settings, /drainRequired/);
  assert.match(settings, /forceRetireAvailable/);
  assert.match(route, /removeTelegramMtprotoAccount/);
  assert.match(route, /return res\.json\(result\)/);
});

test("F43 lost-owner force retirement is explicit, audited, live-owner fenced, and separately surfaced", () => {
  const settings = read("src/services/settings-service.js");
  const route = read("src/routes/settings.js");

  assert.match(settings, /acknowledgeLostObservations !== true/);
  assert.match(settings, /SETTINGS_TELEGRAM_FORCE_RETIRE_REASON_REQUIRED/);
  assert.match(settings, /SETTINGS_TELEGRAM_FORCE_RETIRE_RUNTIME_LIVE/);
  assert.match(settings, /settings\.telegram\.account_force_retired_lost_runtime/);
  assert.match(settings, /required:\s*true/);
  assert.match(route, /\/telegram\/accounts\/:accountId\/force-retire/);
});

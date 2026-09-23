"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function controls(creator, values) {
  let sent;
  const handlers = {};
  const button = { dataset: { saveCreatorEntitlement: creator.id }, addEventListener: (type, fn) => { handlers[type] = fn; } };
  const root = {
    querySelector: selector => Object.hasOwn(values, selector) ? { value: values[selector] } : null,
    querySelectorAll: selector => selector === "[data-save-creator-entitlement]" ? [button] : [],
  };
  const window = { OnlinodRouter: { toast: () => {} }, OnlinodAdminAuth: { request: async (url, options) => { sent = { url, ...options }; return { ok: false, error: "test stops before reload" }; } } };
  const source = fs.readFileSync(path.join(__dirname, "../../public/pages/admin.js"), "utf8").replace("window.OnlinodAdminPage = { render: guardedStart };", "window.OnlinodAdminPage = { bind, state, localDateTimeValue };");
  vm.runInNewContext(source, { window, CSS: { escape: value => value }, Date });
  window.OnlinodAdminPage.state.selectedAgency = { id: "a", creators: [creator] };
  window.OnlinodAdminPage.bind(root);
  return { click: () => handlers.click(), sent: () => sent, date: window.OnlinodAdminPage.localDateTimeValue };
}
test("AI-only edit from the actual UI retains untouched paid timestamps and source fields", async () => {
  const creator = { id: "c", billingProfile: { tier: "PRO" }, billingEntitlement: { tier: "PRO", entitlementRevision: 7, coreValidUntil: "2026-10-01T12:34:56Z", aiChatterValidUntil: null } };
  const values = { '[data-entitlement-reason="c"]': "AI extension", '[data-entitlement-tier="c"]': "PRO", '[data-entitlement-outreach="c"]': "", '[data-entitlement-ai="c"]': "2026-12-01T00:00" };
  const ui = controls(creator, values); values['[data-entitlement-core="c"]'] = ui.date(creator.billingEntitlement.coreValidUntil);
  await ui.click();
  assert.equal(ui.sent().body.expectedRevision, 7);
  assert.equal(Object.hasOwn(ui.sent().body, "coreValidUntil"), false);
  assert.equal(Object.hasOwn(ui.sent().body, "tier"), false);
  assert.ok(ui.sent().body.aiChatterValidUntil);
});
test("a default tier from pricing does not fabricate a core revoke while granting only an add-on", async () => {
  const creator = { id: "c", billingProfile: { tier: "ELITE" }, billingEntitlement: null };
  const ui = controls(creator, { '[data-entitlement-reason="c"]': "AI grant", '[data-entitlement-tier="c"]': "ELITE", '[data-entitlement-core="c"]': "", '[data-entitlement-outreach="c"]': "", '[data-entitlement-ai="c"]': "2026-12-01T00:00" });
  await ui.click();
  assert.equal(ui.sent().body.expectedRevision, 0);
  assert.equal(Object.hasOwn(ui.sent().body, "coreValidUntil"), false);
  assert.equal(Object.hasOwn(ui.sent().body, "tier"), false);
});

"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  { randomUUID } = require("node:crypto");
const { parseManagementCommand, ACTIONS } = require("./management-command-contract");
const retired = require("../middleware/retired-management-writes");
const inputs = {
  "billing.preferences": ["c", { expectedRevision: "a".repeat(64), aiChatterEnabled: false, outreachEnabled: true }],
  "billing.start": ["c", { expectedRevision: "a".repeat(64), testMode: true, expectedActive: false, expectedChargeCents: 2000 }],
  "billing.cancelRenewal": ["c", { expectedRevision: "a".repeat(64) }],
  "creator.beginConnection": ["c", { deviceId: "d", expectedGeneration: 0, expectedState: "ENROLLMENT_REQUIRED" }],
  "creator.telegramContact": ["c", { telegramContact: "@next", telegramAccountId: null, expectedContact: null, expectedAccountId: null }],
  "account.profile": ["", { name: "next", expectedName: null }],
  "workspace.update": ["", { expectedRevision: "a".repeat(64), name: "name" }],
  "creator.create": ["", { displayName: "draft", username: "draft" }],
  "creator.update": ["c", { displayName: "new", expectedUpdatedAt: "2026-09-29T00:00:00.000Z" }],
  "network.create": [
    "c",
    { label: "test", type: "SOCKS5", host: "example.test", port: 1080, deviceId: "d", expectedNetworkVersion: 0 },
  ],
  "network.update": ["p", { label: "test", deviceId: "d", expectedVersion: 1 }],
  "network.delete": ["p", { expectedVersion: 1 }],
  "network.assign": ["c", { mode: "DIRECT", expectedVersion: 0 }],
};
for (const action of ACTIONS)
  test(`${action}: strict contract, raw fingerprint, cancellable invalid payload`, () => {
    const [targetId, payload] = inputs[action],
      c = { commandId: randomUUID(), action, targetId, payload },
      parsed = parseManagementCommand(c);
    assert.equal(parsed.fingerprint, parseManagementCommand(c, { cancel: true }).fingerprint);
    assert.notEqual(
      parsed.fingerprint,
      parseManagementCommand({ ...c, payload: { ...payload, unused: true } }, { cancel: true }).fingerprint
    );
    assert.throws(() => parseManagementCommand({ ...c, payload: { ...payload, unused: true } }));
    assert.ok(parseManagementCommand({ ...c, payload: { notValid: true } }, { cancel: true }).fingerprint);
  });
test("plain passwords or extra plaintext nested inside encrypted envelopes fail validation", () => {
  const [targetId, payload] = inputs["network.create"],
    c = { commandId: randomUUID(), action: "network.create", targetId, payload };
  for (const extra of [
    { password: "sensitive" },
    {
      opaqueCredentials: {
        encryptionMode: "CLIENT_E2E_V1",
        algorithm: "aes-256-gcm-client-e2e-v1",
        keyVersion: 1,
        ciphertext: "cipher",
        iv: "iv",
        tag: "tag",
        password: "bad",
      },
    },
  ])
    assert.throws(() => parseManagementCommand({ ...c, payload: { ...payload, ...extra } }));
});
test("KEEP and CLEAR cannot smuggle encrypted replacement material", () => {
  const [targetId, payload] = inputs["network.update"];
  for (const mode of ["KEEP", "CLEAR"])
    assert.throws(() =>
      parseManagementCommand({
        commandId: randomUUID(),
        action: "network.update",
        targetId,
        payload: {
          ...payload,
          credentials: {
            mode,
            opaqueCredentials: {
              encryptionMode: "CLIENT_E2E_V1",
              algorithm: "aes-256-gcm-client-e2e-v1",
              keyVersion: 1,
              ciphertext: "cipher",
              iv: "iv",
              tag: "tag",
            },
          },
        },
      })
    );
});
test("bad identity, target and excessive cancelled payload are bounded", () => {
  const c = {
    commandId: randomUUID(),
    action: "creator.create",
    targetId: "",
    payload: { displayName: "name", username: "name" },
  };
  assert.throws(() => parseManagementCommand({ ...c, commandId: "invalid" }));
  assert.throws(() => parseManagementCommand({ ...c, targetId: "another" }));
  assert.throws(
    () => parseManagementCommand({ ...c, payload: { value: "x".repeat(1100 * 1024) } }, { cancel: true }),
    (e) => e.code === "MANAGEMENT_COMMAND_TOO_LARGE"
  );
});
for (const [method, url] of [
  ["POST", "/api/creators/c/begin-connection"],
  ["PATCH", "/api/creators/c/telegram-contact"],
  ["PATCH", "/api/billing/creators/c/preferences"],
  ["POST", "/api/billing/creators/c/start"],
  ["POST", "/API/BILLING/creators/c/cancel-renewal/"],
  ["POST", "/api/creators/"],
  ["POST", "/API/Creators/"],
  ["PATCH", "/API/SETTINGS/Account/Profile/"],
  ["PATCH", "/api/creators/c"],
  ["PATCH", "/api/settings/account/profile"],
  ["PATCH", "/api/settings/workspace"],
  ["POST", "/api/network-profiles/creators/c/proxy"],
  ["PATCH", "/api/network-profiles/proxies/p"],
  ["DELETE", "/api/network-profiles/proxies/p"],
  ["PUT", "/api/network-profiles/creators/c"],
])
  test(`${method} ${url} is a retired unkeyed write`, () => {
    let status;
    retired(
      { method, baseUrl: "", path: url },
      {
        status(s) {
          status = s;
          return this;
        },
        json(v) {
          assert.equal(v.code, "MANAGEMENT_COMMAND_REQUIRED");
        },
      },
      () => assert.fail("unkeyed write admitted")
    );
    assert.equal(status, 410);
  });
for (const [method, path] of [
  ["POST", "/api/billing/creators/c/refresh-earnings"],
  ["POST", "/api/billing/orders/o/reconcile"],
  ["POST", "/api/creators/c/complete-connection"],
  ["POST", "/api/creators/c/platform-profile"],
  ["GET", "/api/creators/c"],
  ["DELETE", "/api/creators/c"],
  ["POST", "/api/network-profiles/proxies/p/test-material"],
  ["POST", "/api/settings/account/password"],
  ["DELETE", "/api/settings/account/avatar"],
])
  test(`${method} ${path} retains its domain owner`, () => {
    let next = false;
    retired(
      { method, baseUrl: "", path },
      {
        status() {
          assert.fail("incorrect retirement");
        },
      },
      () => {
        next = true;
      }
    );
    assert.ok(next);
  });

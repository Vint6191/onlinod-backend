"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { assertAutomationDeliveryAdoption } = require("./automation-delivery-adoption-guard");

const expected = {
  agencyId: "agency-1",
  creatorId: "creator-1",
  moduleKey: "BUMPS",
  actionType: "SEND_MESSAGE",
};

function delivery(overrides = {}) {
  return {
    id: "delivery-1",
    originKind: "AUTOMATION",
    ...expected,
    ...overrides,
  };
}

test("Automation idempotency adoption accepts only the exact Automation authority binding", () => {
  const row = delivery();
  assert.equal(assertAutomationDeliveryAdoption(row, expected), row);
  assert.equal(assertAutomationDeliveryAdoption(null, expected), null);
});

test("Automation idempotency adoption rejects a shared-table programmatic row", () => {
  assert.throws(
    () => assertAutomationDeliveryAdoption(delivery({ originKind: "INTERACTIVE" }), expected),
    (error) => error?.code === "AUTOMATION_IDEMPOTENCY_CONFLICT" && error?.status === 409,
  );
});

test("Automation idempotency adoption rejects wrong creator/module/action binding", () => {
  for (const patch of [
    { creatorId: "creator-2" },
    { agencyId: "agency-2" },
    { moduleKey: "LIKES" },
    { actionType: "LIKE_POST" },
  ]) {
    assert.throws(
      () => assertAutomationDeliveryAdoption(delivery(patch), expected),
      (error) => error?.code === "AUTOMATION_IDEMPOTENCY_CONFLICT" && error?.status === 409,
    );
  }
});

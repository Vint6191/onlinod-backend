"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { parseManagementCommand } = require("./management-command-contract");

function command(rangeKey) {
  return { commandId: randomUUID(), action: "operation.control", targetId: "creator",
    payload: { family: "analytics_refresh", operation: "refresh", input: { rangeKey },
      expectedRevision: "a".repeat(64) } };
}

// Exercise the real durable-command boundary, where the old independent enum
// rejected the two long periods that the current Overview already displayed.
for (const rangeKey of ["7d", "30d", "90d", "180d", "365d"]) {
  test(`Creator Analytics refresh accepts the current ${rangeKey} period without rewriting its intent`, () => {
    const input = command(rangeKey);
    const parsed = parseManagementCommand(input);
    assert.deepEqual(parsed.payload, input.payload);
    assert.equal(parsed.fingerprint, parseManagementCommand(input, { cancel: true }).fingerprint);
  });
}

test("Creator Analytics refresh rejects non-overview periods and unknown fields at admission", () => {
  for (const range of ["today", "yesterday", "14d", "all", "ytd", "prev_year", "366d", "", null, undefined]) {
    assert.throws(() => parseManagementCommand(command(range)), error => error.name === "ZodError");
  }
  const extra = command("180d");
  extra.payload.input.forceUnverified = true;
  assert.throws(() => parseManagementCommand(extra), error => error.name === "ZodError");
});

test("Creator Analytics long-period refresh still requires the original optimistic revision", () => {
  const input = command("365d");
  delete input.payload.expectedRevision;
  assert.throws(() => parseManagementCommand(input), error => error.name === "ZodError");
});

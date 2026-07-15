"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { sanitizeAuditMetadata } = require("./audit-service");

test("audit metadata strips secrets and message content", () => {
  const value = sanitizeAuditMetadata({
    creatorId: "c1",
    token: "secret",
    cookie: "session=1",
    messageText: "private text",
    nested: { leaseToken: "lease", status: "COMPLETED" },
  });
  assert.equal(value.creatorId, "c1");
  assert.equal(value.token, "[redacted]");
  assert.equal(value.cookie, "[redacted]");
  assert.equal(value.messageText, "[redacted]");
  assert.equal(value.nested.leaseToken, "[redacted]");
  assert.equal(value.nested.status, "COMPLETED");
});

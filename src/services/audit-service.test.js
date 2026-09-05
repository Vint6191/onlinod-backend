"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { audit, sanitizeAuditMetadata } = require("./audit-service");

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


test("required audit propagates durable storage failure while best-effort audit remains non-fatal", async () => {
  const db={auditLog:{async create(){throw Object.assign(new Error("audit down"),{code:"AUDIT_DOWN"});}}};
  const originalWarn=console.warn; console.warn=()=>{};
  try {
    assert.equal(await audit({agencyId:"a1",action:"best_effort",db}),null);
    await assert.rejects(audit({agencyId:"a1",action:"required",db,required:true}),(error)=>error?.code==="AUDIT_DOWN");
  } finally { console.warn=originalWarn; }
});

"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createRuntimeDiagnosticEmitter, diagnosticError } = require("./runtime-diagnostic-log");
test("diagnostics emit at default level, redact nested credentials and never include raw exceptions", () => {
  const rows = [], emit = createRuntimeDiagnosticEmitter({ log: { warn: (...row) => rows.push(row) } });
  emit("claim failed", "job", { error: diagnosticError(Object.assign(Error("private SQL canary"), { code: "FINANCIAL_RESOLUTION_BINDING_INVALID" })),
    snapshot: { token: "canary-token", cookies: ["canary-cookie"], params: { x: "canary" }, phase: "RECOLLECTING" } });
  assert.equal(rows[0][1].error.code, "FINANCIAL_RESOLUTION_BINDING_INVALID");
  assert.equal(rows[0][1].snapshot.phase, "RECOLLECTING");
  assert.doesNotMatch(JSON.stringify(rows), /canary/);
});
test("repeated failures remain visible each minute with bounded key memory and global output", () => {
  let at = 0; const rows = [];
  const emit = createRuntimeDiagnosticEmitter({ log: { warn: (...row) => rows.push(row) }, now: () => at, capacity: 2, maxPerMinute: 3 });
  assert.equal(emit("error", "a", {}), true);
  assert.equal(emit("error", "a", {}), false);
  assert.equal(emit("error", "b", {}), true);
  assert.equal(emit("error", "c", {}), true);
  assert.equal(emit("error", "d", {}), false);
  at = 60_000;
  assert.equal(emit("error", "a", {}), true);
  assert.equal(rows.at(-1)[1].diagnosticRateLimited, 1);
  assert.equal(rows.length, 4);
});
test("broken logger, circular metadata and bigint cannot break caller work", () => {
  const circular = {}; circular.self = circular;
  const emit = createRuntimeDiagnosticEmitter({ log: { warn: () => { throw Error("log down"); } } });
  assert.equal(emit("test", "a", { circular, count: 5n }), false);
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  safeTraceId,
  expectedLongRequest,
  createRequestObservabilityMiddleware,
} = require("./request-observability");

test("request observability accepts bounded opaque trace ids only", () => {
  assert.equal(safeTraceId("12345678-aaaa-bbbb-cccc-123456789012"), "12345678-aaaa-bbbb-cccc-123456789012");
  assert.equal(safeTraceId("short"), null);
  assert.equal(safeTraceId("bad trace id with spaces"), null);
  assert.equal(safeTraceId("x".repeat(129)), null);
});

test("request observability preserves an incoming desktop trace and emits one terminal timing", () => {
  const rows = [];
  const middleware = createRequestObservabilityMiddleware({
    slowRequestMs: 10_000,
    log: {
      debug(message, meta) { rows.push({ level: "debug", message, meta }); },
      warn(message, meta) { rows.push({ level: "warn", message, meta }); },
    },
  });
  const req = {
    method: "POST",
    path: "/api/desktop/bootstrap",
    headers: {
      "x-nod-trace-id": "execution-12345678",
      "x-nod-startup-trace-id": "startup-12345678",
    },
  };
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.setHeader = (name, value) => { res.headers[String(name).toLowerCase()] = value; };
  let nextCalled = false;

  middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req.traceId, "execution-12345678");
  assert.equal(req.startupTraceId, "startup-12345678");
  assert.equal(res.headers["x-nod-trace-id"], "execution-12345678");

  res.emit("finish");
  res.emit("close");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].level, "debug");
  assert.equal(rows[0].meta.traceId, "execution-12345678");
  assert.equal(rows[0].meta.startupTraceId, "startup-12345678");
  assert.equal(rows[0].meta.path, "/api/desktop/bootstrap");
  assert.ok(rows[0].meta.durationMs >= 0);
});

test("event streams are timed but excluded from generic slow-request warnings", () => {
  assert.equal(expectedLongRequest("/api/creator-sessions/events"), true);
  assert.equal(expectedLongRequest("/api/creators"), false);
});

test("fast failed background polls are visible without logging request secrets", () => {
  for (const path of ["/api/jobs/claim", "/api/devices/heartbeat", "/api/creator-sessions/events"]) {
    const rows = [];
    const middleware = createRequestObservabilityMiddleware({ slowRequestMs: 10_000,
      log: { debug: (message, meta) => rows.push({ level: "debug", message, meta }),
        warn: (message, meta) => rows.push({ level: "warn", message, meta }) } });
    const req = { method: "POST", originalUrl: path + "?token=private-query",
      headers: { authorization: "Bearer private-header", "x-nod-trace-id": "job-poll-12345678" },
      body: { credential: "private-body" } };
    const res = new EventEmitter(); res.statusCode = 503; res.setHeader = () => {};
    middleware(req, res, () => {}); res.emit("finish"); res.emit("close");
    assert.equal(rows.length, 1); assert.equal(rows[0].level, "warn");
    assert.equal(rows[0].message, "failed http request");
    assert.equal(rows[0].meta.path, path); assert.equal(rows[0].meta.status, 503);
    assert.equal(rows[0].meta.traceId, "job-poll-12345678");
    assert.doesNotMatch(JSON.stringify(rows), /private-|credential|authorization|token=/);
  }
});

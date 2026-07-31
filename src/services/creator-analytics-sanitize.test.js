"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { sanitizeAnalyticsRaw } = require("./creator-analytics-sanitize");

test("analytics raw sanitizer keeps chart data but strips secrets recursively", () => {
  const input = {
    chart: [{ value: 1 }, { value: 2 }],
    authorization: "Bearer secret",
    nested: {
      accessToken: "token",
      cookie: "sid=secret",
      safe: "ok",
      deeper: { api_key: "hidden", points: [3, 4] },
    },
  };
  const clean = sanitizeAnalyticsRaw(input);
  assert.deepEqual(clean.chart, [{ value: 1 }, { value: 2 }]);
  assert.equal(clean.authorization, undefined);
  assert.equal(clean.nested.accessToken, undefined);
  assert.equal(clean.nested.cookie, undefined);
  assert.equal(clean.nested.safe, "ok");
  assert.deepEqual(clean.nested.deeper.points, [3, 4]);
  assert.equal(clean.nested.deeper.api_key, undefined);
});

test("analytics raw sanitizer rejects prototype keys, cycles and oversized values", () => {
  const cyclic = { safe: true, huge: "x".repeat(30_000), list: Array.from({ length: 6000 }, (_, index) => index) };
  cyclic.self = cyclic;
  Object.defineProperty(cyclic, "__proto__", { value: { polluted: true }, enumerable: true });
  const clean = sanitizeAnalyticsRaw(cyclic);
  assert.equal(clean.safe, true);
  assert.equal(clean.huge.length, 10_000);
  assert.equal(clean.list.length, 5_000);
  assert.equal(clean.self, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(clean, "__proto__"), false);
});

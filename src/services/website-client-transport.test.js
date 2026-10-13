"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../../public/site/web-api.js"), "utf8");
function client(fetch) {
  const window = {};
  vm.runInNewContext(source, { window, navigator: {}, fetch, AbortController, FormData, setTimeout, clearTimeout });
  return window.NODWeb;
}

test("website accepts a complete receipt and keeps business rejections distinguishable from lost responses", async () => {
  let calls = 0;
  const api = client(async () => {
    calls++;
    return Response.json(calls === 1 ? { ok: true, emailSent: true } : { ok: false, code: "INVALID_CREDENTIALS" }, { status: calls === 1 ? 201 : 401 });
  });
  assert.equal((await api.request("/api/web/auth/register", { method: "POST", body: {} })).emailSent, true);
  await assert.rejects(api.request("/api/web/auth/login", { method: "POST", body: {} }), error => error.code === "INVALID_CREDENTIALS" && error.status === 401);
  assert.equal(calls, 2);
});

for (const [label, body, status] of [["truncated JSON", '{"ok":true', 201], ["proxy HTML", "<html>upstream unavailable</html>", 502], ["empty receipt", "{}", 200], ["null receipt", "null", 200], ["array receipt", "[]", 200]]) {
  test(`website treats ${label} as uncertain and never repeats a mutation`, async () => {
    let calls = 0;
    const api = client(async () => { calls++; return new Response(body, { status }); });
    await assert.rejects(api.request("/api/web/auth/register", { method: "post", body: {} }), { code: "REQUEST_OUTCOME_UNKNOWN" });
    assert.equal(calls, 1);
    await assert.rejects(api.request("/api/web/auth/me"), { code: "NETWORK_UNAVAILABLE" });
    assert.equal(calls, 2);
  });
}

test("AbortError with numeric DOM code is normalized for both read and write requests", async () => {
  let calls = 0;
  const api = client((_path, { signal }) => new Promise((_resolve, reject) => {
    calls++;
    signal.addEventListener("abort", () => reject(new DOMException("Timed out", "AbortError")), { once: true });
  }));
  await assert.rejects(api.request("/api/web/auth/register", { method: "POST", body: {}, timeout: 5 }), { code: "REQUEST_OUTCOME_UNKNOWN" });
  await assert.rejects(api.request("/api/web/auth/me", { timeout: 5 }), { code: "NETWORK_UNAVAILABLE" });
  assert.equal(calls, 2);
});

test("a connection reset carrying a low-level code cannot masquerade as a backend rejection", async () => {
  const api = client(async () => { throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); });
  await assert.rejects(api.request("/api/web/auth/reset-password", { method: "POST", body: {} }), { code: "REQUEST_OUTCOME_UNKNOWN" });
});

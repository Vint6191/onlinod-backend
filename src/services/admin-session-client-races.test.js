"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm"), fs = require("node:fs"), path = require("node:path");
const { webcrypto } = require("node:crypto");
const files = path.join(__dirname, "../../public/admin/core");
const input = { path: "/api/admin/billing/creator/c", method: "PATCH", body: { reason: "proof", expectedRevision: 1, corePriceCents: 2000 }, token: "first-token" };
const defer = () => { let resolve; return { promise: new Promise(r => { resolve = r; }), resolve: value => resolve(value) }; };
function browser(fetch) {
  const storage = new Map(), tokens = new Map([["onlinod_admin_token", "first-token"]]); let renders = 0;
  const window = { OnlinodAdminState: { lastDebug: { preserved: true } }, OnlinodAdminRouter: { render: () => { renders++; } }, dispatchEvent() {}, CustomEvent: class {} };
  const sandbox = { window, crypto: webcrypto, TextEncoder, URLSearchParams, Date, fetch,
    sessionStorage: { getItem: k => storage.get(k), setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) },
    localStorage: { getItem: k => tokens.get(k), setItem: (k,v) => tokens.set(k,v), removeItem: k => tokens.delete(k) },
    location: { pathname: "/admin" }, history: { pushState() {} },
  };
  for (const file of ["admin-command-client.js", "admin-api.js"]) vm.runInNewContext(fs.readFileSync(path.join(files, file), "utf8"), sandbox);
  return { window, commands: window.OnlinodAdminCommands, api: window.OnlinodAdminApi, renders: () => renders };
}
function response(status, body) { return { status, ok: status < 400, headers: { get: () => "application/json" }, json: async () => body }; }

for (const status of [200, 401, 403]) test(`late ${status} from an old login cannot affect the current admin session`, async () => {
  const gate = defer(), entered = defer();
  const b = browser(async () => { entered.resolve(); return gate.promise; });
  const request = b.api.request("/api/admin/plans"); await entered.promise;
  b.api.setToken("new-token"); gate.resolve(response(status, { ok: status === 200, customerData: "old-session-data" }));
  const result = await request;
  assert.equal(result.code, "ADMIN_SESSION_CHANGED"); assert.equal(result.customerData, undefined);
  assert.equal(b.api.getToken(), "new-token"); assert.equal(b.renders(), 0);
  assert.equal(b.window.OnlinodAdminState.lastDebug.preserved, true);
});

test("changing session during preparation prevents an old-session send", async () => {
  const gate = defer(); let sends = 0;
  const b = browser(async () => { sends++; return response(200, {}); });
  b.commands.prepare = () => gate.promise;
  const request = b.api.request(input.path, input); b.api.setToken("new-token"); gate.resolve(null);
  assert.equal((await request).code, "ADMIN_SESSION_CHANGED"); assert.equal(sends, 0);
});

test("denied retries keep the uncertain command UUID", async () => {
  const b = browser(), first = await b.commands.prepare(input);
  for (const status of [400, 401, 403, 404, 428]) {
    const retry = await b.commands.prepare(input);
    b.commands.settle(retry, { status }, { ok: false, code: "DENIED" });
    assert.equal((await b.commands.prepare(input)).commandId, first.commandId);
  }
});

test("a first pre-admission validation failure permits correcting the form", async () => {
  const b = browser(), first = await b.commands.prepare(input);
  b.commands.settle(first, { status: 400 }, { ok: false, code: "VALIDATION_ERROR" });
  assert.notEqual((await b.commands.prepare({ ...input, body: { ...input.body, corePriceCents: 3000 } })).commandId, first.commandId);
});

test("a delayed old receipt cannot erase a newer command", async () => {
  const b = browser(), first = await b.commands.prepare(input);
  b.commands.settle(first, { status: 200 }, { ok: true, commandId: first.commandId });
  const nextInput = { ...input, body: { ...input.body, corePriceCents: 3000 } }, next = await b.commands.prepare(nextInput);
  b.commands.settle(first, { status: 200 }, { ok: true, commandId: first.commandId });
  assert.equal((await b.commands.prepare(nextInput)).commandId, next.commandId);
});

test("a delayed status read cannot erase a newer command", async () => {
  const gate = defer(), entered = defer();
  const b = browser(async () => { entered.resolve(); return gate.promise; }), first = await b.commands.prepare(input);
  const read = b.commands.resolve(input.path, input.method, input.token); await entered.promise;
  b.commands.settle(first, { status: 200 }, { ok: true, commandId: first.commandId });
  const nextInput = { ...input, body: { ...input.body, corePriceCents: 3000 } }, next = await b.commands.prepare(nextInput);
  gate.resolve(response(200, { ok: true, commandId: first.commandId, status: "SUCCEEDED" }));
  assert.equal((await read).pending, true);
  assert.equal((await b.commands.prepare(nextInput)).commandId, next.commandId);
});

test("a current-session 401 still signs out and clears current credentials", async () => {
  const b = browser(async () => response(401, { ok: false, code: "ADMIN_AUTH_INVALID" }));
  assert.equal((await b.api.me()).code, "ADMIN_AUTH_INVALID");
  assert.equal(b.api.getToken(), ""); assert.equal(b.renders(), 1);
});

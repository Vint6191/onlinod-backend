"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const transport = require("./website-session-transport");
function response() { return { values: [], statusCode: 200, set() { return this; }, status(n) { this.statusCode = n; return this; }, json(data) { this.body = data; return this; }, cookie(...args) { this.values.push(args); }, clearCookie(...args) { this.values.push(args); } }; }
function request(extra = {}) { return { method: "POST", path: "/login", protocol: "https", secure: true,
  headers: { host: "nod.example", origin: "https://nod.example", "x-nod-client": "website" },
  get(name) { return this.headers[name]; }, body: {}, ...extra }; }
test("web mutations require the same origin and an explicit browser-client header", () => {
  for (const change of [{ origin: "https://evil.example" }, { origin: "null" }, { "x-nod-client": "" }, { "sec-fetch-site": "cross-site" }]) {
    const req = request(); Object.assign(req.headers, change); const res = response(); let called = false;
    transport.requireWebsiteRequest(req, res, () => { called = true; }); assert.equal(called, false); assert.equal(res.statusCode, 403);
  }
  let called = false; transport.requireWebsiteRequest(request(), response(), () => { called = true; }); assert.equal(called, true);
});
test("browser login gets a server-issued logical device and new login lineage", () => {
  const req = request({ body: { email: "u@example.test", deviceId: "victim", client: "desktop", authorizationScopeIncarnation: "victim-generation", rememberDevice: true } });
  transport.prepareAuthRequest(req, response(), () => {});
  assert.match(req.body.deviceId, /^web-/); assert.match(req.body.authorizationScopeIncarnation, /^web-auth-/);
  assert.equal(req.body.client, "website"); assert.equal(req.websiteRemember, true);
  const previous = req.body.authorizationScopeIncarnation;
  transport.prepareAuthRequest(req, response(), () => {}); assert.notEqual(req.body.authorizationScopeIncarnation, previous);
});
test("browser refresh accepts only cookie credentials and preserves device binding", () => {
  const req = request({ path: "/refresh", body: { refreshToken: "body-secret", deviceId: "victim" } });
  req.headers.cookie = "nod_web_refresh=cookie-secret; nod_web_device=web-01234567-89ab-cdef-0123-456789abcdef; nod_web_remember=1";
  req.headers.authorization = "Bearer untrusted";
  transport.prepareAuthRequest(req, response(), () => {});
  assert.equal(req.body.refreshToken, "cookie-secret"); assert.equal(req.body.deviceId, "web-01234567-89ab-cdef-0123-456789abcdef");
  assert.equal(req.body.authorizationScopeIncarnation, null); assert.equal(req.headers.authorization, undefined);
});
test("website response never returns bearer tokens and cookies are HttpOnly, scoped and Secure", () => {
  const req = request({ websiteRemember: true, websiteDevice: "web-device" }), res = response();
  transport.replySession(req, res, { ok: true, user: { id: "u" }, accessToken: "access", refreshToken: "refresh",
    accessTokenExpiresAt: "2030-01-01T00:00:00Z", refreshTokenExpiresAt: "2030-02-01T00:00:00Z" }, true);
  assert.equal(res.body.accessToken, undefined); assert.equal(res.body.refreshToken, undefined); assert.equal(res.body.user.id, "u");
  assert.equal(res.values.length, 4);
  for (const [, , options] of res.values) assert.deepEqual({ httpOnly: options.httpOnly, secure: options.secure, sameSite: options.sameSite, path: options.path }, { httpOnly: true, secure: true, sameSite: "lax", path: "/api/web" });
  assert.ok(res.values.every(([, , opts]) => opts.expires instanceof Date));
});
test("non-remembered login uses session cookies and native API keeps its token contract", () => {
  const req = request({ websiteRemember: false }), res = response(), data = { ok: true, accessToken: "a", refreshToken: "r" };
  transport.replySession(req, res, data, true); assert.ok(res.values.every(([, , opts]) => !Object.hasOwn(opts, "expires")));
  const native = response(); transport.replySession(req, native, data, false); assert.equal(native.body, data); assert.equal(native.values.length, 0);
});
test("logout clears only this website's credentials", () => {
  const res = response(); transport.clearSession(request(), res);
  assert.deepEqual(res.values.map(v => v[0]), ["nod_web_access", "nod_web_refresh", "nod_web_remember", "nod_web_device"]);
});

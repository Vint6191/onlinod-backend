"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto"), express = require("express");
const { createMemoryDb } = require("../../scripts/test-support/admin-command-memory-db");
const { adminReadBoundary } = require("../middleware/admin-read-boundary");

function install(t, m) {
  m.state.sessions[0].tokenHash = crypto.createHash("sha256").update("read-proof-token").digest("hex");
  const path = require.resolve("../prisma"), prior = require.cache[path];
  require.cache[path] = { id: path, filename: path, loaded: true, exports: m.db };
  const sessionPath = require.resolve("../middleware/admin-session"); delete require.cache[sessionPath];
  t.after(() => { if (prior) require.cache[path] = prior; else delete require.cache[path]; delete require.cache[sessionPath]; });
  return require("../middleware/admin-session").adminSessionRequired;
}
async function listen(t, app) {
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return (path = "/read", options = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers: { Authorization: "Bearer read-proof-token" }, ...options });
}

for (const cause of ["expiry", "revocation", "epoch", "disabled"]) test(`admin read discards its computed DTO after ${cause}`, async t => {
  const m = createMemoryDb(), app = express();
  app.use(install(t, m), adminReadBoundary);
  app.get("/read", async (_req, res) => {
    await Promise.resolve();
    if (cause === "expiry") m.clock.setUTCFullYear(2030);
    if (cause === "revocation") m.state.sessions[0].revokedAt = new Date(m.clock);
    if (cause === "epoch") m.state.admins[0].accessEpoch++;
    if (cause === "disabled") m.state.admins[0].active = false;
    return res.json({ ok: true, customerData: "must-not-be-sent" });
  });
  const fetchRead = await listen(t, app), response = await fetchRead();
  assert.equal(response.status, cause === "disabled" ? 403 : 401);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(await response.text(), /must-not-be-sent/);
});

test("a failed final authority query fails closed without exposing the prepared DTO", async t => {
  let failClock = false;
  const m = createMemoryDb({ extendClient(api) {
    const query = api.$queryRawUnsafe;
    api.$queryRawUnsafe = async (sql, ...args) => { if (failClock && sql.includes("clock_timestamp")) throw Error("Clock unavailable"); return query(sql, ...args); };
    return api;
  } });
  const app = express(); app.use(install(t, m), adminReadBoundary);
  app.get("/read", (_req, res) => { failClock = true; return res.json({ customerData: "must-not-be-sent" }); });
  const fetchRead = await listen(t, app), response = await fetchRead();
  assert.equal(response.status, 503);
  const body = await response.json(); assert.equal(body.code, "ADMIN_READ_AUTHORITY_UNAVAILABLE"); assert.equal(body.customerData, undefined);
});

test("valid reads retain status, redaction, dates and bigint conversion", async t => {
  const m = createMemoryDb(), app = express(); app.use(install(t, m), adminReadBoundary);
  app.get("/read", (_req, res) => res.status(206).json({ ok: true, count: 42n, at: new Date("2026-01-01"), nested: [{ passwordHash: "hidden", label: "visible" }] }));
  const fetchRead = await listen(t, app), response = await fetchRead();
  assert.equal(response.status, 206);
  assert.deepEqual(await response.json(), { ok: true, count: "42", at: "2026-01-01T00:00:00.000Z", nested: [{ label: "visible" }] });
});

test("main, billing, data and identity GET routers all reject authority revoked after admission", async t => {
  let armed = false;
  const m = createMemoryDb({ extendClient(api, { read, clock }) {
    const query = api.$queryRawUnsafe;
    api.$queryRawUnsafe = async (sql, ...args) => {
      const rows = await query(sql, ...args);
      if (armed && sql.includes("clock_timestamp")) { armed = false; read().sessions[0].revokedAt = new Date(clock); }
      return rows;
    };
    api.adminUser.findMany = async () => structuredClone(read().admins);
    return api;
  } });
  install(t, m);
  const app = express();
  for (const [prefix, file] of [["/api/admin", "admin"], ["/api/admin/billing", "admin-billing"], ["/api/admin/data", "admin-data"], ["/api/admin-auth", "admin-auth"]]) {
    const p = require.resolve(`../routes/${file}`); delete require.cache[p]; app.use(prefix, require(p)); t.after(() => { delete require.cache[p]; });
  }
  const fetchRead = await listen(t, app);
  for (const path of ["/api/admin/admin-users", "/api/admin/billing/commercial-policy", "/api/admin/data/search?q=x", "/api/admin-auth/me"]) {
    m.state.sessions[0].revokedAt = null;
    const valid = await fetchRead(path); assert.equal(valid.status, 200, path); await valid.json();
    armed = true;
    const stale = await fetchRead(path); assert.equal(stale.status, 401, path); assert.equal((await stale.json()).code, "ADMIN_AUTH_INVALID");
    assert.equal(armed, false);
  }
});

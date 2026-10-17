"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const { createApiTrafficLimiter } = require("./api-traffic-limiter");
const { signAccessToken } = require("../utils/tokens");

function token(deviceId, extra = {}) { return signAccessToken({ userId: "user-a", agencyId: "agency-a", deviceId, ...extra }); }

async function serverFixture(t, env = {}) {
  const app = express();
  app.use("/api", createApiTrafficLimiter({ env }));
  app.use(express.json());
  app.use("/api", (_req, res) => res.status(204).end());
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const agent = new http.Agent({ keepAlive: true, maxSockets: 32 });
  t.after(async () => { agent.destroy(); await new Promise(resolve => server.close(resolve)); });
  return (pathname, accessToken = null, body = {}) => new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port: server.address().port, path: pathname, method: "POST", agent,
      headers: { "Content-Type": "application/json", ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) } }, response => {
      let data = ""; response.setEncoding("utf8"); response.on("data", part => { data += part; });
      response.on("end", () => resolve({ status: response.statusCode, body: data ? JSON.parse(data) : null }));
    });
    request.on("error", reject); request.end(JSON.stringify(body));
  });
}

test("six creator acquire/started streams do not exhaust a shared-IP UI budget", async (t) => {
  const send = await serverFixture(t);
  const accessToken = token("device-a");
  for (let batch = 0; batch < 12; batch += 1) {
    const responses = await Promise.all(Array.from({ length: 100 }, (_, index) => send(
      index % 2 ? "/api/of-request-gate/started" : "/api/of-request-gate/acquire", accessToken,
      { creatorId: `creator-${index % 6}`, deviceId: "device-a" },
    )));
    assert.ok(responses.every(response => response.status === 204), `protocol batch ${batch}`);
  }
  assert.equal((await send("/api/home", accessToken)).status, 204);
});

test("signed devices behind one NAT have independent budgets; token rotation and body device spoof do not reset one", async (t) => {
  const send = await serverFixture(t, { API_DEVICE_RATE_LIMIT_PER_MIN: "2" });
  const a = token("device-a"), b = token("device-b");
  assert.equal((await send("/api/home", a)).status, 204);
  assert.equal((await send("/api/home", token("device-a", { nonce: "rotated" }))).status, 204);
  assert.equal((await send("/api/home", a, { deviceId: "spoof-other-device" })).status, 429);
  assert.equal((await send("/api/home", b)).status, 204);
  assert.equal((await send("/api/home", b)).status, 204);
  assert.equal((await send("/api/home", b)).status, 429);
});

test("acquire overload retains a bounded separate budget for started and cancel", async (t) => {
  const send = await serverFixture(t, { OF_GATE_ACQUIRE_RATE_LIMIT_PER_MIN: "2", OF_GATE_SETTLEMENT_RATE_LIMIT_PER_MIN: "2" });
  const a = token("device-a");
  assert.equal((await send("/api/of-request-gate/acquire", a)).status, 204);
  assert.equal((await send("/api/of-request-gate/acquire", a)).status, 204);
  const rejected = await send("/api/of-request-gate/acquire", a);
  assert.equal(rejected.status, 429); assert.equal(rejected.body.retryable, true);
  assert.equal((await send("/api/of-request-gate/started", a)).status, 204);
  assert.equal((await send("/api/of-request-gate/cancel", a)).status, 204);
  assert.equal((await send("/api/of-request-gate/started", a)).status, 429);
  assert.equal((await send("/api/home", a)).status, 204);
});

test("missing, forged and device-unbound tokens retain the anonymous IP limit", async (t) => {
  const send = await serverFixture(t, { API_RATE_LIMIT_PER_MIN: "2" });
  assert.equal((await send("/api/of-request-gate/acquire", null, { deviceId: "spoof-a" })).status, 204);
  assert.equal((await send("/api/of-request-gate/acquire", "forged.jwt.claims", { deviceId: "spoof-b" })).status, 204);
  assert.equal((await send("/api/of-request-gate/acquire", token(null))).status, 429);
});

test("a valid token cannot bypass the public authentication IP limit", async (t) => {
  const send = await serverFixture(t, { API_RATE_LIMIT_PER_MIN: "2" });
  assert.equal((await send("/api/auth/login", token("device-a"))).status, 204);
  assert.equal((await send("/api/auth/refresh", token("device-b"))).status, 204);
  assert.equal((await send("/api/auth/login", token("device-c"))).status, 429);
});

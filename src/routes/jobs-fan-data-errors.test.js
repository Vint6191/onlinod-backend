"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), express = require("express");
const { FanDataObservationBoundaryError } = require("../services/fan-data-authority-service");
const inject = (id, exports) => { const path = require.resolve(id); require.cache[path] = { id: path, filename: path, loaded: true, exports }; };
let failure;
inject("../services/job-lease-service", { JobLeaseError: class extends Error {}, progressJob: async () => { throw failure; } });
inject("../middleware/auth", { requireAuthDevice() {} });
delete require.cache[require.resolve("./jobs")];
const router = require("./jobs");

test("job progress exposes typed fan observation rejection and preserves unexpected-error handling", async t => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.auth = { userId: 'user' }; next(); });
  app.use('/jobs', router);
  app.use((_err, _req, res, _next) => res.status(500).json({ code: 'SERVER_ERROR' }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const post = () => fetch(`http://127.0.0.1:${server.address().port}/jobs/job/progress`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: 'device', leaseToken: 'fixture-token-long-enough', leaseRevision: 1 }),
  });
  failure = new FanDataObservationBoundaryError('FAN_DATA_SAME_GENERATION_CONFLICT', 'Contradictory profile hint', 409);
  failure.details = { secretProfile: 'must-not-be-returned' };
  let response = await post(); assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { ok: false, code: 'FAN_DATA_SAME_GENERATION_CONFLICT', error: 'Contradictory profile hint', retryable: false });
  failure = new Error('unrelated SQL problem'); response = await post();
  assert.equal(response.status, 500); assert.deepEqual(await response.json(), { code: 'SERVER_ERROR' });
});

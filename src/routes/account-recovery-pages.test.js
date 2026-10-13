"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");

test("public recovery routes serve a separate uncached document without reflecting the token", async () => {
  const app = express();
  app.use(require("./account-recovery-pages"));
  app.use((_req, res) => res.status(404).end());
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const route of ["/forgot-password", "/reset-password?token=private-do-not-reflect", "/reset-password/"]) {
      const response = await fetch(base + route);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("cache-control"), /no-store/);
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
      const html = await response.text();
      assert.match(html, /id="reset-form"/);
      assert.match(html, /id="request-form"/);
      assert.doesNotMatch(html, /private-do-not-reflect|NodSession|\/core\/state\.js/);
    }
    assert.equal((await fetch(base + "/unrelated")).status, 404);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

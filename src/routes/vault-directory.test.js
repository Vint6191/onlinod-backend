"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const prismaModule = require.resolve("../prisma");
const schedulerModule = require.resolve("../services/job-scheduler");
require.cache[prismaModule] = { id: prismaModule, filename: prismaModule, loaded: true, exports: {} };
require.cache[schedulerModule] = { id: schedulerModule, filename: schedulerModule, loaded: true, exports: { scheduleJobNow: async () => ({ created: false, reason: "test", job: {} }) } };
delete require.cache[require.resolve("./vault-directory")];
const router = require("./vault-directory");

function routePaths() {
  return router.stack
    .filter((layer) => layer.route)
    .map((layer) => `${Object.keys(layer.route.methods).join(',').toUpperCase()} ${layer.route.path}`);
}

test("Vault Directory exposes Messages catalog and Never Used projection without a second inventory scanner", () => {
  const paths = routePaths();
  for (const expected of [
    "GET /:creatorId/unsorted",
    "POST /:creatorId/unsorted/items",
    "POST /:creatorId/unsorted/scans",
    "GET /:creatorId/never-used",
    "POST /:creatorId/never-used/items",
  ]) assert.ok(paths.includes(expected), `${expected} is missing`);
  assert.equal(paths.some((path) => path.includes("/:creatorId/inventory")), false);
});

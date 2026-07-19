"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("active Media Library catalog is the only Never Used candidate inventory", () => {
  const neverUsed = read("src/services/vault-never-used-service.js");
  const resultService = read("src/services/job-result-service.js");
  const schema = read("prisma/schema.prisma");

  assert.match(neverUsed, /db\.creatorMediaAsset\.findMany/);
  assert.match(neverUsed, /catalogActive:\s*true/);
  assert.match(neverUsed, /sentCount:\s*0/);
  assert.doesNotMatch(neverUsed, /vaultUnsortedItem|vaultAssetSalesAggregate|dialogMessageMedia/);
  assert.doesNotMatch(neverUsed, /creatorVaultMediaInventory|creatorVaultInventorySnapshot/);
  assert.doesNotMatch(resultService, /vault-inventory-service|INVENTORY_JOB_KEY|vault_creator_inventory_scan/);
  assert.doesNotMatch(schema, /model CreatorVaultInventorySnapshot|model CreatorVaultMediaInventory/);
  assert.match(schema, /model CreatorMediaAsset/);
  assert.match(schema, /model CreatorMediaUsageContribution/);
  assert.doesNotMatch(schema, /model VaultUnsortedItem|model VaultAssetSalesAggregate|model CreatorMediaDeliveryEvent/);
  assert.equal(fs.existsSync(path.join(root, "src/services/vault-inventory-service.js")), false);
  assert.equal(fs.existsSync(path.join(root, "src/services/vault-inventory-normalizer.js")), false);
});

test("redundant creator inventory tables are removed by a safe follow-up migration", () => {
  const migration = read("prisma/migrations/20260716224500_drop_redundant_creator_inventory/migration.sql");
  assert.match(migration, /DROP TABLE IF EXISTS "CreatorVaultMediaInventory"/);
  assert.match(migration, /DROP TABLE IF EXISTS "CreatorVaultInventorySnapshot"/);
  assert.match(migration, /WHERE "jobKey" = 'vault_creator_inventory_scan'/);
});

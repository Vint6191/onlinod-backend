"use strict";
const { ID, assertCapacityProjectionCatalog } = require("../../src/services/provider-capacity-catalog-contract");

async function verifyCapacityCatalog(db) {
  const rows = await db.$queryRawUnsafe(
    'SELECT "generation","jobKeys" FROM "ProviderCapacityProjectionState" WHERE "id"=$1', ID);
  return { event: "CAPACITY_PROJECTION_CATALOG_PASS", ...assertCapacityProjectionCatalog(rows[0]) };
}

module.exports = { verifyCapacityCatalog };
if (require.main === module) {
  require("dotenv").config();
  const db = require("../../src/prisma");
  verifyCapacityCatalog(db).then(result => console.log(JSON.stringify(result))).catch(error => {
    if (error.capacityCatalog) console.error(JSON.stringify(error.capacityCatalog));
    console.error(error.code || error.message); process.exitCode = 1;
  }).finally(() => db.$disconnect());
}

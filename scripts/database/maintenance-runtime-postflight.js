"use strict";
const { verifyMaintenanceRuntime } = require("../../src/services/maintenance-runtime-contract");
module.exports = { verifyMaintenanceRuntime };
if (require.main === module) {
  require("dotenv").config();
  const db = require("../../src/prisma");
  verifyMaintenanceRuntime({ db }).then(result => console.log(JSON.stringify({ maintenanceRuntime: result })))
    .catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.$disconnect());
}

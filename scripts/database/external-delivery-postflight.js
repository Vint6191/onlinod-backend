"use strict";
const { verifyExternalDeliveryRuntime } = require("../../src/services/external-delivery-runtime-contract");
module.exports = { verifyExternalDeliveryRuntime };
if (require.main === module) {
  require("dotenv").config();
  const db = require("../../src/prisma");
  verifyExternalDeliveryRuntime({ db }).then(result => console.log(JSON.stringify(result)))
    .catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => db.$disconnect());
}

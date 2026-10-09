"use strict";
// Keep the established entry point; current diagnostics have one SQL proof owner.
const { main } = require("./current-admin-diagnostics-proof.cjs");
const keep = setInterval(() => {}, 1000);
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearInterval(keep));

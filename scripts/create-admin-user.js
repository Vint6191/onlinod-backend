"use strict";
const prisma = require("../src/prisma");
const { bootstrapAdmin } = require("../src/services/admin-operator-bootstrap-service");
async function main() {
  // A retry must use the same ADMIN_COMMAND_ID, operator, reason and payload.
  // Existing admin sessions are revoked atomically with credential rotation.
  const result = await bootstrapAdmin({ db: prisma, commandId: process.env.ADMIN_COMMAND_ID, operator: process.env.ADMIN_OPERATOR, reason: process.env.ADMIN_REASON, email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD, name: process.env.ADMIN_NAME || "Onlinod Admin" });
  console.log("Admin user ready:", result);
}
main().catch(error => { console.error(error?.issues ? "Required: ADMIN_EMAIL, ADMIN_PASSWORD (8–72 UTF-8 bytes), ADMIN_OPERATOR, ADMIN_REASON, ADMIN_COMMAND_ID (stable UUID)." : (error.code || "ADMIN_BOOTSTRAP_FAILED")); process.exitCode = 1; }).finally(() => prisma.$disconnect());

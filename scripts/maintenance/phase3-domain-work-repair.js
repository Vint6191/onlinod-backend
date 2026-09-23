#!/usr/bin/env node
"use strict";

const prisma = require("../../src/prisma");
const { resumeDomainWorkAfterRepair } = require("../../src/services/domain-work-repair-service");

function arg(name) {
  const prefix = `--${name}=`;
  return process.argv.slice(3).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}
async function main() {
  const action = process.argv[2] || "list";
  const agencyId = arg("agency");
  if (!agencyId) throw new Error("--agency=<id> is required");
  if (action === "list") {
    const workClass = arg("class");
    if (!workClass) throw new Error("list requires --class=<workClass>");
    const rows = await prisma.domainWorkItem.findMany({
      where: { agencyId, workClass, state: "RECONCILE_REQUIRED" },
      orderBy: [{ availableAt: "asc" }, { id: "asc" }], take: 100,
      select: { id: true, creatorId: true, requestedRevision: true, consecutiveFailures: true, errorClass: true, terminalCause: true, lastError: true, lastFailureAt: true, lastRepair: true },
    });
    console.log(JSON.stringify({ rows }, (_, value) => typeof value === "bigint" ? String(value) : value));
    return;
  }
  if (action !== "resume") throw new Error("Use list or resume");
  const result = await resumeDomainWorkAfterRepair({ db: prisma, agencyId,
    workId: arg("id"), expectedRevision: arg("revision"), reason: arg("reason") });
  console.log(JSON.stringify(result));
  if (!result.resumed) process.exitCode = 2;
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
module.exports = { main };

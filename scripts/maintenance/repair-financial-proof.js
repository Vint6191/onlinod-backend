"use strict";

// Preview is the default. The command only repairs coverage metadata and queues
// durable provider verification; COMPLETE never means that verification ran.
const { runRepairPage } = require("../../src/services/financial-proof-repair-service");
const db = require("../../src/prisma");
async function main() {
  const options = { mode: "dry-run" }; let maxPages = 1;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply") options.mode = "apply";
    else if (arg === "--dry-run") options.mode = "dry-run";
    else if (["--run-id", "--agency-id", "--cursor", "--limit", "--max-pages", "--expected-revision"].includes(arg)) {
      const value = args[++i]; if (!value || value.startsWith("--")) throw Error("FINANCIAL_REPAIR_ARGUMENT_REQUIRED");
      if (arg === "--run-id") options.runId = value;
      if (arg === "--agency-id") options.agencyId = value;
      if (arg === "--cursor") options.cursor = value;
      if (arg === "--limit") options.limit = Number(value);
      if (arg === "--max-pages") maxPages = Number(value);
      if (arg === "--expected-revision") options.expectedRevision = Number(value);
    } else throw Error("FINANCIAL_REPAIR_UNKNOWN_ARGUMENT");
  }
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000
    || (options.limit != null && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100))
    || (options.expectedRevision != null && (!Number.isInteger(options.expectedRevision) || options.expectedRevision < 1)))
    throw Error("FINANCIAL_REPAIR_ARGUMENT_INVALID");
  for (let page = 0; page < maxPages; page++) {
    const result = await runRepairPage({ db, ...options });
    process.stdout.write(JSON.stringify(result) + "\n");
    if (result.status === "COMPLETE") break;
    if (options.mode === "dry-run") options.cursor = result.nextCursor;
    else options.expectedRevision = result.revision;
  }
}
main().catch(error => { process.stderr.write(String(error.code || error.message) + "\n"); process.exitCode = 1; })
  .finally(() => db.$disconnect());

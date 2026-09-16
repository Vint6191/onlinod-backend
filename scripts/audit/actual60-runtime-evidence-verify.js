"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { validateClosureReceipt } = require("./actual60-runtime-evidence");

const input = String(process.argv[2] || process.env.ONLINOD_AUDIT_EVIDENCE_PATH || "").trim();
if (!input) {
  console.error("usage: node scripts/audit/actual60-runtime-evidence-verify.js <receipt.json>");
  process.exit(2);
}
const target = path.resolve(input);
let receipt;
try {
  receipt = JSON.parse(fs.readFileSync(target, "utf8"));
} catch (error) {
  console.error(`# ACTUAL60_EVIDENCE_VERIFY_FAIL unreadable receipt: ${error?.message || error}`);
  process.exit(1);
}
const result = validateClosureReceipt(receipt, { currentSource: true });
if (!receipt.completeClosureRun) result.errors.push("completeClosureRun must be true");
if (!receipt.closureEvidenceValid) result.errors.push("closureEvidenceValid must be true");
if (result.errors.length) {
  console.error(`# ACTUAL60_EVIDENCE_VERIFY_FAIL ${result.errors.join("; ")}`);
  process.exit(1);
}
console.log(`# ACTUAL60_EVIDENCE_VERIFY_PASS runId=${receipt.runId} startedAt=${receipt.startedAt} finishedAt=${receipt.finishedAt} gates=${receipt.gates.length}`);

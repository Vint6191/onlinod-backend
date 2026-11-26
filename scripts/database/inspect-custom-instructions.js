"use strict";
// Historical provider facts are never expanded into new sends. This bounded,
// read-only inventory gives an operator exact identities for manual review.
const crypto = require("node:crypto");
const { taskText } = require("../../src/services/custom-order-reminders");

async function inspectLegacyInstructions({ db, agencyId, after = "", targetAt = new Date(), limit = 100 }) {
  if (!agencyId || !Number.isFinite(new Date(targetAt).getTime())) throw Error("agency and target-at are required");
  const take = Math.max(1, Math.min(200, Math.floor(Number(limit) || 100)));
  const rows = await db.telegramDeliveryIntent.findMany({ where: { agencyId: String(agencyId), id: { gt: after },
    kind: { in: ["TASK", "REVISION_REQUEST"] }, state: "CONFIRMED", createdAt: { lte: new Date(targetAt) } }, orderBy: { id: "asc" }, take });
  const items = [];
  for (const row of rows) {
    if (row.instructionManifest) continue;
    const text = String(row.payload?.text || "");
    let expected = null, reason = null;
    if (row.kind === "TASK" && text.length === 4096) {
      const order = await db.customOrder.findFirst({ where: { agencyId, id: row.customOrderId, creatorId: row.creatorId } });
      if (!order) { reason = "LEGACY_INSTRUCTION_ORDER_MISSING"; }
      else {
        expected = taskText(order);
        if (expected.length > text.length) reason = expected.startsWith(text) ? "LEGACY_TASK_TRUNCATED" : "LEGACY_TASK_TEXT_CHANGED_REVIEW_REQUIRED";
      }
    }
    if (row.kind === "REVISION_REQUEST" && row.payload?.reviewComment && !text.includes(String(row.payload.reviewComment))) {
      reason = "LEGACY_REVISION_COMMENT_TRUNCATED"; expected = String(row.payload.reviewComment);
    }
    if (reason) items.push({ intentId: row.id, orderId: row.customOrderId, creatorId: row.creatorId, kind: row.kind,
      decision: "MANUAL_REVIEW", reason, providerMessageId: row.remoteMessageId, accountId: row.accountId,
      expectedHash: crypto.createHash("sha256").update(JSON.stringify([row.id, row.updatedAt, row.payloadFingerprint, row.remoteMessageId])).digest("hex"),
      deliveredTextUnits: text.length, expectedTextUnits: expected?.length || null,
      acceptedTextHash: expected ? crypto.createHash("sha256").update(expected).digest("hex") : null });
  }
  return { policyVersion: 1, mode: "DRY_RUN_ONLY", scope: { agencyId }, targetAt: new Date(targetAt).toISOString(),
    after, nextCursor: rows.at(-1)?.id || after, scanComplete: rows.length < take, scanned: rows.length, manualReview: items.length, items };
}

if (require.main === module) {
  const args = process.argv.slice(2), get = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  if (args.includes("--apply")) throw Error("Historical instructions require explicit review; this tool never sends or expands them");
  const db = require("../../src/prisma");
  inspectLegacyInstructions({ db, agencyId: get("--agency"), after: get("--after"), targetAt: get("--target-at") || new Date(), limit: get("--limit") })
    .then(result => process.stdout.write(JSON.stringify(result, null, 2) + "\n"))
    .catch(error => { process.stderr.write(`${error.code || "LEGACY_INSTRUCTION_INSPECTION_FAILED"}: ${error.message}\n`); process.exitCode = 1; })
    .finally(() => db.$disconnect());
}
module.exports = { inspectLegacyInstructions };

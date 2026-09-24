"use strict";

// Prisma contains uses PostgreSQL LIKE: an opaque underscore must stay literal.
function literalPageContains(scanRunId, suffix = "") {
  return `:run:${scanRunId}:page:${suffix}`.replace(/[\\%_]/g, value => `\\${value}`);
}

// Completion checks receipts of the exact collected run, never retained facts.
// PostgreSQL computes the count/sum; full history is not materialized in Node.
async function notificationCommittedPageProof(db, job, result) {
  const scanRunId = String(result?.scanRunId || "").trim();
  const expectedRows = Number(result?.totalAcceptedEvents);
  if (!/^[A-Za-z0-9._-]{8,80}$/.test(scanRunId) || !Number.isSafeInteger(expectedRows) || expectedRows < 0) {
    return { verified: false, reason: "completion_fact_count_missing" };
  }
  const where = { agencyId: job.agencyId, creatorId: job.creatorId, sourceJobId: job.id,
    dataType: "NOTIFICATIONS", idempotencyKey: { contains: literalPageContains(scanRunId) } };
  const model = db?.analyticsIngestBatch;
  let receivedRows, batches, receiptsClean;
  if (typeof model?.aggregate === "function") {
    const counts = await model.aggregate({ where, _sum: { receivedRows: true }, _count: { _all: true } });
    receivedRows = Number(counts._sum.receivedRows || 0); batches = counts._count._all;
    const failed = await model.findFirst({ where: { ...where,
      OR: [{ status: { not: "COMMITTED" } }, { rejectedRows: { gt: 0 } }] }, select: { id: true } });
    receiptsClean = !failed;
  } else if (typeof model?.findMany === "function") {
    // Bounded unit adapter. Production Prisma always uses aggregate above.
    const rows = await model.findMany({ where, take: 1000,
      select: { idempotencyKey: true, status: true, receivedRows: true, rejectedRows: true } });
    if (rows.length >= 1000) return { verified: false, reason: "receipt_adapter_capacity" };
    const current = rows.filter(row => String(row.idempotencyKey || "").includes(`:run:${scanRunId}:page:`));
    receivedRows = current.reduce((sum, row) => sum + Number(row.receivedRows || 0), 0);
    batches = current.length;
    receiptsClean = current.every(row => row.status === "COMMITTED" && Number(row.rejectedRows || 0) === 0);
  } else {
    throw Object.assign(new Error("Canonical notification page receipts are required"), { code: "NOTIFICATION_PAGE_RECEIPTS_REQUIRED" });
  }
  return { verified: receiptsClean && receivedRows === expectedRows,
    reason: !receiptsClean ? "backend_page_receipt_partial" : receivedRows !== expectedRows ? "backend_page_receipt_count_mismatch" : "verified",
    expectedRows, receivedRows, batches };
}
module.exports = { notificationCommittedPageProof, literalPageContains };

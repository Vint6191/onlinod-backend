"use strict";
const authority = require("./financial-receipt-authority");
function cursorError() { return Object.assign(new Error("FINANCIAL_CURSOR_INVALID"), { code: "FINANCIAL_CURSOR_INVALID", status: 400 }); }
function decode(cursor) {
  if (!cursor) return null;
  if (typeof cursor !== "string" || cursor.length > 800) throw cursorError();
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof value.run !== "string" || !/^[a-f0-9]{64}$/.test(value.run) || typeof value.after !== "string" || value.after.length > 220) throw cursorError();
    return value;
  } catch { throw cursorError(); }
}
async function read({ db, job, creator, limit, cursor }) {
  const position = decode(cursor);
  if (!job || !authority.enabled(job)) return { run: null, items: [], nextCursor: null, hasMore: false, bounds: null, detailsExpired: false };
  const run = await db.financialReceiptRun.findUnique({ where: { id: authority.runId(job) } });
  if (!run) return { run: null, items: [], nextCursor: null, hasMore: false, bounds: null, detailsExpired: false };
  if (run.agencyId !== creator.agencyId || run.creatorId !== creator.id || run.jobId !== job.id || run.generation !== job.params.collectionGeneration) throw new authority.FinancialReceiptError("FINANCIAL_RECEIPT_READ_SCOPE_INVALID");
  if (run.detailsRetiredAt || run.compactedAt) return { run, items: [], nextCursor: null, hasMore: false, bounds: null, detailsExpired: true };
  const where = { runId: run.id, windowIndex: 0 };
  const after = position?.run === run.id ? position.after : null;
  const [rows, first, last] = await Promise.all([
    db.financialObservedFact.findMany({ where: { ...where, ...(after ? { externalId: { gt: after } } : {}) }, orderBy: { externalId: "asc" }, take: limit + 1 }),
    db.financialObservedFact.findFirst({ where, orderBy: [{ occurredAt: "asc" }, { externalId: "asc" }], select: { occurredAt: true } }),
    db.financialObservedFact.findFirst({ where, orderBy: [{ occurredAt: "desc" }, { externalId: "desc" }], select: { occurredAt: true } }),
  ]);
  const page = rows.slice(0, limit), hasMore = rows.length > limit;
  return { run, items: page.map(row => ({ ...row.value, id: `${run.id}:${row.externalId}` })),
    nextCursor: hasMore ? Buffer.from(JSON.stringify({ run: run.id, after: page.at(-1).externalId })).toString("base64url") : null,
    hasMore, bounds: { _min: { occurredAt: first?.occurredAt }, _max: { occurredAt: last?.occurredAt } }, detailsExpired: false };
}
module.exports = { read, decode };

"use strict";
const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { dbAuthorityNow } = require("./db-time-authority-service");
const DAY = 86400000;
const FLOOR = new Date("2016-01-01T00:00:00Z");
const RECENT_DAYS = 7, AUDIT_DAYS = 30, HISTORY_FRESH_MS = 7 * DAY;
const COLLECTOR = "payout-transactions-v3-window-receipts";
const FULL_CHARTS = ["total", "subscribes", "tips", "messages", "post", "stream"];
class FinancialReceiptError extends Error {
  constructor(code) { super(code); this.code = code; this.status = 409; }
}
function fault(code) { return new FinancialReceiptError(code); }
function enabled(job) { return job?.jobKey === "financial_transactions_scan" && job.params?.financialReceiptVersion === 1; }
function date(value) {
  if (!value) return null;
  const raw = typeof value === "string" && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? value.replace(" ", "T") + "Z" : value;
  const result = new Date(raw); return Number.isFinite(+result) ? result : null;
}
function integer(value, max = 1000000000) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw fault("FINANCIAL_RECEIPT_COUNTER_INVALID");
  return value;
}
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
}
function hash(value) { return createHash("sha256").update(canonical(value)).digest("hex"); }
function runId(job) { return hash([job.id, job.params.collectionGeneration]); }
async function enter(db) { await db.$executeRawUnsafe("SELECT set_config('onlinod.financial_receipts_v1','1',true)"); }
function window(kind, from, to) {
  return { kind, from: from.toISOString(), to: to.toISOString(), initialMarker: String(Math.floor(+to / 1000)) };
}
function planWindows(params, state) {
  const end = date(params.endDate) || date(params.collectionRequestedAt);
  if (!end || end < FLOOR) throw fault("FINANCIAL_WINDOW_END_INVALID");
  const mode = params.collectionMode || params.financialMode;
  if (mode !== "catchup") return [window("FULL", date(params.startDate) || FLOOR, end)];
  const headFrom = new Date(Math.max(+FLOOR, +end - RECENT_DAYS * DAY));
  const result = [window("HEAD", headFrom, end)];
  const frontier = date(state?.coverageThrough) || date(state?.baselineRangeTo) || FLOOR;
  if (frontier < headFrom) {
    result.push(window("GAP", new Date(Math.max(+FLOOR, +frontier)), new Date(Math.min(+headFrom, +frontier + AUDIT_DAYS * DAY))));
  } else if (headFrom > FLOOR) {
    const candidate = date(state?.historyAuditCursor) || FLOOR;
    const from = candidate < headFrom && candidate >= FLOOR ? candidate : FLOOR;
    result.push(window("AUDIT", from, new Date(Math.min(+headFrom, +from + AUDIT_DAYS * DAY))));
  }
  return result;
}
function windowsFor(job) {
  const windows = job.params?.financialWindows;
  if (!enabled(job) || job.params.financialWindowGeneration !== job.params.collectionGeneration || !Array.isArray(windows) || !windows.length || windows.length > 2) throw fault("FINANCIAL_WINDOWS_REQUIRED");
  for (const w of windows) if (!["FULL", "HEAD", "GAP", "AUDIT"].includes(w.kind) || !date(w.from) || !date(w.to) || date(w.from) > date(w.to) || String(w.initialMarker) !== String(Math.floor(+date(w.to) / 1000))) throw fault("FINANCIAL_WINDOW_INVALID");
  const head = windows[0], catchup = (job.params.collectionMode || job.params.financialMode) === "catchup";
  if (head.to !== date(job.params.endDate)?.toISOString() || date(head.from) < FLOOR) throw fault("FINANCIAL_WINDOW_BINDING_INVALID");
  if (catchup) {
    if (head.kind !== "HEAD" || +date(head.to) - date(head.from) > RECENT_DAYS * DAY) throw fault("FINANCIAL_HEAD_WINDOW_INVALID");
    if (windows[1] && (!["GAP", "AUDIT"].includes(windows[1].kind) || +date(windows[1].to) - date(windows[1].from) > AUDIT_DAYS * DAY || date(windows[1].to) > date(head.from))) throw fault("FINANCIAL_HISTORY_WINDOW_INVALID");
  } else if (windows.length !== 1 || head.kind !== "FULL") throw fault("FINANCIAL_FULL_WINDOW_INVALID");
  return windows;
}
async function claimParams(db, job) {
  if (enabled(job) && job.params.financialWindowGeneration === job.params.collectionGeneration) { windowsFor(job); return job.params; }
  const state = await db.creatorFinancialCollectionState.findUnique({ where: { creatorId: job.creatorId } });
  const params = { ...job.params, financialReceiptVersion: 1, collectorVersion: COLLECTOR };
  delete params.knownTransactionIds; delete params.catchupMaxPages;
  params.financialWindows = planWindows(params, state);
  params.financialWindowGeneration = params.collectionGeneration;
  return params;
}
function initialCursor(job, windows = windowsFor(job)) {
  return { financialReceiptVersion: 1, collectorVersion: COLLECTOR, scanRunId: job.params.collectionGeneration,
    windowIndex: 0, phase: "transactions", page: 0, marker: windows[0].initialMarker, chartIndex: 0, processed: 0, scannerRejected: 0 };
}
function resultFor(job, cursor) {
  return { schemaVersion: 1, collectorVersion: COLLECTOR, financialReceiptVersion: 1,
    scanRunId: job.params.collectionGeneration, sourceBoundaryReached: cursor.phase === "done",
    scannerRejected: cursor.scannerRejected, processed: cursor.processed };
}
function envelope(job, cursor) {
  return cursor.phase === "done" ? { driverPhase: "complete", result: resultFor(job, cursor), progress: { percent: 100, message: "Financial windows collected" } }
    : { driverPhase: "execute", jobContinuation: cursor };
}
function expectedMatches(job, expected) { return expected !== undefined && isDeepStrictEqual(job.continuation ?? null, expected ?? null); }
async function restoreContinuation(db, job) {
  const row = await db.financialReceiptRun.findUnique({ where: { id: runId(job) } });
  return envelope(job, row?.cursor || initialCursor(job));
}
function emptyTotals() { return { count: 0, storedOnly: 0, grossCents: 0, netCents: 0, feeCents: 0, statusGroups: {}, typeGroups: {} }; }
function sum(a, b) { const n = (a || 0) + (b || 0); if (!Number.isSafeInteger(n)) throw fault("FINANCIAL_RECEIPT_AMOUNT_OVERFLOW"); return n; }
function addFact(totals, value, sign) {
  totals.count += sign;
  if (value.projectionStatus === "STORED_ONLY") totals.storedOnly += sign;
  for (const [key, field] of [["grossCents", "amountCents"], ["netCents", "netCents"], ["feeCents", "feeCents"]]) totals[key] = sum(totals[key], sign * (value[field] || 0));
  const status = String(value.transactionStatus || "").trim().toLowerCase();
  const key = ["done", "loading", "undo", ""].includes(status) ? status : "other";
  const group = totals.statusGroups[key] || { transactionStatus: key, _count: { _all: 0 }, _sum: { amountCents: 0, netCents: 0, feeCents: 0 } };
  group._count._all += sign;
  for (const field of ["amountCents", "netCents", "feeCents"]) group._sum[field] = sum(group._sum[field], sign * (value[field] || 0));
  totals.statusGroups[key] = group;
  const type = ["message", "post", "stream"].includes(value.transactionType) ? value.transactionType
    : value.factType === "TIP" ? "tip" : value.factType === "PAID_SUBSCRIPTION" ? "subscription" : "other";
  const identity = JSON.stringify([type, value.factType, value.projectionStatus, value.reasonCode]);
  totals.typeGroups ||= {};
  const typed = totals.typeGroups[identity] || { transactionType: type, factType: value.factType,
    projectionStatus: value.projectionStatus, reasonCode: value.reasonCode, count: 0, grossCents: 0, netCents: 0 };
  typed.count += sign; typed.grossCents = sum(typed.grossCents, sign * value.amountCents); typed.netCents = sum(typed.netCents, sign * (value.netCents || 0));
  if (typed.count) totals.typeGroups[identity] = typed; else delete totals.typeGroups[identity];
}
async function lockedRun(db, job) {
  await enter(db);
  const id = runId(job), windows = windowsFor(job);
  await db.financialReceiptRun.upsert({ where: { id }, create: { id, jobId: job.id, agencyId: job.agencyId, creatorId: job.creatorId,
    generation: job.params.collectionGeneration, windows, cursor: initialCursor(job, windows),
    proof: { complete: false, windows: windows.map(() => ({ ...emptyTotals(), pages: 0, received: 0, rejected: 0, exhausted: false, charts: {} })) } }, update: {} });
  await db.$queryRawUnsafe('SELECT id FROM "FinancialReceiptRun" WHERE id=$1 FOR UPDATE', id);
  const row = await db.financialReceiptRun.findUnique({ where: { id } });
  if (row.agencyId !== job.agencyId || row.creatorId !== job.creatorId || !isDeepStrictEqual(row.windows, windows)) throw fault("FINANCIAL_RECEIPT_SCOPE_MISMATCH");
  return row;
}
async function beforePage(db, job, chunk) {
  const row = await lockedRun(db, job), state = row.cursor, checksum = hash(chunk);
  if (chunk.collectorVersion !== COLLECTOR || chunk.scanRunId !== row.generation) throw fault("FINANCIAL_RECEIPT_PROTOCOL_INVALID");
  const windowIndex = integer(chunk.windowIndex, row.windows.length - 1), page = integer(chunk.pageNumber);
  const existing = await db.financialPageReceipt.findUnique({ where: { runId_windowIndex_page: { runId: row.id, windowIndex, page } } });
  if (existing) {
    if (existing.payloadHash !== checksum) throw fault("FINANCIAL_RECEIPT_PAYLOAD_CONFLICT");
    return { row, replay: true, checksum, financialContinuation: envelope(job, state) };
  }
  if (state.phase !== "transactions" || state.windowIndex !== windowIndex || state.page + 1 !== page || chunk.markerStart !== state.marker) throw fault("FINANCIAL_RECEIPT_CURSOR_MISMATCH");
  integer(chunk.rawReceived, 100); integer(chunk.scannerRejected, 100); integer(chunk.duplicateRows, 100);
  if (!Array.isArray(chunk.transactions) || chunk.rawReceived !== chunk.transactions.length + chunk.scannerRejected + chunk.duplicateRows || typeof chunk.sourceHasMore !== "boolean") throw fault("FINANCIAL_RECEIPT_PAGE_INVALID");
  if (chunk.sourceHasMore && (typeof chunk.markerEnd !== "string" || !chunk.markerEnd || chunk.markerEnd.length > 220 || chunk.markerEnd === chunk.markerStart || chunk.rawReceived === 0)) throw fault("FINANCIAL_RECEIPT_CURSOR_STALLED");
  if (chunk.sourceHasMore && await db.financialPageReceipt.findFirst({ where: { runId: row.id, windowIndex, markerStart: chunk.markerEnd }, select: { page: true } })) throw fault("FINANCIAL_RECEIPT_CURSOR_CYCLE");
  return { row, checksum, replay: false };
}
function withinWindow(job, chunk, row) {
  const w = windowsFor(job)[chunk.windowIndex];
  return w && row.occurredAt >= date(w.from) && row.occurredAt <= date(w.to);
}
async function commitPage(db, job, chunk, prepared, accepted, backendRejected) {
  const { row, checksum } = prepared, index = chunk.windowIndex, proof = row.proof, totals = proof.windows[index];
  const previous = accepted.length ? await db.financialObservedFact.findMany({ where: { runId: row.id, windowIndex: index, externalId: { in: accepted.map(x => x.externalTransactionId) } } }) : [];
  const byId = new Map(previous.map(x => [x.externalId, x.value]));
  const records = [];
  for (const fact of accepted) {
    const value = { externalTransactionId: fact.externalTransactionId, occurredAt: fact.occurredAt.toISOString(),
      transactionType: fact.transactionType, factType: fact.factType, projectionStatus: fact.projectionStatus,
      fanOnlyFansUserId: fact.fanOnlyFansUserId, currency: fact.currency, reasonCode: fact.reasonCode,
      amountCents: fact.amountCents, netCents: fact.netCents, feeCents: fact.feeCents, transactionStatus: fact.transactionStatus,
      page: fact.page, ordinal: fact.ordinal };
    if (byId.has(fact.externalTransactionId)) addFact(totals, byId.get(fact.externalTransactionId), -1);
    addFact(totals, value, 1);
    byId.set(fact.externalTransactionId, value);
    records.push({ externalId: fact.externalTransactionId, occurredAt: fact.occurredAt.toISOString(), value });
  }
  if (records.length) await db.$executeRawUnsafe(`INSERT INTO "FinancialObservedFact"("runId","windowIndex","externalId","occurredAt",value)
    SELECT $1,$2,r."externalId",r."occurredAt",r.value FROM jsonb_to_recordset($3::jsonb) r("externalId" text,"occurredAt" timestamp,value jsonb)
    ON CONFLICT("runId","windowIndex","externalId") DO UPDATE SET "occurredAt"=EXCLUDED."occurredAt",value=EXCLUDED.value`, row.id, index, JSON.stringify(records));
  const rejected = chunk.scannerRejected + backendRejected;
  totals.pages++; totals.received += chunk.rawReceived; totals.rejected += rejected; totals.exhausted = !chunk.sourceHasMore;
  await db.financialPageReceipt.create({ data: { runId: row.id, windowIndex: index, page: chunk.pageNumber, markerStart: chunk.markerStart,
    markerEnd: chunk.markerEnd || null, sourceHasMore: chunk.sourceHasMore, payloadHash: checksum, received: chunk.rawReceived, rejected } });
  const cursor = { ...row.cursor, page: chunk.pageNumber, marker: chunk.sourceHasMore ? chunk.markerEnd : row.cursor.marker,
    phase: chunk.sourceHasMore ? "transactions" : "charts", chartIndex: 0, processed: row.cursor.processed + chunk.rawReceived, scannerRejected: row.cursor.scannerRejected + rejected };
  const receivedAt = await dbAuthorityNow({ db });
  await db.financialReceiptRun.update({ where: { id: row.id }, data: { cursor, proof, updatedAt: receivedAt } });
  return envelope(job, cursor);
}
async function commitChart(db, job, chunk) {
  const row = await lockedRun(db, job), index = integer(chunk.windowIndex, row.windows.length - 1), state = row.cursor, w = row.windows[index];
  const categories = w.kind === "FULL" ? FULL_CHARTS : ["total"];
  const previous = row.proof.windows[index].charts[chunk.category];
  const summary = { grossCents: chunk.grossCents, netCents: chunk.netCents, transactionsCount: chunk.transactionsCount };
  if (chunk.collectorVersion !== COLLECTOR || chunk.scanRunId !== row.generation || date(chunk.rangeFrom)?.toISOString() !== w.from || date(chunk.rangeTo)?.toISOString() !== w.to) throw fault("FINANCIAL_CHART_SCOPE_MISMATCH");
  if (!Number.isSafeInteger(summary.grossCents) || !Number.isSafeInteger(summary.netCents)) throw fault("FINANCIAL_CHART_AMOUNT_INVALID");
  integer(summary.transactionsCount);
  if (previous) {
    if (!isDeepStrictEqual(previous, summary)) throw fault("FINANCIAL_CHART_RECEIPT_CONFLICT");
    return { replay: true, financialContinuation: envelope(job, state) };
  }
  if (state.windowIndex !== index || state.phase !== "charts" || categories[state.chartIndex] !== chunk.category) throw fault("FINANCIAL_CHART_CURSOR_MISMATCH");
  const proof = row.proof, totals = proof.windows[index]; totals.charts[chunk.category] = summary;
  const cursor = { ...state, chartIndex: state.chartIndex + 1 };
  if (cursor.chartIndex === categories.length) {
    const chart = totals.charts.total, undo = totals.statusGroups.undo;
    totals.matched = totals.count - (undo?._count._all || 0) === chart.transactionsCount
      && totals.grossCents - (undo?._sum.amountCents || 0) === chart.grossCents && totals.netCents - (undo?._sum.netCents || 0) === chart.netCents;
    cursor.windowIndex++;
    if (cursor.windowIndex < row.windows.length) Object.assign(cursor, { phase: "transactions", marker: row.windows[cursor.windowIndex].initialMarker, page: 0, chartIndex: 0 });
    else { cursor.phase = "done"; proof.complete = proof.windows.every(p => p.exhausted && p.matched && p.rejected === 0); }
  }
  const receivedAt = await dbAuthorityNow({ db });
  await db.financialReceiptRun.update({ where: { id: row.id }, data: { cursor, proof, updatedAt: receivedAt } });
  return { replay: false, financialContinuation: envelope(job, cursor) };
}
async function completionProof(db, job) {
  if (!enabled(job)) return { complete: false, protocolCurrent: false };
  const row = await db.financialReceiptRun.findUnique({ where: { id: runId(job) } });
  if (!row || row.generation !== job.params.collectionGeneration || row.jobId !== job.id || row.agencyId !== job.agencyId || row.creatorId !== job.creatorId) return { complete: false, protocolCurrent: true };
  return { complete: row.cursor.phase === "done" && row.proof.complete === true, protocolCurrent: true, row };
}
function coverageUpdate(job, current, row, observedAt, now) {
  const head = row.windows[0];
  const common = { receiptCoverageVersion: 1, recentRangeFrom: date(head.from), recentRangeTo: date(head.to) };
  if (head.kind === "FULL") return { ...common, coverageThrough: date(head.to), historyAuditCursor: FLOOR,
    historyAuditCycleStartedAt: null, historyAuditObservedAt: observedAt, historyAuditCompletedAt: now };
  const frontier = date(current?.coverageThrough) || date(current?.baselineRangeTo) || FLOOR;
  const extra = row.windows[1];
  if (frontier >= date(head.from)) common.coverageThrough = date(head.to);
  else if (extra?.kind === "GAP" && date(extra.from) <= frontier) common.coverageThrough = date(extra.to) >= date(head.from) ? date(head.to) : date(extra.to);
  if (extra?.kind === "AUDIT") {
    const began = date(current?.historyAuditCycleStartedAt) || observedAt;
    if (date(extra.to) >= date(head.from)) Object.assign(common, { historyAuditCursor: FLOOR, historyAuditCycleStartedAt: null, historyAuditObservedAt: began, historyAuditCompletedAt: now });
    else Object.assign(common, { historyAuditCursor: date(extra.to), historyAuditCycleStartedAt: began });
  }
  return common;
}
function coverageView(state, now = new Date()) {
  const head = date(state?.recentRangeTo), through = date(state?.coverageThrough), historical = date(state?.historyAuditObservedAt);
  return { version: state?.receiptCoverageVersion || 0, recentFromAt: date(state?.recentRangeFrom), recentToAt: head,
    coverageThroughAt: through, continuous: Boolean(head && through && through >= head),
    historyObservedAt: historical, historyFresh: Boolean(historical && historical <= now && +now - historical <= HISTORY_FRESH_MS),
    historyNextFromAt: date(state?.historyAuditCursor), recentDays: RECENT_DAYS, auditWindowDays: AUDIT_DAYS };
}
function evaluateCollection(state, now, freshnessMs) {
  const base = require("./analytics-state-evaluator").evaluateDurableCollectorState({
    status: state?.status, baselineCompletedAt: state?.baselineVerifiedAt, baselineVerifiedAt: state?.baselineVerifiedAt,
    lastVerifiedAt: state?.receiptCoverageVersion === 1 ? state?.lastCatchupCompletedAt : null,
    baselineObservedAt: state?.baselineObservedAt, lastObservedAt: state?.receiptCoverageVersion === 1 ? state?.lastCatchupObservedAt : null,
    retryAfterAt: state?.retryAfterAt, now, freshnessMs,
  });
  const coverage = coverageView(state, now);
  if (coverage.continuous && coverage.historyFresh) return base;
  const deferred = Boolean(base.retryAfterAt && base.retryAfterAt > now);
  return Object.freeze({ ...base, fresh: false, stale: base.proven, deferred, due: !deferred && !base.failed });
}
module.exports = { FinancialReceiptError, COLLECTOR, FULL_CHARTS, RECENT_DAYS, AUDIT_DAYS, HISTORY_FRESH_MS, enabled, enter, date, hash, runId,
  planWindows, windowsFor, claimParams, initialCursor, envelope, resultFor, expectedMatches, restoreContinuation,
  beforePage, withinWindow, commitPage, commitChart, completionProof, coverageUpdate, coverageView, evaluateCollection };

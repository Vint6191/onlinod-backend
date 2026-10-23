"use strict";

// Overview and Home read the same active generation. Raw payout observations
// are retained for diagnostics and verification, never mixed with an older
// successful baseline. Range cost is days × fixed category/status vocabulary.
function integer(value) {
  const result = Number(value ?? 0);
  if (!Number.isSafeInteger(result)) throw new Error("FINANCIAL_DISPLAY_AMOUNT_OVERFLOW");
  return result;
}
function add(a, b) { return integer(a + integer(b)); }
function summarize(rows) {
  const out = { grossCents: 0, netCents: 0, transactions: 0, refundGrossCents: 0,
    refundNetCents: 0, refundTransactions: 0, payoutPendingNetCents: 0, payoutPendingTransactions: 0, types: [] };
  const types = new Map();
  let grossKnown = 0, refundGrossKnown = 0;
  for (const row of rows) {
    const m = row.metrics || {}, key = row.category;
    const count = add(integer(m.done_count), m.loading_count);
    const net = integer(row.netCents);
    const gross = add(integer(m.done_gross), m.loading_gross);
    const known = add(integer(m.done_grossKnown), m.loading_grossKnown);
    out.transactions = add(out.transactions, count); out.netCents = add(out.netCents, net);
    out.grossCents = add(out.grossCents, gross); grossKnown = add(grossKnown, known);
    out.refundTransactions = add(out.refundTransactions, m.undo_count);
    out.refundNetCents = add(out.refundNetCents, m.undo_net);
    out.refundGrossCents = add(out.refundGrossCents, m.undo_gross);
    refundGrossKnown = add(refundGrossKnown, m.undo_grossKnown);
    out.payoutPendingTransactions = add(out.payoutPendingTransactions, m.loading_count);
    out.payoutPendingNetCents = add(out.payoutPendingNetCents, m.loading_net);
    const type = types.get(key) || { key, grossCents: 0, netCents: 0, transactions: 0, grossKnown: 0 };
    type.grossCents = add(type.grossCents, gross); type.netCents = add(type.netCents, net);
    type.transactions = add(type.transactions, count); type.grossKnown = add(type.grossKnown, known);
    types.set(key, type);
  }
  if (grossKnown !== out.transactions) out.grossCents = null;
  if (refundGrossKnown !== out.refundTransactions) out.refundGrossCents = null;
  out.types = [...types.values()].filter(row => row.transactions || row.netCents).map(({ grossKnown: known, ...row }) => ({
    ...row, grossCents: known === row.transactions ? row.grossCents : null,
  })).sort((a, b) => b.netCents - a.netCents || a.key.localeCompare(b.key));
  return out;
}

async function readPublishedFinancialSummary({ db, creatorId, from, to }) {
  const start = new Date(from), end = new Date(to);
  start.setUTCHours(0, 0, 0, 0); end.setUTCHours(0, 0, 0, 0);
  if (!Number.isFinite(+start) || !Number.isFinite(+end) || end < start || end - start > 366 * 86400000)
    throw new Error("FINANCIAL_DISPLAY_RANGE_INVALID");
  const [row] = await db.$queryRawUnsafe(`WITH authority AS MATERIALIZED (
      SELECT p.* FROM "CreatorAccount" c JOIN "CreatorEarningsLedgerProof" p ON p."creatorId"=c.id AND p."agencyId"=c."agencyId"
      WHERE c.id=$1 AND c."deletedAt" IS NULL
    ), metric_rows AS (
      SELECT d.category,d."netCents",d."financialMetrics" AS metrics FROM authority p
        JOIN "CreatorEarningsGenerationDay" d ON d.generation=p."activeGeneration"
        WHERE d.date BETWEEN $2::date AND $3::date
      UNION ALL
      SELECT d.category,d."netCents",d."financialMetrics" FROM authority p
        JOIN "CreatorEarningsLedgerHour" d ON d."creatorId"=p."creatorId" AND d."agencyId"=p."agencyId"
        WHERE p."activeGeneration" IS NULL AND d.hour >= $2 AND d.hour < $3::timestamp+interval '1 day'
    ) SELECT p."fromAt",p."throughAt",p.generation,p."activeGeneration",
      COALESCE((SELECT jsonb_agg(jsonb_build_object('category',category,'netCents',"netCents",'metrics',metrics)) FROM metric_rows),'[]') AS rows
      FROM authority p`, creatorId, start, end);
  return { ready: Boolean(row), state: row ? "READY" : "REBUILDING", generation: row?.activeGeneration || row?.generation || null,
    fromAt: row?.fromAt?.toISOString() || null, throughAt: row?.throughAt?.toISOString() || null,
    finance: row ? summarize(row.rows) : { grossCents: null, netCents: null, transactions: null, refundGrossCents: null,
      refundNetCents: null, refundTransactions: null, payoutPendingNetCents: null, payoutPendingTransactions: null, types: [] } };
}

module.exports = { readPublishedFinancialSummary, summarize };

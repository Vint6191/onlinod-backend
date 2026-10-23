"use strict";
const INACTIVE_FINANCIAL_STATUSES = Object.freeze(["undo", "refunded", "refund", "chargeback", "reversed", "reversal", "unverified", "gross_unknown", "superseded"]);
const inactive = new Set(INACTIVE_FINANCIAL_STATUSES);
function financiallyActive(row) { return !inactive.has(String(row?.financialStatus || "").trim().toLowerCase()); }
function activeFinancialWhere() { return { OR: [{ financialStatus: null }, { financialStatus: { notIn: INACTIVE_FINANCIAL_STATUSES } }] }; }
function teamFinancialStatus(row, fallback) {
  const status = String(row?.transactionStatus || fallback || "").trim().toLowerCase();
  return row?.amountCents == null && !inactive.has(status) ? "gross_unknown" : status || null;
}
async function publishTeamMoneyResult(db, row, kind) {
  // Production owners always have a root commit. Pure domain unit adapters do
  // not implement the SQL reverse feed.
  if (typeof db?.$queryRawUnsafe !== "function" || !row?.creatorId) return;
  const { hashCanonicalJson } = require("./realtime-receipt-hash");
  const fields = ["status","financialStatus","amountCents","currency","attributedMemberId","attributedUserId","attributedShiftKey","attributionBasis","active","memberId","creatorKey","sourceType","day"];
  const state = Object.fromEntries(fields.map(field => [field, typeof row[field] === "bigint" ? row[field].toString() : row[field] ?? null]));
  const dataVersion = hashCanonicalJson(state);
  await require("./creator-entity-change-service").publishEntityChanges({ db, agencyId: row.agencyId, creatorId: row.creatorId,
    changes: [{ entityType: "TEAM", entityId: row.creatorId, sourceIdentity: `team:${kind}:${row.id || row.sourceFactId}`,
      sourceVersion: dataVersion, payload: { dataVersion, reason: kind } }] });
}
module.exports = { INACTIVE_FINANCIAL_STATUSES, financiallyActive, activeFinancialWhere, teamFinancialStatus, publishTeamMoneyResult };

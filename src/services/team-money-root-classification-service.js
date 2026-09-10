"use strict";

const CLASSIFICATION_VERSION = "team_money_root_classification_v1";
const STATE = Object.freeze({ PENDING: "PENDING", CANONICAL: "CANONICAL", AMBIGUOUS: "AMBIGUOUS", INCOMPLETE: "INCOMPLETE" });

function clean(value, max = 240) {
  const text = String(value == null ? "" : value).trim();
  return text ? text.slice(0, max) : null;
}

function businessIdentity(row) {
  const sourceType = String(row?.sourceType || "").toUpperCase();
  if (sourceType === "PPV") {
    const saleId = clean(row?.creatorSaleId, 220);
    if (saleId) return { key: `sale:${saleId}`, selector: { sourceType: "PPV", creatorSaleId: saleId } };
    const financialId = clean(row?.financialTransactionId, 220);
    if (financialId) return { key: `financial:${financialId}`, selector: { sourceType: "PPV", financialTransactionId: financialId } };
  }
  if (sourceType === "TIP") {
    const tipId = clean(row?.creatorTipId, 220);
    if (tipId) return { key: `tip:${tipId}`, selector: { sourceType: "TIP", creatorTipId: tipId } };
  }
  return null;
}

function classifyGroup(rows, key) {
  const items = Array.isArray(rows) ? rows : [];
  if (items.length === 1) return { state: STATE.CANONICAL, reason: null, key };
  if (items.length > 1) return { state: STATE.AMBIGUOUS, reason: `MULTIPLE_FACT_GENERATIONS:${items.length}`, key };
  return { state: STATE.INCOMPLETE, reason: "CANONICAL_BUSINESS_IDENTITY_NOT_FOUND", key: key || null };
}

async function updateClassification(db, ids, result) {
  if (!ids.length) return 0;
  const changed = await db.teamMoneyAttributionFact.updateMany({
    where: { id: { in: ids } },
    data: {
      canonicalBusinessKey: result.key || null,
      classificationState: result.state,
      classificationReason: result.reason || null,
      classificationVersion: CLASSIFICATION_VERSION,
    },
  });
  return Number(changed?.count || 0);
}

async function classifyTeamMoneyRootsBatch({ db = null, agencyId, cursor = null, limit = 100 } = {}) {
  if (!db) db = require("../prisma");
  if (!agencyId) return { ok: false, code: "TEAM_MONEY_CLASSIFICATION_AGENCY_REQUIRED", complete: false, nextCursor: cursor || null };
  const take = Math.max(1, Math.min(100, Math.floor(Number(limit) || 100)));
  const rows = await db.teamMoneyAttributionFact.findMany({
    where: {
      agencyId: String(agencyId),
      classificationVersion: CLASSIFICATION_VERSION,
      classificationState: { in: [STATE.PENDING, STATE.INCOMPLETE, STATE.AMBIGUOUS] },
      ...(cursor ? { id: { gt: String(cursor) } } : {}),
    },
    select: {
      id: true, sourceType: true, rootId: true, sourceRowId: true,
      creatorSaleId: true, financialTransactionId: true, creatorTipId: true,
      classificationState: true,
    },
    orderBy: { id: "asc" },
    take,
  });
  if (!rows.length) return { ok: true, complete: true, nextCursor: cursor || null, scanned: 0, canonical: 0, ambiguous: 0, incomplete: 0 };

  let canonical = 0, ambiguous = 0, incompleteCount = 0, updated = 0;
  for (const row of rows) {
    const identity = businessIdentity(row);
    if (!identity) {
      updated += await updateClassification(db, [String(row.id)], { state: STATE.INCOMPLETE, reason: "CANONICAL_BUSINESS_IDENTITY_MISSING", key: null });
      incompleteCount += 1;
      continue;
    }

    // Bound duplicate discovery per selected historical fact. We only need to know
    // whether another generation exists; every duplicate row is classified when its
    // own stable-id cursor is visited, so no one batch performs an unbounded update.
    const matches = await db.teamMoneyAttributionFact.findMany({
      where: { agencyId: String(agencyId), ...identity.selector },
      select: { id: true },
      orderBy: { id: "asc" },
      take: 2,
    });
    const result = classifyGroup(matches || [], identity.key);
    updated += await updateClassification(db, [String(row.id)], result);
    if (result.state === STATE.CANONICAL) canonical += 1;
    else if (result.state === STATE.AMBIGUOUS) ambiguous += 1;
    else incompleteCount += 1;
  }

  const nextCursor = String(rows[rows.length - 1].id);
  return {
    ok: true,
    complete: rows.length < take,
    nextCursor,
    scanned: rows.length,
    updated,
    canonical,
    ambiguous,
    incomplete: incompleteCount,
    unresolved: ambiguous + incompleteCount,
  };
}

module.exports = { CLASSIFICATION_VERSION, STATE, businessIdentity, classifyGroup, classifyTeamMoneyRootsBatch };

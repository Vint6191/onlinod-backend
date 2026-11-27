"use strict";

const KEY = "financial_correlation_adoption209";

// A frozen, keyset-paged upgrade pass repairs retained facts through the same
// current correlation and Team owners used for new observations.
async function adoptPageInTransaction(db) {
  const [state] = await db.$queryRawUnsafe('SELECT * FROM "MaintenanceLaneState" WHERE key=$1 AND "completedAt" IS NULL FOR UPDATE SKIP LOCKED', KEY);
  if (!state) return null;
  const kind = state.cursor.phase === "TIP" ? "TIP" : "SALE";
  const model = kind === "SALE" ? "creatorSale" : "creatorTip";
  const upper = state.cursor[kind === "SALE" ? "upperSaleId" : "upperTipId"];
  const rows = await db[model].findMany({ where: { id: { gt: state.cursor.afterId || "", lte: upper || "" } }, orderBy: { id: "asc" }, take: 100 });
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.agencyId, row.creatorId]);
    const group = groups.get(key) || []; group.push(row); groups.set(key, group);
  }
  const now = await require("./db-time-authority-service").dbAuthorityNow({ db });
  for (const key of [...groups.keys()].sort()) {
    const facts = groups.get(key), { agencyId, creatorId } = facts[0];
    const life = await require("./agency-lifecycle-barrier-service").lockAgencyLifecycleBarrier({ db, agencyId });
    if (!life.row || life.row.deletedAt) continue;
    await require("./creator-fact-write-authority").lockCreatorFacts(db, agencyId, creatorId);
    const affected = await require("./financial-correlation-service").invalidateNeighborhoods({ db,
      job: { agencyId, creatorId }, rows: facts, kind, now });
    for (const fact of facts) {
      if (fact.financialCorrelation?.state === "AMBIGUOUS" || (kind === "SALE" && fact.saleType !== "MESSAGE")) affected.push(fact.id);
    }
    for (const objectId of new Set(affected)) await require("./domain-work-authority-service").publishDomainWork({
      db, agencyId, creatorId, objectType: kind === "SALE" ? "CreatorSale" : "CreatorTip", objectId,
      workClass: "TEAM_MONEY_RECONCILIATION", partitionKey: creatorId, fallbackNow: now,
    });
  }
  const exhausted = rows.length < 100;
  const complete = exhausted && kind === "TIP";
  await db.maintenanceLaneState.update({ where: { key: KEY }, data: { completedAt: complete ? now : null,
    cursor: { ...state.cursor, phase: exhausted ? "TIP" : kind, afterId: exhausted && kind === "SALE" ? "" : rows.at(-1)?.id || state.cursor.afterId },
  } });
  return { complete, selected: rows.length, phase: kind, repair: KEY };
}

module.exports = { KEY, adoptPageInTransaction };

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { businessIdentity, classifyGroup, classifyTeamMoneyRootsBatch } = require("./team-money-root-classification-service");

function dbFixture(rows) {
  const list = rows.map((row) => ({ classificationVersion: "team_money_root_classification_v1", classificationState: "PENDING", ...row }));
  function matches(row, where = {}) {
    if (where.agencyId && String(row.agencyId) !== String(where.agencyId)) return false;
    if (where.sourceType && String(row.sourceType) !== String(where.sourceType)) return false;
    if (where.creatorSaleId && String(row.creatorSaleId) !== String(where.creatorSaleId)) return false;
    if (where.financialTransactionId && String(row.financialTransactionId) !== String(where.financialTransactionId)) return false;
    if (where.creatorTipId && String(row.creatorTipId) !== String(where.creatorTipId)) return false;
    if (where.id?.gt && String(row.id) <= String(where.id.gt)) return false;
    if (where.classificationVersion && String(row.classificationVersion) !== String(where.classificationVersion)) return false;
    if (where.classificationState?.in && !where.classificationState.in.includes(row.classificationState)) return false;
    if (Array.isArray(where.OR) && !where.OR.some((part) => matches(row, { agencyId: where.agencyId, ...part }))) return false;
    return true;
  }
  return {
    rows: list,
    teamMoneyAttributionFact: {
      findMany: async ({ where = {}, take = 999, orderBy = {} }) => list.filter((row) => matches(row, where)).sort((a,b) => String(a.id).localeCompare(String(b.id))).slice(0,take),
      updateMany: async ({ where, data }) => {
        let count=0; for (const row of list) if (where.id?.in?.includes(row.id)) { Object.assign(row, data); count += 1; }
        return { count };
      },
    },
  };
}

test("business identity uses verified canonical sale/tip links, not arbitrary timestamps", () => {
  assert.deepEqual(businessIdentity({ sourceType: "PPV", creatorSaleId: "sale-1" }), { key: "sale:sale-1", selector: { sourceType: "PPV", creatorSaleId: "sale-1" } });
  assert.deepEqual(businessIdentity({ sourceType: "TIP", creatorTipId: "tip-1" }), { key: "tip:tip-1", selector: { sourceType: "TIP", creatorTipId: "tip-1" } });
  assert.equal(businessIdentity({ sourceType: "PPV", externalId: "weak-only" }), null);
});

test("duplicate fact generations for one canonical business identity are quarantined, never arbitrarily summed", async () => {
  const db = dbFixture([
    { id: "f1", agencyId: "a1", sourceType: "PPV", sourceRowId: "root-old", rootId: "root-old", creatorSaleId: "sale-1" },
    { id: "f2", agencyId: "a1", sourceType: "PPV", sourceRowId: "root-new", rootId: "root-new", creatorSaleId: "sale-1" },
  ]);
  const result = await classifyTeamMoneyRootsBatch({ db, agencyId: "a1", limit: 100 });
  assert.equal(result.ambiguous, 2);
  assert.equal(result.canonical, 0);
  assert.deepEqual(db.rows.map((row) => row.classificationState), ["AMBIGUOUS", "AMBIGUOUS"]);
  assert.ok(db.rows.every((row) => row.canonicalBusinessKey === "sale:sale-1"));
});

test("single verified root becomes canonical while unverified historical shape stays incomplete", async () => {
  const db = dbFixture([
    { id: "f1", agencyId: "a1", sourceType: "TIP", sourceRowId: "tip-root", rootId: "tip-root", creatorTipId: "tip-1" },
    { id: "f2", agencyId: "a1", sourceType: "PPV", sourceRowId: "legacy-root", rootId: "legacy-root", externalId: "purchase-only" },
  ]);
  const result = await classifyTeamMoneyRootsBatch({ db, agencyId: "a1", limit: 100 });
  assert.equal(result.canonical, 1);
  assert.equal(result.incomplete, 1);
  assert.equal(db.rows.find((row) => row.id === "f1").classificationState, "CANONICAL");
  assert.equal(db.rows.find((row) => row.id === "f2").classificationState, "INCOMPLETE");
});

test("classifyGroup never picks a latest winner from multiple roots", () => {
  assert.equal(classifyGroup([{ id: "old" }, { id: "new" }], "sale:x").state, "AMBIGUOUS");
});

test("classification remains bounded and every duplicate row is quarantined across cursor batches", async () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({
    id: `f${index + 1}`, agencyId: "a1", sourceType: "PPV", sourceRowId: `root-${index + 1}`, rootId: `root-${index + 1}`, creatorSaleId: "sale-many",
  }));
  const db = dbFixture(rows);
  let cursor = null;
  let totalAmbiguous = 0;
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const result = await classifyTeamMoneyRootsBatch({ db, agencyId: "a1", cursor, limit: 1 });
    totalAmbiguous += result.ambiguous;
    cursor = result.nextCursor;
  }
  assert.equal(totalAmbiguous, 5);
  assert.ok(db.rows.every((row) => row.classificationState === "AMBIGUOUS"));
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const prismaPath = require.resolve("../prisma");
const tipPath = require.resolve("./team-tip-ledger-service");

function source(rel) { return fs.readFileSync(path.join(ROOT, rel), "utf8"); }
function loadWithPrisma(modulePath, fake) {
  delete require.cache[modulePath];
  delete require.cache[prismaPath];
  require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: fake };
  return require(modulePath);
}

function migratedRow({ id = "tip-1", legacyState = "manager", owner = "member-B", history = [], resultExtra = {}, resolvedSource = "legacy_money_attribution_migration" } = {}) {
  return {
    id, agencyId: "agency-1", accountId: "creator-1", creatorId: "creator-1", eventHash: `H-${id}`,
    amountCents: 10000, currency: "USD", receivedAt: new Date("2026-08-31T20:00:00Z"),
    status: owner ? "resolved" : "unresolved", attributedMemberId: owner, attributedUserId: owner ? "user-B" : null,
    attributedShiftKey: owner ? "old-shift" : null, resolvedAt: new Date("2026-08-31T20:05:00Z"),
    resolvedSource, source: "legacy_money_attribution_migration",
    result: { migratedFrom: "MoneyAttribution", legacyState, ...resultExtra }, history,
    createdAt: new Date("2026-08-31T19:59:00Z"), updatedAt: new Date("2026-08-31T20:06:00Z"),
  };
}

function oneRowRepairFake(initial) {
  let row = structuredClone(initial);
  const fake = {
    async $transaction(work) { return work(fake); },
    async $queryRawUnsafe(sql) {
      assert.match(String(sql), /FROM "TeamTipLedger"[\s\S]*audit15Closure5ManualRepairScan[\s\S]*FOR UPDATE SKIP LOCKED/);
      const classified = row.result?.audit15Closure5ManualRepairScan?.classified === true;
      const manual = String(row.resolvedSource || "").startsWith("manual_");
      return classified || manual ? [] : [structuredClone(row)];
    },
    agencyMember: { async findFirst({ where }) { return where.id === "member-B" ? { userId: "user-B" } : null; } },
    teamTipLedger: {
      async update({ data }) { row = { ...row, ...structuredClone(data), updatedAt: new Date("2026-09-01T13:00:00Z") }; return structuredClone(row); },
    },
  };
  return { fake, get row() { return row; } };
}

test("Closure5 state-only legacy manager authority is repaired even when history is empty", async () => {
  const fx = oneRowRepairFake(migratedRow({ legacyState: "manager", history: [] }));
  const tips = loadWithPrisma(tipPath, fx.fake);
  const result = await tips.repairMigratedLegacyTipManualAuthority({ agencyId: "agency-1", limit: 10 });
  assert.equal(result.ok, true);
  assert.equal(result.repaired, 1);
  assert.equal(fx.row.status, "resolved");
  assert.equal(fx.row.attributedMemberId, "member-B");
  assert.equal(fx.row.attributedUserId, "user-B");
  assert.equal(fx.row.attributedShiftKey, null);
  assert.match(fx.row.resolvedSource, /^manual_legacy_money_attribution_forward_repair_state_manager$/);
  assert.equal(fx.row.result.audit15Closure5ManualRepairScan.classification, "state_only_manual_repaired");
});

test("Closure5 fail-closes destroyed legacy authority instead of guessing AUTO or MANUAL", async () => {
  const fx = oneRowRepairFake(migratedRow({
    legacyState: "", owner: "member-B",
    resultExtra: { claimType: "tip_attribution", autoReason: "NO_EXACT_MESSAGE_PROVENANCE" },
    history: [{ ts: 1, action: "audit15_migrate_legacy_tip_to_team_tip_ledger", prevOwner: "member-B" }],
    resolvedSource: "creator_tip_unresolved",
  }));
  const tips = loadWithPrisma(tipPath, fx.fake);
  const result = await tips.repairMigratedLegacyTipManualAuthority({ agencyId: "agency-1", limit: 10 });
  assert.equal(result.ambiguous, 1);
  assert.equal(fx.row.status, "conflict");
  assert.equal(fx.row.attributedMemberId, null);
  assert.equal(fx.row.attributedUserId, null);
  assert.equal(fx.row.attributedShiftKey, null);
  assert.equal(fx.row.resolvedSource, "manual_legacy_money_attribution_ambiguous_requires_review");
  assert.equal(fx.row.result.audit15Closure5ManualRepairScan.requiresManualReview, true);
});

test("Closure5 bounded runtime repair advances beyond 250 classified rows", async () => {
  let rows = Array.from({ length: 300 }, (_, i) => migratedRow({
    id: `tip-${String(i).padStart(3, "0")}`,
    legacyState: i === 299 ? "manager" : "auto",
    owner: i === 299 ? "member-B" : "member-A",
  }));
  const fake = {
    async $transaction(work) { return work(fake); },
    async $queryRawUnsafe(_sql, ...args) {
      const limit = Number(args.at(-1) || 250);
      return rows
        .filter((row) => !String(row.resolvedSource || "").startsWith("manual_"))
        .filter((row) => row.result?.audit15Closure5ManualRepairScan?.classified !== true)
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
        .slice(0, limit)
        .map((row) => structuredClone(row));
    },
    agencyMember: { async findFirst({ where }) { return where.id === "member-B" ? { userId: "user-B" } : { userId: "user-A" }; } },
    teamTipLedger: {
      async update({ where, data }) {
        const idx = rows.findIndex((row) => row.id === where.id);
        rows[idx] = { ...rows[idx], ...structuredClone(data), updatedAt: new Date() };
        return structuredClone(rows[idx]);
      },
    },
  };
  const tips = loadWithPrisma(tipPath, fake);
  const first = await tips.repairMigratedLegacyTipManualAuthority({ agencyId: "agency-1", limit: 250 });
  assert.equal(first.scanned, 250);
  assert.equal(first.classifiedAuto, 250);
  assert.equal(first.repaired, 0);
  const second = await tips.repairMigratedLegacyTipManualAuthority({ agencyId: "agency-1", limit: 250 });
  assert.equal(second.scanned, 50);
  assert.equal(second.classifiedAuto, 49);
  assert.equal(second.repaired, 1);
  const last = rows.find((row) => row.id === "tip-299");
  assert.match(last.resolvedSource, /^manual_legacy_money_attribution_forward_repair_state_manager$/);
  const third = await tips.repairMigratedLegacyTipManualAuthority({ agencyId: "agency-1", limit: 250 });
  assert.equal(third.scanned, 0);
});


test("Closure5 AUTO classification survives later result replacement because history marker is durable", async () => {
  let row = migratedRow({ id: "tip-auto", legacyState: "auto", owner: "member-A" });
  const fake = {
    async $transaction(work) { return work(fake); },
    async $queryRawUnsafe() {
      const durable = (row.history || []).some((item) => item.action === "audit15_closure5_classify_legacy_auto_no_manual_evidence");
      return durable ? [] : [structuredClone(row)];
    },
    teamTipLedger: {
      async update({ data }) { row = { ...row, ...structuredClone(data) }; return structuredClone(row); },
    },
  };
  const tips = loadWithPrisma(tipPath, fake);
  const first = await tips.repairMigratedLegacyTipManualAuthority({ agencyId: "agency-1", limit: 10 });
  assert.equal(first.classifiedAuto, 1);
  assert.ok(row.history.some((item) => item.action === "audit15_closure5_classify_legacy_auto_no_manual_evidence"));
  // Simulate a later automatic projector replacing mutable result metadata.
  row.result = { claimType: "tip_attribution", autoReason: "NO_EXACT_MESSAGE_PROVENANCE" };
  row.source = "creator_tip_reconciliation";
  row.resolvedSource = "creator_tip_unresolved";
  const second = await tips.repairMigratedLegacyTipManualAuthority({ agencyId: "agency-1", limit: 10 });
  assert.equal(second.scanned, 0);
  assert.equal(row.status, "resolved");
});

test("Closure5 runtime legacy migration serializes on MoneyAttribution table before row selection", async () => {
  const calls = [];
  const fake = {
    async $transaction(work) { return work(fake); },
    async $executeRawUnsafe(sql) { calls.push(String(sql)); return 0; },
    async $queryRawUnsafe(sql) { calls.push(String(sql)); return []; },
  };
  const tips = loadWithPrisma(tipPath, fake);
  const result = await tips.migrateLegacyTipsToTipLedger({ agencyId: "agency-1", limit: 10 });
  assert.equal(result.ok, true);
  assert.match(calls[0], /LOCK TABLE "MoneyAttribution" IN SHARE ROW EXCLUSIVE MODE/);
  assert.match(calls[1], /FROM "MoneyAttribution"[\s\S]*FOR UPDATE SKIP LOCKED/);
});

test("Closure5 forward repair is independent and pending historical cutover serializes legacy runtime", () => {
  const current = source("../prisma/migrations/20260901140000_event_team_money_authority_closure5/migration.sql");
  assert.match(current, /^BEGIN;/m);
  assert.match(current, /legacyState/);
  assert.match(current, /state_only_manual_repaired/);
  assert.match(current, /ambiguous_legacy_authority_requires_review/);
  assert.match(current, /legacy_auto_no_manual_evidence/);
  assert.match(current, /audit15_closure5_classify_legacy_auto_no_manual_evidence/);
  assert.doesNotMatch(current, /FROM "MoneyAttribution"|LOCK TABLE "MoneyAttribution"|DELETE FROM "MoneyAttribution"/);
  assert.match(current, /COMMIT;/);
  const historical = source("../prisma/migrations/20260831223000_event_team_money_authority_cutover/migration.sql");
  assert.match(historical, /LOCK TABLE "MoneyAttribution" IN ACCESS EXCLUSIVE MODE/);
  assert.doesNotMatch(historical, /LOCK TABLE "TeamTipLedger"/);
});

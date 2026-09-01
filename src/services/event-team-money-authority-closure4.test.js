"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const prismaPath = require.resolve("../prisma");
const tipPath = require.resolve("./team-tip-ledger-service");
const moneyPath = require.resolve("./team-money-reconciliation-service");

function source(rel) { return fs.readFileSync(path.join(ROOT, rel), "utf8"); }
function loadWithPrisma(modulePath, fake) {
  delete require.cache[modulePath];
  delete require.cache[prismaPath];
  require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: fake };
  return require(modulePath);
}

function closure2MigratedManualRow({ overwritten = false } = {}) {
  const manualAt = new Date("2026-08-31T20:05:00Z");
  return {
    id: "tip-ledger-legacy", agencyId: "agency-1", accountId: "creator-1", creatorId: "creator-1",
    eventHash: "H", tipId: "H", messageId: "message-1", fanId: "fan-1", dialogId: "fan-1",
    amountCents: 10000, currency: "USD", receivedAt: new Date("2026-08-31T20:00:00Z"),
    status: overwritten ? "unresolved" : "resolved",
    attributedMemberId: overwritten ? null : "member-B",
    attributedUserId: overwritten ? null : "user-B",
    attributedShiftKey: overwritten ? null : "shift-old",
    resolvedAt: overwritten ? null : manualAt,
    resolvedByMemberId: overwritten ? null : "manager",
    resolvedSource: overwritten ? "creator_tip_unresolved" : "legacy_money_attribution_migration",
    source: overwritten ? "creator_tip_reconciliation" : "legacy_money_attribution_migration",
    result: overwritten ? { claimType: "tip_attribution", autoReason: "NO_EXACT_MESSAGE_PROVENANCE" } : {
      claimType: "tip_attribution",
      migratedFrom: "MoneyAttribution",
      manualResolutions: [{
        manualResolution: true, action: "manager_override", memberId: "member-B",
        resolvedByMemberId: "manager", resolvedAt: manualAt.toISOString(), migratedFromLegacyHistory: true,
      }],
    },
    history: [
      { ts: manualAt.getTime(), action: "manager_override", byMemberId: "manager", nextOwner: "member-B", reason: "manual B" },
      { ts: manualAt.getTime() + 1000, action: "migrate_legacy_tip_to_team_tip_ledger", source: "v16_1_legacy_tip_migration" },
      ...(overwritten ? [{ ts: manualAt.getTime() + 2000, action: "unresolved_evidence", source: "creator_tip_reconciliation" }] : []),
    ],
    createdAt: new Date("2026-08-31T19:59:00Z"), updatedAt: new Date("2026-08-31T20:06:00Z"),
  };
}

function repairFake(initialRow) {
  let row = { ...initialRow };
  const fake = {
    async $transaction(work) { return work(fake); },
    async $queryRawUnsafe(sql) {
      assert.match(String(sql), /FROM "TeamTipLedger"[\s\S]*FOR UPDATE SKIP LOCKED/);
      assert.doesNotMatch(String(sql), /FROM "MoneyAttribution"/);
      return [{ ...row }];
    },
    agencyMember: { async findFirst({ where }) { return where.id === "member-B" ? { userId: "user-B" } : null; } },
    teamTipLedger: {
      async update({ data }) { row = { ...row, ...data, updatedAt: new Date("2026-09-01T10:00:00Z") }; return { ...row }; },
    },
  };
  return { fake, get row() { return row; } };
}

test("Closure4 repairs already-Closure2-migrated MANUAL after MoneyAttribution is gone", async () => {
  const fx = repairFake(closure2MigratedManualRow());
  const tips = loadWithPrisma(tipPath, fx.fake);
  const result = await tips.repairMigratedLegacyTipManualAuthority({ agencyId: "agency-1", limit: 10 });
  assert.equal(result.ok, true);
  assert.equal(result.repaired, 1);
  assert.equal(fx.row.status, "resolved");
  assert.equal(fx.row.attributedMemberId, "member-B");
  assert.equal(fx.row.attributedUserId, "user-B");
  assert.equal(fx.row.attributedShiftKey, null);
  assert.match(fx.row.resolvedSource, /^manual_legacy_money_attribution_forward_repair_manager_override$/);
  assert.equal(fx.row.result.audit15Closure4ManualRepair.repaired, true);
});

test("Closure4 repairs MANUAL even after buggy AUTO already overwrote the canonical row", async () => {
  const fx = repairFake(closure2MigratedManualRow({ overwritten: true }));
  const tips = loadWithPrisma(tipPath, fx.fake);
  const result = await tips.repairMigratedLegacyTipManualAuthority({ agencyId: "agency-1", limit: 10 });
  assert.equal(result.repaired, 1);
  assert.equal(fx.row.attributedMemberId, "member-B");
  assert.equal(fx.row.status, "resolved");
  assert.match(fx.row.resolvedSource, /^manual_/);
});

test("Closure4 repaired MANUAL survives future automatic CreatorTip reconciliation", async () => {
  const fx = repairFake(closure2MigratedManualRow({ overwritten: true }));
  let tips = loadWithPrisma(tipPath, fx.fake);
  await tips.repairMigratedLegacyTipManualAuthority({ agencyId: "agency-1", limit: 10 });
  let row = { ...fx.row };
  const tip = {
    id: "creator-tip-1", agencyId: "agency-1", creatorId: "creator-1", eventFingerprint: "H",
    externalNotificationId: "n-1", messageId: "message-1", amountCents: 10000, currency: "USD",
    tippedAt: new Date("2026-08-31T20:00:00Z"), transactionStatus: "done",
    fan: { onlyFansUserId: "fan-1" }, creator: { id: "creator-1", username: "creator" },
  };
  const db = {
    creatorTip: { async findUnique() { return { ...tip }; } },
    teamSentMessageLedger: { async findFirst() { return null; }, async findMany() { return []; } },
    teamTipLedger: {
      async findFirst() { return { ...row }; }, async findUnique() { return { ...row }; },
      async update({ data }) { row = { ...row, ...data }; return { ...row }; },
      async create({ data }) { row = { id: "new", ...data }; return { ...row }; },
    },
  };
  const money = loadWithPrisma(moneyPath, {});
  const result = await money.reconcileCreatorTipToTeam({ db, tipId: tip.id });
  assert.equal(result.preservedManualResolution, true);
  assert.equal(row.attributedMemberId, "member-B");
  assert.match(row.resolvedSource, /^manual_/);
});

test("Closure4 preserves manual manager decision to creator revenue with no owner", async () => {
  const row = closure2MigratedManualRow({ overwritten: true });
  row.history = [
    { ts: new Date("2026-08-31T20:05:00Z").getTime(), action: "manager_override", byMemberId: "manager", nextOwner: null, reason: "creator revenue" },
    { ts: new Date("2026-08-31T20:05:01Z").getTime(), action: "migrate_legacy_tip_to_team_tip_ledger", source: "v16_1_legacy_tip_migration" },
  ];
  const fx = repairFake(row);
  const tips = loadWithPrisma(tipPath, fx.fake);
  const result = await tips.repairMigratedLegacyTipManualAuthority({ agencyId: "agency-1", limit: 10 });
  assert.equal(result.repaired, 1);
  assert.equal(fx.row.status, "creator_revenue");
  assert.equal(fx.row.attributedMemberId, null);
  assert.equal(fx.row.attributedUserId, null);
  assert.match(fx.row.resolvedSource, /^manual_legacy_money_attribution_forward_repair_manager_override$/);
});

test("Closure4 repair is idempotent once durable manual source exists", async () => {
  const row = closure2MigratedManualRow();
  row.resolvedSource = "manual_legacy_money_attribution_forward_repair_manager_override";
  row.resolvedAt = new Date("2026-08-31T20:10:00Z");
  const fx = repairFake(row);
  const tips = loadWithPrisma(tipPath, fx.fake);
  const result = await tips.repairMigratedLegacyTipManualAuthority({ agencyId: "agency-1", limit: 10 });
  assert.equal(result.repaired, 0);
  assert.equal(result.alreadyManual, 1);
  assert.equal(fx.row.attributedMemberId, "member-B");
});

test("Closure4 forward migration repairs canonical history without touching MoneyAttribution", () => {
  const sql = source("../prisma/migrations/20260901130000_event_team_money_authority_closure4/migration.sql");
  assert.match(sql, /^BEGIN;/m);
  assert.match(sql, /UPDATE "TeamTipLedger"/);
  assert.match(sql, /manual_legacy_money_attribution_forward_repair_/);
  assert.match(sql, /manualResolutions/);
  assert.match(sql, /migrate_legacy_tip_to_team_tip_ledger/);
  assert.doesNotMatch(sql, /FROM "MoneyAttribution"|UPDATE "MoneyAttribution"|DELETE FROM "MoneyAttribution"|LOCK TABLE "MoneyAttribution"/);
  assert.match(sql, /COMMIT;/);
});

test("Closure4 rolling migration lock graph has no Team->Money cycle", () => {
  const historical = source("../prisma/migrations/20260831223000_event_team_money_authority_cutover/migration.sql");
  const runtime = source("services/team-tip-ledger-service.js");
  const forward = source("../prisma/migrations/20260901130000_event_team_money_authority_closure4/migration.sql");
  assert.match(historical, /LOCK TABLE "MoneyAttribution" IN SHARE ROW EXCLUSIVE MODE/);
  assert.doesNotMatch(historical, /LOCK TABLE "TeamTipLedger"/);
  const migrateBody = runtime.slice(runtime.indexOf("async function migrateLegacyTipsToTipLedger"));
  assert.ok(migrateBody.indexOf("selectLegacyTipsForMigration") < migrateBody.indexOf("findTipLedgerForUpdate"));
  assert.doesNotMatch(forward, /MoneyAttribution"/);
});

test("Closure4 scheduler repairs already-migrated manual rows before automatic reconciliation", () => {
  const scheduler = source("services/job-scheduler.js");
  const repair = scheduler.indexOf("await repairMigratedLegacyTipManualAuthority");
  const migrate = scheduler.indexOf("await migrateLegacyTipsToTipLedger", repair);
  const reconcile = scheduler.indexOf("await reconcileHistoricalTeamMoneyBatch", migrate);
  assert.ok(repair >= 0 && migrate > repair && reconcile > migrate);
});

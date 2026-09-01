"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const prismaPath = require.resolve("../prisma");
const tipPath = require.resolve("./team-tip-ledger-service");

function source(rel) { return fs.readFileSync(path.join(ROOT, rel), "utf8"); }
function loadWithPrisma(fake) {
  delete require.cache[tipPath];
  delete require.cache[prismaPath];
  require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: fake };
  return require(tipPath);
}

function legacyMoney({ state = "auto", owner = "member-A", history = [] } = {}) {
  return {
    id: "legacy-1", agencyId: "agency-1", accountId: "creator-1", creatorId: "creator-1",
    eventHash: "H", eventType: "tip_received", fanId: "fan-1", amountCents: 10000, currency: "USD",
    occurredAt: new Date("2026-08-30T10:00:00Z"), createdAt: new Date("2026-08-30T10:00:00Z"),
    updatedAt: new Date("2026-08-30T10:05:00Z"), lockedAt: new Date("2026-08-30T10:05:00Z"),
    state, attributedToMemberId: owner, attributedToUserId: owner ? `user-${owner}` : null,
    autoAttributedToMemberId: state === "auto" ? owner : null,
    autoAttributedToUserId: state === "auto" && owner ? `user-${owner}` : null,
    autoReason: state === "auto" ? "legacy_auto" : null, history,
  };
}

function migrationFake(legacy) {
  let canonical = null;
  let legacyPresent = true;
  const fake = {
    async $transaction(work) { return work(fake); },
    async $executeRawUnsafe() { return 0; },
    async $queryRawUnsafe(sql) {
      const text = String(sql);
      if (text.includes('FROM "MoneyAttribution"')) return legacyPresent ? [structuredClone(legacy)] : [];
      if (text.includes('FROM "TeamTipLedger"')) {
        const hasClosure6Auto = (canonical?.history || []).some((item) => item.action === "audit15_closure6_classify_legacy_auto_authority");
        const manual = String(canonical?.resolvedSource || "").startsWith("manual_");
        return canonical && !hasClosure6Auto && !manual ? [structuredClone(canonical)] : [];
      }
      return [];
    },
    moneyAttribution: {
      async findMany() { return legacyPresent ? [structuredClone(legacy)] : []; },
      async deleteMany() { const count = legacyPresent ? 1 : 0; legacyPresent = false; return { count }; },
    },
    teamTipLedger: {
      async createMany({ data }) {
        if (!canonical && data.length) canonical = { id: "tip-1", ...structuredClone(data[0]), updatedAt: new Date() };
        return { count: canonical ? 1 : 0 };
      },
      async findFirst() { return canonical ? structuredClone(canonical) : null; },
      async findMany() { return canonical ? [structuredClone(canonical)] : []; },
      async update({ data }) { canonical = { ...canonical, ...structuredClone(data), updatedAt: new Date() }; return structuredClone(canonical); },
    },
    agencyMember: {
      async findFirst({ where }) { return where.id ? { userId: `user-${where.id}` } : null; },
    },
  };
  return {
    fake,
    get row() { return canonical; },
    replaceByAutomaticProjection() {
      canonical = {
        ...canonical,
        status: "unresolved", attributedMemberId: null, attributedUserId: null, attributedShiftKey: null,
        resolvedSource: "creator_tip_unresolved", source: "creator_tip_reconciliation",
        result: { claimType: "tip_attribution", autoReason: "NO_EXACT_MESSAGE_PROVENANCE" },
      };
    },
  };
}

test("Closure6 proven AUTO classification is durable in migration before canonical result replacement", async () => {
  const fx = migrationFake(legacyMoney({ state: "auto", owner: "member-A" }));
  const tips = loadWithPrisma(fx.fake);
  const migrated = await tips.migrateLegacyTipsToTipLedger({ agencyId: "agency-1", limit: 10 });
  assert.equal(migrated.ok, true);
  assert.ok(fx.row.history.some((item) => item.action === "audit15_closure6_classify_legacy_auto_authority"));
  assert.equal(fx.row.result.audit15Closure6MigrationAuthority.classification, "proven_legacy_auto");

  fx.replaceByAutomaticProjection();
  const repaired = await tips.repairMigratedLegacyTipManualAuthority({ agencyId: "agency-1", limit: 10 });
  assert.equal(repaired.scanned, 0);
  assert.equal(repaired.ambiguous, 0);
  assert.equal(fx.row.status, "unresolved");
  assert.notEqual(fx.row.resolvedSource, "manual_legacy_money_attribution_ambiguous_requires_review");
});

test("Closure6 runtime classifier gives manual history precedence over stale legacyState=auto", async () => {
  const legacy = legacyMoney({
    state: "auto", owner: "member-A",
    history: [{
      ts: new Date("2026-08-30T10:06:00Z").getTime(), action: "manager_override",
      byMemberId: "manager-1", prevOwner: "member-A", nextOwner: "member-B", reason: "manager B",
    }],
  });
  const fx = migrationFake(legacy);
  const tips = loadWithPrisma(fx.fake);
  const migrated = await tips.migrateLegacyTipsToTipLedger({ agencyId: "agency-1", limit: 10 });
  assert.equal(migrated.ok, true);
  assert.equal(fx.row.status, "resolved");
  assert.equal(fx.row.attributedMemberId, "member-B");
  assert.match(fx.row.resolvedSource, /^manual_legacy_money_attribution_manager_override$/);
  assert.ok(fx.row.history.some((item) => item.action === "audit15_closure6_classify_legacy_manual_authority"));
  assert.equal(fx.row.history.some((item) => item.action === "audit15_closure6_classify_legacy_auto_authority"), false);
});

test("Closure6 historical migration-review lane is discoverable beyond 48h, prioritized over fresh claims, only when explicitly enabled", async () => {
  const old = {
    id: "tip-review", agencyId: "agency-1", accountId: "creator-1", creatorId: "creator-1", eventHash: "H-review",
    tipId: "H-review", amountCents: 10000, currency: "USD", receivedAt: new Date(Date.now() - 72 * 60 * 60 * 1000),
    status: "conflict", attributedMemberId: null, attributedUserId: null, attributedShiftKey: null,
    resolvedSource: "manual_legacy_money_attribution_ambiguous_requires_review", financialStatus: "done",
    result: { audit15Closure6MigrationAuthority: { classified: true, requiresManualReview: true } }, history: [],
    createdAt: new Date(), updatedAt: new Date(),
  };
  const fresh = {
    ...structuredClone(old), id: "tip-fresh", eventHash: "H-fresh", tipId: "H-fresh",
    receivedAt: new Date(), status: "unresolved", resolvedSource: "creator_tip_unresolved",
    result: {}, history: [],
  };
  const seenWhere = [];
  const fake = {
    teamTipLedger: {
      async findMany({ where }) {
        seenWhere.push(where);
        const serialized = JSON.stringify(where);
        return serialized.includes("manual_legacy_money_attribution_ambiguous_requires_review")
          ? [structuredClone(old)]
          : [structuredClone(fresh)];
      },
    },
    agencyMember: { async findMany() { return []; } },
  };
  const tips = loadWithPrisma(fake);
  const rows = await tips.listTipClaims({ agencyId: "agency-1", limit: 1, senior: true, includeMigrationReview: true, allowedCreatorIds: ["creator-1"] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "tip-review", "historical migration review must not be starved by the fresh-claims limit");
  assert.equal(rows[0].requiresManualReview, true);
  assert.equal(rows[0].reviewLane, "migration_ambiguity");
  assert.ok(seenWhere.some((where) => JSON.stringify(where).includes("manual_legacy_money_attribution_ambiguous_requires_review")));

  const hidden = await tips.listTipClaims({ agencyId: "agency-1", limit: 1, senior: true, includeMigrationReview: false, allowedCreatorIds: ["creator-1"] });
  assert.equal(hidden.length, 1);
  assert.equal(hidden[0].id, "tip-fresh");
});

test("Closure6 senior manager can resolve historical quarantine beyond 48h with audited reason", async () => {
  let row = {
    id: "tip-review", agencyId: "agency-1", accountId: "creator-1", creatorId: "creator-1", eventHash: "H-review",
    tipId: "H-review", amountCents: 10000, currency: "USD", receivedAt: new Date(Date.now() - 72 * 60 * 60 * 1000),
    status: "conflict", attributedMemberId: null, attributedUserId: null, attributedShiftKey: null,
    resolvedSource: "manual_legacy_money_attribution_ambiguous_requires_review", financialStatus: "done",
    result: { audit15Closure6MigrationAuthority: { classified: true, requiresManualReview: true } }, history: [],
    createdAt: new Date(), updatedAt: new Date(),
  };
  const fake = {
    agencyMember: {
      async findFirst({ where }) {
        if (where.id === "manager-1") return { id: "manager-1", userId: "user-manager", role: "manager", roleKey: "manager" };
        if (where.id === "member-B") return { id: "member-B", userId: "user-B", role: "chatter", roleKey: "chatter" };
        return null;
      },
      async findMany() { return [{ id: "member-B", userId: "user-B", user: { name: "B" } }]; },
    },
    async $transaction(work) { return work(fake); },
    creatorTip: {
      async findUnique() {
        return {
          id: "creator-tip-1", agencyId: "agency-1", creatorId: "creator-1", eventFingerprint: "H-review",
          externalNotificationId: "notif-1", externalTransactionId: null, messageId: null, amountCents: 10000, currency: "USD",
          tippedAt: new Date(Date.now() - 72 * 60 * 60 * 1000), transactionStatus: "done", fan: { onlyFansUserId: "fan-1" },
          creator: { id: "creator-1", username: "creator", displayName: "Creator" },
        };
      },
    },
    teamSentMessageLedger: {
      async findFirst() { return null; },
      async findMany() { return []; },
    },
    teamTipLedger: {
      async create() { throw new Error("manual review row already exists"); },
      async findFirst() { return structuredClone(row); },
      async findUnique() { return structuredClone(row); },
      async update({ data }) { row = { ...row, ...structuredClone(data) }; return structuredClone(row); },
    },
    teamActivityEvent: { async create() { return {}; } },
  };
  const tips = loadWithPrisma(fake);
  const result = await tips.applyTipOverride({
    agencyId: "agency-1", byUserId: "user-manager", byMemberId: "manager-1", eventHash: "H-review",
    action: "manager_override", targetMemberId: "member-B", reason: "Reviewed historical migration ambiguity",
    senior: true, allowedCreatorIds: ["creator-1"],
  });
  assert.equal(result.ok, true);
  assert.equal(row.status, "resolved");
  assert.equal(row.attributedMemberId, "member-B");
  assert.equal(row.attributedUserId, "user-B");
  assert.equal(row.attributedShiftKey, null);
  assert.equal(row.resolvedSource, "manual_manager_migration_review");
  assert.equal(row.result.manualResolution.migrationReview, true);
  assert.equal(row.result.audit15Closure6MigrationAuthority.requiresManualReview, false);
  assert.equal(result.attribution.requiresManualReview, false);
  assert.equal(result.attribution.reviewLane, null);
  assert.ok(row.history.some((item) => item.action === "manager_override" && item.migrationReview === true));
  assert.ok(row.history.some((item) => item.action === "audit15_closure7_finalize_migration_review" && item.requiresManualReview === false));

  const reconciliation = require("./team-money-reconciliation-service");
  const auto = await reconciliation.reconcileCreatorTipToTeam({ db: fake, tipId: "creator-tip-1" });
  assert.equal(auto.ok, true);
  assert.equal(auto.preservedManualResolution, true, "future automatic projection must preserve senior migration review");
  assert.equal(row.status, "resolved");
  assert.equal(row.attributedMemberId, "member-B");
  assert.equal(row.attributedUserId, "user-B");
  assert.equal(row.resolvedSource, "manual_manager_migration_review");

  const second = await tips.applyTipOverride({
    agencyId: "agency-1", byUserId: "user-manager", byMemberId: "manager-1", eventHash: "H-review",
    action: "manager_override", targetMemberId: "member-B", reason: "review lane must now be terminal",
    senior: true, allowedCreatorIds: ["creator-1"],
  });
  assert.equal(second.ok, false);
  assert.equal(second.code, "ATTRIBUTION_LOCKED");
});

test("Closure6 ordinary 48h lock remains for non-senior or non-review manager_override", async () => {
  const old = {
    id: "tip-normal", agencyId: "agency-1", creatorId: "creator-1", eventHash: "H-normal",
    receivedAt: new Date(Date.now() - 72 * 60 * 60 * 1000), status: "conflict", financialStatus: "done",
    resolvedSource: "creator_tip_conflict", result: {}, history: [],
  };
  const fake = {
    agencyMember: { async findFirst({ where }) { return { id: where.id || "manager-1", userId: "user-manager", role: "manager", roleKey: "manager" }; } },
    async $transaction(work) { return work(fake); },
    teamTipLedger: { async findFirst() { return structuredClone(old); } },
  };
  const tips = loadWithPrisma(fake);
  const result = await tips.applyTipOverride({
    agencyId: "agency-1", byMemberId: "manager-1", eventHash: "H-normal", action: "manager_override",
    targetMemberId: "member-B", reason: "normal old claim", senior: true, allowedCreatorIds: ["creator-1"],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "ATTRIBUTION_LOCKED");
});

test("Closure6 forward SQL uses the same evidence precedence and does not edit older migrations", () => {
  const sql = source("../prisma/migrations/20260901150000_event_team_money_authority_closure6/migration.sql");
  assert.match(sql, /Audit15Closure6ManualEvidence/);
  assert.match(sql, /manualResolutions/);
  assert.match(sql, /manualResolution/);
  assert.match(sql, /legacyMigration.*manualResolutions/s);
  assert.match(sql, /MANUAL result\/history evidence always wins/i);
  const manualAt = sql.indexOf("MANUAL result/history evidence always wins");
  const stateAt = sql.indexOf("State-only MANUAL fallback");
  const autoAt = sql.indexOf("Proven AUTO only after");
  const ambiguousAt = sql.indexOf("Remaining historical rows are truly ambiguous");
  assert.ok(manualAt >= 0 && stateAt > manualAt && autoAt > stateAt && ambiguousAt > autoAt);
  assert.match(sql.slice(autoAt, ambiguousAt), /NOT EXISTS \(SELECT 1 FROM "Audit15Closure6ManualEvidence"/);
  assert.match(sql, /audit15_closure5_classify_legacy_auto_no_manual_evidence/);
  assert.match(sql, /audit15_closure6_classify_legacy_auto_authority/);
  assert.doesNotMatch(sql, /FROM "MoneyAttribution"|LOCK TABLE "MoneyAttribution"|UPDATE "MoneyAttribution"|DELETE FROM "MoneyAttribution"/);

  const service = source("services/team-tip-ledger-service.js");
  const manualFn = service.indexOf("function canonicalLegacyManualEvidence");
  const autoFn = service.indexOf("function legacyProvenAutoEvidence");
  const useManual = service.indexOf("const evidence = canonicalLegacyManualEvidence(row)");
  const useAuto = service.indexOf("if (legacyProvenAutoEvidence(row))", useManual);
  assert.ok(manualFn >= 0 && autoFn > manualFn && useManual >= 0 && useAuto > useManual);

  const route = source("routes/team-claims.js");
  assert.match(route, /includeMigrationReview: canOverrideAttribution/);
  assert.match(route, /money\.override_attribution permission is required/);
});

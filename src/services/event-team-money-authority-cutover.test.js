"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { requireBoundAccessDevice } = require("../utils/device-binding");

const ROOT = path.resolve(__dirname, "..");
const prismaPath = require.resolve("../prisma");
const analyticsPath = require.resolve("./team-analytics-service");
const tipLedgerPath = require.resolve("./team-tip-ledger-service");

function source(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function listModel(rows) {
  return {
    async findMany(args = {}) {
      const cursorId = args.cursor?.id || null;
      let start = 0;
      if (cursorId) {
        const idx = rows.findIndex((row) => row.id === cursorId);
        start = idx >= 0 ? idx + Number(args.skip || 0) : 0;
      }
      const take = Number(args.take || rows.length || 1000);
      return rows.slice(start, start + take);
    },
  };
}

function memberRow() {
  return {
    id: "member-a",
    agencyId: "agency-1",
    userId: "user-a",
    role: "OPERATOR",
    roleKey: "chatter",
    displayName: "Marina",
    assignedCreators: ["creator-1"],
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    user: { id: "user-a", email: "marina@example.test", name: "Marina" },
    teamFunctions: [{ functionKey: "CHATTER" }],
  };
}

function emptyCorePrisma({ activity = [], coverageFrom = new Date("2026-08-01T00:00:00.000Z") } = {}) {
  return {
    agencyMember: listModel([memberRow()]),
    teamActivityEvent: listModel(activity),
    teamPpvPurchaseLedger: { ...listModel([]), async groupBy() { return []; } },
    teamResponseCase: listModel([]),
    teamDialogSession: listModel([]),
    teamPendingDialogState: listModel([]),
    teamProjectionCoverage: {
      async findUnique() {
        return { agencyId: "agency-1", responseCoverageFrom: coverageFrom, dialogCoverageFrom: coverageFrom };
      },
    },
    moneyAttribution: { async findMany() { return []; } },
    teamTipLedger: { ...listModel([]), async groupBy() { return []; } },
  };
}

function loadAnalytics(prisma) {
  delete require.cache[analyticsPath];
  delete require.cache[prismaPath];
  require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: prisma };
  return require(analyticsPath);
}

function moneyPrisma({ canonicalUndo = false } = {}) {
  const legacy = {
    id: "legacy-h",
    agencyId: "agency-1",
    creatorId: "creator-1",
    accountId: "creator-1",
    fanId: "fan-1",
    eventHash: "H",
    eventType: "tip_received",
    attributedToMemberId: "member-a",
    amountCents: 10000,
    occurredAt: new Date("2026-08-30T10:00:00.000Z"),
  };
  const canonical = {
    id: "tip-h",
    agencyId: "agency-1",
    creatorId: "creator-1",
    accountId: "creator-1",
    fanId: "fan-1",
    dialogId: "fan-1",
    eventHash: "H",
    status: "attributed",
    financialStatus: canonicalUndo ? "undo" : "active",
    attributedMemberId: "member-a",
    amountCents: 10000,
    receivedAt: new Date("2026-08-30T10:00:00.000Z"),
  };
  const prisma = emptyCorePrisma();
  prisma.moneyAttribution = { async findMany() { return [legacy]; } };
  prisma.teamTipLedger = {
    async groupBy() {
      return canonicalUndo ? [] : [{ attributedMemberId: "member-a", _sum: { amountCents: 10000 } }];
    },
    async findMany(args = {}) {
      if (args.where?.eventHash?.in) return [{ eventHash: "H" }];
      if (canonicalUndo) return [];
      const cursorId = args.cursor?.id || null;
      if (cursorId === canonical.id) return [];
      return [canonical];
    },
  };
  return prisma;
}

function loadTipLedger(prisma) {
  delete require.cache[tipLedgerPath];
  delete require.cache[prismaPath];
  require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: prisma };
  return require(tipLedgerPath);
}

test("Audit15 source closure removes client money ingress and duplicate compatibility money writers", () => {
  const claims = source("routes/team-claims.js");
  const telemetry = source("services/telemetry-ingest-service.js");
  const observation = source("services/team-observation-service.js");
  const money = source("services/money-attribution-service.js");
  const tips = source("services/team-tip-ledger-service.js");
  const ppv = source("services/team-ppv-ledger-service.js");
  const analytics = source("services/team-analytics-service.js");
  const schema = fs.readFileSync(path.join(ROOT, "..", "prisma", "schema.prisma"), "utf8");
  const migration = fs.readFileSync(path.join(ROOT, "..", "prisma", "migrations", "20260831223000_event_team_money_authority_cutover", "migration.sql"), "utf8");

  assert.doesNotMatch(claims, /router\.post\(["']\/ingest["']/);
  assert.doesNotMatch(claims, /ingestMoneyEvent/);
  assert.doesNotMatch(telemetry, /normalizeLegacyEvent/);
  assert.doesNotMatch(observation, /ingestTipEvent|upsertPurchaseFromEvent/);
  assert.doesNotMatch(money, /function\s+ingestMoneyEvent|ingestMoneyEvent\s*,/);
  assert.doesNotMatch(tips, /function\s+ingestTipEvent|ingestTipEvent\s*,/);
  assert.doesNotMatch(ppv, /function\s+upsertPurchaseFromEvent|upsertPurchaseFromEvent\s*,/);
  assert.doesNotMatch(analytics, /moneyAttribution\.findMany|legacyTipRevenueByMember|team_ledgers_plus_unmigrated_legacy_tip_fallback/);
  assert.equal((schema.match(/teamProjectionCoverage\s+TeamProjectionCoverage\?/g) || []).length, 1, "projection coverage is agency-level authority only");
  assert.match(migration, /FROM "MoneyAttribution" m[\s\S]*WHERE m\."eventType" = 'tip_received'/);
  assert.match(migration, /DELETE FROM "MoneyAttribution" m[\s\S]*EXISTS \([\s\S]*"TeamTipLedger"/);
});

test("Audit15 scheduler automatically drains legacy tip migration before canonical historical reconciliation", () => {
  const scheduler = source("services/job-scheduler.js");
  assert.match(scheduler, /migrateLegacyTipsToTipLedger/);
  assert.match(scheduler, /TEAM_MONEY_BACKFILL_BATCH_SIZE/);
  const migrateIndex = scheduler.indexOf("await migrateLegacyTipsToTipLedger");
  const reconcileIndex = scheduler.indexOf("await reconcileHistoricalTeamMoneyBatch", migrateIndex);
  assert.ok(migrateIndex >= 0 && reconcileIndex > migrateIndex, "legacy tip migration must run before canonical historical reconciliation in the same maintenance sweep");
});

test("Audit15 telemetry route binds device and ignores client tenant authority", () => {
  const route = source("routes/telemetry.js");
  assert.match(route, /requireAuthDevice\(req,\s*input\.deviceId/);
  assert.match(route, /const agencyId = req\.auth\.agencyId/);
  assert.doesNotMatch(route, /agencyId:\s*z\./);
  assert.throws(
    () => requireBoundAccessDevice("device-a", "device-b", { mismatchCode: "TELEMETRY_DEVICE_MISMATCH" }),
    (error) => error?.code === "TELEMETRY_DEVICE_MISMATCH" && error?.status === 403,
  );
});

test("Audit15 canonical tip suppresses the same legacy eventHash instead of double counting", async () => {
  const analytics = loadAnalytics(moneyPrisma({ canonicalUndo: false }));
  const payload = await analytics.buildTeamMembers({ agencyId: "agency-1", rangeKey: "7d", includeMoney: true });
  assert.equal(payload.members[0].metrics.revenueAttributedCents, 10000);
});

test("Audit15 canonical undo suppresses the same legacy hash so refunded revenue stays zero", async () => {
  const analytics = loadAnalytics(moneyPrisma({ canonicalUndo: true }));
  const payload = await analytics.buildTeamMembers({ agencyId: "agency-1", rangeKey: "7d", includeMoney: true });
  assert.equal(payload.members[0].metrics.revenueAttributedCents, 0);
});

test("Audit15 legacy MoneyAttribution alone is no longer a Team Analytics money source", async () => {
  const prisma = moneyPrisma({ canonicalUndo: true });
  prisma.teamTipLedger = {
    async groupBy() { return []; },
    async findMany() { return []; },
  };
  const analytics = loadAnalytics(prisma);
  const payload = await analytics.buildTeamMembers({ agencyId: "agency-1", rangeKey: "7d", includeMoney: true });
  assert.equal(payload.members[0].metrics.revenueAttributedCents, 0);
  assert.notEqual(payload.members[0].metrics.moneySource, "team_ledgers_plus_unmigrated_legacy_tip_fallback");
});

test("Audit15 retained legacy PPV telemetry cannot create Team revenue without canonical ledger", async () => {
  const activity = [{
    id: "legacy-ppv", agencyId: "agency-1", memberId: "member-a", creatorId: "creator-1", accountId: "creator-1",
    fanId: "fan-1", type: "ppv_purchase_attributed", source: "electron_team_v12", ts: new Date(),
    extra: { purchaseId: "legacy-purchase", amountCents: 10000, attributedMemberId: "member-a" },
  }];
  const analytics = loadAnalytics(emptyCorePrisma({ activity }));
  const payload = await analytics.buildTeamMembers({ agencyId: "agency-1", rangeKey: "7d", includeMoney: true });
  assert.equal(payload.members[0].metrics.revenueAttributedCents, 0);
  assert.equal(payload.members[0].metrics.ppvRevenueCents, 0);
});

test("Audit15 projected response/dialog coverage owns authoritative zero rows", async () => {
  const ts = new Date("2026-08-30T12:00:00.000Z");
  const activity = [
    {
      id: "legacy-reply-after-cutover", agencyId: "agency-1", memberId: "member-a", creatorId: "creator-1",
      accountId: "creator-1", fanId: "fan-1", dialogId: "fan-1", type: "chat_message_sent_local",
      source: "electron_team_v12", ts, extra: { telemetryVersion: "team_v12_actual_backend_ppv_safe", isFreshReply: true, replySeconds: 777 },
    },
    {
      id: "dialog-after-cutover", agencyId: "agency-1", memberId: "member-a", creatorId: "creator-1",
      accountId: "creator-1", fanId: "fan-1", dialogId: "fan-1", eventKind: "DIALOG_SESSION",
      source: "electron_team_v13", ts, durationSeconds: 999, extra: { telemetryVersion: "team_v13_provenance" },
    },
  ];
  const analytics = loadAnalytics(emptyCorePrisma({ activity, coverageFrom: new Date("2026-08-01T00:00:00.000Z") }));
  const payload = await analytics.buildTeamMembers({ agencyId: "agency-1", rangeKey: "7d", includeMoney: false });
  const metrics = payload.members[0].metrics;
  assert.equal(payload.responseSummary.source, "team_response_case_v1");
  assert.equal(payload.projection.responseSource, "team_response_case_v1");
  assert.equal(payload.projection.dialogSessionSource, "team_dialog_session_v1");
  assert.equal(metrics.avgResponseSeconds, null);
  assert.equal(metrics.dialogSessionsCount, 0);
});

test("Audit15 pre-cutover history keeps only the legacy slice in a hybrid range", async () => {
  const cutoff = new Date("2026-08-15T00:00:00.000Z");
  const activity = [
    {
      id: "legacy-before", agencyId: "agency-1", memberId: "member-a", creatorId: "creator-1", accountId: "creator-1",
      fanId: "fan-1", dialogId: "fan-1", type: "chat_message_sent_local", source: "electron_team_v12",
      ts: new Date("2026-08-10T10:00:00.000Z"), extra: { telemetryVersion: "team_v12_actual_backend_ppv_safe", isFreshReply: true, replySeconds: 120 },
    },
    {
      id: "legacy-after", agencyId: "agency-1", memberId: "member-a", creatorId: "creator-1", accountId: "creator-1",
      fanId: "fan-1", dialogId: "fan-1", type: "chat_message_sent_local", source: "electron_team_v12",
      ts: new Date("2026-08-20T10:00:00.000Z"), extra: { telemetryVersion: "team_v12_actual_backend_ppv_safe", isFreshReply: true, replySeconds: 900 },
    },
  ];
  const analytics = loadAnalytics(emptyCorePrisma({ activity, coverageFrom: cutoff }));
  const payload = await analytics.buildTeamMembers({ agencyId: "agency-1", rangeKey: "all", includeMoney: false });
  assert.equal(payload.responseSummary.source, "hybrid_legacy_before_projection_coverage");
  assert.equal(payload.projection.responseSource, "hybrid_legacy_before_projection_coverage");
  assert.equal(payload.members[0].metrics.avgResponseSeconds, 120);
});

test("Audit15 legacy tip migration preserves provenance, deletes only after ledger presence, and is idempotent", async () => {
  const legacy = [{
    id: "legacy-1", agencyId: "agency-1", accountId: "creator-1", creatorId: "creator-1", fanId: "fan-1",
    eventHash: "H", eventType: "tip_received", amountCents: 10000, currency: "USD",
    occurredAt: new Date(), attributedToMemberId: "member-a", attributedToUserId: "user-a",
    state: "claimed", locked: true, lockedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
    history: [{ action: "claim", byMemberId: "member-a" }], result: { prior: true },
  }];
  const ledgers = [];
  const prisma = {
    moneyAttribution: {
      async findMany() { return legacy.slice(); },
      async deleteMany({ where }) {
        const ids = new Set(where.id.in);
        const before = legacy.length;
        for (let i = legacy.length - 1; i >= 0; i -= 1) if (ids.has(legacy[i].id)) legacy.splice(i, 1);
        return { count: before - legacy.length };
      },
    },
    teamTipLedger: {
      async findMany({ where }) {
        const hashes = new Set(where.eventHash?.in || []);
        return ledgers.filter((row) => row.agencyId === where.agencyId && hashes.has(row.eventHash))
          .map((row) => ({ ...row }));
      },
      async findFirst({ where }) {
        const row = ledgers.find((current) => current.agencyId === where.agencyId && current.eventHash === where.eventHash);
        return row ? { ...row } : null;
      },
      async createMany({ data }) {
        let count = 0;
        for (const row of data) {
          if (ledgers.some((current) => current.agencyId === row.agencyId && current.eventHash === row.eventHash)) continue;
          ledgers.push({ id: `tip-${ledgers.length + 1}`, ...row });
          count += 1;
        }
        return { count };
      },
      async update({ where, data }) {
        const index = ledgers.findIndex((row) => row.id === where.id);
        ledgers[index] = { ...ledgers[index], ...data };
        return { ...ledgers[index] };
      },
    },
    async $transaction(work) { return work(prisma); },
  };
  const service = loadTipLedger(prisma);
  const first = await service.migrateLegacyTipsToTipLedger({ agencyId: "agency-1", deleteLegacy: true });
  assert.equal(first.ok, true);
  assert.equal(first.migrated, 1);
  assert.equal(first.deletedLegacy, 1);
  assert.equal(legacy.length, 0);
  assert.equal(ledgers.length, 1);
  assert.equal(ledgers[0].attributedMemberId, "member-a");
  assert.equal(ledgers[0].source, "legacy_money_attribution_migration");
  assert.ok(Array.isArray(ledgers[0].history) && ledgers[0].history.length >= 2);

  const second = await service.migrateLegacyTipsToTipLedger({ agencyId: "agency-1", deleteLegacy: true });
  assert.equal(second.ok, true);
  assert.equal(second.scanned, 0);
  assert.equal(ledgers.length, 1);
});

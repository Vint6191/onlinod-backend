"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const prismaPath = require.resolve("../prisma");
const tipPath = require.resolve("./team-tip-ledger-service");
const ppvPath = require.resolve("./team-ppv-ledger-service");
const moneyPath = require.resolve("./team-money-reconciliation-service");
const analyticsPath = require.resolve("./team-analytics-service");

function source(rel) { return fs.readFileSync(path.join(ROOT, rel), "utf8"); }
function loadWithPrisma(modulePath, fake) {
  delete require.cache[modulePath];
  delete require.cache[prismaPath];
  require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: fake };
  return require(modulePath);
}

function legacyManualRow() {
  return {
    id: "legacy-manual", agencyId: "agency-1", eventHash: "H", eventType: "tip_received",
    amountCents: 10000, currency: "USD", occurredAt: new Date("2026-08-31T20:00:00Z"), capturedAt: new Date("2026-08-31T20:00:01Z"),
    creatorId: "creator-1", accountId: "creator-1", fanId: "fan-1", state: "manager",
    attributedToMemberId: "member-B", attributedToUserId: "user-B", locked: true,
    lockedAt: new Date("2026-08-31T20:05:00Z"), updatedAt: new Date("2026-08-31T20:05:00Z"), createdAt: new Date("2026-08-31T19:59:00Z"),
    history: [{ ts: new Date("2026-08-31T20:05:00Z").getTime(), action: "manager_override", byMemberId: "manager", nextOwner: "member-B", reason: "manual B" }],
    autoAttributedToMemberId: "member-A", autoAttributedToUserId: "user-A", autoReason: "old auto",
  };
}

function autoTipRow() {
  return {
    id: "team-tip-1", agencyId: "agency-1", accountId: "creator-1", creatorId: "creator-1", eventHash: "H", tipId: "tip-H",
    amountCents: 10000, currency: "USD", receivedAt: new Date("2026-08-31T20:00:00Z"), status: "attributed",
    attributedMemberId: "member-A", attributedUserId: "user-A", attributedShiftKey: "shift-A",
    resolvedAt: new Date("2026-08-31T20:01:00Z"), resolvedSource: "creator_tip_exact_message",
    source: "creator_tip_reconciliation", result: {}, history: [], updatedAt: new Date("2026-08-31T20:01:00Z"), createdAt: new Date("2026-08-31T20:00:00Z"),
  };
}

test("Closure3 existing AUTO + later legacy MANUAL migrates MANUAL before legacy delete", async () => {
  const legacy = legacyManualRow();
  let canonical = autoTipRow();
  let deleted = [];
  const fake = {
    async $transaction(work) { return work(fake); },
    async $queryRawUnsafe(sql) {
      assert.match(String(sql), /MoneyAttribution[\s\S]*FOR UPDATE SKIP LOCKED/);
      return [{ ...legacy }];
    },
    moneyAttribution: { async deleteMany({ where }) { deleted = where.id.in.slice(); return { count: deleted.length }; } },
    teamTipLedger: {
      async createMany() { return { count: 0 }; },
      async findFirst() { return { ...canonical }; },
      async update({ data }) { canonical = { ...canonical, ...data, updatedAt: new Date("2026-08-31T20:06:00Z") }; return { ...canonical }; },
    },
  };
  const tips = loadWithPrisma(tipPath, fake);
  const result = await tips.migrateLegacyTipsToTipLedger({ agencyId: "agency-1", limit: 10 });
  assert.equal(result.ok, true);
  assert.equal(result.manualMerged, 1);
  assert.equal(canonical.attributedMemberId, "member-B");
  assert.equal(canonical.attributedUserId, "user-B");
  assert.equal(canonical.attributedShiftKey, null);
  assert.match(canonical.resolvedSource, /^manual_/);
  assert.deepEqual(deleted, ["legacy-manual"]);
});


test("Closure3 newer canonical MANUAL beats older legacy MANUAL while legacy history is merged before delete", async () => {
  const legacy = legacyManualRow();
  let canonical = {
    ...autoTipRow(),
    attributedMemberId: "member-C", attributedUserId: "user-C", attributedShiftKey: null,
    status: "resolved", resolvedSource: "manual_manager_resolution",
    resolvedAt: new Date("2026-08-31T20:10:00Z"), updatedAt: new Date("2026-08-31T20:10:00Z"),
    history: [{ action: "manager_override", nextOwner: "member-C", ts: new Date("2026-08-31T20:10:00Z").getTime() }], result: {},
  };
  let deleted = [];
  const fake = {
    async $transaction(work) { return work(fake); },
    async $queryRawUnsafe() { return [{ ...legacy }]; },
    moneyAttribution: { async deleteMany({ where }) { deleted = where.id.in.slice(); return { count: deleted.length }; } },
    teamTipLedger: {
      async createMany() { return { count: 0 }; },
      async findFirst() { return { ...canonical }; },
      async update({ data }) { canonical = { ...canonical, ...data }; return { ...canonical }; },
    },
  };
  const tips = loadWithPrisma(tipPath, fake);
  const result = await tips.migrateLegacyTipsToTipLedger({ agencyId: "agency-1", limit: 10 });
  assert.equal(result.ok, true);
  assert.equal(canonical.attributedMemberId, "member-C");
  assert.equal(canonical.resolvedSource, "manual_manager_resolution");
  assert.ok(canonical.history.some((item) => item.legacyAttributionId === "legacy-manual"));
  assert.deepEqual(deleted, ["legacy-manual"]);
});

test("Closure3 latest legacy manual history owns migration even if stale legacy state says auto", async () => {
  const legacy = { ...legacyManualRow(), state: "auto", attributedToMemberId: "member-A", attributedToUserId: "user-A" };
  let canonical = autoTipRow();
  const fake = {
    async $transaction(work) { return work(fake); }, async $queryRawUnsafe() { return [{ ...legacy }]; },
    moneyAttribution: { async deleteMany() { return { count: 1 }; } },
    teamTipLedger: {
      async createMany() { return { count: 0 }; }, async findFirst() { return { ...canonical }; },
      async update({ data }) { canonical = { ...canonical, ...data }; return { ...canonical }; },
    },
  };
  const tips = loadWithPrisma(tipPath, fake);
  await tips.migrateLegacyTipsToTipLedger({ agencyId: "agency-1", limit: 10 });
  assert.equal(canonical.attributedMemberId, "member-B");
  assert.match(canonical.resolvedSource, /^manual_legacy_money_attribution_manager_override$/);
});

test("Closure3 migrated MANUAL Tip remains MANUAL after later automatic reconcile", async () => {
  let row = {
    ...autoTipRow(),
    attributedMemberId: "member-B", attributedUserId: "user-B", attributedShiftKey: null,
    status: "resolved", resolvedSource: "manual_legacy_money_attribution_manager", resolvedAt: new Date("2026-08-31T20:05:00Z"),
  };
  const tip = {
    id: "creator-tip-1", agencyId: "agency-1", creatorId: "creator-1", eventFingerprint: "H", externalNotificationId: "n-1",
    messageId: "message-1", amountCents: 10000, currency: "USD", tippedAt: new Date("2026-08-31T20:00:00Z"), transactionStatus: "done",
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

function ppvJobAndPurchase() {
  const job = { id: "job-1", agencyId: "agency-1", creatorId: "creator-1", accountId: "creator-1", creatorRef: "creator", purchaseId: "purchase-1", messageId: "message-1", amountCents: 1000, currency: "USD", purchasedAt: new Date(), status: "conflict", result: {} };
  const purchase = { id: "purchase-row", agencyId: "agency-1", creatorId: "creator-1", accountId: "creator-1", purchaseId: "purchase-1", messageId: "message-1", amountCents: 1000, currency: "USD", purchasedAt: job.purchasedAt, status: "attributed", attributedMemberId: "member-A", attributedUserId: "user-A", attributedShiftKey: "shift-A", resolvedSource: "creator_sale_exact_message" };
  return { job, purchase };
}

test("Closure3 PPV manual reassignment replaces the full owner tuple", async () => {
  const state = ppvJobAndPurchase();
  let purchase = state.purchase;
  const lockOrder = [];
  const fake = {
    async $transaction(work) { return work(fake); },
    async $queryRaw(strings) {
      const sql = Array.isArray(strings) ? strings.join("?") : String(strings);
      if (sql.includes('"TeamPpvResolveJob"')) { lockOrder.push("job"); return [{ ...state.job }]; }
      if (sql.includes('"TeamPpvPurchaseLedger"')) { lockOrder.push("purchase"); return [{ ...purchase }]; }
      return [];
    },
    agencyMember: {
      async findFirst({ where }) { return { id: where.id, userId: where.id === "member-B" ? "user-B" : "user-manager" }; },
      async findMany({ where }) { return (where.id?.in || []).map((id) => ({ id, userId: id === "member-B" ? "user-B" : "user-manager", user: { id, email: `${id}@test` } })); },
    },
    teamPpvPurchaseLedger: { async upsert({ update }) { purchase = { ...purchase, ...update }; return { ...purchase }; } },
    teamPpvResolveJob: { async update() { return { ...state.job, status: "resolved" }; } },
    teamActivityEvent: { async findFirst() { return null; }, async create() { return {}; } },
    teamPpvClaimAudit: { async create() { return {}; } },
  };
  const ppv = loadWithPrisma(ppvPath, fake);
  const result = await ppv.resolvePpvConflict({ agencyId: "agency-1", jobId: "job-1", memberId: "member-B", actorMemberId: "manager", action: "assign", deviceId: "device-1", reason: "manager changed owner", allowedCreatorIds: ["creator-1"] });
  assert.equal(result.resolved, 1);
  assert.deepEqual(lockOrder.slice(0, 2), ["job", "purchase"]);
  assert.equal(purchase.attributedMemberId, "member-B");
  assert.equal(purchase.attributedUserId, "user-B");
  assert.equal(purchase.attributedShiftKey, null);
  assert.equal(purchase.resolvedSource, "manual_claim_resolution");
});

function createSharedPpvConcurrencyDb() {
  const state = ppvJobAndPurchase();
  state.purchase.creatorSaleId = "sale-1";
  const sale = { id: "sale-1", agencyId: "agency-1", creatorId: "creator-1", fanId: "fan-internal", externalNotificationId: "purchase-1", externalTransactionId: "tx-1", eventFingerprint: "sale-fp", saleType: "MESSAGE", messageId: "message-1", amountCents: 1000, currency: "USD", purchasedAt: state.job.purchasedAt, transactionStatus: "done", fan: { onlyFansUserId: "fan-1" }, creator: { username: "creator" } };
  const sent = { agencyId: "agency-1", accountId: "creator-1", creatorId: "creator-1", memberId: "member-A", userId: "user-A", deviceId: "device-A", shiftKey: "shift-A", dialogId: "fan-1", fanId: "fan-1", messageId: "message-1", sentAt: new Date(state.job.purchasedAt.getTime() - 1000), source: "manual" };
  const locks = new Map();
  let txSeq = 0;
  async function acquire(txid, name) {
    while (locks.has(name) && locks.get(name) !== txid) await new Promise((r) => setTimeout(r, 1));
    locks.set(name, txid);
  }
  function release(txid) { for (const [name, owner] of [...locks]) if (owner === txid) locks.delete(name); }
  const root = {
    async $transaction(work) {
      const txid = `tx-${++txSeq}`;
      const tx = makeTx(txid);
      try { return await work(tx); } finally { release(txid); }
    },
  };
  function makeTx(txid) {
    const tx = {
      async $queryRawUnsafe(sql) {
        const text = String(sql);
        if (text.includes('"TeamPpvResolveJob"')) { await acquire(txid, "job"); return [{ ...state.job }]; }
        if (text.includes('"TeamPpvPurchaseLedger"')) { await acquire(txid, "purchase"); return [{ ...state.purchase }]; }
        return [];
      },
      async $queryRaw(strings) {
        const text = Array.isArray(strings) ? strings.join("?") : String(strings);
        if (text.includes('"TeamPpvResolveJob"')) { await acquire(txid, "job"); return [{ ...state.job }]; }
        if (text.includes('"TeamPpvPurchaseLedger"')) { await acquire(txid, "purchase"); return [{ ...state.purchase }]; }
        return [];
      },
      creatorSale: { async findUnique() { return { ...sale }; } },
      creatorFinancialTransaction: { async findUnique() { return { id: "financial-1", transactionStatus: "done" }; } },
      teamSentMessageLedger: { async findFirst() { return { ...sent }; } },
      agencyMember: {
        async findFirst({ where }) { return { id: where.id, userId: where.id === "member-B" ? "user-B" : (where.id === "member-A" ? "user-A" : "user-manager") }; },
        async findMany({ where }) { return (where.id?.in || []).map((id) => ({ id, userId: id === "member-B" ? "user-B" : "user-A", user: { id, email: `${id}@test` } })); },
      },
      teamPpvPurchaseLedger: {
        async findUnique() { return { ...state.purchase }; }, async findMany() { return []; },
        async update({ data }) { state.purchase = { ...state.purchase, ...data }; return { ...state.purchase }; },
        async create({ data }) { state.purchase = { id: "purchase-row", ...data }; return { ...state.purchase }; },
        async upsert({ update, create }) { state.purchase = state.purchase ? { ...state.purchase, ...update } : { id: "purchase-row", ...create }; return { ...state.purchase }; },
      },
      teamPpvResolveJob: {
        async upsert({ update, create }) { state.job = state.job ? { ...state.job, ...update } : { id: "job-1", ...create }; return { ...state.job }; },
        async update({ data }) { state.job = { ...state.job, ...data }; return { ...state.job }; },
        async updateMany({ data }) { state.job = { ...state.job, ...data }; return { count: 1 }; },
      },
      teamActivityEvent: { async findFirst() { return null; }, async create() { return {}; } },
      teamPpvClaimAudit: { async create() { return {}; } },
    };
    return tx;
  }
  return { root, state };
}

test("Closure3 true AUTO/MANUAL PPV overlap converges without deadlock and final owner is MANUAL", async () => {
  const fx = createSharedPpvConcurrencyDb();
  const money = loadWithPrisma(moneyPath, {});
  const ppv = loadWithPrisma(ppvPath, fx.root);
  const auto = money.reconcileCreatorSaleToTeam({ db: fx.root, saleId: "sale-1" });
  const manual = ppv.resolvePpvConflict({ agencyId: "agency-1", jobId: "job-1", memberId: "member-B", actorMemberId: "manager", action: "assign", deviceId: "device-1", reason: "manual wins overlap", allowedCreatorIds: ["creator-1"] });
  await Promise.race([
    Promise.all([auto, manual]),
    new Promise((_, reject) => setTimeout(() => reject(new Error("deadlock timeout")), 1000)),
  ]);
  assert.equal(fx.state.purchase.attributedMemberId, "member-B");
  assert.equal(fx.state.purchase.attributedUserId, "user-B");
  assert.equal(fx.state.purchase.attributedShiftKey, null);
  assert.equal(fx.state.purchase.resolvedSource, "manual_claim_resolution");
});

function listModel(rows = []) { return { async findMany() { return rows.map((row) => ({ ...row })); } }; }
function analyticsMember() { return { id: "member-a", agencyId: "agency-1", userId: "user-a", role: "OPERATOR", displayName: "Marina", assignedCreators: ["creator-1"], createdAt: new Date(), user: { id: "user-a", email: "a@test", name: "Marina" }, teamFunctions: [] }; }
function analyticsFake({ tipCountThrows = false, currencies = { EUR: 10000 } } = {}) {
  const now = new Date();
  const ppvRows = Object.entries(currencies).map(([currency, amountCents], i) => ({ id: `p-${i}`, agencyId: "agency-1", creatorId: "creator-1", accountId: "creator-1", purchaseId: `purchase-${i}`, fanId: "fan-1", status: "attributed", attributedMemberId: "member-a", amountCents, currency, purchasedAt: now }));
  return {
    agencyMember: listModel([analyticsMember()]), teamActivityEvent: listModel([]),
    teamProjectionCoverage: { async findUnique() { return { agencyId: "agency-1", responseCoverageFrom: new Date(now.getTime() - 8 * 86400000), dialogCoverageFrom: new Date(now.getTime() - 8 * 86400000) }; } },
    teamResponseCase: listModel([]),
    teamDialogSession: listModel([{ id: "d-1", agencyId: "agency-1", creatorId: "creator-1", memberId: "member-a", dialogId: "fan-1", fanId: "fan-1", startedAt: new Date(now.getTime() - 10000), activeSeconds: 1800 }]),
    teamPendingDialogState: listModel([]),
    teamPpvPurchaseLedger: {
      async findMany() { return ppvRows.map((r) => ({ ...r })); },
      async groupBy() { return Object.entries(currencies).map(([currency, amountCents]) => ({ attributedMemberId: "member-a", currency, _sum: { amountCents } })); },
      async count() { return 0; },
    },
    teamTipLedger: { async findMany() { return []; }, async groupBy() { return []; }, async count() { if (tipCountThrows) throw new Error("tip conflict db down"); return 0; } },
    teamPpvResolveJob: { async count() { return 0; } },
  };
}

test("Closure3 mounted alerts/flags treat canonical money read failure as UNAVAILABLE", async () => {
  const analytics = loadWithPrisma(analyticsPath, analyticsFake({ tipCountThrows: true }));
  await assert.rejects(analytics.buildTeamAlerts({ agencyId: "agency-1", rangeKey: "7d", includeMoney: true }), (err) => err?.code === "TEAM_ANALYTICS_DATA_UNAVAILABLE" && err?.status === 503 && err?.section === "money_conflicts");
  await assert.rejects(analytics.buildTeamFlags({ agencyId: "agency-1", rangeKey: "7d", includeMoney: true }), (err) => err?.code === "TEAM_ANALYTICS_DATA_UNAVAILABLE" && err?.status === 503 && err?.section === "money_conflicts");
});

test("Closure3 alerts render EUR and mixed currencies explicitly, never hardcoded dollar or mixed zero", async () => {
  let analytics = loadWithPrisma(analyticsPath, analyticsFake({ currencies: { EUR: 10000 } }));
  let payload = await analytics.buildTeamAlerts({ agencyId: "agency-1", rangeKey: "7d", includeMoney: true });
  let focus = payload.alerts.find((row) => String(row.id).startsWith("focus_dialog_"));
  assert.match(focus.text, /EUR 100\.00/);
  assert.doesNotMatch(focus.text, /\$100|\$0/);

  analytics = loadWithPrisma(analyticsPath, analyticsFake({ currencies: { USD: 10000, EUR: 10000 } }));
  payload = await analytics.buildTeamAlerts({ agencyId: "agency-1", rangeKey: "7d", includeMoney: true });
  focus = payload.alerts.find((row) => String(row.id).startsWith("focus_dialog_"));
  assert.match(focus.text, /EUR 100\.00/);
  assert.match(focus.text, /USD 100\.00/);
  assert.doesNotMatch(focus.text, /\$0/);
});

test("Closure3 deployment migration locks rolling writers and has manual-precedence upsert", () => {
  const sql = source("../prisma/migrations/20260831223000_event_team_money_authority_cutover/migration.sql");
  assert.match(sql, /^BEGIN;/m);
  assert.match(sql, /LOCK TABLE "MoneyAttribution" IN SHARE ROW EXCLUSIVE MODE/);
  assert.match(sql, /LOCK TABLE "TeamTipLedger" IN SHARE ROW EXCLUSIVE MODE/);
  assert.match(sql, /manual_legacy_money_attribution_/);
  assert.match(sql, /LEFT JOIN LATERAL/);
  assert.match(sql, /WITH ORDINALITY/);
  assert.match(sql, /ON CONFLICT \("agencyId", "eventHash"\) DO UPDATE/);
  assert.match(sql, /LEFT\(EXCLUDED\."resolvedSource", 7\) = 'manual_'/);
  assert.match(sql, /COMMIT;/);
});

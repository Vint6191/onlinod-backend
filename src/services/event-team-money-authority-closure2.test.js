"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const prismaPath = require.resolve("../prisma");
const analyticsPath = require.resolve("./team-analytics-service");
const tipPath = require.resolve("./team-tip-ledger-service");
const ppvPath = require.resolve("./team-ppv-ledger-service");

function source(rel) { return fs.readFileSync(path.join(ROOT, rel), "utf8"); }
function listModel(rows = []) {
  return { async findMany() { return rows.map((row) => ({ ...row })); } };
}
function member() {
  return {
    id: "member-a", agencyId: "agency-1", userId: "user-a", role: "OPERATOR", roleKey: "chatter",
    displayName: "Marina", assignedCreators: ["creator-1"], createdAt: new Date("2026-08-01T00:00:00Z"),
    user: { id: "user-a", email: "a@test", name: "Marina" }, teamFunctions: [{ functionKey: "CHATTER" }],
  };
}
function analyticsPrisma({ responseThrows = false, dialogThrows = false, coverageThrows = false, tipThrows = false, currencies = false, ppvMixed = false } = {}) {
  const ppvRows = ppvMixed ? [
    { id: "ppv-usd", agencyId: "agency-1", accountId: "creator-1", purchaseId: "purchase-usd", status: "attributed", attributedMemberId: "member-a", amountCents: 10000, currency: "USD", financialStatus: "active", purchasedAt: new Date("2026-08-20T00:00:00Z") },
    { id: "ppv-eur", agencyId: "agency-1", accountId: "creator-1", purchaseId: "purchase-eur", status: "attributed", attributedMemberId: "member-a", amountCents: 10000, currency: "EUR", financialStatus: "active", purchasedAt: new Date("2026-08-20T00:01:00Z") },
  ] : [];
  return {
    agencyMember: listModel([member()]),
    teamActivityEvent: listModel([]),
    teamProjectionCoverage: { async findUnique() { if (coverageThrows) throw new Error("coverage db down"); return { agencyId: "agency-1", responseCoverageFrom: new Date("2026-08-01T00:00:00Z"), dialogCoverageFrom: new Date("2026-08-01T00:00:00Z") }; } },
    teamResponseCase: { async findMany() { if (responseThrows) throw new Error("db down"); return []; } },
    teamDialogSession: { async findMany() { if (dialogThrows) throw new Error("dialog db down"); return []; } },
    teamPendingDialogState: listModel([]),
    teamPpvPurchaseLedger: {
      ...listModel(ppvRows),
      async groupBy() {
        if (ppvMixed) return [
          { attributedMemberId: "member-a", currency: "USD", _sum: { amountCents: 10000 } },
          { attributedMemberId: "member-a", currency: "EUR", _sum: { amountCents: 10000 } },
        ];
        return currencies ? [{ attributedMemberId: "member-a", currency: "USD", _sum: { amountCents: 10000 } }] : [];
      },
    },
    teamTipLedger: {
      ...listModel([]),
      async groupBy() { if (tipThrows) throw new Error("money db down"); return currencies ? [{ attributedMemberId: "member-a", currency: "EUR", _sum: { amountCents: 10000 } }] : []; },
    },
  };
}
function loadAnalytics(fake) {
  delete require.cache[analyticsPath]; delete require.cache[prismaPath];
  require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: fake };
  return require(analyticsPath);
}
function loadTip(fake) {
  delete require.cache[tipPath]; delete require.cache[prismaPath];
  require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: fake };
  return require(tipPath);
}
function loadPpv(fake) {
  delete require.cache[ppvPath]; delete require.cache[prismaPath];
  require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: fake };
  return require(ppvPath);
}

test("Closure2 legacy migration reads fresh MoneyAttribution rows under FOR UPDATE SKIP LOCKED", async () => {
  let created = [];
  let deleted = [];
  const fresh = {
    id: "legacy-1", agencyId: "agency-1", eventHash: "H", eventType: "tip_received", amountCents: 10000, currency: "USD",
    occurredAt: new Date(), capturedAt: new Date(), creatorId: "creator-1", accountId: "creator-1", fanId: "fan-1",
    state: "manager", attributedToMemberId: "member-B", attributedToUserId: "user-B", locked: true,
    history: [{ action: "manager_override", byMemberId: "manager", nextOwner: "member-B", reason: "fresh manual" }],
    autoAttributedToMemberId: "member-A", autoAttributedToUserId: "user-A", autoReason: "old auto", createdAt: new Date(), updatedAt: new Date(),
  };
  const fake = {
    async $transaction(work) { return work(fake); },
    async $queryRawUnsafe(sql) { assert.match(sql, /FOR UPDATE SKIP LOCKED/); return [{ ...fresh }]; },
    moneyAttribution: {
      async findMany() { throw new Error("migration must not pre-read unlocked rows when raw locking is available"); },
      async deleteMany({ where }) { deleted = where.id.in.slice(); return { count: deleted.length }; },
    },
    teamTipLedger: {
      async findMany() { return created.map((row) => ({ agencyId: row.agencyId, eventHash: row.eventHash })); },
      async createMany({ data }) { created.push(...data.map((row) => ({ ...row }))); return { count: data.length }; },
    },
  };
  const service = loadTip(fake);
  const result = await service.migrateLegacyTipsToTipLedger({ agencyId: "agency-1", limit: 10 });
  assert.equal(result.ok, true);
  assert.equal(created.length, 1);
  assert.equal(created[0].attributedMemberId, "member-B");
  assert.equal(created[0].resolvedSource, "legacy_money_attribution_migration");
  assert.deepEqual(deleted, ["legacy-1"]);
});

test("Closure2 auto-first then manual Tip resolution ends MANUAL", async () => {
  let row = {
    id: "tip-row", agencyId: "agency-1", creatorId: "creator-1", accountId: "creator-1", eventHash: "H",
    status: "attributed", attributedMemberId: "member-auto", attributedUserId: "user-auto", resolvedSource: "creator_tip_exact_message",
    amountCents: 1000, currency: "USD", receivedAt: new Date(), financialStatus: "active", history: [], result: {}, candidates: [], weakCandidates: [],
  };
  const fake = {
    async $transaction(work) { return work(fake); },
    async $queryRaw() { return [{ ...row }]; },
    agencyMember: {
      async findFirst({ where }) { return { id: where.id || "manager", userId: where.id === "member-B" ? "user-B" : "user-manager", displayName: "x" }; },
      async findMany({ where }) { const ids = where.id?.in || []; return ids.map((id) => ({ id, userId: id === "member-B" ? "user-B" : "user-manager", displayName: id })); },
    },
    teamTipLedger: { async update({ data }) { row = { ...row, ...data }; return { ...row }; } },
    teamActivityEvent: { async create() { return { id: "notice" }; } },
  };
  const service = loadTip(fake);
  const result = await service.applyTipOverride({ agencyId: "agency-1", byMemberId: "manager", byUserId: "user-manager", eventHash: "H", action: "manager_override", targetMemberId: "member-B", reason: "manual wins", senior: true });
  assert.equal(result.ok, true);
  assert.equal(row.attributedMemberId, "member-B");
  assert.equal(row.resolvedSource, "manual_manager_resolution");
});

test("Closure2 auto-first then manual PPV resolution ends MANUAL", async () => {
  const job = {
    id: "job-1", agencyId: "agency-1", creatorId: "creator-1", accountId: "creator-1", creatorRef: "creator-1",
    purchaseId: "purchase-1", messageId: "message-1", amountCents: 1000, currency: "USD", purchasedAt: new Date(),
    status: "conflict", result: {},
  };
  let purchase = {
    id: "ppv-row", agencyId: "agency-1", creatorId: "creator-1", accountId: "creator-1", purchaseId: "purchase-1",
    messageId: "message-1", status: "attributed", attributedMemberId: "member-auto", attributedUserId: "user-auto",
    resolvedSource: "creator_sale_exact_message", amountCents: 1000, currency: "USD", purchasedAt: job.purchasedAt,
  };
  const fake = {
    async $transaction(work) { return work(fake); },
    async $queryRaw(strings) {
      const sql = Array.isArray(strings) ? strings.join("?") : String(strings);
      if (sql.includes('"TeamPpvResolveJob"')) return [{ ...job }];
      if (sql.includes('"TeamPpvPurchaseLedger"')) return [{ ...purchase }];
      return [];
    },
    agencyMember: {
      async findFirst({ where }) { return { id: where.id || "manager", userId: where.id === "member-B" ? "user-B" : "user-manager", displayName: "x", user: { id: "u", name: "x", email: "x@test" } }; },
      async findMany({ where }) { return (where.id?.in || []).map((id) => ({ id, userId: id === "member-B" ? "user-B" : "user-manager", displayName: id, user: { id, name: id, email: `${id}@test` } })); },
    },
    teamPpvPurchaseLedger: {
      async upsert({ create, update }) { purchase = { ...purchase, ...(purchase ? update : create) }; return { ...purchase }; },
    },
    teamPpvResolveJob: { async update() { return { ...job, status: "resolved" }; } },
    teamActivityEvent: { async findFirst() { return null; }, async create() { return { id: "activity" }; } },
    teamPpvClaimAudit: { async create() { return { id: "audit" }; } },
  };
  const service = loadPpv(fake);
  const result = await service.resolvePpvConflict({
    agencyId: "agency-1", jobId: "job-1", memberId: "member-B", actorMemberId: "manager", action: "assign", deviceId: "device-1", reason: "manual wins", allowedCreatorIds: ["creator-1"],
  });
  assert.equal(result.resolved, 1);
  assert.equal(purchase.attributedMemberId, "member-B");
  assert.equal(purchase.resolvedSource, "manual_claim_resolution");
});

test("Closure2 canonical response read failure is UNAVAILABLE, never authoritative zero or legacy fallback", async () => {
  const analytics = loadAnalytics(analyticsPrisma({ responseThrows: true }));
  await assert.rejects(
    analytics.buildTeamMembers({ agencyId: "agency-1", rangeKey: "7d", includeMoney: false }),
    (err) => err?.code === "TEAM_ANALYTICS_DATA_UNAVAILABLE" && err?.status === 503 && err?.section === "response_projection",
  );
});

test("Closure2 canonical dialog read failure is UNAVAILABLE, never authoritative zero or legacy fallback", async () => {
  const analytics = loadAnalytics(analyticsPrisma({ dialogThrows: true }));
  await assert.rejects(
    analytics.buildTeamMembers({ agencyId: "agency-1", rangeKey: "7d", includeMoney: false }),
    (err) => err?.code === "TEAM_ANALYTICS_DATA_UNAVAILABLE" && err?.status === 503 && err?.section === "dialog_projection",
  );
});

test("Closure2 projection coverage failure is UNAVAILABLE and never switches authority generation", async () => {
  const analytics = loadAnalytics(analyticsPrisma({ coverageThrows: true }));
  await assert.rejects(
    analytics.buildTeamMembers({ agencyId: "agency-1", rangeKey: "7d", includeMoney: false }),
    (err) => err?.code === "TEAM_ANALYTICS_DATA_UNAVAILABLE" && err?.status === 503 && err?.section === "projection_coverage",
  );
});

test("Closure2 canonical money read failure is UNAVAILABLE, never $0", async () => {
  const analytics = loadAnalytics(analyticsPrisma({ tipThrows: true }));
  await assert.rejects(
    analytics.buildTeamMembers({ agencyId: "agency-1", rangeKey: "7d", includeMoney: true }),
    (err) => err?.code === "TEAM_ANALYTICS_DATA_UNAVAILABLE" && err?.status === 503 && err?.section === "tip_revenue",
  );
});

test("Closure2 mixed currencies are never summed into one USD amount", async () => {
  const analytics = loadAnalytics(analyticsPrisma({ currencies: true }));
  const payload = await analytics.buildTeamMembers({ agencyId: "agency-1", rangeKey: "7d", includeMoney: true });
  const metrics = payload.members[0].metrics;
  assert.deepEqual(metrics.revenueByCurrency, { EUR: 10000, USD: 10000 });
  assert.equal(metrics.revenueAttributedCents, null);
  assert.equal(metrics.revenueCurrency, null);
  assert.equal(metrics.dollarsPerMessageCents, null);
});

test("Closure2 mixed-currency PPV revenue is never collapsed into one amount", async () => {
  const analytics = loadAnalytics(analyticsPrisma({ ppvMixed: true }));
  const payload = await analytics.buildTeamMembers({ agencyId: "agency-1", rangeKey: "7d", includeMoney: true });
  const metrics = payload.members[0].metrics;
  assert.deepEqual(metrics.ppvRevenueByCurrency, { EUR: 10000, USD: 10000 });
  assert.equal(metrics.ppvRevenueCents, null);
  assert.equal(metrics.ppvRevenueCurrency, null);
});

test("Closure2 old client PPV resolver generation is physically retired", () => {
  const route = source("routes/team-analytics.js");
  const ppv = source("services/team-ppv-ledger-service.js");
  assert.doesNotMatch(route, /ppv\/resolve-jobs|ppv\/resolve-results/);
  assert.doesNotMatch(route, /listResolveJobs|submitResolveResults/);
  assert.doesNotMatch(ppv, /async function listResolveJobs|async function submitResolveResults/);
  assert.doesNotMatch(ppv, /\blistResolveJobs,|\bsubmitResolveResults,/);
});

test("Closure2 legacy transition is locked migration input only, never a current manual money writer", () => {
  const tips = source("services/team-tip-ledger-service.js");
  const legacy = source("services/money-attribution-service.js");
  const claims = source("routes/team-claims.js");
  assert.match(tips, /FROM "MoneyAttribution"[\s\S]*FOR UPDATE SKIP LOCKED/);
  assert.doesNotMatch(legacy, /async function applyOverride|moneyAttribution\.update\s*\(/);
  assert.doesNotMatch(claims, /\bapplyOverride\b/);
});

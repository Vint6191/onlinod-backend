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

function memberFor(id) {
  return { id, userId: `user-${id}`, displayName: id, role: id === "manager" ? "MANAGER" : "CHATTER", roleKey: id === "manager" ? "manager" : "chatter" };
}

function claimsFake(initialRow) {
  let row = structuredClone(initialRow);
  const fake = {
    async $transaction(work) { return work(fake); },
    async $queryRaw() { return row ? [structuredClone(row)] : []; },
    agencyMember: {
      async findFirst({ where }) {
        const id = where?.id || (where?.userId ? String(where.userId).replace(/^user-/, "") : null);
        return id ? memberFor(id) : null;
      },
      async findMany({ where }) { return (where?.id?.in || []).map(memberFor); },
    },
    teamTipLedger: {
      async findMany() { return row ? [structuredClone(row)] : []; },
      async findUnique() { return row ? structuredClone(row) : null; },
      async update({ data }) { row = { ...row, ...structuredClone(data), updatedAt: new Date() }; return structuredClone(row); },
    },
    teamActivityEvent: { async create() { return { id: "notice" }; } },
    teamSentMessageLedger: { async findMany() { return []; } },
  };
  return { fake, get row() { return row; } };
}

function baseTip(overrides = {}) {
  return {
    id: "tip-1", agencyId: "agency-1", creatorId: "creator-1", accountId: "creator-1", creatorRef: "creator-1",
    eventHash: "H", tipId: "tip-H", status: "attributed", attributedMemberId: "member-A", attributedUserId: "user-member-A",
    attributedShiftKey: "shift-auto-A", resolvedSource: "creator_tip_exact_message", amountCents: 1000, currency: "USD",
    receivedAt: new Date(), financialStatus: "active", history: [], result: {}, candidates: [], weakCandidates: [],
    createdAt: new Date(), updatedAt: new Date(), ...overrides,
  };
}

test("Closure7 migration review reaches a terminal manual state and cannot reuse the >48h review bypass", async () => {
  const old = new Date(Date.now() - 72 * 60 * 60 * 1000);
  const fx = claimsFake(baseTip({
    status: "conflict", attributedMemberId: null, attributedUserId: null, attributedShiftKey: null,
    receivedAt: old, resolvedSource: "manual_legacy_money_attribution_ambiguous_requires_review",
    result: {
      audit15Closure5ManualRepairScan: { classified: true, classification: "ambiguous_legacy_authority_requires_review", requiresManualReview: true },
      audit15Closure6MigrationAuthority: { classified: true, classification: "ambiguous_legacy_authority_requires_review", requiresManualReview: true },
    },
  }));
  const tips = loadWithPrisma(fx.fake);

  const resolved = await tips.applyTipOverride({
    agencyId: "agency-1", byMemberId: "manager", byUserId: "user-manager", eventHash: "H",
    action: "manager_override", targetMemberId: "member-B", reason: "resolve migrated ambiguity", senior: true,
    allowedCreatorIds: ["creator-1"],
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.attribution.requiresManualReview, false);
  assert.equal(resolved.attribution.reviewLane, null);
  assert.equal(fx.row.result.audit15Closure5ManualRepairScan.requiresManualReview, false);
  assert.equal(fx.row.result.audit15Closure6MigrationAuthority.requiresManualReview, false);
  assert.equal(fx.row.attributedMemberId, "member-B");
  assert.equal(fx.row.attributedUserId, "user-member-B");
  assert.equal(fx.row.attributedShiftKey, null);
  assert.match(fx.row.resolvedSource, /^manual_manager_migration_review/);
  assert.ok(fx.row.history.some((item) => item.action === "audit15_closure7_finalize_migration_review"));

  const reread = await tips.listTipClaims({ agencyId: "agency-1", limit: 10, senior: true, includeMigrationReview: true, allowedCreatorIds: ["creator-1"] });
  assert.equal(reread[0].requiresManualReview, false);
  assert.equal(reread[0].reviewLane, null);

  const second = await tips.applyTipOverride({
    agencyId: "agency-1", byMemberId: "manager", byUserId: "user-manager", eventHash: "H",
    action: "manager_override", targetMemberId: "member-C", reason: "should be normal locked history now", senior: true,
    allowedCreatorIds: ["creator-1"],
  });
  assert.equal(second.ok, false);
  assert.equal(second.code, "ATTRIBUTION_LOCKED");
});

test("Closure7 migration review to creator revenue is terminal and clears stale review metadata", async () => {
  const old = new Date(Date.now() - 72 * 60 * 60 * 1000);
  const fx = claimsFake(baseTip({
    status: "conflict", attributedMemberId: null, attributedUserId: null, attributedShiftKey: "shift-should-not-survive",
    receivedAt: old, resolvedSource: "manual_legacy_money_attribution_ambiguous_requires_review",
    result: {
      audit15Closure5ManualRepairScan: { classified: true, requiresManualReview: true },
      audit15Closure6MigrationAuthority: { classified: true, requiresManualReview: true },
    },
  }));
  const tips = loadWithPrisma(fx.fake);
  const resolved = await tips.applyTipOverride({
    agencyId: "agency-1", byMemberId: "manager", byUserId: "user-manager", eventHash: "H",
    action: "manager_override", targetMemberId: null, reason: "creator revenue after migration review", senior: true,
    allowedCreatorIds: ["creator-1"],
  });
  assert.equal(resolved.ok, true);
  assert.equal(fx.row.status, "creator_revenue");
  assert.equal(fx.row.attributedMemberId, null);
  assert.equal(fx.row.attributedUserId, null);
  assert.equal(fx.row.attributedShiftKey, null);
  assert.equal(resolved.attribution.requiresManualReview, false);
  assert.equal(resolved.attribution.reviewLane, null);
  assert.equal(fx.row.result.audit15Closure5ManualRepairScan.requiresManualReview, false);
  assert.equal(fx.row.result.audit15Closure6MigrationAuthority.requiresManualReview, false);
  assert.equal(fx.row.resolvedSource, "manual_manager_migration_review_creator_revenue");
});

test("Closure7 canonical Claims read failures are typed UNAVAILABLE for disputable, event audit, and list audit", async () => {
  const dbDown = new Error("db down");
  const fake = {
    teamTipLedger: {
      async findMany() { throw dbDown; },
      async findUnique() { throw dbDown; },
    },
  };
  const tips = loadWithPrisma(fake);
  await assert.rejects(
    tips.listTipClaims({ agencyId: "agency-1", senior: true }),
    (err) => err?.code === "TEAM_CLAIMS_DATA_UNAVAILABLE" && err?.status === 503 && err?.section === "tip_claims_disputable",
  );
  await assert.rejects(
    tips.getTipClaimByHash({ agencyId: "agency-1", eventHash: "H" }),
    (err) => err?.code === "TEAM_CLAIMS_DATA_UNAVAILABLE" && err?.status === 503 && err?.section === "tip_claim_audit_event",
  );
  await assert.rejects(
    tips.listTipAudit({ agencyId: "agency-1", senior: true }),
    (err) => err?.code === "TEAM_CLAIMS_DATA_UNAVAILABLE" && err?.status === 503 && err?.section === "tip_claim_audit_list",
  );
});

test("Closure7 Claims routes consult legacy rows only after a successful canonical read and preserve typed 503", () => {
  const route = source("routes/team-claims.js");
  const disputable = route.slice(route.indexOf('router.get("/disputable"'), route.indexOf('router.get("/audit"'));
  assert.ok(disputable.indexOf("const tipRows = await listTipClaims") < disputable.indexOf("const legacyRows = await listDisputable"));
  const disputableReadWindow = disputable.slice(disputable.indexOf("const tipRows = await listTipClaims"), disputable.indexOf("const rows = [...tipRows"));
  assert.doesNotMatch(disputableReadWindow, /Promise\.all/);
  assert.match(disputable, /sendClaimsReadError\(res, err, "CLAIMS_DISPUTABLE_FAILED"\)/);

  const audit = route.slice(route.indexOf('router.get("/audit"'), route.indexOf('router.post("/sweep"'));
  assert.ok(audit.indexOf("await getTipClaimByHash") < audit.indexOf("prisma.moneyAttribution.findUnique"));
  const firstList = audit.indexOf("const tipRows = await listTipAudit");
  const firstLegacy = audit.indexOf("const legacyRows = await prisma.moneyAttribution.findMany", firstList);
  assert.ok(firstList >= 0 && firstLegacy > firstList);
  const auditReadWindow = audit.slice(firstList, firstLegacy + "const legacyRows = await prisma.moneyAttribution.findMany".length);
  assert.doesNotMatch(auditReadWindow, /Promise\.all/);
  assert.match(audit, /sendClaimsReadError\(res, err, "CLAIMS_AUDIT_FAILED"\)/);
  assert.match(route, /status = Number\(err\?\.status\) \|\| 500[\s\S]*err\?\.section/);
});

for (const scenario of [
  { name: "claim", action: "claim", initial: { status: "attributed", attributedMemberId: "member-A", attributedUserId: "user-member-A" }, actor: "member-A", target: null, expectedStatus: "claimed", expectedMember: "member-A", expectedUser: "user-member-A" },
  { name: "release", action: "release", initial: { status: "claimed", attributedMemberId: "member-A", attributedUserId: "user-member-A" }, actor: "member-A", target: null, expectedStatus: "released", expectedMember: null, expectedUser: null },
  { name: "manager member reassignment", action: "manager_override", initial: { status: "attributed", attributedMemberId: "member-A", attributedUserId: "user-member-A" }, actor: "manager", target: "member-B", expectedStatus: "resolved", expectedMember: "member-B", expectedUser: "user-member-B" },
  { name: "manager creator revenue", action: "manager_override", initial: { status: "attributed", attributedMemberId: "member-A", attributedUserId: "user-member-A" }, actor: "manager", target: null, expectedStatus: "creator_revenue", expectedMember: null, expectedUser: null },
]) {
  test(`Closure7 Tip manual owner tuple is atomic for ${scenario.name}`, async () => {
    const fx = claimsFake(baseTip({ ...scenario.initial, attributedShiftKey: "shift-auto-A" }));
    const tips = loadWithPrisma(fx.fake);
    const result = await tips.applyTipOverride({
      agencyId: "agency-1", byMemberId: scenario.actor, byUserId: `user-${scenario.actor}`, eventHash: "H",
      action: scenario.action, targetMemberId: scenario.target, reason: scenario.action === "manager_override" ? "manual ownership decision" : "manual",
      senior: scenario.action === "manager_override", allowedCreatorIds: ["creator-1"],
    });
    assert.equal(result.ok, true);
    assert.equal(fx.row.status, scenario.expectedStatus);
    assert.equal(fx.row.attributedMemberId, scenario.expectedMember);
    assert.equal(fx.row.attributedUserId, scenario.expectedUser);
    assert.equal(fx.row.attributedShiftKey, null);
    assert.equal(fx.row.result.manualResolution.shiftKey, null);
    assert.match(fx.row.resolvedSource, /^manual_/);
  });
}

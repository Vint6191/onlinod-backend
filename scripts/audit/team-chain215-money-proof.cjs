"use strict";
// Native PostgreSQL proof of the canonical CreatorTip -> attribution -> claim
// -> durable fact -> rollup chain. Provider observations and identities are
// fixtures; reconciliation, claim authority, SQL triggers and rollups are real.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

async function runTeamMoneyProof({ db, backendRoot = path.resolve(__dirname, "../..") }) {
  const load = createRequire(path.join(backendRoot, "package.json"));
  const prismaPath = load.resolve("./src/prisma");
  require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: db };
  const { scope } = load("./scripts/audit/analytics-traffic/fixture.cjs");
  const { runRootCommit } = load("./src/services/db-commit-kernel");
  const { lockCreatorFacts } = load("./src/services/creator-fact-write-authority");
  const money = load("./src/services/team-money-reconciliation-service");
  const claims = load("./src/services/team-tip-ledger-service");
  const rollups = load("./src/services/team-money-rollup-authority-service");
  const now = new Date((await db.$queryRawUnsafe("SELECT clock_timestamp() AS now"))[0].now);
  const commit = fn => runRootCommit(db, ({ tx }) => fn(tx));
  const checks = [];
  const check = async (name, work) => {
    const outcome = { name, ok: false }; checks.push(outcome);
    try { await work(outcome); outcome.ok = true; }
    catch (error) { outcome.error = { code: error.code || null, message: error.message, actual: error.actual, expected: error.expected }; }
  };
  async function fixture(suffix) {
    const prefix = `money215-${suffix}`;
    const s = await scope(db, { agencyId: `${prefix}-agency`, creatorId: `${prefix}-creator`, userId: `${prefix}-owner` });
    s.memberId = `member-${s.agencyId}`;
    s.actor = await db.agencyMember.findUnique({ where: { id: s.memberId } });
    s.send = (id, fan, age, options = {}) => commit(tx => tx.teamSentMessageLedger.create({ data: {
      id, agencyId: s.agencyId, accountId: s.creatorId, creatorId: s.creatorId, localSeed: id,
      messageId: id, fanId: fan, dialogId: fan, sentAt: new Date(+now - age),
      memberId: s.memberId, userId: s.userId, source: "manual", ...options,
    } }));
    s.fan = (id, external) => commit(tx => tx.creatorFan.create({ data: {
      id, agencyId: s.agencyId, creatorId: s.creatorId, onlyFansUserId: external,
    } }));
    s.addMember = async (id) => {
      await commit(async tx => {
        await tx.$queryRawUnsafe("SELECT set_config('onlinod.phase2_team_control_plane_generation','phase2_team_control_plane_v2_durable_access',true)");
        await tx.user.create({ data: { id: `${id}-user`, email: `${id}@example.test`, passwordHash: "fixture" } });
        await tx.agencyMember.create({ data: { id, agencyId: s.agencyId, userId: `${id}-user`, role: "OPERATOR", roleKey: "chatter", assignedCreators: [s.creatorId] } });
      });
      return db.agencyMember.findUnique({ where: { id } });
    };
    s.tip = async (id, overrides = {}) => {
      await commit(async tx => {
        await lockCreatorFacts(tx, s.agencyId, s.creatorId);
        await tx.creatorTip.create({ data: { id, agencyId: s.agencyId, creatorId: s.creatorId,
          eventFingerprint: crypto.createHash("sha256").update(id).digest("hex"), externalTransactionId: id,
          amountCents: 2500, netCents: 2000, currency: "USD", tippedAt: now, transactionStatus: "done", ...overrides } });
      });
      return (await money.reconcileCreatorTipToTeam({ db, tipId: id })).attribution;
    };
    s.correct = async (id, data) => {
      await commit(async tx => {
        await lockCreatorFacts(tx, s.agencyId, s.creatorId);
        await tx.creatorTip.update({ where: { id }, data });
      });
      return (await money.reconcileCreatorTipToTeam({ db, tipId: id })).attribution;
    };
    s.action = (row, action = "claim", extra = {}) => claims.applyTipOverride({
      db, agencyId: s.agencyId, actorMember: s.actor, byUserId: s.userId, byMemberId: s.memberId,
      eventHash: row.eventHash, action, allowedCreatorIds: [s.creatorId], ...extra,
    });
    s.fact = row => db.teamMoneyAttributionFact.findFirst({ where: { creatorTipId: row.creatorTipId } });
    s.project = async row => {
      const fact = await s.fact(row);
      assert(fact, "canonical root must project a durable fact in its own commit");
      await rollups.applyTeamMoneyFactToRollups({ db, agencyId: s.agencyId, factId: fact.id });
      return fact;
    };
    s.buckets = async () => (await db.teamMoneyLifetimeRollup.findMany({ where: { agencyId: s.agencyId }, orderBy: { currency: "asc" } }))
      .map(row => ({ memberId: row.memberId, currency: row.currency, cents: row.amountCents.toString(), count: row.factCount }));
    return s;
  }

  await check("unknown buyer cannot borrow another dialog's candidate or self-claim authority", async out => {
    const s = await fixture("unknown"); await s.send("unknown-message", "other-fan", 180000);
    const row = await s.tip("unknown-tip"); const claim = await s.action(row);
    out.observed = { candidates: row.candidates, claimOk: claim.ok, code: claim.code };
    assert.deepEqual(row.candidates, []); assert.equal(claim.code, "CLAIM_NOT_ELIGIBLE");
    assert.equal((await s.fact(row)).attributionActive, false);
  });
  await check("retained buyer identity survives absent live relation and excludes other dialogs", async out => {
    const s = await fixture("retained"); await s.send("retained-other", "other-fan", 180000);
    const row = await s.tip("retained-tip", { fanOnlyFansUserIdAtEvent: "retained-fan" });
    const claim = await s.action(row);
    out.observed = { fanId: row.fanId, candidates: row.candidates, claimOk: claim.ok };
    assert.equal(row.fanId, "retained-fan"); assert.deepEqual(row.candidates, []); assert.equal(claim.code, "CLAIM_NOT_ELIGIBLE");
  });
  await check("old cached candidate JSON cannot authorize an unrelated worker", async out => {
    const s = await fixture("cached"); await s.send("cached-message", "different-fan", 60000);
    const row = await s.tip("cached-tip", { fanOnlyFansUserIdAtEvent: "actual-fan" });
    await commit(tx => tx.teamTipLedger.update({ where: { id: row.id }, data: {
      candidates: [{ memberId: s.memberId }], result: { candidates: [{ memberId: s.memberId }] },
    } }));
    const claim = await s.action(row); out.observed = { ok: claim.ok, code: claim.code };
    assert.equal(claim.code, "CLAIM_NOT_ELIGIBLE");
    assert.equal((await db.teamTipLedger.findUnique({ where: { id: row.id } })).attributedMemberId, null);
  });
  for (const [label, age, primary, weak, claimable] of [
    ["future", -1, 0, 0, false], ["same-millisecond", 0, 1, 0, true],
    ["ten-minutes", 600000, 1, 0, true], ["ten-minutes-plus-one-ms", 600001, 0, 1, true],
    ["fifteen-minutes", 900000, 0, 1, true], ["fifteen-minutes-plus-one-ms", 900001, 0, 0, false],
  ]) await check(`exact candidate/claim boundary: ${label}`, async out => {
    const s = await fixture(label); const fan = `${label}-fan`;
    await s.fan(`${fan}-record`, fan); await s.send(`${label}-message`, fan, age);
    const row = await s.tip(`${label}-tip`, { fanRecordId: `${fan}-record` });
    const claim = await s.action(row);
    out.observed = { primary: row.candidates.length, weak: row.weakCandidates.length, claimOk: claim.ok, code: claim.code };
    assert.equal(row.candidates.length, primary); assert.equal(row.weakCandidates.length, weak); assert.equal(claim.ok, claimable);
  });
  await check("two workers remain candidates after two hundred newer messages by one worker", async out => {
    const s = await fixture("volume"); const other = await s.addMember("volume-other-member");
    await s.fan("volume-fan-record", "volume-fan"); await s.send("volume-older", "volume-fan", 540000);
    await commit(tx => tx.teamSentMessageLedger.createMany({ data: Array.from({ length: 200 }, (_, i) => ({
      id: `volume-newer-${i}`, agencyId: s.agencyId, accountId: s.creatorId, creatorId: s.creatorId,
      localSeed: `volume-newer-${i}`, messageId: `volume-newer-${i}`, fanId: "volume-fan", dialogId: "volume-fan",
      sentAt: new Date(+now - 60000 - i), memberId: other.id, userId: other.userId, source: "manual",
    })) }));
    const row = await s.tip("volume-tip", { fanRecordId: "volume-fan-record" });
    out.observed = { status: row.status, candidates: row.candidates.map(candidate => candidate.memberId) };
    assert.equal(row.status, "conflict"); assert.equal(row.candidates.length, 2);
    assert.equal((await s.action(row)).code, "TIP_CONFLICT_MANAGER_REQUIRED");
  });
  await check("same provider fan ID on another creator cannot supply claim evidence", async out => {
    const s = await fixture("creator-scope");
    await commit(async tx => {
      await tx.$queryRawUnsafe("SELECT set_config('onlinod.phase2_creator_writer_generation','phase2_creator_writer_v2_actual56_postcut',true)");
      await tx.creatorAccount.create({ data: { id: "different-creator", agencyId: s.agencyId, displayName: "Other creator", remoteId: "different-creator", status: "READY" } });
    });
    await s.fan("creator-scope-fan", "shared-fan");
    await s.send("creator-scope-message", "shared-fan", 120000, { accountId: "different-creator", creatorId: "different-creator" });
    const row = await s.tip("creator-scope-tip", { fanRecordId: "creator-scope-fan" });
    const claim = await s.action(row); out.observed = { candidates: row.candidates, code: claim.code };
    assert.deepEqual(row.candidates, []); assert.equal(claim.code, "CLAIM_NOT_ELIGIBLE");
  });
  await check("automatic sources containing manual text do not grant a worker claim", async out => {
    const s = await fixture("nonhuman"); await s.fan("nonhuman-fan-record", "nonhuman-fan");
    for (const [i, source] of ["automation_manual", "manual_broadcast", "manual_campaign", "mystery"].entries()) {
      await s.send(`nonhuman-message-${i}`, "nonhuman-fan", 60000 + i, { source });
    }
    const row = await s.tip("nonhuman-tip", { fanRecordId: "nonhuman-fan-record" });
    out.observed = { candidates: row.candidates, code: (await s.action(row)).code };
    assert.deepEqual(row.candidates, []); assert.equal(out.observed.code, "CLAIM_NOT_ELIGIBLE");
  });
  for (const [label, elapsed, allowed] of [["one-ms-before-48h", 172799999, true], ["exactly-48h", 172800000, false]]) {
    await check(`claim grace boundary: ${label}`, async out => {
      const s = await fixture(label); await s.fan(`${label}-fan-record`, `${label}-fan`);
      await s.send(`${label}-message`, `${label}-fan`, elapsed + 60000);
      const row = await s.tip(`${label}-tip`, { fanRecordId: `${label}-fan-record`, tippedAt: new Date(+now - elapsed) });
      const originalNow = Date.now; let claim;
      try { Date.now = () => +now; claim = await s.action(row); } finally { Date.now = originalNow; }
      out.observed = { ok: claim.ok, code: claim.code };
      assert.equal(claim.ok, allowed); if (!allowed) assert.equal(claim.code, "ATTRIBUTION_LOCKED");
    });
  }
  await check("valid retained-fan claim records owner/audit and contributes GROSS once through concurrent replay", async out => {
    const s = await fixture("valid"); await s.send("valid-message", "valid-fan", 120000);
    const row = await s.tip("valid-tip", { fanOnlyFansUserIdAtEvent: "valid-fan", netCents: 1701 });
    assert.equal(row.status, "unresolved");
    const claim = await s.action(row); assert.equal(claim.ok, true);
    let current = await db.teamTipLedger.findUnique({ where: { id: row.id } });
    assert.equal(current.attributedMemberId, s.memberId); assert.equal(current.result.manualResolutions.length, 1);
    const fact = await s.project(row);
    await Promise.all([money.reconcileCreatorTipToTeam({ db, tipId: row.creatorTipId }), money.reconcileCreatorTipToTeam({ db, tipId: row.creatorTipId })]);
    await Promise.all([1, 2].map(() => rollups.applyTeamMoneyFactToRollups({ db, agencyId: s.agencyId, factId: fact.id })));
    current = await db.teamTipLedger.findUnique({ where: { id: row.id } });
    const buckets = await s.buckets(); out.observed = { owner: current.attributedMemberId, manualAuditEntries: current.result.manualResolutions.length, buckets };
    assert.equal(current.result.manualResolutions.length, 1);
    assert.equal(await db.teamTipLedger.count({ where: { creatorTipId: row.creatorTipId } }), 1);
    assert.equal(await db.teamMoneyAttributionFact.count({ where: { creatorTipId: row.creatorTipId } }), 1);
    assert.equal(await db.teamMoneyRollupContribution.count({ where: { sourceFactId: fact.id } }), 1);
    assert.deepEqual(buckets, [{ memberId: s.memberId, currency: "USD", cents: "2500", count: 1 }]);
  });
  await check("manual ownership survives USD amount correction, unknown gross, refund and restoration", async out => {
    const s = await fixture("correction"); await s.send("correction-message", "correction-fan", 120000);
    const row = await s.tip("correction-tip", { fanOnlyFansUserIdAtEvent: "correction-fan" });
    assert.equal((await s.action(row)).ok, true); await s.project(row);
    const corrected = await s.correct(row.creatorTipId, { amountCents: 3107, netCents: 2222, currency: "USD" });
    assert.equal(corrected.attributedMemberId, s.memberId); assert.equal(corrected.status, "claimed"); await s.project(row);
    assert.deepEqual(await s.buckets(), [
      { memberId: s.memberId, currency: "USD", cents: "3107", count: 1 },
    ]);
    const unknown = await s.correct(row.creatorTipId, { amountCents: null, netCents: 2222 });
    const unknownFact = await s.project(row);
    assert.equal(unknown.financialStatus, "gross_unknown"); assert.equal(unknownFact.attributionActive, false);
    assert.equal((await s.action(row)).code, "TIP_FINANCIAL_REVERSED");
    assert((await s.buckets()).every(bucket => bucket.cents === "0"));
    const refunded = await s.correct(row.creatorTipId, { amountCents: 3107, transactionStatus: "refunded" });
    assert.equal(refunded.attributedMemberId, s.memberId); assert.equal((await s.project(row)).attributionActive, false);
    const restored = await s.correct(row.creatorTipId, { transactionStatus: "done" }); await s.project(row);
    out.observed = { owner: restored.attributedMemberId, financialStatus: restored.financialStatus, buckets: await s.buckets() };
    assert.equal(restored.result.manualResolutions.length, 1);
    assert.equal((await s.buckets()).find(bucket => bucket.currency === "USD").cents, "3107");
  });
  await check("late exact manual evidence resolves the same canonical tip root without recent-window guessing", async out => {
    const s = await fixture("late");
    const row = await s.tip("late-tip", { messageId: "late-message", fanOnlyFansUserIdAtEvent: "late-fan" });
    assert.equal(row.status, "unresolved");
    await s.send("late-message", "late-fan", 1800000);
    const reconciled = (await money.reconcileCreatorTipToTeam({ db, tipId: row.creatorTipId })).attribution;
    const fact = await s.project(row);
    out.observed = { sameRoot: reconciled.id === row.id, status: reconciled.status, basis: reconciled.attributionBasis, cents: fact.amountCents };
    assert.equal(reconciled.id, row.id); assert.equal(reconciled.attributedMemberId, s.memberId);
    assert.equal(reconciled.attributionBasis, "EXACT_MESSAGE_MANUAL"); assert.equal(fact.amountCents, 2500);
  });
  await check("manager resolution for unknown fan stays explicit and survives canonical replay", async out => {
    const s = await fixture("manager"); const row = await s.tip("manager-tip");
    assert.equal((await s.action(row, "manager_override", { targetMemberId: s.memberId, reason: "ok" })).code, "RESOLUTION_REASON_REQUIRED");
    const action = await s.action(row, "manager_override", { targetMemberId: s.memberId, reason: "Reviewed external proof", senior: true });
    assert.equal(action.ok, true);
    const current = (await money.reconcileCreatorTipToTeam({ db, tipId: row.creatorTipId })).attribution;
    out.observed = { owner: current.attributedMemberId, status: current.status, audit: current.result.manualResolutions };
    assert.equal(current.status, "resolved"); assert.equal(current.attributedMemberId, s.memberId);
    assert.equal(current.result.manualResolutions.length, 1); assert.equal(current.result.manualResolutions[0].reason, "Reviewed external proof");
  });
  await check("180-day compaction preserves manual audit/owner and later financial retraction", async out => {
    const s = await fixture("retention"); await s.send("retention-message", "retention-fan", 120000);
    const row = await s.tip("retention-tip", { fanOnlyFansUserIdAtEvent: "retention-fan" });
    assert.equal((await s.action(row)).ok, true);
    const oldAt = new Date(+now - 181 * 86400000);
    await s.correct(row.creatorTipId, { tippedAt: oldAt }); await s.project(row);
    const before = await db.teamTipLedger.findUnique({ where: { id: row.id } });
    const retention = await commit(tx => load("./src/services/team-ledger-retention-service").runTeamLedgerRetentionPage({
      db: tx, agencyId: s.agencyId, kind: "tips", cutoff: new Date(+now - 180 * 86400000), now,
    }));
    const compacted = await db.teamTipLedger.findUnique({ where: { id: row.id } });
    assert.equal(retention.compacted, 1); assert(compacted.compactedAt);
    assert.equal(compacted.attributedMemberId, s.memberId); assert.deepEqual(compacted.history, before.history);
    assert.equal(compacted.candidates, null);
    const corrected = await s.correct(row.creatorTipId, { transactionStatus: "undo" }); const fact = await s.project(row);
    out.observed = { compacted: retention.compacted, sameRoot: corrected.id === row.id, owner: corrected.attributedMemberId, financialStatus: fact.financialStatus, buckets: await s.buckets() };
    assert.equal(corrected.id, row.id); assert.equal(corrected.attributedMemberId, s.memberId);
    assert.equal(fact.attributionActive, false); assert((await s.buckets()).every(bucket => bucket.cents === "0"));
  });
  return { ok: checks.every(check => check.ok), engine: "native PostgreSQL + actual reconciliation, Claims authority, triggers and rollups", checks, productionAccessed: false };
}

module.exports = { runTeamMoneyProof };
if (require.main === module) (async () => {
  const runtime = await require(process.env.NOD_TEAM_NATIVE_FIXTURE).createNativeRuntime();
  try {
    const result = await runTeamMoneyProof({ db: runtime.db, backendRoot: process.env.NOD_NATIVE_BACKEND_ROOT });
    const serialized = JSON.stringify(result, (_, value) => typeof value === "bigint" ? value.toString() : value, 2);
    fs.writeFileSync(path.join(process.env.NOD_AUDIT_NATIVE_OUTPUT, "team-money-result.json"), serialized);
    console.log(serialized); if (!result.ok) process.exitCode = 1;
  } finally { await runtime.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

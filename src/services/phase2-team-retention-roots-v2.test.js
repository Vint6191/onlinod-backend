"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { deriveContribution, backfillActivityContributionBatch } = require("./team-activity-contribution-authority-service");

function loadTeamPpvServiceWithDb(db) {
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "team-ppv-ledger-service.js"), "utf8");
  const module = { exports: {} };
  const requireStub = (request) => {
    if (request === "../prisma") return db;
    if (request === "./management-commit-authority-service") return { assertManagementCommitAuthority: async () => ({}) };
    if (request === "./historical-attribution-target-authority-service") return { resolveHistoricalAttributionTarget: async () => ({}) };
    if (request === "../utils/prisma-transaction") return { serializableTxOptions: () => ({}) };
    if (request === "./team-money-reconciliation-service") return { reconcileMoneyForSentMessageEvidence: async () => ({}) };
    throw new Error(`unexpected require ${request}`);
  };
  vm.runInNewContext(source, { module, exports: module.exports, require: requireStub, console, Date, Set, Map, Math, Number, String, Array, Object, JSON, Promise, Buffer, Error }, { filename: "team-ppv-ledger-service.js" });
  return module.exports;
}

function confirmedMessage(localId) {
  return {
    id: `raw-${localId}`, agencyId: "agency-1", deviceId: "device-1", localId,
    source: "electron_team_v13", eventKind: "MESSAGE_SEND_CONFIRMED", actionSource: "MANUAL", lifecycle: "CONFIRMED",
    memberId: "member-1", creatorId: "creator-1", accountId: "creator-1", messageId: "message-1",
    isPpv: true, priceCents: 2500, mediaCount: 0, ts: new Date("2026-08-12T10:00:00Z"),
    historicalProjectionVersion: "team_activity_daily_v1", historicalProjectedAt: new Date("2026-08-12T10:00:01Z"),
  };
}

test("A37 semantic contribution identity is independent from transport localId", () => {
  const a = deriveContribution(confirmedMessage("transport-a"));
  const b = deriveContribution(confirmedMessage("transport-b"));
  assert.equal(a.semanticKey, "creator-1:message:message-1");
  assert.equal(b.semanticKey, a.semanticKey);
  assert.equal(a.contribution.messagesSent, 1);
  assert.equal(a.contribution.ppvSentMessages, 1);
});

test("contributing event without stable business identity fails closed instead of using localId", () => {
  const row = confirmedMessage("transport-only");
  row.messageId = null;
  const derived = deriveContribution(row);
  assert.equal(derived.contributes, true);
  assert.equal(derived.stable, false);
  assert.equal(derived.semanticKey, null);
  assert.equal(derived.version, "team_activity_unkeyed_v2");
});

test("bounded v1 baseline enumeration installs dedup identity without incrementing daily again", async () => {
  const rows = [confirmedMessage("old-1")];
  const contributions = new Map();
  const updates = [];
  const db = {
    teamActivityEvent: {
      async findMany() { return rows.filter((r) => r.historicalProjectionVersion === "team_activity_daily_v1"); },
      async update({ where, data }) { const row = rows.find((r) => r.id === where.id); Object.assign(row, data); updates.push({ where, data }); return row; },
    },
    teamActivityContribution: {
      async upsert({ where, create }) {
        const key = `${where.agencyId_eventKind_semanticKey.agencyId}:${where.agencyId_eventKind_semanticKey.eventKind}:${where.agencyId_eventKind_semanticKey.semanticKey}`;
        if (!contributions.has(key)) contributions.set(key, { ...create });
        return contributions.get(key);
      },
    },
  };
  const first = await backfillActivityContributionBatch({ db, agencyId: "agency-1", limit: 100 });
  const second = await backfillActivityContributionBatch({ db, agencyId: "agency-1", cursor: first.nextCursor, limit: 100 });
  assert.equal(first.baseline, 1);
  assert.equal(first.unresolved, 0);
  assert.equal(contributions.size, 1);
  assert.equal([...contributions.values()][0].state, "APPLIED_BASELINE");
  assert.equal(rows[0].historicalProjectionVersion, "team_activity_contribution_v2");
  assert.equal(second.rows, 0);
  assert.equal(updates.length, 1);
});

test("retention-roots migration uses contribution ON CONFLICT and never performs global money root history scan", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260910034500_phase2_team_retention_roots/migration.sql"), "utf8");
  assert.match(sql, /TeamActivityContribution/);
  assert.match(sql, /ON CONFLICT \("agencyId","eventKind","semanticKey"\) DO NOTHING/);
  assert.match(sql, /GET DIAGNOSTICS v_inserted = ROW_COUNT/);
  assert.match(sql, /SEALED_LEGACY/);
  assert.doesNotMatch(sql, /INSERT INTO "TeamPpvPurchaseLedger"[\s\S]*SELECT f\./);
  assert.doesNotMatch(sql, /INSERT INTO "TeamTipLedger"[\s\S]*SELECT f\./);
  assert.match(sql, /TeamResponseCase[\s\S]*projectionState[\s\S]*NEEDS_REPAIR/);
  assert.match(sql, /TeamResponseCase_agency_projection_state_reply_idx/);
});

test("stable Team money roots are compacted, not deleted by retention", () => {
  const ppv = fs.readFileSync(path.join(__dirname, "team-ppv-ledger-service.js"), "utf8");
  const tip = fs.readFileSync(path.join(__dirname, "team-tip-ledger-service.js"), "utf8");
  assert.match(ppv, /teamPpvPurchaseLedger\.updateMany/);
  assert.doesNotMatch(ppv, /teamPpvPurchaseLedger\.deleteMany\(\{[\s\S]{0,500}historicalFactVersion/);
  assert.match(tip, /teamTipLedger\.updateMany/);
  assert.match(tip, /compactedAt/);
});


test("R15/R6 Team ledger retention preserves compact roots and yields after one bounded unit", async () => {
  const calls = { sentUpdated: [], purchasesUpdated: [], jobsExpired: [], jobsDeleted: [] };
  const db = {
    teamSentMessageLedger: {
      async findMany({ take }) { return [{ id: "s1" }, { id: "s2" }, { id: "s3" }].slice(0, take); },
      async updateMany({ where, data }) { calls.sentUpdated.push({ where, data }); return { count: where.id.in.length }; },
    },
    teamPpvPurchaseLedger: {
      async findMany({ take }) { return [{ id: "p1" }, { id: "p2" }, { id: "p3" }].slice(0, take); },
      async updateMany({ where, data }) { calls.purchasesUpdated.push({ where, data }); return { count: where.id.in.length }; },
    },
    teamPpvResolveJob: {
      async findMany({ where, take }) {
        if (where.status === "pending") return [{ id: "pending-1" }, { id: "pending-2" }, { id: "pending-3" }].slice(0, take);
        return [{ id: "done-1" }, { id: "done-2" }, { id: "done-3" }].slice(0, take);
      },
      async updateMany({ where, data }) { calls.jobsExpired.push({ where, data }); return { count: where.id.in.length }; },
      async deleteMany({ where }) { calls.jobsDeleted.push(where); return { count: where.id.in.length }; },
    },
  };
  const { gcTeamLedgers } = loadTeamPpvServiceWithDb(db);
  const result = await gcTeamLedgers({ db, now: new Date("2026-09-10T00:00:00Z"), olderThanMs: 1, limit: 2 });
  assert.equal(result.sentMessageLedger, 0, "sent proof roots are compacted, never TTL-deleted");
  assert.equal(result.sentMessageLedgerCompacted, 2);
  assert.equal(result.ppvPurchaseLedgerCompacted, 2);
  assert.equal(result.ppvResolveJob, 2);
  assert.equal(result.hasMore, true, "full bounded pages must yield with continuation work visible");
  assert.deepEqual(calls.sentUpdated[0].where.id.in, ["s1", "s2"]);
  assert.equal(calls.sentUpdated[0].data.mediaIds, null);
  assert.equal(calls.sentUpdated[0].data.rootVersion, "team_sent_root_v2");
});

test("retention compacts response/dialog/coverage only behind explicit consumer watermark authority", () => {
  const retention = fs.readFileSync(path.join(__dirname, "retention-service.js"), "utf8");
  assert.match(retention, /compactTeamProjectionAuthorityForAgency/);
  assert.match(retention, /projectionState:\s*"FULL"/);
  assert.match(retention, /response_repair_coverage_incomplete/);
  assert.match(retention, /retainedFrom:\s*cutoff/);
  assert.match(retention, /phase2_retention_vector_v3/);
});

"use strict";

const { isCommitTransaction } = require("./db-commit-kernel");
const { runRetentionMutation } = require("./retention-work-context-service");

// Each entry is one independently committed work unit. First bound discovery,
// then skip busy rows inside that page: SKIP LOCKED alone can walk an unbounded
// locked backlog. A short/empty picked page is not evidence of completion.
const PAGE_LIMIT = 500;
const TERMINAL = "l.status IN ('resolved','expired','rejected')";
const PAGES = Object.freeze({
  sent: {
    table: "TeamSentMessageLedger", time: "sentAt",
    predicate: 'l."sentAt" < $1 AND l."compactedAt" IS NULL',
    set: '"mediaIds"=NULL,"compactedAt"=$3,"rootVersion"=\'team_sent_root_v2\'',
    label: "teamSentMessageLedger.compacted", counter: "compacted",
  },
  purchases: {
    table: "TeamPpvPurchaseLedger", time: "purchasedAt",
    predicate: `l."purchasedAt" < $1 AND l."compactedAt" IS NULL
      AND l.status IN ('resolved','expired','attributed','unresolved','rejected','creator_revenue')
      AND l."historicalFactVersion"='team_money_fact_v2' AND l."historicalFactProjectedAt" IS NOT NULL`,
    set: '"compactedAt"=$3,"rootVersion"=\'team_money_root_v2\'',
    label: "teamPpvPurchaseLedger.compacted", counter: "compacted",
  },
  tips: {
    table: "TeamTipLedger", time: "receivedAt",
    predicate: `l."receivedAt" < $1 AND l."compactedAt" IS NULL
      AND l."historicalFactVersion"='team_money_fact_v2' AND l."historicalFactProjectedAt" IS NOT NULL`,
    set: 'candidates=NULL,"weakCandidates"=NULL,result=NULL,"compactedAt"=$3,"rootVersion"=\'team_money_root_v2\'',
    label: "teamTipLedger.compacted", counter: "compacted",
  },
  expireJobs: {
    table: "TeamPpvResolveJob", time: "expiresAt",
    predicate: "l.status='pending' AND l.\"expiresAt\" < $1",
    set: "status='expired',\"updatedAt\"=$3",
    label: "teamPpvResolveJob.expired", counter: "expired",
  },
  expiredJobs: {
    table: "TeamPpvResolveJob", time: "expiresAt",
    predicate: `${TERMINAL} AND l."expiresAt" < $1`,
    label: "teamPpvResolveJob.expired_history", counter: "deleted",
  },
  oldJobs: {
    table: "TeamPpvResolveJob", time: "createdAt",
    predicate: `${TERMINAL} AND l."createdAt" < $1`,
    label: "teamPpvResolveJob.old_history", counter: "deleted",
  },
});

async function runTeamLedgerRetentionPage({ kind, cutoff, now, limit = PAGE_LIMIT, agencyId = null, dryRun = false, db = require("../prisma") }) {
  const page = PAGES[kind];
  if (!page) throw new Error("TEAM_LEDGER_RETENTION_PAGE_INVALID");
  if (![cutoff, now].every(value => value instanceof Date && Number.isFinite(+value))) {
    throw new Error("TEAM_LEDGER_RETENTION_TIME_INVALID");
  }
  const take = Math.min(PAGE_LIMIT, Math.max(1, Math.floor(Number(limit) || PAGE_LIMIT)));
  const scopedAgency = agencyId ? String(agencyId) : null;
  const predicate = `${page.predicate} AND ($4::text IS NULL OR l."agencyId"=$4)`;
  const order = `l."${page.time}",l.id`;
  const execute = async tx => {
    const discovery = `SELECT l.id FROM "${page.table}" l WHERE ${predicate} ORDER BY ${order} LIMIT $2`;
    // Keep all parameters typed even for dry runs and delete-only pages.
    const prefix = 'WITH authority AS (SELECT $3::timestamp AS at), candidates AS MATERIALIZED';
    const sql = dryRun
      ? `${prefix} (${discovery}) SELECT count(*)::int AS matched,0::int AS picked,0::int AS affected FROM candidates`
      : `${prefix} (${discovery}), picked AS MATERIALIZED (
          SELECT l.id FROM "${page.table}" l JOIN candidates c ON c.id=l.id
          WHERE ${predicate} ORDER BY ${order} FOR UPDATE OF l SKIP LOCKED
        ), changed AS (
          ${page.set
            ? `UPDATE "${page.table}" l SET ${page.set} FROM picked p WHERE l.id=p.id AND ${predicate}`
            : `DELETE FROM "${page.table}" l USING picked p WHERE l.id=p.id AND ${predicate}`}
          RETURNING l.id
        ) SELECT (SELECT count(*)::int FROM candidates) AS matched,
                 (SELECT count(*)::int FROM picked) AS picked,
                 (SELECT count(*)::int FROM changed) AS affected`;
    const [row] = await tx.$queryRawUnsafe(sql, cutoff, take, now, scopedAgency);
    const matched = Number(row.matched), picked = Number(row.picked), affected = Number(row.affected);
    return {
      ok: true, label: page.label, matched, affected, deleted: 0, compacted: 0, expired: 0,
      [page.counter]: affected, skippedBusy: dryRun ? 0 : matched - picked,
      hasMore: matched >= take || (!dryRun && affected < matched),
      dryRun: Boolean(dryRun), workBudgetRows: take,
    };
  };
  if (dryRun) return execute(db);
  return isCommitTransaction(db) ? execute(db) : runRetentionMutation(execute, db);
}

module.exports = { runTeamLedgerRetentionPage, PAGE_LIMIT };

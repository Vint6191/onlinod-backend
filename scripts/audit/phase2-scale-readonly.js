"use strict";

/*
 * Phase 2 large-data evidence harness.
 *
 * Safety contract:
 * - explicit opt-in only;
 * - no seed / delete / update / migration work;
 * - reads one caller-selected Agency;
 * - EXPLAIN ANALYZE is separately opt-in because it intentionally executes the
 *   measured SELECTs and can be expensive on a large production-like dataset.
 *
 * Required:
 *   ONLINOD_PHASE2_SCALE_BENCHMARK=1
 *   ONLINOD_PHASE2_SCALE_AGENCY_ID=<agency id>
 *
 * Optional:
 *   ONLINOD_PHASE2_SCALE_EXPLAIN=1
 *   ONLINOD_PHASE2_SCALE_REQUIRE_LARGE=1
 *   ONLINOD_PHASE2_SCALE_MAX_RAW_ROWS_PER_MEMBER=64
 */

function envFlag(name) {
  return String(process.env[name] || "").trim() === "1";
}

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function finiteInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function bigintToNumber(value) {
  if (typeof value === "bigint") return Number(value);
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function msSince(start) {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function bytesToMiB(bytes) {
  return Math.round((Number(bytes || 0) / 1024 / 1024) * 100) / 100;
}

function sqlLabel(sql) {
  const text = String(sql || "").replace(/\s+/g, " ").trim();
  const known = [
    "TeamMemberActivityDaily",
    "TeamActivityEvent",
    "TeamMoneyAttributionFact",
    "TeamResponseCase",
    "TeamDialogSession",
    "TeamPendingDialogState",
    "TeamHistoricalAnalyticsCoverage",
  ];
  const hit = known.find((name) => text.includes(`\"${name}\"`));
  return hit || text.slice(0, 96);
}

async function countDataset(prisma, agencyId) {
  const where = { agencyId };
  const [
    members,
    activityDays,
    moneyFacts,
    responseCases,
    dialogSessions,
    pendingDialogs,
  ] = await Promise.all([
    prisma.agencyMember.count({ where: { agencyId, deletedAt: null } }),
    prisma.teamMemberActivityDaily.count({ where }),
    prisma.teamMoneyAttributionFact.count({ where }),
    prisma.teamResponseCase.count({ where }),
    prisma.teamDialogSession.count({ where }),
    prisma.teamPendingDialogState.count({ where: { agencyId, status: "PENDING" } }),
  ]);
  const creatorRows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(DISTINCT x."creatorId")::bigint AS "count"
       FROM (
         SELECT "creatorId" FROM "TeamMemberActivityDaily" WHERE "agencyId" = $1 AND "creatorId" IS NOT NULL
         UNION ALL
         SELECT "creatorId" FROM "TeamMoneyAttributionFact" WHERE "agencyId" = $1 AND "creatorId" IS NOT NULL
       ) x`,
    agencyId,
  );
  return {
    members,
    creatorsTouched: bigintToNumber(creatorRows?.[0]?.count),
    activityDays,
    moneyFacts,
    responseCases,
    dialogSessions,
    pendingDialogs,
  };
}

async function measureSnapshot({ prisma, buildTeamAnalyticsSnapshot, agencyId, includeMoney }) {
  const originalRaw = prisma.$queryRawUnsafe.bind(prisma);
  const rawQueries = [];
  prisma.$queryRawUnsafe = async function phase2ScaleObservedRaw(sql, ...params) {
    const start = process.hrtime.bigint();
    const rows = await originalRaw(sql, ...params);
    rawQueries.push({
      label: sqlLabel(sql),
      rows: Array.isArray(rows) ? rows.length : null,
      durationMs: Math.round(msSince(start) * 100) / 100,
      touchesMoneyFacts: String(sql || "").includes('"TeamMoneyAttributionFact"'),
    });
    return rows;
  };

  const heapBefore = process.memoryUsage().heapUsed;
  const start = process.hrtime.bigint();
  try {
    const payload = await buildTeamAnalyticsSnapshot({
      agencyId,
      rangeKey: "all",
      includeMoney,
      allowedCreatorIds: null,
    });
    const wallMs = Math.round(msSince(start) * 100) / 100;
    const heapAfter = process.memoryUsage().heapUsed;
    const members = Array.isArray(payload?.members) ? payload.members : [];
    let maxTopDialogs = 0;
    for (const row of members) {
      maxTopDialogs = Math.max(maxTopDialogs, Array.isArray(row?.metrics?.topDialogSessions) ? row.metrics.topDialogSessions.length : 0);
    }
    return {
      wallMs,
      heapDeltaMiB: bytesToMiB(heapAfter - heapBefore),
      membersReturned: members.length,
      maxTopDialogsPerMember: maxTopDialogs,
      authorityVersion: payload?.snapshot?.authorityVersion || null,
      queryShape: payload?.projection?.queryShape || null,
      rawQueryCount: rawQueries.length,
      rawRowsReturned: rawQueries.reduce((sum, item) => sum + Math.max(0, Number(item.rows || 0)), 0),
      moneyFactRawQueries: rawQueries.filter((item) => item.touchesMoneyFacts).length,
      rawQueries,
    };
  } finally {
    prisma.$queryRawUnsafe = originalRaw;
  }
}

function structuralChecks({ dataset, withoutMoney, withMoney }) {
  const memberBase = Math.max(1, dataset.members, withoutMoney.membersReturned, withMoney.membersReturned);
  const maxRowsPerMember = finiteInt(process.env.ONLINOD_PHASE2_SCALE_MAX_RAW_ROWS_PER_MEMBER, 64);
  const maxRawRows = memberBase * maxRowsPerMember + 256;
  return [
    {
      id: "authority_version",
      ok: withoutMoney.authorityVersion === "team_analytics_read_authority_v1" && withMoney.authorityVersion === "team_analytics_read_authority_v1",
      actual: [withoutMoney.authorityVersion, withMoney.authorityVersion],
    },
    {
      id: "bounded_query_shape",
      ok: withoutMoney.queryShape === "sql_aggregate_bounded_v1" && withMoney.queryShape === "sql_aggregate_bounded_v1",
      actual: [withoutMoney.queryShape, withMoney.queryShape],
    },
    {
      id: "money_off_reads_zero_money_facts",
      ok: withoutMoney.moneyFactRawQueries === 0,
      actual: withoutMoney.moneyFactRawQueries,
    },
    {
      id: "top_dialogs_bounded",
      ok: Math.max(withoutMoney.maxTopDialogsPerMember, withMoney.maxTopDialogsPerMember) <= 10,
      actual: Math.max(withoutMoney.maxTopDialogsPerMember, withMoney.maxTopDialogsPerMember),
    },
    {
      id: "raw_result_cardinality_bounded",
      ok: withoutMoney.rawRowsReturned <= maxRawRows && withMoney.rawRowsReturned <= maxRawRows,
      actual: { withoutMoney: withoutMoney.rawRowsReturned, withMoney: withMoney.rawRowsReturned, maxRawRows },
    },
  ];
}

function largeDatasetChecks(dataset) {
  return [
    { id: "members>=100", ok: dataset.members >= 100, actual: dataset.members },
    { id: "creatorsTouched>=500", ok: dataset.creatorsTouched >= 500, actual: dataset.creatorsTouched },
    { id: "moneyFacts>=1000000", ok: dataset.moneyFacts >= 1_000_000, actual: dataset.moneyFacts },
    { id: "responses>=100000", ok: dataset.responseCases >= 100_000, actual: dataset.responseCases },
    { id: "dialogs>=100000", ok: dataset.dialogSessions >= 100_000, actual: dataset.dialogSessions },
    { id: "pending>=10000", ok: dataset.pendingDialogs >= 10_000, actual: dataset.pendingDialogs },
  ];
}

async function explainRepresentativeQueries(prisma, agencyId) {
  const detailDays = finiteInt(process.env.ONLINOD_PHASE2_SCALE_DETAIL_DAYS, 180);
  const queries = [
    {
      id: "activity_all_grouped_by_member",
      sql: `SELECT d."memberId", SUM(d."messagesSent")::bigint AS messages
              FROM "TeamMemberActivityDaily" d
             WHERE d."agencyId" = $1 AND d."memberId" IS NOT NULL
             GROUP BY d."memberId"`,
      params: [agencyId],
    },
    {
      id: "money_all_grouped_by_member_currency",
      sql: `SELECT m."memberId", m."currency", COUNT(*)::bigint AS facts, SUM(m."amountCents")::bigint AS cents
              FROM "TeamMoneyAttributionFact" m
             WHERE m."agencyId" = $1 AND m."memberId" IS NOT NULL AND m."attributionActive" = TRUE
             GROUP BY m."memberId", m."currency"`,
      params: [agencyId],
    },
    {
      id: "responses_retained_detail_grouped_by_member",
      sql: `SELECT r."memberId", COUNT(*)::bigint AS cases,
                   AVG(r."wallClockSeconds"::double precision) FILTER (WHERE r."slaEligible" = TRUE) AS avg_seconds,
                   percentile_cont(0.9) WITHIN GROUP (ORDER BY r."wallClockSeconds") FILTER (WHERE r."slaEligible" = TRUE) AS p90_seconds
              FROM "TeamResponseCase" r
             WHERE r."agencyId" = $1
               AND r."memberId" IS NOT NULL
               AND r."replyAt" >= clock_timestamp() - ($2::int * interval '1 day')
             GROUP BY r."memberId"`,
      params: [agencyId, detailDays],
    },
    {
      id: "dialogs_retained_detail_top10_by_member",
      sql: `WITH ranked AS (
              SELECT s."memberId", s."creatorId",
                     COALESCE(NULLIF(s."fanId",''), s."dialogId") AS "fanKey",
                     COUNT(*)::bigint AS sessions,
                     COALESCE(SUM(s."activeSeconds"),0)::bigint AS dwell,
                     ROW_NUMBER() OVER (
                       PARTITION BY s."memberId"
                       ORDER BY COALESCE(SUM(s."activeSeconds"),0) DESC,
                                COALESCE(NULLIF(s."fanId",''), s."dialogId") ASC
                     ) AS rn
                FROM "TeamDialogSession" s
               WHERE s."agencyId" = $1
                 AND s."startedAt" >= clock_timestamp() - ($2::int * interval '1 day')
               GROUP BY s."memberId", s."creatorId", COALESCE(NULLIF(s."fanId",''), s."dialogId")
            )
            SELECT * FROM ranked WHERE rn <= 10`,
      params: [agencyId, detailDays],
    },
    {
      id: "pending_current_grouped_by_owner",
      sql: `SELECT p."ownerMemberId", COUNT(*)::bigint AS pending
              FROM "TeamPendingDialogState" p
             WHERE p."agencyId" = $1 AND p."status" = 'PENDING'
             GROUP BY p."ownerMemberId"`,
      params: [agencyId],
    },
  ];
  const out = [];
  for (const item of queries) {
    const start = process.hrtime.bigint();
    const rows = await prisma.$queryRawUnsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${item.sql}`, ...(item.params || []));
    const planRoot = rows?.[0]?.["QUERY PLAN"]?.[0] || null;
    out.push({
      id: item.id,
      wallMs: Math.round(msSince(start) * 100) / 100,
      planningMs: planRoot?.["Planning Time"] ?? null,
      executionMs: planRoot?.["Execution Time"] ?? null,
      planRows: planRoot?.Plan?.["Actual Rows"] ?? null,
      sharedHitBlocks: planRoot?.Plan?.["Shared Hit Blocks"] ?? null,
      sharedReadBlocks: planRoot?.Plan?.["Shared Read Blocks"] ?? null,
    });
  }
  return out;
}

async function main() {
  if (!envFlag("ONLINOD_PHASE2_SCALE_BENCHMARK")) {
    throw new Error("ONLINOD_PHASE2_SCALE_BENCHMARK=1_REQUIRED");
  }
  const agencyId = requiredEnv("ONLINOD_PHASE2_SCALE_AGENCY_ID");

  // Set before loading Prisma so its event mode can be enabled by an operator if desired.
  const prisma = require("../../src/prisma");
  const { buildTeamAnalyticsSnapshot } = require("../../src/services/team-analytics-service");

  try {
    const agency = await prisma.agency.findUnique({ where: { id: agencyId }, select: { id: true } });
    if (!agency) throw new Error("ONLINOD_PHASE2_SCALE_AGENCY_NOT_FOUND");

    const dataset = await countDataset(prisma, agencyId);
    const withoutMoney = await measureSnapshot({ prisma, buildTeamAnalyticsSnapshot, agencyId, includeMoney: false });
    const withMoney = await measureSnapshot({ prisma, buildTeamAnalyticsSnapshot, agencyId, includeMoney: true });
    const checks = structuralChecks({ dataset, withoutMoney, withMoney });
    const largeChecks = largeDatasetChecks(dataset);
    const explain = envFlag("ONLINOD_PHASE2_SCALE_EXPLAIN")
      ? await explainRepresentativeQueries(prisma, agencyId)
      : [];

    const report = {
      ok: checks.every((item) => item.ok) && (!envFlag("ONLINOD_PHASE2_SCALE_REQUIRE_LARGE") || largeChecks.every((item) => item.ok)),
      mode: "READ_ONLY_EXISTING_DATA",
      agencyId,
      range: "all",
      dataset,
      withoutMoney,
      withMoney,
      checks,
      largeDatasetQualification: {
        required: envFlag("ONLINOD_PHASE2_SCALE_REQUIRE_LARGE"),
        qualified: largeChecks.every((item) => item.ok),
        checks: largeChecks,
      },
      explainEnabled: envFlag("ONLINOD_PHASE2_SCALE_EXPLAIN"),
      explain,
      generatedAt: new Date().toISOString(),
    };

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 2;
  } finally {
    if (typeof prisma.$disconnect === "function") await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("[phase2-scale-readonly]", err?.stack || err?.message || err);
  process.exitCode = 1;
});

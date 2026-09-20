#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const { PrismaClient } = require("@prisma/client");
const { CURRENT_STATE_FALLBACK_EXPLAIN_SQL } = require("../database/phase3-campaign-coverage-generation-online-preflight");
const { withPhase3PostgresFixtureAuthority } = require("./phase3-postgres-proof-fixture-authority");

const mode = String(process.argv[2] || "").trim().toLowerCase();
const nonce = String(process.env.ONLINOD_A20_SEED_NONCE || "seeded").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48) || "seeded";
const historyRows = Math.max(0, Math.min(100000, Number(process.env.ONLINOD_A20_SEED_HISTORY_ROWS || 20000) || 20000));
const currentGenerationRows = Math.max(1, Math.min(50000, Number(process.env.ONLINOD_A20_SEED_CURRENT_ROWS || 10000) || 10000));
const p = (name) => `a205-${nonce}-${name}`;
const ids = {
  agency: p("agency"),
  manualCreator: p("manual-creator"),
  automaticCreator: p("auto-creator"),
  fallbackCreator: p("fallback-creator"),
  missingCreator: p("missing-creator"),
  manualJob: p("manual-job"),
  automaticJob: p("auto-job"),
  fallbackCurrentJob: p("fallback-current-job"),
  fallbackOldJob: p("fallback-old-job"),
};

async function seed(db) {
  return withPhase3PostgresFixtureAuthority(db, async (tx) => {
  const now = new Date("2040-04-01T00:00:00.000Z");
  await tx.$executeRawUnsafe(`INSERT INTO "Agency" ("id","name","createdAt","updatedAt") VALUES ($1,$2,$3,$3)`, ids.agency, `A20.5 seeded ${nonce}`, now);
  for (const creatorId of [ids.manualCreator, ids.automaticCreator, ids.fallbackCreator, ids.missingCreator]) {
    await tx.$executeRawUnsafe(`INSERT INTO "CreatorAccount" ("id","agencyId","displayName","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$4)`, creatorId, ids.agency, creatorId, now);
  }
  const jobs = [
    [ids.manualJob, ids.manualCreator, { campaignFreshnessCoverageVersion: 1, manualCampaignScan: true }, { driverPhase: "execute", jobContinuation: { collectorVersion: "campaigns-v13-wrapped" } }, null],
    [ids.automaticJob, ids.automaticCreator, { campaignFreshnessCoverageVersion: 1 }, { collectorVersion: "campaigns-v13-unwrapped" }, null],
    [ids.fallbackCurrentJob, ids.fallbackCreator, {}, null, { collectorVersion: "campaigns-v13-result" }],
    [ids.fallbackOldJob, ids.fallbackCreator, { manualCampaignScan: true }, null, { collectorVersion: "campaigns-v12-old" }],
  ];
  for (const [id, creatorId, params, continuation, result] of jobs) {
    await tx.$executeRawUnsafe(
      `INSERT INTO "JobInstance" ("id","jobKey","scope","creatorId","agencyId","params","status","continuation","result","createdAt","updatedAt") VALUES ($1,'fetch_campaigns','creator',$2,$3,$4::jsonb,'DONE',$5::jsonb,$6::jsonb,$7,$7)`,
      id, creatorId, ids.agency, JSON.stringify(params), continuation ? JSON.stringify(continuation) : null, result ? JSON.stringify(result) : null, now,
    );
  }
  const states = [
    [p("state-manual"), ids.manualCreator, "run-manual", ids.manualJob],
    [p("state-auto"), ids.automaticCreator, "run-auto", ids.automaticJob],
    [p("state-fallback"), ids.fallbackCreator, "run-current", null],
    [p("state-missing"), ids.missingCreator, "run-missing", p("deleted-job")],
  ];
  for (const [id, creatorId, runId, sourceJobId] of states) {
    await tx.$executeRawUnsafe(
      `INSERT INTO "CreatorCampaignCollectionState" ("id","agencyId","creatorId","status","mode","fanValueCoverageScanRunId","sourceJobId","createdAt","updatedAt") VALUES ($1,$2,$3,'PARTIAL','catchup',$4,$5,$6,$6)`,
      id, ids.agency, creatorId, runId, sourceJobId, now,
    );
  }
  const insertWork = async ({ id, runId, fanId, campaignJobId }) => {
    await tx.$executeRawUnsafe(
      `INSERT INTO "CreatorCampaignFanRefreshWork" ("id","agencyId","creatorId","scanRunId","scanStartedAt","onlyFansUserId","campaignJobId","freshnessCutoffAt","status","scheduledAt","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$5,'QUEUED',$5,$5,$5)`,
      id, ids.agency, ids.fallbackCreator, runId, now, fanId, campaignJobId,
    );
  };
  await insertWork({ id: p("work-old"), runId: "run-old", fanId: "fan-old", campaignJobId: ids.fallbackOldJob });
  await insertWork({ id: p("work-current"), runId: "run-current", fanId: "fan-current", campaignJobId: ids.fallbackCurrentJob });

  if (currentGenerationRows > 1) {
    const started = performance.now();
    await tx.$executeRawUnsafe(`
      INSERT INTO "CreatorCampaignFanRefreshWork" (
        "id","agencyId","creatorId","scanRunId","scanStartedAt","onlyFansUserId","campaignJobId",
        "freshnessCutoffAt","status","scheduledAt","createdAt","updatedAt"
      )
      SELECT
        $1 || '-current-work-' || g::text,
        $2,
        $3,
        'run-current',
        $4,
        'current-fan-' || g::text,
        $5,
        $4,
        'QUEUED',
        $4,$4,$4
      FROM generate_series(2, $6::int) AS g
    `, p("bulk"), ids.agency, ids.fallbackCreator, now, ids.fallbackCurrentJob, currentGenerationRows);
    const durationMs = Math.round((performance.now() - started) * 100) / 100;
    console.log(`# A20_11_SEEDED_CURRENT_GENERATION ${JSON.stringify({ currentGenerationRows, insertDurationMs: durationMs })}`);
  }

  if (historyRows > 0) {
    const started = performance.now();
    await tx.$executeRawUnsafe(`
      INSERT INTO "CreatorCampaignFanRefreshWork" (
        "id","agencyId","creatorId","scanRunId","scanStartedAt","onlyFansUserId","campaignJobId",
        "freshnessCutoffAt","status","scheduledAt","createdAt","updatedAt"
      )
      SELECT
        $1 || '-hist-work-' || g::text,
        $2,
        $3,
        'historical-' || g::text,
        $4,
        'hist-fan-' || g::text,
        $5,
        $4,
        'QUEUED',
        $4,$4,$4
      FROM generate_series(1, $6::int) AS g
    `, p("bulk"), ids.agency, ids.fallbackCreator, now, ids.fallbackOldJob, historyRows);
    const durationMs = Math.round((performance.now() - started) * 100) / 100;
    console.log(`# A20_5_SEEDED_HISTORY ${JSON.stringify({ historyRows, insertDurationMs: durationMs })}`);
  }
  console.log(`# A20_5_SEEDED_ROLLING_SEED ${JSON.stringify({ ok: true, nonce, historyRows, currentGenerationRows })}`);

  });
}
async function verify(db) {
  const rows = await db.$queryRawUnsafe(`
    SELECT "creatorId", "fanValueCoverageDelegated", "fanValueCoverageOwnerKind",
           "fanValueCoverageCollectorVersion", "fanValueCoverageSourceJobId", "fanValueCoverageScanRunId"
    FROM "CreatorCampaignCollectionState"
    WHERE "creatorId" = ANY($1::text[])
    ORDER BY "creatorId"
  `, [ids.manualCreator, ids.automaticCreator, ids.fallbackCreator, ids.missingCreator]);
  const byCreator = new Map(rows.map((row) => [String(row.creatorId), row]));
  const manual = byCreator.get(ids.manualCreator);
  assert.equal(manual.fanValueCoverageDelegated, true);
  assert.equal(manual.fanValueCoverageOwnerKind, "MANUAL");
  assert.equal(manual.fanValueCoverageCollectorVersion, "campaigns-v13-wrapped");
  assert.equal(manual.fanValueCoverageSourceJobId, ids.manualJob);

  const automatic = byCreator.get(ids.automaticCreator);
  assert.equal(automatic.fanValueCoverageDelegated, true);
  assert.equal(automatic.fanValueCoverageOwnerKind, "AUTOMATIC");
  assert.equal(automatic.fanValueCoverageCollectorVersion, "campaigns-v13-unwrapped");
  assert.equal(automatic.fanValueCoverageSourceJobId, ids.automaticJob);

  const fallback = byCreator.get(ids.fallbackCreator);
  assert.equal(fallback.fanValueCoverageDelegated, true);
  assert.equal(fallback.fanValueCoverageOwnerKind, "AUTOMATIC");
  assert.equal(fallback.fanValueCoverageCollectorVersion, "campaigns-v13-result");
  assert.equal(fallback.fanValueCoverageSourceJobId, ids.fallbackCurrentJob, "superseded historical work must not win current-generation authority backfill");

  const missing = byCreator.get(ids.missingCreator);
  assert.equal(missing.fanValueCoverageDelegated, false);
  assert.equal(missing.fanValueCoverageOwnerKind, null);
  assert.equal(missing.fanValueCoverageCollectorVersion, null);
  assert.equal(missing.fanValueCoverageSourceJobId, null);

  const { readManualCampaignScan } = require("../../src/services/campaign-scan-control-service");
  const reader = await readManualCampaignScan({
    db,
    creator: { id: ids.fallbackCreator, agencyId: ids.agency },
    limit: 1,
    offset: 0,
  });
  assert.equal(reader.currentCoverageScanRunId, "run-current");
  assert.equal(reader.currentCoverageDelegated, true);
  assert.equal(reader.currentCoverageOwnerKind, "AUTOMATIC");
  assert.equal(reader.currentCoverageCollectorVersion, "campaigns-v13-result");
  assert.equal(reader.currentCoverageSourceJobId, ids.fallbackCurrentJob);
  assert.equal(reader.fanRefreshDelegated, true);

  // A20.6 proves the migration-lineage-safe online preflight rather than the
  // historical all-work DISTINCT ON migration. The preflight starts from the
  // one current collection-state row per creator and probes only that exact
  // creator+scanRun. Large superseded history must therefore stay out of the
  // physical work scan.
  const explain = await db.$queryRawUnsafe(CURRENT_STATE_FALLBACK_EXPLAIN_SQL);
  const payload = explain?.[0]?.["QUERY PLAN"] || explain?.[0] || null;
  const roots = Array.isArray(payload) ? payload : payload ? [payload] : [];
  let workRowsVisited = 0;
  let workPlanNodes = 0;
  let executionTimeMs = null;
  let currentRunIndexUsed = false;
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (executionTimeMs === null && Number.isFinite(Number(node["Execution Time"]))) executionTimeMs = Number(node["Execution Time"]);
    if (String(node["Index Name"] || "") === "CreatorCampaignFanRefreshWork_creator_run_id_idx") currentRunIndexUsed = true;
    if (String(node["Relation Name"] || "") === "CreatorCampaignFanRefreshWork") {
      const loops = Math.max(1, Number(node["Actual Loops"] || 1));
      const rows = Math.max(0, Number(node["Actual Rows"] || 0));
      const removed = Math.max(0, Number(node["Rows Removed by Filter"] || 0));
      workRowsVisited += (rows + removed) * loops;
      workPlanNodes += 1;
    }
    for (const child of Array.isArray(node.Plans) ? node.Plans : []) visit(child);
    if (node.Plan) visit(node.Plan);
  };
  for (const root of roots) visit(root);
  assert.ok(workPlanNodes > 0, "seeded migration proof must expose a physical CreatorCampaignFanRefreshWork plan node");
  const visitBudget = Math.max(500, Math.ceil(currentGenerationRows * 0.02));
  assert.equal(currentRunIndexUsed, true, "large current-generation proof must use CreatorCampaignFanRefreshWork_creator_run_id_idx");
  assert.ok(
    workRowsVisited <= visitBudget,
    `current-state migration preflight visited ${workRowsVisited} work rows with currentGenerationRows=${currentGenerationRows}; budget=${visitBudget}`,
  );
  console.log(`# A20_6_SEEDED_BACKFILL_EXPLAIN_METRICS ${JSON.stringify({ historyRows, currentGenerationRows, workRowsVisited, visitBudget, workPlanNodes, currentRunIndexUsed, executionTimeMs })}`);
  console.log(`# A20_6_SEEDED_BACKFILL_EXPLAIN ${JSON.stringify(payload)}`);
  console.log(`# A20_5_SEEDED_ROLLING_VERIFY ${JSON.stringify({ ok: true, nonce, historyRows, currentGenerationRows })}`);
}

(async () => {
  if (!["seed", "verify"].includes(mode)) throw new Error("usage: phase3-a20-seeded-rolling-coverage.js <seed|verify>");
  const db = new PrismaClient();
  try {
    if (mode === "seed") await seed(db);
    else await verify(db);
  } finally {
    await db.$disconnect();
  }
})().catch((error) => {
  console.error(`# A20_5_SEEDED_ROLLING_FAIL ${error?.stack || error}`);
  process.exitCode = 1;
});

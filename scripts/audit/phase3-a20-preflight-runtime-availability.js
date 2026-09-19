#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { setTimeout: delay } = require("node:timers/promises");
const { PrismaClient } = require("@prisma/client");
const {
  ensureAuthorityColumns,
  backfillAuthority,
} = require("../database/phase3-campaign-coverage-generation-online-preflight");

const nonce = String(process.env.ONLINOD_A20_SEED_NONCE || "seeded").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48) || "seeded";
const p = (name) => `a205-${nonce}-${name}`;
const fallbackCreator = p("fallback-creator");
const missingCreator = p("missing-creator");

async function main() {
  const ddl = new PrismaClient();
  const blocker = new PrismaClient();
  const backfillDb = new PrismaClient();
  const writer = new PrismaClient();
  let releaseBlocker;
  let blockerReadyResolve;
  const blockerReady = new Promise((resolve) => { blockerReadyResolve = resolve; });
  const release = new Promise((resolve) => { releaseBlocker = resolve; });
  try {
    const ddlResult = await ensureAuthorityColumns(ddl);
    assert.ok(ddlResult && typeof ddlResult.altered === "boolean");

    const blockerTask = blocker.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT "id" FROM "CreatorCampaignCollectionState" WHERE "creatorId" = $1 FOR UPDATE`,
        fallbackCreator,
      );
      assert.equal(rows.length, 1, "seeded fallback state row must exist");
      blockerReadyResolve();
      await release;
    }, { maxWait: 30_000, timeout: 60_000 });
    await blockerReady;

    let backfillSettled = false;
    const backfillTask = backfillAuthority(backfillDb).then(
      (value) => { backfillSettled = true; return value; },
      (error) => { backfillSettled = true; throw error; },
    );
    await delay(250);
    assert.equal(backfillSettled, false, "backfill must be blocked on the seeded fallback row for this proof");

    const started = Date.now();
    const updated = await writer.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '1500ms'`);
      return tx.creatorCampaignCollectionState.updateMany({
        where: { creatorId: missingCreator },
        data: { updatedAt: new Date("2040-04-01T00:00:01.000Z") },
      });
    }, { maxWait: 5_000, timeout: 5_000 });
    const runtimeWriterMs = Date.now() - started;
    assert.equal(Number(updated?.count || 0), 1, "unrelated runtime state writer must stay available during backfill");
    assert.ok(runtimeWriterMs < 1500, `runtime writer exceeded statement timeout while backfill was blocked: ${runtimeWriterMs}ms`);

    releaseBlocker();
    await blockerTask;
    const backfillResult = await backfillTask;
    assert.ok(backfillResult && Number.isFinite(Number(backfillResult.directUpdated)) && Number.isFinite(Number(backfillResult.fallbackUpdated)));
    console.log(`# A20_11_PREFLIGHT_RUNTIME_AVAILABILITY_PASS ${JSON.stringify({ ddlAltered: ddlResult.altered === true, runtimeWriterMs, directUpdated: Number(backfillResult.directUpdated || 0), fallbackUpdated: Number(backfillResult.fallbackUpdated || 0) })}`);
  } finally {
    if (releaseBlocker) releaseBlocker();
    await Promise.allSettled([ddl.$disconnect(), blocker.$disconnect(), backfillDb.$disconnect(), writer.$disconnect()]);
  }
}

main().catch((error) => {
  console.error(`# A20_11_PREFLIGHT_RUNTIME_AVAILABILITY_FAIL ${error?.stack || error}`);
  process.exitCode = 1;
});

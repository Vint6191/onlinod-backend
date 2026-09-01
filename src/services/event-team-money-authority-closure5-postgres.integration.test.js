"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function rollbackTx(prisma, work, sentinel) {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '4s'");
      await work(tx);
      throw new Error(sentinel);
    });
    throw new Error(`${sentinel}: transaction unexpectedly committed`);
  } catch (err) {
    if (err?.message !== sentinel) throw err;
  }
}

async function seedPair(prisma) {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT m."id" AS "moneyId", t."id" AS "tipId"
    FROM "MoneyAttribution" m
    JOIN "TeamTipLedger" t
      ON t."agencyId" = m."agencyId" AND t."eventHash" = m."eventHash"
    WHERE m."eventType" = 'tip_received'
    ORDER BY m."id"
    LIMIT 1
  `);
  return rows?.[0] || null;
}

async function legacyRuntimeDml(tx, pair, moneyRowLocked) {
  // Exact pre-Closure5 runtime shape: no table serialization lock.
  await tx.$queryRawUnsafe('SELECT "id" FROM "MoneyAttribution" WHERE "id" = $1 FOR UPDATE', pair.moneyId);
  moneyRowLocked.resolve();
  await tx.$executeRawUnsafe('UPDATE "TeamTipLedger" SET "updatedAt" = "updatedAt" WHERE "id" = $1', pair.tipId);
  await tx.$executeRawUnsafe('DELETE FROM "MoneyAttribution" WHERE "id" = $1', pair.moneyId);
}

async function currentRuntimeDml(tx, pair, tableLocked) {
  await tx.$executeRawUnsafe('LOCK TABLE "MoneyAttribution" IN SHARE ROW EXCLUSIVE MODE');
  tableLocked.resolve();
  await tx.$queryRawUnsafe('SELECT "id" FROM "MoneyAttribution" WHERE "id" = $1 FOR UPDATE', pair.moneyId);
  await tx.$executeRawUnsafe('UPDATE "TeamTipLedger" SET "updatedAt" = "updatedAt" WHERE "id" = $1', pair.tipId);
  await tx.$executeRawUnsafe('DELETE FROM "MoneyAttribution" WHERE "id" = $1', pair.moneyId);
}

async function deploymentDml(tx, pair, tableLocked) {
  // Closure5 hardens the still-pending historical migration with ACCESS
  // EXCLUSIVE. It conflicts with legacy runtime ROW SHARE at SELECT FOR UPDATE.
  await tx.$executeRawUnsafe('LOCK TABLE "MoneyAttribution" IN ACCESS EXCLUSIVE MODE');
  tableLocked.resolve();
  await tx.$executeRawUnsafe('UPDATE "TeamTipLedger" SET "updatedAt" = "updatedAt" WHERE "id" = $1', pair.tipId);
  await tx.$executeRawUnsafe('DELETE FROM "MoneyAttribution" WHERE "id" = $1', pair.moneyId);
}

async function overlap(prisma, firstWork, secondWork, label) {
  const firstLocked = deferred();
  const first = rollbackTx(prisma, async (tx) => {
    await firstWork(tx, firstLocked);
    await tx.$executeRawUnsafe("SELECT pg_sleep(0.20)");
  }, `${label}_FIRST_ROLLBACK`);
  await firstLocked.promise;
  const second = rollbackTx(prisma, async (tx) => secondWork(tx, deferred()), `${label}_SECOND_ROLLBACK`);
  await withTimeout(Promise.all([first, second]), 6000, label);
}

test("Closure5 PostgreSQL exact DML: pending migration serializes both legacy and current runtime", { skip: !enabled }, async (t) => {
  const prisma = require("../prisma");
  const pair = await seedPair(prisma);
  if (!pair) {
    t.skip("integration DB has no MoneyAttribution + TeamTipLedger pair for the same eventHash");
    return;
  }

  // Previous deployed binary already holds the Money row; migration waits at
  // ACCESS EXCLUSIVE and therefore holds no Team lock while it waits.
  await overlap(prisma, (tx, d) => legacyRuntimeDml(tx, pair, d), (tx, d) => deploymentDml(tx, pair, d), "legacy-runtime-first");
  // Migration first prevents legacy runtime from even acquiring ROW SHARE for
  // SELECT FOR UPDATE.
  await overlap(prisma, (tx, d) => deploymentDml(tx, pair, d), (tx, d) => legacyRuntimeDml(tx, pair, d), "migration-first-vs-legacy");
  // Current runtime also serializes at the first table authority.
  await overlap(prisma, (tx, d) => currentRuntimeDml(tx, pair, d), (tx, d) => deploymentDml(tx, pair, d), "current-runtime-first");
  assert.ok(true);
});

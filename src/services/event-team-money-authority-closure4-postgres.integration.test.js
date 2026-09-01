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
  } finally {
    clearTimeout(timer);
  }
}

test("Closure4 PostgreSQL migration/runtime lock ordering does not deadlock", { skip: !enabled }, async () => {
  const prisma = require("../prisma");
  const runtimeHasMoneyLock = deferred();

  const runtime = prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe('SELECT "id" FROM "MoneyAttribution" ORDER BY "id" LIMIT 1 FOR UPDATE');
    runtimeHasMoneyLock.resolve();
    await tx.$executeRawUnsafe("SELECT pg_sleep(0.20)");
    await tx.$executeRawUnsafe('LOCK TABLE "TeamTipLedger" IN ROW EXCLUSIVE MODE');
  });

  await runtimeHasMoneyLock.promise;
  const migration = prisma.$transaction(async (tx) => {
    // Same first table lock as the historical cutover migration. It must wait
    // for a runtime transaction that already entered MoneyAttribution; it must
    // never hold TeamTipLedger while waiting for MoneyAttribution.
    await tx.$executeRawUnsafe('LOCK TABLE "MoneyAttribution" IN SHARE ROW EXCLUSIVE MODE');
    await tx.$queryRawUnsafe('SELECT "id" FROM "TeamTipLedger" ORDER BY "id" LIMIT 1 FOR UPDATE');
  });

  await withTimeout(Promise.all([runtime, migration]), 5000, "runtime-first overlap");

  const migrationHasMoneyLock = deferred();
  const migrationFirst = prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('LOCK TABLE "MoneyAttribution" IN SHARE ROW EXCLUSIVE MODE');
    migrationHasMoneyLock.resolve();
    await tx.$executeRawUnsafe("SELECT pg_sleep(0.20)");
    await tx.$queryRawUnsafe('SELECT "id" FROM "TeamTipLedger" ORDER BY "id" LIMIT 1 FOR UPDATE');
  });
  await migrationHasMoneyLock.promise;
  const runtimeSecond = prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe('SELECT "id" FROM "MoneyAttribution" ORDER BY "id" LIMIT 1 FOR UPDATE');
    await tx.$executeRawUnsafe('LOCK TABLE "TeamTipLedger" IN ROW EXCLUSIVE MODE');
  });

  await withTimeout(Promise.all([migrationFirst, runtimeSecond]), 5000, "migration-first overlap");
  assert.ok(true);
});

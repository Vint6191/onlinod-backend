"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";

test("Closure4 PostgreSQL/Prisma smoke acquires a transaction advisory lock without business writes", { skip: !enabled }, async () => {
  const prisma = require("../prisma");
  const { lockDbAdvisoryXact } = require("./db-transaction-service");
  try {
    const result = await prisma.$transaction(async (tx) => lockDbAdvisoryXact({
      db: tx,
      key: `audit13_closure4_smoke:${process.pid}`,
    }));
    assert.match(result.key, /^audit13_closure4_smoke:/);
  } finally {
    if (typeof prisma.$disconnect === "function") await prisma.$disconnect();
  }
});

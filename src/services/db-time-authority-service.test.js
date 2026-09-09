"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { dbAuthorityNow } = require("./db-time-authority-service");

test("PostgreSQL clock is authoritative even when caller wall clock disagrees", async () => {
  const dbNow = new Date("2026-09-09T09:00:00.000Z");
  const result = await dbAuthorityNow({
    db: { async $queryRawUnsafe(sql) { assert.match(String(sql), /clock_timestamp\(\)/); return [{ authorityNow: dbNow }]; } },
    fallbackNow: new Date("2026-09-09T12:00:00.000Z"),
  });
  assert.equal(result.toISOString(), dbNow.toISOString());
});

test("DB clock query failure fails closed instead of trusting process fallback", async () => {
  await assert.rejects(
    dbAuthorityNow({
      db: { async $queryRawUnsafe() { throw new Error("db unavailable"); } },
      fallbackNow: new Date("2026-09-09T12:00:00.000Z"),
    }),
    (error) => error?.code === "DB_TIME_AUTHORITY_QUERY_FAILED"
  );
});

test("invalid DB clock result fails closed", async () => {
  await assert.rejects(
    dbAuthorityNow({
      db: { async $queryRawUnsafe() { return []; } },
      fallbackNow: new Date("2026-09-09T12:00:00.000Z"),
    }),
    (error) => error?.code === "DB_TIME_AUTHORITY_INVALID"
  );
});

test("explicit fallback is allowed only for tiny unit doubles without raw-query capability", async () => {
  const fallbackNow = new Date("2026-09-09T12:00:00.000Z");
  const result = await dbAuthorityNow({ db: {}, fallbackNow });
  assert.equal(result.toISOString(), fallbackNow.toISOString());
  await assert.rejects(dbAuthorityNow({ db: {} }), (error) => error?.code === "DB_TIME_AUTHORITY_CLIENT_REQUIRED");
});

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { configuration } = require("./databases");
const { cleanPatch } = require("./crm-repository");
const { ConversationRuntime } = require("./runtime");
const c = require("./common");
const env = {
  DATABASE_URL: "postgresql://u:p@ep-a/db",
  DIALOGS_DATABASE_URL: "postgresql://u:p@ep-a/dialogs",
  CRM_DATABASE_URL: "postgresql://u:p@ep-a/crm",
};
test("database separation rejects reused main DB and pooled endpoint aliases", () => {
  assert.equal(configuration(env).dialogs, env.DIALOGS_DATABASE_URL);
  for (const bad of [
    { CRM_DATABASE_URL: env.DIALOGS_DATABASE_URL },
    { CRM_DATABASE_URL: env.DATABASE_URL },
    {
      DIALOGS_DATABASE_URL: "postgresql://u:p@ep-a-pooler.neon.tech/db",
      DATABASE_URL: "postgresql://u:p@ep-a.neon.tech/db",
    },
  ])
    assert.throws(() => configuration({ ...env, ...bad }), { code: "CONVERSATION_DATABASES_MUST_BE_SEPARATE" });
  assert.throws(() => configuration({ ...env, CRM_DATABASE_URL: env.CRM_DATABASE_URL + "?schema=second" }), {
    code: "CONVERSATION_PUBLIC_SCHEMA_REQUIRED",
  });
});
test("manual profile contract rejects malformed nested data before SQL", () => {
  assert.throws(() => cleanPatch({ fetishes: [null] }), { code: "CRM_FIELD_INVALID" });
  assert.throws(() => cleanPatch({ boundaries: [{}] }), { code: "CRM_FIELD_INVALID" });
  assert.throws(() => cleanPatch({ sexualDynamic: { surprise: [] } }), { code: "CRM_FIELD_INVALID" });
  assert.throws(() => cleanPatch({ budgetMin: 20, budgetMax: 10 }), { code: "CRM_BUDGET_INVALID" });
  assert.deepEqual(
    cleanPatch({ preferredName: "Alice", fetishes: [{ label: "example", strength: "weak" }] }).preferredName,
    "Alice"
  );
});
test("CRM money is unavailable without its canonical money permission and never queries the ledger", async () => {
  const runtime = new ConversationRuntime(
    { dialogs: {}, crm: {} },
    {
      $queryRawUnsafe: () => {
        throw new Error("FORBIDDEN_QUERY");
      },
    }
  );
  assert.deepEqual(await runtime.financial({ canViewMoney: false }, "12"), {
    available: false,
    source: "financial-ledger",
    reason: "FORBIDDEN",
  });
});
test("hash and wire conversion accept native PostgreSQL bigint and date values", () => {
  assert.equal(
    c.hash({ count: 3n, at: new Date("2026-01-01") }),
    c.hash({ at: "2026-01-01T00:00:00.000Z", count: "3" })
  );
  assert.deepEqual(c.jsonResult({ id: 9007199254740993n }), { id: "9007199254740993" });
  assert.throws(() => c.platformId(9007199254740992), { code: "PLATFORM_ID_INVALID" });
});

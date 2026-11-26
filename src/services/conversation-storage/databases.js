"use strict";
const { URL } = require("node:url");
const { check, fail } = require("./common");
const { verify } = require("./schema-contract");
let clients;
function address(raw) {
  let u, database;
  try { u = new URL(raw); database = u.pathname.slice(1); }
  catch { throw fail("CONVERSATION_DATABASE_URL_INVALID", 503); }
  check(["postgres:", "postgresql:"].includes(u.protocol) && u.hostname && database,
    "CONVERSATION_DATABASE_URL_INVALID", 503);
  check(!u.searchParams.getAll("schema").some((schema) => schema && schema !== "public"),
    "CONVERSATION_PUBLIC_SCHEMA_REQUIRED", 503);
  // Prisma 5.22 uses the database pathname verbatim: /store and /%73tore
  // can select different databases. Fold DNS case, but do not decode or rewrite
  // the database component or the URL passed to Prisma.
  return JSON.stringify({ host: u.hostname.toLowerCase().replace("-pooler.", "."),
    port: u.port || "5432", database, schema: "public" });
}
function configuration(env = process.env) {
  const dialogs = env.DIALOGS_DATABASE_URL,
    crm = env.CRM_DATABASE_URL;
  check(dialogs && crm, "CONVERSATION_DATABASES_NOT_CONFIGURED", 503);
  const a = address(dialogs),
    b = address(crm);
  check(
    a !== b && (!env.DATABASE_URL || (address(env.DATABASE_URL) !== a && address(env.DATABASE_URL) !== b)),
    "CONVERSATION_DATABASES_MUST_BE_SEPARATE",
    503
  );
  return { dialogs, crm };
}
function getDatabases() {
  if (clients) return clients;
  const config = configuration();
  const { PrismaClient } = require("@prisma/client");
  const make = (url) => {
    const parsed = new URL(url);
    if (!parsed.searchParams.has("connection_limit")) parsed.searchParams.set("connection_limit", "3");
    return new PrismaClient({ datasources: { db: { url: parsed.toString() } } });
  };
  clients = { dialogs: make(config.dialogs), crm: make(config.crm) };
  return clients;
}
async function ready(db, domain) {
  // ConversationRuntime.check owns the bounded 30-second readiness cache and
  // coalesces concurrent checks. This verifier always inspects the real store.
  return verify(db, domain);
}
function databaseShutdownPort(core, currentStores = () => clients) {
  return {
    async $disconnect() {
      // Resolve lazily: these clients may be created later during startup or a
      // request. This port is called only after process-wide drain completes.
      const databases = [core, ...Object.values(currentStores() || {})];
      const results = await Promise.allSettled(databases.map((db) => Promise.resolve().then(() => db.$disconnect())));
      const failed = results.find((r) => r.status === "rejected");
      if (failed) throw failed.reason;
    },
  };
}
module.exports = { configuration, getDatabases, ready, databaseShutdownPort };

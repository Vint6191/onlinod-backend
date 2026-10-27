"use strict";
const { URL } = require("node:url");
const { check, one } = require("./common");
let clients;
function address(raw) {
  const u = new URL(raw);
  check(
    !u.searchParams.get("schema") || u.searchParams.get("schema") === "public",
    "CONVERSATION_PUBLIC_SCHEMA_REQUIRED",
    503
  );
  check(["postgres:", "postgresql:"].includes(u.protocol), "CONVERSATION_DATABASE_URL_INVALID", 503);
  return `${u.hostname.replace("-pooler.", ".")}:${u.port || "5432"}${u.pathname}`;
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
  const row = await one(db, "SELECT version FROM conversation_schema_version WHERE domain=$1", domain);
  check(row?.version === 1, "CONVERSATION_DATABASE_MIGRATION_REQUIRED", 503);
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

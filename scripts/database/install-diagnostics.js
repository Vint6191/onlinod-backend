"use strict";

// Installation failures may contain connection URLs, SQL and row values. Never
// print driver messages or CLI output. Only named stages and known error codes
// cross this boundary; detailed raw causes remain in memory for classification.
const messages = {
  UNKNOWN_INSTALL_ARGUMENT: "Use only the documented installer options. No installation was started.",
  DATABASE_URL_REQUIRED: "Set DATABASE_URL to a valid PostgreSQL connection URL.",
  DIRECT_DATABASE_URL_INVALID: "DIRECT_URL is set but is not a valid PostgreSQL connection URL. Correct it or omit it to use DATABASE_URL for installation.",
  DIRECT_DATABASE_IDENTITY_MISMATCH: "DIRECT_URL must identify the same PostgreSQL database as DATABASE_URL. Verify host, port, database name and public schema; a different database is never selected automatically.",
  PUBLIC_SCHEMA_REQUIRED: "Use the public schema for the core database.",
  BASELINE_SOURCE_CHECKSUM_MISMATCH: "A migration file differs from its recorded checksum. Restore the complete matching Backend package; do not edit applied migrations.",
  DATABASE_INSTALL_SOURCE_MISSING: "A required migration, schema or Prisma CLI file is missing. Restore the complete Backend package and install its dependencies.",
  DATABASE_INSTALL_FILE_ACCESS_DENIED: "The installer cannot read its files or write its private temporary directory. Check build-user filesystem permissions.",
  DATABASE_INSTALL_STORAGE_FULL: "The installation filesystem has no free space. Free build storage and retry.",
  EMPTY_DATABASE_REQUIRED: "The core database has tables without a recognized migration history. Verify the target database and its history before retrying; no automatic reset was performed.",
  CURRENT_BASELINE_DATABASE_REQUIRED: "The core migration history differs from this release. Verify the deployed Backend package and database history; do not delete data to bypass this check.",
  LEGACY_TEST_RESET_NOT_APPLICABLE: "The explicit legacy TEST reset does not apply to this history. Existing data was not reset.",
  BASELINE_INSTALLATION_INCOMPLETE: "An unfinished migration receipt exists. Inspect and resolve that migration with the database operator before retrying; do not mark it successful without verifying its effects.",
  DUPLICATE_BASELINE_RECEIPT: "The database has duplicate migration receipts. Review migration history before retrying.",
  NONCONTIGUOUS_BASELINE_RECEIPTS: "A later migration is recorded while an earlier receipt is missing. Review migration history before retrying.",
  BASELINE_DEPLOY_FAILED: "Prisma migration deployment failed. Use the named stage, Prisma code and SQLSTATE below to diagnose it; completed database stages can be retried safely after correction.",
  DATABASE_CONTRACT_REQUIRED: "The installed core schema or required controls differ from this release. Review the schema contract and recorded migration history; no automatic reset was performed.",
  ANALYTICS_TRAFFIC_INDEX_INVALID: "An existing Analytics/Traffic index differs from the required definition or is not valid. Inspect that index before retrying; the installer does not drop existing indexes automatically.",
  ANALYTICS_TRAFFIC_INDEX_REQUIRED: "A required Analytics/Traffic index is missing. Run the current production installer before starting the backend.",
  ANALYTICS_TRAFFIC_INDEX_BUILD_INVALID: "An Analytics/Traffic online index build did not produce the required valid index. Inspect the build and retry after resolving its cause.",
  ANALYTICS_TRAFFIC_INDEX_LOCK_BUSY: "Another Analytics/Traffic index installer still owns the deployment lock. Wait for that installation to finish and retry.",
  CONVERSATION_DATABASES_NOT_CONFIGURED: "Set both DIALOGS_DATABASE_URL and CRM_DATABASE_URL, or omit both when conversation storage is not configured.",
  CONVERSATION_DATABASES_MUST_BE_SEPARATE: "Core, Dialogs and CRM must use distinct databases. Correct the connection configuration before retrying.",
  CONVERSATION_DATABASE_URL_INVALID: "A conversation connection is not a valid PostgreSQL URL. Check the named store's connection setting.",
  CONVERSATION_PUBLIC_SCHEMA_REQUIRED: "Conversation databases must use the public schema.",
  CONVERSATION_MIGRATION_CHECKSUM_MISMATCH: "The conversation migration receipt does not match this release's SQL. Verify the deployed source and that database's migration history; do not overwrite its receipt.",
  EMPTY_CONVERSATION_DATABASE_REQUIRED: "The conversation target contains unrelated tables. Use the correct dedicated database; no automatic reset was performed.",
  CONVERSATION_DATABASE_CONTRACT_REQUIRED: "A conversation receipt exists, but the expected database objects do not match. Repair or restore the named store's schema before retrying; its receipt was not overwritten.",
  CONVERSATION_DATABASE_MIGRATION_REQUIRED: "The named conversation store has no accepted schema receipt. Run the conversation installer against its dedicated database before starting runtime work.",
  CONVERSATION_DOMAIN_INVALID: "The installer only accepts the dialogs and crm store domains.",
  DATABASE_AUTHENTICATION_FAILED: "PostgreSQL rejected authentication. Check the named store's current username/password and the deployment environment binding.",
  DATABASE_CONNECTION_UNREACHABLE: "The named PostgreSQL server could not be reached. Check the service connection setting, network access and database availability.",
  DATABASE_CONNECTION_TIMEOUT: "The PostgreSQL connection timed out. Check database availability, connection limits and deployment network access.",
  DATABASE_NOT_FOUND: "The configured PostgreSQL database does not exist. Check the database name in the named store's connection setting.",
  DATABASE_ACCESS_DENIED: "The PostgreSQL role lacks access required by this installation. Verify CONNECT, schema privileges and ownership of existing objects for the named store.",
  DATABASE_TLS_FAILED: "The database TLS connection failed. Check the provider's TLS requirements and the deployment's connection options.",
  DATABASE_CONNECTION_INVALID: "Prisma rejected the connection configuration. Check the named store's PostgreSQL URL format and required environment variables.",
  DATABASE_SERVER_INCOMPATIBLE: "The database server version or requested feature is incompatible with this Prisma installation.",
  DATABASE_CONNECTION_CLOSED: "The PostgreSQL connection closed unexpectedly. Check database restarts, availability and connection limits before retrying.",
  DATABASE_CONNECTION_LIMIT: "No database connection was available within the allowed time. Check connection limits and concurrent deploys.",
  DATABASE_LOCK_TIMEOUT: "Installation could not acquire a database lock. Check for another migration/deployment or a long-running transaction, then retry.",
  DATABASE_TRANSACTION_RETRY_REQUIRED: "The database aborted a transaction due to concurrency. Resolve competing installation work and retry the same release.",
  DATABASE_QUERY_CANCELLED: "The database cancelled an installation query. Check statement timeouts, operator cancellation and concurrent deployment activity.",
  DATABASE_SCHEMA_OBJECT_MISSING: "A required database object is missing. Review the named store's schema and migration history before retrying.",
  DATABASE_SCHEMA_OBJECT_EXISTS: "Installation found an existing object that conflicts with a migration. Review schema and migration history before retrying.",
  DATABASE_DATA_CONSTRAINT_FAILED: "Existing rows violate a required migration constraint. Review the identified migration privately; row values are intentionally omitted from deploy logs.",
  DATABASE_STORAGE_CAPACITY: "PostgreSQL could not allocate required storage or memory. Check database capacity before retrying.",
  DATABASE_INSTALL_FAILED: "Installation failed with an unclassified error. The named stage/store identifies the failing step; no credentials, SQL or row values were written to this log.",
};

const prismaCodes = {
  P1000: "DATABASE_AUTHENTICATION_FAILED", P1001: "DATABASE_CONNECTION_UNREACHABLE",
  P1002: "DATABASE_CONNECTION_TIMEOUT", P1003: "DATABASE_NOT_FOUND", P1008: "DATABASE_QUERY_CANCELLED",
  P1010: "DATABASE_ACCESS_DENIED", P1011: "DATABASE_TLS_FAILED", P1012: "DATABASE_CONNECTION_INVALID",
  P1013: "DATABASE_CONNECTION_INVALID", P1014: "DATABASE_SCHEMA_OBJECT_MISSING", P1015: "DATABASE_SERVER_INCOMPATIBLE",
  P1017: "DATABASE_CONNECTION_CLOSED", P2002: "DATABASE_DATA_CONSTRAINT_FAILED", P2003: "DATABASE_DATA_CONSTRAINT_FAILED",
  P2004: "DATABASE_DATA_CONSTRAINT_FAILED", P2010: null, P2021: "DATABASE_SCHEMA_OBJECT_MISSING",
  P2022: "DATABASE_SCHEMA_OBJECT_MISSING", P2024: "DATABASE_CONNECTION_LIMIT", P2034: "DATABASE_TRANSACTION_RETRY_REQUIRED",
  P3005: "EMPTY_DATABASE_REQUIRED", P3006: "BASELINE_DEPLOY_FAILED", P3009: "BASELINE_INSTALLATION_INCOMPLETE",
  P3018: "BASELINE_DEPLOY_FAILED", P3019: "DATABASE_CONNECTION_INVALID", P3020: "DATABASE_ACCESS_DENIED",
};
const sqlCodes = {
  "28000": "DATABASE_AUTHENTICATION_FAILED", "28P01": "DATABASE_AUTHENTICATION_FAILED", "3D000": "DATABASE_NOT_FOUND",
  "42501": "DATABASE_ACCESS_DENIED", "42P01": "DATABASE_SCHEMA_OBJECT_MISSING", "42703": "DATABASE_SCHEMA_OBJECT_MISSING",
  "42P07": "DATABASE_SCHEMA_OBJECT_EXISTS", "42710": "DATABASE_SCHEMA_OBJECT_EXISTS",
  "23502": "DATABASE_DATA_CONSTRAINT_FAILED", "23503": "DATABASE_DATA_CONSTRAINT_FAILED",
  "23505": "DATABASE_DATA_CONSTRAINT_FAILED", "23514": "DATABASE_DATA_CONSTRAINT_FAILED",
  "55P03": "DATABASE_LOCK_TIMEOUT", "40P01": "DATABASE_TRANSACTION_RETRY_REQUIRED", "40001": "DATABASE_TRANSACTION_RETRY_REQUIRED",
  "57014": "DATABASE_QUERY_CANCELLED", "53300": "DATABASE_CONNECTION_LIMIT", "53100": "DATABASE_STORAGE_CAPACITY",
  "53200": "DATABASE_STORAGE_CAPACITY", "57P01": "DATABASE_CONNECTION_CLOSED", "57P02": "DATABASE_CONNECTION_CLOSED",
  "57P03": "DATABASE_CONNECTION_UNREACHABLE", "08000": "DATABASE_CONNECTION_CLOSED", "08001": "DATABASE_CONNECTION_UNREACHABLE",
  "08003": "DATABASE_CONNECTION_CLOSED", "08004": "DATABASE_CONNECTION_UNREACHABLE", "08006": "DATABASE_CONNECTION_CLOSED",
  "0A000": "DATABASE_SERVER_INCOMPATIBLE",
};
const domains = new Set(["core", "dialogs", "crm", "conversation"]);
const phases = new Set(["CONFIGURATION", "SOURCE_PREPARATION", "CORE_CONNECT", "CORE_INSPECT", "CORE_LEGACY_RESET", "CORE_DEPLOY", "CORE_ONLINE_INDEXES", "CORE_VERIFY",
  "CONVERSATION_PREFLIGHT", "CONVERSATION_INSTALL", "CONVERSATION_VERIFY", "DATABASE_DISCONNECT", "SOURCE_CLEANUP", "INSTALL_COMPLETE"]);
const own = (object, key) => typeof key === "string" && Object.prototype.hasOwnProperty.call(object, key);
const isPrismaCode = value => typeof value === "string" && /^P\d{4}$/.test(value);
const isSqlState = value => typeof value === "string" && /^[A-Z0-9]{5}$/.test(value);

function annotateFailure(error, context = {}) {
  const failure = error instanceof Error ? error : new Error("DATABASE_INSTALL_FAILED");
  try { failure.installContext = { ...context, ...(failure.installContext || {}) }; return failure; }
  catch { const wrapper = new Error("DATABASE_INSTALL_FAILED", { cause: failure }); wrapper.installContext = context; return wrapper; }
}

function diagnosticFor(error) {
  const chain = []; let current = error;
  for (let i = 0; current && i < 4 && !chain.includes(current); i++, current = current.cause) chain.push(current);
  const context = Object.assign({}, ...chain.slice().reverse().map(item => item.installContext || {}));
  const recognized = chain.flatMap(item => [item.code, item.message]).find(code => own(messages, code));
  const prismaCode = chain.flatMap(item => [item.errorCode, item.code, item.prismaCode]).find(isPrismaCode);
  const sqlState = chain.flatMap(item => [item.sqlState, item.meta?.code,
    own(sqlCodes, item.code) || ["ERROR", "FATAL", "PANIC"].includes(item.severity) ? item.code : null]).find(isSqlState);
  const fileCode = chain.map(item => item.code).find(code => ["ENOENT", "MODULE_NOT_FOUND", "EACCES", "EPERM", "ENOSPC"].includes(code));
  const fileReason = ["ENOENT", "MODULE_NOT_FOUND"].includes(fileCode) ? "DATABASE_INSTALL_SOURCE_MISSING" : fileCode === "ENOSPC" ? "DATABASE_INSTALL_STORAGE_FULL"
    : fileCode ? "DATABASE_INSTALL_FILE_ACCESS_DENIED" : null;
  const reason = (sqlState && sqlCodes[sqlState]) || (prismaCode && prismaCodes[prismaCode]) || fileReason || null;
  const code = recognized || reason || "DATABASE_INSTALL_FAILED";
  const diagnostic = { code, phase: phases.has(context.phase) ? context.phase : "CONFIGURATION",
    domain: domains.has(context.domain) ? context.domain : "core" };
  if (reason && reason !== code) diagnostic.reason = reason;
  if (["DATABASE_URL", "DIRECT_URL"].includes(context.connectionSetting)) diagnostic.connectionSetting = context.connectionSetting;
  if (prismaCode) diagnostic.prismaCode = prismaCode;
  if (sqlState) diagnostic.sqlState = sqlState;
  if (Array.isArray(context.completedDatabases)) diagnostic.completedDatabases = [...new Set(context.completedDatabases.filter(domain => domains.has(domain)))];
  const child = chain.find(item => Number.isInteger(item.exitCode) || ["SIGINT", "SIGTERM", "SIGKILL"].includes(item.signal));
  if (child && Number.isInteger(child.exitCode)) diagnostic.exitCode = child.exitCode;
  if (child && ["SIGINT", "SIGTERM", "SIGKILL"].includes(child.signal)) diagnostic.signal = child.signal;
  // A migration identifier is source-owned, never copied from arbitrary error text.
  if (typeof context.migration === "string") {
    const { migrations } = require("../../src/services/database-migration-chain");
    if (migrations.some(item => item.migration === context.migration)) diagnostic.migration = context.migration;
  }
  const problems = chain.find(item => Array.isArray(item.problems))?.problems;
  if (problems) {
    diagnostic.problemCount = problems.length;
    diagnostic.problemKinds = [...new Set(problems.map(value => String(value).split(":")[0]).filter(value =>
      ["tables", "columns", "enums", "views", "functions", "triggers", "constraints", "indexes", "unexpected-table", "control", "BASELINE_REQUIRED", "trigger", "index", "constraint"].includes(value)))];
    // These identifiers belong to the shared install/startup/readiness contract,
    // not to database rows. Keep the failing control actionable without logging
    // arbitrary object names or values returned by the database.
    const controls = new Set(["topology", "provider", "campaigns", "campaign_dispatch", "maintenance_dispatch"]);
    const controlProblems = [...new Set(problems.filter(value => typeof value === "string" && value.startsWith("control:"))
      .map(value => value.slice("control:".length)).filter(value => controls.has(value)))];
    if (controlProblems.length) diagnostic.controlProblems = controlProblems;
  }
  const cleanup = chain.find(item => item.installCleanupFailure)?.installCleanupFailure;
  if (cleanup) diagnostic.cleanupFailure = diagnosticFor(cleanup).code;
  return diagnostic;
}

function reportFailure(error) {
  const diagnostic = diagnosticFor(error);
  console.error(diagnostic.code);
  console.error(JSON.stringify(diagnostic));
  console.error(messages[diagnostic.reason || diagnostic.code]);
}

function deploymentFailure(output, exitCode, signal, knownMigrations = []) {
  const failure = Object.assign(new Error("BASELINE_DEPLOY_FAILED"), { code: "BASELINE_DEPLOY_FAILED", exitCode, signal });
  const text = output.replace(/\x1b\[[0-9;]*m/g, "");
  // Only explicit engine labels are diagnostic authority. A row value which
  // happens to contain P1000 or another code must not change the failure class.
  const prismaCode = [...text.matchAll(/^\s*(?:Error(?: code)?|error_code)\s*[:=]\s*["']?(P\d{4})\b/gm)].map(match => match[1]).find(isPrismaCode);
  const sqlState = [...text.matchAll(/^\s*(?:SQLSTATE|Database error code)\s*[:=]\s*["']?([A-Z0-9]{5})\b/gmi)]
    .map(match => match[1].toUpperCase()).find(isSqlState);
  if (prismaCode) failure.prismaCode = prismaCode;
  if (sqlState) failure.sqlState = sqlState;
  // Some Prisma migrate failures omit SQLSTATE but still emit a stable engine
  // diagnosis. Classify it without copying any following identifier or value.
  if (!sqlState && /^\s*(?:Error:\s*)?(?:db error:\s*)?ERROR:\s*permission denied\b/im.test(text)) failure.sqlState = "42501";
  if (!sqlState && /^\s*(?:Error:\s*)?(?:db error:\s*)?ERROR:\s*deadlock detected\b/im.test(text)) failure.sqlState = "40P01";
  const matched = [...text.matchAll(/^\s*(?:Applying migration\s+[`"']?|Migration name:\s*)([0-9]{14}_[a-zA-Z0-9_]+)/gm)]
    .map(match => match[1]).filter(name => knownMigrations.includes(name));
  if (matched.length) failure.installContext = { migration: matched.at(-1) };
  return failure;
}

function preservePrimaryFailure(primary, cleanup, context) {
  const failure = annotateFailure(cleanup, context);
  if (!primary) return failure;
  try { primary.installCleanupFailure = failure; } catch { /* the original failure remains authoritative */ }
  return primary;
}

module.exports = { annotateFailure, diagnosticFor, reportFailure, deploymentFailure, preservePrimaryFailure };

"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");
const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { setTimeout: delay } = require("node:timers/promises");
const { dbAuthorityNow } = require("./db-time-authority-service");

// One owner begins, retries and commits. Domain services still own permission
// checks and lock ordering. Only explicitly migrated command families use this
// kernel; the legacy db-transaction adapter is not silently changed underneath
// unconverted callers.
const scope = new AsyncLocalStorage();
const contexts = new WeakMap();
const transactionContexts = new WeakMap();
const ISOLATION = Object.freeze({ ReadCommitted: 1, RepeatableRead: 2, Serializable: 3 });
const COMMIT_PROFILES = Object.freeze({
  COMMAND: Object.freeze({ isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 15000, deadlineMs: 20000, lockTimeoutMs: 5000, statementTimeoutMs: 15000 }),
  SECRET_READ: Object.freeze({ isolationLevel: "Serializable", maxWait: 10000, timeout: 30000, deadlineMs: 40000, lockTimeoutMs: 5000, statementTimeoutMs: 25000 }),
  SECRET_WRITE: Object.freeze({ isolationLevel: "Serializable", maxWait: 10000, timeout: 30000, deadlineMs: 40000, lockTimeoutMs: 5000, statementTimeoutMs: 25000 }),
  BILLING_RECOVERY: Object.freeze({ isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 15000, deadlineMs: 20000, lockTimeoutMs: 5000, statementTimeoutMs: 15000 }),
  TEAM_MANAGEMENT: Object.freeze({ isolationLevel: "Serializable", maxWait: 5000, timeout: 15000, deadlineMs: 20000, lockTimeoutMs: 5000, statementTimeoutMs: 15000 }),
  ADMIN_COMMAND: Object.freeze({ isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 15000, deadlineMs: 20000, lockTimeoutMs: 5000, statementTimeoutMs: 15000 }),
});

function failure(code, message, cause = undefined) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function positive(value, name, max = 120000) {
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw failure("DB_COMMIT_OPTIONS_INVALID", `${name} must be an integer in 1..${max}`);
  }
  return value;
}

function classifyCommitConflict(error) {
  const seen = new Set();
  let current = error;
  for (let depth = 0; current && typeof current === "object" && depth < 12 && !seen.has(current); depth += 1) {
    seen.add(current);
    const code = String(current.code || "");
    if (code === "P2034") return { kind: "TRANSACTION_CONFLICT", code, sqlState: null };
    const sqlState = code === "P2010" ? String(current.meta?.code || "") : code;
    if (sqlState === "40001" || sqlState === "40P01") {
      return { kind: sqlState === "40001" ? "SERIALIZATION_FAILURE" : "DEADLOCK", code, sqlState };
    }
    // Domain rejection, unique violations, timeouts and unknown commit outcomes
    // are not made retryable by a historical cause attached for diagnostics.
    if ((Number(current.status) >= 400 && Number(current.status) < 500) || /^P\d{4}$/.test(code)) return null;
    current = current.cause;
  }
  return null;
}

function optionsFor(options) {
  const profile = options.profile || "COMMAND";
  if (!Object.hasOwn(COMMIT_PROFILES, profile)) throw failure("DB_COMMIT_PROFILE_INVALID", "Unknown commit profile");
  const config = { ...COMMIT_PROFILES[profile], ...options, profile };
  if (!Object.hasOwn(ISOLATION, config.isolationLevel)) throw failure("DB_COMMIT_ISOLATION_INVALID", "Unsupported isolation level");
  for (const key of ["maxWait", "timeout", "deadlineMs", "lockTimeoutMs", "statementTimeoutMs"]) positive(config[key], key);
  config.maxAttempts = positive(options.maxAttempts ?? 3, "maxAttempts", 5);
  config.retryBaseMs = positive(options.retryBaseMs ?? 25, "retryBaseMs", 1000);
  config.maxHints = positive(options.maxHints ?? 1024, "maxHints", 4096);
  if (config.deadlineMs < 2) throw failure("DB_COMMIT_OPTIONS_INVALID", "deadlineMs must cover admission and execution");
  return config;
}

function stateFor(context) {
  const state = context && contexts.get(context);
  if (!state) throw failure("DB_COMMIT_CONTEXT_REQUIRED", "A kernel-issued commit context is required");
  if (state.phase !== "ACTIVE") throw failure("DB_COMMIT_CONTEXT_CLOSED", "The transaction attempt is no longer active");
  if (scope.getStore() !== context) throw failure("DB_COMMIT_CONTEXT_SCOPE_MISMATCH", "The context belongs to another command attempt");
  if (performance.now() >= state.deadlineAt) throw failure("DB_COMMIT_DEADLINE_EXCEEDED", "The command deadline expired");
  return state;
}

function currentCommitContext() {
  const context = scope.getStore();
  if (!context) return null;
  stateFor(context);
  return context;
}

function isCommitTransaction(db) {
  return Boolean(db && transactionContexts.has(db));
}

async function joinCommit(context, requirements, work) {
  const state = stateFor(context);
  if (typeof work !== "function") throw new TypeError("joinCommit requires a work callback");
  const isolation = requirements?.isolationLevel;
  if (isolation && (!Object.hasOwn(ISOLATION, isolation) || ISOLATION[context.isolationLevel] < ISOLATION[isolation])) {
    throw failure("DB_COMMIT_JOIN_ISOLATION_MISMATCH", "The root transaction does not meet the required isolation level");
  }
  if (requirements?.authorityKind && requirements.authorityKind !== context.authority.kind) {
    throw failure("DB_COMMIT_JOIN_AUTHORITY_MISMATCH", "The root command has a different authority intent");
  }
  for (const key of ["agencyId", "creatorId", "userId"]) {
    if (requirements?.[key] !== undefined && requirements[key] !== context.authority[key]) {
      throw failure("DB_COMMIT_JOIN_SCOPE_MISMATCH", "The joined operation belongs to another authority scope");
    }
  }
  if (requirements?.remainingMs !== undefined) {
    positive(requirements.remainingMs, "remainingMs");
    if (state.deadlineAt - performance.now() < requirements.remainingMs) {
      throw failure("DB_COMMIT_JOIN_BUDGET_INSUFFICIENT", "The root command has insufficient remaining time");
    }
  }
  return work(context);
}

async function commitAuthorityNow(context, fallbackNow = null) {
  stateFor(context);
  // This is intentionally not memoized. Call AFTER domain locks and at the
  // actual grant/claim/renew boundary, not once at transaction admission.
  return dbAuthorityNow({ db: context.tx, fallbackNow });
}

function deferCommitHint(context, key, notify) {
  const state = stateFor(context);
  if (typeof key !== "string" || !key || key.length > 500 || typeof notify !== "function") {
    throw failure("DB_COMMIT_HINT_INVALID", "A bounded key and notification callback are required");
  }
  if (!state.hints.has(key) && state.hints.size >= state.config.maxHints) {
    throw failure("DB_COMMIT_HINT_CAPACITY", "The transaction notification budget is exhausted");
  }
  state.hints.set(key, notify);
}

// A command may commit its rejection receipt after rolling its domain savepoint
// back. That root must explicitly discard advisory effects of the rejected work.
function discardCommitHints(context) {
  stateFor(context).hints.clear();
}

function hintFailure(error) {
  // No payloads, credentials or query text. A failed advisory notification must
  // never turn a committed command into an HTTP error and cause command replay.
  try {
    console.warn("[db-commit] post-commit hint failed", { code: String(error?.code || error?.name || "ERROR") });
  } catch { return; } // Logging must not change an already committed outcome.
}

function flushHints(state) {
  const hints = [...state.hints.values()];
  state.hints.clear();
  scope.exit(() => {
    for (const notify of hints) {
      try {
        // Hints are bounded non-durable wakeups. Required work MUST have a
        // durable DB intent; do not register network sends or jobs here.
        const result = notify();
        if (result && typeof result.then === "function") Promise.resolve(result).catch(hintFailure);
      } catch (error) { hintFailure(error); }
    }
  });
}

async function applySqlBudgets(tx, config, timeout) {
  if (typeof tx.$executeRawUnsafe !== "function") return; // Small unit doubles only.
  await tx.$executeRawUnsafe(
    "SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)",
    `${Math.min(config.lockTimeoutMs, timeout)}ms`,
    `${Math.min(config.statementTimeoutMs, timeout)}ms`,
  );
}

async function runRootCommit(db, work, options = {}) {
  if (scope.getStore() || isCommitTransaction(db)) {
    throw failure("DB_COMMIT_NESTED_ROOT_FORBIDDEN", "Use joinCommit with the existing context instead of opening another root");
  }
  if (!db || typeof db.$transaction !== "function") throw failure("DB_COMMIT_ROOT_REQUIRED", "A root Prisma client is required");
  if (typeof work !== "function") throw new TypeError("runRootCommit requires a work callback");
  const config = optionsFor(options);
  const authority = Object.freeze({ kind: "DOMAIN", ...(options.authority || {}) });
  if (typeof authority.kind !== "string" || !authority.kind) throw failure("DB_COMMIT_AUTHORITY_INVALID", "An authority intent is required");
  const rootId = randomUUID();
  const deadlineAt = performance.now() + config.deadlineMs;
  let lastError;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    const remaining = Math.floor(deadlineAt - performance.now());
    if (remaining < 2) break;
    const maxWait = Math.min(config.maxWait, Math.max(1, Math.floor(remaining / 2)));
    const timeout = Math.min(config.timeout, remaining - maxWait);
    let state;
    let result;
    try {
      result = await db.$transaction(async (rawTx) => {
        if (!rawTx || rawTx === db || typeof rawTx.$transaction === "function") {
          throw failure("DB_COMMIT_TRANSACTION_CLIENT_REQUIRED", "The root must provide a distinct Prisma transaction client");
        }
        const tx = rawTx;
        const context = Object.freeze({ rootId, attempt, tx, profile: config.profile, isolationLevel: config.isolationLevel, authority });
        state = { phase: "ACTIVE", deadlineAt: Math.min(deadlineAt, performance.now() + timeout), hints: new Map(), config };
        contexts.set(context, state);
        transactionContexts.set(tx, context);
        return scope.run(context, async () => {
          await applySqlBudgets(tx, config, timeout);
          stateFor(context);
          const value = await work(context);
          stateFor(context);
          state.phase = "COMMITTING";
          return value;
        });
      }, { isolationLevel: config.isolationLevel, maxWait, timeout });
    } catch (error) {
      if (state) { state.phase = "ROLLED_BACK"; state.hints.clear(); }
      lastError = error;
      if (!classifyCommitConflict(error)) throw error;
      if (attempt >= config.maxAttempts) break;
      const pause = Math.min(1000, config.retryBaseMs * (2 ** (attempt - 1))) + Math.floor(Math.random() * config.retryBaseMs);
      if (performance.now() + pause + 2 >= deadlineAt) break;
      await delay(pause);
      continue;
    }
    // Outside the retry catch: once the driver confirms commit, no notification
    // or diagnostics failure may re-enter the transaction retry loop.
    if (state) {
      state.phase = "COMMITTED";
      flushHints(state);
    }
    return result;
  }
  if (lastError && config.conflictCode) {
    const error = failure(config.conflictCode, config.conflictMessage || "State changed concurrently; refresh and retry", lastError);
    error.status = 409;
    throw error;
  }
  if (lastError) throw lastError;
  throw failure("DB_COMMIT_DEADLINE_EXCEEDED", "The command deadline expired before transaction admission");
}

module.exports = {
  COMMIT_PROFILES, runRootCommit, joinCommit, currentCommitContext,
  isCommitTransaction, classifyCommitConflict, commitAuthorityNow, deferCommitHint, discardCommitHints,
};

"use strict";
const { runDbTransaction } = require("./db-transaction-service");


const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { sameDate } = require("./billing-state-service");

const CURSOR_ID = "billing_aggregate_v1";
const PAGE_SIZE = 100;
const LEASE_MS = 30_000;
const RUN_BUDGET_MS = 5_000;
const TX_OPTIONS = { maxWait: 5_000, timeout: 10_000 };

async function lockedCursor(tx, fallbackNow) {
  await tx.$queryRawUnsafe('SELECT "id" FROM "BillingReconciliationCursor" WHERE "id"=$1 FOR UPDATE', CURSOR_ID);
  // A row-lock wait can outlive a lease. Observe the database clock afterwards.
  const now = await dbAuthorityNow({ db: tx, fallbackNow });
  const state = await tx.billingReconciliationCursor.findUnique({ where: { id: CURSOR_ID } });
  if (!state) throw Object.assign(new Error("Billing reconciliation cursor is missing"), { code: "BILLING_RECONCILIATION_CURSOR_MISSING" });
  return { state, now };
}

function owned(state, token, now) {
  return state.ownerToken === token && state.leaseUntil instanceof Date && state.leaseUntil > now;
}

async function reconcileBillingStates({ db, now: fallbackNow = new Date(), limit = PAGE_SIZE, budgetMs = RUN_BUDGET_MS } = {}) {
  if (!db?.$transaction || !db?.billingReconciliationCursor) throw new TypeError("BILLING_RECONCILIATION_DATABASE_REQUIRED");
  const size = Math.min(PAGE_SIZE, Math.max(1, Math.trunc(Number(limit) || PAGE_SIZE)));
  const budget = Math.min(RUN_BUDGET_MS, Math.max(1, Number(budgetMs) || RUN_BUDGET_MS));
  const token = randomUUID();
  const started = performance.now();
  const result = { scanned: 0, expired: 0, repaired: 0, failed: 0, cycleCompleted: false, busy: false, leaseLost: false };
  const page = await runDbTransaction(db, async tx => {
    const { state, now } = await lockedCursor(tx, fallbackNow);
    if (state.ownerToken && state.leaseUntil > now) { result.busy = true; return []; }
    // Scan Agency, not Subscription. A new trial need not have a subscription;
    // no status predicate can permanently hide a stale or held projection.
    const rows = await tx.agency.findMany({
      where: state.lastAgencyId ? { id: { gt: state.lastAgencyId } } : {},
      select: { id: true }, orderBy: { id: "asc" }, take: size,
    });
    if (!rows.length) {
      await tx.billingReconciliationCursor.update({ where: { id: CURSOR_ID }, data: {
        lastAgencyId: null, ownerToken: null, leaseUntil: null,
        cycle: { increment: 1 }, lastCompletedAt: now,
      } });
      result.cycleCompleted = true;
      return [];
    }
    await tx.billingReconciliationCursor.update({ where: { id: CURSOR_ID }, data: {
      ownerToken: token, leaseUntil: new Date(now.getTime() + LEASE_MS),
    } });
    return rows;
  }, TX_OPTIONS);
  if (!page.length) return result;

  const { syncAgencyBillingAggregate } = require("./billing-entitlement-service");
  try {
    for (const row of page) {
      if (result.scanned && performance.now() - started >= budget) break;
      let outcome;
      try {
        outcome = await runDbTransaction(db, async tx => {
          const { state, now } = await lockedCursor(tx, fallbackNow);
          if (!owned(state, token, now)) return { leaseLost: true };
          const before = await tx.agency.findUnique({ where: { id: row.id } });
          let changed = false, expired = false;
          if (before) {
            const aggregate = await syncAgencyBillingAggregate(tx, row.id, now);
            changed = aggregate.status !== before.status || !sameDate(aggregate.currentPeriodEnd, before.currentPeriodEnd);
            expired = changed && aggregate.status === "PAST_DUE";
          }
          // Progress and projection commit together. Restart can only replay a
          // harmless repair, never skip an uncommitted agency.
          const after = await dbAuthorityNow({ db: tx, fallbackNow: now });
          if (!owned(state, token, after)) throw Object.assign(new Error("Billing reconciliation lease expired"), { code: "BILLING_RECONCILIATION_LEASE_LOST" });
          await tx.billingReconciliationCursor.update({ where: { id: CURSOR_ID }, data: {
            lastAgencyId: row.id, leaseUntil: new Date(after.getTime() + LEASE_MS),
          } });
          return { changed, expired };
        }, TX_OPTIONS);
      } catch (error) {
        if (error?.code === "BILLING_RECONCILIATION_LEASE_LOST") { result.leaseLost = true; break; }
        // A bad tenant cannot pin the prefix forever. Record the failure and
        // visit it again next cycle. If storage itself is down this transaction
        // fails too, leaving the cursor unchanged for crash-safe recovery.
        outcome = await runDbTransaction(db, async tx => {
          const { state, now } = await lockedCursor(tx, fallbackNow);
          if (!owned(state, token, now)) return { leaseLost: true };
          const code = String(error?.code || "BILLING_RECONCILIATION_FAILED").slice(0, 120);
          await tx.billingReconciliationCursor.update({ where: { id: CURSOR_ID }, data: {
            lastAgencyId: row.id, failureCount: { increment: 1 },
            lastFailedAgencyId: row.id, lastErrorCode: code,
            leaseUntil: new Date(now.getTime() + LEASE_MS),
          } });
          console.error(JSON.stringify({ event: "billing_reconciliation_agency_failed", agencyId: row.id, code }));
          return { failed: true };
        }, TX_OPTIONS);
      }
      if (outcome.leaseLost) { result.leaseLost = true; break; }
      result.scanned += 1;
      if (outcome.failed) result.failed += 1;
      else if (outcome.expired) result.expired += 1;
      else if (outcome.changed) result.repaired += 1;
    }
  } finally {
    // Exact owner CAS: an expired worker cannot release its successor's lease.
    await db.billingReconciliationCursor.updateMany({
      where: { id: CURSOR_ID, ownerToken: token }, data: { ownerToken: null, leaseUntil: null },
    });
  }
  return result;
}

module.exports = { CURSOR_ID, PAGE_SIZE, LEASE_MS, reconcileBillingStates };

"use strict";

const receipts = require("./financial-receipt-authority");
function targeted(job) { return job?.jobKey === "financial_transactions_scan" && job.params?.moneyResolutionVersion === 1; }

async function assertMoneyResolutionAuthority(db, job) {
  if (!targeted(job)) throw new receipts.FinancialReceiptError("FINANCIAL_RESOLUTION_COMMAND_REQUIRED");
  receipts.windowsFor(job);
  // The caller already owns the financial collector lock and the fenced job
  // lease/publication. Resolution owns this exact pending request, never the
  // main historical collector's generation, freshness or retry state.
  const rows = await db.$queryRawUnsafe(`SELECT r."jobId",m.id FROM "CreatorMoneyResolutionRequest" r
    JOIN "CreatorMoneyObservation" m ON m.id=r."targetId" AND m."creatorId"=r."creatorId" AND m."agencyId"=r."agencyId"
    WHERE r."creatorId"=$1 AND r."agencyId"=$2 AND r."jobId"=$3 AND r."targetId"=$4 AND r.queued=true`,
  job.creatorId, job.agencyId, job.id, job.params.moneyResolutionObservationId);
  if (rows.length !== 1) throw new receipts.FinancialReceiptError("FINANCIAL_RESOLUTION_AUTHORITY_STALE");
  return true;
}
async function wakePendingRecovery(db, job) {
  // A targeted job occupied the shared financial lane while the recurring
  // planner could have yielded for an hour. Wake only existing recovery debt,
  // through the outbox so no domain-work lock is taken under the collector.
  const pending = await db.$queryRawUnsafe(`SELECT 1 FROM "CreatorRecoveryIntent"
    WHERE "agencyId"=$1 AND "creatorId"=$2 AND stream='financial' AND status IN ('PENDING','RUNNING') LIMIT 1`, job.agencyId, job.creatorId);
  if (pending.length) await require("./subscriber-directory-maintenance-signal-service").signalSubscriberDirectoryMaintenance({
    db, agencyId: job.agencyId, creatorId: job.creatorId, kind: "DERIVED_PLANNING", reason: "FINANCIAL_RESOLUTION_TERMINAL",
  });
}
module.exports = { targeted, assertMoneyResolutionAuthority, wakePendingRecovery };

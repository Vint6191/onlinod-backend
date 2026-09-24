"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const context = new AsyncLocalStorage();

// HTTP product reads/commands opt into this boundary. Worker receipts and
// identity/payment routes keep their existing durable authority and can drain.
function withProductBilling(agencyId, work) { return context.run({ agencyId }, work); }
function inProductBilling(agencyId) { const current = context.getStore(); return !!current && current.agencyId === agencyId; }

async function assertProductBilling({ db, agencyId, creatorId }) {
  if (!inProductBilling(agencyId)) return;
  await require("./billing-write-admission-service").assertBillingWriteAdmission({ db, agencyId, creatorId });
}

async function productBillingScope({ db, agencyId, scope }) {
  if (!inProductBilling(agencyId)) return scope;
  const rows = await db.$queryRawUnsafe(`WITH clock AS MATERIALIZED (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS at),
    agency AS MATERIALIZED (SELECT a."id",a."trialEndsAt",a."billingSupportHold",
      COALESCE(s."billingMode"::text,'MANUAL') AS mode FROM "Agency" a
      LEFT JOIN LATERAL (SELECT "billingMode" FROM "AgencySubscription" WHERE "agencyId"=a."id"
        ORDER BY "createdAt" DESC,"id" DESC LIMIT 1) s ON true WHERE a."id"=$1 AND a."deletedAt" IS NULL)
    SELECT c."id" FROM "CreatorAccount" c JOIN agency a ON a."id"=c."agencyId" CROSS JOIN clock
    LEFT JOIN "CreatorBillingEntitlement" e ON e."creatorId"=c."id" AND e."agencyId"=a."id"
    WHERE c."deletedAt" IS NULL AND ($2::boolean OR c."id"=ANY($3::text[])) AND NOT a."billingSupportHold"
      AND (a.mode='FREE_INTERNAL' OR a."trialEndsAt">clock.at
        OR (e."coreValidUntil">clock.at AND (e."coreValidFrom" IS NULL OR e."coreValidFrom"<=clock.at)))
    ORDER BY c."id"`, agencyId, scope.broad === true, scope.creatorIds || []);
  return { ...scope, broad: false, creatorIds: rows.map(row => row.id) };
}
// Re-read the canonical facts using DB time after authority/business lock waits.
async function assertProductBillingTargets({ db, agencyId, creatorIds }) {
  if (!inProductBilling(agencyId)) return;
  const { readBillingExecutionAccess, BillingExecutionAccessError } = require("./billing-execution-access-service");
  const ids = [...new Set((creatorIds || []).map(String).filter(Boolean))];
  if (!ids.length) throw new BillingExecutionAccessError("PRODUCT_CREATOR_SCOPE_REQUIRED", "Product command requires an explicit creator scope", 403);
  // Serializable callers may have opened their MVCC snapshot before waiting
  // for Agency billing authority. Lock existing fact rows to reject a stale
  // snapshot (40001) instead of accepting a grant revoked during that wait.
  // Missing grants fail closed. Billing writers own Agency first, so these
  // read locks cannot invert with a compliant entitlement/policy mutation.
  await db.$queryRawUnsafe('SELECT "id" FROM "AgencySubscription" WHERE "agencyId"=$1 ORDER BY "createdAt" DESC,"id" DESC LIMIT 1 FOR SHARE', agencyId);
  for (let offset=0;offset<ids.length;offset+=500) {
    await db.$queryRawUnsafe('SELECT "id" FROM "CreatorBillingEntitlement" WHERE "agencyId"=$1 AND "creatorId"=ANY($2::text[]) ORDER BY "creatorId" FOR SHARE', agencyId, ids.slice(offset,offset+500));
  }
  const states = await readBillingExecutionAccess({ db, agencyId, creatorIds: ids });
  for (const id of ids) {
    const state = states.get(id);
    if (!state) throw new BillingExecutionAccessError("BILLING_CREATOR_NOT_FOUND", "Creator is outside the live agency scope", 404);
    if (!state.allowed) throw new BillingExecutionAccessError(state.reason, "Active creator access is required", state.recoverable ? 402 : 403);
  }
}
module.exports = { assertProductBillingTargets, withProductBilling, inProductBilling, assertProductBilling, productBillingScope };

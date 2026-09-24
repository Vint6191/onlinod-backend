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
module.exports = { withProductBilling, inProductBilling, assertProductBilling, productBillingScope };

"use strict";
const { catalogForPolicy } = require("./billing-catalog-service");

function billingPage(query = {}) {
  const limit = query.limit == null ? 100 : Number(query.limit);
  const after = query.after == null ? null : query.after;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (after != null && (typeof after !== "string" || !after.length || after.length > 180))) {
    throw Object.assign(new Error("Invalid billing page"), { code: "BILLING_PAGE_INVALID", status: 400 });
  }
  return { limit, after };
}

// Only current creators/profiles/entitlements participate. History size never
// affects this reader; the global aggregate returns one row, a page at most 100.
const TOTALS_SQL = `WITH agencies AS MATERIALIZED (
  SELECT a."id",a."billingSupportHold",a."trialEndsAt",COALESCE(s."billingMode"::text,'MANUAL') AS mode,COALESCE(s."status"::text,'TRIAL') AS sub_status
  FROM "Agency" a LEFT JOIN LATERAL (SELECT "billingMode","status" FROM "AgencySubscription"
    WHERE "agencyId"=a."id" ORDER BY "createdAt" DESC,"id" DESC LIMIT 1) s ON true
  WHERE a."deletedAt" IS NULL AND ($1::boolean OR a."id"=ANY($2::text[]))
), lines AS (
  SELECT c."agencyId", c."id",
    CASE WHEN e."coreValidUntil">$3 AND (e."coreValidFrom" IS NULL OR e."coreValidFrom"<=$3) THEN e."coreValidUntil" END AS active_until,
    CASE WHEN e."coreValidUntil">$3 AND (e."coreValidFrom" IS NULL OR e."coreValidFrom"<=$3) THEN e."corePriceCents" ELSE 0 END AS core,
    CASE WHEN e."aiChatterValidUntil">$3 THEN e."aiChatterPriceCents" ELSE 0 END AS ai,
    CASE WHEN e."outreachValidUntil">$3 THEN e."outreachPriceCents" ELSE 0 END AS outreach,
    CASE WHEN p."billingExcluded" THEN 0 ELSE
      COALESCE(p."corePriceOverrideCents",($4::jsonb->>COALESCE(p."tier"::text,'STARTER'))::int,0)
      + CASE WHEN p."aiChatterEnabled" THEN COALESCE(p."aiChatterPriceOverrideCents",($4::jsonb->>'ai')::int) ELSE 0 END
      + CASE WHEN p."outreachEnabled" THEN COALESCE(p."outreachPriceOverrideCents",($4::jsonb->>'outreach')::int) ELSE 0 END END AS configured
  FROM "CreatorAccount" c JOIN agencies a ON a."id"=c."agencyId"
  LEFT JOIN "CreatorBillingEntitlement" e ON e."creatorId"=c."id" AND e."agencyId"=c."agencyId"
  LEFT JOIN "CreatorBillingProfile" p ON p."creatorId"=c."id" AND p."agencyId"=c."agencyId"
  WHERE c."deletedAt" IS NULL
), totals AS (
  SELECT a."id",a.mode,a."billingSupportHold",a."trialEndsAt",a.sub_status,
    max(l.active_until) AS "activeUntil",count(l."id")::text AS "modelsTotal",
    count(l."id") FILTER(WHERE l.core+l.ai+l.outreach>0)::text AS "modelsBilled",
    COALESCE(sum(l.core+l.ai+l.outreach),0)::text AS "monthlyCents",
    COALESCE(sum(l.configured),0)::text AS "configuredCents",
    COALESCE(sum(l.ai),0)::text AS ai,COALESCE(sum(l.outreach),0)::text AS outreach
  FROM agencies a LEFT JOIN lines l ON l."agencyId"=a."id"
  GROUP BY a."id",a.mode,a."billingSupportHold",a."trialEndsAt",a.sub_status
), states AS (
  SELECT totals.*, CASE WHEN "billingSupportHold" THEN 'LOCKED'
    WHEN "activeUntil" IS NOT NULL OR mode='FREE_INTERNAL' THEN 'ACTIVE'
    WHEN "trialEndsAt">$3 THEN 'TRIAL' WHEN sub_status='CANCELLED' THEN 'CANCELLED' ELSE 'PAST_DUE' END AS status
  FROM totals
)`;

function parameters({ agencyIds = [], policy, now }, global) {
  const { tiers, addons } = catalogForPolicy(policy);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("BILLING_STATE_CLOCK_REQUIRED");
  return [global, agencyIds, now, JSON.stringify({ ...Object.fromEntries(Object.entries(tiers).map(([k,v]) => [k,v.priceCents ?? 0])), ai: addons.aiChatter.priceCents, outreach: addons.outreach.priceCents })];
}
function integer(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("BILLING_TOTAL_INVALID");
  return n;
}
async function readAgencyBillingTotals(input) {
  if (!input.agencyIds.length) return new Map();
  if (input.agencyIds.length > 100) throw new Error("BILLING_TOTAL_PAGE_TOO_LARGE");
  const rows = await input.db.$queryRawUnsafe(`${TOTALS_SQL} SELECT * FROM states`, ...parameters(input, false));
  return new Map(rows.map(row => [row.id, { ...row, ...Object.fromEntries(["modelsTotal","modelsBilled","monthlyCents","configuredCents","ai","outreach"].map(key => [key,integer(row[key])])) }]));
}
async function readGlobalBillingTotals(input) {
  const [row] = await input.db.$queryRawUnsafe(`${TOTALS_SQL} SELECT
    COALESCE(sum("monthlyCents"::bigint) FILTER(WHERE status='ACTIVE' AND mode<>'FREE_INTERNAL'),0)::text AS "billedCents",
    COALESCE(sum("configuredCents"::bigint) FILTER(WHERE status='TRIAL'),0)::text AS "trialPotentialCents",
    COALESCE(sum("modelsBilled"::bigint) FILTER(WHERE status='ACTIVE' AND mode<>'FREE_INTERNAL'),0)::text AS "billedModels",
    count(*) FILTER(WHERE status='ACTIVE' AND mode<>'FREE_INTERNAL')::text AS "billableAgencies",count(*)::text AS "totalAgencies" FROM states`, ...parameters(input, true));
  if (!row) throw new Error("BILLING_TOTAL_UNAVAILABLE");
  return Object.fromEntries(["billedCents","trialPotentialCents","billedModels","billableAgencies","totalAgencies"].map(key => [key,integer(row[key])]));
}
module.exports = { billingPage, readAgencyBillingTotals, readGlobalBillingTotals, TOTALS_SQL };

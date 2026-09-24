"use strict";

// Effective state is a read of current facts, never an interpretation of a
// cached Agency.status. Projection repair is eventual; expiry is not.
function date(value) {
  if (value == null || value === "") return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function activeCore(entitlement, now) {
  const until = date(entitlement?.coreValidUntil);
  const from = date(entitlement?.coreValidFrom);
  // A malformed explicit start must not become a legacy, unspecified start.
  return !!until && until > now
    && (entitlement?.coreValidFrom == null || (!!from && from <= now));
}

function scopedEntitlement(creator, agencyId) {
  const entitlement = creator?.billingEntitlement;
  return creator && !creator.deletedAt && creator.agencyId === agencyId
    && entitlement?.agencyId === agencyId && entitlement?.creatorId === creator.id ? entitlement : null;
}

function liveEntitlementEnd(creators, agencyId, now) {
  let end = null;
  for (const creator of creators || []) {
    const entitlement = scopedEntitlement(creator, agencyId);
    if (!activeCore(entitlement, now)) continue;
    const candidate = date(entitlement.coreValidUntil);
    if (!end || candidate > end) end = candidate;
  }
  return end;
}

function effectiveBillingState({ agency, subscription = null, activeUntil = null, billingMode = null, now }) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError("BILLING_STATE_CLOCK_REQUIRED");
  if (!agency) throw Object.assign(new Error("Agency not found"), { code: "AGENCY_NOT_FOUND", status: 404 });
  const mode = billingMode || subscription?.billingMode || "MANUAL";
  const paid = date(activeUntil);
  const currentPeriodEnd = paid && paid > now ? paid : null;
  const trialEndsAt = date(agency.trialEndsAt);
  const supportHold = agency.billingSupportHold === true;
  let status;
  if (agency.deletedAt || supportHold) status = "LOCKED";
  else if (currentPeriodEnd || mode === "FREE_INTERNAL") status = "ACTIVE";
  else if (trialEndsAt && trialEndsAt > now) status = "TRIAL";
  else if (subscription?.status === "CANCELLED") status = "CANCELLED";
  else status = "PAST_DUE";
  return { status, currentPeriodEnd, billingMode: mode, supportHold };
}

function sameDate(a, b) {
  return (date(a)?.getTime() ?? null) === (date(b)?.getTime() ?? null);
}

// Dashboard cardinality is constant: PostgreSQL aggregates current facts,
// rather than materializing every entitlement/creator in the Node process.
// No historical BillingOrder/Period/Ledger scan is involved.
async function readBillingDashboard({ db }) {
  const rows = await db.$queryRawUnsafe(`
    WITH clock AS MATERIALIZED (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS at),
    agencies AS MATERIALIZED (
      SELECT a."id",a."billingSupportHold",a."trialEndsAt",
        COALESCE(s."billingMode"::text,'MANUAL') AS mode,
        COALESCE(s."status"::text,'TRIAL') AS subscription_status
      FROM "Agency" a
      LEFT JOIN LATERAL (SELECT "billingMode","status" FROM "AgencySubscription"
        WHERE "agencyId"=a."id" ORDER BY "createdAt" DESC,"id" DESC LIMIT 1) s ON true
      WHERE a."deletedAt" IS NULL
    ),
    paid AS MATERIALIZED (
      SELECT e."agencyId",
        bool_or(e."coreValidUntil">clock.at AND (e."coreValidFrom" IS NULL OR e."coreValidFrom"<=clock.at)) AS core_active,
        COALESCE(sum(CASE WHEN e."coreValidUntil">clock.at AND (e."coreValidFrom" IS NULL OR e."coreValidFrom"<=clock.at) THEN e."corePriceCents" ELSE 0 END),0) AS core,
        COALESCE(sum(CASE WHEN e."aiChatterValidUntil">clock.at THEN e."aiChatterPriceCents" ELSE 0 END),0) AS ai,
        COALESCE(sum(CASE WHEN e."outreachValidUntil">clock.at THEN e."outreachPriceCents" ELSE 0 END),0) AS outreach
      FROM "CreatorBillingEntitlement" e
      JOIN "CreatorAccount" c ON c."id"=e."creatorId" AND c."agencyId"=e."agencyId" AND c."deletedAt" IS NULL
      JOIN agencies a ON a."id"=e."agencyId"
      CROSS JOIN clock
      WHERE e."coreValidUntil">clock.at OR e."aiChatterValidUntil">clock.at OR e."outreachValidUntil">clock.at
      GROUP BY e."agencyId"
    ), states AS (
      SELECT a.*,p.core,p.ai,p.outreach,
        CASE WHEN a."billingSupportHold" THEN 'LOCKED'
          WHEN p.core_active OR a.mode='FREE_INTERNAL' THEN 'ACTIVE'
          WHEN a."trialEndsAt">clock.at THEN 'TRIAL'
          WHEN a.subscription_status='CANCELLED' THEN 'CANCELLED'
          ELSE 'PAST_DUE' END AS effective_status
      FROM agencies a CROSS JOIN clock LEFT JOIN paid p ON p."agencyId"=a."id"
    )
    SELECT count(*)::text AS total,
      count(*) FILTER (WHERE effective_status='ACTIVE')::text AS active,
      count(*) FILTER (WHERE effective_status='TRIAL')::text AS trial,
      count(*) FILTER (WHERE effective_status IN ('LOCKED','PAST_DUE'))::text AS locked,
      COALESCE(sum(core) FILTER (WHERE effective_status='ACTIVE' AND mode<>'FREE_INTERNAL'),0)::text AS core,
      COALESCE(sum(ai) FILTER (WHERE effective_status='ACTIVE' AND mode<>'FREE_INTERNAL'),0)::text AS ai,
      COALESCE(sum(outreach) FILTER (WHERE effective_status='ACTIVE' AND mode<>'FREE_INTERNAL'),0)::text AS outreach
    FROM states`);
  const row = rows?.[0];
  if (!row) throw new Error("BILLING_DASHBOARD_STATE_UNAVAILABLE");
  const value = key => {
    const n = Number(row[key]);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error("BILLING_DASHBOARD_STATE_INVALID");
    return n;
  };
  return { counts: { total: value("total"), active: value("active"), trial: value("trial"), locked: value("locked") },
    mrr: { coreCents: value("core"), aiChatterCents: value("ai"), outreachCents: value("outreach") } };
}

module.exports = { activeCore, scopedEntitlement, liveEntitlementEnd, effectiveBillingState, sameDate, readBillingDashboard };

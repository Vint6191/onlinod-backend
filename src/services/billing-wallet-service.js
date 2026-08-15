"use strict";

const prisma = require("../prisma");
const { audit } = require("./audit-service");
const { TIER_CATALOG, ADDON_CATALOG, automaticTierForRevenue } = require("./billing-catalog-service");
const { isFuture, lockAgencyBillingMutation, syncAgencyBillingAggregate } = require("./billing-entitlement-service");

const DEFAULT_MAX_EARNINGS_AGE_HOURS = 48;
const MAX_INT_CENTS = 2_147_483_647;

function asDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function cents(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return Math.max(0, Math.round(Number(fallback || 0)));
  return Math.max(0, Math.min(MAX_INT_CENTS, Math.round(n)));
}

function bigintCents(value) {
  if (typeof value === "bigint") return value;
  if (value === null || value === undefined || value === "") return 0n;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isSafeInteger(Math.round(n))) throw new Error("Invalid wallet amount");
  return BigInt(Math.round(n));
}

function publicBigInt(value) {
  const n = bigintCents(value);
  const asNumber = Number(n);
  return Number.isSafeInteger(asNumber) ? asNumber : String(n);
}

function billingError(message, code, status = 409, extra = null) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  err.permanent = status >= 400 && status < 500;
  if (extra && typeof extra === "object") Object.assign(err, extra);
  return err;
}

function utcDay(value) {
  const date = asDate(value) || new Date();
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function closedRevenueWindow(now = new Date()) {
  const endDay = utcDay(now);
  endDay.setUTCDate(endDay.getUTCDate() - 1);
  const startDay = new Date(endDay);
  startDay.setUTCDate(startDay.getUTCDate() - 29);
  return { startDay, endDay };
}

function normalizedAnchorDay(value, fallbackDate = null) {
  const n = Number(value);
  if (Number.isInteger(n) && n >= 1 && n <= 31) return n;
  const fallback = asDate(fallbackDate);
  return fallback ? fallback.getUTCDate() : null;
}

function addMonthsAnchoredUtc(value, months, anchorDay) {
  const date = asDate(value);
  if (!date) return null;
  const anchor = normalizedAnchorDay(anchorDay, date) || date.getUTCDate();
  const target = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth() + Number(months || 0),
    1,
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  ));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(anchor, lastDay));
  return target;
}

function envEnabled(name, fallback = false) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function liveAutoPricingEnabled() {
  return envEnabled("BILLING_LIVE_AUTO_PRICING_ENABLED", false);
}

function earningsMaxAgeMs() {
  const raw = Number(process.env.BILLING_EARNINGS_MAX_AGE_HOURS || DEFAULT_MAX_EARNINGS_AGE_HOURS);
  const hours = Number.isFinite(raw) ? Math.max(1, Math.min(168, raw)) : DEFAULT_MAX_EARNINGS_AGE_HOURS;
  return hours * 60 * 60 * 1000;
}

async function readRolling30dRevenue({ db, creatorId, now = new Date() }) {
  // Monetary pricing uses the last 30 fully closed UTC days. Never authorize a
  // debit from today's PARTIAL row: its value depends on what time the scanner
  // happened to run and can materially understate the creator's true 30-day
  // earnings by renewal time.
  if (db.creatorEarningsDaily?.findMany && db.analyticsCoverage?.count) {
    const closed = closedRevenueWindow(now);
    const [rows, completeDays] = await Promise.all([
      db.creatorEarningsDaily.findMany({
        where: { creatorId, sourceTimezone: "UTC", sourceJobId: { not: null }, sourceScanRunId: { not: null }, sourceJob: { is: { jobKey: "fetch_earnings", status: "DONE", completedAt: { not: null } } }, date: { gte: closed.startDay, lte: closed.endDay } },
        orderBy: { date: "asc" },
      }),
      db.analyticsCoverage.count({
        where: { creatorId, dataType: "EARNINGS", sourceTimezone: "UTC", status: "COMPLETE", ingestBatchId: { not: null }, lastVerifiedAt: { not: null }, ingestBatch: { is: { status: "COMMITTED", sourceJobId: { not: null }, completedAt: { not: null } } }, coverageDate: { gte: closed.startDay, lte: closed.endDay } },
      }),
    ]);
    const uniqueDays = new Set(rows.map((row) => asDate(row.date)?.toISOString().slice(0, 10)).filter(Boolean));
    if (completeDays >= 30 && uniqueDays.size >= 30) {
      const newest = rows.reduce((latest, row) => {
        const candidate = asDate(row.collectedAt || row.updatedAt || row.date);
        return candidate && (!latest || candidate > latest) ? candidate : latest;
      }, null);
      return {
        revenue30dCents: cents(rows.reduce((sum, row) => sum + cents(row.totalCents), 0)),
        capturedAt: newest || closed.endDay,
        source: "EARNINGS_DAILY_COMPLETE_30D",
        fresh: true,
      };
    }
  }

  // Legacy 30d snapshots remain display-only estimates. The billing amount is
  // unavailable until the relational ledger proves all 30 closed days.
  const snapshot = db.creatorEarningsSnapshot?.findUnique
    ? await db.creatorEarningsSnapshot.findUnique({ where: { creatorId_rangeKey: { creatorId, rangeKey: "30d" } } })
    : null;
  const capturedAt = asDate(snapshot?.capturedAt);
  const snapshotRecent = !!snapshot && !!capturedAt && now.getTime() - capturedAt.getTime() <= earningsMaxAgeMs();
  return {
    revenue30dCents: snapshot ? cents(snapshot.totalCents) : null,
    capturedAt,
    source: snapshot ? (snapshotRecent ? "EARNINGS_SNAPSHOT_30D_UNVERIFIED" : "EARNINGS_SNAPSHOT_30D_STALE") : "UNAVAILABLE",
    fresh: false,
  };
}

async function readRolling30dRevenueBatch({ db, creatorIds, now = new Date() }) {
  const ids = [...new Set((creatorIds || []).map((value) => String(value || "").trim()).filter(Boolean))];
  const results = new Map();
  if (!ids.length) return results;

  // Real Prisma path: aggregate the same 30 fully closed days in two grouped
  // queries, independent of creator count. No N*30 daily-row materialization.
  if (db.creatorEarningsDaily?.groupBy && db.analyticsCoverage?.groupBy) {
    const snapshots = db.creatorEarningsSnapshot?.findMany
      ? await db.creatorEarningsSnapshot.findMany({ where: { creatorId: { in: ids }, rangeKey: "30d" } })
      : [];
    const snapshotByCreator = new Map(snapshots.map((row) => [String(row.creatorId), row]));
    for (const creatorId of ids) {
      const snapshot = snapshotByCreator.get(creatorId) || null;
      const capturedAt = asDate(snapshot?.capturedAt);
      const recent = !!snapshot && !!capturedAt && now.getTime() - capturedAt.getTime() <= earningsMaxAgeMs();
      results.set(creatorId, {
        revenue30dCents: snapshot ? cents(snapshot.totalCents) : null,
        capturedAt,
        source: snapshot ? (recent ? "EARNINGS_SNAPSHOT_30D_UNVERIFIED" : "EARNINGS_SNAPSHOT_30D_STALE") : "UNAVAILABLE",
        fresh: false,
      });
    }

    const closed = closedRevenueWindow(now);
    const [dailyGroups, coverageGroups] = await Promise.all([
      db.creatorEarningsDaily.groupBy({
        by: ["creatorId"],
        where: { creatorId: { in: ids }, sourceTimezone: "UTC", sourceJobId: { not: null }, sourceScanRunId: { not: null }, sourceJob: { is: { jobKey: "fetch_earnings", status: "DONE", completedAt: { not: null } } }, date: { gte: closed.startDay, lte: closed.endDay } },
        _count: { _all: true },
        _sum: { totalCents: true },
        _max: { collectedAt: true },
      }),
      db.analyticsCoverage.groupBy({
        by: ["creatorId"],
        where: { creatorId: { in: ids }, dataType: "EARNINGS", sourceTimezone: "UTC", status: "COMPLETE", ingestBatchId: { not: null }, lastVerifiedAt: { not: null }, ingestBatch: { is: { status: "COMMITTED", sourceJobId: { not: null }, completedAt: { not: null } } }, coverageDate: { gte: closed.startDay, lte: closed.endDay } },
        _count: { _all: true },
      }),
    ]);
    const dailyByCreator = new Map(dailyGroups.map((row) => [String(row.creatorId), row]));
    const coverageByCreator = new Map(coverageGroups.map((row) => [String(row.creatorId), Number(row?._count?._all || 0)]));
    for (const creatorId of ids) {
      const daily = dailyByCreator.get(creatorId);
      if (Number(daily?._count?._all || 0) >= 30 && (coverageByCreator.get(creatorId) || 0) >= 30) {
        results.set(creatorId, {
          revenue30dCents: cents(daily?._sum?.totalCents),
          capturedAt: asDate(daily?._max?.collectedAt) || closed.endDay,
          source: "EARNINGS_DAILY_COMPLETE_30D",
          fresh: true,
        });
      }
    }
    return results;
  }

  for (const creatorId of ids) {
    results.set(creatorId, await readRolling30dRevenue({ db, creatorId, now }));
  }
  return results;
}

function configuredAddonPrice(profile, key) {
  if (key === "ai") return cents(profile?.aiChatterPriceCents, ADDON_CATALOG.aiChatter.priceCents);
  return cents(profile?.outreachPriceCents, ADDON_CATALOG.outreach.priceCents);
}

function pricingFromRevenue({ profile, revenue }) {
  if (!revenue?.fresh || revenue.revenue30dCents === null) {
    throw billingError(
      "A complete earnings ledger for the previous 30 closed UTC days is required before starting or renewing this subscription",
      "BILLING_EARNINGS_30D_UNAVAILABLE",
      409,
      { revenueCapturedAt: revenue?.capturedAt || null },
    );
  }

  const mode = String(profile?.tierMode || "AUTO").toUpperCase();
  const configuredTier = String(profile?.tier || "STARTER").toUpperCase();
  const manual = mode === "MANUAL" && ["STARTER", "GROWTH", "PRO", "ELITE", "CUSTOM"].includes(configuredTier);
  const tier = manual ? configuredTier : automaticTierForRevenue(revenue.revenue30dCents);
  const catalogPrice = TIER_CATALOG[tier]?.priceCents;
  const corePriceCents = manual
    ? cents(profile?.corePriceCents, catalogPrice || TIER_CATALOG.STARTER.priceCents)
    : cents(catalogPrice, TIER_CATALOG.STARTER.priceCents);
  if (corePriceCents <= 0) throw billingError("Configured creator price is not billable", "BILLING_CORE_PRICE_INVALID");

  const aiChatterEnabled = profile?.aiChatterEnabled === true;
  const outreachEnabled = profile?.outreachEnabled === true;
  const aiChatterPriceCents = aiChatterEnabled ? configuredAddonPrice(profile, "ai") : 0;
  const outreachPriceCents = outreachEnabled ? configuredAddonPrice(profile, "outreach") : 0;
  return {
    tier,
    pricingSource: manual ? "ADMIN_OVERRIDE" : "AUTO_30D",
    revenue30dCents: revenue.revenue30dCents,
    revenueCapturedAt: revenue.capturedAt,
    revenueSource: revenue.source,
    corePriceCents,
    aiChatterEnabled,
    aiChatterPriceCents,
    outreachEnabled,
    outreachPriceCents,
    totalCents: corePriceCents + aiChatterPriceCents + outreachPriceCents,
  };
}

function pricingPreviewFromRevenue({ profile, revenue }) {
  const normalized = revenue || { revenue30dCents: null, capturedAt: null, source: "UNAVAILABLE", fresh: false };
  if (normalized.fresh && normalized.revenue30dCents !== null) {
    return { available: true, errorCode: null, ...pricingFromRevenue({ profile, revenue: normalized }) };
  }
  const mode = String(profile?.tierMode || "AUTO").toUpperCase();
  const configuredTier = String(profile?.tier || "STARTER").toUpperCase();
  const manual = mode === "MANUAL" && ["STARTER", "GROWTH", "PRO", "ELITE", "CUSTOM"].includes(configuredTier);
  const tier = manual ? configuredTier : (normalized.revenue30dCents === null ? null : automaticTierForRevenue(normalized.revenue30dCents));
  const corePriceCents = tier ? (manual ? cents(profile?.corePriceCents, TIER_CATALOG[tier]?.priceCents || TIER_CATALOG.STARTER.priceCents) : cents(TIER_CATALOG[tier]?.priceCents)) : 0;
  const aiChatterEnabled = profile?.aiChatterEnabled === true;
  const outreachEnabled = profile?.outreachEnabled === true;
  const aiChatterPriceCents = aiChatterEnabled ? configuredAddonPrice(profile, "ai") : 0;
  const outreachPriceCents = outreachEnabled ? configuredAddonPrice(profile, "outreach") : 0;
  return {
    available: false,
    errorCode: "BILLING_EARNINGS_30D_UNAVAILABLE",
    tier,
    pricingSource: manual ? "ADMIN_OVERRIDE" : "AUTO_30D",
    revenue30dCents: normalized.revenue30dCents,
    revenueCapturedAt: normalized.capturedAt || null,
    revenueSource: normalized.source || "UNAVAILABLE",
    corePriceCents,
    aiChatterEnabled,
    aiChatterPriceCents,
    outreachEnabled,
    outreachPriceCents,
    totalCents: tier ? corePriceCents + aiChatterPriceCents + outreachPriceCents : 0,
  };
}

function pricingPreviewFromSnapshot({ profile, snapshot, now = new Date() }) {
  const capturedAt = asDate(snapshot?.capturedAt);
  const recent = !!snapshot && !!capturedAt && now.getTime() - capturedAt.getTime() <= earningsMaxAgeMs();
  // A legacy summary is display-only evidence. Keep this helper fail-closed too
  // so no future caller can accidentally turn a desktop-written snapshot into
  // monetary authority by reusing this exported preview helper.
  return pricingPreviewFromRevenue({
    profile,
    revenue: {
      revenue30dCents: snapshot ? cents(snapshot.totalCents) : null,
      capturedAt,
      source: snapshot ? (recent ? "EARNINGS_SNAPSHOT_30D_UNVERIFIED" : "EARNINGS_SNAPSHOT_30D_STALE") : "UNAVAILABLE",
      fresh: false,
    },
  });
}

async function quoteCreatorMonthlyPrice({ db = null, creator, now = new Date() }) {
  const client = db || prisma;
  if (!creator) throw billingError("Creator not found", "BILLING_CREATOR_NOT_FOUND", 404);
  if (creator.deletedAt) throw billingError("Creator is deleted", "BILLING_CREATOR_NOT_FOUND", 404);
  if (creator.billingProfile?.billingExcluded === true) throw billingError("Creator is excluded from billing", "BILLING_CREATOR_EXCLUDED");
  const revenue = await readRolling30dRevenue({ db: client, creatorId: creator.id, now });
  return pricingPreviewFromRevenue({ profile: creator.billingProfile, revenue });
}

function walletUniqueWhere(agencyId, testMode) {
  return { agencyId_testMode: { agencyId: String(agencyId), testMode: testMode === true } };
}

async function ensureWallet(tx, agencyId, testMode) {
  return tx.agencyBillingWallet.upsert({
    where: walletUniqueWhere(agencyId, testMode),
    create: { agencyId, testMode: testMode === true, balanceCents: 0n, currency: "USD" },
    update: {},
  });
}

async function assertWalletDebitAllowed(tx, agencyId, testMode) {
  // Sandbox is deliberately available for end-to-end provider/billing tests. Live
  // automatic pricing is a separate opt-in because the earnings ledger is produced
  // by an authenticated desktop worker rather than an independently signed OF feed.
  // Rules and debits are backend-owned, but external-customer live charging must not
  // silently trust that worker evidence until the operator accepts this trust model.
  if (testMode === true) return;
  // Production Prisma always exposes AgencySubscription. Keep service-level test
  // doubles without the model usable, but never bypass either live guard on the
  // real database path.
  if (!tx.agencySubscription?.findFirst) return;
  const subscription = await tx.agencySubscription.findFirst({ where: { agencyId }, orderBy: { createdAt: "desc" }, select: { billingMode: true } });
  if (String(subscription?.billingMode || "MANUAL") === "FREE_INTERNAL") {
    throw billingError("Live wallet billing is disabled while this workspace is FREE_INTERNAL", "BILLING_FREE_INTERNAL_LIVE_DEBIT_DISABLED", 409);
  }
  if (!liveAutoPricingEnabled()) {
    throw billingError(
      "Live automatic creator billing is disabled until BILLING_LIVE_AUTO_PRICING_ENABLED is explicitly enabled",
      "BILLING_LIVE_AUTO_PRICING_DISABLED",
      409,
    );
  }
}

function publicWallet(row) {
  return {
    id: row ? String(row.id) : null,
    testMode: row?.testMode === true,
    balanceCents: row ? publicBigInt(row.balanceCents) : 0,
    currency: String(row?.currency || "USD"),
    updatedAt: row?.updatedAt ? asDate(row.updatedAt)?.toISOString() || null : null,
  };
}

function publicWalletTransaction(row) {
  return {
    id: String(row.id),
    type: String(row.type),
    creatorId: row.creatorId || null,
    orderId: row.orderId || null,
    periodId: row.periodId || null,
    testMode: row.testMode === true,
    amountCents: publicBigInt(row.amountCents),
    balanceAfterCents: publicBigInt(row.balanceAfterCents),
    currency: String(row.currency || "USD"),
    description: row.description || null,
    createdAt: asDate(row.createdAt)?.toISOString() || null,
  };
}

function publicBillingPeriod(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    creatorId: String(row.creatorId),
    testMode: row.testMode === true,
    tier: String(row.tier),
    revenue30dCents: cents(row.revenue30dCents),
    revenueCapturedAt: row.revenueCapturedAt ? asDate(row.revenueCapturedAt)?.toISOString() || null : null,
    pricingSource: String(row.pricingSource || "AUTO_30D"),
    corePriceCents: cents(row.corePriceCents),
    aiChatterEnabled: row.aiChatterEnabled === true,
    aiChatterPriceCents: cents(row.aiChatterPriceCents),
    outreachEnabled: row.outreachEnabled === true,
    outreachPriceCents: cents(row.outreachPriceCents),
    totalCents: cents(row.totalCents),
    startedAt: asDate(row.startedAt)?.toISOString() || null,
    endsAt: asDate(row.endsAt)?.toISOString() || null,
    status: String(row.status || "ACTIVE"),
    createdAt: asDate(row.createdAt)?.toISOString() || null,
  };
}

function assertWalletTransactionBinding(row, { agencyId, testMode, amountCents, type, creatorId = null, orderId = null, periodId = null, idempotencyKey }) {
  if (!row) return;
  const mismatches = [];
  if (String(row.agencyId || "") !== String(agencyId || "")) mismatches.push("agencyId");
  if ((row.testMode === true) !== (testMode === true)) mismatches.push("testMode");
  if (String(row.idempotencyKey || "") !== String(idempotencyKey || "")) mismatches.push("idempotencyKey");
  if (String(row.type || "") !== String(type || "")) mismatches.push("type");
  if (bigintCents(row.amountCents) !== bigintCents(amountCents)) mismatches.push("amountCents");
  if (String(row.creatorId || "") !== String(creatorId || "")) mismatches.push("creatorId");
  if (String(row.orderId || "") !== String(orderId || "")) mismatches.push("orderId");
  if (String(row.periodId || "") !== String(periodId || "")) mismatches.push("periodId");
  if (mismatches.length) {
    throw billingError(
      `Wallet idempotency key is already bound to a different billing mutation (${mismatches.join(", ")})`,
      "BILLING_WALLET_IDEMPOTENCY_BINDING_MISMATCH",
      409,
    );
  }
}

async function mutateWallet(tx, { agencyId, testMode, amountCents, type, idempotencyKey, creatorId = null, orderId = null, periodId = null, description = null, metadata = null }) {
  const existing = await tx.billingWalletTransaction.findUnique({ where: { idempotencyKey } });
  if (existing) {
    assertWalletTransactionBinding(existing, { agencyId, testMode, amountCents, type, creatorId, orderId, periodId, idempotencyKey });
    const wallet = await tx.agencyBillingWallet.findUnique({ where: walletUniqueWhere(agencyId, testMode) });
    if (!wallet || String(wallet.id || "") !== String(existing.walletId || "")) {
      throw billingError("Wallet transaction does not belong to the expected agency wallet", "BILLING_WALLET_TRANSACTION_SCOPE_MISMATCH", 409);
    }
    return { transaction: existing, wallet, replayed: true };
  }

  const wallet = await ensureWallet(tx, agencyId, testMode);
  const delta = bigintCents(amountCents);
  const before = bigintCents(wallet.balanceCents);
  const after = before + delta;
  const updated = await tx.agencyBillingWallet.update({ where: { id: wallet.id }, data: { balanceCents: after } });
  const transaction = await tx.billingWalletTransaction.create({
    data: {
      walletId: wallet.id,
      agencyId,
      creatorId,
      orderId,
      periodId,
      testMode: testMode === true,
      type,
      amountCents: delta,
      balanceAfterCents: after,
      currency: "USD",
      idempotencyKey,
      description,
      metadata,
    },
  });
  return { transaction, wallet: updated, replayed: false };
}

async function creditPaidTopUp({ orderId, sandboxActivationEnabled, db = null }) {
  const client = db || prisma;
  return client.$transaction(async (tx) => {
    const identity = await tx.billingOrder.findUnique({ where: { id: orderId }, select: { id: true, agencyId: true } });
    if (!identity) return { credited: false, reason: "ORDER_NOT_FOUND" };
    await lockAgencyBillingMutation(tx, identity.agencyId);
    const order = await tx.billingOrder.findUnique({ where: { id: orderId } });
    if (!order || String(order.purpose || "SUBSCRIPTION") !== "WALLET_TOP_UP" || order.status !== "PAID") return { credited: false, reason: "ORDER_NOT_PAID_TOP_UP" };
    if (order.testMode && sandboxActivationEnabled !== true) return { credited: false, reason: "SANDBOX_ACTIVATION_DISABLED" };

    const idempotencyKey = `topup:${order.id}`;
    const already = await tx.billingWalletTransaction.findUnique({ where: { idempotencyKey } });
    if (already) {
      assertWalletTransactionBinding(already, {
        agencyId: order.agencyId,
        testMode: order.testMode === true,
        amountCents: BigInt(order.amountCents),
        type: "TOP_UP",
        orderId: order.id,
        idempotencyKey,
      });
      return { credited: false, reason: "ALREADY_CREDITED", transaction: publicWalletTransaction(already) };
    }

    const claim = await tx.billingOrder.updateMany({ where: { id: order.id, status: "PAID", activatedAt: null }, data: { activatedAt: new Date(), paidAt: order.paidAt || new Date() } });
    if (claim.count !== 1) {
      const replay = await tx.billingWalletTransaction.findUnique({ where: { idempotencyKey } });
      if (replay) {
        assertWalletTransactionBinding(replay, {
          agencyId: order.agencyId,
          testMode: order.testMode === true,
          amountCents: BigInt(order.amountCents),
          type: "TOP_UP",
          orderId: order.id,
          idempotencyKey,
        });
        return { credited: false, reason: "ALREADY_CREDITED", transaction: publicWalletTransaction(replay) };
      }
      return { credited: false, reason: "ORDER_ALREADY_ACTIVATED" };
    }

    const result = await mutateWallet(tx, {
      agencyId: order.agencyId,
      testMode: order.testMode === true,
      amountCents: BigInt(order.amountCents),
      type: "TOP_UP",
      idempotencyKey,
      orderId: order.id,
      description: `Balance top-up · $${(Number(order.amountCents) / 100).toFixed(2)}`,
      metadata: { provider: String(order.provider || "NOWPAYMENTS"), providerInvoiceId: order.providerInvoiceId || null },
    });
    return { credited: true, wallet: publicWallet(result.wallet), transaction: publicWalletTransaction(result.transaction) };
  });
}

async function refundTopUp({ order, db = null }) {
  const orderId = String(order?.id || "").trim();
  const agencyId = String(order?.agencyId || "").trim();
  if (!orderId || !agencyId) return { reversed: false, reason: "ORDER_NOT_FOUND" };
  const client = db || prisma;
  return client.$transaction(async (tx) => {
    await lockAgencyBillingMutation(tx, agencyId);
    const current = await tx.billingOrder.findUnique({ where: { id: orderId } });
    if (!current || String(current.purpose || "SUBSCRIPTION") !== "WALLET_TOP_UP" || current.status !== "REFUNDED") return { reversed: false, reason: "ORDER_NOT_REFUNDED_TOP_UP" };
    const originalIdempotencyKey = `topup:${orderId}`;
    const original = await tx.billingWalletTransaction.findUnique({ where: { idempotencyKey: originalIdempotencyKey } });
    if (!original) return { reversed: false, reason: "TOP_UP_WAS_NOT_CREDITED" };
    assertWalletTransactionBinding(original, {
      agencyId,
      testMode: current.testMode === true,
      amountCents: BigInt(current.amountCents),
      type: "TOP_UP",
      orderId,
      idempotencyKey: originalIdempotencyKey,
    });
    const result = await mutateWallet(tx, {
      agencyId,
      testMode: current.testMode === true,
      amountCents: -bigintCents(original.amountCents),
      type: "TOP_UP_REFUND",
      idempotencyKey: `topup-refund:${orderId}`,
      orderId,
      description: `Refunded balance top-up · $${(Number(bigintCents(original.amountCents)) / 100).toFixed(2)}`,
      metadata: { originalTransactionId: original.id },
    });
    return { reversed: !result.replayed, wallet: publicWallet(result.wallet), transaction: publicWalletTransaction(result.transaction) };
  });
}

async function setCreatorBillingPreferences({ agencyId, creatorId, aiChatterEnabled, outreachEnabled, actorUserId = null, db = null }) {
  const client = db || prisma;
  const result = await client.$transaction(async (tx) => {
    await lockAgencyBillingMutation(tx, agencyId);
    const creator = await tx.creatorAccount.findFirst({ where: { id: creatorId, agencyId, deletedAt: null }, include: { billingProfile: true } });
    if (!creator) throw billingError("Creator not found", "BILLING_CREATOR_NOT_FOUND", 404);
    if (creator.billingProfile?.billingExcluded === true) throw billingError("Creator is excluded from billing", "BILLING_CREATOR_EXCLUDED");
    const data = {
      aiChatterEnabled: aiChatterEnabled === true,
      outreachEnabled: outreachEnabled === true,
    };
    const profile = await tx.creatorBillingProfile.upsert({
      where: { creatorId },
      create: {
        agencyId,
        creatorId,
        tier: "STARTER",
        tierMode: "AUTO",
        corePriceCents: TIER_CATALOG.STARTER.priceCents,
        aiChatterEnabled: data.aiChatterEnabled,
        aiChatterPriceCents: ADDON_CATALOG.aiChatter.priceCents,
        outreachEnabled: data.outreachEnabled,
        outreachPriceCents: ADDON_CATALOG.outreach.priceCents,
        billingExcluded: false,
      },
      update: data,
    });
    return { creator, profile };
  });
  await audit({ agencyId, actorUserId, action: "billing.creator_preferences_changed", targetType: "creator", targetId: creatorId, metadata: { aiChatterEnabled: result.profile.aiChatterEnabled, outreachEnabled: result.profile.outreachEnabled }, db: client }).catch(() => undefined);
  return result.profile;
}

async function chargeMonthlyPeriod(tx, { agencyId, creator, entitlement, testMode, now, reason, startAt = null }) {
  await assertWalletDebitAllowed(tx, agencyId, testMode);
  const profile = creator.billingProfile || null;
  const revenue = await readRolling30dRevenue({ db: tx, creatorId: creator.id, now });
  const pricing = pricingFromRevenue({ profile, revenue });
  const wallet = await ensureWallet(tx, agencyId, testMode);
  const balance = bigintCents(wallet.balanceCents);
  const required = BigInt(pricing.totalCents);
  if (balance < required) {
    throw billingError(
      `Insufficient billing balance: $${(Number(balance) / 100).toFixed(2)} available, $${(pricing.totalCents / 100).toFixed(2)} required`,
      "BILLING_WALLET_INSUFFICIENT_BALANCE",
      409,
      { balanceCents: publicBigInt(balance), requiredCents: pricing.totalCents, shortfallCents: publicBigInt(required - balance) },
    );
  }

  const start = asDate(startAt) || now;
  const priorEnd = asDate(entitlement?.coreValidUntil || entitlement?.currentPeriodEndsAt);
  const continuingBoundary = !!priorEnd && start.getTime() === priorEnd.getTime();
  const inheritedAnchorDay = normalizedAnchorDay(
    entitlement?.billingAnchorDay,
    entitlement?.currentPeriodStartedAt || entitlement?.coreValidFrom || entitlement?.subscriptionStartedAt || start,
  );
  const billingAnchorDay = continuingBoundary ? (inheritedAnchorDay || start.getUTCDate()) : start.getUTCDate();
  const end = addMonthsAnchoredUtc(start, 1, billingAnchorDay);
  if (tx.creatorBillingPeriod?.updateMany) {
    await tx.creatorBillingPeriod.updateMany({
      where: { agencyId, creatorId: creator.id, status: "ACTIVE", endsAt: { lte: start } },
      data: { status: "COMPLETED" },
    });
  }
  const renewalKey = `${reason}:${creator.id}:${start.toISOString()}`;
  const period = await tx.creatorBillingPeriod.create({
    data: {
      agencyId,
      creatorId: creator.id,
      testMode: testMode === true,
      tier: pricing.tier,
      revenue30dCents: pricing.revenue30dCents,
      revenueCapturedAt: pricing.revenueCapturedAt,
      pricingSource: pricing.pricingSource,
      corePriceCents: pricing.corePriceCents,
      aiChatterEnabled: pricing.aiChatterEnabled,
      aiChatterPriceCents: pricing.aiChatterPriceCents,
      outreachEnabled: pricing.outreachEnabled,
      outreachPriceCents: pricing.outreachPriceCents,
      totalCents: pricing.totalCents,
      startedAt: start,
      endsAt: end,
      status: "ACTIVE",
      renewalKey,
    },
  });

  const debit = await mutateWallet(tx, {
    agencyId,
    testMode,
    amountCents: -required,
    type: "SUBSCRIPTION_DEBIT",
    idempotencyKey: `period:${period.id}`,
    creatorId: creator.id,
    periodId: period.id,
    description: `${creator.displayName || creator.username || creator.id} · ${pricing.tier} · ${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)}`,
    metadata: { pricingSource: pricing.pricingSource, revenue30dCents: pricing.revenue30dCents, revenueSource: pricing.revenueSource },
  });
  await tx.creatorBillingPeriod.update({ where: { id: period.id }, data: { walletTransactionId: debit.transaction.id } });

  const subscriptionStartedAt = asDate(entitlement?.subscriptionStartedAt || entitlement?.coreValidFrom) || start;
  const entitlementData = {
    agencyId,
    creatorId: creator.id,
    tier: pricing.tier,
    coreSource: "WALLET",
    corePriceCents: pricing.corePriceCents,
    coreValidFrom: entitlement?.coreValidFrom || subscriptionStartedAt,
    coreValidUntil: end,
    aiChatterSource: pricing.aiChatterEnabled ? "WALLET" : (entitlement?.aiChatterSource || "LEGACY"),
    aiChatterPriceCents: pricing.aiChatterEnabled ? pricing.aiChatterPriceCents : 0,
    aiChatterValidUntil: pricing.aiChatterEnabled ? end : null,
    outreachSource: pricing.outreachEnabled ? "WALLET" : (entitlement?.outreachSource || "LEGACY"),
    outreachPriceCents: pricing.outreachEnabled ? pricing.outreachPriceCents : 0,
    outreachValidUntil: pricing.outreachEnabled ? end : null,
    coreLastOrderId: null,
    aiLastOrderId: null,
    outreachLastOrderId: null,
    lastPaidAt: now,
    subscriptionStartedAt,
    currentPeriodStartedAt: start,
    currentPeriodEndsAt: end,
    nextRenewalAt: end,
    billingAnchorDay,
    tierAtPeriodStart: pricing.tier,
    amountChargedForPeriodCents: pricing.totalCents,
    autoRenewEnabled: true,
    lastRenewalAttemptAt: now,
    lastRenewalErrorCode: null,
    lastRevenue30dCents: pricing.revenue30dCents,
    lastRevenueCapturedAt: pricing.revenueCapturedAt,
    walletTestMode: testMode === true,
  };
  const updatedEntitlement = await tx.creatorBillingEntitlement.upsert({
    where: { creatorId: creator.id },
    create: entitlementData,
    update: entitlementData,
  });

  if (String(profile?.tierMode || "AUTO").toUpperCase() !== "MANUAL") {
    await tx.creatorBillingProfile.upsert({
      where: { creatorId: creator.id },
      create: {
        agencyId,
        creatorId: creator.id,
        tier: pricing.tier,
        tierMode: "AUTO",
        corePriceCents: pricing.corePriceCents,
        revenue30dCents: pricing.revenue30dCents,
        aiChatterEnabled: pricing.aiChatterEnabled,
        aiChatterPriceCents: configuredAddonPrice(profile, "ai"),
        outreachEnabled: pricing.outreachEnabled,
        outreachPriceCents: configuredAddonPrice(profile, "outreach"),
        billingExcluded: false,
      },
      update: { tier: pricing.tier, tierMode: "AUTO", corePriceCents: pricing.corePriceCents, revenue30dCents: pricing.revenue30dCents },
    });
  } else {
    await tx.creatorBillingProfile.update({ where: { creatorId: creator.id }, data: { revenue30dCents: pricing.revenue30dCents } });
  }

  await syncAgencyBillingAggregate(tx, agencyId, now);
  return { period: { ...period, walletTransactionId: debit.transaction.id }, entitlement: updatedEntitlement, wallet: debit.wallet, pricing, transaction: debit.transaction };
}

async function startCreatorSubscription({ agencyId, creatorId, testMode = false, actorUserId = null, db = null, now = new Date() }) {
  const client = db || prisma;
  const result = await client.$transaction(async (tx) => {
    await lockAgencyBillingMutation(tx, agencyId);
    const creator = await tx.creatorAccount.findFirst({ where: { id: creatorId, agencyId, deletedAt: null }, include: { billingProfile: true, billingEntitlement: true } });
    if (!creator) throw billingError("Creator not found", "BILLING_CREATOR_NOT_FOUND", 404);
    if (creator.billingProfile?.billingExcluded === true) throw billingError("Creator is excluded from billing", "BILLING_CREATOR_EXCLUDED");
    const entitlement = creator.billingEntitlement || null;
    if (entitlement && isFuture(entitlement.coreValidUntil, now)) {
      const entitlementTestMode = entitlement.walletTestMode;
      if (entitlementTestMode !== null && entitlementTestMode !== undefined && (entitlementTestMode === true) !== (testMode === true)) {
        throw billingError("This active subscription belongs to a different billing environment", "BILLING_WALLET_ENVIRONMENT_MISMATCH", 409);
      }
      const resolvedTestMode = entitlementTestMode === null || entitlementTestMode === undefined ? testMode === true : entitlementTestMode === true;
      const billingAnchorDay = normalizedAnchorDay(
        entitlement.billingAnchorDay,
        entitlement.currentPeriodStartedAt || entitlement.coreValidFrom || entitlement.subscriptionStartedAt || entitlement.coreValidUntil,
      );
      await assertWalletDebitAllowed(tx, agencyId, resolvedTestMode);
      const updated = await tx.creatorBillingEntitlement.update({
        where: { creatorId },
        data: {
          autoRenewEnabled: true,
          nextRenewalAt: entitlement.coreValidUntil,
          lastRenewalErrorCode: null,
          walletTestMode: resolvedTestMode,
          ...(billingAnchorDay ? { billingAnchorDay } : {}),
        },
      });
      return { alreadyActive: true, entitlement: updated, wallet: await ensureWallet(tx, agencyId, resolvedTestMode), period: null, pricing: null, transaction: null };
    }
    return { alreadyActive: false, ...(await chargeMonthlyPeriod(tx, { agencyId, creator, entitlement, testMode, now, reason: "start" })) };
  });
  await audit({ agencyId, actorUserId, action: "billing.creator_subscription_started", targetType: "creator", targetId: creatorId, metadata: { alreadyActive: result.alreadyActive === true, periodId: result.period?.id || null, amountCents: result.pricing?.totalCents || 0, testMode: testMode === true }, db: client }).catch(() => undefined);
  return result;
}

async function cancelCreatorRenewal({ agencyId, creatorId, actorUserId = null, db = null }) {
  const client = db || prisma;
  const result = await client.$transaction(async (tx) => {
    await lockAgencyBillingMutation(tx, agencyId);
    const creator = await tx.creatorAccount.findFirst({ where: { id: creatorId, agencyId, deletedAt: null }, include: { billingEntitlement: true } });
    if (!creator) throw billingError("Creator not found", "BILLING_CREATOR_NOT_FOUND", 404);
    if (!creator.billingEntitlement) return { changed: false, entitlement: null };
    const entitlement = await tx.creatorBillingEntitlement.update({ where: { creatorId }, data: { autoRenewEnabled: false, nextRenewalAt: null, lastRenewalErrorCode: null } });
    return { changed: true, entitlement };
  });
  await audit({ agencyId, actorUserId, action: "billing.creator_auto_renew_cancelled", targetType: "creator", targetId: creatorId, metadata: {}, db: client }).catch(() => undefined);
  return result;
}

function renewalStartAt(entitlement, now = new Date()) {
  const previousEnd = asDate(entitlement?.coreValidUntil || entitlement?.currentPeriodEndsAt);
  if (!previousEnd) return now;
  const latenessMs = now.getTime() - previousEnd.getTime();
  const hadBillingFailure = ["BILLING_WALLET_INSUFFICIENT_BALANCE", "BILLING_EARNINGS_30D_UNAVAILABLE"].includes(String(entitlement?.lastRenewalErrorCode || ""));
  // Keep the calendar boundary stable for a normal hourly scheduler delay, but
  // never back-bill a customer for a material period in which access had already
  // expired because balance/earnings were unavailable.
  if (!hadBillingFailure && latenessMs >= 0 && latenessMs <= 2 * 60 * 60 * 1000) return previousEnd;
  return now;
}

async function renewCreatorSubscription({ entitlement, db = null, now = new Date() }) {
  const client = db || prisma;
  const agencyId = String(entitlement?.agencyId || "");
  const creatorId = String(entitlement?.creatorId || "");
  if (!agencyId || !creatorId || entitlement?.autoRenewEnabled !== true) return { renewed: false, reason: "AUTO_RENEW_DISABLED" };
  if (isFuture(entitlement.coreValidUntil, now)) return { renewed: false, reason: "NOT_DUE" };
  const providerSandbox = String(process.env.NOWPAYMENTS_MODE || "").toLowerCase() === "sandbox";
  if (entitlement.walletTestMode !== null && entitlement.walletTestMode !== undefined && (entitlement.walletTestMode === true) !== providerSandbox) {
    return { renewed: false, reason: "BILLING_WALLET_ENVIRONMENT_MISMATCH" };
  }

  try {
    const result = await client.$transaction(async (tx) => {
      await lockAgencyBillingMutation(tx, agencyId);
      const freshEntitlement = await tx.creatorBillingEntitlement.findUnique({ where: { creatorId } });
      if (!freshEntitlement?.autoRenewEnabled) return { renewed: false, reason: "AUTO_RENEW_DISABLED" };
      if (isFuture(freshEntitlement.coreValidUntil, now)) return { renewed: false, reason: "NOT_DUE" };
      const creator = await tx.creatorAccount.findFirst({ where: { id: creatorId, agencyId, deletedAt: null }, include: { billingProfile: true, billingEntitlement: true } });
      if (!creator || creator.billingProfile?.billingExcluded === true) {
        await tx.creatorBillingEntitlement.update({ where: { creatorId }, data: { autoRenewEnabled: false, nextRenewalAt: null, lastRenewalAttemptAt: now, lastRenewalErrorCode: "CREATOR_UNAVAILABLE" } }).catch(() => undefined);
        return { renewed: false, reason: "CREATOR_UNAVAILABLE" };
      }
      const startAt = renewalStartAt(freshEntitlement, now);
      return { renewed: true, ...(await chargeMonthlyPeriod(tx, { agencyId, creator, entitlement: freshEntitlement, testMode: freshEntitlement.walletTestMode === true, now, startAt, reason: "renew" })) };
    });
    return result;
  } catch (err) {
    if (err?.code === "BILLING_WALLET_INSUFFICIENT_BALANCE" || err?.code === "BILLING_EARNINGS_30D_UNAVAILABLE") {
      await client.creatorBillingEntitlement.updateMany({
        where: { creatorId, agencyId, autoRenewEnabled: true, coreValidUntil: { lte: now } },
        data: { lastRenewalAttemptAt: now, lastRenewalErrorCode: err.code, nextRenewalAt: now },
      }).catch(() => undefined);
      return { renewed: false, reason: err.code, balanceCents: err.balanceCents ?? null, requiredCents: err.requiredCents ?? null };
    }
    if (err?.code === "BILLING_FREE_INTERNAL_LIVE_DEBIT_DISABLED" || err?.code === "BILLING_LIVE_AUTO_PRICING_DISABLED") {
      await client.creatorBillingEntitlement.updateMany({
        where: { creatorId, agencyId, autoRenewEnabled: true, coreValidUntil: { lte: now }, walletTestMode: false },
        data: { autoRenewEnabled: false, nextRenewalAt: null, lastRenewalAttemptAt: now, lastRenewalErrorCode: err.code },
      }).catch(() => undefined);
      return { renewed: false, reason: err.code };
    }
    throw err;
  }
}

async function renewDueCreatorSubscriptions({ now = new Date(), db = null, limit = 1000, agencyId = null } = {}) {
  const client = db || prisma;
  if (client.creatorBillingPeriod?.updateMany) {
    await client.creatorBillingPeriod.updateMany({
      where: { status: "ACTIVE", endsAt: { lte: now }, ...(agencyId ? { agencyId: String(agencyId) } : {}) },
      data: { status: "COMPLETED" },
    });
  }
  const due = await client.creatorBillingEntitlement.findMany({
    where: {
      ...(agencyId ? { agencyId: String(agencyId) } : {}),
      autoRenewEnabled: true,
      coreValidUntil: { lte: now },
      creator: { deletedAt: null },
    },
    orderBy: [{ coreValidUntil: "asc" }, { creatorId: "asc" }],
    take: Math.max(1, Math.min(10_000, Number(limit || 1000))),
  });
  let renewed = 0;
  let insufficientBalance = 0;
  let earningsUnavailable = 0;
  let skipped = 0;
  for (const entitlement of due) {
    const result = await renewCreatorSubscription({ entitlement, db: client, now });
    if (result.renewed) renewed += 1;
    else if (result.reason === "BILLING_WALLET_INSUFFICIENT_BALANCE") insufficientBalance += 1;
    else if (result.reason === "BILLING_EARNINGS_30D_UNAVAILABLE") earningsUnavailable += 1;
    else skipped += 1;
  }
  return { scanned: due.length, renewed, insufficientBalance, earningsUnavailable, skipped };
}

async function getWalletState({ agencyId, testMode = false, db = null, limit = 30 }) {
  const client = db || prisma;
  const [wallet, transactions] = await Promise.all([
    client.agencyBillingWallet.findUnique({ where: walletUniqueWhere(agencyId, testMode) }),
    client.billingWalletTransaction.findMany({ where: { agencyId, testMode: testMode === true }, orderBy: { createdAt: "desc" }, take: Math.max(1, Math.min(100, Number(limit || 30))) }),
  ]);
  return {
    wallet: publicWallet(wallet || { id: null, testMode, balanceCents: 0n, currency: "USD", updatedAt: null }),
    transactions: transactions.map(publicWalletTransaction),
  };
}

module.exports = {
  DEFAULT_MAX_EARNINGS_AGE_HOURS,
  liveAutoPricingEnabled,
  readRolling30dRevenue,
  readRolling30dRevenueBatch,
  pricingFromRevenue,
  pricingPreviewFromRevenue,
  pricingPreviewFromSnapshot,
  quoteCreatorMonthlyPrice,
  publicWallet,
  publicWalletTransaction,
  publicBillingPeriod,
  getWalletState,
  creditPaidTopUp,
  refundTopUp,
  setCreatorBillingPreferences,
  startCreatorSubscription,
  cancelCreatorRenewal,
  renewalStartAt,
  renewCreatorSubscription,
  renewDueCreatorSubscriptions,
};

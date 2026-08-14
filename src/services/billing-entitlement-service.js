"use strict";

const prisma = require("../prisma");

function asDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function maxDate(a, b) {
  const da = asDate(a);
  const db = asDate(b);
  if (!da) return db;
  if (!db) return da;
  return da > db ? da : db;
}

function addMonthsUtc(date, months) {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + Number(months || 1));
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

function isFuture(value, now = new Date()) {
  const date = asDate(value);
  return !!date && date > now;
}

function publicEntitlement(row, now = new Date()) {
  if (!row) {
    return {
      tier: null,
      coreSource: null,
      corePriceCents: 0,
      coreValidFrom: null,
      coreValidUntil: null,
      aiChatterSource: null,
      aiChatterPriceCents: 0,
      aiChatterValidUntil: null,
      outreachSource: null,
      outreachPriceCents: 0,
      outreachValidUntil: null,
      coreActive: false,
      aiChatterActive: false,
      outreachActive: false,
      expired: true,
      subscriptionStartedAt: null,
      currentPeriodStartedAt: null,
      currentPeriodEndsAt: null,
      nextRenewalAt: null,
      tierAtPeriodStart: null,
      amountChargedForPeriodCents: 0,
      autoRenewEnabled: false,
      lastRenewalAttemptAt: null,
      lastRenewalErrorCode: null,
      lastRevenue30dCents: null,
      lastRevenueCapturedAt: null,
      walletTestMode: null,
    };
  }
  return {
    tier: row.tier ? String(row.tier) : null,
    coreSource: row.coreSource ? String(row.coreSource) : null,
    corePriceCents: Math.max(0, Number(row.corePriceCents || 0)),
    coreValidFrom: row.coreValidFrom ? asDate(row.coreValidFrom)?.toISOString() || null : null,
    coreValidUntil: row.coreValidUntil ? asDate(row.coreValidUntil)?.toISOString() || null : null,
    aiChatterSource: row.aiChatterSource ? String(row.aiChatterSource) : null,
    aiChatterPriceCents: Math.max(0, Number(row.aiChatterPriceCents || 0)),
    aiChatterValidUntil: row.aiChatterValidUntil ? asDate(row.aiChatterValidUntil)?.toISOString() || null : null,
    outreachSource: row.outreachSource ? String(row.outreachSource) : null,
    outreachPriceCents: Math.max(0, Number(row.outreachPriceCents || 0)),
    outreachValidUntil: row.outreachValidUntil ? asDate(row.outreachValidUntil)?.toISOString() || null : null,
    coreActive: isFuture(row.coreValidUntil, now),
    aiChatterActive: isFuture(row.aiChatterValidUntil, now),
    outreachActive: isFuture(row.outreachValidUntil, now),
    expired: !isFuture(row.coreValidUntil, now),
    subscriptionStartedAt: row.subscriptionStartedAt ? asDate(row.subscriptionStartedAt)?.toISOString() || null : (row.coreValidFrom ? asDate(row.coreValidFrom)?.toISOString() || null : null),
    currentPeriodStartedAt: row.currentPeriodStartedAt ? asDate(row.currentPeriodStartedAt)?.toISOString() || null : null,
    currentPeriodEndsAt: row.currentPeriodEndsAt ? asDate(row.currentPeriodEndsAt)?.toISOString() || null : (row.coreValidUntil ? asDate(row.coreValidUntil)?.toISOString() || null : null),
    nextRenewalAt: row.nextRenewalAt ? asDate(row.nextRenewalAt)?.toISOString() || null : null,
    tierAtPeriodStart: row.tierAtPeriodStart ? String(row.tierAtPeriodStart) : (row.tier ? String(row.tier) : null),
    amountChargedForPeriodCents: Math.max(0, Number(row.amountChargedForPeriodCents || 0)),
    autoRenewEnabled: row.autoRenewEnabled === true,
    lastRenewalAttemptAt: row.lastRenewalAttemptAt ? asDate(row.lastRenewalAttemptAt)?.toISOString() || null : null,
    lastRenewalErrorCode: row.lastRenewalErrorCode || null,
    lastRevenue30dCents: row.lastRevenue30dCents == null ? null : Math.max(0, Number(row.lastRevenue30dCents || 0)),
    lastRevenueCapturedAt: row.lastRevenueCapturedAt ? asDate(row.lastRevenueCapturedAt)?.toISOString() || null : null,
    walletTestMode: row.walletTestMode == null ? null : row.walletTestMode === true,
  };
}

function legacyLineFromSnapshot(order, raw) {
  if (!raw || typeof raw !== "object") return null;
  const creatorId = String(raw.creatorId || "").trim();
  if (!creatorId) return null;
  const core = Math.max(0, Number(raw.corePriceCents || 0));
  const aiEnabled = raw.aiChatterEnabled === true;
  const outreachEnabled = raw.outreachEnabled === true;
  const ai = aiEnabled ? Math.max(0, Number(raw.aiChatterPriceCents || 0)) : 0;
  const outreach = outreachEnabled ? Math.max(0, Number(raw.outreachPriceCents || 0)) : 0;
  const monthly = Math.max(0, Number(raw.monthlyCents ?? raw.lineTotalCents ?? (core + ai + outreach)));
  const months = Math.max(1, Number(order.periodMonths || 1));
  return {
    orderId: order.id,
    agencyId: order.agencyId,
    creatorId,
    creatorName: String(raw.creatorName || raw.creatorUsername || creatorId).slice(0, 180),
    creatorUsername: raw.creatorUsername ? String(raw.creatorUsername).slice(0, 180) : null,
    tier: ["STARTER", "GROWTH", "PRO", "ELITE", "CUSTOM"].includes(String(raw.tier || "").toUpperCase()) ? String(raw.tier).toUpperCase() : "STARTER",
    corePriceCents: Math.round(core),
    aiChatterEnabled: aiEnabled,
    aiChatterPriceCents: Math.round(ai),
    outreachEnabled,
    outreachPriceCents: Math.round(outreach),
    monthlyCents: Math.round(monthly),
    periodMonths: months,
    lineTotalCents: Math.round(monthly * months),
  };
}

async function ensureOrderLines(tx, order) {
  let lines = await tx.billingOrderLine.findMany({ where: { orderId: order.id }, orderBy: { createdAt: "asc" } });
  if (lines.length) return lines;

  const rawLines = Array.isArray(order?.pricingSnapshot?.lines) ? order.pricingSnapshot.lines : [];
  const fallback = rawLines.map((row) => legacyLineFromSnapshot(order, row)).filter(Boolean);
  if (!fallback.length) {
    const err = new Error("Paid billing order has no creator lines to activate");
    err.code = "BILLING_ORDER_LINES_MISSING";
    err.status = 409;
    err.permanent = true;
    throw err;
  }

  for (const data of fallback) {
    try { await tx.billingOrderLine.create({ data }); }
    catch (err) { if (err?.code !== "P2002") throw err; }
  }
  lines = await tx.billingOrderLine.findMany({ where: { orderId: order.id }, orderBy: { createdAt: "asc" } });
  return lines;
}

async function lockAgencyBillingMutation(tx, agencyId) {
  const id = String(agencyId || "").trim();
  if (!id || typeof tx?.$queryRawUnsafe !== "function") return;
  // Billing entitlement mutations for one agency must serialize. Different
  // creator payments can otherwise compute against different uncommitted
  // entitlement sets and race the shared Agency/AgencySubscription aggregate.
  // Locking the Agency row is transaction-scoped in PostgreSQL and does not
  // modify the row or its updatedAt timestamp.
  await tx.$queryRawUnsafe('SELECT "id" FROM "Agency" WHERE "id" = $1 FOR UPDATE', id);
}

async function activeEntitlementEnd(tx, agencyId, now = new Date()) {
  const row = await tx.creatorBillingEntitlement.findFirst({
    where: {
      agencyId,
      coreValidUntil: { gt: now },
      // Soft-deleted creators are not billable product access. Keep financial
      // history, but never let a hidden/deleted creator keep the workspace
      // aggregate ACTIVE.
      creator: { deletedAt: null },
    },
    orderBy: { coreValidUntil: "desc" },
  });
  return asDate(row?.coreValidUntil);
}

async function previousUnrefundedGrant(tx, line, component) {
  const where = {
    creatorId: line.creatorId,
    orderId: { not: line.orderId },
    activatedAt: { not: null },
    refundedAt: null,
    order: { status: "PAID", activatedAt: { not: null } },
  };
  if (component === "core") where.coreGrantedUntil = { not: null };
  if (component === "ai") {
    where.aiChatterEnabled = true;
    where.aiGrantedUntil = { not: null };
  }
  if (component === "outreach") {
    where.outreachEnabled = true;
    where.outreachGrantedUntil = { not: null };
  }
  return tx.billingOrderLine.findFirst({
    where,
    orderBy: [{ activatedAt: "desc" }, { createdAt: "desc" }],
    include: { order: { select: { id: true, status: true, paidAt: true, activatedAt: true, testMode: true } } },
  });
}

function fallbackComponentState({ previousSource, previousPriceCents, previousValidUntil }) {
  // A PAYMENT snapshot is only a hint about what used to be underneath this
  // line. If that payment has since been refunded, restoring the frozen
  // snapshot would resurrect refunded access. Payment predecessors therefore
  // come only from live, non-refunded relational order lines.
  if (previousSource && previousSource !== "PAYMENT") {
    return {
      source: previousSource,
      priceCents: Math.max(0, Number(previousPriceCents || 0)),
      validUntil: previousValidUntil || null,
      lastOrderId: null,
    };
  }
  return { source: "LEGACY", priceCents: 0, validUntil: null, lastOrderId: null };
}

async function activatePaidOrderEntitlements({ orderId, sandboxActivationEnabled, db = null }) {
  const client = db || prisma;
  return client.$transaction(async (tx) => {
    // Read only enough to choose the agency lock, then re-read authoritative
    // order state after acquiring it. Provider callbacks can move PAID ->
    // REFUNDED concurrently; never activate from a stale pre-lock snapshot.
    const identity = await tx.billingOrder.findUnique({ where: { id: orderId }, select: { id: true, agencyId: true } });
    if (!identity) return { activated: false, reason: "ORDER_NOT_PAID" };
    await lockAgencyBillingMutation(tx, identity.agencyId);

    const order = await tx.billingOrder.findUnique({ where: { id: orderId } });
    if (!order || order.status !== "PAID") return { activated: false, reason: "ORDER_NOT_PAID" };
    if (order.activatedAt) return { activated: false, reason: "ALREADY_ACTIVATED" };
    if (order.testMode && sandboxActivationEnabled !== true) return { activated: false, reason: "SANDBOX_ACTIVATION_DISABLED" };

    const lines = await ensureOrderLines(tx, order);
    const now = new Date();
    const claim = await tx.billingOrder.updateMany({
      where: { id: orderId, status: "PAID", activatedAt: null },
      data: { activatedAt: now, paidAt: order.paidAt || now },
    });
    if (claim.count !== 1) return { activated: false, reason: "ALREADY_ACTIVATED" };

    const grants = [];
    for (const line of lines) {
      const existing = await tx.creatorBillingEntitlement.findUnique({ where: { creatorId: line.creatorId } });
      if (existing && String(existing.agencyId) !== String(order.agencyId)) {
        const err = new Error("Creator entitlement belongs to another agency");
        err.code = "BILLING_ENTITLEMENT_AGENCY_MISMATCH";
        err.status = 409;
        err.permanent = true;
        throw err;
      }

      const previousCoreSource = existing?.coreSource || null;
      const previousCorePrice = Math.max(0, Number(existing?.corePriceCents || 0));
      const previousCore = asDate(existing?.coreValidUntil);
      const coreBase = maxDate(previousCore && previousCore > now ? previousCore : null, now);
      const coreGrantedUntil = addMonthsUtc(coreBase, line.periodMonths || order.periodMonths || 1);

      const previousAiSource = existing?.aiChatterSource || null;
      const previousAiPrice = Math.max(0, Number(existing?.aiChatterPriceCents || 0));
      const previousAi = asDate(existing?.aiChatterValidUntil);
      const aiBase = line.aiChatterEnabled ? maxDate(previousAi && previousAi > now ? previousAi : null, now) : null;
      const aiGrantedUntil = aiBase ? addMonthsUtc(aiBase, line.periodMonths || order.periodMonths || 1) : null;

      const previousOutreachSource = existing?.outreachSource || null;
      const previousOutreachPrice = Math.max(0, Number(existing?.outreachPriceCents || 0));
      const previousOutreach = asDate(existing?.outreachValidUntil);
      const outreachBase = line.outreachEnabled ? maxDate(previousOutreach && previousOutreach > now ? previousOutreach : null, now) : null;
      const outreachGrantedUntil = outreachBase ? addMonthsUtc(outreachBase, line.periodMonths || order.periodMonths || 1) : null;

      const entitlementData = {
        agencyId: order.agencyId,
        creatorId: line.creatorId,
        tier: line.tier,
        coreSource: "PAYMENT",
        corePriceCents: line.corePriceCents,
        coreValidFrom: existing && isFuture(existing.coreValidUntil, now) ? (existing.coreValidFrom || now) : now,
        coreValidUntil: coreGrantedUntil,
        coreLastOrderId: order.id,
        lastPaidAt: order.paidAt || now,
        subscriptionStartedAt: existing?.subscriptionStartedAt || existing?.coreValidFrom || now,
        currentPeriodStartedAt: coreBase,
        currentPeriodEndsAt: coreGrantedUntil,
        nextRenewalAt: null,
        tierAtPeriodStart: line.tier,
        amountChargedForPeriodCents: Math.max(0, Number(line.lineTotalCents || line.monthlyCents || 0)),
        // A V13 direct payment bought this dated period only. Do not infer
        // consent to future V14 wallet debits; Start/Resume is the opt-in.
        autoRenewEnabled: false,
        lastRenewalErrorCode: null,
        walletTestMode: order.testMode === true,
        ...(line.aiChatterEnabled ? { aiChatterSource: "PAYMENT", aiChatterPriceCents: line.aiChatterPriceCents, aiChatterValidUntil: aiGrantedUntil, aiLastOrderId: order.id } : {}),
        ...(line.outreachEnabled ? { outreachSource: "PAYMENT", outreachPriceCents: line.outreachPriceCents, outreachValidUntil: outreachGrantedUntil, outreachLastOrderId: order.id } : {}),
      };

      await tx.creatorBillingEntitlement.upsert({
        where: { creatorId: line.creatorId },
        create: entitlementData,
        update: entitlementData,
      });

      // The billing profile is configuration/defaults for the next order. Access
      // itself is decided by CreatorBillingEntitlement dates, not these booleans.
      await tx.creatorBillingProfile.upsert({
        where: { creatorId: line.creatorId },
        create: {
          agencyId: order.agencyId,
          creatorId: line.creatorId,
          tier: line.tier,
          tierMode: line.tier === "CUSTOM" ? "MANUAL" : "AUTO",
          corePriceCents: line.corePriceCents,
          aiChatterEnabled: line.aiChatterEnabled === true,
          aiChatterPriceCents: line.aiChatterPriceCents,
          outreachEnabled: line.outreachEnabled === true,
          outreachPriceCents: line.outreachPriceCents,
          billingExcluded: false,
        },
        update: {
          tier: line.tier,
          tierMode: line.tier === "CUSTOM" ? "MANUAL" : "AUTO",
          corePriceCents: line.corePriceCents,
          aiChatterEnabled: line.aiChatterEnabled === true,
          aiChatterPriceCents: line.aiChatterPriceCents,
          outreachEnabled: line.outreachEnabled === true,
          outreachPriceCents: line.outreachPriceCents,
        },
      });

      await tx.billingOrderLine.update({
        where: { id: line.id },
        data: {
          previousTier: existing?.tier || null,
          corePreviousSource: previousCoreSource,
          corePreviousPriceCents: previousCorePrice,
          corePreviousValidUntil: previousCore,
          coreGrantedUntil,
          aiPreviousSource: previousAiSource,
          aiPreviousPriceCents: previousAiPrice,
          aiPreviousValidUntil: previousAi,
          aiGrantedUntil,
          outreachPreviousSource: previousOutreachSource,
          outreachPreviousPriceCents: previousOutreachPrice,
          outreachPreviousValidUntil: previousOutreach,
          outreachGrantedUntil,
          activatedAt: now,
        },
      });

      grants.push({
        creatorId: line.creatorId,
        tier: line.tier,
        coreValidUntil: coreGrantedUntil.toISOString(),
        aiChatterValidUntil: aiGrantedUntil?.toISOString() || null,
        outreachValidUntil: outreachGrantedUntil?.toISOString() || null,
      });
    }

    const subscription = await tx.agencySubscription.findFirst({ where: { agencyId: order.agencyId }, orderBy: { createdAt: "desc" } });
    const maxEnd = await activeEntitlementEnd(tx, order.agencyId, now) || now;
    const data = {
      status: "ACTIVE",
      billingMode: order.testMode ? String(subscription?.billingMode || "FREE_INTERNAL") : "CRYPTO",
      billingPeriod: order.billingPeriod,
      currentPeriodStart: subscription?.status === "ACTIVE" && subscription?.currentPeriodStart ? subscription.currentPeriodStart : now,
      currentPeriodEnd: maxEnd,
      graceUntil: null,
    };
    if (subscription) await tx.agencySubscription.update({ where: { id: subscription.id }, data });
    else await tx.agencySubscription.create({ data: { agencyId: order.agencyId, ...data } });
    await tx.agency.update({ where: { id: order.agencyId }, data: { status: "ACTIVE", currentPeriodEnd: maxEnd } });

    return { activated: true, currentPeriodEnd: maxEnd, grants };
  });
}

async function refundOrderEntitlements({ order, db = null }) {
  const orderId = String(order?.id || "").trim();
  const agencyId = String(order?.agencyId || "").trim();
  if (!orderId || !agencyId) return { downgraded: false, reason: "ORDER_NOT_FOUND" };
  const client = db || prisma;
  return client.$transaction(async (tx) => {
    // The order object passed by provider processing may predate a concurrent
    // activation. Serialize with activation and re-read after the lock so a
    // REFUNDED event can never miss an activation that just committed.
    await lockAgencyBillingMutation(tx, agencyId);
    const currentOrder = await tx.billingOrder.findUnique({ where: { id: orderId } });
    if (!currentOrder || currentOrder.status !== "REFUNDED") return { downgraded: false, reason: "ORDER_NOT_REFUNDED" };
    if (!currentOrder.activatedAt) return { downgraded: false, reason: "ORDER_NOT_ACTIVATED" };

    const lines = await tx.billingOrderLine.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
    const now = new Date();
    let changed = 0;

    for (const line of lines) {
      if (!line.activatedAt || line.refundedAt) continue;
      const ent = await tx.creatorBillingEntitlement.findUnique({ where: { creatorId: line.creatorId } });
      if (!ent) {
        await tx.billingOrderLine.update({ where: { id: line.id }, data: { refundedAt: now } });
        continue;
      }

      const data = {};

      if (String(ent.coreLastOrderId || "") === orderId) {
        const previous = await previousUnrefundedGrant(tx, line, "core");
        const state = previous
          ? { source: "PAYMENT", priceCents: previous.corePriceCents, validUntil: previous.coreGrantedUntil, lastOrderId: previous.orderId }
          : fallbackComponentState({ previousSource: line.corePreviousSource, previousPriceCents: line.corePreviousPriceCents, previousValidUntil: line.corePreviousValidUntil });
        data.coreSource = state.source;
        data.corePriceCents = state.priceCents;
        data.coreValidUntil = state.validUntil;
        data.coreLastOrderId = state.lastOrderId;
        data.lastPaidAt = previous?.order?.paidAt || null;
        data.currentPeriodEndsAt = state.validUntil;
        if (previous) {
          const restoredStart = previous.activatedAt || previous.order?.activatedAt || null;
          data.nextRenewalAt = null;
          data.currentPeriodStartedAt = restoredStart;
          // Restoring a dated V13 PAYMENT predecessor is not wallet consent.
          data.autoRenewEnabled = false;
          data.walletTestMode = previous.order?.testMode === true;
          data.billingAnchorDay = restoredStart ? asDate(restoredStart)?.getUTCDate() || null : (state.validUntil ? asDate(state.validUntil)?.getUTCDate() || null : null);
          if (previous.tier) data.tierAtPeriodStart = previous.tier;
          data.amountChargedForPeriodCents = Math.max(0, Number(previous.lineTotalCents || previous.monthlyCents || 0));
        } else {
          // Restored ADMIN/LEGACY access is not a customer-paid renewal. Never
          // let metadata from the refunded payment turn it into wallet authority.
          data.nextRenewalAt = null;
          data.currentPeriodStartedAt = null;
          data.autoRenewEnabled = false;
          data.walletTestMode = null;
          data.billingAnchorDay = state.validUntil ? asDate(state.validUntil)?.getUTCDate() || null : null;
          data.amountChargedForPeriodCents = 0;
        }

        // A later admin tier edit is independent of payment validity. Only
        // restore the payment predecessor tier when nobody changed tier after
        // this order became the current grant.
        if (String(ent.tier || "") === String(line.tier || "")) {
          if (previous?.tier) data.tier = previous.tier;
          else if (line.corePreviousSource && line.corePreviousSource !== "PAYMENT" && line.previousTier) data.tier = line.previousTier;
        }
      }

      if (String(ent.aiLastOrderId || "") === orderId) {
        const previous = await previousUnrefundedGrant(tx, line, "ai");
        const state = previous
          ? { source: "PAYMENT", priceCents: previous.aiChatterPriceCents, validUntil: previous.aiGrantedUntil, lastOrderId: previous.orderId }
          : fallbackComponentState({ previousSource: line.aiPreviousSource, previousPriceCents: line.aiPreviousPriceCents, previousValidUntil: line.aiPreviousValidUntil });
        data.aiChatterSource = state.source;
        data.aiChatterPriceCents = state.priceCents;
        data.aiChatterValidUntil = state.validUntil;
        data.aiLastOrderId = state.lastOrderId;
      }

      if (String(ent.outreachLastOrderId || "") === orderId) {
        const previous = await previousUnrefundedGrant(tx, line, "outreach");
        const state = previous
          ? { source: "PAYMENT", priceCents: previous.outreachPriceCents, validUntil: previous.outreachGrantedUntil, lastOrderId: previous.orderId }
          : fallbackComponentState({ previousSource: line.outreachPreviousSource, previousPriceCents: line.outreachPreviousPriceCents, previousValidUntil: line.outreachPreviousValidUntil });
        data.outreachSource = state.source;
        data.outreachPriceCents = state.priceCents;
        data.outreachValidUntil = state.validUntil;
        data.outreachLastOrderId = state.lastOrderId;
      }

      if (Object.keys(data).length) {
        await tx.creatorBillingEntitlement.update({ where: { creatorId: line.creatorId }, data });
        changed += 1;
      }
      await tx.billingOrderLine.update({ where: { id: line.id }, data: { refundedAt: now } });
    }

    const subscription = await tx.agencySubscription.findFirst({ where: { agencyId }, orderBy: { createdAt: "desc" } });
    const maxEnd = await activeEntitlementEnd(tx, agencyId, now);
    if (subscription) {
      if (subscription.billingMode === "FREE_INTERNAL") {
        await tx.agencySubscription.update({ where: { id: subscription.id }, data: { currentPeriodEnd: maxEnd || subscription.currentPeriodEnd } });
      } else if (maxEnd) {
        await tx.agencySubscription.update({ where: { id: subscription.id }, data: { status: "ACTIVE", currentPeriodEnd: maxEnd } });
        await tx.agency.update({ where: { id: agencyId }, data: { status: "ACTIVE", currentPeriodEnd: maxEnd } });
      } else {
        await tx.agencySubscription.update({ where: { id: subscription.id }, data: { status: "PAST_DUE", currentPeriodEnd: null } });
        await tx.agency.update({ where: { id: agencyId }, data: { status: "PAST_DUE", currentPeriodEnd: null } });
      }
    }
    return { downgraded: !maxEnd && subscription?.billingMode !== "FREE_INTERNAL", changed, currentPeriodEnd: maxEnd };
  });
}

async function syncAgencyBillingAggregate(tx, agencyId, now = new Date()) {
  await lockAgencyBillingMutation(tx, agencyId);
  const subscription = await tx.agencySubscription.findFirst({
    where: { agencyId },
    orderBy: { createdAt: "desc" },
  });
  const maxEnd = await activeEntitlementEnd(tx, agencyId, now);

  if (!subscription) {
    if (!maxEnd) return { status: null, currentPeriodEnd: null, billingMode: null };
    const created = await tx.agencySubscription.create({
      data: {
        agencyId,
        status: "ACTIVE",
        billingMode: "MANUAL",
        billingPeriod: "MONTHLY",
        currentPeriodStart: now,
        currentPeriodEnd: maxEnd,
      },
    });
    await tx.agency.update({ where: { id: agencyId }, data: { status: "ACTIVE", currentPeriodEnd: maxEnd } });
    return { status: "ACTIVE", currentPeriodEnd: maxEnd, billingMode: created.billingMode };
  }

  if (subscription.billingMode === "FREE_INTERNAL") {
    return { status: subscription.status, currentPeriodEnd: maxEnd || subscription.currentPeriodEnd || null, billingMode: subscription.billingMode };
  }

  if (maxEnd) {
    await tx.agencySubscription.update({
      where: { id: subscription.id },
      data: { status: "ACTIVE", currentPeriodEnd: maxEnd, graceUntil: null },
    });
    await tx.agency.update({ where: { id: agencyId }, data: { status: "ACTIVE", currentPeriodEnd: maxEnd } });
    return { status: "ACTIVE", currentPeriodEnd: maxEnd, billingMode: subscription.billingMode };
  }

  if (["ACTIVE", "GRACE", "PAST_DUE"].includes(String(subscription.status))) {
    await tx.agencySubscription.update({ where: { id: subscription.id }, data: { status: "PAST_DUE", currentPeriodEnd: null } });
    await tx.agency.update({ where: { id: agencyId }, data: { status: "PAST_DUE", currentPeriodEnd: null } });
    return { status: "PAST_DUE", currentPeriodEnd: null, billingMode: subscription.billingMode };
  }

  return { status: subscription.status, currentPeriodEnd: subscription.currentPeriodEnd || null, billingMode: subscription.billingMode };
}

async function reconcileExpiredBillingStates({ now = new Date(), db = null } = {}) {
  const client = db || prisma;
  // Reconcile every paid ACTIVE/GRACE aggregate, not only aggregates whose
  // cached currentPeriodEnd is already due. A creator can be soft-deleted or
  // a payment can be refunded before that cached date, so the aggregate must
  // be derived from live creator entitlements rather than trusted as a timer.
  const subscriptions = await client.agencySubscription.findMany({
    where: {
      status: { in: ["ACTIVE", "GRACE"] },
      billingMode: { not: "FREE_INTERNAL" },
    },
    orderBy: { createdAt: "asc" },
    take: 10000,
  });
  let expired = 0;
  let repaired = 0;
  for (const subscription of subscriptions) {
    await client.$transaction(async (tx) => {
      const beforeEnd = asDate(subscription.currentPeriodEnd);
      const result = await syncAgencyBillingAggregate(tx, subscription.agencyId, now);
      const afterEnd = asDate(result.currentPeriodEnd);
      const changed =
        String(result.status || "") !== String(subscription.status || "") ||
        Number(beforeEnd?.getTime?.() || 0) !== Number(afterEnd?.getTime?.() || 0);
      if (!changed) return;
      if (result.status === "PAST_DUE") expired += 1;
      else repaired += 1;
    });
  }
  return { scanned: subscriptions.length, expired, repaired };
}

module.exports = {
  addMonthsUtc,
  isFuture,
  publicEntitlement,
  lockAgencyBillingMutation,
  ensureOrderLines,
  activatePaidOrderEntitlements,
  refundOrderEntitlements,
  syncAgencyBillingAggregate,
  reconcileExpiredBillingStates,
};

"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { rebuildCreatorDailyMetrics } = require("./creator-analytics-projection-service");

const JOB_KEY = "financial_transactions_scan";
const COLLECTOR_VERSION = "payout-transactions-v2-catchup";
const SCHEMA_VERSION = 1;
const KNOWN_SALE_TYPES = new Map([
  ["message", "MESSAGE"],
  ["post", "POST"],
  ["stream", "STREAM"],
]);
const TIP_TYPES = new Set(["tip", "tips"]);

const REFUND_TRANSACTION_STATUSES = new Set(["undo"]);
const PAYOUT_PENDING_TRANSACTION_STATUSES = new Set(["loading"]);

function normalizedStatus(value) {
  return String(value || "").trim().toLowerCase();
}
function summarizeStatusGroups(groups = []) {
  const statusSummary = [];
  let refundTransactionsCount = 0, refundGrossCents = 0, refundNetCents = 0, refundFeeCents = 0;
  let pendingTransactionsCount = 0, pendingGrossCents = 0, pendingNetCents = 0, pendingFeeCents = 0;
  let settledTransactionsCount = 0, settledGrossCents = 0, settledNetCents = 0, settledFeeCents = 0;
  for (const group of groups || []) {
    const status = normalizedStatus(group.transactionStatus);
    const count = Number(group?._count?._all || 0);
    const grossCents = Number(group?._sum?.amountCents || 0);
    const netCents = Number(group?._sum?.netCents || 0);
    const feeCents = Number(group?._sum?.feeCents || 0);
    statusSummary.push({ status: status || null, count, grossCents, netCents, feeCents });
    if (status === "done") {
      settledTransactionsCount += count; settledGrossCents += grossCents; settledNetCents += netCents; settledFeeCents += feeCents;
    }
    if (PAYOUT_PENDING_TRANSACTION_STATUSES.has(status)) {
      pendingTransactionsCount += count; pendingGrossCents += grossCents; pendingNetCents += netCents; pendingFeeCents += feeCents;
    }
    if (REFUND_TRANSACTION_STATUSES.has(status)) {
      refundTransactionsCount += count; refundGrossCents += grossCents; refundNetCents += netCents; refundFeeCents += feeCents;
    }
  }
  return {
    statusSummary: statusSummary.sort((a, b) => b.count - a.count || String(a.status || "").localeCompare(String(b.status || ""))),
    settledTransactionsCount, settledGrossCents, settledNetCents, settledFeeCents,
    pendingTransactionsCount, pendingGrossCents, pendingNetCents, pendingFeeCents,
    refundTransactionsCount, refundGrossCents, refundNetCents, refundFeeCents,
  };
}
const CHART_CATEGORY_MAP = Object.freeze({
  total: "TOTAL",
  subscribes: "SUBSCRIPTIONS",
  messages: "MESSAGES",
  tips: "TIPS",
  post: "POSTS",
  stream: "STREAMS",
});

function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function financialMode(job) { return object(job?.params).financialMode === "catchup" ? "catchup" : "full"; }
function clean(value, max = 220) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}
function strictDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
function moneyCents(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const cents = Math.round(parsed * 100);
  return Number.isSafeInteger(cents) && Math.abs(cents) <= 2_147_483_647 ? cents : null;
}
function integer(value, fallback = 0, max = 100_000_000) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return Math.min(max, parsed);
}
function signedInteger(value, fallback = 0, max = 2_147_483_647) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || Math.abs(parsed) > max) return fallback;
  return parsed;
}
function hash(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function classification(transactionType) {
  const type = String(transactionType || "").trim().toLowerCase();
  if (KNOWN_SALE_TYPES.has(type)) return { factType: "SALE", projectionStatus: "PROJECTED", saleType: KNOWN_SALE_TYPES.get(type), reasonCode: null };
  if (TIP_TYPES.has(type)) return { factType: "TIP", projectionStatus: "PROJECTED", saleType: null, reasonCode: null };
  if (/^(subscribe|subscribes|subscription|renew|renewal|resubscribe|resubscription)/.test(type)) {
    return { factType: "PAID_SUBSCRIPTION", projectionStatus: "STORED_ONLY", saleType: null, reasonCode: "subscription_payment_type_not_proven" };
  }
  return { factType: "OTHER", projectionStatus: "STORED_ONLY", saleType: null, reasonCode: "unmapped_transaction_type" };
}

function normalizeTransaction(row, index, page) {
  const source = object(row);
  const details = object(source.descriptionDetails || source.description_details);
  const user = object(source.user);
  const externalTransactionId = clean(source.externalTransactionId ?? source.id ?? source.transactionId ?? source.transaction_id, 220);
  const transactionType = clean(source.transactionType ?? details.type ?? source.type, 120);
  const occurredAt = strictDate(source.occurredAt ?? source.createdAt ?? source.created_at ?? source.date);
  const explicitAmountCents = Number(source.amountCents);
  const amountCents = Number.isSafeInteger(explicitAmountCents) && Math.abs(explicitAmountCents) <= 2_147_483_647 ? explicitAmountCents : moneyCents(source.amount);
  const currency = (clean(source.currency, 10) || "USD").toUpperCase();
  if (!externalTransactionId) return { rejected: true, reasonCode: "transaction_id_missing", page, ordinal: index };
  if (!transactionType) return { rejected: true, reasonCode: "transaction_type_missing", page, ordinal: index, externalTransactionId };
  if (!occurredAt) return { rejected: true, reasonCode: "occurred_at_invalid", page, ordinal: index, externalTransactionId, transactionType };
  if (amountCents === null) return { rejected: true, reasonCode: "amount_invalid", page, ordinal: index, externalTransactionId, transactionType, occurredAt: occurredAt.toISOString() };
  if (!/^[A-Z]{3}$/.test(currency)) return { rejected: true, reasonCode: "currency_invalid", page, ordinal: index, externalTransactionId, transactionType, occurredAt: occurredAt.toISOString(), amountCents };
  const mapped = classification(transactionType);
  if (mapped.projectionStatus === "PROJECTED" && amountCents <= 0) {
    mapped.projectionStatus = "STORED_ONLY";
    mapped.reasonCode = "nonpositive_transaction_not_projected";
  }
  const fanOnlyFansUserId = clean(source.fanOnlyFansUserId ?? user.id ?? source.userId ?? source.user_id, 180);
  return {
    rejected: false,
    page,
    ordinal: index,
    externalTransactionId,
    transactionType: transactionType.toLowerCase(),
    factType: mapped.factType,
    projectionStatus: mapped.projectionStatus,
    saleType: mapped.saleType,
    reasonCode: mapped.reasonCode,
    fanOnlyFansUserId,
    fanUsername: clean(source.fanUsername ?? user.username, 180),
    fanDisplayName: clean(source.fanDisplayName ?? user.name ?? user.displayName, 255),
    amountCents,
    feeCents: Number.isSafeInteger(Number(source.feeCents)) && Math.abs(Number(source.feeCents)) <= 2_147_483_647 ? Number(source.feeCents) : moneyCents(source.fee),
    netCents: Number.isSafeInteger(Number(source.netCents)) && Math.abs(Number(source.netCents)) <= 2_147_483_647 ? Number(source.netCents) : moneyCents(source.net),
    taxCents: Number.isSafeInteger(Number(source.taxCents)) && Math.abs(Number(source.taxCents)) <= 2_147_483_647 ? Number(source.taxCents) : moneyCents(source.taxAmount ?? source.tax_amount),
    vatCents: Number.isSafeInteger(Number(source.vatCents)) && Math.abs(Number(source.vatCents)) <= 2_147_483_647 ? Number(source.vatCents) : moneyCents(source.vatAmount ?? source.vat_amount),
    mediaTaxCents: Number.isSafeInteger(Number(source.mediaTaxCents)) && Math.abs(Number(source.mediaTaxCents)) <= 2_147_483_647 ? Number(source.mediaTaxCents) : moneyCents(source.mediaTaxAmount ?? source.media_tax_amount),
    currency,
    occurredAt,
    transactionStatus: clean(source.transactionStatus ?? source.status, 80),
  };
}

async function resolveFan(tx, job, row, now) {
  if (!row.fanOnlyFansUserId) return null;
  const where = { creatorId_onlyFansUserId: { creatorId: job.creatorId, onlyFansUserId: row.fanOnlyFansUserId } };
  const existing = await tx.creatorFan.findUnique({ where });
  if (!existing) {
    return tx.creatorFan.create({ data: {
      id: crypto.randomUUID(), agencyId: job.agencyId, creatorId: job.creatorId,
      onlyFansUserId: row.fanOnlyFansUserId,
      username: row.fanUsername || null, displayName: row.fanDisplayName || null,
      firstSeenAt: row.occurredAt, lastSeenAt: row.occurredAt,
      createdAt: now, updatedAt: now,
    }});
  }
  const data = { lastSeenAt: existing.lastSeenAt < row.occurredAt ? row.occurredAt : existing.lastSeenAt, updatedAt: now };
  if (existing.firstSeenAt > row.occurredAt) data.firstSeenAt = row.occurredAt;
  if (row.occurredAt >= existing.lastSeenAt) {
    if (row.fanUsername) data.username = row.fanUsername;
    if (row.fanDisplayName) data.displayName = row.fanDisplayName;
  }
  return tx.creatorFan.update({ where: { id: existing.id }, data });
}

function businessData(job, deviceId, row, fanId, now) {
  return {
    agencyId: job.agencyId,
    creatorId: job.creatorId,
    fanId,
    externalTransactionId: row.externalTransactionId,
    amountCents: row.amountCents,
    feeCents: row.feeCents,
    netCents: row.netCents,
    taxCents: row.taxCents,
    vatCents: row.vatCents,
    mediaTaxCents: row.mediaTaxCents,
    transactionStatus: row.transactionStatus,
    currency: row.currency,
    source: "ONLYFANS_API",
    sourceUpdatedAt: null,
    collectedAt: now,
    sourceDeviceId: deviceId || null,
    sourceJobId: job.id,
    updatedAt: now,
  };
}

async function uniqueLegacyProjectionCandidate(tx, job, row, fanId) {
  if (!fanId || row.amountCents <= 0) return null;
  const gte = new Date(row.occurredAt.getTime() - 5_000);
  const lte = new Date(row.occurredAt.getTime() + 5_000);
  if (row.factType === "SALE") {
    const rows = await tx.creatorSale.findMany({
      where: {
        creatorId: job.creatorId,
        fanId,
        externalTransactionId: null,
        saleType: row.saleType || "OTHER",
        amountCents: row.amountCents,
        currency: row.currency,
        purchasedAt: { gte, lte },
      },
      orderBy: { purchasedAt: "asc" },
      take: 2,
    });
    return rows.length === 1 ? rows[0] : null;
  }
  if (row.factType === "TIP") {
    const rows = await tx.creatorTip.findMany({
      where: {
        creatorId: job.creatorId,
        fanId,
        externalTransactionId: null,
        amountCents: row.amountCents,
        currency: row.currency,
        tippedAt: { gte, lte },
      },
      orderBy: { tippedAt: "asc" },
      take: 2,
    });
    return rows.length === 1 ? rows[0] : null;
  }
  return null;
}

async function projectKnownFact(tx, job, deviceId, row, fanId, now) {
  const common = businessData(job, deviceId, row, fanId, now);
  if (row.factType === "SALE") {
    const update = { ...common, saleType: row.saleType || "OTHER", purchasedAt: row.occurredAt };
    const existing = await tx.creatorSale.findUnique({
      where: { creatorId_externalTransactionId: { creatorId: job.creatorId, externalTransactionId: row.externalTransactionId } },
    });
    if (existing) return tx.creatorSale.update({ where: { id: existing.id }, data: update });
    const legacy = await uniqueLegacyProjectionCandidate(tx, job, row, fanId);
    if (legacy) return tx.creatorSale.update({ where: { id: legacy.id }, data: update });
    return tx.creatorSale.create({
      data: { id: crypto.randomUUID(), createdAt: now, eventFingerprint: hash(`payout-transaction|${job.creatorId}|${row.externalTransactionId}`), externalNotificationId: null, messageId: null, postId: null, ...update },
    });
  }
  if (row.factType === "TIP") {
    const update = { ...common, tippedAt: row.occurredAt };
    const existing = await tx.creatorTip.findUnique({
      where: { creatorId_externalTransactionId: { creatorId: job.creatorId, externalTransactionId: row.externalTransactionId } },
    });
    if (existing) return tx.creatorTip.update({ where: { id: existing.id }, data: update });
    const legacy = await uniqueLegacyProjectionCandidate(tx, job, row, fanId);
    if (legacy) return tx.creatorTip.update({ where: { id: legacy.id }, data: update });
    return tx.creatorTip.create({
      data: { id: crypto.randomUUID(), createdAt: now, eventFingerprint: hash(`payout-transaction|${job.creatorId}|${row.externalTransactionId}`), externalNotificationId: null, messageId: null, ...update },
    });
  }
  return null;
}

function comparable(row) {
  return JSON.stringify([
    row.fanOnlyFansUserId, row.transactionType, row.factType, row.projectionStatus,
    row.amountCents, row.feeCents, row.netCents, row.taxCents, row.vatCents, row.mediaTaxCents,
    row.currency, row.occurredAt?.toISOString?.() || String(row.occurredAt), row.transactionStatus, row.reasonCode,
  ]);
}

async function runInTransaction(db, callback) {
  // Job progress is already applied inside prisma.$transaction() and therefore
  // passes Prisma's TransactionClient here. TransactionClient intentionally
  // does not expose $transaction, so never try to nest one. Keep standalone
  // callers atomic by opening a transaction only when the root Prisma client
  // is supplied.
  if (db && typeof db.$transaction === "function") return db.$transaction(callback);
  return callback(db);
}

async function ingestFinancialTransactionsChunk({ db = prisma, job, deviceId, chunk }) {
  if (!job?.creatorId || !job?.agencyId || !job?.id) throw new Error("Financial transaction ingest requires creator job scope");
  const scanRunId = clean(chunk?.scanRunId, 120);
  if (!scanRunId) throw new Error("Financial transaction chunk is missing scanRunId");
  const page = integer(chunk?.pageNumber, 0, 1_000_000);
  if (page < 1) throw new Error("Financial transaction chunk has invalid pageNumber");
  const rawRows = Array.isArray(chunk?.transactions) ? chunk.transactions : [];
  if (rawRows.length > 100) throw new Error("Financial transaction page exceeds 100 rows");
  const normalized = rawRows.map((row, index) => normalizeTransaction(row, index, page));
  const rejected = normalized.filter((row) => row.rejected);
  // A source page should not normally repeat a transaction id, but replayed or
  // corrected rows must never explode the creator-scoped unique key. Keep the
  // last source occurrence deterministically; the durable identity is the OF
  // transaction id, not the page ordinal.
  const acceptedByTransactionId = new Map();
  for (const row of normalized) {
    if (!row.rejected) acceptedByTransactionId.set(row.externalTransactionId, row);
  }
  const accepted = [...acceptedByTransactionId.values()];
  const now = new Date();
  let inserted = 0; let updated = 0; let unchanged = 0; let projected = 0; let storedOnly = 0;
  const affectedDates = [];

  await runInTransaction(db, async (tx) => {
    const ids = accepted.map((row) => row.externalTransactionId);
    const existingRows = ids.length ? await tx.creatorFinancialTransaction.findMany({
      where: { creatorId: job.creatorId, externalTransactionId: { in: ids } },
    }) : [];
    const existingById = new Map(existingRows.map((row) => [row.externalTransactionId, row]));

    for (const row of accepted) {
      const fan = await resolveFan(tx, job, row, now);
      const fanId = fan?.id || null;
      const commonData = {
        agencyId: job.agencyId, creatorId: job.creatorId, fanId,
        fanOnlyFansUserId: row.fanOnlyFansUserId || null,
        externalTransactionId: row.externalTransactionId,
        transactionType: row.transactionType,
        factType: row.factType,
        projectionStatus: row.projectionStatus,
        amountCents: row.amountCents, feeCents: row.feeCents, netCents: row.netCents,
        taxCents: row.taxCents, vatCents: row.vatCents, mediaTaxCents: row.mediaTaxCents,
        currency: row.currency, occurredAt: row.occurredAt, transactionStatus: row.transactionStatus,
        sourceUpdatedAt: null, collectedAt: now, sourceDeviceId: deviceId || null,
        reasonCode: row.reasonCode, updatedAt: now,
      };
      const previous = existingById.get(row.externalTransactionId);
      if (!previous) {
        const data = { ...commonData, sourceJobId: job.id, scanRunId, page: row.page, ordinal: row.ordinal };
        await tx.creatorFinancialTransaction.create({ data: { id: crypto.randomUUID(), createdAt: now, ...data } });
        inserted += 1;
      } else {
        // Catch-up re-observes the head so status changes such as done -> undo
        // are applied, but an overlap page must not steal provenance from the
        // original full scan. Full rebuilds intentionally rebind provenance.
        const data = financialMode(job) === "catchup"
          ? commonData
          : { ...commonData, sourceJobId: job.id, scanRunId, page: row.page, ordinal: row.ordinal };
        const previousComparable = comparable(previous);
        const nextComparable = comparable({ ...commonData, occurredAt: row.occurredAt });
        await tx.creatorFinancialTransaction.update({ where: { id: previous.id }, data });
        if (previousComparable === nextComparable) unchanged += 1; else updated += 1;
      }
      if (row.projectionStatus === "PROJECTED") {
        await projectKnownFact(tx, job, deviceId, row, fanId, now);
        projected += 1;
        affectedDates.push(row.occurredAt);
      } else {
        storedOnly += 1;
      }
    }
  });

  if (affectedDates.length) {
    // A sparse payout page can span more than a year on low-volume historical
    // accounts. CreatorDailyMetrics is a disposable cache, so rebuild only the
    // UTC days that actually changed instead of filling the entire min..max
    // interval and tripping the 370-day safety bound.
    const uniqueDays = [...new Set(affectedDates.map((date) => date.toISOString().slice(0, 10)))].sort();
    for (const day of uniqueDays) {
      const date = new Date(`${day}T00:00:00.000Z`);
      try {
        await rebuildCreatorDailyMetrics({ db, agencyId: job.agencyId, creatorId: job.creatorId, from: date, to: date, now });
      } catch (error) {
        console.warn("[creator-analytics] daily metrics projection failed after payout transaction ingest:", error?.message || error);
      }
    }
  }

  return {
    type: "financial_transactions_page",
    scanRunId, page,
    received: rawRows.length,
    accepted: accepted.length,
    rejected: rejected.length,
    inserted, updated, unchanged, projected, storedOnly,
    rejectedRows: rejected.slice(0, 20).map((row) => ({ ordinal: row.ordinal, reasonCode: row.reasonCode, externalTransactionId: row.externalTransactionId || null, transactionType: row.transactionType || null })),
  };
}

async function ingestFinancialChartChunk({ db = prisma, job, deviceId, chunk }) {
  const category = CHART_CATEGORY_MAP[String(chunk?.category || "").trim().toLowerCase()];
  if (!category) throw new Error("Unsupported financial chart category");
  const grossCents = signedInteger(chunk?.grossCents, Number.NaN, 2_147_483_647);
  const netCents = signedInteger(chunk?.netCents, Number.NaN, 2_147_483_647);
  const transactionsCount = integer(chunk?.transactionsCount, -1, 100_000_000);
  if (!Number.isInteger(grossCents) || !Number.isInteger(netCents) || transactionsCount < 0) throw new Error("Financial chart totals are invalid");
  const rangeFrom = strictDate(chunk?.rangeFrom);
  const rangeTo = strictDate(chunk?.rangeTo);
  const scanRunId = clean(chunk?.scanRunId, 120);
  if (!rangeFrom || !rangeTo || !scanRunId) throw new Error("Financial chart chunk is missing range metadata");
  const now = new Date();
  await db.creatorEarningsTotal.upsert({
    where: { creatorId_category: { creatorId: job.creatorId, category } },
    create: {
      id: crypto.randomUUID(), agencyId: job.agencyId, creatorId: job.creatorId, category,
      rangeFrom, rangeTo, grossCents, netCents, transactionsCount, currency: "USD",
      collectedAt: now, sourceDeviceId: deviceId || null, sourceJobId: job.id, scanRunId,
      createdAt: now, updatedAt: now,
    },
    update: {
      rangeFrom, rangeTo, grossCents, netCents, transactionsCount, currency: "USD",
      collectedAt: now, sourceDeviceId: deviceId || null, sourceJobId: job.id, scanRunId, updatedAt: now,
    },
  });
  return { type: "financial_chart_total", category, grossCents, netCents, transactionsCount };
}

async function completeFinancialTransactionsScan({ db = prisma, job, deviceId, result }) {
  const payload = object(result);
  const scanRunId = clean(payload.scanRunId, 120);
  if (!scanRunId) throw new Error("Financial transaction completion is missing scanRunId");
  const mode = payload.financialMode === "catchup" || financialMode(job) === "catchup" ? "catchup" : "full";
  const baseWhere = { creatorId: job.creatorId, sourceJobId: job.id, scanRunId };
  const [aggregate, count, statusGroups, chartTotal, storedOnly] = await Promise.all([
    db.creatorFinancialTransaction.aggregate({
      where: baseWhere,
      _sum: { amountCents: true, netCents: true, feeCents: true },
    }),
    db.creatorFinancialTransaction.count({ where: baseWhere }),
    db.creatorFinancialTransaction.groupBy({
      by: ["transactionStatus"],
      where: baseWhere,
      _count: { _all: true },
      _sum: { amountCents: true, netCents: true, feeCents: true },
    }),
    db.creatorEarningsTotal.findUnique({ where: { creatorId_category: { creatorId: job.creatorId, category: "TOTAL" } } }),
    db.creatorFinancialTransaction.count({ where: { ...baseWhere, projectionStatus: "STORED_ONLY" } }),
  ]);
  const grossCents = Number(aggregate?._sum?.amountCents || 0);
  const netCents = Number(aggregate?._sum?.netCents || 0);
  const feeCents = Number(aggregate?._sum?.feeCents || 0);
  const statusTotals = summarizeStatusGroups(statusGroups);
  const earningsTransactionsCount = Math.max(0, count - statusTotals.refundTransactionsCount);
  const earningsGrossCents = grossCents - statusTotals.refundGrossCents;
  const earningsNetCents = netCents - statusTotals.refundNetCents;
  const earningsFeeCents = feeCents - statusTotals.refundFeeCents;
  const sourceBoundaryReached = payload.sourceBoundaryReached === true;
  const scannerRejected = integer(payload.scannerRejected, 0, 100_000_000);
  const chartReady = Boolean(chartTotal && chartTotal.sourceJobId === job.id && chartTotal.scanRunId === scanRunId);
  // Live OF evidence from multiple creators shows earnings/chart includes both
  // cleared (done) and payout-pending (loading) earnings, while status=undo is
  // a refunded/reversed transaction and is excluded from chart earnings.
  const countMatched = chartReady ? earningsTransactionsCount === Number(chartTotal.transactionsCount || 0) : false;
  const grossMatched = chartReady ? earningsGrossCents === Number(chartTotal.grossCents || 0) : false;
  const netMatched = chartReady ? earningsNetCents === Number(chartTotal.netCents || 0) : false;
  const complete = mode === "catchup"
    ? sourceBoundaryReached && scannerRejected === 0
    : sourceBoundaryReached && scannerRejected === 0 && chartReady && countMatched && grossMatched && netMatched;
  return {
    ok: true,
    type: "financial_transactions",
    mode,
    complete,
    scanRunId,
    sourceBoundaryReached,
    scannerRejected,
    transactionsCount: count,
    grossCents,
    netCents,
    feeCents,
    earningsTransactionsCount,
    earningsGrossCents,
    earningsNetCents,
    earningsFeeCents,
    settledTransactionsCount: statusTotals.settledTransactionsCount,
    settledGrossCents: statusTotals.settledGrossCents,
    settledNetCents: statusTotals.settledNetCents,
    settledFeeCents: statusTotals.settledFeeCents,
    pendingTransactionsCount: statusTotals.pendingTransactionsCount,
    pendingGrossCents: statusTotals.pendingGrossCents,
    pendingNetCents: statusTotals.pendingNetCents,
    pendingFeeCents: statusTotals.pendingFeeCents,
    refundTransactionsCount: statusTotals.refundTransactionsCount,
    refundGrossCents: statusTotals.refundGrossCents,
    refundNetCents: statusTotals.refundNetCents,
    refundFeeCents: statusTotals.refundFeeCents,
    statusSummary: statusTotals.statusSummary,
    storedOnly,
    reconciliation: {
      chartReady,
      countMatched,
      grossMatched,
      netMatched,
      chartCount: chartReady ? Number(chartTotal.transactionsCount || 0) : null,
      chartGrossCents: chartReady ? Number(chartTotal.grossCents || 0) : null,
      chartNetCents: chartReady ? Number(chartTotal.netCents || 0) : null,
    },
    deviceId: deviceId || null,
  };
}

module.exports = {
  JOB_KEY,
  COLLECTOR_VERSION,
  SCHEMA_VERSION,
  ingestFinancialTransactionsChunk,
  ingestFinancialChartChunk,
  completeFinancialTransactionsScan,
  summarizeStatusGroups,
  REFUND_TRANSACTION_STATUSES,
  PAYOUT_PENDING_TRANSACTION_STATUSES,
};

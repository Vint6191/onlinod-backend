"use strict";

const { resolveRange, rangeForClient, whereForRange } = require("./range-service");
const {
  CUSTOM_DELIVERY_OVERDUE_MS,
  loadAssets,
  isReady,
  serializeDelivery,
} = require("./custom-content-delivery-service");
const { receiptSignalRows } = require("./custom-delivery-receipt-authority-service");

const SIGNAL_ACTIONS = [
  "CUSTOM_PAYMENT_OVERRIDE",
  "CUSTOM_PAYMENT_UNDERCHARGE",
  "CUSTOM_DELIVERY_DUPLICATE_ATTEMPT",
];

const ANOMALY_SIGNAL_SCAN_BUDGET = 1000;
const OVERDUE_SCAN_BUDGET = 1000;

function clean(value, max = 500) { return String(value == null ? "" : value).trim().slice(0, max); }
function num(value) { const n = Number(value); return Number.isFinite(n) ? Math.round(n) : 0; }
function ids(values) { return Array.from(new Set((Array.isArray(values) ? values : []).map((v) => clean(v, 180)).filter(Boolean))); }
function metadata(row) { return row?.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata : {}; }
function creatorWhere(allowedCreatorIds) {
  if (!Array.isArray(allowedCreatorIds)) return {};
  const scoped = ids(allowedCreatorIds);
  return { creatorId: { in: scoped.length ? scoped : ["__none__"] } };
}
function creatorAllowed(creatorId, allowedCreatorIds) {
  if (!Array.isArray(allowedCreatorIds)) return true;
  return new Set(ids(allowedCreatorIds)).has(clean(creatorId, 180));
}

const OVERDUE_INCLUDE = {
  creator: { select: { id: true, displayName: true, username: true, avatarUrl: true, customsVaultFolderId: true } },
  customOrder: {
    select: {
      id: true, creatorId: true, dialogId: true, scenario: true, internalNote: true, type: true, contentKind: true,
      status: true, deliveredAt: true, fanDeliveredAt: true, deliverySentMediaIds: true, deliveryMessageIds: true, deliveryOfferedCents: true,
      priceCents: true, paidAmountCents: true, createdAt: true,
      creator: { select: { id: true, displayName: true, username: true, avatarUrl: true, customsVaultFolderId: true } },
    },
  },
};

async function loadOverdue({ db, agencyId, allowedCreatorIds, includeMoney, now, limit, scanBudget = OVERDUE_SCAN_BUDGET }) {
  const cutoff = new Date(now.getTime() - CUSTOM_DELIVERY_OVERDUE_MS);
  const items = [];
  let total = 0;
  let cursor = null;
  let scannedRows = 0;
  let complete = true;
  const budget = Math.max(1, Math.min(5000, Math.floor(Number(scanBudget) || OVERDUE_SCAN_BUDGET)));
  while (scannedRows < budget) {
    const pageTake = Math.min(200, budget - scannedRows);
    const rows = await db.customContentSubmission.findMany({
      where: {
        agencyId,
        reviewStatus: "APPROVED",
        reviewedAt: { not: null, lte: cutoff },
        customOrderId: { not: null },
        customOrder: { is: { type: "CONTENT", status: "PENDING", fanDeliveredAt: null } },
        ...creatorWhere(allowedCreatorIds),
      },
      include: OVERDUE_INCLUDE,
      orderBy: [{ reviewedAt: "asc" }, { id: "asc" }],
      take: pageTake,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;
    scannedRows += rows.length;
    cursor = String(rows[rows.length - 1].id || "");
    const assets = await loadAssets(db, agencyId, rows);
    for (const row of rows || []) {
      if (!isReady(row, assets)) continue;
      const delivery = serializeDelivery(row, assets, now);
      if (!delivery.overdue) continue;
      total += 1;
      if (items.length < limit) items.push({
        customOrderId: delivery.customOrderId,
        submissionId: delivery.submissionId,
        creatorId: delivery.creatorId,
        dialogId: delivery.dialogId,
        creator: delivery.creator,
        scenario: delivery.scenario,
        readyAt: delivery.readyAt,
        overdueAt: delivery.overdueAt,
        overdueForSeconds: delivery.overdueForSeconds,
        totalPriceCents: includeMoney ? delivery.totalPriceCents : null,
        paidAmountCents: includeMoney ? delivery.paidAmountCents : null,
        remainingAmountCents: includeMoney ? delivery.remainingAmountCents : null,
        deliveryPriceCents: includeMoney ? delivery.deliveryPriceCents : null,
        approvedMediaCount: delivery.approvedMediaCount,
        deliveredMediaCount: delivery.deliveredMediaCount,
      });
    }
    if (!cursor || rows.length < pageTake) break;
    if (scannedRows >= budget) { complete = false; break; }
  }
  return { items, total: complete ? total : null, totalLowerBound: total, complete, nextCursor: complete ? null : cursor, scannedRows };
}

function coverageKey(customOrderId, creatorId, messageId) {
  return `${clean(customOrderId, 180)}|${clean(creatorId, 180)}|${clean(messageId, 220)}`;
}

async function enrichSignalRows({ db, agencyId, rows, includeMoney }) {
  const actorUserIds = ids(rows.map((row) => row.actorUserId));
  const actorMemberIds = ids(rows.map((row) => row.actorMemberId));
  const creatorIds = ids(rows.map((row) => row.creatorId));
  const memberOr = [];
  if (actorUserIds.length) memberOr.push({ userId: { in: actorUserIds } });
  if (actorMemberIds.length) memberOr.push({ id: { in: actorMemberIds } });
  const [members, creators] = await Promise.all([
    memberOr.length ? db.agencyMember.findMany({
      where: { agencyId, OR: memberOr },
      select: { id: true, userId: true, displayName: true, roleKey: true, user: { select: { name: true, email: true } } },
    }) : [],
    creatorIds.length ? db.creatorAccount.findMany({
      where: { agencyId, id: { in: creatorIds } },
      select: { id: true, displayName: true, username: true, avatarUrl: true },
    }) : [],
  ]);
  const memberByUser = new Map((members || []).filter((row) => row.userId).map((row) => [String(row.userId), row]));
  const memberById = new Map((members || []).map((row) => [String(row.id), row]));
  const creatorById = new Map((creators || []).map((row) => [String(row.id), row]));
  return rows.map((row) => {
    const actor = (row.actorMemberId ? memberById.get(String(row.actorMemberId)) : null)
      || (row.actorUserId ? memberByUser.get(String(row.actorUserId)) : null) || null;
    const creator = creatorById.get(String(row.creatorId || "")) || null;
    return {
      id: String(row.id), type: String(row.type), customOrderId: clean(row.customOrderId, 180) || null,
      creatorId: clean(row.creatorId, 180) || null, dialogId: clean(row.dialogId, 180) || null,
      creator: creator ? { displayName: creator.displayName || null, username: creator.username || null, avatarUrl: creator.avatarUrl || null } : null,
      actor: actor ? { memberId: String(actor.id), name: actor.displayName || actor.user?.name || actor.user?.email || null, roleKey: actor.roleKey || null } : null,
      expectedPriceCents: includeMoney ? Math.max(0, num(row.expectedPriceCents)) : null, actualPriceCents: includeMoney ? Math.max(0, num(row.actualPriceCents)) : null,
      totalPriceCents: includeMoney ? Math.max(0, num(row.totalPriceCents)) : null, paidAmountCents: includeMoney ? Math.max(0, num(row.paidAmountCents)) : null,
      remainingAmountCents: includeMoney ? Math.max(0, num(row.remainingAmountCents)) : null, shortfallCents: includeMoney ? Math.max(0, num(row.shortfallCents)) : null,
      duplicateMediaCount: Math.max(0, num(row.duplicateMediaCount)), reason: clean(row.reason, 500) || null,
      messageId: clean(row.messageId, 220) || null, createdAt: new Date(row.createdAt).toISOString(),
    };
  });
}

async function loadReceiptSignals({ db, agencyId, allowedCreatorIds, includeMoney, range, scanBudget = ANOMALY_SIGNAL_SCAN_BUDGET }) {
  if (!db.customDeliveryReceipt?.findMany) return { rows: [], coverage: new Set(), complete: true, nextCursor: null, scannedRows: 0 };
  const receipts = [];
  let cursor = null;
  let scannedRows = 0;
  let complete = true;
  const budget = Math.max(1, Math.min(5000, Math.floor(Number(scanBudget) || ANOMALY_SIGNAL_SCAN_BUDGET)));
  while (scannedRows < budget) {
    const pageTake = Math.min(200, budget - scannedRows);
    const page = await db.customDeliveryReceipt.findMany({
      where: { agencyId, ...creatorWhere(allowedCreatorIds), ...whereForRange("occurredAt", range) },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: pageTake,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!page.length) break;
    receipts.push(...page);
    scannedRows += page.length;
    cursor = String(page[page.length - 1].id || "");
    if (!cursor || page.length < pageTake) break;
    if (scannedRows >= budget) { complete = false; break; }
  }
  const coverage = new Set(receipts.map((row) => coverageKey(row.customOrderId, row.creatorId, row.messageId)));
  const normalized = receipts.flatMap((receipt) => receiptSignalRows(receipt)).map((row) => ({ ...row, actorUserId: row.actorUserId || null, actorMemberId: row.actorMemberId || null }));
  return { rows: await enrichSignalRows({ db, agencyId, rows: normalized, includeMoney }), coverage, complete, nextCursor: complete ? null : cursor, scannedRows };
}

async function expandReceiptCoverageForLegacyAuditRows({ db, agencyId, allowedCreatorIds, auditRows, coverage }) {
  const expanded = new Set(coverage || []);
  if (!db.customDeliveryReceipt?.findMany || !Array.isArray(auditRows) || !auditRows.length) return expanded;
  const messageIds = Array.from(new Set(auditRows.flatMap((row) => {
    const meta = metadata(row);
    if (!creatorAllowed(meta.creatorId, allowedCreatorIds)) return [];
    const messageId = clean(meta.messageId, 220);
    return messageId ? [messageId] : [];
  })));
  for (let offset = 0; offset < messageIds.length; offset += 500) {
    const chunk = messageIds.slice(offset, offset + 500);
    const receipts = await db.customDeliveryReceipt.findMany({
      where: { agencyId, ...creatorWhere(allowedCreatorIds), messageId: { in: chunk } },
      select: { customOrderId: true, creatorId: true, messageId: true },
    });
    for (const row of receipts || []) expanded.add(coverageKey(row.customOrderId, row.creatorId, row.messageId));
  }
  return expanded;
}

async function loadLegacyAuditSignals({ db, agencyId, allowedCreatorIds, includeMoney, range, coverage, scanBudget = ANOMALY_SIGNAL_SCAN_BUDGET }) {
  const rows = [];
  let cursor = null;
  let scannedRows = 0;
  let complete = true;
  const budget = Math.max(1, Math.min(5000, Math.floor(Number(scanBudget) || ANOMALY_SIGNAL_SCAN_BUDGET)));
  while (scannedRows < budget) {
    const pageTake = Math.min(200, budget - scannedRows);
    const page = await db.auditLog.findMany({
      where: { agencyId, action: { in: SIGNAL_ACTIONS }, ...whereForRange("createdAt", range) },
      select: { id: true, actorUserId: true, action: true, targetId: true, metadata: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: pageTake,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!page.length) break;
    rows.push(...page);
    scannedRows += page.length;
    cursor = String(page[page.length - 1].id || "");
    if (!cursor || page.length < pageTake) break;
    if (scannedRows >= budget) { complete = false; break; }
  }
  const canonicalCoverage = await expandReceiptCoverageForLegacyAuditRows({ db, agencyId, allowedCreatorIds, auditRows: rows, coverage });
  const normalized = rows.flatMap((row) => {
    const meta = metadata(row);
    if (!creatorAllowed(meta.creatorId, allowedCreatorIds)) return [];
    if (canonicalCoverage.has(coverageKey(row.targetId, meta.creatorId, meta.messageId))) return [];
    const expected = Math.max(0, num(meta.expectedPriceCents));
    const actual = Math.max(0, num(meta.actualPriceCents));
    return [{
      id: String(row.id), type: String(row.action), customOrderId: clean(row.targetId, 180) || null,
      creatorId: clean(meta.creatorId, 180) || null, dialogId: clean(meta.dialogId, 180) || null,
      actorUserId: row.actorUserId || null, actorMemberId: null,
      expectedPriceCents: expected, actualPriceCents: actual, totalPriceCents: Math.max(0, num(meta.totalPriceCents)),
      paidAmountCents: Math.max(0, num(meta.paidAmountCents)), remainingAmountCents: Math.max(0, num(meta.remainingAmountCents)),
      shortfallCents: Math.max(0, num(meta.shortfallCents)), duplicateMediaCount: Array.isArray(meta.duplicateMediaIds) ? meta.duplicateMediaIds.length : 0,
      reason: clean(meta.reason, 500) || null, messageId: clean(meta.messageId, 220) || null, createdAt: row.createdAt,
    }];
  });
  return { rows: await enrichSignalRows({ db, agencyId, rows: normalized, includeMoney }), complete, nextCursor: complete ? null : cursor, scannedRows };
}

async function loadBusinessSignals({ db, agencyId, allowedCreatorIds, includeMoney, range, limit, scanBudget = ANOMALY_SIGNAL_SCAN_BUDGET }) {
  const receiptResult = await loadReceiptSignals({ db, agencyId, allowedCreatorIds, includeMoney, range, scanBudget });
  const legacyResult = await loadLegacyAuditSignals({ db, agencyId, allowedCreatorIds, includeMoney, range, coverage: receiptResult.coverage, scanBudget });
  const all = [...receiptResult.rows, ...legacyResult.rows]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || String(b.id).localeCompare(String(a.id)));
  return {
    all, items: all.slice(0, limit), complete: receiptResult.complete && legacyResult.complete,
    scannedRows: receiptResult.scannedRows + legacyResult.scannedRows,
    continuation: { receipts: receiptResult.nextCursor, legacyAudit: legacyResult.nextCursor },
  };
}

async function listCustomDeliveryAnomalies({ agencyId, allowedCreatorIds = null, includeMoney = false, rangeKey = "7d", limit = 100, scanBudget = ANOMALY_SIGNAL_SCAN_BUDGET, now: nowInput = new Date(), db = null } = {}) {
  if (!agencyId) throw Object.assign(new Error("agencyId is required"), { code: "CUSTOM_ANOMALIES_AGENCY_REQUIRED", status: 400 });
  const client = db || require("../prisma");
  const now = nowInput instanceof Date ? nowInput : new Date(nowInput);
  const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 100)));
  const range = resolveRange(rangeKey, now);
  const [overdueResult, eventResult] = await Promise.all([
    loadOverdue({ db: client, agencyId, allowedCreatorIds, includeMoney, now, limit: safeLimit, scanBudget }),
    loadBusinessSignals({ db: client, agencyId, allowedCreatorIds, includeMoney, range, limit: safeLimit, scanBudget }),
  ]);
  const overdue = overdueResult.items;
  const events = eventResult.items;
  const allEvents = eventResult.all;
  const eventCounts = {
    paymentOverrides: allEvents.filter((row) => row.type === "CUSTOM_PAYMENT_OVERRIDE").length,
    undercharges: allEvents.filter((row) => row.type === "CUSTOM_PAYMENT_UNDERCHARGE").length,
    duplicateAttempts: allEvents.filter((row) => row.type === "CUSTOM_DELIVERY_DUPLICATE_ATTEMPT").length,
    fullyPaidSentAsPpv: allEvents.filter((row) => row.type === "CUSTOM_PAYMENT_OVERRIDE" && row.expectedPriceCents === 0 && row.actualPriceCents > 0).length,
  };
  const summary = {
    overdueDeliveries: overdueResult.complete ? overdueResult.totalLowerBound : null,
    paymentOverrides: eventResult.complete ? eventCounts.paymentOverrides : null,
    undercharges: eventResult.complete ? eventCounts.undercharges : null,
    duplicateAttempts: eventResult.complete ? eventCounts.duplicateAttempts : null,
    fullyPaidSentAsPpv: includeMoney ? (eventResult.complete ? eventCounts.fullyPaidSentAsPpv : null) : null,
  };
  const summaryLowerBounds = { overdueDeliveries: overdueResult.totalLowerBound, ...eventCounts, fullyPaidSentAsPpv: includeMoney ? eventCounts.fullyPaidSentAsPpv : null };
  return {
    ok: true,
    range: rangeForClient(range),
    serverNow: now.toISOString(),
    overdueThresholdSeconds: Math.floor(CUSTOM_DELIVERY_OVERDUE_MS / 1000),
    moneyVisible: includeMoney === true,
    summary,
    summaryLowerBounds,
    readCoverage: {
      complete: overdueResult.complete && eventResult.complete,
      overdue: { complete: overdueResult.complete, scannedRows: overdueResult.scannedRows, nextCursor: overdueResult.nextCursor },
      events: { complete: eventResult.complete, scannedRows: eventResult.scannedRows, continuation: eventResult.continuation },
    },
    overdue,
    events,
  };
}

module.exports = { listCustomDeliveryAnomalies, SIGNAL_ACTIONS };

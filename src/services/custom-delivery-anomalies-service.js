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

async function loadOverdue({ db, agencyId, allowedCreatorIds, now, limit }) {
  const cutoff = new Date(now.getTime() - CUSTOM_DELIVERY_OVERDUE_MS);
  const items = [];
  let total = 0;
  let cursor = null;
  for (;;) {
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
      take: 200,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;
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
        totalPriceCents: delivery.totalPriceCents,
        paidAmountCents: delivery.paidAmountCents,
        remainingAmountCents: delivery.remainingAmountCents,
        deliveryPriceCents: delivery.deliveryPriceCents,
        approvedMediaCount: delivery.approvedMediaCount,
        deliveredMediaCount: delivery.deliveredMediaCount,
      });
    }
    if (!cursor || rows.length < 200) break;
  }
  return { items, total };
}

function coverageKey(customOrderId, creatorId, messageId) {
  return `${clean(customOrderId, 180)}|${clean(creatorId, 180)}|${clean(messageId, 220)}`;
}

async function enrichSignalRows({ db, agencyId, rows }) {
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
      expectedPriceCents: Math.max(0, num(row.expectedPriceCents)), actualPriceCents: Math.max(0, num(row.actualPriceCents)),
      totalPriceCents: Math.max(0, num(row.totalPriceCents)), paidAmountCents: Math.max(0, num(row.paidAmountCents)),
      remainingAmountCents: Math.max(0, num(row.remainingAmountCents)), shortfallCents: Math.max(0, num(row.shortfallCents)),
      duplicateMediaCount: Math.max(0, num(row.duplicateMediaCount)), reason: clean(row.reason, 500) || null,
      messageId: clean(row.messageId, 220) || null, createdAt: new Date(row.createdAt).toISOString(),
    };
  });
}

async function loadReceiptSignals({ db, agencyId, allowedCreatorIds, range }) {
  if (!db.customDeliveryReceipt?.findMany) return { rows: [], coverage: new Set() };
  const receipts = [];
  let cursor = null;
  for (;;) {
    const page = await db.customDeliveryReceipt.findMany({
      where: { agencyId, ...creatorWhere(allowedCreatorIds), ...whereForRange("occurredAt", range) },
      orderBy: { id: "asc" }, take: 1000,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!page.length) break;
    receipts.push(...page);
    cursor = String(page[page.length - 1].id || "");
    if (!cursor || page.length < 1000) break;
  }
  const coverage = new Set(receipts.map((row) => coverageKey(row.customOrderId, row.creatorId, row.messageId)));
  const normalized = receipts.flatMap((receipt) => receiptSignalRows(receipt)).map((row) => ({ ...row, actorUserId: row.actorUserId || null, actorMemberId: row.actorMemberId || null }));
  return { rows: await enrichSignalRows({ db, agencyId, rows: normalized }), coverage };
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

async function loadLegacyAuditSignals({ db, agencyId, allowedCreatorIds, range, coverage }) {
  const rows = [];
  let cursor = null;
  for (;;) {
    const page = await db.auditLog.findMany({
      where: { agencyId, action: { in: SIGNAL_ACTIONS }, ...whereForRange("createdAt", range) },
      select: { id: true, actorUserId: true, action: true, targetId: true, metadata: true, createdAt: true },
      orderBy: { id: "asc" }, take: 1000,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!page.length) break;
    rows.push(...page);
    cursor = String(page[page.length - 1].id || "");
    if (!cursor || page.length < 1000) break;
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
  return enrichSignalRows({ db, agencyId, rows: normalized });
}

async function loadBusinessSignals({ db, agencyId, allowedCreatorIds, range, limit }) {
  const receiptResult = await loadReceiptSignals({ db, agencyId, allowedCreatorIds, range });
  const legacy = await loadLegacyAuditSignals({ db, agencyId, allowedCreatorIds, range, coverage: receiptResult.coverage });
  const all = [...receiptResult.rows, ...legacy]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || String(b.id).localeCompare(String(a.id)));
  return { all, items: all.slice(0, limit) };
}

async function listCustomDeliveryAnomalies({ agencyId, allowedCreatorIds = null, rangeKey = "7d", limit = 100, now: nowInput = new Date(), db = null } = {}) {
  if (!agencyId) throw Object.assign(new Error("agencyId is required"), { code: "CUSTOM_ANOMALIES_AGENCY_REQUIRED", status: 400 });
  const client = db || require("../prisma");
  const now = nowInput instanceof Date ? nowInput : new Date(nowInput);
  const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 100)));
  const range = resolveRange(rangeKey, now);
  const [overdueResult, eventResult] = await Promise.all([
    loadOverdue({ db: client, agencyId, allowedCreatorIds, now, limit: safeLimit }),
    loadBusinessSignals({ db: client, agencyId, allowedCreatorIds, range, limit: safeLimit }),
  ]);
  const overdue = overdueResult.items;
  const events = eventResult.items;
  const allEvents = eventResult.all;
  const summary = {
    overdueDeliveries: overdueResult.total,
    paymentOverrides: allEvents.filter((row) => row.type === "CUSTOM_PAYMENT_OVERRIDE").length,
    undercharges: allEvents.filter((row) => row.type === "CUSTOM_PAYMENT_UNDERCHARGE").length,
    duplicateAttempts: allEvents.filter((row) => row.type === "CUSTOM_DELIVERY_DUPLICATE_ATTEMPT").length,
    fullyPaidSentAsPpv: allEvents.filter((row) => row.type === "CUSTOM_PAYMENT_OVERRIDE" && row.expectedPriceCents === 0 && row.actualPriceCents > 0).length,
  };
  return {
    ok: true,
    range: rangeForClient(range),
    serverNow: now.toISOString(),
    overdueThresholdSeconds: Math.floor(CUSTOM_DELIVERY_OVERDUE_MS / 1000),
    summary,
    overdue,
    events,
  };
}

module.exports = { listCustomDeliveryAnomalies, SIGNAL_ACTIONS };

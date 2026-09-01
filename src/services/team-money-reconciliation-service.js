"use strict";

const prisma = require("../prisma");
const { runDbTransaction } = require("./db-transaction-service");
const { serializableTxOptions } = require("../utils/prisma-transaction");

const RESOLVE_JOB_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const REFUND_STATUSES = new Set(["undo"]);
const MANUAL_SOURCE_MARKERS = ["manual"];
const NON_HUMAN_SOURCE_MARKERS = ["automation", "auto_", "broadcast", "mass", "campaign", "queue", "system", "scheduler", "welcome", "bump"];
const MANAGER_SOURCE_PREFIX = "manual_claim_";

function clean(value, max = 255) {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, max) : null;
}

function normalizedStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function isRefundStatus(value) {
  return REFUND_STATUSES.has(normalizedStatus(value));
}

function classifySentSource(row) {
  const source = String(row?.source || "").trim().toLowerCase();
  if (!source) return "UNKNOWN";
  if (NON_HUMAN_SOURCE_MARKERS.some((marker) => source.includes(marker))) return "NON_HUMAN";
  if (MANUAL_SOURCE_MARKERS.some((marker) => source.includes(marker))) return "MANUAL";
  return "UNKNOWN";
}

function purchaseIdentity(sale) {
  return clean(
    sale?.externalNotificationId
      || sale?.externalTransactionId
      || sale?.eventFingerprint
      || (sale?.id ? `creator_sale:${sale.id}` : null),
    220,
  );
}

function manualResolutionPreserved(row) {
  return String(row?.resolvedSource || "").startsWith(MANAGER_SOURCE_PREFIX);
}

function candidateFromPurchase(row) {
  const memberId = clean(row?.attributedMemberId, 160);
  if (!memberId) return null;
  return {
    memberId,
    userId: clean(row?.attributedUserId, 160),
    deviceId: clean(row?.resolvedByDeviceId, 160),
    shiftKey: clean(row?.attributedShiftKey, 220),
    source: clean(row?.resolvedSource || "existing_purchase_ledger", 80) || "existing_purchase_ledger",
  };
}

function candidateFromSent(row) {
  const memberId = clean(row?.memberId, 160);
  if (!memberId) return null;
  const sentAt = row?.sentAt instanceof Date ? row.sentAt : new Date(row?.sentAt || 0);
  return {
    memberId,
    userId: clean(row?.userId, 160),
    deviceId: clean(row?.deviceId, 160),
    shiftKey: clean(row?.shiftKey, 220),
    sentAtMs: Number.isFinite(sentAt.getTime()) ? sentAt.getTime() : null,
    source: "exact_message_provenance",
  };
}

function mergeCandidates(...values) {
  const map = new Map();
  const push = (value) => {
    if (!value) return;
    if (Array.isArray(value)) return value.forEach(push);
    const memberId = clean(value.memberId, 160);
    if (!memberId) return;
    const prev = map.get(memberId) || {};
    map.set(memberId, {
      memberId,
      userId: prev.userId || clean(value.userId, 160),
      deviceId: prev.deviceId || clean(value.deviceId, 160),
      shiftKey: prev.shiftKey || clean(value.shiftKey, 220),
      sentAtMs: prev.sentAtMs || Number(value.sentAtMs || 0) || null,
      source: prev.source || clean(value.source, 80) || "unknown",
    });
  };
  values.forEach(push);
  return [...map.values()];
}

async function findExactSentMessage(db, sale) {
  const messageId = clean(sale?.messageId, 160);
  if (!messageId || !db?.teamSentMessageLedger?.findFirst) return null;

  const exact = await db.teamSentMessageLedger.findFirst({
    where: { agencyId: sale.agencyId, creatorId: sale.creatorId, messageId },
    orderBy: { sentAt: "asc" },
  });
  if (exact) return exact;

  // Historical v13 preview builds sometimes populated accountId before the
  // creatorId column. This fallback is still exact because messageId + account
  // are both creator-scoped; there is no time-window ownership heuristic here.
  return db.teamSentMessageLedger.findFirst({
    where: {
      agencyId: sale.agencyId,
      accountId: sale.creatorId,
      messageId,
      OR: [{ creatorId: null }, { creatorId: sale.creatorId }],
    },
    orderBy: { sentAt: "asc" },
  });
}

async function findExistingPurchase(db, { sale, purchaseId, fanExternalId }) {
  if (!db?.teamPpvPurchaseLedger) return null;
  if (sale.id && db.teamPpvPurchaseLedger.findUnique) {
    const bySale = await db.teamPpvPurchaseLedger.findUnique({ where: { creatorSaleId: sale.id } }).catch(() => null);
    if (bySale) return bySale;
  }
  if (purchaseId && db.teamPpvPurchaseLedger.findUnique) {
    const byId = await db.teamPpvPurchaseLedger.findUnique({
      where: { agencyId_purchaseId: { agencyId: sale.agencyId, purchaseId } },
    }).catch(() => null);
    if (byId) return byId;
  }
  const messageId = clean(sale.messageId, 160);
  if (!messageId || !db.teamPpvPurchaseLedger.findMany) return null;
  const when = sale.purchasedAt instanceof Date ? sale.purchasedAt : new Date(sale.purchasedAt);
  if (!Number.isFinite(when.getTime())) return null;
  const rows = await db.teamPpvPurchaseLedger.findMany({
    where: {
      agencyId: sale.agencyId,
      creatorId: sale.creatorId,
      messageId,
      amountCents: Number(sale.amountCents || 0),
      purchasedAt: {
        gte: new Date(when.getTime() - 24 * 60 * 60 * 1000),
        lte: new Date(when.getTime() + 24 * 60 * 60 * 1000),
      },
    },
    orderBy: { createdAt: "asc" },
    take: 3,
  });
  const semanticallySame = (rows || []).filter((row) => {
    if (!fanExternalId) return true;
    return !row.fanId || row.fanId === fanExternalId || row.buyerFanId === fanExternalId || row.dialogId === fanExternalId;
  });
  return semanticallySame.length === 1 ? semanticallySame[0] : null;
}

async function loadSale(db, saleId) {
  return db.creatorSale.findUnique({
    where: { id: saleId },
    include: {
      fan: { select: { onlyFansUserId: true } },
      creator: { select: { id: true, username: true, displayName: true } },
    },
  });
}

async function loadFinancialTransaction(db, sale) {
  if (!sale?.externalTransactionId || !db?.creatorFinancialTransaction?.findUnique) return null;
  return db.creatorFinancialTransaction.findUnique({
    where: {
      creatorId_externalTransactionId: {
        creatorId: sale.creatorId,
        externalTransactionId: sale.externalTransactionId,
      },
    },
  });
}

async function ensureActiveMember(db, sale, sent) {
  const memberId = clean(sent?.memberId, 160);
  if (!memberId || !db?.agencyMember?.findFirst) return null;
  return db.agencyMember.findFirst({
    where: { id: memberId, agencyId: sale.agencyId, deletedAt: null },
    select: { id: true, userId: true },
  });
}

async function upsertResolveJob(db, { purchase, sale, proposed, sent }) {
  const messageId = clean(sale.messageId, 160);
  if (!messageId || !db?.teamPpvResolveJob?.upsert) return null;
  const key = {
    agencyId_purchaseId_messageId: {
      agencyId: sale.agencyId,
      purchaseId: purchase.purchaseId,
      messageId,
    },
  };
  const base = {
    agencyId: sale.agencyId,
    accountId: purchase.accountId,
    creatorId: sale.creatorId,
    creatorRef: purchase.creatorRef,
    purchaseId: purchase.purchaseId,
    messageId,
    amountCents: Number(sale.amountCents || 0),
    currency: clean(sale.currency || "USD", 16) || "USD",
    purchasedAt: sale.purchasedAt,
    expiresAt: new Date(Date.now() + RESOLVE_JOB_RETENTION_MS),
  };

  if (proposed.status === "unresolved") {
    return db.teamPpvResolveJob.upsert({
      where: key,
      create: { ...base, status: "pending", attempts: 0, result: { source: "creator_sale_reconciliation", reason: proposed.basis } },
      update: {
        amountCents: base.amountCents,
        currency: base.currency,
        purchasedAt: base.purchasedAt,
        status: "pending",
        expiresAt: base.expiresAt,
        result: { source: "creator_sale_reconciliation", reason: proposed.basis },
      },
    });
  }

  if (proposed.status === "conflict") {
    const candidates = mergeCandidates(candidateFromPurchase(purchase), candidateFromSent(sent));
    return db.teamPpvResolveJob.upsert({
      where: key,
      create: {
        ...base,
        status: "conflict",
        attempts: 0,
        result: { conflict: true, claimType: "ppv_attribution_conflict", source: "creator_sale_reconciliation", candidates },
      },
      update: {
        amountCents: base.amountCents,
        currency: base.currency,
        purchasedAt: base.purchasedAt,
        status: "conflict",
        result: { conflict: true, claimType: "ppv_attribution_conflict", source: "creator_sale_reconciliation", candidates },
      },
    });
  }

  // Exact attribution / exact non-human provenance closes any automatic
  // pending job. Manual Claims resolutions are preserved by the purchase row
  // and do not pass through this branch.
  return db.teamPpvResolveJob.upsert({
    where: key,
    create: {
      ...base,
      status: "resolved",
      resolvedAt: new Date(),
      resolvedByMemberId: proposed.memberId || null,
      result: { source: "creator_sale_reconciliation", reason: proposed.basis, exact: true },
    },
    update: {
      amountCents: base.amountCents,
      currency: base.currency,
      purchasedAt: base.purchasedAt,
      status: "resolved",
      resolvedAt: new Date(),
      resolvedByMemberId: proposed.memberId || null,
      result: { source: "creator_sale_reconciliation", reason: proposed.basis, exact: true },
    },
  });
}

async function lockPpvResolveJobByIdentity(db, { agencyId, purchaseId, messageId }) {
  if (!agencyId || !purchaseId || !messageId || !db?.teamPpvResolveJob) return null;
  if (typeof db?.$queryRawUnsafe === "function") {
    const rows = await db.$queryRawUnsafe(`
      SELECT * FROM "TeamPpvResolveJob"
      WHERE "agencyId" = $1 AND "purchaseId" = $2 AND "messageId" = $3
      FOR UPDATE
      LIMIT 1
    `, agencyId, purchaseId, messageId);
    return rows?.[0] || null;
  }
  if (typeof db?.teamPpvResolveJob?.findUnique === "function") {
    return db.teamPpvResolveJob.findUnique({
      where: { agencyId_purchaseId_messageId: { agencyId, purchaseId, messageId } },
    });
  }
  return null;
}

async function lockPpvPurchaseRow(db, row) {
  if (!row?.id) return row || null;
  if (typeof db?.$queryRawUnsafe !== "function") {
    return db?.teamPpvPurchaseLedger?.findUnique ? (await db.teamPpvPurchaseLedger.findUnique({ where: { id: row.id } })) || row : row;
  }
  const rows = await db.$queryRawUnsafe(`
    SELECT * FROM "TeamPpvPurchaseLedger" WHERE "id" = $1 FOR UPDATE
  `, row.id);
  return rows?.[0] || null;
}

async function lockTipLedgerRow(db, row) {
  if (!row?.id) return row || null;
  if (typeof db?.$queryRawUnsafe !== "function") {
    return db?.teamTipLedger?.findUnique ? (await db.teamTipLedger.findUnique({ where: { id: row.id } })) || row : row;
  }
  const rows = await db.$queryRawUnsafe(`
    SELECT * FROM "TeamTipLedger" WHERE "id" = $1 FOR UPDATE
  `, row.id);
  return rows?.[0] || null;
}

async function reconcileCreatorSaleToTeamInTransaction({ db, saleId }) {
  if (!saleId) return { ok: false, code: "SALE_ID_REQUIRED" };
  // Memory test clients used by Creator Analytics intentionally do not model
  // Team tables. Production after the additive migration does.
  if (!db?.creatorSale?.findUnique || !db?.teamPpvPurchaseLedger?.create) {
    return { ok: true, skipped: true, reason: "TEAM_MONEY_MODELS_UNAVAILABLE" };
  }

  const sale = await loadSale(db, saleId);
  if (!sale) return { ok: false, code: "SALE_NOT_FOUND" };
  if (String(sale.saleType || "").toUpperCase() !== "MESSAGE") {
    return { ok: true, skipped: true, reason: "NOT_MESSAGE_SALE" };
  }

  const purchaseId = purchaseIdentity(sale);
  if (!purchaseId) throw new Error(`CreatorSale ${sale.id} has no stable purchase identity`);
  const fanExternalId = clean(sale.fan?.onlyFansUserId, 160);
  const [financialTransaction, sent] = await Promise.all([
    loadFinancialTransaction(db, sale),
    findExactSentMessage(db, sale),
  ]);
  const financialStatus = clean(sale.transactionStatus || financialTransaction?.transactionStatus, 80);
  const sentClass = classifySentSource(sent);
  const member = sentClass === "MANUAL" ? await ensureActiveMember(db, sale, sent) : null;

  let proposed = { status: "unresolved", memberId: null, userId: null, basis: "MESSAGE_PROVENANCE_MISSING" };
  if (!sale.messageId) proposed = { status: "unresolved", memberId: null, userId: null, basis: "SOURCE_MESSAGE_ID_MISSING" };
  else if (sentClass === "NON_HUMAN") proposed = { status: "creator_revenue", memberId: null, userId: null, basis: "EXACT_MESSAGE_NON_HUMAN" };
  else if (sentClass === "MANUAL" && member) proposed = {
    status: "attributed",
    memberId: member.id,
    userId: member.userId || sent.userId || null,
    basis: "EXACT_MESSAGE_MANUAL",
  };
  else if (sentClass === "MANUAL" && !member) proposed = { status: "unresolved", memberId: null, userId: null, basis: "EXACT_MESSAGE_MEMBER_INACTIVE" };

  // Audit15 Closure3: manual Claims locks ResolveJob -> Purchase. Automatic
  // reconciliation must use the same order whenever the resolve job exists,
  // otherwise a real MANUAL/AUTO overlap can deadlock in PostgreSQL.
  await lockPpvResolveJobByIdentity(db, {
    agencyId: sale.agencyId,
    purchaseId,
    messageId: clean(sale.messageId, 160),
  });
  let existing = await findExistingPurchase(db, { sale, purchaseId, fanExternalId });
  if (existing) existing = await lockPpvPurchaseRow(db, existing);
  const accountId = clean(sent?.accountId || sale.creatorId, 160) || sale.creatorId;
  const creatorRef = clean(sale.creator?.username || sale.creator?.displayName, 160);
  const sourceData = {
    agencyId: sale.agencyId,
    accountId,
    creatorId: sale.creatorId,
    creatorRef,
    purchaseId: existing?.purchaseId || purchaseId,
    messageId: clean(sale.messageId, 160),
    dialogId: clean(sent?.dialogId || fanExternalId, 160),
    fanId: clean(sent?.fanId || fanExternalId, 160),
    buyerFanId: fanExternalId,
    amountCents: Number(sale.amountCents || 0),
    currency: clean(sale.currency || "USD", 16) || "USD",
    purchasedAt: sale.purchasedAt,
    creatorSaleId: sale.id,
    financialTransactionId: financialTransaction?.id || null,
    financialStatus,
  };

  if (existing && manualResolutionPreserved(existing)) {
    existing = await db.teamPpvPurchaseLedger.update({
      where: { id: existing.id },
      data: {
        ...sourceData,
        attributionBasis: existing.attributionBasis || "MANUAL_OVERRIDE_PRESERVED",
      },
    });
    return { ok: true, purchase: existing, preservedManualResolution: true, financialRefunded: isRefundStatus(financialStatus) };
  }

  if (existing?.attributedMemberId && proposed.status === "attributed" && existing.attributedMemberId !== proposed.memberId) {
    proposed = { ...proposed, status: "conflict", basis: "EXACT_MESSAGE_OWNERSHIP_CONFLICT" };
  }

  const attributionData = proposed.status === "attributed"
    ? {
        status: "attributed",
        attributedMemberId: proposed.memberId,
        attributedUserId: proposed.userId,
        attributedShiftKey: clean(sent?.shiftKey, 220),
        resolvedAt: new Date(),
        resolvedByDeviceId: clean(sent?.deviceId, 160),
        resolvedSource: "creator_sale_exact_message",
      }
    : proposed.status === "creator_revenue"
      ? {
          status: "creator_revenue",
          attributedMemberId: null,
          attributedUserId: null,
          attributedShiftKey: null,
          resolvedAt: new Date(),
          resolvedByDeviceId: clean(sent?.deviceId, 160),
          resolvedSource: "creator_sale_exact_non_human",
        }
      : proposed.status === "conflict"
        ? {
            status: "conflict",
            // Keep the previous owner as evidence only; Team read models ignore
            // money while status=conflict. Claims must resolve explicitly.
            attributedMemberId: existing?.attributedMemberId || null,
            attributedUserId: existing?.attributedUserId || null,
            attributedShiftKey: existing?.attributedShiftKey || null,
            resolvedAt: null,
            resolvedByDeviceId: null,
            resolvedSource: "creator_sale_exact_conflict",
          }
        : {
            status: "unresolved",
            attributedMemberId: null,
            attributedUserId: null,
            attributedShiftKey: null,
            resolvedAt: null,
            resolvedByDeviceId: null,
            resolvedSource: "creator_sale_unresolved",
          };

  const data = { ...sourceData, ...attributionData, attributionBasis: proposed.basis };
  let purchase;
  if (existing) {
    purchase = await db.teamPpvPurchaseLedger.update({ where: { id: existing.id }, data });
  } else {
    purchase = await db.teamPpvPurchaseLedger.create({ data });
  }

  if (sale.messageId && !isRefundStatus(financialStatus)) {
    await upsertResolveJob(db, { purchase, sale, proposed, sent });
  } else if (sale.messageId && isRefundStatus(financialStatus) && db?.teamPpvResolveJob?.updateMany) {
    await db.teamPpvResolveJob.updateMany({
      where: { agencyId: sale.agencyId, purchaseId: purchase.purchaseId, messageId: sale.messageId, status: { in: ["pending", "conflict"] } },
      data: { status: "expired", resolvedAt: new Date(), result: { source: "creator_sale_reconciliation", reason: "FINANCIAL_UNDO" } },
    });
  }

  return {
    ok: true,
    purchase,
    proposedStatus: proposed.status,
    attributionBasis: proposed.basis,
    financialRefunded: isRefundStatus(financialStatus),
  };
}

async function reconcileCreatorSaleToTeam({ db = prisma, saleId }) {
  return runDbTransaction(db, (tx) => reconcileCreatorSaleToTeamInTransaction({ db: tx, saleId }), serializableTxOptions());
}

async function reconcileCreatorSalesToTeam({ db = prisma, saleIds = [] }) {
  const ids = [...new Set((saleIds || []).map((id) => clean(id, 160)).filter(Boolean))];
  const results = [];
  for (const saleId of ids) results.push(await reconcileCreatorSaleToTeam({ db, saleId }));
  return results;
}

async function loadTip(db, tipId) {
  return db.creatorTip.findUnique({
    where: { id: tipId },
    include: {
      fan: { select: { onlyFansUserId: true } },
      creator: { select: { id: true, username: true, displayName: true } },
    },
  });
}

async function findRecentTipCandidates(db, tip, fanExternalId) {
  if (!db?.teamSentMessageLedger?.findMany) return { primary: [], weak: [] };
  const receivedAt = tip.tippedAt instanceof Date ? tip.tippedAt : new Date(tip.tippedAt);
  if (!Number.isFinite(receivedAt.getTime())) return { primary: [], weak: [] };
  const rows = await db.teamSentMessageLedger.findMany({
    where: {
      agencyId: tip.agencyId,
      creatorId: tip.creatorId,
      memberId: { not: null },
      sentAt: { gte: new Date(receivedAt.getTime() - 15 * 60 * 1000), lte: receivedAt },
      ...(fanExternalId ? { OR: [{ fanId: fanExternalId }, { dialogId: fanExternalId }] } : {}),
    },
    orderBy: { sentAt: "desc" },
    take: 200,
  });
  const byMember = new Map();
  for (const row of rows || []) {
    if (classifySentSource(row) !== "MANUAL" || !row.memberId) continue;
    if (byMember.has(row.memberId)) continue;
    const sentAt = row.sentAt instanceof Date ? row.sentAt : new Date(row.sentAt);
    const ageMs = receivedAt.getTime() - sentAt.getTime();
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 15 * 60 * 1000) continue;
    byMember.set(row.memberId, {
      memberId: row.memberId,
      userId: row.userId || null,
      deviceId: row.deviceId || null,
      shiftKey: row.shiftKey || null,
      sentAtMs: sentAt.getTime(),
      ageMinutes: Math.round(ageMs / 60000),
      source: "recent_manual_message_evidence_only",
    });
  }
  const all = [...byMember.values()];
  return {
    primary: all.filter((row) => row.ageMinutes !== null && row.ageMinutes <= 10),
    weak: all.filter((row) => row.ageMinutes !== null && row.ageMinutes > 10),
  };
}

function tipManualResolutionPreserved(row) {
  return String(row?.resolvedSource || "").startsWith("manual_");
}

async function reconcileCreatorTipToTeamInTransaction({ db, tipId }) {
  if (!tipId) return { ok: false, code: "TIP_ID_REQUIRED" };
  if (!db?.creatorTip?.findUnique || !db?.teamTipLedger?.create) {
    return { ok: true, skipped: true, reason: "TEAM_MONEY_MODELS_UNAVAILABLE" };
  }
  const tip = await loadTip(db, tipId);
  if (!tip) return { ok: false, code: "TIP_NOT_FOUND" };
  const fanExternalId = clean(tip.fan?.onlyFansUserId, 160);
  const sent = await findExactSentMessage(db, tip);
  const sentClass = classifySentSource(sent);
  const member = sentClass === "MANUAL" ? await ensureActiveMember(db, tip, sent) : null;
  const recent = await findRecentTipCandidates(db, tip, fanExternalId);
  const financialStatus = clean(tip.transactionStatus, 80);

  let proposed = { status: "unresolved", memberId: null, userId: null, basis: "NO_EXACT_MESSAGE_PROVENANCE" };
  if (tip.messageId && sentClass === "NON_HUMAN") {
    proposed = { status: "creator_revenue", memberId: null, userId: null, basis: "EXACT_MESSAGE_NON_HUMAN" };
  } else if (tip.messageId && sentClass === "MANUAL" && member) {
    proposed = { status: "attributed", memberId: member.id, userId: member.userId || sent.userId || null, basis: "EXACT_MESSAGE_MANUAL" };
  } else if (tip.messageId && sentClass === "MANUAL" && !member) {
    proposed = { status: "unresolved", memberId: null, userId: null, basis: "EXACT_MESSAGE_MEMBER_INACTIVE" };
  } else if (recent.primary.length > 1) {
    proposed = { status: "conflict", memberId: null, userId: null, basis: "MULTIPLE_RECENT_CANDIDATES_EVIDENCE_ONLY" };
  } else if (recent.primary.length === 1) {
    proposed = { status: "unresolved", memberId: null, userId: null, basis: "SINGLE_RECENT_CANDIDATE_EVIDENCE_ONLY" };
  }

  const eventHash = clean(tip.eventFingerprint, 120) || clean(tip.id, 120);
  let existing = await db.teamTipLedger.findFirst({
    where: { agencyId: tip.agencyId, OR: [{ creatorTipId: tip.id }, { eventHash }] },
  }).catch(() => null);
  if (existing) existing = await lockTipLedgerRow(db, existing);

  const sourceData = {
    agencyId: tip.agencyId,
    accountId: tip.creatorId,
    creatorId: tip.creatorId,
    creatorRef: clean(tip.creator?.username || tip.creator?.displayName, 160),
    eventHash,
    tipId: clean(tip.externalNotificationId || tip.externalTransactionId || tip.eventFingerprint || tip.id, 220),
    messageId: clean(tip.messageId, 160),
    dialogId: clean(sent?.dialogId || fanExternalId, 160),
    fanId: clean(sent?.fanId || fanExternalId, 160),
    amountCents: Number(tip.amountCents || 0),
    currency: clean(tip.currency || "USD", 8) || "USD",
    receivedAt: tip.tippedAt,
    creatorTipId: tip.id,
    financialStatus,
    source: "creator_tip_reconciliation",
  };

  if (existing && tipManualResolutionPreserved(existing)) {
    existing = await db.teamTipLedger.update({
      where: { id: existing.id },
      data: { ...sourceData, attributionBasis: existing.attributionBasis || "MANUAL_OVERRIDE_PRESERVED" },
    });
    return { ok: true, attribution: existing, preservedManualResolution: true, financialRefunded: isRefundStatus(financialStatus) };
  }

  if (existing?.attributedMemberId && proposed.status === "attributed" && existing.attributedMemberId !== proposed.memberId) {
    proposed = { ...proposed, status: "conflict", basis: "EXACT_MESSAGE_OWNERSHIP_CONFLICT" };
  }

  const result = {
    claimType: "tip_attribution",
    attributionMode: "exact_message_first",
    attributionWindowMinutes: 10,
    softReviewWindowMinutes: 15,
    candidates: recent.primary,
    weakCandidates: recent.weak,
    autoReason: proposed.basis,
    exactMessageId: clean(tip.messageId, 160),
  };
  const history = Array.isArray(existing?.history) ? [...existing.history] : [];
  history.push({
    ts: Date.now(),
    action: proposed.status === "attributed" ? "exact_auto_attribution" : proposed.status === "conflict" ? "evidence_conflict" : proposed.status === "creator_revenue" ? "exact_non_human_creator_revenue" : "unresolved_evidence",
    reason: proposed.basis,
    prevOwner: existing?.attributedMemberId || null,
    nextOwner: proposed.status === "attributed" ? proposed.memberId : null,
    source: "creator_tip_reconciliation",
  });

  const attributionData = proposed.status === "attributed"
    ? {
        status: "attributed", attributedMemberId: proposed.memberId, attributedUserId: proposed.userId,
        attributedShiftKey: clean(sent?.shiftKey, 220), resolvedAt: new Date(),
        resolvedByMemberId: null, resolvedSource: "creator_tip_exact_message",
      }
    : proposed.status === "creator_revenue"
      ? {
          status: "creator_revenue", attributedMemberId: null, attributedUserId: null, attributedShiftKey: null,
          resolvedAt: new Date(), resolvedByMemberId: null, resolvedSource: "creator_tip_exact_non_human",
        }
      : proposed.status === "conflict"
        ? {
            status: "conflict", attributedMemberId: existing?.attributedMemberId || null,
            attributedUserId: existing?.attributedUserId || null, attributedShiftKey: existing?.attributedShiftKey || null,
            resolvedAt: null, resolvedByMemberId: null, resolvedSource: "creator_tip_evidence_conflict",
          }
        : {
            status: "unresolved", attributedMemberId: null, attributedUserId: null, attributedShiftKey: null,
            resolvedAt: null, resolvedByMemberId: null, resolvedSource: "creator_tip_unresolved",
          };

  const data = {
    ...sourceData, ...attributionData, attributionBasis: proposed.basis,
    candidates: recent.primary, weakCandidates: recent.weak, result, history,
  };
  const attribution = existing
    ? await db.teamTipLedger.update({ where: { id: existing.id }, data })
    : await db.teamTipLedger.create({ data });

  return {
    ok: true, attribution, proposedStatus: proposed.status, attributionBasis: proposed.basis,
    financialRefunded: isRefundStatus(financialStatus),
  };
}

async function reconcileCreatorTipToTeam({ db = prisma, tipId }) {
  return runDbTransaction(db, (tx) => reconcileCreatorTipToTeamInTransaction({ db: tx, tipId }), serializableTxOptions());
}

async function reconcileCreatorTipsToTeam({ db = prisma, tipIds = [] }) {
  const ids = [...new Set((tipIds || []).map((id) => clean(id, 160)).filter(Boolean))];
  const results = [];
  for (const tipId of ids) results.push(await reconcileCreatorTipToTeam({ db, tipId }));
  return results;
}

async function reconcileMoneyForSentMessageEvidence({ db = prisma, sent }) {
  const agencyId = clean(sent?.agencyId, 160);
  const creatorId = clean(sent?.creatorId || sent?.accountId, 160);
  const messageId = clean(sent?.messageId, 160);
  if (!agencyId || !creatorId || !messageId) return { ok: true, skipped: true, reason: "SENT_EVIDENCE_INCOMPLETE" };
  if (!db?.creatorSale?.findMany || !db?.creatorTip?.findMany) return { ok: true, skipped: true, reason: "CREATOR_MONEY_MODELS_UNAVAILABLE" };

  const sentAt = sent?.sentAt instanceof Date ? sent.sentAt : new Date(sent?.sentAt || Date.now());
  const sentAtMs = Number.isFinite(sentAt.getTime()) ? sentAt.getTime() : Date.now();
  const tipWindowEnd = new Date(sentAtMs + 15 * 60 * 1000);

  const [sales, tips] = await Promise.all([
    db.creatorSale.findMany({
      where: { agencyId, creatorId, saleType: "MESSAGE", messageId },
      select: { id: true }, orderBy: { id: "asc" }, take: 100,
    }),
    db.creatorTip.findMany({
      where: {
        agencyId, creatorId,
        OR: [
          { messageId },
          { tippedAt: { gte: sentAt, lte: tipWindowEnd } },
        ],
      },
      select: { id: true }, orderBy: { id: "asc" }, take: 200,
    }),
  ]);

  const saleIds = [...new Set((sales || []).map((row) => clean(row.id, 160)).filter(Boolean))];
  const tipIds = [...new Set((tips || []).map((row) => clean(row.id, 160)).filter(Boolean))];
  await reconcileCreatorSalesToTeam({ db, saleIds });
  await reconcileCreatorTipsToTeam({ db, tipIds });
  return { ok: true, saleIds, tipIds };
}

/**
 * Gradually attaches historical Creator Analytics money facts to the Team
 * ledgers. The relation itself is the durable progress marker: once a
 * CreatorSale/CreatorTip is reconciled, it no longer matches the next batch.
 *
 * This is intentionally DB-only. It never requests OnlyFans and it never
 * invents ownership. Exact message provenance can auto-attribute; otherwise
 * the canonical fact remains unresolved/creator revenue according to the same
 * rules used for live ingest.
 */
async function reconcileHistoricalTeamMoneyBatch({
  db = prisma,
  agencyId = null,
  saleLimit = 250,
  tipLimit = 250,
  retentionDays = 180,
  now = new Date(),
} = {}) {
  if (!db?.creatorSale?.findMany || !db?.creatorTip?.findMany) {
    return { ok: true, skipped: true, reason: "CREATOR_MONEY_MODELS_UNAVAILABLE", sales: null, tips: null };
  }
  if (!db?.teamPpvPurchaseLedger || !db?.teamTipLedger) {
    return { ok: true, skipped: true, reason: "TEAM_MONEY_MODELS_UNAVAILABLE", sales: null, tips: null };
  }

  const normalizedAgencyId = clean(agencyId, 160);
  const safeSaleLimit = Math.min(2000, Math.max(1, Number(saleLimit) || 250));
  const safeTipLimit = Math.min(2000, Math.max(1, Number(tipLimit) || 250));
  const agencyWhere = normalizedAgencyId ? { agencyId: normalizedAgencyId } : {};
  const safeRetentionDays = Math.min(730, Math.max(1, Number(retentionDays) || 180));
  const safeNow = now instanceof Date ? now : new Date(now);
  const nowMs = Number.isFinite(safeNow.getTime()) ? safeNow.getTime() : Date.now();
  const detailedSince = new Date(nowMs - safeRetentionDays * 24 * 60 * 60 * 1000);

  const [missingSaleRows, missingTipRows, unresolvedPurchases, unresolvedTips] = await Promise.all([
    db.creatorSale.findMany({
      where: { ...agencyWhere, saleType: "MESSAGE", purchasedAt: { gte: detailedSince }, teamPpvPurchase: { is: null } },
      orderBy: { id: "asc" }, take: safeSaleLimit, select: { id: true },
    }),
    db.creatorTip.findMany({
      where: { ...agencyWhere, tippedAt: { gte: detailedSince }, teamTipAttribution: { is: null } },
      orderBy: { id: "asc" }, take: safeTipLimit, select: { id: true },
    }),
    db.teamPpvPurchaseLedger.findMany ? db.teamPpvPurchaseLedger.findMany({
      where: { ...agencyWhere, purchasedAt: { gte: detailedSince }, status: { in: ["unresolved", "conflict"] }, creatorSaleId: { not: null } },
      orderBy: { id: "asc" }, take: safeSaleLimit, select: { creatorSaleId: true },
    }) : Promise.resolve([]),
    db.teamTipLedger.findMany ? db.teamTipLedger.findMany({
      where: { ...agencyWhere, receivedAt: { gte: detailedSince }, status: { in: ["unresolved", "conflict"] }, creatorTipId: { not: null } },
      orderBy: { id: "asc" }, take: safeTipLimit, select: { creatorTipId: true },
    }) : Promise.resolve([]),
  ]);
  const saleRows = [...new Set([...(missingSaleRows || []).map((r) => r.id), ...(unresolvedPurchases || []).map((r) => r.creatorSaleId)].filter(Boolean))]
    .slice(0, safeSaleLimit).map((id) => ({ id }));
  const tipRows = [...new Set([...(missingTipRows || []).map((r) => r.id), ...(unresolvedTips || []).map((r) => r.creatorTipId)].filter(Boolean))]
    .slice(0, safeTipLimit).map((id) => ({ id }));

  const run = async (rows, reconcile, idKey) => {
    let processed = 0;
    let linked = 0;
    let skipped = 0;
    const failures = [];
    for (const row of rows || []) {
      const id = clean(row?.id, 160);
      if (!id) continue;
      processed += 1;
      try {
        const result = await reconcile({ db, [idKey]: id });
        if (result?.ok === false) {
          failures.push({ id, code: clean(result.code || "RECONCILE_FAILED", 120) });
        } else if (result?.skipped) {
          skipped += 1;
        } else {
          linked += 1;
        }
      } catch (err) {
        failures.push({ id, code: "RECONCILE_EXCEPTION", error: clean(err?.message || err, 240) });
      }
    }
    return {
      selected: (rows || []).length,
      processed,
      linked,
      skipped,
      failed: failures.length,
      failures: failures.slice(0, 25),
    };
  };

  const sales = await run(saleRows, reconcileCreatorSaleToTeam, "saleId");
  const tips = await run(tipRows, reconcileCreatorTipToTeam, "tipId");

  return {
    ok: sales.failed === 0 && tips.failed === 0,
    agencyId: normalizedAgencyId,
    retentionDays: safeRetentionDays,
    detailedSince,
    sales: { ...sales, likelyMore: sales.selected >= safeSaleLimit },
    tips: { ...tips, likelyMore: tips.selected >= safeTipLimit },
  };
}

module.exports = {
  REFUND_STATUSES,
  classifySentSource,
  reconcileCreatorSaleToTeam,
  reconcileCreatorSalesToTeam,
  reconcileCreatorTipToTeam,
  reconcileCreatorTipsToTeam,
  reconcileMoneyForSentMessageEvidence,
  reconcileHistoricalTeamMoneyBatch,
};

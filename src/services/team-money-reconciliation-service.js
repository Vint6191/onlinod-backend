"use strict";

const prisma = require("../prisma");
const { runDbTransaction } = require("./db-transaction-service");
const { serializableTxOptions } = require("../utils/prisma-transaction");

const { teamFinancialStatus, publishTeamMoneyResult, financiallyActive } = require("./team-money-financial-state-service");
const correlation = require("./financial-correlation-service");

const RESOLVE_JOB_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const REFUND_STATUSES = new Set(["undo", "refunded", "refund", "chargeback", "reversed", "reversal"]);
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

function purchaseIdentity(sale) { return require("./team-purchase-identity-service").purchaseId(sale); }

function manualResolutionPreserved(row) {
  return row?.migrationBaselineProtected === true
    || String(row?.resolvedSource || "").startsWith(MANAGER_SOURCE_PREFIX);
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

async function recoverPpvRootFromDurableFact(db, { sale, purchaseId, financialTransactionId = null, aliasRootId = null }) {
  if (!db?.teamMoneyAttributionFact?.findMany || !db?.teamPpvPurchaseLedger?.create) return null;
  const or = [{ creatorSaleId: sale.id }];
  if(aliasRootId)or.push({rootId:aliasRootId});
  if (financialTransactionId) or.push({ financialTransactionId });

  const facts = await db.teamMoneyAttributionFact.findMany({
    where: { agencyId: sale.agencyId, creatorId: sale.creatorId, sourceType: "PPV", OR: or },
    orderBy: [{ sourceUpdatedAt: "desc" }, { id: "asc" }], take: 3,
  });
  const roots = [...new Set((facts || []).map((f) => clean(f.rootId || f.sourceRowId, 220)).filter(Boolean))];
  if (roots.length === 0) return null;
  if (roots.length !== 1) {
    const error = new Error("Multiple durable PPV fact generations require migration adjudication");
    error.code = "TEAM_MONEY_ROOT_MIGRATION_AMBIGUOUS";
    throw error;
  }
  const fact = facts.find((f) => clean(f.rootId || f.sourceRowId, 220) === roots[0]) || facts[0];
  const rootId = roots[0];
  const existingById = db.teamPpvPurchaseLedger.findUnique
    ? await db.teamPpvPurchaseLedger.findUnique({ where: { id: rootId } })
    : null;
  if (existingById) return require("./team-purchase-identity-service").compatible(existingById,sale,financialTransactionId)?existingById:null;
  try {
    return await db.teamPpvPurchaseLedger.create({ data: {
      id: rootId,
      agencyId: sale.agencyId,
      accountId: clean(fact.creatorId || sale.creatorId, 160) || sale.creatorId,
      creatorId: clean(fact.creatorId || sale.creatorId, 160) || sale.creatorId,
      purchaseId: purchaseId,
      messageId: clean(sale.messageId, 160), dialogId: clean(fact.dialogId, 160),
      fanId: clean(fact.fanId, 160), buyerFanId: clean(fact.fanId, 160),
      amountCents: Number(fact.amountCents || sale.amountCents || 0),
      currency: clean(fact.currency || sale.currency || "USD", 16) || "USD",
      purchasedAt: fact.occurredAt || sale.purchasedAt,
      status: clean(fact.businessStatus, 80) || "unresolved",
      attributedMemberId: clean(fact.memberId, 160), attributedUserId: clean(fact.userId, 160),
      resolvedAt: fact.attributionActive ? (fact.sourceUpdatedAt || new Date()) : null,
      resolvedSource: "migration_fact_baseline",
      creatorSaleId: sale.id,
      financialTransactionId: financialTransactionId || clean(fact.financialTransactionId, 160),
      financialStatus: clean(fact.financialStatus, 80),
      attributionBasis: clean(fact.attributionBasis, 240) || "MIGRATION_FACT_BASELINE",
      historicalFactVersion: "team_money_fact_v2", historicalFactProjectedAt: new Date(),
      rootVersion: "team_money_root_v2", compactedAt: new Date(), migrationBaselineProtected: true,
    }});
  } catch (error) {
    if (error?.code !== "P2002") throw error;
    const recovered = db.teamPpvPurchaseLedger.findUnique
      ? await db.teamPpvPurchaseLedger.findUnique({ where: { id: rootId } })
      : null;
    if (recovered && require("./team-purchase-identity-service").compatible(recovered,sale,financialTransactionId)) return recovered;
    throw error;
  }
}

async function findExistingPurchase(db, { sale, purchaseId, fanExternalId, financialTransactionId = null }) {
  const identity=require("./team-purchase-identity-service");
  if(!db?.teamPpvPurchaseLedger)return null;
  const bySale=await db.teamPpvPurchaseLedger.findUnique({where:{creatorSaleId:sale.id}});
  if(bySale) {
    if(!identity.compatible(bySale,sale,financialTransactionId))throw Error("TEAM_PURCHASE_ROOT_IDENTITY_CONFLICT");
    return bySale;
  }
  if(financialTransactionId) {
    const byFinancial=await db.teamPpvPurchaseLedger.findUnique({where:{financialTransactionId}});
    if(byFinancial) {
      if(!identity.compatible(byFinancial,sale,financialTransactionId))throw Error("TEAM_PURCHASE_ROOT_IDENTITY_CONFLICT");
      return byFinancial;
    }
  }
  const aliased=await identity.find(db,sale);
  if(aliased?.root) {
    if(!identity.compatible(aliased.root,sale,financialTransactionId))throw Error("TEAM_PURCHASE_ALIAS_CONFLICT");
    return aliased.root;
  }
  // A retained fact proves a canonical operation. A bare provider number or a
  // similar message/amount/date never proves that two purchases are identical.
  return recoverPpvRootFromDurableFact(db,{sale,purchaseId,financialTransactionId,aliasRootId:aliased?.rootId});
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

async function upsertResolveJob(db, { purchase, sale, proposed, sent, previousResult = null }) {
  const messageId = clean(correlation.reviewMessageId(sale), 160);
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
    const candidates = mergeCandidates(candidateFromPurchase(purchase), candidateFromSent(sent),
      await correlation.reviewCandidates(db, sale, "SALE"));
    return db.teamPpvResolveJob.upsert({
      where: key,
      create: {
        ...base,
        status: "conflict",
        attempts: 0,
        result: { ...previousResult, conflict: true, claimType: "ppv_attribution_conflict", source: "creator_sale_reconciliation", reason: proposed.basis, candidates,
          financialCorrelation: sale.financialCorrelation || null, exactMessageId: sale.messageId || null },
      },
      update: {
        amountCents: base.amountCents,
        currency: base.currency,
        purchasedAt: base.purchasedAt,
        status: "conflict",
        result: { ...previousResult, conflict: true, claimType: "ppv_attribution_conflict", source: "creator_sale_reconciliation", reason: proposed.basis, candidates,
          financialCorrelation: sale.financialCorrelation || null, exactMessageId: sale.messageId || null },
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

async function closeInactivePpvResolver(db, job, reason) {
  if (!job || !["pending", "conflict"].includes(job.status)) return;
  await db.teamPpvResolveJob.update({ where: { id: job.id }, data: { status: "expired", resolvedAt: new Date(),
    result: { ...(job.result || {}), source: "creator_sale_reconciliation", financialClosureReason: reason } } });
}

async function retireNonMessagePurchase(db, sale) {
  const financial = await loadFinancialTransaction(db, sale);
  let existing = await findExistingPurchase(db, { sale, purchaseId: purchaseIdentity(sale),
    financialTransactionId: financial?.id || null });
  if (!existing) return { ok: true, skipped: true, reason: "NOT_MESSAGE_SALE" };
  // Keep the same ResolveJob -> Purchase lock order as manager decisions.
  const jobs = typeof db.$queryRawUnsafe === "function"
    ? await db.$queryRawUnsafe('SELECT * FROM "TeamPpvResolveJob" WHERE "agencyId"=$1 AND "purchaseId"=$2 ORDER BY id FOR UPDATE',sale.agencyId,existing.purchaseId)
    : [await lockPpvResolveJobByIdentity(db, { agencyId: sale.agencyId, purchaseId: existing.purchaseId, messageId: existing.messageId })].filter(Boolean);
  existing = await lockPpvPurchaseRow(db, existing);
  const purchase = existing.financialStatus === "superseded" ? existing : await db.teamPpvPurchaseLedger.update({
    where: { id: existing.id }, data: { financialStatus: "superseded" },
  });
  for (const job of jobs) await closeInactivePpvResolver(db, job, "SOURCE_NOT_MESSAGE");
  await publishTeamMoneyResult(db, purchase, "PPV_RECONCILED");
  return { ok: true, purchase, financiallyInactive: true, reason: "NOT_MESSAGE_SALE" };
}

// A notification can be corrected to an informational event after its automatic
// unresolved Team projection was created. That derived row is not independent
// money authority. Keep its audit/aliases, but withdraw it atomically with the
// notification-only fact. Attributed, claimed, migrated and payout-owned roots
// still require explicit review and are never retired through this path.
async function retireUnattributedNotificationMoney({ db, model, fact, apply = false }) {
  const sale = model === "creatorSale", tip = model === "creatorTip";
  if (!sale && !tip) return { allowed: true };
  const table = sale ? "CreatorSale" : "CreatorTip";
  // A concurrent Team creator takes an FK key-share lock. This row lock closes
  // the no-root check/delete gap, including workers that read the fact earlier.
  if (typeof db.$queryRawUnsafe === "function") await db.$queryRawUnsafe(
    `SELECT id FROM "${table}" WHERE id=$1 AND "agencyId"=$2 AND "creatorId"=$3 FOR UPDATE`, fact.id, fact.agencyId, fact.creatorId);
  const delegate = sale ? db.teamPpvPurchaseLedger : db.teamTipLedger;
  const link = sale ? "creatorSaleId" : "creatorTipId";
  let root = await delegate.findFirst({ where: { [link]: fact.id } });
  if (!root) return { allowed: true, projected: false };
  const jobs = sale && typeof db.$queryRawUnsafe === "function"
    ? await db.$queryRawUnsafe('SELECT * FROM "TeamPpvResolveJob" WHERE "agencyId"=$1 AND "purchaseId"=$2 ORDER BY id FOR UPDATE', fact.agencyId, root.purchaseId)
    : sale ? [await lockPpvResolveJobByIdentity(db, { agencyId: fact.agencyId, purchaseId: root.purchaseId, messageId: root.messageId })].filter(Boolean) : [];
  root = sale ? await lockPpvPurchaseRow(db, root) : await lockTipLedgerRow(db, root);
  if (!root) return { allowed: true, projected: false };
  const source = sale ? "creator_sale_unresolved" : "creator_tip_unresolved";
  const protectedRoot = root.agencyId !== fact.agencyId || (root.creatorId || root.accountId) !== fact.creatorId
    || root[link] !== fact.id || fact.externalTransactionId || fact.source !== "NOTIFICATION"
    || root.status !== "unresolved" || root.resolvedSource !== source
    || root.attributedMemberId || root.attributedUserId || root.attributedShiftKey || root.resolvedAt
    || root.resolvedByDeviceId || root.resolvedByMemberId || root.financialTransactionId
    || root.migrationBaselineProtected || root.compactedAt
    || (tip && (root.source !== "creator_tip_reconciliation" || !Array.isArray(root.history)
      || root.history.some(item => item?.action !== "unresolved_evidence" || item?.source !== "creator_tip_reconciliation"
        || item?.prevOwner || item?.nextOwner || item?.byMemberId || item?.resolvedByMemberId)
      || root.result?.manualResolution || root.result?.manualResolutions?.length || root.result?.legacyMigration))
    || jobs.some(job => job.status !== "pending" || job.resolvedAt || job.resolvedByMemberId || job.resolvedByDeviceId
      || job.result?.source !== "creator_sale_reconciliation" || job.result?.manualResolution
      || job.result?.manualResolutions?.length || job.result?.legacyMigration);
  if (protectedRoot) return { allowed: false };
  if (sale && await db.teamPpvClaimAudit.findFirst({ where: { agencyId: fact.agencyId, purchaseId: root.purchaseId }, select: { id: true } })) {
    return { allowed: false };
  }
  if (!apply) return { allowed: true, projected: true };
  // The canonical guard must see withdrawal before the retained Team root is
  // updated. Its FK will be cleared by the caller's subsequent canonical delete;
  // the superseded monetary state survives that FK update and worker replay.
  await db[model].update({ where: { id: fact.id }, data: { transactionStatus: "superseded" } });
  root = await delegate.update({ where: { id: root.id }, data: {
    financialStatus: "superseded", attributionBasis: "NOTIFICATION_SOURCE_RECLASSIFIED",
  } });
  for (const job of jobs) await closeInactivePpvResolver(db, job, "NOTIFICATION_SOURCE_RECLASSIFIED");
  await publishTeamMoneyResult(db, root, "NOTIFICATION_SOURCE_RECLASSIFIED");
  return { allowed: true, projected: true, retiredRootId: root.id };
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
    return retireNonMessagePurchase(db, sale);
  }

  const purchaseId = purchaseIdentity(sale);
  if (!purchaseId) throw new Error(`CreatorSale ${sale.id} has no stable purchase identity`);
  const fanExternalId = clean(sale.fan?.onlyFansUserId, 160);
  const [financialTransaction, sent] = await Promise.all([
    loadFinancialTransaction(db, sale),
    findExactSentMessage(db, sale),
  ]);
  const financialStatus = teamFinancialStatus(sale, financialTransaction?.transactionStatus);
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
  let existing = await findExistingPurchase(db, {
    sale, purchaseId, fanExternalId, financialTransactionId: financialTransaction?.id || null,
  });
  const lockedResolveJob = await lockPpvResolveJobByIdentity(db, {agencyId:sale.agencyId,purchaseId:existing?.purchaseId||purchaseId,messageId:clean(correlation.reviewMessageId(sale),160)});
  if (existing) existing = await lockPpvPurchaseRow(db, existing);
  const correlationReview = require("./financial-correlation-service").requiresReview(sale, existing);
  if (correlationReview) proposed = { ...proposed, status: "conflict", basis: "FINANCIAL_IDENTITY_AMBIGUOUS" };
  const ambiguousLegacyClaim=existing && manualResolutionPreserved(existing)
    && await require("./team-purchase-identity-service").legacyAmbiguous(db,sale,existing);
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
    rootVersion: "team_money_root_v3",
  };

  if (existing && manualResolutionPreserved(existing)) {
    existing = await db.teamPpvPurchaseLedger.update({
      where: { id: existing.id },
      data: {
        ...sourceData,
        attributionBasis: correlationReview?"FINANCIAL_IDENTITY_AMBIGUOUS":ambiguousLegacyClaim?"LEGACY_IDENTITY_REVIEW_REQUIRED":existing.attributionBasis || "MANUAL_OVERRIDE_PRESERVED",
        ...(ambiguousLegacyClaim||correlationReview?{status:"conflict"}:{}),
        ...(!correlationReview&&!ambiguousLegacyClaim?require("./financial-correlation-service").restoredManualDecision(sale,existing):{}),
      },
    });
    await require("./team-purchase-identity-service").bind(db,sale,existing);
    if (!financiallyActive({financialStatus})) {
      await closeInactivePpvResolver(db, lockedResolveJob, "FINANCIAL_" + String(financialStatus).toUpperCase());
    } else if (correlationReview && correlation.reviewMessageId(sale)) {
      await upsertResolveJob(db, { purchase: existing, sale, proposed, sent, previousResult: lockedResolveJob?.result });
    } else if (!correlationReview && lockedResolveJob?.status === "conflict"
      && lockedResolveJob.result?.reason === "FINANCIAL_IDENTITY_AMBIGUOUS" && existing.status === "attributed") {
      await db.teamPpvResolveJob.update({where:{id:lockedResolveJob.id},data:{status:"resolved",resolvedAt:new Date(),
        result:{...lockedResolveJob.result,conflict:false,financialCorrelationResolution:"EXACT_IDENTITY_OR_EXPLICIT_REVIEW"}}});
    }
    await publishTeamMoneyResult(db, existing, "PPV_RECONCILED");
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

  const data = { ...sourceData, ...attributionData, attributionBasis: proposed.basis, compactedAt: null };
  let purchase;
  if (existing) {
    purchase = await db.teamPpvPurchaseLedger.update({ where: { id: existing.id }, data });
  } else {
    purchase = await db.teamPpvPurchaseLedger.create({ data });
  }

  await require("./team-purchase-identity-service").bind(db,sale,purchase);
  if (correlation.reviewMessageId(sale) && financiallyActive({ financialStatus })) {
    await upsertResolveJob(db, { purchase, sale, proposed, sent, previousResult: lockedResolveJob?.result });
  } else if (!financiallyActive({financialStatus})) {
    await closeInactivePpvResolver(db, lockedResolveJob, "FINANCIAL_" + String(financialStatus).toUpperCase());
  }

  await publishTeamMoneyResult(db, purchase, "PPV_RECONCILED");
  return {
    ok: true,
    purchase,
    proposedStatus: proposed.status,
    attributionBasis: proposed.basis,
    financialRefunded: isRefundStatus(financialStatus),
  };
}

async function reconcileCreatorSaleToTeam({ db = prisma, saleId }) {
  // The source and attribution locks are re-read inside each DB-only attempt.
  return runDbTransaction(db, (tx) => reconcileCreatorSaleToTeamInTransaction({ db: tx, saleId }), {
    ...serializableTxOptions(), maxAttempts: 3,
    operation: "team-money.reconcile-sale", authority: { kind: "TEAM_MONEY_RECONCILIATION", saleId },
  });
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
  return row?.migrationBaselineProtected === true
    || String(row?.resolvedSource || "").startsWith("manual_");
}

async function recoverTipRootFromDurableFact(db, { tip, eventHash, aliasRootId = null }) {
  if (!db?.teamMoneyAttributionFact?.findMany || !db?.teamTipLedger?.create) return null;
  const facts = await db.teamMoneyAttributionFact.findMany({
    where: { agencyId: tip.agencyId, creatorId: tip.creatorId, sourceType: "TIP",
      OR: [{ creatorTipId: tip.id }, ...(aliasRootId ? [{ rootId: aliasRootId }] : [])] },
    orderBy: [{ sourceUpdatedAt: "desc" }, { id: "asc" }], take: 3,
  });
  const roots = [...new Set((facts || []).map((f) => clean(f.rootId || f.sourceRowId, 220)).filter(Boolean))];
  if (roots.length === 0) return null;
  if (roots.length !== 1) {
    const error = new Error("Multiple durable Tip fact generations require migration adjudication");
    error.code = "TEAM_MONEY_ROOT_MIGRATION_AMBIGUOUS";
    throw error;
  }
  const fact = facts.find((f) => clean(f.rootId || f.sourceRowId, 220) === roots[0]) || facts[0];
  const rootId = roots[0];
  const existingById = db.teamTipLedger.findUnique
    ? await db.teamTipLedger.findUnique({ where: { id: rootId } })
    : null;
  if (existingById) {
    if (!require("./team-tip-identity-service").compatible(existingById, tip)) throw Object.assign(Error("TEAM_TIP_ROOT_SCOPE_MISMATCH"), { code: "TEAM_TIP_ROOT_SCOPE_MISMATCH" });
    return existingById;
  }
  if (fact.creatorTipId && fact.creatorTipId !== tip.id && aliasRootId !== rootId) throw Object.assign(Error("TEAM_TIP_RETAINED_IDENTITY_MISMATCH"), { code: "TEAM_TIP_RETAINED_IDENTITY_MISMATCH" });
  try {
    return await db.teamTipLedger.create({ data: {
      id: rootId, agencyId: tip.agencyId, accountId: clean(fact.creatorId || tip.creatorId, 160) || tip.creatorId,
      creatorId: clean(fact.creatorId || tip.creatorId, 160) || tip.creatorId,
      eventHash: clean(eventHash, 120) || `recovered:${fact.id}`,
      tipId: clean(fact.externalId || tip.externalNotificationId || tip.externalTransactionId || tip.eventFingerprint || tip.id, 220),
      messageId: clean(tip.messageId, 160), dialogId: clean(fact.dialogId, 160), fanId: clean(fact.fanId, 160),
      amountCents: Number(fact.amountCents || tip.amountCents || 0), currency: clean(fact.currency || tip.currency || "USD", 8) || "USD",
      receivedAt: fact.occurredAt || tip.tippedAt, status: clean(fact.businessStatus, 80) || "unresolved",
      attributedMemberId: clean(fact.memberId, 160), attributedUserId: clean(fact.userId, 160),
      resolvedAt: fact.attributionActive ? (fact.sourceUpdatedAt || new Date()) : null,
      resolvedSource: "migration_fact_baseline", creatorTipId: tip.id, financialStatus: clean(fact.financialStatus, 80),
      attributionBasis: clean(fact.attributionBasis, 240) || "MIGRATION_FACT_BASELINE",
      historicalFactVersion: "team_money_fact_v2", historicalFactProjectedAt: new Date(),
      rootVersion: "team_money_root_v2", compactedAt: new Date(), migrationBaselineProtected: true,
      candidates: null, weakCandidates: null, result: null, history: [], source: "migration_fact_baseline",
    }});
  } catch (error) {
    if (error?.code !== "P2002") throw error;
    const recovered = db.teamTipLedger.findUnique
      ? await db.teamTipLedger.findUnique({ where: { id: rootId } })
      : null;
    if (recovered && require("./team-tip-identity-service").compatible(recovered, tip)) return recovered;
    throw error;
  }
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
  const financialStatus = teamFinancialStatus(tip);

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
  const identity = require("./team-tip-identity-service");
  const aliased = await identity.find(db, tip);
  let existing = await db.teamTipLedger.findFirst({
    where: { agencyId: tip.agencyId, creatorId: tip.creatorId, creatorTipId: tip.id },
  });
  if (existing && aliased && existing.id !== aliased.rootId) throw Object.assign(Error("TEAM_TIP_ALIAS_CONFLICT"), { code: "TEAM_TIP_ALIAS_CONFLICT" });
  existing ||= aliased?.root;
  if (!existing) existing = await recoverTipRootFromDurableFact(db, { tip, eventHash, aliasRootId: aliased?.rootId });
  if (existing && !identity.compatible(existing, tip)) throw Object.assign(Error("TEAM_TIP_ROOT_SCOPE_MISMATCH"), { code: "TEAM_TIP_ROOT_SCOPE_MISMATCH" });
  if (existing) existing = await lockTipLedgerRow(db, existing);
  const correlationReview = require("./financial-correlation-service").requiresReview(tip, existing);
  if (correlationReview) proposed = { ...proposed, status: "conflict", basis: "FINANCIAL_IDENTITY_AMBIGUOUS" };

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
    rootVersion: "team_money_root_v2",
  };

  if (existing && tipManualResolutionPreserved(existing)) {
    const ambiguousLegacy=!aliased&&await identity.legacyAmbiguous(db,tip);
    existing = await db.teamTipLedger.update({
      where: { id: existing.id },
      data: { ...sourceData, attributionBasis: correlationReview?"FINANCIAL_IDENTITY_AMBIGUOUS":ambiguousLegacy?"LEGACY_IDENTITY_REVIEW_REQUIRED":existing.attributionBasis || "MANUAL_OVERRIDE_PRESERVED",
        ...(ambiguousLegacy||correlationReview?{status:"conflict"}:{}),
        ...(!correlationReview&&!ambiguousLegacy?require("./financial-correlation-service").restoredManualDecision(tip,existing):{}) },
    });
    await identity.bind(db, tip, existing);
    await publishTeamMoneyResult(db, existing, "TIP_RECONCILED");
    return { ok: true, attribution: existing, preservedManualResolution: true, financialRefunded: isRefundStatus(financialStatus) };
  }

  if (existing?.attributedMemberId && proposed.status === "attributed" && existing.attributedMemberId !== proposed.memberId) {
    proposed = { ...proposed, status: "conflict", basis: "EXACT_MESSAGE_OWNERSHIP_CONFLICT" };
  }

  const candidates = mergeCandidates(recent.primary, await correlation.reviewCandidates(db, tip, "TIP"));
  const result = {
    claimType: "tip_attribution",
    attributionMode: "exact_message_first",
    attributionWindowMinutes: 10,
    softReviewWindowMinutes: 15,
    candidates,
    weakCandidates: recent.weak,
    autoReason: proposed.basis,
    exactMessageId: clean(tip.messageId, 160),
    financialCorrelation: tip.financialCorrelation || null,
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
    ...sourceData, ...attributionData, attributionBasis: proposed.basis, compactedAt: null,
    candidates, weakCandidates: recent.weak, result, history,
  };
  const attribution = existing
    ? await db.teamTipLedger.update({ where: { id: existing.id }, data })
    : await db.teamTipLedger.create({ data });

  await identity.bind(db, tip, attribution);
  await publishTeamMoneyResult(db, attribution, "TIP_RECONCILED");
  return {
    ok: true, attribution, proposedStatus: proposed.status, attributionBasis: proposed.basis,
    financialRefunded: isRefundStatus(financialStatus),
  };
}

async function reconcileCreatorTipToTeam({ db = prisma, tipId }) {
  return runDbTransaction(db, (tx) => reconcileCreatorTipToTeamInTransaction({ db: tx, tipId }), {
    ...serializableTxOptions(), maxAttempts: 3,
    operation: "team-money.reconcile-tip", authority: { kind: "TEAM_MONEY_RECONCILIATION", tipId },
  });
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
  const sentLedgerId = clean(sent?.id, 160);
  if (!agencyId || !creatorId || !messageId) return { ok: true, skipped: true, reason: "SENT_EVIDENCE_INCOMPLETE" };

  // Current production path: the sent-message root is durable. Publish one fanout
  // work identity in the same transaction as the ledger write; its keyset cursor
  // enumerates every matching canonical sale/tip without a hidden take ceiling.
  if (sentLedgerId && (db?.domainWorkItem?.upsert || db?.domainWorkItem?.update || typeof db?.$queryRawUnsafe === "function")) {
    const { publishDomainWork, WORK_CLASS } = require("./domain-work-authority-service");
    await publishDomainWork({
      db, agencyId, workClass: WORK_CLASS.DEPENDENCY_FANOUT,
      objectType: "TeamSentMessageLedger", objectId: sentLedgerId,
      partitionKey: creatorId, creatorId, parentObjectId: messageId, fallbackNow: new Date(),
    });
    return { ok: true, publishedFanout: true, sentLedgerId };
  }

  // Reduced compatibility doubles do not have DomainWork. Keep an exact bounded
  // fallback for old unit tests only; production never relies on this path.
  if (!db?.creatorSale?.findMany || !db?.creatorTip?.findMany) return { ok: true, skipped: true, reason: "CREATOR_MONEY_MODELS_UNAVAILABLE" };
  const sentAt = sent?.sentAt instanceof Date ? sent.sentAt : new Date(sent?.sentAt || Date.now());
  const sentAtMs = Number.isFinite(sentAt.getTime()) ? sentAt.getTime() : Date.now();
  const tipWindowEnd = new Date(sentAtMs + 15 * 60 * 1000);
  const [sales, tips] = await Promise.all([
    db.creatorSale.findMany({ where: { agencyId, creatorId, saleType: "MESSAGE", messageId }, select: { id: true }, orderBy: { id: "asc" }, take: 100 }),
    db.creatorTip.findMany({ where: { agencyId, creatorId, OR: [{ messageId }, { tippedAt: { gte: sentAt, lte: tipWindowEnd } }] }, select: { id: true }, orderBy: { id: "asc" }, take: 100 }),
  ]);
  const saleIds = [...new Set((sales || []).map((row) => clean(row.id, 160)).filter(Boolean))];
  const tipIds = [...new Set((tips || []).map((row) => clean(row.id, 160)).filter(Boolean))];
  await reconcileCreatorSalesToTeam({ db, saleIds });
  await reconcileCreatorTipsToTeam({ db, tipIds });
  return { ok: true, saleIds, tipIds, compatibilityInline: true };
}

async function publishTeamMoneyReconciliationWork({ db = prisma, agencyId, creatorId = null, sourceType, sourceId, now = new Date() } = {}) {
  const agency = clean(agencyId,160); const id = clean(sourceId,160); const type = String(sourceType || "").trim().toUpperCase();
  if (!agency || !id || !["PPV","TIP"].includes(type)) throw Object.assign(new Error("TEAM_MONEY_WORK_IDENTITY_REQUIRED"), { code: "TEAM_MONEY_WORK_IDENTITY_REQUIRED" });
  const { publishDomainWork, WORK_CLASS } = require("./domain-work-authority-service");
  return publishDomainWork({ db, agencyId: agency, workClass: WORK_CLASS.TEAM_MONEY_RECONCILIATION,
    objectType: type === "PPV" ? "CreatorSale" : "CreatorTip", objectId: id,
    partitionKey: clean(creatorId,160) || agency, creatorId: clean(creatorId,160), fallbackNow: now });
}

async function dispatchTeamMoneyReconciliationForCanonicalFact({ db = prisma, agencyId, creatorId = null, sourceType, sourceId, now = new Date() } = {}) {
  // Production PostgreSQL publishes from the canonical CreatorSale/CreatorTip trigger in
  // the same transaction. Reduced test doubles do not execute triggers: use DomainWork when
  // available, otherwise preserve the legacy exact reconcile only as compatibility behavior.
  if (typeof db?.$queryRawUnsafe === "function") return { ok: true, triggerOwned: true };
  if (db?.domainWorkItem?.upsert || db?.domainWorkItem?.update) {
    await publishTeamMoneyReconciliationWork({ db, agencyId, creatorId, sourceType, sourceId, now });
    return { ok: true, published: true };
  }
  return String(sourceType || "").toUpperCase() === "TIP"
    ? reconcileCreatorTipToTeam({ db, tipId: sourceId })
    : reconcileCreatorSaleToTeam({ db, saleId: sourceId });
}

async function repairTeamMoneyReconciliationWorkItem({ db = prisma, agencyId, objectType, objectId } = {}) {
  const type = String(objectType || ""); const id = clean(objectId,160); const agency = clean(agencyId,160);
  if (!agency || !id || !["CreatorSale","CreatorTip"].includes(type)) throw Object.assign(new Error("TEAM_MONEY_WORK_IDENTITY_REQUIRED"), { code: "TEAM_MONEY_WORK_IDENTITY_REQUIRED" });
  const row = type === "CreatorSale"
    ? await db.creatorSale.findFirst({ where: { id, agencyId: agency }, select: { id: true } })
    : await db.creatorTip.findFirst({ where: { id, agencyId: agency }, select: { id: true } });
  if (!row) return { ok: true, obsolete: true };
  const result = type === "CreatorSale"
    ? await reconcileCreatorSaleToTeam({ db, saleId: id })
    : await reconcileCreatorTipToTeam({ db, tipId: id });
  return { ...result, obsolete: false };
}


module.exports = {
  REFUND_STATUSES,
  classifySentSource,
  reconcileCreatorSaleToTeam,
  reconcileCreatorSalesToTeam,
  reconcileCreatorTipToTeam,
  reconcileCreatorTipsToTeam,
  reconcileMoneyForSentMessageEvidence,
  publishTeamMoneyReconciliationWork,
  dispatchTeamMoneyReconciliationForCanonicalFact,
  repairTeamMoneyReconciliationWorkItem,
  retireUnattributedNotificationMoney,
};

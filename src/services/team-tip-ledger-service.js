"use strict";

const prisma = require("../prisma");
const { serializableTxOptions } = require("../utils/prisma-transaction");
const { classifySentSource } = require("./team-money-reconciliation-service");

const TIP_ATTRIBUTION_WINDOW_MS = 10 * 60 * 1000;
const TIP_SOFT_REVIEW_WINDOW_MS = 15 * 60 * 1000;
const TIP_CLAIM_GRACE_PERIOD_MS = 48 * 60 * 60 * 1000;
const TIP_LEDGER_RETENTION_DAYS = 180;
const TIP_LEDGER_RETENTION_MS = TIP_LEDGER_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const ATTRIBUTED_TIP_STATUSES = ["attributed", "claimed", "resolved"];
const LEGACY_MIGRATION_REVIEW_SOURCE = "manual_legacy_money_attribution_ambiguous_requires_review";
const CLOSURE6_AUTO_CLASSIFICATION_ACTION = "audit15_closure6_classify_legacy_auto_authority";
const CLOSURE6_AMBIGUOUS_CLASSIFICATION_ACTION = "audit15_closure6_quarantine_ambiguous_legacy_authority";

function clean(value, max = 255) {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, max) : null;
}

function creatorScopeWhere(allowedCreatorIds) {
  if (!Array.isArray(allowedCreatorIds)) return {};
  const ids = Array.from(new Set(allowedCreatorIds.map(String).map((id) => id.trim()).filter(Boolean)));
  return { creatorId: { in: ids.length ? ids : ["__none__"] } };
}

function creatorAllowed(creatorId, allowedCreatorIds) {
  if (!Array.isArray(allowedCreatorIds)) return true;
  const ids = new Set(allowedCreatorIds.map(String).map((id) => id.trim()).filter(Boolean));
  return ids.has(String(creatorId || ""));
}

function activeFinancialWhere() {
  return { OR: [{ financialStatus: null }, { financialStatus: { not: "undo" } }] };
}

function financiallyActive(row) {
  return String(row?.financialStatus || "").trim().toLowerCase() !== "undo";
}

async function findTipLedgerForUpdate(tx, { agencyId, eventHash }) {
  if (typeof tx?.$queryRaw !== "function") {
    if (tx?.teamTipLedger?.findFirst) return tx.teamTipLedger.findFirst({ where: { agencyId, eventHash } });
    if (tx?.teamTipLedger?.findMany) {
      const rows = await tx.teamTipLedger.findMany({ where: { agencyId, eventHash }, take: 1 });
      return rows?.[0] || null;
    }
    return null;
  }
  const rows = await tx.$queryRaw`
    SELECT * FROM "TeamTipLedger"
    WHERE "agencyId" = ${agencyId} AND "eventHash" = ${eventHash}
    FOR UPDATE
    LIMIT 1
  `;
  return rows?.[0] || null;
}

function int(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function safeDate(value, fallback = Date.now()) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return new Date(n);
  const d = new Date(value || fallback);
  return Number.isFinite(d.getTime()) ? d : new Date(fallback);
}

async function resolveMember({ agencyId, memberId, userId }) {
  if (memberId) {
    const direct = await prisma.agencyMember.findFirst({
      where: { agencyId, id: clean(memberId, 160), deletedAt: null },
      select: { id: true, userId: true, displayName: true, role: true, roleKey: true },
    });
    if (direct) return direct;
  }
  if (userId) {
    const byUser = await prisma.agencyMember.findFirst({
      where: { agencyId, userId: clean(userId, 160), deletedAt: null },
      select: { id: true, userId: true, displayName: true, role: true, roleKey: true },
    });
    if (byUser) return byUser;
  }
  return null;
}

function memberDisplay(member) {
  if (!member) return null;
  return member.displayName || member.user?.name || member.user?.email || null;
}

function candidateFromSent(row, receivedAt) {
  if (!row?.memberId) return null;
  const sentAtMs = row.sentAt instanceof Date ? row.sentAt.getTime() : new Date(row.sentAt).getTime();
  const receivedMs = receivedAt instanceof Date ? receivedAt.getTime() : new Date(receivedAt).getTime();
  const ageMs = Number.isFinite(sentAtMs) && Number.isFinite(receivedMs) ? Math.max(0, receivedMs - sentAtMs) : null;
  return {
    memberId: row.memberId,
    userId: row.userId || null,
    deviceId: row.deviceId || null,
    shiftKey: row.shiftKey || null,
    sentAtMs: Number.isFinite(sentAtMs) ? sentAtMs : null,
    ageMinutes: ageMs === null ? null : Math.round(ageMs / 60000),
    source: "team_sent_message_ledger",
  };
}

function mergeCandidates(...inputs) {
  const byMember = new Map();
  const push = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) push(item);
      return;
    }
    if (!value.memberId) return;
    const key = String(value.memberId);
    const prev = byMember.get(key);
    if (!prev) {
      byMember.set(key, { ...value });
      return;
    }
    const prevSent = Number(prev.sentAtMs || 0);
    const nextSent = Number(value.sentAtMs || 0);
    byMember.set(key, nextSent > prevSent ? { ...prev, ...value } : { ...value, ...prev });
  };
  for (const input of inputs) push(input);
  return Array.from(byMember.values()).sort((a, b) => Number(b.sentAtMs || 0) - Number(a.sentAtMs || 0));
}

function historyOf(row) {
  return Array.isArray(row?.history) ? row.history : [];
}

function appendHistory(row, entry) {
  return historyOf(row).concat([{ ts: Date.now(), ...entry }]);
}

function manualResolutionsOf(result) {
  const base = result && typeof result === "object" && !Array.isArray(result) ? result : {};
  return Array.isArray(base.manualResolutions) ? base.manualResolutions : [];
}

function appendManualResolution(result, manualResolution) {
  const base = result && typeof result === "object" && !Array.isArray(result) ? { ...result } : {};
  base.manualResolution = manualResolution;
  base.manualResolutions = manualResolutionsOf(base).concat([manualResolution]);
  return base;
}

function isLocked(row) {
  if (!row) return false;
  const elapsed = Date.now() - new Date(row.receivedAt).getTime();
  return elapsed >= TIP_CLAIM_GRACE_PERIOD_MS;
}

function isLegacyMigrationReviewRow(row) {
  if (!row) return false;
  const result = row?.result && typeof row.result === "object" && !Array.isArray(row.result) ? row.result : {};
  return String(row.resolvedSource || "") === LEGACY_MIGRATION_REVIEW_SOURCE
    || result?.audit15Closure5ManualRepairScan?.requiresManualReview === true
    || result?.audit15Closure6MigrationAuthority?.requiresManualReview === true;
}

function expiresAtMs(row) {
  const received = new Date(row?.receivedAt || 0).getTime();
  return Number.isFinite(received) && received > 0 ? received + TIP_CLAIM_GRACE_PERIOD_MS : null;
}

async function findRecentDialogCandidates({ agencyId, accountId, fanId, dialogId, receivedAt }) {
  const to = safeDate(receivedAt);
  const from = new Date(to.getTime() - TIP_SOFT_REVIEW_WINDOW_MS);
  const ors = [];
  const safeFan = clean(fanId, 160);
  const safeDialog = clean(dialogId, 160);
  if (safeFan) ors.push({ fanId: safeFan }, { dialogId: safeFan });
  if (safeDialog && safeDialog !== safeFan) ors.push({ dialogId: safeDialog }, { fanId: safeDialog });

  const where = {
    agencyId,
    sentAt: { gte: from, lte: to },
    memberId: { not: null },
    ...(clean(accountId, 160) ? { accountId: clean(accountId, 160) } : {}),
    ...(ors.length ? { OR: ors } : {}),
  };

  const rows = await prisma.teamSentMessageLedger.findMany({
    where,
    select: { memberId: true, userId: true, deviceId: true, shiftKey: true, sentAt: true, source: true },
    orderBy: { sentAt: "desc" },
    take: 200,
  }).catch(() => []);

  const candidates = mergeCandidates(rows
    .filter((row) => classifySentSource(row) === "MANUAL")
    .map((row) => candidateFromSent(row, to)));
  const primary = candidates.filter((c) => {
    if (!c.sentAtMs) return false;
    return to.getTime() - Number(c.sentAtMs) <= TIP_ATTRIBUTION_WINDOW_MS;
  });
  const weak = candidates.filter((c) => {
    if (!c.sentAtMs) return false;
    const age = to.getTime() - Number(c.sentAtMs);
    return age > TIP_ATTRIBUTION_WINDOW_MS && age <= TIP_SOFT_REVIEW_WINDOW_MS;
  });
  return { primary, weak };
}

// Audit15: live client tip ingest was retired; canonical CreatorTip reconciliation
// is the only production TeamTipLedger money writer.

async function canActorClaimTip({ agencyId, row, actor }) {
  if (!row || !actor || !financiallyActive(row)) return false;
  if (row.attributedMemberId === actor.id) return true;
  if (String(row.status || "") === "conflict") return false;

  const candidates = mergeCandidates(row.candidates, row.weakCandidates, row.result?.candidates, row.result?.weakCandidates);
  if (candidates.some((c) => c.memberId === actor.id)) return true;

  const { primary, weak } = await findRecentDialogCandidates({
    agencyId,
    accountId: row.accountId,
    fanId: row.fanId,
    dialogId: row.dialogId,
    receivedAt: row.receivedAt,
  });
  return mergeCandidates(primary, weak).some((c) => c.memberId === actor.id);
}

function statusToState(row) {
  const status = String(row?.status || "creator_revenue");
  if (status === "attributed") return "auto";
  if (status === "resolved") return "manager";
  if (status === "creator_revenue") return "creator_revenue";
  return status;
}

function tipRowForClaims(row, membersById = new Map()) {
  if (!row) return null;
  const candidates = mergeCandidates(row.candidates, row.result?.candidates).map((c) => ({
    ...c,
    name: memberDisplay(membersById.get(c.memberId)) || c.name || null,
  }));
  const weakCandidates = mergeCandidates(row.weakCandidates, row.result?.weakCandidates).map((c) => ({
    ...c,
    name: memberDisplay(membersById.get(c.memberId)) || c.name || null,
  }));
  const locked = isLocked(row);
  return {
    id: row.id,
    ledgerType: "tip",
    claimType: "tip_attribution",
    entityType: "tip",
    entityId: row.tipId,
    eventHash: row.eventHash,
    eventType: "tip_received",
    amountCents: row.amountCents,
    currency: row.currency,
    occurredAt: row.receivedAt,
    receivedAt: row.receivedAt,
    accountId: row.accountId,
    creatorId: row.creatorId,
    creatorRef: row.creatorRef,
    fanId: row.fanId,
    dialogId: row.dialogId,
    messageId: row.messageId,
    financialStatus: row.financialStatus || null,
    attributionBasis: row.attributionBasis || null,
    state: statusToState(row),
    status: row.status,
    locked,
    requiresManualReview: isLegacyMigrationReviewRow(row),
    reviewLane: isLegacyMigrationReviewRow(row) ? "migration_ambiguity" : null,
    expiresAt: expiresAtMs(row),
    attributedToMemberId: row.attributedMemberId,
    attributedToUserId: row.attributedUserId,
    autoAttributedToMemberId: row.status === "attributed" ? row.attributedMemberId : null,
    autoAttributedToUserId: row.status === "attributed" ? row.attributedUserId : null,
    autoReason: row.result?.autoReason || row.resolvedSource || null,
    candidates,
    weakCandidates,
    result: row.result || null,
    history: historyOf(row),
    manualResolutions: manualResolutionsOf(row.result),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function enrichTipRows(rows, agencyId) {
  const memberIds = Array.from(new Set((rows || []).flatMap((row) => {
    const candidates = mergeCandidates(row.candidates, row.weakCandidates, row.result?.candidates, row.result?.weakCandidates);
    return [row.attributedMemberId, ...candidates.map((c) => c.memberId)].filter(Boolean);
  })));
  const members = memberIds.length
    ? await prisma.agencyMember.findMany({
        where: { agencyId, id: { in: memberIds }, deletedAt: null },
        include: { user: { select: { id: true, email: true, name: true } } },
        take: 10000}).catch(() => [])
    : [];
  const membersById = new Map(members.map((m) => [m.id, m]));
  return rows.map((row) => tipRowForClaims(row, membersById));
}

async function listTipClaims({ agencyId, limit = 200, actorMemberId = null, senior = false, includeMigrationReview = false, allowedCreatorIds = null }) {
  const cutoff = new Date(Date.now() - TIP_CLAIM_GRACE_PERIOD_MS);
  const safeLimit = Math.min(1000, Math.max(1, int(limit, 200)));
  const baseWhere = { agencyId, ...creatorScopeWhere(allowedCreatorIds) };
  const normalRows = await prisma.teamTipLedger.findMany({
    where: { ...baseWhere, AND: [activeFinancialWhere(), { receivedAt: { gte: cutoff } }] },
    orderBy: { receivedAt: "desc" },
    take: safeLimit,
  }).catch(() => []);
  const reviewRows = includeMigrationReview
    ? await prisma.teamTipLedger.findMany({
        where: {
          ...baseWhere,
          AND: [activeFinancialWhere(), { resolvedSource: LEGACY_MIGRATION_REVIEW_SOURCE }],
        },
        orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
        take: safeLimit,
      }).catch(() => [])
    : [];

  const byId = new Map();
  for (const row of [...reviewRows, ...normalRows]) if (row?.id && !byId.has(row.id)) byId.set(row.id, row);
  let visible = Array.from(byId.values());
  if (!senior) {
    const filtered = [];
    for (const row of visible) {
      if (!actorMemberId) continue;
      if (String(row.status || "") === "conflict") continue;
      if (row.attributedMemberId === actorMemberId) {
        filtered.push(row);
        continue;
      }
      const ok = await canActorClaimTip({ agencyId, row, actor: { id: actorMemberId } });
      if (ok) filtered.push(row);
    }
    visible = filtered;
  }
  visible.sort((a, b) => {
    const reviewOrder = Number(isLegacyMigrationReviewRow(b)) - Number(isLegacyMigrationReviewRow(a));
    if (reviewOrder) return reviewOrder;
    return new Date(b.receivedAt || 0).getTime() - new Date(a.receivedAt || 0).getTime();
  });
  return enrichTipRows(visible.slice(0, safeLimit), agencyId);
}

async function getTipClaimByHash({ agencyId, eventHash, allowedCreatorIds = null }) {
  const row = await prisma.teamTipLedger.findUnique({
    where: { agencyId_eventHash: { agencyId, eventHash: clean(eventHash, 120) } },
  }).catch(() => null);
  if (!row || !creatorAllowed(row.creatorId, allowedCreatorIds)) return null;
  const [enriched] = await enrichTipRows([row], agencyId);
  return enriched || null;
}

async function listTipAudit({ agencyId, memberId = null, from, limit = 500, senior = false, actorMemberId = null, allowedCreatorIds = null }) {
  const where = {
    agencyId,
    ...creatorScopeWhere(allowedCreatorIds),
    ...(from ? { receivedAt: { gte: from } } : {}),
  };
  const rows = await prisma.teamTipLedger.findMany({
    where,
    orderBy: { receivedAt: "desc" },
    take: Math.min(1000, Math.max(1, int(limit, 500))),
  }).catch(() => []);

  let filtered = rows;
  if (memberId) {
    filtered = filtered.filter((row) => row.attributedMemberId === memberId);
  }
  if (!senior) {
    filtered = filtered.filter((row) => row.attributedMemberId === actorMemberId);
  }
  return enrichTipRows(filtered, agencyId);
}

async function createTipClaimNoticeEvents(tx, { agencyId, row, action, selectedMemberId, byMemberId, reason }) {
  const candidates = mergeCandidates(row.candidates, row.weakCandidates, row.result?.candidates, row.result?.weakCandidates);
  const losers = candidates
    .map((c) => c.memberId)
    .filter((id) => id && id !== selectedMemberId);
  const uniqueLosers = Array.from(new Set(losers));
  for (const memberId of uniqueLosers) {
    await tx.teamActivityEvent.create({
      data: {
        agencyId,
        memberId,
        accountId: row.accountId || "unknown",
        creatorId: row.creatorId || null,
        creatorRef: row.creatorRef || null,
        fanId: row.fanId || row.dialogId || null,
        type: "tip_claim_resolution_notice",
        ts: new Date(),
        localId: `tip-notice:${row.id}:${memberId}:${Date.now()}`,
        source: "team_tip_ledger",
        extra: {
          tipLedgerId: row.id,
          eventHash: row.eventHash,
          amountCents: row.amountCents,
          currency: row.currency,
          action,
          assignedMemberId: selectedMemberId || null,
          resolvedByMemberId: byMemberId || null,
          reason: clean(reason, 500),
        },
      },
    }).catch(() => null);
  }
}

async function applyTipOverride({ agencyId, byUserId, byMemberId, eventHash, action, targetMemberId, reason, senior = false, allowedCreatorIds = null }) {
  const safeHash = clean(eventHash, 120);
  const cleanAction = clean(action, 24);
  if (!safeHash) return { ok: false, code: "TIP_NOT_FOUND" };
  if (!cleanAction || !["claim", "release", "manager_override"].includes(cleanAction)) {
    return { ok: false, code: "INVALID_ACTION" };
  }
  if (cleanAction === "manager_override" && String(reason || "").trim().length < 3) {
    return { ok: false, code: "RESOLUTION_REASON_REQUIRED", error: "A reason of at least 3 characters is required" };
  }

  const actor = await resolveMember({ agencyId, memberId: byMemberId, userId: byUserId });
  if (!actor) return { ok: false, code: "ACTOR_NOT_AGENCY_MEMBER" };

  const outcome = await prisma.$transaction(async (tx) => {
    const row = await findTipLedgerForUpdate(tx, { agencyId, eventHash: safeHash });
    if (!row) return { code: "TIP_NOT_FOUND" };
    if (!creatorAllowed(row.creatorId, allowedCreatorIds)) return { code: "CREATOR_ACCESS_FORBIDDEN" };
    if (!financiallyActive(row)) return { code: "TIP_FINANCIAL_REVERSED", error: "This tip was reversed in the financial ledger" };
    const migrationReview = isLegacyMigrationReviewRow(row);
    const historicalManagerReview = cleanAction === "manager_override" && senior && migrationReview;
    if (isLocked(row) && !historicalManagerReview) return { code: "ATTRIBUTION_LOCKED", error: "48-hour grace period elapsed" };

    let nextStatus = row.status;
    let nextOwnerMemberId = row.attributedMemberId;
    let nextOwnerUserId = row.attributedUserId;
    let nextResolvedSource = row.resolvedSource;

    if (cleanAction === "claim") {
      if (String(row.status || "") === "conflict") {
        return { code: "TIP_CONFLICT_MANAGER_REQUIRED", error: "Tip conflicts must be resolved by owner / manager / admin" };
      }
      const eligible = await canActorClaimTip({ agencyId, row, actor });
      if (!eligible) {
        return { code: "CLAIM_NOT_ELIGIBLE", error: "You can claim only tips from dialogs you worked within the 15-minute soft review window" };
      }
      nextStatus = "claimed";
      nextOwnerMemberId = actor.id;
      nextOwnerUserId = actor.userId;
      nextResolvedSource = "manual_chatter_claim";
    } else if (cleanAction === "release") {
      if (row.attributedMemberId !== actor.id) return { code: "NOT_OWNER", error: "Only the current owner can release" };
      nextStatus = "released";
      nextOwnerMemberId = null;
      nextOwnerUserId = null;
      nextResolvedSource = "manual_chatter_release";
    } else if (cleanAction === "manager_override") {
      if (!senior) return { code: "MANAGER_OVERRIDE_FORBIDDEN", error: "Only owner / manager / admin can apply manager_override" };
      if (targetMemberId) {
        const target = await resolveMember({ agencyId, memberId: targetMemberId });
        if (!target) return { code: "TARGET_NOT_AGENCY_MEMBER" };
        nextStatus = "resolved";
        nextOwnerMemberId = target.id;
        nextOwnerUserId = target.userId;
        nextResolvedSource = historicalManagerReview ? "manual_manager_migration_review" : "manual_manager_resolution";
      } else {
        nextStatus = "creator_revenue";
        nextOwnerMemberId = null;
        nextOwnerUserId = null;
        nextResolvedSource = historicalManagerReview ? "manual_manager_migration_review_creator_revenue" : "manual_manager_creator_revenue";
      }
    }

    const manualResolution = {
      manualResolution: true,
      action: cleanAction,
      memberId: nextOwnerMemberId || null,
      reason: clean(reason, 1000),
      resolvedByMemberId: actor.id,
      resolvedAt: new Date().toISOString(),
      migrationReview: historicalManagerReview,
    };
    const result = appendManualResolution(row.result, manualResolution);
    const history = appendHistory(row, {
      action: cleanAction,
      byMemberId: actor.id,
      byUserId: actor.userId,
      reason: clean(reason, 200),
      prevOwner: row.attributedMemberId,
      nextOwner: nextOwnerMemberId,
      source: nextResolvedSource,
      migrationReview: historicalManagerReview,
    });

    const updated = await tx.teamTipLedger.update({
      where: { id: row.id },
      data: {
        status: nextStatus,
        attributedMemberId: nextOwnerMemberId,
        attributedUserId: nextOwnerUserId,
        resolvedAt: ["claimed", "resolved", "released", "creator_revenue"].includes(nextStatus) ? new Date() : row.resolvedAt,
        resolvedByMemberId: actor.id,
        resolvedSource: nextResolvedSource,
        result,
        history,
      },
    });

    if (cleanAction === "manager_override") {
      await createTipClaimNoticeEvents(tx, {
        agencyId,
        row,
        action: cleanAction,
        selectedMemberId: nextOwnerMemberId,
        byMemberId: actor.id,
        reason,
      });
    }

    return { ok: true, row: updated };
  }, serializableTxOptions());

  if (!outcome?.ok) return { ok: false, code: outcome?.code || "TIP_OVERRIDE_FAILED", error: outcome?.error || "Failed" };
  const [attribution] = await enrichTipRows([outcome.row], agencyId);
  return { ok: true, attribution };
}

function legacyStateToTipStatus(row) {
  const state = String(row?.state || "").toLowerCase();
  if (state === "auto" && row?.attributedToMemberId) return "attributed";
  if (state === "claimed" && row?.attributedToMemberId) return "claimed";
  if (state === "manager" && row?.attributedToMemberId) return "resolved";
  // Legacy release means the current owner gave up the tip. If legacy logic
  // reverted it to another auto owner, keep it claimable for that owner;
  // otherwise it becomes creator revenue and is not counted for chatters.
  if (state === "released" && row?.attributedToMemberId) return "claimed";
  if (state === "released") return "creator_revenue";
  return "creator_revenue";
}

function legacyManualHistory(row) {
  const history = Array.isArray(row?.history) ? row.history : [];
  return history
    .filter((item) => ["claim", "release", "manager_override"].includes(String(item?.action || "")))
    .sort((a, b) => Number(a?.ts || 0) - Number(b?.ts || 0));
}

function legacyManualAuthority(row) {
  const state = String(row?.state || "").trim().toLowerCase();
  const manualHistory = legacyManualHistory(row);
  const latest = manualHistory[manualHistory.length - 1] || null;
  const manual = ["claimed", "manager", "released"].includes(state) || manualHistory.length > 0;
  const rawTs = latest?.ts || row?.lockedAt || row?.updatedAt || row?.occurredAt || row?.createdAt || Date.now();
  const resolvedAt = safeDate(rawTs);
  const action = String(latest?.action || state || "manual").trim().toLowerCase();
  let memberId = clean(row?.attributedToMemberId, 160);
  let userId = clean(row?.attributedToUserId, 160);
  let status = legacyStateToTipStatus(row);
  if (latest) {
    const nextOwner = clean(latest?.nextOwner, 160);
    if (action === "claim") { memberId = nextOwner || memberId; status = memberId ? "claimed" : "unresolved"; }
    else if (action === "manager_override") { memberId = nextOwner; status = memberId ? "resolved" : "creator_revenue"; }
    else if (action === "release") { memberId = nextOwner; status = memberId ? "claimed" : "released"; }
    if (memberId !== clean(row?.attributedToMemberId, 160)) userId = null;
  }
  const source = manual
    ? `manual_legacy_money_attribution_${action || "resolution"}`
    : "legacy_money_attribution_migration";
  return {
    manual, action, source, resolvedAt, status, memberId, userId,
    resolvedByMemberId: clean(latest?.byMemberId, 160),
    manualHistory,
  };
}

function legacyAuthorityClassification(row) {
  const manualAuthority = legacyManualAuthority(row);
  if (manualAuthority.manual) return { kind: "manual", manualAuthority };
  const state = String(row?.state || "").trim().toLowerCase();
  if (state === "auto") return { kind: "auto", manualAuthority };
  return { kind: "ambiguous", manualAuthority };
}

function canonicalManualAuthority(row) {
  return String(row?.resolvedSource || "").startsWith("manual_");
}

function canonicalManualAt(row) {
  return safeDate(row?.resolvedAt || row?.updatedAt || row?.createdAt || 0, 0).getTime();
}

function legacyTipResult(row) {
  const classification = legacyAuthorityClassification(row);
  const authority = classification.manualAuthority;
  const manualResolutions = authority.manualHistory.map((item) => ({
    manualResolution: true,
    action: item.action,
    memberId: item.nextOwner || null,
    reason: item.reason || null,
    resolvedByMemberId: item.byMemberId || null,
    resolvedAt: item.ts ? new Date(item.ts).toISOString() : null,
    migratedFromLegacyHistory: true,
  }));
  if (classification.kind === "manual" && manualResolutions.length === 0) {
    manualResolutions.push({
      manualResolution: true,
      action: authority.action,
      memberId: authority.memberId || null,
      reason: `Recovered state-only legacy manual authority (${String(row?.state || "manual").toLowerCase()})`,
      resolvedByMemberId: authority.resolvedByMemberId || null,
      resolvedAt: authority.resolvedAt?.toISOString?.() || null,
      migratedFromLegacyState: true,
    });
  }
  return {
    claimType: "tip_attribution",
    migratedFrom: "MoneyAttribution",
    migratedAt: new Date().toISOString(),
    legacyAttributionId: row?.id || null,
    legacyState: row?.state || null,
    legacyAutoReason: row?.autoReason || null,
    manualAuthority: classification.kind === "manual",
    audit15Closure6MigrationAuthority: {
      classified: true,
      classification: classification.kind === "manual"
        ? "legacy_manual_authority"
        : classification.kind === "auto"
          ? "proven_legacy_auto"
          : "ambiguous_legacy_authority_requires_review",
      requiresManualReview: classification.kind === "ambiguous",
      classifiedAt: new Date().toISOString(),
      source: "audit15_closure6_runtime_migration",
    },
    attributionWindowMinutes: 10,
    softReviewWindowMinutes: 15,
    candidates: row?.autoAttributedToMemberId ? [{
      memberId: row.autoAttributedToMemberId,
      userId: row.autoAttributedToUserId || null,
      sentAtMs: null,
      ageMinutes: null,
      source: row.autoReason || "legacy_money_attribution_auto",
    }] : [],
    weakCandidates: [],
    autoReason: row?.autoReason || "legacy_money_attribution_migration",
    manualResolutions,
  };
}

function legacyTipHistory(row) {
  const original = Array.isArray(row?.history) ? row.history : [];
  const classification = legacyAuthorityClassification(row);
  const authority = classification.manualAuthority;
  const classificationEntry = classification.kind === "manual"
    ? {
        ts: Date.now(),
        action: "audit15_closure6_classify_legacy_manual_authority",
        classification: "legacy_manual_authority",
        legacyAction: authority.action || null,
        prevOwner: row?.attributedToMemberId || null,
        nextOwner: authority.memberId || null,
        source: "audit15_closure6_runtime_migration",
      }
    : classification.kind === "auto"
      ? {
          ts: Date.now(),
          action: CLOSURE6_AUTO_CLASSIFICATION_ACTION,
          classification: "proven_legacy_auto",
          prevOwner: row?.attributedToMemberId || null,
          nextOwner: row?.attributedToMemberId || null,
          source: "audit15_closure6_runtime_migration",
        }
      : {
          ts: Date.now(),
          action: CLOSURE6_AMBIGUOUS_CLASSIFICATION_ACTION,
          classification: "ambiguous_legacy_authority_requires_review",
          prevOwner: row?.attributedToMemberId || null,
          nextOwner: null,
          source: LEGACY_MIGRATION_REVIEW_SOURCE,
        };
  return original.concat([{
    ts: Date.now(),
    action: "migrate_legacy_tip_to_team_tip_ledger",
    reason: "MoneyAttribution tip_received moved to TeamTipLedger before 180-day retention cleanup",
    prevOwner: row?.attributedToMemberId || null,
    nextOwner: row?.attributedToMemberId || null,
    source: "v16_1_legacy_tip_migration",
    legacyAttributionId: row?.id || null,
  }, classificationEntry]);
}

function legacyTipCreateData(row) {
  const classification = legacyAuthorityClassification(row);
  const authority = classification.manualAuthority;
  const status = classification.kind === "ambiguous"
    ? "conflict"
    : classification.kind === "manual" ? authority.status : legacyStateToTipStatus(row);
  const attributedMemberId = classification.kind === "ambiguous"
    ? null
    : classification.kind === "manual"
      ? (ATTRIBUTED_TIP_STATUSES.includes(status) ? authority.memberId : null)
      : (ATTRIBUTED_TIP_STATUSES.includes(status) ? row.attributedToMemberId : null);
  const result = legacyTipResult(row);
  const candidates = Array.isArray(result.candidates) ? result.candidates : [];
  return {
    agencyId: row.agencyId,
    accountId: clean(row.accountId, 160) || "unknown",
    creatorId: row.creatorId || null,
    creatorRef: null,
    eventHash: row.eventHash,
    tipId: clean(row.eventHash, 220) || row.id,
    messageId: null,
    dialogId: row.fanId || null,
    fanId: row.fanId || null,
    amountCents: int(row.amountCents, 0),
    currency: clean(row.currency, 8) || "USD",
    receivedAt: row.occurredAt,
    status,
    attributedMemberId,
    attributedUserId: attributedMemberId ? (classification.kind === "manual" ? authority.userId : row.attributedToUserId) : null,
    attributedShiftKey: null,
    resolvedAt: classification.kind === "manual" ? authority.resolvedAt : (attributedMemberId ? (row.lockedAt || row.updatedAt || row.occurredAt) : null),
    resolvedByMemberId: classification.kind === "manual" ? authority.resolvedByMemberId : null,
    resolvedSource: classification.kind === "ambiguous" ? LEGACY_MIGRATION_REVIEW_SOURCE : authority.source,
    candidates,
    weakCandidates: [],
    result,
    history: legacyTipHistory(row),
    source: "legacy_money_attribution_migration",
    createdAt: row.createdAt || row.capturedAt || row.occurredAt,
  };
}

function legacyAlreadyRepresented(row, legacyRow) {
  return (Array.isArray(row?.history) ? row.history : []).some((item) =>
    String(item?.legacyAttributionId || "") === String(legacyRow?.id || "")
      && String(item?.action || "") === "migrate_legacy_tip_to_team_tip_ledger"
  );
}

function mergeLegacyResult(existing, legacyRow) {
  const current = existing?.result && typeof existing.result === "object" ? existing.result : {};
  const incoming = legacyTipResult(legacyRow);
  const manualResolutions = [
    ...(Array.isArray(current.manualResolutions) ? current.manualResolutions : []),
    ...(Array.isArray(incoming.manualResolutions) ? incoming.manualResolutions : []),
  ];
  return {
    ...current,
    legacyMigration: incoming,
    manualResolutions,
  };
}

function mergeLegacyHistory(existing, legacyRow) {
  return [
    ...(Array.isArray(existing?.history) ? existing.history : []),
    ...legacyTipHistory(legacyRow),
  ];
}

async function mergeLegacyManualAuthority(tx, existing, legacyRow) {
  const authority = legacyManualAuthority(legacyRow);
  if (!authority.manual || legacyAlreadyRepresented(existing, legacyRow)) {
    return { row: existing, manualMerged: false };
  }
  const incoming = legacyTipCreateData(legacyRow);
  const existingManual = canonicalManualAuthority(existing);
  const incomingWins = !existingManual || authority.resolvedAt.getTime() > canonicalManualAt(existing);
  const data = {
    result: mergeLegacyResult(existing, legacyRow),
    history: mergeLegacyHistory(existing, legacyRow),
    ...(incomingWins ? {
      status: incoming.status,
      attributedMemberId: incoming.attributedMemberId,
      attributedUserId: incoming.attributedUserId,
      attributedShiftKey: null,
      resolvedAt: incoming.resolvedAt,
      resolvedByMemberId: incoming.resolvedByMemberId,
      resolvedSource: incoming.resolvedSource,
    } : {}),
  };
  const row = await tx.teamTipLedger.update({ where: { id: existing.id }, data });
  return { row, manualMerged: incomingWins };
}

function hasClosure6LegacyClassification(row, legacyRow, action) {
  return (Array.isArray(row?.history) ? row.history : []).some((item) =>
    String(item?.action || "") === action
      && (!legacyRow?.id || String(item?.legacyAttributionId || "") === String(legacyRow.id))
  );
}

async function mergeLegacyNonManualClassification(tx, existing, legacyRow) {
  const classification = legacyAuthorityClassification(legacyRow);
  if (classification.kind === "manual") return { row: existing, classificationMerged: false };
  const action = classification.kind === "auto" ? CLOSURE6_AUTO_CLASSIFICATION_ACTION : CLOSURE6_AMBIGUOUS_CLASSIFICATION_ACTION;
  if (hasClosure6LegacyClassification(existing, legacyRow, action)) return { row: existing, classificationMerged: false };

  const currentResult = existing?.result && typeof existing.result === "object" && !Array.isArray(existing.result)
    ? { ...existing.result }
    : {};
  currentResult.audit15Closure6MigrationAuthority = {
    classified: true,
    classification: classification.kind === "auto" ? "proven_legacy_auto" : "ambiguous_legacy_authority_requires_review",
    requiresManualReview: classification.kind === "ambiguous",
    classifiedAt: new Date().toISOString(),
    source: "audit15_closure6_runtime_migration",
    legacyAttributionId: legacyRow?.id || null,
  };
  const history = Array.isArray(existing?.history) ? [...existing.history] : [];
  history.push({
    ts: Date.now(),
    action,
    classification: classification.kind === "auto" ? "proven_legacy_auto" : "ambiguous_legacy_authority_requires_review",
    legacyAttributionId: legacyRow?.id || null,
    prevOwner: existing?.attributedMemberId || null,
    nextOwner: classification.kind === "ambiguous" ? null : (existing?.attributedMemberId || null),
    source: classification.kind === "ambiguous" ? LEGACY_MIGRATION_REVIEW_SOURCE : "audit15_closure6_runtime_migration",
  });

  const data = classification.kind === "auto" || canonicalManualAuthority(existing)
    ? { result: currentResult, history }
    : {
        status: "conflict",
        attributedMemberId: null,
        attributedUserId: null,
        attributedShiftKey: null,
        resolvedAt: null,
        resolvedByMemberId: null,
        resolvedSource: LEGACY_MIGRATION_REVIEW_SOURCE,
        result: currentResult,
        history,
      };
  const row = await tx.teamTipLedger.update({ where: { id: existing.id }, data });
  return { row, classificationMerged: true };
}

async function findExistingTipHashesForLegacyRows(tx, legacyRows) {
  const groups = new Map();
  for (const row of legacyRows || []) {
    if (!row?.agencyId || !row?.eventHash) continue;
    const list = groups.get(row.agencyId) || [];
    list.push(row.eventHash);
    groups.set(row.agencyId, list);
  }

  const existing = new Set();
  for (const [agencyId, hashes] of groups.entries()) {
    const uniqueHashes = Array.from(new Set(hashes));
    for (let i = 0; i < uniqueHashes.length; i += 1000) {
      const chunk = uniqueHashes.slice(i, i + 1000);
      const rows = await tx.teamTipLedger.findMany({
        where: { agencyId, eventHash: { in: chunk } },
        select: { agencyId: true, eventHash: true },
        take: 10000});
      for (const row of rows || []) existing.add(`${row.agencyId}|${row.eventHash}`);
    }
  }
  return existing;
}

async function selectLegacyTipsForMigration(tx, { agencyId, cutoff, limit }) {
  const safeLimit = Math.min(5000, Math.max(1, int(limit, 1000)));
  if (typeof tx?.$queryRawUnsafe !== "function") {
    return tx.moneyAttribution.findMany({
      where: { eventType: "tip_received", occurredAt: { gte: cutoff }, ...(agencyId ? { agencyId } : {}) },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }], take: safeLimit,
    });
  }
  if (agencyId) {
    return tx.$queryRawUnsafe(`
      SELECT *
      FROM "MoneyAttribution"
      WHERE "eventType" = $1
        AND "occurredAt" >= $2
        AND "agencyId" = $3
      ORDER BY "occurredAt" ASC, "id" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT $4
    `, "tip_received", cutoff, agencyId, safeLimit);
  }
  return tx.$queryRawUnsafe(`
    SELECT *
    FROM "MoneyAttribution"
    WHERE "eventType" = $1
      AND "occurredAt" >= $2
    ORDER BY "occurredAt" ASC, "id" ASC
    FOR UPDATE SKIP LOCKED
    LIMIT $3
  `, "tip_received", cutoff, safeLimit);
}

async function lockLegacyMoneyMigrationTable(tx) {
  // Audit15 Closure5: serialize every runtime legacy migrator with the historical
  // deployment cutover before either side acquires Money row / TeamTip row locks.
  // SHARE ROW EXCLUSIVE conflicts with itself, so runtime/runtime and
  // runtime/deployment overlap stop at the first authority instead of forming a
  // Money-row -> Team-row -> Money-delete lock cycle.
  if (typeof tx?.$executeRawUnsafe === "function") {
    await tx.$executeRawUnsafe('LOCK TABLE "MoneyAttribution" IN SHARE ROW EXCLUSIVE MODE');
  }
}

async function migrateLegacyTipsToTipLedger({ agencyId = null, limit = 1000, retentionDays = TIP_LEDGER_RETENTION_DAYS, dryRun = false, deleteLegacy = true } = {}) {
  const cleanAgency = clean(agencyId, 160);
  const safeLimit = Math.min(5000, Math.max(1, int(limit, 1000)));
  const safeRetentionDays = Math.max(1, int(retentionDays, TIP_LEDGER_RETENTION_DAYS));
  const cutoff = new Date(Date.now() - safeRetentionDays * 24 * 60 * 60 * 1000);

  try {
    return await prisma.$transaction(async (tx) => {
      await lockLegacyMoneyMigrationTable(tx);
      // Audit15 Closure3: the legacy row and any existing canonical TeamTip row
      // are both locked before precedence is decided. A committed legacy MANUAL
      // resolution can therefore never be deleted merely because an older AUTO
      // TeamTipLedger row already exists.
      const legacyRows = await selectLegacyTipsForMigration(tx, {
        agencyId: cleanAgency,
        cutoff,
        limit: safeLimit,
      });
      const scanned = legacyRows.length;
      if (scanned === 0) {
        return {
          ok: true, scanned: 0, migrated: 0, manualMerged: 0, skippedExisting: 0,
          deletedLegacy: 0, failed: 0, errors: [], retentionDays: safeRetentionDays,
          cutoff, dryRun: Boolean(dryRun), deleteLegacy: Boolean(deleteLegacy), batched: true,
        };
      }

      const createData = legacyRows.map(legacyTipCreateData);
      if (dryRun) {
        return {
          ok: true, scanned, migrated: createData.length, manualMerged: 0,
          skippedExisting: 0, deletedLegacy: 0, failed: 0, errors: [],
          retentionDays: safeRetentionDays, cutoff, dryRun: true,
          deleteLegacy: Boolean(deleteLegacy), batched: true,
        };
      }

      let createdCount = 0;
      if (createData.length) {
        const created = await tx.teamTipLedger.createMany({ data: createData, skipDuplicates: true });
        createdCount = created.count || 0;
      }

      const representedIds = [];
      let manualMerged = 0;
      let skippedExisting = 0;
      const errors = [];
      for (const legacyRow of legacyRows) {
        let canonical = await findTipLedgerForUpdate(tx, { agencyId: legacyRow.agencyId, eventHash: legacyRow.eventHash });
        if (!canonical) {
          errors.push({ id: legacyRow.id, eventHash: legacyRow.eventHash, error: "TeamTipLedger representation missing after createMany" });
          continue;
        }
        const alreadyLegacy = legacyAlreadyRepresented(canonical, legacyRow);
        const classification = legacyAuthorityClassification(legacyRow);
        if (classification.kind === "manual" && !alreadyLegacy) {
          const merged = await mergeLegacyManualAuthority(tx, canonical, legacyRow);
          canonical = merged.row;
          if (merged.manualMerged) manualMerged += 1;
          else skippedExisting += 1;
        } else if (classification.kind !== "manual") {
          const merged = await mergeLegacyNonManualClassification(tx, canonical, legacyRow);
          canonical = merged.row;
          if (!merged.classificationMerged && !alreadyLegacy && canonical.source !== "legacy_money_attribution_migration") skippedExisting += 1;
        } else if (!alreadyLegacy && canonical.source !== "legacy_money_attribution_migration") {
          skippedExisting += 1;
        }
        representedIds.push(legacyRow.id);
      }

      let deletedLegacy = 0;
      if (deleteLegacy && representedIds.length) {
        const deleted = await tx.moneyAttribution.deleteMany({ where: { id: { in: representedIds } } });
        deletedLegacy = deleted.count || 0;
      }

      return {
        ok: errors.length === 0,
        scanned,
        migrated: createdCount + manualMerged,
        manualMerged,
        skippedExisting,
        deletedLegacy,
        failed: errors.length,
        errors,
        retentionDays: safeRetentionDays,
        cutoff,
        dryRun: false,
        deleteLegacy: Boolean(deleteLegacy),
        batched: true,
      };
    }, serializableTxOptions());
  } catch (err) {
    return {
      ok: false, scanned: 0, migrated: 0, manualMerged: 0, skippedExisting: 0, deletedLegacy: 0, failed: 0,
      errors: [{ error: err?.message || String(err) }], retentionDays: safeRetentionDays,
      cutoff, dryRun: Boolean(dryRun), deleteLegacy: Boolean(deleteLegacy), batched: true,
    };
  }
}


function isLegacyMigratedTipRow(row) {
  const source = String(row?.source || "");
  const resolvedSource = String(row?.resolvedSource || "");
  const result = row?.result && typeof row.result === "object" && !Array.isArray(row.result) ? row.result : {};
  const history = Array.isArray(row?.history) ? row.history : [];
  return source.includes("legacy_money_attribution_migration")
    || resolvedSource.includes("legacy_money_attribution_migration")
    || result.migratedFrom === "MoneyAttribution"
    || Boolean(result.legacyMigration)
    || history.some((item) => [
      "migrate_legacy_tip_to_team_tip_ledger",
      "audit15_migrate_legacy_tip_to_team_tip_ledger",
    ].includes(String(item?.action || "")));
}

function legacyStateFromCanonicalRow(row) {
  const result = row?.result && typeof row.result === "object" && !Array.isArray(row.result) ? row.result : {};
  return String(result?.legacyState || result?.legacyMigration?.legacyState || "").trim().toLowerCase();
}

function legacyStateManualEvidence(row) {
  const state = legacyStateFromCanonicalRow(row);
  if (!["claimed", "manager", "released"].includes(state)) return null;
  const action = state === "claimed" ? "claim" : state === "manager" ? "manager_override" : "release";
  // Closure2 preserved the current owner tuple for state-only legacy rows.
  // A claimed row without an owner is internally inconsistent and therefore
  // cannot be reconstructed automatically; it will be quarantined below.
  const memberId = clean(row?.attributedMemberId, 160);
  if (state === "claimed" && !memberId) return null;
  const rawAt = row?.resolvedAt || row?.result?.migratedAt || row?.updatedAt || row?.receivedAt || row?.createdAt || Date.now();
  return {
    action,
    memberId,
    resolvedByMemberId: null,
    resolvedAt: safeDate(rawAt),
    reason: `Recovered state-only legacy manual authority (${state})`,
    sourceRank: 0,
    ordinal: 0,
    stateOnly: true,
  };
}

function closure5RepairClassification(row) {
  const result = row?.result && typeof row.result === "object" && !Array.isArray(row.result) ? row.result : {};
  const closure6 = result?.audit15Closure6MigrationAuthority;
  if (closure6 && closure6.classified === true) return String(closure6.classification || "classified");
  const history = Array.isArray(row?.history) ? row.history : [];
  const durable = history.find((item) => [
    CLOSURE6_AUTO_CLASSIFICATION_ACTION,
    CLOSURE6_AMBIGUOUS_CLASSIFICATION_ACTION,
  ].includes(String(item?.action || "")));
  return durable ? String(durable?.classification || durable?.action || "classified") : null;
}

function canonicalLegacyManualEvidence(row) {
  if (!isLegacyMigratedTipRow(row)) return null;
  const result = row?.result && typeof row.result === "object" && !Array.isArray(row.result) ? row.result : {};
  const events = [];
  let ordinal = 0;
  const push = ({ action, memberId, resolvedByMemberId, resolvedAt, reason, sourceRank = 0 }) => {
    const normalizedAction = String(action || "").trim().toLowerCase();
    if (!["claim", "release", "manager_override"].includes(normalizedAction)) return;
    ordinal += 1;
    const parsed = resolvedAt ? safeDate(resolvedAt, 0) : null;
    const ts = parsed && parsed.getTime() > 0 ? parsed.getTime() : 0;
    events.push({
      action: normalizedAction,
      memberId: clean(memberId, 160),
      resolvedByMemberId: clean(resolvedByMemberId, 160),
      resolvedAt: ts > 0 ? new Date(ts) : null,
      reason: clean(reason, 1000),
      sourceRank,
      ordinal,
    });
  };

  const resultManual = [
    ...(Array.isArray(result.manualResolutions) ? result.manualResolutions : []),
    ...(result.manualResolution ? [result.manualResolution] : []),
    ...(Array.isArray(result?.legacyMigration?.manualResolutions) ? result.legacyMigration.manualResolutions : []),
  ];
  for (const item of resultManual) {
    push({
      action: item?.action,
      memberId: item?.memberId,
      resolvedByMemberId: item?.resolvedByMemberId,
      resolvedAt: item?.resolvedAt,
      reason: item?.reason,
      sourceRank: 2,
    });
  }

  for (const item of Array.isArray(row?.history) ? row.history : []) {
    push({
      action: item?.action,
      memberId: item?.nextOwner,
      resolvedByMemberId: item?.byMemberId,
      resolvedAt: item?.ts,
      reason: item?.reason,
      sourceRank: 1,
    });
  }

  if (!events.length) return legacyStateManualEvidence(row);
  events.sort((a, b) => {
    const at = a.resolvedAt?.getTime?.() || 0;
    const bt = b.resolvedAt?.getTime?.() || 0;
    return at - bt || a.sourceRank - b.sourceRank || a.ordinal - b.ordinal;
  });
  return events[events.length - 1];
}

function legacyProvenAutoEvidence(row) {
  if (!isLegacyMigratedTipRow(row)) return false;
  const state = legacyStateFromCanonicalRow(row);
  if (state === "auto") return true;
  const result = row?.result && typeof row.result === "object" && !Array.isArray(row.result) ? row.result : {};
  if (String(result?.audit15Closure6MigrationAuthority?.classification || "") === "proven_legacy_auto") return true;
  const history = Array.isArray(row?.history) ? row.history : [];
  return history.some((item) => [
    "audit15_closure5_classify_legacy_auto_no_manual_evidence",
    CLOSURE6_AUTO_CLASSIFICATION_ACTION,
  ].includes(String(item?.action || "")));
}

function repairedManualStatus(evidence) {
  if (!evidence) return "creator_revenue";
  if (evidence.action === "claim") return evidence.memberId ? "claimed" : "unresolved";
  if (evidence.action === "manager_override") return evidence.memberId ? "resolved" : "creator_revenue";
  if (evidence.action === "release") return evidence.memberId ? "claimed" : "released";
  return "creator_revenue";
}

async function selectMigratedTipRowsForManualRepair(tx, { agencyId, limit }) {
  const safeLimit = Math.min(5000, Math.max(1, int(limit, 1000)));
  const eligible = (row) => isLegacyMigratedTipRow(row)
    && !canonicalManualAuthority(row)
    && !closure5RepairClassification(row);
  if (typeof tx?.$queryRawUnsafe !== "function") {
    const rows = await tx.teamTipLedger.findMany({
      where: agencyId ? { agencyId } : {},
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: Math.min(20000, safeLimit * 4),
    });
    return (rows || []).filter(eligible).slice(0, safeLimit);
  }
  const originSql = `(
      "resolvedSource" IN ('legacy_money_attribution_migration','audit15_legacy_money_attribution_migration')
      OR "source" IN ('legacy_money_attribution_migration','audit15_legacy_money_attribution_migration')
      OR COALESCE("result"->>'migratedFrom','') = 'MoneyAttribution'
      OR ("result" ? 'legacyMigration')
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE("history", '[]'::jsonb)) h(item)
        WHERE h.item->>'action' IN ('migrate_legacy_tip_to_team_tip_ledger','audit15_migrate_legacy_tip_to_team_tip_ledger')
      )
    )`;
  const pendingSql = `
      LEFT(COALESCE("resolvedSource", ''), 7) <> 'manual_'
      AND COALESCE("result"->'audit15Closure5ManualRepairScan'->>'classified', 'false') <> 'true'
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE("history", '[]'::jsonb)) c5(item)
        WHERE c5.item->>'action' IN (
          'audit15_closure6_classify_legacy_auto_authority',
          'audit15_closure6_quarantine_ambiguous_legacy_authority'
        )
      )`;
  if (agencyId) {
    return tx.$queryRawUnsafe(`
      SELECT * FROM "TeamTipLedger"
      WHERE "agencyId" = $1 AND ${originSql} AND ${pendingSql}
      ORDER BY "updatedAt" ASC, "id" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT $2
    `, agencyId, safeLimit);
  }
  return tx.$queryRawUnsafe(`
    SELECT * FROM "TeamTipLedger"
    WHERE ${originSql} AND ${pendingSql}
    ORDER BY "updatedAt" ASC, "id" ASC
    FOR UPDATE SKIP LOCKED
    LIMIT $1
  `, safeLimit);
}

async function repairMigratedLegacyTipManualAuthority({ agencyId = null, limit = 1000, dryRun = false } = {}) {
  const cleanAgency = clean(agencyId, 160);
  const safeLimit = Math.min(5000, Math.max(1, int(limit, 1000)));
  try {
    return await prisma.$transaction(async (tx) => {
      const rows = await selectMigratedTipRowsForManualRepair(tx, { agencyId: cleanAgency, limit: safeLimit });
      let repaired = 0;
      let alreadyManual = 0;
      let classifiedAuto = 0;
      let ambiguous = 0;
      const errors = [];

      for (const row of rows) {
        if (canonicalManualAuthority(row)) {
          alreadyManual += 1;
          continue;
        }
        const evidence = canonicalLegacyManualEvidence(row);
        if (evidence) {
          if (dryRun) { repaired += 1; continue; }

          let attributedUserId = null;
          if (evidence.memberId && tx?.agencyMember?.findFirst) {
            const member = await tx.agencyMember.findFirst({
              where: { agencyId: row.agencyId, id: evidence.memberId },
              select: { userId: true },
            });
            attributedUserId = clean(member?.userId, 160);
          }
          const resolvedAt = evidence.resolvedAt || safeDate(row.updatedAt || row.receivedAt || Date.now());
          const suffix = evidence.stateOnly ? `state_${legacyStateFromCanonicalRow(row)}` : evidence.action;
          const resolvedSource = `manual_legacy_money_attribution_forward_repair_${suffix}`;
          const currentResult = row?.result && typeof row.result === "object" && !Array.isArray(row.result) ? { ...row.result } : {};
          currentResult.audit15Closure4ManualRepair = {
            repaired: true, action: evidence.action, memberId: evidence.memberId || null,
            resolvedByMemberId: evidence.resolvedByMemberId || null, resolvedAt: resolvedAt.toISOString(),
            source: "audit15_closure5_forward_repair", stateOnly: Boolean(evidence.stateOnly),
          };
          currentResult.audit15Closure5ManualRepairScan = {
            classified: true, classification: evidence.stateOnly ? "state_only_manual_repaired" : "manual_repaired",
            classifiedAt: new Date().toISOString(),
          };
          const history = Array.isArray(row?.history) ? [...row.history] : [];
          history.push({
            ts: Date.now(), action: "audit15_closure5_repair_migrated_manual_authority",
            reason: evidence.stateOnly
              ? `Recovered durable manual authority from legacyState=${legacyStateFromCanonicalRow(row)}`
              : "Recovered durable manual authority from canonical migrated history after legacy MoneyAttribution removal",
            prevOwner: row.attributedMemberId || null, nextOwner: evidence.memberId || null, source: resolvedSource,
          });
          try {
            await tx.teamTipLedger.update({
              where: { id: row.id },
              data: {
                status: repairedManualStatus(evidence),
                attributedMemberId: evidence.memberId || null,
                attributedUserId,
                attributedShiftKey: null,
                resolvedAt,
                resolvedByMemberId: evidence.resolvedByMemberId || null,
                resolvedSource,
                result: currentResult,
                history,
              },
            });
            repaired += 1;
          } catch (err) {
            errors.push({ id: row.id, eventHash: row.eventHash, error: err?.message || String(err) });
          }
          continue;
        }

        const legacyState = legacyStateFromCanonicalRow(row);
        if (legacyProvenAutoEvidence(row)) {
          classifiedAuto += 1;
          if (!dryRun) {
            const currentResult = row?.result && typeof row.result === "object" && !Array.isArray(row.result) ? { ...row.result } : {};
            currentResult.audit15Closure5ManualRepairScan = {
              classified: true, classification: "legacy_auto_no_manual_evidence", classifiedAt: new Date().toISOString(),
            };
            currentResult.audit15Closure6MigrationAuthority = {
              classified: true, classification: "proven_legacy_auto", requiresManualReview: false,
              classifiedAt: new Date().toISOString(), source: "audit15_closure6_runtime_repair",
            };
            const history = Array.isArray(row?.history) ? [...row.history] : [];
            history.push({
              ts: Date.now(), action: "audit15_closure5_classify_legacy_auto_no_manual_evidence",
              classification: "legacy_auto_no_manual_evidence",
              reason: "Legacy state proves AUTO and contains no MANUAL authority evidence",
              source: "audit15_closure5_runtime_repair",
            });
            history.push({
              ts: Date.now(), action: CLOSURE6_AUTO_CLASSIFICATION_ACTION,
              classification: "proven_legacy_auto",
              reason: "Legacy authority was proven AUTO before mutable projection metadata could be replaced",
              source: "audit15_closure6_runtime_repair",
            });
            await tx.teamTipLedger.update({ where: { id: row.id }, data: { result: currentResult, history } });
          }
          continue;
        }

        // Historical evidence was destroyed before Closure5. We cannot prove
        // whether the prior owner was AUTO or MANUAL, so fail closed: remove any
        // chatter attribution, freeze automatic reconciliation with a manual_*
        // source, and surface the row as conflict for explicit manager review.
        ambiguous += 1;
        if (!dryRun) {
          const currentResult = row?.result && typeof row.result === "object" && !Array.isArray(row.result) ? { ...row.result } : {};
          currentResult.audit15Closure5ManualRepairScan = {
            classified: true, classification: "ambiguous_legacy_authority_requires_review",
            classifiedAt: new Date().toISOString(), requiresManualReview: true,
          };
          currentResult.audit15Closure6MigrationAuthority = {
            classified: true, classification: "ambiguous_legacy_authority_requires_review",
            classifiedAt: new Date().toISOString(), requiresManualReview: true, source: "audit15_closure6_runtime_repair",
          };
          const history = Array.isArray(row?.history) ? [...row.history] : [];
          history.push({
            ts: Date.now(), action: "audit15_closure5_quarantine_ambiguous_legacy_authority",
            reason: "Legacy migration provenance is insufficient to distinguish historical AUTO from MANUAL authority",
            prevOwner: row.attributedMemberId || null, nextOwner: null,
            source: LEGACY_MIGRATION_REVIEW_SOURCE,
          });
          history.push({
            ts: Date.now(), action: CLOSURE6_AMBIGUOUS_CLASSIFICATION_ACTION,
            classification: "ambiguous_legacy_authority_requires_review",
            reason: "Historical legacy authority remains ambiguous and requires explicit senior review",
            prevOwner: row.attributedMemberId || null, nextOwner: null,
            source: LEGACY_MIGRATION_REVIEW_SOURCE,
          });
          await tx.teamTipLedger.update({
            where: { id: row.id },
            data: {
              status: "conflict", attributedMemberId: null, attributedUserId: null, attributedShiftKey: null,
              resolvedAt: null, resolvedByMemberId: null,
              resolvedSource: "manual_legacy_money_attribution_ambiguous_requires_review",
              result: currentResult, history,
            },
          });
        }
      }

      return {
        ok: errors.length === 0, scanned: rows.length, repaired, alreadyManual, classifiedAuto, ambiguous,
        noManualEvidence: classifiedAuto + ambiguous, failed: errors.length, errors, dryRun: Boolean(dryRun),
      };
    }, serializableTxOptions());
  } catch (err) {
    return {
      ok: false, scanned: 0, repaired: 0, alreadyManual: 0, classifiedAuto: 0, ambiguous: 0, noManualEvidence: 0, failed: 1,
      errors: [{ error: err?.message || String(err) }], dryRun: Boolean(dryRun),
    };
  }
}

async function purgeExpiredTipLedger({ agencyId = null, retentionDays = TIP_LEDGER_RETENTION_DAYS, limit = 5000, dryRun = false } = {}) {
  const cleanAgency = clean(agencyId, 160);
  const safeRetentionDays = Math.max(1, int(retentionDays, TIP_LEDGER_RETENTION_DAYS));
  const safeLimit = Math.min(20000, Math.max(1, int(limit, 5000)));
  const cutoff = new Date(Date.now() - safeRetentionDays * 24 * 60 * 60 * 1000);

  const where = {
    receivedAt: { lt: cutoff },
    ...(cleanAgency ? { agencyId: cleanAgency } : {}),
  };

  const rows = await prisma.teamTipLedger.findMany({
    where,
    select: { id: true },
    orderBy: { receivedAt: "asc" },
    take: safeLimit,
  }).catch(() => []);

  if (dryRun || rows.length === 0) {
    return { ok: true, deleted: dryRun ? 0 : rows.length, matched: rows.length, retentionDays: safeRetentionDays, cutoff, dryRun: Boolean(dryRun) };
  }

  const result = await prisma.teamTipLedger.deleteMany({
    where: { id: { in: rows.map((row) => row.id) } },
  });
  return { ok: true, deleted: result.count, matched: rows.length, retentionDays: safeRetentionDays, cutoff, dryRun: false };
}

module.exports = {
  TIP_ATTRIBUTION_WINDOW_MS,
  TIP_SOFT_REVIEW_WINDOW_MS,
  TIP_CLAIM_GRACE_PERIOD_MS,
  TIP_LEDGER_RETENTION_DAYS,
  TIP_LEDGER_RETENTION_MS,
  ATTRIBUTED_TIP_STATUSES,
  applyTipOverride,
  listTipClaims,
  getTipClaimByHash,
  listTipAudit,
  migrateLegacyTipsToTipLedger,
  repairMigratedLegacyTipManualAuthority,
  purgeExpiredTipLedger,
  tipRowForClaims,
};

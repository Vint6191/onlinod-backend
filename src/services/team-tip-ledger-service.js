"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { serializableTxOptions } = require("../utils/prisma-transaction");
const { classifySentSource } = require("./team-money-reconciliation-service");

const TIP_ATTRIBUTION_WINDOW_MS = 10 * 60 * 1000;
const TIP_SOFT_REVIEW_WINDOW_MS = 15 * 60 * 1000;
const TIP_CLAIM_GRACE_PERIOD_MS = 48 * 60 * 60 * 1000;
const TIP_LEDGER_RETENTION_DAYS = 180;
const TIP_LEDGER_RETENTION_MS = TIP_LEDGER_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const ATTRIBUTED_TIP_STATUSES = ["attributed", "claimed", "resolved"];

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

function asAmountCents(payload) {
  const dollars = Number(payload?.amount ?? payload?.priceDollars ?? payload?.amountDollars ?? 0);
  if (!Number.isFinite(dollars) || dollars <= 0) return 0;
  return Math.round(dollars * 100);
}

function safeDate(value, fallback = Date.now()) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return new Date(n);
  const d = new Date(value || fallback);
  return Number.isFinite(d.getTime()) ? d : new Date(fallback);
}

function buildTipSemanticId({ tipId, messageId, notificationId, toastId, targetUrl } = {}) {
  return clean(tipId, 120) ||
    clean(messageId, 120) ||
    clean(notificationId, 120) ||
    clean(toastId, 120) ||
    clean(targetUrl, 500) ||
    "";
}

function hashTipSeed({ agencyId, accountId, fanId, receivedAt, amountCents, semanticId, eventType = "tip_received" } = {}) {
  const seed = [
    String(agencyId || ""),
    String(accountId || ""),
    String(fanId || ""),
    String(eventType || ""),
    String(amountCents || 0),
    semanticId || "",
    Math.floor(Number(receivedAt) / 1000),
  ].join("|");
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 40);
}

function hashTipEvent({
  agencyId,
  accountId,
  fanId,
  receivedAt,
  amountCents,
  eventHash,
  tipId,
  messageId,
  notificationId,
  toastId,
  targetUrl,
} = {}) {
  const explicit = clean(eventHash, 120);
  if (explicit) return explicit;

  return hashTipSeed({
    agencyId,
    accountId,
    fanId,
    receivedAt,
    amountCents,
    eventType: "tip_received",
    semanticId: buildTipSemanticId({ tipId, messageId, notificationId, toastId, targetUrl }),
  });
}

function candidateTipHashes({
  agencyId,
  accountId,
  fanId,
  receivedAt,
  amountCents,
  eventHash,
  tipId,
  messageId,
  notificationId,
  toastId,
  targetUrl,
} = {}) {
  const semanticId = buildTipSemanticId({ tipId, messageId, notificationId, toastId, targetUrl });
  const hashes = [
    clean(eventHash, 120),
    hashTipSeed({ agencyId, accountId, fanId, receivedAt, amountCents, semanticId, eventType: "tip_received" }),
    // Compatibility with early v16 builds where the TeamTipLedger seed used
    // the shorter event type. This prevents one real tip becoming two rows
    // when old/new workers report the same payload around a deploy.
    hashTipSeed({ agencyId, accountId, fanId, receivedAt, amountCents, semanticId, eventType: "tip" }),
  ].filter(Boolean);
  return Array.from(new Set(hashes));
}

async function resolveCreator({ agencyId, payload }) {
  const accountId = clean(payload?.accountId, 160);
  if (accountId) {
    const byId = await prisma.creatorAccount.findFirst({
      where: { agencyId, id: accountId, deletedAt: null },
      select: { id: true, username: true },
    }).catch(() => null);
    if (byId) return byId;
  }

  const username = clean(payload?.creatorRef, 160)?.replace(/^@/, "");
  if (username) {
    const byUsername = await prisma.creatorAccount.findFirst({
      where: { agencyId, username, deletedAt: null },
      select: { id: true, username: true },
    }).catch(() => null);
    if (byUsername) return byUsername;
  }
  return null;
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

async function findExactTipMessageCandidate({ agencyId, creatorId, accountId, messageId }) {
  const safeMessageId = clean(messageId, 160);
  if (!safeMessageId) return { sent: null, sourceClass: "UNKNOWN", member: null };
  let sent = null;
  if (creatorId) {
    sent = await prisma.teamSentMessageLedger.findFirst({
      where: { agencyId, creatorId, messageId: safeMessageId },
      orderBy: { sentAt: "asc" },
    }).catch(() => null);
  }
  if (!sent && accountId) {
    sent = await prisma.teamSentMessageLedger.findFirst({
      where: { agencyId, accountId, messageId: safeMessageId, OR: [{ creatorId: null }, ...(creatorId ? [{ creatorId }] : [])] },
      orderBy: { sentAt: "asc" },
    }).catch(() => null);
  }
  const sourceClass = classifySentSource(sent);
  const member = sourceClass === "MANUAL" && sent?.memberId
    ? await resolveMember({ agencyId, memberId: sent.memberId, userId: sent.userId })
    : null;
  return { sent, sourceClass, member };
}

function fallbackWeakCandidateFromPayload({ payload, receivedAt }) {
  const memberId = clean(payload?.autoAttributedToMemberId, 160);
  if (!memberId) return null;
  return {
    memberId,
    userId: clean(payload?.autoAttributedToUserId, 160),
    deviceId: clean(payload?.deviceId, 160),
    shiftKey: clean(payload?.shiftKey, 220),
    sentAtMs: null,
    ageMinutes: null,
    source: clean(payload?.autoReason, 80) || "electron_auto_legacy_soft_only",
    note: "Not auto-counted: backend could not verify a 10-minute sent-message ledger match.",
    receivedAtMs: safeDate(receivedAt).getTime(),
  };
}

async function ingestTipEvent({ agencyId, userId, payload }) {
  const amountCents = asAmountCents(payload);
  if (amountCents <= 0) return { ok: false, code: "ZERO_AMOUNT" };

  const receivedAt = safeDate(payload?.ts || payload?.occurredAt);
  const accountId = clean(payload?.accountId, 160);
  const fanId = clean(payload?.fanId, 160);
  const dialogId = clean(payload?.dialogId, 160) || fanId;
  if (!accountId || !fanId) return { ok: false, code: "MISSING_IDENTIFIERS" };

  const tipHashCandidates = candidateTipHashes({
    agencyId,
    accountId,
    fanId,
    receivedAt: receivedAt.getTime(),
    amountCents,
    eventHash: payload?.eventHash,
    tipId: payload?.tipId || payload?.tip_id,
    messageId: payload?.messageId,
    notificationId: payload?.notificationId,
    toastId: payload?.toastId,
    targetUrl: payload?.targetUrl,
  });
  const eventHash = tipHashCandidates[0];

  const existing = await prisma.teamTipLedger.findFirst({
    where: { agencyId, eventHash: { in: tipHashCandidates } },
  }).catch(() => null);
  if (existing) return { ok: true, deduped: true, attribution: tipRowForClaims(existing) };

  // Cross-version dedupe: if v15/v16.0 stored the same tip under a different
  // compatible hash, do not write a second revenue row. Sweep/backfill will
  // migrate that legacy row into TeamTipLedger in batch.
  const legacyExisting = await prisma.moneyAttribution.findFirst({
    where: { agencyId, eventType: "tip_received", eventHash: { in: tipHashCandidates } },
  }).catch(() => null);
  if (legacyExisting) {
    return { ok: true, deduped: true, legacy: true, attribution: legacyExisting };
  }

  const creator = await resolveCreator({ agencyId, payload });
  const exact = await findExactTipMessageCandidate({
    agencyId, creatorId: creator?.id || clean(payload?.creatorId, 160), accountId, messageId: payload?.messageId,
  });
  const { primary, weak } = await findRecentDialogCandidates({ agencyId, accountId, fanId, dialogId, receivedAt });
  const fallbackWeak = fallbackWeakCandidateFromPayload({ payload, receivedAt });
  const exactCandidate = exact.member && exact.sent ? candidateFromSent(exact.sent, receivedAt) : null;
  const candidates = mergeCandidates(exactCandidate, primary);
  const weakCandidates = mergeCandidates(weak, primary.length ? [] : fallbackWeak);

  // Exact message provenance may auto-attribute. Recent-message timing is only
  // evidence for Claims and is never enough to count chatter revenue by itself.
  let status = "unresolved";
  let attributedMemberId = null;
  let attributedUserId = null;
  let attributedShiftKey = null;
  let resolvedSource = "tip_unresolved_no_exact_message";
  let autoReason = "no_exact_message_provenance";

  if (exact.sourceClass === "MANUAL" && exact.member) {
    status = "attributed";
    attributedMemberId = exact.member.id;
    attributedUserId = exact.member.userId || exact.sent?.userId || null;
    attributedShiftKey = exact.sent?.shiftKey || null;
    resolvedSource = "tip_exact_message_manual";
    autoReason = "exact_message_manual";
  } else if (exact.sourceClass === "NON_HUMAN") {
    status = "creator_revenue";
    resolvedSource = "tip_exact_message_non_human";
    autoReason = "exact_message_non_human";
  } else if (primary.length > 1) {
    status = "conflict";
    resolvedSource = "tip_recent_candidates_conflict";
    autoReason = "multiple_recent_candidates_evidence_only";
  } else if (primary.length === 1) {
    autoReason = "single_recent_candidate_evidence_only";
  }

  const result = {
    claimType: "tip_attribution",
    attributionMode: "exact_message_first",
    attributionWindowMinutes: 10,
    softReviewWindowMinutes: 15,
    candidates,
    weakCandidates,
    autoReason,
  };

  const history = [{
    ts: Date.now(),
    action: status === "attributed" ? "exact_auto_attribution" : (status === "conflict" ? "evidence_conflict" : (status === "creator_revenue" ? "exact_non_human_creator_revenue" : "unresolved_evidence")),
    reason: autoReason,
    prevOwner: null,
    nextOwner: attributedMemberId,
    source: "team_tip_ledger_ingest",
    byUserId: userId || null,
  }];

  const created = await prisma.teamTipLedger.create({
    data: {
      agencyId,
      accountId,
      creatorId: creator?.id || null,
      creatorRef: clean(payload?.creatorRef, 160) || creator?.username || null,
      eventHash,
      tipId: clean(payload?.tipId || payload?.tip_id || payload?.notificationId || payload?.toastId || eventHash, 220),
      messageId: clean(payload?.messageId, 160),
      dialogId,
      fanId,
      amountCents,
      currency: clean(payload?.currency, 8) || "USD",
      receivedAt,
      status,
      attributedMemberId,
      attributedUserId,
      attributedShiftKey,
      resolvedAt: ["attributed", "creator_revenue"].includes(status) ? new Date() : null,
      resolvedSource,
      attributionBasis: autoReason,
      candidates,
      weakCandidates,
      result,
      history,
      source: clean(payload?.source, 80) || "claims_ingest",
    },
  });

  return { ok: true, deduped: false, attribution: tipRowForClaims(created) };
}

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

async function listTipClaims({ agencyId, limit = 200, actorMemberId = null, senior = false, allowedCreatorIds = null }) {
  const cutoff = new Date(Date.now() - TIP_CLAIM_GRACE_PERIOD_MS);
  const rows = await prisma.teamTipLedger.findMany({
    where: {
      agencyId,
      ...creatorScopeWhere(allowedCreatorIds),
      ...activeFinancialWhere(),
      receivedAt: { gte: cutoff },
    },
    orderBy: { receivedAt: "desc" },
    take: Math.min(1000, Math.max(1, int(limit, 200))),
  }).catch(() => []);

  let visible = rows;
  if (!senior) {
    visible = [];
    for (const row of rows) {
      if (!actorMemberId) continue;
      if (String(row.status || "") === "conflict") continue;
      if (row.attributedMemberId === actorMemberId) {
        visible.push(row);
        continue;
      }
      const ok = await canActorClaimTip({ agencyId, row, actor: { id: actorMemberId } });
      if (ok) visible.push(row);
    }
  }
  return enrichTipRows(visible.slice(0, Math.min(1000, Math.max(1, int(limit, 200)))), agencyId);
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
    if (isLocked(row)) return { code: "ATTRIBUTION_LOCKED", error: "48-hour grace period elapsed" };

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
        nextResolvedSource = "manual_manager_resolution";
      } else {
        nextStatus = "creator_revenue";
        nextOwnerMemberId = null;
        nextOwnerUserId = null;
        nextResolvedSource = "manual_manager_creator_revenue";
      }
    }

    const manualResolution = {
      manualResolution: true,
      action: cleanAction,
      memberId: nextOwnerMemberId || null,
      reason: clean(reason, 1000),
      resolvedByMemberId: actor.id,
      resolvedAt: new Date().toISOString(),
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

function legacyTipResult(row) {
  const history = Array.isArray(row?.history) ? row.history : [];
  return {
    claimType: "tip_attribution",
    migratedFrom: "MoneyAttribution",
    migratedAt: new Date().toISOString(),
    legacyAttributionId: row?.id || null,
    legacyState: row?.state || null,
    legacyAutoReason: row?.autoReason || null,
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
    manualResolutions: history.filter((item) => ["claim", "release", "manager_override"].includes(String(item?.action || ""))).map((item) => ({
      manualResolution: true,
      action: item.action,
      memberId: item.nextOwner || null,
      reason: item.reason || null,
      resolvedByMemberId: item.byMemberId || null,
      resolvedAt: item.ts ? new Date(item.ts).toISOString() : null,
      migratedFromLegacyHistory: true,
    })),
  };
}

function legacyTipHistory(row) {
  const original = Array.isArray(row?.history) ? row.history : [];
  return original.concat([{
    ts: Date.now(),
    action: "migrate_legacy_tip_to_team_tip_ledger",
    reason: "MoneyAttribution tip_received moved to TeamTipLedger before 180-day retention cleanup",
    prevOwner: row?.attributedToMemberId || null,
    nextOwner: row?.attributedToMemberId || null,
    source: "v16_1_legacy_tip_migration",
  }]);
}

function legacyTipCreateData(row) {
  const status = legacyStateToTipStatus(row);
  const attributedMemberId = ATTRIBUTED_TIP_STATUSES.includes(status) ? row.attributedToMemberId : null;
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
    attributedUserId: attributedMemberId ? row.attributedToUserId : null,
    attributedShiftKey: null,
    resolvedAt: attributedMemberId ? (row.lockedAt || row.updatedAt || row.occurredAt) : null,
    resolvedByMemberId: null,
    resolvedSource: "legacy_money_attribution_migration",
    candidates,
    weakCandidates: [],
    result,
    history: legacyTipHistory(row),
    source: "legacy_money_attribution_migration",
    createdAt: row.createdAt || row.capturedAt || row.occurredAt,
  };
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

async function migrateLegacyTipsToTipLedger({ agencyId = null, limit = 1000, retentionDays = TIP_LEDGER_RETENTION_DAYS, dryRun = false, deleteLegacy = true } = {}) {
  const cleanAgency = clean(agencyId, 160);
  const safeLimit = Math.min(5000, Math.max(1, int(limit, 1000)));
  const safeRetentionDays = Math.max(1, int(retentionDays, TIP_LEDGER_RETENTION_DAYS));
  const cutoff = new Date(Date.now() - safeRetentionDays * 24 * 60 * 60 * 1000);

  const where = {
    eventType: "tip_received",
    occurredAt: { gte: cutoff },
    ...(cleanAgency ? { agencyId: cleanAgency } : {}),
  };

  const legacyRows = await prisma.moneyAttribution.findMany({
    where,
    orderBy: { occurredAt: "asc" },
    take: safeLimit,
  }).catch(() => []);

  const scanned = legacyRows.length;
  if (scanned === 0) {
    return {
      ok: true,
      scanned: 0,
      migrated: 0,
      skippedExisting: 0,
      deletedLegacy: 0,
      failed: 0,
      errors: [],
      retentionDays: safeRetentionDays,
      cutoff,
      dryRun: Boolean(dryRun),
      deleteLegacy: Boolean(deleteLegacy),
      batched: true,
    };
  }

  try {
    const existingHashes = await findExistingTipHashesForLegacyRows(prisma, legacyRows);
    const seenInBatch = new Set();
    const existingLegacyIds = [];
    const rowsToCreate = [];
    const createData = [];

    for (const row of legacyRows) {
      const key = `${row.agencyId}|${row.eventHash}`;
      if (existingHashes.has(key)) {
        existingLegacyIds.push(row.id);
        continue;
      }
      if (seenInBatch.has(key)) {
        existingLegacyIds.push(row.id);
        continue;
      }
      seenInBatch.add(key);
      rowsToCreate.push(row);
      createData.push(legacyTipCreateData(row));
    }

    if (dryRun) {
      return {
        ok: true,
        scanned,
        migrated: createData.length,
        skippedExisting: existingLegacyIds.length,
        deletedLegacy: 0,
        failed: 0,
        errors: [],
        retentionDays: safeRetentionDays,
        cutoff,
        dryRun: true,
        deleteLegacy: Boolean(deleteLegacy),
        batched: true,
      };
    }

    const result = await prisma.$transaction(async (tx) => {
      let createdCount = 0;
      if (createData.length) {
        const created = await tx.teamTipLedger.createMany({ data: createData, skipDuplicates: true });
        createdCount = created.count || 0;
      }

      // Verify by the same unique key Prisma enforces: (agencyId, eventHash).
      // This avoids cross-agency false positives when sweep runs without an
      // agencyId filter, even though hash collisions are practically impossible.
      const presentHashes = await findExistingTipHashesForLegacyRows(tx, legacyRows);

      const legacyIdsToDelete = deleteLegacy
        ? legacyRows
            .filter((row) => presentHashes.has(`${row.agencyId}|${row.eventHash}`))
            .map((row) => row.id)
        : [];

      let deletedLegacy = 0;
      if (legacyIdsToDelete.length) {
        const deleted = await tx.moneyAttribution.deleteMany({ where: { id: { in: legacyIdsToDelete } } });
        deletedLegacy = deleted.count || 0;
      }

      return {
        createdCount,
        deletedLegacy,
        skippedExisting: existingLegacyIds.length,
        failedCreateCount: Math.max(0, rowsToCreate.length - createdCount),
      };
    }, serializableTxOptions());

    return {
      ok: result.failedCreateCount === 0,
      scanned,
      migrated: result.createdCount,
      skippedExisting: result.skippedExisting,
      deletedLegacy: result.deletedLegacy,
      failed: result.failedCreateCount,
      errors: result.failedCreateCount ? [{ error: "createMany inserted fewer rows than expected; legacy rows not present in TeamTipLedger were preserved" }] : [],
      retentionDays: safeRetentionDays,
      cutoff,
      dryRun: false,
      deleteLegacy: Boolean(deleteLegacy),
      batched: true,
    };
  } catch (err) {
    return {
      ok: false,
      scanned,
      migrated: 0,
      skippedExisting: 0,
      deletedLegacy: 0,
      failed: scanned,
      errors: [{ error: err?.message || String(err) }],
      retentionDays: safeRetentionDays,
      cutoff,
      dryRun: Boolean(dryRun),
      deleteLegacy: Boolean(deleteLegacy),
      batched: true,
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
  ingestTipEvent,
  applyTipOverride,
  listTipClaims,
  getTipClaimByHash,
  listTipAudit,
  migrateLegacyTipsToTipLedger,
  purgeExpiredTipLedger,
  tipRowForClaims,
};

"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");

// --------------------------------------------------------------------
// Constants — these MUST match electron/team-claims/claim-rules.js or
// auto/manual attribution will diverge between client and server.
// --------------------------------------------------------------------
const ATTRIBUTION_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours
const GRACE_PERIOD_MS = 48 * 60 * 60 * 1000;      // 48 hours after the money event

const MONEY_EVENT_TYPES = new Set([
  "tip_received",
  "ppv_purchase_received",
  "subscription_created",
]);

// PPV attribution moved to TeamPpvPurchaseLedger / TeamPpvResolveJob.
// Keep MoneyAttribution only for legacy non-PPV money types until tips/subs
// get their own ledger.
const LEGACY_CLAIMABLE_EVENT_TYPES = new Set([
  "tip_received",
  "subscription_created",
]);

const ALLOWED_ACTIONS = new Set(["claim", "release", "manager_override"]);

// --------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------

function cleanString(value, max = 200) {
  const s = String(value || "").trim();
  return s ? s.slice(0, max) : null;
}

function hashEvent({
  agencyId,
  accountId,
  fanId,
  occurredAt,
  eventType,
  amountCents,
  eventHash,
  messageId,
  purchaseMessageId,
  notificationId,
  toastId,
  targetUrl,
} = {}) {
  // Best identity: websocket-listener eventHash, because PPV purchases can
  // share account/fan/amount/second. We still include agency in the seed via
  // the DB unique (agencyId,eventHash), so the same OF event in two agencies
  // cannot collide in storage.
  const explicit = cleanString(eventHash, 120);
  if (explicit) return explicit;

  const semanticId =
    cleanString(purchaseMessageId, 120) ||
    cleanString(messageId, 120) ||
    cleanString(notificationId, 120) ||
    cleanString(toastId, 120) ||
    cleanString(targetUrl, 500) ||
    "";

  const seed = [
    String(agencyId || ""),
    String(accountId || ""),
    String(fanId || ""),
    String(eventType || ""),
    String(amountCents || 0),
    semanticId,
    Math.floor(Number(occurredAt) / 1000),
  ].join("|");
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 40);
}

function asAmountCents(payload) {
  // Electron sends amount in dollars (Number). Convert to cents.
  const dollars = Number(payload.amount ?? payload.priceDollars ?? payload.amountDollars ?? 0);
  if (!Number.isFinite(dollars) || dollars <= 0) return 0;
  return Math.round(dollars * 100);
}

function safeDate(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return new Date(n);
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : new Date();
}

function isLocked(row) {
  if (!row) return false;
  if (row.locked) return true;
  const elapsed = Date.now() - new Date(row.occurredAt).getTime();
  return elapsed >= GRACE_PERIOD_MS;
}

function pushHistory(row, entry) {
  const history = Array.isArray(row.history) ? row.history : [];
  history.push({
    ts: Date.now(),
    ...entry,
  });
  return history;
}

// --------------------------------------------------------------------
// Resolve creator & member ids (mirrors telemetry-ingest-service)
// --------------------------------------------------------------------

async function resolveCreator({ agencyId, payload }) {
  const candidates = [];
  if (payload.accountId) candidates.push({ id: cleanString(payload.accountId, 160) });
  if (payload.creatorRef) candidates.push({ username: cleanString(payload.creatorRef, 160).replace(/^@/, "") });
  for (const where of candidates) {
    if (!where || (!where.id && !where.username)) continue;
    try {
      const creator = await prisma.creatorAccount.findFirst({
        where: { agencyId, deletedAt: null, ...where },
        select: { id: true, username: true },
      });
      if (creator) return creator;
    } catch (_) {}
  }
  return null;
}

async function resolveMember({ agencyId, memberId, userId }) {
  if (memberId) {
    const direct = await prisma.agencyMember.findFirst({
      where: { agencyId, id: cleanString(memberId, 160), deletedAt: null },
      select: { id: true, userId: true },
    });
    if (direct) return direct;
  }
  if (userId) {
    const byUser = await prisma.agencyMember.findFirst({
      where: { agencyId, userId: cleanString(userId, 160), deletedAt: null },
      select: { id: true, userId: true },
    });
    if (byUser) return byUser;
  }
  return null;
}

function isLegacyClaimableEventType(eventType) {
  return LEGACY_CLAIMABLE_EVENT_TYPES.has(String(eventType || ""));
}

async function memberHadRecentDialogWork({ agencyId, row, memberId }) {
  if (!agencyId || !row || !memberId || !row.occurredAt) return false;

  const occurredAt = new Date(row.occurredAt);
  const occurredMs = occurredAt.getTime();
  if (!Number.isFinite(occurredMs)) return false;

  const from = new Date(occurredMs - ATTRIBUTION_WINDOW_MS);
  const fanOrDialog = cleanString(row.fanId, 160);
  const accountId = cleanString(row.accountId, 160);

  const and = [];
  if (accountId) and.push({ accountId });
  if (fanOrDialog) {
    and.push({
      OR: [
        { fanId: fanOrDialog },
        { dialogId: fanOrDialog },
      ],
    });
  }

  const match = await prisma.teamSentMessageLedger.findFirst({
    where: {
      agencyId,
      memberId,
      sentAt: { gte: from, lte: occurredAt },
      ...(and.length ? { AND: and } : {}),
    },
    select: { id: true },
  }).catch(() => null);

  return Boolean(match);
}

async function canActorClaimAttribution({ agencyId, row, actor }) {
  if (!row || !actor) return false;
  if (!isLegacyClaimableEventType(row.eventType)) return false;

  // Current/auto owner can safely claim/release; otherwise require proof
  // that this member actually worked this dialog shortly before the money event.
  if (row.attributedToMemberId === actor.id) return true;
  if (row.autoAttributedToMemberId === actor.id) return true;

  return memberHadRecentDialogWork({ agencyId, row, memberId: actor.id });
}

// --------------------------------------------------------------------
// Ingest a money event from Electron and apply auto-attribution
// --------------------------------------------------------------------
//
// Electron computes auto-attribution locally using its own event log
// (because that's where "who messaged this fan in the last 2h" lives).
// The backend just stores what it sends. If two Electrons report the
// same event with different auto-attribution (race condition between
// chatters' instances) — first write wins, subsequent reports are
// idempotent on eventHash.

async function ingestMoneyEvent({ agencyId, userId, payload }) {
  const eventType = cleanString(payload?.type, 80);
  if (!eventType || !MONEY_EVENT_TYPES.has(eventType)) {
    return { ok: false, code: "INVALID_EVENT_TYPE" };
  }

  if (!isLegacyClaimableEventType(eventType)) {
    return {
      ok: true,
      ignored: true,
      code: "PPV_MOVED_TO_TEAM_PPV_LEDGER",
      message: "PPV attribution is handled by TeamPpvPurchaseLedger / TeamPpvResolveJob",
    };
  }

  const amountCents = asAmountCents(payload);
  if (amountCents <= 0) {
    return { ok: false, code: "ZERO_AMOUNT" };
  }

  const occurredAt = safeDate(payload.ts || payload.occurredAt);
  const accountId = cleanString(payload.accountId, 160);
  const fanId = cleanString(payload.fanId, 160);

  if (!accountId || !fanId) {
    return { ok: false, code: "MISSING_IDENTIFIERS" };
  }

  const eventHash = hashEvent({
    agencyId,
    accountId,
    fanId,
    occurredAt: occurredAt.getTime(),
    eventType,
    amountCents,
    eventHash: payload.eventHash,
    messageId: payload.messageId,
    purchaseMessageId: payload.purchaseMessageId,
    notificationId: payload.notificationId,
    toastId: payload.toastId,
    targetUrl: payload.targetUrl,
  });

  // Already exists? Idempotent — return current row.
  const existing = await prisma.moneyAttribution.findUnique({
    where: { agencyId_eventHash: { agencyId, eventHash } },
  });

  if (existing) {
    return { ok: true, deduped: true, attribution: existing };
  }

  // Resolve creator and the auto-attributed member (sent by Electron).
  const creator = await resolveCreator({ agencyId, payload });
  const autoMember = await resolveMember({
    agencyId,
    memberId: payload.autoAttributedToMemberId,
    userId: payload.autoAttributedToUserId,
  });

  const initialState = autoMember ? "auto" : "unattributed";
  const initialHistory = [{
    ts: Date.now(),
    action: "auto_attribution",
    reason: cleanString(payload.autoReason, 80) || (autoMember ? "last_outgoing_within_2h" : "no_message_in_window"),
    prevOwner: null,
    nextOwner: autoMember?.id || null,
    source: "electron_ingest",
    byUserId: userId || null,
  }];

  const created = await prisma.moneyAttribution.create({
    data: {
      agencyId,
      eventHash,
      eventType,
      amountCents,
      currency: cleanString(payload.currency, 8) || "USD",
      occurredAt,
      creatorId: creator?.id || null,
      accountId,
      fanId,
      state: initialState,
      attributedToMemberId: autoMember?.id || null,
      attributedToUserId: autoMember?.userId || null,
      autoAttributedToMemberId: autoMember?.id || null,
      autoAttributedToUserId: autoMember?.userId || null,
      autoReason: cleanString(payload.autoReason, 80) || null,
      history: initialHistory,
    },
  });

  return { ok: true, deduped: false, attribution: created };
}

// --------------------------------------------------------------------
// Apply a manual override (claim / release / manager_override)
// --------------------------------------------------------------------

async function applyOverride({ agencyId, byUserId, byMemberId, eventHash, action, targetMemberId, reason }) {
  const cleanAction = cleanString(action, 24);
  if (!cleanAction || !ALLOWED_ACTIONS.has(cleanAction)) {
    return { ok: false, code: "INVALID_ACTION" };
  }

  const row = await prisma.moneyAttribution.findUnique({
    where: { agencyId_eventHash: { agencyId, eventHash: cleanString(eventHash, 80) } },
  });

  if (!row) {
    return { ok: false, code: "ATTRIBUTION_NOT_FOUND" };
  }

  if (!isLegacyClaimableEventType(row.eventType)) {
    return {
      ok: false,
      code: "PPV_CLAIMS_MOVED_TO_LEDGER",
      error: "PPV attribution conflicts must be resolved through /api/team/analytics/ppv/conflicts",
    };
  }

  if (isLocked(row)) {
    return { ok: false, code: "ATTRIBUTION_LOCKED", error: "48-hour grace period elapsed" };
  }

  // Resolve actor (the chatter / manager performing the action).
  const actor = await resolveMember({ agencyId, memberId: byMemberId, userId: byUserId });
  if (!actor) {
    return { ok: false, code: "ACTOR_NOT_AGENCY_MEMBER" };
  }

  let nextOwnerMemberId = row.attributedToMemberId;
  let nextOwnerUserId = row.attributedToUserId;
  let nextState = row.state;

  if (cleanAction === "claim") {
    const eligible = await canActorClaimAttribution({ agencyId, row, actor });
    if (!eligible) {
      return {
        ok: false,
        code: "CLAIM_NOT_ELIGIBLE",
        error: "You can claim only tips/subscriptions from dialogs you worked in the attribution window",
      };
    }
    nextOwnerMemberId = actor.id;
    nextOwnerUserId = actor.userId;
    nextState = "claimed";
  } else if (cleanAction === "release") {
    // Owner gives up the money. Goes back to auto-attribution if
    // someone was eligible there, otherwise unattributed.
    if (row.attributedToMemberId !== actor.id) {
      return { ok: false, code: "NOT_OWNER", error: "Only the current owner can release" };
    }
    nextOwnerMemberId = row.autoAttributedToMemberId !== actor.id
      ? row.autoAttributedToMemberId
      : null;
    nextOwnerUserId = row.autoAttributedToUserId !== actor.userId
      ? row.autoAttributedToUserId
      : null;
    nextState = nextOwnerMemberId ? "released" : "unattributed";
  } else if (cleanAction === "manager_override") {
    // Manager / owner sets the attribution to anyone (or null).
    // Authorisation is enforced at the route level (requireManager).
    if (targetMemberId) {
      const target = await resolveMember({ agencyId, memberId: targetMemberId });
      if (!target) {
        return { ok: false, code: "TARGET_NOT_AGENCY_MEMBER" };
      }
      nextOwnerMemberId = target.id;
      nextOwnerUserId = target.userId;
    } else {
      nextOwnerMemberId = null;
      nextOwnerUserId = null;
    }
    nextState = "manager";
  }

  const newHistory = pushHistory(row, {
    action: cleanAction,
    byMemberId: actor.id,
    byUserId: actor.userId,
    reason: cleanString(reason, 200),
    prevOwner: row.attributedToMemberId,
    nextOwner: nextOwnerMemberId,
    source: "manual_override",
  });

  const updated = await prisma.moneyAttribution.update({
    where: { id: row.id },
    data: {
      state: nextState,
      attributedToMemberId: nextOwnerMemberId,
      attributedToUserId: nextOwnerUserId,
      history: newHistory,
    },
  });

  return { ok: true, attribution: updated };
}

// --------------------------------------------------------------------
// List money events still in the dispute window (any agency member
// can call this — it's intentionally agency-wide so the team has
// full visibility).
// --------------------------------------------------------------------

async function listDisputable({ agencyId, range = "24h", limit = 200, actorMemberId = null, senior = false }) {
  const cutoff = new Date(Date.now() - GRACE_PERIOD_MS);
  const where = {
    agencyId,
    eventType: { in: Array.from(LEGACY_CLAIMABLE_EVENT_TYPES) },
    occurredAt: { gte: cutoff },
    locked: false,
  };

  if (!senior) {
    const ownId = cleanString(actorMemberId, 160);
    if (!ownId) return [];
    where.OR = [
      { attributedToMemberId: ownId },
      { autoAttributedToMemberId: ownId },
    ];
  }

  const rows = await prisma.moneyAttribution.findMany({
    where,
    orderBy: { occurredAt: "desc" },
    take: Math.min(500, Math.max(1, Number(limit) || 200)),
  });

  // Decorate with locked status (some may have crossed 48h since query).
  const now = Date.now();
  return rows.map((row) => ({
    ...row,
    locked: row.locked || (now - new Date(row.occurredAt).getTime() >= GRACE_PERIOD_MS),
    expiresAt: new Date(new Date(row.occurredAt).getTime() + GRACE_PERIOD_MS),
  }));
}

// --------------------------------------------------------------------
// Sweep: lock rows that have exceeded the grace period. Run on a
// schedule from the backend.
// --------------------------------------------------------------------

async function sweepLocks() {
  const cutoff = new Date(Date.now() - GRACE_PERIOD_MS);
  const result = await prisma.moneyAttribution.updateMany({
    where: { locked: false, occurredAt: { lte: cutoff } },
    data: { locked: true, lockedAt: new Date() },
  });
  return { locked: result.count };
}

module.exports = {
  ATTRIBUTION_WINDOW_MS,
  GRACE_PERIOD_MS,
  MONEY_EVENT_TYPES,
  LEGACY_CLAIMABLE_EVENT_TYPES,
  ingestMoneyEvent,
  applyOverride,
  listDisputable,
  sweepLocks,
  hashEvent,
  isLocked,
  isLegacyClaimableEventType,
  canActorClaimAttribution,
};

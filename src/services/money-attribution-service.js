"use strict";

const prisma = require("../prisma");
const { serializableTxOptions } = require("../utils/prisma-transaction");

// --------------------------------------------------------------------
// Constants — these MUST match electron/team-claims/claim-rules.js or
// auto/manual attribution will diverge between client and server.
// --------------------------------------------------------------------
const ATTRIBUTION_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours
const GRACE_PERIOD_MS = 48 * 60 * 60 * 1000;      // 48 hours after the money event
const LEGACY_ATTRIBUTION_RETENTION_DAYS = 180;

// PPV attribution moved to TeamPpvPurchaseLedger / TeamPpvResolveJob.
// Tips moved to TeamTipLedger in v16. MoneyAttribution is kept only as
// a read-only legacy fallback for old tip rows until they are migrated.
// Subscriptions are intentionally NOT Team member revenue; they belong to
// the future Traffic / CreatorSubscription ledger.
const LEGACY_CLAIMABLE_EVENT_TYPES = new Set([
  "tip_received",
]);

// Keep old subscription_created rows until Traffic/CreatorSubscriptionLedger
// exists and a dedicated backfill can preserve historical subscription stats.
const LEGACY_PURGEABLE_EVENT_TYPES = new Set([
  "tip_received",
  "ppv_purchase_received",
]);

const ALLOWED_ACTIONS = new Set(["claim", "release", "manager_override"]);

// --------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------

function cleanString(value, max = 200) {
  const s = String(value || "").trim();
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

async function findMoneyAttributionForUpdate(tx, { agencyId, eventHash }) {
  const rows = await tx.$queryRaw`
    SELECT * FROM "MoneyAttribution"
    WHERE "agencyId" = ${agencyId} AND "eventHash" = ${eventHash}
    FOR UPDATE
    LIMIT 1
  `;
  return rows?.[0] || null;
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
// Audit15: MoneyAttribution is migration/read history only. Client money
// ingest authority has been removed; no production writer may create rows.
// --------------------------------------------------------------------

// --------------------------------------------------------------------
// Apply a manual override (claim / release / manager_override)
// --------------------------------------------------------------------

async function applyOverride({ agencyId, byUserId, byMemberId, eventHash, action, targetMemberId, reason, allowedCreatorIds = null }) {
  const cleanAction = cleanString(action, 24);
  const safeHash = cleanString(eventHash, 80);
  if (!cleanAction || !ALLOWED_ACTIONS.has(cleanAction)) {
    return { ok: false, code: "INVALID_ACTION" };
  }
  if (!safeHash) {
    return { ok: false, code: "ATTRIBUTION_NOT_FOUND" };
  }

  // Resolve actor before taking the row lock. The financial row itself is
  // locked below, so concurrent claim/release/manager_override requests are
  // serialized before checks + update are applied.
  const actor = await resolveMember({ agencyId, memberId: byMemberId, userId: byUserId });
  if (!actor) {
    return { ok: false, code: "ACTOR_NOT_AGENCY_MEMBER" };
  }

  const outcome = await prisma.$transaction(async (tx) => {
    const row = await findMoneyAttributionForUpdate(tx, { agencyId, eventHash: safeHash });

    if (!row) {
      return { ok: false, code: "ATTRIBUTION_NOT_FOUND" };
    }
    if (!creatorAllowed(row.creatorId, allowedCreatorIds)) {
      return { ok: false, code: "CREATOR_ACCESS_FORBIDDEN" };
    }

    if (!isLegacyClaimableEventType(row.eventType)) {
      if (row.eventType === "subscription_created") {
        return {
          ok: false,
          code: "SUBSCRIPTION_NOT_TEAM_MEMBER_REVENUE",
          error: "Subscriptions belong to traffic / creator revenue and are not claimable by chatters",
        };
      }
      return {
        ok: false,
        code: "PPV_CLAIMS_MOVED_TO_LEDGER",
        error: "PPV attribution conflicts must be resolved through /api/team/analytics/ppv/conflicts",
      };
    }

    if (isLocked(row)) {
      return { ok: false, code: "ATTRIBUTION_LOCKED", error: "48-hour grace period elapsed" };
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
          error: "You can claim only legacy tip rows from dialogs you worked in the attribution window",
        };
      }
      nextOwnerMemberId = actor.id;
      nextOwnerUserId = actor.userId;
      nextState = "claimed";
    } else if (cleanAction === "release") {
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

    const updated = await tx.moneyAttribution.update({
      where: { id: row.id },
      data: {
        state: nextState,
        attributedToMemberId: nextOwnerMemberId,
        attributedToUserId: nextOwnerUserId,
        history: newHistory,
      },
    });

    return { ok: true, attribution: updated };
  }, serializableTxOptions());

  return outcome?.ok ? outcome : { ok: false, code: outcome?.code || "OVERRIDE_FAILED", error: outcome?.error || "Failed" };
}

// --------------------------------------------------------------------
// List money events still in the dispute window (any agency member
// can call this — it's intentionally agency-wide so the team has
// full visibility).
// --------------------------------------------------------------------

async function listDisputable({ agencyId, range = "24h", limit = 200, actorMemberId = null, senior = false, allowedCreatorIds = null }) {
  const cutoff = new Date(Date.now() - GRACE_PERIOD_MS);
  const where = {
    agencyId,
    ...creatorScopeWhere(allowedCreatorIds),
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

async function sweepLocks({ agencyId = null } = {}) {
  const cutoff = new Date(Date.now() - GRACE_PERIOD_MS);
  const cleanAgency = cleanString(agencyId, 160);
  const result = await prisma.moneyAttribution.updateMany({
    where: {
      locked: false,
      occurredAt: { lte: cutoff },
      ...(cleanAgency ? { agencyId: cleanAgency } : {}),
    },
    data: { locked: true, lockedAt: new Date() },
  });
  return { locked: result.count };
}


async function purgeExpiredLegacyAttributions({ agencyId = null, retentionDays = LEGACY_ATTRIBUTION_RETENTION_DAYS, limit = 5000, dryRun = false } = {}) {
  const cleanAgency = cleanString(agencyId, 160);
  const safeRetentionDays = Math.max(1, Math.round(Number(retentionDays) || LEGACY_ATTRIBUTION_RETENTION_DAYS));
  const safeLimit = Math.min(20000, Math.max(1, Math.round(Number(limit) || 5000)));
  const cutoff = new Date(Date.now() - safeRetentionDays * 24 * 60 * 60 * 1000);

  const rows = await prisma.moneyAttribution.findMany({
    where: {
      ...(cleanAgency ? { agencyId: cleanAgency } : {}),
      eventType: { in: Array.from(LEGACY_PURGEABLE_EVENT_TYPES) },
      occurredAt: { lt: cutoff },
    },
    select: { id: true },
    orderBy: { occurredAt: "asc" },
    take: safeLimit,
  }).catch(() => []);

  if (dryRun || rows.length === 0) {
    return { ok: true, deleted: 0, matched: rows.length, retentionDays: safeRetentionDays, cutoff, dryRun: Boolean(dryRun) };
  }

  const result = await prisma.moneyAttribution.deleteMany({
    where: { id: { in: rows.map((row) => row.id) } },
  });
  return { ok: true, deleted: result.count, matched: rows.length, retentionDays: safeRetentionDays, cutoff, dryRun: false };
}

module.exports = {
  ATTRIBUTION_WINDOW_MS,
  GRACE_PERIOD_MS,
  LEGACY_ATTRIBUTION_RETENTION_DAYS,
  LEGACY_CLAIMABLE_EVENT_TYPES,
  LEGACY_PURGEABLE_EVENT_TYPES,
  applyOverride,
  listDisputable,
  sweepLocks,
  purgeExpiredLegacyAttributions,
  isLocked,
  isLegacyClaimableEventType,
  canActorClaimAttribution,
};

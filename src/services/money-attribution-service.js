"use strict";

const prisma = require("../prisma");

// --------------------------------------------------------------------
// Constants — these MUST match electron/team-claims/claim-rules.js or
// auto/manual attribution will diverge between client and server.
// --------------------------------------------------------------------
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

function isLocked(row) {
  if (!row) return false;
  if (row.locked) return true;
  const elapsed = Date.now() - new Date(row.occurredAt).getTime();
  return elapsed >= GRACE_PERIOD_MS;
}

// --------------------------------------------------------------------
// Audit15: MoneyAttribution is migration/read history only. Client money
// ingest authority has been removed; no production writer may create rows.
// --------------------------------------------------------------------

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
  GRACE_PERIOD_MS,
  LEGACY_ATTRIBUTION_RETENTION_DAYS,
  LEGACY_CLAIMABLE_EVENT_TYPES,
  LEGACY_PURGEABLE_EVENT_TYPES,
  listDisputable,
  sweepLocks,
  purgeExpiredLegacyAttributions,
  isLocked,
};

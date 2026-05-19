"use strict";

const prisma = require("../prisma");

const STATUS_RANK = Object.freeze({
  free: 1,
  not_opened: 2,
  sold: 3,
});

function cleanId(value) {
  const raw = String(value || "").trim();
  return /^\d{3,40}$/.test(raw) ? raw : "";
}

function cleanText(value, max = 500) {
  const raw = String(value || "").trim();
  return raw ? raw.slice(0, max) : null;
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function toNonNegativeInt(value, fallback = 0) {
  return Math.max(0, toInt(value, fallback));
}

function normalizeStatus(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "sold") return "sold";
  if (raw === "free") return "free";
  return "not_opened";
}

function bestStatus(a, b) {
  const aa = normalizeStatus(a);
  const bb = normalizeStatus(b);
  return (STATUS_RANK[bb] || 0) > (STATUS_RANK[aa] || 0) ? bb : aa;
}

function normalizePriceCents(value, fallback = 0) {
  return toNonNegativeInt(value, fallback);
}

async function loadCreatorForAgency({ agencyId, creatorId }) {
  const creator = await prisma.creatorAccount.findFirst({
    where: {
      id: String(creatorId || ""),
      agencyId: String(agencyId || ""),
      deletedAt: null,
    },
  });

  return creator || null;
}

function normalizeDeliveryEvent(input = {}) {
  const messageId = cleanId(input.messageId || input.message_id);
  const mediaId = cleanId(input.mediaId || input.media_id);
  if (!messageId || !mediaId) return null;

  const packSize = Math.max(1, toNonNegativeInt(input.packSize ?? input.pack_size, 1));
  const packagePriceCents = normalizePriceCents(input.packagePriceCents ?? input.package_price_cents, 0);
  const allocatedAmountCents = normalizePriceCents(
    input.allocatedAmountCents ?? input.allocated_amount_cents,
    packagePriceCents > 0 ? Math.floor(packagePriceCents / packSize) : 0
  );

  return {
    messageId,
    mediaId,
    packSize,
    packagePriceCents,
    allocatedAmountCents,
    status: normalizeStatus(input.status),
    source: cleanText(input.source || "electron", 80) || "electron",
  };
}

async function upsertDeliveryEvents({ agencyId, creatorId, events = [] }) {
  const creator = await loadCreatorForAgency({ agencyId, creatorId });
  if (!creator) {
    const err = new Error("Creator not found");
    err.code = "CREATOR_NOT_FOUND";
    throw err;
  }

  const normalized = [];
  for (const event of Array.isArray(events) ? events : []) {
    const item = normalizeDeliveryEvent(event);
    if (item) normalized.push(item);
  }

  let changed = 0;
  let inserted = 0;
  let updated = 0;

  await prisma.$transaction(async (tx) => {
    for (const event of normalized) {
      const existing = await tx.creatorMediaDeliveryEvent.findUnique({
        where: {
          creatorId_messageId_mediaId: {
            creatorId: creator.id,
            messageId: event.messageId,
            mediaId: event.mediaId,
          },
        },
      });

      if (!existing) {
        await tx.creatorMediaDeliveryEvent.create({
          data: {
            agencyId,
            creatorId: creator.id,
            ...event,
          },
        });
        inserted += 1;
        changed += 1;
        continue;
      }

      const nextStatus = bestStatus(existing.status, event.status);
      const nextPackagePrice = Math.max(Number(existing.packagePriceCents || 0), event.packagePriceCents);
      const nextAllocated = nextStatus === "sold"
        ? Math.max(Number(existing.allocatedAmountCents || 0), event.allocatedAmountCents)
        : Number(existing.allocatedAmountCents || 0);

      await tx.creatorMediaDeliveryEvent.update({
        where: { id: existing.id },
        data: {
          packSize: Math.max(Number(existing.packSize || 1), event.packSize),
          packagePriceCents: nextPackagePrice,
          allocatedAmountCents: nextAllocated,
          status: nextStatus,
          source: event.source,
        },
      });
      updated += 1;
      changed += 1;
    }
  });

  return { ok: true, creatorId: creator.id, received: Array.isArray(events) ? events.length : 0, accepted: normalized.length, inserted, updated, changed };
}

async function upsertMediaAssetMeta({ agencyId, creatorId, mediaId, patch = {} }) {
  const creator = await loadCreatorForAgency({ agencyId, creatorId });
  if (!creator) {
    const err = new Error("Creator not found");
    err.code = "CREATOR_NOT_FOUND";
    throw err;
  }

  const cleanMediaId = cleanId(mediaId);
  if (!cleanMediaId) {
    const err = new Error("mediaId is required");
    err.code = "MEDIA_ID_MISSING";
    throw err;
  }

  const data = {
    type: cleanText(patch.type, 40),
    durationSec: patch.durationSec === undefined ? undefined : toNonNegativeInt(patch.durationSec, 0),
    costCents: patch.costCents === undefined ? undefined : toNonNegativeInt(patch.costCents, 0),
    targetPriceCents: patch.targetPriceCents === undefined ? undefined : toNonNegativeInt(patch.targetPriceCents, 0),
    tags: Array.isArray(patch.tags) ? patch.tags : undefined,
    metadata: patch.metadata && typeof patch.metadata === "object" && !Array.isArray(patch.metadata) ? patch.metadata : undefined,
  };

  Object.keys(data).forEach((key) => data[key] === undefined && delete data[key]);

  const asset = await prisma.creatorMediaAsset.upsert({
    where: { creatorId_mediaId: { creatorId: creator.id, mediaId: cleanMediaId } },
    create: {
      agencyId,
      creatorId: creator.id,
      mediaId: cleanMediaId,
      ...data,
    },
    update: data,
  });

  return { ok: true, asset };
}

async function getMediaAnalytics({ agencyId, creatorId, mediaIds = [] }) {
  const creator = await loadCreatorForAgency({ agencyId, creatorId });
  if (!creator) {
    const err = new Error("Creator not found");
    err.code = "CREATOR_NOT_FOUND";
    throw err;
  }

  const ids = Array.from(new Set((Array.isArray(mediaIds) ? mediaIds : [])
    .map((id) => cleanId(id))
    .filter(Boolean)));

  const where = {
    agencyId,
    creatorId: creator.id,
    ...(ids.length ? { mediaId: { in: ids } } : {}),
  };

  const [byStatus, soldAgg, metas] = await Promise.all([
    prisma.creatorMediaDeliveryEvent.groupBy({
      by: ["mediaId", "status"],
      where,
      _count: { _all: true },
      _sum: { packagePriceCents: true, allocatedAmountCents: true },
    }),
    prisma.creatorMediaDeliveryEvent.groupBy({
      by: ["mediaId"],
      where: { ...where, status: "sold" },
      _count: { _all: true },
      _sum: { packagePriceCents: true, allocatedAmountCents: true },
      _avg: { packagePriceCents: true, allocatedAmountCents: true },
    }),
    prisma.creatorMediaAsset.findMany({
      where: {
        agencyId,
        creatorId: creator.id,
        ...(ids.length ? { mediaId: { in: ids } } : {}),
      },
    }),
  ]);

  const out = new Map();
  const ensure = (mediaId) => {
    const id = cleanId(mediaId);
    if (!out.has(id)) {
      out.set(id, {
        mediaId: id,
        sentCount: 0,
        freeCount: 0,
        paidSentCount: 0,
        soldCount: 0,
        notOpenedCount: 0,
        grossRevenueCents: 0,
        allocatedRevenueCents: 0,
        avgSoldPriceCents: 0,
        avgAllocatedPriceCents: 0,
        conversionRate: 0,
        costCents: null,
        targetPriceCents: null,
        profitCents: null,
        roi: null,
        neverUsed: true,
      });
    }
    return out.get(id);
  };

  for (const id of ids) ensure(id);

  for (const row of byStatus) {
    const item = ensure(row.mediaId);
    const count = Number(row._count?._all || 0);
    item.sentCount += count;
    if (row.status === "free") item.freeCount += count;
    else item.paidSentCount += count;
    if (row.status === "not_opened") item.notOpenedCount += count;
  }

  for (const row of soldAgg) {
    const item = ensure(row.mediaId);
    item.soldCount = Number(row._count?._all || 0);
    item.grossRevenueCents = Number(row._sum?.packagePriceCents || 0);
    item.allocatedRevenueCents = Number(row._sum?.allocatedAmountCents || 0);
    item.avgSoldPriceCents = Math.round(Number(row._avg?.packagePriceCents || 0));
    item.avgAllocatedPriceCents = Math.round(Number(row._avg?.allocatedAmountCents || 0));
  }

  const metaById = new Map(metas.map((m) => [m.mediaId, m]));
  for (const [mediaId, item] of out) {
    const meta = metaById.get(mediaId);
    if (meta) {
      item.costCents = meta.costCents;
      item.targetPriceCents = meta.targetPriceCents;
    }
    item.conversionRate = item.sentCount > 0 ? item.soldCount / item.sentCount : 0;
    item.neverUsed = item.sentCount === 0;
    if (typeof item.costCents === "number" && item.costCents > 0) {
      item.profitCents = item.allocatedRevenueCents - item.costCents;
      item.roi = item.profitCents / item.costCents;
    }
  }

  return { ok: true, creatorId: creator.id, items: Array.from(out.values()) };
}

module.exports = {
  upsertDeliveryEvents,
  upsertMediaAssetMeta,
  getMediaAnalytics,
};

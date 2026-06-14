"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { ensureSingleJob, TRAFFIC_REFRESH_WINDOW_MS } = require("./job-scheduler");

const TRAFFIC_SOURCES_SCAN_JOB_KEY = "traffic_sources_scan";
const VALUE_SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;

function clean(value, max = 255) {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, max) : null;
}

function asDate(value) {
  if (!value) return null;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return new Date(n);
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function moneyCents(value) {
  if (value === null || value === undefined || value === "") return 0;
  const n = Number(String(value).replace(/[^0-9.,-]/g, "").replace(",", "."));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n * 100));
}

function cents(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

function stableHash(parts) {
  return crypto.createHash("sha1").update((parts || []).map((x) => String(x ?? "")).join("|"), "utf8").digest("hex");
}

function utcDay(value) {
  const d = asDate(value) || new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function rangeWindow(rangeKey = "7d", now = new Date()) {
  const key = String(rangeKey || "7d").toLowerCase();
  const end = new Date(now);
  const start = new Date(now);

  if (key === "all") return { key, start: null, end: null };
  if (key === "24h") {
    start.setTime(end.getTime() - 24 * 60 * 60 * 1000);
    return { key, start, end };
  }
  if (key === "30d" || key === "90d" || key === "180d" || key === "365d") {
    const days = Number(key.replace("d", ""));
    start.setTime(end.getTime() - days * 24 * 60 * 60 * 1000);
    return { key, start, end };
  }
  if (key === "ytd") {
    return { key, start: new Date(Date.UTC(end.getUTCFullYear(), 0, 1)), end };
  }
  if (key === "prev_year") {
    return {
      key,
      start: new Date(Date.UTC(end.getUTCFullYear() - 1, 0, 1)),
      end: new Date(Date.UTC(end.getUTCFullYear(), 0, 1)),
    };
  }

  start.setTime(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { key: "7d", start, end };
}

function sourceLabel(sourceType) {
  const type = String(sourceType || "").toLowerCase();
  if (type === "of_campaign") return "OF campaign / trial";
  if (type === "trial_link") return "Trial link";
  if (type === "promo_link") return "Promo link";
  if (type === "sfs_market") return "SFS market";
  if (type === "sfs_partner") return "SFS partner";
  if (type === "paid_unknown") return "Paid subscriptions";
  return type || "traffic source";
}


function compactJson(value, max = 12000) {
  if (!value || typeof value !== "object") return null;
  try {
    const s = JSON.stringify(value);
    if (s.length > max) return { truncated: true };
    return value;
  } catch (_) {
    return null;
  }
}

function normalizeSource(input = {}, { accountId } = {}) {
  const sourceType = clean(input.sourceType || input.type || "of_campaign", 80) || "of_campaign";
  const externalId = clean(input.externalId || input.id || input.campaignId || input.campaign_id, 180);
  if (!externalId) return null;

  return {
    sourceType,
    externalId,
    accountId: clean(input.accountId || accountId || "unknown", 180) || "unknown",
    name: clean(input.name || input.title || input.label || input.campaignName, 255),
    url: clean(input.url || input.link || input.shareUrl || input.share_url, 1000),
    status: clean(input.status || (input.isActive === true || input.is_active === true ? "active" : null), 80),
    startedAt: asDate(input.startedAt || input.startDate || input.start_date || input.createdAt || input.created_at),
    endedAt: asDate(input.endedAt || input.endDate || input.end_date || input.expiresAt || input.expires_at),
    costCents: cents(input.costCents) || moneyCents(input.cost),
    currency: clean(input.currency, 8) || "USD",
    stats: compactJson(input.stats || input.totals || input.metrics || null),
    metadata: compactJson(input.metadata || input.rawMeta || null),
  };
}

function normalizeMember(input = {}) {
  const fanId = clean(input.fanId || input.userId || input.id || input.remoteId, 180);
  const sourceExternalId = clean(input.sourceExternalId || input.campaignId || input.externalId || input.sourceId, 180);
  if (!fanId || !sourceExternalId) return null;
  return {
    fanId,
    sourceType: clean(input.sourceType || "of_campaign", 80) || "of_campaign",
    sourceExternalId,
    claimedAt: asDate(input.claimedAt || input.createdAt || input.addedAt || input.ts),
    metadata: compactJson(input.metadata || null),
  };
}

function normalizeSnapshot(input = {}) {
  const fanId = clean(input.fanId || input.id, 180);
  if (!fanId) return null;
  return {
    fanId,
    totalSummCents: moneyCents(input.totalSumm ?? input.total),
    messagesSummCents: moneyCents(input.messagesSumm ?? input.messages),
    tipsSummCents: moneyCents(input.tipsSumm ?? input.tips),
    subscribesSummCents: moneyCents(input.subscribesSumm ?? input.subscribes),
    postsSummCents: moneyCents(input.postsSumm ?? input.posts),
    streamsSummCents: moneyCents(input.streamsSumm ?? input.streams),
    lastActivity: asDate(input.lastActivity),
    fetchedAt: asDate(input.fetchedAt) || new Date(),
    source: clean(input.source || "fan_value_core", 80) || "fan_value_core",
  };
}

async function validateDeviceForCreator({ deviceId, userId, creatorId }) {
  const [device, creator] = await Promise.all([
    prisma.workerDevice.findUnique({ where: { id: deviceId } }),
    prisma.creatorAccount.findUnique({ where: { id: creatorId } }),
  ]);

  if (!device || device.userId !== userId) {
    const err = new Error("Invalid device");
    err.code = "NOT_YOUR_DEVICE";
    throw err;
  }
  if (!creator || creator.deletedAt) {
    const err = new Error("Creator not found");
    err.code = "CREATOR_NOT_FOUND";
    throw err;
  }
  if (device.agencyId !== creator.agencyId) {
    const err = new Error("Device and creator agency mismatch");
    err.code = "DEVICE_CREATOR_AGENCY_MISMATCH";
    throw err;
  }

  return { device, creator };
}

async function selectFanIdsNeedingValueRefresh({ agencyId, creatorId, fanIds, ttlMs = VALUE_SNAPSHOT_TTL_MS, limit = 1000 }) {
  const uniqueFanIds = Array.from(new Set((fanIds || []).map((x) => clean(x, 180)).filter(Boolean)));
  if (!uniqueFanIds.length) return [];

  const threshold = new Date(Date.now() - Math.max(60_000, Number(ttlMs) || VALUE_SNAPSHOT_TTL_MS));
  const out = [];

  for (let i = 0; i < uniqueFanIds.length; i += 500) {
    const chunk = uniqueFanIds.slice(i, i + 500);
    const snapshots = await prisma.trafficFanValueSnapshot.findMany({
      where: { agencyId, creatorId, fanId: { in: chunk } },
      select: { fanId: true, fetchedAt: true },
    });
    const byFan = new Map(snapshots.map((row) => [String(row.fanId), row]));

    const dirtyMembers = await prisma.trafficSourceMember.findMany({
      where: {
        agencyId,
        creatorId,
        fanId: { in: chunk },
        OR: [
          { needsValueRefresh: true },
          { lastValueFetchedAt: null },
          { lastValueFetchedAt: { lt: threshold } },
        ],
      },
      select: { fanId: true },
      take: chunk.length,
    });
    const dirty = new Set(dirtyMembers.map((row) => String(row.fanId)));

    for (const fanId of chunk) {
      const snap = byFan.get(fanId);
      if (!snap || !snap.fetchedAt || snap.fetchedAt < threshold || dirty.has(fanId)) {
        out.push(fanId);
        if (out.length >= limit) return out;
      }
    }
  }

  return out;
}

async function upsertTrafficSourceScan({ deviceId, userId, creatorId, accountId, sources = [], members = [], hydrateLimit = 1000 }) {
  const { device, creator } = await validateDeviceForCreator({ deviceId, userId, creatorId });
  const agencyId = creator.agencyId;
  const now = new Date();

  const sourceRows = [];
  const sourceMap = new Map();

  for (const input of Array.isArray(sources) ? sources : []) {
    const normalized = normalizeSource(input, { accountId });
    if (!normalized) continue;
    const row = await prisma.trafficSource.upsert({
      where: {
        agencyId_creatorId_sourceType_externalId: {
          agencyId,
          creatorId: creator.id,
          sourceType: normalized.sourceType,
          externalId: normalized.externalId,
        },
      },
      create: {
        agencyId,
        creatorId: creator.id,
        accountId: normalized.accountId,
        sourceType: normalized.sourceType,
        externalId: normalized.externalId,
        name: normalized.name,
        url: normalized.url,
        status: normalized.status,
        startedAt: normalized.startedAt,
        endedAt: normalized.endedAt,
        lastScannedAt: now,
        costCents: normalized.costCents,
        currency: normalized.currency,
        stats: normalized.stats,
        metadata: normalized.metadata,
      },
      update: {
        accountId: normalized.accountId,
        name: normalized.name,
        url: normalized.url,
        status: normalized.status,
        startedAt: normalized.startedAt,
        endedAt: normalized.endedAt,
        lastScannedAt: now,
        costCents: normalized.costCents,
        currency: normalized.currency,
        stats: normalized.stats,
        metadata: normalized.metadata,
      },
    });
    sourceRows.push(row);
    sourceMap.set(`${row.sourceType}:${row.externalId}`, row);
  }

  let memberUpserts = 0;
  const memberFanIds = [];
  for (const input of Array.isArray(members) ? members : []) {
    const member = normalizeMember(input);
    if (!member) continue;
    let source = sourceMap.get(`${member.sourceType}:${member.sourceExternalId}`);
    if (!source) {
      source = await prisma.trafficSource.findUnique({
        where: {
          agencyId_creatorId_sourceType_externalId: {
            agencyId,
            creatorId: creator.id,
            sourceType: member.sourceType,
            externalId: member.sourceExternalId,
          },
        },
      });
    }
    if (!source) continue;

    await prisma.trafficSourceMember.upsert({
      where: {
        agencyId_creatorId_sourceId_fanId: {
          agencyId,
          creatorId: creator.id,
          sourceId: source.id,
          fanId: member.fanId,
        },
      },
      create: {
        agencyId,
        creatorId: creator.id,
        sourceId: source.id,
        fanId: member.fanId,
        firstSeenAt: member.claimedAt || now,
        lastSeenAt: now,
        claimedAt: member.claimedAt || null,
        needsValueRefresh: true,
        metadata: member.metadata,
      },
      update: {
        lastSeenAt: now,
        claimedAt: member.claimedAt || undefined,
        metadata: member.metadata || undefined,
      },
    });
    memberUpserts += 1;
    memberFanIds.push(member.fanId);
  }

  const hydrateFanIds = await selectFanIdsNeedingValueRefresh({
    agencyId,
    creatorId: creator.id,
    fanIds: memberFanIds,
    limit: hydrateLimit,
  });

  return {
    ok: true,
    agencyId,
    creatorId: creator.id,
    deviceId: device.id,
    sourcesUpserted: sourceRows.length,
    membersUpserted: memberUpserts,
    hydrateFanIds,
  };
}

async function upsertTrafficFanValueSnapshots({ deviceId, userId, creatorId, snapshots = [] }) {
  const { device, creator } = await validateDeviceForCreator({ deviceId, userId, creatorId });
  const agencyId = creator.agencyId;
  const rows = (Array.isArray(snapshots) ? snapshots : []).map(normalizeSnapshot).filter(Boolean);
  let upserted = 0;
  const fanIds = [];

  for (const row of rows) {
    await prisma.trafficFanValueSnapshot.upsert({
      where: { agencyId_creatorId_fanId: { agencyId, creatorId: creator.id, fanId: row.fanId } },
      create: {
        agencyId,
        creatorId: creator.id,
        fanId: row.fanId,
        totalSummCents: row.totalSummCents,
        messagesSummCents: row.messagesSummCents,
        tipsSummCents: row.tipsSummCents,
        subscribesSummCents: row.subscribesSummCents,
        postsSummCents: row.postsSummCents,
        streamsSummCents: row.streamsSummCents,
        lastActivity: row.lastActivity,
        fetchedAt: row.fetchedAt,
        source: row.source,
      },
      update: {
        totalSummCents: row.totalSummCents,
        messagesSummCents: row.messagesSummCents,
        tipsSummCents: row.tipsSummCents,
        subscribesSummCents: row.subscribesSummCents,
        postsSummCents: row.postsSummCents,
        streamsSummCents: row.streamsSummCents,
        lastActivity: row.lastActivity,
        fetchedAt: row.fetchedAt,
        source: row.source,
      },
    });
    upserted += 1;
    fanIds.push(row.fanId);
  }

  if (fanIds.length) {
    await prisma.trafficSourceMember.updateMany({
      where: { agencyId, creatorId: creator.id, fanId: { in: Array.from(new Set(fanIds)) } },
      data: {
        lastValueFetchedAt: new Date(),
        needsValueRefresh: false,
      },
    });
  }

  return { ok: true, agencyId, creatorId: creator.id, deviceId: device.id, upserted };
}

async function ingestSubscriptionEvent({ deviceId, userId, creatorId, accountId, event }) {
  const { device, creator } = await validateDeviceForCreator({ deviceId, userId, creatorId });
  const agencyId = creator.agencyId;
  const fanId = clean(event?.fanId, 180);
  const amountCents = cents(event?.amountCents) || moneyCents(event?.amount || event?.price);
  const occurredAt = asDate(event?.occurredAt || event?.createdAt || event?.ts) || new Date();

  // Product decision: free subscriptions without a tracked source are not stored.
  // Paid subs are facts and go to the creator/traffic ledger.
  if (!fanId || amountCents <= 0) {
    return { ok: true, ignored: true, reason: !fanId ? "no_fan_id" : "free_subscription" };
  }

  const sourceMember = await prisma.trafficSourceMember.findFirst({
    where: { agencyId, creatorId: creator.id, fanId },
    orderBy: [{ lastSeenAt: "desc" }, { createdAt: "desc" }],
    select: { id: true, sourceId: true },
  });

  const eventHash = clean(event?.eventHash, 220) || stableHash([
    "subscription",
    agencyId,
    creator.id,
    fanId,
    amountCents,
    occurredAt.toISOString(),
    event?.externalEventId || event?.toastId || event?.notificationId || "",
  ]);

  const data = {
    agencyId,
    creatorId: creator.id,
    accountId: clean(accountId || event?.accountId || creator.id, 180) || creator.id,
    fanId,
    sourceId: sourceMember?.sourceId || null,
    eventType: clean(event?.eventType || "paid_subscribed", 80) || "paid_subscribed",
    amountCents,
    currency: clean(event?.currency, 8) || "USD",
    occurredAt,
    externalEventId: clean(event?.externalEventId || event?.toastId || event?.notificationId || null, 220),
    eventHash,
    source: clean(event?.source || "realtime_subscription", 80) || "realtime_subscription",
    metadata: compactJson(event?.metadata || null),
  };

  let created = null;
  try {
    created = await prisma.creatorSubscriptionLedger.create({ data });
  } catch (err) {
    if (err?.code === "P2002") {
      return { ok: true, duplicate: true, eventHash };
    }
    throw err;
  }

  if (sourceMember?.id) {
    await prisma.trafficSourceMember.update({
      where: { id: sourceMember.id },
      data: {
        lastRevenueAt: occurredAt,
        convertedAt: occurredAt,
        needsValueRefresh: true,
      },
    });
  }

  if (created.sourceId) {
    const day = utcDay(occurredAt);
    await prisma.trafficDailyAggregate.upsert({
      where: { sourceId_day: { sourceId: created.sourceId, day } },
      create: {
        agencyId,
        creatorId: creator.id,
        sourceId: created.sourceId,
        day,
        paidSubs: 1,
        grossCents: amountCents,
        netCents: amountCents,
      },
      update: {
        paidSubs: { increment: 1 },
        grossCents: { increment: amountCents },
        netCents: { increment: amountCents },
      },
    });
  }

  return { ok: true, ledgerId: created.id, sourceId: created.sourceId, amountCents };
}

async function assertTrafficViewer({ userId, creatorId }) {
  const creator = await prisma.creatorAccount.findUnique({ where: { id: creatorId } });
  if (!creator || creator.deletedAt) {
    const err = new Error("Creator not found");
    err.code = "CREATOR_NOT_FOUND";
    throw err;
  }

  const member = await prisma.agencyMember.findFirst({
    where: { userId, agencyId: creator.agencyId, deletedAt: null, agency: { deletedAt: null } },
    select: { id: true, roleKey: true },
  });
  if (!member) {
    const err = new Error("Not a member of this agency");
    err.code = "NOT_A_MEMBER";
    throw err;
  }

  return { creator, member };
}

async function getTrafficOverview({ userId, creatorId, rangeKey = "7d" }) {
  const { creator } = await assertTrafficViewer({ userId, creatorId });
  const range = rangeWindow(rangeKey);
  const revenueWhere = {
    agencyId: creator.agencyId,
    creatorId: creator.id,
  };
  if (range.start || range.end) {
    revenueWhere.occurredAt = {};
    if (range.start) revenueWhere.occurredAt.gte = range.start;
    if (range.end) revenueWhere.occurredAt.lt = range.end;
  }

  const [sources, membersCount, revenue] = await Promise.all([
    prisma.trafficSource.findMany({
      where: { agencyId: creator.agencyId, creatorId: creator.id },
      orderBy: [{ updatedAt: "desc" }],
      take: 300,
      include: {
        _count: { select: { members: true, subscriptionLedgers: true } },
      },
    }),
    prisma.trafficSourceMember.count({ where: { agencyId: creator.agencyId, creatorId: creator.id } }),
    prisma.creatorSubscriptionLedger.groupBy({
      by: ["sourceId"],
      where: revenueWhere,
      _sum: { amountCents: true },
      _count: { _all: true },
    }),
  ]);

  const revenueBySource = new Map(revenue.map((row) => [row.sourceId || "", row]));
  const rows = sources.map((source) => {
    const rev = revenueBySource.get(source.id);
    const claimers = source._count.members;
    const paidSubscriptions = Number(rev?._count?._all || 0);
    const revenueCents = Number(rev?._sum?.amountCents || 0);
    const costCents = Number(source.costCents || 0);
    const roiPercent = costCents > 0 ? ((revenueCents - costCents) / costCents) * 100 : null;
    return {
      id: source.id,
      sourceType: source.sourceType,
      sourceLabel: sourceLabel(source.sourceType),
      externalId: source.externalId,
      name: source.name || source.externalId,
      status: source.status,
      url: source.url,
      claimers,
      paidSubscriptions,
      revenueCents,
      costCents,
      roiPercent,
      lastScannedAt: source.lastScannedAt,
      updatedAt: source.updatedAt,
      bucket: "tracked_source",
    };
  });

  const unknown = revenueBySource.get("");
  const unknownPaidSubscriptions = Number(unknown?._count?._all || 0);
  const unknownRevenueCents = Number(unknown?._sum?.amountCents || 0);
  if (unknownPaidSubscriptions || unknownRevenueCents) {
    rows.unshift({
      id: "unattributed_paid_subscriptions",
      sourceType: "paid_unknown",
      sourceLabel: sourceLabel("paid_unknown"),
      externalId: "unattributed",
      name: "Paid subscriptions · unknown source",
      status: "live",
      url: null,
      claimers: 0,
      paidSubscriptions: unknownPaidSubscriptions,
      revenueCents: unknownRevenueCents,
      costCents: 0,
      roiPercent: null,
      lastScannedAt: null,
      updatedAt: null,
      bucket: "unattributed_paid",
      isUnattributed: true,
    });
  }

  const bucketsByType = new Map();
  for (const row of rows) {
    const key = row.isUnattributed ? "paid_unknown" : row.sourceType;
    const cur = bucketsByType.get(key) || {
      key,
      label: sourceLabel(key),
      sources: 0,
      claimers: 0,
      paidSubscriptions: 0,
      revenueCents: 0,
      costCents: 0,
    };
    cur.sources += row.isUnattributed ? 0 : 1;
    cur.claimers += Number(row.claimers || 0);
    cur.paidSubscriptions += Number(row.paidSubscriptions || 0);
    cur.revenueCents += Number(row.revenueCents || 0);
    cur.costCents += Number(row.costCents || 0);
    bucketsByType.set(key, cur);
  }

  const subscriptionRevenueCents = revenue.reduce((acc, row) => acc + Number(row._sum.amountCents || 0), 0);
  const paidSubscriptions = revenue.reduce((acc, row) => acc + Number(row._count?._all || 0), 0);
  const trackedRevenueCents = subscriptionRevenueCents - unknownRevenueCents;
  const trackedPaidSubscriptions = paidSubscriptions - unknownPaidSubscriptions;

  return {
    ok: true,
    creatorId: creator.id,
    range: {
      key: range.key,
      startAt: range.start ? range.start.toISOString() : null,
      endAt: range.end ? range.end.toISOString() : null,
    },
    totals: {
      sources: sources.length,
      sourceMembers: membersCount,
      subscriptionRevenueCents,
      paidSubscriptions,
      trackedRevenueCents,
      trackedPaidSubscriptions,
      unattributedRevenueCents: unknownRevenueCents,
      unattributedPaidSubscriptions: unknownPaidSubscriptions,
    },
    buckets: Array.from(bucketsByType.values()).sort((a, b) => Number(b.revenueCents || 0) - Number(a.revenueCents || 0)),
    sources: rows.sort((a, b) => Number(b.revenueCents || 0) - Number(a.revenueCents || 0)),
  };
}

async function scheduleTrafficRefresh({ userId, creatorId, force = false } = {}) {
  const { creator } = await assertTrafficViewer({ userId, creatorId });
  const decision = await ensureSingleJob({
    jobKey: TRAFFIC_SOURCES_SCAN_JOB_KEY,
    creatorId: creator.id,
    agencyId: creator.agencyId,
    params: { hydrateFanValues: true, valueTtlHours: 6, reason: "manual_traffic_refresh" },
    priority: 100,
    now: new Date(),
    freshnessWindowMs: force ? 0 : Math.min(60_000, TRAFFIC_REFRESH_WINDOW_MS),
  });
  return { ok: true, ...decision };
}

module.exports = {
  TRAFFIC_SOURCES_SCAN_JOB_KEY,
  VALUE_SNAPSHOT_TTL_MS,
  upsertTrafficSourceScan,
  upsertTrafficFanValueSnapshots,
  ingestSubscriptionEvent,
  getTrafficOverview,
  scheduleTrafficRefresh,
};

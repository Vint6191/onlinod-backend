"use strict";

const crypto = require("node:crypto");
const { Prisma } = require("@prisma/client");
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

function dbNumber(value) {
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value === "object" && typeof value.toNumber === "function") return value.toNumber();
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function chunkArray(list = [], size = 500) {
  const cleanSize = Math.max(1, Number(size) || 500);
  const out = [];
  for (let i = 0; i < list.length; i += cleanSize) out.push(list.slice(i, i + cleanSize));
  return out;
}

function uniqueBy(list = [], keyFn = (x) => x) {
  const map = new Map();
  for (const item of Array.isArray(list) ? list : []) {
    const key = keyFn(item);
    if (!key) continue;
    map.set(key, item);
  }
  return Array.from(map.values());
}

function isoOrNull(value) {
  const d = asDate(value);
  return d ? d.toISOString() : null;
}

function valueStatsSeed() {
  return {
    valueSnapshotMembers: 0,
    valuePendingMembers: 0,
    valuePayingFans: 0,
    fanValueCents: 0,
    valueMessagesCents: 0,
    valueTipsCents: 0,
    valueSubscribesCents: 0,
    valuePostsCents: 0,
    valueStreamsCents: 0,
    lastValueFetchedAt: null,
  };
}

function extractMemberIdentity(metadata = {}) {
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  const user = meta.user && typeof meta.user === "object" ? meta.user : {};
  const fan = meta.fan && typeof meta.fan === "object" ? meta.fan : {};
  const subscriber = meta.subscriber && typeof meta.subscriber === "object" ? meta.subscriber : {};

  const username = clean(
    meta.fanUsername || meta.username || meta.login ||
    user.username || user.login ||
    fan.username || fan.login ||
    subscriber.username || subscriber.login,
    120
  );
  const name = clean(
    meta.fanName || meta.name || meta.displayName ||
    user.name || user.displayName ||
    fan.name || fan.displayName ||
    subscriber.name || subscriber.displayName,
    160
  );
  const avatarUrl = clean(
    meta.fanAvatar || meta.avatarUrl || meta.avatar ||
    user.avatar || user.avatarUrl || user.avatarThumbs?.c50 || user.avatarThumbs?.c144 ||
    fan.avatar || fan.avatarUrl || fan.avatarThumbs?.c50 || fan.avatarThumbs?.c144 ||
    subscriber.avatar || subscriber.avatarUrl || subscriber.avatarThumbs?.c50 || subscriber.avatarThumbs?.c144,
    1000
  );

  return { username, name, avatarUrl };
}

function normalizeValueStatsRow(row = {}) {
  return {
    valueSnapshotMembers: dbNumber(row.valueSnapshotMembers),
    valuePendingMembers: 0,
    valuePayingFans: dbNumber(row.valuePayingFans),
    fanValueCents: dbNumber(row.fanValueCents),
    valueMessagesCents: dbNumber(row.valueMessagesCents),
    valueTipsCents: dbNumber(row.valueTipsCents),
    valueSubscribesCents: dbNumber(row.valueSubscribesCents),
    valuePostsCents: dbNumber(row.valuePostsCents),
    valueStreamsCents: dbNumber(row.valueStreamsCents),
    lastValueFetchedAt: row.lastValueFetchedAt || null,
  };
}

function stableHash(parts) {
  return crypto.createHash("sha1").update((parts || []).map((x) => String(x ?? "")).join("|"), "utf8").digest("hex");
}

function utcDay(value) {
  const d = asDate(value) || new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}


async function recomputeTrafficDailyAggregate(tx, { agencyId, creatorId, sourceId, day }) {
  if (!sourceId || !day) return null;
  const dayStart = utcDay(day);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const [subscriptionAgg, source] = await Promise.all([
    tx.creatorSubscriptionLedger.aggregate({
      where: {
        agencyId,
        creatorId,
        sourceId,
        occurredAt: { gte: dayStart, lt: dayEnd },
      },
      _count: { _all: true },
      _sum: { amountCents: true },
    }),
    tx.trafficSource.findUnique({ where: { id: sourceId }, select: { costCents: true } }),
  ]);

  const paidSubs = Number(subscriptionAgg?._count?._all || 0);
  const grossCents = Number(subscriptionAgg?._sum?.amountCents || 0);
  const costCents = Number(source?.costCents || 0);

  return tx.trafficDailyAggregate.upsert({
    where: { sourceId_day: { sourceId, day: dayStart } },
    create: {
      agencyId,
      creatorId,
      sourceId,
      day: dayStart,
      paidSubs,
      grossCents,
      netCents: grossCents,
      costCents,
    },
    update: {
      paidSubs,
      grossCents,
      netCents: grossCents,
      costCents,
    },
  });
}

async function applySubscriptionSideEffects(tx, { agencyId, creatorId, fanId, sourceId, occurredAt }) {
  if (sourceId && fanId) {
    await tx.trafficSourceMember.updateMany({
      where: { agencyId, creatorId, sourceId, fanId },
      data: {
        lastRevenueAt: occurredAt,
        convertedAt: occurredAt,
        needsValueRefresh: true,
      },
    });
  }

  if (sourceId) {
    await recomputeTrafficDailyAggregate(tx, { agencyId, creatorId, sourceId, day: occurredAt });
  }
}

function rangeWindow(rangeKey = "all", now = new Date()) {
  const key = String(rangeKey || "all").toLowerCase();
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
    if (s.length > max) {
      console.warn(`[traffic] metadata dropped/truncated, size=${s.length}, max=${max}`);
      return { truncated: true, originalSize: s.length };
    }
    return value;
  } catch (err) {
    console.warn(`[traffic] metadata json failed: ${err?.message || err}`);
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
    fanUsername: clean(input.fanUsername || input.username || input.login, 120),
    fanName: clean(input.fanName || input.name || input.displayName, 160),
    fanAvatar: clean(input.fanAvatar || input.avatarUrl || input.avatar, 1000),
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

// Write/ingest path: device-bound, because Electron workers mutate traffic data from a local OF session.
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


async function upsertTrafficSourceScan({ deviceId, userId, creatorId, accountId, sources = [], members = [], hydrateLimit = 1000, forceHydrate = false }) {
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

  const normalizedMembers = [];
  const missingSourceKeys = new Map();
  for (const input of Array.isArray(members) ? members : []) {
    const member = normalizeMember(input);
    if (!member) continue;
    const key = `${member.sourceType}:${member.sourceExternalId}`;
    normalizedMembers.push({ member, key });
    if (!sourceMap.has(key)) {
      missingSourceKeys.set(key, { sourceType: member.sourceType, externalId: member.sourceExternalId });
    }
  }

  const missingKeys = Array.from(missingSourceKeys.values());
  for (const chunk of chunkArray(missingKeys, 200)) {
    if (!chunk.length) continue;
    const existingSources = await prisma.trafficSource.findMany({
      where: {
        agencyId,
        creatorId: creator.id,
        OR: chunk.map((item) => ({ sourceType: item.sourceType, externalId: item.externalId })),
      },
    });
    for (const row of existingSources) {
      sourceMap.set(`${row.sourceType}:${row.externalId}`, row);
    }
  }

  const memberRowsByKey = new Map();
  for (const { member, key } of normalizedMembers) {
    const source = sourceMap.get(key);
    if (!source?.id) continue;
    const dedupeKey = `${source.id}:${member.fanId}`;
    const prev = memberRowsByKey.get(dedupeKey);
    memberRowsByKey.set(dedupeKey, {
      sourceId: source.id,
      fanId: member.fanId,
      claimedAt: member.claimedAt || prev?.claimedAt || null,
      metadata: member.metadata || prev?.metadata || null,
    });
  }

  const memberRows = Array.from(memberRowsByKey.values());
  let memberUpserts = 0;
  const memberFanIds = Array.from(new Set(memberRows.map((row) => row.fanId)));

  if (memberRows.length) {
    for (const chunk of chunkArray(memberRows, 1000)) {
      const createData = chunk.map((row) => ({
        agencyId,
        creatorId: creator.id,
        sourceId: row.sourceId,
        fanId: row.fanId,
        firstSeenAt: row.claimedAt || now,
        lastSeenAt: now,
        claimedAt: row.claimedAt || null,
        needsValueRefresh: true,
        metadata: row.metadata,
        updatedAt: now,
      }));

      await prisma.trafficSourceMember.createMany({ data: createData, skipDuplicates: true });

      const updatePayload = chunk.map((row) => ({
        sourceId: row.sourceId,
        fanId: row.fanId,
        claimedAt: isoOrNull(row.claimedAt),
        metadata: row.metadata || null,
      }));

      await prisma.$executeRaw`
        UPDATE "TrafficSourceMember" AS m
        SET
          "lastSeenAt" = ${now},
          "claimedAt" = COALESCE(x."claimedAt", m."claimedAt"),
          "metadata" = CASE
            WHEN x."metadata" IS NULL THEN m."metadata"
            ELSE COALESCE(m."metadata", '{}'::jsonb) || x."metadata"
          END,
          "needsValueRefresh" = CASE
            WHEN ${forceHydrate === true} THEN TRUE
            ELSE m."needsValueRefresh"
          END
        FROM jsonb_to_recordset(${JSON.stringify(updatePayload)}::jsonb)
          AS x("sourceId" text, "fanId" text, "claimedAt" timestamptz, "metadata" jsonb)
        WHERE m."agencyId" = ${agencyId}
          AND m."creatorId" = ${creator.id}
          AND m."sourceId" = x."sourceId"
          AND m."fanId" = x."fanId"
      `;

      memberUpserts += chunk.length;
    }
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
  const now = new Date();
  const rows = uniqueBy(
    (Array.isArray(snapshots) ? snapshots : []).map(normalizeSnapshot).filter(Boolean).sort((a, b) => {
      return (Number(asDate(a.fetchedAt)?.getTime() || 0) - Number(asDate(b.fetchedAt)?.getTime() || 0));
    }),
    (row) => row.fanId
  );

  if (!rows.length) {
    return { ok: true, agencyId, creatorId: creator.id, deviceId: device.id, upserted: 0 };
  }

  const fanIds = Array.from(new Set(rows.map((row) => row.fanId)));
  let upserted = 0;

  for (const chunk of chunkArray(rows, 500)) {
    const createData = chunk.map((row) => ({
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
      updatedAt: now,
    }));

    await prisma.trafficFanValueSnapshot.createMany({ data: createData, skipDuplicates: true });

    const updatePayload = chunk.map((row) => ({
      fanId: row.fanId,
      totalSummCents: row.totalSummCents,
      messagesSummCents: row.messagesSummCents,
      tipsSummCents: row.tipsSummCents,
      subscribesSummCents: row.subscribesSummCents,
      postsSummCents: row.postsSummCents,
      streamsSummCents: row.streamsSummCents,
      lastActivity: isoOrNull(row.lastActivity),
      fetchedAt: isoOrNull(row.fetchedAt) || now.toISOString(),
      source: row.source || "fan_value_core",
    }));

    await prisma.$executeRaw`
      UPDATE "TrafficFanValueSnapshot" AS v
      SET
        "totalSummCents" = x."totalSummCents",
        "messagesSummCents" = x."messagesSummCents",
        "tipsSummCents" = x."tipsSummCents",
        "subscribesSummCents" = x."subscribesSummCents",
        "postsSummCents" = x."postsSummCents",
        "streamsSummCents" = x."streamsSummCents",
        "lastActivity" = x."lastActivity",
        "fetchedAt" = x."fetchedAt",
        "source" = COALESCE(x."source", v."source"),
        "updatedAt" = NOW()
      FROM jsonb_to_recordset(${JSON.stringify(updatePayload)}::jsonb)
        AS x(
          "fanId" text,
          "totalSummCents" int,
          "messagesSummCents" int,
          "tipsSummCents" int,
          "subscribesSummCents" int,
          "postsSummCents" int,
          "streamsSummCents" int,
          "lastActivity" timestamptz,
          "fetchedAt" timestamptz,
          "source" text
        )
      WHERE v."agencyId" = ${agencyId}
        AND v."creatorId" = ${creator.id}
        AND v."fanId" = x."fanId"
    `;

    const identityPayload = chunk
      .map((row) => {
        const identity = {
          ...(row.fanUsername ? { fanUsername: row.fanUsername } : {}),
          ...(row.fanName ? { fanName: row.fanName } : {}),
          ...(row.fanAvatar ? { fanAvatar: row.fanAvatar } : {}),
        };
        return Object.keys(identity).length ? { fanId: row.fanId, metadata: identity } : null;
      })
      .filter(Boolean);

    if (identityPayload.length) {
      await prisma.$executeRaw`
        UPDATE "TrafficSourceMember" AS m
        SET "metadata" = COALESCE(m."metadata", '{}'::jsonb) || x."metadata"
        FROM jsonb_to_recordset(${JSON.stringify(identityPayload)}::jsonb)
          AS x("fanId" text, "metadata" jsonb)
        WHERE m."agencyId" = ${agencyId}
          AND m."creatorId" = ${creator.id}
          AND m."fanId" = x."fanId"
      `;
    }

    upserted += chunk.length;
  }

  await prisma.trafficSourceMember.updateMany({
    where: { agencyId, creatorId: creator.id, fanId: { in: fanIds } },
    data: {
      lastValueFetchedAt: now,
      needsValueRefresh: false,
    },
  });

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

  try {
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.creatorSubscriptionLedger.create({ data });
      await applySubscriptionSideEffects(tx, {
        agencyId,
        creatorId: creator.id,
        fanId: row.fanId,
        sourceId: row.sourceId,
        occurredAt: row.occurredAt,
      });
      return row;
    });

    return { ok: true, ledgerId: created.id, sourceId: created.sourceId, amountCents };
  } catch (err) {
    if (err?.code !== "P2002") throw err;

    const existing = await prisma.creatorSubscriptionLedger.findUnique({
      where: { agencyId_eventHash: { agencyId, eventHash } },
      select: { id: true, fanId: true, sourceId: true, occurredAt: true, amountCents: true },
    });

    if (existing) {
      await prisma.$transaction(async (tx) => {
        await applySubscriptionSideEffects(tx, {
          agencyId,
          creatorId: creator.id,
          fanId: existing.fanId,
          sourceId: existing.sourceId,
          occurredAt: existing.occurredAt,
        });
      });
    }

    return { ok: true, duplicate: true, repaired: !!existing, eventHash };
  }
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
    select: { id: true, role: true, roleKey: true },
  });
  if (!member) {
    const err = new Error("Not a member of this agency");
    err.code = "NOT_A_MEMBER";
    throw err;
  }

  return { creator, member };
}

async function getTrafficValueStats({ agencyId, creatorId, sourceIds = [] }) {
  const uniqueSourceIds = Array.from(new Set((sourceIds || []).map((id) => clean(id, 180)).filter(Boolean)));
  const bySource = new Map();
  const totals = valueStatsSeed();

  if (!uniqueSourceIds.length) {
    return { bySource, totals };
  }

  const sourceRows = await prisma.$queryRaw`
    SELECT
      m."sourceId" AS "sourceId",
      COUNT(v."fanId")::bigint AS "valueSnapshotMembers",
      COUNT(CASE WHEN v."totalSummCents" > 0 THEN 1 END)::bigint AS "valuePayingFans",
      COALESCE(SUM(v."totalSummCents"), 0)::bigint AS "fanValueCents",
      COALESCE(SUM(v."messagesSummCents"), 0)::bigint AS "valueMessagesCents",
      COALESCE(SUM(v."tipsSummCents"), 0)::bigint AS "valueTipsCents",
      COALESCE(SUM(v."subscribesSummCents"), 0)::bigint AS "valueSubscribesCents",
      COALESCE(SUM(v."postsSummCents"), 0)::bigint AS "valuePostsCents",
      COALESCE(SUM(v."streamsSummCents"), 0)::bigint AS "valueStreamsCents",
      MAX(v."fetchedAt") AS "lastValueFetchedAt"
    FROM "TrafficSourceMember" m
    LEFT JOIN "TrafficFanValueSnapshot" v
      ON v."agencyId" = m."agencyId"
     AND v."creatorId" = m."creatorId"
     AND v."fanId" = m."fanId"
    WHERE m."agencyId" = ${agencyId}
      AND m."creatorId" = ${creatorId}
      AND m."sourceId" IN (${Prisma.join(uniqueSourceIds)})
    GROUP BY m."sourceId"
  `;

  for (const row of sourceRows || []) {
    bySource.set(String(row.sourceId), normalizeValueStatsRow(row));
  }

  const totalRows = await prisma.$queryRaw`
    SELECT
      COUNT(*)::bigint AS "valueSnapshotMembers",
      COUNT(CASE WHEN x."totalSummCents" > 0 THEN 1 END)::bigint AS "valuePayingFans",
      COALESCE(SUM(x."totalSummCents"), 0)::bigint AS "fanValueCents",
      COALESCE(SUM(x."messagesSummCents"), 0)::bigint AS "valueMessagesCents",
      COALESCE(SUM(x."tipsSummCents"), 0)::bigint AS "valueTipsCents",
      COALESCE(SUM(x."subscribesSummCents"), 0)::bigint AS "valueSubscribesCents",
      COALESCE(SUM(x."postsSummCents"), 0)::bigint AS "valuePostsCents",
      COALESCE(SUM(x."streamsSummCents"), 0)::bigint AS "valueStreamsCents",
      MAX(x."fetchedAt") AS "lastValueFetchedAt"
    FROM (
      SELECT DISTINCT ON (m."fanId")
        m."fanId",
        v."totalSummCents",
        v."messagesSummCents",
        v."tipsSummCents",
        v."subscribesSummCents",
        v."postsSummCents",
        v."streamsSummCents",
        v."fetchedAt"
      FROM "TrafficSourceMember" m
      JOIN "TrafficFanValueSnapshot" v
        ON v."agencyId" = m."agencyId"
       AND v."creatorId" = m."creatorId"
       AND v."fanId" = m."fanId"
      WHERE m."agencyId" = ${agencyId}
        AND m."creatorId" = ${creatorId}
      ORDER BY m."fanId", v."fetchedAt" DESC
    ) x
  `;

  return {
    bySource,
    totals: normalizeValueStatsRow((totalRows || [])[0] || {}),
  };
}

async function getTrafficSourceMembers({ userId, creatorId, sourceId, rangeKey = "all", limit = 100, offset = 0, onlyPaying = false }) {
  const { creator } = await assertTrafficViewer({ userId, creatorId });
  const id = clean(sourceId, 180);
  if (!id) {
    const err = new Error("Source id is required");
    err.code = "TRAFFIC_SOURCE_ID_REQUIRED";
    throw err;
  }

  const take = Math.max(1, Math.min(500, Number(limit || 100)));
  const skip = Math.max(0, Number(offset || 0));

  if (id === "unattributed_paid_subscriptions") {
    const range = rangeWindow(rangeKey);
    const where = {
      agencyId: creator.agencyId,
      creatorId: creator.id,
      sourceId: null,
    };
    if (range.start || range.end) {
      where.occurredAt = {};
      if (range.start) where.occurredAt.gte = range.start;
      if (range.end) where.occurredAt.lt = range.end;
    }

    const [rows, totalCount] = await Promise.all([
      prisma.creatorSubscriptionLedger.groupBy({
        by: ["fanId"],
        where,
        _sum: { amountCents: true },
        _count: { _all: true },
        orderBy: { _sum: { amountCents: "desc" } },
        take,
        skip,
      }),
      prisma.creatorSubscriptionLedger.groupBy({ by: ["fanId"], where, _count: { _all: true } }),
    ]);

    const members = rows.map((row) => ({
      fanId: String(row.fanId),
      fanUsername: null,
      fanName: null,
      displayName: String(row.fanId),
      totalSummCents: Number(row._sum?.amountCents || 0),
      messagesSummCents: 0,
      tipsSummCents: 0,
      subscribesSummCents: Number(row._sum?.amountCents || 0),
      postsSummCents: 0,
      streamsSummCents: 0,
      fetchedAt: null,
      claimedAt: null,
      firstSeenAt: null,
      lastSeenAt: null,
      pendingValue: false,
      ledgerSubscriptions: Number(row._count?._all || 0),
      ledgerRevenueCents: Number(row._sum?.amountCents || 0),
    }));

    return {
      ok: true,
      source: {
        id,
        sourceType: "paid_unknown",
        sourceLabel: sourceLabel("paid_unknown"),
        name: "Paid subscriptions · unknown source",
        externalId: "unattributed",
      },
      totals: {
        members: Number(totalCount?.length || 0),
        fetched: members.length,
        pending: 0,
        buyers: members.filter((row) => Number(row.totalSummCents || 0) > 0).length,
        fanValueCents: members.reduce((acc, row) => acc + Number(row.totalSummCents || 0), 0),
        messagesSummCents: 0,
        tipsSummCents: 0,
        subscribesSummCents: members.reduce((acc, row) => acc + Number(row.subscribesSummCents || 0), 0),
      },
      members,
      pagination: { limit: take, offset: skip, returned: members.length, hasMore: skip + members.length < Number(totalCount?.length || 0) },
    };
  }

  const source = await prisma.trafficSource.findFirst({
    where: { id, agencyId: creator.agencyId, creatorId: creator.id },
    select: {
      id: true,
      sourceType: true,
      externalId: true,
      name: true,
      status: true,
      url: true,
      costCents: true,
      currency: true,
      lastScannedAt: true,
      updatedAt: true,
    },
  });

  if (!source) {
    const err = new Error("Traffic source not found");
    err.code = "TRAFFIC_SOURCE_NOT_FOUND";
    throw err;
  }

  const rows = await prisma.$queryRaw`
    SELECT
      m."fanId" AS "fanId",
      m."metadata" AS "metadata",
      m."firstSeenAt" AS "firstSeenAt",
      m."lastSeenAt" AS "lastSeenAt",
      m."claimedAt" AS "claimedAt",
      m."convertedAt" AS "convertedAt",
      m."lastValueFetchedAt" AS "lastValueFetchedAt",
      m."needsValueRefresh" AS "needsValueRefresh",
      COALESCE(v."totalSummCents", 0)::bigint AS "totalSummCents",
      COALESCE(v."messagesSummCents", 0)::bigint AS "messagesSummCents",
      COALESCE(v."tipsSummCents", 0)::bigint AS "tipsSummCents",
      COALESCE(v."subscribesSummCents", 0)::bigint AS "subscribesSummCents",
      COALESCE(v."postsSummCents", 0)::bigint AS "postsSummCents",
      COALESCE(v."streamsSummCents", 0)::bigint AS "streamsSummCents",
      v."fetchedAt" AS "fetchedAt",
      COALESCE(l."paidSubscriptions", 0)::bigint AS "ledgerSubscriptions",
      COALESCE(l."ledgerRevenueCents", 0)::bigint AS "ledgerRevenueCents"
    FROM "TrafficSourceMember" m
    LEFT JOIN "TrafficFanValueSnapshot" v
      ON v."agencyId" = m."agencyId"
     AND v."creatorId" = m."creatorId"
     AND v."fanId" = m."fanId"
    LEFT JOIN (
      SELECT "fanId", COUNT(*)::bigint AS "paidSubscriptions", COALESCE(SUM("amountCents"), 0)::bigint AS "ledgerRevenueCents"
      FROM "CreatorSubscriptionLedger"
      WHERE "agencyId" = ${creator.agencyId}
        AND "creatorId" = ${creator.id}
        AND "sourceId" = ${source.id}
      GROUP BY "fanId"
    ) l ON l."fanId" = m."fanId"
    WHERE m."agencyId" = ${creator.agencyId}
      AND m."creatorId" = ${creator.id}
      AND m."sourceId" = ${source.id}
      AND (${onlyPaying === true} = false OR COALESCE(v."totalSummCents", 0) > 0)
    ORDER BY COALESCE(v."totalSummCents", 0) DESC, m."lastSeenAt" DESC, m."fanId" ASC
    LIMIT ${take}
    OFFSET ${skip}
  `;

  const countRows = await prisma.$queryRaw`
    SELECT
      COUNT(*)::bigint AS "members",
      COUNT(v."fanId")::bigint AS "fetched",
      COUNT(CASE WHEN COALESCE(v."totalSummCents", 0) > 0 THEN 1 END)::bigint AS "buyers",
      COALESCE(SUM(v."totalSummCents"), 0)::bigint AS "fanValueCents",
      COALESCE(SUM(v."messagesSummCents"), 0)::bigint AS "messagesSummCents",
      COALESCE(SUM(v."tipsSummCents"), 0)::bigint AS "tipsSummCents",
      COALESCE(SUM(v."subscribesSummCents"), 0)::bigint AS "subscribesSummCents",
      COALESCE(SUM(v."postsSummCents"), 0)::bigint AS "postsSummCents",
      COALESCE(SUM(v."streamsSummCents"), 0)::bigint AS "streamsSummCents"
    FROM "TrafficSourceMember" m
    LEFT JOIN "TrafficFanValueSnapshot" v
      ON v."agencyId" = m."agencyId"
     AND v."creatorId" = m."creatorId"
     AND v."fanId" = m."fanId"
    WHERE m."agencyId" = ${creator.agencyId}
      AND m."creatorId" = ${creator.id}
      AND m."sourceId" = ${source.id}
  `;

  const totalsRow = (countRows || [])[0] || {};
  const members = (rows || []).map((row) => {
    const identity = extractMemberIdentity(row.metadata || {});
    const username = identity.username || null;
    const name = identity.name || null;
    const displayName = username ? `@${username}` : (name || String(row.fanId || ""));
    return {
      fanId: String(row.fanId || ""),
      fanUsername: username,
      fanName: name,
      avatarUrl: identity.avatarUrl || null,
      displayName,
      totalSummCents: dbNumber(row.totalSummCents),
      messagesSummCents: dbNumber(row.messagesSummCents),
      tipsSummCents: dbNumber(row.tipsSummCents),
      subscribesSummCents: dbNumber(row.subscribesSummCents),
      postsSummCents: dbNumber(row.postsSummCents),
      streamsSummCents: dbNumber(row.streamsSummCents),
      fetchedAt: row.fetchedAt || null,
      pendingValue: !row.fetchedAt,
      firstSeenAt: row.firstSeenAt || null,
      lastSeenAt: row.lastSeenAt || null,
      claimedAt: row.claimedAt || null,
      convertedAt: row.convertedAt || null,
      lastValueFetchedAt: row.lastValueFetchedAt || null,
      needsValueRefresh: row.needsValueRefresh === true,
      ledgerSubscriptions: dbNumber(row.ledgerSubscriptions),
      ledgerRevenueCents: dbNumber(row.ledgerRevenueCents),
    };
  });

  const totalMembers = dbNumber(totalsRow.members);
  const fetched = dbNumber(totalsRow.fetched);
  return {
    ok: true,
    source: {
      ...source,
      sourceLabel: sourceLabel(source.sourceType),
    },
    totals: {
      members: totalMembers,
      fetched,
      pending: Math.max(0, totalMembers - fetched),
      buyers: dbNumber(totalsRow.buyers),
      fanValueCents: dbNumber(totalsRow.fanValueCents),
      messagesSummCents: dbNumber(totalsRow.messagesSummCents),
      tipsSummCents: dbNumber(totalsRow.tipsSummCents),
      subscribesSummCents: dbNumber(totalsRow.subscribesSummCents),
      postsSummCents: dbNumber(totalsRow.postsSummCents),
      streamsSummCents: dbNumber(totalsRow.streamsSummCents),
    },
    members,
    pagination: {
      limit: take,
      offset: skip,
      returned: members.length,
      hasMore: skip + members.length < (onlyPaying ? dbNumber(totalsRow.buyers) : totalMembers),
    },
  };
}

async function getTrafficOverview({ userId, creatorId, rangeKey = "all" }) {
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

  const [sources, membersCount, revenue, lastTrafficJob] = await Promise.all([
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
    prisma.jobInstance.findFirst({
      where: {
        agencyId: creator.agencyId,
        creatorId: creator.id,
        jobKey: TRAFFIC_SOURCES_SCAN_JOB_KEY,
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        status: true,
        attempts: true,
        createdAt: true,
        claimedAt: true,
        completedAt: true,
        nextRunAt: true,
        leaseUntil: true,
        lastError: true,
        result: true,
        params: true,
      },
    }),
  ]);

  const valueStats = await getTrafficValueStats({
    agencyId: creator.agencyId,
    creatorId: creator.id,
    sourceIds: sources.map((source) => source.id),
  });

  const revenueBySource = new Map(revenue.map((row) => [row.sourceId || "", row]));
  const rows = sources.map((source) => {
    const rev = revenueBySource.get(source.id);
    const claimers = source._count.members;
    const paidSubscriptions = Number(rev?._count?._all || 0);
    const revenueCents = Number(rev?._sum?.amountCents || 0);
    const costCents = Number(source.costCents || 0);
    const value = { ...valueStatsSeed(), ...(valueStats.bySource.get(source.id) || {}) };
    value.valuePendingMembers = Math.max(0, claimers - Number(value.valueSnapshotMembers || 0));
    const roiPercent = costCents > 0 ? ((revenueCents - costCents) / costCents) * 100 : null;
    const valueRoiPercent = costCents > 0 ? ((Number(value.fanValueCents || 0) - costCents) / costCents) * 100 : null;
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
      currency: source.currency || "USD",
      roiPercent,
      valueRoiPercent,
      valueSnapshotMembers: value.valueSnapshotMembers,
      valuePendingMembers: value.valuePendingMembers,
      valuePayingFans: value.valuePayingFans,
      fanValueCents: value.fanValueCents,
      valueMessagesCents: value.valueMessagesCents,
      valueTipsCents: value.valueTipsCents,
      valueSubscribesCents: value.valueSubscribesCents,
      valuePostsCents: value.valuePostsCents,
      valueStreamsCents: value.valueStreamsCents,
      lastValueFetchedAt: value.lastValueFetchedAt,
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
      valueRoiPercent: null,
      valueSnapshotMembers: 0,
      valuePendingMembers: 0,
      valuePayingFans: unknownPaidSubscriptions,
      fanValueCents: unknownRevenueCents,
      valueMessagesCents: 0,
      valueTipsCents: 0,
      valueSubscribesCents: unknownRevenueCents,
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
      valueSnapshotMembers: 0,
      valuePendingMembers: 0,
      valuePayingFans: 0,
      fanValueCents: 0,
      valueMessagesCents: 0,
      valueTipsCents: 0,
      valueSubscribesCents: 0,
    };
    cur.sources += row.isUnattributed ? 0 : 1;
    cur.claimers += Number(row.claimers || 0);
    cur.paidSubscriptions += Number(row.paidSubscriptions || 0);
    cur.revenueCents += Number(row.revenueCents || 0);
    cur.costCents += Number(row.costCents || 0);
    cur.valueSnapshotMembers += Number(row.valueSnapshotMembers || 0);
    cur.valuePendingMembers += Number(row.valuePendingMembers || 0);
    cur.valuePayingFans += Number(row.valuePayingFans || 0);
    cur.fanValueCents += Number(row.fanValueCents || 0);
    cur.valueMessagesCents += Number(row.valueMessagesCents || 0);
    cur.valueTipsCents += Number(row.valueTipsCents || 0);
    cur.valueSubscribesCents += Number(row.valueSubscribesCents || 0);
    bucketsByType.set(key, cur);
  }

  const subscriptionRevenueCents = revenue.reduce((acc, row) => acc + Number(row._sum.amountCents || 0), 0);
  const paidSubscriptions = revenue.reduce((acc, row) => acc + Number(row._count?._all || 0), 0);
  const trackedRevenueCents = subscriptionRevenueCents - unknownRevenueCents;
  const trackedPaidSubscriptions = paidSubscriptions - unknownPaidSubscriptions;
  const uniqueValue = valueStats.totals || valueStatsSeed();
  const valueSnapshotMembers = Number(uniqueValue.valueSnapshotMembers || 0);
  const valuePendingMembers = Math.max(0, membersCount - valueSnapshotMembers);
  const valuePayingFans = Number(uniqueValue.valuePayingFans || 0);

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
      valueSnapshotMembers,
      valuePendingMembers,
      valuePayingFans,
      fanValueCents: Number(uniqueValue.fanValueCents || 0),
      valueMessagesCents: Number(uniqueValue.valueMessagesCents || 0),
      valueTipsCents: Number(uniqueValue.valueTipsCents || 0),
      valueSubscribesCents: Number(uniqueValue.valueSubscribesCents || 0),
      valuePostsCents: Number(uniqueValue.valuePostsCents || 0),
      valueStreamsCents: Number(uniqueValue.valueStreamsCents || 0),
      lastValueFetchedAt: uniqueValue.lastValueFetchedAt || null,
    },
    buckets: Array.from(bucketsByType.values()).sort((a, b) => Number((b.fanValueCents || b.revenueCents) || 0) - Number((a.fanValueCents || a.revenueCents) || 0)),
    sources: rows.sort((a, b) => Number((b.fanValueCents || b.revenueCents) || 0) - Number((a.fanValueCents || a.revenueCents) || 0)),
    lastTrafficJob: lastTrafficJob ? {
      id: lastTrafficJob.id,
      status: lastTrafficJob.status,
      attempts: lastTrafficJob.attempts,
      createdAt: lastTrafficJob.createdAt,
      claimedAt: lastTrafficJob.claimedAt,
      completedAt: lastTrafficJob.completedAt,
      nextRunAt: lastTrafficJob.nextRunAt,
      leaseUntil: lastTrafficJob.leaseUntil,
      lastError: lastTrafficJob.lastError,
      result: lastTrafficJob.result || null,
      params: lastTrafficJob.params || null,
    } : null,
  };
}


function isSeniorTrafficMember(member) {
  const role = String(member?.role || "").toUpperCase();
  const roleKey = String(member?.roleKey || "").toLowerCase();
  return role === "OWNER" || role === "MANAGER" || role === "ADMIN" || ["owner", "manager", "admin"].includes(roleKey);
}

async function recomputeTrafficDailyAggregatesForSource({ agencyId, creatorId, sourceId, chunkSize = 30 } = {}) {
  const cleanSourceId = clean(sourceId, 180);
  if (!agencyId || !creatorId || !cleanSourceId) {
    return { ok: false, days: 0, recomputedDays: 0, code: "BAD_RECOMPUTE_INPUT" };
  }

  const days = await prisma.trafficDailyAggregate.findMany({
    where: { agencyId, creatorId, sourceId: cleanSourceId },
    select: { day: true },
    orderBy: { day: "desc" },
  });

  let recomputedDays = 0;
  for (const chunk of chunkArray(days, chunkSize)) {
    await prisma.$transaction(async (tx) => {
      for (const { day } of chunk) {
        await recomputeTrafficDailyAggregate(tx, {
          agencyId,
          creatorId,
          sourceId: cleanSourceId,
          day,
        });
        recomputedDays += 1;
      }
    }, {
      maxWait: 10_000,
      timeout: 60_000,
    });
  }

  return { ok: true, days: days.length, recomputedDays };
}

async function updateTrafficSourceCost({ userId, creatorId, sourceId, costCents, currency }) {
  const { creator, member } = await assertTrafficViewer({ userId, creatorId });

  // Cost/ROI is a financial setting. Keep it owner/manager/admin-only so
  // chatters cannot manipulate promo performance by zeroing source cost.
  if (!isSeniorTrafficMember(member)) {
    const err = new Error("Only OWNER / manager / admin can update traffic source cost");
    err.code = "INSUFFICIENT_TEAM_ROLE";
    throw err;
  }

  const cleanSourceId = clean(sourceId, 180);
  if (!cleanSourceId) {
    const err = new Error("Traffic source id is required");
    err.code = "TRAFFIC_SOURCE_NOT_FOUND";
    throw err;
  }

  const nextCostCents = cents(costCents);

  // Keep the financial write itself short and atomic. Daily aggregates can span
  // hundreds of days, so recomputing them inside the same transaction can hit
  // Prisma/host transaction timeouts and roll back the actual cost update.
  const updated = await prisma.$transaction(async (tx) => {
    const source = await tx.trafficSource.findFirst({
      where: {
        id: cleanSourceId,
        agencyId: creator.agencyId,
        creatorId: creator.id,
      },
      select: {
        id: true,
        agencyId: true,
        creatorId: true,
        currency: true,
      },
    });

    if (!source) {
      const err = new Error("Traffic source not found");
      err.code = "TRAFFIC_SOURCE_NOT_FOUND";
      throw err;
    }

    return tx.trafficSource.update({
      where: { id: source.id },
      data: {
        costCents: nextCostCents,
        currency: clean(currency, 16) || source.currency || "USD",
      },
    });
  }, {
    maxWait: 10_000,
    timeout: 20_000,
  });

  // TrafficDailyAggregate stores a denormalized costCents copy for fast
  // dashboard reads. Recompute from the ledger source of truth in small
  // transactions so old long-lived campaigns do not lock one huge transaction.
  let recompute = { ok: true, days: 0, recomputedDays: 0 };
  try {
    recompute = await recomputeTrafficDailyAggregatesForSource({
      agencyId: creator.agencyId,
      creatorId: creator.id,
      sourceId: updated.id,
      chunkSize: 30,
    });
  } catch (err) {
    console.warn("[traffic] source cost updated but aggregate recompute failed", {
      sourceId: updated.id,
      error: err?.message || String(err),
    });
    recompute = {
      ok: false,
      days: 0,
      recomputedDays: 0,
      code: err?.code || "TRAFFIC_AGGREGATE_RECOMPUTE_FAILED",
      message: err?.message || String(err),
    };
  }

  return { ok: true, source: updated, recompute };
}

function cleanHint(value, max = 255) {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, max) : null;
}

async function scheduleTrafficRefresh({ userId, creatorId, force = false, accountHints = {} } = {}) {
  const { creator } = await assertTrafficViewer({ userId, creatorId });

  const localAccountId = cleanHint(
    accountHints.localAccountId ||
    accountHints.accountId ||
    accountHints.accountManifestId ||
    null
  );
  const remoteId = cleanHint(
    accountHints.creatorRemoteId ||
    accountHints.remoteId ||
    creator.remoteId ||
    null
  );
  const username = cleanHint(
    accountHints.creatorUsername ||
    accountHints.username ||
    creator.username ||
    null
  );

  const now = new Date();
  const params = {
    hydrateFanValues: true,
    forceHydrate: force === true,
    hydrateLimit: force === true ? 5000 : 1000,
    valueTtlHours: 6,
    reason: force === true ? "manual_traffic_refresh_force" : "manual_traffic_refresh",
    manualRefreshAt: now.toISOString(),
    // Electron account manifests are local ids, while job.creatorId is the
    // backend CreatorAccount.id. Pass the visible/local account id from the
    // renderer when available, then remote hints as a fallback.
    accountId: localAccountId,
    localAccountId,
    accountManifestId: localAccountId,
    creatorRemoteId: remoteId,
    remoteId,
    creatorUsername: username,
    username,
    creatorDisplayName: cleanHint(accountHints.creatorDisplayName || creator.displayName || null),
  };

  // Manual refresh must not reuse an older SCHEDULED/CLAIMED job that was
  // created by an older app build without localAccountId. That is exactly how
  // we ended up with "job scheduled · saved 0 · Account not found" forever:
  // ensureSingleJob kept returning the stale in-flight job instead of creating
  // a fresh one with the new account hints. The scan/upsert path is idempotent,
  // so a duplicate manual job is safer than silently reusing stale params.
  if (force === true) {
    const job = await prisma.jobInstance.create({
      data: {
        jobKey: TRAFFIC_SOURCES_SCAN_JOB_KEY,
        scope: "creator",
        creatorId: creator.id,
        agencyId: creator.agencyId,
        params,
        priority: 120,
        scheduledAt: now,
        nextRunAt: now,
      },
      select: { id: true, status: true, jobKey: true, createdAt: true, nextRunAt: true, params: true },
    });

    return { ok: true, created: true, forced: true, jobId: job.id, job };
  }

  const decision = await ensureSingleJob({
    jobKey: TRAFFIC_SOURCES_SCAN_JOB_KEY,
    creatorId: creator.id,
    agencyId: creator.agencyId,
    params,
    priority: 100,
    now,
    freshnessWindowMs: Math.min(60_000, TRAFFIC_REFRESH_WINDOW_MS),
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
  getTrafficSourceMembers,
  updateTrafficSourceCost,
  scheduleTrafficRefresh,
};

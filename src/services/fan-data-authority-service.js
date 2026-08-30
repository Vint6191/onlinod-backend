"use strict";

const crypto = require("node:crypto");

const IDENTITY_SOURCE_PRIORITY = Object.freeze({
  USER_PROFILE: 700,
  SUBSCRIBER_DIRECTORY: 600,
  LIVE_MESSAGE: 500,
  PAGE_OBSERVATION: 450,
  LIVE_NOTIFICATION: 400,
  FINANCIAL_TRANSACTION: 350,
  CAMPAIGN_CLAIMER: 300,
  TRAFFIC_ATTRIBUTION: 250,
  PRESENCE_HINT: 100,
  UNKNOWN: 0,
});

const VALUE_AVAILABILITY = Object.freeze({
  AVAILABLE: "AVAILABLE",
  NOT_FETCHED: "NOT_FETCHED",
  UNAVAILABLE: "UNAVAILABLE",
  MALFORMED: "MALFORMED",
});

function text(value, max = 500) {
  const out = String(value ?? "").trim();
  return out ? out.slice(0, max) : null;
}
function onlyFansUserId(value) {
  // OF ids are domain identifiers, not JavaScript numbers. Keep them opaque.
  return text(value, 180);
}
function date(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}
function sourcePriority(source) {
  return IDENTITY_SOURCE_PRIORITY[String(source || "UNKNOWN").toUpperCase()] || 0;
}
function isSyntheticIdentity(value) {
  return /^u\d{1,40}$/i.test(String(value || "").trim());
}
function shouldApplyIdentity(existing, observedAt, source) {
  const currentAt = date(existing?.identityObservedAt);
  if (!currentAt) return true;
  if (observedAt.getTime() !== currentAt.getTime()) return observedAt > currentAt;
  return sourcePriority(source) >= sourcePriority(existing?.identitySource);
}
function identityCompleteness(input) {
  const fields = [input.username, input.platformDisplayName, input.avatarUrl, input.headerUrl];
  const known = fields.filter((value) => text(value)).length;
  return known >= 4 ? "FULL" : known > 0 ? "PARTIAL" : "ID_ONLY";
}
function cleanIdentityFields(input, { rejectSynthetic = false } = {}) {
  const username = text(input.username, 200)?.replace(/^@+/, "") || null;
  const platformDisplayName = text(input.platformDisplayName ?? input.displayName, 500);
  return {
    username: rejectSynthetic && isSyntheticIdentity(username) ? null : username,
    platformDisplayName: rejectSynthetic && isSyntheticIdentity(platformDisplayName) ? null : platformDisplayName,
    avatarUrl: text(input.avatarUrl, 1200),
    headerUrl: text(input.headerUrl, 1200),
  };
}

async function ensureFanRecord(tx, observation) {
  const externalId = onlyFansUserId(observation.onlyFansUserId);
  const observedAt = date(observation.observedAt);
  if (!externalId || !observedAt) throw new Error("Invalid fan observation identity");
  const where = { creatorId_onlyFansUserId: { creatorId: observation.creatorId, onlyFansUserId: externalId } };
  let fan = await tx.creatorFan.findUnique({ where });
  if (!fan && typeof tx.creatorFan.findMany === "function") {
    const rows = await tx.creatorFan.findMany({ where: { creatorId: observation.creatorId, onlyFansUserId: externalId }, take: 1 });
    fan = rows?.[0] || null;
  }
  if (fan) return fan;
  const identity = cleanIdentityFields(observation, { rejectSynthetic: observation.rejectSyntheticIdentity === true });
  const activityAt = date(observation.activityObservedAt);
  try {
    fan = await tx.creatorFan.create({
      data: {
        id: crypto.randomUUID(),
        agencyId: observation.agencyId,
        creatorId: observation.creatorId,
        onlyFansUserId: externalId,
        username: identity.username,
        displayName: identity.platformDisplayName,
        avatarUrl: identity.avatarUrl,
        headerUrl: identity.headerUrl,
        identityObservedAt: observedAt,
        identitySource: text(observation.source, 80) || "UNKNOWN",
        identityCompleteness: identityCompleteness(identity),
        firstSeenAt: activityAt || observedAt,
        lastSeenAt: activityAt || observedAt,
        lastActivityObservedAt: activityAt,
      },
    });
    return fan;
  } catch (error) {
    if (error?.code !== "P2002") throw error;
    fan = await tx.creatorFan.findUnique({ where });
    if (!fan && typeof tx.creatorFan.findMany === "function") {
      const rows = await tx.creatorFan.findMany({ where: { creatorId: observation.creatorId, onlyFansUserId: externalId }, take: 1 });
      fan = rows?.[0] || null;
    }
    if (!fan) throw error;
    return fan;
  }
}

async function projectFanIdentity(tx, observation) {
  const externalId = onlyFansUserId(observation.onlyFansUserId);
  const observedAt = date(observation.observedAt);
  if (!externalId || !observedAt) throw new Error("Invalid FanIdentityObservation");
  const where = { creatorId_onlyFansUserId: { creatorId: observation.creatorId, onlyFansUserId: externalId } };
  let fan = await tx.creatorFan.findUnique({ where });
  if (!fan) return ensureFanRecord(tx, observation);

  const data = {};
  const activityAt = date(observation.activityObservedAt);
  if (activityAt) {
    const currentActivity = date(fan.lastActivityObservedAt) || date(fan.lastSeenAt);
    if (!currentActivity || activityAt > currentActivity) {
      data.lastActivityObservedAt = activityAt;
      data.lastSeenAt = activityAt;
    }
    if (date(fan.firstSeenAt) > activityAt) data.firstSeenAt = activityAt;
  }

  if (shouldApplyIdentity(fan, observedAt, observation.source)) {
    const incoming = cleanIdentityFields(observation, { rejectSynthetic: observation.rejectSyntheticIdentity === true });
    if (incoming.username) data.username = incoming.username;
    if (incoming.platformDisplayName) data.displayName = incoming.platformDisplayName;
    if (incoming.avatarUrl) data.avatarUrl = incoming.avatarUrl;
    if (incoming.headerUrl) data.headerUrl = incoming.headerUrl;
    data.identityObservedAt = observedAt;
    data.identitySource = text(observation.source, 80) || "UNKNOWN";
    data.identityCompleteness = text(observation.completeness, 40) || identityCompleteness(incoming);
  }

  if (!Object.keys(data).length) return fan;
  return tx.creatorFan.update({ where: { id: fan.id }, data });
}

function relationshipData(observation) {
  const result = {};
  const boolFields = [
    "fanSubscribesToCreator",
    "fanSubscriptionActive",
    "creatorFollowsFan",
    "canReceiveChatMessage",
    "blocked",
    "restricted",
    "performer",
  ];
  for (const field of boolFields) if (typeof observation[field] === "boolean") result[field] = observation[field];
  const dateFields = ["fanSubscriptionExpiresAt", "creatorFollowExpiresAt", "lastSeenAt"];
  for (const field of dateFields) {
    if (observation[field] === null) result[field] = null;
    else if (observation[field] !== undefined) {
      const parsed = date(observation[field]);
      if (parsed) result[field] = parsed;
    }
  }
  if (observation.fanSubscriptionType !== undefined) result.fanSubscriptionType = text(observation.fanSubscriptionType, 100);
  if (observation.subscribePriceCents === null) result.subscribePriceCents = null;
  else if (Number.isSafeInteger(observation.subscribePriceCents) && observation.subscribePriceCents >= 0) result.subscribePriceCents = observation.subscribePriceCents;
  return result;
}

async function projectFanIdentityBatch(tx, observations) {
  const normalized = [];
  const aggregate = new Map();
  for (const raw of observations || []) {
    const externalId = onlyFansUserId(raw.onlyFansUserId);
    const observedAt = date(raw.observedAt);
    if (!raw?.agencyId || !raw?.creatorId || !externalId || !observedAt) continue;
    const key = `${raw.creatorId}\u0000${externalId}`;
    const identity = cleanIdentityFields(raw, { rejectSynthetic: raw.rejectSyntheticIdentity === true });
    const activityAt = date(raw.activityObservedAt);
    const candidate = {
      agencyId: raw.agencyId,
      creatorId: raw.creatorId,
      onlyFansUserId: externalId,
      ...identity,
      observedAt,
      activityAt,
      source: text(raw.source, 80) || "UNKNOWN",
      sourcePriority: sourcePriority(raw.source),
      completeness: text(raw.completeness, 40) || identityCompleteness(identity),
    };
    const current = aggregate.get(key);
    if (!current) {
      aggregate.set(key, { ...candidate, firstSeenAt: activityAt || observedAt, lastActivityAt: activityAt });
      continue;
    }
    if ((activityAt || observedAt) < current.firstSeenAt) current.firstSeenAt = activityAt || observedAt;
    if (activityAt && (!current.lastActivityAt || activityAt > current.lastActivityAt)) current.lastActivityAt = activityAt;
    if (observedAt > current.observedAt || (observedAt.getTime() === current.observedAt.getTime() && candidate.sourcePriority >= current.sourcePriority)) {
      candidate.firstSeenAt = current.firstSeenAt;
      candidate.lastActivityAt = current.lastActivityAt;
      aggregate.set(key, candidate);
    }
  }
  normalized.push(...aggregate.values());
  if (!normalized.length) return new Map();

  await tx.creatorFan.createMany({
    data: normalized.map((item) => ({
      id: crypto.randomUUID(),
      agencyId: item.agencyId,
      creatorId: item.creatorId,
      onlyFansUserId: item.onlyFansUserId,
      username: item.username,
      displayName: item.platformDisplayName,
      avatarUrl: item.avatarUrl,
      headerUrl: item.headerUrl,
      identityObservedAt: item.observedAt,
      identitySource: item.source,
      identityCompleteness: item.completeness,
      firstSeenAt: item.firstSeenAt,
      lastSeenAt: item.lastActivityAt || item.firstSeenAt,
      lastActivityObservedAt: item.lastActivityAt,
    })),
    skipDuplicates: true,
  });

  if (typeof tx.$executeRawUnsafe === "function") {
    const prioritySql = `(CASE fan."identitySource"
      WHEN 'USER_PROFILE' THEN 700 WHEN 'SUBSCRIBER_DIRECTORY' THEN 600 WHEN 'LIVE_MESSAGE' THEN 500
      WHEN 'PAGE_OBSERVATION' THEN 450 WHEN 'LIVE_NOTIFICATION' THEN 400 WHEN 'FINANCIAL_TRANSACTION' THEN 350
      WHEN 'CAMPAIGN_CLAIMER' THEN 300 WHEN 'TRAFFIC_ATTRIBUTION' THEN 250 WHEN 'PRESENCE_HINT' THEN 100 ELSE 0 END)`;
    for (let offset = 0; offset < normalized.length; offset += 500) {
      const rows = normalized.slice(offset, offset + 500);
      const params = [];
      const tuples = rows.map((item) => {
        const n = params.length;
        params.push(
          item.creatorId, item.onlyFansUserId, item.username, item.platformDisplayName, item.avatarUrl, item.headerUrl,
          item.observedAt, item.source, item.sourcePriority, item.completeness, item.firstSeenAt, item.lastActivityAt,
        );
        return `($${n+1}::text,$${n+2}::text,$${n+3}::text,$${n+4}::text,$${n+5}::text,$${n+6}::text,$${n+7}::timestamptz,$${n+8}::text,$${n+9}::int,$${n+10}::text,$${n+11}::timestamptz,$${n+12}::timestamptz)`;
      });
      const sql = `
        UPDATE "CreatorFan" AS fan SET
          "firstSeenAt" = LEAST(fan."firstSeenAt", incoming."firstSeenAt"),
          "lastActivityObservedAt" = CASE WHEN incoming."lastActivityAt" IS NOT NULL AND (fan."lastActivityObservedAt" IS NULL OR incoming."lastActivityAt" > fan."lastActivityObservedAt") THEN incoming."lastActivityAt" ELSE fan."lastActivityObservedAt" END,
          "lastSeenAt" = CASE WHEN incoming."lastActivityAt" IS NOT NULL AND incoming."lastActivityAt" > fan."lastSeenAt" THEN incoming."lastActivityAt" ELSE fan."lastSeenAt" END,
          "username" = CASE WHEN incoming."observedAt" > COALESCE(fan."identityObservedAt", '-infinity'::timestamptz) OR (incoming."observedAt" = fan."identityObservedAt" AND incoming."sourcePriority" >= ${prioritySql}) THEN COALESCE(incoming."username", fan."username") ELSE fan."username" END,
          "displayName" = CASE WHEN incoming."observedAt" > COALESCE(fan."identityObservedAt", '-infinity'::timestamptz) OR (incoming."observedAt" = fan."identityObservedAt" AND incoming."sourcePriority" >= ${prioritySql}) THEN COALESCE(incoming."displayName", fan."displayName") ELSE fan."displayName" END,
          "avatarUrl" = CASE WHEN incoming."observedAt" > COALESCE(fan."identityObservedAt", '-infinity'::timestamptz) OR (incoming."observedAt" = fan."identityObservedAt" AND incoming."sourcePriority" >= ${prioritySql}) THEN COALESCE(incoming."avatarUrl", fan."avatarUrl") ELSE fan."avatarUrl" END,
          "headerUrl" = CASE WHEN incoming."observedAt" > COALESCE(fan."identityObservedAt", '-infinity'::timestamptz) OR (incoming."observedAt" = fan."identityObservedAt" AND incoming."sourcePriority" >= ${prioritySql}) THEN COALESCE(incoming."headerUrl", fan."headerUrl") ELSE fan."headerUrl" END,
          "identityObservedAt" = CASE WHEN incoming."observedAt" > COALESCE(fan."identityObservedAt", '-infinity'::timestamptz) OR (incoming."observedAt" = fan."identityObservedAt" AND incoming."sourcePriority" >= ${prioritySql}) THEN incoming."observedAt" ELSE fan."identityObservedAt" END,
          "identitySource" = CASE WHEN incoming."observedAt" > COALESCE(fan."identityObservedAt", '-infinity'::timestamptz) OR (incoming."observedAt" = fan."identityObservedAt" AND incoming."sourcePriority" >= ${prioritySql}) THEN incoming."source" ELSE fan."identitySource" END,
          "identityCompleteness" = CASE WHEN incoming."observedAt" > COALESCE(fan."identityObservedAt", '-infinity'::timestamptz) OR (incoming."observedAt" = fan."identityObservedAt" AND incoming."sourcePriority" >= ${prioritySql}) THEN incoming."completeness" ELSE fan."identityCompleteness" END,
          "updatedAt" = NOW()
        FROM (VALUES ${tuples.join(',')}) AS incoming(
          "creatorId","onlyFansUserId","username","displayName","avatarUrl","headerUrl","observedAt","source","sourcePriority","completeness","firstSeenAt","lastActivityAt"
        )
        WHERE fan."creatorId" = incoming."creatorId" AND fan."onlyFansUserId" = incoming."onlyFansUserId"`;
      await tx.$executeRawUnsafe(sql, ...params);
    }
  } else {
    for (const item of normalized) await projectFanIdentity(tx, {
      ...item,
      platformDisplayName: item.platformDisplayName,
      activityObservedAt: item.lastActivityAt,
    });
  }
  const creators = [...new Set(normalized.map((item) => item.creatorId))];
  const ids = [...new Set(normalized.map((item) => item.onlyFansUserId))];
  const fans = await tx.creatorFan.findMany({ where: { creatorId: { in: creators }, onlyFansUserId: { in: ids } } });
  return new Map(fans.map((fan) => [`${fan.creatorId}\u0000${fan.onlyFansUserId}`, fan]));
}


async function projectFanRelationship(tx, observation) {
  const externalId = onlyFansUserId(observation.onlyFansUserId);
  const observedAt = date(observation.observedAt);
  if (!externalId || !observedAt) throw new Error("Invalid CreatorFanRelationshipObservation");
  const fan = await ensureFanRecord(tx, { ...observation, username: null, platformDisplayName: null });
  const where = { creatorId_onlyFansUserId: { creatorId: observation.creatorId, onlyFansUserId: externalId } };
  const existing = await tx.creatorFanRelationshipCurrent.findUnique({ where });
  const fields = relationshipData(observation);
  if (existing?.observedAt && date(existing.observedAt) >= observedAt) return existing;
  const data = {
    agencyId: observation.agencyId,
    creatorId: observation.creatorId,
    fanRecordId: fan.id,
    onlyFansUserId: externalId,
    ...fields,
    observedAt,
    source: text(observation.source, 80) || "UNKNOWN",
    sourceDeviceId: text(observation.sourceDeviceId, 180),
    sourceJobId: text(observation.sourceJobId, 180),
    scanRunId: text(observation.scanRunId, 180),
  };
  return tx.creatorFanRelationshipCurrent.upsert({ where, create: data, update: data });
}

function nullableBigInt(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "bigint") return value >= 0n ? value : null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? BigInt(number) : null;
}
function normalizeAvailability(value) {
  const key = String(value || "NOT_FETCHED").toUpperCase();
  return VALUE_AVAILABILITY[key] || VALUE_AVAILABILITY.UNAVAILABLE;
}

async function projectFanValue(tx, observation) {
  const externalId = onlyFansUserId(observation.onlyFansUserId);
  const observedAt = date(observation.observedAt);
  if (!externalId || !observedAt) throw new Error("Invalid CreatorFanValueObservation");
  const fan = await ensureFanRecord(tx, { ...observation, username: null, platformDisplayName: null });
  const where = { creatorId_fanRecordId: { creatorId: observation.creatorId, fanRecordId: fan.id } };
  const existing = await tx.creatorFanValueCurrent.findUnique({ where });
  const currentAt = date(existing?.valueObservedAt ?? existing?.fetchedAt);
  if (currentAt && currentAt >= observedAt) return { record: existing, replay: true, fanRecordId: fan.id };

  const availability = normalizeAvailability(observation.availability);
  const numeric = {
    platformReportedTotalSpendCents: nullableBigInt(observation.totalSpentCents ?? observation.platformReportedTotalSpendCents),
    messagesSpentCents: nullableBigInt(observation.messagesSpentCents),
    subscriptionsSpentCents: nullableBigInt(observation.subscriptionsSpentCents),
    tipsSpentCents: nullableBigInt(observation.tipsSpentCents),
    postsSpentCents: nullableBigInt(observation.postsSpentCents),
    streamsSpentCents: nullableBigInt(observation.streamsSpentCents),
  };
  if (availability === VALUE_AVAILABILITY.AVAILABLE && numeric.platformReportedTotalSpendCents === null) {
    throw new Error("AVAILABLE fan value observation requires a valid totalSpentCents");
  }
  const data = {
    agencyId: observation.agencyId,
    creatorId: observation.creatorId,
    fanRecordId: fan.id,
    availability,
    valueObservedAt: observedAt,
    source: text(observation.source, 80) || "UNKNOWN",
    sourceDeviceId: text(observation.sourceDeviceId, 180),
    sourceJobId: text(observation.sourceJobId, 180),
    scanRunId: text(observation.scanRunId, 180),
  };
  if (availability === VALUE_AVAILABILITY.AVAILABLE) {
    Object.assign(data, numeric);
    if (observation.lastActivityAt === null) data.lastActivityAt = null;
    else if (observation.lastActivityAt !== undefined) data.lastActivityAt = date(observation.lastActivityAt);
  }

  const create = {
    ...data,
    platformReportedTotalSpendCents: numeric.platformReportedTotalSpendCents,
    messagesSpentCents: numeric.messagesSpentCents,
    subscriptionsSpentCents: numeric.subscriptionsSpentCents,
    tipsSpentCents: numeric.tipsSpentCents,
    postsSpentCents: numeric.postsSpentCents,
    streamsSpentCents: numeric.streamsSpentCents,
    lastActivityAt: observation.lastActivityAt === null ? null : date(observation.lastActivityAt),
  };
  if (typeof tx.creatorFanValueCurrent.upsert === "function") {
    return {
      record: await tx.creatorFanValueCurrent.upsert({ where, create, update: data }),
      replay: false, fanRecordId: fan.id,
    };
  }
  if (!existing) return { record: await tx.creatorFanValueCurrent.create({ data: create }), replay: false, fanRecordId: fan.id };
  return { record: await tx.creatorFanValueCurrent.update({ where: { id: existing.id }, data }), replay: false, fanRecordId: fan.id };
}

async function projectSubscriberDirectoryRun(db, { runId, agencyId, creatorId, sourceJobId = null }) {
  if (!text(runId, 180) || !text(agencyId, 180) || !text(creatorId, 180)) throw new Error("Invalid subscriber projection scope");
  if (typeof db.$executeRawUnsafe !== "function") {
    const items = await db.subscriberScanItem.findMany({ where: { runId } });
    let projected = 0;
    for (const item of items) {
      await projectFanIdentity(db, {
        agencyId, creatorId, onlyFansUserId: item.fanId,
        username: item.username, platformDisplayName: item.name, avatarUrl: item.avatarUrl,
        observedAt: item.observedAt, activityObservedAt: item.lastSeenAt,
        source: "SUBSCRIBER_DIRECTORY",
      });
      await projectFanRelationship(db, {
        agencyId, creatorId, onlyFansUserId: item.fanId,
        fanSubscribesToCreator: item.fanSubscribesToCreator ?? item.subscribedOn,
        fanSubscriptionActive: item.fanSubscriptionActive,
        fanSubscriptionType: item.subscriptionType,
        fanSubscriptionExpiresAt: item.fanSubscriptionExpiresAt,
        creatorFollowsFan: item.creatorFollowsFan ?? item.subscribedBy,
        creatorFollowExpiresAt: item.creatorFollowExpiresAt,
        canReceiveChatMessage: item.canReceiveChatMessage,
        blocked: item.blocked, restricted: item.restricted, performer: item.performer,
        lastSeenAt: item.lastSeenAt, subscribePriceCents: item.subscribePriceCents,
        observedAt: item.observedAt, source: "SUBSCRIBER_DIRECTORY", sourceJobId, scanRunId: runId,
      });
      await projectFanValue(db, {
        agencyId, creatorId, onlyFansUserId: item.fanId,
        totalSpentCents: item.totalSpentCents, messagesSpentCents: item.messagesSpentCents,
        tipsSpentCents: item.tipsSpentCents, subscriptionsSpentCents: item.subscriptionsSpentCents,
        postsSpentCents: item.postsSpentCents, streamsSpentCents: item.streamsSpentCents,
        availability: item.valueAvailability, observedAt: item.observedAt,
        source: "SUBSCRIBER_DIRECTORY", sourceJobId, scanRunId: runId,
      });
      projected += 1;
    }
    return { projected };
  }

  // Current identity is a projection of the immutable subscriber observation.
  // It is updated only when this observation wins the identity clock.
  await db.$executeRawUnsafe(`
    INSERT INTO "CreatorFan" (
      "id","agencyId","creatorId","onlyFansUserId","username","displayName","avatarUrl",
      "identityObservedAt","identitySource","identityCompleteness","firstSeenAt","lastSeenAt",
      "lastActivityObservedAt","createdAt","updatedAt"
    )
    SELECT
      'fan_' || md5(i."creatorId" || ':' || i."fanId"), i."agencyId", i."creatorId", i."fanId",
      NULLIF(btrim(i."username"), ''), NULLIF(btrim(i."name"), ''), NULLIF(btrim(i."avatarUrl"), ''),
      i."observedAt", 'SUBSCRIBER_DIRECTORY',
      CASE WHEN i."username" IS NOT NULL OR i."name" IS NOT NULL OR i."avatarUrl" IS NOT NULL THEN 'PARTIAL' ELSE 'ID_ONLY' END,
      COALESCE(i."lastSeenAt", i."observedAt"), COALESCE(i."lastSeenAt", i."observedAt"), i."lastSeenAt", NOW(), NOW()
    FROM "SubscriberScanItem" i
    WHERE i."runId" = $1 AND i."agencyId" = $2 AND i."creatorId" = $3
    ON CONFLICT ("creatorId","onlyFansUserId") DO UPDATE SET
      "firstSeenAt" = LEAST("CreatorFan"."firstSeenAt", EXCLUDED."firstSeenAt"),
      "lastSeenAt" = CASE WHEN EXCLUDED."lastActivityObservedAt" IS NOT NULL AND EXCLUDED."lastActivityObservedAt" > "CreatorFan"."lastSeenAt" THEN EXCLUDED."lastActivityObservedAt" ELSE "CreatorFan"."lastSeenAt" END,
      "lastActivityObservedAt" = CASE WHEN EXCLUDED."lastActivityObservedAt" IS NOT NULL AND ("CreatorFan"."lastActivityObservedAt" IS NULL OR EXCLUDED."lastActivityObservedAt" > "CreatorFan"."lastActivityObservedAt") THEN EXCLUDED."lastActivityObservedAt" ELSE "CreatorFan"."lastActivityObservedAt" END,
      "username" = CASE WHEN EXCLUDED."identityObservedAt" > COALESCE("CreatorFan"."identityObservedAt", '-infinity'::timestamptz) OR (EXCLUDED."identityObservedAt" = "CreatorFan"."identityObservedAt" AND 600 >= CASE "CreatorFan"."identitySource" WHEN 'USER_PROFILE' THEN 700 WHEN 'SUBSCRIBER_DIRECTORY' THEN 600 WHEN 'LIVE_MESSAGE' THEN 500 WHEN 'PAGE_OBSERVATION' THEN 450 WHEN 'LIVE_NOTIFICATION' THEN 400 WHEN 'FINANCIAL_TRANSACTION' THEN 350 WHEN 'CAMPAIGN_CLAIMER' THEN 300 WHEN 'TRAFFIC_ATTRIBUTION' THEN 250 WHEN 'PRESENCE_HINT' THEN 100 ELSE 0 END) THEN COALESCE(EXCLUDED."username", "CreatorFan"."username") ELSE "CreatorFan"."username" END,
      "displayName" = CASE WHEN EXCLUDED."identityObservedAt" > COALESCE("CreatorFan"."identityObservedAt", '-infinity'::timestamptz) OR (EXCLUDED."identityObservedAt" = "CreatorFan"."identityObservedAt" AND 600 >= CASE "CreatorFan"."identitySource" WHEN 'USER_PROFILE' THEN 700 WHEN 'SUBSCRIBER_DIRECTORY' THEN 600 WHEN 'LIVE_MESSAGE' THEN 500 WHEN 'PAGE_OBSERVATION' THEN 450 WHEN 'LIVE_NOTIFICATION' THEN 400 WHEN 'FINANCIAL_TRANSACTION' THEN 350 WHEN 'CAMPAIGN_CLAIMER' THEN 300 WHEN 'TRAFFIC_ATTRIBUTION' THEN 250 WHEN 'PRESENCE_HINT' THEN 100 ELSE 0 END) THEN COALESCE(EXCLUDED."displayName", "CreatorFan"."displayName") ELSE "CreatorFan"."displayName" END,
      "avatarUrl" = CASE WHEN EXCLUDED."identityObservedAt" > COALESCE("CreatorFan"."identityObservedAt", '-infinity'::timestamptz) OR (EXCLUDED."identityObservedAt" = "CreatorFan"."identityObservedAt" AND 600 >= CASE "CreatorFan"."identitySource" WHEN 'USER_PROFILE' THEN 700 WHEN 'SUBSCRIBER_DIRECTORY' THEN 600 WHEN 'LIVE_MESSAGE' THEN 500 WHEN 'PAGE_OBSERVATION' THEN 450 WHEN 'LIVE_NOTIFICATION' THEN 400 WHEN 'FINANCIAL_TRANSACTION' THEN 350 WHEN 'CAMPAIGN_CLAIMER' THEN 300 WHEN 'TRAFFIC_ATTRIBUTION' THEN 250 WHEN 'PRESENCE_HINT' THEN 100 ELSE 0 END) THEN COALESCE(EXCLUDED."avatarUrl", "CreatorFan"."avatarUrl") ELSE "CreatorFan"."avatarUrl" END,
      "identityObservedAt" = CASE WHEN EXCLUDED."identityObservedAt" > COALESCE("CreatorFan"."identityObservedAt", '-infinity'::timestamptz) OR (EXCLUDED."identityObservedAt" = "CreatorFan"."identityObservedAt" AND 600 >= CASE "CreatorFan"."identitySource" WHEN 'USER_PROFILE' THEN 700 WHEN 'SUBSCRIBER_DIRECTORY' THEN 600 WHEN 'LIVE_MESSAGE' THEN 500 WHEN 'PAGE_OBSERVATION' THEN 450 WHEN 'LIVE_NOTIFICATION' THEN 400 WHEN 'FINANCIAL_TRANSACTION' THEN 350 WHEN 'CAMPAIGN_CLAIMER' THEN 300 WHEN 'TRAFFIC_ATTRIBUTION' THEN 250 WHEN 'PRESENCE_HINT' THEN 100 ELSE 0 END) THEN EXCLUDED."identityObservedAt" ELSE "CreatorFan"."identityObservedAt" END,
      "identitySource" = CASE WHEN EXCLUDED."identityObservedAt" > COALESCE("CreatorFan"."identityObservedAt", '-infinity'::timestamptz) OR (EXCLUDED."identityObservedAt" = "CreatorFan"."identityObservedAt" AND 600 >= CASE "CreatorFan"."identitySource" WHEN 'USER_PROFILE' THEN 700 WHEN 'SUBSCRIBER_DIRECTORY' THEN 600 WHEN 'LIVE_MESSAGE' THEN 500 WHEN 'PAGE_OBSERVATION' THEN 450 WHEN 'LIVE_NOTIFICATION' THEN 400 WHEN 'FINANCIAL_TRANSACTION' THEN 350 WHEN 'CAMPAIGN_CLAIMER' THEN 300 WHEN 'TRAFFIC_ATTRIBUTION' THEN 250 WHEN 'PRESENCE_HINT' THEN 100 ELSE 0 END) THEN 'SUBSCRIBER_DIRECTORY' ELSE "CreatorFan"."identitySource" END,
      "identityCompleteness" = CASE WHEN EXCLUDED."identityObservedAt" > COALESCE("CreatorFan"."identityObservedAt", '-infinity'::timestamptz) OR (EXCLUDED."identityObservedAt" = "CreatorFan"."identityObservedAt" AND 600 >= CASE "CreatorFan"."identitySource" WHEN 'USER_PROFILE' THEN 700 WHEN 'SUBSCRIBER_DIRECTORY' THEN 600 WHEN 'LIVE_MESSAGE' THEN 500 WHEN 'PAGE_OBSERVATION' THEN 450 WHEN 'LIVE_NOTIFICATION' THEN 400 WHEN 'FINANCIAL_TRANSACTION' THEN 350 WHEN 'CAMPAIGN_CLAIMER' THEN 300 WHEN 'TRAFFIC_ATTRIBUTION' THEN 250 WHEN 'PRESENCE_HINT' THEN 100 ELSE 0 END) THEN EXCLUDED."identityCompleteness" ELSE "CreatorFan"."identityCompleteness" END,
      "updatedAt" = NOW()
  `, runId, agencyId, creatorId);

  await db.$executeRawUnsafe(`
    INSERT INTO "CreatorFanRelationshipCurrent" (
      "id","agencyId","creatorId","fanRecordId","onlyFansUserId","fanSubscribesToCreator","fanSubscriptionActive",
      "fanSubscriptionType","fanSubscriptionExpiresAt","creatorFollowsFan","creatorFollowExpiresAt","canReceiveChatMessage",
      "blocked","restricted","performer","lastSeenAt","subscribePriceCents","observedAt","source","sourceJobId","scanRunId","createdAt","updatedAt"
    )
    SELECT
      'fan_rel_' || md5(i."creatorId" || ':' || i."fanId"), i."agencyId", i."creatorId", f."id", i."fanId",
      COALESCE(i."fanSubscribesToCreator", i."subscribedOn"), i."fanSubscriptionActive",
      i."subscriptionType", i."fanSubscriptionExpiresAt", COALESCE(i."creatorFollowsFan", i."subscribedBy"), i."creatorFollowExpiresAt",
      i."canReceiveChatMessage", i."blocked", i."restricted", i."performer", i."lastSeenAt", i."subscribePriceCents",
      i."observedAt", 'SUBSCRIBER_DIRECTORY', $4, i."runId", NOW(), NOW()
    FROM "SubscriberScanItem" i
    JOIN "CreatorFan" f ON f."creatorId" = i."creatorId" AND f."onlyFansUserId" = i."fanId"
    WHERE i."runId" = $1 AND i."agencyId" = $2 AND i."creatorId" = $3
    ON CONFLICT ("creatorId","onlyFansUserId") DO UPDATE SET
      "fanRecordId" = EXCLUDED."fanRecordId",
      "fanSubscribesToCreator" = CASE WHEN EXCLUDED."observedAt" > "CreatorFanRelationshipCurrent"."observedAt" THEN COALESCE(EXCLUDED."fanSubscribesToCreator", "CreatorFanRelationshipCurrent"."fanSubscribesToCreator") ELSE "CreatorFanRelationshipCurrent"."fanSubscribesToCreator" END,
      "fanSubscriptionActive" = CASE WHEN EXCLUDED."observedAt" > "CreatorFanRelationshipCurrent"."observedAt" THEN COALESCE(EXCLUDED."fanSubscriptionActive", "CreatorFanRelationshipCurrent"."fanSubscriptionActive") ELSE "CreatorFanRelationshipCurrent"."fanSubscriptionActive" END,
      "fanSubscriptionType" = CASE WHEN EXCLUDED."observedAt" > "CreatorFanRelationshipCurrent"."observedAt" THEN COALESCE(EXCLUDED."fanSubscriptionType", "CreatorFanRelationshipCurrent"."fanSubscriptionType") ELSE "CreatorFanRelationshipCurrent"."fanSubscriptionType" END,
      "fanSubscriptionExpiresAt" = CASE WHEN EXCLUDED."observedAt" > "CreatorFanRelationshipCurrent"."observedAt" THEN COALESCE(EXCLUDED."fanSubscriptionExpiresAt", "CreatorFanRelationshipCurrent"."fanSubscriptionExpiresAt") ELSE "CreatorFanRelationshipCurrent"."fanSubscriptionExpiresAt" END,
      "creatorFollowsFan" = CASE WHEN EXCLUDED."observedAt" > "CreatorFanRelationshipCurrent"."observedAt" THEN COALESCE(EXCLUDED."creatorFollowsFan", "CreatorFanRelationshipCurrent"."creatorFollowsFan") ELSE "CreatorFanRelationshipCurrent"."creatorFollowsFan" END,
      "creatorFollowExpiresAt" = CASE WHEN EXCLUDED."observedAt" > "CreatorFanRelationshipCurrent"."observedAt" THEN COALESCE(EXCLUDED."creatorFollowExpiresAt", "CreatorFanRelationshipCurrent"."creatorFollowExpiresAt") ELSE "CreatorFanRelationshipCurrent"."creatorFollowExpiresAt" END,
      "canReceiveChatMessage" = CASE WHEN EXCLUDED."observedAt" > "CreatorFanRelationshipCurrent"."observedAt" THEN COALESCE(EXCLUDED."canReceiveChatMessage", "CreatorFanRelationshipCurrent"."canReceiveChatMessage") ELSE "CreatorFanRelationshipCurrent"."canReceiveChatMessage" END,
      "blocked" = CASE WHEN EXCLUDED."observedAt" > "CreatorFanRelationshipCurrent"."observedAt" THEN COALESCE(EXCLUDED."blocked", "CreatorFanRelationshipCurrent"."blocked") ELSE "CreatorFanRelationshipCurrent"."blocked" END,
      "restricted" = CASE WHEN EXCLUDED."observedAt" > "CreatorFanRelationshipCurrent"."observedAt" THEN COALESCE(EXCLUDED."restricted", "CreatorFanRelationshipCurrent"."restricted") ELSE "CreatorFanRelationshipCurrent"."restricted" END,
      "performer" = CASE WHEN EXCLUDED."observedAt" > "CreatorFanRelationshipCurrent"."observedAt" THEN COALESCE(EXCLUDED."performer", "CreatorFanRelationshipCurrent"."performer") ELSE "CreatorFanRelationshipCurrent"."performer" END,
      "lastSeenAt" = CASE WHEN EXCLUDED."observedAt" > "CreatorFanRelationshipCurrent"."observedAt" THEN COALESCE(EXCLUDED."lastSeenAt", "CreatorFanRelationshipCurrent"."lastSeenAt") ELSE "CreatorFanRelationshipCurrent"."lastSeenAt" END,
      "subscribePriceCents" = CASE WHEN EXCLUDED."observedAt" > "CreatorFanRelationshipCurrent"."observedAt" THEN COALESCE(EXCLUDED."subscribePriceCents", "CreatorFanRelationshipCurrent"."subscribePriceCents") ELSE "CreatorFanRelationshipCurrent"."subscribePriceCents" END,
      "observedAt" = GREATEST(EXCLUDED."observedAt", "CreatorFanRelationshipCurrent"."observedAt"),
      "source" = CASE WHEN EXCLUDED."observedAt" > "CreatorFanRelationshipCurrent"."observedAt" THEN EXCLUDED."source" ELSE "CreatorFanRelationshipCurrent"."source" END,
      "sourceJobId" = CASE WHEN EXCLUDED."observedAt" > "CreatorFanRelationshipCurrent"."observedAt" THEN EXCLUDED."sourceJobId" ELSE "CreatorFanRelationshipCurrent"."sourceJobId" END,
      "scanRunId" = CASE WHEN EXCLUDED."observedAt" > "CreatorFanRelationshipCurrent"."observedAt" THEN EXCLUDED."scanRunId" ELSE "CreatorFanRelationshipCurrent"."scanRunId" END,
      "updatedAt" = NOW()
  `, runId, agencyId, creatorId, sourceJobId);

  await db.$executeRawUnsafe(`
    INSERT INTO "CreatorFanValueCurrent" (
      "id","agencyId","creatorId","fanId","totalNetCents","messagesNetCents","subscriptionsNetCents","tipsNetCents","postsNetCents","streamsNetCents",
      "lastActivityAt","fetchedAt","availability","source","sourceJobId","scanRunId","createdAt","updatedAt"
    )
    SELECT
      'fan_value_' || md5(i."creatorId" || ':' || i."fanId"), i."agencyId", i."creatorId", f."id",
      CASE WHEN i."valueAvailability" = 'AVAILABLE' THEN i."totalSpentCents"::bigint ELSE NULL END,
      CASE WHEN i."valueAvailability" = 'AVAILABLE' THEN i."messagesSpentCents"::bigint ELSE NULL END,
      CASE WHEN i."valueAvailability" = 'AVAILABLE' THEN i."subscriptionsSpentCents"::bigint ELSE NULL END,
      CASE WHEN i."valueAvailability" = 'AVAILABLE' THEN i."tipsSpentCents"::bigint ELSE NULL END,
      CASE WHEN i."valueAvailability" = 'AVAILABLE' THEN i."postsSpentCents"::bigint ELSE NULL END,
      CASE WHEN i."valueAvailability" = 'AVAILABLE' THEN i."streamsSpentCents"::bigint ELSE NULL END,
      NULL, i."observedAt", i."valueAvailability", 'SUBSCRIBER_DIRECTORY', $4, i."runId", NOW(), NOW()
    FROM "SubscriberScanItem" i
    JOIN "CreatorFan" f ON f."creatorId" = i."creatorId" AND f."onlyFansUserId" = i."fanId"
    WHERE i."runId" = $1 AND i."agencyId" = $2 AND i."creatorId" = $3
    ON CONFLICT ("creatorId","fanId") DO UPDATE SET
      "totalNetCents" = CASE WHEN EXCLUDED."fetchedAt" > "CreatorFanValueCurrent"."fetchedAt" AND EXCLUDED."availability" = 'AVAILABLE' THEN EXCLUDED."totalNetCents" ELSE "CreatorFanValueCurrent"."totalNetCents" END,
      "messagesNetCents" = CASE WHEN EXCLUDED."fetchedAt" > "CreatorFanValueCurrent"."fetchedAt" AND EXCLUDED."availability" = 'AVAILABLE' THEN EXCLUDED."messagesNetCents" ELSE "CreatorFanValueCurrent"."messagesNetCents" END,
      "subscriptionsNetCents" = CASE WHEN EXCLUDED."fetchedAt" > "CreatorFanValueCurrent"."fetchedAt" AND EXCLUDED."availability" = 'AVAILABLE' THEN EXCLUDED."subscriptionsNetCents" ELSE "CreatorFanValueCurrent"."subscriptionsNetCents" END,
      "tipsNetCents" = CASE WHEN EXCLUDED."fetchedAt" > "CreatorFanValueCurrent"."fetchedAt" AND EXCLUDED."availability" = 'AVAILABLE' THEN EXCLUDED."tipsNetCents" ELSE "CreatorFanValueCurrent"."tipsNetCents" END,
      "postsNetCents" = CASE WHEN EXCLUDED."fetchedAt" > "CreatorFanValueCurrent"."fetchedAt" AND EXCLUDED."availability" = 'AVAILABLE' THEN EXCLUDED."postsNetCents" ELSE "CreatorFanValueCurrent"."postsNetCents" END,
      "streamsNetCents" = CASE WHEN EXCLUDED."fetchedAt" > "CreatorFanValueCurrent"."fetchedAt" AND EXCLUDED."availability" = 'AVAILABLE' THEN EXCLUDED."streamsNetCents" ELSE "CreatorFanValueCurrent"."streamsNetCents" END,
      "availability" = CASE WHEN EXCLUDED."fetchedAt" > "CreatorFanValueCurrent"."fetchedAt" THEN EXCLUDED."availability" ELSE "CreatorFanValueCurrent"."availability" END,
      "source" = CASE WHEN EXCLUDED."fetchedAt" > "CreatorFanValueCurrent"."fetchedAt" THEN EXCLUDED."source" ELSE "CreatorFanValueCurrent"."source" END,
      "sourceJobId" = CASE WHEN EXCLUDED."fetchedAt" > "CreatorFanValueCurrent"."fetchedAt" THEN EXCLUDED."sourceJobId" ELSE "CreatorFanValueCurrent"."sourceJobId" END,
      "scanRunId" = CASE WHEN EXCLUDED."fetchedAt" > "CreatorFanValueCurrent"."fetchedAt" THEN EXCLUDED."scanRunId" ELSE "CreatorFanValueCurrent"."scanRunId" END,
      "fetchedAt" = GREATEST(EXCLUDED."fetchedAt", "CreatorFanValueCurrent"."fetchedAt"),
      "updatedAt" = NOW()
  `, runId, agencyId, creatorId, sourceJobId);

  const count = await db.subscriberScanItem.count({ where: { runId } });
  return { projected: count };
}

const FAN_DATA_POINT_REFRESH_JOB_KEY = "fan_data_point_refresh";

function numberOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : null;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

async function projectFanObservationBatch(db, { agencyId, creatorId, sourceDeviceId = null, sourceJobId = null, items = [] } = {}) {
  if (!text(agencyId, 180) || !text(creatorId, 180)) throw new Error("Invalid fan observation batch scope");
  const rows = Array.isArray(items) ? items.slice(0, 500) : [];
  const apply = async (tx) => {
    let identityProjected = 0;
    let relationshipProjected = 0;
    let valueProjected = 0;
    const touchedFanIds = [];
    for (const raw of rows) {
      const externalId = onlyFansUserId(raw?.onlyFansUserId);
      if (!externalId) continue;
      const identity = raw.identity && typeof raw.identity === "object" ? raw.identity : null;
      const relationship = raw.relationship && typeof raw.relationship === "object" ? raw.relationship : null;
      const value = raw.value && typeof raw.value === "object" ? raw.value : null;
      const common = { agencyId, creatorId, onlyFansUserId: externalId, sourceDeviceId, sourceJobId };
      if (identity) {
        await projectFanIdentity(tx, { ...common, ...identity });
        identityProjected += 1;
      } else if (relationship || value) {
        await ensureFanRecord(tx, { ...common, observedAt: relationship?.observedAt || value?.observedAt || new Date(), source: relationship?.source || value?.source || "UNKNOWN" });
      }
      if (relationship) {
        await projectFanRelationship(tx, { ...common, ...relationship });
        relationshipProjected += 1;
      }
      if (value) {
        await projectFanValue(tx, { ...common, ...value });
        valueProjected += 1;
      }
      touchedFanIds.push(externalId);
    }
    return { ok: true, projected: rows.length, identityProjected, relationshipProjected, valueProjected, touchedFanIds };
  };
  if (typeof db.$transaction === "function") return db.$transaction((tx) => apply(tx));
  return apply(db);
}

async function applyFanDataPointRefreshChunk({ db, job, deviceId, chunkResult }) {
  if (!job?.creatorId || !job?.agencyId) throw new Error("fan_data_point_refresh job is missing creator scope");
  if (text(chunkResult?.kind, 80) !== "fan_data_point_refresh") throw new Error("Unsupported fan data point refresh chunk");
  const items = Array.isArray(chunkResult?.items) ? chunkResult.items : [];
  const result = await projectFanObservationBatch(db, {
    agencyId: job.agencyId,
    creatorId: job.creatorId,
    sourceDeviceId: deviceId,
    sourceJobId: job.id,
    items,
  });
  const successfulValueIds = items
    .filter((item) => item?.value && typeof item.value === "object" && normalizeAvailability(item.value.availability) === VALUE_AVAILABILITY.AVAILABLE)
    .map((item) => onlyFansUserId(item.onlyFansUserId))
    .filter(Boolean);
  if (successfulValueIds.length && db.trafficSourceMember?.updateMany) {
    await db.trafficSourceMember.updateMany({
      where: { agencyId: job.agencyId, creatorId: job.creatorId, fanId: { in: successfulValueIds } },
      data: { needsValueRefresh: false, lastValueFetchedAt: date(chunkResult.observedAt) || new Date() },
    });
  }
  return { type: "fan_data_point_refresh", ...result };
}

async function scheduleFanDataPointRefresh({ agencyId, creatorId, onlyFansUserIds = [], reason = "fan_data_point_refresh", priority = 95, now = new Date(), params = {} } = {}) {
  if (!text(agencyId, 180) || !text(creatorId, 180)) return { created: false, reason: "missing_scope" };
  const ids = [...new Set((onlyFansUserIds || []).map(onlyFansUserId).filter(Boolean))].sort().slice(0, 500);
  if (!ids.length) return { created: false, reason: "no_fan_ids" };
  const { ensureSingleJob } = require("./job-scheduler");
  // Generic creator-wide coalescing would drop a second refresh batch while a
  // different batch is in flight. Range by the exact opaque OF-id set instead:
  // same batch dedupes, different batches remain independently claimable.
  const rangeKey = `fan-data:${crypto.createHash("sha256").update(ids.join("\n")).digest("hex").slice(0, 24)}`;
  const stableParams = { ...params };
  delete stableParams.scheduledFromObservationAt;
  delete stableParams.reason;
  return ensureSingleJob({
    jobKey: FAN_DATA_POINT_REFRESH_JOB_KEY,
    creatorId,
    agencyId,
    params: { ...stableParams, fanIds: ids, rangeKey, requestReason: text(reason, 120) || "fan_data_point_refresh" },
    priority,
    now,
    freshnessWindowMs: 2 * 60 * 1000,
  });
}


async function readFanCurrent(db, { agencyId, creatorId, onlyFansUserIds }) {
  const ids = [...new Set((onlyFansUserIds || []).map(onlyFansUserId).filter(Boolean))];
  if (!ids.length) return [];
  const fans = await db.creatorFan.findMany({
    where: { agencyId, creatorId, onlyFansUserId: { in: ids } },
    include: { valueCurrent: true, relationshipCurrent: true },
  });
  return fans.map((fan) => ({
    fanRecordId: fan.id,
    creatorId: fan.creatorId,
    onlyFansUserId: fan.onlyFansUserId,
    platformIdentity: {
      username: fan.username || null,
      platformDisplayName: fan.displayName || null,
      avatarUrl: fan.avatarUrl || null,
      headerUrl: fan.headerUrl || null,
      observedAt: fan.identityObservedAt || null,
      source: fan.identitySource || null,
      completeness: fan.identityCompleteness || null,
    },
    relationship: fan.relationshipCurrent ? {
      fanSubscribesToCreator: fan.relationshipCurrent.fanSubscribesToCreator,
      fanSubscriptionActive: fan.relationshipCurrent.fanSubscriptionActive,
      fanSubscriptionType: fan.relationshipCurrent.fanSubscriptionType,
      fanSubscriptionExpiresAt: fan.relationshipCurrent.fanSubscriptionExpiresAt,
      creatorFollowsFan: fan.relationshipCurrent.creatorFollowsFan,
      creatorFollowExpiresAt: fan.relationshipCurrent.creatorFollowExpiresAt,
      canReceiveChatMessage: fan.relationshipCurrent.canReceiveChatMessage,
      blocked: fan.relationshipCurrent.blocked,
      restricted: fan.relationshipCurrent.restricted,
      performer: fan.relationshipCurrent.performer,
      lastSeenAt: fan.relationshipCurrent.lastSeenAt,
      subscribePriceCents: fan.relationshipCurrent.subscribePriceCents,
      observedAt: fan.relationshipCurrent.observedAt,
      source: fan.relationshipCurrent.source,
    } : null,
    value: fan.valueCurrent ? {
      platformReportedTotalSpendCents: numberOrNull(fan.valueCurrent.platformReportedTotalSpendCents),
      messagesSpentCents: numberOrNull(fan.valueCurrent.messagesSpentCents),
      subscriptionsSpentCents: numberOrNull(fan.valueCurrent.subscriptionsSpentCents),
      tipsSpentCents: numberOrNull(fan.valueCurrent.tipsSpentCents),
      postsSpentCents: numberOrNull(fan.valueCurrent.postsSpentCents),
      streamsSpentCents: numberOrNull(fan.valueCurrent.streamsSpentCents),
      lastActivityAt: fan.valueCurrent.lastActivityAt,
      availability: fan.valueCurrent.availability,
      observedAt: fan.valueCurrent.valueObservedAt,
      source: fan.valueCurrent.source,
    } : null,
  }));
}

module.exports = {
  IDENTITY_SOURCE_PRIORITY,
  VALUE_AVAILABILITY,
  FAN_DATA_POINT_REFRESH_JOB_KEY,
  onlyFansUserId,
  projectFanIdentity,
  projectFanIdentityBatch,
  projectFanRelationship,
  projectFanValue,
  projectSubscriberDirectoryRun,
  projectFanObservationBatch,
  applyFanDataPointRefreshChunk,
  scheduleFanDataPointRefresh,
  readFanCurrent,
};

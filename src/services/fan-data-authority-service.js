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
  TRAFFIC_LEGACY_MIGRATION: 50,
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

const IDENTITY_FIELDS = Object.freeze([
  ["username", "username", "usernameAuthorityVersion"],
  ["platformDisplayName", "displayName", "displayNameAuthorityVersion"],
  ["avatarUrl", "avatarUrl", "avatarAuthorityVersion"],
  ["headerUrl", "headerUrl", "headerAuthorityVersion"],
]);

const RELATIONSHIP_FIELDS = Object.freeze([
  ["fanSubscribesToCreator", "fanSubscribesToCreatorAuthorityVersion"],
  ["fanSubscriptionActive", "fanSubscriptionActiveAuthorityVersion"],
  ["fanSubscriptionType", "fanSubscriptionTypeAuthorityVersion"],
  ["fanSubscriptionExpiresAt", "fanSubscriptionExpiresAtAuthorityVersion"],
  ["creatorFollowsFan", "creatorFollowsFanAuthorityVersion"],
  ["creatorFollowExpiresAt", "creatorFollowExpiresAtAuthorityVersion"],
  ["canReceiveChatMessage", "canReceiveChatMessageAuthorityVersion"],
  ["blocked", "blockedAuthorityVersion"],
  ["restricted", "restrictedAuthorityVersion"],
  ["performer", "performerAuthorityVersion"],
  ["lastSeenAt", "lastSeenAtAuthorityVersion"],
  ["subscribePriceCents", "subscribePriceCentsAuthorityVersion"],
]);

const VALUE_FIELDS = Object.freeze([
  ["platformReportedTotalSpendCents", "platformReportedTotalSpendCentsAuthorityVersion"],
  ["messagesSpentCents", "messagesSpentCentsAuthorityVersion"],
  ["subscriptionsSpentCents", "subscriptionsSpentCentsAuthorityVersion"],
  ["tipsSpentCents", "tipsSpentCentsAuthorityVersion"],
  ["postsSpentCents", "postsSpentCentsAuthorityVersion"],
  ["streamsSpentCents", "streamsSpentCentsAuthorityVersion"],
]);

function stableAuthorityValue(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (Array.isArray(value)) return `[${value.map(stableAuthorityValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableAuthorityValue(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function authorityVersion(observedAt, source, value) {
  const at = date(observedAt);
  if (!at) throw new Error("Invalid authority observation timestamp");
  const normalizedSource = text(source, 80) || "UNKNOWN";
  const priority = String(sourcePriority(normalizedSource)).padStart(4, "0");
  const digest = crypto.createHash("sha256").update(stableAuthorityValue(value)).digest("hex").slice(0, 24);
  return `${at.toISOString()}|${priority}|${normalizedSource}|${digest}`;
}

function newerVersionWhere(field, version) {
  return { OR: [{ [field]: null }, { [field]: { lt: version } }] };
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
  const activityAt = date(observation.activityObservedAt);
  try {
    fan = await tx.creatorFan.create({
      data: {
        id: crypto.randomUUID(),
        agencyId: observation.agencyId,
        creatorId: observation.creatorId,
        onlyFansUserId: externalId,
        // Identity is projected only by projectFanIdentity. Merely learning an OF id
        // from relationship/value/presence must never manufacture identity freshness.
        username: null,
        displayName: null,
        avatarUrl: null,
        headerUrl: null,
        identityObservedAt: null,
        identitySource: null,
        identityCompleteness: null,
        identityAuthorityVersion: null,
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

async function projectFanActivity(tx, fanId, activityObservedAt) {
  const activityAt = date(activityObservedAt);
  if (!activityAt || typeof tx.creatorFan.updateMany !== "function") return;
  await tx.creatorFan.updateMany({
    where: { id: fanId, firstSeenAt: { gt: activityAt } },
    data: { firstSeenAt: activityAt },
  });
  await tx.creatorFan.updateMany({
    where: { id: fanId, OR: [{ lastActivityObservedAt: null }, { lastActivityObservedAt: { lt: activityAt } }] },
    data: { lastActivityObservedAt: activityAt },
  });
  await tx.creatorFan.updateMany({
    where: { id: fanId, lastSeenAt: { lt: activityAt } },
    data: { lastSeenAt: activityAt },
  });
}

async function projectFanIdentity(tx, observation) {
  const externalId = onlyFansUserId(observation.onlyFansUserId);
  const observedAt = date(observation.observedAt);
  if (!externalId || !observedAt) throw new Error("Invalid FanIdentityObservation");
  const source = text(observation.source, 80) || "UNKNOWN";
  const fan = await ensureFanRecord(tx, observation);
  await projectFanActivity(tx, fan.id, observation.activityObservedAt);

  // Presence is temporal telemetry, never canonical identity authority. Keep this
  // fail-safe at the projector boundary so a stale caller cannot reintroduce F13.
  if (source === "PRESENCE_HINT") {
    const where = { creatorId_onlyFansUserId: { creatorId: observation.creatorId, onlyFansUserId: externalId } };
    return (await tx.creatorFan.findUnique({ where })) || fan;
  }

  const incoming = cleanIdentityFields(observation, { rejectSynthetic: observation.rejectSyntheticIdentity === true });
  let accepted = 0;
  for (const [incomingField, dbField, versionField] of IDENTITY_FIELDS) {
    const value = incoming[incomingField];
    if (value === null) continue;
    const version = authorityVersion(observedAt, source, value);
    const result = await tx.creatorFan.updateMany({
      where: { id: fan.id, ...newerVersionWhere(versionField, version) },
      data: { [dbField]: value, [versionField]: version },
    });
    accepted += Number(result?.count || 0);
  }

  // A rejected/synthetic/ID-only observation has zero accepted identity fields and
  // therefore cannot advance the identity clock. The aggregate clock is metadata
  // only; field authority is decided by the per-field versions above.
  if (accepted > 0) {
    const identityVersion = authorityVersion(observedAt, source, incoming);
    await tx.creatorFan.updateMany({
      where: { id: fan.id, ...newerVersionWhere("identityAuthorityVersion", identityVersion) },
      data: {
        identityObservedAt: observedAt,
        identitySource: source,
        identityAuthorityVersion: identityVersion,
      },
    });
  }

  const where = { creatorId_onlyFansUserId: { creatorId: observation.creatorId, onlyFansUserId: externalId } };
  let current = await tx.creatorFan.findUnique({ where });
  if (current && accepted > 0) {
    const completeness = identityCompleteness({
      username: current.username,
      platformDisplayName: current.displayName,
      avatarUrl: current.avatarUrl,
      headerUrl: current.headerUrl,
    });
    await tx.creatorFan.updateMany({ where: { id: current.id }, data: { identityCompleteness: completeness } });
    current = { ...current, identityCompleteness: completeness };
  }
  return current || fan;
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
  for (const field of boolFields) {
    if (observation[field] === null) result[field] = null;
    else if (typeof observation[field] === "boolean") result[field] = observation[field];
  }
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
  for (const raw of observations || []) {
    const externalId = onlyFansUserId(raw?.onlyFansUserId);
    const observedAt = date(raw?.observedAt);
    if (!raw?.agencyId || !raw?.creatorId || !externalId || !observedAt) continue;
    normalized.push({ ...raw, onlyFansUserId: externalId, observedAt });
  }
  if (!normalized.length) return new Map();

  // Create identity-neutral fan records in one batch; identity clocks are advanced
  // only by projectFanIdentity after real fields survive normalization.
  const firstByFan = new Map();
  for (const item of normalized) {
    const key = `${item.creatorId}\u0000${item.onlyFansUserId}`;
    const activityAt = date(item.activityObservedAt);
    const firstAt = activityAt || item.observedAt;
    const current = firstByFan.get(key);
    if (!current || firstAt < current.firstAt) firstByFan.set(key, { ...item, firstAt, activityAt });
  }
  await tx.creatorFan.createMany({
    data: [...firstByFan.values()].map((item) => ({
      id: crypto.randomUUID(), agencyId: item.agencyId, creatorId: item.creatorId, onlyFansUserId: item.onlyFansUserId,
      username: null, displayName: null, avatarUrl: null, headerUrl: null,
      identityObservedAt: null, identitySource: null, identityCompleteness: null, identityAuthorityVersion: null,
      firstSeenAt: item.firstAt, lastSeenAt: item.firstAt, lastActivityObservedAt: item.activityAt || null,
    })),
    skipDuplicates: true,
  });

  // Project in chronological-independent atomic writes. updateMany compares authority
  // versions inside the database write, so inverse commit order cannot roll current back.
  for (const item of normalized) await projectFanIdentity(tx, item);

  const creators = [...new Set(normalized.map((item) => item.creatorId))];
  const ids = [...new Set(normalized.map((item) => item.onlyFansUserId))];
  const fans = await tx.creatorFan.findMany({ where: { creatorId: { in: creators }, onlyFansUserId: { in: ids } } });
  return new Map(fans.map((fan) => [`${fan.creatorId}\u0000${fan.onlyFansUserId}`, fan]));
}


async function projectFanRelationship(tx, observation) {
  const externalId = onlyFansUserId(observation.onlyFansUserId);
  const observedAt = date(observation.observedAt);
  if (!externalId || !observedAt) throw new Error("Invalid CreatorFanRelationshipObservation");
  const source = text(observation.source, 80) || "UNKNOWN";
  const fan = await ensureFanRecord(tx, { ...observation, username: null, platformDisplayName: null });
  const where = { creatorId_onlyFansUserId: { creatorId: observation.creatorId, onlyFansUserId: externalId } };
  const fields = relationshipData(observation);
  if (!Object.keys(fields).length) return tx.creatorFanRelationshipCurrent.findUnique({ where });
  const observationVersion = authorityVersion(observedAt, source, fields);
  let existing = await tx.creatorFanRelationshipCurrent.findUnique({ where });
  if (!existing) {
    const create = {
      agencyId: observation.agencyId, creatorId: observation.creatorId, fanRecordId: fan.id, onlyFansUserId: externalId,
      observedAt, source, relationshipAuthorityVersion: observationVersion,
      sourceDeviceId: text(observation.sourceDeviceId, 180), sourceJobId: text(observation.sourceJobId, 180), scanRunId: text(observation.scanRunId, 180),
    };
    for (const [field, versionField] of RELATIONSHIP_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(fields, field)) continue;
      create[field] = fields[field];
      create[versionField] = authorityVersion(observedAt, source, fields[field]);
    }
    try {
      existing = await tx.creatorFanRelationshipCurrent.create({ data: create });
    } catch (error) {
      if (error?.code !== "P2002") throw error;
      existing = await tx.creatorFanRelationshipCurrent.findUnique({ where });
    }
  }

  for (const [field, versionField] of RELATIONSHIP_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(fields, field)) continue;
    const version = authorityVersion(observedAt, source, fields[field]);
    await tx.creatorFanRelationshipCurrent.updateMany({
      where: { creatorId: observation.creatorId, onlyFansUserId: externalId, ...newerVersionWhere(versionField, version) },
      data: { [field]: fields[field], [versionField]: version },
    });
  }
  if (Object.keys(fields).length) {
    await tx.creatorFanRelationshipCurrent.updateMany({
      where: { creatorId: observation.creatorId, onlyFansUserId: externalId, ...newerVersionWhere("relationshipAuthorityVersion", observationVersion) },
      data: {
        observedAt, source, relationshipAuthorityVersion: observationVersion,
        sourceDeviceId: text(observation.sourceDeviceId, 180), sourceJobId: text(observation.sourceJobId, 180), scanRunId: text(observation.scanRunId, 180),
      },
    });
  }
  return tx.creatorFanRelationshipCurrent.findUnique({ where });
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

function normalizedFanValueFacts(observation) {
  const availability = normalizeAvailability(observation.availability);
  const totalRaw = Object.prototype.hasOwnProperty.call(observation, "totalSpentCents")
    ? observation.totalSpentCents
    : observation.platformReportedTotalSpendCents;
  const numeric = {
    platformReportedTotalSpendCents: nullableBigInt(totalRaw),
    messagesSpentCents: nullableBigInt(observation.messagesSpentCents),
    subscriptionsSpentCents: nullableBigInt(observation.subscriptionsSpentCents),
    tipsSpentCents: nullableBigInt(observation.tipsSpentCents),
    postsSpentCents: nullableBigInt(observation.postsSpentCents),
    streamsSpentCents: nullableBigInt(observation.streamsSpentCents),
  };
  if (availability === VALUE_AVAILABILITY.AVAILABLE && numeric.platformReportedTotalSpendCents === null) {
    throw new Error("AVAILABLE fan value observation requires a valid totalSpentCents");
  }
  const lastActivityPresent = Object.prototype.hasOwnProperty.call(observation, "lastActivityAt");
  const lastActivityAt = observation.lastActivityAt === null ? null : date(observation.lastActivityAt);
  const observedFields = { availability };
  if (availability === VALUE_AVAILABILITY.AVAILABLE) {
    for (const [field, value] of Object.entries(numeric)) if (value !== null) observedFields[field] = value;
  }
  if (lastActivityPresent && (observation.lastActivityAt === null || lastActivityAt)) observedFields.lastActivityAt = lastActivityAt;
  return { availability, numeric, lastActivityPresent, lastActivityAt, observedFields };
}

async function projectFanValue(tx, observation) {
  const externalId = onlyFansUserId(observation.onlyFansUserId);
  const observedAt = date(observation.observedAt);
  if (!externalId || !observedAt) throw new Error("Invalid CreatorFanValueObservation");
  const fan = await ensureFanRecord(tx, { ...observation, username: null, platformDisplayName: null });
  const where = { creatorId_fanRecordId: { creatorId: observation.creatorId, fanRecordId: fan.id } };
  const source = text(observation.source, 80) || "UNKNOWN";

  // Presence may update temporal activity elsewhere, but it cannot be a money
  // authority. This guards canonical value even if an obsolete caller survives.
  if (source === "PRESENCE_HINT") {
    await projectFanActivity(tx, fan.id, observation.activityObservedAt ?? observation.lastActivityAt);
    const current = await tx.creatorFanValueCurrent.findUnique({ where });
    return { record: current, replay: true, fanRecordId: fan.id };
  }
  const { availability, numeric, lastActivityPresent, lastActivityAt, observedFields } = normalizedFanValueFacts(observation);

  const valueVersion = authorityVersion(observedAt, source, observedFields);
  const availabilityVersion = authorityVersion(observedAt, source, availability);
  const base = {
    agencyId: observation.agencyId,
    creatorId: observation.creatorId,
    fanRecordId: fan.id,
    availability,
    availabilityAuthorityVersion: availabilityVersion,
    valueObservedAt: observedAt,
    source,
    valueAuthorityVersion: valueVersion,
    sourceDeviceId: text(observation.sourceDeviceId, 180),
    sourceJobId: text(observation.sourceJobId, 180),
    scanRunId: text(observation.scanRunId, 180),
  };
  if (availability === VALUE_AVAILABILITY.AVAILABLE) {
    for (const [field, versionField] of VALUE_FIELDS) {
      const value = numeric[field];
      if (value === null) continue;
      base[field] = value;
      base[versionField] = authorityVersion(observedAt, source, value);
    }
  }
  if (lastActivityPresent && (observation.lastActivityAt === null || lastActivityAt)) {
    base.lastActivityAt = lastActivityAt;
    base.lastActivityAtAuthorityVersion = authorityVersion(observedAt, source, lastActivityAt);
  }

  let existing = await tx.creatorFanValueCurrent.findUnique({ where });
  if (!existing) {
    try {
      existing = await tx.creatorFanValueCurrent.create({ data: base });
    } catch (error) {
      if (error?.code !== "P2002") throw error;
      existing = await tx.creatorFanValueCurrent.findUnique({ where });
    }
  }

  // Availability is its own fact. MALFORMED/UNAVAILABLE may become the latest
  // observation without erasing the last known monetary values.
  await tx.creatorFanValueCurrent.updateMany({
    where: { creatorId: observation.creatorId, fanRecordId: fan.id, ...newerVersionWhere("availabilityAuthorityVersion", availabilityVersion) },
    data: { availability, availabilityAuthorityVersion: availabilityVersion },
  });

  if (availability === VALUE_AVAILABILITY.AVAILABLE) {
    for (const [field, versionField] of VALUE_FIELDS) {
      const value = numeric[field];
      if (value === null) continue;
      const version = authorityVersion(observedAt, source, value);
      await tx.creatorFanValueCurrent.updateMany({
        where: { creatorId: observation.creatorId, fanRecordId: fan.id, ...newerVersionWhere(versionField, version) },
        data: { [field]: value, [versionField]: version },
      });
    }
  }
  if (lastActivityPresent && (observation.lastActivityAt === null || lastActivityAt)) {
    const version = authorityVersion(observedAt, source, lastActivityAt);
    await tx.creatorFanValueCurrent.updateMany({
      where: { creatorId: observation.creatorId, fanRecordId: fan.id, ...newerVersionWhere("lastActivityAtAuthorityVersion", version) },
      data: { lastActivityAt, lastActivityAtAuthorityVersion: version },
    });
  }

  const result = await tx.creatorFanValueCurrent.updateMany({
    where: { creatorId: observation.creatorId, fanRecordId: fan.id, ...newerVersionWhere("valueAuthorityVersion", valueVersion) },
    data: {
      valueObservedAt: observedAt,
      source,
      valueAuthorityVersion: valueVersion,
      sourceDeviceId: text(observation.sourceDeviceId, 180),
      sourceJobId: text(observation.sourceJobId, 180),
      scanRunId: text(observation.scanRunId, 180),
    },
  });
  const current = await tx.creatorFanValueCurrent.findUnique({ where });
  return { record: current || existing, replay: Number(result?.count || 0) === 0 && !!existing, fanRecordId: fan.id };
}

async function projectSubscriberDirectoryRun(db, { runId, agencyId, creatorId, sourceJobId = null }) {
  if (!text(runId, 180) || !text(agencyId, 180) || !text(creatorId, 180)) throw new Error("Invalid subscriber projection scope");
  const items = await db.subscriberScanItem.findMany({ where: { runId } });
  if (!items.length) return { projected: 0 };

  // Test/in-memory adapters do not expose raw SQL. They still use the exact same
  // canonical projectors and therefore exercise semantic behavior, not a facade.
  if (typeof db.$executeRawUnsafe !== "function") {
    let projected = 0;
    for (const item of items) {
      const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata : {};
      const observed = metadata.fanDataObservedFields && typeof metadata.fanDataObservedFields === "object"
        ? metadata.fanDataObservedFields
        : {};
      const identityFields = new Set(Array.isArray(observed.identity) ? observed.identity : []);
      const relationshipFields = new Set(Array.isArray(observed.relationship) ? observed.relationship : []);
      const valueFields = new Set(Array.isArray(observed.value) ? observed.value : []);
      const identity = {
        agencyId, creatorId, onlyFansUserId: item.fanId,
        observedAt: item.observedAt, activityObservedAt: relationshipFields.has("lastSeenAt") ? item.lastSeenAt : undefined,
        source: "SUBSCRIBER_DIRECTORY",
      };
      if (identityFields.has("username") || (!identityFields.size && item.username)) identity.username = item.username;
      if (identityFields.has("platformDisplayName") || (!identityFields.size && item.name)) identity.platformDisplayName = item.name;
      if (identityFields.has("avatarUrl") || (!identityFields.size && item.avatarUrl)) identity.avatarUrl = item.avatarUrl;
      await projectFanIdentity(db, identity);

      const relationship = {
        agencyId, creatorId, onlyFansUserId: item.fanId,
        observedAt: item.observedAt, source: "SUBSCRIBER_DIRECTORY", sourceJobId, scanRunId: runId,
      };
      const relationshipMap = {
        fanSubscribesToCreator: "fanSubscribesToCreator",
        fanSubscriptionActive: "fanSubscriptionActive",
        fanSubscriptionType: "subscriptionType",
        fanSubscriptionExpiresAt: "fanSubscriptionExpiresAt",
        creatorFollowsFan: "creatorFollowsFan",
        creatorFollowExpiresAt: "creatorFollowExpiresAt",
        canReceiveChatMessage: "canReceiveChatMessage",
        blocked: "blocked", restricted: "restricted", performer: "performer",
        lastSeenAt: "lastSeenAt", subscribePriceCents: "subscribePriceCents",
      };
      for (const [field, itemField] of Object.entries(relationshipMap)) {
        if (relationshipFields.has(field) || (!relationshipFields.size && item[itemField] !== null && item[itemField] !== undefined)) {
          relationship[field] = item[itemField];
        }
      }
      await projectFanRelationship(db, relationship);

      const value = {
        agencyId, creatorId, onlyFansUserId: item.fanId,
        availability: item.valueAvailability, observedAt: item.observedAt,
        source: "SUBSCRIBER_DIRECTORY", sourceJobId, scanRunId: runId,
      };
      const valueMap = {
        totalSpentCents: "totalSpentCents", messagesSpentCents: "messagesSpentCents",
        subscriptionsSpentCents: "subscriptionsSpentCents", tipsSpentCents: "tipsSpentCents",
        postsSpentCents: "postsSpentCents", streamsSpentCents: "streamsSpentCents",
      };
      for (const [field, itemField] of Object.entries(valueMap)) {
        if (valueFields.has(field) || (!valueFields.size && item[itemField] !== null && item[itemField] !== undefined)) value[field] = item[itemField];
      }
      // AVAILABLE is impossible without a strict canonical total after ingress normalization.
      if (value.availability === VALUE_AVAILABILITY.AVAILABLE && value.totalSpentCents == null) value.availability = VALUE_AVAILABILITY.MALFORMED;
      await projectFanValue(db, value);
      projected += 1;
    }
    return { projected };
  }

  const SOURCE = "SUBSCRIBER_DIRECTORY";
  const relationshipMap = {
    fanSubscribesToCreator: "fanSubscribesToCreator",
    fanSubscriptionActive: "fanSubscriptionActive",
    fanSubscriptionType: "subscriptionType",
    fanSubscriptionExpiresAt: "fanSubscriptionExpiresAt",
    creatorFollowsFan: "creatorFollowsFan",
    creatorFollowExpiresAt: "creatorFollowExpiresAt",
    canReceiveChatMessage: "canReceiveChatMessage",
    blocked: "blocked", restricted: "restricted", performer: "performer",
    lastSeenAt: "lastSeenAt", subscribePriceCents: "subscribePriceCents",
  };
  const valueMap = {
    platformReportedTotalSpendCents: "totalSpentCents",
    messagesSpentCents: "messagesSpentCents",
    subscriptionsSpentCents: "subscriptionsSpentCents",
    tipsSpentCents: "tipsSpentCents",
    postsSpentCents: "postsSpentCents",
    streamsSpentCents: "streamsSpentCents",
  };
  const chunks = [];
  for (let index = 0; index < items.length; index += 500) chunks.push(items.slice(index, index + 500));

  for (const chunk of chunks) {
    const fanRows = [];
    const relationshipRows = [];
    const valueRows = [];

    for (const item of chunk) {
      const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata : {};
      const observed = metadata.fanDataObservedFields && typeof metadata.fanDataObservedFields === "object"
        ? metadata.fanDataObservedFields
        : {};
      const identityMask = new Set(Array.isArray(observed.identity) ? observed.identity : []);
      const relationshipMask = new Set(Array.isArray(observed.relationship) ? observed.relationship : []);
      const valueMask = new Set(Array.isArray(observed.value) ? observed.value : []);
      const observedAt = date(item.observedAt);
      if (!observedAt) continue;

      const identityInput = cleanIdentityFields({
        username: identityMask.has("username") || (!identityMask.size && item.username) ? item.username : null,
        platformDisplayName: identityMask.has("platformDisplayName") || (!identityMask.size && item.name) ? item.name : null,
        avatarUrl: identityMask.has("avatarUrl") || (!identityMask.size && item.avatarUrl) ? item.avatarUrl : null,
        headerUrl: null,
      });
      const usernameVersion = identityInput.username === null ? null : authorityVersion(observedAt, SOURCE, identityInput.username);
      const displayNameVersion = identityInput.platformDisplayName === null ? null : authorityVersion(observedAt, SOURCE, identityInput.platformDisplayName);
      const avatarVersion = identityInput.avatarUrl === null ? null : authorityVersion(observedAt, SOURCE, identityInput.avatarUrl);
      const identityVersion = usernameVersion || displayNameVersion || avatarVersion
        ? authorityVersion(observedAt, SOURCE, identityInput)
        : null;
      const activityAt = relationshipMask.has("lastSeenAt") && item.lastSeenAt ? date(item.lastSeenAt) : null;
      fanRows.push({
        id: crypto.randomUUID(), agencyId, creatorId, onlyFansUserId: String(item.fanId),
        username: identityInput.username, displayName: identityInput.platformDisplayName, avatarUrl: identityInput.avatarUrl,
        usernameAuthorityVersion: usernameVersion, displayNameAuthorityVersion: displayNameVersion,
        avatarAuthorityVersion: avatarVersion, identityAuthorityVersion: identityVersion,
        identityObservedAt: identityVersion ? observedAt.toISOString() : null,
        identitySource: identityVersion ? SOURCE : null,
        identityCompleteness: identityVersion ? identityCompleteness(identityInput) : null,
        firstSeenAt: (activityAt || observedAt).toISOString(),
        lastActivityObservedAt: activityAt?.toISOString?.() || null,
      });

      const relationshipObservation = { agencyId, creatorId, onlyFansUserId: item.fanId, observedAt, source: SOURCE };
      for (const [field, itemField] of Object.entries(relationshipMap)) {
        if (relationshipMask.has(field) || (!relationshipMask.size && item[itemField] !== null && item[itemField] !== undefined)) {
          relationshipObservation[field] = item[itemField];
        }
      }
      const relationshipFacts = relationshipData(relationshipObservation);
      if (Object.keys(relationshipFacts).length) {
        const row = {
          id: crypto.randomUUID(), agencyId, creatorId, onlyFansUserId: String(item.fanId),
          observedAt: observedAt.toISOString(), source: SOURCE, sourceJobId: text(sourceJobId, 180), scanRunId: runId,
          relationshipAuthorityVersion: authorityVersion(observedAt, SOURCE, relationshipFacts),
        };
        for (const [field, versionField] of RELATIONSHIP_FIELDS) {
          if (!Object.prototype.hasOwnProperty.call(relationshipFacts, field)) continue;
          const value = relationshipFacts[field];
          row[field] = value instanceof Date ? value.toISOString() : value;
          row[versionField] = authorityVersion(observedAt, SOURCE, value);
        }
        relationshipRows.push(row);
      }

      const valueObservation = {
        agencyId, creatorId, onlyFansUserId: item.fanId,
        availability: item.valueAvailability, observedAt, source: SOURCE,
      };
      for (const [field, itemField] of Object.entries({
        totalSpentCents: "totalSpentCents", messagesSpentCents: "messagesSpentCents",
        subscriptionsSpentCents: "subscriptionsSpentCents", tipsSpentCents: "tipsSpentCents",
        postsSpentCents: "postsSpentCents", streamsSpentCents: "streamsSpentCents",
      })) {
        if (valueMask.has(field) || (!valueMask.size && item[itemField] !== null && item[itemField] !== undefined)) valueObservation[field] = item[itemField];
      }
      if (valueObservation.availability === VALUE_AVAILABILITY.AVAILABLE && valueObservation.totalSpentCents == null) {
        valueObservation.availability = VALUE_AVAILABILITY.MALFORMED;
      }
      const normalizedValue = normalizedFanValueFacts(valueObservation);
      const valueVersion = authorityVersion(observedAt, SOURCE, normalizedValue.observedFields);
      const availabilityVersion = authorityVersion(observedAt, SOURCE, normalizedValue.availability);
      const valueRow = {
        id: crypto.randomUUID(), agencyId, creatorId, onlyFansUserId: String(item.fanId),
        availability: normalizedValue.availability,
        availabilityAuthorityVersion: availabilityVersion,
        valueObservedAt: observedAt.toISOString(), source: SOURCE, valueAuthorityVersion: valueVersion,
        sourceJobId: text(sourceJobId, 180), scanRunId: runId,
      };
      if (normalizedValue.availability === VALUE_AVAILABILITY.AVAILABLE) {
        for (const [field, versionField] of VALUE_FIELDS) {
          const value = normalizedValue.numeric[field];
          if (value === null) continue;
          valueRow[field] = value.toString();
          valueRow[versionField] = authorityVersion(observedAt, SOURCE, value);
        }
      }
      valueRows.push(valueRow);
    }

    if (fanRows.length) {
      const json = JSON.stringify(fanRows);
      await db.$executeRawUnsafe(`
        WITH incoming AS (
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS i(
            "id" text, "agencyId" text, "creatorId" text, "onlyFansUserId" text,
            "username" text, "displayName" text, "avatarUrl" text,
            "usernameAuthorityVersion" text, "displayNameAuthorityVersion" text, "avatarAuthorityVersion" text,
            "identityAuthorityVersion" text, "identityObservedAt" timestamptz, "identitySource" text, "identityCompleteness" text,
            "firstSeenAt" timestamptz, "lastActivityObservedAt" timestamptz
          )
        )
        INSERT INTO "CreatorFan" (
          "id","agencyId","creatorId","onlyFansUserId","username","displayName","avatarUrl",
          "identityObservedAt","identitySource","identityCompleteness","identityAuthorityVersion",
          "usernameAuthorityVersion","displayNameAuthorityVersion","avatarAuthorityVersion",
          "firstSeenAt","lastSeenAt","lastActivityObservedAt","createdAt","updatedAt"
        )
        SELECT
          i."id",i."agencyId",i."creatorId",i."onlyFansUserId",i."username",i."displayName",i."avatarUrl",
          i."identityObservedAt",i."identitySource",i."identityCompleteness",i."identityAuthorityVersion",
          i."usernameAuthorityVersion",i."displayNameAuthorityVersion",i."avatarAuthorityVersion",
          i."firstSeenAt",i."firstSeenAt",i."lastActivityObservedAt",NOW(),NOW()
        FROM incoming i
        ON CONFLICT ("creatorId","onlyFansUserId") DO UPDATE SET
          "firstSeenAt" = LEAST("CreatorFan"."firstSeenAt", EXCLUDED."firstSeenAt"),
          "lastSeenAt" = CASE WHEN EXCLUDED."lastActivityObservedAt" IS NOT NULL AND EXCLUDED."lastActivityObservedAt" > "CreatorFan"."lastSeenAt" THEN EXCLUDED."lastActivityObservedAt" ELSE "CreatorFan"."lastSeenAt" END,
          "lastActivityObservedAt" = CASE WHEN EXCLUDED."lastActivityObservedAt" IS NOT NULL AND ("CreatorFan"."lastActivityObservedAt" IS NULL OR EXCLUDED."lastActivityObservedAt" > "CreatorFan"."lastActivityObservedAt") THEN EXCLUDED."lastActivityObservedAt" ELSE "CreatorFan"."lastActivityObservedAt" END,
          "username" = CASE WHEN EXCLUDED."usernameAuthorityVersion" IS NOT NULL AND ("CreatorFan"."usernameAuthorityVersion" IS NULL OR EXCLUDED."usernameAuthorityVersion" > "CreatorFan"."usernameAuthorityVersion") THEN EXCLUDED."username" ELSE "CreatorFan"."username" END,
          "usernameAuthorityVersion" = CASE WHEN EXCLUDED."usernameAuthorityVersion" IS NOT NULL AND ("CreatorFan"."usernameAuthorityVersion" IS NULL OR EXCLUDED."usernameAuthorityVersion" > "CreatorFan"."usernameAuthorityVersion") THEN EXCLUDED."usernameAuthorityVersion" ELSE "CreatorFan"."usernameAuthorityVersion" END,
          "displayName" = CASE WHEN EXCLUDED."displayNameAuthorityVersion" IS NOT NULL AND ("CreatorFan"."displayNameAuthorityVersion" IS NULL OR EXCLUDED."displayNameAuthorityVersion" > "CreatorFan"."displayNameAuthorityVersion") THEN EXCLUDED."displayName" ELSE "CreatorFan"."displayName" END,
          "displayNameAuthorityVersion" = CASE WHEN EXCLUDED."displayNameAuthorityVersion" IS NOT NULL AND ("CreatorFan"."displayNameAuthorityVersion" IS NULL OR EXCLUDED."displayNameAuthorityVersion" > "CreatorFan"."displayNameAuthorityVersion") THEN EXCLUDED."displayNameAuthorityVersion" ELSE "CreatorFan"."displayNameAuthorityVersion" END,
          "avatarUrl" = CASE WHEN EXCLUDED."avatarAuthorityVersion" IS NOT NULL AND ("CreatorFan"."avatarAuthorityVersion" IS NULL OR EXCLUDED."avatarAuthorityVersion" > "CreatorFan"."avatarAuthorityVersion") THEN EXCLUDED."avatarUrl" ELSE "CreatorFan"."avatarUrl" END,
          "avatarAuthorityVersion" = CASE WHEN EXCLUDED."avatarAuthorityVersion" IS NOT NULL AND ("CreatorFan"."avatarAuthorityVersion" IS NULL OR EXCLUDED."avatarAuthorityVersion" > "CreatorFan"."avatarAuthorityVersion") THEN EXCLUDED."avatarAuthorityVersion" ELSE "CreatorFan"."avatarAuthorityVersion" END,
          "identityObservedAt" = CASE WHEN EXCLUDED."identityAuthorityVersion" IS NOT NULL AND ("CreatorFan"."identityAuthorityVersion" IS NULL OR EXCLUDED."identityAuthorityVersion" > "CreatorFan"."identityAuthorityVersion") THEN EXCLUDED."identityObservedAt" ELSE "CreatorFan"."identityObservedAt" END,
          "identitySource" = CASE WHEN EXCLUDED."identityAuthorityVersion" IS NOT NULL AND ("CreatorFan"."identityAuthorityVersion" IS NULL OR EXCLUDED."identityAuthorityVersion" > "CreatorFan"."identityAuthorityVersion") THEN EXCLUDED."identitySource" ELSE "CreatorFan"."identitySource" END,
          "identityAuthorityVersion" = CASE WHEN EXCLUDED."identityAuthorityVersion" IS NOT NULL AND ("CreatorFan"."identityAuthorityVersion" IS NULL OR EXCLUDED."identityAuthorityVersion" > "CreatorFan"."identityAuthorityVersion") THEN EXCLUDED."identityAuthorityVersion" ELSE "CreatorFan"."identityAuthorityVersion" END,
          "updatedAt" = NOW()
      `, json);
      await db.$executeRawUnsafe(`
        WITH incoming AS (SELECT "onlyFansUserId" FROM jsonb_to_recordset($1::jsonb) AS i("onlyFansUserId" text))
        UPDATE "CreatorFan" f SET
          "identityCompleteness" = CASE
            WHEN f."username" IS NOT NULL AND f."displayName" IS NOT NULL AND f."avatarUrl" IS NOT NULL AND f."headerUrl" IS NOT NULL THEN 'FULL'
            WHEN f."username" IS NOT NULL OR f."displayName" IS NOT NULL OR f."avatarUrl" IS NOT NULL OR f."headerUrl" IS NOT NULL THEN 'PARTIAL'
            ELSE NULL END,
          "updatedAt" = NOW()
        WHERE f."creatorId" = $2 AND f."onlyFansUserId" IN (SELECT "onlyFansUserId" FROM incoming)
      `, json, creatorId);
    }

    if (relationshipRows.length) {
      const json = JSON.stringify(relationshipRows);
      await db.$executeRawUnsafe(`
        WITH incoming AS (
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS i(
            "id" text,"agencyId" text,"creatorId" text,"onlyFansUserId" text,
            "fanSubscribesToCreator" boolean,"fanSubscriptionActive" boolean,"fanSubscriptionType" text,"fanSubscriptionExpiresAt" timestamptz,
            "creatorFollowsFan" boolean,"creatorFollowExpiresAt" timestamptz,"canReceiveChatMessage" boolean,"blocked" boolean,"restricted" boolean,"performer" boolean,
            "lastSeenAt" timestamptz,"subscribePriceCents" integer,
            "relationshipAuthorityVersion" text,"fanSubscribesToCreatorAuthorityVersion" text,"fanSubscriptionActiveAuthorityVersion" text,
            "fanSubscriptionTypeAuthorityVersion" text,"fanSubscriptionExpiresAtAuthorityVersion" text,"creatorFollowsFanAuthorityVersion" text,
            "creatorFollowExpiresAtAuthorityVersion" text,"canReceiveChatMessageAuthorityVersion" text,"blockedAuthorityVersion" text,
            "restrictedAuthorityVersion" text,"performerAuthorityVersion" text,"lastSeenAtAuthorityVersion" text,"subscribePriceCentsAuthorityVersion" text,
            "observedAt" timestamptz,"source" text,"sourceJobId" text,"scanRunId" text
          )
        ), joined AS (
          SELECT i.*, f."id" AS "fanRecordId" FROM incoming i
          JOIN "CreatorFan" f ON f."creatorId" = i."creatorId" AND f."onlyFansUserId" = i."onlyFansUserId"
        )
        INSERT INTO "CreatorFanRelationshipCurrent" (
          "id","agencyId","creatorId","fanRecordId","onlyFansUserId",
          "fanSubscribesToCreator","fanSubscriptionActive","fanSubscriptionType","fanSubscriptionExpiresAt","creatorFollowsFan","creatorFollowExpiresAt",
          "canReceiveChatMessage","blocked","restricted","performer","lastSeenAt","subscribePriceCents",
          "relationshipAuthorityVersion","fanSubscribesToCreatorAuthorityVersion","fanSubscriptionActiveAuthorityVersion","fanSubscriptionTypeAuthorityVersion",
          "fanSubscriptionExpiresAtAuthorityVersion","creatorFollowsFanAuthorityVersion","creatorFollowExpiresAtAuthorityVersion","canReceiveChatMessageAuthorityVersion",
          "blockedAuthorityVersion","restrictedAuthorityVersion","performerAuthorityVersion","lastSeenAtAuthorityVersion","subscribePriceCentsAuthorityVersion",
          "observedAt","source","sourceJobId","scanRunId","createdAt","updatedAt"
        )
        SELECT
          "id","agencyId","creatorId","fanRecordId","onlyFansUserId",
          "fanSubscribesToCreator","fanSubscriptionActive","fanSubscriptionType","fanSubscriptionExpiresAt","creatorFollowsFan","creatorFollowExpiresAt",
          "canReceiveChatMessage","blocked","restricted","performer","lastSeenAt","subscribePriceCents",
          "relationshipAuthorityVersion","fanSubscribesToCreatorAuthorityVersion","fanSubscriptionActiveAuthorityVersion","fanSubscriptionTypeAuthorityVersion",
          "fanSubscriptionExpiresAtAuthorityVersion","creatorFollowsFanAuthorityVersion","creatorFollowExpiresAtAuthorityVersion","canReceiveChatMessageAuthorityVersion",
          "blockedAuthorityVersion","restrictedAuthorityVersion","performerAuthorityVersion","lastSeenAtAuthorityVersion","subscribePriceCentsAuthorityVersion",
          "observedAt","source","sourceJobId","scanRunId",NOW(),NOW()
        FROM joined
        ON CONFLICT ("creatorId","onlyFansUserId") DO UPDATE SET
          "fanRecordId" = EXCLUDED."fanRecordId",
          "fanSubscribesToCreator" = CASE WHEN EXCLUDED."fanSubscribesToCreatorAuthorityVersion" IS NOT NULL AND ("CreatorFanRelationshipCurrent"."fanSubscribesToCreatorAuthorityVersion" IS NULL OR EXCLUDED."fanSubscribesToCreatorAuthorityVersion" > "CreatorFanRelationshipCurrent"."fanSubscribesToCreatorAuthorityVersion") THEN EXCLUDED."fanSubscribesToCreator" ELSE "CreatorFanRelationshipCurrent"."fanSubscribesToCreator" END,
          "fanSubscribesToCreatorAuthorityVersion" = CASE WHEN EXCLUDED."fanSubscribesToCreatorAuthorityVersion" IS NOT NULL AND ("CreatorFanRelationshipCurrent"."fanSubscribesToCreatorAuthorityVersion" IS NULL OR EXCLUDED."fanSubscribesToCreatorAuthorityVersion" > "CreatorFanRelationshipCurrent"."fanSubscribesToCreatorAuthorityVersion") THEN EXCLUDED."fanSubscribesToCreatorAuthorityVersion" ELSE "CreatorFanRelationshipCurrent"."fanSubscribesToCreatorAuthorityVersion" END,
          "fanSubscriptionActive" = CASE WHEN EXCLUDED."fanSubscriptionActiveAuthorityVersion" IS NOT NULL AND ("CreatorFanRelationshipCurrent"."fanSubscriptionActiveAuthorityVersion" IS NULL OR EXCLUDED."fanSubscriptionActiveAuthorityVersion" > "CreatorFanRelationshipCurrent"."fanSubscriptionActiveAuthorityVersion") THEN EXCLUDED."fanSubscriptionActive" ELSE "CreatorFanRelationshipCurrent"."fanSubscriptionActive" END,
          "fanSubscriptionActiveAuthorityVersion" = CASE WHEN EXCLUDED."fanSubscriptionActiveAuthorityVersion" IS NOT NULL AND ("CreatorFanRelationshipCurrent"."fanSubscriptionActiveAuthorityVersion" IS NULL OR EXCLUDED."fanSubscriptionActiveAuthorityVersion" > "CreatorFanRelationshipCurrent"."fanSubscriptionActiveAuthorityVersion") THEN EXCLUDED."fanSubscriptionActiveAuthorityVersion" ELSE "CreatorFanRelationshipCurrent"."fanSubscriptionActiveAuthorityVersion" END,
          "fanSubscriptionType" = CASE WHEN EXCLUDED."fanSubscriptionTypeAuthorityVersion" IS NOT NULL AND ("CreatorFanRelationshipCurrent"."fanSubscriptionTypeAuthorityVersion" IS NULL OR EXCLUDED."fanSubscriptionTypeAuthorityVersion" > "CreatorFanRelationshipCurrent"."fanSubscriptionTypeAuthorityVersion") THEN EXCLUDED."fanSubscriptionType" ELSE "CreatorFanRelationshipCurrent"."fanSubscriptionType" END,
          "fanSubscriptionTypeAuthorityVersion" = CASE WHEN EXCLUDED."fanSubscriptionTypeAuthorityVersion" IS NOT NULL AND ("CreatorFanRelationshipCurrent"."fanSubscriptionTypeAuthorityVersion" IS NULL OR EXCLUDED."fanSubscriptionTypeAuthorityVersion" > "CreatorFanRelationshipCurrent"."fanSubscriptionTypeAuthorityVersion") THEN EXCLUDED."fanSubscriptionTypeAuthorityVersion" ELSE "CreatorFanRelationshipCurrent"."fanSubscriptionTypeAuthorityVersion" END,
          "fanSubscriptionExpiresAt" = CASE WHEN EXCLUDED."fanSubscriptionExpiresAtAuthorityVersion" IS NOT NULL AND ("CreatorFanRelationshipCurrent"."fanSubscriptionExpiresAtAuthorityVersion" IS NULL OR EXCLUDED."fanSubscriptionExpiresAtAuthorityVersion" > "CreatorFanRelationshipCurrent"."fanSubscriptionExpiresAtAuthorityVersion") THEN EXCLUDED."fanSubscriptionExpiresAt" ELSE "CreatorFanRelationshipCurrent"."fanSubscriptionExpiresAt" END,
          "fanSubscriptionExpiresAtAuthorityVersion" = CASE WHEN EXCLUDED."fanSubscriptionExpiresAtAuthorityVersion" IS NOT NULL AND ("CreatorFanRelationshipCurrent"."fanSubscriptionExpiresAtAuthorityVersion" IS NULL OR EXCLUDED."fanSubscriptionExpiresAtAuthorityVersion" > "CreatorFanRelationshipCurrent"."fanSubscriptionExpiresAtAuthorityVersion") THEN EXCLUDED."fanSubscriptionExpiresAtAuthorityVersion" ELSE "CreatorFanRelationshipCurrent"."fanSubscriptionExpiresAtAuthorityVersion" END,
          "creatorFollowsFan" = CASE WHEN EXCLUDED."creatorFollowsFanAuthorityVersion" IS NOT NULL AND ("CreatorFanRelationshipCurrent"."creatorFollowsFanAuthorityVersion" IS NULL OR EXCLUDED."creatorFollowsFanAuthorityVersion" > "CreatorFanRelationshipCurrent"."creatorFollowsFanAuthorityVersion") THEN EXCLUDED."creatorFollowsFan" ELSE "CreatorFanRelationshipCurrent"."creatorFollowsFan" END,
          "creatorFollowsFanAuthorityVersion" = CASE WHEN EXCLUDED."creatorFollowsFanAuthorityVersion" IS NOT NULL AND ("CreatorFanRelationshipCurrent"."creatorFollowsFanAuthorityVersion" IS NULL OR EXCLUDED."creatorFollowsFanAuthorityVersion" > "CreatorFanRelationshipCurrent"."creatorFollowsFanAuthorityVersion") THEN EXCLUDED."creatorFollowsFanAuthorityVersion" ELSE "CreatorFanRelationshipCurrent"."creatorFollowsFanAuthorityVersion" END,
          "creatorFollowExpiresAt" = CASE WHEN EXCLUDED."creatorFollowExpiresAtAuthorityVersion" IS NOT NULL AND ("CreatorFanRelationshipCurrent"."creatorFollowExpiresAtAuthorityVersion" IS NULL OR EXCLUDED."creatorFollowExpiresAtAuthorityVersion" > "CreatorFanRelationshipCurrent"."creatorFollowExpiresAtAuthorityVersion") THEN EXCLUDED."creatorFollowExpiresAt" ELSE "CreatorFanRelationshipCurrent"."creatorFollowExpiresAt" END,
          "creatorFollowExpiresAtAuthorityVersion" = CASE WHEN EXCLUDED."creatorFollowExpiresAtAuthorityVersion" IS NOT NULL AND ("CreatorFanRelationshipCurrent"."creatorFollowExpiresAtAuthorityVersion" IS NULL OR EXCLUDED."creatorFollowExpiresAtAuthorityVersion" > "CreatorFanRelationshipCurrent"."creatorFollowExpiresAtAuthorityVersion") THEN EXCLUDED."creatorFollowExpiresAtAuthorityVersion" ELSE "CreatorFanRelationshipCurrent"."creatorFollowExpiresAtAuthorityVersion" END,
          "canReceiveChatMessage" = CASE WHEN EXCLUDED."canReceiveChatMessageAuthorityVersion" IS NOT NULL AND ("CreatorFanRelationshipCurrent"."canReceiveChatMessageAuthorityVersion" IS NULL OR EXCLUDED."canReceiveChatMessageAuthorityVersion" > "CreatorFanRelationshipCurrent"."canReceiveChatMessageAuthorityVersion") THEN EXCLUDED."canReceiveChatMessage" ELSE "CreatorFanRelationshipCurrent"."canReceiveChatMessage" END,
          "canReceiveChatMessageAuthorityVersion" = CASE WHEN EXCLUDED."canReceiveChatMessageAuthorityVersion" IS NOT NULL AND ("CreatorFanRelationshipCurrent"."canReceiveChatMessageAuthorityVersion" IS NULL OR EXCLUDED."canReceiveChatMessageAuthorityVersion" > "CreatorFanRelationshipCurrent"."canReceiveChatMessageAuthorityVersion") THEN EXCLUDED."canReceiveChatMessageAuthorityVersion" ELSE "CreatorFanRelationshipCurrent"."canReceiveChatMessageAuthorityVersion" END,
          "blocked" = CASE WHEN EXCLUDED."blockedAuthorityVersion" IS NOT NULL AND ("CreatorFanRelationshipCurrent"."blockedAuthorityVersion" IS NULL OR EXCLUDED."blockedAuthorityVersion" > "CreatorFanRelationshipCurrent"."blockedAuthorityVersion") THEN EXCLUDED."blocked" ELSE "CreatorFanRelationshipCurrent"."blocked" END,
          "blockedAuthorityVersion" = CASE WHEN EXCLUDED."blockedAuthorityVersion" IS NOT NULL AND ("CreatorFanRelationshipCurrent"."blockedAuthorityVersion" IS NULL OR EXCLUDED."blockedAuthorityVersion" > "CreatorFanRelationshipCurrent"."blockedAuthorityVersion") THEN EXCLUDED."blockedAuthorityVersion" ELSE "CreatorFanRelationshipCurrent"."blockedAuthorityVersion" END,
          "restricted" = CASE WHEN EXCLUDED."restrictedAuthorityVersion" IS NOT NULL AND ("CreatorFanRelationshipCurrent"."restrictedAuthorityVersion" IS NULL OR EXCLUDED."restrictedAuthorityVersion" > "CreatorFanRelationshipCurrent"."restrictedAuthorityVersion") THEN EXCLUDED."restricted" ELSE "CreatorFanRelationshipCurrent"."restricted" END,
          "restrictedAuthorityVersion" = CASE WHEN EXCLUDED."restrictedAuthorityVersion" IS NOT NULL AND ("CreatorFanRelationshipCurrent"."restrictedAuthorityVersion" IS NULL OR EXCLUDED."restrictedAuthorityVersion" > "CreatorFanRelationshipCurrent"."restrictedAuthorityVersion") THEN EXCLUDED."restrictedAuthorityVersion" ELSE "CreatorFanRelationshipCurrent"."restrictedAuthorityVersion" END,
          "performer" = CASE WHEN EXCLUDED."performerAuthorityVersion" IS NOT NULL AND ("CreatorFanRelationshipCurrent"."performerAuthorityVersion" IS NULL OR EXCLUDED."performerAuthorityVersion" > "CreatorFanRelationshipCurrent"."performerAuthorityVersion") THEN EXCLUDED."performer" ELSE "CreatorFanRelationshipCurrent"."performer" END,
          "performerAuthorityVersion" = CASE WHEN EXCLUDED."performerAuthorityVersion" IS NOT NULL AND ("CreatorFanRelationshipCurrent"."performerAuthorityVersion" IS NULL OR EXCLUDED."performerAuthorityVersion" > "CreatorFanRelationshipCurrent"."performerAuthorityVersion") THEN EXCLUDED."performerAuthorityVersion" ELSE "CreatorFanRelationshipCurrent"."performerAuthorityVersion" END,
          "lastSeenAt" = CASE WHEN EXCLUDED."lastSeenAtAuthorityVersion" IS NOT NULL AND ("CreatorFanRelationshipCurrent"."lastSeenAtAuthorityVersion" IS NULL OR EXCLUDED."lastSeenAtAuthorityVersion" > "CreatorFanRelationshipCurrent"."lastSeenAtAuthorityVersion") THEN EXCLUDED."lastSeenAt" ELSE "CreatorFanRelationshipCurrent"."lastSeenAt" END,
          "lastSeenAtAuthorityVersion" = CASE WHEN EXCLUDED."lastSeenAtAuthorityVersion" IS NOT NULL AND ("CreatorFanRelationshipCurrent"."lastSeenAtAuthorityVersion" IS NULL OR EXCLUDED."lastSeenAtAuthorityVersion" > "CreatorFanRelationshipCurrent"."lastSeenAtAuthorityVersion") THEN EXCLUDED."lastSeenAtAuthorityVersion" ELSE "CreatorFanRelationshipCurrent"."lastSeenAtAuthorityVersion" END,
          "subscribePriceCents" = CASE WHEN EXCLUDED."subscribePriceCentsAuthorityVersion" IS NOT NULL AND ("CreatorFanRelationshipCurrent"."subscribePriceCentsAuthorityVersion" IS NULL OR EXCLUDED."subscribePriceCentsAuthorityVersion" > "CreatorFanRelationshipCurrent"."subscribePriceCentsAuthorityVersion") THEN EXCLUDED."subscribePriceCents" ELSE "CreatorFanRelationshipCurrent"."subscribePriceCents" END,
          "subscribePriceCentsAuthorityVersion" = CASE WHEN EXCLUDED."subscribePriceCentsAuthorityVersion" IS NOT NULL AND ("CreatorFanRelationshipCurrent"."subscribePriceCentsAuthorityVersion" IS NULL OR EXCLUDED."subscribePriceCentsAuthorityVersion" > "CreatorFanRelationshipCurrent"."subscribePriceCentsAuthorityVersion") THEN EXCLUDED."subscribePriceCentsAuthorityVersion" ELSE "CreatorFanRelationshipCurrent"."subscribePriceCentsAuthorityVersion" END,
          "observedAt" = CASE WHEN "CreatorFanRelationshipCurrent"."relationshipAuthorityVersion" IS NULL OR EXCLUDED."relationshipAuthorityVersion" > "CreatorFanRelationshipCurrent"."relationshipAuthorityVersion" THEN EXCLUDED."observedAt" ELSE "CreatorFanRelationshipCurrent"."observedAt" END,
          "source" = CASE WHEN "CreatorFanRelationshipCurrent"."relationshipAuthorityVersion" IS NULL OR EXCLUDED."relationshipAuthorityVersion" > "CreatorFanRelationshipCurrent"."relationshipAuthorityVersion" THEN EXCLUDED."source" ELSE "CreatorFanRelationshipCurrent"."source" END,
          "sourceJobId" = CASE WHEN "CreatorFanRelationshipCurrent"."relationshipAuthorityVersion" IS NULL OR EXCLUDED."relationshipAuthorityVersion" > "CreatorFanRelationshipCurrent"."relationshipAuthorityVersion" THEN EXCLUDED."sourceJobId" ELSE "CreatorFanRelationshipCurrent"."sourceJobId" END,
          "scanRunId" = CASE WHEN "CreatorFanRelationshipCurrent"."relationshipAuthorityVersion" IS NULL OR EXCLUDED."relationshipAuthorityVersion" > "CreatorFanRelationshipCurrent"."relationshipAuthorityVersion" THEN EXCLUDED."scanRunId" ELSE "CreatorFanRelationshipCurrent"."scanRunId" END,
          "relationshipAuthorityVersion" = CASE WHEN "CreatorFanRelationshipCurrent"."relationshipAuthorityVersion" IS NULL OR EXCLUDED."relationshipAuthorityVersion" > "CreatorFanRelationshipCurrent"."relationshipAuthorityVersion" THEN EXCLUDED."relationshipAuthorityVersion" ELSE "CreatorFanRelationshipCurrent"."relationshipAuthorityVersion" END,
          "updatedAt" = NOW()
      `, json);
    }

    if (valueRows.length) {
      const json = JSON.stringify(valueRows);
      await db.$executeRawUnsafe(`
        WITH incoming AS (
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS i(
            "id" text,"agencyId" text,"creatorId" text,"onlyFansUserId" text,
            "availability" text,"availabilityAuthorityVersion" text,"valueObservedAt" timestamptz,"source" text,"valueAuthorityVersion" text,
            "platformReportedTotalSpendCents" text,"platformReportedTotalSpendCentsAuthorityVersion" text,
            "messagesSpentCents" text,"messagesSpentCentsAuthorityVersion" text,
            "subscriptionsSpentCents" text,"subscriptionsSpentCentsAuthorityVersion" text,
            "tipsSpentCents" text,"tipsSpentCentsAuthorityVersion" text,
            "postsSpentCents" text,"postsSpentCentsAuthorityVersion" text,
            "streamsSpentCents" text,"streamsSpentCentsAuthorityVersion" text,
            "lastActivityAt" timestamptz,"lastActivityAtAuthorityVersion" text,"sourceJobId" text,"scanRunId" text
          )
        ), joined AS (
          SELECT i.*, f."id" AS "fanRecordId" FROM incoming i
          JOIN "CreatorFan" f ON f."creatorId" = i."creatorId" AND f."onlyFansUserId" = i."onlyFansUserId"
        )
        INSERT INTO "CreatorFanValueCurrent" (
          "id","agencyId","creatorId","fanId","totalNetCents","messagesNetCents","subscriptionsNetCents","tipsNetCents","postsNetCents","streamsNetCents",
          "lastActivityAt","fetchedAt","availability","source","valueAuthorityVersion","availabilityAuthorityVersion",
          "platformReportedTotalSpendCentsAuthorityVersion","messagesSpentCentsAuthorityVersion","subscriptionsSpentCentsAuthorityVersion",
          "tipsSpentCentsAuthorityVersion","postsSpentCentsAuthorityVersion","streamsSpentCentsAuthorityVersion","lastActivityAtAuthorityVersion",
          "sourceJobId","scanRunId","createdAt","updatedAt"
        )
        SELECT
          "id","agencyId","creatorId","fanRecordId",
          CASE WHEN "platformReportedTotalSpendCents" IS NULL THEN NULL ELSE "platformReportedTotalSpendCents"::bigint END,
          CASE WHEN "messagesSpentCents" IS NULL THEN NULL ELSE "messagesSpentCents"::bigint END,
          CASE WHEN "subscriptionsSpentCents" IS NULL THEN NULL ELSE "subscriptionsSpentCents"::bigint END,
          CASE WHEN "tipsSpentCents" IS NULL THEN NULL ELSE "tipsSpentCents"::bigint END,
          CASE WHEN "postsSpentCents" IS NULL THEN NULL ELSE "postsSpentCents"::bigint END,
          CASE WHEN "streamsSpentCents" IS NULL THEN NULL ELSE "streamsSpentCents"::bigint END,
          "lastActivityAt","valueObservedAt","availability","source","valueAuthorityVersion","availabilityAuthorityVersion",
          "platformReportedTotalSpendCentsAuthorityVersion","messagesSpentCentsAuthorityVersion","subscriptionsSpentCentsAuthorityVersion",
          "tipsSpentCentsAuthorityVersion","postsSpentCentsAuthorityVersion","streamsSpentCentsAuthorityVersion","lastActivityAtAuthorityVersion",
          "sourceJobId","scanRunId",NOW(),NOW()
        FROM joined
        ON CONFLICT ("creatorId","fanId") DO UPDATE SET
          "availability" = CASE WHEN "CreatorFanValueCurrent"."availabilityAuthorityVersion" IS NULL OR EXCLUDED."availabilityAuthorityVersion" > "CreatorFanValueCurrent"."availabilityAuthorityVersion" THEN EXCLUDED."availability" ELSE "CreatorFanValueCurrent"."availability" END,
          "availabilityAuthorityVersion" = CASE WHEN "CreatorFanValueCurrent"."availabilityAuthorityVersion" IS NULL OR EXCLUDED."availabilityAuthorityVersion" > "CreatorFanValueCurrent"."availabilityAuthorityVersion" THEN EXCLUDED."availabilityAuthorityVersion" ELSE "CreatorFanValueCurrent"."availabilityAuthorityVersion" END,
          "totalNetCents" = CASE WHEN EXCLUDED."platformReportedTotalSpendCentsAuthorityVersion" IS NOT NULL AND ("CreatorFanValueCurrent"."platformReportedTotalSpendCentsAuthorityVersion" IS NULL OR EXCLUDED."platformReportedTotalSpendCentsAuthorityVersion" > "CreatorFanValueCurrent"."platformReportedTotalSpendCentsAuthorityVersion") THEN EXCLUDED."totalNetCents" ELSE "CreatorFanValueCurrent"."totalNetCents" END,
          "platformReportedTotalSpendCentsAuthorityVersion" = CASE WHEN EXCLUDED."platformReportedTotalSpendCentsAuthorityVersion" IS NOT NULL AND ("CreatorFanValueCurrent"."platformReportedTotalSpendCentsAuthorityVersion" IS NULL OR EXCLUDED."platformReportedTotalSpendCentsAuthorityVersion" > "CreatorFanValueCurrent"."platformReportedTotalSpendCentsAuthorityVersion") THEN EXCLUDED."platformReportedTotalSpendCentsAuthorityVersion" ELSE "CreatorFanValueCurrent"."platformReportedTotalSpendCentsAuthorityVersion" END,
          "messagesNetCents" = CASE WHEN EXCLUDED."messagesSpentCentsAuthorityVersion" IS NOT NULL AND ("CreatorFanValueCurrent"."messagesSpentCentsAuthorityVersion" IS NULL OR EXCLUDED."messagesSpentCentsAuthorityVersion" > "CreatorFanValueCurrent"."messagesSpentCentsAuthorityVersion") THEN EXCLUDED."messagesNetCents" ELSE "CreatorFanValueCurrent"."messagesNetCents" END,
          "messagesSpentCentsAuthorityVersion" = CASE WHEN EXCLUDED."messagesSpentCentsAuthorityVersion" IS NOT NULL AND ("CreatorFanValueCurrent"."messagesSpentCentsAuthorityVersion" IS NULL OR EXCLUDED."messagesSpentCentsAuthorityVersion" > "CreatorFanValueCurrent"."messagesSpentCentsAuthorityVersion") THEN EXCLUDED."messagesSpentCentsAuthorityVersion" ELSE "CreatorFanValueCurrent"."messagesSpentCentsAuthorityVersion" END,
          "subscriptionsNetCents" = CASE WHEN EXCLUDED."subscriptionsSpentCentsAuthorityVersion" IS NOT NULL AND ("CreatorFanValueCurrent"."subscriptionsSpentCentsAuthorityVersion" IS NULL OR EXCLUDED."subscriptionsSpentCentsAuthorityVersion" > "CreatorFanValueCurrent"."subscriptionsSpentCentsAuthorityVersion") THEN EXCLUDED."subscriptionsNetCents" ELSE "CreatorFanValueCurrent"."subscriptionsNetCents" END,
          "subscriptionsSpentCentsAuthorityVersion" = CASE WHEN EXCLUDED."subscriptionsSpentCentsAuthorityVersion" IS NOT NULL AND ("CreatorFanValueCurrent"."subscriptionsSpentCentsAuthorityVersion" IS NULL OR EXCLUDED."subscriptionsSpentCentsAuthorityVersion" > "CreatorFanValueCurrent"."subscriptionsSpentCentsAuthorityVersion") THEN EXCLUDED."subscriptionsSpentCentsAuthorityVersion" ELSE "CreatorFanValueCurrent"."subscriptionsSpentCentsAuthorityVersion" END,
          "tipsNetCents" = CASE WHEN EXCLUDED."tipsSpentCentsAuthorityVersion" IS NOT NULL AND ("CreatorFanValueCurrent"."tipsSpentCentsAuthorityVersion" IS NULL OR EXCLUDED."tipsSpentCentsAuthorityVersion" > "CreatorFanValueCurrent"."tipsSpentCentsAuthorityVersion") THEN EXCLUDED."tipsNetCents" ELSE "CreatorFanValueCurrent"."tipsNetCents" END,
          "tipsSpentCentsAuthorityVersion" = CASE WHEN EXCLUDED."tipsSpentCentsAuthorityVersion" IS NOT NULL AND ("CreatorFanValueCurrent"."tipsSpentCentsAuthorityVersion" IS NULL OR EXCLUDED."tipsSpentCentsAuthorityVersion" > "CreatorFanValueCurrent"."tipsSpentCentsAuthorityVersion") THEN EXCLUDED."tipsSpentCentsAuthorityVersion" ELSE "CreatorFanValueCurrent"."tipsSpentCentsAuthorityVersion" END,
          "postsNetCents" = CASE WHEN EXCLUDED."postsSpentCentsAuthorityVersion" IS NOT NULL AND ("CreatorFanValueCurrent"."postsSpentCentsAuthorityVersion" IS NULL OR EXCLUDED."postsSpentCentsAuthorityVersion" > "CreatorFanValueCurrent"."postsSpentCentsAuthorityVersion") THEN EXCLUDED."postsNetCents" ELSE "CreatorFanValueCurrent"."postsNetCents" END,
          "postsSpentCentsAuthorityVersion" = CASE WHEN EXCLUDED."postsSpentCentsAuthorityVersion" IS NOT NULL AND ("CreatorFanValueCurrent"."postsSpentCentsAuthorityVersion" IS NULL OR EXCLUDED."postsSpentCentsAuthorityVersion" > "CreatorFanValueCurrent"."postsSpentCentsAuthorityVersion") THEN EXCLUDED."postsSpentCentsAuthorityVersion" ELSE "CreatorFanValueCurrent"."postsSpentCentsAuthorityVersion" END,
          "streamsNetCents" = CASE WHEN EXCLUDED."streamsSpentCentsAuthorityVersion" IS NOT NULL AND ("CreatorFanValueCurrent"."streamsSpentCentsAuthorityVersion" IS NULL OR EXCLUDED."streamsSpentCentsAuthorityVersion" > "CreatorFanValueCurrent"."streamsSpentCentsAuthorityVersion") THEN EXCLUDED."streamsNetCents" ELSE "CreatorFanValueCurrent"."streamsNetCents" END,
          "streamsSpentCentsAuthorityVersion" = CASE WHEN EXCLUDED."streamsSpentCentsAuthorityVersion" IS NOT NULL AND ("CreatorFanValueCurrent"."streamsSpentCentsAuthorityVersion" IS NULL OR EXCLUDED."streamsSpentCentsAuthorityVersion" > "CreatorFanValueCurrent"."streamsSpentCentsAuthorityVersion") THEN EXCLUDED."streamsSpentCentsAuthorityVersion" ELSE "CreatorFanValueCurrent"."streamsSpentCentsAuthorityVersion" END,
          "lastActivityAt" = CASE WHEN EXCLUDED."lastActivityAtAuthorityVersion" IS NOT NULL AND ("CreatorFanValueCurrent"."lastActivityAtAuthorityVersion" IS NULL OR EXCLUDED."lastActivityAtAuthorityVersion" > "CreatorFanValueCurrent"."lastActivityAtAuthorityVersion") THEN EXCLUDED."lastActivityAt" ELSE "CreatorFanValueCurrent"."lastActivityAt" END,
          "lastActivityAtAuthorityVersion" = CASE WHEN EXCLUDED."lastActivityAtAuthorityVersion" IS NOT NULL AND ("CreatorFanValueCurrent"."lastActivityAtAuthorityVersion" IS NULL OR EXCLUDED."lastActivityAtAuthorityVersion" > "CreatorFanValueCurrent"."lastActivityAtAuthorityVersion") THEN EXCLUDED."lastActivityAtAuthorityVersion" ELSE "CreatorFanValueCurrent"."lastActivityAtAuthorityVersion" END,
          "fetchedAt" = CASE WHEN "CreatorFanValueCurrent"."valueAuthorityVersion" IS NULL OR EXCLUDED."valueAuthorityVersion" > "CreatorFanValueCurrent"."valueAuthorityVersion" THEN EXCLUDED."fetchedAt" ELSE "CreatorFanValueCurrent"."fetchedAt" END,
          "source" = CASE WHEN "CreatorFanValueCurrent"."valueAuthorityVersion" IS NULL OR EXCLUDED."valueAuthorityVersion" > "CreatorFanValueCurrent"."valueAuthorityVersion" THEN EXCLUDED."source" ELSE "CreatorFanValueCurrent"."source" END,
          "sourceJobId" = CASE WHEN "CreatorFanValueCurrent"."valueAuthorityVersion" IS NULL OR EXCLUDED."valueAuthorityVersion" > "CreatorFanValueCurrent"."valueAuthorityVersion" THEN EXCLUDED."sourceJobId" ELSE "CreatorFanValueCurrent"."sourceJobId" END,
          "scanRunId" = CASE WHEN "CreatorFanValueCurrent"."valueAuthorityVersion" IS NULL OR EXCLUDED."valueAuthorityVersion" > "CreatorFanValueCurrent"."valueAuthorityVersion" THEN EXCLUDED."scanRunId" ELSE "CreatorFanValueCurrent"."scanRunId" END,
          "valueAuthorityVersion" = CASE WHEN "CreatorFanValueCurrent"."valueAuthorityVersion" IS NULL OR EXCLUDED."valueAuthorityVersion" > "CreatorFanValueCurrent"."valueAuthorityVersion" THEN EXCLUDED."valueAuthorityVersion" ELSE "CreatorFanValueCurrent"."valueAuthorityVersion" END,
          "updatedAt" = NOW()
      `, json);
    }
  }

  return { projected: items.length };
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

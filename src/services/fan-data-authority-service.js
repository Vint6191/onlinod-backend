"use strict";

const crypto = require("node:crypto");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { consumeFanObservationToken } = require("./fan-observation-token-service");
const { lockDbAdvisoryXact } = require("./db-transaction-service");
const { acquireCampaignTransactionLock } = require("./campaign-transaction-lock-service");

const IDENTITY_SOURCE_PRIORITY = Object.freeze({
  AUTOMATION_WRITE_RESULT: 900,
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

const FAN_DATA_POINT_REFRESH_CHUNK_MAX = 20;
const FAN_DATA_POINT_REFRESH_MAX_FANS = 500;
const FAN_DATA_OBSERVATION_BATCH_MAX = 500;

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

function parseAuthorityVersion(version) {
  const raw = text(version, 500);
  if (!raw) return null;
  const parts = raw.split("|");
  const observedAt = date(parts[0]);
  if (!observedAt) return { authorityVersion: raw, observedAt: null, source: null, priority: null };
  const priority = Number(parts[1]);
  return {
    authorityVersion: raw,
    observedAt,
    source: text(parts[2], 80) || null,
    priority: Number.isFinite(priority) ? priority : null,
  };
}

function authorityFactIdentity(version) {
  const raw = text(version, 500);
  if (!raw) return null;
  const parts = raw.split("|");
  const observedAt = date(parts[0]);
  const source = text(parts[2], 80);
  const digest = text(parts[3], 128);
  if (!observedAt || !source || !digest) return null;
  return { observedAt: observedAt.toISOString(), source, digest };
}

function sameGenerationContradiction(leftVersion, rightVersion) {
  const left = authorityFactIdentity(leftVersion);
  const right = authorityFactIdentity(rightVersion);
  return Boolean(
    left && right
    && left.observedAt === right.observedAt
    && left.source === right.source
    && left.digest !== right.digest
  );
}

function fanDataConflict(kind, fanId, field, currentVersion, incomingVersion) {
  const error = new FanDataObservationBoundaryError(
    "FAN_DATA_SAME_GENERATION_CONFLICT",
    `Contradictory ${kind} fact for fan ${fanId} field ${field} has the same observation generation and source`,
    409,
  );
  error.details = { kind, fanId, field, currentVersion, incomingVersion };
  return error;
}

function chooseAuthorityEntry(current, candidate, context) {
  if (!candidate?.version) return current || null;
  if (current?.version && sameGenerationContradiction(current.version, candidate.version)) {
    throw fanDataConflict(context.kind, context.fanId, context.field, current.version, candidate.version);
  }
  if (!current?.version || candidate.version > current.version) return candidate;
  return current;
}

function relationshipFieldAuthority(row) {
  if (!row) return {};
  const result = {};
  for (const [field, versionField] of RELATIONSHIP_FIELDS) {
    result[field] = parseAuthorityVersion(row[versionField]);
  }
  return result;
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
  await lockFanAuthorityScope(tx, observation.creatorId, [externalId]);
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
    assertStoredVersionCompatible("identity", externalId, incomingField, fan[versionField], version);
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
  await lockFanAuthorityScope(tx, observation.creatorId, [externalId]);
  const fan = await ensureFanRecord(tx, { ...observation, username: null, platformDisplayName: null });
  const where = { creatorId_onlyFansUserId: { creatorId: observation.creatorId, onlyFansUserId: externalId } };
  const fields = relationshipData(observation);
  if (!Object.keys(fields).length) return tx.creatorFanRelationshipCurrent.findUnique({ where });
  const observationVersion = authorityVersion(observedAt, source, fields);
  let existing = await tx.creatorFanRelationshipCurrent.findUnique({ where });
  if (existing) {
    for (const [field, versionField] of RELATIONSHIP_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(fields, field)) continue;
      const version = authorityVersion(observedAt, source, fields[field]);
      assertStoredVersionCompatible("relationship", externalId, field, existing[versionField], version);
    }
  }
  if (!existing) {
    const create = {
      agencyId: observation.agencyId, creatorId: observation.creatorId, fanRecordId: fan.id, onlyFansUserId: externalId,
      observedAt, source, relationshipAuthorityVersion: observationVersion,
      sourceDeviceId: text(observation.sourceDeviceId, 180), sourceJobId: text(observation.sourceJobId, 180), sourceDeliveryId: text(observation.sourceDeliveryId, 180), scanRunId: text(observation.scanRunId, 180),
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
        sourceDeviceId: text(observation.sourceDeviceId, 180), sourceJobId: text(observation.sourceJobId, 180), sourceDeliveryId: text(observation.sourceDeliveryId, 180), scanRunId: text(observation.scanRunId, 180),
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
  await lockFanAuthorityScope(tx, observation.creatorId, [externalId]);
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
    sourceDeliveryId: text(observation.sourceDeliveryId, 180),
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
  if (existing) {
    assertStoredVersionCompatible("value", externalId, "availability", existing.availabilityAuthorityVersion, availabilityVersion);
    if (availability === VALUE_AVAILABILITY.AVAILABLE) {
      for (const [field, versionField] of VALUE_FIELDS) {
        const value = numeric[field];
        if (value === null) continue;
        assertStoredVersionCompatible("value", externalId, field, existing[versionField], authorityVersion(observedAt, source, value));
      }
    }
    if (lastActivityPresent && (observation.lastActivityAt === null || lastActivityAt)) {
      assertStoredVersionCompatible(
        "value", externalId, "lastActivityAt", existing.lastActivityAtAuthorityVersion, authorityVersion(observedAt, source, lastActivityAt),
      );
    }
  }
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
      sourceDeliveryId: text(observation.sourceDeliveryId, 180),
      scanRunId: text(observation.scanRunId, 180),
    },
  });
  const current = await tx.creatorFanValueCurrent.findUnique({ where });
  return { record: current || existing, replay: Number(result?.count || 0) === 0 && !!existing, fanRecordId: fan.id };
}

function subscriberDirectoryObservationFromItem(item) {
  const metadata = item?.metadata && typeof item.metadata === "object" ? item.metadata : {};
  const observed = metadata.fanDataObservedFields && typeof metadata.fanDataObservedFields === "object"
    ? metadata.fanDataObservedFields
    : {};
  const identityFields = new Set(Array.isArray(observed.identity) ? observed.identity : []);
  const relationshipFields = new Set(Array.isArray(observed.relationship) ? observed.relationship : []);
  const valueFields = new Set(Array.isArray(observed.value) ? observed.value : []);
  const observedAt = date(item?.observedAt);
  const onlyFansUserIdValue = onlyFansUserId(item?.fanId);
  if (!observedAt || !onlyFansUserIdValue) return null;

  const identity = { source: "SUBSCRIBER_DIRECTORY", observedAt };
  if (identityFields.has("username") || (!identityFields.size && item?.username)) identity.username = item.username;
  if (identityFields.has("platformDisplayName") || (!identityFields.size && item?.name)) identity.platformDisplayName = item.name;
  if (identityFields.has("avatarUrl") || (!identityFields.size && item?.avatarUrl)) identity.avatarUrl = item.avatarUrl;

  const relationship = { source: "SUBSCRIBER_DIRECTORY", observedAt };
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
    if (relationshipFields.has(field) || (!relationshipFields.size && item?.[itemField] !== null && item?.[itemField] !== undefined)) {
      relationship[field] = item[itemField];
    }
  }

  // Subscriber directory owns a value fact only when the provider actually
  // returned a positive AVAILABLE total. NOT_FETCHED / UNAVAILABLE / MALFORMED
  // mean that this producer has no canonical value observation and therefore
  // must not overwrite availability or satisfy Campaign freshness debt.
  const subscriberValueAvailable = item?.valueAvailability === VALUE_AVAILABILITY.AVAILABLE && item?.totalSpentCents != null;
  const value = subscriberValueAvailable ? {
    source: "SUBSCRIBER_DIRECTORY",
    observedAt,
    availability: VALUE_AVAILABILITY.AVAILABLE,
  } : null;
  const valueMap = {
    totalSpentCents: "totalSpentCents",
    messagesSpentCents: "messagesSpentCents",
    subscriptionsSpentCents: "subscriptionsSpentCents",
    tipsSpentCents: "tipsSpentCents",
    postsSpentCents: "postsSpentCents",
    streamsSpentCents: "streamsSpentCents",
  };
  if (value) {
    for (const [field, itemField] of Object.entries(valueMap)) {
      if (valueFields.has(field) || (!valueFields.size && item?.[itemField] !== null && item?.[itemField] !== undefined)) value[field] = item[itemField];
    }
  }

  return { onlyFansUserId: onlyFansUserIdValue, identity, relationship, value };
}

async function projectSubscriberDirectoryItems(db, { items = [], agencyId, creatorId, runId, sourceJobId = null, campaignLockHeld = false } = {}) {
  const observations = (Array.isArray(items) ? items : []).map(subscriberDirectoryObservationFromItem).filter(Boolean);
  if (!observations.length) return { ok: true, projected: 0, identityProjected: 0, relationshipProjected: 0, valueProjected: 0, touchedFanIds: [] };
  const authorityReceivedAt = await dbAuthorityNow({ db, fallbackNow: new Date() });
  return commitFanFacts(db, {
    agencyId,
    creatorId,
    sourceJobId,
    scanRunId: runId,
    items: observations,
    allowedSources: ["SUBSCRIBER_DIRECTORY"],
    observedAtPolicy: "TRUSTED_INPUT",
    receivedAt: authorityReceivedAt,
    campaignLockHeld,
  });
}

async function projectSubscriberDirectoryRun(db, { runId, agencyId, creatorId, sourceJobId = null, cursorId = null, limit = 100 } = {}) {
  if (!text(runId, 180) || !text(agencyId, 180) || !text(creatorId, 180)) throw new Error("Invalid subscriber projection scope");
  const take = Math.max(1, Math.min(100, Number(limit) || 100));
  const where = { runId, ...(cursorId ? { id: { gt: String(cursorId) } } : {}) };
  const items = await db.subscriberScanItem.findMany({ where, orderBy: { id: "asc" }, take });
  if (!items.length) return { projected: 0, nextCursorId: cursorId || null, done: true };
  const result = await projectSubscriberDirectoryItems(db, { items, agencyId, creatorId, runId, sourceJobId });
  return {
    projected: result.projected,
    nextCursorId: items[items.length - 1].id,
    done: items.length < take,
  };
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

class FanDataObservationBoundaryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "FanDataObservationBoundaryError";
    this.code = code;
    this.status = status;
  }
}

const BATCH_IDENTITY_FACT_KEYS = Object.freeze([
  "username", "platformDisplayName", "displayName", "avatarUrl", "headerUrl", "activityObservedAt",
]);
const BATCH_RELATIONSHIP_FACT_KEYS = Object.freeze(RELATIONSHIP_FIELDS.map(([field]) => field));
const BATCH_VALUE_FACT_KEYS = Object.freeze([
  "availability", "totalSpentCents", "platformReportedTotalSpendCents",
  "messagesSpentCents", "subscriptionsSpentCents", "tipsSpentCents", "postsSpentCents", "streamsSpentCents",
  "lastActivityAt",
]);

async function lockFanAuthorityScope(tx, creatorId, fanIds) {
  const ids = [...new Set((fanIds || []).map(onlyFansUserId).filter(Boolean))];
  if (!ids.length || typeof tx?.$executeRawUnsafe !== "function") return;
  // Same-generation conflict detection must serialize the read-before-write
  // boundary, but FanData does not own a second advisory-lock implementation.
  // A single creator-scoped key keeps the bulk path O(1) in lock statements and
  // routes physical lock semantics through the project-wide DB lock authority.
  await lockDbAdvisoryXact({ db: tx, key: `fan_data_authority:${String(creatorId)}` });
}

function assertStoredVersionCompatible(kind, fanId, field, currentVersion, incomingVersion) {
  if (currentVersion && incomingVersion && sameGenerationContradiction(currentVersion, incomingVersion)) {
    throw fanDataConflict(kind, fanId, field, currentVersion, incomingVersion);
  }
}

async function assertNoPersistedBulkAuthorityConflicts(tx, { creatorId, fanRows, relationshipRows, valueRows }) {
  const fanIds = [...new Set([
    ...fanRows.map((row) => row.onlyFansUserId),
    ...relationshipRows.map((row) => row.onlyFansUserId),
    ...valueRows.map((row) => row.onlyFansUserId),
  ])].filter(Boolean);
  if (!fanIds.length) return;

  const currentFans = typeof tx?.creatorFan?.findMany === "function"
    ? await tx.creatorFan.findMany({ where: { creatorId, onlyFansUserId: { in: fanIds } } })
    : [];
  const fanByExternalId = new Map((currentFans || []).map((row) => [String(row.onlyFansUserId), row]));

  for (const incoming of fanRows) {
    const current = fanByExternalId.get(String(incoming.onlyFansUserId));
    if (!current) continue;
    for (const [incomingField, _dbField, versionField] of IDENTITY_FIELDS) {
      assertStoredVersionCompatible("identity", incoming.onlyFansUserId, incomingField, current[versionField], incoming[versionField]);
    }
  }

  const currentRelationships = typeof tx?.creatorFanRelationshipCurrent?.findMany === "function"
    ? await tx.creatorFanRelationshipCurrent.findMany({ where: { creatorId, onlyFansUserId: { in: fanIds } } })
    : [];
  const relationshipByExternalId = new Map((currentRelationships || []).map((row) => [String(row.onlyFansUserId), row]));
  for (const incoming of relationshipRows) {
    const current = relationshipByExternalId.get(String(incoming.onlyFansUserId));
    if (!current) continue;
    for (const [field, versionField] of RELATIONSHIP_FIELDS) {
      assertStoredVersionCompatible("relationship", incoming.onlyFansUserId, field, current[versionField], incoming[versionField]);
    }
  }

  const fanRecordIds = [...new Set((currentFans || []).map((row) => row.id).filter(Boolean))];
  const currentValues = fanRecordIds.length && typeof tx?.creatorFanValueCurrent?.findMany === "function"
    ? await tx.creatorFanValueCurrent.findMany({ where: { creatorId, fanRecordId: { in: fanRecordIds } } })
    : [];
  const fanExternalIdByRecordId = new Map((currentFans || []).map((row) => [String(row.id), String(row.onlyFansUserId)]));
  const valueByExternalId = new Map((currentValues || []).map((row) => [fanExternalIdByRecordId.get(String(row.fanRecordId)), row]));
  for (const incoming of valueRows) {
    const current = valueByExternalId.get(String(incoming.onlyFansUserId));
    if (!current) continue;
    assertStoredVersionCompatible("value", incoming.onlyFansUserId, "availability", current.availabilityAuthorityVersion, incoming.availabilityAuthorityVersion);
    for (const [field, versionField] of VALUE_FIELDS) {
      assertStoredVersionCompatible("value", incoming.onlyFansUserId, field, current[versionField], incoming[versionField]);
    }
    assertStoredVersionCompatible("value", incoming.onlyFansUserId, "lastActivityAt", current.lastActivityAtAuthorityVersion, incoming.lastActivityAtAuthorityVersion);
  }
}

function ownFacts(input, keys) {
  const out = {};
  if (!input || typeof input !== "object") return out;
  for (const key of keys) if (Object.prototype.hasOwnProperty.call(input, key)) out[key] = input[key];
  return out;
}

function trustedBatchSource(rawSource, allowedSources) {
  const source = text(rawSource, 80);
  if (!source) throw new FanDataObservationBoundaryError("FAN_DATA_OBSERVATION_SOURCE_REQUIRED", "Fan observation source is required");
  const allowed = new Set((Array.isArray(allowedSources) ? allowedSources : []).map((value) => text(value, 80)).filter(Boolean));
  if (!allowed.size) {
    throw new FanDataObservationBoundaryError("FAN_DATA_OBSERVATION_PRODUCER_POLICY_REQUIRED", "Fan observation producer policy is required", 500);
  }
  if (!allowed.has(source)) {
    throw new FanDataObservationBoundaryError("FAN_DATA_OBSERVATION_SOURCE_FORBIDDEN", `Fan observation source ${source} is not allowed for this producer`, 403);
  }
  return source;
}

function batchObservedAt(rawObservedAt, { observedAtPolicy, receivedAt, causalObservedAt }) {
  const receipt = date(receivedAt) || new Date();
  if (observedAtPolicy === "SERVER_RECEIPT") return receipt;
  // A server-issued producer generation is a conservative causal token: it is
  // created before the provider read and therefore prevents an older delayed
  // result from becoming "new" merely because transport finished later. The
  // client timestamp remains provenance only and never participates in current
  // FanData ordering on this path.
  if (observedAtPolicy === "SERVER_GENERATION") {
    const causal = date(causalObservedAt);
    if (!causal) {
      throw new FanDataObservationBoundaryError(
        "FAN_DATA_OBSERVATION_CAUSAL_GENERATION_REQUIRED",
        "Fan observation producer is missing its server-owned causal generation",
        500,
      );
    }
    return causal;
  }
  if (observedAtPolicy !== "TRUSTED_INPUT") {
    throw new FanDataObservationBoundaryError("FAN_DATA_OBSERVATION_TIME_POLICY_REQUIRED", "Fan observation time policy is required", 500);
  }
  const parsed = date(rawObservedAt);
  if (!parsed) throw new FanDataObservationBoundaryError("FAN_DATA_OBSERVATION_TIME_INVALID", "Fan observation timestamp is invalid");
  return parsed;
}

function normalizeBatchObservation(raw, envelope) {
  const externalId = onlyFansUserId(raw?.onlyFansUserId);
  if (!externalId) return null;
  const common = {
    agencyId: envelope.agencyId,
    creatorId: envelope.creatorId,
    onlyFansUserId: externalId,
    sourceDeviceId: envelope.sourceDeviceId,
    sourceJobId: envelope.sourceJobId,
    sourceDeliveryId: envelope.sourceDeliveryId,
    scanRunId: envelope.scanRunId,
  };
  const normalized = { onlyFansUserId: externalId };
  for (const [kind, keys] of [
    ["identity", BATCH_IDENTITY_FACT_KEYS],
    ["relationship", BATCH_RELATIONSHIP_FACT_KEYS],
    ["value", BATCH_VALUE_FACT_KEYS],
  ]) {
    const input = raw?.[kind];
    if (!input || typeof input !== "object") continue;
    const source = trustedBatchSource(input.source, envelope.allowedSources);
    const observedAt = batchObservedAt(input.observedAt, envelope);
    normalized[kind] = { ...ownFacts(input, keys), source, observedAt, ...common };
  }
  if (!normalized.identity && !normalized.relationship && !normalized.value) return null;
  return normalized;
}

function maxVersionEntry(current, candidate, context = null) {
  if (context) return chooseAuthorityEntry(current, candidate, context);
  if (!candidate?.version) return current || null;
  if (!current?.version || candidate.version > current.version) return candidate;
  return current;
}

function initialFanSeenAt(row) {
  const evidence = row.identity || row.relationship || row.value;
  return date(row.identity?.activityObservedAt) || date(evidence?.observedAt);
}

function buildGenericFanObservationBulkRows(rows, { agencyId, creatorId, sourceDeviceId, sourceJobId, sourceDeliveryId }) {
  const fans = new Map();
  const relationships = new Map();
  const values = new Map();

  for (const row of rows) {
    const fanId = row.onlyFansUserId;
    let fan = fans.get(fanId);
    if (!fan) {
      const initialSeen = initialFanSeenAt(row);
      if (!initialSeen) throw new Error("Invalid fan observation timestamp");
      fan = {
        id: crypto.randomUUID(), agencyId, creatorId, onlyFansUserId: fanId,
        initialSeenAt: initialSeen, activityMin: null, activityMax: null,
        identityFields: {}, identityAggregate: null,
      };
      fans.set(fanId, fan);
    }

    const identity = row.identity || null;
    if (identity) {
      const identityActivity = date(identity.activityObservedAt);
      if (identityActivity) {
        if (!fan.activityMin || identityActivity < fan.activityMin) fan.activityMin = identityActivity;
        if (!fan.activityMax || identityActivity > fan.activityMax) fan.activityMax = identityActivity;
      }
      const source = text(identity.source, 80) || "UNKNOWN";
      if (source !== "PRESENCE_HINT") {
        const observedAt = date(identity.observedAt);
        const incoming = cleanIdentityFields(identity, { rejectSynthetic: identity.rejectSyntheticIdentity === true });
        for (const [incomingField, dbField, versionField] of IDENTITY_FIELDS) {
          const value = incoming[incomingField];
          if (value === null) continue;
          const version = authorityVersion(observedAt, source, value);
          const previous = fan.identityFields[versionField];
          fan.identityFields[versionField] = chooseAuthorityEntry(
            previous,
            { dbField, value, version },
            { kind: "identity", fanId, field: incomingField },
          );
        }
        if (Object.values(incoming).some((value) => value !== null)) {
          const version = authorityVersion(observedAt, source, incoming);
          fan.identityAggregate = maxVersionEntry(fan.identityAggregate, { version, observedAt, source });
        }
      }
    }

    const relationship = row.relationship || null;
    if (relationship) {
      const observedAt = date(relationship.observedAt);
      const source = text(relationship.source, 80) || "UNKNOWN";
      const facts = relationshipData(relationship);
      if (Object.keys(facts).length) {
        let aggregate = relationships.get(fanId);
        if (!aggregate) {
          aggregate = { id: crypto.randomUUID(), agencyId, creatorId, onlyFansUserId: fanId, fields: {}, aggregate: null };
          relationships.set(fanId, aggregate);
        }
        for (const [field, versionField] of RELATIONSHIP_FIELDS) {
          if (!Object.prototype.hasOwnProperty.call(facts, field)) continue;
          const value = facts[field];
          const version = authorityVersion(observedAt, source, value);
          const previous = aggregate.fields[versionField];
          aggregate.fields[versionField] = chooseAuthorityEntry(
            previous,
            { field, value, version },
            { kind: "relationship", fanId, field },
          );
        }
        const version = authorityVersion(observedAt, source, facts);
        aggregate.aggregate = maxVersionEntry(aggregate.aggregate, {
          version, observedAt, source,
          sourceDeviceId: text(relationship.sourceDeviceId ?? sourceDeviceId, 180),
          sourceJobId: text(relationship.sourceJobId ?? sourceJobId, 180),
          sourceDeliveryId: text(relationship.sourceDeliveryId ?? sourceDeliveryId, 180),
          scanRunId: text(relationship.scanRunId, 180),
        });
      }
    }

    const value = row.value || null;
    if (value) {
      const source = text(value.source, 80) || "UNKNOWN";
      if (source === "PRESENCE_HINT") {
        const activity = date(value.activityObservedAt ?? value.lastActivityAt);
        if (activity) {
          if (!fan.activityMin || activity < fan.activityMin) fan.activityMin = activity;
          if (!fan.activityMax || activity > fan.activityMax) fan.activityMax = activity;
        }
      } else {
        const observedAt = date(value.observedAt);
        const normalized = normalizedFanValueFacts(value);
        let aggregate = values.get(fanId);
        if (!aggregate) {
          aggregate = { id: crypto.randomUUID(), agencyId, creatorId, onlyFansUserId: fanId, fields: {}, availability: null, aggregate: null };
          values.set(fanId, aggregate);
        }
        const availabilityVersion = authorityVersion(observedAt, source, normalized.availability);
        aggregate.availability = maxVersionEntry(aggregate.availability, {
          version: availabilityVersion, value: normalized.availability,
        }, { kind: "value", fanId, field: "availability" });
        if (normalized.availability === VALUE_AVAILABILITY.AVAILABLE) {
          for (const [field, versionField] of VALUE_FIELDS) {
            const fieldValue = normalized.numeric[field];
            if (fieldValue === null) continue;
            const version = authorityVersion(observedAt, source, fieldValue);
            const previous = aggregate.fields[versionField];
            aggregate.fields[versionField] = chooseAuthorityEntry(
              previous,
              { field, value: fieldValue, version },
              { kind: "value", fanId, field },
            );
          }
        }
        if (normalized.lastActivityPresent && (value.lastActivityAt === null || normalized.lastActivityAt)) {
          const version = authorityVersion(observedAt, source, normalized.lastActivityAt);
          const previous = aggregate.fields.lastActivityAtAuthorityVersion;
          aggregate.fields.lastActivityAtAuthorityVersion = chooseAuthorityEntry(
            previous,
            { field: "lastActivityAt", value: normalized.lastActivityAt, version },
            { kind: "value", fanId, field: "lastActivityAt" },
          );
        }
        const version = authorityVersion(observedAt, source, normalized.observedFields);
        aggregate.aggregate = maxVersionEntry(aggregate.aggregate, {
          version, observedAt, source,
          sourceDeviceId: text(value.sourceDeviceId ?? sourceDeviceId, 180),
          sourceJobId: text(value.sourceJobId ?? sourceJobId, 180),
          sourceDeliveryId: text(value.sourceDeliveryId ?? sourceDeliveryId, 180),
          scanRunId: text(value.scanRunId, 180),
        });
      }
    }
  }

  const fanRows = [...fans.values()].map((fan) => {
    const row = {
      id: fan.id, agencyId, creatorId, onlyFansUserId: fan.onlyFansUserId,
      initialSeenAt: fan.initialSeenAt.toISOString(),
      activityMin: fan.activityMin?.toISOString?.() || null,
      activityMax: fan.activityMax?.toISOString?.() || null,
      username: null, displayName: null, avatarUrl: null, headerUrl: null,
      usernameAuthorityVersion: null, displayNameAuthorityVersion: null, avatarAuthorityVersion: null, headerAuthorityVersion: null,
      identityAuthorityVersion: fan.identityAggregate?.version || null,
      identityObservedAt: fan.identityAggregate?.observedAt?.toISOString?.() || null,
      identitySource: fan.identityAggregate?.source || null,
    };
    for (const [versionField, entry] of Object.entries(fan.identityFields)) {
      row[entry.dbField] = entry.value;
      row[versionField] = entry.version;
    }
    return row;
  });

  const relationshipRows = [...relationships.values()].map((aggregate) => {
    const row = {
      id: aggregate.id, agencyId, creatorId, onlyFansUserId: aggregate.onlyFansUserId,
      observedAt: aggregate.aggregate.observedAt.toISOString(), source: aggregate.aggregate.source,
      sourceDeviceId: aggregate.aggregate.sourceDeviceId, sourceJobId: aggregate.aggregate.sourceJobId, sourceDeliveryId: aggregate.aggregate.sourceDeliveryId, scanRunId: aggregate.aggregate.scanRunId,
      relationshipAuthorityVersion: aggregate.aggregate.version,
    };
    for (const [versionField, entry] of Object.entries(aggregate.fields)) {
      row[entry.field] = entry.value instanceof Date ? entry.value.toISOString() : entry.value;
      row[versionField] = entry.version;
    }
    return row;
  });

  const valueRows = [...values.values()].map((aggregate) => {
    const row = {
      id: aggregate.id, agencyId, creatorId, onlyFansUserId: aggregate.onlyFansUserId,
      availability: aggregate.availability.value,
      availabilityAuthorityVersion: aggregate.availability.version,
      valueObservedAt: aggregate.aggregate.observedAt.toISOString(), source: aggregate.aggregate.source,
      valueAuthorityVersion: aggregate.aggregate.version,
      sourceDeviceId: aggregate.aggregate.sourceDeviceId, sourceJobId: aggregate.aggregate.sourceJobId, sourceDeliveryId: aggregate.aggregate.sourceDeliveryId, scanRunId: aggregate.aggregate.scanRunId,
    };
    for (const [versionField, entry] of Object.entries(aggregate.fields)) {
      const raw = entry.value;
      row[entry.field] = typeof raw === "bigint" ? raw.toString() : raw instanceof Date ? raw.toISOString() : raw;
      row[versionField] = entry.version;
    }
    return row;
  });

  const byFanId = (a, b) => {
    const left = String(a.onlyFansUserId);
    const right = String(b.onlyFansUserId);
    return left < right ? -1 : left > right ? 1 : 0;
  };
  fanRows.sort(byFanId);
  relationshipRows.sort(byFanId);
  valueRows.sort(byFanId);
  return { fanRows, relationshipRows, valueRows };
}

async function applyGenericFanObservationBulkSql(tx, rows, scope) {
  const { fanRows, relationshipRows, valueRows } = buildGenericFanObservationBulkRows(rows, scope);
  const fanIds = [...new Set(rows.map((row) => row.onlyFansUserId).filter(Boolean))];
  await lockFanAuthorityScope(tx, scope.creatorId, fanIds);
  await assertNoPersistedBulkAuthorityConflicts(tx, { creatorId: scope.creatorId, fanRows, relationshipRows, valueRows });
  if (fanRows.length) {
    const json = JSON.stringify(fanRows);
    await tx.$executeRawUnsafe(`
      WITH incoming AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS i(
          "id" text,"agencyId" text,"creatorId" text,"onlyFansUserId" text,
          "initialSeenAt" timestamptz,"activityMin" timestamptz,"activityMax" timestamptz,
          "username" text,"displayName" text,"avatarUrl" text,"headerUrl" text,
          "usernameAuthorityVersion" text,"displayNameAuthorityVersion" text,"avatarAuthorityVersion" text,"headerAuthorityVersion" text,
          "identityAuthorityVersion" text,"identityObservedAt" timestamptz,"identitySource" text
        )
      )
      INSERT INTO "CreatorFan" (
        "id","agencyId","creatorId","onlyFansUserId","username","displayName","avatarUrl","headerUrl",
        "identityObservedAt","identitySource","identityAuthorityVersion",
        "usernameAuthorityVersion","displayNameAuthorityVersion","avatarAuthorityVersion","headerAuthorityVersion",
        "firstSeenAt","lastSeenAt","lastActivityObservedAt","createdAt","updatedAt"
      )
      SELECT
        i."id",i."agencyId",i."creatorId",i."onlyFansUserId",i."username",i."displayName",i."avatarUrl",i."headerUrl",
        i."identityObservedAt",i."identitySource",i."identityAuthorityVersion",
        i."usernameAuthorityVersion",i."displayNameAuthorityVersion",i."avatarAuthorityVersion",i."headerAuthorityVersion",
        LEAST(i."initialSeenAt",COALESCE(i."activityMin",i."initialSeenAt")),
        GREATEST(i."initialSeenAt",COALESCE(i."activityMax",i."initialSeenAt")),
        i."activityMax",NOW(),NOW()
      FROM incoming i
      ON CONFLICT ("creatorId","onlyFansUserId") DO UPDATE SET
        "username" = CASE WHEN EXCLUDED."usernameAuthorityVersion" IS NOT NULL AND ("CreatorFan"."usernameAuthorityVersion" IS NULL OR EXCLUDED."usernameAuthorityVersion" > "CreatorFan"."usernameAuthorityVersion") THEN EXCLUDED."username" ELSE "CreatorFan"."username" END,
        "usernameAuthorityVersion" = CASE WHEN EXCLUDED."usernameAuthorityVersion" IS NOT NULL AND ("CreatorFan"."usernameAuthorityVersion" IS NULL OR EXCLUDED."usernameAuthorityVersion" > "CreatorFan"."usernameAuthorityVersion") THEN EXCLUDED."usernameAuthorityVersion" ELSE "CreatorFan"."usernameAuthorityVersion" END,
        "displayName" = CASE WHEN EXCLUDED."displayNameAuthorityVersion" IS NOT NULL AND ("CreatorFan"."displayNameAuthorityVersion" IS NULL OR EXCLUDED."displayNameAuthorityVersion" > "CreatorFan"."displayNameAuthorityVersion") THEN EXCLUDED."displayName" ELSE "CreatorFan"."displayName" END,
        "displayNameAuthorityVersion" = CASE WHEN EXCLUDED."displayNameAuthorityVersion" IS NOT NULL AND ("CreatorFan"."displayNameAuthorityVersion" IS NULL OR EXCLUDED."displayNameAuthorityVersion" > "CreatorFan"."displayNameAuthorityVersion") THEN EXCLUDED."displayNameAuthorityVersion" ELSE "CreatorFan"."displayNameAuthorityVersion" END,
        "avatarUrl" = CASE WHEN EXCLUDED."avatarAuthorityVersion" IS NOT NULL AND ("CreatorFan"."avatarAuthorityVersion" IS NULL OR EXCLUDED."avatarAuthorityVersion" > "CreatorFan"."avatarAuthorityVersion") THEN EXCLUDED."avatarUrl" ELSE "CreatorFan"."avatarUrl" END,
        "avatarAuthorityVersion" = CASE WHEN EXCLUDED."avatarAuthorityVersion" IS NOT NULL AND ("CreatorFan"."avatarAuthorityVersion" IS NULL OR EXCLUDED."avatarAuthorityVersion" > "CreatorFan"."avatarAuthorityVersion") THEN EXCLUDED."avatarAuthorityVersion" ELSE "CreatorFan"."avatarAuthorityVersion" END,
        "headerUrl" = CASE WHEN EXCLUDED."headerAuthorityVersion" IS NOT NULL AND ("CreatorFan"."headerAuthorityVersion" IS NULL OR EXCLUDED."headerAuthorityVersion" > "CreatorFan"."headerAuthorityVersion") THEN EXCLUDED."headerUrl" ELSE "CreatorFan"."headerUrl" END,
        "headerAuthorityVersion" = CASE WHEN EXCLUDED."headerAuthorityVersion" IS NOT NULL AND ("CreatorFan"."headerAuthorityVersion" IS NULL OR EXCLUDED."headerAuthorityVersion" > "CreatorFan"."headerAuthorityVersion") THEN EXCLUDED."headerAuthorityVersion" ELSE "CreatorFan"."headerAuthorityVersion" END,
        "identityObservedAt" = CASE WHEN EXCLUDED."identityAuthorityVersion" IS NOT NULL AND ("CreatorFan"."identityAuthorityVersion" IS NULL OR EXCLUDED."identityAuthorityVersion" > "CreatorFan"."identityAuthorityVersion") THEN EXCLUDED."identityObservedAt" ELSE "CreatorFan"."identityObservedAt" END,
        "identitySource" = CASE WHEN EXCLUDED."identityAuthorityVersion" IS NOT NULL AND ("CreatorFan"."identityAuthorityVersion" IS NULL OR EXCLUDED."identityAuthorityVersion" > "CreatorFan"."identityAuthorityVersion") THEN EXCLUDED."identitySource" ELSE "CreatorFan"."identitySource" END,
        "identityAuthorityVersion" = CASE WHEN EXCLUDED."identityAuthorityVersion" IS NOT NULL AND ("CreatorFan"."identityAuthorityVersion" IS NULL OR EXCLUDED."identityAuthorityVersion" > "CreatorFan"."identityAuthorityVersion") THEN EXCLUDED."identityAuthorityVersion" ELSE "CreatorFan"."identityAuthorityVersion" END,
        "updatedAt" = NOW()
    `, json);
    await tx.$executeRawUnsafe(`
      WITH incoming AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS i(
          "onlyFansUserId" text,"activityMin" timestamptz,"activityMax" timestamptz
        )
      )
      UPDATE "CreatorFan" f SET
        "firstSeenAt" = CASE WHEN i."activityMin" IS NOT NULL THEN LEAST(f."firstSeenAt", i."activityMin") ELSE f."firstSeenAt" END,
        "lastSeenAt" = CASE WHEN i."activityMax" IS NOT NULL AND i."activityMax" > f."lastSeenAt" THEN i."activityMax" ELSE f."lastSeenAt" END,
        "lastActivityObservedAt" = CASE WHEN i."activityMax" IS NOT NULL AND (f."lastActivityObservedAt" IS NULL OR i."activityMax" > f."lastActivityObservedAt") THEN i."activityMax" ELSE f."lastActivityObservedAt" END,
        "identityCompleteness" = CASE
          WHEN f."username" IS NOT NULL AND f."displayName" IS NOT NULL AND f."avatarUrl" IS NOT NULL AND f."headerUrl" IS NOT NULL THEN 'FULL'
          WHEN f."username" IS NOT NULL OR f."displayName" IS NOT NULL OR f."avatarUrl" IS NOT NULL OR f."headerUrl" IS NOT NULL THEN 'PARTIAL'
          ELSE NULL END,
        "updatedAt" = NOW()
      FROM incoming i
      WHERE f."creatorId" = $2 AND f."onlyFansUserId" = i."onlyFansUserId"
    `, json, scope.creatorId);
  }

  if (relationshipRows.length) {
    const json = JSON.stringify(relationshipRows);
    await tx.$executeRawUnsafe(`
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
          "observedAt" timestamptz,"source" text,"sourceDeviceId" text,"sourceJobId" text,"sourceDeliveryId" text,"scanRunId" text
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
        "observedAt","source","sourceDeviceId","sourceJobId","sourceDeliveryId","scanRunId","createdAt","updatedAt"
      )
      SELECT
        "id","agencyId","creatorId","fanRecordId","onlyFansUserId",
        "fanSubscribesToCreator","fanSubscriptionActive","fanSubscriptionType","fanSubscriptionExpiresAt","creatorFollowsFan","creatorFollowExpiresAt",
        "canReceiveChatMessage","blocked","restricted","performer","lastSeenAt","subscribePriceCents",
        "relationshipAuthorityVersion","fanSubscribesToCreatorAuthorityVersion","fanSubscriptionActiveAuthorityVersion","fanSubscriptionTypeAuthorityVersion",
        "fanSubscriptionExpiresAtAuthorityVersion","creatorFollowsFanAuthorityVersion","creatorFollowExpiresAtAuthorityVersion","canReceiveChatMessageAuthorityVersion",
        "blockedAuthorityVersion","restrictedAuthorityVersion","performerAuthorityVersion","lastSeenAtAuthorityVersion","subscribePriceCentsAuthorityVersion",
        "observedAt","source","sourceDeviceId","sourceJobId","sourceDeliveryId","scanRunId",NOW(),NOW()
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
        "sourceDeviceId" = CASE WHEN "CreatorFanRelationshipCurrent"."relationshipAuthorityVersion" IS NULL OR EXCLUDED."relationshipAuthorityVersion" > "CreatorFanRelationshipCurrent"."relationshipAuthorityVersion" THEN EXCLUDED."sourceDeviceId" ELSE "CreatorFanRelationshipCurrent"."sourceDeviceId" END,
        "sourceJobId" = CASE WHEN "CreatorFanRelationshipCurrent"."relationshipAuthorityVersion" IS NULL OR EXCLUDED."relationshipAuthorityVersion" > "CreatorFanRelationshipCurrent"."relationshipAuthorityVersion" THEN EXCLUDED."sourceJobId" ELSE "CreatorFanRelationshipCurrent"."sourceJobId" END,
        "sourceDeliveryId" = CASE WHEN "CreatorFanRelationshipCurrent"."relationshipAuthorityVersion" IS NULL OR EXCLUDED."relationshipAuthorityVersion" > "CreatorFanRelationshipCurrent"."relationshipAuthorityVersion" THEN EXCLUDED."sourceDeliveryId" ELSE "CreatorFanRelationshipCurrent"."sourceDeliveryId" END,
        "scanRunId" = CASE WHEN "CreatorFanRelationshipCurrent"."relationshipAuthorityVersion" IS NULL OR EXCLUDED."relationshipAuthorityVersion" > "CreatorFanRelationshipCurrent"."relationshipAuthorityVersion" THEN EXCLUDED."scanRunId" ELSE "CreatorFanRelationshipCurrent"."scanRunId" END,
        "relationshipAuthorityVersion" = CASE WHEN "CreatorFanRelationshipCurrent"."relationshipAuthorityVersion" IS NULL OR EXCLUDED."relationshipAuthorityVersion" > "CreatorFanRelationshipCurrent"."relationshipAuthorityVersion" THEN EXCLUDED."relationshipAuthorityVersion" ELSE "CreatorFanRelationshipCurrent"."relationshipAuthorityVersion" END,
        "updatedAt" = NOW()
    `, json);
  }

  if (valueRows.length) {
    const json = JSON.stringify(valueRows);
    await tx.$executeRawUnsafe(`
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
          "lastActivityAt" timestamptz,"lastActivityAtAuthorityVersion" text,
          "sourceDeviceId" text,"sourceJobId" text,"sourceDeliveryId" text,"scanRunId" text
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
        "sourceDeviceId","sourceJobId","sourceDeliveryId","scanRunId","createdAt","updatedAt"
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
        "sourceDeviceId","sourceJobId","sourceDeliveryId","scanRunId",NOW(),NOW()
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
        "sourceDeviceId" = CASE WHEN "CreatorFanValueCurrent"."valueAuthorityVersion" IS NULL OR EXCLUDED."valueAuthorityVersion" > "CreatorFanValueCurrent"."valueAuthorityVersion" THEN EXCLUDED."sourceDeviceId" ELSE "CreatorFanValueCurrent"."sourceDeviceId" END,
        "sourceJobId" = CASE WHEN "CreatorFanValueCurrent"."valueAuthorityVersion" IS NULL OR EXCLUDED."valueAuthorityVersion" > "CreatorFanValueCurrent"."valueAuthorityVersion" THEN EXCLUDED."sourceJobId" ELSE "CreatorFanValueCurrent"."sourceJobId" END,
        "sourceDeliveryId" = CASE WHEN "CreatorFanValueCurrent"."valueAuthorityVersion" IS NULL OR EXCLUDED."valueAuthorityVersion" > "CreatorFanValueCurrent"."valueAuthorityVersion" THEN EXCLUDED."sourceDeliveryId" ELSE "CreatorFanValueCurrent"."sourceDeliveryId" END,
        "scanRunId" = CASE WHEN "CreatorFanValueCurrent"."valueAuthorityVersion" IS NULL OR EXCLUDED."valueAuthorityVersion" > "CreatorFanValueCurrent"."valueAuthorityVersion" THEN EXCLUDED."scanRunId" ELSE "CreatorFanValueCurrent"."scanRunId" END,
        "valueAuthorityVersion" = CASE WHEN "CreatorFanValueCurrent"."valueAuthorityVersion" IS NULL OR EXCLUDED."valueAuthorityVersion" > "CreatorFanValueCurrent"."valueAuthorityVersion" THEN EXCLUDED."valueAuthorityVersion" ELSE "CreatorFanValueCurrent"."valueAuthorityVersion" END,
        "updatedAt" = NOW()
    `, json);
  }

  return { statements: (fanRows.length ? 2 : 0) + (relationshipRows.length ? 1 : 0) + (valueRows.length ? 1 : 0) };
}


async function commitFanFacts(db, {
  agencyId, creatorId, sourceDeviceId = null, sourceJobId = null, sourceDeliveryId = null, scanRunId = null, items = [],
  allowedSources = null, observedAtPolicy = null, receivedAt = new Date(), causalObservedAt = null, campaignLockHeld = false,
} = {}) {
  const scopedAgencyId = text(agencyId, 180);
  const scopedCreatorId = text(creatorId, 180);
  if (!scopedAgencyId || !scopedCreatorId) throw new Error("Invalid fan observation batch scope");
  const envelope = {
    agencyId: scopedAgencyId,
    creatorId: scopedCreatorId,
    sourceDeviceId: text(sourceDeviceId, 180),
    sourceJobId: text(sourceJobId, 180),
    sourceDeliveryId: text(sourceDeliveryId, 180),
    scanRunId: text(scanRunId, 180),
    allowedSources,
    observedAtPolicy,
    receivedAt: date(receivedAt) || new Date(),
    causalObservedAt: date(causalObservedAt),
  };
  // Validate and strip the entire producer payload before any DB mutation. Nested
  // objects own facts only; tenant/creator/fan/provenance/source/time authority is
  // supplied by the trusted envelope and can never be reintroduced by spread order.
  const inputItems = Array.isArray(items) ? items : [];
  if (inputItems.length > FAN_DATA_OBSERVATION_BATCH_MAX) {
    throw new FanDataObservationBoundaryError(
      "FAN_DATA_OBSERVATION_BATCH_TOO_LARGE",
      `Fan observation batch exceeds ${FAN_DATA_OBSERVATION_BATCH_MAX} observations`,
      413,
    );
  }
  const rows = inputItems
    .map((raw) => normalizeBatchObservation(raw, envelope))
    .filter(Boolean);
  const apply = async (tx) => {
    const identityProjected = rows.reduce((count, row) => count + (row.identity ? 1 : 0), 0);
    const relationshipProjected = rows.reduce((count, row) => count + (row.relationship ? 1 : 0), 0);
    const valueProjected = rows.reduce((count, row) => count + (row.value ? 1 : 0), 0);
    const touchedFanIds = rows.map((row) => row.onlyFansUserId);
    const valueFanIds = rows.filter((row) => row.value).map((row) => row.onlyFansUserId);

    // Campaign freshness reconciliation mutates creator-wide Campaign demand /
    // work / collection-state authority. Acquire that creator lock before the
    // FanData authority lock taken by the bulk projector, so every value path
    // has the same global order: campaign creator -> FanData creator -> demand
    // -> work -> collection state. This closes the mixed-page deadlock where a
    // Campaign ingest held collection state while another value writer held
    // FanData/demand authority and waited back on Campaign state.
    let campaignAuthorityHeld = campaignLockHeld === true;
    if (valueFanIds.length && typeof tx.$executeRawUnsafe === "function" && !campaignAuthorityHeld) {
      await acquireCampaignTransactionLock(tx, scopedCreatorId);
      campaignAuthorityHeld = true;
    }

    // PostgreSQL production path: one bounded JSONB upsert set per canonical table,
    // independent of fan/field count. In-memory/unit adapters keep the semantic
    // projector fallback below so tests can exercise authority behavior without SQL.
    if (rows.length && typeof tx.$executeRawUnsafe === "function") {
      await applyGenericFanObservationBulkSql(tx, rows, {
        agencyId: scopedAgencyId, creatorId: scopedCreatorId,
        sourceDeviceId: envelope.sourceDeviceId, sourceJobId: envelope.sourceJobId, sourceDeliveryId: envelope.sourceDeliveryId,
      });
      if (valueFanIds.length) {
        const { reconcileCampaignFanRefreshDemandsFromCanonicalObservations } = require("./campaign-fan-refresh-queue-service");
        await reconcileCampaignFanRefreshDemandsFromCanonicalObservations({
          db: tx, creatorId: scopedCreatorId, fanIds: valueFanIds, now: envelope.receivedAt, _campaignLockHeld: campaignAuthorityHeld,
        });
      }
      return { ok: true, projected: rows.length, identityProjected, relationshipProjected, valueProjected, touchedFanIds };
    }

    for (const row of rows) {
      const identity = row.identity || null;
      const relationship = row.relationship || null;
      const value = row.value || null;
      const common = {
        agencyId: scopedAgencyId, creatorId: scopedCreatorId, onlyFansUserId: row.onlyFansUserId,
        sourceDeviceId: envelope.sourceDeviceId, sourceJobId: envelope.sourceJobId, sourceDeliveryId: envelope.sourceDeliveryId,
      };
      if (identity) {
        await projectFanIdentity(tx, { ...identity, ...common });
      } else if (relationship || value) {
        const evidence = relationship || value;
        await ensureFanRecord(tx, { ...evidence, ...common });
      }
      if (relationship) await projectFanRelationship(tx, { ...relationship, ...common });
      if (value) await projectFanValue(tx, { ...value, ...common });
    }
    if (valueFanIds.length && tx.creatorFanRefreshDemand?.findMany) {
      const { reconcileCampaignFanRefreshDemandsFromCanonicalObservations } = require("./campaign-fan-refresh-queue-service");
      await reconcileCampaignFanRefreshDemandsFromCanonicalObservations({
        db: tx, creatorId: scopedCreatorId, fanIds: valueFanIds, now: envelope.receivedAt, _campaignLockHeld: campaignAuthorityHeld,
      });
    }
    return { ok: true, projected: rows.length, identityProjected, relationshipProjected, valueProjected, touchedFanIds };
  };
  if (typeof db.$transaction === "function") return db.$transaction((tx) => apply(tx));
  return apply(db);
}

async function projectFanObservationBatch(db, options = {}) {
  return commitFanFacts(db, options);
}


async function applyFanDataPointRefreshChunk({ db, job, deviceId, chunkResult }) {
  if (!job?.creatorId || !job?.agencyId) throw new Error("fan_data_point_refresh job is missing creator scope");
  if (text(chunkResult?.kind, 80) !== "fan_data_point_refresh") throw new Error("Unsupported fan data point refresh chunk");
  const requestedFanIds = [...new Set((Array.isArray(job?.params?.fanIds) ? job.params.fanIds : []).map(onlyFansUserId).filter(Boolean))];
  if (!requestedFanIds.length) {
    throw new FanDataObservationBoundaryError(
      "FAN_DATA_POINT_REFRESH_SCOPE_REQUIRED",
      "Fan data point refresh job is missing its server-requested fan scope",
      409,
    );
  }
  const requestedFanSet = new Set(requestedFanIds);
  const items = Array.isArray(chunkResult?.items) ? chunkResult.items : [];
  if (items.length > FAN_DATA_POINT_REFRESH_CHUNK_MAX) {
    throw new FanDataObservationBoundaryError(
      "FAN_DATA_POINT_REFRESH_CHUNK_TOO_LARGE",
      `Fan data point refresh chunk exceeds ${FAN_DATA_POINT_REFRESH_CHUNK_MAX} observations`,
      413,
    );
  }
  const returnedFanIds = items.map((item) => onlyFansUserId(item?.onlyFansUserId));
  if (returnedFanIds.some((fanId) => !fanId)) {
    throw new FanDataObservationBoundaryError(
      "FAN_DATA_POINT_REFRESH_FAN_ID_REQUIRED",
      "Fan data point refresh result contains an invalid fan id",
      400,
    );
  }
  if (new Set(returnedFanIds).size !== returnedFanIds.length) {
    throw new FanDataObservationBoundaryError(
      "FAN_DATA_POINT_REFRESH_DUPLICATE_FAN",
      "Fan data point refresh result contains duplicate fan observations in one causal chunk",
      409,
    );
  }
  const outOfScopeFanIds = [...new Set(returnedFanIds.filter((fanId) => !requestedFanSet.has(fanId)))];
  if (outOfScopeFanIds.length) {
    throw new FanDataObservationBoundaryError(
      "FAN_DATA_POINT_REFRESH_FAN_SCOPE_MISMATCH",
      "Fan data point refresh result contains a fan outside the server-requested scope",
      403,
    );
  }
  // INT5.4C-1A: chronology is acquired after the provider reads complete, not
  // from job creation order. The one-time token is lease/device/scope bound and
  // carries a globally monotonic PostgreSQL-owned observedAt. This prevents an
  // older job that physically reads later from losing merely because it was
  // scheduled earlier.
  const receivedAt = await dbAuthorityNow({ db, fallbackNow: new Date() });
  let causalObservedAt = null;
  const observationTokenRequired = Number(job?.params?.observationTokenVersion || 0) >= 1;
  if (items.length && observationTokenRequired) {
    try {
      const consumedToken = await consumeFanObservationToken({
        db,
        job,
        deviceId,
        leaseRevision: job.leaseRevision,
        token: chunkResult?.observationToken,
        purpose: "fan_data_point_refresh",
        subjects: returnedFanIds,
      });
      causalObservedAt = date(consumedToken.observedAt);
    } catch (error) {
      throw new FanDataObservationBoundaryError(
        "FAN_DATA_POINT_REFRESH_OBSERVATION_TOKEN_INVALID",
        error?.message || "Fan data point refresh observation token is invalid",
        409,
      );
    }
  } else if (items.length) {
    // Rollout compatibility for jobs created before INT5.4C-1A deployment. New
    // schedules always carry observationTokenVersion=1 and cannot use this path.
    causalObservedAt = date(job.createdAt);
  } else {
    causalObservedAt = receivedAt;
  }
  if (!causalObservedAt) throw new FanDataObservationBoundaryError(
    "FAN_DATA_POINT_REFRESH_OBSERVATION_TIME_REQUIRED",
    "Fan data point refresh is missing server-owned observation chronology",
    409,
  );
  const result = await projectFanObservationBatch(db, {
    agencyId: job.agencyId,
    creatorId: job.creatorId,
    sourceDeviceId: deviceId,
    sourceJobId: job.id,
    sourceDeliveryId: text(job?.params?.sourceDeliveryId, 180),
    items,
    allowedSources: ["USER_PROFILE"],
    observedAtPolicy: "SERVER_GENERATION",
    receivedAt,
    causalObservedAt,
  });
  const successfulValueIds = items
    .filter((item) => item?.value && typeof item.value === "object" && normalizeAvailability(item.value.availability) === VALUE_AVAILABILITY.AVAILABLE)
    .map((item) => onlyFansUserId(item.onlyFansUserId))
    .filter(Boolean);
  if (successfulValueIds.length && db.trafficSourceMember?.updateMany) {
    await db.trafficSourceMember.updateMany({
      where: { agencyId: job.agencyId, creatorId: job.creatorId, fanId: { in: successfulValueIds } },
      data: { needsValueRefresh: false, lastValueFetchedAt: receivedAt },
    });
  }
  return { type: "fan_data_point_refresh", ...result };
}

async function scheduleFanDataPointRefresh({ agencyId, creatorId, onlyFansUserIds = [], reason = "fan_data_point_refresh", priority = 95, now = new Date(), params = {} } = {}) {
  if (!text(agencyId, 180) || !text(creatorId, 180)) return { created: false, reason: "missing_scope" };
  const ids = [...new Set((onlyFansUserIds || []).map(onlyFansUserId).filter(Boolean))].sort();
  if (ids.length > FAN_DATA_POINT_REFRESH_MAX_FANS) {
    throw new FanDataObservationBoundaryError(
      "FAN_DATA_POINT_REFRESH_TOO_LARGE",
      `Fan data point refresh exceeds ${FAN_DATA_POINT_REFRESH_MAX_FANS} fans`,
      413,
    );
  }
  if (!ids.length) return { created: false, reason: "no_fan_ids" };
  const { ensureSingleJob } = require("./job-scheduler");
  // Generic creator-wide coalescing would drop a second refresh batch while a
  // different batch is in flight. Range by the exact opaque OF-id set instead:
  // same batch dedupes, different batches remain independently claimable.
  const fanSetHash = crypto.createHash("sha256").update(ids.join("\n")).digest("hex").slice(0, 24);
  const causalBarrierKey = text(params?.causalBarrierKey, 240);
  const causalBarrierHash = causalBarrierKey
    ? crypto.createHash("sha256").update(causalBarrierKey).digest("hex").slice(0, 16)
    : null;
  const rangeKey = causalBarrierHash ? `fan-data:${fanSetHash}:${causalBarrierHash}` : `fan-data:${fanSetHash}`;
  const stableParams = { ...params };
  delete stableParams.scheduledFromObservationAt;
  delete stableParams.reason;
  return ensureSingleJob({
    jobKey: FAN_DATA_POINT_REFRESH_JOB_KEY,
    creatorId,
    agencyId,
    params: { ...stableParams, fanIds: ids, rangeKey, requestReason: text(reason, 120) || "fan_data_point_refresh", observationTokenVersion: 1, observationReadLeaseVersion: 1 },
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
      fieldAuthority: relationshipFieldAuthority(fan.relationshipCurrent),
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
  FAN_DATA_OBSERVATION_BATCH_MAX,
  FAN_DATA_POINT_REFRESH_MAX_FANS,
  FanDataObservationBoundaryError,
  FAN_DATA_POINT_REFRESH_JOB_KEY,
  onlyFansUserId,
  projectFanIdentity,
  projectFanIdentityBatch,
  projectFanRelationship,
  projectSubscriberDirectoryRun,
  projectSubscriberDirectoryItems,
  commitFanFacts,
  projectFanObservationBatch,
  applyFanDataPointRefreshChunk,
  scheduleFanDataPointRefresh,
  readFanCurrent,
  parseAuthorityVersion,
  relationshipFieldAuthority,
  _test: Object.freeze({ projectFanValue }),
};

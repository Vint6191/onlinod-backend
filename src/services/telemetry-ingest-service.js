"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { applyLedgerSideEffects } = require("./team-ppv-ledger-service");

const TEAM_V13_VERSION = "team_v13_provenance";
const TEAM_V13_SOURCE = "electron_team_v13";
const TEAM_V13_EVENT_KINDS = new Set([
  "FAN_MESSAGE_RECEIVED",
  "MESSAGE_SEND_ATTEMPTED",
  "MESSAGE_SEND_CONFIRMED",
  "BROADCAST_DISPATCH_CONFIRMED",
  "DIALOG_SELECTED",
  "DIALOG_SEEN",
  "DIALOG_SESSION",
  "COVERAGE_STARTED",
  "COVERAGE_ENDED",
  "USER_ACTIVITY",
]);
const TEAM_V13_ACTION_SOURCES = new Set([
  "MANUAL",
  "BROADCAST",
  "AUTOMATION",
  "CAMPAIGN_QUEUE",
  "SYSTEM",
  "UNKNOWN",
]);
const TEAM_V13_LIFECYCLES = new Set(["OBSERVED", "ATTEMPTED", "CONFIRMED", "FAILED"]);
const HUMAN_ACTIVITY_KINDS = new Set([
  "DIALOG_SELECTED",
  "DIALOG_SEEN",
  "DIALOG_SESSION",
  "COVERAGE_STARTED",
  "COVERAGE_ENDED",
  "USER_ACTIVITY",
]);

function hashEvent(seed) {
  return crypto.createHash("sha256").update(JSON.stringify(seed)).digest("hex").slice(0, 40);
}

function safeDate(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return new Date(n < 1e12 ? n * 1000 : n);
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : new Date();
}

function optionalDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return new Date(n < 1e12 ? n * 1000 : n);
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function cleanString(value, max = 512) {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, max) : null;
}

function nonNegativeInt(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(2147483647, Math.round(n));
}

function stripInternalValue(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stripInternalValue);
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (String(key).startsWith("__")) continue;
    out[key] = stripInternalValue(val);
  }
  return out;
}

function stripInternalEventFields(event) {
  const clean = stripInternalValue(event || {});
  return clean && typeof clean === "object" ? clean : {};
}

function compactObject(value) {
  const out = {};
  for (const [key, val] of Object.entries(value || {})) {
    if (val === undefined || val === null) continue;
    if (Array.isArray(val) && !val.length) continue;
    if (val && typeof val === "object" && !Array.isArray(val) && !Object.keys(val).length) continue;
    out[key] = val;
  }
  return Object.keys(out).length ? out : null;
}

async function resolveCreator({ agencyId, event, strict = false }) {
  const candidates = [];
  const accountId = cleanString(event.accountId, 160);
  const explicitCreatorId = cleanString(event.creatorId, 160);
  const creatorRef = cleanString(event.creatorRef, 160);
  const remoteId = cleanString(event.remoteId || event.ofUserId || event.extra?.remoteId || event.extra?.creatorUserId, 160);
  const username = cleanString(event.username || event.extra?.username, 160);

  // Current ONLINOD sends backend creator id in creatorId/accountId. Legacy
  // Electron versions sometimes used local account ids, remote ids or usernames.
  if (explicitCreatorId) candidates.push({ id: explicitCreatorId });
  if (accountId && accountId !== explicitCreatorId) candidates.push({ id: accountId });
  if (remoteId) candidates.push({ remoteId });
  if (creatorRef) candidates.push({ username: creatorRef.replace(/^@/, "") });
  if (username) candidates.push({ username: username.replace(/^@/, "") });

  for (const where of candidates) {
    try {
      const creator = await prisma.creatorAccount.findFirst({
        where: { agencyId, deletedAt: null, ...where },
        select: { id: true, username: true, remoteId: true },
      });
      if (creator) return creator;
    } catch (err) {
      if (strict) throw err;
    }
  }
  return null;
}

async function resolveMember({ agencyId, event, fallbackUserId }) {
  const viewerId = cleanString(
    event.viewerId || event.memberId || event.userId ||
    event.extra?.viewerId || event.extra?.memberId || event.extra?.userId,
    160
  );
  if (viewerId) {
    const direct = await prisma.agencyMember.findFirst({
      where: { agencyId, id: viewerId, deletedAt: null },
      select: { id: true, userId: true },
    });
    if (direct) return direct;

    const byUser = await prisma.agencyMember.findFirst({
      where: { agencyId, userId: viewerId, deletedAt: null },
      select: { id: true, userId: true },
    });
    if (byUser) return byUser;
  }

  if (fallbackUserId) {
    const fallback = await prisma.agencyMember.findFirst({
      where: { agencyId, userId: fallbackUserId, deletedAt: null },
      select: { id: true, userId: true },
    });
    if (fallback) return fallback;
  }
  return null;
}

async function resolveAuthenticatedMember({ agencyId, memberId, userId }) {
  const safeMemberId = cleanString(memberId, 160);
  const safeUserId = cleanString(userId, 160);
  if (safeMemberId) {
    const member = await prisma.agencyMember.findFirst({
      where: { agencyId, id: safeMemberId, deletedAt: null },
      select: { id: true, userId: true },
    });
    if (member && (!safeUserId || member.userId === safeUserId)) return member;
  }
  if (!safeUserId) return null;
  return prisma.agencyMember.findFirst({
    where: { agencyId, userId: safeUserId, deletedAt: null },
    select: { id: true, userId: true },
  });
}

async function resolveExistingDeviceId({ agencyId, deviceId }) {
  const id = cleanString(deviceId, 160);
  if (!id) return null;
  try {
    const device = await prisma.workerDevice.findFirst({
      where: { agencyId, id },
      select: { id: true },
    });
    return device?.id || null;
  } catch (_) {
    return null;
  }
}

function isCanonicalV13(event) {
  return cleanString(event.telemetryVersion, 80) === TEAM_V13_VERSION
    || cleanString(event.source, 80) === TEAM_V13_SOURCE
    || Boolean(cleanString(event.eventKind, 80));
}

function canonicalNeedsHumanActor(eventKind, actionSource) {
  if (HUMAN_ACTIVITY_KINDS.has(eventKind)) return true;
  if (eventKind === "BROADCAST_DISPATCH_CONFIRMED") return actionSource === "BROADCAST";
  if (eventKind === "MESSAGE_SEND_ATTEMPTED" || eventKind === "MESSAGE_SEND_CONFIRMED") {
    return actionSource === "MANUAL";
  }
  return false;
}

function canonicalMustNotHaveHumanActor(eventKind, actionSource) {
  if (eventKind === "FAN_MESSAGE_RECEIVED") return true;
  if ((eventKind === "MESSAGE_SEND_ATTEMPTED" || eventKind === "MESSAGE_SEND_CONFIRMED")
      && ["AUTOMATION", "CAMPAIGN_QUEUE", "SYSTEM"].includes(actionSource)) return true;
  return false;
}

function normalizeCanonicalCore({ agencyId, deviceId, event, creator, authenticatedMember }) {
  const eventKind = cleanString(event.eventKind, 80)?.toUpperCase() || "";
  const actionSource = cleanString(event.actionSource, 40)?.toUpperCase() || "";
  const lifecycle = cleanString(event.lifecycle, 40)?.toUpperCase() || "";
  if (!TEAM_V13_EVENT_KINDS.has(eventKind)
      || !TEAM_V13_ACTION_SOURCES.has(actionSource)
      || !TEAM_V13_LIFECYCLES.has(lifecycle)) return { row: null, reason: "invalid_contract" };

  const requiresHuman = canonicalNeedsHumanActor(eventKind, actionSource);
  const forbidsHuman = canonicalMustNotHaveHumanActor(eventKind, actionSource);
  const suppliedActorMemberId = cleanString(event.actorMemberId, 160);
  const suppliedActorUserId = cleanString(event.actorUserId, 160);

  if (requiresHuman) {
    if (!authenticatedMember) return { row: null, reason: "human_actor_missing" };
    if (suppliedActorMemberId && suppliedActorMemberId !== authenticatedMember.id) {
      return { row: null, reason: "human_actor_mismatch" };
    }
    if (suppliedActorUserId && suppliedActorUserId !== authenticatedMember.userId) {
      return { row: null, reason: "human_actor_mismatch" };
    }
  }
  if (forbidsHuman && (suppliedActorMemberId || suppliedActorUserId)) {
    return { row: null, reason: "nonhuman_actor_forbidden" };
  }

  // Automation/system observations happen inside a logged-in workstation, but
  // the logged-in human is not the performance actor. Never let auth context
  // silently turn an automated PPV/message into chatter revenue ownership.
  const humanActor = requiresHuman && !forbidsHuman ? authenticatedMember : null;
  const ts = safeDate(event.occurredAt || event.ts || event.createdAt || Date.now());
  const localId = cleanString(event.localId, 160) || hashEvent({
    agencyId,
    deviceId,
    eventKind,
    actionSource,
    creatorId: creator?.id || event.creatorId || event.accountId || null,
    messageId: event.messageId || null,
    correlationId: event.correlationId || null,
    ts: ts.getTime(),
  });

  const metadata = event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)
    ? stripInternalValue(event.metadata)
    : null;
  const mediaIds = Array.isArray(event.mediaIds)
    ? Array.from(new Set(event.mediaIds.map((v) => cleanString(v, 160)).filter(Boolean))).slice(0, 100)
    : [];
  const extra = compactObject({
    telemetryVersion: TEAM_V13_VERSION,
    sourceDetail: cleanString(event.sourceDetail, 120),
    mediaIds,
    metadata,
  });

  return {
    row: {
      agencyId,
      deviceId,
      userId: humanActor?.userId || null,
      memberId: humanActor?.id || null,
      accountId: cleanString(event.accountId || event.creatorId, 160),
      creatorId: creator?.id || null,
      creatorRef: cleanString(event.creatorRef || creator?.username, 160),
      fanId: cleanString(event.fanId, 160),
      type: eventKind.toLowerCase(),
      eventKind,
      actionSource,
      lifecycle,
      dialogId: cleanString(event.dialogId || event.fanId, 160),
      messageId: cleanString(event.messageId, 220),
      correlationId: cleanString(event.correlationId, 220),
      coverageId: cleanString(event.coverageId, 220),
      startedAt: optionalDate(event.startedAt),
      endedAt: optionalDate(event.endedAt),
      durationSeconds: nonNegativeInt(event.durationSeconds),
      automationDeliveryId: cleanString(event.automationDeliveryId, 220),
      broadcastDispatchId: cleanString(event.broadcastDispatchId, 220),
      priceCents: nonNegativeInt(event.priceCents),
      currency: cleanString(event.currency, 16),
      isPpv: event.isPpv === true,
      mediaCount: Math.max(0, nonNegativeInt(event.mediaCount) || mediaIds.length),
      ts,
      localId,
      extra,
      source: TEAM_V13_SOURCE,
    },
    reason: null,
  };
}

async function normalizeLegacyEvent({ agencyId, safeDeviceId, deviceId, userId, event }) {
  const type = cleanString(event.type, 80);
  if (!type) return null;
  const ts = safeDate(event.ts || event.createdAt || Date.now());
  const creator = await resolveCreator({ agencyId, event });
  const member = await resolveMember({ agencyId, event, fallbackUserId: userId });
  const localId = cleanString(event.localId, 160) || hashEvent({
    deviceId: safeDeviceId || deviceId || null,
    ts: ts.getTime(),
    type,
    userId: member?.userId || userId || null,
    memberId: member?.id || null,
    accountId: event.accountId || null,
    fanId: event.fanId || null,
    extra: event.extra || null,
  });
  return {
    agencyId,
    deviceId: safeDeviceId,
    userId: member?.userId || userId || null,
    memberId: member?.id || null,
    accountId: cleanString(event.accountId || event.extra?.accountId, 160),
    creatorId: creator?.id || null,
    creatorRef: cleanString(event.creatorRef || creator?.username, 160),
    fanId: cleanString(event.fanId || event.extra?.fanId, 160),
    type,
    ts,
    localId,
    extra: event.extra && typeof event.extra === "object" ? event.extra : null,
    source: cleanString(event.source, 80) || "electron",
  };
}

async function ingestTeamEvents({ agencyId, deviceId, userId, memberId = null, events = [] }) {
  const input = Array.isArray(events) ? events : [];
  const normalized = [];
  let skipped = 0;
  const rejectedByReason = {};
  const safeDeviceId = await resolveExistingDeviceId({ agencyId, deviceId });
  const authenticatedMember = await resolveAuthenticatedMember({ agencyId, memberId, userId });

  for (const rawEvent of input) {
    const event = stripInternalEventFields(rawEvent);
    if (!event || typeof event !== "object") {
      skipped += 1;
      continue;
    }

    if (isCanonicalV13(event)) {
      const creator = await resolveCreator({ agencyId, event, strict: true });
      if (!creator) {
        skipped += 1;
        rejectedByReason.creator_not_found = (rejectedByReason.creator_not_found || 0) + 1;
        continue;
      }
      const result = normalizeCanonicalCore({
        agencyId,
        deviceId: safeDeviceId,
        event,
        creator,
        authenticatedMember,
      });
      if (!result.row) {
        skipped += 1;
        const key = result.reason || "invalid_contract";
        rejectedByReason[key] = (rejectedByReason[key] || 0) + 1;
        continue;
      }
      normalized.push(result.row);
      continue;
    }

    const legacy = await normalizeLegacyEvent({ agencyId, safeDeviceId, deviceId, userId, event });
    if (!legacy) {
      skipped += 1;
      continue;
    }
    normalized.push(legacy);
  }

  let inserted = 0;
  let duplicated = 0;

  for (const row of normalized) {
    try {
      // Prisma unique index contains nullable deviceId, so Postgres can allow
      // duplicates when deviceId is null. Do a manual localId check too.
      if (row.localId) {
        const exists = await prisma.teamActivityEvent.findFirst({
          where: { agencyId: row.agencyId, localId: row.localId },
          select: { id: true },
        });
        if (exists) {
          duplicated += 1;
          // Side effects (sent-message / PPV ledgers) are part of durable
          // ingestion semantics. If they fail, propagate the error so the
          // desktop keeps its outbox row and retries. On retry the raw event is
          // found by localId and the idempotent side effect is attempted again.
          await applyLedgerSideEffects({ ...row, id: exists.id });
          continue;
        }
      }
      const created = await prisma.teamActivityEvent.create({ data: row });
      inserted += 1;
      await applyLedgerSideEffects({ ...row, id: created.id });
    } catch (err) {
      if (err?.code === "P2002") duplicated += 1;
      else throw err;
    }
  }

  return {
    received: input.length,
    accepted: normalized.length,
    inserted,
    duplicated,
    skipped,
    ...(Object.keys(rejectedByReason).length ? { rejectedByReason } : {}),
  };
}

module.exports = {
  TEAM_V13_VERSION,
  TEAM_V13_SOURCE,
  ingestTeamEvents,
};

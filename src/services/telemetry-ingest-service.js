"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { applyLedgerSideEffects } = require("./team-ppv-ledger-service");
const { applyTeamResponseProjection } = require("./team-response-projection-service");
const { applyTeamPendingProjection } = require("./team-pending-projection-service");
const { projectCustomDeliveryFromTeamEvent } = require("./custom-content-delivery-tracking-service");
const { canAccessCreator } = require("../middleware/automation-permissions");
const { serializableTxOptions } = require("../utils/prisma-transaction");
const { runDbTransaction } = require("./db-transaction-service");

const TEAM_V13_VERSION = "team_v13_provenance";
const TEAM_V13_SOURCE = "electron_team_v13";
const TEAM_V13_EVENT_KINDS = new Set([
  "FAN_MESSAGE_RECEIVED",
  "MESSAGE_SEND_ATTEMPTED",
  "MESSAGE_SEND_CONFIRMED",
  "BROADCAST_DISPATCH_CONFIRMED",
  "CONTENT_POST_PUBLISHED_CONFIRMED",
  "CONTENT_STORY_PUBLISHED_CONFIRMED",
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

async function resolveCreator({ agencyId, event, strict = false, db = prisma }) {
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
      const creator = await db.creatorAccount.findFirst({
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

function isCanonicalV13(event) {
  return cleanString(event.telemetryVersion, 80) === TEAM_V13_VERSION
    && cleanString(event.source, 80) === TEAM_V13_SOURCE;
}

function telemetryAdmissionError(code, message, status = 403) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

async function loadLiveTelemetryMember({ db, agencyId, memberId, userId, admittedAccessEpoch }) {
  const live = await db.agencyMember.findFirst({
    where: {
      id: memberId,
      agencyId,
      userId,
      deletedAt: null,
      deactivatedAt: null,
      agency: { deletedAt: null },
    },
    select: {
      id: true, userId: true, agencyId: true, accessEpoch: true, role: true, roleKey: true,
      assignedCreators: true, permissions: true, deletedAt: true, deactivatedAt: true,
    },
  });
  if (!live) throw telemetryAdmissionError("TELEMETRY_MEMBER_STALE", "Agency membership is no longer active");
  if (Number(live.accessEpoch || 1) !== Number(admittedAccessEpoch || 1)) {
    throw telemetryAdmissionError("TELEMETRY_ACCESS_EPOCH_STALE", "Creator access changed while telemetry batch was in flight");
  }
  return live;
}

function canonicalNeedsHumanActor(eventKind, actionSource) {
  if (HUMAN_ACTIVITY_KINDS.has(eventKind)) return true;
  if (eventKind === "BROADCAST_DISPATCH_CONFIRMED") return actionSource === "BROADCAST";
  if (eventKind === "CONTENT_POST_PUBLISHED_CONFIRMED" || eventKind === "CONTENT_STORY_PUBLISHED_CONFIRMED") return actionSource === "MANUAL";
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
      contentId: cleanString(event.contentId || event.metadata?.contentId, 220),
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

async function ingestTeamEvents({ agencyId, deviceId, userId, memberId = null, admittedAccessEpoch = 1, events = [] }) {
  const input = Array.isArray(events) ? events : [];
  let inserted = 0;
  let duplicated = 0;
  let skipped = 0;
  const acknowledgedLocalIds = [];
  const rejectedByReason = {};
  const rejectedEvents = [];

  if (!agencyId || !deviceId || !userId || !memberId) {
    throw telemetryAdmissionError("TELEMETRY_AUTHORITY_REQUIRED", "Telemetry requires authenticated member and device authority", 401);
  }

  const reject = (event, reason) => {
    skipped += 1;
    rejectedByReason[reason] = (rejectedByReason[reason] || 0) + 1;
    rejectedEvents.push({ localId: cleanString(event?.localId, 160), reason });
  };

  for (const rawEvent of input) {
    const event = stripInternalEventFields(rawEvent);
    if (!event || typeof event !== "object") {
      reject(null, "invalid_event");
      continue;
    }
    if (!isCanonicalV13(event)) {
      reject(event, "legacy_telemetry_disabled");
      continue;
    }

    let durable = null;
    try {
      durable = await runDbTransaction(prisma, async (tx) => {
        const liveMember = await loadLiveTelemetryMember({
          db: tx,
          agencyId,
          memberId,
          userId,
          admittedAccessEpoch,
        });
        const creator = await resolveCreator({ agencyId, event, strict: true, db: tx });
        if (!creator) return { rejected: "creator_not_found" };
        if (!canAccessCreator(liveMember, creator.id)) return { rejected: "creator_access_forbidden" };

        const result = normalizeCanonicalCore({
          agencyId,
          deviceId,
          event,
          creator,
          authenticatedMember: liveMember,
        });
        if (!result.row) return { rejected: result.reason || "invalid_contract" };
        const row = result.row;

        if (row.localId) {
          const exists = await tx.teamActivityEvent.findFirst({
            where: { agencyId: row.agencyId, deviceId: row.deviceId, localId: row.localId },
          });
          if (exists) {
            // localId is the durable idempotency identity for this device.  Once committed,
            // every replay projection must come from the stored canonical event, never from
            // a newly supplied payload carrying the same localId.  Otherwise a mutated replay
            // could change money/Custom/response side effects without changing TeamActivityEvent.
            const durableRow = exists;
            await applyLedgerSideEffects(durableRow, tx);
            await applyTeamResponseProjection(durableRow, tx);
            await applyTeamPendingProjection(durableRow, tx);
            await projectCustomDeliveryFromTeamEvent(durableRow, { db: tx });
            return { row: durableRow, duplicated: true };
          }
        }
        try {
          const created = await tx.teamActivityEvent.create({ data: row });
          const durableRow = { ...row, id: created.id };
          await applyLedgerSideEffects(durableRow, tx);
          await applyTeamResponseProjection(durableRow, tx);
          await applyTeamPendingProjection(durableRow, tx);
          await projectCustomDeliveryFromTeamEvent(durableRow, { db: tx });
          return { row: durableRow, inserted: true };
        } catch (err) {
          if (err?.code !== "P2002" || !row.localId) throw err;
          const exists = await tx.teamActivityEvent.findFirst({
            where: { agencyId: row.agencyId, deviceId: row.deviceId, localId: row.localId },
          });
          if (!exists) throw err;
          const durableRow = exists;
          await applyLedgerSideEffects(durableRow, tx);
          await applyTeamResponseProjection(durableRow, tx);
          await applyTeamPendingProjection(durableRow, tx);
          await projectCustomDeliveryFromTeamEvent(durableRow, { db: tx });
          return { row: durableRow, duplicated: true };
        }
      }, serializableTxOptions());
    } catch (err) {
      if (["TELEMETRY_MEMBER_STALE", "TELEMETRY_ACCESS_EPOCH_STALE"].includes(err?.code)) throw err;
      throw err;
    }

    if (durable?.rejected) {
      reject(event, durable.rejected);
      continue;
    }
    if (!durable?.row) {
      reject(event, "durable_event_missing");
      continue;
    }

    if (durable.inserted) inserted += 1;
    if (durable.duplicated) duplicated += 1;
    if (durable.row.localId) acknowledgedLocalIds.push(durable.row.localId);
  }

  return {
    received: input.length,
    accepted: inserted + duplicated,
    inserted,
    duplicated,
    skipped,
    acknowledgedLocalIds,
    rejectedEvents,
    ...(Object.keys(rejectedByReason).length ? { rejectedByReason } : {}),
  };
}

module.exports = {
  TEAM_V13_VERSION,
  TEAM_V13_SOURCE,
  ingestTeamEvents,
};

"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { applyLedgerSideEffects } = require("./team-ppv-ledger-service");
const { applyTeamResponseProjection } = require("./team-response-projection-service");
const { applyTeamPendingProjection } = require("./team-pending-projection-service");
const { publishTeamProjectionWorkForEvent } = require("./team-dialog-projection-authority-service");
const { projectCustomDeliveryFromTeamEvent } = require("./custom-content-delivery-tracking-service");
const { projectNativeMassWriteFromTeamEvent } = require("./programmatic-of-write-authority-service");
const { canAccessCreator } = require("../middleware/automation-permissions");
const { serializableTxOptions } = require("../utils/prisma-transaction");
const { runDbTransaction } = require("./db-transaction-service");
const { dbAuthorityNow } = require("./db-time-authority-service");

const TEAM_V13_VERSION = "team_v13_provenance";
const TEAM_V13_SOURCE = "electron_team_v13";
const TEAM_V13_EVENT_KINDS = new Set([
  "FAN_MESSAGE_RECEIVED",
  "MESSAGE_SEND_ATTEMPTED",
  "MESSAGE_SEND_CONFIRMED",
  "BROADCAST_DISPATCH_CONFIRMED",
  "BROADCAST_QUEUE_CANCELED_CONFIRMED",
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
const PROVIDER_EVENT_TIME_SOURCE_DETAILS = new Set([
  "creator_runtime_ws",
  "crm_incremental_recovery",
  "crm_pending_bootstrap_v2",
  "creator_runtime_cdp",
]);
const PROVIDER_EVENT_TIME_KINDS = new Set([
  "FAN_MESSAGE_RECEIVED",
  "MESSAGE_SEND_CONFIRMED",
  "BROADCAST_DISPATCH_CONFIRMED",
  "BROADCAST_QUEUE_CANCELED_CONFIRMED",
  "CONTENT_POST_PUBLISHED_CONFIRMED",
  "CONTENT_STORY_PUBLISHED_CONFIRMED",
]);
const PROVIDER_EVENT_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const PROVIDER_EVENT_MAX_HISTORY_MS = 366 * 24 * 60 * 60 * 1000;

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

async function resolveCreator({ agencyId, event, strict = false, allowRetired = false, db = prisma }) {
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
        where: { agencyId, ...(allowRetired ? {} : { deletedAt: null }), ...where },
        select: { id: true, username: true, remoteId: true, deletedAt: true, status: true },
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

function authorizationGenerationProof(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const authorizationScopeIncarnation = cleanString(value.authorizationScopeIncarnation, 220);
  const accessEpoch = Number(value.accessEpoch);
  const creatorCatalogGeneration = Number(value.creatorCatalogGeneration);
  if (!authorizationScopeIncarnation || !Number.isInteger(accessEpoch) || accessEpoch < 0
      || !Number.isInteger(creatorCatalogGeneration) || creatorCatalogGeneration < 0) return null;
  return { authorizationScopeIncarnation, accessEpoch, creatorCatalogGeneration };
}

function sameAuthorizationGenerationProof(left, right) {
  return Boolean(left && right
    && left.authorizationScopeIncarnation === right.authorizationScopeIncarnation
    && left.accessEpoch === right.accessEpoch
    && left.creatorCatalogGeneration === right.creatorCatalogGeneration);
}

function humanAuthorizationCapture(event) {
  const metadata = event?.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata) ? event.metadata : null;
  const marker = metadata?.authorizationCapture;
  if (!marker || typeof marker !== "object" || Array.isArray(marker) || Number(marker.version) !== 1) return null;
  const semantics = cleanString(marker.semantics, 40)?.toUpperCase() || "";
  const generation = authorizationGenerationProof(marker);
  const localAuthorizationRevision = marker.localAuthorizationRevision == null ? null : Number(marker.localAuthorizationRevision);
  if (!generation || !["CURRENT_HUMAN", "TERMINAL_CLOSURE"].includes(semantics)) return null;
  if (localAuthorizationRevision !== null && (!Number.isInteger(localAuthorizationRevision) || localAuthorizationRevision < 0)) return null;
  return { ...generation, semantics, localAuthorizationRevision };
}

async function accessGenerationEndedAt({ db, memberId, agencyId, userId, accessEpoch }) {
  if (!db || typeof db.$queryRawUnsafe !== "function") return null;
  const rows = await db.$queryRawUnsafe(
    `SELECT "endedAt"
       FROM "AgencyMemberAccessEpochBoundary"
      WHERE "memberId"=$1
        AND "agencyId"=$2
        AND "userId"=$3
        AND "accessEpoch"=$4
      LIMIT 1`,
    memberId, agencyId, userId, accessEpoch,
  );
  return optionalDate(Array.isArray(rows) ? rows[0]?.endedAt : null);
}

async function authorizationSessionEndedAt({ db, authorizationSessionId, agencyId, userId }) {
  if (!db || typeof db.$queryRawUnsafe !== "function" || !authorizationSessionId) return null;
  const rows = await db.$queryRawUnsafe(
    `SELECT
        (SELECT b."endedAt"
           FROM "AuthorizationSessionBoundary" b
          WHERE b."authorizationSessionId"=$1
            AND b."agencyId"=$2
            AND b."userId"=$3
          LIMIT 1) AS "revokedEndedAt",
        (SELECT r."expiresAt"
           FROM "RefreshSession" r
          WHERE r."authorizationSessionId"=$1
            AND r."agencyId"=$2
            AND r."userId"=$3
          ORDER BY r."expiresAt" DESC
          LIMIT 1) AS "naturalExpiresAt",
        clock_timestamp() AS "dbNow"`,
    authorizationSessionId, agencyId, userId,
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  const revokedEndedAt = optionalDate(row?.revokedEndedAt);
  const naturalExpiresAt = optionalDate(row?.naturalExpiresAt);
  const dbNow = optionalDate(row?.dbNow);

  // Expiry is itself a server-owned end of authority even when no UPDATE fires.
  // A later revoke must never move that end forward. Conversely, if there is no
  // explicit revoke boundary and the latest lineage expiry is still in the
  // future, fail closed: a differing current lineage proves some other boundary
  // should exist and we must not invent it from a future expiry.
  if (revokedEndedAt && naturalExpiresAt) {
    return new Date(Math.min(revokedEndedAt.getTime(), naturalExpiresAt.getTime()));
  }
  if (revokedEndedAt) return revokedEndedAt;
  if (naturalExpiresAt && dbNow && naturalExpiresAt.getTime() <= dbNow.getTime()) return naturalExpiresAt;
  return null;
}

async function creatorCatalogGenerationEndedAt({ db, agencyId, generation }) {
  if (!db || typeof db.$queryRawUnsafe !== "function") return null;
  const rows = await db.$queryRawUnsafe(
    `SELECT "endedAt"
       FROM "AgencyCreatorCatalogGenerationBoundary"
      WHERE "agencyId"=$1
        AND "generation"=$2
      LIMIT 1`,
    agencyId, generation,
  );
  return optionalDate(Array.isArray(rows) ? rows[0]?.endedAt : null);
}


function terminalPerformanceClosure(event) {
  const eventKind = cleanString(event?.eventKind, 80)?.toUpperCase() || "";
  if (eventKind !== "COVERAGE_ENDED" && eventKind !== "DIALOG_SESSION") return null;
  const metadata = event?.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata) ? event.metadata : null;
  const marker = metadata?.authorizationTerminalClosure;
  if (!marker || typeof marker !== "object" || Array.isArray(marker) || Number(marker.version) !== 1) return null;
  const startedUnder = authorizationGenerationProof(marker.startedUnder);
  const coverageId = cleanString(event.coverageId || metadata?.coverageId, 220);
  const boundaryOffsetSeconds = Number(marker.boundaryOffsetSeconds);
  if (!startedUnder || !coverageId || !Number.isFinite(boundaryOffsetSeconds) || boundaryOffsetSeconds < 0) return null;
  return {
    eventKind,
    coverageId,
    startedUnder,
    boundaryOffsetSeconds: Math.min(24 * 60 * 60, Math.round(boundaryOffsetSeconds)),
  };
}

async function hasDurableTerminalClosureProof({
  db, agencyId, deviceId, member, creator, event, admittedAuthorizationSessionId, currentCreatorCatalogGeneration,
}) {
  const closure = terminalPerformanceClosure(event);
  if (!closure || !member?.id || !member?.userId) return false;
  const start = await db.teamActivityEvent.findFirst({
    where: {
      agencyId,
      deviceId,
      memberId: member.id,
      userId: member.userId,
      creatorId: creator?.id,
      coverageId: closure.coverageId,
      eventKind: "COVERAGE_STARTED",
      actionSource: "MANUAL",
      lifecycle: "OBSERVED",
    },
    orderBy: [{ ts: "asc" }, { id: "asc" }],
    select: { extra: true, startedAt: true, ts: true },
  });
  const startMetadata = start?.extra?.metadata && typeof start.extra.metadata === "object" && !Array.isArray(start.extra.metadata)
    ? start.extra.metadata
    : null;
  const startedUnder = authorizationGenerationProof(startMetadata?.authorizationGeneration);
  const coverageStartedAt = optionalDate(start?.startedAt) || optionalDate(start?.ts);
  if (!sameAuthorizationGenerationProof(startedUnder, closure.startedUnder) || !coverageStartedAt) return null;

  // Every component of the captured human authorization generation has its
  // own server-owned end boundary. A terminal closure that crosses a changed
  // component must prove that boundary; otherwise an old Desktop fact could be
  // resurrected under a newer login/member/catalog generation.
  let authorizationSessionEnded = null;
  if (closure.startedUnder.authorizationScopeIncarnation !== admittedAuthorizationSessionId) {
    authorizationSessionEnded = await authorizationSessionEndedAt({
      db,
      authorizationSessionId: closure.startedUnder.authorizationScopeIncarnation,
      agencyId,
      userId: member.userId,
    });
    if (!authorizationSessionEnded) return null;
  }

  let memberGenerationEndedAt = null;
  if (Number(closure.startedUnder.accessEpoch) !== Number(member.accessEpoch)) {
    memberGenerationEndedAt = await accessGenerationEndedAt({
      db, memberId: member.id, agencyId, userId: member.userId, accessEpoch: closure.startedUnder.accessEpoch,
    });
    if (!memberGenerationEndedAt) return null;
  }

  let creatorCatalogGenerationEnded = null;
  if (Number(closure.startedUnder.creatorCatalogGeneration) !== Number(currentCreatorCatalogGeneration)) {
    creatorCatalogGenerationEnded = await creatorCatalogGenerationEndedAt({
      db, agencyId, generation: closure.startedUnder.creatorCatalogGeneration,
    });
    if (!creatorCatalogGenerationEnded) return null;
  }

  const creatorRetiredAt = optionalDate(creator?.deletedAt);
  // Creator retirement canonically advances AgencyCreatorCatalogState in the
  // same retirement transaction. When that DB-clock generation boundary exists
  // it supersedes the application-created CreatorAccount.deletedAt timestamp,
  // which may have been computed before waiting on transaction/authority locks.
  // Keep deletedAt only as a conservative fallback for inconsistent/legacy data
  // where no catalog boundary is available.
  const effectiveCreatorRetiredAt = creatorCatalogGenerationEnded || creatorRetiredAt;
  const endCandidates = [authorizationSessionEnded, memberGenerationEndedAt, effectiveCreatorRetiredAt].filter(Boolean);
  const authorizationEndedAt = endCandidates.length
    ? new Date(Math.min(...endCandidates.map((value) => value.getTime())))
    : null;
  return {
    closure,
    coverageStartedAt,
    authorizationEndedAt,
    authorizationSessionEndedAt: authorizationSessionEnded,
    memberGenerationEndedAt,
    creatorCatalogGenerationEndedAt: creatorCatalogGenerationEnded,
    creatorRetiredAt,
  };
}

function telemetryAdmissionError(code, message, status = 403) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

async function loadLiveTelemetryMember({ db, agencyId, memberId, userId, admittedAccessEpoch }) {
  let live = null;
  if (typeof db?.$queryRawUnsafe === "function") {
    const rows = await db.$queryRawUnsafe(
      `SELECT m."id", m."userId", m."agencyId", m."accessEpoch", m."role", m."roleKey",
              m."assignedCreators", m."permissions", m."deletedAt", m."deactivatedAt"
         FROM "AgencyMember" m
         JOIN "Agency" a ON a."id"=m."agencyId"
        WHERE m."id"=$1
          AND m."agencyId"=$2
          AND m."userId"=$3
          AND m."deletedAt" IS NULL
          AND m."deactivatedAt" IS NULL
          AND a."deletedAt" IS NULL
        LIMIT 1
        FOR SHARE OF m`,
      memberId, agencyId, userId,
    );
    live = Array.isArray(rows) ? rows.find((row) => row && row.id && row.accessEpoch !== undefined) || null : null;
  }
  if (!live && db?.agencyMember?.findFirst) {
    // Reduced test doubles often expose $queryRawUnsafe only for DB clock
    // authority. Production PostgreSQL returns the member row from the locked
    // SELECT above; this fallback preserves unit-test compatibility without
    // weakening the production commit fence.
    live = await db.agencyMember.findFirst({
      where: {
        id: memberId, agencyId, userId, deletedAt: null, deactivatedAt: null, agency: { deletedAt: null },
      },
      select: {
        id: true, userId: true, agencyId: true, accessEpoch: true, role: true, roleKey: true,
        assignedCreators: true, permissions: true, deletedAt: true, deactivatedAt: true,
      },
    });
  }
  if (!live) throw telemetryAdmissionError("TELEMETRY_MEMBER_STALE", "Agency membership is no longer active");
  if (Number(live.accessEpoch || 1) !== Number(admittedAccessEpoch || 1)) {
    throw telemetryAdmissionError("TELEMETRY_ACCESS_EPOCH_STALE", "Creator access changed while telemetry batch was in flight");
  }
  return live;
}

async function lockLiveAuthorizationSession({ db, agencyId, userId, deviceId, authorizationSessionId }) {
  if (!authorizationSessionId) throw telemetryAdmissionError("TELEMETRY_AUTHORIZATION_SESSION_REQUIRED", "Authorization session lineage is required", 401);
  if (typeof db?.$queryRawUnsafe !== "function") return { authorizationSessionId };
  const rows = await db.$queryRawUnsafe(
    `SELECT "id", "authorizationSessionId"
       FROM "RefreshSession"
      WHERE "userId"=$1
        AND "agencyId"=$2
        AND "deviceId"=$3
        AND "authorizationSessionId"=$4
        AND "revokedAt" IS NULL
        AND "expiresAt" > clock_timestamp()
      LIMIT 1
      FOR SHARE`,
    userId, agencyId, deviceId, authorizationSessionId,
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw telemetryAdmissionError("TELEMETRY_AUTHORIZATION_SESSION_STALE", "Login authorization generation changed while telemetry was in flight");
  return row;
}

async function lockCreatorCatalogGeneration({ db, agencyId }) {
  if (typeof db?.$queryRawUnsafe === "function") {
    const rows = await db.$queryRawUnsafe(
      `SELECT "generation"
         FROM "AgencyCreatorCatalogState"
        WHERE "agencyId"=$1
        LIMIT 1
        FOR SHARE`,
      agencyId,
    );
    const row = Array.isArray(rows) ? rows.find((item) => item && item.generation !== undefined) : null;
    if (row) return Number(row.generation);
  }
  if (db?.agencyCreatorCatalogState?.findUnique) {
    const row = await db.agencyCreatorCatalogState.findUnique({ where: { agencyId }, select: { generation: true } });
    if (row) return Number(row.generation);
  }
  throw telemetryAdmissionError("TELEMETRY_CREATOR_CATALOG_STALE", "Creator catalog generation is unavailable");
}


function canonicalNeedsHumanActor(eventKind, actionSource) {
  if (HUMAN_ACTIVITY_KINDS.has(eventKind)) return true;
  if (eventKind === "BROADCAST_DISPATCH_CONFIRMED" || eventKind === "BROADCAST_QUEUE_CANCELED_CONFIRMED") return actionSource === "BROADCAST";
  if (eventKind === "CONTENT_POST_PUBLISHED_CONFIRMED" || eventKind === "CONTENT_STORY_PUBLISHED_CONFIRMED") return actionSource === "MANUAL";
  if (eventKind === "MESSAGE_SEND_ATTEMPTED" || eventKind === "MESSAGE_SEND_CONFIRMED") {
    return actionSource === "MANUAL";
  }
  return false;
}

function eventRequiresHumanAuthorizationCapture(event) {
  const eventKind = cleanString(event?.eventKind, 80)?.toUpperCase() || "";
  const actionSource = cleanString(event?.actionSource, 40)?.toUpperCase() || "";
  return canonicalNeedsHumanActor(eventKind, actionSource);
}

function canonicalMustNotHaveHumanActor(eventKind, actionSource) {
  if (eventKind === "FAN_MESSAGE_RECEIVED") return true;
  if ((eventKind === "MESSAGE_SEND_ATTEMPTED" || eventKind === "MESSAGE_SEND_CONFIRMED")
      && ["AUTOMATION", "CAMPAIGN_QUEUE", "SYSTEM"].includes(actionSource)) return true;
  return false;
}

function canonicalEventTime({ event, eventKind, authorityNow }) {
  const dbNow = authorityNow instanceof Date && Number.isFinite(authorityNow.getTime()) ? new Date(authorityNow) : null;
  if (!dbNow) throw telemetryAdmissionError("TEAM_EVENT_TIME_AUTHORITY_REQUIRED", "DB event-time authority is required", 500);
  const reported = optionalDate(event.occurredAt ?? event.ts ?? event.createdAt);
  const sourceDetail = cleanString(event.sourceDetail, 120);
  const providerEligible = PROVIDER_EVENT_TIME_KINDS.has(eventKind) && PROVIDER_EVENT_TIME_SOURCE_DETAILS.has(String(sourceDetail || ""));
  if (providerEligible && reported) {
    const delta = reported.getTime() - dbNow.getTime();
    if (delta <= PROVIDER_EVENT_FUTURE_TOLERANCE_MS && delta >= -PROVIDER_EVENT_MAX_HISTORY_MS) {
      return { ts: reported, reported, authority: "PROVIDER_REPORTED_BOUNDED", rejectedReason: null };
    }
    return { ts: dbNow, reported, authority: "DB_RECEIPT", rejectedReason: delta > PROVIDER_EVENT_FUTURE_TOLERANCE_MS ? "REPORTED_FUTURE" : "REPORTED_TOO_OLD" };
  }
  return { ts: dbNow, reported, authority: "DB_RECEIPT", rejectedReason: reported ? "CLIENT_WALL_CLOCK_NOT_AUTHORITY" : null };
}

function activitySemanticEventKey({ eventKind, creatorId, accountId, messageId, broadcastDispatchId, contentId }) {
  const scope = cleanString(creatorId || accountId, 160);
  if (!scope) return null;
  if (eventKind === "MESSAGE_SEND_CONFIRMED") {
    const id = cleanString(messageId, 220);
    return id ? `${scope}:message:${id}` : null;
  }
  if (eventKind === "BROADCAST_DISPATCH_CONFIRMED") {
    const id = cleanString(broadcastDispatchId, 220);
    return id ? `${scope}:broadcast:${id}` : null;
  }
  if (eventKind === "CONTENT_POST_PUBLISHED_CONFIRMED" || eventKind === "CONTENT_STORY_PUBLISHED_CONFIRMED") {
    const id = cleanString(contentId, 220);
    return id ? `${scope}:content:${id}` : null;
  }
  return null;
}

function canonicalHumanSessionTimes({
  eventKind, authorityNow, durationSeconds, rawStartedAt, rawEndedAt, terminalClosureProof = null, rawMetadata = null,
}) {
  if (!HUMAN_ACTIVITY_KINDS.has(eventKind)) return { startedAt: rawStartedAt, endedAt: rawEndedAt };
  const at = new Date(authorityNow);
  if (eventKind === "COVERAGE_STARTED") return { startedAt: at, endedAt: null };

  if (terminalClosureProof && (eventKind === "COVERAGE_ENDED" || eventKind === "DIALOG_SESSION")) {
    const coverageStartedAt = optionalDate(terminalClosureProof.coverageStartedAt);
    const boundaryOffsetSeconds = Math.max(0, Math.min(24 * 60 * 60, Number(terminalClosureProof.closure?.boundaryOffsetSeconds) || 0));
    if (coverageStartedAt) {
      const serverGenerationEnd = optionalDate(terminalClosureProof.authorizationEndedAt);
      const terminalAt = new Date(Math.min(
        at.getTime(),
        coverageStartedAt.getTime() + boundaryOffsetSeconds * 1000,
        serverGenerationEnd ? serverGenerationEnd.getTime() : Number.POSITIVE_INFINITY,
      ));
      if (eventKind === "COVERAGE_ENDED") return { startedAt: coverageStartedAt, endedAt: terminalAt };
      const wallSeconds = Math.max(0, Math.min(24 * 60 * 60, Number(rawMetadata?.wallSeconds ?? durationSeconds) || 0));
      return {
        startedAt: new Date(Math.max(coverageStartedAt.getTime(), terminalAt.getTime() - wallSeconds * 1000)),
        endedAt: terminalAt,
      };
    }
  }

  if (eventKind === "COVERAGE_ENDED" || eventKind === "DIALOG_SESSION") {
    const seconds = Math.max(0, Math.min(24 * 60 * 60, Number(durationSeconds) || 0));
    return { startedAt: new Date(at.getTime() - seconds * 1000), endedAt: at };
  }
  return { startedAt: null, endedAt: null };
}

function normalizeCanonicalCore({ agencyId, deviceId, event, creator, authenticatedMember, authorityNow, terminalClosureProof = null }) {
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
  const eventTime = canonicalEventTime({ event, eventKind, authorityNow });
  // R15/A37 admission-horizon fence: a provider event older than the supported
  // correction horizon is an explicitly rejected historical observation, not a
  // new event at DB receipt time.  The Desktop outbox treats rejectedEvents as
  // terminal/quarantined evidence, so this prevents a replay after raw retention
  // from becoming a second current contribution.
  if (eventTime.rejectedReason === "REPORTED_TOO_OLD") {
    return { row: null, reason: "provider_event_outside_admission_horizon" };
  }
  const ts = eventTime.ts;
  const identityTime = eventTime.reported || ts;
  const localId = cleanString(event.localId, 160) || hashEvent({
    agencyId,
    deviceId,
    eventKind,
    actionSource,
    creatorId: creator?.id || event.creatorId || event.accountId || null,
    messageId: event.messageId || null,
    correlationId: event.correlationId || null,
    ts: identityTime.getTime(),
  });

  const metadata = event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)
    ? stripInternalValue(event.metadata)
    : null;
  const mediaIds = Array.isArray(event.mediaIds)
    ? Array.from(new Set(event.mediaIds.map((v) => cleanString(v, 160)).filter(Boolean))).slice(0, 200)
    : [];
  const extra = compactObject({
    telemetryVersion: TEAM_V13_VERSION,
    sourceDetail: cleanString(event.sourceDetail, 120),
    eventTimeAuthority: eventTime.authority,
    reportedOccurredAt: eventTime.reported ? eventTime.reported.toISOString() : null,
    reportedTimeRejectedReason: eventTime.rejectedReason,
    mediaIds,
    metadata,
  });

  const reportedDurationSeconds = nonNegativeInt(event.durationSeconds);
  const sessionTimes = canonicalHumanSessionTimes({
    eventKind,
    authorityNow: ts,
    durationSeconds: reportedDurationSeconds,
    rawStartedAt: optionalDate(event.startedAt),
    rawEndedAt: optionalDate(event.endedAt),
    terminalClosureProof,
    rawMetadata: event.metadata,
  });
  let durationSeconds = reportedDurationSeconds;
  if (terminalClosureProof && sessionTimes.startedAt && sessionTimes.endedAt && durationSeconds !== null) {
    const canonicalWallSeconds = Math.max(0, Math.round((sessionTimes.endedAt.getTime() - sessionTimes.startedAt.getTime()) / 1000));
    durationSeconds = Math.min(durationSeconds, canonicalWallSeconds);
  }
  const canonicalCreatorId = creator?.id || null;
  const canonicalAccountId = cleanString(event.accountId || event.creatorId, 160);
  const canonicalMessageId = cleanString(event.messageId, 220);
  const canonicalContentId = cleanString(event.contentId || event.metadata?.contentId, 220);
  const canonicalBroadcastDispatchId = cleanString(event.broadcastDispatchId, 220);
  const semanticEventKey = activitySemanticEventKey({
    eventKind,
    creatorId: canonicalCreatorId,
    accountId: canonicalAccountId,
    messageId: canonicalMessageId,
    broadcastDispatchId: canonicalBroadcastDispatchId,
    contentId: canonicalContentId,
  });

  return {
    row: {
      agencyId,
      deviceId,
      userId: humanActor?.userId || null,
      memberId: humanActor?.id || null,
      accountId: canonicalAccountId,
      creatorId: canonicalCreatorId,
      creatorRef: cleanString(event.creatorRef || creator?.username, 160),
      fanId: cleanString(event.fanId, 160),
      type: eventKind.toLowerCase(),
      eventKind,
      actionSource,
      lifecycle,
      dialogId: cleanString(event.dialogId || event.fanId, 160),
      messageId: canonicalMessageId,
      contentId: canonicalContentId,
      correlationId: cleanString(event.correlationId, 220),
      coverageId: cleanString(event.coverageId, 220),
      startedAt: sessionTimes.startedAt,
      endedAt: sessionTimes.endedAt,
      durationSeconds,
      automationDeliveryId: cleanString(event.automationDeliveryId, 220),
      broadcastDispatchId: canonicalBroadcastDispatchId,
      semanticEventKey,
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

async function dispatchTeamProjectionForDurableEvent(durableRow, db) {
  // PostgreSQL production uses the AFTER INSERT producer installed by Phase 2, so the
  // canonical event commit and DomainWork invalidation are atomic. Reduced test doubles
  // do not execute DB triggers: publish through the same authority when DomainWork exists,
  // otherwise retain the old inline reducer only as a schema-compatibility/test fallback.
  if (typeof db?.$queryRawUnsafe === "function") return { triggerOwned: true };
  if (db?.domainWorkItem?.upsert || db?.domainWorkItem?.update) {
    return publishTeamProjectionWorkForEvent({ row: durableRow, db });
  }
  await applyTeamResponseProjection(durableRow, db);
  await applyTeamPendingProjection(durableRow, db);
  return { compatibilityInline: true };
}

async function persistCanonicalTeamEventRow({ db, row }) {
  if (!db || !row) throw new Error("Canonical Team event persistence requires db and row");
  if (row.localId) {
    const exists = await db.teamActivityEvent.findFirst({
      where: { agencyId: row.agencyId, deviceId: row.deviceId, localId: row.localId },
    });
    if (exists) {
      const durableRow = exists;
      await applyLedgerSideEffects(durableRow, db);
      await dispatchTeamProjectionForDurableEvent(durableRow, db);
      await projectCustomDeliveryFromTeamEvent(durableRow, { db });
    await projectNativeMassWriteFromTeamEvent(durableRow, { db });
      return { row: durableRow, duplicated: true, inserted: false };
    }
  }
  try {
    const created = await db.teamActivityEvent.create({ data: row });
    const durableRow = { ...row, id: created.id };
    await applyLedgerSideEffects(durableRow, db);
    await dispatchTeamProjectionForDurableEvent(durableRow, db);
    await projectCustomDeliveryFromTeamEvent(durableRow, { db });
    await projectNativeMassWriteFromTeamEvent(durableRow, { db });
    return { row: durableRow, duplicated: false, inserted: true };
  } catch (err) {
    if (err?.code !== "P2002" || !row.localId) throw err;
    const exists = await db.teamActivityEvent.findFirst({
      where: { agencyId: row.agencyId, deviceId: row.deviceId, localId: row.localId },
    });
    if (!exists) throw err;
    const durableRow = exists;
    await applyLedgerSideEffects(durableRow, db);
    await dispatchTeamProjectionForDurableEvent(durableRow, db);
    await projectCustomDeliveryFromTeamEvent(durableRow, { db });
    await projectNativeMassWriteFromTeamEvent(durableRow, { db });
    return { row: durableRow, duplicated: true, inserted: false };
  }
}

const TEAM_TELEMETRY_TX_CHUNK_SIZE = 16;

async function ingestCanonicalTeamEventInTx({
  tx, agencyId, deviceId, event, liveMember, admittedAuthorizationSessionId, currentCreatorCatalogGeneration,
}) {
  const eventKind = cleanString(event.eventKind, 80)?.toUpperCase() || "";
  const actionSource = cleanString(event.actionSource, 40)?.toUpperCase() || "";
  const requiresHuman = canonicalNeedsHumanActor(eventKind, actionSource);
  const authorizationCapture = requiresHuman ? humanAuthorizationCapture(event) : null;
  if (requiresHuman && !authorizationCapture) return { rejected: "human_authorization_capture_required" };
  if (authorizationCapture?.semantics === "CURRENT_HUMAN") {
    const exactGeneration = authorizationCapture.authorizationScopeIncarnation === admittedAuthorizationSessionId
      && Number(authorizationCapture.accessEpoch) === Number(liveMember.accessEpoch)
      && Number(authorizationCapture.creatorCatalogGeneration) === Number(currentCreatorCatalogGeneration);
    if (!exactGeneration) return { rejected: "human_authorization_generation_stale" };
  }

  const terminalClosure = terminalPerformanceClosure(event);
  // Normal/current telemetry must resolve only a live Creator. A terminal
  // closure may resolve a retired Creator solely so the server can prove
  // and clamp an already-existing performance session to the canonical
  // Creator retirement boundary.
  const creator = await resolveCreator({ agencyId, event, strict: true, allowRetired: Boolean(terminalClosure), db: tx });
  if (!creator) return { rejected: "creator_not_found" };
  if (authorizationCapture?.semantics === "TERMINAL_CLOSURE") {
    if (!terminalClosure || !sameAuthorizationGenerationProof(authorizationCapture, terminalClosure.startedUnder)) {
      return { rejected: "authorization_terminal_capture_mismatch" };
    }
  } else if (terminalClosure) {
    return { rejected: "authorization_terminal_capture_required" };
  }

  const terminalClosureProof = terminalClosure
    ? await hasDurableTerminalClosureProof({
      db: tx,
      agencyId,
      deviceId,
      member: liveMember,
      creator,
      event,
      admittedAuthorizationSessionId,
      currentCreatorCatalogGeneration,
    })
    : null;
  if (terminalClosure && !terminalClosureProof) return { rejected: "authorization_terminal_closure_unproven" };

  const creatorRetired = Boolean(optionalDate(creator.deletedAt));
  if (creatorRetired) {
    // Retirement is creator-wide even for OWNER/all-scope members. Only a
    // proven COVERAGE_ENDED may terminate the already-existing durable
    // session after retirement. DIALOG_SESSION has no independent durable
    // START proof and remains fail-closed.
    if (!terminalClosureProof || terminalClosureProof.closure.eventKind !== "COVERAGE_ENDED") {
      return { rejected: "creator_retired" };
    }
  } else if (!canAccessCreator(liveMember, creator.id)) {
    // Only COVERAGE_ENDED can bypass a later scoped creator revoke: the
    // durable matching COVERAGE_STARTED row proves an already-existing
    // server session that this event can only terminate. DIALOG_SESSION
    // has no durable START row of its own, so accepting it after revoke
    // would create a new performance record rather than close proven state.
    if (!terminalClosureProof || terminalClosureProof.closure.eventKind !== "COVERAGE_ENDED") {
      return { rejected: "creator_access_forbidden" };
    }
  }

  const authorityNow = await dbAuthorityNow({ db: tx });
  const result = normalizeCanonicalCore({
    agencyId,
    deviceId,
    event,
    creator,
    authenticatedMember: liveMember,
    authorityNow,
    terminalClosureProof,
  });
  if (!result.row) return { rejected: result.reason || "invalid_contract" };
  const row = result.row;

  return persistCanonicalTeamEventRow({ db: tx, row });
}

async function ingestTeamEvents({
  agencyId, deviceId, userId, memberId = null, admittedAccessEpoch = 1, admittedAuthorizationSessionId = null, events = [],
}) {
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
  const candidates = [];

  // Contract-only rejects do not need a database transaction. Everything that
  // can affect authority/projections enters a bounded SERIALIZABLE chunk below.
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
    candidates.push(event);
  }

  for (let offset = 0; offset < candidates.length; offset += TEAM_TELEMETRY_TX_CHUNK_SIZE) {
    const chunk = candidates.slice(offset, offset + TEAM_TELEMETRY_TX_CHUNK_SIZE);
    let outcomes = null;
    try {
      outcomes = await runDbTransaction(prisma, async (tx) => {
        // One current member-generation SHARE lock owns this bounded chunk. A
        // concurrent accessEpoch mutation cannot pass the chunk and then let
        // stale human events physically commit afterward. The small fixed chunk
        // bound prevents one 1000-event request from holding the generation lock
        // for the entire HTTP batch.
        const liveMember = await loadLiveTelemetryMember({
          db: tx,
          agencyId,
          memberId,
          userId,
          admittedAccessEpoch,
        });
        const chunkHasHumanPerformance = chunk.some((event) => eventRequiresHumanAuthorizationCapture(event));
        if (chunkHasHumanPerformance) {
          await lockLiveAuthorizationSession({
            db: tx, agencyId, userId, deviceId, authorizationSessionId: admittedAuthorizationSessionId,
          });
        }
        const currentCreatorCatalogGeneration = chunkHasHumanPerformance
          ? await lockCreatorCatalogGeneration({ db: tx, agencyId })
          : null;
        const results = [];
        for (const event of chunk) {
          const durable = await ingestCanonicalTeamEventInTx({
            tx, agencyId, deviceId, event, liveMember, admittedAuthorizationSessionId, currentCreatorCatalogGeneration,
          });
          results.push({ event, durable });
        }
        return results;
      }, serializableTxOptions());
    } catch (err) {
      if ([
        "TELEMETRY_MEMBER_STALE", "TELEMETRY_ACCESS_EPOCH_STALE",
        "TELEMETRY_AUTHORIZATION_SESSION_REQUIRED", "TELEMETRY_AUTHORIZATION_SESSION_STALE",
        "TELEMETRY_CREATOR_CATALOG_STALE",
      ].includes(err?.code)) throw err;
      throw err;
    }

    for (const { event, durable } of outcomes || []) {
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
  TEAM_TELEMETRY_TX_CHUNK_SIZE,
  eventRequiresHumanAuthorizationCapture,
  ingestTeamEvents,
  normalizeCanonicalCore,
  persistCanonicalTeamEventRow,
};

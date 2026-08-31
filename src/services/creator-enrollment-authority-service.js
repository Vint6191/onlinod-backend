"use strict";

const { canAccessCreator } = require("../middleware/automation-permissions");
const { canUsePermission } = require("./team-access-control");
const { lockDbAdvisoryXact } = require("./db-transaction-service");
const {
  reinitializeCreatorSessionInTransaction,
  revokeCreatorSessionInTransaction,
} = require("./creator-session-broker-service");
const { CREATOR_CONNECTION_STATES, creatorConnectionLockKey } = require("./creator-connection-authority");

const SERIALIZABLE = Object.freeze({ isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });

function clean(value, max = 4096) {
  const text = String(value ?? "").trim();
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeUsername(value) {
  const text = clean(value, 120).replace(/^@+/, "").toLowerCase();
  return text || null;
}

const CREATOR_PROFILE_CLOCK_SKEW_MS = 5 * 60 * 1000;

function parseObservedAt(value, now = new Date()) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) {
    throw codedError("CREATOR_PROFILE_OBSERVED_AT_INVALID", "A valid platform profile observation timestamp is required", 400);
  }
  if (date.getTime() > now.getTime() + CREATOR_PROFILE_CLOCK_SKEW_MS) {
    throw codedError("CREATOR_PROFILE_OBSERVED_AT_FUTURE", "Platform profile observation is too far in the future", 409);
  }
  return date;
}

function profileAuthorityOrder({ observedAt, sourceDeviceId }) {
  return { at: observedAt.getTime(), device: clean(sourceDeviceId, 180) };
}

function compareProfileAuthority(current, incoming) {
  const currentGeneration = Number(current.platformProfileConnectionGeneration || 0);
  const incomingGeneration = Number(incoming.connectionGeneration);
  if (currentGeneration !== incomingGeneration) return incomingGeneration > currentGeneration ? 1 : -1;
  const currentAt = current.platformProfileObservedAt ? new Date(current.platformProfileObservedAt) : null;
  if (!currentAt || Number.isNaN(currentAt.getTime())) return 1;
  const a = profileAuthorityOrder({ observedAt: currentAt, sourceDeviceId: current.platformProfileSourceDeviceId || "" });
  const b = profileAuthorityOrder({ observedAt: incoming.observedAt, sourceDeviceId: incoming.sourceDeviceId });
  if (b.at !== a.at) return b.at > a.at ? 1 : -1;
  if (b.device === a.device) return 0;
  return b.device > a.device ? 1 : -1;
}

function codedError(code, message, status = 409, extra = null) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  if (extra && typeof extra === "object") Object.assign(error, extra);
  return error;
}

function creatorUniqueViolation(error) {
  return String(error?.code || "") === "P2002";
}

async function runSerializable(db, work) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db.$transaction(work, SERIALIZABLE);
    } catch (error) {
      last = error;
      if (String(error?.code || "") !== "P2034") throw error;
    }
  }
  throw codedError(
    "CREATOR_CONNECTION_CONCURRENT_CHANGE",
    "Creator connection authority changed concurrently; refresh and retry",
    409,
    { cause: last },
  );
}

async function requireLiveConnectionAuthority({ tx, agencyId, creatorId, userId }) {
  const member = await tx.agencyMember.findUnique({
    where: { agencyId_userId: { agencyId, userId } },
  });
  if (!member || member.deletedAt || member.deactivatedAt) {
    throw codedError("CREATOR_CONNECTION_MEMBER_INACTIVE", "Agency membership is no longer active", 403);
  }
  if (!(await canUsePermission({ member, key: "creators.manage", db: tx }))) {
    throw codedError("CREATOR_MANAGEMENT_FORBIDDEN", "Creator management permission is required", 403);
  }
  const creator = await tx.creatorAccount.findFirst({
    where: { id: creatorId, agencyId, deletedAt: null },
  });
  if (!creator) throw codedError("CREATOR_NOT_FOUND", "Creator not found", 404);
  if (!canAccessCreator(member, creator.id)) {
    throw codedError("CREATOR_ACCESS_FORBIDDEN", "Creator access was revoked before connection commit", 403);
  }
  return { member, creator };
}

async function requireLiveCreatorAccess({ tx, agencyId, creatorId, userId }) {
  const member = await tx.agencyMember.findUnique({
    where: { agencyId_userId: { agencyId, userId } },
  });
  if (!member || member.deletedAt || member.deactivatedAt) {
    throw codedError("CREATOR_CONNECTION_MEMBER_INACTIVE", "Agency membership is no longer active", 403);
  }
  const creator = await tx.creatorAccount.findFirst({
    where: { id: creatorId, agencyId, deletedAt: null },
  });
  if (!creator) throw codedError("CREATOR_NOT_FOUND", "Creator not found", 404);
  if (!canAccessCreator(member, creator.id)) {
    throw codedError("CREATOR_ACCESS_FORBIDDEN", "Creator access was revoked", 403);
  }
  return { member, creator };
}

async function createCreatorDraft({ db, agencyId, displayName, username, notes = null, beforeCommit = null }) {
  const expectedUsername = normalizeUsername(username);
  const internalName = clean(displayName, 120);
  if (!expectedUsername || !internalName) throw codedError("CREATOR_ENROLLMENT_INPUT_INVALID", "Display name and expected OnlyFans username are required", 400);
  try {
    return await runSerializable(db, async (tx) => {
      const creator = await tx.creatorAccount.create({
        data: {
          agencyId,
          displayName: internalName,
          username: expectedUsername,
          enrollmentExpectedUsername: expectedUsername,
          platformUsername: null,
          platformDisplayName: null,
          platformAvatarUrl: null,
          remoteId: null,
          status: "DRAFT",
          connectionState: CREATOR_CONNECTION_STATES.ENROLLMENT_REQUIRED,
          connectionGeneration: 0,
          connectionStartedAt: null,
          connectedSessionRevision: null,
          notes: clean(notes, 2000) || null,
        },
      });
      if (typeof beforeCommit === "function") await beforeCommit(tx, creator);
      return creator;
    });
  } catch (error) {
    if (creatorUniqueViolation(error)) throw codedError("CREATOR_ALREADY_EXISTS", "This OnlyFans username is already active in the agency", 409, { cause: error });
    throw error;
  }
}

async function beginCreatorConnection({ db, agencyId, creatorId, userId, deviceId = null }) {
  return runSerializable(db, async (tx) => {
    await lockDbAdvisoryXact({ db: tx, key: creatorConnectionLockKey(agencyId, creatorId) });
    const { creator } = await requireLiveConnectionAuthority({ tx, agencyId, creatorId, userId });
    const state = String(creator.connectionState || CREATOR_CONNECTION_STATES.ENROLLMENT_REQUIRED);
    const hasImmutableIdentity = Boolean(clean(creator.remoteId, 160));

    if (hasImmutableIdentity && state === CREATOR_CONNECTION_STATES.CONNECTED) {
      return { creator, mode: "CONNECTED", connectionGeneration: Number(creator.connectionGeneration || 0), unchanged: true };
    }
    if (!hasImmutableIdentity && state === CREATOR_CONNECTION_STATES.CONNECTING) {
      return { creator, mode: "ENROLLMENT", connectionGeneration: Number(creator.connectionGeneration || 0), unchanged: true };
    }
    if (hasImmutableIdentity && state === CREATOR_CONNECTION_STATES.RECONNECTING) {
      return { creator, mode: "RECONNECT", connectionGeneration: Number(creator.connectionGeneration || 0), unchanged: true };
    }

    const firstEnrollment = !hasImmutableIdentity;
    const expectedState = firstEnrollment
      ? CREATOR_CONNECTION_STATES.ENROLLMENT_REQUIRED
      : CREATOR_CONNECTION_STATES.RECONNECT_REQUIRED;
    if (state !== expectedState) {
      throw codedError(
        "CREATOR_CONNECTION_STATE_CONFLICT",
        `Creator connection cannot begin from ${state}`,
        409,
        { currentConnectionState: state, connectionGeneration: Number(creator.connectionGeneration || 0) },
      );
    }
    if (firstEnrollment && !normalizeUsername(creator.enrollmentExpectedUsername || creator.username)) {
      throw codedError("CREATOR_ENROLLMENT_USERNAME_REQUIRED", "Expected enrollment username is required", 409);
    }

    const now = new Date();
    const nextGeneration = Number(creator.connectionGeneration || 0) + 1;
    const nextState = firstEnrollment ? CREATOR_CONNECTION_STATES.CONNECTING : CREATOR_CONNECTION_STATES.RECONNECTING;
    const updated = await tx.creatorAccount.update({
      where: { id: creator.id },
      data: {
        connectionState: nextState,
        connectionGeneration: nextGeneration,
        connectionStartedAt: now,
        connectedSessionRevision: null,
      },
    });

    // Reconnect is an explicit anti-resurrection boundary. If a previous
    // canonical row exists, invalidate its credential payload before a new
    // verified generation is allowed to publish. This also handles a DRAFT
    // generation restarted after an interrupted/revoked attempt.
    await reinitializeCreatorSessionInTransaction({
      db: tx,
      agencyId,
      creatorId: creator.id,
      actorUserId: userId,
      deviceId,
      connectionGeneration: nextGeneration,
      connectionStartedAt: now,
    });

    return {
      creator: updated,
      mode: firstEnrollment ? "ENROLLMENT" : "RECONNECT",
      connectionGeneration: nextGeneration,
      unchanged: false,
    };
  });
}

function assertCanonicalForConnection({ creator, canonical, remoteId, connectionGeneration }) {
  const generation = Number(connectionGeneration);
  if (!Number.isInteger(generation) || generation <= 0 || Number(creator.connectionGeneration) !== generation) {
    throw codedError("CREATOR_CONNECTION_GENERATION_STALE", "Creator connection generation is no longer current", 409, {
      currentConnectionGeneration: Number(creator.connectionGeneration || 0),
    });
  }
  const state = String(creator.connectionState || "");
  if (state !== CREATOR_CONNECTION_STATES.CONNECTING && state !== CREATOR_CONNECTION_STATES.RECONNECTING) {
    throw codedError("CREATOR_CONNECTION_STATE_CONFLICT", `Creator is not awaiting connection completion (${state || "UNKNOWN"})`, 409, {
      currentConnectionState: state,
    });
  }
  if (!canonical
    || canonical.status !== "ACTIVE"
    || Number(canonical.connectionGeneration || 0) !== generation
    || Number(canonical.revision) <= 0
    || Number(canonical.payloadVersion) !== 1
    || canonical.portableReady !== true
    || String(canonical.platformUserId || "") !== String(remoteId)
    || !clean(canonical.credentialHash, 128)
    || !clean(canonical.coherenceHash, 128)) {
    throw codedError("CREATOR_CANONICAL_SESSION_REQUIRED", "A verified canonical creator session from the current connection generation is required", 409);
  }
  const startedAt = creator.connectionStartedAt ? new Date(creator.connectionStartedAt) : null;
  const capturedAt = canonical.capturedAt ? new Date(canonical.capturedAt) : null;
  if (!startedAt || Number.isNaN(startedAt.getTime()) || !capturedAt || Number.isNaN(capturedAt.getTime()) || capturedAt.getTime() < startedAt.getTime()) {
    throw codedError("CREATOR_CANONICAL_SESSION_STALE_GENERATION", "Canonical creator session predates the current connection generation", 409);
  }
}

async function completeCreatorConnection({
  db, agencyId, creatorId, userId, connectionGeneration, remoteId, username, platformDisplayName = null, avatarUrl = null,
}) {
  const identity = clean(remoteId, 160);
  const observedUsername = normalizeUsername(username);
  if (!identity || !observedUsername) throw codedError("CREATOR_CONNECTION_IDENTITY_REQUIRED", "Verified OnlyFans id and username are required", 400);

  try {
    return await runSerializable(db, async (tx) => {
      await lockDbAdvisoryXact({ db: tx, key: creatorConnectionLockKey(agencyId, creatorId) });
      const { creator } = await requireLiveConnectionAuthority({ tx, agencyId, creatorId, userId });
      const generation = Number(connectionGeneration);

      // Lost HTTP acknowledgement after a successful commit is idempotent.
      if (String(creator.connectionState || "") === CREATOR_CONNECTION_STATES.CONNECTED
        && Number(creator.connectionGeneration) === generation
        && String(creator.remoteId || "") === identity) {
        return { creator, unchanged: true, connectedNow: false };
      }

      const firstEnrollment = !clean(creator.remoteId, 160);
      if (firstEnrollment) {
        const expectedUsername = normalizeUsername(creator.enrollmentExpectedUsername || creator.username);
        if (!expectedUsername || expectedUsername !== observedUsername) {
          throw codedError("CREATOR_IDENTITY_MISMATCH", "The signed-in OnlyFans account does not match the enrollment username", 409, {
            expectedUsername,
            observedUsername,
          });
        }
      } else if (String(creator.remoteId) !== identity) {
        throw codedError("CREATOR_IDENTITY_MISMATCH", "Reconnect must prove the creator's immutable OnlyFans user id", 409);
      }

      const canonical = await tx.creatorSessionState.findUnique({ where: { creatorId: creator.id } });
      assertCanonicalForConnection({ creator, canonical, remoteId: identity, connectionGeneration: generation });

      const conflict = await tx.creatorAccount.findFirst({
        where: {
          agencyId,
          deletedAt: null,
          id: { not: creator.id },
          OR: [
            { remoteId: identity },
            { platformUsername: { equals: observedUsername, mode: "insensitive" } },
            { enrollmentExpectedUsername: { equals: observedUsername, mode: "insensitive" } },
            { username: { equals: observedUsername, mode: "insensitive" } },
          ],
        },
        select: { id: true },
      });
      if (conflict) {
        throw codedError("CREATOR_ALREADY_EXISTS", "This OnlyFans creator is already connected", 409, { creatorId: conflict.id });
      }

      const updated = await tx.creatorAccount.update({
        where: { id: creator.id },
        data: {
          remoteId: identity,
          username: observedUsername,
          enrollmentExpectedUsername: null,
          platformUsername: observedUsername,
          platformDisplayName: clean(platformDisplayName, 120) || null,
          platformAvatarUrl: clean(avatarUrl, 2000) || null,
          platformProfileObservedAt: canonical.capturedAt || null,
          platformProfileSourceDeviceId: clean(canonical.capturedByDeviceId, 180) || null,
          platformProfileConnectionGeneration: generation,
          avatarUrl: clean(avatarUrl, 2000) || creator.avatarUrl,
          status: "READY",
          connectionState: CREATOR_CONNECTION_STATES.CONNECTED,
          connectionStartedAt: null,
          connectedSessionRevision: Number(canonical.revision),
        },
      });
      return { creator: updated, unchanged: false, connectedNow: true };
    });
  } catch (error) {
    if (creatorUniqueViolation(error)) {
      throw codedError("CREATOR_ALREADY_EXISTS", "This OnlyFans creator identity or username is already active in the agency", 409, { cause: error });
    }
    throw error;
  }
}

async function observeCreatorPlatformProfile({
  db, agencyId, creatorId, userId, sourceDeviceId, connectionGeneration, observedAt,
  remoteId, username, platformDisplayName = null, avatarUrl = null, beforeCommit = null,
}) {
  const identity = clean(remoteId, 160);
  const observedUsername = normalizeUsername(username);
  const deviceId = clean(sourceDeviceId, 180);
  const generation = Number(connectionGeneration);
  const observationTime = parseObservedAt(observedAt);
  if (!identity || !observedUsername) throw codedError("CREATOR_PROFILE_IDENTITY_REQUIRED", "Verified OnlyFans id and username are required", 400);
  if (!deviceId) throw codedError("CREATOR_PROFILE_DEVICE_REQUIRED", "A device-bound platform profile observation is required", 400);
  if (!Number.isInteger(generation) || generation <= 0) throw codedError("CREATOR_PROFILE_GENERATION_INVALID", "A valid creator connection generation is required", 400);
  try {
    return await runSerializable(db, async (tx) => {
      await lockDbAdvisoryXact({ db: tx, key: creatorConnectionLockKey(agencyId, creatorId) });
      const { creator } = await requireLiveCreatorAccess({ tx, agencyId, creatorId, userId });
      if (String(creator.remoteId || "") !== identity) {
        throw codedError("CREATOR_PROFILE_IDENTITY_MISMATCH", "Platform profile observation does not match the connected creator identity", 409);
      }
      const currentGeneration = Number(creator.connectionGeneration || 0);
      if (generation < currentGeneration) {
        return { creator, unchanged: true, staleNoop: true, reason: "STALE_CONNECTION_GENERATION" };
      }
      if (generation > currentGeneration) {
        throw codedError("CREATOR_PROFILE_GENERATION_MISMATCH", "Platform profile observation belongs to an unknown future connection generation", 409, {
          currentConnectionGeneration: currentGeneration,
          observedConnectionGeneration: generation,
        });
      }
      if (String(creator.connectionState || "") !== CREATOR_CONNECTION_STATES.CONNECTED) {
        throw codedError("CREATOR_PROFILE_CONNECTION_NOT_CURRENT", "Platform profile observations require the current connected generation", 409);
      }

      const authority = compareProfileAuthority(creator, {
        connectionGeneration: generation,
        observedAt: observationTime,
        sourceDeviceId: deviceId,
      });
      if (authority < 0) {
        return { creator, unchanged: true, staleNoop: true, reason: "STALE_PROFILE_OBSERVATION" };
      }
      if (authority === 0) {
        return { creator, unchanged: true, staleNoop: false, reason: "DUPLICATE_PROFILE_OBSERVATION" };
      }

      const conflict = await tx.creatorAccount.findFirst({
        where: {
          agencyId,
          deletedAt: null,
          id: { not: creator.id },
          OR: [
            { platformUsername: { equals: observedUsername, mode: "insensitive" } },
            { enrollmentExpectedUsername: { equals: observedUsername, mode: "insensitive" } },
            { username: { equals: observedUsername, mode: "insensitive" } },
          ],
        },
        select: { id: true },
      });
      if (conflict) throw codedError("CREATOR_ALREADY_EXISTS", "This OnlyFans username is already active in the agency", 409, { creatorId: conflict.id });
      if (typeof beforeCommit === "function") await beforeCommit(tx, creator);
      // The access/member state may have changed while an external test hook or
      // future pre-commit work ran. Re-read inside the same transaction before
      // mutating the current projection.
      const { creator: liveCreator } = await requireLiveCreatorAccess({ tx, agencyId, creatorId, userId });
      if (String(liveCreator.remoteId || "") !== identity || Number(liveCreator.connectionGeneration || 0) !== generation) {
        throw codedError("CREATOR_PROFILE_AUTHORITY_CHANGED", "Creator profile authority changed before commit", 409);
      }
      const nextAvatar = clean(avatarUrl, 2000) || null;
      const updated = await tx.creatorAccount.update({
        where: { id: liveCreator.id },
        data: {
          username: observedUsername,
          platformUsername: observedUsername,
          platformDisplayName: clean(platformDisplayName, 120) || null,
          platformAvatarUrl: nextAvatar,
          platformProfileObservedAt: observationTime,
          platformProfileSourceDeviceId: deviceId,
          platformProfileConnectionGeneration: generation,
          ...(nextAvatar ? { avatarUrl: nextAvatar } : {}),
        },
      });
      return { creator: updated, unchanged: false, staleNoop: false, reason: null };
    });
  } catch (error) {
    if (creatorUniqueViolation(error)) throw codedError("CREATOR_ALREADY_EXISTS", "This OnlyFans username is already active in the agency", 409, { cause: error });
    throw error;
  }
}

async function revokeCreatorConnection({
  db, agencyId, creatorId, userId, deviceId, baseRevision, requestId, reason, beforeRevoke = null,
}) {
  return runSerializable(db, async (tx) => {
    await lockDbAdvisoryXact({ db: tx, key: creatorConnectionLockKey(agencyId, creatorId) });
    await requireLiveConnectionAuthority({ tx, agencyId, creatorId, userId });
    if (typeof beforeRevoke === "function") await beforeRevoke(tx);
    // Destructive authority is checked again immediately before the broker
    // mutation so middleware/request admission is never the correctness fence.
    await requireLiveConnectionAuthority({ tx, agencyId, creatorId, userId });
    return revokeCreatorSessionInTransaction({
      tx, agencyId, creatorId, actorUserId: userId, deviceId, baseRevision, requestId, reason,
    });
  });
}

module.exports = {
  createCreatorDraft,
  beginCreatorConnection,
  completeCreatorConnection,
  observeCreatorPlatformProfile,
  revokeCreatorConnection,
  normalizeUsername,
  CREATOR_CONNECTION_STATES,
};

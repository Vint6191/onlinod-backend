"use strict";

const crypto = require("node:crypto");
const { encryptSnapshot, decryptSnapshot } = require("./snapshot-crypto");

function text(value, max = 4096) {
  const result = String(value ?? "");
  return result.length > max ? result.slice(0, max) : result;
}

function nullableText(value, max = 4096) {
  if (value === null || value === undefined) return null;
  const result = text(value, max).trim();
  return result || null;
}

function normalizeSameSite(value) {
  const result = nullableText(value, 32);
  if (!result) return null;
  return ["no_restriction", "lax", "strict", "unspecified"].includes(result) ? result : null;
}

const SESSION_COOKIE_NOISE_EXACT = new Set([
  "lang",
  "cookiesaccepted",
  "ref_src",
  "__cf_bm",
  "_cfuvid",
  "streams",
  "_fbp",
  "_gid",
  "_gcl_au",
]);

function isPortableSessionCookieName(name) {
  const lower = String(name || "").trim().toLowerCase();
  if (!lower || SESSION_COOKIE_NOISE_EXACT.has(lower)) return false;
  if (lower.startsWith("cloudfront-")) return false;
  if (lower === "_ga" || lower.startsWith("_ga_") || lower.startsWith("_gat_")) return false;
  return true;
}

function isOnlyFansCookieDomain(domainInput) {
  const host = String(domainInput || "").trim().replace(/^\.+/, "").toLowerCase();
  return host === "onlyfans.com" || host.endsWith(".onlyfans.com");
}

function normalizeCookie(cookie) {
  const source = cookie && typeof cookie === "object" && !Array.isArray(cookie) ? cookie : {};
  const name = nullableText(source.name, 256);
  const domain = nullableText(source.domain, 512);
  if (!name || !domain || !isOnlyFansCookieDomain(domain) || !isPortableSessionCookieName(name)) return null;

  const expiration = Number(source.expirationDate);
  const expirationDate = Number.isFinite(expiration) && expiration > 0 ? expiration : null;

  const hostOnly = source.hostOnly === true ? true : source.hostOnly === false ? false : !domain.startsWith(".");

  return {
    name,
    value: text(source.value, 32_768),
    domain,
    hostOnly,
    path: nullableText(source.path, 2048) || "/",
    secure: source.secure !== false,
    httpOnly: source.httpOnly === true,
    sameSite: normalizeSameSite(source.sameSite),
    session: source.session === true,
    expirationDate,
  };
}

function normalizePayload(payload) {
  const source = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const cookies = Array.isArray(source.cookies)
    ? source.cookies.map(normalizeCookie).filter(Boolean).slice(0, 256)
    : [];
  cookies.sort((left, right) => {
    const l = `${left.domain}\u0000${left.path}\u0000${left.name}`;
    const r = `${right.domain}\u0000${right.path}\u0000${right.name}`;
    return l.localeCompare(r);
  });

  const storageSource = source.storage && typeof source.storage === "object" && !Array.isArray(source.storage)
    ? source.storage
    : {};

  return {
    cookies,
    storage: {
      bcTokenSha: nullableText(storageSource.bcTokenSha, 16_384),
    },
    userAgent: nullableText(source.userAgent, 2048),
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

function hashesForPayload(payload) {
  const normalized = normalizePayload(payload);
  const credentialShape = {
    cookies: normalized.cookies.map((cookie) => ({ name: cookie.name, value: cookie.value, domain: cookie.domain, hostOnly: cookie.hostOnly, path: cookie.path })),
    storage: normalized.storage,
    userAgent: normalized.userAgent,
  };
  return {
    payload: normalized,
    credentialHash: hash(credentialShape),
    coherenceHash: hash(normalized),
  };
}

function publicState(record, { includePayload = false } = {}) {
  if (!record) {
    return {
      revision: 0,
      status: "MISSING",
      payloadVersion: 1,
      platformUserId: null,
      credentialHash: null,
      coherenceHash: null,
      capturedAt: null,
      capturedByDeviceId: null,
      sourceRequestId: null,
      revokedAt: null,
      updatedAt: null,
      ...(includePayload ? { payload: null } : {}),
    };
  }

  let payload = null;
  if (includePayload && record.status === "ACTIVE") {
    if (!record.encryptedPayload || !record.iv || !record.tag) {
      const error = new Error("Active creator session is missing encrypted payload fields");
      error.code = "CREATOR_SESSION_CORRUPT";
      error.status = 500;
      throw error;
    }
    payload = decryptSnapshot(record);
  }

  return {
    revision: Number(record.revision || 0),
    status: String(record.status || "MISSING"),
    payloadVersion: Number(record.payloadVersion || 1),
    platformUserId: record.platformUserId || null,
    credentialHash: record.credentialHash || null,
    coherenceHash: record.coherenceHash || null,
    capturedAt: record.capturedAt || null,
    capturedByDeviceId: record.capturedByDeviceId || null,
    sourceRequestId: record.sourceRequestId || null,
    revokedAt: record.revokedAt || null,
    updatedAt: record.updatedAt || null,
    ...(includePayload ? { payload } : {}),
  };
}

async function requireRegisteredDevice({ db, agencyId, userId, deviceId }) {
  const id = nullableText(deviceId, 180);
  if (!id) {
    const error = new Error("A registered deviceId is required");
    error.code = "CREATOR_SESSION_DEVICE_REQUIRED";
    error.status = 400;
    throw error;
  }
  const device = await db.workerDevice.findFirst({
    where: { id, agencyId, userId },
    select: { id: true, agencyId: true, userId: true, lastSeenAt: true },
  });
  if (!device) {
    const error = new Error("This device is not registered for the current user and agency");
    error.code = "CREATOR_SESSION_DEVICE_NOT_REGISTERED";
    error.status = 403;
    throw error;
  }
  return device;
}

async function getCreatorSession({ db, agencyId, creatorId, includePayload = true }) {
  const record = await db.creatorSessionState.findUnique({ where: { creatorId } });
  if (record && record.agencyId !== agencyId) {
    const error = new Error("Creator session state belongs to a different agency");
    error.code = "CREATOR_SESSION_AGENCY_MISMATCH";
    error.status = 403;
    throw error;
  }
  return publicState(record, { includePayload });
}

function sessionConflict(current) {
  const error = new Error("Creator session revision is stale");
  error.code = "CREATOR_SESSION_REVISION_CONFLICT";
  error.status = 409;
  error.current = publicState(current, { includePayload: false });
  return error;
}

async function writeCreatorSession({
  db,
  agencyId,
  creatorId,
  actorUserId,
  deviceId,
  baseRevision,
  requestId,
  capturedAt,
  platformUserId,
  payload,
}) {
  const revision = Math.max(0, Math.floor(Number(baseRevision) || 0));
  const normalizedRequestId = nullableText(requestId, 180);
  if (!normalizedRequestId) {
    const error = new Error("requestId is required");
    error.code = "CREATOR_SESSION_REQUEST_ID_REQUIRED";
    error.status = 400;
    throw error;
  }

  const identity = nullableText(platformUserId, 160);
  if (!identity) {
    const error = new Error("platformUserId is required");
    error.code = "CREATOR_SESSION_PLATFORM_USER_REQUIRED";
    error.status = 400;
    throw error;
  }

  const creator = await db.creatorAccount.findFirst({
    where: { id: creatorId, agencyId, deletedAt: null },
    select: { id: true, agencyId: true, remoteId: true, status: true },
  });
  if (!creator) {
    const error = new Error("Creator not found");
    error.code = "CREATOR_NOT_FOUND";
    error.status = 404;
    throw error;
  }
  if (creator.remoteId && String(creator.remoteId) !== identity) {
    const error = new Error("The verified OnlyFans identity does not match this creator");
    error.code = "CREATOR_SESSION_IDENTITY_MISMATCH";
    error.status = 409;
    throw error;
  }

  const { payload: normalizedPayload, credentialHash, coherenceHash } = hashesForPayload(payload);
  if (!normalizedPayload.cookies.length) {
    const error = new Error("At least one OnlyFans cookie is required");
    error.code = "CREATOR_SESSION_COOKIES_REQUIRED";
    error.status = 400;
    throw error;
  }
  const strongCookieNames = new Set(normalizedPayload.cookies.map((cookie) => String(cookie.name || "").toLowerCase()));
  if (!strongCookieNames.has("sess") && !strongCookieNames.has("auth_id")) {
    const error = new Error("A strong OnlyFans auth cookie is required");
    error.code = "CREATOR_SESSION_STRONG_AUTH_COOKIE_REQUIRED";
    error.status = 400;
    throw error;
  }
  const captured = capturedAt ? new Date(capturedAt) : new Date();
  if (Number.isNaN(captured.getTime())) {
    const error = new Error("capturedAt is invalid");
    error.code = "CREATOR_SESSION_CAPTURED_AT_INVALID";
    error.status = 400;
    throw error;
  }
  const encrypted = encryptSnapshot(normalizedPayload);

  return db.$transaction(async (tx) => {
    const current = await tx.creatorSessionState.findUnique({ where: { creatorId } });

    if (current?.sourceRequestId === normalizedRequestId && current.capturedByDeviceId === deviceId) {
      if (current.coherenceHash !== coherenceHash || current.platformUserId !== identity) {
        const error = new Error("requestId was already used for different creator session data");
        error.code = "CREATOR_SESSION_REQUEST_ID_REUSED";
        error.status = 409;
        throw error;
      }
      return { state: publicState(current, { includePayload: false }), idempotent: true, unchanged: true };
    }

    if (!current) {
      if (revision !== 0) throw sessionConflict(null);
      try {
        const created = await tx.creatorSessionState.create({
          data: {
            agencyId,
            creatorId,
            revision: 1,
            status: "ACTIVE",
            payloadVersion: encrypted.payloadVersion,
            encryptedPayload: encrypted.encryptedPayload,
            iv: encrypted.iv,
            tag: encrypted.tag,
            algorithm: encrypted.algorithm,
            platformUserId: identity,
            credentialHash,
            coherenceHash,
            capturedAt: captured,
            capturedByUserId: actorUserId,
            capturedByDeviceId: deviceId,
            sourceRequestId: normalizedRequestId,
            revokedAt: null,
            revokeReason: null,
          },
        });
        return { state: publicState(created, { includePayload: false }), idempotent: false, unchanged: false };
      } catch (error) {
        if (error?.code !== "P2002") throw error;
        const raced = await tx.creatorSessionState.findUnique({ where: { creatorId } });
        throw sessionConflict(raced);
      }
    }

    if (current.agencyId !== agencyId || Number(current.revision) !== revision) throw sessionConflict(current);

    if (current.status === "ACTIVE" && current.coherenceHash === coherenceHash && current.platformUserId === identity) {
      return { state: publicState(current, { includePayload: false }), idempotent: false, unchanged: true };
    }

    const updated = await tx.creatorSessionState.updateMany({
      where: { creatorId, agencyId, revision },
      data: {
        revision: { increment: 1 },
        status: "ACTIVE",
        payloadVersion: encrypted.payloadVersion,
        encryptedPayload: encrypted.encryptedPayload,
        iv: encrypted.iv,
        tag: encrypted.tag,
        algorithm: encrypted.algorithm,
        platformUserId: identity,
        credentialHash,
        coherenceHash,
        capturedAt: captured,
        capturedByUserId: actorUserId,
        capturedByDeviceId: deviceId,
        sourceRequestId: normalizedRequestId,
        revokedAt: null,
        revokeReason: null,
      },
    });
    if (updated.count !== 1) {
      const raced = await tx.creatorSessionState.findUnique({ where: { creatorId } });
      throw sessionConflict(raced);
    }
    const next = await tx.creatorSessionState.findUnique({ where: { creatorId } });
    return { state: publicState(next, { includePayload: false }), idempotent: false, unchanged: false };
  }, { maxWait: 10_000, timeout: 30_000 });
}

async function revokeCreatorSession({ db, agencyId, creatorId, actorUserId, deviceId, baseRevision, requestId, reason }) {
  const revision = Math.max(0, Math.floor(Number(baseRevision) || 0));
  const normalizedRequestId = nullableText(requestId, 180);
  if (!normalizedRequestId) {
    const error = new Error("requestId is required");
    error.code = "CREATOR_SESSION_REQUEST_ID_REQUIRED";
    error.status = 400;
    throw error;
  }

  return db.$transaction(async (tx) => {
    const current = await tx.creatorSessionState.findUnique({ where: { creatorId } });
    if (!current) {
      if (revision !== 0) throw sessionConflict(null);
      return { state: publicState(null, { includePayload: false }), idempotent: false, unchanged: true };
    }
    if (current.agencyId !== agencyId || Number(current.revision) !== revision) throw sessionConflict(current);
    if (current.sourceRequestId === normalizedRequestId && current.capturedByDeviceId === deviceId && current.status === "REVOKED") {
      return { state: publicState(current, { includePayload: false }), idempotent: true, unchanged: true };
    }
    if (current.status === "REVOKED") {
      return { state: publicState(current, { includePayload: false }), idempotent: false, unchanged: true };
    }

    const now = new Date();
    const updated = await tx.creatorSessionState.updateMany({
      where: { creatorId, agencyId, revision, status: "ACTIVE" },
      data: {
        revision: { increment: 1 },
        status: "REVOKED",
        encryptedPayload: null,
        iv: null,
        tag: null,
        algorithm: null,
        credentialHash: null,
        coherenceHash: null,
        capturedAt: now,
        capturedByUserId: actorUserId,
        capturedByDeviceId: deviceId,
        sourceRequestId: normalizedRequestId,
        revokedAt: now,
        revokeReason: nullableText(reason, 500),
      },
    });
    if (updated.count !== 1) {
      const raced = await tx.creatorSessionState.findUnique({ where: { creatorId } });
      throw sessionConflict(raced);
    }
    const next = await tx.creatorSessionState.findUnique({ where: { creatorId } });
    return { state: publicState(next, { includePayload: false }), idempotent: false, unchanged: false };
  }, { maxWait: 10_000, timeout: 30_000 });
}

module.exports = {
  normalizePayload,
  hashesForPayload,
  publicState,
  requireRegisteredDevice,
  getCreatorSession,
  writeCreatorSession,
  revokeCreatorSession,
};

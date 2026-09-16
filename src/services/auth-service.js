const jwt = require("jsonwebtoken");
const prisma = require("../prisma");
const { randomToken, randomCode, sha256, addMinutes, addDays } = require("../utils/crypto");
const { signAccessToken, refreshTokenDays } = require("../utils/tokens");
const { resolveRefreshDeviceBinding } = require("../utils/device-binding");
const { verificationEmail, passwordResetEmail } = require("./email-service");
const {
  acquireAuthorizationUserLock,
  acquireAuthorizationDeviceLock,
  acquireAuthorizationLineageLock,
  lockCurrentLoginAuthority,
  lockCurrentRefreshSession,
  withAuthorizationUserLock,
} = require("./authorization-session-authority-service");

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    emailVerifiedAt: user.emailVerifiedAt,
    lastLoginAt: user.lastLoginAt,
    disabledAt: user.disabledAt || null,
    createdAt: user.createdAt,
  };
}

function accessTokenExpiry(accessToken) {
  try {
    const decoded = jwt.decode(accessToken);
    if (decoded?.exp) return new Date(decoded.exp * 1000);
  } catch (_) {}
  return new Date(Date.now() + 15 * 60 * 1000);
}

function refreshDaysForRememberDevice(rememberDevice) {
  if (rememberDevice) {
    const n = Number(process.env.REFRESH_TOKEN_REMEMBER_DAYS || 90);
    return Number.isFinite(n) && n > 0 ? n : 90;
  }
  return refreshTokenDays();
}

async function authorizationSessionWasUsed(db, authorizationSessionId) {
  const normalized = String(authorizationSessionId || "").trim();
  if (!normalized) return false;
  const raw = await db.refreshSession.findFirst({
    where: { authorizationSessionId: normalized },
    select: { id: true },
  });
  if (raw) return true;
  if (db.authorizationSessionBoundary?.findUnique) {
    const boundary = await db.authorizationSessionBoundary.findUnique({
      where: { authorizationSessionId: normalized },
      select: { authorizationSessionId: true },
    });
    if (boundary) return true;
  }
  return false;
}

async function getPrimaryMembership(userId) {
  return prisma.agencyMember.findFirst({
    where: {
      userId,
      deletedAt: null,
      deactivatedAt: null,
      agency: { deletedAt: null },
    },
    include: { agency: true },
    orderBy: { createdAt: "asc" },
  });
}

async function createAuthToken({ userId, type, ttlMinutes = 30, withCode = false }) {
  const token = randomToken(32);
  const code = withCode ? randomCode() : null;

  await prisma.authToken.create({
    data: {
      userId,
      type,
      tokenHash: sha256(token),
      codeHash: code ? sha256(code) : null,
      expiresAt: addMinutes(ttlMinutes),
    },
  });

  return { token, code };
}

async function issueEmailVerification(user) {
  await prisma.authToken.updateMany({
    where: {
      userId: user.id,
      type: "EMAIL_VERIFY",
      usedAt: null,
    },
    data: {
      usedAt: new Date(),
    },
  });

  const issued = await createAuthToken({
    userId: user.id,
    type: "EMAIL_VERIFY",
    ttlMinutes: 30,
    withCode: true,
  });

  const emailResult = await verificationEmail({
    email: user.email,
    token: issued.token,
    code: issued.code,
  });

  return {
    token: issued.token,
    code: issued.code,
    emailResult,
  };
}

async function issuePasswordReset(user) {
  await prisma.authToken.updateMany({
    where: {
      userId: user.id,
      type: "PASSWORD_RESET",
      usedAt: null,
    },
    data: {
      usedAt: new Date(),
    },
  });

  const issued = await createAuthToken({
    userId: user.id,
    type: "PASSWORD_RESET",
    ttlMinutes: 30,
    withCode: false,
  });

  const emailResult = await passwordResetEmail({
    email: user.email,
    token: issued.token,
  });

  return {
    token: issued.token,
    emailResult,
  };
}

async function createRefreshSession({
  userId,
  agencyId,
  userAgent,
  ipAddress,
  rememberDevice = false,
  deviceId = null,
  client = null,
  impersonatedByAdminId = null,
  authorizationSessionId = null,
  db = prisma,
}) {
  const refreshToken = randomToken(48);
  const expiresAt = addDays(refreshDaysForRememberDevice(rememberDevice));

  const row = await db.refreshSession.create({
    data: {
      userId,
      agencyId,
      tokenHash: sha256(refreshToken),
      userAgent: userAgent || null,
      ipAddress: ipAddress || null,
      expiresAt,
      rememberDevice: rememberDevice === true,
      deviceId: deviceId || null,
      client: client || null,
      impersonatedByAdminId: impersonatedByAdminId || null,
      authorizationSessionId: authorizationSessionId || null,
    },
    select: { id: true },
  });

  return { refreshToken, expiresAt, id: row.id, authorizationSessionId: authorizationSessionId || null };
}

async function issueLoginTokens({
  user, membership, req, rememberDevice = false, deviceId = null, client = null, authorizationScopeIncarnation = null,
}) {
  // Rolling activation mirrors refresh adoption. A lineage-aware Desktop brings
  // the durable incarnation it already owns; a legacy client that cannot persist
  // the server field remains NULL-lineage until a later upgraded refresh adopts
  // its local incarnation. Never invent a hidden random lineage for legacy login.
  const requestedAuthorizationSessionId = String(authorizationScopeIncarnation || "").trim().slice(0, 220) || null;
  const authorizationSessionId = requestedAuthorizationSessionId;
  const committed = await prisma.$transaction(async (tx) => {
    // Canonical lock order for authentication publication:
    // user -> device -> current User/Member/Agency rows.  The user lock is
    // shared by refresh rotation and refresh-only logout/revoke writers; the
    // row SHARE fence composes with business authority writers that mutate
    // User, AgencyMember or Agency without needing another advisory authority.
    await acquireAuthorizationUserLock(tx, { userId: user.id });
    await acquireAuthorizationDeviceLock(tx, { userId: user.id, agencyId: membership.agencyId, deviceId });
    await lockCurrentLoginAuthority(tx, {
      userId: user.id,
      agencyId: membership.agencyId,
      memberId: membership.id,
      expectedAccessEpoch: membership.accessEpoch,
      expectedPasswordHash: user.passwordHash || null,
    });

    if (authorizationSessionId) {
      // The Desktop incarnation is a global authorization-generation identity,
      // not merely a device-local label. Serialize its first publication and
      // reject any historical reuse before creating the login refresh session.
      await acquireAuthorizationLineageLock(tx, authorizationSessionId);
      const collision = await authorizationSessionWasUsed(tx, authorizationSessionId);
      if (collision) {
        const error = new Error("Authorization generation was already used by another session");
        error.code = "AUTHORIZATION_SESSION_COLLISION";
        error.status = 409;
        throw error;
      }
    }

    const updatedUser = await tx.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    // Publish the new lineage first. Revoking older same-device lineages after
    // this point cannot accidentally terminate the new generation.
    const created = await createRefreshSession({
      userId: user.id,
      agencyId: membership.agencyId,
      userAgent: req?.headers?.["user-agent"] || null,
      ipAddress: req?.ip || null,
      rememberDevice,
      deviceId,
      client,
      authorizationSessionId,
      db: tx,
    });
    const boundDeviceId = String(deviceId || "").trim();
    if (boundDeviceId) {
      await tx.refreshSession.updateMany({
        where: {
          userId: user.id,
          agencyId: membership.agencyId,
          deviceId: boundDeviceId,
          revokedAt: null,
          expiresAt: { gt: new Date() },
          id: { not: created.id },
        },
        data: { revokedAt: new Date() },
      });
    }
    return { ...created, user: updatedUser };
  });

  const accessToken = signAccessToken({
    userId: user.id,
    agencyId: membership.agencyId,
    role: membership.role,
    deviceId: deviceId || null,
    authorizationSessionId,
  });

  return {
    accessToken,
    refreshToken: committed.refreshToken,
    accessTokenExpiresAt: accessTokenExpiry(accessToken),
    refreshTokenExpiresAt: committed.expiresAt,
    authorizationSessionId,
    user: committed.user,
  };
}

async function verifyEmailByToken(token) {
  const tokenHash = sha256(token);

  const record = await prisma.authToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!record || record.type !== "EMAIL_VERIFY") {
    return { ok: false, code: "TOKEN_INVALID", error: "Verification token is invalid" };
  }

  if (record.usedAt) {
    return { ok: false, code: "TOKEN_USED", error: "Verification token was already used" };
  }

  if (record.expiresAt < new Date()) {
    return { ok: false, code: "TOKEN_EXPIRED", error: "Verification token expired" };
  }

  const user = await prisma.$transaction(async (tx) => {
    await tx.authToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    });

    return tx.user.update({
      where: { id: record.userId },
      data: { emailVerifiedAt: record.user.emailVerifiedAt || new Date() },
    });
  });

  return {
    ok: true,
    user,
  };
}

async function verifyEmailByCode({ email, code }) {
  const user = await prisma.user.findUnique({
    where: { email: String(email).toLowerCase().trim() },
  });

  if (!user) {
    return { ok: false, code: "USER_NOT_FOUND", error: "User not found" };
  }

  const records = await prisma.authToken.findMany({
    where: {
      userId: user.id,
      type: "EMAIL_VERIFY",
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
    take: 10000});

  const codeHash = sha256(code);
  const record = records.find((item) => item.codeHash === codeHash);

  if (!record) {
    return { ok: false, code: "CODE_INVALID", error: "Verification code is invalid or expired" };
  }

  const updated = await prisma.$transaction(async (tx) => {
    await tx.authToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    });

    return tx.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: user.emailVerifiedAt || new Date() },
    });
  });

  return {
    ok: true,
    user: updated,
  };
}

async function revokeRefreshReuseScope(session, now = new Date()) {
  const boundDeviceId = String(session?.deviceId || "").trim();
  return withAuthorizationUserLock({ db: prisma, userId: session.userId, work: async (tx) => tx.refreshSession.updateMany({
    where: {
      userId: session.userId,
      revokedAt: null,
      expiresAt: { gt: now },
      ...(boundDeviceId ? { deviceId: boundDeviceId } : {}),
    },
    data: { revokedAt: now },
  }) });
}

async function refreshAccessToken({ refreshToken, req, deviceId = null, client = null, authorizationScopeIncarnation = null }) {
  const tokenHash = sha256(refreshToken);

  const session = await prisma.refreshSession.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  const now = new Date();

  if (!session || session.expiresAt < now) {
    return { ok: false, code: "REFRESH_INVALID", error: "Refresh token is invalid or expired" };
  }

  if (session.revokedAt) {
    await revokeRefreshReuseScope(session, now);
    return { ok: false, code: "REFRESH_REUSED", error: "Refresh token reuse detected. Please sign in again." };
  }

  if (session.user.disabledAt) {
    return { ok: false, code: "USER_DISABLED", error: "User is disabled" };
  }

  const membership = await prisma.agencyMember.findFirst({
    where: {
      userId: session.userId,
      agencyId: session.agencyId,
      deletedAt: null,
      deactivatedAt: null,
      agency: { deletedAt: null },
    },
    include: { agency: true },
  });

  if (!membership) {
    return { ok: false, code: "SESSION_AGENCY_INVALID", error: "Session agency is invalid" };
  }

  const deviceBinding = resolveRefreshDeviceBinding(session.deviceId, deviceId);
  if (!deviceBinding.ok) return deviceBinding;
  const effectiveDeviceId = deviceBinding.deviceId;
  const requestedIncarnation = String(authorizationScopeIncarnation || "").trim().slice(0, 220) || null;
  const existingLineage = String(session.authorizationSessionId || "").trim() || null;

  if (existingLineage && requestedIncarnation && requestedIncarnation !== existingLineage) {
    return { ok: false, code: "AUTHORIZATION_SESSION_MISMATCH", error: "Refresh session belongs to a different authorization generation" };
  }

  const nextRefreshToken = randomToken(48);
  let authorizationSessionId = existingLineage;
  let nextRefreshExpiresAt = null;

  try {
    const rotated = await prisma.$transaction(async (tx) => {
      await acquireAuthorizationUserLock(tx, { userId: session.userId });
      await acquireAuthorizationDeviceLock(tx, {
        userId: session.userId, agencyId: session.agencyId, deviceId: effectiveDeviceId,
      });
      await lockCurrentLoginAuthority(tx, {
        userId: session.userId,
        agencyId: session.agencyId,
        memberId: membership.id,
        expectedAccessEpoch: membership.accessEpoch,
      });
      // Request-time refresh validation is not a commit fence. Re-lock the
      // exact source token after the canonical USER/DEVICE locks and prove that
      // it is still live using the database clock. This prevents a token that
      // expired or was revoked while waiting on authorization serialization
      // from publishing a replacement generation.
      const sourceSession = await lockCurrentRefreshSession(tx, {
        sessionId: session.id,
        tokenHash,
        userId: session.userId,
        agencyId: session.agencyId,
      });
      const sourceLineage = String(sourceSession.authorizationSessionId || "").trim() || null;
      if (sourceLineage && requestedIncarnation && requestedIncarnation !== sourceLineage) {
        const error = new Error("Refresh session belongs to a different authorization generation");
        error.code = "AUTHORIZATION_SESSION_MISMATCH";
        error.status = 401;
        throw error;
      }
      let authorizationSessionId = sourceLineage;
      const adoptingLegacyLineage = !authorizationSessionId && Boolean(requestedIncarnation);
      if (adoptingLegacyLineage) {
        // The same Desktop incarnation must not be concurrently adopted by a
        // different device/legacy chain after both transactions observe the
        // collision lookup as empty. Serialize the global incarnation identity
        // before performing the historical-use check.
        await acquireAuthorizationLineageLock(tx, requestedIncarnation);
        // Rolling upgrade: only a lineage-aware Desktop may convert a legacy
        // NULL-lineage refresh chain into the durable incarnation it already
        // persisted locally. A legacy Desktop that does not send an incarnation
        // must remain NULL-lineage across refresh rotation; otherwise a
        // Backend-first rollout invents a hidden random lineage that the old
        // client cannot persist and the upgraded client can never adopt.
        authorizationSessionId = requestedIncarnation;
        const collision = await authorizationSessionWasUsed(tx, authorizationSessionId);
        if (collision) {
          const error = new Error("AUTHORIZATION_SESSION_COLLISION");
          error.code = "AUTHORIZATION_SESSION_COLLISION";
          throw error;
        }
      }

      const nextExpiresAt = addDays(refreshDaysForRememberDevice(session.rememberDevice));
      const rotationNow = new Date();

      // Replacement first: the DB boundary trigger on the old token observes
      // another live row with the same lineage and therefore does not terminate
      // the login generation during ordinary refresh rotation.
      const replacement = await tx.refreshSession.create({
        data: {
          userId: session.userId,
          agencyId: session.agencyId,
          tokenHash: sha256(nextRefreshToken),
          userAgent: req?.headers?.["user-agent"] || session.userAgent,
          ipAddress: req?.ip || session.ipAddress,
          expiresAt: nextExpiresAt,
          rememberDevice: session.rememberDevice === true,
          deviceId: effectiveDeviceId,
          client: client || session.client,
          impersonatedByAdminId: session.impersonatedByAdminId || null,
          authorizationSessionId,
          lastUsedAt: rotationNow,
        },
        select: { id: true },
      });

      const revoked = await tx.refreshSession.updateMany({
        where: { id: session.id, revokedAt: null },
        data: {
          revokedAt: rotationNow,
          lastUsedAt: rotationNow,
          ipAddress: req?.ip || session.ipAddress,
          userAgent: req?.headers?.["user-agent"] || session.userAgent,
          deviceId: effectiveDeviceId,
          client: client || session.client,
          ...(adoptingLegacyLineage ? { authorizationSessionId } : {}),
        },
      });
      if (revoked.count !== 1) {
        const error = new Error("REFRESH_REUSED");
        error.code = "REFRESH_REUSED";
        throw error;
      }

      if (adoptingLegacyLineage && effectiveDeviceId) {
        // Pre-lineage versions could leave multiple active refresh chains on a
        // single logical device. Once one chain is adopted into the server
        // lineage, revoke every remaining live NULL-lineage chain for the same
        // user/agency/device. Otherwise an old access JWT without a lineage
        // could still authenticate through one of those spare legacy rows.
        await tx.refreshSession.updateMany({
          where: {
            userId: session.userId,
            agencyId: session.agencyId,
            deviceId: effectiveDeviceId,
            revokedAt: null,
            expiresAt: { gt: rotationNow },
            authorizationSessionId: null,
            id: { not: replacement.id },
          },
          data: { revokedAt: rotationNow },
        });
      }
      return { replacement, authorizationSessionId, nextExpiresAt };
    });
    if (!rotated) throw Object.assign(new Error("REFRESH_REUSED"), { code: "REFRESH_REUSED" });
    authorizationSessionId = rotated.authorizationSessionId;
    nextRefreshExpiresAt = rotated.nextExpiresAt;
  } catch (error) {
    if (error?.code === "AUTHORIZATION_SESSION_COLLISION") {
      return { ok: false, code: "AUTHORIZATION_SESSION_COLLISION", error: "Authorization generation was already used by another session" };
    }
    if (error?.code === "AUTHORIZATION_SESSION_MISMATCH") {
      return { ok: false, code: "AUTHORIZATION_SESSION_MISMATCH", error: error?.message || "Refresh session belongs to a different authorization generation" };
    }
    if (error?.code === "REFRESH_INVALID") {
      return { ok: false, code: "REFRESH_INVALID", error: error?.message || "Refresh token is invalid or expired" };
    }
    if (["AUTHORIZATION_CHANGED", "AUTHORIZATION_GENERATION_CHANGED", "CREDENTIAL_GENERATION_CHANGED"].includes(String(error?.code || ""))) {
      return { ok: false, code: String(error.code), error: error?.message || "Authorization changed. Please sign in again." };
    }
    if (error?.code === "REFRESH_REUSED") {
      await revokeRefreshReuseScope({ ...session, deviceId: effectiveDeviceId || session.deviceId }, now);
      return { ok: false, code: "REFRESH_REUSED", error: "Refresh token reuse detected. Please sign in again." };
    }
    throw error;
  }

  const accessToken = signAccessToken({
    userId: session.userId,
    agencyId: session.agencyId,
    role: membership.role,
    deviceId: effectiveDeviceId,
    authorizationSessionId,
  });

  return {
    ok: true,
    accessToken,
    accessTokenExpiresAt: accessTokenExpiry(accessToken),
    refreshToken: nextRefreshToken,
    refreshTokenExpiresAt: nextRefreshExpiresAt,
    authorizationSessionId,
    user: session.user,
    membership,
  };
}

async function revokeRefreshToken(refreshToken) {
  if (!refreshToken) return { ok: true };
  const tokenHash = sha256(refreshToken);
  const session = await prisma.refreshSession.findUnique({ where: { tokenHash } });
  if (!session || session.revokedAt) return { ok: true };
  const boundDeviceId = String(session.deviceId || "").trim();
  await withAuthorizationUserLock({ db: prisma, userId: session.userId, work: async (tx) => {
    await acquireAuthorizationDeviceLock(tx, {
      userId: session.userId,
      agencyId: session.agencyId,
      deviceId: boundDeviceId,
    });
    const revokeNow = new Date();
    await tx.refreshSession.updateMany({
      where: boundDeviceId
        ? { userId: session.userId, deviceId: boundDeviceId, revokedAt: null, expiresAt: { gt: revokeNow } }
        : { id: session.id, revokedAt: null },
      data: { revokedAt: revokeNow },
    });
  } });
  return { ok: true };
}

module.exports = {
  publicUser,
  getPrimaryMembership,
  issueEmailVerification,
  issuePasswordReset,
  issueLoginTokens,
  verifyEmailByToken,
  verifyEmailByCode,
  refreshAccessToken,
  revokeRefreshToken,
  accessTokenExpiry,
};

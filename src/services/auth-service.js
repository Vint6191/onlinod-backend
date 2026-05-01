const jwt = require("jsonwebtoken");
const prisma = require("../prisma");
const { randomToken, randomCode, sha256, addMinutes, addDays } = require("../utils/crypto");
const { signAccessToken, refreshTokenDays } = require("../utils/tokens");
const { verificationEmail, passwordResetEmail } = require("./email-service");

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

async function getPrimaryMembership(userId) {
  return prisma.agencyMember.findFirst({
    where: {
      userId,
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
}) {
  const refreshToken = randomToken(48);
  const expiresAt = addDays(refreshDaysForRememberDevice(rememberDevice));

  await prisma.refreshSession.create({
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
    },
  });

  return { refreshToken, expiresAt };
}

async function issueLoginTokens({ user, membership, req, rememberDevice = false, deviceId = null, client = null }) {
  const accessToken = signAccessToken({
    userId: user.id,
    agencyId: membership.agencyId,
    role: membership.role,
  });

  const refresh = await createRefreshSession({
    userId: user.id,
    agencyId: membership.agencyId,
    userAgent: req?.headers?.["user-agent"] || null,
    ipAddress: req?.ip || null,
    rememberDevice,
    deviceId,
    client,
  });

  return {
    accessToken,
    refreshToken: refresh.refreshToken,
    accessTokenExpiresAt: accessTokenExpiry(accessToken),
    refreshTokenExpiresAt: refresh.expiresAt,
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
  });

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

async function refreshAccessToken({ refreshToken, req, deviceId = null, client = null }) {
  const session = await prisma.refreshSession.findUnique({
    where: {
      tokenHash: sha256(refreshToken),
    },
    include: {
      user: true,
    },
  });

  if (!session || session.revokedAt || session.expiresAt < new Date()) {
    return { ok: false, code: "REFRESH_INVALID", error: "Refresh token is invalid or expired" };
  }

  if (session.user.disabledAt) {
    return { ok: false, code: "USER_DISABLED", error: "User is disabled" };
  }

  const membership = await prisma.agencyMember.findFirst({
    where: {
      userId: session.userId,
      agencyId: session.agencyId,
      agency: { deletedAt: null },
    },
    include: { agency: true },
  });

  if (!membership) {
    return { ok: false, code: "SESSION_AGENCY_INVALID", error: "Session agency is invalid" };
  }

  await prisma.refreshSession.update({
    where: { id: session.id },
    data: {
      lastUsedAt: new Date(),
      ipAddress: req?.ip || session.ipAddress,
      userAgent: req?.headers?.["user-agent"] || session.userAgent,
      deviceId: deviceId || session.deviceId,
      client: client || session.client,
    },
  });

  const accessToken = signAccessToken({
    userId: session.userId,
    agencyId: session.agencyId,
    role: membership.role,
  });

  return {
    ok: true,
    accessToken,
    accessTokenExpiresAt: accessTokenExpiry(accessToken),
    refreshToken,
    refreshTokenExpiresAt: session.expiresAt,
    user: session.user,
    membership,
  };
}

async function revokeRefreshToken(refreshToken) {
  if (!refreshToken) return { ok: true };

  await prisma.refreshSession.updateMany({
    where: {
      tokenHash: sha256(refreshToken),
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
    },
  });

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

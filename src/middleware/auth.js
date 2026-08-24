const prisma = require("../prisma");
const { verifyAccessToken } = require("../utils/tokens");
const { requireBoundAccessDevice } = require("../utils/device-binding");

async function authRequired(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const match = header.match(/^Bearer\s+(.+)$/i);

    if (!match) {
      return res.status(401).json({
        ok: false,
        code: "AUTH_REQUIRED",
        error: "Authorization token is required",
      });
    }

    const token = match[1];
    const decoded = verifyAccessToken(token);

    const boundDeviceId = decoded.deviceId ? String(decoded.deviceId).trim().slice(0, 160) : null;
    const membership = await prisma.agencyMember.findFirst({
      where: {
        userId: decoded.userId,
        agencyId: decoded.agencyId,
        deletedAt: null,
        deactivatedAt: null,
        agency: { deletedAt: null },
      },
      include: {
        user: boundDeviceId ? {
          include: {
            refreshSessions: {
              where: {
                agencyId: decoded.agencyId,
                deviceId: boundDeviceId,
                revokedAt: null,
                expiresAt: { gt: new Date() },
              },
              select: { id: true },
              take: 1,
            },
          },
        } : true,
        agency: true,
      },
    });

    if (!membership) {
      return res.status(401).json({
        ok: false,
        code: "SESSION_INVALID",
        error: "Session is invalid",
      });
    }

    if (membership.user.disabledAt) {
      return res.status(403).json({
        ok: false,
        code: "USER_DISABLED",
        error: "User is disabled",
      });
    }

    // Device logout is an account-session concern, not a crypto revocation.
    // A device-bound access token is accepted only while this user still has
    // an active refresh-session lineage for that same logical device. Remote
    // logout revokes those rows, so the next API request is rejected without
    // touching WorkerDevice, AMK/CDK wraps, creator bindings or other users.
    if (boundDeviceId) {
      const activeDeviceSessions = Array.isArray(membership.user.refreshSessions) ? membership.user.refreshSessions : [];
      if (!activeDeviceSessions.length) {
        return res.status(401).json({
          ok: false,
          code: "SESSION_REVOKED",
          error: "This device was logged out. Please sign in again.",
        });
      }
      const { refreshSessions: _activeDeviceSessions, ...publicAuthUser } = membership.user;
      membership.user = publicAuthUser;
    }

    // Admin force-logout must invalidate already-issued access tokens too.
    // Revoking refresh sessions is not enough because access tokens remain
    // valid until their exp. JWT iat is seconds, sessionsRevokedAt is ms.
    if (membership.user.sessionsRevokedAt) {
      const tokenIssuedAtMs = Number(decoded.iat || 0) * 1000;
      const revokedAtMs = new Date(membership.user.sessionsRevokedAt).getTime();

      if (!tokenIssuedAtMs || tokenIssuedAtMs <= revokedAtMs) {
        return res.status(401).json({
          ok: false,
          code: "SESSION_REVOKED",
          error: "Session was revoked. Please sign in again.",
        });
      }
    }

    if (!membership.user.emailVerifiedAt) {
      return res.status(403).json({
        ok: false,
        code: "EMAIL_NOT_VERIFIED",
        error: "Email is not verified",
      });
    }

    req.user = membership.user;
    req.member = membership;
    req.agency = membership.agency;

    req.auth = {
      userId: membership.userId,
      agencyId: membership.agencyId,
      memberId: membership.id,
      role: membership.role,
      deviceId: decoded.deviceId ? String(decoded.deviceId) : null,
      permissions: membership.permissions || {},
      user: membership.user,
      agency: membership.agency,
      membership,
    };

    return next();
  } catch (err) {
    return res.status(401).json({
      ok: false,
      code: "AUTH_INVALID",
      error: "Invalid or expired access token",
    });
  }
}

function requireAuthDevice(req, suppliedDeviceId, options = {}) {
  return requireBoundAccessDevice(req?.auth?.deviceId, suppliedDeviceId, options);
}

module.exports = {
  authRequired,
  requireAuthDevice,
};

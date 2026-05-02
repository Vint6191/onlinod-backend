const prisma = require("../prisma");
const { verifyAccessToken } = require("../utils/tokens");

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

    const membership = await prisma.agencyMember.findFirst({
      where: {
        userId: decoded.userId,
        agencyId: decoded.agencyId,
        agency: { deletedAt: null },
      },
      include: {
        user: true,
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

module.exports = {
  authRequired,
};

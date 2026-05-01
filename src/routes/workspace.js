const express = require("express");
const prisma = require("../prisma");
const { authRequired } = require("../middleware/auth");
const { publicUser } = require("../services/auth-service");

const router = express.Router();
router.use(authRequired);

function serializeMembership(member) {
  return {
    id: member.id,
    agencyId: member.agencyId,
    userId: member.userId,
    role: member.role,
    permissions: member.permissions || {},
    createdAt: member.createdAt,
    updatedAt: member.updatedAt,
    agency: member.agency,
  };
}

router.get("/context", async (req, res) => {
  try {
    const memberships = await prisma.agencyMember.findMany({
      where: {
        userId: req.auth.userId,
        agency: { deletedAt: null },
      },
      include: { agency: true },
      orderBy: { createdAt: "asc" },
    });

    const activeMember = memberships.find((item) => item.agencyId === req.auth.agencyId) || memberships[0] || null;

    const creators = activeMember
      ? await prisma.creatorAccount.findMany({
          where: {
            agencyId: activeMember.agencyId,
            deletedAt: null,
          },
          include: {
            billingProfile: true,
            accessSnapshots: {
              where: { active: true, revokedAt: null },
              orderBy: { createdAt: "desc" },
              take: 1,
              select: {
                id: true,
                creatorId: true,
                active: true,
                expiresAt: true,
                revokedAt: true,
                createdAt: true,
                username: true,
                remoteId: true,
                deviceId: true,
              },
            },
          },
          orderBy: { createdAt: "desc" },
        })
      : [];

    return res.json({
      ok: true,
      user: publicUser(req.auth.user),
      memberships: memberships.map(serializeMembership),
      activeAgency: activeMember?.agency || req.auth.agency,
      activeAgencyId: activeMember?.agencyId || req.auth.agencyId,
      activeMember: activeMember ? serializeMembership(activeMember) : null,
      activeMemberId: activeMember?.id || req.auth.memberId,
      role: activeMember?.role || req.auth.role,
      permissions: activeMember?.permissions || req.auth.permissions || {},
      creators,
    });
  } catch (err) {
    console.error("[workspace/context] failed:", err);
    return res.status(500).json({ ok: false, code: "WORKSPACE_CONTEXT_FAILED", error: "Failed to load workspace context" });
  }
});

module.exports = router;

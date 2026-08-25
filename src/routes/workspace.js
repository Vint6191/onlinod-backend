const express = require("express");
const prisma = require("../prisma");
const { authRequired } = require("../middleware/auth");
const { publicUser } = require("../services/auth-service");
const { isOwner, normalizeAssignedCreators, resolveEffectivePermissions } = require("../services/team-access-control");

const router = express.Router();
router.use(authRequired);

function getCreatorScopeFilter(member) {
  if (!member) return { id: { in: [] } };
  if (isOwner(member)) return {};
  const scope = normalizeAssignedCreators(member.assignedCreators);
  if (scope.mode === "all") return {};
  return { id: { in: scope.creatorIds.length ? scope.creatorIds : ["__none__"] } };
}

function serializeMembership(member) {
  return {
    id: member.id,
    agencyId: member.agencyId,
    userId: member.userId,
    role: member.role,
    roleKey: member.roleKey || (member.role === "OWNER" ? "owner" : member.role === "MANAGER" ? "manager" : "chatter"),
    permissions: member.permissions || {},
    displayName: member.displayName || member.user?.name || null,
    initials: member.initials || null,
    tone: member.tone || null,
    commission: member.commission || null,
    assignedCreators: member.assignedCreators || "all",
    statusBadge: member.statusBadge || null,
    lastSeenLabel: member.lastSeenLabel || null,
    isTest: member.isTest === true,
    deletedAt: member.deletedAt || null,
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
        deletedAt: null,
        deactivatedAt: null,
      },
      include: { agency: true, user: true },
      orderBy: { createdAt: "asc" },
      take: 10000});

    const membershipsWithPermissions = await Promise.all(memberships.map(async (member) => ({
      ...member,
      permissions: await resolveEffectivePermissions({ member, db: prisma }),
    })));
    const activeMember = membershipsWithPermissions.find((item) => item.agencyId === req.auth.agencyId) || membershipsWithPermissions[0] || null;

    const creators = activeMember
      ? await prisma.creatorAccount.findMany({
          where: {
            agencyId: activeMember.agencyId,
            deletedAt: null,
            ...(getCreatorScopeFilter(activeMember)),
          },
          include: {
            billingProfile: true,
            sessionState: {
              select: {
                status: true,
                revision: true,
                payloadVersion: true,
                portableReady: true,
                platformUserId: true,
                capturedByDeviceId: true,
                updatedAt: true,
              },
            },
          },
          orderBy: { createdAt: "desc" },
        })
      : [];

    return res.json({
      ok: true,
      user: publicUser(req.auth.user),
      memberships: membershipsWithPermissions.map(serializeMembership),
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

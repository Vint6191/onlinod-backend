"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { audit } = require("./audit-service");
const {
  revokeOwnerRootAccessForMember,
  requireOwnerCryptoCommitActor,
} = require("./client-e2e-keyring-service");
const {
  TEAM_FUNCTION_KEYS,
  PRESET_ROLES,
  PERMISSION_BY_KEY,
  PUBLIC_PERMISSION_KEYS,
  PUBLIC_PERMISSION_KEY_SET,
  memberRoleKey,
  isOwner,
  resolveRoleDefinition,
  resolveEffectivePermissions,
  canUsePermission,
  normalizeAssignedCreators,
  validateAssignedCreators,
  publicPermissionZones,
} = require("./team-access-control");

const TEAM_FUNCTION_SET = new Set(TEAM_FUNCTION_KEYS);
const PRESET_ROLE_KEYS = Object.freeze(Object.keys(PRESET_ROLES));
const PRESET_ROLE_SET = new Set(PRESET_ROLE_KEYS);

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function newToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function roleKeyToLegacy(roleKey) {
  const key = String(roleKey || "").trim().toLowerCase();
  if (key === "owner") return "OWNER";
  if (key === "manager" || key === "supervisor") return "MANAGER";
  return "OPERATOR";
}

function actorUserId(req) {
  return req?.auth?.userId || req?.user?.id || null;
}

function actorMemberId(req) {
  return req?.agencyMember?.id || req?.auth?.memberId || null;
}

function cleanFunctions(value) {
  const raw = Array.isArray(value) ? value : [];
  return Array.from(new Set(raw.map((key) => String(key || "").trim().toUpperCase()).filter((key) => TEAM_FUNCTION_SET.has(key))));
}


function actorScopeIds(member) {
  return normalizeAssignedCreators(member?.assignedCreators);
}

function assertActorCanGrantCreatorScope({ actorMember, targetMember = null, assignedCreators }) {
  if (isOwner(actorMember)) return;
  if (targetMember && isOwner(targetMember)) {
    const error = new Error("Only OWNER can manage an OWNER membership");
    error.code = "OWNER_MANAGEMENT_REQUIRED";
    error.status = 403;
    throw error;
  }
  const actorScope = actorScopeIds(actorMember);
  if (actorScope.mode === "all") return;

  const requested = normalizeAssignedCreators(assignedCreators);
  if (requested.mode === "all") {
    const error = new Error("You cannot grant all-creators access while your own creator access is scoped");
    error.code = "CREATOR_SCOPE_ESCALATION";
    error.status = 403;
    throw error;
  }
  const allowed = new Set(actorScope.creatorIds);
  const outside = requested.creatorIds.filter((id) => !allowed.has(id));
  if (outside.length) {
    const error = new Error("You cannot grant creator access outside your own scope");
    error.code = "CREATOR_SCOPE_ESCALATION";
    error.status = 403;
    error.details = { creatorIds: outside };
    throw error;
  }
}

// Delegation fence: a non-owner may only assign/configure operational powers
// they personally hold. The two claim permissions are intentionally exempt:
// they are self-scoped actions (claim/release own work), so a manager does not
// need to hold them in order to assign a normal Chatter role.
const SELF_SCOPED_PERMISSION_KEYS = new Set([
  "money.claim",
  "money.release_own_claim",
]);
const DELEGATED_PERMISSION_KEYS = Object.freeze(
  PUBLIC_PERMISSION_KEYS.filter((key) => !SELF_SCOPED_PERMISSION_KEYS.has(key))
);

async function serializableTeamTransaction(db, fn) {
  return db.$transaction(fn, { isolationLevel: "Serializable" });
}

function requireLiveTeamActor(actor) {
  if (!actor || actor.deletedAt || actor.deactivatedAt) {
    const error = new Error("Team administration actor is no longer active");
    error.code = "TEAM_ACTOR_INACTIVE";
    error.status = 403;
    throw error;
  }
  return actor;
}

function teamCryptoProofError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = 403;
  return error;
}

async function requireOwnerPossessionForCryptoDestructiveTeamMutation({
  tx,
  agencyId,
  actorUserId,
  liveActor,
  actorDeviceId,
  actorProof,
}) {
  // Preserve pre-E2E Team Administration semantics until an agency root exists.
  // Once AMK-backed crypto is initialized, any Team mutation that removes OWNER
  // authority is itself a destructive crypto operation because the same
  // Serializable transaction revokes that member's AMK wraps.
  const root = await tx.agencyCryptoRoot.findUnique({ where: { agencyId }, select: { agencyId: true } });
  if (!root) return null;
  if (!String(actorDeviceId || "").trim()) {
    throw teamCryptoProofError("CRYPTO_ACTOR_DEVICE_REQUIRED", "OWNER crypto-sensitive Team Administration requires a device-bound authentication token");
  }
  if (!String(actorProof || "").trim()) {
    throw teamCryptoProofError("CRYPTO_ACTOR_PROOF_REQUIRED", "OWNER crypto-sensitive Team Administration requires possession of the active Agency Master Key");
  }
  return requireOwnerCryptoCommitActor({
    db: tx,
    agencyId,
    userId: actorUserId,
    member: liveActor,
    deviceId: actorDeviceId,
    actorProof,
  });
}

function assertRoleConfigurationWithinActor({ actorMember, actorPermissions, role }) {
  if (isOwner(actorMember)) return;
  const escalated = DELEGATED_PERMISSION_KEYS.filter((permissionKey) =>
    role?.permissions?.[permissionKey] === true && actorPermissions?.[permissionKey] !== true
  );
  if (escalated.length) {
    const error = new Error("You cannot configure a role with administration privileges you do not have");
    error.code = "ROLE_CONFIGURATION_PRIVILEGE_ESCALATION";
    error.status = 403;
    error.details = { permissionKeys: escalated };
    throw error;
  }
}

async function assertActorCanAssignRole({ agencyId, actorMember, roleKey, db = prisma }) {
  const key = String(roleKey || "").trim().toLowerCase();
  if (isOwner(actorMember)) return;
  if (key === "owner") {
    const error = new Error("Only OWNER can assign the OWNER role");
    error.code = "OWNER_ROLE_CHANGE_REQUIRED";
    error.status = 403;
    throw error;
  }
  const [actorPermissions, targetRole] = await Promise.all([
    resolveEffectivePermissions({ member: actorMember, db }),
    resolveRoleDefinition({ agencyId, roleKey: key, db }),
  ]);
  const escalated = DELEGATED_PERMISSION_KEYS.filter((permissionKey) => targetRole.permissions?.[permissionKey] === true && actorPermissions?.[permissionKey] !== true);
  if (escalated.length) {
    const error = new Error("You cannot assign a role with administration privileges you do not have");
    error.code = "ROLE_PRIVILEGE_ESCALATION";
    error.status = 403;
    error.details = { permissionKeys: escalated };
    throw error;
  }
}

function assertActorCanManageMember({ actorMember, targetMember }) {
  if (isOwner(actorMember)) return;
  if (isOwner(targetMember)) {
    const error = new Error("Only OWNER can manage an OWNER membership");
    error.code = "OWNER_MANAGEMENT_REQUIRED";
    error.status = 403;
    throw error;
  }
  assertActorCanGrantCreatorScope({ actorMember, targetMember, assignedCreators: targetMember?.assignedCreators });
}

function canActorManageMember({ actorMember, targetMember }) {
  try {
    assertActorCanManageMember({ actorMember, targetMember });
    return true;
  } catch (_) {
    return false;
  }
}

function canActorManageCreatorScope({ actorMember, assignedCreators }) {
  try {
    assertActorCanGrantCreatorScope({ actorMember, assignedCreators });
    return true;
  } catch (_) {
    return false;
  }
}

function hasDirectPermissionOverrides(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  for (const item of Object.values(value)) {
    if (typeof item === "boolean") return true;
    if (item && typeof item === "object" && !Array.isArray(item) && hasDirectPermissionOverrides(item)) return true;
  }
  return false;
}

function memberStatus(member) {
  if (member?.deletedAt) return "removed";
  if (member?.deactivatedAt) return "deactivated";
  return "active";
}

function memberToClient(member) {
  const name = member.displayName || member.user?.name || member.user?.email || "member";
  return {
    id: member.id,
    userId: member.userId,
    displayName: member.displayName || null,
    name,
    email: member.user?.email || null,
    avatarUrl: member.user?.avatarUrl || null,
    initials: member.initials || String(name).trim().slice(0, 2).toUpperCase(),
    tone: member.tone || "amber",
    roleKey: memberRoleKey(member),
    legacyRole: member.role,
    functions: cleanFunctions((member.teamFunctions || []).map((row) => row.functionKey)),
    creatorAccess: isOwner(member) ? { mode: "all", creatorIds: [] } : normalizeAssignedCreators(member.assignedCreators),
    assignedCreators: member.assignedCreators ?? "all",
    commission: member.commission || { kind: "none" },
    status: memberStatus(member),
    deactivatedAt: member.deactivatedAt || null,
    deletedAt: member.deletedAt || null,
    createdAt: member.createdAt,
    updatedAt: member.updatedAt,
    lastLoginAt: member.user?.lastLoginAt || null,
    lastSeenLabel: member.lastSeenLabel || null,
    isTest: Boolean(member.isTest),
    hasDirectPermissionOverrides: hasDirectPermissionOverrides(member.permissions),
  };
}

function invitationStatus(inv, now = new Date()) {
  if (inv.claimedAt) return "claimed";
  if (inv.revokedAt) return "revoked";
  if (inv.expiresAt < now) return "expired";
  return "pending";
}

function invitationToClient(inv) {
  return {
    id: inv.id,
    email: inv.email,
    roleKey: inv.roleKey,
    displayName: inv.displayName,
    creatorAccess: normalizeAssignedCreators(inv.assignedCreators ?? []),
    assignedCreators: inv.assignedCreators ?? [],
    functions: cleanFunctions(inv.functions),
    commission: inv.commission || null,
    invitedBy: inv.invitedBy ? { id: inv.invitedBy.id, email: inv.invitedBy.email, name: inv.invitedBy.name } : null,
    expiresAt: inv.expiresAt,
    claimedAt: inv.claimedAt,
    revokedAt: inv.revokedAt,
    createdAt: inv.createdAt,
    status: invitationStatus(inv),
  };
}

function creatorToClient(creator) {
  return {
    id: creator.id,
    displayName: creator.displayName,
    username: creator.username || null,
    avatarUrl: creator.avatarUrl || null,
    status: creator.status,
  };
}

async function roleExists({ agencyId, roleKey, db = prisma }) {
  const key = String(roleKey || "").trim().toLowerCase();
  if (PRESET_ROLE_SET.has(key)) return true;
  if (!key) return false;
  return Boolean(await db.agencyCustomRole.findUnique({ where: { agencyId_key: { agencyId, key } }, select: { id: true } }));
}

async function ensureRoleExists({ agencyId, roleKey, db = prisma }) {
  if (!(await roleExists({ agencyId, roleKey, db }))) {
    const error = new Error(`Unknown roleKey: ${roleKey}`);
    error.code = "UNKNOWN_ROLE";
    error.status = 400;
    throw error;
  }
  return String(roleKey).trim().toLowerCase();
}

async function listRoles({ agencyId, members, db = prisma }) {
  const [customs, inviteGroups] = await Promise.all([
    db.agencyCustomRole.findMany({ where: { agencyId }, select: { key: true }, orderBy: { createdAt: "asc" }, take: 10000 }),
    db.agencyInvitation.groupBy({
      by: ["roleKey"],
      where: { agencyId, claimedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      _count: { _all: true },
    }),
  ]);
  const keys = [...PRESET_ROLE_KEYS, ...customs.map((row) => row.key).filter((key) => !PRESET_ROLE_SET.has(key))];
  const counts = new Map();
  for (const member of members) {
    const key = memberRoleKey(member);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const inviteCounts = new Map(inviteGroups.map((row) => [String(row.roleKey), Number(row._count?._all || 0)]));
  const roles = [];
  for (const key of keys) {
    const resolved = await resolveRoleDefinition({ agencyId, roleKey: key, db });
    const memberCount = counts.get(key) || 0;
    const pendingInvitationCount = inviteCounts.get(key) || 0;
    roles.push({
      ...resolved,
      memberCount,
      pendingInvitationCount,
      canDelete: resolved.custom && memberCount === 0 && pendingInvitationCount === 0,
    });
  }
  return roles;
}

async function teamAdminCapabilities({ member, db = prisma }) {
  const keys = [
    "workspace.view_team",
    "workspace.manage_members",
    "workspace.invite",
    "workspace.edit_roles",
    "workspace.view_audit",
  ];
  const entries = await Promise.all(keys.map(async (key) => [key, await canUsePermission({ member, key, db })]));
  return Object.fromEntries(entries);
}

async function getTeamAdministrationState({ agencyId, viewerMember, includeAudit = true, auditLimit = 40, db = prisma }) {
  const members = await db.agencyMember.findMany({
    where: { agencyId, deletedAt: null },
    include: {
      user: { select: { id: true, email: true, name: true, avatarUrl: true, lastLoginAt: true } },
      teamFunctions: { select: { functionKey: true } },
    },
    orderBy: [{ deactivatedAt: "asc" }, { createdAt: "asc" }],
    take: 10000,
  });
  const [rolesRaw, creators, invitations, capabilities, viewerPermissions] = await Promise.all([
    listRoles({ agencyId, members, db }),
    db.creatorAccount.findMany({
      where: {
        agencyId,
        deletedAt: null,
        ...(() => {
          const scope = normalizeAssignedCreators(viewerMember.assignedCreators);
          if (isOwner(viewerMember) || scope.mode === "all") return {};
          return { id: { in: scope.creatorIds.length ? scope.creatorIds : ["__none__"] } };
        })(),
      },
      select: { id: true, displayName: true, username: true, avatarUrl: true, status: true },
      orderBy: { displayName: "asc" },
      take: 10000,
    }),
    db.agencyInvitation.findMany({
      where: { agencyId },
      include: { invitedBy: { select: { id: true, email: true, name: true } } },
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
    teamAdminCapabilities({ member: viewerMember, db }),
    resolveEffectivePermissions({ member: viewerMember, db }),
  ]);
  const roles = rolesRaw.map((role) => ({
    ...role,
    assignable: isOwner(viewerMember) || (role.key !== "owner" && !DELEGATED_PERMISSION_KEYS.some((permissionKey) =>
      role.permissions?.[permissionKey] === true && viewerPermissions?.[permissionKey] !== true
    )),
  }));

  let auditRows = [];
  if (includeAudit && capabilities["workspace.view_audit"] === true) {
    auditRows = await db.auditLog.findMany({
      where: { agencyId, action: { startsWith: "team." } },
      include: { actor: { select: { id: true, email: true, name: true, avatarUrl: true } } },
      orderBy: { createdAt: "desc" },
      take: Math.max(1, Math.min(200, Number(auditLimit) || 40)),
    });
  }

  const assignableRoleKeys = new Set(roles.filter((role) => role.assignable).map((role) => role.key));
  const viewerCreatorAccess = isOwner(viewerMember) ? { mode: "all", creatorIds: [] } : normalizeAssignedCreators(viewerMember.assignedCreators);

  return {
    ok: true,
    agencyId,
    meMemberId: viewerMember.id,
    viewerCreatorAccess,
    capabilities,
    members: members.map((member) => ({
      ...memberToClient(member),
      manageableByViewer: canActorManageMember({ actorMember: viewerMember, targetMember: member }),
    })),
    roles,
    creators: creators.map(creatorToClient),
    invitations: invitations.map((invitation) => {
      const client = invitationToClient(invitation);
      const scopeManageable = canActorManageCreatorScope({ actorMember: viewerMember, assignedCreators: invitation.assignedCreators ?? [] });
      return {
        ...client,
        reissuableByViewer: client.roleKey !== "owner" && scopeManageable && assignableRoleKeys.has(client.roleKey),
        revocableByViewer: scopeManageable,
      };
    }),
    permissionZones: publicPermissionZones(),
    functionKeys: [...TEAM_FUNCTION_KEYS],
    audit: auditRows.map((row) => ({
      id: row.id,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      metadata: row.metadata || {},
      createdAt: row.createdAt,
      actor: row.actor ? { id: row.actor.id, name: row.actor.name || row.actor.email || "member", email: row.actor.email, avatarUrl: row.actor.avatarUrl || null } : null,
    })),
  };
}

async function assertOwnerSafety({ agencyId, targetMember, nextRoleKey = null, removing = false, db = prisma }) {
  const currentlyOwner = isOwner(targetMember);
  const remainsOwner = !removing && (nextRoleKey === null || String(nextRoleKey).toLowerCase() === "owner");
  if (!currentlyOwner || remainsOwner) return;
  const otherOwners = await db.agencyMember.count({
    where: {
      agencyId,
      deletedAt: null,
      deactivatedAt: null,
      id: { not: targetMember.id },
      OR: [{ roleKey: "owner" }, { role: "OWNER" }],
    },
  });
  if (otherOwners === 0) {
    const error = new Error("Cannot demote, deactivate, or remove the last active OWNER");
    error.code = "LAST_OWNER";
    error.status = 409;
    throw error;
  }
}

async function updateMemberSettings({ agencyId, memberId, patch, actorMember, actorUserId: actorId, actorDeviceId = null, actorProof = null, db = prisma }) {
  const target = await db.agencyMember.findFirst({
    where: { id: memberId, agencyId, deletedAt: null },
    include: { user: true, teamFunctions: { select: { functionKey: true } } },
  });
  if (!target) {
    const error = new Error("Member not found in this agency");
    error.code = "MEMBER_NOT_FOUND";
    error.status = 404;
    throw error;
  }

  assertActorCanManageMember({ actorMember, targetMember: target });

  const nextRoleKey = patch.roleKey === undefined ? memberRoleKey(target) : await ensureRoleExists({ agencyId, roleKey: patch.roleKey, db });
  if ((nextRoleKey === "owner" || isOwner(target)) && !isOwner(actorMember)) {
    const error = new Error("Only OWNER can promote or demote an OWNER");
    error.code = "OWNER_ROLE_CHANGE_REQUIRED";
    error.status = 403;
    throw error;
  }
  await assertActorCanAssignRole({ agencyId, actorMember, roleKey: nextRoleKey, db });
  await assertOwnerSafety({ agencyId, targetMember: target, nextRoleKey, db });

  let creatorScope = null;
  if (nextRoleKey === "owner") {
    creatorScope = { ok: true, value: "all", normalized: { mode: "all", creatorIds: [] } };
  } else if (patch.assignedCreators !== undefined) {
    creatorScope = await validateAssignedCreators({ agencyId, assignedCreators: patch.assignedCreators, db });
    if (!creatorScope.ok) {
      const error = new Error(`Unknown creator scope: ${creatorScope.unknownCreatorIds.join(", ")}`);
      error.code = creatorScope.code;
      error.status = 400;
      error.details = { unknownCreatorIds: creatorScope.unknownCreatorIds };
      throw error;
    }
  }

  assertActorCanGrantCreatorScope({
    actorMember,
    targetMember: target,
    assignedCreators: creatorScope ? creatorScope.value : target.assignedCreators,
  });

  const nextFunctions = patch.functions === undefined ? null : cleanFunctions(patch.functions);
  const before = memberToClient(target);

  const ownerDemoted = isOwner(target) && nextRoleKey !== "owner";
  const updated = await serializableTeamTransaction(db, async (tx) => {
    const liveActor = requireLiveTeamActor(await tx.agencyMember.findFirst({ where: { id: actorMember?.id, agencyId, deletedAt: null } }));
    const liveTarget = await tx.agencyMember.findFirst({ where: { id: target.id, agencyId, deletedAt: null } });
    if (!liveTarget) { const error = new Error("Member not found in this agency"); error.code = "MEMBER_NOT_FOUND"; error.status = 404; throw error; }
    assertActorCanManageMember({ actorMember: liveActor, targetMember: liveTarget });
    if ((nextRoleKey === "owner" || isOwner(liveTarget)) && !isOwner(liveActor)) { const error = new Error("Only OWNER can promote or demote an OWNER"); error.code = "OWNER_ROLE_CHANGE_REQUIRED"; error.status = 403; throw error; }
    await assertActorCanAssignRole({ agencyId, actorMember: liveActor, roleKey: nextRoleKey, db: tx });
    await assertOwnerSafety({ agencyId, targetMember: liveTarget, nextRoleKey, db: tx });
    assertActorCanGrantCreatorScope({ actorMember: liveActor, targetMember: liveTarget, assignedCreators: creatorScope ? creatorScope.value : liveTarget.assignedCreators });
    const liveOwnerDemoted = isOwner(liveTarget) && nextRoleKey !== "owner";
    if (liveOwnerDemoted) {
      await requireOwnerPossessionForCryptoDestructiveTeamMutation({
        tx, agencyId, actorUserId: actorId, liveActor, actorDeviceId, actorProof,
      });
    }
    const row = await tx.agencyMember.update({
      where: { id: liveTarget.id },
      data: {
        ...(patch.displayName !== undefined ? { displayName: patch.displayName || null } : {}),
        ...(patch.roleKey !== undefined ? { roleKey: nextRoleKey, role: roleKeyToLegacy(nextRoleKey) } : {}),
        ...(creatorScope ? { assignedCreators: creatorScope.value } : {}),
      },
    });
    if (liveOwnerDemoted) {
      await revokeOwnerRootAccessForMember({ db: tx, agencyId, userId: liveTarget.userId, revokedAt: new Date() });
    }
    if (nextFunctions !== null) {
      await tx.teamMemberFunction.deleteMany({ where: { agencyId, memberId: target.id } });
      if (nextFunctions.length) {
        await tx.teamMemberFunction.createMany({
          data: nextFunctions.map((functionKey) => ({ agencyId, memberId: target.id, functionKey })),
          skipDuplicates: true,
        });
      }
    }
    return tx.agencyMember.findUnique({
      where: { id: row.id },
      include: {
        user: { select: { id: true, email: true, name: true, avatarUrl: true, lastLoginAt: true } },
        teamFunctions: { select: { functionKey: true } },
      },
    });
  });

  const after = memberToClient(updated);
  await audit({
    agencyId,
    actorUserId: actorId,
    action: "team.member.updated",
    targetType: "agency_member",
    targetId: target.id,
    metadata: {
      actorMemberId: actorMember?.id || null,
      before: { roleKey: before.roleKey, functions: before.functions, creatorAccess: before.creatorAccess, displayName: before.name },
      after: { roleKey: after.roleKey, functions: after.functions, creatorAccess: after.creatorAccess, displayName: after.name },
    },
    db,
  });
  return after;
}

async function setMemberStatus({ agencyId, memberId, status, actorMember, actorUserId: actorId, actorDeviceId = null, actorProof = null, db = prisma }) {
  const target = await db.agencyMember.findFirst({ where: { id: memberId, agencyId, deletedAt: null } });
  if (!target) {
    const error = new Error("Member not found");
    error.code = "MEMBER_NOT_FOUND";
    error.status = 404;
    throw error;
  }
  assertActorCanManageMember({ actorMember, targetMember: target });
  if (target.id === actorMember?.id && status === "deactivated") {
    const error = new Error("You cannot deactivate your own active membership");
    error.code = "CANNOT_DEACTIVATE_SELF";
    error.status = 409;
    throw error;
  }
  if (status === "deactivated") await assertOwnerSafety({ agencyId, targetMember: target, nextRoleKey: null, removing: true, db });

  const deactivatedAt = status === "deactivated" ? new Date() : null;
  await serializableTeamTransaction(db, async (tx) => {
    const liveActor = requireLiveTeamActor(await tx.agencyMember.findFirst({ where: { id: actorMember?.id, agencyId, deletedAt: null } }));
    const liveTarget = await tx.agencyMember.findFirst({ where: { id: target.id, agencyId, deletedAt: null } });
    if (!liveTarget) { const error = new Error("Member not found"); error.code = "MEMBER_NOT_FOUND"; error.status = 404; throw error; }
    assertActorCanManageMember({ actorMember: liveActor, targetMember: liveTarget });
    if (liveTarget.id === liveActor.id && status === "deactivated") { const error = new Error("You cannot deactivate your own active membership"); error.code = "CANNOT_DEACTIVATE_SELF"; error.status = 409; throw error; }
    if (status === "deactivated") await assertOwnerSafety({ agencyId, targetMember: liveTarget, nextRoleKey: null, removing: true, db: tx });
    if (status === "deactivated" && isOwner(liveTarget)) {
      await requireOwnerPossessionForCryptoDestructiveTeamMutation({
        tx, agencyId, actorUserId: actorId, liveActor, actorDeviceId, actorProof,
      });
    }
    await tx.agencyMember.update({ where: { id: liveTarget.id }, data: { deactivatedAt } });
    if (status === "deactivated") {
      await revokeOwnerRootAccessForMember({ db: tx, agencyId, userId: liveTarget.userId, revokedAt: deactivatedAt });
      await tx.refreshSession.updateMany({
        where: { userId: liveTarget.userId, agencyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
  });
  await audit({
    agencyId,
    actorUserId: actorId,
    action: status === "deactivated" ? "team.member.deactivated" : "team.member.reactivated",
    targetType: "agency_member",
    targetId: target.id,
    metadata: { actorMemberId: actorMember?.id || null, roleKey: memberRoleKey(target) },
    db,
  });
  return { id: target.id, status, deactivatedAt };
}

async function removeMember({ agencyId, memberId, actorMember, actorUserId: actorId, actorDeviceId = null, actorProof = null, db = prisma }) {
  const target = await db.agencyMember.findFirst({ where: { id: memberId, agencyId, deletedAt: null } });
  if (!target) {
    const error = new Error("Member not found");
    error.code = "MEMBER_NOT_FOUND";
    error.status = 404;
    throw error;
  }
  assertActorCanManageMember({ actorMember, targetMember: target });
  if (target.id === actorMember?.id) {
    const error = new Error("You cannot remove your own membership");
    error.code = "CANNOT_REMOVE_SELF";
    error.status = 409;
    throw error;
  }
  await assertOwnerSafety({ agencyId, targetMember: target, nextRoleKey: null, removing: true, db });
  const deletedAt = new Date();
  await serializableTeamTransaction(db, async (tx) => {
    const liveActor = requireLiveTeamActor(await tx.agencyMember.findFirst({ where: { id: actorMember?.id, agencyId, deletedAt: null } }));
    const liveTarget = await tx.agencyMember.findFirst({ where: { id: target.id, agencyId, deletedAt: null } });
    if (!liveTarget) { const error = new Error("Member not found"); error.code = "MEMBER_NOT_FOUND"; error.status = 404; throw error; }
    assertActorCanManageMember({ actorMember: liveActor, targetMember: liveTarget });
    if (liveTarget.id === liveActor.id) { const error = new Error("You cannot remove your own membership"); error.code = "CANNOT_REMOVE_SELF"; error.status = 409; throw error; }
    await assertOwnerSafety({ agencyId, targetMember: liveTarget, nextRoleKey: null, removing: true, db: tx });
    if (isOwner(liveTarget)) {
      await requireOwnerPossessionForCryptoDestructiveTeamMutation({
        tx, agencyId, actorUserId: actorId, liveActor, actorDeviceId, actorProof,
      });
    }
    await tx.agencyMember.update({ where: { id: liveTarget.id }, data: { deletedAt, deactivatedAt: deletedAt } });
    await revokeOwnerRootAccessForMember({ db: tx, agencyId, userId: liveTarget.userId, revokedAt: deletedAt });
    await tx.refreshSession.updateMany({ where: { userId: liveTarget.userId, agencyId, revokedAt: null }, data: { revokedAt: deletedAt } });
  });
  await audit({
    agencyId,
    actorUserId: actorId,
    action: "team.member.removed",
    targetType: "agency_member",
    targetId: target.id,
    metadata: { actorMemberId: actorMember?.id || null, roleKey: memberRoleKey(target), historicalAttributionPreserved: true },
    db,
  });
  return { id: target.id, deletedAt };
}

function invitationUrl(rawToken) {
  const baseUrl = String(process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  return baseUrl ? `${baseUrl}/invite/${rawToken}` : `/invite/${rawToken}`;
}

async function createInvitation({ agencyId, input, actorMember, actorUserId: actorId, db = prisma }) {
  const roleKey = await ensureRoleExists({ agencyId, roleKey: input.roleKey, db });
  if (roleKey === "owner") {
    const error = new Error("Cannot invite as owner. Promote after the member joins.");
    error.code = "CANNOT_INVITE_OWNER";
    error.status = 409;
    throw error;
  }
  await assertActorCanAssignRole({ agencyId, actorMember, roleKey, db });
  const creatorScope = await validateAssignedCreators({ agencyId, assignedCreators: input.assignedCreators ?? { mode: "scoped", creatorIds: [] }, db });
  if (!creatorScope.ok) {
    const error = new Error(`Unknown creator scope: ${creatorScope.unknownCreatorIds.join(", ")}`);
    error.code = creatorScope.code;
    error.status = 400;
    throw error;
  }
  assertActorCanGrantCreatorScope({ actorMember, assignedCreators: creatorScope.value });
  const functions = cleanFunctions(input.functions);
  const rawToken = newToken(24);
  const expiresInDays = Math.max(1, Math.min(60, Number(input.expiresInDays) || 14));
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
  const created = await db.agencyInvitation.create({
    data: {
      agencyId,
      tokenHash: sha256(rawToken),
      email: input.email || null,
      roleKey,
      displayName: input.displayName || null,
      assignedCreators: creatorScope.value,
      functions,
      commission: input.commission || null,
      invitedByUserId: actorId,
      expiresAt,
    },
    include: { invitedBy: { select: { id: true, email: true, name: true } } },
  });
  await audit({
    agencyId,
    actorUserId: actorId,
    action: "team.invitation.created",
    targetType: "agency_invitation",
    targetId: created.id,
    metadata: { actorMemberId: actorMember?.id || null, email: created.email, roleKey, functions, creatorAccess: normalizeAssignedCreators(created.assignedCreators), expiresAt },
    db,
  });
  return { invitation: invitationToClient(created), url: invitationUrl(rawToken), token: rawToken };
}

async function reissueInvitation({ agencyId, invitationId, expiresInDays = 14, actorMember, actorUserId: actorId, db = prisma }) {
  const inv = await db.agencyInvitation.findFirst({ where: { id: invitationId, agencyId } });
  if (!inv) {
    const error = new Error("Invitation not found");
    error.code = "INVITE_NOT_FOUND";
    error.status = 404;
    throw error;
  }
  if (inv.claimedAt) {
    const error = new Error("Claimed invitations cannot be reissued");
    error.code = "INVITE_CLAIMED";
    error.status = 409;
    throw error;
  }
  if (String(inv.roleKey || "").trim().toLowerCase() === "owner") {
    const error = new Error("Owner invitations are not allowed. Promote an active member instead.");
    error.code = "CANNOT_INVITE_OWNER";
    error.status = 409;
    throw error;
  }
  await assertActorCanAssignRole({ agencyId, actorMember, roleKey: inv.roleKey, db });
  assertActorCanGrantCreatorScope({ actorMember, assignedCreators: inv.assignedCreators });
  const rawToken = newToken(24);
  const days = Math.max(1, Math.min(60, Number(expiresInDays) || 14));
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const updated = await db.agencyInvitation.update({
    where: { id: inv.id },
    data: { tokenHash: sha256(rawToken), revokedAt: null, expiresAt },
    include: { invitedBy: { select: { id: true, email: true, name: true } } },
  });
  await audit({
    agencyId,
    actorUserId: actorId,
    action: "team.invitation.reissued",
    targetType: "agency_invitation",
    targetId: inv.id,
    metadata: { actorMemberId: actorMember?.id || null, email: inv.email, roleKey: inv.roleKey, expiresAt },
    db,
  });
  return { invitation: invitationToClient(updated), url: invitationUrl(rawToken), token: rawToken };
}

async function revokeInvitation({ agencyId, invitationId, actorMember, actorUserId: actorId, db = prisma }) {
  const inv = await db.agencyInvitation.findFirst({ where: { id: invitationId, agencyId } });
  if (!inv) {
    const error = new Error("Invitation not found");
    error.code = "INVITE_NOT_FOUND";
    error.status = 404;
    throw error;
  }
  if (inv.claimedAt) {
    const error = new Error("Claimed invitations cannot be revoked");
    error.code = "INVITE_CLAIMED";
    error.status = 409;
    throw error;
  }
  assertActorCanGrantCreatorScope({ actorMember, assignedCreators: inv.assignedCreators });
  const revokedAt = new Date();
  await db.agencyInvitation.update({ where: { id: inv.id }, data: { revokedAt } });
  await audit({
    agencyId,
    actorUserId: actorId,
    action: "team.invitation.revoked",
    targetType: "agency_invitation",
    targetId: inv.id,
    metadata: { actorMemberId: actorMember?.id || null, email: inv.email, roleKey: inv.roleKey },
    db,
  });
  return { id: inv.id, revokedAt };
}

async function createCustomRole({ agencyId, input, actorMember, actorUserId: actorId, db = prisma }) {
  const sourceKey = await ensureRoleExists({ agencyId, roleKey: input.basedOn || "chatter", db });
  if (sourceKey === "owner") {
    const error = new Error("Owner cannot be duplicated");
    error.code = "OWNER_ROLE_LOCKED";
    error.status = 409;
    throw error;
  }
  const source = await resolveRoleDefinition({ agencyId, roleKey: sourceKey, db });
  const actorPermissions = await resolveEffectivePermissions({ member: actorMember, db });
  assertRoleConfigurationWithinActor({ actorMember, actorPermissions, role: source });
  const slug = String(input.label || "custom")
    .trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 36) || "custom";
  const key = `custom_${slug}_${crypto.randomBytes(3).toString("hex")}`;
  const created = await db.$transaction(async (tx) => {
    const role = await tx.agencyCustomRole.create({
      data: {
        agencyId,
        key,
        label: String(input.label).trim(),
        tone: input.tone || source.tone || "amber",
        description: input.description || `Based on ${source.label}`,
        access: source.access,
        basedOn: sourceKey,
        createdByUserId: actorId,
      },
    });
    const explicit = Object.entries(source.permissionDetails || {})
      .filter(([permissionKey, detail]) => PUBLIC_PERMISSION_KEY_SET.has(permissionKey) && detail.source !== "zone")
      .map(([subPermKey, detail]) => ({ agencyId, roleKey: key, subPermKey, value: detail.value === true }));
    if (explicit.length) await tx.agencySubPermissionOverride.createMany({ data: explicit, skipDuplicates: true });
    return role;
  });
  await audit({
    agencyId,
    actorUserId: actorId,
    action: "team.role.created",
    targetType: "team_role",
    targetId: key,
    metadata: { actorMemberId: actorMember?.id || null, label: created.label, basedOn: sourceKey },
    db,
  });
  return resolveRoleDefinition({ agencyId, roleKey: key, db });
}

async function updateRoleMetadata({ agencyId, roleKey, input, actorMember, actorUserId: actorId, db = prisma }) {
  const key = String(roleKey || "").trim().toLowerCase();
  if (PRESET_ROLE_SET.has(key)) {
    const error = new Error("Preset role metadata is locked");
    error.code = "PRESET_ROLE_METADATA_LOCKED";
    error.status = 409;
    throw error;
  }
  const existing = await db.agencyCustomRole.findUnique({ where: { agencyId_key: { agencyId, key } } });
  if (!existing) {
    const error = new Error("Custom role not found");
    error.code = "ROLE_NOT_FOUND";
    error.status = 404;
    throw error;
  }
  await db.agencyCustomRole.update({
    where: { id: existing.id },
    data: {
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.description !== undefined ? { description: input.description || null } : {}),
      ...(input.tone !== undefined ? { tone: input.tone || null } : {}),
    },
  });
  await audit({ agencyId, actorUserId: actorId, action: "team.role.updated", targetType: "team_role", targetId: key, metadata: { actorMemberId: actorMember?.id || null }, db });
  return resolveRoleDefinition({ agencyId, roleKey: key, db });
}

async function setRoleAccess({ agencyId, roleKey, zoneKey, levelKey, actorMember, actorUserId: actorId, db = prisma }) {
  const key = await ensureRoleExists({ agencyId, roleKey, db });
  if (key === "owner") {
    const error = new Error("Owner role is locked");
    error.code = "ROLE_LOCKED";
    error.status = 409;
    throw error;
  }
  const zones = new Map(publicPermissionZones().map((zone) => [zone.key, zone]));
  const zone = zones.get(String(zoneKey || ""));
  if (!zone || !zone.levels.includes(String(levelKey || "").toLowerCase())) {
    const error = new Error("Unknown role zone or access level");
    error.code = "INVALID_ROLE_ACCESS";
    error.status = 400;
    throw error;
  }
  const level = String(levelKey).toLowerCase();
  const actorPermissions = await resolveEffectivePermissions({ member: actorMember, db });
  const role = await db.$transaction(async (tx) => {
    const custom = await tx.agencyCustomRole.findUnique({ where: { agencyId_key: { agencyId, key } } });
    if (custom) {
      await tx.agencyCustomRole.update({ where: { id: custom.id }, data: { access: { ...custom.access, [zone.key]: level } } });
    } else {
      const existing = await tx.agencyRoleOverride.findUnique({ where: { agencyId_roleKey: { agencyId, roleKey: key } } });
      await tx.agencyRoleOverride.upsert({
        where: { agencyId_roleKey: { agencyId, roleKey: key } },
        update: { access: { ...(existing?.access || {}), [zone.key]: level } },
        create: { agencyId, roleKey: key, access: { [zone.key]: level } },
      });
    }
    const nextRole = await resolveRoleDefinition({ agencyId, roleKey: key, db: tx });
    assertRoleConfigurationWithinActor({ actorMember, actorPermissions, role: nextRole });
    return nextRole;
  });
  await audit({ agencyId, actorUserId: actorId, action: "team.role.access_changed", targetType: "team_role", targetId: key, metadata: { actorMemberId: actorMember?.id || null, zoneKey: zone.key, level }, db });
  return role;
}

async function setRolePermission({ agencyId, roleKey, permissionKey, value, actorMember, actorUserId: actorId, db = prisma }) {
  const key = await ensureRoleExists({ agencyId, roleKey, db });
  if (key === "owner") {
    const error = new Error("Owner role is locked");
    error.code = "ROLE_LOCKED";
    error.status = 409;
    throw error;
  }
  if (!PERMISSION_BY_KEY.has(permissionKey) || !PUBLIC_PERMISSION_KEY_SET.has(permissionKey)) {
    const error = new Error(`Permission is not editable in Team Administration: ${permissionKey}`);
    error.code = "PERMISSION_NOT_EDITABLE";
    error.status = 400;
    throw error;
  }
  const actorPermissions = await resolveEffectivePermissions({ member: actorMember, db });
  const role = await db.$transaction(async (tx) => {
    if (value === null) {
      await tx.agencySubPermissionOverride.deleteMany({ where: { agencyId, roleKey: key, subPermKey: permissionKey } });
    } else {
      await tx.agencySubPermissionOverride.upsert({
        where: { agencyId_roleKey_subPermKey: { agencyId, roleKey: key, subPermKey: permissionKey } },
        update: { value: Boolean(value) },
        create: { agencyId, roleKey: key, subPermKey: permissionKey, value: Boolean(value) },
      });
    }
    const nextRole = await resolveRoleDefinition({ agencyId, roleKey: key, db: tx });
    assertRoleConfigurationWithinActor({ actorMember, actorPermissions, role: nextRole });
    return nextRole;
  });
  await audit({ agencyId, actorUserId: actorId, action: "team.role.permission_changed", targetType: "team_role", targetId: key, metadata: { actorMemberId: actorMember?.id || null, permissionKey, value }, db });
  return role;
}

async function resetRole({ agencyId, roleKey, actorMember, actorUserId: actorId, db = prisma }) {
  const key = await ensureRoleExists({ agencyId, roleKey, db });
  if (key === "owner") {
    const error = new Error("Owner role is locked");
    error.code = "ROLE_LOCKED";
    error.status = 409;
    throw error;
  }
  if (!PRESET_ROLE_SET.has(key)) {
    const error = new Error("Only preset roles can be reset; edit or delete custom roles instead");
    error.code = "CUSTOM_ROLE_RESET_UNSUPPORTED";
    error.status = 409;
    throw error;
  }
  const actorPermissions = await resolveEffectivePermissions({ member: actorMember, db });
  const role = await db.$transaction(async (tx) => {
    const publicAccessZones = publicPermissionZones().filter((zone) => zone.levels.length > 0).map((zone) => zone.key);
    const existingAccessOverride = await tx.agencyRoleOverride.findUnique({
      where: { agencyId_roleKey: { agencyId, roleKey: key } },
    });
    if (existingAccessOverride) {
      const preservedAccess = { ...(existingAccessOverride.access || {}) };
      for (const zoneKey of publicAccessZones) delete preservedAccess[zoneKey];
      if (Object.keys(preservedAccess).length) {
        await tx.agencyRoleOverride.update({ where: { id: existingAccessOverride.id }, data: { access: preservedAccess } });
      } else {
        await tx.agencyRoleOverride.delete({ where: { id: existingAccessOverride.id } });
      }
    }
    await tx.agencySubPermissionOverride.deleteMany({
      where: { agencyId, roleKey: key, subPermKey: { in: [...PUBLIC_PERMISSION_KEYS] } },
    });
    const nextRole = await resolveRoleDefinition({ agencyId, roleKey: key, db: tx });
    assertRoleConfigurationWithinActor({ actorMember, actorPermissions, role: nextRole });
    return nextRole;
  });
  await audit({ agencyId, actorUserId: actorId, action: "team.role.reset", targetType: "team_role", targetId: key, metadata: { actorMemberId: actorMember?.id || null }, db });
  return role;
}

async function deleteCustomRole({ agencyId, roleKey, actorMember, actorUserId: actorId, db = prisma }) {
  const key = String(roleKey || "").trim().toLowerCase();
  if (PRESET_ROLE_SET.has(key)) {
    const error = new Error("Preset roles cannot be deleted");
    error.code = "NOT_A_CUSTOM_ROLE";
    error.status = 409;
    throw error;
  }
  const custom = await db.agencyCustomRole.findUnique({ where: { agencyId_key: { agencyId, key } } });
  if (!custom) {
    const error = new Error("Custom role not found");
    error.code = "ROLE_NOT_FOUND";
    error.status = 404;
    throw error;
  }
  const [memberCount, inviteCount] = await Promise.all([
    db.agencyMember.count({ where: { agencyId, deletedAt: null, roleKey: key } }),
    db.agencyInvitation.count({ where: { agencyId, roleKey: key, claimedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } }),
  ]);
  if (memberCount || inviteCount) {
    const error = new Error("Reassign members and revoke pending invitations before deleting this role");
    error.code = "ROLE_IN_USE";
    error.status = 409;
    error.details = { memberCount, inviteCount };
    throw error;
  }
  await db.$transaction([
    db.agencySubPermissionOverride.deleteMany({ where: { agencyId, roleKey: key } }),
    db.agencyCustomRole.delete({ where: { id: custom.id } }),
  ]);
  await audit({ agencyId, actorUserId: actorId, action: "team.role.deleted", targetType: "team_role", targetId: key, metadata: { actorMemberId: actorMember?.id || null, label: custom.label }, db });
  return { key };
}

module.exports = {
  TEAM_FUNCTION_KEYS,
  PRESET_ROLE_KEYS,
  roleKeyToLegacy,
  actorUserId,
  actorMemberId,
  cleanFunctions,
  assertActorCanGrantCreatorScope,
  assertActorCanManageMember,
  assertActorCanAssignRole,
  assertRoleConfigurationWithinActor,
  memberToClient,
  invitationToClient,
  roleExists,
  ensureRoleExists,
  getTeamAdministrationState,
  updateMemberSettings,
  setMemberStatus,
  removeMember,
  createInvitation,
  reissueInvitation,
  revokeInvitation,
  createCustomRole,
  updateRoleMetadata,
  setRoleAccess,
  setRolePermission,
  resetRole,
  deleteCustomRole,
  resolveEffectivePermissions,
};

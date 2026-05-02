/* src/routes/team.js
   ────────────────────────────────────────────────────────────
   Team / Roles / Members / Invitations API.
   
   Mounted at /api/team in server.js.
   
   All routes require an authenticated USER (not admin) — the
   existing requireUser middleware that populates req.user must
   run before this router.
   
   ────────────────────────────────────────────────────────────
   ROUTES OVERVIEW
   
   GET    /state?agencyId=X
       → Full team state for renderer hydration. Returns the
         exact shape stored in localStorage("onlinod.teamAnalytics.v1")
         so the renderer state module can plug it in unchanged.
   
   PATCH  /roles/:roleKey/access
   POST   /roles/:roleKey/reset
   POST   /roles/duplicate
   DELETE /roles/:roleKey
   PATCH  /roles/:roleKey/sub/:subPermKey
   
   POST   /members
   PATCH  /members/:memberId
   DELETE /members/:memberId
   PATCH  /members/:memberId/role
   
   POST   /invitations
   GET    /invitations?agencyId=X
   DELETE /invitations/:id
   
   PUBLIC (no auth, but token-gated):
   GET    /invitations/preview/:token   → see what you're joining
   POST   /invitations/claim            → accept invitation (auth required)
   ────────────────────────────────────────────────────────────
*/

"use strict";

const express = require("express");
const crypto  = require("node:crypto");
const { z }   = require("zod");
const prisma  = require("../prisma");

const {
  teamReadRequired,
  teamWriteRequired,
  rolesWriteRequired,
} = require("../middleware/team-permissions");

const router = express.Router();


// ════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function newToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function validationError(res, err) {
  return res.status(400).json({
    ok: false,
    code: "VALIDATION_ERROR",
    error: err.issues?.[0]?.message || "Validation error",
    issues: err.issues || [],
  });
}

function actorUserId(req) {
  return req.auth?.userId || actorUserId(req);
}

// Map an AgencyMember row to the shape the renderer expects.
function memberToClient(m) {
  return {
    id: m.id,
    userId: m.userId,
    name: m.displayName || m.user?.name || m.user?.email || "member",
    email: m.user?.email || null,
    initials:
      m.initials ||
      String(m.displayName || m.user?.name || m.user?.email || "??")
        .trim()
        .slice(0, 2)
        .toUpperCase(),
    tone: m.tone || "amber",
    role: m.roleKey || legacyRoleToKey(m.role),
    legacyRole: m.role,
    assignedCreators: m.assignedCreators ?? "all",
    commission: m.commission || { kind: "none" },
    statusBadge: m.statusBadge || null,
    lastSeenLabel: m.lastSeenLabel || null,
    isTest: !!m.isTest,
    deletedAt: m.deletedAt || null,
    createdAt: m.createdAt,
  };
}

function legacyRoleToKey(role) {
  const r = String(role || "").toUpperCase();
  if (r === "OWNER")    return "owner";
  if (r === "ADMIN")    return "manager";
  if (r === "MANAGER")  return "manager";
  if (r === "OPERATOR") return "chatter";
  return "chatter";
}

// Convert a roleKey back to a legacy enum value so the old `role`
// column stays in sync. We don't lose info here — roleKey is the
// authoritative one.
function roleKeyToLegacy(roleKey) {
  const k = String(roleKey || "").toLowerCase();
  if (k === "owner")      return "OWNER";
  if (k === "manager")    return "MANAGER";
  if (k === "supervisor") return "MANAGER";
  if (k === "analyst")    return "OPERATOR";
  if (k === "chatter")    return "OPERATOR";
  // Custom role → fall back to OPERATOR (least-privileged).
  return "OPERATOR";
}


// ════════════════════════════════════════════════════════════
// GET /state — single fetch endpoint for renderer hydration
// ════════════════════════════════════════════════════════════

router.get("/state", teamReadRequired(), async (req, res) => {
  try {
    const agencyId = req.agencyId;

    const [members, customRoles, roleOverrides, subOverrides, pendingInvitations] = await Promise.all([
      prisma.agencyMember.findMany({
        where: { agencyId, deletedAt: null },
        include: { user: true },
        orderBy: { createdAt: "asc" },
      }),
      prisma.agencyCustomRole.findMany({
        where: { agencyId },
        orderBy: { createdAt: "asc" },
      }),
      prisma.agencyRoleOverride.findMany({
        where: { agencyId },
      }),
      prisma.agencySubPermissionOverride.findMany({
        where: { agencyId },
      }),
      prisma.agencyInvitation.findMany({
        where: { agencyId, claimedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    // Reshape into the structure that
    // window.OnlinodTeamAnalyticsState.loadPersisted() expects.
    const roleOverridesMap = {};
    for (const ro of roleOverrides) {
      roleOverridesMap[ro.roleKey] = { access: ro.access || {} };
    }

    const subPermissionOverrides = {};
    for (const sp of subOverrides) {
      if (!subPermissionOverrides[sp.roleKey]) subPermissionOverrides[sp.roleKey] = {};
      subPermissionOverrides[sp.roleKey][sp.subPermKey] = sp.value;
    }

    const memberRoleAssignments = {};
    for (const m of members) {
      if (m.roleKey) memberRoleAssignments[m.id] = m.roleKey;
    }

    return res.json({
      ok: true,
      agencyId,
      meMemberId: req.agencyMember.id,
      members: members.map(memberToClient),
      customRoles: customRoles.map((c) => ({
        key: c.key,
        label: c.label,
        tone: c.tone || "amber",
        locked: false,
        description: c.description || "Custom role",
        access: c.access || {},
        basedOn: c.basedOn,
        createdAt: c.createdAt,
      })),
      roleOverrides: roleOverridesMap,
      subPermissionOverrides,
      memberRoleAssignments,
      pendingInvitations: pendingInvitations.map((inv) => ({
        id: inv.id,
        email: inv.email,
        roleKey: inv.roleKey,
        displayName: inv.displayName,
        assignedCreators: inv.assignedCreators,
        commission: inv.commission,
        expiresAt: inv.expiresAt,
        createdAt: inv.createdAt,
      })),
    });
  } catch (err) {
    console.error("[team/state] failed:", err);
    return res.status(500).json({ ok: false, code: "TEAM_STATE_FAILED", error: err?.message || "Failed" });
  }
});


// ════════════════════════════════════════════════════════════
// ROLES — write endpoints
// ════════════════════════════════════════════════════════════

const accessSchema = z.object({
  zoneKey:   z.string().min(1),
  levelKey:  z.string().min(1),
  agencyId:  z.string().min(1),
});

router.patch("/roles/:roleKey/access", rolesWriteRequired(), async (req, res) => {
  try {
    const input = accessSchema.parse({
      zoneKey:  req.body?.zoneKey,
      levelKey: req.body?.levelKey,
      agencyId: req.agencyId,
    });
    const roleKey = req.params.roleKey;

    if (roleKey === "owner") {
      return res.status(409).json({
        ok: false,
        code: "ROLE_LOCKED",
        error: "owner is locked and cannot be modified",
      });
    }

    // Custom role → mutate row directly. Preset → upsert override.
    const custom = await prisma.agencyCustomRole.findUnique({
      where: { agencyId_key: { agencyId: req.agencyId, key: roleKey } },
    });

    if (custom) {
      const access = { ...(custom.access || {}), [input.zoneKey]: input.levelKey };
      const updated = await prisma.agencyCustomRole.update({
        where: { id: custom.id },
        data: { access, updatedAt: new Date() },
      });
      return res.json({ ok: true, role: { key: updated.key, access: updated.access } });
    }

    const existing = await prisma.agencyRoleOverride.findUnique({
      where: { agencyId_roleKey: { agencyId: req.agencyId, roleKey } },
    });

    const access = { ...(existing?.access || {}), [input.zoneKey]: input.levelKey };
    const upserted = await prisma.agencyRoleOverride.upsert({
      where: { agencyId_roleKey: { agencyId: req.agencyId, roleKey } },
      update: { access, updatedAt: new Date() },
      create: { agencyId: req.agencyId, roleKey, access },
    });

    return res.json({ ok: true, override: { roleKey, access: upserted.access } });
  } catch (err) {
    if (err?.issues) return validationError(res, err);
    return res.status(500).json({ ok: false, code: "ROLE_ACCESS_FAILED", error: err?.message || "Failed" });
  }
});

router.post("/roles/:roleKey/reset", rolesWriteRequired(), async (req, res) => {
  try {
    const roleKey = req.params.roleKey;

    await prisma.agencyRoleOverride.deleteMany({
      where: { agencyId: req.agencyId, roleKey },
    });
    await prisma.agencySubPermissionOverride.deleteMany({
      where: { agencyId: req.agencyId, roleKey },
    });

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "ROLE_RESET_FAILED", error: err?.message || "Failed" });
  }
});

const duplicateSchema = z.object({
  agencyId:    z.string().min(1),
  sourceKey:   z.string().min(1),
  newLabel:    z.string().min(1).max(80).optional(),
});

router.post("/roles/duplicate", rolesWriteRequired(), async (req, res) => {
  try {
    const input = duplicateSchema.parse({ ...req.body, agencyId: req.agencyId });

    const newKey = `custom_${Date.now()}_${crypto.randomBytes(2).toString("hex")}`;

    // We don't know preset access on the backend (renderer holds presets in
    // constants). The renderer is responsible for sending us the access
    // object to start with — fall back to empty if not given.
    const sourceAccess = req.body?.sourceAccess || {};

    const created = await prisma.agencyCustomRole.create({
      data: {
        agencyId: req.agencyId,
        key: newKey,
        label: input.newLabel || `${input.sourceKey} copy`,
        tone: req.body?.tone || "amber",
        description: `Duplicated from ${input.sourceKey}`,
        access: sourceAccess,
        basedOn: input.sourceKey,
        createdByUserId: actorUserId(req),
      },
    });

    return res.status(201).json({
      ok: true,
      role: {
        key: created.key,
        label: created.label,
        tone: created.tone,
        locked: false,
        description: created.description,
        access: created.access,
        basedOn: created.basedOn,
      },
    });
  } catch (err) {
    if (err?.issues) return validationError(res, err);
    return res.status(500).json({ ok: false, code: "ROLE_DUPLICATE_FAILED", error: err?.message || "Failed" });
  }
});

router.delete("/roles/:roleKey", rolesWriteRequired(), async (req, res) => {
  try {
    const roleKey = req.params.roleKey;

    if (roleKey === "owner") {
      return res.status(409).json({ ok: false, code: "ROLE_LOCKED", error: "owner is locked" });
    }
    if (!roleKey.startsWith("custom_")) {
      return res.status(409).json({
        ok: false,
        code: "NOT_A_CUSTOM_ROLE",
        error: "Only custom roles can be deleted. Reset preset overrides instead.",
      });
    }

    // Reassign all members on this role to "chatter" before delete.
    await prisma.agencyMember.updateMany({
      where: { agencyId: req.agencyId, roleKey },
      data: { roleKey: "chatter", role: "OPERATOR" },
    });

    await prisma.agencyCustomRole.deleteMany({
      where: { agencyId: req.agencyId, key: roleKey },
    });
    await prisma.agencySubPermissionOverride.deleteMany({
      where: { agencyId: req.agencyId, roleKey },
    });

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "ROLE_DELETE_FAILED", error: err?.message || "Failed" });
  }
});

const subPermSchema = z.object({
  agencyId: z.string().min(1),
  // value=true (explicit on), value=false (explicit off), value=null (auto, removes override)
  value:    z.boolean().nullable(),
});

router.patch("/roles/:roleKey/sub/:subPermKey", rolesWriteRequired(), async (req, res) => {
  try {
    const input = subPermSchema.parse({ agencyId: req.agencyId, value: req.body?.value });
    const { roleKey, subPermKey } = req.params;

    if (roleKey === "owner") {
      return res.status(409).json({ ok: false, code: "ROLE_LOCKED", error: "owner is locked" });
    }

    if (input.value === null) {
      await prisma.agencySubPermissionOverride.deleteMany({
        where: { agencyId: req.agencyId, roleKey, subPermKey },
      });
      return res.json({ ok: true, override: null });
    }

    const upserted = await prisma.agencySubPermissionOverride.upsert({
      where: {
        agencyId_roleKey_subPermKey: {
          agencyId: req.agencyId,
          roleKey,
          subPermKey,
        },
      },
      update: { value: input.value, updatedAt: new Date() },
      create: { agencyId: req.agencyId, roleKey, subPermKey, value: input.value },
    });

    return res.json({ ok: true, override: { roleKey, subPermKey, value: upserted.value } });
  } catch (err) {
    if (err?.issues) return validationError(res, err);
    return res.status(500).json({ ok: false, code: "SUBPERM_FAILED", error: err?.message || "Failed" });
  }
});


// ════════════════════════════════════════════════════════════
// MEMBERS — write endpoints
// ════════════════════════════════════════════════════════════

const memberPatchSchema = z.object({
  agencyId:         z.string().min(1),
  displayName:      z.string().min(1).max(120).optional(),
  initials:         z.string().max(4).optional().nullable(),
  tone:             z.string().max(40).optional().nullable(),
  commission:       z.any().optional(),
  assignedCreators: z.any().optional(),  // "all" or string[]
  statusBadge:      z.any().optional().nullable(),
  lastSeenLabel:    z.string().max(120).optional().nullable(),
});

router.patch("/members/:memberId", teamWriteRequired(), async (req, res) => {
  try {
    const input = memberPatchSchema.parse({ ...req.body, agencyId: req.agencyId });

    const member = await prisma.agencyMember.findUnique({
      where: { id: req.params.memberId },
    });
    if (!member || member.agencyId !== req.agencyId) {
      return res.status(404).json({ ok: false, code: "MEMBER_NOT_FOUND", error: "Member not found in this agency" });
    }

    const data = {};
    for (const k of [
      "displayName", "initials", "tone", "commission",
      "assignedCreators", "statusBadge", "lastSeenLabel",
    ]) {
      if (input[k] !== undefined) data[k] = input[k];
    }

    const updated = await prisma.agencyMember.update({
      where: { id: member.id },
      data,
      include: { user: true },
    });

    return res.json({ ok: true, member: memberToClient(updated) });
  } catch (err) {
    if (err?.issues) return validationError(res, err);
    return res.status(500).json({ ok: false, code: "MEMBER_PATCH_FAILED", error: err?.message || "Failed" });
  }
});

router.delete("/members/:memberId", teamWriteRequired(), async (req, res) => {
  try {
    const member = await prisma.agencyMember.findUnique({
      where: { id: req.params.memberId },
    });
    if (!member || member.agencyId !== req.agencyId) {
      return res.status(404).json({ ok: false, code: "MEMBER_NOT_FOUND", error: "Member not found in this agency" });
    }

    // Last-OWNER guard.
    if (member.roleKey === "owner" || member.role === "OWNER") {
      const otherOwners = await prisma.agencyMember.count({
        where: {
          agencyId: req.agencyId,
          deletedAt: null,
          id: { not: member.id },
          OR: [{ roleKey: "owner" }, { role: "OWNER" }],
        },
      });
      if (otherOwners === 0) {
        return res.status(409).json({ ok: false, code: "LAST_OWNER", error: "Cannot remove the last OWNER" });
      }
    }

    // Soft delete + revoke their refresh sessions for this agency.
    await prisma.$transaction([
      prisma.agencyMember.update({
        where: { id: member.id },
        data: { deletedAt: new Date() },
      }),
      prisma.refreshSession.updateMany({
        where: { userId: member.userId, agencyId: req.agencyId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "MEMBER_DELETE_FAILED", error: err?.message || "Failed" });
  }
});

const memberRoleSchema = z.object({
  agencyId: z.string().min(1),
  roleKey:  z.string().min(1).max(80),
});

router.patch("/members/:memberId/role", teamWriteRequired(), async (req, res) => {
  try {
    const input = memberRoleSchema.parse({ ...req.body, agencyId: req.agencyId });

    const member = await prisma.agencyMember.findUnique({
      where: { id: req.params.memberId },
    });
    if (!member || member.agencyId !== req.agencyId) {
      return res.status(404).json({ ok: false, code: "MEMBER_NOT_FOUND", error: "Member not found" });
    }

    // Last-OWNER guard if demoting an owner.
    const isCurrentOwner = member.roleKey === "owner" || member.role === "OWNER";
    if (isCurrentOwner && input.roleKey !== "owner") {
      const otherOwners = await prisma.agencyMember.count({
        where: {
          agencyId: req.agencyId,
          deletedAt: null,
          id: { not: member.id },
          OR: [{ roleKey: "owner" }, { role: "OWNER" }],
        },
      });
      if (otherOwners === 0) {
        return res.status(409).json({ ok: false, code: "LAST_OWNER", error: "Cannot demote the last OWNER" });
      }
    }

    // Validate roleKey: must be a preset or an existing custom role.
    const PRESET_KEYS = new Set(["owner", "manager", "supervisor", "chatter", "analyst"]);
    if (!PRESET_KEYS.has(input.roleKey)) {
      const custom = await prisma.agencyCustomRole.findUnique({
        where: { agencyId_key: { agencyId: req.agencyId, key: input.roleKey } },
      });
      if (!custom) {
        return res.status(400).json({ ok: false, code: "UNKNOWN_ROLE", error: `Unknown roleKey: ${input.roleKey}` });
      }
    }

    const updated = await prisma.agencyMember.update({
      where: { id: member.id },
      data: {
        roleKey: input.roleKey,
        role: roleKeyToLegacy(input.roleKey),
      },
      include: { user: true },
    });

    return res.json({ ok: true, member: memberToClient(updated) });
  } catch (err) {
    if (err?.issues) return validationError(res, err);
    return res.status(500).json({ ok: false, code: "MEMBER_ROLE_FAILED", error: err?.message || "Failed" });
  }
});


// ════════════════════════════════════════════════════════════
// INVITATIONS
// ════════════════════════════════════════════════════════════

const inviteCreateSchema = z.object({
  agencyId:         z.string().min(1),
  email:            z.string().email().optional().nullable(),
  roleKey:          z.string().min(1).max(80),
  displayName:      z.string().max(120).optional().nullable(),
  assignedCreators: z.any().optional(),   // "all" | string[]
  commission:       z.any().optional(),
  expiresInDays:    z.number().int().min(1).max(60).optional(),
});

router.post("/invitations", teamWriteRequired(), async (req, res) => {
  try {
    const input = inviteCreateSchema.parse({ ...req.body, agencyId: req.agencyId });

    // Validate roleKey
    const PRESET_KEYS = new Set(["manager", "supervisor", "chatter", "analyst"]);
    if (input.roleKey !== "owner" && !PRESET_KEYS.has(input.roleKey)) {
      const custom = await prisma.agencyCustomRole.findUnique({
        where: { agencyId_key: { agencyId: req.agencyId, key: input.roleKey } },
      });
      if (!custom) {
        return res.status(400).json({ ok: false, code: "UNKNOWN_ROLE", error: `Unknown roleKey: ${input.roleKey}` });
      }
    }
    if (input.roleKey === "owner") {
      return res.status(409).json({
        ok: false,
        code: "CANNOT_INVITE_OWNER",
        error: "Cannot invite as owner. Promote member after they join instead.",
      });
    }

    const rawToken = newToken(24);
    const expiresInDays = input.expiresInDays || 14;
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

    const created = await prisma.agencyInvitation.create({
      data: {
        agencyId: req.agencyId,
        tokenHash: sha256(rawToken),
        email: input.email || null,
        roleKey: input.roleKey,
        displayName: input.displayName || null,
        assignedCreators: input.assignedCreators ?? "all",
        commission: input.commission || null,
        invitedByUserId: actorUserId(req),
        expiresAt,
      },
    });

    const baseUrl = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
    const url = baseUrl ? `${baseUrl}/invite/${rawToken}` : `/invite/${rawToken}`;

    return res.status(201).json({
      ok: true,
      invitation: {
        id: created.id,
        email: created.email,
        roleKey: created.roleKey,
        displayName: created.displayName,
        assignedCreators: created.assignedCreators,
        commission: created.commission,
        expiresAt: created.expiresAt,
        createdAt: created.createdAt,
      },
      url,
      token: rawToken,  // Returned ONCE — admin copies to clipboard.
    });
  } catch (err) {
    if (err?.issues) return validationError(res, err);
    return res.status(500).json({ ok: false, code: "INVITE_CREATE_FAILED", error: err?.message || "Failed" });
  }
});

router.get("/invitations", teamReadRequired(), async (req, res) => {
  try {
    const includeExpired = req.query.includeExpired === "1";
    const where = { agencyId: req.agencyId };

    if (!includeExpired) {
      where.claimedAt = null;
      where.revokedAt = null;
      where.expiresAt = { gt: new Date() };
    }

    const list = await prisma.agencyInvitation.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: { invitedBy: { select: { id: true, email: true, name: true } } },
    });

    return res.json({
      ok: true,
      invitations: list.map((inv) => ({
        id: inv.id,
        email: inv.email,
        roleKey: inv.roleKey,
        displayName: inv.displayName,
        assignedCreators: inv.assignedCreators,
        commission: inv.commission,
        invitedBy: inv.invitedBy ? { email: inv.invitedBy.email, name: inv.invitedBy.name } : null,
        expiresAt: inv.expiresAt,
        claimedAt: inv.claimedAt,
        revokedAt: inv.revokedAt,
        createdAt: inv.createdAt,
        status:
          inv.claimedAt ? "claimed" :
          inv.revokedAt ? "revoked" :
          inv.expiresAt < new Date() ? "expired" :
          "pending",
      })),
    });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "INVITE_LIST_FAILED", error: err?.message || "Failed" });
  }
});

router.delete("/invitations/:id", teamWriteRequired(), async (req, res) => {
  try {
    const inv = await prisma.agencyInvitation.findUnique({ where: { id: req.params.id } });
    if (!inv || inv.agencyId !== req.agencyId) {
      return res.status(404).json({ ok: false, code: "INVITE_NOT_FOUND", error: "Invitation not found" });
    }
    if (inv.claimedAt) {
      return res.status(409).json({ ok: false, code: "INVITE_CLAIMED", error: "Already claimed" });
    }

    const updated = await prisma.agencyInvitation.update({
      where: { id: inv.id },
      data: { revokedAt: new Date() },
    });

    return res.json({ ok: true, invitation: { id: updated.id, revokedAt: updated.revokedAt } });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "INVITE_REVOKE_FAILED", error: err?.message || "Failed" });
  }
});


module.exports = router;

"use strict";

const express = require("express");
const { z } = require("zod");
const {
  teamReadRequired,
  teamWriteRequired,
  rolesWriteRequired,
} = require("../middleware/team-permissions");
const {
  actorUserId,
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
} = require("../services/team-administration-service");

const router = express.Router();

// Kept explicit for the provenance contract and older static regression tests.
const TEAM_FUNCTION_KEYS = Object.freeze(["CHATTER", "CONTENT", "SUPERVISOR"]);

const functionSchema = z.enum(TEAM_FUNCTION_KEYS);
const creatorAccessSchema = z.union([
  z.literal("all"),
  z.array(z.string().min(1)).max(10000),
  z.object({ mode: z.enum(["all", "scoped"]), creatorIds: z.array(z.string().min(1)).max(10000).default([]) }),
]);
const memberSettingsSchema = z.object({
  displayName: z.string().trim().min(1).max(120).nullable().optional(),
  roleKey: z.string().trim().min(1).max(100).optional(),
  functions: z.array(functionSchema).max(TEAM_FUNCTION_KEYS.length).optional(),
  assignedCreators: creatorAccessSchema.optional(),
}).strict();
const memberStatusSchema = z.object({ status: z.enum(["active", "deactivated"]) }).strict();
const invitationSchema = z.object({
  email: z.string().trim().email().max(254).nullable().optional(),
  displayName: z.string().trim().min(1).max(120).nullable().optional(),
  roleKey: z.string().trim().min(1).max(100).default("chatter"),
  functions: z.array(functionSchema).max(TEAM_FUNCTION_KEYS.length).default([]),
  assignedCreators: creatorAccessSchema.default({ mode: "scoped", creatorIds: [] }),
  commission: z.unknown().nullable().optional(),
  expiresInDays: z.coerce.number().int().min(1).max(60).default(14),
}).strict();
const reissueSchema = z.object({ expiresInDays: z.coerce.number().int().min(1).max(60).default(14) }).strict();
const createRoleSchema = z.object({
  label: z.string().trim().min(1).max(80),
  basedOn: z.string().trim().min(1).max(100).default("chatter"),
  description: z.string().trim().max(280).nullable().optional(),
  tone: z.string().trim().max(40).nullable().optional(),
}).strict();
const updateRoleSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(280).nullable().optional(),
  tone: z.string().trim().max(40).nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, { message: "At least one role field is required" });
const roleAccessSchema = z.object({
  zoneKey: z.string().trim().min(1).max(80),
  levelKey: z.string().trim().min(1).max(40),
}).strict();
const rolePermissionSchema = z.object({ value: z.boolean().nullable() }).strict();

function validationError(res, error) {
  return res.status(400).json({
    ok: false,
    code: "VALIDATION_ERROR",
    error: error.issues?.[0]?.message || "Validation error",
    issues: error.issues || [],
  });
}

function serviceError(res, error, fallbackCode) {
  if (error?.issues) return validationError(res, error);
  const status = Number(error?.status);
  if (Number.isFinite(status) && status >= 400 && status < 600) {
    return res.status(status).json({
      ok: false,
      code: error.code || fallbackCode,
      error: error.message || "Request failed",
      ...(error.details ? { details: error.details } : {}),
    });
  }
  console.error(`[team] ${fallbackCode}:`, error);
  return res.status(500).json({ ok: false, code: fallbackCode, error: "Team administration request failed" });
}

function actor(req) {
  return { actorMember: req.agencyMember, actorUserId: actorUserId(req) };
}

router.get("/state", teamReadRequired("workspace.view_team"), async (req, res) => {
  try {
    const state = await getTeamAdministrationState({
      agencyId: req.agencyId,
      viewerMember: req.agencyMember,
      includeAudit: true,
      auditLimit: req.query?.auditLimit,
    });
    return res.json(state);
  } catch (error) {
    return serviceError(res, error, "TEAM_STATE_FAILED");
  }
});

router.patch("/members/:memberId/settings", teamWriteRequired("workspace.manage_members"), async (req, res) => {
  try {
    const patch = memberSettingsSchema.parse(req.body || {});
    const member = await updateMemberSettings({ agencyId: req.agencyId, memberId: req.params.memberId, patch, ...actor(req) });
    return res.json({ ok: true, member });
  } catch (error) {
    return serviceError(res, error, "TEAM_MEMBER_UPDATE_FAILED");
  }
});

router.patch("/members/:memberId/status", teamWriteRequired("workspace.manage_members"), async (req, res) => {
  try {
    const input = memberStatusSchema.parse(req.body || {});
    const result = await setMemberStatus({ agencyId: req.agencyId, memberId: req.params.memberId, status: input.status, ...actor(req) });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return serviceError(res, error, "TEAM_MEMBER_STATUS_FAILED");
  }
});

// Compatibility endpoint retained for older desktops; V8 uses /settings atomically.
router.patch("/members/:memberId", teamWriteRequired("workspace.manage_members"), async (req, res) => {
  try {
    const patch = memberSettingsSchema.partial().parse(req.body || {});
    const member = await updateMemberSettings({ agencyId: req.agencyId, memberId: req.params.memberId, patch, ...actor(req) });
    return res.json({ ok: true, member });
  } catch (error) {
    return serviceError(res, error, "TEAM_MEMBER_UPDATE_FAILED");
  }
});

// Compatibility endpoint kept deliberately; functions remain explicit and never permission-derived.
router.patch("/members/:memberId/functions", teamWriteRequired("workspace.manage_members"), async (req, res) => {
  try {
    const input = z.object({ functions: z.array(functionSchema).max(TEAM_FUNCTION_KEYS.length) }).strict().parse(req.body || {});
    const member = await updateMemberSettings({ agencyId: req.agencyId, memberId: req.params.memberId, patch: { functions: input.functions }, ...actor(req) });
    return res.json({ ok: true, member });
  } catch (error) {
    return serviceError(res, error, "TEAM_MEMBER_FUNCTIONS_FAILED");
  }
});

router.patch("/members/:memberId/role", teamWriteRequired("workspace.manage_members"), async (req, res) => {
  try {
    const input = z.object({ roleKey: z.string().trim().min(1).max(100) }).strict().parse(req.body || {});
    const member = await updateMemberSettings({ agencyId: req.agencyId, memberId: req.params.memberId, patch: { roleKey: input.roleKey }, ...actor(req) });
    return res.json({ ok: true, member });
  } catch (error) {
    return serviceError(res, error, "TEAM_MEMBER_ROLE_FAILED");
  }
});

router.delete("/members/:memberId", teamWriteRequired("workspace.manage_members"), async (req, res) => {
  try {
    const result = await removeMember({ agencyId: req.agencyId, memberId: req.params.memberId, ...actor(req) });
    return res.json({ ok: true, ...result, historicalAttributionPreserved: true });
  } catch (error) {
    return serviceError(res, error, "TEAM_MEMBER_REMOVE_FAILED");
  }
});

router.post("/invitations", teamWriteRequired("workspace.invite"), async (req, res) => {
  try {
    const input = invitationSchema.parse(req.body || {});
    const result = await createInvitation({ agencyId: req.agencyId, input, ...actor(req) });
    return res.status(201).json({ ok: true, ...result });
  } catch (error) {
    return serviceError(res, error, "TEAM_INVITATION_CREATE_FAILED");
  }
});

router.get("/invitations", teamReadRequired("workspace.view_team"), async (req, res) => {
  try {
    const state = await getTeamAdministrationState({ agencyId: req.agencyId, viewerMember: req.agencyMember, includeAudit: false });
    return res.json({ ok: true, invitations: state.invitations });
  } catch (error) {
    return serviceError(res, error, "TEAM_INVITATIONS_LIST_FAILED");
  }
});

router.post("/invitations/:invitationId/reissue", teamWriteRequired("workspace.invite"), async (req, res) => {
  try {
    const input = reissueSchema.parse(req.body || {});
    const result = await reissueInvitation({ agencyId: req.agencyId, invitationId: req.params.invitationId, expiresInDays: input.expiresInDays, ...actor(req) });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return serviceError(res, error, "TEAM_INVITATION_REISSUE_FAILED");
  }
});

router.delete("/invitations/:invitationId", teamWriteRequired("workspace.invite"), async (req, res) => {
  try {
    const result = await revokeInvitation({ agencyId: req.agencyId, invitationId: req.params.invitationId, ...actor(req) });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return serviceError(res, error, "TEAM_INVITATION_REVOKE_FAILED");
  }
});

router.post("/roles", rolesWriteRequired(), async (req, res) => {
  try {
    const input = createRoleSchema.parse(req.body || {});
    const role = await createCustomRole({ agencyId: req.agencyId, input, ...actor(req) });
    return res.status(201).json({ ok: true, role });
  } catch (error) {
    return serviceError(res, error, "TEAM_ROLE_CREATE_FAILED");
  }
});

router.patch("/roles/:roleKey", rolesWriteRequired(), async (req, res) => {
  try {
    const input = updateRoleSchema.parse(req.body || {});
    const role = await updateRoleMetadata({ agencyId: req.agencyId, roleKey: req.params.roleKey, input, ...actor(req) });
    return res.json({ ok: true, role });
  } catch (error) {
    return serviceError(res, error, "TEAM_ROLE_UPDATE_FAILED");
  }
});

router.patch("/roles/:roleKey/access", rolesWriteRequired(), async (req, res) => {
  try {
    const input = roleAccessSchema.parse(req.body || {});
    const role = await setRoleAccess({ agencyId: req.agencyId, roleKey: req.params.roleKey, zoneKey: input.zoneKey, levelKey: input.levelKey, ...actor(req) });
    return res.json({ ok: true, role });
  } catch (error) {
    return serviceError(res, error, "TEAM_ROLE_ACCESS_FAILED");
  }
});

router.patch("/roles/:roleKey/sub/:subPermKey", rolesWriteRequired(), async (req, res) => {
  try {
    const input = rolePermissionSchema.parse(req.body || {});
    const role = await setRolePermission({ agencyId: req.agencyId, roleKey: req.params.roleKey, permissionKey: req.params.subPermKey, value: input.value, ...actor(req) });
    return res.json({ ok: true, role });
  } catch (error) {
    return serviceError(res, error, "TEAM_ROLE_PERMISSION_FAILED");
  }
});

router.post("/roles/:roleKey/reset", rolesWriteRequired(), async (req, res) => {
  try {
    const role = await resetRole({ agencyId: req.agencyId, roleKey: req.params.roleKey, ...actor(req) });
    return res.json({ ok: true, role });
  } catch (error) {
    return serviceError(res, error, "TEAM_ROLE_RESET_FAILED");
  }
});

// Compatibility with the Alpha-era desktop API; server still owns the cloned permission state.
router.post("/roles/duplicate", rolesWriteRequired(), async (req, res) => {
  try {
    const input = z.object({ sourceKey: z.string().trim().min(1).max(100), newLabel: z.string().trim().min(1).max(80).optional() }).strict().parse(req.body || {});
    const role = await createCustomRole({ agencyId: req.agencyId, input: { basedOn: input.sourceKey, label: input.newLabel || `Copy of ${input.sourceKey}` }, ...actor(req) });
    return res.status(201).json({ ok: true, role });
  } catch (error) {
    return serviceError(res, error, "TEAM_ROLE_DUPLICATE_FAILED");
  }
});

router.delete("/roles/:roleKey", rolesWriteRequired(), async (req, res) => {
  try {
    const result = await deleteCustomRole({ agencyId: req.agencyId, roleKey: req.params.roleKey, ...actor(req) });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return serviceError(res, error, "TEAM_ROLE_DELETE_FAILED");
  }
});

module.exports = router;

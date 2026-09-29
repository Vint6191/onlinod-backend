"use strict";
const { z } = require("zod");
const crypto = require("node:crypto");
// Kept explicit for the provenance contract and older static regression tests.
const TEAM_FUNCTION_KEYS = Object.freeze(["CHATTER", "CONTENT", "SUPERVISOR"]);

const functionSchema = z.enum(TEAM_FUNCTION_KEYS);
const actorProofSchema = z.string().trim().min(1).max(256).optional();
const creatorAccessSchema = z.union([
  z.literal("all"),
  z.array(z.string().trim().min(1).max(180)).max(10000),
  z.object({ mode: z.enum(["all", "scoped"]), creatorIds: z.array(z.string().trim().min(1).max(180)).max(10000).default([]) }),
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


const id = z.string().trim().min(1).max(180);
const empty = z.object({}).strict();
const shift = z.object({
  memberId: id, creatorIds: z.array(id).min(1).max(100),
  startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }),
  timezone: z.string().trim().min(1).max(100).default("UTC"),
  note: z.string().trim().max(500).nullable().optional(),
}).strict();
const ACTIONS = Object.freeze({
  "member.update": memberSettingsSchema,
  "member.status": memberStatusSchema,
  "member.remove": empty,
  "invitation.create": invitationSchema,
  "invitation.reissue": reissueSchema,
  "invitation.revoke": empty,
  "role.create": createRoleSchema,
  "role.update": updateRoleSchema,
  "role.access": roleAccessSchema,
  "role.permission": rolePermissionSchema.extend({ permissionKey: z.string().trim().min(1).max(100) }),
  "role.reset": empty,
  "role.delete": empty,
  "shift.create": shift,
  "shift.update": shift.partial().extend({ expectedRevision: z.number().int().positive() }),
  "shift.cancel": z.object({ expectedRevision: z.number().int().positive(), reason: z.string().trim().max(500).nullable().optional() }).strict(),
});
const envelope = z.object({
  commandId: z.string().uuid(), action: z.enum(Object.keys(ACTIONS)),
  targetId: z.string().trim().max(180).default(""), payload: z.record(z.unknown()).default({}),
  actorProof: actorProofSchema,
}).strict();
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function digest(value) { return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function parseCommand(input) {
  const command = envelope.parse(input);
  command.commandId = command.commandId.toLowerCase();
  command.payload = ACTIONS[command.action].parse(command.payload);
  if (command.action.endsWith(".create") ? command.targetId !== "" : !command.targetId) {
    throw Object.assign(new Error("Command target does not match the action"), { status: 400, code: "TEAM_COMMAND_TARGET_INVALID" });
  }
  const fingerprint = digest({ version: 2, action: command.action, targetId: command.targetId, payload: command.payload });
  return { ...command, fingerprint };
}
function permissionFor(action) {
  return action.startsWith("member.") ? "workspace.manage_members" : action.startsWith("invitation.") ? "workspace.invite" : action.startsWith("role.") ? "workspace.edit_roles" : "workspace.manage_schedule";
}
module.exports = { ACTIONS, parseCommand, digest, permissionFor };

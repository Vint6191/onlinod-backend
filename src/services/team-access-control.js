"use strict";

const TEAM_FUNCTION_KEYS = Object.freeze(["CHATTER", "CONTENT", "SUPERVISOR"]);
const ACCESS_LEVELS = Object.freeze(["hidden", "view", "full"]);
const SCOPE_LEVELS = Object.freeze(["scoped", "all"]);

const ZONES = Object.freeze([
  Object.freeze({
    key: "chats",
    label: "Chats",
    hint: "Fan conversations and message tools",
    kind: "access",
    permissions: Object.freeze([
      Object.freeze({ key: "chats.read", label: "Read fan messages", requiredLevel: "view" }),
      Object.freeze({ key: "chats.reply", label: "Send replies", requiredLevel: "full" }),
      Object.freeze({ key: "chats.mass_message", label: "Mass messages", requiredLevel: "full" }),
      Object.freeze({ key: "chats.schedule", label: "Scheduled sends", requiredLevel: "full" }),
    ]),
  }),
  Object.freeze({
    key: "money",
    label: "Money & claims",
    hint: "Earnings visibility and attribution resolution",
    kind: "access",
    permissions: Object.freeze([
      Object.freeze({ key: "money.view_earnings", label: "View creator earnings", requiredLevel: "view" }),
      Object.freeze({ key: "money.view_attribution", label: "View Team revenue attribution", requiredLevel: "view" }),
      Object.freeze({ key: "money.claim", label: "Claim own eligible tips", requiredLevel: "full" }),
      Object.freeze({ key: "money.release_own_claim", label: "Release own claim", requiredLevel: "full" }),
      Object.freeze({ key: "money.resolve_attribution", label: "Resolve attribution conflicts", requiredLevel: "destructive" }),
      Object.freeze({ key: "money.override_attribution", label: "Override resolved attribution", requiredLevel: "destructive" }),
      Object.freeze({ key: "money.view_audit", label: "View money attribution audit", requiredLevel: "view" }),
    ]),
  }),
  Object.freeze({
    key: "content",
    label: "Content",
    hint: "Vault and content management",
    kind: "access",
    permissions: Object.freeze([
      Object.freeze({ key: "content.manage", label: "Manage creator content", requiredLevel: "full" }),
      Object.freeze({ key: "content.manage_vault", label: "Manage Vault", requiredLevel: "full" }),
      Object.freeze({ key: "message_library.manage", label: "Manage Message Library", requiredLevel: "full" }),
      Object.freeze({ key: "content.delete_posts", label: "Delete published content", requiredLevel: "destructive" }),
    ]),
  }),
  Object.freeze({
    key: "automation",
    label: "Automation",
    hint: "Automation configuration and worker visibility",
    kind: "access",
    permissions: Object.freeze([
      Object.freeze({ key: "automation.view_logs", label: "View automation logs", requiredLevel: "view" }),
      Object.freeze({ key: "automation.manage", label: "Configure automation", requiredLevel: "full" }),
    ]),
  }),
  Object.freeze({
    key: "creators",
    label: "Creator access",
    hint: "Whether the role is intended for scoped or all creators",
    kind: "scope",
    permissions: Object.freeze([
      Object.freeze({ key: "creators.manage", label: "Add, edit and remove creators", requiredLevel: "destructive" }),
    ]),
  }),
  Object.freeze({
    key: "workspace",
    label: "Team & workspace",
    hint: "Team Analytics, members, invitations and roles",
    kind: "access",
    permissions: Object.freeze([
      Object.freeze({ key: "team.analytics.view", label: "View Team Analytics", requiredLevel: "view" }),
      Object.freeze({ key: "workspace.view_team", label: "View members and roles", requiredLevel: "view" }),
      Object.freeze({ key: "workspace.manage_members", label: "Edit members and creator access", requiredLevel: "full" }),
      Object.freeze({ key: "workspace.manage_schedule", label: "Create and edit Team schedule", requiredLevel: "full" }),
      Object.freeze({ key: "workspace.invite", label: "Create and revoke invitations", requiredLevel: "full" }),
      Object.freeze({ key: "workspace.view_audit", label: "View Team administration audit", requiredLevel: "full" }),
      Object.freeze({ key: "workspace.edit_roles", label: "Edit role permissions", requiredLevel: "destructive" }),
    ]),
  }),
]);


const PUBLIC_PERMISSION_KEYS = Object.freeze([
  "money.view_earnings",
  "money.view_attribution",
  "money.claim",
  "money.release_own_claim",
  "money.resolve_attribution",
  "money.override_attribution",
  "money.view_audit",
  "message_library.manage",
  "automation.view_logs",
  "automation.manage",
  "creators.manage",
  "team.analytics.view",
  "workspace.view_team",
  "workspace.manage_members",
  "workspace.manage_schedule",
  "workspace.invite",
  "workspace.view_audit",
  "workspace.edit_roles",
]);
const PUBLIC_PERMISSION_KEY_SET = new Set(PUBLIC_PERMISSION_KEYS);

const PRESET_ROLES = Object.freeze({
  chatter: Object.freeze({
    key: "chatter",
    label: "Chatter",
    tone: "amber",
    description: "Fan conversations and day-to-day chat work.",
    locked: false,
    access: Object.freeze({ chats: "full", money: "hidden", content: "view", automation: "view", creators: "scoped", workspace: "hidden" }),
    permissionDefaults: Object.freeze({
      "money.claim": true,
      "money.release_own_claim": true,
      // Preserve the pre-V8 chatter default while making this permission
      // independently editable in the non-Browser Content zone.
      "message_library.manage": true,
    }),
  }),
  manager: Object.freeze({
    key: "manager",
    label: "Manager",
    tone: "teal",
    description: "Runs the team day-to-day and manages assigned creators.",
    locked: false,
    access: Object.freeze({ chats: "full", money: "view", content: "full", automation: "full", creators: "scoped", workspace: "full" }),
    permissionDefaults: Object.freeze({
      "workspace.edit_roles": false,
      "money.resolve_attribution": true,
      "money.override_attribution": false,
      "creators.manage": true,
    }),
  }),
  supervisor: Object.freeze({
    key: "supervisor",
    label: "Supervisor",
    tone: "purple",
    description: "Quality control and Team Analytics with limited write access.",
    locked: false,
    access: Object.freeze({ chats: "view", money: "view", content: "view", automation: "view", creators: "scoped", workspace: "view" }),
    permissionDefaults: Object.freeze({
      "team.analytics.view": true,
      "money.claim": true,
      "money.release_own_claim": true,
    }),
  }),
  analyst: Object.freeze({
    key: "analyst",
    label: "Analyst",
    tone: "blue",
    description: "Read-only performance and money analysis.",
    locked: false,
    access: Object.freeze({ chats: "hidden", money: "view", content: "hidden", automation: "view", creators: "all", workspace: "view" }),
    permissionDefaults: Object.freeze({
      "workspace.manage_members": false,
      "workspace.invite": false,
      "workspace.view_audit": false,
    }),
  }),
  owner: Object.freeze({
    key: "owner",
    label: "Owner",
    tone: "amber-strong",
    description: "Workspace owner. Full recovery and administration access.",
    locked: true,
    access: Object.freeze({ chats: "full", money: "full", content: "full", automation: "full", creators: "all", workspace: "full" }),
    permissionDefaults: Object.freeze({}),
  }),
});

const ZONE_BY_KEY = new Map(ZONES.map((zone) => [zone.key, zone]));
const PERMISSION_BY_KEY = new Map();
for (const zone of ZONES) {
  for (const permission of zone.permissions) PERMISSION_BY_KEY.set(permission.key, { ...permission, zoneKey: zone.key, zoneKind: zone.kind });
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function memberRoleKey(member) {
  const explicit = String(member?.roleKey || "").trim().toLowerCase();
  if (explicit) return explicit;
  const legacy = String(member?.role || "").trim().toUpperCase();
  if (legacy === "OWNER") return "owner";
  if (legacy === "MANAGER" || legacy === "ADMIN") return "manager";
  return "chatter";
}

function isOwner(member) {
  return String(member?.role || "").toUpperCase() === "OWNER" || memberRoleKey(member) === "owner";
}

function directPermissionValue(permissions, key) {
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) return null;
  if (Object.prototype.hasOwnProperty.call(permissions, key) && typeof permissions[key] === "boolean") return permissions[key];
  const parts = String(key || "").split(".").filter(Boolean);
  let current = permissions;
  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !Object.prototype.hasOwnProperty.call(current, part)) return null;
    current = current[part];
  }
  return typeof current === "boolean" ? current : null;
}

function autoPermissionFromAccess(level, requiredLevel) {
  if (requiredLevel === "destructive") return false;
  if (requiredLevel === "view") return level === "view" || level === "full" || level === "all";
  if (requiredLevel === "full") return level === "full" || level === "all";
  return false;
}

function normalizeAccessValue(zone, value, fallback) {
  const clean = String(value || "").trim().toLowerCase();
  const allowed = zone?.kind === "scope" ? SCOPE_LEVELS : ACCESS_LEVELS;
  return allowed.includes(clean) ? clean : fallback;
}

async function resolveRoleDefinition({ agencyId, roleKey, db = null }) {
  const client = db || require("../prisma");
  const key = String(roleKey || "chatter").trim().toLowerCase() || "chatter";
  const preset = PRESET_ROLES[key] || null;
  const custom = preset ? null : await client.agencyCustomRole.findUnique({
    where: { agencyId_key: { agencyId, key } },
  });

  const base = custom ? {
    key: custom.key,
    label: custom.label,
    tone: custom.tone || "amber",
    description: custom.description || "Custom role",
    locked: false,
    custom: true,
    basedOn: custom.basedOn || null,
    access: object(custom.access),
    permissionDefaults: {},
  } : preset ? {
    ...preset,
    custom: false,
    basedOn: null,
    access: { ...preset.access },
    permissionDefaults: { ...preset.permissionDefaults },
  } : {
    ...PRESET_ROLES.chatter,
    key,
    label: key,
    description: "Unknown role; least-privilege fallback.",
    custom: false,
    basedOn: null,
    access: { ...PRESET_ROLES.chatter.access },
    permissionDefaults: {},
  };

  let override = null;
  if (!custom && key !== "owner") {
    override = await client.agencyRoleOverride.findUnique({
      where: { agencyId_roleKey: { agencyId, roleKey: key } },
    });
  }

  const rawAccess = custom ? object(custom.access) : { ...object(base.access), ...object(override?.access) };
  const access = {};
  for (const zone of ZONES) {
    const fallback = zone.kind === "scope" ? "scoped" : "hidden";
    access[zone.key] = normalizeAccessValue(zone, rawAccess[zone.key], normalizeAccessValue(zone, base.access?.[zone.key], fallback));
  }
  if (key === "owner") {
    for (const zone of ZONES) access[zone.key] = zone.kind === "scope" ? "all" : "full";
  }

  const overrides = await client.agencySubPermissionOverride.findMany({
    where: { agencyId, roleKey: key },
    select: { subPermKey: true, value: true },
    take: 10000,
  });
  const overrideMap = new Map(overrides.map((row) => [String(row.subPermKey), Boolean(row.value)]));

  const permissions = {};
  const permissionDetails = {};
  for (const [permissionKey, meta] of PERMISSION_BY_KEY) {
    let value;
    let source = "zone";
    if (key === "owner") {
      value = true;
      source = "owner";
    } else if (overrideMap.has(permissionKey)) {
      value = overrideMap.get(permissionKey);
      source = "override";
    } else if (Object.prototype.hasOwnProperty.call(base.permissionDefaults || {}, permissionKey)) {
      value = Boolean(base.permissionDefaults[permissionKey]);
      source = "preset";
    } else {
      value = autoPermissionFromAccess(access[meta.zoneKey], meta.requiredLevel);
    }
    permissions[permissionKey] = Boolean(value);
    permissionDetails[permissionKey] = {
      value: Boolean(value),
      source,
      override: overrideMap.has(permissionKey) ? overrideMap.get(permissionKey) : null,
    };
  }

  return {
    key: base.key,
    label: base.label,
    tone: base.tone,
    description: base.description,
    locked: key === "owner" || Boolean(base.locked),
    custom: Boolean(base.custom),
    basedOn: base.basedOn || null,
    access,
    permissions,
    permissionDetails,
  };
}

async function resolveEffectivePermissions({ member, db = null }) {
  if (!member) return {};
  const client = db || require("../prisma");
  const agencyId = String(member.agencyId || "").trim();
  if (!agencyId) return { ...object(member.permissions) };
  const role = await resolveRoleDefinition({ agencyId, roleKey: memberRoleKey(member), db: client });
  const effective = { ...role.permissions };
  const direct = object(member.permissions);
  for (const [key, value] of Object.entries(direct)) {
    if (typeof value === "boolean") effective[key] = value;
  }
  if (isOwner(member)) {
    for (const key of PERMISSION_BY_KEY.keys()) effective[key] = true;
  }
  return effective;
}

async function canUsePermission({ member, key, db = null }) {
  if (!member || !key) return false;
  if (isOwner(member)) return true;
  const direct = directPermissionValue(member.permissions, key);
  if (direct !== null) return direct;
  const client = db || require("../prisma");
  const role = await resolveRoleDefinition({ agencyId: String(member.agencyId || ""), roleKey: memberRoleKey(member), db: client });
  if (Object.prototype.hasOwnProperty.call(role.permissions, key)) return role.permissions[key] === true;
  return false;
}

function normalizeAssignedCreators(value) {
  if (value === null || value === undefined || value === "all") return { mode: "all", creatorIds: [] };
  if (Array.isArray(value)) {
    return { mode: "scoped", creatorIds: Array.from(new Set(value.map(String).map((id) => id.trim()).filter(Boolean))) };
  }
  const obj = object(value);
  if (obj.all === true || String(obj.mode || "").toLowerCase() === "all") return { mode: "all", creatorIds: [] };
  const ids = Array.isArray(obj.creatorIds) ? obj.creatorIds : Array.isArray(obj.ids) ? obj.ids : [];
  return { mode: "scoped", creatorIds: Array.from(new Set(ids.map(String).map((id) => id.trim()).filter(Boolean))) };
}

function assignedCreatorsForStorage(value) {
  const normalized = normalizeAssignedCreators(value);
  return normalized.mode === "all" ? "all" : normalized.creatorIds;
}

async function validateAssignedCreators({ agencyId, assignedCreators, db = null }) {
  const normalized = normalizeAssignedCreators(assignedCreators);
  if (normalized.mode === "all") return { ok: true, value: "all", normalized };
  const client = db || require("../prisma");
  if (!normalized.creatorIds.length) return { ok: true, value: [], normalized };
  const rows = await client.creatorAccount.findMany({
    where: { agencyId, deletedAt: null, id: { in: normalized.creatorIds } },
    select: { id: true },
    take: 10000,
  });
  const found = new Set(rows.map((row) => String(row.id)));
  const unknown = normalized.creatorIds.filter((id) => !found.has(id));
  if (unknown.length) return { ok: false, code: "UNKNOWN_CREATOR_SCOPE", unknownCreatorIds: unknown };
  return { ok: true, value: normalized.creatorIds, normalized };
}

function publicPermissionZones() {
  // V8 only exposes controls that the server can actually enforce today.
  // Browser chat permissions remain reserved until the proven V7.6 Browser
  // lifecycle can enforce them without renderer-side policy. Legacy generic
  // Content permissions are also kept internal until their read/write routes
  // are uniformly permission-gated.
  const exposedZones = ZONES
    .filter((zone) => zone.key !== "chats")
    .map((zone) => ({
      ...zone,
      permissions: zone.permissions.filter((permission) => PUBLIC_PERMISSION_KEY_SET.has(permission.key)),
    }))
    .filter((zone) => zone.permissions.length > 0);

  return exposedZones.map((zone) => {
    const exactOnly = zone.key === "content" || zone.key === "automation" || zone.key === "creators";
    const label = zone.key === "content"
      ? "Message Library"
      : zone.key === "creators"
        ? "Creator management"
        : zone.label;
    const hint = zone.key === "content"
      ? "Explicit permission to manage the shared Message Library."
      : zone.key === "creators"
        ? "Manage creator accounts. Actual creator visibility is assigned explicitly per member."
        : zone.key === "automation"
          ? "Explicit permissions for automation configuration and operational logs."
          : zone.hint;
    return {
      key: zone.key,
      label,
      hint,
      kind: zone.kind,
      // Exact-only zones intentionally have no broad role-level switch: the
      // visible sub-permissions below are the authoritative controls. Creator
      // visibility itself is always member-scoped.
      levels: exactOnly ? [] : (zone.kind === "scope" ? [...SCOPE_LEVELS] : [...ACCESS_LEVELS]),
      permissions: zone.permissions.map((permission) => ({ ...permission })),
    };
  });
}

module.exports = {
  TEAM_FUNCTION_KEYS,
  PUBLIC_PERMISSION_KEYS,
  PUBLIC_PERMISSION_KEY_SET,
  ACCESS_LEVELS,
  SCOPE_LEVELS,
  ZONES,
  PRESET_ROLES,
  PERMISSION_BY_KEY,
  memberRoleKey,
  isOwner,
  directPermissionValue,
  resolveRoleDefinition,
  resolveEffectivePermissions,
  canUsePermission,
  normalizeAssignedCreators,
  assignedCreatorsForStorage,
  validateAssignedCreators,
  publicPermissionZones,
};

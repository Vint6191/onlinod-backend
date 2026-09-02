"use strict";

const {
  requireCreatorAccess,
  allowedCreatorScope,
} = require("./automation-permissions");
const {
  canUsePermission,
  resolveEffectivePermissions,
  memberRoleKey,
} = require("../services/team-access-control");

class ProductAccessError extends Error {
  constructor(code, message, status = 403) {
    super(message);
    this.name = "ProductAccessError";
    this.code = code;
    this.status = status;
  }
}

function currentMember(req) {
  return req?.auth?.membership || req?.member || null;
}

function currentAccessEpoch(req) {
  const value = Number(currentMember(req)?.accessEpoch ?? 1);
  return Number.isInteger(value) && value >= 0 ? value : 1;
}

async function productAccessContext(req, { db = null, includePermissions = false } = {}) {
  const member = currentMember(req);
  if (!member || !req?.auth?.agencyId || !req?.auth?.userId) {
    throw new ProductAccessError("PRODUCT_ACTOR_REQUIRED", "Current agency membership is required", 401);
  }
  const client = db || require("../prisma");
  const scope = await allowedCreatorScope({ agencyId: req.auth.agencyId, member, db: client });
  const permissions = includePermissions
    ? await resolveEffectivePermissions({ member, db: client })
    : null;
  return {
    agencyId: req.auth.agencyId,
    userId: req.auth.userId,
    memberId: member.id,
    roleKey: memberRoleKey(member),
    accessEpoch: currentAccessEpoch(req),
    deviceId: req.auth.deviceId ? String(req.auth.deviceId) : null,
    member,
    scope,
    permissions,
  };
}

async function requireProductCreator(req, creatorId, { db = null } = {}) {
  const member = currentMember(req);
  if (!member) throw new ProductAccessError("PRODUCT_ACTOR_REQUIRED", "Current agency membership is required", 401);
  return requireCreatorAccess({
    agencyId: req.auth.agencyId,
    member,
    creatorId: String(creatorId || ""),
    db: db || require("../prisma"),
  });
}

async function requireProductPermission(req, key, { db = null, code = "FEATURE_FORBIDDEN", message = null } = {}) {
  const member = currentMember(req);
  if (!member) throw new ProductAccessError("PRODUCT_ACTOR_REQUIRED", "Current agency membership is required", 401);
  const allowed = await canUsePermission({ member, key, db: db || require("../prisma") });
  if (!allowed) {
    throw new ProductAccessError(code, message || `${key} permission is required`, 403);
  }
  return true;
}

function requireProductDevice(req, suppliedDeviceId, options = {}) {
  // Keep device binding dependency lazy so creator/permission-only product routes
  // can be exercised with injected DB clients without loading the global Prisma
  // singleton. The authority is still the canonical auth middleware primitive.
  const { requireAuthDevice } = require("./auth");
  return requireAuthDevice(req, suppliedDeviceId, {
    requiredCode: options.requiredCode || "DEVICE_BOUND_TOKEN_REQUIRED",
    mismatchCode: options.mismatchCode || "DEVICE_IDENTITY_MISMATCH",
  });
}

async function requireProductCreatorDevice(req, { creatorId, deviceId, db = null, deviceOptions = {} } = {}) {
  const creator = await requireProductCreator(req, creatorId, { db });
  const boundDeviceId = requireProductDevice(req, deviceId, deviceOptions);
  return {
    creator,
    deviceId: boundDeviceId,
    member: currentMember(req),
    accessEpoch: currentAccessEpoch(req),
  };
}

async function filterProductCreatorScope(req, creatorIds, { db = null, rejectForeign = true } = {}) {
  const context = await productAccessContext(req, { db });
  const requested = Array.from(new Set((Array.isArray(creatorIds) ? creatorIds : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean)));
  if (context.scope.broad) return { ...context, creatorIds: requested };
  const allowed = new Set(context.scope.creatorIds || []);
  const foreign = requested.filter((id) => !allowed.has(id));
  if (foreign.length && rejectForeign) {
    throw new ProductAccessError(
      "CREATOR_ACCESS_FORBIDDEN",
      "One or more requested creators are outside the current member scope",
      403,
    );
  }
  return { ...context, creatorIds: requested.filter((id) => allowed.has(id)), foreignCreatorIds: foreign };
}

module.exports = {
  ProductAccessError,
  currentMember,
  currentAccessEpoch,
  productAccessContext,
  requireProductCreator,
  requireProductPermission,
  requireProductDevice,
  requireProductCreatorDevice,
  filterProductCreatorScope,
};

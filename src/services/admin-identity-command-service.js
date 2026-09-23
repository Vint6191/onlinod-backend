"use strict";

const bcrypt = require("bcryptjs");
const { z } = require("zod");
const { executeAdminCommand } = require("./admin-commit-authority-service");
const { adminError, reasonSchema, revisionSchema, passwordFingerprint, publicAdmin } = require("./admin-command-contract");

// bcrypt uses at most 72 bytes. Reject truncation instead of accepting two
// different submitted passwords as the same credential.
const passwordSchema = z.string().min(8).refine(value => Buffer.byteLength(value, "utf8") <= 72, "Password must be at most 72 UTF-8 bytes");
const roleSchema = z.enum(["SUPER_ADMIN", "SUPPORT"]);
const createSchema = z.object({ email: z.string().trim().email().max(254).transform(value => value.toLowerCase()), password: passwordSchema, name: z.string().trim().min(1).max(120).optional(), role: roleSchema.default("SUPPORT"), reason: reasonSchema }).strict();
const patchSchema = z.object({ name: z.string().trim().min(1).max(120).optional(), role: roleSchema.optional(), active: z.boolean().optional(), expectedEpoch: revisionSchema, reason: reasonSchema }).strict().refine(value => ["name", "role", "active"].some(key => value[key] !== undefined), "No changes supplied");
const resetSchema = z.object({ password: passwordSchema, expectedEpoch: revisionSchema, reason: reasonSchema }).strict();

async function requireTarget(tx, targetId, expectedEpoch) {
  const target = await tx.adminUser.findUnique({ where: { id: targetId } });
  if (!target) throw adminError("ADMIN_NOT_FOUND", "Admin not found", 404);
  if (target.accessEpoch !== expectedEpoch) throw adminError("ADMIN_IDENTITY_REVISION_CONFLICT", "Admin access changed; reload before editing", 409, { currentEpoch: target.accessEpoch });
  return target;
}

async function createAdminIdentity({ db, actor, commandId, payload }) {
  const input = createSchema.parse(payload);
  const { password, ...safe } = input;
  // No credential or bcrypt hash is retained in the command receipt/audit.
  const fingerprint = passwordFingerprint(password);
  const passwordHash = await bcrypt.hash(password, 12);
  return executeAdminCommand({ db, actor, commandId, action: "admin.identity.create", targetId: input.email, payload: { ...safe, passwordFingerprint: fingerprint }, work: async ({ tx }) => {
    if (await tx.adminUser.findUnique({ where: { email: input.email } })) throw adminError("EMAIL_TAKEN", "Admin with this email already exists", 409);
    const admin = await tx.adminUser.create({ data: { email: input.email, passwordHash, name: input.name || null, role: input.role, active: true } });
    const result = publicAdmin(admin);
    return { statusCode: 201, body: { ok: true, admin: result }, audit: { after: result } };
  } });
}

async function patchAdminIdentity({ db, actor, commandId, targetId, payload }) {
  const input = patchSchema.parse(payload);
  return executeAdminCommand({ db, actor, commandId, action: "admin.identity.patch", targetId, payload: input, work: async ({ tx, authority }) => {
    const before = await requireTarget(tx, targetId, input.expectedEpoch);
    if (targetId === actor.adminId && input.active === false) throw adminError("CANNOT_DISABLE_SELF", "Cannot disable yourself", 409);
    if (before.active && before.role === "SUPER_ADMIN" && (input.active === false || (input.role && input.role !== "SUPER_ADMIN"))) {
      // All roster writers, including the operator CLI, hold admin-roster-v1.
      const count = await tx.adminUser.count({ where: { active: true, role: "SUPER_ADMIN" } });
      if (count <= 1) throw adminError("LAST_SUPER_ADMIN", "The last active SUPER_ADMIN cannot be removed", 409);
    }
    const { expectedEpoch: _epoch, reason: _reason, ...data } = input;
    const after = await tx.adminUser.update({ where: { id: targetId }, data });
    if (after.accessEpoch !== before.accessEpoch) await tx.adminSession.updateMany({ where: { adminUserId: targetId, revokedAt: null }, data: { revokedAt: authority.now } });
    return { body: { ok: true, admin: publicAdmin(after) }, audit: { before: publicAdmin(before), after: publicAdmin(after) } };
  } });
}

async function resetAdminPassword({ db, actor, commandId, targetId, payload }) {
  const input = resetSchema.parse(payload);
  const { password, ...safe } = input;
  const fingerprint = passwordFingerprint(password);
  const passwordHash = await bcrypt.hash(password, 12);
  return executeAdminCommand({ db, actor, commandId, action: "admin.identity.reset-password", targetId, payload: { ...safe, passwordFingerprint: fingerprint }, work: async ({ tx, authority }) => {
    const before = await requireTarget(tx, targetId, input.expectedEpoch);
    const after = await tx.adminUser.update({ where: { id: targetId }, data: { passwordHash } });
    await tx.adminSession.updateMany({ where: { adminUserId: targetId, revokedAt: null }, data: { revokedAt: authority.now } });
    return { body: { ok: true, admin: publicAdmin(after) }, audit: { before: publicAdmin(before), after: publicAdmin(after), credentialsRotated: true } };
  } });
}

module.exports = { createAdminIdentity, patchAdminIdentity, resetAdminPassword, createSchema, passwordSchema };

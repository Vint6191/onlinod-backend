"use strict";
const bcrypt = require("bcryptjs");
const { z } = require("zod");
const { createSchema } = require("./admin-identity-command-service");
const { adminError, commandIdSchema, reasonSchema, intentHash, passwordFingerprint, publicAdmin } = require("./admin-command-contract");
const { lockCommandIdentity, safeJson } = require("./admin-commit-authority-service");
const { lockAdminRows } = require("./admin-session-authority-service");
const { dbAuthorityNow } = require("./db-time-authority-service");

// Operator-only entry point. No HTTP route imports or exposes this authority.
async function bootstrapAdmin({ db, commandId, operator, reason, email, password, name }) {
  commandIdSchema.parse(commandId);
  const actorId = `operator:${z.string().trim().min(1).max(120).parse(operator)}`;
  const input = createSchema.parse({ email, password, name, reason: reasonSchema.parse(reason), role: "SUPER_ADMIN" });
  const action = "admin.operator.bootstrap";
  const payloadHash = intentHash({ action, targetId: input.email, payload: { email: input.email, name: input.name, reason: input.reason, passwordFingerprint: passwordFingerprint(password) } });
  const passwordHash = await bcrypt.hash(password, 12);
  return db.$transaction(async tx => {
    await lockCommandIdentity(tx, actorId, commandId);
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", "admin-roster-v1");
    const existing = await tx.adminCommand.findUnique({ where: { actorId_commandId: { actorId, commandId } } });
    if (existing) {
      if (existing.payloadHash !== payloadHash) throw adminError("ADMIN_COMMAND_PAYLOAD_CONFLICT", "Command identity already used for another intent", 409);
      return existing.result;
    }
    const identity = await tx.adminUser.findUnique({ where: { email: input.email } });
    if (identity) await lockAdminRows(tx, [identity.id], "update");
    const before = identity ? await tx.adminUser.findUnique({ where: { id: identity.id } }) : null;
    const admin = await tx.adminUser.upsert({ where: { email: input.email }, create: { email: input.email, name: input.name || null, passwordHash, role: "SUPER_ADMIN", active: true }, update: { name: input.name || null, passwordHash, role: "SUPER_ADMIN", active: true } });
    const now = await dbAuthorityNow({ db: tx });
    await tx.adminSession.updateMany({ where: { adminUserId: admin.id, revokedAt: null }, data: { revokedAt: now } });
    const result = safeJson({ ok: true, admin: publicAdmin(admin), commandId });
    const command = await tx.adminCommand.create({ data: { actorId, commandId, sessionId: "operator-cli", actorAccessEpoch: 0, action, targetId: input.email, payloadHash, reason: input.reason, status: "SUCCEEDED", httpStatus: 200, result, completedAt: now } });
    await tx.adminCommandAudit.create({ data: { commandId: command.id, sequence: 1, actorId, action, targetId: admin.id, event: "OPERATOR_BOOTSTRAP", reason: input.reason, detail: safeJson({ before: before ? publicAdmin(before) : null, after: publicAdmin(admin) }) } });
    return result;
  }, { maxWait: 5000, timeout: 15000 });
}
module.exports = { bootstrapAdmin };

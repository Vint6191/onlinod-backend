"use strict";

const { dbAuthorityNow } = require("./db-time-authority-service");
const { ACTIONS, adminError, commandIdSchema, intentHash } = require("./admin-command-contract");
const { lockAdminActor } = require("./admin-session-authority-service");
const { runRootCommit, discardCommitHints, classifyCommitConflict } = require("./db-commit-kernel");

async function lockCommandIdentity(tx, actorId, commandId) {
  await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", `admin-command:${actorId}:${commandId}`);
}

function safeJson(value) {
  const json = JSON.stringify(value, (_key, item) => typeof item === "bigint" ? String(item) : item);
  if (json === undefined || Buffer.byteLength(json) > 32768) throw adminError("ADMIN_COMMAND_RESULT_TOO_LARGE", "Command result exceeds its storage budget", 500);
  return JSON.parse(json);
}

async function assertCommandSessionLifetime(tx, authority) {
  // AdminUser/AdminSession rows stay locked throughout the command. Their
  // expiration clock can still advance while domain locks/work are awaited.
  if (new Date(authority.session.expiresAt) <= await dbAuthorityNow({ db: tx })) {
    throw adminError("ADMIN_AUTH_INVALID", "Admin session expired while the command was in progress", 401);
  }
}

async function executeAdminCommand({ db, actor, commandId, action, targetId, payload, work }) {
  const contract = ACTIONS[action];
  if (!contract || typeof work !== "function") throw adminError("ADMIN_ACTION_UNKNOWN", "Unknown admin action", 400);
  if (!actor?.adminId) throw adminError("ADMIN_AUTH_REQUIRED", "Admin context is required", 401);
  commandIdSchema.parse(commandId);
  const normalized = contract.schema ? contract.schema.parse(payload) : payload;
  const hash = intentHash({ action, targetId, payload: normalized });
  return runRootCommit(db, async context => {
    const tx = context.tx;
    const relatedIdentity = contract.parentIdentity ? normalized.targetCommandId : contract.resumeIdentity ? normalized.resumesCommandId : null;
    const identities = [...new Set([commandId, relatedIdentity].filter(Boolean))].sort();
    for (const identity of identities) await lockCommandIdentity(tx, actor.adminId, identity);
    // Roster mutex is used only by identity commands, before any AdminUser row.
    if (contract.roster) await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", "admin-roster-v1");
    const authority = await lockAdminActor(tx, actor, { roles: contract.roles, mutateIdentity: contract.roster === true, targetAdminId: contract.roster ? targetId : null });
    const where = { actorId_commandId: { actorId: actor.adminId, commandId } };
    const existing = await tx.adminCommand.findUnique({ where });
    if (existing) {
      if (existing.payloadHash !== hash) throw adminError("ADMIN_COMMAND_PAYLOAD_CONFLICT", "Command identity was already used for another intent", 409);
      await assertCommandSessionLifetime(tx, authority);
      return { commandId, replayed: true, statusCode: existing.httpStatus, body: existing.result };
    }
    const command = await tx.adminCommand.create({ data: {
      commandId, actorId: actor.adminId, sessionId: actor.sessionId,
      actorAccessEpoch: actor.accessEpoch, action, targetId, payloadHash: hash,
      reason: normalized.reason, status: "RUNNING",
    } });
    // Domain errors must not retain a partial mutation. Keep the command row
    // outside the savepoint so a terminal rejection has a stable receipt too.
    await tx.$executeRawUnsafe("SAVEPOINT admin_domain_mutation");
    let outcome;
    try {
      outcome = await work({ tx, commitContext: context, authority, payload: normalized, command });
      await assertCommandSessionLifetime(tx, authority);
      await tx.$executeRawUnsafe("RELEASE SAVEPOINT admin_domain_mutation");
    } catch (error) {
      if (classifyCommitConflict(error)) throw error;
      if (!(Number(error.status) >= 400 && Number(error.status) < 500 && error.code)) throw error;
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT admin_domain_mutation");
      await tx.$executeRawUnsafe("RELEASE SAVEPOINT admin_domain_mutation");
      discardCommitHints(context);
      outcome = { statusCode: error.status, body: { ok: false, code: error.code, error: error.message, ...(error.details ? { details: error.details } : {}) }, audit: { outcome: "REJECTED", code: error.code } };
    }
    const statusCode = outcome.statusCode || 200;
    if (statusCode >= 400) discardCommitHints(context);
    const body = safeJson({ ...outcome.body, commandId });
    const audit = safeJson(outcome.audit || {});
    await tx.adminCommandAudit.create({ data: { commandId: command.id, sequence: 1, actorId: actor.adminId, action, targetId, scopeAgencyId: outcome.agencyId || null, event: outcome.queued ? "ACCEPTED" : statusCode < 400 ? "COMMITTED" : "REJECTED", detail: audit, reason: normalized.reason } });
    await tx.adminCommand.update({ where: { id: command.id }, data: { status: outcome.queued ? "QUEUED" : statusCode < 400 ? "SUCCEEDED" : "REJECTED", httpStatus: statusCode, result: body, scopeAgencyId: outcome.agencyId || null, completedAt: outcome.queued ? null : await dbAuthorityNow({ db: tx }) } });
    return { commandId, replayed: false, statusCode, body };
  }, {
    profile: "ADMIN_COMMAND", isolationLevel: contract.isolationLevel || "ReadCommitted",
    authority: { kind: "ADMIN_COMMAND", adminId: actor.adminId, agencyId: normalized.agencyId || null },
    conflictCode: "TEAM_CONTROL_PLANE_SERIALIZATION_CONFLICT",
    conflictMessage: "State changed concurrently; retry with the same command identity",
  });
}

async function readAdminCommand({ db, actor, commandId }) {
  commandIdSchema.parse(commandId);
  return runRootCommit(db, async ({ tx }) => {
    const authority = await lockAdminActor(tx, actor);
    const row = await tx.adminCommand.findUnique({ where: { actorId_commandId: { actorId: actor.adminId, commandId } } });
    if (!row) throw adminError("ADMIN_COMMAND_NOT_FOUND", "Command not found", 404);
    let execution = null;
    if (row.action === "billing.pricing.bulk") {
      const { workId } = require("./domain-work-authority-service");
      const item = await tx.domainWorkItem.findUnique({ where: { id: workId({ agencyId: row.scopeAgencyId, workClass: "ADMIN_BILLING_PRICING", objectType: "AdminCommand", objectId: row.id }) } });
      execution = { resume: row.status === "PAUSED_AUTH" ? { ...row.executionPayload, reason: undefined, items: row.executionPayload.items.slice(row.executionProgress.nextIndex), resumesCommandId: row.commandId } : null, progress: row.executionProgress, workState: item?.state || null, errorClass: item?.errorClass || null, terminalCause: item?.terminalCause || null, retryAt: item?.nextAttemptAt || null };
    }
    if (row.action === "retention.run") execution = { progress: row.executionProgress };
    await assertCommandSessionLifetime(tx, authority);
    return { ok: true, execution, commandId, action: row.action, targetId: row.targetId, status: row.status, result: row.result, httpStatus: row.httpStatus, createdAt: row.createdAt, completedAt: row.completedAt };
  }, { profile: "ADMIN_COMMAND", authority: { kind: "ADMIN_COMMAND_READ", adminId: actor.adminId } });
}

module.exports = { executeAdminCommand, readAdminCommand, lockCommandIdentity, safeJson };

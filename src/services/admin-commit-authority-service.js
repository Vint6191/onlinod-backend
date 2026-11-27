"use strict";

const { dbAuthorityNow } = require("./db-time-authority-service");
const { ACTIONS, adminError, commandIdSchema, intentHash } = require("./admin-command-contract");
const { lockAdminActor, assertAdminSessionLifetime: assertCommandSessionLifetime } = require("./admin-session-authority-service");
const { runRootCommit, discardCommitHints, classifyCommitConflict } = require("./db-commit-kernel");

const ABANDONED_ACTION = "admin.command.abandon";

async function lockCommandIdentity(tx, actorId, commandId) {
  await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", `admin-command:${actorId}:${commandId}`);
}

function safeJson(value) {
  const json = JSON.stringify(value, (_key, item) => typeof item === "bigint" ? String(item) : item);
  if (json === undefined || Buffer.byteLength(json) > 32768) throw adminError("ADMIN_COMMAND_RESULT_TOO_LARGE", "Command result exceeds its storage budget", 500);
  return JSON.parse(json);
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
      // A recovery tombstone closes this identity before an originally delayed
      // request can arrive. It deliberately has no knowledge of that payload.
      if (existing.action === ABANDONED_ACTION) {
        await assertCommandSessionLifetime(tx, authority);
        return { commandId, replayed: true, statusCode: existing.httpStatus, body: existing.result };
      }
      if (existing.payloadHash !== hash) throw adminError("ADMIN_COMMAND_PAYLOAD_CONFLICT", "Command identity was already used for another intent", 409);
      await assertCommandSessionLifetime(tx, authority);
      return { commandId, replayed: true, statusCode: existing.httpStatus, body: existing.result };
    }
    const command = await tx.adminCommand.create({ data: {
      commandId, actorId: actor.adminId, sessionId: actor.sessionId,
      actorAccessEpoch: actor.accessEpoch, action, targetId, payloadHash: hash,
      reason: normalized.reason, status: "RUNNING",
    } });
    // Domain work, mandatory audit and success receipt share one rollback
    // boundary. The initial row stays outside it so an expired command can
    // retain a rejection without retaining its effects or a success audit.
    await tx.$executeRawUnsafe("SAVEPOINT admin_domain_mutation");
    const rejectedOutcome = error => ({ statusCode: error.status, body: { ok: false, code: error.code, error: error.message, ...(error.details ? { details: error.details } : {}) }, audit: { outcome: "REJECTED", code: error.code } });
    const persistOutcome = async outcome => {
      const statusCode = outcome.statusCode || 200;
      const queued = statusCode < 400 && outcome.queued === true;
      const body = safeJson({ ...outcome.body, commandId });
      const audit = safeJson(outcome.audit || {});
      await tx.adminCommandAudit.create({ data: { commandId: command.id, sequence: 1, actorId: actor.adminId, action, targetId, scopeAgencyId: outcome.agencyId || null, event: queued ? "ACCEPTED" : statusCode < 400 ? "COMMITTED" : "REJECTED", detail: audit, reason: normalized.reason } });
      await tx.adminCommand.update({ where: { id: command.id }, data: { status: queued ? "QUEUED" : statusCode < 400 ? "SUCCEEDED" : "REJECTED", httpStatus: statusCode, result: body, scopeAgencyId: outcome.agencyId || null, completedAt: queued ? null : await dbAuthorityNow({ db: tx }) } });
      return { commandId, replayed: false, statusCode, body };
    };
    let outcome, rejected = false;
    try {
      outcome = await work({ tx, commitContext: context, authority, payload: normalized, command });
      await assertCommandSessionLifetime(tx, authority);
      rejected = (outcome.statusCode || 200) >= 400;
    } catch (error) {
      if (classifyCommitConflict(error)) throw error;
      if (!(Number(error.status) >= 400 && Number(error.status) < 500 && error.code)) throw error;
      outcome = rejectedOutcome(error);
      rejected = true;
    }
    if (!rejected) {
      // Receipt storage failures abort the root; they are never converted to
      // business rejections. Only our final lifetime check can reject here.
      const result = await persistOutcome(outcome);
      try {
        await assertCommandSessionLifetime(tx, authority);
        // COMMIT releases the savepoint. No awaited audit, receipt update or
        // RELEASE follows this final authority decision on the success path.
        return result;
      } catch (error) {
        if (error.code !== "ADMIN_AUTH_INVALID") throw error;
        outcome = rejectedOutcome(error);
      }
    }
    await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT admin_domain_mutation");
    await tx.$executeRawUnsafe("RELEASE SAVEPOINT admin_domain_mutation");
    discardCommitHints(context);
    // A denial receipt grants no authority and may survive session expiry.
    return persistOutcome(outcome);
  }, {
    profile: "ADMIN_COMMAND", isolationLevel: contract.isolationLevel || "ReadCommitted",
    authority: { kind: "ADMIN_COMMAND", adminId: actor.adminId, agencyId: normalized.agencyId || null },
    conflictCode: "TEAM_CONTROL_PLANE_SERIALIZATION_CONFLICT",
    conflictMessage: "State changed concurrently; retry with the same command identity",
  });
}

async function readAdminCommand({ db, actor, commandId }) {
  commandIdSchema.parse(commandId);
  if (!actor?.adminId) throw adminError("ADMIN_AUTH_REQUIRED", "Admin context is required", 401);
  return runRootCommit(db, async ({ tx }) => {
    // Use the same order as execution. A status read waits for an in-flight
    // command instead of presenting its uncommitted receipt as absent.
    await lockCommandIdentity(tx, actor.adminId, commandId);
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

async function abandonAdminCommand({ db, actor, commandId }) {
  commandIdSchema.parse(commandId);
  if (!actor?.adminId) throw adminError("ADMIN_AUTH_REQUIRED", "Admin context is required", 401);
  return runRootCommit(db, async ({ tx }) => {
    // Absence from a status read alone is not proof of noncommit. Serialize
    // closing and executing the identity on the very same transaction lock.
    await lockCommandIdentity(tx, actor.adminId, commandId);
    const authority = await lockAdminActor(tx, actor);
    let row = await tx.adminCommand.findUnique({ where: { actorId_commandId: { actorId: actor.adminId, commandId } } });
    if (!row) {
      const completedAt = await dbAuthorityNow({ db: tx });
      const result = { ok: false, commandId, code: "ADMIN_COMMAND_ABANDONED", error: "This unsubmitted change was closed. Reload current values before submitting a new change." };
      row = await tx.adminCommand.create({ data: {
        commandId, actorId: actor.adminId, sessionId: actor.sessionId, actorAccessEpoch: actor.accessEpoch,
        action: ABANDONED_ACTION, targetId: commandId, payloadHash: intentHash({ action: ABANDONED_ACTION, targetId: commandId, payload: {} }),
        reason: "Close an unconfirmed change", status: "REJECTED", httpStatus: 409, result, completedAt,
      } });
      await tx.adminCommandAudit.create({ data: { commandId: row.id, sequence: 1, actorId: actor.adminId,
        action: ABANDONED_ACTION, targetId: commandId, event: "REJECTED", detail: { code: "ADMIN_COMMAND_ABANDONED" }, reason: row.reason } });
    }
    // An already accepted command keeps its result and background work. This
    // operation closes only an identity which has never committed a receipt.
    await assertCommandSessionLifetime(tx, authority);
    return { ok: true, commandId, action: row.action, targetId: row.targetId, status: row.status,
      result: row.result, httpStatus: row.httpStatus, createdAt: row.createdAt, completedAt: row.completedAt };
  }, { profile: "ADMIN_COMMAND", authority: { kind: "ADMIN_COMMAND_ABANDON", adminId: actor.adminId } });
}

module.exports = { executeAdminCommand, readAdminCommand, abandonAdminCommand, lockCommandIdentity, safeJson };

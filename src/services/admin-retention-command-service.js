"use strict";

const { adminError } = require("./admin-command-contract");
const { executeAdminCommand, lockCommandIdentity, safeJson } = require("./admin-commit-authority-service");
const { lockAdminActor } = require("./admin-session-authority-service");
const { lockDbAdvisoryXact } = require("./db-transaction-service");
const { dbAuthorityNow } = require("./db-time-authority-service");
const retention = require("./retention-service");
const ACTIVE = ["QUEUED", "RUNNING"];
const COORDINATOR = "retention-sweep-coordinator";
const POLICY = retention.RETENTION_SETTING_KEY;
const actorOf = row => ({ adminId: row.actorId, sessionId: row.sessionId, accessEpoch: row.actorAccessEpoch });

function checkPolicy(current, input) {
  if (!current.ok) throw adminError("RETENTION_POLICY_UNAVAILABLE", "Retention policy is unavailable", 503);
  if (current.revision !== input.expectedRevision || current.policyHash !== input.expectedPolicyHash) {
    throw adminError("RETENTION_POLICY_CHANGED", "Retention policy changed; reload before submitting", 409);
  }
}

async function setAdminRetentionPolicy({ db, actor, commandId, payload, reset = false }) {
  const action = reset ? "retention.policy.reset" : "retention.policy.set";
  return executeAdminCommand({ db, actor, commandId, action, targetId: POLICY, payload,
    work: async ({ tx, payload: input }) => {
      await lockDbAdvisoryXact({ db: tx, key: COORDINATOR });
      const before = await retention.getRetentionSettings({ db: tx });
      checkPolicy(before, input);
      await tx.$queryRawUnsafe('SELECT "key" FROM "RetentionSweepLease" WHERE "key"=$1 FOR UPDATE', "global_retention_v1");
      const now = await dbAuthorityNow({ db: tx });
      const lease = await tx.retentionSweepLease.findUnique({ where: { key: "global_retention_v1" } });
      if (lease && !lease.completedAt && lease.leaseUntil > now) throw adminError("RETENTION_SWEEP_ACTIVE", "A sweep is using this policy; retry after it finishes", 409);
      const settings = reset ? before.defaults : input.settings;
      await tx.$executeRawUnsafe("SELECT set_config('onlinod.retention_policy_command','v1',true)");
      await tx.systemSetting.upsert({ where: { key: POLICY },
        create: { key: POLICY, value: settings, updatedByAdminId: actor.adminId },
        update: { value: settings, updatedByAdminId: actor.adminId },
      });
      const after = await retention.getRetentionSettings({ db: tx });
      return { body: { ...after, reset }, audit: { before: { revision: before.revision, settings: before.settings }, after: { revision: after.revision, settings: after.settings }, reset } };
    },
  });
}

async function submitAdminRetentionRun({ db, actor, commandId, payload }) {
  return executeAdminCommand({ db, actor, commandId, action: "retention.run", targetId: POLICY, payload,
    work: async ({ tx, command, payload: input }) => {
      await lockDbAdvisoryXact({ db: tx, key: COORDINATOR });
      const policy = await retention.getRetentionSettings({ db: tx });
      checkPolicy(policy, input);
      const existing = await tx.adminCommand.findFirst({ where: { action: "retention.run", status: { in: ACTIVE }, id: { not: command.id } }, select: { id: true } });
      if (existing) throw adminError("RETENTION_RUN_ALREADY_PENDING", "A retention pass is already queued or running", 409);
      await tx.adminCommand.update({ where: { id: command.id }, data: {
        executionPayload: safeJson({ ...input, policySettings: policy.settings }),
        executionProgress: { attempts: 0, state: "QUEUED" },
      } });
      return { queued: true, statusCode: 202, body: { ok: true, accepted: true, status: "QUEUED" },
        audit: { revision: policy.revision, policyHash: policy.policyHash, settings: policy.settings, scope: "global", work: "one bounded pass; recurring maintenance drains remaining work" } };
    },
  });
}

async function finishRun(tx, row, status, detail, now) {
  const progress = { ...row.executionProgress, state: status, ...detail };
  const sequence = 2 + Number(progress.attempts || 0) * 2;
  await tx.adminCommandAudit.create({ data: { commandId: row.id, sequence, actorId: row.actorId,
    action: row.action, targetId: row.targetId, event: status, reason: row.reason, detail: safeJson(progress) } });
  await tx.adminCommand.update({ where: { id: row.id }, data: { status, executionProgress: safeJson(progress), completedAt: now } });
}

// Uses the same cluster lease as recurring retention. No agency fan-out and no
// separate cleanup executor. A crashed pass is reclaimable after lease expiry;
// cleanup remains idempotent and its final receipt is atomic with lease release.
async function claimAdminRetentionRun({ db, row }) {
  return db.$transaction(async tx => {
    await lockCommandIdentity(tx, row.actorId, row.commandId);
    row = await tx.adminCommand.findUnique({ where: { id: row.id } });
    if (!row || !ACTIVE.includes(row.status)) return { skipped: true, reason: "command_terminal" };
    let authorityError = null;
    try { await lockAdminActor(tx, actorOf(row), { roles: ["SUPER_ADMIN"] }); }
    catch (error) { if (![401, 403].includes(error.status)) throw error; authorityError = error; }
    await lockDbAdvisoryXact({ db: tx, key: COORDINATOR });
    // A second worker must not cancel or finish a pass owned by another worker.
    const now = await dbAuthorityNow({ db: tx });
    const currentLease = await tx.retentionSweepLease.findUnique({ where: { key: "global_retention_v1" } });
    if (currentLease && !currentLease.completedAt && currentLease.leaseUntil > now) return { skipped: true, reason: "lease_held" };
    if (authorityError) {
      await finishRun(tx, row, "CANCELLED", { code: authorityError.code }, now);
      return { skipped: true, reason: "admin_authority_changed" };
    }
    const input = row.executionPayload;
    const policy = await retention.getRetentionSettings({ db: tx });
    try { checkPolicy(policy, input); }
    catch (error) {
      if (error.code !== "RETENTION_POLICY_CHANGED") throw error;
      await finishRun(tx, row, "CANCELLED", { code: error.code }, now);
      return { skipped: true, reason: "policy_changed" };
    }
    const lease = await retention.claimRetentionSweepLease({ db: tx });
    if (!lease.acquired) return { skipped: true, reason: lease.reason };
    const progress = { attempts: Number(row.executionProgress?.attempts || 0) + 1, state: "RUNNING", startedAt: lease.startedAt.toISOString() };
    await tx.adminCommandAudit.create({ data: { commandId: row.id, sequence: progress.attempts * 2 + 1,
      actorId: row.actorId, action: row.action, targetId: row.targetId, event: "PASS_STARTED", reason: row.reason, detail: progress } });
    row = await tx.adminCommand.update({ where: { id: row.id }, data: { status: "RUNNING", executionProgress: progress } });
    return { row, lease, policySettings: policy.settings };
  }, { maxWait: 5000, timeout: 15000 });
}

async function runAdminRetentionSweep({ db = require("../prisma"), run = retention.runRetentionSweep } = {}) {
  const row = await db.adminCommand.findFirst({ where: { action: "retention.run", status: { in: ACTIVE }, executionPayload: { not: require("@prisma/client").Prisma.DbNull } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  if (!row) return null;
  const claim = await claimAdminRetentionRun({ db, row });
  if (!claim.lease) return { ok: true, ...claim };
  return run({ claimedLease: claim.lease, policySettings: claim.policySettings,
    actorGuard: tx => lockAdminActor(tx, actorOf(claim.row), { roles: ["SUPER_ADMIN"] }),
    onFinalize: async (tx, now, report, error) => {
      const status = error || report?.ok === false ? "FAILED" : report?.remainingWork ? "PARTIAL" : "SUCCEEDED";
      await finishRun(tx, claim.row, status, { report: report ? safeJson(report) : null, error: error ? String(error.message).slice(0, 1000) : null,
        countsScope: "this attempt; a reclaimed earlier attempt may have committed cleanup before its receipt" }, now);
    },
  });
}

module.exports = { setAdminRetentionPolicy, submitAdminRetentionRun, runAdminRetentionSweep, claimAdminRetentionRun };

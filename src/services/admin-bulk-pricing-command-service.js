"use strict";

const { bulkPricingSchema, adminError } = require("./admin-command-contract");
const { executeAdminCommand, lockCommandIdentity, safeJson } = require("./admin-commit-authority-service");
const { lockAdminActor, assertAdminSessionLifetime } = require("./admin-session-authority-service");
const { lockLiveAgency } = require("./admin-billing-access-command-service");
const { setPricingWithinTransaction } = require("./admin-pricing-command-service");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { runRootCommit, classifyCommitConflict, discardCommitHints } = require("./db-commit-kernel");
const { performance } = require("node:perf_hooks");
const work = require("./domain-work-authority-service");
const GENERATION = "phase4_admin_pricing_v1";
const WORK_CLASS = "ADMIN_BILLING_PRICING";
const active = status => ["QUEUED", "RUNNING"].includes(status);
const actorOf = row => ({ adminId: row.actorId, sessionId: row.sessionId, accessEpoch: row.actorAccessEpoch });
const claimArgs = (db, item, ownerToken) => ({ db, item, ownerToken, generation: GENERATION });
function requireOwnership(result) {
  if (!result || result.lost) throw Object.assign(new Error("Admin work claim is no longer current"), { code: "ADMIN_WORK_CLAIM_LOST" });
  return result;
}
async function submitAdminBulkPricing({ db, actor, commandId, agencyId, payload }) {
  const input = bulkPricingSchema.parse(payload);
  return executeAdminCommand({ db, actor, commandId, action: "billing.pricing.bulk", targetId: agencyId, payload: input,
    work: async ({ tx, command }) => {
      await lockLiveAgency(tx, agencyId);
      let resumedParent = null;
      if (input.resumesCommandId) {
        const parent = await tx.adminCommand.findUnique({ where: { actorId_commandId: { actorId: actor.adminId, commandId: input.resumesCommandId } } });
        if (!parent || parent.scopeAgencyId !== agencyId || parent.action !== "billing.pricing.bulk" || parent.status !== "PAUSED_AUTH") throw adminError("ADMIN_RESUME_NOT_AVAILABLE", "Only your paused command in this agency can be resumed", 409);
        const remaining = parent.executionPayload.items.slice(parent.executionProgress.nextIndex);
        if (JSON.stringify(remaining) !== JSON.stringify(input.items) || parent.executionPayload.tier !== input.tier || parent.executionPayload.corePriceCents !== input.corePriceCents || parent.executionPayload.includeExcluded !== input.includeExcluded) throw adminError("ADMIN_RESUME_INTENT_CHANGED", "Resume must preserve the original remaining selection and prices", 409);
        resumedParent = parent;
      }
      // Selection is supplied with displayed revisions. Never enumerate ALL here.
      const selected = await tx.creatorAccount.findMany({ where: { agencyId, deletedAt: null, id: { in: input.items.map(item => item.creatorId) } }, select: { id: true }, take: 100 });
      if (selected.length !== input.items.length) throw adminError("ADMIN_SELECTION_SCOPE_INVALID", "Selection contains a missing, retired or foreign creator", 409);
      if (resumedParent) {
        await tx.adminCommandAudit.create({ data: { commandId: resumedParent.id, sequence: resumedParent.executionProgress.nextIndex + 3, actorId: actor.adminId, action: resumedParent.action, targetId: agencyId, scopeAgencyId: agencyId, event: "RESUMED", reason: input.reason, detail: { resumedByCommandId: commandId } } });
        await tx.adminCommand.update({ where: { id: resumedParent.id }, data: { status: "RESUMED", executionProgress: { ...resumedParent.executionProgress, resumedByCommandId: commandId } } });
      }
      const progress = { total: input.items.length, nextIndex: 0, succeeded: 0, rejected: 0, skipped: 0, outcomes: [] };
      await tx.adminCommand.update({ where: { id: command.id }, data: { executionPayload: safeJson(input), executionProgress: progress } });
      const published = await work.publishDomainWork({ db: tx, agencyId, workClass: WORK_CLASS, objectType: "AdminCommand", objectId: command.id, activeGeneration: GENERATION, projectionVersion: GENERATION });
      if (!published?.id) throw adminError("ADMIN_WORK_NOT_PUBLISHED", "Durable work was not published", 503);
      return { queued: true, statusCode: 202, agencyId, body: { ok: true, accepted: true, total: input.items.length, status: "QUEUED" }, audit: { selection: input.items, tier: input.tier, corePriceCents: input.corePriceCents ?? null, includeExcluded: input.includeExcluded, resumesCommandId: input.resumesCommandId || null } };
    },
  });
}

async function cancelAdminBulkPricing({ db, actor, commandId, agencyId, payload }) {
  return executeAdminCommand({ db, actor, commandId, action: "billing.pricing.bulk.cancel", targetId: agencyId, payload,
    work: async ({ tx, payload: input }) => {
      const row = await tx.adminCommand.findUnique({ where: { actorId_commandId: { actorId: actor.adminId, commandId: input.targetCommandId } } });
      if (!row || row.action !== "billing.pricing.bulk" || row.scopeAgencyId !== agencyId) throw adminError("ADMIN_COMMAND_NOT_FOUND", "Bulk command not found in this scope", 404);
      if (active(row.status) || row.status === "PAUSED_AUTH") {
        // Receipt lock before actor locks excludes a worker crossing cancellation.
        await tx.adminCommandAudit.create({ data: { commandId: row.id, sequence: row.executionProgress.nextIndex + (row.status === "PAUSED_AUTH" ? 3 : 2), actorId: actor.adminId, action: row.action, targetId: agencyId, scopeAgencyId: agencyId, event: "CANCELLED", reason: input.reason, detail: { cancellingCommandId: commandId, progress: row.executionProgress } } });
        await tx.adminCommand.update({ where: { id: row.id }, data: { status: "CANCELLED", completedAt: await dbAuthorityNow({ db: tx }) } });
      }
      return { agencyId, body: { ok: true, targetCommandId: input.targetCommandId, status: active(row.status) || row.status === "PAUSED_AUTH" ? "CANCELLED" : row.status }, audit: { targetCommandId: input.targetCommandId, priorStatus: row.status } };
    },
  });
}

async function stopCommand(tx, row, item, ownerToken, status, code) {
  const progress = { ...row.executionProgress, stoppedCode: code };
  await tx.adminCommandAudit.create({ data: { commandId: row.id, sequence: progress.nextIndex + 2, actorId: row.actorId, action: row.action, targetId: row.targetId, scopeAgencyId: row.scopeAgencyId, event: status, reason: row.reason, detail: { code, progress } } });
  await tx.adminCommand.update({ where: { id: row.id }, data: { status, executionProgress: progress, completedAt: await dbAuthorityNow({ db: tx }) } });
  requireOwnership(await work.ackDomainWorkClaim({ ...claimArgs(tx, item, ownerToken), terminalCause: status }));
  return { status };
}

async function processAdminBulkPricingItem({ db, item, ownerToken, keepClaim = false }) {
  return runRootCommit(db, async context => {
    const { tx } = context;
    const identity = await tx.adminCommand.findUnique({ where: { id: item.objectId } });
    if (!identity || item.objectType !== "AdminCommand" || identity.action !== "billing.pricing.bulk" || identity.scopeAgencyId !== item.agencyId) throw Object.assign(new Error("Admin billing work identity mismatch"), { code: "ADMIN_WORK_IDENTITY_INVALID", retryable: false });
    await lockCommandIdentity(tx, identity.actorId, identity.commandId);
    const row = await tx.adminCommand.findUnique({ where: { id: identity.id } });
    let authorizationError, authority;
    try { authority = await lockAdminActor(tx, actorOf(row)); }
    catch (error) { if (![401, 403].includes(error.status)) throw error; authorizationError = error; }
    let targetError;
    try { await lockLiveAgency(tx, item.agencyId); }
    catch (error) { if (![404, 409].includes(error.status)) throw error; targetError = error; }
    // Agency billing/lifecycle precedes DWI: retirement has the same order.
    const owned = requireOwnership(await work.lockDomainWorkClaimForCommit(claimArgs(tx, item, ownerToken)));
    if (owned.newerRevision) throw Object.assign(new Error("Immutable command work was republished"), { code: "ADMIN_WORK_REVISION_CHANGED", retryable: false });
    if (!active(row.status)) { requireOwnership(await work.ackDomainWorkClaim(claimArgs(tx, item, ownerToken))); return { status: row.status }; }
    if (authorizationError) return stopCommand(tx, row, item, ownerToken, "PAUSED_AUTH", authorizationError.code);
    if (targetError) return stopCommand(tx, row, item, ownerToken, "STOPPED_TARGET", targetError.code);
    const input = bulkPricingSchema.parse(row.executionPayload);
    const progress = structuredClone(row.executionProgress);
    const selected = input.items[progress.nextIndex];
    if (!selected) throw Object.assign(new Error("Invalid bulk cursor"), { code: "ADMIN_WORK_CURSOR_INVALID", retryable: false });
    await tx.$executeRawUnsafe("SAVEPOINT admin_bulk_item");
    try {
      let outcome, audit;
      try {
        await tx.$queryRawUnsafe('SELECT "id" FROM "CreatorAccount" WHERE "id"=$1 FOR SHARE', selected.creatorId);
        await tx.$queryRawUnsafe('SELECT "id" FROM "CreatorBillingProfile" WHERE "creatorId"=$1 FOR UPDATE', selected.creatorId);
        await assertAdminSessionLifetime(tx, authority);
        const creator = await tx.creatorAccount.findUnique({ where: { id: selected.creatorId }, include: { billingProfile: true } });
        if (!creator || creator.agencyId !== item.agencyId || creator.deletedAt) throw adminError("CREATOR_NOT_FOUND", "Creator is no longer live in this agency", 404);
        if (creator.billingProfile && creator.billingProfile.agencyId !== item.agencyId) throw adminError("BILLING_SCOPE_MISMATCH", "Stored pricing belongs to another agency", 409);
        if ((creator.billingProfile?.pricingRevision || 0) !== selected.expectedRevision) throw adminError("ADMIN_PRICING_REVISION_CONFLICT", "Pricing changed since selection", 409);
        if (!input.includeExcluded && creator.billingProfile?.billingExcluded) {
          outcome = { creatorId: selected.creatorId, status: "SKIPPED", code: "BILLING_EXCLUDED" }; audit = outcome;
        } else {
          const result = await setPricingWithinTransaction({ tx, creatorId: selected.creatorId, expectedAgencyId: item.agencyId, payload: { expectedRevision: selected.expectedRevision, reason: row.reason, tier: input.tier, ...(input.corePriceCents !== undefined ? { corePriceCents: input.corePriceCents } : {}) } });
          outcome = { creatorId: selected.creatorId, status: "SUCCEEDED", pricingRevision: result.body.billing.pricingRevision }; audit = result.audit;
        }
      } catch (error) {
        if (classifyCommitConflict(error) || error.code === "ADMIN_AUTH_INVALID") throw error;
        if (!(error.status >= 400 && error.status < 500 && error.code)) throw error;
        await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT admin_bulk_item");
        discardCommitHints(context);
        outcome = { creatorId: selected.creatorId, status: "REJECTED", code: error.code }; audit = outcome;
      }
      progress.nextIndex++;
      progress[outcome.status === "SUCCEEDED" ? "succeeded" : outcome.status === "SKIPPED" ? "skipped" : "rejected"]++;
      progress.outcomes.push(outcome);
      const done = progress.nextIndex === input.items.length;
      const status = done ? (progress.rejected ? "COMPLETED_WITH_REJECTIONS" : "SUCCEEDED") : "RUNNING";
      await tx.adminCommandAudit.create({ data: { commandId: row.id, sequence: progress.nextIndex + 1, actorId: row.actorId, action: row.action, targetId: selected.creatorId, scopeAgencyId: item.agencyId, event: outcome.status, reason: row.reason, detail: safeJson(audit) } });
      await tx.adminCommand.update({ where: { id: row.id }, data: { executionProgress: safeJson(progress), status, completedAt: done ? await dbAuthorityNow({ db: tx }) : null } });
      const settle = done ? work.ackDomainWorkClaim : keepClaim ? work.saveDomainWorkProgress : work.yieldDomainWorkClaim;
      requireOwnership(await settle({ ...claimArgs(tx, item, ownerToken), progressCursor: { nextIndex: progress.nextIndex } }));
      // The savepoint includes pricing, receipt, progress and claim settlement.
      // Expiry while waiting or writing must never advance the target cursor.
      await assertAdminSessionLifetime(tx, authority);
      await tx.$executeRawUnsafe("RELEASE SAVEPOINT admin_bulk_item");
      return { status, outcome, nextIndex: progress.nextIndex };
    } catch (error) {
      if (classifyCommitConflict(error) || error.code !== "ADMIN_AUTH_INVALID") throw error;
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT admin_bulk_item");
      await tx.$executeRawUnsafe("RELEASE SAVEPOINT admin_bulk_item");
      discardCommitHints(context);
      return stopCommand(tx, row, item, ownerToken, "PAUSED_AUTH", error.code);
    }
  }, { profile: "ADMIN_BACKGROUND", authority: { kind: "ADMIN_BULK_PRICING", agencyId: item.agencyId } });
}

async function runAdminBulkPricingSweep({ db }) {
  const started = performance.now();
  const claim = await work.claimDomainWorkBatch({ db, workClass: WORK_CLASS, generation: GENERATION, limit: 4, perAgencyQuantum: 1, perPartitionQuantum: 1, leaseMs: 120000 });
  const report = { ok: true, selected: claim.items.length, processed: 0, failed: 0, lost: 0, skipped: claim.skipped || false, reason: claim.reason || null };
  for (const item of claim.items) {
    try {
      // At most ten short per-target transactions per claim; each checks the
      // actor again. A local time budget is admission only, never commit truth.
      let released = false;
      for (let step = 0; step < 10 && performance.now() - started < 8000; step++) {
        const keepClaim = step < 9;
        const result = await processAdminBulkPricingItem({ db, item, ownerToken: claim.ownerToken, keepClaim });
        report.processed++;
        if (result.status !== "RUNNING" || !keepClaim) { released = true; break; }
      }
      if (!released) requireOwnership(await work.yieldDomainWorkClaim(claimArgs(db, item, claim.ownerToken)));
    } catch (error) {
      const failed = await work.failDomainWorkClaim({ ...claimArgs(db, item, claim.ownerToken), error });
      if (failed.lost) report.lost++; else report.failed++;
    }
  }
  report.ok = report.failed === 0 && report.lost === 0;
  return report;
}
module.exports = { cancelAdminBulkPricing, submitAdminBulkPricing, processAdminBulkPricingItem, runAdminBulkPricingSweep, GENERATION, WORK_CLASS };

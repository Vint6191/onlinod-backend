"use strict";

const prisma = require("../prisma");

const ACTIVE_WRITE_STATUSES = ["QUEUED", "RETRY_SCHEDULED", "CLAIMED", "RUNNING", "COMMITTING", "RECONCILE_REQUIRED"];

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function randomBetween(min, max) {
  const lo = Math.max(0, Math.floor(number(min)));
  const hi = Math.max(lo, Math.floor(number(max, lo)));
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}
function interval(settings = {}, minimumKey, maximumKey) {
  const min = Math.max(0, Math.floor(number(settings[minimumKey], 0)));
  const max = Math.max(min, Math.floor(number(settings[maximumKey], min)));
  return settings.randomJitter === true ? randomBetween(min, max) : min;
}
function dateMs(value) { return value instanceof Date && Number.isFinite(value.getTime()) ? value.getTime() : 0; }

async function latestCommittedWrite({ agencyId, creatorId, actionType = null, db = prisma }) {
  // A physical write permit consumes pacing even when the provider rejects it,
  // its reply is lost, or the work is later canceled. Pre-wire failures have no
  // writeCommitAt and do not consume this lane. Include the delivery itself:
  // an idempotent retry must respect its previous physical attempt too.
  return db.automationDelivery.findFirst({
    where: { agencyId, creatorId, originKind: "AUTOMATION", writeCommitAt: { not: null }, ...(actionType ? { actionType } : {}) },
    orderBy: { writeCommitAt: "desc" }, select: { writeCommitAt: true },
  });
}

async function latestWriteState({ agencyId, creatorId, actionType = null, now = new Date(), db = prisma }) {
  const typeFilter = actionType ? { actionType } : {};
  const [planned, completed, committed] = await Promise.all([
    db.automationDelivery.findFirst({
      where: {
        agencyId,
        creatorId,
        originKind: "AUTOMATION",
        ...typeFilter,
        status: { in: ACTIVE_WRITE_STATUSES },
        // A bump delete scheduled an hour from now must not reserve the entire
        // send timeline. It joins pacing only once it is actually due.
        OR: [{ actionType: { not: "DELETE_MESSAGE" } }, { notBefore: { lte: now } }],
      },
      orderBy: [{ notBefore: "desc" }, { createdAt: "desc" }],
      select: { status: true, notBefore: true, claimedAt: true },
    }),
    db.automationDelivery.findFirst({
      where: { agencyId, creatorId, originKind: "AUTOMATION", ...typeFilter, status: "COMPLETED", finishedAt: { not: null } },
      orderBy: [{ finishedAt: "desc" }, { updatedAt: "desc" }],
      select: { finishedAt: true },
    }),
    latestCommittedWrite({ agencyId, creatorId, actionType, db }),
  ]);
  const activeBase = planned
    ? Math.max(dateMs(planned.notBefore), dateMs(planned.claimedAt), ["CLAIMED", "RUNNING", "COMMITTING", "RECONCILE_REQUIRED"].includes(planned.status) ? now.getTime() : 0)
    : 0;
  return {
    hasState: Boolean(planned || completed || committed),
    baseMs: Math.max(activeBase, dateMs(completed?.finishedAt), dateMs(committed?.writeCommitAt)),
  };
}

async function nextAutomationWriteSlot({
  agencyId,
  creatorId,
  actionType,
  workspaceSettings,
  actionSettings,
  now = new Date(),
  db = prisma,
}) {
  const [globalState, actionState] = await Promise.all([
    latestWriteState({ agencyId, creatorId, now, db }),
    latestWriteState({ agencyId, creatorId, actionType, now, db }),
  ]);
  const globalDelay = interval(workspaceSettings, "globalWriteMinIntervalMs", "globalWriteMaxIntervalMs");
  const actionDelay = interval(actionSettings, "minimumIntervalMs", "maximumIntervalMs");
  return new Date(Math.max(
    now.getTime(),
    globalState.hasState ? globalState.baseMs + globalDelay : 0,
    actionState.hasState ? actionState.baseMs + actionDelay : 0,
  ));
}

async function claimPacingRetryAt({ delivery, workspaceSettings, actionSettings, now = new Date(), db = prisma }) {
  const [globalCompleted, actionCompleted, globalCommitted, actionCommitted] = await Promise.all([
    db.automationDelivery.findFirst({
      where: {
        agencyId: delivery.agencyId,
        creatorId: delivery.creatorId,
        originKind: "AUTOMATION",
        status: "COMPLETED",
        finishedAt: { not: null },
        id: { not: delivery.id },
      },
      orderBy: { finishedAt: "desc" },
      select: { finishedAt: true },
    }),
    db.automationDelivery.findFirst({
      where: {
        agencyId: delivery.agencyId,
        creatorId: delivery.creatorId,
        originKind: "AUTOMATION",
        actionType: delivery.actionType,
        status: "COMPLETED",
        finishedAt: { not: null },
        id: { not: delivery.id },
      },
      orderBy: { finishedAt: "desc" },
      select: { finishedAt: true },
    }),
    latestCommittedWrite({ agencyId: delivery.agencyId, creatorId: delivery.creatorId, db }),
    latestCommittedWrite({ agencyId: delivery.agencyId, creatorId: delivery.creatorId, actionType: delivery.actionType, db }),
  ]);
  const globalMin = Math.max(0, Math.floor(number(workspaceSettings?.globalWriteMinIntervalMs, 0)));
  const actionMin = Math.max(0, Math.floor(number(actionSettings?.minimumIntervalMs, 0)));
  const retryAtMs = Math.max(
    dateMs(globalCompleted?.finishedAt) + globalMin,
    dateMs(actionCompleted?.finishedAt) + actionMin,
    dateMs(globalCommitted?.writeCommitAt) + globalMin,
    dateMs(actionCommitted?.writeCommitAt) + actionMin,
  );
  return retryAtMs > now.getTime() ? new Date(retryAtMs) : null;
}

module.exports = {
  ACTIVE_WRITE_STATUSES,
  nextAutomationWriteSlot,
  claimPacingRetryAt,
  latestCommittedWrite,
};

"use strict";

const prisma = require("../prisma");
const { publishDomainWork, WORK_CLASS } = require("./domain-work-authority-service");
const { applyTeamPendingProjection } = require("./team-pending-projection-service");
const { applyTeamResponseProjection, upsertCoverageSession, repairResponseCasesForCoverageEvent } = require("./team-response-projection-service");

const TEAM_DIALOG_PROJECTION_VERSION = "team_dialog_projection_v1";
const DIALOG_EVENT_KINDS = new Set(["FAN_MESSAGE_RECEIVED", "DIALOG_SEEN", "MESSAGE_SEND_CONFIRMED", "DIALOG_SESSION"]);
const COVERAGE_EVENT_KINDS = new Set(["COVERAGE_STARTED", "COVERAGE_ENDED"]);

function clean(value, max = 220) {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, max) : null;
}

function dialogWorkObjectId(creatorId, dialogId) {
  const creator = clean(creatorId, 160); const dialog = clean(dialogId, 160);
  if (!creator || !dialog) throw Object.assign(new Error("TEAM_DIALOG_WORK_IDENTITY_REQUIRED"), { code: "TEAM_DIALOG_WORK_IDENTITY_REQUIRED" });
  return JSON.stringify([creator, dialog]);
}

function parseDialogWorkObjectId(value) {
  try {
    const parsed = JSON.parse(String(value || ""));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const creatorId = clean(parsed[0], 160); const dialogId = clean(parsed[1], 160);
    return creatorId && dialogId ? { creatorId, dialogId } : null;
  } catch (_) { return null; }
}


function relevantDialogEventWhere() {
  return {
    OR: [
      { eventKind: { in: ["FAN_MESSAGE_RECEIVED", "DIALOG_SEEN", "DIALOG_SESSION"] } },
      { eventKind: "MESSAGE_SEND_CONFIRMED", actionSource: "MANUAL", lifecycle: "CONFIRMED" },
    ],
  };
}

function unprojectedDialogWhere() {
  return {
    OR: [
      { dialogProjectionVersion: null },
      { dialogProjectionVersion: { not: TEAM_DIALOG_PROJECTION_VERSION } },
    ],
  };
}

async function listUnprojectedRelevantDialogEvents({ agencyId, cursor = null, limit = 100, db = prisma } = {}) {
  agencyId = clean(agencyId, 160);
  if (!agencyId) throw Object.assign(new Error("TEAM_DIALOG_AGENCY_REQUIRED"), { code: "TEAM_DIALOG_AGENCY_REQUIRED" });
  if (!db?.teamActivityEvent?.findMany) throw Object.assign(new Error("TEAM_DIALOG_EVENT_STORAGE_REQUIRED"), { code: "TEAM_DIALOG_EVENT_STORAGE_REQUIRED" });
  const take = Math.max(1, Math.min(100, Math.floor(Number(limit) || 100)));
  return db.teamActivityEvent.findMany({
    where: {
      agencyId,
      ...(cursor ? { id: { gt: String(cursor) } } : {}),
      AND: [relevantDialogEventWhere(), unprojectedDialogWhere()],
    },
    select: { id: true, agencyId: true, creatorId: true, dialogId: true, fanId: true, eventKind: true, actionSource: true, lifecycle: true },
    orderBy: { id: "asc" },
    take,
  });
}

function isRelevantDialogEvent(row) {
  const kind = String(row?.eventKind || "").trim().toUpperCase();
  if (!DIALOG_EVENT_KINDS.has(kind)) return false;
  if (kind === "MESSAGE_SEND_CONFIRMED") {
    return String(row?.actionSource || "").trim().toUpperCase() === "MANUAL"
      && String(row?.lifecycle || "").trim().toUpperCase() === "CONFIRMED";
  }
  return true;
}

async function publishTeamProjectionWorkForEvent({ row, db = prisma, now = new Date() } = {}) {
  const agencyId = clean(row?.agencyId, 160); const creatorId = clean(row?.creatorId, 160);
  const kind = String(row?.eventKind || "").trim().toUpperCase();
  if (!agencyId || !creatorId || !kind) return { published: 0, reason: "missing_scope" };
  let published = 0;
  const dialogId = clean(row?.dialogId || row?.fanId, 160);
  if (dialogId && isRelevantDialogEvent(row)) {
    await publishDomainWork({
      db, agencyId, workClass: WORK_CLASS.TEAM_DIALOG_PROJECTION, objectType: "CreatorDialog",
      objectId: dialogWorkObjectId(creatorId, dialogId), parentObjectId: clean(row?.id, 220),
      partitionKey: creatorId, creatorId, availableAt: now,
    });
    published += 1;
  }
  if (COVERAGE_EVENT_KINDS.has(kind) && clean(row?.id, 220)) {
    await publishDomainWork({
      db, agencyId, workClass: WORK_CLASS.TEAM_RESPONSE_RANGE_REPAIR, objectType: "TeamActivityEvent",
      objectId: clean(row.id, 220), parentObjectId: clean(row?.coverageId || row?.correlationId, 220),
      partitionKey: creatorId, creatorId, availableAt: now,
    });
    published += 1;
  }
  return { published };
}

async function markDialogEventProjected(row, db) {
  if (!row?.id || !db?.teamActivityEvent?.updateMany) return 0;
  const changed = await db.teamActivityEvent.updateMany({
    where: { id: String(row.id), agencyId: String(row.agencyId), OR: [{ dialogProjectionVersion: null }, { dialogProjectionVersion: { not: TEAM_DIALOG_PROJECTION_VERSION } }] },
    data: { dialogProjectionVersion: TEAM_DIALOG_PROJECTION_VERSION, dialogProjectedAt: new Date() },
  });
  return Number(changed?.count || 0);
}

async function projectCreatorDialogWorkItem({ agencyId, creatorId, dialogId, db = prisma, limit = 100, progressCursor = null } = {}) {
  agencyId = clean(agencyId,160); creatorId = clean(creatorId,160); dialogId = clean(dialogId,160);
  if (!agencyId || !creatorId || !dialogId) throw Object.assign(new Error("TEAM_DIALOG_WORK_IDENTITY_REQUIRED"), { code: "TEAM_DIALOG_WORK_IDENTITY_REQUIRED" });
  const take = Math.max(1, Math.min(100, Math.floor(Number(limit) || 100)));
  if (!db?.teamActivityEvent?.findMany) throw Object.assign(new Error("TEAM_DIALOG_EVENT_STORAGE_REQUIRED"), { code: "TEAM_DIALOG_EVENT_STORAGE_REQUIRED" });

  const repairEventId = clean(progressCursor?.pendingRepair?.eventId, 220);
  let rows;
  if (repairEventId && db?.teamActivityEvent?.findFirst) {
    const resume = await db.teamActivityEvent.findFirst({
      where: { id: repairEventId, agencyId, creatorId, dialogId, AND: [relevantDialogEventWhere(), unprojectedDialogWhere()] },
    });
    rows = resume ? [resume] : [];
  } else {
    rows = await db.teamActivityEvent.findMany({
      where: { agencyId, creatorId, dialogId, AND: [relevantDialogEventWhere(), unprojectedDialogWhere()] },
      orderBy: [{ ts: "asc" }, { id: "asc" }], take,
    });
  }

  let projected = 0;
  for (const row of rows || []) {
    if (isRelevantDialogEvent(row)) {
      // Response projection was already committed before a pending repair cursor
      // can be yielded. Do not replay that sibling projection on every bounded
      // pending-repair page; a failed response projection never reaches this cursor.
      if (!repairEventId) await applyTeamResponseProjection(row, db);
      const repairProgress = repairEventId === clean(row?.id, 220) ? progressCursor?.pendingRepair?.cursor || null : null;
      const pending = await applyTeamPendingProjection(row, db, { executeRepair: true, repairProgress, repairLimit: take });
      if (pending?.complete === false) {
        return {
          ok: true, selected: Number(rows?.length || 0), projected, hasMore: true,
          nextProgressCursor: { pendingRepair: { eventId: clean(row?.id, 220), cursor: pending?.progress || repairProgress || null } },
        };
      }
    }
    projected += await markDialogEventProjected(row, db);
  }
  // A resumed repair intentionally selects only its source event. Yield once after
  // completion so the same DWI claim can continue any other unprojected events.
  const resumed = Boolean(repairEventId);
  return { ok: true, selected: Number(rows?.length || 0), projected, hasMore: resumed || Number(rows?.length || 0) >= take, nextProgressCursor: null };
}

async function projectCoverageResponseWorkItem({ agencyId, eventId, db = prisma, cursor = null, limit = 100 } = {}) {
  agencyId = clean(agencyId,160); eventId = clean(eventId,220);
  if (!agencyId || !eventId) throw Object.assign(new Error("TEAM_COVERAGE_WORK_IDENTITY_REQUIRED"), { code: "TEAM_COVERAGE_WORK_IDENTITY_REQUIRED" });
  const event = await db?.teamActivityEvent?.findFirst?.({ where: { id: eventId, agencyId } });
  if (!event) return { ok: true, obsolete: true, complete: true, nextCursor: null, repaired: 0 };
  const kind = String(event.eventKind || "").toUpperCase();
  if (!COVERAGE_EVENT_KINDS.has(kind)) return { ok: true, obsolete: true, complete: true, nextCursor: null, repaired: 0 };
  const coverage = await upsertCoverageSession(event, db);
  if (!coverage) return { ok: true, obsolete: true, complete: true, nextCursor: null, repaired: 0 };
  return repairResponseCasesForCoverageEvent({ coverage, db, cursor, limit });
}

module.exports = {
  TEAM_DIALOG_PROJECTION_VERSION, DIALOG_EVENT_KINDS, COVERAGE_EVENT_KINDS,
  dialogWorkObjectId, parseDialogWorkObjectId, isRelevantDialogEvent, relevantDialogEventWhere, listUnprojectedRelevantDialogEvents,
  publishTeamProjectionWorkForEvent, projectCreatorDialogWorkItem, projectCoverageResponseWorkItem,
};

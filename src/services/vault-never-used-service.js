"use strict";

const prisma = require("../prisma");
const { getVaultUnsortedState } = require("./vault-unsorted-service");
const { DIALOG_INTELLIGENCE_JOB_KEY } = require("./dialog-intelligence-service");

const PROJECTION_CHUNK_SIZE = 5000;
const LIST_SCAN_CHUNK_SIZE = 500;
const DEFAULT_STALE_AFTER_MS = 3 * 60 * 60 * 1000;
const PROJECTION_CACHE_LIMIT = 500;
const MEDIA_TYPES = new Set(["photo", "video", "audio", "gif", "unknown"]);
const projectionCache = new Map();

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function clean(value, max = 240) {
  return String(value ?? "").trim().slice(0, max);
}

function integer(value, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function timestamp(value) {
  if (!value) return NaN;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function mostRecent(values) {
  const times = values.map(timestamp).filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

function oldest(values) {
  const times = values.map(timestamp).filter(Number.isFinite);
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

function staleAfterMs(value = process.env.ONLINOD_NEVER_USED_STALE_AFTER_MS) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 60_000 ? Math.floor(parsed) : DEFAULT_STALE_AFTER_MS;
}


function normalizeMediaType(value) {
  const type = clean(value, 20).toLowerCase();
  return MEDIA_TYPES.has(type) ? type : "unknown";
}

async function requireCreator(db, agencyId, creatorId) {
  const creator = await db.creatorAccount.findFirst({
    where: { id: creatorId, agencyId, deletedAt: null },
    select: { id: true },
  });
  if (!creator) {
    const error = new Error("Creator not found");
    error.code = "CREATOR_NOT_FOUND";
    throw error;
  }
  return creator;
}

async function dialogPipelineState(db, agencyId, creatorId) {
  const [states, discoveryRuns, activeJobs, latestRun] = await Promise.all([
    db.dialogScanState.findMany({
      where: { agencyId, creatorId, dialogId: { not: "__dialog_discovery__" } },
      select: {
        initialScanComplete: true,
        status: true,
        pagesProcessed: true,
        messagesProcessed: true,
        lastError: true,
        lastFullScanAt: true,
        lastIncrementalScanAt: true,
        updatedAt: true,
      },
      take: 100000,
    }),
    db.dialogScanRun.findMany({
      where: { agencyId, creatorId, dialogId: "__dialog_discovery__" },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        jobId: true,
        status: true,
        pagesProcessed: true,
        purchaseSignals: true,
        completedAt: true,
        updatedAt: true,
      },
    }),
    db.jobInstance.findMany({
      where: {
        agencyId,
        creatorId,
        jobKey: DIALOG_INTELLIGENCE_JOB_KEY,
        status: { in: ["SCHEDULED", "CLAIMED"] },
      },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      take: 1000,
      select: {
        id: true,
        status: true,
        params: true,
        progress: true,
        claimedByDeviceId: true,
        leaseUntil: true,
        attempts: true,
        lastError: true,
        updatedAt: true,
      },
    }),
    db.dialogScanRun.findFirst({
      where: { agencyId, creatorId },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true, completedAt: true, lastError: true },
    }),
  ]);

  const discoveryJobIds = discoveryRuns.map((run) => clean(run.jobId)).filter(Boolean);
  const discoveryJobs = discoveryJobIds.length
    ? await db.jobInstance.findMany({
        where: { id: { in: discoveryJobIds } },
        select: { id: true, params: true },
        take: discoveryJobIds.length,
      })
    : [];
  const paramsByJobId = new Map(discoveryJobs.map((job) => [job.id, object(job.params)]));

  let discoveryCompleted = false;
  let discoveryCompletedAt = null;
  for (const run of discoveryRuns) {
    if (run.status !== "COMPLETED") continue;
    const params = paramsByJobId.get(run.jobId) || {};
    if (params.childMode !== "initial") continue;
    discoveryCompleted = true;
    discoveryCompletedAt = iso(run.completedAt || run.updatedAt);
    break;
  }

  const discovered = states.length;
  const initialComplete = states.filter((state) => state.initialScanComplete === true).length;
  const active = states.filter((state) => ["QUEUED", "RUNNING", "PAUSED"].includes(state.status)).length;
  const paused = states.some((state) => state.status === "PAUSED");
  const failed = states.filter((state) => state.status === "FAILED").length;
  const pagesCommitted = states.reduce((sum, state) => sum + number(state.pagesProcessed), 0);
  const messagesCommitted = states.reduce((sum, state) => sum + number(state.messagesProcessed), 0);
  const discoveryJob = activeJobs.find((job) => clean(object(job.params).dialogId) === "__dialog_discovery__") || null;
  const activeJob = discoveryJob || activeJobs[0] || null;
  const successfulStateTimes = states
    .filter((state) => state.initialScanComplete === true)
    .map((state) => state.lastIncrementalScanAt || state.lastFullScanAt)
    .filter(Boolean);

  return {
    discovered,
    initialComplete,
    active,
    paused,
    failed,
    pagesCommitted,
    messagesCommitted,
    discoveryCompleted,
    activeJobStatus: activeJob?.status || null,
    claimedByDeviceId: activeJob?.claimedByDeviceId || null,
    leaseUntil: iso(activeJob?.leaseUntil),
    retries: number(activeJob?.attempts),
    lastError: activeJob?.lastError || latestRun?.lastError || states.find((state) => state.lastError)?.lastError || null,
    lastUpdatedAt: iso(activeJob?.updatedAt || latestRun?.updatedAt || states[0]?.updatedAt),
    lastSuccessfulScanAt: mostRecent([discoveryCompletedAt, ...successfulStateTimes]),
    activeJob,
    discoveryActive: Boolean(discoveryJob),
    historyActive: activeJobs.some((job) => clean(object(job.params).dialogId) !== "__dialog_discovery__"),
  };
}

function emptyByType() {
  return { all: 0, photo: 0, video: 0, audio: 0, gif: 0, unknown: 0 };
}

function emptyProjection(snapshot = null, { deferred = false } = {}) {
  const catalogMedia = number(snapshot?.itemsCount);
  return {
    catalogMedia,
    eligibleCreatorMedia: catalogMedia,
    usedCreatorMedia: 0,
    neverUsed: 0,
    notApplicable: 0,
    unknown: 0,
    byType: emptyByType(),
    rebuiltAt: null,
    complete: false,
    deferred,
  };
}

async function usedMediaIdsForBatch(db, agencyId, creatorId, ids) {
  if (!ids.length) return { ids: new Set(), updatedAt: null };
  const creatorEvidence = {
    agencyId,
    creatorId,
    OR: [{ ownership: "CREATOR" }, { isFanMedia: false, messageLedger: { isFromCreator: true } }],
  };
  const [ledgerMedia, ledgerAssets, salesMedia, salesAssets] = await Promise.all([
    db.dialogMessageMedia.findMany({
      where: { ...creatorEvidence, mediaId: { in: ids } },
      distinct: ["mediaId"],
      select: { mediaId: true, updatedAt: true },
      take: ids.length,
    }),
    db.dialogMessageMedia.findMany({
      where: { ...creatorEvidence, assetId: { in: ids } },
      distinct: ["assetId"],
      select: { assetId: true, updatedAt: true },
      take: ids.length,
    }),
    db.vaultAssetSalesAggregate.findMany({
      where: { agencyId, creatorId, mediaId: { in: ids } },
      distinct: ["mediaId"],
      select: { mediaId: true, updatedAt: true },
      take: ids.length,
    }),
    db.vaultAssetSalesAggregate.findMany({
      where: { agencyId, creatorId, assetId: { in: ids } },
      distinct: ["assetId"],
      select: { assetId: true, updatedAt: true },
      take: ids.length,
    }),
  ]);

  const candidateIds = new Set(ids);
  const used = new Set();
  const freshness = [];
  for (const row of [...ledgerMedia, ...ledgerAssets, ...salesMedia, ...salesAssets]) {
    for (const value of [row.mediaId, row.assetId]) {
      const id = clean(value);
      if (id && candidateIds.has(id)) used.add(id);
    }
    const updatedAt = timestamp(row.updatedAt);
    if (Number.isFinite(updatedAt)) freshness.push(updatedAt);
  }
  return {
    ids: used,
    updatedAt: freshness.length ? new Date(Math.max(...freshness)).toISOString() : null,
  };
}

async function projectionCounts(db, agencyId, creatorId) {
  const byType = emptyByType();
  const neverUsedByType = emptyByType();
  let catalogMedia = 0;
  let usedCreatorMedia = 0;
  let newestEvidenceAt = NaN;
  let cursorId = null;

  for (;;) {
    const page = await db.vaultUnsortedItem.findMany({
      where: { agencyId, creatorId, status: { not: "HIDDEN" } },
      select: { id: true, mediaId: true, mediaType: true, updatedAt: true },
      orderBy: { id: "asc" },
      take: PROJECTION_CHUNK_SIZE,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });
    if (!page.length) break;

    const ids = page.map((row) => clean(row.mediaId)).filter(Boolean);
    const used = await usedMediaIdsForBatch(db, agencyId, creatorId, ids);
    const usedAt = timestamp(used.updatedAt);
    if (Number.isFinite(usedAt)) newestEvidenceAt = Math.max(newestEvidenceAt, usedAt);

    for (const row of page) {
      const id = clean(row.mediaId);
      if (!id) continue;
      const type = normalizeMediaType(row.mediaType);
      catalogMedia += 1;
      byType.all += 1;
      byType[type] += 1;

      const rowAt = timestamp(row.updatedAt);
      if (Number.isFinite(rowAt)) newestEvidenceAt = Math.max(newestEvidenceAt, rowAt);

      if (used.ids.has(id)) {
        usedCreatorMedia += 1;
      } else {
        neverUsedByType.all += 1;
        neverUsedByType[type] += 1;
      }
    }

    if (page.length < PROJECTION_CHUNK_SIZE) break;
    const nextCursor = clean(page[page.length - 1]?.id);
    if (!nextCursor || nextCursor === cursorId) break;
    cursorId = nextCursor;
  }

  return {
    catalogMedia,
    eligibleCreatorMedia: catalogMedia,
    usedCreatorMedia,
    neverUsed: Math.max(0, catalogMedia - usedCreatorMedia),
    notApplicable: 0,
    unknown: 0,
    byType: neverUsedByType,
    catalogByType: byType,
    rebuiltAt: Number.isFinite(newestEvidenceAt)
      ? new Date(newestEvidenceAt).toISOString()
      : new Date().toISOString(),
    complete: true,
    deferred: false,
  };
}

function projectionFingerprint(messagesSnapshot, dialogs, salesUpdatedAt) {
  return [
    messagesSnapshot?.updatedAt || "",
    messagesSnapshot?.lastFullScanAt || "",
    messagesSnapshot?.lastIncrementalScanAt || "",
    dialogs.lastUpdatedAt || "",
    dialogs.lastSuccessfulScanAt || "",
    salesUpdatedAt || "",
  ].join("|");
}

async function latestSalesUpdatedAt(db, agencyId, creatorId) {
  const row = await db.vaultAssetSalesAggregate.findFirst({
    where: { agencyId, creatorId },
    orderBy: { updatedAt: "desc" },
    select: { updatedAt: true },
  });
  return iso(row?.updatedAt);
}

async function cachedProjection(db, agencyId, creatorId, fingerprint) {
  const key = `${agencyId}:${creatorId}`;
  const cached = projectionCache.get(key);
  if (cached?.fingerprint === fingerprint) return cached.projection;
  const projection = await projectionCounts(db, agencyId, creatorId);
  if (!projectionCache.has(key) && projectionCache.size >= PROJECTION_CACHE_LIMIT) {
    const oldestKey = projectionCache.keys().next().value;
    if (oldestKey) projectionCache.delete(oldestKey);
  }
  projectionCache.set(key, { fingerprint, projection });
  return projection;
}

function jobStatus(value) {
  return clean(value, 40).toUpperCase();
}

function stageFrom({ messages, dialogs, authoritative, stale }) {
  const scanStatus = jobStatus(messages?.snapshot?.scan?.status || "IDLE");
  const messagesJob = jobStatus(messages?.activeJob?.status);
  const dialogJob = jobStatus(dialogs.activeJobStatus);
  if (scanStatus === "FAILED" || dialogs.failed > 0) return "FAILED";
  if ((messagesJob === "SCHEDULED" && messages?.activeJob?.lastError) || (dialogJob === "SCHEDULED" && dialogs.lastError)) return "RETRYING";
  if (scanStatus === "PAUSED" || dialogs.paused) return "PAUSED";
  if (messagesJob === "CLAIMED" || scanStatus === "RUNNING") return "UPDATING_MESSAGES_CATALOG";
  if (dialogJob === "CLAIMED" && dialogs.discoveryActive) return "DISCOVERING_DIALOGS";
  if (dialogJob === "CLAIMED" || dialogs.historyActive || dialogs.active > 0) return "SCANNING_DIALOG_HISTORY";
  if ([messagesJob, dialogJob].some((status) => status === "SCHEDULED") || scanStatus === "QUEUED") return "WAITING_FOR_WORKER";
  if (scanStatus === "CANCELLED") return "CANCELLED";
  if (authoritative && stale) return "STALE";
  if (authoritative) return "UP_TO_DATE";
  return "NOT_SCANNED";
}

async function loadPipelineSources({ agencyId, creatorId, db }) {
  await requireCreator(db, agencyId, creatorId);
  const [messages, dialogs, salesAt] = await Promise.all([
    getVaultUnsortedState({ agencyId, creatorId, db }),
    dialogPipelineState(db, agencyId, creatorId),
    latestSalesUpdatedAt(db, agencyId, creatorId),
  ]);
  return { messages, dialogs, salesAt };
}

async function getNeverUsedPipelineState({ agencyId, creatorId, db = prisma, now = new Date(), staleAfter = null }) {
  const { messages, dialogs, salesAt } = await loadPipelineSources({ agencyId, creatorId, db });
  const messagesComplete = Boolean(messages.snapshot?.lastFullScanAt && messages.snapshot?.scan?.status === "COMPLETED");
  const dialogsComplete = Boolean(
    dialogs.discoveryCompleted
      && dialogs.active === 0
      && dialogs.failed === 0
      && dialogs.initialComplete === dialogs.discovered,
  );
  const authoritative = messagesComplete && dialogsComplete;
  const reasons = [];
  if (!messagesComplete) reasons.push("Messages catalog initial scan is incomplete");
  if (!dialogsComplete) reasons.push("dialog history initial scan is incomplete");

  const messagesAt = messages.snapshot?.lastIncrementalScanAt || messages.snapshot?.lastFullScanAt || null;
  const dialogsAt = dialogs.lastSuccessfulScanAt || null;
  const sourceOldestAt = authoritative ? oldest([messagesAt, dialogsAt]) : null;
  const thresholdMs = staleAfterMs(staleAfter);
  const nowMs = timestamp(now);
  const oldestMs = timestamp(sourceOldestAt);
  const stale = authoritative && (!Number.isFinite(oldestMs) || (Number.isFinite(nowMs) && nowMs - oldestMs >= thresholdMs));
  const staleSources = [];
  if (stale) {
    for (const [name, value] of [["Messages catalog", messagesAt], ["dialog history", dialogsAt]]) {
      const valueMs = timestamp(value);
      if (!Number.isFinite(valueMs) || nowMs - valueMs >= thresholdMs) staleSources.push(name);
    }
  }

  const stage = stageFrom({ messages, dialogs, authoritative, stale });
  const workActive = [
    "UPDATING_MESSAGES_CATALOG",
    "DISCOVERING_DIALOGS",
    "SCANNING_DIALOG_HISTORY",
    "WAITING_FOR_WORKER",
    "RETRYING",
  ].includes(stage);
  const fingerprint = projectionFingerprint(messages.snapshot, dialogs, salesAt);
  const projection = authoritative && !workActive
    ? await cachedProjection(db, agencyId, creatorId, fingerprint)
    : emptyProjection(messages.snapshot, { deferred: workActive || !authoritative });

  let progressPercent = 0;
  let progressIndeterminate = false;
  if (messagesComplete) progressPercent += 35;
  else if (["UPDATING_MESSAGES_CATALOG", "WAITING_FOR_WORKER", "RETRYING"].includes(stage)) {
    progressPercent = 5;
    progressIndeterminate = true;
  }
  if (messagesComplete && dialogs.discoveryCompleted) progressPercent = Math.max(progressPercent, 40);
  if (dialogs.discovered > 0) {
    progressPercent = Math.max(progressPercent, 40 + Math.round((dialogs.initialComplete / dialogs.discovered) * 55));
  } else if (messagesComplete && ["DISCOVERING_DIALOGS", "WAITING_FOR_WORKER"].includes(stage)) {
    progressIndeterminate = true;
  }
  if (authoritative) progressPercent = 100;

  const updatedValues = [messages.snapshot?.updatedAt, dialogs.lastUpdatedAt, projection.rebuiltAt, salesAt]
    .map(timestamp)
    .filter(Number.isFinite);

  return {
    ok: true,
    creatorId,
    pipeline: {
      creatorId,
      stage,
      authoritative,
      provisionalReason: authoritative ? null : reasons.join("; "),
      stale,
      staleReason: stale ? `${staleSources.join(", ")} older than ${Math.round(thresholdMs / 3_600_000)}h` : null,
      progressPercent: Math.max(0, Math.min(100, progressPercent)),
      progressIndeterminate,
      messagesCatalog: messages.snapshot,
      unsorted: messages.snapshot,
      dialogs: {
        discovered: dialogs.discovered,
        initialComplete: dialogs.initialComplete,
        active: dialogs.active,
        paused: dialogs.paused,
        failed: dialogs.failed,
        pagesCommitted: dialogs.pagesCommitted,
        messagesCommitted: dialogs.messagesCommitted,
        discoveryCompleted: dialogs.discoveryCompleted,
        activeJobStatus: dialogs.activeJobStatus,
        claimedByDeviceId: dialogs.claimedByDeviceId,
        leaseUntil: dialogs.leaseUntil,
        retries: dialogs.retries,
        lastError: dialogs.lastError,
        lastUpdatedAt: dialogs.lastUpdatedAt,
        lastSuccessfulScanAt: dialogs.lastSuccessfulScanAt,
      },
      freshness: {
        messagesAt: iso(messagesAt),
        dialogsAt: iso(dialogsAt),
        oldestAt: sourceOldestAt,
        staleAfterMs: thresholdMs,
      },
      projection,
      updatedAt: updatedValues.length ? new Date(Math.max(...updatedValues)).toISOString() : null,
    },
  };
}

function rowToMedia(row) {
  const type = normalizeMediaType(row.mediaType);
  return {
    id: String(row.mediaId),
    type,
    name: `${type === "unknown" ? "media" : type} #${row.mediaId}`,
    createdAt: null,
    duration: integer(row.duration, 0, 0, 24 * 60 * 60),
    thumbUrl: row.thumbUrl || "",
    previewUrl: row.thumbUrl || "",
    fullUrl: row.thumbUrl || "",
    folderIds: Array.isArray(row.folderIds) ? row.folderIds : [],
    lastSeenAt: iso(row.lastSeenAt),
  };
}

async function listVaultNeverUsedMedia({ agencyId, creatorId, offset = 0, limit = 40, type = null, db = prisma }) {
  const pipelineResult = await getNeverUsedPipelineState({ agencyId, creatorId, db });
  const pipeline = pipelineResult.pipeline;
  if (!pipeline?.authoritative) {
    return {
      ok: false,
      creatorId,
      media: [],
      total: 0,
      offset: integer(offset),
      nextOffset: integer(offset),
      hasMore: false,
      pipeline,
      code: "VAULT_NEVER_USED_NOT_AUTHORITATIVE",
      error: pipeline?.provisionalReason || "Initial Messages and dialog scans are incomplete",
    };
  }

  const safeOffset = integer(offset, 0, 0, 10_000_000);
  const safeLimit = integer(limit, 40, 1, 100);
  const mediaType = type ? normalizeMediaType(type) : null;
  const where = {
    agencyId,
    creatorId,
    status: { not: "HIDDEN" },
    ...(mediaType ? { mediaType } : {}),
  };
  const catalogTotal = await db.vaultUnsortedItem.count({ where });
  let scanOffset = safeOffset;
  const media = [];

  while (scanOffset < catalogTotal && media.length < safeLimit) {
    const rows = await db.vaultUnsortedItem.findMany({
      where,
      orderBy: [{ lastSeenAt: "desc" }, { mediaId: "desc" }],
      skip: scanOffset,
      take: Math.min(LIST_SCAN_CHUNK_SIZE, catalogTotal - scanOffset),
    });
    if (!rows.length) break;
    const used = await usedMediaIdsForBatch(db, agencyId, creatorId, rows.map((row) => String(row.mediaId)));
    let processedRows = 0;
    for (const row of rows) {
      processedRows += 1;
      if (!used.ids.has(String(row.mediaId))) media.push(rowToMedia(row));
      if (media.length >= safeLimit) break;
    }
    // nextOffset is a continuation over the Messages catalog, not a result-row
    // offset. Advance only past rows actually inspected so a dense Never Used
    // page cannot skip unprocessed candidates from an over-fetched DB batch.
    scanOffset += processedRows;
  }

  const total = mediaType
    ? number(pipeline.projection?.byType?.[mediaType])
    : number(pipeline.projection?.neverUsed);
  return {
    ok: true,
    creatorId,
    media,
    total,
    offset: safeOffset,
    nextOffset: scanOffset,
    hasMore: scanOffset < catalogTotal,
    pipeline,
  };
}

module.exports = {
  PROJECTION_CHUNK_SIZE,
  LIST_SCAN_CHUNK_SIZE,
  DEFAULT_STALE_AFTER_MS,
  PROJECTION_CACHE_LIMIT,
  getNeverUsedPipelineState,
  listVaultNeverUsedMedia,
  dialogPipelineState,
  projectionCounts,
  usedMediaIdsForBatch,
  stageFrom,
};

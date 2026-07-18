"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { scheduleJobNow } = require("./job-scheduler");

const VAULT_UNSORTED_JOB_KEY = "vault_unsorted_scan";
const VAULT_UNSORTED_PAGE_SIZE = 40;
const VAULT_UNSORTED_LISTS_PAGE_SIZE = 100;
const VAULT_UNSORTED_KNOWN_STREAK = 80;
const VAULT_UNSORTED_MAX_PAGES = 10_000;
const ACTIVE_JOB_STATUSES = ["SCHEDULED", "CLAIMED"];

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}
function integer(value, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}
function uniqueStrings(values, limit = 100_000) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const id = clean(value, 240);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}
function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function normalizeMode(value) {
  return value === "full" ? "full" : "incremental";
}
function normalizeStatus(value) {
  const status = clean(value, 40).toUpperCase();
  if (["QUEUED", "RUNNING", "PAUSED", "COMPLETED", "FAILED", "CANCELLED"].includes(status)) return status;
  return "IDLE";
}
function snapshotPayload(snapshot, patch = {}) {
  const payload = object(snapshot?.payload);
  const scan = object(payload.scan);
  return {
    schema: 3,
    kind: "vault_unsorted_snapshot",
    messagesFolderId: clean(patch.messagesFolderId ?? payload.messagesFolderId, 240),
    updatedAt: patch.updatedAt || new Date().toISOString(),
    lastFullScanAt: patch.lastFullScanAt === undefined ? (payload.lastFullScanAt || null) : patch.lastFullScanAt,
    lastIncrementalScanAt: patch.lastIncrementalScanAt === undefined ? (payload.lastIncrementalScanAt || null) : patch.lastIncrementalScanAt,
    scan: {
      status: normalizeStatus(patch.scanStatus ?? scan.status),
      mode: normalizeMode(patch.mode ?? scan.mode),
      jobId: clean(patch.jobId ?? scan.jobId, 240) || null,
      pages: integer(patch.pages ?? scan.pages),
      scanned: integer(patch.scanned ?? scan.scanned),
      knownStreak: integer(patch.knownStreak ?? scan.knownStreak),
      expectedCount: integer(patch.expectedCount ?? scan.expectedCount),
      published: patch.published === undefined ? (scan.published !== false) : patch.published === true,
      startedAt: patch.startedAt === undefined ? (scan.startedAt || null) : patch.startedAt,
      completedAt: patch.completedAt === undefined ? (scan.completedAt || null) : patch.completedAt,
      lastError: patch.lastError === undefined ? (scan.lastError || null) : patch.lastError,
    },
  };
}
function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    progress: job.progress || null,
    continuation: job.continuation || null,
    attempts: job.attempts,
    priority: job.priority,
    lastError: job.lastError || null,
    createdAt: iso(job.createdAt),
    updatedAt: iso(job.updatedAt),
    completedAt: iso(job.completedAt),
  };
}
function publicSnapshot(snapshot) {
  if (!snapshot) return null;
  const payload = snapshotPayload(snapshot);
  return {
    id: snapshot.id,
    creatorId: snapshot.creatorId,
    itemsCount: snapshot.itemsCount,
    unsortedCount: snapshot.unsortedCount,
    sortedCount: snapshot.sortedCount,
    messagesFolderId: payload.messagesFolderId,
    capturedAt: iso(snapshot.capturedAt),
    updatedAt: iso(snapshot.updatedAt),
    lastFullScanAt: payload.lastFullScanAt || null,
    lastIncrementalScanAt: payload.lastIncrementalScanAt || null,
    scan: payload.scan,
  };
}
async function loadActiveJob(db, creatorId) {
  return db.jobInstance.findFirst({
    where: { creatorId, jobKey: VAULT_UNSORTED_JOB_KEY, status: { in: ACTIVE_JOB_STATUSES } },
    orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
  });
}
async function counts(db, agencyId, creatorId) {
  const [itemsCount, unsortedCount] = await Promise.all([
    db.vaultUnsortedItem.count({ where: { agencyId, creatorId } }),
    db.vaultUnsortedItem.count({ where: { agencyId, creatorId, status: "UNSORTED" } }),
  ]);
  return { itemsCount, unsortedCount, sortedCount: Math.max(0, itemsCount - unsortedCount) };
}
async function updateSnapshot(db, { agencyId, creatorId, userId = null, patch = {}, countOverride = null }) {
  const current = await db.vaultUnsortedSnapshot.findUnique({
    where: { agencyId_creatorId: { agencyId, creatorId } },
  });
  const nextCounts = countOverride || await counts(db, agencyId, creatorId);
  const payload = snapshotPayload(current, patch);
  return db.vaultUnsortedSnapshot.upsert({
    where: { agencyId_creatorId: { agencyId, creatorId } },
    create: {
      agencyId,
      creatorId,
      payload,
      ...nextCounts,
      updatedByUserId: userId || null,
      capturedAt: new Date(),
    },
    update: {
      payload,
      ...nextCounts,
      updatedByUserId: userId || undefined,
      capturedAt: new Date(),
    },
  });
}

async function reconcileOrphanedSnapshot(db, { agencyId, creatorId, snapshot, activeJob }) {
  if (!snapshot || activeJob) return snapshot;
  const payload = snapshotPayload(snapshot);
  const scanStatus = normalizeStatus(payload.scan.status);
  if (!["RUNNING", "QUEUED"].includes(scanStatus)) return snapshot;

  // A snapshot is a projection of a durable JobInstance, never an independent
  // lock. Older failures could leave scan.status=RUNNING after the job had
  // already become terminal or disappeared. That stale flag masked dialog
  // history forever and made the UI claim that two scanners were active.
  const jobId = clean(payload.scan.jobId, 240);
  const findUnique = db.jobInstance && typeof db.jobInstance.findUnique === "function"
    ? db.jobInstance.findUnique.bind(db.jobInstance)
    : null;
  if (!jobId || !findUnique) return snapshot;

  const job = await findUnique({ where: { id: jobId } });
  if (job && ACTIVE_JOB_STATUSES.includes(String(job.status || "").toUpperCase())) return snapshot;

  const result = object(job?.result);
  const progress = object(job?.progress);
  const mode = normalizeMode(result.mode || job?.params?.mode || payload.scan.mode);
  const completedAt = iso(job?.completedAt) || new Date().toISOString();
  let patch;
  if (String(job?.status || "").toUpperCase() === "DONE") {
    patch = {
      scanStatus: "COMPLETED",
      mode,
      jobId,
      pages: integer(result.pages ?? progress.pages ?? payload.scan.pages),
      scanned: integer(result.scanned ?? progress.current ?? progress.scanned ?? payload.scan.scanned),
      knownStreak: integer(result.knownStreak ?? progress.knownStreak ?? payload.scan.knownStreak),
      completedAt,
      lastFullScanAt: mode === "full" ? completedAt : undefined,
      lastIncrementalScanAt: mode === "incremental" ? completedAt : undefined,
      lastError: null,
    };
  } else if (String(job?.status || "").toUpperCase() === "CANCELLED") {
    patch = {
      scanStatus: String(job?.lastError || "").toLowerCase().includes("paused") ? "PAUSED" : "CANCELLED",
      jobId,
      completedAt,
      lastError: null,
    };
  } else {
    patch = {
      scanStatus: "FAILED",
      jobId: jobId || null,
      completedAt,
      lastError: clean(job?.lastError, 2000) || "Messages catalog job is no longer active",
    };
  }
  return updateSnapshot(db, { agencyId, creatorId, patch });
}

async function getVaultUnsortedState({ agencyId, creatorId, db = prisma }) {
  const [loadedSnapshot, activeJob] = await Promise.all([
    db.vaultUnsortedSnapshot.findUnique({ where: { agencyId_creatorId: { agencyId, creatorId } } }),
    loadActiveJob(db, creatorId),
  ]);
  const snapshot = await reconcileOrphanedSnapshot(db, {
    agencyId,
    creatorId,
    snapshot: loadedSnapshot,
    activeJob,
  });
  return { ok: true, creatorId, snapshot: publicSnapshot(snapshot), activeJob: publicJob(activeJob) };
}

async function listVaultUnsortedMedia({ agencyId, creatorId, offset = 0, limit = 40, type = null }) {
  const safeOffset = integer(offset, 0, 0, 1_000_000);
  const safeLimit = integer(limit, 40, 1, 100);
  const mediaType = ["photo", "video", "audio", "gif", "unknown"].includes(clean(type, 20).toLowerCase())
    ? clean(type, 20).toLowerCase()
    : null;
  const where = { agencyId, creatorId, status: "UNSORTED", ...(mediaType ? { mediaType } : {}) };
  const [rows, total] = await Promise.all([
    prisma.vaultUnsortedItem.findMany({
      where,
      orderBy: [{ lastSeenAt: "desc" }, { mediaId: "desc" }],
      skip: safeOffset,
      take: safeLimit,
    }),
    prisma.vaultUnsortedItem.count({ where }),
  ]);
  const items = rows.map((row) => ({
    id: row.mediaId,
    type: row.mediaType || "unknown",
    name: `${row.mediaType || "media"} #${row.mediaId}`,
    createdAt: null,
    duration: row.duration || 0,
    thumbUrl: row.thumbUrl || "",
    previewUrl: row.thumbUrl || "",
    fullUrl: row.thumbUrl || "",
    folderIds: Array.isArray(row.folderIds) ? row.folderIds : [],
    lastSeenAt: iso(row.lastSeenAt),
  }));
  return {
    ok: true,
    creatorId,
    media: items,
    total,
    offset: safeOffset,
    nextOffset: safeOffset + items.length,
    hasMore: safeOffset + items.length < total,
  };
}

async function scheduleVaultUnsortedScan({ agencyId, creatorId, userId, mode = "incremental", source = "vault_ui", priority = 80 }) {
  const normalizedMode = normalizeMode(mode);
  const active = await loadActiveJob(prisma, creatorId);
  if (active) {
    const snapshot = await prisma.vaultUnsortedSnapshot.findUnique({ where: { agencyId_creatorId: { agencyId, creatorId } } });
    return { ok: true, created: false, reason: "already_in_flight", job: publicJob(active), snapshot: publicSnapshot(snapshot) };
  }
  const scheduled = await scheduleJobNow({
    jobKey: VAULT_UNSORTED_JOB_KEY,
    creatorId,
    agencyId,
    params: {
      mode: normalizedMode,
      source: clean(source, 80) || "vault_ui",
      pageLimit: VAULT_UNSORTED_PAGE_SIZE,
      listsLimit: VAULT_UNSORTED_LISTS_PAGE_SIZE,
      knownStreakLimit: VAULT_UNSORTED_KNOWN_STREAK,
      maxPages: VAULT_UNSORTED_MAX_PAGES,
    },
    priority: integer(priority, 80, 0, 200),
    bucketMs: 30_000,
  });
  const snapshot = await updateSnapshot(prisma, {
    agencyId,
    creatorId,
    userId,
    patch: {
      scanStatus: "QUEUED",
      mode: normalizedMode,
      jobId: scheduled.job.id,
      pages: 0,
      scanned: 0,
      knownStreak: 0,
      startedAt: new Date().toISOString(),
      completedAt: null,
      lastError: null,
    },
  });
  return { ok: true, created: scheduled.created, reason: scheduled.reason, job: publicJob(scheduled.job), snapshot: publicSnapshot(snapshot) };
}

async function pauseVaultUnsortedScan({ agencyId, creatorId, userId }) {
  const job = await loadActiveJob(prisma, creatorId);
  if (!job) return { ok: false, code: "VAULT_UNSORTED_JOB_NOT_ACTIVE", error: "Unsorted scan is not active" };
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.jobInstance.updateMany({
      where: { id: job.id, status: { in: ACTIVE_JOB_STATUSES } },
      data: {
        status: "CANCELLED",
        completedAt: now,
        lastError: "paused by user",
        claimedByDeviceId: null,
        leaseUntil: null,
        leaseTokenHash: null,
        leaseRevision: { increment: 1 },
      },
    });
    await updateSnapshot(tx, {
      agencyId,
      creatorId,
      userId,
      patch: { scanStatus: "PAUSED", jobId: job.id, completedAt: null, lastError: null },
    });
  });
  return getVaultUnsortedState({ agencyId, creatorId });
}

async function resumeVaultUnsortedScan({ agencyId, creatorId, userId }) {
  const active = await loadActiveJob(prisma, creatorId);
  if (active) return { ok: true, created: false, reason: "already_in_flight", job: publicJob(active) };
  const paused = await prisma.jobInstance.findFirst({
    where: { creatorId, agencyId, jobKey: VAULT_UNSORTED_JOB_KEY, status: "CANCELLED", lastError: "paused by user" },
    orderBy: { updatedAt: "desc" },
  });
  if (!paused) return { ok: false, code: "VAULT_UNSORTED_PAUSED_JOB_NOT_FOUND", error: "Paused Unsorted scan was not found" };
  const now = new Date();
  const job = await prisma.jobInstance.create({
    data: {
      jobKey: VAULT_UNSORTED_JOB_KEY,
      scope: "creator",
      creatorId,
      agencyId,
      idempotencyKey: `${VAULT_UNSORTED_JOB_KEY}:resume:${paused.id}:${Date.now()}`,
      params: paused.params || {},
      continuation: paused.continuation || null,
      progress: paused.progress || null,
      status: "SCHEDULED",
      priority: paused.priority || 80,
      scheduledAt: now,
      nextRunAt: now,
    },
  });
  const snapshot = await updateSnapshot(prisma, {
    agencyId,
    creatorId,
    userId,
    patch: { scanStatus: "QUEUED", jobId: job.id, completedAt: null, lastError: null },
  });
  return { ok: true, created: true, reason: "resumed", job: publicJob(job), snapshot: publicSnapshot(snapshot) };
}

async function cancelVaultUnsortedScan({ agencyId, creatorId, userId }) {
  const job = await loadActiveJob(prisma, creatorId);
  if (job) {
    await prisma.jobInstance.updateMany({
      where: { id: job.id, status: { in: ACTIVE_JOB_STATUSES } },
      data: {
        status: "CANCELLED",
        completedAt: new Date(),
        lastError: "cancelled by user",
        claimedByDeviceId: null,
        leaseUntil: null,
        leaseTokenHash: null,
        leaseRevision: { increment: 1 },
      },
    });
  }
  const snapshot = await updateSnapshot(prisma, {
    agencyId,
    creatorId,
    userId,
    patch: { scanStatus: "CANCELLED", jobId: job?.id || null, completedAt: new Date().toISOString(), lastError: null },
  });
  return { ok: true, creatorId, snapshot: publicSnapshot(snapshot), activeJob: null };
}

function normalizeChunkItem(value) {
  const row = object(value);
  const mediaId = clean(row.mediaId || row.id, 240);
  if (!mediaId) return null;
  const mediaType = ["photo", "video", "audio", "gif", "unknown"].includes(clean(row.mediaType || row.type, 20).toLowerCase())
    ? clean(row.mediaType || row.type, 20).toLowerCase()
    : "unknown";
  return {
    mediaId,
    status: row.sorted === true || clean(row.status, 30).toUpperCase() === "SORTED" ? "SORTED" : "UNSORTED",
    mediaType,
    thumbUrl: clean(row.thumbUrl || row.thumb, 4000) || null,
    duration: integer(row.duration, 0, 0, 24 * 60 * 60),
    folderIds: uniqueStrings(row.folderIds, 500),
  };
}

async function upsertVaultUnsortedItems(db, { agencyId, creatorId, jobId, items, now }) {
  if (!items.length) return;
  // Render/Neon latency made the old per-row loop the dominant cost of the
  // Messages catalog: one OF page of 40 media caused forty sequential UPSERTs.
  // PostgreSQL can apply the whole page atomically in one parameterized
  // statement. Keep the Prisma fallback only for lightweight unit-test doubles.
  if (typeof db.$executeRawUnsafe === "function") {
    const params = [];
    const rows = items.map((item) => {
      const values = [
        crypto.randomUUID(), agencyId, creatorId, item.mediaId, item.status,
        item.mediaType, item.thumbUrl, item.duration, JSON.stringify(item.folderIds),
        now, now, jobId, now, now,
      ];
      const base = params.length;
      params.push(...values);
      const refs = values.map((_, index) => `$${base + index + 1}`);
      refs[8] = `${refs[8]}::jsonb`;
      return `(${refs.join(", ")})`;
    });
    const sql = `
      INSERT INTO "VaultUnsortedItem" (
        "id", "agencyId", "creatorId", "mediaId", "status", "mediaType",
        "thumbUrl", "duration", "folderIds", "firstSeenAt", "lastSeenAt",
        "lastSeenJobId", "createdAt", "updatedAt"
      ) VALUES ${rows.join(", ")}
      ON CONFLICT ("agencyId", "creatorId", "mediaId") DO UPDATE SET
        "status" = EXCLUDED."status",
        "mediaType" = EXCLUDED."mediaType",
        "thumbUrl" = EXCLUDED."thumbUrl",
        "duration" = EXCLUDED."duration",
        "folderIds" = EXCLUDED."folderIds",
        "lastSeenAt" = EXCLUDED."lastSeenAt",
        "lastSeenJobId" = EXCLUDED."lastSeenJobId",
        "updatedAt" = EXCLUDED."updatedAt"
    `;
    await db.$executeRawUnsafe(sql, ...params);
    return;
  }
  for (const item of items) {
    await db.vaultUnsortedItem.upsert({
      where: { agencyId_creatorId_mediaId: { agencyId, creatorId, mediaId: item.mediaId } },
      create: {
        agencyId, creatorId, mediaId: item.mediaId, status: item.status,
        mediaType: item.mediaType, thumbUrl: item.thumbUrl, duration: item.duration,
        folderIds: item.folderIds, firstSeenAt: now, lastSeenAt: now,
        lastSeenJobId: jobId,
      },
      update: {
        status: item.status, mediaType: item.mediaType, thumbUrl: item.thumbUrl,
        duration: item.duration, folderIds: item.folderIds, lastSeenAt: now,
        lastSeenJobId: jobId,
      },
    });
  }
}

async function applyVaultUnsortedChunk({ db, job, userId, chunkResult }) {
  if (!job.creatorId || !job.agencyId) throw new Error("Vault Unsorted job is missing creator scope");
  const chunk = object(chunkResult);
  const kind = clean(chunk.kind, 80);
  if (kind === "vault_unsorted_begin") {
    const continuation = object(chunk.continuation);
    const mode = normalizeMode(continuation.mode || job.params?.mode);
    // A full scan is generation-based: keep the last complete projection visible
    // while the new job walks Messages, stamp every seen row with this job id,
    // and prune stale rows only in the fenced completion transaction.
    await updateSnapshot(db, {
      agencyId: job.agencyId,
      creatorId: job.creatorId,
      userId,
      patch: {
        scanStatus: "RUNNING",
        mode,
        jobId: job.id,
        messagesFolderId: continuation.messagesFolderId,
        pages: 0,
        scanned: 0,
        knownStreak: 0,
        expectedCount: integer(continuation.expectedCount),
        published: false,
        startedAt: new Date().toISOString(),
        completedAt: null,
        lastError: null,
      },
    });
    return { jobContinuationOverride: continuation, kind };
  }
  if (kind === "vault_unsorted_lists_page") {
    return { jobContinuationOverride: object(chunk.continuation), kind };
  }
  if (kind !== "vault_unsorted_media_page") {
    throw new Error(`Unsupported Vault Unsorted chunk kind: ${kind || "missing"}`);
  }

  const continuation = object(chunk.continuation);
  const mode = normalizeMode(continuation.mode || job.params?.mode);
  const items = (Array.isArray(chunk.items) ? chunk.items : []).map(normalizeChunkItem).filter(Boolean).slice(0, VAULT_UNSORTED_PAGE_SIZE);
  const ids = items.map((item) => item.mediaId);
  const existingRows = ids.length
    ? await db.vaultUnsortedItem.findMany({
        where: { agencyId: job.agencyId, creatorId: job.creatorId, mediaId: { in: ids } },
        select: { mediaId: true },
      })
    : [];
  const existing = new Set(existingRows.map((row) => row.mediaId));
  let knownStreak = integer(continuation.knownStreak, 0, 0, VAULT_UNSORTED_KNOWN_STREAK);
  const now = new Date();
  for (const item of items) {
    const wasKnown = existing.has(item.mediaId);
    knownStreak = mode === "incremental" && wasKnown ? knownStreak + 1 : 0;
  }
  await upsertVaultUnsortedItems(db, {
    agencyId: job.agencyId,
    creatorId: job.creatorId,
    jobId: job.id,
    items,
    now,
  });
  const pages = integer(continuation.pages, 0) + 1;
  const scanned = integer(continuation.scanned, 0) + items.length;
  const hasMore = chunk.hasMore === true;
  const maxPages = integer(job.params?.maxPages, VAULT_UNSORTED_MAX_PAGES, 1, VAULT_UNSORTED_MAX_PAGES);
  const knownLimit = integer(job.params?.knownStreakLimit, VAULT_UNSORTED_KNOWN_STREAK, 1, 500);
  const stopForKnown = mode === "incremental" && knownStreak >= knownLimit;
  const stopForMaxPages = pages >= maxPages;
  const nextContinuation = {
    ...continuation,
    phase: "media",
    offset: integer(chunk.nextOffset, integer(continuation.offset, 0) + items.length, 0, 10_000_000),
    pages,
    scanned,
    knownStreak,
  };
  const nextCounts = await counts(db, job.agencyId, job.creatorId);
  await updateSnapshot(db, {
    agencyId: job.agencyId,
    creatorId: job.creatorId,
    userId,
    patch: {
      scanStatus: "RUNNING",
      mode,
      jobId: job.id,
      messagesFolderId: continuation.messagesFolderId,
      pages,
      scanned,
      knownStreak,
      expectedCount: integer(continuation.expectedCount ?? chunk.expectedMediaCount),
      published: false,
      lastError: null,
    },
    countOverride: nextCounts,
  });
  const complete = !hasMore || stopForKnown || stopForMaxPages || items.length === 0;
  if (complete) {
    return {
      completeAfterCommit: true,
      completionResult: {
        mode,
        pages,
        scanned,
        knownStreak,
        expectedMediaCount: integer(continuation.expectedCount ?? chunk.expectedMediaCount),
        messagesFolderId: clean(continuation.messagesFolderId, 240),
        stoppedReason: stopForKnown ? `known_streak_${knownLimit}` : stopForMaxPages ? "max_pages" : !hasMore ? "of_has_more_false" : "empty_page",
      },
      kind,
    };
  }
  return { jobContinuationOverride: nextContinuation, kind };
}

async function applyVaultUnsortedCompletion({ db = prisma, job, userId, result }) {
  if (!job.creatorId || !job.agencyId) throw new Error("Vault Unsorted job is missing creator scope");
  const payload = object(result);
  const mode = normalizeMode(payload.mode || job.params?.mode);
  const expectedMediaCount = integer(payload.expectedMediaCount, 0, 0, 10_000_000);
  let seenByJob = 0;
  if (mode === "full") {
    seenByJob = await db.vaultUnsortedItem.count({
      where: { agencyId: job.agencyId, creatorId: job.creatorId, lastSeenJobId: job.id },
    });
    if (expectedMediaCount > 0 && seenByJob < expectedMediaCount) {
      const detail = `Messages catalog incomplete: expected ${expectedMediaCount}, received ${seenByJob}; previous complete catalog preserved`;
      const preservedCounts = await counts(db, job.agencyId, job.creatorId);
      const preservedSnapshot = await updateSnapshot(db, {
        agencyId: job.agencyId,
        creatorId: job.creatorId,
        userId,
        patch: {
          scanStatus: "FAILED",
          mode,
          jobId: job.id,
          pages: integer(payload.pages),
          scanned: integer(payload.scanned),
          knownStreak: integer(payload.knownStreak),
          expectedCount: expectedMediaCount,
          published: false,
          completedAt: new Date().toISOString(),
          lastError: detail,
        },
        countOverride: preservedCounts,
      });
      return {
        type: "vault_unsorted",
        snapshot: publicSnapshot(preservedSnapshot),
        ...payload,
        published: false,
        incomplete: true,
        expectedMediaCount,
        seenByJob,
        error: detail,
      };
    }
    await db.vaultUnsortedItem.deleteMany({
      where: { agencyId: job.agencyId, creatorId: job.creatorId, NOT: { lastSeenJobId: job.id } },
    });
  }
  const nextCounts = await counts(db, job.agencyId, job.creatorId);
  const snapshot = await updateSnapshot(db, {
    agencyId: job.agencyId,
    creatorId: job.creatorId,
    userId,
    patch: {
      scanStatus: "COMPLETED",
      mode,
      jobId: job.id,
      pages: integer(payload.pages),
      scanned: integer(payload.scanned),
      knownStreak: integer(payload.knownStreak),
      expectedCount: expectedMediaCount,
      published: true,
      completedAt: new Date().toISOString(),
      lastFullScanAt: mode === "full" ? new Date().toISOString() : undefined,
      lastIncrementalScanAt: mode === "incremental" ? new Date().toISOString() : undefined,
      lastError: null,
    },
    countOverride: nextCounts,
  });
  return { type: "vault_unsorted", snapshot: publicSnapshot(snapshot), ...payload, published: true, expectedMediaCount, seenByJob };
}

async function recordVaultUnsortedFailure({ job, error, terminal }) {
  if (!job.creatorId || !job.agencyId) return null;
  const snapshot = await updateSnapshot(prisma, {
    agencyId: job.agencyId,
    creatorId: job.creatorId,
    patch: {
      scanStatus: terminal ? "FAILED" : "QUEUED",
      mode: job.params?.mode,
      jobId: job.id,
      lastError: clean(error, 2000) || "Vault Unsorted scan failed",
      completedAt: terminal ? new Date().toISOString() : null,
    },
  });
  return { type: "vault_unsorted_failure", snapshot: publicSnapshot(snapshot) };
}

async function markVaultUnsortedItems({ agencyId, creatorId, mediaIds, status }) {
  const ids = uniqueStrings(mediaIds, 10_000);
  if (!ids.length) return { ok: true, updated: 0 };
  const normalizedStatus = clean(status, 30).toUpperCase();
  if (normalizedStatus === "HIDDEN") {
    const deleted = await prisma.vaultUnsortedItem.deleteMany({ where: { agencyId, creatorId, mediaId: { in: ids } } });
    await updateSnapshot(prisma, { agencyId, creatorId });
    return { ok: true, updated: deleted.count };
  }
  const target = normalizedStatus === "SORTED" ? "SORTED" : "UNSORTED";
  const updated = await prisma.vaultUnsortedItem.updateMany({
    where: { agencyId, creatorId, mediaId: { in: ids } },
    data: { status: target, lastSeenAt: new Date() },
  });
  await updateSnapshot(prisma, { agencyId, creatorId });
  return { ok: true, updated: updated.count };
}

module.exports = {
  VAULT_UNSORTED_JOB_KEY,
  VAULT_UNSORTED_PAGE_SIZE,
  VAULT_UNSORTED_LISTS_PAGE_SIZE,
  VAULT_UNSORTED_KNOWN_STREAK,
  getVaultUnsortedState,
  listVaultUnsortedMedia,
  scheduleVaultUnsortedScan,
  pauseVaultUnsortedScan,
  resumeVaultUnsortedScan,
  cancelVaultUnsortedScan,
  applyVaultUnsortedChunk,
  applyVaultUnsortedCompletion,
  recordVaultUnsortedFailure,
  markVaultUnsortedItems,
  publicSnapshot,
  snapshotPayload,
};

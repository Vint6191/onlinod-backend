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
    db.creatorMediaAsset.count({ where: { agencyId, creatorId, catalogActive: true } }),
    db.creatorMediaAsset.count({ where: { agencyId, creatorId, catalogActive: true, sortingStatus: "UNSORTED" } }),
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

/**
 * A running page checkpoint must not perform several snapshot round trips.
 * Full scans write to staging, so published counts cannot change until final
 * publication and are intentionally left untouched. Incremental scans mutate
 * the published catalog; one indexed aggregate inside the snapshot UPDATE
 * refreshes those counts exactly without separate COUNT/read/upsert queries.
 */
async function updateRunningSnapshotProgress(db, {
  agencyId,
  creatorId,
  userId = null,
  mode,
  jobId,
  messagesFolderId,
  pages,
  scanned,
  knownStreak,
  expectedCount,
}) {
  const normalizedMode = normalizeMode(mode);
  const updatedAt = new Date().toISOString();

  if (typeof db.$executeRawUnsafe === "function") {
    const recountPublishedCatalog = normalizedMode === "incremental";
    const countCte = recountPublishedCatalog ? `
      WITH catalog_counts AS (
        SELECT
          COUNT(*)::integer AS "itemsCount",
          COUNT(*) FILTER (WHERE "sortingStatus" = 'UNSORTED')::integer AS "unsortedCount"
        FROM "CreatorMediaAsset"
        WHERE "agencyId" = $1
          AND "creatorId" = $2
          AND "catalogActive" = true
      )
    ` : "";
    const countAssignments = recountPublishedCatalog ? `,
        "itemsCount" = catalog_counts."itemsCount",
        "unsortedCount" = catalog_counts."unsortedCount",
        "sortedCount" = GREATEST(0, catalog_counts."itemsCount" - catalog_counts."unsortedCount")
    ` : "";
    const countFrom = recountPublishedCatalog ? "FROM catalog_counts" : "";
    const updatedRows = await db.$executeRawUnsafe(`
      ${countCte}
      UPDATE "VaultUnsortedSnapshot"
      SET
        "payload" = (
          jsonb_set(
            jsonb_set(
              COALESCE("payload", '{}'::jsonb),
              '{messagesFolderId}',
              to_jsonb($3::text),
              true
            ),
            '{updatedAt}',
            to_jsonb($4::text),
            true
          )
          || jsonb_build_object(
            'scan',
            COALESCE("payload"->'scan', '{}'::jsonb)
            || jsonb_build_object(
              'status', 'RUNNING',
              'mode', $5::text,
              'jobId', $6::text,
              'pages', $7::integer,
              'scanned', $8::integer,
              'knownStreak', $9::integer,
              'expectedCount', $10::integer,
              'published', false,
              'lastError', NULL
            )
          )
        ),
        "updatedByUserId" = COALESCE(NULLIF($11::text, ''), "updatedByUserId"),
        "capturedAt" = NOW(),
        "updatedAt" = NOW()
        ${countAssignments}
      ${countFrom}
      WHERE "agencyId" = $1 AND "creatorId" = $2
    `,
    agencyId,
    creatorId,
    clean(messagesFolderId, 240),
    updatedAt,
    normalizedMode,
    clean(jobId, 240),
    integer(pages),
    integer(scanned),
    integer(knownStreak),
    integer(expectedCount),
    clean(userId, 240) || null);
    if (Number(updatedRows) > 0) return null;
  }

  // Portable fallback for tests/non-Postgres adapters and self-healing if an
  // old job somehow resumes after its snapshot row was deleted.
  return updateSnapshot(db, {
    agencyId,
    creatorId,
    userId,
    patch: {
      scanStatus: "RUNNING",
      mode: normalizedMode,
      jobId,
      messagesFolderId,
      pages,
      scanned,
      knownStreak,
      expectedCount,
      published: false,
      lastError: null,
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
  const where = { agencyId, creatorId, catalogActive: true, sortingStatus: "UNSORTED", ...(mediaType ? { mediaType } : {}) };
  const [rows, total] = await Promise.all([
    prisma.creatorMediaAsset.findMany({
      where,
      orderBy: [{ lastSeenAt: "desc" }, { mediaId: "desc" }],
      skip: safeOffset,
      take: safeLimit,
    }),
    prisma.creatorMediaAsset.count({ where }),
  ]);
  const items = rows.map((row) => ({
    id: row.mediaId,
    type: row.mediaType || "unknown",
    name: `${row.mediaType || "media"} #${row.mediaId}`,
    createdAt: null,
    duration: row.durationSec || 0,
    thumbUrl: row.thumbUrl || "",
    previewUrl: row.previewUrl || row.thumbUrl || "",
    fullUrl: row.fullUrl || row.previewUrl || row.thumbUrl || "",
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
  await prisma.mediaLibraryScanItem.updateMany({
    where: { agencyId, creatorId, jobId: paused.id },
    data: { jobId: job.id },
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
  await prisma.mediaLibraryScanItem.deleteMany({ where: { agencyId, creatorId } });
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
    previewUrl: clean(row.previewUrl || row.preview || row.thumbUrl || row.thumb, 4000) || null,
    fullUrl: clean(row.fullUrl || row.url || row.previewUrl || row.thumbUrl || row.thumb, 4000) || null,
    duration: integer(row.duration, 0, 0, 24 * 60 * 60),
    folderIds: uniqueStrings(row.folderIds, 500),
  };
}

async function upsertMediaLibraryScanItems(db, { agencyId, creatorId, jobId, mode, items, now }) {
  if (!items.length) return;
  const fullScan = mode === "full";
  // A full generation is written only to staging. The published Media Library
  // stays byte-for-byte stable until the expected count fence passes in the
  // completion transaction. Incremental pages can safely update live rows.
  if (typeof db.$executeRawUnsafe === "function") {
    const params = [];
    const rows = items.map((item) => {
      const values = fullScan
        ? [
            crypto.randomUUID(), agencyId, creatorId, item.mediaId, item.status,
            item.mediaType, item.duration, item.thumbUrl, item.previewUrl, item.fullUrl,
            JSON.stringify(item.folderIds), now, jobId, now, now,
          ]
        : [
            crypto.randomUUID(), agencyId, creatorId, item.mediaId, true, item.status,
            item.mediaType, item.duration, item.thumbUrl, item.previewUrl, item.fullUrl,
            JSON.stringify(item.folderIds), now, jobId, now, now,
          ];
      const base = params.length;
      params.push(...values);
      const refs = values.map((_, index) => `$${base + index + 1}`);
      refs[fullScan ? 10 : 11] = `${refs[fullScan ? 10 : 11]}::jsonb`;
      return `(${refs.join(", ")})`;
    });
    const sql = fullScan ? `
      INSERT INTO "MediaLibraryScanItem" (
        "id", "agencyId", "creatorId", "mediaId", "sortingStatus", "mediaType",
        "durationSec", "thumbUrl", "previewUrl", "fullUrl", "folderIds",
        "seenAt", "jobId", "createdAt", "updatedAt"
      ) VALUES ${rows.join(", ")}
      ON CONFLICT ("jobId", "mediaId") DO UPDATE SET
        "sortingStatus" = EXCLUDED."sortingStatus",
        "mediaType" = EXCLUDED."mediaType",
        "durationSec" = EXCLUDED."durationSec",
        "thumbUrl" = EXCLUDED."thumbUrl",
        "previewUrl" = EXCLUDED."previewUrl",
        "fullUrl" = EXCLUDED."fullUrl",
        "folderIds" = EXCLUDED."folderIds",
        "seenAt" = EXCLUDED."seenAt",
        "updatedAt" = EXCLUDED."updatedAt"
    ` : `
      INSERT INTO "CreatorMediaAsset" (
        "id", "agencyId", "creatorId", "mediaId", "catalogActive", "sortingStatus", "mediaType",
        "durationSec", "thumbUrl", "previewUrl", "fullUrl", "folderIds",
        "lastSeenAt", "lastSeenJobId", "createdAt", "updatedAt"
      ) VALUES ${rows.join(", ")}
      ON CONFLICT ("creatorId", "mediaId") DO UPDATE SET
        "agencyId" = EXCLUDED."agencyId",
        "catalogActive" = true,
        "sortingStatus" = EXCLUDED."sortingStatus",
        "mediaType" = EXCLUDED."mediaType",
        "durationSec" = EXCLUDED."durationSec",
        "thumbUrl" = EXCLUDED."thumbUrl",
        "previewUrl" = EXCLUDED."previewUrl",
        "fullUrl" = EXCLUDED."fullUrl",
        "folderIds" = EXCLUDED."folderIds",
        "lastSeenAt" = EXCLUDED."lastSeenAt",
        "lastSeenJobId" = EXCLUDED."lastSeenJobId",
        "updatedAt" = EXCLUDED."updatedAt"
    `;
    await db.$executeRawUnsafe(sql, ...params);
    return;
  }
  for (const item of items) {
    const data = {
      agencyId,
      creatorId,
      mediaId: item.mediaId,
      sortingStatus: item.status,
      mediaType: item.mediaType,
      durationSec: item.duration,
      thumbUrl: item.thumbUrl,
      previewUrl: item.previewUrl,
      fullUrl: item.fullUrl,
      folderIds: item.folderIds,
    };
    if (fullScan) {
      await db.mediaLibraryScanItem.upsert({
        where: { jobId_mediaId: { jobId, mediaId: item.mediaId } },
        create: { ...data, jobId, seenAt: now },
        update: { ...data, seenAt: now },
      });
    } else {
      await db.creatorMediaAsset.upsert({
        where: { creatorId_mediaId: { creatorId, mediaId: item.mediaId } },
        create: { ...data, catalogActive: true, firstSeenAt: now, lastSeenAt: now, lastSeenJobId: jobId },
        update: { ...data, catalogActive: true, lastSeenAt: now, lastSeenJobId: jobId },
      });
    }
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
    if (mode === "full") {
      await db.mediaLibraryScanItem.deleteMany({
        where: { agencyId: job.agencyId, creatorId: job.creatorId },
      });
    }
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
  // Full scans write to staging and never use known-streak detection. Avoid a
  // pointless read from the published catalog on every full-scan page.
  const existingRows = mode === "incremental" && ids.length
    ? await db.creatorMediaAsset.findMany({
        where: { agencyId: job.agencyId, creatorId: job.creatorId, catalogActive: true, mediaId: { in: ids } },
        select: { mediaId: true },
      })
    : [];
  const existing = new Set(existingRows.map((row) => String(row.mediaId)));
  let knownStreak = integer(continuation.knownStreak, 0, 0, VAULT_UNSORTED_KNOWN_STREAK);
  const now = new Date();
  for (const item of items) {
    const wasKnown = existing.has(item.mediaId);
    knownStreak = mode === "incremental" && wasKnown ? knownStreak + 1 : 0;
  }
  await upsertMediaLibraryScanItems(db, {
    agencyId: job.agencyId,
    creatorId: job.creatorId,
    jobId: job.id,
    mode,
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
  await updateRunningSnapshotProgress(db, {
    agencyId: job.agencyId,
    creatorId: job.creatorId,
    userId,
    mode,
    jobId: job.id,
    messagesFolderId: continuation.messagesFolderId,
    pages,
    scanned,
    knownStreak,
    expectedCount: integer(continuation.expectedCount ?? chunk.expectedMediaCount),
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

async function publishFullGeneration(db, job) {
  if (typeof db.$executeRawUnsafe === "function") {
    await db.$executeRawUnsafe(`
      INSERT INTO "CreatorMediaAsset" (
        "id", "agencyId", "creatorId", "mediaId", "catalogActive",
        "sortingStatus", "mediaType", "durationSec", "thumbUrl", "previewUrl",
        "fullUrl", "folderIds", "firstSeenAt", "lastSeenAt", "lastSeenJobId",
        "createdAt", "updatedAt"
      )
      SELECT
        stage."id", stage."agencyId", stage."creatorId", stage."mediaId", true,
        stage."sortingStatus", stage."mediaType", stage."durationSec",
        stage."thumbUrl", stage."previewUrl", stage."fullUrl", stage."folderIds",
        stage."seenAt", stage."seenAt", stage."jobId", stage."createdAt", stage."updatedAt"
      FROM "MediaLibraryScanItem" stage
      WHERE stage."agencyId" = $1 AND stage."creatorId" = $2 AND stage."jobId" = $3
      ON CONFLICT ("creatorId", "mediaId") DO UPDATE SET
        "agencyId" = EXCLUDED."agencyId",
        "catalogActive" = true,
        "sortingStatus" = EXCLUDED."sortingStatus",
        "mediaType" = EXCLUDED."mediaType",
        "durationSec" = EXCLUDED."durationSec",
        "thumbUrl" = EXCLUDED."thumbUrl",
        "previewUrl" = EXCLUDED."previewUrl",
        "fullUrl" = EXCLUDED."fullUrl",
        "folderIds" = EXCLUDED."folderIds",
        "lastSeenAt" = EXCLUDED."lastSeenAt",
        "lastSeenJobId" = EXCLUDED."lastSeenJobId",
        "updatedAt" = EXCLUDED."updatedAt"
    `, job.agencyId, job.creatorId, job.id);
    await db.$executeRawUnsafe(`
      DELETE FROM "CreatorMediaAsset" asset
      WHERE asset."agencyId" = $1
        AND asset."creatorId" = $2
        AND NOT EXISTS (
          SELECT 1
          FROM "MediaLibraryScanItem" stage
          WHERE stage."jobId" = $3
            AND stage."agencyId" = asset."agencyId"
            AND stage."creatorId" = asset."creatorId"
            AND stage."mediaId" = asset."mediaId"
        )
    `, job.agencyId, job.creatorId, job.id);
    await db.mediaLibraryScanItem.deleteMany({ where: { jobId: job.id } });
    return;
  }

  const rows = await db.mediaLibraryScanItem.findMany({
    where: { agencyId: job.agencyId, creatorId: job.creatorId, jobId: job.id },
    take: 10_000_000,
  });
  for (const row of rows) {
    await db.creatorMediaAsset.upsert({
      where: { creatorId_mediaId: { creatorId: job.creatorId, mediaId: row.mediaId } },
      create: {
        agencyId: job.agencyId,
        creatorId: job.creatorId,
        mediaId: row.mediaId,
        catalogActive: true,
        sortingStatus: row.sortingStatus,
        mediaType: row.mediaType,
        durationSec: row.durationSec,
        thumbUrl: row.thumbUrl,
        previewUrl: row.previewUrl,
        fullUrl: row.fullUrl,
        folderIds: row.folderIds,
        firstSeenAt: row.seenAt,
        lastSeenAt: row.seenAt,
        lastSeenJobId: job.id,
      },
      update: {
        catalogActive: true,
        sortingStatus: row.sortingStatus,
        mediaType: row.mediaType,
        durationSec: row.durationSec,
        thumbUrl: row.thumbUrl,
        previewUrl: row.previewUrl,
        fullUrl: row.fullUrl,
        folderIds: row.folderIds,
        lastSeenAt: row.seenAt,
        lastSeenJobId: job.id,
      },
    });
  }
  await db.creatorMediaAsset.deleteMany({
    where: {
      agencyId: job.agencyId,
      creatorId: job.creatorId,
      mediaId: { notIn: rows.map((row) => row.mediaId) },
    },
  });
  await db.mediaLibraryScanItem.deleteMany({ where: { jobId: job.id } });
}

async function applyVaultUnsortedCompletion({ db = prisma, job, userId, result }) {
  if (!job.creatorId || !job.agencyId) throw new Error("Vault Unsorted job is missing creator scope");
  const payload = object(result);
  const mode = normalizeMode(payload.mode || job.params?.mode);
  const expectedMediaCount = integer(payload.expectedMediaCount, 0, 0, 10_000_000);
  let seenByJob = 0;
  if (mode === "full") {
    seenByJob = await db.mediaLibraryScanItem.count({
      where: { agencyId: job.agencyId, creatorId: job.creatorId, jobId: job.id },
    });
    if (expectedMediaCount > 0 && seenByJob < expectedMediaCount) {
      const detail = `Messages catalog incomplete: expected ${expectedMediaCount}, received ${seenByJob}; previous complete catalog preserved`;
      await db.mediaLibraryScanItem.deleteMany({ where: { jobId: job.id } });
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
    await publishFullGeneration(db, job);
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
  if (terminal) await prisma.mediaLibraryScanItem.deleteMany({ where: { jobId: job.id } });
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
  publicSnapshot,
  snapshotPayload,
};

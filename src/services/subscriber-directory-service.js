"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { refreshFollowBackProjection } = require("./follow-back-service");

const SUBSCRIBER_DIRECTORY_JOB_KEY = "subscriber_directory_scan";
const ACTIVE_RUN_STATUSES = ["QUEUED", "RUNNING"];
const DEFAULT_SCAN_EVERY_DAYS = 7;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 100;
const MAX_PAGE_ITEMS = 100;
const MAX_HIDDEN_LIST_LIMIT = 500;

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}
function integer(value, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}
function boolOrNull(value) {
  return typeof value === "boolean" ? value : null;
}
function dateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function asNumber(value) {
  if (typeof value === "bigint") return Number(value);
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
function hashJson(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function normalizeStatus(value) {
  const status = String(value || "active").toLowerCase();
  return ["active", "ignored", "blocked"].includes(status) ? status : "active";
}
function runSummary(run) {
  if (!run) return null;
  return {
    id: run.id,
    jobId: run.jobId,
    mode: run.mode,
    sourceType: run.sourceType,
    status: run.status,
    pageLimit: run.pageLimit,
    nextOffset: run.nextOffset,
    scannedCount: run.scannedCount,
    pageCount: run.pageCount,
    hiddenCount: run.hiddenCount,
    hasMore: run.hasMore,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    publishedAt: run.publishedAt,
    lastError: run.lastError,
    summary: run.summary || {},
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

async function scheduleSubscriberScan({
  agencyId,
  creatorId,
  userId = null,
  manual = false,
  force = false,
  mode = "full",
  sourceType = "all",
  pageLimit = DEFAULT_PAGE_LIMIT,
  scanEveryDays = DEFAULT_SCAN_EVERY_DAYS,
  priority = 20,
  reason = "subscriber_directory_refresh",
} = {}) {
  if (!agencyId || !creatorId)
    throw Object.assign(new Error("Creator scope is required"), { code: "CREATOR_SCOPE_REQUIRED" });
  const now = new Date();
  const normalizedLimit = integer(pageLimit, DEFAULT_PAGE_LIMIT, 20, MAX_PAGE_LIMIT);
  const normalizedEveryDays = integer(scanEveryDays, DEFAULT_SCAN_EVERY_DAYS, 1, 30);

  const active = await prisma.subscriberScanRun.findFirst({
    where: { agencyId, creatorId, status: { in: ACTIVE_RUN_STATUSES } },
    orderBy: { createdAt: "desc" },
  });
  if (active) {
    const job = active.jobId ? await prisma.jobInstance.findUnique({ where: { id: active.jobId } }) : null;
    if (job && ["SCHEDULED", "CLAIMED"].includes(job.status)) {
      return { ok: true, created: false, reason: "already_in_flight", run: runSummary(active), job };
    }
  }

  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      if (active) {
        await tx.subscriberScanRun.updateMany({
          where: { id: active.id, status: { in: ACTIVE_RUN_STATUSES } },
          data: {
            status: "FAILED",
            completedAt: now,
            lastError: "orphaned scan superseded before scheduling a new run",
          },
        });
      }
      const run = await tx.subscriberScanRun.create({
        data: {
          agencyId,
          creatorId,
          mode: clean(mode, 40) || "full",
          sourceType: clean(sourceType, 40) || "all",
          status: "QUEUED",
          pageLimit: normalizedLimit,
          createdByUserId: userId,
          summary: {
            manual: manual === true,
            force: force === true,
            reason: clean(reason, 160) || "subscriber_directory_refresh",
          },
        },
      });
      const job = await tx.jobInstance.create({
        data: {
          jobKey: SUBSCRIBER_DIRECTORY_JOB_KEY,
          scope: "creator",
          creatorId,
          agencyId,
          idempotencyKey: `${SUBSCRIBER_DIRECTORY_JOB_KEY}:${creatorId}:${run.id}`,
          params: {
            scanRunId: run.id,
            mode: run.mode,
            sourceType: run.sourceType,
            pageLimit: normalizedLimit,
            scanEveryDays: normalizedEveryDays,
            reason: clean(reason, 160) || "subscriber_directory_refresh",
          },
          status: "SCHEDULED",
          priority: integer(priority, 20, 0, 200),
          scheduledAt: now,
          nextRunAt: now,
        },
      });
      const linkedRun = await tx.subscriberScanRun.update({ where: { id: run.id }, data: { jobId: job.id } });
      await tx.subscriberDirectoryState.upsert({
        where: { creatorId },
        create: {
          agencyId,
          creatorId,
          lastJobId: job.id,
          status: "SCANNING",
          scanEveryDays: normalizedEveryDays,
          summary: { activeRunId: run.id, reason: clean(reason, 160) || null },
        },
        update: {
          lastJobId: job.id,
          status: "SCANNING",
          scanEveryDays: normalizedEveryDays,
          lastError: null,
          summary: { activeRunId: run.id, reason: clean(reason, 160) || null },
        },
      });
      return { run: linkedRun, job };
    });
  } catch (error) {
    // The migration adds a partial unique index for one QUEUED/RUNNING run per
    // creator. This closes the multi-process race between scheduler/manual scan.
    if (error?.code !== "P2002") throw error;
    const concurrentRun = await prisma.subscriberScanRun.findFirst({
      where: { agencyId, creatorId, status: { in: ACTIVE_RUN_STATUSES } },
      orderBy: { createdAt: "desc" },
    });
    const concurrentJob = concurrentRun?.jobId
      ? await prisma.jobInstance.findUnique({ where: { id: concurrentRun.jobId } })
      : null;
    if (!concurrentRun) throw error;
    return {
      ok: true,
      created: false,
      reason: "concurrent_scan_won",
      run: runSummary(concurrentRun),
      job: concurrentJob,
    };
  }

  return { ok: true, created: true, reason: "created", run: runSummary(result.run), job: result.job };
}

async function ensureSubscriberScanDue({ agencyId, creatorId, priority = 10, now = new Date() } = {}) {
  const state = await prisma.subscriberDirectoryState.findUnique({ where: { creatorId } });
  if (state?.nextScanAt && state.nextScanAt > now)
    return { ok: true, created: false, reason: "not_due", nextScanAt: state.nextScanAt };
  return scheduleSubscriberScan({
    agencyId,
    creatorId,
    priority,
    scanEveryDays: state?.scanEveryDays || DEFAULT_SCAN_EVERY_DAYS,
    reason: state ? "subscriber_directory_due" : "subscriber_directory_initial",
  });
}

function normalizeChunkItem(item, { runId, agencyId, creatorId, observedAt }) {
  const raw = object(item);
  const fanId = clean(raw.fanId ?? raw.userId ?? raw.id, 120);
  if (!fanId) return null;
  const lastSeenIsNull = raw.lastSeenIsNull === true;
  const normalized = {
    runId,
    agencyId,
    creatorId,
    fanId,
    dialogId: clean(raw.dialogId ?? raw.withUserId ?? fanId, 120),
    username: clean(raw.username, 160),
    name: clean(raw.name ?? raw.displayName, 240),
    avatarUrl: clean(raw.avatarUrl ?? raw.avatar, 1000),
    totalSpentCents: integer(raw.totalSpentCents, 0, 0, 2_000_000_000),
    lastSeenAt: dateOrNull(raw.lastSeenAt),
    lastSeenIsNull,
    canReceiveChatMessage: boolOrNull(raw.canReceiveChatMessage),
    isActive: boolOrNull(raw.isActive),
    subscribedOn: boolOrNull(raw.subscribedOn),
    subscribedBy: boolOrNull(raw.subscribedBy),
    subscriptionType: clean(raw.subscriptionType ?? raw.type, 80),
    metadata: object(raw.metadata),
    observedAt,
  };
  normalized.contentHash =
    clean(raw.contentHash, 128) ||
    hashJson({
      fanId: normalized.fanId,
      dialogId: normalized.dialogId,
      username: normalized.username,
      name: normalized.name,
      avatarUrl: normalized.avatarUrl,
      totalSpentCents: normalized.totalSpentCents,
      lastSeenAt: normalized.lastSeenAt?.toISOString?.() || null,
      lastSeenIsNull: normalized.lastSeenIsNull,
      canReceiveChatMessage: normalized.canReceiveChatMessage,
      isActive: normalized.isActive,
      subscribedOn: normalized.subscribedOn,
      subscribedBy: normalized.subscribedBy,
      subscriptionType: normalized.subscriptionType,
    });
  return normalized;
}

async function scalarCount(db, sql, ...params) {
  const rows = await db.$queryRawUnsafe(sql, ...params);
  return asNumber(rows?.[0]?.count);
}

async function publishRun(db, run, { jobId, scanEveryDays }) {
  const now = new Date();
  const state = await db.subscriberDirectoryState.findUnique({ where: { creatorId: run.creatorId } });
  const previousRunId = state?.currentRunId && state.currentRunId !== run.id ? state.currentRunId : null;
  const totalCount = await db.subscriberScanItem.count({ where: { runId: run.id } });
  // Preserve alpha semantics exactly: a hidden-online candidate is a subscriber
  // whose payload explicitly contains lastSeen: null. Messaging/activity flags
  // are metadata for later eligibility rules, not discovery exclusions.
  const hiddenCount = await db.subscriberScanItem.count({
    where: { runId: run.id, lastSeenIsNull: true },
  });
  let addedCount = totalCount;
  let changedCount = 0;
  let disappearedCount = 0;
  if (previousRunId) {
    addedCount = await scalarCount(
      db,
      `SELECT COUNT(*)::bigint AS count FROM "SubscriberScanItem" c LEFT JOIN "SubscriberScanItem" p ON p."runId" = $2 AND p."fanId" = c."fanId" WHERE c."runId" = $1 AND p."id" IS NULL`,
      run.id,
      previousRunId
    );
    changedCount = await scalarCount(
      db,
      `SELECT COUNT(*)::bigint AS count FROM "SubscriberScanItem" c JOIN "SubscriberScanItem" p ON p."runId" = $2 AND p."fanId" = c."fanId" WHERE c."runId" = $1 AND c."contentHash" <> p."contentHash"`,
      run.id,
      previousRunId
    );
    disappearedCount = await scalarCount(
      db,
      `SELECT COUNT(*)::bigint AS count FROM "SubscriberScanItem" p LEFT JOIN "SubscriberScanItem" c ON c."runId" = $1 AND c."fanId" = p."fanId" WHERE p."runId" = $2 AND c."id" IS NULL`,
      run.id,
      previousRunId
    );
  }
  const nextScanAt = new Date(
    now.getTime() + integer(scanEveryDays, DEFAULT_SCAN_EVERY_DAYS, 1, 30) * 24 * 60 * 60 * 1000
  );
  const summary = {
    totalCount,
    hiddenCount,
    addedCount,
    changedCount,
    disappearedCount,
    currentRunId: run.id,
    previousRunId,
  };

  await db.subscriberDirectoryState.upsert({
    where: { creatorId: run.creatorId },
    create: {
      agencyId: run.agencyId,
      creatorId: run.creatorId,
      currentRunId: run.id,
      previousRunId,
      lastJobId: jobId,
      status: "READY",
      scanEveryDays: integer(scanEveryDays, DEFAULT_SCAN_EVERY_DAYS, 1, 30),
      nextScanAt,
      publishedAt: now,
      totalCount,
      hiddenCount,
      addedCount,
      changedCount,
      disappearedCount,
      summary,
    },
    update: {
      currentRunId: run.id,
      previousRunId,
      lastJobId: jobId,
      status: "READY",
      nextScanAt,
      publishedAt: now,
      totalCount,
      hiddenCount,
      addedCount,
      changedCount,
      disappearedCount,
      summary,
      lastError: null,
    },
  });

  await db.subscriberScanRun.update({
    where: { id: run.id },
    data: { status: "PUBLISHED", completedAt: now, publishedAt: now, hasMore: false, summary },
  });
  if (previousRunId) {
    await db.subscriberScanRun.updateMany({
      where: { id: previousRunId, status: "PUBLISHED" },
      data: { status: "SUPERSEDED" },
    });
  }

  // HiddenOnlineUser is a compact projection/override table. Existing ignored
  // and blocked choices are preserved while current candidates are refreshed.
  await db.$executeRawUnsafe(
    `
    INSERT INTO "HiddenOnlineUser" (
      "id", "agencyId", "creatorId", "fanId", "dialogId", "username", "name",
      "totalSpentCents", "status", "signals", "metadata", "lastSignalAt", "createdAt", "updatedAt"
    )
    SELECT
      'hidden_' || md5(i."creatorId" || ':' || i."fanId"), i."agencyId", i."creatorId", i."fanId",
      i."dialogId", i."username", i."name", i."totalSpentCents", 'active', '["lastSeen:null"]'::jsonb,
      jsonb_build_object(
        'source', 'subscriber_directory', 'scanRunId', i."runId", 'lastSeen', NULL,
        'avatar', i."avatarUrl", 'canReceiveChatMessage', i."canReceiveChatMessage",
        'isActive', i."isActive", 'subscribedOn', i."subscribedOn", 'subscribedBy', i."subscribedBy"
      ), $2, $2, $2
    FROM "SubscriberScanItem" i
    WHERE i."runId" = $1
      AND i."lastSeenIsNull" = true
    ON CONFLICT ("creatorId", "fanId") DO UPDATE SET
      "dialogId" = EXCLUDED."dialogId",
      "username" = EXCLUDED."username",
      "name" = EXCLUDED."name",
      "totalSpentCents" = EXCLUDED."totalSpentCents",
      "status" = CASE WHEN "HiddenOnlineUser"."status" IN ('ignored', 'blocked') THEN "HiddenOnlineUser"."status" ELSE 'active' END,
      "signals" = EXCLUDED."signals",
      "metadata" = COALESCE("HiddenOnlineUser"."metadata", '{}'::jsonb) || EXCLUDED."metadata",
      "lastSignalAt" = EXCLUDED."lastSignalAt",
      "updatedAt" = EXCLUDED."updatedAt"
  `,
    run.id,
    now
  );

  await db.$executeRawUnsafe(
    `
    UPDATE "HiddenOnlineUser" h
    SET "status" = 'removed', "updatedAt" = $3,
        "metadata" = COALESCE(h."metadata", '{}'::jsonb) || jsonb_build_object('removedByScanRunId', $1)
    WHERE h."agencyId" = $2 AND h."creatorId" = $4 AND h."status" = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM "SubscriberScanItem" i
        WHERE i."runId" = $1 AND i."fanId" = h."fanId"
          AND i."lastSeenIsNull" = true
      )
  `,
    run.id,
    run.agencyId,
    now,
    run.creatorId
  );

  const followBackProjection = await refreshFollowBackProjection({
    db,
    agencyId: run.agencyId,
    creatorId: run.creatorId,
    runId: run.id,
  });

  return { ...summary, followBackProjection };
}

async function applySubscriberScanChunk({ db, job, chunkResult }) {
  if (job.jobKey !== SUBSCRIBER_DIRECTORY_JOB_KEY) return null;
  const chunk = object(chunkResult);
  if (chunk.kind !== "subscriber_directory_page") throw new Error("Unsupported subscriber directory chunk");
  const runId = clean(chunk.scanRunId, 120);
  if (!runId || runId !== clean(job.params?.scanRunId, 120)) throw new Error("Subscriber scan run mismatch");
  const run = await db.subscriberScanRun.findUnique({ where: { id: runId } });
  if (!run || run.creatorId !== job.creatorId || run.agencyId !== job.agencyId)
    throw new Error("Subscriber scan run is outside job scope");
  if (["PUBLISHED", "SUPERSEDED"].includes(run.status))
    return { duplicate: true, published: true, summary: run.summary || {} };

  const offset = integer(chunk.offset, 0, 0, 10_000_000);
  const nextOffset = integer(chunk.nextOffset, offset, offset, 10_000_000);
  const hasMore = chunk.hasMore === true;
  const itemsInput = Array.isArray(chunk.items) ? chunk.items.slice(0, MAX_PAGE_ITEMS) : [];
  const observedAt = dateOrNull(chunk.observedAt) || new Date();
  const items = itemsInput
    .map((item) => normalizeChunkItem(item, { runId, agencyId: run.agencyId, creatorId: run.creatorId, observedAt }))
    .filter(Boolean);
  const contentHash = clean(chunk.contentHash, 128) || hashJson(items.map((item) => [item.fanId, item.contentHash]));
  const existingPage = await db.subscriberScanPage.findUnique({ where: { runId_offset: { runId, offset } } });
  if (existingPage) {
    return {
      duplicate: true,
      published: run.status === "PUBLISHED",
      nextOffset: existingPage.nextOffset,
      hasMore: existingPage.hasMore,
    };
  }
  const hiddenCount = items.filter((item) => item.lastSeenIsNull).length;
  await db.subscriberScanPage.create({
    data: { runId, offset, nextOffset, itemCount: items.length, hiddenCount, hasMore, contentHash },
  });
  if (items.length) await db.subscriberScanItem.createMany({ data: items, skipDuplicates: true });
  const updatedRun = await db.subscriberScanRun.update({
    where: { id: runId },
    data: {
      status: "RUNNING",
      startedAt: run.startedAt || new Date(),
      nextOffset,
      scannedCount: { increment: items.length },
      pageCount: { increment: 1 },
      hiddenCount: { increment: hiddenCount },
      hasMore,
      lastError: null,
    },
  });
  if (hasMore)
    return {
      duplicate: false,
      published: false,
      nextOffset,
      hasMore,
      scannedCount: updatedRun.scannedCount,
      pageCount: updatedRun.pageCount,
    };
  const summary = await publishRun(db, updatedRun, { jobId: job.id, scanEveryDays: job.params?.scanEveryDays });
  return { duplicate: false, published: true, nextOffset, hasMore: false, summary };
}

async function applySubscriberScanCompletion({ job, result }) {
  const runId = clean(job.params?.scanRunId, 120);
  const run = runId ? await prisma.subscriberScanRun.findUnique({ where: { id: runId } }) : null;
  if (!run || run.status !== "PUBLISHED")
    throw new Error("Subscriber directory snapshot was not published before job completion");
  return { type: "subscriber_directory", runId: run.id, summary: run.summary || {}, result: object(result) };
}

async function recordSubscriberScanFailure({ job, error, terminal = true }) {
  const runId = clean(job.params?.scanRunId, 120);
  if (!runId) return null;
  const errorText = clean(error, 2000) || "subscriber scan failed";
  const now = new Date();
  const existing = await prisma.subscriberScanRun.findUnique({ where: { id: runId } }).catch(() => null);
  // A final progress request may have committed and published before its HTTP
  // response was lost. Never downgrade an immutable published snapshot.
  if (!existing || ["PUBLISHED", "SUPERSEDED"].includes(existing.status)) return existing;
  const run = await prisma.subscriberScanRun
    .update({
      where: { id: runId },
      data: terminal
        ? { status: "FAILED", completedAt: now, lastError: errorText }
        : { status: "RUNNING", lastError: errorText },
    })
    .catch(() => null);
  if (run) {
    await prisma.subscriberDirectoryState.upsert({
      where: { creatorId: run.creatorId },
      create: {
        agencyId: run.agencyId,
        creatorId: run.creatorId,
        status: terminal ? "FAILED" : "SCANNING",
        lastJobId: job.id,
        lastError: errorText,
      },
      update: { status: terminal ? "FAILED" : "SCANNING", lastJobId: job.id, lastError: errorText },
    });
  }
  return run;
}

async function cleanupSubscriberScanHistory({ creatorId, keep = 2 } = {}) {
  const state = await prisma.subscriberDirectoryState.findUnique({ where: { creatorId } });
  const keepIds = new Set([state?.currentRunId, state?.previousRunId].filter(Boolean));
  const old = await prisma.subscriberScanRun.findMany({
    where: {
      creatorId,
      status: { in: ["SUPERSEDED", "FAILED"] },
      ...(keepIds.size ? { id: { notIn: [...keepIds] } } : {}),
    },
    orderBy: { createdAt: "desc" },
    skip: Math.max(0, keep),
    select: { id: true },
    take: 50,
  });
  if (old.length) await prisma.subscriberScanRun.deleteMany({ where: { id: { in: old.map((item) => item.id) } } });
  return { deletedRuns: old.length };
}

async function getSubscriberDirectoryStatus({ agencyId, creatorId }) {
  const [state, activeRun, latestRun, job] = await Promise.all([
    prisma.subscriberDirectoryState.findFirst({ where: { agencyId, creatorId } }),
    prisma.subscriberScanRun.findFirst({
      where: { agencyId, creatorId, status: { in: ACTIVE_RUN_STATUSES } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.subscriberScanRun.findFirst({ where: { agencyId, creatorId }, orderBy: { createdAt: "desc" } }),
    prisma.jobInstance.findFirst({
      where: { agencyId, creatorId, jobKey: SUBSCRIBER_DIRECTORY_JOB_KEY },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  const run = activeRun || latestRun;
  return {
    ok: true,
    creatorId,
    state: state || null,
    run: runSummary(run),
    job: job
      ? {
          id: job.id,
          status: job.status,
          progress: job.progress || null,
          attempts: job.attempts,
          nextRunAt: job.nextRunAt,
          claimedAt: job.claimedAt,
          leaseUntil: job.leaseUntil,
          lastError: job.lastError,
          updatedAt: job.updatedAt,
        }
      : null,
    scanning: Boolean(activeRun || job?.status === "SCHEDULED" || job?.status === "CLAIMED"),
    fresh: Boolean(state?.publishedAt && (!state.nextScanAt || state.nextScanAt > new Date())),
  };
}

async function listHiddenOnline({
  agencyId,
  creatorId,
  status = "active",
  search = "",
  offset = 0,
  limit = 100,
  sort = "spent_desc",
}) {
  const state = await prisma.subscriberDirectoryState.findFirst({ where: { agencyId, creatorId } });
  if (!state?.currentRunId)
    return { ok: true, creatorId, items: [], count: 0, offset: 0, nextOffset: 0, hasMore: false, state: state || null };

  const normalizedStatus = ["active", "ignored", "blocked", "all"].includes(String(status || "active").toLowerCase())
    ? String(status || "active").toLowerCase()
    : "active";
  const query = clean(search, 160) || "";
  const take = integer(limit, 100, 1, MAX_HIDDEN_LIST_LIMIT);
  const skip = integer(offset, 0, 0, 10_000_000);
  const orderSql =
    sort === "name"
      ? `COALESCE(i."name", i."username", i."fanId") ASC, i."fanId" ASC`
      : sort === "recent"
        ? `i."observedAt" DESC, i."fanId" ASC`
        : `i."totalSpentCents" DESC, i."observedAt" DESC, i."fanId" ASC`;

  // Join the compact override table in SQL. Avoid loading every ignored/blocked
  // fan into memory or producing a huge NOT IN list for large creator accounts.
  const baseSql = `
    FROM "SubscriberScanItem" i
    LEFT JOIN "HiddenOnlineUser" h
      ON h."agencyId" = $2 AND h."creatorId" = $3 AND h."fanId" = i."fanId"
    WHERE i."runId" = $1
      AND i."lastSeenIsNull" = true
      AND ($4 = 'all' OR (CASE WHEN h."status" IN ('ignored', 'blocked') THEN h."status" ELSE 'active' END) = $4)
      AND (
        $5 = '' OR i."fanId" ILIKE ('%' || $5 || '%')
        OR COALESCE(i."username", '') ILIKE ('%' || $5 || '%')
        OR COALESCE(i."name", '') ILIKE ('%' || $5 || '%')
      )`;

  const [rows, countRows] = await Promise.all([
    prisma.$queryRawUnsafe(
      `
      SELECT
        i."fanId", i."dialogId", i."username", i."name", i."avatarUrl",
        i."totalSpentCents", i."lastSeenAt", i."lastSeenIsNull",
        i."canReceiveChatMessage", i."isActive", i."subscribedOn", i."subscribedBy",
        i."subscriptionType", i."observedAt",
        (CASE WHEN h."status" IN ('ignored', 'blocked') THEN h."status" ELSE 'active' END) AS "status",
        (COALESCE(i."metadata", '{}'::jsonb) || COALESCE(h."metadata", '{}'::jsonb)) AS "metadata",
        h."updatedAt" AS "statusUpdatedAt"
      ${baseSql}
      ORDER BY ${orderSql}
      LIMIT $6 OFFSET $7
    `,
      state.currentRunId,
      agencyId,
      creatorId,
      normalizedStatus,
      query,
      take,
      skip
    ),
    prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::bigint AS count ${baseSql}`,
      state.currentRunId,
      agencyId,
      creatorId,
      normalizedStatus,
      query
    ),
  ]);

  const count = asNumber(countRows?.[0]?.count);
  const items = (Array.isArray(rows) ? rows : []).map((item) => ({
    ...item,
    totalSpentCents: asNumber(item.totalSpentCents),
    metadata: object(item.metadata),
  }));
  return {
    ok: true,
    creatorId,
    items,
    count,
    offset: skip,
    nextOffset: skip + items.length,
    hasMore: skip + items.length < count,
    state,
  };
}

async function setHiddenOnlineStatus({ agencyId, creatorId, fanId, status }) {
  const normalizedStatus = normalizeStatus(status);
  const state = await prisma.subscriberDirectoryState.findFirst({ where: { agencyId, creatorId } });
  if (!state?.currentRunId)
    throw Object.assign(new Error("Subscriber snapshot is not ready"), { code: "SUBSCRIBER_SNAPSHOT_NOT_READY" });
  const item = await prisma.subscriberScanItem.findUnique({
    where: { runId_fanId: { runId: state.currentRunId, fanId } },
  });
  if (!item || !item.lastSeenIsNull)
    throw Object.assign(new Error("Hidden online candidate not found"), { code: "HIDDEN_ONLINE_NOT_FOUND" });
  const row = await prisma.hiddenOnlineUser.upsert({
    where: { creatorId_fanId: { creatorId, fanId } },
    create: {
      agencyId,
      creatorId,
      fanId,
      dialogId: item.dialogId,
      username: item.username,
      name: item.name,
      totalSpentCents: item.totalSpentCents,
      status: normalizedStatus,
      signals: ["lastSeen:null"],
      metadata: {
        source: "subscriber_directory",
        scanRunId: state.currentRunId,
        statusChangedAt: new Date().toISOString(),
      },
      lastSignalAt: item.observedAt,
    },
    update: {
      dialogId: item.dialogId,
      username: item.username,
      name: item.name,
      totalSpentCents: item.totalSpentCents,
      status: normalizedStatus,
      metadata: {
        source: "subscriber_directory",
        scanRunId: state.currentRunId,
        statusChangedAt: new Date().toISOString(),
      },
      lastSignalAt: item.observedAt,
    },
  });
  return { ok: true, creatorId, fanId, status: row.status, item: row };
}

module.exports = {
  SUBSCRIBER_DIRECTORY_JOB_KEY,
  scheduleSubscriberScan,
  ensureSubscriberScanDue,
  applySubscriberScanChunk,
  applySubscriberScanCompletion,
  recordSubscriberScanFailure,
  cleanupSubscriberScanHistory,
  getSubscriberDirectoryStatus,
  listHiddenOnline,
  setHiddenOnlineStatus,
};

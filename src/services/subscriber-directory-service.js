"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { projectFollowBackProjectionChunk, staleFollowBackProjectionFans, ensureAutomaticFollowBack } = require("./follow-back-service");
const { projectFollowAutomationProjectionChunk, staleFollowAutomationProjectionFans, ensureAutomaticFollowAutomation } = require("./follow-automation-service");
const { ensureAutomaticBumps } = require("./bump-service");
const { projectSubscriberDirectoryItems, readFanCurrent, scheduleFanDataPointRefresh } = require("./fan-data-authority-service");
const { createPlannedJob, publishPlannedJobAvailable } = require("./job-planning-repository");
const { consumeFanObservationToken } = require("./fan-observation-token-service");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { lockAutomationWriteCommitFence } = require("./automation-write-commit-fence-service");
const {
  SUBSCRIBER_MAINTENANCE_KIND,
  signalSubscriberDirectoryMaintenance,
  lockSubscriberMaintenanceClaimRow,
} = require("./subscriber-directory-maintenance-signal-service");

const SUBSCRIBER_DIRECTORY_JOB_KEY = "subscriber_directory_scan";
const ACTIVE_RUN_STATUSES = ["QUEUED", "RUNNING"];
const DEFAULT_SCAN_EVERY_DAYS = 7;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 100;
const MAX_PAGE_ITEMS = 100;
const MAX_HIDDEN_LIST_LIMIT = 500;
const PUBLICATION_BATCH_SIZE = 500;
const SUBSCRIBER_PUBLICATION_IN_PROGRESS_STATUSES = Object.freeze(["PENDING", "CURRENT", "PREVIOUS", "FINALIZE"]);

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}
function integer(value, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}
function integerOrNull(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : null;
}
function valueAvailability(raw) {
  const explicit = clean(raw.valueAvailability, 40)?.toUpperCase();
  const totalPresent = Object.prototype.hasOwnProperty.call(raw, "totalSpentCents");
  const parsedTotal = totalPresent ? integerOrNull(raw.totalSpentCents, 0, 2_000_000_000) : null;
  // AVAILABLE is a strict canonical claim: it is invalid without an explicit valid total.
  if (explicit === "AVAILABLE") return totalPresent && parsedTotal !== null ? "AVAILABLE" : "MALFORMED";
  if (["NOT_FETCHED", "UNAVAILABLE", "MALFORMED"].includes(explicit)) return explicit;
  if (!totalPresent || raw.totalSpentCents === null || raw.totalSpentCents === "") return "NOT_FETCHED";
  return parsedTotal === null ? "MALFORMED" : "AVAILABLE";
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
    fanProjectionStatus: run.fanProjectionStatus || "PENDING",
    fanProjectionCursorOffset: Number(run.fanProjectionCursorOffset || 0),
    fanProjectionCount: Number(run.fanProjectionCount || 0),
    fanProjectionCompletedAt: run.fanProjectionCompletedAt || null,
    fanProjectionLastError: run.fanProjectionLastError || null,
    publicationStatus: run.publicationStatus || "PENDING",
    publicationGeneration: Number(run.publicationGeneration || 0),
    publicationCursorId: run.publicationCursorId || null,
    publicationPreviousRunId: run.publicationPreviousRunId || null,
    publicationAddedCount: Number(run.publicationAddedCount || 0),
    publicationChangedCount: Number(run.publicationChangedCount || 0),
    publicationDisappearedCount: Number(run.publicationDisappearedCount || 0),
    publicationStartedAt: run.publicationStartedAt || null,
    publicationCompletedAt: run.publicationCompletedAt || null,
    publicationJobReconciledAt: run.publicationJobReconciledAt || null,
    publicationLastError: run.publicationLastError || null,
    summary: run.summary || {},
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

async function lockSubscriberPublicationCreator(db, agencyId, creatorId) {
  if (!agencyId || !creatorId || typeof db?.$executeRawUnsafe !== "function") return;
  await db.$executeRawUnsafe(
    `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
    `subscriber-publication:${agencyId}:${creatorId}`,
  );
}

function subscriberPublicationDebtWhere({ agencyId, creatorId } = {}) {
  return {
    ...(agencyId ? { agencyId } : {}),
    ...(creatorId ? { creatorId } : {}),
    OR: [
      {
        hasMore: false,
        fanProjectionStatus: "COMPLETE",
        publicationStatus: { in: [...SUBSCRIBER_PUBLICATION_IN_PROGRESS_STATUSES] },
      },
      {
        status: { in: ["PUBLISHED", "SUPERSEDED"] },
        publicationStatus: "COMPLETE",
        publicationJobReconciledAt: null,
      },
    ],
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
  const now = await dbAuthorityNow({ db: prisma, fallbackNow: new Date() });
  const normalizedLimit = integer(pageLimit, DEFAULT_PAGE_LIMIT, 20, MAX_PAGE_LIMIT);
  const normalizedEveryDays = integer(scanEveryDays, DEFAULT_SCAN_EVERY_DAYS, 1, 30);

  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      // A single creator-local lock serializes generation allocation with
      // publication/recovery.  Job status is deliberately not the publication
      // authority: a terminal JobInstance may still have durable publication
      // debt that must finish before another generation can be scheduled.
      await lockSubscriberPublicationCreator(tx, agencyId, creatorId);

      const publicationDebt = await tx.subscriberScanRun.findFirst({
        where: subscriberPublicationDebtWhere({ agencyId, creatorId }),
        orderBy: [{ publicationGeneration: "asc" }, { updatedAt: "asc" }, { id: "asc" }],
      });
      if (publicationDebt) {
        const debtJob = publicationDebt.jobId
          ? await tx.jobInstance.findUnique({ where: { id: publicationDebt.jobId } }).catch(() => null)
          : null;
        return { existingPublication: publicationDebt, existingJob: debtJob };
      }

      const active = await tx.subscriberScanRun.findFirst({
        where: { agencyId, creatorId, status: { in: ACTIVE_RUN_STATUSES } },
        orderBy: [{ publicationGeneration: "desc" }, { createdAt: "desc" }],
      });
      if (active) {
        const job = active.jobId ? await tx.jobInstance.findUnique({ where: { id: active.jobId } }) : null;
        if (job && ["SCHEDULED", "CLAIMED"].includes(job.status)) {
          return { existingRun: active, existingJob: job };
        }
        await tx.subscriberScanRun.updateMany({
          where: {
            id: active.id,
            status: { in: ACTIVE_RUN_STATUSES },
          },
          data: {
            status: "FAILED",
            completedAt: now,
            lastError: "orphaned scan superseded before scheduling a new run",
          },
        });
      }

      const state = await tx.subscriberDirectoryState.findUnique({
        where: { creatorId },
        select: { publicationGeneration: true, publishedGeneration: true },
      }).catch(() => null);
      const newestRun = await tx.subscriberScanRun.findFirst({
        where: { creatorId },
        orderBy: [{ publicationGeneration: "desc" }, { createdAt: "desc" }],
        select: { publicationGeneration: true },
      }).catch(() => null);
      const generation = Math.max(
        Number(state?.publicationGeneration || 0),
        Number(newestRun?.publicationGeneration || 0),
      ) + 1;

      const run = await tx.subscriberScanRun.create({
        data: {
          agencyId,
          creatorId,
          mode: clean(mode, 40) || "full",
          sourceType: clean(sourceType, 40) || "all",
          status: "QUEUED",
          pageLimit: normalizedLimit,
          publicationGeneration: generation,
          createdByUserId: userId,
          summary: {
            manual: manual === true,
            force: force === true,
            reason: clean(reason, 160) || "subscriber_directory_refresh",
            publicationGeneration: generation,
          },
        },
      });
      const job = await createPlannedJob({
        db: tx,
        publish: false,
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
          publicationGeneration: generation,
          observationTokenVersion: 1,
          observationReadLeaseVersion: 1,
        },
        priority: integer(priority, 20, 0, 200),
        scheduledAt: now,
        nextRunAt: now,
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
          publicationGeneration: generation,
          publishedGeneration: 0,
          summary: { activeRunId: run.id, reason: clean(reason, 160) || null, publicationGeneration: generation },
        },
        update: {
          lastJobId: job.id,
          status: "SCANNING",
          scanEveryDays: normalizedEveryDays,
          publicationGeneration: generation,
          lastError: null,
          summary: { activeRunId: run.id, reason: clean(reason, 160) || null, publicationGeneration: generation },
        },
      });
      return { run: linkedRun, job };
    }, { maxWait: 30_000, timeout: 30_000 });
  } catch (error) {
    // Retain the partial unique active-run index as a second line of defence for
    // older callers, but the creator advisory lock is the generation authority.
    if (error?.code !== "P2002") throw error;
    const concurrentRun = await prisma.subscriberScanRun.findFirst({
      where: { agencyId, creatorId, status: { in: ACTIVE_RUN_STATUSES } },
      orderBy: [{ publicationGeneration: "desc" }, { createdAt: "desc" }],
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

  if (result.existingPublication) {
    return {
      ok: true,
      created: false,
      reason: "publication_recovery_in_progress",
      run: runSummary(result.existingPublication),
      job: result.existingJob || null,
    };
  }
  if (result.existingRun) {
    return { ok: true, created: false, reason: "already_in_flight", run: runSummary(result.existingRun), job: result.existingJob || null };
  }
  publishPlannedJobAvailable(result.job);
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

function normalizeChunkItem(item, {
  runId, agencyId, creatorId, observedAt, producerObservedAt = null,
  observationTimeBasis = "SERVER_SCAN_GENERATION_LEGACY",
}) {
  const raw = object(item);
  const fanId = clean(raw.fanId ?? raw.userId ?? raw.id, 120);
  if (!fanId) return null;
  const lastSeenIsNull = raw.lastSeenIsNull === true;
  const relationshipInputToCanonical = {
    canReceiveChatMessage: "canReceiveChatMessage",
    subscriptionType: "fanSubscriptionType",
    fanSubscribesToCreator: "fanSubscribesToCreator",
    fanSubscriptionActive: "fanSubscriptionActive",
    fanSubscriptionExpiresAt: "fanSubscriptionExpiresAt",
    creatorFollowsFan: "creatorFollowsFan",
    creatorFollowExpiresAt: "creatorFollowExpiresAt",
    blocked: "blocked",
    restricted: "restricted",
    performer: "performer",
    subscribePriceCents: "subscribePriceCents",
    lastSeenAt: "lastSeenAt",
  };
  const observedRelationshipFields = Object.entries(relationshipInputToCanonical)
    .filter(([inputField]) => Object.prototype.hasOwnProperty.call(raw, inputField))
    .map(([, canonicalField]) => canonicalField);
  const observedIdentityFields = [
    ["username", "username"], ["name", "platformDisplayName"], ["avatarUrl", "avatarUrl"], ["headerUrl", "headerUrl"],
  ].filter(([inputField]) => Object.prototype.hasOwnProperty.call(raw, inputField)).map(([, canonicalField]) => canonicalField);
  const observedValueFields = [
    "totalSpentCents", "messagesSpentCents", "tipsSpentCents", "subscriptionsSpentCents", "postsSpentCents", "streamsSpentCents",
  ].filter((field) => Object.prototype.hasOwnProperty.call(raw, field));
  const metadata = {
    ...object(raw.metadata),
    fanDataObservedFields: { identity: observedIdentityFields, relationship: observedRelationshipFields, value: observedValueFields },
    fanDataObservationTimeBasis: observationTimeBasis,
    producerObservedAt: producerObservedAt?.toISOString?.() || null,
  };
  const normalized = {
    runId,
    agencyId,
    creatorId,
    fanId,
    dialogId: clean(raw.dialogId ?? raw.withUserId ?? fanId, 120),
    username: clean(raw.username, 160),
    name: clean(raw.name ?? raw.displayName, 240),
    avatarUrl: clean(raw.avatarUrl ?? raw.avatar, 1000),
    totalSpentCents: integerOrNull(raw.totalSpentCents, 0, 2_000_000_000),
    messagesSpentCents: integerOrNull(raw.messagesSpentCents, 0, 2_000_000_000),
    tipsSpentCents: integerOrNull(raw.tipsSpentCents, 0, 2_000_000_000),
    subscriptionsSpentCents: integerOrNull(raw.subscriptionsSpentCents, 0, 2_000_000_000),
    postsSpentCents: integerOrNull(raw.postsSpentCents, 0, 2_000_000_000),
    streamsSpentCents: integerOrNull(raw.streamsSpentCents, 0, 2_000_000_000),
    valueAvailability: valueAvailability(raw),
    lastSeenAt: dateOrNull(raw.lastSeenAt),
    lastSeenIsNull,
    canReceiveChatMessage: boolOrNull(raw.canReceiveChatMessage),
    isActive: boolOrNull(raw.isActive),
    subscribedOn: boolOrNull(raw.subscribedOn),
    subscribedBy: boolOrNull(raw.subscribedBy),
    subscriptionType: clean(raw.subscriptionType ?? raw.type, 80),
    fanSubscribesToCreator: boolOrNull(raw.fanSubscribesToCreator),
    fanSubscriptionActive: boolOrNull(raw.fanSubscriptionActive),
    fanSubscriptionExpiresAt: dateOrNull(raw.fanSubscriptionExpiresAt),
    creatorFollowsFan: boolOrNull(raw.creatorFollowsFan),
    creatorFollowExpiresAt: dateOrNull(raw.creatorFollowExpiresAt),
    blocked: boolOrNull(raw.blocked),
    restricted: boolOrNull(raw.restricted),
    performer: boolOrNull(raw.performer),
    subscribePriceCents: integerOrNull(raw.subscribePriceCents, 0, 2_000_000_000),
    metadata,
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
      messagesSpentCents: normalized.messagesSpentCents,
      tipsSpentCents: normalized.tipsSpentCents,
      subscriptionsSpentCents: normalized.subscriptionsSpentCents,
      postsSpentCents: normalized.postsSpentCents,
      streamsSpentCents: normalized.streamsSpentCents,
      valueAvailability: normalized.valueAvailability,
      lastSeenAt: normalized.lastSeenAt?.toISOString?.() || null,
      lastSeenIsNull: normalized.lastSeenIsNull,
      canReceiveChatMessage: normalized.canReceiveChatMessage,
      isActive: normalized.isActive,
      subscribedOn: normalized.subscribedOn,
      subscribedBy: normalized.subscribedBy,
      subscriptionType: normalized.subscriptionType,
      fanSubscribesToCreator: normalized.fanSubscribesToCreator,
      fanSubscriptionActive: normalized.fanSubscriptionActive,
      fanSubscriptionExpiresAt: normalized.fanSubscriptionExpiresAt?.toISOString?.() || null,
      creatorFollowsFan: normalized.creatorFollowsFan,
      creatorFollowExpiresAt: normalized.creatorFollowExpiresAt?.toISOString?.() || null,
      blocked: normalized.blocked, restricted: normalized.restricted, performer: normalized.performer,
      subscribePriceCents: normalized.subscribePriceCents,
    });
  return normalized;
}

function assertSubscriberPublicationBarrier(run) {
  const projectionStatus = String(run?.fanProjectionStatus || "PENDING");
  const projectionCursorOffset = Number(run?.fanProjectionCursorOffset || 0);
  const projectionCount = Number(run?.fanProjectionCount || 0);
  const scannedCount = Number(run?.scannedCount || 0);
  const expectedOffset = Number(run?.nextOffset || 0);
  if (projectionStatus !== "COMPLETE" || run?.hasMore === true || projectionCursorOffset < expectedOffset || projectionCount < scannedCount) {
    const error = new Error("Subscriber canonical FanData projection has not crossed the publish barrier");
    error.code = "SUBSCRIBER_FAN_FACTS_PROJECTION_INCOMPLETE";
    throw error;
  }
}

async function lockSubscriberPublicationRun(db, runId) {
  if (typeof db?.$queryRawUnsafe === "function") {
    const rows = await db.$queryRawUnsafe(`SELECT * FROM "SubscriberScanRun" WHERE "id" = $1 FOR UPDATE`, runId);
    return rows?.[0] || null;
  }
  return db.subscriberScanRun.findUnique({ where: { id: runId } });
}

async function publicationTransaction(db, agencyId, creatorId, work, {
  maxWaitMs = 30_000,
  timeoutMs = 30_000,
  maintenanceSignal = null,
} = {}) {
  if (typeof db?.$transaction === "function") {
    const maxWait = Math.max(250, Math.min(30_000, Number(maxWaitMs) || 30_000));
    const timeout = Math.max(250, Math.min(30_000, Number(timeoutMs) || 30_000));
    return db.$transaction(async (tx) => {
      // Canonical Subscriber durable mutation lock order:
      //   1) agency-wide automation write fence
      //   2) creator-local Subscriber advisory lock
      //   3) durable maintenance signal row (when maintenance owns the work)
      // No maintenance path is allowed to invert (3)->(2).
      await lockAutomationWriteCommitFence({ db: tx, agencyId });
      await lockSubscriberPublicationCreator(tx, agencyId, creatorId);
      let claim = null;
      if (maintenanceSignal) {
        claim = await lockSubscriberMaintenanceClaimRow({ db: tx, signal: maintenanceSignal });
        if (!claim) {
          const error = new Error("Subscriber maintenance claim is stale or expired before durable mutation");
          error.code = "SUBSCRIBER_MAINTENANCE_CLAIM_STALE";
          throw error;
        }
      }
      return work(tx, claim);
    }, { maxWait, timeout });
  }
  if (maintenanceSignal) {
    const error = new Error("Subscriber maintenance durable mutation requires transaction support");
    error.code = "SUBSCRIBER_MAINTENANCE_FENCE_TRANSACTION_REQUIRED";
    throw error;
  }
  if (typeof db?.$executeRawUnsafe === "function") {
    await lockAutomationWriteCommitFence({ db, agencyId });
    await lockSubscriberPublicationCreator(db, agencyId, creatorId);
  }
  return work(db, null);
}

async function projectHiddenOnlineChunk(db, run, itemIds, now) {
  if (!itemIds.length || typeof db?.$executeRawUnsafe !== "function") return;
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
    WHERE i."runId" = $1 AND i."id" = ANY($3::text[]) AND i."lastSeenIsNull" = true
    ON CONFLICT ("creatorId", "fanId") DO UPDATE SET
      "dialogId" = EXCLUDED."dialogId", "username" = EXCLUDED."username", "name" = EXCLUDED."name",
      "totalSpentCents" = EXCLUDED."totalSpentCents",
      "status" = CASE WHEN "HiddenOnlineUser"."status" IN ('ignored', 'blocked') THEN "HiddenOnlineUser"."status" ELSE 'active' END,
      "signals" = EXCLUDED."signals",
      "metadata" = COALESCE("HiddenOnlineUser"."metadata", '{}'::jsonb) || EXCLUDED."metadata",
      "lastSignalAt" = EXCLUDED."lastSignalAt", "updatedAt" = EXCLUDED."updatedAt"
    `,
    run.id, now, itemIds,
  );
  await db.$executeRawUnsafe(
    `
    UPDATE "HiddenOnlineUser" h
    SET "status" = 'removed', "updatedAt" = $4,
        "metadata" = COALESCE(h."metadata", '{}'::jsonb) || jsonb_build_object('removedByScanRunId', $1)
    FROM "SubscriberScanItem" i
    WHERE i."runId" = $1 AND i."id" = ANY($2::text[]) AND i."lastSeenIsNull" = false
      AND h."agencyId" = $3 AND h."creatorId" = $5 AND h."fanId" = i."fanId" AND h."status" = 'active'
    `,
    run.id, itemIds, run.agencyId, now, run.creatorId,
  );
}

async function markHiddenOnlineDisappeared(db, run, fanIds, now) {
  if (!fanIds.length || typeof db?.$executeRawUnsafe !== "function") return;
  await db.$executeRawUnsafe(
    `
    UPDATE "HiddenOnlineUser"
    SET "status" = 'removed', "updatedAt" = $4,
        "metadata" = COALESCE("metadata", '{}'::jsonb) || jsonb_build_object('removedByScanRunId', $1)
    WHERE "agencyId" = $2 AND "creatorId" = $3 AND "fanId" = ANY($5::text[]) AND "status" = 'active'
    `,
    run.id, run.agencyId, run.creatorId, now, fanIds,
  );
}

async function advanceSubscriberPublication(db, { runId, jobId, scanEveryDays }) {
  const run = await lockSubscriberPublicationRun(db, runId);
  if (!run) throw new Error("Subscriber directory scan run is missing during publication");
  if (run.status === "SUPERSEDED" && String(run.publicationStatus || "") === "COMPLETE") return { complete: true, run, summary: run.summary || {} };
  if (run.status === "PUBLISHED" && String(run.publicationStatus || "") === "COMPLETE") {
    return { complete: true, run, summary: run.summary || {} };
  }
  assertSubscriberPublicationBarrier(run);
  const now = await dbAuthorityNow({ db, fallbackNow: new Date() });
  let phase = String(run.publicationStatus || "PENDING").toUpperCase();
  if (!["PENDING", "CURRENT", "PREVIOUS", "FINALIZE", "COMPLETE"].includes(phase)) {
    const error = new Error(`Unknown subscriber publication phase ${phase}`);
    error.code = "SUBSCRIBER_PUBLICATION_PHASE_INVALID";
    throw error;
  }

  const generation = Number(run.publicationGeneration || 0);
  if (!Number.isInteger(generation) || generation <= 0) {
    const error = new Error("Subscriber publication generation is missing");
    error.code = "SUBSCRIBER_PUBLICATION_GENERATION_MISSING";
    throw error;
  }
  const generationState = await db.subscriberDirectoryState.findUnique({
    where: { creatorId: run.creatorId },
    select: { currentRunId: true, publicationGeneration: true, publishedGeneration: true },
  }).catch(() => null);
  const latestGeneration = Number(generationState?.publicationGeneration || 0);
  const publishedGeneration = Number(generationState?.publishedGeneration || 0);

  // If a newer generation is already published, every remaining phase of this
  // run is obsolete.  It is safe to close it as SUPERSEDED because the newer
  // generation has already replaced all derived state.  If a newer generation
  // is merely allocated but not yet published, fail closed and keep the
  // publication fence active rather than expose mixed generations.
  if (publishedGeneration > generation) {
    const superseded = await db.subscriberScanRun.update({
      where: { id: run.id },
      data: {
        status: "SUPERSEDED",
        publicationStatus: "COMPLETE",
        publicationCursorId: null,
        publicationCompletedAt: run.publicationCompletedAt || now,
        completedAt: run.completedAt || now,
        publicationLastError: null,
      },
    });
    return { complete: true, phase: "COMPLETE", run: superseded, summary: superseded.summary || run.summary || {}, supersededByGeneration: publishedGeneration };
  }
  if (latestGeneration > generation && phase !== "COMPLETE") {
    const error = new Error(`Subscriber publication generation ${generation} is stale behind allocated generation ${latestGeneration}`);
    error.code = "SUBSCRIBER_PUBLICATION_GENERATION_STALE";
    throw error;
  }

  if (phase === "PENDING") {
    const state = generationState || await db.subscriberDirectoryState.findUnique({ where: { creatorId: run.creatorId } });
    const previousRunId = state?.currentRunId && state.currentRunId !== run.id ? state.currentRunId : null;
    const updated = await db.subscriberScanRun.update({
      where: { id: run.id },
      data: {
        publicationStatus: "CURRENT", publicationCursorId: null, publicationPreviousRunId: previousRunId,
        publicationAddedCount: 0, publicationChangedCount: 0, publicationDisappearedCount: 0,
        publicationStartedAt: run.publicationStartedAt || now, publicationCompletedAt: null, publicationLastError: null,
      },
    });
    return { complete: false, phase: "CURRENT", run: updated };
  }

  if (phase === "CURRENT") {
    const cursorId = clean(run.publicationCursorId, 180);
    const items = await db.subscriberScanItem.findMany({
      where: { runId: run.id, ...(cursorId ? { id: { gt: cursorId } } : {}) },
      orderBy: { id: "asc" }, take: PUBLICATION_BATCH_SIZE,
      select: { id: true, fanId: true, contentHash: true, lastSeenIsNull: true },
    });
    if (!items.length) {
      const updated = await db.subscriberScanRun.update({ where: { id: run.id }, data: { publicationStatus: "PREVIOUS", publicationCursorId: null } });
      return { complete: false, phase: "PREVIOUS", run: updated };
    }
    const fanIds = items.map((item) => item.fanId);
    const previousRows = run.publicationPreviousRunId
      ? await db.subscriberScanItem.findMany({
          where: { runId: run.publicationPreviousRunId, fanId: { in: fanIds } },
          select: { fanId: true, contentHash: true },
        })
      : [];
    const previousByFan = new Map(previousRows.map((item) => [String(item.fanId), item]));
    let added = 0;
    let changed = 0;
    for (const item of items) {
      const previous = previousByFan.get(String(item.fanId));
      if (!previous) added += 1;
      else if (String(previous.contentHash || "") !== String(item.contentHash || "")) changed += 1;
    }
    const itemIds = items.map((item) => item.id);
    await projectHiddenOnlineChunk(db, run, itemIds, now);
    await projectFollowBackProjectionChunk({ db, agencyId: run.agencyId, creatorId: run.creatorId, runId: run.id, itemIds, now });
    await projectFollowAutomationProjectionChunk({ db, agencyId: run.agencyId, creatorId: run.creatorId, runId: run.id, itemIds, now });
    const exhausted = items.length < PUBLICATION_BATCH_SIZE;
    const updated = await db.subscriberScanRun.update({
      where: { id: run.id },
      data: {
        publicationStatus: exhausted ? "PREVIOUS" : "CURRENT",
        publicationCursorId: exhausted ? null : items[items.length - 1].id,
        publicationAddedCount: { increment: added }, publicationChangedCount: { increment: changed },
        publicationLastError: null,
      },
    });
    return { complete: false, phase: exhausted ? "PREVIOUS" : "CURRENT", run: updated, processed: items.length };
  }

  if (phase === "PREVIOUS") {
    const previousRunId = clean(run.publicationPreviousRunId, 180);
    if (!previousRunId) {
      const updated = await db.subscriberScanRun.update({ where: { id: run.id }, data: { publicationStatus: "FINALIZE", publicationCursorId: null } });
      return { complete: false, phase: "FINALIZE", run: updated };
    }
    const cursorId = clean(run.publicationCursorId, 180);
    const previousItems = await db.subscriberScanItem.findMany({
      where: { runId: previousRunId, ...(cursorId ? { id: { gt: cursorId } } : {}) },
      orderBy: { id: "asc" }, take: PUBLICATION_BATCH_SIZE, select: { id: true, fanId: true },
    });
    if (!previousItems.length) {
      const updated = await db.subscriberScanRun.update({ where: { id: run.id }, data: { publicationStatus: "FINALIZE", publicationCursorId: null } });
      return { complete: false, phase: "FINALIZE", run: updated };
    }
    const fanIds = previousItems.map((item) => item.fanId);
    const currentItems = await db.subscriberScanItem.findMany({
      where: { runId: run.id, fanId: { in: fanIds } }, select: { fanId: true },
    });
    const current = new Set(currentItems.map((item) => String(item.fanId)));
    const disappeared = fanIds.filter((fanId) => !current.has(String(fanId)));
    await markHiddenOnlineDisappeared(db, run, disappeared, now);
    await staleFollowBackProjectionFans({ db, agencyId: run.agencyId, creatorId: run.creatorId, runId: run.id, fanIds: disappeared, now });
    await staleFollowAutomationProjectionFans({ db, agencyId: run.agencyId, creatorId: run.creatorId, runId: run.id, fanIds: disappeared, now });
    const exhausted = previousItems.length < PUBLICATION_BATCH_SIZE;
    const updated = await db.subscriberScanRun.update({
      where: { id: run.id },
      data: {
        publicationStatus: exhausted ? "FINALIZE" : "PREVIOUS",
        publicationCursorId: exhausted ? null : previousItems[previousItems.length - 1].id,
        publicationDisappearedCount: { increment: disappeared.length }, publicationLastError: null,
      },
    });
    return { complete: false, phase: exhausted ? "FINALIZE" : "PREVIOUS", run: updated, processed: previousItems.length };
  }

  if (phase === "FINALIZE") {
    const totalCount = Number(run.scannedCount || 0);
    const hiddenCount = Number(run.hiddenCount || 0);
    const addedCount = Number(run.publicationAddedCount || 0);
    const changedCount = Number(run.publicationChangedCount || 0);
    const disappearedCount = Number(run.publicationDisappearedCount || 0);
    const previousRunId = clean(run.publicationPreviousRunId, 180);
    const nextScanAt = new Date(now.getTime() + integer(scanEveryDays, DEFAULT_SCAN_EVERY_DAYS, 1, 30) * 24 * 60 * 60 * 1000);
    const summary = {
      totalCount, hiddenCount, addedCount, changedCount, disappearedCount,
      currentRunId: run.id, previousRunId,
      publicationGeneration: generation,
      fanProjectionStatus: String(run.fanProjectionStatus || "PENDING"),
      fanProjectionCursorOffset: Number(run.fanProjectionCursorOffset || 0),
      fanProjectionCount: Number(run.fanProjectionCount || 0),
      publicationTopology: "durable_chunked_generation_v2",
    };

    // Monotonic generation CAS: only the latest allocated generation may move
    // currentRunId forward, and publishedGeneration can only increase.  The
    // creator advisory lock removes ordinary contention; the CAS is the durable
    // source-level fence against old/new FINALIZE reordering and legacy callers.
    const stateCas = await db.subscriberDirectoryState.updateMany({
      where: {
        creatorId: run.creatorId,
        publicationGeneration: generation,
        publishedGeneration: { lt: generation },
      },
      data: {
        currentRunId: run.id, previousRunId, lastJobId: jobId, status: "READY",
        scanEveryDays: integer(scanEveryDays, DEFAULT_SCAN_EVERY_DAYS, 1, 30),
        nextScanAt, publishedAt: now, totalCount, hiddenCount, addedCount, changedCount, disappearedCount,
        publishedGeneration: generation, summary, lastError: null,
      },
    });

    if (!Number(stateCas?.count || 0)) {
      const currentState = await db.subscriberDirectoryState.findUnique({
        where: { creatorId: run.creatorId },
        select: { currentRunId: true, publicationGeneration: true, publishedGeneration: true },
      });
      const currentPublishedGeneration = Number(currentState?.publishedGeneration || 0);
      const alreadyCommitted = currentState?.currentRunId === run.id && currentPublishedGeneration === generation;
      if (!alreadyCommitted) {
        if (currentPublishedGeneration > generation) {
          const superseded = await db.subscriberScanRun.update({
            where: { id: run.id },
            data: {
              status: "SUPERSEDED", publicationStatus: "COMPLETE", publicationCursorId: null,
              publicationCompletedAt: now, completedAt: now, publicationLastError: null,
            },
          });
          return { complete: true, phase: "COMPLETE", run: superseded, summary: superseded.summary || run.summary || {}, supersededByGeneration: currentPublishedGeneration };
        }
        const error = new Error("Subscriber publication FINALIZE lost the monotonic generation CAS");
        error.code = "SUBSCRIBER_PUBLICATION_GENERATION_CAS_LOST";
        throw error;
      }
    }

    const committed = await db.subscriberScanRun.updateMany({
      where: { id: run.id, publicationGeneration: generation, publicationStatus: "FINALIZE" },
      data: {
        status: "PUBLISHED", completedAt: now, publishedAt: now, hasMore: false, summary,
        publicationStatus: "COMPLETE", publicationCursorId: null, publicationCompletedAt: now, publicationLastError: null,
      },
    });
    let updated = null;
    if (Number(committed?.count || 0)) {
      updated = await db.subscriberScanRun.findUnique({ where: { id: run.id } });
    } else {
      updated = await db.subscriberScanRun.findUnique({ where: { id: run.id } });
      if (!(updated?.status === "PUBLISHED" && String(updated?.publicationStatus || "") === "COMPLETE")) {
        const error = new Error("Subscriber publication run generation changed before FINALIZE commit");
        error.code = "SUBSCRIBER_PUBLICATION_RUN_CAS_LOST";
        throw error;
      }
    }
    if (previousRunId) {
      await db.subscriberScanRun.updateMany({
        where: { id: previousRunId, status: "PUBLISHED", publicationGeneration: { lt: generation } },
        data: { status: "SUPERSEDED" },
      });
    }
    return { complete: true, phase: "COMPLETE", run: updated, summary };
  }

  return { complete: true, phase: "COMPLETE", run, summary: run.summary || {} };
}

async function publishRun(db, run, { jobId, scanEveryDays, maxSteps = 8 } = {}) {
  const runId = clean(run?.id, 120);
  if (!runId) throw new Error("Subscriber publication run id is required");
  const stepBudget = Math.max(1, Math.min(32, Number(maxSteps) || 8));
  let lastResult = null;
  // Request/job-completion work is deliberately bounded. Durable phase/cursor
  // state plus the creator-scoped RECOVERY signal own convergence beyond this
  // small synchronous budget.
  for (let step = 0; step < stepBudget; step += 1) {
    const result = await publicationTransaction(
      db,
      run.agencyId,
      run.creatorId,
      (tx) => advanceSubscriberPublication(tx, { runId, jobId, scanEveryDays }),
    );
    lastResult = result;
    if (result?.complete) {
      return {
        complete: true,
        steps: step + 1,
        summary: result.summary || result.run?.summary || {},
        run: result.run || null,
      };
    }
  }
  return {
    complete: false,
    steps: stepBudget,
    reason: "step_budget_exhausted",
    summary: lastResult?.summary || lastResult?.run?.summary || run.summary || {},
    run: lastResult?.run || null,
  };
}

async function applySubscriberScanChunk({
  db, job, deviceId = null, chunkResult, consumeObservationToken = consumeFanObservationToken,
}) {
  if (job.jobKey !== SUBSCRIBER_DIRECTORY_JOB_KEY) return null;
  const chunk = object(chunkResult);
  if (chunk.kind !== "subscriber_directory_page") throw new Error("Unsupported subscriber directory chunk");
  const runId = clean(chunk.scanRunId, 120);
  if (!runId || runId !== clean(job.params?.scanRunId, 120)) throw new Error("Subscriber scan run mismatch");
  let run = null;
  if (typeof db.$queryRawUnsafe === "function") {
    const locked = await db.$queryRawUnsafe(
      `SELECT * FROM "SubscriberScanRun" WHERE "id" = $1 FOR UPDATE`,
      runId
    );
    run = locked?.[0] || null;
  } else {
    run = await db.subscriberScanRun.findUnique({ where: { id: runId } });
  }
  if (!run || run.creatorId !== job.creatorId || run.agencyId !== job.agencyId)
    throw new Error("Subscriber scan run is outside job scope");
  if (["PUBLISHED", "SUPERSEDED"].includes(run.status))
    return { duplicate: true, published: true, summary: run.summary || {} };

  const offset = integerOrNull(chunk.offset, 0, 10_000_000);
  if (offset === null) {
    const error = new Error("Subscriber page offset must be a non-negative integer");
    error.code = "SUBSCRIBER_SCAN_OFFSET_INVALID";
    throw error;
  }
  const hasMore = chunk.hasMore === true;
  if (!Array.isArray(chunk.items)) throw new Error("SUBSCRIBER_SCAN_ITEMS_REQUIRED");
  if (chunk.items.length > MAX_PAGE_ITEMS) {
    const error = new Error(`Subscriber page exceeds ${MAX_PAGE_ITEMS} items`);
    error.code = "SUBSCRIBER_SCAN_PAGE_TOO_LARGE";
    throw error;
  }
  const itemsInput = chunk.items;
  const expectedOffset = Number(run.nextOffset || 0);
  if (offset !== expectedOffset) {
    const existingReplay = await db.subscriberScanPage.findUnique({ where: { runId_offset: { runId, offset } } });
    if (!existingReplay) {
      const error = new Error(`Subscriber page offset ${offset} does not match durable cursor ${expectedOffset}`);
      error.code = offset < expectedOffset ? "SUBSCRIBER_SCAN_REWIND" : "SUBSCRIBER_SCAN_GAP";
      throw error;
    }
  }
  // Fail closed on any ambiguity between transported provider rows and cursor
  // advance. Frozen Desktop normally emits one compact item per provider row;
  // if a provider page ever compacts/deduplicates differently, rejecting that
  // page is safer than granting the client authority to advance an unproved
  // cursor and publish an incomplete canonical source.
  const serverDerivedNextOffset = offset + itemsInput.length;
  const nextOffsetSubmitted = chunk.nextOffset !== null && chunk.nextOffset !== undefined && chunk.nextOffset !== "";
  const submittedNextOffset = nextOffsetSubmitted ? integerOrNull(chunk.nextOffset, 0, 10_000_000) : serverDerivedNextOffset;
  if (submittedNextOffset === null || submittedNextOffset !== serverDerivedNextOffset) {
    const error = new Error("Subscriber nextOffset does not match transported provider row count");
    error.code = "SUBSCRIBER_SCAN_NEXT_OFFSET_MISMATCH";
    throw error;
  }
  const nextOffset = serverDerivedNextOffset;
  const producerObservedAt = dateOrNull(chunk.observedAt);

  // Lost-response replay must be idempotent even though observation tokens are
  // one-time. Detect an already committed page before attempting token consume.
  const providerPayloadHash = hashJson(itemsInput);
  const existingPage = await db.subscriberScanPage.findUnique({ where: { runId_offset: { runId, offset } } });
  if (existingPage) {
    const replayHash = providerPayloadHash;
    if (existingPage.contentHash && replayHash !== existingPage.contentHash) {
      const error = new Error("Subscriber replay payload conflicts with committed page");
      error.code = "SUBSCRIBER_SCAN_REPLAY_CONFLICT";
      throw error;
    }
    if (Number(existingPage.nextOffset || 0) !== nextOffset || Boolean(existingPage.hasMore) !== hasMore) {
      const error = new Error("Subscriber replay continuation conflicts with committed page");
      error.code = "SUBSCRIBER_SCAN_REPLAY_CONFLICT";
      throw error;
    }
    const projectedThrough = Number(run.fanProjectionCursorOffset || 0);
    if (!["PUBLISHED", "SUPERSEDED"].includes(run.status) && projectedThrough < Number(existingPage.nextOffset || 0)) {
      const error = new Error("Subscriber page exists without a committed canonical FanData projection");
      error.code = "SUBSCRIBER_PAGE_PROJECTION_GAP";
      throw error;
    }
    return { duplicate: true, published: run.status === "PUBLISHED", nextOffset: existingPage.nextOffset, hasMore: existingPage.hasMore };
  }

  if (hasMore && itemsInput.length === 0) {
    const error = new Error("Subscriber non-terminal page cannot stall the provider cursor");
    error.code = "SUBSCRIBER_SCAN_STALLED_CURSOR";
    throw error;
  }
  const normalizedFanIds = itemsInput.map((item) => clean(object(item).fanId ?? object(item).userId ?? object(item).id, 120));
  if (normalizedFanIds.some((fanId) => !fanId)) throw new Error("SUBSCRIBER_SCAN_FAN_ID_REQUIRED");
  if (new Set(normalizedFanIds).size !== normalizedFanIds.length) throw new Error("SUBSCRIBER_SCAN_DUPLICATE_FAN_IN_PAGE");
  if (normalizedFanIds.length && typeof db.subscriberScanItem?.findMany === "function") {
    const prior = await db.subscriberScanItem.findMany({
      where: { runId, fanId: { in: normalizedFanIds } },
      select: { fanId: true, pageOffset: true },
      take: normalizedFanIds.length,
    });
    if ((prior || []).length) {
      const error = new Error("Subscriber provider repeated a fan on a different committed page");
      error.code = "SUBSCRIBER_SCAN_DUPLICATE_FAN_ACROSS_PAGES";
      throw error;
    }
  }

  // INT5.4C-1C: every non-empty provider page receives chronology only after
  // the provider read completed. The token is lease/device/purpose/exact-fan
  // scope bound, so job/run creation order is no longer used as current truth.
  const observationTokenRequired = Number(job?.params?.observationTokenVersion || 0) >= 1;
  let observedAt = null;
  let observationTimeBasis = "SERVER_PROVIDER_READ_TOKEN";
  if (normalizedFanIds.length && observationTokenRequired) {
    if (!clean(chunk.observationToken, 500)) throw new Error("SUBSCRIBER_SCAN_OBSERVATION_TOKEN_REQUIRED");
    const consumed = await consumeObservationToken({
      db,
      job,
      deviceId,
      leaseRevision: job.leaseRevision,
      token: chunk.observationToken,
      purpose: "subscriber_directory_page",
      subjects: normalizedFanIds,
    });
    observedAt = dateOrNull(consumed?.observedAt);
  } else if (normalizedFanIds.length) {
    // Rollout compatibility for subscriber jobs created before the token cutover.
    observedAt = dateOrNull(run.createdAt) || dateOrNull(job.createdAt);
    observationTimeBasis = "SERVER_SCAN_GENERATION_LEGACY";
  } else {
    // Empty terminal pages carry no FanData facts, so no chronology token exists.
    observedAt = dateOrNull(run.createdAt) || dateOrNull(job.createdAt) || new Date();
    observationTimeBasis = observationTokenRequired ? "NO_FAN_FACTS" : "SERVER_SCAN_GENERATION_LEGACY";
  }
  if (!observedAt) throw new Error("SUBSCRIBER_SCAN_CAUSAL_GENERATION_REQUIRED");

  const items = itemsInput
    .map((item) => normalizeChunkItem(item, {
      runId,
      agencyId: run.agencyId,
      creatorId: run.creatorId,
      observedAt,
      producerObservedAt,
      observationTimeBasis,
    }))
    .filter(Boolean)
    .map((item) => ({ ...item, pageOffset: offset }));
  const contentHash = providerPayloadHash;
  const authorityNow = await dbAuthorityNow({ db, fallbackNow: new Date() });
  const hiddenCount = items.filter((item) => item.lastSeenIsNull).length;
  await db.subscriberScanPage.create({
    data: { runId, offset, nextOffset, itemCount: items.length, hiddenCount, hasMore, contentHash },
  });
  if (items.length) await db.subscriberScanItem.createMany({ data: items, skipDuplicates: true });

  // The page and its canonical FanData facts commit atomically under the job
  // progress transaction. Provider pages are capped at 100 fans, so projection
  // work is bounded; no final O(all subscribers) publish transaction exists.
  const pageProjection = await projectSubscriberDirectoryItems(db, {
    items,
    agencyId: run.agencyId,
    creatorId: run.creatorId,
    runId,
    sourceJobId: job.id,
  });
  if (Number(pageProjection?.projected || 0) !== items.length) {
    const error = new Error("Subscriber page canonical FanData projection count mismatch");
    error.code = "SUBSCRIBER_PAGE_PROJECTION_COUNT_MISMATCH";
    throw error;
  }

  const progressData = {
    status: "RUNNING", startedAt: run.startedAt || authorityNow, nextOffset,
    scannedCount: { increment: items.length }, pageCount: { increment: 1 }, hiddenCount: { increment: hiddenCount },
    hasMore, lastError: null, fanProjectionStatus: hasMore ? "PROJECTING" : "COMPLETE",
    fanProjectionCursorOffset: nextOffset, fanProjectionCount: { increment: items.length },
    fanProjectionCompletedAt: hasMore ? null : authorityNow, fanProjectionLastError: null,
  };
  let updatedRun;
  if (typeof db.subscriberScanRun.updateMany === "function") {
    const advanced = await db.subscriberScanRun.updateMany({
      where: { id: runId, nextOffset: offset, status: { in: ["QUEUED", "RUNNING"] } }, data: progressData,
    });
    if (Number(advanced?.count || 0) !== 1) {
      const error = new Error("Subscriber progress cursor lost concurrent CAS");
      error.code = "SUBSCRIBER_SCAN_CURSOR_CONFLICT";
      throw error;
    }
    updatedRun = await db.subscriberScanRun.findUnique({ where: { id: runId } });
  } else {
    updatedRun = await db.subscriberScanRun.update({ where: { id: runId }, data: progressData });
  }
  if (hasMore)
    return {
      duplicate: false,
      published: false,
      nextOffset,
      hasMore,
      scannedCount: updatedRun.scannedCount,
      pageCount: updatedRun.pageCount,
    };
  // Final-page canonical FanData commit creates durable publication debt. Signal
  // the creator-scoped recovery lane in the SAME transaction so a crash before
  // Job completion cannot strand publication behind a global scan.
  await signalSubscriberDirectoryMaintenance({
    db, agencyId: run.agencyId, creatorId: run.creatorId,
    kind: SUBSCRIBER_MAINTENANCE_KIND.RECOVERY, dueAt: authorityNow, reason: "FINAL_PAGE_READY",
  });
  // Final-page canonical FanData commit must stay bounded. commitFanFacts holds a
  // transaction-scoped Campaign/FanData authority until this progress transaction
  // commits, so never run whole-directory publication work here. The subsequent
  // job-completion transaction crosses the durable fanProjection barrier and
  // publishes without holding Campaign authority across O(all subscribers) work.
  return {
    duplicate: false, published: false, readyToPublish: true, nextOffset, hasMore: false,
    scannedCount: updatedRun.scannedCount, pageCount: updatedRun.pageCount,
  };
}

async function planSubscriberDerivedAutomation({
  run,
  userId = null,
  db = prisma,
  source = "subscriber_snapshot_published",
  fencedMaintenance = false,
  scheduleFanRefresh = null,
} = {}) {
  if (!run?.agencyId || !run?.creatorId) return {
    followBackPlanning: { ok: false, created: false, reason: "subscriber_run_scope_missing" },
    followAutomationPlanning: { ok: false, created: false, reason: "subscriber_run_scope_missing" },
    bumpPlanning: { ok: false, created: false, reason: "subscriber_run_scope_missing", sources: [] },
  };
  const refreshScheduler = typeof scheduleFanRefresh === "function" ? scheduleFanRefresh : scheduleFanDataPointRefresh;
  const fencedRefreshScheduler = fencedMaintenance
    ? async (input = {}) => refreshScheduler({
        ...input,
        db,
        params: {
          ...(input?.params && typeof input.params === "object" ? input.params : {}),
          causalBarrierKey: input?.params?.causalBarrierKey
            || `subscriber-derived:${run.id}:${Number(run.publicationGeneration || 0)}`,
          subscriberRunId: run.id,
          subscriberPublicationGeneration: Number(run.publicationGeneration || 0),
        },
      })
    : undefined;
  let followBackPlanning = null;
  let followAutomationPlanning = null;
  let bumpPlanning = null;
  try {
    followBackPlanning = await ensureAutomaticFollowBack({
      agencyId: run.agencyId, creatorId: run.creatorId, source, db,
      ...(fencedRefreshScheduler ? { scheduleFanRefresh: fencedRefreshScheduler } : {}),
    });
  } catch (error) {
    followBackPlanning = { ok: false, created: false, reason: error?.code || "follow_back_planning_failed", error: clean(error?.message || error, 500) };
  }
  try {
    followAutomationPlanning = await ensureAutomaticFollowAutomation({
      agencyId: run.agencyId, creatorId: run.creatorId, source, db,
      ...(fencedRefreshScheduler ? { scheduleFanRefresh: fencedRefreshScheduler } : {}),
    });
  } catch (error) {
    followAutomationPlanning = { ok: false, created: false, reason: error?.code || "follow_automation_planning_failed", error: clean(error?.message || error, 500) };
  }
  try {
    bumpPlanning = await ensureAutomaticBumps({
      agencyId: run.agencyId,
      creatorId: run.creatorId,
      userId,
      source,
      db,
      ...(fencedRefreshScheduler ? { scheduleFanRefresh: fencedRefreshScheduler } : {}),
    });
  } catch (error) {
    bumpPlanning = {
      ok: false,
      created: false,
      reason: error?.code || "bump_planning_failed",
      error: clean(error?.message || error, 500),
      sources: [],
    };
  }
  return { followBackPlanning, followAutomationPlanning, bumpPlanning };
}

async function applySubscriberScanCompletion({ job, userId = null, result, db = prisma }) {
  const runId = clean(job.params?.scanRunId, 120);
  let run = runId ? await db.subscriberScanRun.findUnique({ where: { id: runId } }) : null;
  if (!run) throw new Error("Subscriber directory scan run is missing before job completion");
  let publishedSummary = run.summary || {};
  if (run.status !== "PUBLISHED") {
    if (String(run.fanProjectionStatus || "") !== "COMPLETE" || run.hasMore === true) {
      throw new Error("Subscriber directory canonical projection is not ready for publication");
    }
    const publication = await publishRun(db, run, {
      jobId: job.id,
      scanEveryDays: job.params?.scanEveryDays,
      maxSteps: 8,
    });
    run = await db.subscriberScanRun.findUnique({ where: { id: runId } });
    if (!publication?.complete || !run || run.status !== "PUBLISHED") {
      await signalSubscriberDirectoryMaintenance({
        db,
        agencyId: run?.agencyId || job.agencyId,
        creatorId: run?.creatorId || job.creatorId,
        kind: SUBSCRIBER_MAINTENANCE_KIND.RECOVERY,
        reason: "COMPLETION_STEP_BUDGET",
      });
      const error = new Error("Subscriber publication deferred to durable maintenance after bounded completion work");
      error.code = "SUBSCRIBER_PUBLICATION_DEFERRED_TO_MAINTENANCE";
      throw error;
    }
    publishedSummary = publication.summary || run.summary || {};
  }

  // Planning is best-effort, but it is part of completion convergence. Recovery
  // executes this same helper before it reconciles a stranded JobInstance to DONE,
  // so a crash after FINALIZE cannot silently lose subscriber-derived automation.
  const planning = await planSubscriberDerivedAutomation({
    run,
    userId,
    db,
    source: "subscriber_snapshot_published",
  });
  if (!subscriberDerivedPlanningConverged(planning)) {
    await signalSubscriberDirectoryMaintenance({
      db,
      agencyId: run.agencyId,
      creatorId: run.creatorId,
      kind: SUBSCRIBER_MAINTENANCE_KIND.RECOVERY,
      reason: "DERIVED_AUTOMATION_PLANNING_FAILED",
    });
    const error = new Error("Subscriber derived automation planning did not converge");
    error.code = "SUBSCRIBER_DERIVED_AUTOMATION_PLANNING_FAILED";
    error.planning = planning;
    throw error;
  }
  await signalSubscriberDirectoryMaintenance({
    db, agencyId: run.agencyId, creatorId: run.creatorId,
    kind: SUBSCRIBER_MAINTENANCE_KIND.RETENTION, reason: "PUBLICATION_COMPLETE",
  });

  return {
    type: "subscriber_directory",
    runId: run.id,
    summary: publishedSummary || run.summary || {},
    ...planning,
    result: object(result),
  };
}
async function recordSubscriberScanFailure({ job, error, terminal = true, db = prisma }) {
  const runId = clean(job.params?.scanRunId, 120);
  if (!runId) return null;
  const errorText = clean(error, 2000) || "subscriber scan failed";
  const now = await dbAuthorityNow({ db, fallbackNow: new Date() });
  const existing = await db.subscriberScanRun.findUnique({ where: { id: runId } }).catch(() => null);
  // A final progress request may have committed its bounded canonical page and
  // lost the response before separate durable publication. Never execute the
  // whole publication state machine under the generic failJob transaction: a
  // transaction client has no $transaction(), so that would collapse every
  // publication phase back into one O(all subscribers) transaction.
  if (!existing || ["PUBLISHED", "SUPERSEDED"].includes(existing.status)) return existing;
  if (String(existing.fanProjectionStatus || "") === "COMPLETE" && existing.hasMore === false) {
    await signalSubscriberDirectoryMaintenance({
      db, agencyId: existing.agencyId, creatorId: existing.creatorId,
      kind: SUBSCRIBER_MAINTENANCE_KIND.RECOVERY, dueAt: now, reason: "JOB_FAILURE_AFTER_FINAL_PAGE",
    });
    await db.subscriberScanRun.updateMany({
      where: { id: runId, status: { in: ["QUEUED", "RUNNING"] } },
      data: { publicationLastError: errorText, lastError: errorText },
    });
    return {
      ...existing,
      publicationRecoveryPending: true,
      publicationLastError: errorText,
    };
  }
  const run = await db.subscriberScanRun
    .update({
      where: { id: runId },
      data: terminal
        ? { status: "FAILED", completedAt: now, lastError: errorText, publicationLastError: errorText }
        : { status: "RUNNING", lastError: errorText, publicationLastError: errorText },
    })
    .catch(() => null);
  if (run) {
    await db.subscriberDirectoryState.updateMany({
      where: { creatorId: run.creatorId, OR: [{ lastJobId: null }, { lastJobId: job.id }] },
      data: { status: terminal ? "FAILED" : "SCANNING", lastJobId: job.id, lastError: errorText },
    });
  }
  return run;
}


async function markSubscriberPublicationJobReconciled(db, runId, now) {
  if (!runId || typeof db?.subscriberScanRun?.updateMany !== "function") return false;
  const updated = await db.subscriberScanRun.updateMany({
    where: {
      id: runId,
      publicationStatus: "COMPLETE",
      status: { in: ["PUBLISHED", "SUPERSEDED"] },
      publicationJobReconciledAt: null,
    },
    data: { publicationJobReconciledAt: now, publicationLastError: null },
  });
  return Number(updated?.count || 0) > 0;
}

function subscriberDerivedPlanningConverged(planning) {
  if (!planning) return true;
  return ["followBackPlanning", "followAutomationPlanning", "bumpPlanning"]
    .every((key) => !planning[key] || planning[key].ok !== false);
}

async function reconcileRecoveredSubscriberPublicationJob(db, { run, summary = null, planning = null, now = new Date() } = {}) {
  const runId = clean(run?.id, 180);
  const jobId = clean(run?.jobId, 180);
  if (!runId) return { reconciled: false, reason: "run_missing" };
  const work = async (tx) => {
    if (!subscriberDerivedPlanningConverged(planning)) {
      return { reconciled: false, reason: "planning_failed", durableRetryRequired: true };
    }
    if (!jobId || typeof tx?.jobInstance?.findUnique !== "function") {
      const marked = await markSubscriberPublicationJobReconciled(tx, runId, now);
      return { reconciled: marked, reason: "job_missing" };
    }
    const currentJob = await tx.jobInstance.findUnique({
      where: { id: jobId },
      select: { id: true, status: true, leaseUntil: true, leaseRevision: true },
    }).catch(() => null);
    if (!currentJob) {
      const marked = await markSubscriberPublicationJobReconciled(tx, runId, now);
      return { reconciled: marked, reason: "job_missing" };
    }
    if (currentJob.status === "DONE") {
      await markSubscriberPublicationJobReconciled(tx, runId, now);
      return { reconciled: true, reason: "already_done" };
    }
    const leaseUntil = dateOrNull(currentJob.leaseUntil);
    if (currentJob.status === "CLAIMED" && leaseUntil && leaseUntil > now) {
      return { reconciled: false, reason: "active_claim" };
    }
    const resultPayload = {
      type: "subscriber_directory",
      runId,
      recoveredPublication: true,
      summary: summary || run.summary || {},
      ...(planning || {}),
    };
    const where = {
      id: jobId,
      status: currentJob.status,
      leaseRevision: Number(currentJob.leaseRevision || 0),
      ...(currentJob.status === "CLAIMED" ? { leaseUntil: { lte: now } } : {}),
    };
    const updated = await tx.jobInstance.updateMany({
      where,
      data: {
        status: "DONE", completedAt: now, lastError: null, result: resultPayload,
        claimedAt: null, claimedByDeviceId: null, leaseUntil: null, leaseTokenHash: null, workId: null, continuation: null,
        progress: { percent: 100, message: "Subscriber snapshot publication recovered" },
        lastProgressAt: now,
      },
    });
    if (!Number(updated?.count || 0)) return { reconciled: false, reason: "job_raced" };
    if (typeof tx?.fanObservationReadLease?.deleteMany === "function") {
      await tx.fanObservationReadLease.deleteMany({ where: { jobId } }).catch(() => null);
    }
    await markSubscriberPublicationJobReconciled(tx, runId, now);
    return { reconciled: true, reason: "done" };
  };
  if (typeof db?.$transaction === "function") {
    return db.$transaction(work, { maxWait: 10_000, timeout: 30_000 });
  }
  return work(db);
}

function subscriberRecoveryJobNeedsPlanning(job, now) {
  if (!job) return true;
  if (job.status === "DONE") return false;
  const leaseUntil = dateOrNull(job.leaseUntil);
  return !(job.status === "CLAIMED" && leaseUntil && leaseUntil > now);
}

async function repairSubscriberDirectoryStateGeneration({ db = prisma, agencyId, creatorId } = {}) {
  const agency = clean(agencyId, 180);
  const creator = clean(creatorId, 180);
  if (!agency || !creator || typeof db?.$queryRawUnsafe !== "function") return { repaired: false, reason: "scope_missing" };
  // Bounded index-backed generation authority. Do not aggregate O(all history)
  // under the agency-wide automation fence.
  const rows = await db.$queryRawUnsafe(`
    SELECT
      COALESCE((
        SELECT r."publicationGeneration"
        FROM "SubscriberScanRun" r
        WHERE r."agencyId"=$1 AND r."creatorId"=$2
        ORDER BY r."publicationGeneration" DESC, r."id" DESC
        LIMIT 1
      ),0)::int AS "maxGeneration",
      COALESCE((
        SELECT r."publicationGeneration"
        FROM "SubscriberScanRun" r
        WHERE r."agencyId"=$1 AND r."creatorId"=$2
          AND r."status" IN ('PUBLISHED','SUPERSEDED')
          AND r."publicationStatus"='COMPLETE'
        ORDER BY r."publicationGeneration" DESC, r."id" DESC
        LIMIT 1
      ),0)::int AS "maxPublishedGeneration"
  `, agency, creator);
  const maxGeneration = Number(rows?.[0]?.maxGeneration || 0);
  const maxPublishedGeneration = Number(rows?.[0]?.maxPublishedGeneration || 0);
  if (maxGeneration <= 0) return { repaired: false, reason: "no_runs", maxGeneration: 0, maxPublishedGeneration: 0 };

  const existing = await db.subscriberDirectoryState.findUnique({ where: { creatorId: creator } }).catch(() => null);
  if (!existing) {
    try {
      await db.subscriberDirectoryState.create({
        data: {
          agencyId: agency,
          creatorId: creator,
          status: maxPublishedGeneration > 0 ? "READY" : "SCANNING",
          publicationGeneration: maxGeneration,
          publishedGeneration: maxPublishedGeneration,
          summary: { repairedBy: "subscriber_maintenance_a26" },
        },
      });
      return { repaired: true, created: true, maxGeneration, maxPublishedGeneration };
    } catch (error) {
      if (error?.code !== "P2002") throw error;
    }
  }
  if (typeof db?.$queryRawUnsafe === "function") {
    const repairedRows = await db.$queryRawUnsafe(`
      UPDATE "SubscriberDirectoryState"
      SET "publicationGeneration" = GREATEST("publicationGeneration", $3),
          "publishedGeneration" = GREATEST("publishedGeneration", $4),
          "updatedAt" = NOW()
      WHERE "agencyId" = $1
        AND "creatorId" = $2
        AND ("publicationGeneration" < $3 OR "publishedGeneration" < $4)
      RETURNING "publicationGeneration", "publishedGeneration"
    `, agency, creator, maxGeneration, maxPublishedGeneration);
    return {
      repaired: Array.isArray(repairedRows) && repairedRows.length > 0,
      created: false,
      maxGeneration,
      maxPublishedGeneration,
      publicationGeneration: Number(repairedRows?.[0]?.publicationGeneration ?? existing?.publicationGeneration ?? 0),
      publishedGeneration: Number(repairedRows?.[0]?.publishedGeneration ?? existing?.publishedGeneration ?? 0),
    };
  }
  const nextPublicationGeneration = Math.max(Number(existing?.publicationGeneration || 0), maxGeneration);
  const nextPublishedGeneration = Math.max(Number(existing?.publishedGeneration || 0), maxPublishedGeneration);
  const updated = await db.subscriberDirectoryState.updateMany({
    where: {
      creatorId: creator,
      OR: [
        { publicationGeneration: { lt: nextPublicationGeneration } },
        { publishedGeneration: { lt: nextPublishedGeneration } },
      ],
    },
    data: {
      publicationGeneration: nextPublicationGeneration,
      publishedGeneration: nextPublishedGeneration,
    },
  });
  return { repaired: Number(updated?.count || 0) > 0, created: false, maxGeneration, maxPublishedGeneration };
}

async function findSubscriberPublicationDebtForCreator(db, { agencyId, creatorId } = {}) {
  const scope = { agencyId: clean(agencyId, 180), creatorId: clean(creatorId, 180) };
  if (!scope.agencyId || !scope.creatorId) return null;
  return db.subscriberScanRun.findFirst({
    where: subscriberPublicationDebtWhere(scope),
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    select: {
      id: true, agencyId: true, creatorId: true, jobId: true, status: true, publicationStatus: true,
      publicationJobReconciledAt: true, summary: true, updatedAt: true,
    },
  });
}

async function hasSubscriberPublicationDebt({ db = prisma, agencyId, creatorId } = {}) {
  return Boolean(await findSubscriberPublicationDebtForCreator(db, { agencyId, creatorId }));
}

async function recoverSubscriberPublicationDebt({
  db = prisma,
  agencyId,
  creatorId,
  now = null,
  maxRuns = 4,
  maxStepsPerRun = 4,
  maxRuntimeMs = 5_000,
  beforePlanning = null,
  maintenanceSignal = null,
  scheduleFanRefresh = null,
} = {}) {
  const agency = clean(agencyId, 180);
  const creator = clean(creatorId, 180);
  if (!agency || !creator) {
    const error = new Error("Subscriber publication recovery requires explicit agencyId and creatorId");
    error.code = "SUBSCRIBER_RECOVERY_CREATOR_SCOPE_REQUIRED";
    throw error;
  }
  if (typeof db?.$transaction !== "function" || typeof db?.subscriberScanRun?.findFirst !== "function") {
    return { ok: true, recoveredRuns: 0, advancedSteps: 0, reason: "adapter_unsupported" };
  }
  const authorityNow = await dbAuthorityNow({ db, fallbackNow: now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date() });
  const runLimit = Math.max(1, Math.min(10, Number(maxRuns) || 4));
  const stepLimit = Math.max(1, Math.min(20, Number(maxStepsPerRun) || 4));
  const runtimeBudget = Math.max(500, Math.min(30_000, Number(maxRuntimeMs) || 5_000));
  const started = Date.now();
  let advancedSteps = 0;
  let recoveredRuns = 0;
  let reconciledJobs = 0;
  let planningRuns = 0;
  let stateRepairs = 0;
  let budgetExhausted = false;

  const repair = await publicationTransaction(db, agency, creator, (tx) => repairSubscriberDirectoryStateGeneration({ db: tx, agencyId: agency, creatorId: creator }), {
    maxWaitMs: Math.min(1_000, runtimeBudget), timeoutMs: Math.min(3_000, runtimeBudget), maintenanceSignal,
  });
  if (repair?.repaired) stateRepairs += 1;

  for (let runIndex = 0; runIndex < runLimit; runIndex += 1) {
    const elapsed = Date.now() - started;
    if (elapsed >= runtimeBudget) { budgetExhausted = true; break; }
    const candidate = await findSubscriberPublicationDebtForCreator(db, { agencyId: agency, creatorId: creator });
    if (!candidate) break;
    const job = candidate.jobId && typeof db?.jobInstance?.findUnique === "function"
      ? await db.jobInstance.findUnique({
          where: { id: candidate.jobId },
          select: { id: true, params: true, status: true, leaseUntil: true, leaseRevision: true },
        }).catch(() => null)
      : null;
    const state = typeof db?.subscriberDirectoryState?.findUnique === "function"
      ? await db.subscriberDirectoryState.findUnique({ where: { creatorId: creator }, select: { scanEveryDays: true } }).catch(() => null)
      : null;
    const scanEveryDays = integer(job?.params?.scanEveryDays ?? state?.scanEveryDays, DEFAULT_SCAN_EVERY_DAYS, 1, 30);
    let completeResult = null;
    if (["PUBLISHED", "SUPERSEDED"].includes(String(candidate.status || "")) && String(candidate.publicationStatus || "") === "COMPLETE") {
      completeResult = { complete: true, run: candidate, summary: candidate.summary || {} };
    } else {
      for (let step = 0; step < stepLimit; step += 1) {
        const remaining = runtimeBudget - (Date.now() - started);
        if (remaining < 300) { budgetExhausted = true; break; }
        const transactionBudget = Math.max(250, Math.min(5_000, remaining));
        const result = await publicationTransaction(db, agency, creator, (tx) => advanceSubscriberPublication(tx, {
          runId: candidate.id,
          jobId: candidate.jobId || null,
          scanEveryDays,
        }), { maxWaitMs: Math.min(1_000, transactionBudget), timeoutMs: transactionBudget, maintenanceSignal });
        advancedSteps += 1;
        if (result?.complete) {
          recoveredRuns += 1;
          completeResult = result;
          break;
        }
      }
    }
    if (!completeResult?.complete) break;
    const freshRun = completeResult.run || await db.subscriberScanRun.findUnique({ where: { id: candidate.id } }).catch(() => candidate);
    let planning = null;
    const publishedRun = freshRun || candidate;
    let reconciled = null;

    if (maintenanceSignal) {
      const fencedResult = await publicationTransaction(db, agency, creator, async (tx, claim) => {
        const txRun = await tx.subscriberScanRun.findUnique({ where: { id: publishedRun.id } }).catch(() => publishedRun);
        const txJob = txRun?.jobId
          ? await tx.jobInstance.findUnique({
              where: { id: txRun.jobId },
              select: { id: true, params: true, status: true, leaseUntil: true, leaseRevision: true },
            }).catch(() => job)
          : job;
        let txPlanning = null;
        let txPlanningRuns = 0;
        const claimNow = claim?.authorityNow instanceof Date ? claim.authorityNow : authorityNow;
        if (String(txRun?.status || "") === "PUBLISHED" && subscriberRecoveryJobNeedsPlanning(txJob, claimNow)) {
          txPlanning = await planSubscriberDerivedAutomation({
            run: txRun,
            userId: null,
            db: tx,
            source: "subscriber_snapshot_recovered",
            fencedMaintenance: true,
            scheduleFanRefresh,
          });
          txPlanningRuns = 1;
        }
        const txReconciled = await reconcileRecoveredSubscriberPublicationJob(tx, {
          run: txRun || publishedRun,
          summary: completeResult.summary || txRun?.summary || publishedRun.summary || {},
          planning: txPlanning,
          now: claimNow,
        });
        return { planning: txPlanning, planningRuns: txPlanningRuns, reconciled: txReconciled };
      }, {
        maxWaitMs: Math.min(2_000, Math.max(500, runtimeBudget - (Date.now() - started))),
        timeoutMs: Math.min(15_000, Math.max(1_500, runtimeBudget - (Date.now() - started) + 2_000)),
        maintenanceSignal,
      });
      planning = fencedResult?.planning || null;
      planningRuns += Number(fencedResult?.planningRuns || 0);
      reconciled = fencedResult?.reconciled || { reconciled: false, reason: "claim_fenced_no_result" };
    } else {
      if (String(publishedRun?.status || "") === "PUBLISHED" && subscriberRecoveryJobNeedsPlanning(job, authorityNow)) {
        if (typeof beforePlanning === "function" && !(await beforePlanning({ run: publishedRun, job }))) {
          return {
            ok: true, creatorId: creator, advancedSteps, recoveredRuns, reconciledJobs, planningRuns, stateRepairs,
            budgetExhausted, staleClaim: true, reason: "maintenance_claim_stale",
          };
        }
        planning = await planSubscriberDerivedAutomation({
          run: publishedRun,
          userId: null,
          db,
          source: "subscriber_snapshot_recovered",
          scheduleFanRefresh,
        });
        planningRuns += 1;
      }
      reconciled = await reconcileRecoveredSubscriberPublicationJob(db, {
        run: freshRun || candidate,
        summary: completeResult.summary || freshRun?.summary || candidate.summary || {},
        planning,
        now: authorityNow,
      });
    }
    if (reconciled.reconciled) reconciledJobs += 1;
    if (!reconciled.reconciled && reconciled.reason === "active_claim") break;
  }

  return {
    ok: true,
    creatorId: creator,
    advancedSteps,
    recoveredRuns,
    reconciledJobs,
    planningRuns,
    stateRepairs,
    budgetExhausted,
    reason: reconciledJobs ? "reconciled" : (recoveredRuns ? "recovered" : (advancedSteps ? "advanced" : (budgetExhausted ? "budget_exhausted" : "none_due"))),
  };
}

async function cleanupSubscriberScanHistory({ db = prisma, agencyId = null, creatorId, keep = 2, maxRuns = 50, maintenanceSignal = null } = {}) {
  const creator = clean(creatorId, 180);
  if (!creator) return { deletedRuns: 0, reason: "creator_missing" };
  let agency = clean(agencyId, 180);
  if (!agency) {
    const state = await db.subscriberDirectoryState.findUnique({ where: { creatorId: creator }, select: { agencyId: true } }).catch(() => null);
    agency = clean(state?.agencyId, 180);
  }
  const batch = Math.max(1, Math.min(200, Number(maxRuns) || 50));
  const parsedKeep = Number(keep);
  const retain = Math.max(0, Math.min(20, Number.isFinite(parsedKeep) ? parsedKeep : 2));
  const work = async (tx) => {
    const debt = await tx.subscriberScanRun.findFirst({ where: subscriberPublicationDebtWhere({ agencyId: agency || undefined, creatorId: creator }), select: { id: true } });
    if (debt) return { deletedRuns: 0, blockedByPublicationDebt: true, reason: "publication_debt" };
    const state = await tx.subscriberDirectoryState.findUnique({ where: { creatorId: creator }, select: { currentRunId: true, previousRunId: true } }).catch(() => null);
    const keepIds = new Set([state?.currentRunId, state?.previousRunId].filter(Boolean));
    const old = await tx.subscriberScanRun.findMany({
      where: {
        creatorId: creator,
        status: { in: ["SUPERSEDED", "FAILED"] },
        publicationStatus: "COMPLETE",
        ...(keepIds.size ? { id: { notIn: [...keepIds] } } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: retain,
      take: batch,
      select: { id: true },
    });
    if (old.length) await tx.subscriberScanRun.deleteMany({ where: { id: { in: old.map((item) => item.id) }, publicationStatus: "COMPLETE" } });
    return { deletedRuns: old.length, hasMore: old.length === batch, blockedByPublicationDebt: false, reason: old.length ? "deleted" : "none_due" };
  };
  if (agency) return publicationTransaction(db, agency, creator, work, { maxWaitMs: 2_000, timeoutMs: 5_000, maintenanceSignal });
  return work(db);
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
  const rawItems = Array.isArray(rows) ? rows : [];
  const currentRows = await readFanCurrent(prisma, {
    agencyId, creatorId, onlyFansUserIds: rawItems.map((item) => item.fanId).filter(Boolean),
  });
  const currentByFan = new Map(currentRows.map((row) => [String(row.onlyFansUserId), row]));
  const items = rawItems.map((item) => {
    const current = currentByFan.get(String(item.fanId || '')) || null;
    return {
      ...item,
      platformIdentity: current?.platformIdentity || null,
      relationship: current?.relationship || null,
      value: current?.value || null,
      username: current?.platformIdentity?.username ?? item.username ?? null,
      name: current?.platformIdentity?.platformDisplayName ?? item.name ?? null,
      avatarUrl: current?.platformIdentity?.avatarUrl ?? item.avatarUrl ?? null,
      totalSpentCents: current?.value?.availability === 'AVAILABLE'
        ? current.value.platformReportedTotalSpendCents
        : null,
      platformReportedTotalSpendCents: current?.value?.platformReportedTotalSpendCents ?? null,
      valueAvailability: current?.value?.availability ?? 'NOT_FETCHED',
      // Legacy flat aliases are response-time derivations of canonical current.
      // lastSeenIsNull remains immutable snapshot/cohort evidence.
      canReceiveChatMessage: current?.relationship?.canReceiveChatMessage ?? null,
      isActive: current?.relationship?.fanSubscriptionActive ?? null,
      subscribedOn: current?.relationship?.fanSubscribesToCreator ?? null,
      subscribedBy: current?.relationship?.creatorFollowsFan ?? null,
      subscriptionType: current?.relationship?.fanSubscriptionType ?? null,
      lastSeenAt: current?.relationship?.lastSeenAt ?? null,
      metadata: object(item.metadata),
    };
  });
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
  await prisma.automationBumpFanState.upsert({
    where: { creatorId_fanId: { creatorId, fanId } },
    create: {
      agencyId, creatorId, fanId, dialogId: item.dialogId || fanId,
      ignored: normalizedStatus === "ignored",
      blocked: normalizedStatus === "blocked",
      metadata: { source: "hidden_online_status", statusChangedAt: new Date().toISOString() },
    },
    update: {
      dialogId: item.dialogId || fanId,
      ignored: normalizedStatus === "ignored",
      blocked: normalizedStatus === "blocked",
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
  recoverSubscriberPublicationDebt,
  repairSubscriberDirectoryStateGeneration,
  hasSubscriberPublicationDebt,
  cleanupSubscriberScanHistory,
  getSubscriberDirectoryStatus,
  listHiddenOnline,
  setHiddenOnlineStatus,
  _test: { publishRun, advanceSubscriberPublication, assertSubscriberPublicationBarrier, publicationTransaction, planSubscriberDerivedAutomation, subscriberDerivedPlanningConverged },
};

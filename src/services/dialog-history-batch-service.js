"use strict";

const { createHash, randomBytes } = require("node:crypto");
const prisma = require("../prisma");

const DIALOG_HISTORY_BATCH_DIALOG_ID = "__dialog_history_batch__";
const ACTIVE_BATCH_STATUSES = ["QUEUED", "RUNNING"];
// The database partial unique index also treats PAUSED as active. A paused
// creator must therefore stay unavailable to the batch claimer until the
// explicit resume flow returns that run to the frozen plan.
const CLAIM_BLOCKING_BATCH_STATUSES = ["QUEUED", "RUNNING", "PAUSED"];
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_LEASE_MS = 10 * 60_000;
const MIN_LEASE_MS = 60_000;
const MAX_LEASE_MS = 30 * 60_000;
const BATCH_TRANSACTION_OPTIONS = Object.freeze({ maxWait: 10_000, timeout: 60_000 });

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function list(value) { return Array.isArray(value) ? value : []; }
function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}
function integer(value, fallback = 0, min = 0, max = 2_000_000_000) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}
function dateOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
function hashToken(token) {
  return createHash("sha256").update(String(token || "")).digest("hex");
}
function leaseMs(value) {
  return integer(value, DEFAULT_LEASE_MS, MIN_LEASE_MS, MAX_LEASE_MS);
}
function batchSize(value) {
  return integer(value, DEFAULT_BATCH_SIZE, 1, 100);
}
function compactResult(raw) {
  const value = object(raw);
  return {
    dialogId: clean(value.dialogId, 180),
    ok: value.ok === true,
    retryable: value.retryable !== false,
    pages: integer(value.pages, 0, 0, 100_000),
    messages: integer(value.messages, 0, 0, 100_000_000),
    inserted: integer(value.inserted, 0, 0, 100_000_000),
    updated: integer(value.updated, 0, 0, 100_000_000),
    error: clean(value.error, 2_000),
    reusedLocal: value.reusedLocal === true,
  };
}
function compactBatchProgress(raw, previous = {}) {
  const value = object(raw);
  const before = object(previous);
  const total = integer(value.total ?? before.total, 0, 0, 100);
  const current = integer(value.current ?? before.current, 0, 0, total || 100);
  const stage = clean(value.stage, 40) || clean(before.stage, 40) || "scanning";
  return {
    current,
    total,
    completed: integer(value.completed ?? before.completed, 0, 0, total || 100),
    failed: integer(value.failed ?? before.failed, 0, 0, total || 100),
    replanned: integer(value.replanned ?? before.replanned, 0, 0, total || 100),
    dialogId: clean(value.dialogId, 180),
    fanId: clean(value.fanId, 180),
    stage,
    pages: integer(value.pages, 0, 0, 100_000),
    messages: integer(value.messages, 0, 0, 100_000_000),
    media: integer(value.media, 0, 0, 100_000_000),
    lastError: clean(value.lastError, 2_000),
    message: clean(value.message, 500) || `Dialog batch ${stage} · ${current}/${total}`,
    updatedAt: new Date().toISOString(),
  };
}

async function assertAllowedCreators(db, agencyId, creatorIds) {
  const ids = [...new Set(list(creatorIds).map((value) => clean(value, 160)).filter(Boolean))].slice(0, 1_000);
  if (!agencyId || ids.length === 0) return [];
  const rows = await db.creatorAccount.findMany({
    where: { agencyId, id: { in: ids }, deletedAt: null },
    select: { id: true },
    take: ids.length,
  });
  return rows.map((row) => row.id);
}

async function lockDialogHistoryBatchClaimsTx(db, agencyId) {
  // Serialise the short claim transaction across every backend instance for an
  // agency. The unique index remains the final safety fence, while this lock
  // prevents normal concurrent polling from surfacing an expected P2002 in
  // Prisma logs. Test doubles without raw-query support remain usable.
  if (typeof db.$queryRawUnsafe !== "function") return;
  await db.$queryRawUnsafe(
    "SELECT pg_advisory_xact_lock(hashtext($1))::text AS \"acquired\"",
    `dialog_history_batch_claim:${agencyId}`,
  );
}

async function recoverExpiredDialogHistoryBatchesTx(db, input = {}) {
  const agencyId = clean(input.agencyId, 160);
  const creatorIds = [...new Set(list(input.creatorIds).map((value) => clean(value, 160)).filter(Boolean))].slice(0, 1_000);
  if (!agencyId) return { recovered: 0, dialogCount: 0 };
  const now = input.now instanceof Date ? input.now : new Date();
  const runs = await db.dialogScanRun.findMany({
    where: {
      agencyId,
      dialogId: DIALOG_HISTORY_BATCH_DIALOG_ID,
      status: { in: ACTIVE_BATCH_STATUSES },
      ...(creatorIds.length ? { creatorId: { in: creatorIds } } : {}),
    },
    orderBy: { updatedAt: "asc" },
    take: 1_000,
  });
  let recovered = 0;
  let dialogCount = 0;
  for (const run of runs) {
    const continuation = object(run.continuation);
    const expiresAt = dateOrNull(continuation.leaseUntil);
    if (!expiresAt || expiresAt.getTime() > now.getTime()) continue;
    const reset = await db.dialogScanState.updateMany({
      where: { agencyId, creatorId: run.creatorId, activeRunId: run.id },
      data: {
        status: "PLANNED",
        activeRunId: null,
        activeJobId: null,
        lastError: null,
      },
    });
    await db.dialogScanRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        completedAt: now,
        lastError: "DIALOG_HISTORY_BATCH_LEASE_EXPIRED",
        progress: {
          ...object(run.progress),
          expired: true,
          expiredAt: now.toISOString(),
          releasedDialogs: reset.count,
        },
      },
    });
    recovered += 1;
    dialogCount += reset.count;
  }
  return { recovered, dialogCount };
}

async function claimDialogHistoryBatchTx(db, input) {
  const agencyId = clean(input.agencyId, 160);
  const deviceId = clean(input.deviceId, 200);
  if (!agencyId || !deviceId) throw new Error("agencyId and deviceId are required");
  const control = await db.moduleSetting.findUnique({
    where: { agencyId_moduleKey: { agencyId, moduleKey: "dialog_intelligence" } },
    select: { enabled: true },
  });
  if (control?.enabled === false) return { ok: true, batch: null, reason: "module_disabled" };
  const allowedCreatorIds = await assertAllowedCreators(db, agencyId, input.creatorIds);
  if (!allowedCreatorIds.length) return { ok: true, batch: null, reason: "no_ready_creators" };

  await lockDialogHistoryBatchClaimsTx(db, agencyId);
  await recoverExpiredDialogHistoryBatchesTx(db, { agencyId, creatorIds: allowedCreatorIds });

  const blockingRuns = await db.dialogScanRun.findMany({
    where: {
      agencyId,
      creatorId: { in: allowedCreatorIds },
      dialogId: DIALOG_HISTORY_BATCH_DIALOG_ID,
      status: { in: CLAIM_BLOCKING_BATCH_STATUSES },
    },
    select: { creatorId: true },
    take: allowedCreatorIds.length,
  });
  const blockedCreatorIds = new Set(blockingRuns.map((run) => clean(run.creatorId, 160)).filter(Boolean));

  // Discovery writes PLANNED rows page-by-page, but they are not claimable until
  // the newest discovery generation is fully frozen. This prevents a second
  // Desktop from consuming a half-built list while another worker is still
  // enumerating dialogs.
  let first = null;
  let completedDiscovery = null;
  for (const candidateCreatorId of allowedCreatorIds) {
    if (blockedCreatorIds.has(candidateCreatorId)) continue;
    const latestDiscovery = await db.dialogScanRun.findFirst({
      where: { agencyId, creatorId: candidateCreatorId, dialogId: "__dialog_discovery__" },
      orderBy: { createdAt: "desc" },
    });
    if (!latestDiscovery || clean(latestDiscovery.status, 40).toUpperCase() !== "COMPLETED") continue;
    const candidate = await db.dialogScanState.findFirst({
      where: {
        agencyId,
        creatorId: candidateCreatorId,
        generation: integer(latestDiscovery.generation, 0),
        dialogId: { notIn: ["__dialog_discovery__", DIALOG_HISTORY_BATCH_DIALOG_ID] },
        status: "PLANNED",
      },
      orderBy: [{ updatedAt: "asc" }, { dialogId: "asc" }],
    });
    if (!candidate) continue;
    first = candidate;
    completedDiscovery = latestDiscovery;
    break;
  }
  if (!first || !completedDiscovery) {
    return {
      ok: true,
      batch: null,
      reason: blockedCreatorIds.size ? "creator_batch_already_active" : "no_frozen_dialog_batch_ready",
    };
  }

  const creatorId = first.creatorId;
  const generation = integer(completedDiscovery.generation, integer(first.generation, 0));
  const mode = clean(first.scanMode, 40) || (first.initialScanComplete ? "incremental" : "initial");
  const wanted = batchSize(input.batchSize);
  const candidates = await db.dialogScanState.findMany({
    where: {
      agencyId,
      creatorId,
      generation,
      dialogId: { notIn: ["__dialog_discovery__", DIALOG_HISTORY_BATCH_DIALOG_ID] },
      status: "PLANNED",
      ...(mode === "initial" ? { initialScanComplete: false } : {}),
    },
    orderBy: [{ updatedAt: "asc" }, { dialogId: "asc" }],
    take: wanted * 3,
  });
  if (!candidates.length) return { ok: true, batch: null, reason: "plan_generation_drained" };

  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + leaseMs(input.leaseMs));
  const run = await db.dialogScanRun.create({
    data: {
      agencyId,
      creatorId,
      dialogId: DIALOG_HISTORY_BATCH_DIALOG_ID,
      fanId: null,
      mode: `${mode}_batch`,
      source: "dialog_history_batch_claim",
      status: "RUNNING",
      generation,
      continuation: {
        kind: "dialog_history_batch",
        claimedByDeviceId: deviceId,
        leaseTokenHash: hashToken(token),
        leaseRevision: 1,
        leaseUntil: expiresAt.toISOString(),
        mode,
        dialogs: [],
      },
      progress: { current: 0, total: 0, completed: 0, failed: 0, message: "Dialog batch claimed" },
      startedAt: now,
      createdByDeviceId: deviceId,
      lastWorkerDeviceId: deviceId,
    },
  });

  const claimed = [];
  for (const state of candidates) {
    if (claimed.length >= wanted) break;
    const updated = await db.dialogScanState.updateMany({
      where: { id: state.id, status: "PLANNED" },
      data: {
        status: "RUNNING",
        scanMode: mode,
        activeRunId: run.id,
        activeJobId: null,
        lastError: null,
      },
    });
    if (updated.count === 1) {
      claimed.push({
        dialogId: state.dialogId,
        fanId: state.fanId || state.dialogId,
        mode: mode === "initial" && state.initialScanComplete ? "incremental" : mode,
      });
    }
  }

  if (!claimed.length) {
    await db.dialogScanRun.delete({ where: { id: run.id } });
    return { ok: true, batch: null, reason: "claim_race_lost" };
  }

  const continuation = {
    kind: "dialog_history_batch",
    claimedByDeviceId: deviceId,
    leaseTokenHash: hashToken(token),
    leaseRevision: 1,
    leaseUntil: expiresAt.toISOString(),
    mode,
    dialogs: claimed,
  };
  const updatedRun = await db.dialogScanRun.update({
    where: { id: run.id },
    data: {
      continuation,
      progress: {
        current: 0,
        total: claimed.length,
        completed: 0,
        failed: 0,
        message: `Dialog batch claimed · ${claimed.length} dialogs`,
      },
    },
  });

  return {
    ok: true,
    reason: "claimed",
    batch: {
      id: updatedRun.id,
      creatorId,
      generation,
      mode,
      dialogs: claimed,
      leaseToken: token,
      leaseRevision: 1,
      leaseUntil: expiresAt.toISOString(),
    },
  };
}

async function claimDialogHistoryBatch(input) {
  try {
    return await prisma.$transaction((tx) => claimDialogHistoryBatchTx(tx, input), BATCH_TRANSACTION_OPTIONS);
  } catch (error) {
    // A rolling deploy can briefly overlap an older instance that does not yet
    // take the advisory lock. The partial unique index still chooses one
    // winner; the loser is an idle claim response, not a failed scan.
    if (error?.code === "P2002") {
      return { ok: true, batch: null, reason: "creator_batch_already_active" };
    }
    throw error;
  }
}

async function requireBatchLeaseTx(db, input, options = {}) {
  const agencyId = clean(input.agencyId, 160);
  const deviceId = clean(input.deviceId, 200);
  const batchId = clean(input.batchId, 160);
  const token = clean(input.leaseToken, 500);
  if (!agencyId || !deviceId || !batchId || !token) {
    const error = new Error("Batch lease scope is incomplete");
    error.code = "DIALOG_BATCH_LEASE_INVALID";
    error.status = 400;
    throw error;
  }
  const run = await db.dialogScanRun.findFirst({
    where: { id: batchId, agencyId, dialogId: DIALOG_HISTORY_BATCH_DIALOG_ID },
  });
  if (!run) {
    const error = new Error("Dialog history batch not found");
    error.code = "DIALOG_BATCH_NOT_FOUND";
    error.status = 404;
    throw error;
  }
  const continuation = object(run.continuation);
  if (clean(continuation.claimedByDeviceId, 200) !== deviceId) {
    const error = new Error("Dialog history batch is claimed by another device");
    error.code = "DIALOG_BATCH_CLAIMED_BY_OTHER";
    error.status = 409;
    throw error;
  }
  if (clean(continuation.leaseTokenHash, 128) !== hashToken(token)) {
    const error = new Error("Dialog history batch lease token is stale");
    error.code = "DIALOG_BATCH_LEASE_STALE";
    error.status = 409;
    throw error;
  }
  const status = clean(run.status, 40).toUpperCase();
  if (!ACTIVE_BATCH_STATUSES.includes(status)) {
    if (!(options.allowCompleted === true && status === "COMPLETED")) {
      const error = new Error("Dialog history batch is no longer active");
      error.code = "DIALOG_BATCH_NOT_ACTIVE";
      error.status = 409;
      throw error;
    }
    return { run, continuation };
  }
  const expiresAt = dateOrNull(continuation.leaseUntil);
  if (!expiresAt || expiresAt.getTime() <= Date.now()) {
    const error = new Error("Dialog history batch lease expired");
    error.code = "DIALOG_BATCH_LEASE_EXPIRED";
    error.status = 409;
    throw error;
  }
  return { run, continuation };
}

async function renewDialogHistoryBatchTx(tx, input) {
  const { run, continuation } = await requireBatchLeaseTx(tx, input);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + leaseMs(input.leaseMs));
  const next = {
    ...continuation,
    leaseUntil: expiresAt.toISOString(),
    leaseRevision: integer(continuation.leaseRevision, 1, 1) + 1,
  };
  await tx.dialogScanRun.update({
    where: { id: run.id },
    data: { continuation: next, lastWorkerDeviceId: clean(input.deviceId, 200) },
  });
  return { ok: true, batchId: run.id, leaseRevision: next.leaseRevision, leaseUntil: expiresAt.toISOString() };
}

async function renewDialogHistoryBatch(input) {
  return prisma.$transaction((tx) => renewDialogHistoryBatchTx(tx, input), BATCH_TRANSACTION_OPTIONS);
}

async function progressDialogHistoryBatchTx(tx, input) {
  const { run, continuation } = await requireBatchLeaseTx(tx, input);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + leaseMs(input.leaseMs));
  const nextContinuation = {
    ...continuation,
    leaseUntil: expiresAt.toISOString(),
  };
  const progress = compactBatchProgress(input.progress, run.progress);
  await tx.dialogScanRun.update({
    where: { id: run.id },
    data: {
      continuation: nextContinuation,
      progress,
      lastWorkerDeviceId: clean(input.deviceId, 200),
    },
  });
  return {
    ok: true,
    batchId: run.id,
    leaseUntil: expiresAt.toISOString(),
    progress,
  };
}

async function progressDialogHistoryBatch(input) {
  return prisma.$transaction((tx) => progressDialogHistoryBatchTx(tx, input), BATCH_TRANSACTION_OPTIONS);
}

async function completeDialogHistoryBatchTx(tx, input) {
  const { run, continuation } = await requireBatchLeaseTx(tx, input, { allowCompleted: true });
    if (clean(run.status, 40).toUpperCase() === "COMPLETED") {
      return { ok: true, ...object(continuation.completedSummary), replayed: true };
    }
    const claimedDialogs = list(continuation.dialogs)
      .map((item) => object(item))
      .map((item) => clean(item.dialogId, 180))
      .filter(Boolean);
    const results = new Map(
      list(input.results)
        .slice(0, 100)
        .map(compactResult)
        .filter((item) => item.dialogId)
        .map((item) => [item.dialogId, item]),
    );
    const now = new Date();
    let completed = 0;
    let replanned = 0;
    let failed = 0;
    let pages = 0;
    let messages = 0;
    let inserted = 0;
    let updated = 0;

    for (const dialogId of claimedDialogs) {
      const result = results.get(dialogId) || {
        dialogId,
        ok: false,
        retryable: true,
        pages: 0,
        messages: 0,
        inserted: 0,
        updated: 0,
        error: "DIALOG_BATCH_RESULT_MISSING",
      };
      pages += result.pages;
      messages += result.messages;
      inserted += result.inserted;
      updated += result.updated;
      if (result.ok) {
        completed += 1;
        await tx.dialogScanState.updateMany({
          where: { agencyId: run.agencyId, creatorId: run.creatorId, dialogId, activeRunId: run.id },
          data: {
            status: "READY",
            ...(String(run.mode).startsWith("initial")
              ? { initialScanComplete: true, lastFullScanAt: now }
              : { lastIncrementalScanAt: now }),
            pagesProcessed: { increment: result.pages },
            messagesProcessed: { increment: result.messages },
            activeRunId: null,
            activeJobId: null,
            lastError: null,
          },
        });
      } else if (result.retryable !== false) {
        replanned += 1;
        await tx.dialogScanState.updateMany({
          where: { agencyId: run.agencyId, creatorId: run.creatorId, dialogId, activeRunId: run.id },
          data: {
            status: "PLANNED",
            activeRunId: null,
            activeJobId: null,
            lastError: result.error || "Dialog batch item will be retried",
          },
        });
      } else {
        failed += 1;
        await tx.dialogScanState.updateMany({
          where: { agencyId: run.agencyId, creatorId: run.creatorId, dialogId, activeRunId: run.id },
          data: {
            status: "FAILED",
            activeRunId: null,
            activeJobId: null,
            lastError: result.error || "Dialog batch item failed",
          },
        });
      }
    }

    const summary = {
      batchId: run.id,
      total: claimedDialogs.length,
      completed,
      replanned,
      failed,
      pages,
      messages,
      inserted,
      updated,
      completedAt: now.toISOString(),
      localStorage: true,
    };
    await tx.dialogScanRun.update({
      where: { id: run.id },
      data: {
        status: "COMPLETED",
        completedAt: now,
        progress: {
          current: claimedDialogs.length,
          total: claimedDialogs.length,
          completed,
          replanned,
          failed,
          pages,
          messages,
          message: `Dialog batch complete · ${completed}/${claimedDialogs.length}`,
        },
        pagesProcessed: pages,
        messagesProcessed: messages,
        continuation: { ...continuation, completedSummary: summary, leaseUntil: null },
        lastWorkerDeviceId: clean(input.deviceId, 200),
        lastError: failed > 0 ? `${failed} dialog(s) failed` : null,
      },
    });
  return { ok: true, ...summary };
}

async function completeDialogHistoryBatch(input) {
  return prisma.$transaction((tx) => completeDialogHistoryBatchTx(tx, input), BATCH_TRANSACTION_OPTIONS);
}

async function releaseDialogHistoryBatchTx(tx, input) {
  const { run } = await requireBatchLeaseTx(tx, input);
    const now = new Date();
    const reset = await tx.dialogScanState.updateMany({
      where: { agencyId: run.agencyId, creatorId: run.creatorId, activeRunId: run.id },
      data: { status: "PLANNED", activeRunId: null, activeJobId: null, lastError: null },
    });
    await tx.dialogScanRun.update({
      where: { id: run.id },
      data: {
        status: "CANCELLED",
        completedAt: now,
        lastWorkerDeviceId: clean(input.deviceId, 200),
        lastError: clean(input.reason, 2_000) || "Dialog batch released",
        progress: {
          ...object(run.progress),
          released: true,
          reason: clean(input.reason, 2_000),
          releasedDialogs: reset.count,
          releasedAt: now.toISOString(),
        },
      },
    });
  return { ok: true, batchId: run.id, released: reset.count };
}

async function releaseDialogHistoryBatch(input) {
  return prisma.$transaction((tx) => releaseDialogHistoryBatchTx(tx, input), BATCH_TRANSACTION_OPTIONS);
}

module.exports = {
  DIALOG_HISTORY_BATCH_DIALOG_ID,
  DEFAULT_BATCH_SIZE,
  claimDialogHistoryBatchTx,
  claimDialogHistoryBatch,
  renewDialogHistoryBatchTx,
  renewDialogHistoryBatch,
  progressDialogHistoryBatchTx,
  progressDialogHistoryBatch,
  completeDialogHistoryBatchTx,
  completeDialogHistoryBatch,
  releaseDialogHistoryBatchTx,
  releaseDialogHistoryBatch,
  recoverExpiredDialogHistoryBatchesTx,
};

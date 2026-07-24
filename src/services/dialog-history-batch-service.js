"use strict";

const { createHash, randomBytes } = require("node:crypto");
const prisma = require("../prisma");
const {
  repairStrandedDialogHistoryStatesTx,
  dialogHistoryControl,
  finalizeCommittedDialogDiscoveryTx,
} = require("./dialog-intelligence-service");
const { isTerminalDialogOutcome } = require("./dialog-terminal-outcome");

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
function effectiveDialogMode(state, fallback = "initial") {
  const scanMode = clean(state?.scanMode, 40)?.toLowerCase();
  if (scanMode === "incremental") return "incremental";
  if (scanMode === "initial" || scanMode === "full") {
    return state?.initialScanComplete === true ? "incremental" : "initial";
  }
  return state?.initialScanComplete === true
    ? "incremental"
    : clean(fallback, 40)?.toLowerCase() === "incremental" ? "incremental" : "initial";
}
function isTerminalDialogAbsence(value) {
  return isTerminalDialogOutcome(value);
}

function compactResult(raw) {
  const value = object(raw);
  return {
    dialogId: clean(value.dialogId, 180),
    ok: value.ok === true,
    retryable: value.retryable !== false,
    pages: integer(value.pages, 0, 0, 100_000),
    messages: integer(value.messages, 0, 0, 100_000_000),
    received: integer(value.received, 0, 0, 100_000_000),
    inserted: integer(value.inserted, 0, 0, 100_000_000),
    updated: integer(value.updated, 0, 0, 100_000_000),
    duplicates: integer(value.duplicates, 0, 0, 100_000_000),
    skippedHistory: integer(value.skippedHistory, 0, 0, 100_000_000),
    localMessageCount: value.localMessageCount == null
      ? null
      : integer(value.localMessageCount, 0, 0, 100_000_000),
    newestMessageId: clean(value.newestMessageId, 240),
    newestMessageAt: dateOrNull(value.newestMessageAt),
    error: clean(value.error, 2_000),
    code: clean(value.code, 120),
    status: value.status == null ? null : integer(value.status, 0, 0, 599),
    unavailable: isTerminalDialogAbsence(value),
    reusedLocal: value.reusedLocal === true,
  };
}
function compactBatchProgress(raw, previous = {}) {
  const value = object(raw);
  const before = object(previous);
  const total = integer(value.total ?? before.total, 0, 0, 100);
  const current = integer(value.current ?? before.current, 0, 0, total || 100);
  const stage = clean(value.stage, 40) || clean(before.stage, 40) || "scanning";
  const messages = integer(value.messages ?? before.messages, 0, 0, 100_000_000);
  const receivedSource = value.received ?? before.received;
  const insertedSource = value.inserted ?? before.inserted;
  return {
    current,
    total,
    completed: integer(value.completed ?? before.completed, 0, 0, total || 100),
    failed: integer(value.failed ?? before.failed, 0, 0, total || 100),
    replanned: integer(value.replanned ?? before.replanned, 0, 0, total || 100),
    skipped: integer(value.skipped ?? before.skipped, 0, 0, total || 100),
    dialogId: clean(value.dialogId, 180),
    fanId: clean(value.fanId, 180),
    stage,
    pages: integer(value.pages ?? before.pages, 0, 0, 100_000),
    messages,
    received: receivedSource == null ? messages : integer(receivedSource, 0, 0, 100_000_000),
    inserted: insertedSource == null ? messages : integer(insertedSource, 0, 0, 100_000_000),
    updated: integer(value.updated ?? before.updated, 0, 0, 100_000_000),
    duplicates: integer(value.duplicates ?? before.duplicates, 0, 0, 100_000_000),
    skippedHistory: integer(value.skippedHistory ?? before.skippedHistory, 0, 0, 100_000_000),
    media: integer(value.media ?? before.media, 0, 0, 100_000_000),
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
    // A RUNNING/QUEUED synthetic batch without a valid lease can never be
    // renewed or released by a Desktop. Treat it exactly like an expired lease
    // instead of allowing it to block the creator forever.
    if (expiresAt && expiresAt.getTime() > now.getTime()) continue;
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
        lastError: expiresAt
          ? "DIALOG_HISTORY_BATCH_LEASE_EXPIRED"
          : "DIALOG_HISTORY_BATCH_LEASE_MISSING",
        continuation: {
          ...continuation,
          leaseUntil: null,
          normalizedAt: now.toISOString(),
        },
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

async function normalizeOrphanedDialogHistoryBatchesTx(db, input = {}) {
  const agencyId = clean(input.agencyId, 160);
  const creatorIds = [...new Set(list(input.creatorIds).map((value) => clean(value, 160)).filter(Boolean))].slice(0, 1_000);
  if (!agencyId) return { normalized: 0, dialogCount: 0 };
  const now = input.now instanceof Date ? input.now : new Date();
  const runs = await db.dialogScanRun.findMany({
    where: {
      agencyId,
      dialogId: DIALOG_HISTORY_BATCH_DIALOG_ID,
      status: { in: CLAIM_BLOCKING_BATCH_STATUSES },
      ...(creatorIds.length ? { creatorId: { in: creatorIds } } : {}),
    },
    orderBy: { updatedAt: "asc" },
    take: 1_000,
  });
  const latestDiscoveryByCreator = new Map();
  let normalized = 0;
  let dialogCount = 0;

  for (const run of runs) {
    let latestDiscovery = latestDiscoveryByCreator.get(run.creatorId);
    if (latestDiscovery === undefined) {
      latestDiscovery = await db.dialogScanRun.findFirst({
        where: { agencyId, creatorId: run.creatorId, dialogId: "__dialog_discovery__" },
        orderBy: { createdAt: "desc" },
      });
      latestDiscoveryByCreator.set(run.creatorId, latestDiscovery || null);
    }

    const ownedStates = await db.dialogScanState.findMany({
      where: { agencyId, creatorId: run.creatorId, activeRunId: run.id },
      take: 101,
    });
    const status = clean(run.status, 40).toUpperCase();
    const latestGeneration = integer(latestDiscovery?.generation, -1, -1);
    const runGeneration = integer(run.generation, -1, -1);
    const superseded = latestDiscovery
      && clean(latestDiscovery.status, 40).toUpperCase() === "COMPLETED"
      && latestGeneration >= 0
      && runGeneration !== latestGeneration;
    const ownsNoDialogs = ownedStates.length === 0;
    const pausedWithoutPausedDialogs = status === "PAUSED"
      && !ownedStates.some((state) => clean(state.status, 40).toUpperCase() === "PAUSED");

    if (!superseded && !ownsNoDialogs && !pausedWithoutPausedDialogs) continue;

    const reset = await db.dialogScanState.updateMany({
      where: { agencyId, creatorId: run.creatorId, activeRunId: run.id },
      data: {
        status: "PLANNED",
        activeRunId: null,
        activeJobId: null,
        lastError: null,
      },
    });
    const reason = superseded
      ? "DIALOG_HISTORY_BATCH_SUPERSEDED"
      : pausedWithoutPausedDialogs
        ? "DIALOG_HISTORY_BATCH_PAUSED_ORPHAN"
        : "DIALOG_HISTORY_BATCH_ORPHANED";
    await db.dialogScanRun.update({
      where: { id: run.id },
      data: {
        status: "CANCELLED",
        completedAt: now,
        pausedAt: null,
        lastError: reason,
        continuation: {
          ...object(run.continuation),
          leaseUntil: null,
          normalizedAt: now.toISOString(),
          normalizedReason: reason,
        },
        progress: {
          ...object(run.progress),
          normalized: true,
          normalizedAt: now.toISOString(),
          normalizedReason: reason,
          releasedDialogs: reset.count,
        },
      },
    });
    normalized += 1;
    dialogCount += reset.count;
  }

  return { normalized, dialogCount };
}

async function reclaimOwnedDialogHistoryBatchTx(db, input = {}) {
  const agencyId = clean(input.agencyId, 160);
  const deviceId = clean(input.deviceId, 200);
  const creatorIds = [...new Set(list(input.creatorIds).map((value) => clean(value, 160)).filter(Boolean))].slice(0, 1_000);
  if (!agencyId || !deviceId || !creatorIds.length) return null;

  const runs = await db.dialogScanRun.findMany({
    where: {
      agencyId,
      creatorId: { in: creatorIds },
      dialogId: DIALOG_HISTORY_BATCH_DIALOG_ID,
      status: { in: ACTIVE_BATCH_STATUSES },
    },
    orderBy: { updatedAt: "asc" },
    take: creatorIds.length,
  });

  for (const run of runs) {
    const continuation = object(run.continuation);
    if (clean(continuation.claimedByDeviceId, 200) !== deviceId) continue;
    const leaseUntil = dateOrNull(continuation.leaseUntil);
    if (!leaseUntil || leaseUntil.getTime() <= Date.now()) continue;

    const ownedStates = await db.dialogScanState.findMany({
      where: { agencyId, creatorId: run.creatorId, activeRunId: run.id },
      take: 100,
    });
    if (!ownedStates.length) continue;

    const stateByDialogId = new Map(ownedStates.map((state) => [clean(state.dialogId, 180), state]));
    const priorItems = list(continuation.dialogs).map((value) => object(value));
    const orderedDialogIds = [];
    for (const item of priorItems) {
      const dialogId = clean(item.dialogId, 180);
      if (dialogId && stateByDialogId.has(dialogId) && !orderedDialogIds.includes(dialogId)) orderedDialogIds.push(dialogId);
    }
    for (const state of ownedStates) {
      const dialogId = clean(state.dialogId, 180);
      if (dialogId && !orderedDialogIds.includes(dialogId)) orderedDialogIds.push(dialogId);
    }

    const priorByDialogId = new Map(priorItems.map((item) => [clean(item.dialogId, 180), item]));
    const dialogs = orderedDialogIds.map((dialogId) => {
      const state = stateByDialogId.get(dialogId);
      const prior = priorByDialogId.get(dialogId) || {};
      return {
        dialogId,
        fanId: clean(state?.fanId ?? prior.fanId, 180) || dialogId,
        mode: effectiveDialogMode(state, prior.mode),
      };
    });
    if (!dialogs.length) continue;

    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + leaseMs(input.leaseMs));
    const leaseRevision = integer(continuation.leaseRevision, 1, 1) + 1;
    const nextContinuation = {
      ...continuation,
      claimedByDeviceId: deviceId,
      leaseTokenHash: hashToken(token),
      leaseRevision,
      leaseUntil: expiresAt.toISOString(),
      dialogs,
      reattachedAt: now.toISOString(),
    };

    await db.dialogScanState.updateMany({
      where: { agencyId, creatorId: run.creatorId, activeRunId: run.id },
      data: { status: "RUNNING", activeJobId: null, lastError: null },
    });
    const updatedRun = await db.dialogScanRun.update({
      where: { id: run.id },
      data: {
        status: "RUNNING",
        continuation: nextContinuation,
        lastWorkerDeviceId: deviceId,
        lastError: null,
      },
    });

    return {
      id: updatedRun.id,
      creatorId: updatedRun.creatorId,
      generation: integer(updatedRun.generation, 0),
      mode: dialogs[0]?.mode || "initial",
      dialogs,
      leaseToken: token,
      leaseRevision,
      leaseUntil: expiresAt.toISOString(),
    };
  }

  return null;
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
  // The final discovery page may be committed even when the Desktop loses the
  // separate completion response. Finalize that durable boundary here too, so
  // the batch worker does not depend on someone opening the Vault status UI.
  for (const creatorId of allowedCreatorIds) {
    await finalizeCommittedDialogDiscoveryTx(db, { agencyId, creatorId });
  }
  await recoverExpiredDialogHistoryBatchesTx(db, { agencyId, creatorIds: allowedCreatorIds });
  await normalizeOrphanedDialogHistoryBatchesTx(db, { agencyId, creatorIds: allowedCreatorIds });
  for (const creatorId of allowedCreatorIds) {
    await repairStrandedDialogHistoryStatesTx(db, { agencyId, creatorId });
  }

  // The lease token lives only in the Desktop process. If that process crashes
  // or restarts, the same stable deviceId must be able to reattach to its own
  // still-live batch instead of waiting for the full lease window to expire.
  const reclaimed = await reclaimOwnedDialogHistoryBatchTx(db, {
    agencyId,
    deviceId,
    creatorIds: allowedCreatorIds,
    leaseMs: input.leaseMs,
  });
  if (reclaimed) return { ok: true, reason: "reclaimed", batch: reclaimed, settledCreators: [] };

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
  const controlledCreators = new Map();
  const settledCreators = [];
  for (const candidateCreatorId of allowedCreatorIds) {
    if (blockedCreatorIds.has(candidateCreatorId)) continue;
    const latestDiscovery = await db.dialogScanRun.findFirst({
      where: { agencyId, creatorId: candidateCreatorId, dialogId: "__dialog_discovery__" },
      orderBy: { createdAt: "desc" },
    });
    if (!latestDiscovery || clean(latestDiscovery.status, 40).toUpperCase() !== "COMPLETED") continue;
    const controlState = dialogHistoryControl(latestDiscovery).state;
    if (["PAUSED", "CANCELLED", "CANCELED"].includes(controlState)) {
      controlledCreators.set(candidateCreatorId, controlState);
      continue;
    }
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
    if (!candidate) {
      const settledAt = dateOrNull(latestDiscovery.completedAt || latestDiscovery.updatedAt || latestDiscovery.createdAt);
      settledCreators.push({
        creatorId: candidateCreatorId,
        generation: integer(latestDiscovery.generation, 0),
        settledAt: settledAt ? settledAt.toISOString() : null,
      });
      continue;
    }
    if (!first) {
      first = candidate;
      completedDiscovery = latestDiscovery;
    }
  }
  if (!first || !completedDiscovery) {
    return {
      ok: true,
      batch: null,
      settledCreators,
      reason: blockedCreatorIds.size
        ? "creator_batch_already_active"
        : [...controlledCreators.values()].includes("PAUSED")
          ? "dialog_history_paused"
          : ([...controlledCreators.values()].includes("CANCELLED") || [...controlledCreators.values()].includes("CANCELED"))
            ? "dialog_history_cancelled"
            : "no_frozen_dialog_batch_ready",
    };
  }

  const creatorId = first.creatorId;
  const generation = integer(completedDiscovery.generation, integer(first.generation, 0));
  const wanted = batchSize(input.batchSize);
  const candidates = await db.dialogScanState.findMany({
    where: {
      agencyId,
      creatorId,
      generation,
      dialogId: { notIn: ["__dialog_discovery__", DIALOG_HISTORY_BATCH_DIALOG_ID] },
      status: "PLANNED",
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
      mode: "dialog_history_batch",
      source: "dialog_history_batch_claim",
      status: "RUNNING",
      generation,
      continuation: {
        kind: "dialog_history_batch",
        claimedByDeviceId: deviceId,
        leaseTokenHash: hashToken(token),
        leaseRevision: 1,
        leaseUntil: expiresAt.toISOString(),
        mode: effectiveDialogMode(first),
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
    const itemMode = effectiveDialogMode(state);
    const updated = await db.dialogScanState.updateMany({
      where: { id: state.id, status: "PLANNED" },
      data: {
        status: "RUNNING",
        scanMode: itemMode,
        activeRunId: run.id,
        activeJobId: null,
        lastError: null,
      },
    });
    if (updated.count === 1) {
      claimed.push({
        dialogId: state.dialogId,
        fanId: state.fanId || state.dialogId,
        mode: itemMode,
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
    mode: claimed[0]?.mode || "initial",
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
    settledCreators,
    batch: {
      id: updatedRun.id,
      creatorId,
      generation,
      mode: claimed[0]?.mode || "initial",
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
    const claimedItems = list(continuation.dialogs)
      .map((item) => object(item))
      .map((item) => ({
        dialogId: clean(item.dialogId, 180),
        mode: clean(item.mode, 40)?.toLowerCase() === "incremental" ? "incremental" : "initial",
      }))
      .filter((item) => item.dialogId);
    const claimedDialogs = claimedItems.map((item) => item.dialogId);
    const claimedModeByDialogId = new Map(claimedItems.map((item) => [item.dialogId, item.mode]));
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
    let unavailable = 0;
    let pages = 0;
    let messages = 0;
    let received = 0;
    let inserted = 0;
    let updated = 0;
    let duplicates = 0;
    let skippedHistory = 0;

    for (const dialogId of claimedDialogs) {
      const result = results.get(dialogId) || {
        dialogId,
        ok: false,
        retryable: true,
        pages: 0,
        messages: 0,
        received: 0,
        inserted: 0,
        updated: 0,
        duplicates: 0,
        skippedHistory: 0,
        localMessageCount: null,
        error: "DIALOG_BATCH_RESULT_MISSING",
      };
      pages += result.pages;
      messages += result.messages;
      received += result.received;
      inserted += result.inserted;
      updated += result.updated;
      duplicates += result.duplicates;
      skippedHistory += result.skippedHistory;
      if (result.ok) {
        completed += 1;
        const itemMode = claimedModeByDialogId.get(dialogId)
          || (String(run.mode).startsWith("incremental") ? "incremental" : "initial");
        await tx.dialogScanState.updateMany({
          where: { agencyId: run.agencyId, creatorId: run.creatorId, dialogId, activeRunId: run.id },
          data: {
            status: "READY",
            ...(itemMode === "initial"
              ? { initialScanComplete: true, lastFullScanAt: now }
              : { lastIncrementalScanAt: now }),
            pagesProcessed: { increment: result.pages },
            // New desktop builds report the authoritative local SQLite count.
            // Keep the increment fallback only for rolling-deploy compatibility
            // with an older client that does not send localMessageCount yet.
            messagesProcessed: result.localMessageCount == null
              ? { increment: result.messages }
              : result.localMessageCount,
            newestMessageId: result.newestMessageId || undefined,
            newestMessageAt: result.newestMessageAt || undefined,
            confirmedWatermarkMessageId: result.newestMessageId || undefined,
            confirmedWatermarkAt: result.newestMessageAt || undefined,
            forwardCursor: itemMode === "incremental" && result.newestMessageId
              ? result.newestMessageId
              : undefined,
            incrementalGapOpen: itemMode === "incremental" ? false : undefined,
            activeRunId: null,
            activeJobId: null,
            lastError: null,
          },
        });
      } else if (result.unavailable === true) {
        unavailable += 1;
        const reason = [result.code || "DIALOG_UNAVAILABLE", result.status ? `HTTP ${result.status}` : null, result.error]
          .filter(Boolean)
          .join(": ")
          .slice(0, 2_000);
        await tx.dialogScanState.updateMany({
          where: { agencyId: run.agencyId, creatorId: run.creatorId, dialogId, activeRunId: run.id },
          data: {
            // Terminal only for this discovery generation. A later discovery
            // can plan the dialog again if the block/geo restriction changes.
            status: "UNAVAILABLE",
            activeRunId: null,
            activeJobId: null,
            lastError: reason || "DIALOG_UNAVAILABLE",
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
      unavailable,
      pages,
      messages,
      received,
      inserted,
      updated,
      duplicates,
      skippedHistory,
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
          skipped: unavailable,
          pages,
          messages,
          received,
          inserted,
          updated,
          duplicates,
          skippedHistory,
          message: `Dialog batch complete · ${completed} completed · ${unavailable} unavailable`,
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

async function reconcileDialogLocalCountsTx(tx, input) {
  const agencyId = clean(input.agencyId, 160);
  const creatorId = clean(input.creatorId, 160);
  const allowed = await assertAllowedCreators(tx, agencyId, [creatorId]);
  if (!creatorId || !allowed.includes(creatorId)) {
    const error = new Error("Creator is unavailable for local dialog reconciliation");
    error.code = "CREATOR_NOT_FOUND";
    error.status = 404;
    throw error;
  }

  const counts = new Map();
  for (const raw of list(input.entries).slice(0, 500)) {
    const entry = object(raw);
    const dialogId = clean(entry.dialogId, 180);
    if (!dialogId) continue;
    counts.set(dialogId, {
      dialogId,
      messages: integer(entry.messages, 0, 0, 100_000_000),
      newestMessageId: clean(entry.newestMessageId, 240),
      newestMessageAt: dateOrNull(entry.newestMessageAt),
      confirmWatermark: entry.confirmWatermark === true,
    });
  }
  const entries = [...counts.values()];
  if (!entries.length) return { ok: true, creatorId, received: 0, updated: 0 };

  const source = clean(input.source, 40) === "runtime_ws" ? "runtime_ws" : "startup_reconcile";
  const params = [agencyId, creatorId, source];
  const values = entries.map((entry, index) => {
    const base = 4 + index * 5;
    params.push(
      entry.dialogId,
      entry.messages,
      entry.newestMessageId,
      entry.newestMessageAt,
      entry.confirmWatermark,
    );
    return `($${base}::text, $${base + 1}::integer, $${base + 2}::text, $${base + 3}::timestamptz, $${base + 4}::boolean)`;
  });
  // Message timestamps have second-level precision in WS payloads, so two
  // consecutive messages can share newest_message_at. Compare their opaque IDs
  // as a tiebreaker and never let an older local database regress a confirmed
  // server watermark. OF message IDs are decimal; the lexical fallback keeps
  // tests and any future opaque identifiers deterministic.
  const markerIdIsGreaterThanConfirmed = `
    CASE
      WHEN local_count.newest_message_id ~ '^[0-9]+$'
       AND state."confirmedWatermarkMessageId" ~ '^[0-9]+$'
        THEN local_count.newest_message_id::numeric > state."confirmedWatermarkMessageId"::numeric
      ELSE local_count.newest_message_id > state."confirmedWatermarkMessageId"
    END
  `;
  const markerIdIsGreaterThanDiscovery = `
    CASE
      WHEN local_count.newest_message_id ~ '^[0-9]+$'
       AND state."newestMessageId" ~ '^[0-9]+$'
        THEN local_count.newest_message_id::numeric > state."newestMessageId"::numeric
      ELSE local_count.newest_message_id > state."newestMessageId"
    END
  `;
  const markerAdvancesConfirmed = `
    local_count.confirm_watermark = TRUE
    AND local_count.newest_message_id IS NOT NULL
    AND (
      state."confirmedWatermarkMessageId" IS NULL
      OR state."confirmedWatermarkMessageId" = local_count.newest_message_id
      OR (
        local_count.newest_message_at IS NOT NULL
        AND (
          state."confirmedWatermarkAt" IS NULL
          OR local_count.newest_message_at > state."confirmedWatermarkAt"
          OR (
            local_count.newest_message_at = state."confirmedWatermarkAt"
            AND (${markerIdIsGreaterThanConfirmed})
          )
        )
      )
      OR (
        local_count.newest_message_at IS NULL
        AND state."confirmedWatermarkAt" IS NULL
        AND (${markerIdIsGreaterThanConfirmed})
      )
    )
  `;

  const updated = await tx.$executeRawUnsafe(
    `
      UPDATE "DialogScanState" AS state
      SET "messagesProcessed" = local_count.messages,
          "confirmedWatermarkMessageId" = CASE
            WHEN (${markerAdvancesConfirmed})
              THEN local_count.newest_message_id
            ELSE state."confirmedWatermarkMessageId"
          END,
          "confirmedWatermarkAt" = CASE
            WHEN (${markerAdvancesConfirmed})
              THEN COALESCE(local_count.newest_message_at, state."confirmedWatermarkAt")
            ELSE state."confirmedWatermarkAt"
          END,
          "lastWsEventAt" = CASE
            WHEN $3::text = 'runtime_ws'
              THEN GREATEST(
                COALESCE(state."lastWsEventAt", '-infinity'::timestamptz),
                COALESCE(local_count.newest_message_at, NOW())
              )
            ELSE state."lastWsEventAt"
          END,
          "updatedAt" = NOW()
      FROM (VALUES ${values.join(", ")})
        AS local_count(dialog_id, messages, newest_message_id, newest_message_at, confirm_watermark)
      WHERE state."agencyId" = $1
        AND state."creatorId" = $2
        AND state."dialogId" = local_count.dialog_id
        AND (
          state."newestMessageId" IS NULL
          OR state."newestMessageId" = local_count.newest_message_id
          OR (
            local_count.newest_message_at IS NOT NULL
            AND (
              state."newestMessageAt" IS NULL
              OR local_count.newest_message_at > state."newestMessageAt"
              OR (
                local_count.newest_message_at = state."newestMessageAt"
                AND (${markerIdIsGreaterThanDiscovery})
              )
            )
          )
        )
    `,
    ...params,
  );

  return {
    ok: true,
    creatorId,
    received: entries.length,
    updated: integer(updated, 0, 0, entries.length),
  };
}

async function reconcileDialogLocalCounts(input) {
  return prisma.$transaction(
    (tx) => reconcileDialogLocalCountsTx(tx, input),
    BATCH_TRANSACTION_OPTIONS,
  );
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
  reconcileDialogLocalCountsTx,
  reconcileDialogLocalCounts,
  releaseDialogHistoryBatchTx,
  releaseDialogHistoryBatch,
  recoverExpiredDialogHistoryBatchesTx,
  normalizeOrphanedDialogHistoryBatchesTx,
  reclaimOwnedDialogHistoryBatchTx,
};

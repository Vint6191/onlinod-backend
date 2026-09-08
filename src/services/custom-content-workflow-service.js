"use strict";

const { allowedCreatorScope, requireCreatorAccess } = require("../middleware/automation-permissions");
const { canUsePermission } = require("./team-access-control");
const { audit } = require("./audit-service");
const { assignCustomContentSubmission } = require("./custom-content-submissions-service");
const { paymentSnapshot } = require("./custom-orders-service");
const { uniqueMediaIds } = require("./custom-content-library-service");
const { ACTIVE_WRITE_STATUSES, hasCurrentVaultSettlement, customAssetMatchesPipelineProjection, setUnassignedSubmissionDisposition, derivePipelineStage, customSubmissionExternalEffectConvergence, lockAgencyPipelineLifecycle, lockCreatorPipelineLifecycle, adjudicateCustomOrderCancellation } = require("./custom-content-pipeline-authority-service");
const { lockAutomationWriteCommitFence } = require("./automation-write-commit-fence-service");
const { deriveCustomRevisionDispatch } = require("./custom-revision-dispatch-authority-service");
const { lockCurrentAgencyMember } = require("./custom-management-access-authority-service");

const REVIEW_WAITING = "WAITING_REVIEW";
const REVIEW_REVISION = "REVISION_REQUESTED";
const REVIEW_APPROVED = "APPROVED";

function fail(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
function boundedLimit(value, fallback = 50, max = 100) { return Math.max(1, Math.min(max, Math.floor(Number(value) || fallback))); }
function identifier(value, field, max = 180) {
  const text = String(value == null ? "" : value).trim();
  if (!text) throw fail(`CUSTOM_WORKFLOW_${field.toUpperCase()}_REQUIRED`, `${field} is required`);
  if (text.length > max) throw fail(`CUSTOM_WORKFLOW_${field.toUpperCase()}_TOO_LONG`, `${field} is too long`);
  return text;
}
function scopeWhere(scope) {
  if (scope?.broad) return {};
  const ids = Array.isArray(scope?.creatorIds) ? scope.creatorIds.map(String).filter(Boolean) : [];
  return { creatorId: { in: ids.length ? ids : ["__none__"] } };
}
async function requireWorkflowView({ agencyId, member, db }) {
  if (!agencyId || !member?.id) throw fail("CUSTOM_WORKFLOW_ACTOR_REQUIRED", "Agency membership is required", 403);
  if (!await canUsePermission({ member, key: "team.analytics.view", db })) throw fail("CUSTOM_WORKFLOW_VIEW_FORBIDDEN", "team.analytics.view permission is required", 403);
}
async function requireWorkflowWrite({ agencyId, member, db }) {
  if (!agencyId || !member?.id) throw fail("CUSTOM_WORKFLOW_ACTOR_REQUIRED", "Agency membership is required", 403);
  if (!await canUsePermission({ member, key: "content.review_customs", db })) throw fail("CUSTOM_WORKFLOW_ASSIGN_FORBIDDEN", "content.review_customs permission is required", 403);
}
async function requireWorkflowCreatorHistoryAccess({ agencyId, member, creatorId, db, scope = null }) {
  const resolvedScope = scope || await allowedCreatorScope({ agencyId, member, db });
  if (!resolvedScope?.broad) return requireCreatorAccess({ agencyId, member, creatorId, db });
  const creator = await db.creatorAccount.findFirst({
    where: { id: creatorId, agencyId },
    select: { id: true, agencyId: true, displayName: true, username: true, status: true, deletedAt: true },
  });
  if (!creator) throw fail("CREATOR_NOT_FOUND", "Creator not found", 404);
  return creator;
}
function timelineCompare(a, b) {
  const ar = new Date(a?.receivedAt || 0).getTime();
  const br = new Date(b?.receivedAt || 0).getTime();
  if (ar !== br) return ar - br;
  const ac = new Date(a?.createdAt || 0).getTime();
  const bc = new Date(b?.createdAt || 0).getTime();
  if (ac !== bc) return ac - bc;
  return String(a?.id || "").localeCompare(String(b?.id || ""));
}
function creatorSummary(creator) {
  return creator ? {
    displayName: creator.displayName || null,
    username: creator.username || null,
    avatarUrl: creator.avatarUrl || null,
  } : null;
}
function reviewActor(member) {
  return member ? { id: String(member.id), name: member.displayName || null, roleKey: member.roleKey || null } : null;
}
function previewAsset(asset, mediaId) {
  return {
    mediaId: String(mediaId),
    mediaType: String(asset?.mediaType || "unknown"),
    thumbUrl: asset?.thumbUrl || null,
    previewUrl: asset?.previewUrl || null,
    fullUrl: asset?.fullUrl || null,
  };
}
async function loadAssets(db, agencyId, rows) {
  const groups = new Map();
  for (const row of rows || []) {
    const creatorId = String(row?.creatorId || "");
    if (!creatorId) continue;
    const ids = groups.get(creatorId) || new Set();
    for (const mediaId of uniqueMediaIds(row?.ofMediaIds)) ids.add(mediaId);
    groups.set(creatorId, ids);
  }
  const queries = [...groups.entries()].filter(([, ids]) => ids.size).map(([creatorId, ids]) => ({ creatorId, mediaId: { in: [...ids] } }));
  const map = new Map();
  for (let offset = 0; offset < queries.length; offset += 50) {
    const or = queries.slice(offset, offset + 50);
    const expected = or.reduce((sum, item) => sum + item.mediaId.in.length, 0);
    const assets = await db.creatorMediaAsset.findMany({
      where: { agencyId, source: "CUSTOM", OR: or },
      select: { creatorId: true, mediaId: true, source: true, customOrderId: true, customSubmissionId: true, customFullPriceCents: true, catalogActive: true, sortingStatus: true, folderIds: true, mediaType: true, thumbUrl: true, previewUrl: true, fullUrl: true },
      take: expected,
    });
    for (const asset of assets || []) map.set(`${asset.creatorId}\n${asset.mediaId}`, asset);
  }
  return map;
}

async function listUnassignedCustomContentSubmissions({ agencyId, member, limit = 50, offset = 0, db = null } = {}) {
  const client = db || require("../prisma");
  await requireWorkflowView({ agencyId, member, db: client });
  const scope = await allowedCreatorScope({ agencyId, member, db: client });
  const take = boundedLimit(limit);
  const skip = Math.max(0, Math.min(2_147_483_647, Math.floor(Number(offset) || 0)));
  const where = { agencyId, customOrderId: null, pipelineDisposition: "ACTIVE", ...scopeWhere(scope) };
  const [rows, count, canAssign] = await Promise.all([
    client.customContentSubmission.findMany({
      where,
      include: { creator: { select: { id: true, displayName: true, username: true, avatarUrl: true } } },
      orderBy: [{ receivedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      skip,
      take,
    }),
    client.customContentSubmission.count({ where }),
    canUsePermission({ member, key: "content.review_customs", db: client }),
  ]);
  const assetMap = await loadAssets(client, agencyId, rows);
  const items = rows.map((row) => {
    const telegramIds = Array.isArray(row.telegramMessageIds) ? row.telegramMessageIds : [];
    const mediaIds = uniqueMediaIds(row.ofMediaIds);
    const media = mediaIds.map((mediaId) => previewAsset(assetMap.get(`${row.creatorId}\n${mediaId}`), mediaId));
    const finalizedMediaCount = mediaIds.filter((mediaId) => {
      const asset = assetMap.get(`${row.creatorId}\n${mediaId}`);
      return customAssetMatchesPipelineProjection(row, asset, null);
    }).length;
    return {
      submissionId: String(row.id),
      creatorId: String(row.creatorId),
      creator: creatorSummary(row.creator),
      comment: row.comment || null,
      receivedAt: new Date(row.receivedAt).toISOString(),
      telegramMessageCount: telegramIds.length,
      ofMediaCount: mediaIds.length,
      finalizedMediaCount,
      uploadComplete: telegramIds.length > 0 && mediaIds.length === telegramIds.length,
      libraryFinalized: mediaIds.length > 0 && hasCurrentVaultSettlement(row) && finalizedMediaCount === mediaIds.length,
      media,
      pipelineDisposition: String(row.pipelineDisposition || "ACTIVE"),
    };
  });
  const total = Number(count || 0);
  return { ok: true, items, count: total, offset: skip, nextOffset: skip + items.length, hasMore: skip + items.length < total, canAssign, serverNow: new Date().toISOString() };
}

async function loadSubmissionForAssignment({ agencyId, member, submissionId, db, write = false }) {
  if (write) await requireWorkflowWrite({ agencyId, member, db });
  else await requireWorkflowView({ agencyId, member, db });
  const id = identifier(submissionId, "submissionId");
  const row = await db.customContentSubmission.findFirst({
    where: { id, agencyId },
    include: { creator: { select: { id: true, displayName: true, username: true, avatarUrl: true } } },
  });
  if (!row) throw fail("CUSTOM_SUBMISSION_NOT_FOUND", "Content submission was not found", 404);
  await requireCreatorAccess({ agencyId, member, creatorId: row.creatorId, db });
  if (String(row.pipelineDisposition || "ACTIVE") !== "ACTIVE") throw fail("CUSTOM_WORKFLOW_SUBMISSION_NOT_ACTIVE", "Submission is no longer active pipeline work", 409);
  if (row.customOrderId) throw fail("CUSTOM_WORKFLOW_SUBMISSION_ALREADY_ASSIGNED", "Submission is already assigned to a custom order", 409);
  if (String(row.reviewStatus || REVIEW_WAITING) !== REVIEW_WAITING) throw fail("CUSTOM_SUBMISSION_REVIEW_LOCKED", "Reviewed submissions cannot be assigned", 409);
  return row;
}

async function loadCandidateSubmissionHistory({ agencyId, creatorId, orderIds, db }) {
  const byOrder = new Map();
  if (!orderIds.length) return byOrder;
  let cursor = null;
  const seenCursors = new Set();
  for (;;) {
    if (cursor && seenCursors.has(cursor)) throw fail("CUSTOM_ASSIGNMENT_HISTORY_CURSOR_LOOP", "Assignment history cursor did not advance", 500);
    if (cursor) seenCursors.add(cursor);
    const rows = await db.customContentSubmission.findMany({
      where: { agencyId, creatorId, customOrderId: { in: orderIds } },
      select: { id: true, customOrderId: true, reviewStatus: true, reviewComment: true, reviewedAt: true, receivedAt: true, createdAt: true },
      orderBy: [{ receivedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      take: 200,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;
    cursor = String(rows[rows.length - 1].id);
    for (const row of rows) {
      const key = String(row.customOrderId || "");
      const list = byOrder.get(key) || [];
      list.push(row);
      byOrder.set(key, list);
    }
    if (rows.length < 200) break;
  }
  return byOrder;
}

async function candidateOrdersForCreator({ agencyId, creatorId, limit, db }) {
  // This is a suggestion read-model, not mutation authority, but it still must
  // be complete enough to make an exact-valid target reachable from the UI.
  // Presentation LIMIT is applied only after eligibility and ranking.
  const result = [];
  let cursor = null;
  const seenCursors = new Set();
  for (;;) {
    if (cursor && seenCursors.has(cursor)) throw fail("CUSTOM_ASSIGNMENT_ORDER_CURSOR_LOOP", "Assignment candidate cursor did not advance", 500);
    if (cursor) seenCursors.add(cursor);
    const orders = await db.customOrder.findMany({
      where: { agencyId, creatorId, type: "CONTENT", status: "PENDING", fanDeliveredAt: null },
      select: { id: true, creatorId: true, dialogId: true, scenario: true, contentKind: true, priceCents: true, paidAmountCents: true, dueAt: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 200,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!orders.length) break;
    cursor = String(orders[orders.length - 1].id);
    const orderIds = orders.map((row) => String(row.id));
    const byOrder = await loadCandidateSubmissionHistory({ agencyId, creatorId, orderIds, db });
    for (const order of orders) {
      const history = (byOrder.get(String(order.id)) || []).sort(timelineCompare);
      if (history.some((row) => String(row.reviewStatus || "") === REVIEW_APPROVED)) continue;
      const latest = history[history.length - 1] || null;
      // Manual assignment is intentionally conservative: attach an unassigned
      // batch only as the first version, or as the next version after an explicit
      // manager revision request. Never create two simultaneous review candidates.
      if (latest && String(latest.reviewStatus || REVIEW_WAITING) !== REVIEW_REVISION) continue;
      const payment = paymentSnapshot(order.priceCents || 0, order.paidAmountCents || 0);
      result.push({
        customOrderId: String(order.id),
        creatorId: String(order.creatorId),
        dialogId: String(order.dialogId),
        scenario: String(order.scenario || ""),
        contentKind: order.contentKind || null,
        totalPriceCents: Math.max(0, Math.round(Number(order.priceCents) || 0)),
        paidAmountCents: payment.paidAmountCents,
        remainingAmountCents: payment.remainingAmountCents,
        paymentStatus: payment.paymentStatus,
        dueAt: order.dueAt ? new Date(order.dueAt).toISOString() : null,
        createdAt: new Date(order.createdAt).toISOString(),
        submissionCount: history.length,
        nextRevisionNumber: history.length + 1,
        awaitingRevision: Boolean(latest && String(latest.reviewStatus) === REVIEW_REVISION),
        lastRevisionComment: latest && String(latest.reviewStatus) === REVIEW_REVISION ? latest.reviewComment || null : null,
        lastRevisionRequestedAt: latest && String(latest.reviewStatus) === REVIEW_REVISION && latest.reviewedAt ? new Date(latest.reviewedAt).toISOString() : null,
      });
    }
    if (orders.length < 200) break;
  }
  result.sort((a, b) => Number(b.awaitingRevision) - Number(a.awaitingRevision) || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return result.slice(0, limit);
}

async function listCustomSubmissionAssignmentCandidates({ agencyId, member, submissionId, limit = 50, db = null } = {}) {
  const client = db || require("../prisma");
  const row = await loadSubmissionForAssignment({ agencyId, member, submissionId, db: client, write: false });
  const take = boundedLimit(limit);
  const [items, canAssign] = await Promise.all([
    candidateOrdersForCreator({ agencyId, creatorId: row.creatorId, limit: take, db: client }),
    canUsePermission({ member, key: "content.review_customs", db: client }),
  ]);
  return { ok: true, submissionId: String(row.id), creatorId: String(row.creatorId), items, count: items.length, canAssign, serverNow: new Date().toISOString() };
}

async function assignUnassignedCustomContentSubmission({ agencyId, member, submissionId, customOrderId, db = null } = {}) {
  const client = db || require("../prisma");
  const row = await loadSubmissionForAssignment({ agencyId, member, submissionId, db: client, write: true });
  const targetId = identifier(customOrderId, "customOrderId");
  // Candidate pages are a UI read model only. The exact assignment mutation
  // re-validates target existence/type/status/current version atomically.
  return assignCustomContentSubmission({ agencyId, member, submissionId: row.id, customOrderId: targetId, db: client });
}

async function listAwaitingCustomRevisions({ agencyId, member, limit = 50, cursor = null, db = null } = {}) {
  const client = db || require("../prisma");
  await requireWorkflowView({ agencyId, member, db: client });
  const scope = await allowedCreatorScope({ agencyId, member, db: client });
  const take = boundedLimit(limit);
  const items = [];
  let scanCursor = String(cursor == null ? "" : cursor).trim().slice(0, 180) || null;
  let pageExhausted = false;
  while (items.length < take) {
    const rows = await client.customContentSubmission.findMany({
      where: {
        agencyId,
        pipelineDisposition: "ACTIVE",
        reviewStatus: REVIEW_REVISION,
        customOrderId: { not: null },
        customOrder: { is: { type: "CONTENT", status: "PENDING", fanDeliveredAt: null } },
        ...scopeWhere(scope),
      },
      include: {
        creator: { select: { id: true, displayName: true, username: true, avatarUrl: true } },
        reviewedByMember: { select: { id: true, displayName: true, roleKey: true } },
        customOrder: { select: { id: true, creatorId: true, dialogId: true, scenario: true, type: true, status: true, fanDeliveredAt: true, priceCents: true, paidAmountCents: true, contentKind: true } },
      },
      orderBy: [{ reviewedAt: "asc" }, { receivedAt: "asc" }, { id: "asc" }],
      take: 200,
      ...(scanCursor ? { cursor: { id: scanCursor }, skip: 1 } : {}),
    });
    if (!rows.length) { pageExhausted = true; break; }
    const revisionIntentBySubmission = new Map();
    if (client.telegramDeliveryIntent?.findMany) {
      const submissionIds = rows.map((row) => String(row.id)).filter(Boolean);
      if (submissionIds.length) {
        const intents = await client.telegramDeliveryIntent.findMany({
          where: { agencyId, kind: "REVISION_REQUEST", customSubmissionId: { in: submissionIds } },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        });
        for (const intent of intents || []) {
          const key = String(intent.customSubmissionId || "");
          if (key && !revisionIntentBySubmission.has(key)) revisionIntentBySubmission.set(key, intent);
        }
      }
    }
    for (const row of rows) {
      scanCursor = String(row.id);
      const order = row.customOrder;
      if (!order || String(order.type || "") !== "CONTENT" || String(order.status || "") !== "PENDING" || order.fanDeliveredAt) continue;
      const latest = await client.customContentSubmission.findFirst({
        where: { agencyId, customOrderId: row.customOrderId },
        select: { id: true, reviewStatus: true, pipelineDisposition: true, receivedAt: true, createdAt: true },
        orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      });
      if (!latest || String(latest.id) !== String(row.id) || String(latest.reviewStatus || "") !== REVIEW_REVISION || String(latest.pipelineDisposition || "ACTIVE") !== "ACTIVE") continue;
      const revisionNumber = await client.customContentSubmission.count({
        where: { agencyId, customOrderId: row.customOrderId, receivedAt: { lte: row.receivedAt } },
      });
      const payment = paymentSnapshot(order.priceCents || 0, order.paidAmountCents || 0);
      items.push({
        submissionId: String(row.id),
        customOrderId: String(order.id),
        creatorId: String(row.creatorId),
        dialogId: String(order.dialogId),
        creator: creatorSummary(row.creator),
        scenario: String(order.scenario || ""),
        contentKind: order.contentKind || null,
        totalPriceCents: Math.max(0, Math.round(Number(order.priceCents) || 0)),
        paidAmountCents: payment.paidAmountCents,
        remainingAmountCents: payment.remainingAmountCents,
        revisionNumber: Math.max(1, Number(revisionNumber || 1)),
        nextRevisionNumber: Math.max(2, Number(revisionNumber || 1) + 1),
        revisionComment: row.reviewComment || null,
        requestedAt: row.reviewedAt ? new Date(row.reviewedAt).toISOString() : null,
        reviewedBy: reviewActor(row.reviewedByMember),
        modelComment: row.comment || null,
        previousMediaCount: uniqueMediaIds(row.ofMediaIds).length,
        revisionDispatch: await deriveCustomRevisionDispatch({
          agencyId, orderId: order.id, submission: row, intent: revisionIntentBySubmission.get(String(row.id)) || null, db: client,
        }),
      });
      if (items.length >= take) break;
    }
    if (items.length >= take) break;
    if (rows.length < 200) { pageExhausted = true; break; }
  }
  const hasMore = items.length >= take && !pageExhausted && Boolean(scanCursor);
  return { ok: true, items, count: items.length, nextCursor: hasMore ? scanCursor : null, hasMore, serverNow: new Date().toISOString() };
}

async function listCustomPipelineResolutionQueue({
  agencyId, member, creatorId = null, limit = 50, offset = 0,
  pendingCustomOffset = 0, activeWriteOffset = 0, db = null,
} = {}) {
  const client = db || require("../prisma");
  await requireWorkflowView({ agencyId, member, db: client });
  const scope = await allowedCreatorScope({ agencyId, member, db: client });
  const focusedCreatorId = creatorId == null || String(creatorId).trim() === "" ? null : identifier(creatorId, "creatorId");
  if (focusedCreatorId) await requireWorkflowCreatorHistoryAccess({ agencyId, member, creatorId: focusedCreatorId, db: client, scope });
  const creatorFilter = focusedCreatorId ? { creatorId: focusedCreatorId } : scopeWhere(scope);
  const take = boundedLimit(limit, 50, 100);
  const pageOffset = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return 0;
    return Math.min(2_147_483_647, Math.floor(numeric));
  };
  const skip = pageOffset(offset);
  const pendingSkip = pageOffset(pendingCustomOffset);
  const writeSkip = pageOffset(activeWriteOffset);
  const where = {
    agencyId,
    ...creatorFilter,
    OR: [
      { pipelineDisposition: "SALVAGE" },
      {
        pipelineDisposition: "ACTIVE",
        pipelineBlockedCode: { not: null },
        customOrderId: { not: null },
        customOrder: { is: { type: "CONTENT", status: "PENDING", fanDeliveredAt: null } },
      },
      { pipelineDisposition: "ACTIVE", customOrderId: null },
    ],
  };
  // Retirement authority blocks every PENDING CustomOrder, not only CONTENT. Keep the
  // operator resolution projection identical to that business invariant so CALL / PHYSICAL
  // historical debt cannot become an invisible permanent blocker.
  const orderBlockerWhere = {
    agencyId,
    ...creatorFilter,
    status: "PENDING",
  };
  const writeBlockerWhere = {
    agencyId,
    ...creatorFilter,
    actionType: { in: ["CUSTOM_RELAY_SEND", "CUSTOM_MANUAL_SEND"] },
    OR: [
      { status: { in: ACTIVE_WRITE_STATUSES } },
      { status: "FAILED", failureCode: "outcome_unresolved_do_not_retry" },
    ],
  };
  const [rows, count, canResolve, orderBlockers, orderBlockerCount, activeWrites, activeWriteCount] = await Promise.all([
    client.customContentSubmission.findMany({
      where,
      include: {
        creator: { select: { id: true, displayName: true, username: true, avatarUrl: true, deletedAt: true } },
        customOrder: { select: { id: true, status: true, scenario: true, type: true, fanDeliveredAt: true, priceCents: true } },
      },
      orderBy: [{ pipelineDispositionChangedAt: "asc" }, { pipelineBlockedAt: "asc" }, { receivedAt: "asc" }, { id: "asc" }],
      take,
      skip,
    }),
    client.customContentSubmission.count({ where }),
    canUsePermission({ member, key: "content.review_customs", db: client }),
    client.customOrder.findMany({
      where: orderBlockerWhere,
      select: {
        id: true, creatorId: true, dialogId: true, scenario: true, type: true, contentKind: true, createdAt: true, dueAt: true,
        creator: { select: { id: true, displayName: true, username: true, avatarUrl: true, deletedAt: true } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take,
      skip: pendingSkip,
    }),
    client.customOrder.count({ where: orderBlockerWhere }),
    client.automationDelivery.findMany({
      where: writeBlockerWhere,
      select: {
        id: true, creatorId: true, actionType: true, targetId: true, status: true, failureCode: true, claimedByDeviceId: true, claimUntil: true, writeCommitAt: true, updatedAt: true,
        creator: { select: { id: true, displayName: true, username: true, avatarUrl: true } },
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take,
      skip: writeSkip,
    }),
    client.automationDelivery.count({ where: writeBlockerWhere }),
  ]);
  const ids = rows.map((row) => String(row.id));
  const assets = ids.length ? await client.creatorMediaAsset.findMany({
    where: { agencyId, source: "CUSTOM", customSubmissionId: { in: ids } },
    select: { creatorId: true, mediaId: true, source: true, customOrderId: true, customSubmissionId: true, customFullPriceCents: true, catalogActive: true, sortingStatus: true, folderIds: true },
    take: rows.reduce((sum, row) => sum + uniqueMediaIds(row.ofMediaIds).length, 0) || 1,
  }) : [];
  const assetsBySubmission = new Map();
  for (const asset of assets) {
    const key = String(asset.customSubmissionId || "");
    const map = assetsBySubmission.get(key) || new Map();
    map.set(String(asset.mediaId), asset);
    assetsBySubmission.set(key, map);
  }
  const items = await Promise.all(rows.map(async (row) => {
    const mediaIds = uniqueMediaIds(row.ofMediaIds);
    const projected = assetsBySubmission.get(String(row.id)) || new Map();
    const finalizedMediaCount = mediaIds.filter((mediaId) => customAssetMatchesPipelineProjection(row, projected.get(String(mediaId)), row.customOrder || null)).length;
    const disposition = String(row.pipelineDisposition || "ACTIVE");
    const finalized = mediaIds.length > 0 && hasCurrentVaultSettlement(row) && finalizedMediaCount === mediaIds.length;
    const pipelineStage = derivePipelineStage({ submission: row, order: row.customOrder || null, finalized, blockedCode: row.pipelineBlockedCode });
    const resolutionAllowed = !row.customOrderId || disposition === "SALVAGE";
    const externalConvergence = await customSubmissionExternalEffectConvergence({ db: client, agencyId, submission: row, order: row.customOrder || null });
    return {
      submissionId: String(row.id),
      creatorId: String(row.creatorId),
      creator: row.creator ? { displayName: row.creator.displayName || null, username: row.creator.username || null, avatarUrl: row.creator.avatarUrl || null } : null,
      creatorRetired: Boolean(row.creator?.deletedAt),
      customOrderId: row.customOrderId == null ? null : String(row.customOrderId),
      customOrder: row.customOrder ? { status: String(row.customOrder.status || ""), scenario: row.customOrder.scenario || null, type: row.customOrder.type || null } : null,
      pipelineDisposition: disposition,
      pipelineStage,
      dispositionReason: row.pipelineDispositionReason || null,
      blockedCode: row.pipelineBlockedCode || null,
      blockedAt: row.pipelineBlockedAt ? new Date(row.pipelineBlockedAt).toISOString() : null,
      nextAttemptAt: row.pipelineNextAttemptAt ? new Date(row.pipelineNextAttemptAt).toISOString() : null,
      receivedAt: new Date(row.receivedAt).toISOString(),
      telegramMessageCount: Array.isArray(row.telegramMessageIds) ? row.telegramMessageIds.length : 0,
      ofMediaCount: mediaIds.length,
      finalizedMediaCount,
      externalEffectsConverged: externalConvergence.converged,
      externalEffectDebt: externalConvergence.debt.map((entry) => ({ deliveryId: entry.deliveryId, actionType: entry.actionType, status: entry.status, state: entry.state })),
      canArchive: Boolean(canResolve && resolutionAllowed && externalConvergence.converged && mediaIds.length > 0
        && hasCurrentVaultSettlement(row)
        && finalizedMediaCount === mediaIds.length),
      canAbandon: Boolean(canResolve && resolutionAllowed && externalConvergence.converged && (mediaIds.length === 0 || Boolean(row.creator?.deletedAt))),
    };
  }));
  const total = Number(count || 0);
  const pendingCustoms = (orderBlockers || []).map((order) => ({
    customOrderId: String(order.id),
    creatorId: String(order.creatorId),
    dialogId: String(order.dialogId),
    creator: creatorSummary(order.creator),
    creatorRetired: Boolean(order.creator?.deletedAt),
    canResolveLegacyRetired: Boolean(canResolve && order.creator?.deletedAt),
    scenario: order.scenario || null,
    type: String(order.type || "CONTENT"),
    contentKind: order.contentKind || null,
    createdAt: new Date(order.createdAt).toISOString(),
    dueAt: order.dueAt ? new Date(order.dueAt).toISOString() : null,
  }));
  return {
    ok: true, items, count: total, offset: skip, nextOffset: skip + items.length, hasMore: skip + items.length < total,
    pendingCustoms,
    pendingCustomCount: Number(orderBlockerCount || 0),
    pendingCustomOffset: pendingSkip,
    pendingCustomNextOffset: pendingSkip + pendingCustoms.length,
    pendingCustomHasMore: pendingSkip + pendingCustoms.length < Number(orderBlockerCount || 0),
    // Compatibility projection for older Desktop builds.
    pendingCustomsTruncated: pendingSkip + pendingCustoms.length < Number(orderBlockerCount || 0),
    activeWrites: (activeWrites || []).map((write) => ({
      writeId: String(write.id), creatorId: String(write.creatorId), actionType: String(write.actionType || ""), targetId: write.targetId == null ? null : String(write.targetId),
      status: String(write.status || ""), failureCode: write.failureCode == null ? null : String(write.failureCode), creator: creatorSummary(write.creator),
      claimedByDeviceId: write.claimedByDeviceId == null ? null : String(write.claimedByDeviceId),
      claimUntil: write.claimUntil ? new Date(write.claimUntil).toISOString() : null,
      writeCommitAt: write.writeCommitAt ? new Date(write.writeCommitAt).toISOString() : null,
      updatedAt: new Date(write.updatedAt).toISOString(),
    })),
    activeWriteCount: Number(activeWriteCount || 0),
    activeWriteOffset: writeSkip,
    activeWriteNextOffset: writeSkip + (activeWrites || []).length,
    activeWriteHasMore: writeSkip + (activeWrites || []).length < Number(activeWriteCount || 0),
    // Compatibility projection for older Desktop builds.
    activeWritesTruncated: writeSkip + (activeWrites || []).length < Number(activeWriteCount || 0),
    focusedCreatorId, canResolve: Boolean(canResolve), serverNow: new Date().toISOString(),
  };
}


async function resolveRetiredCreatorPendingCustomOrder({ agencyId, member, customOrderId, reason = null, now = new Date(), db = null } = {}) {
  const client = db || require("../prisma");
  const id = identifier(customOrderId, "customOrderId");
  const justification = String(reason == null ? "" : reason).trim().slice(0, 300);
  if (!justification) throw fail("CUSTOM_RETIRED_ORDER_RESOLUTION_REASON_REQUIRED", "An explicit legacy retirement resolution reason is required", 400);
  if (typeof client?.$transaction !== "function") throw fail("CUSTOM_RETIRED_ORDER_RESOLUTION_TRANSACTION_REQUIRED", "Legacy Custom resolution requires transactional audit authority", 500);

  return client.$transaction(async (tx) => {
    const currentMember = await lockCurrentAgencyMember({ agencyId, actorMember: member, db: tx });
    await requireWorkflowWrite({ agencyId, member: currentMember, db: tx });
    const scope = await allowedCreatorScope({ agencyId, member: currentMember, db: tx });
    if (!scope?.broad) throw fail("CUSTOM_RETIRED_ORDER_RESOLUTION_BROAD_SCOPE_REQUIRED", "Only broad-scope managers can resolve historical Customs for a retired creator", 403);

    const initial = await tx.customOrder.findFirst({
      where: { id, agencyId },
      select: { id: true, creatorId: true, status: true, type: true, dialogId: true, telegramTaskMessageId: true },
    });
    if (!initial) throw fail("CUSTOM_ORDER_NOT_FOUND", "Custom order was not found", 404);

    // Global lifecycle lock order is Agency -> Creator. allowDeleted is intentional here:
    // this is the one audited compatibility workflow whose purpose is to adjudicate debt
    // left behind by versions that retired CreatorAccount before resolving its Customs.
    await lockAgencyPipelineLifecycle({ db: tx, agencyId });
    const creator = await lockCreatorPipelineLifecycle({ db: tx, agencyId, creatorId: initial.creatorId, allowDeleted: true });
    if (!creator.deletedAt) throw fail("CUSTOM_RETIRED_ORDER_CREATOR_ACTIVE", "This compatibility resolution is only valid for an already-retired creator", 409);
    await lockAutomationWriteCommitFence({ db: tx, agencyId });

    const current = await tx.customOrder.findFirst({
      where: { id, agencyId, creatorId: initial.creatorId },
      select: { id: true, creatorId: true, status: true, type: true, dialogId: true, telegramTaskMessageId: true, deliveredAt: true, updatedAt: true },
    });
    if (!current) throw fail("CUSTOM_ORDER_NOT_FOUND", "Custom order was not found", 404);
    if (String(current.status) !== "PENDING") throw fail("CUSTOM_RETIRED_ORDER_NOT_PENDING", "Only a historical PENDING Custom can be terminalized by this compatibility workflow", 409);

    const unresolvedManualDelivery = tx.automationDelivery?.findFirst ? await tx.automationDelivery.findFirst({
      where: {
        agencyId, creatorId: current.creatorId, actionType: "CUSTOM_MANUAL_SEND", targetId: current.id,
        OR: [
          { status: { in: ["COMMITTING", "RECONCILE_REQUIRED"] } },
          { status: "FAILED", failureCode: "outcome_unresolved_do_not_retry" },
        ],
      },
      select: { id: true, status: true, failureCode: true },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    }) : null;
    if (unresolvedManualDelivery) {
      throw fail(
        "CUSTOM_RETIRED_ORDER_MANUAL_DELIVERY_OUTCOME_UNRESOLVED",
        "Resolve the historical physical Custom delivery outcome before terminalizing this retired-creator Custom",
        409,
      );
    }

    const telegramRows = tx.telegramDeliveryIntent?.findMany ? await tx.telegramDeliveryIntent.findMany({
      where: { agencyId, creatorId: current.creatorId, customOrderId: current.id },
      select: { id: true, kind: true, state: true, commitStartedAt: true, remoteMessageId: true, remoteSentAt: true, confirmedAt: true },
    }) : [];
    const unknownTelegram = (telegramRows || []).filter((row) => ["COMMITTING", "RECONCILE_REQUIRED"].includes(String(row.state)));
    const unknownTask = unknownTelegram.find((row) => String(row.kind) === "TASK");
    if (unknownTask) {
      throw fail(
        "CUSTOM_RETIRED_ORDER_TASK_OUTCOME_UNRESOLVED",
        "Resolve the historical Telegram TASK outcome before terminalizing this retired-creator Custom",
        409,
      );
    }
    const unknownRevision = unknownTelegram.find((row) => String(row.kind) === "REVISION_REQUEST");
    if (unknownRevision) {
      throw fail(
        "CUSTOM_RETIRED_ORDER_REVISION_OUTCOME_UNRESOLVED",
        "Resolve the historical Telegram revision-instruction outcome before terminalizing this retired-creator Custom",
        409,
      );
    }

    // Proven-precommit provider work has no external outcome. It cannot execute after legacy
    // creator retirement and is terminalized here. Unknown/confirmed outcomes are preserved.
    const cancelledPrecommit = tx.telegramDeliveryIntent?.updateMany ? await tx.telegramDeliveryIntent.updateMany({
      where: {
        agencyId, creatorId: current.creatorId, customOrderId: current.id,
        state: { in: ["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"] },
        commitStartedAt: null,
      },
      data: {
        state: "CANCELLED", deviceId: null, userId: null, memberId: null, accessEpoch: null,
        claimTokenHash: null, claimUntil: null, claimRevision: { increment: 1 },
        outcomeReason: "LEGACY_CREATOR_RETIRED_PRECOMMIT",
      },
    }) : { count: 0 };

    const confirmedTask = (telegramRows || []).find((row) => String(row.kind) === "TASK" && String(row.state) === "CONFIRMED");
    let confirmedTaskMessageId = null;
    let confirmedTaskEffectAt = null;
    if (confirmedTask) {
      confirmedTaskMessageId = Number(confirmedTask.remoteMessageId);
      if (!Number.isSafeInteger(confirmedTaskMessageId) || confirmedTaskMessageId <= 0) {
        throw fail("CUSTOM_RETIRED_ORDER_TASK_RECEIPT_INVALID", "Confirmed historical Telegram TASK is missing a valid provider message id", 409);
      }
      if (current.telegramTaskMessageId != null && Number(current.telegramTaskMessageId) !== confirmedTaskMessageId) {
        throw fail("CUSTOM_RETIRED_ORDER_TASK_PROJECTION_CONFLICT", "Custom order is linked to a different Telegram TASK provider message", 409);
      }
      const effectCandidate = confirmedTask.remoteSentAt || confirmedTask.confirmedAt || now;
      const parsedEffect = new Date(effectCandidate);
      confirmedTaskEffectAt = Number.isFinite(parsedEffect.getTime()) ? parsedEffect : now;
    }
    const confirmedRevision = (telegramRows || []).find((row) => String(row.kind) === "REVISION_REQUEST" && String(row.state) === "CONFIRMED");
    if (confirmedRevision) {
      const revisionMessageId = Number(confirmedRevision.remoteMessageId);
      if (!Number.isSafeInteger(revisionMessageId) || revisionMessageId <= 0) {
        throw fail("CUSTOM_RETIRED_ORDER_REVISION_RECEIPT_INVALID", "Confirmed historical Telegram revision instruction is missing a valid provider message id", 409);
      }
    }
    const cancellationOutcome = (telegramRows || []).find((row) => String(row.kind) === "CANCELLATION" && ["COMMITTING", "RECONCILE_REQUIRED", "CONFIRMED"].includes(String(row.state)));
    const confirmedModelInstruction = confirmedRevision || confirmedTask || null;
    const waiveCancellation = Boolean(confirmedModelInstruction && !cancellationOutcome);

    const changed = await tx.customOrder.updateMany({
      where: { id: current.id, agencyId, creatorId: current.creatorId, status: "PENDING", updatedAt: current.updatedAt },
      data: {
        status: "CANCELLED", cancelledAt: now, cancelReason: justification,
        ...(confirmedTaskMessageId != null ? { telegramTaskMessageId: confirmedTaskMessageId } : {}),
        ...(confirmedTaskEffectAt && !current.deliveredAt ? { deliveredAt: confirmedTaskEffectAt } : {}),
        nextReminderAt: null, reminderClaimToken: null, reminderClaimUntil: null, reminderClaimedByDeviceId: null,
        reminderLeaseUserId: null, reminderLeaseMemberId: null, reminderLeaseAccessEpoch: null,
        ...(waiveCancellation ? { telegramCancellationWaivedAt: now, telegramCancellationWaiverReason: justification } : {}),
      },
    });
    if (Number(changed?.count || 0) !== 1) throw fail("CUSTOM_RETIRED_ORDER_RESOLUTION_CONFLICT", "Custom order changed while legacy retirement resolution was committing", 409);

    const content = String(current.type || "CONTENT") === "CONTENT"
      ? await adjudicateCustomOrderCancellation({ db: tx, agencyId, customOrderId: current.id, now, reason: "LEGACY_CREATOR_RETIRED_CUSTOM_CANCELLED" })
      : { changed: 0, cancelledPrecommitWrites: 0, disposition: null };

    await audit({
      agencyId, actorUserId: member?.userId || null, action: "custom_order.legacy_retired_creator_resolve",
      targetType: "CustomOrder", targetId: current.id, required: true, db: tx,
      metadata: {
        creatorId: current.creatorId, type: current.type, reason: justification,
        telegramPrecommitCancelled: Number(cancelledPrecommit?.count || 0),
        telegramUnknownOutcomeCount: unknownTelegram.length, telegramCancellationWaived: waiveCancellation,
        contentSubmissionsAdjudicated: Number(content?.changed || 0),
        relayPrecommitCancelled: Number(content?.cancelledPrecommitWrites || 0),
      },
    });

    return {
      ok: true, customOrderId: current.id, status: "CANCELLED", creatorId: current.creatorId,
      telegramCancellationWaived: waiveCancellation, telegramUnknownOutcomeCount: unknownTelegram.length,
      telegramPrecommitCancelled: Number(cancelledPrecommit?.count || 0),
    };
  }, { isolationLevel: "Serializable", timeout: 35_000 });
}

async function resolveUnassignedCustomContentSubmission({ agencyId, member, submissionId, disposition, reason = null, now = new Date(), db = null } = {}) {
  const client = db || require("../prisma");
  const id = identifier(submissionId, "submissionId");
  const justification = String(reason == null ? "" : reason).trim().slice(0, 300);
  if (!justification) throw fail("CUSTOM_SUBMISSION_DISPOSITION_REASON_REQUIRED", "An explicit resolution reason is required", 400);
  if (typeof client?.$transaction !== "function") throw fail("CUSTOM_SUBMISSION_DISPOSITION_TRANSACTION_REQUIRED", "Pipeline resolution requires transactional audit authority", 500);

  return client.$transaction(async (tx) => {
    // Human terminal resolution is destructive control-plane authority: re-check the canonical
    // membership row and permission/scope in the commit transaction before mutating the pipeline.
    const currentMember = await lockCurrentAgencyMember({ agencyId, actorMember: member, db: tx });
    await requireWorkflowWrite({ agencyId, member: currentMember, db: tx });
    const row = await tx.customContentSubmission.findFirst({
      where: { id, agencyId },
      select: { id: true, creatorId: true, customOrderId: true, pipelineDisposition: true, ofMediaIds: true },
    });
    if (!row) throw fail("CUSTOM_SUBMISSION_NOT_FOUND", "Content submission was not found", 404);
    const scope = await allowedCreatorScope({ agencyId, member: currentMember, db: tx });
    const historicalCreator = await requireWorkflowCreatorHistoryAccess({ agencyId, member: currentMember, creatorId: row.creatorId, db: tx, scope });
    const retiredCreatorResolution = Boolean(scope?.broad && historicalCreator?.deletedAt);
    const result = await setUnassignedSubmissionDisposition({
      db: tx, agencyId, submissionId: row.id, nextDisposition: disposition, reason: justification, now,
      allowRetiredConfirmedAbandon: retiredCreatorResolution,
    });
    await audit({
      agencyId, actorUserId: member?.userId || null, action: "custom_content_submission.pipeline_disposition_resolve",
      targetType: "CustomContentSubmission", targetId: row.id, required: true, db: tx,
      metadata: {
        creatorId: row.creatorId, customOrderId: row.customOrderId || null,
        fromDisposition: String(row.pipelineDisposition || "ACTIVE"), toDisposition: result.pipelineDisposition,
        confirmedMediaCount: uniqueMediaIds(row.ofMediaIds).length, retiredCreatorResolution, reason: justification,
      },
    });
    return result;
  }, { timeout: 35_000 });
}

module.exports = {
  assignUnassignedCustomContentSubmission,
  listAwaitingCustomRevisions,
  listCustomSubmissionAssignmentCandidates,
  listCustomPipelineResolutionQueue,
  listUnassignedCustomContentSubmissions,
  resolveUnassignedCustomContentSubmission,
  resolveRetiredCreatorPendingCustomOrder,
};

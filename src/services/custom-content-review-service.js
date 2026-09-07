"use strict";

const { audit } = require("./audit-service");
const { allowedCreatorScope } = require("../middleware/automation-permissions");
const { canUsePermission } = require("./team-access-control");
const { isCompleteSubmission, uniqueMediaIds } = require("./custom-content-library-service");
const { paymentSnapshot } = require("./custom-orders-service");
const { hasCurrentVaultSettlement, customAssetMatchesPipelineProjection, derivePipelineStage } = require("./custom-content-pipeline-authority-service");

const REVIEW_WAITING = "WAITING_REVIEW";
const REVIEW_REVISION = "REVISION_REQUESTED";
const REVIEW_APPROVED = "APPROVED";
const REVIEW_STATUSES = new Set([REVIEW_WAITING, REVIEW_REVISION, REVIEW_APPROVED]);
const MAX_REVIEW_COMMENT = 4_000;

function fail(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
function clean(value, max = 12_000) { return String(value == null ? "" : value).trim().slice(0, max); }
function normalizeStatus(value, fallback = REVIEW_WAITING) {
  const status = String(value || fallback).trim().toUpperCase();
  if (!REVIEW_STATUSES.has(status)) throw fail("CUSTOM_REVIEW_STATUS_INVALID", "Invalid custom review status");
  return status;
}
function normalizeAction(value) {
  const action = String(value || "").trim().toUpperCase();
  if (action !== "APPROVE" && action !== "REQUEST_REVISION") throw fail("CUSTOM_REVIEW_ACTION_INVALID", "Review action must be APPROVE or REQUEST_REVISION");
  return action;
}
function reviewComment(value, required) {
  const text = String(value == null ? "" : value).trim();
  if (required && !text) throw fail("CUSTOM_REVIEW_COMMENT_REQUIRED", "Revision comment is required");
  if (text.length > MAX_REVIEW_COMMENT) throw fail("CUSTOM_REVIEW_COMMENT_TOO_LONG", `Revision comment is too long (max ${MAX_REVIEW_COMMENT} characters)`);
  return text || null;
}
function scopeWhere(scope) {
  if (scope?.broad) return {};
  const ids = Array.isArray(scope?.creatorIds) ? scope.creatorIds.map(String).filter(Boolean) : [];
  return { creatorId: { in: ids.length ? ids : ["__none__"] } };
}
async function requireReviewView({ agencyId, member, db }) {
  if (!agencyId || !member?.id) throw fail("CUSTOM_REVIEW_ACTOR_REQUIRED", "Agency membership is required", 403);
  if (!await canUsePermission({ member, key: "team.analytics.view", db })) throw fail("CUSTOM_REVIEW_VIEW_FORBIDDEN", "team.analytics.view permission is required", 403);
}
async function requireReviewWrite({ agencyId, member, db }) {
  if (!agencyId || !member?.id) throw fail("CUSTOM_REVIEW_ACTOR_REQUIRED", "Agency membership is required", 403);
  if (!await canUsePermission({ member, key: "content.review_customs", db })) throw fail("CUSTOM_REVIEW_FORBIDDEN", "content.review_customs permission is required", 403);
}

function compareSubmissionTimeline(a, b) {
  const ar = new Date(a?.receivedAt || 0).getTime();
  const br = new Date(b?.receivedAt || 0).getTime();
  if (ar !== br) return ar - br;
  const ac = new Date(a?.createdAt || 0).getTime();
  const bc = new Date(b?.createdAt || 0).getTime();
  if (ac !== bc) return ac - bc;
  return String(a?.id || "").localeCompare(String(b?.id || ""));
}

async function loadRevisionContext(db, agencyId, rows) {
  const orderIds = Array.from(new Set((rows || []).map((row) => String(row?.customOrderId || "")).filter(Boolean)));
  const result = new Map();
  if (!orderIds.length) return result;
  // Revision history is correctness context, not a preview list. A fixed
  // `orderIds * N` horizon can silently drop old versions of one busy Custom and
  // make revisionNumber / previousRevisionRequest depend on backlog shape.
  // Exhaust the exact order-id set with a stable unique cursor instead.
  const history = [];
  let historyCursor = null;
  for (;;) {
    const page = await db.customContentSubmission.findMany({
      where: { agencyId, customOrderId: { in: orderIds } },
      select: {
        id: true, customOrderId: true, reviewStatus: true, reviewComment: true, reviewedAt: true,
        receivedAt: true, createdAt: true, reviewedByMemberId: true,
        reviewedByMember: { select: { id: true, displayName: true, roleKey: true } },
      },
      orderBy: [{ receivedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      take: 200,
      ...(historyCursor ? { cursor: { id: historyCursor }, skip: 1 } : {}),
    });
    if (!page.length) break;
    history.push(...page);
    historyCursor = String(page[page.length - 1].id || "");
    if (!historyCursor || page.length < 200) break;
  }
  const byOrder = new Map();
  for (const item of history || []) {
    const key = String(item.customOrderId || "");
    if (!key) continue;
    const list = byOrder.get(key) || [];
    list.push(item);
    byOrder.set(key, list);
  }
  for (const list of byOrder.values()) list.sort(compareSubmissionTimeline);
  for (const row of rows || []) {
    const list = byOrder.get(String(row.customOrderId || "")) || [row];
    let index = list.findIndex((item) => String(item.id) === String(row.id));
    if (index < 0) {
      const augmented = [...list, row].sort(compareSubmissionTimeline);
      index = augmented.findIndex((item) => String(item.id) === String(row.id));
      list.splice(0, list.length, ...augmented);
    }
    let previous = null;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const candidate = list[cursor];
      if (String(candidate?.reviewStatus || "") !== REVIEW_REVISION) continue;
      previous = {
        submissionId: String(candidate.id),
        comment: candidate.reviewComment || null,
        requestedAt: candidate.reviewedAt ? new Date(candidate.reviewedAt).toISOString() : null,
        reviewedBy: candidate.reviewedByMember ? {
          id: String(candidate.reviewedByMember.id),
          name: candidate.reviewedByMember.displayName || null,
          roleKey: candidate.reviewedByMember.roleKey || null,
        } : null,
      };
      break;
    }
    result.set(String(row.id), { revisionNumber: Math.max(1, index + 1), previousRevisionRequest: previous });
  }
  return result;
}

function finalizedAssetMap(assets) {
  const map = new Map();
  for (const asset of assets || []) map.set(`${asset.creatorId}\n${asset.mediaId}`, asset);
  return map;
}
function isFinalizedForReview(row, assetByKey) {
  if (!row?.customOrder || !isCompleteSubmission(row)) return false;
  if (!hasCurrentVaultSettlement(row)) return false;
  const mediaIds = uniqueMediaIds(row.ofMediaIds);
  if (!mediaIds.length) return false;
  const expectedPrice = Math.max(0, Math.round(Number(row.customOrder.priceCents) || 0));
  return mediaIds.every((mediaId) => {
    const asset = assetByKey.get(`${row.creatorId}\n${mediaId}`);
    return asset
      && Number(asset.customFullPriceCents) === expectedPrice
      && customAssetMatchesPipelineProjection(row, asset, row.customOrder);
  });
}
function serializeReviewItem(row, assetByKey, revisionContext = null) {
  const order = row.customOrder;
  const creator = order?.creator || row.creator || null;
  const mediaIds = uniqueMediaIds(row.ofMediaIds);
  const payment = paymentSnapshot(order?.priceCents || 0, order?.paidAmountCents || 0);
  const media = mediaIds.map((mediaId) => {
    const asset = assetByKey.get(`${row.creatorId}\n${mediaId}`) || {};
    return {
      mediaId,
      mediaType: String(asset.mediaType || "unknown"),
      thumbUrl: asset.thumbUrl || null,
      previewUrl: asset.previewUrl || null,
      fullUrl: asset.fullUrl || null,
    };
  });
  return {
    submissionId: String(row.id),
    customOrderId: String(order.id),
    creatorId: String(row.creatorId),
    dialogId: String(order.dialogId),
    creator: creator ? { displayName: creator.displayName || null, username: creator.username || null, avatarUrl: creator.avatarUrl || null } : null,
    scenario: String(order.scenario || ""),
    internalNote: order.internalNote || null,
    contentKind: order.contentKind || null,
    totalPriceCents: Math.max(0, Math.round(Number(order?.priceCents) || 0)),
    paidAmountCents: payment.paidAmountCents,
    remainingAmountCents: payment.remainingAmountCents,
    paymentStatus: payment.paymentStatus,
    modelComment: row.comment || null,
    reviewStatus: normalizeStatus(row.reviewStatus),
    reviewComment: row.reviewComment || null,
    reviewedAt: row.reviewedAt ? new Date(row.reviewedAt).toISOString() : null,
    reviewedBy: row.reviewedByMember ? { id: String(row.reviewedByMember.id), name: row.reviewedByMember.displayName || null, roleKey: row.reviewedByMember.roleKey || null } : null,
    receivedAt: new Date(row.receivedAt).toISOString(),
    revisionNumber: Math.max(1, Math.round(Number(revisionContext?.revisionNumber) || 1)),
    previousRevisionRequest: revisionContext?.previousRevisionRequest || null,
    media,
  };
}

const REVIEW_INCLUDE = {
  creator: { select: { id: true, displayName: true, username: true, avatarUrl: true } },
  reviewedByMember: { select: { id: true, displayName: true, roleKey: true } },
  customOrder: {
    select: {
      id: true, creatorId: true, dialogId: true, scenario: true, internalNote: true, type: true, contentKind: true,
      status: true, fanDeliveredAt: true, priceCents: true, paidAmountCents: true, createdAt: true,
      creator: { select: { id: true, displayName: true, username: true, avatarUrl: true } },
    },
  },
};

async function loadAssets(db, agencyId, rows) {
  const byCreator = new Map();
  for (const row of rows) {
    for (const mediaId of uniqueMediaIds(row.ofMediaIds)) {
      const creatorId = String(row.creatorId || "");
      if (!creatorId) continue;
      const ids = byCreator.get(creatorId) || new Set(); ids.add(mediaId); byCreator.set(creatorId, ids);
    }
  }
  const groups = [...byCreator.entries()]
    .filter(([, ids]) => ids.size)
    .map(([creatorId, ids]) => ({ creatorId, mediaId: { in: [...ids] } }));
  const assets = [];
  // Keep queue reads bounded at agency scale. Do not turn a 200-row review page
  // into one CreatorMediaAsset query per creator. Prisma OR chunks keep SQL size
  // reasonable while making DB round-trips independent of creator count.
  for (let offset = 0; offset < groups.length; offset += 50) {
    const or = groups.slice(offset, offset + 50);
    const expectedRows = or.reduce((sum, group) => sum + group.mediaId.in.length, 0);
    const found = await db.creatorMediaAsset.findMany({
      where: { agencyId, source: "CUSTOM", OR: or },
      select: { creatorId: true, mediaId: true, source: true, customOrderId: true, customSubmissionId: true, customFullPriceCents: true, catalogActive: true, sortingStatus: true, folderIds: true, mediaType: true, thumbUrl: true, previewUrl: true, fullUrl: true },
      take: expectedRows,
    });
    assets.push(...found);
  }
  return finalizedAssetMap(assets);
}

async function listCustomContentReviewQueue({ agencyId, member, status = REVIEW_WAITING, limit = 50, cursor = null, db = null } = {}) {
  const client = db || require("../prisma");
  await requireReviewView({ agencyId, member, db: client });
  const normalizedStatus = normalizeStatus(status);
  const take = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
  const scope = await allowedCreatorScope({ agencyId, member, db: client });
  const canReview = await canUsePermission({ member, key: "content.review_customs", db: client });
  const items = [];
  let scanCursor = clean(cursor, 180) || null;
  let pageExhausted = false;
  while (items.length < take) {
    const rows = await client.customContentSubmission.findMany({
      where: {
        agencyId,
        pipelineDisposition: "ACTIVE",
        reviewStatus: normalizedStatus,
        customOrderId: { not: null },
        customOrder: { is: { type: "CONTENT", status: "PENDING", fanDeliveredAt: null } },
        ...scopeWhere(scope),
      },
      include: REVIEW_INCLUDE,
      orderBy: [{ receivedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      take: 200,
      ...(scanCursor ? { cursor: { id: scanCursor }, skip: 1 } : {}),
    });
    if (!rows.length) { pageExhausted = true; break; }
    const validRows = rows.filter((row) => String(row.customOrder?.type || "") === "CONTENT" && String(row.customOrder?.status || "") === "PENDING" && !row.customOrder?.fanDeliveredAt && String(row.pipelineDisposition || "ACTIVE") === "ACTIVE" && isCompleteSubmission(row));
    const validIds = new Set(validRows.map((row) => String(row.id)));
    const assetByKey = await loadAssets(client, agencyId, validRows);
    const orderIds = Array.from(new Set(validRows.map((row) => String(row.customOrderId || "")).filter(Boolean)));
    const approvedRows = normalizedStatus === REVIEW_WAITING && orderIds.length
      ? await client.customContentSubmission.findMany({ where: { agencyId, customOrderId: { in: orderIds }, reviewStatus: REVIEW_APPROVED }, select: { customOrderId: true }, take: orderIds.length })
      : [];
    const approvedOrders = new Set(approvedRows.map((row) => String(row.customOrderId)));
    const revisionContext = await loadRevisionContext(client, agencyId, validRows);
    for (const row of rows) {
      scanCursor = String(row.id);
      if (!validIds.has(scanCursor)) continue;
      if (approvedOrders.has(String(row.customOrderId))) continue;
      const finalized = isFinalizedForReview(row, assetByKey);
      const stage = derivePipelineStage({ submission: row, order: row.customOrder, finalized, blockedCode: row.pipelineBlockedCode });
      const expectedStage = normalizedStatus === REVIEW_APPROVED ? "APPROVED_DELIVERY_READY" : normalizedStatus === REVIEW_REVISION ? "REVISION_WAITING" : "REVIEW_READY";
      if (stage !== expectedStage) continue;
      items.push(serializeReviewItem(row, assetByKey, revisionContext.get(scanCursor)));
      if (items.length >= take) break;
    }
    if (items.length >= take) break;
    if (rows.length < 200) { pageExhausted = true; break; }
  }
  const hasMore = items.length >= take && !pageExhausted && Boolean(scanCursor);
  return { ok: true, items, count: items.length, nextCursor: hasMore ? scanCursor : null, hasMore, canReview, serverNow: new Date().toISOString() };
}

async function loadReviewableSubmission({ agencyId, submissionId, db }) {
  const id = clean(submissionId, 180);
  if (!id) throw fail("CUSTOM_REVIEW_SUBMISSION_REQUIRED", "submissionId is required");
  const row = await db.customContentSubmission.findFirst({ where: { id, agencyId }, include: REVIEW_INCLUDE });
  if (!row) throw fail("CUSTOM_SUBMISSION_NOT_FOUND", "Content submission was not found", 404);
  if (!row.customOrderId || !row.customOrder || String(row.customOrder.type || "") !== "CONTENT") throw fail("CUSTOM_REVIEW_ORDER_REQUIRED", "Submission must be assigned to a CONTENT custom order", 409);
  const assetByKey = await loadAssets(db, agencyId, [row]);
  const finalized = isFinalizedForReview(row, assetByKey);
  const stage = derivePipelineStage({ submission: row, order: row.customOrder, finalized, blockedCode: row.pipelineBlockedCode });
  if (stage === "TERMINAL" || stage === "SALVAGE_READY") {
    throw fail("CUSTOM_REVIEW_ORDER_TERMINAL", "Cancelled, completed, delivered, or salvaged Custom content cannot receive a new review decision", 409);
  }
  if (!["REVIEW_READY", "REVISION_WAITING", "APPROVED_DELIVERY_READY"].includes(stage)) {
    throw fail("CUSTOM_REVIEW_NOT_READY", "Submission must finish source relay and pinned Vault/Content Library finalization before review", 409);
  }
  return { row, assetByKey };
}

async function reviewCustomContentSubmission({ agencyId, member, submissionId, action, comment, now = new Date(), db = null } = {}) {
  const client = db || require("../prisma");
  await requireReviewWrite({ agencyId, member, db: client });
  const normalizedAction = normalizeAction(action);
  const normalizedComment = reviewComment(comment, normalizedAction === "REQUEST_REVISION");
  const normalizedSubmissionId = clean(submissionId, 180);
  if (!normalizedSubmissionId) throw fail("CUSTOM_REVIEW_SUBMISSION_REQUIRED", "submissionId is required");

  // Resolve the business lock target before opening the commit transaction. This
  // read is not authority; loadReviewableSubmission() is called again after the
  // CustomOrder lock and remains the commit-time source of truth.
  const target = await client.customContentSubmission.findFirst({
    where: { id: normalizedSubmissionId, agencyId },
    select: { id: true, customOrderId: true },
  });
  if (!target) throw fail("CUSTOM_SUBMISSION_NOT_FOUND", "Content submission was not found", 404);
  if (!target.customOrderId) throw fail("CUSTOM_REVIEW_ORDER_REQUIRED", "Submission must be assigned to a CONTENT custom order", 409);

  const applyReview = async (tx) => {
    // Cancellation mutates this same CustomOrder row in its transaction. Taking
    // FOR UPDATE first creates one linear commit boundary:
    //   review-lock -> review commit -> cancellation
    // or
    //   cancellation commit -> review-lock -> terminal recheck/reject.
    // Therefore an APPROVE can never commit *after* an already-committed CANCEL.
    if (typeof tx.$queryRawUnsafe === "function") {
      await tx.$queryRawUnsafe(
        `SELECT "id" FROM "CustomOrder" WHERE "id" = $1 AND "agencyId" = $2 FOR UPDATE`,
        String(target.customOrderId),
        String(agencyId),
      );
    }

    const { row, assetByKey } = await loadReviewableSubmission({ agencyId, submissionId: normalizedSubmissionId, db: tx });
    const currentStatus = normalizeStatus(row.reviewStatus);

    if (currentStatus === REVIEW_APPROVED) {
      if (normalizedAction === "APPROVE") {
        const revisionContext = await loadRevisionContext(tx, agencyId, [row]);
        return { idempotent: true, row, assetByKey, item: serializeReviewItem(row, assetByKey, revisionContext.get(String(row.id))) };
      }
      throw fail("CUSTOM_REVIEW_APPROVAL_FINAL", "Approved custom content is final; reopen must be an explicit separate workflow", 409);
    }
    if (currentStatus === REVIEW_REVISION) {
      if (normalizedAction === "REQUEST_REVISION" && (row.reviewComment || null) === normalizedComment) {
        const revisionContext = await loadRevisionContext(tx, agencyId, [row]);
        return { idempotent: true, row, assetByKey, item: serializeReviewItem(row, assetByKey, revisionContext.get(String(row.id))) };
      }
      throw fail("CUSTOM_REVIEW_ALREADY_DECIDED", "This submission already has a review decision", 409);
    }

    const nextStatus = normalizedAction === "APPROVE" ? REVIEW_APPROVED : REVIEW_REVISION;
    if (nextStatus === REVIEW_APPROVED) {
      const existing = await tx.customContentSubmission.findFirst({
        where: { agencyId, customOrderId: row.customOrderId, reviewStatus: REVIEW_APPROVED, id: { not: row.id } }, select: { id: true },
      });
      if (existing) throw fail("CUSTOM_REVIEW_ALREADY_APPROVED", "Another submission is already approved for this custom order", 409);
    }

    let changed;
    try {
      changed = await tx.customContentSubmission.updateMany({
        where: {
          id: row.id,
          agencyId,
          pipelineDisposition: "ACTIVE",
          reviewStatus: REVIEW_WAITING,
          customOrderId: row.customOrderId,
          updatedAt: row.updatedAt,
        },
        data: { reviewStatus: nextStatus, reviewComment: nextStatus === REVIEW_REVISION ? normalizedComment : null, reviewedByMemberId: member.id, reviewedAt: new Date(now) },
      });
    } catch (error) {
      if (nextStatus === REVIEW_APPROVED && error?.code === "P2002") throw fail("CUSTOM_REVIEW_ALREADY_APPROVED", "Another submission is already approved for this custom order", 409);
      throw error;
    }
    if (Number(changed?.count || 0) !== 1) throw fail("CUSTOM_REVIEW_CONFLICT", "Submission changed while it was being reviewed; refresh and try again", 409);
    const updated = await tx.customContentSubmission.findFirst({ where: { id: row.id, agencyId }, include: REVIEW_INCLUDE });
    if (!updated) throw fail("CUSTOM_SUBMISSION_NOT_FOUND", "Content submission disappeared after review", 404);
    const revisionContext = await loadRevisionContext(tx, agencyId, [updated]);
    return {
      idempotent: false,
      row: updated,
      previousRow: row,
      assetByKey,
      item: serializeReviewItem(updated, assetByKey, revisionContext.get(String(updated.id))),
      nextStatus,
    };
  };

  const outcome = typeof client.$transaction === "function"
    ? await client.$transaction(applyReview)
    : await applyReview(client);

  if (outcome.idempotent) return { ok: true, idempotent: true, item: outcome.item };

  await audit({
    agencyId,
    actorUserId: member.userId || null,
    action: outcome.nextStatus === REVIEW_APPROVED ? "custom_content_submission.approve" : "custom_content_submission.request_revision",
    targetType: "CustomContentSubmission",
    targetId: outcome.row.id,
    metadata: {
      creatorId: outcome.row.creatorId,
      customOrderId: outcome.row.customOrderId,
      reviewStatus: outcome.nextStatus,
      revisionCommentLength: outcome.nextStatus === REVIEW_REVISION ? normalizedComment.length : 0,
    },
    db: client,
  });
  return { ok: true, idempotent: false, item: outcome.item };
}

module.exports = {
  REVIEW_APPROVED,
  REVIEW_REVISION,
  REVIEW_WAITING,
  listCustomContentReviewQueue,
  reviewCustomContentSubmission,
};

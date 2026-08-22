"use strict";

const { allowedCreatorScope, requireCreatorAccess } = require("../middleware/automation-permissions");
const { canUsePermission } = require("./team-access-control");
const { assignCustomContentSubmission } = require("./custom-content-submissions-service");
const { paymentSnapshot } = require("./custom-orders-service");
const { uniqueMediaIds } = require("./custom-content-library-service");

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
      select: { creatorId: true, mediaId: true, customOrderId: true, customSubmissionId: true, customFullPriceCents: true, mediaType: true, thumbUrl: true, previewUrl: true, fullUrl: true },
      take: expected,
    });
    for (const asset of assets || []) map.set(`${asset.creatorId}\n${asset.mediaId}`, asset);
  }
  return map;
}

async function listUnassignedCustomContentSubmissions({ agencyId, member, limit = 50, db = null } = {}) {
  const client = db || require("../prisma");
  await requireWorkflowView({ agencyId, member, db: client });
  const scope = await allowedCreatorScope({ agencyId, member, db: client });
  const take = boundedLimit(limit);
  const where = { agencyId, customOrderId: null, ...scopeWhere(scope) };
  const [rows, count, canAssign] = await Promise.all([
    client.customContentSubmission.findMany({
      where,
      include: { creator: { select: { id: true, displayName: true, username: true, avatarUrl: true } } },
      orderBy: [{ receivedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
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
      return asset && String(asset.customSubmissionId || "") === String(row.id || "") && asset.customOrderId == null && asset.customFullPriceCents == null;
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
      libraryFinalized: mediaIds.length > 0 && finalizedMediaCount === mediaIds.length,
      media,
    };
  });
  return { ok: true, items, count: Number(count || 0), canAssign, serverNow: new Date().toISOString() };
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
  if (row.customOrderId) throw fail("CUSTOM_WORKFLOW_SUBMISSION_ALREADY_ASSIGNED", "Submission is already assigned to a custom order", 409);
  if (String(row.reviewStatus || REVIEW_WAITING) !== REVIEW_WAITING) throw fail("CUSTOM_SUBMISSION_REVIEW_LOCKED", "Reviewed submissions cannot be assigned", 409);
  return row;
}

async function candidateOrdersForCreator({ agencyId, creatorId, limit, db }) {
  const orders = await db.customOrder.findMany({
    where: { agencyId, creatorId, type: "CONTENT", status: "PENDING", fanDeliveredAt: null },
    select: { id: true, creatorId: true, dialogId: true, scenario: true, contentKind: true, priceCents: true, paidAmountCents: true, dueAt: true, createdAt: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: Math.max(limit * 4, 100),
  });
  if (!orders.length) return [];
  const orderIds = orders.map((row) => String(row.id));
  const submissions = await db.customContentSubmission.findMany({
    where: { agencyId, creatorId, customOrderId: { in: orderIds } },
    select: { id: true, customOrderId: true, reviewStatus: true, reviewComment: true, reviewedAt: true, receivedAt: true, createdAt: true },
    orderBy: [{ receivedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: Math.max(200, orderIds.length * 20),
  });
  const byOrder = new Map();
  for (const row of submissions || []) {
    const key = String(row.customOrderId || "");
    const list = byOrder.get(key) || [];
    list.push(row);
    byOrder.set(key, list);
  }
  const result = [];
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
  const candidates = await candidateOrdersForCreator({ agencyId, creatorId: row.creatorId, limit: 100, db: client });
  if (!candidates.some((candidate) => candidate.customOrderId === targetId)) {
    throw fail("CUSTOM_WORKFLOW_ASSIGN_TARGET_INVALID", "Target custom is not eligible for this submission; it may already have an active or approved version", 409);
  }
  return assignCustomContentSubmission({ agencyId, member, submissionId: row.id, customOrderId: targetId, db: client });
}

async function listAwaitingCustomRevisions({ agencyId, member, limit = 50, db = null } = {}) {
  const client = db || require("../prisma");
  await requireWorkflowView({ agencyId, member, db: client });
  const scope = await allowedCreatorScope({ agencyId, member, db: client });
  const take = boundedLimit(limit);
  const revisionRows = await client.customContentSubmission.findMany({
    where: {
      agencyId,
      reviewStatus: REVIEW_REVISION,
      customOrderId: { not: null },
      ...scopeWhere(scope),
    },
    include: {
      creator: { select: { id: true, displayName: true, username: true, avatarUrl: true } },
      reviewedByMember: { select: { id: true, displayName: true, roleKey: true } },
      customOrder: { select: { id: true, creatorId: true, dialogId: true, scenario: true, type: true, status: true, fanDeliveredAt: true, priceCents: true, paidAmountCents: true, contentKind: true } },
    },
    orderBy: [{ reviewedAt: "asc" }, { receivedAt: "asc" }, { id: "asc" }],
    take: Math.max(200, take * 10),
  });
  const valid = revisionRows.filter((row) => row.customOrder && String(row.customOrder.type || "") === "CONTENT" && String(row.customOrder.status || "") === "PENDING" && !row.customOrder.fanDeliveredAt);
  const orderIds = Array.from(new Set(valid.map((row) => String(row.customOrderId || "")).filter(Boolean)));
  const history = orderIds.length ? await client.customContentSubmission.findMany({
    where: { agencyId, customOrderId: { in: orderIds } },
    select: { id: true, customOrderId: true, reviewStatus: true, receivedAt: true, createdAt: true },
    orderBy: [{ receivedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: Math.max(200, orderIds.length * 20),
  }) : [];
  const byOrder = new Map();
  for (const item of history || []) {
    const key = String(item.customOrderId || "");
    const list = byOrder.get(key) || [];
    list.push(item);
    byOrder.set(key, list);
  }
  for (const list of byOrder.values()) list.sort(timelineCompare);
  const items = [];
  for (const row of valid) {
    const list = byOrder.get(String(row.customOrderId)) || [row];
    const latest = list[list.length - 1];
    if (!latest || String(latest.id) !== String(row.id)) continue;
    const index = list.findIndex((item) => String(item.id) === String(row.id));
    const order = row.customOrder;
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
      revisionNumber: Math.max(1, index + 1),
      nextRevisionNumber: Math.max(2, index + 2),
      revisionComment: row.reviewComment || null,
      requestedAt: row.reviewedAt ? new Date(row.reviewedAt).toISOString() : null,
      reviewedBy: reviewActor(row.reviewedByMember),
      modelComment: row.comment || null,
      previousMediaCount: uniqueMediaIds(row.ofMediaIds).length,
    });
    if (items.length >= take) break;
  }
  return { ok: true, items, count: items.length, serverNow: new Date().toISOString() };
}

module.exports = {
  assignUnassignedCustomContentSubmission,
  listAwaitingCustomRevisions,
  listCustomSubmissionAssignmentCandidates,
  listUnassignedCustomContentSubmissions,
};

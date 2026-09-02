"use strict";

const express = require("express");
const prisma = require("../prisma");
const { canUsePermission } = require("../services/team-access-control");
const { requireProductCreator } = require("../middleware/product-access");
const {
  cleanString,
  optionalString,
  jsonArray,
  jsonObject,
  centsFromAny,
  parseLimit,
  parseOffset,
  sendError,
} = require("../services/server-store-utils");

const router = express.Router();

function genericContentGone(req, res) {
  return res.status(410).json({
    ok: false,
    code: "LEGACY_CONTENT_COLLECTION_API_GONE",
    error: "Generic content collection API is retired; use the product-specific Message Library API",
  });
}

router.get("/collections", genericContentGone);
router.get("/collections/:id", genericContentGone);
router.post("/collections", genericContentGone);
router.patch("/collections/:id", genericContentGone);
router.delete("/collections/:id", genericContentGone);
router.put("/collections/:id/blocks", genericContentGone);
router.post("/collections/:id/usage", genericContentGone);


// ─────────────────────────────────────────────────────────────────────────────
// Message Library server source-of-truth adapter
//
// Electron Message Library still speaks its compact "script" shape. The server
// stores it in ContentCollection/ContentBlock so scripts are shared by all
// devices while Electron keeps only a warm local cache.
// ─────────────────────────────────────────────────────────────────────────────

const MESSAGE_LIBRARY_KIND = "message_library_script";

const MESSAGE_LIBRARY_TRASH_RETENTION_DAYS = 14;
const MESSAGE_LIBRARY_PURGE_INTERVAL_MS = 10 * 60 * 1000;
const messageLibraryPurgeStateByAgency = new Map();
function addDays(date, days) {
  return new Date(date.getTime() + Number(days || 0) * 24 * 60 * 60 * 1000);
}

function trashPurgeAfter(trashedAt = new Date()) {
  const base = trashedAt instanceof Date ? trashedAt : new Date(trashedAt || Date.now());
  return addDays(Number.isFinite(base.getTime()) ? base : new Date(), MESSAGE_LIBRARY_TRASH_RETENTION_DAYS);
}

async function isMessageLibraryManager(req) {
  const member = req.auth?.membership || req.member || null;
  if (!member) return false;
  return canUsePermission({ member, key: "message_library.manage", db: prisma });
}

async function assertMessageLibraryManager(req) {
  if (await isMessageLibraryManager(req)) return;
  const err = new Error("Message Library management permission is required");
  err.status = 403;
  err.code = "MESSAGE_LIBRARY_MANAGER_REQUIRED";
  throw err;
}

async function requireMessageLibraryCreator(req) {
  const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
  if (!creatorId) {
    const err = new Error("creatorId is required");
    err.status = 400;
    err.code = "CREATOR_ID_MISSING";
    throw err;
  }
  await requireProductCreator(req, creatorId, { db: prisma });
  return creatorId;
}

async function purgeExpiredMessageLibraryTrash(agencyId, creatorId) {
  const now = new Date();

  const expiredCollections = await prisma.contentCollection.findMany({
    where: {
      agencyId,
      creatorId,
      kind: MESSAGE_LIBRARY_KIND,
      OR: [
        { status: "trash", purgeAfter: { lte: now } },
        { deletedAt: { not: null }, purgeAfter: { lte: now } },
      ],
    },
    select: { id: true },
    take: 10000});

  const allCollections = await prisma.contentCollection.findMany({
    where: { agencyId, creatorId, kind: MESSAGE_LIBRARY_KIND },
    select: { id: true },
    take: 10000});
  const collectionIds = allCollections.map((item) => item.id);

  const expiredBlocks = collectionIds.length
    ? await prisma.contentBlock.deleteMany({
        where: {
          collectionId: { in: collectionIds },
          OR: [
            { status: "trash", purgeAfter: { lte: now } },
            { deletedAt: { not: null }, purgeAfter: { lte: now } },
          ],
        },
      })
    : { count: 0 };

  const collectionDelete = expiredCollections.length
    ? await prisma.contentCollection.deleteMany({ where: { id: { in: expiredCollections.map((item) => item.id) } } })
    : { count: 0 };

  return { ok: true, scriptsDeleted: collectionDelete.count || 0, blocksDeleted: expiredBlocks.count || 0 };
}

async function maybePurgeExpiredMessageLibraryTrash(agencyId, creatorId, { force = false } = {}) {
  const agencyKey = String(agencyId || "").trim();
  const creatorKey = String(creatorId || "").trim();
  const key = `${agencyKey}:${creatorKey}`;
  if (!agencyKey || !creatorKey) return { ok: true, skipped: true, reason: "creator_scope_missing", scriptsDeleted: 0, blocksDeleted: 0 };

  const now = Date.now();
  const previous = messageLibraryPurgeStateByAgency.get(key) || null;
  if (previous?.promise) return previous.promise;
  if (!force && previous?.completedAt && now - previous.completedAt < MESSAGE_LIBRARY_PURGE_INTERVAL_MS) {
    return { ok: true, skipped: true, reason: "throttled", scriptsDeleted: 0, blocksDeleted: 0 };
  }

  const promise = purgeExpiredMessageLibraryTrash(agencyKey, creatorKey);
  messageLibraryPurgeStateByAgency.set(key, { completedAt: previous?.completedAt || 0, promise });
  try {
    const result = await promise;
    messageLibraryPurgeStateByAgency.set(key, { completedAt: Date.now(), promise: null });
    return result;
  } catch (error) {
    messageLibraryPurgeStateByAgency.delete(key);
    throw error;
  }
}

function asDateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function dollarsFromCents(value) {
  const cents = Number(value || 0);
  if (!Number.isFinite(cents) || cents <= 0) return 0;
  return Math.round(cents) / 100;
}

function centsFromDollars(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100);
}

function normalizeMlTags(value = []) {
  const out = [];
  const seen = new Set();
  for (const item of jsonArray(value)) {
    const tag = cleanString(item, 60);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= 20) break;
  }
  return out;
}

function mlText(value, max = 12000) {
  const text = String(value == null ? "" : value);
  return text.length > max ? text.slice(0, max) : text;
}

const MESSAGE_LIBRARY_MEDIA_SENSITIVE_KEY = /(^|_)(authorization|cookie|cookies|token|password|secret)($|_)/i;

function isMlMediaSensitiveKey(value) {
  const normalized = String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
  return MESSAGE_LIBRARY_MEDIA_SENSITIVE_KEY.test(normalized);
}

function pruneMlMediaValue(value, depth = 0) {
  if (depth > 6 || value === undefined) return undefined;
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") return value.length > 4000 ? value.slice(0, 4000) : value;
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => pruneMlMediaValue(item, depth + 1)).filter((item) => item !== undefined);
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor" || isMlMediaSensitiveKey(key)) continue;
    const next = pruneMlMediaValue(item, depth + 1);
    if (next !== undefined) out[key] = next;
  }
  return out;
}

function compactMlMediaRaw(value) {
  const raw = pruneMlMediaValue(jsonObject(value));
  try {
    return JSON.stringify(raw || {}).length <= 50000 ? raw : {};
  } catch (_) {
    return {};
  }
}

function normalizeMlMedia(value = []) {
  const out = [];
  const seen = new Set();
  for (const item of jsonArray(value)) {
    const row = jsonObject(item);
    const raw = compactMlMediaRaw(row.raw);
    const id = cleanString(row.id || row.mediaId || row.media_id || row.sourceId || raw.id, 120);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      type: cleanString(row.type || row.mediaType || row.media_type || raw.type || "media", 40) || "media",
      thumb: cleanString(row.thumb || row.thumbUrl || row.previewUrl || row.url || raw.thumb || raw.previewUrl || raw.url, 4000),
      playUrl: optionalString(row.playUrl || row.fullUrl || raw.playUrl || raw.fullUrl || raw.url, 4000),
      duration: Math.max(0, Number(row.duration || row.dur || raw.duration || 0) || 0),
      raw: Object.keys(raw).length ? raw : null,
    });
    if (out.length >= 100) break;
  }
  return out;
}

function assertUniqueMlBlockClientIds(blocks) {
  const seen = new Set();
  for (const block of blocks) {
    if (!block.clientId || seen.has(block.clientId)) {
      const err = new Error("Every Message Library block must have a unique id");
      err.status = 400;
      err.code = "MESSAGE_LIBRARY_BLOCK_ID_DUPLICATE";
      throw err;
    }
    seen.add(block.clientId);
  }
}

function normalizeMlUsageMetadata(body, scriptId, messageId) {
  const metadata = jsonObject(body.metadata);
  return {
    source: cleanString(body.source || metadata.source || "electron-message-library", 100) || "electron-message-library",
    scriptId: scriptId || null,
    messageId: messageId || null,
    draftId: optionalString(body.draftId, 120),
    realMessageId: optionalString(body.realMessageId || body.purchaseMessageId, 120),
    amount: Math.max(0, Number(body.amount || metadata.amount || 0) || 0),
    currency: cleanString(body.currency || metadata.currency || "USD", 10).toUpperCase() || "USD",
    mediaCount: Math.max(0, Math.min(100, Math.floor(Number(metadata.mediaCount || 0) || 0))),
    price: Math.max(0, Number(metadata.price || 0) || 0),
    lockedText: metadata.lockedText === true,
  };
}

function messageFromBlock(block = {}, index = 0) {
  const metadata = jsonObject(block.metadata);
  return {
    id: String(block.clientId || block.id || `msg_${index}`),
    serverId: block.id || null,
    order: Number.isFinite(Number(block.order)) ? Number(block.order) : index,
    role: block.role || "message",
    title: block.title || block.role || `Message ${index + 1}`,
    text: block.text || "",
    price: dollarsFromCents(block.priceCents),
    currency: block.currency || "USD",
    lockedText: block.lockedText === true,
    media: normalizeMlMedia(block.media),
    note: block.note || "",
    stats: jsonObject(metadata.stats),
    status: block.status || (block.deletedAt ? "trash" : "active"),
    trashedAt: block.deletedAt || metadata.trashedAt || null,
    purgeAfter: block.purgeAfter || metadata.purgeAfter || null,
    createdAt: block.createdAt,
    updatedAt: block.updatedAt,
  };
}

function scriptFromCollection(collection = {}) {
  const metadata = jsonObject(collection.metadata);
  const collectionInTrash = !!collection.deletedAt || collection.status === "trash" || collection.status === "deleted";
  const messages = (Array.isArray(collection.blocks) ? collection.blocks : [])
    .filter((block) => collectionInTrash || !(block.deletedAt || block.status === "trash" || block.status === "deleted"))
    .map(messageFromBlock)
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
    .map((message, index) => ({ ...message, order: index }));

  return {
    schemaVersion: 1,
    id: String(collection.clientId || collection.id || ""),
    serverId: collection.id || null,
    accountId: collection.creatorId || metadata.accountId || "",
    creatorId: collection.creatorId || null,
    enabled: metadata.enabled !== false && collection.status !== "disabled" && collection.status !== "deleted" && collection.status !== "trash" && !collection.deletedAt,
    title: collection.title || "Untitled script",
    folderId: metadata.folderId || "scripts",
    description: collection.description || "",
    tags: normalizeMlTags(collection.tags),
    messages,
    stats: jsonObject(metadata.stats),
    status: collection.status || (collection.deletedAt ? "trash" : "active"),
    trashedAt: collection.deletedAt || metadata.trashedAt || null,
    purgeAfter: collection.purgeAfter || metadata.purgeAfter || null,
    trashRetentionDays: MESSAGE_LIBRARY_TRASH_RETENTION_DAYS,
    createdAt: collection.createdAt,
    updatedAt: collection.updatedAt,
    source: "server",
  };
}

function normalizeMlMessage(message = {}, index = 0) {
  const clientId = cleanString(message.id || message.clientId || `msg_${index}`, 120) || `msg_${index}`;
  const stats = jsonObject(message.stats);
  return {
    order: Number.isFinite(Number(message.order)) ? Number(message.order) : index,
    role: cleanString(message.role || "message", 40) || "message",
    title: optionalString(message.title || message.role || `Message ${index + 1}`, 180),
    text: mlText(message.text ?? message.messageText ?? message.body ?? "", 12000),
    priceCents: message.priceCents !== undefined ? centsFromAny(message, "priceCents", "price") : centsFromDollars(message.price),
    currency: cleanString(message.currency || "USD", 10).toUpperCase() || "USD",
    lockedText: message.lockedText === true,
    media: normalizeMlMedia(message.media),
    note: optionalString(message.note, 2000),
    clientId,
    metadata: {
      source: "message-library",
      stats,
      rawId: String(message.id || ""),
      updatedAt: new Date().toISOString(),
    },
  };
}

async function normalizeMlScriptPayload(req, { patch = false } = {}) {
  const body = req.body || {};
  const scriptId = cleanString(body.id || body.clientId || body.scriptId, 120) || `script_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const creatorId = cleanString(body.creatorId || body.accountId || req.query.creatorId, 100);
  await requireProductCreator(req, creatorId, { db: prisma });
  const restoreFromTrash = body.trashedAt === null || body.status === "active";
  const trashedAt = restoreFromTrash ? null : asDateOrNull(body.trashedAt);
  const enabled = body.enabled !== false && !trashedAt;
  const status = trashedAt ? "trash" : (enabled ? "active" : "disabled");
  const purgeAfter = trashedAt ? trashPurgeAfter(trashedAt) : null;

  const data = {
    agencyId: req.auth.agencyId,
    creatorId,
    kind: MESSAGE_LIBRARY_KIND,
    title: cleanString(body.title || body.name || "Untitled script", 180) || "Untitled script",
    description: optionalString(body.description, 2000),
    tags: normalizeMlTags(body.tags),
    status,
    clientId: scriptId,
    deletedAt: trashedAt,
    purgeAfter,
    trashedByUserId: trashedAt ? req.auth.userId : null,
    createdByUserId: req.auth.userId,
    updatedByUserId: req.auth.userId,
    metadata: {
      source: "message-library",
      accountId: cleanString(body.accountId || creatorId, 120) || null,
      folderId: cleanString(body.folderId || body.folder || "scripts", 80) || "scripts",
      enabled,
      stats: jsonObject(body.stats),
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
    },
  };

  if (patch) {
    delete data.agencyId;
    delete data.createdByUserId;
  }

  const blocks = Array.isArray(body.messages) ? body.messages : Array.isArray(body.blocks) ? body.blocks : [];
  const normalizedBlocks = blocks.map(normalizeMlMessage);
  assertUniqueMlBlockClientIds(normalizedBlocks);
  return { scriptId, data, blocks: normalizedBlocks };
}

async function upsertMessageLibraryScript(req) {
  const normalized = await normalizeMlScriptPayload(req);
  const existing = await prisma.contentCollection.findFirst({
    where: { agencyId: req.auth.agencyId, clientId: normalized.scriptId, kind: MESSAGE_LIBRARY_KIND },
    include: { blocks: true },
  });
  if (existing && String(existing.creatorId || "") !== String(normalized.data.creatorId || "")) {
    const err = new Error("Message Library script belongs to another creator");
    err.status = 409;
    err.code = "MESSAGE_LIBRARY_SCRIPT_CREATOR_MISMATCH";
    throw err;
  }

  return prisma.$transaction(async (tx) => {
    let collection;
    if (existing) {
      const updateData = { ...normalized.data };
      delete updateData.agencyId;
      delete updateData.createdByUserId;
      collection = await tx.contentCollection.update({
        where: { id: existing.id },
        data: updateData,
      });
    } else {
      collection = await tx.contentCollection.create({ data: normalized.data });
    }

    const incomingClientIds = normalized.blocks.map((block) => block.clientId).filter(Boolean);
    const trashAt = new Date();
    const purgeAfter = trashPurgeAfter(trashAt);

    // Missing blocks are moved to trash for 14 days instead of hard-deleted.
    // This allows restoring deleted message blocks and prevents accidental loss.
    if (existing) {
      await tx.contentBlock.updateMany({
        where: {
          collectionId: collection.id,
          deletedAt: null,
          ...(incomingClientIds.length ? { clientId: { notIn: incomingClientIds } } : {}),
        },
        data: {
          status: "trash",
          deletedAt: trashAt,
          purgeAfter,
          trashedByUserId: req.auth.userId,
        },
      });
    }

    for (const block of normalized.blocks) {
      const activeBlock = {
        ...block,
        status: "active",
        deletedAt: null,
        purgeAfter: null,
        trashedByUserId: null,
      };
      const prev = existing?.blocks?.find((item) => String(item.clientId || "") === String(block.clientId || ""));
      if (prev) {
        await tx.contentBlock.update({ where: { id: prev.id }, data: activeBlock });
      } else {
        await tx.contentBlock.create({ data: { collectionId: collection.id, ...activeBlock } });
      }
    }

    return tx.contentCollection.findFirst({
      where: { id: collection.id, agencyId: req.auth.agencyId },
      include: { blocks: { orderBy: [{ order: "asc" }, { createdAt: "asc" }] } },
    });
  });
}

router.get("/message-library/scripts", async (req, res) => {
  try {
    const creatorId = await requireMessageLibraryCreator(req);
    // Trash retention is maintenance, not a dependency of reads. A temporary
    // cleanup failure must never make the authoritative library unavailable.
    await maybePurgeExpiredMessageLibraryTrash(req.auth.agencyId, creatorId).catch(() => null);
    const includeTrash = req.query.includeTrash === "true" || req.query.includeTrash === "1";
    const where = {
      agencyId: req.auth.agencyId,
      kind: MESSAGE_LIBRARY_KIND,
    };
    if (!includeTrash) where.deletedAt = null;
    if (creatorId) where.creatorId = creatorId;

    const take = parseLimit(req.query.limit, 500, 1000);
    const skip = parseOffset(req.query.offset);
    const [items, count] = await Promise.all([
      prisma.contentCollection.findMany({
        where,
        include: { blocks: { orderBy: [{ order: "asc" }, { createdAt: "asc" }] } },
        orderBy: [{ updatedAt: "desc" }],
        take,
        skip,
      }),
      prisma.contentCollection.count({ where }),
    ]);

    return res.json({
      ok: true,
      source: "server",
      creatorId: creatorId || null,
      accountId: creatorId || null,
      items: items.map(scriptFromCollection),
      count,
      nextOffset: skip + items.length,
      hasMore: skip + items.length < count,
    });
  } catch (err) {
    return sendError(res, err, "MESSAGE_LIBRARY_SCRIPTS_FAILED");
  }
});

router.post("/message-library/scripts", async (req, res) => {
  try {
    await assertMessageLibraryManager(req);
    const item = await upsertMessageLibraryScript(req);
    return res.status(201).json({ ok: true, source: "server", item: scriptFromCollection(item) });
  } catch (err) {
    return sendError(res, err, "MESSAGE_LIBRARY_SCRIPT_SAVE_FAILED");
  }
});

router.put("/message-library/scripts/:id", async (req, res) => {
  try {
    await assertMessageLibraryManager(req);
    req.body = { ...(req.body || {}), id: req.params.id };
    const item = await upsertMessageLibraryScript(req);
    return res.json({ ok: true, source: "server", item: scriptFromCollection(item) });
  } catch (err) {
    return sendError(res, err, "MESSAGE_LIBRARY_SCRIPT_SAVE_FAILED");
  }
});

router.delete("/message-library/scripts/:id", async (req, res) => {
  try {
    await assertMessageLibraryManager(req);
    const id = cleanString(req.params.id, 120);
    const creatorId = await requireMessageLibraryCreator(req);
    const existing = await prisma.contentCollection.findFirst({
      where: { agencyId: req.auth.agencyId, clientId: id, kind: MESSAGE_LIBRARY_KIND, creatorId },
    });
    if (!existing) return res.status(404).json({ ok: false, code: "MESSAGE_LIBRARY_SCRIPT_NOT_FOUND", error: "Script not found" });

    const trashedAt = new Date();
    const purgeAfter = trashPurgeAfter(trashedAt);
    const item = await prisma.contentCollection.update({
      where: { id: existing.id },
      data: {
        deletedAt: trashedAt,
        status: "trash",
        purgeAfter,
        trashedByUserId: req.auth.userId,
        updatedByUserId: req.auth.userId,
      },
      include: { blocks: { orderBy: [{ order: "asc" }, { createdAt: "asc" }] } },
    });
    return res.json({ ok: true, retentionDays: MESSAGE_LIBRARY_TRASH_RETENTION_DAYS, item: scriptFromCollection(item) });
  } catch (err) {
    return sendError(res, err, "MESSAGE_LIBRARY_SCRIPT_DELETE_FAILED");
  }
});

router.post("/message-library/scripts/:id/restore", async (req, res) => {
  try {
    await assertMessageLibraryManager(req);
    const id = cleanString(req.params.id, 120);
    const creatorId = await requireMessageLibraryCreator(req);
    const existing = await prisma.contentCollection.findFirst({
      where: { agencyId: req.auth.agencyId, clientId: id, kind: MESSAGE_LIBRARY_KIND, creatorId },
    });
    if (!existing) return res.status(404).json({ ok: false, code: "MESSAGE_LIBRARY_SCRIPT_NOT_FOUND", error: "Script not found" });
    const item = await prisma.contentCollection.update({
      where: { id: existing.id },
      data: { deletedAt: null, status: "active", purgeAfter: null, trashedByUserId: null, updatedByUserId: req.auth.userId },
      include: { blocks: { orderBy: [{ order: "asc" }, { createdAt: "asc" }] } },
    });
    return res.json({ ok: true, item: scriptFromCollection(item) });
  } catch (err) {
    return sendError(res, err, "MESSAGE_LIBRARY_SCRIPT_RESTORE_FAILED");
  }
});

router.delete("/message-library/scripts/:id/permanent", async (req, res) => {
  try {
    await assertMessageLibraryManager(req);
    const id = cleanString(req.params.id, 120);
    const creatorId = await requireMessageLibraryCreator(req);
    const existing = await prisma.contentCollection.findFirst({
      where: { agencyId: req.auth.agencyId, clientId: id, kind: MESSAGE_LIBRARY_KIND, creatorId },
      include: { blocks: { orderBy: [{ order: "asc" }, { createdAt: "asc" }] } },
    });
    if (!existing) return res.status(404).json({ ok: false, code: "MESSAGE_LIBRARY_SCRIPT_NOT_FOUND", error: "Script not found" });
    if (!existing.deletedAt && existing.status !== "trash" && existing.status !== "deleted") {
      return res.status(409).json({ ok: false, code: "MESSAGE_LIBRARY_SCRIPT_NOT_TRASHED", error: "Move the script to trash before deleting it forever" });
    }
    const item = scriptFromCollection(existing);
    await prisma.contentCollection.delete({ where: { id: existing.id } });
    return res.json({ ok: true, permanent: true, item });
  } catch (err) {
    return sendError(res, err, "MESSAGE_LIBRARY_SCRIPT_PERMANENT_DELETE_FAILED");
  }
});

router.delete("/message-library/scripts/:scriptId/messages/:messageId", async (req, res) => {
  try {
    await assertMessageLibraryManager(req);
    const scriptId = cleanString(req.params.scriptId, 120);
    const messageId = cleanString(req.params.messageId, 120);
    const creatorId = await requireMessageLibraryCreator(req);
    const collection = await prisma.contentCollection.findFirst({
      where: { agencyId: req.auth.agencyId, clientId: scriptId, kind: MESSAGE_LIBRARY_KIND, creatorId },
      include: { blocks: true },
    });
    if (!collection) return res.status(404).json({ ok: false, code: "MESSAGE_LIBRARY_SCRIPT_NOT_FOUND", error: "Script not found" });
    const block = collection.blocks.find((item) => String(item.clientId || item.id) === String(messageId));
    if (!block) return res.status(404).json({ ok: false, code: "MESSAGE_LIBRARY_BLOCK_NOT_FOUND", error: "Message block not found" });
    const trashedAt = new Date();
    const updated = await prisma.contentBlock.update({
      where: { id: block.id },
      data: { status: "trash", deletedAt: trashedAt, purgeAfter: trashPurgeAfter(trashedAt), trashedByUserId: req.auth.userId },
    });
    return res.json({ ok: true, retentionDays: MESSAGE_LIBRARY_TRASH_RETENTION_DAYS, block: messageFromBlock(updated) });
  } catch (err) {
    return sendError(res, err, "MESSAGE_LIBRARY_BLOCK_DELETE_FAILED");
  }
});

router.post("/message-library/scripts/:scriptId/messages/:messageId/restore", async (req, res) => {
  try {
    await assertMessageLibraryManager(req);
    const scriptId = cleanString(req.params.scriptId, 120);
    const messageId = cleanString(req.params.messageId, 120);
    const creatorId = await requireMessageLibraryCreator(req);
    const collection = await prisma.contentCollection.findFirst({
      where: { agencyId: req.auth.agencyId, clientId: scriptId, kind: MESSAGE_LIBRARY_KIND, creatorId },
      include: { blocks: true },
    });
    if (!collection) return res.status(404).json({ ok: false, code: "MESSAGE_LIBRARY_SCRIPT_NOT_FOUND", error: "Script not found" });
    const block = collection.blocks.find((item) => String(item.clientId || item.id) === String(messageId));
    if (!block) return res.status(404).json({ ok: false, code: "MESSAGE_LIBRARY_BLOCK_NOT_FOUND", error: "Message block not found" });
    const updated = await prisma.contentBlock.update({
      where: { id: block.id },
      data: { status: "active", deletedAt: null, purgeAfter: null, trashedByUserId: null },
    });
    return res.json({ ok: true, block: messageFromBlock(updated) });
  } catch (err) {
    return sendError(res, err, "MESSAGE_LIBRARY_BLOCK_RESTORE_FAILED");
  }
});

router.post("/message-library/purge-expired", async (req, res) => {
  try {
    await assertMessageLibraryManager(req);
    const creatorId = await requireMessageLibraryCreator(req);
    const result = await maybePurgeExpiredMessageLibraryTrash(req.auth.agencyId, creatorId, { force: true });
    return res.json({ ...result, creatorId });
  } catch (err) {
    return sendError(res, err, "MESSAGE_LIBRARY_PURGE_EXPIRED_FAILED");
  }
});

router.get("/message-library/usage", async (req, res) => {
  try {
    const creatorId = await requireMessageLibraryCreator(req);
    const collections = await prisma.contentCollection.findMany({
      where: { agencyId: req.auth.agencyId, creatorId, kind: MESSAGE_LIBRARY_KIND },
      select: { id: true },
      take: 10000,
    });
    const collectionIds = collections.map((item) => item.id);
    if (!collectionIds.length) return res.json({ ok: true, source: "server", events: [], count: 0 });
    const events = await prisma.contentUsageEvent.findMany({
      where: { agencyId: req.auth.agencyId, creatorId, collectionId: { in: collectionIds } },
      orderBy: [{ createdAt: "desc" }],
      take: parseLimit(req.query.limit, 500, 2000),
      skip: parseOffset(req.query.offset),
    });
    return res.json({ ok: true, source: "server", creatorId, events, count: events.length });
  } catch (err) {
    return sendError(res, err, "MESSAGE_LIBRARY_USAGE_LIST_FAILED");
  }
});

router.post("/message-library/usage", async (req, res) => {
  try {
    const body = req.body || {};
    const scriptId = cleanString(body.scriptId || body.collectionId, 120);
    const messageId = cleanString(body.messageId || body.blockId, 120);
    const creatorId = cleanString(body.creatorId || body.accountId, 100);
    if (!scriptId || !creatorId) {
      const err = new Error("creatorId and scriptId are required");
      err.status = 400;
      err.code = "MESSAGE_LIBRARY_USAGE_KEYS_MISSING";
      throw err;
    }
    await requireProductCreator(req, creatorId, { db: prisma });

    const collection = await prisma.contentCollection.findFirst({
      where: { agencyId: req.auth.agencyId, kind: MESSAGE_LIBRARY_KIND, clientId: scriptId, creatorId },
      include: { blocks: true },
    });
    if (!collection) {
      const err = new Error("Message Library script not found for this creator");
      err.status = 404;
      err.code = "MESSAGE_LIBRARY_SCRIPT_NOT_FOUND";
      throw err;
    }
    const block = messageId
      ? collection.blocks.find((item) => String(item.clientId || item.id) === String(messageId)) || null
      : null;
    if (messageId && !block) {
      const err = new Error("Message Library block not found");
      err.status = 404;
      err.code = "MESSAGE_LIBRARY_BLOCK_NOT_FOUND";
      throw err;
    }

    const event = await prisma.contentUsageEvent.create({
      data: {
        agencyId: req.auth.agencyId,
        collectionId: collection.id,
        blockId: block?.id || null,
        creatorId,
        fanId: optionalString(body.fanId, 80),
        dialogId: optionalString(body.dialogId, 80),
        eventType: cleanString(body.eventType || body.status || "used", 40) || "used",
        metadata: normalizeMlUsageMetadata(body, scriptId, messageId),
        createdByUserId: req.auth.userId,
      },
    });

    return res.status(201).json({ ok: true, source: "server", event });
  } catch (err) {
    return sendError(res, err, "MESSAGE_LIBRARY_USAGE_EVENT_FAILED");
  }
});

module.exports = router;

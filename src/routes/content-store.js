"use strict";

const express = require("express");
const prisma = require("../prisma");
const { canUsePermission, directPermissionValue } = require("../services/team-access-control");
const {
  cleanString,
  optionalString,
  jsonArray,
  jsonObject,
  centsFromAny,
  parseLimit,
  parseOffset,
  requireCreator,
  sendError,
} = require("../services/server-store-utils");

const router = express.Router();

function collectionSelect() {
  return {
    include: {
      blocks: { orderBy: [{ order: "asc" }, { createdAt: "asc" }] },
    },
  };
}

async function normalizeCollectionInput(req, { patch = false } = {}) {
  const body = req.body || {};
  const data = {};

  if (!patch || body.kind !== undefined) data.kind = cleanString(body.kind || "message_library", 40) || "message_library";
  if (!patch || body.title !== undefined) data.title = cleanString(body.title || "Untitled", 180) || "Untitled";
  if (!patch || body.description !== undefined) data.description = optionalString(body.description, 2000);
  if (!patch || body.tags !== undefined) data.tags = jsonArray(body.tags).map((x) => cleanString(x, 60)).filter(Boolean).slice(0, 100);
  if (!patch || body.status !== undefined) data.status = cleanString(body.status || "active", 40) || "active";
  if (!patch || body.clientId !== undefined) data.clientId = optionalString(body.clientId, 120);

  if (body.creatorId !== undefined) {
    const creatorId = cleanString(body.creatorId, 100);
    if (creatorId) await requireCreator(prisma, req.auth.agencyId, creatorId);
    data.creatorId = creatorId || null;
  } else if (!patch) {
    data.creatorId = null;
  }

  if (!patch) {
    data.agencyId = req.auth.agencyId;
    data.createdByUserId = req.auth.userId;
  }
  data.updatedByUserId = req.auth.userId;

  return data;
}

function normalizeBlockInput(body = {}, index = 0, { patch = false } = {}) {
  const data = {};
  if (!patch || body.order !== undefined) data.order = Number.isFinite(Number(body.order)) ? Number(body.order) : index;
  if (!patch || body.role !== undefined) data.role = cleanString(body.role || "message", 40) || "message";
  if (!patch || body.title !== undefined) data.title = optionalString(body.title, 180);
  if (!patch || body.text !== undefined) data.text = cleanString(body.text || "", 12000);
  if (!patch || body.priceCents !== undefined || body.price !== undefined) data.priceCents = centsFromAny(body, "priceCents", "price");
  if (!patch || body.currency !== undefined) data.currency = cleanString(body.currency || "USD", 10).toUpperCase() || "USD";
  if (!patch || body.lockedText !== undefined) data.lockedText = body.lockedText === true;
  if (!patch || body.media !== undefined) data.media = jsonArray(body.media);
  if (!patch || body.note !== undefined) data.note = optionalString(body.note, 2000);
  if (!patch || body.metadata !== undefined) data.metadata = jsonObject(body.metadata);
  if (!patch || body.clientId !== undefined) data.clientId = optionalString(body.clientId, 120);
  return data;
}

router.get("/collections", async (req, res) => {
  try {
    const where = {
      agencyId: req.auth.agencyId,
      deletedAt: null,
    };
    const kind = cleanString(req.query.kind, 40);
    const creatorId = cleanString(req.query.creatorId, 100);
    const status = cleanString(req.query.status, 40);
    const q = cleanString(req.query.q, 120);

    if (kind) where.kind = kind;
    where.creatorId = creatorId;
    if (status) where.status = status;
    if (q) {
      where.OR = [
        { title: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } },
      ];
    }

    const take = parseLimit(req.query.limit, 100, 500);
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

    return res.json({ ok: true, items, count, nextOffset: skip + items.length, hasMore: skip + items.length < count });
  } catch (err) {
    return sendError(res, err, "CONTENT_COLLECTIONS_FAILED");
  }
});

router.get("/collections/:id", async (req, res) => {
  try {
    const item = await prisma.contentCollection.findFirst({
      where: { id: req.params.id, agencyId: req.auth.agencyId, deletedAt: null },
      ...collectionSelect(),
    });
    if (!item) return res.status(404).json({ ok: false, code: "CONTENT_COLLECTION_NOT_FOUND", error: "Collection not found" });
    return res.json({ ok: true, item });
  } catch (err) {
    return sendError(res, err, "CONTENT_COLLECTION_FAILED");
  }
});

router.post("/collections", async (req, res) => {
  try {
    const collectionData = await normalizeCollectionInput(req);
    const blocks = Array.isArray(req.body?.blocks) ? req.body.blocks : [];
    const item = await prisma.contentCollection.create({
      data: {
        ...collectionData,
        blocks: { create: blocks.map((block, index) => normalizeBlockInput(block, index)) },
      },
      ...collectionSelect(),
    });
    return res.status(201).json({ ok: true, item });
  } catch (err) {
    return sendError(res, err, "CONTENT_COLLECTION_CREATE_FAILED");
  }
});

router.patch("/collections/:id", async (req, res) => {
  try {
    const existing = await prisma.contentCollection.findFirst({ where: { id: req.params.id, agencyId: req.auth.agencyId, deletedAt: null } });
    if (!existing) return res.status(404).json({ ok: false, code: "CONTENT_COLLECTION_NOT_FOUND", error: "Collection not found" });
    const data = await normalizeCollectionInput(req, { patch: true });
    const item = await prisma.contentCollection.update({ where: { id: existing.id }, data, ...collectionSelect() });
    return res.json({ ok: true, item });
  } catch (err) {
    return sendError(res, err, "CONTENT_COLLECTION_UPDATE_FAILED");
  }
});

router.delete("/collections/:id", async (req, res) => {
  try {
    const existing = await prisma.contentCollection.findFirst({ where: { id: req.params.id, agencyId: req.auth.agencyId, deletedAt: null } });
    if (!existing) return res.status(404).json({ ok: false, code: "CONTENT_COLLECTION_NOT_FOUND", error: "Collection not found" });
    const item = await prisma.contentCollection.update({
      where: { id: existing.id },
      data: { deletedAt: new Date(), status: "deleted", updatedByUserId: req.auth.userId },
    });
    return res.json({ ok: true, item });
  } catch (err) {
    return sendError(res, err, "CONTENT_COLLECTION_DELETE_FAILED");
  }
});

router.put("/collections/:id/blocks", async (req, res) => {
  try {
    const existing = await prisma.contentCollection.findFirst({ where: { id: req.params.id, agencyId: req.auth.agencyId, deletedAt: null } });
    if (!existing) return res.status(404).json({ ok: false, code: "CONTENT_COLLECTION_NOT_FOUND", error: "Collection not found" });
    const blocks = Array.isArray(req.body?.blocks) ? req.body.blocks : [];
    const item = await prisma.$transaction(async (tx) => {
      await tx.contentBlock.deleteMany({ where: { collectionId: existing.id } });
      if (blocks.length) {
        await tx.contentBlock.createMany({ data: blocks.map((block, index) => ({ collectionId: existing.id, ...normalizeBlockInput(block, index) })) });
      }
      return tx.contentCollection.update({
        where: { id: existing.id },
        data: { updatedByUserId: req.auth.userId },
        include: { blocks: { orderBy: [{ order: "asc" }, { createdAt: "asc" }] } },
      });
    });
    return res.json({ ok: true, item });
  } catch (err) {
    return sendError(res, err, "CONTENT_BLOCKS_REPLACE_FAILED");
  }
});

router.post("/collections/:id/usage", async (req, res) => {
  try {
    const existing = await prisma.contentCollection.findFirst({ where: { id: req.params.id, agencyId: req.auth.agencyId, deletedAt: null } });
    if (!existing) return res.status(404).json({ ok: false, code: "CONTENT_COLLECTION_NOT_FOUND", error: "Collection not found" });
    const event = await prisma.contentUsageEvent.create({
      data: {
        agencyId: req.auth.agencyId,
        collectionId: existing.id,
        blockId: optionalString(req.body?.blockId, 100),
        creatorId: optionalString(req.body?.creatorId || existing.creatorId, 100),
        fanId: optionalString(req.body?.fanId, 80),
        dialogId: optionalString(req.body?.dialogId, 80),
        eventType: cleanString(req.body?.eventType || "used", 40) || "used",
        metadata: jsonObject(req.body?.metadata),
        createdByUserId: req.auth.userId,
      },
    });
    return res.status(201).json({ ok: true, event });
  } catch (err) {
    return sendError(res, err, "CONTENT_USAGE_FAILED");
  }
});


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
const MESSAGE_LIBRARY_MANAGER_PERMISSION_KEYS = [
  "message_library.manage",
  "messageLibrary.manage",
  "content.manage",
  "library.manage",
];

function addDays(date, days) {
  return new Date(date.getTime() + Number(days || 0) * 24 * 60 * 60 * 1000);
}

function trashPurgeAfter(trashedAt = new Date()) {
  const base = trashedAt instanceof Date ? trashedAt : new Date(trashedAt || Date.now());
  return addDays(Number.isFinite(base.getTime()) ? base : new Date(), MESSAGE_LIBRARY_TRASH_RETENTION_DAYS);
}

async function isMessageLibraryManager(req) {
  const member = req.auth?.membership || req.member || (req.auth ? { agencyId: req.auth.agencyId, role: req.auth.role, roleKey: req.auth.roleKey, permissions: req.auth.permissions || {} } : null);
  if (!member) return false;
  const perms = member.permissions || {};
  const canonical = directPermissionValue(perms, "message_library.manage");
  if (canonical !== null) return canonical;
  let sawLegacyDeny = false;
  for (const key of MESSAGE_LIBRARY_MANAGER_PERMISSION_KEYS.filter((key) => key !== "message_library.manage")) {
    const value = directPermissionValue(perms, key);
    if (value === true) return true;
    if (value === false) sawLegacyDeny = true;
  }
  if (sawLegacyDeny) return false;
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
  await requireCreator(prisma, req.auth.agencyId, creatorId);
  return creatorId;
}

async function purgeExpiredMessageLibraryTrash(agencyId) {
  const now = new Date();

  const expiredCollections = await prisma.contentCollection.findMany({
    where: {
      agencyId,
      kind: MESSAGE_LIBRARY_KIND,
      OR: [
        { status: "trash", purgeAfter: { lte: now } },
        { deletedAt: { not: null }, purgeAfter: { lte: now } },
      ],
    },
    select: { id: true },
    take: 10000});

  const allCollections = await prisma.contentCollection.findMany({
    where: { agencyId, kind: MESSAGE_LIBRARY_KIND },
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

async function maybePurgeExpiredMessageLibraryTrash(agencyId, { force = false } = {}) {
  const key = String(agencyId || "").trim();
  if (!key) return { ok: true, skipped: true, reason: "agency_missing", scriptsDeleted: 0, blocksDeleted: 0 };

  const now = Date.now();
  const previous = messageLibraryPurgeStateByAgency.get(key) || null;
  if (previous?.promise) return previous.promise;
  if (!force && previous?.completedAt && now - previous.completedAt < MESSAGE_LIBRARY_PURGE_INTERVAL_MS) {
    return { ok: true, skipped: true, reason: "throttled", scriptsDeleted: 0, blocksDeleted: 0 };
  }

  const promise = purgeExpiredMessageLibraryTrash(key);
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
  await requireCreator(prisma, req.auth.agencyId, creatorId);
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
    await maybePurgeExpiredMessageLibraryTrash(req.auth.agencyId).catch(() => null);
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
    const result = await maybePurgeExpiredMessageLibraryTrash(req.auth.agencyId, { force: true });
    return res.json(result);
  } catch (err) {
    return sendError(res, err, "MESSAGE_LIBRARY_PURGE_EXPIRED_FAILED");
  }
});

router.get("/message-library/usage", async (req, res) => {
  try {
    const creatorId = cleanString(req.query.creatorId || req.query.accountId, 100);
    if (creatorId) await requireCreator(prisma, req.auth.agencyId, creatorId);
    const collections = await prisma.contentCollection.findMany({
      where: { agencyId: req.auth.agencyId, kind: MESSAGE_LIBRARY_KIND, ...(creatorId ? { creatorId } : {}) },
      select: { id: true },
      take: 10000,
    });
    const collectionIds = collections.map((item) => item.id);
    if (!collectionIds.length) return res.json({ ok: true, source: "server", events: [], count: 0 });
    const events = await prisma.contentUsageEvent.findMany({
      where: { agencyId: req.auth.agencyId, collectionId: { in: collectionIds }, ...(creatorId ? { creatorId } : {}) },
      orderBy: [{ createdAt: "desc" }],
      take: parseLimit(req.query.limit, 500, 2000),
      skip: parseOffset(req.query.offset),
    });
    return res.json({ ok: true, source: "server", events, count: events.length });
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
    await requireCreator(prisma, req.auth.agencyId, creatorId);

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

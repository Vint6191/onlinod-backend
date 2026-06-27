"use strict";

const express = require("express");
const prisma = require("../prisma");
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
    if (creatorId) where.creatorId = creatorId;
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

function isMessageLibraryManager(req) {
  const role = String(req.auth?.role || req.auth?.membership?.role || "").toUpperCase();
  const roleKey = String(req.auth?.membership?.roleKey || req.auth?.roleKey || "").toLowerCase();
  if (["OWNER", "ADMIN", "MANAGER"].includes(role)) return true;
  if (["owner", "admin", "manager"].includes(roleKey)) return true;

  const perms = req.auth?.permissions || req.auth?.membership?.permissions || {};
  for (const key of MESSAGE_LIBRARY_MANAGER_PERMISSION_KEYS) {
    if (perms?.[key] === true) return true;
  }
  return false;
}

function assertMessageLibraryManager(req) {
  if (isMessageLibraryManager(req)) return;
  const err = new Error("Only managers/admins can modify the global Message Library");
  err.status = 403;
  err.code = "MESSAGE_LIBRARY_MANAGER_REQUIRED";
  throw err;
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
  return jsonArray(value).map((x) => cleanString(x, 60)).filter(Boolean).slice(0, 20);
}

function normalizeMlMedia(value = []) {
  return jsonArray(value).slice(0, 100);
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
    media: jsonArray(block.media),
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
    tags: jsonArray(collection.tags),
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
    text: cleanString(message.text || message.messageText || message.body || "", 12000),
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

function normalizeMlScriptPayload(req, { patch = false } = {}) {
  const body = req.body || {};
  const scriptId = cleanString(body.id || body.clientId || body.scriptId, 120) || `script_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const creatorId = cleanString(body.creatorId || body.accountId || req.query.creatorId, 100) || null;
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
  return { scriptId, data, blocks: blocks.map(normalizeMlMessage) };
}

async function upsertMessageLibraryScript(req) {
  const normalized = normalizeMlScriptPayload(req);
  const existing = await prisma.contentCollection.findFirst({
    where: { agencyId: req.auth.agencyId, clientId: normalized.scriptId, kind: MESSAGE_LIBRARY_KIND },
    include: { blocks: true },
  });

  return prisma.$transaction(async (tx) => {
    let collection;
    if (existing) {
      collection = await tx.contentCollection.update({
        where: { id: existing.id },
        data: normalized.data,
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
    await purgeExpiredMessageLibraryTrash(req.auth.agencyId);
    const includeTrash = req.query.includeTrash === "true" || req.query.includeTrash === "1";
    const creatorId = cleanString(req.query.creatorId || req.query.accountId, 100);
    const where = {
      agencyId: req.auth.agencyId,
      kind: MESSAGE_LIBRARY_KIND,
    };
    if (!includeTrash) where.deletedAt = null;
    if (creatorId) where.creatorId = creatorId;

    const items = await prisma.contentCollection.findMany({
      where,
      include: { blocks: { orderBy: [{ order: "asc" }, { createdAt: "asc" }] } },
      orderBy: [{ updatedAt: "desc" }],
      take: parseLimit(req.query.limit, 500, 1000),
      skip: parseOffset(req.query.offset),
    });

    return res.json({
      ok: true,
      source: "server",
      creatorId: creatorId || null,
      accountId: creatorId || null,
      items: items.map(scriptFromCollection),
      count: items.length,
    });
  } catch (err) {
    return sendError(res, err, "MESSAGE_LIBRARY_SCRIPTS_FAILED");
  }
});

router.post("/message-library/scripts", async (req, res) => {
  try {
    assertMessageLibraryManager(req);
    const item = await upsertMessageLibraryScript(req);
    return res.status(201).json({ ok: true, source: "server", item: scriptFromCollection(item) });
  } catch (err) {
    return sendError(res, err, "MESSAGE_LIBRARY_SCRIPT_SAVE_FAILED");
  }
});

router.put("/message-library/scripts/:id", async (req, res) => {
  try {
    assertMessageLibraryManager(req);
    req.body = { ...(req.body || {}), id: req.params.id };
    const item = await upsertMessageLibraryScript(req);
    return res.json({ ok: true, source: "server", item: scriptFromCollection(item) });
  } catch (err) {
    return sendError(res, err, "MESSAGE_LIBRARY_SCRIPT_SAVE_FAILED");
  }
});

router.delete("/message-library/scripts/:id", async (req, res) => {
  try {
    assertMessageLibraryManager(req);
    const id = cleanString(req.params.id, 120);
    const existing = await prisma.contentCollection.findFirst({
      where: { agencyId: req.auth.agencyId, clientId: id, kind: MESSAGE_LIBRARY_KIND },
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
    assertMessageLibraryManager(req);
    const id = cleanString(req.params.id, 120);
    const existing = await prisma.contentCollection.findFirst({
      where: { agencyId: req.auth.agencyId, clientId: id, kind: MESSAGE_LIBRARY_KIND },
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

router.delete("/message-library/scripts/:scriptId/messages/:messageId", async (req, res) => {
  try {
    assertMessageLibraryManager(req);
    const scriptId = cleanString(req.params.scriptId, 120);
    const messageId = cleanString(req.params.messageId, 120);
    const collection = await prisma.contentCollection.findFirst({
      where: { agencyId: req.auth.agencyId, clientId: scriptId, kind: MESSAGE_LIBRARY_KIND },
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
    assertMessageLibraryManager(req);
    const scriptId = cleanString(req.params.scriptId, 120);
    const messageId = cleanString(req.params.messageId, 120);
    const collection = await prisma.contentCollection.findFirst({
      where: { agencyId: req.auth.agencyId, clientId: scriptId, kind: MESSAGE_LIBRARY_KIND },
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
    assertMessageLibraryManager(req);
    const result = await purgeExpiredMessageLibraryTrash(req.auth.agencyId);
    return res.json(result);
  } catch (err) {
    return sendError(res, err, "MESSAGE_LIBRARY_PURGE_EXPIRED_FAILED");
  }
});

router.get("/message-library/usage", async (req, res) => {
  try {
    const creatorId = cleanString(req.query.creatorId || req.query.accountId, 100);
    const where = { agencyId: req.auth.agencyId };
    if (creatorId) where.creatorId = creatorId;
    const events = await prisma.contentUsageEvent.findMany({
      where,
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
    const creatorId = cleanString(body.creatorId || body.accountId, 100) || null;

    let collection = null;
    let block = null;
    if (scriptId) {
      collection = await prisma.contentCollection.findFirst({
        where: { agencyId: req.auth.agencyId, kind: MESSAGE_LIBRARY_KIND, clientId: scriptId },
        include: { blocks: true },
      });
      block = collection?.blocks?.find((x) => String(x.clientId || x.id) === String(messageId)) || null;
    }

    const event = await prisma.contentUsageEvent.create({
      data: {
        agencyId: req.auth.agencyId,
        collectionId: collection?.id || null,
        blockId: block?.id || messageId || null,
        creatorId,
        fanId: optionalString(body.fanId || body.dialogId, 80),
        dialogId: optionalString(body.dialogId, 80),
        eventType: cleanString(body.eventType || body.status || "used", 40) || "used",
        metadata: {
          ...jsonObject(body.metadata),
          source: body.source || "electron-message-library",
          scriptId: scriptId || null,
          messageId: messageId || null,
          draftId: body.draftId || null,
          realMessageId: body.realMessageId || body.purchaseMessageId || null,
          amount: Number(body.amount || 0) || 0,
          currency: body.currency || "USD",
          raw: jsonObject(body.rawEvent || body.raw || {}),
        },
        createdByUserId: req.auth.userId,
      },
    });

    return res.status(201).json({ ok: true, source: "server", event });
  } catch (err) {
    return sendError(res, err, "MESSAGE_LIBRARY_USAGE_EVENT_FAILED");
  }
});

module.exports = router;

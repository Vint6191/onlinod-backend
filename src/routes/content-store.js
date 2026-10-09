"use strict";
const { normalizeUsageInput, recordMessageLibraryUsage } = require("../services/message-library-usage-service");

const express = require("express");
const { executeMessageLibraryCommand } = require("../services/message-library-command-service");
const prisma = require("../prisma");
const { canUsePermission } = require("../services/team-access-control");
const { requireProductCreator } = require("../middleware/product-access");
const { preflightProgrammaticCustomMedia } = require("../services/custom-content-delivery-service");
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

const { upsertMessageLibraryBlocks, withMessageLibraryMutation, changeMessageLibraryLifecycle, runMessageLibraryTrashMaintenance, isTrash } = require("../services/message-library-lifecycle-service");
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
function trashPurgeAfter(trashedAt = new Date()) { return new Date(trashedAt.getTime() + MESSAGE_LIBRARY_TRASH_RETENTION_DAYS * 86400000); }
function mutationContext(req, creatorId, scriptId, action, manager = true, db = prisma) {
  return { db, agencyId: req.auth.agencyId, creatorId, scriptId, action, manager,
    userId: req.auth.userId, actorMember: req.auth.membership || req.member,
    expectedUpdatedAt: req.body?.expectedUpdatedAt || (action === "save" && req.body?.serverId ? req.body?.updatedAt : null) };
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

async function normalizeMlScriptPayload(req, { patch = false, db = prisma } = {}) {
  const body = req.body || {};
  const scriptId = cleanString(body.id || body.clientId || body.scriptId, 120);
  if (!scriptId) throw Object.assign(new Error("Stable script identity is required"), { code: "MESSAGE_LIBRARY_SCRIPT_ID_MISSING", status: 400 });
  const creatorId = cleanString(body.creatorId || body.accountId || req.query.creatorId, 100);
  await requireProductCreator(req, creatorId, { db });
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
  if (blocks.length > 500) throw Object.assign(new Error("One script supports at most 500 messages"), {code:"MESSAGE_LIBRARY_SCRIPT_LIMIT",status:413});
  const normalizedBlocks = blocks.map(normalizeMlMessage);
  if (Buffer.byteLength(JSON.stringify({data,blocks:normalizedBlocks})) > 2 * 1024 * 1024) throw Object.assign(new Error("One script supports at most 2 MiB of normalized content"), {code:"MESSAGE_LIBRARY_SCRIPT_LIMIT",status:413});
  assertUniqueMlBlockClientIds(normalizedBlocks);
  return { scriptId, data, blocks: normalizedBlocks };
}

async function upsertMessageLibraryScript(req, db = prisma) {
  const normalized = await normalizeMlScriptPayload(req, { db });
  const mediaIds = [...new Set(normalized.blocks.flatMap((block) => normalizeMlMedia(block.media).map((item) => String(item.id || "").trim())).filter(Boolean))];
  if (mediaIds.length > 2000) throw Object.assign(new Error("One script supports at most 2000 distinct media references"), {code:"MESSAGE_LIBRARY_SCRIPT_LIMIT",status:413});
  if (mediaIds.length) {
    const customMediaIds = [];
    // The canonical programmatic provenance classifier intentionally bounds one
    // request to 200 IDs. A reusable script can contain more across many blocks,
    // so exhaustively classify every chunk instead of turning a transport batch
    // size into a correctness horizon or rejecting a large all-GENERAL script.
    for (let offset = 0; offset < mediaIds.length; offset += 200) {
      const preflight = await preflightProgrammaticCustomMedia({
        agencyId: req.auth.agencyId,
        member: req.auth.membership || req.member,
        creatorId: normalized.data.creatorId,
        mediaIds: mediaIds.slice(offset, offset + 200),
        db,
      });
      if (!preflight?.ok || !Array.isArray(preflight.customMediaIds)) {
        const err = new Error("Message Library media provenance check returned an incomplete result");
        err.status = 503;
        err.code = "MESSAGE_LIBRARY_MEDIA_PROVENANCE_INCOMPLETE";
        throw err;
      }
      customMediaIds.push(...preflight.customMediaIds.map(String));
    }
    if (customMediaIds.length) {
      const err = new Error("CUSTOM media cannot be saved into reusable Message Library scripts");
      err.status = 409;
      err.code = "MESSAGE_LIBRARY_CUSTOM_MEDIA_FORBIDDEN";
      err.customMediaIds = [...new Set(customMediaIds)];
      throw err;
    }
  }
  const context = mutationContext(req, normalized.data.creatorId, normalized.scriptId, "save", true, db);
  if (req.body?.serverId && !context.expectedUpdatedAt) throw Object.assign(new Error("Reload the server script before saving"), {code:"MESSAGE_LIBRARY_REVISION_REQUIRED",status:428});
  return withMessageLibraryMutation({ ...context, work: async ({ tx, existing, now }) => {
    if (existing && isTrash(existing)) throw Object.assign(new Error("Restore the script before saving"), { code: "MESSAGE_LIBRARY_SCRIPT_TRASHED", status: 409 });
    if (normalized.data.deletedAt) throw Object.assign(new Error("Use the trash action"), { code: "MESSAGE_LIBRARY_TYPED_TRASH_REQUIRED", status: 409 });
    if (existing && !context.expectedUpdatedAt) throw Object.assign(new Error("Reload the server script before saving"), {code:"MESSAGE_LIBRARY_REVISION_REQUIRED",status:428});
    if (req.body?.serverId && req.body.serverId !== existing?.id) throw Object.assign(new Error("Server script identity changed; reload before saving"), {code:"MESSAGE_LIBRARY_REVISION_CONFLICT",status:409});
    for(let offset=0;offset<mediaIds.length;offset+=200){
      const proof=await preflightProgrammaticCustomMedia({agencyId:req.auth.agencyId,member:req.auth.membership||req.member,creatorId:normalized.data.creatorId,mediaIds:mediaIds.slice(offset,offset+200),db:tx});
      if(!proof?.ok || !Array.isArray(proof.customMediaIds) || proof.customMediaIds.length) throw Object.assign(new Error("Reusable media provenance changed; reload"), {code:"MESSAGE_LIBRARY_MEDIA_PROVENANCE_CHANGED",status:409});
    }
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
    const trashAt = now;
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

    await upsertMessageLibraryBlocks({ tx, collectionId: collection.id, blocks: normalized.blocks, now });

    return tx.contentCollection.findFirst({
      where: { id: collection.id, agencyId: req.auth.agencyId },
      include: { blocks: { where: { deletedAt: null, status: { notIn: ["trash","deleted"] } }, orderBy: [{ order: "asc" }, { id: "asc" }], take: 501 } },
    });
  } });
}

router.get("/message-library/scripts", async (req, res) => {
  try {
    const creatorId = await requireMessageLibraryCreator(req);
    // Reads never perform destructive maintenance; the scheduler drains durable trash.
    const includeTrash = req.query.includeTrash === "true" || req.query.includeTrash === "1";
    const where = {
      agencyId: req.auth.agencyId,
      kind: MESSAGE_LIBRARY_KIND,
      status: { not: "deleting" },
    };
    if (!includeTrash) { where.deletedAt = null; where.status = { notIn: ["trash","deleted","deleting"] }; }
    if (creatorId) where.creatorId = creatorId;

    const take = parseLimit(req.query.limit, 500, 1000);
    const skip = parseOffset(req.query.offset);
    const [items, count] = await Promise.all([
      prisma.contentCollection.findMany({
        where,
        include: { blocks: { orderBy: [{ order: "asc" }, { createdAt: "asc" }, { id: "asc" }] } },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
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

router.get("/message-library/scripts/:id", async (req, res) => {
  try {
    const creatorId = await requireMessageLibraryCreator(req);
    const scriptId = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!scriptId || scriptId.length > 120) {
      return res.status(400).json({ ok: false, code: "MESSAGE_LIBRARY_SCRIPT_ID_INVALID", error: "A valid script identity is required" });
    }
    const item = await prisma.contentCollection.findFirst({
      where: {
        agencyId: req.auth.agencyId, creatorId, kind: MESSAGE_LIBRARY_KIND,
        deletedAt: null, status: { notIn: ["trash", "deleted", "deleting"] },
        OR: [{ clientId: scriptId }, { id: scriptId, clientId: null }],
      },
      include: { blocks: {
        where: { deletedAt: null, status: { notIn: ["trash", "deleted"] } },
        orderBy: [{ order: "asc" }, { id: "asc" }], take: 501,
      } },
    });
    if (!item) return res.status(404).json({ ok: false, code: "MESSAGE_LIBRARY_SCRIPT_NOT_FOUND", error: "Script not found" });
    if (item.blocks.length > 500) return res.status(413).json({ ok: false, code: "MESSAGE_LIBRARY_SCRIPT_LIMIT", error: "Script has more than 500 active messages" });
    return res.json({ ok: true, source: "server", creatorId, item: scriptFromCollection(item) });
  } catch (err) {
    return sendError(res, err, "MESSAGE_LIBRARY_SCRIPT_FAILED");
  }
});

function mutationUpgradeRequired(_req, res) {
  return res.status(410).json({ ok: false, code: "MESSAGE_LIBRARY_COMMAND_V3_REQUIRED", error: "Update Desktop to use recoverable Message Library commands" });
}
router.post("/message-library/scripts", mutationUpgradeRequired);
router.put("/message-library/scripts/:id", mutationUpgradeRequired);
router.delete("/message-library/scripts/:id", mutationUpgradeRequired);
router.post("/message-library/scripts/:id/restore", mutationUpgradeRequired);
router.delete("/message-library/scripts/:id/permanent", mutationUpgradeRequired);
router.delete("/message-library/scripts/:scriptId/messages/:messageId", mutationUpgradeRequired);
router.post("/message-library/scripts/:scriptId/messages/:messageId/restore", mutationUpgradeRequired);
function messageLibraryCommandRoute(cancel) {
  return async (req, res) => {
    try {
      const result = await executeMessageLibraryCommand({
        db: prisma, agencyId: req.auth?.agencyId, userId: req.auth?.userId, actorMember: req.auth?.membership || req.member,
        input: req.body, cancel, projectScript: scriptFromCollection, projectBlock: messageFromBlock,
        saveScript: (body, db) => upsertMessageLibraryScript({ ...req, body }, db),
      });
      return res.json(result);
    } catch (error) {
      if (error?.issues) return res.status(400).json({ ok: false, code: "MESSAGE_LIBRARY_COMMAND_INVALID", error: "Invalid command" });
      return res.status(Number(error?.status) || 500).json({ ok: false, code: error?.code || "MESSAGE_LIBRARY_COMMAND_FAILED", error: Number(error?.status) < 500 ? error.message : "Message Library command failed" });
    }
  };
}
router.post("/message-library/commands/v3", messageLibraryCommandRoute(false));
router.post("/message-library/commands/v3/cancel", messageLibraryCommandRoute(true));

router.post("/message-library/purge-expired", async (req, res) => {
  try {
    await assertMessageLibraryManager(req);
    const creatorId = await requireMessageLibraryCreator(req);
    const result = await runMessageLibraryTrashMaintenance({ db: prisma, agencyId: req.auth.agencyId, creatorId, actorMember: req.auth.membership || req.member, userId: req.auth.userId });
    return res.json({ ...result, creatorId });
  } catch (err) {
    return sendError(res, err, "MESSAGE_LIBRARY_PURGE_EXPIRED_FAILED");
  }
});

router.get("/message-library/usage", async (req, res) => {
  try {
    const creatorId = await requireMessageLibraryCreator(req);
    const events = await prisma.$queryRawUnsafe(`
      SELECT e.* FROM "ContentUsageEvent" e LEFT JOIN "ContentCollection" c ON c."id"=e."collectionId" AND c."agencyId"=e."agencyId" AND c."creatorId"=e."creatorId"
      WHERE e."agencyId"=$1 AND e."creatorId"=$2 AND (c."kind"=$3 OR e."metadata"->>'product'=$3)
      ORDER BY e."createdAt" DESC,e."id" DESC LIMIT $4 OFFSET $5`,
      req.auth.agencyId, creatorId, MESSAGE_LIBRARY_KIND, parseLimit(req.query.limit,500,2000), parseOffset(req.query.offset));
    return res.json({ ok: true, source: "server", creatorId, events, count: events.length });
  } catch (err) {
    return sendError(res, err, "MESSAGE_LIBRARY_USAGE_LIST_FAILED");
  }
});

// The old write URL cannot silently accept clients without a stable intent ID.
router.post("/message-library/usage", (_req, res) => res.status(410).json({
  ok: false, code: "MESSAGE_LIBRARY_USAGE_CLIENT_UPDATE_REQUIRED", error: "Update Desktop to record usage events",
}));

router.post("/message-library/usage/v2", async (req, res) => {
  try {
    const command = normalizeUsageInput(req.body);
    await requireProductCreator(req, command.creatorId, { db: prisma });
    const result = await recordMessageLibraryUsage({
      db: prisma, agencyId: req.auth.agencyId, userId: req.auth.userId,
      actorMember: req.auth.membership || req.member, input: req.body,
    });
    return res.status(result.replayed ? 200 : 201).json({ ok: true, source: "server", ...result });
  } catch (err) {
    return sendError(res, err, "MESSAGE_LIBRARY_USAGE_EVENT_FAILED");
  }
});

module.exports = router;

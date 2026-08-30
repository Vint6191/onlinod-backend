"use strict";

const express = require("express");
const prisma = require("../prisma");
const {
  cleanString,
  optionalString,
  jsonArray,
  jsonObject,
  parseLimit,
  parseOffset,
  requireCreator,
  sendError,
} = require("../services/server-store-utils");

const router = express.Router();

const SERVER_CRM_PRODUCT_STATUS = "SERVER_CRM_ISOLATED";

// This route is an explicitly isolated server/admin CRM product surface. It may
// store CRM knowledge, but it is not a writer for canonical OnlyFans platform
// identity, relationship or fan-value projections. Desktop local CRM has no
// implicit sync contract with this surface.
router.use((req, res, next) => {
  res.setHeader("X-ONLINOD-CRM-SURFACE", SERVER_CRM_PRODUCT_STATUS);
  next();
});

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function normalizeProfileInput(body = {}, req) {
  const fanId = cleanString(body.fanId || body.userId || body.remoteId, 80);
  if (!fanId) {
    const err = new Error("fanId is required");
    err.status = 400;
    err.code = "FAN_ID_MISSING";
    throw err;
  }

  return {
    agencyId: req.auth.agencyId,
    creatorId: cleanString(body.creatorId, 100),
    fanId,
    dialogId: cleanString(body.dialogId || body.dialog_id || "", 80),
    username: optionalString(body.username, 120),
    name: optionalString(body.name, 180),
    preferredName: optionalString(body.preferredName || body.preferred_address || body.nickname, 180),
    age: optionalString(body.age, 40),
    location: optionalString(body.location, 240),
    country: optionalString(body.country, 120),
    city: optionalString(body.city, 120),
    timezone: optionalString(body.timezone || body.tz, 80),
    nativeLanguage: optionalString(body.nativeLanguage || body.native_language, 80),
    chatLanguage: optionalString(body.chatLanguage || body.chat_language, 80),
    profession: optionalString(body.profession, 160),
    spenderTier: optionalString(body.spenderTier || body.spender_tier, 80),
    stage: optionalString(body.stage, 80),
    fanRole: optionalString(body.fanRole || body.fan_role, 80),
    controlPreference: optionalString(body.controlPreference || body.control || body.control_preference, 120),
    creatorRole: optionalString(body.creatorRole || body.creator_role, 80),
    tone: optionalString(body.tone, 120),
    dynamicSummary: optionalString(body.dynamicSummary || body.dynamic_summary, 2000),
    aiSummary: optionalString(body.aiSummary || body.ai_summary || body.summary, 3000),
    info: jsonObject(body.info),
    ppvStats: jsonObject(body.ppvStats || body.ppv_stats),
    messageStats: jsonObject(body.messageStats || body.message_stats),
    source: cleanString(body.source || "electron", 60) || "electron",
    analyzedAt: parseDate(body.analyzedAt || body.analyzed_at) || new Date(),
  };
}

function normalizeTag(tag = {}, req, profileId) {
  const tagKey = cleanString(tag.tagKey || tag.key || tag.id || tag.label, 120);
  if (!tagKey) return null;
  return {
    agencyId: req.auth.agencyId,
    profileId,
    tagKey,
    label: cleanString(tag.label || tag.name || tagKey, 160) || tagKey,
    kind: cleanString(tag.kind || tag.type || "fetish", 60) || "fetish",
    category: optionalString(tag.category, 120),
    facets: jsonArray(tag.facets),
    intensity: optionalString(tag.intensity, 80),
    nicheLevel: optionalString(tag.nicheLevel || tag.niche_level, 80),
    broadcastPolicy: optionalString(tag.broadcastPolicy || tag.broadcast_policy, 80),
    confidence: Number.isFinite(Number(tag.confidence)) ? Number(tag.confidence) : null,
    source: cleanString(tag.source || "ai", 60) || "ai",
    negative: tag.negative === true,
    metadata: jsonObject(tag.metadata),
  };
}

function normalizeRawTag(raw = {}, req, profileId) {
  const rawLabel = cleanString(raw.rawLabel || raw.raw || raw.label || raw.text, 180);
  if (!rawLabel) return null;
  return {
    agencyId: req.auth.agencyId,
    profileId,
    rawLabel,
    mappedKey: optionalString(raw.mappedKey || raw.mapped_key || raw.tagKey, 120),
    kind: optionalString(raw.kind || raw.type, 60),
    status: cleanString(raw.status || "needs_review", 60) || "needs_review",
    confidence: Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : null,
    metadata: jsonObject(raw.metadata),
  };
}

async function includeProfile(id) {
  return prisma.crmProfile.findUnique({
    where: { id },
    include: {
      tags: { orderBy: [{ kind: "asc" }, { label: "asc" }] },
      rawTags: { orderBy: { createdAt: "desc" }, take: 100 },
      notes: { where: { deletedAt: null }, orderBy: { createdAt: "desc" }, take: 100 },
    },
  });
}

router.get("/profiles", async (req, res) => {
  try {
    const where = { agencyId: req.auth.agencyId };
    const creatorId = cleanString(req.query.creatorId, 100);
    const q = cleanString(req.query.q, 120);
    if (creatorId) where.creatorId = creatorId;
    for (const [param, field] of [
      ["country", "country"], ["city", "city"], ["nativeLanguage", "nativeLanguage"],
      ["chatLanguage", "chatLanguage"], ["fanRole", "fanRole"], ["creatorRole", "creatorRole"],
    ]) {
      const v = cleanString(req.query[param], 120);
      if (v) where[field] = v;
    }
    if (q) {
      where.OR = [
        { fanId: { contains: q, mode: "insensitive" } },
        { dialogId: { contains: q, mode: "insensitive" } },
        { username: { contains: q, mode: "insensitive" } },
        { name: { contains: q, mode: "insensitive" } },
        { city: { contains: q, mode: "insensitive" } },
        { country: { contains: q, mode: "insensitive" } },
      ];
    }

    const tagKeys = String(req.query.tagKeys || "").split(",").map((x) => cleanString(x, 120)).filter(Boolean);
    if (tagKeys.length) {
      where.tags = { some: { tagKey: { in: tagKeys }, negative: false } };
    }

    const take = parseLimit(req.query.limit, 100, 500);
    const skip = parseOffset(req.query.offset);
    const [items, count] = await Promise.all([
      prisma.crmProfile.findMany({
        where,
        include: { tags: { take: 25, orderBy: [{ kind: "asc" }, { label: "asc" }] } },
        orderBy: { updatedAt: "desc" },
        take,
        skip,
      }),
      prisma.crmProfile.count({ where }),
    ]);
    return res.json({ ok: true, productStatus: SERVER_CRM_PRODUCT_STATUS, items, count, nextOffset: skip + items.length, hasMore: skip + items.length < count });
  } catch (err) {
    return sendError(res, err, "CRM_PROFILES_FAILED");
  }
});

router.get("/profiles/:id", async (req, res) => {
  try {
    const profile = await prisma.crmProfile.findFirst({
      where: { id: req.params.id, agencyId: req.auth.agencyId },
      include: { tags: true, rawTags: true, notes: { where: { deletedAt: null }, orderBy: { createdAt: "desc" } }, runs: { orderBy: { createdAt: "desc" }, take: 20 } },
    });
    if (!profile) return res.status(404).json({ ok: false, code: "CRM_PROFILE_NOT_FOUND", error: "CRM profile not found" });
    return res.json({ ok: true, productStatus: SERVER_CRM_PRODUCT_STATUS, profile });
  } catch (err) {
    return sendError(res, err, "CRM_PROFILE_FAILED");
  }
});

router.post("/profiles/upsert", async (req, res) => {
  try {
    const input = normalizeProfileInput(req.body || {}, req);
    await requireCreator(prisma, req.auth.agencyId, input.creatorId);

    const profile = await prisma.crmProfile.upsert({
      where: { creatorId_fanId: { creatorId: input.creatorId, fanId: input.fanId } },
      create: input,
      update: { ...input, agencyId: undefined, creatorId: undefined, fanId: undefined },
    });

    if (Array.isArray(req.body?.tags)) {
      await prisma.crmProfileTag.deleteMany({ where: { profileId: profile.id } });
      const tags = req.body.tags.map((tag) => normalizeTag(tag, req, profile.id)).filter(Boolean);
      if (tags.length) await prisma.crmProfileTag.createMany({ data: tags, skipDuplicates: true });
    }

    if (Array.isArray(req.body?.rawTags)) {
      await prisma.crmProfileRawTag.deleteMany({ where: { profileId: profile.id } });
      const rawTags = req.body.rawTags.map((raw) => normalizeRawTag(raw, req, profile.id)).filter(Boolean);
      if (rawTags.length) await prisma.crmProfileRawTag.createMany({ data: rawTags });
    }

    if (Array.isArray(req.body?.notes)) {
      await prisma.crmNote.deleteMany({ where: { profileId: profile.id, kind: { in: ["auto", "summary"] } } });
      const notes = req.body.notes.map((note) => ({
        agencyId: req.auth.agencyId,
        creatorId: input.creatorId,
        profileId: profile.id,
        kind: cleanString(note.kind || "auto", 40) || "auto",
        text: cleanString(note.text || note, 3000),
        metadata: jsonObject(note.metadata),
        createdByUserId: req.auth.userId,
      })).filter((x) => x.text);
      if (notes.length) await prisma.crmNote.createMany({ data: notes });
    }

    if (req.body?.analysis) {
      await prisma.crmAnalysisRun.create({
        data: {
          agencyId: req.auth.agencyId,
          creatorId: input.creatorId,
          profileId: profile.id,
          dialogId: input.dialogId || null,
          fanId: input.fanId,
          status: cleanString(req.body.analysis.status || "done", 40) || "done",
          model: optionalString(req.body.analysis.model, 120),
          promptVersion: optionalString(req.body.analysis.promptVersion || req.body.analysis.prompt_version, 120),
          analysis: jsonObject(req.body.analysis.data || req.body.analysis),
          error: optionalString(req.body.analysis.error, 2000),
          startedAt: parseDate(req.body.analysis.startedAt),
          completedAt: parseDate(req.body.analysis.completedAt) || new Date(),
          createdByUserId: req.auth.userId,
        },
      });
    }

    return res.json({ ok: true, profile: await includeProfile(profile.id) });
  } catch (err) {
    return sendError(res, err, "CRM_PROFILE_UPSERT_FAILED");
  }
});

router.post("/profiles/:id/notes", async (req, res) => {
  try {
    const profile = await prisma.crmProfile.findFirst({ where: { id: req.params.id, agencyId: req.auth.agencyId } });
    if (!profile) return res.status(404).json({ ok: false, code: "CRM_PROFILE_NOT_FOUND", error: "CRM profile not found" });
    const note = await prisma.crmNote.create({
      data: {
        agencyId: req.auth.agencyId,
        creatorId: profile.creatorId,
        profileId: profile.id,
        kind: cleanString(req.body?.kind || "manual", 40) || "manual",
        text: cleanString(req.body?.text, 3000),
        metadata: jsonObject(req.body?.metadata),
        createdByUserId: req.auth.userId,
      },
    });
    return res.status(201).json({ ok: true, note });
  } catch (err) {
    return sendError(res, err, "CRM_NOTE_CREATE_FAILED");
  }
});

router.get("/filter-options", async (req, res) => {
  try {
    const agencyId = req.auth.agencyId;
    const creatorId = cleanString(req.query.creatorId, 100);
    const profileWhere = { agencyId, ...(creatorId ? { creatorId } : {}) };
    const tagWhere = { agencyId, ...(creatorId ? { profile: { creatorId } } : {}) };
    const [profiles, tags] = await Promise.all([
      prisma.crmProfile.findMany({ where: profileWhere, select: { country: true, city: true, nativeLanguage: true, chatLanguage: true, fanRole: true, creatorRole: true, tone: true } , take: 10000}),
      prisma.crmProfileTag.findMany({ where: tagWhere, select: { tagKey: true, label: true, kind: true, category: true, nicheLevel: true, broadcastPolicy: true } , take: 10000}),
    ]);
    const counts = (items, key) => {
      const m = new Map();
      for (const it of items) {
        const v = cleanString(it?.[key], 120);
        if (v) m.set(v, (m.get(v) || 0) + 1);
      }
      return Array.from(m.entries()).map(([value, count]) => ({ key: value, label: value, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    };
    const tagMap = new Map();
    for (const t of tags) {
      const key = cleanString(t.tagKey, 120);
      if (!key) continue;
      const prev = tagMap.get(key) || { key, label: t.label || key, count: 0, kind: t.kind, category: t.category, nicheLevel: t.nicheLevel, broadcastPolicy: t.broadcastPolicy };
      prev.count += 1;
      tagMap.set(key, prev);
    }
    return res.json({
      ok: true,
      totalProfiles: await prisma.crmProfile.count({ where: profileWhere }),
      countries: counts(profiles, "country"),
      cities: counts(profiles, "city"),
      nativeLanguages: counts(profiles, "nativeLanguage"),
      chatLanguages: counts(profiles, "chatLanguage"),
      fanRoles: counts(profiles, "fanRole"),
      creatorRoles: counts(profiles, "creatorRole"),
      tones: counts(profiles, "tone"),
      tags: Array.from(tagMap.values()).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    });
  } catch (err) {
    return sendError(res, err, "CRM_FILTER_OPTIONS_FAILED");
  }
});

module.exports = router;

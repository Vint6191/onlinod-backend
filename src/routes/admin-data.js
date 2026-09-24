/* src/routes/admin-data.js — Onlinod admin "deep data" surface
   ────────────────────────────────────────────────────────────
   Admin tools to inspect / search data and issue typed archive commands
   across all agencies and creators. Mounted at /api/admin/data and
   protected by the same adminRequired guard as admin.js.

   Read:
     GET  /data/creator/:id/overview        — everything about one creator
     GET  /data/crm-profiles                — ?agencyId&creatorId&q&fanId&limit&offset
     GET  /data/crm-profiles/:id            — single profile + tags + notes + rawTags
     GET  /data/crm-tags                    — ?agencyId&creatorId&profileId&kind&q
     GET  /data/crm-notes                   — ?creatorId&profileId
     GET  /data/deliveries                  — ?agencyId&creatorId&status&fanId
     GET  /data/bump-stats                  — ?creatorId&from&to (reply-rate aggregate)
     GET  /data/hidden-online               — ?creatorId&status&q
     GET  /data/follow-back                 — ?creatorId&status&q
     GET  /data/vault-sales                 — ?creatorId&status
     GET  /data/vault-purchases             — ?creatorId
     GET  /data/money                       — ?agencyId&creatorId (MoneyAttribution)
     GET  /data/content                     — ?agencyId&creatorId&kind (collections)
     GET  /data/inspect/:model/:id          — raw record of any whitelisted model

   Search:
     GET  /data/search                      — ?q  (global: fan, username, messageId, creator, agency)

   Health / typed archive:
     GET  /data/anomalies                   — duplicate deliveries, stuck bumps, orphans, etc.
     POST /data/creators/:id/archive-deliveries — explicit bounded selection
     Legacy generic delete / bulk-delete / purge-deliveries return 410.
   ──────────────────────────────────────────────────────────── */

"use strict";

const express = require("express");
const prisma = require("../prisma");
const { adminRequired } = require("../middleware/admin");
const { adminHttpAuditMiddleware } = require("../middleware/admin-audit");
const { listHiddenOnline } = require("../services/subscriber-directory-service");
const { listFollowBack } = require("../services/follow-back-service");
const { archiveDeliveriesHandler, contentLifecycleHandler } = require("./admin-command-handlers");

const router = require("./admin-router").createAdminRouter();
router.use(adminRequired);
router.use(require("../middleware/admin-read-boundary").adminReadBoundary);
router.use(adminHttpAuditMiddleware);

// ── helpers ───────────────────────────────────────────────────
function clamp(n, lo, hi, dflt) {
  const x = Number(n);
  if (!Number.isFinite(x)) return dflt;
  return Math.max(lo, Math.min(hi, Math.floor(x)));
}
function limitOf(q) { return clamp(q.limit, 1, 500, 100); }
function offsetOf(q) { return Math.max(0, clamp(q.offset, 0, 10_000_000, 0)); }
function str(v) { const s = String(v ?? "").trim(); return s || null; }

async function resolveCreatorScope(creatorId, agencyId = null) {
  const id = str(creatorId);
  if (!id) {
    const error = new Error("creatorId is required for canonical current views");
    error.status = 400; error.code = "CREATOR_ID_REQUIRED"; throw error;
  }
  const creator = await prisma.creatorAccount.findUnique({ where: { id }, select: { id: true, agencyId: true } });
  if (!creator || (agencyId && creator.agencyId !== agencyId)) {
    const error = new Error("Creator not found in requested scope");
    error.status = 404; error.code = "CREATOR_NOT_FOUND"; throw error;
  }
  return creator;
}

function sendErr(res, err, code = "ADMIN_DATA_FAILED") {
  const status = Number(err?.status || 500) || 500;
  return res.status(status).json({ ok: false, code: err?.code || code, error: String(err?.message || "Failed") });
}

// Whitelist for inspection only. Mutations belong to typed domain commands.
const MODELS = {
  crmProfile:         { d: () => prisma.crmProfile,         soft: false },
  crmProfileTag:      { d: () => prisma.crmProfileTag,      soft: false },
  crmProfileRawTag:   { d: () => prisma.crmProfileRawTag,   soft: false },
  crmNote:            { d: () => prisma.crmNote,            soft: true  },
  crmAnalysisRun:     { d: () => prisma.crmAnalysisRun,     soft: false },
  automationDelivery: { d: () => prisma.automationDelivery, soft: false, deleteProtected: true },
  bumpDeliveryStat:   { d: () => prisma.bumpDeliveryStat,   soft: false },
  hiddenOnlineUser:   { d: () => prisma.hiddenOnlineUser,   soft: false, deleteProtected: true },
  followBackTask:     { d: () => prisma.followBackTask,     soft: false, deleteProtected: true },
  vaultMediaSale:     { d: () => prisma.vaultMediaSale,     soft: false },
  vaultPurchaseMessage:{d: () => prisma.vaultPurchaseMessage,soft: false },
  moneyAttribution:   { d: () => prisma.moneyAttribution,   soft: false },
  contentCollection:  { d: () => prisma.contentCollection,  soft: true  },
  fanList:            { d: () => prisma.fanList,            soft: true  },
  savedSegment:       { d: () => prisma.savedSegment,       soft: true  },
  campaignDraft:      { d: () => prisma.campaignDraft,      soft: true  },
};

// ════════════════════════════════════════════════════════════════
// READ — per entity (all support agency/creator filters + pagination)
// ════════════════════════════════════════════════════════════════

router.get("/crm-profiles", async (req, res) => {
  try {
    const where = {};
    if (str(req.query.agencyId)) where.agencyId = str(req.query.agencyId);
    if (str(req.query.creatorId)) where.creatorId = str(req.query.creatorId);
    if (str(req.query.fanId)) where.fanId = str(req.query.fanId);
    const q = str(req.query.q);
    if (q) where.OR = [
      { username: { contains: q, mode: "insensitive" } },
      { name: { contains: q, mode: "insensitive" } },
      { fanId: { contains: q } },
    ];
    const [items, total] = await Promise.all([
      prisma.crmProfile.findMany({
        where, orderBy: { updatedAt: "desc" }, take: limitOf(req.query), skip: offsetOf(req.query),
        include: { _count: { select: { tags: true, notes: true, rawTags: true } } },
      }),
      prisma.crmProfile.count({ where }),
    ]);
    return res.json({ ok: true, total, items });
  } catch (err) { return sendErr(res, err); }
});

router.get("/crm-profiles/:id", async (req, res) => {
  try {
    const profile = await prisma.crmProfile.findUnique({
      where: { id: req.params.id },
      include: {
        tags: { orderBy: { createdAt: "desc" } },
        rawTags: { orderBy: { createdAt: "desc" } },
        notes: { where: { deletedAt: null }, orderBy: { createdAt: "desc" } },
        runs: { orderBy: { createdAt: "desc" }, take: 10 },
      },
    });
    if (!profile) return res.status(404).json({ ok: false, code: "NOT_FOUND" });
    return res.json({ ok: true, profile });
  } catch (err) { return sendErr(res, err); }
});

router.get("/crm-tags", async (req, res) => {
  try {
    const where = {};
    if (str(req.query.agencyId)) where.agencyId = str(req.query.agencyId);
    if (str(req.query.profileId)) where.profileId = str(req.query.profileId);
    if (str(req.query.kind)) where.kind = str(req.query.kind);
    const q = str(req.query.q);
    if (q) where.OR = [{ label: { contains: q, mode: "insensitive" } }, { tagKey: { contains: q, mode: "insensitive" } }];
    const [items, total] = await Promise.all([
      prisma.crmProfileTag.findMany({ where, orderBy: { createdAt: "desc" }, take: limitOf(req.query), skip: offsetOf(req.query) }),
      prisma.crmProfileTag.count({ where }),
    ]);
    return res.json({ ok: true, total, items });
  } catch (err) { return sendErr(res, err); }
});

router.get("/crm-notes", async (req, res) => {
  try {
    const where = { deletedAt: null };
    if (str(req.query.creatorId)) where.creatorId = str(req.query.creatorId);
    if (str(req.query.profileId)) where.profileId = str(req.query.profileId);
    const items = await prisma.crmNote.findMany({ where, orderBy: { createdAt: "desc" }, take: limitOf(req.query), skip: offsetOf(req.query) });
    return res.json({ ok: true, items });
  } catch (err) { return sendErr(res, err); }
});

router.get("/deliveries", async (req, res) => {
  try {
    const where = {};
    if (str(req.query.agencyId)) where.agencyId = str(req.query.agencyId);
    if (str(req.query.creatorId)) where.creatorId = str(req.query.creatorId);
    if (str(req.query.status)) where.status = str(req.query.status);
    if (str(req.query.fanId)) where.fanId = str(req.query.fanId);
    const [items, total, byStatus] = await Promise.all([
      prisma.automationDelivery.findMany({ where, orderBy: { createdAt: "desc" }, take: limitOf(req.query), skip: offsetOf(req.query) }),
      prisma.automationDelivery.count({ where }),
      prisma.automationDelivery.groupBy({ by: ["status"], where, _count: { _all: true } }),
    ]);
    const statusCounts = {};
    for (const r of byStatus) statusCounts[r.status] = r._count._all;
    return res.json({ ok: true, total, statusCounts, items });
  } catch (err) { return sendErr(res, err); }
});

router.get("/bump-stats", async (req, res) => {
  try {
    const where = {};
    if (str(req.query.agencyId)) where.agencyId = str(req.query.agencyId);
    if (str(req.query.creatorId)) where.creatorId = str(req.query.creatorId);
    if (str(req.query.from) || str(req.query.to)) {
      where.day = {};
      if (str(req.query.from)) where.day.gte = str(req.query.from);
      if (str(req.query.to)) where.day.lte = str(req.query.to);
    }
    const rows = await prisma.bumpDeliveryStat.findMany({ where, orderBy: { day: "desc" }, take: limitOf(req.query) });
    const totals = { sent: 0, replied: 0, canceled: 0, expired: 0, failed: 0 };
    const byTemplate = {};
    for (const r of rows) {
      for (const k of ["sent", "replied", "canceled", "expired", "failed"]) totals[k] += r[k] || 0;
      const t = r.templateId || "";
      if (!byTemplate[t]) byTemplate[t] = { templateId: t, sent: 0, replied: 0, canceled: 0, expired: 0, failed: 0 };
      for (const k of ["sent", "replied", "canceled", "expired", "failed"]) byTemplate[t][k] += r[k] || 0;
    }
    const rate = (rep, sent) => (sent > 0 ? Math.round((rep / sent) * 10000) / 100 : 0);
    totals.replyRate = rate(totals.replied, totals.sent);
    const perTemplate = Object.values(byTemplate).map((t) => ({ ...t, replyRate: rate(t.replied, t.sent) })).sort((a, b) => b.replyRate - a.replyRate);
    return res.json({ ok: true, totals, perTemplate, days: rows });
  } catch (err) { return sendErr(res, err); }
});

router.get("/hidden-online", async (req, res) => {
  try {
    const scope = await resolveCreatorScope(req.query.creatorId, str(req.query.agencyId));
    const result = await listHiddenOnline({
      agencyId: scope.agencyId, creatorId: scope.id, status: str(req.query.status) || "all", search: str(req.query.q) || "",
      limit: limitOf(req.query), offset: offsetOf(req.query), sort: str(req.query.sort) || "recent",
    });
    return res.json({ ok: true, authority: "canonical_current", total: result.count || 0, items: result.items || [] });
  } catch (err) { return sendErr(res, err); }
});

router.get("/follow-back", async (req, res) => {
  try {
    const scope = await resolveCreatorScope(req.query.creatorId, str(req.query.agencyId));
    const rawStatus = str(req.query.status);
    const state = rawStatus && rawStatus.toLowerCase() !== "all" ? rawStatus.toUpperCase() : null;
    const result = await listFollowBack({
      agencyId: scope.agencyId, creatorId: scope.id, state, search: str(req.query.q) || "",
      limit: limitOf(req.query), offset: offsetOf(req.query),
    });
    return res.json({ ok: true, authority: "canonical_current", total: result.count || 0, items: result.items || [], metrics: result.metrics || null });
  } catch (err) { return sendErr(res, err); }
});

router.get("/vault-sales", async (req, res) => {
  try {
    const where = {};
    if (str(req.query.creatorId)) where.creatorId = str(req.query.creatorId);
    if (str(req.query.agencyId)) where.agencyId = str(req.query.agencyId);
    if (str(req.query.status)) where.status = str(req.query.status);
    const [items, total] = await Promise.all([
      prisma.vaultMediaSale.findMany({ where, orderBy: { createdAt: "desc" }, take: limitOf(req.query), skip: offsetOf(req.query) }),
      prisma.vaultMediaSale.count({ where }),
    ]);
    return res.json({ ok: true, total, items });
  } catch (err) { return sendErr(res, err); }
});

router.get("/vault-purchases", async (req, res) => {
  try {
    const where = {};
    if (str(req.query.creatorId)) where.creatorId = str(req.query.creatorId);
    if (str(req.query.agencyId)) where.agencyId = str(req.query.agencyId);
    const [items, total] = await Promise.all([
      prisma.vaultPurchaseMessage.findMany({ where, orderBy: { createdAt: "desc" }, take: limitOf(req.query), skip: offsetOf(req.query) }),
      prisma.vaultPurchaseMessage.count({ where }),
    ]);
    return res.json({ ok: true, total, items });
  } catch (err) { return sendErr(res, err); }
});

router.get("/money", async (req, res) => {
  try {
    const where = {};
    if (str(req.query.agencyId)) where.agencyId = str(req.query.agencyId);
    if (str(req.query.creatorId)) where.creatorId = str(req.query.creatorId);
    const [items, total, sum] = await Promise.all([
      prisma.moneyAttribution.findMany({ where, orderBy: { occurredAt: "desc" }, take: limitOf(req.query), skip: offsetOf(req.query) }),
      prisma.moneyAttribution.count({ where }),
      prisma.moneyAttribution.aggregate({ where, _sum: { amountCents: true } }),
    ]);
    return res.json({ ok: true, total, totalCents: sum._sum.amountCents || 0, items });
  } catch (err) { return sendErr(res, err); }
});

router.get("/content", async (req, res) => {
  try {
    const where = req.query.includeTrash === "true" ? {} : { deletedAt: null };
    if (str(req.query.agencyId)) where.agencyId = str(req.query.agencyId);
    if (str(req.query.creatorId)) where.creatorId = str(req.query.creatorId);
    if (str(req.query.kind)) where.kind = str(req.query.kind);
    const items = await prisma.contentCollection.findMany({
      where, orderBy: { updatedAt: "desc" }, take: limitOf(req.query), skip: offsetOf(req.query),
      include: { _count: { select: { blocks: true } } },
    });
    return res.json({ ok: true, items });
  } catch (err) { return sendErr(res, err); }
});

// ════════════════════════════════════════════════════════════════
// CREATOR OVERVIEW — everything about one model in a single call
// ════════════════════════════════════════════════════════════════
router.get("/creator/:id/overview", async (req, res) => {
  try {
    const creatorId = req.params.id;
    const creator = await prisma.creatorAccount.findUnique({
      where: { id: creatorId },
      include: { agency: { select: { id: true, name: true, plan: true } }, billingProfile: true },
    });
    if (!creator) return res.status(404).json({ ok: false, code: "CREATOR_NOT_FOUND" });

    const [
      crmProfiles, crmTags, crmNotes,
      deliveries, deliveriesByStatus,
      vaultSales, vaultPurchases,
      contentCollections, bumpStatRows,
      moneySum,
    ] = await Promise.all([
      prisma.crmProfile.count({ where: { creatorId } }),
      prisma.crmProfileTag.count({ where: { profile: { creatorId } } }),
      prisma.crmNote.count({ where: { creatorId, deletedAt: null } }),
      prisma.automationDelivery.count({ where: { creatorId } }),
      prisma.automationDelivery.groupBy({ by: ["status"], where: { creatorId }, _count: { _all: true } }),
      prisma.vaultMediaSale.count({ where: { creatorId } }),
      prisma.vaultPurchaseMessage.count({ where: { creatorId } }),
      prisma.contentCollection.count({ where: { creatorId, deletedAt: null } }),
      prisma.bumpDeliveryStat.findMany({ where: { creatorId } , take: 10000}),
      prisma.moneyAttribution.aggregate({ where: { creatorId }, _sum: { amountCents: true } }),
    ]);

    const [hiddenCurrent, followBackCurrent] = await Promise.all([
      listHiddenOnline({ agencyId: creator.agencyId, creatorId, status: "all", limit: 1, offset: 0 }),
      listFollowBack({ agencyId: creator.agencyId, creatorId, limit: 1, offset: 0 }),
    ]);
    const hiddenOnline = Number(hiddenCurrent?.count || 0);
    const followBack = Number(followBackCurrent?.count || 0);

    const dStatus = {};
    for (const r of deliveriesByStatus) dStatus[r.status] = r._count._all;

    const bs = { sent: 0, replied: 0, canceled: 0, expired: 0, failed: 0 };
    for (const r of bumpStatRows) for (const k of Object.keys(bs)) bs[k] += r[k] || 0;
    bs.replyRate = bs.sent > 0 ? Math.round((bs.replied / bs.sent) * 10000) / 100 : 0;

    return res.json({
      ok: true,
      creator,
      counts: {
        crmProfiles, crmTags, crmNotes,
        deliveries, deliveriesByStatus: dStatus,
        hiddenOnline, followBack,
        vaultSales, vaultPurchases, contentCollections,
        moneyCents: moneySum._sum.amountCents || 0,
      },
      bumpStats: bs,
    });
  } catch (err) { return sendErr(res, err); }
});

// ════════════════════════════════════════════════════════════════
// GLOBAL SEARCH — one box: fanId / username / messageId / creator / agency
// ════════════════════════════════════════════════════════════════
router.get("/search", async (req, res) => {
  try {
    const q = str(req.query.q);
    if (!q || q.length < 2) return res.json({ ok: true, q, results: {} });
    const ci = { contains: q, mode: "insensitive" };
    const take = 15;

    const [agencies, creators, users, crmProfiles, hidden, deliveriesByMsg] = await Promise.all([
      prisma.agency.findMany({ where: { OR: [{ name: ci }, { id: q }] }, take, select: { id: true, name: true, plan: true, status: true } }),
      prisma.creatorAccount.findMany({ where: { OR: [{ displayName: ci }, { username: ci }, { id: q }, { remoteId: q }] }, take, select: { id: true, displayName: true, username: true, agencyId: true, status: true } }),
      prisma.user.findMany({ where: { OR: [{ email: ci }, { name: ci }, { id: q }] }, take, select: { id: true, email: true, name: true } }),
      prisma.crmProfile.findMany({ where: { OR: [{ fanId: q }, { username: ci }, { name: ci }] }, take, select: { id: true, fanId: true, username: true, name: true, creatorId: true, agencyId: true } }),
      // Hidden status is canonical current authority, not a historical fuzzy-search
      // table. Exact fanId lookup stays index-backed across creators; username search
      // belongs to canonical fan identity/CRM surfaces above.
      prisma.hiddenOnlineUser.findMany({ where: { fanId: q }, take, select: { id: true, fanId: true, username: true, creatorId: true, status: true } }),
      prisma.automationDelivery.findMany({ where: { OR: [{ messageId: q }, { fanId: q }] }, take, select: { id: true, fanId: true, messageId: true, status: true, creatorId: true } }),
    ]);

    return res.json({ ok: true, q, results: { agencies, creators, users, crmProfiles, hiddenOnline: hidden, hiddenOnlineHistoricalCompatibility: hidden, deliveries: deliveriesByMsg } });
  } catch (err) { return sendErr(res, err); }
});

// ════════════════════════════════════════════════════════════════
// ANOMALIES — proactive health: clones, stuck bumps, orphans, junk
// ════════════════════════════════════════════════════════════════
router.get("/anomalies", async (req, res) => {
  try {
    return res.json(await require("../services/admin-diagnostics-service").readDiagnostics({ db: prisma }));
  } catch (err) { return sendErr(res, err); }
});

// ════════════════════════════════════════════════════════════════
// INSPECT — raw record of any whitelisted model
// ════════════════════════════════════════════════════════════════
router.get("/inspect/:model/:id", async (req, res) => {
  try {
    const m = MODELS[req.params.model];
    if (!m) return res.status(400).json({ ok: false, code: "MODEL_NOT_ALLOWED", error: `Unknown model: ${req.params.model}` });
    const record = await m.d().findUnique({ where: { id: req.params.id } });
    if (!record) return res.status(404).json({ ok: false, code: "NOT_FOUND" });
    return res.json({ ok: true, model: req.params.model, record });
  } catch (err) { return sendErr(res, err); }
});

// ════════════════════════════════════════════════════════════════
// DELETE — single record (soft if supported & ?hard not set)
// ════════════════════════════════════════════════════════════════
function retiredMutation(_req, res) {
  return res.status(410).json({ ok: false, code: "ADMIN_DATA_MUTATION_RETIRED", error: "Generic deletion and purge are retired. Use the owning domain; terminal delivery archival requires an explicit creator, selection, cutoff and reason." });
}
router.delete("/record/:model/:id", retiredMutation);
router.post("/bulk-delete", retiredMutation);
router.post("/purge-deliveries", retiredMutation);
router.post("/creators/:id/archive-deliveries", archiveDeliveriesHandler);

router.post("/content/:id/lifecycle", contentLifecycleHandler);

module.exports = router;

/* src/routes/admin-data.js — Onlinod admin "deep data" surface
   ────────────────────────────────────────────────────────────
   Super-admin tools to inspect / search / clean every data entity
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

   Health / cleanup:
     GET  /data/anomalies                   — duplicate deliveries, stuck bumps, orphans, etc.
     DELETE /data/record/:model/:id         — delete one record (?hard=1 for non-soft models)
     POST /data/bulk-delete                 — { model, ids:[] }  bulk delete
     POST /data/purge-deliveries            — { creatorId?, statuses:[], olderThanDays? }
   ──────────────────────────────────────────────────────────── */

"use strict";

const express = require("express");
const prisma = require("../prisma");
const { adminRequired } = require("../middleware/admin");
const { adminHttpAuditMiddleware } = require("../middleware/admin-audit");

const router = express.Router();
router.use(adminRequired);
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

async function adminLog(req, data) {
  try { await prisma.adminActionLog.create({ data: { adminUserId: req.admin.id, ...data } }); }
  catch (err) { console.warn("[adminData.log] failed:", err?.message || err); }
}

function sendErr(res, err, code = "ADMIN_DATA_FAILED") {
  const status = Number(err?.status || 500) || 500;
  return res.status(status).json({ ok: false, code: err?.code || code, error: String(err?.message || "Failed") });
}

// Whitelist of models the generic inspect/delete can touch, mapped to the
// prisma delegate + whether they support soft-delete (deletedAt).
const MODELS = {
  crmProfile:         { d: () => prisma.crmProfile,         soft: false },
  crmProfileTag:      { d: () => prisma.crmProfileTag,      soft: false },
  crmProfileRawTag:   { d: () => prisma.crmProfileRawTag,   soft: false },
  crmNote:            { d: () => prisma.crmNote,            soft: true  },
  crmAnalysisRun:     { d: () => prisma.crmAnalysisRun,     soft: false },
  automationDelivery: { d: () => prisma.automationDelivery, soft: false, deleteProtected: true },
  bumpDeliveryStat:   { d: () => prisma.bumpDeliveryStat,   soft: false },
  hiddenOnlineUser:   { d: () => prisma.hiddenOnlineUser,   soft: false },
  followBackTask:     { d: () => prisma.followBackTask,     soft: false },
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
    const where = {};
    if (str(req.query.creatorId)) where.creatorId = str(req.query.creatorId);
    if (str(req.query.agencyId)) where.agencyId = str(req.query.agencyId);
    if (str(req.query.status)) where.status = str(req.query.status);
    const q = str(req.query.q);
    if (q) where.OR = [{ username: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }, { fanId: { contains: q } }];
    const [items, total] = await Promise.all([
      prisma.hiddenOnlineUser.findMany({ where, orderBy: { updatedAt: "desc" }, take: limitOf(req.query), skip: offsetOf(req.query) }),
      prisma.hiddenOnlineUser.count({ where }),
    ]);
    return res.json({ ok: true, total, items });
  } catch (err) { return sendErr(res, err); }
});

router.get("/follow-back", async (req, res) => {
  try {
    const where = {};
    if (str(req.query.creatorId)) where.creatorId = str(req.query.creatorId);
    if (str(req.query.agencyId)) where.agencyId = str(req.query.agencyId);
    if (str(req.query.status)) where.status = str(req.query.status);
    const q = str(req.query.q);
    if (q) where.OR = [{ username: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }, { fanId: { contains: q } }];
    const [items, total] = await Promise.all([
      prisma.followBackTask.findMany({ where, orderBy: { updatedAt: "desc" }, take: limitOf(req.query), skip: offsetOf(req.query) }),
      prisma.followBackTask.count({ where }),
    ]);
    return res.json({ ok: true, total, items });
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
    const where = { deletedAt: null };
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
      hiddenOnline, followBack,
      vaultSales, vaultPurchases,
      contentCollections, bumpStatRows,
      moneySum,
    ] = await Promise.all([
      prisma.crmProfile.count({ where: { creatorId } }),
      prisma.crmProfileTag.count({ where: { profile: { creatorId } } }),
      prisma.crmNote.count({ where: { creatorId, deletedAt: null } }),
      prisma.automationDelivery.count({ where: { creatorId } }),
      prisma.automationDelivery.groupBy({ by: ["status"], where: { creatorId }, _count: { _all: true } }),
      prisma.hiddenOnlineUser.count({ where: { creatorId } }),
      prisma.followBackTask.count({ where: { creatorId } }),
      prisma.vaultMediaSale.count({ where: { creatorId } }),
      prisma.vaultPurchaseMessage.count({ where: { creatorId } }),
      prisma.contentCollection.count({ where: { creatorId, deletedAt: null } }),
      prisma.bumpDeliveryStat.findMany({ where: { creatorId } , take: 10000}),
      prisma.moneyAttribution.aggregate({ where: { creatorId }, _sum: { amountCents: true } }),
    ]);

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
      prisma.hiddenOnlineUser.findMany({ where: { OR: [{ fanId: q }, { username: ci }] }, take, select: { id: true, fanId: true, username: true, creatorId: true, status: true } }),
      prisma.automationDelivery.findMany({ where: { OR: [{ messageId: q }, { fanId: q }] }, take, select: { id: true, fanId: true, messageId: true, status: true, creatorId: true } }),
    ]);

    return res.json({ ok: true, q, results: { agencies, creators, users, crmProfiles, hiddenOnline: hidden, deliveries: deliveriesByMsg } });
  } catch (err) { return sendErr(res, err); }
});

// ════════════════════════════════════════════════════════════════
// ANOMALIES — proactive health: clones, stuck bumps, orphans, junk
// ════════════════════════════════════════════════════════════════
router.get("/anomalies", async (req, res) => {
  try {
    const out = [];

    // 1) Duplicate deliveries: same (creatorId, messageId) appearing more than once.
    const dupes = await prisma.$queryRawUnsafe(`
      SELECT "creatorId", "messageId", COUNT(*)::int AS n
      FROM "AutomationDelivery"
      WHERE "messageId" IS NOT NULL
      GROUP BY "creatorId", "messageId"
      HAVING COUNT(*) > 1
      ORDER BY n DESC
      LIMIT 50
    `);
    const dupeTotal = dupes.reduce((s, r) => s + (r.n - 1), 0);
    out.push({
      key: "delivery_clones",
      level: dupeTotal > 0 ? "warn" : "ok",
      title: "Duplicate bump deliveries",
      detail: dupeTotal > 0 ? `${dupeTotal} clone rows across ${dupes.length} (creator, messageId) groups` : "No duplicate deliveries",
      count: dupeTotal,
      sample: dupes.slice(0, 10),
    });

    // 2) Stuck bumps: pending_reply / checking_reply older than 3 days.
    const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const stuck = await prisma.automationDelivery.count({
      where: { status: { in: ["pending_reply", "checking_reply"] }, OR: [{ sentAt: { lt: cutoff } }, { sentAt: null, createdAt: { lt: cutoff } }] },
    });
    out.push({
      key: "stuck_bumps",
      level: stuck > 0 ? "warn" : "ok",
      title: "Stuck bumps (>3d, unresolved)",
      detail: stuck > 0 ? `${stuck} deliveries stuck in pending/checking` : "No stuck bumps",
      count: stuck,
    });

    // 3) CRM profiles with zero tags (never analyzed / empty).
    const untagged = await prisma.crmProfile.count({ where: { tags: { none: {} } } });
    out.push({
      key: "untagged_profiles",
      level: "info",
      title: "CRM profiles without tags",
      detail: `${untagged} profiles have no tags yet`,
      count: untagged,
    });

    // 4) Raw tags needing review (unmapped fetish labels).
    const needsReview = await prisma.crmProfileRawTag.count({ where: { status: "needs_review" } });
    out.push({
      key: "raw_tags_review",
      level: needsReview > 0 ? "info" : "ok",
      title: "Raw tags needing review",
      detail: `${needsReview} raw fetish labels not yet mapped`,
      count: needsReview,
    });

    // 5) Orphan-ish: deliveries with null messageId still in flight.
    const noMsg = await prisma.automationDelivery.count({ where: { messageId: null, status: { in: ["pending_reply", "checking_reply", "sent"] } } });
    out.push({
      key: "deliveries_no_messageid",
      level: noMsg > 0 ? "warn" : "ok",
      title: "In-flight deliveries without messageId",
      detail: noMsg > 0 ? `${noMsg} can never be canceled (no messageId)` : "None",
      count: noMsg,
    });

    return res.json({ ok: true, anomalies: out, checkedAt: new Date().toISOString() });
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
router.delete("/record/:model/:id", async (req, res) => {
  try {
    const m = MODELS[req.params.model];
    if (!m) return res.status(400).json({ ok: false, code: "MODEL_NOT_ALLOWED" });
    if (m.deleteProtected) return res.status(403).json({ ok: false, code: "ADMIN_DELETE_PROTECTED", error: "This authority record cannot be deleted through generic admin data APIs" });
    const hard = String(req.query.hard || "") === "1";
    const id = req.params.id;

    let result;
    if (m.soft && !hard) {
      result = await m.d().update({ where: { id }, data: { deletedAt: new Date() } });
    } else {
      result = await m.d().delete({ where: { id } });
    }
    await adminLog(req, { action: "data.delete", targetType: req.params.model, targetId: id, after: { hard } });
    return res.json({ ok: true, deleted: true, hard: hard || !m.soft, id });
  } catch (err) { return sendErr(res, err); }
});

// ════════════════════════════════════════════════════════════════
// BULK DELETE — { model, ids:[], hard? }
// ════════════════════════════════════════════════════════════════
router.post("/bulk-delete", async (req, res) => {
  try {
    const m = MODELS[req.body?.model];
    if (!m) return res.status(400).json({ ok: false, code: "MODEL_NOT_ALLOWED" });
    if (m.deleteProtected) return res.status(403).json({ ok: false, code: "ADMIN_DELETE_PROTECTED", error: "This authority record cannot be deleted through generic admin data APIs" });
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ ok: false, code: "NO_IDS" });
    const hard = req.body?.hard === true;

    let count = 0;
    if (m.soft && !hard) {
      const r = await m.d().updateMany({ where: { id: { in: ids } }, data: { deletedAt: new Date() } });
      count = r.count;
    } else {
      const r = await m.d().deleteMany({ where: { id: { in: ids } } });
      count = r.count;
    }
    await adminLog(req, { action: "data.bulkDelete", targetType: req.body.model, after: { count, hard } });
    return res.json({ ok: true, deleted: count });
  } catch (err) { return sendErr(res, err); }
});

// ════════════════════════════════════════════════════════════════
// PURGE DELIVERIES — targeted cleanup (clones + stuck + by status/age)
// ════════════════════════════════════════════════════════════════
router.post("/purge-deliveries", async (req, res) => {
  try {
    const creatorId = str(req.body?.creatorId);
    const statuses = Array.isArray(req.body?.statuses) ? req.body.statuses.map(String) : [];
    const olderThanDays = Number(req.body?.olderThanDays) || 0;
    const dedupeClones = req.body?.dedupeClones === true;

    let deletedClones = 0;
    if (dedupeClones) {
      // Keep newest row per (creatorId, messageId), delete the rest.
      const rows = await prisma.automationDelivery.findMany({
        where: { originKind: "AUTOMATION", status: { in: ["COMPLETED", "FAILED", "SKIPPED", "CANCELED"] }, messageId: { not: null }, ...(creatorId ? { creatorId } : {}) },
        select: { id: true, creatorId: true, messageId: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
        take: 10000});
      const seen = new Set();
      const toDelete = [];
      for (const r of rows) {
        const key = `${r.creatorId}||${r.messageId}`;
        if (seen.has(key)) toDelete.push(r.id); else seen.add(key);
      }
      for (let i = 0; i < toDelete.length; i += 500) {
        const r = await prisma.automationDelivery.deleteMany({ where: { id: { in: toDelete.slice(i, i + 500) }, originKind: "AUTOMATION", status: { in: ["COMPLETED", "FAILED", "SKIPPED", "CANCELED"] } } });
        deletedClones += r.count;
      }
    }

    let deletedByFilter = 0;
    if (statuses.length || olderThanDays > 0) {
      const terminalStatuses = new Set(["COMPLETED", "FAILED", "SKIPPED", "CANCELED"]);
      const safeStatuses = statuses.filter((status) => terminalStatuses.has(status));
      const where = { originKind: "AUTOMATION", status: { in: safeStatuses.length ? safeStatuses : [...terminalStatuses] } };
      if (creatorId) where.creatorId = creatorId;
      if (olderThanDays > 0) {
        const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
        where.OR = [{ sentAt: { lt: cutoff } }, { sentAt: null, createdAt: { lt: cutoff } }];
      }
      const r = await prisma.automationDelivery.deleteMany({ where });
      deletedByFilter = r.count;
    }

    await adminLog(req, { action: "data.purgeDeliveries", targetType: "automationDelivery", after: { creatorId, statuses, olderThanDays, dedupeClones, deletedClones, deletedByFilter } });
    return res.json({ ok: true, deletedClones, deletedByFilter, total: deletedClones + deletedByFilter });
  } catch (err) { return sendErr(res, err); }
});

module.exports = router;

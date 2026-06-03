"use strict";

const express = require("express");
const prisma = require("../prisma");
const { cleanString, optionalString, jsonArray, jsonObject, centsFromAny, parseLimit, parseOffset, positiveInt, requireCreator, sendError } = require("../services/server-store-utils");

const router = express.Router();

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

router.get("/deliveries", async (req, res) => {
  try {
    const where = { agencyId: req.auth.agencyId };
    const creatorId = cleanString(req.query.creatorId, 100);
    const status = cleanString(req.query.status, 40);
    const fanId = cleanString(req.query.fanId, 80);
    if (creatorId) where.creatorId = creatorId;
    if (status) where.status = status;
    if (fanId) where.fanId = fanId;
    const take = parseLimit(req.query.limit, 100, 500);
    const skip = parseOffset(req.query.offset);
    const [items, count] = await Promise.all([
      prisma.automationDelivery.findMany({ where, orderBy: { createdAt: "desc" }, take, skip }),
      prisma.automationDelivery.count({ where }),
    ]);
    return res.json({ ok: true, items, count, nextOffset: skip + items.length, hasMore: skip + items.length < count });
  } catch (err) { return sendError(res, err, "AUTOMATION_DELIVERIES_FAILED"); }
});

router.post("/deliveries/upsert", async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId, 100);
    const fanId = cleanString(req.body?.fanId || req.body?.userId, 80);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    if (!fanId) return res.status(400).json({ ok: false, code: "FAN_ID_MISSING", error: "fanId is required" });
    // Electron присылает свой локальный id вида "bd_...", который НЕ является
    // серверным cuid. Доверяем id только если это похоже на серверный ключ
    // (cuid: начинается с 'c', без префикса 'bd_'/'local'/'tmp'). Иначе игнорируем,
    // чтобы дедуп ушёл в ветку по messageId, а не делал create по несуществующему id.
    const rawId = cleanString(req.body?.id, 100);
    const id = rawId && !/^(bd_|local|tmp|temp)/i.test(rawId) ? rawId : "";
    const data = {
      agencyId: req.auth.agencyId,
      creatorId,
      ruleId: optionalString(req.body?.ruleId, 100),
      contentCollectionId: optionalString(req.body?.contentCollectionId, 100),
      fanId,
      dialogId: optionalString(req.body?.dialogId, 80),
      trigger: optionalString(req.body?.trigger, 80),
      status: cleanString(req.body?.status || "scheduled", 40) || "scheduled",
      scheduledAt: parseDate(req.body?.scheduledAt),
      sentAt: parseDate(req.body?.sentAt),
      messageId: optionalString(req.body?.messageId, 100),
      priceCents: centsFromAny(req.body || {}, "priceCents", "price"),
      media: jsonArray(req.body?.media),
      result: jsonObject(req.body?.result),
      error: optionalString(req.body?.error, 2000),
      createdByUserId: req.auth.userId,
    };
    // Dedup logic:
    // 1) explicit server id -> upsert by primary key
    // 2) else if messageId present -> find existing row for this creator+messageId and update it
    //    (prevents the sweep from inserting a fresh clone on every tick)
    // 3) else -> create (drafts / no message yet)
    const updateData = { ...data, agencyId: undefined, creatorId: undefined, fanId: undefined };
    let item;
    if (id) {
      item = await prisma.automationDelivery.upsert({ where: { id }, create: data, update: updateData });
    } else if (data.messageId) {
      const existing = await prisma.automationDelivery.findFirst({
        where: { agencyId: req.auth.agencyId, creatorId, messageId: data.messageId },
        select: { id: true },
      });
      item = existing
        ? await prisma.automationDelivery.update({ where: { id: existing.id }, data: updateData })
        : await prisma.automationDelivery.create({ data });
    } else {
      item = await prisma.automationDelivery.create({ data });
    }
    return res.json({ ok: true, item, _dedup: "v2-messageId" });
  } catch (err) { return sendError(res, err, "AUTOMATION_DELIVERY_UPSERT_FAILED"); }
});

router.get("/hidden-online", async (req, res) => {
  try {
    const where = { agencyId: req.auth.agencyId };
    const creatorId = cleanString(req.query.creatorId, 100);
    const status = cleanString(req.query.status, 40);
    if (creatorId) where.creatorId = creatorId;
    if (status) where.status = status;
    const take = parseLimit(req.query.limit, 200, 1000);
    const skip = parseOffset(req.query.offset);
    const [items, count] = await Promise.all([
      prisma.hiddenOnlineUser.findMany({ where, orderBy: [{ lastSignalAt: "desc" }, { updatedAt: "desc" }], take, skip }),
      prisma.hiddenOnlineUser.count({ where }),
    ]);
    return res.json({ ok: true, items, count, nextOffset: skip + items.length, hasMore: skip + items.length < count });
  } catch (err) { return sendError(res, err, "HIDDEN_ONLINE_FAILED"); }
});

router.post("/hidden-online/upsert", async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId, 100);
    const fanId = cleanString(req.body?.fanId || req.body?.userId, 80);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    if (!fanId) return res.status(400).json({ ok: false, code: "FAN_ID_MISSING", error: "fanId is required" });
    const item = await prisma.hiddenOnlineUser.upsert({
      where: { creatorId_fanId: { creatorId, fanId } },
      create: {
        agencyId: req.auth.agencyId, creatorId, fanId,
        dialogId: optionalString(req.body?.dialogId, 80), username: optionalString(req.body?.username, 120), name: optionalString(req.body?.name, 180),
        totalSpentCents: Number(req.body?.totalSpentCents || 0) || 0,
        status: cleanString(req.body?.status || "active", 40) || "active",
        signals: jsonArray(req.body?.signals), metadata: jsonObject(req.body?.metadata),
        lastSignalAt: parseDate(req.body?.lastSignalAt) || new Date(),
      },
      update: {
        dialogId: optionalString(req.body?.dialogId, 80), username: optionalString(req.body?.username, 120), name: optionalString(req.body?.name, 180),
        totalSpentCents: req.body?.totalSpentCents === undefined ? undefined : Number(req.body.totalSpentCents || 0) || 0,
        status: req.body?.status === undefined ? undefined : cleanString(req.body.status, 40) || "active",
        signals: req.body?.signals === undefined ? undefined : jsonArray(req.body.signals),
        metadata: req.body?.metadata === undefined ? undefined : jsonObject(req.body.metadata),
        lastSignalAt: parseDate(req.body?.lastSignalAt) || new Date(),
      },
    });
    return res.json({ ok: true, item });
  } catch (err) { return sendError(res, err, "HIDDEN_ONLINE_UPSERT_FAILED"); }
});

router.get("/follow-back", async (req, res) => {
  try {
    const where = { agencyId: req.auth.agencyId };
    const creatorId = cleanString(req.query.creatorId, 100);
    const status = cleanString(req.query.status, 40);
    if (creatorId) where.creatorId = creatorId;
    if (status) where.status = status;
    const take = parseLimit(req.query.limit, 200, 1000);
    const skip = parseOffset(req.query.offset);
    const [items, count] = await Promise.all([
      prisma.followBackTask.findMany({ where, orderBy: { queuedAt: "desc" }, take, skip }),
      prisma.followBackTask.count({ where }),
    ]);
    return res.json({ ok: true, items, count, nextOffset: skip + items.length, hasMore: skip + items.length < count });
  } catch (err) { return sendError(res, err, "FOLLOW_BACK_FAILED"); }
});

router.post("/follow-back/upsert", async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId, 100);
    const fanId = cleanString(req.body?.fanId || req.body?.userId, 80);
    const action = cleanString(req.body?.action || "follow_back", 80) || "follow_back";
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    if (!fanId) return res.status(400).json({ ok: false, code: "FAN_ID_MISSING", error: "fanId is required" });
    const item = await prisma.followBackTask.upsert({
      where: { creatorId_fanId_action: { creatorId, fanId, action } },
      create: { agencyId: req.auth.agencyId, creatorId, fanId, action, dialogId: optionalString(req.body?.dialogId, 80), username: optionalString(req.body?.username, 120), name: optionalString(req.body?.name, 180), status: cleanString(req.body?.status || "pending", 40) || "pending", reason: optionalString(req.body?.reason, 500), result: jsonObject(req.body?.result), error: optionalString(req.body?.error, 2000), lastResultAt: parseDate(req.body?.lastResultAt), createdByUserId: req.auth.userId },
      update: { dialogId: optionalString(req.body?.dialogId, 80), username: optionalString(req.body?.username, 120), name: optionalString(req.body?.name, 180), status: req.body?.status === undefined ? undefined : cleanString(req.body.status, 40) || "pending", reason: req.body?.reason === undefined ? undefined : optionalString(req.body.reason, 500), result: req.body?.result === undefined ? undefined : jsonObject(req.body.result), error: req.body?.error === undefined ? undefined : optionalString(req.body.error, 2000), lastResultAt: req.body?.lastResultAt ? parseDate(req.body.lastResultAt) : undefined },
    });
    return res.json({ ok: true, item });
  } catch (err) { return sendError(res, err, "FOLLOW_BACK_UPSERT_FAILED"); }
});

// ─── Bump reply-rate aggregate ────────────────────────────────────────────────
// Атомарный счётчик по (creatorId, templateId, day). Клиент шлёт по одному событию
// на каждый переход бампа: sent при отправке, replied/canceled/expired/failed в финале.
// Дубль-вызовы безопасны на уровне суммы только если клиент гарантирует один вызов
// на переход (он гарантирует через флаг statCounted в локальной записи).
const STAT_EVENTS = new Set(["sent", "replied", "canceled", "expired", "failed"]);

router.post("/deliveries/stat-bump", async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId, 100);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    const event = cleanString(req.body?.event, 40);
    if (!STAT_EVENTS.has(event)) {
      return res.status(400).json({ ok: false, code: "BAD_EVENT", error: "event must be one of: " + Array.from(STAT_EVENTS).join(", ") });
    }
    const templateId = cleanString(req.body?.templateId, 100) || "";
    // day: YYYY-MM-DD (UTC). Берём из тела если прислали, иначе серверный сегодняшний.
    const day = cleanString(req.body?.day, 10) || new Date().toISOString().slice(0, 10);
    const by = Math.max(1, Math.min(1000, positiveInt(req.body?.by, 1)));

    const item = await prisma.bumpDeliveryStat.upsert({
      where: { creatorId_templateId_day: { creatorId, templateId, day } },
      create: {
        agencyId: req.auth.agencyId, creatorId, templateId, day,
        sent: event === "sent" ? by : 0,
        replied: event === "replied" ? by : 0,
        canceled: event === "canceled" ? by : 0,
        expired: event === "expired" ? by : 0,
        failed: event === "failed" ? by : 0,
      },
      update: { [event]: { increment: by } },
    });
    return res.json({ ok: true, item });
  } catch (err) { return sendError(res, err, "BUMP_STAT_FAILED"); }
});

router.get("/deliveries/bump-stats", async (req, res) => {
  try {
    const creatorId = cleanString(req.query?.creatorId, 100);
    const fromDay = cleanString(req.query?.from, 10);
    const toDay = cleanString(req.query?.to, 10);

    const where = { agencyId: req.auth.agencyId };
    if (creatorId) where.creatorId = creatorId;
    if (fromDay || toDay) {
      where.day = {};
      if (fromDay) where.day.gte = fromDay;
      if (toDay) where.day.lte = toDay;
    }

    const rows = await prisma.bumpDeliveryStat.findMany({ where, orderBy: { day: "desc" }, take: parseLimit(req.query?.limit, 500, 5000) });

    // Сводки: всего и по шаблону.
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
    const perTemplate = Object.values(byTemplate).map((t) => ({ ...t, replyRate: rate(t.replied, t.sent) }))
      .sort((a, b) => b.replyRate - a.replyRate);

    return res.json({ ok: true, totals, perTemplate, days: rows });
  } catch (err) { return sendError(res, err, "BUMP_STATS_READ_FAILED"); }
});

module.exports = router;

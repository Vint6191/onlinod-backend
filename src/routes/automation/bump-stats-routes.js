"use strict";

function registerBumpStatsRoutes(router, deps = {}) {
  const {
    prisma,
    cleanString,
    positiveInt,
    parseLimit,
    requireCreator,
    sendError,
    bumpStatStatus,
    incrementBumpDeliveryStat,
    STAT_EVENTS,
  } = deps;

  router.post("/deliveries/stat-bump", async (req, res) => {
    try {
      const creatorId = cleanString(req.body?.creatorId, 100);
      await requireCreator(prisma, req.auth.agencyId, creatorId);
      const event = bumpStatStatus(req.body?.event);
      if (!STAT_EVENTS.has(event)) {
        return res.status(400).json({ ok: false, code: "BAD_EVENT", error: "event must be one of: " + Array.from(STAT_EVENTS).join(", ") });
      }
      const templateId = cleanString(req.body?.templateId, 100) || "";
      const day = cleanString(req.body?.day, 10) || new Date().toISOString().slice(0, 10);
      const by = Math.max(1, Math.min(1000, positiveInt(req.body?.by, 1)));
      const stat = await incrementBumpDeliveryStat({ agencyId: req.auth.agencyId, creatorId, templateId, day, event, by });
      return res.json({ ok: true, item: stat.item, taskStats: stat.taskStats });
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

      // Compact summaries come from the same UTC-day buckets used by bump list counters.
      const today = new Date().toISOString().slice(0, 10);
      const totals = { sent: 0, replied: 0, canceled: 0, expired: 0, failed: 0, sentToday: 0, repliedToday: 0 };
      const byTemplate = {};
      for (const r of rows) {
        for (const k of ["sent", "replied", "canceled", "expired", "failed"]) totals[k] += r[k] || 0;
        if (r.day === today) {
          totals.sentToday += r.sent || 0;
          totals.repliedToday += r.replied || 0;
        }
        const t = r.templateId || "";
        if (!byTemplate[t]) byTemplate[t] = { templateId: t, sent: 0, replied: 0, canceled: 0, expired: 0, failed: 0, sentToday: 0, repliedToday: 0 };
        for (const k of ["sent", "replied", "canceled", "expired", "failed"]) byTemplate[t][k] += r[k] || 0;
        if (r.day === today) {
          byTemplate[t].sentToday += r.sent || 0;
          byTemplate[t].repliedToday += r.replied || 0;
        }
      }
      const rate = (rep, sent) => (sent > 0 ? Math.round((rep / sent) * 10000) / 100 : 0);
      totals.replyRate = rate(totals.replied, totals.sent);
      const perTemplate = Object.values(byTemplate).map((t) => ({ ...t, replyRate: rate(t.replied, t.sent) }))
        .sort((a, b) => b.replyRate - a.replyRate);

      return res.json({ ok: true, totals, perTemplate, days: rows });
    } catch (err) { return sendError(res, err, "BUMP_STATS_READ_FAILED"); }
  });
}

module.exports = { registerBumpStatsRoutes };

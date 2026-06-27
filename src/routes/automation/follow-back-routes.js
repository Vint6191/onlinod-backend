"use strict";

function registerFollowBackRoutes(router, deps) {
  const {
    prisma, cleanString, optionalString, jsonObject, parseLimit, parseOffset, positiveInt, requireCreator, sendError, requireSeniorAutomationWriter,
    parseDate, logAutomationActivitySafe,
  } = deps;

  function automationIntelNumber(value, fallback = 0) {
    if (value === null || value === undefined || value === "") return fallback;
    const n = typeof value === "number" ? value : Number(String(value).replace(/[^0-9.,-]/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : fallback;
  }

  function automationIntelCents(input = {}) {
    const item = input && typeof input === "object" ? input : {};
    const direct = automationIntelNumber(item.totalSpentCents ?? item.spendTotalCents ?? item.spentCents, 0);
    if (direct > 0) return Math.max(0, Math.round(direct));
    const total = automationIntelNumber(item.totalSumm ?? item.totalSpent, 0);
    const parts = automationIntelNumber(item.messagesSumm, 0) + automationIntelNumber(item.tipsSumm, 0) + automationIntelNumber(item.postsSumm, 0) + automationIntelNumber(item.streamsSumm, 0) + automationIntelNumber(item.subscribesSumm, 0);
    return Math.max(0, Math.round(Math.max(total, parts) * 100));
  }

  function compactAutomationFanIntel(input = {}) {
    const src = input && typeof input === "object" ? input : {};
    const fanId = cleanString(src.fanId || src.userId || src.id || "", 80);
    if (!fanId) return null;
    const totalSpentCents = automationIntelCents(src);
    return jsonObject({
      fanId,
      username: optionalString(src.username, 120),
      name: optionalString(src.name, 180),
      displayName: optionalString(src.displayName, 180),
      avatarUrl: optionalString(src.avatarUrl || src.avatar, 1000),
      avatarThumbUrl: optionalString(src.avatarThumbUrl || src.avatarThumb, 1000),
      subscribedAt: optionalString(src.subscribedAt || src.subscribeAt, 80),
      subscribedUntil: optionalString(src.subscribedUntil || src.subscribedOnExpireDate || src.expiredAt, 80),
      subscribedDurationText: optionalString(src.subscribedDurationText || src.duration, 80),
      subDays: Number.isFinite(Number(src.subDays)) ? Number(src.subDays) : null,
      totalSumm: automationIntelNumber(src.totalSumm, totalSpentCents / 100),
      messagesSumm: automationIntelNumber(src.messagesSumm, 0),
      tipsSumm: automationIntelNumber(src.tipsSumm, 0),
      postsSumm: automationIntelNumber(src.postsSumm, 0),
      streamsSumm: automationIntelNumber(src.streamsSumm, 0),
      subscribesSumm: automationIntelNumber(src.subscribesSumm, 0),
      totalSpentCents,
      joinDate: optionalString(src.joinDate, 80),
      lastSeen: optionalString(src.lastSeen, 80),
      fetchedAt: optionalString(src.fetchedAt, 80) || new Date().toISOString(),
      source: optionalString(src.source, 80) || "fan_intel_provider",
    });
  }

  function mergeIntelIntoPublicRow(row = {}) {
    const item = row && typeof row === "object" ? row : {};
    const meta = jsonObject(item.metadata || {});
    const result = jsonObject(item.result || {});
    const intel = compactAutomationFanIntel(item.fanIntel || meta.fanIntel || result.fanIntel || meta || result || {});
    if (!intel) return item;
    return {
      ...item,
      username: item.username || intel.username || null,
      name: item.name || intel.displayName || intel.name || null,
      displayName: intel.displayName || null,
      avatarUrl: intel.avatarUrl || null,
      avatarThumbUrl: intel.avatarThumbUrl || intel.avatarUrl || null,
      totalSpentCents: Number(item.totalSpentCents || 0) || Number(intel.totalSpentCents || 0) || 0,
      totalSumm: intel.totalSumm || 0,
      messagesSumm: intel.messagesSumm || 0,
      tipsSumm: intel.tipsSumm || 0,
      subscribedAt: intel.subscribedAt || null,
      subscribedUntil: intel.subscribedUntil || null,
      subscribedDurationText: intel.subscribedDurationText || null,
      subDays: intel.subDays ?? null,
      lastSeen: intel.lastSeen || null,
      fanIntelFetchedAt: intel.fetchedAt || null,
      fanIntel: intel,
    };
  }

const FOLLOW_BACK_TERMINAL_STATUSES = new Set(["followed", "waiting_return", "final_unfollowed", "done", "completed"]);
  
  function followBackTerminalStatus(status) {
    return FOLLOW_BACK_TERMINAL_STATUSES.has(String(status || "").toLowerCase());
  }
  
  function followBackStatus(value, fallback = "pending") {
    const s = cleanString(value || fallback, 40).toLowerCase() || fallback;
    return s;
  }
  
  function compactWorkerResult(input = {}) {
    const result = input.result && typeof input.result === "object" && !Array.isArray(input.result) ? input.result : {};
    return jsonObject({
      ...result,
      reason: input.reason || result.reason || null,
      skipReason: input.skipReason || result.skipReason || null,
      failReason: input.failReason || result.failReason || null,
      actionReason: input.actionReason || result.actionReason || null,
      decisionReason: input.decisionReason || result.decisionReason || null,
      rawStatus: input.status || result.rawStatus || null,
      claimedByDeviceId: result.claimedByDeviceId || input.claimedByDeviceId || input.deviceId || null,
      claimedAt: result.claimedAt || input.claimedAt || null,
      leaseUntil: result.leaseUntil || input.leaseUntil || null,
      claimTimeoutSec: result.claimTimeoutSec || input.claimTimeoutSec || null,
      refollowNudgeCount: input.refollowNudgeCount ?? result.refollowNudgeCount ?? null,
      followBackStatus: input.followBackStatus || result.followBackStatus || null,
      refollowStatus: input.refollowStatus || result.refollowStatus || null,
      waitReturnUntil: input.waitReturnUntil || result.waitReturnUntil || null,
      lastSuccessAt: input.lastSuccessAt || result.lastSuccessAt || null,
      processedAt: input.processedAt || result.processedAt || null,
      skippedAt: input.skippedAt || result.skippedAt || null,
      failedAt: input.failedAt || result.failedAt || null,
      attentionStatus: input.attentionStatus || result.attentionStatus || null,
      attentionLikesTarget: input.attentionLikesTarget ?? result.attentionLikesTarget ?? 0,
      attentionLikesDone: input.attentionLikesDone ?? result.attentionLikesDone ?? 0,
      attentionError: input.attentionError || result.attentionError || null,
      canChat: input.canChat ?? result.canChat ?? null,
      canReceiveChatMessage: input.canReceiveChatMessage ?? result.canReceiveChatMessage ?? null,
      bumpEligible: input.bumpEligible ?? result.bumpEligible ?? null,
      subscriptionState: input.subscriptionState || result.subscriptionState || null,
      subscribedBy: input.subscribedBy ?? result.subscribedBy ?? null,
      subscribedByActive: input.subscribedByActive ?? result.subscribedByActive ?? null,
      subscribedByExpire: input.subscribedByExpire ?? result.subscribedByExpire ?? null,
      subscribedIsExpiredNow: input.subscribedIsExpiredNow ?? result.subscribedIsExpiredNow ?? null,
      subscribedByExpireDate: input.subscribedByExpireDate || result.subscribedByExpireDate || null,
      subscribedOn: input.subscribedOn ?? result.subscribedOn ?? null,
      subscribedOnActive: input.subscribedOnActive ?? result.subscribedOnActive ?? null,
      subscribedOnExpiredNow: input.subscribedOnExpiredNow ?? result.subscribedOnExpiredNow ?? null,
      subscribedOnExpireDate: input.subscribedOnExpireDate || result.subscribedOnExpireDate || null,
    });
  }
  
  async function supersedeFollowBackAlternatives({ req, creatorId, fanId, action, status, reason }) {
    const normalizedAction = cleanString(action || "", 80) || "follow_back";
    const normalizedStatus = followBackStatus(status || "pending");
    const realActions = ["follow_back", "refollow_nudge"];
    let actionsToClose = [];
    let closeReason = optionalString(reason, 500) || `superseded_by_${normalizedAction}`;
  
    if (realActions.includes(normalizedAction) && ["pending", "followed", "waiting_return", "skipped"].includes(normalizedStatus)) {
      actionsToClose = realActions.filter((x) => x !== normalizedAction);
      closeReason = `superseded_by_${normalizedAction}`;
    } else if (normalizedAction === "skip" || normalizedStatus === "skipped") {
      actionsToClose = realActions;
      closeReason = optionalString(reason, 500) || "superseded_by_skip_decision";
    }
  
    if (!actionsToClose.length) return;
    await prisma.followBackTask.updateMany({
      where: {
        agencyId: req.auth.agencyId,
        creatorId,
        fanId,
        action: { in: actionsToClose },
        status: { in: ["pending", "running"] },
      },
      data: {
        status: "skipped",
        reason: closeReason,
        error: null,
        lastResultAt: new Date(),
        result: jsonObject({ reason: closeReason, supersededByAction: normalizedAction, source: "follow_back_worker_supersede" }),
      },
    }).catch(() => null);
  }
  
  async function upsertFollowBackWorkerItem({ req, creatorId, rawItem = {} }) {
    const body = rawItem && typeof rawItem === "object" ? rawItem : {};
    const fanId = cleanString(body.fanId || body.userId || body.id, 80);
    if (!fanId) return null;
    const action = cleanString(body.action || "follow_back", 80) || "follow_back";
    const incomingStatus = followBackStatus(body.status || "pending");
    const existing = await prisma.followBackTask.findUnique({ where: { creatorId_fanId_action: { creatorId, fanId, action } } });
    const status = existing && followBackTerminalStatus(existing.status) && incomingStatus === "pending" ? existing.status : incomingStatus;
    const reason = optionalString(body.reason || body.skipReason || body.failReason || body.actionReason || body.decisionReason, 500);
    const lastResultAt = parseDate(body.lastResultAt || body.processedAt || body.skippedAt || body.failedAt || body.updatedAt);
    const result = compactWorkerResult({
      ...body,
      result: {
        ...(existing?.result && typeof existing.result === "object" && !Array.isArray(existing.result) ? existing.result : {}),
        ...(body.result && typeof body.result === "object" && !Array.isArray(body.result) ? body.result : {}),
      },
    });
    const item = await prisma.followBackTask.upsert({
      where: { creatorId_fanId_action: { creatorId, fanId, action } },
      create: {
        agencyId: req.auth.agencyId,
        creatorId,
        fanId,
        action,
        dialogId: optionalString(body.dialogId || body.fanId, 80),
        username: optionalString(body.username, 120),
        name: optionalString(body.name, 180),
        status,
        reason,
        result,
        error: optionalString(body.error || body.failReason, 2000),
        lastResultAt,
        createdByUserId: req.auth.userId,
      },
      update: {
        dialogId: body.dialogId === undefined ? undefined : optionalString(body.dialogId, 80),
        username: body.username === undefined ? undefined : optionalString(body.username, 120),
        name: body.name === undefined ? undefined : optionalString(body.name, 180),
        status,
        reason: reason === null ? undefined : reason,
        result,
        error: body.error === undefined && body.failReason === undefined ? undefined : optionalString(body.error || body.failReason, 2000),
        lastResultAt: lastResultAt || undefined,
      },
    });
    await supersedeFollowBackAlternatives({ req, creatorId, fanId, action, status, reason });
    return item;
  }
  
  function isFollowBackClaimExpired(item, now = Date.now()) {
    const result = item?.result && typeof item.result === "object" ? item.result : {};
    const leaseUntil = result.leaseUntil ? new Date(result.leaseUntil).getTime() : 0;
    if (Number.isFinite(leaseUntil) && leaseUntil > 0) return leaseUntil <= now;
    const updatedAt = item?.updatedAt ? new Date(item.updatedAt).getTime() : 0;
    return Number.isFinite(updatedAt) && updatedAt > 0 && now - updatedAt > 10 * 60 * 1000;
  }
  
  function followBackClaimMeta(existingResult = {}, body = {}, deviceId = "unknown") {
    const now = new Date();
    const timeoutSec = Math.max(60, Math.min(86400, positiveInt(body.claimTimeoutSec, 600)));
    return jsonObject({
      ...(existingResult && typeof existingResult === "object" ? existingResult : {}),
      claimedByDeviceId: deviceId,
      claimedAt: now.toISOString(),
      leaseUntil: new Date(now.getTime() + timeoutSec * 1000).toISOString(),
      claimTimeoutSec: timeoutSec,
      claimSource: "follow_back_worker_claim",
    });
  }
  
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
      return res.json({ ok: true, items: items.map(mergeIntelIntoPublicRow), count, nextOffset: skip + items.length, hasMore: skip + items.length < count });
    } catch (err) { return sendError(res, err, "FOLLOW_BACK_FAILED"); }
  });
  
  
  router.get("/follow-back/diagnostics", async (req, res) => {
    try {
      const creatorId = cleanString(req.query.creatorId || req.query.accountId, 100);
      await requireCreator(prisma, req.auth.agencyId, creatorId);
  
      const runnableActions = ["follow_back", "refollow_nudge"];
      const activeJobWhere = {
        agencyId: req.auth.agencyId,
        creatorId,
        type: "follow_back",
        action: "run_queue",
        status: { in: ["scheduled", "claimed", "running"] },
      };
  
      const [groups, pendingRunnable, runningClaims, activeJobs, staleRunning] = await Promise.all([
        prisma.followBackTask.groupBy({
          by: ["status", "action"],
          where: { agencyId: req.auth.agencyId, creatorId },
          _count: { _all: true },
        }),
        prisma.followBackTask.count({
          where: { agencyId: req.auth.agencyId, creatorId, status: "pending", action: { in: runnableActions } },
        }),
        prisma.followBackTask.findMany({
          where: { agencyId: req.auth.agencyId, creatorId, status: "running", action: { in: runnableActions } },
          orderBy: { updatedAt: "desc" },
          take: 25,
          select: { id: true, fanId: true, username: true, action: true, status: true, reason: true, error: true, result: true, updatedAt: true, lastResultAt: true },
        }),
        prisma.automationJob.findMany({
          where: activeJobWhere,
          orderBy: [{ claimedAt: "desc" }, { runAfter: "asc" }, { createdAt: "desc" }],
          take: 20,
          select: { id: true, type: true, action: true, status: true, dedupeKey: true, attempts: true, maxAttempts: true, claimedByDeviceId: true, claimedAt: true, runAfter: true, error: true, createdAt: true, updatedAt: true, completedAt: true, result: true },
        }),
        prisma.followBackTask.findMany({
          where: { agencyId: req.auth.agencyId, creatorId, status: "running", action: { in: runnableActions } },
          orderBy: { updatedAt: "asc" },
          take: 100,
          select: { id: true, fanId: true, action: true, result: true, updatedAt: true },
        }).catch(() => []),
      ]);
  
      const counts = {};
      for (const row of groups || []) {
        const status = String(row.status || "unknown");
        const action = String(row.action || "unknown");
        const count = Number(row._count?._all || 0);
        counts[status] = Number(counts[status] || 0) + count;
        counts[`${status}:${action}`] = count;
      }
  
      const now = Date.now();
      const running = (runningClaims || []).map((item) => {
        const meta = item.result && typeof item.result === "object" ? item.result : {};
        const leaseUntilMs = meta.leaseUntil ? new Date(meta.leaseUntil).getTime() : 0;
        return {
          id: item.id,
          fanId: item.fanId,
          username: item.username,
          action: item.action,
          status: item.status,
          reason: item.reason,
          error: item.error,
          claimedByDeviceId: meta.claimedByDeviceId || null,
          claimedAt: meta.claimedAt || null,
          leaseUntil: meta.leaseUntil || null,
          leaseExpired: leaseUntilMs > 0 ? leaseUntilMs <= now : false,
          updatedAt: item.updatedAt,
          lastResultAt: item.lastResultAt,
        };
      });
  
      const staleRunningCount = (staleRunning || []).filter((item) => {
        const meta = item.result && typeof item.result === "object" ? item.result : {};
        const leaseUntilMs = meta.leaseUntil ? new Date(meta.leaseUntil).getTime() : 0;
        if (leaseUntilMs > 0) return leaseUntilMs <= now;
        const updatedAtMs = item.updatedAt ? new Date(item.updatedAt).getTime() : 0;
        return updatedAtMs > 0 && now - updatedAtMs > 10 * 60 * 1000;
      }).length;
  
      return res.json({
        ok: true,
        creatorId,
        counts,
        pendingRunnable,
        runningClaims: running,
        runningClaimCount: running.length,
        staleRunningCount,
        activeRunJobs: activeJobs || [],
        activeRunJobCount: (activeJobs || []).length,
        serverTime: new Date().toISOString(),
      });
    } catch (err) { return sendError(res, err, "FOLLOW_BACK_DIAGNOSTICS_FAILED"); }
  });
  
  router.post("/follow-back/upsert", requireSeniorAutomationWriter, async (req, res) => {
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
  
  
  router.post("/follow-back/intel-bulk", async (req, res) => {
    try {
      const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
      await requireCreator(prisma, req.auth.agencyId, creatorId);
      const inputItems = Array.isArray(req.body?.items) ? req.body.items : [];
      const updated = [];
      for (const raw of inputItems.slice(0, 1000)) {
        const intel = compactAutomationFanIntel(raw);
        if (!intel?.fanId) continue;
        const rows = await prisma.followBackTask.findMany({
          where: { agencyId: req.auth.agencyId, creatorId, fanId: intel.fanId },
          take: 20,
        });
        for (const existing of rows) {
          const prevResult = jsonObject(existing.result || {});
          const next = await prisma.followBackTask.update({
            where: { id: existing.id },
            data: {
              username: intel.username || existing.username || null,
              name: intel.displayName || intel.name || existing.name || null,
              result: compactWorkerResult({
                result: {
                  ...prevResult,
                  fanIntel: intel,
                  fanIntelFetchedAt: intel.fetchedAt,
                  subscribedAt: intel.subscribedAt || prevResult.subscribedAt || null,
                  subscribedDurationText: intel.subscribedDurationText || prevResult.subscribedDurationText || null,
                  totalSpentCents: intel.totalSpentCents || prevResult.totalSpentCents || 0,
                },
              }),
            },
          });
          updated.push(mergeIntelIntoPublicRow(next));
        }
      }
      return res.json({ ok: true, creatorId, count: updated.length, items: updated });
    } catch (err) { return sendError(res, err, "FOLLOW_BACK_INTEL_BULK_FAILED"); }
  });
  
  
  
  // Worker protocol: opened for authenticated Electron workers. Definition/destructive
  // writes stay senior-only, but workers must be able to mirror scan decisions,
  // claim one fan atomically, release claims on Stop, and report OF results.
  router.post("/follow-back/worker/upsert-bulk", async (req, res) => {
    try {
      const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
      await requireCreator(prisma, req.auth.agencyId, creatorId);
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      const written = [];
      for (const raw of items.slice(0, 1000)) {
        const item = await upsertFollowBackWorkerItem({ req, creatorId, rawItem: raw });
        if (item) written.push(item);
      }
      return res.json({ ok: true, creatorId, count: written.length, items: written });
    } catch (err) { return sendError(res, err, "FOLLOW_BACK_WORKER_UPSERT_FAILED"); }
  });
  
  router.post("/follow-back/worker/claim", async (req, res) => {
    try {
      const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
      const deviceId = cleanString(req.body?.deviceId || req.body?.claimedByDeviceId || "unknown", 120) || "unknown";
      const limit = parseLimit(req.body?.limit, 1, 10);
      await requireCreator(prisma, req.auth.agencyId, creatorId);
  
      const nowMs = Date.now();
      const staleBefore = new Date(nowMs - Math.max(60, Math.min(86400, positiveInt(req.body?.claimTimeoutSec, 600))) * 1000);
  
      await prisma.$executeRaw`
        UPDATE "FollowBackTask"
        SET "status" = 'pending', "error" = 'claim expired; returned to queue', "lastResultAt" = NOW()
        WHERE "agencyId" = ${req.auth.agencyId}
          AND "creatorId" = ${creatorId}
          AND "status" = 'running'
          AND (
            ("result"->>'leaseUntil')::timestamptz < NOW()
            OR (("result"->>'leaseUntil') IS NULL AND "updatedAt" < ${staleBefore})
          )
      `.catch(() => null);
  
      const candidates = await prisma.followBackTask.findMany({
        where: {
          agencyId: req.auth.agencyId,
          creatorId,
          status: { in: ["pending", "running"] },
          action: { in: ["follow_back", "refollow_nudge"] },
        },
        orderBy: [{ queuedAt: "asc" }, { updatedAt: "asc" }],
        take: Math.max(10, limit * 8),
      });
  
      const items = [];
      for (const candidate of candidates) {
        if (items.length >= limit) break;
        const meta = candidate.result && typeof candidate.result === "object" ? candidate.result : {};
        const sameDevice = String(meta.claimedByDeviceId || "") === deviceId;
        if (candidate.status === "running" && !sameDevice) continue;
  
        const result = followBackClaimMeta(meta, req.body || {}, deviceId);
        const where = candidate.status === "pending"
          ? { id: candidate.id, agencyId: req.auth.agencyId, creatorId, status: "pending" }
          : { id: candidate.id, agencyId: req.auth.agencyId, creatorId, status: "running" };
        const updated = await prisma.followBackTask.updateMany({
          where,
          data: { status: "running", result, error: null, lastResultAt: new Date() },
        });
        if (updated.count > 0) {
          const item = await prisma.followBackTask.findUnique({ where: { id: candidate.id } });
          if (item) items.push(item);
        }
      }
  
      return res.json({ ok: true, creatorId, deviceId, items, count: items.length });
    } catch (err) { return sendError(res, err, "FOLLOW_BACK_WORKER_CLAIM_FAILED"); }
  });
  
  router.post("/follow-back/worker/release", async (req, res) => {
    try {
      const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
      const deviceId = cleanString(req.body?.deviceId || req.body?.claimedByDeviceId || "", 120);
      const reason = optionalString(req.body?.reason || "manual_stop", 500) || "manual_stop";
      await requireCreator(prisma, req.auth.agencyId, creatorId);
  
      const where = { agencyId: req.auth.agencyId, creatorId, status: "running" };
      const running = await prisma.followBackTask.findMany({ where, take: 500 });
      const releaseIds = running
        .filter((item) => {
          if (!deviceId) return true;
          const result = item.result && typeof item.result === "object" ? item.result : {};
          return String(result.claimedByDeviceId || "") === deviceId;
        })
        .map((item) => item.id);
  
      if (!releaseIds.length) return res.json({ ok: true, creatorId, released: 0, items: [] });
      await prisma.followBackTask.updateMany({
        where: { agencyId: req.auth.agencyId, creatorId, id: { in: releaseIds }, status: "running" },
        data: { status: "pending", error: reason, lastResultAt: new Date() },
      });
      const items = await prisma.followBackTask.findMany({ where: { agencyId: req.auth.agencyId, creatorId, id: { in: releaseIds } } });
      return res.json({ ok: true, creatorId, released: items.length, items });
    } catch (err) { return sendError(res, err, "FOLLOW_BACK_WORKER_RELEASE_FAILED"); }
  });
  
  router.post("/follow-back/worker/result", async (req, res) => {
    try {
      const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
      const fanId = cleanString(req.body?.fanId || req.body?.userId, 80);
      const action = cleanString(req.body?.action || "follow_back", 80) || "follow_back";
      await requireCreator(prisma, req.auth.agencyId, creatorId);
      if (!fanId) return res.status(400).json({ ok: false, code: "FAN_ID_MISSING", error: "fanId is required" });
  
      const existing = await prisma.followBackTask.findUnique({ where: { creatorId_fanId_action: { creatorId, fanId, action } } });
      if (!existing) return res.status(404).json({ ok: false, code: "FOLLOW_BACK_TASK_NOT_FOUND", error: "Follow-back task not found" });
  
      const status = followBackStatus(req.body?.status || (req.body?.ok === false ? "failed" : "done"), "done");
      const result = compactWorkerResult({ ...(req.body || {}), result: { ...(existing.result && typeof existing.result === "object" ? existing.result : {}), ...(req.body?.result || {}) } });
      const reason = optionalString(req.body?.reason || req.body?.skipReason || req.body?.failReason || existing.reason, 500);
      const item = await prisma.followBackTask.update({
        where: { id: existing.id },
        data: {
          status,
          reason,
          result,
          error: optionalString(req.body?.error || req.body?.failReason, 2000),
          lastResultAt: parseDate(req.body?.lastResultAt || req.body?.processedAt || req.body?.skippedAt || req.body?.failedAt) || new Date(),
        },
      });
      await logAutomationActivitySafe({
        req,
        creatorId,
        module: "follow_back",
        action: status === "done" ? "done" : status === "failed" ? "failed" : status === "skipped" ? "skipped" : status,
        status: status === "failed" ? "failed" : status === "skipped" ? "skipped" : "ok",
        input: { fanId, amountCents: 0 },
        metadata: { fanId, fanUsername: item.username || item.name || null, action: item.action, reason: reason || item.error || null, taskId: item.id },
      });
      return res.json({ ok: true, item });
    } catch (err) { return sendError(res, err, "FOLLOW_BACK_WORKER_RESULT_FAILED"); }
  });
  
  router.post("/follow-back/clear", requireSeniorAutomationWriter, async (req, res) => {
    try {
      const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
      await requireCreator(prisma, req.auth.agencyId, creatorId);
      const result = await prisma.followBackTask.deleteMany({ where: { agencyId: req.auth.agencyId, creatorId } });
      return res.json({ ok: true, creatorId, deleted: result.count, items: [] });
    } catch (err) { return sendError(res, err, "FOLLOW_BACK_CLEAR_FAILED"); }
  });
  
  // ─── Bump reply-rate aggregate ────────────────────────────────────────────────
  // Атомарный счётчик по (creatorId, templateId, day). Клиент шлёт sent при отправке.
  // Серверный cancel-worker шлёт terminal статусы сам, чтобы другой worker мог закрыть
  // чужую доставку без локального raw-event журнала.
}

module.exports = { registerFollowBackRoutes };

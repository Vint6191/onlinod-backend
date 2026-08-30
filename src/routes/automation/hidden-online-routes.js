"use strict";

const { scheduleSubscriberScan, getSubscriberDirectoryStatus } = require("../../services/subscriber-directory-service");
const { readFanCurrent } = require("../../services/fan-data-authority-service");

function registerHiddenOnlineRoutes(router, deps) {
  const {
    prisma, cleanString, optionalString, jsonArray, jsonObject, parseLimit, parseOffset, positiveInt, requireCreator, sendError, requireSeniorAutomationWriter,
    parseDate, dateIso, deliveryMeta, mapAutomationDelivery, onlineSpacingRange, randomOnlineSpacingMs, acquireOnlineGate, onlineGateNextAllowed,
    BUMP_TRIGGER_KEYS,
  } = deps;

  // Candidate listing and bump actions remain here. Subscriber scanning is
  // owned exclusively by SubscriberDirectory/JobInstance.

  function canonicalAutomationFan(row = {}, current = null) {
    const identity = current?.platformIdentity || null;
    const value = current?.value || null;
    const available = value?.availability === "AVAILABLE";
    return {
      ...row,
      platformIdentity: identity,
      relationship: current?.relationship || null,
      value,
      username: identity?.username || row.username || null,
      name: identity?.platformDisplayName || row.name || null,
      displayName: identity?.platformDisplayName || row.displayName || null,
      avatarUrl: identity?.avatarUrl || row.avatarUrl || null,
      avatarThumbUrl: identity?.avatarUrl || row.avatarThumbUrl || row.avatarUrl || null,
      platformReportedTotalSpendCents: available ? value.platformReportedTotalSpendCents : null,
      totalSpentCents: available ? value.platformReportedTotalSpendCents : null,
      valueAvailability: value?.availability || "NOT_FETCHED",
      fanValueObservedAt: value?.observedAt || null,
    };
  }
  
  function automationDeliveryDateIso(row = {}) {
    return dateIso(row.sentAt || row.updatedAt || row.createdAt || row.scheduledAt || row.cancelAt);
  }
  
  function latestByFanId(rows = []) {
    const map = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const fanId = cleanString(row?.fanId, 80);
      if (!fanId) continue;
      const prev = map.get(fanId);
      const rowMs = parseDate(row.sentAt || row.updatedAt || row.createdAt || row.scheduledAt || row.cancelAt)?.getTime() || 0;
      const prevMs = prev ? (parseDate(prev.sentAt || prev.updatedAt || prev.createdAt || prev.scheduledAt || prev.cancelAt)?.getTime() || 0) : 0;
      if (!prev || rowMs >= prevMs) map.set(fanId, row);
    }
    return map;
  }
  
  // Compatibility surface for old alpha clients. Enqueue is bridged into the
  // new fenced SubscriberDirectory job. Claim/progress are deliberately closed
  // so a legacy worker cannot create a second subscriber scanner.
  router.post("/hidden-online/scan-jobs/enqueue", async (req, res) => {
    try {
      const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
      await requireCreator(prisma, req.auth.agencyId, creatorId);
      const result = await scheduleSubscriberScan({
        agencyId: req.auth.agencyId,
        creatorId,
        userId: req.auth.userId || null,
        manual: true,
        force: req.body?.force === true || req.body?.fullScan === true,
        pageLimit: Math.max(20, Math.min(100, positiveInt(req.body?.limit, 100))),
        scanEveryDays: Math.max(1, Math.min(30, positiveInt(req.body?.scanEveryDays, 7))),
        priority: 80,
        reason: "legacy_hidden_online_enqueue_bridge",
      });
      return res.status(result.created ? 202 : 200).json({
        ...result,
        creatorId,
        queued: result.created,
        code: "SUBSCRIBER_DIRECTORY_BRIDGE",
      });
    } catch (err) { return sendError(res, err, "HIDDEN_SCAN_ENQUEUE_FAILED"); }
  });

  const rejectLegacyScanWorker = (_req, res) => res.status(410).json({
    ok: false,
    code: "LEGACY_HIDDEN_SCAN_WORKER_DISABLED",
    error: "Hidden Online scanning is owned by SubscriberDirectory and the fenced backend job worker.",
  });
  router.post("/hidden-online/scan-jobs/claim", rejectLegacyScanWorker);
  router.post("/hidden-online/scan-jobs/progress", rejectLegacyScanWorker);

  router.get("/hidden-online/scan-state", async (req, res) => {
    try {
      const creatorId = cleanString(req.query.creatorId || req.query.accountId, 100);
      await requireCreator(prisma, req.auth.agencyId, creatorId);
      const [directory, total, active, ignored, blocked] = await Promise.all([
        getSubscriberDirectoryStatus({ agencyId: req.auth.agencyId, creatorId }),
        prisma.hiddenOnlineUser.count({ where: { agencyId: req.auth.agencyId, creatorId } }),
        prisma.hiddenOnlineUser.count({ where: { agencyId: req.auth.agencyId, creatorId, status: "active" } }),
        prisma.hiddenOnlineUser.count({ where: { agencyId: req.auth.agencyId, creatorId, status: "ignored" } }),
        prisma.hiddenOnlineUser.count({ where: { agencyId: req.auth.agencyId, creatorId, status: "blocked" } }),
      ]);
      return res.json({
        ok: true,
        creatorId,
        item: null,
        scanState: {
          status: directory.scanning ? "running" : String(directory.state?.status || "idle").toLowerCase(),
          scanned: directory.run?.scannedCount || 0,
          pages: directory.run?.pageCount || 0,
          hiddenSeen: directory.state?.hiddenCount || directory.run?.hiddenCount || 0,
          nextOffset: directory.run?.nextOffset || 0,
          nextScanAt: directory.state?.nextScanAt || null,
          lastError: directory.state?.lastError || directory.run?.lastError || null,
          jobId: directory.job?.id || null,
          progress: directory.job?.progress || null,
          architecture: "subscriber_directory_v1",
        },
        counts: { total, active, ignored, blocked },
      });
    } catch (err) { return sendError(res, err, "HIDDEN_SCAN_STATE_FAILED"); }
  });


  router.post("/hidden-online/manual-bump", requireSeniorAutomationWriter, async (req, res) => {
    try {
      const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
      const fanId = cleanString(req.body?.fanId || req.body?.userId || req.query?.fanId || req.query?.userId, 80);
      await requireCreator(prisma, req.auth.agencyId, creatorId);
      if (!fanId) return res.status(400).json({ ok: false, code: "FAN_ID_MISSING", error: "fanId is required" });
  
      const now = new Date();
      const cancelNow = new Date(now.getTime() - 60 * 1000);
      const username = optionalString(req.body?.username || req.body?.fanUsername, 120);
      const name = optionalString(req.body?.name || req.body?.fanName || req.body?.displayName, 180);
  
      const result = await prisma.$transaction(async (tx) => {
        const cancelable = await tx.automationDelivery.findMany({
          where: {
            agencyId: req.auth.agencyId,
            creatorId,
            fanId,
            status: { in: ["pending_reply", "sent", "checking_reply"] },
          },
          orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
          take: 10,
        });
  
        const cancelItems = [];
        for (const row of cancelable) {
          const updated = await tx.automationDelivery.update({
            where: { id: row.id },
            data: {
              status: "pending_reply",
              cancelAt: cancelNow,
              claimedByDeviceId: null,
              claimedAt: null,
              claimUntil: null,
              lastCheckedAt: now,
              error: null,
              result: jsonObject({
                ...deliveryMeta(row),
                manualHiddenBumpCancelQueuedAt: now.toISOString(),
                manualHiddenBumpFanId: fanId,
                previousCancelAt: row.cancelAt ? row.cancelAt.toISOString() : deliveryMeta(row).cancelAt || null,
              }),
            },
          });
          cancelItems.push(updated);
        }
  
        const replacedQueued = await tx.automationDelivery.updateMany({
          where: {
            agencyId: req.auth.agencyId,
            creatorId,
            fanId,
            status: { in: ["online_queued", "retry_wait", "send_unknown"] },
          },
          data: {
            status: "skipped",
            lastCheckedAt: now,
            error: "manual_hidden_bump_replaced",
          },
        });
  
        const sendItem = await tx.automationDelivery.create({
          data: {
            agencyId: req.auth.agencyId,
            creatorId,
            fanId,
            dialogId: cleanString(req.body?.dialogId || fanId, 80),
            trigger: BUMP_TRIGGER_KEYS.HIDDEN,
            status: "online_queued",
            scheduledAt: now,
            maxAttempts: 5,
            result: jsonObject({
              eventQueue: true,
              hiddenOnlineQueue: true,
              manualHiddenBump: true,
              manualUrgent: true,
              triggerKey: BUMP_TRIGGER_KEYS.HIDDEN,
              trigger: BUMP_TRIGGER_KEYS.HIDDEN,
              eventType: "manual_hidden_online_bump",
              reason: "manual hidden online bump button",
              queuedAt: now.toISOString(),
              source: "hidden_online_tab",
              replaceQueuedCount: replacedQueued.count || 0,
              cancelQueuedCount: cancelItems.length,
            }),
            createdByUserId: req.auth.userId || null,
          },
        });
  
        const existing = await tx.hiddenOnlineUser.findUnique({ where: { creatorId_fanId: { creatorId, fanId } } }).catch(() => null);
        if (existing?.id) {
          const meta = existing.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata) ? existing.metadata : {};
          await tx.hiddenOnlineUser.update({
            where: { id: existing.id },
            data: {
              username: username || existing.username || undefined,
              name: name || existing.name || undefined,
              lastSignalAt: existing.lastSignalAt || now,
              metadata: jsonObject({ ...meta, lastManualHiddenBumpAt: now.toISOString(), manualHiddenBumpDeliveryId: sendItem.id }),
            },
          });
        } else {
          await tx.hiddenOnlineUser.create({
            data: {
              agencyId: req.auth.agencyId,
              creatorId,
              fanId,
              dialogId: cleanString(req.body?.dialogId || fanId, 80),
              username,
              name,
              totalSpentCents: Number(req.body?.totalSpentCents || 0) || 0,
              status: "active",
              signals: [],
              metadata: jsonObject({ source: "manual_hidden_online_bump", lastManualHiddenBumpAt: now.toISOString(), manualHiddenBumpDeliveryId: sendItem.id }),
              lastSignalAt: now,
            },
          });
        }
  
        return { sendItem, cancelItems, replacedQueuedCount: replacedQueued.count || 0 };
      }, { timeout: 15000 });
  
      return res.json({
        ok: true,
        creatorId,
        fanId,
        code: "HIDDEN_MANUAL_BUMP_QUEUED",
        send: mapAutomationDelivery(result.sendItem),
        cancelQueued: result.cancelItems.length,
        cancelItems: result.cancelItems.map(mapAutomationDelivery),
        replacedQueuedCount: result.replacedQueuedCount,
      });
    } catch (err) { return sendError(res, err, "HIDDEN_MANUAL_BUMP_FAILED"); }
  });
  
  router.post("/hidden-online/queue-eligible", async (req, res) => {
    try {
      const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
      await requireCreator(prisma, req.auth.agencyId, creatorId);
      const now = new Date();
      const range = onlineSpacingRange(req.body || {});
      const limit = Math.max(1, Math.min(200, positiveInt(req.body?.limit, 50)));
      const cadenceHours = Math.max(1, Math.min(168, Number(req.body?.cadenceHours || req.body?.hiddenCadenceHours || 3) || 3));
      const replyTimeoutHours = Math.max(1, Math.min(24, Number(req.body?.replyTimeoutHours || req.body?.hiddenReplyTimeoutHours || 1) || 1));
  
      // Pull a wide candidate window. The previous limit*5 window could be
      // fully occupied by fresh fanOnline/pending_reply rows, so hidden refill
      // returned NO_ELIGIBLE even though thousands of older hidden candidates
      // were available deeper in the list.
      const candidateTake = Math.max(limit * 50, limit, 1000);
      const candidates = await prisma.hiddenOnlineUser.findMany({
        where: { agencyId: req.auth.agencyId, creatorId, status: "active" },
        orderBy: [{ lastSignalAt: "desc" }, { updatedAt: "desc" }],
        take: Math.min(5000, candidateTake),
      });
      const fanIds = candidates.map((x) => x.fanId).filter(Boolean);
      const hiddenCooldownSince = new Date(now.getTime() - cadenceHours * 60 * 60 * 1000);
      const [activeRows, recentHiddenRows] = fanIds.length ? await Promise.all([
        prisma.automationDelivery.findMany({
          where: {
            agencyId: req.auth.agencyId,
            creatorId,
            fanId: { in: fanIds },
            OR: [
              { status: { in: ["online_queued", "scheduled", "retry_wait", "send_unknown", "claimed", "online_claimed", "send_reserved", "checking_reply"] } },
              { status: { in: ["sent", "pending_reply"] }, OR: [{ cancelAt: null }, { cancelAt: { gt: now } }] },
            ],
          },
          select: { fanId: true, status: true, cancelAt: true, trigger: true, createdAt: true, sentAt: true },
          take: 10000,
        }),
        prisma.automationDelivery.findMany({
          where: {
            agencyId: req.auth.agencyId,
            creatorId,
            fanId: { in: fanIds },
            trigger: BUMP_TRIGGER_KEYS.HIDDEN,
            OR: [
              { createdAt: { gte: hiddenCooldownSince } },
              { sentAt: { gte: hiddenCooldownSince } },
              { scheduledAt: { gte: hiddenCooldownSince } },
            ],
          },
          select: { fanId: true, status: true, trigger: true, createdAt: true, sentAt: true, scheduledAt: true, cancelAt: true },
          orderBy: [{ createdAt: "desc" }],
          take: 10000,
        }),
      ]) : [[], []];
      const activeByFan = new Map(activeRows.map((x) => [String(x.fanId), x]));
      const recentHiddenByFan = new Map();
      for (const row of recentHiddenRows || []) {
        const fid = String(row.fanId || "");
        if (!fid || recentHiddenByFan.has(fid)) continue;
        recentHiddenByFan.set(fid, row);
      }
      const picked = [];
      const skipped = [];
      const skippedCounts = {};
      const pushSkip = (row) => {
        const code = String(row?.code || row?.reason || "SKIPPED");
        skipped.push({ reason: code, ...row, code });
        skippedCounts[code] = (skippedCounts[code] || 0) + 1;
      };
      for (const c of candidates) {
        if (picked.length >= limit) break;
        const recentHidden = recentHiddenByFan.get(String(c.fanId));
        if (recentHidden) {
          const baseAt = parseDate(recentHidden.sentAt || recentHidden.createdAt || recentHidden.scheduledAt || recentHidden.cancelAt) || now;
          const nextEligibleAt = new Date(baseAt.getTime() + cadenceHours * 60 * 60 * 1000);
          if (nextEligibleAt > now) {
            pushSkip({ fanId: c.fanId, code: "COOLING", nextEligibleAt: nextEligibleAt.toISOString(), lastHiddenAt: baseAt.toISOString(), status: recentHidden.status || null, trigger: recentHidden.trigger || null, cancelAt: recentHidden.cancelAt ? recentHidden.cancelAt.toISOString() : null });
            continue;
          }
        }
        const active = activeByFan.get(String(c.fanId));
        if (active) { pushSkip({ fanId: c.fanId, code: "ACTIVE_OR_ALREADY_QUEUED", status: active.status || null, trigger: active.trigger || null, cancelAt: active.cancelAt ? active.cancelAt.toISOString() : null }); continue; }
        picked.push(c);
      }
  
      if (!picked.length) return res.json({ ok: true, creatorId, count: 0, items: [], skipped, skippedCount: skipped.length, skippedCounts, candidateWindow: candidates.length, activeChecked: activeRows.length, code: "NO_ELIGIBLE_HIDDEN_ONLINE" });
  
      const result = await prisma.$transaction(async (tx) => {
        const gate = await acquireOnlineGate(tx, { agencyId: req.auth.agencyId, creatorId, now, scope: "hidden" });
        let cursor = onlineGateNextAllowed(gate, now);
        const items = [];
        for (const c of picked) {
          const scheduledAt = new Date(Math.max(cursor.getTime(), now.getTime()));
          const meta = c.metadata && typeof c.metadata === "object" && !Array.isArray(c.metadata) ? c.metadata : {};
          const item = await tx.automationDelivery.create({
            data: {
              agencyId: req.auth.agencyId,
              creatorId,
              fanId: c.fanId,
              dialogId: c.dialogId || c.fanId,
              trigger: BUMP_TRIGGER_KEYS.HIDDEN,
              status: "online_queued",
              scheduledAt,
              maxAttempts: 3,
              result: jsonObject({
                eventQueue: true,
                hiddenOnlineQueue: true,
                queuePriority: "background",
                gateScope: "hidden",
                triggerKey: BUMP_TRIGGER_KEYS.HIDDEN,
                trigger: BUMP_TRIGGER_KEYS.HIDDEN,
                eventType: "hidden_online_candidate",
                sourceCandidateId: c.id,
                reason: meta.reason || "hidden online candidate",
                replyTimeoutHours,
                hiddenReplyTimeoutHours: replyTimeoutHours,
                hiddenCadenceHours: cadenceHours,
                minFanSpacingSec: range.min,
                maxFanSpacingSec: range.max,
                queuedAt: now.toISOString(),
              }),
              createdByUserId: req.auth.userId || null,
            },
          });
          items.push(item);
          const nextEligibleAt = new Date(now.getTime() + cadenceHours * 60 * 60 * 1000).toISOString();
          await tx.hiddenOnlineUser.update({
            where: { id: c.id },
            data: { metadata: jsonObject({ ...meta, lastHiddenQueuedAt: now.toISOString(), nextEligibleAt, hiddenCadenceHours: cadenceHours, hiddenReplyTimeoutHours: replyTimeoutHours }) },
          });
          cursor = new Date(scheduledAt.getTime() + randomOnlineSpacingMs(range));
        }
        await tx.automationDelivery.update({
          where: { id: gate.id },
          data: { scheduledAt: cursor, result: jsonObject({ ...deliveryMeta(gate), eventGate: true, hiddenGate: true, onlineGate: false, gateScope: "hidden", nextAllowedAt: cursor.toISOString(), minFanSpacingSec: range.min, maxFanSpacingSec: range.max, updatedAt: now.toISOString() }) },
        });
        return { items, gateNextAllowedAt: cursor };
      }, { timeout: 15000 });
  
      return res.json({ ok: true, creatorId, triggerKey: BUMP_TRIGGER_KEYS.HIDDEN, count: result.items.length, items: result.items.map(mapAutomationDelivery), skipped, skippedCount: skipped.length, skippedCounts, candidateWindow: candidates.length, activeChecked: activeRows.length, gateNextAllowedAt: result.gateNextAllowedAt.toISOString(), minFanSpacingSec: range.min, maxFanSpacingSec: range.max, cadenceHours, replyTimeoutHours });
    } catch (err) { return sendError(res, err, "HIDDEN_ONLINE_QUEUE_ELIGIBLE_FAILED"); }
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
  
      const fanIds = items.map((x) => String(x.fanId || "")).filter(Boolean);
      let latestHiddenByFan = new Map();
      let activeHiddenByFan = new Map();
      if (fanIds.length && creatorId) {
        const rows = await prisma.automationDelivery.findMany({
          where: {
            agencyId: req.auth.agencyId,
            creatorId,
            fanId: { in: fanIds },
            OR: [
              { trigger: BUMP_TRIGGER_KEYS.HIDDEN },
              { result: { path: ["triggerKey"], equals: BUMP_TRIGGER_KEYS.HIDDEN } },
              { result: { path: ["hiddenOnlineQueue"], equals: true } },
              { result: { path: ["manualHiddenBump"], equals: true } },
            ],
          },
          orderBy: [{ sentAt: "desc" }, { updatedAt: "desc" }],
          take: Math.min(5000, Math.max(fanIds.length * 20, 200)),
        }).catch(() => []);
        latestHiddenByFan = latestByFanId(rows);
        for (const row of rows) {
          const fanId = String(row.fanId || "");
          const status = String(row.status || "").toLowerCase();
          if (!fanId || activeHiddenByFan.has(fanId)) continue;
          if (["online_queued", "scheduled", "retry", "sent", "checking_reply", "pending_reply", "claimed"].includes(status)) activeHiddenByFan.set(fanId, row);
        }
      }
  
      const currentRows = creatorId && fanIds.length
        ? await readFanCurrent(prisma, { agencyId: req.auth.agencyId, creatorId, onlyFansUserIds: fanIds }).catch(() => [])
        : [];
      const currentByFan = new Map(currentRows.map((row) => [String(row.onlyFansUserId), row]));
      const enriched = items.map((item) => {
        const fanId = String(item.fanId || "");
        const meta = jsonObject(item.metadata || {});
        const latest = latestHiddenByFan.get(fanId) || null;
        const active = activeHiddenByFan.get(fanId) || null;
        return canonicalAutomationFan({
          ...item,
          lastHiddenBumpAt: dateIso(latest?.sentAt) || dateIso(meta.lastHiddenSentAt) || dateIso(meta.lastHiddenQueuedAt) || automationDeliveryDateIso(latest) || null,
          lastHiddenQueuedAt: dateIso(meta.lastHiddenQueuedAt) || dateIso(latest?.createdAt) || null,
          lastHiddenStatus: latest?.status || meta.lastHiddenStatus || null,
          lastHiddenMessageId: latest?.messageId || meta.lastHiddenMessageId || null,
          lastHiddenDeliveryId: latest?.id || null,
          hiddenActiveStatus: active?.status || null,
          hiddenActiveDeliveryId: active?.id || null,
          nextEligibleAt: dateIso(meta.nextEligibleAt || meta.hiddenNextEligibleAt) || null,
        }, currentByFan.get(fanId) || null);
      });
  
      return res.json({ ok: true, items: enriched, count, nextOffset: skip + items.length, hasMore: skip + items.length < count });
    } catch (err) { return sendError(res, err, "HIDDEN_ONLINE_FAILED"); }
  });
  
  router.post("/hidden-online/upsert", requireSeniorAutomationWriter, async (req, res) => {
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
  
  

  router.post("/hidden-online/clear", requireSeniorAutomationWriter, async (req, res) => {
    try {
      const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
      await requireCreator(prisma, req.auth.agencyId, creatorId);
      const result = await prisma.hiddenOnlineUser.deleteMany({ where: { agencyId: req.auth.agencyId, creatorId } });
      return res.json({ ok: true, creatorId, deleted: result.count, items: [], signals: [] });
    } catch (err) { return sendError(res, err, "HIDDEN_ONLINE_CLEAR_FAILED"); }
  });
  
  router.post("/hidden-online/:fanId/status", requireSeniorAutomationWriter, async (req, res) => {
    try {
      const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
      const fanId = cleanString(req.params.fanId || req.body?.fanId || req.body?.userId, 80);
      const status = cleanString(req.body?.status || req.query?.status || "active", 40) || "active";
      await requireCreator(prisma, req.auth.agencyId, creatorId);
      if (!fanId) return res.status(400).json({ ok: false, code: "FAN_ID_MISSING", error: "fanId is required" });
      const existing = await prisma.hiddenOnlineUser.findUnique({ where: { creatorId_fanId: { creatorId, fanId } } });
      if (!existing) return res.status(404).json({ ok: false, code: "HIDDEN_ONLINE_USER_NOT_FOUND", error: "Hidden online user not found" });
      const item = await prisma.hiddenOnlineUser.update({
        where: { id: existing.id },
        data: { status, metadata: { ...(existing.metadata && typeof existing.metadata === "object" ? existing.metadata : {}), statusUpdatedAt: new Date().toISOString() } },
      });
      return res.json({ ok: true, item });
    } catch (err) { return sendError(res, err, "HIDDEN_ONLINE_STATUS_FAILED"); }
  });
  
  
}

module.exports = { registerHiddenOnlineRoutes };

"use strict";

function registerDeliveryRoutes(router, deps) {
  const {
    prisma, cleanString, optionalString, jsonArray, jsonObject, centsFromAny, parseLimit, parseOffset, positiveInt, requireCreator, sendError, requireSeniorAutomationWriter,
    parseDate, deliveryMeta, deliveryTemplateId, deliveryCancelAt, sortAutomationSendCandidates, mapAutomationDelivery,
    automationActivityModuleForDelivery, logAutomationActivitySafe, BUMP_TERMINAL_DELIVERY_STATUSES, bumpStatStatus,
    refreshBumpTaskStats, compactTemplateIds, dateIso, maxIsoDate, addHoursDate, mapBumpFanState, upsertBumpFanState,
    incrementBumpDeliveryStat, findAutomationDeliveryForResult, stripUndefinedFields, deliveryStatAlreadyCounted, automationResultCode,
    isSoftRetryResult, isSendUnknownResult, automationRetryAt, normalizeDeliveryWriteData, createAutomationDeliverySafe,
    saveAutomationDeliveryIdempotent, markAutomationDeliveryTerminal, repairAutomationDeliveries, BUMP_TRIGGER_KEYS, normalizeBumpTrigger,
    eventGateId, eventQueueBatchId, onlineQueueFanIds, onlineSpacingRange, randomOnlineSpacingMs, acquireOnlineGate, onlineGateNextAllowed,
    AUTOMATION_TERMINAL_ROW_STATUSES, AUTOMATION_SOFT_RETRY_CODES, ONLINE_SEND_ACTIVE_STATUSES,
  } = deps;

  const TERMINAL_ROW_STATUSES = AUTOMATION_TERMINAL_ROW_STATUSES instanceof Set
    ? AUTOMATION_TERMINAL_ROW_STATUSES
    : new Set(["replied", "canceled", "expired", "failed", "skipped"]);

router.get("/deliveries/fan-state", async (req, res) => {
    try {
      const creatorId = cleanString(req.query.creatorId || req.query.accountId, 100);
      const fanId = cleanString(req.query.fanId || req.query.dialogId, 80);
      await requireCreator(prisma, req.auth.agencyId, creatorId);
      if (!fanId) return res.status(400).json({ ok: false, code: "FAN_ID_MISSING", error: "fanId is required" });
      const item = await prisma.automationBumpFanState.findUnique({ where: { creatorId_fanId: { creatorId, fanId } } });
      return res.json({ ok: true, item: mapBumpFanState(item), fanId, creatorId });
    } catch (err) { return sendError(res, err, "BUMP_FAN_STATE_FAILED"); }
  });
  
  router.post("/deliveries/fan-state/upsert", async (req, res) => {
    try {
      const creatorId = cleanString(req.body?.creatorId || req.body?.accountId, 100);
      const fanId = cleanString(req.body?.fanId || req.body?.dialogId, 80);
      await requireCreator(prisma, req.auth.agencyId, creatorId);
      if (!fanId) return res.status(400).json({ ok: false, code: "FAN_ID_MISSING", error: "fanId is required" });
      const item = await upsertBumpFanState({
        agencyId: req.auth.agencyId,
        creatorId,
        fanId,
        dialogId: req.body?.dialogId || fanId,
        templateId: req.body?.templateId || req.body?.bumpId || req.body?.contentCollectionId || "",
        status: req.body?.status || "sent",
        sentAt: req.body?.sentAt || null,
        finalizedAt: req.body?.finalizedAt || req.body?.repliedAt || req.body?.canceledAt || req.body?.failedAt || null,
        messageId: req.body?.messageId || null,
        replyCooldownHours: req.body?.replyCooldownHours ?? req.body?.fanReplyCooldownHours ?? req.body?.afterReplyCooldownHours ?? 24,
        sentCooldownHours: req.body?.sentCooldownHours ?? req.body?.fanSentCooldownHours ?? req.body?.afterSendCooldownHours ?? 6,
        sameTemplateCooldownHours: req.body?.sameTemplateCooldownHours ?? req.body?.cooldownHours ?? null,
        nextAllowedAt: req.body?.nextAllowedAt || null,
        repliedCooldownUntil: req.body?.repliedCooldownUntil || null,
        sentCooldownUntil: req.body?.sentCooldownUntil || null,
      });
      return res.json({ ok: true, item });
    } catch (err) { return sendError(res, err, "BUMP_FAN_STATE_UPSERT_FAILED"); }
  });
  
  router.post("/deliveries/repair", requireSeniorAutomationWriter, async (req, res) => {
    try {
      const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
      await requireCreator(prisma, req.auth.agencyId, creatorId);
      const report = await repairAutomationDeliveries({ agencyId: req.auth.agencyId, creatorId, timeoutSec: positiveInt(req.body?.timeoutSec, 180) });
      return res.json({ ok: true, creatorId, report });
    } catch (err) { return sendError(res, err, "AUTOMATION_DELIVERY_REPAIR_FAILED"); }
  });
  
  router.get("/deliveries/health", async (req, res) => {
    try {
      const creatorId = cleanString(req.query.creatorId || req.query.accountId, 100);
      await requireCreator(prisma, req.auth.agencyId, creatorId);
      const now = new Date();
      const [byStatus, byTrigger, staleClaims, dueHot, dueHidden, pendingReply, terminalToday, retryWait, sendUnknown, softLimited] = await Promise.all([
        prisma.automationDelivery.groupBy({ by: ["status"], where: { agencyId: req.auth.agencyId, creatorId }, _count: { _all: true } }).catch(() => []),
        prisma.automationDelivery.groupBy({ by: ["trigger"], where: { agencyId: req.auth.agencyId, creatorId }, _count: { _all: true } }).catch(() => []),
        prisma.automationDelivery.count({ where: { agencyId: req.auth.agencyId, creatorId, status: { in: ["online_claimed", "send_reserved", "cancel_claimed", "hidden_scan_claimed"] }, OR: [{ claimUntil: null }, { claimUntil: { lt: now } }, { claimedByDeviceId: null }] } }).catch(() => 0),
        prisma.automationDelivery.count({ where: { agencyId: req.auth.agencyId, creatorId, status: "online_queued", trigger: { in: ["fanOnline", "fanSubscribed", "fanLikedPost"] }, scheduledAt: { lte: now } } }).catch(() => 0),
        prisma.automationDelivery.count({ where: { agencyId: req.auth.agencyId, creatorId, status: "online_queued", trigger: "hiddenOnlineSignal", scheduledAt: { lte: now } } }).catch(() => 0),
        prisma.automationDelivery.count({ where: { agencyId: req.auth.agencyId, creatorId, status: "pending_reply" } }).catch(() => 0),
        prisma.automationDelivery.count({ where: { agencyId: req.auth.agencyId, creatorId, status: { in: Array.from(TERMINAL_ROW_STATUSES) }, updatedAt: { gte: new Date(now.toISOString().slice(0,10) + "T00:00:00.000Z") } } }).catch(() => 0),
        prisma.automationDelivery.count({ where: { agencyId: req.auth.agencyId, creatorId, status: "online_queued", result: { path: ["softRetry"], equals: true } } }).catch(() => 0),
        prisma.automationDelivery.count({ where: { agencyId: req.auth.agencyId, creatorId, status: "send_unknown" } }).catch(() => 0),
        prisma.automationDelivery.count({ where: { agencyId: req.auth.agencyId, creatorId, status: "online_queued", OR: Array.from(AUTOMATION_SOFT_RETRY_CODES).map((code) => ({ result: { path: ["retryReason"], equals: code } })) } }).catch(() => 0),
      ]);
      return res.json({
        ok: true,
        creatorId,
        deliveries: {
          byStatus: Object.fromEntries((byStatus || []).map((x) => [x.status || "null", x._count?._all || 0])),
          byTrigger: Object.fromEntries((byTrigger || []).map((x) => [x.trigger || "null", x._count?._all || 0])),
          staleClaims,
          dueHot,
          dueHidden,
          pendingReply,
          terminalToday,
          retryWait,
          sendUnknown,
          softLimited,
        },
      });
    } catch (err) { return sendError(res, err, "AUTOMATION_DELIVERY_HEALTH_FAILED"); }
  });
  
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
      const [rows, count] = await Promise.all([
        prisma.automationDelivery.findMany({ where, orderBy: { createdAt: "desc" }, take, skip }),
        prisma.automationDelivery.count({ where }),
      ]);
      const items = (rows || []).map(mapAutomationDelivery);
      return res.json({ ok: true, items, count, nextOffset: skip + items.length, hasMore: skip + items.length < count });
    } catch (err) { return sendError(res, err, "AUTOMATION_DELIVERIES_FAILED"); }
  });
  
  router.post("/deliveries/upsert", async (req, res) => {
    try {
      const creatorId = cleanString(req.body?.creatorId, 100);
      const fanId = cleanString(req.body?.fanId || req.body?.userId, 80);
      await requireCreator(prisma, req.auth.agencyId, creatorId);
      if (!fanId) return res.status(400).json({ ok: false, code: "FAN_ID_MISSING", error: "fanId is required" });
  
      // Electron может прислать локальный id вида bd_/local/tmp. Такой id не
      // является серверным primary key, поэтому дедупим его через messageId.
      const rawId = cleanString(req.body?.id, 100);
      const id = rawId && !/^(bd_|local|tmp|temp)/i.test(rawId) ? rawId : "";
      const templateId = optionalString(req.body?.contentCollectionId || req.body?.templateId || req.body?.bumpId, 100);
      const incomingResult = req.body?.result && typeof req.body.result === "object" && !Array.isArray(req.body.result) ? req.body.result : {};
      const resultMeta = jsonObject({
        ...incomingResult,
        lifecycle: incomingResult.lifecycle || "active",
        localDeliveryId: rawId && /^(bd_|local|tmp|temp)/i.test(rawId) ? rawId : (incomingResult.localDeliveryId || incomingResult.localId || null),
        templateId: templateId || incomingResult.templateId || incomingResult.bumpId || null,
        bumpId: templateId || incomingResult.bumpId || incomingResult.templateId || null,
        queueId: req.body?.queueId ?? incomingResult.queueId ?? null,
        cancelAt: req.body?.cancelAt || incomingResult.cancelAt || null,
        cancelAfterHours: req.body?.cancelAfterHours ?? incomingResult.cancelAfterHours ?? null,
        statCounted: incomingResult.statCounted || null,
        statCountedAt: incomingResult.statCountedAt || null,
        statCountedStatus: incomingResult.statCountedStatus || null,
      });
  
      let data = normalizeDeliveryWriteData({
        agencyId: req.auth.agencyId,
        creatorId,
        ruleId: optionalString(req.body?.ruleId, 100),
        contentCollectionId: templateId,
        fanId,
        dialogId: optionalString(req.body?.dialogId, 80),
        trigger: optionalString(req.body?.trigger, 80),
        status: cleanString(req.body?.status || "scheduled", 40) || "scheduled",
        scheduledAt: parseDate(req.body?.scheduledAt),
        sentAt: parseDate(req.body?.sentAt),
        cancelAt: parseDate(req.body?.cancelAt || incomingResult.cancelAt),
        claimedByDeviceId: optionalString(req.body?.claimedByDeviceId || incomingResult.claimedByDeviceId, 120),
        claimedAt: parseDate(req.body?.claimedAt || incomingResult.claimedAt),
        claimUntil: parseDate(req.body?.claimUntil || incomingResult.claimUntil),
        lastCheckedAt: parseDate(req.body?.lastCheckedAt || incomingResult.lastCheckedAt),
        attempts: req.body?.attempts === undefined ? undefined : positiveInt(req.body.attempts, 0),
        maxAttempts: req.body?.maxAttempts === undefined ? undefined : Math.max(1, Math.min(50, positiveInt(req.body.maxAttempts, 5))),
        messageId: optionalString(req.body?.messageId, 100),
        priceCents: centsFromAny(req.body || {}, "priceCents", "price"),
        media: jsonArray(req.body?.media),
        result: resultMeta,
        error: optionalString(req.body?.error, 2000),
        createdByUserId: req.auth.userId,
      });
  
      const updateData = stripUndefinedFields({ ...data, agencyId: undefined, creatorId: undefined, fanId: undefined, createdByUserId: undefined });
      const terminalStatus = bumpStatStatus(data.status);
  
      // Terminal writes are state transitions, not deletes. Keeping a tombstone row
      // makes late local fire-and-forget updates idempotent and avoids P2025 races.
      if (BUMP_TERMINAL_DELIVERY_STATUSES.has(terminalStatus)) {
        const existing = id
          ? await prisma.automationDelivery.findFirst({ where: { id, agencyId: req.auth.agencyId, creatorId } })
          : data.messageId
            ? await prisma.automationDelivery.findFirst({ where: { agencyId: req.auth.agencyId, creatorId, messageId: data.messageId }, orderBy: { updatedAt: "desc" } })
            : null;
        if (!existing?.id) {
          return res.json({ ok: true, item: null, alreadyCompacted: true, terminal: true, status: terminalStatus, code: "TERMINAL_DELIVERY_NOT_FOUND" });
        }
        const final = await markAutomationDeliveryTerminal({ req, creatorId, row: existing, status: terminalStatus, input: req.body || {}, source: "delivery_upsert_terminal" });
        return res.json({ ...final, _dedup: "v19.34-terminal-tombstone" });
      }
  
      const item = await saveAutomationDeliveryIdempotent({
        agencyId: req.auth.agencyId,
        creatorId,
        id,
        messageId: data.messageId,
        data,
        updateData,
      });
  
      if (item && !TERMINAL_ROW_STATUSES.has(bumpStatStatus(item.status || ""))) {
        await upsertBumpFanState({
          agencyId: req.auth.agencyId, creatorId, fanId: item.fanId, dialogId: item.dialogId || item.fanId,
          templateId: deliveryTemplateId(item), status: item.status || "sent", sentAt: item.sentAt, messageId: item.messageId,
          replyCooldownHours: req.body?.replyCooldownHours ?? req.body?.fanReplyCooldownHours ?? req.body?.afterReplyCooldownHours ?? 24,
          sentCooldownHours: req.body?.sentCooldownHours ?? req.body?.fanSentCooldownHours ?? req.body?.afterSendCooldownHours ?? 6,
          sameTemplateCooldownHours: req.body?.sameTemplateCooldownHours ?? req.body?.cooldownHours ?? null,
        }).catch(() => null);
      }
      return res.json({ ok: true, item: mapAutomationDelivery(item), _dedup: "v19.34-state-machine-idempotent" });
    } catch (err) { return sendError(res, err, "AUTOMATION_DELIVERY_UPSERT_FAILED"); }
  });
  
  
  // Test helper for environments without DB shell access. It does NOT delete
  // messages by itself. It only moves a small number of pending bump deliveries
  // into the due window so the normal distributed claim/sweep pipeline can be
  // tested from the desktop console. Senior automation writer is required.
  router.post("/deliveries/debug-force-due", requireSeniorAutomationWriter, async (req, res) => {
    try {
      const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
      await requireCreator(prisma, req.auth.agencyId, creatorId);
  
      const limit = parseLimit(req.body?.limit, 1, 5);
      const minutesAgo = Math.max(1, Math.min(60, positiveInt(req.body?.minutesAgo, 1)));
      const now = new Date();
      const forcedCancelAt = new Date(now.getTime() - minutesAgo * 60 * 1000);
  
      const deliveryId = cleanString(req.body?.deliveryId || req.body?.id, 120);
      const messageId = cleanString(req.body?.messageId, 120);
      const fanId = cleanString(req.body?.fanId || req.body?.dialogId, 100);
      const templateId = cleanString(req.body?.templateId || req.body?.bumpId, 100);
  
      const where = {
        agencyId: req.auth.agencyId,
        creatorId,
        status: { in: ["pending_reply", "sent", "checking_reply"] },
        ...(deliveryId ? { id: deliveryId } : {}),
        ...(messageId ? { messageId } : {}),
        ...(fanId ? { OR: [{ fanId }, { dialogId: fanId }] } : {}),
        ...(templateId ? { contentCollectionId: templateId } : {}),
      };
  
      const rows = await prisma.automationDelivery.findMany({
        where,
        orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
        take: limit,
      });
  
      const items = [];
      for (const row of rows) {
        const updated = await prisma.automationDelivery.update({
          where: { id: row.id },
          data: {
            status: "pending_reply",
            cancelAt: forcedCancelAt,
            claimedByDeviceId: null,
            claimedAt: null,
            claimUntil: null,
            lastCheckedAt: now,
            error: null,
            result: jsonObject({
              ...deliveryMeta(row),
              debugForcedDueAt: now.toISOString(),
              debugForcedByUserId: req.auth?.userId || null,
              previousCancelAt: row.cancelAt ? row.cancelAt.toISOString() : deliveryMeta(row).cancelAt || null,
            }),
          },
        });
        items.push(mapAutomationDelivery(updated));
      }
  
      return res.json({
        ok: true,
        creatorId,
        count: items.length,
        forcedCancelAt: forcedCancelAt.toISOString(),
        items,
        warning: "debug-force-due only makes rows claimable; normal claim/sweep still performs reply-check and delete",
      });
    } catch (err) { return sendError(res, err, "BUMP_DEBUG_FORCE_DUE_FAILED"); }
  });
  
  
  // Distributed bump event scheduler. Workers report online/like/subscription fan batches; server
  // dedupes fanIds and assigns global scheduledAt slots with 15–30s spacing so
  // several employees/devices cannot burst-send at the same time.
  router.post("/deliveries/online-batch", async (req, res) => {
    try {
      const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
      await requireCreator(prisma, req.auth.agencyId, creatorId);
      const fanIds = onlineQueueFanIds(req.body?.fanIds || req.body?.onlineIds || req.body?.ids || []);
      if (!fanIds.length) return res.json({ ok: true, creatorId, count: 0, items: [], skipped: [], code: "BUMP_EVENT_BATCH_EMPTY" });
  
      const range = onlineSpacingRange(req.body || {});
      const triggerKey = normalizeBumpTrigger(req.body?.triggerType || req.body?.triggerKey || req.body?.trigger || req.body?.event?.triggerKey || req.body?.event?.type);
      const deviceId = cleanString(req.body?.deviceId || req.body?.claimedByDeviceId || "unknown", 120) || "unknown";
      const batchId = cleanString(req.body?.batchId, 120) || eventQueueBatchId(triggerKey);
      const now = new Date();
  
      const result = await prisma.$transaction(async (tx) => {
        const gate = await acquireOnlineGate(tx, { agencyId: req.auth.agencyId, creatorId, now, scope: "live" });
        const activeRows = await tx.automationDelivery.findMany({
          where: { agencyId: req.auth.agencyId, creatorId, fanId: { in: fanIds }, status: { in: ONLINE_SEND_ACTIVE_STATUSES } },
          select: { id: true, fanId: true, status: true, scheduledAt: true, sentAt: true, createdAt: true },
          take: 10000});
        const activeByFan = new Map(activeRows.map((x) => [String(x.fanId), x]));
        let cursor = onlineGateNextAllowed(gate, now);
        const maxCarrySec = Math.max(30, Math.min(180, positiveInt(req.body?.maxGateCarrySec || req.body?.liveMaxGateCarrySec, 60)));
        let gateWasClamped = false;
        if (cursor.getTime() - now.getTime() > maxCarrySec * 1000) {
          cursor = now;
          gateWasClamped = true;
        }
        const items = [];
        const skipped = [];
  
        for (const fanId of fanIds) {
          if (activeByFan.has(String(fanId))) {
            skipped.push({ fanId, code: "ACTIVE_OR_ALREADY_QUEUED", status: activeByFan.get(String(fanId))?.status || null });
            continue;
          }
  
          const scheduledAt = new Date(Math.max(cursor.getTime(), now.getTime()));
          const item = await tx.automationDelivery.create({
            data: {
              agencyId: req.auth.agencyId,
              creatorId,
              fanId,
              dialogId: fanId,
              trigger: triggerKey,
              status: "online_queued",
              scheduledAt,
              maxAttempts: 3,
              claimedByDeviceId: null,
              result: jsonObject({
                onlineQueue: triggerKey === BUMP_TRIGGER_KEYS.ONLINE,
                eventQueue: true,
                triggerKey,
                trigger: triggerKey,
                eventType: req.body?.event?.type || req.body?.eventType || null,
                externalEventId: req.body?.event?.externalEventId || req.body?.externalEventId || null,
                batchId,
                sourceDeviceId: deviceId,
                minFanSpacingSec: range.min,
                maxFanSpacingSec: range.max,
                queuedAt: now.toISOString(),
              }),
              createdByUserId: req.auth.userId,
            },
          });
          items.push(item);
          activeByFan.set(String(fanId), item);
          cursor = new Date(scheduledAt.getTime() + randomOnlineSpacingMs(range));
        }
  
        await tx.automationDelivery.update({
          where: { id: gate.id },
          data: {
            scheduledAt: cursor,
            result: jsonObject({ ...deliveryMeta(gate), eventGate: true, onlineGate: true, gateScope: "live", nextAllowedAt: cursor.toISOString(), minFanSpacingSec: range.min, maxFanSpacingSec: range.max, updatedAt: now.toISOString(), gateWasClamped }),
          },
        });
  
        const nextScheduledAt = items[0]?.scheduledAt || await tx.automationDelivery.findFirst({
          where: { agencyId: req.auth.agencyId, creatorId, status: "online_queued" },
          orderBy: { scheduledAt: "asc" },
          select: { scheduledAt: true },
        }).then((x) => x?.scheduledAt || null);
  
        return { items, skipped, nextScheduledAt, gateNextAllowedAt: cursor };
      }, { timeout: 15000 });
  
      return res.json({
        ok: true,
        creatorId,
        mode: "server_event_queue",
        triggerKey,
        count: result.items.length,
        items: result.items.map(mapAutomationDelivery),
        skipped: result.skipped,
        skippedCount: result.skipped.length,
        nextScheduledAt: result.nextScheduledAt ? result.nextScheduledAt.toISOString() : null,
        gateNextAllowedAt: result.gateNextAllowedAt ? result.gateNextAllowedAt.toISOString() : null,
        liveGateMaxCarrySec: 60,
        minFanSpacingSec: range.min,
        maxFanSpacingSec: range.max,
      });
    } catch (err) { return sendError(res, err, "BUMP_EVENT_BATCH_FAILED"); }
  });
  
  router.post("/deliveries/claim-online-send", async (req, res) => {
    try {
      const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
      await requireCreator(prisma, req.auth.agencyId, creatorId);
      const deviceId = cleanString(req.body?.deviceId || req.body?.claimedByDeviceId || "unknown", 120) || "unknown";
      const limit = parseLimit(req.body?.limit, 1, 10);
      const timeoutSec = Math.max(30, Math.min(1800, positiveInt(req.body?.claimTimeoutSec, 180)));
      const now = new Date();
      const claimUntil = new Date(now.getTime() + timeoutSec * 1000);
  
      // v19.33.7: repair stale online send reservations before claiming.
      // Older desktop builds could create `send_reserved` rows with no claimUntil
      // (legacy realtime reservation fallback). Those rows never expired and fell
      // out of the normal claim flow forever. Treat every expired/null lease on
      // online_claimed/send_reserved as retryable queue work.
      await prisma.automationDelivery.updateMany({
        where: {
          agencyId: req.auth.agencyId,
          creatorId,
          status: { in: ["online_claimed", "send_reserved"] },
          OR: [
            { claimUntil: { lt: now } },
            { claimUntil: null },
          ],
        },
        data: {
          status: "online_queued",
          sentAt: null,
          claimedByDeviceId: null,
          claimedAt: null,
          claimUntil: null,
          lastCheckedAt: now,
          scheduledAt: now,
          error: "stale online/send reservation repaired; returned to queue",
        },
      }).catch(() => null);
  
      // v19.33.4: a backlog of hiddenOnlineSignal rows must not keep fresh
      // fanOnline/fanSubscribed/fanLikedPost rows behind it. scheduledAt still
      // controls the configured online delay; among rows already due, claim by
      // business priority first, then by scheduledAt. Fetch a wider window because
      // old hidden rows can otherwise hide newer realtime rows from the candidate set.
      const candidates = await prisma.automationDelivery.findMany({
        where: { agencyId: req.auth.agencyId, creatorId, status: "online_queued", scheduledAt: { lte: now } },
        orderBy: [{ scheduledAt: "asc" }, { createdAt: "asc" }],
        take: Math.max(limit * 100, 100),
      });
      candidates.sort(sortAutomationSendCandidates);
  
      const items = [];
      for (const candidate of candidates) {
        if (items.length >= limit) break;
        const updated = await prisma.automationDelivery.updateMany({
          where: { id: candidate.id, agencyId: req.auth.agencyId, creatorId, status: "online_queued", OR: [{ claimUntil: null }, { claimUntil: { lt: now } }] },
          data: { status: "online_claimed", claimedByDeviceId: deviceId, claimedAt: now, claimUntil, lastCheckedAt: now, attempts: { increment: 1 }, error: null },
        });
        if (updated.count > 0) {
          const row = await prisma.automationDelivery.findUnique({ where: { id: candidate.id } });
          if (row) items.push(mapAutomationDelivery(row));
        }
      }
  
      const next = await prisma.automationDelivery.findFirst({
        where: { agencyId: req.auth.agencyId, creatorId, status: "online_queued" },
        orderBy: { scheduledAt: "asc" },
        select: { scheduledAt: true },
      });
  
      return res.json({ ok: true, creatorId, deviceId, count: items.length, items, claimUntil, nextScheduledAt: next?.scheduledAt ? next.scheduledAt.toISOString() : null });
    } catch (err) { return sendError(res, err, "BUMP_ONLINE_CLAIM_FAILED"); }
  });
  
  router.post("/deliveries/online-send-result", async (req, res) => {
    try {
      const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
      await requireCreator(prisma, req.auth.agencyId, creatorId);
      const id = cleanString(req.body?.id || req.body?.deliveryId || req.body?.serverDeliveryId, 120);
      if (!id) return res.status(400).json({ ok: false, code: "ONLINE_QUEUE_ID_MISSING", error: "delivery id is required" });
  
      const row = await prisma.automationDelivery.findFirst({
        where: { id, agencyId: req.auth.agencyId, creatorId, status: { in: ["online_claimed", "online_queued", "send_reserved", "pending_reply", "failed", "skipped", "retry_wait", "send_unknown"] } },
      });
      if (!row) return res.json({ ok: true, alreadyDone: true, item: null, code: "ONLINE_QUEUE_ROW_NOT_FOUND" });
  
      const status = cleanString(req.body?.status || (req.body?.ok === false ? "failed" : "done"), 40) || "done";
      const now = new Date();
      const inputResult = req.body?.result && typeof req.body.result === "object" && !Array.isArray(req.body.result) ? req.body.result : {};
      const resultItem = inputResult.item && typeof inputResult.item === "object" && !Array.isArray(inputResult.item) ? inputResult.item : {};
      const responseData = inputResult.data && typeof inputResult.data === "object" && !Array.isArray(inputResult.data) ? inputResult.data : {};
      const messageId = cleanString(req.body?.messageId || resultItem.messageId || inputResult.messageId || responseData.id || responseData.messageId, 100);
      const sentAt = parseDate(req.body?.sentAt || resultItem.sentAt || inputResult.sentAt || responseData.createdAt) || row.sentAt || now;
      const cancelAt = parseDate(req.body?.cancelAt || resultItem.cancelAt || inputResult.cancelAt) || row.cancelAt || null;
      const meta = jsonObject({
        ...deliveryMeta(row),
        ...inputResult,
        sendResultStatus: status,
        lastSendResultAt: now.toISOString(),
        workerDeviceId: req.body?.deviceId || row.claimedByDeviceId || null,
        messageId: messageId || row.messageId || null,
        lifecycle: status === "done" ? "waiting_reply" : "active",
      });
      const resultCode = automationResultCode(req.body || {}, meta);
  
      if (isSoftRetryResult(status, resultCode)) {
        const retryAt = automationRetryAt(req.body || {}, meta, resultCode === "BUMP_HOURLY_LIMIT" ? 60 * 60 * 1000 : 5 * 60 * 1000);
        const nextMeta = jsonObject({
          ...meta,
          lifecycle: "active",
          softRetry: true,
          retryReason: resultCode || status || "SOFT_RETRY",
          retryAt: retryAt.toISOString(),
          terminalAt: null,
          finalStatus: null,
        });
        const updated = await prisma.automationDelivery.updateMany({
          where: { id: row.id, agencyId: req.auth.agencyId, creatorId },
          data: {
            status: "online_queued",
            scheduledAt: retryAt,
            sentAt: null,
            claimedByDeviceId: null,
            claimedAt: null,
            claimUntil: null,
            lastCheckedAt: now,
            result: nextMeta,
            error: optionalString(resultCode || "soft retry; returned to queue", 2000),
          },
        });
        const item = updated.count > 0 ? await prisma.automationDelivery.findUnique({ where: { id: row.id } }).catch(() => null) : null;
        return res.json({ ok: true, compacted: false, requeued: true, status: "online_queued", retryAt: retryAt.toISOString(), item: item ? mapAutomationDelivery(item) : null, deliveryId: row.id, result: nextMeta, code: resultCode || "SOFT_RETRY" });
      }
  
      if (isSendUnknownResult(status, resultCode, req.body || {}, meta)) {
        const verifyAt = automationRetryAt(req.body || {}, meta, 5 * 60 * 1000);
        const nextMeta = jsonObject({
          ...meta,
          lifecycle: "send_unknown",
          sendUnknown: true,
          verifyAt: verifyAt.toISOString(),
          retryAt: verifyAt.toISOString(),
          retryReason: resultCode || status || "SEND_UNKNOWN",
          terminalAt: null,
          finalStatus: null,
        });
        const updated = await prisma.automationDelivery.updateMany({
          where: { id: row.id, agencyId: req.auth.agencyId, creatorId },
          data: {
            status: "send_unknown",
            scheduledAt: verifyAt,
            claimedByDeviceId: null,
            claimedAt: null,
            claimUntil: null,
            lastCheckedAt: now,
            result: nextMeta,
            error: optionalString(req.body?.error || inputResult.error || resultCode || "send result unknown; verification required", 2000),
          },
        });
        const item = updated.count > 0 ? await prisma.automationDelivery.findUnique({ where: { id: row.id } }).catch(() => null) : null;
        return res.json({ ok: true, compacted: false, sendUnknown: true, status: "send_unknown", verifyAt: verifyAt.toISOString(), item: item ? mapAutomationDelivery(item) : null, deliveryId: row.id, result: nextMeta, code: resultCode || "SEND_UNKNOWN" });
      }
  
      if (status === "done") {
        if (!messageId && !row.messageId) {
          // Do not create a pending_reply that cannot ever be cancelled/checked.
          // Requeue with a short delay and explicit error instead.
          const nextAt = new Date(now.getTime() + 120 * 1000);
          const updated = await prisma.automationDelivery.updateMany({
            where: { id: row.id, agencyId: req.auth.agencyId, creatorId },
            data: {
              status: "online_queued",
              scheduledAt: nextAt,
              sentAt: null,
              claimedByDeviceId: null,
              claimedAt: null,
              claimUntil: null,
              lastCheckedAt: now,
              result: jsonObject({ ...meta, sendResultProblem: "missing_message_id", retryAt: nextAt.toISOString() }),
              error: "online send returned done without messageId; returned to queue",
            },
          });
          const item = updated.count > 0 ? await prisma.automationDelivery.findUnique({ where: { id: row.id } }).catch(() => null) : null;
          return res.json({ ok: true, repaired: true, requeued: true, status: "online_queued", item: item ? mapAutomationDelivery(item) : null, code: "ONLINE_SEND_DONE_WITHOUT_MESSAGE_ID" });
        }
  
        const updated = await prisma.automationDelivery.updateMany({
          where: { id: row.id, agencyId: req.auth.agencyId, creatorId },
          data: {
            status: "pending_reply",
            messageId: messageId || row.messageId,
            sentAt,
            cancelAt,
            claimedByDeviceId: null,
            claimedAt: null,
            claimUntil: null,
            lastCheckedAt: now,
            result: meta,
            error: null,
          },
        });
        const item = updated.count > 0 ? await prisma.automationDelivery.findUnique({ where: { id: row.id } }).catch(() => null) : null;
        if (item) {
          await logAutomationActivitySafe({
            req,
            creatorId,
            module: automationActivityModuleForDelivery(item),
            action: "sent",
            status: "ok",
            row: item,
            input: { ...(req.body || {}), messageId: messageId || row.messageId, amountCents: item.priceCents || 0 },
            metadata: { resultCode: resultCode || "BUMP_SENT", sentAt: sentAt?.toISOString?.() || sentAt, cancelAt: cancelAt?.toISOString?.() || cancelAt },
          });
        }
        return res.json({ ok: true, compacted: false, status: "pending_reply", item: item ? mapAutomationDelivery(item) : null, deliveryId: row.id, result: meta });
      }
  
      if (status === "skipped") {
        const final = await markAutomationDeliveryTerminal({ req, creatorId, row, status: "skipped", input: { ...(req.body || {}), result: meta }, source: "online_send_result_skipped" });
        return res.json({ ...final, deliveryId: row.id });
      }
  
      const attempts = Math.max(0, Number(row.attempts || 0));
      const maxAttempts = Math.max(1, Math.min(50, Number(row.maxAttempts || 5)));
      if (attempts >= maxAttempts) {
        const final = await markAutomationDeliveryTerminal({ req, creatorId, row, status: "failed", input: { ...(req.body || {}), result: meta }, source: "online_send_result_max_attempts" });
        return res.json({ ...final, deliveryId: row.id, maxAttemptsReached: true });
      }
  
      const retryAt = new Date(now.getTime() + Math.min(15 * 60 * 1000, Math.max(30 * 1000, attempts * 60 * 1000)));
      const updated = await prisma.automationDelivery.updateMany({
        where: { id: row.id, agencyId: req.auth.agencyId, creatorId },
        data: {
          status: "online_queued",
          scheduledAt: retryAt,
          claimedByDeviceId: null,
          claimedAt: null,
          claimUntil: null,
          lastCheckedAt: now,
          result: jsonObject({ ...meta, retryAt: retryAt.toISOString(), retryReason: status || "failed" }),
          error: optionalString(req.body?.error || inputResult.error || inputResult.code || "online send failed; returned to queue", 2000),
        },
      });
      const item = updated.count > 0 ? await prisma.automationDelivery.findUnique({ where: { id: row.id } }).catch(() => null) : null;
      return res.json({ ok: true, compacted: false, requeued: true, status: "online_queued", retryAt: retryAt.toISOString(), item: item ? mapAutomationDelivery(item) : null, deliveryId: row.id, result: meta });
    } catch (err) { return sendError(res, err, "BUMP_ONLINE_RESULT_FAILED"); }
  });
  
  // Distributed bump cancel queue. Active AutomationDelivery rows are the queue:
  // pending_reply rows become claimable after cancelAt; a worker gets a short lease,
  // verifies reply, deletes the OF message if needed, then reports a terminal result.
  router.post("/deliveries/claim-cancel", async (req, res) => {
    try {
      const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
      await requireCreator(prisma, req.auth.agencyId, creatorId);
      const deviceId = cleanString(req.body?.deviceId || req.body?.claimedByDeviceId || "unknown", 120) || "unknown";
      const limit = parseLimit(req.body?.limit, 20, 100);
      const timeoutSec = Math.max(30, Math.min(3600, positiveInt(req.body?.claimTimeoutSec, 120)));
      const now = new Date();
      const claimUntil = new Date(now.getTime() + timeoutSec * 1000);
      const fallbackReplyTimeoutHours = Math.max(1, Math.min(72, Number(req.body?.fallbackReplyTimeoutHours || 5)));
      const fallbackBefore = new Date(now.getTime() - fallbackReplyTimeoutHours * 60 * 60 * 1000);
  
      // Dead worker recovery: release expired leases back into pending queue.
      await prisma.automationDelivery.updateMany({
        where: {
          agencyId: req.auth.agencyId,
          creatorId,
          status: "cancel_claimed",
          OR: [{ claimUntil: { lt: now } }, { claimUntil: null, updatedAt: { lt: new Date(now.getTime() - timeoutSec * 1000) } }],
        },
        data: {
          status: "pending_reply",
          claimedByDeviceId: null,
          claimedAt: null,
          claimUntil: null,
          error: "cancel claim expired; returned to queue",
        },
      }).catch(() => null);
  
      const candidates = await prisma.automationDelivery.findMany({
        where: {
          agencyId: req.auth.agencyId,
          creatorId,
          status: { in: ["pending_reply", "sent", "checking_reply"] },
          OR: [
            { cancelAt: { lte: now } },
            // Rows created before cancelAt migration: safe fallback, same old default timeout.
            { cancelAt: null, sentAt: { lte: fallbackBefore } },
          ],
        },
        orderBy: [{ cancelAt: "asc" }, { sentAt: "asc" }, { createdAt: "asc" }],
        take: Math.max(limit * 6, limit),
      });
  
      const items = [];
      const skippedMaxAttempts = [];
      for (const candidate of candidates) {
        if (items.length >= limit) break;
        const maxAttempts = Math.max(1, Math.min(50, Number(candidate.maxAttempts || 5)));
        const attempts = Math.max(0, Number(candidate.attempts || 0));
        if (attempts >= maxAttempts) {
          await markAutomationDeliveryTerminal({
            req,
            creatorId,
            row: candidate,
            status: "failed",
            input: { result: { reason: "cancel_max_attempts", attempts, maxAttempts }, failedAt: now.toISOString() },
            source: "cancel_claim_max_attempts",
          }).catch(() => null);
          skippedMaxAttempts.push(candidate.id);
          continue;
        }
        const updated = await prisma.automationDelivery.updateMany({
          where: {
            id: candidate.id,
            agencyId: req.auth.agencyId,
            creatorId,
            status: { in: ["pending_reply", "sent", "checking_reply"] },
            OR: [{ claimUntil: null }, { claimUntil: { lt: now } }],
          },
          data: {
            status: "cancel_claimed",
            claimedByDeviceId: deviceId,
            claimedAt: now,
            claimUntil,
            lastCheckedAt: now,
            attempts: { increment: 1 },
            error: null,
          },
        });
        if (updated.count > 0) {
          const row = await prisma.automationDelivery.findUnique({ where: { id: candidate.id } });
          if (row) items.push(mapAutomationDelivery(row));
        }
      }
  
      return res.json({ ok: true, creatorId, deviceId, count: items.length, items, claimUntil, skippedMaxAttemptsCount: skippedMaxAttempts.length });
    } catch (err) { return sendError(res, err, "BUMP_CANCEL_CLAIM_FAILED"); }
  });
  
  router.post("/deliveries/cancel-result", async (req, res) => {
    try {
      const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
      await requireCreator(prisma, req.auth.agencyId, creatorId);
      const existing = await findAutomationDeliveryForResult({ agencyId: req.auth.agencyId, creatorId, input: req.body || {} });
      if (!existing) {
        return res.json({ ok: true, alreadyCompacted: true, item: null, code: "DELIVERY_NOT_FOUND_OR_ALREADY_TERMINAL" });
      }
  
      const status = bumpStatStatus(req.body?.status || (req.body?.ok === false ? "failed" : "canceled"));
      const now = new Date();
      const prevMeta = deliveryMeta(existing);
      const mergedResult = jsonObject({
        ...prevMeta,
        ...(req.body?.result && typeof req.body.result === "object" && !Array.isArray(req.body.result) ? req.body.result : {}),
        finalSource: req.body?.source || req.body?.replySource || req.body?.cancelSource || "server_cancel_worker",
        finalStatus: status,
        finalizedAt: req.body?.finalizedAt || req.body?.repliedAt || req.body?.canceledAt || req.body?.failedAt || now.toISOString(),
        replyMessageId: req.body?.replyMessageId || prevMeta.replyMessageId || null,
        deleteVerified: req.body?.deleteVerified ?? prevMeta.deleteVerified ?? null,
        workerDeviceId: req.body?.deviceId || req.body?.claimedByDeviceId || existing.claimedByDeviceId || null,
      });
  
      if (BUMP_TERMINAL_DELIVERY_STATUSES.has(status)) {
        const final = await markAutomationDeliveryTerminal({ req, creatorId, row: existing, status, input: { ...(req.body || {}), result: mergedResult }, source: "cancel_result_terminal" });
        return res.json({ ...final, deliveryId: existing.id, templateId: deliveryTemplateId(existing) });
      }
  
      // Non-terminal result means transient failure / release lease back into queue.
      const nextStatus = status === "cancel_claimed" ? "cancel_claimed" : "pending_reply";
      const updated = await prisma.automationDelivery.updateMany({
        where: { id: existing.id, agencyId: req.auth.agencyId, creatorId },
        data: {
          status: nextStatus,
          claimedByDeviceId: nextStatus === "cancel_claimed" ? existing.claimedByDeviceId : null,
          claimedAt: nextStatus === "cancel_claimed" ? existing.claimedAt : null,
          claimUntil: nextStatus === "cancel_claimed" ? existing.claimUntil : null,
          lastCheckedAt: now,
          result: mergedResult,
          error: optionalString(req.body?.error || req.body?.lastError || null, 2000),
        },
      });
      const item = updated.count > 0 ? await prisma.automationDelivery.findUnique({ where: { id: existing.id } }).catch(() => null) : null;
      return res.json({ ok: true, compacted: false, item: item ? mapAutomationDelivery(item) : null, released: nextStatus === "pending_reply" });
    } catch (err) { return sendError(res, err, "BUMP_CANCEL_RESULT_FAILED"); }
  });
  
}

module.exports = { registerDeliveryRoutes };

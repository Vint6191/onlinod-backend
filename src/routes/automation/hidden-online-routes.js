"use strict";

function registerHiddenOnlineRoutes(router, deps) {
  const {
    prisma, cleanString, optionalString, jsonArray, jsonObject, parseLimit, parseOffset, positiveInt, requireCreator, sendError, requireSeniorAutomationWriter,
    parseDate, dateIso, deliveryMeta, mapAutomationDelivery, createAutomationDeliverySafe, onlineSpacingRange, randomOnlineSpacingMs, acquireOnlineGate, onlineGateNextAllowed,
    ONLINE_SEND_ACTIVE_STATUSES, BUMP_TRIGGER_KEYS,
  } = deps;

// Hidden online is intentionally server-owned: desktop workers only claim scan
  // chunks and upload compact candidate rows. We keep one mutable row per fan in
  // HiddenOnlineUser and reuse AutomationDelivery as the distributed job/queue
  // table, so no local-only state and no event-log explosion.
  const HIDDEN_SCAN_STATUSES = ["hidden_scan_queued", "hidden_scan_claimed", "hidden_scan_paused"];
  
  function hiddenScanJobId(creatorId) {
    return `hidden_scan_${String(creatorId || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 90)}`;
  }
  
  function hiddenScanState(row = {}) {
    const meta = deliveryMeta(row);
    const rawStatus = String(row?.status || "").toLowerCase();
    const out = meta && typeof meta === "object" && !Array.isArray(meta) ? { ...meta } : {};
  
    // Expose server job status to desktop UI. The previous version returned only
    // row.result, so freshly queued/claimed jobs could look idle until the first
    // progress page was posted. Hidden scan is server-owned, so the visible
    // progress state must reflect AutomationDelivery.status too.
    if (!out.status) {
      if (rawStatus === "hidden_scan_claimed") out.status = "running";
      else if (rawStatus === "hidden_scan_queued") out.status = "queued";
      else if (rawStatus === "hidden_scan_paused") out.status = "paused";
      else if (rawStatus === "hidden_scan_done") out.status = "done";
      else if (rawStatus === "failed") out.status = "failed";
      else if (rawStatus) out.status = rawStatus;
      else out.status = "idle";
    }
  
    out.serverStatus = rawStatus || out.serverStatus || null;
    if (row?.id && !out.jobId) out.jobId = row.id;
    if (row?.scheduledAt && !out.nextScanAt) out.nextScanAt = row.scheduledAt.toISOString ? row.scheduledAt.toISOString() : row.scheduledAt;
    if (row?.claimedByDeviceId && !out.claimedByDeviceId) out.claimedByDeviceId = row.claimedByDeviceId;
    if (row?.claimUntil && !out.claimUntil) out.claimUntil = row.claimUntil.toISOString ? row.claimUntil.toISOString() : row.claimUntil;
    if (row?.lastCheckedAt && !out.lastCheckedAt) out.lastCheckedAt = row.lastCheckedAt.toISOString ? row.lastCheckedAt.toISOString() : row.lastCheckedAt;
    if (row?.error && !out.lastError) out.lastError = row.error;
  
    return out;
  }
  
  function hiddenCandidateMoneyCents(input = {}) {
    const metadata = jsonObject(input.metadata || {});
    const raw = jsonObject(input.raw || input.payload || {});
    const d = jsonObject(input.subscribedOnData || raw.subscribedOnData || metadata.subscribedOnData || {});
    const moneyNumber = (value) => {
      if (value === undefined || value === null || value === "") return 0;
      if (typeof value === "string") return Number(value.replace(/[^\d.,-]/g, "").replace(",", ".")) || 0;
      return Number(value) || 0;
    };
    const cents = Math.max(
      moneyNumber(input.totalSpentCents),
      moneyNumber(input.spendTotalCents),
      moneyNumber(input.spentCents),
      moneyNumber(metadata.totalSpentCents),
      moneyNumber(raw.totalSpentCents),
      moneyNumber(raw.spendTotalCents),
      moneyNumber(raw.spentCents)
    );
    if (cents > 0) return Math.round(cents);
    const dollars = Math.max(
      moneyNumber(d.totalSumm ?? input.totalSumm ?? metadata.totalSumm ?? raw.totalSumm ?? input.totalSpent ?? raw.totalSpent),
      moneyNumber(d.messagesSumm ?? input.messagesSumm ?? metadata.messagesSumm ?? raw.messagesSumm) +
        moneyNumber(d.tipsSumm ?? input.tipsSumm ?? metadata.tipsSumm ?? raw.tipsSumm) +
        moneyNumber(d.postsSumm ?? input.postsSumm ?? metadata.postsSumm ?? raw.postsSumm) +
        moneyNumber(d.streamsSumm ?? input.streamsSumm ?? metadata.streamsSumm ?? raw.streamsSumm) +
        moneyNumber(d.subscribesSumm ?? input.subscribesSumm ?? metadata.subscribesSumm ?? raw.subscribesSumm)
    );
    return dollars > 0 ? Math.round(dollars * 100) : 0;
  }
  
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
      messagesSpentCents: Math.max(0, Math.round(Number(src.messagesSpentCents || 0) || automationIntelNumber(src.messagesSumm, 0) * 100)),
      tipsSpentCents: Math.max(0, Math.round(Number(src.tipsSpentCents || 0) || automationIntelNumber(src.tipsSumm, 0) * 100)),
      postsSpentCents: Math.max(0, Math.round(Number(src.postsSpentCents || 0) || automationIntelNumber(src.postsSumm, 0) * 100)),
      streamsSpentCents: Math.max(0, Math.round(Number(src.streamsSpentCents || 0) || automationIntelNumber(src.streamsSumm, 0) * 100)),
      subscribesSpentCents: Math.max(0, Math.round(Number(src.subscribesSpentCents || 0) || automationIntelNumber(src.subscribesSumm, 0) * 100)),
      joinDate: optionalString(src.joinDate, 80),
      lastSeen: optionalString(src.lastSeen, 80),
      canChat: src.canChat === undefined ? null : src.canChat !== false,
      canReceiveChatMessage: src.canReceiveChatMessage === undefined ? null : src.canReceiveChatMessage !== false,
      isBlocked: src.isBlocked === true,
      isRestricted: src.isRestricted === true,
      isPerformer: src.isPerformer === true,
      isVerified: src.isVerified === true,
      canEarn: src.canEarn === true,
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
  
  function hiddenCandidateStatus(value) {
    const s = cleanString(value || "active", 40).toLowerCase() || "active";
    if (["ignored", "blocked", "removed", "excluded"].includes(s)) return s;
    if (["queued", "cooling", "eligible"].includes(s)) return "active";
    return "active";
  }
  
  function hiddenCandidateCompact(input = {}) {
    const fanId = cleanString(input.fanId || input.userId || input.id || input.dialogId, 80);
    if (!fanId) return null;
    const metadata = jsonObject(input.metadata || {});
    const now = new Date().toISOString();
    return {
      fanId,
      dialogId: optionalString(input.dialogId || input.withUserId || fanId, 80),
      username: optionalString(input.username || input.fanUsername, 120),
      name: optionalString(input.name || input.fanName || input.displayName, 180),
      totalSpentCents: hiddenCandidateMoneyCents(input),
      status: hiddenCandidateStatus(input.status),
      lastSignalAt: parseDate(input.lastSignalAt || input.lastScannedAt || input.scannedAt) || new Date(),
      metadata: {
        ...metadata,
        source: metadata.source || input.source || "hidden_online_scan",
        reason: metadata.reason || input.reason || "hidden lastSeen=null",
        lastScannedAt: input.lastScannedAt || input.scannedAt || now,
        lastSeen: input.lastSeen === undefined ? (metadata.lastSeen ?? null) : input.lastSeen,
        canReceiveChatMessage: input.canReceiveChatMessage ?? metadata.canReceiveChatMessage ?? null,
        lastOutgoingAt: input.lastOutgoingAt || metadata.lastOutgoingAt || null,
        lastIncomingAt: input.lastIncomingAt || metadata.lastIncomingAt || null,
        nextEligibleAt: input.nextEligibleAt || metadata.nextEligibleAt || null,
        lastHiddenQueuedAt: input.lastHiddenQueuedAt || metadata.lastHiddenQueuedAt || null,
        hiddenCadenceHours: Number(input.hiddenCadenceHours || metadata.hiddenCadenceHours || 3) || 3,
      },
    };
  }
  
  async function upsertHiddenCandidateRows({ agencyId, creatorId, items = [], scanJobId = null }) {
    const out = { inserted: 0, updated: 0, items: [] };
    for (const raw of Array.isArray(items) ? items : []) {
      const item = hiddenCandidateCompact(raw);
      if (!item?.fanId) continue;
      const existing = await prisma.hiddenOnlineUser.findUnique({ where: { creatorId_fanId: { creatorId, fanId: item.fanId } } }).catch(() => null);
      const prevMeta = existing?.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata) ? existing.metadata : {};
      const status = existing && ["ignored", "blocked", "removed", "excluded"].includes(String(existing.status || ""))
        ? existing.status
        : item.status;
      const saved = await prisma.hiddenOnlineUser.upsert({
        where: { creatorId_fanId: { creatorId, fanId: item.fanId } },
        create: {
          agencyId,
          creatorId,
          fanId: item.fanId,
          dialogId: item.dialogId,
          username: item.username,
          name: item.name,
          totalSpentCents: item.totalSpentCents,
          status,
          signals: [],
          metadata: jsonObject({ ...item.metadata, scanJobId }),
          lastSignalAt: item.lastSignalAt,
        },
        update: {
          dialogId: item.dialogId || undefined,
          username: item.username || undefined,
          name: item.name || undefined,
          totalSpentCents: raw?.totalSpentCents === undefined && raw?.spendTotalCents === undefined && raw?.spentCents === undefined ? undefined : item.totalSpentCents,
          status,
          // Keep compact. Do not append signal history here.
          signals: [],
          metadata: jsonObject({ ...prevMeta, ...item.metadata, scanJobId }),
          lastSignalAt: item.lastSignalAt,
        },
      });
      if (existing?.id) out.updated += 1; else out.inserted += 1;
      out.items.push(saved);
    }
    return out;
  }
  
  router.post("/hidden-online/scan-jobs/enqueue", async (req, res) => {
    try {
      const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
      await requireCreator(prisma, req.auth.agencyId, creatorId);
      const now = new Date();
      const scanEveryDays = Math.max(1, Math.min(30, positiveInt(req.body?.scanEveryDays, 7)));
      const limit = Math.max(20, Math.min(100, positiveInt(req.body?.limit, 100)));
      const fullScan = req.body?.fullScan === true || req.body?.force === true;
      const id = hiddenScanJobId(creatorId);
      const existing = await prisma.automationDelivery.findUnique({ where: { id } }).catch(() => null);
      const prev = hiddenScanState(existing || {});
      const dueAt = existing?.scheduledAt || null;
      const manual = req.body?.manual === true;
      const due = !dueAt || dueAt <= now || manual || fullScan;
  
      // v19.34.9: hidden scan is one pass. A completed hasMore=false job must
      // stay done until its next scheduled scan or an explicit manual/full scan.
      // Older logic excluded hidden_scan_done from the not-due return path, so
      // every scheduler tick resurrected a completed scan and cursor/pages ran
      // away (offset 900k+ / pages 9000+ with only a few thousand scanned).
      if (existing?.id && String(existing.status || "") === "hidden_scan_done" && !due) {
        return res.json({
          ok: true,
          creatorId,
          item: mapAutomationDelivery(existing),
          queued: false,
          nextScanAt: dueAt?.toISOString?.() || prev.nextScanAt || null,
          code: "HIDDEN_SCAN_DONE_NOT_DUE",
          scanState: hiddenScanState(existing),
        });
      }
  
      if (existing?.id && !due && !["hidden_scan_paused", "failed"].includes(String(existing.status || ""))) {
        return res.json({ ok: true, creatorId, item: mapAutomationDelivery(existing), queued: false, nextScanAt: dueAt?.toISOString?.() || null, code: "HIDDEN_SCAN_NOT_DUE", scanState: hiddenScanState(existing) });
      }
  
      const prevPages = Math.max(0, Number(prev.pages || 0) || 0);
      const prevOffset = Math.max(0, Number(prev.nextOffset || prev.offset || 0) || 0);
      const prevScanned = Math.max(0, Number(prev.scanned || 0) || 0);
      const runawayCursor = (prevPages >= 2000 || prevOffset >= 200000) && (prevOffset <= 0 || (prevScanned / prevOffset) < 0.25);
  
      const state = jsonObject({
        ...prev,
        hiddenScan: true,
        scanEveryDays,
        limit,
        sourceType: cleanString(req.body?.type || req.body?.subscriberType || prev.sourceType || "all", 40) || "all",
        nextOffset: (fullScan || runawayCursor) ? 0 : Math.max(0, Number(prev.nextOffset || 0) || 0),
        fullScan,
        manual,
        repairedRunawayCursor: runawayCursor || undefined,
        enqueuedAt: now.toISOString(),
        lastError: null,
      });
      const hiddenScanData = {
        id,
        agencyId: req.auth.agencyId,
        creatorId,
        fanId: "__hidden_scan__",
        trigger: "hidden_online_scan",
        status: "hidden_scan_queued",
        scheduledAt: now,
        maxAttempts: 100000,
        result: state,
        createdByUserId: req.auth.userId || null,
      };
      const hiddenScanUpdate = {
        status: "hidden_scan_queued",
        scheduledAt: now,
        claimedByDeviceId: null,
        claimedAt: null,
        claimUntil: null,
        error: null,
        result: state,
      };
      const updatedScan = await prisma.automationDelivery.updateMany({
        where: { id, agencyId: req.auth.agencyId, creatorId },
        data: hiddenScanUpdate,
      });
      const item = updatedScan.count > 0
        ? await prisma.automationDelivery.findUnique({ where: { id } })
        : await createAutomationDeliverySafe(hiddenScanData);
      return res.json({ ok: true, creatorId, queued: true, item: mapAutomationDelivery(item), scanState: hiddenScanState(item) });
    } catch (err) { return sendError(res, err, "HIDDEN_SCAN_ENQUEUE_FAILED"); }
  });
  
  router.post("/hidden-online/scan-jobs/claim", async (req, res) => {
    try {
      const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
      await requireCreator(prisma, req.auth.agencyId, creatorId);
      const deviceId = cleanString(req.body?.deviceId || req.body?.claimedByDeviceId || "unknown", 120) || "unknown";
      const timeoutSec = Math.max(60, Math.min(3600, positiveInt(req.body?.claimTimeoutSec, 300)));
      const now = new Date();
      const claimUntil = new Date(now.getTime() + timeoutSec * 1000);
  
      await prisma.automationDelivery.updateMany({
        where: { agencyId: req.auth.agencyId, creatorId, status: "hidden_scan_claimed", OR: [{ claimUntil: { lt: now } }, { claimUntil: null, updatedAt: { lt: new Date(now.getTime() - timeoutSec * 1000) } }] },
        data: { status: "hidden_scan_queued", claimedByDeviceId: null, claimedAt: null, claimUntil: null, error: "hidden scan claim expired; returned to queue" },
      }).catch(() => null);
  
      const row = await prisma.automationDelivery.findFirst({
        where: { agencyId: req.auth.agencyId, creatorId, status: "hidden_scan_queued", scheduledAt: { lte: now }, trigger: "hidden_online_scan" },
        orderBy: [{ scheduledAt: "asc" }, { updatedAt: "asc" }],
      });
      if (!row) {
        const next = await prisma.automationDelivery.findFirst({ where: { agencyId: req.auth.agencyId, creatorId, trigger: "hidden_online_scan" }, orderBy: { scheduledAt: "asc" } });
        return res.json({ ok: true, creatorId, count: 0, items: [], item: null, nextScanAt: next?.scheduledAt ? next.scheduledAt.toISOString() : null });
      }
      const claimed = await prisma.automationDelivery.updateMany({
        where: { id: row.id, agencyId: req.auth.agencyId, creatorId, status: "hidden_scan_queued" },
        data: { status: "hidden_scan_claimed", claimedByDeviceId: deviceId, claimedAt: now, claimUntil, lastCheckedAt: now, attempts: { increment: 1 }, error: null },
      });
      if (claimed.count <= 0) return res.json({ ok: true, creatorId, count: 0, items: [], item: null, code: "HIDDEN_SCAN_CLAIM_RACE_LOST" });
      const updated = await prisma.automationDelivery.findUnique({ where: { id: row.id } });
      return res.json({ ok: true, creatorId, count: 1, item: mapAutomationDelivery(updated), items: [mapAutomationDelivery(updated)], scanState: hiddenScanState(updated), claimUntil });
    } catch (err) { return sendError(res, err, "HIDDEN_SCAN_CLAIM_FAILED"); }
  });
  
  router.post("/hidden-online/scan-jobs/progress", async (req, res) => {
    try {
      const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
      await requireCreator(prisma, req.auth.agencyId, creatorId);
      const id = cleanString(req.body?.jobId || req.body?.id || hiddenScanJobId(creatorId), 120);
      const now = new Date();
      const row = await prisma.automationDelivery.findFirst({ where: { id, agencyId: req.auth.agencyId, creatorId, trigger: "hidden_online_scan" } });
      if (!row) return res.status(404).json({ ok: false, code: "HIDDEN_SCAN_JOB_NOT_FOUND", error: "Hidden scan job not found" });
      const prev = hiddenScanState(row);
      const upsert = await upsertHiddenCandidateRows({ agencyId: req.auth.agencyId, creatorId, items: req.body?.items || req.body?.candidates || [], scanJobId: row.id });
      const scanned = Number(prev.scanned || 0) + Math.max(0, Number(req.body?.scanned || req.body?.pageSize || 0) || 0);
      const hiddenSeen = Number(prev.hiddenSeen || 0) + Math.max(0, Number(req.body?.hiddenSeen || upsert.items.length || 0) || 0);
      const pages = Number(prev.pages || 0) + Math.max(1, Number(req.body?.pages || 1) || 1);
      const hasMore = req.body?.hasMore === true;
      const done = req.body?.done === true || hasMore === false;
      const scanEveryDays = Math.max(1, Math.min(30, positiveInt(req.body?.scanEveryDays || prev.scanEveryDays, 7)));
      const nextOffset = Math.max(0, Number(req.body?.nextOffset ?? prev.nextOffset ?? 0) || 0);
      const errorText = cleanString(req.body?.error || "", 2000);
      const pauseForPriority = req.body?.pauseForPriority === true;
      const requestedBackoffMs = Math.max(0, Math.min(24 * 60 * 60 * 1000, Number(req.body?.backoffMs || req.body?.priorityPauseMs || 0) || 0));
      const runtimeAuthMissing = Boolean(errorText && /runtime auth context.*missing|auth context.*missing|runtime context.*missing/i.test(errorText)) || String(req.body?.workerStatus || "").toLowerCase().includes("auth_context_wait");
      const authBackoffMs = errorText && !runtimeAuthMissing && /invalid|expired|access token|auth|unauthorized|forbidden/i.test(errorText) ? 10 * 60 * 1000 : 0;
      const runtimeAuthBackoffMs = runtimeAuthMissing ? 5 * 60 * 1000 : 0;
      const browserBackoffMs = errorText && /browser tab.*not found|tab for account.*not found|account browser page.*not on onlyfans|page is not on onlyfans/i.test(errorText) ? 15 * 60 * 1000 : 0;
      const browserMissing = browserBackoffMs > 0 || String(req.body?.workerStatus || "").toLowerCase().includes("browser_tab_missing");
      const backoffMs = done ? 0 : Math.max(requestedBackoffMs, runtimeAuthBackoffMs, authBackoffMs, browserBackoffMs, pauseForPriority ? 45 * 1000 : 0);
      const stateStatus = done ? "done" : (backoffMs > 0 ? "cooldown" : "queued");
      const workerStatus = cleanString(req.body?.workerStatus || (runtimeAuthMissing ? "auth_context_wait" : browserMissing ? "browser_tab_missing" : pauseForPriority ? "paused_for_bumps" : (errorText ? "error_backoff" : "queued")), 80);
      const nextScheduledAt = done
        ? new Date(now.getTime() + scanEveryDays * 24 * 60 * 60 * 1000)
        : new Date(now.getTime() + (backoffMs > 0 ? backoffMs : 1000));
      const state = jsonObject({
        ...prev,
        scanned,
        hiddenSeen,
        inserted: Number(prev.inserted || 0) + upsert.inserted,
        updated: Number(prev.updated || 0) + upsert.updated,
        pages,
        nextOffset,
        hasMore,
        status: stateStatus,
        workerStatus,
        serverStatus: done ? "hidden_scan_done" : "hidden_scan_queued",
        claimedByDeviceId: null,
        claimedAt: null,
        claimUntil: null,
        // Do not keep a stale `local_bump_queue` pause reason after the page
        // finished. The UI used that stale reason to show a fake waiting-worker
        // state even while the scheduler was correctly processing scan pages.
        pauseReason: runtimeAuthMissing ? "runtime_auth_context_missing" : browserMissing ? "browser_tab_missing" : (pauseForPriority ? "local_bump_queue" : null),
        pausedForPriority: pauseForPriority || false,
        backoffMs: backoffMs || undefined,
        nextPageAt: done ? null : nextScheduledAt.toISOString(),
        nextScanAt: done ? nextScheduledAt.toISOString() : null,
        lastPageAt: now.toISOString(),
        finishedAt: done ? now.toISOString() : prev.finishedAt || null,
        lastError: errorText || null,
      });
      const progressed = await prisma.automationDelivery.updateMany({
        where: { id: row.id, agencyId: req.auth.agencyId, creatorId, trigger: "hidden_online_scan" },
        data: {
          status: done ? "hidden_scan_done" : "hidden_scan_queued",
          scheduledAt: nextScheduledAt,
          claimedByDeviceId: null,
          claimedAt: null,
          claimUntil: null,
          lastCheckedAt: now,
          result: state,
          error: req.body?.error ? optionalString(req.body.error, 2000) : null,
        },
      });
      const item = progressed.count > 0 ? await prisma.automationDelivery.findUnique({ where: { id: row.id } }).catch(() => null) : null;
      const counts = await prisma.hiddenOnlineUser.groupBy({ by: ["status"], where: { agencyId: req.auth.agencyId, creatorId }, _count: { _all: true } }).catch(() => []);
      return res.json({ ok: true, creatorId, item: item ? mapAutomationDelivery(item) : null, scanState: hiddenScanState(item), upsert, counts, nextScanAt: nextScheduledAt.toISOString(), raceLost: progressed.count <= 0 });
    } catch (err) { return sendError(res, err, "HIDDEN_SCAN_PROGRESS_FAILED"); }
  });
  
  router.get("/hidden-online/scan-state", async (req, res) => {
    try {
      const creatorId = cleanString(req.query.creatorId || req.query.accountId, 100);
      await requireCreator(prisma, req.auth.agencyId, creatorId);
      const job = await prisma.automationDelivery.findUnique({ where: { id: hiddenScanJobId(creatorId) } }).catch(() => null);
      const [total, active, ignored, blocked] = await Promise.all([
        prisma.hiddenOnlineUser.count({ where: { agencyId: req.auth.agencyId, creatorId } }),
        prisma.hiddenOnlineUser.count({ where: { agencyId: req.auth.agencyId, creatorId, status: "active" } }),
        prisma.hiddenOnlineUser.count({ where: { agencyId: req.auth.agencyId, creatorId, status: "ignored" } }),
        prisma.hiddenOnlineUser.count({ where: { agencyId: req.auth.agencyId, creatorId, status: "blocked" } }),
      ]);
      return res.json({ ok: true, creatorId, item: mapAutomationDelivery(job), scanState: hiddenScanState(job || {}), counts: { total, active, ignored, blocked } });
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
  
      const enriched = items.map((item) => {
        const fanId = String(item.fanId || "");
        const meta = jsonObject(item.metadata || {});
        const latest = latestHiddenByFan.get(fanId) || null;
        const active = activeHiddenByFan.get(fanId) || null;
        return mergeIntelIntoPublicRow({
          ...item,
          totalSpentCents: Number(item.totalSpentCents || 0) || hiddenCandidateMoneyCents(item),
          lastHiddenBumpAt: dateIso(latest?.sentAt) || dateIso(meta.lastHiddenSentAt) || dateIso(meta.lastHiddenQueuedAt) || automationDeliveryDateIso(latest) || null,
          lastHiddenQueuedAt: dateIso(meta.lastHiddenQueuedAt) || dateIso(latest?.createdAt) || null,
          lastHiddenStatus: latest?.status || meta.lastHiddenStatus || null,
          lastHiddenMessageId: latest?.messageId || meta.lastHiddenMessageId || null,
          lastHiddenDeliveryId: latest?.id || null,
          hiddenActiveStatus: active?.status || null,
          hiddenActiveDeliveryId: active?.id || null,
          nextEligibleAt: dateIso(meta.nextEligibleAt || meta.hiddenNextEligibleAt) || null,
        });
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
  
  
  router.post("/hidden-online/intel-bulk", async (req, res) => {
    try {
      const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
      await requireCreator(prisma, req.auth.agencyId, creatorId);
      const inputItems = Array.isArray(req.body?.items) ? req.body.items : [];
      const updated = [];
      for (const raw of inputItems.slice(0, 1000)) {
        const intel = compactAutomationFanIntel(raw);
        if (!intel?.fanId) continue;
        const existing = await prisma.hiddenOnlineUser.findUnique({
          where: { creatorId_fanId: { creatorId, fanId: intel.fanId } },
        });
        if (!existing || existing.agencyId !== req.auth.agencyId) continue;
        const prevMeta = jsonObject(existing.metadata || {});
        const name = intel.displayName || intel.name || existing.name || null;
        const next = await prisma.hiddenOnlineUser.update({
          where: { id: existing.id },
          data: {
            username: intel.username || existing.username || null,
            name,
            totalSpentCents: Math.max(Number(existing.totalSpentCents || 0), Number(intel.totalSpentCents || 0)),
            metadata: jsonObject({
              ...prevMeta,
              ...intel,
              fanIntel: intel,
              fanIntelFetchedAt: intel.fetchedAt,
            }),
          },
        });
        updated.push(mergeIntelIntoPublicRow(next));
      }
      return res.json({ ok: true, creatorId, count: updated.length, items: updated });
    } catch (err) { return sendError(res, err, "HIDDEN_ONLINE_INTEL_BULK_FAILED"); }
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

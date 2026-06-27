"use strict";

function createDeliveryHelpers(deps = {}) {
  const {
    prisma,
    automationServer,
    cleanString,
    optionalString,
    jsonArray,
    jsonObject,
    centsFromAny,
    positiveInt,
  } = deps;

  function parseDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d : null;
  }

  const BUMP_TERMINAL_DELIVERY_STATUSES = new Set(["replied", "canceled", "expired", "failed", "skipped"]);

  function bumpStatStatus(status) {
    const s = cleanString(status, 40).toLowerCase();
    if (s === "cancelled") return "canceled";
    return s;
  }

  async function refreshBumpTaskStats({ agencyId, creatorId, templateId }) {
    const cid = cleanString(creatorId, 100);
    const tid = cleanString(templateId, 100);
    if (!agencyId || !cid || !tid) return null;
    const rows = await prisma.bumpDeliveryStat.findMany({
      where: { agencyId, creatorId: cid, templateId: tid },
      select: { sent: true, replied: true, canceled: true, expired: true, failed: true, day: true },
      take: 10000}).catch(() => []);
    const today = new Date().toISOString().slice(0, 10);
    const stats = { sent: 0, replied: 0, canceled: 0, expired: 0, failed: 0, sentToday: 0, repliedToday: 0, lastStatAt: new Date().toISOString() };
    for (const row of rows || []) {
      const sent = Number(row.sent || 0);
      const replied = Number(row.replied || 0);
      stats.sent += sent;
      stats.replied += replied;
      stats.canceled += Number(row.canceled || 0);
      stats.expired += Number(row.expired || 0);
      stats.failed += Number(row.failed || 0);
      if (row.day === today) {
        stats.sentToday += sent;
        stats.repliedToday += replied;
      }
    }
    stats.replyRate = stats.sent > 0 ? Math.round((stats.replied / stats.sent) * 10000) / 10000 : 0;
    const task = await prisma.automationTask.findFirst({
      where: { agencyId, creatorId: cid, type: "bump_online", OR: [{ id: tid }, { clientId: tid }] },
      select: { id: true, stats: true },
    }).catch(() => null);
    if (!task?.id) return stats;
    const prev = task.stats && typeof task.stats === "object" && !Array.isArray(task.stats) ? task.stats : {};
    await prisma.automationTask.update({ where: { id: task.id }, data: { stats: { ...prev, ...stats } } }).catch(() => null);
    return stats;
  }


  function deliveryMeta(item = {}) {
    const result = item?.result && typeof item.result === "object" && !Array.isArray(item.result) ? item.result : {};
    return result;
  }

  function deliveryTemplateId(item = {}) {
    const meta = deliveryMeta(item);
    return cleanString(item.contentCollectionId || item.templateId || item.bumpId || meta.templateId || meta.bumpId || meta.clientId, 100) || "";
  }

  function deliveryCancelAt(item = {}) {
    const meta = deliveryMeta(item);
    return item.cancelAt || meta.cancelAt || null;
  }

  function automationDeliveryTriggerPriority(row = {}) {
    const meta = deliveryMeta(row);
    if (meta.manualUrgent === true || meta.manualHiddenBump === true || meta.urgent === true) return -5;
    const raw = String(row.trigger || row.eventType || row.triggerKey || meta.triggerKey || meta.trigger || "").trim();
    const lower = raw.toLowerCase();
    // v19.33.4 business order: once due, online is the hottest action.
    // scheduledAt still controls the configured online delay; this priority only
    // decides among rows that are already due.
    if (raw === "fanOnline" || lower.includes("online") || lower.includes("presence")) return 0;
    if (raw === "fanSubscribed" || lower.includes("subscrib") || lower.includes("new_sub")) return 10;
    if (raw === "fanLikedPost" || lower.includes("liked") || lower.includes("post_like") || lower.includes("favorite")) return 20;
    if (raw === "hiddenOnlineSignal" || lower.includes("hidden")) return 50;
    return 80;
  }

  function automationDeliveryTimeMs(value) {
    const t = new Date(value || 0).getTime();
    return Number.isFinite(t) ? t : 0;
  }

  function sortAutomationSendCandidates(a, b) {
    return (automationDeliveryTriggerPriority(a) - automationDeliveryTriggerPriority(b))
      || (automationDeliveryTimeMs(a.scheduledAt) - automationDeliveryTimeMs(b.scheduledAt))
      || (automationDeliveryTimeMs(a.createdAt) - automationDeliveryTimeMs(b.createdAt));
  }

  function mapAutomationDelivery(item = {}) {
    if (!item || typeof item !== "object") return item;
    const meta = deliveryMeta(item);
    const templateId = deliveryTemplateId(item);
    return {
      ...item,
      templateId,
      bumpId: templateId,
      localDeliveryId: meta.localDeliveryId || meta.localId || null,
      cancelAt: item.cancelAt || meta.cancelAt || null,
      claimUntil: item.claimUntil || meta.claimUntil || null,
      claimedByDeviceId: item.claimedByDeviceId || meta.claimedByDeviceId || null,
      claimedAt: item.claimedAt || meta.claimedAt || null,
    };
  }


  function automationActivityModuleForDelivery(row = {}) {
    const trig = String(row?.trigger || deliveryMeta(row)?.triggerKey || "").toLowerCase();
    return trig.includes("hidden") ? "hidden" : "bump";
  }

  async function logAutomationActivitySafe({ req, creatorId, module = "automation", action = "activity", status = "info", row = null, input = {}, metadata = {} } = {}) {
    try {
      const meta = {
        module,
        action,
        ...(metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {}),
      };
      if (row) {
        meta.deliveryId = row.id || meta.deliveryId || null;
        meta.templateId = deliveryTemplateId(row) || meta.templateId || null;
        meta.triggerKey = row.trigger || meta.triggerKey || null;
        meta.fanUsername = meta.fanUsername || deliveryMeta(row).fanUsername || deliveryMeta(row).username || null;
        meta.reason = meta.reason || input?.reason || input?.code || input?.error || row.error || null;
      }
      await automationServer.logEvent({
        agencyId: req.auth.agencyId,
        userId: req.auth.userId,
        input: {
          creatorId,
          accountId: creatorId,
          taskId: meta.templateId || input?.taskId || null,
          jobId: input?.jobId || meta.jobId || null,
          fanId: row?.fanId || input?.fanId || meta.fanId || null,
          dialogId: row?.dialogId || input?.dialogId || meta.dialogId || null,
          type: `${module}_${action}`,
          status,
          messageId: row?.messageId || input?.messageId || meta.messageId || null,
          amountCents: Number(input?.amountCents ?? row?.priceCents ?? meta.amountCents ?? 0) || 0,
          metadata: meta,
        },
      });
    } catch (_) {}
  }

  function compactTemplateIds(values = [], next = null, max = 50) {
    const out = [];
    const seen = new Set();
    const push = (value) => {
      const id = cleanString(value, 100);
      if (!id || seen.has(id)) return;
      seen.add(id);
      out.push(id);
    };
    push(next);
    for (const value of Array.isArray(values) ? values : []) push(value);
    return out.slice(0, Math.max(1, Math.min(200, Number(max) || 50)));
  }

  function dateIso(value) {
    const d = value instanceof Date ? value : parseDate(value);
    return d && Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }

  function maxIsoDate(...values) {
    let best = null;
    let bestMs = 0;
    for (const value of values) {
      const d = value instanceof Date ? value : parseDate(value);
      const ms = d && Number.isFinite(d.getTime()) ? d.getTime() : 0;
      if (ms > bestMs) { bestMs = ms; best = d; }
    }
    return best ? best.toISOString() : null;
  }

  function addHoursDate(value, hours) {
    const d = value instanceof Date ? value : parseDate(value);
    const h = Number(hours);
    if (!d || !Number.isFinite(d.getTime()) || !Number.isFinite(h) || h <= 0) return null;
    return new Date(d.getTime() + h * 60 * 60 * 1000);
  }

  function mapBumpFanState(row = {}) {
    if (!row || typeof row !== "object") return null;
    const counters = row.counters && typeof row.counters === "object" && !Array.isArray(row.counters) ? row.counters : {};
    return {
      id: row.id,
      creatorId: row.creatorId,
      fanId: row.fanId,
      dialogId: row.dialogId || row.fanId,
      lastTemplateId: row.lastTemplateId || null,
      lastStatus: row.lastStatus || null,
      lastSentAt: row.lastSentAt ? row.lastSentAt.toISOString() : null,
      lastFinalizedAt: row.lastFinalizedAt ? row.lastFinalizedAt.toISOString() : null,
      lastMessageId: row.lastMessageId || null,
      templateIds: Array.isArray(row.templateIds) ? row.templateIds : [],
      counters,
      // Compact fan quiet-window state. Kept in counters JSON to avoid another DB migration.
      lastRepliedAt: counters.lastRepliedAt || null,
      lastCanceledAt: counters.lastCanceledAt || null,
      lastExpiredAt: counters.lastExpiredAt || null,
      repliedCooldownUntil: counters.repliedCooldownUntil || null,
      sentCooldownUntil: counters.sentCooldownUntil || null,
      sameTemplateCooldownUntil: counters.sameTemplateCooldownUntil || null,
      nextAllowedAt: counters.nextAllowedAt || null,
      quietReason: counters.quietReason || null,
      updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
    };
  }

  async function upsertBumpFanState({
    agencyId,
    creatorId,
    fanId,
    dialogId = null,
    templateId = "",
    status = "sent",
    sentAt = null,
    finalizedAt = null,
    messageId = null,
    replyCooldownHours = 24,
    sentCooldownHours = 6,
    sameTemplateCooldownHours = null,
    nextAllowedAt = null,
    repliedCooldownUntil = null,
    sentCooldownUntil = null,
  }) {
    const cid = cleanString(creatorId, 100);
    const fid = cleanString(fanId, 80);
    if (!agencyId || !cid || !fid) return null;
    const tid = cleanString(templateId, 100) || "";
    const st = cleanString(status, 40) || "sent";
    const existing = await prisma.automationBumpFanState.findUnique({
      where: { creatorId_fanId: { creatorId: cid, fanId: fid } },
    }).catch(() => null);
    const templateIds = compactTemplateIds(existing?.templateIds || [], tid, 50);
    const sentDate = parseDate(sentAt) || existing?.lastSentAt || new Date();
    const finalizedDate = parseDate(finalizedAt) || (["replied", "canceled", "expired", "failed"].includes(st) ? new Date() : existing?.lastFinalizedAt || null);
    const prevCounters = existing?.counters && typeof existing.counters === "object" && !Array.isArray(existing.counters) ? existing.counters : {};

    const replyHours = Math.max(0, Math.min(2160, Number(replyCooldownHours ?? 24) || 24));
    const sentHours = Math.max(0, Math.min(720, Number(sentCooldownHours ?? 6) || 6));
    const sameTplHours = sameTemplateCooldownHours === null || sameTemplateCooldownHours === undefined
      ? null
      : Math.max(0, Math.min(8760, Number(sameTemplateCooldownHours) || 0));

    const computedSentUntil = addHoursDate(sentDate, sentHours);
    const computedReplyUntil = st === "replied" ? addHoursDate(finalizedDate || sentDate, replyHours) : null;
    const computedSameTemplateUntil = tid && sameTplHours !== null ? addHoursDate(sentDate, sameTplHours) : null;
    const explicitNextAllowedAt = parseDate(nextAllowedAt);
    const explicitRepliedUntil = parseDate(repliedCooldownUntil);
    const explicitSentUntil = parseDate(sentCooldownUntil);

    const nextAllowedIso = maxIsoDate(
      prevCounters.nextAllowedAt,
      explicitNextAllowedAt,
      explicitRepliedUntil,
      explicitSentUntil,
      computedReplyUntil,
      computedSentUntil
    );
    const repliedUntilIso = maxIsoDate(prevCounters.repliedCooldownUntil, explicitRepliedUntil, computedReplyUntil);
    const sentUntilIso = maxIsoDate(prevCounters.sentCooldownUntil, explicitSentUntil, computedSentUntil);
    const sameTemplateUntilIso = maxIsoDate(prevCounters.sameTemplateCooldownUntil, computedSameTemplateUntil);

    const counters = {
      ...prevCounters,
      lastSentAt: dateIso(sentDate) || prevCounters.lastSentAt || null,
      lastFinalizedAt: dateIso(finalizedDate) || prevCounters.lastFinalizedAt || null,
      lastStatus: st,
      lastMessageId: optionalString(messageId || existing?.lastMessageId, 100),
      lastTemplateId: tid || existing?.lastTemplateId || null,
      lastRepliedAt: st === "replied" ? (dateIso(finalizedDate) || new Date().toISOString()) : prevCounters.lastRepliedAt || null,
      lastCanceledAt: st === "canceled" ? (dateIso(finalizedDate) || new Date().toISOString()) : prevCounters.lastCanceledAt || null,
      lastExpiredAt: st === "expired" ? (dateIso(finalizedDate) || new Date().toISOString()) : prevCounters.lastExpiredAt || null,
      repliedCooldownUntil: repliedUntilIso || prevCounters.repliedCooldownUntil || null,
      sentCooldownUntil: sentUntilIso || prevCounters.sentCooldownUntil || null,
      sameTemplateCooldownUntil: sameTemplateUntilIso || prevCounters.sameTemplateCooldownUntil || null,
      nextAllowedAt: nextAllowedIso || prevCounters.nextAllowedAt || null,
      quietReason: computedReplyUntil ? "replied" : "sent",
      replyCooldownHours: replyHours,
      sentCooldownHours: sentHours,
      sameTemplateCooldownHours: sameTplHours,
      updatedAt: new Date().toISOString(),
    };

    const data = {
      agencyId,
      creatorId: cid,
      fanId: fid,
      dialogId: optionalString(dialogId || fid, 80),
      lastTemplateId: tid || existing?.lastTemplateId || null,
      lastStatus: st,
      lastSentAt: sentDate,
      lastFinalizedAt: finalizedDate,
      lastMessageId: optionalString(messageId || existing?.lastMessageId, 100),
      templateIds,
      counters,
    };
    const row = await prisma.automationBumpFanState.upsert({
      where: { creatorId_fanId: { creatorId: cid, fanId: fid } },
      create: data,
      update: { ...data, agencyId: undefined, creatorId: undefined, fanId: undefined },
    });
    return mapBumpFanState(row);
  }

  const STAT_EVENTS = new Set(["sent", "replied", "canceled", "expired", "failed"]);

  async function incrementBumpDeliveryStat({ agencyId, creatorId, templateId = "", day = null, event, by = 1 }) {
    const ev = bumpStatStatus(event);
    if (!STAT_EVENTS.has(ev)) {
      const err = new Error("Bad bump stat event");
      err.status = 400;
      err.code = "BAD_EVENT";
      throw err;
    }
    const cid = cleanString(creatorId, 100);
    const tid = cleanString(templateId, 100) || "";
    const statDay = cleanString(day, 10) || new Date().toISOString().slice(0, 10);
    const incBy = Math.max(1, Math.min(1000, positiveInt(by, 1)));

    const item = await prisma.bumpDeliveryStat.upsert({
      where: { creatorId_templateId_day: { creatorId: cid, templateId: tid, day: statDay } },
      create: {
        agencyId, creatorId: cid, templateId: tid, day: statDay,
        sent: ev === "sent" ? incBy : 0,
        replied: ev === "replied" ? incBy : 0,
        canceled: ev === "canceled" ? incBy : 0,
        expired: ev === "expired" ? incBy : 0,
        failed: ev === "failed" ? incBy : 0,
      },
      update: { [ev]: { increment: incBy } },
    });
    const taskStats = await refreshBumpTaskStats({ agencyId, creatorId: cid, templateId: tid });
    return { item, taskStats };
  }

  async function findAutomationDeliveryForResult({ agencyId, creatorId, input = {} }) {
    const id = cleanString(input.id || input.deliveryId || input.serverDeliveryId, 120);
    const messageId = cleanString(input.messageId, 100);
    if (id && !/^(bd_|local|tmp|temp)/i.test(id)) {
      const byId = await prisma.automationDelivery.findFirst({ where: { id, agencyId, creatorId } });
      if (byId) return byId;
    }
    if (messageId) {
      return prisma.automationDelivery.findFirst({ where: { agencyId, creatorId, messageId } });
    }
    return null;
  }


  // v19.34.0: AutomationDelivery state-machine guard.
  // This table is still used by legacy desktop clients, so the repair is intentionally
  // schema-free: terminal/lifecycle metadata lives in result JSON and terminal rows
  // are kept as tombstones instead of being deleted immediately.
  const AUTOMATION_SEND_CLAIM_STATUSES = new Set(["online_claimed", "send_reserved"]);
  const AUTOMATION_CANCEL_CLAIM_STATUSES = new Set(["cancel_claimed"]);
  const AUTOMATION_HIDDEN_SCAN_CLAIM_STATUSES = new Set(["hidden_scan_claimed"]);
  const AUTOMATION_ANY_CLAIM_STATUSES = new Set([
    ...AUTOMATION_SEND_CLAIM_STATUSES,
    ...AUTOMATION_CANCEL_CLAIM_STATUSES,
    ...AUTOMATION_HIDDEN_SCAN_CLAIM_STATUSES,
  ]);
  const AUTOMATION_TERMINAL_ROW_STATUSES = new Set(["replied", "canceled", "expired", "failed", "skipped"]);

  // v19.34.2: send results now distinguish hard terminal outcomes from
  // soft scheduling pressure and unknown post-send states. Soft limits stay in
  // the active queue; request timeouts become send_unknown so we never blindly
  // retry a message that OF may already have accepted.
  const AUTOMATION_SOFT_RETRY_CODES = new Set([
    "BUMP_HOURLY_LIMIT",
    "BUMP_DAILY_LIMIT",
    "BUMP_COOLDOWN",
    "LOCAL_BUMP_SEND_SPACING_WAIT",
    "LOCAL_BUMP_SEND_NOT_DUE",
    "BUMP_SEND_ALREADY_RUNNING",
    "BUMP_FAN_QUIET_WINDOW",
    "FAN_QUIET_WINDOW",
    "ACCOUNT_COOLDOWN",
    "BUMP_ACCOUNT_COOLDOWN",
    "BUMP_DELAYED_BY_SERVER_GATE",
  ]);
  const AUTOMATION_SEND_UNKNOWN_CODES = new Set([
    "REQUEST_TIMEOUT",
    "REQUEST_FAILED",
    "ONLINE_BUMP_SEND_EXCEPTION",
    "BROWSER_API_REQUEST_TIMEOUT",
    "NETWORK_ERROR",
    "ETIMEDOUT",
    "ECONNRESET",
  ]);

  function stripUndefinedFields(input = {}) {
    const out = {};
    for (const [key, value] of Object.entries(input || {})) {
      if (value !== undefined) out[key] = value;
    }
    return out;
  }

  function deliveryStatAlreadyCounted(row = {}) {
    const meta = deliveryMeta(row);
    return Boolean(meta.statCounted === true || meta.statCountedAt || meta.statCountedStatus);
  }

  function automationResultCode(input = {}, meta = {}) {
    return cleanString(
      input.code || input.resultCode || input.statusCode || input.errorCode ||
      meta.code || meta.resultCode || meta.statusCode || meta.errorCode ||
      meta.retryReason || meta.sendResultStatus || "",
      120
    ).toUpperCase();
  }

  function isSoftRetryResult(status = "", code = "") {
    const s = cleanString(status, 40).toLowerCase();
    const c = cleanString(code, 120).toUpperCase();
    return s === "retry_wait" || s === "soft_retry" || s === "soft_limited" || AUTOMATION_SOFT_RETRY_CODES.has(c);
  }

  function isSendUnknownResult(status = "", code = "", input = {}, meta = {}) {
    const s = cleanString(status, 40).toLowerCase();
    const c = cleanString(code, 120).toUpperCase();
    if (s === "send_unknown" || s === "unknown" || AUTOMATION_SEND_UNKNOWN_CODES.has(c)) return true;
    const text = String(input.error || input.message || meta.error || meta.message || meta.lastError || "").toLowerCase();
    return text.includes("timed out") || text.includes("timeout") || text.includes("network") || text.includes("socket hang up");
  }

  function automationRetryAt(input = {}, meta = {}, fallbackMs = 5 * 60 * 1000) {
    const raw = input.retryAt || input.nextScheduledAt || input.nextDueAt || input.nextAllowedAt ||
      meta.retryAt || meta.nextScheduledAt || meta.nextDueAt || meta.nextAllowedAt ||
      meta.quietUntil || meta.verifyAt || null;
    const parsed = parseDate(raw);
    if (parsed && parsed.getTime() > Date.now()) return parsed;
    const wait = Math.max(30 * 1000, Math.min(24 * 60 * 60 * 1000, Number(input.waitMs || input.retryAfterMs || meta.waitMs || meta.retryAfterMs || fallbackMs) || fallbackMs));
    return new Date(Date.now() + wait);
  }

  function normalizeDeliveryWriteData(data = {}) {
    const next = { ...(data || {}) };
    const status = bumpStatStatus(next.status || "");
    if (AUTOMATION_ANY_CLAIM_STATUSES.has(status) && (!next.claimUntil || !next.claimedByDeviceId)) {
      const meta = deliveryMeta(next);
      next.result = jsonObject({
        ...meta,
        leaseRejected: true,
        leaseRejectedAt: new Date().toISOString(),
        requestedStatus: status,
        leaseRejectedReason: "claimed/reserved status requires claimedByDeviceId and claimUntil",
      });
      if (AUTOMATION_CANCEL_CLAIM_STATUSES.has(status)) next.status = "pending_reply";
      else if (AUTOMATION_HIDDEN_SCAN_CLAIM_STATUSES.has(status)) next.status = "hidden_scan_queued";
      else next.status = "online_queued";
      next.claimedByDeviceId = null;
      next.claimedAt = null;
      next.claimUntil = null;
    }
    return next;
  }

  async function createAutomationDeliverySafe(data = {}) {
    try {
      return await prisma.automationDelivery.create({ data });
    } catch (err) {
      if (err?.code === "P2002" && data.id) {
        const existing = await prisma.automationDelivery.findUnique({ where: { id: data.id } }).catch(() => null);
        if (existing) return existing;
      }
      throw err;
    }
  }

  async function saveAutomationDeliveryIdempotent({ agencyId, creatorId, id = "", messageId = "", data = {}, updateData = {} }) {
    const safeData = normalizeDeliveryWriteData(data);
    const safeUpdate = stripUndefinedFields(normalizeDeliveryWriteData(updateData));
    const cid = cleanString(creatorId, 100);
    const did = cleanString(id, 120);
    const mid = cleanString(messageId, 100);

    if (did) {
      const updated = await prisma.automationDelivery.updateMany({
        where: { id: did, agencyId, creatorId: cid },
        data: safeUpdate,
      });
      if (updated.count > 0) {
        const row = await prisma.automationDelivery.findUnique({ where: { id: did } }).catch(() => null);
        if (row) return row;
      }
      const foreign = await prisma.automationDelivery.findUnique({ where: { id: did }, select: { id: true, agencyId: true, creatorId: true } }).catch(() => null);
      if (foreign?.id && (foreign.agencyId !== agencyId || foreign.creatorId !== cid)) {
        const err = new Error("delivery id belongs to another creator");
        err.status = 409;
        err.code = "DELIVERY_ID_CONFLICT";
        throw err;
      }
      return createAutomationDeliverySafe({ ...safeData, id: did });
    }

    if (mid) {
      const updated = await prisma.automationDelivery.updateMany({
        where: { agencyId, creatorId: cid, messageId: mid },
        data: safeUpdate,
      });
      if (updated.count > 0) {
        const row = await prisma.automationDelivery.findFirst({
          where: { agencyId, creatorId: cid, messageId: mid },
          orderBy: { updatedAt: "desc" },
        }).catch(() => null);
        if (row) return row;
      }
      return createAutomationDeliverySafe(safeData);
    }

    return createAutomationDeliverySafe(safeData);
  }

  async function markAutomationDeliveryTerminal({ req, creatorId, row, status, input = {}, source = "automation_state_machine" }) {
    const terminalStatus = bumpStatStatus(status);
    if (!row?.id || !BUMP_TERMINAL_DELIVERY_STATUSES.has(terminalStatus)) {
      return { ok: false, code: "BAD_TERMINAL_DELIVERY", item: row ? mapAutomationDelivery(row) : null };
    }
    const now = new Date();
    const prevMeta = deliveryMeta(row);
    const inputResult = input?.result && typeof input.result === "object" && !Array.isArray(input.result) ? input.result : {};
    const alreadyCounted = deliveryStatAlreadyCounted(row);
    const templateId = cleanString(input?.templateId || input?.bumpId || deliveryTemplateId(row), 100) || "";
    const day = cleanString(input?.day, 10) || (row.sentAt ? row.sentAt.toISOString().slice(0, 10) : now.toISOString().slice(0, 10));
    let stat = null;

    if (!alreadyCounted && STAT_EVENTS.has(terminalStatus)) {
      await upsertBumpFanState({
        agencyId: req.auth.agencyId,
        creatorId,
        fanId: row.fanId,
        dialogId: row.dialogId || row.fanId,
        templateId,
        status: terminalStatus,
        sentAt: row.sentAt,
        finalizedAt: input?.repliedAt || input?.canceledAt || input?.failedAt || input?.finalizedAt || now.toISOString(),
        messageId: row.messageId,
        replyCooldownHours: input?.replyCooldownHours ?? input?.fanReplyCooldownHours ?? input?.afterReplyCooldownHours ?? 24,
        sentCooldownHours: input?.sentCooldownHours ?? input?.fanSentCooldownHours ?? input?.afterSendCooldownHours ?? 6,
        sameTemplateCooldownHours: input?.sameTemplateCooldownHours ?? input?.cooldownHours ?? null,
      }).catch(() => null);
      stat = await incrementBumpDeliveryStat({ agencyId: req.auth.agencyId, creatorId, templateId, day, event: terminalStatus, by: 1 }).catch((err) => ({ ok: false, error: String(err?.message || err) }));
    }

    const mergedResult = jsonObject({
      ...prevMeta,
      ...inputResult,
      finalSource: input?.source || input?.replySource || input?.cancelSource || source,
      finalStatus: terminalStatus,
      terminalStatus,
      lifecycle: "terminal",
      terminalAt: input?.terminalAt || input?.repliedAt || input?.canceledAt || input?.failedAt || input?.finalizedAt || now.toISOString(),
      finalizedAt: input?.finalizedAt || input?.repliedAt || input?.canceledAt || input?.failedAt || now.toISOString(),
      replyMessageId: input?.replyMessageId || prevMeta.replyMessageId || null,
      deleteVerified: input?.deleteVerified ?? prevMeta.deleteVerified ?? null,
      workerDeviceId: input?.deviceId || input?.claimedByDeviceId || row.claimedByDeviceId || null,
      statCounted: alreadyCounted || STAT_EVENTS.has(terminalStatus),
      statCountedStatus: prevMeta.statCountedStatus || (STAT_EVENTS.has(terminalStatus) ? terminalStatus : null),
      statCountedAt: prevMeta.statCountedAt || (STAT_EVENTS.has(terminalStatus) ? now.toISOString() : null),
      statSkipped: !STAT_EVENTS.has(terminalStatus),
    });

    const updated = await prisma.automationDelivery.updateMany({
      where: { id: row.id, agencyId: req.auth.agencyId, creatorId },
      data: {
        status: terminalStatus,
        claimedByDeviceId: null,
        claimedAt: null,
        claimUntil: null,
        lastCheckedAt: now,
        result: mergedResult,
        error: optionalString(input?.error || input?.lastError || null, 2000),
      },
    });
    if (updated.count <= 0) {
      return { ok: true, alreadyCompacted: true, item: null, code: "DELIVERY_TERMINAL_RACE_LOST", status: terminalStatus, stat };
    }
    const item = await prisma.automationDelivery.findUnique({ where: { id: row.id } }).catch(() => null);
    if (item) {
      const module = automationActivityModuleForDelivery(item);
      let action = terminalStatus;
      const metaForActivity = deliveryMeta(item);
      if (terminalStatus === "replied") action = "replied";
      else if (terminalStatus === "canceled") action = "canceled";
      else if (terminalStatus === "failed") action = "failed";
      else if (terminalStatus === "skipped") action = "skipped";
      await logAutomationActivitySafe({
        req,
        creatorId,
        module,
        action,
        status: terminalStatus === "failed" ? "failed" : terminalStatus === "skipped" ? "skipped" : "ok",
        row: item,
        input: { ...(input || {}), amountCents: item.priceCents || metaForActivity.amountCents || 0 },
        metadata: { terminalStatus, reason: metaForActivity.reason || metaForActivity.finalStatus || input?.reason || input?.code || null },
      });
    }
    return { ok: true, compacted: false, terminal: true, status: terminalStatus, item: item ? mapAutomationDelivery(item) : null, stat, alreadyCounted };
  }

  async function repairAutomationDeliveries({ agencyId, creatorId, now = new Date(), timeoutSec = 180 } = {}) {
    const cid = cleanString(creatorId, 100);
    const staleBefore = new Date(now.getTime() - Math.max(30, Number(timeoutSec) || 180) * 1000);
    const report = { repairedOnlineClaims: 0, repairedCancelClaims: 0, repairedHiddenScanClaims: 0, fixedQueuedWithMessageId: 0, fixedPendingWithoutMessageId: 0 };

    const online = await prisma.automationDelivery.updateMany({
      where: {
        agencyId,
        creatorId: cid,
        status: { in: ["online_claimed", "send_reserved"] },
        OR: [{ claimUntil: { lt: now } }, { claimUntil: null }, { claimedByDeviceId: null }],
      },
      data: {
        status: "online_queued",
        sentAt: null,
        claimedByDeviceId: null,
        claimedAt: null,
        claimUntil: null,
        scheduledAt: now,
        lastCheckedAt: now,
        error: "stale online/send claim repaired; returned to queue",
      },
    }).catch(() => ({ count: 0 }));
    report.repairedOnlineClaims = online.count || 0;

    const cancel = await prisma.automationDelivery.updateMany({
      where: {
        agencyId,
        creatorId: cid,
        status: "cancel_claimed",
        OR: [{ claimUntil: { lt: now } }, { claimUntil: null }, { claimedByDeviceId: null }],
      },
      data: {
        status: "pending_reply",
        claimedByDeviceId: null,
        claimedAt: null,
        claimUntil: null,
        lastCheckedAt: now,
        error: "stale cancel claim repaired; returned to pending_reply",
      },
    }).catch(() => ({ count: 0 }));
    report.repairedCancelClaims = cancel.count || 0;

    const scan = await prisma.automationDelivery.updateMany({
      where: {
        agencyId,
        creatorId: cid,
        trigger: "hidden_online_scan",
        status: "hidden_scan_claimed",
        OR: [{ claimUntil: { lt: now } }, { claimUntil: null }, { claimedByDeviceId: null }, { updatedAt: { lt: staleBefore } }],
      },
      data: {
        status: "hidden_scan_queued",
        claimedByDeviceId: null,
        claimedAt: null,
        claimUntil: null,
        lastCheckedAt: now,
        error: "stale hidden scan claim repaired; returned to queue",
      },
    }).catch(() => ({ count: 0 }));
    report.repairedHiddenScanClaims = scan.count || 0;

    const queuedWithMessage = await prisma.automationDelivery.updateMany({
      where: { agencyId, creatorId: cid, status: "online_queued", messageId: { not: null } },
      data: { status: "pending_reply", claimedByDeviceId: null, claimedAt: null, claimUntil: null, lastCheckedAt: now, error: null },
    }).catch(() => ({ count: 0 }));
    report.fixedQueuedWithMessageId = queuedWithMessage.count || 0;

    const pendingNoMessage = await prisma.automationDelivery.updateMany({
      where: { agencyId, creatorId: cid, status: "pending_reply", messageId: null, sentAt: null },
      data: { status: "online_queued", scheduledAt: now, claimedByDeviceId: null, claimedAt: null, claimUntil: null, lastCheckedAt: now, error: "pending_reply without messageId/sentAt repaired; returned to queue" },
    }).catch(() => ({ count: 0 }));
    report.fixedPendingWithoutMessageId = pendingNoMessage.count || 0;

    return report;
  }

  // Legacy server-state mutating routes are intentionally senior-only in v19.5.
  // Worker job protocol remains open through /jobs/claim, /jobs/:id/result and /events.



  const BUMP_TRIGGER_KEYS = Object.freeze({
    ONLINE: "fanOnline",
    LIKE: "fanLikedPost",
    SUBSCRIBED: "fanSubscribed",
    HIDDEN: "hiddenOnlineSignal",
  });

  function normalizeBumpTrigger(value) {
    const raw = cleanString(value, 80);
    const lower = String(raw || "").toLowerCase();
    if (!raw) return BUMP_TRIGGER_KEYS.ONLINE;
    if (raw === BUMP_TRIGGER_KEYS.ONLINE || lower === "online" || lower === "presence_online" || lower === "fan_online") return BUMP_TRIGGER_KEYS.ONLINE;
    if (raw === BUMP_TRIGGER_KEYS.LIKE || lower === "like" || lower === "post_like" || lower === "fan_liked_post" || lower === "fanlikedpost") return BUMP_TRIGGER_KEYS.LIKE;
    if (raw === BUMP_TRIGGER_KEYS.SUBSCRIBED || lower === "subscribe" || lower === "subscription" || lower === "subscription_created" || lower === "new_subscriber" || lower === "fansubscribed") return BUMP_TRIGGER_KEYS.SUBSCRIBED;
    if (raw === BUMP_TRIGGER_KEYS.HIDDEN || lower === "hidden" || lower === "hidden_online" || lower === "hiddenonlinesignal" || lower === "hidden_online_signal") return BUMP_TRIGGER_KEYS.HIDDEN;
    return BUMP_TRIGGER_KEYS.ONLINE;
  }

  function eventGateId(creatorId) {
    return `bump_event_gate_${String(creatorId || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80)}`;
  }

  function eventQueueBatchId(prefix = "event") {
    return `bump_${String(prefix || "event").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24)}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function onlineQueueFanIds(value) {
    const source = Array.isArray(value) ? value : [];
    const out = [];
    const seen = new Set();
    for (const item of source) {
      const raw = item && typeof item === "object" ? (item.fanId || item.userId || item.id || item.dialogId) : item;
      const id = cleanString(raw, 80);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  function onlineSpacingRange(input = {}) {
    const min = Math.max(15, Math.min(3600, positiveInt(input.minFanSpacingSec ?? input.onlineFanSpacingSec ?? input.batchSpacingSec, 15)));
    const rawMax = positiveInt(input.maxFanSpacingSec ?? input.onlineFanMaxSpacingSec ?? input.batchMaxSpacingSec, 30);
    const max = Math.max(min, Math.min(3600, rawMax || 30));
    return { min, max };
  }

  function randomOnlineSpacingMs(range = {}) {
    const min = Math.max(15, Number(range.min) || 15);
    const max = Math.max(min, Number(range.max) || 30);
    const sec = min + Math.floor(Math.random() * (max - min + 1));
    return sec * 1000;
  }

  async function acquireOnlineGate(tx, { agencyId, creatorId, now }) {
    const id = eventGateId(creatorId);
    let row = await tx.automationDelivery.findUnique({ where: { id } }).catch(() => null);
    if (!row) {
      try {
        row = await tx.automationDelivery.create({
          data: {
            id,
            agencyId,
            creatorId,
            fanId: "__bump_event_gate__",
            dialogId: null,
            trigger: "bumpEvent_gate",
            status: "online_gate",
            scheduledAt: now,
            lastCheckedAt: now,
            result: { onlineGate: true, nextAllowedAt: now.toISOString() },
          },
        });
      } catch (_) {
        row = await tx.automationDelivery.findUnique({ where: { id } }).catch(() => null);
      }
    }

    if (!row) throw new Error("ONLINE_GATE_UNAVAILABLE");
    // UPDATE locks the gate row inside the transaction on PostgreSQL, giving us
    // one global cursor per creator/account for online bump sends.
    return tx.automationDelivery.update({ where: { id }, data: { lastCheckedAt: now } });
  }

  function onlineGateNextAllowed(row, now) {
    const meta = deliveryMeta(row);
    const t = new Date(meta.nextAllowedAt || row?.scheduledAt || 0).getTime();
    return Number.isFinite(t) && t > now.getTime() ? new Date(t) : now;
  }

  const ONLINE_SEND_ACTIVE_STATUSES = ["online_queued", "online_claimed", "send_reserved", "send_unknown", "retry_wait", "pending_reply", "sent", "checking_reply", "cancel_claimed"];


  return {
    parseDate,
    BUMP_TERMINAL_DELIVERY_STATUSES,
    bumpStatStatus,
    refreshBumpTaskStats,
    deliveryMeta,
    deliveryTemplateId,
    deliveryCancelAt,
    sortAutomationSendCandidates,
    mapAutomationDelivery,
    automationActivityModuleForDelivery,
    logAutomationActivitySafe,
    compactTemplateIds,
    dateIso,
    maxIsoDate,
    addHoursDate,
    mapBumpFanState,
    upsertBumpFanState,
    incrementBumpDeliveryStat,
    findAutomationDeliveryForResult,
    stripUndefinedFields,
    deliveryStatAlreadyCounted,
    automationResultCode,
    isSoftRetryResult,
    isSendUnknownResult,
    automationRetryAt,
    normalizeDeliveryWriteData,
    createAutomationDeliverySafe,
    saveAutomationDeliveryIdempotent,
    markAutomationDeliveryTerminal,
    repairAutomationDeliveries,
    BUMP_TRIGGER_KEYS,
    normalizeBumpTrigger,
    eventGateId,
    eventQueueBatchId,
    onlineQueueFanIds,
    onlineSpacingRange,
    randomOnlineSpacingMs,
    acquireOnlineGate,
    onlineGateNextAllowed,
    STAT_EVENTS,
    AUTOMATION_TERMINAL_ROW_STATUSES,
    AUTOMATION_SOFT_RETRY_CODES,
    ONLINE_SEND_ACTIVE_STATUSES,
  };
}

module.exports = { createDeliveryHelpers };

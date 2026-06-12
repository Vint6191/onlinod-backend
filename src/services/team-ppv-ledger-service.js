"use strict";

const prisma = require("../prisma");

const RAW_LEDGER_RETENTION_DAYS = 180;
const RAW_LEDGER_RETENTION_MS = RAW_LEDGER_RETENTION_DAYS * 86400000;
const RESOLVE_JOB_EXPIRE_MS = RAW_LEDGER_RETENTION_MS;

function clean(value, max = 255) {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, max) : null;
}

function safeDate(value, fallback = Date.now()) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return new Date(n);
  const d = new Date(value || fallback);
  return Number.isFinite(d.getTime()) ? d : new Date(fallback);
}

function int(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function extraOf(event) {
  return event?.extra && typeof event.extra === "object" ? event.extra : {};
}

function eventAgency(event, fallback) {
  return clean(event?.agencyId || extraOf(event).agencyId || fallback, 160);
}

function eventAccount(event) {
  return clean(event?.accountId || extraOf(event).accountId || extraOf(event).creatorAccountId || "unknown", 160) || "unknown";
}

function eventCreatorId(event) {
  return clean(event?.creatorId || extraOf(event).creatorId || null, 160);
}

function eventCreatorRef(event) {
  return clean(event?.creatorRef || extraOf(event).creatorRef || extraOf(event).creatorUserId || extraOf(event).remoteId || null, 160);
}

function eventMessageId(event) {
  return clean(event?.messageId || extraOf(event).messageId || extraOf(event).message_id || null, 160);
}

function purchaseIdFromEvent(event) {
  const extra = extraOf(event);
  return clean(
    extra.purchaseId || extra.purchase_id || extra.notificationId || extra.transactionId ||
    extra.localSeed || event.localId || [eventMessageId(event) || "no-message", event.ts || Date.now()].join(":"),
    220
  );
}

function shouldKeepExisting(value) {
  const s = String(value ?? "").trim();
  return Boolean(s && s !== "member" && s !== "unknown");
}

function safeMediaIds(value) {
  if (!Array.isArray(value)) return undefined;
  return Array.from(new Set(value.map((v) => String(v || "").trim()).filter(Boolean))).slice(0, 100);
}

async function findSentLedger({ agencyId, accountId, localSeed, messageId }) {
  if (messageId) {
    const byMessage = await prisma.teamSentMessageLedger.findFirst({
      where: { agencyId, accountId, messageId },
    });
    if (byMessage) return byMessage;
  }
  if (localSeed) {
    const bySeed = await prisma.teamSentMessageLedger.findUnique({
      where: { agencyId_accountId_localSeed: { agencyId, accountId, localSeed } },
    });
    if (bySeed) return bySeed;
  }
  return null;
}

async function upsertSentMessageFromEvent(row) {
  const event = row || {};
  const extra = extraOf(event);
  const agencyId = eventAgency(event, event.agencyId);
  if (!agencyId) return null;

  const accountId = eventAccount(event);
  const messageId = eventMessageId(event);
  const localSeed = clean(
    extra.localSeed || event.localId || messageId || [event.fanId || extra.dialogId || "dialog", event.ts || Date.now()].join(":"),
    220
  );
  if (!localSeed) return null;

  const next = {
    agencyId,
    accountId,
    creatorId: eventCreatorId(event),
    creatorRef: eventCreatorRef(event),
    memberId: clean(event.memberId || extra.memberId || extra.viewerId, 160),
    userId: clean(event.userId || extra.userId, 160),
    deviceId: clean(event.deviceId || extra.deviceId, 160),
    shiftKey: clean(extra.shiftKey || extra.shift_key, 220),
    dialogId: clean(extra.dialogId || event.fanId || extra.fanId, 160),
    fanId: clean(extra.fanId || event.fanId, 160),
    messageId,
    localSeed,
    sentAt: safeDate(extra.sentAt || extra.sentAtMs || event.ts),
    messageKind: clean(extra.messageKind || extra.message_kind || (extra.isPpv ? "ppv" : "text"), 40) || "text",
    isPpv: Boolean(extra.isPpv || extra.is_ppv || event.type === "ppv_message_sent_recorded"),
    priceCents: extra.priceCents === null || extra.priceCents === undefined ? null : Math.max(0, int(extra.priceCents, 0)),
    currency: clean(extra.currency || null, 16),
    mediaCount: Math.max(0, int(extra.mediaCount || extra.media_count, 0)),
    mediaIds: safeMediaIds(extra.mediaIds),
    campaignId: clean(extra.campaignId || extra.campaign_id || null, 160),
    source: clean(extra.source || "manual_chat", 80) || "manual_chat",
    telemetryEventId: clean(event.id || null, 160),
  };

  const existing = await findSentLedger({ agencyId, accountId, localSeed, messageId });
  if (!existing) {
    try {
      return await prisma.teamSentMessageLedger.create({ data: next });
    } catch (err) {
      if (err?.code !== "P2002") throw err;
      const afterRace = await findSentLedger({ agencyId, accountId, localSeed, messageId });
      if (!afterRace) throw err;
      return afterRace;
    }
  }

  // Critical: do not let another opened webview / retry steal original owner.
  const update = {
    creatorId: existing.creatorId || next.creatorId,
    creatorRef: existing.creatorRef || next.creatorRef,
    memberId: shouldKeepExisting(existing.memberId) ? existing.memberId : next.memberId,
    userId: shouldKeepExisting(existing.userId) ? existing.userId : next.userId,
    deviceId: shouldKeepExisting(existing.deviceId) ? existing.deviceId : next.deviceId,
    shiftKey: shouldKeepExisting(existing.shiftKey) && !String(existing.shiftKey || "").includes("__member") ? existing.shiftKey : next.shiftKey,
    dialogId: existing.dialogId || next.dialogId,
    fanId: existing.fanId || next.fanId,
    messageId: existing.messageId || next.messageId,
    sentAt: existing.sentAt || next.sentAt,
    messageKind: next.isPpv ? "ppv" : (existing.messageKind || next.messageKind),
    isPpv: Boolean(existing.isPpv || next.isPpv),
    priceCents: existing.priceCents ?? next.priceCents,
    currency: existing.currency || next.currency,
    mediaCount: Math.max(int(existing.mediaCount, 0), int(next.mediaCount, 0)),
    mediaIds: existing.mediaIds || next.mediaIds,
    campaignId: existing.campaignId || next.campaignId,
    source: existing.source || next.source,
    telemetryEventId: existing.telemetryEventId || next.telemetryEventId,
  };

  return prisma.teamSentMessageLedger.update({ where: { id: existing.id }, data: update });
}

async function createResolveJobIfNeeded(payload) {
  if (!payload?.messageId || !payload?.purchaseId || payload.status === "attributed") return null;
  return prisma.teamPpvResolveJob.upsert({
    where: {
      agencyId_purchaseId_messageId: {
        agencyId: payload.agencyId,
        purchaseId: payload.purchaseId,
        messageId: payload.messageId,
      },
    },
    create: {
      agencyId: payload.agencyId,
      accountId: payload.accountId,
      creatorId: payload.creatorId,
      creatorRef: payload.creatorRef,
      purchaseId: payload.purchaseId,
      messageId: payload.messageId,
      amountCents: payload.amountCents,
      currency: payload.currency,
      purchasedAt: payload.purchasedAt,
      status: "pending",
      expiresAt: new Date(Date.now() + RESOLVE_JOB_EXPIRE_MS),
    },
    update: {
      amountCents: payload.amountCents,
      currency: payload.currency,
      purchasedAt: payload.purchasedAt,
      status: "pending",
      expiresAt: new Date(Date.now() + RESOLVE_JOB_EXPIRE_MS),
    },
  });
}

async function upsertPurchaseFromEvent(row) {
  const event = row || {};
  const extra = extraOf(event);
  const agencyId = eventAgency(event, event.agencyId);
  if (!agencyId) return null;

  const accountId = eventAccount(event);
  const purchaseId = purchaseIdFromEvent(event);
  const messageId = eventMessageId(event);
  const amountCents = Math.max(0, int(extra.amountCents || extra.amount_cents || extra.priceCents || 0, 0));
  const purchasedAt = safeDate(extra.purchasedAt || extra.purchasedAtMs || extra.createdAt || event.ts);
  const attributedMemberId = clean(extra.attributedMemberId || event.memberId || null, 160);
  const attributedUserId = clean(extra.attributedUserId || event.userId || null, 160);
  const status = attributedMemberId ? "attributed" : "unresolved";

  const payload = {
    agencyId,
    accountId,
    creatorId: eventCreatorId(event),
    creatorRef: eventCreatorRef(event),
    purchaseId,
    messageId,
    dialogId: clean(extra.dialogId || event.fanId || extra.fanId, 160),
    fanId: clean(extra.fanId || event.fanId, 160),
    buyerFanId: clean(extra.buyerFanId || extra.buyer_fan_id || extra.fanId || event.fanId, 160),
    amountCents,
    currency: clean(extra.currency || "USD", 16) || "USD",
    purchasedAt,
    status,
    attributedMemberId,
    attributedUserId,
    attributedShiftKey: clean(extra.attributedShiftKey || extra.shiftKey || null, 220),
    resolvedAt: attributedMemberId ? new Date() : null,
    resolvedByDeviceId: clean(event.deviceId || extra.deviceId || null, 160),
    resolvedSource: attributedMemberId ? clean(extra.source || "telemetry", 80) : null,
  };

  const existing = await prisma.teamPpvPurchaseLedger.findUnique({
    where: { agencyId_purchaseId: { agencyId, purchaseId } },
  });

  if (existing?.attributedMemberId && !attributedMemberId) {
    // Unresolved duplicate arrived after attribution. Do not downgrade a sale.
    return existing;
  }

  if (existing?.attributedMemberId && attributedMemberId && existing.attributedMemberId !== attributedMemberId) {
    await prisma.teamPpvPurchaseLedger.update({ where: { id: existing.id }, data: { status: "conflict" } });
    if (messageId) {
      await prisma.teamPpvResolveJob.upsert({
        where: { agencyId_purchaseId_messageId: { agencyId, purchaseId, messageId } },
        create: {
          agencyId,
          accountId,
          creatorId: payload.creatorId,
          creatorRef: payload.creatorRef,
          purchaseId,
          messageId,
          amountCents,
          currency: payload.currency,
          purchasedAt,
          status: "conflict",
          attempts: 1,
          result: { existingMemberId: existing.attributedMemberId, incomingMemberId: attributedMemberId },
          expiresAt: new Date(Date.now() + RESOLVE_JOB_EXPIRE_MS),
        },
        update: { status: "conflict", attempts: { increment: 1 }, result: { existingMemberId: existing.attributedMemberId, incomingMemberId: attributedMemberId } },
      });
    }
    return existing;
  }

  const purchase = await prisma.teamPpvPurchaseLedger.upsert({
    where: { agencyId_purchaseId: { agencyId, purchaseId } },
    create: payload,
    update: {
      messageId: payload.messageId || undefined,
      dialogId: payload.dialogId || undefined,
      fanId: payload.fanId || undefined,
      buyerFanId: payload.buyerFanId || undefined,
      amountCents: payload.amountCents,
      currency: payload.currency,
      purchasedAt: payload.purchasedAt,
      status: attributedMemberId ? "attributed" : undefined,
      attributedMemberId: payload.attributedMemberId || undefined,
      attributedUserId: payload.attributedUserId || undefined,
      attributedShiftKey: payload.attributedShiftKey || undefined,
      resolvedAt: payload.resolvedAt || undefined,
      resolvedByDeviceId: payload.resolvedByDeviceId || undefined,
      resolvedSource: payload.resolvedSource || undefined,
    },
  });

  if (!attributedMemberId && messageId) await createResolveJobIfNeeded(payload);
  return purchase;
}

async function applyLedgerSideEffects(row) {
  if (!row || !row.type) return;
  if (row.type === "sent_message_recorded" || row.type === "ppv_message_sent_recorded") {
    await upsertSentMessageFromEvent(row);
  }
  if (row.type === "ppv_purchase_attributed" || row.type === "ppv_purchase_unresolved") {
    await upsertPurchaseFromEvent(row);
  }
}

async function expirePendingJobs({ agencyId = null } = {}) {
  const where = {
    status: "pending",
    expiresAt: { lt: new Date() },
    ...(agencyId ? { agencyId } : {}),
  };
  try {
    return await prisma.teamPpvResolveJob.updateMany({ where, data: { status: "expired" } });
  } catch (_) {
    return { count: 0 };
  }
}

async function listResolveJobs({ agencyId, limit = 100 }) {
  await expirePendingJobs({ agencyId });
  const now = new Date();
  const rows = await prisma.teamPpvResolveJob.findMany({
    where: {
      agencyId,
      status: "pending",
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: { createdAt: "asc" },
    take: Math.max(1, Math.min(250, Number(limit) || 100)),
  });
  return rows.map((r) => ({
    id: r.id,
    jobId: r.id,
    agencyId: r.agencyId,
    accountId: r.accountId,
    creatorId: r.creatorId,
    creatorRef: r.creatorRef,
    purchaseId: r.purchaseId,
    messageId: r.messageId,
    amountCents: r.amountCents,
    currency: r.currency,
    purchasedAt: r.purchasedAt?.getTime?.() || null,
  }));
}

async function createResolverActivityEvent(tx, { agencyId, deviceId, job, memberId, item }) {
  const member = await tx.agencyMember.findFirst({ where: { agencyId, id: memberId, deletedAt: null }, select: { userId: true } });
  const localId = ["ppv_resolved", job.id, memberId].join(":");
  const exists = await tx.teamActivityEvent.findFirst({ where: { agencyId, localId }, select: { id: true } });
  if (exists) return null;
  return tx.teamActivityEvent.create({
    data: {
      agencyId,
      deviceId: clean(deviceId || item.deviceId, 160),
      userId: member?.userId || null,
      memberId,
      accountId: job.accountId,
      creatorId: job.creatorId || null,
      creatorRef: job.creatorRef || null,
      fanId: clean(item.fanId || null, 160),
      type: "ppv_purchase_attributed",
      ts: job.purchasedAt || new Date(),
      localId,
      source: "server_ppv_resolver",
      extra: {
        telemetryVersion: "team_v12_actual_backend_ppv_safe",
        source: "local_worker_ledger",
        purchaseId: job.purchaseId,
        messageId: job.messageId,
        amountCents: job.amountCents,
        currency: job.currency,
        attributedMemberId: memberId,
        shiftKey: clean(item.shiftKey, 220),
        resolvedByDeviceId: clean(deviceId || item.deviceId, 160),
      },
    },
  });
}

async function submitResolveResults({ agencyId, deviceId, results = [] }) {
  const input = Array.isArray(results) ? results : [];
  let resolved = 0;
  let conflicts = 0;
  let skipped = 0;

  for (const item of input) {
    const jobId = clean(item.jobId || item.id, 160);
    const messageId = clean(item.messageId, 160);
    const purchaseId = clean(item.purchaseId, 220);
    const memberId = clean(item.memberId || item.attributedMemberId, 160);
    if (!messageId || !memberId || (!jobId && !purchaseId)) { skipped += 1; continue; }

    const outcome = await prisma.$transaction(async (tx) => {
      const job = await tx.teamPpvResolveJob.findFirst({
        where: { agencyId, ...(jobId ? { id: jobId } : { purchaseId, messageId }) },
      });
      if (!job || job.status === "resolved") return "skipped";
      if (job.expiresAt && job.expiresAt < new Date()) {
        await tx.teamPpvResolveJob.update({ where: { id: job.id }, data: { status: "expired", attempts: { increment: 1 } } });
        return "skipped";
      }

      const existingPurchase = await tx.teamPpvPurchaseLedger.findFirst({ where: { agencyId, purchaseId: job.purchaseId } });
      if (existingPurchase?.attributedMemberId && existingPurchase.attributedMemberId !== memberId) {
        await tx.teamPpvResolveJob.update({ where: { id: job.id }, data: { status: "conflict", attempts: { increment: 1 }, result: item } });
        await tx.teamPpvPurchaseLedger.update({ where: { id: existingPurchase.id }, data: { status: "conflict" } });
        return "conflict";
      }

      await tx.teamPpvPurchaseLedger.upsert({
        where: { agencyId_purchaseId: { agencyId, purchaseId: job.purchaseId } },
        create: {
          agencyId,
          accountId: job.accountId,
          creatorId: job.creatorId,
          creatorRef: job.creatorRef,
          purchaseId: job.purchaseId,
          messageId: job.messageId,
          amountCents: job.amountCents,
          currency: job.currency,
          purchasedAt: job.purchasedAt || new Date(),
          status: "attributed",
          attributedMemberId: memberId,
          attributedShiftKey: clean(item.shiftKey, 220),
          resolvedAt: new Date(),
          resolvedByDeviceId: clean(deviceId || item.deviceId, 160),
          resolvedSource: clean(item.source || "local_worker_ledger", 80),
        },
        update: {
          status: "attributed",
          attributedMemberId: memberId,
          attributedShiftKey: clean(item.shiftKey, 220),
          resolvedAt: new Date(),
          resolvedByDeviceId: clean(deviceId || item.deviceId, 160),
          resolvedSource: clean(item.source || "local_worker_ledger", 80),
        },
      });

      await tx.teamPpvResolveJob.update({
        where: { id: job.id },
        data: {
          status: "resolved",
          attempts: { increment: 1 },
          resolvedAt: new Date(),
          resolvedByMemberId: memberId,
          resolvedByDeviceId: clean(deviceId || item.deviceId, 160),
          result: item,
        },
      });

      await createResolverActivityEvent(tx, { agencyId, deviceId, job, memberId, item });
      return "resolved";
    });

    if (outcome === "resolved") resolved += 1;
    else if (outcome === "conflict") conflicts += 1;
    else skipped += 1;
  }
  return { received: input.length, resolved, conflicts, skipped };
}

async function listPpvConflicts({ agencyId, limit = 100 }) {
  const rows = await prisma.teamPpvResolveJob.findMany({
    where: { agencyId, status: "conflict" },
    orderBy: { updatedAt: "desc" },
    take: Math.max(1, Math.min(250, Number(limit) || 100)),
  });
  return rows.map((r) => ({
    id: r.id,
    jobId: r.id,
    purchaseId: r.purchaseId,
    messageId: r.messageId,
    amountCents: r.amountCents,
    currency: r.currency,
    purchasedAt: r.purchasedAt?.getTime?.() || null,
    resolvedByMemberId: r.resolvedByMemberId || null,
    result: r.result || null,
    updatedAt: r.updatedAt?.getTime?.() || null,
  }));
}

async function resolvePpvConflict({ agencyId, jobId, memberId, deviceId }) {
  const safeJobId = clean(jobId, 160);
  const safeMemberId = clean(memberId, 160);
  if (!safeJobId || !safeMemberId) return { resolved: 0, skipped: 1 };

  const outcome = await prisma.$transaction(async (tx) => {
    const job = await tx.teamPpvResolveJob.findFirst({ where: { agencyId, id: safeJobId } });
    if (!job) return "skipped";
    await tx.teamPpvPurchaseLedger.upsert({
      where: { agencyId_purchaseId: { agencyId, purchaseId: job.purchaseId } },
      create: {
        agencyId,
        accountId: job.accountId,
        creatorId: job.creatorId,
        creatorRef: job.creatorRef,
        purchaseId: job.purchaseId,
        messageId: job.messageId,
        amountCents: job.amountCents,
        currency: job.currency,
        purchasedAt: job.purchasedAt || new Date(),
        status: "attributed",
        attributedMemberId: safeMemberId,
        resolvedAt: new Date(),
        resolvedByDeviceId: clean(deviceId, 160),
        resolvedSource: "manual_conflict_resolution",
      },
      update: {
        status: "attributed",
        attributedMemberId: safeMemberId,
        resolvedAt: new Date(),
        resolvedByDeviceId: clean(deviceId, 160),
        resolvedSource: "manual_conflict_resolution",
      },
    });
    await tx.teamPpvResolveJob.update({
      where: { id: job.id },
      data: {
        status: "resolved",
        resolvedAt: new Date(),
        resolvedByMemberId: safeMemberId,
        resolvedByDeviceId: clean(deviceId, 160),
        result: { ...(job.result && typeof job.result === "object" ? job.result : {}), manualResolution: true, memberId: safeMemberId },
      },
    });
    await createResolverActivityEvent(tx, { agencyId, deviceId, job, memberId: safeMemberId, item: { source: "manual_conflict_resolution" } });
    return "resolved";
  });

  return outcome === "resolved" ? { resolved: 1, skipped: 0 } : { resolved: 0, skipped: 1 };
}

async function gcTeamLedgers({ olderThanMs = RAW_LEDGER_RETENTION_MS } = {}) {
  await expirePendingJobs({});
  const before = new Date(Date.now() - olderThanMs);
  await prisma.teamSentMessageLedger.deleteMany({ where: { sentAt: { lt: before } } });
  await prisma.teamPpvPurchaseLedger.deleteMany({ where: { purchasedAt: { lt: before }, status: { in: ["resolved", "expired", "attributed", "unresolved"] } } });
  await prisma.teamPpvResolveJob.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: new Date() } }, { createdAt: { lt: before } }],
      status: { in: ["resolved", "expired"] },
    },
  });
}

module.exports = {
  applyLedgerSideEffects,
  upsertSentMessageFromEvent,
  upsertPurchaseFromEvent,
  listResolveJobs,
  submitResolveResults,
  listPpvConflicts,
  resolvePpvConflict,
  expirePendingJobs,
  gcTeamLedgers,
};

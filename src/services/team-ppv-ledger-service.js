"use strict";

const prisma = require("../prisma");
const { serializableTxOptions } = require("../utils/prisma-transaction");

const RAW_LEDGER_RETENTION_DAYS = 180;
const RAW_LEDGER_RETENTION_MS = RAW_LEDGER_RETENTION_DAYS * 86400000;
const RESOLVE_JOB_EXPIRE_MS = RAW_LEDGER_RETENTION_MS;

function clean(value, max = 255) {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, max) : null;
}

function normalizedCreatorScope(allowedCreatorIds) {
  if (!Array.isArray(allowedCreatorIds)) return null;
  return Array.from(new Set(allowedCreatorIds.map(String).map((id) => id.trim()).filter(Boolean)));
}

function creatorScopeWhere(allowedCreatorIds) {
  const ids = normalizedCreatorScope(allowedCreatorIds);
  if (ids === null) return {};
  return { creatorId: { in: ids.length ? ids : ["__none__"] } };
}

function creatorAllowed(creatorId, allowedCreatorIds) {
  const ids = normalizedCreatorScope(allowedCreatorIds);
  if (ids === null) return true;
  return ids.includes(String(creatorId || ""));
}

async function findPpvResolveJobForUpdate(tx, { agencyId, jobId, purchaseId, messageId }) {
  if (jobId) {
    const rows = await tx.$queryRaw`
      SELECT * FROM "TeamPpvResolveJob"
      WHERE "agencyId" = ${agencyId} AND "id" = ${jobId}
      FOR UPDATE
      LIMIT 1
    `;
    return rows?.[0] || null;
  }
  const rows = await tx.$queryRaw`
    SELECT * FROM "TeamPpvResolveJob"
    WHERE "agencyId" = ${agencyId} AND "purchaseId" = ${purchaseId} AND "messageId" = ${messageId}
    FOR UPDATE
    LIMIT 1
  `;
  return rows?.[0] || null;
}

async function findPpvPurchaseForUpdate(tx, { agencyId, purchaseId }) {
  const rows = await tx.$queryRaw`
    SELECT * FROM "TeamPpvPurchaseLedger"
    WHERE "agencyId" = ${agencyId} AND "purchaseId" = ${purchaseId}
    FOR UPDATE
    LIMIT 1
  `;
  return rows?.[0] || null;
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

function eventActionSource(event) {
  return clean(event?.actionSource || extraOf(event).actionSource || extraOf(event).source || null, 80);
}

function shouldKeepExisting(value) {
  const s = String(value ?? "").trim();
  return Boolean(s && s !== "member" && s !== "unknown");
}

function safeMediaIds(value) {
  if (!Array.isArray(value)) return undefined;
  return Array.from(new Set(value.map((v) => String(v || "").trim()).filter(Boolean))).slice(0, 100);
}


function candidateSentAtMs(value) {
  const raw = value?.sentAtMs ?? value?.sent_at_ms ?? value?.sentAt ?? value?.sent_at ?? null;
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : null;
}

function normalizeCandidate(value) {
  if (!value || typeof value !== "object") return null;
  const memberId = clean(
    value.memberId || value.member_id || value.attributedMemberId || value.attributed_member_id ||
    value.existingMemberId || value.incomingMemberId || null,
    160
  );
  if (!memberId) return null;
  return {
    memberId,
    userId: clean(value.userId || value.user_id || value.attributedUserId || value.attributed_user_id || null, 160),
    deviceId: clean(value.deviceId || value.device_id || value.resolvedByDeviceId || value.resolved_by_device_id || null, 160),
    shiftKey: clean(value.shiftKey || value.shift_key || value.attributedShiftKey || value.attributed_shift_key || null, 220),
    sentAtMs: candidateSentAtMs(value),
    source: clean(value.source || value.resolvedSource || value.resolved_source || "unknown", 80) || "unknown",
  };
}

function mergeCandidates(...inputs) {
  const out = new Map();
  const push = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) push(item);
      return;
    }
    const c = normalizeCandidate(value);
    if (!c) return;
    const key = [c.memberId, c.shiftKey || "", c.deviceId || ""].join("|");
    const prev = out.get(key) || {};
    out.set(key, {
      memberId: c.memberId,
      userId: prev.userId || c.userId || null,
      deviceId: prev.deviceId || c.deviceId || null,
      shiftKey: prev.shiftKey || c.shiftKey || null,
      sentAtMs: prev.sentAtMs || c.sentAtMs || null,
      source: prev.source && prev.source !== "unknown" ? prev.source : c.source,
    });
  };
  for (const input of inputs) push(input);
  return Array.from(out.values());
}

function conflictResult(prev, ...candidates) {
  const base = prev && typeof prev === "object" && !Array.isArray(prev) ? { ...prev } : {};
  base.conflict = true;
  base.claimType = "ppv_attribution_conflict";
  base.candidates = mergeCandidates(base.candidates, ...candidates);
  return base;
}

function displayNameForMember(member) {
  if (!member) return null;
  return member.displayName || member.user?.name || member.user?.email || null;
}

async function findSentLedger({ agencyId, accountId, localSeed, messageId }, db = prisma) {
  if (messageId) {
    const byMessage = await db.teamSentMessageLedger.findFirst({
      where: { agencyId, accountId, messageId },
    });
    if (byMessage) return byMessage;
  }
  if (localSeed) {
    const bySeed = await db.teamSentMessageLedger.findUnique({
      where: { agencyId_accountId_localSeed: { agencyId, accountId, localSeed } },
    });
    if (bySeed) return bySeed;
  }
  return null;
}

async function upsertSentMessageFromEvent(row, db = prisma) {
  const event = row || {};
  const extra = extraOf(event);
  const agencyId = eventAgency(event, event.agencyId);
  if (!agencyId) return null;

  const accountId = eventAccount(event);
  const messageId = eventMessageId(event);
  const localSeed = clean(
    event.correlationId || extra.localSeed || event.localId || messageId || [event.dialogId || event.fanId || extra.dialogId || "dialog", event.ts || Date.now()].join(":"),
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
    dialogId: clean(event.dialogId || extra.dialogId || event.fanId || extra.fanId, 160),
    fanId: clean(event.fanId || extra.fanId, 160),
    messageId,
    localSeed,
    sentAt: safeDate(extra.sentAt || extra.sentAtMs || event.ts),
    messageKind: clean(extra.messageKind || extra.message_kind || (event.isPpv === true || extra.isPpv ? "ppv" : "text"), 40) || "text",
    isPpv: Boolean(event.isPpv === true || extra.isPpv || extra.is_ppv || event.type === "ppv_message_sent_recorded"),
    priceCents: event.priceCents !== null && event.priceCents !== undefined
      ? Math.max(0, int(event.priceCents, 0))
      : (extra.priceCents === null || extra.priceCents === undefined ? null : Math.max(0, int(extra.priceCents, 0))),
    currency: clean(event.currency || extra.currency || null, 16),
    mediaCount: Math.max(0, int(event.mediaCount ?? extra.mediaCount ?? extra.media_count, 0)),
    mediaIds: safeMediaIds(extra.mediaIds),
    campaignId: clean(extra.campaignId || extra.campaign_id || null, 160),
    source: clean(eventActionSource(event)?.toLowerCase() || extra.source || "manual_chat", 80) || "manual_chat",
    telemetryEventId: clean(event.id || null, 160),
  };

  const existing = await findSentLedger({ agencyId, accountId, localSeed, messageId }, db);
  if (!existing) {
    try {
      return await db.teamSentMessageLedger.create({ data: next });
    } catch (err) {
      if (err?.code !== "P2002") throw err;
      const afterRace = await findSentLedger({ agencyId, accountId, localSeed, messageId }, db);
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

  return db.teamSentMessageLedger.update({ where: { id: existing.id }, data: update });
}

// Audit15: PPV purchase creation from telemetry/compatibility events was retired.
// Canonical CreatorSale reconciliation is the only Team PPV money projector.

async function applyLedgerSideEffects(row, db = prisma) {
  if (!row || (!row.type && !row.eventKind)) return;
  const eventKind = String(row.eventKind || "").toUpperCase();
  if (row.type === "sent_message_recorded"
      || row.type === "ppv_message_sent_recorded"
      || (eventKind === "MESSAGE_SEND_CONFIRMED" && String(row.lifecycle || "").toUpperCase() === "CONFIRMED")) {
    await upsertSentMessageFromEvent(row, db);
  }
  // Audit15: telemetry is ownership/activity provenance only. PPV money facts
  // are projected exclusively from canonical CreatorSale rows.
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

async function listResolveJobs({ agencyId, limit = 100, allowedCreatorIds = null }) {
  await expirePendingJobs({ agencyId });
  const now = new Date();
  const rows = await prisma.teamPpvResolveJob.findMany({
    where: {
      agencyId,
      ...creatorScopeWhere(allowedCreatorIds),
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

function appendManualResolution(baseResult, manualResolution) {
  const base = baseResult && typeof baseResult === "object" && !Array.isArray(baseResult)
    ? { ...baseResult }
    : {};
  const prev = Array.isArray(base.manualResolutions)
    ? base.manualResolutions
    : (base.manualResolution ? [base.manualResolution] : []);
  return {
    ...base,
    manualResolution,
    manualResolutions: [...prev, manualResolution],
  };
}

function manualResolutionHistory(result) {
  if (!result || typeof result !== "object") return [];
  if (Array.isArray(result.manualResolutions)) return result.manualResolutions;
  return result.manualResolution ? [result.manualResolution] : [];
}

async function actorFromDevice(tx, { agencyId, deviceId }) {
  const safeDeviceId = clean(deviceId, 160);
  if (!safeDeviceId) return null;
  const device = await tx.workerDevice.findFirst({
    where: { agencyId, id: safeDeviceId },
    include: { user: { select: { id: true, email: true, name: true } } },
  });
  if (!device?.userId) return null;
  const member = await tx.agencyMember.findFirst({
    where: { agencyId, userId: device.userId, deletedAt: null },
    include: { user: { select: { id: true, email: true, name: true } } },
  });
  return {
    userId: device.userId,
    memberId: member?.id || null,
    name: displayNameForMember(member) || device.user?.name || device.user?.email || null,
  };
}

async function createPpvClaimNoticeEvents(tx, { agencyId, deviceId, actorMemberId = null, job, action, selectedMemberId, candidates, reason }) {
  const safeAction = clean(action, 40) || "assign";
  const safeSelectedMemberId = clean(selectedMemberId, 160);
  const uniqueCandidateIds = Array.from(new Set((candidates || []).map((c) => clean(c?.memberId, 160)).filter(Boolean)));
  if (!uniqueCandidateIds.length) return 0;

  const targetIds = safeAction === "assign"
    ? uniqueCandidateIds.filter((id) => id !== safeSelectedMemberId)
    : uniqueCandidateIds;
  if (!targetIds.length) return 0;

  const [members, selectedMember, actor] = await Promise.all([
    tx.agencyMember.findMany({
      where: { agencyId, id: { in: targetIds }, deletedAt: null },
      include: { user: { select: { id: true, email: true, name: true } } },
      take: 10000}),
    safeSelectedMemberId
      ? tx.agencyMember.findFirst({
          where: { agencyId, id: safeSelectedMemberId, deletedAt: null },
          include: { user: { select: { id: true, email: true, name: true } } },
        })
      : null,
    actorMemberId
      ? tx.agencyMember.findFirst({
          where: { agencyId, id: clean(actorMemberId, 160), deletedAt: null },
          include: { user: { select: { id: true, email: true, name: true } } },
        }).then((member) => member ? ({
          memberId: member.id,
          userId: member.userId,
          name: displayNameForMember(member) || member.id,
        }) : null)
      : actorFromDevice(tx, { agencyId, deviceId }),
  ]);
  const memberById = new Map(members.map((m) => [m.id, m]));
  const selectedName = displayNameForMember(selectedMember) || safeSelectedMemberId || null;
  const actorName = actor?.name || actor?.memberId || actor?.userId || null;
  let created = 0;

  for (const targetMemberId of targetIds) {
    const target = memberById.get(targetMemberId);
    const localId = ["ppv_claim_notice", job.id, safeAction, targetMemberId, Date.now(), Math.random().toString(36).slice(2, 8)].join(":");
    await tx.teamActivityEvent.create({
      data: {
        agencyId,
        deviceId: clean(deviceId, 160),
        userId: target?.userId || null,
        memberId: targetMemberId,
        accountId: job.accountId,
        creatorId: job.creatorId || null,
        creatorRef: job.creatorRef || null,
        fanId: null,
        type: "ppv_claim_resolution_notice",
        ts: new Date(),
        localId,
        source: "server_ppv_claims",
        extra: {
          telemetryVersion: "team_v13_ppv_claims",
          claimType: "ppv_attribution_conflict",
          action: safeAction,
          purchaseId: job.purchaseId,
          messageId: job.messageId,
          amountCents: job.amountCents,
          currency: job.currency,
          targetMemberId,
          assignedMemberId: safeAction === "assign" ? safeSelectedMemberId : null,
          assignedMemberName: safeAction === "assign" ? selectedName : null,
          resolvedByDeviceId: clean(deviceId, 160),
          resolvedByMemberId: actor?.memberId || null,
          resolvedByUserId: actor?.userId || null,
          resolvedByName: actorName,
          reason: clean(reason, 1000),
          text: safeAction === "assign"
            ? `PPV ${(job.amountCents || 0) / 100} ${job.currency || "USD"} was assigned to ${selectedName || safeSelectedMemberId || "another member"}${actorName ? ` by ${actorName}` : ""}.`
            : `PPV ${(job.amountCents || 0) / 100} ${job.currency || "USD"} claim was marked ${safeAction}${actorName ? ` by ${actorName}` : ""}.`,
        },
      },
    });
    created += 1;
  }
  return created;
}

async function submitResolveResults({ agencyId, deviceId, results = [], actorMemberId = null, actorUserId = null, senior = false, allowedCreatorIds = null }) {
  const input = Array.isArray(results) ? results : [];
  const safeActorMemberId = clean(actorMemberId, 160);
  const safeActorUserId = clean(actorUserId, 160);
  const isSenior = Boolean(senior);
  let resolved = 0;
  let conflicts = 0;
  let skipped = 0;
  let forbidden = 0;

  for (const item of input) {
    const jobId = clean(item.jobId || item.id, 160);
    const messageId = clean(item.messageId, 160);
    const purchaseId = clean(item.purchaseId, 220);
    const submittedMemberId = clean(item.memberId || item.attributedMemberId, 160);
    if (!messageId || !submittedMemberId || (!jobId && !purchaseId)) { skipped += 1; continue; }

    const outcome = await prisma.$transaction(async (tx) => {
      const job = await findPpvResolveJobForUpdate(tx, { agencyId, jobId, purchaseId, messageId });
      if (!job) return "skipped";
      if (!creatorAllowed(job.creatorId, allowedCreatorIds)) return "forbidden";
      if (job.expiresAt && job.expiresAt < new Date()) {
        await tx.teamPpvResolveJob.update({ where: { id: job.id }, data: { status: "expired", attempts: { increment: 1 } } });
        return "skipped";
      }

      // Non-senior workers may only submit PPV resolution for themselves,
      // and only when the backend has proof that this member originally sent
      // the purchased PPV message. This closes the forged worker-result window
      // before a later conflict detector has to clean it up manually.
      let proof = null;
      let memberId = submittedMemberId;
      if (!isSenior) {
        if (!safeActorMemberId || submittedMemberId !== safeActorMemberId || messageId !== job.messageId) {
          return "forbidden";
        }
        proof = await tx.teamSentMessageLedger.findFirst({
          where: {
            agencyId,
            memberId: safeActorMemberId,
            messageId: job.messageId,
            ...(job.accountId ? { accountId: job.accountId } : {}),
          },
          select: { id: true, userId: true, deviceId: true, shiftKey: true, sentAt: true },
        }).catch(() => null);
        if (!proof) return "forbidden";
        memberId = safeActorMemberId;
      }

      const resolvedDeviceId = clean(deviceId || item.deviceId || proof?.deviceId, 160);
      const resolvedShiftKey = clean(item.shiftKey || proof?.shiftKey, 220);
      const resolvedUserId = clean(proof?.userId || safeActorUserId, 160);
      const resolvedSentAtMs = item.sentAtMs || item.sent_at_ms || (proof?.sentAt ? new Date(proof.sentAt).getTime() : null);

      const incomingCandidate = {
        memberId,
        userId: resolvedUserId,
        shiftKey: resolvedShiftKey,
        deviceId: resolvedDeviceId,
        sentAtMs: resolvedSentAtMs,
        source: clean(item.source || "local_worker_ledger", 80),
      };

      const existingPurchase = await findPpvPurchaseForUpdate(tx, { agencyId, purchaseId: job.purchaseId });
      if (existingPurchase?.attributedMemberId && existingPurchase.attributedMemberId !== memberId) {
        const existingCandidate = {
          memberId: existingPurchase.attributedMemberId,
          userId: existingPurchase.attributedUserId,
          shiftKey: existingPurchase.attributedShiftKey,
          deviceId: existingPurchase.resolvedByDeviceId,
          source: existingPurchase.resolvedSource || "existing_purchase_ledger",
        };
        const result = conflictResult(job.result, existingCandidate, incomingCandidate);
        await tx.teamPpvResolveJob.update({
          where: { id: job.id },
          data: { status: "conflict", attempts: { increment: 1 }, result },
        });
        await tx.teamPpvPurchaseLedger.update({ where: { id: existingPurchase.id }, data: { status: "conflict" } });
        return "conflict";
      }

      if (String(job.status || "") === "conflict") {
        const result = conflictResult(job.result, incomingCandidate);
        await tx.teamPpvResolveJob.update({
          where: { id: job.id },
          data: { attempts: { increment: 1 }, result },
        });
        return "conflict";
      }

      if (String(job.status || "") === "resolved") return "skipped";

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
          attributedUserId: resolvedUserId,
          attributedShiftKey: resolvedShiftKey,
          resolvedAt: new Date(),
          resolvedByDeviceId: resolvedDeviceId,
          resolvedSource: clean(item.source || "local_worker_ledger", 80),
        },
        update: {
          status: "attributed",
          attributedMemberId: memberId,
          attributedUserId: resolvedUserId,
          attributedShiftKey: resolvedShiftKey,
          resolvedAt: new Date(),
          resolvedByDeviceId: resolvedDeviceId,
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
          resolvedByDeviceId: resolvedDeviceId,
          result: { ...incomingCandidate, autoResolved: true, verifiedBySentMessageLedger: Boolean(proof) },
        },
      });

      // Do not create a provisional money event here. Team stats read PPV money
      // from TeamPpvPurchaseLedger, so a later conflict can safely remove it
      // from revenue until a manager closes the claim.
      return "resolved";
    }, serializableTxOptions());

    if (outcome === "resolved") resolved += 1;
    else if (outcome === "conflict") conflicts += 1;
    else if (outcome === "forbidden") forbidden += 1;
    else skipped += 1;
  }
  return { received: input.length, resolved, conflicts, skipped, forbidden };
}

async function listPpvConflicts({ agencyId, limit = 100, includeClosed = false, allowedCreatorIds = null }) {
  const statuses = includeClosed
    ? ["conflict", "resolved", "rejected"]
    : ["conflict"];
  const rows = await prisma.teamPpvResolveJob.findMany({
    where: { agencyId, ...creatorScopeWhere(allowedCreatorIds), status: { in: statuses } },
    orderBy: { updatedAt: "desc" },
    take: Math.max(1, Math.min(250, Number(limit) || 100)),
  });

  const purchaseIds = Array.from(new Set(rows.map((r) => r.purchaseId).filter(Boolean)));
  const purchases = purchaseIds.length
    ? await prisma.teamPpvPurchaseLedger.findMany({ where: { agencyId, purchaseId: { in: purchaseIds } } , take: 10000})
    : [];
  const purchaseById = new Map(purchases.map((p) => [p.purchaseId, p]));
  const jobIds = rows.map((row) => row.id).filter(Boolean);
  const auditRows = jobIds.length
    ? await prisma.teamPpvClaimAudit.findMany({
        where: { agencyId, jobId: { in: jobIds } },
        orderBy: { createdAt: "asc" },
        take: 10000,
      }).catch(() => [])
    : [];
  const auditByJob = new Map();
  for (const audit of auditRows || []) {
    const key = String(audit.jobId || "");
    if (!key) continue;
    if (!auditByJob.has(key)) auditByJob.set(key, []);
    auditByJob.get(key).push({
      id: audit.id,
      action: audit.action,
      actorMemberId: audit.actorMemberId,
      selectedMemberId: audit.selectedMemberId || null,
      reason: audit.reason || null,
      evidence: audit.evidence || null,
      createdAt: audit.createdAt?.getTime?.() || null,
    });
  }

  const rawCandidates = rows.flatMap((r) => {
    const result = r.result && typeof r.result === "object" ? r.result : {};
    const p = purchaseById.get(r.purchaseId);
    return mergeCandidates(
      result.candidates,
      result.existingMemberId ? { memberId: result.existingMemberId, source: "existing_result" } : null,
      result.incomingMemberId ? { memberId: result.incomingMemberId, source: "incoming_result" } : null,
      result.memberId ? { memberId: result.memberId, shiftKey: result.shiftKey, deviceId: result.deviceId, sentAtMs: result.sentAtMs, source: result.source } : null,
      p?.attributedMemberId ? { memberId: p.attributedMemberId, userId: p.attributedUserId, shiftKey: p.attributedShiftKey, deviceId: p.resolvedByDeviceId, source: p.resolvedSource } : null
    );
  });
  const memberIds = Array.from(new Set(rawCandidates.map((c) => c.memberId).filter(Boolean)));
  const members = memberIds.length
    ? await prisma.agencyMember.findMany({
        where: { agencyId, id: { in: memberIds }, deletedAt: null },
        include: { user: { select: { id: true, email: true, name: true } } },
        take: 10000})
    : [];
  const memberById = new Map(members.map((m) => [m.id, m]));

  return rows.map((r) => {
    const result = r.result && typeof r.result === "object" ? r.result : {};
    const purchase = purchaseById.get(r.purchaseId) || null;
    const candidates = mergeCandidates(
      result.candidates,
      result.existingMemberId ? { memberId: result.existingMemberId, source: "existing_result" } : null,
      result.incomingMemberId ? { memberId: result.incomingMemberId, source: "incoming_result" } : null,
      result.memberId ? { memberId: result.memberId, shiftKey: result.shiftKey, deviceId: result.deviceId, sentAtMs: result.sentAtMs, source: result.source } : null,
      purchase?.attributedMemberId ? {
        memberId: purchase.attributedMemberId,
        userId: purchase.attributedUserId,
        shiftKey: purchase.attributedShiftKey,
        deviceId: purchase.resolvedByDeviceId,
        source: purchase.resolvedSource,
      } : null
    ).map((c) => {
      const member = memberById.get(c.memberId);
      return {
        ...c,
        name: displayNameForMember(member) || c.memberId,
        email: member?.user?.email || null,
      };
    });

    return {
      id: r.id,
      jobId: r.id,
      claimType: "ppv_attribution_conflict",
      entityType: "ppv_purchase",
      entityId: r.purchaseId,
      status: r.status === "conflict" ? "open" : r.status,
      jobStatus: r.status,
      purchaseId: r.purchaseId,
      messageId: r.messageId,
      accountId: r.accountId,
      creatorId: r.creatorId,
      creatorRef: r.creatorRef,
      amountCents: r.amountCents,
      currency: r.currency,
      purchasedAt: r.purchasedAt?.getTime?.() || null,
      resolvedByMemberId: r.resolvedByMemberId || null,
      purchaseStatus: purchase?.status || (r.status === "conflict" ? "conflict" : r.status),
      canReopen: r.status !== "conflict",
      candidates,
      manualResolutions: manualResolutionHistory(r.result),
      audit: auditByJob.get(String(r.id)) || [],
      result: r.result || null,
      resolvedAt: r.resolvedAt?.getTime?.() || null,
      updatedAt: r.updatedAt?.getTime?.() || null,
    };
  });
}

async function createPpvClaimAudit(tx, { agencyId, actorMemberId, job, action, selectedMemberId, reason, candidates, purchaseBefore }) {
  const actorId = clean(actorMemberId, 160);
  if (!actorId) return null;
  return tx.teamPpvClaimAudit.create({
    data: {
      agencyId,
      jobId: clean(job?.id, 160),
      purchaseId: clean(job?.purchaseId, 220) || "unknown",
      messageId: clean(job?.messageId, 220),
      action: clean(action, 40) || "unresolved",
      actorMemberId: actorId,
      selectedMemberId: clean(selectedMemberId, 160),
      reason: clean(reason, 1000),
      evidence: {
        jobStatusBefore: clean(job?.status, 80),
        purchaseStatusBefore: clean(purchaseBefore?.status, 80),
        candidates: Array.isArray(candidates) ? candidates : [],
      },
    },
  });
}

async function resolvePpvConflict({ agencyId, jobId, memberId, actorMemberId = null, action = "assign", deviceId, reason = null, allowedCreatorIds = null }) {
  const safeJobId = clean(jobId, 160);
  const safeAction = clean(action || (memberId ? "assign" : "unresolved"), 40) || "assign";
  const safeMemberId = clean(memberId, 160);
  const finalAction = safeAction === "reopen"
    ? "reopen"
    : (safeAction === "reject"
      ? "reject"
      : (safeAction === "creator_revenue"
        ? "creator_revenue"
        : (safeAction === "unresolved" ? "unresolved" : "assign")));
  const safeActorMemberId = clean(actorMemberId, 160);
  const safeReason = clean(reason, 1000);
  if (!safeJobId) return { resolved: 0, skipped: 1, code: "PPV_CONFLICT_NOT_FOUND" };
  if (!safeActorMemberId) return { resolved: 0, skipped: 1, code: "RESOLUTION_ACTOR_REQUIRED" };
  if (finalAction === "assign" && !safeMemberId) return { resolved: 0, skipped: 1, code: "RESOLUTION_MEMBER_REQUIRED" };
  if (["assign", "reject", "creator_revenue"].includes(finalAction) && (!safeReason || safeReason.length < 3)) {
    return { resolved: 0, skipped: 1, code: "RESOLUTION_REASON_REQUIRED" };
  }

  const outcome = await prisma.$transaction(async (tx) => {
    const job = await findPpvResolveJobForUpdate(tx, { agencyId, jobId: safeJobId });
    if (!job) return "skipped";
    if (!creatorAllowed(job.creatorId, allowedCreatorIds)) return "creator_forbidden";

    const purchaseBefore = await findPpvPurchaseForUpdate(tx, { agencyId, purchaseId: job.purchaseId });

    if (finalAction === "assign") {
      const selectedMember = await tx.agencyMember.findFirst({
        where: { agencyId, id: safeMemberId, deletedAt: null },
        select: { id: true },
      });
      if (!selectedMember) return "invalid_member";
    }

    const baseResult = job.result && typeof job.result === "object" ? job.result : {};
    const manualResolution = {
      manualResolution: true,
      action: finalAction,
      memberId: finalAction === "assign" ? safeMemberId : null,
      reason: safeReason,
      actorMemberId: safeActorMemberId,
      resolvedByDeviceId: clean(deviceId, 160),
      resolvedAt: new Date().toISOString(),
    };
    const nextResult = appendManualResolution(baseResult, manualResolution);
    const candidates = mergeCandidates(
      baseResult.candidates,
      baseResult.existingMemberId ? { memberId: baseResult.existingMemberId, source: "existing_result" } : null,
      baseResult.incomingMemberId ? { memberId: baseResult.incomingMemberId, source: "incoming_result" } : null,
      baseResult.memberId ? { memberId: baseResult.memberId, shiftKey: baseResult.shiftKey, deviceId: baseResult.deviceId, sentAtMs: baseResult.sentAtMs, source: baseResult.source } : null,
      safeMemberId ? { memberId: safeMemberId, source: "manual_selected" } : null
    );

    if (finalAction === "reopen") {
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
          status: "conflict",
          attributedMemberId: null,
          resolvedAt: null,
          resolvedByDeviceId: clean(deviceId, 160),
          resolvedSource: "manual_claim_reopen",
        },
        update: {
          status: "conflict",
          attributedMemberId: null,
          attributedUserId: null,
          attributedShiftKey: null,
          resolvedAt: null,
          resolvedByDeviceId: clean(deviceId, 160),
          resolvedSource: "manual_claim_reopen",
        },
      });

      await tx.teamPpvResolveJob.update({
        where: { id: job.id },
        data: {
          status: "conflict",
          resolvedAt: null,
          resolvedByMemberId: null,
          resolvedByDeviceId: clean(deviceId, 160),
          result: nextResult,
        },
      });

      await createPpvClaimNoticeEvents(tx, {
        agencyId,
        deviceId,
        actorMemberId: safeActorMemberId,
        job,
        action: "reopen",
        selectedMemberId: null,
        candidates,
        reason: safeReason,
      });
      await createPpvClaimAudit(tx, {
        agencyId,
        actorMemberId: safeActorMemberId,
        job,
        action: "reopen",
        selectedMemberId: null,
        reason: safeReason,
        candidates,
        purchaseBefore,
      });

      return finalAction;
    }

    if (finalAction === "assign") {
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
          resolvedSource: "manual_claim_resolution",
        },
        update: {
          status: "attributed",
          attributedMemberId: safeMemberId,
          resolvedAt: new Date(),
          resolvedByDeviceId: clean(deviceId, 160),
          resolvedSource: "manual_claim_resolution",
        },
      });
    } else {
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
          status: finalAction === "reject" ? "rejected" : (finalAction === "creator_revenue" ? "creator_revenue" : "unresolved"),
          attributedMemberId: null,
          resolvedAt: finalAction === "unresolved" ? null : new Date(),
          resolvedByDeviceId: clean(deviceId, 160),
          resolvedSource: finalAction === "reject" ? "manual_claim_reject" : (finalAction === "creator_revenue" ? "manual_claim_creator_revenue" : "manual_claim_unresolved"),
        },
        update: {
          status: finalAction === "reject" ? "rejected" : (finalAction === "creator_revenue" ? "creator_revenue" : "unresolved"),
          attributedMemberId: null,
          attributedUserId: null,
          attributedShiftKey: null,
          resolvedAt: finalAction === "unresolved" ? null : new Date(),
          resolvedByDeviceId: clean(deviceId, 160),
          resolvedSource: finalAction === "reject" ? "manual_claim_reject" : (finalAction === "creator_revenue" ? "manual_claim_creator_revenue" : "manual_claim_unresolved"),
        },
      });
    }

    await tx.teamPpvResolveJob.update({
      where: { id: job.id },
      data: {
        status: finalAction === "reject" ? "rejected" : "resolved",
        resolvedAt: new Date(),
        resolvedByMemberId: finalAction === "assign" ? safeMemberId : null,
        resolvedByDeviceId: clean(deviceId, 160),
        result: nextResult,
      },
    });

    await createPpvClaimNoticeEvents(tx, {
      agencyId,
      deviceId,
      actorMemberId: safeActorMemberId,
      job,
      action: finalAction,
      selectedMemberId: finalAction === "assign" ? safeMemberId : null,
      candidates,
      reason: safeReason,
    });
    await createPpvClaimAudit(tx, {
      agencyId,
      actorMemberId: safeActorMemberId,
      job,
      action: finalAction,
      selectedMemberId: finalAction === "assign" ? safeMemberId : null,
      reason: safeReason,
      candidates,
      purchaseBefore,
    });

    if (finalAction === "assign") {
      await createResolverActivityEvent(tx, {
        agencyId,
        deviceId,
        job,
        memberId: safeMemberId,
        item: { source: "manual_claim_resolution", reason: safeReason },
      });
    }

    return finalAction;
  }, serializableTxOptions());

  if (outcome === "skipped") return { resolved: 0, skipped: 1 };
  if (outcome === "creator_forbidden") return { resolved: 0, skipped: 1, code: "CREATOR_ACCESS_FORBIDDEN" };
  if (outcome === "invalid_member") return { resolved: 0, skipped: 1, code: "RESOLUTION_MEMBER_INVALID" };
  return { resolved: 1, skipped: 0, action: outcome };
}

async function gcTeamLedgers({ olderThanMs = RAW_LEDGER_RETENTION_MS } = {}) {
  await expirePendingJobs({});
  const before = new Date(Date.now() - olderThanMs);

  const [sent, purchases, resolveJobs] = await Promise.all([
    prisma.teamSentMessageLedger.deleteMany({ where: { sentAt: { lt: before } } }),
    prisma.teamPpvPurchaseLedger.deleteMany({
      where: {
        purchasedAt: { lt: before },
        status: { in: ["resolved", "expired", "attributed", "unresolved", "rejected", "creator_revenue"] },
      },
    }),
    prisma.teamPpvResolveJob.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: new Date() } }, { createdAt: { lt: before } }],
        status: { in: ["resolved", "expired", "rejected"] },
      },
    }),
  ]);

  return {
    sentMessageLedger: sent?.count || 0,
    ppvPurchaseLedger: purchases?.count || 0,
    ppvResolveJob: resolveJobs?.count || 0,
  };
}

module.exports = {
  applyLedgerSideEffects,
  upsertSentMessageFromEvent,
  listResolveJobs,
  submitResolveResults,
  listPpvConflicts,
  resolvePpvConflict,
  expirePendingJobs,
  gcTeamLedgers,
};

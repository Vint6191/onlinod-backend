"use strict";

const prisma = require("../prisma");
const { readSubscriberConsumerPage } = require("./fan-consumer-cursor-service");
const { assertAutomationDeliveryAdoption } = require("./automation-delivery-adoption-guard");
const { withDbAdvisoryXactLock } = require("./db-transaction-service");
const { runWithAutomationWriteCommitFence } = require("./automation-write-commit-fence-service");
const { projectFanObservationBatch, scheduleFanDataPointRefresh, scheduleDurableFanDataRefreshDebt, FAN_DATA_OBSERVATION_BATCH_MAX } = require("./fan-data-authority-service");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { assertSubscriberPublicationIdle, validateSubscriberPublicationIdle } = require("./subscriber-publication-fence-service");
const { PRECOMMIT_MUTABLE_STATUSES, ACTIVE_WRITE_WORKFLOW_STATUSES } = require("./automation-delivery-statuses");
const { nextAutomationWriteSlot } = require("./automation-pacing-service");
const { classifyProgrammaticCustomMediaProvenance } = require("./custom-content-delivery-service");
const {
  stableFingerprint,
  taskToTemplate,
  triggerEnabled,
  templateTiming,
  eligibility,
} = require("./bump-rules");
const {
  BUMPS_MODULE_KEY,
  assertAutomationEnabled,
  getAutomationControlSnapshot,
  requireCreator,
} = require("./automation-control-service");
const {
  readFanCurrentMap,
  validateBumpCurrentRelationship,
  bumpRequiredFields,
  buildFanCurrentFieldFence,
} = require("./fan-current-consumer-service");

const ACTIVE_ACTION_STATUSES = [...ACTIVE_WRITE_WORKFLOW_STATUSES];
const SEND_ACTION = "SEND_MESSAGE";
const DELETE_ACTION = "DELETE_MESSAGE";
const SOURCE_KEYS = new Set(["online", "hidden_online", "paid_subscriber", "free_subscriber", "subscription_event", "manual"]);

function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
const BUMP_PRIVATE_RELATIONSHIP_KEYS = new Set([
  "subscriptionType", "isActive", "canReceiveChatMessage", "fanSubscribesToCreator",
  "fanSubscriptionActive", "fanSubscriptionType", "fanSubscriptionExpiresAt",
  "creatorFollowsFan", "creatorFollowExpiresAt", "subscribedOn", "subscribedBy",
  "subscribedByCreator", "blocked", "restricted", "performer", "subscribePriceCents",
]);
function stripPrivateRelationshipMetadata(value) {
  const input = object(value);
  const output = {};
  for (const [key, item] of Object.entries(input)) {
    if (BUMP_PRIVATE_RELATIONSHIP_KEYS.has(key)) continue;
    if (key === "fan") {
      const fan = {};
      for (const [fanKey, fanValue] of Object.entries(object(item))) {
        if (!BUMP_PRIVATE_RELATIONSHIP_KEYS.has(fanKey)) fan[fanKey] = fanValue;
      }
      if (Object.keys(fan).length) output.fan = fan;
      continue;
    }
    output[key] = item;
  }
  return output;
}
function clean(value, max = 500) { const text = String(value ?? "").trim(); return text ? text.slice(0, max) : null; }
function int(value, fallback, min, max) { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback; }
function date(value) { const d = value instanceof Date ? value : new Date(value || 0); return Number.isFinite(d.getTime()) ? d : null; }
function dayStart(input = new Date()) { const out = new Date(input); out.setHours(0, 0, 0, 0); return out; }
function sourceKey(value) { const key = clean(value, 80) || "manual"; return SOURCE_KEYS.has(key) ? key : "manual"; }
function randomBetween(min, max) { if (max <= min) return min; return min + Math.floor(Math.random() * (max - min + 1)); }
function sourcePriority(source, manual = false) {
  if (manual) return 100;
  if (source === "subscription_event") return 85;
  if (source === "online") return 75;
  if (source === "hidden_online") return 55;
  return 45;
}

async function sessionWriteWorkerCount({ agencyId, creatorId, db = prisma }) {
  const freshAfter = new Date(Date.now() - 2 * 60_000);
  return db.deviceCreatorBinding.count({
    where: {
      agencyId, creatorId, status: "ACTIVE", sessionWriteReady: true, lastSeenAt: { gte: freshAfter },
      device: { agencyId, lastSeenAt: { gte: freshAfter } },
    },
  });
}

function configuredSnapshotSources(settings) {
  const requested = [];
  if (settings.hiddenOnlineEnabled) requested.push("hidden_online");
  if (settings.paidSubscribersEnabled) requested.push("paid_subscriber");
  if (settings.freeSubscribersEnabled) requested.push("free_subscriber");
  return requested;
}

function summarizePlanningSkips(sources = []) {
  const counts = {};
  for (const source of Array.isArray(sources) ? sources : []) {
    if (!source?.ok && source?.code) counts[source.code] = (counts[source.code] || 0) + 1;
    for (const row of Array.isArray(source?.skipped) ? source.skipped : []) {
      const code = clean(row?.code, 120) || "skipped";
      counts[code] = (counts[code] || 0) + 1;
    }
  }
  return counts;
}

async function classifyBumpCustomMediaIds({ agencyId, creatorId, mediaIds, db = prisma }) {
  const normalized = [...new Set((Array.isArray(mediaIds) ? mediaIds : [])
    .map((mediaId) => clean(mediaId, 240))
    .filter(Boolean))];
  const customIds = new Set();
  for (let offset = 0; offset < normalized.length; offset += 200) {
    const result = await classifyProgrammaticCustomMediaProvenance({
      agencyId, creatorId, mediaIds: normalized.slice(offset, offset + 200), db,
    });
    if (!result?.ok || !Array.isArray(result.customMediaIds)) {
      const err = new Error("Bump media provenance check returned an incomplete result");
      err.code = "AUTOMATION_BUMP_MEDIA_PROVENANCE_INCOMPLETE";
      throw err;
    }
    for (const mediaId of result.customMediaIds) customIds.add(String(mediaId));
  }
  return customIds;
}

const ACTIVE_TEMPLATE_PAGE_SIZE = 200;

async function activeTemplates({ agencyId, creatorId, source, eligibleLimit = null, db = prisma }) {
  const requestedLimit = eligibleLimit == null ? null : Number(eligibleLimit);
  const targetEligible = requestedLimit != null && Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(500, Math.floor(requestedLimit)))
    : null;
  const templates = [];
  const blockedTemplateIds = [];
  let cursorId = null;

  while (targetEligible == null || templates.length < targetEligible) {
    const rows = await db.automationTask.findMany({
      where: { agencyId, creatorId, type: "bump_online", enabled: true, status: "active", deletedAt: null },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "asc" }, { id: "asc" }],
      take: ACTIVE_TEMPLATE_PAGE_SIZE,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });
    if (!rows.length) break;

    cursorId = rows[rows.length - 1]?.id || null;
    const candidates = rows
      .map(taskToTemplate)
      .filter((item) => triggerEnabled(item, source) && (item.text || item.mediaFiles.length));
    const customIds = await classifyBumpCustomMediaIds({
      agencyId, creatorId, mediaIds: candidates.flatMap((item) => item.mediaFiles), db,
    });

    for (const item of candidates) {
      const blocked = item.mediaFiles.some((mediaId) => customIds.has(String(mediaId)));
      if (blocked) {
        blockedTemplateIds.push(item.id);
        continue;
      }
      templates.push(item);
      if (targetEligible != null && templates.length >= targetEligible) break;
    }

    if (rows.length < ACTIVE_TEMPLATE_PAGE_SIZE || !cursorId) break;
  }

  return { templates, blockedTemplateIds };
}

async function currentSubscriberRun({ agencyId, creatorId, db = prisma }) {
  return db.subscriberDirectoryState.findFirst({
    where: { agencyId, creatorId, status: "READY", currentRunId: { not: null } },
    select: { currentRunId: true, publishedAt: true },
  });
}

async function loadCandidates({ agencyId, creatorId, source, fanIds = [], limit = 100, db = prisma }) {
  const take = Math.max(1, Math.min(500, Number(limit) || 100));
  const ids = [...new Set((Array.isArray(fanIds) ? fanIds : []).map((x) => clean(x, 160)).filter(Boolean))];
  if (source === "online" || source === "subscription_event" || source === "manual") {
    return db.automationBumpFanState.findMany({
      where: {
        agencyId, creatorId,
        ...(ids.length ? { fanId: { in: ids } } : {}),
        ...(source === "online" ? { lastOnlineAt: { not: null } } : {}),
      },
      orderBy: { lastOnlineAt: "desc" },
      take,
    }).then((rows) => rows.map((row) => {
      const metadata = object(row.metadata);
      const fan = object(metadata.fan);
      return {
        fanId: row.fanId,
        dialogId: row.dialogId || clean(metadata.dialogId, 160) || row.fanId,
        username: clean(fan.username || fan.userName || metadata.username, 160),
        displayName: clean(fan.name || fan.displayName || metadata.displayName, 200),
        // Relationship-looking metadata is historical trigger evidence only.
        // Current relationship fields are overlaid exclusively from FanDataAuthority.
        subscriptionType: null,
        isActive: null,
        canReceiveChatMessage: null,
        snapshotRunId: null,
        observedAt: row.lastOnlineAt || row.updatedAt,
        metadata,
      };
    }));
  }
  const state = await currentSubscriberRun({ agencyId, creatorId, db });
  if (!state?.currentRunId) return [];
  const rows = await readSubscriberConsumerPage({ db, agencyId, creatorId, runId: state.currentRunId,
    consumerKey: `bumps:${source}`, fanIds: ids, limit: take });
  return rows.map((row) => ({
    fanId: row.fanId,
    dialogId: row.dialogId || row.fanId,
    username: null,
    displayName: null,
    subscriptionType: null,
    isActive: null,
    canReceiveChatMessage: null,
    snapshotRunId: row.runId,
    observedAt: row.observedAt,
    metadata: {},
  }));
}


async function scheduleBumpCurrentRefresh({
  agencyId,
  creatorId,
  fanIds = [],
  priority = 60,
  trigger = "planning",
  refreshFields = [],
  scheduleFanRefresh = scheduleFanDataPointRefresh,
} = {}) {
  return scheduleDurableFanDataRefreshDebt({
    agencyId, creatorId, fanIds, consumer: "bumps", reason: "bump_current_unknown",
    priority: Math.max(85, Number(priority) || 60), trigger, refreshFields, scheduleFanRefresh,
  });
}

async function planBumps({ agencyId, creatorId, userId = null, source = "manual", fanIds = [], limit = null, manual = false, db = prisma, scheduleFanRefresh = scheduleFanDataPointRefresh }) {
  const normalizedSource = sourceKey(source);
  await requireCreator(agencyId, creatorId, db);
  const result = await withDbAdvisoryXactLock({ db, key: `p11:bumps:${agencyId}:${creatorId}`, work: async (tx) => {
    const control = await assertAutomationEnabled({ agencyId, creatorId, moduleKey: BUMPS_MODULE_KEY, db: tx });
    const settings = control.modules.bumps.settings;
    const sourceEnabled = normalizedSource === "online" ? settings.onlineEnabled
      : normalizedSource === "hidden_online" ? settings.hiddenOnlineEnabled
        : normalizedSource === "paid_subscriber" ? settings.paidSubscribersEnabled
          : normalizedSource === "free_subscriber" ? settings.freeSubscribersEnabled
            : normalizedSource === "subscription_event" ? settings.subscriptionEventsEnabled
              : true;
    if (!sourceEnabled) return { ok: true, source: normalizedSource, planned: 0, skipped: [{ code: "source_disabled" }] };
    if (["hidden_online", "paid_subscriber", "free_subscriber"].includes(normalizedSource)) {
      await assertSubscriberPublicationIdle({ db: tx, agencyId, creatorId });
    }

    const take = Math.min(settings.candidateBatchSize, Math.max(1, Number(limit) || settings.candidateBatchSize));
    const templateSelection = await activeTemplates({
      agencyId, creatorId, source: normalizedSource, eligibleLimit: take, db: tx,
    });
    const templates = templateSelection.templates;
    if (!templates.length) return {
      ok: true, source: normalizedSource, planned: 0,
      skipped: [{
        code: templateSelection.blockedTemplateIds.length ? "custom_media_programmatic_forbidden" : "no_template",
        ...(templateSelection.blockedTemplateIds.length ? { templateIds: templateSelection.blockedTemplateIds } : {}),
      }],
    };
    const candidates = await loadCandidates({ agencyId, creatorId, source: normalizedSource, fanIds, limit: take, db: tx });
    if (!candidates.length) return { ok: true, source: normalizedSource, planned: 0, skipped: [{ code: "no_candidates" }] };
    const currentByFan = await readFanCurrentMap(tx, {
      agencyId,
      creatorId,
      fanIds: candidates.map((candidate) => candidate.fanId),
    });

    const reservedToday = await tx.automationDelivery.count({
      where: {
        agencyId, creatorId, moduleKey: BUMPS_MODULE_KEY, actionType: SEND_ACTION,
        OR: [
          { status: "COMPLETED", finishedAt: { gte: dayStart() } },
          { status: { in: ACTIVE_ACTION_STATUSES }, createdAt: { gte: dayStart() } },
        ],
      },
    });
    let remaining = Math.max(0, settings.dailyLimit - reservedToday);
    let slot = await nextAutomationWriteSlot({
      agencyId, creatorId, actionType: SEND_ACTION,
      workspaceSettings: control.workspace.settings, actionSettings: settings, now: new Date(), db: tx,
    });
    const planned = [];
    const skipped = [];
    const refreshFanIds = new Set();
    const refreshFields = new Set();

    for (const candidate of candidates) {
      if (remaining <= 0) { skipped.push({ fanId: candidate.fanId, code: "daily_limit" }); continue; }
      const current = currentByFan.get(String(candidate.fanId || "")) || null;
      const currentDecision = validateBumpCurrentRelationship({ candidate, current, source: normalizedSource, now: new Date() });
      if (!currentDecision.ok) {
        skipped.push({ fanId: candidate.fanId, code: currentDecision.code });
        if (currentDecision.refreshRequired === true && candidate.fanId) {
          refreshFanIds.add(String(candidate.fanId));
          for (const field of currentDecision.refreshFields || []) refreshFields.add(String(field));
        }
        continue;
      }
      const canonicalCandidate = currentDecision.candidate;
      const fanState = await tx.automationBumpFanState.findUnique({ where: { creatorId_fanId: { creatorId, fanId: candidate.fanId } } });
      const skip = eligibility({ candidate: canonicalCandidate, fanState, settings, source: normalizedSource, now: new Date() });
      if (skip) { skipped.push({ fanId: candidate.fanId, code: skip }); continue; }
      const active = await tx.automationDelivery.findFirst({
        where: { agencyId, creatorId, moduleKey: BUMPS_MODULE_KEY, actionType: SEND_ACTION, targetId: candidate.fanId, status: { in: ACTIVE_ACTION_STATUSES } },
        select: { id: true, status: true },
      });
      if (active) { skipped.push({ fanId: candidate.fanId, code: "active_delivery", deliveryId: active.id }); continue; }

      let choices = templates;
      if (fanState?.lastTemplateId && templates.length > 1) choices = templates.filter((t) => t.id !== fanState.lastTemplateId);
      let template = choices[planned.length % choices.length] || templates[0];
      const timing = templateTiming(template, settings, normalizedSource);
      if (fanState?.lastTemplateId === template.id && fanState?.lastTemplateSentAt
        && fanState.lastTemplateSentAt.getTime() + timing.sameTemplateCooldownMs > Date.now()) {
        const alternate = templates.find((t) => t.id !== template.id);
        if (!alternate) { skipped.push({ fanId: candidate.fanId, code: "template_cooldown" }); continue; }
        template = alternate;
      }
      const generation = Math.max(0, Number(fanState?.sendGeneration || 0)) + 1;
      const plannedAt = new Date();
      const payload = {
        schemaVersion: 1,
        source: normalizedSource,
        plannedAt: plannedAt.toISOString(),
        snapshotRunId: candidate.snapshotRunId || null,
        fan: {
          fanId: candidate.fanId,
          dialogId: candidate.dialogId,
          username: canonicalCandidate.username || null,
          displayName: canonicalCandidate.displayName || null,
          subscriptionType: canonicalCandidate.subscriptionType || null,
        },
        template,
        timing,
        sendFingerprint: stableFingerprint({ creatorId, fanId: candidate.fanId, dialogId: candidate.dialogId, templateFingerprint: template.fingerprint, generation }),
      };
      const idempotencyKey = `bump_send:${creatorId}:${candidate.fanId}:${normalizedSource}:${generation}`;
      try {
        const delivery = await tx.automationDelivery.create({
          data: {
            agencyId, creatorId, originKind: "AUTOMATION", moduleKey: BUMPS_MODULE_KEY, actionType: SEND_ACTION,
            targetId: candidate.fanId, fanId: candidate.fanId, dialogId: candidate.dialogId,
            idempotencyKey, generation, priority: sourcePriority(normalizedSource, manual), payload,
            contentCollectionId: template.id, trigger: normalizedSource,
            status: "QUEUED", scheduledAt: slot, notBefore: slot,
            maxAttempts: settings.maxAttempts, createdByUserId: userId,
          },
        });
        await tx.automationBumpFanState.upsert({
          where: { creatorId_fanId: { creatorId, fanId: candidate.fanId } },
          create: {
            agencyId, creatorId, fanId: candidate.fanId, dialogId: candidate.dialogId,
            lastStatus: "QUEUED", pendingDeliveryId: delivery.id, sendGeneration: generation,
            metadata: { source: normalizedSource, username: candidate.username || null, displayName: candidate.displayName || null },
          },
          update: {
            dialogId: candidate.dialogId, lastStatus: "QUEUED", pendingDeliveryId: delivery.id, sendGeneration: generation,
            metadata: { ...object(fanState?.metadata), source: normalizedSource, username: candidate.username || null, displayName: candidate.displayName || null },
          },
        });
        planned.push(delivery);
        remaining -= 1;
        const gap = (settings.randomJitter || control.workspace.settings.randomJitter)
          ? randomBetween(Math.max(settings.minimumIntervalMs, control.workspace.settings.globalWriteMinIntervalMs), Math.max(settings.maximumIntervalMs, control.workspace.settings.globalWriteMaxIntervalMs))
          : Math.max(settings.minimumIntervalMs, control.workspace.settings.globalWriteMinIntervalMs);
        slot = new Date(slot.getTime() + gap);
      } catch (error) {
        if (error?.code === "P2002") skipped.push({ fanId: candidate.fanId, code: "active_delivery" });
        else throw error;
      }
    }
    return {
      ok: true,
      source: normalizedSource,
      planned: planned.length,
      items: planned,
      skipped,
      dailyRemaining: remaining,
      refreshFanIds: [...refreshFanIds].slice(0, 500),
      refreshFields: [...refreshFields],
    };
  }, options: { timeout: 30_000 } });
  const fanRefresh = await scheduleBumpCurrentRefresh({
    agencyId,
    creatorId,
    fanIds: result.refreshFanIds,
    priority: sourcePriority(normalizedSource, manual),
    trigger: "planning",
    refreshFields: result.refreshFields || [],
    scheduleFanRefresh,
  });
  if (!fanRefresh.requested) return { ...result, refreshFanIds: [], refreshFields: [] };
  return { ...result, refreshFanIds: fanRefresh.fanIds, fanRefresh };
}

async function recordDetailedObservations({
  agencyId, creatorId, observations, sourceDeviceId = null, updateLastOnlineAt = true, db = prisma,
}) {
  await requireCreator(agencyId, creatorId, db);
  const authorityReceivedAt = await dbAuthorityNow({ db, fallbackNow: new Date() });
  const byFan = new Map();
  for (const raw of Array.isArray(observations) ? observations : []) {
    const fanId = clean(raw?.fanId, 160);
    if (!fanId) continue;
    const previous = byFan.get(fanId);
    const producerObservedAt = date(raw?.observedAt);
    // Runtime activity timestamps are useful for ordering a private trigger, but
    // they are not a distributed clock authority. Preserve delayed older events
    // while clamping a future-skewed producer clock to PostgreSQL receipt time.
    const observedAt = producerObservedAt && producerObservedAt <= authorityReceivedAt
      ? producerObservedAt
      : authorityReceivedAt;
    if (!previous || observedAt >= previous.observedAt) {
      byFan.set(fanId, {
        fanId,
        observedAt,
        metadata: stripPrivateRelationshipMetadata(raw?.metadata),
        dialogId: clean(raw?.dialogId, 160),
        fanObservation: object(raw?.fanObservation),
      });
    }
    if (byFan.size >= 5000) break;
  }
  const rows = [...byFan.values()];
  const ids = rows.map((row) => row.fanId);

  // Strong runtime evidence converges back into the canonical authority first.
  // AutomationBumpFanState remains workflow/trigger state and never owns current
  // fan relationship truth.
  const authorityItems = rows
    .map((row) => {
      const observation = object(row.fanObservation);
      const identity = object(observation.identity);
      const relationship = object(observation.relationship);
      const value = object(observation.value);
      if (!Object.keys(identity).length && !Object.keys(relationship).length && !Object.keys(value).length) return null;
      return {
        onlyFansUserId: row.fanId,
        ...(Object.keys(identity).length ? { identity } : {}),
        ...(Object.keys(relationship).length ? { relationship } : {}),
        ...(Object.keys(value).length ? { value } : {}),
      };
    })
    .filter(Boolean);
  let authorityProjected = 0;
  for (let offset = 0; offset < authorityItems.length; offset += FAN_DATA_OBSERVATION_BATCH_MAX) {
    const chunk = authorityItems.slice(offset, offset + FAN_DATA_OBSERVATION_BATCH_MAX);
    const projected = await projectFanObservationBatch(db, {
      agencyId, creatorId, sourceDeviceId: clean(sourceDeviceId, 180), items: chunk,
      allowedSources: ["PRESENCE_HINT"],
      observedAtPolicy: "SERVER_RECEIPT",
      receivedAt: authorityReceivedAt,
    });
    authorityProjected += Number(projected?.projected || 0);
  }

  const existingRows = ids.length ? await db.automationBumpFanState.findMany({
    where: { agencyId, creatorId, fanId: { in: ids } },
    select: { fanId: true, dialogId: true, metadata: true },
  }) : [];
  const existingByFan = new Map(existingRows.map((row) => [row.fanId, row]));
  for (const row of rows) {
    const existing = existingByFan.get(row.fanId);
    const previous = stripPrivateRelationshipMetadata(existing?.metadata);
    const incoming = stripPrivateRelationshipMetadata(row.metadata);
    const mergedFan = { ...object(previous.fan), ...object(incoming.fan) };
    const mergedMetadata = {
      ...previous,
      ...incoming,
      ...(Object.keys(mergedFan).length ? { fan: mergedFan } : {}),
    };
    const dialogId = clean(row.dialogId || incoming.dialogId || object(incoming.fan).dialogId || existing?.dialogId || row.fanId, 160) || row.fanId;
    await db.automationBumpFanState.upsert({
      where: { creatorId_fanId: { creatorId, fanId: row.fanId } },
      create: {
        agencyId, creatorId, fanId: row.fanId, dialogId,
        ...(updateLastOnlineAt ? { lastOnlineAt: row.observedAt } : {}),
        metadata: mergedMetadata,
      },
      update: {
        dialogId,
        ...(updateLastOnlineAt ? { lastOnlineAt: row.observedAt } : {}),
        metadata: mergedMetadata,
      },
    });
  }
  return { ok: true, count: rows.length, fanIds: ids, authorityProjected };
}

async function recordOnlineObservations({ agencyId, creatorId, fanIds, observedAt = new Date(), metadata = {}, sourceDeviceId = null, db = prisma }) {
  const ids = [...new Set((Array.isArray(fanIds) ? fanIds : []).map((x) => clean(x, 160)).filter(Boolean))].slice(0, 5000);
  const at = date(observedAt) || new Date();
  return recordDetailedObservations({
    agencyId,
    creatorId,
    observations: ids.map((fanId) => ({
      fanId,
      observedAt: at,
      metadata,
      // Presence is temporal activity evidence only; it must not manufacture
      // identity or subscription relationship facts.
      fanObservation: { identity: { observedAt: at, activityObservedAt: at, source: "PRESENCE_HINT" } },
    })),
    sourceDeviceId,
    updateLastOnlineAt: true,
    db,
  });
}

async function bumpStat({ agencyId, creatorId, templateId = "", field, at = new Date(), db = prisma }) {
  if (!["sent", "replied", "canceled", "expired", "failed"].includes(field)) return;
  const day = at.toISOString().slice(0, 10);
  await db.bumpDeliveryStat.upsert({
    where: { creatorId_templateId_day: { creatorId, templateId: templateId || "", day } },
    create: { agencyId, creatorId, templateId: templateId || "", day, [field]: 1 },
    update: { [field]: { increment: 1 } },
  });
}

async function validateBumpDelivery({ delivery, control = null, now = new Date(), db = prisma }) {
  if (!delivery || delivery.moduleKey !== BUMPS_MODULE_KEY) return { ok: true };
  const payload = object(delivery.payload);
  const derivedSource = sourceKey(payload.source);
  if (delivery.actionType === SEND_ACTION && ["hidden_online", "paid_subscriber", "free_subscriber"].includes(derivedSource)) {
    const publicationFence = await validateSubscriberPublicationIdle({ db, agencyId: delivery.agencyId, creatorId: delivery.creatorId, now });
    if (publicationFence.ok === false) return publicationFence;
  }
  const snapshot = control || await assertAutomationEnabled({ agencyId: delivery.agencyId, creatorId: delivery.creatorId, moduleKey: BUMPS_MODULE_KEY, db });
  const state = await db.automationBumpFanState.findUnique({ where: { creatorId_fanId: { creatorId: delivery.creatorId, fanId: delivery.fanId } } });
  let fanCurrentFence = null;
  if (delivery.actionType === SEND_ACTION) {
    if (!delivery.dialogId) return { ok: false, terminal: true, status: "SKIPPED", code: "missing_dialog" };
    const template = object(payload.template);
    if (!template.id) return { ok: false, terminal: true, status: "SKIPPED", code: "no_template" };
    const customMediaIds = await classifyBumpCustomMediaIds({
      agencyId: delivery.agencyId, creatorId: delivery.creatorId, mediaIds: template.mediaFiles, db,
    });
    if (customMediaIds.size) {
      return {
        ok: false, terminal: true, status: "SKIPPED", code: "custom_media_programmatic_forbidden",
        customMediaIds: [...customMediaIds],
      };
    }
    if (state?.blocked) return { ok: false, terminal: true, status: "CANCELED", code: "blocked" };
    if (state?.ignored) return { ok: false, terminal: true, status: "CANCELED", code: "ignored" };
    if (state?.pendingMessageId && state.pendingDeliveryId !== delivery.id) return { ok: false, terminal: true, status: "SKIPPED", code: "pending_reply" };
    if (state?.cooldownUntil && state.cooldownUntil > now) return { ok: false, terminal: false, code: "fan_cooldown", retryAt: state.cooldownUntil };
    const source = sourceKey(payload.source);
    const currentByFan = await readFanCurrentMap(db, {
      agencyId: delivery.agencyId,
      creatorId: delivery.creatorId,
      fanIds: [delivery.fanId || delivery.targetId],
    });
    const current = currentByFan.get(String(delivery.fanId || delivery.targetId || "")) || null;
    const currentDecision = validateBumpCurrentRelationship({
      candidate: { fanId: delivery.fanId || delivery.targetId, dialogId: delivery.dialogId },
      current,
      source,
      now,
    });
    if (!currentDecision.ok) {
      if (currentDecision.refreshRequired === true) {
        return {
          ok: false,
          terminal: false,
          status: "SKIPPED",
          code: currentDecision.code,
          retryAt: new Date(now.getTime() + 30_000),
          refreshRequired: true,
          refreshFanIds: [String(delivery.fanId || delivery.targetId || "")].filter(Boolean),
          refreshFields: currentDecision.refreshFields || [],
          freshnessClass: currentDecision.freshnessClass || null,
        };
      }
      return { ok: false, terminal: currentDecision.terminal !== false, status: "SKIPPED", code: currentDecision.code };
    }
    fanCurrentFence = buildFanCurrentFieldFence(current, bumpRequiredFields(source));
    if (source === "online") {
      const observed = state?.lastOnlineAt;
      if (!observed || observed.getTime() < now.getTime() - snapshot.modules.bumps.settings.onlineObservationTtlMs) {
        return { ok: false, terminal: true, status: "SKIPPED", code: "stale_candidate" };
      }
    }
    if (payload.snapshotRunId) {
      const current = await currentSubscriberRun({ agencyId: delivery.agencyId, creatorId: delivery.creatorId, db });
      if (!current?.currentRunId || current.currentRunId !== payload.snapshotRunId) return { ok: false, terminal: true, status: "SKIPPED", code: "stale_candidate" };
    }
  }
  if (delivery.actionType === DELETE_ACTION) {
    const messageId = clean(payload.messageId || delivery.targetId, 160);
    if (!messageId) return { ok: false, terminal: true, status: "SKIPPED", code: "message_id_missing" };
    if (!state?.pendingMessageId || state.pendingMessageId !== messageId) return { ok: false, terminal: true, status: "SKIPPED", code: "cancel_not_needed" };
    if (state.lastAnyRepliedAt && state.lastAnyRepliedAt > (delivery.createdAt || new Date(0))) return { ok: false, terminal: true, status: "SKIPPED", code: "replied" };
  }
  return { ok: true, ...(fanCurrentFence ? { fanCurrentFence } : {}) };
}

async function finalizeBumpSend({ delivery, result, db = prisma }) {
  if (!delivery || delivery.moduleKey !== BUMPS_MODULE_KEY || delivery.actionType !== SEND_ACTION) return null;
  const payload = object(delivery.payload);
  const template = object(payload.template);
  const timing = object(payload.timing);
  const messageId = clean(result.messageId || delivery.messageId, 160);
  if (!messageId) throw Object.assign(new Error("Bump send result is missing messageId"), { code: "message_id_missing", status: 409 });
  const sentAt = date(result.sentAt || delivery.sentAt) || new Date();
  const deleteAfter = int(timing.deleteAfterNoReplyMs, 60 * 60_000, 60_000, 14 * 24 * 60 * 60_000);
  const cancelAt = new Date(sentAt.getTime() + deleteAfter);
  const afterSendCooldown = int(timing.afterSendCooldownMs, 6 * 60 * 60_000, 0, 90 * 24 * 60 * 60_000);
  const sameTemplateCooldown = int(timing.sameTemplateCooldownMs, 24 * 60 * 60_000, 0, 90 * 24 * 60 * 60_000);

  const cancelPayload = {
    schemaVersion: 1,
    sourceDeliveryId: delivery.id,
    source: payload.source || delivery.trigger || "manual",
    messageId,
    dialogId: delivery.dialogId,
    fanId: delivery.fanId,
    sentAt: sentAt.toISOString(),
    templateId: template.id || delivery.contentCollectionId || null,
    afterReplyCooldownMs: int(timing.afterReplyCooldownMs, 24 * 60 * 60_000, 0, 90 * 24 * 60 * 60_000),
  };
  const cancelKey = `bump_cancel:${delivery.creatorId}:${messageId}`;
  let cancel = assertAutomationDeliveryAdoption(await db.automationDelivery.findUnique({ where: { idempotencyKey: cancelKey } }), { agencyId: delivery.agencyId, creatorId: delivery.creatorId, moduleKey: BUMPS_MODULE_KEY, actionType: DELETE_ACTION });
  if (!cancel) {
    cancel = await db.automationDelivery.create({
      data: {
        agencyId: delivery.agencyId, creatorId: delivery.creatorId, originKind: "AUTOMATION", moduleKey: BUMPS_MODULE_KEY,
        actionType: DELETE_ACTION, targetId: messageId, fanId: delivery.fanId, dialogId: delivery.dialogId,
        idempotencyKey: cancelKey, generation: delivery.generation,
        priority: 120, payload: cancelPayload, contentCollectionId: template.id || delivery.contentCollectionId,
        trigger: payload.source || delivery.trigger, status: "QUEUED", scheduledAt: cancelAt, notBefore: cancelAt,
        maxAttempts: 5, messageId, createdByUserId: delivery.createdByUserId,
      },
    });
  } else if (ACTIVE_ACTION_STATUSES.includes(cancel.status)) {
    cancel = await db.automationDelivery.update({
      where: { id: cancel.id },
      data: { notBefore: cancelAt, scheduledAt: cancelAt, payload: cancelPayload, messageId },
    });
  }
  const existingState = await db.automationBumpFanState.findUnique({ where: { creatorId_fanId: { creatorId: delivery.creatorId, fanId: delivery.fanId } } });
  await db.automationBumpFanState.upsert({
    where: { creatorId_fanId: { creatorId: delivery.creatorId, fanId: delivery.fanId } },
    create: {
      agencyId: delivery.agencyId, creatorId: delivery.creatorId, fanId: delivery.fanId, dialogId: delivery.dialogId,
      lastTemplateId: template.id || delivery.contentCollectionId, lastStatus: "PENDING_REPLY",
      lastSentAt: sentAt, lastAnySentAt: sentAt, lastBumpSentAt: sentAt, lastTemplateSentAt: sentAt,
      lastMessageId: messageId, pendingMessageId: messageId, pendingDeliveryId: delivery.id, pendingCancelAt: cancelAt,
      cooldownUntil: new Date(sentAt.getTime() + afterSendCooldown),
      templateCooldownUntil: new Date(sentAt.getTime() + sameTemplateCooldown),
      templateIds: [template.id || delivery.contentCollectionId].filter(Boolean),
      counters: { sent: 1 }, metadata: { cancelDeliveryId: cancel.id, source: payload.source || null },
    },
    update: {
      dialogId: delivery.dialogId, lastTemplateId: template.id || delivery.contentCollectionId, lastStatus: "PENDING_REPLY",
      lastSentAt: sentAt, lastAnySentAt: sentAt, lastBumpSentAt: sentAt, lastTemplateSentAt: sentAt,
      lastMessageId: messageId, pendingMessageId: messageId, pendingDeliveryId: delivery.id, pendingCancelAt: cancelAt,
      cooldownUntil: new Date(sentAt.getTime() + afterSendCooldown),
      templateCooldownUntil: new Date(sentAt.getTime() + sameTemplateCooldown),
      templateIds: [...new Set([...(Array.isArray(existingState?.templateIds) ? existingState.templateIds : []), template.id || delivery.contentCollectionId].filter(Boolean))].slice(-20),
      counters: { ...object(existingState?.counters), sent: Number(object(existingState?.counters).sent || 0) + 1 },
      metadata: { ...object(existingState?.metadata), cancelDeliveryId: cancel.id, source: payload.source || null },
    },
  });
  await bumpStat({ agencyId: delivery.agencyId, creatorId: delivery.creatorId, templateId: template.id || delivery.contentCollectionId || "", field: "sent", at: sentAt, db });
  return { cancelDelivery: cancel, cancelAt, messageId, sentAt };
}

async function finalizeBumpDelete({ delivery, result, outcomeCode, db = prisma }) {
  if (!delivery || delivery.moduleKey !== BUMPS_MODULE_KEY || delivery.actionType !== DELETE_ACTION) return null;
  const payload = object(delivery.payload);
  const messageId = clean(payload.messageId || delivery.targetId || delivery.messageId, 160);
  const state = await db.automationBumpFanState.findUnique({ where: { creatorId_fanId: { creatorId: delivery.creatorId, fanId: delivery.fanId } } });
  const replied = outcomeCode === "replied" || result.replied === true;
  const canceled = outcomeCode === "message_deleted" || outcomeCode === "message_not_found" || result.deleted === true;
  const at = date(result.repliedAt || result.deletedAt) || new Date();
  let changed = 0;
  if (replied) {
    const cooldownMs = int(payload.afterReplyCooldownMs, 24 * 60 * 60_000, 0, 90 * 24 * 60 * 60_000);
    const transition = await db.automationBumpFanState.updateMany({
      where: { creatorId: delivery.creatorId, fanId: delivery.fanId, pendingMessageId: messageId },
      data: {
        lastStatus: "REPLIED", lastAnyRepliedAt: at, lastReplyMessageId: clean(result.replyMessageId, 160),
        lastFinalizedAt: at, pendingMessageId: null, pendingDeliveryId: null, pendingCancelAt: null,
        cooldownUntil: new Date(at.getTime() + cooldownMs),
        counters: { ...object(state?.counters), replied: Number(object(state?.counters).replied || 0) + 1 },
      },
    });
    changed = transition.count;
    if (changed) await bumpStat({ agencyId: delivery.agencyId, creatorId: delivery.creatorId, templateId: clean(payload.templateId, 160) || "", field: "replied", at, db });
  } else if (canceled) {
    const transition = await db.automationBumpFanState.updateMany({
      where: { creatorId: delivery.creatorId, fanId: delivery.fanId, pendingMessageId: messageId },
      data: {
        lastStatus: "CANCELED", lastFinalizedAt: at, pendingMessageId: null, pendingDeliveryId: null, pendingCancelAt: null,
        counters: { ...object(state?.counters), canceled: Number(object(state?.counters).canceled || 0) + 1 },
      },
    });
    changed = transition.count;
    if (changed) await bumpStat({ agencyId: delivery.agencyId, creatorId: delivery.creatorId, templateId: clean(payload.templateId, 160) || "", field: "canceled", at, db });
  }
  return { replied: replied && changed > 0, canceled: canceled && changed > 0, changed };
}

async function markBumpReply({ agencyId, creatorId, fanId, messageId = null, repliedAt = new Date(), source = "ws", db = prisma }) {
  return runWithAutomationWriteCommitFence({
    db,
    agencyId, creatorId,
    options: { timeout: 30_000 },
    work: async (tx) => {
      const state = await tx.automationBumpFanState.findUnique({ where: { creatorId_fanId: { creatorId, fanId } } });
      if (!state?.pendingMessageId) return { ok: true, matched: false, code: "no_pending_bump" };
      const pendingMessageId = state.pendingMessageId;
      const cancel = await tx.automationDelivery.findFirst({
        where: { agencyId, creatorId, moduleKey: BUMPS_MODULE_KEY, actionType: DELETE_ACTION, targetId: pendingMessageId, status: { in: ACTIVE_ACTION_STATUSES } },
        orderBy: { createdAt: "desc" },
      });
      const send = state.pendingDeliveryId ? await tx.automationDelivery.findUnique({ where: { id: state.pendingDeliveryId } }) : null;
      const payload = object(cancel?.payload || send?.payload);
      const timing = object(send?.payload?.timing);
      const cooldownMs = int(payload.afterReplyCooldownMs ?? timing.afterReplyCooldownMs, 24 * 60 * 60_000, 0, 90 * 24 * 60 * 60_000);
      const at = date(repliedAt) || new Date();
      const stateChanged = await tx.automationBumpFanState.updateMany({
        where: { id: state.id, pendingMessageId },
        data: {
          lastStatus: "REPLIED", lastAnyRepliedAt: at, lastReplyMessageId: clean(messageId, 160), lastFinalizedAt: at,
          pendingMessageId: null, pendingDeliveryId: null, pendingCancelAt: null,
          cooldownUntil: new Date(at.getTime() + cooldownMs),
          counters: { ...object(state.counters), replied: Number(object(state.counters).replied || 0) + 1 },
        },
      });
      if (!stateChanged.count) return { ok: true, matched: false, code: "reply_already_applied" };
      let replyObservedDuringCommit = false;
      if (cancel) {
        if (["COMMITTING", "RECONCILE_REQUIRED"].includes(cancel.status)) {
          replyObservedDuringCommit = true;
          await tx.automationDelivery.updateMany({
            where: { id: cancel.id, status: cancel.status, leaseRevision: cancel.leaseRevision },
            data: {
              result: {
                ...object(cancel.result),
                replyObservedDuringCommit: true,
                replied: true,
                repliedAt: at.toISOString(),
                replyMessageId: clean(messageId, 160),
                source,
              },
            },
          });
        } else {
          await tx.automationDelivery.updateMany({
            where: { id: cancel.id, status: { in: PRECOMMIT_MUTABLE_STATUSES }, leaseRevision: cancel.leaseRevision },
            data: {
              status: "SKIPPED", failureCode: "replied", lastError: null, finishedAt: at,
              claimedByDeviceId: null, claimedAt: null, claimUntil: null, leaseTokenHash: null, leaseRevision: { increment: 1 },
              result: { ...object(cancel.result), code: "replied", replied: true, repliedAt: at.toISOString(), replyMessageId: clean(messageId, 160), source },
            },
          });
        }
      }
      if (send) {
        await tx.automationDelivery.update({
          where: { id: send.id },
          data: { result: { ...object(send.result), replied: true, repliedAt: at.toISOString(), replyMessageId: clean(messageId, 160), replySource: source } },
        });
      }
      const templateId = clean(object(send?.payload).template?.id || send?.contentCollectionId, 160) || "";
      await bumpStat({ agencyId, creatorId, templateId, field: "replied", at, db: tx });
      return { ok: true, matched: true, pendingMessageId, cancelDeliveryId: cancel?.id || null, sendDeliveryId: send?.id || null, replyObservedDuringCommit };
    },
  });
}

async function finalizeBumpFailure({ delivery, failureCode, retryable = false, db = prisma }) {
  if (!delivery || delivery.moduleKey !== BUMPS_MODULE_KEY) return null;
  if (retryable) return { retryable: true };
  const state = await db.automationBumpFanState.findUnique({
    where: { creatorId_fanId: { creatorId: delivery.creatorId, fanId: delivery.fanId } },
  });
  let changed = 0;
  if (delivery.actionType === SEND_ACTION) {
    const transition = await db.automationBumpFanState.updateMany({
      where: { creatorId: delivery.creatorId, fanId: delivery.fanId, pendingDeliveryId: delivery.id },
      data: {
        lastStatus: "FAILED", pendingDeliveryId: null,
        counters: { ...object(state?.counters), failed: Number(object(state?.counters).failed || 0) + 1 },
      },
    });
    changed = transition.count;
  } else if (delivery.actionType === DELETE_ACTION) {
    const payload = object(delivery.payload);
    const messageId = clean(payload.messageId || delivery.targetId || delivery.messageId, 160);
    const transition = await db.automationBumpFanState.updateMany({
      where: { creatorId: delivery.creatorId, fanId: delivery.fanId, ...(messageId ? { pendingMessageId: messageId } : {}) },
      data: {
        lastStatus: "CANCEL_FAILED",
        counters: { ...object(state?.counters), failed: Number(object(state?.counters).failed || 0) + 1 },
      },
    });
    changed = transition.count;
  }
  if (changed) {
    const payload = object(delivery.payload);
    const templateId = clean(object(payload.template).id || payload.templateId || delivery.contentCollectionId, 160) || "";
    await bumpStat({ agencyId: delivery.agencyId, creatorId: delivery.creatorId, templateId, field: "failed", at: new Date(), db });
  }
  return { retryable: false, failureCode, changed };
}

async function finalizeBumpTerminal({ delivery, status, failureCode = null, db = prisma }) {
  if (!delivery || delivery.moduleKey !== BUMPS_MODULE_KEY) return null;
  const normalizedStatus = clean(status, 80) || "SKIPPED";
  const code = clean(failureCode, 120);
  const state = await db.automationBumpFanState.findUnique({
    where: { creatorId_fanId: { creatorId: delivery.creatorId, fanId: delivery.fanId } },
  });
  const terminalMetadata = { ...object(state?.metadata), terminalCode: code, terminalDeliveryId: delivery.id };
  if (delivery.actionType === SEND_ACTION) {
    const changed = await db.automationBumpFanState.updateMany({
      where: { creatorId: delivery.creatorId, fanId: delivery.fanId, pendingDeliveryId: delivery.id },
      data: {
        lastStatus: normalizedStatus,
        pendingDeliveryId: null,
        metadata: terminalMetadata,
      },
    });
    return { changed: changed.count };
  }
  if (delivery.actionType === DELETE_ACTION) {
    const payload = object(delivery.payload);
    const messageId = clean(payload.messageId || delivery.targetId || delivery.messageId, 160);
    if (!messageId || code === "cancel_not_needed") return { changed: 0 };
    if (code === "replied") {
      const changed = await db.automationBumpFanState.updateMany({
        where: { creatorId: delivery.creatorId, fanId: delivery.fanId, pendingMessageId: messageId },
        data: {
          lastStatus: "REPLIED",
          pendingMessageId: null,
          pendingDeliveryId: null,
          pendingCancelAt: null,
          lastFinalizedAt: new Date(),
        },
      });
      return { changed: changed.count };
    }
    const changed = await db.automationBumpFanState.updateMany({
      where: { creatorId: delivery.creatorId, fanId: delivery.fanId, pendingMessageId: messageId },
      data: {
        lastStatus: normalizedStatus === "CANCELED" ? "PENDING_REPLY" : `CANCEL_${normalizedStatus}`,
        pendingCancelAt: null,
        metadata: terminalMetadata,
      },
    });
    return { changed: changed.count };
  }
  return null;
}

async function prepareBumpRetry({ delivery, db = prisma }) {
  if (!delivery || delivery.moduleKey !== BUMPS_MODULE_KEY) return { changed: 0 };
  if (delivery.actionType === SEND_ACTION) {
    const changed = await db.automationBumpFanState.updateMany({
      where: {
        creatorId: delivery.creatorId,
        fanId: delivery.fanId,
        pendingMessageId: null,
        OR: [{ pendingDeliveryId: null }, { pendingDeliveryId: delivery.id }],
      },
      data: { pendingDeliveryId: delivery.id, lastStatus: "QUEUED" },
    });
    return { changed: changed.count };
  }
  if (delivery.actionType === DELETE_ACTION) {
    const payload = object(delivery.payload);
    const messageId = clean(payload.messageId || delivery.targetId || delivery.messageId, 160);
    if (!messageId) return { changed: 0 };
    const changed = await db.automationBumpFanState.updateMany({
      where: { creatorId: delivery.creatorId, fanId: delivery.fanId, pendingMessageId: messageId },
      data: { pendingCancelAt: delivery.notBefore, lastStatus: "PENDING_REPLY" },
    });
    return { changed: changed.count };
  }
  return { changed: 0 };
}

async function triggerPendingReplyScan({ agencyId, creatorId, limit = 100, db = prisma }) {
  await assertAutomationEnabled({ agencyId, creatorId, moduleKey: BUMPS_MODULE_KEY, db });
  const now = new Date();
  const rows = await db.automationDelivery.findMany({
    where: {
      agencyId, creatorId, moduleKey: BUMPS_MODULE_KEY, actionType: DELETE_ACTION,
      status: { in: ["QUEUED", "RETRY_SCHEDULED"] },
    },
    orderBy: [{ notBefore: "asc" }, { createdAt: "asc" }],
    take: Math.max(1, Math.min(500, Number(limit) || 100)),
    select: { id: true },
  });
  if (!rows.length) return { ok: true, scheduled: 0 };
  const changed = await db.automationDelivery.updateMany({
    where: { id: { in: rows.map((row) => row.id) }, status: { in: ["QUEUED", "RETRY_SCHEDULED"] } },
    data: { notBefore: now, failureCode: null, lastError: null },
  });
  return { ok: true, scheduled: changed.count, at: now };
}

async function processRuntimeEvents({ agencyId, creatorId, events = [], userId = null, sourceDeviceId = null, db = prisma, commitFence = null, reconcileOnly = false }) {
  const rows = Array.isArray(events) ? events.slice(0, 500) : [];
  const summary = { ok: true, received: rows.length, onlineObserved: 0, replies: 0, planned: 0, ignored: 0, errors: [] };
  const onlineIds = new Set();
  let onlineObservedAt = null;
  const subscriptionByFan = new Map();
  const replies = [];
  const runCommit = typeof commitFence === "function"
    ? commitFence
    : async (work) => work(db);

  for (const event of rows) {
    const type = clean(event?.type, 80);
    if (type === "presence_online") {
      for (const fanId of event.fanIds || event.onlineIds || []) {
        const normalized = clean(fanId, 160);
        if (normalized) onlineIds.add(normalized);
      }
      const observedAt = date(event.createdAt || event.ts) || new Date();
      if (!onlineObservedAt || observedAt > onlineObservedAt) onlineObservedAt = observedAt;
    } else if (type === "chat_message_received") {
      replies.push(event);
    } else if (type === "subscription_created") {
      const fanId = clean(event.fanId, 160);
      if (fanId) subscriptionByFan.set(fanId, event);
      else summary.ignored += 1;
    } else {
      summary.ignored += 1;
    }
  }

  try {
    if (onlineIds.size) {
      const observed = await runCommit((commitDb) => recordOnlineObservations({
        agencyId,
        creatorId,
        fanIds: [...onlineIds],
        observedAt: onlineObservedAt || new Date(),
        metadata: { source: "ws" },
        sourceDeviceId,
        db: commitDb,
      }));
      summary.onlineObserved += Number(observed?.count || 0);
      const plannedCount = await runCommit(async (commitDb) => {
        const control = await getAutomationControlSnapshot({ agencyId, creatorId, db: commitDb });
        if (!control.effective.bumpsEnabled || !control.modules.bumps.settings.automatic || !control.modules.bumps.settings.onlineEnabled) return 0;
        const planned = await planBumps({
          agencyId,
          creatorId,
          userId,
          source: "online",
          fanIds: observed.fanIds,
          limit: observed.fanIds.length,
          db: commitDb,
        });
        return Number(planned.planned || 0);
      });
      summary.planned += Number(plannedCount || 0);
    }
  } catch (error) {
    summary.errors.push({ type: "presence_online", code: error?.code || "event_failed", error: String(error?.message || error).slice(0, 500) });
  }

  for (const event of replies) {
    try {
      const fanId = clean(event.fanId, 160);
      if (!fanId) { summary.ignored += 1; continue; }
      const reply = await runCommit((commitDb) => markBumpReply({
        agencyId,
        creatorId,
        fanId,
        messageId: event.messageId,
        repliedAt: event.createdAt || event.changedAt || new Date(),
        source: clean(event.source, 80) || "ws",
        db: commitDb,
      }));
      if (reply.matched) summary.replies += 1;
    } catch (error) {
      summary.errors.push({ type: "chat_message_received", code: error?.code || "event_failed", error: String(error?.message || error).slice(0, 500) });
    }
  }

  if (subscriptionByFan.size) {
    try {
      const entries = [...subscriptionByFan.entries()];
      const observations = entries.map(([fanId, event]) => ({
        fanId,
        dialogId: clean(event.dialogId, 160) || fanId,
        observedAt: date(event.createdAt || event.occurredAt || event.ts),
        metadata: {
          source: clean(event.source, 80) || "subscription_event",
          dialogId: clean(event.dialogId, 160) || fanId,
          providerEventId: clean(event.providerEventId || event.notificationId || event.externalEventId, 240),
          providerOccurredAt: date(event.createdAt || event.occurredAt || event.ts)?.toISOString?.() || null,
        },
        // A notification proves that an event was reported, but transport order,
        // producer clock and provider-observation order are not one causal clock.
        // Do not invent a scalar LIVE_NOTIFICATION winner. Reconcile current
        // relationship from a new server-issued provider profile generation.
        fanObservation: null,
      }));
      const observed = reconcileOnly ? { fanIds: entries.map(([fanId]) => fanId) } : await runCommit((commitDb) => recordDetailedObservations({
        agencyId, creatorId, observations, sourceDeviceId, updateLastOnlineAt: false, db: commitDb,
      }));

      const refreshDecision = await runCommit(async (commitDb) => {
        const authorityNow = await dbAuthorityNow({ db: commitDb, fallbackNow: new Date() });
        const barrier = stableFingerprint(entries.map(([fanId, event]) => ({
          fanId,
          providerEventId: clean(event.providerEventId || event.notificationId || event.externalEventId, 240),
          providerOccurredAt: date(event.createdAt || event.occurredAt || event.ts)?.toISOString?.() || null,
        })).sort((a, b) => String(a.fanId).localeCompare(String(b.fanId))));
        return scheduleFanDataPointRefresh({
          db: commitDb,
          agencyId,
          creatorId,
          onlyFansUserIds: observed.fanIds,
          reason: "bump_runtime_subscription_event_reconcile",
          priority: 98,
          now: authorityNow,
          params: {
            consumer: "bumps_runtime",
            trigger: "subscription_created",
            causalBarrierKey: `runtime-subscription:${barrier}`,
            refreshFields: ["fanSubscribesToCreator", "fanSubscriptionActive", "fanSubscriptionType", "canReceiveChatMessage"],
          },
        });
      });
      summary.subscriptionReconcile = { fanIds: observed.fanIds, decision: refreshDecision };
      if (Number(refreshDecision?.requested || 0) > 0 && refreshDecision?.durable !== true) {
        throw Object.assign(new Error("Subscription reconciliation was not durably scheduled"), { code: "FAN_REFRESH_INTENT_NOT_DURABLE" });
      }

      const plannedCount = await runCommit(async (commitDb) => {
        if (reconcileOnly) return 0; // Historical repair requests current facts; it must not replay outbound automation.
        const control = await getAutomationControlSnapshot({ agencyId, creatorId, db: commitDb });
        if (!control.effective.bumpsEnabled || !control.modules.bumps.settings.automatic || !control.modules.bumps.settings.subscriptionEventsEnabled) return 0;
        const planned = await planBumps({
          agencyId,
          creatorId,
          userId,
          source: "subscription_event",
          fanIds: observed.fanIds,
          limit: observed.fanIds.length,
          db: commitDb,
        });
        return Number(planned.planned || 0);
      });
      summary.planned += Number(plannedCount || 0);
    } catch (error) {
      summary.errors.push({ type: "subscription_created", code: error?.code || "event_failed", error: String(error?.message || error).slice(0, 500) });
    }
  }

  return summary;
}

async function planConfiguredBumpSources({
  agencyId, creatorId, userId = null, source = "manual", requireAutomatic = true, manual = false, db = prisma,
  scheduleFanRefresh = scheduleFanDataPointRefresh,
}) {
  const control = await getAutomationControlSnapshot({ agencyId, creatorId, db });
  if (!control.effective.bumpsEnabled) {
    return { ok: true, created: false, reason: "module_disabled", planned: 0, sources: [], readyDevices: 0, skipCounts: { module_disabled: 1 } };
  }
  const settings = control.modules.bumps.settings;
  if (requireAutomatic && !settings.automatic) {
    return { ok: true, created: false, reason: "automatic_disabled", planned: 0, sources: [], readyDevices: await sessionWriteWorkerCount({ agencyId, creatorId, db }), skipCounts: { automatic_disabled: 1 } };
  }
  const requested = configuredSnapshotSources(settings);
  if (!requested.length) {
    return { ok: true, created: false, reason: "no_sources_enabled", planned: 0, sources: [], readyDevices: await sessionWriteWorkerCount({ agencyId, creatorId, db }), skipCounts: { no_sources_enabled: 1 } };
  }

  const sources = [];
  let planned = 0;
  for (const candidateSource of requested) {
    try {
      const result = await planBumps({
        agencyId, creatorId, userId, source: candidateSource,
        limit: Math.min(settings.candidateBatchSize, Math.max(1, settings.dailyLimit)),
        manual, db, scheduleFanRefresh,
      });
      const refreshDebt = Number(result?.fanRefresh?.requested || 0) > 0 && result?.fanRefresh?.durable !== true;
      sources.push({
        source: candidateSource,
        ok: !refreshDebt,
        planned: result.planned || 0,
        skipped: result.skipped || [],
        ...(result?.fanRefresh ? { fanRefresh: result.fanRefresh } : {}),
        ...(refreshDebt ? { code: "fan_refresh_debt_not_durable", error: result?.fanRefresh?.error || "fan refresh intent was not durably scheduled" } : {}),
      });
      planned += Number(result.planned || 0);
    } catch (error) {
      sources.push({ source: candidateSource, ok: false, code: error?.code || "planning_failed", error: String(error?.message || error).slice(0, 500), skipped: [] });
    }
  }
  const skipCounts = summarizePlanningSkips(sources);
  const readyDevices = await sessionWriteWorkerCount({ agencyId, creatorId, db });
  const firstFailure = Object.keys(skipCounts)[0] || null;
  const ok = sources.every((row) => row?.ok !== false);
  return {
    ok, created: planned > 0,
    reason: ok ? (planned > 0 ? source : (firstFailure || "no_eligible_candidates")) : (firstFailure || "planning_failed"),
    planned, sources, requestedSources: requested, readyDevices, skipCounts,
  };
}

async function ensureAutomaticBumps({
  agencyId, creatorId, userId = null, source = "recurring_scheduler", db = prisma,
  scheduleFanRefresh = scheduleFanDataPointRefresh,
}) {
  return planConfiguredBumpSources({
    agencyId, creatorId, userId, source, requireAutomatic: true, manual: false, db, scheduleFanRefresh,
  });
}

async function planConfiguredBumpsNow({ agencyId, creatorId, userId = null, source = "manual_plan_now", db = prisma }) {
  return planConfiguredBumpSources({ agencyId, creatorId, userId, source, requireAutomatic: false, manual: true, db });
}

async function getBumpOverview({ agencyId, creatorId, db = prisma }) {
  const control = await getAutomationControlSnapshot({ agencyId, creatorId, db });
  const now = new Date();
  const settings = control.modules.bumps.settings;
  const snapshot = await currentSubscriberRun({ agencyId, creatorId, db });
  const snapshotSources = configuredSnapshotSources(settings);
  const [templates, fanStates, queued, claimed, running, completed, failed, replied, canceled, readyDevices] = await Promise.all([
    db.automationTask.count({ where: { agencyId, creatorId, type: "bump_online", deletedAt: null } }),
    db.automationBumpFanState.count({ where: { agencyId, creatorId } }),
    db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: BUMPS_MODULE_KEY, status: { in: ["QUEUED", "RETRY_SCHEDULED"] } } }),
    db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: BUMPS_MODULE_KEY, status: "CLAIMED" } }),
    db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: BUMPS_MODULE_KEY, status: { in: ["RUNNING", "COMMITTING", "RECONCILE_REQUIRED"] } } }),
    db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: BUMPS_MODULE_KEY, actionType: SEND_ACTION, status: "COMPLETED", finishedAt: { gte: dayStart(now) } } }),
    db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: BUMPS_MODULE_KEY, status: "FAILED", updatedAt: { gte: dayStart(now) } } }),
    db.bumpDeliveryStat.aggregate({ where: { agencyId, creatorId }, _sum: { replied: true } }),
    db.bumpDeliveryStat.aggregate({ where: { agencyId, creatorId }, _sum: { canceled: true } }),
    sessionWriteWorkerCount({ agencyId, creatorId, db }),
  ]);

  const templateCounts = {};
  for (const source of ["online", "hidden_online", "paid_subscriber", "free_subscriber", "subscription_event"]) {
    templateCounts[source] = (await activeTemplates({ agencyId, creatorId, source, eligibleLimit: 500, db })).templates.length;
  }

  const candidateCounts = { online: 0, hidden_online: 0, paid_subscriber: 0, free_subscriber: 0 };
  candidateCounts.online = await db.automationBumpFanState.count({
    where: {
      agencyId, creatorId,
      lastOnlineAt: { gte: new Date(now.getTime() - settings.onlineObservationTtlMs) },
    },
  });
  if (snapshot?.currentRunId) {
    const [counts] = await db.$queryRawUnsafe(`
      SELECT COUNT(*) FILTER (WHERE r."lastSeenAt" IS NULL AND r."lastSeenAtAuthorityVersion" IS NOT NULL) AS hidden,
        COUNT(*) FILTER (WHERE r."fanSubscriptionActive"=TRUE AND r."fanSubscriptionActiveAuthorityVersion" IS NOT NULL
          AND r."fanSubscriptionTypeAuthorityVersion" IS NOT NULL
          AND LOWER(r."fanSubscriptionType") NOT LIKE '%expired%' AND LOWER(r."fanSubscriptionType") NOT LIKE '%free%'
          AND (LOWER(r."fanSubscriptionType") LIKE '%paid%' OR LOWER(r."fanSubscriptionType") LIKE '%active%')) AS paid,
        COUNT(*) FILTER (WHERE r."fanSubscriptionActive"=TRUE AND r."fanSubscriptionActiveAuthorityVersion" IS NOT NULL
          AND r."fanSubscriptionTypeAuthorityVersion" IS NOT NULL
          AND LOWER(r."fanSubscriptionType") NOT LIKE '%expired%' AND LOWER(r."fanSubscriptionType") LIKE '%free%') AS free
        FROM "SubscriberScanItem" i
        JOIN "CreatorFanRelationshipCurrent" r ON r."agencyId"=i."agencyId" AND r."creatorId"=i."creatorId" AND r."onlyFansUserId"=i."fanId"
       WHERE i."agencyId"=$1 AND i."creatorId"=$2 AND i."runId"=$3`, agencyId, creatorId, snapshot.currentRunId);
    candidateCounts.hidden_online = Number(counts?.hidden || 0);
    candidateCounts.paid_subscriber = Number(counts?.paid || 0);
    candidateCounts.free_subscriber = Number(counts?.free || 0);
  }

  const reasons = [];
  if (!control.effective.bumpsEnabled) reasons.push("module_disabled");
  if (!settings.automatic) reasons.push("automatic_disabled");
  if (!snapshot?.currentRunId && snapshotSources.length) reasons.push("snapshot_not_ready");
  if (!snapshotSources.length && !settings.onlineEnabled && !settings.subscriptionEventsEnabled) reasons.push("no_sources_enabled");
  const enabledSources = [
    ...(settings.onlineEnabled ? ["online"] : []),
    ...snapshotSources,
    ...(settings.subscriptionEventsEnabled ? ["subscription_event"] : []),
  ];
  if (enabledSources.length && enabledSources.every((source) => Number(templateCounts[source] || 0) === 0)) reasons.push("no_template");
  const snapshotCandidateTotal = snapshotSources.reduce((sum, source) => sum + Number(candidateCounts[source] || 0), 0);
  if (snapshot?.currentRunId && snapshotSources.length && snapshotCandidateTotal === 0) reasons.push("no_candidates");
  if (!readyDevices) reasons.push("no_ready_worker");

  return {
    ok: true, creatorId, control,
    worker: { ready: readyDevices > 0, readyDevices },
    planning: {
      ready: reasons.length === 0,
      primaryReason: reasons[0] || "ready",
      reasons,
      automatic: settings.automatic === true,
      snapshotRunId: snapshot?.currentRunId || null,
      snapshotPublishedAt: snapshot?.publishedAt || null,
      enabledSources,
      templateCounts,
      candidateCounts,
    },
    metrics: { templates, fanStates, queued, claimed, running, sentToday: completed, failedToday: failed, replied: replied._sum.replied || 0, canceled: canceled._sum.canceled || 0 },
  };
}

module.exports = {
  SEND_ACTION,
  DELETE_ACTION,
  ACTIVE_ACTION_STATUSES,
  planBumps,
  scheduleBumpCurrentRefresh,
  activeTemplates,
  planConfiguredBumpsNow,
  summarizePlanningSkips,
  recordOnlineObservations,
  processRuntimeEvents,
  ensureAutomaticBumps,
  validateBumpDelivery,
  finalizeBumpSend,
  finalizeBumpDelete,
  finalizeBumpFailure,
  finalizeBumpTerminal,
  prepareBumpRetry,
  markBumpReply,
  triggerPendingReplyScan,
  getBumpOverview,
};

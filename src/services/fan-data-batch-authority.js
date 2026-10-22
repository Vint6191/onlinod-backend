"use strict";
const { isDeepStrictEqual } = require("node:util");
const MAX_BATCH = 20;
function fail(code, message = code) { throw Object.assign(new Error(message), { code, status: 409 }); }
function state(value) { const row = value && typeof value === "object" ? value : {}; return row.driverPhase ? row.jobContinuation || {} : row; }
function ids(value) { return [...new Set((Array.isArray(value) ? value : []).map(value => String(value || "").trim()).filter(Boolean))]; }
function index(value) { return Number.isSafeInteger(value) && value >= 0 ? value : 0; }
const RELATIONSHIP_FIELDS = ["fanSubscribesToCreator", "fanSubscriptionActive", "fanSubscriptionType", "fanSubscriptionExpiresAt",
  "creatorFollowsFan", "creatorFollowExpiresAt", "canReceiveChatMessage", "blocked", "restricted", "performer", "lastSeenAt", "subscribePriceCents"];
const IDENTITY_FIELDS = { username: "usernameAuthorityVersion", displayName: "displayNameAuthorityVersion", platformDisplayName: "displayNameAuthorityVersion",
  avatarUrl: "avatarAuthorityVersion", headerUrl: "headerAuthorityVersion" };
const VALUE_FIELDS = ["platformReportedTotalSpendCents", "messagesSpentCents", "subscriptionsSpentCents", "tipsSpentCents", "postsSpentCents", "streamsSpentCents", "lastActivityAt"];
function compatibleFieldsSatisfied(fan, fields, cutoff, now, isFresh) {
  if (!cutoff || !Number.isFinite(+new Date(cutoff)) || !fields.length) return false;
  const freshVersion = value => typeof value === "string" && isFresh(value.split("|")[0], cutoff, now);
  const value = fan?.valueCurrent, relationship = fan?.relationshipCurrent;
  const knownValue = () => ["AVAILABLE", "UNAVAILABLE"].includes(value?.availability)
    && isFresh(value.valueObservedAt ?? value.fetchedAt, cutoff, now)
    && (value.availability === "UNAVAILABLE" || value.platformReportedTotalSpendCents != null || value.totalNetCents != null);
  return fields.every(field => {
    if (field === "value") return knownValue();
    if (field === "identity") return ["usernameAuthorityVersion", "displayNameAuthorityVersion", "avatarAuthorityVersion", "headerAuthorityVersion"].every(key => freshVersion(fan?.[key]));
    if (field === "relationship") return RELATIONSHIP_FIELDS.every(key => freshVersion(relationship?.[`${key}AuthorityVersion`]));
    if (IDENTITY_FIELDS[field]) return freshVersion(fan?.[IDENTITY_FIELDS[field]]);
    if (RELATIONSHIP_FIELDS.includes(field)) return freshVersion(relationship?.[`${field}AuthorityVersion`]);
    if (VALUE_FIELDS.includes(field)) return knownValue() && (value.availability === "UNAVAILABLE" || freshVersion(value[`${field}AuthorityVersion`]));
    return false;
  });
}
function scope(job, batch, { lookahead = false } = {}) {
  if (job?.jobKey !== "fan_data_point_refresh") fail("FAN_DATA_BATCH_JOB_INVALID");
  const requested = ids(job?.params?.fanIds), start = batch?.startIndex, fanIds = batch?.fanIds;
  if (!Number.isSafeInteger(start) || start < 0 || !Array.isArray(fanIds) || fanIds.length > MAX_BATCH
    || !isDeepStrictEqual(requested.slice(start, start + fanIds.length), fanIds)) fail("FAN_DATA_BATCH_SCOPE_INVALID");
  const durableIndex = index(state(job.continuation).index);
  if (start < durableIndex || (lookahead ? start + fanIds.length > durableIndex + 2 * MAX_BATCH : start !== durableIndex)) fail("FAN_DATA_BATCH_CHECKPOINT_MISMATCH");
  return { requested, startIndex: start, endIndex: start + fanIds.length, fanIds };
}

// A fixed job scope is never rewritten at admission. Fresh canonical evidence is
// checked in one bounded set and its ids travel with the immutable batch receipt.
async function recheckFanDataBatchDemand({ db, job, batch, now = new Date() }) {
  const checked = scope(job, batch, { lookahead: true });
  if (!checked.fanIds.length) return { ...checked, readFanIds: [], reusedFanIds: [], reusedUnavailableFanIds: [] };
  const { acquireCampaignTransactionLock } = require("./campaign-transaction-lock-service");
  await acquireCampaignTransactionLock(db, job.creatorId);
  const queue = require("./campaign-fan-refresh-queue-service");
  await queue.reconcileCampaignFanRefreshDemandsFromCanonicalObservations({
    db, creatorId: job.creatorId, fanIds: checked.fanIds, now, _campaignLockHeld: true,
  });
  const demands = Number(job.params?.campaignRefreshQueueVersion || 0) >= 1
    ? await db.creatorFanRefreshDemand.findMany({ where: { creatorId: job.creatorId, onlyFansUserId: { in: checked.fanIds } }, take: MAX_BATCH }) : [];
  const fans = await db.creatorFan.findMany({ where: { creatorId: job.creatorId, onlyFansUserId: { in: checked.fanIds } }, include: { valueCurrent: true, relationshipCurrent: true }, take: MAX_BATCH });
  const byId = new Map(fans.map(fan => [String(fan.onlyFansUserId), fan]));
  const demandById = new Map(demands.map(row => [String(row.onlyFansUserId), row]));
  const reusedFanIds = [], reusedUnavailableFanIds = [], readFanIds = [];
  const explicitFields = Array.isArray(job.params?.refreshFields) ? job.params.refreshFields : [];
  for (const fanId of checked.fanIds) {
    const demand = demandById.get(fanId), fan = byId.get(fanId), value = fan?.valueCurrent;
    // Monetary demand and field-specific consumer demand share canonical facts,
    // but a value timestamp cannot certify a relationship/identity field. Each
    // requested field must have server-owned authority after this job's request.
    const cutoff = demand?.requestedFreshnessCutoffAt;
    const availability = String(value?.availability || "").toUpperCase();
    const campaignFresh = demand && explicitFields.length === 0 && ["AVAILABLE", "UNAVAILABLE"].includes(availability)
      && queue.campaignFanRefreshIsFresh(value?.valueObservedAt ?? value?.fetchedAt, cutoff, now)
      && (availability !== "AVAILABLE" || value?.platformReportedTotalSpendCents != null || value?.totalNetCents != null);
    const fresh = campaignFresh || compatibleFieldsSatisfied(fan, explicitFields, job.createdAt, now, queue.campaignFanRefreshIsFresh);
    if (!fresh) readFanIds.push(fanId);
    else {
      reusedFanIds.push(fanId);
      if (availability === "UNAVAILABLE") reusedUnavailableFanIds.push(fanId);
    }
  }
  return { startIndex: checked.startIndex, endIndex: checked.endIndex, readFanIds, reusedFanIds, reusedUnavailableFanIds };
}

function assertFanDataBatchProgress({ job, chunkResult, continuation }) {
  if (Number(chunkResult?.pipelineVersion || 0) !== 1) {
    if (job?.jobKey !== "fan_data_point_refresh" || Number(job.params?.fanDataPipelineVersion || state(job.continuation).pipelineVersion || 0) !== 1) return;
    const prior = state(job.continuation), requested = state(continuation);
    if (continuation?.driverPhase === "complete") {
      if (job.continuation?.driverPhase === "complete" && isDeepStrictEqual(job.continuation, continuation)) return;
      const result = continuation.result || {};
      if (index(prior.index) !== ids(job.params.fanIds).length || result.requested !== prior.index
        || result.refreshed !== index(prior.refreshed) || result.reused !== index(prior.reused)
        || result.unavailable !== index(prior.unavailable) + index(prior.reusedUnavailable) || result.errors !== index(prior.errors)
        || result.complete !== (result.unavailable === 0 && result.errors === 0)) fail("FAN_DATA_BATCH_COMPLETION_UNCONFIRMED");
    } else if (!isDeepStrictEqual(prior, requested)) fail("FAN_DATA_BATCH_RECEIPT_REQUIRED");
    return;
  }
  if (chunkResult.kind !== "fan_data_point_refresh") fail("FAN_DATA_BATCH_KIND_INVALID");
  const checked = scope(job, chunkResult);
  const before = state(job.continuation), next = continuation?.driverPhase === "complete" ? chunkResult.checkpoint || {} : state(continuation);
  if (next.index !== checked.endIndex || chunkResult.endIndex !== checked.endIndex) fail("FAN_DATA_BATCH_CHECKPOINT_INVALID");
  const items = Array.isArray(chunkResult.items) ? chunkResult.items : [];
  const reused = Array.isArray(chunkResult.reusedFanIds) ? chunkResult.reusedFanIds : [];
  const failed = Array.isArray(chunkResult.terminalFailures) ? chunkResult.terminalFailures : [];
  const returned = items.map(row => String(row?.onlyFansUserId || ""));
  const completed = [...returned, ...reused, ...failed.map(row => String(row?.fanId || ""))];
  if (new Set(completed).size !== completed.length || completed.length !== checked.fanIds.length
    || checked.fanIds.some(id => !completed.includes(id))) fail("FAN_DATA_BATCH_PREFIX_REQUIRED");
  const configuredAttempts = Number(job.params?.fanDataProfileMaxAttempts);
  const maxAttempts = Number.isSafeInteger(configuredAttempts) && configuredAttempts >= 0 ? Math.max(1, Math.min(5, configuredAttempts)) : 5;
  if (failed.some(row => row.attempts !== maxAttempts
    || row.attempts !== (before.retry?.fanId === row.fanId ? index(before.retry.attempts) : 0) + 1
    || !String(row.code || ""))) fail("FAN_DATA_BATCH_FAILURE_INVALID");
  const unavailable = items.filter(row => row?.value?.availability === "UNAVAILABLE").length;
  if (next.refreshed !== index(before.refreshed) + items.length - unavailable
    || next.unavailable !== index(before.unavailable) + unavailable
    || next.reused !== index(before.reused) + reused.length
    || next.errors !== index(before.errors) + failed.length
    || index(next.reusedUnavailable) !== index(before.reusedUnavailable) + (chunkResult.reusedUnavailableFanIds || []).length) fail("FAN_DATA_BATCH_COUNTER_INVALID");
  if ((chunkResult.reusedUnavailableFanIds || []).some(id => !reused.includes(id))
    || new Set(chunkResult.reusedUnavailableFanIds || []).size !== (chunkResult.reusedUnavailableFanIds || []).length) fail("FAN_DATA_BATCH_REUSE_INVALID");
  if (next.retry) {
    const old = before.retry?.index === next.retry.index ? index(before.retry.attempts) : 0;
    if (next.retry.index !== next.index || next.retry.fanId !== checked.requested[next.index]
      || next.retry.attempts !== old + 1 || next.retry.attempts > 5) fail("FAN_DATA_BATCH_RETRY_INVALID");
  }
}

async function validateFanDataBatchReuse({ db, job, chunkResult, now }) {
  const reused = chunkResult?.reusedFanIds || [];
  if (!reused.length) return;
  const rechecked = await recheckFanDataBatchDemand({ db, job, batch: { startIndex: chunkResult.startIndex, fanIds: chunkResult.fanIds }, now });
  if (reused.some(id => !rechecked.reusedFanIds.includes(id))
    || !isDeepStrictEqual([...chunkResult.reusedUnavailableFanIds || []].sort(),
      reused.filter(id => rechecked.reusedUnavailableFanIds.includes(id)).sort())) fail("FAN_DATA_BATCH_REUSE_STALE");
}
module.exports = { recheckFanDataBatchDemand, assertFanDataBatchProgress, validateFanDataBatchReuse, MAX_BATCH };

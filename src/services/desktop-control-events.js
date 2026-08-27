"use strict";

const { randomUUID } = require("node:crypto");

const MAX_EVENTS = 5000;
const MAX_WAIT_MS = 25_000;
const TYPES = new Set([
  "ACCESS_EPOCH_CHANGED",
  "CREATOR_REVOKED",
  "SESSION_REVISION_CHANGED",
  "NETWORK_REVISION_CHANGED",
  "KEY_VERSION_CHANGED",
  "JOB_AVAILABLE",
]);
const streamId = randomUUID();
let sequence = 0;
const events = [];
const waitersByAgency = new Map();

function clean(value, max = 220) {
  return String(value ?? "").trim().slice(0, max);
}
function int(value, minimum = 0) {
  const parsed = Math.floor(Number(value));
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : null;
}
function targetMatches(event, context) {
  const userId = clean(context?.userId, 180);
  const memberId = clean(context?.memberId, 180);
  const deviceId = clean(context?.deviceId, 180);
  if (event._targetUserId && event._targetUserId !== userId) return false;
  if (event._targetMemberId && event._targetMemberId !== memberId) return false;
  if (event._targetDeviceId && event._targetDeviceId !== deviceId) return false;
  return true;
}

function normalizeEvent(input) {
  const agencyId = clean(input?.agencyId, 180);
  const type = clean(input?.type, 80).toUpperCase();
  if (!agencyId || !TYPES.has(type)) return null;

  const base = {
    seq: ++sequence,
    type,
    emittedAt: new Date().toISOString(),
    sourceDeviceId: clean(input?.sourceDeviceId, 180) || null,
    requestId: clean(input?.requestId, 180) || null,
    _agencyId: agencyId,
    _targetUserId: clean(input?.targetUserId, 180) || null,
    _targetMemberId: clean(input?.targetMemberId, 180) || null,
    _targetDeviceId: clean(input?.targetDeviceId, 180) || null,
  };

  if (type === "SESSION_REVISION_CHANGED") {
    const creatorId = clean(input?.creatorId, 180);
    const revision = int(input?.revision, 1);
    const status = clean(input?.status, 40).toUpperCase();
    if (!creatorId || revision === null || !status) return null;
    return { ...base, creatorId, revision, status };
  }
  if (type === "NETWORK_REVISION_CHANGED") {
    const creatorId = clean(input?.creatorId, 180);
    const networkVersion = int(input?.networkVersion, 0);
    if (!creatorId || networkVersion === null) return null;
    return { ...base, creatorId, networkVersion };
  }
  if (type === "KEY_VERSION_CHANGED") {
    const creatorId = clean(input?.creatorId, 180);
    const keyVersion = int(input?.keyVersion, 1);
    if (!creatorId || keyVersion === null) return null;
    return { ...base, creatorId, keyVersion };
  }
  if (type === "ACCESS_EPOCH_CHANGED") {
    const accessEpoch = int(input?.accessEpoch, 1);
    if (accessEpoch === null) return null;
    return { ...base, accessEpoch };
  }
  if (type === "CREATOR_REVOKED") {
    const creatorId = clean(input?.creatorId, 180);
    if (!creatorId) return null;
    return { ...base, creatorId, reason: clean(input?.reason, 160) || null };
  }
  if (type === "JOB_AVAILABLE") {
    const jobId = clean(input?.jobId, 180);
    if (!jobId) return null;
    return { ...base, jobId, jobKind: clean(input?.jobKind, 100) || null, creatorId: clean(input?.creatorId, 180) || null };
  }
  return null;
}

function visible(event) {
  const output = {};
  for (const [key, value] of Object.entries(event)) {
    if (!key.startsWith("_")) output[key] = value;
  }
  return output;
}

function agencyEventsAfter({ agencyId, afterSeq, userId, memberId, deviceId }) {
  const normalizedAgencyId = clean(agencyId, 180);
  const cursor = Math.max(0, Math.floor(Number(afterSeq) || 0));
  const agencyMatches = events.filter((event) => event._agencyId === normalizedAgencyId && event.seq > cursor);
  const latestSeq = agencyMatches.length > 0 ? agencyMatches[agencyMatches.length - 1].seq : Math.max(cursor, sequence);
  return {
    streamId,
    cursor: latestSeq,
    events: agencyMatches.filter((event) => targetMatches(event, { userId, memberId, deviceId })).map(visible),
  };
}

function notifyAgency(agencyId) {
  const key = clean(agencyId, 180);
  const waiters = waitersByAgency.get(key);
  if (!waiters || waiters.size === 0) return;
  waitersByAgency.delete(key);
  for (const wake of waiters) {
    try { wake(); } catch {}
  }
}

function publishDesktopControlEvent(input) {
  const event = normalizeEvent(input);
  if (!event) throw new Error("DESKTOP_CONTROL_EVENT_INVALID");
  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  notifyAgency(event._agencyId);
  return visible(event);
}

async function waitForDesktopControlEvents({ agencyId, userId = null, memberId = null, deviceId = null, streamId: clientStreamId, afterSeq = 0, waitMs = 20_000 }) {
  const normalizedAgencyId = clean(agencyId, 180);
  if (!normalizedAgencyId) throw new Error("agencyId is required");
  const normalizedAfterSeq = clientStreamId && clean(clientStreamId, 180) !== streamId
    ? 0
    : Math.max(0, Math.floor(Number(afterSeq) || 0));
  const read = () => agencyEventsAfter({ agencyId: normalizedAgencyId, afterSeq: normalizedAfterSeq, userId, memberId, deviceId });
  let current = read();
  if (current.events.length > 0 || (clientStreamId && clean(clientStreamId, 180) !== streamId)) return current;

  const boundedWaitMs = Math.max(250, Math.min(MAX_WAIT_MS, Math.floor(Number(waitMs) || 20_000)));
  await new Promise((resolve) => {
    const key = normalizedAgencyId;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const waiters = waitersByAgency.get(key);
      waiters?.delete(finish);
      if (waiters && waiters.size === 0) waitersByAgency.delete(key);
      resolve();
    };
    const timer = setTimeout(finish, boundedWaitMs);
    timer.unref?.();
    const waiters = waitersByAgency.get(key) || new Set();
    waiters.add(finish);
    waitersByAgency.set(key, waiters);
  });
  return read();
}

function currentDesktopControlStreamId() { return streamId; }

module.exports = {
  DESKTOP_CONTROL_EVENT_TYPES: TYPES,
  publishDesktopControlEvent,
  waitForDesktopControlEvents,
  currentDesktopControlStreamId,
};

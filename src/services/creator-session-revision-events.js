"use strict";

const { randomUUID } = require("node:crypto");

const MAX_EVENTS = 5000;
const MAX_WAIT_MS = 25_000;
const streamId = randomUUID();
let sequence = 0;
const events = [];
const waitersByAgency = new Map();

function clean(value, max = 220) {
  return String(value ?? "").trim().slice(0, max);
}

function publicEvent(input) {
  const agencyId = clean(input?.agencyId);
  const creatorId = clean(input?.creatorId);
  const revision = Math.floor(Number(input?.revision));
  const status = clean(input?.status, 40).toUpperCase();
  if (!agencyId || !creatorId || !Number.isInteger(revision) || revision <= 0 || !status) return null;
  return {
    seq: ++sequence,
    creatorId,
    revision,
    status,
    sourceDeviceId: clean(input?.sourceDeviceId, 180) || null,
    requestId: clean(input?.requestId, 180) || null,
    emittedAt: new Date().toISOString(),
    _agencyId: agencyId,
  };
}

function visible(event) {
  return {
    seq: event.seq,
    creatorId: event.creatorId,
    revision: event.revision,
    status: event.status,
    sourceDeviceId: event.sourceDeviceId,
    requestId: event.requestId,
    emittedAt: event.emittedAt,
  };
}

function agencyEventsAfter(agencyId, afterSeq) {
  const normalizedAgencyId = clean(agencyId);
  const cursor = Math.max(0, Math.floor(Number(afterSeq) || 0));
  const matches = events.filter((event) => event._agencyId === normalizedAgencyId && event.seq > cursor);
  const latestSeq = matches.length > 0 ? matches[matches.length - 1].seq : Math.max(cursor, sequence);
  return { streamId, cursor: latestSeq, events: matches.map(visible) };
}

function notifyAgency(agencyId) {
  const key = clean(agencyId);
  const waiters = waitersByAgency.get(key);
  if (!waiters || waiters.size === 0) return;
  waitersByAgency.delete(key);
  for (const wake of waiters) {
    try { wake(); } catch {}
  }
}

function publishCreatorSessionRevision(input) {
  const event = publicEvent(input);
  if (!event) throw new Error("CREATOR_SESSION_REVISION_EVENT_INVALID");
  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  notifyAgency(event._agencyId);
  return visible(event);
}

async function waitForCreatorSessionRevisionEvents({ agencyId, streamId: clientStreamId, afterSeq = 0, waitMs = 20_000 }) {
  const normalizedAgencyId = clean(agencyId);
  if (!normalizedAgencyId) throw new Error("agencyId is required");
  // Server restart creates a new stream id. A client carrying an old cursor
  // must reset immediately instead of waiting for the new process sequence to
  // eventually catch up with an unrelated old number.
  const normalizedAfterSeq = clientStreamId && clean(clientStreamId) !== streamId
    ? 0
    : Math.max(0, Math.floor(Number(afterSeq) || 0));
  let current = agencyEventsAfter(normalizedAgencyId, normalizedAfterSeq);
  if (current.events.length > 0 || (clientStreamId && clean(clientStreamId) !== streamId)) return current;

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
  current = agencyEventsAfter(normalizedAgencyId, normalizedAfterSeq);
  return current;
}

function currentCreatorSessionRevisionStreamId() {
  return streamId;
}

module.exports = {
  publishCreatorSessionRevision,
  waitForCreatorSessionRevisionEvents,
  currentCreatorSessionRevisionStreamId,
};

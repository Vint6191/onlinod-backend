"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { applyLedgerSideEffects } = require("./team-ppv-ledger-service");

function hashEvent(seed) {
  return crypto.createHash("sha256").update(JSON.stringify(seed)).digest("hex").slice(0, 40);
}

function safeDate(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return new Date(n);
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : new Date();
}

function cleanString(value, max = 512) {
  const s = String(value || "").trim();
  return s ? s.slice(0, max) : null;
}


function stripInternalValue(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stripInternalValue);
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (String(key).startsWith("__")) continue;
    out[key] = stripInternalValue(val);
  }
  return out;
}

function stripInternalEventFields(event) {
  const clean = stripInternalValue(event || {});
  return clean && typeof clean === "object" ? clean : {};
}


async function resolveCreator({ agencyId, event }) {
  const candidates = [];
  const accountId = cleanString(event.accountId, 160);
  const creatorRef = cleanString(event.creatorRef, 160);
  const remoteId = cleanString(event.remoteId || event.ofUserId || event.extra?.remoteId || event.extra?.creatorUserId, 160);
  const username = cleanString(event.username || event.extra?.username, 160);

  // accountId from Electron can be either backend creator id or local account id.
  // Try id first; if it misses, keep storing accountId as raw telemetry ref.
  if (accountId) candidates.push({ id: accountId });
  if (remoteId) candidates.push({ remoteId });
  if (creatorRef) candidates.push({ username: creatorRef.replace(/^@/, "") });
  if (username) candidates.push({ username: username.replace(/^@/, "") });

  for (const where of candidates) {
    try {
      const creator = await prisma.creatorAccount.findFirst({
        where: { agencyId, deletedAt: null, ...where },
        select: { id: true, username: true, remoteId: true },
      });
      if (creator) return creator;
    } catch (_) {}
  }
  return null;
}

async function resolveMember({ agencyId, event, fallbackUserId }) {
  const viewerId = cleanString(
    event.viewerId || event.memberId || event.userId ||
    event.extra?.viewerId || event.extra?.memberId || event.extra?.userId,
    160
  );
  if (viewerId) {
    const direct = await prisma.agencyMember.findFirst({
      where: { agencyId, id: viewerId, deletedAt: null },
      select: { id: true, userId: true },
    });
    if (direct) return direct;

    const byUser = await prisma.agencyMember.findFirst({
      where: { agencyId, userId: viewerId, deletedAt: null },
      select: { id: true, userId: true },
    });
    if (byUser) return byUser;
  }

  if (fallbackUserId) {
    const fallback = await prisma.agencyMember.findFirst({
      where: { agencyId, userId: fallbackUserId, deletedAt: null },
      select: { id: true, userId: true },
    });
    if (fallback) return fallback;
  }
  return null;
}

async function resolveExistingDeviceId({ agencyId, deviceId }) {
  const id = cleanString(deviceId, 160);
  if (!id) return null;
  try {
    const device = await prisma.workerDevice.findFirst({
      where: { agencyId, id },
      select: { id: true },
    });
    return device?.id || null;
  } catch (_) {
    return null;
  }
}

async function ingestTeamEvents({ agencyId, deviceId, userId, events = [] }) {
  const input = Array.isArray(events) ? events : [];
  const normalized = [];
  let skipped = 0;
  const safeDeviceId = await resolveExistingDeviceId({ agencyId, deviceId });

  for (const rawEvent of input) {
    const event = stripInternalEventFields(rawEvent);
    if (!event || typeof event !== "object") {
      skipped += 1;
      continue;
    }

    const type = cleanString(event.type, 80);
    if (!type) {
      skipped += 1;
      continue;
    }

    const ts = safeDate(event.ts || event.createdAt || Date.now());
    const creator = await resolveCreator({ agencyId, event });
    const member = await resolveMember({ agencyId, event, fallbackUserId: userId });

    const localId = cleanString(event.localId, 160) || hashEvent({
      deviceId: safeDeviceId || deviceId || null,
      ts: ts.getTime(),
      type,
      userId: member?.userId || userId || null,
      memberId: member?.id || null,
      accountId: event.accountId || null,
      fanId: event.fanId || null,
      extra: event.extra || null,
    });

    normalized.push({
      agencyId,
      deviceId: safeDeviceId,
      userId: member?.userId || userId || null,
      memberId: member?.id || null,
      accountId: cleanString(event.accountId || event.extra?.accountId, 160),
      creatorId: creator?.id || null,
      creatorRef: cleanString(event.creatorRef || creator?.username, 160),
      fanId: cleanString(event.fanId || event.extra?.fanId, 160),
      type,
      ts,
      localId,
      extra: event.extra && typeof event.extra === "object" ? event.extra : null,
      source: cleanString(event.source, 80) || "electron",
    });
  }

  let inserted = 0;
  let duplicated = 0;

  for (const row of normalized) {
    try {
      // Prisma unique index contains nullable deviceId, so Postgres can allow
      // duplicates when deviceId is null. Do a manual localId check too.
      if (row.localId) {
        const exists = await prisma.teamActivityEvent.findFirst({
          where: { agencyId: row.agencyId, localId: row.localId },
          select: { id: true },
        });
        if (exists) {
          duplicated += 1;
          try { await applyLedgerSideEffects({ ...row, id: exists.id }); } catch (ledgerErr) { console.error("[team-ledger] duplicate side effect failed:", ledgerErr?.message || ledgerErr); }
          continue;
        }
      }
      const created = await prisma.teamActivityEvent.create({ data: row });
      inserted += 1;
      try { await applyLedgerSideEffects({ ...row, id: created.id }); } catch (ledgerErr) { console.error("[team-ledger] side effect failed:", ledgerErr?.message || ledgerErr); }
    } catch (err) {
      if (err?.code === "P2002") duplicated += 1;
      else throw err;
    }
  }

  return { received: input.length, accepted: normalized.length, inserted, duplicated, skipped };
}

module.exports = { ingestTeamEvents };

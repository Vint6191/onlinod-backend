"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");

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

async function resolveCreator({ agencyId, event }) {
  const candidates = [];
  const accountId = cleanString(event.accountId, 160);
  const creatorRef = cleanString(event.creatorRef, 160);
  const remoteId = cleanString(event.remoteId || event.ofUserId || event.extra?.remoteId, 160);
  const username = cleanString(event.username || event.extra?.username, 160);

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
  const viewerId = cleanString(event.viewerId || event.memberId || event.userId, 160);
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

async function ingestTeamEvents({ agencyId, deviceId, userId, events = [] }) {
  const input = Array.isArray(events) ? events : [];
  const normalized = [];
  let skipped = 0;

  for (const event of input) {
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
      deviceId,
      ts: ts.getTime(),
      type,
      viewerId: event.viewerId || event.memberId || event.userId || null,
      accountId: event.accountId || null,
      fanId: event.fanId || null,
      extra: event.extra || null,
    });

    normalized.push({
      agencyId,
      deviceId: cleanString(deviceId, 160),
      userId: member?.userId || userId || null,
      memberId: member?.id || null,
      accountId: cleanString(event.accountId, 160),
      creatorId: creator?.id || null,
      creatorRef: cleanString(event.creatorRef || creator?.username, 160),
      fanId: cleanString(event.fanId, 160),
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
      await prisma.teamActivityEvent.create({ data: row });
      inserted += 1;
    } catch (err) {
      if (err?.code === "P2002") duplicated += 1;
      else throw err;
    }
  }

  return { received: input.length, accepted: normalized.length, inserted, duplicated, skipped };
}

module.exports = { ingestTeamEvents };

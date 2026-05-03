"use strict";

const prisma = require("../prisma");
const { resolveRange, rangeForClient } = require("./range-service");

const ALLOWED_SCOPES = new Set([
  "home",
  "team_overview",
  "team_members",
  "team_alerts",
  "team_flags",
]);

function cleanString(value, max = 120) {
  const s = String(value || "").trim();
  return s ? s.slice(0, max) : null;
}

function safeDate(value) {
  if (!value) return new Date();
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : new Date();
}

function normalizeScope(value) {
  const scope = cleanString(value, 80);
  if (!scope) return null;
  return scope.replace(/[^a-z0-9_:-]/gi, "_").toLowerCase();
}

function normalizeRange(value) {
  return resolveRange(value || "7d").key;
}

function withMeta(payload, meta) {
  const base = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : { value: payload };
  return {
    ...base,
    _meta: {
      ...(base._meta || {}),
      ...meta,
    },
  };
}

async function reportAnalyticsSnapshots({ agencyId, userId, deviceId = null, snapshots = [] }) {
  const input = Array.isArray(snapshots) ? snapshots : [];
  const saved = [];
  let skipped = 0;

  for (const item of input) {
    if (!item || typeof item !== "object") {
      skipped += 1;
      continue;
    }

    const scope = normalizeScope(item.scope);
    if (!scope || !ALLOWED_SCOPES.has(scope)) {
      skipped += 1;
      continue;
    }

    const rangeKey = normalizeRange(item.rangeKey || item.range || "7d");
    const capturedAt = safeDate(item.capturedAt || Date.now());
    const range = resolveRange(rangeKey);

    const payload = withMeta(item.payload || {}, {
      source: cleanString(item.source, 80) || "electron_snapshot",
      deviceId: cleanString(deviceId, 160),
      reportedByUserId: userId || null,
      reportedAt: new Date().toISOString(),
      capturedAt: capturedAt.toISOString(),
      range: rangeForClient(range),
      computeLocation: "electron",
    });

    const row = await prisma.analyticsSnapshot.upsert({
      where: {
        agencyId_scope_rangeKey: {
          agencyId,
          scope,
          rangeKey,
        },
      },
      create: {
        agencyId,
        scope,
        rangeKey,
        payload,
        capturedAt,
      },
      update: {
        payload,
        capturedAt,
      },
    });

    saved.push({ id: row.id, scope, rangeKey, capturedAt: row.capturedAt });
  }

  return { received: input.length, saved: saved.length, skipped, snapshots: saved };
}

async function getLatestSnapshot({ agencyId, scope, rangeKey = "7d" }) {
  const cleanScope = normalizeScope(scope);
  if (!cleanScope) return null;
  const key = normalizeRange(rangeKey);
  return prisma.analyticsSnapshot.findUnique({
    where: {
      agencyId_scope_rangeKey: {
        agencyId,
        scope: cleanScope,
        rangeKey: key,
      },
    },
  });
}

async function getLatestPayload({ agencyId, scope, rangeKey = "7d" }) {
  const row = await getLatestSnapshot({ agencyId, scope, rangeKey });
  if (!row) return null;
  return {
    id: row.id,
    scope: row.scope,
    rangeKey: row.rangeKey,
    payload: row.payload || {},
    capturedAt: row.capturedAt,
    staleSeconds: Math.max(0, Math.floor((Date.now() - new Date(row.capturedAt).getTime()) / 1000)),
  };
}

module.exports = {
  reportAnalyticsSnapshots,
  getLatestSnapshot,
  getLatestPayload,
  ALLOWED_SCOPES,
};

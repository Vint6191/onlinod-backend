"use strict";

const MONEY_FIELDS = new Set(["revenueCents", "totalRevenueCents", "averagePriceCents", "priceCents", "allocatedCents", "netCents", "grossCents", "knownNetCents"]);
function projectVaultMoney(value, allowed) {
  if (Array.isArray(value)) return value.map(item => projectVaultMoney(item, allowed));
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  const out = {};
  let monetary = false;
  for (const [key, item] of Object.entries(value)) {
    if (MONEY_FIELDS.has(key)) { out[key] = allowed ? item : null; monetary = true; }
    else out[key] = projectVaultMoney(item, allowed);
  }
  if (monetary) {
    out.revenueRestricted = !allowed;
    if (!allowed) {
      out.revenueAvailable = false; out.revenueComplete = false; out.revenuePending = false;
      if (Object.hasOwn(out, "rank")) out.rank = null;
    }
  }
  return out;
}

async function readMediaWithViewer({ db = require("../prisma"), userId, creatorId, member = null }, read) {
  return require("./analytics-viewer-read-service").readWithAnalyticsViewer({
    db, userId, creatorId, member, permission: null, projectionPermissions: ["money.view_earnings"],
  }, async ({ db: tx, creator, member: current }) => {
    const moneyAllowed = current.permissions?.["money.view_earnings"] === true;
    return projectVaultMoney(await read({ db: tx, creator, moneyAllowed }), moneyAllowed);
  });
}

module.exports = { projectVaultMoney, readMediaWithViewer };

"use strict";

const { lockDbAdvisoryXact, withDbAdvisoryXactLock } = require("./db-transaction-service");

const CAMPAIGN_TRANSACTION_LOCK_NAMESPACE = "analytics-collector:campaigns";

function campaignTransactionLockKey(creatorId) {
  const scoped = String(creatorId || "").trim();
  if (!scoped) {
    const error = new Error("Campaign transaction lock requires creatorId");
    error.code = "CAMPAIGN_TRANSACTION_LOCK_CREATOR_REQUIRED";
    throw error;
  }
  return `${CAMPAIGN_TRANSACTION_LOCK_NAMESPACE}:${scoped}`;
}

async function acquireCampaignTransactionLock(db, creatorId) {
  if (typeof db?.$executeRawUnsafe !== "function") return { key: campaignTransactionLockKey(creatorId), adapterFallback: true };
  const key = campaignTransactionLockKey(creatorId);
  await lockDbAdvisoryXact({ db, key });
  return { key, adapterFallback: false };
}

async function acquireCampaignTransactionLocks(db, creatorIds) {
  const keys = [...new Set((Array.isArray(creatorIds) ? creatorIds : [])
    .map((creatorId) => campaignTransactionLockKey(creatorId)))]
    .sort();
  if (!keys.length) return { keys: [], adapterFallback: true };
  if (typeof db?.$executeRawUnsafe !== "function") return { keys, adapterFallback: true };
  await db.$executeRawUnsafe(`
    WITH ordered_scope_keys AS MATERIALIZED (
      SELECT scope_key
      FROM unnest($1::text[]) AS candidate(scope_key)
      ORDER BY scope_key ASC
    )
    SELECT pg_advisory_xact_lock(hashtext(scope_key))
    FROM ordered_scope_keys
  `, keys);
  return { keys, adapterFallback: false };
}

async function withCampaignTransactionLock({ db, creatorId, work, options = undefined } = {}) {
  if (typeof work !== "function") throw new TypeError("Campaign transaction lock requires work callback");
  const key = campaignTransactionLockKey(creatorId);
  if (typeof db?.$executeRawUnsafe !== "function" && typeof db?.$transaction !== "function") return work(db);
  return withDbAdvisoryXactLock({ db, key, work, options });
}

module.exports = {
  CAMPAIGN_TRANSACTION_LOCK_NAMESPACE,
  campaignTransactionLockKey,
  acquireCampaignTransactionLock,
  acquireCampaignTransactionLocks,
  withCampaignTransactionLock,
};

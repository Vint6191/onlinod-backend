"use strict";

const { runDbTransaction } = require("./db-transaction-service");

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
  // The version fence is transaction-local and scoped to the same creator as
  // the lock. Old binaries cannot update retained refresh work after cutover.
  await db.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1)),
    set_config('onlinod.campaign_refresh_work_version','2',true),
    set_config('onlinod.campaign_refresh_creator',$2,true)`, key, String(creatorId).trim());
  return { key, adapterFallback: false };
}

async function withCampaignTransactionLock({ db, creatorId, work, options = undefined } = {}) {
  if (typeof work !== "function") throw new TypeError("Campaign transaction lock requires work callback");
  if (typeof db?.$executeRawUnsafe !== "function" && typeof db?.$transaction !== "function") return work(db);
  return runDbTransaction(db, async (tx) => {
    await acquireCampaignTransactionLock(tx, creatorId);
    return work(tx);
  }, options);
}

module.exports = {
  CAMPAIGN_TRANSACTION_LOCK_NAMESPACE,
  campaignTransactionLockKey,
  acquireCampaignTransactionLock,
  withCampaignTransactionLock,
};

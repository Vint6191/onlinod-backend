"use strict";
const { hashCanonicalJson } = require("./realtime-receipt-hash");
const { publishEntityChanges } = require("./creator-entity-change-service");
function versions(row) {
  return Object.fromEntries(Object.entries(row || {}).filter(([key]) => key.endsWith("AuthorityVersion")));
}
async function publishCanonicalFanChanges({ db, agencyId, creatorId, fanIds }) {
  const ids = [...new Set(fanIds || [])];
  if (!ids.length) return { staged: true, count: 0 };
  const fans = await db.creatorFan.findMany({ where: { agencyId, creatorId, onlyFansUserId: { in: ids } },
    include: { valueCurrent: true, relationshipCurrent: true }, take: ids.length });
  const demands = await db.creatorFanRefreshDemand.findMany({ where: { creatorId, onlyFansUserId: { in: ids } }, take: ids.length,
    select: { onlyFansUserId: true, status: true, requestedRevision: true, satisfiedRevision: true, retryAttempts: true,
      lastError: true, quarantinedAt: true, nextRetryAt: true } });
  const demandById = new Map(demands.map(row => [row.onlyFansUserId, row]));
  const changes = [];
  for (const fan of fans) {
    const dataVersion = hashCanonicalJson({ identity: versions(fan), value: versions(fan.valueCurrent), relationship: versions(fan.relationshipCurrent),
      demand: demandById.get(fan.onlyFansUserId) || null });
    for (const entityType of ["FAN", "CRM"]) changes.push({ entityType, entityId: fan.onlyFansUserId,
      sourceIdentity: `CreatorFan:${fan.id}`, sourceVersion: dataVersion,
      payload: { dataVersion, fanOnlyFansUserId: fan.onlyFansUserId, reason: "CANONICAL_FAN_CHANGED" } });
  }
  const dataVersion = hashCanonicalJson(changes.map(row => [row.entityId, row.sourceVersion]));
  for (const entityType of ["AUDIENCE", "TRAFFIC"]) changes.push({ entityType, entityId: creatorId,
    sourceIdentity: "CreatorFanCurrent", sourceVersion: dataVersion, payload: { dataVersion, reason: "CANONICAL_FANS_CHANGED" } });
  return publishEntityChanges({ db, agencyId, creatorId, changes });
}
async function publishCanonicalCampaignChanges({ db, agencyId, creatorId, campaignIds = [], externalCampaignIds = [] }) {
  const campaigns = await db.creatorCampaign.findMany({ where: { agencyId, creatorId,
    OR: [{ id: { in: campaignIds } }, { externalCampaignId: { in: externalCampaignIds } }] }, take: 50 });
  const changes = campaigns.map(row => {
    const dataVersion = hashCanonicalJson(JSON.parse(JSON.stringify(row, (_key, value) => typeof value === "bigint" ? value.toString() : value)));
    return { entityType: "CAMPAIGN", entityId: row.id, sourceIdentity: `CreatorCampaign:${row.id}`, sourceVersion: dataVersion,
      payload: { dataVersion, campaignId: row.id, reason: "CANONICAL_CAMPAIGN_CHANGED" } };
  });
  if (changes.length) {
    const dataVersion = hashCanonicalJson(changes.map(row => [row.entityId, row.sourceVersion]));
    changes.push({ entityType: "TRAFFIC", entityId: creatorId, sourceIdentity: "CreatorCampaign", sourceVersion: dataVersion,
      payload: { dataVersion, reason: "CAMPAIGN_MEMBERSHIP_CHANGED" } });
  }
  return publishEntityChanges({ db, agencyId, creatorId, changes });
}
module.exports = { publishCanonicalFanChanges, publishCanonicalCampaignChanges };

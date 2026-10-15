"use strict";

const { providerCategoryGuaranteedStartsPerHour, DEFAULT_CAMPAIGN_DIRECTORY_TARGET_MS } = require("./provider-capacity-sla-service");
const { CAMPAIGN_FAN_VALUE_FRESHNESS_MS } = require("./analytics-freshness-policy");

// Only trusted repository SELECTs are passed here. Aggregate the small creator
// buckets, never raw fan history on the maintenance publication/read path.
function creatorCapacitySummarySql(source) {
  const directoryLimit = Math.floor(providerCategoryGuaranteedStartsPerHour("campaign_directory") * DEFAULT_CAMPAIGN_DIRECTORY_TARGET_MS / 3600000);
  const fanLimit = Math.floor(providerCategoryGuaranteedStartsPerHour("fan_data") * CAMPAIGN_FAN_VALUE_FRESHNESS_MS / 3600000);
  return `SELECT COUNT(*)::bigint AS "capacityCreatorCount",
    COALESCE(SUM(GREATEST(c."directoryCalls"-${directoryLimit},0)),0)::bigint AS "creatorDirectoryDebtCalls",
    COALESCE(SUM(GREATEST(c."fanCalls"-${fanLimit},0)),0)::bigint AS "creatorFanDebtCalls",
    COALESCE(MAX(c."directoryCalls"),0)::bigint AS "creatorMaxDirectoryCalls",
    COALESCE(MAX(c."fanCalls"),0)::bigint AS "creatorMaxFanCalls",
    COALESCE(MAX(c."directoryCalls"+c."fanCalls"),0)::bigint AS "creatorMaxRequiredCalls"
    FROM (${source}) c`;
}

const PROJECTED_CREATOR_DEMANDS_SQL = `SELECT "creatorId",
  COALESCE(SUM("requiredCalls") FILTER (WHERE bucket='directory'),0)::bigint AS "directoryCalls",
  COALESCE(SUM("itemCount") FILTER (WHERE bucket='fan'),0)::bigint AS "fanCalls"
  FROM "ProviderCapacityCreatorBucket" GROUP BY "creatorId" HAVING SUM("itemCount")>0`;

const USAGE_KEYS = ["Total", "CriticalWrite", "Interactive", "Realtime", "Normal", "CampaignDirectory", "CampaignFrontier", "FanData", "BackgroundOther", "Unclassified"];
const CREATOR_USAGE_SQL = `SELECT MIN("usageWindowStartedAt") AS "usageWindowStartedAt",
  ${USAGE_KEYS.map(key => `COALESCE(SUM("usage${key}Starts"),0)::bigint AS "usage${key}Starts"`).join(",")}
  FROM "OfProviderRequestGateState" WHERE "scopeCreatorId" IS NOT NULL
    AND "usageWindowStartedAt">=$1::timestamp-interval '1 hour'`;

function creatorCapacityFromRow(row) {
  if (row?.capacityCreatorCount == null) return null;
  return { creatorCount: Number(row.capacityCreatorCount),
    directoryDebtCalls: row.creatorDirectoryDebtCalls, fanDebtCalls: row.creatorFanDebtCalls,
    maxDirectoryCalls: row.creatorMaxDirectoryCalls, maxFanCalls: row.creatorMaxFanCalls,
    maxRequiredCalls: row.creatorMaxRequiredCalls };
}

module.exports = { creatorCapacitySummarySql, PROJECTED_CREATOR_DEMANDS_SQL, CREATOR_USAGE_SQL, creatorCapacityFromRow };

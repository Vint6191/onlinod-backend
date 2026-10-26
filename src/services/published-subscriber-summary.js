"use strict";

const { scopeSql, scopeParams } = require("./home-scope-repository");

// Count metadata is committed with the published head. Do not COUNT subscriber
// rows or expose the partially built next generation while it is scanning.
function subscriberHeadJoins() {
  return `LEFT JOIN "SubscriberDirectoryState" sd ON sd."creatorId"=c.id AND sd."agencyId"=c."agencyId"
    LEFT JOIN "SubscriberScanRun" sr ON sr.id=sd."currentRunId" AND sr."creatorId"=c.id AND sr."agencyId"=c."agencyId"
      AND sr."publicationGeneration"=sd."publishedGeneration" AND sd."publishedGeneration">0
      AND sr.status='PUBLISHED' AND sr."publicationStatus"='COMPLETE' AND sr."sourceType"='all'
      AND sr."hasMore"=false AND sr."fanProjectionStatus"='COMPLETE'
      AND sr."fanProjectionCursorOffset">=sr."nextOffset" AND sr."fanProjectionCount">=sr."scannedCount"
      AND sd."totalCount"=sr."scannedCount" AND sd."totalCount">=0
      AND sd."publishedAt"=sr."publishedAt" AND sd."publishedAt" IS NOT NULL`;
}
function subscriberStaleSql(now) {
  return `(sd.status<>'READY' OR sd."publicationGeneration">sd."publishedGeneration"
    OR sd."publishedAt">(${now}::timestamptz AT TIME ZONE 'UTC')+interval '5 minutes'
    OR COALESCE(sd."nextScanAt",sd."publishedAt"+sd."scanEveryDays"*interval '1 day')<=(${now}::timestamptz AT TIME ZONE 'UTC'))`;
}
function subscriberHeadColumns(now = "$11") {
  return `CASE WHEN sr.id IS NOT NULL THEN sd."totalCount" ELSE NULL END AS subscriber_count,
    CASE WHEN sr.id IS NOT NULL THEN sd."publishedAt" ELSE NULL END AS subscribers_updated_at,
    CASE WHEN sr.id IS NOT NULL THEN ${subscriberStaleSql(now)} ELSE true END AS subscribers_stale`;
}
function count(value) {
  if (value == null) return null;
  const n=Number(value);if(!Number.isSafeInteger(n)||n<0)throw Error("SUBSCRIBER_SUMMARY_COUNT_INVALID");return n;
}
function iso(value) { return value ? new Date(value).toISOString() : null; }
function audienceFromRow(row) {
  return {subscriberCount:count(row?.subscriber_count),publishedAt:iso(row?.subscribers_updated_at),stale:row?.subscribers_stale!==false};
}
async function readCreatorAudience({ db, creatorId, now }) {
  const [row]=await db.$queryRawUnsafe(`SELECT ${subscriberHeadColumns("$2")} FROM "CreatorAccount" c
    ${subscriberHeadJoins()} WHERE c.id=$1 AND c."deletedAt" IS NULL`,creatorId,now);
  return audienceFromRow(row);
}
async function readHomeAudience(input) {
  if (!input.money) return {available:false,totalSubscribers:null,coverage:{totalCreators:0,reportingCreators:0,staleCreators:0},oldestPublishedAt:null};
  const [row]=await input.db.$queryRawUnsafe(`${scopeSql()} SELECT COUNT(*) AS total,
    COUNT(sr.id) AS reporting,COUNT(*) FILTER(WHERE sr.id IS NOT NULL AND ${subscriberStaleSql("$6")}) AS stale,
    SUM(sd."totalCount") FILTER(WHERE sr.id IS NOT NULL) AS subscribers,
    MIN(sd."publishedAt") FILTER(WHERE sr.id IS NOT NULL) AS oldest FROM visible c ${subscriberHeadJoins()}`,...scopeParams(input),input.now);
  const total=count(row?.total)||0,reporting=count(row?.reporting)||0,complete=total===reporting;
  return {available:true,totalSubscribers:complete?count(row?.subscribers)||0:null,
    coverage:{totalCreators:total,reportingCreators:reporting,staleCreators:count(row?.stale)||0},
    oldestPublishedAt:complete?iso(row?.oldest):null};
}

module.exports={subscriberHeadJoins,subscriberHeadColumns,readCreatorAudience,readHomeAudience,audienceFromRow};

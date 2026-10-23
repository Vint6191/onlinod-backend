"use strict";
const { valueFieldState } = require("./fan-value-field-authority");
const { readCampaignRefreshDebt } = require("./campaign-refresh-debt-service");

const { dbAuthorityNow } = require("./db-time-authority-service");
const { displayRangeBounds } = require("./analytics-range-contract");
const { CAMPAIGN_FAN_VALUE_FRESHNESS_MS, FINANCIAL_COLLECTION_FRESHNESS_MS, trustedCollectionTimestamp } = require("./analytics-freshness-policy");
const { CAMPAIGN_COVERAGE_SELECT, evaluateCampaignCollectionState, coverageDto } = require("./campaign-freshness-service");
const { stateVocabulary } = require("./analytics-state-evaluator");
const financialAuthority = require("./financial-receipt-authority");
const { campaignRevenueCoverage } = require("./campaign-revenue-coverage");
const { RANGES, CLASSES } = require("./campaign-read-projection-service");
const VERSION = 1;
const fault = (code,status=400) => Object.assign(new Error(code),{code,status});
function safeInteger(value) {
  if (value == null) return null;
  const exact=BigInt(value),number=Number(exact);
  if (!Number.isSafeInteger(number)) throw fault("CAMPAIGN_AMOUNT_OUT_OF_SAFE_RANGE",422);
  return number;
}
const n=(m,k)=>safeInteger(m?.[k]??0);
function metricsDto(m={},ready=true,revenueReady=ready) {
  const moneyReady=ready && revenueReady && n(m,"unknownAttributionFans")===0 && n(m,"unverifiedTransactions")===0;
  const amount=(known,unknown)=>moneyReady && n(m,unknown)===0?n(m,known):null;
  return {
    campaigns:n(m,"campaigns"),activeCampaigns:n(m,"activeCampaigns"),memberships:n(m,"memberships"),
    fans:n(m,"memberships"),fansCount:n(m,"memberships"),uniqueFans:n(m,"uniqueFans"),newFans:n(m,"newFans"),
    payingFans:moneyReady?n(m,"payingFans"):null,unknownAttributionFans:n(m,"unknownAttributionFans"),
    grossCents:amount("grossCents","unknownGrossTransactions"),unknownGrossTransactions:n(m,"unknownGrossTransactions"),knownNetCents:ready?n(m,"knownNetCents"):null,
    unknownNetTransactions:n(m,"unknownNetTransactions"),unverifiedTransactions:n(m,"unverifiedTransactions"),netCents:amount("knownNetCents","unknownNetTransactions"),
    transactionsCount:n(m,"transactionsCount"),transactions:n(m,"transactionsCount"),
    settledGrossCents:amount("settledGrossCents","settledUnknownGrossTransactions"),settledNetCents:amount("settledKnownNetCents","settledUnknownNetTransactions"),
    settledTransactionsCount:n(m,"settledTransactionsCount"),pendingGrossCents:amount("pendingGrossCents","pendingUnknownGrossTransactions"),
    pendingNetCents:amount("pendingKnownNetCents","pendingUnknownNetTransactions"),pendingTransactionsCount:n(m,"pendingTransactionsCount"),
    salesRevenueCents:amount("salesKnownNetCents","salesUnknownNetTransactions"),tipsRevenueCents:amount("tipsKnownNetCents","tipsUnknownNetTransactions"),
    subscriptionRevenueCents:amount("subscriptionKnownNetCents","subscriptionUnknownNetTransactions"),
    ofValueKnownFans:n(m,"ofValueKnownFans"),ofValueUnknownFans:n(m,"ofValueUnknownFans"),ofValuePayingFans:n(m,"ofValuePayingFans"),
    ofValueFreshFans:ready?n(m,"ofValueFreshFans"):null,ofValueStaleFans:ready?n(m,"ofValueStaleFans"):null,
    knownPlatformReportedFanSpendCents:ready?n(m,"knownPlatformReportedFanSpendCents"):null,
    platformReportedFanSpendCents:ready && n(m,"ofValueUnknownFans")===0?n(m,"knownPlatformReportedFanSpendCents"):null,
  };
}
function combineMetrics(rows,key) {
  const result=new Map();
  for (const row of rows) {
    const metrics=result.get(row[key])||{};
    for (const [name,value] of Object.entries(row.metrics||{})) metrics[name]=String(BigInt(metrics[name]||0)+BigInt(value));
    result.set(row[key],metrics);
  }
  return result;
}
function rangeKey(value) {
  const key=String(value||"all");
  if(!RANGES.includes(key))throw fault("CAMPAIGN_RANGE_UNSUPPORTED");
  return key;
}
function decodeCursor(value,scope) {
  if(!value)return "";
  if(typeof value!=="string"||value.length>4096)throw fault("CAMPAIGN_CURSOR_INVALID");
  let parsed;
  try{parsed=JSON.parse(Buffer.from(value,"base64url").toString("utf8"));}catch{throw fault("CAMPAIGN_CURSOR_INVALID");}
  if(!Array.isArray(parsed)||parsed.length!==scope.length+1||scope.some((v,i)=>v!==parsed[i])||typeof parsed.at(-1)!=="string"||!parsed.at(-1)||parsed.at(-1).length>240)throw fault("CAMPAIGN_CURSOR_SCOPE_MISMATCH");
  return parsed.at(-1);
}
const encodeCursor=(scope,id)=>Buffer.from(JSON.stringify([...scope,id])).toString("base64url");
const pageSize=value=>Math.max(1,Math.min(100,Math.floor(Number(value)||50)));
async function readiness(db,creatorId,now) {
  const [row]=await db.$queryRawUnsafe(`SELECT s."completedAt",s."generation",p."generation" AS "activeGeneration",p."valueFreshnessMs",
    COALESCE(m."metrics"->>'ofValueStaleFans','0') AS "staleFans",
    NOT EXISTS(SELECT 1 FROM "CreatorCampaign" c WHERE c."creatorId"=$1) AS empty,
    EXISTS(SELECT 1 FROM "DomainWorkItem" w WHERE w."creatorId"=$1 AND w."isOutstanding" AND w."workClass"=ANY($2::text[])
      AND w."workClass"<>'CAMPAIGN_CLOCK') AS pending,
    EXISTS(SELECT 1 FROM "CampaignReadReceipt" r WHERE r."creatorId"=$1 AND r."nextDueAt"<="phase3_utc_timestamp"($3::timestamptz)) AS expired,
    (SELECT r."nextDueAt" FROM "CampaignReadReceipt" r WHERE r."creatorId"=$1 AND r."nextDueAt" IS NOT NULL ORDER BY r."nextDueAt","kind","sourceId" LIMIT 1) AS "nextChangeAt"
    FROM "CampaignProjectionPolicy" p LEFT JOIN "CampaignReadStateData" s ON s."creatorId"=$1
    LEFT JOIN "CampaignReadMetric" m ON m."creatorId"=$1 AND m."campaignId"='' AND m."rangeKey"='current' AND m."fanId"=''
    WHERE p."id"='active'`,creatorId,CLASSES,now);
  if(!row)throw fault("CAMPAIGN_PROJECTION_POLICY_MISSING",503);
  const current=row.generation===row.activeGeneration;
  const ready=Boolean(row.empty || (current&&row.completedAt&&!row.pending&&!row.expired));
  return {ready,empty:row.empty,generation:row.activeGeneration,state:ready?"READY":!current||!row.completedAt?"REBUILDING":"PENDING",asOf:now.toISOString(),
    fanValueStatus:!ready?"PENDING":!row.empty&&BigInt(row.staleFans||0)>0n?"STALE":"FRESH",
    valueFreshnessMs:row.valueFreshnessMs,nextChangeAt:!row.empty&&current?row.nextChangeAt?.toISOString()||null:null};
}
async function sourceCoverage(db,creatorId,now,key) {
  const [storedFinancial,campaigns,refreshDebt,liveCoverage]=await Promise.all([
    // Creator Demand survives current coverage generation changes.

    db.creatorFinancialCollectionState.findUnique({where:{creatorId},select:{status:true,baselineVerifiedAt:true,lastCatchupCompletedAt:true,baselineObservedAt:true,lastCatchupObservedAt:true,retryAfterAt:true,
      baselineRangeFrom:true,baselineRangeTo:true,receiptCoverageVersion:true,coverageThrough:true,recentRangeFrom:true,recentRangeTo:true,
      historyAuditCursor:true,historyAuditObservedAt:true}}),
    db.creatorCampaignCollectionState.findUnique({where:{creatorId},select:CAMPAIGN_COVERAGE_SELECT}),
    readCampaignRefreshDebt({db,creatorId}),
    require("./earnings-live-read-sql").readLiveEarningsCoverage(db,creatorId,now),
  ]);
  const financial=storedFinancial ? {...storedFinancial,liveCoverage} : null;
  // Provider coverage evidence is separate from processing all locally known
  // facts. READY never fabricates a completed provider scan.
  const financialState=financialAuthority.evaluateCollection(financial,now,FINANCIAL_COLLECTION_FRESHNESS_MS);
  const financialFresh=financialState.proven && (liveCoverage ? liveCoverage.fresh : financialState.fresh);
  const campaignState=evaluateCampaignCollectionState(campaigns,now,refreshDebt);
  return {financial:financial?{...coverageDto(financial),status:stateVocabulary({...financialState,fresh:financialFresh,stale:financialState.proven&&!financialFresh}),proven:financialState.proven,fresh:financialFresh,
    coverage:financialAuthority.coverageView(financial,now)}:null,
    revenue:campaignRevenueCoverage(financial,campaignState,displayRangeBounds(key,now),now),campaigns:campaigns?{
    ...coverageDto(campaigns),status:stateVocabulary(campaignState),proven:campaignState.proven,fresh:campaignState.fresh,
    providerFresh:campaignState.providerFresh,refreshDebt,
    due:campaignState.due,freshnessAuthority:campaignState.freshnessAuthority,
    fanValueCoverageAuthority:"TRAVERSAL_RECEIPT",
    directoryDue:campaignState.directoryDue,frontierDue:campaignState.frontierDue,fanRefreshPending:campaignState.fanRefreshPending,
  }:null};
}
async function readCampaignPage({db,creatorId,rangeKey:key="all",cursor=null,limit=50,now=null,offset=0}) {
  if(Number(offset)!==0)throw fault("CAMPAIGN_CURSOR_REQUIRED");
  now=now||await dbAuthorityNow({db});key=rangeKey(key);
  const scope=[VERSION,"directory",creatorId,key],after=decodeCursor(cursor,scope),take=pageSize(limit);
  const [projection,coverage,rows]=await Promise.all([readiness(db,creatorId,now),sourceCoverage(db,creatorId,now,key),
    db.creatorCampaign.findMany({where:{creatorId,id:{gt:after}},orderBy:{id:"asc"},take:take+1,
      select:{id:true,externalCampaignId:true,name:true,isActive:true,startedAt:true,endedAt:true,collectedAt:true,campaignType:true,trackingCode:true,trackingUrl:true,claimersCount:true,clicksCount:true}})]);
  const page=rows.slice(0,take),ids=["",...page.map(r=>r.id)];
  const metrics=projection.empty?[]:await db.$queryRawUnsafe('SELECT "campaignId","metrics" FROM "CampaignReadMetric" WHERE "creatorId"=$1 AND "rangeKey" IN ($2,\'current\') AND "fanId"=\'\' AND "campaignId"=ANY($3::text[])',creatorId,key,ids);
  const byId=combineMetrics(metrics,"campaignId");
  coverage.fanValues = {
    authority:"CANONICAL_VALUE_TTL",scope:"CURRENT_CAMPAIGN_MEMBERS",freshnessMs:projection.valueFreshnessMs,
    status:!projection.ready?"PENDING":n(byId.get(""),"ofValueStaleFans")>0?"STALE":n(byId.get(""),"ofValueUnknownFans")>0?"PARTIAL":"FRESH",
    fresh:projection.ready&&n(byId.get(""),"ofValueStaleFans")===0&&n(byId.get(""),"ofValueUnknownFans")===0,
    knownFans:projection.ready?n(byId.get(""),"ofValueKnownFans"):null,
    unknownFans:projection.ready?n(byId.get(""),"ofValueUnknownFans"):null,
    freshFans:projection.ready?n(byId.get(""),"ofValueFreshFans"):null,
    staleFans:projection.ready?n(byId.get(""),"ofValueStaleFans"):null,
  };
  const bounds=displayRangeBounds(key,now);
  return {ok:true,contractVersion:VERSION,creatorId,range:{key,startAt:bounds.startAt.toISOString(),endAt:bounds.endAt.toISOString()},
    projection,sourceCoverage:coverage,totals:projection.ready?metricsDto(byId.get(""),true,coverage.revenue.ready):null,
    rows:page.map(row=>({...row,...metricsDto(byId.get(row.id),projection.ready,coverage.revenue.ready)})),
    pagination:{limit:take,returned:page.length,hasMore:rows.length>take,nextCursor:rows.length>take?encodeCursor(scope,page.at(-1).id):null,order:"IMMUTABLE_ID",semantics:"LIVE_PAGES"}};
}
function fanValueDto(value,now,freshnessMs=CAMPAIGN_FAN_VALUE_FRESHNESS_MS) {
  if(!value)return null;
  const observed=trustedCollectionTimestamp(value.valueObservedAt,now);
  const state=valueFieldState(value,now,freshnessMs),available=state.available;
  const money=field=>(field==="platformReportedTotalSpendCents"?available:state.fields[field].fresh)?safeInteger(value[field]):null;
  return {available,availability:value.availability,
    platformReportedTotalSpendCents:money("platformReportedTotalSpendCents"),messagesSpentCents:money("messagesSpentCents"),
    subscriptionsSpentCents:money("subscriptionsSpentCents"),tipsSpentCents:money("tipsSpentCents"),postsSpentCents:money("postsSpentCents"),streamsSpentCents:money("streamsSpentCents"),
    observedAt:value.valueObservedAt.toISOString(),expiresAt:observed?new Date(+observed+freshnessMs).toISOString():null,
    lastActivityAt:value.lastActivityAt?.toISOString()||null,source:value.source,fieldAuthority:state.authority,fieldFreshness:state.fields};
}
async function readCampaignFanPage({db,creatorId,campaignId,rangeKey:key="all",filter="ALL",cursor=null,limit=50,offset=0,now=null}) {
  if(Number(offset)!==0)throw fault("CAMPAIGN_CURSOR_REQUIRED");
  now=now||await dbAuthorityNow({db});key=rangeKey(key);
  if(!["ALL","PAYING"].includes(filter))throw fault("CAMPAIGN_FAN_FILTER_INVALID");
  const scope=[VERSION,"fans",creatorId,campaignId,key,filter],after=decodeCursor(cursor,scope),take=pageSize(limit);
  const [campaign,projection,coverage]=await Promise.all([
    db.creatorCampaign.findFirst({where:{id:campaignId,creatorId},select:{id:true,name:true,externalCampaignId:true,isActive:true}}),readiness(db,creatorId,now),sourceCoverage(db,creatorId,now,key)]);
  if(!campaign)return null;
  // PAYING means ledger transactions in this range, never current FanData spend.
  // Materialize the bounded payer page BEFORE looking up memberships. A plain
  // ordered JOIN can become a merge join that walks every non-paying member
  // between sparse payers even when the payer side uses its partial index.
  const ids=filter==="PAYING"&&!projection.ready?[]:await db.$queryRawUnsafe(filter==="PAYING"?`
    WITH payers AS MATERIALIZED (
      SELECT p."fanId" FROM "CampaignReadMetric" p
      WHERE p."creatorId"=$1 AND p."campaignId"=$2 AND p."rangeKey"=$3 AND p."paying"=true AND p."fanId">$4
      ORDER BY p."fanId" LIMIT $5
    ) SELECT m."id",m."fanId" FROM payers p JOIN LATERAL (
      SELECT m."id",m."fanId" FROM "CreatorCampaignFan" m
      WHERE m."creatorId"=$1 AND m."campaignId"=$2 AND m."fanId"=p."fanId" LIMIT 1
    ) m ON true ORDER BY p."fanId"
    `:`SELECT m."id",m."fanId" FROM "CreatorCampaignFan" m WHERE m."creatorId"=$1 AND m."campaignId"=$2
      AND $3::text IS NOT NULL AND m."fanId">$4 ORDER BY m."fanId" LIMIT $5`,creatorId,campaignId,key,after,take+1);
  const pageIds=ids.slice(0,take);
  const rows=pageIds.length?await db.creatorCampaignFan.findMany({where:{creatorId,campaignId,id:{in:pageIds.map(x=>x.id)}},include:{fan:{include:{valueCurrent:true}}}}):[];
  const metrics=pageIds.length?await db.$queryRawUnsafe('SELECT "fanId","metrics" FROM "CampaignReadMetric" WHERE "creatorId"=$1 AND "campaignId"=$2 AND "rangeKey" IN ($3,\'current\') AND "fanId"=ANY($4::text[])',creatorId,campaignId,key,pageIds.map(x=>x.fanId)):[];
  const demands=rows.length&&db.creatorFanRefreshDemand?.findMany?await db.creatorFanRefreshDemand.findMany({
    where:{creatorId,onlyFansUserId:{in:rows.map(row=>row.fan.onlyFansUserId)}},take:take,
    select:{onlyFansUserId:true,status:true,lastError:true,retryAttempts:true,nextRetryAt:true,activeRefreshJob:{select:{status:true}}}}):[];
  const demandByFan=new Map(demands.map(row=>[row.onlyFansUserId,row]));
  const byId=new Map(rows.map(r=>[r.id,r])),byFan=combineMetrics(metrics,"fanId");
  return {ok:true,contractVersion:VERSION,creatorId,campaign,rangeKey:key,filter,projection,sourceCoverage:coverage,
    fans:pageIds.flatMap(({id})=>{
      const row=byId.get(id);if(!row)return [];
      const fan=row.fan,demand=demandByFan.get(fan.onlyFansUserId),value=fanValueDto(fan.valueCurrent,now,projection.valueFreshnessMs);
      const fanDataStatus=demand?.status==="QUEUED"?(demand.activeRefreshJob?.status==="CLAIMED"?"RUNNING":"PENDING")
        :demand?.status==="FAILED"?"FAILED":value?.availability==="UNAVAILABLE"&&value.expiresAt&&+new Date(value.expiresAt)>+now?"UNAVAILABLE":value?.available?"AVAILABLE":"STALE";
      return [{id:row.id,externalClaimerId:row.externalClaimerId,attributedAt:row.attributedAt?.toISOString()||null,collectedAt:row.collectedAt.toISOString(),
        fan:{id:fan.id,onlyFansUserId:fan.onlyFansUserId,username:fan.username,displayName:fan.displayName,firstSeenAt:fan.firstSeenAt.toISOString(),lastSeenAt:fan.lastSeenAt.toISOString()},
        fanDataStatus,fanDataError:fanDataStatus==="FAILED"?demand.lastError:null,fanDataRetryAttempts:demand?.retryAttempts||0,
        fanValue:value,revenue:metricsDto(byFan.get(row.fanRecordId),projection.ready,coverage.revenue.ready && row.attributedAt!=null)}];
    }),pagination:{limit:take,returned:pageIds.length,hasMore:ids.length>take,nextCursor:ids.length>take?encodeCursor(scope,pageIds.at(-1).fanId):null,order:"IMMUTABLE_FAN_ID",semantics:"LIVE_PAGES"}};
}
module.exports={VERSION,safeInteger,metricsDto,rangeKey,decodeCursor,encodeCursor,readiness,fanValueDto,readCampaignPage,readCampaignFanPage};

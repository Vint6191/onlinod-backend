"use strict";

const { runRootCommit } = require("./db-commit-kernel");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { lockAgencyLifecycleBarrier } = require("./agency-lifecycle-barrier-service");
const { claimDomainWorkBatch, lockDomainWorkClaimForCommit, ackDomainWorkClaim,
  yieldDomainWorkClaim, failDomainWorkClaim, publishDomainWork } = require("./domain-work-authority-service");
const { CAMPAIGN_FAN_VALUE_FRESHNESS_MS, COLLECTION_FUTURE_SKEW_TOLERANCE_MS } = require("./analytics-freshness-policy");
const { utcDay, DAY_MS } = require("./analytics-range-contract");

const PAGE = 100;
const RANGES = Object.freeze(["7d", "30d", "90d", "180d", "365d", "all"]);
const CLASSES = Object.freeze(["CAMPAIGN_FACT", "CAMPAIGN_VALUE", "CAMPAIGN_ATTRIBUTION", "CAMPAIGN_CLOCK", "CAMPAIGN_BACKFILL"]);
const SOURCES = Object.freeze({ DIRECTORY: "CreatorCampaign", MEMBER: "CreatorCampaignFan", FINANCIAL: "CreatorFinancialTransaction" });
const fault = code => Object.assign(new Error(code), { code, status: 409 });
const textMetrics = obj => Object.fromEntries(Object.entries(obj).map(([k,v]) => [k, String(v)]));

function windowMembership(at, now) {
  if (!at) return { ranges: [], due: null };
  at = new Date(at);
  if (+at > +now) return { ranges: [], due: at };
  const today = +utcDay(now), day = +utcDay(at);
  const ranges = ["all"], future = [];
  for (const key of RANGES.slice(0,-1)) {
    const expires = day + Number(key.slice(0,-1)) * DAY_MS;
    if (expires > today) { ranges.push(key); future.push(expires); }
  }
  return { ranges, due: future.length ? new Date(Math.min(...future)) : null };
}
function valueMetrics(value, now) {
  const observed = value?.fetchedAt ? new Date(value.fetchedAt) : null;
  const trusted = observed && +observed <= +now + COLLECTION_FUTURE_SKEW_TOLERANCE_MS;
  const expires = observed ? new Date(+observed + CAMPAIGN_FAN_VALUE_FRESHNESS_MS) : null;
  const available = Boolean(trusted && +expires > +now && value.availability === "AVAILABLE");
  const known = available && value.totalNetCents != null;
  return {
    metrics: textMetrics({ ofValueKnownFans: known ? 1 : 0, ofValueUnknownFans: known ? 0 : 1,
      ofValuePayingFans: known && BigInt(value.totalNetCents) > 0n ? 1 : 0,
      knownPlatformReportedFanSpendCents: known ? value.totalNetCents : 0 }),
    due: observed && !trusted ? new Date(+observed - COLLECTION_FUTURE_SKEW_TOLERANCE_MS)
      : available ? expires : null,
  };
}
function financialMetrics(row) {
  if (!row || String(row.transactionStatus || "").toLowerCase() === "undo") return {};
  const net = row.netCents, settled = String(row.transactionStatus || "").toLowerCase() === "done";
  const type = String(row.transactionType || "").toLowerCase();
  const category = type.startsWith("subscription") ? "subscription" : ["message","chat_message","chat_messages"].includes(type) ? "sales" : ["tip","tips"].includes(type) ? "tips" : null;
  const out = { grossCents: row.amountCents, knownNetCents: net ?? 0, unknownNetTransactions: net == null ? 1 : 0, transactionsCount: 1 };
  const prefix = settled ? "settled" : "pending";
  Object.assign(out, { [prefix+"GrossCents"]: row.amountCents, [prefix+"KnownNetCents"]: net ?? 0,
    [prefix+"UnknownNetTransactions"]: net == null ? 1 : 0, [prefix+"TransactionsCount"]: 1 });
  if (category) Object.assign(out, { [category+"KnownNetCents"]: net ?? 0, [category+"UnknownNetTransactions"]: net == null ? 1 : 0 });
  return textMetrics(out);
}
function deltas(previous, next) {
  const map = new Map();
  for (const [list, sign] of [[previous,-1n],[next,1n]]) for (const row of list || []) {
    const key = JSON.stringify([row.campaignId,row.rangeKey,row.fanId]);
    const out = map.get(key) || { campaignId: row.campaignId, rangeKey: row.rangeKey, fanId: row.fanId, metrics: {} };
    for (const [k,v] of Object.entries(row.metrics)) out.metrics[k] = String(BigInt(out.metrics[k] || 0) + sign * BigInt(v));
    map.set(key,out);
  }
  return [...map.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([,v]) => v).filter(r => Object.values(r.metrics).some(v => v !== "0"));
}
async function replaceReceipt(tx, item, kind, sourceId, contributions, nextDueAt) {
  const [before] = await tx.$queryRawUnsafe('SELECT "contributions" FROM "CampaignReadReceipt" WHERE "creatorId"=$1 AND "kind"=$2 AND "sourceId"=$3', item.creatorId,kind,sourceId);
  const delta = deltas(before?.contributions || [],contributions);
  if (delta.length) await tx.$executeRawUnsafe(`SELECT "onlinod_campaign_read_add_v1"($1,$2,x."campaignId",x."rangeKey",x."fanId",x.metrics)
    FROM jsonb_to_recordset($3::jsonb) x("campaignId" text,"rangeKey" text,"fanId" text,metrics jsonb)`,item.agencyId,item.creatorId,JSON.stringify(delta));
  if (!contributions.length && !nextDueAt) {
    await tx.$executeRawUnsafe('DELETE FROM "CampaignReadReceipt" WHERE "creatorId"=$1 AND "kind"=$2 AND "sourceId"=$3',item.creatorId,kind,sourceId);
  } else await tx.$executeRawUnsafe(`INSERT INTO "CampaignReadReceipt"("agencyId","creatorId","kind","sourceId","contributions","nextDueAt") VALUES($1,$2,$3,$4,$5::jsonb,$6)
    ON CONFLICT("creatorId","kind","sourceId") DO UPDATE SET "contributions"=EXCLUDED."contributions","nextDueAt"=EXCLUDED."nextDueAt","updatedAt"=CURRENT_TIMESTAMP`,
  item.agencyId,item.creatorId,kind,sourceId,JSON.stringify(contributions),nextDueAt);
}
async function projectSource(tx, item, kind, id, now) {
  let row;
  if (kind === "VALUE") {
    const [member] = await tx.$queryRawUnsafe('SELECT "id" FROM "CreatorCampaignFan" WHERE "creatorId"=$1 AND "agencyId"=$2 AND "fanId"=$3 LIMIT 1',item.creatorId,item.agencyId,id);
    if (member) row = { fanId:id };
  } else {
    if (!SOURCES[kind]) throw fault("CAMPAIGN_READ_SOURCE_INVALID");
    [row] = await tx.$queryRawUnsafe(`SELECT * FROM "${SOURCES[kind]}" WHERE "creatorId"=$1 AND "agencyId"=$2 AND "id"=$3`,item.creatorId,item.agencyId,id);
  }
  const entries = [], due = [];
  const add = (campaignId,rangeKey,fanId,metrics) => entries.push({campaignId,rangeKey,fanId,metrics:textMetrics(metrics)});
  const schedule = date => { if (date && +date > +now) due.push(+date); };
  if (row && kind === "DIRECTORY") {
    for (const p of ["",row.id]) add(p,"current","",{campaigns:1,activeCampaigns:row.isActive?1:0});
  }
  if (row && (kind === "MEMBER" || kind === "VALUE")) {
    const [value] = await tx.$queryRawUnsafe('SELECT "availability","totalNetCents","fetchedAt" FROM "CreatorFanValueCurrent" WHERE "creatorId"=$1 AND "agencyId"=$2 AND "fanId"=$3',item.creatorId,item.agencyId,row.fanId);
    const current = valueMetrics(value,now); schedule(current.due);
    const membership = windowMembership(row.attributedAt,now);
    if (kind === "MEMBER") schedule(membership.due);
    // Current directory/value/membership facts exist once, independent of the
    // financial window. Only payer references and arrivals need window state.
    if (kind === "MEMBER") {
      for (const p of ["",row.campaignId]) {
        add(p,"current",row.fanId,{memberships:1,unknownAttributionFans:row.attributedAt==null?1:0});
        for (const w of membership.ranges) add(p,w,"",{newFans:1});
      }
      add(row.campaignId,"current","",current.metrics);
    } else add("","current","",current.metrics);
  }
  if (row && kind === "FINANCIAL") {
    const window = windowMembership(row.occurredAt,now); schedule(window.due);
    const [attribution] = row.fanId ? await tx.$queryRawUnsafe(`SELECT "campaignId" FROM "CreatorCampaignFan"
      WHERE "creatorId"=$1 AND "agencyId"=$2 AND "fanId"=$3 AND "attributedAt"<=$4
      ORDER BY "attributedAt" DESC,"id" DESC LIMIT 1`,item.creatorId,item.agencyId,row.fanId,row.occurredAt) : [];
    const money = financialMetrics(row);
    if (attribution && Object.keys(money).length) for (const w of window.ranges) for (const p of ["",attribution.campaignId]) add(p,w,row.fanId,money);
    // Unattributed facts are found by the membership interval repair later.
    if (!attribution || !Object.keys(money).length) due.length=0;
  }
  await replaceReceipt(tx,item,kind,id,entries,due.length?new Date(Math.min(...due)):null);
}
async function nextClock(tx, creatorId) {
  const [row] = await tx.$queryRawUnsafe('SELECT "nextDueAt" FROM "CampaignReadReceipt" WHERE "creatorId"=$1 AND "nextDueAt" IS NOT NULL ORDER BY "nextDueAt","kind","sourceId" LIMIT 1',creatorId);
  return row?.nextDueAt || null;
}
async function scheduleClock(tx,item) {
  const due = await nextClock(tx,item.creatorId);
  if (!due) return;
  const current = await tx.domainWorkItem.findFirst({where:{agencyId:item.agencyId,creatorId:item.creatorId,workClass:"CAMPAIGN_CLOCK",objectId:item.creatorId}});
  if (current?.isOutstanding && +current.availableAt <= +due) return;
  await publishDomainWork({db:tx,agencyId:item.agencyId,creatorId:item.creatorId,partitionKey:item.creatorId,workClass:"CAMPAIGN_CLOCK",objectType:"CampaignReadClock",objectId:item.creatorId,availableAt:due});
}
async function backfillUnit(tx,item,now) {
  const [state] = await tx.$queryRawUnsafe('SELECT * FROM "CampaignReadState" WHERE "creatorId"=$1 AND "agencyId"=$2',item.creatorId,item.agencyId);
  if (!state || state.completedAt) return {done:true};
  if (state.valueFreshnessMs!=null && state.valueFreshnessMs!==CAMPAIGN_FAN_VALUE_FRESHNESS_MS && state.stage!=="DIRECTORY") {
    state.stage=state.stage==="VALUE_MEMBERS"?"VALUE_MEMBERS":"MEMBER";state.cursor="";
  }
  const sourceKind=state.stage==="VALUE_MEMBERS"?"MEMBER":state.stage;
  const order = ["DIRECTORY","MEMBER","FINANCIAL"], table = SOURCES[sourceKind];
  if (!table) throw fault("CAMPAIGN_BACKFILL_STAGE_INVALID");
  const rows = await tx.$queryRawUnsafe(`SELECT "id"${sourceKind==="MEMBER"?',"fanId"':''} FROM "${table}" WHERE "creatorId"=$1 AND "agencyId"=$2 AND "id">$3 ORDER BY "id" LIMIT $4`,item.creatorId,item.agencyId,state.cursor,PAGE);
  for (const row of rows) {
    await projectSource(tx,item,sourceKind,row.id,now);
    if (sourceKind === "MEMBER") await projectSource(tx,item,"VALUE",row.fanId,now);
  }
  const stage = rows.length === PAGE ? state.stage : state.stage==="VALUE_MEMBERS"?"DONE":order[order.indexOf(state.stage)+1] || "DONE";
  await tx.$executeRawUnsafe(`UPDATE "CampaignReadState" SET "stage"=$2,"cursor"=$3,"completedAt"=CASE WHEN $2='DONE' THEN CURRENT_TIMESTAMP ELSE NULL END,"valueFreshnessMs"=$4,"updatedAt"=CURRENT_TIMESTAMP WHERE "creatorId"=$1`,item.creatorId,stage,rows.length===PAGE?rows.at(-1).id:"",CAMPAIGN_FAN_VALUE_FRESHNESS_MS);
  return {done:stage==="DONE",processed:rows.length,stage};
}
async function valueUnit(tx,item,cursor,now) {
  await projectSource(tx,item,"VALUE",item.objectId,now);
  const rows = await tx.$queryRawUnsafe(`SELECT "id" FROM "CreatorCampaignFan" WHERE "creatorId"=$1 AND "agencyId"=$2 AND "fanId"=$3 AND "id">$4 ORDER BY "id" LIMIT $5`,item.creatorId,item.agencyId,item.objectId,cursor.id||"",PAGE);
  for (const row of rows) await projectSource(tx,item,"MEMBER",row.id,now);
  return {done:rows.length<PAGE,processed:rows.length,cursor:{id:rows.at(-1)?.id||cursor.id}};
}
async function attributionUnit(tx,item,cursor,now) {
  // Capture locks repair intent before its DWI. Follow that order and never
  // lock canonical rows; the only source operation here is an MVCC read.
  const [repair] = await tx.$queryRawUnsafe('SELECT * FROM "CampaignReadRepair" WHERE "creatorId"=$1 AND "agencyId"=$2 AND "fanId"=$3 FOR UPDATE',item.creatorId,item.agencyId,item.objectId);
  if (!repair) return {done:true};
  const rows = await tx.$queryRawUnsafe(`SELECT "id","occurredAt" FROM "CreatorFinancialTransaction"
    WHERE "creatorId"=$1 AND "agencyId"=$2 AND "fanId"=$3 AND "occurredAt">=$4
      AND ("occurredAt","id")>($5::timestamp,$6::text) ORDER BY "occurredAt","id" LIMIT $7`,
  item.creatorId,item.agencyId,item.objectId,repair.fromAt,cursor.at?new Date(cursor.at):repair.fromAt,cursor.id||"",PAGE);
  for (const row of rows) await projectSource(tx,item,"FINANCIAL",row.id,now);
  const done = rows.length < PAGE;
  if (done) await tx.$executeRawUnsafe('DELETE FROM "CampaignReadRepair" WHERE "creatorId"=$1 AND "fanId"=$2',item.creatorId,item.objectId);
  return {done,processed:rows.length,cursor:rows.length?{id:rows.at(-1).id,at:rows.at(-1).occurredAt.toISOString()}:cursor};
}
async function clockUnit(tx,item,now) {
  const rows = await tx.$queryRawUnsafe(`SELECT "kind","sourceId" FROM "CampaignReadReceipt" WHERE "creatorId"=$1 AND "nextDueAt"<=$2 ORDER BY "nextDueAt","kind","sourceId" LIMIT $3`,item.creatorId,now,PAGE);
  for (const row of rows) await projectSource(tx,item,row.kind,row.sourceId,now);
  const next = await nextClock(tx,item.creatorId);
  return {done:!next,availableAt:next,processed:rows.length};
}
async function factUnit(tx,item,now) {
  const rows=await tx.$queryRawUnsafe('SELECT * FROM "CampaignReadChange" WHERE "creatorId"=$1 AND "agencyId"=$2 ORDER BY "id" LIMIT $3',item.creatorId,item.agencyId,PAGE);
  const sources=new Map(rows.map(row=>[JSON.stringify([row.kind,row.sourceId]),row]));
  for (const row of sources.values()) await projectSource(tx,item,row.kind,row.sourceId,now);
  if(rows.length) await tx.$executeRawUnsafe('DELETE FROM "CampaignReadChange" WHERE "creatorId"=$1 AND "id"=ANY($2::bigint[])',item.creatorId,rows.map(r=>r.id));
  return {done:rows.length<PAGE,processed:rows.length};
}
async function runCampaignProjectionUnit({db,item,ownerToken}) {
  return runRootCommit(db,async({tx}) => {
    const lifecycle = await lockAgencyLifecycleBarrier({db:tx,agencyId:item.agencyId});
    const creators = await tx.$queryRawUnsafe('SELECT "id" FROM "CreatorAccount" WHERE "id"=$1 AND "agencyId"=$2 AND "deletedAt" IS NULL FOR SHARE',item.creatorId,item.agencyId);
    if (creators.length && await require("./analytics-projection-lifecycle-service").pauseDeletedAgencyProjection({db:tx,lifecycle,item,ownerToken})) return {done:false,paused:true};
    let result = {done:true,retired:true};
    if (lifecycle.row && !lifecycle.row.deletedAt && creators.length) {
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended('campaign-read-v1:'||$1,0))",item.creatorId);
      const now = await dbAuthorityNow({db:tx});
      const cursor = String(item.progressCursor?.revision)===String(item.claimedRevision)?item.progressCursor:{};
      if (item.workClass==="CAMPAIGN_BACKFILL") result=await backfillUnit(tx,item,now);
      else if (item.workClass==="CAMPAIGN_VALUE") result=await valueUnit(tx,item,cursor,now);
      else if (item.workClass==="CAMPAIGN_ATTRIBUTION") result=await attributionUnit(tx,item,cursor,now);
      else if (item.workClass==="CAMPAIGN_CLOCK") result=await clockUnit(tx,item,now);
      else if (item.workClass==="CAMPAIGN_FACT") result=await factUnit(tx,item,now);
      else throw fault("CAMPAIGN_WORK_CLASS_INVALID");
      if (item.workClass!=="CAMPAIGN_CLOCK") await scheduleClock(tx,item);
    }
    const fence=await lockDomainWorkClaimForCommit({db:tx,item,ownerToken});
    if (!fence.current) throw fault("CAMPAIGN_PROJECTION_CLAIM_LOST");
    const settlement=result.done?await ackDomainWorkClaim({db:tx,item,ownerToken})
      :await yieldDomainWorkClaim({db:tx,item,ownerToken,availableAt:result.availableAt||null,progressCursor:{...result.cursor,revision:String(item.claimedRevision)}});
    if (settlement.lost) throw fault("CAMPAIGN_PROJECTION_CLAIM_LOST");
    return result;
  },{profile:"JOB_CHUNK",authority:{kind:"CAMPAIGN_READ_PROJECTION",agencyId:item.agencyId,creatorId:item.creatorId}});
}
async function seedCampaignProjection({db}) {
  return runRootCommit(db,async({tx}) => {
    const [seed]=await tx.$queryRawUnsafe('SELECT * FROM "CampaignReadSeed" WHERE "id"=\'v1\' FOR UPDATE SKIP LOCKED');
    if (!seed) return {seeded:0};
    if (seed.valueFreshnessMs!==CAMPAIGN_FAN_VALUE_FRESHNESS_MS) {
      await tx.$executeRawUnsafe('UPDATE "CampaignReadSeed" SET "valueFreshnessMs"=$1,"cursor"=\'\',"complete"=false WHERE "id"=\'v1\'',CAMPAIGN_FAN_VALUE_FRESHNESS_MS);
      seed.cursor="";seed.complete=false;
    }
    if (seed.complete) return {seeded:0};
    const rows=await tx.creatorAccount.findMany({where:{id:{gt:seed.cursor},deletedAt:null},orderBy:{id:"asc"},take:PAGE,select:{id:true,agencyId:true}});
    for (const row of rows) {
      await tx.$executeRawUnsafe('SELECT "onlinod_campaign_read_enroll_v1"($1,$2)',row.agencyId,row.id);
      const changed=await tx.$executeRawUnsafe(`UPDATE "CampaignReadState" SET "stage"='VALUE_MEMBERS',"cursor"='',"completedAt"=NULL
        WHERE "creatorId"=$1 AND "completedAt" IS NOT NULL AND "valueFreshnessMs" IS DISTINCT FROM $2`,row.id,CAMPAIGN_FAN_VALUE_FRESHNESS_MS);
      if(changed)await publishDomainWork({db:tx,agencyId:row.agencyId,creatorId:row.id,partitionKey:row.id,workClass:"CAMPAIGN_BACKFILL",objectType:"CampaignReadState",objectId:row.id});
    }
    await tx.$executeRawUnsafe('UPDATE "CampaignReadSeed" SET "cursor"=$1,"complete"=$2 WHERE "id"=\'v1\'',rows.at(-1)?.id||seed.cursor,rows.length<PAGE);
    return {seeded:rows.length};
  },{profile:"JOB_CHUNK",authority:{kind:"CAMPAIGN_READ_SEED"}});
}
async function runCampaignProjectionSweep({db,limit=4}) {
  const seed=await seedCampaignProjection({db}),results=[];
  for (const workClass of CLASSES) {
    const batch=await claimDomainWorkBatch({db,workClass,limit:Math.max(1,Math.min(8,limit)),perAgencyQuantum:2,perPartitionQuantum:1});
    for (const item of batch.items||[]) {
      try { results.push(await runCampaignProjectionUnit({db,item,ownerToken:batch.ownerToken})); }
      catch(error) { await failDomainWorkClaim({db,item,ownerToken:batch.ownerToken,error}); results.push({error:String(error.code||error.message)}); }
    }
  }
  return {ok:results.every(x=>!x.error),seed,processed:results.length,results};
}
module.exports={PAGE,RANGES,CLASSES,windowMembership,valueMetrics,financialMetrics,deltas,projectSource,clockUnit,runCampaignProjectionUnit,seedCampaignProjection,runCampaignProjectionSweep};

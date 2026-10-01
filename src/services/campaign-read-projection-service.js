"use strict";

const { runRootCommit } = require("./db-commit-kernel");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { lockAgencyLifecycleBarrier } = require("./agency-lifecycle-barrier-service");
const { claimDomainWorkBatch, lockDomainWorkClaimForCommit, ackDomainWorkClaim,
  yieldDomainWorkClaim, failDomainWorkClaim, publishDomainWork } = require("./domain-work-authority-service");
const { CAMPAIGN_FAN_VALUE_FRESHNESS_MS, COLLECTION_FUTURE_SKEW_TOLERANCE_MS } = require("./analytics-freshness-policy");
const { utcDay, DAY_MS } = require("./analytics-range-contract");

const { enterCampaignProjection, admitProjectionWorkClass } = require("./campaign-projection-policy");
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
function valueMetrics(value, now, freshnessMs = CAMPAIGN_FAN_VALUE_FRESHNESS_MS) {
  const observed = value?.fetchedAt ? new Date(value.fetchedAt) : null;
  const trusted = observed && +observed <= +now + COLLECTION_FUTURE_SKEW_TOLERANCE_MS;
  const expires = observed ? new Date(+observed + freshnessMs) : null;
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
  const [before] = await tx.$queryRawUnsafe('SELECT "contributions","nextDueAt" FROM "CampaignReadReceipt" WHERE "creatorId"=$1 AND "kind"=$2 AND "sourceId"=$3', item.creatorId,kind,sourceId);
  const delta = deltas(before?.contributions || [],contributions);
  if (before && !delta.length && +(before.nextDueAt || 0) === +(nextDueAt || 0)) return;
  if (delta.length) await tx.$executeRawUnsafe(`SELECT "onlinod_campaign_read_add_v1"($1,$2,x."campaignId",x."rangeKey",x."fanId",x.metrics)
    FROM jsonb_to_recordset($3::jsonb) x("campaignId" text,"rangeKey" text,"fanId" text,metrics jsonb)`,item.agencyId,item.creatorId,JSON.stringify(delta));
  if (!contributions.length && !nextDueAt) {
    await tx.$executeRawUnsafe('DELETE FROM "CampaignReadReceipt" WHERE "creatorId"=$1 AND "kind"=$2 AND "sourceId"=$3',item.creatorId,kind,sourceId);
  } else await tx.$executeRawUnsafe(`INSERT INTO "CampaignReadReceipt"("agencyId","creatorId","kind","sourceId","contributions","nextDueAt") VALUES($1,$2,$3,$4,$5::jsonb,"phase3_utc_timestamp"($6::timestamptz))
    ON CONFLICT("creatorId","kind","sourceId") DO UPDATE SET "contributions"=EXCLUDED."contributions","nextDueAt"=EXCLUDED."nextDueAt","updatedAt"=CURRENT_TIMESTAMP`,
  item.agencyId,item.creatorId,kind,sourceId,JSON.stringify(contributions),nextDueAt);
}
async function projectSource(tx, item, kind, id, now) {
  const policy = item.policy || await enterCampaignProjection(tx);
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
    const current = valueMetrics(value,now,policy.valueFreshnessMs); schedule(current.due);
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
    const [attribution] = row.fanId ? await tx.$queryRawUnsafe(`SELECT "onlinod_campaign_read_attribution_v3"($2::text,$1::text,$3::text,"phase3_utc_timestamp"($4::timestamptz)) AS "campaignId"`,item.creatorId,item.agencyId,row.fanId,row.occurredAt) : [];
    const money = financialMetrics(row);
    if (attribution?.campaignId && Object.keys(money).length) for (const w of window.ranges) for (const p of ["",attribution.campaignId]) add(p,w,row.fanId,money);
    // Unattributed facts are found by the membership interval repair later.
    if (!attribution?.campaignId || !Object.keys(money).length) due.length=0;
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
  let [state] = await tx.$queryRawUnsafe('SELECT * FROM "CampaignReadStateData" WHERE "creatorId"=$1 AND "agencyId"=$2 FOR UPDATE',item.creatorId,item.agencyId);
  if (!state) return {done:true};
  const policy=item.policy;
  if (state.generation!==policy.generation) {
    await tx.$executeRawUnsafe(`UPDATE "CampaignReadStateData" SET "generation"=$2,"valueFreshnessMs"=$3,
      "stage"='RESET_RECEIPTS',"cursor"='',"completedAt"=NULL WHERE "creatorId"=$1`,item.creatorId,policy.generation,policy.valueFreshnessMs);
    state={...state,generation:policy.generation,stage:"RESET_RECEIPTS",cursor:"",completedAt:null};
  }
  if(state.completedAt)return {done:true};
  // Rebuild only the derived cache, in bounded chunks. New intervals/outbox are
  // retained throughout reset; canonical changes therefore cannot disappear.
  const resets={RESET_RECEIPTS:["CampaignReadReceipt",["kind","sourceId"],"RESET_METRICS"],
    RESET_METRICS:["CampaignReadMetric",["campaignId","rangeKey","fanId"],"RESET_LEGACY_REPAIR"],
    RESET_LEGACY_REPAIR:["CampaignReadRepair",["fanId"],"DIRECTORY"]};
  let processed=0;
  while(resets[state.stage]) {
    const [table,keys,next]=resets[state.stage],columns=keys.map(k=>'"'+k+'"').join(',');
    const count=await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "creatorId"=$1 AND (${columns}) IN
      (SELECT ${columns} FROM "${table}" WHERE "creatorId"=$1 ORDER BY ${columns} LIMIT $2)`,item.creatorId,PAGE);
    processed+=count;
    if(count===PAGE)return {done:false,processed,stage:state.stage};
    state.stage=next;
    await tx.$executeRawUnsafe('UPDATE "CampaignReadStateData" SET "stage"=$2 WHERE "creatorId"=$1',item.creatorId,next);
  }
  const [campaign]=await tx.$queryRawUnsafe('SELECT "id" FROM "CreatorCampaign" WHERE "creatorId"=$1 LIMIT 1',item.creatorId);
  if(!campaign){state.stage="DONE";state.cursor="";}
  const order=["DIRECTORY","MEMBER","FINANCIAL"];
  // Empty stage transitions happen within this one work unit, not three queue
  // admissions. A page budget bounds total canonical rows in this commit.
  let budget=PAGE;
  while(order.includes(state.stage)) {
    const kind=state.stage,table=SOURCES[kind];
    const rows=await tx.$queryRawUnsafe(`SELECT "id"${kind==="MEMBER"?',"fanId"':''} FROM "${table}"
      WHERE "creatorId"=$1 AND "agencyId"=$2 AND "id">$3 ORDER BY "id" LIMIT $4`,item.creatorId,item.agencyId,state.cursor,budget);
    for(const row of rows){await projectSource(tx,item,kind,row.id,now);if(kind==="MEMBER")await projectSource(tx,item,"VALUE",row.fanId,now);}
    budget-=rows.length;processed+=rows.length;
    if(!budget){state.cursor=rows.at(-1).id;break;}
    state.stage=order[order.indexOf(state.stage)+1]||"DONE";state.cursor="";
  }
  await tx.$executeRawUnsafe(`UPDATE "CampaignReadStateData" SET "stage"=$2,"cursor"=$3,
    "completedAt"=CASE WHEN $2='DONE' THEN "phase3_utc_timestamp"(CURRENT_TIMESTAMP) ELSE NULL END,
    "updatedAt"="phase3_utc_timestamp"(CURRENT_TIMESTAMP) WHERE "creatorId"=$1`,item.creatorId,state.stage,state.cursor);
  return {done:state.stage==="DONE",processed,stage:state.stage};
}
async function valueUnit(tx,item,cursor,now) {
  await projectSource(tx,item,"VALUE",item.objectId,now);
  const rows = await tx.$queryRawUnsafe(`SELECT "id" FROM "CreatorCampaignFan" WHERE "creatorId"=$1 AND "agencyId"=$2 AND "fanId"=$3 AND "id">$4 ORDER BY "id" LIMIT $5`,item.creatorId,item.agencyId,item.objectId,cursor.id||"",PAGE);
  for (const row of rows) await projectSource(tx,item,"MEMBER",row.id,now);
  return {done:rows.length<PAGE,processed:rows.length,cursor:{id:rows.at(-1)?.id||cursor.id}};
}
async function attributionUnit(tx,item,cursor,now) {
  const queue=await tx.$queryRawUnsafe(`SELECT * FROM "CampaignReadRepairInterval"
    WHERE "creatorId"=$1 AND "agencyId"=$2 AND "fanId"=$3 ORDER BY "id" LIMIT 32 FOR UPDATE`,item.creatorId,item.agencyId,item.objectId);
  if(!queue.length)return {done:true,processed:0};
  const repair={...queue[0]}, merged=[];
  let changed=true;
  while(changed){changed=false;for(const r of queue.slice(1)){
    if(merged.includes(r.id))continue;
    if(+r.fromAt<=(repair.untilAt?+repair.untilAt:Infinity) && +repair.fromAt<=(r.untilAt?+r.untilAt:Infinity)){
      repair.fromAt=new Date(Math.min(+repair.fromAt,+r.fromAt));
      repair.untilAt=repair.untilAt&&r.untilAt?new Date(Math.max(+repair.untilAt,+r.untilAt)):null;
      merged.push(r.id);changed=true;
    }
  }}
  if(merged.length){
    // A newly captured edit can invalidate an already traversed prefix.
    repair.cursorAt=null;repair.cursorId="";
    await tx.$executeRawUnsafe('DELETE FROM "CampaignReadRepairInterval" WHERE "creatorId"=$1 AND "id"=ANY($2::bigint[])',item.creatorId,merged);
  }
  const args=[item.creatorId,item.agencyId,item.objectId,repair.fromAt];
  let bounds='';
  // Keep range/keyset conditions directly indexable even after PostgreSQL
  // switches a prepared statement to a generic plan. Nullable OR predicates
  // can otherwise rescan the already traversed prefix on every page.
  if(repair.untilAt){args.push(repair.untilAt);bounds+=` AND "occurredAt"<"phase3_utc_timestamp"($${args.length}::timestamptz)`;}
  if(repair.cursorAt){args.push(repair.cursorAt,repair.cursorId);bounds+=` AND ("occurredAt","id")>("phase3_utc_timestamp"($${args.length-1}::timestamptz),$${args.length}::text)`;}
  args.push(PAGE);
  const rows=await tx.$queryRawUnsafe(`SELECT "id","occurredAt" FROM "CreatorFinancialTransaction"
    WHERE "creatorId"=$1 AND "agencyId"=$2 AND "fanId"=$3
      AND "occurredAt">="phase3_utc_timestamp"($4::timestamptz)
      ${bounds} ORDER BY "occurredAt","id" LIMIT $${args.length}`,...args);
  for(const row of rows)await projectSource(tx,item,"FINANCIAL",row.id,now);
  if(rows.length<PAGE)await tx.$executeRawUnsafe('DELETE FROM "CampaignReadRepairInterval" WHERE "id"=$1',repair.id);
  else await tx.$executeRawUnsafe(`UPDATE "CampaignReadRepairInterval" SET "fromAt"="phase3_utc_timestamp"($2::timestamptz),
    "untilAt"="phase3_utc_timestamp"($3::timestamptz),"cursorAt"="phase3_utc_timestamp"($4::timestamptz),"cursorId"=$5 WHERE "id"=$1`,
    repair.id,repair.fromAt,repair.untilAt,rows.at(-1).occurredAt,rows.at(-1).id);
  const [remaining]=await tx.$queryRawUnsafe('SELECT "id" FROM "CampaignReadRepairInterval" WHERE "creatorId"=$1 AND "fanId"=$2 ORDER BY "id" LIMIT 1',item.creatorId,item.objectId);
  return {done:!remaining,processed:rows.length,coalesced:merged.length};
}
async function clockUnit(tx,item,now) {
  const rows = await tx.$queryRawUnsafe(`SELECT "kind","sourceId" FROM "CampaignReadReceipt" WHERE "creatorId"=$1 AND "nextDueAt"<="phase3_utc_timestamp"($2::timestamptz) ORDER BY "nextDueAt","kind","sourceId" LIMIT $3`,item.creatorId,now,PAGE);
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
    const policy=await enterCampaignProjection(tx);item={...item,policy};
    const lifecycle = await lockAgencyLifecycleBarrier({db:tx,agencyId:item.agencyId});
    const creators = await tx.$queryRawUnsafe('SELECT "id" FROM "CreatorAccount" WHERE "id"=$1 AND "agencyId"=$2 AND "deletedAt" IS NULL FOR SHARE',item.creatorId,item.agencyId);
    if (creators.length && await require("./analytics-projection-lifecycle-service").pauseDeletedAgencyProjection({db:tx,lifecycle,item,ownerToken})) return {done:false,paused:true};
    let result = {done:true,retired:true};
    if (lifecycle.row && !lifecycle.row.deletedAt && creators.length) {
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended('campaign-read-v1:'||$1,0))",item.creatorId);
      const now = await dbAuthorityNow({db:tx});
      const cursor = String(item.progressCursor?.revision)===String(item.claimedRevision)?item.progressCursor:{};
      const [state]=await tx.$queryRawUnsafe('SELECT "generation","stage" FROM "CampaignReadStateData" WHERE "creatorId"=$1',item.creatorId);
      if (item.workClass==="CAMPAIGN_BACKFILL") result=await backfillUnit(tx,item,now);
      else if(state && (state.generation!==policy.generation || state.stage.startsWith("RESET_"))) {
        const outstanding=await tx.domainWorkItem.findFirst({where:{creatorId:item.creatorId,workClass:"CAMPAIGN_BACKFILL",isOutstanding:true},select:{id:true}});
        if(!outstanding)await publishDomainWork({db:tx,agencyId:item.agencyId,creatorId:item.creatorId,partitionKey:item.creatorId,workClass:"CAMPAIGN_BACKFILL",objectType:"CampaignReadState",objectId:item.creatorId});
        // Help reset using the already admitted unit. Backfill's own durable
        // claim remains outstanding; this class is yielded, never swallowed.
        result={...await backfillUnit(tx,item,now),done:false};
      }
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
    const policy=await enterCampaignProjection(tx);
    const [seed]=await tx.$queryRawUnsafe('SELECT "id","cursor","complete","valueFreshnessMs","generation" FROM "CampaignReadSeed" WHERE "id"=\'v1\' FOR UPDATE SKIP LOCKED');
    if(!seed)return {seeded:0,visited:0};
    if(seed.generation!==policy.generation){
      await tx.$executeRawUnsafe('UPDATE "CampaignReadSeed" SET "generation"=$1,"valueFreshnessMs"=$2,"cursor"=\'\',"complete"=false WHERE "id"=\'v1\'',policy.generation,policy.valueFreshnessMs);
      seed.cursor="";seed.complete=false;
    }
    if(seed.complete)return {seeded:0,visited:0};
    const rows=await tx.$queryRawUnsafe(`WITH batch AS MATERIALIZED (
      SELECT "id","agencyId" FROM "CreatorAccount" WHERE "id">$1 AND "deletedAt" IS NULL ORDER BY "id" LIMIT $2
    ) SELECT b.*,EXISTS(SELECT 1 FROM "CreatorCampaign" c WHERE c."creatorId"=b."id") AS relevant,
      s."generation" AS "stateGeneration" FROM batch b LEFT JOIN "CampaignReadStateData" s ON s."creatorId"=b."id" ORDER BY b."id"`,seed.cursor,PAGE);
    let seeded=0;
    for(const row of rows)if(row.relevant || row.stateGeneration!=null){
      await tx.$executeRawUnsafe('SELECT "onlinod_campaign_read_enroll_v1"($1,$2)',row.agencyId,row.id);
      if(row.stateGeneration!=null && row.stateGeneration!==policy.generation)await publishDomainWork({db:tx,agencyId:row.agencyId,creatorId:row.id,partitionKey:row.id,workClass:"CAMPAIGN_BACKFILL",objectType:"CampaignReadState",objectId:row.id});
      seeded++;
    }
    await tx.$executeRawUnsafe('UPDATE "CampaignReadSeed" SET "cursor"=$1,"complete"=$2 WHERE "id"=\'v1\'',rows.at(-1)?.id||seed.cursor,rows.length<PAGE);
    return {seeded,visited:rows.length};
  },{profile:"JOB_CHUNK",authority:{kind:"CAMPAIGN_READ_SEED"}});
}
async function runCampaignProjectionSweep({db,limit=4,concurrency=1,seed=true,maxRuntimeMs=Infinity}) {
  const started=Date.now();
  const seeding=seed?await seedCampaignProjection({db}):{visited:0,seeded:0},results=[];
  for (let turn=0;turn<CLASSES.length && Date.now()-started<maxRuntimeMs;turn++) {
    const workClass=await admitProjectionWorkClass(db);
    if(!workClass)break;
    const batch=await claimDomainWorkBatch({db,workClass,limit:Math.max(1,Math.min(8,limit)),perAgencyQuantum:2,perPartitionQuantum:1});
    const items=[...(batch.items||[])];
    await Promise.all(Array.from({length:Math.min(items.length,Math.max(1,Math.min(4,concurrency)))},async()=>{
      while(items.length){const item=items.shift();
        try{results.push(await runCampaignProjectionUnit({db,item,ownerToken:batch.ownerToken}));}
        catch(error){await failDomainWorkClaim({db,item,ownerToken:batch.ownerToken,error});results.push({error:String(error.code||error.message)});}
      }
    }));
  }
  return {ok:results.every(x=>!x.error),seed:seeding,processed:results.length,results};
}
module.exports={PAGE,RANGES,CLASSES,windowMembership,valueMetrics,financialMetrics,deltas,projectSource,clockUnit,runCampaignProjectionUnit,seedCampaignProjection,runCampaignProjectionSweep};

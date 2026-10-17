"use strict";
const {randomUUID}=require("node:crypto");
const {realtimeFrameSampleAt}=require("./team-observation-service");
const {hasLongOfflineGap,hasRealtimeCoverageClockSkew,OFFLINE_DIALOG_RECOVERY_GAP_MS}=require("./dialog-offline-recovery-service");
const optionalInt=x=>x==null||x===""||!Number.isInteger(Number(x))||Number(x)<0?null:Number(x);
const capabilityFields=["sessionReadReady","sessionWriteReady","realtimeReady","pageLocalReady","browserMaterialized","browserPresentable"];
async function syncBindings({agencyId,deviceId,accounts,allowedCreatorIds=null,currentAccessEpoch=null,now,db}) {
  let rejected=0;
  const resolved=new Map(), recovery=new Map();
  for(let start=0;start<accounts.length;start+=500) {
    const batch=accounts.slice(start,start+500), refs=batch.map((a,i)=>({i,ids:[a.creatorId,a.backendCreatorId,a.accountId].filter(Boolean).map(String),
      remote:a.remoteId==null?null:String(a.remoteId),username:a.username?String(a.username).replace(/^@/,""):null}));
    const rows=await db.$queryRawUnsafe(`SELECT x.i,c.id,o."lastRealtimeEventAt" FROM jsonb_to_recordset($1::jsonb) x(i int,ids text[],remote text,username text)
      JOIN LATERAL (SELECT id FROM "CreatorAccount" WHERE "agencyId"=$2 AND "deletedAt" IS NULL AND status='READY'
        AND (id=ANY(x.ids) OR "remoteId"=x.remote OR username=x.username)
        ORDER BY (id=ANY(x.ids)) DESC,id LIMIT 1) c ON true
      LEFT JOIN "TeamObservationState" o ON o."agencyId"=$2 AND o."creatorId"=c.id`,JSON.stringify(refs),agencyId);
    const byIndex=new Map(rows.map(x=>[x.i,x]));
    for(let i=0;i<batch.length;i++) {
      const a=batch[i],found=byIndex.get(i);
      if(!found || allowedCreatorIds && !allowedCreatorIds.has(found.id)) {rejected++;continue;}
      // Repeated account aliases cannot acquire the same row twice in one insert.
      if(resolved.has(found.id)) {rejected++;continue;}
      const epoch=optionalInt(a.accessEpoch),current=optionalInt(currentAccessEpoch)!==null && epoch===optionalInt(currentAccessEpoch);
      const read=current&&a.sessionReadReady===true, materialized=current&&a.browserMaterialized===true;
      const at=current&&a.realtimeHealthy===true?realtimeFrameSampleAt(a,now):null;
      const account={...a,creatorId:found.id,backendCreatorId:found.id,sessionReadReady:read,
        sessionWriteReady:read&&a.sessionWriteReady===true,realtimeHealthy:Boolean(at),pageLocalReady:current&&a.pageLocalReady===true,
        browserMaterialized:materialized,browserPresentable:materialized&&a.browserPresentable===true,lastWsFrameAt:at?.toISOString()||null};
      resolved.set(found.id,{creatorId:found.id,account});
      if(at && (!found.lastRealtimeEventAt || hasLongOfflineGap(found.lastRealtimeEventAt,now,OFFLINE_DIALOG_RECOVERY_GAP_MS) || hasRealtimeCoverageClockSkew(found.lastRealtimeEventAt,now)))
        recovery.set(found.id,{creatorId:found.id,lastCoveredAt:found.lastRealtimeEventAt||null});
    }
  }
  const entries=[...resolved.values()].sort((a,b)=>a.creatorId.localeCompare(b.creatorId));
  const fields=["remoteId","username","accessEpoch",...capabilityFields,"sessionProofEpoch","canonicalRevision","networkRevision"];
  for(let start=0;start<entries.length;start+=500) {
    const data=entries.slice(start,start+500).map(({creatorId,account:a})=>({id:randomUUID(),creatorId,
      remoteId:a.remoteId==null?null:String(a.remoteId),username:a.username?String(a.username).replace(/^@/,""):null,
      accessEpoch:optionalInt(a.accessEpoch),...Object.fromEntries(capabilityFields.map(k=>[k,k==="realtimeReady"?a.realtimeHealthy:a[k]===true])),
      sessionProofEpoch:optionalInt(a.sessionProofEpoch),canonicalRevision:optionalInt(a.canonicalRevision),networkRevision:optionalInt(a.networkRevision)}));
    const columns=fields.map(k=>`"${k}"`).join(","), types=fields.map(k=>`"${k}" ${capabilityFields.includes(k)?"boolean":/Epoch|Revision/.test(k)?"int":"text"}`).join(",");
    await db.$executeRawUnsafe(`INSERT INTO "DeviceCreatorBinding"(id,"agencyId","deviceId","creatorId",status,${columns},"lastCapabilityAt","lastSeenAt","updatedAt")
      SELECT x.id,$1,$2,x."creatorId",'ACTIVE',${fields.map(k=>`x."${k}"`).join(",")},$4,$4,$4
      FROM jsonb_to_recordset($3::jsonb) x(id text,"creatorId" text,${types}) ORDER BY x."creatorId"
      ON CONFLICT("deviceId","creatorId") DO UPDATE SET status='ACTIVE',${fields.map(k=>`"${k}"=EXCLUDED."${k}"`).join(",")},
        "lastCapabilityAt"=$4,"lastSeenAt"=$4,"updatedAt"=$4
      WHERE ("DeviceCreatorBinding"."lastSeenAt" IS NULL OR "DeviceCreatorBinding"."lastSeenAt"<=$4)
        AND ("DeviceCreatorBinding".status<>'ACTIVE' OR "DeviceCreatorBinding"."lastSeenAt"<$4::timestamp-interval '60 seconds'
          OR (${fields.map(k=>`"DeviceCreatorBinding"."${k}"`).join(",")}) IS DISTINCT FROM (${fields.map(k=>`EXCLUDED."${k}"`).join(",")}))`,agencyId,deviceId,JSON.stringify(data),now);
  }
  await db.$executeRawUnsafe(`UPDATE "DeviceCreatorBinding" SET status='STALE',${capabilityFields.map(k=>`"${k}"=false`).join(",")},"updatedAt"=$4
    WHERE "agencyId"=$1 AND "deviceId"=$2 AND "creatorId"<>ALL($3::text[]) AND status<>'STALE' AND ("lastSeenAt" IS NULL OR "lastSeenAt"<=$4)`,agencyId,deviceId,entries.map(x=>x.creatorId),now);
  return {accepted:entries.length,rejected,visibleCreatorIds:entries.map(x=>x.creatorId),recoveryCandidates:[...recovery.values()],resolvedAccounts:entries};
}
async function recordTeamObservations({db,agencyId,bindings,now,preserve}) {
  let advanced=0;
  for(let start=0;start<bindings.length;start+=500) {
    const rows=bindings.slice(start,start+500).map(({creatorId,account:a})=>{
      const at=preserve(creatorId)?null:realtimeFrameSampleAt(a,now); if(at)advanced++;
      return {id:randomUUID(),creatorId,accountId:String(a.accountId||creatorId).slice(0,160),
        creatorRef:String(a.username||a.displayName||"").slice(0,160)||null,at};
    });
    await db.$executeRawUnsafe(`INSERT INTO "TeamObservationState"(id,"agencyId","creatorId","accountId","creatorRef","lastHeartbeatAt","lastObservedAt","lastRealtimeEventAt","updatedAt")
      SELECT x.id,$1,x."creatorId",x."accountId",x."creatorRef",$3,$3,x.at,$3
      FROM jsonb_to_recordset($2::jsonb) x(id text,"creatorId" text,"accountId" text,"creatorRef" text,at timestamp) ORDER BY x."creatorId"
      ON CONFLICT("agencyId","creatorId") DO UPDATE SET "accountId"=EXCLUDED."accountId","creatorRef"=EXCLUDED."creatorRef",
        "lastHeartbeatAt"=GREATEST("TeamObservationState"."lastHeartbeatAt",$3),"lastObservedAt"=GREATEST("TeamObservationState"."lastObservedAt",$3),
        "lastRealtimeEventAt"=CASE WHEN EXCLUDED."lastRealtimeEventAt" IS NULL THEN "TeamObservationState"."lastRealtimeEventAt"
          WHEN "TeamObservationState"."lastRealtimeEventAt">$3::timestamp+interval '30 seconds' THEN EXCLUDED."lastRealtimeEventAt"
          ELSE GREATEST("TeamObservationState"."lastRealtimeEventAt",EXCLUDED."lastRealtimeEventAt") END,"updatedAt"=$3
      WHERE "TeamObservationState"."lastHeartbeatAt" IS NULL OR "TeamObservationState"."lastHeartbeatAt"<$3::timestamp-interval '60 seconds'
        OR "TeamObservationState"."lastRealtimeEventAt" IS NULL AND EXCLUDED."lastRealtimeEventAt" IS NOT NULL
        OR "TeamObservationState"."lastRealtimeEventAt">$3::timestamp+interval '30 seconds'`,agencyId,JSON.stringify(rows),now);
  }
  return {ok:true,observed:bindings.length,scheduled:0,results:[],realtimeHealthy:bindings.length,realtimeCoverageAdvanced:advanced,realtimeCoverageFenced:bindings.length-advanced};
}
module.exports={syncBindings,recordTeamObservations};

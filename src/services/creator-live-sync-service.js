"use strict";

// Capture, delivery and collection coverage are separate authorities. All writes
// join an already-authorized root commit; no network work happens under a lock.
const { hashCanonicalJson } = require("./realtime-receipt-hash");
const POLICY_VERSION = 2;
const OFFLINE_GAP_MS = 60 * 60_000;
const SAMPLE_MAX_AGE_MS = 3 * 60_000;
const STREAMS = Object.freeze(["notifications", "financial", "campaigns", "subscribers"]);
const JOB_STREAM = Object.freeze({
  catchup_notifications_scan: "notifications",
  financial_transactions_scan: "financial",
  fetch_campaigns: "campaigns",
  subscriber_directory_scan: "subscribers",
});
const key = (...parts) => hashCanonicalJson(parts);
const date = (value) => {
  const normalized=typeof value==="string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)?value+"Z":value;
  const d = normalized ? new Date(normalized) : null;
  return d && Number.isFinite(+d) ? d : null;
};
function error(code) {
  return Object.assign(new Error(code), { code, status: 409 });
}
function validSequence(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function isAutomaticReason(reason) {
  return [
    "RECURRING",
    "HOME_AUTOMATIC",
    "creator_analytics_catchup",
    "CAMPAIGN_VALUE_EXPIRED",
    "subscriber_directory_due",
  ].includes(String(reason || ""));
}
function automaticJob(job) {
  const p = job.params || {};
  return (
    Boolean(JOB_STREAM[job.jobKey] || job.jobKey === "fetch_earnings") &&
    p.analyticsSyncKind !== "initial" &&
    p.collectionMode !== "full" &&
    p.notificationMode !== "full" &&
    isAutomaticReason(p.collectionReason || p.reason)
  );
}
function admitsJob(job) {
  return (
    !automaticJob(job) || (job.params?.syncPolicyVersion === POLICY_VERSION && Boolean(job.params?.recoveryIntentId))
  );
}

async function ensureState(db, agencyId, creatorId) {
  await db.$executeRawUnsafe(
    `INSERT INTO "CreatorLiveSync"("creatorId","agencyId") VALUES($1,$2) ON CONFLICT("creatorId") DO NOTHING`,
    creatorId,
    agencyId
  );
  const [row] = await db.$queryRawUnsafe(
    'SELECT * FROM "CreatorLiveSync" WHERE "creatorId"=$1 AND "agencyId"=$2 FOR UPDATE',
    creatorId,
    agencyId
  );
  if (!row) throw error("LIVE_SYNC_SCOPE_MISMATCH");
  return row;
}
async function session(db, { agencyId, creatorId, deviceId, memberId, accessEpoch, observation }) {
  if (
    observation?.version !== 1 ||
    !/^[a-f0-9-]{16,80}$/i.test(observation.sessionId || "") ||
    !validSequence(observation.capturedThroughSeq)
  )
    throw error("LIVE_CAPTURE_PROTOCOL_INVALID");
  const id = key(creatorId, deviceId, observation.sessionId);
  await db.$executeRawUnsafe(
    `INSERT INTO "CreatorRealtimeSession"(id,"agencyId","creatorId","deviceId","memberId","accessEpoch","incarnation")
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,
    id,
    agencyId,
    creatorId,
    deviceId,
    memberId,
    accessEpoch,
    observation.sessionId
  );
  const [row] = await db.$queryRawUnsafe('SELECT * FROM "CreatorRealtimeSession" WHERE id=$1 FOR UPDATE', id);
  if (
    !row ||
    row.agencyId !== agencyId ||
    row.creatorId !== creatorId ||
    row.deviceId !== deviceId ||
    row.memberId !== memberId ||
    row.accessEpoch > accessEpoch
  )
    throw error("LIVE_CAPTURE_SESSION_STALE");
  return row;
}

async function recordCaptureSample(input) {
  return (await recordCaptureSamples({...input,bindings:[{creatorId:input.creatorId,account:input.account}]}))[0]
    || {recorded:false,reason:"receive_path_unhealthy"};
}

// The protocol has one implementation for both a single observer and an entire
// heartbeat. Sorted creator locks precede every session lock, on hot and cold
// paths alike. No network roundtrip is proportional to the number of creators.
async function recordCaptureSamples({db,agencyId,deviceId,memberId,accessEpoch,bindings,now}) {
  const input=[...new Map(bindings.map(x=>[x.creatorId,x])).values()].sort((a,b)=>a.creatorId.localeCompare(b.creatorId)),output=[];
  for(let offset=0;offset<input.length;offset+=500) {
    const batch=input.slice(offset,offset+500),samples=[];
    // API readiness admits recovery work; it is not evidence of live capture.
    // Lock the union before taking any session locks, including on a heartbeat
    // where some creators have an API session but no healthy websocket yet.
    const readyIds=batch.filter(entry=>entry.account?.sessionReadReady===true).map(entry=>entry.creatorId);
    for(const entry of batch) {
      const o=entry.account?.observation,at=date(entry.account?.lastWsFrameAt),through=date(o?.capturedThroughAt);
      if(o?.version===1 && o.moneyRevisionVersion!==1){output.push({recorded:false,reason:"money_revision_protocol_required"});continue;}
      if(o?.version!==1 || !entry.account.realtimeHealthy || !at || !through || +at>+now+30000 || +now-at>SAMPLE_MAX_AGE_MS || +through>+at)continue;
      if(!/^[a-f0-9-]{16,80}$/i.test(o.sessionId||"") || !validSequence(o.capturedThroughSeq))throw error("LIVE_CAPTURE_PROTOCOL_INVALID");
      samples.push({creatorId:entry.creatorId,id:key(entry.creatorId,deviceId,o.sessionId),incarnation:o.sessionId,through,seq:o.capturedThroughSeq,
        lossRevision:validSequence(o.lossRevision)?o.lossRevision:o.loss===true?1:0,from:date(o.captureFromAt)});
    }
    const ids=[...new Set([...samples.map(x=>x.creatorId),...readyIds])].sort();
    if(!ids.length)continue;
    await db.$executeRawUnsafe(`INSERT INTO "CreatorLiveSync"("creatorId","agencyId")
      SELECT x,$1 FROM unnest($2::text[]) x ORDER BY x ON CONFLICT("creatorId") DO NOTHING`,agencyId,ids);
    // Lock state before inserting sessions, including first contact after sleep.
    await db.$queryRawUnsafe(`SELECT "creatorId" FROM "CreatorLiveSync" WHERE "agencyId"=$1 AND "creatorId"=ANY($2::text[])
      ORDER BY "creatorId" FOR UPDATE`,agencyId,ids);
    if(samples.length)await db.$executeRawUnsafe(`INSERT INTO "CreatorRealtimeSession"(id,"agencyId","creatorId","deviceId","memberId","accessEpoch",incarnation)
      SELECT x.id,$1,x."creatorId",$2,$3,$4,x.incarnation FROM jsonb_to_recordset($5::jsonb) x(id text,"creatorId" text,incarnation text)
      ORDER BY x."creatorId" ON CONFLICT(id) DO NOTHING`,agencyId,deviceId,memberId,accessEpoch,JSON.stringify(samples));
    const states=samples.length?await db.$queryRawUnsafe(`SELECT l.*,row_to_json(s) AS session,p."throughAt" AS baseline,
      (SELECT min(w."throughAt") FROM "CreatorRecoveryWatermark" w WHERE w."creatorId"=l."creatorId" AND w.stream=ANY($6::text[])
        HAVING count(*)=cardinality($6::text[])) AS "recoveryCoveredThrough",
      (SELECT jsonb_object_agg(q.stream,q."targetAt") FROM (
        SELECT i.stream,max(i."targetAt") AS "targetAt" FROM "CreatorRecoveryIntent" i
        WHERE i."creatorId"=l."creatorId" AND i.status<>'COMPLETE' GROUP BY i.stream) q) AS "recoveryQueuedThrough",
      CASE WHEN s."capturedAt" IS NULL THEN EXISTS(SELECT 1 FROM "CreatorRealtimeSession" old
        WHERE old."creatorId"=l."creatorId" AND old."deviceId"=$4 AND old.id<>s.id AND old."capturedSeq">old."ackedSeq"
        AND old."updatedAt">$5::timestamp-interval '30 days') ELSE false END AS abandoned,
      CASE WHEN s.loss OR l."shortGapFrom" IS NOT NULL THEN EXISTS(SELECT 1 FROM "CreatorRecoveryIntent" i
        WHERE i."creatorId"=l."creatorId" AND i.status<>'COMPLETE') ELSE false END AS pending,
      CASE WHEN s.loss OR l."shortGapFrom" IS NOT NULL THEN (SELECT min(at) FROM (
        SELECT stream,max(at) AS at FROM (
          SELECT stream,"throughAt" AS at FROM "CreatorRecoveryWatermark" WHERE "creatorId"=l."creatorId"
          UNION ALL SELECT stream,"targetAt" FROM "CreatorRecoveryIntent" WHERE "creatorId"=l."creatorId" AND status='COMPLETE'
        ) history GROUP BY stream) completed) ELSE NULL END AS recovered
      FROM "CreatorLiveSync" l JOIN "CreatorRealtimeSession" s ON s.id=ANY($3::text[]) AND s."creatorId"=l."creatorId"
      LEFT JOIN "CreatorEarningsLedgerProof" p ON p."creatorId"=l."creatorId"
      WHERE l."agencyId"=$1 AND l."creatorId"=ANY($2::text[]) ORDER BY l."creatorId"`,agencyId,ids,samples.map(x=>x.id),deviceId,now,STREAMS):[];
    const byId=new Map(states.map(x=>[x.creatorId,x])),writes=[],intents=[],wake=[];
    for(const x of samples) {
      const l=byId.get(x.creatorId),s=l?.session;
      if(!l)throw error("LIVE_SYNC_SCOPE_MISMATCH");
      if(!s || s.memberId!==memberId || s.deviceId!==deviceId || s.accessEpoch>accessEpoch)throw error("LIVE_CAPTURE_SESSION_STALE");
      if(Number(s.capturedSeq)>x.seq || date(s.capturedAt)>x.through || Number(s.lossRevision)>x.lossRevision) {
        output.push({recorded:false,reason:"older_sample"});continue;
      }
      let resolved=Number(s.resolvedLossRevision||0),shortFrom=date(l.shortGapFrom),shortTo=date(l.shortGapTo);
      if(!l.pending && l.recovered) {
        if(s.lossAt && date(s.lossAt)<=l.recovered)resolved=Number(s.lossRevision);
        if(shortFrom && (shortTo||shortFrom)<=l.recovered){shortFrom=null;shortTo=null;}
      }
      const captured=date(l.lastCapturedAt)||date(l.baseline),recoveredThrough=date(l.recoveryCoveredThrough);
      // Provider recovery is interval coverage, not live freshness. It can
      // suppress a repeated old gap when the websocket finally returns, but
      // must never advance lastCapturedAt or lastDeliveredAt by itself.
      const previous=captured&&recoveredThrough?new Date(Math.max(+captured,+recoveredThrough)):captured||recoveredThrough,
        continuous=previous&&x.from&&x.from<=x.through&&+x.from<=+previous+SAMPLE_MAX_AGE_MS;
      const gap=previous&&!continuous?+x.through-previous:0,longGap=previous&&gap>=OFFLINE_GAP_MS;
      const captureLoss=x.lossRevision>Number(s.lossRevision)||l.abandoned,delivered=Number(s.ackedSeq)>=x.seq;
      if(longGap||captureLoss) {
        const reason=captureLoss?"CAPTURE_LOSS":"OFFLINE_GAP";
        for(const stream of STREAMS) {
          const queued=date(l.recoveryQueuedThrough?.[stream]);
          const from=!captureLoss&&queued&&queued>(previous||x.through)?queued:previous||x.through;
          if(!captureLoss&&queued&&+x.through-from<OFFLINE_GAP_MS) {
            // An API-only heartbeat may have already queued this interval.
            // Preserve that immutable target. A later, uncovered short tail
            // remains explicit debt until proof covers it; it is not capture.
            if(+x.through-from>SAMPLE_MAX_AGE_MS) {
              shortFrom=!shortFrom||from<shortFrom?from:shortFrom;
              shortTo=!shortTo||x.through>shortTo?x.through:shortTo;
            }
            continue;
          }
          const recoveryKey=key(x.creatorId,from.toISOString(),x.through.toISOString(),reason);
          intents.push({id:key(recoveryKey,stream),creatorId:x.creatorId,stream,reason,from,through:x.through});
          wake.push(x.creatorId);
        }
      }
      if(previous&&gap>SAMPLE_MAX_AGE_MS&&!longGap){shortFrom=!shortFrom||previous<shortFrom?previous:shortFrom;shortTo=!shortTo||x.through>shortTo?x.through:shortTo;}
      const changed=!s.capturedAt||s.retiredAt||Number(s.capturedSeq)!==x.seq||x.lossRevision!==Number(s.lossRevision)
        ||resolved!==Number(s.resolvedLossRevision)||String(shortFrom)!==String(date(l.shortGapFrom))||longGap||captureLoss||+now-date(s.updatedAt)>=60000;
      if(changed)writes.push({...x,resolved,shortFrom,shortTo,delivered,loss:x.lossRevision>resolved,
        lossAt:x.lossRevision>Number(s.lossRevision)?x.through:date(s.lossAt)});
      output.push({recorded:true,coalesced:!changed,recoveryRequired:Boolean(longGap||captureLoss),delivered});
    }
    if(writes.length) {
      const json=JSON.stringify(writes);
      await db.$executeRawUnsafe(`UPDATE "CreatorRealtimeSession" s SET "capturedSeq"=x.seq,"capturedAt"=x.through,loss=x.loss,
        "lossAt"=x."lossAt","lossRevision"=x."lossRevision","resolvedLossRevision"=x.resolved,"updatedAt"=$2,"retiredAt"=NULL
        FROM jsonb_to_recordset($1::jsonb) x(id text,seq bigint,through timestamp,loss boolean,"lossAt" timestamp,"lossRevision" int,resolved int) WHERE s.id=x.id`,json,now);
      await db.$executeRawUnsafe(`UPDATE "CreatorLiveSync" l SET "lastCapturedAt"=GREATEST(l."lastCapturedAt",x.through),
        "lastDeliveredAt"=CASE WHEN x.delivered THEN GREATEST(l."lastDeliveredAt",x.through) ELSE l."lastDeliveredAt" END,
        "shortGapFrom"=x."shortFrom","shortGapTo"=x."shortTo","updatedAt"=$2
        FROM jsonb_to_recordset($1::jsonb) x("creatorId" text,through timestamp,delivered boolean,"shortFrom" timestamp,"shortTo" timestamp)
        WHERE l."creatorId"=x."creatorId"`,json,now);
    }
    if(readyIds.length) {
      // Evaluate after capture writes: another receiver or a continuous local
      // journal may already cover the apparent disconnect. Only a real,
      // uncovered interval creates debt. A running traversal has a frozen
      // target; repeated heartbeats must not move it or multiply its jobs.
      // Completed watermarks survive intent retention and service restarts.
      // A proved short interruption also needs eventual repair: fresh later
      // capture cannot erase it. After one hour of age repair its fixed end,
      // rather than turning continuous healthy capture into recurring scans.
      const gaps=await db.$queryRawUnsafe(`/* api_ready_recovery_debt_v1 */
        SELECT l."creatorId",s.stream,g."gapFrom",
          CASE WHEN c."coveredAt"<=($4::timestamptz AT TIME ZONE 'UTC')-($5::bigint*interval '1 millisecond')
            THEN ($4::timestamptz AT TIME ZONE 'UTC') ELSE l."shortGapTo" END AS "targetAt"
        FROM "CreatorLiveSync" l CROSS JOIN unnest($3::text[]) s(stream)
        LEFT JOIN "CreatorEarningsLedgerProof" p ON p."creatorId"=l."creatorId" AND p."agencyId"=l."agencyId"
        LEFT JOIN "CreatorRecoveryWatermark" w ON w."creatorId"=l."creatorId" AND w.stream=s.stream
        CROSS JOIN LATERAL (SELECT GREATEST(COALESCE(l."lastCapturedAt",p."throughAt"),w."throughAt") AS "coveredAt") c
        CROSS JOIN LATERAL (SELECT LEAST(c."coveredAt",CASE WHEN l."shortGapTo">COALESCE(
          GREATEST(w."throughAt",CASE WHEN s.stream='financial' THEN p."throughAt" END),'-infinity'::timestamp)
          THEN GREATEST(l."shortGapFrom",w."throughAt",CASE WHEN s.stream='financial' THEN p."throughAt" END)
          END) AS "gapFrom") g
        WHERE l."agencyId"=$1 AND l."creatorId"=ANY($2::text[])
          AND g."gapFrom"<=($4::timestamptz AT TIME ZONE 'UTC')-($5::bigint*interval '1 millisecond')
          AND NOT EXISTS(SELECT 1 FROM "CreatorRecoveryIntent" i WHERE i."creatorId"=l."creatorId"
            AND i.stream=s.stream AND i.status<>'COMPLETE')
        ORDER BY l."creatorId",s.stream`,agencyId,readyIds,STREAMS,now,OFFLINE_GAP_MS);
      for(const gap of gaps) {
        const from=date(gap.gapFrom),through=date(gap.targetAt),reason="OFFLINE_GAP";
        intents.push({id:key(key(gap.creatorId,from.toISOString(),through.toISOString(),reason),gap.stream),
          creatorId:gap.creatorId,stream:gap.stream,reason,from,through});
        wake.push(gap.creatorId);
      }
    }
    if(intents.length) {
      await db.$executeRawUnsafe(`INSERT INTO "CreatorRecoveryIntent"(id,"agencyId","creatorId",stream,reason,"gapFrom","targetAt","policyVersion")
        SELECT x.id,$1,x."creatorId",x.stream,x.reason,x."from",x.through,$3 FROM jsonb_to_recordset($2::jsonb)
        x(id text,"creatorId" text,stream text,reason text,"from" timestamp,through timestamp) ORDER BY x."creatorId",x.stream ON CONFLICT(id) DO NOTHING`,agencyId,JSON.stringify(intents),POLICY_VERSION);
      await require("./domain-work-authority-service").publishDomainWorkBatch({db,items:[...new Set(wake)].map(creatorId=>({agencyId,creatorId,
        workClass:"CREATOR_RECURRING_PLANNING",objectType:"CreatorAccount",objectId:creatorId,partitionKey:creatorId}))});
    }
    if(writes.length) await require("./earnings-coverage-service").advanceDelivered(db,writes.map(x=>x.creatorId));
  }
  return output;
}

async function acceptDelivery({
  db,
  agencyId,
  creatorId,
  deviceId,
  memberId,
  accessEpoch,
  delivery,
  events,
  now,
  ingest,
}) {
  if (
    delivery?.version !== 1 ||
    !Array.isArray(delivery.entries) ||
    delivery.entries.length !== events.length ||
    !events.length
  )
    throw error("LIVE_DELIVERY_PROTOCOL_INVALID");
  const entries = delivery.entries;
  if (
    entries.some(
      (e, i) =>
        !validSequence(e.seq) ||
        e.seq < 1 ||
        !date(e.capturedAt) ||
        +date(e.capturedAt) > +now + 30_000 ||
        (i && e.seq !== entries[i - 1].seq + 1)
    )
  )
    throw error("LIVE_DELIVERY_SEQUENCE_INVALID");
  await ensureState(db, agencyId, creatorId);
  const s = await session(db, {
    agencyId,
    creatorId,
    deviceId,
    memberId,
    accessEpoch,
    observation: { version: 1, sessionId: delivery.sessionId, capturedThroughSeq: entries.at(-1).seq },
  });
  let ack = Number(s.ackedSeq);
  let retiredReplay = false;
  let newEntries = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i],
      digest = key(events[i], new Date(e.capturedAt).toISOString());
    const [existing] = await db.$queryRawUnsafe(
      'SELECT digest FROM "CreatorRealtimeReceipt" WHERE "sessionId"=$1 AND seq=$2',
      s.id,
      e.seq
    );
    if (existing && existing.digest !== digest) throw error("LIVE_DELIVERY_PAYLOAD_CONFLICT");
    if (!existing && e.seq <= Number(s.ackedSeq)) {
      retiredReplay = true;
      continue;
    }
    if (!existing && e.seq !== ack + 1) throw error("LIVE_DELIVERY_GAP");
    if (!existing) {
      await db.$executeRawUnsafe(
        'INSERT INTO "CreatorRealtimeReceipt"("sessionId",seq,digest,"capturedAt") VALUES($1,$2,$3,$4)',
        s.id,
        e.seq,
        digest,
        new Date(e.capturedAt)
      );
      ack = e.seq;
      newEntries++;
    }
  }
  // Facts, their durable projection signals and the contiguous ACK commit as one.
  if (retiredReplay && entries.at(-1).seq > Number(s.ackedSeq)) throw error("LIVE_DELIVERY_REPLAY_BOUNDARY");
  const results = retiredReplay || !newEntries ? [] : await ingest();
  await db.$executeRawUnsafe(
    `DELETE FROM "CreatorRealtimeReceipt" WHERE "sessionId"=$1 AND seq IN (
    SELECT seq FROM "CreatorRealtimeReceipt" WHERE "sessionId"=$1 AND seq<$2 AND "capturedAt"<$3 ORDER BY seq LIMIT 100)`,
    s.id,
    ack - 5000,
    new Date(+now - 30 * 86400000)
  );
  await db.$executeRawUnsafe(
    'UPDATE "CreatorRealtimeSession" SET "ackedSeq"=$2,"updatedAt"=$3 WHERE id=$1',
    s.id,
    ack,
    now
  );
  if (ack >= Number(s.capturedSeq) && s.capturedAt) {
    await db.$executeRawUnsafe(
      'UPDATE "CreatorLiveSync" SET "lastDeliveredAt"=GREATEST("lastDeliveredAt",$2),"updatedAt"=$3 WHERE "creatorId"=$1',
      creatorId,
      s.capturedAt,
      now
    );
  }
  await require("./earnings-coverage-service").advanceDelivered(db,[creatorId]);
  return { results, deliveryAck: { version: 1, sessionId: delivery.sessionId, throughSeq: ack } };
}

async function pendingRecovery(db, creatorId, stream) {
  const rows = await db.$queryRawUnsafe(
    `SELECT * FROM "CreatorRecoveryIntent" WHERE "creatorId"=$1 AND stream=$2 AND status IN ('PENDING','RUNNING') ORDER BY "targetAt",id LIMIT 1`,
    creatorId,
    stream
  );
  return rows[0] || null;
}
function recoveryParams(intent) {
  return {
    syncPolicyVersion: POLICY_VERSION,
    recoveryIntentId: intent.id,
    recoveryTargetAt: new Date(intent.targetAt).toISOString(),
    collectionReason: intent.reason,
    reason: intent.reason,
  };
}
async function bindRecovery(db, intent, jobId) {
  if (!jobId) return;
  await db.$executeRawUnsafe(
    `UPDATE "CreatorRecoveryIntent" SET "jobId"=$2,status='RUNNING',"updatedAt"=clock_timestamp() WHERE id=$1 AND status<>'COMPLETE'`,
    intent.id,
    jobId
  );
}
async function completeRecovery(db, job, successful, { deferPlanningWake = false } = {}) {
  const id = job.params?.recoveryIntentId;
  if (!successful) return;
  const stream = JOB_STREAM[job.jobKey];
  if (!id) {
    if (
      job.jobKey === "financial_transactions_scan" &&
      job.params?.collectionMode === "full" &&
      job.params?.earningsLedgerVersion === 1
    ) {
      await db.$executeRawUnsafe(
        `UPDATE "CreatorRecoveryIntent" SET status='COMPLETE',"completedAt"=clock_timestamp(),"updatedAt"=clock_timestamp()
        WHERE "creatorId"=$1 AND stream='financial' AND status<>'COMPLETE' AND "targetAt"<=$2`,
        job.creatorId,
        new Date(job.params.collectionRequestedAt)
      );
      await compactRecoveryAuthority(db, job.creatorId);
      await wakeRemainingRecovery(db, job, { deferPlanningWake });
    }
    return;
  }
  const rows = await db.$queryRawUnsafe(
    `UPDATE "CreatorRecoveryIntent" SET status='COMPLETE',"completedAt"=clock_timestamp(),"updatedAt"=clock_timestamp()
    WHERE id=$1 AND "agencyId"=$2 AND "creatorId"=$3 AND stream=$4 AND "jobId"=$5 AND "policyVersion"=$6 RETURNING "targetAt"`,
    id,
    job.agencyId,
    job.creatorId,
    stream,
    job.id,
    POLICY_VERSION
  );
  if (!rows.length) throw error("LIVE_RECOVERY_COMPLETION_SCOPE_MISMATCH");
  // Coalesce only unstarted debt covered by this exact published traversal.
  await db.$executeRawUnsafe(
    `UPDATE "CreatorRecoveryIntent" SET status='COMPLETE',"completedAt"=clock_timestamp(),"updatedAt"=clock_timestamp()
    WHERE "creatorId"=$1 AND stream=$2 AND status='PENDING' AND "targetAt"<=$3`,
    job.creatorId,
    stream,
    rows[0].targetAt
  );
  await compactRecoveryAuthority(db, job.creatorId);
  await wakeRemainingRecovery(db, job, { deferPlanningWake });
}

async function wakeRemainingRecovery(db, job, { deferPlanningWake = false } = {}) {
  // A newer gap may have arrived while the old collector was still running.
  // Its completion wakes the creator directly instead of relying on a sweep.
  const pending=await db.$queryRawUnsafe(`SELECT 1 FROM "CreatorRecoveryIntent"
    WHERE "creatorId"=$1 AND status='PENDING' LIMIT 1`,job.creatorId);
  if (pending.length && deferPlanningWake) {
    await require("./subscriber-directory-maintenance-signal-service").signalSubscriberDirectoryMaintenance({
      db, agencyId: job.agencyId, creatorId: job.creatorId, kind: "DERIVED_PLANNING", reason: "REMAINING_RECOVERY_DEBT",
    });
    return;
  }
  if(pending.length) await require("./domain-work-authority-service").publishDomainWork({
    db,agencyId:job.agencyId,creatorId:job.creatorId,workClass:"CREATOR_RECURRING_PLANNING",
    objectType:"CreatorAccount",objectId:job.creatorId,partitionKey:job.creatorId,
  });
}

async function compactRecoveryAuthority(db, creatorId) {
  await db.$executeRawUnsafe(`INSERT INTO "CreatorRecoveryWatermark"("creatorId",stream,"throughAt")
    SELECT "creatorId",stream,max("targetAt") FROM "CreatorRecoveryIntent" WHERE "creatorId"=$1 AND status='COMPLETE'
    GROUP BY "creatorId",stream ON CONFLICT("creatorId",stream) DO UPDATE SET
    "throughAt"=GREATEST("CreatorRecoveryWatermark"."throughAt",EXCLUDED."throughAt")`,creatorId);
}

module.exports = {
  POLICY_VERSION,
  OFFLINE_GAP_MS,
  STREAMS,
  JOB_STREAM,
  isAutomaticReason,
  automaticJob,
  admitsJob,
  recordCaptureSample,
  recordCaptureSamples,
  acceptDelivery,
  pendingRecovery,
  recoveryParams,
  bindRecovery,
  completeRecovery,
};

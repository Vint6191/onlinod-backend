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
    const samples=[];
    for(const entry of input.slice(offset,offset+500)) {
      const o=entry.account?.observation,at=date(entry.account?.lastWsFrameAt),through=date(o?.capturedThroughAt);
      if(o?.version===1 && o.moneyRevisionVersion!==1){output.push({recorded:false,reason:"money_revision_protocol_required"});continue;}
      if(o?.version!==1 || !entry.account.realtimeHealthy || !at || !through || +at>+now+30000 || +now-at>SAMPLE_MAX_AGE_MS || +through>+at)continue;
      if(!/^[a-f0-9-]{16,80}$/i.test(o.sessionId||"") || !validSequence(o.capturedThroughSeq))throw error("LIVE_CAPTURE_PROTOCOL_INVALID");
      samples.push({creatorId:entry.creatorId,id:key(entry.creatorId,deviceId,o.sessionId),incarnation:o.sessionId,through,seq:o.capturedThroughSeq,
        lossRevision:validSequence(o.lossRevision)?o.lossRevision:o.loss===true?1:0,from:date(o.captureFromAt)});
    }
    if(!samples.length)continue;
    const ids=samples.map(x=>x.creatorId);
    await db.$executeRawUnsafe(`INSERT INTO "CreatorLiveSync"("creatorId","agencyId")
      SELECT x,$1 FROM unnest($2::text[]) x ORDER BY x ON CONFLICT("creatorId") DO NOTHING`,agencyId,ids);
    // Lock state before inserting sessions, including first contact after sleep.
    await db.$queryRawUnsafe(`SELECT "creatorId" FROM "CreatorLiveSync" WHERE "agencyId"=$1 AND "creatorId"=ANY($2::text[])
      ORDER BY "creatorId" FOR UPDATE`,agencyId,ids);
    await db.$executeRawUnsafe(`INSERT INTO "CreatorRealtimeSession"(id,"agencyId","creatorId","deviceId","memberId","accessEpoch",incarnation)
      SELECT x.id,$1,x."creatorId",$2,$3,$4,x.incarnation FROM jsonb_to_recordset($5::jsonb) x(id text,"creatorId" text,incarnation text)
      ORDER BY x."creatorId" ON CONFLICT(id) DO NOTHING`,agencyId,deviceId,memberId,accessEpoch,JSON.stringify(samples));
    const states=await db.$queryRawUnsafe(`SELECT l.*,row_to_json(s) AS session,p."throughAt" AS baseline,
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
      WHERE l."agencyId"=$1 AND l."creatorId"=ANY($2::text[]) ORDER BY l."creatorId"`,agencyId,ids,samples.map(x=>x.id),deviceId,now);
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
      const previous=date(l.lastCapturedAt)||date(l.baseline),continuous=previous&&x.from&&x.from<=x.through&&+x.from<=+previous+SAMPLE_MAX_AGE_MS;
      const gap=previous&&!continuous?+x.through-previous:0,longGap=previous&&gap>=OFFLINE_GAP_MS;
      const captureLoss=x.lossRevision>Number(s.lossRevision)||l.abandoned,delivered=Number(s.ackedSeq)>=x.seq;
      if(longGap||captureLoss) {
        const from=previous||x.through,reason=captureLoss?"CAPTURE_LOSS":"OFFLINE_GAP",recoveryKey=key(x.creatorId,from.toISOString(),x.through.toISOString(),reason);
        for(const stream of STREAMS)intents.push({id:key(recoveryKey,stream),creatorId:x.creatorId,stream,reason,from,through:x.through});
        wake.push(x.creatorId);
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
    if(intents.length) {
      await db.$executeRawUnsafe(`INSERT INTO "CreatorRecoveryIntent"(id,"agencyId","creatorId",stream,reason,"gapFrom","targetAt","policyVersion")
        SELECT x.id,$1,x."creatorId",x.stream,x.reason,x."from",x.through,$3 FROM jsonb_to_recordset($2::jsonb)
        x(id text,"creatorId" text,stream text,reason text,"from" timestamp,through timestamp) ORDER BY x."creatorId",x.stream ON CONFLICT(id) DO NOTHING`,agencyId,JSON.stringify(intents),POLICY_VERSION);
      await require("./domain-work-authority-service").publishDomainWorkBatch({db,items:wake.map(creatorId=>({agencyId,creatorId,
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
    `SELECT * FROM "CreatorRecoveryIntent" WHERE "creatorId"=$1 AND stream=$2 AND status<>'COMPLETE' ORDER BY "targetAt",id LIMIT 1`,
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
async function completeRecovery(db, job, successful) {
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
      await wakeRemainingRecovery(db, job);
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
  await wakeRemainingRecovery(db, job);
}

async function wakeRemainingRecovery(db, job) {
  // A newer gap may have arrived while the old collector was still running.
  // Its completion wakes the creator directly instead of relying on a sweep.
  const pending=await db.$queryRawUnsafe(`SELECT 1 FROM "CreatorRecoveryIntent"
    WHERE "creatorId"=$1 AND status='PENDING' LIMIT 1`,job.creatorId);
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

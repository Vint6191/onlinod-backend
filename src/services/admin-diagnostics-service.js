"use strict";
const { runRootCommit } = require("./db-commit-kernel");
// Rebuildable rolling observation, not a transaction-wide historical snapshot.
// Each durable step reads <=500 rows and <=2 indexed duplicate candidates per row.
const KEY = "admin.diagnostics.v1", BATCH = 500, STEP_MS = 5000, CYCLE_MS = 60000;
const LANES = ["AutomationDelivery", "CrmProfile", "CrmProfileRawTag"];
const SPECS = [
  ["delivery_clones", "Deliveries sharing a message ID", "warn"],
  ["stuck_bumps", "Stuck bumps (>3d, unresolved)", "warn"],
  ["untagged_profiles", "CRM profiles without tags", "info"],
  ["raw_tags_review", "Raw tags needing review", "info"],
  ["deliveries_no_messageid", "In-flight deliveries without messageId", "warn"],
];
const DELIVERY_PAGE_SQL = `WITH page AS MATERIALIZED (
  SELECT "id","agencyId","creatorId","messageId","status","sentAt","createdAt"
  FROM "AutomationDelivery" WHERE "id">$1 AND "id"<=$2 ORDER BY "id" LIMIT $3
) SELECT p.*, CASE WHEN p."messageId" IS NULL THEN false ELSE
  (SELECT count(*)>1 FROM (SELECT 1 FROM "AutomationDelivery" d
    WHERE d."creatorId"=p."creatorId" AND d."messageId"=p."messageId" LIMIT 2) candidates)
  END AS duplicate FROM page p ORDER BY p."id"`;
const PROFILE_PAGE_SQL = `WITH page AS MATERIALIZED (
  SELECT "id" FROM "CrmProfile" WHERE "id">$1 AND "id"<=$2 ORDER BY "id" LIMIT $3
) SELECT p."id", (SELECT t."id" FROM "CrmProfileTag" t WHERE t."profileId"=p."id" LIMIT 1) IS NOT NULL AS tagged FROM page p ORDER BY p."id"`;
function newRun(now) {
  return { startedAt: now.toISOString(), lane: 0, cursor: "", upper: null, scanned: 0,
    counts: Object.fromEntries(SPECS.map(([key]) => [key, 0])), sample: [] };
}
async function diagnosticsStep({ db }) {
  return runRootCommit(db, async ({ tx }) => {
    // Skewed creator/message or profile/tag statistics can make PostgreSQL
    // choose a whole-table scan for a LIMIT 1/2 probe. These maintenance lanes
    // deliberately use their existing PK/identity indexes even under that skew.
    await tx.$executeRawUnsafe("SET LOCAL enable_seqscan=off");
    await tx.$executeRawUnsafe(`INSERT INTO "SystemSetting" ("id","key","value","updatedAt")
      VALUES ($1,$1,'{}'::jsonb,now()) ON CONFLICT ("key") DO NOTHING`, KEY);
    const rows = await tx.$queryRawUnsafe(`SELECT "value",clock_timestamp() AT TIME ZONE 'UTC' AS now
      FROM "SystemSetting" WHERE "key"=$1 FOR UPDATE SKIP LOCKED`, KEY);
    if (!rows.length) return { skipped: "busy" };
    const now = rows[0].now, state = rows[0].value || {};
    if (state.nextAt && new Date(state.nextAt)>now) return { skipped: "not_due" };
    const run = state.run || newRun(now), table = LANES[run.lane];
    if (!table) throw Error("ADMIN_DIAGNOSTICS_INVALID_LANE");
    if (run.upper === null) {
      const last = await tx.$queryRawUnsafe(`SELECT "id" FROM "${table}" ORDER BY "id" DESC LIMIT 1`);
      run.upper = last[0]?.id || "";
    }
    let page;
    if (run.lane === 0) page = await tx.$queryRawUnsafe(DELIVERY_PAGE_SQL, run.cursor, run.upper, BATCH);
    else if (run.lane === 1) page = await tx.$queryRawUnsafe(PROFILE_PAGE_SQL, run.cursor, run.upper, BATCH);
    else page = await tx.$queryRawUnsafe(`SELECT "id","status" FROM "CrmProfileRawTag"
      WHERE "id">$1 AND "id"<=$2 ORDER BY "id" LIMIT $3`, run.cursor, run.upper, BATCH);
    const cutoff = new Date(run.startedAt).getTime()-3*86400000;
    for (const row of page) {
      if (run.lane === 0) {
        if (row.duplicate) {
          run.counts.delivery_clones++;
          if (run.sample.length<10) run.sample.push({ id:row.id, agencyId:row.agencyId, creatorId:row.creatorId, messageId:row.messageId });
        }
        if (["pending_reply","checking_reply"].includes(row.status) && new Date(row.sentAt || row.createdAt).getTime()<cutoff) run.counts.stuck_bumps++;
        if (!row.messageId && ["pending_reply","checking_reply","sent"].includes(row.status)) run.counts.deliveries_no_messageid++;
      } else if (run.lane === 1 && !row.tagged) run.counts.untagged_profiles++;
      else if (run.lane === 2 && row.status === "needs_review") run.counts.raw_tags_review++;
    }
    run.scanned += page.length;
    if (page.length) run.cursor = page[page.length-1].id;
    if (page.length < BATCH || run.cursor === run.upper) { run.lane++; run.cursor=""; run.upper=null; }
    const complete = run.lane === LANES.length;
    const next = { ...state, run: complete ? null : run, nextAt: new Date(now.getTime()+(complete?CYCLE_MS:STEP_MS)).toISOString(),
      ...(complete ? { completed: { ...run, completedAt:now.toISOString() } } : {}) };
    await tx.$executeRawUnsafe(`UPDATE "SystemSetting" SET "value"=$2::jsonb,"updatedAt"=clock_timestamp() WHERE "key"=$1`, KEY, JSON.stringify(next));
    return { processed:page.length, complete, lane:table };
  }, { profile: "ADMIN_DIAGNOSTICS", authority: { kind: "ADMIN_DIAGNOSTICS" } });
}
async function readDiagnostics({ db }) {
  const rows=await db.$queryRawUnsafe(`SELECT "value",clock_timestamp() AT TIME ZONE 'UTC' AS now FROM "SystemSetting" WHERE "key"=$1`,KEY);
  const state=rows[0]?.value || {}, done=state.completed, progress=state.run;
  const age=done ? Math.max(0,rows[0].now.getTime()-Date.parse(done.completedAt)) : null;
  return { ok:true, checkedAt:done?.completedAt || null,
    coverage: { status:!done?"BUILDING":age>300000?"STALE":"AVAILABLE", mode:"ROLLING_OBSERVATION",
      observationFrom:done?.startedAt || null, observationTo:done?.completedAt || null,
      scannedRows:done?.scanned || 0, rebuilding:!!progress, progressRows:progress?.scanned || 0, ageMs:age },
    anomalies:SPECS.map(([key,title,level])=>({key,title,level:done?(done.counts[key]>0?level:"ok"):"info",
      count:done?done.counts[key]:null, detail:done?`${done.counts[key]} rows observed during the completed pass`:"Initial check is in progress; no complete result yet",
      ...(key==="delivery_clones"?{sample:done?.sample || []}:{})})) };
}
function startAdminDiagnostics({ db, log }) {
  let running=false, stopped=false;
  const tick=async()=>{ if(running || stopped)return;running=true;try{await diagnosticsStep({db});}catch(err){log.warn("admin diagnostics step failed",{error:String(err?.message || err)});}finally{running=false;} };
  const timer=setInterval(tick,STEP_MS);timer.unref?.();void tick();
  return ()=>{stopped=true;clearInterval(timer);};
}
module.exports={KEY,BATCH,DELIVERY_PAGE_SQL,PROFILE_PAGE_SQL,diagnosticsStep,readDiagnostics,startAdminDiagnostics};

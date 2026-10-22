"use strict";
const assert = require("node:assert/strict");
const { createScaleSqlRuntime } = require("../test-support/scale-sql-runtime.cjs");
const { scope } = require("./analytics-traffic/fixture.cjs");
const { selectClaimCandidate, MAX_PRIORITY_WAIT_MS } = require("../../src/services/job-claim-fairness-service");
const keep = setInterval(() => {}, 1000);
(async () => {
 const runtime = await createScaleSqlRuntime();
 try {
  const {db} = runtime;
  const own = await scope(db,{agencyId:"fair-agency",creatorId:"fair-creator",userId:"fair-user"});
  const other = await scope(db,{agencyId:"other-agency",creatorId:"other-creator",userId:"other-user"});
  const now = new Date(), old = new Date(+now - MAX_PRIORITY_WAIT_MS - 10_000);
  const job = (id,jobKey,priority,nextRunAt=old,s=own) => ({id,agencyId:s.agencyId,creatorId:s.creatorId,scope:"CREATOR",status:"SCHEDULED",jobKey,priority,nextRunAt});
  await db.jobInstance.createMany({data:[job("financial","financial_transactions_scan",20),job("fan","fan_data_point_refresh",98,new Date(+old+1)),job("foreign","financial_transactions_scan",200,new Date(0),other)]});
  const where = {creatorId:own.creatorId,status:"SCHEDULED",nextRunAt:{lte:now},attempts:{lt:5}};
  const select = () => selectClaimCandidate({db,where,now});
  assert.equal((await select()).id,"financial");
  console.log("PASS overdue low-priority financial work is admitted before newer FanData, with tenant scope intact");
  await db.jobInstance.update({where:{id:"financial"},data:{nextRunAt:new Date(+now+1000)}});
  assert.equal((await select()).id,"fan");
  await db.$disconnect();
  assert.equal((await select()).id,"fan");
  console.log("PASS a yielded quantum joins the queue tail and a new connection preserves admission order");
  await db.jobInstance.update({where:{id:"financial"},data:{nextRunAt:now,priority:95}});
  await db.jobInstance.update({where:{id:"fan"},data:{nextRunAt:now,priority:85}});
  assert.equal((await select()).id,"financial");
  console.log("PASS initial financial priority applies inside the bounded fresh-work interval");
  const history = Array.from({length:5000},(_,i)=>({...job("history-"+i,"fan_data_point_refresh",100,new Date(0)),status:"DONE",completedAt:new Date(0)}));
  for(let i=0;i<history.length;i+=500) await db.jobInstance.createMany({data:history.slice(i,i+500)});
  await db.$executeRawUnsafe('ANALYZE "JobInstance"');
  await db.jobInstance.update({where:{id:"financial"},data:{nextRunAt:old,priority:20}});
  assert.equal((await select()).id,"financial");
  const rows = await db.$queryRawUnsafe(`EXPLAIN (ANALYZE, FORMAT JSON) SELECT id FROM "JobInstance"
   WHERE "creatorId"=$1 AND status='SCHEDULED' AND "nextRunAt"<=$2 AND attempts<5
   ORDER BY "nextRunAt",priority DESC,id LIMIT 1`,own.creatorId,old);
  const plan=rows[0]["QUERY PLAN"], rendered=JSON.stringify(plan);
  assert.match(rendered,/Index Scan|Index Only Scan/);
  assert.match(rendered,/JobInstance_creator_due_fair_idx|JobInstance_due_fair_idx/);
  console.log("PASS old terminal history is excluded by the indexed ready-queue lookup",JSON.stringify({terminalRows:5000,nativePostgres:runtime.native===true}));
 } finally { await runtime.close(); }
})().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>clearInterval(keep));

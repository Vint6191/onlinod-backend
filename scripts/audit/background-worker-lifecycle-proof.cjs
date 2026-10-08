"use strict";
// Disposable SQL + actual production services. Independent native PostgreSQL
// connections and provider execution are explicitly outside this proof.
const assert = require("node:assert/strict"), crypto = require("node:crypto"), fs = require("node:fs");
async function main() {
  const fixture = await require("../test-support/admin-sql-runtime.cjs").createAdminSqlRuntime({ runtimePath: process.env.BACKGROUND_PROOF_RUNTIME });
  const { db } = fixture, cases = [];
  require.cache[require.resolve("../../src/prisma")] = { exports: db };
  const check = async (name, run) => { await run(); cases.push({name,status:"PASS"}); console.log(JSON.stringify(cases.at(-1))); };
  try {
    await db.$executeRawUnsafe(`UPDATE "Phase2ReleaseCompatibilityAuthority" SET "activationState"='ACTIVE' WHERE "scope"='TEAM_CONTROL_PLANE'`);
    // Match the explicit current executor activation in the disposable fixture;
    // no production release state is read or changed by this script.
    const { DOMAIN_WORK_EXECUTOR_GENERATION } = require("../../src/services/phase2-release-compatibility-authority-service");
    await db.$executeRawUnsafe(`UPDATE "Phase2ReleaseCompatibilityAuthority" SET "requiredGeneration"=$1,"activationState"='ACTIVE' WHERE "scope"='DOMAIN_WORK_EXECUTOR'`,DOMAIN_WORK_EXECUTOR_GENERATION);
    const { runRootCommit } = require("../../src/services/db-commit-kernel");
    const job = require("../../src/services/job-lease-service"), actions = require("../../src/services/automation-action-delivery-service");
    const work = require("../../src/services/domain-work-authority-service"), lane = require("../../src/services/maintenance-work-authority");
    const clock = async () => (await db.$queryRawUnsafe('SELECT clock_timestamp() AS "now"'))[0].now;
    const scope = await db.$transaction(async tx => {
      await tx.$executeRawUnsafe("SELECT set_config('onlinod.phase2_team_control_plane_generation',$1,true)","phase2_team_control_plane_v2_durable_access");
      const user=await tx.user.create({data:{email:"worker-lifecycle@example.test",passwordHash:"fixture"}});
      const agency=await tx.agency.create({data:{name:"Lifecycle proof",trialEndsAt:new Date(Date.now()+86400000)}});
      const member=await tx.agencyMember.create({data:{agencyId:agency.id,userId:user.id,role:"OWNER",roleKey:"owner",assignedCreators:"all"}});
      const creator=await tx.creatorAccount.create({data:{agencyId:agency.id,displayName:"Fixture",status:"READY"}});
      const device=await tx.workerDevice.create({data:{agencyId:agency.id,userId:user.id}});
      return {user,agency,member,creator,device};
    });
    const token="worker-lifecycle-exact-token", hash=crypto.createHash("sha256").update(token).digest("hex");
    const leaseInput=row=>({userId:scope.user.id,deviceId:scope.device.id,leaseToken:token,leaseRevision:row.leaseRevision});
    async function seedJob() {
      const now=await clock();
      return runRootCommit(db,({tx})=>tx.jobInstance.create({data:{agencyId:scope.agency.id,creatorId:scope.creator.id,jobKey:"fan_data_point_refresh",scope:"creator",status:"CLAIMED",
        claimedByDeviceId:scope.device.id,leaseTokenHash:hash,leaseRevision:1,leaseMemberId:scope.member.id,leaseAccessEpoch:scope.member.accessEpoch,
        leaseUntil:new Date(+now+60000),attempts:2,continuation:{driverPhase:"execute",jobContinuation:{page:3}},params:{observationReadLeaseVersion:1}}}),{profile:"JOB_CHUNK"});
    }
    await check("late read claim release preserves progress and retry budget, revokes its read lease",async()=>{
      const row=await seedJob(),input={...leaseInput(row),jobId:row.id};
      await job.acquireJobFanObservationReadLease({...input,purpose:"fan_data_point_refresh",requestId:"late-read"});
      await db.jobInstance.update({where:{id:row.id},data:{leaseUntil:new Date(0)}});
      await job.releaseJob({...input,reason:"worker stopped"});
      const saved=await db.jobInstance.findUnique({where:{id:row.id}});
      assert.equal(saved.status,"SCHEDULED");assert.equal(saved.attempts,2);assert.deepEqual(saved.continuation,row.continuation);
      assert.equal(await db.fanObservationReadLease.count({where:{jobId:row.id}}),0);
      await assert.rejects(job.renewLease({...input,leaseMs:60000}),{code:"JOB_NOT_CLAIMED"});
    });
    await check("old read owner cannot release or acknowledge the replacement claim",async()=>{
      const row=await seedJob(),input={...leaseInput(row),jobId:row.id};
      await runRootCommit(db,({tx})=>tx.jobInstance.update({where:{id:row.id},data:{leaseTokenHash:"replacement",leaseRevision:2}}),{profile:"JOB_CHUNK"});
      const before=await db.jobInstance.findUnique({where:{id:row.id}});
      for(const method of ["releaseJob","renewLease","completeJob","failJob"]) await assert.rejects(job[method](input),{code:"JOB_LEASE_STALE"});
      assert.deepEqual(await db.jobInstance.findUnique({where:{id:row.id}}),before);
    });
    await check("read release and read-lease cleanup roll back together",async()=>{
      const row=await seedJob(),input={...leaseInput(row),jobId:row.id};
      await job.acquireJobFanObservationReadLease({...input,purpose:"fan_data_point_refresh",requestId:"rollback-read"});
      await db.$executeRawUnsafe(`CREATE FUNCTION lifecycle_delete_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'LIFECYCLE_ROLLBACK'; END $$`);
      await db.$executeRawUnsafe(`CREATE TRIGGER lifecycle_delete_fault BEFORE DELETE ON "FanObservationReadLease" FOR EACH ROW EXECUTE FUNCTION lifecycle_delete_fault()`);
      try { await assert.rejects(job.releaseJob({...input,reason:"stop"}),/LIFECYCLE_ROLLBACK/); }
      finally { await db.$executeRawUnsafe('DROP TRIGGER lifecycle_delete_fault ON "FanObservationReadLease"'); }
      assert.equal((await db.jobInstance.findUnique({where:{id:row.id}})).status,"CLAIMED");
      assert.equal(await db.fanObservationReadLease.count({where:{jobId:row.id}}),1);
      await job.releaseJob({...input,reason:"retry cleanup"});
    });
    let sequence=0, unresolvedId=null;
    async function seedAction(status="RUNNING",extra={}) {
      await db.automationDelivery.updateMany({where:{creatorId:scope.creator.id,status:{in:["RUNNING","COMMITTING"]}},data:{status:"COMPLETED"}});
      return runRootCommit(db,({tx})=>tx.automationDelivery.create({data:{agencyId:scope.agency.id,creatorId:scope.creator.id,originKind:"AUTOMATION",moduleKey:"fixture",actionType:"SEND_MESSAGE",targetId:String(100+sequence),idempotencyKey:"lifecycle:"+(++sequence),status,
        claimedByDeviceId:scope.device.id,leaseTokenHash:hash,leaseRevision:1,leaseMemberId:scope.member.id,leaseAccessEpoch:scope.member.accessEpoch,
        claimUntil:new Date(Date.now()+60000),attempts:1,...extra}}),{profile:"JOB_CHUNK"});
    }
    await check("late unstarted action release refunds one attempt and fences its old token",async()=>{
      const row=await seedAction("CLAIMED"),input={...leaseInput(row),deliveryId:row.id,reason:"stop"};
      const released=await actions.releaseActionDelivery(input);assert.equal(released.delivery.status,"QUEUED");assert.equal(released.delivery.attempts,0);assert.equal(released.delivery.leaseRevision,2);
      await assert.rejects(actions.renewActionLease(input));
    });
    await check("COMMITTING action cannot be requeued by stop; expiry preserves unknown outcome",async()=>{
      const row=await seedAction("COMMITTING",{writeCommitAt:new Date(),writeCommitRevision:1}),input={...leaseInput(row),deliveryId:row.id,reason:"stop"};
      await assert.rejects(actions.releaseActionDelivery(input),{code:"DELIVERY_COMMIT_IN_FLIGHT"});
      await db.automationDelivery.update({where:{id:row.id},data:{claimUntil:new Date(0)}});
      await actions.sweepExpiredAutomationLeases({now:await clock(),agencyId:scope.agency.id,creatorIds:[scope.creator.id]});
      const saved=await db.automationDelivery.findUnique({where:{id:row.id}});
      assert.equal(saved.status,"RECONCILE_REQUIRED");assert.equal(saved.failureCategory,"OUTCOME_UNKNOWN_RECONCILE");assert.equal(saved.writeCommitRevision,1);unresolvedId=row.id;
    });
    await check("unresolved action physically blocks a second active write for the creator",async()=>{
      await assert.rejects(seedAction("RUNNING"),{code:"P2002"});
      assert.equal((await db.automationDelivery.findUnique({where:{id:unresolvedId}})).status,"RECONCILE_REQUIRED");
    });
    await check("released reconciliation lease cannot become a fresh send",async()=>{
      const row=await runRootCommit(db,({tx})=>tx.automationDelivery.update({where:{id:unresolvedId},data:{status:"RUNNING",claimUntil:new Date(Date.now()+60000),claimedByDeviceId:scope.device.id,leaseTokenHash:hash,leaseRevision:{increment:1}}}),{profile:"JOB_CHUNK"});
      const released=await actions.releaseActionDelivery({...leaseInput(row),deliveryId:row.id,reason:"stop"});
      assert.equal(released.delivery.status,"RECONCILE_REQUIRED");assert.equal(released.delivery.attempts,1);
      assert.equal(released.delivery.result.outcomeState,"RECONCILE_REQUIRED");
    });
    const klass=work.WORK_CLASS.DEPENDENCY_FANOUT;
    const publish=id=>work.publishDomainWork({db,agencyId:scope.agency.id,workClass:klass,objectType:"LifecycleFixture",objectId:id,partitionKey:scope.agency.id});
    const claim=async id=>{
      const batch=await work.claimDomainWorkBatch({db,agencyId:scope.agency.id,workClass:klass,objectIds:[id],limit:1});
      assert.equal(batch.items.length,1,JSON.stringify(batch,(_key,value)=>typeof value==="bigint"?String(value):value));return {db,item:batch.items[0],ownerToken:batch.ownerToken};
    };
    for(const method of ["ackDomainWorkClaim","failDomainWorkClaim","yieldDomainWorkClaim","blockDomainWorkClaim"]) {
      await check(`new domain revision survives old ${method} without delay`,async()=>{
        const id="revision:"+method;await publish(id);const input=await claim(id);await publish(id);
        await work[method]({...input,error:new Error("old failure"),availableAt:new Date(Date.now()+3600000),dependencyKind:"Lifecycle",dependencyKey:id,dependencyRevision:0n});
        const row=await db.domainWorkItem.findUnique({where:{id:input.item.id}});
        assert.equal(row.state,"READY");assert.equal(row.requestedRevision,2n);assert.equal(row.consecutiveFailures,0);assert.equal(row.nextAttemptAt,null);
        const next=await claim(id);assert.equal(next.item.claimedRevision,2n);await work.ackDomainWorkClaim(next);
      });
    }
    await check("domain claim takeover rejects all stale settlement and cursor commands",async()=>{
      const id="takeover";await publish(id);const old=await claim(id);
      await db.domainWorkItem.update({where:{id:old.item.id},data:{leaseUntil:new Date(0)}});const fresh=await claim(id);
      assert(fresh.item.claimFence>old.item.claimFence);
      for(const method of ["ackDomainWorkClaim","failDomainWorkClaim","yieldDomainWorkClaim","saveDomainWorkProgress","heartbeatDomainWorkClaim"])
        assert.equal((await work[method]({...old,progressCursor:{page:999}})).lost,true);
      assert.equal((await work.ackDomainWorkClaim(fresh)).acknowledged,true);
    });
    await check("dependency advance before block leaves domain work ready",async()=>{
      const id="dependency";await publish(id);const input=await claim(id);
      await work.bumpDomainDependency({db,agencyId:scope.agency.id,dependencyKind:"Lifecycle",dependencyKey:id});
      const result=await work.blockDomainWorkClaim({...input,dependencyKind:"Lifecycle",dependencyKey:id,dependencyRevision:0n});
      assert.equal(result.ready,true);assert.equal(result.newerDependency,true);
      await work.ackDomainWorkClaim(await claim(id));
    });
    await check("maintenance takeover fences old cursor, heartbeat and finish",async()=>{
      const key="lifecycle-proof-lane",generation="fixture-v1";
      const old=await lane.claimMaintenanceLane({db,key,generation});assert.equal(old.acquired,true);
      await db.maintenanceLaneState.update({where:{key},data:{leaseUntil:new Date(0)}});
      const current=await lane.claimMaintenanceLane({db,key,generation});assert.equal(current.acquired,true);assert(current.claimFence>old.claimFence);
      assert.equal((await lane.heartbeatMaintenanceLane({db,...old,cursor:{page:999}})).renewed,false);
      assert.equal(await lane.finishMaintenanceLane({db,...old,complete:true}),false);
      assert.equal(await lane.finishMaintenanceLane({db,...current,complete:true}),true);
    });
    const result={ok:true,runtime:process.version,mode:"actual Prisma/services; serialized single-session PGlite",nativeConcurrentPostgres:false,migrations:fixture.migrations.length,cases};
    if(process.env.BACKGROUND_PROOF_REPORT)fs.writeFileSync(process.env.BACKGROUND_PROOF_REPORT,JSON.stringify(result,null,2));
    console.log(JSON.stringify(result));
  } finally {await fixture.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});

'use strict';
// Current-schema SQL proof, synthetic actors only. No caller DATABASE_URL is
// used. PGlite verifies actual constraints/rollback; concurrent lock behavior
// is covered by the accompanying deterministic unit fixture, not claimed here.
const assert = require('node:assert/strict');
const { fixture, scope } = require('./analytics-traffic/fixture.cjs');
const { observeCreatorPlatformProfile } = require('../../src/services/creator-enrollment-authority-service');
const { withProductBilling } = require('../../src/services/product-billing-context-service');
const { authorizeCreatorAccountWrite } = require('../../src/services/database-write-contract-service');
const { runRootCommit } = require('../../src/services/db-commit-kernel');
const keep = setInterval(() => {}, 1000);

async function main() {
  const f = await fixture();
  try {
    const { db } = f;
    await require('../../src/services/database-contract-service').assertDatabaseContract(db);
    const s = await scope(db);
    await runRootCommit(db, async ({tx}) => {
      await authorizeCreatorAccountWrite(tx);
      await tx.agency.update({where:{id:s.agencyId},data:{trialEndsAt:new Date(Date.now()+86400000)}});
      await tx.creatorAccount.update({where:{id:s.creatorId},data:{username:'alice',platformUsername:'alice',
        connectionState:'CONNECTED',connectionGeneration:1,platformProfileConnectionGeneration:1,
        platformProfileObservedAt:new Date('2026-01-01'),platformProfileSourceDeviceId:'old-device'}});
      await tx.creatorAccount.create({data:{id:'another-creator',agencyId:s.agencyId,displayName:'Other',
        username:'other',platformUsername:'other',remoteId:'other',status:'READY'}});
    });
    const member = await db.agencyMember.findUnique({where:{id:'member-'+s.agencyId}});
    const base = {db,...s,actorMember:member,sourceDeviceId:'device-a',connectionGeneration:1,
      remoteId:s.creatorId,username:'alice',platformDisplayName:'Alice updated',avatarUrl:'https://example.test/alice.png',
      observedAt:'2026-01-02T00:00:00Z'};
    const observe = extra => withProductBilling(s.agencyId, () => observeCreatorPlatformProfile({...base,...extra}));
    const queriesAt = f.queries.length;
    let isolation;
    const first = await observe({beforeCommit:async tx => {
      isolation = (await tx.$queryRawUnsafe('SHOW transaction_isolation'))[0].transaction_isolation;
    }});
    assert.equal(isolation,'read committed');
    assert.equal(first.creator.platformDisplayName,'Alice updated');
    assert.equal(first.creator.avatarRevision,1);
    const statements = f.queries.slice(queriesAt).map(row=>row.query);
    assert(statements.some(sql=>sql.includes('FROM "CreatorAccount"') && sql.includes('FOR NO KEY UPDATE')));
    assert(statements.some(sql=>sql.includes('FROM "AgencyMember"') && sql.includes('FOR SHARE')));
    assert(statements.some(sql=>sql.includes('FROM "User"') && sql.includes('FOR SHARE')));
    console.log('PASS actual Prisma profile update uses ReadCommitted, creator NO KEY UPDATE and live user/member fences');

    assert.equal((await observe({})).reason,'DUPLICATE_PROFILE_OBSERVATION');
    assert.equal((await observe({observedAt:'2026-01-01T12:00:00Z',platformDisplayName:'Old'})).reason,'STALE_PROFILE_OBSERVATION');
    await assert.rejects(observe({platformDisplayName:'Different'}),{code:'CREATOR_PROFILE_OBSERVATION_CONFLICT'});
    await assert.rejects(observe({observedAt:'2026-01-03T00:00:00Z',username:'other'}),{code:'CREATOR_ALREADY_EXISTS'});
    assert.equal((await db.creatorAccount.findUnique({where:{id:s.creatorId}})).avatarRevision,1);
    console.log('PASS actual persisted observations: stale/replayed payloads cannot overwrite; username collision rejects');

    // Inject one driver conflict AFTER a real UPDATE. Prisma must roll the
    // attempt back, rerun authority, and commit the same observation once.
    let attempts = 0;
    const retryDb = { $transaction(work, options) {
      const attempt = ++attempts;
      return db.$transaction(rawTx => {
        const tx = new Proxy(rawTx,{get(target,key){
          if(key==='creatorAccount') return new Proxy(target.creatorAccount,{get(model,method){
            if(method==='update') return async args => {
              const value=await model.update(args);
              if(attempt===1) throw Object.assign(new Error('controlled driver write conflict'),{code:'P2034'});
              return value;
            };
            const value=model[method];return typeof value==='function'?value.bind(model):value;
          }});
          const value=target[key];return typeof value==='function'?value.bind(target):value;
        }});
        return work(tx);
      },options);
    }};
    const second = await observe({db:retryDb,observedAt:'2026-01-03T00:00:00Z',avatarUrl:'https://example.test/new.png'});
    assert.equal(attempts,2); assert.equal(second.creator.avatarRevision,2);
    assert.equal((await db.creatorAccount.findUnique({where:{id:s.creatorId}})).avatarRevision,2);
    console.log('PASS actual database rollback after UPDATE; one retry commits once, avatar revision has no double increment');

    await assert.rejects(observe({observedAt:'2026-01-04T00:00:00Z',beforeCommit:async tx=>{
      await require('../../src/services/database-write-contract-service').assertTeamControlPlaneWriteAdmission(tx);
      await tx.$executeRawUnsafe('UPDATE "User" SET "disabledAt"=clock_timestamp() WHERE id=$1',s.userId);
    }}),{code:'CREATOR_CONNECTION_MEMBER_INACTIVE'});
    assert.equal((await db.user.findUnique({where:{id:s.userId}})).disabledAt,null,'rejected attempt must roll back all its writes');
    assert.equal((await db.creatorAccount.findUnique({where:{id:s.creatorId}})).platformProfileObservedAt.toISOString(),'2026-01-03T00:00:00.000Z');
    console.log('PASS live access recheck rejects user disable before commit and rolls the transaction back');

    await runRootCommit(db,async({tx})=>{
      await authorizeCreatorAccountWrite(tx);
      await tx.creatorAccount.update({where:{id:s.creatorId},data:{connectionGeneration:2,connectionState:'RECONNECTING'}});
    });
    assert.equal((await observe({observedAt:'2026-01-04T00:00:00Z'})).reason,'STALE_CONNECTION_GENERATION');
    await assert.rejects(observe({observedAt:'2026-01-04T00:00:00Z',connectionGeneration:2}),{code:'CREATOR_PROFILE_CONNECTION_NOT_CURRENT'});
    await require('../../src/services/database-contract-service').assertDatabaseContract(db);
    console.log(JSON.stringify({result:'PASS',schema:'nod_current_v3_creator_provider_gate',schemaChanged:false,
      profileIsolation:isolation,rollbackAttempts:attempts,nativeConcurrentPostgres:false,liveProvider:false}));
  } finally {await f.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>clearInterval(keep));

'use strict';
// Current-schema SQL, actual services, synthetic creators. No live provider.
const assert = require('node:assert/strict');
const { fixture, scope } = require('./analytics-traffic/fixture.cjs');
const gate = require('../../src/services/provider-request-credit-authority-service');
const keep = setInterval(() => {}, 1000);
async function main() {
  const f = await fixture();
  try {
    const { db } = f;
    await require('../../src/services/database-contract-service').assertDatabaseContract(db);
    const a = await scope(db, { agencyId: 'agency-a', creatorId: 'creator-a', userId: 'user-a' });
    const b = await scope(db, { agencyId: 'agency-b', creatorId: 'creator-b', userId: 'user-b' });
    const c = { ...a, creatorId: 'creator-c' };
    await db.$transaction(async tx => {
      await tx.$queryRawUnsafe(`SELECT set_config('onlinod.phase2_creator_writer_generation','phase2_creator_writer_v2_actual56_postcut',true)`);
      await tx.creatorAccount.create({data:{id:c.creatorId,agencyId:c.agencyId,remoteId:c.creatorId,displayName:'Same agency fixture',status:'READY'}});
    });
    let number = 0;
    async function waiter(s, extra = {}) {
      const id = 'waiter-' + (++number);
      const input = { db, ...s, waiterId: id, permitId: id, ownerInstanceId: 'replica-' + number,
        deviceId: 'device-' + number, capability: 'read', priority: 'background', category: 'background_other',
        operation: 'earnings.chart', intervalMs: 700, ...extra };
      await gate.registerDurableProviderWaiter(input);
      return input;
    }
    const firstA = await waiter(a), secondA = await waiter(a, { capability: 'write', priority: 'critical_write', operation: 'messages.send' });
    // Priority is durable, so acquire the selected write before the queued read.
    assert.equal((await gate.tryAcquireDurableProviderPermit(secondA)).granted, true);
    const firstB = await waiter(b);
    assert.equal((await gate.tryAcquireDurableProviderPermit(firstB)).granted, true, 'B cannot wait for A acknowledgement');
    const sameAgencyC = await waiter(c, { capability: 'security_probe', priority: 'interactive', operation: 'identity.bootstrap.me' });
    assert.equal((await gate.tryAcquireDurableProviderPermit(sameAgencyC)).granted, true, 'same-agency C cannot wait for A either');
    await gate.acknowledgeDurableProviderStarted(sameAgencyC);
    assert.equal((await gate.tryAcquireDurableProviderPermit(firstA)).reason, 'active_permit');
    assert.equal((await gate.readDurableProviderGateState({ db, creatorId: a.creatorId })).activePermitId, secondA.permitId);
    assert.equal((await gate.readDurableProviderGateState({ db, creatorId: b.creatorId })).activePermitId, firstB.permitId);
    console.log('PASS independent creators in same/different agencies coexist; read/write/security probes share only their own model clock');

    const startedA = await gate.acknowledgeDurableProviderStarted(secondA);
    assert.equal(+startedA.nextAllowedAt - +startedA.startedAt, 700);
    const blocked = await gate.tryAcquireDurableProviderPermit(firstA);
    assert.equal(blocked.reason, 'spacing');
    await assert.rejects(gate.acknowledgeDurableProviderStarted({ ...firstB, creatorId: a.creatorId }), { code: 'OF_GATE_PERMIT_INVALID' });
    assert.equal((await gate.cancelDurableProviderPermit({ ...firstB, deviceId: 'wrong-device' })).cancelled, false);
    await gate.acknowledgeDurableProviderStarted(firstB);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, +startedA.nextAllowedAt - Date.now()) + 30));
    assert.equal((await gate.tryAcquireDurableProviderPermit(firstA)).granted, true);
    const laterA = await gate.acknowledgeDurableProviderStarted(firstA);
    assert(+laterA.startedAt - +startedA.startedAt >= 700);
    console.log('PASS >=700ms spacing is preserved within a creator across replicas; forged acknowledgements/cancels reject');

    // Lost /started: only A enters fail-safe expiry. B remains admissible.
    await db.$executeRawUnsafe('UPDATE "OfProviderRequestGateState" SET "nextAllowedAt"=\'2000-01-01\'');
    const lostA = await waiter(a), liveB = await waiter(b);
    assert.equal((await gate.tryAcquireDurableProviderPermit(lostA)).granted, true);
    await db.$executeRawUnsafe('UPDATE "OfProviderRequestGateState" SET "activeExpiresAt"=(clock_timestamp() AT TIME ZONE \'UTC\')-interval \'1 second\' WHERE "scopeCreatorId"=$1', a.creatorId);
    const retryA = await waiter(a);
    const expired = await gate.tryAcquireDurableProviderPermit(retryA);
    assert.equal(expired.reason, 'expired_unknown_outcome');
    assert.equal(+expired.retryAt - +expired.authorityNow, 700);
    assert.equal((await gate.tryAcquireDurableProviderPermit(liveB)).granted, true);
    await gate.cancelDurableProviderPermit(liveB);
    console.log('PASS lost acknowledgement and expiry pause only that creator; another creator keeps progressing');

    // Direct SQL for deliberate constraint faults: the local PGlite wire adapter
    // closes a Prisma connection after a server error; production PostgreSQL does not.
    await assert.rejects(f.pg.exec(`UPDATE "OfProviderRequestGateState" SET "activePermitId"='retired' WHERE id='of-global'`), /GLOBAL_WRITER_RETIRED/);
    await assert.rejects(f.pg.exec(`UPDATE "OfProviderRequestGateState" SET "scopeCreatorId"='creator-b' WHERE "scopeCreatorId"='creator-a'`), /SCOPE_MISMATCH|SCOPE_IMMUTABLE/);
    console.log('PASS SQL fences reject retired global grants and changing creator clock identity');

    const recurring = require('../../src/services/analytics-recurring-planning-service');
    assert(await recurring.reserveDirectoryAdmission({ db, creatorId: a.creatorId, state: { campaignDirectoryCampaignCount: 900000 } }));
    assert.equal(await recurring.reserveDirectoryAdmission({ db, creatorId: a.creatorId, state: { campaignDirectoryCampaignCount: 900000 } }), false);
    assert(await recurring.reserveDirectoryAdmission({ db, creatorId: b.creatorId, state: { campaignDirectoryCampaignCount: 2 } }));
    console.log('PASS a large campaign directory exhausts only its own reservation; another model is admitted');

    const { runRootCommit } = require('../../src/services/db-commit-kernel');
    await runRootCommit(db, async ({ tx }) => {
      for (const [s, count] of [[a, 900000], [b, 2]]) {
        const jobId = 'capacity-seed-' + s.creatorId, generation = 'generation-' + s.creatorId;
        // Synthetic accepted publication supplies the existing collector fence.
        // Production publication is not bypassed or changed by this patch.
        await tx.jobInstance.create({ data: { id: jobId, agencyId: s.agencyId, creatorId: s.creatorId,
          jobKey: 'fetch_campaigns', scope: 'creator', status: 'PUBLISHING' } });
        await tx.analyticsPublication.create({ data: { id: jobId, jobId, ...s,
          deviceId: 'fixture-device', leaseRevision: 1, leaseTokenHash: 'fixture', payloadHash: 'fixture',
          payload: { scanRunId: generation }, state: 'PENDING', stage: 'FINALIZE' } });
        await tx.creatorCampaignCollectionState.create({ data: {
          agencyId: s.agencyId, creatorId: s.creatorId, baselineVerifiedAt: new Date(), sourceJobId: jobId, activeGeneration: generation,
          campaignDirectoryCampaignCount: count, campaignDirectoryDiscoveryRequestedRevision: 1,
        } });
      }
    });
    const debt = require('../../src/services/provider-capacity-debt-authority-service');
    let snapshot;
    for (let i = 0; i < 20; i++) {
      const result = await debt.refreshProviderCapacityDebtSnapshot({ db });
      if (result.projectionComplete) { snapshot = result.snapshot; break; }
    }
    assert(snapshot, 'capacity backfill must finish');
    assert.equal(snapshot.topologyScope, 'CREATOR_PARALLEL');
    assert.equal(snapshot.topologyShardCount, 2);
    const rate = require('../../src/services/provider-capacity-sla-service').providerCategoryGuaranteedStartsPerHour('campaign_directory');
    assert.equal(Number(snapshot.campaignDirectoryRequiredCalls), 18003);
    assert.equal(Number(snapshot.campaignDirectoryCapacityDebtCalls), 18001 - Math.floor(rate * 72));
    assert(Math.abs(snapshot.campaignDirectoryGuaranteedClearHours - 18001 / rate) < 0.00001);
    const canonical = debt.deriveProviderCapacityDebtSnapshot({ now: snapshot.sampledAt, ...await debt.readCanonicalCapacityInputs({ db, now: snapshot.sampledAt }) });
    for (const key of ['topologyShardCount','campaignDirectoryRequiredCalls','campaignDirectoryCapacityDebtCalls','actualUsageTotalStarts']) assert.equal(String(snapshot[key]), String(canonical[key]), key);
    assert(Math.abs(snapshot.campaignDirectoryGuaranteedClearHours - canonical.campaignDirectoryGuaranteedClearHours) < 1e-9);
    console.log('PASS per-creator debt projection matches canonical data; idle model credits cannot hide an overloaded model');

    // Exercise incremental replacement and rollback with the new creator bucket.
    const before = await db.$queryRawUnsafe('SELECT * FROM "ProviderCapacityCreatorBucket" ORDER BY "creatorId",bucket');
    await runRootCommit(db, ({tx}) => tx.creatorCampaignCollectionState.update({where:{creatorId:a.creatorId},data:{campaignDirectoryCampaignCount:901000}}));
    await assert.rejects(require('../../src/services/provider-capacity-projection-service').runProviderCapacityProjectionBatch({db,publish:async()=>{throw Error('controlled-publication-failure');}}),/controlled-publication-failure/);
    assert.deepEqual(await db.$queryRawUnsafe('SELECT * FROM "ProviderCapacityCreatorBucket" ORDER BY "creatorId",bucket'),before);
    const changed = await debt.refreshProviderCapacityDebtSnapshot({db});
    assert.equal(Number(changed.snapshot.campaignDirectoryRequiredCalls),18023);
    const replay = await debt.refreshProviderCapacityDebtSnapshot({db});
    assert.equal(Number(replay.snapshot.campaignDirectoryRequiredCalls),18023);
    await runRootCommit(db,({tx})=>tx.creatorCampaignCollectionState.delete({where:{creatorId:a.creatorId}}));
    const removed = await debt.refreshProviderCapacityDebtSnapshot({db});
    assert.equal(Number(removed.snapshot.campaignDirectoryRequiredCalls),2);
    assert.equal(removed.snapshot.topologyShardCount,1);
    console.log('PASS incremental creator debt updates and deletes are exact; publication failure rolls back creator buckets; replay does not double count');

    const plan = await db.$queryRawUnsafe(`EXPLAIN (FORMAT JSON) SELECT "ticket" FROM "OfProviderRequestGateWaiter"
      WHERE "creatorId"='creator-a' AND priority='background' AND category='background_other'
      ORDER BY "creatorId",priority,category,ticket LIMIT 32`);
    await require('../../src/services/database-contract-service').assertDatabaseContract(db);
    console.log(JSON.stringify({ result: 'PASS', schema: 'current', liveProvider: false, creatorDebt: String(snapshot.campaignDirectoryCapacityDebtCalls), queryPlanAvailable: !!plan.length }));
  } finally { await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearInterval(keep));

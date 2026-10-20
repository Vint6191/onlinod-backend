'use strict';
// Isolated PostgreSQL WASM + real Prisma, production planner, Desktop collector,
// leased commits, publication and Home readers. Synthetic provider only.
const assert = require('node:assert/strict'), path = require('node:path'), crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { scope } = require('./analytics-traffic/fixture.cjs');
const { createAdminSqlRuntime } = require('../test-support/admin-sql-runtime.cjs');
const root = path.resolve(__dirname, '../..');
const desktop = path.resolve(process.env.ONLINOD_DESKTOP_ROOT || path.join(root, '../desktop'));
const dayMs = 86_400_000, key = d => new Date(d).toISOString().slice(0, 10);
const keepAlive = setInterval(() => {}, 1000);
const deadline = setTimeout(() => { console.error('EARNINGS_LIVE_PROOF_DEADLINE'); process.exit(2); }, 300_000);
const checks = [], pass = name => { checks.push(name); console.log('PASS', name); };

async function seedPredecessorEarnings(db, { creatorScope, otherId, now }) {
  const verifiedDay = new Date(key(+now - dayMs));
  await db.$transaction(async tx => {
    for (const creatorId of [creatorScope.creatorId, otherId]) {
      const jobId = `upgrade-job-${creatorId}`, runId = `upgrade-run-${creatorId}`, proofId = `upgrade-proof-${creatorId}`;
      await tx.jobInstance.create({ data: { id: jobId, agencyId: creatorScope.agencyId, creatorId,
        jobKey: 'fetch_earnings', scope: 'creator', status: 'PUBLISHING', leaseRevision: 1 } });
      await tx.analyticsPublication.create({ data: { id: `upgrade-publication-${creatorId}`, jobId,
        agencyId: creatorScope.agencyId, creatorId, userId: creatorScope.userId, deviceId: 'upgrade-device',
        leaseRevision: 1, leaseTokenHash: 'upgrade-token', payloadHash: 'upgrade-payload', payload: {},
        state: 'PENDING', stage: 'FINALIZE' } });
      // The real predecessor proof guard requires this scoped publisher. No
      // trigger is disabled and no receipt/schema is removed to seed fixtures.
      await tx.analyticsScanProof.create({ data: { id: proofId, agencyId: creatorScope.agencyId, creatorId,
        dataType: 'EARNINGS', scanRunId: runId, sourceTimezone: 'UTC', scanFrom: verifiedDay, scanTo: verifiedDay,
        requestedAt: now, observationStartedAt: now, serverReceivedAt: now, committedAt: now, status: 'COMMITTED',
        collectorVersion: 'earnings-v7', schemaVersion: 2, scanGeneration: runId, collectionReason: 'UPGRADE_PROOF',
        sourceJobId: jobId, rowCount: 1, payloadChecksum: `upgrade-${creatorId}`, proofVersion: 2 } });
      await tx.creatorEarningsDaily.create({ data: { id: `upgrade-day-${creatorId}`, agencyId: creatorScope.agencyId,
        creatorId, date: verifiedDay, sourceTimezone: 'UTC', totalCents: creatorId === otherId ? 0 : 2400,
        sourceScanRunId: runId, sourceScanRequestedAt: now, scanProofId: proofId, sourceJobId: jobId } });
      await tx.analyticsCoverage.create({ data: { id: `upgrade-coverage-${creatorId}`, agencyId: creatorScope.agencyId,
        creatorId, dataType: 'EARNINGS', coverageDate: verifiedDay, sourceTimezone: 'UTC', status: 'COMPLETE',
        coveredFromAt: verifiedDay, coveredToAt: new Date(+verifiedDay + dayMs - 1), scanProofId: proofId, lastVerifiedAt: now } });
      await tx.analyticsPublication.update({ where: { id: `upgrade-publication-${creatorId}` }, data: { state: 'COMMITTED', stage: 'TERMINAL', completedAt: now } });
      await tx.jobInstance.update({ where: { id: jobId }, data: { status: 'DONE', completedAt: now } });
    }
    await tx.creatorEarningsDaily.create({ data: { id: 'upgrade-unverified-day', agencyId: creatorScope.agencyId,
      creatorId: creatorScope.creatorId, date: new Date(key(now)), sourceTimezone: 'UTC', totalCents: 999999,
      sourceScanRunId: 'upgrade-rejected-run', sourceScanRequestedAt: now } });
    await tx.analyticsCoverage.create({ data: { id: 'upgrade-unverified-coverage', agencyId: creatorScope.agencyId,
      creatorId: creatorScope.creatorId, dataType: 'EARNINGS', coverageDate: new Date(key(now)), sourceTimezone: 'UTC',
      status: 'FAILED', lastVerifiedAt: now, lastErrorCode: 'EARNINGS_DAILY_INCOMPLETE', lastErrorMessage: 'No committed proof for this candidate' } });
  });
}

async function provePublishedSnapshotUpgrade({ creatorScope, otherId, now }) {
  const targetMigration = '20261016000000_earnings_published_snapshot';
  const predecessor = await createAdminSqlRuntime({ runtimePath: process.env.ONLINOD_SQL_PROOF_RUNTIME,
    maxConnections: 4, beforeMigration: targetMigration });
  try {
    const db = predecessor.db;
    assert.equal(predecessor.migrations.length, 3, 'the actual v3 schema has exactly its three predecessor receipts');
    assert.equal(predecessor.migrations.includes(targetMigration), false);
    assert.equal((await db.$queryRawUnsafe(`SELECT to_regclass('public."CreatorEarningsPublishedDay"')::text AS name`))[0].name, null);
    const { inspectInstallation } = require(path.join(root, 'scripts/database/install-current'));
    assert.deepEqual(await inspectInstallation(db), { fresh: false });
    const readRows = (client, table) => client.$queryRawUnsafe(`SELECT to_jsonb(t) AS row FROM "${table}" t WHERE t."agencyId"=$1 ORDER BY t.id`, creatorScope.agencyId)
      .then(rows => rows.map(row => row.row));
    const sourceTables = ['WorkerDevice', 'JobInstance', 'AnalyticsPublication', 'AnalyticsScanProof',
      'AnalyticsIngestBatch', 'CreatorEarningsDaily', 'AnalyticsCoverage'];
    await scope(db, creatorScope);
    await db.$transaction(async tx => {
      await tx.$queryRawUnsafe("SELECT set_config('onlinod.phase2_creator_writer_generation','phase2_creator_writer_v2_actual56_postcut',true)");
      await tx.creatorAccount.create({ data: { id: otherId, agencyId: creatorScope.agencyId, displayName: 'Zero', status: 'READY', remoteId: otherId } });
    });
    await seedPredecessorEarnings(db, { creatorScope, otherId, now });
    const source = Object.fromEntries(await Promise.all(sourceTables.map(async table => [table, await readRows(db, table)])));
    assert.ok(source.CreatorEarningsDaily.length > 1 && source.AnalyticsScanProof.some(row => row.status === 'COMMITTED'));
    const predecessorReceipts = await db.$queryRawUnsafe('SELECT migration_name,checksum,finished_at FROM "_prisma_migrations" ORDER BY migration_name');
    assert.equal(predecessorReceipts.length, 3);
    await db.$disconnect();
    await predecessor.waitForIdle();
    console.log('UPGRADE genuine v3 schema, receipts and source data prepared; starting the production installer');
    await new Promise((resolve, reject) => {
      const child = require('node:child_process').spawn(process.execPath, ['scripts/database/install-current.js'], {
        cwd: root, env: { ...process.env, DATABASE_URL: predecessor.url, DIRECT_URL: predecessor.url }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
      const timer = setTimeout(() => child.kill('SIGTERM'), 60_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error(`Upgrade installer failed: ${output}`)); });
    });
    assert.equal(await db.creatorEarningsPublishedDay.count(), source.CreatorEarningsDaily.length - 1);
    assert.equal(await db.creatorEarningsPublishedDay.count({ where: { creatorId: creatorScope.creatorId, date: new Date(key(now)) } }), 0);
    assert.equal(await db.creatorEarningsPublishedDay.count({ where: { creatorId: otherId, totalCents: 0 } }),
      source.CreatorEarningsDaily.filter(row => row.creatorId === otherId && row.totalCents === 0 && row.scanProofId).length);
    const verifiedMoney = source.CreatorEarningsDaily.filter(row => row.creatorId === creatorScope.creatorId && row.scanProofId)
      .reduce((sum, row) => sum + row.totalCents, 0);
    assert.equal((await db.creatorEarningsPublishedDay.aggregate({ where: { creatorId: creatorScope.creatorId }, _sum: { totalCents: true } }))._sum.totalCents, verifiedMoney);
    for (const table of ['AnalyticsScanProof', 'AnalyticsIngestBatch', 'CreatorEarningsDaily', 'AnalyticsCoverage']) {
      assert.deepEqual(await readRows(db, table), source[table], `${table} preserved by the real upgrade`);
    }
    const upgradedReceipts = await db.$queryRawUnsafe('SELECT migration_name,checksum,finished_at FROM "_prisma_migrations" ORDER BY migration_name');
    assert.deepEqual(upgradedReceipts.slice(0, predecessorReceipts.length), predecessorReceipts, 'installer preserves the complete predecessor receipt prefix');
    assert.equal((await require(path.join(root, 'src/services/database-contract-service')).readDatabaseContract(db)).ready, true);
  } finally { await predecessor.close(); }
}

async function main() {
  if (process.argv.includes('--upgrade-only')) {
    await provePublishedSnapshotUpgrade({ creatorScope: { agencyId: 'upgrade-agency', creatorId: 'upgrade-creator', userId: 'upgrade-user' },
      otherId: 'upgrade-zero', now: new Date() });
    pass('genuine v3-to-current installer preserves source evidence and receipts, publishes verified money/zero and excludes unverified money');
    console.log(JSON.stringify({ ok: true, checks, mode: 'upgrade-only', runtime: 'isolated predecessor PGlite + Prisma', liveProvider: false }));
    return;
  }
  const { earningsHandler } = await import(pathToFileURL(path.join(desktop, 'apps/desktop/dist/electron/main/services/backend-jobs/handlers/earnings-handler.js')));
  const f = await createAdminSqlRuntime({ runtimePath: process.env.ONLINOD_SQL_PROOF_RUNTIME, maxConnections: 4 });
  try {
    const { db } = f, s = await scope(db), now = new Date();
    require.cache[require.resolve(path.join(root, 'src/prisma'))] = { exports: db };
    const { runRootCommit } = require(path.join(root, 'src/services/db-commit-kernel'));
    const planner = require(path.join(root, 'src/services/analytics-collection-planner'));
    const lease = require(path.join(root, 'src/services/job-lease-service'));
    const scheduler = require(path.join(root, 'src/services/job-scheduler'));
    const admitted = new Set();
    let pumpTicks = 0;
    let assertPublished = async () => {};
    async function publish(receipts, expectedState = 'COMMITTED') {
      for (let tick = 0; tick < 100; tick++) {
        const rows = await db.analyticsPublication.findMany({ where: { id: { in: receipts.map(r => r.publicationId) } } });
        assert.equal(rows.length, receipts.length);
        if (rows.every(r => r.state === expectedState)) return;
        for (const row of rows) assert.ok(['PENDING', expectedState].includes(row.state), JSON.stringify(row.response));
        const result = await scheduler.runPhase2MaintenancePump({ db });
        pumpTicks++;
        await assertPublished('maintenance');
        for (const name of result.admission.selected) admitted.add(name);
        if (result.analyticsPublication) assert.equal(result.analyticsPublication.ok, true, JSON.stringify(result.analyticsPublication));
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      throw Error('maintenance pump did not publish the collected earnings');
    }
    const home = require(path.join(root, 'src/services/home-summary-service'));
    const commit = fn => runRootCommit(db, ({ tx }) => fn(tx));
    const deviceId = 'home-device', otherId = 'home-zero';
    await db.agency.update({ where: { id: s.agencyId }, data: { trialEndsAt: new Date(+now + dayMs) } });
    await db.workerDevice.create({ data: { id: deviceId, agencyId: s.agencyId, userId: s.userId, lastSeenAt: now } });
    await db.$transaction(async tx => {
      await tx.$queryRawUnsafe("SELECT set_config('onlinod.phase2_creator_writer_generation','phase2_creator_writer_v2_actual56_postcut',true)");
      await tx.creatorAccount.create({ data: { id: otherId, agencyId: s.agencyId, displayName: 'Zero', status: 'READY', remoteId: otherId } });
    });
    const member = await db.agencyMember.findUnique({ where: { id: 'member-' + s.agencyId } });
    const input = { db, agencyId: s.agencyId, member };
    const demandInput = { db, agencyId: s.agencyId, scopeMode: 'MEMBER_CURRENT', requestedByMemberId: member.id,
      requestedAccessEpoch: member.accessEpoch, mode: 'automatic' };
    const request = await planner.enqueueHomeAnalyticsFreshnessDemand({ ...demandInput, rangeKey: '7d' });
    const claim = await planner.claimNextAnalyticsDemand({ db });
    assert.equal(claim.key, request.key);
    const repeated = await planner.enqueueHomeAnalyticsFreshnessDemand({ ...demandInput, rangeKey: 'today' });
    assert.equal(repeated.requestRevision, claim.requestRevision);
    const planned = await planner.processAnalyticsDemand({ db, demand: claim, maxCreators: 10, budgetMs: 30_000 });
    assert.equal(planned.ok, true);
    const jobs = await db.jobInstance.findMany({ where: { agencyId: s.agencyId, jobKey: 'fetch_earnings', status: 'SCHEDULED' }, orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }] });
    assert.equal(jobs.length, 14);
    for (const creatorId of [s.creatorId, otherId]) {
      const covered = new Set();
      for (const job of jobs.filter(j => j.creatorId === creatorId)) {
        const from = Date.parse(job.params.scanFrom), to = Date.parse(job.params.scanTo);
        assert.ok((to - from) / dayMs < 30);
        for (let d = from; d <= to; d += dayMs) { assert.ok(!covered.has(key(d))); covered.add(key(d)); }
      }
      assert.equal(covered.size, 180);
    }
    assert.equal(jobs[0].params.scanFrom, key(now));
    pass('one tab request plans exactly one 180-day history per creator; repeated tab request preserves the live claim');
    assert.equal((await home.buildHomeSummary({ ...input, rangeKey: '90d' })).revenue.totalCents, null);

    async function collect(job, cents, legacyRejected = false) {
      const token = 'fixture-token-' + job.id, revision = Number(job.leaseRevision || 0) + 1;
      await commit(tx => tx.jobInstance.update({ where: { id: job.id }, data: {
        status: 'CLAIMED', claimedByDeviceId: deviceId, leaseTokenHash: crypto.createHash('sha256').update(token).digest('hex'),
        leaseRevision: revision, leaseMemberId: member.id, leaseAccessEpoch: member.accessEpoch, leaseUntil: new Date(Date.now() + 600_000),
      } }));
      const transport = { jobId: job.id, userId: s.userId, deviceId, leaseToken: token, leaseRevision: revision };
      const from = Date.parse(job.params.scanFrom), to = Date.parse(job.params.scanTo), days = (to - from) / dayMs + 1;
      const points = Array.from({ length: days }, (_, i) => [
        { date: new Date(from + i * dayMs).toISOString(), count: 0 },
        { date: new Date(from + i * dayMs + 10 * 3600_000).toISOString(), count: cents / 200 },
        { date: new Date(from + i * dayMs + 20 * 3600_000).toISOString(), count: cents / 200 },
      ]).flat();
      const reports = [];
      const collected = await earningsHandler.runChunk({ creatorId: job.creatorId, job, signal: new AbortController().signal,
        ofApi: { request: async () => ({ ok: true, status: 200, data: { total: { total: cents * days / 100, chartAmount: points } } }) },
        reportAsync: report => reports.push(report), flushAsyncReports: async () => {},
      });
      assert.equal(collected.result.dailyComplete, true); assert.equal(collected.result.dailyCount, days);
      if (legacyRejected) {
        assert.equal(days, 1);
        for (const report of reports) {
          report.chunkResult.collectorVersion = 'earnings-v6';
          report.chunkResult.scannerRejected = 2;
          report.chunkResult.rows[0].totalCents = 0;
        }
        Object.assign(collected.result, { collectorVersion: 'earnings-v6', scannerRejected: 2, dailyComplete: false,
          raw: { dailyObservedCount: 1, dailyRejected: 2, dailyRejectionReasons: { CONFLICTING_DAY: 2 }, dailySource: 'total.chartAmount' } });
      }
      for (const report of reports) await lease.progressJob({ ...transport, ...report });
      await assertPublished('ingest');
      const receipt = await lease.completeJob({ ...transport, result: collected.result });
      assert.ok(receipt.publicationId);
      return receipt;
    }
    const brokenJob = jobs.find(j => j.creatorId === s.creatorId && j.params.scanFrom === key(now));
    const rejected = await collect(brokenJob, 2400, true);
    await publish([rejected], 'REJECTED');
    const retryJob = await db.jobInstance.findUnique({ where: { id: brokenJob.id } });
    assert.equal(retryJob.status, 'SCHEDULED');
    assert.match(retryJob.lastError, /1 accepted, 2 rejected.*CONFLICTING_DAY.*chartCents=2400; storedCents=0/);
    assert.notEqual(retryJob.params.scanGeneration, brokenJob.params.scanGeneration);
    assert.equal((await home.buildHomeSummary({ ...input, rangeKey: 'today' })).revenue.totalCents, null);
    pass('queued V6 failure reproduces screenshot; real maintenance rejects incomplete money and schedules a new generation');
    const receipts = [];
    for (const job of jobs) receipts.push(await collect(job.id === brokenJob.id ? retryJob : job, job.creatorId === s.creatorId ? 2400 : 0));
    await publish(receipts);
    for (const [rangeKey, days] of [['today', 1], ['7d', 7], ['30d', 30], ['90d', 90]]) {
      const result = await home.buildHomeSummary({ ...input, rangeKey });
      assert.equal(result.revenue.totalCents, days * 2400, rangeKey);
      assert.equal(result.revenue.deltaPct, 0, rangeKey);
      assert.equal(result.revenue.coverage.reportingCreators, 2);
      assert.equal(result.revenue.points.length, days === 1 ? 3 : days);
      assert.equal(result.revenue.points.reduce((sum, p) => sum + p.valueCents, 0), result.revenue.totalCents);
      const page = await home.buildHomeCreatorPage({ ...input, rangeKey });
      assert.equal(page.creators.find(c => c.id === otherId).revenueCents, 0);
    }
    pass('intraday chartAmount -> leased ingest -> unmodified scheduler pump -> durable publication -> all four Home periods, comparison totals and known zero');
    const fresh = await planner.ensureOperationalAnalyticsFreshness({ db, ...s });
    assert.equal(fresh.dueDays, 0);
    const future = new Date(Date.now() + 61_000);
    const coverageRows = await db.analyticsCoverage.findMany({ where: { creatorId: s.creatorId, dataType: 'EARNINGS' }, include: { scanProof: true } });
    // The direct bounded planner takes an already-authoritative time; only the
    // current day is due. No fabricated DB clock is used for commit authority.
    const range = planner.operationalFreshnessWindow(future);
    const live = await planner.ensureAnalyticsWindowFreshness({ db, ...s, ...range, now: future, coverageRows, reason: 'HOME_INTERACTIVE_REFRESH' });
    assert.equal(live.dueDays, 1); assert.equal(live.jobs.length, 1);
    assert.equal(live.jobs[0].id, brokenJob.id, 'recurring collection must reuse its logical day task');
    assert.equal(await db.jobInstance.count({where:{agencyId:s.agencyId,jobKey:'fetch_earnings'}}),14);
    assertPublished = async phase => {
      const differences = [];
      // Read periods in switching order, including the separately fetched list.
      for (const [rangeKey, days] of [['90d', 90], ['today', 1], ['30d', 30], ['7d', 7]]) {
        const summary = await home.buildHomeSummary({ ...input, rangeKey });
        assert.notEqual(summary.revenue.totalCents, null, `published total disappeared during ${phase}: ${rangeKey}`);
        assert.equal(summary.revenue.coverage.reportingCreators, 2);
        const diff = summary.revenue.totalCents - days * 2400;
        assert.ok(phase === 'ingest' ? diff === 0 : [0, 2400].includes(diff), `${phase} leaked unverified amount`);
        differences.push(diff);
        const page = await home.buildHomeCreatorPage({ ...input, rangeKey });
        assert.equal(page.creators.find(c => c.id === otherId).revenueCents, 0);
      }
      assert.equal(new Set(differences).size, 1, 'periods switched across different publication state');
    };
    await publish([await collect(live.jobs[0], 4800)]);
    assertPublished = async () => {};
    for (const [rangeKey, days] of [['today', 1], ['7d', 7], ['30d', 30], ['90d', 90]]) {
      const result = await home.buildHomeSummary({ ...input, rangeKey });
      assert.equal(result.revenue.totalCents, days * 2400 + 2400, rangeKey);
    }
    pass('one updated current day changes every Home period without rescanning their history');

    // Fail immediately AFTER the real snapshot INSERT, before the root commit.
    // Its proof, job settlement and money must all roll back together.
    const third = await planner.ensureOperationalAnalyticsFreshness({ db, ...s, reason:'HOME_INTERACTIVE_REFRESH' });
    assert.equal(third.jobs.length,1); assert.equal(third.jobs[0].id,brokenJob.id);
    const receipt = await collect(third.jobs[0],7200);
    let publisher = require(path.join(root,'src/services/analytics-publication-service'));
    for(let i=0;i<10;i++) {
      const row=await db.analyticsPublication.findUnique({where:{id:receipt.publicationId}});
      if(row.stage==='FINALIZE') break;
      await new Promise(resolve=>setTimeout(resolve,30));
      await publisher.runAnalyticsPublicationUnit({db,publicationId:receipt.publicationId});
    }
    await new Promise(resolve=>setTimeout(resolve,30));
    let injected=false;
    const faultyDb=new Proxy(db,{get(target,prop){
      if(prop==='$transaction') return (callback,options)=>target.$transaction(tx=>callback(new Proxy(tx,{get(inner,key){
        if(key==='$executeRawUnsafe') return async(sql,...args)=>{
          const result=await inner.$executeRawUnsafe(sql,...args);
          if(sql.includes('earnings_verified_snapshot_v1')) { injected=true; throw Error('INJECTED_AFTER_SNAPSHOT'); }
          return result;
        };
        const value=inner[key];return typeof value==='function'?value.bind(inner):value;
      }})),options);
      const value=target[prop];return typeof value==='function'?value.bind(target):value;
    }});
    await assert.rejects(publisher.runAnalyticsPublicationUnit({db:faultyDb,publicationId:receipt.publicationId}),/INJECTED_AFTER_SNAPSHOT/);
    assert.equal(injected,true);
    assert.equal((await home.buildHomeSummary({...input,rangeKey:'today'})).revenue.totalCents,4800);
    assert.equal((await db.analyticsPublication.findUnique({where:{id:receipt.publicationId}})).state,'PENDING');
    delete require.cache[require.resolve(path.join(root,'src/services/analytics-publication-service'))];
    await publish([receipt]);
    assert.equal((await home.buildHomeSummary({...input,rangeKey:'today'})).revenue.totalCents,7200);
    await require(path.join(root,'src/services/analytics-publication-service')).runAnalyticsPublicationUnit({db,publicationId:receipt.publicationId});
    assert.equal((await home.buildHomeSummary({...input,rangeKey:'today'})).revenue.totalCents,7200);
    pass('snapshot/proof/settlement roll back atomically; restarted publication and replay keep exact money');

    const bad = await planner.ensureOperationalAnalyticsFreshness({db,...s,reason:'HOME_INTERACTIVE_REFRESH'});
    assertPublished=async phase=>{
      for(const [rangeKey,days] of [['today',1],['90d',90],['7d',7],['30d',30]])
        assert.equal((await home.buildHomeSummary({...input,rangeKey})).revenue.totalCents,days*2400+4800,phase);
    };
    await publish([await collect(bad.jobs[0],9600,true)],'REJECTED');
    const afterFailure=await db.jobInstance.findUnique({where:{id:brokenJob.id}});
    const pausedUntil=afterFailure.nextRunAt;
    await planner.ensureOperationalAnalyticsFreshness({db,...s,reason:'HOME_INTERACTIVE_REFRESH'});
    assert.deepEqual((await db.jobInstance.findUnique({where:{id:brokenJob.id}})).nextRunAt,pausedUntil);
    assert.equal(await db.jobInstance.count({where:{agencyId:s.agencyId,jobKey:'fetch_earnings'}}),14);
    const protectedProof=(await db.creatorEarningsPublishedDay.findFirst({where:{creatorId:s.creatorId,date:new Date(key(now))}})).scanProofId;
    await assert.rejects(db.analyticsScanProof.delete({where:{id:protectedProof}}),/Foreign key constraint/);
    await db.$disconnect(); // PGlite socket resets after an intentionally rejected protocol transaction.
    await assertPublished('rejected refresh and proof retention');
    pass('rejected refresh preserves all periods and hourly chart; demand does not bypass retry or multiply jobs; proof remains protected');

    const lifecycle=require(path.join(root,'src/services/phase2-destructive-delete-authority-service'));
    const constraints=await lifecycle.loadForeignKeyConstraints(db);
    const cleanupPlan=lifecycle.cascadeDeletePlanFromConstraints(constraints.filter(x=>x.deleteAction==='CASCADE'),'CreatorAccount',constraints);
    assert.ok(cleanupPlan.findIndex(x=>x.tableName==='CreatorEarningsPublishedDay')<cleanupPlan.findIndex(x=>x.tableName==='AnalyticsScanProof'));
    // A migration proof must start from matching predecessor DDL and receipts.
    // Keep the full-current execution fixture intact and use an isolated v3 DB.
    await provePublishedSnapshotUpgrade({ creatorScope: s, otherId, now });
    pass('isolated v3-to-current installer seeds verified fixture rows only, preserves source evidence and predecessor receipts, excludes unverified money and passes the full schema contract');
    assert.ok(admitted.has('analyticsPublication'));
    console.log(JSON.stringify({ ok: true, checks, plannedJobs: jobs.length, pumpTicks, admittedLanes: [...admitted], syntheticProvider: true, publicationDueTimesModified: false, runtime: 'isolated PGlite + Prisma', liveProvider: false }));
  } finally { await f.close(); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; })
  .finally(() => { clearInterval(keepAlive); clearTimeout(deadline); });

'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { createRequire } = require('node:module');

// Full current Team Analytics path. Only physical provider/window observations
// and transport failures are controlled. No activity, coverage, ownership,
// response case or paid money projection is inserted through SQL.
exports.runTeam215 = async function runTeam215(f) {
  const { modules: m, desktop, scratch, output, auth, api, agencyId, deviceId,
    creatorId: c, creatorIds, must, pass, results } = f;
  const load = createRequire(path.join(desktop, 'package.json'));
  const runtime = createRequire(path.join(process.env.ONLINOD_BROWSER_RUNTIME, 'package.json'));
  const logs = [], calls = [], errors = [], telemetry = [], providerCalls = [];
  const log = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, (...args) => logs.push({ level,
    args: args.map(value => value instanceof Error ? { message: value.message, code: value.code } : value) })]));
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (work, label, timeout = 60000) => { const end = Date.now() + timeout;
    for (;;) { if (await work()) return; if (Date.now() > end) throw Error(label + '\n' + JSON.stringify(logs.slice(-4))); await wait(1000); } };
  const authStore = { ...auth, readSession: () => ({ ...auth.readSession(), deviceId }), getDeviceId: () => deviceId,
    getAuthorizationScopeHash: () => agencyId + ':' + deviceId, getActiveCreatorId: () => c, onSessionChanged: () => () => {} };
  const authService = { ensureSession: async () => ({ authenticated: true, session: authStore.readSession() }) };
  const state = await must('GET', '/api/team/state');
  const permissions = state.roles.find(row => row.key === 'owner').permissions;
  const catalog = await f.withDatabase((db, backendLoad) => backendLoad('./src/services/creator-human-management-authority-service').currentCreatorCatalogGeneration({ db, agencyId }));
  const authority = new m.DesktopCurrentAuthorizationAuthorityService({ log, authStore,
    accessRuntime: { currentAuthorityProof: () => ({ accessEpoch: 1, creatorCatalogGeneration: catalog }), allowedCreatorIdsSnapshot: () => creatorIds } });
  const publish = () => authority.publish({ accessEpoch: 1, creatorCatalogGeneration: catalog, role: 'OWNER', roleKey: 'owner',
    effectivePermissions: permissions, allowedCreatorIds: creatorIds, observedAt: Date.now(), observedAtMono: performance.now(),
    billing: { version: 1, validForMs: 90000, creators: creatorIds.map(creatorId => ({ creatorId, allowed: true, validForMs: 90000, reason: 'TRIAL' })) } },
  'Team215 actual authority', { renewUnchanged: true });
  publish();
  const renew = setInterval(publish, 30000);
  const outboxPath = path.join(scratch, 'team215-outbox.sqlite');
  const pendingEvents = () => {
    const sql = new (load('better-sqlite3'))(outboxPath, { readonly: true });
    try { return sql.prepare('SELECT event_json FROM team_activity_outbox').all().map(row => JSON.parse(row.event_json)); }
    finally { sql.close(); }
  };
  let analytics, fault = 'empty-ack', server, browser, page;
  const open = () => {
    analytics = new m.TeamAnalyticsService({ log, authStore, authService, authorization: authority, outbox: new m.TeamActivityOutbox(outboxPath) });
    const request = analytics.api.request.bind(analytics.api);
    analytics.api.request = async (url, options) => {
      const result = await request(url, options);
      if (url.includes('/telemetry/')) {
        telemetry.push({ events: options.body.events, receipt: result });
        if (fault === 'empty-ack') return { ...result, acknowledgedLocalIds: [], rejectedEvents: [] };
        if (fault === 'lose-reply') throw Object.assign(Error('Controlled telemetry reply loss after commit'), { code: 'NETWORK_ERROR' });
      }
      return result;
    };
  };
  const action = (creatorId, messageId, overrides = {}) => {
    const permit = authority.capturePermit('LOCAL_PROCESS', { creatorId });
    return { kind: 'MANUAL_MESSAGE_SEND_CONFIRMED', creatorId, fanId: '2151001', dialogId: '2151001', messageId,
      occurredAt: new Date(Date.now() - 5 * 60000).toISOString(), priceCents: 1200, currency: 'USD', mediaCount: 1, mediaIds: ['2159001'],
      webContentsId: 1, requestId: 'team215-' + creatorId + '-' + messageId,
      authorizationCapture: { version: 1, creatorId, actorAgencyId: agencyId, actorMemberId: f.login.activeMemberId, actorUserId: f.login.user.id,
        authorizationScopeIncarnation: permit.authorizationScopeIncarnation, accessEpoch: permit.accessEpoch,
        creatorCatalogGeneration: permit.creatorCatalogGeneration, localAuthorizationRevision: permit.localAuthorizationRevision }, ...overrides };
  };
  const serviceApi = { ...api, deviceId };
  const management = new m.ManagementCommandTransport(serviceApi, authStore, path.join(scratch, 'team215-management.json'), authority, () => {});
  const claims = new m.TeamClaimsService(serviceApi, authority, management);
  try {
    open();
    analytics.handleNetworkAction(action(c, '2152001'));
    analytics.handleNetworkAction(action(creatorIds[1], '2152001'));
    await analytics.flush();
    assert.deepEqual(pendingEvents().filter(row => row.eventKind === 'MESSAGE_SEND_CONFIRMED').map(row => row.creatorId).sort(),
      [...creatorIds].sort(), 'An explicit empty row ACK must retain both creator-scoped pending messages');
    const pendingCount = analytics.health().pending;
    await analytics.destroy();
    open();
    assert.ok(analytics.health().pending >= pendingCount, 'SQLite restart must retain unacknowledged events and closed dialog evidence');
    fault = null;
    await until(async () => { await analytics.flush(); return analytics.health().pending === 0; }, 'Scoped SQLite rows did not recover');
    let today = await analytics.getSnapshot({ rangeKey: '24h' });
    assert.equal(today.overview.manualMessages, 2);
    pass('Same provider ID in two creators survives SQLite, an empty modern ACK and Desktop reopen; actual HTTP commits two messages');

    const original = telemetry.flatMap(row => row.events).find(row => row.creatorId === c && row.eventKind === 'MESSAGE_SEND_CONFIRMED');
    assert.ok(original);
    const replay = await must('POST', '/api/telemetry/events/ingest/current-authorized', { deviceId,
      events: [{ ...original, localId: 'legacy-observation-replay-215' }] });
    assert.equal(replay.accepted, 1);
    const collision = await must('POST', '/api/telemetry/events/ingest/current-authorized', { deviceId,
      events: [{ ...original, creatorId: creatorIds[1], accountId: creatorIds[1] }] });
    assert.deepEqual(collision.acknowledgedLocalIds, []);
    assert.equal(collision.rejectedEvents[0]?.reason, 'local_id_identity_conflict');
    const week = await analytics.getSnapshot({ rangeKey: '7d' });
    today = await analytics.getSnapshot({ rangeKey: '24h' });
    assert.equal(today.overview.manualMessages, 2);
    assert.equal(week.overview.manualMessages, 2);
    pass('Legacy/scoped replay remains one canonical contribution in Today and 7 days; a conflicting localId receives explicit rejection');

    const foreign = await must('POST', '/api/telemetry/events/ingest/current-authorized', { deviceId,
      events: [{ ...original, localId: 'unsupported-currency-215', currency: 'EUR' }] });
    assert.equal(foreign.accepted, 0);
    assert.equal(foreign.rejectedEvents[0]?.reason, 'unsupported_currency');
    assert.equal((await analytics.getSnapshot({ rangeKey: '24h' })).overview.manualMessages, 2);
    pass('Actual authorized HTTP ingestion rejects explicit foreign money without another activity or revenue contribution');

    analytics.setWorkspaceCoverage(c, 'team215-visible');
    await analytics.flush();
    await wait(30);
    const receivedAt = new Date().toISOString();
    const incoming = { type: 'chat_message_received', fanId: '2151002', dialogId: '2151002', messageId: '2153001', createdAt: receivedAt };
    analytics.handleRuntimeEvent({ creatorId: c, event: incoming });
    analytics.handleRuntimeEvent({ creatorId: creatorIds[1], event: incoming });
    await analytics.flush();
    await until(async () => { const pending = await analytics.getPending({ limit: 100 }); results.pendingBeforeReply = pending;
      return pending.rows?.filter(row => row.dialogId === '2151002').length === 2; }, 'Creator-scoped incoming queue did not converge');
    await wait(30);
    fault = 'lose-reply';
    analytics.handleNetworkAction(action(c, '2152002', { fanId: '2151002', dialogId: '2151002', priceCents: 0,
      mediaCount: 0, mediaIds: [], occurredAt: new Date().toISOString() }));
    await analytics.flush();
    assert.ok(analytics.health().pending >= 1);
    fault = null;
    await until(async () => { await analytics.flush(); return analytics.health().pending === 0; }, 'Lost reply telemetry did not retry');
    analytics.endWorkspaceCoverage('team215-hidden');
    await analytics.flush();
    await until(async () => {
      const response = await analytics.getResponses({ rangeKey: '24h', memberId: f.login.activeMemberId, limit: 100 });
      results.responsesCurrent = response;
      return response.rows?.some(row => row.replyMessageId === '2152002' && row.classification === 'FRESH');
    }, 'Coverage/incoming/manual reply did not produce FRESH response');
    const fresh = results.responsesCurrent.rows.find(row => row.replyMessageId === '2152002');
    assert.equal(fresh.slaEligible, true);
    await until(async () => { const pending = await analytics.getPending({ limit: 100 }); results.pendingAfterReply = pending;
      const rows = pending.rows?.filter(row => row.dialogId === '2151002') || [];
      return rows.length === 1 && rows[0].creatorId === creatorIds[1]; }, 'Reply closed wrong creator queue');
    pass('Observed coverage -> two scoped incoming messages -> one human reply -> FRESH/SLA and one remaining queue; lost reply retry is idempotent');

    await must('POST', '/api/devices/heartbeat', { deviceId, accounts: [{ creatorId: c, remoteId: '100001', status: 'READY',
      accessEpoch: 1, sessionReadReady: true, sessionWriteReady: true, sessionProofEpoch: 1, canonicalRevision: 1, networkRevision: 0, runtimeReady: true }] });
    const runOperation = async (target, jobKey, handler, provider, capability = {}) => {
      if (target === 'notification') {
        const stopped = await management.executeOperation(target, c, 'stop', {}); management.acknowledge(stopped.commandId);
      }
      const operation = await management.executeOperation(target, c, 'start', {}); management.acknowledge(operation.commandId);
      let claim;
      await until(async () => {
        claim = await must('POST', '/api/jobs/claim', { deviceId, leaseMs: 180000, jobKeys: [jobKey], capabilities: {
          creatorEventDrivenSyncV2: true, legacyStorageRetirementV1: true, ...capability } });
        if (!claim.job) assert.ok(['initial-stage-wait', 'no-work', 'race-lost', 'campaign-directory-capacity'].includes(claim.reason), JSON.stringify(claim));
        return Boolean(claim.job);
      }, 'Current initial collection dependency did not admit ' + jobKey);
      assert.ok(claim.job, JSON.stringify(claim)); const job = claim.job;
      if (provider.onJob) provider.onJob(job);
      let continuation = job.continuation || { driverPhase: 'execute', jobContinuation: null };
      for (let step = 0; step < 20; step++) {
        const chunk = await handler.runChunk({ job, creatorId: c, continuation: continuation.jobContinuation,
          signal: new AbortController().signal, ofApi: provider });
        const next = chunk.outcome === 'done' ? { driverPhase: 'complete', result: chunk.result, progress: chunk.progress }
          : { driverPhase: 'execute', jobContinuation: chunk.continuation };
        const response = await must('POST', `/api/jobs/${job.id}/progress`, { deviceId, leaseToken: job.leaseToken,
          leaseRevision: job.leaseRevision, expectedContinuation: continuation, continuation: next, chunkResult: chunk.chunkResult, progress: chunk.progress });
        continuation = response.lease.continuation;
        if (continuation.driverPhase === 'complete') {
          await must('POST', `/api/jobs/${job.id}/complete`, { deviceId, leaseToken: job.leaseToken, leaseRevision: job.leaseRevision,
            result: continuation.result, progress: continuation.progress }); break;
        }
      }
      assert.equal(continuation.driverPhase, 'complete');
      if (target === 'financial') assert.equal(continuation.result.scannerRejected, 0, 'Controlled facts must fit the claimed immutable financial window');
    };
    const tippedAt = new Date(Date.now() - 60000).toISOString();
    const transactions = [
      { id: 'team215-tip-known', descriptionDetails: { type: 'tip' }, amount: 25, net: 17.01, fee: 7.99,
        currency: 'USD', status: 'done', createdAt: tippedAt, user: { id: '2151001', username: 'team215_buyer' } },
      { id: 'team215-tip-unknown', descriptionDetails: { type: 'tip' }, amount: 7, net: 5.6, fee: 1.4,
        currency: 'USD', status: 'done', createdAt: tippedAt },
    ];
    await runOperation('financial', 'financial_transactions_scan', m.financialTransactionsHandler, {
      onJob: job => { const end = String(job.params.endDate).replace(' ', 'T');
        const at = new Date(Date.parse(end.endsWith('Z') ? end : end + 'Z') - 1000).toISOString();
        transactions.forEach(row => { row.createdAt = at; }); },
      request: async input => { assert.equal(input.endpoint.method, 'GET'); providerCalls.push({ source: input.source, path: input.endpoint.path });
        if (input.source.endsWith('.payouts')) return { ok: true, status: 200, data: { list: transactions, hasMore: false } };
        const category = input.source.split('.').at(-1), key = category === 'messages' ? 'chat_messages' : category;
        const included = ['total', 'tips'].includes(category);
        return { ok: true, status: 200, data: { [key]: { gross: included ? 32 : 0, total: included ? 22.61 : 0, count: included ? 2 : 0 } } }; }
    }, { financialWindowReceiptsV1: true, financialMoneyResolutionV1: true, financialTraversalV2: true });
    await until(async () => { results.tipWorkspace = await claims.getWorkspace(); return results.tipWorkspace.tips.length === 2; }, 'Canonical financial tips did not reconcile');
    const knownTip = results.tipWorkspace.tips.find(row => row.amountCents === 2500), unknownTip = results.tipWorkspace.tips.find(row => row.amountCents === 700);
    assert.ok(knownTip && unknownTip);
    assert.equal(unknownTip.status, 'unresolved');
    assert.deepEqual(unknownTip.candidates || [], []);
    const claimed = await claims.resolveTip({ eventHash: knownTip.eventHash, expectedUpdatedAt: knownTip.updatedAt,
      action: 'claim', reason: 'Actual recent manual evidence for this dialog' });
    management.acknowledge(claimed.commandId);
    results.tipAudit = await claims.getTipAudit({ eventHash: knownTip.eventHash });
    assert.equal(results.tipAudit.attribution.attributedToMemberId, f.login.activeMemberId);
    await until(async () => { results.tipSnapshot = await analytics.getSnapshot({ rangeKey: '24h' });
      return results.tipSnapshot.overview.revenueByCurrency?.USD === 2500; }, 'Gross USD tip attribution did not converge');
    pass('Actual financial handler -> canonical gross tip -> scoped recent evidence -> authorized self-claim; unknown buyer stays unresolved without another dialog candidate');

    // The actual initial collector requires financial -> Campaigns ->
    // notifications readiness. Complete the empty controlled Campaign source
    // through its current handler/receipts; never seed a readiness flag.
    await runOperation('campaign', 'fetch_campaigns', m.campaignsHandler, {
      request: async input => { assert.equal(input.endpoint.method, 'GET');
        assert.equal(input.source, 'backend.readonly.fetch_campaigns.list');
        providerCalls.push({ source: input.source, path: input.endpoint.path });
        return { ok: true, status: 200, data: { list: [], hasMore: false, total: 0 } }; }
    }, Object.fromEntries(['campaignCausalObservationV1', 'campaignServerFanRefreshV1', 'campaignResumablePaginationV1',
      'campaignFreshnessCoverageV1', 'campaignOrderIndependentTraversalV1', 'campaignSegmentedFairTraversalV1',
      'campaignFrontierSchedulingV1', 'campaignDirectoryReuseV1', 'campaignBoundedTraversalV1',
      'campaignTraversalAuthorityV1', 'campaignFairPagesV1', 'campaignSourceValidationV1'].map(key => [key, true])));

    const purchase = { id: 'team215-purchase-notice', type: 'purchased_message', messageId: '2152001', amount: 12,
      currency: 'USD', createdAt: new Date(Date.now() - 60000).toISOString(), user: { id: '2151001', username: 'team215_buyer' } };
    await runOperation('notification', 'catchup_notifications_scan', m.notificationsCatchupHandler, {
      onJob: job => { purchase.createdAt = new Date(Date.parse(job.params.to) - 1000).toISOString(); },
      request: async input => { assert.equal(input.endpoint.method, 'GET'); providerCalls.push({ source: input.source, path: input.endpoint.path });
        const q = new URL(input.endpoint.path, 'https://provider.invalid').searchParams, type = q.get('type');
        return { ok: true, status: 200, data: { list: (!type || type === 'all' || /purchase|paid|earnings/i.test(type)) && !q.get('fromId') ? [purchase] : [], hasMore: false } }; }
    });
    await until(async () => { results.claims = await claims.getWorkspace({ includeClosedPpv: true }); return results.claims.ppv.some(row => row.messageId === '2152001'); }, 'Canonical PPV reconciliation missing');
    const ppv = results.claims.ppv.find(row => row.messageId === '2152001');
    assert.equal(ppv.amountCents, 1200);
    await until(async () => { results.moneySnapshot = await analytics.getSnapshot({ rangeKey: '24h' });
      return results.moneySnapshot.overview.revenueByCurrency?.USD === 3700; }, 'Gross USD attribution did not converge');
    assert.equal(results.moneySnapshot.overview.manualMessages, 3);
    pass('Actual notification handler -> current job progress -> canonical PPV -> original human sender -> gross USD Team read');

    const renderer = path.join(desktop, 'apps/desktop/renderer/src'), entry = path.join(scratch, 'team215-renderer.tsx'), script = path.join(scratch, 'team215-renderer.js');
    fs.writeFileSync(entry, `import React from 'react';import{createRoot}from'react-dom/client';
import{TeamAnalyticsWorkspace}from ${JSON.stringify(path.join(renderer, 'features/team-analytics/TeamAnalyticsWorkspace.tsx'))};
import{acceptRendererAuthorizationProjection}from ${JSON.stringify(path.join(renderer, 'shared/rpc/authorization-scope.ts'))};
import ${JSON.stringify(path.join(renderer, 'styles.css'))};
export function mount(input){window.nod={events:{onDesktopAuthorizationEvent:()=>()=>{},onCreatorRuntimeEvent:()=>()=>{}},rpc:{call:async(method,payload)=>{const r=await window.actualRpc(method,payload);if(r.error)throw Object.assign(Error(r.error.message),r.error);return r.result;}}};acceptRendererAuthorizationProjection(input.projection);createRoot(document.getElementById('root')).render(<React.StrictMode><TeamAnalyticsWorkspace session={input.session}/></React.StrictMode>);}`);
    await load('esbuild').build({ entryPoints: [entry], outfile: script, bundle: true, platform: 'browser', format: 'iife', globalName: 'ActualTeam215', jsx: 'automatic',
      nodePaths: [path.join(desktop, 'node_modules')], alias: { '@nod/shared': path.join(desktop, 'packages/shared/src/index.ts') },
      loader: { '.css': 'css', '.png': 'dataurl', '.svg': 'dataurl', '.ttf': 'dataurl' }, define: { 'process.env.NODE_ENV': '"development"' } });
    server = http.createServer((req, res) => { const file = req.url === '/app.js' ? script : req.url === '/app.css' ? script.replace(/js$/, 'css') : null;
      res.setHeader('Content-Type', file ? file.endsWith('.js') ? 'application/javascript' : 'text/css' : 'text/html');
      res.end(file ? fs.readFileSync(file) : '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const chromiumModule = runtime('@sparticuz/chromium'), chromium = chromiumModule.default || chromiumModule;
    browser = await runtime('playwright').chromium.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true });
    page = await browser.newPage({ viewport: { width: 1536, height: 1050 } }); page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(error.message));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    const handlers = m.createTeamAnalyticsHandlers(analytics, authority);
    await page.exposeFunction('actualRpc', async (method, input) => { calls.push({ method, input });
      try { assert.ok(handlers[method], 'Unexpected renderer call ' + method); return { result: await handlers[method](input) }; }
      catch (error) { return { error: { message: error.message, code: error.code, status: error.status } }; } });
    await page.goto(origin);
    const rendererSession = { ...authStore.readSession(), accessToken: undefined, refreshToken: undefined, permissions };
    await page.evaluate(input => window.ActualTeam215.mount(input), { session: rendererSession, projection: { ok: true, authenticated: true,
      current: true, quarantineState: 'CURRENT', localAuthorizationRevision: 1, session: rendererSession, creators: state.creators, activeCreatorId: c } });
    await page.locator('.ta-hero').getByText(/\$37\.00/).waitFor();
    await page.getByRole('navigation', { name: 'Team Analytics views' }).getByRole('button', { name: /^Chatters/ }).click();
    await page.locator('.ta-chatter-card').getByText('Acceptance owner', { exact: true }).waitFor();
    const chatterText = await page.locator('.ta-chatter-card').innerText();
    assert.ok(chatterText.includes('$12.00'));
    assert.ok(chatterText.includes('$12.33'));
    results.renderer = { errors, renderedText: (await page.locator('#root').innerText()).slice(0, 20000), calls };
    assert.equal(errors.length, 0, errors.join('\n'));
    pass('Actual TeamAnalyticsWorkspace in Chromium reads current authorized USD-only gross revenue and observed activity with no renderer errors');

    await f.stop('SIGKILL'); await f.boot();
    const after = await analytics.getSnapshot({ rangeKey: '24h' });
    assert.equal(after.overview.manualMessages, 3);
    assert.deepEqual(after.overview.revenueByCurrency, { USD: 3700 });
    const retained = await f.withDatabase(async db => ({
      sent: await db.teamSentMessageLedger.findMany({ where: { agencyId }, select: { creatorId: true, messageId: true, memberId: true } }),
      facts: await db.teamMoneyAttributionFact.findMany({ where: { agencyId }, select: { amountCents: true, currency: true, memberId: true, attributionActive: true } }),
      responses: await db.teamResponseCase.findMany({ where: { agencyId }, select: { replyMessageId: true, classification: true, slaEligible: true } }),
    }));
    assert.equal(retained.sent.length, 3);
    assert.equal(retained.facts.filter(row => row.attributionActive).length, 2);
    results.retained = retained;
    pass('Backend SIGKILL/restart retains one canonical owner, gross money, response evidence and exact activity totals');
  } finally {
    clearInterval(renew);
    if (page) results.rendererObserved = { errors, text: (await page.locator('#root').innerText()).slice(0, 20000) };
    if (analytics) await analytics.destroy();
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
    results.team215Trace = { logs, calls, errors, telemetry, providerCalls };
  }
};

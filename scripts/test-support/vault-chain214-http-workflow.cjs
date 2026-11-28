'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createRequire } = require('node:module');

// Current production services, HTTP server, PostgreSQL, SQLite journals and
// React views. Only the read-only provider and explicit transport faults are
// controlled; no sale, asset usage, job completion or coverage is SQL-seeded.
exports.runVault214 = async function runVault214(f) {
  const { modules: m, desktop, scratch, output, auth, api, agencyId, deviceId,
    creatorId: c, creatorIds, must, pass, results } = f;
  const load = createRequire(path.join(desktop, 'package.json'));
  const runtime = createRequire(path.join(process.env.ONLINOD_BROWSER_RUNTIME, 'package.json'));
  const logs = [], requests = [], calls = [], errors = [], providerCalls = [];
  const log = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, (...args) => logs.push({
    level, args: JSON.parse(JSON.stringify(args, (_key, value) => value instanceof Error
      ? { message: value.message, code: value.code, stack: value.stack } : value)),
  })]));
  const authStore = { ...auth, readSession: () => ({ ...auth.readSession(), deviceId }), getDeviceId: () => deviceId,
    getAuthorizationScopeHash: () => agencyId + ':' + deviceId, getActiveCreatorId: () => c,
    setActiveCreatorId() {}, onSessionChanged: () => () => {} };
  const serviceApi = { ...api, deviceId };
  const authService = { ensureSession: async () => ({ authenticated: true, session: authStore.readSession() }) };
  const permissions = { ...f.login.permissions, 'money.view_earnings': true, 'content.manage_vault': true,
    'creator_analytics.refresh': true, 'chats.read': true };
  const authority = new m.DesktopCurrentAuthorizationAuthorityService({ log, authStore,
    accessRuntime: { currentAuthorityProof: () => ({ accessEpoch: 1, creatorCatalogGeneration: 1 }),
      allowedCreatorIdsSnapshot: () => creatorIds } });
  const publish = () => authority.publish({ accessEpoch: 1, creatorCatalogGeneration: 1, role: 'OWNER', roleKey: 'owner',
    effectivePermissions: permissions, allowedCreatorIds: creatorIds, observedAt: Date.now(), observedAtMono: performance.now(),
    billing: { version: 1, validForMs: 90000, creators: creatorIds.map(creatorId => ({ creatorId, allowed: true,
      validForMs: 90000, reason: 'TRIAL' })) } }, 'Vault acceptance authority', { renewUnchanged: true });
  publish();
  const now = Date.now(), at = minutes => new Date(now - minutes * 60000).toISOString();
  const fanId = '2148001', messageId = '2147001', transactionId = 'vault-payment-214';
  const fan = { id: fanId, username: 'vault_buyer_214', name: 'Vault buyer' };
  let netCents = 803, financialStatus = 'done', loseLiveReply = false, loseDialogReply = false;
  let holdDetails = null, failDiagnostics = false;
  let traceAt = 0;
  const rawMessage = { id: messageId, fromUser: { id: '100001' }, toUser: { id: fanId },
    createdAt: at(1440), text: 'Synthetic purchased package', price: 10.04, isOpened: true, isFree: false,
    media: [{ id: '2149002', type: 'photo', userId: '100001' },
      { id: '2149999', type: 'photo', userId: fanId }, { id: '2149001', type: 'photo', userId: '100001' }] };
  const notice = { id: 'vault-notice-214', type: 'paided_message', subType: 'subscriber_pay_for_chat_message',
    amount: 10.04, currency: 'USD', transactionId, messageId, user: fan, createdAt: at(5) };
  const catalog = ['2149001', '2149002', '2149999'].map(id => ({ id, type: 'photo', createdAt: at(2000), lists: [],
    files: { thumb: { url: 'https://fixture.invalid/' + id + '-thumb' }, preview: { url: 'https://fixture.invalid/' + id + '-preview' },
      full: { url: 'https://fixture.invalid/' + id } } }));
  const transactions = () => [{ id: transactionId, descriptionDetails: { type: 'message' }, amount: 10.04,
    net: netCents / 100, fee: (1004 - netCents) / 100, status: financialStatus, currency: 'USD', createdAt: notice.createdAt, user: fan }];
  const success = data => ({ ok: true, status: 200, data });
  const ofApi = { getStatus: () => ({ status: { rulesReady: true, hasAppToken: true, hasXBc: true, hasUserId: true } }),
    async request(input) {
      assert.equal(input.endpoint.method, 'GET', 'Vault sales proof must not send provider writes');
      providerCalls.push({ source: input.source, creatorId: input.creatorId, path: input.endpoint.path });
      const u = new URL(input.endpoint.path, 'https://provider.fixture'), q = u.searchParams, own = input.creatorId === c;
      if (input.source === 'backend.dialog-intelligence.targeted') return success(rawMessage);
      if (input.source === 'backend.dialog-intelligence.discovery') return success({ list: [], hasMore: false });
      if (input.source.startsWith('backend.dialog-intelligence.')) return success({ list: own ? [rawMessage] : [], hasMore: false });
      if (input.source.startsWith('backend.readonly.notifications_')) {
        const type = q.get('type');
        return success({ list: own && !q.get('fromId') && (!type || type === 'all' || type === 'paided_message' || type === 'purchases') ? [notice] : [], hasMore: false });
      }
      if (input.source === 'backend.readonly.fetch_earnings.chart') {
        const rows = own && financialStatus === 'done' && notice.createdAt.slice(0, 10) >= String(q.get('startDate')).slice(0, 10)
          && notice.createdAt.slice(0, 10) <= String(q.get('endDate')).slice(0, 10) ? transactions() : [];
        return success({ total: { total_amount: rows.length ? netCents / 100 : 0, gross_amount: rows.length ? 10.04 : 0,
          total_count: rows.length }, chart: rows.map(row => ({ date: row.createdAt.slice(0, 10), amount: row.net })) });
      }
      if (input.source === 'backend.readonly.financial_transactions.payouts') {
        const from = q.get('startDate')?.replace(' ', 'T'), marker = Number(q.get('marker'));
        const rows = own ? transactions().filter(row => (!from || Date.parse(row.createdAt) >= Date.parse(from.endsWith('Z') ? from : from + 'Z'))
          && (!marker || Date.parse(row.createdAt) / 1000 <= marker)) : [];
        return success({ list: rows, hasMore: false });
      }
      if (input.source.startsWith('backend.readonly.financial_transactions.chart.')) {
        const category = input.source.split('.').at(-1), key = category === 'messages' ? 'chat_messages' : category;
        const included = own && financialStatus === 'done' && ['total', 'messages'].includes(category)
          && notice.createdAt.slice(0, 10) >= String(q.get('startDate')).slice(0, 10)
          && notice.createdAt.slice(0, 10) <= String(q.get('endDate')).slice(0, 10);
        return success({ [key]: { gross: included ? 10.04 : 0, total: included ? netCents / 100 : 0, count: included ? 1 : 0 } });
      }
      if (input.source === 'backend.readonly.fetch_campaigns.list' || input.source === 'backend.readonly.subscriber_directory')
        return success({ list: [], hasMore: false, total: 0 });
      if (input.source === 'backend.readonly.fan_data_point_refresh') return success(fan);
      if (u.pathname.includes('/vault/lists') && !u.pathname.endsWith('/media'))
        return success({ all: { count: own ? catalog.length : 0 }, list: own ? [{ id: 'messages', name: 'Messages', type: 'messages', count: catalog.length }] : [], hasMore: false });
      if (u.pathname.includes('/vault/media') || u.pathname.endsWith('/media')) {
        const offset = Number(q.get('offset') || 0), limit = Number(q.get('limit') || 100), rows = own ? catalog : [];
        return success({ list: rows.slice(offset, offset + limit), hasMore: offset + limit < rows.length });
      }
      throw Error('UNEXPECTED_PROVIDER_REQUEST ' + JSON.stringify({ source: input.source, path: input.endpoint.path }));
    } };
  const capabilities = { canRun: () => ({ allowed: true }), onChanged: () => () => {}, get: creatorId => ({
    api: { readReady: true, writeReady: true }, browser: { pageLocalReady: false, materialized: false, presentable: false },
    identity: { state: 'VERIFIED', platformUserId: creatorId === c ? '100001' : '100002', sessionProofEpoch: 1 },
    access: { accessEpoch: 1 }, session: { partition: 'persist:vault214:' + creatorId, sessionEpoch: 1,
      canonicalRevision: 1, networkRevision: 0, runtimeGeneration: 1 }, realtime: { ready: true, lastInboundFrameAt: at(0) } }) };
  const creatorRuntime = { getVerifiedIdentity: creatorId => ({ platformUserId: creatorId === c ? '100001' : '100002' }),
    getState: () => ({ attached: true, websocket: { connected: true }, lastEventAt: at(0) }), getAll: () => ({}),
    on: () => () => {}, onStateChanged: () => () => {}, registerChangeAdapter: () => () => {},
    getManagedRealtimeLastInboundFrameAt: () => null };
  const creatorService = m.createCreatorService(authStore, authService);
  let coordinator, worker, conversation, dialogs, media, sales, vault, analytics, unbindUsage;
  const commands = new m.ManagementCommandTransport(api, authStore, path.join(scratch, 'vault214-commands.json'), authority, () => {});
  const home = new m.HomeService({ log, authStore, authService, api: serviceApi, authorization: authority });
  const makeServices = () => {
    coordinator = new m.WorkCoordinatorService({ log, databasePath: path.join(scratch, 'vault214-work.sqlite') });
    coordinator.setCapabilityResolver((...args) => capabilities.canRun(...args));
    coordinator.setAuthorizationResolver(({ item, authorizationClass, provenance }) => authorizationClass === 'HUMAN_COMMAND'
      ? authority.evaluateHumanCommandProvenance(provenance) : authorizationClass === 'CURRENT_DATA_PROCESS'
        ? authority.evaluateCurrentDataProcess(item.creatorId) : { allowed: true });
    coordinator.setControlAuthorizationResolver({ allowedCreatorIds: () => creatorIds, authorizeCreator: () => ({ allowed: true }) });
    media = new m.MediaLibraryService({ log, authStore, authService, authorization: authority, coordinator, managementCommands: commands });
    conversation = new m.ConversationClient(new m.BackendApiClient(authStore, authService), authority, log);
    dialogs = new m.DialogMessagesService({ log, conversationClient: conversation, ofApi, creatorRuntime, workCoordinator: coordinator,
      computeWorker: { execute: async () => { throw Error('UNEXPECTED_COMPUTE_WORK'); } },
      ai: { infer: async () => { throw Error('UNEXPECTED_AI_WORK'); } }, authorization: authority, mediaUsageSink: media });
    unbindUsage = media.bindUsageSourceProvider(dialogs);
    sales = new m.VaultSalesService(authStore, authService, dialogs, media, authority, commands);
    vault = new m.VaultService({ log, ofApi, authorization: authority, coordinator,
      directoryBackend: new m.VaultDirectoryBackendService(authStore, authService, media, undefined, commands), mediaLibrary: media,
      getMainWindow: () => null });
    analytics = new m.CreatorAnalyticsService({ log, authStore, authService, api: serviceApi, authorization: authority, managementCommands: commands });
    worker = new m.BackendReadonlyJobWorker({ log, authStore, authService, creatorService, capabilities, creatorRuntime,
      coordinator, ofApi, accessRuntime: { captureAuthorizationScopePermit: () => ({}), isAuthorizationScopePermitCurrent: () => true,
        revokeCreator() { throw Error('UNEXPECTED_REVOKE'); } }, apiRuntime: { getAll: () => ({}) },
      backgroundRuntime: { isBackground: () => true }, events: { emit() {} },
      sessionReconcile: { reconcileDurableAccessCatalog: async () => {}, observeCanonicalManifests() {}, observeNetworkManifests() {},
        hardRevokeCreator() { throw Error('UNEXPECTED_REVOKE'); }, hardRevokeAll() { throw Error('UNEXPECTED_LOGOUT'); } } });
    worker.setDialogLocalChunkSink({ commitDialogPage: input => dialogs.commitTargetedMessagePage(input),
      commitPurchaseSignals: async () => { throw Error('RETIRED_PURCHASE_SIGNAL'); } });
  };
  makeServices();
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input)); assert.equal(url.origin, api.apiBase);
    const body = options?.body ? JSON.parse(options.body) : null;
    if (failDiagnostics && /\/dialog-intelligence\/creators\/[^/]+\/diagnostics$/.test(url.pathname))
      return Response.json({ code: failDiagnostics === 403 ? 'FORBIDDEN' : 'CONTROLLED_DIAGNOSTICS_UNAVAILABLE', error: 'Controlled diagnostics boundary' }, { status: Number(failDiagnostics) || 503 });
    const response = await nativeFetch(input, options);
    requests.push({ path: url.pathname, method: options?.method || 'GET', status: response.status,
      target: body?.target, operation: body?.method, chunk: body?.chunkResult?.kind });
    if (loseDialogReply && body?.target === 'messages' && body?.method === 'commitScanPage' && response.ok) {
      loseDialogReply = false; await response.clone().text(); results.lostDialogReply = true;
      throw Error('CONTROLLED_LOST_DIALOG_COMMIT_REPLY');
    }
    if (loseLiveReply && /\/notifications\/live$/.test(url.pathname) && response.ok) {
      loseLiveReply = false; await response.clone().text(); results.lostLiveReply = true;
      throw Error('CONTROLLED_LOST_LIVE_REPLY');
    }
    return response;
  };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (fn, label, timeout = 120000) => {
    const end = Date.now() + timeout;
    for (;;) {
      try { if (await fn()) return; } catch (e) {
        if (!['API_RATE_LIMITED', 'DESKTOP_AUTHORIZATION_PERMIT_STALE', 'CONVERSATION_STORAGE_UNAVAILABLE'].includes(e.code)) throw e;
        logs.push({ controlledWait: e.code }); await wait(Math.min(30000, Number(e.payload?.retryAfterMs) || 1000));
      }
      if (Date.now() - traceAt > 5000) { traceAt = Date.now(); fs.writeFileSync(path.join(output, 'checkpoint.json'), JSON.stringify({ phase: label, health: worker.health(), live: analytics.live.health(), lastProvider: providerCalls.slice(-12), lastRequests: requests.slice(-8), lastLogs: logs.slice(-5) }, null, 2)); }
      if (Date.now() > end) throw Error(label + '\n' + JSON.stringify({ health: worker.health(), lastLogs: logs.slice(-10), provider: providerCalls.slice(-20) }));
      await wait(1000);
    }
  };
  const emit = row => {
    const events = m.normalizeRuntimeWsFrame({ direction: 'in', data: JSON.stringify({ new_message: row }), ts: Date.now() }, { accountId: c });
    assert.ok(events.length); results.lastEmittedTypes = events.map(event => event.type); for (const event of events) analytics.handleRuntimeEvent({ creatorId: c, event });
  };
  const handlers = () => ({ ...m.createVaultSalesHandlers(sales), ...m.createVaultHandlers(vault), ...m.createMediaLibraryHandlers(media),
    'managementCommands.listPending': () => commands.listPending(), 'managementCommands.acknowledge': i => commands.acknowledge(i.commandId),
    'managementCommands.retry': i => commands.retry(i.commandId) });
  let renewal, browser, context, server, page;
  const stopServices = async () => {
    await worker.stop(); await analytics.destroy(); unbindUsage?.(); await dialogs.destroy(); await conversation.destroy();
    await media.destroy(); await vault.destroy(); await coordinator.destroy();
  };
  try {
    renewal = setInterval(publish, 30000);
    const creators = await Promise.all(creatorIds.map(async id => (await must('GET', '/api/creators/' + id)).creator));
    const renderer = path.join(desktop, 'apps/desktop/renderer/src'), entry = path.join(scratch, 'vault214-renderer.tsx'), script = path.join(scratch, 'vault214-renderer.js');
    fs.writeFileSync(entry, `import React from 'react';import{createRoot}from'react-dom/client';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';
import{VaultDashboard}from ${JSON.stringify(path.join(renderer, 'features/vault/VaultDashboard.tsx'))};
import{VaultAssetSalesPanel}from ${JSON.stringify(path.join(renderer, 'features/vault/VaultAssetSalesPanel.tsx'))};
import{acceptRendererAuthorizationProjection}from ${JSON.stringify(path.join(renderer, 'shared/rpc/authorization-scope.ts'))};
import ${JSON.stringify(path.join(renderer, 'styles.css'))};
const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});let root;let input;
export function mount(i){input=i;window.nod={events:{onDesktopAuthorizationEvent:()=>()=>{},onCreatorRuntimeEvent:()=>()=>{}},rpc:{call:async(method,payload)=>{const r=await window.actualRpc(method,payload);if(r.error)throw Object.assign(Error(r.error.message),{code:r.error.code});return r.result;}}};acceptRendererAuthorizationProjection(i.projection);show(false);}
export function show(sales){root?.unmount();root=createRoot(document.getElementById('root'));root.render(<React.StrictMode><QueryClientProvider client={client}>{sales?<VaultAssetSalesPanel creators={input.creators} activeCreator={input.creators[0]} onBack={()=>show(false)}/>:<VaultDashboard creators={input.creators} activeCreator={input.creators[0]}/>}</QueryClientProvider></React.StrictMode>);}
export function unmount(){root?.unmount();}`);
    await load('esbuild').build({ entryPoints: [entry], outfile: script, bundle: true, platform: 'browser', format: 'iife', globalName: 'ActualVault214',
      jsx: 'automatic', nodePaths: [path.join(desktop, 'node_modules')], alias: { '@nod/shared': path.join(desktop, 'packages/shared/src/index.ts') },
      loader: { '.css': 'css', '.png': 'dataurl', '.svg': 'dataurl', '.ttf': 'dataurl' }, define: { 'process.env.NODE_ENV': '"development"' } });
    server = http.createServer((req, res) => {
      const file = req.url === '/app.js' ? script : req.url === '/app.css' ? script.replace(/js$/, 'css') : null;
      res.setHeader('Content-Type', file ? file.endsWith('js') ? 'application/javascript' : 'text/css' : 'text/html');
      res.end(file ? fs.readFileSync(file) : '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { default: chromium } = await import(require('node:url').pathToFileURL(runtime.resolve('@sparticuz/chromium')).href);
    browser = await runtime('playwright').chromium.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1050 } }); page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', e => { if (e.type() === 'error' && /same key|React/.test(e.text())) errors.push(e.text()); });
    const origin = 'http://127.0.0.1:' + server.address().port;
    await page.route('**/*', r => r.request().url().startsWith(origin) ? r.continue() : r.abort());
    await page.exposeFunction('actualRpc', async (method, input) => {
      calls.push({ method, input });
      try {
        if (holdDetails && method === 'vaultSales.listPurchases' && input.creatorId === c) { const gate = holdDetails; holdDetails = null; gate.enter(); await gate.promise; }
        assert.ok(handlers()[method], 'Unexpected RPC ' + method); return { result: await handlers()[method](input) };
      } catch (e) { return { error: { message: e.message, code: e.code } }; }
    });
    page.setDefaultTimeout(20000); await page.goto(origin);
    const mount = { creators, session: { ...authStore.readSession(), permissions }, projection: { ok: true, authenticated: true, current: true,
      quarantineState: 'CURRENT', localAuthorizationRevision: 1, session: { ...authStore.readSession(), accessToken: undefined, refreshToken: undefined },
      creators, activeCreatorId: c } };
    await page.evaluate(i => ActualVault214.mount(i), mount);
    await until(async () => await page.locator('.hq-vault-asset').count() === 3, 'Current Vault catalog did not load');
    pass('Actual Vault Dashboard reads current provider media through the authenticated Desktop services');
    const catalogRun = await vault.startUnsortedScan({ creatorId: c, mode: 'full' }); assert.equal(catalogRun.ok, true);
    if (catalogRun.commandId) commands.acknowledge(catalogRun.commandId);
    await home.refresh({ rangeKey: '7d' });
    const notificationRun = await analytics.startNotificationScan({ creatorId: c }); commands.acknowledge(notificationRun.commandId);
    loseDialogReply = true; coordinator.start(); worker.start(); emit(notice);
    await until(async () => {
      results.catalog = await vault.getUnsortedState({ creatorId: c });
      return results.catalog.snapshot?.scan?.status === 'COMPLETED';
    }, 'Current catalog job did not complete', 180000);
    await until(async () => {
      results.purchases = await sales.listPurchases({ creatorId: c, offset: 0, limit: 50 });
      return results.purchases.items.some(row => row.sourceMessageId === messageId);
    }, 'Canonical notification did not resolve its exact message into the Dialogs store', 360000);
    const purchase = results.purchases.items.find(row => row.sourceMessageId === messageId);
    assert.deepEqual(purchase.media.map(row => row.mediaId).sort(), ['2149001', '2149002']);
    assert.deepEqual(purchase.media.map(row => row.allocatedCents).sort(), [502, 502]);
    assert.equal(purchase.amountBasis, 'MESSAGE_PRICE'); assert.equal(purchase.purchasedAt, null);
    assert.equal(purchase.sentAt, rawMessage.createdAt);
    assert.equal(results.lostDialogReply, true);
    pass('Notification → exact message → real conversation journal and PostgreSQL retain only creator media, with one recovered lost commit response');
    await until(async () => {
      results.sales = await media.getSalesSummary(c);
      return results.sales.revenueAvailable && results.sales.revenueCents === 803;
    }, 'Canonical NET did not converge to the exact package total', 360000);
    results.assets = await sales.listAssets({ creatorId: c, offset: 0, limit: 50 });
    assert.equal(results.sales.totalSales, 2);
    assert.deepEqual(results.assets.items.map(row => [row.mediaId, row.totalRevenueCents]).sort(), [['2149001', 402], ['2149002', 401]]);
    assert.equal(results.assets.items.reduce((sum, row) => sum + row.totalRevenueCents, 0), 803);
    assert.equal(results.assets.items.some(row => row.mediaId === '2149999' && row.soldCount > 0), false);
    assert.equal((await media.getSalesSummary(creatorIds[1])).revenueCents, 0);
    pass('Canonical financial collector and per-media projection conserve803cents across two creator files and isolate the other creator');
    await page.evaluate(() => ActualVault214.show(true));
    await page.getByText('$8.03', { exact: true }).first().waitFor();
    await page.getByText('$10.04', { exact: true }).first().waitFor();
    await page.screenshot({ animations: 'disabled', path: path.join(output, 'vault-sales-current.png') });
    pass('Actual current Vault sales interface presents canonical NET and the separate message package price');
    // Same source notification traverses the real WS normalizer and local
    // durable outbox; its committed reply is deliberately lost.
    loseLiveReply = true; emit(notice);
    await until(async () => results.lostLiveReply === true && !analytics.live.health().flushing, 'Lost live reply was not exercised');
    assert.ok(analytics.live.health().pending > 0);
    await stopServices(); const killed = await f.stop('SIGKILL'); assert.equal(killed.signal, 'SIGKILL'); await f.boot();
    publish(); makeServices(); coordinator.start(); worker.start();
    await until(async () => analytics.live.health().pending === 0, 'Reopened SQLite outbox did not acknowledge the original event');
    results.restarted = await sales.getDashboard({ creatorId: c });
    assert.equal(results.restarted.summary.revenueCents, 803); assert.equal(results.restarted.summary.totalSales, 2);
    assert.equal((await sales.listPurchases({ creatorId: c, offset: 0, limit: 50 })).count, 1);
    pass('Lost live ACK, backend SIGKILL and reopened SQLite journals preserve one purchased message and exact per-file totals');
    const messageReadsBeforeCorrection = providerCalls.filter(row => row.source === 'backend.dialog-intelligence.targeted').length;
    netCents = 1001; await home.refresh({ rangeKey: '7d' }); worker.scheduleImmediateClaim();
    await until(async () => { results.corrected = await media.getSalesSummary(c); return results.corrected.revenueAvailable && results.corrected.revenueCents === 1001; },
      'Canonical financial correction did not reprice the same media set', 240000);
    assert.equal(results.corrected.totalSales, 2);
    assert.equal(providerCalls.filter(row => row.source === 'backend.dialog-intelligence.targeted').length, messageReadsBeforeCorrection);
    await page.evaluate(() => ActualVault214.show(true)); await page.getByText('$10.01', { exact: true }).first().waitFor();
    pass('A later canonical NET correction reprices the same two files without another gallery or message scan');
    failDiagnostics = 503;
    const partialStatus = await sales.getDashboard({ creatorId: c });
    assert.equal(partialStatus.collectionAvailable, false); assert.equal(partialStatus.summary.revenueCents, 1001);
    await page.evaluate(() => ActualVault214.show(true));
    await page.locator('.vault-sales-meta > span').filter({ hasText: 'Status unavailable' }).waitFor();
    await page.getByText('$10.01', { exact: true }).first().waitFor();
    failDiagnostics = 403;
    await assert.rejects(sales.getDashboard({ creatorId: c }), error => error.status === 403);
    failDiagnostics = false;
    assert.equal((await sales.getDashboard({ creatorId: c })).collectionAvailable, true);
    await page.evaluate(() => ActualVault214.show(true));
    await page.getByText('$10.01', { exact: true }).first().waitFor();
    results.diagnosticsFaults = { transientPreservesSummary: true, unknownStatusVisible: true, forbiddenPropagates: true, recovered: true };
    pass('Actual HTTP diagnostics503 retains verified sales and shows unknown collection state;403 propagates and a later healthy read recovers');
    assert.deepEqual(errors, []); results.browserVersion = await browser.version();
  } finally {
    clearInterval(renewal);
    results.renderer = { errors, calls, requests }; results.provider = { calls: providerCalls, externalWrites: 0 };
    results.workerHealth = worker?.health();
    if (page) await page.screenshot({ animations: 'disabled', timeout: 30000, path: path.join(output, 'last-screen.png') }).catch(() => {});
    await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await stopServices().catch(e => { logs.push({ shutdownError: e.message }); });
    globalThis.fetch = nativeFetch;
    fs.writeFileSync(path.join(output, 'desktop-log.json'), JSON.stringify(logs, null, 2));
  }
};

"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const { createRequire } = require("node:module");

// This workflow drives the actual server, Desktop worker, durable SQLite outbox
// and current React overview. Only read-only provider responses and transport
// failures are controlled; no facts, completion flags or publication are seeded.
exports.runNotifications = async function runNotifications(f) {
  const { modules: m, desktop, scratch, output, auth, api, agencyId, deviceId, creatorId: c, creatorIds, pass, results } = f;
  const load = createRequire(path.join(desktop, "package.json"));
  const runtime = createRequire(path.join(process.env.ONLINOD_BROWSER_RUNTIME || process.env.ONLINOD_SQL_PROOF_RUNTIME, "package.json"));
  const logs = [], calls = [], errors = [], requests = [], providerCalls = [];
  const log = Object.fromEntries(["debug", "info", "warn", "error"].map(level => [level, (...args) => logs.push({ level,
    args: JSON.parse(JSON.stringify(args, (_key, value) => value instanceof Error ? { message: value.message, code: value.code } : value)) })]));
  const authStore = { ...auth, readSession: () => ({ ...auth.readSession(), deviceId }), getDeviceId: () => deviceId,
    getAuthorizationScopeHash: () => agencyId + ":" + deviceId, getActiveCreatorId: () => c,
    setActiveCreatorId: () => {}, onSessionChanged: () => () => {} };
  const authService = { ensureSession: async () => ({ authenticated: true, session: authStore.readSession() }) };
  const permissions = { "money.view_earnings": true, "creator_analytics.refresh": true, "traffic.view": true };
  const authority = new m.DesktopCurrentAuthorizationAuthorityService({ log, authStore,
    accessRuntime: { currentAuthorityProof: () => ({ accessEpoch: 1, creatorCatalogGeneration: 1 }), allowedCreatorIdsSnapshot: () => creatorIds } });
  const publishAuthority = () => authority.publish({ accessEpoch: 1, creatorCatalogGeneration: 1, role: "OWNER", roleKey: "owner",
    effectivePermissions: permissions, allowedCreatorIds: creatorIds, observedAt: Date.now(), observedAtMono: performance.now(),
    billing: { version: 1, validForMs: 90000, creators: creatorIds.map(creatorId => ({ creatorId, allowed: true, validForMs: 90000, reason: "TRIAL" })) } },
    "notification acceptance authority", { renewUnchanged: true });
  publishAuthority();
  let failStatusRead = false;
  const serviceApi = { ...api, deviceId, async request(url, options) {
    if (failStatusRead && /\/notification-scan\?/.test(url)) throw Object.assign(Error("CONTROLLED_STATUS_503"), { code: "HTTP_503" });
    return api.request(url, options);
  } };
  const commands = new m.ManagementCommandTransport(serviceApi, authStore, path.join(scratch, "notification-commands.json"), authority, () => {});
  const home = new m.HomeService({ log, authStore, authService, api: serviceApi, authorization: authority });
  let analytics;
  const makeAnalytics = () => { analytics = new m.CreatorAnalyticsService({ log, authStore, authService, api: serviceApi,
    authorization: authority, managementCommands: commands }); };
  makeAnalytics();
  const creatorService = m.createCreatorService(authStore, authService);
  const capabilities = { canRun: () => ({ allowed: true }), onChanged: () => () => {}, get: creatorId => ({
    api: { readReady: true, writeReady: true }, browser: { pageLocalReady: false, materialized: false, presentable: false },
    identity: { state: "VERIFIED", platformUserId: creatorId === c ? "100001" : "100002", sessionProofEpoch: 1 }, access: { accessEpoch: 1 },
    session: { partition: "persist:notifications:" + creatorId, sessionEpoch: 1, canonicalRevision: 1, networkRevision: 0, runtimeGeneration: 1 },
    realtime: { ready: true, lastInboundFrameAt: new Date().toISOString() },
  }) };
  const creatorRuntime = { getVerifiedIdentity: creatorId => ({ platformUserId: creatorId === c ? "100001" : "100002" }),
    getState: () => ({ attached: true, websocket: { connected: true }, lastEventAt: new Date().toISOString() }), on: () => () => {},
    registerChangeAdapter: () => () => {} };
  const now = Date.now(), at = minutes => new Date(now - minutes * 60000).toISOString();
  const fan = id => ({ id: String(id), username: "notification_fan_" + id, name: "Notification Fan " + id });
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: "notice-sub-" + String(12 - i).padStart(3, "0"), type: "subscribed",
    createdAt: at(10 + i), user: fan(21200 + i), ...(i === 0 ? { amountCents: "", amount: 5 } : i === 11 ? {} : { amount: 0 }) }));
  rows.push({ id: "notice-like", type: "favorited", createdAt: at(30), user: fan(21200), postId: "42001" },
    { id: "notice-comment", type: "commented", createdAt: at(31), user: fan(21201), postId: "42001", commentId: "52001" },
    { id: "notice-tip", type: "tip", createdAt: at(32), user: fan(21202), amountCents: "", amount: "$5.00" },
    { id: "notice-other", type: "post_removed", createdAt: at(33), user: fan(21203), postId: "42002", amount: 5 });
  const provider = { gate: null, firstSubscriptionReads: 0 };
  const success = data => ({ ok: true, status: 200, data });
  const ofApi = { async request(input) {
    assert.equal(input.endpoint.method, "GET", "Notification acceptance never writes to a provider");
    const url = new URL(input.endpoint.path, "https://provider.fixture"), q = url.searchParams;
    providerCalls.push({ source: input.source, creatorId: input.creatorId, path: input.endpoint.path });
    if (provider.gate?.match(input)) {
      const gate = provider.gate; provider.gate = null; gate.enter();
      let aborted;
      try {
        await Promise.race([gate.releasePromise, new Promise((_, reject) => {
          aborted = () => reject(Object.assign(Error("Controlled provider read aborted"), { name: "AbortError" }));
          if (input.signal?.aborted) aborted(); else input.signal?.addEventListener("abort", aborted, { once: true });
        })]);
      } finally { if (aborted) input.signal?.removeEventListener("abort", aborted); }
    }
    if (input.source.startsWith("backend.readonly.notifications_")) {
      const filter = q.get("type");
      const eligible = input.creatorId === c ? rows.filter(row => !filter || row.type === filter || (filter === "tip" && row.type === "post_removed")) : [];
      eligible.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      const cursor = q.get("fromId"), index = cursor ? eligible.findIndex(row => row.id === cursor) + 1 : 0;
      if (cursor) assert(index > 0, "Provider cursor must identify an existing source row");
      if (filter === "subscribed" && !cursor && input.creatorId === c) provider.firstSubscriptionReads++;
      const limit = Number(q.get("limit") || 10);
      return success({ list: eligible.slice(index, index + limit), hasMore: index + limit < eligible.length });
    }
    if (input.source === "backend.readonly.fetch_earnings.chart") return success({ total: { total_amount: 0, gross_amount: 0, total_count: 0 }, chart: [] });
    if (input.source === "backend.readonly.financial_transactions.payouts") return success({ list: [], hasMore: false });
    if (input.source.startsWith("backend.readonly.financial_transactions.chart.")) {
      const category = input.source.split(".").at(-1), key = category === "messages" ? "chat_messages" : category;
      return success({ [key]: { gross: 0, total: 0, count: 0 } });
    }
    if (input.source === "backend.readonly.fetch_campaigns.list") return success({ list: [], hasMore: false, total: 0 });
    if (input.source === "backend.readonly.subscriber_directory") return success({ list: [], hasMore: false, total: 0 });
    if (input.source === "backend.readonly.fan_data_point_refresh") return success(fan(url.pathname.split("/").at(-1)));
    throw Error("UNEXPECTED_PROVIDER_REQUEST " + JSON.stringify({ source: input.source, path: input.endpoint.path }));
  } };
  let coordinator, worker;
  const makeWorker = () => {
    coordinator = new m.WorkCoordinatorService({ log, databasePath: path.join(scratch, "notification-work.sqlite") });
    coordinator.setCapabilityResolver((...args) => capabilities.canRun(...args));
    worker = new m.BackendReadonlyJobWorker({ log, authStore, authService, creatorService, capabilities, creatorRuntime, coordinator, ofApi,
      accessRuntime: { captureAuthorizationScopePermit: () => ({}), isAuthorizationScopePermitCurrent: () => true,
        revokeCreator: () => { throw Error("UNEXPECTED_REVOKE"); } }, apiRuntime: { getAll: () => ({}) },
      backgroundRuntime: { isBackground: () => true }, events: { emit: () => {} },
      sessionReconcile: { reconcileDurableAccessCatalog: async () => {}, observeCanonicalManifests: () => {}, observeNetworkManifests: () => {},
        hardRevokeCreator: () => { throw Error("UNEXPECTED_REVOKE"); }, hardRevokeAll: () => { throw Error("UNEXPECTED_LOGOUT"); } } });
  };
  makeWorker();
  let loseProgress = true, loseLiveReply = false, loseLegacyReply = false;
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input)); assert.equal(url.origin, api.apiBase);
    const response = await nativeFetch(input, options), body = options?.body ? JSON.parse(options.body) : null;
    requests.push({ path: url.pathname, method: options?.method || "GET", status: response.status, kind: body?.chunkResult?.kind });
    if (loseProgress && /\/api\/jobs\/[^/]+\/progress$/.test(url.pathname) && body?.chunkResult?.kind === "notification_facts_page_all" && response.ok) {
      loseProgress = false; await response.clone().text(); results.lostNotificationProgressReply = true;
      throw Error("CONTROLLED_LOST_NOTIFICATION_PROGRESS_REPLY");
    }
    if (loseLiveReply && /\/notifications\/live$/.test(url.pathname) && response.ok) {
      loseLiveReply = false; await response.clone().text(); results.lostLiveReply = true;
      throw Error("CONTROLLED_LOST_LIVE_REPLY");
    }
    if (loseLegacyReply && /\/notifications\/live$/.test(url.pathname) && response.ok
      && body?.events?.every(event => event.normalizerVersion === "notification-source-v2")) {
      loseLegacyReply = false; await response.clone().text(); results.lostLegacyReply = true;
      throw Error("CONTROLLED_LOST_LEGACY_UPGRADE_REPLY");
    }
    return response;
  };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (fn, label, timeout = 120000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      try { if (await fn()) return; } catch (error) { if (!/DESKTOP_AUTHORIZATION_PERMIT_STALE/.test(error.code || error.message)) throw error; }
      if (Date.now() > deadline) throw Error(label + "\n" + JSON.stringify({ health: worker.health(), logs: logs.slice(-8), sources: [...new Set(providerCalls.map(row => row.source))] }));
      await wait(200);
    }
  };
  const status = creatorId => analytics.getNotificationScan({ creatorId: creatorId || c });
  const overview = creatorId => analytics.getOverview({ creatorId: creatorId || c, rangeKey: "7d", force: true });
  const start = async creatorId => {
    const receipt = await analytics.startNotificationScan({ creatorId: creatorId || c });
    assert.equal(receipt.family, "notification"); assert.equal(receipt.operation, "start");
    assert.ok(receipt.commandId); assert.ok(receipt.committedControlRevision > 0); commands.acknowledge(receipt.commandId);
    return receipt;
  };
  const emit = source => {
    const events = m.normalizeRuntimeWsFrame({ direction: "in", data: JSON.stringify({ new_message: source }), ts: Date.now() }, { accountId: c });
    assert.ok(events.length, "Controlled frame must cross the actual runtime normalizer");
    for (const event of events) analytics.handleRuntimeEvent({ creatorId: c, event });
  };
  let renewal, server, browser, page;
  try {
    renewal = setInterval(publishAuthority, 30000);
    const creators = (await creatorService.list()).creators;
    const renderer = path.join(desktop, "apps/desktop/renderer/src"), fixture = path.join(scratch, "notifications-renderer.tsx"), script = path.join(scratch, "notifications-renderer.js");
    fs.writeFileSync(fixture, `import React from 'react';import{createRoot}from'react-dom/client';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';
import{CreatorAnalyticsWorkspace}from ${JSON.stringify(path.join(renderer, "features/creator-analytics/CreatorAnalyticsWorkspace.tsx"))};
import{acceptRendererAuthorizationProjection}from ${JSON.stringify(path.join(renderer, "shared/rpc/authorization-scope.ts"))};
import ${JSON.stringify(path.join(renderer, "styles.css"))};
const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});let root;
export function mount(input){window.nod={events:{onDesktopAuthorizationEvent:()=>()=>{},onCreatorRuntimeEvent:()=>()=>{}},rpc:{call:async(method,payload)=>{const r=await window.actualRpc(method,payload);if(r.error)throw Object.assign(Error(r.error.message),{code:r.error.code});return r.result;}}};acceptRendererAuthorizationProjection(input.projection);root=createRoot(document.getElementById('root'));root.render(<React.StrictMode><QueryClientProvider client={client}><CreatorAnalyticsWorkspace creators={input.creators} session={input.session} activeCreator={input.creators[0]}/></QueryClientProvider></React.StrictMode>);}
export async function refresh(){await client.invalidateQueries();}`);
    await load("esbuild").build({ entryPoints: [fixture], outfile: script, bundle: true, platform: "browser", format: "iife", globalName: "ActualNotifications",
      jsx: "automatic", nodePaths: [path.join(desktop, "node_modules")], alias: { "@nod/shared": path.join(desktop, "packages/shared/src/index.ts") },
      loader: { ".css": "css", ".png": "dataurl", ".svg": "dataurl", ".ttf": "dataurl", ".woff2": "dataurl" }, define: { "process.env.NODE_ENV": '"development"' } });
    server = http.createServer((req, res) => {
      const file = req.url === "/app.js" ? script : req.url === "/app.css" ? script.replace(/js$/, "css") : null;
      res.setHeader("Content-Type", file ? file.endsWith(".js") ? "application/javascript" : "text/css" : "text/html");
      res.end(file ? fs.readFileSync(file) : '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    browser = await runtime("playwright").chromium.launch({ ...(process.env.ONLINOD_CHROMIUM_PATH ? { executablePath: process.env.ONLINOD_CHROMIUM_PATH } : {}), args: ["--no-sandbox"], headless: true });
    page = await browser.newPage({ viewport: { width: 1536, height: 1050 } });
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", entry => { if (entry.type() === "error" && /same key|unique.*key/i.test(entry.text())) errors.push(entry.text()); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.route("**/*", route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    await page.exposeFunction("actualRpc", async (method, input) => {
      calls.push({ method, input });
      const handlers = { ...m.createHomeHandlers(home), ...m.createCreatorAnalyticsHandlers(analytics),
        "managementCommands.listPending": () => commands.listPending(), "managementCommands.acknowledge": input => commands.acknowledge(input.commandId),
        "managementCommands.retry": input => commands.retry(input.commandId), "managementCommands.cancel": input => commands.cancel(input.commandId) };
      try { assert.ok(handlers[method], "Unexpected RPC " + method); return { result: await handlers[method](input) }; }
      catch (error) { return { error: { message: error.message, code: error.code } }; }
    });
    await page.goto(origin);
    await page.evaluate(input => window.ActualNotifications.mount(input), { creators, session: { ...authStore.readSession(), permissions },
      projection: { ok: true, authenticated: true, current: true, quarantineState: "CURRENT", localAuthorizationRevision: 1,
        session: { ...authStore.readSession(), accessToken: undefined, refreshToken: undefined }, creators, activeCreatorId: c } });
    const number = label => page.locator(".hq-number-row").filter({ has: page.getByText(label, { exact: true }) }).locator(".hq-number-value");
    const select = async name => { await page.getByRole("button", { name: "View analytics for " + name, exact: true }).click(); await page.getByLabel("Analytics period", { exact: true }).selectOption("7d"); };
    await select("model_one");
    await until(async () => await number("New subscribers").textContent() === "—", "Uncollected activity must remain unknown");
    results.beforeCollection = await overview(); assert.equal(results.beforeCollection.coverage.collectors.notifications.proven, false);
    pass("Actual React shows unknown activity before a notification source boundary is proven");

    failStatusRead = true;
    results.startReceipt = await start();
    await assert.rejects(() => status(), { code: "HTTP_503" }); failStatusRead = false;
    pass("Committed START receipt survives an unavailable follow-up status read");
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; }), releasePromise = new Promise(resolve => { release = resolve; });
    provider.gate = { match: input => input.source === "backend.readonly.notifications_history.subscriptions.subscribed" && new URL(input.endpoint.path, "https://provider.fixture").searchParams.has("fromId"), enter, releasePromise };
    coordinator.start(); worker.start();
    await Promise.race([entered, wait(90000).then(() => { throw Error("Notification worker did not reach subscription page two: " + JSON.stringify(logs.slice(-8))); })]);
    results.partial = await status(); assert.equal(results.partial.pagesScanned, 1);
    assert.equal((await overview()).coverage.collectors.notifications.proven, false);
    assert.equal(results.lostNotificationProgressReply, true);
    await worker.stop(); release(); await coordinator.destroy(); makeWorker(); coordinator.start(); worker.start();
    await until(async () => (await status()).status === "COMPLETE", "Reopened worker did not complete the notification traversal");
    await until(async () => { results.initialOverview = await overview(); return results.initialOverview.coverage.factPublication.activity.ready && results.initialOverview.activity.newSubscribers === 12; }, "Notification activity did not publish");
    assert.equal(results.initialOverview.activity.paidStarts, 1); assert.equal(results.initialOverview.activity.freeStarts, 10); assert.equal(results.initialOverview.activity.unknownStarts, 1);
    assert.equal(results.initialOverview.activity.likes, 1); assert.equal(results.initialOverview.activity.comments, 1);
    assert.equal(provider.firstSubscriptionReads, 1, "Lost ACK and restart must resume the accepted page rather than reread HEAD");
    results.initialScan = await status(); assert.equal(results.initialScan.sourceBoundaryReached, true); assert.ok(results.initialScan.ignored > 0);
    await until(async () => await number("New subscribers").textContent() === "12", "Published activity did not reach actual React");
    pass("Lost progress ACK and worker/SQLite reopen preserve all six source phases and publish activity exactly once");

    const beforeUpgradeJob = (await status()).jobId;
    // A persisted v2 wire specimen carries the old five-cent interpretation.
    // Its original body must be acknowledged/quarantined, never relabelled and
    // applied as a v3 fact. The next v3 event shares its delivery sequence.
    const tip = rows.find(row => row.id === "notice-tip");
    const modern = m.normalizeRuntimeWsFrame({ direction: "in", data: JSON.stringify({ new_message: tip }), ts: Date.now() }, { accountId: c })[0];
    assert.equal(modern.normalizerVersion, "notification-source-v3");
    const legacy = structuredClone(modern);
    legacy.normalizerVersion = "notification-source-v2";
    legacy.notificationObservation.normalizerVersion = "notification-source-v2";
    legacy.notificationObservation.amountCents = 5;
    if (legacy.notificationFact) { legacy.notificationFact.normalizerVersion = "notification-source-v2"; legacy.notificationFact.amountCents = 5; }
    if (legacy.moneyObservation) legacy.moneyObservation.amountCents = 5;
    loseLegacyReply = true;
    analytics.handleRuntimeEvent({ creatorId: c, event: legacy });
    analytics.handleRuntimeEvent({ creatorId: c, event: modern });
    await until(async () => results.lostLegacyReply === true && !analytics.live.health().flushing,
      "Legacy upgrade did not commit before its lost acknowledgement");
    assert.equal(analytics.live.health().pending, 2, "Failed first group must leave the following sequence untouched");
    analytics.destroy(); makeAnalytics();
    await until(async () => analytics.live.health().pending === 0, "Legacy SQLite restart blocked the following current delivery");
    const sqlitePath = fs.readdirSync(scratch, { recursive: true }).find(name => path.basename(name) === "analytics-outbox.sqlite");
    assert.ok(sqlitePath);
    const sqlite = new (load("better-sqlite3"))(path.join(scratch, sqlitePath), { readonly: true });
    try {
      const quarantined = sqlite.prepare("SELECT original_row_json,upgrade_receipt_json FROM analytics_live_normalizer_quarantine").all();
      assert.equal(quarantined.length, 1);
      const original = JSON.parse(JSON.parse(quarantined[0].original_row_json).event_json);
      assert.equal(original.normalizerVersion, "notification-source-v2");
      assert.equal(original.notificationObservation.amountCents, 5);
      const receipt = JSON.parse(quarantined[0].upgrade_receipt_json);
      assert.equal(receipt.toVersion, "notification-source-v3");
      results.legacyUpgrade = { originalVersion: original.normalizerVersion, originalCents: original.notificationObservation.amountCents,
        receipt, quarantineRows: quarantined.length };
    } finally { sqlite.close(); }
    pass("Lost legacy ACK and real SQLite reopen quarantine the old payload and deliver the next v3 sequence without a gap");

    await until(async () => { results.upgradeScan = await status(); return results.upgradeScan.jobId !== beforeUpgradeJob && results.upgradeScan.status === "COMPLETE"; }, "Legacy quarantine repair did not finish its new FULL generation");
    assert.equal(results.upgradeScan.mode, "full");

    const corrected = { ...rows.find(row => row.id === "notice-sub-001"), amount: 25, currency: "EUR" };
    rows[rows.findIndex(row => row.id === corrected.id)] = corrected;
    loseLiveReply = true; emit(corrected);
    await until(async () => results.lostLiveReply === true && analytics.live.health().flushing === false, "Live correction did not commit before lost response");
    assert.ok(analytics.live.health().pending > 0, "Lost reply must retain the real SQLite row");
    await worker.stop(); await coordinator.destroy(); analytics.destroy();
    const killed = await f.stop("SIGKILL"); assert.equal(killed.signal, "SIGKILL"); await f.boot();
    creatorService.invalidateBootstrap(); publishAuthority(); makeAnalytics(); makeWorker(); coordinator.start(); worker.start();
    await until(async () => analytics.live.health().pending === 0, "Live SQLite replay did not acknowledge after restart");
    await until(async () => { results.correctedOverview = await overview(); return results.correctedOverview.activity.paidStarts === 2 && results.correctedOverview.activity.unknownStarts === 0; }, "Live correction did not replace the unknown subscription");
    assert.equal(results.correctedOverview.activity.newSubscribers, 12);
    pass("Actual WS normalization, lost live response, backend SIGKILL and SQLite replay preserve one corrected subscription");

    const extra = { id: "notice-live-extra", type: "subscribed", createdAt: at(1), user: fan(21299), amount: 0 };
    rows.unshift(extra); emit(extra); emit(extra);
    await until(async () => { results.liveOverview = await overview(); return results.liveOverview.activity.newSubscribers === 13 && analytics.live.health().pending === 0; }, "New live subscription did not publish once");
    const previousJob = (await status()).jobId;
    await start();
    await until(async () => { results.catchupScan = await status(); return results.catchupScan.jobId !== previousJob && results.catchupScan.status === "COMPLETE"; }, "Manual HEAD catch-up did not complete");
    assert.equal(results.catchupScan.mode, "catchup"); assert.equal((await overview()).activity.newSubscribers, 13);
    pass("Repeated live frame plus overlapping history catch-up keep one canonical event and thirteen subscribers");

    await start(creatorIds[1]);
    await until(async () => (await status(creatorIds[1])).status === "COMPLETE", "Empty creator notification traversal did not finish");
    await until(async () => { results.emptyOverview = await overview(creatorIds[1]); return results.emptyOverview.coverage.factPublication.activity.ready && results.emptyOverview.coverage.collectors.notifications.proven; }, "Confirmed empty activity did not publish");
    assert.equal(results.emptyOverview.activity.newSubscribers, 0);
    await page.getByRole("button", { name: "← Creators", exact: true }).click(); await select("model_two");
    await until(async () => await number("New subscribers").textContent() === "0", "Confirmed zero was not isolated to the empty creator");
    await page.getByRole("button", { name: "← Creators", exact: true }).click(); await select("model_one");
    await until(async () => await number("New subscribers").textContent() === "13", "Switching creators lost the populated activity");
    await page.getByLabel("Analytics period", { exact: true }).selectOption("30d");
    await until(async () => await number("New subscribers").textContent() === "13", "Changing period lost published activity");
    pass("Current React isolates a verified empty creator, restores the populated creator and preserves range changes");

    await worker.stop(); await coordinator.destroy(); analytics.destroy();
    results.persisted = await f.withDatabase(async db => {
      const events = await db.creatorSubscriptionEvent.findMany({ where: { agencyId, creatorId: c } });
      const receipts = await db.creatorSubscriptionLedger.findMany({ where: { agencyId, creatorId: c } });
      const correctedEvent = events.find(row => row.externalNotificationId === corrected.id);
      assert.ok(correctedEvent); assert.equal(correctedEvent.observedPriceCents, 2500); assert.equal(correctedEvent.currency, "EUR");
      assert.equal(events.length, 13);
      const receipt = receipts.find(row => row.externalEventId === corrected.id);
      assert.ok(receipt, "Corrected paid canonical fact must have its compatibility receipt");
      assert.equal(receipt.amountCents, 2500); assert.equal(receipt.currency, "EUR");
      assert.equal(receipts.length, 2, "Ignored source and free subscriptions must not invent paid receipts");
      const tips = await db.creatorTip.findMany({ where: { agencyId, creatorId: c } });
      assert.equal(tips.length, 1); assert.equal(tips[0].amountCents, 500, "The old five-cent payload must never overwrite the current five-dollar fact");
      return { events, receipts, correctedReceipt: receipt, tips };
    });
    assert.deepEqual(errors, []); results.browserVersion = await browser.version();
    pass("Durable canonical store retains exactly thirteen events after all replays and restarts");
  } finally {
    clearInterval(renewal); failStatusRead = false;
    await worker?.stop(); await coordinator?.destroy(); analytics?.destroy();
    await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    globalThis.fetch = nativeFetch;
    results.renderer = { calls, errors }; results.provider = { calls: providerCalls, externalWrites: 0 };
    results.requests = requests;
    fs.writeFileSync(path.join(output, "notification-desktop-log.json"), JSON.stringify(logs, null, 2));
  }
};

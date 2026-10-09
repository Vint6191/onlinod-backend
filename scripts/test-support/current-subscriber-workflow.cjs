"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");

// No Subscriber/FanData/candidate rows are seeded. Current services and workers
// consume controlled physical OF responses through the normal HTTP/SQL path.
exports.runSubscriberDirectory = async function runSubscriberDirectory(f) {
  const { modules: m, desktop, scratch, output, auth, api, agencyId, deviceId,
    creatorId: c, creatorIds, must, pass, results } = f;
  const load = createRequire(path.join(desktop, "package.json"));
  const runtime = createRequire(path.join(process.env.ONLINOD_BROWSER_RUNTIME || process.env.ONLINOD_SQL_PROOF_RUNTIME, "package.json"));
  const logs = [], calls = [], errors = [], requests = [];
  const log = Object.fromEntries(["debug", "info", "warn", "error"].map(level => [level, (...args) => logs.push({ level, args: JSON.parse(JSON.stringify(args, (_key, value) => value instanceof Error ? { message: value.message, code: value.code, stack: value.stack } : value)) })]));
  const authStore = { ...auth, readSession: () => ({ ...auth.readSession(), deviceId }), getDeviceId: () => deviceId,
    getAuthorizationScopeHash: () => agencyId + ":" + deviceId, getActiveCreatorId: () => c, setActiveCreatorId: () => {}, onSessionChanged: () => () => {} };
  const authService = { ensureSession: async () => ({ authenticated: true, session: authStore.readSession() }) };
  const authority = new m.DesktopCurrentAuthorizationAuthorityService({ log, authStore,
    accessRuntime: { currentAuthorityProof: () => ({ accessEpoch: 1, creatorCatalogGeneration: 1 }), allowedCreatorIdsSnapshot: () => creatorIds } });
  const publishAuthority = () => authority.publish({ accessEpoch: 1, creatorCatalogGeneration: 1, role: "OWNER", roleKey: "owner",
    effectivePermissions: { "automation.manage": true, "automation.view_logs": true, "content.manage_vault": true },
    allowedCreatorIds: creatorIds, observedAt: Date.now(), observedAtMono: performance.now(),
    billing: { version: 1, validForMs: 90000, creators: creatorIds.map(creatorId => ({ creatorId, allowed: true, validForMs: 90000, reason: "TRIAL" })) } });
  publishAuthority();
  const commands = new m.ManagementCommandTransport(api, authStore, path.join(scratch, "subscriber-commands.json"), authority, () => {});
  const service = new m.SubscriberDirectoryService(authStore, authService, authority, commands);
  const automation = new m.AutomationService(authStore, authService, authority, commands);
  const creatorService = m.createCreatorService(authStore, authService);
  const capabilities = { canRun: () => ({ allowed: true }), onChanged: () => () => {}, get: creatorId => ({
    api: { readReady: true, writeReady: true }, browser: { pageLocalReady: false, materialized: false, presentable: false },
    identity: { state: "VERIFIED", platformUserId: creatorId === c ? "100001" : "100002", sessionProofEpoch: 1 },
    access: { accessEpoch: 1 }, session: { partition: "persist:acceptance:" + creatorId, sessionEpoch: 1, canonicalRevision: 1, networkRevision: 0, runtimeGeneration: 1 },
    realtime: { ready: true, lastInboundFrameAt: new Date().toISOString() },
  }) };
  const creatorRuntime = { getVerifiedIdentity: creatorId => ({ platformUserId: creatorId === c ? "100001" : "100002" }),
    getState: () => ({ attached: true, websocket: { connected: true }, lastEventAt: new Date().toISOString() }), on: () => () => {} };
  const provider = { calls: [], profiles: new Map(), pageReads: new Map(), generation: 1, gate: null, messages: [], pageChangedAfterAck: false };
  const observedAt = new Date().toISOString();
  const names = ["Alice", "Bobby", "Cara", "Dora", "Evan"];
  const makeFan = index => ({ id: String(20001 + index), username: "fan_" + (20001 + index), name: names[index] || "Fan " + (20001 + index),
    ...(index < 5 ? { lastSeen: null } : { lastSeen: observedAt }),
    ...(index !== 4 ? { subscribedOn: index !== 2, subscribedOnData: { isActive: index !== 2, type: "FREE" }, totalSpentCents: (index + 1) * 1000 } : { isActive: true }),
    subscribedBy: index === 2, subscribePrice: 0, canReceiveChatMessage: index !== 3, isBlocked: false, isRestricted: false, isPerformer: false });
  let rows = Array.from({ length: 225 }, (_, index) => makeFan(index));
  for (const row of rows) provider.profiles.set(row.id, row);
  const success = data => ({ ok: true, status: 200, data });
  const ofApi = {
    withWriteCriticalSection: (_creator, _key, fn, options) => fn(options.signal), withOperationReadback: (_creator, _context, fn) => fn(),
    async request(input) {
      provider.calls.push({ source: input.source, endpoint: input.endpoint, generation: provider.generation });
      if (provider.gate?.match(input)) {
        const gate = provider.gate; provider.gate = null; gate.enter();
        await Promise.race([gate.releasePromise, new Promise((_, reject) => {
          const abort = () => reject(Object.assign(Error("OF_REQUEST_CANCELLED"), { code: "OF_REQUEST_CANCELLED" }));
          if (input.signal.aborted) abort(); else input.signal.addEventListener("abort", abort, { once: true });
        })]);
      }
      if (input.source === "backend.readonly.subscriber_directory") {
        const query = new URL(input.endpoint.path, "https://provider.fixture").searchParams;
        const offset = Number(query.get("offset") || 0), limit = Number(query.get("limit") || 100);
        const key = provider.generation + ":" + offset;
        provider.pageReads.set(key, (provider.pageReads.get(key) || 0) + 1);
        const list = rows.slice(offset, offset + limit).map(row => ({ ...row }));
        if (provider.pageChangedAfterAck && offset === 0) list[0] = { ...list[0], name: "Changed after accepted page" };
        return success({ list, hasMore: offset + limit < rows.length, total: rows.length });
      }
      if (input.source === "backend.readonly.fan_data_point_refresh" || /preflight:/.test(input.source) && input.endpoint.path.includes("/users/")) {
        const id = input.endpoint.path.split("/").pop();
        return success(provider.profiles.get(id));
      }
      if (input.source.startsWith("automation.bump.send-preflight:")) return success({ list: [] });
      if (input.source.startsWith("automation.bump.send:")) { provider.messages.push(input); return success({ id: "900001", text: input.endpoint.body.text }); }
      // Enrollment also warms independent read models. Keep those physical
      // sources explicitly empty without replacing their real job handlers.
      if (input.source.startsWith("backend.readonly.notifications_history.")) return success({ list: [], hasMore: false });
      if (input.source === "backend.readonly.fetch_earnings.chart") return success({ total: { total_amount: 0, total_count: 0 }, chart: [] });
      throw Error("UNEXPECTED_PROVIDER_REQUEST " + JSON.stringify({ source: input.source, endpoint: input.endpoint }));
    },
  };
  let coordinator, worker, actionWorker;
  const makeWorkers = () => {
    coordinator = new m.WorkCoordinatorService({ log, databasePath: path.join(scratch, "subscriber-work.sqlite") });
    coordinator.setCapabilityResolver((...args) => capabilities.canRun(...args));
    worker = new m.BackendReadonlyJobWorker({ log, authStore, authService, creatorService, capabilities, creatorRuntime, coordinator, ofApi,
      accessRuntime: { captureAuthorizationScopePermit: () => ({}), isAuthorizationScopePermitCurrent: () => true,
        revokeCreator: () => { throw Error("UNEXPECTED_REVOKE"); } }, apiRuntime: { getAll: () => ({}) }, backgroundRuntime: { isBackground: () => true },
      sessionReconcile: { reconcileDurableAccessCatalog: async () => {}, observeCanonicalManifests: () => {}, observeNetworkManifests: () => {},
        hardRevokeCreator: () => { throw Error("UNEXPECTED_HARD_REVOKE"); }, hardRevokeAll: () => { throw Error("UNEXPECTED_LOGOUT"); } }, events: { emit: () => {} } });
    actionWorker = new m.BackendActionWorker({ log, authStore, authService, capabilities, authorization: authority,
      creatorRuntime, coordinator, ofApi, customOrders: { assertProgrammaticMediaAllowed: async () => { throw Error("MEDIA_NOT_IN_THIS_WORKFLOW"); } } });
  };
  makeWorkers();
  const handlers = { ...m.createSubscriberDirectoryHandlers(service), ...m.createAutomationHandlers(automation, () => actionWorker),
    "managementCommands.listPending": () => commands.listPending(), "managementCommands.acknowledge": input => commands.acknowledge(input.commandId),
    "managementCommands.retry": input => commands.retry(input.commandId) };
  let loseProgressAck = false, loseCompleteAck = false;
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input)); assert.equal(url.origin, api.apiBase);
    const response = await nativeFetch(input, options);
    const body = options?.body ? JSON.parse(options.body) : null;
    requests.push({ path: url.pathname, method: options?.method || "GET", status: response.status,
      ...(body?.chunkResult?.kind ? { chunkKind: body.chunkResult.kind, offset: body.chunkResult.offset } : {}) });
    if (loseProgressAck && /\/api\/jobs\/[^/]+\/progress$/.test(url.pathname) && body?.chunkResult?.kind === "subscriber_directory_page" && response.ok) {
      loseProgressAck = false; await response.clone().text(); provider.pageChangedAfterAck = true;
      results.lostProgressAck = { offset: body.chunkResult.offset, nextOffset: body.chunkResult.nextOffset };
      throw Error("CONTROLLED_LOST_SUBSCRIBER_PROGRESS_RESPONSE");
    }
    if (loseCompleteAck && /\/api\/jobs\/[^/]+\/complete$/.test(url.pathname) && response.ok) {
      loseCompleteAck = false; await response.clone().text(); results.lostCompleteAck = true;
      throw Error("CONTROLLED_LOST_SUBSCRIBER_COMPLETE_RESPONSE");
    }
    return response;
  };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (fn, label, timeout = 40000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      try { if (await fn()) return; }
      catch (error) {
        // Authority renewal intentionally invalidates an in-flight read. Poll
        // again with a newly captured permit; never accept that old response.
        if (error.code !== "DESKTOP_AUTHORIZATION_PERMIT_STALE" && error.message !== "DESKTOP_AUTHORIZATION_PERMIT_STALE") throw error;
      }
      if (Date.now() > deadline) throw Error(label + "\n" + JSON.stringify({ health: worker.health(), logs: logs.slice(-10) }));
      await wait(150);
    }
  };
  const hold = match => {
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const releasePromise = new Promise(resolve => { release = resolve; });
    provider.gate = { match, enter, releasePromise }; return { entered, release };
  };
  const status = () => service.getStatus({ creatorId: c });
  const hidden = (extra = {}) => service.listHiddenOnline({ creatorId: c, status: "all", limit: 100, ...extra });
  const current = async ids => (await must("POST", "/api/fan-data/current", { creatorId: c, onlyFansUserIds: ids })).items;
  const setControl = async (moduleKey, settings, enabled = true) => {
    const control = (await automation.getControls({ creatorId: c })).snapshot.modules[moduleKey];
    const result = await automation.setControl({ creatorId: c, scope: "module", moduleKey, enabled, settings, expectedUpdatedAt: control.updatedAt });
    commands.acknowledge(result.commandId);
  };
  let renewal, server, browser, page;
  try {
    renewal = setInterval(publishAuthority, 30000);
    const creators = (await creatorService.list()).creators;
    const renderer = path.join(desktop, "apps/desktop/renderer/src"), fixture = path.join(scratch, "subscriber-renderer.tsx"), script = path.join(scratch, "subscriber-renderer.js");
    fs.writeFileSync(fixture, `import React from 'react';import{createRoot}from'react-dom/client';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';
import{AutomationWorkspace}from ${JSON.stringify(path.join(renderer, "features/automation/AutomationWorkspace.tsx"))};
import{acceptRendererAuthorizationProjection}from ${JSON.stringify(path.join(renderer, "shared/rpc/authorization-scope.ts"))};
import ${JSON.stringify(path.join(renderer, "styles.css"))};
const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});let root;
export function mount(input){window.onlinod={events:{onDesktopAuthorizationEvent:()=>()=>{},onCreatorRuntimeEvent:()=>()=>{}},rpc:{call:async(method,payload)=>{const r=await window.actualRpc(method,payload);if(r.error)throw Object.assign(Error(r.error.message),{code:r.error.code});return r.result;}}};acceptRendererAuthorizationProjection(input.projection);root=createRoot(document.getElementById('root'));root.render(<React.StrictMode><QueryClientProvider client={client}><AutomationWorkspace session={input.session} creators={input.creators} activeCreator={input.creators.find(creator=>creator.id===input.projection.activeCreatorId)}/></QueryClientProvider></React.StrictMode>);}
export async function refresh(){await client.invalidateQueries({queryKey:['automation']});}`);
    await load("esbuild").build({ entryPoints: [fixture], outfile: script, bundle: true, platform: "browser", format: "iife", globalName: "ActualAutomation",
      jsx: "automatic", nodePaths: [path.join(desktop, "node_modules")], loader: { ".css": "css", ".png": "dataurl", ".svg": "dataurl" }, define: { "process.env.NODE_ENV": '"development"' } });
    server = http.createServer((req, res) => {
      const file = req.url === "/app.js" ? script : req.url === "/app.css" ? script.replace(/js$/, "css") : null;
      res.setHeader("Content-Type", file ? file.endsWith(".js") ? "application/javascript" : "text/css" : "text/html");
      res.end(file ? fs.readFileSync(file) : '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const { default: chromium } = await import(pathToFileURL(runtime.resolve("@sparticuz/chromium")).href);
    browser = await runtime("playwright").chromium.launch({ executablePath: process.env.ONLINOD_CHROMIUM_PATH || await chromium.executablePath(), args: chromium.args, headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("pageerror", error => errors.push(error.message));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.route("**/*", route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    await page.exposeFunction("actualRpc", async (method, input) => {
      calls.push({ method, input });
      try { assert.ok(handlers[method], "Unexpected RPC " + method); return { result: await handlers[method](input) }; }
      catch (error) { return { error: { message: error.message, code: error.code } }; }
    });
    await page.goto(origin);
    await page.evaluate(input => window.ActualAutomation.mount(input), { creators, session: { ...authStore.readSession(), permissions: { "automation.manage": true } },
      projection: { ok: true, authenticated: true, current: true, quarantineState: "CURRENT", localAuthorizationRevision: 1,
        session: { ...authStore.readSession(), accessToken: undefined, refreshToken: undefined }, creators, activeCreatorId: c } });
    const go = name => page.getByRole("navigation", { name: "Automation sections" }).getByRole("button", { name, exact: true }).click();
    const refresh = async () => { await page.getByRole("button", { name: "Refresh", exact: true }).click(); await page.evaluate(() => window.ActualAutomation.refresh()); };
    const click = async name => { await page.getByRole("button", { name, exact: true }).first().click(); await until(async () => !(await page.getByRole("button", { name: "Refresh", exact: true }).isDisabled()), "UI command did not settle"); };
    await go("Hidden Online");
    assert.equal((await hidden()).count, 0);
    const bumpSettings = { automatic: false, hiddenOnlineEnabled: true, onlineEnabled: false,
      paidSubscribersEnabled: false, freeSubscribersEnabled: false, subscriptionEventsEnabled: false };
    for (const key of ["bumps", "follow_back", "follow", "likes", "sfs"]) await setControl(key, key === "bumps" ? bumpSettings : { automatic: false }, key !== "sfs");
    pass("Empty actual React directory and real creator bootstrap; all subscriber facts begin absent");

    const held = hold(input => input.source === "backend.readonly.subscriber_directory" && Number(new URL(input.endpoint.path, "https://provider.fixture").searchParams.get("offset")) === 100);
    await click("Full rescan");
    coordinator.start(); worker.start();
    await Promise.race([held.entered, wait(40000).then(() => { throw Error("Subscriber worker did not reach page two: " + JSON.stringify(logs.slice(-8))); })]);
    const partial = await status(); results.partial = partial;
    assert.equal(partial.run.scannedCount, 100); assert.equal(partial.state.currentRunId, null);
    assert.equal((await hidden()).count, 0, "Unpublished cohort must not leak into the UI");
    assert.equal((await current(["20001"])).length, 1, "Canonical page facts commit before directory publication");
    await worker.stop(); held.release(); await coordinator.destroy();
    makeWorkers(); coordinator.start(); worker.start();
    await until(async () => (await status()).state?.status === "READY" && (await status()).job?.status === "DONE", "Reopened worker did not publish directory", 65000);
    results.initial = await status();
    assert.equal(results.initial.state.totalCount, 225); assert.equal(results.initial.run.pageCount, 3);
    assert.equal(provider.pageReads.get("1:0"), 1, "Reopen resumes from durable next page");
    assert.equal((await hidden()).count, 5);
    const facts = await current(["20001", "20003", "20005"]); results.initialFacts = facts;
    assert.equal(facts.find(row => row.onlyFansUserId === "20001").relationship.fanSubscriptionActive, true);
    assert.equal(facts.find(row => row.onlyFansUserId === "20003").relationship.fanSubscriptionActive, false);
    assert.equal(facts.find(row => row.onlyFansUserId === "20005").relationship.fanSubscriptionActive, null, "Generic isActive cannot grant a subscription");
    const unknownValue = (await hidden()).items.find(row => row.fanId === "20005");
    assert.equal(unknownValue.totalSpentCents, null, "Unfetched spend is not zero");
    await refresh(); await page.getByText("Alice", { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, "published-directory.png"), fullPage: true });
    pass("225 fans / three actual provider pages; SQLite reopen resumes, publication exposes five hidden fans and current FanData");

    const row = name => page.getByRole("row").filter({ has: page.getByText(name, { exact: true }) });
    await row("Alice").getByRole("button", { name: "Ignore", exact: true }).click();
    await until(async () => (await hidden({ status: "ignored" })).count === 1, "Ignore did not commit");
    await row("Bobby").getByRole("button", { name: "Block", exact: true }).click();
    await until(async () => (await hidden({ status: "blocked" })).count === 1, "Block did not commit");
    await page.getByLabel("Hidden fan status").selectOption("all");
    pass("Actual UI ignore/block controls commit through the management journal and separate status filters");

    rows = rows.filter(row => row.id !== "20003").map(row => row.id === "20004" ? { ...row, lastSeen: observedAt } : row);
    const newcomer = { ...makeFan(225), name: "New hidden fan", lastSeen: null }; rows.push(newcomer); provider.profiles.set(newcomer.id, newcomer);
    provider.generation = 2; loseProgressAck = true; loseCompleteAck = true;
    const previousRun = results.initial.state.currentRunId;
    await click("Full rescan"); worker.wakeAvailableJob();
    await until(async () => { const value = await status(); return value.state?.currentRunId !== previousRun && value.state?.status === "READY" && value.job?.status === "DONE"; }, "Lost progress acknowledgement prevented the next snapshot", 55000);
    results.rescan = await status();
    assert.equal(provider.pageReads.get("2:0"), 1, "Committed subscriber page must not be read from the provider again after losing its ACK");
    assert.equal(results.rescan.state.totalCount, 225); assert.equal(results.rescan.state.disappearedCount, 1);
    const refreshedHidden = await hidden(); results.rescanHidden = refreshedHidden;
    assert.deepEqual(refreshedHidden.items.map(row => row.fanId).sort(), ["20001", "20002", "20005", "20226"]);
    assert.equal(refreshedHidden.items.find(row => row.fanId === "20001").status, "ignored");
    assert.equal(refreshedHidden.items.find(row => row.fanId === "20002").status, "blocked");
    pass("Rescan changes cohort atomically; lost progress/complete replies recover without another provider read and preserve overrides");

    provider.profiles.set("20001", { ...provider.profiles.get("20001"), name: "Zoe current", username: "zoe_current", totalSpentCents: 900000 });
    await must("POST", "/api/fan-data/refresh", { creatorId: c, onlyFansUserIds: ["20001"], reason: "acceptance_current_profile" }); worker.wakeAvailableJob();
    await until(async () => (await current(["20001"]))[0]?.platformIdentity?.username === "zoe_current", "Point profile refresh did not publish current identity");
    const search = await hidden({ search: "Zoe current" }); results.currentSearch = search;
    assert.deepEqual(search.items.map(row => row.fanId), ["20001"], "Search must use the current name displayed in the UI");
    const ordered = await hidden({ sort: "spent_desc" }); results.currentOrder = ordered.items.map(row => ({ fanId: row.fanId, totalSpentCents: row.totalSpentCents }));
    assert.equal(ordered.items[0].fanId, "20001", "Spend order must use current values before pagination");
    assert.equal(ordered.items.at(-1).fanId, "20005", "Unknown spend follows known values");
    assert.equal((await hidden({ sort: "spent_desc", limit: 1 })).items[0].fanId, "20001", "Canonical ordering precedes pagination");
    assert.equal((await hidden({ sort: "spent_desc", limit: 1, offset: 1 })).items[0].fanId, ordered.items[1].fanId);
    assert.equal((await hidden({ search: "Alice" })).count, 0, "Retired display names must not produce hidden matches");
    await refresh(); await page.getByLabel("Search hidden fans").fill("Zoe current"); await page.getByText("Zoe current", { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, "current-profile-search.png"), fullPage: true });
    pass("Actual point-refresh worker updates identity/spend; server search, ordering and React use the same canonical current data");

    await row("Zoe current").getByRole("button", { name: "Restore", exact: true }).click();
    await until(async () => (await hidden({ status: "active", search: "zoe_current" })).count === 1, "Restore did not commit");
    await go("Bumps"); await click("New bump");
    await page.getByLabel("Internal title", { exact: true }).fill("Directory acceptance");
    await page.getByLabel("Message", { exact: true }).fill("Current directory message");
    await page.getByLabel("Hidden online", { exact: true }).check();
    await page.getByLabel("Minimum delay, seconds", { exact: true }).fill("0"); await page.getByLabel("Maximum delay, seconds", { exact: true }).fill("0");
    await click("Save template"); await page.getByRole("heading", { name: "Directory acceptance", exact: true }).waitFor();
    await setControl("bumps", bumpSettings);
    const heldSend = hold(input => input.source.startsWith("automation.bump.send-preflight:"));
    // Use the newly discovered fan: the earlier identity test legitimately
    // leaves 20001 inside the point-refresh two-minute freshness window.
    const planned = await automation.planBumps({ creatorId: c, source: "hidden_online", fanIds: ["20226"], manual: true }); commands.acknowledge(planned.commandId);
    results.plannedBump = planned; assert.equal(planned.planned, 1, JSON.stringify(planned));
    actionWorker.start();
    await Promise.race([heldSend.entered, wait(30000).then(() => { throw Error("Bump did not reach its preflight"); })]);
    provider.profiles.set("20226", { ...provider.profiles.get("20226"), isBlocked: true, canReceiveChatMessage: false });
    const blockRefresh = await must("POST", "/api/fan-data/refresh", { creatorId: c, onlyFansUserIds: ["20226"], reason: "acceptance_block_during_preflight" });
    results.blockRefresh = blockRefresh; assert.equal(blockRefresh.decision.created, true, JSON.stringify(blockRefresh)); worker.wakeAvailableJob();
    await until(async () => (await current(["20226"]))[0]?.relationship?.canReceiveChatMessage === false, "Concurrent message eligibility change was not published");
    heldSend.release();
    let terminal;
    await until(async () => { terminal = (await automation.listDeliveries({ creatorId: c, limit: 100 })).items.find(item => item.actionType === "SEND_MESSAGE"); return terminal && ["SKIPPED", "CANCELED", "FAILED", "COMPLETED"].includes(terminal.status); }, "Changed eligibility did not settle the pending bump");
    results.changedEligibility = terminal;
    assert.ok(["SKIPPED", "CANCELED"].includes(terminal.status), JSON.stringify(terminal)); assert.equal(provider.messages.length, 0);
    pass("Current FanData changes during Bump preflight: actual write executor stops the planned send before any external effect");

    await actionWorker.stop(); await worker.stop();
    const stopped = await f.stop("SIGKILL"); assert.equal(stopped.signal, "SIGKILL"); await f.boot();
    creatorService.invalidateBootstrap(); publishAuthority(); worker.start();
    await go("Hidden Online"); await refresh();
    assert.equal((await status()).state.currentRunId, results.rescan.state.currentRunId);
    assert.equal((await hidden({ search: "zoe_current" })).count, 1);
    await page.getByLabel("Automation model").selectOption(creatorIds[1]);
    assert.equal((await service.listHiddenOnline({ creatorId: creatorIds[1], status: "all" })).count, 0);
    await page.getByLabel("Automation model").selectOption(c);
    pass("Backend SIGKILL preserves published directory, overrides/current profile; second model remains isolated");

    rows = []; provider.generation = 3; provider.pageChangedAfterAck = false;
    await click("Full rescan"); worker.wakeAvailableJob();
    await until(async () => { const value = await status(); return value.state?.status === "READY" && value.state?.totalCount === 0 && value.job?.status === "DONE"; }, "Explicit empty terminal source did not publish");
    results.empty = await status(); assert.equal(results.empty.state.disappearedCount, 225); assert.equal((await hidden()).count, 0);
    assert.equal((await current(["20001"]))[0]?.platformIdentity?.username, "zoe_current", "Source disappearance must not erase known current facts");
    await refresh(); await page.screenshot({ path: path.join(output, "empty-published.png"), fullPage: true });
    assert.deepEqual(errors, []); assert.equal(results.lostCompleteAck, true);
    pass("Explicit empty source publishes a new generation, removes old cohort and retains independently known FanData");
    results.browserVersion = await browser.version();
  } finally {
    clearInterval(renewal);
    await actionWorker.stop(); await worker.stop(); await coordinator.destroy();
    results.finalStatus = await status().catch(error => ({ error: error.message }));
    results.renderer = { calls, errors, requests };
    results.provider = { calls: provider.calls, pageReads: [...provider.pageReads], physicalWrites: provider.messages.length };
    fs.writeFileSync(path.join(output, "worker-log.json"), JSON.stringify(logs, null, 2));
    await page?.screenshot({ path: path.join(output, "last-screen.png"), fullPage: true }).catch(() => {});
    await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    globalThis.fetch = nativeFetch;
  }
};

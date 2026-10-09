"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");

// The renderer, command journal, SQL services, scheduler and delivery executor
// are application code. Only native/provider observations and physical OF I/O
// are fixtures. Never point this workflow at a caller's application database.
exports.runAutomation = async function runAutomation(f) {
  const { modules: m, desktop, scratch, output, auth, login, api, agencyId, deviceId,
    creatorId: c, creatorIds, must, pass, results } = f;
  const load = createRequire(path.join(desktop, "package.json"));
  const runtime = createRequire(path.join(process.env.ONLINOD_BROWSER_RUNTIME || process.env.ONLINOD_SQL_PROOF_RUNTIME, "package.json"));
  const logRows = [], log = Object.fromEntries(["debug", "info", "warn", "error"].map(key => [key, (...args) => logRows.push({ level: key, args: JSON.parse(JSON.stringify(args, (_key, value) => value instanceof Error ? { message: value.message, code: value.code, stack: value.stack } : value)) })]));
  const authStore = { ...auth, readSession: () => ({ ...auth.readSession(), deviceId }), getDeviceId: () => deviceId, onSessionChanged: () => () => {} };
  const authService = { ensureSession: async () => ({ authenticated: true, session: authStore.readSession() }) };
  const authority = new m.DesktopCurrentAuthorizationAuthorityService({ log, authStore,
    accessRuntime: { currentAuthorityProof: () => ({ accessEpoch: 1, creatorCatalogGeneration: 1 }), allowedCreatorIdsSnapshot: () => creatorIds } });
  const publish = () => authority.publish({ accessEpoch: 1, creatorCatalogGeneration: 1, role: "OWNER", roleKey: "owner",
    effectivePermissions: { "automation.manage": true, "automation.view_logs": true, "content.manage_vault": true },
    allowedCreatorIds: creatorIds, observedAt: Date.now(), observedAtMono: performance.now(),
    billing: { version: 1, validForMs: 90000, creators: creatorIds.map(creatorId => ({ creatorId, allowed: true, validForMs: 90000, reason: "TRIAL" })) } });
  publish();
  const commands = new m.ManagementCommandTransport(api, authStore, path.join(scratch, "automation-commands.json"), authority, () => {});
  const service = new m.AutomationService(authStore, authService, authority, commands);
  const subscribers = new m.SubscriberDirectoryService(authStore, authService, authority, commands);
  const coordinator = new m.WorkCoordinatorService({ log, databasePath: path.join(scratch, "automation-work.sqlite") });
  const capabilities = { canRun: () => ({ allowed: true }) };
  coordinator.setCapabilityResolver((...args) => capabilities.canRun(...args));
  let runtimeListener;
  const creatorRuntime = { getVerifiedIdentity: creatorId => ({ platformUserId: creatorId === c ? "100001" : "100002" }),
    on: (_event, listener) => { runtimeListener = listener; return () => { runtimeListener = null; }; } };
  const provider = { calls: [], messages: [], follows: new Map([["16004", true]]), comments: [], likes: new Set(), gate: null, loseSend: false };
  const success = data => ({ ok: true, status: 200, data });
  const ofApi = {
    withWriteCriticalSection: (_creator, _key, fn, options) => fn(options.signal),
    withOperationReadback: (_creator, _context, fn) => fn(),
    async request(input) {
      provider.calls.push({ source: input.source, endpoint: input.endpoint, operationId: input.operationId, authority: input.writeAuthorityContext });
      if (provider.gate && provider.gate.match(input)) { const gate = provider.gate; provider.gate = null; gate.entered(); await gate.released; }
      const source = input.source, endpoint = input.endpoint;
      if (source.startsWith("automation.bump.send-preflight:")) return success({ list: provider.messages.filter(row => row.toUser.id === String(endpoint.path.match(/chats\/(\d+)/)?.[1])) });
      if (source.startsWith("automation.bump.send:")) {
        assert.equal(input.writeAuthorityContext.authorityKind, "AUTOMATION_DELIVERY");
        assert.ok(input.writeAuthorityContext.writeCommitRevision > 0);
        const fan = String(endpoint.path.match(/chats\/(\d+)/)?.[1]);
        const message = { id: String(900000 + provider.messages.length), text: endpoint.body.text, price: endpoint.body.price || 0,
          media: [], createdAt: new Date().toISOString(), fromUser: { id: 100001 }, toUser: { id: fan }, isFromCreator: true };
        provider.messages.push(message);
        if (provider.loseSend) { provider.loseSend = false; return { ok: false, status: 0, code: "WRITE_OUTCOME_AMBIGUOUS", error: "Controlled lost provider response" }; }
        return success(message);
      }
      if (/preflight:/.test(source) && /users\//.test(endpoint.path)) {
        const id = String(endpoint.path.match(/users\/(\d+)/)?.[1]);
        return success({ id, username: "fixture_" + id, name: "Fixture " + id, subscribedBy: provider.follows.get(id) === true,
          subscribedOn: id !== "16004", subscribePrice: 0, canReceiveChatMessage: true, isBlocked: false, isRestricted: false, isPerformer: false, isWantComments: true });
      }
      if (/automation\.(follow-back\.execute|follow\.recovery|sfs\.follow):/.test(source)) { provider.follows.set(String(endpoint.path.match(/users\/(\d+)/)?.[1]), true); return success({}); }
      if (/automation\.(follow\.unfollow|sfs\.unfollow):/.test(source)) { provider.follows.set(String(endpoint.path.match(/users\/(\d+)/)?.[1]), false); return success({}); }
      if (source.startsWith("automation.likes.execute:")) { provider.likes.add(input.operationId); return success({}); }
      if (source.startsWith("backend.readonly.likes.")) {
        const isFan = /users\/16005\//.test(endpoint.path);
        return success({ list: isFan ? [
          { id: "50001", publishedAt: new Date().toISOString(), canToggleFavorite: true, canViewMedia: true, isFavorite: false },
          { id: "50002", publishedAt: new Date().toISOString(), canToggleFavorite: false, canViewMedia: true, isFavorite: false },
          { id: "50003", publishedAt: "2020-01-01T00:00:00Z", canToggleFavorite: true, canViewMedia: true, isFavorite: false },
        ] : [], hasMore: false });
      }
      if (source.startsWith("backend.readonly.sfs.discovery.feed:")) return success({ list: [{ id: "60001", text: "Meet @fixture_16006" }], hasMore: false });
      if (source.startsWith("backend.readonly.sfs.discovery.self:")) return success({ id: 100001, username: "model_one" });
      if (source.startsWith("backend.readonly.sfs.discovery.profile:")) return success({ id: 16006, username: "fixture_16006", name: "SFS fixture", subscribePrice: 0, subscribedBy: false, isWantComments: true, canReceiveChatMessage: true });
      if (source.startsWith("backend.readonly.sfs.scan.pinned:")) return success({ list: [{ id: "70001", canComment: true }], hasMore: false });
      if (source.startsWith("backend.readonly.sfs.scan.comments:")) return success({ list: provider.comments, hasMore: false });
      if (source.startsWith("automation.sfs.comments:")) return success({ list: provider.comments, hasMore: false });
      if (source.startsWith("automation.sfs.comment:")) { const row = { id: String(80000 + provider.comments.length), text: endpoint.body.text, fromUser: { id: 100001 } }; provider.comments.push(row); return success(row); }
      if (source.startsWith("automation.sfs.comment-like:")) { provider.likes.add(input.operationId); return success({}); }
      throw Error("UNEXPECTED_PROVIDER_REQUEST " + JSON.stringify({ source, endpoint }));
    },
  };
  const worker = new m.BackendActionWorker({ log, authStore, authService, capabilities, authorization: authority,
    creatorRuntime, coordinator, ofApi, customOrders: { assertProgrammaticMediaAllowed: async () => {} } });
  const handlers = { ...m.createAutomationHandlers(service, () => worker),
    "managementCommands.listPending": () => commands.listPending(),
    "managementCommands.acknowledge": input => commands.acknowledge(input.commandId),
    "managementCommands.retry": input => commands.retry(input.commandId),
    "subscribers.getStatus": input => subscribers.getStatus(input),
    "subscribers.listHiddenOnline": input => subscribers.listHiddenOnline(input),
    "subscribers.scheduleScan": input => subscribers.scheduleScan(input),
  };
  let loseCompletionAck = false;
  const blockedReleases = [];
  const calls = [], errors = [], requests = [], nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    assert.equal(url.origin, api.apiBase, "Only isolated Backend HTTP is permitted");
    const response = await nativeFetch(input, options);
    requests.push({ method: options?.method || "GET", path: url.pathname, status: response.status });
    if (loseCompletionAck && /\/api\/automation\/worker\/[^/]+\/complete$/.test(url.pathname) && response.ok) {
      loseCompletionAck = false; await response.clone().text();
      results.lostCompletionAck = true;
      throw Error("Controlled lost completion acknowledgement after SQL commit");
    }
    return response;
  };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (fn, label, timeout = 30000) => {
    const end = Date.now() + timeout;
    while (!(await fn())) { if (Date.now() > end) throw Error(label + "\n" + JSON.stringify({ health: worker.health(), recentLogs: logRows.slice(-8) })); await wait(100); }
  };
  const heartbeat = () => must("POST", "/api/devices/heartbeat", { deviceId, accounts: creatorIds.map((creatorId, index) => ({ creatorId,
    remoteId: String(100001 + index), status: "READY", accessEpoch: 1, sessionReadReady: true, sessionWriteReady: true,
    sessionProofEpoch: 1, canonicalRevision: 1, networkRevision: 0, realtimeHealthy: true, wsConnected: true, lastWsFrameAt: new Date().toISOString() })) });
  let renewal, browser, server, page;
  try {
    await heartbeat();
    renewal = setInterval(() => { publish(); void heartbeat().catch(error => errors.push(error.message)); }, 45000);
    const creators = await Promise.all(creatorIds.map(async id => (await must("GET", `/api/creators/${id}`)).creator));
    const renderer = path.join(desktop, "apps/desktop/renderer/src");
    const fixture = path.join(scratch, "automation-renderer.tsx"), script = path.join(scratch, "automation-renderer.js");
    fs.writeFileSync(fixture, `import React from 'react';import{createRoot}from'react-dom/client';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';
import{AutomationWorkspace}from ${JSON.stringify(path.join(renderer, "features/automation/AutomationWorkspace.tsx"))};
import{acceptRendererAuthorizationProjection}from ${JSON.stringify(path.join(renderer, "shared/rpc/authorization-scope.ts"))};
import ${JSON.stringify(path.join(renderer, "styles.css"))};
const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});let root;
export function mount(input){window.onlinod={events:{onDesktopAuthorizationEvent:()=>()=>{},onCreatorRuntimeEvent:()=>()=>{}},rpc:{call:async(method,payload)=>{const r=await window.actualRpc(method,payload);if(r.error)throw Object.assign(Error(r.error.message),{code:r.error.code});return r.result;}}};
acceptRendererAuthorizationProjection(input.projection);root=createRoot(document.getElementById('root'));root.render(<React.StrictMode><QueryClientProvider client={client}><AutomationWorkspace session={input.session} creators={input.creators} activeCreator={input.creators[0]}/></QueryClientProvider></React.StrictMode>);}
export async function refresh(){await client.invalidateQueries({queryKey:['automation']});}
export function unmount(){root.unmount();client.clear();}`);
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
      try { assert.ok(handlers[method], "Unexpected renderer RPC " + method); return { result: await handlers[method](input) }; }
      catch (error) { return { error: { message: error.message, code: error.code } }; }
    });
    await page.goto(origin);
    await page.evaluate(input => window.ActualAutomation.mount(input), { creators, session: { ...authStore.readSession(), permissions: { "automation.manage": true } },
      projection: { ok: true, authenticated: true, current: true, quarantineState: "CURRENT", localAuthorizationRevision: 1,
        session: { ...authStore.readSession(), accessToken: undefined, refreshToken: undefined }, creators, activeCreatorId: c } });
    const go = async name => { await page.getByRole("navigation", { name: "Automation sections" }).getByRole("button", { name, exact: true }).click(); await until(async () => !(await page.getByText("Loading…", { exact: true }).count()), "Renderer did not settle"); };
    const click = async name => { await page.getByRole("button", { name, exact: true }).first().click(); await until(async () => !(await page.getByRole("button", { name: "Refresh", exact: true }).isDisabled()), "Command did not settle");
      const alerts = await page.getByRole("alert").allTextContents(); assert.deepEqual(alerts, [], name + ": " + alerts.join("; ")); };
    for (const name of ["Overview", "Bumps", "Hidden Online", "Follow Back", "Refollow", "Likes", "SFS Hunter", "Queue", "History", "Settings"]) {
      await go(name); await wait(100); assert.deepEqual(await page.getByRole("alert").allTextContents(), [], name);
    }
    pass("Ten actual React Automation sections load through Desktop services and live isolated Backend");
    await go("Bumps");
    await click("New bump");
    await page.getByLabel("Internal title", { exact: true }).fill("Acceptance welcome");
    await page.getByLabel("Message", { exact: true }).fill("Linked acceptance message");
    await page.getByLabel("Minimum delay, seconds", { exact: true }).fill("0");
    await page.getByLabel("Maximum delay, seconds", { exact: true }).fill("0");
    await click("Save template");
    await page.getByRole("heading", { name: "Acceptance welcome", exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, "bumps-created.png"), fullPage: true });
    await page.getByLabel("Automation model").selectOption(creatorIds[1]);
    await page.getByText("No matching templates.", { exact: true }).waitFor();
    assert.equal((await service.uiListBumps({ creatorId: creatorIds[1], includeTrash: true })).items.length, 0);
    await page.getByLabel("Automation model").selectOption(c);
    await page.getByRole("heading", { name: "Acceptance welcome", exact: true }).waitFor();
    pass("UI-created bump is canonical, survives model switching and stays within its model");
    const setControl = async (scope, moduleKey, settings, enabled = true) => {
      const snapshot = (await service.getControls({ creatorId: c })).snapshot;
      const source = scope === "workspace" ? snapshot.workspace : snapshot.modules[moduleKey];
      const r = await service.setControl({ creatorId: c, scope, moduleKey, enabled, settings, expectedUpdatedAt: source.updatedAt });
      commands.acknowledge(r.commandId);
    };
    await setControl("workspace", undefined, { globalWriteMinIntervalMs: 1000, globalWriteMaxIntervalMs: 1000, randomJitter: false });
    for (const key of ["bumps", "follow_back", "follow", "likes", "sfs"]) await setControl("module", key, {
      automatic: key === "bumps", minimumIntervalMs: 5000, maximumIntervalMs: 5000, randomJitter: false,
      ...(key === "bumps" ? { onlineEnabled: true, hiddenOnlineEnabled: false, paidSubscribersEnabled: false, freeSubscribersEnabled: false, subscriptionEventsEnabled: false, onlineObservationTtlMs: 300000 } : {}),
      ...(key === "follow" ? { refollowEnabled: true, refollowPauseMinMs: 1000, refollowPauseMaxMs: 1000 } : {}),
      ...(key === "sfs" ? { huntingEnabled: true, followToScanMinMs: 1000, followToScanMaxMs: 1000, quickUnfollowMinMs: 1000, quickUnfollowMaxMs: 1000, unfollowMinMinutes: 1, unfollowMaxMinutes: 1 } : {}),
    });
    await f.withDatabase(async (db, backendLoad) => {
      results.databaseTimezone = await db.$queryRawUnsafe("SHOW TimeZone");
      const rollback = Error("TIMING_FIXTURE_ROLLBACK");
      const { runRootCommit } = backendLoad("./src/services/db-commit-kernel");
      const { ACTION_FAIR_CANDIDATES_SQL } = backendLoad("./src/services/automation-action-delivery-service");
      results.timezoneCases = [];
      await assert.rejects(runRootCommit(db, async ({ tx }) => {
        const time = new Date();
        const base = { agencyId, creatorId: c, moduleKey: "bumps", actionType: "SEND_MESSAGE", originKind: "AUTOMATION", status: "QUEUED", targetId: "timing-fixture" };
        const due = await tx.automationDelivery.create({ data: { ...base, idempotencyKey: "timing-due", notBefore: new Date(+time - 1000), priority: 1 } });
        await tx.automationDelivery.create({ data: { ...base, targetId: "timing-future", idempotencyKey: "timing-future", notBefore: new Date(+time + 3600000), priority: 1000 } });
        for (const zone of ["UTC", "Europe/Kyiv", "America/New_York"]) {
          await tx.$executeRawUnsafe("SELECT set_config('TimeZone', $1, true)", zone);
          const selected = await tx.$queryRawUnsafe(ACTION_FAIR_CANDIDATES_SQL, agencyId, [c], ["SEND_MESSAGE"], time, [c]);
          assert.deepEqual(selected.map(row => row.id), [due.id], "SQL due selection in " + zone);
          results.timezoneCases.push({ zone, dueSelected: true, futureExcluded: true });
        }
        throw rollback;
      }, { profile: "JOB_CHUNK" }), error => error === rollback);
      assert.equal(await db.automationDelivery.count(), 0, "Timing proof leaves no application work");
      const now = new Date(), authorityVersion = `${now.toISOString()}|0700|USER_PROFILE|acceptance`;
      const run = await db.subscriberScanRun.create({ data: { agencyId, creatorId: c, status: "PUBLISHED", publicationStatus: "COMPLETE", fanProjectionStatus: "COMPLETE", publicationGeneration: 1, publishedAt: now, completedAt: now } });
      await db.subscriberDirectoryState.upsert({ where: { creatorId: c }, create: { agencyId, creatorId: c, currentRunId: run.id, status: "READY", publishedAt: now, publicationGeneration: 1, publishedGeneration: 1 }, update: { currentRunId: run.id, status: "READY", publishedAt: now, publicationGeneration: 1, publishedGeneration: 1 } });
      for (const id of ["16001", "16002", "16003", "16004", "16005", "16006", "16007", "16008", "16009"]) {
        await db.subscriberScanItem.create({ data: { agencyId, creatorId: c, runId: run.id, fanId: id, dialogId: id, contentHash: "observation-fixture-" + id, observedAt: now } });
        const fan = await db.creatorFan.create({ data: { agencyId, creatorId: c, onlyFansUserId: id } });
        const fields = { fanSubscribesToCreator: id !== "16004", fanSubscriptionActive: id !== "16004", fanSubscriptionType: "FREE", creatorFollowsFan: id === "16004",
          canReceiveChatMessage: true, blocked: false, restricted: false, performer: false, subscribePriceCents: 0 };
        await db.creatorFanRelationshipCurrent.create({ data: { agencyId, creatorId: c, fanRecordId: fan.id, onlyFansUserId: id,
          ...fields, ...Object.fromEntries(Object.keys(fields).map(key => [key + "AuthorityVersion", authorityVersion])), observedAt: now, source: "USER_PROFILE" } });
      }
      for (const id of ["16001", "16002", "16007", "16008", "16009"]) await db.automationBumpFanState.create({ data: { agencyId, creatorId: c, fanId: id, dialogId: id, lastOnlineAt: id === "16001" ? now : null } });
      await db.followBackCandidate.create({ data: { agencyId, creatorId: c, fanId: "16003", snapshotRunId: run.id, lastSeenAt: now } });
      await db.followAutomationCandidate.create({ data: { agencyId, creatorId: c, fanId: "16004", snapshotRunId: run.id, lastSeenAt: now } });
    });
    await heartbeat(); publish();
    await page.evaluate(() => window.ActualAutomation.refresh());
    await click("Plan automatic bumps");
    const deliveries = async () => (await service.listDeliveries({ creatorId: c, limit: 100 })).items;
    assert.equal((await deliveries()).length, 0, "Plan snapshots must not invent live presence observations");
    coordinator.start(); worker.start();
    runtimeListener({ creatorId: c, event: { type: "presence_online", fanIds: ["16001"], createdAt: new Date().toISOString() } });
    let initial;
    await until(async () => { initial = (await deliveries()).find(row => row.actionType === "SEND_MESSAGE"); return initial; }, "Live observation did not plan a bump");
    await until(async () => (await deliveries()).find(row => row.id === initial.id)?.status === "COMPLETED", "Bump did not complete", 45000);
    assert.equal(provider.messages.length, 1);
    const deleteAfterSend = (await deliveries()).find(row => row.actionType === "DELETE_MESSAGE");
    results.firstBumpTiming = { now: new Date().toISOString(), deleteAfterSend };
    assert.ok(Date.parse(deleteAfterSend.notBefore) > Date.now() + 3000000, "Bump deletion must retain its one-hour delay: " + JSON.stringify(results.firstBumpTiming));
    await go("History"); await click("Refresh");
    await page.getByRole("cell", { name: /^COMPLETED/ }).first().waitFor();
    await page.screenshot({ path: path.join(output, "bump-history.png"), fullPage: true });
    pass("UI template + actual live-event handling → SQL claim → actual SQLite coordinator/worker → one OF message → UI history");
    const terminal = async (actionType, fanId, timeout = 45000) => {
      let row;
      await until(async () => { row = (await deliveries()).find(x => x.actionType === actionType && x.fanId === fanId); return row && ["COMPLETED", "FAILED", "SKIPPED", "CANCELED"].includes(row.status); }, actionType + " did not settle for " + fanId, timeout);
      assert.equal(row.status, "COMPLETED", JSON.stringify(row)); return row;
    };
    const holdRead = match => {
      let enter, release;
      const entered = new Promise(resolve => { enter = resolve; });
      const released = new Promise(resolve => { release = resolve; });
      blockedReleases.push(release);
      provider.gate = { match, entered: enter, released };
      return { entered, release };
    };
    await go("Bumps");
    const held = holdRead(input => input.source.startsWith("automation.bump.send-preflight:"));
    const planned = await service.planBumps({ creatorId: c, source: "manual", fanIds: ["16002"], manual: true });
    commands.acknowledge(planned.commandId);
    await Promise.race([held.entered, wait(30000).then(() => { throw Error("Bump preflight was not entered"); })]);
    await click("Bumps: On");
    assert.equal((await deliveries()).find(row => row.fanId === "16002").status, "PAUSED");
    held.release();
    await until(() => coordinator.list({ statuses: ["running"], limit: 100 }).items.length === 0, "Paused local attempt did not settle");
    assert.equal(provider.messages.length, 1, "Pause before prepare-write forbids external effect");
    await click("Bumps: Off");
    await terminal("SEND_MESSAGE", "16002");
    assert.equal(provider.messages.length, 2, "Resume produces exactly one message");
    pass("UI pause during preflight invalidates the lease; resume finishes the same delivery once");

    const jobClient = new m.BackendJobClient(authStore, authService);
    const runReadJob = async (key, handler) => {
      let job;
      await until(async () => { job = (await must("POST", "/api/jobs/claim", { deviceId, leaseMs: 180000, jobKeys: [key], capabilities: { legacyStorageRetirementV1: true } })).job; return job; }, key + " was not claimable");
      let continuation = job.continuation || null;
      const workId = "actual-read:" + job.id;
      await jobClient.renew(job, { leaseMs: 180000, workId });
      for (let n = 0; n < 40; n++) {
        const chunk = await handler.runChunk({ job, creatorId: c, continuation, signal: new AbortController().signal, ofApi, verifiedIdentity: { platformUserId: "100001" },
          acquireObservationReadLease: input => jobClient.acquireObservationReadLease(job, input),
          releaseObservationReadLease: token => jobClient.releaseObservationReadLease(job, token),
          acquireObservationToken: input => jobClient.observationToken(job, input),
        });
        if (chunk.chunkResult !== undefined || chunk.outcome !== "done") await jobClient.progress(job, {
          leaseMs: 180000, workId, progress: chunk.progress, chunkResult: chunk.chunkResult,
          continuation: chunk.continuation, expectedContinuation: continuation,
        });
        if (chunk.outcome === "done") { await jobClient.complete(job, { workId, result: chunk.result, progress: chunk.progress }); return chunk.result; }
        continuation = chunk.continuation;
        await wait(chunk.runAfterMs || 0);
      }
      throw Error(key + " exceeded bounded chunk count");
    };
    for (const [name, actionType, fanId] of [["Follow Back", "FOLLOW_BACK", "16003"], ["Likes", "LIKE_POST", "16005"], ["Refollow", "UNFOLLOW_FAN", "16004"]]) {
      await go(name);
      if (name === "Likes") {
        await click("Discover candidates");
        await runReadJob("likes_content_discovery", m.likesContentDiscoveryHandler);
        const observed = (await service.getLikes({ creatorId: c, limit: 100 })).items;
        results.likesDiscovery = observed;
        assert.ok(observed.find(row => row.contentId === "50001")?.publishedAt, "Discovery must persist the actual publication date");
        assert.equal(observed.find(row => row.contentId === "50002")?.canToggleFavorite, false, "Discovery must preserve the provider's cannot-like flag");
        assert.ok(!observed.some(row => row.contentId === "50003"), "Old content must not enter the discovery cohort");
      }
      await click("Build queue");
      await terminal(actionType, fanId);
      if (name === "Refollow") await terminal("FOLLOW_FAN", fanId, 60000);
      await click("Refresh");
      await page.screenshot({ path: path.join(output, name.toLowerCase().replaceAll(" ", "-") + ".png"), fullPage: true });
    }
    assert.equal(provider.follows.get("16003"), true);
    assert.equal(provider.follows.get("16004"), true);
    assert.equal(provider.likes.size, 1);
    pass("Follow Back, Likes and complete Refollow cycle: UI queue → actual provider executor → canonical state");

    await go("SFS Hunter");
    await click("Discover candidates");
    const discoveryResult = await runReadJob("sfs_target_discovery", m.sfsTargetDiscoveryHandler);
    assert.equal(discoveryResult.resolved, 1);
    await click("Refresh");
    assert.equal((await service.getSfs({ creatorId: c, limit: 100 })).items[0].targetUserId, "16006");
    await click("New comment");
    await page.getByLabel("Internal title", { exact: true }).fill("Acceptance SFS");
    await page.getByLabel("Message", { exact: true }).fill("Linked SFS comment");
    await click("Save template");
    provider.comments.push({ id: "71001", text: "Fan comment", fromUser: { id: 17001, username: "commenter", isPerformer: false }, isLiked: false, canLike: true });
    await click("Build queue");
    await terminal("SFS_FOLLOW_TARGET", "16006");
    const scanResult = await runReadJob("sfs_target_scan", m.sfsTargetScanHandler);
    assert.equal(scanResult.posts[0].eligibleComments[0].commentId, "71001");
    await terminal("SFS_COMMENT_POST", "16006", 60000);
    await terminal("SFS_LIKE_COMMENT", "16006", 60000);
    await click("Refresh");
    await click("SFS Hunter: On");
    const cleanup = (await deliveries()).find(row => row.actionType === "SFS_UNFOLLOW_TARGET");
    assert.ok(cleanup && cleanup.status !== "PAUSED", "Owned follow cleanup must survive module pause");
    await terminal("SFS_UNFOLLOW_TARGET", "16006", 100000);
    assert.equal(provider.follows.get("16006"), false);
    assert.equal(provider.comments.filter(row => row.text === "Linked SFS comment").length, 1);
    const settledSfs = (await service.getSfs({ creatorId: c, limit: 100 })).items.find(row => row.targetUserId === "16006");
    assert.equal(settledSfs.state, "COMPLETED");
    assert.equal(settledSfs.usedForever, true);
    results.settledSfs = settledSfs;
    await click("Refresh");
    await page.getByRole("cell", { name: /^COMPLETED/ }).first().waitFor();
    await page.screenshot({ path: path.join(output, "sfs-complete-paused.png"), fullPage: true });
    pass("Complete SFS saga: follow → actual scan handler → comment + comment like → owned cleanup while paused");

    loseCompletionAck = true;
    const withLostAck = await service.planBumps({ creatorId: c, source: "manual", fanIds: ["16007"], manual: true });
    commands.acknowledge(withLostAck.commandId);
    const ackRow = await terminal("SEND_MESSAGE", "16007");
    await until(() => coordinator.list({ statuses: ["queued", "running"], limit: 100 }).items.length === 0, "Local retry did not accept committed SQL receipt", 30000);
    assert.equal(results.lostCompletionAck, true);
    assert.equal(provider.messages.filter(row => row.toUser.id === "16007").length, 1);
    assert.equal((await deliveries()).find(row => row.id === ackRow.id).status, "COMPLETED");
    pass("Lost completion acknowledgement retries the durable receipt without another provider send");

    provider.loseSend = true;
    const ambiguous = await service.planBumps({ creatorId: c, source: "manual", fanIds: ["16008"], manual: true });
    commands.acknowledge(ambiguous.commandId);
    await until(async () => (await deliveries()).some(row => row.fanId === "16008" && row.status === "RECONCILE_REQUIRED"), "Unknown send was not fenced for reconciliation");
    await go("Bumps"); await click("Refresh"); await click("Bumps: On");
    await terminal("SEND_MESSAGE", "16008", 100000);
    assert.equal(provider.messages.filter(row => row.toUser.id === "16008").length, 1);
    pass("Ambiguous send remains eligible for readback while paused and settles without resending");
    const reconciled = (await deliveries()).find(row => row.fanId === "16008" && row.actionType === "SEND_MESSAGE");
    results.reconciledDelivery = reconciled;
    assert.equal(reconciled.failureCategory, null, "Resolved provider outcome must release the creator write barrier");
    await click("Bumps: Off");
    const afterRecovery = await service.planBumps({ creatorId: c, source: "manual", fanIds: ["16009"], manual: true });
    commands.acknowledge(afterRecovery.commandId);
    await terminal("SEND_MESSAGE", "16009");
    assert.equal(provider.messages.filter(row => row.toUser.id === "16009").length, 1);
    pass("A settled unknown result releases the creator lane for new independent work");

    const countBeforeRestart = provider.calls.filter(row => !/preflight|comments:|backend.readonly/.test(row.source)).length;
    await worker.stop();
    const stopped = await f.stop("SIGKILL"); assert.equal(stopped.signal, "SIGKILL");
    await f.boot(); await heartbeat(); publish();
    worker.start();
    await go("History"); await click("Refresh");
    assert.equal((await deliveries()).filter(row => row.status === "COMPLETED").length, 13);
    await until(async () => (await page.getByRole("cell", { name: /^COMPLETED/ }).count()) === 13, "UI history did not show all completed deliveries after restart");
    assert.equal(provider.calls.filter(row => !/preflight|comments:|backend.readonly/.test(row.source)).length, countBeforeRestart);
    await page.screenshot({ path: path.join(output, "history-after-restart.png"), fullPage: true });
    pass("Backend SIGKILL/restart preserves all completed Automation receipts and UI history");
    results.provider = { calls: provider.calls, messages: provider.messages, follows: [...provider.follows], likes: [...provider.likes] };
    results.renderer = { engine: await browser.version(), calls, errors, desktopRequests: requests };
    assert.deepEqual(errors, []);
  } finally {
    clearInterval(renewal);
    for (const release of blockedReleases) release();
    if (page) { await page.screenshot({ path: path.join(output, "last-screen.png"), fullPage: true }).catch(() => {}); }
    await worker.stop(); await coordinator.destroy();
    results.finalDeliveries = await service.listDeliveries({ creatorId: c, limit: 100 }).catch(error => ({ error: error.message }));
    globalThis.fetch = nativeFetch;
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    fs.writeFileSync(path.join(output, "worker-log.json"), JSON.stringify(logRows, null, 2));
    results.renderer = { ...(results.renderer || {}), calls, errors, desktopRequests: requests };
    results.provider = { calls: provider.calls, messages: provider.messages, follows: [...provider.follows], likes: [...provider.likes] };
  }
};

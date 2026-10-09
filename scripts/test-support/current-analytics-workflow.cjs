"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const { createRequire } = require("node:module");

// The physical OF boundary is controlled. No earnings, finance, Campaign,
// Traffic or FanData rows are seeded; current workers publish all source facts.
exports.runAnalytics = async function runAnalytics(f) {
  const { modules: m, desktop, scratch, output, auth, api, agencyId, deviceId, creatorId: c, creatorIds, must, pass, results } = f;
  const load = createRequire(path.join(desktop, "package.json"));
  const runtime = createRequire(path.join(process.env.ONLINOD_BROWSER_RUNTIME || process.env.ONLINOD_SQL_PROOF_RUNTIME, "package.json"));
  const logs = [], calls = [], errors = [], requests = [], providerCalls = [];
  const log = Object.fromEntries(["debug", "info", "warn", "error"].map(level => [level, (...args) => logs.push({ level, args: JSON.parse(JSON.stringify(args, (_key, value) => value instanceof Error ? { message: value.message, code: value.code } : value)) })]));
  const authStore = { ...auth, readSession: () => ({ ...auth.readSession(), deviceId }), getDeviceId: () => deviceId,
    getAuthorizationScopeHash: () => agencyId + ":" + deviceId, getActiveCreatorId: () => c, setActiveCreatorId: () => {}, onSessionChanged: () => () => {} };
  const authService = { ensureSession: async () => ({ authenticated: true, session: authStore.readSession() }) };
  const permissions = Object.fromEntries(["money.view_earnings", "creator_analytics.refresh", "traffic.view", "traffic.refresh", "traffic.manage_costs"].map(key => [key, true]));
  const authority = new m.DesktopCurrentAuthorizationAuthorityService({ log, authStore,
    accessRuntime: { currentAuthorityProof: () => ({ accessEpoch: 1, creatorCatalogGeneration: 1 }), allowedCreatorIdsSnapshot: () => creatorIds } });
  const publishAuthority = () => authority.publish({ accessEpoch: 1, creatorCatalogGeneration: 1, role: "OWNER", roleKey: "owner", effectivePermissions: permissions,
    allowedCreatorIds: creatorIds, observedAt: Date.now(), observedAtMono: performance.now(),
    billing: { version: 1, validForMs: 90000, creators: creatorIds.map(creatorId => ({ creatorId, allowed: true, validForMs: 90000, reason: "TRIAL" })) } });
  publishAuthority();
  let loseCostReply = false, heldTraffic = null;
  const serviceApi = { ...api, deviceId, request: async (url, options) => {
    const result = await api.request(url, options);
    if (loseCostReply && options?.body?.action === "traffic.cost") {
      loseCostReply = false; results.lostCostReply = true; throw Object.assign(Error("Controlled lost cost response"), { code: "NETWORK_ERROR" });
    }
    return result;
  } };
  const commands = new m.ManagementCommandTransport(serviceApi, authStore, path.join(scratch, "analytics-commands.json"), authority, () => {});
  const home = new m.HomeService({ log, authStore, authService, api: serviceApi, authorization: authority });
  const analytics = new m.CreatorAnalyticsService({ log, authStore, authService, api: serviceApi, authorization: authority, managementCommands: commands });
  const creatorService = m.createCreatorService(authStore, authService);
  const capabilities = { canRun: () => ({ allowed: true }), onChanged: () => () => {}, get: creatorId => ({
    api: { readReady: true, writeReady: true }, browser: { pageLocalReady: false, materialized: false, presentable: false },
    identity: { state: "VERIFIED", platformUserId: creatorId === c ? "100001" : "100002", sessionProofEpoch: 1 }, access: { accessEpoch: 1 },
    session: { partition: "persist:acceptance:" + creatorId, sessionEpoch: 1, canonicalRevision: 1, networkRevision: 0, runtimeGeneration: 1 },
    realtime: { ready: true, lastInboundFrameAt: new Date().toISOString() },
  }) };
  const creatorRuntime = { getVerifiedIdentity: creatorId => ({ platformUserId: creatorId === c ? "100001" : "100002" }),
    getState: () => ({ attached: true, websocket: { connected: true }, lastEventAt: new Date().toISOString() }), on: () => () => {} };
  const now = Date.now(), ago = days => new Date(now - days * 86400000).toISOString();
  const fan = id => ({ id: String(id), username: "fan_" + id, name: "Fan " + id,
    ...(String(id) !== "21051" ? { totalSpentCents: String(id) === "21001" ? 15000 : String(id) === "21002" ? 2000 : 0 } : {}),
    subscribedOnData: { isActive: true, type: "FREE" }, canReceiveChatMessage: true });
  const campaigns = Array.from({ length: 51 }, (_, i) => ({ id: String(31001 + i), name: "Source " + String(i + 1).padStart(2, "0"), is_active: true,
    created_at: ago(15), claimers_count: i === 0 ? 51 : i === 1 ? 1 : 0, clicks_count: i === 0 ? 120 : 2, trackingCode: "code_" + (i + 1) }));
  const members = id => id === "31001" ? Array.from({ length: 51 }, (_, i) => ({ id: "claimer_a_" + i, user: fan(21001 + i), createdAt: ago(12) }))
    : id === "31002" ? [{ id: "claimer_b", user: fan(21001), createdAt: ago(10) }] : [];
  let refunded = true, campaignGeneration = 1, lostProgress = false;
  const tx = (id, type, amount, status, who, age) => ({ id, descriptionDetails: { type }, amount, net: amount * 0.8, fee: amount * 0.2,
    status, currency: "USD", createdAt: ago(age), user: fan(who) });
  const transactions = () => [tx("payment-1", "message", 30, "done", 21001, 0.02), tx("payment-2", "subscribes", 10, "done", 21001, 0.03),
    tx("payment-3", "tip", 5, "loading", 21002, 0.04), tx("payment-4", "post", 20, refunded ? "undo" : "done", 21002, 0.05)];
  const notifications = [
    { id: "notification-4", type: "subscribed", createdAt: ago(0.03), user: fan(21001), amount: 10 },
    { id: "notification-3", type: "subscribed", createdAt: ago(0.04), user: fan(21002), amount: 0 },
    { id: "notification-2", type: "liked", createdAt: ago(0.05), user: fan(21001), postId: "40001" },
    { id: "notification-1", type: "commented", createdAt: ago(0.06), user: fan(21002), postId: "40001", commentId: "50001" },
  ];
  const providerTime = value => value ? Date.parse(value.includes('T') ? value : value.replace(' ', 'T') + 'Z') : -Infinity;
  const providerReads = new Map();
  const success = data => ({ ok: true, status: 200, data });
  const ofApi = { async request(input) {
    assert.equal(input.endpoint.method, "GET", "No external writes in analytics acceptance");
    const url = new URL(input.endpoint.path, "https://provider.fixture"), q = url.searchParams;
    providerCalls.push({ source: input.source, creatorId: input.creatorId, path: input.endpoint.path, generation: campaignGeneration });
    const own = input.creatorId === c;
    if (input.source === "backend.readonly.fetch_earnings.chart") {
      const start = q.get("startDate"), end = q.get("endDate"), points = new Map();
      const rows = own ? transactions().filter(row => row.status !== "undo" && row.createdAt.slice(0, 10) >= start && row.createdAt.slice(0, 10) <= end) : [];
      for (const row of rows) points.set(row.createdAt.slice(0, 10), (points.get(row.createdAt.slice(0, 10)) || 0) + row.net);
      return success({ total: { total_amount: rows.reduce((sum, row) => sum + row.net, 0), gross_amount: rows.reduce((sum, row) => sum + row.amount, 0), total_count: rows.length }, chart: [...points].map(([date, amount]) => ({ date, amount })) });
    }
    if (input.source === "backend.readonly.financial_transactions.payouts") {
      const rows = own ? transactions() : [], marker = Number(q.get("marker"));
      const first = rows.filter(row => Date.parse(row.createdAt) / 1000 <= marker && Date.parse(row.createdAt) >= providerTime(q.get("startDate")));
      return success({ list: first.slice(0, 2), hasMore: first.length > 2, ...(first.length > 2 ? { nextMarker: String(Math.floor(Date.parse(first[1].createdAt) / 1000) - 1) } : {}) });
    }
    if (input.source.startsWith("backend.readonly.financial_transactions.chart.")) {
      const category = input.source.split(".").at(-1), responseKey = category === "messages" ? "chat_messages" : category;
      const categoryType = { messages: "message", subscribes: "subscribes", tips: "tip", post: "post", stream: "stream" }[category];
      const rows = own ? transactions().filter(row => row.status !== "undo" && Date.parse(row.createdAt) >= providerTime(q.get("startDate")) && Date.parse(row.createdAt) <= providerTime(q.get("endDate")) && (category === "total" || row.descriptionDetails.type === categoryType)) : [];
      return success({ [responseKey]: { gross: rows.reduce((sum, row) => sum + row.amount, 0), total: rows.reduce((sum, row) => sum + row.net, 0), count: rows.length } });
    }
    if (input.source.startsWith("backend.readonly.notifications_")) {
      const filter = q.get("type"), rows = own ? notifications.filter(row => !filter || filter === "all" || row.type === filter) : [];
      return success({ list: q.get("fromId") ? [] : rows, hasMore: false });
    }
    if (input.source === "backend.readonly.fetch_campaigns.list") {
      const offset = Number(q.get("offset") || 0), limit = Number(q.get("limit") || 100), rows = own ? campaigns : [];
      const key = `${input.creatorId}:${campaignGeneration}:directory:${offset}`; providerReads.set(key, (providerReads.get(key) || 0) + 1);
      return success({ list: rows.slice(offset, offset + limit), hasMore: offset + limit < rows.length, total: rows.length });
    }
    if (input.source === "backend.readonly.fetch_campaigns.claimers") {
      const id = url.pathname.split("/").at(-2), rows = own ? members(id) : [], offset = Number(q.get("offset") || 0), limit = Number(q.get("limit") || 100);
      return success({ list: rows.slice(offset, offset + limit), hasMore: offset + limit < rows.length, total: rows.length });
    }
    if (input.source === "backend.readonly.fan_data_point_refresh") return success(fan(url.pathname.split("/").at(-1)));
    throw Error("UNEXPECTED_PROVIDER_REQUEST " + JSON.stringify({ source: input.source, path: input.endpoint.path }));
  } };
  let coordinator, worker;
  const makeWorker = () => {
    coordinator = new m.WorkCoordinatorService({ log, databasePath: path.join(scratch, "analytics-work.sqlite") });
    coordinator.setCapabilityResolver((...args) => capabilities.canRun(...args));
    worker = new m.BackendReadonlyJobWorker({ log, authStore, authService, creatorService, capabilities, creatorRuntime, coordinator, ofApi,
      accessRuntime: { captureAuthorizationScopePermit: () => ({}), isAuthorizationScopePermitCurrent: () => true, revokeCreator: () => { throw Error("UNEXPECTED_REVOKE"); } },
      apiRuntime: { getAll: () => ({}) }, backgroundRuntime: { isBackground: () => true }, events: { emit: () => {} },
      sessionReconcile: { reconcileDurableAccessCatalog: async () => {}, observeCanonicalManifests: () => {}, observeNetworkManifests: () => {}, hardRevokeCreator: () => { throw Error("UNEXPECTED_REVOKE"); }, hardRevokeAll: () => { throw Error("UNEXPECTED_LOGOUT"); } } });
  };
  makeWorker();
  const handlers = { ...m.createHomeHandlers(home), ...m.createCreatorAnalyticsHandlers(analytics),
    "managementCommands.listPending": () => commands.listPending(), "managementCommands.acknowledge": input => commands.acknowledge(input.commandId),
    "managementCommands.retry": input => commands.retry(input.commandId), "managementCommands.cancel": input => commands.cancel(input.commandId) };
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input)); assert.equal(url.origin, api.apiBase);
    const response = await nativeFetch(input, options), body = options?.body ? JSON.parse(options.body) : null;
    requests.push({ path: url.pathname, method: options?.method || "GET", status: response.status, kind: body?.chunkResult?.kind });
    if (lostProgress && /\/api\/jobs\/[^/]+\/progress$/.test(url.pathname) && body?.chunkResult?.kind === "campaigns_page" && response.ok) {
      lostProgress = false; await response.clone().text(); results.lostCampaignProgress = true; throw Error("CONTROLLED_LOST_CAMPAIGN_PROGRESS_RESPONSE");
    }
    return response;
  };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (fn, label, timeout = 90000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      try { if (await fn()) return; } catch (error) { if (!/DESKTOP_AUTHORIZATION_PERMIT_STALE/.test(error.code || error.message)) throw error; }
      if (Date.now() > deadline) throw Error(label + "\n" + JSON.stringify({ health: worker.health(), logs: logs.slice(-5), sources: [...new Set(providerCalls.map(row => row.source))] }));
      await wait(250);
    }
  };
  const overview = () => analytics.getOverview({ creatorId: c, rangeKey: "7d", force: true });
  const traffic = (extra = {}) => analytics.getTraffic({ creatorId: c, rangeKey: "30d", force: true, ...extra });
  let renewal, server, browser, page;
  try {
    renewal = setInterval(publishAuthority, 30000);
    const creators = (await creatorService.list()).creators;
    const renderer = path.join(desktop, "apps/desktop/renderer/src"), fixture = path.join(scratch, "analytics-renderer.tsx"), script = path.join(scratch, "analytics-renderer.js");
    fs.writeFileSync(fixture, `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';
import{HomeDashboard}from ${JSON.stringify(path.join(renderer, "features/workspace/home/HomeDashboard.tsx"))};
import{CreatorAnalyticsWorkspace}from ${JSON.stringify(path.join(renderer, "features/creator-analytics/CreatorAnalyticsWorkspace.tsx"))};
import{acceptRendererAuthorizationProjection}from ${JSON.stringify(path.join(renderer, "shared/rpc/authorization-scope.ts"))};
import ${JSON.stringify(path.join(renderer, "styles.css"))};
const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});let root;
function App({input}){const[view,setView]=useState('home');const props={session:input.session,creators:input.creators,activeCreator:input.creators.find(c=>c.id===input.projection.activeCreatorId)};return <><nav aria-label="Acceptance workspace"><button onClick={()=>setView('home')}>Home</button><button onClick={()=>setView('analytics')}>Analytics</button></nav>{view==='home'?<HomeDashboard {...props} authorizationRevision={1}/>:<CreatorAnalyticsWorkspace {...props}/>}</>}
export function mount(input){window.onlinod={events:{onDesktopAuthorizationEvent:()=>()=>{},onCreatorRuntimeEvent:()=>()=>{}},rpc:{call:async(method,payload)=>{const r=await window.actualRpc(method,payload);if(r.error)throw Object.assign(Error(r.error.message),{code:r.error.code});return r.result;}}};acceptRendererAuthorizationProjection(input.projection);root=createRoot(document.getElementById('root'));root.render(<React.StrictMode><QueryClientProvider client={client}><App input={input}/></QueryClientProvider></React.StrictMode>);}
export async function refresh(){await client.invalidateQueries();}`);
    await load("esbuild").build({ entryPoints: [fixture], outfile: script, bundle: true, platform: "browser", format: "iife", globalName: "ActualAnalytics",
      jsx: "automatic", nodePaths: [path.join(desktop, "node_modules")], alias: { "@onlinod/shared": path.join(desktop, "packages/shared/src/index.ts") },
      loader: { ".css": "css", ".png": "dataurl", ".svg": "dataurl" }, define: { "process.env.NODE_ENV": '"development"' } });
    server = http.createServer((req, res) => {
      const file = req.url === "/app.js" ? script : req.url === "/app.css" ? script.replace(/js$/, "css") : null;
      res.setHeader("Content-Type", file ? file.endsWith(".js") ? "application/javascript" : "text/css" : "text/html");
      res.end(file ? fs.readFileSync(file) : '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const chromium = runtime("@sparticuz/chromium");
    browser = await runtime("playwright").chromium.launch({ executablePath: process.env.ONLINOD_CHROMIUM_PATH || await chromium.executablePath(), args: chromium.args, headless: true });
    page = await browser.newPage({ viewport: { width: 1536, height: 1050 } });
    page.on("pageerror", error => errors.push(error.message));
    page.on('console', entry => { if (entry.type() === 'error' && /same key|unique.*key/i.test(entry.text())) errors.push(entry.text()); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.route("**/*", route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    await page.exposeFunction("actualRpc", async (method, input) => {
      calls.push({ method, input });
      try {
        assert.ok(handlers[method], "Unexpected RPC " + method); const result = await handlers[method](input);
        if (heldTraffic && method === "creatorAnalytics.getTraffic" && input.creatorId === c && input.rangeKey === heldTraffic.range) { const held = heldTraffic; heldTraffic = null; held.enter(); await held.promise; }
        return { result };
      } catch (error) { return { error: { message: error.message, code: error.code } }; }
    });
    await page.goto(origin);
    await page.evaluate(input => window.ActualAnalytics.mount(input), { creators, session: { ...authStore.readSession(), permissions },
      projection: { ok: true, authenticated: true, current: true, quarantineState: "CURRENT", localAuthorizationRevision: 1,
        session: { ...authStore.readSession(), accessToken: undefined, refreshToken: undefined }, creators, activeCreatorId: c } });
    const app = name => page.getByRole("navigation", { name: "Acceptance workspace" }).getByRole("button", { name, exact: true }).click();
    const view = name => page.getByRole("navigation", { name: "Creator Analytics views" }).getByRole("button", { name: new RegExp(name) }).click();
    const scanner = name => page.getByRole("navigation", { name: "Creator Analytics scanners" }).getByRole("button", { name: new RegExp(name) }).click();
    const showTrafficSource = async name => {
      const table = page.getByRole('table', { name: 'Traffic sources' });
      await until(async () => await page.getByRole('button', { name: 'Reload saved data', exact: true }).isEnabled(), 'Traffic reload did not settle');
      await until(async () => (await table.locator('tbody tr').count()) > 0 && !(await table.innerText()).includes('Loading traffic'), 'Traffic page did not load');
      if (!await table.getByText(name, { exact: true }).count()) await page.getByRole('button', { name: 'Next sources', exact: true }).click();
      await table.getByText(name, { exact: true }).waitFor();
    };
    results.emptyHome = await home.getSummary({ rangeKey: "7d" }); assert.equal(results.emptyHome.revenue.totalCents, null);
    await page.screenshot({ path: path.join(output, "home-empty.png"), fullPage: true });
    pass("Empty current Home and actual creator bootstrap preserve unknown earnings");
    await app("Analytics");
    await until(async () => await page.locator('.co-finance-summary .co-metric-card').first().locator('strong').textContent() === '—', 'Unknown overview became zero');
    await page.screenshot({ path: path.join(output, "overview-empty.png"), fullPage: true });
    await app("Home");
    await home.refresh({ rangeKey: "7d" }); coordinator.start(); worker.start();
    await until(async () => { results.home = await home.getSummary({ rangeKey: "7d" }); return results.home.revenue.coverage.reportingCreators === 2; }, "Home collection did not publish both creators", 300000);
    assert.equal(results.home.revenue.totalCents, 3600); results.homeCreators = await home.getCreators({ rangeKey: "7d" });
    assert.equal(results.homeCreators.creators.find(row => row.id === c).revenueCents, 3600);
    assert.equal(results.homeCreators.creators.find(row => row.id !== c).revenueCents, 0);
    await page.evaluate(() => window.ActualAnalytics.refresh()); await page.locator(".hq-metric.primary .hq-metric-value").getByText("$36", { exact: true }).waitFor({ timeout: 60000 });
    results.homeAxisLabels = await page.locator('.hq-sparkline-axis span').allTextContents();
    assert.equal(results.homeAxisLabels.length, 7); assert(results.homeAxisLabels.every(label => /^\d{2} [A-Z][a-z]{2}$/.test(label)));
    await page.screenshot({ path: path.join(output, "home-populated.png"), fullPage: true });
    pass("Actual earnings handler -> durable daily coverage -> Home totals and separate creator rows");

    await app("Analytics"); await view("DATA SOURCES"); await scanner("FINANCIAL TRANSACTIONS"); await page.getByRole("button", { name: "START MONEY SCAN", exact: true }).click(); worker.wakeAvailableJob();
    await until(async () => { results.financial = await analytics.getFinancialTransactionScan({ creatorId: c }); return results.financial.status === "COMPLETE"; }, "Financial scan did not finish");
    assert.equal(results.financial.items.length, 4); results.firstOverview = await overview();
    await until(async () => { results.firstOverview = await overview(); return results.firstOverview.finance.netCents === 3600; }, "Financial publication missing from overview");
    assert.equal(results.firstOverview.finance.refundGrossCents, 2000);
    await page.screenshot({ path: path.join(output, "financial-collected.png"), fullPage: true });
    pass("Actual financial worker collects two payout pages and six chart checks; refunds stay separate from net earnings");

    await scanner("NOTIFICATIONS"); await page.getByRole("button", { name: "START SCAN", exact: true }).click(); worker.wakeAvailableJob();
    await until(async () => { results.notifications = await analytics.getNotificationScan({ creatorId: c }); return results.notifications.status === "COMPLETE"; }, "Notification scan did not finish");
    await until(async () => { results.notificationOverview = await overview(); return results.notificationOverview.activity.newSubscribers === 2; }, "Notification activity did not publish");
    assert.equal(results.notificationOverview.activity.likes, 1); assert.equal(results.notificationOverview.activity.comments, 1);
    pass("Actual typed notification history -> published audience/activity with two subscriptions, a like and a comment");

    await scanner("CAMPAIGNS"); lostProgress = true;
    await page.getByRole("button", { name: "START SCAN", exact: true }).click(); worker.wakeAvailableJob();
    await until(async () => { results.campaignScan = await analytics.getCampaignScan({ creatorId: c }); return results.campaignScan.collectorStatus === "COMPLETE"; }, "Campaign traversal did not finish", 180000);
    await until(async () => { results.traffic = await traffic(); return results.traffic.projection.ready && results.traffic.totals.sourceMembers === 52; }, "Traffic projection did not finish", 240000);
    await until(async () => { results.campaigns = await analytics.getCampaignPage({ creatorId: c, rangeKey: "7d", limit: 100 }); return results.campaigns.projection.ready; }, "Campaign read projection did not finish");
    assert.equal(results.campaigns.totals.memberships, 52); assert.equal(results.campaigns.totals.uniqueFans, 51);
    assert.equal(results.campaigns.totals.netCents, 3600);
    assert.equal(results.traffic.totals.sources, 51); assert.equal(results.traffic.totals.fanValueCents, 17000); assert.equal(results.traffic.totals.valuePendingMembers, 1);
    assert.equal(results.traffic.totals.valueSnapshotMembers + results.traffic.totals.valuePendingMembers, 51);
    assert.equal(results.traffic.totals.subscriptionRevenueCents, 1000); assert.equal(results.lostCampaignProgress, true);
    assert.equal(providerReads.get(`${c}:1:directory:0`), 1);
    pass("51 Campaign sources / 52 memberships / 51 unique fans publish through actual workers; lost progress recovers and Traffic deduplicates fan spend");

    await view("OVERVIEW");
    await page.locator('.co-finance-summary .co-metric-card').first().getByText('$36.00', { exact: true }).waitFor();
    await page.locator('.coa-main').filter({ hasText: 'Source 02' }).click();
    await page.locator('.coa-drop').getByText('@fan_21001', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, "campaign-overview.png"), fullPage: true });
    pass("Actual Overview and Campaign accordion show published earnings, attributed paying fans and separate unknown lifetime value");

    await view("TRAFFIC"); await until(async () => await page.getByRole('button', { name: 'Next sources', exact: true }).isEnabled(), 'Traffic first page did not load');
    await page.getByRole("button", { name: "Next sources", exact: true }).click();
    await until(async () => (await page.getByRole("table", { name: "Traffic sources" }).locator("tbody tr").count()) === 1, "Source page two not displayed");
    await page.getByRole("button", { name: "Previous sources", exact: true }).click();
    await showTrafficSource('Source 01');
    await page.getByRole("button", { name: "View fans from Source 01", exact: true }).click();
    await page.getByRole("button", { name: "Next fans", exact: true }).click();
    await page.getByText("fan_21051", { exact: false }).last().waitFor(); await page.getByText("Not available yet", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Previous fans", exact: true }).click();
    await page.screenshot({ path: path.join(output, "traffic-members.png"), fullPage: true });
    pass("Actual Traffic UI source/member pagination, shared-fan totals and explicit unknown spend");

    await page.getByRole("button", { name: "Edit cost for Source 01", exact: true }).click();
    await page.getByLabel("Source cost", { exact: true }).fill("25.50");
    await page.getByRole("button", { name: "Save cost", exact: true }).click();
    await until(async () => { results.cost = (await traffic()).sources.find(row => row.name === "Source 01"); return results.cost?.costCents === 2550; }, "Cost UI did not commit");
    assert.equal(results.cost.costRevision, 1);
    await page.getByRole('form', { name: 'Cost for Source 01', exact: true }).waitFor({ state: 'hidden' });
    await page.getByRole('table', { name: 'Traffic sources' }).locator('tr').filter({ hasText: 'Source 01' }).getByText('$25.50', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, "traffic-cost.png"), fullPage: true });
    pass("Actual cost editor -> durable command -> revision checked server commit -> refreshed Traffic UI");

    await page.getByRole("button", { name: "Edit cost for Source 01", exact: true }).click();
    await page.getByLabel("Source cost", { exact: true }).fill("26.75"); await page.getByLabel("Cost currency", { exact: true }).fill("EUR"); loseCostReply = true;
    await page.getByRole("button", { name: "Save cost", exact: true }).click();
    await page.getByRole("button", { name: "Recover", exact: true }).click();
    await until(async () => commands.listPending().length === 0, "Cost receipt was not recovered");
    results.recoveredCost = (await traffic()).sources.find(row => row.name === "Source 01");
    assert.equal(results.recoveredCost.costCents, 2675); assert.equal(results.recoveredCost.currency, "EUR"); assert.equal(results.recoveredCost.costRevision, 2);
    assert.equal(results.lostCostReply, true);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    pass("Lost cost response is recovered through the actual UI journal with the same receipt; one revision and original EUR currency");

    await page.getByLabel('Traffic revenue period').selectOption('prev_year');
    await until(async () => await page.locator('.traffic-metrics article').nth(1).locator('strong').textContent() === '$0.00', 'Period-specific revenue did not change');
    assert.equal(await page.locator('.traffic-metrics article').nth(2).locator('strong').textContent(), '$170.00');
    await page.getByLabel('Traffic revenue period').selectOption('30d');
    await showTrafficSource('Source 01');
    pass("Traffic period switch changes subscription revenue while lifetime fan spend remains separate");

    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; }), promise = new Promise(resolve => { release = resolve; });
    heldTraffic = { enter, promise, range: '7d' };
    await page.getByLabel('Traffic revenue period').selectOption('7d');
    await Promise.race([entered, wait(10000).then(() => { throw Error("Traffic response was not held"); })]);
    await page.locator(".creator-ledger-rail-list").getByRole("button").filter({ hasText: "model_two" }).click();
    await until(async () => (await page.getByRole("table", { name: "Traffic sources" }).innerText()).includes("No traffic sources"), "Model two not isolated");
    release(); await wait(200);
    assert.equal(await page.getByText("Source 01", { exact: true }).count(), 0);
    await page.locator(".creator-ledger-rail-list").getByRole("button").filter({ hasText: "model_one" }).click();
    await showTrafficSource('Source 01');
    pass("Delayed model-one response cannot populate model two; model switches reset source/member pages");

    refunded = false;
    await view("DATA SOURCES"); await scanner("FINANCIAL TRANSACTIONS");
    await page.getByRole('button', { name: 'START MONEY SCAN', exact: true }).click(); worker.wakeAvailableJob();
    await view("OVERVIEW");
    await until(async () => { results.correctedOverview = await overview(); return results.correctedOverview.finance.netCents === 5200; }, "Financial correction was not published", 120000);
    assert.equal(results.correctedOverview.finance.refundGrossCents, 0);
    results.correctedScan = await analytics.getFinancialTransactionScan({ creatorId: c }); assert.equal(results.correctedScan.items.length, 4);
    await page.locator('.co-finance-summary .co-metric-card').first().getByText('$52.00', { exact: true }).waitFor({ timeout: 45000 });
    await page.screenshot({ path: path.join(output, 'overview-corrected.png'), fullPage: true });
    pass("Provider correction of an existing refund updates the actual Overview automatically: four transactions, net $52, no duplicated fact");
    await view("TRAFFIC");
    campaignGeneration = 2; campaigns[0].name = "Source 01 refreshed";
    await page.getByRole("button", { name: "Update sources", exact: true }).click(); worker.wakeAvailableJob();
    await until(async () => { results.rescan = await traffic(); return results.rescan.projection.ready && results.rescan.sources.some(row => row.name === "Source 01 refreshed"); }, "Traffic refresh did not publish", 180000);
    assert.equal(results.rescan.sources.find(row => row.name === "Source 01 refreshed").costCents, 2675);
    assert.equal(results.rescan.sources.find(row => row.name === "Source 01 refreshed").currency, "EUR");
    assert.equal(results.rescan.totals.sourceMembers, 52); assert.equal(results.rescan.totals.fanValueCents, 17000);
    await worker.stop(); await coordinator.destroy(); const killed = await f.stop("SIGKILL"); assert.equal(killed.signal, "SIGKILL"); await f.boot();
    creatorService.invalidateBootstrap(); publishAuthority(); makeWorker(); coordinator.start(); worker.start();
    results.afterRestart = await traffic(); assert.equal(results.afterRestart.totals.sourceMembers, 52);
    assert.equal(results.afterRestart.sources.find(row => row.name === "Source 01 refreshed").costCents, 2675);
    await page.getByRole("button", { name: "Reload saved data", exact: true }).click();
    await showTrafficSource('Source 01 refreshed');
    await page.getByRole('table', { name: 'Traffic sources' }).locator('tr').filter({ hasText: 'Source 01 refreshed' }).getByText('€26.75', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, "traffic-recovered.png"), fullPage: true });
    assert.deepEqual(errors, []);
    pass("Repeat provider collection preserves manual cost and exact totals; SQLite reopen and Backend SIGKILL retain the populated UI");
    results.browserVersion = await browser.version();
  } catch (error) {
    await worker.stop();
    results.failureState = await f.withDatabase(async db => ({
      coverage: await db.analyticsCoverage.findMany({ where: { agencyId, dataType: 'EARNINGS' } }),
      proofs: await db.analyticsScanProof.findMany({ where: { agencyId, dataType: 'EARNINGS' } }),
      jobs: await db.jobInstance.findMany({ where: { agencyId }, select: { jobKey: true, status: true, lastError: true, params: true } }),
      publications: await db.analyticsPublication.findMany({ where: { agencyId }, select: { jobId: true, state: true, stage: true, attempts: true, lastError: true, proof: true } }),
      work: await db.domainWorkItem.findMany({ where: { agencyId, workClass: { in: ['ANALYTICS_PUBLICATION', 'ANALYTICS_FACT_PUBLICATION', 'TRAFFIC_BACKFILL', 'TRAFFIC_FACT', 'TRAFFIC_FAN'] } } }),
    }));
    throw error;
  } finally {
    clearInterval(renewal); await worker.stop(); await coordinator.destroy(); analytics.destroy();
    results.renderer = { calls, errors, requests }; results.provider = { calls: providerCalls, campaignDirectoryReads: [...providerReads], externalWrites: 0 };
    fs.writeFileSync(path.join(output, "worker-log.json"), JSON.stringify(logs, null, 2));
    await page?.screenshot({ path: path.join(output, "last-screen.png"), fullPage: true }).catch(() => {});
    await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    globalThis.fetch = nativeFetch;
  }
};

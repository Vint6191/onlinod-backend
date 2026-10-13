"use strict";
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http");
const { createRequire } = require("node:module"),
  { pathToFileURL } = require("node:url");

function crmResult(history = false) {
  const identity = Object.fromEntries(
    [
      "name",
      "preferred_address",
      "age",
      "country",
      "city",
      "location",
      "native_language",
      "chat_language",
      "timezone",
      "profession",
    ].map((k) => [k, ""])
  );
  Object.assign(identity, { name: "Alex", country: "Spain", chat_language: "English", profession: "Designer" });
  const common = {
    sexual_dynamic: {
      fan_role: "unknown",
      preferred_creator_role: "unknown",
      control_preference: "unknown",
      notes: "",
    },
    fetishes: [],
    content_preferences: [],
    turn_on_triggers: [],
    requested_content: [],
    boundaries: ["No phone calls"],
    negations: [],
    evidence_notes: ["The fan is planning a trip."],
  };
  const sales = { budget_min: null, budget_max: null, price_resistance: "" };
  return history
    ? { ...common, identity_facts: identity, sales_facts: sales, behavior: [] }
    : {
        ...common,
        identity,
        sales,
        strategy: {
          recommended_tone: "friendly",
          sales_trigger: "",
          do_not_do: ["Do not promise phone calls"],
          summary: "Discussing travel and photography.",
        },
        notes_auto: ["Interested in travel."],
        reply_suggestions: [],
      };
}

exports.runDialog = async function (f) {
  const {
    modules: m,
    desktop,
    scratch,
    output,
    auth,
    api,
    agencyId,
    deviceId,
    creatorId: c,
    creatorIds,
    must,
    pass,
    results,
  } = f;
  const load = createRequire(path.join(desktop, "package.json")),
    runtime = createRequire(path.join(process.env.ONLINOD_BROWSER_RUNTIME, "package.json"));
  const logs = [],
    requests = [],
    calls = [],
    errors = [],
    providerCalls = [],
    aiCalls = [];
  const log = Object.fromEntries(
    ["debug", "info", "warn", "error"].map((level) => [
      level,
      (...args) =>
        logs.push({
          level,
          args: JSON.parse(
            JSON.stringify(args, (_k, v) => (v instanceof Error ? { message: v.message, code: v.code } : v))
          ),
        }),
    ])
  );
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const pendingReleases = new Set();
  const deferred = () => {
    let release;
    const promise = new Promise((r) => {
      release = r;
    });
    const resolve = () => {
      pendingReleases.delete(resolve);
      release();
    };
    pendingReleases.add(resolve);
    return { promise, resolve };
  };
  const until = async (fn, label, timeout = 30000) => {
    const end = Date.now() + timeout;
    while (!(await fn())) {
      if (Date.now() > end) throw Error(label + " " + JSON.stringify(logs.slice(-4)));
      await wait(50);
    }
  };
  const authStore = {
    ...auth,
    readSession: () => ({ ...auth.readSession(), deviceId }),
    getDeviceId: () => deviceId,
    getAuthorizationScopeHash: () => agencyId + ":" + deviceId,
    getActiveCreatorId: () => c,
    setActiveCreatorId() {},
    onSessionChanged: () => () => {},
  };
  const authService = { ensureSession: async () => ({ authenticated: true, session: authStore.readSession() }) };
  const permissions = { ...f.login.permissions, "chats.read": true, "chats.reply": true, "content.manage_vault": true };
  const authority = new m.DesktopCurrentAuthorizationAuthorityService({
    log,
    authStore,
    accessRuntime: {
      currentAuthorityProof: () => ({ accessEpoch: 1, creatorCatalogGeneration: 1 }),
      allowedCreatorIdsSnapshot: () => creatorIds,
    },
  });
  const publish = () =>
    authority.publish({
      accessEpoch: 1,
      creatorCatalogGeneration: 1,
      role: "OWNER",
      roleKey: "owner",
      effectivePermissions: permissions,
      allowedCreatorIds: creatorIds,
      observedAt: Date.now(),
      observedAtMono: performance.now(),
      billing: {
        version: 1,
        validForMs: 90000,
        creators: creatorIds.map((creatorId) => ({ creatorId, allowed: true, validForMs: 90000, reason: "TRIAL" })),
      },
    });
  publish();
  const coordinator = new m.WorkCoordinatorService({ log, databasePath: path.join(scratch, "dialog-work.sqlite") });
  coordinator.setCapabilityResolver(() => ({ allowed: true }));
  coordinator.setAuthorizationResolver(({ item, authorizationClass, provenance }) =>
    authorizationClass === "HUMAN_COMMAND"
      ? authority.evaluateHumanCommandProvenance(provenance)
      : authorizationClass === "CURRENT_DATA_PROCESS"
        ? authority.evaluateCurrentDataProcess(item.creatorId)
        : { allowed: true }
  );
  coordinator.setControlAuthorizationResolver({
    allowedCreatorIds: () => creatorIds,
    authorizeCreator: () => ({ allowed: true }),
  });
  const commands = new m.ManagementCommandTransport(
    api,
    authStore,
    path.join(scratch, "dialog-commands.json"),
    authority,
    () => {}
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).startsWith(api.apiBase), "External fetch forbidden");
    const response = await originalFetch(url, init);
    requests.push({
      method: init?.method || "GET",
      url: String(url).slice(api.apiBase.length),
      status: response.status,
    });
    return response;
  };
  const mediaLibrary = new m.MediaLibraryService({
    log,
    authStore,
    authService,
    authorization: authority,
    coordinator,
    managementCommands: commands,
  });
  const listeners = new Map();
  const creatorRuntime = {
    on(name, fn) {
      const set = listeners.get(name) || new Set();
      set.add(fn);
      listeners.set(name, set);
      return () => set.delete(fn);
    },
    onStateChanged: () => () => {},
    getAll: () => ({}),
    getVerifiedIdentity: (id) => ({ platformUserId: id === c ? "100001" : "100002" }),
    getManagedRealtimeLastInboundFrameAt: () => null,
  };
  const dialogId = "422411209";
  const source = Array.from({ length: 65 }, (_, i) => ({
    id: String(700001 + i),
    fromUser: { id: i % 2 ? 100001 : Number(dialogId) },
    text:
      i === 0
        ? "My name is Alex. I live in Spain and work as a designer. No phone calls please."
        : i === 64
          ? "I am planning a trip next week."
          : "Travel conversation " + i,
    createdAt: new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString(),
    media: i === 63 ? [{ id: "99001" }] : [],
    price: i === 63 ? 12.5 : 0,
    isOpened: i === 63,
  }));
  const ofApi = {
    async request(input) {
      providerCalls.push({ creatorId: input.creatorId, source: input.source, endpoint: input.endpoint });
      assert.equal(input.endpoint.method, "GET");
      const u = new URL(input.endpoint.path, "https://onlyfans.com");
      const limit = Number(u.searchParams.get("limit") || 30),
        first = Number(u.searchParams.get("id") || u.searchParams.get("firstId") || Infinity);
      const rows =
        input.creatorId === c && u.pathname.includes(dialogId)
          ? source.filter((row) => Number(row.id) < first).sort((a, b) => Number(b.id) - Number(a.id))
          : [];
      return { ok: true, status: 200, data: { list: rows.slice(0, limit), hasMore: rows.length > limit } };
    },
  };
  let aiHook = null,
    rpcBefore = null,
    rpcAfter = null,
    aiActive = 0,
    aiMaxActive = 0;
  const ai = new m.AiInferenceService(
    new m.AiDispatcher(),
    new m.OllamaProvider(async (url, init) => {
      const u = new URL(url);
      assert.equal(u.hostname, "127.0.0.1");
      if (u.pathname.endsWith("/version")) return Response.json({ version: "0.32.0" });
      if (u.pathname.endsWith("/show")) return Response.json({ model_info: { "test.context_length": 16384 } });
      assert.ok(u.pathname.endsWith("/generate"));
      const body = JSON.parse(init.body),
        prompt = body.prompt;
      const kind =
        body.format !== "json"
          ? "translation"
          : prompt.startsWith("Write 3 ready-to-send")
            ? "replies"
            : prompt.startsWith("You produce")
              ? "final"
              : prompt.startsWith("Merge")
                ? "merge"
                : "history";
      const entry = { kind, prompt, model: body.model };
      aiCalls.push(entry);
      aiMaxActive = Math.max(aiMaxActive, ++aiActive);
      try {
        if (aiHook) {
          const injected = await aiHook(entry, init.signal);
          if (injected instanceof Response) return injected;
        }
        init.signal?.throwIfAborted();
        let answer;
        if (kind === "translation") {
          const target = prompt.match(/messages into ([^.]+)\./)?.[1];
          answer =
            target === "Spanish"
              ? "hola desde el viaje"
              : target === "Ukrainian"
                ? "привіт із подорожі"
                : target === "Russian"
                  ? "привет из поездки"
                  : "hello from the trip";
        } else if (kind === "replies")
          answer = JSON.stringify({
            reply_suggestions: [
              { text: "Where are you planning to go?", intent: "rapport", tone: "friendly", confidence: 0.9 },
              {
                text: "What would you like to photograph there?",
                intent: "rapport",
                tone: "friendly",
                confidence: 0.9,
              },
              {
                text: "Tell me about your plans for next week.",
                intent: "follow_up",
                tone: "friendly",
                confidence: 0.9,
              },
            ],
          });
        else answer = JSON.stringify(crmResult(kind !== "final"));
        return Response.json({
          done: true,
          done_reason: "stop",
          response: answer,
          prompt_eval_count: 1000,
          eval_count: 300,
        });
      } finally {
        aiActive--;
      }
    })
  );
  const computeWorker = new m.ComputeWorkerService({
    log,
    workerFactory: () => new (require("node:worker_threads").Worker)(path.join(scratch, "compute-worker.cjs")),
  });
  let dialogs, unbindUsage;
  const openDialogs = () => {
    dialogs = new m.DialogMessagesService({
      log,
      ofApi,
      creatorRuntime,
      workCoordinator: coordinator,
      computeWorker,
      ai,
      authorization: authority,
      mediaUsageSink: mediaLibrary,
    });
    unbindUsage = mediaLibrary.bindUsageSourceProvider(dialogs);
  };
  openDialogs();
  const translator = new m.TranslatorService(log, authority, ai);
  const brain = new m.CreatorAiProfileService(log, authority);
  const handlers = () => ({
    ...m.createDialogCrmHandlers(dialogs),
    ...m.createTranslatorHandlers(translator),
    ...m.createCreatorAiProfileHandlers(brain),
  });
  let browser, context, server, page, renewal;
  try {
    renewal = setInterval(publish, 30000);
    coordinator.start();
    const asset = await mediaLibrary.upsertMetadata({
      creatorId: c,
      onlyfansMediaId: "99001",
      expectedAssetId: null,
      expectedUpdatedAt: null,
      mediaType: "photo",
      description: "Travel photo",
      manualTags: [],
      visibleBodyParts: [],
      accessType: "paid",
      minPrice: 12.5,
      idealPrice: 12.5,
    });
    assert.equal(asset.ok, true);
    commands.acknowledge(asset.commandId);
    const scan = await dialogs.scan(
      { creatorId: c, dialogId, mode: "full", limit: 40, pageDelayMs: 0 },
      { waitTimeoutMs: 10000 }
    );
    assert.equal(scan.ok, true, JSON.stringify(scan));
    const snapshot = await dialogs.getCrmPanelSnapshot({ creatorId: c, dialogId });
    assert.equal(snapshot.stats.messagesCount, 65);
    assert.equal(snapshot.stats.fullScanDone, true);
    results.scan = scan;
    await until(async () => {
      const s = await dialogs.getCrmPanelSnapshot({ creatorId: c, dialogId });
      return s.profile.analysisStatus === "done";
    }, "CRM analysis did not finish");
    results.profile = await dialogs.getCrmPanelSnapshot({ creatorId: c, dialogId });
    results.localUsage = await Array.fromAsync(dialogs.iterateMediaLibraryUsageSources(c));
    results.sales = await mediaLibrary.getSalesSummary(c);
    pass(
      "Actual dialog scan/coordinator -> SQLite worker -> durable paged CRM inference and media usage SQL projection"
    );

    const creators = await Promise.all(
      creatorIds.map(async (id) => (await must("GET", `/api/creators/${id}`)).creator)
    );
    const renderer = path.join(desktop, "apps/desktop/renderer/src"),
      runtimes = path.join(desktop, "apps/desktop/electron/page-runtimes");
    const entry = path.join(scratch, "dialog-renderer.tsx"),
      script = path.join(scratch, "dialog-renderer.js");
    fs.writeFileSync(
      entry,
      `import React from'react';import{createRoot}from'react-dom/client';
import{DialogCrmSidecarRuntime}from ${JSON.stringify(path.join(renderer, "tool-sidecar/modules/crm/lifecycle.ts"))};
import{createSidecarRuntimeHost}from ${JSON.stringify(path.join(renderer, "tool-sidecar/runtime-host.ts"))};
import{TranslatorPageRuntime}from ${JSON.stringify(path.join(runtimes, "translator-page/lifecycle.ts"))};
import{findInputEditor}from ${JSON.stringify(path.join(runtimes, "translator-page/dom.ts"))};
import{CreatorAiProfileDashboard}from ${JSON.stringify(path.join(renderer, "features/creator-ai-profile/CreatorAiProfileDashboard.tsx"))};
import{acceptRendererAuthorizationProjection}from ${JSON.stringify(path.join(renderer, "shared/rpc/authorization-scope.ts"))};
import ${JSON.stringify(path.join(renderer, "styles.css"))};
let root,crm,translator,host,mutation;let creatorId,dialogId;
export async function rpc(method,input){const r=await window.actualRpc(method,input);if(r.error)throw Object.assign(Error(r.error.message),{code:r.error.code});return r.result;}
export async function mount(input){creatorId=input.creatorId;dialogId=input.dialogId;window.nod={events:{onDesktopAuthorizationEvent:()=>()=>{}},rpc:{call:rpc}};acceptRendererAuthorizationProjection(input.projection);window.__NOD_TOOL_SIDECAR_CONTEXT__={url:'https://onlyfans.com/my/chats/chat/'+dialogId,creatorId};window.nodToolSidecar={copyText:async text=>{window.lastCopied=text;return{ok:true}},setSurfaceState(){}};host=createSidecarRuntimeHost();crm=new DialogCrmSidecarRuntime(host,Object.fromEntries(['getPanel','updateProfile','analyzeProfile','generateReplies'].map(name=>[name,i=>rpc('dialogCrm.'+name,{...i,creatorId})])));await crm.mount(window.__NOD_TOOL_SIDECAR_CONTEXT__);window.crmRuntime=crm;}
export function switchCreator(id){creatorId=id;window.__NOD_TOOL_SIDECAR_CONTEXT__={url:'https://onlyfans.com/my/chats/chat/'+dialogId,creatorId};crm.refresh(window.__NOD_TOOL_SIDECAR_CONTEXT__);}
export async function translate(){const hostApi={...createSidecarRuntimeHost(),onDomMutation:fn=>{mutation=fn;return()=>{mutation=null}}};translator=new TranslatorPageRuntime(hostApi,Object.fromEntries(['getState','updateSettings','translate','clearCache'].map(name=>[name,i=>rpc('translator.'+name,name==='translate'?{...i,creatorId}:i)])));await translator.mount();window.translatorRuntime=translator;}
export function changed(){mutation?.({addedElements:[],removedElements:[],changedElements:[document.querySelector('[data-message-id]')],mutationCount:1,timestamp:Date.now()});}
export function applySettings(settings){translator.applyHostSettings({translator:settings});}
export function selectedInput(){return findInputEditor()?.id||null;}
export function brain(input){crm?.destroy();translator?.destroy();root=createRoot(document.getElementById('root'));root.render(<React.StrictMode><CreatorAiProfileDashboard creators={input.creators} activeCreator={input.creators[0]}/></React.StrictMode>);}
export function unmount(){crm?.destroy();translator?.destroy();host?.destroy();root?.unmount();}
`
    );
    await load("esbuild").build({
      entryPoints: [entry],
      outfile: script,
      bundle: true,
      platform: "browser",
      format: "iife",
      globalName: "ActualDialog",
      alias: { "@nod/shared": path.join(desktop, "packages/shared/src/index.ts") },
      jsx: "automatic",
      nodePaths: [path.join(desktop, "node_modules")],
      loader: { ".css": "css", ".png": "dataurl", ".svg": "dataurl" },
      define: { "process.env.NODE_ENV": '"development"' },
      plugins: [
        {
          name: "inline-css",
          setup(build) {
            build.onResolve({ filter: /\.css\?inline$/ }, (args) => ({
              path: path.resolve(args.resolveDir, args.path.slice(0, -7)),
              namespace: "inline-css",
            }));
            build.onLoad({ filter: /.*/, namespace: "inline-css" }, (args) => ({
              contents: fs.readFileSync(args.path, "utf8"),
              loader: "text",
            }));
          },
        },
      ],
    });
    server = http.createServer((req, res) => {
      const file = req.url === "/app.js" ? script : req.url === "/app.css" ? script.replace(/js$/, "css") : null;
      res.setHeader("Content-Type", file ? (file.endsWith("js") ? "application/javascript" : "text/css") : "text/html");
      res.end(
        file
          ? fs.readFileSync(file)
          : '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><style>body{background:#111;color:#ddd;padding:25px}#native-chat{width:700px}.b-chat__message{margin:20px;padding:15px;background:#25252d;border-radius:10px}.b-chat__message-form{margin-top:30px;padding:20px;background:#25252d}textarea{color:#eee;background:#16161b;width:600px;min-height:80px}a{color:#9edcff}</style><div id="root"></div><div id="native-chat"><h1>Dialog acceptance</h1><div class="b-chat__messages"><div class="b-chat__message" data-message-id="700065"><div class="b-chat__message__text">Hello <a href="#trip">travel friend</a><br>How are you?</div></div></div><form class="b-chat__message-form"><textarea id="composer" class="b-chat__input">привет из поездки</textarea></form><input id="search" type="text" value="search text"></div><script src="/app.js"></script>'
      );
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const { default: chromium } = await import(pathToFileURL(runtime.resolve("@sparticuz/chromium")).href);
    browser = await runtime("playwright").chromium.launch({
      executablePath: process.env.ONLINOD_CHROMIUM_PATH || (await chromium.executablePath()),
      args: chromium.args,
      headless: true,
    });
    context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on("pageerror", (e) => errors.push(e.message));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.route("**/*", (r) => (r.request().url().startsWith(origin) ? r.continue() : r.abort()));
    await page.exposeFunction("actualRpc", async (method, input) => {
      calls.push({ method, input });
      try {
        assert.ok(handlers()[method], "Unexpected RPC " + method);
        if (rpcBefore) await rpcBefore(method, input);
        const result = await handlers()[method](input);
        if (rpcAfter) await rpcAfter(method, input, result);
        return { result };
      } catch (e) {
        return { error: { message: e.message, code: e.code } };
      }
    });
    await page.goto(origin + "/my/chats/chat/" + dialogId);
    await page.addStyleTag({ content: "#root:empty{display:none}" });
    const mount = {
      creators,
      creatorId: c,
      dialogId,
      projection: {
        ok: true,
        authenticated: true,
        current: true,
        quarantineState: "CURRENT",
        localAuthorizationRevision: 1,
        session: { ...authStore.readSession(), accessToken: undefined, refreshToken: undefined },
        creators,
        activeCreatorId: c,
      },
    };
    await page.evaluate((i) => ActualDialog.mount(i), mount);
    await page.locator('[data-onrail-id="crm"],.onrail-btn[title="CRM"]').first().click();
    await page.locator('[data-oncrm-field="preferredName"]').fill("Manual Alex");
    await page.locator('[data-oncrm-tab="notes"]').click();
    await page.locator('[data-oncrm-tab="profile"]').click();
    results.uiObservations = {
      crmDraftAfterTab: await page.locator('[data-oncrm-field="preferredName"]').inputValue(),
    };
    assert.equal(results.uiObservations.crmDraftAfterTab, "Manual Alex");
    await page.setViewportSize({ width: 1440, height: 720 });
    await until(
      () =>
        page.locator(".oncrm-footer").evaluate((el) => {
          const r = el.getBoundingClientRect();
          return r.top >= 0 && r.bottom <= innerHeight;
        }),
      "CRM footer in 720px viewport"
    );
    results.uiObservations.crmFooterFits720 = true;
    await page.setViewportSize({ width: 1440, height: 1050 });
    const field = (name) => page.locator(`[data-oncrm-field="${name}"]`);
    const action = (name) => page.locator(`[data-oncrm-action="${name}"]`).first();
    await action("refresh").click();
    await until(async () => !(await action("save").isDisabled()), "CRM refresh");
    assert.equal(await field("preferredName").inputValue(), "Manual Alex");
    await page.evaluate(() => {
      window.crmRuntime.suspend();
      window.crmRuntime.resume();
    });
    await field("preferredName").waitFor();
    assert.equal(await field("preferredName").inputValue(), "Manual Alex");
    rpcBefore = (method) => {
      if (method === "dialogCrm.updateProfile") throw Error("QA_SAVE_UNAVAILABLE");
    };
    await action("save").click();
    await page.getByText("QA_SAVE_UNAVAILABLE", { exact: true }).waitFor();
    assert.equal(await field("preferredName").inputValue(), "Manual Alex");
    rpcBefore = null;
    await action("save").click();
    await until(
      async () =>
        (await dialogs.getCrmPanelSnapshot({ creatorId: c, dialogId })).profile.preferredName === "Manual Alex",
      "manual CRM save"
    );
    await until(async () => !(await action("save").isDisabled()), "CRM saved UI");
    const savedCall = calls.filter((x) => x.method === "dialogCrm.updateProfile").at(-1);
    assert.deepEqual(savedCall.input.patch, { preferredName: "Manual Alex" });
    await page.locator('[data-oncrm-tab="notes"]').click();
    await field("manualNote").fill("Keep calls disabled.");
    await page.locator('[data-oncrm-tab="profile"]').click();
    await action("save").click();
    await until(
      async () =>
        (await dialogs.getCrmPanelSnapshot({ creatorId: c, dialogId })).profile.notesManual.includes(
          "Keep calls disabled."
        ),
      "manual note save across tabs"
    );
    await until(async () => !(await action("save").isDisabled()), "manual note ACK");
    const saveEntered = deferred(),
      saveRelease = deferred();
    rpcAfter = async (method) => {
      if (method === "dialogCrm.updateProfile") {
        saveEntered.resolve();
        await saveRelease.promise;
      }
    };
    await field("preferredName").fill("Submitted Alex");
    await action("save").click();
    await saveEntered.promise;
    await field("preferredName").fill("Newer Alex");
    saveRelease.resolve();
    rpcAfter = null;
    await until(async () => !(await action("save").isDisabled()), "delayed CRM save ACK");
    await page.locator('[data-oncrm-tab="notes"]').click();
    await page.locator('[data-oncrm-tab="profile"]').click();
    assert.equal(await field("preferredName").inputValue(), "Newer Alex");
    await action("save").click();
    await until(
      async () =>
        (await dialogs.getCrmPanelSnapshot({ creatorId: c, dialogId })).profile.preferredName === "Newer Alex",
      "new edits save"
    );
    await until(async () => !(await action("save").isDisabled()), "new edits ACK");
    pass(
      "CRM edits survive tabs, refresh, suspend/resume and failed save; only changed fields commit; delayed ACK preserves new input"
    );

    const panelEntered = deferred(),
      panelRelease = deferred();
    rpcAfter = async (method, input) => {
      if (method === "dialogCrm.getPanel" && input.creatorId === c) {
        panelEntered.resolve();
        await panelRelease.promise;
      }
    };
    await action("refresh").click();
    await panelEntered.promise;
    await page.evaluate((id) => ActualDialog.switchCreator(id), creatorIds[1]);
    await until(
      async () => (await field("preferredName").count()) && (await field("preferredName").inputValue()) === "",
      "second creator CRM"
    );
    await field("preferredName").fill("Second model fan");
    panelRelease.resolve();
    rpcAfter = null;
    await action("save").click();
    await until(
      async () =>
        (await dialogs.getCrmPanelSnapshot({ creatorId: creatorIds[1], dialogId })).profile.preferredName ===
        "Second model fan",
      "second creator save"
    );
    assert.equal((await dialogs.getCrmPanelSnapshot({ creatorId: c, dialogId })).profile.preferredName, "Newer Alex");
    await page.evaluate((id) => ActualDialog.switchCreator(id), c);
    await until(
      async () =>
        (await field("preferredName").count()) && (await field("preferredName").inputValue()) === "Newer Alex",
      "return first creator"
    );
    pass("Same fan URL across two creators owns independent edits and snapshots; old creator response is discarded");

    await page.locator('[data-oncrm-tab="notes"]').click();
    await action("replies").click();
    await page.locator(".oncrm-reply").first().waitFor();
    assert.equal(await page.locator(".oncrm-reply").count(), 3);
    await action("copy-reply").click();
    assert.equal(await page.evaluate(() => window.lastCopied), "Where are you planning to go?");
    const replyEntered = deferred(),
      replyRelease = deferred();
    aiHook = async (entry) => {
      if (entry.kind === "replies") {
        replyEntered.resolve();
        await replyRelease.promise;
      }
    };
    const lateReplies = dialogs.generateCrmReplies({ creatorId: c, dialogId }).then(
      (value) => ({ value }),
      (error) => ({ error: error.message })
    );
    await replyEntered.promise;
    await dialogs.updateCrmProfile({ creatorId: c, dialogId, patch: { summary: "Manual travel summary" } });
    replyRelease.resolve();
    const staleReply = await lateReplies;
    aiHook = null;
    assert.match(staleReply.error, /CRM_REPLY_PROFILE_CHANGED/);
    assert.equal(
      (await dialogs.getCrmPanelSnapshot({ creatorId: c, dialogId })).profile.summary,
      "Manual travel summary"
    );
    pass("Actual CRM reply inference renders/copies three suggestions; a result for an outdated profile cannot commit");

    // Persist one history page, inject a retryable provider failure, reopen the
    // actual SQLite worker and allow its normal retry deadline to elapse.
    const recoveryStart = aiCalls.length;
    let historyAttempt = 0;
    aiHook = async (entry) => {
      if (entry.kind === "history" && ++historyAttempt === 2)
        return Response.json({ error: "QA_MODEL_TEMPORARILY_UNAVAILABLE" }, { status: 503 });
    };
    await dialogs.analyzeCrmProfile({ creatorId: c, dialogId });
    await until(
      async () =>
        (await dialogs.getCrmPanelSnapshot({ creatorId: c, dialogId })).profile.error.includes("OLLAMA_HTTP_503"),
      "durable AI retry checkpoint"
    );
    unbindUsage();
    await dialogs.destroy();
    openDialogs();
    aiHook = null;
    results.recovery = {
      workerReopened: true,
      firstCompletedHistoryPrompt: aiCalls.slice(recoveryStart).find((e) => e.kind === "history").prompt,
    };
    await page.screenshot({ path: path.join(output, "01-crm-panel.png") });
    await page.evaluate(() => ActualDialog.translate());
    await page.locator("#search").focus();
    results.uiObservations.translatorSelectedInput = await page.evaluate(() => ActualDialog.selectedInput());
    await page.locator(".b-chat__message__text").hover();
    await page.getByRole("button", { name: "Translate this message", exact: true }).click();
    await page.locator('.nod-tx-icon-btn[data-state="translated"]').waitFor();
    results.uiObservations.nativeLinkAfterTranslation = await page.locator(".b-chat__message__text a").count();
    assert.equal(results.uiObservations.translatorSelectedInput, "composer");
    assert.equal(results.uiObservations.nativeLinkAfterTranslation, 1);
    assert.match(await page.locator(".nod-tx-translation").innerText(), /привет из поездки/);
    const settings = translator.updateSettings({ incomingTargetLang: "uk" }).settings;
    await page.evaluate((s) => ActualDialog.applySettings(s), settings);
    results.uiObservations.translatedBubbleAfterLanguageChange = await page
      .locator(".b-chat__message__text")
      .innerText();
    assert.equal(await page.locator(".nod-tx-translation").count(), 0);
    assert.match(results.uiObservations.translatedBubbleAfterLanguageChange, /Hello travel friend/);
    await page.locator(".b-chat__message__text").hover();
    await page.getByRole("button", { name: "Translate this message", exact: true }).click();
    await page.locator('.nod-tx-icon-btn[data-state="translated"]').waitFor();
    assert.match(await page.locator(".nod-tx-translation").innerText(), /привіт із подорожі/);
    const translations = aiCalls.filter((e) => e.kind === "translation").length;
    await page.getByRole("button", { name: "Translate this message", exact: true }).click();
    await page.getByRole("button", { name: "Translate this message", exact: true }).click();
    assert.equal(aiCalls.filter((e) => e.kind === "translation").length, translations);
    pass(
      "Translator targets native composer, preserves native links/line breaks, refreshes target language and reuses only current translation"
    );
    await page.screenshot({ path: path.join(output, "02-translator.png") });

    const delayedTranslation = deferred(),
      releaseTranslation = deferred();
    aiHook = async (entry) => {
      if (entry.kind === "translation") {
        delayedTranslation.resolve();
        await releaseTranslation.promise;
      }
    };
    await page.evaluate(() => {
      const b = document.querySelector(".b-chat__message__text");
      b.firstChild.textContent = "A new message ";
      ActualDialog.changed();
    });
    await page.locator(".b-chat__message__text").hover();
    await page.getByRole("button", { name: "Translate this message", exact: true }).click();
    await delayedTranslation.promise;
    await page.evaluate(() => {
      const b = document.querySelector(".b-chat__message__text");
      b.firstChild.textContent = "Recycled message ";
      b.closest("[data-message-id]").dataset.messageId = "800001";
      ActualDialog.changed();
    });
    releaseTranslation.resolve();
    aiHook = null;
    await until(() => aiActive === 0, "old translation settled");
    assert.equal(await page.locator(".nod-tx-translation").count(), 0);
    assert.match(await page.locator(".b-chat__message__text").innerText(), /Recycled message/);
    assert.equal(await page.locator(".b-chat__message__text a").count(), 1);
    const inputEntered = deferred(),
      inputRelease = deferred();
    aiHook = async (entry) => {
      if (entry.kind === "translation") {
        inputEntered.resolve();
        await inputRelease.promise;
      }
    };
    await page.locator("#composer").fill("новый текст поездки");
    await page.evaluate(() => {
      window.inputTranslation = window.NodOfTranslate.translateInputField();
    });
    await inputEntered.promise;
    await page.locator("#composer").fill("уже другой текст");
    inputRelease.resolve();
    aiHook = null;
    assert.equal(await page.evaluate(() => window.inputTranslation), false);
    assert.equal(await page.locator("#composer").inputValue(), "уже другой текст");
    await page.locator("#search").focus();
    assert.equal(await page.evaluate(() => window.NodOfTranslate.translateInputField()), true);
    assert.equal(await page.locator("#composer").inputValue(), "hello from the trip");
    assert.equal(await page.locator("#search").inputValue(), "search text");
    pass(
      "Recycled message ignores old model result; input typed during translation survives; search field is never translated"
    );

    await until(
      async () => (await dialogs.getCrmPanelSnapshot({ creatorId: c, dialogId })).profile.analysisStatus === "done",
      "resumed durable CRM analysis",
      45000
    );
    const resumed = await dialogs.getCrmPanelSnapshot({ creatorId: c, dialogId });
    assert.equal(resumed.profile.preferredName, "Newer Alex");
    assert.equal(resumed.profile.summary, "Manual travel summary");
    assert.ok(resumed.profile.notesManual.includes("Keep calls disabled."));
    results.recovery.firstCompletedPageExecutions = aiCalls
      .slice(recoveryStart)
      .filter((e) => e.kind === "history" && e.prompt === results.recovery.firstCompletedHistoryPrompt).length;
    assert.equal(results.recovery.firstCompletedPageExecutions, 1);
    delete results.recovery.firstCompletedHistoryPrompt;
    results.recovery.analysisCompleted = true;
    pass(
      "Transient Ollama failure resumes persisted analysis after SQLite worker reopen without repeating completed page or erasing manual fields"
    );

    await page.evaluate((i) => ActualDialog.brain(i), mount);
    const brainName = page.getByLabel(/^\*?\s*Name$/i);
    await until(async () => (await brainName.count()) && !(await brainName.isDisabled()), "brain card load");
    await brainName.fill("Creator One");
    await page.getByRole("button", { name: "Save profile", exact: true }).click();
    await page.getByText("Saved", { exact: true }).waitFor();
    const firstBrain = brain.get({ creatorId: c }).profile;
    brain.save({
      profile: {
        ...firstBrain,
        creatorId: creatorIds[1],
        personal: { ...firstBrain.personal, name: "Creator Two Stored" },
      },
    });
    rpcBefore = (method, input) => {
      if (method === "creatorAiProfile.get" && input.creatorId === creatorIds[1])
        throw Error("QA_BRAIN_LOAD_UNAVAILABLE");
    };
    await page.locator(".hq-ai-creator-picker select").selectOption(creatorIds[1]);
    await page.getByRole("button", { name: "Retry loading" }).waitFor();
    assert.equal(await brainName.isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Save profile", exact: true }).isDisabled(), true);
    assert.equal(brain.get({ creatorId: creatorIds[1] }).profile.personal.name, "Creator Two Stored");
    rpcBefore = null;
    await page.getByRole("button", { name: "Retry loading" }).click();
    await until(async () => !(await brainName.isDisabled()), "brain retry");
    assert.equal(await brainName.inputValue(), "Creator Two Stored");
    await brainName.fill("Creator Two");
    const brainEntered = deferred(),
      brainRelease = deferred();
    rpcAfter = async (method) => {
      if (method === "creatorAiProfile.save") {
        brainEntered.resolve();
        await brainRelease.promise;
      }
    };
    await page.getByRole("button", { name: "Save profile", exact: true }).click();
    await brainEntered.promise;
    await brainName.fill("Creator Two Newer");
    brainRelease.resolve();
    rpcAfter = null;
    await page.getByText("Saved. New edits are not saved yet.", { exact: true }).waitFor();
    assert.equal(await brainName.inputValue(), "Creator Two Newer");
    await page.getByRole("button", { name: "Save profile", exact: true }).click();
    await page.getByText("Saved", { exact: true }).waitFor();
    await page.locator(".hq-ai-creator-picker select").selectOption(c);
    await until(async () => (await brainName.inputValue()) === "Creator One", "brain creator isolation");
    const reopenedBrain = new m.CreatorAiProfileService(log, authority);
    assert.equal(reopenedBrain.get({ creatorId: c }).profile.personal.name, "Creator One");
    assert.equal(reopenedBrain.get({ creatorId: creatorIds[1] }).profile.personal.name, "Creator Two Newer");
    await page.screenshot({ path: path.join(output, "03-creator-brain-card.png") });
    pass(
      "Creator brain card: failed load cannot overwrite stored profile; retry, two creators, pending save edits and actual AtomicJsonStore reopen"
    );

    await f.stop("SIGKILL");
    await f.boot();
    results.recovery.backendSIGKILL = true;
    unbindUsage();
    await dialogs.destroy();
    openDialogs();
    const restored = await dialogs.getCrmPanelSnapshot({ creatorId: c, dialogId });
    assert.equal(restored.stats.messagesCount, 65);
    assert.equal(restored.profile.preferredName, "Newer Alex");
    const usage = await Array.fromAsync(dialogs.iterateMediaLibraryUsageSources(c));
    assert.equal(usage[0].items[0].revenueCents, 1250);
    const sqlUsage = await f.withDatabase(async (db) =>
      db.creatorMediaUsageContribution.findMany({ where: { creatorId: c, mediaId: "99001" } })
    );
    assert.equal(sqlUsage.length, 1);
    assert.equal(sqlUsage[0].revenueCents, 1250);
    assert.equal(sqlUsage[0].soldCount, 1);
    results.rawUsage = {
      messages: 65,
      pages: providerCalls.filter((e) => e.creatorId === c).length,
      localRevenueCents: 1250,
      sqlContributionCount: sqlUsage.length,
      sqlRevenueCents: sqlUsage[0].revenueCents,
      catalogActive: false,
    };
    assert.equal(errors.length, 0, JSON.stringify(errors));
    assert.equal(aiMaxActive, 1);
    pass(
      "Backend SIGKILL and second SQLite reopen preserve CRM/raw history and one media revenue contribution; AI dispatcher serializes all three paths"
    );
    results.ai = { calls: aiCalls, maxActive: aiMaxActive };
  } finally {
    for (const release of pendingReleases) release();
    if (page)
      try {
        results.lastCrmState = await page.evaluate(() => ({
          state: window.crmRuntime?.state,
          scope: window.crmRuntime?.route,
          editing: document.activeElement?.outerHTML,
          save: document.querySelector('[data-oncrm-action="save"]')?.outerHTML,
        }));
      } catch {}
    if (page) {
      try {
        await page.screenshot({ path: path.join(output, "last-screen.png") });
      } catch {}
      try {
        await page.evaluate(() => ActualDialog.unmount());
      } catch {}
    }
    clearInterval(renewal);
    await context?.close();
    await browser?.close();
    if (server) await new Promise((r) => server.close(r));
    translator.destroy();
    unbindUsage?.();
    await dialogs?.destroy();
    await mediaLibrary.destroy();
    await coordinator.destroy();
    await computeWorker.close();
    ai.close();
    authority.destroy();
    globalThis.fetch = originalFetch;
    results.renderer = { errors, calls, requests };
    results.provider = { calls: providerCalls, externalWrites: 0 };
    results.ai = { calls: aiCalls, maxActive: aiMaxActive };
    fs.writeFileSync(path.join(output, "desktop-log.json"), JSON.stringify(logs, null, 2));
  }
};

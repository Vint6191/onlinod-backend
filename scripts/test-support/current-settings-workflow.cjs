"use strict";
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http"),
  crypto = require("node:crypto");
const { EventEmitter } = require("node:events"),
  { createRequire } = require("node:module");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

exports.runSettings = async function (f) {
  const { modules: m, desktop, scratch, output, agencyId, deviceId, creatorId: c, creatorIds, must, pass, results } = f;
  const load = createRequire(path.join(desktop, "package.json")),
    runtime = createRequire(
      path.join(process.env.ONLINOD_BROWSER_RUNTIME || process.env.ONLINOD_SQL_PROOF_RUNTIME, "package.json")
    );
  const calls = [],
    errors = [],
    requests = [],
    logs = [],
    findings = [];
  let failRead = null,
    failuresLeft = 1,
    loseAction = null,
    held = null;
  const baseline = process.env.ONLINOD_SETTINGS_BASELINE === "1";
  const check = (ok, name) => {
    if (!ok) findings.push(name);
    if (!baseline) assert.ok(ok, name);
  };
  const log = Object.fromEntries(
    ["debug", "info", "warn", "error"].map((k) => [
      k,
      (...args) => logs.push({ level: k, args: args.map((x) => (x instanceof Error ? x.message : x)) }),
    ])
  );
  let session = { ...f.auth.readSession(), deviceId };
  const authStore = {
    readSession: () => session,
    saveSession: (s) => {
      session = s;
    },
    clearSession: () => {
      session = null;
    },
    getDeviceId: () => deviceId,
    getAuthorizationScopeIncarnation: () => session?.authorizationSessionId || "signed-out",
    getAuthorizationScopeHash: () => agencyId + ":" + deviceId,
    onSessionChanged: () => () => {},
  };
  const authService = { ensureSession: async () => ({ authenticated: !!session, session }) };
  const state = await must("GET", "/api/team/state"),
    permissions = state.roles.find((r) => r.key === "owner").permissions;
  const catalog = await f.withDatabase((db, backendLoad) =>
    backendLoad("./src/services/creator-human-management-authority-service").currentCreatorCatalogGeneration({
      db,
      agencyId,
    })
  );
  const accessRuntime = {
    currentAuthorityProof: () => ({ accessEpoch: 1, creatorCatalogGeneration: catalog }),
    allowedCreatorIdsSnapshot: () => creatorIds,
    capturePermit: (creatorId) => authority.capturePermit("SECRET_READ", { creatorId }),
    assertPermitCurrent: (p) => authority.assertPermitCurrent(p),
    withAuthorizedCommit: async (p, work) => {
      authority.assertPermitCurrent(p);
      return work(() => authority.assertPermitCurrent(p));
    },
    withCreatorRevocationBarrier: async (_id, work) => work(),
  };
  const authority = new m.DesktopCurrentAuthorizationAuthorityService({ log, authStore, accessRuntime });
  const publish = () =>
    authority.publish({
      accessEpoch: 1,
      creatorCatalogGeneration: catalog,
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
    }, "billing authority refresh", { renewUnchanged: true });
  publish();
  let renewal = setInterval(publish, 30000);
  const api = {
    ...f.api,
    deviceId,
    request: async (url, options) => {
      const response = await f.api.request(url, options);
      requests.push({ url, action: options?.body?.action });
      if (loseAction && options?.body?.action === loseAction) {
        loseAction = null;
        throw Object.assign(Error("Controlled reply lost after commit"), { code: "NETWORK_ERROR" });
      }
      return response;
    },
  };
  fs.mkdirSync(path.join(scratch, "desktop-cache"), { recursive: true });
  fs.writeFileSync(
    path.join(scratch, "desktop-cache/client-e2e-device-key.v1.json"),
    JSON.stringify({
      version: 1,
      deviceId,
      publicKey: f.keys.publicKey,
      fingerprint: f.keys.fingerprint,
      privateKey: {
        format: "safeStorage-v1",
        value: m.safeStorage.encryptString(f.keys.privateKey).toString("base64"),
      },
      createdAt: new Date().toISOString(),
    })
  );
  let management, account, telegram, billing, settings, pageSettings, keyring, network;
  const nativeHelpers = [];
  const spawnHelper = (helperId) => {
    const child = new EventEmitter();
    Object.assign(child, { connected: true, killed: false, exitCode: null, helperId });
    nativeHelpers.push(child);
    child.kill = () => {
      if (child.exitCode === null) {
        child.killed = true;
        child.exitCode = 0;
        child.emit("exit", 0);
      }
    };
    child.stage = (stage) =>
      child.emit("message", {
        type: "telegram-mtproto-helper-stage",
        helperId,
        stage,
        qrCodeDataUrl: "data:image/png;base64,iVBORw0KGgo=",
        qrExpiresAt: new Date(Date.now() + 60000).toISOString(),
        passwordHint: "Acceptance password",
      });
    child.send = (message) => {
      if (message.type === "auth-start-qr") setImmediate(() => child.stage("QR"));
      if (message.type === "cancel") child.kill();
      if (message.type === "auth-password")
        setImmediate(() => {
          child.emit("message", {
            type: "telegram-mtproto-helper-session",
            helperId,
            session: "controlled-mtproto-session",
          });
        });
      if (message.type === "auth-session-staged") setImmediate(() => child.kill());
    };
    setImmediate(() => child.emit("message", { type: "telegram-mtproto-helper-ready", helperId }));
    return child;
  };
  const reopen = () => {
    settings?.destroy();
    management = new m.ManagementCommandTransport(
      api,
      authStore,
      path.join(scratch, "settings-management.json"),
      authority,
      () => {}
    );
    account = new m.AccountSecurityCommandTransport(
      api,
      authStore,
      path.join(scratch, "settings-account.json"),
      authority
    );
    telegram = new m.TelegramControlCommandTransport(
      api,
      authStore,
      path.join(scratch, "settings-telegram.json"),
      authority
    );
    billing = new m.DurableCommandTransport(api, authStore, path.join(scratch, "settings-billing.json"), null, null, {
      actions: ["wallet.topup"],
      endpoint: "/api/billing/wallet/top-up/v2",
      domain: "Billing",
      maxPayloadBytes: 1024,
      allowCancel: false,
      canAcknowledgeResult: (r) => r.recoveryPending === false,
      label: (_a, p) => `Top up $${(p.amountCents / 100).toFixed(2)}`,
      slot: () => "wallet.topup",
    });
    keyring = new m.ClientE2eKeyringService(api, authStore, accessRuntime);
    pageSettings = new m.PageRuntimeSettingsStore(log);
    network = new m.CreatorNetworkProfileService(log, api, keyring, null, authority, management);
    settings = new m.SettingsService(
      authStore,
      authService,
      pageSettings,
      network,
      keyring,
      authority,
      billing,
      management,
      account,
      telegram
    );
    // Replace only the process-launch port. The actual MTProto coordinator owns
    // challenges, cancellation, session staging, helper exit and durable handoff.
    settings.telegramLocal = new m.TelegramLocalMtprotoService(() => Date.now(), spawnHelper);
  };
  reopen();
  const handlers = () => ({
    ...m.createSettingsHandlers(settings),
    "managementCommands.listPending": () => management.listPending(),
    "managementCommands.acknowledge": (i) => management.acknowledge(i.commandId),
    "managementCommands.retry": (i) => management.retry(i.commandId),
    "managementCommands.cancel": (i) => management.cancel(i.commandId),
    "campaigns.getRetirementState": (i) =>
      api.request("/api/programmatic-of-writes/mass-queue/retirement-state", {
        method: "POST",
        body: { deviceId, cursor: i?.cursor || null },
      }),
  });
  const until = async (fn, message, timeout = 30000) => {
    const end = Date.now() + timeout;
    for (;;) {
      try {
        if (await fn()) return;
      } catch (e) {
        if (!/DESKTOP_AUTHORIZATION_PERMIT_STALE/.test(e.code || e.message)) throw e;
      }
      if (Date.now() > end) throw Error(message);
      await wait(250);
    }
  };
  const hold = (method) => {
    let enter, release;
    const entered = new Promise((r) => (enter = r)),
      promise = new Promise((r) => (release = r));
    held = { method, enter, promise };
    return { entered, release };
  };
  let server, browser, page;
  // Headless Chromium can stall its image compositor after fonts are ready.
  // Capture is diagnostic evidence; functional assertions below remain required.
  results.visualCaptures = [];
  const capture = async (name) => {
    try {
      await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true, animations: "disabled", timeout: 10000 });
      results.visualCaptures.push({ name, ok: true });
    } catch (error) {
      results.visualCaptures.push({ name, ok: false, error: error.message });
      const text = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "DOM text unavailable");
      fs.writeFileSync(path.join(output, `${name}.txt`), text);
      const limitation = "Some diagnostic screenshots could not be captured by headless Chromium; DOM text is retained and visual verification is incomplete";
      if (!results.limitations.includes(limitation)) results.limitations.push(limitation);
    }
  };
  try {
    const renderer = path.join(desktop, "apps/desktop/renderer/src"),
      entry = path.join(scratch, "settings-renderer.tsx"),
      script = path.join(scratch, "settings-renderer.js");
    fs.writeFileSync(
      entry,
      `import React from 'react';import{createRoot}from'react-dom/client';import{SettingsWorkspace}from ${JSON.stringify(path.join(renderer, "features/settings/SettingsWorkspace.tsx"))};import{acceptRendererAuthorizationProjection}from ${JSON.stringify(path.join(renderer, "shared/rpc/authorization-scope.ts"))};import ${JSON.stringify(path.join(renderer, "styles.css"))};
export function mount(projection){window.nod={events:{onDesktopAuthorizationEvent:()=>()=>{},onCreatorRuntimeEvent:()=>()=>{}},rpc:{call:async(method,input)=>{const r=await window.actualRpc(method,input);if(r.error)throw Object.assign(Error(r.error.message),{code:r.error.code});return r.result;}}};acceptRendererAuthorizationProjection(projection);createRoot(document.getElementById('root')).render(<React.StrictMode><SettingsWorkspace/></React.StrictMode>);}
export function context(projection){acceptRendererAuthorizationProjection(projection);}`
    );
    await load("esbuild").build({
      entryPoints: [entry],
      outfile: script,
      bundle: true,
      platform: "browser",
      format: "iife",
      globalName: "ActualSettings",
      jsx: "automatic",
      nodePaths: [path.join(desktop, "node_modules")],
      alias: { "@nod/shared": path.join(desktop, "packages/shared/src/index.ts") },
      loader: { ".css": "css", ".png": "dataurl", ".svg": "dataurl" },
      define: { "process.env.NODE_ENV": '"development"' },
    });
    server = http.createServer((req, res) => {
      const file = req.url === "/app.js" ? script : req.url === "/app.css" ? script.replace(/js$/, "css") : null;
      res.setHeader(
        "Content-Type",
        file ? (file.endsWith(".js") ? "application/javascript" : "text/css") : "text/html"
      );
      res.end(
        file
          ? fs.readFileSync(file)
          : '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>'
      );
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const chromiumModule = runtime("@sparticuz/chromium");
    const chromium = chromiumModule.default || chromiumModule;
    browser = await runtime("playwright").chromium.launch({
      executablePath: process.env.ONLINOD_CHROMIUM_PATH || (await chromium.executablePath()),
      args: chromium.args,
      headless: true,
    });
    page = await browser.newPage({ viewport: { width: 1536, height: 1100 } });
    page.setDefaultTimeout(15000);
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => d.accept());
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.route("**/*", (route) =>
      route.request().url().startsWith(origin) || route.request().url().startsWith("data:")
        ? route.continue()
        : route.abort()
    );
    await page.exposeFunction("actualRpc", async (method, input) => {
      calls.push({
        method,
        input: JSON.parse(
          JSON.stringify(input || {}, (k, v) => (/password|base64|recoveryCode/i.test(k) ? "[redacted]" : v))
        ),
      });
      try {
        if (failRead === method) {
          if (--failuresLeft <= 0) {
            failRead = null;
            failuresLeft = 1;
          }
          throw Error("Controlled read unavailable");
        }
        const fn = handlers()[method];
        if (!fn) {
          errors.push("Unexpected RPC " + method);
          throw Error("Unexpected RPC " + method);
        }
        const result = await fn(input);
        if (held?.method === method) {
          const g = held;
          held = null;
          g.enter();
          await g.promise;
        }
        return { result };
      } catch (e) {
        return { error: { message: e.message, code: e.code } };
      }
    });
    const projection = {
      ok: true,
      authenticated: true,
      current: true,
      quarantineState: "CURRENT",
      localAuthorizationRevision: 1,
      session: { ...session, accessToken: undefined, refreshToken: undefined },
      creators: state.creators,
      activeCreatorId: c,
    };
    await page.goto(origin);
    await page.evaluate((p) => window.ActualSettings.mount(p), projection);
    const tab = (name) => page.locator(".sv-tabs").getByRole("button", { name, exact: true }).click();
    const visible = () => page.locator(".sv-body > .sv-tab-panel:not([hidden])");
    const refresh = () => page.locator(".sv-header").getByRole("button", { name: "Refresh", exact: true }).click();
    const recover = async (region, journal) => {
      await page
        .getByRole("region", { name: region, exact: true })
        .getByRole("button", { name: "Recover", exact: true })
        .click();
      await until(() => journal().listPending().length === 0, "Pending action did not recover");
    };
    await page.getByLabel("Display name", { exact: true }).waitFor();
    pass("Current Settings React mounts against actual handlers, authorization, services and Backend");
    await page.getByLabel("Display name", { exact: true }).fill("Edited owner");
    await tab("Workspace");
    await page.getByLabel("Workspace name", { exact: true }).waitFor();
    await tab("My Account");
    check(
      (await page.getByLabel("Display name", { exact: true }).inputValue()) === "Edited owner",
      "ACCOUNT_EDIT_LOST_ON_TAB_CHANGE"
    );
    await tab("Workspace");
    await page.getByLabel("Workspace name", { exact: true }).fill("Renamed workspace");
    const save = hold("settings.updateWorkspace");
    await page.getByRole("button", { name: "Save workspace", exact: true }).click();
    await save.entered;
    check(
      await page.getByLabel("Workspace name", { exact: true }).isDisabled(),
      "WORKSPACE_FIELDS_EDITABLE_DURING_COMMIT"
    );
    save.release();
    await until(
      async () => !(await page.getByRole("button", { name: "Save workspace", exact: true }).isDisabled()),
      "Workspace save did not finish"
    );
    if (baseline) {
      results.baselineFindings = findings;
      return;
    }
    await page.getByLabel("Workspace name", { exact: true }).fill("Unsaved workspace");
    await refresh();
    await until(async () => await page.locator(".sv-header button").isEnabled(), "Refresh stuck");
    assert.equal(await page.getByLabel("Workspace name", { exact: true }).inputValue(), "Unsaved workspace");
    await tab("My Account");
    assert.equal(await page.getByLabel("Display name", { exact: true }).inputValue(), "Edited owner");
    const staleRead = hold("settings.getState");
    await refresh();
    await staleRead.entered;
    await page.getByRole("button", { name: "Save profile", exact: true }).click();
    await page.getByText("Profile updated", { exact: true }).waitFor();
    staleRead.release();
    await wait(100);
    assert.equal(await page.getByLabel("Display name", { exact: true }).inputValue(), "Edited owner");
    pass(
      "Account/workspace edits survive tab changes and refresh; submitted fields lock; old whole-state reply cannot overwrite profile commit"
    );

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhC8AAAAASUVORK5CYII=",
      "base64"
    );
    loseAction = "account.avatar";
    await page.locator("input[type=file]").setInputFiles({ name: "avatar.png", mimeType: "image/png", buffer: png });
    await page.getByText("Controlled reply lost after commit", { exact: true }).waitFor();
    assert.equal(management.listPending().length, 1);
    reopen();
    await recover("Pending management actions", () => management);
    await page.locator(".sv-avatar img").waitFor();
    failRead = "managementCommands.acknowledge";
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await page.getByText("Profile photo removed", { exact: true }).waitFor();
    assert.equal(management.listPending().length, 1);
    await recover("Pending management actions", () => management);
    assert.equal((await settings.getState()).account.user.avatarUrl, null);
    pass(
      "Avatar upload lost after commit and removal with failed local ACK both recover through durable journal and normal Settings UI"
    );

    await tab("Notifications");
    const quiet = page.getByRole("button", { name: "Quiet hours", exact: true });
    await quiet.click();
    await visible().locator("input[type=time]").nth(0).fill("22:15");
    await visible().locator("input[type=time]").nth(1).fill("07:30");
    await page.getByRole("button", { name: "Play sound", exact: true }).click();
    const nsave = hold("settings.updateNotifications");
    await page.getByRole("button", { name: "Save notifications", exact: true }).click();
    await nsave.entered;
    assert.ok(await quiet.isDisabled());
    nsave.release();
    await page.getByText("Notification settings saved on this device", { exact: true }).waitFor();
    reopen();
    const notifications = pageSettings.getSettings().notifications;
    assert.equal(notifications.sound, true);
    assert.deepEqual(notifications.quietHours, { enabled: true, start: "22:15", end: "07:30" });
    results.notifications = notifications;
    pass(
      "Device notification settings, quiet hours across midnight and operational toggles persist through real AtomicJsonStore reopen"
    );

    failRead = "settings.listNetworkProfiles";
    failuresLeft = 2;
    await tab("Network & Proxy");
    await page.getByRole("button", { name: "Retry network profiles", exact: true }).click();
    await page.getByRole("button", { name: "Add proxy", exact: true }).click();
    await page.getByLabel("Model", { exact: false }).selectOption(c);
    await page.getByLabel("Label", { exact: true }).fill("Dedicated test proxy");
    await page.getByLabel("Host", { exact: true }).fill("proxy.example.test");
    await page.getByLabel("Port", { exact: true }).fill("1080");
    await page.getByLabel("Username (optional)", { exact: true }).fill("acceptance-user");
    await page.getByLabel("Password", { exact: true }).fill("controlled-proxy-secret");
    const psave = hold("settings.createProxyEndpoint");
    await page.getByRole("button", { name: "Save proxy", exact: true }).click();
    await psave.entered;
    assert.ok(await page.getByLabel("Host", { exact: true }).isDisabled());
    psave.release();
    await page.locator(".sv-proxy-row").waitFor();
    let net = await settings.listNetworkProfiles();
    assert.equal(net.proxies.length, 1);
    assert.equal(net.proxies[0].hasCredentials, true);
    assert.equal(net.creators.find((r) => r.creatorId === c).mode, "PROXY");
    assert.ok(!JSON.stringify(net).includes("controlled-proxy-secret"));
    await page
      .locator(".sv-creator-network-row")
      .filter({ hasText: "model_one" })
      .locator("select")
      .selectOption("DIRECT");
    await until(
      async () => (await settings.listNetworkProfiles()).creators.find((r) => r.creatorId === c).mode === "DIRECT",
      "Direct policy not saved"
    );
    await page.locator(".sv-proxy-row").getByRole("button", { name: "Delete", exact: true }).click();
    await until(async () => (await settings.listNetworkProfiles()).proxies.length === 0, "Proxy not removed");
    pass(
      "Network initial-read failure retries; UI creates encrypted dedicated proxy, assigns one creator, returns to Direct and deletes it"
    );

    await tab("Telegram");
    await page.getByRole("button", { name: "Open Telegram setup", exact: true }).click();
    await page.locator(".sv-telegram-account-block").waitFor();
    const offsets = page.getByLabel("За сколько минут до звонка", { exact: false });
    await offsets.fill("");
    await offsets.pressSequentially("120, 47, 5");
    assert.equal(await offsets.inputValue(), "120, 47, 5");
    loseAction = "telegram.reminders";
    await page.getByRole("button", { name: "Save reminder settings", exact: true }).click();
    await page.getByText("Controlled reply lost after commit", { exact: true }).waitFor();
    reopen();
    await recover("Pending Telegram actions", () => telegram);
    assert.deepEqual((await settings.getState()).telegram.reminders.call.offsetsMinutes, [120, 47, 5]);
    await page.getByRole("button", { name: "Authorize account", exact: true }).click();
    await page.getByRole("button", { name: "Generate QR code", exact: true }).click();
    await page.getByAltText("Telegram authorization QR code").waitFor();
    const cancelledHelper = nativeHelpers.at(-1);
    await tab("My Account");
    await until(() => cancelledHelper.killed, "Leaving Telegram did not close helper");
    await tab("Telegram");
    await page.getByRole("button", { name: "Authorize account", exact: true }).click();
    await page.getByRole("button", { name: "Generate QR code", exact: true }).click();
    await page.getByAltText("Telegram authorization QR code").waitFor();
    nativeHelpers.at(-1).stage("PASSWORD");
    await page.getByLabel("Telegram 2FA password", { exact: false }).fill("controlled-2fa");
    loseAction = "telegram.session";
    await page.getByRole("button", { name: "Authorize", exact: true }).click();
    await page.getByRole("button", { name: "Retry session save", exact: true }).waitFor();
    assert.ok(nativeHelpers.at(-1).killed);
    assert.equal(telegram.listPending().length, 1);
    await page.getByRole("button", { name: "Retry session save", exact: true }).click();
    await page.getByText("AUTHORIZED", { exact: true }).waitFor();
    await until(() => telegram.listPending().length === 0, "Telegram ACK remained pending");
    results.telegram = {
      helperCancelledOnTab: true,
      helperExitedBeforeHandoff: true,
      sessionReady: (await settings.getState()).telegram.accounts[0].sessionReady,
      offsets: [120, 47, 5],
    };
    assert.equal(results.telegram.sessionReady, true);
    await page.locator(".sv-telegram-row").getByRole("button", { name: "Remove", exact: true }).click();
    await page.getByRole("button", { name: "Finish removal", exact: true }).click();
    // Retirement is a durable background fanout. Allow the normal maintenance
    // admission cadence to finish; do not bypass it or alter production timers.
    try {
      await until(
        async () => (await settings.getState()).telegram.accounts.length === 0,
        "Telegram connection not retired",
        120000
      );
    } catch (error) {
      results.retirementDiagnostics = await f.withDatabase((db) =>
        db.domainWorkItem.findMany({ where: { agencyId, workClass: "DEPENDENCY_FANOUT" } })
      );
      throw error;
    }
    pass(
      "Telegram setup/reminders/QR/2FA use actual control transport and MTProto coordinator; tab exit cancels helper, lost session handoff recovers after helper exit, connection retires"
    );

    await tab("Plan & Billing");
    const creatorCard = () => page.locator(".sv-auto-creator").filter({ hasText: "model_one" });
    await creatorCard().waitFor();
    assert.ok(
      await creatorCard()
        .getByRole("button", { name: /Start 1 month/ })
        .isDisabled()
    );
    await creatorCard().getByRole("button", { name: "Refresh earnings", exact: true }).click();
    await page.getByText(/Earnings refresh queued/).waitFor();
    loseAction = "billing.preferences";
    await creatorCard().locator(".sv-addon").nth(1).click();
    await page.getByText("Controlled reply lost after commit", { exact: true }).waitFor();
    reopen();
    await recover("Pending management actions", () => management);
    await until(
      async () => (await creatorCard().locator(".sv-addon").nth(1).getAttribute("class")).includes(" on"),
      "Recovered add-on not reflected"
    );
    let current = await settings.getState();
    let row = current.billing.creators.find((x) => x.creatorId === c);
    await f.manage("billing.preferences", c, {
      expectedRevision: row.controlRevision,
      aiChatterEnabled: false,
      outreachEnabled: false,
    });
    await refresh();
    await until(
      async () => !(await creatorCard().locator(".sv-addon").nth(1).getAttribute("class")).includes(" on"),
      "External add-on update not reflected after refresh"
    );
    pass(
      "Billing blocks unpriced subscriptions, queues earnings recovery, and renders authoritative add-ons after lost response/recovery and external update"
    );
    await page.getByLabel("Balance top-up amount", { exact: true }).fill("100");
    loseAction = "wallet.topup";
    await page.getByRole("button", { name: "Top up $100.00", exact: true }).click();
    await page.getByText("Controlled reply lost after commit", { exact: true }).waitFor();
    reopen();
    await recover("Pending actions", () => billing);
    const invoices = fs.readFileSync(f.providerLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.equal(invoices.length, 1);
    const order = (await settings.getState()).billing.recentOrders[0];
    assert.equal(Number((await settings.getState()).billing.wallet.balanceCents), 0);
    await refresh();
    await page.getByRole("button", { name: "Resume checkout", exact: true }).click();
    await until(() => m.ports.checkoutCalls.length === 2, "Saved checkout did not reopen");
    assert.equal(Number((await settings.getState()).billing.wallet.balanceCents), 0);
    const ipn = {
      payment_id: "payment-acceptance",
      invoice_id: order.providerInvoiceId,
      order_id: order.id,
      payment_status: "finished",
      price_amount: 100,
      price_currency: "usd",
      pay_amount: 100,
      actually_paid: 100,
      pay_currency: "usdttrc20",
      outcome_amount: 100,
      outcome_currency: "usd",
    };
    const signature = (payload) =>
      crypto
        .createHmac("sha512", f.ipnSecret)
        .update(
          JSON.stringify(
            Object.fromEntries(
              Object.keys(payload)
                .sort()
                .map((k) => [k, payload[k]])
            )
          )
        )
        .digest("hex");
    await must("POST", "/api/billing/nowpayments/ipn", ipn, 401, { "x-nowpayments-sig": "invalid" });
    await must("POST", "/api/billing/nowpayments/ipn", ipn, 200, { "x-nowpayments-sig": signature(ipn) });
    // Exact duplicates now use an atomic inbox INSERT ... ON CONFLICT. They
    // reuse the completed receipt without a second credit or unique violation.
    const exactDuplicate = await must("POST", "/api/billing/nowpayments/ipn", ipn, 200, { "x-nowpayments-sig": signature(ipn) });
    assert.equal(exactDuplicate.duplicate, true);
    const repeated = { ...ipn, updated_at: new Date().toISOString() };
    await must("POST", "/api/billing/nowpayments/ipn", repeated, 200, { "x-nowpayments-sig": signature(repeated) });
    await refresh();
    await until(
      async () => Number((await settings.getState()).billing.wallet.balanceCents) === 10000,
      "Verified balance not credited"
    );
    results.payment = {
      invoiceCount: invoices.length,
      checkoutWindows: m.ports.checkoutCalls.length,
      verifiedCreditCents: 10000,
      repeatedPaymentEvents: true,
      exactDuplicateCallback: true,
      realProvider: false,
    };
    pass(
      "Lost top-up response recovers one saved invoice; checkout/resume do not credit funds; actual HMAC rejects forged callback and exact duplicate plus a second verified event credit the same payment once"
    );

    // Even an explicit Admin price requires the normal 30-day earnings proof.
    // Fulfil the job queued by the UI through the actual collector and HTTP
    // lease/progress/complete path. Only the remote chart response is controlled.
    await must("POST", "/api/devices/heartbeat", {
      deviceId,
      accounts: [
        {
          creatorId: c,
          remoteId: "100001",
          status: "READY",
          accessEpoch: 1,
          sessionReadReady: true,
          sessionWriteReady: true,
          sessionProofEpoch: 1,
          canonicalRevision: 1,
          networkRevision: 0,
          runtimeReady: true,
        },
      ],
    });
    const earningsClaim = await must("POST", "/api/jobs/claim", {
      deviceId,
      leaseMs: 180000,
      jobKeys: ["fetch_earnings"],
      excludedCreatorIds: creatorIds.filter((id) => id !== c),
      capabilities: { legacyStorageRetirementV1: true, billingRecoveryLeaseV1: true },
    });
    const earningsJob = earningsClaim.job;
    assert.ok(earningsJob, JSON.stringify(earningsClaim));
    assert.equal(earningsJob.creatorId, c);
    let reportTail = Promise.resolve();
    const earnings = await m.earningsHandler.runChunk({
      job: earningsJob,
      creatorId: c,
      signal: new AbortController().signal,
      ofApi: {
        request: async (input) => {
          assert.equal(input.endpoint.method, "GET");
          assert.equal(input.source, "backend.readonly.fetch_earnings.chart");
          return {
            ok: true,
            status: 200,
            data: { total: { total_amount: 0, gross_amount: 0, total_count: 0 }, chart: [] },
          };
        },
      },
      reportAsync: (report) => {
        reportTail = reportTail.then(() =>
          must("POST", `/api/jobs/${earningsJob.id}/progress`, {
            deviceId,
            leaseToken: earningsJob.leaseToken,
            leaseRevision: earningsJob.leaseRevision,
            ...report,
          })
        );
      },
      flushAsyncReports: () => reportTail,
    });
    assert.equal(earnings.outcome, "done");
    assert.equal(earnings.result.dailyCount, 30);
    assert.equal(earnings.result.dailyComplete, true);
    await must("POST", `/api/jobs/${earningsJob.id}/complete`, {
      deviceId,
      leaseToken: earningsJob.leaseToken,
      leaseRevision: earningsJob.leaseRevision,
      result: earnings.result,
      progress: earnings.progress,
    });
    await until(
      async () => (await settings.getState()).billing.creators.find((x) => x.creatorId === c).pricingAvailable,
      "Billing earnings proof did not publish",
      120000
    );
    results.billingEarnings = {
      days: earnings.result.dailyCount,
      totalCents: 0,
      actualCollector: true,
      actualHttpLeaseAndPublication: true,
      physicalProvider: false,
    };

    const adminLogin = await must("POST", "/api/admin-auth/login", {
      email: "admin@example.test",
      password: "isolated-admin-password",
    });
    const ah = { Authorization: `Bearer ${adminLogin.token}`, "Idempotency-Key": crypto.randomUUID() };
    const agency = await must("GET", `/api/admin/agencies/${agencyId}`, undefined, 200, ah);
    const profile = agency.agency.creators.find((x) => x.id === c).billingProfile;
    await must(
      "PATCH",
      `/api/admin/creators/${c}/billing`,
      {
        expectedRevision: profile?.pricingRevision || 0,
        reason: "Local acceptance explicit test price",
        tier: "CUSTOM",
        tierMode: "MANUAL",
        corePriceCents: 1000,
        corePriceSource: "OVERRIDE",
      },
      200,
      ah
    );
    await refresh();
    await creatorCard().getByRole("button", { name: "Start 1 month · $10.00", exact: true }).click();
    await page.getByText(/Monthly subscription started/).waitFor();
    assert.equal(Number((await settings.getState()).billing.wallet.balanceCents), 9000);
    await creatorCard().getByRole("button", { name: "Cancel auto-renew", exact: true }).click();
    await page.getByText(/Automatic renewal cancelled/).waitFor();
    await creatorCard().getByRole("button", { name: "Resume auto-renew", exact: true }).click();
    await page.getByText(/Automatic monthly renewal is enabled/).waitFor();
    const paid = await settings.getState();
    assert.equal(Number(paid.billing.wallet.balanceCents), 9000);
    assert.equal(paid.billing.creators.find((x) => x.creatorId === c).entitlement.coreActive, true);
    results.billing = { explicitAdminTestPriceCents: 1000, balanceAfterCents: 9000 };
    pass(
      "Server-authorized explicit test price starts one monthly period; cancel/resume renewal preserves paid access and does not debit twice"
    );
    await capture("billing");

    const second = await must("POST", "/api/auth/login", {
      email: "owner@example.test",
      password: f.password,
      deviceId: "desktop-two",
      client: "desktop",
      authorizationScopeIncarnation: "settings-two",
    });
    await must(
      "POST",
      "/api/devices/heartbeat",
      { deviceId: "desktop-two", accounts: [], deviceName: "Second computer" },
      200,
      { Authorization: `Bearer ${second.accessToken}` }
    );
    await tab("My Account");
    await refresh();
    await page
      .locator(".sv-session")
      .filter({ hasText: "Second computer" })
      .getByRole("button", { name: "Log out", exact: true })
      .click();
    await page.getByText("Device logged out", { exact: true }).waitFor();
    await must("GET", "/api/settings/account", undefined, 401, { Authorization: `Bearer ${second.accessToken}` });
    const third = await must("POST", "/api/auth/login", {
      email: "owner@example.test",
      password: f.password,
      deviceId: "desktop-three",
      client: "desktop",
      authorizationScopeIncarnation: "settings-three",
    });
    await page.getByLabel("Current password", { exact: true }).fill(f.password);
    await page.getByLabel("New password", { exact: true }).fill("changed-acceptance-password");
    await page.getByLabel("Confirm new password", { exact: true }).fill("changed-acceptance-password");
    loseAction = "account.password";
    await page.getByRole("button", { name: "Change password", exact: true }).click();
    await page.getByText("Controlled reply lost after commit", { exact: true }).waitFor();
    assert.ok(
      !fs.readFileSync(path.join(scratch, "settings-account.json"), "utf8").includes("changed-acceptance-password")
    );
    reopen();
    await recover("Pending account security actions", () => account);
    assert.equal(await page.getByLabel("Current password", { exact: true }).inputValue(), "");
    await must("GET", "/api/settings/account", undefined, 401, { Authorization: `Bearer ${third.accessToken}` });
    await must("GET", "/api/settings/account");
    await must(
      "POST",
      "/api/auth/login",
      { email: "owner@example.test", password: f.password, deviceId: "old-password-check" },
      401
    );
    await must("POST", "/api/auth/login", {
      email: "owner@example.test",
      password: "changed-acceptance-password",
      deviceId: "new-password-check",
    });
    pass(
      "Account UI logs out a selected device; protected password journal recovers a committed password change, old password/other sessions fail and current session stays valid"
    );

    failRead = "settings.getEncryptionState";
    failuresLeft = 2;
    await tab("Encryption");
    await page.getByRole("button", { name: "Retry encryption state", exact: true }).click();
    await page.getByText("ROOT V1", { exact: true }).waitFor();
    const enc = await settings.getEncryptionState();
    assert.equal(enc.currentDevice.ownerRootAvailable, true);
    await f.stop("SIGKILL");
    await f.boot();
    reopen();
    const recovered = await settings.getState();
    assert.equal(recovered.account.user.name, "Edited owner");
    assert.equal(recovered.workspace.agency.name, "Renamed workspace");
    assert.equal(Number(recovered.billing.wallet.balanceCents), 9000);
    assert.equal(recovered.notifications.sound, true);
    assert.deepEqual(recovered.telegram.reminders.call.offsetsMinutes, [120, 47, 5]);
    results.recovery = { backendSIGKILL: true, protectedJournalsReopened: true, pageSettingsReopened: true };
    pass(
      "Encryption state read retries through actual keyring; Backend SIGKILL and store reopen retain profile, workspace, reminders, local notifications and paid wallet state"
    );

    await tab("My Account");
    await capture("account");
    const old = hold("settings.getState");
    await refresh();
    await old.entered;
    clearInterval(renewal);
    authority.quarantine("Acceptance logout");
    await page.evaluate(() =>
      window.ActualSettings.context({
        ok: true,
        authenticated: false,
        current: false,
        quarantineState: "UNAUTHENTICATED",
        localAuthorizationRevision: 100,
        session: null,
        creators: [],
        activeCreatorId: null,
      })
    );
    old.release();
    await page.getByText("Settings unavailable until account access is confirmed.", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("Display name", { exact: true }).count(), 0);
    pass("Replaced authorization context removes all Settings data and ignores late old-session response");
    assert.equal(errors.length, 0, errors.join("\n"));
  } catch (e) {
    if (page && !page.isClosed()) {
      results.failedUi = await page
        .locator("body")
        .innerText()
        .catch(() => null);
      await capture("failure");
    }
    throw e;
  } finally {
    clearInterval(renewal);
    settings?.destroy();
    await browser?.close();
    if (server) await new Promise((r) => server.close(r));
    results.rendererRpcCalls = calls.length;
    results.rendererErrors = errors;
    results.desktopRequests = requests.length;
    fs.writeFileSync(
      path.join(output, "renderer.json"),
      JSON.stringify({ calls, errors, requests, logs, findings }, null, 2)
    );
  }
};

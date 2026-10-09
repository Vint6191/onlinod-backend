"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  net = require("node:net"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const { spawn } = require("node:child_process"),
  { createRequire } = require("node:module");
// Real server/Prisma and current Desktop command/crypto modules on an isolated DB.
// No application DATABASE_URL, native Electron, or live provider is used.
const root = path.resolve(__dirname, "../.."),
  load = createRequire(path.join(root, "package.json"));
if (!process.env.ONLINOD_DESKTOP_ROOT || !process.env.ONLINOD_SQL_PROOF_RUNTIME) {
  throw Error("Set ONLINOD_DESKTOP_ROOT and ONLINOD_SQL_PROOF_RUNTIME to the local source/runtime directories");
}
const outputBase =
  process.env.ONLINOD_SQL_PROOF_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), "onlinod-acceptance-report-"));
const output = path.resolve(outputBase, "evidence/product-acceptance");
fs.mkdirSync(output, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "onlinod-acceptance-private-"));
// Only synthetic credentials enter this private temporary directory; remove it on every exit.
process.once("exit", () => fs.rmSync(scratch, { recursive: true, force: true }));
const desktop = path.resolve(process.env.ONLINOD_DESKTOP_ROOT),
  desktopLoad = createRequire(path.join(desktop, "package.json"));
const mainServices = path.join(desktop, "apps/desktop/electron/main/services");
const entry = path.join(scratch, "desktop-entry.ts"),
  bundle = path.join(scratch, "desktop-actual.cjs");
fs.writeFileSync(
  entry,
  `export * as e2e from ${JSON.stringify(path.join(mainServices, "client-e2e-keyring/client-e2e-crypto.ts"))};
export {ManagementCommandTransport} from ${JSON.stringify(path.join(mainServices, "management-commands/management-command-transport.ts"))};
export {TeamCommandTransport} from ${JSON.stringify(path.join(mainServices, "team-commands/team-command-transport.ts"))};
export {normalizeHomeSummary} from ${JSON.stringify(path.join(mainServices, "home/home-service.ts"))};
export * as campaigns from ${JSON.stringify(path.join(mainServices, "creator-analytics/campaign-read-contract.ts"))};`
);
desktopLoad("esbuild").buildSync({
  entryPoints: [entry],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "cjs",
  alias: { "@onlinod/shared": path.join(desktop, "packages/shared/src/index.ts") },
});
const { e2e, ManagementCommandTransport, TeamCommandTransport, normalizeHomeSummary, campaigns } = require(bundle);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {
  ok: false,
  checks: [],
  cases: [],
  responses: {},
  nativePostgres: false,
  nativeElectron: false,
  productionAccessed: false,
  externalProviders: false,
  engine: "PGlite + actual server.js/Prisma + current Desktop modules",
  node: process.version,
  limitations: [
    "Single physical SQL session: no native PostgreSQL contention proof",
    "Controlled identity/email fixtures: no real OF, Telegram, SMTP or S3",
    "No native Electron/Windows UI, full worker fleet, or real local AI model",
  ],
};
let lastCheck = 0;
const pass = (name) => {
  const checks = results.checks.slice(lastCheck);
  assert.ok(
    checks.every((x) => x.ok),
    name
  );
  results.cases.push({ name, ok: true, firstRequest: lastCheck + 1, requests: checks.length });
  lastCheck = results.checks.length;
  console.log("PASS", name);
};
async function main() {
  const f = await load("./scripts/test-support/admin-sql-runtime.cjs").createAdminSqlRuntime({
    runtimePath: process.env.ONLINOD_SQL_PROOF_RUNTIME,
    // A killed TCP client can remain in pglite-socket 0.2.11's handler set.
    // Leave bounded reconnect capacity; only one Backend is alive at a time
    // and PGlite still has one physical SQL session.
    maxConnections: 4,
  });
  let child,
    log = "",
    exit;
  try {
    await load("./src/services/admin-operator-bootstrap-service").bootstrapAdmin({
      db: f.db,
      commandId: crypto.randomUUID(),
      operator: "local-acceptance",
      reason: "Disposable local HTTP proof",
      email: "admin@example.test",
      password: "isolated-admin-password",
      name: "Local admin",
    });
    await f.db.$disconnect();
    const s = net.createServer();
    await new Promise((r, j) => {
      s.once("error", j);
      s.listen(0, "127.0.0.1", r);
    });
    const port = s.address().port;
    await new Promise((r) => s.close(r));
    const mailbox = path.join(scratch, "mail.jsonl");
    fs.writeFileSync(mailbox, "");
    const preload = path.join(scratch, "controlled-io.cjs");
    fs.writeFileSync(
      preload,
      `const fs=require('node:fs'),crypto=require('node:crypto');
require(${JSON.stringify(path.join(root, "src/services/email-service.js"))}).sendMail=async(payload,options)=>{
fs.appendFileSync(process.env.ONLINOD_ACCEPTANCE_MAILBOX,JSON.stringify({payload,idempotencyKey:options.idempotencyKey})+'\\n');
return {ok:true,outcome:'confirmed',providerId:'local-'+crypto.createHash('sha256').update(options.idempotencyKey).digest('hex').slice(0,32)};};
globalThis.fetch=async()=>{throw Error('ACCEPTANCE_EXTERNAL_IO_FORBIDDEN');};
`
    );
    const env = { ...process.env };
    for (const k of Object.keys(env))
      if (/DATABASE|DIRECT_URL|SHADOW|JWT|SECRET|PASSWORD|TOKEN|API_KEY|TELEGRAM|SMTP|BOOTSTRAP_ADMIN/.test(k))
        delete env[k];
    Object.assign(env, {
      DATABASE_URL: f.url,
      PORT: String(port),
      NODE_ENV: "production",
      JWT_SECRET: crypto.randomBytes(64).toString("base64url"),
      SNAPSHOT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      RESEND_API_KEY: "",
      ONLINOD_ACCEPTANCE_MAILBOX: mailbox,
    });
    async function boot() {
      const from = log.length;
      let ended = false;
      child = spawn(process.execPath, ["--require", preload, "src/server.js"], {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (b) => (log += b));
      child.stderr.on("data", (b) => (log += b));
      exit = new Promise((r, j) => {
        child.once("error", j);
        child.once("exit", (code, signal) => {
          ended = true;
          r({ code, signal });
        });
      });
      const deadline = Date.now() + 30000;
      while (!log.slice(from).includes('"message":"backend listening"')) {
        if (ended || Date.now() > deadline) throw Error(log.slice(from));
        await wait(50);
      }
    }
    async function stop(signal = "SIGTERM") {
      child.kill(signal);
      const t = setTimeout(() => child.kill("SIGKILL"), 15000);
      const status = await exit;
      clearTimeout(t);
      child = null;
      return status;
    }
    await boot();
    let token = null;
    const call = async (method, url, body, expected = 200, headers = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}${url}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      const data = await response.json();
      const entry = { method, url, status: response.status, code: data.code || null, ok: response.status === expected };
      results.checks.push(entry);
      results.responses[method + " " + url] = JSON.parse(
        JSON.stringify(data, (k, v) => (/token|password|ciphertext|authorizationSessionId/i.test(k) ? "[redacted]" : v))
      );
      assert.equal(response.status, expected, `${method} ${url}: ${JSON.stringify(data)}`);
      return { status: response.status, data };
    };
    const email = "owner@example.test",
      password = "isolated-password",
      deviceId = "desktop-one";
    const registration = await call(
      "POST",
      "/api/auth/register",
      { email, password, name: "Acceptance owner", agencyName: "Acceptance agency" },
      201
    );
    assert.equal(registration.status, 201);
    await call("POST", "/api/auth/login", { email, password, deviceId }, 403);
    const mail = fs
      .readFileSync(mailbox, "utf8")
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x))
      .at(-1);
    const code = /Or use this code: (\d+)/.exec(mail.payload.text)[1];
    const verified = await call("POST", "/api/auth/verify-email", { email, code });
    assert.equal(verified.status, 200);
    const login = await call("POST", "/api/auth/login", {
      email,
      password,
      deviceId,
      client: "desktop",
      authorizationScopeIncarnation: "acceptance-one",
    });
    assert.equal(login.status, 200);
    token = login.data.accessToken;
    const command = (action, targetId, payload) => ({ commandId: crypto.randomUUID(), action, targetId, payload });
    const agencyId = login.data.activeAgencyId,
      master = e2e.generateAgencyMasterKey(),
      keys = e2e.generateDeviceKeyPair();
    const actorProof = e2e.recoveryProofForMasterKey(master, agencyId, 1);
    const must = async (method, url, body, expected = 200, headers = {}) => {
      const r = await call(method, url, body, expected, headers);
      assert.equal(r.status, expected, JSON.stringify(r.data));
      return r.data;
    };
    await must("POST", "/api/devices/heartbeat", { deviceId, accounts: [], platform: "acceptance-node" });
    await must("PUT", "/api/client-e2e-keyring/device-identity", { deviceId, publicKey: keys.publicKey });
    await must(
      "POST",
      "/api/client-e2e-keyring/initialize",
      {
        deviceId,
        recoveryProof: actorProof,
        recoveryEnvelope: e2e.wrapMasterKeyForRecovery(
          master,
          e2e.generateRecoveryKey(),
          e2e.recoveryContext(agencyId, 1)
        ),
        ownerWrap: e2e.wrapKeyForDevice(master, keys.publicKey, e2e.rootWrapContext(agencyId, 1, deviceId)),
      },
      201
    );
    const auth = {
      readSession: () => ({ ...login.data, apiBase: `http://127.0.0.1:${port}` }),
      getAuthorizationScopeIncarnation: () => login.data.authorizationSessionId,
    };
    const authorization = {
      capturePermit: () => ({ incarnation: auth.getAuthorizationScopeIncarnation() }),
      assertPermitCurrent: (p) => assert.equal(p.incarnation, auth.getAuthorizationScopeIncarnation()),
    };
    let loseResponse = null;
    const api = {
      request: async (url, options = {}) => {
        const r = await call(options.method || "GET", url, options.body);
        if (r.status >= 400)
          throw Object.assign(Error(r.data.error || r.data.code), { code: r.data.code, status: r.status });
        if (loseResponse === options.body?.action) {
          loseResponse = null;
          throw Object.assign(Error("controlled response loss after server commit"), { code: "TEST_RESPONSE_LOST" });
        }
        return r.data;
      },
    };
    const journal = path.join(scratch, "management-journal.json");
    fs.rmSync(journal, { force: true });
    let transport = new ManagementCommandTransport(api, auth, journal, authorization, () => {});
    const manage = async (action, targetId, payload) => {
      const r = await transport.execute(action, targetId, payload);
      transport.acknowledge(r.commandId);
      return r;
    };
    async function connectCreator(username, remoteId) {
      const created = await manage("creator.create", "", { displayName: username, username });
      const c = created.creator.id;
      const begin = await manage("creator.beginConnection", c, {
        deviceId,
        expectedGeneration: 0,
        expectedState: "ENROLLMENT_REQUIRED",
      });
      await must(
        "POST",
        `/api/creators/${c}/complete-connection`,
        { connectionGeneration: begin.connectionGeneration, remoteId, username },
        409
      );
      await must("POST", `/api/client-e2e-keyring/creators/${c}/initialize-key`, { deviceId, actorProof }, 201);
      const payload = {
        fixture: true,
        identity: { id: remoteId, username },
        cookies: [{ name: "session", value: "controlled-fixture", domain: ".onlyfans.com" }],
      };
      const creatorKey = e2e.deriveCreatorKey(master, agencyId, c, 1);
      const opaquePayload = e2e.encryptCreatorSecret(payload, creatorKey, {
        agencyId,
        creatorId: c,
        keyVersion: 1,
        purpose: "creator-session",
      });
      const hash = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
      const write = {
        deviceId,
        baseRevision: 0,
        requestId: crypto.randomUUID(),
        capturedAt: new Date().toISOString(),
        platformUserId: remoteId,
        opaquePayload,
        credentialHash: hash,
        coherenceHash: hash,
        portableReady: true,
      };
      const state = await must("POST", `/api/creator-sessions/${c}`, write);
      assert.equal(state.state.revision, 1);
      const repeat = await must("POST", `/api/creator-sessions/${c}`, write);
      assert.equal(repeat.idempotent, true);
      assert.equal(repeat.state.revision, 1);
      const connected = await must("POST", `/api/creators/${c}/complete-connection`, {
        connectionGeneration: begin.connectionGeneration,
        remoteId,
        username,
      });
      assert.equal(connected.creator.connectionState, "CONNECTED");
      const read = await must("GET", `/api/creator-sessions/${c}?deviceId=${deviceId}&includePayload=1`);
      assert.deepEqual(
        e2e.decryptCreatorSecret(read.state.opaquePayload, creatorKey, {
          agencyId,
          creatorId: c,
          keyVersion: 1,
          purpose: "creator-session",
        }),
        payload
      );
      return { id: c, username, remoteId, write, creatorKey };
    }
    pass("Verified owner, workspace, device identity and encrypted key root");
    const first = await connectCreator("model_one", "100001"),
      second = await connectCreator("model_two", "100002"),
      c = first.id;
    pass("Two creators: enrollment, canonical session requirement, encrypted publication and decryption");
    const endpoints = [
      "/api/auth/me",
      "/api/workspace/context",
      "/api/creators",
      `/api/creators/${c}`,
      "/api/settings/account",
      "/api/settings/workspace",
      "/api/settings/billing",
      "/api/settings/telegram",
      "/api/billing/provider",
      "/api/home/summary?contractVersion=2",
      "/api/home/creators",
      "/api/team/state",
      "/api/team/invitations",
      "/api/team/schedule",
      "/api/team/analytics/overview",
      "/api/team/analytics/members",
      "/api/team/analytics/alerts",
      "/api/team/analytics/flags",
      `/api/stats/creators/${c}/overview-v2?campaignReadVersion=1`,
      `/api/stats/creators/${c}/current-task`,
      `/api/stats/creators/${c}/task-activity`,
      `/api/stats/creators/${c}/campaigns?campaignReadVersion=1`,
      `/api/stats/creators/${c}/campaign-scan?campaignReadVersion=1`,
      `/api/stats/creators/${c}/notification-scan`,
      `/api/stats/creators/${c}/financial-transaction-scan`,
      `/api/traffic/creators/${c}/overview`,
      `/api/subscribers/${c}/status`,
      `/api/subscribers/${c}/hidden-online`,
      `/api/automation/overview/${c}`,
      `/api/automation/controls/${c}`,
      `/api/automation/metrics/${c}`,
      `/api/automation/audit/${c}`,
      `/api/automation/follow-back/${c}`,
      `/api/automation/follow/${c}`,
      `/api/automation/bumps/${c}/overview`,
      `/api/automation/likes/${c}`,
      `/api/automation/sfs/${c}`,
      `/api/automation/deliveries?creatorId=${c}`,
      `/api/server/content/message-library/scripts?creatorId=${c}`,
      `/api/server/content/message-library/usage?creatorId=${c}`,
      `/api/server/vault-directory/${c}/unsorted`,
      `/api/server/vault-directory/${c}/never-used`,
      `/api/server/media-library/${c}/storylines`,
      `/api/server/media-library/${c}/sales/summary`,
      `/api/dialog-intelligence/creators/${c}/runs`,
      `/api/dialog-intelligence/creators/${c}/diagnostics`,
      `/api/custom-orders?creatorId=${c}`,
      `/api/custom-orders/operations/non-content?creatorId=${c}`,
      `/api/custom-orders/vault-destination?creatorId=${c}`,
      `/api/custom-orders/review-queue?creatorId=${c}`,
      `/api/custom-orders/ready-deliveries?creatorId=${c}`,
      `/api/creator-sessions/${c}?deviceId=${deviceId}`,
    ];
    for (const url of endpoints) await call("GET", url);
    const home = normalizeHomeSummary(results.responses["GET /api/home/summary?contractVersion=2"], "7d");
    assert.equal(home.revenue.totalCents, null);
    const campaignPage = campaigns.normalizeCampaignPage(
      results.responses[`GET /api/stats/creators/${c}/campaigns?campaignReadVersion=1`],
      c,
      "all"
    );
    assert.equal(campaignPage.rows.length, 0);
    pass("Current product read surfaces accepted; Home unknown revenue and Campaign Desktop parsers");
    // The actual Desktop durable transport persists before HTTP and validates the actual Backend result.
    loseResponse = "account.profile";
    await assert.rejects(
      transport.execute("account.profile", "", { expectedName: "Acceptance owner", name: "Renamed owner" }),
      (e) => e.code === "TEST_RESPONSE_LOST"
    );
    const pending = transport.listPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].received, false);
    assert.equal((await stop("SIGKILL")).signal, "SIGKILL");
    await boot();
    transport = new ManagementCommandTransport(api, auth, journal, authorization, () => {});
    const recovered = await transport.retry(pending[0].commandId);
    assert.equal(recovered.replayed, true);
    assert.equal(recovered.result.user.name, "Renamed owner");
    transport.acknowledge(recovered.commandId);
    assert.equal(transport.listPending().length, 0);
    pass("Lost response after commit, SIGKILL, new Desktop transport and same-command recovery");
    const workspace = await must("GET", "/api/settings/workspace");
    await manage("workspace.update", "", {
      expectedRevision: workspace.revision,
      name: "Verified agency",
      timezone: "Europe/Kyiv",
    });
    const billing = await must("GET", "/api/settings/billing");
    const price = billing.billing.creators.find((x) => x.creatorId === c);
    await manage("billing.preferences", c, {
      expectedRevision: price.controlRevision,
      aiChatterEnabled: true,
      outreachEnabled: false,
    });
    const metadata = (await must("GET", `/api/creators/${c}`)).creator;
    await manage("creator.update", c, { expectedUpdatedAt: metadata.updatedAt, displayName: "Model One renamed" });
    const proxy = await manage("network.create", c, {
      deviceId,
      expectedNetworkVersion: 0,
      label: "Fixture proxy",
      type: "SOCKS5",
      host: "proxy.example.test",
      port: 1080,
    });
    const updatedProxy = await manage("network.update", proxy.proxy.id, {
      deviceId,
      expectedVersion: proxy.proxy.version,
      label: "Updated fixture proxy",
    });
    const direct = await manage("network.assign", c, {
      expectedVersion: proxy.profile.version,
      mode: "DIRECT",
      proxyEndpointId: null,
    });
    assert.equal(direct.profile.mode, "DIRECT");
    await manage("network.delete", updatedProxy.proxy.id, { expectedVersion: updatedProxy.proxy.version });
    pass("Workspace, billing preferences, creator and network commands");
    for (const moduleKey of ["bumps", "follow_back", "follow", "likes", "sfs"]) {
      const enabled = await manage("automation.control", c, {
        scope: "module",
        moduleKey,
        expectedUpdatedAt: null,
        enabled: true,
      });
      assert.equal(enabled.control.enabled, true);
      await manage("automation.control", c, {
        scope: "module",
        moduleKey,
        expectedUpdatedAt: enabled.control.updatedAt,
        enabled: false,
      });
    }
    for (const kind of ["bump", "sfs"]) {
      const templateId = "fixture-" + kind;
      let task = (
        await manage("automation.template", c, {
          kind,
          operation: "save",
          templateId,
          expectedTaskId: null,
          expectedUpdatedAt: null,
          input: { text: "Fixture " + kind, title: "Fixture template" },
        })
      ).task;
      for (const operation of ["trash", "restore", "delete"]) {
        const r = await manage("automation.template", c, {
          kind,
          operation,
          templateId,
          expectedTaskId: task.id,
          expectedUpdatedAt: task.updatedAt,
        });
        if (operation === "delete") assert.equal(r.deleted, true);
        else task = r.task;
      }
    }
    pass("All five automation module controls and Bump/SFS template lifecycle");
    const operationResults = [];
    for (const [family, operations] of [
      ["analytics_refresh", ["refresh"]],
      ["notification", ["start", "stop"]],
      ["financial", ["start", "stop"]],
      ["campaign", ["start", "stop"]],
      ["vault", ["start", "pause", "resume", "cancel"]],
      ["dialog", ["start", "pause", "resume", "cancel"]],
      ["subscriber", ["start"]],
      ["traffic_refresh", ["refresh"]],
    ]) {
      for (const operation of operations) {
        const r = await transport.executeOperation(
          family,
          c,
          operation,
          family === "analytics_refresh" ? { rangeKey: "7d" } : {}
        );
        assert.equal(r.family, family);
        assert.equal(r.operation, operation);
        transport.acknowledge(r.commandId);
        operationResults.push({ family, operation });
      }
    }
    results.operationResults = operationResults;
    pass("Seventeen operational commands with current preview and result validation");
    // Full Message Library content/lifecycle with the current command protocol.
    const ml = "/api/server/content/message-library/commands/v3",
      scriptId = "acceptance-script";
    const save = command("save", scriptId, {
      creatorId: c,
      title: "Reusable script",
      folderId: "scripts",
      messages: [
        { id: "intro", text: "Hello", order: 0 },
        { id: "offer", text: "A second message", order: 1, price: 5 },
      ],
    });
    const saved = await must("POST", ml, save);
    assert.equal(saved.item.messages.length, 2);
    const replay = await must("POST", ml, save);
    assert.equal(replay.replayed, true);
    assert.equal(replay.item.serverId, saved.item.serverId);
    const duplicate = await must("POST", ml, command("duplicate", scriptId, { creatorId: c, title: "Copy" }));
    assert.notEqual(duplicate.item.id, scriptId);
    const blockTrash = await must(
      "POST",
      ml,
      command("block.trash", scriptId, { creatorId: c, messageId: "intro", expectedUpdatedAt: saved.item.updatedAt })
    );
    assert.equal(blockTrash.block.status, "trash");
    await must("POST", ml, command("block.restore", scriptId, { creatorId: c, messageId: "intro" }));
    const trashed = await must("POST", ml, command("trash", scriptId, { creatorId: c }));
    assert.equal(trashed.item.status, "trash");
    await must(
      "POST",
      ml,
      command("save", scriptId, { creatorId: c, title: "Forbidden edit in trash", messages: [] }),
      409
    );
    const restored = await must("POST", ml, command("restore", scriptId, { creatorId: c }));
    assert.equal(restored.item.status, "active");
    await must("POST", ml, command("trash", duplicate.item.id, { creatorId: c }));
    const deleted = await must("POST", ml, command("permanent", duplicate.item.id, { creatorId: c }));
    assert.equal(deleted.permanent, true);
    pass("Message Library save/replay/duplicate, block trash/restore and script lifecycle");
    // Media metadata is shared; logical folders must read back through the same creator.
    const media = await manage("media.metadata", c, {
      mediaId: "fixture-media-1",
      expectedAssetId: null,
      expectedUpdatedAt: null,
      metadata: {
        mediaType: "photo",
        description: "Fixture photo",
        manualTags: ["test"],
        visibleBodyParts: [],
        accessType: "free",
        minPrice: 0,
        idealPrice: 0,
      },
    });
    assert.equal(media.item.description, "Fixture photo");
    await manage("media.folder", c, { mediaIds: ["fixture-media-1"], folderId: "fixture-folder", action: "add" });
    const query = await must("POST", `/api/server/media-library/${c}/assets/query`, { mediaIds: ["fixture-media-1"] });
    assert.equal(query.items.length, 1);
    pass("Creator-scoped media metadata, folder assignment and readback");
    // New, edit and cancel a Custom without a live Telegram provider.
    const orderInput = {
      clientMutationId: crypto.randomUUID(),
      creatorId: c,
      dialogId: "fan-200001",
      type: "CONTENT",
      scenario: "Fixture custom request",
      price: 20,
      paidAmount: 5,
    };
    const order = await must("POST", "/api/custom-orders", orderInput, 201);
    const orderRepeat = await must("POST", "/api/custom-orders", orderInput);
    assert.equal(orderRepeat.order.id, order.order.id);
    const changed = await transport.execute("custom.update", c, {
      orderId: order.order.id,
      expectedUpdatedAt: order.order.updatedAt,
      patch: { scenario: "Updated fixture request" },
    });
    assert.equal(changed.order.creatorId, c);
    const customReplay = await transport.retry(changed.commandId);
    assert.equal(customReplay.replayed, true);
    assert.deepEqual(customReplay.result.order, changed.order);
    const cancelOrder = {
      orderId: order.order.id,
      expectedUpdatedAt: changed.order.updatedAt,
      patch: { status: "CANCELLED", cancelReason: "Acceptance complete" },
    };
    await assert.rejects(
      transport.execute("custom.update", c, cancelOrder),
      (error) => error.code === "TEAM_COMMAND_UNRESOLVED"
    );
    // Another client's command may supersede the current projection while the
    // first client still owns an unacknowledged receipt. Do not bypass its journal.
    await must("POST", "/api/management/commands/v1", command("custom.update", c, cancelOrder));
    const changedResult = await transport.retry(changed.commandId);
    assert.equal(changedResult.replayed, true);
    assert.equal(changedResult.resultUnavailable, true);
    assert.equal(changedResult.result, null);
    transport.acknowledge(changed.commandId);
    const dest = await must("GET", `/api/custom-orders/vault-destination?creatorId=${c}`);
    await manage("custom.destination", c, {
      folderId: "custom-folder",
      expectedFolderId: dest.folderId,
      expectedRevision: dest.revision,
    });
    pass("Custom create/edit/cancel, current receipt replay, superseded result and Vault destination");
    // A second logical Desktop receives only an approved encrypted key and canonical revision.
    const secondDevice = "desktop-two",
      secondKeys = e2e.generateDeviceKeyPair(),
      ownerToken = token;
    const loginTwo = await must("POST", "/api/auth/login", {
      email,
      password,
      deviceId: secondDevice,
      client: "desktop",
      authorizationScopeIncarnation: "acceptance-two",
    });
    token = loginTwo.accessToken;
    await must("POST", "/api/devices/heartbeat", { deviceId: secondDevice, accounts: [] });
    await must("PUT", "/api/client-e2e-keyring/device-identity", {
      deviceId: secondDevice,
      publicKey: secondKeys.publicKey,
    });
    await must("GET", `/api/creator-sessions/${c}?deviceId=${secondDevice}&includePayload=1`, undefined, 403);
    token = ownerToken;
    await must("POST", `/api/client-e2e-keyring/devices/${secondDevice}/approve`, {
      approverDeviceId: deviceId,
      expectedRootVersion: 1,
      actorProof,
      ownerWrap: e2e.wrapKeyForDevice(master, secondKeys.publicKey, e2e.rootWrapContext(agencyId, 1, secondDevice)),
      creatorWraps: [],
    });
    token = loginTwo.accessToken;
    const portable = await must("GET", `/api/creator-sessions/${c}?deviceId=${secondDevice}&includePayload=1`);
    assert.equal(portable.state.revision, 1);
    const secondWrite = {
      ...first.write,
      deviceId: secondDevice,
      baseRevision: 1,
      requestId: crypto.randomUUID(),
      capturedAt: new Date().toISOString(),
      coherenceHash: "a".repeat(64),
    };
    const advanced = await must("POST", `/api/creator-sessions/${c}`, secondWrite);
    assert.equal(advanced.state.revision, 2);
    token = ownerToken;
    await must(
      "POST",
      `/api/creator-sessions/${c}`,
      {
        ...first.write,
        baseRevision: 1,
        requestId: crypto.randomUUID(),
        capturedAt: new Date().toISOString(),
        coherenceHash: "b".repeat(64),
      },
      409
    );
    pass("Second device: approval, canonical revision advance and stale writer rejection");
    // Team invitation, assigned scope, schedule, and current-token revocation.
    const teamJournal = path.join(scratch, "team-journal.json");
    fs.rmSync(teamJournal, { force: true });
    const team = new TeamCommandTransport(
      api,
      auth,
      teamJournal,
      async () => actorProof,
      () => {}
    );
    const teamRun = async (action, targetId, payload) => {
      const r = await team.execute(action, targetId, payload);
      team.acknowledge(r.commandId);
      return r;
    };
    const invitation = await teamRun("invitation.create", "", {
      email: "member@example.test",
      displayName: "Member",
      roleKey: "chatter",
      assignedCreators: [c],
      functions: ["CHATTER"],
    });
    assert.ok(invitation.token);
    token = null;
    await must(
      "POST",
      "/api/auth/register",
      { email: "member@example.test", password, name: "Member", inviteToken: invitation.token },
      201
    );
    const memberMail = fs
      .readFileSync(mailbox, "utf8")
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x))
      .at(-1);
    await must("POST", "/api/auth/verify-email", {
      email: "member@example.test",
      code: /Or use this code: (\d+)/.exec(memberMail.payload.text)[1],
    });
    const memberLogin = await must("POST", "/api/auth/login", {
      email: "member@example.test",
      password,
      deviceId: "member-desktop",
      authorizationScopeIncarnation: "member-acceptance",
    });
    token = memberLogin.accessToken;
    await must("GET", `/api/creators/${c}`);
    await must("GET", `/api/creators/${second.id}`, undefined, 403);
    await must(
      "POST",
      ml,
      command("save", "forbidden-script", { creatorId: second.id, title: "Forbidden", messages: [] }),
      403
    );
    token = ownerToken;
    const startsAt = new Date(Date.now() + 3600000).toISOString(),
      endsAt = new Date(Date.now() + 7200000).toISOString();
    const shift = await teamRun("shift.create", "", {
      memberId: memberLogin.activeMemberId,
      creatorIds: [c],
      startsAt,
      endsAt,
      timezone: "Europe/Kyiv",
    });
    await teamRun("shift.cancel", shift.shiftId, { expectedRevision: 1, reason: "Acceptance complete" });
    await teamRun("member.status", memberLogin.activeMemberId, { status: "deactivated" });
    token = memberLogin.accessToken;
    await must("GET", `/api/creators/${c}`, undefined, 401);
    await must(
      "POST",
      ml,
      command("save", "after-revoke", { creatorId: c, title: "Forbidden after revoke", messages: [] }),
      401
    );
    token = ownerToken;
    pass("Team invitation, assigned creator scope, schedule and immediate member revocation");
    const currentSecond = (await must("GET", `/api/creators/${second.id}`)).creator;
    const retirementPayload = {
      expectedUpdatedAt: currentSecond.updatedAt,
      phrase: load("./src/services/creator-agency-removal").agencyRemovalPhrase(currentSecond),
      acknowledgeAgencyRemoval: true,
      acknowledgeSessionRevocation: true,
    };
    const protectedRetirement = await must(
      "POST",
      "/api/management/commands/v1",
      command("creator.retire", second.id, retirementPayload),
      409
    );
    assert.equal(protectedRetirement.code, "CREATOR_MASS_PROVIDER_SNAPSHOT_REQUIRED");
    const draft = (await manage("creator.create", "", { displayName: "Unused draft", username: "unused_draft" }))
      .creator;
    const removed = await manage("creator.retire", draft.id, {
      ...retirementPayload,
      expectedUpdatedAt: draft.updatedAt,
      phrase: load("./src/services/creator-agency-removal").agencyRemovalPhrase(draft),
    });
    assert.equal(removed.historyPreserved, true);
    await must("GET", `/api/creators/${draft.id}`, undefined, 404);
    await must("GET", `/api/creators/${c}`);
    pass("Creator retirement requires provider evidence; unused creator can be retired");
    // Admin uses a separate session and a typed, idempotent domain command.
    await must("GET", "/api/admin-auth/me", undefined, 401);
    const adminLogin = await must("POST", "/api/admin-auth/login", {
      email: "admin@example.test",
      password: "isolated-admin-password",
    });
    token = adminLogin.token;
    await must("GET", "/api/admin-auth/me");
    await must("GET", "/api/admin/data/anomalies");
    await must("DELETE", `/api/admin/data/record/CreatorAccount/${c}`, {}, 410);
    const agency = await must("GET", `/api/admin/agencies/${agencyId}`);
    results.adminAgency = agency;
    const holdBody = {
        expectedRevision: agency.agency.billingPolicyRevision,
        enabled: true,
        reason: "Acceptance hold",
      },
      holdId = crypto.randomUUID();
    const hold = await must("PATCH", `/api/admin/agencies/${agencyId}/billing-hold`, holdBody, 200, {
      "Idempotency-Key": holdId,
    });
    const holdReplay = await must("PATCH", `/api/admin/agencies/${agencyId}/billing-hold`, holdBody, 200, {
      "Idempotency-Key": holdId,
    });
    assert.deepEqual(holdReplay, hold);
    await must("GET", `/api/admin/commands/${holdId}`);
    const heldAgency = await must("GET", `/api/admin/agencies/${agencyId}`);
    await must(
      "PATCH",
      `/api/admin/agencies/${agencyId}/billing-hold`,
      { expectedRevision: heldAgency.agency.billingPolicyRevision, enabled: false, reason: "Acceptance complete" },
      200,
      { "Idempotency-Key": crypto.randomUUID() }
    );
    await must("POST", "/api/admin-auth/logout", {});
    await must("GET", "/api/admin-auth/me", undefined, 401);
    token = ownerToken;
    pass("Separate admin session, typed billing policy receipt/replay and generic mutation denial");
    // Replaced unkeyed mutation surfaces must remain closed.
    results.unkeyedMutationProbes = [];
    for (const [url, body] of [
      [`/api/server/automation/bumps/${c}/upsert`, { id: "bump_unkeyed", text: "unkeyed write" }],
      [`/api/automation/controls`, { creatorId: c, scope: "creator", enabled: false }],
      [`/api/server/vault-directory/${c}/unsorted/scans`, { mode: "full" }],
      [`/api/custom-orders/vault-destination`, { creatorId: c, folderId: "unkeyed-folder" }],
    ]) {
      const r = await call(
        url.includes("vault-destination") || url.endsWith("/controls") ? "PATCH" : "POST",
        url,
        body,
        410
      );
      results.unkeyedMutationProbes.push({ url, status: r.status, code: r.data.code });
    }
    pass("Retired unkeyed management writes return 410");
    results.desktops = {
      actualCrypto: true,
      actualDurableTransport: true,
      actualHomeParser: true,
      actualCampaignParser: true,
      creators: [c, second.id],
    };
    const beforeRestart = await must("GET", `/api/server/content/message-library/scripts?creatorId=${c}`);
    assert.equal((await stop()).code, 0);
    await boot();
    const afterRestart = await must("GET", `/api/server/content/message-library/scripts?creatorId=${c}`);
    assert.deepEqual(afterRestart.items, beforeRestart.items);
    await must("GET", "/ready");
    assert.doesNotMatch(log, /prisma:error|step failed|sweep crashed|maintenance degraded|42P01|does not exist/);
    pass("Graceful server restart preserves current Message Library data and readiness");
    assert.equal(transport.listPending().length, 0);
    results.ok = true;
  } catch (e) {
    results.error = { message: e.message, stack: e.stack };
    throw e;
  } finally {
    if (child) {
      child.kill("SIGTERM");
      const t = setTimeout(() => child.kill("SIGKILL"), 15000);
      await exit;
      clearTimeout(t);
    }
    fs.writeFileSync(path.join(output, "server.log"), log);
    fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(results, null, 2));
    await f.close();
  }
}
// PGlite socket callbacks alone do not retain the event loop during initialization.
const keep = setInterval(() => {}, 1000);
const deadline = setTimeout(() => {
  console.error("PRODUCT_ACCEPTANCE_DEADLINE");
  process.exit(2);
}, 180000);
main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    clearInterval(keep);
    clearTimeout(deadline);
    fs.rmSync(scratch, { recursive: true, force: true });
    console.log("Report:", path.join(output, "results.json"));
  });

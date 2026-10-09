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
const output = path.resolve(outputBase, "evidence/custom-acceptance");
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
export {CustomOrdersService} from ${JSON.stringify(path.join(mainServices, "custom-orders/custom-orders-service.ts"))};
export {DesktopCurrentAuthorizationAuthorityService} from ${JSON.stringify(path.join(mainServices, "desktop-authorization/desktop-current-authorization-authority.ts"))};
export {VaultService} from ${JSON.stringify(path.join(mainServices, "vault/vault-service.ts"))};
export {ProgrammaticOfWriteClient} from ${JSON.stringify(path.join(mainServices, "programmatic-of-write/programmatic-of-write-client.ts"))};`
);
const electronFixture = path.join(scratch, "electron.mjs");
fs.writeFileSync(
  electronFixture,
  `export * from ${JSON.stringify(path.join(desktop, "apps/desktop/scripts/test-support/custom-electron-fixture.mjs"))};export const session={fromPartition(){throw Error('NATIVE_ELECTRON_NOT_AVAILABLE_IN_ACCEPTANCE');}};`
);
const bundleReady = desktopLoad("esbuild").build({
  entryPoints: [entry],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "cjs",
  alias: { "@onlinod/shared": path.join(desktop, "packages/shared/src/index.ts"), electron: electronFixture },
  define: {
    "import.meta.url": JSON.stringify(require("node:url").pathToFileURL(path.join(desktop, "package.json")).href),
  },
  plugins: [
    {
      name: "native-sqlite",
      setup(build) {
        build.onResolve({ filter: /^better-sqlite3$/ }, () => ({
          path: desktopLoad.resolve("better-sqlite3"),
          external: true,
        }));
      },
    },
  ],
});
let desktopModules, e2e, ManagementCommandTransport;
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
    "No native Electron/Windows UI or physical MTProto/OF/S3 provider call",
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
const { runCustoms } = require("../test-support/current-custom-workflow.cjs");
async function main() {
  await bundleReady;
  desktopModules = require(bundle);
  ({ e2e, ManagementCommandTransport } = desktopModules);
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
      const entry = {
        method,
        url,
        status: response.status,
        code: data.code || null,
        ok: expected === null || (Array.isArray(expected) ? expected : [expected]).includes(response.status),
      };
      results.checks.push(entry);
      results.responses[method + " " + url] = JSON.parse(
        JSON.stringify(data, (k, v) =>
          /token|password|ciphertext|authorizationSessionId|apiHash|session$/i.test(k) ? "[redacted]" : v
        )
      );
      assert.ok(
        expected === null || (Array.isArray(expected) ? expected : [expected]).includes(response.status),
        `${method} ${url}: ${JSON.stringify(data)}`
      );
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
      apiBase: `http://127.0.0.1:${port}`,
      request: async (url, options = {}) => {
        const r = await call(options.method || "GET", url, options.body, null);
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
    await runCustoms({
      modules: desktopModules,
      root,
      desktop,
      scratch,
      must,
      call,
      manage,
      command,
      api,
      auth,
      login: login.data,
      agencyId,
      deviceId,
      creatorId: c,
      creatorIds: [c, second.id],
      transport,
      pass,
      results,
      stop,
      boot,
      withDatabase: async (work) => {
        await stop();
        try {
          return await work(f.db, load, f.queries);
        } finally {
          await f.db.$disconnect();
          await load("./src/prisma").$disconnect();
          await boot();
        }
      },
    });
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

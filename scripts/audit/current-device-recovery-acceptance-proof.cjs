"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  net = require("node:net"),
  crypto = require("node:crypto"),
  assert = require("node:assert/strict");
const { spawn, fork } = require("node:child_process"),
  { createRequire } = require("node:module");
const root = path.resolve(__dirname, "../.."),
  load = createRequire(path.join(root, "package.json"));
if (!process.env.ONLINOD_DESKTOP_ROOT) throw Error("Set ONLINOD_DESKTOP_ROOT to the current Desktop source root");
const desktop = path.resolve(process.env.ONLINOD_DESKTOP_ROOT),
  desktopLoad = createRequire(path.join(desktop, "package.json"));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "nod-device-proof-"));
const output = path.resolve(process.env.ONLINOD_SQL_PROOF_OUTPUT || scratch, "evidence/device-recovery");
fs.mkdirSync(output, { recursive: true });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const result = {
  ok: false,
  cases: [],
  checks: [],
  requests: [],
  processes: [],
  findings: [],
  nativeElectron: false,
  nativePostgres: false,
  externalProviders: false,
  externalWrites: 0,
  engine: "Independent Desktop Node processes + actual auth/keyring/broker/publisher/journals + Backend/Prisma/PGlite",
  limitations: [
    "Native Electron Session/Windows DPAPI are controlled OS ports",
    "One physical SQL session; logical client concurrency is not native PostgreSQL contention",
    "Portable OnlyFans credentials are synthetic, no external provider is contacted",
  ],
};
const baseline = process.env.ONLINOD_DEVICE_BASELINE === "1";
function check(ok, name) {
  result.checks.push({ name, ok: !!ok });
  console.log(ok ? "CHECK" : "FINDING", name);
  if (!ok) result.findings.push(name);
  if (!baseline) assert.ok(ok, name);
}
function pass(name) {
  result.cases.push(name);
  console.log("PASS", name);
}
function deadline(promise, name, ms = 45000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(`Timed out: ${name}`)), ms);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}
async function until(read, test, name, timeout = 20000) {
  const end = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (test(value)) return value;
    assert.ok(Date.now() < end, name);
    await wait(50);
  } while (true);
}
async function bundleDesktop() {
  const services = path.join(desktop, "apps/desktop/electron/main/services");
  const exports = {
    "backend/auth-session-store.ts": ["createAuthSessionStore"],
    "backend/backend-auth-service.ts": ["createBackendAuthService"],
    "backend/backend-api-client.ts": ["BackendApiClient"],
    "backend/creator-service.ts": ["createCreatorService"],
    "creator-capability/creator-access-runtime.ts": ["CreatorAccessRuntimeService"],
    "desktop-authorization/desktop-current-authorization-authority.ts": ["DesktopCurrentAuthorizationAuthorityService"],
    "client-e2e-keyring/client-e2e-keyring-service.ts": ["ClientE2eKeyringService"],
    "creator-session-broker/creator-session-broker-client.ts": ["CreatorSessionBrokerClient"],
    "creator-session-broker/creator-session-publisher-outbox.ts": ["CreatorSessionPublisherOutbox"],
    "creator-session-broker/creator-session-canonical-publisher-service.ts": [
      "CreatorSessionCanonicalPublisherService",
    ],
    "management-commands/management-command-transport.ts": ["ManagementCommandTransport"],
  };
  const entry = path.join(scratch, "entry.ts"),
    bundle = path.join(scratch, "desktop.cjs"),
    electron = path.join(scratch, "electron.mjs");
  fs.writeFileSync(
    entry,
    Object.entries(exports)
      .map(([file, names]) => `export {${names.join(",")}} from ${JSON.stringify(path.join(services, file))};`)
      .join("\n")
  );
  fs.writeFileSync(
    electron,
    `import crypto from 'node:crypto';
const key=Buffer.from(process.env.ONLINOD_DEVICE_PROOF_OS_KEY,'hex');
export const app={getPath:name=>name==='temp'?process.env.TMPDIR||'/tmp':process.env.ONLINOD_DEVICE_PROOF_DIRECTORY,getVersion:()=> '0.7.1'};
export const safeStorage={isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'controlled-device-aes',encryptString(value){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,c.update(value,'utf8'),c.final(),c.getAuthTag()]);},decryptString(value){const d=crypto.createDecipheriv('aes-256-gcm',key,value.subarray(0,12));d.setAuthTag(value.subarray(-16));return Buffer.concat([d.update(value.subarray(12,-16)),d.final()]).toString('utf8');}};`
  );
  await desktopLoad("esbuild").build({
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    alias: { electron, "@nod/shared": path.join(desktop, "packages/shared/src/index.ts") },
    define: {
      "import.meta.url": JSON.stringify(require("node:url").pathToFileURL(path.join(desktop, "package.json")).href),
    },
  });
  return bundle;
}
async function main() {
  const bundle = await bundleDesktop();
  const f = await load("./scripts/test-support/admin-sql-runtime.cjs").createAdminSqlRuntime({
    runtimePath: process.env.ONLINOD_SQL_PROOF_RUNTIME,
    maxConnections: 4,
  });
  let backend,
    backendExit,
    log = "";
  const devices = new Map(),
    identities = new Map();
  try {
    const hash = await load("bcryptjs").hash("isolated-owner-password", 10);
    const writes = load("./src/services/database-write-contract-service");
    await f.db.$transaction(async (tx) => {
      await writes.assertTeamControlPlaneWriteAdmission(tx);
      await tx.user.create({
        data: {
          id: "owner",
          email: "owner@example.test",
          name: "Proof owner",
          passwordHash: hash,
          emailVerifiedAt: new Date(),
        },
      });
      await tx.agency.create({
        data: { id: "device-agency", name: "Device proof", trialEndsAt: new Date(Date.now() + 14 * 86400000) },
      });
      await tx.agencyMember.create({
        data: { id: "device-owner", userId: "owner", agencyId: "device-agency", role: "OWNER", roleKey: "owner" },
      });
      await tx.user.create({
        data: {
          id: "manager",
          email: "manager@example.test",
          name: "Proof manager",
          passwordHash: hash,
          emailVerifiedAt: new Date(),
        },
      });
      await tx.agencyMember.create({
        data: {
          id: "device-manager",
          userId: "manager",
          agencyId: "device-agency",
          role: "MANAGER",
          roleKey: "manager",
          assignedCreators: "all",
        },
      });
    });
    await f.db.$disconnect();
    const socket = net.createServer();
    await new Promise((r) => socket.listen(0, "127.0.0.1", r));
    const port = socket.address().port;
    await new Promise((r) => socket.close(r));
    const origin = `http://127.0.0.1:${port}`;
    const preload = path.join(scratch, "backend-io.cjs");
    fs.writeFileSync(
      preload,
      `globalThis.fetch=async()=>{throw Error('EXTERNAL_IO_FORBIDDEN_IN_DEVICE_PROOF')};require(${JSON.stringify(path.join(root, "src/services/email-service.js"))}).sendMail=async()=>{throw Error('EMAIL_FORBIDDEN_IN_DEVICE_PROOF')};`
    );
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (/DATABASE|DIRECT_URL|SHADOW|JWT|SECRET|PASSWORD|TOKEN|API_KEY|TELEGRAM|SMTP|BOOTSTRAP_ADMIN/.test(key))
        delete env[key];
    Object.assign(env, {
      DATABASE_URL: f.url,
      PORT: String(port),
      NODE_ENV: "production",
      JWT_SECRET: crypto.randomBytes(64).toString("base64url"),
      SNAPSHOT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      PUBLIC_BASE_URL: origin,
    });
    async function bootBackend() {
      const from = log.length;
      backend = spawn(process.execPath, ["--require", preload, "src/server.js"], {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      backend.stdout.on("data", (b) => (log += b));
      backend.stderr.on("data", (b) => (log += b));
      backendExit = new Promise((r, j) => {
        backend.once("error", j);
        backend.once("exit", (code, signal) => r({ code, signal }));
      });
      await until(
        () => log.slice(from),
        (x) => x.includes('"message":"backend listening"'),
        "backend starts",
        30000
      );
    }
    async function stopBackend(signal = "SIGTERM") {
      backend.kill(signal);
      await deadline(backendExit, "Backend shutdown");
      backend = null;
    }
    async function startDevice(name) {
      if (!identities.has(name))
        identities.set(name, { key: crypto.randomBytes(32).toString("hex"), directory: path.join(scratch, name) });
      const identity = identities.get(name);
      fs.mkdirSync(identity.directory, { recursive: true });
      const child = fork(path.join(root, "scripts/test-support/current-device-recovery-client.cjs"), [], {
        execPath: process.execPath,
        env: {
          ...env,
          DATABASE_URL: "",
          ONLINOD_DEVICE_PROOF_DIRECTORY: identity.directory,
          ONLINOD_DEVICE_PROOF_OS_KEY: identity.key,
          ONLINOD_DEVICE_PROOF_ORIGIN: origin,
          ONLINOD_DEVICE_PROOF_BUNDLE: bundle,
          ONLINOD_DESKTOP_ROOT: desktop,
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      let next = 0,
        ready,
        stderr = "";
      const pending = new Map(),
        faults = new Map();
      const readyPromise = new Promise((r) => (ready = r)),
        exited = new Promise((r) =>
          child.once("exit", (code, signal) => {
            for (const p of pending.values()) p.reject(Error("Desktop process exited"));
            pending.clear();
            r({ code, signal });
          })
        );
      child.stderr.on("data", (b) => (stderr += b));
      child.on("message", (message) => {
        if (message.event === "ready") {
          result.processes.push({ name, pid: message.pid, deviceId: message.deviceId });
          ready(message);
        } else if (message.event === "request") result.requests.push({ device: name, ...message });
        else if (message.event === "fault") {
          faults.get(message.id)?.();
          faults.delete(message.id);
        } else if (message.id && pending.has(message.id)) {
          const p = pending.get(message.id);
          pending.delete(message.id);
          message.ok ? p.resolve(message.value) : p.reject(Object.assign(Error(message.error.message), message.error));
        }
      });
      const d = {
        call(method, input) {
          const id = ++next;
          return deadline(
            new Promise((resolve, reject) => {
              pending.set(id, { resolve, reject });
              child.send({ id, method, input });
            }),
            `${name}: ${method}`
          ).finally(() => pending.delete(id));
        },
        async stop(signal = "SIGKILL") {
          child.kill(signal);
          await exited;
          devices.delete(name);
        },
        async fault(spec) {
          const id = crypto.randomUUID(),
            seen = new Promise((r) => faults.set(id, r));
          await d.call("fault", { ...spec, id });
          return {
            seen: deadline(seen, `${name}: ${spec.method} ${spec.path} interruption`),
            release: () => d.call("release", { id }),
          };
        },
        key(method, ...args) {
          return d.call("keyring", { method, args });
        },
        async login(email = "owner@example.test") {
          return d.call("login", { email, password: "isolated-owner-password" });
        },
      };
      devices.set(name, d);
      await Promise.race([
        readyPromise,
        exited.then(() => {
          throw Error("Device startup failed: " + stderr.slice(-3000));
        }),
      ]);
      return d;
    }
    await bootBackend();
    let a = await startDevice("desktop-a");
    await a.login();
    const originalIdentity = await a.call("state");
    const initializeLoss = await a.fault({
      method: "POST",
      path: "/api/client-e2e-keyring/initialize",
      phase: "after",
      action: "drop",
    });
    await assert.rejects(a.key("initializeAgencyRoot"));
    await initializeLoss.seen;
    const initializePending = await a.key("pendingRootRecovery");
    assert.equal(initializePending.kind, "INITIALIZE");
    await a.stop();
    a = await startDevice("desktop-a");
    assert.equal((await a.call("auth")).authorizationSessionId, originalIdentity.authorizationSessionId);
    const initial = await a.key("resumeRootRecovery");
    check(
      initial.operationId === initializePending.operationId && initial.rootVersion === 1,
      "root initialization survives lost committed reply and Desktop SIGKILL with the same protected intent"
    );
    await a.key("acknowledgeRootRecovery", initial.operationId);
    assert.equal(await a.key("pendingRootRecovery"), null);
    pass("Protected root initialization and remembered identity recovery");
    const create = await a.call("manage", {
      action: "creator.create",
      payload: { displayName: "Device model", username: "device_model" },
    });
    const creatorId = create.creator.id;
    const begin = await a.call("manage", {
      action: "creator.beginConnection",
      targetId: creatorId,
      payload: {
        deviceId: (await a.call("state")).deviceId,
        expectedGeneration: 0,
        expectedState: "ENROLLMENT_REQUIRED",
      },
    });
    const snapshot = (value) => ({
      creatorId,
      platformUserId: "100001",
      capturedAt: new Date().toISOString(),
      webContentsId: 1,
      payload: {
        cookies: [
          {
            name: "auth_id",
            value: "100001",
            domain: ".onlyfans.com",
            path: "/",
            secure: true,
            httpOnly: false,
            hostOnly: false,
            session: true,
            sameSite: "no_restriction",
            expirationDate: null,
          },
          {
            name: "sess",
            value,
            domain: ".onlyfans.com",
            path: "/",
            secure: true,
            httpOnly: true,
            hostOnly: false,
            session: true,
            sameSite: "no_restriction",
            expirationDate: null,
          },
        ],
        storage: { bcTokenSha: "controlled-bc" },
        userAgent: "NOD isolated acceptance",
      },
    });
    await a.call("publish", { snapshot: snapshot("initial-session") });
    await until(
      () => a.call("state"),
      (x) => x.events.some((e) => e.creatorId === creatorId),
      "first canonical publication"
    );
    await a.call("api", {
      path: `/api/creators/${creatorId}/complete-connection`,
      options: {
        method: "POST",
        body: { connectionGeneration: begin.connectionGeneration, remoteId: "100001", username: "device_model" },
      },
    });
    check(
      (await a.call("read", { creatorId })).revision === 1,
      "first Desktop publishes an encrypted canonical session"
    );

    const sessionPath = `/api/creator-sessions/${creatorId}`;
    const posts = (name, route) =>
      result.requests.filter((r) => (!name || r.device === name) && r.method === "POST" && r.path === route).length;
    const canonical = (device, revision) =>
      until(
        () => device.call("state"),
        (s) => s.pending.length === 0 && s.events.some((e) => e.creatorId === creatorId && e.revision === revision),
        `canonical revision ${revision}`
      );
    const publicationLoss = await a.fault({ method: "POST", path: sessionPath, phase: "after", action: "drop" });
    await a.call("publish", { snapshot: snapshot("committed-before-restart") });
    await publicationLoss.seen;
    check(
      (await a.call("state")).pending.length === 1,
      "encrypted outbox retains an unacknowledged committed publication"
    );
    await a.stop();
    await stopBackend("SIGKILL");
    await bootBackend();
    const publicationPosts = posts("desktop-a", sessionPath);
    a = await startDevice("desktop-a");
    await a.call("resume");
    await canonical(a, 2);
    const recovered = await a.call("read", { creatorId });
    check(
      recovered.revision === 2 &&
        recovered.payload.cookies.some((c) => c.value === "committed-before-restart") &&
        posts("desktop-a", sessionPath) === publicationPosts,
      "Desktop and Backend restart reconcile the committed session without a duplicate write"
    );
    assert.equal((await a.call("state")).deviceId, originalIdentity.deviceId);

    const commandLoss = await a.fault({
      method: "POST",
      path: "/api/management/commands/v1",
      phase: "after",
      action: "drop",
    });
    await assert.rejects(
      a.call("manage", { action: "account.profile", payload: { name: "Recovered owner", expectedName: "Proof owner" } })
    );
    await commandLoss.seen;
    const pendingCommands = await a.call("managementPending");
    assert.equal(pendingCommands.length, 1);
    const profileCommandId = pendingCommands[0].commandId;
    await a.stop();
    a = await startDevice("desktop-a");
    const profileRecovery = await a.call("managementRecover", { commandId: profileCommandId });
    await a.call("managementAck", { commandId: profileCommandId });
    check(
      profileRecovery.commandId === profileCommandId && (await a.call("managementPending")).length === 0,
      "management journal recovers the same command after lost reply and process death"
    );
    assert.equal((await a.call("api", { path: "/api/auth/me" })).user.name, "Recovered owner");
    pass("Canonical publication and management command recovery across process death");

    let b = await startDevice("desktop-b");
    await b.login();
    await b.key("ensureRegisteredIdentity");
    await assert.rejects(b.call("read", { creatorId }), (e) => e.status === 403);
    await a.key("approveDevice", (await b.call("state")).deviceId);
    check(
      (await b.call("read", { creatorId })).payload.cookies.some((x) => x.value === "committed-before-restart"),
      "second Desktop decrypts only after actual owner approval"
    );
    const concurrent = await a.fault({ method: "POST", path: sessionPath, phase: "before", action: "hold" });
    await a.call("publish", { snapshot: snapshot("stale-concurrent-a") });
    await concurrent.seen;
    await b.call("publish", { snapshot: snapshot("current-concurrent-b") });
    await canonical(b, 3);
    await concurrent.release();
    await canonical(a, 3);
    check(
      (await a.call("read", { creatorId })).payload.cookies.some((c) => c.value === "current-concurrent-b") &&
        result.requests.some((r) => r.device === "desktop-a" && r.path === sessionPath && r.status === 409),
      "two live publishers resolve CAS conflict by adopting the winning canonical state"
    );

    const offline = await a.fault({ method: "POST", path: sessionPath, phase: "before", action: "drop" });
    await a.call("publish", { snapshot: snapshot("stale-offline-a") });
    await offline.seen;
    assert.equal((await a.call("state")).pending.length, 1);
    await a.stop();
    await b.call("publish", { snapshot: snapshot("current-offline-b") });
    await canonical(b, 4);
    const beforeResume = posts("desktop-a", sessionPath);
    a = await startDevice("desktop-a");
    await a.call("resume");
    await canonical(a, 4);
    check(
      posts("desktop-a", sessionPath) === beforeResume &&
        (await a.call("read", { creatorId })).payload.cookies.some((c) => c.value === "current-offline-b"),
      "restarted offline outbox discards its older revision instead of overwriting the other Desktop"
    );
    pass("Two real publisher processes: compare-and-set conflict and obsolete offline queue");

    const credentials = { username: "controlled-proxy-user", password: "controlled-proxy-password" };
    const opaqueCredentials = await a.call("encrypt", { creatorId, purpose: "proxy-credentials", value: credentials });
    const proxy = await a.call("manage", {
      action: "network.create",
      targetId: creatorId,
      payload: {
        label: "Isolated proxy",
        type: "HTTP",
        host: "proxy.example.test",
        port: 8080,
        deviceId: (await a.call("state")).deviceId,
        expectedNetworkVersion: 0,
        opaqueCredentials,
        usernameHint: credentials.username,
      },
    });
    assert.ok(proxy.proxy.id);
    const readProxy = async (device) => {
      const id = (await device.call("state")).deviceId;
      return device.call("api", {
        path: `/api/network-profiles/creators/${creatorId}/runtime?deviceId=${encodeURIComponent(id)}`,
      });
    };
    const decryptProxy = async (device) => {
      const runtime = await readProxy(device);
      return device.call("decrypt", {
        creatorId,
        purpose: "proxy-credentials",
        envelope: runtime.profile.proxy.opaqueCredentials,
      });
    };
    assert.deepEqual(await decryptProxy(b), credentials);
    let worker = await startDevice("desktop-manager");
    await worker.login("manager@example.test");
    await worker.key("ensureRegisteredIdentity");
    const managerApproval = await a.key("approveDevice", (await worker.call("state")).deviceId);
    check(
      managerApproval.targetIsOwner === false &&
        managerApproval.creatorWrapCount === 1 &&
        (await worker.key("status")).ownerWrap === null,
      "assigned manager receives a creator key without the agency root"
    );
    assert.equal((await worker.call("read", { creatorId })).revision, 4);
    assert.deepEqual(await decryptProxy(worker), credentials);

    await a.key("unlockOwnerRoot");
    const rootLoss = await b.fault({
      method: "POST",
      path: "/api/client-e2e-keyring/root-rotation/begin",
      phase: "after",
      action: "drop",
    });
    await assert.rejects(b.key("beginRootRotation"));
    await rootLoss.seen;
    const pendingRotation = await b.key("pendingRootRecovery");
    await b.stop();
    b = await startDevice("desktop-b");
    const rotated = await b.key("resumeRootRecovery");
    await b.key("acknowledgeRootRecovery", rotated.operationId);
    check(
      rotated.operationId === pendingRotation.operationId &&
        rotated.rootVersion === 2 &&
        posts("desktop-b", "/api/client-e2e-keyring/root-rotation/begin") === 1,
      "lost root rotation reply resumes the exact protected generation without rotating again"
    );
    const rotationPath = `/api/client-e2e-keyring/creators/${creatorId}/rotate`;
    const creatorLoss = await b.fault({ method: "POST", path: rotationPath, phase: "after", action: "drop" });
    await assert.rejects(b.key("strongRotateCreator", creatorId));
    await creatorLoss.seen;
    await b.stop();
    b = await startDevice("desktop-b");
    await b.call("bootstrap");
    const creatorRecovered = await b.key("strongRotateCreator", creatorId);
    check(
      creatorRecovered.activeKeyVersion === 2 && creatorRecovered.activeRootVersion === 2,
      "creator rotation journal recovers one key generation after committed reply loss"
    );
    await b.key("continueRootRotation");
    await b.key("finalizeRootRotation");
    assert.deepEqual(await decryptProxy(worker), credentials);
    check(
      (await worker.call("read", { creatorId })).payload.cookies.some((c) => c.value === "current-offline-b"),
      "root and creator rotation preserve the portable session and encrypted proxy for an approved manager"
    );
    pass("Separate owner and manager grants; durable root/creator rotation includes proxy credentials");
    const c = await startDevice("desktop-c");
    await c.login();
    await c.key("ensureRegisteredIdentity");
    let approvalError = null,
      readError = null;
    try {
      await a.key("approveDevice", (await c.call("state")).deviceId);
    } catch (error) {
      approvalError = error.code || error.message;
    }
    if (!approvalError) {
      try {
        await c.call("read", { creatorId });
      } catch (error) {
        readError = error.code || error.message;
      }
    }
    result.rootApproval = { approvalError, readError };
    check(
      !approvalError && !readError,
      "stale first Desktop approves with the current root after second Desktop rotation"
    );
    pass("Coherent approval after another Desktop changed the agency root");
    if (baseline && approvalError) {
      result.ok = false;
      return;
    }

    const revokedWorkerId = (await worker.call("state")).deviceId;
    const workerRevoke = await a.key("strongRevokeDevice", revokedWorkerId);
    check(
      workerRevoke.revoked && !workerRevoke.rootRotationRequired && workerRevoke.pendingCreatorIds.length === 0,
      "manager device revocation rotates creator secrets and settles exposure debt"
    );
    await assert.rejects(worker.call("read", { creatorId }), (e) => e.status === 403);
    await assert.rejects(decryptProxy(worker), (e) => e.status === 403 || /REVOKED/.test(e.code));
    assert.deepEqual(await decryptProxy(b), credentials);
    const cId = (await c.call("state")).deviceId;
    const ownerRevoke = await a.key("strongRevokeDevice", cId);
    check(
      ownerRevoke.revoked && ownerRevoke.rootRotationRequired,
      "revoked owner root is reported as rotation debt rather than completed erasure"
    );
    await assert.rejects(c.call("read", { creatorId }), (e) => e.status === 403);
    const replacementRoot = await b.key("beginRootRotation");
    await b.key("acknowledgeRootRecovery", replacementRoot.operationId);
    await b.key("continueRootRotation");
    await b.key("finalizeRootRotation");
    const debt = await a.key("deviceRevocationPlan", cId);
    check(
      !debt.rootRotationRequired && debt.affectedCreatorIds.length === 0,
      "surviving owner completes root rotation and clears revoked-device exposure debt"
    );
    assert.deepEqual(await decryptProxy(a), credentials);
    assert.ok((await b.call("read", { creatorId })).payload.cookies.some((c) => c.value === "current-offline-b"));
    pass("Manager and owner revocation preserve surviving devices and require the proper secret rotation");

    let d = await startDevice("desktop-auth");
    const loginIdentity = await d.call("state");
    const loginLoss = await d.fault({ method: "POST", path: "/api/auth/login", phase: "after", action: "drop" });
    await assert.rejects(d.login());
    await loginLoss.seen;
    await d.stop();
    d = await startDevice("desktop-auth");
    await d.login();
    check(
      (await d.call("state")).deviceId === loginIdentity.deviceId &&
        result.requests.some((r) => r.device === "desktop-auth" && r.code === "AUTHORIZATION_SESSION_COLLISION"),
      "login recovers an orphan committed response through the ordinary collision retry on the same device"
    );
    const authBefore = await d.call("state"),
      otherLineage = (await a.call("state")).authorizationSessionId;
    const refreshLoss = await d.fault({ method: "POST", path: "/api/auth/refresh", phase: "after", action: "drop" });
    const uncertainAuth = await d.call("auth", { refresh: true });
    await refreshLoss.seen;
    check(
      uncertainAuth.authenticated && uncertainAuth.accessHash === authBefore.accessHash,
      "transient refresh reply loss preserves the remembered session until a definitive rejection"
    );
    await d.stop();
    d = await startDevice("desktop-auth");
    const rejectedAuth = await d.call("auth", { refresh: true });
    check(
      !rejectedAuth.authenticated && (await a.call("auth")).authorizationSessionId === otherLineage,
      "refresh-token reuse terminates only the affected lineage; the other Desktop stays signed in"
    );
    await d.login();
    const replacementLogin = await d.call("state");
    check(
      replacementLogin.authenticated && replacementLogin.authorizationSessionId !== authBefore.authorizationSessionId,
      "normal login recovers a definitively rejected remembered session with a new lineage"
    );
    const lateRead = await d.fault({ method: "GET", path: "/api/auth/me", phase: "after", action: "hold" });
    const oldRead = d.call("api", { path: "/api/auth/me" }).then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    await lateRead.seen;
    await d.call("logout", { remote: false });
    await d.login();
    const newestLogin = await d.call("state");
    await lateRead.release();
    const lateResult = await oldRead;
    check(
      !!lateResult.error && (await d.call("state")).authorizationSessionId === newestLogin.authorizationSessionId,
      "late response from the previous login cannot publish into the replacement login"
    );
    pass("Remembered authentication, definitive refresh rejection and late response isolation");

    // PGlite provides one physical SQL session. Inspect receipts only after all
    // HTTP clients and Backend are stopped; this is not a PostgreSQL load proof.
    for (const device of [...devices.values()]) await device.stop();
    await stopBackend();
    const receiptId =
      "management_v1_" +
      load("./src/services/team-command-contract").digest(["device-agency", "owner", profileCommandId]);
    const receipt = await f.db.managementCommandReceipt.findMany({ where: { id: receiptId } });
    const audits = await f.db.auditLog.findMany({
      where: { agencyId: "device-agency", action: "management_command.committed" },
    });
    const commandAuditCount = audits.filter((x) => x.metadata?.commandId === profileCommandId).length;
    check(
      receipt.length === 1 && commandAuditCount === 1,
      "lost management reply left exactly one SQL receipt and one commit audit"
    );
    const rootState = await f.db.agencyCryptoRoot.findUnique({ where: { agencyId: "device-agency" } });
    const keyState = await f.db.creatorCryptoKeyState.findUnique({
      where: { agencyId_creatorId: { agencyId: "device-agency", creatorId } },
    });
    result.sql = {
      managementReceipts: receipt.length,
      managementAudits: commandAuditCount,
      rootVersion: rootState.version,
      creatorKeyVersion: keyState.activeVersion,
    };
    check(
      rootState.version === 3 && keyState.activeVersion === 4,
      "SQL generations account for exactly the requested rotations"
    );
    pass("Final SQL receipts and cryptographic generation accounting");
    result.ok = result.findings.length === 0;
  } finally {
    for (const d of devices.values()) await d.stop();
    if (backend) {
      backend.kill("SIGKILL");
      await backendExit;
    }
    await f.db.$disconnect();
    await wait(100);
    await f.close();
    fs.writeFileSync(
      path.join(output, baseline ? "baseline.json" : "result.json"),
      JSON.stringify(result, null, 2) + "\n"
    );
    fs.writeFileSync(path.join(output, "server.log"), log);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

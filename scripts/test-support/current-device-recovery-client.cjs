"use strict";
// A separate process per logical Desktop. All application services are bundled
// from current Desktop source; only native OS paths/key-store and transport
// fault injection belong to this fixture. No physical Electron or OF service.
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { createRequire } = require("node:module");
const directory = process.env.ONLINOD_DEVICE_PROOF_DIRECTORY;
const origin = process.env.ONLINOD_DEVICE_PROOF_ORIGIN;
const desktopLoad = createRequire(path.join(process.env.ONLINOD_DESKTOP_ROOT, "package.json"));
const electronId = desktopLoad.resolve("electron");
require.cache[electronId] = {
  id: electronId,
  filename: electronId,
  loaded: true,
  exports: { app: { getPath: (name) => (name === "temp" ? require("node:os").tmpdir() : directory) } },
};
const actual = require(process.env.ONLINOD_DEVICE_PROOF_BUNDLE);
const log = Object.fromEntries(
  ["debug", "info", "warn", "error"].map((level) => [
    level,
    (...args) => {
      process.send?.({ event: "log", level, message: String(args.at(-1) || "") });
    },
  ])
);
let fault = null;
const blocked = new Map();
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.origin !== origin) throw Error("EXTERNAL_IO_FORBIDDEN_IN_DEVICE_PROOF");
  const method = options.method || "GET";
  const selected = fault && (!fault.method || fault.method === method) && url.pathname === fault.path ? fault : null;
  if (selected) fault = null;
  const apply = async () => {
    process.send?.({ event: "fault", id: selected.id, method, path: url.pathname });
    if (selected.action === "drop")
      throw new TypeError("fetch failed", {
        cause: Object.assign(Error("Controlled transport interruption"), { code: "ECONNRESET" }),
      });
    if (selected.action === "hold") await new Promise((resolve) => blocked.set(selected.id, resolve));
  };
  if (selected?.phase === "before") await apply();
  const response = await originalFetch(input, options);
  const data = await response
    .clone()
    .json()
    .catch(() => null);
  process.send?.({ event: "request", method, path: url.pathname, status: response.status, code: data?.code });
  if (selected?.phase === "after") await apply();
  return response;
};
const store = actual.createAuthSessionStore();
const auth = actual.createBackendAuthService(store);
const api = new actual.BackendApiClient(store, auth);
const access = new actual.CreatorAccessRuntimeService({ log });
const creators = actual.createCreatorService(store, auth, api);
const authority = new actual.DesktopCurrentAuthorizationAuthorityService({
  log,
  authStore: store,
  accessRuntime: access,
});
const keyring = new actual.ClientE2eKeyringService(api, store, access);
const broker = new actual.CreatorSessionBrokerClient(api, keyring);
const outbox = new actual.CreatorSessionPublisherOutbox(log);
const events = [];
const publisher = new actual.CreatorSessionCanonicalPublisherService(log, api, {
  keyring,
  accessRuntime: access,
  outbox,
  getScopeKey: () => store.getAuthorizationScopeHash(),
  onCanonicalReady: (event) => {
    events.push(event);
    process.send?.({ event: "canonical", creatorId: event.creatorId, revision: event.revision });
  },
});
const management = new actual.ManagementCommandTransport(
  api,
  store,
  path.join(directory, "management-journal.json"),
  authority,
  () => creators.invalidateBootstrap()
);
store.onSessionChanged((change) => {
  if (!change.principalScopeChanged && !change.authorizationRevisionChanged) return;
  keyring.resetScope();
  access.resetScope();
  publisher.reset();
  creators.invalidateBootstrap();
});
async function refresh() {
  creators.invalidateBootstrap();
  const list = await creators.list();
  const proof = creators.getBootstrapAuthorization();
  if (!proof) throw Error("BOOTSTRAP_AUTHORITY_MISSING");
  access.replaceCatalog({
    accessEpoch: proof.accessEpoch,
    creatorCatalogGeneration: proof.creatorCatalogGeneration,
    creatorIds: proof.allowedCreatorIds,
  });
  authority.publish({ ...proof, observedAt: proof.observedAtMs, observedAtMono: proof.observedAtMono });
  return { creators: list.creators, proof: access.currentAuthorityProof(), deviceId: api.deviceId };
}
const sessionSummary = () => {
  const s = store.readSession();
  return {
    authenticated: !!s,
    deviceId: api.deviceId,
    incarnation: store.getAuthorizationScopeIncarnation(),
    authorizationSessionId: s?.authorizationSessionId,
    accessEpoch: s?.accessEpoch,
    accessHash: s ? crypto.createHash("sha256").update(s.accessToken).digest("hex") : null,
  };
};
const handlers = {
  fault: (input) => {
    fault = input;
    return true;
  },
  release: (input) => {
    blocked.get(input.id)?.();
    blocked.delete(input.id);
    return true;
  },
  login: async (input) => {
    await auth.login({ apiBase: origin, rememberDevice: true, ...input });
    await api.request("/api/devices/heartbeat", {
      method: "POST",
      body: { deviceId: api.deviceId, accounts: [], platform: "acceptance-node", deviceName: path.basename(directory) },
    });
    return refresh();
  },
  auth: async (input) => {
    if (input?.refresh) await auth.refreshSession();
    else await auth.ensureSession();
    return sessionSummary();
  },
  logout: async (input) => {
    await auth.logout(input || {});
    return sessionSummary();
  },
  state: () => ({ ...sessionSummary(), pending: outbox.list(store.getAuthorizationScopeHash()), events }),
  bootstrap: refresh,
  api: (input) => api.request(input.path, input.options),
  keyring: (input) => {
    const allowed = new Set([
      "ensureRegisteredIdentity",
      "initializeAgencyRoot",
      "pendingRootRecovery",
      "resumeRootRecovery",
      "acknowledgeRootRecovery",
      "unlockOwnerRoot",
      "status",
      "approveDevice",
      "recoverOwnerRoot",
      "ensureCreatorEncryptionReady",
      "beginRootRotation",
      "continueRootRotation",
      "finalizeRootRotation",
      "rootRotationProgress",
      "strongRotateCreator",
      "softRevokeDevice",
      "strongRevokeDevice",
      "deviceRevocationPlan",
      "retireLocalDeviceIdentity",
      "syncGrantedAccess",
    ]);
    if (!allowed.has(input.method)) throw Error("UNSUPPORTED_KEYRING_PROOF_OPERATION");
    return keyring[input.method](...(input.args || []));
  },
  manage: async (input) => {
    await refresh();
    const result = await management.execute(input.action, input.targetId || "", input.payload);
    if (input.ack !== false) management.acknowledge(result.commandId);
    return result;
  },
  managementPending: () => management.listPending(),
  managementRecover: async (input) => {
    await refresh();
    return management.retry(input.commandId);
  },
  managementAck: (input) => {
    management.acknowledge(input.commandId);
    return true;
  },
  publish: async (input) => {
    await refresh();
    publisher.capture(input.snapshot);
    return true;
  },
  resume: async () => {
    await refresh();
    publisher.resumeDurable();
    return true;
  },
  read: (input) => broker.read(input.creatorId, input.includePayload !== false),
  encrypt: (input) => keyring.encryptForCreator(input.creatorId, input.purpose, input.value),
  decrypt: (input) => keyring.decryptForCreator(input.creatorId, input.purpose, input.envelope),
};
process.on("message", async (message) => {
  try {
    if (!handlers[message.method]) throw Error("UNSUPPORTED_DEVICE_PROOF_OPERATION");
    const value = await handlers[message.method](message.input);
    process.send?.({ id: message.id, ok: true, value: value === undefined ? null : value });
  } catch (error) {
    process.send?.({
      id: message.id,
      ok: false,
      error: { code: error.code || error.name, message: error.message, status: error.status },
    });
  }
});
process.send?.({ event: "ready", pid: process.pid, ...sessionSummary() });

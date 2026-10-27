"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { setImmediate } = require("node:timers");
const { startConversationStores } = require("./lifecycle");
const turn = () => new Promise(setImmediate);
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function fixture(overrides = {}) {
  const calls = [],
    timers = new Set();
  let dispose;
  const stores = {
    db: Object.fromEntries(
      ["dialogs", "crm"].map((domain) => [
        domain,
        {
          $disconnect: async () => {
            calls.push("close:" + domain);
          },
        },
      ])
    ),
    check: async (domain) => {
      calls.push("check:" + domain);
    },
    pump: async () => {
      calls.push("pump");
    },
    ...overrides,
  };
  startConversationStores({
    stores,
    own(name, stop) {
      calls.push("own:" + name);
      dispose = stop;
    },
    log: { info: (...a) => calls.push(a), warn: (...a) => calls.push(a) },
    schedule(fn, ms) {
      const timer = { fn, ms };
      timers.add(timer);
      return timer;
    },
    cancel: (timer) => timers.delete(timer),
  });
  return {
    calls,
    timers,
    stop: () => dispose(),
    next() {
      const timer = [...timers][0];
      timers.delete(timer);
      timer.fn();
      return timer.ms;
    },
  };
}
test("CRM outage leaves startup synchronous, logs the failing domain and recovers with bounded retry", async () => {
  let unavailable = true,
    pumped = 0;
  const f = fixture({
    check: async (domain) => {
      if (domain === "crm" && unavailable) throw Object.assign(Error(), { code: "TEST_UNAVAILABLE" });
    },
    pump: async () => {
      pumped++;
    },
  });
  assert.equal(f.calls[0], "own:conversation-stores");
  await turn();
  assert.equal(pumped, 0);
  assert.ok(f.calls.some((x) => Array.isArray(x) && x[1].domain === "crm" && x[1].code === "TEST_UNAVAILABLE"));
  assert.equal([...f.timers][0].ms, 30000);
  unavailable = false;
  f.next();
  await turn();
  assert.equal(pumped, 1);
  assert.equal([...f.timers][0].ms, 5000);
  await f.stop();
  assert.equal(f.timers.size, 0);
  assert.equal(
    f.calls.some((x) => typeof x === "string" && x.startsWith("close:")),
    false
  );
});
test("shutdown joins in-flight relay before disconnecting either database and never rearms it", async () => {
  const work = deferred();
  let pumped = 0;
  const f = fixture({
    pump: async () => {
      pumped++;
      await work.promise;
    },
  });
  await turn();
  assert.equal(pumped, 1);
  assert.equal(f.timers.size, 0);
  const closing = f.stop();
  assert.equal(f.stop(), closing);
  await turn();
  assert.equal(f.calls.includes("close:dialogs"), false);
  work.resolve();
  await closing;
  assert.equal(f.timers.size, 0);
  assert.equal(f.calls.filter((x) => x === "close:dialogs").length, 0);
});
test("shutdown during database readiness never starts the relay afterwards", async () => {
  const readiness = deferred();
  let pumped = 0;
  const f = fixture({
    check: async () => readiness.promise,
    pump: async () => {
      pumped++;
    },
  });
  const stopping = f.stop();
  await turn();
  assert.equal(f.calls.includes("close:crm"), false);
  readiness.resolve();
  await stopping;
  assert.equal(pumped, 0);
  assert.equal(f.timers.size, 0);
});

test("process shutdown drains both HTTP and relay before disconnecting lazily-created conversation databases", async () => {
  const { EventEmitter } = require("node:events");
  const { createBackendProcessLifecycle } = require("../backend-process-lifecycle");
  const { databaseShutdownPort } = require("./databases");
  const http = deferred(),
    relay = deferred(),
    calls = [];
  const client = (name) => ({
    $disconnect: async () => {
      calls.push(name);
    },
  });
  let databases;
  const log = { info() {}, warn() {}, error() {} };
  const processPort = Object.assign(new EventEmitter(), { exit: (code) => calls.push(`exit:${code}`) });
  const lifecycle = createBackendProcessLifecycle({
    db: databaseShutdownPort(client("product"), () => databases),
    log,
    processPort,
  });
  await lifecycle.start(async ({ own }) => {
    databases = { dialogs: client("dialogs"), crm: client("crm") };
    startConversationStores({ stores: { db: databases, check: async () => {}, pump: () => relay.promise }, own, log });
    own("http", () => http.promise);
  });
  await turn();
  const stopping = lifecycle.stop("test");
  relay.resolve();
  await turn();
  assert.deepEqual(calls, []);
  http.resolve();
  await stopping;
  assert.deepEqual(calls.sort(), ["crm", "dialogs", "exit:0", "product"]);
});
test("database cleanup joins all disconnects even when one client rejects", async () => {
  const { databaseShutdownPort } = require("./databases");
  const pending = deferred();
  let ended = false;
  const port = databaseShutdownPort(
    {
      $disconnect: async () => {
        throw Error("DISCONNECT_FAILED");
      },
    },
    () => ({
      dialogs: {
        $disconnect: async () => {
          await pending.promise;
          ended = true;
        },
      },
    })
  );
  let settled = false;
  const result = port.$disconnect().catch((error) => {
    settled = true;
    return error;
  });
  await turn();
  assert.equal(settled, false);
  pending.resolve();
  assert.equal((await result).message, "DISCONNECT_FAILED");
  assert.equal(ended, true);
});

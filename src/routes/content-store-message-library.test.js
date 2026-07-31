"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function createRouter() {
  const routes = [];
  const router = { routes };
  for (const method of ["get", "post", "put", "patch", "delete"]) {
    router[method] = (path, ...handlers) => {
      routes.push({ method: method.toUpperCase(), path, handler: handlers.at(-1) });
      return router;
    };
  }
  return router;
}

function loadRoute(db) {
  const router = createRouter();
  const originalLoad = Module._load;
  const routePath = require.resolve("./content-store");
  delete require.cache[routePath];
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "express") return { Router: () => router };
    if (request === "../prisma" && parent?.filename === routePath) return db;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    require(routePath);
  } finally {
    Module._load = originalLoad;
  }
  return {
    route(method, path) {
      const item = router.routes.find((entry) => entry.method === method && entry.path === path);
      assert.ok(item, `${method} ${path} is missing`);
      return item.handler;
    },
  };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

function auth() {
  return { agencyId: "agency-1", userId: "user-1", role: "OWNER" };
}

function baseDb() {
  return {
    creatorAccount: { findFirst: async () => ({ id: "creator-1" }) },
    contentBlock: { deleteMany: async () => ({ count: 0 }) },
    contentUsageEvent: { findMany: async () => [], create: async ({ data }) => ({ id: "event-1", ...data }) },
    contentCollection: {
      findMany: async () => [],
      count: async () => 0,
      findFirst: async () => null,
      deleteMany: async () => ({ count: 0 }),
      delete: async () => ({}),
    },
    $transaction: async (fn) => fn({}),
  };
}

test("script listing returns lockedText and authoritative pagination", async () => {
  const db = baseDb();
  db.contentCollection.findMany = async (args) => {
    if (args?.include?.blocks) {
      return [{
        id: "server-script-1", clientId: "script-1", agencyId: "agency-1", creatorId: "creator-1",
        title: "Flow", status: "active", tags: [" sales ", "sales", ""], metadata: {}, deletedAt: null,
        blocks: [{ id: "server-block-1", clientId: "block-1", order: 0, text: "hello", lockedText: true, media: [{ id: "media-1", type: "photo", raw: { id: "media-1", token: "secret", accessToken: "secret-2", nested: { cookie: "drop", passwordHash: "drop-2", safe: "keep" } } }], metadata: {}, status: "active" }],
      }];
    }
    return [];
  };
  db.contentCollection.count = async () => 12;
  const api = loadRoute(db);
  const res = response();
  await api.route("GET", "/message-library/scripts")({ auth: auth(), query: { creatorId: "creator-1", limit: "5", offset: "5" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.count, 12);
  assert.equal(res.body.nextOffset, 6);
  assert.equal(res.body.hasMore, true);
  assert.equal(res.body.items[0].messages[0].lockedText, true);
  assert.deepEqual(res.body.items[0].tags, ["sales"]);
  assert.equal(res.body.items[0].messages[0].media[0].raw.token, undefined);
  assert.equal(res.body.items[0].messages[0].media[0].raw.accessToken, undefined);
  assert.equal(res.body.items[0].messages[0].media[0].raw.nested.cookie, undefined);
  assert.equal(res.body.items[0].messages[0].media[0].raw.nested.passwordHash, undefined);
  assert.equal(res.body.items[0].messages[0].media[0].raw.nested.safe, "keep");
});

test("script update preserves original author and exact message whitespace", async () => {
  const db = baseDb();
  const existing = { id: "server-script-1", clientId: "script-1", creatorId: "creator-1", blocks: [] };
  db.contentCollection.findFirst = async () => existing;
  let collectionUpdate = null;
  let blockCreate = null;
  db.$transaction = async (fn) => fn({
    contentCollection: {
      update: async ({ data }) => { collectionUpdate = data; return { ...existing, ...data }; },
      create: async ({ data }) => ({ id: "server-script-1", ...data }),
      findFirst: async () => ({
        id: "server-script-1", clientId: "script-1", creatorId: "creator-1", title: "Flow", status: "active", tags: [], metadata: {}, deletedAt: null,
        blocks: [{ id: "server-block-1", clientId: "block-1", order: 0, text: blockCreate.text, lockedText: false, media: [], metadata: {}, status: "active" }],
      }),
    },
    contentBlock: {
      updateMany: async () => ({ count: 0 }),
      update: async () => ({}),
      create: async ({ data }) => { blockCreate = data; return data; },
    },
  });
  const api = loadRoute(db);
  const res = response();
  await api.route("PUT", "/message-library/scripts/:id")({
    auth: auth(), query: {}, params: { id: "script-1" },
    body: { creatorId: "creator-1", title: "Flow", messages: [{ id: "block-1", text: "  first line\nsecond line  " }] },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal("createdByUserId" in collectionUpdate, false);
  assert.equal(blockCreate.text, "  first line\nsecond line  ");
  assert.equal(res.body.item.messages[0].text, "  first line\nsecond line  ");
});

test("duplicate block ids are rejected before a transaction mutates data", async () => {
  const db = baseDb();
  let transactionCalled = false;
  db.$transaction = async () => { transactionCalled = true; };
  const api = loadRoute(db);
  const res = response();
  await api.route("PUT", "/message-library/scripts/:id")({
    auth: auth(), query: {}, params: { id: "script-1" },
    body: { creatorId: "creator-1", title: "Flow", messages: [{ id: "same", text: "a" }, { id: "same", text: "b" }] },
  }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "MESSAGE_LIBRARY_BLOCK_ID_DUPLICATE");
  assert.equal(transactionCalled, false);
});

test("usage attribution is creator-bound and stores only the safe metadata allowlist", async () => {
  const db = baseDb();
  db.contentCollection.findFirst = async () => ({
    id: "server-script-1", creatorId: "creator-1",
    blocks: [{ id: "server-block-1", clientId: "block-1" }],
  });
  let created = null;
  db.contentUsageEvent.create = async ({ data }) => { created = data; return { id: "event-1", ...data }; };
  const api = loadRoute(db);
  const res = response();
  await api.route("POST", "/message-library/usage")({
    auth: auth(), query: {},
    body: {
      creatorId: "creator-1", scriptId: "script-1", messageId: "block-1", dialogId: "dialog-1",
      eventType: "draft_inserted", text: "secret", rawEvent: { conversation: "secret" },
      metadata: { mediaCount: 2, price: 15, currency: "USD", lockedText: true, text: "secret", arbitrary: "drop me" },
    },
  }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(created.collectionId, "server-script-1");
  assert.equal(created.blockId, "server-block-1");
  assert.deepEqual(Object.keys(created.metadata).sort(), ["amount", "currency", "draftId", "lockedText", "mediaCount", "messageId", "price", "realMessageId", "scriptId", "source"].sort());
  assert.equal(JSON.stringify(created.metadata).includes("secret"), false);
});

test("permanent deletion refuses an active script", async () => {
  const db = baseDb();
  let findWhere = null;
  db.contentCollection.findFirst = async ({ where }) => {
    findWhere = where;
    return {
      id: "server-script-1", clientId: "script-1", creatorId: "creator-1", title: "Flow", status: "active", deletedAt: null, tags: [], metadata: {}, blocks: [],
    };
  };
  let deleted = false;
  db.contentCollection.delete = async () => { deleted = true; };
  const api = loadRoute(db);
  const res = response();
  await api.route("DELETE", "/message-library/scripts/:id/permanent")({ auth: auth(), query: { creatorId: "creator-1" }, params: { id: "script-1" }, body: {} }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "MESSAGE_LIBRARY_SCRIPT_NOT_TRASHED");
  assert.equal(findWhere.creatorId, "creator-1");
  assert.equal(deleted, false);
});

test("script id collisions cannot move a script to another creator", async () => {
  const db = baseDb();
  db.creatorAccount.findFirst = async ({ where }) => ({ id: where.id });
  db.contentCollection.findFirst = async () => ({
    id: "server-script-1", clientId: "script-1", creatorId: "creator-a", blocks: [],
  });
  let transactionCalled = false;
  db.$transaction = async () => { transactionCalled = true; };
  const api = loadRoute(db);
  const res = response();
  await api.route("PUT", "/message-library/scripts/:id")({
    auth: auth(), query: {}, params: { id: "script-1" },
    body: { creatorId: "creator-b", title: "Wrong creator", messages: [] },
  }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "MESSAGE_LIBRARY_SCRIPT_CREATOR_MISMATCH");
  assert.equal(transactionCalled, false);
});

test("message-library listing and destructive actions require an explicit creatorId", async () => {
  const db = baseDb();
  let collectionLookup = false;
  db.contentCollection.findFirst = async () => { collectionLookup = true; return null; };
  const api = loadRoute(db);

  const listRes = response();
  await api.route("GET", "/message-library/scripts")({ auth: auth(), query: {}, body: {} }, listRes);
  assert.equal(listRes.statusCode, 400);
  assert.equal(listRes.body.code, "CREATOR_ID_MISSING");

  const deleteRes = response();
  await api.route("DELETE", "/message-library/scripts/:id")({ auth: auth(), query: {}, body: {}, params: { id: "script-1" } }, deleteRes);
  assert.equal(deleteRes.statusCode, 400);
  assert.equal(deleteRes.body.code, "CREATOR_ID_MISSING");
  assert.equal(collectionLookup, false);
});

test("message block actions are creator-bound before looking up the script", async () => {
  const db = baseDb();
  db.creatorAccount.findFirst = async ({ where }) => ({ id: where.id });
  let findWhere = null;
  db.contentCollection.findFirst = async ({ where }) => { findWhere = where; return null; };
  const api = loadRoute(db);
  const res = response();
  await api.route("DELETE", "/message-library/scripts/:scriptId/messages/:messageId")({
    auth: auth(), query: { creatorId: "creator-b" }, body: {}, params: { scriptId: "script-1", messageId: "message-1" },
  }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(findWhere.creatorId, "creator-b");
});

test("media raw sanitization drops prototype mutation keys", async () => {
  const db = baseDb();
  const dangerousRaw = JSON.parse('{"id":"media-1","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"safe":"keep"}');
  db.contentCollection.findMany = async () => [{
    id: "server-script-1", clientId: "script-1", agencyId: "agency-1", creatorId: "creator-1",
    title: "Flow", status: "active", tags: [], metadata: {}, deletedAt: null,
    blocks: [{ id: "server-block-1", clientId: "block-1", order: 0, text: "hello", lockedText: false, media: [{ id: "media-1", raw: dangerousRaw }], metadata: {}, status: "active" }],
  }];
  db.contentCollection.count = async () => 1;
  const api = loadRoute(db);
  const res = response();
  await api.route("GET", "/message-library/scripts")({ auth: auth(), query: { creatorId: "creator-1" }, body: {} }, res);
  assert.equal(res.statusCode, 200);
  const raw = res.body.items[0].messages[0].media[0].raw;
  assert.equal(Object.prototype.hasOwnProperty.call(raw, "__proto__"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(raw, "constructor"), false);
  assert.equal(raw.safe, "keep");
  assert.equal({}.polluted, undefined);
});


test("automatic expired-trash cleanup is throttled per agency while manual purge remains forceable", async () => {
  const db = baseDb();
  let purgeCollectionScans = 0;
  db.contentCollection.findMany = async (args) => {
    if (args?.select?.id === true && args?.take === 10000) {
      purgeCollectionScans += 1;
      return [];
    }
    return [];
  };
  db.contentCollection.count = async () => 0;
  const api = loadRoute(db);

  const first = response();
  await api.route("GET", "/message-library/scripts")({ auth: auth(), query: { creatorId: "creator-1" }, body: {} }, first);
  assert.equal(first.statusCode, 200);
  assert.equal(purgeCollectionScans, 2);

  const second = response();
  await api.route("GET", "/message-library/scripts")({ auth: auth(), query: { creatorId: "creator-1" }, body: {} }, second);
  assert.equal(second.statusCode, 200);
  assert.equal(purgeCollectionScans, 2, "a frequent list refresh must not rescan all agency trash");

  const manual = response();
  await api.route("POST", "/message-library/purge-expired")({ auth: auth(), query: {}, body: {} }, manual);
  assert.equal(manual.statusCode, 200);
  assert.equal(purgeCollectionScans, 4, "manual manager purge must bypass the read throttle");
});


test("a transient automatic purge failure does not make script listing unavailable", async () => {
  const db = baseDb();
  let firstPurgeQuery = true;
  db.contentCollection.findMany = async (args) => {
    if (args?.select?.id === true && firstPurgeQuery) {
      firstPurgeQuery = false;
      throw new Error("temporary cleanup failure");
    }
    if (args?.include?.blocks) return [];
    return [];
  };
  db.contentCollection.count = async () => 0;
  const api = loadRoute(db);
  const res = response();
  await api.route("GET", "/message-library/scripts")({ auth: auth(), query: { creatorId: "creator-1" }, body: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.items, []);
});

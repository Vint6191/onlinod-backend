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
  const priorFind = db.contentCollection.findFirst;
  db.contentCollection.findFirst = async args => { const row = await priorFind(args); return row && {agencyId:"agency-1",kind:"message_library_script",status:"active",updatedAt:new Date("2026-01-01"),...row}; };
  const priorTx = db.$transaction;
  db.$transaction = fn => priorTx(tx => fn({...db,...tx,contentCollection:{...db.contentCollection,...tx.contentCollection}}));

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
  return {
    agencyId: "agency-1",
    userId: "user-1",
    deviceId: "device-1",
    role: "OWNER",
    membership: { id: "member-1", agencyId: "agency-1", role: "OWNER", roleKey: "owner", accessEpoch: 1, assignedCreators: "all", permissions: {} },
  };
}

function baseDb() {
  return {
    $executeRawUnsafe: async () => 1,
    $queryRawUnsafe: async (sql, id) => sql.includes("clock_timestamp") ? [{authorityNow:new Date("2026-09-24T00:00:00Z")}] : sql.includes('FROM "Agency"') ? [{id,deletedAt:null,status:"ACTIVE"}] : [{id}],
    agencyMember: {findFirst: async () => ({...auth().membership,userId:"user-1"})},
    auditLog: {create: async ({data}) => data},
    creatorAccount: { findFirst: async () => ({ id: "creator-1" }) },
    creatorMediaAsset: { findMany: async () => [] },
    customContentSubmission: { findMany: async () => [] },
    contentBlock: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
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
    $executeRawUnsafe: async (sql, payload) => { if(sql.includes('INSERT INTO "ContentBlock"')) blockCreate=JSON.parse(payload)[0]; return 1; },
    contentCollection: {
      update: async ({ data }) => { collectionUpdate = data; return { ...existing, ...data }; },
      create: async ({ data }) => ({ id: "server-script-1", ...data }),
      findFirst: async () => !blockCreate ? {...existing,agencyId:"agency-1",kind:"message_library_script",status:"active",updatedAt:new Date("2026-01-01")} : ({
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
    body: { creatorId: "creator-1", serverId:"server-script-1", updatedAt:"2026-01-01T00:00:00.000Z", title: "Flow", messages: [{ id: "block-1", text: "  first line\nsecond line  " }] },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal("createdByUserId" in collectionUpdate, false);
  assert.equal(blockCreate.text, "  first line\nsecond line  ");
  assert.equal(res.body.item.messages[0].text, "  first line\nsecond line  ");
});

test("reusable Message Library scripts reject canonical CUSTOM media before any transaction", async () => {
  const db = baseDb();
  db.creatorMediaAsset.findMany = async () => [{ mediaId: "9001", customOrderId: "custom-1", customSubmissionId: "submission-1" }];
  let transactionCalled = false;
  db.$transaction = async () => { transactionCalled = true; };
  const api = loadRoute(db);
  const res = response();
  await api.route("PUT", "/message-library/scripts/:id")({
    auth: auth(), query: {}, params: { id: "script-1" },
    body: {
      creatorId: "creator-1", title: "Reusable flow",
      messages: [{ id: "block-1", text: "hello", media: [{ id: "9001", type: "video" }] }],
    },
  }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "MESSAGE_LIBRARY_CUSTOM_MEDIA_FORBIDDEN");
  assert.equal(transactionCalled, false);
});

test("Message Library provenance classification exhaustively crosses the 200-id transport batch boundary", async () => {
  const db = baseDb();
  let assetReads = 0;
  db.creatorMediaAsset.findMany = async ({ where }) => {
    assetReads += 1;
    const ids = Array.isArray(where?.mediaId?.in) ? where.mediaId.in.map(String) : [];
    return ids.includes("205") ? [{ mediaId: "205", customOrderId: "custom-205", customSubmissionId: "submission-205" }] : [];
  };
  let transactionCalled = false;
  db.$transaction = async () => { transactionCalled = true; };
  const api = loadRoute(db);
  const res = response();
  const ids = Array.from({ length: 205 }, (_, index) => String(index + 1));
  const messages = [0, 1, 2].map((blockIndex) => ({
    id: `block-${blockIndex + 1}`,
    text: `block ${blockIndex + 1}`,
    media: ids.slice(blockIndex * 100, (blockIndex + 1) * 100).map((id) => ({ id, type: "photo" })),
  }));
  await api.route("PUT", "/message-library/scripts/:id")({
    auth: auth(), query: {}, params: { id: "script-large" },
    body: { creatorId: "creator-1", title: "Large reusable flow", messages },
  }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "MESSAGE_LIBRARY_CUSTOM_MEDIA_FORBIDDEN");
  assert.equal(assetReads, 2);
  assert.equal(transactionCalled, false);
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
  assert.deepEqual(Object.keys(created.metadata).sort(), ["product", "amount", "currency", "draftId", "lockedText", "mediaCount", "messageId", "price", "realMessageId", "scriptId", "source"].sort());
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
  assert.equal(findWhere.agencyId, "agency-1");
  assert.equal(deleted, false);
});

test("script id collisions cannot move a script to another creator", async () => {
  const db = baseDb();
  db.creatorAccount.findFirst = async ({ where }) => ({ id: where.id });
  db.contentCollection.findFirst = async () => ({
    id: "server-script-1", clientId: "script-1", creatorId: "creator-a", blocks: [],
  });
  let transactionCalled = false;
  db.$transaction = async fn => { transactionCalled = true; return fn({}); };
  const api = loadRoute(db);
  const res = response();
  await api.route("PUT", "/message-library/scripts/:id")({
    auth: auth(), query: {}, params: { id: "script-1" },
    body: { creatorId: "creator-b", title: "Wrong creator", messages: [] },
  }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "MESSAGE_LIBRARY_SCRIPT_CREATOR_MISMATCH");
  assert.equal(transactionCalled, true);
});

test("message-library usage listing and manual purge require an explicit creatorId", async () => {
  const db = baseDb();
  const api = loadRoute(db);

  const usageRes = response();
  await api.route("GET", "/message-library/usage")({ auth: auth(), query: {}, body: {} }, usageRes);
  assert.equal(usageRes.statusCode, 400);
  assert.equal(usageRes.body.code, "CREATOR_ID_MISSING");

  const purgeRes = response();
  await api.route("POST", "/message-library/purge-expired")({ auth: auth(), query: {}, body: {} }, purgeRes);
  assert.equal(purgeRes.statusCode, 400);
  assert.equal(purgeRes.body.code, "CREATOR_ID_MISSING");
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
  assert.equal(findWhere.agencyId, "agency-1");
  assert.equal(findWhere.clientId, "script-1");
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


test("listing is read-only and manual cleanup uses bounded selections", async () => {
  const db=baseDb();let scans=0;
  db.contentCollection.findMany=async args=>{if(args.select?.id){scans++;assert.ok(args.take<=10);}return [];};
  const api=loadRoute(db),first=response();
  await api.route("GET","/message-library/scripts")({auth:auth(),query:{creatorId:"creator-1"}},first);
  assert.equal(first.statusCode,200);assert.equal(scans,0);
  const manual=response();await api.route("POST","/message-library/purge-expired")({auth:auth(),query:{},body:{creatorId:"creator-1"}},manual);
  assert.equal(manual.statusCode,200);assert.equal(scans,1);
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

test("a new Desktop draft with a local updatedAt is created without a false revision conflict",async()=>{
 const db=baseDb();let saved=null;db.contentCollection.findFirst=async()=>saved;
 db.contentCollection.create=async({data})=>{saved={id:"new-server-id",...data,updatedAt:new Date("2026-09-24"),blocks:[]};return saved;};
 const api=loadRoute(db),res=response();await api.route("PUT","/message-library/scripts/:id")({auth:auth(),query:{},params:{id:"new-script"},body:{creatorId:"creator-1",serverId:null,updatedAt:"2026-09-23T18:30:00Z",messages:[]}},res);
 assert.equal(res.statusCode,200);assert.equal(res.body.item.serverId,"new-server-id");
});
for(const state of ["trash","deleting"])test(`ordinary save cannot resurrect ${state} script`,async()=>{
 const db=baseDb();let writes=0;db.contentCollection.findFirst=async()=>({id:"server-script-1",clientId:"script-1",creatorId:"creator-1",status:state,deletedAt:new Date("2026-01-01"),updatedAt:new Date("2026-01-01")});db.contentCollection.update=async()=>{writes++;};
 const api=loadRoute(db),res=response();await api.route("PUT","/message-library/scripts/:id")({auth:auth(),query:{},params:{id:"script-1"},body:{creatorId:"creator-1",serverId:"server-script-1",updatedAt:"2026-01-01T00:00:00Z",status:"active",trashedAt:null,messages:[]}},res);
 assert.equal(res.statusCode,409);assert.equal(writes,0);
});
test("a stale Desktop revision fails before changing collection or messages",async()=>{
 const db=baseDb();let writes=0;db.contentCollection.findFirst=async()=>({id:"server-script-1",clientId:"script-1",creatorId:"creator-1",updatedAt:new Date("2026-02-01")});db.contentCollection.update=async()=>{writes++;};
 const api=loadRoute(db),res=response();await api.route("PUT","/message-library/scripts/:id")({auth:auth(),query:{},params:{id:"script-1"},body:{creatorId:"creator-1",serverId:"server-script-1",updatedAt:"2026-01-01T00:00:00Z",messages:[]}},res);
 assert.equal(res.statusCode,409);assert.equal(res.body.code,"MESSAGE_LIBRARY_REVISION_CONFLICT");assert.equal(writes,0);
});

for (const present of [true, false]) test(`serverId without its shown revision cannot bypass save concurrency checks (existing=${present})`,async()=>{
 const db=baseDb();let writes=0;db.contentCollection.findFirst=async()=>present?{id:"server-script-1",clientId:"script-1",creatorId:"creator-1",updatedAt:new Date("2026-01-01")}:null;
 db.contentCollection.update=async()=>{writes++;};db.contentCollection.create=async()=>{writes++;};
 const api=loadRoute(db),res=response();await api.route("PUT","/message-library/scripts/:id")({auth:auth(),query:{},params:{id:"script-1"},body:{creatorId:"creator-1",serverId:"server-script-1",messages:[]}},res);
 assert.equal(res.statusCode,428);assert.equal(res.body.code,"MESSAGE_LIBRARY_REVISION_REQUIRED");assert.equal(writes,0);
});
test("a server identity from another script cannot be reused even with the current timestamp",async()=>{
 const db=baseDb();let writes=0;db.contentCollection.findFirst=async()=>({id:"server-script-1",clientId:"script-1",creatorId:"creator-1",updatedAt:new Date("2026-01-01")});db.contentCollection.update=async()=>{writes++;};
 const api=loadRoute(db),res=response();await api.route("PUT","/message-library/scripts/:id")({auth:auth(),query:{},params:{id:"script-1"},body:{creatorId:"creator-1",serverId:"another-script",updatedAt:"2026-01-01T00:00:00Z",messages:[]}},res);
 assert.equal(res.statusCode,409);assert.equal(res.body.code,"MESSAGE_LIBRARY_REVISION_CONFLICT");assert.equal(writes,0);
});

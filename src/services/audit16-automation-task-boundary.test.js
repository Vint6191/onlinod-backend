"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

function routeRecorder() {
  const routes = [];
  const router = {};
  for (const method of ["get", "post", "patch", "delete"]) {
    router[method] = (routePath, ...handlers) => routes.push({ method, path: routePath, handlers });
  }
  return { router, routes };
}

function routeHandler(routes, method, routePath) {
  const route = routes.find((item) => item.method === method && item.path === routePath);
  assert.ok(route, `${method.toUpperCase()} ${routePath} must be registered`);
  return route.handlers.at(-1);
}

function routeDeps(overrides = {}) {
  return {
    automationServer: {},
    cleanString(value, max = 100) { return String(value ?? "").trim().slice(0, max); },
    async requireAutomationCreatorAccess() {},
    requireSeniorAutomationWriter(_req, _res, next) { next?.(); },
    sendError(res, err, fallback) {
      return res.status(Number(err?.status || 500)).json({ ok: false, code: err?.code || fallback, error: err?.message || "failed" });
    },
    ...overrides,
  };
}

test("Audit16 generic AutomationTask customer API is an authenticated 410 tombstone", async () => {
  const { registerCoreRoutes } = require("../routes/automation/core-routes");
  const { router, routes } = routeRecorder();
  registerCoreRoutes(router, routeDeps());
  const expected = [
    ["get", "/tasks"],
    ["post", "/tasks"],
    ["patch", "/tasks/:id"],
    ["post", "/tasks/:id/trash"],
    ["post", "/tasks/:id/restore"],
    ["delete", "/tasks/:id"],
  ];
  for (const [method, routePath] of expected) {
    const res = responseRecorder();
    await routeHandler(routes, method, routePath)({}, res);
    assert.equal(res.statusCode, 410);
    assert.equal(res.payload?.code, "LEGACY_AUTOMATION_TASK_API_GONE");
  }
});

test("Audit16 Bumps and SFS fail closed when creator aliases disagree", async () => {
  for (const [modulePath, registerName, routePath, method, serviceName] of [
    ["../routes/automation/bumps-routes", "registerBumpRoutes", "/bumps/upsert", "post", "saveBump"],
    ["../routes/automation/sfs-routes", "registerSfsRoutes", "/sfs-comments/upsert", "post", "saveSfsComment"],
  ]) {
    const mod = require(modulePath);
    const { router, routes } = routeRecorder();
    let serviceCalls = 0;
    const deps = routeDeps({ automationServer: { async [serviceName]() { serviceCalls += 1; return { ok: true }; } } });
    mod[registerName](router, deps);
    const res = responseRecorder();
    await routeHandler(routes, method, routePath)({
      params: {},
      query: {},
      body: { accountId: "creator-a", creatorId: "creator-b", commentText: "hello" },
      auth: { agencyId: "agency-1", userId: "user-1" },
    }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.payload?.code, "CREATOR_IDENTITY_MISMATCH");
    assert.equal(serviceCalls, 0, `${serviceName} must not run after identity mismatch`);
  }
});

test("Audit16 normal Desktop creator aliases remain accepted and canonical", async () => {
  const { registerBumpRoutes } = require("../routes/automation/bumps-routes");
  const { router, routes } = routeRecorder();
  let saved = null;
  registerBumpRoutes(router, routeDeps({
    automationServer: {
      async saveBump(input) { saved = input; return { ok: true }; },
      async listBumps() { return { ok: true, items: [] }; },
    },
  }));
  const res = responseRecorder();
  await routeHandler(routes, "post", "/bumps/upsert")({
    params: {},
    query: {},
    body: { accountId: "creator-a", creatorId: "creator-a", messageText: "hello" },
    auth: { agencyId: "agency-1", userId: "user-1" },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(saved?.accountId, "creator-a");
  assert.equal(saved?.input?.creatorId, "creator-a");
  assert.equal(saved?.input?.accountId, "creator-a");
});

function matches(row, where = {}) {
  if (where.OR) {
    const ok = where.OR.some((part) => matches(row, part));
    if (!ok) return false;
  }
  for (const [key, value] of Object.entries(where)) {
    if (key === "OR") continue;
    if (value && typeof value === "object" && !Array.isArray(value)) continue;
    if (row[key] !== value) return false;
  }
  return true;
}

function taskDb(initialTasks) {
  const tasks = initialTasks.map((row) => ({ ...row }));
  const creatorAccount = {
    async findFirst({ where }) {
      if (where.agencyId !== "agency-1" || !["creator-a", "creator-b"].includes(where.id)) return null;
      return { id: where.id, agencyId: where.agencyId, deletedAt: null };
    },
  };
  const automationTask = {
    async findFirst({ where, select } = {}) {
      const row = tasks.find((item) => matches(item, where));
      if (!row) return null;
      if (!select) return { ...row };
      return Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, row[key]]));
    },
    async updateMany({ where, data }) {
      const targets = tasks.filter((row) => matches(row, where));
      if (data.clientId) {
        for (const target of targets) {
          if (tasks.some((row) => row !== target && row.agencyId === target.agencyId && row.clientId === data.clientId)) {
            const err = new Error("unique"); err.code = "P2002"; throw err;
          }
        }
      }
      for (const row of targets) Object.assign(row, data);
      return { count: targets.length };
    },
    async deleteMany({ where }) {
      let count = 0;
      for (let i = tasks.length - 1; i >= 0; i -= 1) {
        if (!matches(tasks[i], where)) continue;
        tasks.splice(i, 1);
        count += 1;
      }
      return { count };
    },
    async create({ data }) {
      if (data.clientId && tasks.some((row) => row.agencyId === data.agencyId && row.clientId === data.clientId)) {
        const err = new Error("unique"); err.code = "P2002"; throw err;
      }
      const row = { id: `created-${tasks.length + 1}`, createdAt: new Date(), updatedAt: new Date(), ...data };
      tasks.push(row);
      return { ...row };
    },
    async findMany() { return tasks.map((row) => ({ ...row })); },
    async count() { return tasks.length; },
  };
  return { tasks, db: { creatorAccount, automationTask } };
}

function loadAutomationServiceWithDb(db) {
  const prismaPath = path.join(ROOT, "prisma.js");
  const servicePath = path.join(ROOT, "services/automation-server-service.js");
  delete require.cache[servicePath];
  require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: db };
  return require(servicePath);
}

test("Audit16 clientId collision cannot update another creator task", async () => {
  const before = {
    id: "task-b", agencyId: "agency-1", creatorId: "creator-b", clientId: "shared-client", type: "bump_online",
    title: "B untouched", enabled: true, status: "active", config: {}, triggers: {}, rules: {}, stats: {}, metadata: {}, deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
  const { tasks, db } = taskDb([before]);
  const service = loadAutomationServiceWithDb(db);
  await assert.rejects(
    service.saveBump({ agencyId: "agency-1", userId: "user-1", accountId: "creator-a", input: { id: "shared-client", clientId: "shared-client", messageText: "A" } }),
    (error) => error?.code === "AUTOMATION_TASK_ID_CONFLICT" && error?.status === 409,
  );
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].creatorId, "creator-b");
  assert.equal(tasks[0].title, "B untouched");
});


test("Audit16 raw task id cannot retarget its clientId onto another creator task", async () => {
  const { tasks, db } = taskDb([
    { id: "task-a", agencyId: "agency-1", creatorId: "creator-a", clientId: "client-a", type: "bump_online", title: "A", enabled: true, status: "active", config: {}, triggers: {}, rules: {}, stats: {}, metadata: {}, deletedAt: null, createdAt: new Date(), updatedAt: new Date() },
    { id: "task-b", agencyId: "agency-1", creatorId: "creator-b", clientId: "client-b", type: "bump_online", title: "B", enabled: true, status: "active", config: {}, triggers: {}, rules: {}, stats: {}, metadata: {}, deletedAt: null, createdAt: new Date(), updatedAt: new Date() },
  ]);
  const service = loadAutomationServiceWithDb(db);
  await assert.rejects(
    service.upsertTask({ agencyId: "agency-1", userId: "user-1", expectedCreatorId: "creator-a", input: { id: "task-a", clientId: "client-b", creatorId: "creator-a", accountId: "creator-a", type: "bump_online", title: "collision" } }),
    (error) => error?.code === "AUTOMATION_TASK_ID_CONFLICT" && error?.status === 409,
  );
  assert.equal(tasks[0].clientId, "client-a");
  assert.equal(tasks[1].clientId, "client-b");
});

test("Audit16 dormant SFS Hunter task writer is creator-fenced before any future remount", async () => {
  const collision = "sfs_hunter_settings:creator-a";
  const { tasks, db } = taskDb([
    { id: "settings-b", agencyId: "agency-1", creatorId: "creator-b", clientId: collision, type: "sfs_hunter", title: "B", enabled: true, status: "active", config: {}, triggers: {}, rules: {}, stats: {}, metadata: {}, deletedAt: null, createdAt: new Date(), updatedAt: new Date() },
  ]);
  const service = loadAutomationServiceWithDb(db);
  await assert.rejects(
    service.saveSfsHunterSettings({ agencyId: "agency-1", userId: "user-1", creatorId: "creator-a", input: { enabled: true } }),
    (error) => error?.code === "AUTOMATION_TASK_ID_CONFLICT" && error?.status === 409,
  );
  assert.equal(tasks[0].creatorId, "creator-b");
  assert.equal(tasks[0].clientId, collision);
});
test("Audit16 foreign bump/SFS ids cannot trash, restore or delete outside creator predicate", async () => {
  const { tasks, db } = taskDb([
    { id: "bump-b", agencyId: "agency-1", creatorId: "creator-b", clientId: "bump-client-b", type: "bump_online", metadata: {}, status: "active", enabled: true, deletedAt: null },
    { id: "sfs-b", agencyId: "agency-1", creatorId: "creator-b", clientId: "sfs-client-b", type: "sfs_comment", metadata: {}, status: "active", enabled: true, deletedAt: null },
  ]);
  const service = loadAutomationServiceWithDb(db);
  for (const action of [
    () => service.trashBump({ agencyId: "agency-1", userId: "user-1", accountId: "creator-a", bumpId: "bump-b" }),
    () => service.trashBump({ agencyId: "agency-1", userId: "user-1", accountId: "creator-a", bumpId: "bump-b", restore: true }),
    () => service.trashBump({ agencyId: "agency-1", userId: "user-1", accountId: "creator-a", bumpId: "bump-b", permanent: true }),
    () => service.trashSfsComment({ agencyId: "agency-1", userId: "user-1", accountId: "creator-a", templateId: "sfs-b" }),
  ]) {
    await assert.rejects(action, (error) => ["BUMP_NOT_FOUND", "SFS_COMMENT_NOT_FOUND"].includes(error?.code));
  }
  assert.deepEqual(tasks.map((row) => [row.id, row.creatorId, row.status]), [
    ["bump-b", "creator-b", "active"],
    ["sfs-b", "creator-b", "active"],
  ]);
});

test("Audit16 current Bump update writes through agencyId + creatorId predicate", async () => {
  const { tasks, db } = taskDb([
    { id: "task-a", agencyId: "agency-1", creatorId: "creator-a", clientId: "client-a", type: "bump_online", title: "old", enabled: true, status: "active", config: {}, triggers: {}, rules: {}, stats: {}, metadata: {}, deletedAt: null, createdAt: new Date(), updatedAt: new Date() },
  ]);
  const service = loadAutomationServiceWithDb(db);
  const result = await service.saveBump({ agencyId: "agency-1", userId: "user-1", accountId: "creator-a", input: { id: "task-a", clientId: "client-a", creatorId: "creator-a", accountId: "creator-a", messageText: "updated" } });
  assert.equal(result.ok, true);
  assert.equal(tasks[0].creatorId, "creator-a");
  assert.equal(tasks[0].config.messageText, "updated");
});

test("Audit16 source closure recursively covers registered automation subrouters and creator-fenced predicates", () => {
  const store = read("routes/automation-store.js");
  for (const register of ["registerCoreRoutes", "registerBumpRoutes", "registerSfsRoutes", "registerEventRoutes"]) assert.match(store, new RegExp(`${register}\\(router`));
  for (const retired of ["registerJobRoutes", "registerHiddenOnlineRoutes", "registerDeliveryRoutes", "registerFollowBackRoutes", "registerBumpStatsRoutes"]) {
    assert.doesNotMatch(store, new RegExp(retired), `${retired} must remain physically unmounted`);
  }

  const core = read("routes/automation/core-routes.js");
  assert.match(core, /LEGACY_AUTOMATION_TASK_API_GONE/);
  assert.doesNotMatch(core, /automationServer\.(listTasks|upsertTask|patchTask|trashTask|restoreTask)/);

  for (const file of ["routes/automation/bumps-routes.js", "routes/automation/sfs-routes.js"]) {
    const source = read(file);
    assert.match(source, /new Set\(supplied\)/);
    assert.match(source, /CREATOR_IDENTITY_MISMATCH/);
    assert.match(source, /creatorId:\s*accountId,\s*accountId/);
  }

  const service = read("services/automation-server-service.js");
  assert.match(service, /expectedCreatorId/);
  assert.match(service, /AUTOMATION_TASK_ID_CONFLICT/);
  assert.match(service, /creatorTaskWhere\(\{ agencyId, creatorId:[^}]+id:/);
  assert.match(service, /findFirst\(\{ where: \{ agencyId, creatorId: canonicalAccountId, OR:/);
  assert.match(service, /updateMany\(\{ where, data \}\)/);
  assert.match(service, /deleteMany\(\{ where \}\)/);
  assert.match(service, /findFirst\(\{ where: \{ agencyId, creatorId: cid, clientId \} \}\)/);

  const manifest = read("route-manifest.js");
  assert.match(manifest, /generic AutomationTask customer API retired/);
  assert.match(manifest, /retiredSubroutes:\s*\["\/tasks"/);
});

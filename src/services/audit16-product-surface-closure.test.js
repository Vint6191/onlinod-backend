"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ROUTE_CLASS, ROUTE_MANIFEST } = require("../route-manifest");

const ROOT = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

function mountedFamilies() {
  const source = read("server.js");
  const out = [];
  const re = /app\.use\(\s*["'](\/api[^"']*)["']/g;
  for (const match of source.matchAll(re)) {
    const mounted = match[1];
    if (mounted === "/api" || mounted === "/api/auth/login") continue;
    out.push(mounted);
  }
  return out;
}

test("Audit16 route manifest exactly classifies all 47 production route families", () => {
  const mounted = mountedFamilies();
  assert.equal(mounted.length, 47, `expected 47 route families, got ${mounted.length}`);
  assert.equal(ROUTE_MANIFEST.length, 47, "manifest must classify exactly 47 route families");
  assert.deepEqual(new Set(ROUTE_MANIFEST.map((x) => x.path)), new Set(mounted));
  const valid = new Set(Object.values(ROUTE_CLASS));
  for (const entry of ROUTE_MANIFEST) {
    assert.ok(valid.has(entry.class), `invalid class for ${entry.path}`);
    assert.ok(entry.authority, `missing authority for ${entry.path}`);
    assert.ok(entry.source, `missing source for ${entry.path}`);
  }
});

test("Audit16 retired customer product generations remain authenticated 410 tombstones", () => {
  const server = read("server.js");
  const expectedGone = new Map([
    ["/api/analytics", "legacyAnalyticsRoutes"],
    ["/api/server/crm", "legacyCrmRoutes"],
    ["/api/server/fan-lists", "legacyFanListsRoutes"],
    ["/api/server/segments", "legacySegmentsRoutes"],
    ["/api/server/campaigns", "legacyCampaignsRoutes"],
    ["/api/server/vault-sales", "legacyVaultSalesRoutes"],
    ["/api/server/diagnostics", "legacyDiagnosticsRoutes"],
    ["/api/audit", "legacyAuditRoutes"],
    ["/api/modules", "legacyModulesRoutes"],
    ["/api/message-library", "legacyMessageLibraryRoutes"],
  ]);
  for (const [mount, variable] of expectedGone) {
    assert.match(server, new RegExp(`app\\.use\\(\\"${mount.replace(/\//g, "\\/")}\\", authRequired, ${variable}\\)`));
  }
  for (const entry of ROUTE_MANIFEST.filter((x) => x.class === ROUTE_CLASS.LEGACY_GONE)) {
    assert.ok(expectedGone.has(entry.path), `${entry.path} must have an explicit tombstone assertion`);
  }
  const gone = read("routes/legacy-gone.js");
  assert.match(gone, /status\(410\)/);
  assert.match(gone, /LEGACY_PRODUCT_SURFACE_GONE/);
});

test("Audit16 generic Content API cannot mutate the current Message Library authority", () => {
  const source = read("routes/content-store.js");
  for (const pattern of [
    /router\.get\("\/collections"\s*,\s*genericContentGone\)/,
    /router\.get\("\/collections\/:id"\s*,\s*genericContentGone\)/,
    /router\.post\("\/collections"\s*,\s*genericContentGone\)/,
    /router\.patch\("\/collections\/:id"\s*,\s*genericContentGone\)/,
    /router\.delete\("\/collections\/:id"\s*,\s*genericContentGone\)/,
    /router\.put\("\/collections\/:id\/blocks"\s*,\s*genericContentGone\)/,
    /router\.post\("\/collections\/:id\/usage"\s*,\s*genericContentGone\)/,
  ]) assert.match(source, pattern);
  assert.match(source, /requireProductCreator/);
  assert.match(source, /message_library\.manage/);
  assert.doesNotMatch(source, /["'\`]messageLibrary\.manage|["'\`]content\.manage["'\`]|["'\`]library\.manage/);
});

test("Audit16 current Home has no AnalyticsSnapshot runtime authority and exposes capability semantics", () => {
  const source = read("services/home-summary-service.js");
  assert.doesNotMatch(source, /analytics-snapshot-service|getLatestPayload|AnalyticsSnapshot/);
  assert.match(source, /allowedCreatorScope/);
  assert.match(source, /money\.view_earnings/);
  assert.match(source, /workspace\.view_team/);
  assert.match(source, /workspace\.view_audit/);
  assert.match(source, /workspace\.manage_settings/);
  assert.match(source, /available:\s*available === true/);
  assert.match(source, /FORBIDDEN|UNAVAILABLE/);
});

test("Audit16 legacy Creator Analytics permission evaluator is physically retired from runtime source", () => {
  assert.equal(fs.existsSync(path.join(ROOT, "services/creator-analytics-permissions.js")), false);
  assert.equal(fs.existsSync(path.join(ROOT, "services/creator-analytics-permissions.test.js")), false);
});

test("Audit16 Stats, Traffic and Fan Data use canonical creator scope and canonical permissions", () => {
  const stats = read("routes/stats.js");
  const trafficRoute = read("routes/traffic.js");
  const trafficService = read("services/traffic-service.js");
  const fan = read("routes/fan-data.js");
  assert.match(stats, /requireCreatorAccess/);
  assert.match(stats, /allowedCreatorScope/);
  assert.match(stats, /requireAuthDevice/);
  assert.match(stats, /money\.view_earnings/);
  assert.match(stats, /creator_analytics\.refresh/);
  assert.doesNotMatch(stats, /creator-analytics-permissions/);

  const liveStart = stats.indexOf('router.post("/creators/:creatorId/notifications/live"');
  const dailyStart = stats.indexOf('router.post("/creators/:creatorId/messages-daily"');
  assert.ok(liveStart >= 0 && dailyStart > liveStart, "Stats machine-plane routes must remain mounted");
  const liveRoute = stats.slice(liveStart, dailyStart);
  const dailyRoute = stats.slice(dailyStart);
  for (const machineRoute of [liveRoute, dailyRoute]) {
    assert.match(machineRoute, /mismatchCode:\s*"DEVICE_IDENTITY_MISMATCH"/);
    assert.match(machineRoute, /accessEpoch:\s*Number\(ctx\.member\.accessEpoch\)/);
    assert.match(machineRoute, /res\.status\(Number\(error\?\.status\) \|\| 500\)/);
  }
  assert.doesNotMatch(liveRoute, /requireRefreshPermission/);
  assert.doesNotMatch(dailyRoute, /requireRefreshPermission/);

  assert.match(trafficRoute, /requireProductCreator/);
  assert.match(trafficRoute, /requireProductDevice/);
  assert.match(trafficService, /requireCreatorAccess/);
  assert.match(trafficService, /traffic\.view/);
  assert.match(trafficService, /traffic\.refresh/);
  assert.match(trafficService, /traffic\.manage_costs/);
  assert.doesNotMatch(trafficService, /creator-analytics-permissions/);
  assert.match(fan, /requireProductCreator/);
});

test("Audit16 Dialog Intelligence batch lease carries and revalidates actor authority", () => {
  const route = read("routes/dialog-intelligence.js");
  const service = read("services/dialog-history-batch-service.js");
  assert.match(route, /requireProductDevice/);
  assert.match(route, /filterProductCreatorScope/);
  assert.match(route, /content\.manage_vault/);
  assert.match(route, /workspace\.manage_settings/);
  assert.doesNotMatch(route, /isSeniorAgencyMember/);
  for (const field of ["leaseUserId", "leaseMemberId", "leaseAccessEpoch", "claimedByDeviceId"]) assert.match(service, new RegExp(field));
  assert.match(service, /assertExecutionAccessFence/);
});

test("Audit16 feature mutation routes no longer resurrect manager role shortcuts", () => {
  const current = [
    "routes/dialog-intelligence.js",
    "routes/subscribers.js",
    "routes/media-library.js",
    "routes/vault-directory.js",
    "routes/custom-orders.js",
  ];
  for (const file of current) assert.doesNotMatch(read(file), /isSeniorAgencyMember\(/, `${file} uses a senior-role shortcut`);
  assert.match(read("routes/subscribers.js"), /automation\.manage/);
  assert.match(read("routes/media-library.js"), /content\.manage_vault/);
  assert.match(read("routes/vault-directory.js"), /content\.manage_vault/);
  assert.match(read("routes/custom-orders.js"), /content\.manage_vault/);
});

test("Audit16 machine routes bind supplied device identity and current long-lived Customs/Telegram work is access-fenced", () => {
  for (const file of ["routes/custom-orders.js", "routes/settings.js", "routes/traffic.js"]) assert.match(read(file), /requireProductDevice/);
  const telegramRuntime = read("services/telegram-execution-runtime.js");
  const telegramDelivery = read("services/telegram-delivery-authority-service.js");
  const uploadWork = read("services/custom-content-submissions-service.js");

  // Reminder execution no longer lives in custom-order-reminders.js.  The current external-write
  // authority is TelegramDeliveryIntent, while account runtime ownership remains a separate lease.
  for (const source of [telegramRuntime, telegramDelivery]) {
    assert.match(source, /assertExecutionAccessFence/);
    assert.match(source, /accessEpoch/);
  }
  for (const field of ["runtimeLeaseUserId", "runtimeLeaseMemberId", "runtimeLeaseAccessEpoch", "runtimeLeaseCreatorId"]) {
    assert.match(telegramRuntime, new RegExp(field), `Telegram runtime must validate ${field}`);
    assert.match(uploadWork, new RegExp(field), `Custom upload work must validate ${field}`);
  }
  for (const field of ["deviceId", "userId", "memberId", "accessEpoch", "claimTokenHash", "commitStartedAt"]) {
    assert.match(telegramDelivery, new RegExp(field), `TelegramDeliveryIntent authority must carry ${field}`);
  }
  assert.match(telegramDelivery, /assertTelegramRuntimeLease/);
  assert.match(uploadWork, /scope\.broad \|\| scopedCreatorIds\.has\(anchorCreatorId\)/);
});

test("Audit16 current automation store does not mount or depend on the weak generic creator helper", () => {
  const source = read("routes/automation-store.js");
  assert.doesNotMatch(source, /\brequireCreator\b/);
  assert.doesNotMatch(source, /registerJob|registerHidden|registerDeliver|registerFollowBack/i);
  assert.match(source, /registerCoreRoutes/);
  assert.match(source, /registerBumpRoutes/);
  assert.match(source, /registerSfsRoutes/);
  assert.match(source, /registerEventRoutes/);
});

test("Audit16 optional PPV audit provenance uses signed device, never body spoof fallback", () => {
  const source = read("routes/team-analytics.js");
  assert.match(source, /deviceId:\s*req\.auth\.deviceId\s*\|\|\s*null/);
  assert.doesNotMatch(source, /req\.auth\.deviceId\s*\|\|\s*req\.body\?\.deviceId/);
});

test("Audit16 Message Library retention and usage cannot widen back to agency scope", () => {
  const source = read("routes/content-store.js");
  assert.match(source, /async function requireMessageLibraryCreator\(req\)[\s\S]*CREATOR_ID_MISSING[\s\S]*requireProductCreator\(req, creatorId, \{ db: prisma \}\)/);
  assert.match(source, /async function purgeExpiredMessageLibraryTrash\(agencyId, creatorId\)/);
  assert.match(source, /where:\s*\{\s*agencyId,\s*creatorId,\s*kind:\s*MESSAGE_LIBRARY_KIND/);
  assert.match(source, /router\.get\("\/message-library\/usage"[\s\S]*const creatorId = await requireMessageLibraryCreator\(req\)/);
  assert.match(source, /router\.post\("\/message-library\/purge-expired"[\s\S]*const creatorId = await requireMessageLibraryCreator\(req\)/);
});

test("Audit16 Dialog Intelligence claim passes only the filtered creator id list into the lease service", () => {
  const route = read("routes/dialog-intelligence.js");
  assert.match(route, /const scoped = await filterProductCreatorScope\(req, input\.creatorIds, \{ rejectForeign: true \}\)/);
  assert.match(route, /creatorIds:\s*scoped\.creatorIds/);
  assert.doesNotMatch(route, /const creatorIds = await filterProductCreatorScope/);
});

test("Audit16 mounted current customer routes cannot reintroduce weak creator or senior-role authorities", () => {
  const entries = ROUTE_MANIFEST.filter((entry) => ![ROUTE_CLASS.PUBLIC, ROUTE_CLASS.ADMIN, ROUTE_CLASS.LEGACY_GONE].includes(entry.class));
  for (const entry of entries) {
    const source = read(entry.source);
    const weakImport = /\{[^}]*\brequireCreator\b[^}]*\}\s*=\s*require\(["']\.\.\/services\/server-store-utils["']\)/s;
    assert.doesNotMatch(source, weakImport, `${entry.path} imports server-store-utils.requireCreator`);
    assert.doesNotMatch(source, /creator-analytics-permissions/, `${entry.path} imports the retired analytics permission evaluator`);
    assert.doesNotMatch(source, /isSeniorAgencyMember\(/, `${entry.path} uses senior role as current product authority`);
  }
});

test("Audit16 route files that directly consume request deviceId contain an authenticated-device binding primitive", () => {
  const entries = ROUTE_MANIFEST.filter((entry) => ![ROUTE_CLASS.PUBLIC, ROUTE_CLASS.ADMIN, ROUTE_CLASS.LEGACY_GONE].includes(entry.class));
  const requestDevice = /req\.(?:body|query)[^\n]{0,120}deviceId|deviceId[^\n]{0,120}req\.(?:body|query)/;
  const binding = /requireAuthDevice|requireProductDevice|actorDevice\(|registeredDevice\(/;
  for (const entry of entries) {
    const source = read(entry.source);
    if (!requestDevice.test(source)) continue;
    assert.match(source, binding, `${entry.path} consumes request deviceId without a recognized auth-device binding primitive`);
  }
});

test("Audit16 permission migration preserves legacy explicit decision precedence without promoting ineffective role aliases", () => {
  const migration = fs.readFileSync(path.resolve(ROOT, "../prisma/migrations/20260902012000_audit16_permission_cutover/migration.sql"), "utf8");
  assert.match(migration, /any explicit TRUE among aliases wins/i);
  assert.match(migration, /creatorAnalytics\.viewMoney/);
  assert.match(migration, /stats\.refresh/);
  assert.match(migration, /creator_analytics\.manage_traffic_costs/);
  assert.match(migration, /jsonb_build_object\('analytics', 'hidden'\)/);
  assert.match(migration, /Legacy AgencySubPermissionOverride alias rows are intentionally retained/);
  assert.doesNotMatch(migration, /INSERT INTO "AgencySubPermissionOverride"/);
});

test("Audit16 current Dialog Intelligence cannot write retired server raw-message or Vault purchase projections", () => {
  const source = read("services/dialog-intelligence-service.js");
  for (const retiredWriter of [
    /dialogMessageLedger\.(?:create|upsert|update)/,
    /dialogMessageMedia\.(?:create|upsert|update)/,
    /dialogPurchaseSignal\.(?:create|upsert|update)/,
    /vaultPurchaseLedger\.(?:create|upsert|update)/,
    /vaultPurchaseMedia\.(?:create|upsert|update)/,
  ]) assert.doesNotMatch(source, retiredWriter);
  assert.match(source, /Purchase facts, prices and Vault projections are local-only/);
  assert.match(source, /ingestWsMessages[\s\S]*localOnly:\s*true[\s\S]*ignored:\s*true/);
});

test("Audit16 direct Dialog Intelligence machine ingress requires a signed auth device", () => {
  const route = read("routes/dialog-intelligence.js");
  const purchaseStart = route.indexOf('router.post("/creators/:creatorId/ingest/purchase-signals"');
  const wsStart = route.indexOf('router.post("/creators/:creatorId/ingest/ws"');
  assert.ok(purchaseStart >= 0 && wsStart > purchaseStart);
  const purchase = route.slice(purchaseStart, wsStart);
  const ws = route.slice(wsStart, route.indexOf('router.get("/creators/:creatorId/', wsStart) >= 0 ? route.indexOf('router.get("/creators/:creatorId/', wsStart) : undefined);
  assert.match(purchase, /requireProductDevice\(req, req\.auth\?\.deviceId\)/);
  assert.match(ws, /requireProductDevice\(req, req\.auth\?\.deviceId\)/);
});


test("Audit16 retired archive Prisma generations have no current runtime reader/writer outside explicit legacy/admin files", () => {
  const allowed = new Set([
    "routes/admin-data.js",
    "routes/campaigns.js",
    "routes/crm-store.js",
    "routes/fan-lists.js",
    "routes/message-library.js",
    "routes/segments.js",
    "routes/vault-sales.js",
    "services/analytics-snapshot-service.js",
  ]);
  const retiredDelegate = /\.(?:analyticsSnapshot|crmProfile|crmProfileTag|crmNote|fanList|fanListMember|savedSegment|campaignDraft|campaignQueueStatus|messageTemplateGroup|messageTemplate|messageTemplateUsageEvent|vaultPurchaseMessage|vaultMediaSale|vaultPurchaseLedger|vaultPurchaseMedia|dialogPurchaseSignal)\b/;
  const offenders = [];
  const walk = (dir, prefix = "") => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile() && rel.endsWith(".js") && !rel.endsWith(".test.js") && !allowed.has(rel)) {
        const source = fs.readFileSync(abs, "utf8");
        if (retiredDelegate.test(source)) offenders.push(rel);
      }
    }
  };
  walk(ROOT);
  assert.deepEqual(offenders, [], `retired archive delegate leaked into current runtime: ${offenders.join(", ")}`);
});

test("Audit16 server cannot accidentally remount retired route implementations behind the 410 tombstones", () => {
  const server = read("server.js");
  for (const legacyModule of [
    "./routes/analytics",
    "./routes/crm-store",
    "./routes/fan-lists",
    "./routes/segments",
    "./routes/campaigns",
    "./routes/vault-sales",
    "./routes/server-store-diagnostics",
    "./routes/audit",
    "./routes/modules",
    "./routes/message-library",
  ]) {
    assert.doesNotMatch(server, new RegExp(`require\\([\\"']${legacyModule.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}[\\"']\\)`), `${legacyModule} must remain physically unimported by production server`);
  }
  assert.match(server, /createLegacyGoneRouter/);
});

test("Audit16 Telegram secret/session material is signed-device and runtime-lease bound", () => {
  const route = read("routes/settings.js");
  const service = read("services/settings-service.js");
  const runtime = read("services/telegram-execution-runtime.js");

  const addStart = route.indexOf('router.post("/telegram/accounts"');
  const removeStart = route.indexOf('router.delete("/telegram/accounts/:accountId"');
  const materialStart = route.indexOf('router.post("/telegram/accounts/:accountId/local-material"');
  const sessionStart = route.indexOf('router.put("/telegram/accounts/:accountId/session"');
  const runtimeGoneStart = route.indexOf('router.get("/runtime"');
  assert.ok(addStart >= 0 && removeStart > addStart && materialStart > removeStart && sessionStart > materialStart && runtimeGoneStart > sessionStart);

  assert.match(route.slice(addStart, removeStart), /requireProductDevice\(req, req\.body\?\.deviceId\)/);
  const materialRoute = route.slice(materialStart, sessionStart);
  assert.match(materialRoute, /requireProductDevice\(req, req\.body\?\.deviceId\)/);
  assert.match(materialRoute, /deviceId:\s*boundDeviceId/);
  assert.match(materialRoute, /claimToken:\s*req\.body\?\.claimToken/);
  assert.match(route.slice(sessionStart, runtimeGoneStart), /requireProductDevice\(req, req\.body\?\.deviceId\)/);

  const materialServiceStart = service.indexOf("async function issueTelegramMtprotoLocalMaterial");
  const sessionServiceStart = service.indexOf("async function storeTelegramMtprotoSession", materialServiceStart);
  const materialService = service.slice(materialServiceStart, sessionServiceStart);
  assert.match(materialService, /assertTelegramMessagingAccess/);
  assert.match(materialService, /assertTelegramRuntimeLease/);
  assert.match(materialService, /deviceId, claimToken/);
  assert.match(runtime, /requestedAccountId[\s\S]*candidates = requestedAccountId[\s\S]*candidate\.accountId === requestedAccountId/);
});


test("Audit16 Devices family cannot leak agency inventory or acknowledge another signed device command", () => {
  const route = read("routes/devices.js");
  const ackStart = route.indexOf('router.post("/commands/:id/ack"');
  const mineStart = route.indexOf('router.get("/mine"');
  assert.ok(ackStart >= 0 && mineStart > ackStart);
  const ack = route.slice(ackStart, mineStart);
  assert.match(ack, /requireAuthDevice\(req, command\.deviceId/);
  assert.match(ack, /mismatchCode:\s*"DEVICE_IDENTITY_MISMATCH"/);
  const mine = route.slice(mineStart);
  assert.match(mine, /status\(410\)/);
  assert.match(mine, /DEVICE_INVENTORY_GONE/);
  assert.doesNotMatch(mine, /workerDevice\.findMany|creatorBindings/);
});

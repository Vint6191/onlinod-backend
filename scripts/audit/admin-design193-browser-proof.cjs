"use strict";
// Actual static Admin assets and fetch/command client, synthetic HTTP responses.
// No Prisma, SQL engine, external site or production credentials are used.
const fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http"),
  assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const runtime = process.env.ONLINOD_BROWSER_RUNTIME;
if (!runtime || !process.env.ONLINOD_CHROMIUM) throw Error("Set ONLINOD_BROWSER_RUNTIME and ONLINOD_CHROMIUM");
const { chromium } = createRequire(path.join(runtime, "package.json"))("playwright");
const root = path.resolve(__dirname, "../.."),
  out = path.resolve(process.env.ONLINOD_UI_PROOF_OUTPUT || path.join(root, "artifacts/admin193"));
fs.mkdirSync(out, { recursive: true });
const now = "2026-11-03T12:00:00.000Z",
  until = "2026-12-03T12:34:56.987Z";
const tiers = Object.fromEntries(
  [
    ["STARTER", "Starter", 2000, "$0–$1k"],
    ["GROWTH", "Growth", 4000, "$1k–$5k"],
    ["PRO", "Pro", 7000, "$5k–$15k"],
    ["ELITE", "Elite", 10000, "$15k+"],
    ["CUSTOM", "Custom", null, "Индивидуально"],
  ].map(([k, label, priceCents, revenueLabel]) => [k, { label, priceCents, revenueLabel }])
);
const addons = {
  aiChatter: { label: "AI Chatter", priceCents: 10000 },
  outreach: { label: "SFS + Comment Bot", priceCents: 2900 },
};
const model = (id, agency, tier) => ({
  creatorId: id,
  agencyId: agency,
  agencyName: agency === "agency-a" ? "North Studio" : "Coast Agency",
  displayName: { c1: "Mira", c2: "Rose", c3: "Neva", c4: "Kate", c5: "Luna", c6: "Ava" }[id] || "Mira",
  username: id,
  remoteId: "556614" + id,
  creatorStatus: "READY",
  tier,
  tierMode: "AUTO",
  corePriceCents: tiers[tier].priceCents || 8500,
  corePriceSource: tier === "CUSTOM" ? "OVERRIDE" : "CATALOG",
  aiChatterPriceCents: 10000,
  aiChatterPriceSource: "CATALOG",
  outreachPriceCents: 2900,
  outreachPriceSource: "CATALOG",
  aiChatterEnabled: false,
  outreachEnabled: false,
  billingExcluded: false,
  pricingRevision: 3,
  configuredLineCents: tiers[tier].priceCents || 8500,
  sessionStatus: id === "c2" ? "REVOKED" : "ACTIVE",
  entitlement: {
    tier,
    entitlementRevision: 4,
    coreValidUntil: until,
    coreActive: id !== "c2",
    coreSource: "PAYMENT",
    aiChatterValidUntil: null,
    outreachValidUntil: null,
  },
  access: { allowed: id !== "c2", reason: id === "c2" ? "CREATOR_SUBSCRIPTION_REQUIRED" : "PAID", validUntil: until },
});
const models = [
  model("c1", "agency-a", "STARTER"),
  model("c2", "agency-a", "GROWTH"),
  model("c3", "agency-a", "PRO"),
  model("c4", "agency-a", "ELITE"),
  model("c5", "agency-a", "CUSTOM"),
  model("c6", "agency-a", "STARTER"),
  model("other", "agency-b", "PRO"),
];
const agencies = [
  ["agency-a", "North Studio"],
  ["agency-b", "Coast Agency"],
].map(([id, name]) => ({
  id,
  name,
  status: "ACTIVE",
  plan: "core",
  billingMode: "MANUAL",
  trialEndsAt: null,
  billingPolicyRevision: 2,
  createdAt: now,
  members: [],
  creators: models.filter((m) => m.agencyId === id).map((m) => ({ id: m.creatorId, ...m })),
  subscriptions: [{ billingMode: "MANUAL", billingPeriod: "MONTHLY" }],
  adminActionLogs: [],
  owner: { email: "owner@example.test" },
  counts: { creators: models.filter((m) => m.agencyId === id).length, members: 1, devices: 1 },
  health: { score: 100, level: "healthy", issues: [] },
}));
const admin = { id: "admin", name: "Owner", email: "owner@example.test", role: "SUPER_ADMIN", active: true };
const report = {
  ok: false,
  engine: "Actual Admin HTML/CSS/JS + Chromium + synthetic HTTP",
  database: false,
  externalWrites: 0,
  cases: [],
  errors: [],
  unknownRequests: [],
  mutations: [],
};
const recordCase = report.cases.push.bind(report.cases);
report.cases.push = (text) => {
  console.log("PASS", text);
  return recordCase(text);
};
const receipts = new Map();
let dropNext = false,
  slowAgency = false;
function response(url, method, body, headers) {
  const p = url.pathname;
  if (p === "/api/admin-auth/me") return { ok: true, admin };
  if (p === "/api/admin-auth/logout") return { ok: true };
  if (p === "/api/admin/dashboard")
    return {
      ok: true,
      counts: {
        agencies: { total: 2, active: 2, trial: 0, locked: 0 },
        users: { total: 3, unverified: 0 },
        creators: { total: 7, ready: 6, problem: 1 },
        devices: { total: 2, online: 1 },
        canonicalSessions: { activePortable: 6 },
      },
      mrr: { coreCents: 24500, aiChatterCents: 0, outreachCents: 0 },
      recentActions: [],
      recentSignups: [],
    };
  if (p === "/api/admin/agencies") return { ok: true, agencies };
  if (p.startsWith("/api/admin/agencies/"))
    return { ok: true, agency: agencies.find((a) => a.id === p.split("/").at(-1)), health: { score: 100, issues: [] } };
  if (p === "/api/admin/billing/tiers")
    return { ok: true, tiers, addons: { aiChatterPriceCents: 10000, outreachPriceCents: 2900 } };
  if (p === "/api/admin/billing/commercial-policy")
    return {
      ok: true,
      revision: 2,
      settings: {
        trialDays: 14,
        starterPriceCents: 2000,
        growthPriceCents: 4000,
        proPriceCents: 7000,
        elitePriceCents: 10000,
        aiChatterPriceCents: 10000,
        outreachPriceCents: 2900,
      },
    };
  if (p === "/api/admin/billing/overview")
    return {
      ok: true,
      mrr: { billedCents: 24500, billedModels: 6, billableAgencies: 2, totalAgencies: 2, trialPotentialCents: 0 },
      agencies: agencies.map((a) => ({
        agencyId: a.id,
        name: a.name,
        status: "ACTIVE",
        billable: true,
        modelsBilled: 3,
        modelsTotal: a.counts.creators,
        monthlyCents: 17500,
        addons: { aiChatter: 0, outreach: 0 },
      })),
      page: { limit: 100, nextCursor: null },
    };
  if (p.startsWith("/api/admin/billing/agency/") && method === "GET") {
    const agency = agencies.find((a) => a.id === p.split("/").at(-1)),
      all = models.filter((m) => m.agencyId === agency.id),
      after = url.searchParams.get("after"),
      start = after ? all.findIndex((m) => m.creatorId === after) + 1 : 0;
    return {
      ok: true,
      agency,
      models: all.slice(start, start + 5),
      modelsTotal: all.length,
      tiers,
      addons,
      configuredMonthlyCents: all.reduce((s, m) => s + m.configuredLineCents, 0),
      monthlyCents: 24500,
      page: { limit: 5, nextCursor: all.length > start + 5 ? all[start + 4].creatorId : null },
    };
  }
  if (
    (p.startsWith("/api/admin/billing/creator/") && method === "PATCH") ||
    (/\/creators\/[^/]+\/entitlement$/.test(p) && method === "PATCH")
  ) {
    const id = headers["idempotency-key"];
    if (receipts.has(id)) return receipts.get(id).result;
    const access = p.endsWith("/entitlement"),
      creatorId = access ? p.split("/").at(-2) : p.split("/").at(-1),
      m = models.find((m) => m.creatorId === creatorId);
    report.mutations.push({ path: p, creatorId, body, commandId: id });
    assert.equal(body.expectedAgencyId, m.agencyId);
    if (access) {
      Object.assign(m.entitlement, body);
      m.entitlement.entitlementRevision++;
    } else {
      Object.assign(m, body);
      m.pricingRevision++;
      if (body.tierMode === "MANUAL") m.tier = body.tier;
    }
    const result = { ok: true, commandId: id, billing: m, entitlement: m.entitlement };
    receipts.set(id, { ok: true, status: "SUCCEEDED", result });
    return result;
  }
  if (p.startsWith("/api/admin/commands/"))
    return receipts.get(p.split("/").at(-1)) || { ok: false, code: "ADMIN_COMMAND_NOT_FOUND" };
  if (p === "/api/admin/creators")
    return {
      ok: true,
      creators: models.map((m) => ({
        id: m.creatorId,
        agency: agencies.find((a) => a.id === m.agencyId),
        displayName: m.displayName,
        username: m.username,
        status: "READY",
        billingProfile: { tier: m.tier },
        sessionState: { status: m.sessionStatus },
        createdAt: now,
      })),
    };
  if (p === "/api/admin/users")
    return {
      ok: true,
      users: [
        {
          id: "owner",
          email: "owner@example.test",
          name: "Owner",
          createdAt: now,
          emailVerifiedAt: now,
          memberships: [],
        },
      ],
    };
  if (p === "/api/admin/devices") return { ok: true, devices: [] };
  if (p === "/api/admin/audit") return { ok: true, events: [] };
  if (p === "/api/admin/admin-users") return { ok: true, admins: [admin] };
  if (p === "/api/admin/data/anomalies")
    return { ok: true, anomalies: [], checkedAt: now, coverage: { status: "COMPLETE", excluded: [] } };
  if (p === "/api/admin/system/health")
    return {
      ok: true,
      db: { ok: true, latencyMs: 12 },
      server: { uptime: 7200, node: "22", memoryMb: 120, version: "0.7.1" },
      env: { nodeEnv: "production", hasResendKey: true, hasSnapshotKey: true, jwtConfigured: true },
    };
  if (p === "/api/admin/system/retention")
    return { ok: true, revision: 1, policyHash: "a".repeat(64), schema: {}, settings: {} };
  if (p === "/api/admin/data/search")
    return { ok: true, results: { agencies: [agencies[1]], creators: [], users: [] } };
  if (/^\/api\/admin\/data\/creator\/[^/]+\/overview$/.test(p)) {
    const m = models.find((m) => m.creatorId === p.split("/").at(-2));
    return {
      ok: true,
      creator: { ...m, id: m.creatorId, agency: agencies.find((a) => a.id === m.agencyId) },
      counts: { deliveries: 0, hiddenOnline: 0, followBack: 0, moneyCents: 0 },
      bumpStats: {},
    };
  }
  report.unknownRequests.push({ method, path: p });
  return { ok: false, error: "Unmocked route: " + p };
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://local");
    if (url.pathname.startsWith("/api/")) {
      let raw = "";
      for await (const c of req) raw += c;
      if (slowAgency && url.pathname === "/api/admin/billing/agency/agency-a")
        await new Promise((r) => setTimeout(r, 350));
      const data = response(url, req.method, raw ? JSON.parse(raw) : null, req.headers);
      if (dropNext && req.method === "PATCH") {
        dropNext = false;
        res.writeHead(502, { "Content-Type": "text/plain" }).end("gateway lost committed response");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
      return;
    }
    let file =
      url.pathname.startsWith("/admin/") && /\.(js|css|ttf)$/.test(url.pathname)
        ? path.join(root, "public", url.pathname)
        : path.join(root, "public/admin/index.html");
    const ext = path.extname(file),
      type = { ".js": "text/javascript", ".css": "text/css", ".ttf": "font/ttf", ".html": "text/html" }[ext];
    res.writeHead(200, { "Content-Type": type }).end(fs.readFileSync(file));
  } catch (e) {
    report.errors.push(e.stack);
    res.writeHead(500).end("fixture failure");
  }
});
(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({
    executablePath: process.env.ONLINOD_CHROMIUM,
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    page.on("pageerror", (e) => report.errors.push(e.stack));
    page.on("dialog", (d) => d.accept());
    await page.route("**/*", (route) =>
      new URL(route.request().url()).origin === base ? route.continue() : route.abort()
    );
    await page.addInitScript(() => localStorage.setItem("onlinod_admin_token", "fixture-admin-token"));
    const go = async (section) => {
      await page.goto(base + "/admin" + (section === "dashboard" ? "" : "/" + section));
      await page.waitForSelector(".adm-rail");
      await page.waitForFunction(() => !document.querySelector("#admMain .adm-loading"));
    };
    await go("agencies/agency-a");
    await page.waitForSelector('tr[data-creator="c1"]');
    assert.equal(await page.locator("tr[data-creator]").count(), 5);
    assert.equal(await page.locator('[data-agtab="creators"]').getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("[data-tier]").count(), 5);
    await page.screenshot({ path: path.join(out, "agency-desktop.png"), fullPage: true });
    report.cases.push("Agency opens on models; all five real tiers rendered, with independent NOD and OF state");
    await page.locator('tr[data-creator="c1"] .bl-pricing').click();
    assert.equal(await page.locator("select[name=tier] option").count(), 5);
    await page.selectOption("[name=tierMode]", "MANUAL");
    await page.selectOption("[name=tier]", "CUSTOM");
    assert.equal(await page.inputValue("[name=corePrice]"), "");
    await page.fill("[name=corePrice]", "83.50");
    await page.check("[name=aiChatterEnabled]");
    await page.fill("[name=reason]", "Agreed model terms");
    await page.locator(".adm-sheet-body").evaluate((el) => (el.scrollTop = 0));
    await page.screenshot({ path: path.join(out, "pricing-drawer.png"), fullPage: true });
    await page.click("form [type=submit]");
    await page.waitForSelector(".adm-side-sheet", { state: "detached" });
    await page.waitForSelector('tr[data-creator="c1"]');
    assert.equal(models[0].tier, "CUSTOM");
    assert.equal(models[1].tier, "GROWTH");
    assert.equal(models.at(-1).tier, "PRO");
    assert.equal(models[0].entitlement.coreValidUntil, until);
    report.cases.push(
      "CUSTOM explicit price and addon configure only one selected model, paid dates and other agency stay unchanged"
    );
    await page.locator('tr[data-creator="c1"] .bl-access').click();
    await page.fill("[name=aiChatterValidUntil]", "2026-12-05T12:00");
    await page.fill("[name=reason]", "AI extension");
    await page.click("form [type=submit]");
    await page.waitForSelector(".adm-side-sheet", { state: "detached" });
    await page.waitForSelector('tr[data-creator="c1"]');
    const accessBody = report.mutations.at(-1).body;
    assert.equal(Object.hasOwn(accessBody, "coreValidUntil"), false);
    assert.equal(Object.hasOwn(accessBody, "tier"), false);
    assert.equal(models[0].entitlement.coreValidUntil, until);
    assert.equal(models[1].sessionStatus, "REVOKED");
    report.cases.push("Addon-only access edit preserves exact core milliseconds, tier and other model OF state");
    await page.locator('tr[data-creator="c2"] .bl-pricing').click();
    await page.fill("[name=reason]", "Retry same intent");
    dropNext = true;
    await page.click("form [type=submit]");
    await page.waitForFunction(
      () =>
        document.querySelector("fieldset[data-draft]")?.disabled &&
        !document.querySelector("form [type=submit]")?.disabled
    );
    const count = report.mutations.length;
    await page.click("form [type=submit]");
    await page.waitForSelector(".adm-side-sheet", { state: "detached" });
    assert.equal(report.mutations.length, count);
    report.cases.push(
      "Committed response lost: draft frozen, retry reuses the command and does not duplicate mutation"
    );
    await page.locator(".bl-page-next").click();
    await page.waitForSelector('tr[data-creator="c6"]');
    assert.equal(await page.locator("tr[data-creator]").count(), 1);
    await page.locator(".bl-page-first").click();
    await page.waitForSelector('tr[data-creator="c1"]');
    report.cases.push("Cursor pagination next/first; page selection does not leak");
    await page.locator('tr[data-creator="c1"] .bl-pricing').click();
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".adm-side-sheet").count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains("bl-pricing")), true);
    report.cases.push("Drawer Escape closes and restores keyboard focus");
    await page.fill("#admGlobalSearch", "Coast");
    await page.waitForSelector(".adm-search-results.active");
    await page.locator(".adm-search-row").first().click();
    await page.waitForSelector('tr[data-creator="other"]');
    assert.equal(await page.locator('tr[data-creator="c1"]').count(), 0);
    report.cases.push("Global search navigates to the correct agency and its own model");
    slowAgency = true;
    await page.evaluate(() => window.NodAdminRouter.pushDetail("billing", "agency-a"));
    await page.waitForTimeout(50);
    await page.evaluate(() => window.NodAdminRouter.pushDetail("billing", "agency-b"));
    await page.waitForSelector('tr[data-creator="other"]');
    await page.waitForTimeout(450);
    assert.equal(await page.locator('tr[data-creator="c1"]').count(), 0);
    slowAgency = false;
    report.cases.push("Late agency read cannot repaint another agency");
    for (const width of [1440, 1024, 736, 380, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const section of [
        "dashboard",
        "agencies",
        "agencies/agency-a",
        "users",
        "creators",
        "billing",
        "data",
        "devices",
        "audit",
        "admins",
        "system",
      ]) {
        await go(section);
        await page.waitForTimeout(100);
        const overflow = await page.evaluate(() => ({
          scroll: document.documentElement.scrollWidth,
          width: innerWidth,
        }));
        assert.ok(overflow.scroll <= width + 1, `${section} width ${width} overflows: ${JSON.stringify(overflow)}`);
        if (width === 1440 && ["dashboard", "billing", "system"].includes(section))
          await page.screenshot({ path: path.join(out, section + ".png"), fullPage: true });
        if (width === 380 && section === "agencies/agency-a")
          await page.screenshot({ path: path.join(out, "agency-mobile.png"), fullPage: true });
      }
    }
    report.cases.push(
      "All ten navigation sections plus agency workspace: no document overflow at 1440/1024/736/380/320px"
    );
    await page.setViewportSize({ width: 1440, height: 1050 });
    await go("billing");
    await page.locator("details>summary").first().click();
    await page.waitForSelector("#blPolicyForm");
    assert.equal(await page.locator(".adm-tier-card").count(), 5);
    await page.screenshot({ path: path.join(out, "catalog.png"), fullPage: true });
    report.cases.push("Global catalog expands, shows all five tiers and both addons, loads real policy form");
    await page.evaluate(() => {
      window.NodAdminApi.setToken(null);
      window.NodAdminRouter.render();
    });
    await page.waitForSelector("#admSubmit");
    await page.screenshot({ path: path.join(out, "login.png"), fullPage: true });
    report.cases.push("Logout renders the matching login screen");
    assert.equal(report.errors.length, 0, report.errors.join("\n"));
    assert.equal(report.unknownRequests.length, 0, JSON.stringify(report.unknownRequests));
    report.ok = true;
  } finally {
    await browser.close();
    server.close();
    fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify({ ok: report.ok, cases: report.cases, output: out }, null, 2));
})().catch((e) => {
  console.error(e.stack);
  server.close();
  process.exitCode = 1;
});

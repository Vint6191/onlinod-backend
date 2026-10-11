"use strict";
// Actual Admin assets -> HTTP server -> Prisma -> disposable current-schema SQL.
// Synthetic accounts and history; no application DB, email or external provider.
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  net = require("node:net"),
  crypto = require("node:crypto"),
  assert = require("node:assert/strict");
const { spawn } = require("node:child_process"),
  { createRequire } = require("node:module");
const root = path.resolve(__dirname, "../.."),
  load = createRequire(path.join(root, "package.json"));
const runtime = createRequire(path.resolve(process.env.ONLINOD_BROWSER_RUNTIME, "package.json"));
const output = path.resolve(
  process.env.ONLINOD_SQL_PROOF_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), "onlinod-admin-evidence-")),
  "evidence/admin-acceptance"
);
fs.mkdirSync(output, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "onlinod-admin-proof-"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const result = {
  ok: false,
  cases: [],
  checks: [],
  findings: [],
  requests: [],
  rendererErrors: [],
  nativePostgres: false,
  nativeElectron: false,
  externalWrites: 0,
  externalProviders: false,
  engine: "PGlite + actual Prisma/HTTP/Chromium Admin",
  fixture: "Synthetic accounts and terminal history; real domain commands",
  limitations: [
    "One physical SQL session; native multi-session PostgreSQL contention is not verified.",
    "Desktop/Windows and physical providers are outside this Admin browser proof.",
  ],
};
const baseline = process.env.ONLINOD_ADMIN_UI_BASELINE;
const servingRoot = baseline || root;
const check = (ok, name) => {
  console.log(ok ? "CHECK" : "FINDING", name);
  result.checks.push({ name, ok: !!ok });
  if (!ok) result.findings.push(name);
  if (!baseline) assert.ok(ok, name);
};
const pass = (name) => {
  result.cases.push(name);
  console.log("PASS", name);
};
async function main() {
  const f = await load("./scripts/test-support/admin-sql-runtime.cjs").createAdminSqlRuntime({
    runtimePath: process.env.ONLINOD_SQL_PROOF_RUNTIME,
    maxConnections: 4,
  });
  let child,
    exit,
    browser,
    page,
    log = "",
    token,
    closing = false;
  try {
    await load("./src/services/admin-operator-bootstrap-service").bootstrapAdmin({
      db: f.db,
      commandId: crypto.randomUUID(),
      operator: "local-proof",
      reason: "Disposable Admin acceptance",
      email: "admin@example.test",
      password: "isolated-admin-password",
      name: "Proof admin",
    });
    const writers = load("./src/services/database-write-contract-service"),
      hash = await load("bcryptjs").hash("isolated-user-password", 10);
    await f.db.$transaction(async (tx) => {
      await writers.assertTeamControlPlaneWriteAdmission(tx);
      for (const [id, name] of [
        ["owner", "Owner"],
        ["member", "Member"],
        ["retire-owner", "Retire Owner"],
      ])
        await tx.user.create({
          data: { id, email: id + "@example.test", name, passwordHash: hash, emailVerifiedAt: new Date() },
        });
      for (const [id, name, uid] of [
        ["admin-agency", "Admin agency", "owner"],
        ["retire-agency", "Retire agency", "retire-owner"],
      ]) {
        await tx.agency.create({ data: { id, name, trialEndsAt: new Date(Date.now() + 14 * 86400000) } });
        await tx.agencyMember.create({
          data: { id: id + "-owner", agencyId: id, userId: uid, role: "OWNER", roleKey: "owner" },
        });
      }
      await tx.agencyMember.create({
        data: { id: "admin-member", agencyId: "admin-agency", userId: "member", role: "OPERATOR", roleKey: "operator" },
      });
      await writers.authorizeCreatorAccountWrite(tx);
      for (const id of ["admin-creator", "other-creator", "unused-creator"])
        await tx.creatorAccount.create({
          data: { id, agencyId: "admin-agency", displayName: id, username: id.replaceAll("-", "_") },
        });
      await tx.workerDevice.create({
        data: {
          id: "proof-device",
          agencyId: "admin-agency",
          userId: "member",
          deviceName: "Proof Windows",
          platform: "win32",
          lastSeenAt: new Date(),
        },
      });
      await tx.contentCollection.create({
        data: {
          id: "proof-content",
          agencyId: "admin-agency",
          creatorId: "admin-creator",
          kind: "message_library_script",
          clientId: "proof-script",
          title: "Admin proof script",
        },
      });
    });
    await f.db.$executeRawUnsafe(
      `INSERT INTO "AutomationDelivery" ("id","agencyId","creatorId","fanId","messageId","status","finishedAt","updatedAt") SELECT 'proof-'||lpad(n::text,4,'0'),'admin-agency','admin-creator','fan-'||n,'message-'||n,'COMPLETED',(clock_timestamp() AT TIME ZONE 'UTC')-interval '1 hour',(clock_timestamp() AT TIME ZONE 'UTC') FROM generate_series(1,405) n`
    );
    await f.db.$disconnect();
    const socket = net.createServer();
    await new Promise((r) => socket.listen(0, "127.0.0.1", r));
    const port = socket.address().port;
    await new Promise((r) => socket.close(r));
    const origin = `http://127.0.0.1:${port}`;
    const preload = path.join(scratch, "io.cjs");
    fs.writeFileSync(
      preload,
      `globalThis.fetch=async()=>{throw Error('EXTERNAL_IO_FORBIDDEN_IN_ADMIN_PROOF')};require(${JSON.stringify(path.join(root, "src/services/email-service.js"))}).sendMail=async()=>{throw Error('EMAIL_FORBIDDEN_IN_ADMIN_PROOF')};`
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
      SNAPSHOT_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
      PUBLIC_BASE_URL: origin,
      CORS_ORIGINS: baseline ? origin : "",
    });
    async function boot() {
      const from = log.length;
      let ended = false;
      child = spawn(process.execPath, ["--require", preload, "src/server.js"], {
        cwd: servingRoot,
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
      const timer = setTimeout(() => child?.kill("SIGKILL"), 15000);
      await exit;
      clearTimeout(timer);
      child = null;
    }
    await boot();
    const api = async (method, url, body, expected = 200, auth = token, id) => {
      const r = await fetch(origin + url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(auth ? { Authorization: "Bearer " + auth } : {}),
          ...(id ? { "Idempotency-Key": id } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      const data = await r.json();
      result.requests.push({ source: "HTTP", method, url, status: r.status, code: data.code });
      assert.ok([].concat(expected).includes(r.status), `${method} ${url}: ${r.status} ${JSON.stringify(data)}`);
      return data;
    };
    const admin = await api("POST", "/api/admin-auth/login", {
      email: "admin@example.test",
      password: "isolated-admin-password",
    });
    token = admin.token;
    const chromium = runtime("@sparticuz/chromium");
    browser = await runtime("playwright").chromium.launch({
      executablePath: process.env.ONLINOD_CHROMIUM_PATH || (await chromium.executablePath()),
      args: chromium.args,
    });
    const context = await browser.newContext({ viewport: { width: 1536, height: 960 } });
    page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on("pageerror", (e) => result.rendererErrors.push(e.message));
    page.on("dialog", (dialog) =>
      dialog.accept(
        dialog.type() === "prompt"
          ? dialog.message().includes("Type 'DELETE'")
            ? "DELETE"
            : "Admin acceptance reason"
          : undefined
      )
    );
    let held = null,
      failOnce = null,
      loseOnce = null;
    function hold(match) {
      let hit, release;
      const seen = new Promise((r) => (hit = r)),
        gate = new Promise((r) => (release = r));
      held = { match, hit, gate };
      return { seen, release };
    }
    await page.route("**/*", async (route) => {
      const req = route.request(),
        url = new URL(req.url());
      if (url.origin !== origin) return route.abort();
      if (
        baseline &&
        !url.pathname.startsWith("/api/") &&
        (url.pathname.startsWith("/admin/") || url.pathname === "/admin" || url.pathname === "/admin-login")
      ) {
        const relative =
          url.pathname.endsWith(".js") || url.pathname.endsWith(".css") ? url.pathname.slice(1) : "admin/index.html";
        const file = path.join(baseline, "public", relative);
        if (fs.existsSync(file)) return route.fulfill({ path: file });
      }
      if (!url.pathname.startsWith("/api/")) return route.continue();
      const key = req.method() + " " + url.pathname + url.search;
      if (failOnce?.(key)) {
        failOnce = null;
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ ok: false, error: "Controlled read outage" }),
        });
      }
      const own = held?.match(key) ? held : null;
      if (own) held = null;
      let response;
      try {
        response = await route.fetch();
      } catch (error) {
        if (closing) return;
        throw Error("Local browser request failed: " + key);
      }
      let data;
      try {
        data = await response.json();
      } catch {}
      result.requests.push({
        source: "browser",
        method: req.method(),
        url: url.pathname + url.search,
        status: response.status(),
        code: data?.code,
        error: data?.error,
        commandId: data?.commandId,
      });
      if (url.pathname.endsWith("/archive-deliveries")) {
        result.archiveRequest = req.postDataJSON();
        result.archiveResponse = data;
        console.log("ARCHIVE", JSON.stringify({ input: result.archiveRequest, output: data }));
      }
      if (own) {
        own.hit(data);
        await own.gate;
      }
      if (loseOnce?.(key)) {
        loseOnce = null;
        return route.abort("failed");
      }
      try {
        await route.fulfill({ response });
      } catch {}
    });
    const nav = async (section) => {
      await page.locator(`.adm-rail-item[data-section="${section}"]`).click();
      await page.waitForFunction((section) => window.OnlinodAdminState.section === section, section);
    };
    const signIn = async (email = "admin@example.test", password = "isolated-admin-password") => {
      await page.locator("#admEmail").fill(email);
      await page.locator("#admPassword").fill(password);
      await page.locator("#admSubmit").click();
      await page.locator("#admDashRefresh").waitFor();
      await page.waitForFunction(() => window.OnlinodAdminState.dashboard.lastLoadedAt > 0);
      check(
        (await page.locator(".adm-metric-grid").count()) === 1,
        "dashboard renders current canonical-session contract"
      );
    };
    const logout = async () => {
      await page.locator("#admUserMenu").click();
      await page.locator("#admSubmit").waitFor();
    };
    await page.goto(origin + "/admin-login");
    await signIn();
    const h = hold((key) => key === "GET /api/admin/users");
    await nav("users");
    await h.seen;
    await nav("devices");
    await page.locator('[data-device-kick="proof-device"]').waitFor();
    h.release();
    await wait(250);
    check((await page.locator("#admDevicesRefresh").count()) === 1, "late list response stays on the current route");
    await nav("users");
    await page.locator("#admUsersQ").waitFor();
    await page.locator('[data-user-open="owner"]').waitFor();
    const q = hold((key) => key.includes("/users?q=owner"));
    await page.locator("#admUsersQ").fill("owner");
    await q.seen;
    await page.locator("#admUsersQ").fill("member");
    await wait(350);
    q.release();
    await wait(250);
    check(
      (await page.locator("#admMain").innerText()).includes("member@example.test") &&
        !(await page.locator("#admMain").innerText()).includes("owner@example.test"),
      "new filter supersedes the pending query"
    );
    const countBefore = result.requests.length;
    await page.locator("#admUsersQ").fill("no-such-user-166");
    await wait(850);
    const emptyCount = result.requests
      .slice(countBefore)
      .filter((x) => x.url.includes("/users?q=no-such-user-166")).length;
    check(emptyCount === 1, "empty list is a loaded result without a request loop");
    await page.goto(origin + "/admin/users");
    await page.locator('[data-user-open="owner"]').waitFor();
    const drawer = hold((key) => key === "GET /api/admin/users/owner");
    await page.locator('[data-user-open="owner"]').click();
    await drawer.seen;
    await page.locator("[data-drawer-close]").last().click();
    await page.locator('[data-user-open="member"]').click();
    await page.locator(".adm-drawer-body").getByText("member@example.test", { exact: true }).waitFor();
    drawer.release();
    await wait(250);
    check(
      (await page.locator(".adm-drawer-body").innerText()).includes("member@example.test"),
      "late user detail cannot replace a newer drawer"
    );
    await page.locator("[data-drawer-close]").last().click();
    const search = hold((key) => key.includes("/data/search?q=owner"));
    await page.locator("#admGlobalSearch").fill("owner");
    await search.seen;
    await page.locator("#admGlobalSearch").fill("member");
    await page.locator("#admSearchResults").getByText("member@example.test", { exact: true }).waitFor();
    search.release();
    await wait(250);
    check(
      !(await page.locator("#admSearchResults").innerText()).includes("owner@example.test"),
      "global search publishes only the current query"
    );
    await page.locator("#admGlobalSearch").press("Escape");
    await page.goto(origin + "/admin/creators/admin-creator");
    await page.locator('[data-tab="deliveries"]').click();
    await page.locator("#admCDBody tbody tr").first().waitFor();
    if (await page.locator("[data-archive-next]").count()) {
      const first = await page.locator("#admCDBody tbody").innerText();
      await page.locator("[data-archive-next]").click();
      await wait(300);
      check(
        (await page.locator("#admCDBody tbody").innerText()) !== first &&
          (await page.locator("#admCDBody tbody tr").count()) === 200,
        "creator history next page advances server pagination"
      );
    } else check(false, "creator history next page advances server pagination");
    await nav("admins");
    await page.locator("[data-admin-role]").first().waitFor();
    const support = await api(
      "POST",
      "/api/admin/admin-users",
      {
        email: "support@example.test",
        password: "isolated-support-password",
        name: "Support proof",
        role: "SUPPORT",
        reason: "Admin acceptance",
      },
      201,
      token,
      crypto.randomUUID()
    );
    await logout();
    await signIn("support@example.test", "isolated-support-password");
    await nav("admins");
    await wait(250);
    check(
      (await page.locator("#admMain").innerText()).includes("support@example.test"),
      "new login reloads module-local admin roster"
    );
    check(await page.locator("#admAdminsCreate").isDisabled(), "support sees read-only administrator controls");
    const supportToken = await page.evaluate(() => window.OnlinodAdminApi.getToken());
    failOnce = (key) => key === "GET /api/admin-auth/me";
    await page.reload();
    await wait(250);
    check(
      await page.evaluate(() => !!window.OnlinodAdminApi.getToken()),
      "temporary authority outage keeps session available for Retry"
    );
    check(
      (await page.getByRole("button", { name: "Retry", exact: true }).count()) === 1,
      "bootstrap outage has a retry path"
    );
    if (baseline) {
      result.ok = result.findings.length === 0;
      return;
    }
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.locator("#admAdminsRefresh").waitFor();
    pass("Route/filter/drawer/search/session races, empty reads, pagination and authority retry");
    await api(
      "POST",
      "/api/admin/admin-users",
      { email: "forbidden@example.test", password: "isolated-password", role: "SUPPORT", reason: "denial proof" },
      403,
      supportToken,
      crypto.randomUUID()
    );
    await nav("system");
    await page.locator("#admRetentionReason").waitFor();
    check(await page.locator("#admRetentionRun").isDisabled(), "support cannot run cleanup from UI");
    await page.goto(origin + "/admin/agencies/admin-agency");
    await page.locator('[data-action="soft-delete"]').waitFor();
    check(await page.locator('[data-action="soft-delete"]').isDisabled(), "support cannot retire agency from UI");
    await page.locator('[data-action="support"]').click();
    await page.locator("#admSupportContent").waitFor();
    await page.locator("#admSupportEnd").click();
    await page.locator("#admSupportContent").waitFor({ state: "detached" });
    await logout();
    await signIn();
    pass("Support grant lifecycle and SUPER_ADMIN write boundaries");
    await nav("billing");
    await page.locator('[name="trialDays"]').fill("21");
    await page.locator('[name="reason"]').fill("New trial duration");
    await page.getByRole("button", { name: "Save global settings", exact: true }).click();
    await page.getByText("Global settings saved.", { exact: true }).waitFor();
    check(
      (await api("GET", "/api/admin/billing/commercial-policy")).settings.trialDays === 21,
      "global policy saved via actual form"
    );
    await page.locator('tr[data-agency="admin-agency"]').click();
    await page.locator('tr[data-creator="admin-creator"]').waitFor();
    const row = page.locator('tr[data-creator="admin-creator"]');
    await row.locator(".bl-mode").selectOption("MANUAL");
    await row.locator(".bl-tier").selectOption("CUSTOM");
    await row.locator(".bl-price").fill("12.34");
    const lost = hold((key) => key === "PATCH /api/admin/billing/creator/admin-creator");
    loseOnce = (key) => key === "PATCH /api/admin/billing/creator/admin-creator";
    await row.locator(".bl-save").click();
    const committed = await lost.seen;
    check(await row.locator(".bl-price").isDisabled(), "billing form cannot change while submission is in flight");
    lost.release();
    await page
      .getByText("Result unknown. Retry the same change or check its status.", { exact: true })
      .first()
      .waitFor();
    await stop("SIGKILL");
    await boot();
    await page.reload();
    await page.locator("#admCommandRecovery").getByRole("button", { name: "Check result", exact: true }).click();
    await page
      .locator("#admCommandRecovery")
      .getByText(/SUCCEEDED/)
      .waitFor();
    check(
      (await page.locator('tr[data-creator="admin-creator"] .bl-price').inputValue()) === "12.34",
      "lost response is recovered after Backend restart and browser reload"
    );
    result.recoveredCommandId = committed.commandId;
    await page.reload();
    await page.locator('tr[data-creator="admin-creator"] .bl-access').click();
    const access = page.locator(".adm-modal-overlay");
    await access.locator('[name="aiChatterValidUntil"]').fill("2026-12-01T12:34:56");
    await access.locator('[name="reason"]').fill("Add-on grant only");
    await access.getByRole("button", { name: "Save access", exact: true }).click();
    await access.waitFor({ state: "detached" });
    const accessState = await api("GET", "/api/admin/billing/agency/admin-agency");
    const entitlement = accessState.models.find((x) => x.creatorId === "admin-creator").entitlement;
    check(
      entitlement.aiChatterValidUntil && entitlement.coreValidUntil === null,
      "AI-only access grant does not fabricate core access"
    );
    await page.locator('tr[data-creator="admin-creator"] .bl-select').check();
    await page.locator('tr[data-creator="other-creator"] .bl-select').check();
    await page.locator("#blBulkTier").selectOption("PRO");
    await page.locator("#blBulkReason").fill("Selected pricing proof");
    await page.locator("#blBulkApply").click();
    await page
      .locator("#blBulkProgress")
      .getByText(/QUEUED|RUNNING|SUCCEEDED/)
      .waitFor();
    let until = Date.now() + 120000;
    while (!(await page.locator("#blBulkProgress").innerText()).includes("SUCCEEDED")) {
      assert.ok(Date.now() < until, "bulk command completion");
      await wait(500);
      await page.locator("#blBulkCheck").click();
    }
    result.bulk = {
      progress: await page.locator("#blBulkProgress").textContent(),
      outcomes: await page.locator("#blBulkOutcomes").textContent(),
    };
    console.log("BULK", JSON.stringify(result.bulk));
    check(result.bulk.outcomes.includes("other-creator: SUCCEEDED"), "bulk selection finishes with per-model outcomes");
    pass("Global policy, prices, command loss/restart/reload, dated access and selected bulk pricing");
    await nav("data");
    await page.locator('[data-tab="browse"]').click();
    await page.locator("#admEntity").selectOption("content");
    await page.locator("#admFAgency").fill("admin-agency");
    await page.locator("#admFCreator").fill("admin-creator");
    await page.locator("#admLoad").click();
    await page.locator('[data-content-id="proof-content"][data-content-action="trash"]').click();
    await page.locator('[data-content-id="proof-content"][data-content-action="restore"]').waitFor();
    await page.locator('[data-content-id="proof-content"][data-content-action="restore"]').click();
    await page.locator('[data-content-id="proof-content"][data-content-action="trash"]').waitFor();
    await page.locator('[data-inspect="proof-content"]').click();
    await page
      .locator(".adm-modal-overlay")
      .getByText(/Admin proof script/)
      .waitFor();
    await page.locator(".adm-modal-close").click();
    await page.locator("#admEntity").selectOption("deliveries");
    await page.locator("#admLoad").click();
    await page.locator(".admRowChk").first().waitFor();
    await page.locator(".admRowChk").first().check();
    await page.locator("#admArchiveCutoff").fill(new Date(Date.now() - 60000).toISOString().slice(0, 16));
    await page.locator("#admArchiveReason").fill("Archive one terminal delivery");
    await page.locator("#admBulkDel").click();
    await page.getByText("archived 1", { exact: true }).waitFor();
    pass("Data diagnostics, current browser, inspection, content trash/restore and bounded terminal archive");
    await page.goto(origin + "/admin/agencies/admin-agency");
    await page.locator('[data-agtab="members"]').click();
    await page.locator('[data-member-role="admin-member"]').selectOption("MANAGER");
    await page.waitForFunction(
      () =>
        document.querySelector('[data-member-role="admin-member"]')?.value === "MANAGER" &&
        !document.querySelector('[data-member-role="admin-member"]')?.disabled
    );
    await page.locator('[data-agtab="subscription"]').click();
    await page.locator("#admSubReason").fill("Pause billing status");
    await page.locator("#admSubHold").click();
    await page.getByRole("button", { name: "Release billing hold", exact: true }).waitFor();
    await page.locator("#admSubReason").fill("Resume billing status");
    await page.locator("#admSubHold").click();
    await page.getByRole("button", { name: "Hold billing status", exact: true }).waitFor();
    await page.locator("#admSubPlan").fill("admin-proof");
    await page.locator("#admSubReason").fill("Plan label proof");
    await page.locator("#admSubSave").click();
    await page.getByText("subscription saved", { exact: true }).waitFor();
    await nav("devices");
    await page.locator('[data-device-kick="proof-device"]').click();
    await page.getByText("device kicked", { exact: true }).waitFor();
    await nav("users");
    await page.locator("#admUsersQ").fill("member");
    await page.locator('[data-user-open="member"]').click();
    await page.locator('[data-user-action="disable"]').click();
    await page.locator('[data-user-action="enable"]').waitFor();
    await page.locator('[data-user-action="enable"]').click();
    await page.locator('[data-user-action="disable"]').waitFor();
    await page.locator('[data-user-action="force-logout"]').click();
    await page.getByText(/session\(s\) revoked/).waitFor();
    await page.locator("[data-drawer-close]").last().click();
    pass("Agency member roles, billing hold/policy, device kick and user disable/enable/logout");
    await page.goto(origin + "/admin/agencies/retire-agency");
    await page.locator('[data-action="soft-delete"]').click();
    await page.locator('[data-action="restore"]').waitFor();
    await page.locator('[data-action="restore"]').click();
    await page.locator('[data-action="soft-delete"]').waitFor();
    await page.locator('[data-action="soft-delete"]').click();
    await page.locator('[data-action="hard-delete"]').click();
    await page.locator("#admAgRefresh").waitFor();
    pass("Disposable agency retirement, restore and explicit permanent retirement");
    await nav("admins");
    await page.locator("#admAdminsCreate").click();
    await page.locator("#admNewAdminEmail").fill("second-admin@example.test");
    await page.locator("#admNewAdminName").fill("Second admin");
    await page.locator("#admNewAdminPwd").fill("isolated-second-password");
    await page.locator("#admNewAdminRole").selectOption("SUPER_ADMIN");
    await page.locator("#admNewAdminSubmit").click();
    await page.getByText("admin created", { exact: true }).waitFor();
    await page.locator('[data-admin-pwd][data-admin-email="support@example.test"]').click();
    await page.locator("#admPwdValue").fill("isolated-support-new-password");
    await page.locator("#admPwdReason").fill("Credential reset proof");
    await page.locator("#admPwdSubmit").click();
    await page.getByText("password set — sessions revoked", { exact: true }).waitFor();
    await api("GET", "/api/admin-auth/me", undefined, 401, supportToken);
    pass("Admin identity creation, password reset and immediate old-session revocation");
    const policyRead = hold((key) => key === "GET /api/admin/system/retention");
    await nav("system");
    await policyRead.seen;
    check(
      await page.locator('.adm-retention-input[data-key="batchSize"]').isDisabled(),
      "retention input waits for the authoritative policy"
    );
    policyRead.release();
    await page.locator('.adm-retention-input[data-key="batchSize"]').fill("100");
    await page.locator("#admRetentionReason").fill("Bounded cleanup proof");
    await page.locator("#admRetentionSave").click();
    await page.getByText("Retention policy saved.", { exact: true }).waitFor();
    await page.locator("#admRetentionRun").click();
    await page
      .getByText(/Cleanup queued|Cleanup is queued|queued/i)
      .first()
      .waitFor();
    let retention = await api("GET", "/api/admin/system/retention");
    const retentionId = retention.lastRun.commandId;
    check(retention.lastRun.status === "QUEUED", "retention is durably queued for the next scheduled pass");
    // The ordinary recurring sweep runs hourly and30s after startup. Exercise
    // durable queue recovery through that actual startup path; do not alter
    // scheduler intervals, leases, policy clocks or the worker implementation.
    await stop();
    await boot();
    await page.reload();
    await page.locator("#admRetentionReload").waitFor();
    until = Date.now() + 120000;
    while (["QUEUED", "RUNNING"].includes(retention.lastRun?.status)) {
      assert.ok(Date.now() < until, "retention completion");
      await wait(500);
      retention = await api("GET", "/api/admin/system/retention");
    }
    check(
      ["SUCCEEDED", "PARTIAL"].includes(retention.lastRun?.status),
      "retention command completes bounded work with durable status"
    );
    check(retention.lastRun.commandId === retentionId, "restart keeps the same queued retention command");
    result.retention = { commandId: retentionId, status: retention.lastRun.status, recoveredAfterRestart: true };
    await page.locator("#admRetentionReload").click();
    await page.getByText(/Cleanup pass completed|Pass finished with remaining work/).waitFor();
    await nav("audit");
    await page.locator("#admAuditQ").fill("billing");
    await page.locator("#admAuditRefresh").click();
    await page.locator("#admMain tbody tr").first().waitFor();
    check((await page.locator("#admMain").innerText()).includes("billing"), "audit reads completed commands");
    pass("System retention policy/run/status and cross-domain audit");
    await page.screenshot({ path: path.join(output, "admin-audit.png"), fullPage: true });
    await stop();
    await f.db.$connect();
    check(
      (await f.db.adminCommand.count({ where: { commandId: result.recoveredCommandId } })) === 1,
      "one durable receipt for recovered price change"
    );
    check(
      (await f.db.adminCommandAudit.count({
        where: {
          commandId: (await f.db.adminCommand.findFirst({ where: { commandId: result.recoveredCommandId } })).id,
        },
      })) === 1,
      "one command audit for recovered price change"
    );
    check(
      (await f.db.automationDelivery.count({ where: { agencyId: "admin-agency", creatorId: "admin-creator" } })) ===
        404,
      "exactly one selected terminal delivery archived"
    );
    result.sqlSummary = {
      commands: await f.db.adminCommand.count(),
      commandAudits: await f.db.adminCommandAudit.count(),
    };
    await f.db.$disconnect();
    check(result.rendererErrors.length === 0, "no browser runtime errors");
    result.ok = true;
  } finally {
    closing = true;
    fs.writeFileSync(
      path.join(output, baseline ? "baseline.json" : "result.json"),
      JSON.stringify(result, null, 2) + "\n"
    );
    if (page) await page.unrouteAll({ behavior: "ignoreErrors" });
    if (browser) await browser.close();
    if (child) {
      child.kill("SIGKILL");
      await exit;
    }
    await f.db.$disconnect();
    await wait(100);
    await f.close();
    fs.writeFileSync(
      path.join(output, baseline ? "baseline.json" : "result.json"),
      JSON.stringify(result, null, 2) + "\n"
    );
    fs.writeFileSync(path.join(output, baseline ? "baseline-server.log" : "server.log"), log);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

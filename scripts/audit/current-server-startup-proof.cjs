"use strict";
// Runs the actual server executable and its normal timers on an empty local DB.
// No real provider credentials or application DATABASE_URL enter the child.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), net = require("node:net");
const { spawn } = require("node:child_process");
const { createAdminSqlRuntime } = require("../test-support/admin-sql-runtime.cjs");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function unusedPort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
async function main() {
  const f = await createAdminSqlRuntime({ runtimePath: process.env.ONLINOD_SQL_PROOF_RUNTIME });
  const output = path.resolve(process.env.ONLINOD_SQL_PROOF_OUTPUT || require("node:os").tmpdir(), "evidence");
  fs.mkdirSync(output, { recursive: true });
  const report = { ok: false, nativePostgres: false, productionAccessed: false, externalProviders: false, engine: "PGlite + actual server.js/Prisma", cases: [] };
  const check = async (name, work) => { await work(); report.cases.push({ name, ok: true }); console.log("PASS", name); };
  async function boot(label, observeMs) {
    await f.db.$disconnect(); // Only the child owns the single PGlite SQL session.
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/DATABASE|DIRECT_URL|SHADOW|JWT|SECRET|PASSWORD|TOKEN|API_KEY|TELEGRAM|SMTP|BOOTSTRAP_ADMIN/.test(key)) delete env[key];
    const port = await unusedPort();
    Object.assign(env, { DATABASE_URL: f.url, PORT: String(port), NODE_ENV: "production", JWT_SECRET: "isolated-current-server-proof-not-a-real-secret",
      SNAPSHOT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"), RESEND_API_KEY: "", ONLINOD_EXPOSE_HEALTH_DETAILS: "1" });
    const child = spawn(process.execPath, ["src/server.js"], { cwd: f.root, env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "", ended = false;
    const append = data => { log += data.toString(); };
    child.stdout.on("data", append); child.stderr.on("data", append);
    const exit = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => { ended = true; resolve({ code, signal }); }); });
    const get = async route => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(10000) });
      const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.ok, true); return body;
    };
    try {
      const deadline = Date.now() + 30000;
      while (!log.includes('"message":"backend listening"')) {
        if (ended || Date.now() > deadline) throw Error("Server did not reach listening state: " + log);
        await pause(100);
      }
      await get("/health"); await get("/ready");
      await pause(observeMs); assert.equal(ended, false);
      const health = await get("/health/details"); await get("/ready");
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 30000);
      let stopped; try { stopped = await exit; } finally { clearTimeout(killTimer); }
      assert.deepEqual(stopped, { code: 0, signal: null }, log);
      assert.match(log, /maintenance runtime ready/); assert.match(log, /shutdown requested/);
      assert.doesNotMatch(log, /prisma:error|"level":"(?:warn|error)"|step failed|sweep crashed|projection degraded|maintenance degraded|42P01|does not exist/i);
      return { observedMs: observeMs, health, exit: stopped };
    } finally {
      if (!ended) { child.kill("SIGKILL"); await exit.catch(() => {}); }
      fs.writeFileSync(path.join(output, "server-" + label + ".log"), log);
    }
  }
  try {
    await check("actual server starts, serves readiness and runs normal background timers through the first recurring sweep", async () => {
      report.firstBoot = await boot("first", 35000);
      const state = await require("../../src/services/admin-diagnostics-service").readDiagnostics({ db: f.db });
      assert.equal(state.coverage.status, "AVAILABLE"); assert.ok(state.anomalies.every(row => row.count === 0));
      report.diagnostics = state.coverage;
      report.maintenanceProgress = await f.db.$queryRawUnsafe('SELECT "laneName","turnCount" FROM "MaintenanceAdmissionClassState" WHERE "generation"=\'onlinod_maintenance_v1\' ORDER BY "ordinal"');
      report.maintenanceProgress = report.maintenanceProgress.map(row => ({ laneName: row.laneName, turnCount: Number(row.turnCount) }));
    });
    await f.db.systemSetting.create({ data: { key: "startup-proof-preserved", value: { preserved: true } } });
    await check("normal restart preserves database data and completed diagnostics without repeating setup", async () => {
      report.restart = await boot("restart", 7000);
      assert.deepEqual((await f.db.systemSetting.findUnique({ where: { key: "startup-proof-preserved" } })).value, { preserved: true });
      assert.equal((await require("../../src/services/admin-diagnostics-service").readDiagnostics({ db: f.db })).coverage.status, "AVAILABLE");
    });
    report.ok = true;
  } catch (error) { report.error = { message: error.message, stack: error.stack }; throw error; }
  finally { await f.close(); fs.writeFileSync(path.join(output, "current-server-startup-proof.json"), JSON.stringify(report, null, 2) + "\n"); }
}
const keep = setInterval(() => {}, 1000);
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearInterval(keep));

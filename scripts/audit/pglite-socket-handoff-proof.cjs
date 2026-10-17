"use strict";

const assert = require("node:assert/strict");
const net = require("node:net");
const path = require("node:path");
const { createRequire } = require("node:module");
const { PrismaClient } = require("@prisma/client");
const { createPgliteSocketServer } = require("../test-support/pglite-socket-runtime.cjs");
const runtimePath = process.env.ONLINOD_SQL_PROOF_RUNTIME;
if (!runtimePath) throw Error("An explicit local proof runtime is required");
const load = createRequire(path.resolve(runtimePath, "package.json"));

async function resetClient(server) {
  const [host, port] = server.getServerConn().split(":");
  const socket = net.connect({ host, port: Number(port) });
  // A real PostgreSQL startup packet, followed by an actual TCP reset. The
  // previous fixture leaked its handler when the server observed ECONNRESET.
  const fields = Buffer.from("user\0postgres\0database\0postgres\0\0");
  const startup = Buffer.alloc(8 + fields.length);
  startup.writeInt32BE(startup.length, 0);
  startup.writeInt32BE(196608, 4);
  fields.copy(startup, 8);
  await new Promise((resolve, reject) => {
    let response = Buffer.alloc(0);
    const timer = setTimeout(() => reject(Error("PGLITE_STARTUP_TIMEOUT")), 5000);
    socket.once("error", reject);
    socket.once("connect", () => socket.write(startup));
    socket.on("data", data => {
      response = Buffer.concat([response, data]);
      while (response.length >= 5) {
        const length = 1 + response.readInt32BE(1);
        if (response.length < length) return;
        const type = String.fromCharCode(response[0]);
        response = response.subarray(length);
        if (type === "Z") {
          clearTimeout(timer);
          socket.resetAndDestroy();
          resolve();
          return;
        }
      }
    });
  });
}

(async () => {
  const keep = setInterval(() => {}, 1000);
  let engine, server, db;
  try {
    engine = await load("@electric-sql/pglite").PGlite.create();
    server = await createPgliteSocketServer({ engine, load });
    const url = `postgresql://postgres:postgres@${server.getServerConn()}/postgres?connection_limit=1&sslmode=disable`;
    db = new PrismaClient({ datasources: { db: { url } } });
    for (let round = 0; round < 8; round++) {
      await resetClient(server);
      await server.waitForIdle();
      assert.equal(server.getStats().activeConnections, 0);
      assert.equal((await db.$queryRawUnsafe("SELECT 1::int AS value"))[0].value, 1);
      await db.$disconnect();
      await server.waitForIdle();
    }
    await engine.exec("BEGIN; SELECT 1; ROLLBACK");
    assert.equal((await db.$queryRawUnsafe("SELECT 2::int AS value"))[0].value, 2);
    console.log("PASS eight TCP-reset retirements, Prisma reconnects and direct-engine handoff");
  } finally {
    if (db) await db.$disconnect();
    if (server) await server.stop();
    if (engine) await engine.close();
    clearInterval(keep);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

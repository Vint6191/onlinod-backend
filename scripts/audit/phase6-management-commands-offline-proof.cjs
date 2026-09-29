"use strict";
// Disposable full-migration SQL proof. Does not use the caller's DATABASE_URL.
const assert = require("node:assert/strict"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { createRequire } = require("node:module"),
  { spawn } = require("node:child_process");
const { PrismaClient } = require(process.env.D6_PRISMA_CLIENT || "@prisma/client");
const keepAlive = setInterval(() => {}, 1000);
const deadline = setTimeout(() => {
  console.error("LOCAL_PROOF_DEADLINE");
  process.exit(2);
}, 55000);
async function main() {
  if (!process.env.PHASE5_PROOF_RUNTIME) throw Error("PHASE5_PROOF_RUNTIME required");
  const load = createRequire(path.resolve(process.env.PHASE5_PROOF_RUNTIME, "package.json"));
  const { PGlite } = load("@electric-sql/pglite"),
    { PGLiteSocketServer } = load("@electric-sql/pglite-socket");
  console.log("PROOF_ENGINE_START");
  const engine = await PGlite.create();
  const server = new PGLiteSocketServer({ db: engine, host: "127.0.0.1", port: 0 });
  await server.start();
  const url = `postgresql://postgres:postgres@${server.getServerConn()}/postgres?connection_limit=1&sslmode=disable`;
  const db = new PrismaClient({ datasources: { db: { url } }, log: [{ emit: "event", level: "query" }] }),
    cases = [];
  if (process.env.D6_SQL_TRACE === "1") db.$on("query", (e) => console.log("SQL", e.query.slice(0, 150)));
  const check = async (name, work) => {
    console.log("CHECK_START", name);
    await work();
    cases.push({ name, status: "PASS" });
    console.log(JSON.stringify(cases.at(-1)));
  };
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [require.resolve("prisma/build/index.js"), "migrate", "deploy"], {
        cwd: path.resolve(__dirname, "../.."),
        env: { ...process.env, DATABASE_URL: url },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (b) => (output += b));
      child.stderr.on("data", (b) => (output += b));
      child.once("error", reject);
      child.once("close", (code) => (code ? reject(Error(output)) : resolve()));
    });
    console.log("PROOF_MIGRATIONS_APPLIED");
    await engine.exec("DISCARD ALL");
    console.log("PROOF_WIRE_RESET");
    await engine.exec("SET TIME ZONE 'UTC'");
    await engine.exec(
      `UPDATE "Phase2ReleaseCompatibilityAuthority" SET "activationState"='ACTIVE' WHERE "scope"='TEAM_CONTROL_PLANE'`
    );
    console.log("PROOF_FIXTURE_DDL_READY");
    require.cache[require.resolve("../../src/prisma")] = { exports: db };
    const { executeManagementCommand } = require("../../src/services/management-command-service");
    const custom = require("../../src/services/custom-orders-service"),
      network = require("../../src/services/creator-network-profile-service"),
      settings = require("../../src/services/settings-service"),
      bcrypt = require("bcryptjs");
    const oldHash = await bcrypt.hash("original-password", 4);
    const generation = (tx) =>
      tx.$executeRawUnsafe(
        "SELECT set_config('onlinod.phase2_team_control_plane_generation',$1,true)",
        "phase2_team_control_plane_v2_durable_access"
      );
    let seq = 0;
    async function seed() {
      return db.$transaction(async (tx) => {
        await generation(tx);
        await require("../../src/services/phase2-release-compatibility-authority-service").authorizeCreatorAccountWrite(
          tx
        );
        const tag = "d6-" + ++seq;
        const user = await tx.user.create({
          data: { email: tag + "@example.test", passwordHash: oldHash, name: "before" },
        });
        const agency = await tx.agency.create({ data: { name: tag, trialEndsAt: new Date("2099-01-01") } });
        const member = await tx.agencyMember.create({
          data: {
            agencyId: agency.id,
            userId: user.id,
            role: "OWNER",
            roleKey: "owner",
            assignedCreators: "all",
            permissions: {},
          },
        });
        const creator = await tx.creatorAccount.create({
          data: { agencyId: agency.id, displayName: tag, status: "READY" },
        });
        return { agencyId: agency.id, userId: user.id, member, creatorId: creator.id };
      });
    }

    async function disable(s) {
      await db.$transaction(async (tx) => {
        await generation(tx);
        await tx.agencyMember.update({ where: { id: s.member.id }, data: { role: "ADMIN", roleKey: "admin" } });
        const replacement = await tx.user.create({
          data: { email: "replacement-" + s.userId + "@example.test", passwordHash: oldHash },
        });
        await tx.agencyMember.create({
          data: {
            agencyId: s.agencyId,
            userId: replacement.id,
            role: "OWNER",
            roleKey: "owner",
            assignedCreators: "all",
          },
        });
        await tx.user.update({ where: { id: s.userId }, data: { disabledAt: new Date() } });
      });
      assert.ok((await db.user.findUnique({ where: { id: s.userId } })).disabledAt);
    }
    const command = (action, targetId, payload) => ({ commandId: crypto.randomUUID(), action, targetId, payload });
    const run = (s, input, extra = {}) =>
      executeManagementCommand({
        db,
        agencyId: s.agencyId,
        userId: s.userId,
        actorMember: s.member,
        deviceId: "device",
        input,
        ...extra,
      });
    const receipts = (s) =>
      db.$queryRawUnsafe('SELECT * FROM "ManagementCommandReceipt" WHERE "agencyId"=$1', s.agencyId);
    const profile = () => command("account.profile", "", { name: "after", expectedName: "before" });
    const proxy = (s) =>
      command("network.create", s.creatorId, {
        deviceId: "device",
        expectedNetworkVersion: 0,
        label: "Dedicated",
        type: "SOCKS5",
        host: "proxy.example.test",
        port: 1080,
      });
    await check("Profile exact replay returns original identity, one receipt, no second audit", async () => {
      const s = await seed(),
        c = profile(),
        one = await run(s, c),
        two = await run(s, c);
      assert.equal(one.result.user.name, "after");
      assert.equal(two.replayed, true);
      assert.deepEqual(two.result, one.result);
      assert.equal((await receipts(s)).length, 1);
      assert.equal(
        await db.auditLog.count({ where: { agencyId: s.agencyId, action: "management_command.committed" } }),
        1
      );
    });
    await check("Profile replay cannot overwrite a later name; stale first command is rejected", async () => {
      const s = await seed(),
        c = profile();
      await run(s, c);
      await run(s, command("account.profile", "", { name: "latest", expectedName: "after" }));
      const replay = await run(s, c);
      assert.equal(replay.resultUnavailable, true);
      assert.equal(replay.result, null);
      assert.equal((await db.user.findUnique({ where: { id: s.userId } })).name, "latest");
      await assert.rejects(run(s, profile()), (e) => e.code === "SETTINGS_PROFILE_VERSION_CONFLICT");
      assert.equal((await receipts(s)).length, 2);
    });
    await check("Workspace snapshot revision, durable replay and stale editor CAS", async () => {
      const s = await seed(),
        before = await settings.getWorkspaceSettings({ db, agencyId: s.agencyId, member: s.member });
      const c = command("workspace.update", "", {
        expectedRevision: before.revision,
        name: "Renamed",
        timezone: "Europe/Kyiv",
        vaultUploadRecipient: "relay_user",
      });
      const one = await run(s, c),
        two = await run(s, c);
      assert.equal(two.replayed, true);
      assert.deepEqual(one.result, two.result);
      assert.notEqual(one.result.revision, before.revision);
      await assert.rejects(
        run(s, command("workspace.update", "", { expectedRevision: before.revision, name: "stale" })),
        (e) => e.code === "SETTINGS_WORKSPACE_VERSION_CONFLICT"
      );
      assert.equal((await db.agency.findUnique({ where: { id: s.agencyId } })).name, "Renamed");
    });
    await check("Invalid workspace change rolls back every field and leaves no receipt", async () => {
      const s = await seed(),
        before = await settings.getWorkspaceSettings({ db, agencyId: s.agencyId, member: s.member });
      const c = command("workspace.update", "", {
        expectedRevision: before.revision,
        name: "Partial forbidden",
        timezone: "Invalid/Nowhere",
      });
      await assert.rejects(run(s, c), (e) => e.code === "SETTINGS_TIMEZONE_INVALID");
      assert.equal((await receipts(s)).length, 0);
      assert.equal((await db.agency.findUnique({ where: { id: s.agencyId } })).name, before.agency.name);
      const cancelled = await run(s, c, { cancel: true });
      assert.equal(cancelled.abandoned, true);
    });
    await check("Creator create has one canonical draft and exact replay after lost response", async () => {
      const s = await seed(),
        c = command("creator.create", "", {
          displayName: "New draft",
          username: "draft_" + seq,
          notes: "private note",
        }),
        one = await run(s, c),
        two = await run(s, c);
      assert.equal(two.replayed, true);
      assert.equal(two.result.creator.id, one.result.creator.id);
      assert.equal(await db.creatorAccount.count({ where: { agencyId: s.agencyId } }), 2);
      const stored = JSON.stringify(await receipts(s));
      assert.ok(!stored.includes("private note"));
      assert.ok(!stored.includes("New draft"));
    });
    await check("Creator metadata uses expected version and replay cannot reapply old fields", async () => {
      const s = await seed(),
        row = await db.creatorAccount.findUnique({ where: { id: s.creatorId } }),
        c = command("creator.update", s.creatorId, {
          expectedUpdatedAt: row.updatedAt.toISOString(),
          displayName: "Metadata edited",
        });
      const first = await run(s, c);
      assert.equal((await run(s, c)).replayed, true);
      await run(
        s,
        command("creator.update", s.creatorId, {
          expectedUpdatedAt: first.result.creator.updatedAt,
          displayName: "Latest",
        })
      );
      assert.equal((await run(s, c)).resultUnavailable, true);
      await assert.rejects(
        run(s, { ...c, commandId: crypto.randomUUID() }),
        (e) => e.code === "CREATOR_METADATA_VERSION_CONFLICT"
      );
    });
    await check("Proxy create lost response replays result instead of reporting original CAS conflict", async () => {
      const s = await seed(),
        c = proxy(s),
        one = await run(s, c),
        two = await run(s, c);
      assert.equal(two.replayed, true);
      assert.deepEqual(two.result, one.result);
      assert.equal(await db.agencyProxyEndpoint.count({ where: { agencyId: s.agencyId } }), 1);
      assert.equal(two.result.profile.proxyEndpointId, two.result.proxy.id);
    });
    await check("Proxy update replay increments endpoint and runtime revision only once", async () => {
      const s = await seed(),
        p = (await run(s, proxy(s))).result.proxy,
        c = command("network.update", p.id, {
          deviceId: "device",
          expectedVersion: p.version,
          host: "changed.example.test",
        });
      const one = await run(s, c),
        two = await run(s, c);
      assert.equal(two.replayed, true);
      assert.equal(two.result.proxy.version, 2);
      assert.deepEqual(two.result, one.result);
      assert.equal(
        (
          await db.creatorNetworkProfile.findUnique({
            where: { agencyId_creatorId: { agencyId: s.agencyId, creatorId: s.creatorId } },
          })
        ).version,
        2
      );
    });
    await check("Assignment replay preserves later network change instead of repeating the transition", async () => {
      const s = await seed(),
        p = (await run(s, proxy(s))).result,
        c = command("network.assign", s.creatorId, {
          expectedVersion: p.profile.version,
          mode: "DIRECT",
          proxyEndpointId: null,
        });
      const direct = await run(s, c);
      assert.equal((await run(s, c)).replayed, true);
      await run(
        s,
        command("network.assign", s.creatorId, {
          expectedVersion: direct.result.profile.version,
          mode: "PROXY",
          proxyEndpointId: p.proxy.id,
        })
      );
      assert.equal((await run(s, c)).resultUnavailable, true);
      assert.equal(
        (await network.getCreatorNetworkManifest({ db, agencyId: s.agencyId, creatorId: s.creatorId })).mode,
        "PROXY"
      );
    });
    await check("Proxy deletion replay never deletes a subsequently reused endpoint ID", async () => {
      const s = await seed(),
        p = (await run(s, proxy(s))).result;
      await run(s, command("network.assign", s.creatorId, { expectedVersion: p.profile.version, mode: "DIRECT" }));
      const c = command("network.delete", p.proxy.id, { expectedVersion: p.proxy.version });
      await run(s, c);
      await db.agencyProxyEndpoint.create({
        data: {
          id: p.proxy.id,
          agencyId: s.agencyId,
          ownerCreatorId: s.creatorId,
          label: "New identity",
          type: "SOCKS5",
          host: "new.example.test",
          port: 1080,
        },
      });
      assert.equal((await run(s, c)).replayed, true);
      assert.equal((await db.agencyProxyEndpoint.findUnique({ where: { id: p.proxy.id } })).label, "New identity");
    });
    await check("Changed payload or target cannot reuse any committed UUID", async () => {
      const s = await seed(),
        c = proxy(s);
      await run(s, c);
      await assert.rejects(
        run(s, { ...c, payload: { ...c.payload, label: "another" } }),
        (e) => e.code === "MANAGEMENT_COMMAND_CONFLICT"
      );
      await assert.rejects(run(s, { ...c, targetId: "other" }), (e) => e.code === "MANAGEMENT_COMMAND_CONFLICT");
    });
    await check("Abandon tombstone prevents a delayed original request from creating anything", async () => {
      const s = await seed(),
        c = proxy(s);
      assert.equal((await run(s, c, { cancel: true })).abandoned, true);
      await assert.rejects(run(s, c), (e) => e.code === "MANAGEMENT_COMMAND_ABANDONED");
      assert.equal(await db.agencyProxyEndpoint.count({ where: { agencyId: s.agencyId } }), 0);
    });
    await check("Cancel after commit reports completed and leaves the effect intact", async () => {
      const s = await seed(),
        c = profile();
      await run(s, c);
      const result = await run(s, c, { cancel: true });
      assert.equal(result.alreadyCommitted, true);
      assert.equal(result.abandoned, false);
      assert.equal((await db.user.findUnique({ where: { id: s.userId } })).name, "after");
      assert.equal((await receipts(s)).length, 1);
    });
    await check("Current access epoch is required even for committed replay", async () => {
      const s = await seed(),
        c = proxy(s);
      await run(s, c);
      await db.$transaction(async (tx) => {
        await generation(tx);
        await tx.agencyMember.update({
          where: { id: s.member.id },
          data: { permissions: { "creators.manage": true } },
        });
      });
      await assert.rejects(run(s, c), (e) => e.code === "MANAGEMENT_ACCESS_STALE");
      s.member = await db.agencyMember.findUnique({ where: { id: s.member.id } });
      assert.equal((await run(s, c)).replayed, true);
    });
    await check("Disabled account cannot read a committed receipt result or cancel a pending intent", async () => {
      const s = await seed(),
        c = proxy(s);
      await run(s, c);
      await disable(s);
      await assert.rejects(run(s, c), (e) => e.code === "MANAGEMENT_USER_DISABLED");
      await assert.rejects(run(s, c, { cancel: true }), (e) => e.code === "MANAGEMENT_USER_DISABLED");
    });
    await check("Replay rechecks original creator scope after committed delete", async () => {
      const s = await seed(),
        p = (await run(s, proxy(s))).result;
      await run(s, command("network.assign", s.creatorId, { expectedVersion: p.profile.version, mode: "DIRECT" }));
      const c = command("network.delete", p.proxy.id, { expectedVersion: 1 });
      await run(s, c);
      await db.$transaction(async (tx) => {
        await generation(tx);
        await tx.agencyMember.update({
          where: { id: s.member.id },
          data: { role: "MANAGER", roleKey: "manager", assignedCreators: [], permissions: { "creators.manage": true } },
        });
        const other = await tx.user.create({
          data: { email: "owner-" + s.userId + "@example.test", passwordHash: oldHash },
        });
        await tx.agencyMember.create({
          data: { agencyId: s.agencyId, userId: other.id, role: "OWNER", roleKey: "owner", assignedCreators: "all" },
        });
      });
      s.member = await db.agencyMember.findUnique({ where: { id: s.member.id } });
      await assert.rejects(run(s, c), (e) => e.code === "MANAGEMENT_CREATOR_SCOPE_REVOKED");
      assert.equal((await run(s, c, { cancel: true })).alreadyCommitted, true);
    });
    await check("Receipt insertion failure rolls back proxy and assignment in the same SQL transaction", async () => {
      const s = await seed(),
        c = proxy(s),
        faultDb = {
          $transaction: (work, options) =>
            db.$transaction(
              (tx) =>
                work(
                  new Proxy(tx, {
                    get(target, key) {
                      if (key === "$executeRawUnsafe")
                        return async (sql, ...args) => {
                          if (sql.startsWith('INSERT INTO "ManagementCommandReceipt"'))
                            throw Error("receipt disk simulation");
                          return target.$executeRawUnsafe(sql, ...args);
                        };
                      const v = target[key];
                      return typeof v === "function" ? v.bind(target) : v;
                    },
                  })
                ),
              options
            ),
        };
      await assert.rejects(run(s, c, { db: faultDb }), /receipt disk simulation/);
      assert.equal(await db.agencyProxyEndpoint.count({ where: { agencyId: s.agencyId } }), 0);
      assert.equal(await db.creatorNetworkProfile.count({ where: { agencyId: s.agencyId } }), 0);
      assert.equal((await receipts(s)).length, 0);
      assert.equal((await run(s, c)).replayed, false);
    });
    await check("Concurrent admitted same command requests yield one effect on serialized SQL adapter", async () => {
      const s = await seed(),
        c = proxy(s),
        results = await Promise.allSettled([run(s, c), run(s, c)]);
      const committed = results.filter((r) => r.status === "fulfilled");
      assert.ok(committed.length >= 1);
      for (const r of results) if (r.status === "rejected") assert.ok(["P2034", "P2010"].includes(r.reason.code));
      const replay = await run(s, c);
      assert.equal(replay.replayed, true);
      assert.equal(await db.agencyProxyEndpoint.count({ where: { agencyId: s.agencyId } }), 1);
      assert.equal((await receipts(s)).length, 1);
    });
    await check("Wrong device cannot replay a network command", async () => {
      const s = await seed(),
        c = proxy(s);
      await run(s, c);
      await assert.rejects(run(s, c, { deviceId: "another-device" }), (e) => e.code === "NETWORK_AUTH_DEVICE_MISMATCH");
    });
    await check("Raw credentials fail before a receipt or endpoint exists", async () => {
      const s = await seed(),
        c = proxy(s);
      c.payload.credentials = { password: "plaintext" };
      await assert.rejects(run(s, c), (e) => Boolean(e.issues));
      assert.equal((await receipts(s)).length, 0);
      assert.equal(await db.agencyProxyEndpoint.count({ where: { agencyId: s.agencyId } }), 0);
    });
    await check(
      "Agency hard-delete batch drains only that agency receipt identity with a bounded index walk",
      async () => {
        const s = await seed(),
          other = await seed();
        await run(s, profile());
        await run(other, profile());
        const purge =
          require("../../src/services/phase2-destructive-delete-authority-service").purgeAgencyNonFkTenantBatch;
        const result = await db.$transaction((tx) => purge({ tx, agencyId: s.agencyId, limit: 1 }));
        assert.equal(result.deleted, 1);
        assert.equal((await receipts(s)).length, 0);
        assert.equal((await receipts(other)).length, 1);
      }
    );
    await check("Oversized canonical result rolls back a fresh mutation and is unavailable on replay", async () => {
      const s = await seed(),
        row = await db.creatorAccount.findUnique({ where: { id: s.creatorId } });
      const c = command("creator.update", s.creatorId, {
        expectedUpdatedAt: row.updatedAt.toISOString(),
        displayName: "Original command",
      });
      await run(s, c);
      await db.$transaction(async (tx) => {
        await generation(tx);
        await require("../../src/services/phase2-release-compatibility-authority-service").authorizeCreatorAccountWrite(
          tx
        );
        await tx.creatorAccount.update({ where: { id: s.creatorId }, data: { notes: "x".repeat(260 * 1024) } });
      });
      assert.equal((await run(s, c)).resultUnavailable, true);
      const current = await db.creatorAccount.findUnique({ where: { id: s.creatorId } });
      await assert.rejects(
        run(
          s,
          command("creator.update", s.creatorId, {
            expectedUpdatedAt: current.updatedAt.toISOString(),
            displayName: "Must roll back",
          })
        ),
        (e) => e.code === "MANAGEMENT_COMMAND_RESULT_LIMIT"
      );
      assert.equal(
        (await db.creatorAccount.findUnique({ where: { id: s.creatorId } })).displayName,
        "Original command"
      );
      assert.equal((await receipts(s)).length, 1);
    });
    console.log(
      JSON.stringify({
        status: "PASS",
        cases: cases.length,
        actualPrisma: true,
        fullMigrationChain: true,
        physicalMultiSessionPostgres: false,
        externalServices: false,
      })
    );
  } finally {
    await db.$disconnect();
    await server.stop();
    await engine.close();
  }
}
main().then(
  () => {
    clearInterval(keepAlive);
    clearTimeout(deadline);
  },
  (e) => {
    console.error(e);
    clearInterval(keepAlive);
    clearTimeout(deadline);
    process.exitCode = 1;
  }
);

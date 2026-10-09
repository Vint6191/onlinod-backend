"use strict";
// Disposable full migration chain + actual application Prisma/services. Never
// connects to DATABASE_URL. Fault injection is deterministic, not native load.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createRequire } = require("node:module");
const { spawn } = require("node:child_process");
const { PrismaClient, Prisma } = require("@prisma/client");
const root = path.resolve(__dirname, "../..");

async function main() {
  if (!process.env.PHASE5_PROOF_RUNTIME) throw new Error("PHASE5_PROOF_RUNTIME required");
  const load = createRequire(path.resolve(process.env.PHASE5_PROOF_RUNTIME, "package.json"));
  const { PGlite } = load("@electric-sql/pglite");
  const { PGLiteSocketServer } = load("@electric-sql/pglite-socket");
  console.log("PROOF_ENGINE_START");
  const engine = await PGlite.create();
  console.log("PROOF_ENGINE_READY");
  const server = new PGLiteSocketServer({ db: engine, host: "127.0.0.1", port: 0 });
  await server.start();
  console.log("PROOF_SOCKET_READY");
  const url = `postgresql://postgres:postgres@${server.getServerConn()}/postgres?connection_limit=1&sslmode=disable`;
  const db = new PrismaClient({ datasources: { db: { url } } });
  const cases = [];
  const check = async (name, work) => {
    await work();
    cases.push({ name, status: "PASS" });
    console.log(JSON.stringify(cases.at(-1)));
  };
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [require.resolve("prisma/build/index.js"), "migrate", "deploy"], {
        cwd: root,
        env: { ...process.env, DATABASE_URL: url },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (b) => {
        output += b;
      });
      child.stderr.on("data", (b) => {
        output += b;
      });
      child.once("error", reject);
      child.once("close", (code) => (code ? reject(new Error(output)) : resolve()));
    });
    console.log("PROOF_MIGRATIONS_APPLIED");
    await engine.exec("DISCARD ALL");
    console.log("PROOF_WIRE_RESET");
    await engine.exec("SET TIME ZONE 'UTC'");
    console.log("PROOF_FIXTURE_DDL_READY");

    Object.assign(process.env, {
      NOWPAYMENTS_MODE: "sandbox",
      NOWPAYMENTS_API_KEY: "synthetic",
      NOWPAYMENTS_IPN_SECRET: "synthetic",
      PUBLIC_BASE_URL: "https://backend.test",
      NOWPAYMENTS_SANDBOX_ACTIVATE: "true",
    });
    require.cache[require.resolve("../../src/prisma")] = { exports: db };
    const router = require("../../src/routes/billing");
    const provider = require("../../src/services/billing-nowpayments-service");
    const generation = (tx) =>
      tx.$executeRawUnsafe(
        "SELECT set_config('onlinod.phase2_team_control_plane_generation',$1,true)",
        "phase2_team_control_plane_v2_durable_access"
      );
    let serial = 0,
      posts = 0,
      handler = null;
    global.fetch = async (_url, options) => {
      posts++;
      const body = JSON.parse(options.body);
      if (handler) return handler(body);
      return {
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({
            invoice_id: "invoice-" + body.order_id,
            invoice_url: "https://sandbox.nowpayments.io/payment/" + body.order_id,
            order_id: body.order_id,
            price_amount: body.price_amount,
            price_currency: "usd",
          }),
      };
    };
    async function seed() {
      const key = "d4-" + ++serial;
      return db.$transaction(async (tx) => {
        await generation(tx);
        const user = await tx.user.create({ data: { email: key + "@example.test", passwordHash: "synthetic" } });
        const agency = await tx.agency.create({ data: { name: key, trialEndsAt: new Date("2099-01-01") } });
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
        return { agencyId: agency.id, userId: user.id, member };
      });
    }
    async function disableActor(s) {
      await db.$transaction(async (tx) => {
        await generation(tx);
        await tx.agencyMember.update({ where: { id: s.member.id }, data: { role: "ADMIN", roleKey: "admin" } });
        const replacement = await tx.user.create({
          data: { email: "disable-" + s.userId + "@example.test", passwordHash: "synthetic" },
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
      assert.ok((await db.user.findUnique({ where: { id: s.userId } })).disabledAt, "fixture disable must persist");
    }
    const cmd = () => ({
      commandId: crypto.randomUUID(),
      action: "wallet.topup",
      targetId: "",
      payload: { amountCents: 6000, testMode: true },
    });
    async function call(s, input, path = "/wallet/top-up/v2", params = {}) {
      const route = router.stack.find((x) => x.route?.path === path).route;
      let status = 200,
        result;
      await route.stack[0].handle(
        { auth: { agencyId: s.agencyId, userId: s.userId, membership: s.member }, body: input, params },
        {
          status(n) {
            status = n;
            return this;
          },
          json(x) {
            result = x;
            return this;
          },
        }
      );
      if (status >= 400) throw Object.assign(Error(JSON.stringify(result)), { status, code: result.code });
      return result;
    }
    const ipn = async (body) => {
      const stable = (v) =>
        Array.isArray(v)
          ? v.map(stable)
          : v && typeof v === "object"
            ? Object.fromEntries(
                Object.keys(v)
                  .sort()
                  .map((k) => [k, stable(v[k])])
              )
            : v;
      const signature = crypto
        .createHmac("sha512", "synthetic")
        .update(JSON.stringify(stable(body)))
        .digest("hex");
      return provider.handleNowPaymentsIpn({ payload: body, signature, db });
    };
    await check("actual route: repeated UUID has one order and one provider invocation", async () => {
      const s = await seed(),
        input = cmd(),
        before = posts;
      const a = await call(s, input),
        b = await call(s, input);
      assert.equal(a.commandId, input.commandId);
      assert.equal(a.order.id, b.order.id);
      assert.equal(b.replayed, true);
      assert.equal(posts - before, 1);
      assert.equal(await db.billingOrder.count({ where: { agencyId: s.agencyId } }), 1);
    });
    await check("real transactions: concurrent caller during provider I/O only reads the reservation", async () => {
      const s = await seed(),
        input = cmd(),
        before = posts;
      let enter, release;
      const entered = new Promise((r) => (enter = r));
      handler = async () => {
        enter();
        await new Promise((r) => (release = r));
        throw Error("timeout");
      };
      const a = call(s, input);
      await entered;
      const b = await call(s, input);
      assert.equal(b.order.status, "CREATED");
      assert.equal(b.checkoutUrl, "");
      release();
      await a;
      handler = null;
      assert.equal(posts - before, 1);
    });
    await check("provider timeout and process retry never submit a second invoice", async () => {
      const s = await seed(),
        input = cmd(),
        before = posts;
      handler = async () => {
        throw Error("timeout");
      };
      const a = await call(s, input);
      handler = null;
      const b = await call(s, input);
      assert.equal(a.order.status, "CREATED");
      assert.equal(b.order.providerStatus, "INVOICE_OUTCOME_UNKNOWN");
      assert.equal(a.order.id, b.order.id);
      assert.equal(posts - before, 1);
    });
    for (const finalStatus of ["PAID", "REFUNDED"])
      for (const failResponse of [false, true])
        await check(
          `${finalStatus} IPN precedes invoice ${failResponse ? "failure" : "success"}: state and wallet remain monotonic`,
          async () => {
            const s = await seed(),
              input = cmd(),
              before = posts;
            let paidPayload;
            handler = async (body) => {
              paidPayload = {
                payment_id: "payment-" + body.order_id,
                invoice_id: "invoice-" + body.order_id,
                order_id: body.order_id,
                payment_status: "finished",
                price_amount: 60,
                price_currency: "usd",
              };
              await ipn(paidPayload);
              if (finalStatus === "REFUNDED") await ipn({ ...paidPayload, payment_status: "refunded" });
              if (failResponse) throw Error("late lost reply");
              return {
                ok: true,
                status: 201,
                text: async () =>
                  JSON.stringify({
                    invoice_id: "invoice-" + body.order_id,
                    invoice_url: "https://sandbox.nowpayments.io/payment/" + body.order_id,
                  }),
              };
            };
            const result = await call(s, input);
            handler = null;
            assert.equal(result.order.status, finalStatus);
            assert.equal(result.checkoutUrl, "");
            await ipn({ ...paidPayload, proof_delivery: 2 });
            await call(s, input);
            const rows = await db.billingWalletTransaction.findMany({ where: { agencyId: s.agencyId } });
            assert.equal(rows.length, finalStatus === "PAID" ? 1 : 2);
            assert.equal(
              rows.reduce((sum, r) => sum + r.amountCents, 0n),
              finalStatus === "PAID" ? 6000n : 0n
            );
            assert.equal((await db.billingOrder.findUnique({ where: { id: result.order.id } })).status, finalStatus);
            assert.equal(posts - before, 1);
          }
        );
    await check("same UUID rejects changed amount and changed payment environment", async () => {
      const s = await seed(),
        input = cmd(),
        before = posts;
      await call(s, input);
      await assert.rejects(() => call(s, { ...input, payload: { ...input.payload, amountCents: 7000 } }), {
        code: "BILLING_CHECKOUT_SELECTION_MISMATCH",
      });
      process.env.NOWPAYMENTS_MODE = "live";
      try {
        await assert.rejects(() => call(s, { ...input, payload: { ...input.payload, testMode: false } }), {
          code: "BILLING_PROVIDER_ENVIRONMENT_MISMATCH",
        });
        const old = await call(s, input);
        assert.equal(old.checkoutUrl, "");
        assert.equal(old.order.providerInvoiceUrl, null);
      } finally {
        process.env.NOWPAYMENTS_MODE = "sandbox";
      }
      assert.equal(posts - before, 1);
    });
    await check("stale membership epoch refuses both replay and resume", async () => {
      const s = await seed(),
        input = cmd(),
        r = await call(s, input);
      await db.$transaction(async (tx) => {
        await generation(tx);
        await tx.agencyMember.update({ where: { id: s.member.id }, data: { accessEpoch: { increment: 1 } } });
      });
      await assert.rejects(() => call(s, input), { code: "MANAGEMENT_ACCESS_STALE" });
      await assert.rejects(() => call(s, {}, "/orders/:orderId/resume", { orderId: r.order.id }), {
        code: "MANAGEMENT_ACCESS_STALE",
      });
    });
    await check("owner disable before reservation produces no order and no invoice", async () => {
      const s = await seed(),
        before = posts;
      await disableActor(s);
      await assert.rejects(() => call(s, cmd()), { code: "MANAGEMENT_USER_DISABLED" });
      assert.equal(posts, before);
      assert.equal(await db.billingOrder.count({ where: { agencyId: s.agencyId } }), 0);
    });
    await check("owner demotion is checked from live storage before replay", async () => {
      const s = await seed(),
        input = cmd();
      await call(s, input);
      await db.$transaction(async (tx) => {
        await generation(tx);
        await tx.agencyMember.update({ where: { id: s.member.id }, data: { role: "ADMIN", roleKey: "admin" } });
        const user = await tx.user.create({
          data: { email: "replacement-" + s.userId + "@example.test", passwordHash: "synthetic" },
        });
        await tx.agencyMember.create({
          data: { agencyId: s.agencyId, userId: user.id, role: "OWNER", roleKey: "owner", assignedCreators: "all" },
        });
      });
      await assert.rejects(() => call(s, input), { code: "MANAGEMENT_ACCESS_STALE" });
      s.member = await db.agencyMember.findUnique({ where: { id: s.member.id } });
      assert.equal(s.member.role, "ADMIN");
      await assert.rejects(() => call(s, input), { code: "BILLING_OWNER_ONLY" });
    });
    await check("owner revocation during external I/O retains invoice but withholds URL", async () => {
      const s = await seed(),
        input = cmd();
      handler = async (body) => {
        await disableActor(s);
        return {
          ok: true,
          status: 201,
          text: async () =>
            JSON.stringify({
              invoice_id: "invoice-" + body.order_id,
              invoice_url: "https://sandbox.nowpayments.io/payment/" + body.order_id,
            }),
        };
      };
      try {
        await assert.rejects(() => call(s, input), { code: "MANAGEMENT_USER_DISABLED" });
      } finally {
        handler = null;
      }
      assert.equal((await db.billingOrder.findFirst({ where: { agencyId: s.agencyId } })).status, "CHECKOUT_CREATED");
    });
    await check("agency isolation uses authenticated tenant even for the same UUID", async () => {
      const a = await seed(),
        b = await seed(),
        input = cmd(),
        one = await call(a, input),
        two = await call(b, input);
      assert.notEqual(one.order.id, two.order.id);
      assert.equal(await db.billingOrder.count({ where: { agencyId: b.agencyId } }), 1);
    });
    await check("invalid command and retired unkeyed endpoint cannot create a reservation", async () => {
      const s = await seed(),
        before = posts;
      await assert.rejects(() => call(s, { ...cmd(), payload: { amountCents: 0, testMode: true } }), { status: 400 });
      await assert.rejects(() => call(s, {}, "/wallet/top-up"), { status: 410 });
      assert.equal(posts, before);
      assert.equal(await db.billingOrder.count({ where: { agencyId: s.agencyId } }), 0);
    });
    await check("Team recovery: rejected payload cancellation persists a tombstone and protects its UUID", async () => {
      const s = await seed();
      const execute = require("../../src/services/team-command-service").executeTeamCommand;
      const input = { commandId: crypto.randomUUID(), action: "role.create", targetId: "", payload: { label: [] } };
      const args = { db, agencyId: s.agencyId, userId: s.userId, input };
      await assert.rejects(() => execute(args));
      assert.equal((await execute({ ...args, cancel: true })).abandoned, true);
      assert.equal((await execute({ ...args, cancel: true })).abandoned, true);
      await assert.rejects(() => execute({ ...args, input: { ...input, payload: { label: "Corrected" } } }), {
        code: "TEAM_COMMAND_INTENT_MISMATCH",
      });
      assert.equal(await db.agencyCustomRole.count({ where: { agencyId: s.agencyId } }), 0);
    });
    await check("unique reservation lookup uses the existing BillingOrder index", async () => {
      const s = await seed(),
        input = cmd();
      await call(s, input);
      const plan = await db.$queryRawUnsafe(
        `EXPLAIN (FORMAT JSON) SELECT * FROM "BillingOrder" WHERE "agencyId"=$1 AND provider='NOWPAYMENTS' AND "testMode"=true AND "checkoutKey"=$2`,
        s.agencyId,
        input.commandId
      );
      assert.match(JSON.stringify(plan), /Index Scan|Index Only Scan|Bitmap/);
    });
    console.log(
      JSON.stringify({
        status: "PASS",
        cases: cases.length,
        actualPrisma: true,
        fullMigrationChain: true,
        physicalMultiSessionPostgres: false,
        externalProvider: false,
      })
    );
  } finally {
    await db.$disconnect();
    await server.stop();
    await engine.close();
  }
}
const keepAlive = setInterval(() => {}, 1000);
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => clearInterval(keepAlive));

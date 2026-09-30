"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { ACTIONS, parse } = require("./telegram-control-command-service");
const {
  credentialRevision,
  accountRevision,
  readReminderState,
  assertAuthorizationIdle,
  publicAccount,
} = require("./telegram-control-state");
const { encryptTelegramCredentials } = require("./telegram-mtproto-credentials");
const { normalizeTelegramCustomReminders } = require("./custom-order-reminders");
const origin = { deviceId: "d", originAuthorizationSessionId: "login" },
  hash = "a".repeat(64);
function command(action) {
  const data =
    action === "telegram.create"
      ? { apiId: 123, apiHash: "a".repeat(32) }
      : action === "telegram.session"
        ? { session: "synthetic-private-session", expectedCredentialRevision: hash }
        : action === "telegram.reminders"
          ? { reminders: normalizeTelegramCustomReminders(null), expectedRevision: hash }
          : action === "telegram.forceRetire"
            ? { reason: "lost device", acknowledgeLostObservations: true, expectedRevision: hash }
            : { expectedRevision: hash };
  return {
    commandId: randomUUID(),
    action,
    targetId: ["telegram.create", "telegram.reminders"].includes(action) ? "" : "account",
    payload: { ...origin, ...data },
  };
}
for (const action of ACTIONS)
  test(`${action}: strict complete shape binds same execute/cancel identity`, () => {
    const c = command(action);
    assert.equal(parse(c).fingerprint, parse(c, true).fingerprint);
    assert.throws(() => parse({ ...c, payload: { ...c.payload, extra: true } }));
    const copy = structuredClone(c);
    delete copy.payload.deviceId;
    assert.throws(() => parse(copy));
    assert.throws(() => parse({ ...c, targetId: c.targetId ? "" : "unexpected" }));
    assert.throws(() => parse({ ...c, actorProof: "unexpected" }));
  });
for (const invalid of ["", " x", "x ", "x".repeat(262145)])
  test(`session validation rejects empty, padded or oversized input ${invalid.length}`, () => {
    const c = command("telegram.session");
    assert.throws(() => parse({ ...c, payload: { ...c.payload, session: invalid } }));
  });
test("oversized cancel envelope cannot bypass payload bound", () => {
  const c = command("telegram.session");
  assert.throws(() => parse({ ...c, payload: { session: "x".repeat(273 * 1024) } }, true), {
    code: "TELEGRAM_CONTROL_PAYLOAD_LIMIT",
  });
});
test("force retirement needs explicit acknowledgement, reason and displayed revision", () => {
  const c = command("telegram.forceRetire");
  for (const patch of [{ acknowledgeLostObservations: false }, { reason: " " }, { expectedRevision: "" }])
    assert.throws(() => parse({ ...c, payload: { ...c.payload, ...patch } }));
});
test("policy contract rejects excessive offsets, negative intervals and oversized text", () => {
  const c = command("telegram.reminders");
  for (const mutate of [
    (p) => {
      p.call.offsetsMinutes = Array(13).fill(1);
    },
    (p) => {
      p.content.firstAfterMinutes = 0;
    },
    (p) => {
      p.physical.text = "a".repeat(2001);
    },
  ]) {
    const copy = structuredClone(c);
    mutate(copy.payload.reminders);
    assert.throws(() => parse(copy));
  }
});
test("credential revision changes on randomized encryption, even for the same secret", () => {
  const r = { id: "a", apiId: 123, ...encryptTelegramCredentials({ apiHash: "a".repeat(32), session: "same-secret" }) };
  assert.notEqual(
    credentialRevision(r),
    credentialRevision({ ...r, ...encryptTelegramCredentials({ apiHash: "a".repeat(32), session: "same-secret" }) })
  );
  assert.notEqual(credentialRevision(r), credentialRevision({ ...r, apiId: 124 }));
});
test("management revision binds lifecycle and runtime identity but ignores lease heartbeat time", () => {
  const r = { id: "a", apiId: 1, lifecycleState: "ACTIVE", ...encryptTelegramCredentials({ apiHash: "a".repeat(32) }) };
  assert.equal(accountRevision(r), accountRevision({ ...r, runtimeClaimUntil: new Date() }));
  for (const patch of [
    { lifecycleState: "RETIRING" },
    { runtimeClaimGeneration: 1 },
    { runtimeDrainedGeneration: 1 },
    { runtimeClaimToken: "new" },
    { runtimeClaimedByDeviceId: "d" },
  ])
    assert.notEqual(accountRevision(r), accountRevision({ ...r, ...patch }));
});
test("public connection omits every secret and runtime credential", () => {
  const r = {
    id: "a",
    apiId: 1,
    lifecycleState: "ACTIVE",
    runtimeClaimToken: "private-claim",
    ...encryptTelegramCredentials({ apiHash: "a".repeat(32), session: "private-session" }),
  };
  const out = JSON.stringify(publicAccount(r, new Date()));
  assert.doesNotMatch(out, /private|apiHash|encryptedPayload|runtimeClaimToken/);
  assert.equal(publicAccount(r, new Date()).sessionReady, true);
});
test("undecipherable connection stays visible with sessionReady false", () => {
  assert.equal(
    publicAccount({ id: "a", apiId: 1, lifecycleState: "ACTIVE", iv: "bad" }, new Date()).sessionReady,
    false
  );
});
test("expired lease alone cannot authorize over undrained observations", () => {
  assert.throws(
    () =>
      assertAuthorizationIdle(
        {
          lifecycleState: "ACTIVE",
          runtimeClaimGeneration: 3,
          runtimeDrainedGeneration: 2,
          runtimeClaimUntil: new Date(0),
        },
        new Date()
      ),
    { code: "TELEGRAM_AUTH_RUNTIME_NOT_DRAINED" }
  );
  assert.doesNotThrow(() =>
    assertAuthorizationIdle(
      { lifecycleState: "ACTIVE", runtimeClaimGeneration: 3, runtimeDrainedGeneration: 3 },
      new Date()
    )
  );
});
test("reminder policy and dependency generation use one snapshot, and storage failure propagates", async () => {
  let count = 0;
  const db = {
    $queryRawUnsafe: async (sql, agency, key) => {
      count++;
      assert.match(sql, /LEFT JOIN "Phase2DependencyState"/);
      assert.equal(agency, "a");
      assert.equal(key, "telegramCustomReminders");
      return [{ value: null, revision: "1" }];
    },
  };
  const a = await readReminderState(db, "a");
  assert.equal(count, 1);
  const b = await readReminderState({ $queryRawUnsafe: async () => [{ value: null, revision: "2" }] }, "a");
  assert.notEqual(a.remindersRevision, b.remindersRevision);
  await assert.rejects(
    readReminderState(
      {
        $queryRawUnsafe: async () => {
          throw Error("storage unavailable");
        },
      },
      "a"
    ),
    /storage unavailable/
  );
});
const gateway = require("../middleware/retired-telegram-control-writes");
for (const [method, path] of [
  ["PATCH", "/telegram/reminders"],
  ["POST", "/telegram/accounts"],
  ["DELETE", "/telegram/accounts/a/"],
  ["POST", "/TELEGRAM/ACCOUNTS/a/force-retire"],
  ["PUT", "/telegram/accounts/a/session"],
])
  test(`${method} ${path}: legacy mutation retired before any secret or disk handler`, () => {
    let next = false;
    const res = {
      status(v) {
        this.code = v;
        return this;
      },
      json(v) {
        this.body = v;
        return this;
      },
    };
    gateway({ method, path }, res, () => {
      next = true;
    });
    assert.equal(next, false);
    assert.equal(res.code, 410);
  });
test("gateway preserves local material, runtime lease and reads", () => {
  for (const [method, path] of [
    ["GET", "/telegram"],
    ["POST", "/telegram/accounts/a/local-material"],
    ["POST", "/telegram/runtime/claim"],
    ["POST", "/telegram/runtime/a/release"],
  ]) {
    let next = false;
    gateway({ method, path }, {}, () => {
      next = true;
    });
    assert.equal(next, true);
  }
});
test("routes use current signed actor and safe errors without echoing invalid secret payload", () => {
  const source = fs.readFileSync(require.resolve("../routes/telegram-control-commands"), "utf8");
  assert.match(source, /router.use\(authRequired\)/);
  assert.match(source, /\.\.\.req.auth/);
  assert.match(source, /no-store/);
  assert.doesNotMatch(source, /console\.|error.issues\)/);
});

test("authorize aliases cannot fall through to legacy unversioned material reader", () => {
  const source = fs.readFileSync(require.resolve("../routes/settings"), "utf8");
  assert.match(source, /String\(req.body\?\.purpose \|\| ""\)\.trim\(\)\.toLowerCase\(\) === "authorize"/);
  assert.match(source, /readTelegramAuthorizationMaterial\(\{[\s\S]*actorMember: req.auth.membership/);
});

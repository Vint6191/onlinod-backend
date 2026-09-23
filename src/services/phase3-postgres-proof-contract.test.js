"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { inspectSource, inspectRepository, knownVoidFunctions } = require("../../scripts/audit/phase3-prisma-source-contract");
const { compactProofFailure, failureDigest, parseTapFailures } = require("../../scripts/audit/phase3-a20-postgres-proof");
const { runPhase3InterleavedTransactions } = require("../../scripts/test-support/phase3-interleaved-transactions");
const ROOT = path.resolve(__dirname, "../..");

test("Phase3 Prisma preflight rejects enum literals using the generated model contract, not business role names", () => {
  const bad = inspectSource('db.agencyMember.create({ data: { role: "CHATTER", roleKey: "chatter" } });');
  assert.equal(bad.length, 1);
  assert.match(bad[0].message, /UserRole requires OWNER \| ADMIN \| MANAGER \| OPERATOR/);
  assert.deepEqual(inspectSource('db.agencyMember.create({ data: { role: "OPERATOR", roleKey: "chatter" } });'), []);
  assert.equal(inspectSource('const data = { role: "CHATTER" }; db.agencyMember.create({data});').length, 1);
  assert.equal(inspectSource('db.agencyMember.updateMany({ data: { role: { set: "CHATTER" } } });').length, 1);
  assert.equal(inspectSource('db.agencyMember.createMany({ data: [{role: "OPERATOR"}, {role: "CHATTER"}] });').length, 1);
  assert.equal(inspectSource('db.agencyMember.upsert({create: {role: "CHATTER"}, update: {role: "CHATTER"}});').length, 2);
});

test("Phase3 Prisma preflight rejects queryRaw void commands across literal, const and tagged SQL", () => {
  const voidFunctions = knownVoidFunctions(ROOT);
  assert.ok(voidFunctions.has("phase2_assert_creator_destructive_insert_allowed"));
  for (const snippet of [
    'db.$queryRawUnsafe("SELECT pg_sleep(0.5)");',
    'const sql = "SELECT pg_advisory_xact_lock(123)"; tx.$queryRawUnsafe(sql);',
    'tx.$queryRaw`SELECT pg_sleep(${seconds}::double precision)`;',
    'tx.$queryRawUnsafe(`SELECT "phase2_assert_creator_destructive_insert_allowed"($1,$2,$3)`, a, b, c);',
    'tx.$queryRawUnsafe(`SELECT public.pg_sleep($1::double precision) AS ignored`, seconds);',
  ]) {
    const violations = inspectSource(snippet, { voidFunctions });
    assert.equal(violations.length, 1, snippet);
    assert.match(violations[0].message, /cannot deserialize PostgreSQL void/);
  }
});

test("Phase3 Prisma preflight allows command execution, typed results and boolean try-locks; comments are not code", () => {
  for (const snippet of [
    'tx.$executeRawUnsafe("SELECT pg_sleep($1::double precision)", seconds);',
    'tx.$executeRaw`SELECT pg_sleep(${seconds}::double precision)`;',
    'tx.$queryRawUnsafe("SELECT pg_sleep($1::double precision)::text", seconds);',
    'tx.$queryRawUnsafe("SELECT pg_try_advisory_xact_lock(1) AS acquired");',
    '// db.agencyMember.create({data:{role:"CHATTER"}})\nconst example = "SELECT pg_sleep(1)";',
    'const example = \'db.$queryRawUnsafe("SELECT pg_sleep(1)")\';',
  ]) assert.deepEqual(inspectSource(snippet), [], snippet);
});

test("Phase3 Prisma preflight covers all production/scripts/physical fixtures without a stale file allowlist", () => {
  const result = inspectRepository(ROOT);
  assert.ok(result.files > 300);
  assert.deepEqual(result.violations, []);
  const gate = fs.readFileSync(path.join(ROOT, "scripts/audit/phase3-a26-changed-js-gate.js"), "utf8");
  assert.match(gate, /inspectRepository\(ROOT\)/);
  assert.match(gate, /&& prismaContracts\.ok/);
  const render = fs.readFileSync(path.join(ROOT, "scripts/audit/phase3-a29-render-gate.js"), "utf8");
  const offlineGate = render.indexOf('phase: "proof-contracts-pass"');
  assert.ok(offlineGate > render.indexOf('phase: "changed-js-pass"'));
  assert.ok(offlineGate < render.indexOf("await createDisposableDatabase(admin, database)"));
  const { CONTRACT_PROOFS } = require("../../scripts/audit/phase3-a29-render-gate");
  assert.ok(CONTRACT_PROOFS.includes(__filename), "Render must actually run these regressions before PostgreSQL");
});

function client(name, events) {
  return {
    async $transaction(work) {
      try {
        return await work({
          // No raw-query adapter: schema pinning is covered by the physical
          // suite; these tests exercise only the scheduling/error contract.
          async $executeRawUnsafe(sql) { assert.match(sql, /SET LOCAL lock_timeout/); },
        });
      } finally {
        events.push(`${name}:settled`);
      }
    },
  };
}

test("Phase3 interleave barrier guarantees both first writes before either second write", async () => {
  const events = [];
  const first = (name) => async () => { events.push(`${name}:first`); };
  const second = (name) => async () => {
    assert.ok(events.includes("a:first") && events.includes("b:first"));
    events.push(`${name}:second`);
  };
  await runPhase3InterleavedTransactions({
    dbA: client("a", events), dbB: client("b", events),
    firstA: first("a"), firstB: first("b"), secondA: second("a"), secondB: second("b"),
  });
  assert.equal(events.filter((item) => item.endsWith(":second")).length, 2);
  assert.equal(events.filter((item) => item.endsWith(":settled")).length, 2);
});

test("Phase3 interleave failure releases the peer and settles both clients before teardown", async () => {
  const events = [];
  const original = new Error("first write failed");
  const neverSecond = async () => { assert.fail("no second write after failed first write"); };
  await assert.rejects(() => runPhase3InterleavedTransactions({
    dbA: client("a", events), dbB: client("b", events),
    firstA: async () => { throw original; },
    firstB: async () => { await delay(20); events.push("b:first"); },
    secondA: neverSecond, secondB: neverSecond,
  }), (error) => error === original);
  assert.ok(events.includes("b:first"));
  assert.equal(events.filter((item) => item.endsWith(":settled")).length, 2);
});

test("Phase3 interleave barrier times out without false success or background teardown races", async () => {
  const events = [];
  const neverSecond = async () => { assert.fail("no second write after barrier timeout"); };
  await assert.rejects(() => runPhase3InterleavedTransactions({
    dbA: client("a", events), dbB: client("b", events), barrierTimeoutMs: 10,
    firstA: async () => {}, firstB: async () => { await delay(40); },
    secondA: neverSecond, secondB: neverSecond,
  }), { code: "PHASE3_PROOF_INTERLEAVE_TIMEOUT" });
  assert.equal(events.filter((item) => item.endsWith(":settled")).length, 2);
});

test("Phase3 interleave timeout stops at barrier arrival, not at slow commit completion", async () => {
  const events = [];
  await runPhase3InterleavedTransactions({
    dbA: client("a", events), dbB: client("b", events), barrierTimeoutMs: 10,
    firstA: async () => {}, firstB: async () => {},
    secondA: async () => { await delay(40); }, secondB: async () => { await delay(40); },
  });
  assert.equal(events.filter((item) => item.endsWith(":settled")).length, 2);
});

test("Phase3 interleave propagates post-barrier transaction failure and waits for the other commit", async () => {
  const events = [];
  const original = new Error("deferred trigger failed");
  await assert.rejects(() => runPhase3InterleavedTransactions({
    dbA: client("a", events), dbB: client("b", events),
    firstA: async () => {}, firstB: async () => {},
    secondA: async () => { throw original; }, secondB: async () => { await delay(20); events.push("b:committed"); },
  }), (error) => error === original);
  assert.ok(events.includes("b:committed"));
  assert.equal(events.filter((item) => item.endsWith(":settled")).length, 2);
});

test("Phase3 interleave never turns a non-Error rejection into success", async () => {
  const events = [];
  const results = await Promise.allSettled([runPhase3InterleavedTransactions({
    dbA: client("a", events), dbB: client("b", events),
    firstA: async () => { throw null; }, firstB: async () => {},
    secondA: async () => { assert.fail("must not continue"); },
    secondB: async () => { assert.fail("must not continue"); },
  })]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[0].reason, null);
  assert.equal(events.filter((item) => item.endsWith(":settled")).length, 2);
});

test("Phase3 console errors are bounded and preserve Prisma reason while report data stays lossless", () => {
  const reason = "Invalid value for argument role. Expected UserRole.";
  const failure = {
    name: "member-scoped claim", code: "PrismaClientValidationError",
    error: "Invalid prisma.agencyMember.create() invocation:\n" + "creator-0123456789\n".repeat(4000) + reason,
    stack: "stack\n".repeat(3000),
  };
  const compact = compactProofFailure(failure);
  assert.ok(compact.error.length <= 2400);
  assert.ok(compact.stack.length <= 1400);
  assert.ok(compact.error.startsWith("Invalid prisma.agencyMember.create() invocation:"));
  assert.ok(compact.error.endsWith(reason));
  assert.ok(failure.error.length > 70_000, "do not mutate persisted report values");
  assert.equal(compact.code, failure.code);
  assert.equal(compactProofFailure(null), null);
});

test("Phase3 failure digest deduplicates overlapping windows by source position and bounds long lines", () => {
  const digest = failureDigest("before\nnot ok 3 - member-scoped claim\n  error: PrismaClientValidationError\nunique-line\n  location: test.js:1\nend", "");
  assert.equal(digest.split("\n").filter((line) => line === "unique-line").length, 1);
  const huge = failureDigest("not ok 1 - error: " + "x".repeat(70_000) + " Expected UserRole.", "");
  assert.ok(huge.length <= 12_000);
  assert.ok(huge.includes("Expected UserRole."));
});

test("Phase3 TAP parsing retains full multiline error for artifacts; console compaction is separate", () => {
  const body = "Invalid invocation\n" + "creator-id\n".repeat(1000) + "Expected UserRole.";
  const tap = "not ok 3 - member-scoped claim\n  ---\n  error: |-\n" + body.split("\n").map((line) => "    " + line).join("\n") + "\n  code: 'ERR_TEST_FAILURE'\n  ...\n1..3\n";
  const failures = parseTapFailures(tap);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].error, body);
  assert.ok(compactProofFailure(failures[0]).error.endsWith("Expected UserRole."));
});

test("Phase3 member proof tears down User through the same generation-fenced fixture graph", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/services/phase3-a34-source-scale-closure.integration.test.js"), "utf8");
  assert.match(source, /cleanupPhase3PostgresFixtureGraph\(dbA, \{ agencyId, userIds: \[userId\] \}\)/);
  assert.doesNotMatch(source, /dbA\.user\.deleteMany/);
  assert.equal((source.match(/await runPhase3InterleavedTransactions\(/g) || []).length, 4);
  assert.doesNotMatch(source, /SELECT pg_sleep/);
});

function actorFixtureAdapter({ failMember = false, accessEpoch = 7 } = {}) {
  const committed = [];
  let transactions = 0;
  const db = { async $transaction(work) {
    transactions += 1;
    const draft = [];
    const tx = {
      agency: { create: async ({ data }) => { draft.push({ kind: "agency", ...data }); return data; } },
      user: { create: async ({ data }) => { draft.push({ kind: "user", ...data }); return data; } },
      agencyMember: { create: async ({ data }) => {
        assert.ok(draft.some((row) => row.kind === "agency" && row.id === data.agencyId), "member needs its real parent agency");
        assert.ok(draft.some((row) => row.kind === "user" && row.id === data.userId), "member needs its real parent user");
        if (failMember) throw Object.assign(new Error("member creation failed"), { code: "FIXTURE_MEMBER_FAILED" });
        const row = { kind: "member", ...data, accessEpoch };
        draft.push(row);
        return row;
      } },
    };
    const result = await work(tx);
    committed.push(...draft);
    return result;
  } };
  return { db, committed, transactions: () => transactions };
}

test("Phase3 actor fixture commits one owned Agency/User/Member graph and uses persisted accessEpoch", async () => {
  const { createPhase3PostgresActorFixture } = require("../../scripts/audit/phase3-postgres-proof-fixture-authority");
  const state = actorFixtureAdapter();
  const actor = await createPhase3PostgresActorFixture(state.db, "actor-fixture");
  assert.equal(state.transactions(), 1);
  assert.equal(state.committed.length, 3);
  assert.deepEqual(actor, { agencyId: "actor-fixture-agency", userId: "actor-fixture-user", memberId: "actor-fixture-member", accessEpoch: 7 });
});

test("Phase3 actor fixture does not leave Agency/User roots after member setup failure", async () => {
  const { createPhase3PostgresActorFixture } = require("../../scripts/audit/phase3-postgres-proof-fixture-authority");
  const state = actorFixtureAdapter({ failMember: true });
  await assert.rejects(createPhase3PostgresActorFixture(state.db, "broken-actor"), { code: "FIXTURE_MEMBER_FAILED" });
  assert.deepEqual(state.committed, []);
});

test("Phase3 actor fixture rejects missing persisted authority instead of manufacturing accessEpoch", async () => {
  const { createPhase3PostgresActorFixture } = require("../../scripts/audit/phase3-postgres-proof-fixture-authority");
  const state = actorFixtureAdapter({ accessEpoch: null });
  await assert.rejects(createPhase3PostgresActorFixture(state.db, "broken-epoch"), { code: "PHASE3_POSTGRES_FIXTURE_ACCESS_EPOCH_REQUIRED" });
  assert.deepEqual(state.committed, []);
  await assert.rejects(createPhase3PostgresActorFixture(state.db, ""), { code: "PHASE3_POSTGRES_FIXTURE_PREFIX_REQUIRED" });
  assert.equal(state.transactions(), 1);
});

test("Phase3 block observer requires actual blocking PIDs rather than an elapsed sleep", async () => {
  const { waitForPhase3PostgresBlock } = require("../../scripts/test-support/phase3-postgres-lock-wait");
  let calls = 0;
  const db = { async $queryRawUnsafe(sql, holder, waiter) {
    assert.match(sql, /pg_blocking_pids/);
    assert.deepEqual([holder, waiter], [101, 202]);
    return [{ blocked: ++calls > 1, authorityNow: new Date() }];
  } };
  assert.equal((await waitForPhase3PostgresBlock({ db, holderPid: 101, waiterPid: 202 })).blocked, true);
  assert.equal(calls, 2);
});

test("Phase3 block observer fails closed on absent overlap, invalid PIDs and query failure", async () => {
  const { waitForPhase3PostgresBlock } = require("../../scripts/test-support/phase3-postgres-lock-wait");
  const db = { $queryRawUnsafe: async () => [{ blocked: false }] };
  await assert.rejects(waitForPhase3PostgresBlock({ db, holderPid: 1, waiterPid: 2, timeoutMs: 1 }), { code: "PHASE3_PROOF_LOCK_WAIT_NOT_OBSERVED" });
  await assert.rejects(waitForPhase3PostgresBlock({ db, holderPid: 1, waiterPid: 1 }), { code: "PHASE3_PROOF_LOCK_PIDS_INVALID" });
  await assert.rejects(waitForPhase3PostgresBlock({ db, holderPid: 1, waiterPid: 2, timeoutMs: Infinity }), { code: "PHASE3_PROOF_LOCK_TIMEOUT_INVALID" });
  const error = new Error("observer disconnected");
  await assert.rejects(waitForPhase3PostgresBlock({ db: { $queryRawUnsafe: async () => { throw error; } }, holderPid: 1, waiterPid: 2 }), (actual) => actual === error);
});

test("Phase3 lease deadline waits through executeRaw and cannot decode PostgreSQL void", async () => {
  const { waitUntilPhase3DatabaseTime } = require("../../scripts/test-support/phase3-postgres-lock-wait");
  const deadline = new Date();
  let calls = 0;
  const tx = {
    $queryRawUnsafe: async () => assert.fail("pg_sleep must not use queryRaw"),
    $executeRawUnsafe: async (sql, value) => { assert.match(sql, /pg_sleep/); assert.equal(value, deadline); calls += 1; },
  };
  await waitUntilPhase3DatabaseTime(tx, deadline);
  assert.equal(calls, 1);
  await assert.rejects(waitUntilPhase3DatabaseTime(tx, new Date(NaN)), { code: "PHASE3_PROOF_LEASE_DEADLINE_INVALID" });
});

for (const exact of [false, true]) {
  test(`Phase3 fixture graph deletes User inside admitted transaction after Agency (${exact ? "exact claim" : "legacy marker"})`, async (t) => {
    const { cleanupPhase3PostgresFixtureGraph, auditSchemaFromDatabaseUrl } = require("../../scripts/audit/phase3-postgres-proof-fixture-authority");
    const release = require("./phase2-release-compatibility-authority-service");
    const domainWork = require("./domain-work-authority-service");
    const events = [];
    t.mock.method(domainWork, "publishDomainWork", async (input) => {
      assert.equal(input.agencyId, "fixture-agency");
      events.push("publish-claim");
      return { id: "fixture-work" };
    });
    t.mock.method(domainWork, "claimDomainWorkBatch", async (input) => ({
      items: [{ id: "fixture-work" }], ownerToken: input.ownerToken,
    }));
    const db = {
      async $transaction(work) {
        const settings = new Map();
        const deleted = (kind) => async () => {
          assert.equal(settings.get(release.TEAM_CONTROL_PLANE_DB_SETTING), release.TEAM_CONTROL_PLANE_GENERATION);
          events.push(`delete-${kind}`);
          return { count: 1 };
        };
        return work({
          async $executeRawUnsafe(sql) { assert.match(sql, /pg_advisory_xact_lock_shared/); return 1; },
          async $queryRawUnsafe(sql, ...args) {
            if (sql.includes("WITH exact_function")) return [{
              topologyMigrationApplied: exact, exactMigrationApplied: exact,
              topologyTablePresent: exact, exactFunctionInstalled: exact,
            }];
            if (sql.includes('FROM "Phase2ReleaseCompatibilityAuthority"')) return [{
              requiredGeneration: release.TEAM_CONTROL_PLANE_GENERATION, activationState: "ACTIVE",
            }];
            if (sql.includes("SELECT set_config($1,$2,true)")) {
              settings.set(args[0], args[1]);
              return [{ value: args[1] }];
            }
            if (sql.includes("set_config('search_path'")) return [{ value: args[0] }];
            if (sql.includes("current_schema()")) return [{ currentSchema: auditSchemaFromDatabaseUrl() }];
            if (sql.includes("set_config('onlinod.phase2_destructive_agency_id'")) {
              assert.equal(args[0], "fixture-agency");
              if (exact) assert.equal(args[1], "fixture-work");
              return [];
            }
            assert.fail(`unexpected fixture SQL: ${sql}`);
          },
          domainWorkItem: { deleteMany: deleted("work") },
          creatorAccount: { deleteMany: deleted("creator") },
          agency: { deleteMany: deleted("agency") },
          user: { deleteMany: deleted("user") },
        });
      },
      user: { async deleteMany() { assert.fail("root-client User cleanup loses the transaction-local generation"); } },
    };
    const result = await cleanupPhase3PostgresFixtureGraph(db, { agencyId: "fixture-agency", userIds: ["fixture-user"] });
    assert.equal(result.usersDeleted, 1);
    assert.deepEqual(events.filter((event) => event.startsWith("delete-")), ["delete-work", "delete-creator", "delete-agency", "delete-user"]);
    assert.equal(events.includes("publish-claim"), exact);
  });
}

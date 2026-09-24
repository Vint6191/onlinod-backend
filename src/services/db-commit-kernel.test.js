"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { setTimeout: delay } = require("node:timers/promises");
const {
  runRootCommit, joinCommit, currentCommitContext, classifyCommitConflict,
  commitAuthorityNow, deferCommitHint, discardCommitHints,
} = require("./db-commit-kernel");

const retryOptions = { retryBaseMs: 1 };

test("a rejected domain savepoint can discard hints while its receipt commits", async () => {
  const published = [];
  const db = rootDb();
  await runRootCommit(db, async context => {
    deferCommitHint(context, "domain", () => published.push("rolled-back-domain"));
    discardCommitHints(context);
    deferCommitHint(context, "receipt", () => published.push("receipt"));
    return { rejected: true };
  }, { maxHints: 1 });
  assert.equal(db.calls[0].committed, true);
  assert.deepEqual(published, ["receipt"]);
});

test("discarding hints requires the active owning context", async () => {
  assert.throws(() => discardCommitHints({}), { code: "DB_COMMIT_CONTEXT_REQUIRED" });
  let closed;
  await runRootCommit(rootDb(), context => { closed = context; });
  assert.throws(() => discardCommitHints(closed), { code: "DB_COMMIT_CONTEXT_CLOSED" });
});
function conflict(code = "40001") {
  return Object.assign(new Error("controlled DB conflict"), { code: "P2010", meta: { code } });
}
function rootDb({ commitError = null } = {}) {
  const calls = [];
  const root = { calls, async $transaction(work, options) {
    const call = { options, sql: [], committed: false };
    calls.push(call);
    const tx = { async $executeRawUnsafe(...args) { call.sql.push(args); return 1; } };
    const result = await work(tx);
    if (commitError) await commitError(calls.length);
    call.committed = true;
    return result;
  } };
  return root;
}

test("root requires a root client and join requires a kernel-issued context", async () => {
  await assert.rejects(runRootCommit({}, () => {}), { code: "DB_COMMIT_ROOT_REQUIRED" });
  await assert.rejects(joinCommit({ tx: {} }, {}, () => {}), { code: "DB_COMMIT_CONTEXT_REQUIRED" });
});

test("the root cannot masquerade as its own transaction client", async () => {
  const db = { $transaction: async (work) => work(db) };
  await assert.rejects(runRootCommit(db, () => assert.fail("non-transaction admitted")), { code: "DB_COMMIT_TRANSACTION_CLIENT_REQUIRED" });
});

test("join shares the exact transaction and rejects an isolation upgrade", async () => {
  const db = rootDb();
  await runRootCommit(db, async (context) => {
    assert.equal(currentCommitContext(), context);
    await joinCommit(context, { isolationLevel: "ReadCommitted" }, async (joined) => assert.equal(joined.tx, context.tx));
    await assert.rejects(joinCommit(context, { isolationLevel: "Serializable" }, () => {}), { code: "DB_COMMIT_JOIN_ISOLATION_MISMATCH" });
  });
  assert.equal(db.calls.length, 1);
});

test("joined authority cannot cross agency, creator, actor or intent", async () => {
  await runRootCommit(rootDb(), async (context) => {
    for (const requirement of [{ authorityKind: "ADMIN" }, { agencyId: "other" }, { creatorId: "other" }, { userId: "other" }]) {
      await assert.rejects(joinCommit(context, requirement, () => assert.fail("scope crossed")), (error) => /DB_COMMIT_JOIN_(AUTHORITY|SCOPE)_MISMATCH/.test(error.code));
    }
    await joinCommit(context, { authorityKind: "PRODUCT", agencyId: "a", creatorId: "c", userId: "u" }, () => 1);
  }, { authority: { kind: "PRODUCT", agencyId: "a", creatorId: "c", userId: "u" } });
});

test("a stronger root may join a weaker requirement without opening a second transaction", async () => {
  const db = rootDb();
  await runRootCommit(db, (context) => joinCommit(context, { isolationLevel: "ReadCommitted" }, () => 7), { profile: "SECRET_READ" });
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].options.isolationLevel, "Serializable");
});

test("root escape is rejected even with a different root client", async () => {
  const first = rootDb(), second = rootDb();
  await runRootCommit(first, async (context) => {
    for (const db of [first, second, context.tx]) await assert.rejects(runRootCommit(db, () => {}), { code: "DB_COMMIT_NESTED_ROOT_FORBIDDEN" });
  });
  assert.equal(second.calls.length, 0);
});

test("closed contexts cannot be reused after commit or rollback", async () => {
  let committed, rolledBack;
  await runRootCommit(rootDb(), (ctx) => { committed = ctx; });
  await assert.rejects(runRootCommit(rootDb(), (ctx) => { rolledBack = ctx; throw new Error("rollback"); }));
  for (const context of [committed, rolledBack]) {
    await assert.rejects(joinCommit(context, {}, () => {}), { code: "DB_COMMIT_CONTEXT_CLOSED" });
    assert.throws(() => deferCommitHint(context, "late", () => {}), { code: "DB_COMMIT_CONTEXT_CLOSED" });
  }
});

for (const sqlState of ["40001", "40P01"]) {
  test(`raw ${sqlState} retries the whole operation with fresh context and authority reads`, async () => {
    const db = rootDb();
    const attempts = [], contexts = [];
    const result = await runRootCommit(db, (context) => {
      attempts.push(context.attempt); contexts.push(context);
      if (context.attempt < 3) throw conflict(sqlState);
      return "done";
    }, retryOptions);
    assert.equal(result, "done");
    assert.deepEqual(attempts, [1, 2, 3]);
    assert.equal(new Set(contexts).size, 3);
    assert.equal(new Set(contexts.map((ctx) => ctx.rootId)).size, 1);
  });
}

test("DB clock wrapper retains SQLSTATE classification through cause", async () => {
  let calls = 0;
  await runRootCommit(rootDb(), () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error("clock query failed", { cause: conflict() }), { code: "DB_TIME_AUTHORITY_QUERY_FAILED" });
  }, retryOptions);
  assert.equal(calls, 2);
});

test("business rejection, uniqueness and unknown outcomes are never blindly retried", async () => {
  const errors = [
    Object.assign(new Error("unique"), { code: "P2002" }),
    Object.assign(new Error("timeout"), { code: "P2028" }),
    Object.assign(new Error("connection lost"), { code: "P1001" }),
    Object.assign(new Error("business conflict", { cause: conflict() }), { code: "STALE_INPUT", status: 409 }),
    Object.assign(new Error("forbidden"), { status: 403 }),
    conflict("23505"),
  ];
  for (const error of errors) {
    const db = rootDb();
    await assert.rejects(runRootCommit(db, () => { throw error; }, retryOptions), (caught) => caught === error);
    assert.equal(db.calls.length, 1);
  }
});

test("root owns conflict exhaustion and preserves the original cause", async () => {
  const db = rootDb(), error = conflict();
  await assert.rejects(runRootCommit(db, () => { throw error; }, { ...retryOptions, conflictCode: "DOMAIN_CONFLICT" }), (caught) => caught.code === "DOMAIN_CONFLICT" && caught.status === 409 && caught.cause === error);
  assert.equal(db.calls.length, 3);
});

test("joined work does not own another retry loop", async () => {
  let childRuns = 0;
  const db = rootDb();
  await runRootCommit(db, (ctx) => joinCommit(ctx, {}, () => {
    childRuns += 1;
    if (childRuns < 3) throw conflict();
    return 1;
  }), retryOptions);
  assert.equal(childRuns, 3);
  assert.equal(db.calls.length, 3);
});

test("retry and rollback discard attempt hints; publication follows actual commit", async () => {
  const db = rootDb({ commitError: (attempt) => { if (attempt === 1) throw conflict(); } });
  const published = [];
  await runRootCommit(db, (ctx) => {
    deferCommitHint(ctx, "same", () => published.push(-1));
    deferCommitHint(ctx, "same", () => {
      assert.equal(db.calls.at(-1).committed, true);
      assert.equal(currentCommitContext(), null);
      published.push(ctx.attempt);
    });
    assert.deepEqual(published, []);
  }, retryOptions);
  assert.deepEqual(published, [2]);
  await assert.rejects(runRootCommit(db, (ctx) => {
    deferCommitHint(ctx, "rollback", () => published.push(99));
    throw new Error("reject");
  }));
  assert.deepEqual(published, [2]);
});

test("hint errors cannot report failure or retry an already committed command", async () => {
  const db = rootDb();
  const result = await runRootCommit(db, (ctx) => {
    deferCommitHint(ctx, "broken", () => { throw conflict(); });
    return { persisted: true };
  });
  assert.deepEqual(result, { persisted: true });
  assert.equal(db.calls.length, 1);
});

test("hint budget is bounded and a duplicate key does not consume another slot", async () => {
  await runRootCommit(rootDb(), (ctx) => {
    deferCommitHint(ctx, "one", () => {});
    deferCommitHint(ctx, "one", () => {});
    assert.throws(() => deferCommitHint(ctx, "two", () => {}), { code: "DB_COMMIT_HINT_CAPACITY" });
  }, { maxHints: 1 });
});

test("separate concurrent roots retain isolated contexts without a global mutex", async () => {
  const db = rootDb();
  let entered = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const ids = await Promise.all(["a", "b"].map((agencyId) => runRootCommit(db, async (ctx) => {
    entered += 1;
    if (entered === 2) release();
    await gate;
    assert.equal(currentCommitContext(), ctx);
    return ctx.authority.agencyId;
  }, { authority: { kind: "PRODUCT", agencyId } })));
  assert.deepEqual(ids, ["a", "b"]);
});

test("total deadline includes failed attempts and backoff", async () => {
  const db = rootDb();
  await assert.rejects(runRootCommit(db, async () => {
    await delay(15);
    throw conflict();
  }, { ...retryOptions, deadlineMs: 10, maxWait: 1, timeout: 8 }), { code: "P2010" });
  assert.equal(db.calls.length, 1);
  assert.ok(db.calls[0].options.maxWait + db.calls[0].options.timeout <= 10);
});

test("SQL lock and statement budgets are transaction-local and capped by remaining timeout", async () => {
  const db = rootDb();
  await runRootCommit(db, () => 1, { deadlineMs: 50, maxWait: 10, timeout: 40 });
  const call = db.calls[0];
  assert.match(call.sql[0][0], /set_config\('lock_timeout', \$1, true\)/);
  for (const value of call.sql[0].slice(1)) assert.ok(Number.parseInt(value) <= call.options.timeout);
});

test("a joined operation cannot claim the unused command budget beyond its root transaction timeout", async () => {
  await runRootCommit(rootDb(), async (ctx) => {
    await assert.rejects(joinCommit(ctx, { remainingMs: 1000 }, () => {}), { code: "DB_COMMIT_JOIN_BUDGET_INSUFFICIENT" });
  }, { deadlineMs: 20000, timeout: 100, maxWait: 10 });
});

test("DB authority time is re-read at each domain boundary", async () => {
  let time = 1000;
  const db = { async $transaction(work) { return work({ $queryRawUnsafe: async () => [{ authorityNow: new Date(time += 1000) }] }); } };
  await runRootCommit(db, async (ctx) => {
    assert.equal((await commitAuthorityNow(ctx)).getTime(), 2000);
    assert.equal((await commitAuthorityNow(ctx)).getTime(), 3000);
  });
});

test("invalid budgets and cyclic error causes are bounded", async () => {
  for (const options of [{ timeout: Infinity }, { maxAttempts: 20 }, { deadlineMs: 0 }, { profile: "missing" }]) {
    const db = rootDb();
    await assert.rejects(runRootCommit(db, () => {}, options));
    assert.equal(db.calls.length, 0);
  }
  const error = new Error("cycle"); error.cause = error;
  assert.equal(classifyCommitConflict(error), null);
});

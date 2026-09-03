"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

function cacheModule(request, exports) {
  const id = require.resolve(request);
  const previous = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports };
  return () => {
    delete require.cache[id];
    if (previous) require.cache[id] = previous;
  };
}
function fresh(request) {
  const id = require.resolve(request);
  delete require.cache[id];
  return require(request);
}
function clone(value) {
  if (value == null) return value;
  return structuredClone(value);
}
function makeDb() {
  let row = null;
  let seq = 0;
  const matches = (where, candidate) => {
    if (!candidate) return false;
    for (const [key, expected] of Object.entries(where || {})) {
      if (key === "OR" && Array.isArray(expected)) {
        if (!expected.some((branch) => matches(branch, candidate))) return false;
        continue;
      }
      if (key === "claimUntil" && expected && typeof expected === "object") {
        if (!(candidate.claimUntil instanceof Date)) return false;
        if (expected.gt && !(candidate.claimUntil > expected.gt)) return false;
        if (expected.lte && !(candidate.claimUntil <= expected.lte)) return false;
        continue;
      }
      if (expected && typeof expected === "object" && Object.hasOwn(expected, "not")) {
        if (candidate[key] === expected.not) return false;
        continue;
      }
      if (expected && typeof expected === "object" && Array.isArray(expected.in)) {
        if (!expected.in.includes(candidate[key])) return false;
        continue;
      }
      if (candidate[key] !== expected) return false;
    }
    return true;
  };
  const apply = (data) => {
    for (const [key, value] of Object.entries(data || {})) {
      if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "increment")) {
        row[key] = Number(row[key] || 0) + Number(value.increment || 0);
      } else {
        row[key] = value;
      }
    }
    row.updatedAt = new Date();
  };
  const db = {
    workerDevice: {
      findFirst: async ({ where }) => ["device-a", "device-b"].includes(where?.id) && where?.agencyId === "agency-a" && where?.userId === "user-a"
        ? { id: where.id, agencyId: "agency-a", userId: "user-a" }
        : null,
    },
    auditLog: { create: async ({ data }) => data },
    automationDelivery: {
      findUnique: async ({ where }) => {
        if (!row) return null;
        if (where.id != null) return where.id === row.id ? row : null;
        if (where.idempotencyKey != null) return where.idempotencyKey === row.idempotencyKey ? row : null;
        return null;
      },
      findFirst: async ({ where }) => matches(where, row) ? row : null,
      findMany: async ({ where }) => matches(where, row) ? [row] : [],
      create: async ({ data }) => {
        if (row && row.idempotencyKey === data.idempotencyKey) {
          const e = new Error("unique"); e.code = "P2002"; throw e;
        }
        row = {
          id: `write-${++seq}`,
          writeCommitRevision: 0,
          leaseRevision: 0,
          result: {},
          ...clone(data),
        };
        return row;
      },
      updateMany: async ({ where, data }) => {
        if (!matches(where, row)) return { count: 0 };
        apply(clone(data));
        return { count: 1 };
      },
    },
    $transaction: async (fn) => fn(db),
    $executeRawUnsafe: async () => 1,
  };
  return { db, getRow: () => row };
}

async function withAuthority(run) {
  const fx = makeDb();
  const permissions = [];
  const access = { enabled: true };
  const restores = [];
  try {
    restores.push(cacheModule("../prisma", fx.db));
    restores.push(cacheModule("./team-access-control", {
      canUsePermission: async ({ key }) => { permissions.push(key); return key === "chats.mass_message" || key === "content.manage_vault"; },
    }));
    restores.push(cacheModule("./execution-access-fence-service", {
      ExecutionAccessFenceError: class ExecutionAccessFenceError extends Error {},
      assertExecutionAccessFence: async ({ agencyId, userId, memberId, accessEpoch, creatorId }) => {
        if (!access.enabled) {
          const error = new Error("creator access revoked");
          error.code = "CREATOR_ACCESS_FORBIDDEN";
          error.status = 403;
          throw error;
        }
        return { member: { id: memberId, agencyId, userId, accessEpoch, assignedCreators: [creatorId] }, accessEpoch };
      },
    }));
    restores.push(cacheModule("./automation-write-commit-fence-service", { lockAutomationWriteCommitFence: async () => ({ ok: true }) }));
    restores.push(cacheModule("./automation-failure-taxonomy", {
      FAILURE_CATEGORIES: {
        OUTCOME_UNKNOWN_RECONCILE: "OUTCOME_UNKNOWN_RECONCILE",
        TERMINAL: "TERMINAL",
        IDEMPOTENT_RETRYABLE: "IDEMPOTENT_RETRYABLE",
        DEFINITE_NO_WRITE_RETRYABLE: "DEFINITE_NO_WRITE_RETRYABLE",
      },
      classifyAutomationFailure: ({ provenNoEffect, idempotent, reachedWire }) => {
        if (provenNoEffect) return "DEFINITE_NO_WRITE_RETRYABLE";
        if (idempotent) return "IDEMPOTENT_RETRYABLE";
        if (reachedWire) return "OUTCOME_UNKNOWN_RECONCILE";
        return "DEFINITE_NO_WRITE_RETRYABLE";
      },
    }));
    const authority = fresh("./programmatic-of-write-authority-service");
    await run({ ...fx, permissions, access, authority });
  } finally {
    delete require.cache[require.resolve("./programmatic-of-write-authority-service")];
    for (const restore of restores.reverse()) restore();
  }
}

const base = {
  kind: "MASS_QUEUE_CREATE",
  agencyId: "agency-a",
  userId: "user-a",
  memberId: "member-a",
  accessEpoch: 7,
  creatorId: "creator-a",
  deviceId: "device-a",
  idempotencyKey: "mass:creator-a:dispatch-a",
  payloadFingerprint: "sha256:aaaaaaaaaaaaaaaa",
};

test("Audit17 schema generalizes AutomationDelivery instead of creating a second write table", () => {
  const schema = fs.readFileSync(path.resolve(ROOT, "../prisma/schema.prisma"), "utf8");
  const migration = fs.readFileSync(path.resolve(ROOT, "../prisma/migrations/20260902183000_audit17_programmatic_write_authority/migration.sql"), "utf8");
  assert.match(schema, /model AutomationDelivery \{[\s\S]*fanId\s+String\?[\s\S]*originKind\s+String[\s\S]*sourceDeviceId\s+String\?[\s\S]*payloadFingerprint\s+String\?[\s\S]*executionKind\s+String\?[\s\S]*reconciliationKind\s+String\?/);
  assert.doesNotMatch(schema, /model\s+(?:ProgrammaticWrite|MassWriteJob|VaultWriteJob|CustomUploadWriteJob)\s*\{/);
  assert.match(migration, /ALTER COLUMN "fanId" DROP NOT NULL/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "originKind"/);
});

test("Audit17 neutral authority is mounted and does not use automation.manage as product permission", () => {
  const server = read("server.js");
  const route = read("routes/programmatic-of-writes.js");
  const service = read("services/programmatic-of-write-authority-service.js");
  const manifest = read("route-manifest.js");
  assert.match(server, /app\.use\("\/api\/programmatic-of-writes", authRequired, programmaticOfWriteRoutes\)/);
  assert.match(manifest, /\/api\/programmatic-of-writes/);
  assert.doesNotMatch(route, /automation\.manage/);
  assert.doesNotMatch(service, /automation\.manage/);
  assert.match(service, /chats\.mass_message/);
  assert.match(service, /content\.manage_vault/);
});

test("Audit17 MASS reserve uses product permission, stable idempotency binding and replay", async () => {
  await withAuthority(async ({ authority, permissions, getRow }) => {
    const first = await authority.reserveProgrammaticWrite(base);
    assert.equal(first.delivery.status, "CLAIMED");
    assert.equal(first.delivery.originKind, "INTERACTIVE");
    assert.equal(first.replay, false);
    assert.ok(first.lease.token);
    assert.deepEqual(permissions, ["chats.mass_message"]);
    assert.equal(getRow().fanId, null);

    const replay = await authority.reserveProgrammaticWrite(base);
    assert.equal(replay.replay, true);
    assert.equal(replay.delivery.id, first.delivery.id);
    assert.equal(replay.delivery.leaseRevision, 2);

    await assert.rejects(
      () => authority.reserveProgrammaticWrite({ ...base, payloadFingerprint: "sha256:bbbbbbbbbbbbbbbb" }),
      (error) => error?.code === "IDEMPOTENCY_CONFLICT" && error?.status === 409,
    );
  });
});

test("Audit17 programmatic reserve cannot poison another product idempotency namespace", async () => {
  await withAuthority(async ({ authority }) => {
    for (const key of [
      "bump_send:future-key",
      "sfs_comment:future-key",
      "vault-relay:creator-a:item-a",
      "mass:creator-b:dispatch-a",
      "mass:creator-a:",
    ]) {
      await assert.rejects(
        () => authority.reserveProgrammaticWrite({ ...base, idempotencyKey: key }),
        (error) => [
          "PROGRAMMATIC_WRITE_IDEMPOTENCY_NAMESPACE_MISMATCH",
          "PROGRAMMATIC_WRITE_IDEMPOTENCY_CREATOR_MISMATCH",
          "PROGRAMMATIC_WRITE_IDEMPOTENCY_SUFFIX_REQUIRED",
        ].includes(error?.code),
      );
    }
  });
});

test("Audit17 durable success requires the remote identity canonical for each programmatic kind", async () => {
  const cases = [
    { kind: "MASS_QUEUE_CREATE", idempotencyKey: "mass:creator-a:dispatch-proof", result: {}, field: "queueId" },
    { kind: "VAULT_CREATE_LIST", idempotencyKey: "vault-create-list:creator-a:list-proof", result: {}, field: "folderId" },
    { kind: "VAULT_RELAY_SEND", idempotencyKey: "vault-relay:creator-a:relay-proof", result: {}, field: "mediaId" },
    { kind: "CUSTOM_RELAY_SEND", idempotencyKey: "custom-relay:submission-proof:0", result: {}, field: "mediaId" },
  ];
  for (const item of cases) {
    await withAuthority(async ({ authority, getRow }) => {
      const input = { ...base, kind: item.kind, idempotencyKey: item.idempotencyKey };
      const reserved = await authority.reserveProgrammaticWrite(input);
      await authority.startProgrammaticWrite({ ...input, writeId: reserved.delivery.id, leaseToken: reserved.lease.token, leaseRevision: reserved.lease.revision });
      await authority.prepareProgrammaticWrite({ ...input, writeId: reserved.delivery.id, leaseToken: reserved.lease.token, leaseRevision: reserved.lease.revision });
      await assert.rejects(
        () => authority.completeProgrammaticWrite({ ...input, writeId: reserved.delivery.id, leaseToken: reserved.lease.token, leaseRevision: reserved.lease.revision, result: item.result }),
        (error) => error?.code === "PROGRAMMATIC_WRITE_COMPLETION_EVIDENCE_REQUIRED",
      );
      assert.equal(getRow().status, "COMMITTING", `${item.kind} must remain COMMITTING without ${item.field}`);
      const evidence = item.field === "queueId" ? { queueId: "queue-proof" } : item.field === "folderId" ? { folderId: "folder-proof" } : { mediaId: "media-proof" };
      const completed = await authority.completeProgrammaticWrite({ ...input, writeId: reserved.delivery.id, leaseToken: reserved.lease.token, leaseRevision: reserved.lease.revision, result: evidence });
      assert.equal(completed.delivery.status, "COMPLETED");
      assert.equal(completed.delivery.result[item.field], evidence[item.field]);
    });
  }
});

test("Audit17 prepare creates one durable COMMITTING permit and complete replay survives erased lease token", async () => {
  await withAuthority(async ({ authority, getRow }) => {
    const reserved = await authority.reserveProgrammaticWrite(base);
    const lease = reserved.lease;
    await authority.startProgrammaticWrite({ ...base, writeId: reserved.delivery.id, leaseToken: lease.token, leaseRevision: lease.revision });
    const prepared = await authority.prepareProgrammaticWrite({ ...base, writeId: reserved.delivery.id, leaseToken: lease.token, leaseRevision: lease.revision });
    assert.equal(prepared.delivery.status, "COMMITTING");
    assert.equal(prepared.writeCommitRevision, 1);

    const completed = await authority.completeProgrammaticWrite({ ...base, writeId: reserved.delivery.id, leaseToken: lease.token, leaseRevision: lease.revision, result: { queueId: "queue-1" } });
    assert.equal(completed.delivery.status, "COMPLETED");
    assert.equal(completed.delivery.result.queueId, "queue-1");
    assert.equal(getRow().leaseTokenHash, null);

    const replay = await authority.completeProgrammaticWrite({ ...base, writeId: reserved.delivery.id, leaseToken: "response-lost-old-token", leaseRevision: lease.revision, result: { queueId: "queue-1" } });
    assert.equal(replay.duplicate, true);
    assert.equal(replay.delivery.result.queueId, "queue-1");
  });
});

test("Audit17 active COMMITTING cannot be taken over; only an expired commit lease becomes RECONCILE_REQUIRED", async () => {
  await withAuthority(async ({ authority, getRow }) => {
    const reserved = await authority.reserveProgrammaticWrite(base);
    await authority.startProgrammaticWrite({ ...base, writeId: reserved.delivery.id, leaseToken: reserved.lease.token, leaseRevision: reserved.lease.revision });
    await authority.prepareProgrammaticWrite({ ...base, writeId: reserved.delivery.id, leaseToken: reserved.lease.token, leaseRevision: reserved.lease.revision });
    const revision = getRow().leaseRevision;

    await assert.rejects(
      () => authority.reserveProgrammaticWrite(base),
      (error) => error?.code === "PROGRAMMATIC_WRITE_COMMIT_IN_FLIGHT",
    );
    assert.equal(getRow().status, "COMMITTING");
    assert.equal(getRow().leaseRevision, revision);

    getRow().claimUntil = new Date(Date.now() - 1_000);
    const recovered = await authority.reserveProgrammaticWrite(base);
    assert.equal(recovered.reconciliationRequired, true);
    assert.equal(recovered.delivery.status, "RECONCILE_REQUIRED");
    await assert.rejects(
      () => authority.prepareProgrammaticWrite({ ...base, writeId: recovered.delivery.id, leaseToken: recovered.lease.token, leaseRevision: recovered.lease.revision }),
      (error) => error?.code === "PROGRAMMATIC_WRITE_RECONCILIATION_REQUIRED",
    );
  });
});

test("Audit17 writeId cannot be rebound to another creator or write kind", async () => {
  await withAuthority(async ({ authority }) => {
    const reserved = await authority.reserveProgrammaticWrite(base);
    await assert.rejects(
      () => authority.startProgrammaticWrite({ ...base, creatorId: "creator-b", writeId: reserved.delivery.id, leaseToken: reserved.lease.token, leaseRevision: reserved.lease.revision }),
      (error) => error?.code === "PROGRAMMATIC_WRITE_CREATOR_MISMATCH",
    );
    await assert.rejects(
      () => authority.startProgrammaticWrite({ ...base, kind: "VAULT_CREATE_LIST", writeId: reserved.delivery.id, leaseToken: reserved.lease.token, leaseRevision: reserved.lease.revision }),
      (error) => error?.code === "PROGRAMMATIC_WRITE_KIND_MISMATCH",
    );
  });
});

test("Audit17 settlement routes bind the signed device but do not demand a fresh product permission after COMMITTING", () => {
  const route = read("routes/programmatic-of-writes.js");
  const complete = route.slice(route.indexOf('router.post("/:writeId/complete"'), route.indexOf('router.post("/:writeId/fail"'));
  const fail = route.slice(route.indexOf('router.post("/:writeId/fail"'), route.indexOf('router.post("/:writeId/reconcile"'));
  for (const source of [complete, fail]) {
    assert.match(source, /publicKindDevice/);
    assert.doesNotMatch(source, /publicKindAccess/);
  }
  assert.match(route, /publicKindDevice[\s\S]*requireProductDevice/);
});

test("Audit17 reconciliation MATCHED recovers remote success without another commit permit", async () => {
  await withAuthority(async ({ authority, getRow }) => {
    const reserved = await authority.reserveProgrammaticWrite(base);
    await authority.startProgrammaticWrite({ ...base, writeId: reserved.delivery.id, leaseToken: reserved.lease.token, leaseRevision: reserved.lease.revision });
    await authority.prepareProgrammaticWrite({ ...base, writeId: reserved.delivery.id, leaseToken: reserved.lease.token, leaseRevision: reserved.lease.revision });
    getRow().claimUntil = new Date(Date.now() - 1_000);

    const recovered = await authority.reserveProgrammaticWrite(base);
    assert.equal(recovered.delivery.status, "RECONCILE_REQUIRED");
    const settled = await authority.reconcileProgrammaticWrite({
      ...base,
      writeId: recovered.delivery.id,
      leaseToken: recovered.lease.token,
      leaseRevision: recovered.lease.revision,
      outcome: "MATCHED",
      result: { queueId: "queue-readback-1" },
    });
    assert.equal(settled.delivery.status, "COMPLETED");
    assert.equal(settled.delivery.result.queueId, "queue-readback-1");
    assert.equal(getRow().writeCommitRevision, 1);
    assert.equal(getRow().leaseTokenHash, null);
  });
});

test("Audit17 readback absence cannot claim PROVEN_NO_EFFECT for current business-write kinds", async () => {
  await withAuthority(async ({ authority, getRow }) => {
    const first = await authority.reserveProgrammaticWrite(base);
    await authority.startProgrammaticWrite({ ...base, writeId: first.delivery.id, leaseToken: first.lease.token, leaseRevision: first.lease.revision });
    await authority.prepareProgrammaticWrite({ ...base, writeId: first.delivery.id, leaseToken: first.lease.token, leaseRevision: first.lease.revision });
    getRow().claimUntil = new Date(Date.now() - 1_000);

    const recovered = await authority.reserveProgrammaticWrite(base);
    await assert.rejects(
      () => authority.reconcileProgrammaticWrite({
        ...base,
        writeId: recovered.delivery.id,
        leaseToken: recovered.lease.token,
        leaseRevision: recovered.lease.revision,
        outcome: "PROVEN_NO_EFFECT",
        result: { evidence: "readback-empty" },
      }),
      (error) => error?.code === "PROGRAMMATIC_WRITE_NO_EFFECT_PROOF_REQUIRED",
    );
    assert.equal(getRow().status, "RECONCILE_REQUIRED");
    assert.equal(getRow().writeCommitRevision, 1);
  });
});

test("Audit17 prewrite checkpoint is durable before COMMITTING and cannot be rewritten after permit", async () => {
  await withAuthority(async ({ authority, getRow }) => {
    const reserved = await authority.reserveProgrammaticWrite(base);
    const lease = reserved.lease;
    await authority.startProgrammaticWrite({ ...base, writeId: reserved.delivery.id, leaseToken: lease.token, leaseRevision: lease.revision });
    const checkpointed = await authority.checkpointProgrammaticWrite({
      ...base,
      writeId: reserved.delivery.id,
      leaseToken: lease.token,
      leaseRevision: lease.revision,
      result: { massPreflight: { queueIds: ["100"], observedAt: "now" } },
    });
    assert.equal(checkpointed.delivery.status, "RUNNING");
    assert.deepEqual(getRow().result.massPreflight.queueIds, ["100"]);
    await authority.prepareProgrammaticWrite({ ...base, writeId: reserved.delivery.id, leaseToken: lease.token, leaseRevision: lease.revision });
    await assert.rejects(
      () => authority.checkpointProgrammaticWrite({ ...base, writeId: reserved.delivery.id, leaseToken: lease.token, leaseRevision: lease.revision, result: { massPreflight: { queueIds: ["evil"] } } }),
      (error) => error?.code === "PROGRAMMATIC_WRITE_CHECKPOINT_FORBIDDEN",
    );
  });
});

test("Audit17 Custom relay mint stays behind the Custom product adapter", () => {
  const generic = read("routes/programmatic-of-writes.js");
  const custom = read("routes/custom-orders.js");
  const submissions = read("services/custom-content-submissions-service.js");
  assert.match(generic, /PUBLIC_RESERVE_KINDS = new Set\(\["MASS_QUEUE_CREATE", "VAULT_RELAY_SEND", "VAULT_CREATE_LIST"\]\)/);
  assert.match(generic, /PUBLIC_LEASE_KINDS = new Set\(\[\.\.\.PUBLIC_RESERVE_KINDS, "CUSTOM_RELAY_SEND"\]\)/);
  assert.match(custom, /submissions\/:submissionId\/relay-write\/reserve/);
  assert.match(custom, /requireProductDevice\(req, req\.body\?\.deviceId\)/);
  assert.match(submissions, /CUSTOM_RELAY_SEND/);
  assert.match(submissions, /custom-relay:\$\{id\}:\$\{index\}/);
  assert.match(submissions, /nextUploadIndex\(row\)/);
});

test("Audit17 commit permit is single-revision and another authenticated device cannot race the active lease", async () => {
  await withAuthority(async ({ authority, getRow }) => {
    const reserved = await authority.reserveProgrammaticWrite(base);
    const lease = reserved.lease;
    await authority.startProgrammaticWrite({ ...base, writeId: reserved.delivery.id, leaseToken: lease.token, leaseRevision: lease.revision });
    const first = await authority.prepareProgrammaticWrite({ ...base, writeId: reserved.delivery.id, leaseToken: lease.token, leaseRevision: lease.revision });
    assert.equal(first.writeCommitRevision, 1);
    const duplicate = await authority.prepareProgrammaticWrite({ ...base, writeId: reserved.delivery.id, leaseToken: lease.token, leaseRevision: lease.revision });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.writeCommitRevision, 1);
    await assert.rejects(
      () => authority.prepareProgrammaticWrite({ ...base, deviceId: "device-b", writeId: reserved.delivery.id, leaseToken: lease.token, leaseRevision: lease.revision }),
      (error) => ["PROGRAMMATIC_WRITE_CLAIMED_BY_OTHER", "PROGRAMMATIC_WRITE_LEASE_STALE"].includes(error?.code),
    );
    assert.equal(getRow().writeCommitRevision, 1);
  });
});

test("Audit17 COMMITTING with missing lease expiry cannot be taken over", async () => {
  await withAuthority(async ({ authority, getRow }) => {
    const reserved = await authority.reserveProgrammaticWrite(base);
    const lease = reserved.lease;
    await authority.startProgrammaticWrite({ ...base, writeId: reserved.delivery.id, leaseToken: lease.token, leaseRevision: lease.revision });
    await authority.prepareProgrammaticWrite({ ...base, writeId: reserved.delivery.id, leaseToken: lease.token, leaseRevision: lease.revision });
    getRow().claimUntil = null;
    await assert.rejects(
      () => authority.reserveProgrammaticWrite(base),
      (error) => error?.code === "PROGRAMMATIC_WRITE_COMMIT_IN_FLIGHT",
    );
    assert.equal(getRow().status, "COMMITTING");
  });
});

test("Audit17 COMMITTING HTTP failure cannot be downgraded by client provenNoEffect", async () => {
  await withAuthority(async ({ authority, getRow }) => {
    const reserved = await authority.reserveProgrammaticWrite(base);
    const lease = reserved.lease;
    await authority.startProgrammaticWrite({ ...base, writeId: reserved.delivery.id, leaseToken: lease.token, leaseRevision: lease.revision });
    await authority.prepareProgrammaticWrite({ ...base, writeId: reserved.delivery.id, leaseToken: lease.token, leaseRevision: lease.revision });
    const failed = await authority.failProgrammaticWrite({
      ...base, writeId: reserved.delivery.id, leaseToken: lease.token, leaseRevision: lease.revision,
      failureCode: "HTTP_500",
      facts: { endpointSemantics: "NON_IDEMPOTENT_WRITE", writeReachedWire: true, provenNoEffect: true, httpStatus: 500 },
    });
    assert.equal(failed.reconciliationRequired, true);
    assert.equal(failed.delivery.status, "RECONCILE_REQUIRED");
    assert.ok(failed.lease?.token);
    assert.equal(failed.lease?.revision, getRow().leaseRevision);
    assert.equal(getRow().result.provenNoEffect, false);
    assert.equal(getRow().result.clientClaimedProvenNoEffect, true);
    await assert.rejects(
      () => authority.reserveProgrammaticWrite({ ...base, deviceId: "device-b" }),
      (error) => error?.code === "PROGRAMMATIC_WRITE_LEASE_BUSY",
    );
    const waited = await authority.reconcileProgrammaticWrite({
      ...base, writeId: reserved.delivery.id, leaseToken: failed.lease.token, leaseRevision: failed.lease.revision,
      outcome: "WAIT_FOR_READBACK", result: { successfulReadback: true },
    });
    assert.equal(waited.reconciliationRequired, true);
    assert.ok(waited.lease?.until);
    assert.equal(getRow().status, "RECONCILE_REQUIRED");
  });
});

test("Audit17 backend ignores a malicious idempotent client hint for COMMITTING MASS", async () => {
  await withAuthority(async ({ authority, getRow }) => {
    const reserved = await authority.reserveProgrammaticWrite(base);
    await authority.startProgrammaticWrite({ ...base, writeId: reserved.delivery.id, leaseToken: reserved.lease.token, leaseRevision: reserved.lease.revision });
    await authority.prepareProgrammaticWrite({ ...base, writeId: reserved.delivery.id, leaseToken: reserved.lease.token, leaseRevision: reserved.lease.revision });
    const failed = await authority.failProgrammaticWrite({
      ...base, writeId: reserved.delivery.id, leaseToken: reserved.lease.token, leaseRevision: reserved.lease.revision,
      failureCode: "write_outcome_ambiguous",
      facts: { endpointSemantics: "IDEMPOTENT_WRITE", provenNoEffect: true, writeReachedWire: false },
    });
    assert.equal(failed.reconciliationRequired, true);
    assert.equal(getRow().status, "RECONCILE_REQUIRED");
    assert.equal(getRow().failureCategory, "OUTCOME_UNKNOWN_RECONCILE");
    assert.equal(getRow().result.failureEvidence.endpointSemantics, "NON_IDEMPOTENT_WRITE");
    assert.equal(getRow().result.failureEvidence.reportedEndpointSemantics, "IDEMPOTENT_WRITE");
  });
});

test("Audit17 stranded programmatic reconciliation auto-closes no-retry after the bounded window", async () => {
  await withAuthority(async ({ authority, getRow }) => {
    const reserved = await authority.reserveProgrammaticWrite(base);
    await authority.startProgrammaticWrite({ ...base, writeId: reserved.delivery.id, leaseToken: reserved.lease.token, leaseRevision: reserved.lease.revision });
    await authority.prepareProgrammaticWrite({ ...base, writeId: reserved.delivery.id, leaseToken: reserved.lease.token, leaseRevision: reserved.lease.revision });
    const failed = await authority.failProgrammaticWrite({
      ...base, writeId: reserved.delivery.id, leaseToken: reserved.lease.token, leaseRevision: reserved.lease.revision,
      failureCode: "write_outcome_unknown", facts: {},
    });
    getRow().result.reconciliationStartedAt = new Date(Date.now() - 31 * 60_000).toISOString();
    getRow().claimUntil = null;
    getRow().leaseTokenHash = null;
    const changed = await authority.sweepExpiredProgrammaticWriteLeases({ agencyId: base.agencyId, creatorId: base.creatorId, now: new Date() });
    assert.equal(changed, 1);
    assert.equal(getRow().status, "FAILED");
    assert.equal(getRow().failureCode, "outcome_unresolved_do_not_retry");
    assert.equal(getRow().result.outcomeState, "UNRESOLVED_DO_NOT_RETRY");
    assert.equal(getRow().idempotencyKey, base.idempotencyKey);
    assert.ok(failed.lease?.token);
  });
});

test("Audit17 SOURCE_DEVICE payload cannot migrate before commit but another device may reconcile after expired COMMITTING", async () => {
  await withAuthority(async ({ authority, getRow }) => {
    const first = await authority.reserveProgrammaticWrite(base);
    getRow().claimUntil = new Date(Date.now() - 1_000);
    await assert.rejects(
      () => authority.reserveProgrammaticWrite({ ...base, deviceId: "device-b" }),
      (error) => error?.code === "PROGRAMMATIC_WRITE_SOURCE_DEVICE_REQUIRED",
    );

    const sameSource = await authority.reserveProgrammaticWrite(base);
    await authority.startProgrammaticWrite({ ...base, writeId: sameSource.delivery.id, leaseToken: sameSource.lease.token, leaseRevision: sameSource.lease.revision });
    await authority.prepareProgrammaticWrite({ ...base, writeId: sameSource.delivery.id, leaseToken: sameSource.lease.token, leaseRevision: sameSource.lease.revision });
    getRow().claimUntil = new Date(Date.now() - 1_000);
    const reconciliation = await authority.reserveProgrammaticWrite({ ...base, deviceId: "device-b" });
    assert.equal(reconciliation.delivery.status, "RECONCILE_REQUIRED");
    assert.equal(reconciliation.delivery.sourceDeviceId, "device-a");
    assert.equal(reconciliation.lease.revision, getRow().leaseRevision);
  });
});

test("Audit17 generic GET derives stored product permission and does not expose product-adapter-only writes", () => {
  const service = read("services/programmatic-of-write-authority-service.js");
  assert.match(service, /getProgrammaticWrite[\s\S]*productKind\(storedKind\)/);
  assert.match(service, /PROGRAMMATIC_WRITE_GET_FORBIDDEN/);
  assert.match(service, /permissionKey: config\.permissionKey/);
});

test("Audit17 pre-COMMITTING product routes retain creator, device, permission and access-epoch fences", () => {
  const route = read("routes/programmatic-of-writes.js");
  const service = read("services/programmatic-of-write-authority-service.js");
  const prepare = route.slice(route.indexOf('for (const action of ["start", "prepare-write"]'), route.indexOf('router.post("/:writeId/checkpoint"'));
  assert.match(prepare, /publicKindDevice/);
  assert.match(prepare, /requireProductCreator/);
  assert.match(prepare, /requireProductPermission/);
  assert.match(service, /assertExecutionAccessFence/);
  assert.match(service, /leaseAccessEpoch/);
  assert.match(service, /claimedByDeviceId/);
});



test("Audit17 unresolved reconciliation may close terminally without reopening the logical commit", async () => {
  await withAuthority(async ({ authority, getRow }) => {
    const reserved = await authority.reserveProgrammaticWrite(base);
    const lease = reserved.lease;
    await authority.startProgrammaticWrite({ ...base, writeId: reserved.delivery.id, leaseToken: lease.token, leaseRevision: lease.revision });
    await authority.prepareProgrammaticWrite({ ...base, writeId: reserved.delivery.id, leaseToken: lease.token, leaseRevision: lease.revision });
    const failed = await authority.failProgrammaticWrite({
      ...base, writeId: reserved.delivery.id, leaseToken: lease.token, leaseRevision: lease.revision,
      failureCode: "WRITE_OUTCOME_AMBIGUOUS", facts: { endpointSemantics: "NON_IDEMPOTENT_WRITE", writeReachedWire: true },
    });
    const closed = await authority.closeProgrammaticWriteUnresolved({
      ...base, writeId: reserved.delivery.id, leaseToken: failed.lease.token, leaseRevision: failed.lease.revision, reason: "manual support close",
    });
    assert.equal(closed.delivery.status, "FAILED");
    assert.equal(getRow().failureCode, "outcome_unresolved_do_not_retry");
    assert.equal(getRow().result.outcomeState, "UNRESOLVED_DO_NOT_RETRY");
    assert.equal(getRow().idempotencyKey, base.idempotencyKey);
    const replay = await authority.reserveProgrammaticWrite(base);
    assert.equal(replay.replay, true);
    assert.equal(replay.lease, null);
    assert.equal(replay.delivery.status, "FAILED");
  });
});


test("Audit17 reconciliation lease is exclusive, renewed by WAIT, and an expired token cannot keep reconciling", async () => {
  await withAuthority(async ({ authority, getRow }) => {
    const reserved = await authority.reserveProgrammaticWrite(base);
    await authority.startProgrammaticWrite({ ...base, writeId: reserved.delivery.id, leaseToken: reserved.lease.token, leaseRevision: reserved.lease.revision });
    await authority.prepareProgrammaticWrite({ ...base, writeId: reserved.delivery.id, leaseToken: reserved.lease.token, leaseRevision: reserved.lease.revision });
    const failed = await authority.failProgrammaticWrite({
      ...base, writeId: reserved.delivery.id, leaseToken: reserved.lease.token, leaseRevision: reserved.lease.revision,
      failureCode: "temporary_of_error", facts: { endpointSemantics: "NON_IDEMPOTENT_WRITE", writeReachedWire: true, httpStatus: 500 },
    });
    assert.equal(failed.reconciliationRequired, true);
    assert.ok(failed.lease?.token);
    await assert.rejects(() => authority.reserveProgrammaticWrite(base), (error) => error?.code === "PROGRAMMATIC_WRITE_LEASE_BUSY");

    const before = failed.lease.until.getTime();
    const waited = await authority.reconcileProgrammaticWrite({
      ...base, writeId: reserved.delivery.id, leaseToken: failed.lease.token, leaseRevision: failed.lease.revision,
      outcome: "WAIT_FOR_READBACK", result: { successfulReadback: true },
    });
    assert.equal(waited.reconciliationRequired, true);
    assert.ok(waited.lease.until.getTime() >= before);

    getRow().claimUntil = new Date(Date.now() - 1_000);
    await assert.rejects(
      () => authority.reconcileProgrammaticWrite({ ...base, writeId: reserved.delivery.id, leaseToken: failed.lease.token, leaseRevision: failed.lease.revision, outcome: "WAIT_FOR_READBACK", result: {} }),
      (error) => error?.code === "PROGRAMMATIC_WRITE_LEASE_EXPIRED",
    );
    const takeover = await authority.reserveProgrammaticWrite({ ...base, deviceId: "device-b" });
    assert.equal(takeover.reconciliationRequired, true);
    assert.equal(takeover.delivery.status, "RECONCILE_REQUIRED");
    assert.equal(takeover.delivery.leaseRevision > failed.lease.revision, true);
  });
});

test("Audit17 client failure/checkpoint JSON cannot overwrite server-owned authority fields", async () => {
  await withAuthority(async ({ authority, getRow }) => {
    const reserved = await authority.reserveProgrammaticWrite(base);
    await authority.checkpointProgrammaticWrite({
      ...base, writeId: reserved.delivery.id, leaseToken: reserved.lease.token, leaseRevision: reserved.lease.revision,
      result: { massPreflight: { ids: ["q0"] }, programmaticWriteKind: "VAULT_CREATE_LIST", outcomeState: "PROVEN_SUCCESS", reservedAt: "fake" },
    });
    assert.equal(getRow().result.programmaticWriteKind, "MASS_QUEUE_CREATE");
    assert.notEqual(getRow().result.outcomeState, "PROVEN_SUCCESS");
    await authority.startProgrammaticWrite({ ...base, writeId: reserved.delivery.id, leaseToken: reserved.lease.token, leaseRevision: reserved.lease.revision });
    await authority.prepareProgrammaticWrite({ ...base, writeId: reserved.delivery.id, leaseToken: reserved.lease.token, leaseRevision: reserved.lease.revision });
    await authority.failProgrammaticWrite({
      ...base, writeId: reserved.delivery.id, leaseToken: reserved.lease.token, leaseRevision: reserved.lease.revision,
      failureCode: "temporary_of_error",
      facts: { endpointSemantics: "NON_IDEMPOTENT_WRITE", writeReachedWire: true, programmaticWriteKind: "EVIL", outcomeState: "PROVEN_SUCCESS", reservedAt: "evil", httpStatus: 500 },
    });
    assert.equal(getRow().result.programmaticWriteKind, "MASS_QUEUE_CREATE");
    assert.equal(getRow().result.outcomeState, "RECONCILE_REQUIRED");
    assert.equal(getRow().result.reservedAt === "evil", false);
    assert.equal(getRow().result.failureEvidence.httpStatus, 500);
  });
});

test("Audit17 terminal duplicate complete does not disclose durable result after creator access revoke", async () => {
  await withAuthority(async ({ authority, access }) => {
    const reserved = await authority.reserveProgrammaticWrite(base);
    await authority.startProgrammaticWrite({ ...base, writeId: reserved.delivery.id, leaseToken: reserved.lease.token, leaseRevision: reserved.lease.revision });
    await authority.prepareProgrammaticWrite({ ...base, writeId: reserved.delivery.id, leaseToken: reserved.lease.token, leaseRevision: reserved.lease.revision });
    const completed = await authority.completeProgrammaticWrite({ ...base, writeId: reserved.delivery.id, leaseToken: reserved.lease.token, leaseRevision: reserved.lease.revision, result: { queueId: "queue-secret" }, messageId: "must-not-be-queue" });
    assert.equal(completed.delivery.result.queueId, "queue-secret");
    assert.equal(completed.delivery.messageId, null);
    access.enabled = false;
    await assert.rejects(
      () => authority.completeProgrammaticWrite({ ...base, writeId: reserved.delivery.id, leaseToken: "stale-terminal", leaseRevision: reserved.lease.revision, result: {} }),
      (error) => error?.code === "PROGRAMMATIC_WRITE_TERMINAL_RESULT_FORBIDDEN" && error?.status === 403,
    );
  });
});

test("Audit17 custom unresolved close stays behind the Custom product adapter", () => {
  const genericRoute = read("routes/programmatic-of-writes.js");
  const customRoute = read("routes/custom-orders.js");
  const customService = read("services/custom-content-submissions-service.js");
  assert.match(genericRoute, /close-unresolved[\s\S]{0,700}publicKindAccess/);
  assert.match(customRoute, /submissions\/:submissionId\/relay-write\/close-unresolved/);
  assert.match(customService, /expectedIdempotencyKey:\s*`custom-relay:\$\{id\}:\$\{index\}`/);
});

test("Audit17 shared lease sweeper dispatches programmatic rows to programmatic policy and automation rows to automation policy", () => {
  const automationService = read("services/automation-action-delivery-service.js");
  const programmaticService = read("services/programmatic-of-write-authority-service.js");
  assert.match(automationService, /sweepExpiredProgrammaticWriteLeases\(\{ now, agencyId: options\.agencyId, creatorIds: options\.creatorIds \}\)/);
  assert.match(automationService, /async function sweepExpiredAutomationLeases/);
  assert.match(automationService, /scopeWhere[\s\S]*originKind:\s*"AUTOMATION"[\s\S]*status:\s*\{\s*in:\s*LEASED_STATUSES/);
  assert.match(programmaticService, /sweepExpiredAutomationLeases\(\{ now, agencyId, creatorIds: \[creatorId\] \}\)/);
  assert.match(programmaticService, /originKind:\s*\{\s*not:\s*"AUTOMATION"\s*\}/);
  assert.match(programmaticService, /CLAIMED[\s\S]*RUNNING[\s\S]*COMMITTING[\s\S]*RECONCILE_REQUIRED/);
});

test("Audit17 bounded WAIT closes permanently unresolved without retry, and manual match can later recover typed remote identity", async () => {
  await withAuthority(async ({ authority, getRow }) => {
    const reserved = await authority.reserveProgrammaticWrite(base);
    await authority.startProgrammaticWrite({ ...base, writeId: reserved.delivery.id, leaseToken: reserved.lease.token, leaseRevision: reserved.lease.revision });
    await authority.prepareProgrammaticWrite({ ...base, writeId: reserved.delivery.id, leaseToken: reserved.lease.token, leaseRevision: reserved.lease.revision });
    const failed = await authority.failProgrammaticWrite({
      ...base, writeId: reserved.delivery.id, leaseToken: reserved.lease.token, leaseRevision: reserved.lease.revision,
      failureCode: "write_outcome_unknown", facts: { endpointSemantics: "NON_IDEMPOTENT_WRITE", writeReachedWire: true },
    });
    getRow().result.reconciliationStartedAt = new Date(Date.now() - 31 * 60_000).toISOString();
    const closed = await authority.reconcileProgrammaticWrite({
      ...base, writeId: reserved.delivery.id, leaseToken: failed.lease.token, leaseRevision: failed.lease.revision,
      outcome: "WAIT_FOR_READBACK", result: { successfulReadback: true },
    });
    assert.equal(closed.unresolved, true);
    assert.equal(closed.delivery.status, "FAILED");
    assert.equal(closed.delivery.failureCode, "outcome_unresolved_do_not_retry");
    assert.equal(closed.delivery.result.outcomeState, "UNRESOLVED_DO_NOT_RETRY");
    assert.equal(getRow().leaseTokenHash, null);

    const replay = await authority.reserveProgrammaticWrite(base);
    assert.equal(replay.lease, null);
    assert.equal(replay.delivery.id, reserved.delivery.id);
    assert.equal(replay.delivery.status, "FAILED");

    const matched = await authority.resolveProgrammaticWriteUnresolvedMatched({
      ...base, writeId: reserved.delivery.id, result: { queueId: "queue-manual-1", outcomeState: "EVIL", programmaticWriteKind: "EVIL" },
    });
    assert.equal(matched.delivery.status, "COMPLETED");
    assert.equal(matched.delivery.result.queueId, "queue-manual-1");
    assert.equal(matched.delivery.result.programmaticWriteKind, "MASS_QUEUE_CREATE");
    assert.equal(matched.delivery.messageId, null);
    const finalReplay = await authority.reserveProgrammaticWrite(base);
    assert.equal(finalReplay.delivery.status, "COMPLETED");
    assert.equal(finalReplay.delivery.id, reserved.delivery.id);
  });
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  assignCustomContentSubmission,
  createCustomContentSubmission,
  deterministicSubmissionId,
  listCustomContentSubmissions,
  sameMessageIds,
  telegramMessageIds,
} = require("./custom-content-submissions-service");

function clone(value) { return value == null ? value : structuredClone(value); }

function fakeDb(seed = {}) {
  const creators = (seed.creators || [
    { id: "creator-1", agencyId: "agency-1", deletedAt: null, displayName: "Model A", username: "a", status: "READY" },
    { id: "creator-2", agencyId: "agency-1", deletedAt: null, displayName: "Model B", username: "b", status: "READY" },
  ]).map(clone);
  const orders = (seed.orders || [
    { id: "custom-1", agencyId: "agency-1", creatorId: "creator-1", type: "CONTENT" },
    { id: "call-1", agencyId: "agency-1", creatorId: "creator-1", type: "CALL" },
    { id: "custom-2", agencyId: "agency-1", creatorId: "creator-2", type: "CONTENT" },
  ]).map(clone);
  const submissions = (seed.submissions || []).map(clone);
  const audits = [];
  let seq = submissions.length;

  function matchesSubmission(row, where = {}) {
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.agencyId !== undefined && row.agencyId !== where.agencyId) return false;
    if (where.creatorId !== undefined && row.creatorId !== where.creatorId) return false;
    if (where.customOrderId !== undefined && row.customOrderId !== where.customOrderId) return false;
    if (where.telegramMessageIds?.hasSome) {
      const ids = new Set((row.telegramMessageIds || []).map(Number));
      if (!where.telegramMessageIds.hasSome.some((id) => ids.has(Number(id)))) return false;
    }
    return true;
  }

  return {
    _submissions: submissions,
    _audits: audits,
    creatorAccount: {
      async findFirst({ where }) {
        const row = creators.find((candidate) => candidate.agencyId === where.agencyId && candidate.id === where.id && !candidate.deletedAt);
        return clone(row || null);
      },
    },
    customOrder: {
      async findFirst({ where }) {
        const row = orders.find((candidate) => candidate.id === where.id && candidate.agencyId === where.agencyId && candidate.creatorId === where.creatorId);
        return clone(row || null);
      },
    },
    customContentSubmission: {
      async findFirst({ where }) { return clone(submissions.find((row) => matchesSubmission(row, where)) || null); },
      async create({ data }) {
        const stamp = new Date(`2026-08-21T12:${String(seq).padStart(2, "0")}:00.000Z`);
        const row = { id: `submission-${++seq}`, ...clone(data), createdAt: stamp, updatedAt: stamp };
        submissions.push(row);
        return clone(row);
      },
      async update({ where, data }) {
        const row = submissions.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, clone(data), { updatedAt: new Date("2026-08-21T13:00:00.000Z") });
        return clone(row);
      },
      async findMany({ where, take, skip }) {
        return submissions.filter((row) => matchesSubmission(row, where))
          .sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt))
          .slice(skip, skip + take).map(clone);
      },
      async count({ where }) { return submissions.filter((row) => matchesSubmission(row, where)).length; },
    },
    auditLog: { async create({ data }) { audits.push(clone(data)); return { id: `audit-${audits.length}`, ...clone(data) }; } },
  };
}

const member = { id: "member-1", userId: "user-1", roleKey: "chatter", role: "OPERATOR", assignedCreators: ["creator-1"] };

test("Prisma submission ledger stays deliberately compact", () => {
  const schema = fs.readFileSync(path.join(__dirname, "../../prisma/schema.prisma"), "utf8");
  const match = schema.match(/model CustomContentSubmission \{([\s\S]*?)\n\}/);
  assert.ok(match, "CustomContentSubmission model must exist");
  const block = match[1];
  for (const required of ["agencyId", "creatorId", "customOrderId", "telegramMessageIds", "ofMediaIds", "comment", "receivedAt", "createdAt", "updatedAt"]) {
    assert.match(block, new RegExp(`\\b${required}\\b`));
  }
  for (const forbidden of ["status", "deviceId", "endpoint", "peerId", "fileName", "mimeType", "sizeBytes", "attemptCount", "lastError"]) {
    assert.doesNotMatch(block, new RegExp(`\\b${forbidden}\\b`, "i"), `do not persist ${forbidden} on the compact ledger`);
  }
  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260821115000_custom_content_submission_ledger/migration.sql"), "utf8");
  assert.match(migration, /CREATE TABLE "CustomContentSubmission"/);
  assert.match(migration, /"telegramMessageIds" INTEGER\[\]/);
  assert.match(migration, /"ofMediaIds" TEXT\[\]/);
});

function baseSubmission(overrides = {}) {
  return {
    id: "submission-existing",
    agencyId: "agency-1",
    creatorId: "creator-1",
    customOrderId: "custom-1",
    telegramMessageIds: [101, 102],
    ofMediaIds: [],
    comment: "first",
    receivedAt: new Date("2026-08-21T10:00:00.000Z"),
    createdAt: new Date("2026-08-21T10:00:00.000Z"),
    updatedAt: new Date("2026-08-21T10:00:00.000Z"),
    ...overrides,
  };
}

test("submission message ids are compact, positive, de-duplicated facts", () => {
  assert.deepEqual(telegramMessageIds([101, "102", 101]), [101, 102]);
  assert.equal(sameMessageIds([102, 101], [101, 102, 102]), true);
  assert.throws(() => telegramMessageIds([]), /at least one/i);
  assert.throws(() => telegramMessageIds([0]), /positive/i);
  assert.equal(
    deterministicSubmissionId("agency-1", "creator-1", [102, 101]),
    deterministicSubmissionId("agency-1", "creator-1", [101, 102, 101]),
    "the row id itself is the compact exact-retry fence",
  );
  assert.notEqual(
    deterministicSubmissionId("agency-1", "creator-1", [101]),
    deterministicSubmissionId("agency-1", "creator-2", [101]),
  );
});

test("create stores one compact submission row and exact retries are idempotent", async () => {
  const db = fakeDb();
  const first = await createCustomContentSubmission({
    agencyId: "agency-1", member, db,
    input: { creatorId: "creator-1", customOrderId: "custom-1", telegramMessageIds: [501, 502, 501], comment: "  second angle  ", receivedAt: "2026-08-21T11:00:00.000Z" },
  });
  assert.equal(first.deduped, false);
  assert.deepEqual(first.submission.telegramMessageIds, ["501", "502"]);
  assert.deepEqual(first.submission.ofMediaIds, []);
  assert.equal(first.submission.comment, "second angle");
  assert.equal(db._submissions.length, 1);

  const retry = await createCustomContentSubmission({
    agencyId: "agency-1", member, db,
    input: { creatorId: "creator-1", customOrderId: "custom-1", telegramMessageIds: [502, 501], comment: "ignored retry text" },
  });
  assert.equal(retry.deduped, true);
  assert.equal(retry.submission.id, first.submission.id);
  assert.equal(db._submissions.length, 1);
  assert.equal(db._audits.length, 1, "idempotent retries do not create audit noise");
});

test("partial Telegram overlap is rejected instead of silently duplicating media", async () => {
  const db = fakeDb({ submissions: [baseSubmission()] });
  await assert.rejects(
    () => createCustomContentSubmission({ agencyId: "agency-1", member, db, input: { creatorId: "creator-1", customOrderId: "custom-1", telegramMessageIds: [102, 103] } }),
    (error) => error?.code === "CUSTOM_SUBMISSION_TELEGRAM_MESSAGE_CONFLICT" && error?.status === 409,
  );
});

test("submission may stay unassigned and can later be assigned only to CONTENT of same creator", async () => {
  const db = fakeDb({ submissions: [baseSubmission({ customOrderId: null })] });
  const assigned = await assignCustomContentSubmission({ agencyId: "agency-1", member, submissionId: "submission-existing", customOrderId: "custom-1", db });
  assert.equal(assigned.unchanged, false);
  assert.equal(assigned.submission.customOrderId, "custom-1");

  await assert.rejects(
    () => assignCustomContentSubmission({ agencyId: "agency-1", member, submissionId: "submission-existing", customOrderId: "call-1", db }),
    (error) => error?.code === "CUSTOM_SUBMISSION_ORDER_TYPE_INVALID" && error?.status === 409,
  );
  await assert.rejects(
    () => assignCustomContentSubmission({ agencyId: "agency-1", member, submissionId: "submission-existing", customOrderId: "custom-2", db }),
    (error) => error?.code === "CUSTOM_SUBMISSION_ORDER_NOT_FOUND" && error?.status === 404,
  );

  const unassigned = await assignCustomContentSubmission({ agencyId: "agency-1", member, submissionId: "submission-existing", customOrderId: null, db });
  assert.equal(unassigned.submission.customOrderId, null);
});

test("list is creator-scoped and supports compact unassigned queue", async () => {
  const db = fakeDb({ submissions: [
    baseSubmission({ id: "a", customOrderId: null, receivedAt: new Date("2026-08-21T12:00:00.000Z") }),
    baseSubmission({ id: "b", customOrderId: "custom-1", telegramMessageIds: [201], receivedAt: new Date("2026-08-21T11:00:00.000Z") }),
    baseSubmission({ id: "c", creatorId: "creator-2", customOrderId: "custom-2", telegramMessageIds: [301], receivedAt: new Date("2026-08-21T10:00:00.000Z") }),
  ] });
  const result = await listCustomContentSubmissions({ agencyId: "agency-1", member, creatorId: "creator-1", unassigned: true, db });
  assert.equal(result.count, 1);
  assert.equal(result.items[0].id, "a");
  await assert.rejects(
    () => listCustomContentSubmissions({ agencyId: "agency-1", member, creatorId: "creator-2", db }),
    /do not have access/i,
  );
});

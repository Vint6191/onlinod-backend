"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { adjudicateHumanModelResponseOverride } = require("./custom-model-instruction-override-authority-service");

function clone(value) { return value == null ? value : structuredClone(value); }
function fixture({ intent = null, latest = null, raceToState = null } = {}) {
  const now = new Date("2026-09-07T19:00:00.000Z");
  const order = { id: "order-1", agencyId: "agency-1", creatorId: "creator-1", type: "CONTENT", status: "PENDING", updatedAt: new Date(now.getTime() - 1000) };
  const intents = intent ? [clone(intent)] : [];
  const submissions = latest ? [clone(latest)] : [];
  const audits = [];
  let raced = false;
  const db = {
    customOrder: {
      async findFirst({ where }) { return where.id === order.id && where.agencyId === order.agencyId ? clone(order) : null; },
      async updateMany({ where, data }) {
        if (where.id !== order.id || where.agencyId !== order.agencyId) return { count: 0 };
        if (where.updatedAt && new Date(where.updatedAt).getTime() !== new Date(order.updatedAt).getTime()) return { count: 0 };
        Object.assign(order, clone(data));
        return { count: 1 };
      },
    },
    customContentSubmission: {
      async findFirst({ where }) {
        const row = submissions.find((candidate) => {
          if (candidate.agencyId !== where.agencyId || candidate.creatorId !== where.creatorId || candidate.customOrderId !== where.customOrderId) return false;
          if (where.id?.not && String(candidate.id) === String(where.id.not)) return false;
          return true;
        });
        return clone(row || null);
      },
    },
    telegramDeliveryIntent: {
      async findFirst({ where }) {
        const row = intents.find((candidate) => {
          if (where.id !== undefined && String(candidate.id) !== String(where.id)) return false;
          if (where.agencyId !== undefined && String(candidate.agencyId) !== String(where.agencyId)) return false;
          if (where.customOrderId !== undefined && String(candidate.customOrderId) !== String(where.customOrderId)) return false;
          if (where.kind !== undefined && String(candidate.kind) !== String(where.kind)) return false;
          if (where.customSubmissionId !== undefined && String(candidate.customSubmissionId || "") !== String(where.customSubmissionId || "")) return false;
          return true;
        });
        return clone(row || null);
      },
      async updateMany({ where, data }) {
        const row = intents.find((candidate) => String(candidate.id) === String(where.id));
        if (!row) return { count: 0 };
        if (raceToState && !raced) {
          raced = true;
          row.state = raceToState;
          if (raceToState === "COMMITTING") row.commitStartedAt = new Date(now.getTime() - 10);
          return { count: 0 };
        }
        if (where.state?.in && !where.state.in.includes(row.state)) return { count: 0 };
        if (where.claimRevision !== undefined && Number(row.claimRevision || 0) !== Number(where.claimRevision)) return { count: 0 };
        if (where.commitStartedAt === null && row.commitStartedAt != null) return { count: 0 };
        Object.assign(row, clone(data));
        return { count: 1 };
      },
    },
    auditLog: { async create({ data }) { audits.push(clone(data)); return { id: `audit-${audits.length}`, ...clone(data) }; } },
  };
  return { now, order, intents, submissions, audits, db };
}

function instruction({ kind = "TASK", state = "PLANNED", customSubmissionId = null } = {}) {
  return {
    id: `${kind.toLowerCase()}-1`, agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1", customSubmissionId,
    kind, state, claimRevision: 4, commitStartedAt: state === "COMMITTING" ? new Date("2026-09-07T18:59:59.000Z") : null,
    remoteMessageId: state === "CONFIRMED" ? 501 : null, remoteRecipientTelegramUserId: state === "CONFIRMED" ? "1001" : null,
    remoteSentAt: state === "CONFIRMED" ? new Date("2026-09-07T18:55:00.000Z") : null,
    confirmedAt: state === "CONFIRMED" ? new Date("2026-09-07T18:55:01.000Z") : null,
    createdAt: new Date("2026-09-07T18:50:00.000Z"), updatedAt: new Date("2026-09-07T18:50:00.000Z"),
  };
}

async function adjudicate(fx, extra = {}) {
  return adjudicateHumanModelResponseOverride({
    agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1", actorUserId: "user-1",
    context: "TEST_HUMAN_RESPONSE", now: fx.now, db: fx.db, ...extra,
  });
}

test("manual first response atomically supersedes a precommit TASK instead of allowing it to chase the accepted response", async () => {
  const fx = fixture({ intent: instruction({ state: "PLANNED" }) });
  const result = await adjudicate(fx);
  assert.equal(result.decision, "SUPERSEDED_PRECOMMIT");
  assert.equal(fx.intents[0].state, "CANCELLED");
  assert.equal(fx.intents[0].claimRevision, 5);
  assert.equal(fx.intents[0].commitStartedAt, null);
  assert.match(fx.intents[0].outcomeReason, /^HUMAN_RESPONSE_SUPERSEDED:/);
  assert.equal(fx.audits.length, 1);
});

test("manual first response is blocked once TASK has crossed COMMITTING", async () => {
  const fx = fixture({ intent: instruction({ state: "COMMITTING" }) });
  await assert.rejects(() => adjudicate(fx), (error) => error?.code === "CUSTOM_MODEL_INSTRUCTION_COMMITTING");
  assert.equal(fx.intents[0].state, "COMMITTING");
});

test("manual response is blocked while TASK provider outcome is unknown", async () => {
  const fx = fixture({ intent: instruction({ state: "RECONCILE_REQUIRED" }) });
  await assert.rejects(() => adjudicate(fx), (error) => error?.code === "CUSTOM_MODEL_INSTRUCTION_OUTCOME_UNKNOWN");
});

test("explicit human response may proceed after exact TASK provider confirmation", async () => {
  const fx = fixture({ intent: instruction({ state: "CONFIRMED" }) });
  const result = await adjudicate(fx);
  assert.equal(result.decision, "CONFIRMED_EXPLICIT_OVERRIDE");
  assert.equal(fx.intents[0].state, "CONFIRMED");
});

test("historical response without any model instruction remains an explicit audited recovery path", async () => {
  const fx = fixture();
  const result = await adjudicate(fx);
  assert.equal(result.decision, "NO_INSTRUCTION");
  assert.equal(result.instructionKind, "TASK");
  assert.equal(fx.audits.length, 1);
});

test("manual V2 adjudicates the exact REVISION_REQUEST for the latest REVISION_REQUESTED submission", async () => {
  const latest = { id: "v1", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1", reviewStatus: "REVISION_REQUESTED", pipelineDisposition: "ACTIVE", receivedAt: new Date("2026-09-07T18:40:00Z"), createdAt: new Date("2026-09-07T18:40:00Z") };
  const fx = fixture({ intent: instruction({ kind: "REVISION_REQUEST", state: "CLAIMED", customSubmissionId: "v1" }), latest });
  const result = await adjudicate(fx);
  assert.equal(result.instructionKind, "REVISION_REQUEST");
  assert.equal(result.latestSubmissionId, "v1");
  assert.equal(fx.intents[0].state, "CANCELLED");
});

test("precommit supersede CAS losing to a concurrent COMMITTING transition reclassifies and blocks instead of assuming no send", async () => {
  const fx = fixture({ intent: instruction({ state: "CLAIMED" }), raceToState: "COMMITTING" });
  await assert.rejects(() => adjudicate(fx), (error) => error?.code === "CUSTOM_MODEL_INSTRUCTION_COMMITTING");
  assert.equal(fx.intents[0].state, "COMMITTING");
  assert.ok(fx.intents[0].commitStartedAt);
});

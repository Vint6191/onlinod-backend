"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const prismaPath = require.resolve("../prisma");
const ledgerPath = require.resolve("./team-ppv-ledger-service");
const projectionPath = require.resolve("./team-response-projection-service");
const servicePath = require.resolve("./telemetry-ingest-service");

const GENERATION = {
  authorizationScopeIncarnation: "scope-A",
  accessEpoch: 7,
  creatorCatalogGeneration: 3,
};

function loadIngest({ startGeneration = GENERATION, assignedCreators = [] } = {}) {
  const rows = [{
    id: "start-1",
    agencyId: "agency-1",
    deviceId: "device-1",
    memberId: "member-1",
    userId: "user-1",
    creatorId: "creator-1",
    coverageId: "coverage-1",
    eventKind: "COVERAGE_STARTED",
    actionSource: "MANUAL",
    lifecycle: "OBSERVED",
    localId: "start-local-1",
    startedAt: new Date("2026-09-15T02:00:00.000Z"),
    ts: new Date("2026-09-15T02:00:00.000Z"),
    extra: { metadata: { authorizationGeneration: startGeneration } },
  }];
  const prisma = {
    async $queryRawUnsafe(sql) {
      const text = String(sql || "");
      if (/FROM "RefreshSession"/i.test(text) && /FOR SHARE/i.test(text)) return [{ id: "refresh-current", authorizationSessionId: "scope-A" }];
      if (/FROM "AgencyCreatorCatalogState"/i.test(text) && /FOR SHARE/i.test(text)) return [{ generation: 3 }];
      if (/AuthorizationSessionBoundary/i.test(text)) return [{ endedAt: new Date("2026-09-15T02:05:00.000Z") }];
      if (/AgencyCreatorCatalogGenerationBoundary/i.test(text)) return [{ endedAt: new Date("2026-09-15T02:05:00.000Z") }];
      if (/FROM "AgencyMember"/i.test(text) && /FOR SHARE OF m/i.test(text)) return [{
        id: "member-1", userId: "user-1", agencyId: "agency-1", accessEpoch: 1,
        role: "CHATTER", roleKey: "chatter", assignedCreators, permissions: {}, deletedAt: null, deactivatedAt: null,
      }];
      if (/AgencyMemberAccessEpochBoundary/i.test(text)) return [{ endedAt: new Date("2026-09-15T02:05:00.000Z") }];
      if (/clock_timestamp/i.test(text)) return [{ authorityNow: new Date("2026-09-15T02:30:00.000Z") }];
      return [];
    },
    async $transaction(work) { return work(prisma); },
    creatorAccount: {
      async findFirst({ where }) {
        return where.agencyId === "agency-1" && where.id === "creator-1"
          ? { id: "creator-1", username: "creator", remoteId: "123" }
          : null;
      },
    },
    agencyMember: {
      async findFirst({ where }) {
        if (where.id !== "member-1" || where.agencyId !== "agency-1" || where.userId !== "user-1") return null;
        return {
          id: "member-1", userId: "user-1", agencyId: "agency-1", accessEpoch: 1,
          role: "CHATTER", roleKey: "chatter", assignedCreators, permissions: {},
        };
      },
    },
    teamActivityEvent: {
      async findFirst({ where }) {
        if (where.eventKind === "COVERAGE_STARTED") {
          return rows.find((row) => row.agencyId === where.agencyId
            && row.deviceId === where.deviceId
            && row.memberId === where.memberId
            && row.userId === where.userId
            && row.creatorId === where.creatorId
            && row.coverageId === where.coverageId
            && row.eventKind === "COVERAGE_STARTED"
            && row.actionSource === "MANUAL"
            && row.lifecycle === "OBSERVED") || null;
        }
        if (Object.prototype.hasOwnProperty.call(where, "localId")) {
          return rows.find((row) => row.agencyId === where.agencyId
            && row.deviceId === where.deviceId
            && row.localId === where.localId) || null;
        }
        return null;
      },
      async create({ data }) {
        const row = { id: `event-${rows.length + 1}`, ...data };
        rows.push(row);
        return row;
      },
    },
  };

  for (const path of [servicePath, prismaPath, ledgerPath, projectionPath]) delete require.cache[path];
  require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: prisma };
  require.cache[ledgerPath] = { id: ledgerPath, filename: ledgerPath, loaded: true, exports: { async applyLedgerSideEffects() {} } };
  require.cache[projectionPath] = { id: projectionPath, filename: projectionPath, loaded: true, exports: { async applyTeamResponseProjection() {} } };
  const service = require(servicePath);
  return { service, rows };
}

function terminalCoverage(overrides = {}) {
  return {
    telemetryVersion: "team_v13_provenance",
    source: "electron_team_v13",
    eventKind: "COVERAGE_ENDED",
    actionSource: "MANUAL",
    lifecycle: "OBSERVED",
    creatorId: "creator-1",
    accountId: "creator-1",
    coverageId: "coverage-1",
    correlationId: "coverage-1",
    actorMemberId: "member-1",
    actorUserId: "user-1",
    localId: "end-local-1",
    durationSeconds: 300,
    occurredAt: "2026-09-15T02:05:00.000Z",
    metadata: {
      startReason: "dialog_activity",
      endReason: "authorization_quarantined",
      authorizationGeneration: GENERATION,
      authorizationCapture: { version: 1, semantics: "TERMINAL_CLOSURE", ...GENERATION, localAuthorizationRevision: null },
      authorizationTerminalClosure: {
        version: 1,
        reason: "authorization_quarantined",
        startedUnder: GENERATION,
        boundaryOffsetSeconds: 300,
      },
    },
    ...overrides,
  };
}

async function ingest(service, event) {
  return service.ingestTeamEvents({
    agencyId: "agency-1", deviceId: "device-1", userId: "user-1", memberId: "member-1",
    admittedAccessEpoch: 1, admittedAuthorizationSessionId: "scope-A", events: [event],
  });
}

test("INT2.6 revoked creator accepts only terminal closure proven by its durable START generation", async () => {
  const { service, rows } = loadIngest({ assignedCreators: [] });
  const result = await ingest(service, terminalCoverage());
  assert.equal(result.accepted, 1);
  assert.equal(result.skipped, 0);
  assert.equal(rows.filter((row) => row.eventKind === "COVERAGE_ENDED").length, 1);
});

test("INT2.6 mismatched generation cannot use terminal closure as creator-access authority", async () => {
  const { service, rows } = loadIngest({ assignedCreators: [] });
  const event = terminalCoverage({
    localId: "end-mismatch",
    metadata: {
      authorizationGeneration: { ...GENERATION, accessEpoch: GENERATION.accessEpoch + 1 },
      authorizationCapture: {
        version: 1, semantics: "TERMINAL_CLOSURE",
        ...GENERATION, accessEpoch: GENERATION.accessEpoch + 1,
        localAuthorizationRevision: null,
      },
      authorizationTerminalClosure: {
        version: 1,
        reason: "authorization_quarantined",
        startedUnder: { ...GENERATION, accessEpoch: GENERATION.accessEpoch + 1 },
        boundaryOffsetSeconds: 300,
      },
    },
  });
  const result = await ingest(service, event);
  assert.equal(result.accepted, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.rejectedByReason.authorization_terminal_closure_unproven, 1);
  assert.equal(rows.filter((row) => row.eventKind === "COVERAGE_ENDED").length, 0);
});

test("INT2.6 marker never bypasses revoked creator for a non-terminal event", async () => {
  const { service } = loadIngest({ assignedCreators: [] });
  const event = terminalCoverage({
    eventKind: "USER_ACTIVITY", localId: "fake-terminal-user-activity",
    metadata: {
      authorizationGeneration: { authorizationScopeIncarnation: "scope-A", accessEpoch: 1, creatorCatalogGeneration: 3 },
      authorizationCapture: {
        version: 1, semantics: "CURRENT_HUMAN",
        authorizationScopeIncarnation: "scope-A", accessEpoch: 1, creatorCatalogGeneration: 3,
        localAuthorizationRevision: 1,
      },
    },
  });
  const result = await ingest(service, event);
  assert.equal(result.accepted, 0);
  assert.equal(result.rejectedByReason.creator_access_forbidden, 1);
});

test("INT2.6 revoked creator cannot use terminal DIALOG_SESSION to create a new performance record", async () => {
  const { service, rows } = loadIngest({ assignedCreators: [] });
  const event = terminalCoverage({
    eventKind: "DIALOG_SESSION", localId: "dialog-revoked-1", dialogId: "fan-1", fanId: "fan-1",
    correlationId: "dialog-session-revoked", durationSeconds: 45,
    metadata: {
      wallSeconds: 120, activeSeconds: 45, coverageId: "coverage-1",
      authorizationGeneration: GENERATION,
      authorizationCapture: { version: 1, semantics: "TERMINAL_CLOSURE", ...GENERATION, localAuthorizationRevision: null },
      authorizationTerminalClosure: {
        version: 1, reason: "authorization_quarantined", startedUnder: GENERATION, boundaryOffsetSeconds: 300,
      },
    },
  });
  const result = await ingest(service, event);
  assert.equal(result.accepted, 0);
  assert.equal(result.rejectedByReason.creator_access_forbidden, 1);
  assert.equal(rows.some((row) => row.eventKind === "DIALOG_SESSION"), false);
});

test("INT2.6 delayed terminal DIALOG_SESSION is anchored before the authorization gap while creator remains current", async () => {
  const { service, rows } = loadIngest({ assignedCreators: ["creator-1"] });
  const event = terminalCoverage({
    eventKind: "DIALOG_SESSION",
    localId: "dialog-terminal-1",
    dialogId: "fan-1",
    fanId: "fan-1",
    correlationId: "dialog-session-1",
    durationSeconds: 45,
    metadata: {
      wallSeconds: 120,
      activeSeconds: 45,
      coverageId: "coverage-1",
      authorizationGeneration: GENERATION,
      authorizationCapture: { version: 1, semantics: "TERMINAL_CLOSURE", ...GENERATION, localAuthorizationRevision: null },
      authorizationTerminalClosure: {
        version: 1,
        reason: "authorization_quarantined",
        startedUnder: GENERATION,
        boundaryOffsetSeconds: 300,
      },
    },
  });
  const result = await ingest(service, event);
  assert.equal(result.accepted, 1);
  const row = rows.find((candidate) => candidate.eventKind === "DIALOG_SESSION");
  assert.ok(row);
  assert.equal(row.endedAt.toISOString(), "2026-09-15T02:05:00.000Z");
  assert.equal(row.startedAt.toISOString(), "2026-09-15T02:03:00.000Z");
  assert.equal(row.durationSeconds, 45, "active duration remains distinct from wall chronology");
});

test("INT2.6 delayed terminal coverage END is truncate-only and cannot stretch to receipt time", async () => {
  // Load the real projection module after clearing the ingest test stub.
  delete require.cache[projectionPath];
  const { upsertCoverageSession } = require(projectionPath);
  const existing = {
    id: "coverage-row-1", agencyId: "agency-1", creatorId: "creator-1", memberId: "member-1",
    userId: "user-1", deviceId: "device-1", coverageId: "coverage-1",
    startedAt: new Date("2026-09-15T02:00:00.000Z"), endedAt: null, durationSeconds: null,
    startReason: "dialog_activity", endReason: null,
  };
  const db = {
    async $transaction(work) { return work(db); },
    async $executeRawUnsafe() { return 1; },
    teamCoverageSession: {
      async findUnique() { return { ...existing }; },
      async create({ data }) { Object.assign(existing, data); return { ...existing }; },
      async update({ data }) { Object.assign(existing, data); return { ...existing }; },
    },
  };
  const receiptTime = new Date("2026-09-15T02:30:00.000Z");
  const canonicalStartedAt = new Date("2026-09-15T02:25:00.000Z"); // receipt - reported 300s
  const result = await upsertCoverageSession({
    agencyId: "agency-1", creatorId: "creator-1", memberId: "member-1", userId: "user-1", deviceId: "device-1",
    coverageId: "coverage-1", eventKind: "COVERAGE_ENDED",
    startedAt: canonicalStartedAt, endedAt: receiptTime, ts: receiptTime, durationSeconds: 300,
    extra: { metadata: { authorizationTerminalClosure: { version: 1, startedUnder: GENERATION, boundaryOffsetSeconds: 300 } } },
  }, db);
  assert.equal(result.startedAt.toISOString(), "2026-09-15T02:00:00.000Z");
  assert.equal(result.endedAt.toISOString(), "2026-09-15T02:05:00.000Z");
  assert.equal(result.durationSeconds, 300);
});

test("INT2.6 terminal coverage replay can only shorten an already earlier durable END", async () => {
  delete require.cache[projectionPath];
  const { upsertCoverageSession } = require(projectionPath);
  const existing = {
    id: "coverage-row-2", agencyId: "agency-1", creatorId: "creator-1", memberId: "member-1",
    coverageId: "coverage-2", startedAt: new Date("2026-09-15T03:00:00.000Z"),
    endedAt: new Date("2026-09-15T03:03:00.000Z"), durationSeconds: 180,
  };
  const db = {
    async $transaction(work) { return work(db); }, async $executeRawUnsafe() { return 1; },
    teamCoverageSession: {
      async findUnique() { return { ...existing }; }, async create({ data }) { Object.assign(existing, data); return { ...existing }; },
      async update({ data }) { Object.assign(existing, data); return { ...existing }; },
    },
  };
  const result = await upsertCoverageSession({
    agencyId: "agency-1", creatorId: "creator-1", memberId: "member-1", coverageId: "coverage-2",
    eventKind: "COVERAGE_ENDED", startedAt: new Date("2026-09-15T03:25:00.000Z"),
    endedAt: new Date("2026-09-15T03:30:00.000Z"), durationSeconds: 300,
    extra: { metadata: { authorizationTerminalClosure: { version: 1, startedUnder: GENERATION, boundaryOffsetSeconds: 300 } } },
  }, db);
  assert.equal(result.endedAt.toISOString(), "2026-09-15T03:03:00.000Z");
  assert.equal(result.durationSeconds, 180);
});

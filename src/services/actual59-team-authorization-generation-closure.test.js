"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const prismaPath = require.resolve("../prisma");
const servicePath = require.resolve("./telemetry-ingest-service");
const dependencyPaths = [
  "./team-ppv-ledger-service",
  "./team-response-projection-service",
  "./team-pending-projection-service",
  "./team-dialog-projection-authority-service",
  "./custom-content-delivery-tracking-service",
  "./programmatic-of-write-authority-service",
].map((rel) => require.resolve(rel));

const OLD_GENERATION = {
  authorizationScopeIncarnation: "scope-A",
  accessEpoch: 7,
  creatorCatalogGeneration: 3,
};

function terminalEvent(overrides = {}) {
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
    localId: "terminal-1",
    durationSeconds: 600,
    occurredAt: "2026-09-15T02:10:00.000Z",
    metadata: {
      authorizationGeneration: OLD_GENERATION,
      authorizationCapture: { version: 1, semantics: "TERMINAL_CLOSURE", ...OLD_GENERATION, localAuthorizationRevision: null },
      authorizationTerminalClosure: {
        version: 1,
        reason: "authorization_quarantined",
        startedUnder: OLD_GENERATION,
        boundaryOffsetSeconds: 600,
      },
    },
    ...overrides,
  };
}

function currentHuman(overrides = {}) {
  return {
    telemetryVersion: "team_v13_provenance",
    source: "electron_team_v13",
    eventKind: "USER_ACTIVITY",
    actionSource: "MANUAL",
    lifecycle: "OBSERVED",
    creatorId: "creator-1",
    accountId: "creator-1",
    actorMemberId: "member-1",
    actorUserId: "user-1",
    localId: "human-1",
    occurredAt: "2026-09-15T02:20:00.000Z",
    metadata: {
      authorizationCapture: {
        version: 1,
        semantics: "CURRENT_HUMAN",
        authorizationScopeIncarnation: "scope-current",
        accessEpoch: 8,
        creatorCatalogGeneration: 4,
        localAuthorizationRevision: 12,
      },
    },
    ...overrides,
  };
}

function loadService({
  currentAccessEpoch = 8,
  boundaryEndedAt = "2026-09-15T02:03:00.000Z",
  authorizationSessionBoundaryEndedAt = "2026-09-15T02:04:00.000Z",
  authorizationSessionNaturalExpiresAt = "2026-09-15T02:08:00.000Z",
  authorizationSessionDbNow = "2026-09-15T02:30:00.000Z",
  creatorCatalogBoundaryEndedAt = "2026-09-15T02:06:00.000Z",
  currentAuthorizationSessionId = "scope-current",
  currentCreatorCatalogGeneration = 4,
  assignedCreators = ["creator-1"],
  role = "CHATTER",
  creatorDeletedAt = null,
} = {}) {
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
    localId: "start-1",
    startedAt: new Date("2026-09-15T02:00:00.000Z"),
    ts: new Date("2026-09-15T02:00:00.000Z"),
    extra: { metadata: { authorizationGeneration: OLD_GENERATION } },
  }];
  const rawQueries = [];
  const prisma = {
    async $queryRawUnsafe(sql) {
      const text = String(sql || "");
      rawQueries.push(text);
      if (/FROM "RefreshSession"/i.test(text) && /FOR SHARE/i.test(text)) return currentAuthorizationSessionId
        ? [{ id: "refresh-current", authorizationSessionId: currentAuthorizationSessionId }]
        : [];
      if (/FROM "AgencyCreatorCatalogState"/i.test(text) && /FOR SHARE/i.test(text)) return [{ generation: currentCreatorCatalogGeneration }];
      if (/AuthorizationSessionBoundary/i.test(text) && /RefreshSession/i.test(text)) return [{
        revokedEndedAt: authorizationSessionBoundaryEndedAt ? new Date(authorizationSessionBoundaryEndedAt) : null,
        naturalExpiresAt: authorizationSessionNaturalExpiresAt ? new Date(authorizationSessionNaturalExpiresAt) : null,
        dbNow: authorizationSessionDbNow ? new Date(authorizationSessionDbNow) : null,
      }];
      if (/AgencyCreatorCatalogGenerationBoundary/i.test(text)) return creatorCatalogBoundaryEndedAt
        ? [{ endedAt: new Date(creatorCatalogBoundaryEndedAt) }]
        : [];
      if (/FROM "AgencyMember"/i.test(text) && /FOR SHARE OF m/i.test(text)) return [{
        id: "member-1", userId: "user-1", agencyId: "agency-1", accessEpoch: currentAccessEpoch,
        role, roleKey: String(role || "CHATTER").toLowerCase(), assignedCreators, permissions: {}, deletedAt: null, deactivatedAt: null,
      }];
      if (/AgencyMemberAccessEpochBoundary/i.test(text)) {
        return boundaryEndedAt ? [{ endedAt: new Date(boundaryEndedAt) }] : [];
      }
      if (/clock_timestamp/i.test(text)) return [{ authorityNow: new Date("2026-09-15T02:30:00.000Z") }];
      return [];
    },
    async $transaction(work) { return work({ ...(prisma), $transaction: undefined }); },
    creatorAccount: {
      async findFirst({ where }) {
        if (where.agencyId !== "agency-1" || where.id !== "creator-1") return null;
        if (where.deletedAt === null && creatorDeletedAt) return null;
        return { id: "creator-1", username: "creator", remoteId: "123", status: creatorDeletedAt ? "DISABLED" : "READY", deletedAt: creatorDeletedAt ? new Date(creatorDeletedAt) : null };
      },
    },
    agencyMember: {
      async findFirst() {
        return { id: "member-1", userId: "user-1", agencyId: "agency-1", accessEpoch: currentAccessEpoch, role, roleKey: String(role || "CHATTER").toLowerCase(), assignedCreators, permissions: {} };
      },
    },
    teamActivityEvent: {
      async findFirst({ where }) {
        if (where.eventKind === "COVERAGE_STARTED") {
          return rows.find((row) => row.eventKind === "COVERAGE_STARTED"
            && row.agencyId === where.agencyId && row.deviceId === where.deviceId
            && row.memberId === where.memberId && row.userId === where.userId
            && row.creatorId === where.creatorId && row.coverageId === where.coverageId) || null;
        }
        if (Object.prototype.hasOwnProperty.call(where, "localId")) {
          return rows.find((row) => row.agencyId === where.agencyId && row.deviceId === where.deviceId && row.localId === where.localId) || null;
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

  for (const p of [servicePath, prismaPath, ...dependencyPaths]) delete require.cache[p];
  require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: prisma };
  const noops = [
    { async applyLedgerSideEffects() {} },
    { async applyTeamResponseProjection() {} },
    { async applyTeamPendingProjection() {} },
    { async publishTeamProjectionWorkForEvent() {} },
    { async projectCustomDeliveryFromTeamEvent() {} },
    { async projectNativeMassWriteFromTeamEvent() {} },
  ];
  dependencyPaths.forEach((p, i) => { require.cache[p] = { id: p, filename: p, loaded: true, exports: noops[i] }; });
  return { service: require(servicePath), rows, rawQueries };
}

async function ingest(service, event, admittedAccessEpoch = 8) {
  return service.ingestTeamEvents({
    agencyId: "agency-1", deviceId: "device-1", userId: "user-1", memberId: "member-1",
    admittedAccessEpoch, admittedAuthorizationSessionId: "scope-current", events: [event],
  });
}

test("F59-A backend rejects human telemetry without durable capture-generation provenance", async () => {
  const { service, rows } = loadService();
  const event = currentHuman({ metadata: {} });
  const result = await ingest(service, event);
  assert.equal(result.accepted, 0);
  assert.equal(result.rejectedByReason.human_authorization_capture_required, 1);
  assert.equal(rows.filter((row) => row.eventKind === "USER_ACTIVITY").length, 0);
});

test("F59-A backend rejects delayed CURRENT_HUMAN telemetry captured under old accessEpoch", async () => {
  const { service, rows } = loadService({ currentAccessEpoch: 8 });
  const event = currentHuman({
    metadata: { authorizationCapture: { version: 1, semantics: "CURRENT_HUMAN", ...OLD_GENERATION, localAuthorizationRevision: 10 } },
  });
  const result = await ingest(service, event, 8);
  assert.equal(result.accepted, 0);
  assert.equal(result.rejectedByReason.human_authorization_generation_stale, 1);
  assert.equal(rows.filter((row) => row.eventKind === "USER_ACTIVITY").length, 0);
});

test("F59-B telemetry transaction locks the current AgencyMember generation FOR SHARE before human commit", async () => {
  const { service, rawQueries } = loadService({ currentAccessEpoch: 8 });
  const result = await ingest(service, currentHuman(), 8);
  assert.equal(result.accepted, 1);
  assert.ok(rawQueries.some((sql) => /FROM "AgencyMember"/i.test(sql) && /FOR SHARE OF m/i.test(sql)), "commit path must lock current member generation");
});

test("F59-C terminal closure is clamped to durable server access-generation end, not later client detection", async () => {
  const { service, rows } = loadService({ currentAccessEpoch: 8, boundaryEndedAt: "2026-09-15T02:03:00.000Z", assignedCreators: [] });
  const result = await ingest(service, terminalEvent(), 8);
  assert.equal(result.accepted, 1);
  const terminal = rows.find((row) => row.eventKind === "COVERAGE_ENDED");
  assert.ok(terminal);
  assert.equal(terminal.endedAt.toISOString(), "2026-09-15T02:03:00.000Z");
  assert.equal(terminal.durationSeconds, 180);
});

test("F59-C old-generation terminal closure fails closed when no durable server epoch-end boundary exists", async () => {
  const { service, rows } = loadService({ currentAccessEpoch: 8, boundaryEndedAt: null, assignedCreators: [] });
  const result = await ingest(service, terminalEvent(), 8);
  assert.equal(result.accepted, 0);
  assert.equal(result.rejectedByReason.authorization_terminal_closure_unproven, 1);
  assert.equal(rows.filter((row) => row.eventKind === "COVERAGE_ENDED").length, 0);
});



test("F59-C OWNER/all terminal coverage prefers the DB-clock catalog retirement boundary over an earlier application deletedAt", async () => {
  const { service, rows } = loadService({
    currentAccessEpoch: 7,
    boundaryEndedAt: null,
    role: "OWNER",
    assignedCreators: "all",
    currentCreatorCatalogGeneration: 4,
    creatorCatalogBoundaryEndedAt: "2026-09-15T02:06:00.000Z",
    creatorDeletedAt: "2026-09-15T02:02:00.000Z",
  });
  const result = await ingest(service, terminalEvent(), 7);
  assert.equal(result.accepted, 1);
  const terminal = rows.find((row) => row.eventKind === "COVERAGE_ENDED");
  assert.ok(terminal);
  assert.equal(terminal.endedAt.toISOString(), "2026-09-15T02:04:00.000Z", "login boundary is still earlier than the DB-clock creator boundary");
  assert.equal(terminal.durationSeconds, 240);
});

test("F59-C retired creator does not allow a delayed DIALOG_SESSION to create new performance attribution", async () => {
  const { service, rows } = loadService({
    currentAccessEpoch: 7,
    boundaryEndedAt: null,
    role: "OWNER",
    assignedCreators: "all",
    creatorDeletedAt: "2026-09-15T02:02:00.000Z",
  });
  const event = terminalEvent({ eventKind: "DIALOG_SESSION", localId: "dialog-terminal-1", dialogId: "fan-1", fanId: "fan-1" });
  const result = await ingest(service, event, 7);
  assert.equal(result.accepted, 0);
  assert.equal(result.rejectedByReason.creator_retired, 1);
  assert.equal(rows.filter((row) => row.eventKind === "DIALOG_SESSION").length, 0);
});

test("F59-C member epoch boundary wins when it ended before later creator retirement", async () => {
  const { service, rows } = loadService({
    currentAccessEpoch: 8,
    boundaryEndedAt: "2026-09-15T02:03:00.000Z",
    assignedCreators: [],
    creatorDeletedAt: "2026-09-15T02:05:00.000Z",
  });
  const result = await ingest(service, terminalEvent(), 8);
  assert.equal(result.accepted, 1);
  const terminal = rows.find((row) => row.eventKind === "COVERAGE_ENDED");
  assert.ok(terminal);
  assert.equal(terminal.endedAt.toISOString(), "2026-09-15T02:03:00.000Z");
  assert.equal(terminal.durationSeconds, 180);
});

test("INT59.3 CURRENT_HUMAN requires the exact server login lineage, not merely the same member/accessEpoch", async () => {
  const { service, rows } = loadService();
  const result = await ingest(service, currentHuman({
    metadata: { authorizationCapture: {
      version: 1, semantics: "CURRENT_HUMAN", authorizationScopeIncarnation: "scope-old",
      accessEpoch: 8, creatorCatalogGeneration: 4, localAuthorizationRevision: 12,
    } },
  }), 8);
  assert.equal(result.accepted, 0);
  assert.equal(result.rejectedByReason.human_authorization_generation_stale, 1);
  assert.equal(rows.some((row) => row.localId === "human-1"), false);
});

test("INT59.3 CURRENT_HUMAN requires the exact locked creator-catalog generation", async () => {
  const { service, rows } = loadService();
  const result = await ingest(service, currentHuman({
    metadata: { authorizationCapture: {
      version: 1, semantics: "CURRENT_HUMAN", authorizationScopeIncarnation: "scope-current",
      accessEpoch: 8, creatorCatalogGeneration: 3, localAuthorizationRevision: 12,
    } },
  }), 8);
  assert.equal(result.accepted, 0);
  assert.equal(result.rejectedByReason.human_authorization_generation_stale, 1);
  assert.equal(rows.some((row) => row.localId === "human-1"), false);
});

test("INT59.3 exact current login/member/catalog generation remains admissible", async () => {
  const { service, rows } = loadService();
  const result = await ingest(service, currentHuman(), 8);
  assert.equal(result.accepted, 1);
  assert.equal(result.skipped, 0);
  assert.equal(rows.some((row) => row.localId === "human-1"), true);
});

test("INT59.3 old-login terminal closure fails closed without a proven revoke or elapsed natural-expiry boundary", async () => {
  const { service, rows } = loadService({
    authorizationSessionBoundaryEndedAt: null,
    authorizationSessionNaturalExpiresAt: "2026-09-15T03:00:00.000Z",
  });
  const result = await ingest(service, terminalEvent(), 8);
  assert.equal(result.accepted, 0);
  assert.equal(result.rejectedByReason.authorization_terminal_closure_unproven, 1);
  assert.equal(rows.some((row) => row.localId === "terminal-1"), false);
});

test("INT59.3 terminal closure consults login, member and catalog server boundaries and clamps to the earliest", async () => {
  const { service, rows, rawQueries } = loadService({
    boundaryEndedAt: "2026-09-15T02:05:00.000Z",
    authorizationSessionBoundaryEndedAt: "2026-09-15T02:04:00.000Z",
    creatorCatalogBoundaryEndedAt: "2026-09-15T02:06:00.000Z",
  });
  const result = await ingest(service, terminalEvent(), 8);
  assert.equal(result.accepted, 1);
  const terminal = rows.find((row) => row.localId === "terminal-1");
  assert.equal(terminal.endedAt.toISOString(), "2026-09-15T02:04:00.000Z");
  assert.ok(rawQueries.some((sql) => /AuthorizationSessionBoundary/.test(sql)));
  assert.ok(rawQueries.some((sql) => /AgencyMemberAccessEpochBoundary/.test(sql)));
  assert.ok(rawQueries.some((sql) => /AgencyCreatorCatalogGenerationBoundary/.test(sql)));
});

test("INT59.4B natural refresh-lineage expiry is an authoritative terminal boundary even without a revoke row", async () => {
  const { service, rows } = loadService({
    authorizationSessionBoundaryEndedAt: null,
    authorizationSessionNaturalExpiresAt: "2026-09-15T02:02:30.000Z",
    authorizationSessionDbNow: "2026-09-15T02:30:00.000Z",
    boundaryEndedAt: "2026-09-15T02:05:00.000Z",
    creatorCatalogBoundaryEndedAt: "2026-09-15T02:06:00.000Z",
  });
  const result = await ingest(service, terminalEvent(), 8);
  assert.equal(result.accepted, 1);
  const terminal = rows.find((row) => row.localId === "terminal-1");
  assert.equal(terminal.endedAt.toISOString(), "2026-09-15T02:02:30.000Z");
  assert.equal(terminal.durationSeconds, 150);
});

test("INT59.4B late explicit revoke cannot move a lineage end later than its natural expiry", async () => {
  const { service, rows } = loadService({
    authorizationSessionBoundaryEndedAt: "2026-09-15T02:09:00.000Z",
    authorizationSessionNaturalExpiresAt: "2026-09-15T02:02:30.000Z",
    authorizationSessionDbNow: "2026-09-15T02:30:00.000Z",
    boundaryEndedAt: "2026-09-15T02:05:00.000Z",
    creatorCatalogBoundaryEndedAt: "2026-09-15T02:06:00.000Z",
  });
  const result = await ingest(service, terminalEvent(), 8);
  assert.equal(result.accepted, 1);
  const terminal = rows.find((row) => row.localId === "terminal-1");
  assert.equal(terminal.endedAt.toISOString(), "2026-09-15T02:02:30.000Z");
});

test("INT59.4B differing lineage with no revoke and a future natural expiry still fails closed", async () => {
  const { service, rows } = loadService({
    authorizationSessionBoundaryEndedAt: null,
    authorizationSessionNaturalExpiresAt: "2026-09-15T03:00:00.000Z",
    authorizationSessionDbNow: "2026-09-15T02:30:00.000Z",
  });
  const result = await ingest(service, terminalEvent(), 8);
  assert.equal(result.accepted, 0);
  assert.equal(result.rejectedByReason.authorization_terminal_closure_unproven, 1);
  assert.equal(rows.some((row) => row.localId === "terminal-1"), false);
});

test("Actual59 migration creates trigger-owned access epoch boundary ledger and versioned telemetry endpoint", () => {
  const root = path.resolve(__dirname, "../..");
  const migration = fs.readFileSync(path.join(root, "prisma/migrations/20260915131500_actual59_team_authorization_generation_boundary/migration.sql"), "utf8");
  const int593 = fs.readFileSync(path.join(root, "prisma/migrations/20260915193000_actual59_int59_3_authorization_lineage_catalog_boundary/migration.sql"), "utf8");
  const schema = fs.readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
  const route = fs.readFileSync(path.join(root, "src/routes/telemetry.js"), "utf8");
  const creatorLifecycle = fs.readFileSync(path.join(root, "src/services/creator-lifecycle-authority-service.js"), "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "AgencyMemberAccessEpochBoundary"/);
  assert.match(migration, /AFTER UPDATE OF "accessEpoch" ON "AgencyMember"/);
  assert.match(migration, /OLD\."accessEpoch"[\s\S]*NEW\."accessEpoch"/);
  assert.match(int593, /capture_agency_member_access_epoch_boundary[\s\S]*clock_timestamp\(\)/, "INT59.3 must move the physical epoch-end boundary to post-lock DB time");
  assert.match(int593, /AuthorizationSessionBoundary/);
  assert.match(int593, /AgencyCreatorCatalogGenerationBoundary/);
  assert.match(schema, /model AgencyMemberAccessEpochBoundary[\s\S]*@@id\(\[memberId, accessEpoch\]\)/);
  assert.match(route, /router\.post\("\/events\/ingest\/current-authorized"[\s\S]*AUTHORIZATION_SESSION_REQUIRED/);
  assert.match(route, /router\.post\("\/events\/ingest"[\s\S]*TELEMETRY_CLIENT_UPGRADE_REQUIRED/, "legacy human telemetry must be retry-gated during rolling activation instead of dead-lettered");
  assert.match(creatorLifecycle, /if \(!current\.deletedAt\)[\s\S]*deletedAt: retiredAt/, "creator retirement timestamp must be written once by canonical retirement authority");
  assert.match(creatorLifecycle, /type: "CREATOR_REVOKED"/, "broad-scope retirement remains a creator-wide access boundary even without member epoch bump");
});

test("F59-C terminal dialog projection cannot preserve client wall/active counters beyond server-bounded chronology", async () => {
  const projectionPath = require.resolve("./team-response-projection-service");
  delete require.cache[projectionPath];
  const { upsertDialogSession } = require(projectionPath);
  let persisted = null;
  const db = {
    teamDialogSession: {
      async upsert(input) { persisted = input.create; return input.create; },
    },
  };
  await upsertDialogSession({
    id: "event-dialog-1", agencyId: "agency-1", creatorId: "creator-1", memberId: "member-1", userId: "user-1", deviceId: "device-1",
    eventKind: "DIALOG_SESSION", actionSource: "MANUAL", lifecycle: "OBSERVED", dialogId: "fan-1", fanId: "fan-1",
    correlationId: "dialog-session-1", coverageId: "coverage-1",
    startedAt: new Date("2026-09-15T02:00:00.000Z"), endedAt: new Date("2026-09-15T02:00:30.000Z"), durationSeconds: 30,
    extra: { metadata: {
      wallSeconds: 120, activeSeconds: 45,
      authorizationTerminalClosure: { version: 1, reason: "authorization_quarantined", startedUnder: OLD_GENERATION, boundaryOffsetSeconds: 120 },
    } },
  }, db);
  assert.ok(persisted);
  assert.equal(persisted.wallSeconds, 30);
  assert.equal(persisted.activeSeconds, 30);
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  projectFanIdentity,
  projectFanRelationship,
  projectFanValue,
  projectFanObservationBatch,
} = require("./fan-data-authority-service");

function compareValue(actual, condition) {
  if (condition === null) return actual == null;
  if (!condition || typeof condition !== "object" || condition instanceof Date) return actual === condition;
  if (Object.prototype.hasOwnProperty.call(condition, "lt")) return actual != null && actual < condition.lt;
  if (Object.prototype.hasOwnProperty.call(condition, "in")) return condition.in.includes(actual);
  return false;
}
function matchesWhere(row, where = {}) {
  if (!row) return false;
  if (Array.isArray(where.OR) && !where.OR.some((branch) => matchesWhere(row, branch))) return false;
  for (const [key, condition] of Object.entries(where)) {
    if (key === "OR") continue;
    if (key.includes("_") && condition && typeof condition === "object" && !Array.isArray(condition) && !Object.keys(condition).some((k) => ["lt", "in"].includes(k))) {
      for (const [innerKey, innerValue] of Object.entries(condition)) if (row[innerKey] !== innerValue) return false;
      continue;
    }
    if (!compareValue(row[key], condition)) return false;
  }
  return true;
}
function p2002() { const error = new Error("unique"); error.code = "P2002"; return error; }

function directDb() {
  let fan = {
    id: "fan-record-1", agencyId: "agency-1", creatorId: "creator-1", onlyFansUserId: "fan-1",
    username: null, displayName: null, avatarUrl: null, headerUrl: null,
    identityObservedAt: null, identitySource: null, identityCompleteness: null, identityAuthorityVersion: null,
    usernameAuthorityVersion: null, displayNameAuthorityVersion: null, avatarAuthorityVersion: null, headerAuthorityVersion: null,
    firstSeenAt: new Date("2026-09-01T00:00:00Z"), lastSeenAt: new Date("2026-09-01T00:00:00Z"), lastActivityObservedAt: null,
  };
  let relationship = null;
  let value = null;
  const db = {
    get fan() { return fan; }, get relationship() { return relationship; }, get value() { return value; },
    creatorFan: {
      findUnique: async () => fan,
      findMany: async () => fan ? [fan] : [],
      create: async ({ data }) => { if (fan) throw p2002(); fan = { ...data }; return fan; },
      updateMany: async ({ where, data }) => { if (!matchesWhere(fan, where)) return { count: 0 }; fan = { ...fan, ...data }; return { count: 1 }; },
    },
    creatorFanRelationshipCurrent: {
      findUnique: async () => relationship,
      create: async ({ data }) => { if (relationship) throw p2002(); relationship = { id: "rel-1", ...data }; return relationship; },
      updateMany: async ({ where, data }) => { if (!matchesWhere(relationship, where)) return { count: 0 }; relationship = { ...relationship, ...data }; return { count: 1 }; },
    },
    creatorFanValueCurrent: {
      findUnique: async () => value,
      create: async ({ data }) => { if (value) throw p2002(); value = { id: "value-1", ...data }; return value; },
      updateMany: async ({ where, data }) => { if (!matchesWhere(value, where)) return { count: 0 }; value = { ...value, ...data }; return { count: 1 }; },
    },
  };
  return db;
}

async function expectConflict(promise, field) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, "FAN_DATA_SAME_GENERATION_CONFLICT");
    assert.equal(error?.status, 409);
    assert.equal(error?.details?.field, field);
    return true;
  });
}

const AT = "2026-09-17T00:10:00.000Z";

test("INT5.4C-2A direct canonical projectors reject same-source same-generation contradictory fields", async () => {
  const db = directDb();
  await projectFanIdentity(db, { agencyId: "agency-1", creatorId: "creator-1", onlyFansUserId: "fan-1", observedAt: AT, source: "USER_PROFILE", username: "alpha" });
  await expectConflict(projectFanIdentity(db, { agencyId: "agency-1", creatorId: "creator-1", onlyFansUserId: "fan-1", observedAt: AT, source: "USER_PROFILE", username: "beta" }), "username");
  assert.equal(db.fan.username, "alpha");

  await projectFanRelationship(db, { agencyId: "agency-1", creatorId: "creator-1", onlyFansUserId: "fan-1", observedAt: AT, source: "USER_PROFILE", creatorFollowsFan: false });
  await expectConflict(projectFanRelationship(db, { agencyId: "agency-1", creatorId: "creator-1", onlyFansUserId: "fan-1", observedAt: AT, source: "USER_PROFILE", creatorFollowsFan: true }), "creatorFollowsFan");
  assert.equal(db.relationship.creatorFollowsFan, false);

  await projectFanValue(db, { agencyId: "agency-1", creatorId: "creator-1", onlyFansUserId: "fan-1", observedAt: AT, source: "USER_PROFILE", availability: "AVAILABLE", totalSpentCents: 100 });
  await expectConflict(projectFanValue(db, { agencyId: "agency-1", creatorId: "creator-1", onlyFansUserId: "fan-1", observedAt: AT, source: "USER_PROFILE", availability: "AVAILABLE", totalSpentCents: 200 }), "platformReportedTotalSpendCents");
  assert.equal(db.value.platformReportedTotalSpendCents, 100n);
});

test("INT5.4C-2A identical replay is idempotent while a different source may still outrank at the same timestamp", async () => {
  const db = directDb();
  const input = { agencyId: "agency-1", creatorId: "creator-1", onlyFansUserId: "fan-1", observedAt: AT, source: "CAMPAIGN_CLAIMER", username: "same" };
  await projectFanIdentity(db, input);
  await projectFanIdentity(db, input);
  assert.equal(db.fan.username, "same");

  await projectFanIdentity(db, { ...input, source: "USER_PROFILE", username: "profile" });
  assert.equal(db.fan.username, "profile");
  assert.equal(db.fan.identitySource, "USER_PROFILE");
});

test("INT5.4C-2A bulk batch rejects contradictory duplicate facts before any SQL mutation", async () => {
  const writes = [];
  const tx = { async $executeRawUnsafe(sql, ...args) { writes.push({ sql, args }); return 1; } };
  const db = { async $transaction(work) { return work(tx); } };
  await expectConflict(projectFanObservationBatch(db, {
    agencyId: "agency-1", creatorId: "creator-1",
    allowedSources: ["USER_PROFILE"], observedAtPolicy: "TRUSTED_INPUT",
    items: [
      { onlyFansUserId: "fan-1", relationship: { source: "USER_PROFILE", observedAt: AT, blocked: false } },
      { onlyFansUserId: "fan-1", relationship: { source: "USER_PROFILE", observedAt: AT, blocked: true } },
    ],
  }), "blocked");
  assert.equal(writes.length, 0);
});

test("INT5.4C-2A production bulk fence rejects contradiction against persisted canonical after fan lock", async () => {
  const writes = [];
  const locks = [];
  let currentVersion = null;
  // First use the public projector with a semantic adapter to obtain the exact persisted authority version.
  const seed = directDb();
  await projectFanRelationship(seed, { agencyId: "agency-1", creatorId: "creator-1", onlyFansUserId: "fan-1", observedAt: AT, source: "USER_PROFILE", blocked: false });
  currentVersion = seed.relationship.blockedAuthorityVersion;

  const tx = {
    async $queryRawUnsafe() { return []; },
    async $executeRawUnsafe(sql, ...args) {
      const statement = String(sql);
      if (/pg_advisory_xact_lock/.test(statement)) locks.push({ sql: statement, args });
      else writes.push({ sql: statement, args });
      return 1;
    },
    creatorFan: {
      async findMany() { return [{ id: "fan-record-1", creatorId: "creator-1", onlyFansUserId: "fan-1" }]; },
    },
    creatorFanRelationshipCurrent: {
      async findMany() { return [{ creatorId: "creator-1", onlyFansUserId: "fan-1", blockedAuthorityVersion: currentVersion }]; },
    },
    creatorFanValueCurrent: { async findMany() { return []; } },
  };
  const db = { async $transaction(work) { return work(tx); } };
  await expectConflict(projectFanObservationBatch(db, {
    agencyId: "agency-1", creatorId: "creator-1",
    allowedSources: ["USER_PROFILE"], observedAtPolicy: "TRUSTED_INPUT",
    items: [{ onlyFansUserId: "fan-1", relationship: { source: "USER_PROFILE", observedAt: AT, blocked: true } }],
  }), "blocked");
  assert.equal(locks.length, 1, "creator-scoped shared advisory transaction lock must be acquired before persisted conflict check");
  assert.equal(writes.length, 0, "conflict must abort before canonical SQL writes");
});

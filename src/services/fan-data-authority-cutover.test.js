"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  projectFanIdentity,
  projectFanRelationship,
  projectFanValue,
  projectSubscriberDirectoryRun,
  VALUE_AVAILABILITY,
} = require("./fan-data-authority-service");

const ROOT = path.resolve(__dirname, "../..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function compareValue(actual, condition) {
  if (condition === null) return actual == null;
  if (!condition || typeof condition !== "object" || condition instanceof Date) return actual === condition;
  if (Object.prototype.hasOwnProperty.call(condition, "lt")) return actual != null && actual < condition.lt;
  if (Object.prototype.hasOwnProperty.call(condition, "gt")) return actual != null && actual > condition.gt;
  if (Object.prototype.hasOwnProperty.call(condition, "in")) return condition.in.includes(actual);
  return false;
}
function matchesWhere(row, where = {}) {
  if (!row) return false;
  if (Array.isArray(where.OR) && !where.OR.some((branch) => matchesWhere(row, branch))) return false;
  for (const [key, condition] of Object.entries(where)) {
    if (key === "OR") continue;
    if (key.includes("_") && condition && typeof condition === "object" && !Array.isArray(condition) && !Object.keys(condition).some((k) => ["lt","gt","in"].includes(k))) {
      // Compound unique selector: compare its actual fields.
      for (const [innerKey, innerValue] of Object.entries(condition)) if (row[innerKey] !== innerValue) return false;
      continue;
    }
    if (!compareValue(row[key], condition)) return false;
  }
  return true;
}
function p2002() { const error = new Error("unique"); error.code = "P2002"; return error; }

function authorityTx({ fan: initialFan = null, relationship: initialRelationship = null, value: initialValue = null, delayWrite = null } = {}) {
  let fan = initialFan ? { ...initialFan } : null;
  let relationship = initialRelationship ? { ...initialRelationship } : null;
  let value = initialValue ? { ...initialValue } : null;
  const maybeDelay = async (data) => { if (delayWrite) await delayWrite(data || {}); };
  return {
    get fan() { return fan; },
    get relationship() { return relationship; },
    get value() { return value; },
    creatorFan: {
      findUnique: async () => fan,
      findMany: async () => fan ? [fan] : [],
      create: async ({ data }) => { if (fan) throw p2002(); fan = { ...data }; return fan; },
      createMany: async ({ data }) => { if (!fan && data?.[0]) fan = { ...data[0] }; return { count: fan ? 1 : 0 }; },
      updateMany: async ({ where, data }) => {
        await maybeDelay(data);
        if (!matchesWhere(fan, where)) return { count: 0 };
        fan = { ...fan, ...data };
        return { count: 1 };
      },
    },
    creatorFanRelationshipCurrent: {
      findUnique: async () => relationship,
      create: async ({ data }) => { if (relationship) throw p2002(); relationship = { id: "relationship-1", ...data }; return relationship; },
      updateMany: async ({ where, data }) => {
        await maybeDelay(data);
        if (!matchesWhere(relationship, where)) return { count: 0 };
        relationship = { ...relationship, ...data };
        return { count: 1 };
      },
    },
    creatorFanValueCurrent: {
      findUnique: async () => value,
      create: async ({ data }) => { if (value) throw p2002(); value = { id: "value-1", ...data }; return value; },
      updateMany: async ({ where, data }) => {
        await maybeDelay(data);
        if (!matchesWhere(value, where)) return { count: 0 };
        value = { ...value, ...data };
        return { count: 1 };
      },
    },
  };
}

const baseFan = () => ({
  id: "fan-record-1", agencyId: "a", creatorId: "c", onlyFansUserId: "123",
  username: null, displayName: null, avatarUrl: null, headerUrl: null,
  identityObservedAt: null, identitySource: null, identityCompleteness: null, identityAuthorityVersion: null,
  usernameAuthorityVersion: null, displayNameAuthorityVersion: null, avatarAuthorityVersion: null, headerAuthorityVersion: null,
  firstSeenAt: new Date("2026-01-01T00:00:00Z"), lastSeenAt: new Date("2026-01-01T00:00:00Z"), lastActivityObservedAt: null,
});

async function projectIdentity(tx, observedAt, source, fields) {
  return projectFanIdentity(tx, { agencyId: "a", creatorId: "c", onlyFansUserId: "123", observedAt, source, ...fields });
}
async function projectRelationship(tx, observedAt, fields) {
  return projectFanRelationship(tx, { agencyId: "a", creatorId: "c", onlyFansUserId: "123", observedAt, source: "USER_PROFILE", ...fields });
}
async function projectValue(tx, observedAt, totalSpentCents, availability = "AVAILABLE", extra = {}) {
  return projectFanValue(tx, { agencyId: "a", creatorId: "c", onlyFansUserId: "123", observedAt, source: "USER_PROFILE", totalSpentCents, availability, ...extra });
}

test("identity field clocks reject delayed identity while preserving newer current profile", async () => {
  const tx = authorityTx({ fan: baseFan() });
  await projectIdentity(tx, "2026-08-30T12:00:00Z", "USER_PROFILE", { username: "NEW", platformDisplayName: "New", avatarUrl: "new.jpg" });
  await projectIdentity(tx, "2026-08-29T12:00:00Z", "LIVE_NOTIFICATION", { username: "OLD", platformDisplayName: "Old" });
  assert.equal(tx.fan.username, "NEW");
  assert.equal(tx.fan.displayName, "New");
  assert.equal(tx.fan.identitySource, "USER_PROFILE");
});

test("equal identity timestamp uses source quality and deterministic value hash as tie-breakers", async () => {
  const tx = authorityTx({ fan: baseFan() });
  await projectIdentity(tx, "2026-08-30T12:00:00Z", "CAMPAIGN_CLAIMER", { username: "campaign" });
  await projectIdentity(tx, "2026-08-30T12:00:00Z", "USER_PROFILE", { username: "profile" });
  assert.equal(tx.fan.username, "profile");
  assert.equal(tx.fan.identitySource, "USER_PROFILE");
});

test("value-only fan creation does not manufacture identity freshness", async () => {
  const tx = authorityTx();
  await projectValue(tx, "2026-08-30T12:00:00Z", 500);
  assert.equal(tx.fan.username, null);
  assert.equal(tx.fan.identityObservedAt, null);
  assert.equal(tx.fan.identitySource, null);
  assert.equal(tx.fan.identityCompleteness, null);
});

test("synthetic rejected identity cannot advance clock and shadow a real intermediate profile", async () => {
  const tx = authorityTx({ fan: baseFan() });
  await projectIdentity(tx, "2026-08-30T10:00:00Z", "USER_PROFILE", { username: "new_user" });
  await projectFanIdentity(tx, {
    agencyId: "a", creatorId: "c", onlyFansUserId: "123", username: "u123",
    observedAt: "2026-08-30T12:00:00Z", source: "PRESENCE_HINT", rejectSyntheticIdentity: true,
  });
  await projectIdentity(tx, "2026-08-30T11:00:00Z", "USER_PROFILE", { username: "real_between" });
  assert.equal(tx.fan.username, "real_between");
  assert.equal(tx.fan.identityObservedAt.toISOString(), "2026-08-30T11:00:00.000Z");
});

test("Presence projector boundary is temporal-only even for a stale caller with non-synthetic data", async () => {
  const tx = authorityTx({ fan: baseFan() });
  await projectIdentity(tx, "2026-08-30T10:00:00Z", "USER_PROFILE", { username: "real_user" });
  await projectFanIdentity(tx, {
    agencyId: "a", creatorId: "c", onlyFansUserId: "123", username: "presence_user",
    observedAt: "2026-08-30T12:00:00Z", source: "PRESENCE_HINT",
  });
  assert.equal(tx.fan.username, "real_user");
  assert.equal(tx.fan.identityObservedAt.toISOString(), "2026-08-30T10:00:00.000Z");

  await projectValue(tx, "2026-08-30T10:00:00Z", 1000);
  const result = await projectFanValue(tx, {
    agencyId: "a", creatorId: "c", onlyFansUserId: "123", observedAt: "2026-08-30T12:00:00Z",
    source: "PRESENCE_HINT", availability: "AVAILABLE", totalSpentCents: 9999,
  });
  assert.equal(result.replay, true);
  assert.equal(tx.value.platformReportedTotalSpendCents, 1000n);
});

test("partial identity fields have independent freshness", async () => {
  const tx = authorityTx({ fan: baseFan() });
  await projectIdentity(tx, "2026-08-30T10:00:00Z", "USER_PROFILE", { avatarUrl: "old-avatar" });
  await projectIdentity(tx, "2026-08-30T13:00:00Z", "USER_PROFILE", { username: "newest_username" });
  await projectIdentity(tx, "2026-08-30T12:00:00Z", "USER_PROFILE", { avatarUrl: "new-avatar" });
  assert.equal(tx.fan.username, "newest_username");
  assert.equal(tx.fan.avatarUrl, "new-avatar");
});

test("identity inverse physical commit order cannot roll T12 back to T11", async () => {
  const tx = authorityTx({ fan: baseFan(), delayWrite: async (data) => {
    const version = Object.values(data).find((v) => typeof v === "string" && v.includes("T11:00:00.000Z"));
    if (version) await new Promise((resolve) => setTimeout(resolve, 20));
  } });
  await projectIdentity(tx, "2026-08-30T10:00:00Z", "USER_PROFILE", { username: "T10" });
  await Promise.all([
    projectIdentity(tx, "2026-08-30T11:00:00Z", "USER_PROFILE", { username: "T11" }),
    projectIdentity(tx, "2026-08-30T12:00:00Z", "USER_PROFILE", { username: "T12" }),
  ]);
  assert.equal(tx.fan.username, "T12");
});

test("relationship missing does not clear known value while explicit null does", async () => {
  const tx = authorityTx({ fan: baseFan() });
  await projectRelationship(tx, "2026-08-30T10:00:00Z", { fanSubscriptionExpiresAt: "2026-09-30T00:00:00Z", canReceiveChatMessage: true });
  await projectRelationship(tx, "2026-08-30T11:00:00Z", { canReceiveChatMessage: false });
  assert.equal(tx.relationship.fanSubscriptionExpiresAt.toISOString(), "2026-09-30T00:00:00.000Z");
  await projectRelationship(tx, "2026-08-30T12:00:00Z", { fanSubscriptionExpiresAt: null });
  assert.equal(tx.relationship.fanSubscriptionExpiresAt, null);
});

test("relationship partial fields have independent freshness", async () => {
  const tx = authorityTx({ fan: baseFan() });
  await projectRelationship(tx, "2026-08-30T10:00:00Z", { creatorFollowsFan: false });
  await projectRelationship(tx, "2026-08-30T13:00:00Z", { canReceiveChatMessage: true });
  await projectRelationship(tx, "2026-08-30T12:00:00Z", { creatorFollowsFan: true });
  assert.equal(tx.relationship.canReceiveChatMessage, true);
  assert.equal(tx.relationship.creatorFollowsFan, true);
});

test("relationship explicit null clears a boolean while omission preserves it", async () => {
  const tx = authorityTx({ fan: baseFan() });
  await projectRelationship(tx, "2026-08-30T10:00:00Z", { blocked: true, restricted: true });
  await projectRelationship(tx, "2026-08-30T11:00:00Z", { restricted: false });
  assert.equal(tx.relationship.blocked, true);
  assert.equal(tx.relationship.restricted, false);
  await projectRelationship(tx, "2026-08-30T12:00:00Z", { blocked: null });
  assert.equal(tx.relationship.blocked, null);
});

test("relationship inverse physical commit order cannot roll T12 back to T11", async () => {
  const tx = authorityTx({ fan: baseFan(), delayWrite: async (data) => {
    const version = Object.values(data).find((v) => typeof v === "string" && v.includes("T11:00:00.000Z"));
    if (version) await new Promise((resolve) => setTimeout(resolve, 20));
  } });
  await projectRelationship(tx, "2026-08-30T10:00:00Z", { creatorFollowsFan: false });
  await Promise.all([
    projectRelationship(tx, "2026-08-30T11:00:00Z", { creatorFollowsFan: false }),
    projectRelationship(tx, "2026-08-30T12:00:00Z", { creatorFollowsFan: true }),
  ]);
  assert.equal(tx.relationship.creatorFollowsFan, true);
});

test("AVAILABLE zero is a real business fact", async () => {
  const tx = authorityTx({ fan: baseFan() });
  await projectValue(tx, "2026-08-30T12:00:00Z", 0);
  assert.equal(tx.value.availability, "AVAILABLE");
  assert.equal(tx.value.platformReportedTotalSpendCents, 0n);
});

test("MALFORMED newer observation changes availability but preserves last known numeric value", async () => {
  const tx = authorityTx({ fan: baseFan() });
  await projectValue(tx, "2026-08-29T12:00:00Z", 12500, "AVAILABLE", { messagesSpentCents: 5000 });
  await projectValue(tx, "2026-08-30T12:00:00Z", null, "MALFORMED");
  assert.equal(tx.value.availability, "MALFORMED");
  assert.equal(tx.value.platformReportedTotalSpendCents, 12500n);
  assert.equal(tx.value.messagesSpentCents, 5000n);
});

test("older value observation cannot roll current value backward", async () => {
  const tx = authorityTx({ fan: baseFan() });
  await projectValue(tx, "2026-08-30T12:00:00Z", 20000);
  const result = await projectValue(tx, "2026-08-29T12:00:00Z", 100);
  assert.equal(result.replay, true);
  assert.equal(tx.value.platformReportedTotalSpendCents, 20000n);
});

test("value component clocks are independent from a newer total-only observation", async () => {
  const tx = authorityTx({ fan: baseFan() });
  await projectValue(tx, "2026-08-30T10:00:00Z", 1000, "AVAILABLE", { messagesSpentCents: 100 });
  await projectValue(tx, "2026-08-30T13:00:00Z", 1300);
  await projectValue(tx, "2026-08-30T12:00:00Z", 1200, "AVAILABLE", { messagesSpentCents: 120 });
  assert.equal(tx.value.platformReportedTotalSpendCents, 1300n);
  assert.equal(tx.value.messagesSpentCents, 120n);
});

test("value inverse physical commit order cannot roll T12 back to T11", async () => {
  const tx = authorityTx({ fan: baseFan(), delayWrite: async (data) => {
    if (typeof data.valueAuthorityVersion === "string" && data.valueAuthorityVersion.includes("T11:00:00.000Z")) await new Promise((resolve) => setTimeout(resolve, 20));
  } });
  await projectValue(tx, "2026-08-30T10:00:00Z", 1000);
  await Promise.all([
    projectValue(tx, "2026-08-30T11:00:00Z", 1100),
    projectValue(tx, "2026-08-30T12:00:00Z", 1200),
  ]);
  assert.equal(tx.value.platformReportedTotalSpendCents, 1200n);
});

test("legacy CreatorFan migration does not invent identity freshness from lastSeenAt", () => {
  const migration = read("prisma/migrations/20260830160000_fan_data_authority_cutover/migration.sql");
  assert.match(migration, /"identityObservedAt"\s*=\s*NULL/);
  assert.match(migration, /LEGACY_UNCLASSIFIED/);
  assert.doesNotMatch(migration, /"identityObservedAt"\s*=\s*COALESCE\(\s*"identityObservedAt"\s*,\s*"lastSeenAt"/);
  assert.match(migration, /"lastActivityObservedAt"\s*=\s*COALESCE\(\s*"lastActivityObservedAt"\s*,\s*"lastSeenAt"/);
});

test("semantic closure migration removes legacy Traffic/Presence false identity clocks and adds field authority versions", () => {
  const migration = read("prisma/migrations/20260830213000_fan_data_authority_semantic_closure/migration.sql");
  assert.match(migration, /WHERE "identitySource" = 'TRAFFIC_LEGACY_MIGRATION'[\s\S]*"username" IS NULL[\s\S]*"headerUrl" IS NULL/);
  assert.match(migration, /WHERE "identitySource" = 'PRESENCE_HINT'/);
  assert.match(migration, /"identityObservedAt" = NULL,[\s\S]*"identitySource" = NULL,[\s\S]*"identityCompleteness" = NULL/);
  for (const column of [
    "usernameAuthorityVersion", "avatarAuthorityVersion",
    "fanSubscribesToCreatorAuthorityVersion", "blockedAuthorityVersion",
    "platformReportedTotalSpendCentsAuthorityVersion", "messagesSpentCentsAuthorityVersion",
  ]) assert.match(migration, new RegExp(`ADD COLUMN "${column}" TEXT`));
});

test("schema establishes separate identity relationship and value clocks with explicit ids", () => {
  const schema = read("prisma/schema.prisma");
  assert.match(schema, /model CreatorFan[\s\S]*identityObservedAt\s+DateTime\?/);
  assert.match(schema, /@@index\(\[creatorId, identityObservedAt\], map: "CreatorFan_creatorId_identityObservedAt_idx"\)/);
  assert.match(schema, /model CreatorFanRelationshipCurrent[\s\S]*fanRecordId\s+String[\s\S]*onlyFansUserId\s+String[\s\S]*observedAt\s+DateTime/);
  const relationshipModel = schema.match(/model CreatorFanRelationshipCurrent \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(relationshipModel, /@@unique\(\[creatorId, fanRecordId\], map: "CreatorFanRelationshipCurrent_creatorId_fanRecordId_key"\)/);
  const migration = read("prisma/migrations/20260830160000_fan_data_authority_cutover/migration.sql");
  assert.match(migration, /CREATE UNIQUE INDEX "CreatorFanRelationshipCurrent_creatorId_fanRecordId_key"[\s\S]*ON "CreatorFanRelationshipCurrent"\("creatorId", "fanRecordId"\)/);
  const valueModel = schema.match(/model CreatorFanValueCurrent \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(valueModel, /fanRecordId\s+String\s+@map\("fanId"\)/);
  assert.match(valueModel, /availability\s+String/);
  assert.match(valueModel, /valueObservedAt\s+DateTime/);
});

test("traffic has no second current fan-value model or orphan refresh key", () => {
  const schema = read("prisma/schema.prisma");
  const traffic = read("src/services/traffic-service.js");
  const catalog = read("src/services/job-catalog.js");
  assert.doesNotMatch(schema, /model TrafficFanValueSnapshot\b/);
  assert.doesNotMatch(traffic, /trafficFanValueSnapshot/);
  assert.doesNotMatch(`${traffic}\n${catalog}`, /traffic_fan_value_refresh/);
  assert.match(`${traffic}\n${catalog}`, /fan_data_point_refresh/);
});

test("Traffic compatibility fan-value ingress and parser are fully removed", () => {
  const route = read("src/routes/traffic.js");
  const service = read("src/services/traffic-service.js");
  assert.doesNotMatch(route, /value-snapshots\/upsert/);
  assert.doesNotMatch(`${route}\n${service}`, /TRAFFIC_COMPAT/);
  assert.doesNotMatch(service, /upsertTrafficFanValueSnapshots|normalizeSnapshot\s*\(|parseMoneyObservation|firstMoneyObservation/);
});

test("all direct CreatorFan foreign keys use fanRecordId vocabulary", () => {
  const schema = read("prisma/schema.prisma");
  const modelBodies = [...schema.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)];
  const directRelations = [];
  for (const [, modelName, body] of modelBodies) {
    for (const line of body.split("\n")) {
      if (!/\bCreatorFan\??\b/.test(line) || !/@relation\(fields:\s*\[/.test(line)) continue;
      directRelations.push({ modelName, line: line.trim() });
      assert.match(line, /fields:\s*\[[^\]]*fanRecordId[^\]]*\]/, `${modelName} relation must use fanRecordId`);
      assert.doesNotMatch(line, /fields:\s*\[[^\]]*\bfanId\b[^\]]*\]/, `${modelName} relation must not expose internal FK as fanId`);
    }
  }
  assert.ok(directRelations.length >= 10, `expected broad CreatorFan relation coverage, got ${directRelations.length}`);
});

test("event and campaign writers use canonical identity projector rather than direct CreatorFan updates", () => {
  const files = [
    "src/services/financial-transactions-service.js",
    "src/services/notification-facts-service.js",
    "src/services/creator-analytics-ledger-service.js",
  ].map(read).join("\n");
  assert.match(files, /projectFanIdentity/);
  assert.doesNotMatch(files, /creatorFan\.(?:update|upsert|create)\s*\(/);
  const financial = read("src/services/financial-transactions-service.js");
  const notifications = read("src/services/notification-facts-service.js");
  const campaign = read("src/services/creator-analytics-ledger-service.js");
  assert.match(financial, /avatarUrl:\s*row\.fanAvatarUrl/);
  assert.match(notifications, /avatarUrl:\s*fact\.fanAvatarUrl/);
  assert.match(campaign, /avatarUrl:\s*claimer\.avatarUrl/);
});

test("subscriber baseline feeds canonical projectors and generic isActive is not relationship truth", () => {
  const service = read("src/services/subscriber-directory-service.js");
  const authority = read("src/services/fan-data-authority-service.js");
  assert.match(service, /projectSubscriberDirectoryRun/);
  assert.doesNotMatch(authority, /fanSubscriptionActive\s*:\s*[^\n]*isActive/);
  assert.doesNotMatch(authority, /fanSubscribesToCreator\s*:\s*[^\n]*isActive/);
});

test("Subscriber Directory production bulk path carries the same per-field authority masks", async () => {
  const calls = [];
  const db = {
    subscriberScanItem: {
      findMany: async () => [{
        fanId: "123", observedAt: new Date("2026-08-30T12:00:00Z"), username: "bulk_user", name: null, avatarUrl: null,
        creatorFollowsFan: true, canReceiveChatMessage: null, totalSpentCents: 1200, messagesSpentCents: null,
        subscriptionsSpentCents: null, tipsSpentCents: null, postsSpentCents: null, streamsSpentCents: null,
        valueAvailability: "AVAILABLE", lastSeenAt: null,
        metadata: { fanDataObservedFields: { identity: ["username"], relationship: ["creatorFollowsFan"], value: ["totalSpentCents"] } },
      }],
    },
    $executeRawUnsafe: async (...args) => { calls.push(args); return 1; },
  };
  const result = await projectSubscriberDirectoryRun(db, { runId: "run-1", agencyId: "a", creatorId: "c", sourceJobId: "job-1" });
  assert.equal(result.projected, 1);
  assert.ok(calls.length >= 4);
  const sql = calls.map(([query]) => query).join("\n");
  assert.match(sql, /usernameAuthorityVersion/);
  assert.match(sql, /creatorFollowsFanAuthorityVersion/);
  assert.match(sql, /platformReportedTotalSpendCentsAuthorityVersion/);
  assert.match(sql, /ON CONFLICT[\s\S]*DO UPDATE SET/);
  assert.match(sql, /EXCLUDED\."creatorFollowsFanAuthorityVersion" > "CreatorFanRelationshipCurrent"\."creatorFollowsFanAuthorityVersion"/);
  assert.match(sql, /EXCLUDED\."platformReportedTotalSpendCentsAuthorityVersion" > "CreatorFanValueCurrent"\."platformReportedTotalSpendCentsAuthorityVersion"/);
  const serializedRows = calls.map(([, json]) => typeof json === "string" ? json : "").join("\n");
  assert.match(serializedRows, /"creatorFollowsFan":true/);
  assert.doesNotMatch(serializedRows, /"canReceiveChatMessage":null/);
});

test("presence is temporal-only and cannot write canonical identity or value", () => {
  const presence = read("src/services/presence-service.js");
  assert.doesNotMatch(presence, /projectFanIdentity/);
  assert.doesNotMatch(presence, /projectFanValue/);
  assert.doesNotMatch(presence, /PRESENCE_HINT/);
  assert.doesNotMatch(presence, /<\s*1000[^\n]*\*\s*100/);
});

test("Team pending identity comes only from canonical CreatorFan, not Follow candidates", () => {
  const team = read("src/services/team-pending-read-service.js");
  assert.match(team, /identityObservedAt/);
  assert.match(team, /identitySource/);
  assert.doesNotMatch(team, /followBackCandidate/);
  assert.doesNotMatch(team, /followAutomationCandidate/);
  assert.match(team, /platformIdentity/);
});

test("server CRM is explicitly isolated from canonical fan authority", () => {
  const crm = read("src/routes/crm-store.js");
  assert.match(crm, /SERVER_CRM_ISOLATED/);
  assert.match(crm, /not a writer for canonical OnlyFans platform/);
});


test("historical event actor snapshots remain explicit while current identity advances", () => {
  const schema = read("prisma/schema.prisma");
  const financial = read("src/services/financial-transactions-service.js");
  const notifications = read("src/services/notification-facts-service.js");
  const campaign = read("src/services/creator-analytics-ledger-service.js");
  for (const model of ["CreatorFinancialTransaction", "CreatorSale", "CreatorTip", "CreatorSubscriptionEvent", "CreatorPaidSubscription", "CreatorPostLike", "CreatorPostComment"]) {
    const body = schema.match(new RegExp(`model ${model} \\{[\\s\\S]*?\\n\\}`))?.[0] || "";
    assert.match(body, /fanUsernameAtEvent/);
    assert.match(body, /fanDisplayNameAtEvent/);
  }
  const campaignBody = schema.match(/model CreatorCampaignFan \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(campaignBody, /claimerUsernameAtEvent/);
  assert.match(financial, /fanUsernameAtEvent:\s*row\.fanUsername/);
  assert.match(notifications, /fanUsernameAtEvent:\s*fact\.fanUsername/);
  assert.match(campaign, /claimerUsernameAtEvent:\s*claimer\.username/);
  const projection = read("src/services/creator-analytics-projection-service.js");
  assert.match(projection, /fanOnlyFansUserIdAtEvent:\s*event\.fanOnlyFansUserIdAtEvent/);
  assert.match(projection, /fanUsernameAtEvent:\s*event\.fanUsernameAtEvent/);
  assert.match(projection, /fanDisplayNameAtEvent:\s*event\.fanDisplayNameAtEvent/);
  assert.match(projection, /fanAvatarUrlAtEvent:\s*event\.fanAvatarUrlAtEvent/);
  const migration = read("prisma/migrations/20260830160000_fan_data_authority_cutover/migration.sql");
  assert.match(migration, /ALTER TABLE "CreatorPaidSubscription"[\s\S]*ADD COLUMN "fanOnlyFansUserIdAtEvent"[\s\S]*ADD COLUMN "fanAvatarUrlAtEvent"/);
});


test("campaign current value read model preserves unknown instead of coercing it to zero", () => {
  const ledger = read("src/services/creator-analytics-ledger-service.js");
  assert.match(ledger, /availability:\s*valueCurrent\.availability/);
  assert.match(ledger, /platformReportedTotalSpendCents:\s*valueCurrent\.platformReportedTotalSpendCents == null \? null/);
  assert.doesNotMatch(ledger, /totalNetCents:\s*Number\(valueCurrent\.platformReportedTotalSpendCents \|\| 0\)/);
  assert.match(ledger, /avatarUrl:\s*text\(item\.avatarUrl, 1200\)/);
  assert.match(ledger, /headerUrl:\s*text\(item\.headerUrl, 1200\)/);
});


test("current value aggregates exclude unavailable or malformed observations", () => {
  const overview = read("src/services/creator-overview-service.js");
  const ledger = read("src/services/creator-analytics-ledger-service.js");
  assert.match(overview, /value\."availability" = 'AVAILABLE'/);
  assert.match(ledger, /value\."availability" = 'AVAILABLE'/);
});


test("point refresh scheduler scopes dedupe to the exact fan-id batch instead of creator-wide loss", () => {
  const service = read("src/services/fan-data-authority-service.js");
  assert.match(service, /const rangeKey = `fan-data:\$\{crypto\.createHash/);
  assert.match(service, /ids\.join\("\\n"\)/);
  assert.match(service, /params:\s*\{ \.\.\.stableParams, fanIds: ids, rangeKey/);
  assert.match(service, /delete stableParams\.scheduledFromObservationAt/);
});


test("follow projections expose explicit relationship vocabulary while legacy DB column names are mapped only", () => {
  const schema = read("prisma/schema.prisma");
  const followBack = read("src/services/follow-back-service.js");
  const followAutomation = read("src/services/follow-automation-service.js");
  const followBackRules = read("src/services/follow-back-rules.js");
  const followAutomationRules = read("src/services/follow-automation-rules.js");
  assert.match(schema, /fanSubscriptionActive\s+Boolean\?\s+@map\("isActive"\)/);
  assert.match(schema, /creatorFollowsFan\s+Boolean\?\s+@map\("subscribedByCreator"\)/);
  assert.match(schema, /fanSubscribesToCreator\s+Boolean\?\s+@map\("subscribedOn"\)/);
  for (const source of [followBackRules, followAutomationRules]) {
    assert.doesNotMatch(source, /candidate\.(?:isActive|subscribedByCreator|subscribedOn|subscriptionType)/);
  }
  assert.match(followBack, /fanSubscriptionActive/);
  assert.match(followBack, /creatorFollowsFan/);
  assert.match(followAutomation, /fanSubscriptionActive/);
  assert.match(followAutomation, /creatorFollowsFan/);
  assert.match(followAutomation, /fanSubscribesToCreator/);
});

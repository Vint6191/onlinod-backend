"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  projectFanIdentity,
  projectFanValue,
  VALUE_AVAILABILITY,
} = require("./fan-data-authority-service");

const ROOT = path.resolve(__dirname, "../..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function identityTx(existing) {
  let fan = { ...existing };
  return {
    get fan() { return fan; },
    creatorFan: {
      findUnique: async () => fan,
      update: async ({ data }) => (fan = { ...fan, ...data }),
      create: async ({ data }) => (fan = { ...data }),
    },
  };
}

test("identity clock rejects delayed event identity while preserving current profile", async () => {
  const tx = identityTx({
    id: "fan-record-1", agencyId: "a", creatorId: "c", onlyFansUserId: "123",
    username: "NEW", displayName: "New", avatarUrl: "new.jpg", headerUrl: null,
    identityObservedAt: new Date("2026-08-30T12:00:00Z"), identitySource: "USER_PROFILE",
    identityCompleteness: "PARTIAL", firstSeenAt: new Date("2026-01-01T00:00:00Z"),
    lastSeenAt: new Date("2026-08-30T12:00:00Z"), lastActivityObservedAt: new Date("2026-08-30T12:00:00Z"),
  });
  await projectFanIdentity(tx, {
    agencyId: "a", creatorId: "c", onlyFansUserId: "123", username: "OLD",
    platformDisplayName: "Old", observedAt: "2026-08-29T12:00:00Z", source: "LIVE_NOTIFICATION",
    activityObservedAt: "2026-08-29T12:00:00Z",
  });
  assert.equal(tx.fan.username, "NEW");
  assert.equal(tx.fan.displayName, "New");
  assert.equal(tx.fan.identitySource, "USER_PROFILE");
});

test("equal identity timestamp uses source quality only as tie-breaker", async () => {
  const tx = identityTx({
    id: "fan-record-1", agencyId: "a", creatorId: "c", onlyFansUserId: "123",
    username: "campaign", displayName: null, identityObservedAt: new Date("2026-08-30T12:00:00Z"),
    identitySource: "CAMPAIGN_CLAIMER", identityCompleteness: "PARTIAL",
    firstSeenAt: new Date("2026-01-01T00:00:00Z"), lastSeenAt: new Date("2026-08-30T12:00:00Z"),
    lastActivityObservedAt: null,
  });
  await projectFanIdentity(tx, {
    agencyId: "a", creatorId: "c", onlyFansUserId: "123", username: "profile",
    observedAt: "2026-08-30T12:00:00Z", source: "USER_PROFILE",
  });
  assert.equal(tx.fan.username, "profile");
  assert.equal(tx.fan.identitySource, "USER_PROFILE");
});

function valueTx(existingValue) {
  const fan = {
    id: "fan-record-1", agencyId: "a", creatorId: "c", onlyFansUserId: "123",
    firstSeenAt: new Date("2026-01-01T00:00:00Z"), lastSeenAt: new Date("2026-01-01T00:00:00Z"),
    identityObservedAt: new Date("2026-01-01T00:00:00Z"), identitySource: "UNKNOWN",
  };
  let value = existingValue ? { ...existingValue } : null;
  return {
    get value() { return value; },
    creatorFan: { findUnique: async () => fan, update: async () => fan, create: async () => fan },
    creatorFanValueCurrent: {
      findUnique: async () => value,
      create: async ({ data }) => (value = { id: "value-1", ...data }),
      update: async ({ data }) => (value = { ...value, ...data }),
    },
  };
}

test("AVAILABLE zero is a real business fact", async () => {
  const tx = valueTx(null);
  await projectFanValue(tx, {
    agencyId: "a", creatorId: "c", onlyFansUserId: "123", totalSpentCents: 0,
    availability: VALUE_AVAILABILITY.AVAILABLE, observedAt: "2026-08-30T12:00:00Z", source: "USER_PROFILE",
  });
  assert.equal(tx.value.availability, "AVAILABLE");
  assert.equal(tx.value.platformReportedTotalSpendCents, 0n);
});

test("MALFORMED newer observation changes availability but preserves last known numeric value", async () => {
  const tx = valueTx({
    id: "value-1", valueObservedAt: new Date("2026-08-29T12:00:00Z"), availability: "AVAILABLE",
    platformReportedTotalSpendCents: 12500n, messagesSpentCents: 5000n,
  });
  await projectFanValue(tx, {
    agencyId: "a", creatorId: "c", onlyFansUserId: "123", totalSpentCents: null,
    availability: VALUE_AVAILABILITY.MALFORMED, observedAt: "2026-08-30T12:00:00Z", source: "USER_PROFILE",
  });
  assert.equal(tx.value.availability, "MALFORMED");
  assert.equal(tx.value.platformReportedTotalSpendCents, 12500n);
  assert.equal(tx.value.messagesSpentCents, 5000n);
});

test("older value observation cannot roll current value backward", async () => {
  const tx = valueTx({
    id: "value-1", valueObservedAt: new Date("2026-08-30T12:00:00Z"), availability: "AVAILABLE",
    platformReportedTotalSpendCents: 20000n,
  });
  const result = await projectFanValue(tx, {
    agencyId: "a", creatorId: "c", onlyFansUserId: "123", totalSpentCents: 100,
    availability: "AVAILABLE", observedAt: "2026-08-29T12:00:00Z", source: "TRAFFIC_COMPAT",
  });
  assert.equal(result.replay, true);
  assert.equal(tx.value.platformReportedTotalSpendCents, 20000n);
});

test("legacy CreatorFan migration does not invent identity freshness from lastSeenAt", () => {
  const migration = read("prisma/migrations/20260830160000_fan_data_authority_cutover/migration.sql");
  assert.match(migration, /"identityObservedAt"\s*=\s*NULL/);
  assert.match(migration, /LEGACY_UNCLASSIFIED/);
  assert.doesNotMatch(migration, /"identityObservedAt"\s*=\s*COALESCE\(\s*"identityObservedAt"\s*,\s*"lastSeenAt"/);
  assert.match(migration, /"lastActivityObservedAt"\s*=\s*COALESCE\(\s*"lastActivityObservedAt"\s*,\s*"lastSeenAt"/);
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

test("presence placeholder cannot become canonical identity and money is not magnitude-guessed", () => {
  const presence = read("src/services/presence-service.js");
  assert.match(presence, /rejectSyntheticIdentity:\s*true/);
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

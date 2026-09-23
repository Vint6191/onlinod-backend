"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readSubscriberConsumerPage, readFanConsumerPage } = require("./fan-consumer-cursor-service");
const { validateBumpCurrentRelationship, bumpRequiredFields, buildFanCurrentFieldFence } = require("./fan-current-consumer-service");

test("Phase3 closure: bounded cohort traversal survives restart, advances past ineligible prefix and rebases publication", async () => {
  const cursors = new Map();
  const calls = [];
  const cohort = Array.from({ length: 11 }, (_, i) => ({ id: `item-${String(i).padStart(2, "0")}`, fanId: String(i).padStart(2, "0"), runId: "run-a", agencyId: "a", creatorId: "c" }));
  cohort.push({ id: "other-tenant", fanId: "foreign", runId: "run-a", agencyId: "b", creatorId: "d" });
  const db = {
    fanConsumerCursor: {
      async findUnique({ where }) { return cursors.get(where.creatorId_consumerKey.consumerKey); },
      async upsert({ create, update }) { cursors.set(create.consumerKey, { ...(cursors.get(create.consumerKey) || create), ...update }); },
    },
    subscriberScanItem: { async findMany({ where, take, select, orderBy }) {
      calls.push({ where: structuredClone(where), take, select });
      assert.deepEqual(orderBy, { fanId: "asc" });
      assert.ok(take <= 501);
      assert.equal(select.subscriptionType, undefined, "no current-looking history fields cross the boundary");
      assert.equal(select.lastSeenIsNull, undefined);
      return cohort.filter((r) => r.agencyId === where.agencyId && r.creatorId === where.creatorId && r.runId === where.runId
        && (!where.fanId?.gt || r.fanId > where.fanId.gt) && (!where.fanId?.in || where.fanId.in.includes(r.fanId)))
        .sort((a, b) => a.fanId.localeCompare(b.fanId)).slice(0, take);
    } },
  };
  const input = { db, agencyId: "a", creatorId: "c", runId: "run-a", consumerKey: "bumps:paid_subscriber", limit: 4 };
  const seen = [];
  for (let restart = 0; restart < 3; restart += 1) seen.push(...(await readSubscriberConsumerPage({ ...input })).map((r) => r.fanId));
  assert.deepEqual(seen, Array.from({ length: 11 }, (_, i) => String(i).padStart(2, "0")));
  assert.equal(cursors.get(input.consumerKey).afterKey, null);
  assert.equal((await readSubscriberConsumerPage(input))[0].fanId, "00");
  const before = structuredClone(cursors.get(input.consumerKey));
  assert.equal((await readSubscriberConsumerPage({ ...input, fanIds: ["10"] }))[0].fanId, "10");
  assert.deepEqual(cursors.get(input.consumerKey), before, "manual targets cannot advance the background cursor");
  cohort.push(...cohort.filter((row) => row.agencyId === "a").map((row) => ({ ...row, id: `new-${row.id}`, runId: "run-b" })));
  assert.deepEqual((await readSubscriberConsumerPage({ ...input, runId: "run-b" })).map((row) => row.fanId), ["04", "05", "06", "07"]);
  assert.deepEqual(calls.at(-1).where.fanId, { gt: "03" }, "publication replacement cannot rewind a stable fan cursor");
  assert.equal(cursors.get(input.consumerKey).runId, "run-b");
  assert.deepEqual((await readSubscriberConsumerPage({ ...input, runId: "run-b" })).map((row) => row.fanId), ["08", "09", "10"]);
});

function current(fields) {
  const observedAt = new Date("2026-09-23T21:00:00Z");
  const fieldAuthority = Object.fromEntries(Object.keys(fields).map((field) => [field, {
    observedAt, source: "USER_PROFILE", authorityVersion: `${observedAt.toISOString()}|0700|USER_PROFILE|${field}`,
  }]));
  return { onlyFansUserId: "fan", creatorId: "creator", relationship: { ...fields, observedAt, fieldAuthority } };
}

test("Phase3 closure: hidden-online admission and send fence require the current visibility observation", () => {
  const historical = { fanId: "fan", metadata: { lastSeenIsNull: true } };
  const visible = current({ canReceiveChatMessage: true, lastSeenAt: new Date("2026-09-23T20:59:00Z") });
  assert.equal(validateBumpCurrentRelationship({ candidate: historical, current: visible, source: "hidden_online" }).code, "fan_not_hidden_current");
  const hidden = current({ canReceiveChatMessage: true, lastSeenAt: null });
  const accepted = validateBumpCurrentRelationship({ candidate: { fanId: "fan", metadata: { lastSeenIsNull: false } }, current: hidden, source: "hidden_online" });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.candidate.metadata.lastSeenIsNull, true);
  const unknown = validateBumpCurrentRelationship({ candidate: historical, current: current({ canReceiveChatMessage: true }), source: "hidden_online" });
  assert.equal(unknown.refreshRequired, true);
  assert.deepEqual(unknown.refreshFields, ["lastSeenAt"]);
  assert.ok(bumpRequiredFields("hidden_online").includes("lastSeenAt"));
  assert.notDeepEqual(buildFanCurrentFieldFence(hidden, bumpRequiredFields("hidden_online")),
    buildFanCurrentFieldFence({ ...hidden, relationship: { ...hidden.relationship, fieldAuthority: {
      ...hidden.relationship.fieldAuthority, lastSeenAt: { ...hidden.relationship.fieldAuthority.lastSeenAt, authorityVersion: "newer-visibility" },
    } } }, bumpRequiredFields("hidden_online")));
});

test("Phase3 closure: active_free never enters the paid audience, irrespective of scan history", () => {
  const candidate = { fanId: "fan", subscriptionType: "paid", isActive: true };
  const canonical = current({ canReceiveChatMessage: true, fanSubscriptionActive: true, fanSubscriptionType: "active_free" });
  assert.equal(validateBumpCurrentRelationship({ candidate, current: canonical, source: "paid_subscriber" }).code, "fan_not_paid_current");
  assert.equal(validateBumpCurrentRelationship({ candidate, current: canonical, source: "free_subscriber" }).ok, true);
  const newlyPaid = current({ canReceiveChatMessage: true, fanSubscriptionActive: true, fanSubscriptionType: "paid" });
  assert.equal(validateBumpCurrentRelationship({ candidate: { ...candidate, subscriptionType: "free" }, current: newlyPaid, source: "paid_subscriber" }).ok, true);
});

test("Phase3 closure: executor activation shares one generation and DB prevents rollback to the infinite retry worker", () => {
  const root = path.resolve(__dirname, "../..");
  const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
  const migration = read("prisma/migrations/20260923210000_phase3_failure_consumer_closure_v1/migration.sql");
  const { DOMAIN_WORK_EXECUTOR_GENERATION } = require("./phase2-release-compatibility-authority-service");
  assert.equal(DOMAIN_WORK_EXECUTOR_GENERATION, "phase3_domain_executor_v6_failure_policy");
  assert.ok(migration.includes(`OLD."requiredGeneration"='${DOMAIN_WORK_EXECUTOR_GENERATION}'`));
  assert.match(migration, /PHASE3_DOMAIN_EXECUTOR_DOWNGRADE_FORBIDDEN/);
  assert.match(read("scripts/database/phase3-domain-work-claim-online-rollout.js"), /require\("\.\.\/\.\.\/src\/services\/phase2-release-compatibility-authority-service"\)/);
  assert.doesNotMatch(read("src/services/bump-service.js"), /where\.subscriptionType|where\.lastSeenIsNull|subscriberScanItem\.count/);
  assert.match(read("src/services/bump-service.js"), /buildFanCurrentFieldFence\(current, bumpRequiredFields\(source\)\)/);
  const actions = read("src/services/automation-action-delivery-service.js");
  const permit = actions.slice(actions.indexOf("async function prepareWriteActionDelivery"), actions.indexOf("function relationshipEffectRefreshTarget"));
  const token = permit.indexOf("set_config('onlinod.phase3_fan_consumer_generation'");
  assert.ok(token > permit.indexOf("assertFanCurrentFieldFence({"));
  assert.ok(token < permit.indexOf('status: "COMMITTING", writeCommitRevision:'));
  assert.match(migration, /PHASE3_INCOMPATIBLE_FAN_CONSUMER_COMMIT/);
  assert.match(migration, /OLD\."writeCommitRevision" IS DISTINCT FROM NEW\."writeCommitRevision"/);
});

test("Phase3 closure: opaque-key cursors cap work at 500 and isolate consumer progress even when every row is ineligible", async () => {
  const stored = new Map();
  const db = { fanConsumerCursor: {
    async findUnique({ where }) { return stored.get(where.creatorId_consumerKey.consumerKey) || null; },
    async upsert({ create, update }) { stored.set(create.consumerKey, { ...create, ...update }); },
  } };
  const keys = Array.from({ length: 1203 }, (_, i) => String(i).padStart(5, "0"));
  let reads = 0;
  const input = { db, agencyId: "a", creatorId: "c", runId: "sfs:current-targets:v1", limit: 100_000,
    keyOf: (r) => r.targetUserId, findPage: async ({ afterKey, take }) => {
      reads += 1;
      assert.equal(take, 501);
      return keys.filter((key) => !afterKey || key > afterKey).slice(0, take).map((key) => ({ targetUserId: key, eligible: false }));
    } };
  const selected = [];
  for (let i = 0; i < 3; i += 1) selected.push(...await readFanConsumerPage({ ...input, consumerKey: "sfs:planning" }));
  assert.equal(selected.length, 1203);
  assert.equal(new Set(selected.map((r) => r.targetUserId)).size, 1203);
  assert.equal(reads, 3);
  assert.equal((await readFanConsumerPage({ ...input, consumerKey: "likes:planning" }))[0].targetUserId, "00000");
  const before = structuredClone(stored.get("sfs:planning"));
  await assert.rejects(() => readFanConsumerPage({ ...input, consumerKey: "sfs:planning", findPage: async () => { throw new Error("read failed"); } }), /read failed/);
  assert.deepEqual(stored.get("sfs:planning"), before);
  await assert.rejects(() => readFanConsumerPage({ ...input, agencyId: "foreign", consumerKey: "sfs:planning" }), /TENANT_MISMATCH/);
});

test("Phase3 closure: Likes discovery passes a fresh prefix and rolls back its cursor when planning fails", async () => {
  const savedModules = new Map();
  const replace = (name, exports) => {
    const id = require.resolve(name);
    savedModules.set(id, require.cache[id]);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  };
  const likesId = require.resolve("./likes-service");
  savedModules.set(likesId, require.cache[likesId]);
  let cursor = null;
  let failInsert = true;
  const inserted = [];
  const cohort = ["0", "1", "2", "3", "4"].map((fanId) => ({ id: fanId, fanId, runId: "run" }));
  const tx = {
    async $executeRawUnsafe() { return 1; },
    subscriberDirectoryState: { async findFirst() { return { currentRunId: "run" }; } },
    subscriberScanItem: { async findMany({ where, take }) { return cohort.filter((r) => !where.fanId?.gt || r.fanId > where.fanId.gt).slice(0, take); } },
    fanConsumerCursor: { async findUnique() { return cursor; }, async upsert({ create, update }) { cursor = { ...(cursor || create), ...update }; } },
    hiddenOnlineUser: { async findMany() { return []; } },
    automationContentDiscoveryState: { async findMany() { return [{ ownerFanId: "0" }, { ownerFanId: "1" }]; } },
    creatorFan: { async findMany() { return []; } },
  };
  const db = { async $transaction(work) {
    const before = structuredClone(cursor);
    try { return await work(tx); }
    catch (error) { cursor = before; throw error; }
  } };
  try {
    const planning = require("./job-planning-repository");
    replace("./job-planning-repository", { ...planning, async ensurePlannedJob({ params, db: client }) {
      assert.equal(client, tx, "jobs must share the cursor transaction");
      if (failInsert) throw new Error("injected planning failure");
      inserted.push(params.fans.map((r) => r.fanId));
      return { job: { id: "new-job", status: "SCHEDULED" } };
    } });
    replace("./automation-control-service", {
      async requireCreator() { return { id: "c" }; },
      async assertAutomationEnabled() { return { modules: { likes: { settings: {} } } }; },
      normalizeLikesSettings: () => ({ discoveryFreshnessHours: 24, discoveryBatchSize: 2, discoveryPostLimit: 10, contentMaxAgeDays: 30 }),
    });
    delete require.cache[likesId];
    const { scheduleLikesDiscovery } = require("./likes-service");
    const input = { db, agencyId: "a", creatorId: "c", maxFans: 2 };
    assert.equal((await scheduleLikesDiscovery(input)).reason, "discovery_fresh_or_no_fans");
    assert.equal(cursor.afterKey, "1");
    await assert.rejects(() => scheduleLikesDiscovery(input), /injected planning failure/);
    assert.equal(cursor.afterKey, "1");
    failInsert = false;
    assert.equal((await scheduleLikesDiscovery(input)).fans, 2);
    assert.deepEqual(inserted, [["2", "3"]]);
    assert.equal(cursor.afterKey, "3");
  } finally {
    for (const [id, value] of savedModules) {
      if (value) require.cache[id] = value; else delete require.cache[id];
    }
  }
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const migration = read("prisma/migrations/20260912005000_phase2_actual56_rolling_release_fence/migration.sql");
const schema = read("prisma/schema.prisma");
const domainWork = read("src/services/domain-work-authority-service.js");
const release = require("./phase2-release-compatibility-authority-service");
const authority = require("./domain-work-authority-service");

function productionCreatorMutationFiles() {
  const files = [];
  const roots = [path.join(root, "src", "routes"), path.join(root, "src", "services")];
  const mutation = /creatorAccount\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/;
  for (const dir of roots) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".js") || name.endsWith(".test.js")) continue;
      const abs = path.join(dir, name);
      if (!fs.statSync(abs).isFile()) continue;
      const source = fs.readFileSync(abs, "utf8");
      if (mutation.test(source)) files.push({ rel: path.relative(root, abs).replaceAll("\\", "/"), source });
    }
  }
  return files;
}

test("M1 migration activates DB-enforced release generations for Creator writers and DomainWork executors", () => {
  assert.match(schema, /model Phase2ReleaseCompatibilityAuthority/);
  assert.match(schema, /claimExecutionGeneration\s+String\?/);
  assert.match(migration, /'CREATOR_ACCOUNT_WRITER','phase2_creator_writer_v2_actual56_postcut'/);
  assert.match(migration, /'DOMAIN_WORK_EXECUTOR','phase2_domain_executor_v4_actual56_postcut'/);
  assert.match(migration, /CREATE TRIGGER "trg_phase2_creator_account_release_writer"[\s\S]*BEFORE INSERT OR UPDATE OR DELETE ON "CreatorAccount"/);
  assert.match(migration, /PHASE2_INCOMPATIBLE_CREATOR_WRITER/);
  assert.match(migration, /CREATE TRIGGER "trg_phase2_domain_work_executor_release"[\s\S]*BEFORE UPDATE OF "state","ownerToken","claimFence"/);
  assert.match(migration, /PHASE2_INCOMPATIBLE_DOMAIN_EXECUTOR/);
});

test("M1 old physical AgencyMember DELETE is retired at the database boundary", () => {
  const start = migration.indexOf('CREATE OR REPLACE FUNCTION "phase2_fence_agency_member_physical_delete"');
  const end = migration.indexOf('DROP TRIGGER IF EXISTS "trg_phase2_agency_member_physical_delete"', start);
  const memberFence = migration.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(memberFence, /phase2_internal_agency_destructive_authorized/);
  assert.match(memberFence, /PHASE2_AGENCY_MEMBER_PHYSICAL_DELETE_RETIRED/);
  assert.doesNotMatch(memberFence, /phase2_creator_writer_generation|phase2_release_generation_authorized/);
  assert.match(migration, /CREATE TRIGGER "trg_phase2_agency_member_physical_delete"[\s\S]*BEFORE DELETE ON "AgencyMember"/);
});

test("M1 release token is transaction-local and installed before new Creator writes", async () => {
  const calls = [];
  const tx = {
    async $queryRawUnsafe(sql, ...args) { calls.push({ sql, args }); return [{ value: args[1] }]; },
  };
  await release.authorizeCreatorAccountWrite(tx);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /set_config\(\$1,\$2,true\)/);
  assert.deepEqual(calls[0].args, ["onlinod.phase2_creator_writer_generation", release.CREATOR_ACCOUNT_WRITER_GENERATION]);
});

test("M1 every direct new-binary CreatorAccount mutation is release-authorized or exact destructive cleanup", () => {
  const uncovered = [];
  for (const entry of productionCreatorMutationFiles()) {
    const covered = entry.source.includes("authorizeCreatorAccountWrite")
      || entry.source.includes("runCreatorAccountWriteTransaction")
      || (entry.rel === "src/routes/creators.js" && entry.source.includes("lockHumanCreatorMutation"))
      || (entry.rel === "src/services/phase2-destructive-delete-authority-service.js"
          && entry.source.includes("phase2_destructive_creator_id")
          && entry.source.includes("phase2_destructive_agency_id"));
    if (!covered) uncovered.push(entry.rel);
  }
  assert.deepEqual(uncovered, []);
});

test("M1 DomainWork release generation is installed in every production claim path", () => {
  const claims = domainWork.slice(domainWork.indexOf("async function claimDomainWorkBatch"), domainWork.indexOf("function claimWhere"));
  const authorizationCalls = claims.match(/authorizeDomainWorkExecutor\(tx\)/g) || [];
  assert.equal(authorizationCalls.length, 3, "creator-scoped, broad/raw and adapter claim paths must all authorize");
  assert.match(migration, /NEW\."claimExecutionGeneration" := v_required/);
});

test("M1 existing old claim can drain but old binary cannot acquire a new owner", () => {
  const trigger = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION "phase2_fence_domain_work_executor_acquire"'));
  assert.match(trigger, /IF NEW\."state"='CLAIMED'[\s\S]*OLD\."state" IS DISTINCT FROM 'CLAIMED'/);
  assert.match(trigger, /OLD\."ownerToken" IS DISTINCT FROM NEW\."ownerToken"/);
  assert.match(trigger, /OLD\."claimFence" IS DISTINCT FROM NEW\."claimFence"/);
  assert.doesNotMatch(trigger, /leaseUntil/);
  assert.match(trigger, /RETURN NEW;/);
});

test("M1 live pre-migration DWI drain applies to every workClass, not only historical maintenance lanes", async () => {
  const now = new Date("2026-09-12T00:00:00.000Z");
  let queriedWorkClass = null;
  const db = {
    phase2LegacyExecutorFence: { async findMany() { throw new Error("maintenance lane lookup must not run for DEPENDENCY_FANOUT"); } },
    maintenanceLaneState: { async findMany() { throw new Error("maintenance lane lookup must not run for DEPENDENCY_FANOUT"); } },
    phase2ReleaseCompatibilityAuthority: {
      async findUnique() { return { requiredGeneration: release.DOMAIN_WORK_EXECUTOR_GENERATION }; },
    },
    domainWorkItem: {
      async findMany({ where }) {
        queriedWorkClass = where.workClass;
        return [{ id: "legacy-dependency", claimExecutionGeneration: null, ownerToken: "old-binary", leaseUntil: new Date(now.getTime() + 60_000) }];
      },
    },
  };
  const result = await authority.legacyExecutorDrainStatus({
    db,
    workClass: authority.WORK_CLASS.DEPENDENCY_FANOUT,
    fallbackNow: now,
  });
  assert.equal(queriedWorkClass, authority.WORK_CLASS.DEPENDENCY_FANOUT);
  assert.equal(result.ready, false);
  assert.equal(result.reason, "legacy_executor_drain");
  assert.equal(result.lanes[0].domainWork, true);
});

test("M1 new binary does not claim until live legacy DWI claims have drained", () => {
  const drainStart = domainWork.indexOf("async function legacyExecutorDrainStatus");
  const claimStart = domainWork.indexOf("async function claimDomainWorkBatch");
  const activeGen = domainWork.indexOf("const activeGeneration = await activeDomainWorkGeneration", claimStart);
  const drain = domainWork.indexOf("const drain = await legacyExecutorDrainStatus", activeGen);
  const rawClaim = domainWork.indexOf("if (rawCapable && normalizedCreatorIds.length)", drain);
  assert.ok(drainStart >= 0 && claimStart > drainStart && activeGen > claimStart && drain > activeGen && rawClaim > drain);
  assert.match(domainWork.slice(drain, rawClaim), /if \(!drain\.ready\)[\s\S]*legacy_executor_drain/);
  assert.doesNotMatch(domainWork.slice(drainStart, claimStart), /if \(!LEGACY_DRAIN_WORK_CLASSES\.has\(klass\)\) return/);
});

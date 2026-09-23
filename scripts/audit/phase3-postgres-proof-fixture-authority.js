"use strict";

const { randomUUID } = require("node:crypto");

const {
  assertTeamControlPlaneWriteAdmission,
  authorizeCreatorAccountWrite,
} = require("../../src/services/phase2-release-compatibility-authority-service");

const PHASE3_CLAIM_TOPOLOGY_MIGRATION = "20260922183000_phase3_a36_domain_work_claim_shard_closure_v1";
const PHASE3_EXACT_DESTRUCTIVE_CLAIM_MIGRATION = "20260922214500_phase3_a36_destructive_claim_authority_closure_v3";
const PHASE3_DESTRUCTIVE_FIXTURE_AUTHORITY_MODE = Object.freeze({
  LEGACY_AGENCY_MARKER: "LEGACY_AGENCY_MARKER",
  EXACT_LIVE_CLAIM: "EXACT_LIVE_CLAIM",
});

function auditSchemaFromDatabaseUrl() {
  const raw = String(process.env.DATABASE_URL || "").trim();
  if (!raw) return null;
  try {
    const schema = String(new URL(raw).searchParams.get("schema") || "").trim();
    if (!schema) return null;
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
      throw Object.assign(new Error(`Invalid Phase3 PostgreSQL audit schema identifier: ${schema}`), { code: "PHASE3_POSTGRES_FIXTURE_SCHEMA_INVALID" });
    }
    return schema;
  } catch (error) {
    if (error?.code) throw error;
    throw Object.assign(new Error("Phase3 PostgreSQL fixture DATABASE_URL is invalid"), { code: "PHASE3_POSTGRES_FIXTURE_DATABASE_URL_INVALID" });
  }
}

async function pinPhase3AuditSchema(tx) {
  const schema = auditSchemaFromDatabaseUrl();
  if (!schema || typeof tx?.$queryRawUnsafe !== "function") return { schema: null, pinned: false };
  const searchPath = `"${schema}", pg_catalog`;
  await tx.$queryRawUnsafe(`SELECT set_config('search_path',$1,true) AS value`, searchPath);
  const rows = await tx.$queryRawUnsafe(`SELECT current_schema() AS "currentSchema", current_setting('search_path') AS "searchPath"`);
  const currentSchema = String(rows?.[0]?.currentSchema || "");
  if (currentSchema !== schema) {
    const error = new Error(`Phase3 PostgreSQL fixture schema pin failed: expected=${schema} actual=${currentSchema || "<none>"}`);
    error.code = "PHASE3_POSTGRES_FIXTURE_SCHEMA_PIN_FAILED";
    error.expectedSchema = schema;
    error.currentSchema = currentSchema || null;
    error.searchPath = rows?.[0]?.searchPath || null;
    throw error;
  }
  return { schema, pinned: true };
}

// PostgreSQL integration proofs run both fully migrated and frozen rolling
// schemas. Test fixtures must use the transaction-local authority implemented by
// the schema generation they are exercising: the legacy Agency marker before
// A36, and one exact live destructive DWI claim after A36. The schema pin is
// equally authoritative: trigger functions contain unqualified relation names
// and must never resolve into public while a proof targets an isolated audit
// schema. Never disable triggers or mutate compatibility rows.
async function withPhase3PostgresFixtureAuthority(db, work, options = undefined) {
  if (!db || typeof db.$transaction !== "function" || typeof work !== "function") {
    const error = new Error("Phase3 PostgreSQL fixture authority requires a root PrismaClient and work callback");
    error.code = "PHASE3_POSTGRES_FIXTURE_TRANSACTION_REQUIRED";
    throw error;
  }
  return db.$transaction(async (tx) => {
    await pinPhase3AuditSchema(tx);
    await assertTeamControlPlaneWriteAdmission(tx);
    await authorizeCreatorAccountWrite(tx);
    return work(tx);
  }, options);
}

// A Prisma model without @relation can still have a migration-installed tenant
// trigger. Actor-scoped proofs therefore own a real Agency/User/Member graph;
// never manufacture an agencyId/memberId solely for a child fixture.
async function createPhase3PostgresActorFixture(db, prefix) {
  const id = String(prefix || "").trim();
  if (!id) throw Object.assign(new Error("Phase3 actor fixture prefix is required"), { code: "PHASE3_POSTGRES_FIXTURE_PREFIX_REQUIRED" });
  const agencyId = `${id}-agency`;
  const userId = `${id}-user`;
  const memberId = `${id}-member`;
  return withPhase3PostgresFixtureAuthority(db, async (tx) => {
    await tx.agency.create({ data: { id: agencyId, name: `Phase3 ${id}` } });
    await tx.user.create({ data: { id: userId, email: `${userId}@example.test`, passwordHash: "integration" } });
    const member = await tx.agencyMember.create({ data: {
      id: memberId, agencyId, userId, role: "OWNER", roleKey: "owner",
    } });
    const accessEpoch = Number(member.accessEpoch);
    if (!Number.isSafeInteger(accessEpoch) || accessEpoch < 1) {
      throw Object.assign(new Error("Phase3 actor fixture has no persisted access epoch"), { code: "PHASE3_POSTGRES_FIXTURE_ACCESS_EPOCH_REQUIRED" });
    }
    return { agencyId, userId, memberId, accessEpoch };
  });
}

async function drainPhase3PostgresAgencyDomainWork(tx, agencyId) {
  // Phase3 fixture agencies are isolated and disposable. Drain operational work
  // before Creator identities in one set-based statement, matching production
  // destructive ordering and avoiding one nested work DELETE per Creator trigger.
  const result = await tx.domainWorkItem.deleteMany({ where: { agencyId } });
  return Number(result?.count || 0);
}

function classifyPhase3PostgresDestructiveFixtureAuthority(row = {}) {
  const capabilities = {
    topologyMigrationApplied: row.topologyMigrationApplied === true,
    exactMigrationApplied: row.exactMigrationApplied === true,
    topologyTablePresent: row.topologyTablePresent === true,
    exactFunctionInstalled: row.exactFunctionInstalled === true,
  };
  const legacy = !capabilities.topologyMigrationApplied
    && !capabilities.exactMigrationApplied
    && !capabilities.topologyTablePresent
    && !capabilities.exactFunctionInstalled;
  const exact = capabilities.topologyMigrationApplied
    && capabilities.exactMigrationApplied
    && capabilities.topologyTablePresent
    && capabilities.exactFunctionInstalled;
  if (!legacy && !exact) {
    const error = new Error(`Phase3 PostgreSQL fixture schema generation is internally inconsistent: ${JSON.stringify(capabilities)}`);
    error.code = "PHASE3_POSTGRES_FIXTURE_GENERATION_DRIFT";
    error.capabilities = capabilities;
    throw error;
  }
  return {
    mode: exact
      ? PHASE3_DESTRUCTIVE_FIXTURE_AUTHORITY_MODE.EXACT_LIVE_CLAIM
      : PHASE3_DESTRUCTIVE_FIXTURE_AUTHORITY_MODE.LEGACY_AGENCY_MARKER,
    ...capabilities,
  };
}

async function resolvePhase3PostgresDestructiveFixtureAuthority(db) {
  return withPhase3PostgresFixtureAuthority(db, async (tx) => {
    const rows = await tx.$queryRawUnsafe(`
      WITH exact_function AS (
        SELECT pg_get_functiondef(p.oid) AS definition
          FROM pg_proc p
         WHERE p.oid=to_regprocedure('"phase2_internal_agency_destructive_authorized"(text)')
      )
      SELECT EXISTS (
               SELECT 1
                 FROM "_prisma_migrations"
                WHERE migration_name=$1
                  AND finished_at IS NOT NULL
                  AND rolled_back_at IS NULL
             ) AS "topologyMigrationApplied",
             EXISTS (
               SELECT 1
                 FROM "_prisma_migrations"
                WHERE migration_name=$2
                  AND finished_at IS NOT NULL
                  AND rolled_back_at IS NULL
             ) AS "exactMigrationApplied",
             to_regclass('"DomainWorkClaimTopologyState"') IS NOT NULL AS "topologyTablePresent",
             COALESCE((
               SELECT POSITION('onlinod.phase2_destructive_agency_work_id' IN definition)>0
                  AND POSITION('onlinod.phase2_destructive_agency_owner_token' IN definition)>0
                 FROM exact_function
             ),FALSE) AS "exactFunctionInstalled"
    `, PHASE3_CLAIM_TOPOLOGY_MIGRATION, PHASE3_EXACT_DESTRUCTIVE_CLAIM_MIGRATION);
    return classifyPhase3PostgresDestructiveFixtureAuthority(rows?.[0] || {});
  });
}

async function installLegacyPhase3PostgresAgencyDestructiveFixtureAuthority(tx, agencyId) {
  await tx.$queryRawUnsafe(
    `SELECT set_config('onlinod.phase2_destructive_agency_id',$1,true) AS "agencyId"`,
    String(agencyId),
  );
}

async function claimPhase3PostgresAgencyDestructiveFixture(db, agencyId) {
  const id = String(agencyId || "").trim();
  if (!id) throw Object.assign(new Error("Phase3 destructive fixture Agency id is required"), { code: "PHASE3_POSTGRES_FIXTURE_AGENCY_REQUIRED" });
  const { publishDomainWork, claimDomainWorkBatch, WORK_CLASS } = require("../../src/services/domain-work-authority-service");
  const ownerToken = `phase3-fixture-agency-delete:${randomUUID()}`;
  const work = await publishDomainWork({
    db,
    agencyId: id,
    workClass: WORK_CLASS.DESTRUCTIVE_AGENCY_CLEANUP,
    objectType: "Phase2AgencyDestructiveCleanup",
    objectId: id,
    partitionKey: id,
    creatorId: null,
  });
  const claim = await claimDomainWorkBatch({
    db,
    agencyId: id,
    workClass: WORK_CLASS.DESTRUCTIVE_AGENCY_CLEANUP,
    objectType: "Phase2AgencyDestructiveCleanup",
    objectIds: [id],
    ownerToken,
    limit: 1,
    leaseMs: 120_000,
  });
  const claimed = (claim?.items || []).find((item) => String(item?.id || "") === String(work?.id || ""));
  if (!claimed) {
    const error = new Error(`Phase3 fixture could not claim exact Agency destructive work: ${id}`);
    error.code = "PHASE3_POSTGRES_FIXTURE_DESTRUCTIVE_CLAIM_REQUIRED";
    throw error;
  }
  return { workId: String(claimed.id), ownerToken: String(claim?.ownerToken || ownerToken) };
}

async function installPhase3PostgresAgencyDestructiveFixtureAuthority(tx, agencyId, claim) {
  await tx.$queryRawUnsafe(`
    SELECT set_config('onlinod.phase2_destructive_agency_id',$1,true) AS "agencyId",
           set_config('onlinod.phase2_destructive_agency_work_id',$2,true) AS "workId",
           set_config('onlinod.phase2_destructive_agency_owner_token',$3,true) AS "ownerToken"
  `, String(agencyId), String(claim?.workId || ""), String(claim?.ownerToken || ""));
}

async function purgePhase3PostgresFixtureTenantResidue(tx, agencyId) {
  // Reuse production ownership, including immutable authorization history.
  // Frozen rolling schemas can predate some tables: discover installed members
  // of that same inventory in the pinned schema, preserving production order.
  // This is fixture-only, set-based teardown for one disposable Agency. Keep
  // its parent and exact destructive claim alive until these deletes finish.
  const { AGENCY_NON_FK_TENANT_TABLES } = require("../../src/services/phase2-destructive-delete-authority-service");
  const installed = await tx.$queryRawUnsafe(`
    SELECT t."tableName"
      FROM unnest($1::text[]) WITH ORDINALITY AS t("tableName",position)
      JOIN pg_class c ON c.relname=t."tableName"
      JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=current_schema() AND c.relkind IN ('r','p')
     ORDER BY t.position
  `, [...AGENCY_NON_FK_TENANT_TABLES]);
  const present = new Set(installed.map((row) => row.tableName));
  let deleted = 0;
  for (const tableName of AGENCY_NON_FK_TENANT_TABLES) {
    if (!present.has(tableName)) continue;
    const table = `"${tableName.replace(/"/g, '""')}"`;
    deleted += Number(await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE "agencyId"=$1`, String(agencyId)) || 0);
  }
  return deleted;
}

async function cleanupPhase3PostgresAgencyFixture(db, agencyId) {
  const id = String(agencyId || "").trim();
  if (!id) return { agencyDeleted: 0, creatorsDeleted: 0, domainWorkDeleted: 0 };
  const authority = await resolvePhase3PostgresDestructiveFixtureAuthority(db);
  if (authority.mode === PHASE3_DESTRUCTIVE_FIXTURE_AUTHORITY_MODE.LEGACY_AGENCY_MARKER) {
    return withPhase3PostgresFixtureAuthority(db, async (tx) => {
      await installLegacyPhase3PostgresAgencyDestructiveFixtureAuthority(tx, id);
      const domainWorkDeleted = await drainPhase3PostgresAgencyDomainWork(tx, id);
      const creatorResult = await tx.creatorAccount.deleteMany({ where: { agencyId: id } });
      await purgePhase3PostgresFixtureTenantResidue(tx, id);
      const agencyResult = await tx.agency.deleteMany({ where: { id } });
      return {
        agencyDeleted: Number(agencyResult?.count || 0),
        creatorsDeleted: Number(creatorResult?.count || 0),
        domainWorkDeleted,
      };
    }, { maxWait: 10_000, timeout: 120_000 });
  }
  const domainWorkDeleted = await withPhase3PostgresFixtureAuthority(
    db,
    (tx) => drainPhase3PostgresAgencyDomainWork(tx, id),
  );
  const claim = await claimPhase3PostgresAgencyDestructiveFixture(db, id);
  return withPhase3PostgresFixtureAuthority(db, async (tx) => {
    // Teardown is set-based and bounded by SQL statement count. Keep the exact
    // claimed Agency cleanup DWI alive while Creator/Member cascade triggers run;
    // deleting Agency removes that work item atomically.
    await installPhase3PostgresAgencyDestructiveFixtureAuthority(tx, id, claim);
    const creatorResult = await tx.creatorAccount.deleteMany({ where: { agencyId: id } });
    await purgePhase3PostgresFixtureTenantResidue(tx, id);
    const agencyResult = await tx.agency.deleteMany({ where: { id } });
    return {
      agencyDeleted: Number(agencyResult?.count || 0),
      creatorsDeleted: Number(creatorResult?.count || 0),
      domainWorkDeleted,
    };
  }, { maxWait: 10_000, timeout: 120_000 });
}



async function cleanupPhase3PostgresFixtureGraph(db, {
  agencyId,
  userIds = [],
} = {}) {
  const id = String(agencyId || "").trim();
  const users = [...new Set((Array.isArray(userIds) ? userIds : []).map((value) => String(value || "").trim()).filter(Boolean))];
  if (!id && !users.length) return { agencyDeleted: 0, creatorsDeleted: 0, domainWorkDeleted: 0, usersDeleted: 0 };
  const authority = id ? await resolvePhase3PostgresDestructiveFixtureAuthority(db) : null;
  if (id && authority.mode === PHASE3_DESTRUCTIVE_FIXTURE_AUTHORITY_MODE.LEGACY_AGENCY_MARKER) {
    return withPhase3PostgresFixtureAuthority(db, async (tx) => {
      await installLegacyPhase3PostgresAgencyDestructiveFixtureAuthority(tx, id);
      const domainWorkDeleted = await drainPhase3PostgresAgencyDomainWork(tx, id);
      const creatorResult = await tx.creatorAccount.deleteMany({ where: { agencyId: id } });
      await purgePhase3PostgresFixtureTenantResidue(tx, id);
      const agencyResult = await tx.agency.deleteMany({ where: { id } });
      const userResult = users.length
        ? await tx.user.deleteMany({ where: { id: { in: users } } })
        : { count: 0 };
      return {
        agencyDeleted: Number(agencyResult?.count || 0),
        creatorsDeleted: Number(creatorResult?.count || 0),
        domainWorkDeleted,
        usersDeleted: Number(userResult?.count || 0),
      };
    }, { maxWait: 10_000, timeout: 120_000 });
  }
  let destructiveClaim = null;
  let predrainedDomainWork = 0;
  if (id) {
    predrainedDomainWork = await withPhase3PostgresFixtureAuthority(
      db,
      (tx) => drainPhase3PostgresAgencyDomainWork(tx, id),
    );
    destructiveClaim = await claimPhase3PostgresAgencyDestructiveFixture(db, id);
  }
  return withPhase3PostgresFixtureAuthority(db, async (tx) => {
    let creatorsDeleted = 0;
    let agencyDeleted = 0;
    let domainWorkDeleted = predrainedDomainWork;
    if (id) {
      await installPhase3PostgresAgencyDestructiveFixtureAuthority(tx, id, destructiveClaim);
      // Drain non-historical operational work before Creator identities. Keep the
      // exact cleanup claim and Agency parent alive until all work/catalog delete
      // triggers complete, then cascade tenant rows before deleting User identity.
      const creatorResult = await tx.creatorAccount.deleteMany({ where: { agencyId: id } });
      creatorsDeleted = Number(creatorResult?.count || 0);
      await purgePhase3PostgresFixtureTenantResidue(tx, id);
      const agencyResult = await tx.agency.deleteMany({ where: { id } });
      agencyDeleted = Number(agencyResult?.count || 0);
    }
    const userResult = users.length
      ? await tx.user.deleteMany({ where: { id: { in: users } } })
      : { count: 0 };
    return {
      agencyDeleted,
      creatorsDeleted,
      domainWorkDeleted,
      usersDeleted: Number(userResult?.count || 0),
    };
  }, { maxWait: 10_000, timeout: 120_000 });
}

module.exports = {
  PHASE3_DESTRUCTIVE_FIXTURE_AUTHORITY_MODE,
  classifyPhase3PostgresDestructiveFixtureAuthority,
  auditSchemaFromDatabaseUrl,
  pinPhase3AuditSchema,
  withPhase3PostgresFixtureAuthority,
  createPhase3PostgresActorFixture,
  drainPhase3PostgresAgencyDomainWork,
  resolvePhase3PostgresDestructiveFixtureAuthority,
  installLegacyPhase3PostgresAgencyDestructiveFixtureAuthority,
  claimPhase3PostgresAgencyDestructiveFixture,
  installPhase3PostgresAgencyDestructiveFixtureAuthority,
  purgePhase3PostgresFixtureTenantResidue,
  cleanupPhase3PostgresAgencyFixture,
  cleanupPhase3PostgresFixtureGraph,
};

"use strict";

const {
  assertTeamControlPlaneWriteAdmission,
  authorizeCreatorAccountWrite,
} = require("../../src/services/phase2-release-compatibility-authority-service");

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

// PostgreSQL integration proofs run against a fully migrated schema where the
// Phase-2 DB writer fences are intentionally ACTIVE. Test fixtures must therefore
// use the same transaction-local release generations as production writers.
// The schema pin is equally authoritative: trigger functions contain unqualified
// relation names and must never resolve into public while a proof targets an
// isolated audit schema. Never disable triggers or mutate compatibility rows.
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

async function drainPhase3PostgresAgencyDomainWork(tx, agencyId) {
  // Phase3 fixture agencies are isolated and disposable. Drain operational work
  // before Creator identities in one set-based statement, matching production
  // destructive ordering and avoiding one nested work DELETE per Creator trigger.
  const result = await tx.domainWorkItem.deleteMany({ where: { agencyId } });
  return Number(result?.count || 0);
}

async function cleanupPhase3PostgresAgencyFixture(db, agencyId) {
  const id = String(agencyId || "").trim();
  if (!id) return { agencyDeleted: 0, creatorsDeleted: 0, domainWorkDeleted: 0 };
  return withPhase3PostgresFixtureAuthority(db, async (tx) => {
    // Teardown is set-based and bounded by SQL statement count. Keep Agency alive
    // while DomainWork/Creator AFTER DELETE projections commit, then let its cascade
    // remove all remaining tenant-owned fixture rows.
    await tx.$queryRawUnsafe(`SELECT set_config('onlinod.phase2_destructive_agency_id',$1,true) AS value`, id);
    const domainWorkDeleted = await drainPhase3PostgresAgencyDomainWork(tx, id);
    const creatorResult = await tx.creatorAccount.deleteMany({ where: { agencyId: id } });
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
  return withPhase3PostgresFixtureAuthority(db, async (tx) => {
    let creatorsDeleted = 0;
    let agencyDeleted = 0;
    let domainWorkDeleted = 0;
    if (id) {
      await tx.$queryRawUnsafe(`SELECT set_config('onlinod.phase2_destructive_agency_id',$1,true) AS value`, id);
      // Drain non-historical operational work before Creator identities. Keep the
      // Agency parent alive until all work/catalog delete triggers complete, then
      // cascade tenant rows before deleting the User identity.
      domainWorkDeleted = await drainPhase3PostgresAgencyDomainWork(tx, id);
      const creatorResult = await tx.creatorAccount.deleteMany({ where: { agencyId: id } });
      creatorsDeleted = Number(creatorResult?.count || 0);
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
  auditSchemaFromDatabaseUrl,
  pinPhase3AuditSchema,
  withPhase3PostgresFixtureAuthority,
  drainPhase3PostgresAgencyDomainWork,
  cleanupPhase3PostgresAgencyFixture,
  cleanupPhase3PostgresFixtureGraph,
};

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
  const searchPath = `"${schema}", pg_catalog, public`;
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

async function cleanupPhase3PostgresAgencyFixture(db, agencyId) {
  const id = String(agencyId || "").trim();
  if (!id) return { agencyDeleted: 0, creatorsDeleted: 0 };
  return withPhase3PostgresFixtureAuthority(db, async (tx) => {
    // Production Agency hard-delete never relies on Agency->Creator cascade: Creator
    // lifecycles are completed first while the Agency parent still exists. Mirror that
    // ordering in the physical-proof harness. Otherwise CreatorAccount AFTER DELETE
    // legitimately bumps AgencyCreatorCatalogState while the Agency is already being
    // cascade-deleted, which can produce a false FK failure in fixture teardown.
    await tx.$queryRawUnsafe(`SELECT set_config('onlinod.phase2_destructive_agency_id',$1,true) AS value`, id);
    const creators = await tx.creatorAccount.findMany({ where: { agencyId: id }, select: { id: true }, orderBy: { id: "asc" } });
    let creatorsDeleted = 0;
    for (const creator of creators) {
      const creatorId = String(creator.id || "").trim();
      if (!creatorId) continue;
      await tx.$queryRawUnsafe(`SELECT set_config('onlinod.phase2_destructive_creator_id',$1,true) AS value`, creatorId);
      const result = await tx.creatorAccount.deleteMany({ where: { id: creatorId, agencyId: id } });
      creatorsDeleted += Number(result?.count || 0);
    }
    await tx.$queryRawUnsafe(`SELECT set_config('onlinod.phase2_destructive_creator_id','',true) AS value`);
    const agencyResult = await tx.agency.deleteMany({ where: { id } });
    return { agencyDeleted: Number(agencyResult?.count || 0), creatorsDeleted };
  });
}

module.exports = {
  auditSchemaFromDatabaseUrl,
  pinPhase3AuditSchema,
  withPhase3PostgresFixtureAuthority,
  cleanupPhase3PostgresAgencyFixture,
};

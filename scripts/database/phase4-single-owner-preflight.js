"use strict";
// Read only. Runs before migrate deploy so ambiguous legacy ownership does not
// leave a failed Prisma migration record. The migration repeats the check under
// table locks to fence writes racing this advisory preflight.
// The wire contract is BOOLEAN, never PostgreSQL regclass/oid catalog objects.
// Resolve only the schema selected by Prisma: search_path fallbacks must not
// make an empty target schema look like a ready deployment.
const SCHEMA_PROBE_SQL = `SELECT
  to_regclass(format('%I.%I', current_schema(), 'Agency')) IS NOT NULL AS agency,
  to_regclass(format('%I.%I', current_schema(), 'AgencyMember')) IS NOT NULL AS member,
  to_regclass(format('%I.%I', current_schema(), 'User')) IS NOT NULL AS account`;
const SCHEMA_FIELDS = Object.freeze(["agency", "member", "account"]);
function schemaProbeResult(rows) {
  if (!Array.isArray(rows) || rows.length !== 1 || !SCHEMA_FIELDS.every(key => typeof rows[0]?.[key] === "boolean")) {
    throw Object.assign(new Error("Invalid ownership schema probe result; expected one row of booleans"), {code:"PHASE4_OWNER_SCHEMA_PROBE_INVALID"});
  }
  return rows[0];
}
async function preflight(db) {
  const tables = schemaProbeResult(await db.$queryRawUnsafe(SCHEMA_PROBE_SQL));
  if (!tables?.agency && !tables?.member && !tables?.account) return {ok:true,readOnly:true,bootstrap:true};
  if (!tables?.agency || !tables?.member || !tables?.account) throw Object.assign(new Error("Incomplete Team schema; cannot validate ownership"),{code:"PHASE4_OWNER_SCHEMA_INCOMPLETE"});
  const blockers = await db.$queryRawUnsafe(`SELECT a."id" AS "agencyId",count(m."id")::int AS "owners",count(m."id") FILTER (WHERE m."deactivatedAt" IS NULL AND u."disabledAt" IS NULL)::int AS "operationalOwners"
    FROM "Agency" a LEFT JOIN "AgencyMember" m ON m."agencyId"=a."id" AND m."deletedAt" IS NULL AND (m."roleKey"='owner' OR m."role"='OWNER')
    LEFT JOIN "User" u ON u."id"=m."userId" GROUP BY a."id",a."deletedAt"
    HAVING count(m."id")>1 OR (a."deletedAt" IS NULL AND (count(m."id")<>1 OR count(m."id") FILTER (WHERE m."deactivatedAt" IS NULL AND u."disabledAt" IS NULL)<>1))
    ORDER BY a."id" LIMIT 50`);
  if (blockers.length) throw Object.assign(new Error("Single OWNER preflight blocked: resolve ownership explicitly before rollout"), {code:"PHASE4_SINGLE_OWNER_PREFLIGHT_FAILED",blockers});
  return {ok:true,authority:"exactly-one-operational-owner",readOnly:true};
}
if (require.main === module) {
  const prisma = require("../../src/prisma");
  preflight(prisma).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(JSON.stringify({ok:false,code:error.code||"PREFLIGHT_FAILED",error:error.message,blockers:error.blockers||[]}));
    process.exitCode = 1;
  }).finally(() => prisma.$disconnect());
}
module.exports = {preflight, SCHEMA_PROBE_SQL, schemaProbeResult};

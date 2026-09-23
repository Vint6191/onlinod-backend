"use strict";
// Read only. Runs before migrate deploy so ambiguous legacy ownership does not
// leave a failed Prisma migration record. The migration repeats the check under
// table locks to fence writes racing this advisory preflight.
const prisma = require("../../src/prisma");
async function preflight(db) {
  const [tables] = await db.$queryRawUnsafe(`SELECT to_regclass('"Agency"') AS agency,to_regclass('"AgencyMember"') AS member,to_regclass('"User"') AS account`);
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
if (require.main===module) preflight(prisma).then(result=>console.log(JSON.stringify(result))).catch(error=>{
  console.error(JSON.stringify({ok:false,code:error.code||"PREFLIGHT_FAILED",error:error.message,blockers:error.blockers||[]}));process.exitCode=1;
}).finally(()=>prisma.$disconnect());
module.exports={preflight};

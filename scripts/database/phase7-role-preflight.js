'use strict';
const {failure}=require('../../src/services/phase7-legacy-storage-service');
// Read-only catalog inspection. No GRANT/REVOKE or database-owner bypass.
async function inspectRoles(db,{roles,strict=false}={}){
  const input=roles??String(process.env.PHASE7_RUNTIME_DB_ROLES||'').split(',').filter(Boolean);
  if(!Array.isArray(input)||input.length>32||input.some(x=>typeof x!=='string'||!x.trim()||x.length>63))throw failure('PHASE7_RUNTIME_ROLE_LIST_INVALID');
  const names=[...new Set(input.map(x=>x.trim()))];
  const actor=(await db.$queryRawUnsafe('SELECT current_user AS name'))[0].name;
  const reports=[];
  for(const name of names){
    const rows=await db.$queryRawUnsafe(`SELECT r.rolname AS name,r.rolsuper AS superuser,r.rolcreaterole AS "createRole",r.rolbypassrls AS "bypassRls",
      r.rolcreatedb AS "createDatabase",r.rolreplication AS replication,
      EXISTS(SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND pg_has_role(r.oid,d.datdba,'MEMBER')) AS "ownsDatabase",
      EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname='public' AND pg_has_role(r.oid,n.nspowner,'MEMBER')) AS "ownsSchema",
      EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND pg_has_role(r.oid,c.relowner,'MEMBER')) AS "ownsTables",
      EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND pg_has_role(r.oid,p.proowner,'MEMBER')) AS "ownsFunctions",
      EXISTS(SELECT 1 FROM pg_roles owner WHERE (owner.rolsuper OR owner.rolcreaterole OR owner.rolbypassrls OR owner.rolcreatedb OR owner.rolreplication) AND pg_has_role(r.oid,owner.oid,'MEMBER')) AS "privilegedMembership",
      has_schema_privilege(r.oid,'public','CREATE') AS "createSchemaObjects"
      FROM pg_roles r WHERE r.rolname=$1`,name);
    if(rows.length!==1)throw failure('PHASE7_RUNTIME_ROLE_NOT_FOUND',{role:name});
    const r=rows[0];
    const checks=['superuser','createRole','bypassRls','createDatabase','replication','ownsDatabase','ownsSchema','ownsTables','ownsFunctions','privilegedMembership','createSchemaObjects'];
    r.safe=checks.every(key=>r[key]===false);reports.push(r);
  }
  const report={actor,runtimeRoles:reports,verified:names.length>0&&reports.every(x=>x.safe),checkedAt:new Date().toISOString()};
  if(strict&&!report.verified)throw failure('PHASE7_RUNTIME_ROLE_SEPARATION_REQUIRED',{roles:reports});
  return report;
}
module.exports={inspectRoles};

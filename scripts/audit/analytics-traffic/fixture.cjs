'use strict';
const path=require('node:path');
if(!process.env.ONLINOD_SQL_PROOF_RUNTIME)throw Error('ONLINOD_SQL_PROOF_RUNTIME must point to a local PGlite + pglite-socket installation');
const runtime=path.resolve(process.env.ONLINOD_SQL_PROOF_RUNTIME);
async function fixture(){
 const current=await require('../../test-support/admin-sql-runtime.cjs').createAdminSqlRuntime({runtimePath:runtime});
 process.env.DATABASE_URL=current.url;process.env.DIRECT_URL=current.url;
 return {...current,pg:current.engine,socket:current.server};
}
async function scope(db,{agencyId='qa-agency',creatorId='qa-creator',userId='qa-user'}={}){
 await db.$transaction(async tx=>{
  await tx.$queryRawUnsafe(`SELECT set_config('onlinod.phase2_team_control_plane_generation','phase2_team_control_plane_v2_durable_access',true),set_config('onlinod.phase2_creator_writer_generation','phase2_creator_writer_v2_actual56_postcut',true)`);
  await tx.user.upsert({where:{id:userId},create:{id:userId,email:userId+'@example.test',passwordHash:'fixture'},update:{}});
  await tx.agency.upsert({where:{id:agencyId},create:{id:agencyId,name:'Fixture'},update:{}});
  await tx.agencyMember.create({data:{id:'member-'+agencyId,agencyId,userId,role:'OWNER',roleKey:'owner',assignedCreators:'all',permissions:{}}});
  await tx.creatorAccount.create({data:{id:creatorId,agencyId,displayName:'Fixture',remoteId:creatorId,status:'READY'}});
 });
 return{agencyId,creatorId,userId};
}
module.exports={fixture,scope};
if(require.main===module)fixture().then(async f=>{console.log('SCHEMA PASS');await scope(f.db);console.log('SCOPE PASS');await f.close();}).catch(e=>{console.error(e.message);process.exitCode=1;});

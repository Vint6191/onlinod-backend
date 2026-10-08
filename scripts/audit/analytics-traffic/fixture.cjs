'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../..');
if(!process.env.ONLINOD_SQL_PROOF_RUNTIME)throw Error('ONLINOD_SQL_PROOF_RUNTIME must point to a local PGlite + pglite-socket installation');
const runtime=path.resolve(process.env.ONLINOD_SQL_PROOF_RUNTIME);
const {PGlite}=require(path.join(runtime,'node_modules/@electric-sql/pglite'));
const {PGLiteSocketServer}=require(path.join(runtime,'node_modules/@electric-sql/pglite-socket'));
const baseFile=process.env.ONLINOD_PROOF_BASE_TAR || null;
async function fixture({newMigrations=true}={}){
 if(newMigrations){
  // Current-code proofs must use the current deployment plan, not a date-pinned
  // subset of migrations or a stale optional base archive. Historical upgrade
  // rehearsals below keep their explicit newMigrations:false baseline.
  const current=await require('../../test-support/admin-sql-runtime.cjs').createAdminSqlRuntime({runtimePath:runtime});
  try{
   await require(path.join(root,'scripts/database/analytics-traffic-indexes')).ensureIndexes(current.db,{create:true});
   console.log('CURRENT_SCHEMA',current.migrations.length);
   return {...current,pg:current.engine,socket:current.server};
  }catch(error){await current.close();throw error;}
 }
 let pg;
 // Large read/index fixtures can use disposable disk storage instead of
 // retaining every relation in WASM memory. Never points at a production DB.
 const storage=process.env.ONLINOD_PROOF_DATA_DIR?{dataDir:path.resolve(process.env.ONLINOD_PROOF_DATA_DIR)}:{};
 if(baseFile&&fs.existsSync(baseFile))pg=await PGlite.create({...storage,loadDataDir:new Blob([fs.readFileSync(baseFile)])});
 else{
  pg=await PGlite.create(storage);
  const history=require(path.join(root,'scripts/database/phase7-applied-history.json')).migrations;
  const names=fs.readdirSync(path.join(root,'prisma/migrations')).filter(n=>n<'20261001'&&n!=='20260930190000_phase7_legacy_storage_contract_v1'&&fs.existsSync(path.join(root,'prisma/migrations',n,'migration.sql'))).sort();
  for(const name of names){
   const old=history.find(h=>h.migration===name);
   const file=old?path.join(root,'scripts/database/phase7-applied-history',name,old.storedChecksum+'.sql'):path.join(root,'prisma/migrations',name,'migration.sql');
   try{await pg.exec(fs.readFileSync(file,'utf8'));}catch(e){e.message=name+': '+e.message;throw e;}
  }
  if(baseFile)fs.writeFileSync(baseFile,Buffer.from(await(await pg.dumpDataDir()).arrayBuffer()));
  console.log('BASE',names.length);
 }
 // Install the same immutable history ledger used by the deploy wrapper.
 await pg.exec('CREATE TABLE IF NOT EXISTS "_prisma_migrations" (id varchar(36) PRIMARY KEY,checksum varchar(64) NOT NULL,finished_at timestamptz,migration_name varchar(255) UNIQUE NOT NULL,logs text,rolled_back_at timestamptz,started_at timestamptz NOT NULL DEFAULT now(),applied_steps_count integer NOT NULL DEFAULT 0)');
 const history=require(path.join(root,'scripts/database/phase7-applied-history.json')).migrations;
 for(const name of fs.readdirSync(path.join(root,'prisma/migrations')).filter(n=>n!=='20260930190000_phase7_legacy_storage_contract_v1'&&fs.existsSync(path.join(root,'prisma/migrations',n,'migration.sql'))&&n<'20261001').sort()){
  const old=history.find(h=>h.migration===name),file=old?path.join(root,'scripts/database/phase7-applied-history',name,old.storedChecksum+'.sql'):path.join(root,'prisma/migrations',name,'migration.sql');
  const crypto=require('node:crypto');await pg.query('INSERT INTO "_prisma_migrations"(id,checksum,migration_name,finished_at,applied_steps_count) VALUES($1,$2,$3,now(),1) ON CONFLICT(migration_name) DO NOTHING',[crypto.randomUUID(),crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),name]);
 }
 const socket=new PGLiteSocketServer({db:pg,host:'127.0.0.1',port:0});await socket.start();
 const url=`postgresql://postgres:postgres@${socket.getServerConn()}/postgres?connection_limit=1&sslmode=disable`;
 process.env.DATABASE_URL=url;process.env.DIRECT_URL=url;
 const {PrismaClient}=require(path.join(root,'node_modules/@prisma/client'));const db=new PrismaClient({datasources:{db:{url}}});
 return {pg,db,root,socket,url,async close(){await db.$disconnect();await socket.stop();await pg.close();}};
}
async function scope(db,{agencyId='qa-agency',creatorId='qa-creator',userId='qa-user'}={}){
 await db.$executeRawUnsafe(`UPDATE "Phase2ReleaseCompatibilityAuthority" SET "activationState"='ACTIVE' WHERE "scope"='TEAM_CONTROL_PLANE'`);
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

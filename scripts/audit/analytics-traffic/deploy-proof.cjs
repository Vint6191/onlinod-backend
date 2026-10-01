'use strict';
// The local Prisma CLI supports this early return before spawning its checkpoint client.
process.env.CHECKPOINT_DISABLE='1';
const {fixture}=require('./fixture.cjs');
const {spawn}=require('node:child_process'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const alive=setInterval(()=>{},1000);const timeout=setTimeout(()=>{console.error('DISPOSABLE_DEPLOY_DEADLINE');process.exit(2)},180000);
async function main(){const f=await fixture({newMigrations:false}),{db,root,pg,url}=f;
 try{
  const fromActual103=process.argv.includes('--from-actual103');
  if(fromActual103){
   // Rehearse the exact user's already-applied V1 history, then let the REAL
   // Prisma CLI add only the repair migration. No checksum rewrite or resolve.
   await db.$disconnect();await pg.exec('DISCARD ALL');
   const crypto=require('node:crypto');
   for(const name of ['20261001000000_analytics_publication_authority_v1','20261001001000_traffic_canonical_projection_v2']){
    const bytes=fs.readFileSync(path.join(root,'prisma/migrations',name,'migration.sql'));
    await pg.exec(bytes.toString('utf8'));
    await pg.query('INSERT INTO "_prisma_migrations"(id,checksum,migration_name,finished_at,applied_steps_count) VALUES($1,$2,$3,now(),1)',[crypto.randomUUID(),crypto.createHash('sha256').update(bytes).digest('hex'),name]);
   }
  }
  const before=(await pg.query('SELECT migration_name,checksum FROM "_prisma_migrations" ORDER BY migration_name')).rows;
  assert.equal(before.length,fromActual103?272:270);await db.$disconnect();
  for(let pass=1;pass<=2;pass++){
   console.log('DEPLOY_PASS',pass);
   await require(path.join(root,'scripts/database/phase7-deploy')).main({db,hooks:false,commandRunner:async args=>{
    // PGlite shares one SQL session between socket clients. Native PostgreSQL
    // gives each process an isolated prepared-statement namespace.
    console.log("HOOK",path.basename(args[0]));
    await db.$disconnect();await pg.exec('DISCARD ALL');
    await new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{cwd:root,env:{...process.env,DATABASE_URL:url,DIRECT_URL:url,PRISMA_HIDE_UPDATE_MESSAGE:'true',CHECKPOINT_DISABLE:'1'},stdio:['ignore','pipe','pipe']});
     child.stdout.on('data',b=>process.stdout.write(b));child.stderr.on('data',b=>process.stderr.write(b));child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('deploy child exit '+code)));
    });
    await pg.exec('DISCARD ALL');
   }});
   await require(path.join(root,'scripts/database/analytics-traffic-indexes')).ensureIndexes(db,{create:true});
   await require(path.join(root,'scripts/database/provider-capacity-catalog-postflight')).verifyCapacityCatalog(db);
   await require(path.join(root,'src/services/provider-capacity-debt-authority-service')).refreshProviderCapacityDebtSnapshot({db});
   await db.$disconnect();
   await pg.exec('DISCARD ALL');
   const rows=(await pg.query('SELECT migration_name,checksum FROM "_prisma_migrations" ORDER BY migration_name')).rows;
   assert.equal(rows.length,273);assert.deepEqual(rows.filter(x=>before.some(b=>b.migration_name===x.migration_name)),before);
   assert(!rows.some(x=>x.migration_name==='20260930190000_phase7_legacy_storage_contract_v1'));
  }
  console.log(JSON.stringify({actualPrismaCli:true,wrapperHooks:false,existingMultiSessionPreflight:"OPEN: requires native PostgreSQL; unchanged hook requires distinct sessions",newOnlineIndexes:true,capacityCatalogPostflight:true,capacityRuntimePublication:true,installTwice:true,priorChecksumsPreserved:before.length,totalApplied:273,destructiveContractApplied:false,runtime:process.version,postgres:'PGlite single connection; not native concurrency'},null,2));
 }finally{await f.close();}}
main().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(()=>{clearInterval(alive);clearTimeout(timeout)});

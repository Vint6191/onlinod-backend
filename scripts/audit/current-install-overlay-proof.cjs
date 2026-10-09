'use strict';
// Actual Prisma CLI against disposable SQL. Never uses a configured application DB.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{createRequire}=require('node:module');
const runtime=process.env.ONLINOD_SQL_PROOF_RUNTIME;
if(!runtime)throw Error('Set ONLINOD_SQL_PROOF_RUNTIME to the isolated PGlite proof runtime');
const load=createRequire(path.resolve(runtime,'package.json'));
const {PGlite}=load('@electric-sql/pglite'),{PGLiteSocketServer}=load('@electric-sql/pglite-socket');
const root=path.resolve(__dirname,'../..'),contract=require('../../src/services/database-contract.json');
const output=process.env.ONLINOD_SQL_PROOF_OUTPUT?path.resolve(process.env.ONLINOD_SQL_PROOF_OUTPUT,'evidence'):fs.mkdtempSync(path.join(os.tmpdir(),'onlinod-overlay-results-'));
fs.mkdirSync(output,{recursive:true});
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'onlinod overlay proof ')),fixture=path.join(scratch,'backend');
const report={ok:false,nativePostgres:false,productionAccessed:false,engine:'PGlite 0.5.8 + Prisma 5.22 CLI',cases:[]};
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function sourceSnapshot(){
 const found={};function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,entry.name);if(entry.isDirectory())walk(p);else found[path.relative(fixture,p)]=hash(fs.readFileSync(p));}}walk(path.join(fixture,'prisma'));return found;
}
async function check(name,fn){await fn();report.cases.push({name,ok:true});console.log('PASS',name);}
function cli(url,label,expectedCode=0){return new Promise((resolve,reject)=>{
 const file=path.join(output,'overlay-'+label+'.log'),fd=fs.openSync(file,'w');
 const env={...process.env,DATABASE_URL:url,TMPDIR:scratch,TEMP:scratch,TMP:scratch};
 delete env.DIRECT_URL;delete env.SHADOW_DATABASE_URL;
 const child=spawn(process.execPath,['scripts/database/install-current.js'],{cwd:fixture,env,stdio:['ignore',fd,fd]});
 const timer=setTimeout(()=>child.kill('SIGTERM'),60000);
 child.once('error',e=>{clearTimeout(timer);fs.closeSync(fd);reject(e);});
 child.once('exit',(code,signal)=>{
  clearTimeout(timer);fs.closeSync(fd);
  try{assert.equal(signal,null);assert.equal(code,expectedCode,label);assert.ok(!fs.readdirSync(scratch).some(n=>n.startsWith('onlinod-current-install-')),'temporary deployment left behind');resolve(fs.readFileSync(file,'utf8'));}catch(e){reject(e);}
 });
});}
async function database(fn){
 const pg=await PGlite.create(),socket=new PGLiteSocketServer({db:pg,host:'127.0.0.1',port:0});
 socket.addEventListener('connection',()=>{pg.exec('DISCARD ALL').catch(()=>{});});
 await socket.start();
 try{await fn(pg,`postgresql://postgres:postgres@${socket.getServerConn()}/postgres?connection_limit=1&sslmode=disable`);}finally{await socket.stop();await pg.close();}
}
(async()=>{const keep=setInterval(()=>{},1000);try{
 const selected=`prisma/migrations/${contract.migration}/migration.sql`;
 for(const rel of [selected,'prisma/schema.prisma','scripts/database/install-current.js','src/services/database-contract-service.js','src/services/database-contract.json']){
  const dest=path.join(fixture,rel);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(root,rel),dest);
 }
 fs.symlinkSync(fs.realpathSync(path.join(root,'node_modules')),path.join(fixture,'node_modules'),'junction');
 const historical=process.env.ONLINOD_INSTALL_PROOF_OLD_MIGRATIONS;
 let copied=0;
 if(historical)for(const entry of fs.readdirSync(historical,{withFileTypes:true}))if(entry.isDirectory()&&entry.name!==contract.migration){fs.cpSync(path.join(historical,entry.name),path.join(fixture,'prisma/migrations',entry.name),{recursive:true});copied++;}
 for(const name of ['19000101000000_retired_poison','29990101000000_unselected_poison']){
  const dir=path.join(fixture,'prisma/migrations',name);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'migration.sql'),"DO $$ BEGIN RAISE EXCEPTION 'UNSELECTED_MIGRATION_EXECUTED'; END $$;\n");
 }
 fs.mkdirSync(path.join(fixture,'prisma/migrations/empty-retired-directory'));
 fs.writeFileSync(path.join(fixture,'prisma/migrations/migration_lock.toml'),'provider = "sqlite"\n');
 report.historicalMigrationDirectories=copied;report.additionalAdversarialDirectories=3;
 const migration=path.join(fixture,selected),sql=fs.readFileSync(migration,'utf8'),before=sourceSnapshot();
 await database(async(pg,url)=>{
  await check('mixed source tree installs only the verified current baseline',async()=>{
   const log=await cli(url,'first');assert.match(log,/1 migration found/);
   const rows=(await pg.query('SELECT migration_name,checksum FROM "_prisma_migrations"')).rows;
   assert.deepEqual(rows,[{migration_name:contract.migration,checksum:contract.checksum}]);assert.deepEqual(sourceSnapshot(),before);
  });
  await pg.exec(`INSERT INTO "LoginAdmissionBucket"("id","windowStartedAt","expiresAt","attempts") VALUES('preserve-current-data',now(),now()+interval '1 hour',3)`);
  const intact=async()=>{assert.equal((await pg.query('SELECT attempts FROM "LoginAdmissionBucket" WHERE id=$1',['preserve-current-data'])).rows[0].attempts,3);assert.equal((await pg.query('SELECT count(*)::int n FROM "_prisma_migrations"')).rows[0].n,1);};
  await check('repeat installation preserves current rows and leaves old source files untouched',async()=>{await cli(url,'repeat');await intact();assert.deepEqual(sourceSnapshot(),before);});
  await check('Windows CRLF checkout produces the same migration receipt',async()=>{
   fs.writeFileSync(migration,sql.replace(/\n/g,'\r\n'));const snapshot=sourceSnapshot();
   await cli(url,'crlf');await intact();assert.deepEqual(sourceSnapshot(),snapshot);
   assert.equal((await pg.query('SELECT checksum FROM "_prisma_migrations"')).rows[0].checksum,contract.checksum);
  });
  await check('changed baseline is rejected before Prisma or database writes',async()=>{
   fs.writeFileSync(migration,sql+'\nSELECT 42;\n');const log=await cli(url,'tamper',1);
   assert.match(log,/BASELINE_SOURCE_CHECKSUM_MISMATCH/);assert.doesNotMatch(log,/Datasource/);await intact();fs.writeFileSync(migration,sql);
  });
  await check('missing baseline cannot fall back to a historical migration',async()=>{
   fs.unlinkSync(migration);const log=await cli(url,'missing',1);assert.match(log,/ENOENT/);assert.doesNotMatch(log,/Datasource/);await intact();fs.writeFileSync(migration,sql);
  });
  await check('non-public schema is rejected without changing data',async()=>{const log=await cli(url+'&schema=other','schema',1);assert.match(log,/PUBLIC_SCHEMA_REQUIRED/);await intact();});
 });
 await database(async(pg,url)=>{
  await pg.exec('CREATE TABLE "ExistingBusinessData"(id text PRIMARY KEY,value text NOT NULL); INSERT INTO "ExistingBusinessData" VALUES(\'keep\',\'unchanged\')');
  const intact=async()=>assert.deepEqual((await pg.query('SELECT * FROM "ExistingBusinessData"')).rows,[{id:'keep',value:'unchanged'}]);
  await check('unbaselined populated database is rejected with a useful message and no changes',async()=>{
   const log=await cli(url,'populated',1);assert.match(log,/EMPTY_DATABASE_REQUIRED/);assert.match(log,/NEW EMPTY database/);assert.doesNotMatch(log,/Datasource/);await intact();
   assert.equal((await pg.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n,1);
  });
  await pg.exec('CREATE TABLE "_prisma_migrations"(migration_name text,checksum text,finished_at timestamptz,rolled_back_at timestamptz); INSERT INTO "_prisma_migrations" VALUES(\'old-baseline\',\'old\',now(),NULL)');
  await check('old migration receipts are rejected without reset or data loss',async()=>{
   const log=await cli(url,'old-ledger',1);assert.match(log,/CURRENT_BASELINE_DATABASE_REQUIRED/);assert.match(log,/existing data was not changed/);await intact();
   assert.deepEqual((await pg.query('SELECT migration_name,checksum FROM "_prisma_migrations"')).rows,[{migration_name:'old-baseline',checksum:'old'}]);
  });
 });
 report.ok=true;
}catch(e){report.error={message:e.message,stack:e.stack};console.error(e.message);process.exitCode=1;}finally{clearInterval(keep);fs.rmSync(scratch,{recursive:true,force:true});fs.writeFileSync(path.join(output,'current-install-overlay-proof.json'),JSON.stringify(report,null,2)+'\n');}})();

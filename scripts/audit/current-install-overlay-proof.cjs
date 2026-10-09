'use strict';
// Actual Prisma CLI against disposable SQL. Never uses a configured application DB.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{createRequire}=require('node:module');
const runtime=process.env.ONLINOD_SQL_PROOF_RUNTIME;
if(!runtime)throw Error('Set ONLINOD_SQL_PROOF_RUNTIME to the isolated PGlite proof runtime');
const load=createRequire(path.resolve(runtime,'package.json'));
const {PGlite}=load('@electric-sql/pglite'),{PGLiteSocketServer}=load('@electric-sql/pglite-socket');
const root=path.resolve(__dirname,'../..'),contract=require('../../src/services/database-contract.json');
const resetFlag='--reset-legacy-test-database',oldMigration='20260429193000_init_auth_v2';
const output=process.env.ONLINOD_SQL_PROOF_OUTPUT?path.resolve(process.env.ONLINOD_SQL_PROOF_OUTPUT,'evidence'):fs.mkdtempSync(path.join(os.tmpdir(),'onlinod-overlay-results-'));
fs.mkdirSync(output,{recursive:true});
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'onlinod overlay proof ')),fixture=path.join(scratch,'backend');
const report={ok:false,nativePostgres:false,productionAccessed:false,engine:'PGlite 0.5.8 + Prisma 5.22 CLI',cases:[]};
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function sourceSnapshot(){
 const found={};function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,entry.name);if(entry.isDirectory())walk(p);else found[path.relative(fixture,p)]=hash(fs.readFileSync(p));}}walk(path.join(fixture,'prisma'));return found;
}
async function check(name,fn){await fn();report.cases.push({name,ok:true});console.log('PASS',name);}
function cli(url,label,expectedCode=0,args=[],command=null){return new Promise((resolve,reject)=>{
 const file=path.join(output,'overlay-'+label+'.log'),fd=fs.openSync(file,'w');
 const env={...process.env,DATABASE_URL:url,TMPDIR:scratch,TEMP:scratch,TMP:scratch};
 delete env.DIRECT_URL;delete env.SHADOW_DATABASE_URL;
 const child=spawn(process.execPath,command||['scripts/database/install-current.js',...args],{cwd:fixture,env,stdio:['ignore',fd,fd]});
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
 let copied=0;const historicalNames=[];
 if(historical)for(const entry of fs.readdirSync(historical,{withFileTypes:true}))if(entry.isDirectory()&&entry.name!==contract.migration){fs.cpSync(path.join(historical,entry.name),path.join(fixture,'prisma/migrations',entry.name),{recursive:true});historicalNames.push(entry.name);copied++;}
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
  await check('reset option on a current installation preserves data and its receipt',async()=>{
   const log=await cli(url,'current-with-reset-option',0,[resetFlag]);
   assert.match(log,/"legacyReset":false/);assert.doesNotMatch(log,/RESETTING_LEGACY_TEST_DATABASE/);await intact();
  });
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
  await check('non-public schema is rejected without changing data even with reset option',async()=>{const log=await cli(url+'&schema=other','schema',1,[resetFlag]);assert.match(log,/PUBLIC_SCHEMA_REQUIRED/);await intact();});
  await check('unknown options fail before database writes',async()=>{const log=await cli(url,'unknown-option',1,['--reset']);assert.match(log,/UNKNOWN_INSTALL_ARGUMENT/);await intact();});
  await pg.exec(`INSERT INTO "_prisma_migrations"(id,checksum,migration_name,finished_at) VALUES('extra-old-receipt','old','${oldMigration}',now())`);
  await check('mixed current and old history is never reset',async()=>{
   const log=await cli(url,'mixed-receipts',1,[resetFlag]);assert.match(log,/LEGACY_TEST_RESET_NOT_APPLICABLE/);
   assert.equal((await pg.query('SELECT count(*)::int n FROM "_prisma_migrations"')).rows[0].n,2);
   assert.equal((await pg.query('SELECT attempts FROM "LoginAdmissionBucket" WHERE id=$1',['preserve-current-data'])).rows[0].attempts,3);
  });
  await pg.exec("DELETE FROM \"_prisma_migrations\" WHERE id='extra-old-receipt'; UPDATE \"_prisma_migrations\" SET checksum='changed'");
  await check('a changed current receipt is never reset',async()=>{
   const log=await cli(url,'changed-receipt',1,[resetFlag]);assert.match(log,/LEGACY_TEST_RESET_NOT_APPLICABLE/);await intact();
   assert.equal((await pg.query('SELECT checksum FROM "_prisma_migrations"')).rows[0].checksum,'changed');
  });
  await pg.query('UPDATE "_prisma_migrations" SET checksum=$1,finished_at=NULL',[contract.checksum]);
  await check('an incomplete current installation is never reset',async()=>{
   const log=await cli(url,'incomplete-current',1,[resetFlag]);assert.match(log,/BASELINE_INSTALLATION_INCOMPLETE/);await intact();
  });
 });
 await database(async(pg,url)=>{
  await pg.exec('CREATE TABLE "ExistingBusinessData"(id text PRIMARY KEY,value text NOT NULL); INSERT INTO "ExistingBusinessData" VALUES(\'keep\',\'unchanged\')');
  const intact=async()=>assert.deepEqual((await pg.query('SELECT * FROM "ExistingBusinessData"')).rows,[{id:'keep',value:'unchanged'}]);
  await check('unbaselined populated database is rejected with a useful message and no changes',async()=>{
   const log=await cli(url,'populated',1);assert.match(log,/EMPTY_DATABASE_REQUIRED/);assert.match(log,/NEW EMPTY database/);assert.doesNotMatch(log,/Datasource/);await intact();
   assert.equal((await pg.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n,1);
  });
  await check('reset option does not clear an unrelated unbaselined database',async()=>{
   const log=await cli(url,'unbaselined-reset',1,[resetFlag]);assert.match(log,/EMPTY_DATABASE_REQUIRED/);await intact();
  });
  await pg.exec(`CREATE TABLE "_prisma_migrations"(migration_name text,checksum text,finished_at timestamptz,rolled_back_at timestamptz); INSERT INTO "_prisma_migrations" VALUES('${oldMigration}','old',now(),NULL)`);
  await check('old migration receipts are rejected without reset or data loss',async()=>{
   const log=await cli(url,'old-ledger',1);assert.match(log,/CURRENT_BASELINE_DATABASE_REQUIRED/);assert.match(log,/existing data was not changed/);await intact();
   assert.deepEqual((await pg.query('SELECT migration_name,checksum FROM "_prisma_migrations"')).rows,[{migration_name:oldMigration,checksum:'old'}]);
  });
  await check('a tampered source cannot delete the old test database',async()=>{
   fs.writeFileSync(migration,sql+'\nSELECT 42;\n');
   try{const log=await cli(url,'reset-tamper',1,[resetFlag]);assert.match(log,/BASELINE_SOURCE_CHECKSUM_MISMATCH/);assert.doesNotMatch(log,/RESETTING_LEGACY_TEST_DATABASE/);await intact();}
   finally{fs.writeFileSync(migration,sql);}
  });
  await pg.exec(`CREATE SCHEMA qa_independent; CREATE TABLE qa_independent.keep_me(id integer PRIMARY KEY); INSERT INTO qa_independent.keep_me VALUES(7);
   CREATE FUNCTION qa_independent.fail_recreate() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'QA_SCHEMA_RECREATE_FAILURE'; END $$;
   CREATE EVENT TRIGGER fail_schema_recreate ON ddl_command_start WHEN TAG IN ('CREATE SCHEMA') EXECUTE FUNCTION qa_independent.fail_recreate()`);
  await check('failed schema recreation rolls back deletion and preserves old rows and history',async()=>{
   const log=await cli(url,'reset-rollback',1,[resetFlag]);assert.match(log,/RESETTING_LEGACY_TEST_DATABASE/);await intact();
   assert.deepEqual((await pg.query('SELECT migration_name,checksum FROM "_prisma_migrations"')).rows,[{migration_name:oldMigration,checksum:'old'}]);
  });
  await pg.exec('DROP EVENT TRIGGER fail_schema_recreate; DROP FUNCTION qa_independent.fail_recreate()');
  await pg.query('INSERT INTO "_prisma_migrations" SELECT name,\'historical\',now(),NULL FROM jsonb_array_elements_text($1::jsonb) AS names(name) WHERE name<>$2',[JSON.stringify(historicalNames),oldMigration]);
  report.historicalMigrationReceipts=(await pg.query('SELECT count(*)::int n FROM "_prisma_migrations"')).rows[0].n;
  await check('explicit old test reset installs only the current baseline in the same database',async()=>{
   const log=await cli(url,'reset-old-test',0,[resetFlag]);assert.match(log,/"legacyReset":true/);assert.match(log,/1 migration found/);
   assert.deepEqual((await pg.query('SELECT migration_name,checksum FROM "_prisma_migrations"')).rows,[{migration_name:contract.migration,checksum:contract.checksum}]);
   assert.equal((await pg.query("SELECT to_regclass('public.\"ExistingBusinessData\"')::text name")).rows[0].name,null);
   assert.deepEqual((await pg.query('SELECT * FROM qa_independent.keep_me')).rows,[{id:7}]);
   assert.deepEqual(sourceSnapshot(),before);
  });
  await pg.exec(`INSERT INTO "LoginAdmissionBucket"("id","windowStartedAt","expiresAt","attempts") VALUES('after-old-reset',now(),now()+interval '1 hour',4)`);
  await check('both reset-option and ordinary redeploy preserve data created after the first reset',async()=>{
   const receipt=(await pg.query('SELECT * FROM "_prisma_migrations"')).rows;
   const log=await cli(url,'reset-repeat',0,[resetFlag]);assert.match(log,/"legacyReset":false/);
   await cli(url,'reset-then-ordinary');
   assert.equal((await pg.query("SELECT attempts FROM \"LoginAdmissionBucket\" WHERE id='after-old-reset'")).rows[0].attempts,4);
   assert.deepEqual((await pg.query('SELECT * FROM "_prisma_migrations"')).rows,receipt);
  });
 });
 await database(async(pg,url)=>{
  await pg.exec(`CREATE TABLE "_prisma_migrations"(migration_name text,checksum text,finished_at timestamptz,rolled_back_at timestamptz); INSERT INTO "_prisma_migrations" VALUES('20990101000000_future','future',now(),NULL)`);
  await check('a later migration history cannot be destroyed by a stale reset option',async()=>{
   const log=await cli(url,'future-receipt',1,[resetFlag]);assert.match(log,/LEGACY_TEST_RESET_NOT_APPLICABLE/);
   assert.equal((await pg.query('SELECT migration_name FROM "_prisma_migrations"')).rows[0].migration_name,'20990101000000_future');
  });
 });
 await database(async(pg,url)=>{
  await pg.exec(`CREATE TABLE "_prisma_migrations"(migration_name text,checksum text,finished_at timestamptz,rolled_back_at timestamptz); INSERT INTO "_prisma_migrations" VALUES('${oldMigration}','old',now(),NULL); CREATE TABLE "OldRows"(id integer); INSERT INTO "OldRows" VALUES(1)`);
  await check('a reset completed without deployment can resume safely with the same option',async()=>{
   const resetOnly=`const {PrismaClient}=require('@prisma/client'); const {resetLegacyTestDatabase}=require('./scripts/database/install-current'); const db=new PrismaClient(); resetLegacyTestDatabase(db).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.code||e.message);process.exitCode=1}).finally(()=>db.$disconnect());`;
   const first=await cli(url,'reset-without-deploy',0,[],['-e',resetOnly]);assert.match(first,/"legacyReset":true/);
   assert.equal((await pg.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n,0);
   const log=await cli(url,'reset-resume-empty',0,[resetFlag]);assert.match(log,/"legacyReset":false/);assert.match(log,/"fresh":true/);
   assert.deepEqual((await pg.query('SELECT migration_name,checksum FROM "_prisma_migrations"')).rows,[{migration_name:contract.migration,checksum:contract.checksum}]);
  });
 });
 report.ok=true;
}catch(e){report.error={message:e.message,stack:e.stack};console.error(e.message);process.exitCode=1;}finally{clearInterval(keep);fs.rmSync(scratch,{recursive:true,force:true});fs.writeFileSync(path.join(output,'current-install-overlay-proof.json'),JSON.stringify(report,null,2)+'\n');}})();

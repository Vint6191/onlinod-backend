'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const contract=require('./database-contract.json');
const parity=require('../../scripts/test-support/current-business-contract.json');
const root=path.resolve(__dirname,'../..');
const sql=fs.readFileSync(path.join(root,'prisma/migrations',contract.migration,'migration.sql'),'utf8');
const schema=fs.readFileSync(path.join(root,'prisma/schema.prisma'),'utf8');
const digest=s=>crypto.createHash('sha256').update(s).digest('hex');

test('immutable baseline and explicit additive migrations are the installation source',()=>{
 assert.deepEqual(fs.readdirSync(path.join(root,'prisma/migrations'),{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name),require('./database-migration-chain').migrations.map(item=>item.migration));
 assert.equal(digest(sql),contract.checksum);
 assert.match(sql,/\nBEGIN;/);assert.match(sql,/COMMIT;\s*$/);
 assert.doesNotMatch(sql,/CREATE INDEX CONCURRENTLY|NOT VALID|Phase7Retirement/);
});
test('current Team storage is retained and retired physical storage cannot return',()=>{
 const tables=new Set([...sql.matchAll(/CREATE (?:UNLOGGED )?TABLE "([^"]+)"/g)].map(m=>m[1]));
 assert.equal(tables.size,210);
 for(const name of parity.retiredTables)assert.equal(tables.has(name),false,name);
 for(const name of ['TeamResponseCaseCurrent','TeamPendingDialogStateCurrent','AutomationDelivery','AutomationTask','CustomDeliveryReceipt','ManagementCommandReceipt','MessageLibraryCommandReceipt','CreatorObservationClock']) {
  if(name==='CreatorObservationClock')assert.ok(tables.has('FanObservationCreatorClock'));else assert.ok(tables.has(name),name);
 }
});
test('retained business functions preserve the final applied behavior',()=>{
 const definitions=new Set([...sql.matchAll(/CREATE(?: OR REPLACE)? FUNCTION public\.([^\s(]+)\([^]*?\$function\$[^]*?\$function\$/g)].map(m=>digest(m[0].trim().replace(/;$/,''))));
 for(const expected of parity.functions)assert.ok(definitions.has(expected.hash),expected.name);
});
test('retained checks, foreign keys and row triggers survive baseline consolidation',()=>{
 for(const x of parity.constraints){const expected=`ALTER TABLE "${x.table}" ADD CONSTRAINT "${x.name}" ${x.definition.replace(' NOT VALID','')};`;assert.ok(sql.includes(expected),x.name);}
 for(const x of parity.triggers)assert.ok(sql.includes(x.definition+';'),x.name);
});
test('fresh controls are active and do not require a prior fleet or repair pass',()=>{
 assert.doesNotMatch(sql,/Phase2ReleaseCompatibilityAuthority|Phase2LegacyExecutorFence|NOTIFICATION_HISTORY_REPAIR|NOTIFICATION_RETAINED_REPAIR_V3/);
 assert.match(sql,/INSERT INTO "OfProviderRequestGateState"[^;]*'ACTIVE'/);
 assert.match(sql,/INSERT INTO "DomainWorkClaimTopologyState"[^;]*'ACTIVE'/);
 assert.match(sql,/"writerGenerationActive":true/);assert.match(sql,/"claimGenerationActive":true/);
 assert.match(schema,/enum SecretEncryptionMode\s*{\s*CLIENT_E2E_V1\s*}/);
});
test('installer accepts empty or current receipt and rejects unknown populated databases',async()=>{
 const {inspectInstallation}=require('../../scripts/database/install-current');
 assert.deepEqual(await inspectInstallation({$queryRawUnsafe:async()=>[]}),{fresh:true});
 await assert.rejects(inspectInstallation({$queryRawUnsafe:async()=>[{name:'Agency'}]}),{code:'EMPTY_DATABASE_REQUIRED'});
 const db={$queryRawUnsafe:async q=>q.includes('pg_class')?[{name:'_prisma_migrations'}]:[{migration_name:contract.migration,checksum:contract.checksum,finished_at:new Date(),rolled_back_at:null}]};
 assert.deepEqual(await inspectInstallation(db),{fresh:false});
 await assert.rejects(inspectInstallation({$queryRawUnsafe:async q=>q.includes('pg_class')?[{name:'_prisma_migrations'}]:[{migration_name:'old',checksum:'old'}]}),{code:'CURRENT_BASELINE_DATABASE_REQUIRED'});
});
test('installer distinguishes duplicate receipts from an incomplete migration sequence without accepting either',async()=>{
 const {inspectInstallation}=require('../../scripts/database/install-current');
 const {migrations}=require('./database-migration-chain');
 const receipts=migrations.map(item=>({migration_name:item.migration,checksum:item.checksum,finished_at:new Date(),rolled_back_at:null}));
 const fixture=rows=>({$queryRawUnsafe:async q=>q.includes('pg_class')?[{name:'_prisma_migrations'}]:rows});
 assert.deepEqual(await inspectInstallation(fixture(receipts)),{fresh:false});
 await assert.rejects(inspectInstallation(fixture([...receipts,receipts[0]])),{code:'DUPLICATE_BASELINE_RECEIPT'});
 for(const missing of ['20261016000000_earnings_published_snapshot','20261017010000_subscriber_publication_liveness','20261018050000_subscriber_stranded_wake']) {
  const at=migrations.findIndex(item=>item.migration===missing);
  assert(at>0 && at<receipts.length-1);
  assert.deepEqual(await inspectInstallation(fixture(receipts.slice(0,at))),{fresh:false});
  await assert.rejects(inspectInstallation(fixture(receipts.filter((_,i)=>i!==at))),{code:'NONCONTIGUOUS_BASELINE_RECEIPTS'});
 }
});
test('upgrade fixtures select only a genuine migration prefix and reject unknown or empty predecessors',()=>{
 const {migrations,validMigrationPrefix}=require('./database-migration-chain');
 const {selectProofMigrations}=require('../../scripts/test-support/proof-migration-chain.cjs');
 assert.deepEqual(selectProofMigrations(),migrations);
 for(let i=1;i<migrations.length;i++) {
  const selected=selectProofMigrations(migrations[i].migration);
  assert.deepEqual(selected,migrations.slice(0,i));
  assert.equal(validMigrationPrefix(selected.map(item=>({migration_name:item.migration,checksum:item.checksum,finished_at:new Date()}))),true);
 }
 assert.throws(()=>selectProofMigrations('unknown-migration'),{code:'PROOF_MIGRATION_PREFIX_REQUIRED'});
 assert.throws(()=>selectProofMigrations(migrations[0].migration),{code:'PROOF_MIGRATION_PREFIX_REQUIRED'});
 assert.deepEqual(selectProofMigrations(),migrations);
});

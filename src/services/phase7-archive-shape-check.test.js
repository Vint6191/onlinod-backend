'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const expected=require('./phase7-archive-shape.json');
const {check}=require('./phase7-archive-shape-check');
const names=Object.keys(expected);
function fixture(mutate=()=>{},metadataFails=false){
 const copy=structuredClone(expected);mutate(copy);
 const calls=[];
 return {calls,$queryRawUnsafe:async(sql,tables)=>{
  calls.push(sql);assert.match(sql,/^SELECT /);
  if(sql.includes('information_schema.columns'))return tables.flatMap(table=>(copy[table]?.columns||[]).map(row=>({table_name:table,...row})));
  if(sql.includes('pg_constraint'))return tables.flatMap(table=>(copy[table]?.constraints||[]).map(row=>({table_name:table,...row})));
  assert.match(sql,/current_setting\('server_version'\)/);
  if(metadataFails)throw Error('fixture metadata unavailable');
  return [{serverVersion:'17.5',searchPath:'public',currentSchema:'public',quoteAllIdentifiers:'off'}];
 }};
}
function reporter(){
 const file=path.resolve(__dirname,'../../scripts/database/phase7-deploy.js'),native=createRequire(file),module={exports:{}};
 vm.runInNewContext(fs.readFileSync(file,'utf8'),{module,exports:module.exports,require:id=>id==='dotenv'?{config(){}}:native(id),__dirname:path.dirname(file),process,console},{filename:file});
 return module.exports.reportFailure;
}
test('All 36 exact archive contracts still pass using only the two catalog reads',async()=>{
 const db=fixture();assert.equal(await check(db,names),true);assert.equal(names.length,36);assert.equal(db.calls.length,2);
});
test('All mismatched tables and exact missing, changed and unexpected fields are reported together',async()=>{
 const db=fixture(s=>{
  s.AnalyticsSnapshot.columns.find(r=>r.column_name==='capturedAt').column_default='now()';
  s.AnalyticsSnapshot.constraints=s.AnalyticsSnapshot.constraints.filter(r=>r.type!=='f');
  s.CrmProfile.columns.push({column_name:'unexpectedLegacyColumn',data_type:'text',is_nullable:'YES',column_default:null});
  s.CrmProfile.columns.find(r=>r.column_name==='id').is_nullable='YES';
 });
 await assert.rejects(check(db,names),error=>{
  assert.equal(error.code,'PHASE7_ARCHIVE_PHYSICAL_SHAPE_MISMATCH');assert.equal(error.table,'AnalyticsSnapshot');
  const d=error.phase7Diagnostics;assert.equal(d.checked,36);assert.equal(d.total,2);
  assert.deepEqual(d.tables.map(t=>t.table),['AnalyticsSnapshot','CrmProfile']);
  assert(d.tables[0].differences.some(x=>x.kind==='changed'&&x.field==='column_default'&&x.expected==='CURRENT_TIMESTAMP'&&x.actual==='now()'));
  assert(d.tables[0].differences.some(x=>x.kind==='missing'&&x.name==='AnalyticsSnapshot_agencyId_fkey'));
  assert(d.tables[1].differences.some(x=>x.kind==='unexpected'&&x.name==='unexpectedLegacyColumn'));
  assert(d.tables[1].differences.some(x=>x.kind==='changed'&&x.field==='is_nullable'));
  assert.equal(d.context.serverVersion,'17.5');
  const lines=[];reporter()(error,line=>lines.push(line));
  const events=lines.slice(0,-1).map(line=>JSON.parse(line));
  assert.equal(events.filter(x=>x.event==='PHASE7_ARCHIVE_TABLE_SHAPE_DIFF').length,2);
  assert.equal(events.filter(x=>x.event==='PHASE7_ARCHIVE_SHAPE_DETAIL').length,4);
  assert.equal(lines.at(-1),error.code);return true;
 });
 assert.equal(db.calls.length,3);
});
test('Constraint definition changes remain blocked and include both exact definitions',async()=>{
 const db=fixture(s=>{s.AnalyticsSnapshot.constraints[0].definition+=' NOT VALID';});
 await assert.rejects(check(db,names),error=>{
  const diff=error.phase7Diagnostics.tables[0].differences[0];
  assert.equal(diff.field,'definition');assert.equal(diff.actual,diff.expected+' NOT VALID');return true;
 });
});
test('Serialization-only differences are visible and are not silently accepted',async()=>{
 const db=fixture(s=>{s.AnalyticsSnapshot.columns=s.AnalyticsSnapshot.columns.map(r=>Object.fromEntries(Object.entries(r).reverse()));});
 await assert.rejects(check(db,names),error=>{
  const table=error.phase7Diagnostics.tables[0];assert.equal(table.serializationOnly,true);assert.deepEqual(table.differences,[]);return true;
 });
});
test('Failure of optional server metadata cannot hide the original mismatch',async()=>{
 const db=fixture(s=>{s.CrmProfile.columns.pop();},true);
 await assert.rejects(check(db,names),error=>{
  assert.equal(error.code,'PHASE7_ARCHIVE_PHYSICAL_SHAPE_MISMATCH');assert.equal(error.table,'CrmProfile');
  assert.deepEqual(error.phase7Diagnostics.context,{unavailable:true});return true;
 });
});
test('Purged/excluded archive tables are not added back by diagnostics',async()=>{
 const db=fixture(s=>{delete s.AnalyticsSnapshot;});
 assert.equal(await check(db,names.filter(t=>t!=='AnalyticsSnapshot')),true);
 assert.equal(await check(db,[]),true);
});
test('Deployment error reporting preserves historical diagnostics and normal errors',()=>{
 const report=reporter(),lines=[],history={event:'PHASE7_MIGRATION_HISTORY_MISMATCH',total:1};
 report({phase7Diagnostics:history,code:'HISTORY_BLOCKED'},line=>lines.push(line));
 report(Error('other failure'),line=>lines.push(line));
 assert.deepEqual(lines,[JSON.stringify(history),'HISTORY_BLOCKED','other failure']);
});

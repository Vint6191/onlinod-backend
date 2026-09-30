'use strict';
const expected=require('./phase7-archive-shape.json');
const {isDeepStrictEqual}=require('node:util');

// Diagnostics only. Acceptance below intentionally keeps the original exact
// comparison: unknown defaults, constraints and columns still block retirement.
function rowDifferences(section,key,wanted,actual){
 const before=new Map(wanted.map(row=>[row[key],row]));
 const after=new Map(actual.map(row=>[row[key],row]));
 const differences=[];
 for(const [name,row] of before){
  if(!after.has(name)){differences.push({section,name,kind:'missing',expected:row});continue;}
  const found=after.get(name);
  for(const field of new Set([...Object.keys(row),...Object.keys(found)])){
   if(!isDeepStrictEqual(row[field],found[field]))differences.push({section,name,kind:'changed',field,expected:row[field],actual:found[field]});
  }
 }
 for(const [name,row] of after)if(!before.has(name))differences.push({section,name,kind:'unexpected',actual:row});
 return differences;
}
async function check(db,tables){
 const columns=await db.$queryRawUnsafe(`SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[]) ORDER BY table_name,column_name`,tables);
 const constraints=await db.$queryRawUnsafe(`SELECT c.relname AS table_name,k.conname AS name,k.contype::text AS type,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND k.contype IN ('p','u','f','c') ORDER BY c.relname,k.conname`,tables);
 const mismatches=[];
 for(const table of tables){
  const actual={columns:columns.filter(r=>r.table_name===table).map(({table_name,...r})=>r).sort((a,b)=>a.column_name<b.column_name?-1:a.column_name>b.column_name?1:0),constraints:constraints.filter(r=>r.table_name===table).map(({table_name,...r})=>r).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)};
  if(JSON.stringify(actual)!==JSON.stringify(expected[table])){
   const wanted=expected[table];
   const differences=wanted?[
    ...rowDifferences('columns','column_name',wanted.columns,actual.columns),
    ...rowDifferences('constraints','name',wanted.constraints,actual.constraints)
   ]:[{section:'table',kind:'missing_expected_contract'}];
   mismatches.push({table,expectedColumns:wanted?.columns.length??null,actualColumns:actual.columns.length,
    expectedConstraints:wanted?.constraints.length??null,actualConstraints:actual.constraints.length,
    serializationOnly:!!wanted&&differences.length===0,differences});
  }
 }
 if(mismatches.length){
  let context;
  try{
   const rows=await db.$queryRawUnsafe(`SELECT current_setting('server_version') AS "serverVersion",current_setting('search_path') AS "searchPath",current_schema() AS "currentSchema",current_setting('quote_all_identifiers') AS "quoteAllIdentifiers"`);
   context=rows[0]||{unavailable:true};
  }catch(_error){context={unavailable:true};}
  throw Object.assign(Error('PHASE7_ARCHIVE_PHYSICAL_SHAPE_MISMATCH'),{
   code:'PHASE7_ARCHIVE_PHYSICAL_SHAPE_MISMATCH',table:mismatches[0].table,
   phase7Diagnostics:{event:'PHASE7_ARCHIVE_PHYSICAL_SHAPE_MISMATCH',checked:tables.length,total:mismatches.length,context,tables:mismatches}
  });
 }
 return true;
}
module.exports={check};

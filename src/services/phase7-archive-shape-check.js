'use strict';
const expected=require('./phase7-archive-shape.json');
async function check(db,tables){
 const columns=await db.$queryRawUnsafe(`SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[]) ORDER BY table_name,column_name`,tables);
 const constraints=await db.$queryRawUnsafe(`SELECT c.relname AS table_name,k.conname AS name,k.contype::text AS type,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND k.contype IN ('p','u','f','c') ORDER BY c.relname,k.conname`,tables);
 for(const table of tables){
  const actual={columns:columns.filter(r=>r.table_name===table).map(({table_name,...r})=>r).sort((a,b)=>a.column_name<b.column_name?-1:a.column_name>b.column_name?1:0),constraints:constraints.filter(r=>r.table_name===table).map(({table_name,...r})=>r).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)};
  if(JSON.stringify(actual)!==JSON.stringify(expected[table]))throw Object.assign(Error('PHASE7_ARCHIVE_PHYSICAL_SHAPE_MISMATCH'),{code:'PHASE7_ARCHIVE_PHYSICAL_SHAPE_MISMATCH',table});
 }return true;
}
module.exports={check};
